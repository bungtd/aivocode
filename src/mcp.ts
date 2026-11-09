import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { McpServerConfig } from "./config.js";
import type { ToolSpec } from "./protocol.js";
import type { ToolExecutionResult } from "./tools/index.js";
import { detectImageMagic, type ImageAttachment } from "./vision.js";
import { AIVO_CLIENT_VERSION } from "./client-identity.js";
import { buildChildEnv } from "./env-utils.js";
import { ShellSandbox, type NetworkAccess, type SandboxMode } from "./sandbox.js";
import {
  McpAuthStore,
  refreshAccessToken,
  tokenNeedsRefresh,
  type OAuthServerMetadata,
  type StoredAuth,
} from "./mcp-oauth.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_START_TIMEOUT_MS = 12_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_TOOL_NAME_LENGTH = 48;
const MAX_EXPOSED_NAME_LENGTH = 64;
const MAX_TOOL_DESCRIPTION_LENGTH = 1_024;
const MAX_OUTPUT_CHARS = 32_000;
const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;

export type McpTransportKind = "stdio" | "http" | "sse";
export type McpServerState = "idle" | "starting" | "ready" | "error" | "disabled";

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptDefinition {
  name: string;
  description?: string;
  arguments: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpToolBinding {
  exposedName: string;
  server: string;
  toolName: string;
  readOnlyHint: boolean;
  approval: "auto" | "ask" | "deny";
}

export interface McpSandboxOptions {
  mode: SandboxMode;
  network: NetworkAccess;
  envAllow?: string[];
}

/** Callbacks the agent provides for server-initiated sampling/elicitation. */
export interface McpClientHandlers {
  /** Handle `sampling/createMessage`; return a { role, content, model } result. */
  sampling?: (request: {
    server: string;
    messages: Array<{ role: string; content: unknown }>;
    modelPreferences?: unknown;
    systemPrompt?: string;
    maxTokens?: number;
  }) => Promise<unknown>;
  /** Handle `elicitation/create`; return { action, content }. */
  elicitation?: (request: {
    server: string;
    message: string;
    requestedSchema?: unknown;
  }) => Promise<unknown>;
  /** Receives `notifications/message`, progress, and list-changed notifications. */
  notification?: (server: string, method: string, params: unknown) => void;
  /** Resolve OAuth tokens for remote servers (interactive or cached). */
  authProvider?: (
    serverName: string,
    serverUrl: string,
    options?: { forceRefresh?: boolean },
  ) => Promise<{ accessToken: string } | null>;
}

export interface McpOAuthConfig {
  /** Cached tokens are read from this store and used as Bearer tokens. */
  authPath?: string;
  /** When false, cached/expired tokens are not refreshed automatically. */
  autoRefresh?: boolean;
}

export interface McpServerStatus {
  name: string;
  transport: McpTransportKind;
  state: McpServerState;
  toolCount: number;
  resourcesSupported: boolean;
  promptsSupported: boolean;
  hasInstructions: boolean;
  serverName?: string;
  serverVersion?: string;
  sandbox?: string;
  approval?: "auto" | "ask" | "deny";
  sampling?: boolean;
  elicitation?: boolean;
  authenticated?: boolean;
  error?: string;
}

class McpError extends Error {
  readonly code: number | string | null;
  constructor(message: string, code: number | string | null = null) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

class McpSessionExpiredError extends McpError {
  constructor(message: string) {
    super(message, "session_expired");
    this.name = "McpSessionExpiredError";
  }
}

/** The server rejected our credentials; a token refresh + reconnect may fix it. */
class McpAuthError extends McpError {
  constructor(message: string) {
    super(message, "auth_required");
    this.name = "McpAuthError";
  }
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number | string; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface McpTransport {
  readonly kind: McpTransportKind;
  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): void;
}

function expandEnvVars(value: string, env: Record<string, string | undefined> = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? "");
}

function expandStringRecord(
  record: Record<string, string> | undefined,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> | undefined {
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = expandEnvVars(value, env);
  }
  return out;
}

function unrefStream(stream: unknown): void {
  (stream as { unref?: () => void } | null | undefined)?.unref?.();
}

/** Quotes one argument for `cmd.exe` when a Windows command shim requires shell:true. */
function quoteWindowsShellArg(value: string): string {
  if (value === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function safeDisposeChild(child: ChildProcess): void {
  if (typeof child.pid === "number") {
    if (process.platform === "win32") {
      try {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        /* ignore */
      }
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}

function parseJsonRpcMessages(text: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  const trimmed = text.trim();
  if (!trimmed) return messages;

  const add = (raw: string) => {
    try {
      const parsed = JSON.parse(raw) as JsonRpcMessage;
      if (parsed && typeof parsed === "object") messages.push(parsed);
    } catch {
      /* ignore malformed payload */
    }
  };

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as JsonRpcMessage | JsonRpcMessage[];
      if (Array.isArray(parsed)) messages.push(...parsed);
      else messages.push(parsed);
      return messages;
    } catch {
      /* fall through to SSE parsing */
    }
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload && payload !== "[DONE]") add(payload);
  }
  return messages;
}

class StdioTransport implements McpTransport {
  readonly kind = "stdio" as const;
  private child: ChildProcess;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stderrTail = "";
  private closed = false;

  constructor(
    server: McpServerConfig,
    cwd: string,
    private readonly onNotification: (method: string, params: unknown) => void,
    private readonly onClosed?: (error: Error) => void,
    private readonly onRequest?: (method: string, params: unknown) => Promise<unknown>,
    private readonly sandbox?: ShellSandbox,
    envAllow: string[] = [],
  ) {
    if (!server.command) throw new McpError("stdio MCP server is missing 'command'");
    const args = server.args ?? [];
    // Never inherit the full parent environment: MCP servers are third-party
    // processes and must receive secrets only through explicit `server.env`.
    const env = buildChildEnv({
      allow: envAllow,
      extra: expandStringRecord(server.env),
    });
    const commandLower = server.command.toLowerCase();
    const needsWindowsShell =
      process.platform === "win32" &&
      (/\.(?:cmd|bat)$/i.test(server.command) ||
        ["npx", "npm", "pnpm", "yarn"].includes(commandLower));
    const sandboxed = this.sandbox?.wrapDirect(server.command, args, server.cwd ?? cwd);
    const activeSandbox = sandboxed?.enforced ? sandboxed : null;
    const useSandbox = activeSandbox !== null;
    // With `shell: true` Node concatenates args without escaping, so pass a
    // single pre-quoted command string and an empty args array.
    const spawnCommand = activeSandbox
      ? activeSandbox.bin
      : needsWindowsShell
        ? [server.command, ...args].map(quoteWindowsShellArg).join(" ")
        : server.command;
    const spawnArgs = activeSandbox
      ? activeSandbox.args
      : needsWindowsShell
        ? []
        : args;
    this.child = spawn(spawnCommand, spawnArgs, {
      cwd: server.cwd ?? cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      // Only Windows command shims need `shell: true`; spawning node.exe directly avoids
      // the unquoted-args deprecation warning and keeps arg passing predictable.
      shell: !useSandbox && needsWindowsShell,
    });
    // Unref the child and its streams so a forgotten MCP server cannot keep the CLI
    // process alive after the session ends. Pending requests keep a ref'd timeout timer.
    this.child.unref();
    unrefStream(this.child.stdout);
    unrefStream(this.child.stderr);

    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.handleData(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4_000);
    });
    this.child.on("error", (err) => {
      const error = new McpError(`MCP process error: ${err.message}`);
      this.onClosed?.(error);
      this.failAll(error);
    });
    this.child.on("exit", (code, signal) => {
      if (!this.closed) {
        const detail = this.stderrTail.trim();
        const error = new McpError(
          `MCP server exited (code=${code ?? "null"}, signal=${signal ?? "none"})${detail ? `: ${detail.slice(-500)}` : ""}`,
        );
        this.onClosed?.(error);
        this.failAll(error);
      }
    });
    this.child.stdin?.on("error", () => {
      /* handled by process error/exit */
    });
  }

  private write(message: JsonRpcMessage): void {
    if (this.closed) throw new McpError("MCP transport is closed");
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) throw new McpError("MCP server stdin is not writable");
    stdin.write(JSON.stringify(message) + "\n");
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (typeof message.method === "string" && message.id === undefined) {
      this.onNotification(message.method, message.params);
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      // Server-to-client request (roots/ping). Sampling/elicitation are not advertised,
      // so unsupported methods receive a proper JSON-RPC error.
      if (!this.onRequest) {
        this.write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Method not supported by AivoCode client: ${message.method}` },
        });
        return;
      }
      void this.onRequest(message.method, message.params)
        .then((result) => {
          if (!this.closed) this.write({ jsonrpc: "2.0", id: message.id, result });
        })
        .catch((err) => {
          if (!this.closed) {
            this.write({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
            });
          }
        });
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (pending.onAbort && pending.signal) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    if (message.error) {
      pending.reject(new McpError(message.error.message ?? "MCP request failed", message.error.code ?? null));
      return;
    }
    pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.onAbort && pending.signal) {
        pending.signal.removeEventListener("abort", pending.onAbort);
      }
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try {
          this.write({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: id, reason: "timeout" },
          });
        } catch {
          /* ignore */
        }
        reject(new McpError(`MCP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const pending: PendingRequest = { resolve, reject, timer, signal };
      if (signal) {
        const onAbort = () => {
          this.pending.delete(id);
          clearTimeout(timer);
          try {
            this.write({
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: id, reason: "client aborted" },
            });
          } catch {
            /* ignore */
          }
          reject(new McpError("MCP request cancelled by user"));
        };
        pending.onAbort = onAbort;
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(id, pending);
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new McpError("MCP transport closed"));
    safeDisposeChild(this.child);
  }
}

