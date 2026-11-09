import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TeamId } from "./teams.js";
import { writeFileAtomic } from "./fs-util.js";
import { parsePermissionsConfig, type PermissionsConfig } from "./permissions.js";
import { parseHooksConfig, type HooksConfig } from "./hooks.js";
import { defaultMcpAuthPath } from "./mcp-oauth.js";
import { SANDBOX_MODES, type NetworkAccess, type SandboxMode } from "./sandbox.js";

export const DEFAULT_GATEWAY_ORIGIN = "https://api.aivokey.dev";
export const DEFAULT_MODEL = "deepseek-v4.1-flash";
export const DEFAULT_FAST_MODEL = "deepseek-v4.1-flash";

export type AivoWire = "chat" | "messages" | "responses";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "off";
export type PermissionMode = "auto" | "safe" | "plan";
export type ExecutionStrategy = "auto" | "subagent-driven" | "native" | "ask";

export const VALID_WIRES = new Set<AivoWire>(["chat", "messages", "responses"]);
export const VALID_EFFORTS = new Set<ReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "off",
]);
export const VALID_MODES = new Set<PermissionMode>(["auto", "safe", "plan"]);
export const VALID_STRATEGIES = new Set<ExecutionStrategy>([
  "auto",
  "subagent-driven",
  "native",
  "ask",
]);
export const VALID_TEAMS = new Set<TeamId>([
  "fullstack",
  "backend",
  "frontend",
  "android",
  "blender3d",
  "gamedev",
  "autopilot",
]);

export interface LspServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** File extensions handled by this server, e.g. [".ts", ".tsx"]. */
  extensions?: string[];
  /** LSP languageId sent in didOpen, e.g. "typescript". */
  languageId?: string;
  initializationOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  enabled?: boolean;
  timeoutMs?: number;
}

export interface McpServerConfig {
  /** stdio transport: executable to spawn. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** HTTP transport: Streamable HTTP endpoint. */
  url?: string;
  headers?: Record<string, string>;
  transport?: "stdio" | "http" | "sse";
  enabled?: boolean;
  timeoutMs?: number;
  /** Sandbox policy for this stdio server; `inherit` uses the session policy. */
  sandbox?: SandboxMode | "inherit";
  /** Per-server network policy; defaults to the session network policy. */
  network?: NetworkAccess;
  /**
   * Approval policy for this server's tools. `ask` (default) prompts for
   * non-read-only tools in auto mode; `auto` trusts them; `deny` blocks all.
   */
  approval?: "auto" | "ask" | "deny";
}

export interface UserConfigFile {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fastModel?: string;
  architectModel?: string;
  builderModel?: string;
  reviewerModel?: string;
  wire?: AivoWire;
  reasoningEffort?: ReasoningEffort;
  subagentEffort?: ReasoningEffort;
  mode?: PermissionMode;
  team?: TeamId;
  strategy?: ExecutionStrategy;
  autoReviewFix?: boolean;
  /** Isolate mutating subagents in their own git worktree (default: true). */
  worktreeIsolation?: boolean;
  setupCompleted?: boolean;
  webSearch?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  lspServers?: Record<string, LspServerConfig>;
  hooks?: HooksConfig;
  sandbox?: SandboxMode;
  permissions?: PermissionsConfig;
}

export interface AivoConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  fastModel: string | null;
  architectModel?: string | null;
  builderModel?: string | null;
  reviewerModel?: string | null;
  wire: AivoWire;
  reasoningEffort: ReasoningEffort;
  subagentEffort?: ReasoningEffort;
  mode: PermissionMode;
  team?: TeamId;
  strategy?: ExecutionStrategy;
  autoReviewFix?: boolean;
  /** Isolate mutating subagents in their own git worktree (default: true). */
  worktreeIsolation?: boolean;
  setupCompleted?: boolean;
  webSearch: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  lspServers?: Record<string, LspServerConfig>;
  hooks?: HooksConfig;
  /** Path to the OAuth token cache for remote MCP servers. */
  mcpAuthPath?: string;
  sandbox?: SandboxMode;
  permissions?: PermissionsConfig;
  cwd: string;
  globalConfigPath: string;
}

