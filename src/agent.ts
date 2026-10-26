import type { AivoConfig } from "./config.js";
import {
  calculateTurnCostMicro,
  type AivoModelInfo,
  type TurnUsageMetrics,
} from "./aivokey-client.js";
import { AivoApiError } from "./errors.js";
import { streamTurn } from "./protocol.js";
import { CheckpointManager } from "./checkpoint.js";
import { createToolset, type TodoItem, type ToolExecutionResult } from "./tools/index.js";
import {
  buildSystemPrompt,
  compactConversation,
  estimateConversationTokens,
  expandFileMentions,
  extractPromptImageAttachments,
} from "./context.js";
import { SessionStore, type AivoSession } from "./session.js";
import { SelfLearningMemory } from "./memory.js";
import { SkillRegistry } from "./skills.js";
import { pickVisionCapableModel } from "./vision.js";
import {
  detectRecommendedTeam,
  getAgentTeam,
  runTeamWorkflow,
  type StageExecutionRecord,
  type TeamId,
} from "./teams.js";

export interface AgentCallbacks {
  onReasoningDelta?: (delta: string) => void;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (
    name: string,
    output: string,
    isError?: boolean,
    details?: ToolExecutionResult,
    args?: Record<string, unknown>,
  ) => void;
  onNotice?: (message: string) => void;
  confirmAction?: (description: string) => Promise<boolean>;
}

export interface AgentOptions {
  config: AivoConfig;
  catalog?: AivoModelInfo[];
  sessionStore?: SessionStore;
  session?: AivoSession;
  memory?: SelfLearningMemory;
  skills?: SkillRegistry;
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
  readonly memory: SelfLearningMemory;
  readonly skills: SkillRegistry;
  session: AivoSession;
  callbacks: AgentCallbacks;
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
    this.memory = opts.memory ?? new SelfLearningMemory();
    this.skills = opts.skills ?? new SkillRegistry({ cwd: this.config.cwd });
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
    const sys = buildSystemPrompt(this.config.cwd, this.config.mode, this.config.team);
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

  /**
   * OpenCode V2 style `/btw <question>`: answers a quick side question using the current
   * session context without adding the exchange to `this.session.messages` or running tools.
   */
  async askSideQuestion(question: string, signal?: AbortSignal): Promise<string> {
    const sysPrompt = buildSystemPrompt(this.config.cwd, "plan", this.config.team);
    const tempMessages = [
      ...this.session.messages,
      {
        role: "user" as const,
        content: `[Side Question — answer concisely without modifying any files]: ${question}`,
      },
    ];
    const res = await streamTurn({
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      sessionId: this.session.id,
      wire: this.config.wire,
      model: this.config.model,
      systemPrompt: sysPrompt,
      messages: tempMessages,
      tools: [],
      reasoningEffort: "off",
      signal,
      fetchFn: this.fetchFn,
      onTextDelta: this.callbacks.onTextDelta,
    });
    return res.text;
  }

  /**
   * Executes a multi-stage Specialist Agent Team workflow (`fullstack`, `backend`, `frontend`,
   * `android`, `blender3d`, `gamedev`, `autopilot`).
   */
  async executeTeamWorkflow(
    goal: string,
    teamId?: TeamId,
    signal?: AbortSignal,
  ): Promise<string> {
    const resolvedTeamId = teamId ?? this.config.team ?? detectRecommendedTeam(goal, this.config.cwd);
    const team = getAgentTeam(resolvedTeamId) ?? getAgentTeam("fullstack")!;

    this.callbacks.onNotice?.(`Starting ${team.name} workflow (${team.workflowStages.length} stages)...`);

    const wfResult = await runTeamWorkflow({
      team,
      goal,
      onStageStart: (stage, role, idx, total) => {
        this.callbacks.onNotice?.(
          `Stage ${idx + 1}/${total}: ${stage.title} [${role.name}]`,
        );
      },
      onStageComplete: (rec: StageExecutionRecord, idx, total) => {
        this.callbacks.onNotice?.(
          `Completed Stage ${idx + 1}/${total}: ${rec.stageTitle}`,
        );
      },
      executeStageAgent: async (_stage, role, stagePrompt) => {
        const stageModel =
          role.preferredTier === "fast" && this.config.fastModel
            ? this.config.fastModel
            : this.config.model;

        const stageAgent = new AivoAgent({
          config: {
            ...this.config,
            model: stageModel,
            team: team.id,
            reasoningEffort:
              this.config.reasoningEffort === "off"
                ? "off"
                : role.preferredEffort,
          },
          catalog: this.catalog,
          sessionStore: this.sessionStore,
          memory: this.memory,
          skills: this.skills,
          fetchFn: this.fetchFn,
          sleepFn: this.sleepFn,
          maxSteps: 12,
          readOnlyOnly: role.readOnly || this.config.mode === "plan",
          allowSubagents: false,
          callbacks: this.callbacks,
        });

        const res = await stageAgent.runUserPrompt(stagePrompt, signal);
        return res.finalText || "(stage finished)";
      },
    });

    return wfResult.finalSummary;
  }