/**
 * Legacy MCP SSE transport: long-lived GET /sse receives an `endpoint` event, then
 * JSON-RPC requests are POSTed to that endpoint and responses arrive over the stream.
 */
class SseTransport implements McpTransport {
  readonly kind = "sse" as const;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private endpoint: string | null = null;
  private endpointWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private abort = new AbortController();
  private closed = false;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> | undefined,
    private readonly fetchFn: typeof fetch,
    private readonly onNotification: (method: string, params: unknown) => void,
    private readonly onClosed?: (error: Error) => void,
    private readonly onRequest?: (method: string, params: unknown) => Promise<unknown>,
  ) {
    void this.connect();
  }

  private resolveEndpoint(endpoint: string): void {
    this.endpoint = endpoint;
    for (const waiter of this.endpointWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private failEndpointWaiters(error: Error): void {
    for (const waiter of this.endpointWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private async connect(): Promise<void> {
    try {
      const res = await this.fetchFn(expandEnvVars(this.url), {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "cache-control": "no-cache",
          ...(expandStringRecord(this.headers) ?? {}),
        },
        signal: this.abort.signal,
      });
      if (!res.ok || !res.body) {
        throw new McpError(`MCP SSE connection failed (${res.status})`);
      }
      this.reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventName = "message";
      let dataLines: string[] = [];

      const dispatch = () => {
        if (dataLines.length === 0) {
          eventName = "message";
          return;
        }
        const data = dataLines.join("\n");
        const currentEvent = eventName;
        eventName = "message";
        dataLines = [];
        if (currentEvent === "endpoint") {
          try {
            this.resolveEndpoint(new URL(data.trim(), this.url).href);
          } catch {
            /* ignore malformed endpoint event */
          }
          return;
        }
        try {
          const message = JSON.parse(data) as JsonRpcMessage;
          void this.handleServerMessage(message);
        } catch {
          /* ignore malformed JSON event */
        }
      };

      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line === "") {
            dispatch();
          } else if (line.startsWith(":")) {
            /* keepalive comment */
          } else if (line.startsWith("event:")) {
            eventName = line.slice(6).trim() || "message";
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
          }
          newline = buffer.indexOf("\n");
        }
      }
      if (!this.closed) {
        const error = new McpError("MCP SSE stream closed unexpectedly");
        this.onClosed?.(error);
        this.failAll(error);
      }
    } catch (err) {
      if (!this.closed) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.onClosed?.(error);
        this.failAll(error);
        this.failEndpointWaiters(error);
      }
    }
  }

  private async handleServerMessage(message: JsonRpcMessage): Promise<void> {
    if (typeof message.method === "string" && message.id === undefined) {
      this.onNotification(message.method, message.params);
      return;
    }
    if (typeof message.method === "string" && message.id !== undefined) {
      if (!this.onRequest) {
        void this.postMessage({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Method not supported: ${message.method}` },
        }).catch(() => {});
        return;
      }
      try {
        const result = await this.onRequest(message.method, message.params);
        await this.postMessage({ jsonrpc: "2.0", id: message.id, result });
      } catch (err) {
        await this.postMessage({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        }).catch(() => {});
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (pending.onAbort && pending.signal) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    if (message.error) {
      pending.reject(new McpError(message.error.message ?? "MCP request failed", message.error.code ?? null));
      return;
    }
    pending.resolve(message.result);
  }

  private waitForEndpoint(timeoutMs: number): Promise<void> {
    if (this.endpoint) return Promise.resolve();
    if (this.closed) return Promise.reject(new McpError("MCP SSE transport is closed"));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.endpointWaiters = this.endpointWaiters.filter((waiter) => waiter.timer !== timer);
        reject(new McpError(`MCP SSE endpoint event timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.endpointWaiters.push({ resolve, reject, timer });
    });
  }

  private async postMessage(message: JsonRpcMessage): Promise<Response> {
    if (this.closed) throw new McpError("MCP SSE transport is closed");
    if (!this.endpoint) throw new McpError("MCP SSE endpoint is not ready");
    const res = await this.fetchFn(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(expandStringRecord(this.headers) ?? {}),
      },
      body: JSON.stringify(message),
      signal: this.abort.signal,
    });
    if (!res.ok) {
      throw new McpError(`MCP SSE message POST failed (${res.status})`);
    }
    return res;
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.onAbort && pending.signal) pending.signal.removeEventListener("abort", pending.onAbort);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    await this.waitForEndpoint(timeoutMs);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`MCP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const pending: PendingRequest = { resolve, reject, timer, signal };
      if (signal) {
        const onAbort = () => {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new McpError("MCP request cancelled by user"));
        };
        pending.onAbort = onAbort;
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, pending);
      void this.postMessage({ jsonrpc: "2.0", id, method, params }).catch((err) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.waitForEndpoint(15_000);
    await this.postMessage({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.reader?.cancel().catch(() => {});
    this.failAll(new McpError("MCP SSE transport closed"));
    this.failEndpointWaiters(new McpError("MCP SSE transport closed"));
  }
}

class HttpTransport implements McpTransport {
  readonly kind = "http" as const;
  private nextId = 1;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> | undefined,
    private readonly fetchFn: typeof fetch,
    private readonly onRequest?: (method: string, params: unknown) => Promise<unknown>,
  ) {}

  private handleServerRequests(messages: JsonRpcMessage[]): void {
    if (!this.onRequest) return;
    for (const message of messages) {
      if (typeof message.method !== "string" || message.id === undefined) continue;
      void this.onRequest(message.method, message.params)
        .then((result) =>
          this.post({ jsonrpc: "2.0", id: message.id!, result }, 15_000).catch(() => {}),
        )
        .catch((err) =>
          this.post(
            {
              jsonrpc: "2.0",
              id: message.id!,
              error: {
                code: -32603,
                message: err instanceof Error ? err.message : String(err),
              },
            },
            15_000,
          ).catch(() => {}),
        );
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(expandStringRecord(this.headers) ?? {}),
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;
    return headers;
  }

  private async post(body: JsonRpcMessage, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onParentAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw new McpError("MCP request cancelled by user");
      }
      signal.addEventListener("abort", onParentAbort, { once: true });
    }
    try {
      return await this.fetchFn(expandEnvVars(this.url), {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onParentAbort);
    }
  }

  async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    let res: Response;
    try {
      res = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs, signal);
    } catch (err) {
      if (signal?.aborted) throw new McpError("MCP request cancelled by user");
      if (err instanceof Error && err.name === "AbortError") {
        throw new McpError(`MCP request '${method}' timed out after ${timeoutMs}ms`);
      }
      throw err;
    }
    const session = res.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (this.sessionId && (res.status === 404 || res.status === 410)) {
        this.sessionId = null;
        throw new McpSessionExpiredError(
          `MCP HTTP session expired (${res.status}); reinitializing`,
        );
      }
      if (res.status === 401 || res.status === 403) {
        throw new McpAuthError(
          `MCP HTTP ${res.status}: ${text.slice(0, 500) || res.statusText}`,
        );
      }
      throw new McpError(`MCP HTTP ${res.status}: ${text.slice(0, 500) || res.statusText}`, res.status);
    }
    if (res.status === 202) return undefined;
    const text = await res.text();
    const messages = parseJsonRpcMessages(text);
    this.handleServerRequests(messages);
    const match =
      messages.find((message) => message.id === id) ??
      messages.find((message) => message.result !== undefined || message.error !== undefined);
    if (!match) {
      throw new McpError(`MCP HTTP response did not contain a JSON-RPC result for '${method}'`);
    }
    if (match.error) {
      throw new McpError(match.error.message ?? "MCP request failed", match.error.code ?? null);
    }
    const rawResult = match.result;
    if (method === "initialize" && typeof rawResult === "object" && rawResult !== null) {
      const version = (rawResult as Record<string, unknown>).protocolVersion;
      if (typeof version === "string") this.protocolVersion = version;
    }
    return rawResult;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const res = await this.post({ jsonrpc: "2.0", method, params }, 15_000);
    if (!res.ok && res.status !== 202) {
      const text = await res.text().catch(() => "");
      throw new McpError(`MCP HTTP notification failed (${res.status}): ${text.slice(0, 300)}`);
    }
  }

  close(): void {
    // Streamable HTTP is stateless from the client side; no socket to close.
  }
}

interface InitializeResult {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
}

class McpConnection {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly transportKind: McpTransportKind;
  state: McpServerState = "idle";
  tools: McpToolDefinition[] = [];
  supportsResources = false;
  supportsPrompts = false;
  instructions: string | undefined;
  toolsDirty = false;
  error: string | undefined;
  retryAt = 0;
  serverName: string | undefined;
  serverVersion: string | undefined;

  private transport: McpTransport | null = null;
  private toolsSupported = false;
  private readonly requestTimeoutMs: number;
  sandboxDescription: string | undefined;
  supportsSampling = false;
  supportsElicitation = false;
  auth: StoredAuth | undefined;
  private authHeaders: Record<string, string> = {};
  private forceTokenRefresh = false;

  constructor(
    name: string,
    config: McpServerConfig,
    private readonly cwd: string,
    private readonly fetchFn: typeof fetch,
    private readonly sandboxOptions?: McpSandboxOptions,
    private readonly handlers?: McpClientHandlers,
  ) {
    this.name = name;
    this.config = config;
    this.requestTimeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.transportKind =
      config.transport === "sse"
        ? "sse"
        : config.transport === "http" || (!config.command && Boolean(config.url))
          ? "http"
          : "stdio";
  }

  private async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "ping") return {};
    if (method === "roots/list") {
      return {
        roots: [
          {
            uri: pathToFileURL(this.cwd).href,
            name: basename(this.cwd) || "workspace",
          },
        ],
      };
    }
    if (method === "sampling/createMessage") {
      if (!this.handlers?.sampling) {
        throw new McpError("Sampling is not enabled by the AivoCode client", -32601);
      }
      const row = (params ?? {}) as {
        messages?: Array<{ role?: string; content?: unknown }>;
        modelPreferences?: unknown;
        systemPrompt?: string;
        maxTokens?: number;
      };
      const result = await this.handlers.sampling({
        server: this.name,
        messages: (row.messages ?? []).map((message) => ({
          role: String(message.role ?? "user"),
          content: message.content,
        })),
        modelPreferences: row.modelPreferences,
        systemPrompt: row.systemPrompt,
        maxTokens: row.maxTokens,
      });
      return result;
    }
    if (method === "elicitation/create") {
      if (!this.handlers?.elicitation) {
        return { action: "decline" };
      }
      const row = (params ?? {}) as { message?: string; requestedSchema?: unknown };
      return this.handlers.elicitation({
        server: this.name,
        message: String(row.message ?? ""),
        requestedSchema: row.requestedSchema,
      });
    }
    throw new McpError(`Method not supported by AivoCode client: ${method}`);
  }

  private notificationHandler(method: string, params: unknown): void {
    if (method === "notifications/tools/list_changed") this.toolsDirty = true;
    this.handlers?.notification?.(this.name, method, params);
  }

  private createTransport(): McpTransport {
    const url = this.config.url ? expandEnvVars(this.config.url) : undefined;
    // OAuth bearer tokens live in `authHeaders` so they never leak into the
    // user's config object (which can be printed or re-saved).
    const headers = { ...(this.config.headers ?? {}), ...this.authHeaders };
    const onNotification = (method: string, params: unknown) => {
      this.notificationHandler(method, params);
    };
    const onClosed = (error: Error) => {
      if (this.state === "ready") {
        this.state = "error";
        this.error = error.message;
      }
    };
    const onRequest = (method: string, params: unknown) => this.handleServerRequest(method, params);
    if (this.transportKind === "sse") {
      if (!url) throw new McpError("SSE MCP server is missing 'url'");
      return new SseTransport(url, headers, this.fetchFn, onNotification, onClosed, onRequest);
    }
    if (this.transportKind === "http") {
      if (!url) throw new McpError("HTTP MCP server is missing 'url'");
      return new HttpTransport(url, headers, this.fetchFn, onRequest);
    }
    const serverMode =
      this.config.sandbox && this.config.sandbox !== "inherit"
        ? this.config.sandbox
        : this.sandboxOptions?.mode;
    const sandbox =
      this.sandboxOptions && serverMode
        ? new ShellSandbox({
            cwd: this.cwd,
            mode: serverMode,
            network: this.config.network ?? this.sandboxOptions.network,
          })
        : undefined;
    this.sandboxDescription = sandbox?.describe();
    return new StdioTransport(
      this.config,
      this.cwd,
      onNotification,
      onClosed,
      onRequest,
      sandbox,
      this.sandboxOptions?.envAllow,
    );
  }

  /** Builds the `initialize` capabilities, including sampling/elicitation when wired. */
  private clientCapabilities(): Record<string, unknown> {
    const capabilities: Record<string, unknown> = { roots: { listChanged: false } };
    if (this.handlers?.sampling) {
      this.supportsSampling = true;
      capabilities.sampling = {};
    }
    if (this.handlers?.elicitation) {
      this.supportsElicitation = true;
      capabilities.elicitation = {};
    }
    return capabilities;
  }

  /** Applies cached OAuth tokens / refresh to remote transports. */
  private async prepareAuth(): Promise<void> {
    if (this.transportKind === "stdio" || !this.config.url) return;
    if (!this.handlers?.authProvider) return;
    // A 401/403 from the server means the cached token is stale even if its
    // recorded expiry says otherwise, so force a refresh on the retry.
    const forceRefresh = this.forceTokenRefresh;
    this.forceTokenRefresh = false;
    try {
      const provided = await this.handlers.authProvider(this.name, this.config.url, {
        forceRefresh,
      });
      if (!provided?.accessToken) return;
      this.authHeaders = { authorization: `Bearer ${provided.accessToken}` };
      this.auth = {
        serverUrl: this.config.url,
        tokens: { accessToken: provided.accessToken, tokenType: "Bearer" },
      };
    } catch (err) {
      // Auth failure should surface as a connection error, not silently retry.
      throw new McpError(
        `OAuth authorization failed for MCP server '${this.name}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async start(): Promise<void> {
    this.state = "starting";
    try {
      await this.prepareAuth();
      this.transport = this.createTransport();
      const init = (await this.transport.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: this.clientCapabilities(),
          clientInfo: { name: "aivocode", version: AIVO_CLIENT_VERSION },
        },
        Math.min(DEFAULT_START_TIMEOUT_MS, this.requestTimeoutMs),
      )) as InitializeResult | undefined;

      if (init && typeof init === "object") {
        this.serverName = typeof init.serverInfo?.name === "string" ? init.serverInfo.name : undefined;
        this.serverVersion =
          typeof init.serverInfo?.version === "string" ? init.serverInfo.version : undefined;
        const capabilities =
          typeof init.capabilities === "object" && init.capabilities !== null
            ? init.capabilities
            : {};
        this.toolsSupported = capabilities.tools !== undefined;
        this.supportsResources = capabilities.resources !== undefined;
        this.supportsPrompts = capabilities.prompts !== undefined;
        this.instructions =
          typeof init.instructions === "string" && init.instructions.trim()
            ? init.instructions.trim()
            : undefined;
      }

      await this.transport.notify("notifications/initialized");
      if (this.toolsSupported) await this.refreshTools();
      this.state = "ready";
      this.error = undefined;
      this.retryAt = 0;
    } catch (err) {
      this.state = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.retryAt = Date.now() + 30_000;
      this.transport?.close();
      this.transport = null;
      throw err;
    }
  }

  private async withSessionRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      // A dropped HTTP session and a rejected bearer token both recover the same
      // way: re-run `prepareAuth` (which refreshes OAuth tokens) and reconnect once.
      const recoverable =
        err instanceof McpSessionExpiredError ||
        (err instanceof McpAuthError && this.handlers?.authProvider !== undefined);
      if (!recoverable) throw err;
      if (err instanceof McpAuthError) this.forceTokenRefresh = true;
      await this.restart();
      return fn();
    }
  }

  private requestRpc(
    method: string,
    params: unknown,
    timeoutMs: number = this.requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.withSessionRetry(async () => {
      if (!this.transport) throw new McpError(`MCP server '${this.name}' is not connected`);
      return this.transport.request(method, params, timeoutMs, signal);
    });
  }

  async refreshTools(): Promise<void> {
    if (!this.transport || !this.toolsSupported) return;
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = (await this.requestRpc(
        "tools/list",
        cursor ? { cursor } : {},
        this.requestTimeoutMs,
      )) as { tools?: unknown[]; nextCursor?: unknown } | undefined;
      const rows = Array.isArray(result?.tools) ? result.tools : [];
      for (const row of rows) {
        if (typeof row !== "object" || row === null) continue;
        const item = row as Record<string, unknown>;
        if (typeof item.name !== "string" || !item.name.trim()) continue;
        const annotations =
          typeof item.annotations === "object" && item.annotations !== null
            ? (item.annotations as Record<string, unknown>)
            : {};
        tools.push({
          name: item.name.trim(),
          description:
            typeof item.description === "string"
              ? item.description.slice(0, MAX_TOOL_DESCRIPTION_LENGTH)
              : "",
          inputSchema:
            typeof item.inputSchema === "object" && item.inputSchema !== null
              ? (item.inputSchema as Record<string, unknown>)
              : { type: "object", properties: {} },
          annotations: {
            readOnlyHint: annotations.readOnlyHint === true,
            destructiveHint: annotations.destructiveHint === true,
            idempotentHint: annotations.idempotentHint === true,
            openWorldHint: annotations.openWorldHint === true,
          },
        });
        if (tools.length >= 500) break;
      }
      const next = typeof result?.nextCursor === "string" ? result.nextCursor : undefined;
      if (!next || next === cursor || tools.length >= 500) break;
      cursor = next;
    }
    this.tools = tools;
    this.toolsDirty = false;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.requestRpc("tools/call", { name, arguments: args }, this.requestTimeoutMs, signal);
  }

  async listResources(signal?: AbortSignal): Promise<McpResourceDefinition[]> {
    if (!this.transport || !this.supportsResources) return [];
    const resources: McpResourceDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = (await this.requestRpc(
        "resources/list",
        cursor ? { cursor } : {},
        this.requestTimeoutMs,
        signal,
      )) as { resources?: unknown[]; nextCursor?: unknown } | undefined;
      const rows = Array.isArray(result?.resources) ? result.resources : [];
      for (const row of rows) {
        if (typeof row !== "object" || row === null) continue;
        const item = row as Record<string, unknown>;
        if (typeof item.uri !== "string") continue;
        resources.push({
          uri: item.uri,
          name: typeof item.name === "string" ? item.name : item.uri,
          description: typeof item.description === "string" ? item.description : undefined,
          mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined,
        });
      }
      const next = typeof result?.nextCursor === "string" ? result.nextCursor : undefined;
      if (!next || next === cursor) break;
      cursor = next;
    }
    return resources;
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<unknown> {
    if (!this.transport || !this.supportsResources) {
      throw new McpError(`MCP server '${this.name}' does not support resources`);
    }
    return this.requestRpc("resources/read", { uri }, this.requestTimeoutMs, signal);
  }

  async listResourceTemplates(signal?: AbortSignal): Promise<McpResourceTemplateDefinition[]> {
    if (!this.transport || !this.supportsResources) return [];
    try {
      const result = (await this.requestRpc(
        "resources/templates/list",
        {},
        this.requestTimeoutMs,
        signal,
      )) as { resourceTemplates?: unknown[] } | undefined;
      const templates: McpResourceTemplateDefinition[] = [];
      for (const row of Array.isArray(result?.resourceTemplates) ? result.resourceTemplates : []) {
        if (typeof row !== "object" || row === null) continue;
        const item = row as Record<string, unknown>;
        if (typeof item.uriTemplate !== "string" || !item.uriTemplate.trim()) continue;
        templates.push({
          uriTemplate: item.uriTemplate.trim(),
          name: typeof item.name === "string" ? item.name : item.uriTemplate,
          description: typeof item.description === "string" ? item.description : undefined,
          mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined,
        });
      }
      return templates;
    } catch {
      return [];
    }
  }

  async listPrompts(signal?: AbortSignal): Promise<McpPromptDefinition[]> {
    if (!this.transport || !this.supportsPrompts) return [];
    const result = (await this.requestRpc(
      "prompts/list",
      {},
      this.requestTimeoutMs,
      signal,
    )) as { prompts?: unknown[] } | undefined;
    const prompts: McpPromptDefinition[] = [];
    for (const row of Array.isArray(result?.prompts) ? result.prompts : []) {
      if (typeof row !== "object" || row === null) continue;
      const item = row as Record<string, unknown>;
      if (typeof item.name !== "string" || !item.name.trim()) continue;
      const args = Array.isArray(item.arguments)
        ? item.arguments
            .filter((arg): arg is Record<string, unknown> => typeof arg === "object" && arg !== null)
            .map((arg) => ({
              name: typeof arg.name === "string" ? arg.name : "",
              description: typeof arg.description === "string" ? arg.description : undefined,
              required: arg.required === true,
            }))
            .filter((arg) => arg.name.length > 0)
        : [];
      prompts.push({
        name: item.name.trim(),
        description: typeof item.description === "string" ? item.description : undefined,
        arguments: args,
      });
    }
    return prompts;
  }

  async getPrompt(
    name: string,
    args: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.transport || !this.supportsPrompts) {
      throw new McpError(`MCP server '${this.name}' does not support prompts`);
    }
    return this.requestRpc(
      "prompts/get",
      { name, arguments: args },
      this.requestTimeoutMs,
      signal,
    );
  }

  async restart(): Promise<void> {
    this.transport?.close();
    this.transport = null;
    this.state = "idle";
    this.error = undefined;
    this.tools = [];
    this.toolsDirty = false;
    this.supportsResources = false;
    this.supportsPrompts = false;
    this.supportsSampling = false;
    this.supportsElicitation = false;
    this.toolsSupported = false;
    this.instructions = undefined;
    this.serverName = undefined;
    this.serverVersion = undefined;
    this.authHeaders = {};
    this.auth = undefined;
    await this.start();
  }

  close(): void {
    this.transport?.close();
    this.transport = null;
    this.state = this.state === "error" ? "error" : "disabled";
  }
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return (
    text.slice(0, MAX_OUTPUT_CHARS) +
    `\n\n... [MCP output truncated (${text.length} chars total)]`
  );
}