export type GatewayEndpoint =
  | "models"
  | "key"
  | "chat"
  | "messages"
  | "responses"
  | "count_tokens"
  | "images"
  | "videos";

const KNOWN_PROVIDER_PREFIXES = new Set([
  "aivokey",
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "openrouter",
  "zhipu",
  "moonshot",
  "xai",
  "cb",
  "inferhub",
]);

/**
 * Normalize any user-supplied gateway URL into the bare origin (`https://api.aivokey.dev`).
 * Strips trailing slashes, `/v1`, `/v1/chat/completions`, `/v1/messages`, `/v1/responses`.
 */
export function normalizeGatewayOrigin(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim().replace(/[\x00-\x1f\x7f]/g, "");
  if (!trimmed) return DEFAULT_GATEWAY_ORIGIN;
  let cleaned = trimmed.replace(/\/+$/, "");
  cleaned = cleaned.replace(/\/v1(?:\/(?:chat\/completions|messages|responses|models|key))?$/i, "");
  return cleaned || DEFAULT_GATEWAY_ORIGIN;
}

/**
 * Build the exact endpoint URL for any AivoKey route from a user baseUrl or origin.
 */
export function endpointUrl(baseUrlOrOrigin: string, endpoint: GatewayEndpoint): string {
  const origin = normalizeGatewayOrigin(baseUrlOrOrigin);
  switch (endpoint) {
    case "models":
      return `${origin}/v1/models`;
    case "key":
      return `${origin}/v1/key`;
    case "chat":
      return `${origin}/v1/chat/completions`;
    case "messages":
      return `${origin}/v1/messages`;
    case "responses":
      return `${origin}/v1/responses`;
    case "count_tokens":
      return `${origin}/v1/messages/count_tokens`;
    case "images":
      return `${origin}/v1/images/generations`;
    case "videos":
      return `${origin}/v1/videos`;
  }
}

/**
 * Normalize model IDs to AivoKey's bare canonical format:
 * - Strips accidental provider prefixes (`aivokey/deepseek-v4-pro` -> `deepseek-v4-pro`)
 * - Lowercases and trims while preserving exact hyphen/dot canonical slugs (`claude-sonnet-5-5`, `claude-opus-4.6`).
 */
export function normalizeModelId(raw: string | undefined | null): string {
  let id = (raw ?? "").trim().toLowerCase().replace(/[\x00-\x1f\x7f]/g, "");
  if (!id) return DEFAULT_MODEL;
  if (id.includes("/")) {
    const parts = id.split("/").filter(Boolean);
    if (parts.length >= 2 && KNOWN_PROVIDER_PREFIXES.has(parts[0]!)) {
      id = parts.slice(1).join("/");
    } else if (parts.length >= 2) {
      id = parts[parts.length - 1]!;
    }
  }
  return id;
}

/**
 * Matches a user-supplied model ID against the live catalog, handling dot/hyphen
 * variations (e.g. `claude-opus-4-6` <-> `claude-opus-4.6`).
 */
export function matchCatalogModelId(
  rawId: string,
  catalogIds: string[],
): string {
  const norm = normalizeModelId(rawId);
  if (catalogIds.includes(norm)) return norm;
  const canonicalKey = (s: string) => s.replace(/[._-]/g, "-");
  const targetKey = canonicalKey(norm);
  const matched = catalogIds.find((c) => canonicalKey(c) === targetKey);
  return matched ?? norm;
}

export function looksLikeApiKey(value: string): boolean {
  const v = value.trim();
  return /^sk-[a-zA-Z0-9_-]{12,}$/.test(v);
}

export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return "(not set)";
  if (trimmed.length <= 12) return "***";
  const prefix = trimmed.startsWith("sk-aivo_") ? "sk-aivo_" : trimmed.slice(0, 6);
  const tail = trimmed.slice(-4);
  return `${prefix}...${tail}`;
}

