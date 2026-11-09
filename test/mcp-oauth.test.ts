import { describe, expect, it, vi } from "vitest";
import {
  McpAuthStore,
  authorizationServerMetadataUrls,
  buildAuthorizationUrl,
  defaultMcpAuthPath,
  protectedResourceMetadataUrls,
  tokenNeedsRefresh,
  type OAuthClientRegistration,
  type OAuthServerMetadata,
} from "../src/mcp-oauth.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("MCP OAuth helpers", () => {
  it("builds RFC 9728 protected-resource metadata URLs", () => {
    expect(protectedResourceMetadataUrls("https://api.example.com/mcp")).toEqual([
      "https://api.example.com/.well-known/oauth-protected-resource/mcp",
      "https://api.example.com/.well-known/oauth-protected-resource",
    ]);
    expect(protectedResourceMetadataUrls("https://api.example.com/")).toEqual([
      "https://api.example.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("builds RFC 8414 authorization-server metadata URLs", () => {
    const urls = authorizationServerMetadataUrls("https://auth.example.com/tenant");
    expect(urls[0]).toBe("https://auth.example.com/tenant/.well-known/oauth-authorization-server");
    expect(urls[1]).toBe("https://auth.example.com/tenant/.well-known/openid-configuration");
    expect(urls).toHaveLength(3);
  });

  it("builds a PKCE authorization URL with state and resource", () => {
    const metadata: OAuthServerMetadata = {
      authorizationEndpoint: "https://auth.example.com/authorize",
      tokenEndpoint: "https://auth.example.com/token",
    };
    const registration: OAuthClientRegistration = {
      clientId: "client-123",
      redirectUri: "http://127.0.0.1:4321/callback",
      tokenEndpointAuthMethod: "none",
      issuedAt: Date.now(),
    };
    const url = new URL(
      buildAuthorizationUrl({
        metadata,
        registration,
        state: "state-abc",
        codeChallenge: "challenge-xyz",
        scope: "read write",
        resource: "https://api.example.com/mcp",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-xyz");
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("resource")).toBe("https://api.example.com/mcp");
  });

  it("decides when a token needs refresh", () => {
    expect(tokenNeedsRefresh(undefined)).toBe(true);
    expect(tokenNeedsRefresh({ accessToken: "a", tokenType: "Bearer" })).toBe(false);
    expect(
      tokenNeedsRefresh({
        accessToken: "a",
        tokenType: "Bearer",
        expiresAt: Date.now() + 5_000,
      }),
    ).toBe(true);
    expect(
      tokenNeedsRefresh({
        accessToken: "a",
        tokenType: "Bearer",
        expiresAt: Date.now() + 600_000,
      }),
    ).toBe(false);
  });

  it("persists tokens per server origin with mode-0600 file semantics", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-mcp-auth-"));
    try {
      const path = join(dir, "mcp-auth.json");
      const store = new McpAuthStore(path);
      store.set("https://api.example.com/mcp", {
        serverUrl: "https://api.example.com/mcp",
        tokens: {
          accessToken: "access-1",
          refreshToken: "refresh-1",
          tokenType: "Bearer",
          expiresAt: Date.now() + 3_600_000,
        },
      });
      // Same origin, different path resolves to the same credential entry.
      const reloaded = new McpAuthStore(path);
      expect(reloaded.get("https://api.example.com/other")?.tokens?.accessToken).toBe("access-1");
      expect(reloaded.list()).toHaveLength(1);
      expect(reloaded.list()[0]?.hasRefreshToken).toBe(true);

      reloaded.clear("https://api.example.com/mcp");
      expect(new McpAuthStore(path).list()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("survives a corrupt auth file", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-mcp-auth-bad-"));
    try {
      const path = join(dir, "mcp-auth.json");
      require("node:fs").writeFileSync(path, "{not json", "utf8");
      const store = new McpAuthStore(path);
      expect(store.list()).toEqual([]);
      store.set("https://x.test", { serverUrl: "https://x.test" });
      expect(new McpAuthStore(path).list()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("uses a default path under the aivokey home directory", () => {
    expect(defaultMcpAuthPath()).toContain(join(".aivokey", "mcp-auth.json"));
  });

  it("discovers metadata and registers a client end-to-end", async () => {
    const { discoverServerMetadata, registerOAuthClient, exchangeAuthorizationCode } = await import(
      "../src/mcp-oauth.js"
    );
    const calls: string[] = [];
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("oauth-protected-resource")) {
        return new Response(
          JSON.stringify({
            resource: "https://mcp.example.com/mcp",
            authorization_servers: ["https://auth.example.com"],
            scopes_supported: ["mcp:read"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            issuer: "https://auth.example.com",
            authorization_endpoint: "https://auth.example.com/authorize",
            token_endpoint: "https://auth.example.com/token",
            registration_endpoint: "https://auth.example.com/register",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/register")) {
        return new Response(JSON.stringify({ client_id: "dynamic-client" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/token")) {
        return new Response(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const discovered = await discoverServerMetadata("https://mcp.example.com/mcp", mockFetch);
    expect(discovered?.metadata.authorizationEndpoint).toBe("https://auth.example.com/authorize");
    expect(discovered?.resource).toBe("https://mcp.example.com/mcp");
    expect(discovered?.scope).toBe("mcp:read");

    const registration = await registerOAuthClient({
      metadata: discovered!.metadata,
      redirectUri: "http://127.0.0.1:1234/callback",
      fetchFn: mockFetch,
    });
    expect(registration.clientId).toBe("dynamic-client");
    expect(registration.tokenEndpointAuthMethod).toBe("none");

    const tokens = await exchangeAuthorizationCode({
      metadata: discovered!.metadata,
      registration,
      code: "code-123",
      codeVerifier: "verifier",
      resource: discovered!.resource,
      fetchFn: mockFetch,
    });
    expect(tokens.accessToken).toBe("access-token");
    expect(tokens.refreshToken).toBe("refresh-token");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(calls.some((call) => call.startsWith("POST https://auth.example.com/register"))).toBe(true);
  });

  it("refreshes an access token and keeps the old refresh token", async () => {
    const { refreshAccessToken } = await import("../src/mcp-oauth.js");
    const mockFetch = (async () =>
      new Response(JSON.stringify({ access_token: "new-access", token_type: "Bearer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const tokens = await refreshAccessToken({
      metadata: {
        authorizationEndpoint: "https://auth/authorize",
        tokenEndpoint: "https://auth/token",
      },
      registration: {
        clientId: "client",
        redirectUri: "http://127.0.0.1/cb",
        tokenEndpointAuthMethod: "none",
        issuedAt: Date.now(),
      },
      refreshToken: "old-refresh",
      fetchFn: mockFetch,
    });
    expect(tokens.accessToken).toBe("new-access");
    expect(tokens.refreshToken).toBe("old-refresh");
  });

  it("fails clearly when the server advertises no metadata", async () => {
    const { authorizeMcpServer } = await import("../src/mcp-oauth.js");
    const mockFetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(
      authorizeMcpServer({
        serverName: "noauth",
        serverUrl: "https://noauth.example.com/mcp",
        fetchFn: mockFetch,
        presentUrl: () => {},
      }),
    ).rejects.toThrow(/No OAuth metadata/);
  });

  it("rejects when the authorization server returns an error", async () => {
    const { exchangeAuthorizationCode } = await import("../src/mcp-oauth.js");
    const mockFetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(
      exchangeAuthorizationCode({
        metadata: {
          authorizationEndpoint: "https://auth/authorize",
          tokenEndpoint: "https://auth/token",
        },
        registration: {
          clientId: "c",
          redirectUri: "http://127.0.0.1/cb",
          tokenEndpointAuthMethod: "none",
          issuedAt: Date.now(),
        },
        code: "bad",
        codeVerifier: "v",
        fetchFn: mockFetch,
      }),
    ).rejects.toThrow(/Token exchange failed/);
  });
});