function imageAttachmentFromBase64(
  data: string,
  source: string,
): ImageAttachment | null {
  try {
    if (!data || data.length > MAX_IMAGE_BASE64_BYTES) return null;
    const buffer = Buffer.from(data, "base64");
    if (buffer.length === 0) return null;
    const magic = detectImageMagic(buffer);
    if (!magic) return null;
    const base64 = buffer.toString("base64");
    return {
      filePath: source,
      mimeType: magic.mimeType,
      width: magic.width,
      height: magic.height,
      byteSize: buffer.length,
      base64,
      dataUrl: `data:${magic.mimeType};base64,${base64}`,
    };
  } catch {
    return null;
  }
}

function renderMcpContent(
  content: unknown[],
  source: string,
): { text: string[]; images: ImageAttachment[] } {
  const text: string[] = [];
  const images: ImageAttachment[] = [];
  for (const row of content) {
    if (typeof row !== "object" || row === null) continue;
    const item = row as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") {
      text.push(item.text);
      continue;
    }
    if (item.type === "image" && typeof item.data === "string") {
      const image = imageAttachmentFromBase64(item.data, `${source}:image`);
      if (image) images.push(image);
      else text.push(`[MCP image omitted: ${typeof item.mimeType === "string" ? item.mimeType : "unknown type"}]`);
      continue;
    }
    if (item.type === "resource" && typeof item.resource === "object" && item.resource !== null) {
      const resource = item.resource as Record<string, unknown>;
      if (typeof resource.text === "string") {
        text.push(resource.text);
      } else if (typeof resource.blob === "string") {
        const image = imageAttachmentFromBase64(resource.blob, `${source}:resource`);
        if (image) images.push(image);
        else text.push(`[MCP binary resource omitted: ${typeof resource.uri === "string" ? resource.uri : "unknown"}]`);
      }
      continue;
    }
    if (item.type === "audio") {
      text.push("[MCP audio content omitted: audio playback is not supported]");
      continue;
    }
    if (typeof item.text === "string") {
      text.push(item.text);
    } else {
      text.push(JSON.stringify(item));
    }
  }
  return { text, images };
}

