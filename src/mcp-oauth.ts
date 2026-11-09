/**
 * OAuth 2.1 client for remote MCP servers.
 *
 * Implements what the MCP authorization spec asks of a client:
 * - Protected Resource Metadata discovery (RFC 9728)
 * - Authorization Server Metadata discovery (RFC 8414 / OIDC)
 * - Dynamic Client Registration (RFC 7591)
 * - Authorization Code + PKCE (S256)
 * - Token refresh, and persisted tokens per server URL
 *
 * Tokens are stored in `~/.aivokey/mcp-auth.json` with mode 0600.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AIVO_CLIENT_VERSION } from "./client-identity.js";
import { writeFileAtomic } from "./fs-util.js";

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  scope?: string;
}

export interface OAuthClientRegistration {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  tokenEndpointAuthMethod: "none" | "client_secret_basic" | "client_secret_post";
  issuedAt: number;
}

export interface OAuthServerMetadata {
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
}

export interface StoredAuth {
  serverUrl: string;
  registration?: OAuthClientRegistration;
  tokens?: OAuthTokens;
  /** Cached discovery results. */
  metadata?: OAuthServerMetadata;
  resource?: string;
}

interface AuthFile {
  version: 1;
  servers: Record<string, StoredAuth>;
}

export function defaultMcpAuthPath(): string {
  return join(homedir(), ".aivokey", "mcp-auth.json");
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function originOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return rawUrl;
  }
}

/** Discovery document URLs for a remote MCP server (RFC 9728). */
export function protectedResourceMetadataUrls(serverUrl: string): string[] {
  const url = new URL(serverUrl);
  const path = url.pathname.replace(/\/$/, "");
  const urls = [`${url.origin}/.well-known/oauth-protected-resource${path}`];
  if (path) urls.push(`${url.origin}/.well-known/oauth-protected-resource`);
  return [...new Set(urls)];
}

/** Candidate authorization-server metadata URLs (RFC 8414 + OIDC). */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const base = issuer.replace(/\/$/, "");
  return [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
    `${base}/.well-known/oauth-authorization-server${new URL(base).pathname.replace(/\/$/, "")}`,
  ];
}

