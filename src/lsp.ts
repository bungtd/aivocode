import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LspServerConfig } from "./config.js";
import { buildChildEnv } from "./env-utils.js";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspHover {
  contents: string;
  range?: LspRange;
}

export interface LspDocumentSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange?: LspRange;
  children?: LspDocumentSymbol[];
}

export interface LspWorkspaceSymbol {
  name: string;
  kind: number;
  location: LspLocation | { uri: string; range?: LspRange };
  containerName?: string;
}

export interface LspServerStatus {
  name: string;
  state: "idle" | "starting" | "ready" | "error";
  command: string;
  extensions: string[];
  error?: string;
}

export class LspError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspError";
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Waiter {
  resolve: (diagnostics: LspDiagnostic[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 2_500;

const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".json": "json",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".vue": "vue",
  ".svelte": "svelte",
};

const SEVERITY_LABEL: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

export function severityLabel(severity: number | undefined): string {
  return SEVERITY_LABEL[severity ?? 1] ?? "error";
}

export function formatLspLocation(location: LspLocation, cwd: string): string {
  let path = location.uri;
  try {
    path = fileURLToPath(location.uri);
  } catch {
    // Keep the URI for non-file schemes.
  }
  const relativePath = path.startsWith(cwd)
    ? path.slice(cwd.length).replace(/^[\\/]/, "")
    : path;
  return `${relativePath}:${location.range.start.line + 1}:${location.range.start.character + 1}`;
}

function quoteWindowsShellArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Canonical key for a document URI. Language servers normalize file URIs
 * differently (lowercase drive, percent-encoded colon), so diagnostics must be
 * stored and looked up through the same filesystem identity.
 */
export function documentUriKey(uri: string): string {
  try {
    const path = fileURLToPath(uri);
    const normalized = resolve(path).replace(/\\/g, "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  } catch {
    return uri;
  }
}

function expandEnvVars(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "");
}

function expandEnvRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) out[key] = expandEnvVars(value);
  return out;
}

function defaultExtensions(name: string, command: string): string[] {
  const key = `${name} ${command}`.toLowerCase();
  if (key.includes("typescript") || key.includes("tsserver")) {
    return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
  }
  if (key.includes("pyright") || key.includes("pylsp") || key.includes("python")) return [".py"];
  if (key.includes("rust-analyzer") || key.includes("rust")) return [".rs"];
  if (key.includes("gopls") || key.includes("go")) return [".go"];
  if (key.includes("json")) return [".json"];
  if (key.includes("css")) return [".css", ".scss"];
  if (key.includes("html")) return [".html"];
  return [];
}

function commandLooksAvailable(command: string, cwd?: string): boolean {
  const resolved = resolveExecutable(command, cwd);
  if (!resolved) return false;
  const result =
    process.platform === "win32"
      ? spawnSync(`"${resolved}" --version`, {
          timeout: 5_000,
          windowsHide: true,
          stdio: "ignore",
          shell: true,
        })
      : spawnSync(resolved, ["--version"], {
          timeout: 5_000,
          windowsHide: true,
          stdio: "ignore",
        });
  return !result.error && result.status === 0;
}

const WINDOWS_EXTENSIONS = [".cmd", ".exe", ".bat", ""];
const POSIX_EXTENSIONS = [""];

/**
 * Resolves a language-server command to an executable path, preferring the
 * workspace's `node_modules/.bin` (where TypeScript/Python servers are usually
 * installed locally) and then PATH. Returns undefined when nothing matches.
 */
export function resolveExecutable(command: string, cwd?: string): string | undefined {
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command) ? command : undefined;
  }
  const extensions = process.platform === "win32" ? WINDOWS_EXTENSIONS : POSIX_EXTENSIONS;
  const localBins = cwd ? [join(cwd, "node_modules", ".bin")] : [];
  const pathDirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  for (const dir of [...localBins, ...pathDirs]) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const AUTO_SERVERS: Array<{
  name: string;
  command: string;
  args: string[];
  extensions: string[];
}> = [
  {
    name: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  },
  { name: "pyright", command: "pyright-langserver", args: ["--stdio"], extensions: [".py"] },
  { name: "pylsp", command: "pylsp", args: [], extensions: [".py"] },
  { name: "rust-analyzer", command: "rust-analyzer", args: [], extensions: [".rs"] },
  { name: "gopls", command: "gopls", args: [], extensions: [".go"] },
];