export function defaultGlobalConfigPath(): string {
  return join(homedir(), ".aivokey", "config.json");
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") continue;
    out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseLspServerConfig(value: unknown): LspServerConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.command !== "string" || !raw.command.trim()) return null;
  const cfg: LspServerConfig = { command: raw.command.trim() };
  if (Array.isArray(raw.args)) {
    cfg.args = raw.args.filter((arg): arg is string => typeof arg === "string");
  }
  const env = parseStringRecord(raw.env);
  if (env) cfg.env = env;
  if (typeof raw.cwd === "string" && raw.cwd.trim()) cfg.cwd = raw.cwd.trim();
  if (Array.isArray(raw.extensions)) {
    const extensions = [
      ...new Set(
        raw.extensions
          .filter((item): item is string => typeof item === "string")
          .map((item) => {
            const trimmed = item.trim().toLowerCase();
            if (!trimmed) return "";
            return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
          })
          .filter(Boolean),
      ),
    ];
    if (extensions.length > 0) cfg.extensions = extensions;
  }
  if (typeof raw.languageId === "string" && raw.languageId.trim()) {
    cfg.languageId = raw.languageId.trim();
  }
  if (typeof raw.initializationOptions === "object" && raw.initializationOptions !== null && !Array.isArray(raw.initializationOptions)) {
    cfg.initializationOptions = raw.initializationOptions as Record<string, unknown>;
  }
  if (typeof raw.settings === "object" && raw.settings !== null && !Array.isArray(raw.settings)) {
    cfg.settings = raw.settings as Record<string, unknown>;
  }
  if (typeof raw.enabled === "boolean") cfg.enabled = raw.enabled;
  if (typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) {
    cfg.timeoutMs = Math.min(120_000, Math.round(raw.timeoutMs));
  }
  return cfg;
}

export function parseMcpServerConfig(value: unknown): McpServerConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const cfg: McpServerConfig = {};
  if (typeof raw.command === "string" && raw.command.trim()) cfg.command = raw.command.trim();
  if (typeof raw.url === "string" && raw.url.trim()) cfg.url = raw.url.trim();
  if (!cfg.command && !cfg.url) return null;
  if (Array.isArray(raw.args)) {
    cfg.args = raw.args.filter((arg): arg is string => typeof arg === "string");
  }
  const env = parseStringRecord(raw.env);
  if (env) cfg.env = env;
  const headers = parseStringRecord(raw.headers);
  if (headers) cfg.headers = headers;
  if (typeof raw.cwd === "string" && raw.cwd.trim()) cfg.cwd = raw.cwd.trim();
  if (raw.transport === "stdio" || raw.transport === "http" || raw.transport === "sse") {
    cfg.transport = raw.transport;
  }
  if (typeof raw.enabled === "boolean") cfg.enabled = raw.enabled;
  if (typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) {
    cfg.timeoutMs = Math.min(120_000, Math.round(raw.timeoutMs));
  }
  if (raw.sandbox === "inherit" || SANDBOX_MODES.has(raw.sandbox as SandboxMode)) {
    cfg.sandbox = raw.sandbox as SandboxMode | "inherit";
  }
  if (raw.network === "allow" || raw.network === "deny") {
    cfg.network = raw.network;
  }
  if (raw.approval === "auto" || raw.approval === "ask" || raw.approval === "deny") {
    cfg.approval = raw.approval;
  }
  return cfg;
}