async function fetchJson(
  url: string,
  init: RequestInit,
  fetchFn: typeof fetch,
  timeoutMs = 15_000,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: unknown = null;
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, body, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverServerMetadata(
  serverUrl: string,
  fetchFn: typeof fetch,
): Promise<{ metadata: OAuthServerMetadata; resource: string; scope?: string } | null> {
  for (const url of protectedResourceMetadataUrls(serverUrl)) {
    try {
      const res = await fetchJson(url, { headers: { accept: "application/json" } }, fetchFn);
      if (res.status !== 200 || typeof res.body !== "object" || res.body === null) continue;
      const prm = res.body as {
        resource?: string;
        authorization_servers?: string[];
        scopes_supported?: string[];
      };
      const issuer = prm.authorization_servers?.[0];
      if (!issuer) continue;
      for (const metadataUrl of authorizationServerMetadataUrls(issuer)) {
        try {
          const meta = await fetchJson(metadataUrl, { headers: { accept: "application/json" } }, fetchFn);
          if (meta.status !== 200 || typeof meta.body !== "object" || meta.body === null) continue;
          const raw = meta.body as Record<string, unknown>;
          if (
            typeof raw.authorization_endpoint !== "string" ||
            typeof raw.token_endpoint !== "string"
          ) {
            continue;
          }
          return {
            resource: prm.resource ?? serverUrl,
            scope: prm.scopes_supported?.join(" "),
            metadata: {
              issuer: typeof raw.issuer === "string" ? raw.issuer : issuer,
              authorizationEndpoint: raw.authorization_endpoint,
              tokenEndpoint: raw.token_endpoint,
              registrationEndpoint:
                typeof raw.registration_endpoint === "string"
                  ? raw.registration_endpoint
                  : undefined,
              scopesSupported: Array.isArray(raw.scopes_supported)
                ? raw.scopes_supported.filter((item): item is string => typeof item === "string")
                : undefined,
              codeChallengeMethodsSupported: Array.isArray(raw.code_challenge_methods_supported)
                ? raw.code_challenge_methods_supported.filter(
                    (item): item is string => typeof item === "string",
                  )
                : undefined,
            },
          };
        } catch {
          // Try the next metadata URL.
        }
      }
    } catch {
      // Try the next protected-resource metadata URL.
    }
  }
  return null;
}

export interface RegisterClientOptions {
  metadata: OAuthServerMetadata;
  redirectUri: string;
  clientName?: string;
  scope?: string;
  fetchFn: typeof fetch;
}

/** Dynamic Client Registration (RFC 7591). */
export async function registerOAuthClient(
  options: RegisterClientOptions,
): Promise<OAuthClientRegistration> {
  if (!options.metadata.registrationEndpoint) {
    throw new Error(
      "MCP server does not advertise a registration_endpoint; configure a static OAuth client instead.",
    );
  }
  const res = await fetchJson(
    options.metadata.registrationEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: options.clientName ?? "AivoCode",
        redirect_uris: [options.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(options.scope ? { scope: options.scope } : {}),
        software_id: "aivocode",
        software_version: AIVO_CLIENT_VERSION,
      }),
    },
    options.fetchFn,
  );
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Dynamic client registration failed (${res.status})`);
  }
  const body = res.body as {
    client_id?: string;
    client_secret?: string;
    token_endpoint_auth_method?: string;
  };
  if (typeof body?.client_id !== "string") {
    throw new Error("Dynamic client registration did not return a client_id");
  }
  const method =
    body.token_endpoint_auth_method === "client_secret_basic"
      ? "client_secret_basic"
      : body.token_endpoint_auth_method === "client_secret_post"
        ? "client_secret_post"
        : "none";
  return {
    clientId: body.client_id,
    clientSecret: typeof body.client_secret === "string" ? body.client_secret : undefined,
    redirectUri: options.redirectUri,
    tokenEndpointAuthMethod: method,
    issuedAt: Date.now(),
  };
}

export interface AuthorizationUrlOptions {
  metadata: OAuthServerMetadata;
  registration: OAuthClientRegistration;
  state: string;
  codeChallenge: string;
  scope?: string;
  resource?: string;
}

export function buildAuthorizationUrl(options: AuthorizationUrlOptions): string {
  const url = new URL(options.metadata.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.registration.clientId);
  url.searchParams.set("redirect_uri", options.registration.redirectUri);
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (options.scope) url.searchParams.set("scope", options.scope);
  if (options.resource) url.searchParams.set("resource", options.resource);
  return url.toString();
}

export interface TokenExchangeOptions {
  metadata: OAuthServerMetadata;
  registration: OAuthClientRegistration;
  code: string;
  codeVerifier: string;
  resource?: string;
  fetchFn: typeof fetch;
}

function tokenRequestHeaders(
  registration: OAuthClientRegistration,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (registration.tokenEndpointAuthMethod === "client_secret_basic" && registration.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(
      `${encodeURIComponent(registration.clientId)}:${encodeURIComponent(registration.clientSecret)}`,
    ).toString("base64")}`;
  }
  return headers;
}

function tokenRequestBody(
  registration: OAuthClientRegistration,
  params: Record<string, string>,
): string {
  const body = new URLSearchParams(params);
  if (registration.tokenEndpointAuthMethod === "client_secret_post" && registration.clientSecret) {
    body.set("client_id", registration.clientId);
    body.set("client_secret", registration.clientSecret);
  } else if (registration.tokenEndpointAuthMethod === "none") {
    body.set("client_id", registration.clientId);
  }
  return body.toString();
}