  async runUserPrompt(rawPrompt: string, signal?: AbortSignal): Promise<RunPromptResult> {
    this.checkpoints.beginTurn(`turn_${Date.now()}`);
    let expandedPrompt = expandFileMentions(rawPrompt, this.config.cwd);
    const promptImages = extractPromptImageAttachments(rawPrompt, this.config.cwd);

    // Pre-step memory recall (injected into user message so static systemPrompt cache never breaks)
    const recallBlock = this.memory.formatRecallBlock(rawPrompt, this.config.cwd, 3);
    if (recallBlock) {
      expandedPrompt = `${expandedPrompt}\n\n${recallBlock}`;
    }

    this.session.messages.push({
      role: "user",
      content: expandedPrompt,
      ...(promptImages.length > 0 ? { images: promptImages } : {}),
    });

    const systemPrompt = buildSystemPrompt(this.config.cwd, this.config.mode, this.config.team);
    const modelInfo = this.getActiveModelInfo();
    const contextLimit = modelInfo?.contextWindow ?? 128_000;

    const estTokens = estimateConversationTokens(systemPrompt, this.session.messages);
    if (estTokens > Math.floor(contextLimit * 0.8)) {
      const c = this.compactNow();
      this.callbacks.onNotice?.(
        `Auto-compacted conversation (${c.beforeTokens.toLocaleString("en-US")} -> ${c.afterTokens.toLocaleString("en-US")} est. tokens)`,
      );
    }

    const toolset = createToolset({
      cwd: this.config.cwd,
      mode: this.config.mode,
      checkpoints: this.checkpoints,
      todos: this.todos,
      memory: this.memory,
      skills: this.skills,
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
              memory: this.memory,
              skills: this.skills,
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
      onTeamWorkflow: this.allowSubagents
        ? async ({ teamId, goal }) => {
            return this.executeTeamWorkflow(goal, teamId, signal);
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

      // Check if any message in the conversation carries images; if so, ensure vision-capable model
      const hasImagesInConversation = this.session.messages.some(
        (m) => m.images && m.images.length > 0,
      );
      const effectiveModel = hasImagesInConversation
        ? pickVisionCapableModel(this.config.model, this.catalog)
        : this.config.model;
      if (effectiveModel !== this.config.model) {
        this.callbacks.onNotice?.(
          `Vision attachment detected — routing step via vision model '${effectiveModel}'`,
        );
      }

      let stepRes;
      let retryCount = 0;
      while (true) {
        try {
          stepRes = await streamTurn({
            baseUrl: this.config.baseUrl,
            apiKey: this.config.apiKey,
            sessionId: this.session.id,
            wire: this.config.wire,
            model: effectiveModel,
            systemPrompt,
            messages: this.session.messages,
            tools: toolset.specs,
            reasoningEffort: this.config.reasoningEffort,
            // Only send maxTokens on Anthropic messages wire (where it is required, capped at 16384);
            // omit on chat/responses wires so upstreams stream immediately without huge reserve delays!
            maxTokens:
              this.config.wire === "messages"
                ? Math.min(16384, modelInfo?.maxOutputTokens ?? 8192)
                : undefined,
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

      const allReadOnly = stepRes.toolCalls.every((tc) =>
        [
          "read_file",
          "glob_files",
          "grep_search",
          "web_search",
          "web_fetch",
          "vision_analyze",
          "memory_search",
          "skill_load",
          "anti_slop_audit",
        ].includes(tc.name),
      );

      const pendingImages = [];

      if (allReadOnly && stepRes.toolCalls.length > 1) {
        const results = await Promise.all(
          stepRes.toolCalls.map(async (tc) => {
            const t0 = Date.now();
            this.callbacks.onToolCall?.(tc.name, tc.arguments);
            const execRes = await toolset.execute(tc.name, tc.arguments);
            if (execRes.durationMs === undefined) execRes.durationMs = Date.now() - t0;
            this.callbacks.onToolResult?.(tc.name, execRes.output, execRes.isError, execRes, tc.arguments);
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
          if (execRes.imageAttachment) {
            pendingImages.push(execRes.imageAttachment);
          }
        }
      } else {
        for (const tc of stepRes.toolCalls) {
          const t0 = Date.now();
          this.callbacks.onToolCall?.(tc.name, tc.arguments);
          const execRes = await toolset.execute(tc.name, tc.arguments);
          if (execRes.durationMs === undefined) execRes.durationMs = Date.now() - t0;
          this.callbacks.onToolResult?.(tc.name, execRes.output, execRes.isError, execRes, tc.arguments);
          this.session.messages.push({
            role: "tool",
            toolCallId: tc.id,
            toolName: tc.name,
            content: execRes.output,
            isError: execRes.isError,
          });
          if (execRes.imageAttachment) {
            pendingImages.push(execRes.imageAttachment);
          }
        }
      }

      if (pendingImages.length > 0) {
        this.session.messages.push({
          role: "user",
          content: "Attached image(s) from tool execution for visual inspection:",
          images: pendingImages,
        });
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
