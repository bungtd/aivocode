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
import {
  autoAdvanceTodos,
  classifyTaskStrategy,
  verifyWorkspaceArtifacts,
} from "./workflow-review.js";

export interface AgentCallbacks {
  onReasoningDelta?: (delta: string) => void;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolCallProgress?: (
    name: string,
    bytes: number,
    lines: number,
    preview: string,
  ) => void;
  onToolResult?: (
    name: string,
    output: string,
    isError?: boolean,
    details?: ToolExecutionResult,
    args?: Record<string, unknown>,
  ) => void;
  onTodoUpdate?: (todos: TodoItem[]) => void;
  onNotice?: (message: string) => void;
  confirmAction?: (description: string) => Promise<boolean>;
  chooseStrategy?: (decision: {
    teamName: string;
    recommendedMode: "subagent-driven" | "native";
  }) => Promise<"subagent-driven" | "native">;
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
    this.maxSteps = opts.maxSteps ?? 30;
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
   * Prunes base64 image payloads from older messages (keeping only the latest 2 image-bearing messages)
   * so taking multiple desktop screenshots never bloats the conversation to 800k+ tokens.
   */
  private pruneOldImagePayloads(): void {
    const imgIndices: number[] = [];
    for (let i = 0; i < this.session.messages.length; i++) {
      const m = this.session.messages[i]!;
      if (m.images && m.images.length > 0) {
        imgIndices.push(i);
      }
    }
    if (imgIndices.length <= 2) return;
    const toStrip = imgIndices.slice(0, imgIndices.length - 2);
    for (const idx of toStrip) {
      const msg = this.session.messages[idx]!;
      delete msg.images;
      if (!msg.content.includes("[Earlier image attachment pruned")) {
        msg.content += "\n[Earlier image attachment pruned after visual inspection to save context]";
      }
    }
  }

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