export function loadUserConfig(path: string = defaultGlobalConfigPath()): UserConfigFile {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const cfg: UserConfigFile = {};
    if (typeof raw.apiKey === "string" && raw.apiKey.trim()) cfg.apiKey = raw.apiKey.trim();
    if (typeof raw.baseUrl === "string" && raw.baseUrl.trim()) {
      cfg.baseUrl = normalizeGatewayOrigin(raw.baseUrl);
    }
    if (typeof raw.model === "string" && raw.model.trim()) {
      cfg.model = normalizeModelId(raw.model);
    }
    if (typeof raw.fastModel === "string" && raw.fastModel.trim()) {
      cfg.fastModel = normalizeModelId(raw.fastModel);
    }
    if (typeof raw.architectModel === "string" && raw.architectModel.trim()) {
      cfg.architectModel = normalizeModelId(raw.architectModel);
    }
    if (typeof raw.builderModel === "string" && raw.builderModel.trim()) {
      cfg.builderModel = normalizeModelId(raw.builderModel);
    }
    if (typeof raw.reviewerModel === "string" && raw.reviewerModel.trim()) {
      cfg.reviewerModel = normalizeModelId(raw.reviewerModel);
    }
    if (typeof raw.wire === "string" && VALID_WIRES.has(raw.wire as AivoWire)) {
      cfg.wire = raw.wire as AivoWire;
    }
    if (typeof raw.reasoningEffort === "string" && VALID_EFFORTS.has(raw.reasoningEffort as ReasoningEffort)) {
      cfg.reasoningEffort = raw.reasoningEffort as ReasoningEffort;
    }
    if (typeof raw.subagentEffort === "string" && VALID_EFFORTS.has(raw.subagentEffort as ReasoningEffort)) {
      cfg.subagentEffort = raw.subagentEffort as ReasoningEffort;
    }
    if (typeof raw.mode === "string" && VALID_MODES.has(raw.mode as PermissionMode)) {
      cfg.mode = raw.mode as PermissionMode;
    }
    if (typeof raw.team === "string" && VALID_TEAMS.has(raw.team as TeamId)) {
      cfg.team = raw.team as TeamId;
    }
    if (typeof raw.strategy === "string" && VALID_STRATEGIES.has(raw.strategy as ExecutionStrategy)) {
      cfg.strategy = raw.strategy as ExecutionStrategy;
    }
    if (typeof raw.autoReviewFix === "boolean") {
      cfg.autoReviewFix = raw.autoReviewFix;
    }
    if (typeof raw.worktreeIsolation === "boolean") {
      cfg.worktreeIsolation = raw.worktreeIsolation;
    }
    if (typeof raw.setupCompleted === "boolean") {
      cfg.setupCompleted = raw.setupCompleted;
    }
    if (typeof raw.webSearch === "boolean") {
      cfg.webSearch = raw.webSearch;
    }
    if (typeof raw.mcpServers === "object" && raw.mcpServers !== null && !Array.isArray(raw.mcpServers)) {
      const servers: Record<string, McpServerConfig> = {};
      for (const [name, value] of Object.entries(raw.mcpServers as Record<string, unknown>)) {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) continue;
        const parsed = parseMcpServerConfig(value);
        if (parsed) servers[name] = parsed;
      }
      if (Object.keys(servers).length > 0) cfg.mcpServers = servers;
    }
    if (typeof raw.lspServers === "object" && raw.lspServers !== null && !Array.isArray(raw.lspServers)) {
      const servers: Record<string, LspServerConfig> = {};
      for (const [name, value] of Object.entries(raw.lspServers as Record<string, unknown>)) {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) continue;
        const parsed = parseLspServerConfig(value);
        if (parsed) servers[name] = parsed;
      }
      if (Object.keys(servers).length > 0) cfg.lspServers = servers;
    }
    const hooks = parseHooksConfig(raw.hooks);
    if (hooks) cfg.hooks = hooks;
    if (typeof raw.sandbox === "string" && SANDBOX_MODES.has(raw.sandbox as SandboxMode)) {
      cfg.sandbox = raw.sandbox as SandboxMode;
    }
    const permissions = parsePermissionsConfig(raw.permissions);
    if (permissions) cfg.permissions = permissions;
    return cfg;
  } catch {
    return {};
  }
}

export function saveUserConfig(
  update: Partial<UserConfigFile>,
  path: string = defaultGlobalConfigPath(),
): UserConfigFile {
  const existing = loadUserConfig(path);
  const merged: UserConfigFile = {
    ...existing,
    ...update,
  };
  if (merged.baseUrl) merged.baseUrl = normalizeGatewayOrigin(merged.baseUrl);
  if (merged.model) merged.model = normalizeModelId(merged.model);
  if (merged.fastModel) merged.fastModel = normalizeModelId(merged.fastModel);
  if (merged.architectModel) merged.architectModel = normalizeModelId(merged.architectModel);
  if (merged.builderModel) merged.builderModel = normalizeModelId(merged.builderModel);
  if (merged.reviewerModel) merged.reviewerModel = normalizeModelId(merged.reviewerModel);

  writeFileAtomic(path, JSON.stringify(merged, null, 2) + "\n", 0o600);
  return merged;
}

