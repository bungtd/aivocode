import { describe, expect, it } from "vitest";
import {
  fetchModels,
  inspectKey,
  recommendCodingModels,
  calculateTurnCostMicro,
  formatMicroUsd,
  formatKeyStatusSummary,
  type AivoModelInfo,
} from "../src/aivokey-client.js";

const SAMPLE_MODELS_PAYLOAD = {
  object: "list",
  data: [
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      context_length: 256000,
      architecture: {
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
      },
      pricing: {
        prompt: "0.000001", // $1 / 1M
        completion: "0.000004", // $4 / 1M
        input_cache_read: "0.0000001", // $0.10 / 1M
        input_cache_write: "0.00000125", // $1.25 / 1M
      },
      top_provider: {
        context_length: 256000,
        max_completion_tokens: 32768,
      },
      supported_parameters: ["temperature", "max_tokens", "stream", "tools", "tool_choice", "reasoning"],
      reasoning: {
        default_enabled: true,
        supported_efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
      },
      prompt_cache: true,
      category: "flagship",
    },
    {
      id: "glm-5.3",
      name: "GLM 5.3",
      context_length: 128000,
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["text"],
      },
      pricing: {
        prompt: "0.0000003", // $0.30 / 1M
        completion: "0.0000012", // $1.20 / 1M
        input_cache_read: "0.00000005",
      },
      top_provider: {
        context_length: 128000,
        max_completion_tokens: 16384,
      },
      supported_parameters: ["temperature", "max_tokens", "stream", "tools", "tool_choice"],
      reasoning: null,
      prompt_cache: true,
      category: "coding",
    },
    {
      id: "chat-only-lite",
      name: "Chat Only Lite",
      context_length: 64000,
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["text"],
      },
      pricing: {
        prompt: "0.0000001",
        completion: "0.0000002",
      },
      top_provider: {
        context_length: 64000,
        max_completion_tokens: 4096,
      },
      supported_parameters: ["temperature", "max_tokens", "stream"],
      reasoning: null,
      prompt_cache: false,
      category: "general",
    },
  ],
};