function parseTokenResponse(body: unknown): OAuthTokens {
  const raw = (body ?? {}) as Record<string, unknown>;
  if (typeof raw.access_token !== "string") {
    throw new Error(
      `Token endpoint returned no access_token${typeof raw.error === "string" ? ` (${raw.error})` : ""}`,
    );
  }
  const expiresIn = typeof raw.expires_in === "number" ? raw.expires_in : undefined;
  return {
    accessToken: raw.access_token,
    refreshToken: typeof raw.refresh_token === "string" ? raw.refresh_token : undefined,
    tokenType: typeof raw.token_type === "string" ? raw.token_type : "Bearer",
    expiresAt: expiresIn ? Date.now() + expiresIn * 1_000 : undefined,
    scope: typeof raw.scope === "string" ? raw.scope : undefined,
  };
}

export async function exchangeAuthorizationCode(
  options: TokenExchangeOptions,
): Promise<OAuthTokens> {
  const body = tokenRequestBody(options.registration, {
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.registration.redirectUri,
    code_verifier: options.codeVerifier,
    ...(options.resource ? { resource: options.resource } : {}),
  });
  const res = await fetchJson(
    options.metadata.tokenEndpoint,
    {
      method: "POST",
      headers: tokenRequestHeaders(options.registration),
      body,
    },
    options.fetchFn,
  );
  if (res.status !== 200) {
    throw new Error(`Token exchange failed (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  return parseTokenResponse(res.body);
}

export async function refreshAccessToken(options: {
  metadata: OAuthServerMetadata;
  registration: OAuthClientRegistration;
  refreshToken: string;
  resource?: string;
  fetchFn: typeof fetch;
}): Promise<OAuthTokens> {
  const body = tokenRequestBody(options.registration, {
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
    ...(options.resource ? { resource: options.resource } : {}),
  });
  const res = await fetchJson(
    options.metadata.tokenEndpoint,
    {
      method: "POST",
      headers: tokenRequestHeaders(options.registration),
      body,
    },
    options.fetchFn,
  );
  if (res.status !== 200) {
    throw new Error(`Token refresh failed (${res.status})`);
  }
  const tokens = parseTokenResponse(res.body);
  if (!tokens.refreshToken) tokens.refreshToken = options.refreshToken;
  return tokens;
}

// ── Token storage ───────────────────────────────────────────────────────────

export class McpAuthStore {
  private readonly data: AuthFile;

  constructor(private readonly path: string = defaultMcpAuthPath()) {
    this.data = { version: 1, servers: {} };
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as AuthFile;
        if (parsed?.servers && typeof parsed.servers === "object") {
          this.data = { version: 1, servers: parsed.servers };
        }
      } catch {
        // Corrupt auth file: start clean rather than crashing the session.
      }
    }
  }

  private key(serverUrl: string): string {
    return originOf(serverUrl);
  }

  get(serverUrl: string): StoredAuth | undefined {
    return this.data.servers[this.key(serverUrl)];
  }

  set(serverUrl: string, value: StoredAuth): void {
    this.data.servers[this.key(serverUrl)] = value;
    this.save();
  }

  clear(serverUrl: string): void {
    delete this.data.servers[this.key(serverUrl)];
    this.save();
  }

  list(): Array<{ serverUrl: string; expiresAt?: number; hasRefreshToken: boolean }> {
    return Object.values(this.data.servers).map((entry) => ({
      serverUrl: entry.serverUrl,
      expiresAt: entry.tokens?.expiresAt,
      hasRefreshToken: Boolean(entry.tokens?.refreshToken),
    }));
  }

  private save(): void {
    writeFileAtomic(this.path, JSON.stringify(this.data, null, 2) + "\n", 0o600);
  }
}

/** Returns true when the access token is missing or expires within 60 seconds. */
export function tokenNeedsRefresh(tokens: OAuthTokens | undefined): boolean {
  if (!tokens) return true;
  if (!tokens.expiresAt) return false;
  return tokens.expiresAt - Date.now() < 60_000;
}

// ── Interactive authorization ───────────────────────────────────────────────

export interface InteractiveAuthOptions {
  serverName: string;
  serverUrl: string;
  fetchFn: typeof fetch;
  /** Called with the URL the user must open. Defaults to printing to stderr. */
  presentUrl?: (url: string) => void;
  timeoutMs?: number;
  openBrowser?: (url: string) => void;
  scope?: string;
  /** Skip launching a callback server and wait for a pasted code instead. */
  manualCode?: () => Promise<string>;
}

export interface InteractiveAuthResult {
  tokens: OAuthTokens;
  registration: OAuthClientRegistration;
  metadata: OAuthServerMetadata;
  resource?: string;
}

/**
 * Runs the full interactive OAuth flow: discovery → DCR → PKCE authorize →
 * local callback → token exchange.
 */
export async function authorizeMcpServer(
  options: InteractiveAuthOptions,
): Promise<InteractiveAuthResult> {
  const discovered = await discoverServerMetadata(options.serverUrl, options.fetchFn);
  if (!discovered) {
    throw new Error(
      `No OAuth metadata found for ${options.serverUrl}. The server may not require OAuth, or it must expose /.well-known/oauth-protected-resource.`,
    );
  }
  const { metadata, resource, scope } = discovered;
  const requestedScope = options.scope ?? scope;

  const { server, redirectPromise, redirectUri } = await startCallbackServer(
    options.timeoutMs ?? 300_000,
  );
  try {
    const registration = await registerOAuthClient({
      metadata,
      redirectUri,
      scope: requestedScope,
      fetchFn: options.fetchFn,
    });

    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const state = base64Url(randomBytes(16));
    const authorizationUrl = buildAuthorizationUrl({
      metadata,
      registration,
      state,
      codeChallenge: challenge,
      scope: requestedScope,
      resource,
    });

    if (options.presentUrl) options.presentUrl(authorizationUrl);
    else process.stderr.write(`\nOpen this URL to authorize MCP server '${options.serverName}':\n${authorizationUrl}\n\n`);
    options.openBrowser?.(authorizationUrl);

    const code = await (options.manualCode ? options.manualCode() : redirectPromise(state));
    const tokens = await exchangeAuthorizationCode({
      metadata,
      registration,
      code,
      codeVerifier: verifier,
      resource,
      fetchFn: options.fetchFn,
    });
    return { tokens, registration, metadata, resource };
  } finally {
    server.close();
  }
}

function startCallbackServer(timeoutMs: number): Promise<{
  server: ReturnType<typeof createServer>;
  redirectUri: string;
  redirectPromise: (expectedState: string) => Promise<string>;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    let resolveCode: ((code: string) => void) | null = null;
    let rejectCode: ((error: Error) => void) | null = null;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback") {
          res.writeHead(404).end("Not found");
          return;
        }
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state") ?? "";
        if (error) {
          res.writeHead(400, { "content-type": "text/html" });
          res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
          rejectCode?.(new Error(`Authorization denied: ${error}`));
          return;
        }
        if (!code) {
          res.writeHead(400, { "content-type": "text/html" });
          res.end("<h1>Missing authorization code</h1>");
          rejectCode?.(new Error("OAuth callback missing 'code'"));
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<h1>AivoCode authorized</h1><p>You can close this window.</p>");
        pendingState = state;
        resolveCode?.(code);
      } catch {
        res.writeHead(500).end("Internal error");
      }
    });
    let pendingState = "";

    server.on("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const timer = setTimeout(() => {
        rejectCode?.(new Error("Timed out waiting for OAuth authorization"));
        server.close();
      }, timeoutMs);
      timer.unref?.();
      resolvePromise({
        server,
        redirectUri: `http://127.0.0.1:${port}/callback`,
        redirectPromise: (expectedState: string) =>
          codePromise.then((code) => {
            if (expectedState && pendingState && pendingState !== expectedState) {
              throw new Error("OAuth state mismatch; aborting authorization");
            }
            clearTimeout(timer);
            return code;
          }),
      });
    });
  });
}