/**
 * Persists a settings change to the config file that actually controls the current workspace.
 *
 * Resolution order is CLI > env > workspace `.aivokey.json` > global `~/.aivokey/config.json`.
 * Writing every slash command to the global file meant a workspace config silently overrode
 * the user's change on the next launch. If the workspace file defines one of the keys being
 * changed we update that file; otherwise we keep writing to the global config.
 */
export function saveConfigForWorkspace(
  target: { cwd: string; globalConfigPath: string },
  update: Partial<UserConfigFile>,
): UserConfigFile {
  const workspacePath = join(target.cwd, ".aivokey.json");
  if (existsSync(workspacePath)) {
    const workspace = loadUserConfig(workspacePath);
    const overridden = Object.keys(update).some(
      (key) => (workspace as Record<string, unknown>)[key] !== undefined,
    );
    if (overridden) {
      return saveUserConfig(update, workspacePath);
    }
  }
  return saveUserConfig(update, target.globalConfigPath);
}

export interface ResolveConfigOptions {
  cwd?: string;
  globalConfigPath?: string;
  env?: Record<string, string | undefined>;
  cli?: Partial<UserConfigFile>;
}

export function resolveConfig(opts: ResolveConfigOptions = {}): AivoConfig {
  const cwd = opts.cwd ?? process.cwd();
  const globalConfigPath = opts.globalConfigPath ?? defaultGlobalConfigPath();
  const env = opts.env ?? process.env;
  const cli = opts.cli ?? {};

  const globalCfg = loadUserConfig(globalConfigPath);
  const workspaceCfg = loadUserConfig(join(cwd, ".aivokey.json"));

  const rawApiKey =
    cli.apiKey ??
    env.AIVOKEY_API_KEY ??
    workspaceCfg.apiKey ??
    globalCfg.apiKey ??
    "";

  const rawBaseUrl =
    cli.baseUrl ??
    env.AIVOKEY_BASE_URL ??
    env.GATEWAY_URL ??
    workspaceCfg.baseUrl ??
    globalCfg.baseUrl ??
    DEFAULT_GATEWAY_ORIGIN;

  const rawModel =
    cli.model ??
    env.AIVOKEY_MODEL ??
    workspaceCfg.model ??
    globalCfg.model ??
    DEFAULT_MODEL;

  const rawFastModel =
    cli.fastModel ??
    env.AIVOKEY_FAST_MODEL ??
    env.AIVOKEY_SUBAGENT_MODEL ??
    workspaceCfg.fastModel ??
    globalCfg.fastModel ??
    null;

  const rawArchitectModel =
    cli.architectModel ??
    env.AIVOKEY_ARCHITECT_MODEL ??
    workspaceCfg.architectModel ??
    globalCfg.architectModel ??
    null;

  const rawBuilderModel =
    cli.builderModel ??
    env.AIVOKEY_BUILDER_MODEL ??
    workspaceCfg.builderModel ??
    globalCfg.builderModel ??
    null;

  const rawReviewerModel =
    cli.reviewerModel ??
    env.AIVOKEY_REVIEWER_MODEL ??
    workspaceCfg.reviewerModel ??
    globalCfg.reviewerModel ??
    null;

  const rawWire = (
    cli.wire ??
    env.AIVOKEY_WIRE ??
    workspaceCfg.wire ??
    globalCfg.wire ??
    "chat"
  ) as AivoWire;

  const rawEffort = (
    cli.reasoningEffort ??
    env.AIVOKEY_REASONING_EFFORT ??
    workspaceCfg.reasoningEffort ??
    globalCfg.reasoningEffort ??
    "off"
  ) as ReasoningEffort;

  const rawSubagentEffort = (
    cli.subagentEffort ??
    env.AIVOKEY_SUBAGENT_EFFORT ??
    workspaceCfg.subagentEffort ??
    globalCfg.subagentEffort ??
    "low"
  ) as ReasoningEffort;

  const rawMode = (
    cli.mode ??
    env.AIVOKEY_MODE ??
    workspaceCfg.mode ??
    globalCfg.mode ??
    "auto"
  ) as PermissionMode;

  const rawTeam = (
    cli.team ??
    env.AIVOKEY_TEAM ??
    workspaceCfg.team ??
    globalCfg.team
  ) as TeamId | undefined;

  const rawStrategy = (
    cli.strategy ??
    env.AIVOKEY_STRATEGY ??
    workspaceCfg.strategy ??
    globalCfg.strategy ??
    "auto"
  ) as ExecutionStrategy;

  const autoReviewFix =
    cli.autoReviewFix ??
    workspaceCfg.autoReviewFix ??
    globalCfg.autoReviewFix ??
    true;

  const worktreeIsolation =
    cli.worktreeIsolation ??
    workspaceCfg.worktreeIsolation ??
    globalCfg.worktreeIsolation ??
    true;

  const webSearch =
    cli.webSearch ??
    (env.AIVOKEY_WEB_SEARCH === "1" || env.AIVOKEY_WEB_SEARCH === "true"
      ? true
      : env.AIVOKEY_WEB_SEARCH === "0" || env.AIVOKEY_WEB_SEARCH === "false"
        ? false
        : undefined) ??
    workspaceCfg.webSearch ??
    globalCfg.webSearch ??
    true;

  const mcpServers: Record<string, McpServerConfig> = {
    ...(globalCfg.mcpServers ?? {}),
    ...(workspaceCfg.mcpServers ?? {}),
    ...(cli.mcpServers ?? {}),
  };
  const lspServers: Record<string, LspServerConfig> = {
    ...(globalCfg.lspServers ?? {}),
    ...(workspaceCfg.lspServers ?? {}),
  };
  const hooks: HooksConfig = { ...(globalCfg.hooks ?? {}) };
  for (const [event, list] of Object.entries(workspaceCfg.hooks ?? {})) {
    if (!list) continue;
    const key = event as keyof HooksConfig;
    hooks[key] = [...(hooks[key] ?? []), ...list];
  }

  const rawSandbox = (
    cli.sandbox ??
    workspaceCfg.sandbox ??
    globalCfg.sandbox ??
    "workspace"
  ) as SandboxMode;
  const permissions: PermissionsConfig = {
    ...(globalCfg.permissions ?? {}),
    ...(workspaceCfg.permissions ?? {}),
    ...(cli.permissions ?? {}),
  };

  return {
    apiKey: rawApiKey.trim(),
    baseUrl: normalizeGatewayOrigin(rawBaseUrl),
    model: normalizeModelId(rawModel),
    fastModel: rawFastModel ? normalizeModelId(rawFastModel) : null,
    architectModel: rawArchitectModel ? normalizeModelId(rawArchitectModel) : null,
    builderModel: rawBuilderModel ? normalizeModelId(rawBuilderModel) : null,
    reviewerModel: rawReviewerModel ? normalizeModelId(rawReviewerModel) : null,
    wire: VALID_WIRES.has(rawWire) ? rawWire : "chat",
    reasoningEffort: VALID_EFFORTS.has(rawEffort) ? rawEffort : "off",
    subagentEffort: VALID_EFFORTS.has(rawSubagentEffort) ? rawSubagentEffort : "low",
    mode: VALID_MODES.has(rawMode) ? rawMode : "auto",
    ...(rawTeam && VALID_TEAMS.has(rawTeam) ? { team: rawTeam } : {}),
    strategy: VALID_STRATEGIES.has(rawStrategy) ? rawStrategy : "auto",
    autoReviewFix,
    worktreeIsolation,
    setupCompleted: globalCfg.setupCompleted ?? workspaceCfg.setupCompleted ?? false,
    webSearch,
    mcpServers,
    lspServers,
    hooks: Object.keys(hooks).length > 0 ? hooks : undefined,
    mcpAuthPath: defaultMcpAuthPath(),
    sandbox: SANDBOX_MODES.has(rawSandbox) ? rawSandbox : "workspace",
    permissions,
    cwd,
    globalConfigPath,
  };
}
