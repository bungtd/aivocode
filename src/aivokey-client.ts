import { endpointUrl, DEFAULT_MODEL } from "./config.js";

export interface AivoModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  supportsPromptCache: boolean;
  supportsJsonMode: boolean;
  supportedEfforts: string[];
  inputMicroPer1M: bigint;
  outputMicroPer1M: bigint;
  cacheReadMicroPer1M: bigint;
  cacheWriteMicroPer1M: bigint | null;
  category: string | null;
}

export interface AllowanceWindowStatus {
  limitMicro: bigint;
  usedMicro: bigint;
  resetAt: string;
}

export interface ModelAllowanceStatus {
  model: string;
  w5h: AllowanceWindowStatus;
  w7d: AllowanceWindowStatus;
  month: AllowanceWindowStatus;
}

export interface TokenPoolEntry {
  model: string;
  remainingTokens: bigint;
}

export interface KeyInspectStatus {
  mode: "plan" | "payg";
  balanceMicro: bigint;
  fallbackEnabled: boolean;
  freeTokens: TokenPoolEntry[];
  purchasedTokens: TokenPoolEntry[];
  plan: {
    name: string;
    allowanceMode: "per_model" | "global_pool";
  } | null;
  models: ModelAllowanceStatus[];
  global: {
    w5h: AllowanceWindowStatus;
    w7d: AllowanceWindowStatus;
    month: AllowanceWindowStatus;
  } | null;
}

export interface TurnUsageMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Convert USD-per-token decimal string (e.g. "0.000001") from `/v1/models`
 * into micro-USD per 1M tokens (`1_000_000n` = $1 / 1M tokens).
 */
export function usdPerTokenToMicroPer1M(usdStr: unknown): bigint {
  if (typeof usdStr !== "string" && typeof usdStr !== "number") return 0n;
  const num = Number(usdStr);
  if (!Number.isFinite(num) || num <= 0) return 0n;
  // 1 token price * 1_000_000 tokens * 1_000_000 micro-USD/USD = * 1e12
  return BigInt(Math.round(num * 1e12));
}

function safeBigInt(val: unknown): bigint {
  if (typeof val === "bigint") return val;
  if (typeof val === "number" && Number.isFinite(val)) return BigInt(Math.trunc(val));
  if (typeof val === "string" && /^-?\d+$/.test(val.trim())) return BigInt(val.trim());
  return 0n;
}

export function parseModelRow(raw: Record<string, unknown>): AivoModelInfo {
  const id = typeof raw.id === "string" ? raw.id : "";
  const name = typeof raw.name === "string" ? raw.name : id;
  const topProvider = (raw.top_provider ?? {}) as Record<string, unknown>;
  const contextWindow =
    typeof raw.context_length === "number" && raw.context_length > 0
      ? raw.context_length
      : typeof topProvider.context_length === "number" && topProvider.context_length > 0
        ? topProvider.context_length
        : 128_000;

  const maxOutputTokens =
    typeof topProvider.max_completion_tokens === "number" && topProvider.max_completion_tokens > 0
      ? topProvider.max_completion_tokens
      : 8192;

  const supportedParams = Array.isArray(raw.supported_parameters)
    ? raw.supported_parameters.filter((p): p is string => typeof p === "string")
    : [];

  const arch = (raw.architecture ?? {}) as Record<string, unknown>;
  const inputModalities = Array.isArray(arch.input_modalities)
    ? arch.input_modalities.filter((m): m is string => typeof m === "string")
    : ["text"];

  const reasoningObj =
    typeof raw.reasoning === "object" && raw.reasoning !== null
      ? (raw.reasoning as Record<string, unknown>)
      : null;

  const supportedEfforts = Array.isArray(reasoningObj?.supported_efforts)
    ? reasoningObj.supported_efforts.filter((e): e is string => typeof e === "string")
    : [];

  const supportsTools = supportedParams.includes("tools");
  const supportsVision = inputModalities.includes("image");
  const supportsReasoning = reasoningObj !== null || supportedParams.includes("reasoning");
  const supportsPromptCache = raw.prompt_cache === true;
  const supportsJsonMode = supportedParams.includes("response_format");

  const pricing = (raw.pricing ?? {}) as Record<string, unknown>;
  const inputMicroPer1M = usdPerTokenToMicroPer1M(pricing.prompt);
  const outputMicroPer1M = usdPerTokenToMicroPer1M(pricing.completion);
  const cacheReadMicroPer1M =
    pricing.input_cache_read !== undefined
      ? usdPerTokenToMicroPer1M(pricing.input_cache_read)
      : inputMicroPer1M;
  const cacheWriteMicroPer1M =
    pricing.input_cache_write !== undefined
      ? usdPerTokenToMicroPer1M(pricing.input_cache_write)
      : null;

  return {
    id,
    name,
    contextWindow,
    maxOutputTokens,
    supportsTools,
    supportsVision,
    supportsReasoning,
    supportsPromptCache,
    supportsJsonMode,
    supportedEfforts,
    inputMicroPer1M,
    outputMicroPer1M,
    cacheReadMicroPer1M,
    cacheWriteMicroPer1M,
    category: typeof raw.category === "string" ? raw.category : null,
  };
}