export class McpManager {
  private static activeManagers = new Set<McpManager>();

  private readonly connections = new Map<string, McpConnection>();
  private readonly configErrors = new Map<string, string>();
  private bindings = new Map<string, McpToolBinding>();
  private started = false;
  private startPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(
    servers: Record<string, McpServerConfig>,
    private readonly opts: {
      cwd: string;
      fetchFn: typeof fetch;
      sandbox?: McpSandboxOptions;
      handlers?: McpClientHandlers;
      oauth?: McpOAuthConfig;
    },
  ) {
    for (const [name, config] of Object.entries(servers)) {
      if (config.enabled === false) continue;
      const transportKind =
        config.transport === "sse"
          ? "sse"
          : config.transport === "http" || (!config.command && Boolean(config.url))
            ? "http"
            : "stdio";
      if (transportKind !== "stdio" && !config.url) {
        this.configErrors.set(name, `${transportKind.toUpperCase()} MCP server is missing 'url'`);
        continue;
      }
      if (transportKind === "stdio" && !config.command) {
        this.configErrors.set(name, "stdio MCP server is missing 'command'");
        continue;
      }
      const authStore = opts.oauth ? new McpAuthStore(opts.oauth.authPath) : null;
      const handlers: McpClientHandlers = {
        sampling: opts.handlers?.sampling,
        elicitation: opts.handlers?.elicitation,
        notification: opts.handlers?.notification,
        authProvider:
          opts.handlers?.authProvider ??
          (authStore
            ? async (
                serverName: string,
                serverUrl: string,
                authOptions?: { forceRefresh?: boolean },
              ) => {
                void serverName;
                const stored = authStore.get(serverUrl);
                if (!stored?.tokens) return null;
                const needsRefresh =
                  authOptions?.forceRefresh === true || tokenNeedsRefresh(stored.tokens);
                if (
                  needsRefresh &&
                  opts.oauth?.autoRefresh !== false &&
                  stored.tokens.refreshToken &&
                  stored.registration &&
                  stored.metadata
                ) {
                  try {
                    const refreshed = await refreshAccessToken({
                      metadata: stored.metadata,
                      registration: stored.registration,
                      refreshToken: stored.tokens.refreshToken,
                      resource: stored.resource,
                      fetchFn: opts.fetchFn,
                    });
                    authStore.set(serverUrl, { ...stored, tokens: refreshed });
                    return { accessToken: refreshed.accessToken };
                  } catch {
                    // Fall through to the (possibly expired) cached token.
                  }
                }
                if (needsRefresh && !stored.tokens.refreshToken) return null;
                return { accessToken: stored.tokens.accessToken };
              }
            : undefined),
      };
      this.connections.set(
        name,
        new McpConnection(name, config, opts.cwd, opts.fetchFn, opts.sandbox, handlers),
      );
    }
    McpManager.activeManagers.add(this);
  }

