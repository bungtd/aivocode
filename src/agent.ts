import type { AivoConfig } from "./config.js";
import {
  calculateTurnCostMicro,
  type AivoModelInfo,
  type TurnUsageMetrics,
} from "./aivokey-client.js";
import { AivoApiError } from "./errors.js";
import { streamTurn, type ChatMessage } from "./protocol.js";
import { CheckpointManager } from "./checkpoint.js";
import { createToolset, type TodoItem } from "./tools/index.js";
import {
  buildSystemPrompt,
  compactConversation,
  estimateConversationTokens,
  expandFileMentions,
} from "./context.js";
import { SessionStore, type AivoSession } from "./session.js";

export interface AgentCallbacks {
  onReasoningDelta?: (delta: string) => void;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, output: string, isError?: boolean) => void;
  onNotice?: (message: string) => void;
  confirmAction?: (description: string) => Promise<boolean>;
}

export interface AgentOptions {
  config: AivoConfig;
  catalog?: AivoModelInfo[];
  sessionStore?: SessionStore;
  session?: AivoSession;
  callbacks?: AgentCallbacks;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  maxSteps?: number;
  readOnlyOnly?: boolean;
  allowSubagents?: boolean;
}

export interface RunPromptResult {
  finalText: string;
  steps: number;
  turnUsage: TurnUsageMetrics;
  turnCostMicro: bigint;
  turnCacheSavedMicro: bigint;
}

export class AivoAgent {
  config: AivoConfig;
  catalog: AivoModelInfo[];
  readonly checkpoints: CheckpointManager;
  readonly todos: TodoItem[];
  readonly sessionStore: SessionStore;
  session: AivoSession;
  private callbacks: AgentCallbacks;
  private fetchFn: typeof fetch;
  private sleepFn: (ms: number) => Promise<void>;
  private maxSteps: number;
  private readOnlyOnly: boolean;
  private allowSubagents: boolean;

  constructor(opts: AgentOptions) {
    this.config = { ...opts.config };
    this.catalog = opts.catalog ?? [];
    this.checkpoints = new CheckpointManager();
    this.todos = [];
    this.sessionStore = opts.sessionStore ?? new SessionStore();
    this.session =
      opts.session ??
      this.sessionStore.createSession({
        model: this.config.model,
        wire: this.config.wire,
        cwd: this.config.cwd,
      });
    this.callbacks = opts.callbacks ?? {};
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleepFn = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxSteps = opts.maxSteps ?? 25;
    this.readOnlyOnly = opts.readOnlyOnly ?? false;
    this.allowSubagents = opts.allowSubagents ?? true;
  }

  getActiveModelInfo(): AivoModelInfo | undefined {
    return this.catalog.find((m) => m.id === this.config.model);
  }

  compactNow(): { beforeTokens: number; afterTokens: number } {
    const sys = buildSystemPrompt(this.config.cwd, this.config.mode);
    const beforeTokens = estimateConversationTokens(sys, this.session.messages);
    this.session.messages = compactConversation(this.session.messages, {
      keepRecentMessages: 4,
      todos: this.todos,
      modifiedFiles: this.checkpoints.listModifiedFiles(),
    });
    const afterTokens = estimateConversationTokens(sys, this.session.messages);
    this.sessionStore.saveSession(this.session);
    return { beforeTokens, afterTokens };
  }