describe("aivokey-client (/v1/models & /v1/key)", () => {
  it("fetches and parses /v1/models with capabilities, pricing, context length, and reasoning efforts", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify(SAMPLE_MODELS_PAYLOAD), { status: 200 });

    const models = await fetchModels("https://api.aivokey.dev", mockFetch);
    expect(models).toHaveLength(3);

    const ds = models.find((m) => m.id === "deepseek-v4-pro")!;
    expect(ds.contextWindow).toBe(256000);
    expect(ds.maxOutputTokens).toBe(32768);
    expect(ds.supportsTools).toBe(true);
    expect(ds.supportsVision).toBe(true);
    expect(ds.supportsReasoning).toBe(true);
    expect(ds.supportsPromptCache).toBe(true);
    expect(ds.supportedEfforts).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(ds.inputMicroPer1M).toBe(1_000_000n);
    expect(ds.outputMicroPer1M).toBe(4_000_000n);
    expect(ds.cacheReadMicroPer1M).toBe(100_000n);
    expect(ds.cacheWriteMicroPer1M).toBe(1_250_000n);

    const chatOnly = models.find((m) => m.id === "chat-only-lite")!;
    expect(chatOnly.supportsTools).toBe(false);
  });

  it("inspects /v1/key for plan and payg accounts including free_tokens and purchased_tokens", async () => {
    const keyPayload = {
      mode: "plan",
      balance_micro: "4250000",
      fallback_enabled: false,
      free_tokens: [{ model: "glm-5.3", remaining: "180000" }],
      purchased_tokens: [{ model: "deepseek-v4-pro", remaining: "500000" }],
      plan: { name: "Builder Pro", allowance_mode: "per_model" },
      models: [
        {
          model: "deepseek-v4-pro",
          allowance: {
            "5h": { limit: "5000000", used: "1250000", reset_at: "2026-10-27T06:00:00Z" },
            "7d": { limit: "25000000", used: "5000000", reset_at: "2026-11-01T00:00:00Z" },
            month: { limit: "60000000", used: "10000000", reset_at: "2026-11-27T00:00:00Z" },
          },
        },
      ],
    };

    const mockFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer sk-aivo_test123456");
      return new Response(JSON.stringify(keyPayload), { status: 200 });
    };

    const status = await inspectKey("https://api.aivokey.dev", "sk-aivo_test123456", mockFetch);
    expect(status.mode).toBe("plan");
    expect(status.balanceMicro).toBe(4_250_000n);
    expect(status.fallbackEnabled).toBe(false);
    expect(status.plan?.name).toBe("Builder Pro");
    expect(status.freeTokens).toEqual([{ model: "glm-5.3", remainingTokens: 180_000n }]);
    expect(status.purchasedTokens).toEqual([{ model: "deepseek-v4-pro", remainingTokens: 500_000n }]);
    expect(status.models[0]?.model).toBe("deepseek-v4-pro");
    expect(status.models[0]?.w5h.limitMicro).toBe(5_000_000n);
    expect(status.models[0]?.w5h.usedMicro).toBe(1_250_000n);

    const summary = formatKeyStatusSummary(status);
    expect(summary).toContain("Builder Pro");
    expect(summary).toContain("$4.25");
    expect(summary).toContain("glm-5.3");
  });

  it("recommends primary and fast subagent models that support tools and are permitted by the user plan/tokens", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify(SAMPLE_MODELS_PAYLOAD), { status: 200 });
    const models = await fetchModels("https://api.aivokey.dev", mockFetch);

    // User is on a plan that ONLY includes deepseek-v4-pro, but also has free faucet tokens on glm-5.3
    const keyStatus = {
      mode: "plan" as const,
      balanceMicro: 0n,
      fallbackEnabled: false,
      freeTokens: [{ model: "glm-5.3", remainingTokens: 150_000n }],
      purchasedTokens: [],
      plan: { name: "Starter", allowanceMode: "per_model" as const },
      models: [
        {
          model: "deepseek-v4-pro",
          w5h: { limitMicro: 5_000_000n, usedMicro: 1_000_000n, resetAt: "2026-10-27T06:00:00Z" },
          w7d: { limitMicro: 20_000_000n, usedMicro: 1_000_000n, resetAt: "2026-11-01T00:00:00Z" },
          month: { limitMicro: 50_000_000n, usedMicro: 1_000_000n, resetAt: "2026-11-27T00:00:00Z" },
        },
      ],
      global: null,
    };

    const rec = recommendCodingModels(models, keyStatus);
    expect(rec.primaryModel).toBe("deepseek-v4-pro");
    // glm-5.3 is eligible because it has free_tokens > 0 and is cheaper/faster!
    expect(rec.fastModel).toBe("glm-5.3");
    // chat-only-lite is excluded because it doesn't support tools
    expect(rec.eligibleModels.map((m: AivoModelInfo) => m.id)).not.toContain("chat-only-lite");
  });

  it("calculates exact turn cost in micro-USD accounting for prompt cache reads and writes", () => {
    const model: AivoModelInfo = {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      contextWindow: 256000,
      maxOutputTokens: 32768,
      supportsTools: true,
      supportsVision: true,
      supportsReasoning: true,
      supportsPromptCache: true,
      supportsJsonMode: false,
      supportedEfforts: ["low", "medium", "high"],
      inputMicroPer1M: 1_000_000n, // $1 / 1M
      outputMicroPer1M: 4_000_000n, // $4 / 1M
      cacheReadMicroPer1M: 100_000n, // $0.10 / 1M
      cacheWriteMicroPer1M: 1_250_000n, // $1.25 / 1M
      category: "flagship",
    };

    // 10,000 uncached input ($0.01 = 10,000 micro), 90,000 cache read ($0.009 = 9,000 micro),
    // 2,000 output ($0.008 = 8,000 micro) => 27,000 micro-USD ($0.027)
    const cost = calculateTurnCostMicro(model, {
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheReadTokens: 90_000,
      cacheWriteTokens: 0,
    });
    expect(cost.costMicro).toBe(27_000n);
    // Without cache read, 90,000 tokens would have cost 90,000 micro instead of 9,000 micro -> saved 81,000 micro!
    expect(cost.cacheSavedMicro).toBe(81_000n);
    expect(formatMicroUsd(27_000n)).toBe("$0.0270");
    expect(formatMicroUsd(4_250_000n)).toBe("$4.25");
  });
});