/**
 * Minimal LSP stdio client with JSON-RPC 2.0 Content-Length framing.
 * It intentionally exposes only read-only operations used by the agent tools.
 */
class LspClient {
  readonly name: string;
  readonly config: LspServerConfig;
  readonly root: string;
  state: "starting" | "ready" | "error" = "starting";
  error: string | undefined;

  private child: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private readonly diagnosticsGeneration = new Map<string, number>();
  private readonly diagnosticsWaiters = new Map<string, Waiter[]>();
  private readonly openDocuments = new Map<string, { version: number; text: string }>();
  private stderrTail = "";
  private disposed = false;

  constructor(
    name: string,
    config: LspServerConfig,
    root: string,
    private readonly envAllow: string[],
  ) {
    this.name = name;
    this.config = config;
    this.root = root;
  }

  async start(): Promise<void> {
    if (!this.config.command) throw new LspError(`LSP server '${this.name}' has no command`);
    const cwd = this.config.cwd ? resolve(this.root, this.config.cwd) : this.root;
    const commandLower = this.config.command.toLowerCase();
    const needsWindowsShell =
      process.platform === "win32" &&
      (/\.(?:cmd|bat)$/i.test(this.config.command) ||
        ["npx", "npm", "pnpm", "yarn"].includes(commandLower));
    // With `shell: true` Node concatenates args without escaping, so pass one
    // pre-quoted command string instead of an args array.
    const spawnCommand = needsWindowsShell
      ? [this.config.command, ...(this.config.args ?? [])].map(quoteWindowsShellArg).join(" ")
      : this.config.command;
    const spawnArgs = needsWindowsShell ? [] : (this.config.args ?? []);

    this.child = spawn(spawnCommand, spawnArgs, {
      cwd,
      env: buildChildEnv({
        allow: this.envAllow,
        extra: expandEnvRecord(this.config.env),
      }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: needsWindowsShell,
    });

    this.child.stdin?.on("error", () => {
      // EPIPE during shutdown is expected; avoid an unhandled stream error.
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.handleData(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4_000);
    });
    this.child.on("error", (err) => this.fail(new LspError(`LSP process error: ${err.message}`)));
    this.child.on("exit", (code, signal) => {
      if (!this.disposed) {
        this.fail(
          new LspError(
            `LSP server '${this.name}' exited (code=${code ?? "null"}, signal=${signal ?? "none"})${this.stderrTail ? `: ${this.stderrTail.trim().slice(-500)}` : ""}`,
          ),
        );
      }
    });

    try {
      await this.request(
        "initialize",
        {
          processId: process.pid,
          rootUri: pathToFileURL(this.root).href,
          rootPath: this.root,
          workspaceFolders: [
            { uri: pathToFileURL(this.root).href, name: basename(this.root) || "workspace" },
          ],
          capabilities: {
            workspace: {
              workspaceFolders: true,
              configuration: true,
              symbol: { dynamicRegistration: false },
            },
            textDocument: {
              synchronization: { dynamicRegistration: false, didSave: true },
              hover: { contentFormat: ["markdown", "plaintext"] },
              definition: { linkSupport: true },
              references: { dynamicRegistration: false },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              publishDiagnostics: { relatedInformation: true },
            },
            window: { workDoneProgress: true },
          },
          initializationOptions: this.config.initializationOptions,
        },
        this.config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
      this.notify("initialized", {});
      if (this.config.settings) {
        this.notify("workspace/didChangeConfiguration", { settings: this.config.settings });
      }
      this.state = "ready";
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
      throw this.error ? new LspError(this.error) : err;
    }
  }

  private fail(error: Error): void {
    if (this.state === "error") return;
    this.state = "error";
    this.error = error.message;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const [uri, waiters] of this.diagnosticsWaiters) {
      const current = this.diagnostics.get(uri) ?? [];
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(current);
      }
      this.diagnosticsWaiters.delete(uri);
    }
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const lengthMatch = /content-length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        this.handleMessage(JSON.parse(body) as JsonRpcMessage);
      } catch {
        // Ignore malformed server messages; the next frame may still be valid.
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.method === undefined) {
      const numericId = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = this.pending.get(numericId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(numericId);
      if (message.error) {
        pending.reject(
          new LspError(
            `LSP ${message.error.code ?? ""}: ${message.error.message ?? "unknown error"}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      void this.handleServerRequest(message);
      return;
    }

    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri?: string; diagnostics?: unknown[] } | undefined;
      if (!params?.uri) return;
      const key = documentUriKey(params.uri);
      const diagnostics = Array.isArray(params.diagnostics)
        ? params.diagnostics
            .map((item): LspDiagnostic | null => {
              if (typeof item !== "object" || item === null) return null;
              const row = item as Record<string, unknown>;
              if (typeof row.message !== "string") return null;
              return {
                range: row.range as LspRange,
                severity: typeof row.severity === "number" ? row.severity : undefined,
                code:
                  typeof row.code === "string" || typeof row.code === "number"
                    ? row.code
                    : undefined,
                source: typeof row.source === "string" ? row.source : undefined,
                message: row.message,
              };
            })
            .filter((item): item is LspDiagnostic => item !== null)
        : [];
      this.diagnostics.set(key, diagnostics);
      this.diagnosticsGeneration.set(key, (this.diagnosticsGeneration.get(key) ?? 0) + 1);
      const waiters = this.diagnosticsWaiters.get(key);
      if (waiters) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(diagnostics);
        }
        this.diagnosticsWaiters.delete(key);
      }
    }
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    const id = message.id;
    const method = message.method;
    if (id === undefined || !method) return;
    let result: unknown = null;
    if (method === "workspace/configuration") {
      const params = message.params as { items?: unknown[] } | undefined;
      const count = Array.isArray(params?.items) ? params.items.length : 0;
      result = Array.from({ length: count }, () => this.config.settings ?? {});
    } else if (method === "workspace/workspaceFolders") {
      result = [{ uri: pathToFileURL(this.root).href, name: basename(this.root) || "workspace" }];
    } else if (method === "client/registerCapability" || method === "client/unregisterCapability") {
      result = null;
    } else if (method === "window/workDoneProgress/create") {
      result = null;
    } else if (method === "workspace/applyEdit") {
      result = { applied: false, failureReason: "AivoCode does not apply server-initiated edits" };
    }
    this.send({ jsonrpc: "2.0", id, result });
  }

  private send(message: JsonRpcMessage): void {
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    if (!this.child?.stdin || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      throw new LspError(`LSP server '${this.name}' is not running`);
    }
    this.child.stdin.write(header + body);
  }

  private notify(method: string, params: unknown): void {
    try {
      this.send({ jsonrpc: "2.0", method, params });
    } catch {
      // Notifications during shutdown are best-effort.
    }
  }

  request(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.state === "error") {
      return Promise.reject(new LspError(this.error ?? `LSP server '${this.name}' failed`));
    }
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new LspError(`LSP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectPromise(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private uriFor(absPath: string): string {
    return pathToFileURL(absPath).href;
  }

  private languageId(absPath: string): string {
    if (this.config.languageId) return this.config.languageId;
    return LANGUAGE_IDS[extname(absPath).toLowerCase()] ?? "plaintext";
  }

  async ensureOpen(absPath: string): Promise<string> {
    const uri = this.uriFor(absPath);
    const key = documentUriKey(uri);
    const text = readFileSync(absPath, "utf8");
    const existing = this.openDocuments.get(key);
    if (!existing) {
      this.openDocuments.set(key, { version: 1, text });
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: this.languageId(absPath), version: 1, text },
      });
    } else if (existing.text !== text) {
      const version = existing.version + 1;
      this.openDocuments.set(key, { version, text });
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    return uri;
  }

  private waitForDiagnostics(
    uriKey: string,
    afterGeneration: number,
    timeoutMs: number,
  ): Promise<LspDiagnostic[]> {
    if ((this.diagnosticsGeneration.get(uriKey) ?? 0) > afterGeneration) {
      return Promise.resolve(this.diagnostics.get(uriKey) ?? []);
    }
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        const waiters = this.diagnosticsWaiters.get(uriKey);
        if (waiters) {
          const index = waiters.findIndex((item) => item.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          if (waiters.length === 0) this.diagnosticsWaiters.delete(uriKey);
        }
        resolvePromise(this.diagnostics.get(uriKey) ?? []);
      }, timeoutMs);
      const waiters = this.diagnosticsWaiters.get(uriKey) ?? [];
      waiters.push({ resolve: resolvePromise, timer });
      this.diagnosticsWaiters.set(uriKey, waiters);
    });
  }

  async diagnosticsForFile(
    absPath: string,
    timeoutMs = DEFAULT_DIAGNOSTICS_TIMEOUT_MS,
  ): Promise<LspDiagnostic[]> {
    const key = documentUriKey(this.uriFor(absPath));
    const before = this.diagnosticsGeneration.get(key) ?? 0;
    await this.ensureOpen(absPath);
    return this.waitForDiagnostics(key, before, timeoutMs);
  }

  async hover(absPath: string, position: LspPosition): Promise<LspHover | null> {
    const uri = await this.ensureOpen(absPath);
    const result = (await this.request("textDocument/hover", {
      textDocument: { uri },
      position,
    })) as { contents?: unknown; range?: LspRange } | null;
    if (!result) return null;
    const contents = result.contents;
    let text = "";
    if (typeof contents === "string") {
      text = contents;
    } else if (Array.isArray(contents)) {
      text = contents
        .map((item) => {
          if (typeof item === "string") return item;
          if (typeof item === "object" && item !== null && "value" in item) {
            return String((item as { value?: unknown }).value ?? "");
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    } else if (typeof contents === "object" && contents !== null && "value" in contents) {
      text = String((contents as { value?: unknown }).value ?? "");
    }
    return { contents: text, range: result.range };
  }

  async definition(absPath: string, position: LspPosition): Promise<LspLocation[]> {
    const uri = await this.ensureOpen(absPath);
    const result = await this.request("textDocument/definition", {
      textDocument: { uri },
      position,
    });
    return normalizeLocations(result);
  }

  async references(absPath: string, position: LspPosition): Promise<LspLocation[]> {
    const uri = await this.ensureOpen(absPath);
    const result = await this.request("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    });
    return normalizeLocations(result);
  }

  async documentSymbols(absPath: string): Promise<LspDocumentSymbol[]> {
    const uri = await this.ensureOpen(absPath);
    const result = (await this.request("textDocument/documentSymbol", {
      textDocument: { uri },
    })) as unknown;
    return normalizeDocumentSymbols(result);
  }

  async workspaceSymbols(query: string): Promise<LspWorkspaceSymbol[]> {
    const result = (await this.request("workspace/symbol", { query })) as unknown;
    if (!Array.isArray(result)) return [];
    const out: LspWorkspaceSymbol[] = [];
    for (const item of result) {
      if (typeof item !== "object" || item === null) continue;
      const row = item as Record<string, unknown>;
      if (typeof row.name !== "string") continue;
      const location = row.location;
      if (typeof location === "object" && location !== null && "uri" in location) {
        out.push({
          name: row.name,
          kind: typeof row.kind === "number" ? row.kind : 0,
          location: location as LspLocation,
          containerName: typeof row.containerName === "string" ? row.containerName : undefined,
        });
      }
    }
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.notify("shutdown", null);
    } catch {
      // ignore
    }
    try {
      this.notify("exit", null);
    } catch {
      // ignore
    }
    const child = this.child;
    this.child = null;
    if (child?.pid) {
      if (process.platform === "win32") {
        try {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          child.kill();
        }
      } else {
        child.kill();
      }
    }
  }
}

function normalizeLocations(value: unknown): LspLocation[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeLocations(item));
  }
  if (typeof value === "object" && value !== null && "uri" in value && "range" in value) {
    return [value as LspLocation];
  }
  if (typeof value === "object" && value !== null && "targetUri" in value) {
    const row = value as { targetUri: string; targetRange: LspRange; targetSelectionRange?: LspRange };
    return [{ uri: row.targetUri, range: row.targetSelectionRange ?? row.targetRange }];
  }
  return [];
}

function normalizeDocumentSymbols(value: unknown): LspDocumentSymbol[] {
  if (!Array.isArray(value)) return [];
  const out: LspDocumentSymbol[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.name === "string" && typeof row.kind === "number") {
      out.push({
        name: row.name,
        kind: row.kind,
        range: row.range as LspRange,
        selectionRange: row.selectionRange as LspRange | undefined,
        children: normalizeDocumentSymbols(row.children),
      });
      continue;
    }
    if (typeof row.name === "string" && typeof row.location === "object" && row.location !== null) {
      const location = row.location as LspLocation;
      out.push({
        name: row.name,
        kind: typeof row.kind === "number" ? row.kind : 0,
        range: location.range,
        children: [],
      });
    }
  }
  return out;
}

export class LspManager {
  private readonly clients = new Map<string, LspClient>();
  private readonly configs = new Map<string, LspServerConfig>();
  private readonly extensions = new Map<string, string>();
  private readonly statuses = new Map<string, LspServerStatus>();
  private initialized = false;