  /** Stops every MCP server from every manager (process shutdown hook). */
  static stopAllActive(): void {
    for (const manager of [...McpManager.activeManagers]) {
      manager.dispose();
    }
  }

  hasServers(): boolean {
    return this.connections.size > 0;
  }

  isStarted(): boolean {
    return this.started;
  }

  async ensureStarted(): Promise<void> {
    if (this.disposed || this.connections.size === 0) return;
    if (!this.started) {
      this.started = true;
      this.startPromise = this.startAll();
    }
    if (this.startPromise) await this.startPromise;

    const retryTargets = [...this.connections.values()].filter(
      (connection) =>
        connection.state === "error" &&
        connection.retryAt > 0 &&
        Date.now() >= connection.retryAt,
    );
    if (retryTargets.length > 0) {
      await Promise.allSettled(retryTargets.map((connection) => connection.restart()));
      this.rebuildBindings();
    }

    const dirty = [...this.connections.values()].filter(
      (connection) => connection.state === "ready" && connection.toolsDirty,
    );
    if (dirty.length > 0) {
      await Promise.allSettled(dirty.map((connection) => connection.refreshTools()));
    }
    this.rebuildBindings();
  }

  async restart(name?: string): Promise<void> {
    if (this.disposed) throw new McpError("MCP manager is disposed");
    const targets = name
      ? [this.connections.get(name)].filter(
          (connection): connection is McpConnection => Boolean(connection),
        )
      : [...this.connections.values()];
    if (name && targets.length === 0) throw new McpError(`Unknown MCP server '${name}'`);
    this.started = true;
    await Promise.allSettled(targets.map((connection) => connection.restart()));
    this.startPromise = null;
    this.rebuildBindings();
  }

