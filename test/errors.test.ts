import { describe, expect, it } from "vitest";
import { parseAivoErrorResponse, AivoApiError } from "../src/errors.js";

describe("AivoKey canonical error parser & recovery policy", () => {
  it("maps 400 context_length_exceeded to compact_and_retry", async () => {
    const res = new Response(
      JSON.stringify({
        error: {
          message: "Input exceeds the model context window",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      }),
      { status: 400, headers: { "x-air-request-id": "req_ctx_1" } },
    );

    const err = await parseAivoErrorResponse(res);
    expect(err).toBeInstanceOf(AivoApiError);
    expect(err.code).toBe("context_length_exceeded");
    expect(err.recoveryAction).toBe("compact_and_retry");
    expect(err.requestId).toBe("req_ctx_1");
  });

  it("distinguishes 503 no_supply WITH Retry-After (wait_and_retry) vs WITHOUT Retry-After (fail_fast)", async () => {
    const transientRes = new Response(
      JSON.stringify({
        error: { message: "No healthy seller right now", type: "api_error", code: "no_supply" },
      }),
      { status: 503, headers: { "retry-after": "12", "x-air-request-id": "req_supply_1" } },
    );
    const transientErr = await parseAivoErrorResponse(transientRes);
    expect(transientErr.recoveryAction).toBe("wait_and_retry");
    expect(transientErr.retryAfterS).toBe(12);

    const permanentRes = new Response(
      JSON.stringify({
        error: { message: "No seller meets discount floor", type: "api_error", code: "no_supply" },
      }),
      { status: 503, headers: { "x-air-request-id": "req_supply_2" } },
    );
    const permanentErr = await parseAivoErrorResponse(permanentRes);
    expect(permanentErr.recoveryAction).toBe("fail_fast");
    expect(permanentErr.retryAfterS).toBeNull();
    expect(permanentErr.formatUserAdvice()).toContain("req_supply_2");
  });

  it("parses Anthropic-shaped 402 model_allowance_exhausted and extracts reset_at", async () => {
    const res = new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "billing_error",
          code: "model_allowance_exhausted",
          message: "5h window exhausted for deepseek-v4-pro",
          reset_at: "2026-10-27T08:00:00Z",
        },
      }),
      {
        status: 402,
        headers: {
          "x-air-reset-at": "2026-10-27T08:00:00Z",
          "x-air-request-id": "req_allow_1",
        },
      },
    );

    const err = await parseAivoErrorResponse(res);
    expect(err.code).toBe("model_allowance_exhausted");
    expect(err.resetAt).toBe("2026-10-27T08:00:00Z");
    expect(err.recoveryAction).toBe("allowance_exhausted");
    expect(err.formatUserAdvice()).toContain("2026-10-27T08:00:00Z");
  });

  it("parses 403 model_not_in_plan and 429 rate_limited with Retry-After", async () => {
    const planRes = new Response(
      JSON.stringify({
        error: {
          message: "model not available on your plan: claude-opus-4.6",
          type: "invalid_request_error",
          code: "model_not_in_plan",
        },
      }),
      { status: 403 },
    );
    const planErr = await parseAivoErrorResponse(planRes);
    expect(planErr.recoveryAction).toBe("switch_model_or_fallback");
    expect(planErr.formatUserAdvice()).toContain("/models");

    const rlRes = new Response(
      JSON.stringify({
        error: {
          message: "Too many requests",
          type: "rate_limit_error",
          code: "rate_limited",
        },
      }),
      { status: 429, headers: { "retry-after": "7" } },
    );
    const rlErr = await parseAivoErrorResponse(rlRes);
    expect(rlErr.recoveryAction).toBe("wait_and_retry");
    expect(rlErr.retryAfterS).toBe(7);
  });
});