  async executeTeamWorkflow(
    goal: string,
    teamId?: TeamId,
    signal?: AbortSignal,
  ): Promise<string> {
    const resolvedTeamId = teamId ?? this.config.team ?? detectRecommendedTeam(goal, this.config.cwd);
    const team = getAgentTeam(resolvedTeamId) ?? getAgentTeam("fullstack")!;

    this.todos.length = 0;
    for (let i = 0; i < team.workflowStages.length; i++) {
      this.todos.push({
        id: String(i + 1),
        content: team.workflowStages[i]!.title.replace(/^\d+\.\s*/, ""),
        status: i === 0 ? "in_progress" : "pending",
      });
    }
    this.callbacks.onTodoUpdate?.(this.todos);
    this.callbacks.onNotice?.(`Starting ${team.name} workflow (${team.workflowStages.length} stages)...`);

    const wfResult = await runTeamWorkflow({
      team,
      goal,
      onStageStart: (stage, role, idx, total) => {
        for (let k = 0; k < this.todos.length; k++) {
          this.todos[k]!.status = k < idx ? "completed" : k === idx ? "in_progress" : "pending";
        }
        this.callbacks.onTodoUpdate?.(this.todos);
        this.callbacks.onNotice?.(
          `Stage ${idx + 1}/${total}: ${stage.title} [${role.name}]`,
        );
      },
      onStageComplete: (rec: StageExecutionRecord, idx, total) => {
        if (this.todos[idx]) this.todos[idx]!.status = "completed";
        if (this.todos[idx + 1]) this.todos[idx + 1]!.status = "in_progress";
        this.callbacks.onTodoUpdate?.(this.todos);
        this.callbacks.onNotice?.(
          `Completed Stage ${idx + 1}/${total}: ${rec.stageTitle}`,
        );
      },
      executeStageAgent: async (_stage, role, stagePrompt) => {
        let stageModel = this.config.model;
        if (role.badge === "ARCH" || role.id.includes("architect") || role.id.includes("director") || role.id.includes("designer")) {
          stageModel = this.config.architectModel || this.config.model;
        } else if (role.badge === "QA" || role.badge === "SEC" || role.badge === "A11Y" || role.badge === "3D-QA" || role.id.includes("reviewer") || role.id.includes("auditor") || role.id.includes("validator") || role.id.includes("qa")) {
          stageModel = this.config.reviewerModel || this.config.model;
        } else if (role.preferredTier === "fast") {
          stageModel = this.config.fastModel || this.config.model;
        } else {
          stageModel = this.config.builderModel || this.config.model;
        }

        const stageEffort =
          this.config.subagentEffort ??
          (this.config.reasoningEffort === "off" ? "off" : role.preferredEffort);

        const stageAgent = new AivoAgent({
          config: {
            ...this.config,
            model: stageModel,
            team: team.id,
            reasoningEffort: stageEffort,
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

    // 1. Strategy Selection & Initial Live Task Seeding for substantial builds
    if (this.allowSubagents && !this.readOnlyOnly) {
      const strategy = classifyTaskStrategy(rawPrompt, this.config.cwd);
      const configuredStrat = this.config.strategy ?? "auto";

      if (strategy.isSubstantialBuild || configuredStrat === "subagent-driven") {
        if (!this.config.team) {
          this.config.team = strategy.teamId;
        }
        if (this.todos.length === 0 && strategy.autoTodos.length > 0) {
          this.todos.push(...strategy.autoTodos);
          this.callbacks.onTodoUpdate?.(this.todos);
        }

        let chosenStrategy: "subagent-driven" | "native" = "native";
        if (configuredStrat === "subagent-driven") {
          chosenStrategy = "subagent-driven";
        } else if (configuredStrat === "native") {
          chosenStrategy = "native";
        } else if (
          (configuredStrat === "ask" || this.config.mode === "safe") &&
          this.callbacks.chooseStrategy
        ) {
          chosenStrategy = await this.callbacks.chooseStrategy({
            teamName: strategy.teamName,
            recommendedMode: strategy.recommendedMode,
          });
        } else {
          this.callbacks.onNotice?.(
            `Active Team: ${strategy.teamName} [${this.config.team}] · Live Tasks initialized (${this.todos.length} stages)`,
          );
        }

        if (chosenStrategy === "subagent-driven") {
          const wfText = await this.executeTeamWorkflow(rawPrompt, this.config.team, signal);
          return {
            finalText: wfText,
            steps: Math.max(1, strategy.autoTodos.length),
            turnUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            turnCostMicro: 0n,
            turnCacheSavedMicro: 0n,
          };
        }
      }
    }

    let expandedPrompt = expandFileMentions(rawPrompt, this.config.cwd);
    const promptImages = extractPromptImageAttachments(rawPrompt, this.config.cwd);

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
              agent === "explore"
                ? (this.config.fastModel || this.config.model)
                : (this.config.builderModel || this.config.model);
            const subEffort =
              this.config.subagentEffort ??
              (agent === "explore"
                ? this.config.reasoningEffort === "off"
                  ? "off"
                  : "low"
                : this.config.reasoningEffort);

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
    let reviewFixPassDone = false;

    while (steps < this.maxSteps) {
      steps++;
      this.pruneOldImagePayloads();

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
            maxTokens:
              this.config.wire === "messages"
                ? Math.min(16384, modelInfo?.maxOutputTokens ?? 8192)
                : undefined,
            signal,
            fetchFn: this.fetchFn,
            onReasoningDelta: this.callbacks.onReasoningDelta,
            onTextDelta: this.callbacks.onTextDelta,
            onToolCallProgress: this.callbacks.onToolCallProgress,
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
        // Automated Review & Fix Gate when files were modified in this turn
        const touched = this.checkpoints.listModifiedFiles();
        if (
          touched.length > 0 &&
          !reviewFixPassDone &&
          !this.readOnlyOnly &&
          this.config.autoReviewFix !== false
        ) {
          reviewFixPassDone = true;
          const verification = verifyWorkspaceArtifacts(this.config.cwd, touched);
          if (!verification.clean) {
            this.callbacks.onNotice?.(
              `Automated Review & Fix Gate detected ${verification.findings.length} issue(s) — running fix pass...`,
            );
            this.session.messages.push({
              role: "user",
              content: [
                "[Automated Review & Fix Gate]",
                "The following issues were found in your modified files. Fix them now before completing:",
                ...verification.findings.map((f) => `- ${f}`),
              ].join("\n"),
            });
            continue;
          }
        }

        // Mark all todos completed when turn finishes cleanly
        if (this.todos.length > 0) {
          for (const t of this.todos) t.status = "completed";
          this.callbacks.onTodoUpdate?.(this.todos);
        }

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
            if (autoAdvanceTodos(this.todos, tc.name, tc.arguments)) {
              this.callbacks.onTodoUpdate?.(this.todos);
            }
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
          if (autoAdvanceTodos(this.todos, tc.name, tc.arguments) || tc.name === "todo_write") {
            this.callbacks.onTodoUpdate?.(this.todos);
          }
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

    // OpenCode V2 rule: if `maxSteps` was reached while the last message was a tool result,
    // remove tools and request a final text summary so the agent NEVER stops silently!
    const lastMsg = this.session.messages[this.session.messages.length - 1];
    if (!finalText && lastMsg && lastMsg.role === "tool") {
      this.pruneOldImagePayloads();
      const summaryTurn = await streamTurn({
        baseUrl: this.config.baseUrl,
        apiKey: this.config.apiKey,
        sessionId: this.session.id,
        wire: this.config.wire,
        model: this.config.model,
        systemPrompt,
        messages: [
          ...this.session.messages,
          {
            role: "user",
            content:
              "Maximum tool steps reached. Summarize everything you built, verified, and how the user can run or open it.",
          },
        ],
        tools: [],
        reasoningEffort: "off",
        signal,
        fetchFn: this.fetchFn,
        onTextDelta: this.callbacks.onTextDelta,
      });
      finalText = summaryTurn.text;
      this.session.messages.push({
        role: "assistant",
        content: finalText,
      });
      if (this.todos.length > 0) {
        for (const t of this.todos) t.status = "completed";
        this.callbacks.onTodoUpdate?.(this.todos);
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