  private async startAll(): Promise<void> {
    await Promise.all(
      [...this.connections.values()].map(async (connection) => {
        try {
          await connection.start();
        } catch {
          /* per-connection state already records the error */
        }
      }),
    );
    this.rebuildBindings();
  }

  private rebuildBindings(): void {
    const next = new Map<string, McpToolBinding>();
    const used = new Set<string>();
    for (const connection of this.connections.values()) {
      if (connection.state !== "ready") continue;
      const safeServer = connection.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 20);
      for (const tool of connection.tools) {
        const prefix = `mcp__${safeServer}__`;
        const safeTool = tool.name
          .replace(/[^a-zA-Z0-9_-]/g, "_")
          .slice(0, MAX_TOOL_NAME_LENGTH)
          .slice(0, Math.max(1, MAX_EXPOSED_NAME_LENGTH - prefix.length));
        const baseName = `${prefix}${safeTool}`.slice(0, MAX_EXPOSED_NAME_LENGTH);
        let exposedName = baseName;
        let suffix = 2;
        while (used.has(exposedName)) {
          const suffixText = `_${suffix++}`;
          exposedName = `${baseName.slice(0, MAX_EXPOSED_NAME_LENGTH - suffixText.length)}${suffixText}`;
        }
        used.add(exposedName);
        next.set(exposedName, {
          exposedName,
          server: connection.name,
          toolName: tool.name,
          readOnlyHint: tool.annotations.readOnlyHint === true,
          approval: connection.config.approval ?? "ask",
        });
      }
    }
    this.bindings = next;
  }

  getInstructions(): string[] {
    return [...this.connections.values()]
      .filter(
        (connection) =>
          connection.state === "ready" &&
          typeof connection.instructions === "string" &&
          connection.instructions.length > 0,
      )
      .map(
        (connection) =>
          `[MCP:${connection.name}] ${connection.instructions!.slice(0, 4_000)}`,
      );
  }

  getToolSpecs(opts: { mode: string; readOnlyOnly: boolean }): ToolSpec[] {
    const specs: ToolSpec[] = [];
    const readOnlyOnly = opts.readOnlyOnly || opts.mode === "plan";
    for (const binding of this.bindings.values()) {
      if (readOnlyOnly && !binding.readOnlyHint) continue;
      const connection = this.connections.get(binding.server);
      const tool = connection?.tools.find((candidate) => candidate.name === binding.toolName);
      if (!tool) continue;
      specs.push({
        name: binding.exposedName,
        description: `[MCP:${binding.server}] ${tool.description || tool.name}`,
        parameters:
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? tool.inputSchema
            : { type: "object", properties: {} },
      });
    }

    const resourceServers = [...this.connections.values()].filter(
      (connection) => connection.state === "ready" && connection.supportsResources,
    );
    if (resourceServers.length > 0) {
      specs.push({
        name: "mcp_list_resources",
        description:
          "List MCP resources exposed by configured servers (read-only). Pass 'server' to limit to one server.",
        parameters: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: `MCP server name (one of: ${resourceServers.map((c) => c.name).join(", ")})`,
            },
          },
        },
      });
      specs.push({
        name: "mcp_read_resource",
        description: "Read a resource by server name and URI from a configured MCP server.",
        parameters: {
          type: "object",
          properties: {
            server: { type: "string", description: "MCP server name" },
            uri: { type: "string", description: "Resource URI from mcp_list_resources" },
          },
          required: ["server", "uri"],
        },
      });
    }

    const promptServers = [...this.connections.values()].filter(
      (connection) => connection.state === "ready" && connection.supportsPrompts,
    );
    if (promptServers.length > 0) {
      specs.push({
        name: "mcp_list_prompts",
        description:
          "List MCP prompt templates exposed by configured servers. Pass 'server' to limit to one server.",
        parameters: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: `MCP server name (one of: ${promptServers.map((c) => c.name).join(", ")})`,
            },
          },
        },
      });
      specs.push({
        name: "mcp_get_prompt",
        description:
          "Render an MCP prompt template into messages. Provide server, prompt name, and string arguments.",
        parameters: {
          type: "object",
          properties: {
            server: { type: "string", description: "MCP server name" },
            name: { type: "string", description: "Prompt name from mcp_list_prompts" },
            arguments: {
              type: "object",
              description: "Prompt argument name -> string value",
              additionalProperties: { type: "string" },
            },
          },
          required: ["server", "name"],
        },
      });
    }
    return specs;
  }

  resolveTool(exposedName: string): McpToolBinding | undefined {
    return this.bindings.get(exposedName);
  }

  async callTool(
    exposedName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const binding = this.bindings.get(exposedName);
    if (!binding) {
      await this.ensureStarted();
    }
    const resolved = this.bindings.get(exposedName);
    if (!resolved) {
      return { isError: true, output: `Unknown MCP tool: ${exposedName}` };
    }
    const connection = this.connections.get(resolved.server);
    if (!connection || connection.state !== "ready") {
      return {
        isError: true,
        output: `MCP server '${resolved.server}' is not ready${connection?.error ? `: ${connection.error}` : ""}`,
      };
    }
    try {
      const result = (await connection.callTool(resolved.toolName, args, signal)) as
        | Record<string, unknown>
        | undefined;
      return this.formatToolResult(resolved, result);
    } catch (err) {
      return {
        isError: true,
        output: `MCP ${resolved.server}/${resolved.toolName} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private formatToolResult(
    binding: McpToolBinding,
    result: Record<string, unknown> | undefined,
  ): ToolExecutionResult {
    const content = Array.isArray(result?.content) ? result.content : [];
    const rendered = renderMcpContent(content, `mcp:${binding.server}/${binding.toolName}`);
    const parts = [...rendered.text];
    if (result?.structuredContent !== undefined) {
      try {
        parts.push(`Structured content:\n${JSON.stringify(result.structuredContent, null, 2)}`);
      } catch {
        /* ignore unstringifiable content */
      }
    }
    const output = truncateOutput(parts.join("\n").trim() || "(MCP tool returned no content)");
    return {
      output,
      isError: result?.isError === true,
      summary: `${binding.server}/${binding.toolName}`,
      imageAttachments: rendered.images.length > 0 ? rendered.images : undefined,
      imageAttachment: rendered.images[0],
    };
  }

  async listPrompts(server?: string, signal?: AbortSignal): Promise<string> {
    const targets = server
      ? [this.connections.get(server)].filter(
          (connection): connection is McpConnection => Boolean(connection),
        )
      : [...this.connections.values()].filter(
          (connection) => connection.state === "ready" && connection.supportsPrompts,
        );
    if (targets.length === 0) {
      return server
        ? `MCP server '${server}' not found or has no prompts.`
        : "No MCP prompts available.";
    }
    const lines: string[] = [];
    for (const connection of targets) {
      if (connection.state !== "ready") {
        lines.push(`## ${connection.name} (not ready${connection.error ? `: ${connection.error}` : ""})`);
        continue;
      }
      try {
        const prompts = await connection.listPrompts(signal);
        lines.push(`## ${connection.name} (${prompts.length})`);
        if (prompts.length === 0) lines.push("- (no prompts)");
        for (const prompt of prompts) {
          const args = prompt.arguments
            .map((arg) => `${arg.name}${arg.required ? "*" : ""}`)
            .join(", ");
          lines.push(
            `- ${prompt.name}${args ? ` (${args})` : ""}${prompt.description ? ` — ${prompt.description}` : ""}`,
          );
        }
      } catch (err) {
        lines.push(`## ${connection.name} (error: ${err instanceof Error ? err.message : String(err)})`);
      }
    }
    return lines.join("\n");
  }

  async getPromptResult(
    server: string,
    name: string,
    args: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const connection = this.connections.get(server);
    if (!connection || connection.state !== "ready") {
      return {
        isError: true,
        output: `MCP server '${server}' is not ready${connection?.error ? `: ${connection.error}` : ""}`,
      };
    }
    try {
      const result = (await connection.getPrompt(name, args, signal)) as
        | { description?: unknown; messages?: unknown[] }
        | undefined;
      const lines: string[] = [];
      if (typeof result?.description === "string" && result.description.trim()) {
        lines.push(result.description.trim());
      }
      for (const row of Array.isArray(result?.messages) ? result.messages : []) {
        if (typeof row !== "object" || row === null) continue;
        const message = row as Record<string, unknown>;
        const role = typeof message.role === "string" ? message.role : "user";
        const content = message.content;
        if (typeof content === "object" && content !== null) {
          const block = content as Record<string, unknown>;
          if (block.type === "text" && typeof block.text === "string") {
            lines.push(`[${role}]\n${block.text}`);
            continue;
          }
        }
        lines.push(`[${role}] ${JSON.stringify(content)}`);
      }
      return {
        output: truncateOutput(lines.join("\n\n").trim() || "(prompt returned no messages)"),
        summary: `${server}/${name}`,
      };
    } catch (err) {
      return {
        isError: true,
        output: `MCP prompt failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async listResources(server?: string, signal?: AbortSignal): Promise<string> {
    const targets = server
      ? [this.connections.get(server)].filter((connection): connection is McpConnection => Boolean(connection))
      : [...this.connections.values()].filter(
          (connection) => connection.state === "ready" && connection.supportsResources,
        );
    if (targets.length === 0) {
      return server ? `MCP server '${server}' not found or has no resources.` : "No MCP resources available.";
    }
    const lines: string[] = [];
    for (const connection of targets) {
      if (connection.state !== "ready") {
        lines.push(`## ${connection.name} (not ready${connection.error ? `: ${connection.error}` : ""})`);
        continue;
      }
      try {
        const resources = await connection.listResources(signal);
        lines.push(`## ${connection.name} (${resources.length})`);
        if (resources.length === 0) lines.push("- (no resources)");
        for (const resource of resources) {
          lines.push(
            `- ${resource.uri}${resource.name ? ` — ${resource.name}` : ""}${resource.mimeType ? ` (${resource.mimeType})` : ""}`,
          );
        }
        const templates = await connection.listResourceTemplates(signal);
        if (templates.length > 0) {
          lines.push(`Templates (${templates.length}):`);
          for (const template of templates) {
            lines.push(
              `- ${template.uriTemplate}${template.name ? ` — ${template.name}` : ""}`,
            );
          }
        }
      } catch (err) {
        lines.push(`## ${connection.name} (error: ${err instanceof Error ? err.message : String(err)})`);
      }
    }
    return lines.join("\n");
  }

  async readResource(server: string, uri: string, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const connection = this.connections.get(server);
    if (!connection || connection.state !== "ready") {
      return {
        isError: true,
        output: `MCP server '${server}' is not ready${connection?.error ? `: ${connection.error}` : ""}`,
      };
    }
    try {
      const result = (await connection.readResource(uri, signal)) as
        | { contents?: unknown[] }
        | undefined;
      const contents = Array.isArray(result?.contents) ? result.contents : [];
      const rendered = renderMcpContent(
        contents.map((item) =>
          typeof item === "object" && item !== null
            ? { ...(item as Record<string, unknown>), type: "resource", resource: item }
            : item,
        ),
        `mcp:${server}/resource`,
      );
      return {
        output: truncateOutput(rendered.text.join("\n").trim() || "(resource is empty)"),
        summary: `${server} ${uri}`,
        imageAttachments: rendered.images.length > 0 ? rendered.images : undefined,
        imageAttachment: rendered.images[0],
      };
    } catch (err) {
      return {
        isError: true,
        output: `MCP resource read failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  getStatuses(): McpServerStatus[] {
    const statuses: McpServerStatus[] = [];
    for (const [name, error] of this.configErrors) {
      statuses.push({
        name,
        transport: "stdio",
        state: "error",
        toolCount: 0,
        resourcesSupported: false,
        promptsSupported: false,
        hasInstructions: false,
        error,
      });
    }
    for (const connection of this.connections.values()) {
      statuses.push({
        name: connection.name,
        transport: connection.transportKind,
        state: connection.state,
        toolCount: connection.tools.length,
        resourcesSupported: connection.supportsResources,
        promptsSupported: connection.supportsPrompts,
        hasInstructions: Boolean(connection.instructions),
        serverName: connection.serverName,
        serverVersion: connection.serverVersion,
        sandbox: connection.sandboxDescription,
        approval: connection.config.approval ?? "ask",
        sampling: connection.supportsSampling,
        elicitation: connection.supportsElicitation,
        authenticated: Boolean(connection.auth),
        error: connection.error,
      });
    }
    return statuses.sort((a, b) => a.name.localeCompare(b.name));
  }

  formatStatus(): string {
    const statuses = this.getStatuses();
    if (statuses.length === 0) {
      return "No MCP servers configured. Add `mcpServers` to ~/.aivokey/config.json or .aivokey.json.";
    }
    const lines = ["MCP Servers:"];
    for (const status of statuses) {
      const detail = [
        status.transport,
        status.state,
        `${status.toolCount} tool(s)`,
        status.resourcesSupported ? "resources" : null,
        status.promptsSupported ? "prompts" : null,
        status.hasInstructions ? "instructions" : null,
        status.sandbox ? `sandbox: ${status.sandbox}` : null,
        status.approval ? `approval: ${status.approval}` : null,
        status.authenticated ? "oauth" : null,
        status.sampling ? "sampling" : null,
        status.elicitation ? "elicitation" : null,
        status.serverName ? `${status.serverName}${status.serverVersion ? `@${status.serverVersion}` : ""}` : null,
        status.error ? `error: ${status.error}` : null,
      ].filter(Boolean);
      lines.push(`- ${status.name}: ${detail.join(" · ")}`);
    }
    return lines.join("\n");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    this.bindings.clear();
    McpManager.activeManagers.delete(this);
  }
}