export const DEFAULT_AIVOKEY_CATALOG: AivoModelInfo[] = [
  {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCache: true,
    supportsJsonMode: true,
    supportedEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    inputMicroPer1M: 300_000n,
    outputMicroPer1M: 1_200_000n,
    cacheReadMicroPer1M: 30_000n,
    cacheWriteMicroPer1M: null,
    category: "flagship",
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCache: true,
    supportsJsonMode: true,
    supportedEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    inputMicroPer1M: 300_000n,
    outputMicroPer1M: 1_200_000n,
    cacheReadMicroPer1M: 30_000n,
    cacheWriteMicroPer1M: null,
    category: "flagship",
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCache: true,
    supportsJsonMode: true,
    supportedEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    inputMicroPer1M: 1_320_000n,
    outputMicroPer1M: 3_960_000n,
    cacheReadMicroPer1M: 132_000n,
    cacheWriteMicroPer1M: null,
    category: "flagship",
  },
  {
    id: "glm-5.3-flash",
    name: "GLM 5.3 Flash",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCache: true,
    supportsJsonMode: true,
    supportedEfforts: ["low", "medium", "high", "max"],
    inputMicroPer1M: 150_000n,
    outputMicroPer1M: 500_000n,
    cacheReadMicroPer1M: 15_000n,
    cacheWriteMicroPer1M: null,
    category: "coding",
  },
  {
    id: "glm-5.3",
    name: "GLM 5.3",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCache: true,
    supportsJsonMode: true,
    supportedEfforts: ["low", "medium", "high", "max"],
    inputMicroPer1M: 1_400_000n,
    outputMicroPer1M: 4_400_000n,
    cacheReadMicroPer1M: 140_000n,
    cacheWriteMicroPer1M: null,
    category: "coding",
  },
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCache: true,
    supportsJsonMode: true,
    supportedEfforts: ["low", "medium", "high", "max"],
    inputMicroPer1M: 4_000_000n,
    outputMicroPer1M: 20_000_000n,
    cacheReadMicroPer1M: 400_000n,
    cacheWriteMicroPer1M: null,
    category: "flagship",
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCache: true,
    supportsJsonMode: true,
    supportedEfforts: ["low", "medium", "high", "max"],
    inputMicroPer1M: 2_000_000n,
    outputMicroPer1M: 10_000_000n,
    cacheReadMicroPer1M: 200_000n,
    cacheWriteMicroPer1M: null,
    category: "flagship",
  },
  {
    id: "gpt-6.1-sol",
    name: "GPT 6.1 Sol",
    contextWindow: 1_100_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCache: true,
    supportsJsonMode: true,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    inputMicroPer1M: 4_000_000n,
    outputMicroPer1M: 15_000_000n,
    cacheReadMicroPer1M: 400_000n,
    cacheWriteMicroPer1M: null,
    category: "flagship",
  },
  {
    id: "gpt-6-luna",
    name: "GPT 6 Luna",
    contextWindow: 1_100_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCache: true,
    supportsJsonMode: true,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    inputMicroPer1M: 200_000n,
    outputMicroPer1M: 750_000n,
    cacheReadMicroPer1M: 20_000n,
    cacheWriteMicroPer1M: null,
    category: "coding",
  },
  {
    id: "gemini-4-argon",
    name: "Gemini 4 Argon",
    contextWindow: 1_100_000,
    maxOutputTokens: 65_536,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCache: true,
    supportsJsonMode: true,
    supportedEfforts: ["low", "medium", "high", "max"],
    inputMicroPer1M: 4_000_000n,
    outputMicroPer1M: 20_000_000n,
    cacheReadMicroPer1M: 400_000n,
    cacheWriteMicroPer1M: null,
    category: "flagship",
  },
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    contextWindow: 1_100_000,
    maxOutputTokens: 65_536,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCache: true,
    supportsJsonMode: true,
    supportedEfforts: ["low", "medium", "high", "max"],
    inputMicroPer1M: 1_500_000n,
    outputMicroPer1M: 7_500_000n,
    cacheReadMicroPer1M: 150_000n,
    cacheWriteMicroPer1M: null,
    category: "coding",
  },
  {
    id: "qwen3.8-flash",
    name: "Qwen 3.8 Flash",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCache: true,
    supportsJsonMode: true,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    inputMicroPer1M: 150_000n,
    outputMicroPer1M: 470_000n,
    cacheReadMicroPer1M: 15_000n,
    cacheWriteMicroPer1M: null,
    category: "coding",
  },
  {
    id: "mimo-v2.5",
    name: "MiMo V2.5",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCache: true,
    supportsJsonMode: true,
    supportedEfforts: ["low", "medium", "high"],
    inputMicroPer1M: 140_000n,
    outputMicroPer1M: 280_000n,
    cacheReadMicroPer1M: 14_000n,
    cacheWriteMicroPer1M: null,
    category: "coding",
  },
];