  constructor(
    private readonly opts: {
      cwd: string;
      servers?: Record<string, LspServerConfig>;
      envAllow?: string[];
    },
  ) {}

  private ensureConfigured(): void {
    if (this.initialized) return;
    this.initialized = true;

    const configured = this.opts.servers;
    const entries: Array<{ name: string; config: LspServerConfig }> = [];
    const hasConfiguredServers =
      configured !== undefined &&
      Object.values(configured).some((config) => config.enabled !== false && Boolean(config.command));
    if (hasConfiguredServers) {
      for (const [name, config] of Object.entries(configured)) {
        if (config.enabled === false || !config.command) continue;
        entries.push({ name, config });
      }
    } else {
      // No explicit config: auto-detect only servers that are actually installed.
      for (const candidate of AUTO_SERVERS) {
        if (!commandLooksAvailable(candidate.command, this.opts.cwd)) continue;
        const resolved = resolveExecutable(candidate.command, this.opts.cwd) ?? candidate.command;
        entries.push({
          name: candidate.name,
          config: {
            command: resolved,
            args: candidate.args,
            extensions: candidate.extensions,
          },
        });
      }
    }

    for (const { name, config } of entries) {
      const extensions = (
        config.extensions && config.extensions.length > 0
          ? config.extensions
          : defaultExtensions(name, config.command ?? "")
      ).map((ext) => (ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`));
      if (extensions.length === 0) continue;
      this.configs.set(name, config);
      for (const ext of extensions) {
        if (!this.extensions.has(ext)) this.extensions.set(ext, name);
      }
      this.statuses.set(name, {
        name,
        state: "idle",
        command: config.command ?? "",
        extensions,
      });
    }
  }

  hasServers(): boolean {
    this.ensureConfigured();
    return this.configs.size > 0;
  }

  getStatuses(): LspServerStatus[] {
    this.ensureConfigured();
    return [...this.statuses.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getServerForFile(absPath: string): string | undefined {
    this.ensureConfigured();
    return this.extensions.get(extname(absPath).toLowerCase());
  }

  private async clientForFile(absPath: string): Promise<LspClient> {
    this.ensureConfigured();
    const serverName = this.getServerForFile(absPath);
    if (!serverName) {
      throw new LspError(
        `No LSP server configured for '${extname(absPath) || absPath}'. Add lspServers to ~/.aivokey/config.json or .aivokey.json.`,
      );
    }
    const existing = this.clients.get(serverName);
    if (existing) {
      if (existing.state === "error") throw new LspError(existing.error ?? `LSP server '${serverName}' failed`);
      return existing;
    }
    const config = this.configs.get(serverName);
    if (!config) throw new LspError(`LSP server '${serverName}' is not configured`);
    const client = new LspClient(serverName, config, this.opts.cwd, this.opts.envAllow ?? []);
    this.clients.set(serverName, client);
    const status = this.statuses.get(serverName);
    if (status) status.state = "starting";
    try {
      await client.start();
      if (status) status.state = "ready";
      return client;
    } catch (err) {
      if (status) {
        status.state = "error";
        status.error = err instanceof Error ? err.message : String(err);
      }
      throw err;
    }
  }

  async diagnostics(
    absPath: string,
    timeoutMs?: number,
  ): Promise<{ server: string; diagnostics: LspDiagnostic[] }> {
    const client = await this.clientForFile(absPath);
    return { server: client.name, diagnostics: await client.diagnosticsForFile(absPath, timeoutMs) };
  }

  async hover(absPath: string, position: LspPosition): Promise<{ server: string; hover: LspHover | null }> {
    const client = await this.clientForFile(absPath);
    return { server: client.name, hover: await client.hover(absPath, position) };
  }

  async definition(absPath: string, position: LspPosition): Promise<{ server: string; locations: LspLocation[] }> {
    const client = await this.clientForFile(absPath);
    return { server: client.name, locations: await client.definition(absPath, position) };
  }

  async references(absPath: string, position: LspPosition): Promise<{ server: string; locations: LspLocation[] }> {
    const client = await this.clientForFile(absPath);
    return { server: client.name, locations: await client.references(absPath, position) };
  }

  async documentSymbols(absPath: string): Promise<{ server: string; symbols: LspDocumentSymbol[] }> {
    const client = await this.clientForFile(absPath);
    return { server: client.name, symbols: await client.documentSymbols(absPath) };
  }

  async workspaceSymbols(query: string): Promise<{ server: string; symbols: LspWorkspaceSymbol[] }[]> {
    this.ensureConfigured();
    const results: Array<{ server: string; symbols: LspWorkspaceSymbol[] }> = [];
    for (const name of this.configs.keys()) {
      const status = this.statuses.get(name);
      if (status?.state === "error") continue;
      const client = this.clients.get(name);
      if (client?.state === "error") continue;
      try {
        const active = client ?? (await this.clientForFileForServer(name));
        if (!active) continue;
        results.push({ server: name, symbols: await active.workspaceSymbols(query) });
      } catch {
        // A failed server should not block symbols from other languages.
      }
    }
    return results;
  }

  private async clientForFileForServer(serverName: string): Promise<LspClient | null> {
    const config = this.configs.get(serverName);
    if (!config) return null;
    const existing = this.clients.get(serverName);
    if (existing) return existing.state === "error" ? null : existing;
    const client = new LspClient(serverName, config, this.opts.cwd, this.opts.envAllow ?? []);
    this.clients.set(serverName, client);
    const status = this.statuses.get(serverName);
    if (status) status.state = "starting";
    try {
      await client.start();
      if (status) status.state = "ready";
      return client;
    } catch (err) {
      if (status) {
        status.state = "error";
        status.error = err instanceof Error ? err.message : String(err);
      }
      return null;
    }
  }

  async restart(name?: string): Promise<void> {
    this.ensureConfigured();
    const targets = name ? [name] : [...this.clients.keys()];
    for (const serverName of targets) {
      const client = this.clients.get(serverName);
      client?.dispose();
      this.clients.delete(serverName);
      const status = this.statuses.get(serverName);
      if (status) {
        status.state = "idle";
        status.error = undefined;
      }
    }
  }

  formatStatus(): string {
    const statuses = this.getStatuses();
    if (statuses.length === 0) {
      return "No LSP servers configured or auto-detected. Add lspServers to ~/.aivokey/config.json or .aivokey.json (typescript-language-server, pyright-langserver, rust-analyzer, gopls, ...).";
    }
    const lines = ["LSP Servers:"];
    for (const status of statuses) {
      const detail = [
        status.state,
        status.command,
        status.extensions.join(","),
        status.error ? `error: ${status.error}` : null,
      ].filter(Boolean);
      lines.push(`- ${status.name}: ${detail.join(" · ")}`);
    }
    return lines.join("\n");
  }

  dispose(): void {
    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();
  }
}
