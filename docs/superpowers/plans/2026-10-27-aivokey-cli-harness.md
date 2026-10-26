# AivoCode (`@aivokey/cli`) Implementation Plan

**Goal:** Build a native, zero-bloat CLI coding harness specifically engineered for the AivoKey AI router & subscription platform, combining the best architectural patterns from Claude Code, OpenCode, Pi, DeepSeek Harness/Codex, CommandCode, and Hermes Agent.

**Architecture:** Modular TypeScript (ESM, Node >= 24) CLI harness speaking all three AivoKey wires (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`), with live catalog discovery (`/v1/models`), real-time quota/balance/faucet/plan window inspection (`/v1/key`), sticky session prompt-cache affinity (`x-opencode-session`), canonical AivoKey error recovery, deterministic-prefix context management with auto-compaction, file checkpoints with `/undo`, subagent delegation with explicit model+effort routing, and interactive REPL + headless CLI modes.

**Tech Stack:** Node.js >= 24, TypeScript 5.9 (strict), Vitest 3.2, zero external runtime dependencies.

## Lessons Applied from Major Harnesses & AivoKey Specifics

| Harness / Platform | Strengths Adopted | Weaknesses Fixed in AivoCode |
|---|---|---|
| **Claude Code** | Line-numbered `read_file`, exact `edit_file` replacement, `todo` tracking, `subagent` delegation, auto-compaction, `AGENTS.md`/`CLAUDE.md` discovery, `!cmd` shell escape | Fixes hardcoded Haiku background calls that trigger `403 model_not_in_plan`; fixes `/v1` base URL 404 trap; eliminates volatile early-message system reminders that bust prompt cache |
| **OpenCode** | Multi-model switching, parallel tool execution, worktree awareness, large-output file spillover | Eliminates manual `opencode.json` model registration and `aivokey/` prefix mismatch; auto-discovers bare canonical models from `/v1/models` |
| **Pi (`pi-coding-agent`)** | Radical simplicity, zero-dependency speed, transparent per-turn token/cache-hit/micro-USD cost accounting, JSONL session persistence & branching | Adds built-in `todo` state, scoped `subagent` (`explore` & `general`), and native AivoKey multi-wire support |
| **DeepSeek Harness / Codex** | Real-time `reasoning_content` / `thinking` streaming, full `minimal..max` reasoning effort ladder, explicit `model` + `reasoningEffort` subagent inheritance | Adds automatic fallback & plan-eligibility validation before spawning subagents |
| **CommandCode / Aider** | `@file` inline prompt mentions, automatic pre-edit file checkpoints with instant `/undo`, `/diff` inspection | Full agentic tool loop rather than brittle diff-only chat formats |
| **Hermes Agent** | Permission modes (`auto`, `safe`, `plan`), leaf subagent toolset scoping (`explore` read-only vs `general` full), `SKILL.md` / `AGENTS.md` loading | Native AivoKey `/v1/key` wallet & quota awareness |

## Modules & Tasks

1. **Task 1: Config, URL/Model Normalization & Credentials (`src/config.ts`)**
   - Normalizes any AivoKey URL (`https://api.aivokey.dev`, `https://api.aivokey.dev/v1/`, `http://localhost:8888/v1`) into canonical gateway origin (`https://api.aivokey.dev`) and builds wire paths cleanly.
   - Normalizes model IDs to bare canonical slugs (`aivokey/deepseek-v4-pro` -> `deepseek-v4-pro`).
   - Resolves config precedence: CLI args > Env vars (`AIVOKEY_API_KEY`, `AIVOKEY_BASE_URL`, `AIVOKEY_MODEL`, `AIVOKEY_FAST_MODEL`, `AIVOKEY_WIRE`, `AIVOKEY_REASONING_EFFORT`) > `.aivokey.json` > `~/.aivokey/config.json`.
   - Masks credentials and prevents saving API keys as labels.

2. **Task 2: AivoKey Client (`/v1/models` & `/v1/key`) & Smart Model Recommender (`src/aivokey-client.ts`)**
   - Fetches and parses OpenRouter-compatible `/v1/models` response (`context_length`, `top_provider.max_completion_tokens`, `pricing`, `supported_parameters`, `reasoning.supported_efforts`, `prompt_cache`, `architecture`).
   - Fetches and parses `/v1/key` (`mode`, `balance_micro`, `fallback_enabled`, `free_tokens`, `purchased_tokens`, `plan`, `models` 5h/7d/month windows, `global` windows).
   - Recommends best primary and fast/explorer models based on tool support, free faucet tokens, purchased token packs, plan eligibility, and remaining quota windows.

3. **Task 3: AivoKey Canonical Error Parser & Recovery Policy (`src/errors.ts`)**
   - Parses OpenAI and Anthropic error envelopes plus `x-air-request-id`, `x-air-model`, `x-air-reset-at`, `retry-after`.
   - Maps all AivoKey error codes (`context_length_exceeded`, `rate_limited`, `upstream_rate_limited`, `no_supply` with/without `Retry-After`, `model_allowance_exhausted`, `model_not_in_plan`, `insufficient_balance`, `auth_unavailable`, `invalid_api_key`) to deterministic recovery actions and actionable human messages.

4. **Task 4: Multi-Wire Protocol & Streaming Engine (`src/protocol.ts`)**
   - Supports `chat` (`/v1/chat/completions`), `messages` (`/v1/messages`), and `responses` (`/v1/responses`) with unified `ChatMessage`, `ToolDefinition`, `ToolCall`, `StreamEvent`, and `TurnUsage` types.
   - Injects sticky session headers (`x-opencode-session`, `x-session-id`, `x-claude-code-session-id`) and prompt cache hints (`cache_control`, `prompt_cache_key`).
   - Streams text deltas, reasoning/thinking deltas, tool call deltas, and usage metrics (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`).

5. **Task 5: File Checkpoints (`/undo`) & Coding Tools (`src/checkpoint.ts`, `src/tools/index.ts`)**
   - `CheckpointManager`: snapshots files before first modification per turn, supports `undoLastTurn()`, `listChangedFiles()`, `diffSummary()`.
   - Tools: `read_file` (1-based line numbers, offset/limit, directory listing), `write_file` (with checkpoint snapshot), `edit_file` (line-number prefix stripping, CRLF preservation, exact + whitespace-tolerant matching, checkpoint snapshot), `glob_files`, `grep_search`, `run_shell` (timeout, dangerous command guard, large output spillover to temp file), `todo_write`, `web_fetch`.
   - Enforces permission modes (`auto`, `safe`, `plan` read-only mode).

6. **Task 6: Deterministic Context Manager, `@file` Mentions, Project Memory & Auto-Compaction (`src/context.ts`, `src/session.ts`)**
   - Discovers `AGENTS.md`, `CLAUDE.md`, `.aivokey/instructions.md` and builds a static, cache-friendly system prompt prefix.
   - Expands `@path/to/file` mentions in user prompts cleanly.
   - Estimates token usage against model's real `context_length` and compacts old tool outputs + summarizes history on `/compact` or `context_length_exceeded`.
   - Persists sessions as JSONL in `~/.aivokey/sessions/` with resume and fork support.

7. **Task 7: Agentic Loop, Subagent Delegation & Auto-Recovery (`src/agent.ts`)**
   - Orchestrates multi-turn LLM + parallel tool execution loop.
   - Implements `subagent` tool (`explore` read-only on `fastModel`, `general` full toolset) with explicit `model` + `reasoningEffort` inheritance.
   - Automatically recovers from `context_length_exceeded` (compacts & retries) and transient `429`/`503` with `Retry-After`.
   - Calculates exact turn & session micro-USD cost (accounting for `input_cache_read` and `input_cache_write`) and cache hit rate.

8. **Task 8: CLI Subcommands, Interactive REPL & Entrypoint (`src/cli.ts`, `src/repl.ts`, `src/bin.ts`)**
   - Interactive REPL (`aivo`) with slash commands (`/help`, `/models`, `/model`, `/effort`, `/wire`, `/mode`, `/status`, `/usage`, `/key`, `/compact`, `/undo`, `/diff`, `/todo`, `/clear`, `/sessions`, `/fork`, `/login`, `/doctor`) and `!cmd` shell escape.
   - Headless runner (`aivo run "<prompt>"` / `aivo -p "<prompt>"`) and direct CLI commands (`aivo status`, `aivo models`, `aivo doctor`, `aivo login`).
