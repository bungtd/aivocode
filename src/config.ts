import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_GATEWAY_ORIGIN = "https://api.aivokey.dev";
export const DEFAULT_MODEL = "deepseek-v4-pro";

export type AivoWire = "chat" | "messages" | "responses";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "off";
export type PermissionMode = "auto" | "safe" | "plan";

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

export interface UserConfigFile {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fastModel?: string;
  wire?: AivoWire;
  reasoningEffort?: ReasoningEffort;
  mode?: PermissionMode;
  webSearch?: boolean;
}

export interface AivoConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  fastModel: string | null;
  wire: AivoWire;
  reasoningEffort: ReasoningEffort;
  mode: PermissionMode;
  webSearch: boolean;
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
  const trimmed = (raw ?? "").trim();
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
  let id = (raw ?? "").trim().toLowerCase();
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
    if (typeof raw.wire === "string" && VALID_WIRES.has(raw.wire as AivoWire)) {
      cfg.wire = raw.wire as AivoWire;
    }
    if (typeof raw.reasoningEffort === "string" && VALID_EFFORTS.has(raw.reasoningEffort as ReasoningEffort)) {
      cfg.reasoningEffort = raw.reasoningEffort as ReasoningEffort;
    }
    if (typeof raw.mode === "string" && VALID_MODES.has(raw.mode as PermissionMode)) {
      cfg.mode = raw.mode as PermissionMode;
    }
    if (typeof raw.webSearch === "boolean") {
      cfg.webSearch = raw.webSearch;
    }
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

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return merged;
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
    workspaceCfg.fastModel ??
    globalCfg.fastModel ??
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
    "medium"
  ) as ReasoningEffort;

  const rawMode = (
    cli.mode ??
    env.AIVOKEY_MODE ??
    workspaceCfg.mode ??
    globalCfg.mode ??
    "auto"
  ) as PermissionMode;

  const webSearch =
    cli.webSearch ??
    (env.AIVOKEY_WEB_SEARCH === "1" || env.AIVOKEY_WEB_SEARCH === "true"
      ? true
      : env.AIVOKEY_WEB_SEARCH === "0" || env.AIVOKEY_WEB_SEARCH === "false"
        ? false
        : undefined) ??
    workspaceCfg.webSearch ??
    globalCfg.webSearch ??
    false;

  return {
    apiKey: rawApiKey.trim(),
    baseUrl: normalizeGatewayOrigin(rawBaseUrl),
    model: normalizeModelId(rawModel),
    fastModel: rawFastModel ? normalizeModelId(rawFastModel) : null,
    wire: VALID_WIRES.has(rawWire) ? rawWire : "chat",
    reasoningEffort: VALID_EFFORTS.has(rawEffort) ? rawEffort : "medium",
    mode: VALID_MODES.has(rawMode) ? rawMode : "auto",
    webSearch,
    cwd,
    globalConfigPath,
  };
}