export async function fetchModels(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<AivoModelInfo[]> {
  const res = await fetchFn(endpointUrl(baseUrl, "models"), {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /v1/models failed with HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: unknown[] };
  if (!Array.isArray(body.data)) return [];
  return body.data
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map(parseModelRow)
    .filter((m) => m.id.length > 0);
}

function parseWindow(raw: unknown): AllowanceWindowStatus {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    limitMicro: safeBigInt(o.limit),
    usedMicro: safeBigInt(o.used),
    resetAt: typeof o.reset_at === "string" ? o.reset_at : "",
  };
}

export async function inspectKey(
  baseUrl: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<KeyInspectStatus> {
  const res = await fetchFn(endpointUrl(baseUrl, "key"), {
    method: "GET",
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET /v1/key failed (${res.status}): ${text || res.statusText}`);
  }
  const raw = (await res.json()) as Record<string, unknown>;
  const mode = raw.mode === "plan" ? "plan" : "payg";
  const balanceMicro = safeBigInt(raw.balance_micro);
  const fallbackEnabled = raw.fallback_enabled === true;

  const freeTokens: TokenPoolEntry[] = Array.isArray(raw.free_tokens)
    ? raw.free_tokens
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((x) => ({
          model: typeof x.model === "string" ? x.model : "",
          remainingTokens: safeBigInt(x.remaining),
        }))
        .filter((x) => x.model.length > 0 && x.remainingTokens > 0n)
    : [];

  const purchasedTokens: TokenPoolEntry[] = Array.isArray(raw.purchased_tokens)
    ? raw.purchased_tokens
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((x) => ({
          model: typeof x.model === "string" ? x.model : "",
          remainingTokens: safeBigInt(x.remaining),
        }))
        .filter((x) => x.model.length > 0 && x.remainingTokens > 0n)
    : [];

  const planObj =
    typeof raw.plan === "object" && raw.plan !== null
      ? (raw.plan as Record<string, unknown>)
      : null;

  const plan = planObj
    ? {
        name: typeof planObj.name === "string" ? planObj.name : "Plan",
        allowanceMode: (planObj.allowance_mode === "global_pool" ? "global_pool" : "per_model") as
          | "per_model"
          | "global_pool",
      }
    : null;

  const models: ModelAllowanceStatus[] = Array.isArray(raw.models)
    ? raw.models
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((x) => {
          const allowance =
            typeof x.allowance === "object" && x.allowance !== null
              ? (x.allowance as Record<string, unknown>)
              : {};
          return {
            model: typeof x.model === "string" ? x.model : "",
            w5h: parseWindow(allowance["5h"]),
            w7d: parseWindow(allowance["7d"]),
            month: parseWindow(allowance.month),
          };
        })
        .filter((x) => x.model.length > 0)
    : [];

  const globalObj =
    typeof raw.global === "object" && raw.global !== null
      ? (raw.global as Record<string, unknown>)
      : null;

  const global = globalObj
    ? {
        w5h: {
          limitMicro: safeBigInt(globalObj.limit_5h),
          usedMicro: safeBigInt(globalObj.used),
          resetAt: typeof globalObj.reset_at === "string" ? globalObj.reset_at : "",
        },
        w7d: {
          limitMicro: safeBigInt(globalObj.limit_7d),
          usedMicro: safeBigInt(globalObj.used_7d),
          resetAt: typeof globalObj.reset_at_7d === "string" ? globalObj.reset_at_7d : "",
        },
        month: {
          limitMicro: safeBigInt(globalObj.limit_month),
          usedMicro: safeBigInt(globalObj.used_month),
          resetAt: typeof globalObj.reset_at_month === "string" ? globalObj.reset_at_month : "",
        },
      }
    : null;

  return {
    mode,
    balanceMicro,
    fallbackEnabled,
    freeTokens,
    purchasedTokens,
    plan,
    models,
    global,
  };
}

export function isModelUsableByKey(modelId: string, keyStatus: KeyInspectStatus | null): boolean {
  if (!keyStatus) return true;
  const hasFree = keyStatus.freeTokens.some((f) => f.model === modelId && f.remainingTokens > 0n);
  if (hasFree) return true;
  const hasPurchased = keyStatus.purchasedTokens.some(
    (p) => p.model === modelId && p.remainingTokens > 0n,
  );
  if (hasPurchased) return true;

  if (keyStatus.mode === "plan") {
    if (keyStatus.plan?.allowanceMode === "per_model") {
      const m = keyStatus.models.find((x) => x.model === modelId);
      if (m) {
        const w5hOk = m.w5h.limitMicro === 0n || m.w5h.usedMicro < m.w5h.limitMicro;
        const w7dOk = m.w7d.limitMicro === 0n || m.w7d.usedMicro < m.w7d.limitMicro;
        const monthOk = m.month.limitMicro === 0n || m.month.usedMicro < m.month.limitMicro;
        if (w5hOk && w7dOk && monthOk) return true;
      }
      return keyStatus.fallbackEnabled && keyStatus.balanceMicro > 0n;
    }
    // global_pool plan: if models array lists allowed models or global pool has remaining
    if (keyStatus.global) {
      const g = keyStatus.global;
      const w5hOk = g.w5h.limitMicro === 0n || g.w5h.usedMicro < g.w5h.limitMicro;
      const monthOk = g.month.limitMicro === 0n || g.month.usedMicro < g.month.limitMicro;
      if (w5hOk && monthOk) return true;
    }
    return keyStatus.fallbackEnabled && keyStatus.balanceMicro > 0n;
  }

  // PAYG mode
  return keyStatus.balanceMicro > 0n;
}

export interface RecommendedCodingModels {
  primaryModel: string;
  fastModel: string;
  eligibleModels: AivoModelInfo[];
}

/**
 * Filters `/v1/models` to the models actually usable by the authenticated user's account:
 * - For `payg` accounts (or `plan` accounts with `fallbackEnabled: true` and positive balance),
 *   all active catalog models are available.
 * - For `plan` accounts without balance fallback, ONLY models included in the user's plan
 *   (or models where the user holds free faucet tokens / purchased token packs) are returned.
 */
export function filterEligibleModelsForAccount(
  catalog: AivoModelInfo[],
  keyStatus: KeyInspectStatus | null,
  opts: { toolsOnly?: boolean } = {},
): AivoModelInfo[] {
  const base = opts.toolsOnly ? catalog.filter((m) => m.supportsTools) : catalog;
  if (!keyStatus) return base;
  if (keyStatus.mode === "payg") return base;
  if (keyStatus.fallbackEnabled && keyStatus.balanceMicro > 0n) return base;

  const eligible = base.filter((m) => isModelUsableByKey(m.id, keyStatus));
  return eligible.length > 0 ? eligible : base;
}

/**
 * Cross-references `/v1/models` and `/v1/key` to pick the best primary coding model
 * and fast subagent/explorer model without ever triggering `403 model_not_in_plan`.
 */
export function recommendCodingModels(
  catalog: AivoModelInfo[],
  keyStatus: KeyInspectStatus | null,
  preferredPrimary?: string,
): RecommendedCodingModels {
  const toolCapable = catalog.filter((m) => m.supportsTools);
  const usable = toolCapable.filter((m) => isModelUsableByKey(m.id, keyStatus));
  const pool = usable.length > 0 ? usable : toolCapable;

  if (pool.length === 0) {
    return {
      primaryModel: preferredPrimary || DEFAULT_MODEL,
      fastModel: preferredPrimary || DEFAULT_MODEL,
      eligibleModels: [],
    };
  }

  const scorePrimary = (m: AivoModelInfo): number => {
    let score = 0;
    if (m.category === "flagship" || m.category === "coding") score += 40;
    if (m.supportsReasoning) score += 25;
    if (m.supportsPromptCache) score += 15;
    if (m.contextWindow >= 200_000) score += 15;
    if (keyStatus?.models.some((pm) => pm.model === m.id)) score += 30;
    if (keyStatus?.purchasedTokens.some((pt) => pt.model === m.id && pt.remainingTokens > 0n)) {
      score += 25;
    }
    if (keyStatus?.freeTokens.some((ft) => ft.model === m.id && ft.remainingTokens > 0n)) {
      score += 20;
    }
    return score;
  };

  const sortedPrimary = [...pool].sort((a, b) => scorePrimary(b) - scorePrimary(a));
  const preferredMatch = preferredPrimary
    ? pool.find((m) => m.id === preferredPrimary)
    : undefined;
  const primary = preferredMatch ?? sortedPrimary[0]!;

  // Fast model for explore subagents: prefer models with free tokens or lowest output cost
  const sortedFast = [...pool].sort((a, b) => {
    const aFree = keyStatus?.freeTokens.some((f) => f.model === a.id && f.remainingTokens > 0n) ? 1 : 0;
    const bFree = keyStatus?.freeTokens.some((f) => f.model === b.id && f.remainingTokens > 0n) ? 1 : 0;
    if (aFree !== bFree) return bFree - aFree;
    if (a.outputMicroPer1M !== b.outputMicroPer1M) {
      return a.outputMicroPer1M < b.outputMicroPer1M ? -1 : 1;
    }
    return 0;
  });

  const fast = sortedFast[0] ?? primary;

  return {
    primaryModel: primary.id,
    fastModel: fast.id,
    eligibleModels: pool,
  };
}

export function calculateTurnCostMicro(
  model: AivoModelInfo | undefined,
  usage: TurnUsageMetrics,
): { costMicro: bigint; cacheSavedMicro: bigint } {
  if (!model) return { costMicro: 0n, cacheSavedMicro: 0n };
  const inTok = BigInt(Math.max(0, usage.inputTokens));
  const outTok = BigInt(Math.max(0, usage.outputTokens));
  const cacheReadTok = BigInt(Math.max(0, usage.cacheReadTokens));
  const cacheWriteTok = BigInt(Math.max(0, usage.cacheWriteTokens));

  const writePrice = model.cacheWriteMicroPer1M ?? model.inputMicroPer1M;
  const totalMicroTimes1M =
    inTok * model.inputMicroPer1M +
    outTok * model.outputMicroPer1M +
    cacheReadTok * model.cacheReadMicroPer1M +
    cacheWriteTok * writePrice;

  const costMicro = (totalMicroTimes1M + 500_000n) / 1_000_000n;

  const fullReadDiff =
    model.inputMicroPer1M > model.cacheReadMicroPer1M
      ? model.inputMicroPer1M - model.cacheReadMicroPer1M
      : 0n;
  const cacheSavedMicro = (cacheReadTok * fullReadDiff + 500_000n) / 1_000_000n;

  return { costMicro, cacheSavedMicro };
}

export function formatMicroUsd(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const usd = Number(abs) / 1_000_000;
  const prefix = negative ? "-$" : "$";
  if (abs === 0n) return "$0.00";
  if (abs < 100_000n) {
    return `${prefix}${usd.toFixed(4)}`;
  }
  return `${prefix}${usd.toFixed(2)}`;
}

export function formatKeyStatusSummary(status: KeyInspectStatus): string {
  const parts: string[] = [];
  if (status.mode === "plan" && status.plan) {
    parts.push(`Plan: ${status.plan.name} (${status.plan.allowanceMode})`);
  } else {
    parts.push("Mode: PAYG");
  }
  parts.push(`Balance: ${formatMicroUsd(status.balanceMicro)}`);
  if (status.mode === "plan") {
    parts.push(`Fallback: ${status.fallbackEnabled ? "ON" : "OFF"}`);
  }
  if (status.freeTokens.length > 0) {
    const freeList = status.freeTokens
      .map((f) => `${f.model} (${Number(f.remainingTokens).toLocaleString("en-US")} tok)`)
      .join(", ");
    parts.push(`Free Faucet: ${freeList}`);
  }
  if (status.purchasedTokens.length > 0) {
    const packList = status.purchasedTokens
      .map((p) => `${p.model} (${Number(p.remainingTokens).toLocaleString("en-US")} tok)`)
      .join(", ");
    parts.push(`Token Packs: ${packList}`);
  }
  return parts.join(" · ");
}