  async runUserPrompt(rawPrompt: string, signal?: AbortSignal): Promise<RunPromptResult> {
    this.checkpoints.beginTurn(`turn_${Date.now()}`);
    const expandedPrompt = expandFileMentions(rawPrompt, this.config.cwd);
    this.session.messages.push({ role: "user", content: expandedPrompt });

    const systemPrompt = buildSystemPrompt(this.config.cwd, this.config.mode);
    const modelInfo = this.getActiveModelInfo();
    const contextLimit = modelInfo?.contextWindow ?? 128_000;

    // Proactive compaction at 80% context window
    const estTokens = estimateConversationTokens(systemPrompt, this.session.messages);
    if (estTokens > Math.floor(contextLimit * 0.8)) {
      const c = this.compactNow();
      this.callbacks.onNotice?.(
        `Auto-compacted conversation (${c.beforeTokens.toLocaleString()} -> ${c.afterTokens.toLocaleString()} est. tokens)`,
      );
    }

    const toolset = createToolset({
      cwd: this.config.cwd,
      mode: this.config.mode,
      checkpoints: this.checkpoints,
      todos: this.todos,
      readOnlyOnly: this.readOnlyOnly,
      confirmAction: this.callbacks.confirmAction,
      fetchFn: this.fetchFn,
      onSubagent: this.allowSubagents
        ? async ({ agent, description, prompt }) => {
            this.callbacks.onNotice?.(`Spawning ${agent} subagent: ${description}`);
            const subModel =
              agent === "explore" && this.config.fastModel
                ? this.config.fastModel
                : this.config.model;
            const subEffort =
              agent === "explore"
                ? this.config.reasoningEffort === "off"
                  ? "off"
                  : "low"
                : this.config.reasoningEffort;

            const subAgent = new AivoAgent({
              config: {
                ...this.config,
                model: subModel,
                reasoningEffort: subEffort,
              },
              catalog: this.catalog,
              sessionStore: this.sessionStore,
              fetchFn: this.fetchFn,
              sleepFn: this.sleepFn,
              maxSteps: 10,
              readOnlyOnly: agent === "explore" || this.config.mode === "plan",
              allowSubagents: false,
            });
            const subRes = await subAgent.runUserPrompt(prompt, signal);
            return subRes.finalText || "(subagent completed with no output)";
          }
        : undefined,
    });

    const totalUsage: TurnUsageMetrics = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let totalCostMicro = 0n;
    let totalCacheSavedMicro = 0n;
    let finalText = "";
    let steps = 0;

    while (steps < this.maxSteps) {
      steps++;

      let stepRes;
      let retryCount = 0;
      while (true) {
        try {
          stepRes = await streamTurn({
            baseUrl: this.config.baseUrl,
            apiKey: this.config.apiKey,
            sessionId: this.session.id,
            wire: this.config.wire,
            model: this.config.model,
            systemPrompt,
            messages: this.session.messages,
            tools: toolset.specs,
            reasoningEffort: this.config.reasoningEffort,
            maxTokens: modelInfo?.maxOutputTokens,
            webSearch: this.config.webSearch,
            signal,
            fetchFn: this.fetchFn,
            onReasoningDelta: this.callbacks.onReasoningDelta,
            onTextDelta: this.callbacks.onTextDelta,
          });
          break;
        } catch (err) {
          if (err instanceof AivoApiError) {
            if (err.recoveryAction === "compact_and_retry" && retryCount < 2) {
              retryCount++;
              const c = this.compactNow();
              this.callbacks.onNotice?.(
                `Context limit reached — auto-compacted (${c.beforeTokens} -> ${c.afterTokens} tokens) and retrying...`,
              );
              continue;
            }
            if (err.recoveryAction === "wait_and_retry" && retryCount < 3) {
              retryCount++;
              const waitS = err.retryAfterS ?? retryCount * 2;
              this.callbacks.onNotice?.(err.formatUserAdvice());
              await this.sleepFn(waitS * 1000);
              continue;
            }
          }
          throw err;
        }
      }

      totalUsage.inputTokens += stepRes.usage.inputTokens;
      totalUsage.outputTokens += stepRes.usage.outputTokens;
      totalUsage.cacheReadTokens += stepRes.usage.cacheReadTokens;
      totalUsage.cacheWriteTokens += stepRes.usage.cacheWriteTokens;

      const stepCost = calculateTurnCostMicro(modelInfo, stepRes.usage);
      totalCostMicro += stepCost.costMicro;
      totalCacheSavedMicro += stepCost.cacheSavedMicro;

      this.session.totalInputTokens += stepRes.usage.inputTokens;
      this.session.totalOutputTokens += stepRes.usage.outputTokens;
      this.session.totalCacheReadTokens += stepRes.usage.cacheReadTokens;
      this.session.totalCacheWriteTokens += stepRes.usage.cacheWriteTokens;
      this.session.totalCostMicro = (
        BigInt(this.session.totalCostMicro || "0") + stepCost.costMicro
      ).toString();

      this.session.messages.push({
        role: "assistant",
        content: stepRes.text,
        ...(stepRes.reasoning ? { reasoning: stepRes.reasoning } : {}),
        ...(stepRes.toolCalls.length > 0 ? { toolCalls: stepRes.toolCalls } : {}),
      });

      if (stepRes.toolCalls.length === 0) {
        finalText = stepRes.text;
        this.sessionStore.saveSession(this.session);
        break;
      }

      // Execute tool calls in parallel when safe (read/search tools) or sequentially when mutating
      const allReadOnly = stepRes.toolCalls.every((tc) =>
        ["read_file", "glob_files", "grep_search", "web_fetch"].includes(tc.name),
      );

      if (allReadOnly && stepRes.toolCalls.length > 1) {
        const results = await Promise.all(
          stepRes.toolCalls.map(async (tc) => {
            this.callbacks.onToolCall?.(tc.name, tc.arguments);
            const execRes = await toolset.execute(tc.name, tc.arguments);
            this.callbacks.onToolResult?.(tc.name, execRes.output, execRes.isError);
            return { tc, execRes };
          }),
        );
        for (const { tc, execRes } of results) {
          this.session.messages.push({
            role: "tool",
            toolCallId: tc.id,
            toolName: tc.name,
            content: execRes.output,
            isError: execRes.isError,
          });
        }
      } else {
        for (const tc of stepRes.toolCalls) {
          this.callbacks.onToolCall?.(tc.name, tc.arguments);
          const execRes = await toolset.execute(tc.name, tc.arguments);
          this.callbacks.onToolResult?.(tc.name, execRes.output, execRes.isError);
          this.session.messages.push({
            role: "tool",
            toolCallId: tc.id,
            toolName: tc.name,
            content: execRes.output,
            isError: execRes.isError,
          });
        }
      }

      this.sessionStore.saveSession(this.session);
    }

    return {
      finalText,
      steps,
      turnUsage: totalUsage,
      turnCostMicro: totalCostMicro,
      turnCacheSavedMicro: totalCacheSavedMicro,
    };
  }
}
