export type AivoRecoveryAction =
  | "compact_and_retry"
  | "wait_and_retry"
  | "switch_model_or_fallback"
  | "allowance_exhausted"
  | "top_up_or_faucet"
  | "switch_model"
  | "reauth"
  | "check_model_or_url"
  | "fail_fast";

export interface AivoErrorDetails {
  status: number;
  code: string;
  type: string;
  message: string;
  requestId: string | null;
  resetAt: string | null;
  retryAfterS: number | null;
  recoveryAction: AivoRecoveryAction;
}

export class AivoApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly type: string;
  readonly requestId: string | null;
  readonly resetAt: string | null;
  readonly retryAfterS: number | null;
  readonly recoveryAction: AivoRecoveryAction;

  constructor(details: AivoErrorDetails) {
    super(details.message);
    this.name = "AivoApiError";
    this.status = details.status;
    this.code = details.code;
    this.type = details.type;
    this.requestId = details.requestId;
    this.resetAt = details.resetAt;
    this.retryAfterS = details.retryAfterS;
    this.recoveryAction = details.recoveryAction;
  }

  formatUserAdvice(): string {
    const reqTag = this.requestId ? ` [request-id: ${this.requestId}]` : "";
    switch (this.code) {
      case "context_length_exceeded":
        return `Context window exceeded (${this.message}). Use /compact to compress history or switch to a larger-context model.${reqTag}`;
      case "invalid_api_key":
        return `Invalid or revoked AivoKey API key (${this.message}). Run 'aivo login' or set AIVOKEY_API_KEY.${reqTag}`;
      case "insufficient_balance":
        return `Insufficient balance or free tokens (${this.message}). Claim free tokens on /faucet, top up at /console/billing, or switch to a model with remaining free_tokens (/status).${reqTag}`;
      case "model_allowance_exhausted": {
        const resetInfo = this.resetAt ? ` Resets at ${this.resetAt}.` : "";
        return `Plan allowance exhausted (${this.message}).${resetInfo} Switch models with /model, use a model with free faucet tokens, or enable balance fallback on your API key.${reqTag}`;
      }
      case "model_not_in_plan":
        return `Model not included in your active plan (${this.message}). Run /models to pick an eligible model or enable balance fallback in Console -> API Keys.${reqTag}`;
      case "upstream_spend_limit_reached":
        return `Temporary upstream spending cap reached (${this.message}). Switch models with /model or retry later.${reqTag}`;
      case "no_supply":
        if (this.retryAfterS !== null) {
          return `Temporary supply gap for this model (${this.message}). Retrying after ${this.retryAfterS}s...${reqTag}`;
        }
        return `No seller meets the configured discount floor for this model (${this.message}). Retrying will not help — switch models or contact support with${reqTag || " the request ID"}.`;
      case "rate_limited":
      case "upstream_rate_limited":
        return `Rate limited (${this.message}). Waiting ${this.retryAfterS ?? 5}s before retry...${reqTag}`;
      case "auth_unavailable":
      case "upstream_error":
        return `Temporary gateway/upstream issue (${this.message}).${reqTag}`;
      case "stream_stalled":
        return `Upstream stream timed out (${this.message}) — retrying on a fresh route...${reqTag}`;
      case "not_found":
        return `Not found (${this.message}). Verify model ID via /models.${reqTag}`;
      default:
        return `AivoKey API Error (${this.status} ${this.code}): ${this.message}${reqTag}`;
    }
  }
}

export function determineRecoveryAction(
  status: number,
  code: string,
  retryAfterS: number | null,
): AivoRecoveryAction {
  if (code === "context_length_exceeded") return "compact_and_retry";
  if (code === "invalid_api_key" || status === 401) return "reauth";
  if (code === "insufficient_balance") return "top_up_or_faucet";
  if (code === "model_allowance_exhausted") return "allowance_exhausted";
  if (code === "upstream_spend_limit_reached") return "switch_model";
  if (code === "model_not_in_plan" || status === 403) return "switch_model_or_fallback";
  if (code === "not_found" || status === 404) return "check_model_or_url";
  if (code === "rate_limited" || code === "upstream_rate_limited" || status === 429) {
    return "wait_and_retry";
  }
  if (code === "no_supply") {
    // Per AivoKey spec: 503 no_supply WITH Retry-After is transient; WITHOUT Retry-After is permanent floor config mismatch
    return retryAfterS !== null ? "wait_and_retry" : "fail_fast";
  }
  if (code === "auth_unavailable" || code === "upstream_error" || status === 502 || status === 503) {
    return "wait_and_retry";
  }
  return "fail_fast";
}

export async function parseAivoErrorResponse(res: Response): Promise<AivoApiError> {
  const status = res.status;
  const requestId = res.headers.get("x-air-request-id");
  const headerResetAt = res.headers.get("x-air-reset-at");
  const retryAfterRaw = res.headers.get("retry-after");
  const parsedRetry = retryAfterRaw !== null ? Number(retryAfterRaw) : NaN;
  const retryAfterS =
    Number.isFinite(parsedRetry) && parsedRetry > 0 ? Math.ceil(parsedRetry) : null;

  let code = status === 401 ? "invalid_api_key" : status === 429 ? "rate_limited" : "unknown_error";
  let type = "api_error";
  let message = `HTTP ${status} ${res.statusText || "Error"}`;
  let bodyResetAt: string | null = null;

  try {
    const text = await res.text();
    if (text) {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const errObj =
        typeof parsed.error === "object" && parsed.error !== null
          ? (parsed.error as Record<string, unknown>)
          : parsed;
      if (typeof errObj.code === "string" && errObj.code) code = errObj.code;
      if (typeof errObj.type === "string" && errObj.type) type = errObj.type;
      if (typeof errObj.message === "string" && errObj.message) message = errObj.message;
      if (typeof errObj.reset_at === "string" && errObj.reset_at) bodyResetAt = errObj.reset_at;
    }
  } catch {
    /* non-JSON error body */
  }

  const resetAt = headerResetAt ?? bodyResetAt;
  const recoveryAction = determineRecoveryAction(status, code, retryAfterS);

  return new AivoApiError({
    status,
    code,
    type,
    message,
    requestId,
    resetAt,
    retryAfterS,
    recoveryAction,
  });
}
