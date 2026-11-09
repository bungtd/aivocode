import type { AivoConfig } from "./config.js";
import {
  calculateTurnCostMicro,
  type AivoModelInfo,
  type TurnUsageMetrics,
} from "./aivokey-client.js";
import { AivoApiError } from "./errors.js";
import { streamTurn, type ChatMessage, type ToolSpec } from "./protocol.js";
import { CheckpointManager, defaultCheckpointDir } from "./checkpoint.js";
import { createToolset, type TodoItem, type ToolExecutionResult } from "./tools/index.js";
import {
  buildSystemPrompt,
  compactConversation,
  estimateConversationTokens,
  expandFileMentions,
  extractPromptImageAttachments,
  isReadOnlyQaPrompt,
  resolveStepReasoningEffort,
} from "./context.js";
import { SessionStore, type AivoSession } from "./session.js";
import { SelfLearningMemory } from "./memory.js";
import { SkillRegistry } from "./skills.js";
import { pickVisionCapableModel } from "./vision.js";
import { ClientWebSearchRouter } from "./web.js";
import { McpManager } from "./mcp.js";
import { LspManager } from "./lsp.js";
import { PermissionEngine } from "./permissions.js";
import { ShellSandbox } from "./sandbox.js";
import { buildChildEnv } from "./env-utils.js";
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
  runIterativeReviewFixLoop,
  verifyWorkspaceArtifacts,
} from "./workflow-review.js";
import { BackgroundJobManager, defaultBackgroundJobsDir, type BackgroundJob } from "./background-jobs.js";
import {
  HookRunner,
  findCustomCommand,
  loadCustomCommands,
  renderCustomCommand,
  type CustomCommand,
  type HookEvent,
} from "./hooks.js";
import { PluginRuntime } from "./plugins.js";
import { withWorktree } from "./worktree.js";
import { MetricsRegistry, Tracer, globalMetrics } from "./telemetry.js";

export interface SubagentRunRecord {
  id: string;
  name: string;
  description: string;
  model: string;
  status: "running" | "completed" | "error";
  logs: string[];
}

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
  confirmActionChoice?: (description: string) => Promise<"yes" | "always" | "no">;
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
  checkpoints?: CheckpointManager;
  ephemeralSession?: boolean;
  memory?: SelfLearningMemory;
  skills?: SkillRegistry;
  backgroundJobs?: BackgroundJobManager;
  webSearchRouter?: ClientWebSearchRouter;
  mcpManager?: McpManager;
  lspManager?: LspManager;
  hookRunner?: HookRunner;
  plugins?: PluginRuntime;
  customCommands?: CustomCommand[];
  /** Optional tracer; when omitted the agent creates a disabled one. */
  tracer?: Tracer;
  metrics?: MetricsRegistry;
  callbacks?: AgentCallbacks;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  maxSteps?: number;
  readOnlyOnly?: boolean;
  allowSubagents?: boolean;
  chunkIdleTimeoutMs?: number;
}

/**
 * Ensures every assistant message with `toolCalls` has matching `role: "tool"` result messages.
 * If a previous turn was interrupted mid-flight (e.g. via Esc), inserts synthetic cancelled
 * tool result blocks so subsequent turns never fail upstream tool_call_id validation.
 */
export function sanitizeDanglingToolCalls(messages: ChatMessage[]): void {
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      const answeredIds = new Set<string>();
      let j = i + 1;
      while (j < messages.length && messages[j]!.role === "tool") {
        if (messages[j]!.toolCallId) answeredIds.add(messages[j]!.toolCallId!);
        j++;
      }
      const missing = msg.toolCalls.filter((tc) => !answeredIds.has(tc.id));
      if (missing.length > 0) {
        const synthetic: ChatMessage[] = missing.map((tc) => ({
          role: "tool",
          toolCallId: tc.id,
          toolName: tc.name,
          content: "[Tool call interrupted before completion]",
          isError: true,
        }));
        messages.splice(j, 0, ...synthetic);
        i = j + synthetic.length;
        continue;
      }
    }
    i++;
  }
}

export interface RunPromptResult {
  finalText: string;
  steps: number;
  turnUsage: TurnUsageMetrics;
  turnCostMicro: bigint;
  turnCacheSavedMicro: bigint;
}

export interface TeamWorkflowResult {
  text: string;
  usage: TurnUsageMetrics;
  costMicro: bigint;
  cacheSavedMicro: bigint;
}

export class AivoAgent {
  config: AivoConfig;
  catalog: AivoModelInfo[];
  checkpoints: CheckpointManager;
  readonly todos: TodoItem[];
  readonly sessionStore: SessionStore;
  readonly memory: SelfLearningMemory;
  readonly skills: SkillRegistry;
  backgroundJobs: BackgroundJobManager;
  readonly webSearchRouter: ClientWebSearchRouter;
  readonly mcpManager: McpManager;
  readonly lspManager: LspManager;
  readonly hookRunner: HookRunner;
  readonly plugins: PluginRuntime;
  readonly tracer: Tracer;
  readonly metrics: MetricsRegistry;
  private pluginTools: Array<{
    spec: ToolSpec;
    handler: (args: Record<string, unknown>) => Promise<ToolExecutionResult>;
  }> = [];
  readonly customCommands: CustomCommand[];
  readonly subagentRuns: SubagentRunRecord[];
  session: AivoSession;
  callbacks: AgentCallbacks;
  private fetchFn: typeof fetch;
  private sleepFn: (ms: number) => Promise<void>;
  private maxSteps: number;
  private readOnlyOnly: boolean;
  private allowSubagents: boolean;
  private ephemeralSession: boolean;
  private chunkIdleTimeoutMs?: number;
  private lastPersistAt = 0;
  private sandboxNoticeShown = false;
  private hookSessionStarted = false;
  private hookSessionEnded = false;
  private pluginsLoaded = false;

  /**
   * Worktree isolation is on by default for mutating subagents when the
   * workspace is a git repo with commits; `AIVO_DISABLE_WORKTREES=1` opts out
   * (handy for CI or nested-repo setups).
   */
  private shouldIsolateSubagents(): boolean {
    if (process.env.AIVO_DISABLE_WORKTREES === "1") return false;
    if (this.config.worktreeIsolation === false) return false;
    return true;
  }
  private confirmQueue: Promise<void> = Promise.resolve();
  private permissionEngine?: PermissionEngine;
  private permissionEngineKey = "";
  private pendingTeamWorkflowUsage: {
    usage: TurnUsageMetrics;
    costMicro: bigint;
    cacheSavedMicro: bigint;
  } | null = null;

  constructor(opts: AgentOptions) {
    this.config = { ...opts.config };
    this.callbacks = opts.callbacks ?? {};
    this.catalog = opts.catalog ?? [];
    this.checkpoints = opts.checkpoints ?? new CheckpointManager();
    this.todos = [];
    this.sessionStore = opts.sessionStore ?? new SessionStore();
    this.ephemeralSession = opts.ephemeralSession ?? false;
    this.memory = opts.memory ?? new SelfLearningMemory();
    this.skills = opts.skills ?? new SkillRegistry({ cwd: this.config.cwd });
    this.backgroundJobs = opts.backgroundJobs ?? new BackgroundJobManager();
    // One router per agent keeps 429/Retry-After cooldowns alive across turns and subagents.
    this.webSearchRouter =
      opts.webSearchRouter ??
      new ClientWebSearchRouter({
        loadLocalDshCredentials: false,
        fetchFn: opts.fetchFn ?? fetch,
      });
    this.mcpManager =
      opts.mcpManager ??
      new McpManager(this.config.mcpServers ?? {}, {
        cwd: this.config.cwd,
        fetchFn: opts.fetchFn ?? fetch,
        sandbox: {
          mode: this.config.sandbox ?? "workspace",
          network: this.config.permissions?.network ?? "allow",
          envAllow: this.config.permissions?.env,
        },
        oauth: { authPath: this.config.mcpAuthPath },
        handlers: {
          sampling: async (request) => this.handleMcpSampling(request),
          elicitation: async (request) => this.handleMcpElicitation(request),
          notification: (server, method, params) => {
            if (method === "notifications/message") {
              const row = params as { level?: string; data?: unknown } | undefined;
              this.callbacks.onNotice?.(
                `[MCP:${server}] ${typeof row?.data === "string" ? row.data : JSON.stringify(row?.data ?? params).slice(0, 300)}`,
              );
            } else if (method === "notifications/progress") {
              const row = params as { progress?: number; total?: number; message?: string } | undefined;
              this.callbacks.onNotice?.(
                `[MCP:${server}] progress ${row?.progress ?? "?"}${row?.total ? `/${row.total}` : ""}${row?.message ? ` · ${row.message}` : ""}`,
              );
            }
          },
        },
      });
    this.lspManager =
      opts.lspManager ??
      new LspManager({
        cwd: this.config.cwd,
        servers: this.config.lspServers,
        envAllow: this.config.permissions?.env,
      });
    this.callbacks = opts.callbacks ?? {};
    this.subagentRuns = [];
    this.plugins =
      opts.plugins ??
      new PluginRuntime({
        cwd: this.config.cwd,
        onNotice: (message) => this.callbacks.onNotice?.(message),
      });
    this.hookRunner =
      opts.hookRunner ??
      new HookRunner({
        cwd: this.config.cwd,
        config: this.config.hooks,
        envAllow: this.config.permissions?.env,
        programmatic: () => this.plugins.hooks,
        onWarning: (message) => this.callbacks.onNotice?.(message),
      });
    this.customCommands = opts.customCommands ?? loadCustomCommands(this.config.cwd);
    this.tracer = opts.tracer ?? new Tracer({ enabled: false });
    this.metrics = opts.metrics ?? globalMetrics;
    this.session =
      opts.session ??
      this.sessionStore.createSession({
        model: this.config.model,
        wire: this.config.wire,
        cwd: this.config.cwd,
      });
    this.fetchFn = opts.fetchFn ?? fetch;
    this.plugins.sessionId = this.session.id;
    this.plugins.mode = this.config.mode;
    // Persist undo history for real sessions so /undo survives a restart;
    // ephemeral subagent/reviewer sessions stay in memory.
    if (!opts.checkpoints && !this.ephemeralSession) {
      this.checkpoints = new CheckpointManager({
        dir: defaultCheckpointDir(this.session.id),
      });
    }
    // Persist background job metadata so `/jobs` shows what ran before a crash
    // and `/jobs restart <id>` can relaunch lost dev servers.
    if (!opts.backgroundJobs && !this.ephemeralSession) {
      this.backgroundJobs.dispose();
      this.backgroundJobs = new BackgroundJobManager(undefined, {
        dir: defaultBackgroundJobsDir(this.session.id),
      });
    }
    this.sleepFn = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxSteps = opts.maxSteps ?? 30;
    this.readOnlyOnly = opts.readOnlyOnly ?? false;
    this.allowSubagents = opts.allowSubagents ?? true;
    this.chunkIdleTimeoutMs = opts.chunkIdleTimeoutMs;
  }

  /**
   * Swaps the live session and re-points everything that is session-scoped:
   * undo checkpoints and background jobs are persisted per session id, so
   * resuming an older session must read that session's history, not the one we
   * just left.
   */
  switchSession(next: AivoSession): void {
    if (!this.ephemeralSession) {
      try {
        this.sessionStore.saveSession(this.session);
      } catch {
        // Losing a save must not block the switch.
      }
    }
    this.session = next;
    this.config.model = next.model;
    this.config.wire = next.wire;
    this.session.wire = next.wire;
    this.todos.length = 0;
    this.subagentRuns.length = 0;
    this.plugins.sessionId = next.id;
    if (!this.ephemeralSession) {
      this.checkpoints = new CheckpointManager({ dir: defaultCheckpointDir(next.id) });
      this.backgroundJobs.dispose();
      this.backgroundJobs = new BackgroundJobManager(undefined, {
        dir: defaultBackgroundJobsDir(next.id),
      });
    }
  }

  /**
   * Persists the session, coalescing rapid tool-step saves. The full JSONL is still
   * rewritten (images can be large), so writing once per 200ms instead of after every
   * single tool call matters in long sessions. Turn boundaries force a final write.
   */
  private persistSession(force: boolean = false): void {
    if (this.ephemeralSession) return;
    const now = Date.now();
    if (!force && now - this.lastPersistAt < 200) return;
    this.lastPersistAt = now;
    try {
      this.sessionStore.saveSession(this.session);
    } catch (err) {
      // A read-only home or full disk must not kill an otherwise successful turn.
      this.callbacks.onNotice?.(
        `Session save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Records usage/cost on the session total exactly once per model call. */
  private addSessionUsage(usage: TurnUsageMetrics, costMicro: bigint): void {
    this.session.totalInputTokens += usage.inputTokens;
    this.session.totalOutputTokens += usage.outputTokens;
    this.session.totalCacheReadTokens += usage.cacheReadTokens;
    this.session.totalCacheWriteTokens += usage.cacheWriteTokens;
    this.session.totalCostMicro = (
      BigInt(this.session.totalCostMicro || "0") + costMicro
    ).toString();
  }

  private takePendingTeamWorkflowUsage(): {
    usage: TurnUsageMetrics;
    costMicro: bigint;
    cacheSavedMicro: bigint;
  } | null {
    const pending = this.pendingTeamWorkflowUsage;
    this.pendingTeamWorkflowUsage = null;
    return pending;
  }

  /** Serializes confirmation prompts so parallel read-only tools cannot race one modal. */
  private async confirmChoiceSerialized(
    description: string,
  ): Promise<"yes" | "always" | "no"> {
    if (!this.callbacks.confirmActionChoice && !this.callbacks.confirmAction) return "no";
    const previous = this.confirmQueue;
    let release: () => void = () => {};
    this.confirmQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.callbacks.confirmActionChoice) {
        return await this.callbacks.confirmActionChoice(description);
      }
      const approved = await this.callbacks.confirmAction!(description);
      return approved ? "yes" : "no";
    } finally {
      release();
    }
  }

  private async sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await this.sleepFn(ms);
      return;
    }
    if (signal.aborted) throw new Error("Generation interrupted by user.");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      (timer as unknown as { unref?: () => void }).unref?.();
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Generation interrupted by user."));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  getActiveModelInfo(): AivoModelInfo | undefined {
    return this.catalog.find((m) => m.id === this.config.model);
  }

  /** Turns an MCP sampling request into a model call and returns MCP content. */
  private async handleMcpSampling(request: {
    server: string;
    messages: Array<{ role: string; content: unknown }>;
    modelPreferences?: unknown;
    systemPrompt?: string;
    maxTokens?: number;
  }): Promise<unknown> {
    const modelInfo = this.getActiveModelInfo();
    const messages: ChatMessage[] = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content:
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content ?? ""),
      }));
    const result = await streamTurn({
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      sessionId: `${this.session.id}-mcp-sampling-${request.server}`,
      wire: this.config.wire,
      model: this.config.model,
      systemPrompt:
        request.systemPrompt ??
        "You are answering a request from an MCP server through AivoCode. Respond concisely and accurately.",
      messages,
      tools: [],
      reasoningEffort: "off",
      maxTokens: Math.min(request.maxTokens ?? 1024, modelInfo?.maxOutputTokens ?? 4096),
      fetchFn: this.fetchFn,
    });
    return {
      role: "assistant",
      content: { type: "text", text: result.text },
      model: this.config.model,
      stopReason: "endTurn",
    };
  }

  /** Prompts the user for structured input requested by an MCP server. */
  private async handleMcpElicitation(request: {
    server: string;
    message: string;
    requestedSchema?: unknown;
  }): Promise<unknown> {
    const properties =
      typeof request.requestedSchema === "object" &&
      request.requestedSchema !== null &&
      "properties" in request.requestedSchema
        ? Object.keys((request.requestedSchema as { properties?: object }).properties ?? {})
        : [];
    const prompt = `[MCP:${request.server}] ${request.message}${properties.length > 0 ? `\nFields: ${properties.join(", ")}` : ""}\nReply with JSON to accept, or leave empty to decline.`;
    const confirmed = await this.confirmChoiceSerialized(prompt);
    if (confirmed === "no") return { action: "decline" };
    return { action: "accept", content: {} };
  }

  /** Loads plugin modules once and caches the tools they contribute. */  private async loadPluginRuntime(): Promise<void> {
    this.plugins.mode = this.config.mode;
    this.plugins.sessionId = this.session.id;
    if (this.pluginsLoaded) return;
    this.pluginsLoaded = true;
    await this.plugins.ensureLoaded();
    this.pluginTools = await this.plugins.getExtraTools();
    if (this.plugins.loaded.length > 0) {
      this.callbacks.onNotice?.(`Loaded plugin(s): ${this.plugins.loaded.join(", ")}`);
    }
  }

  /** Expands a user-defined slash command into a prompt, or returns null. */
  resolveCustomCommand(line: string): string | null {
    const found = findCustomCommand(this.customCommands, line);
    if (!found) return null;
    return renderCustomCommand(found.command, found.args);
  }

  /** Starts a user-requested background shell command with the same sandbox policy as run_shell. */
  startBackgroundJob(command: string): BackgroundJob {
    const sandbox = new ShellSandbox({
      cwd: this.config.cwd,
      mode: this.config.sandbox ?? "workspace",
      network: this.config.permissions?.network ?? "allow",
    });
    const shellBin = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    const shellArgs =
      process.platform === "win32"
        ? ["-NoProfile", "-Command", command]
        : ["-c", command];
    const wrapped = sandbox.wrap(command, shellBin, shellArgs, this.config.cwd);
    return this.backgroundJobs.startJob({
      command,
      cwd: this.config.cwd,
      shellBin: wrapped.bin,
      shellArgs: wrapped.args,
      env: buildChildEnv({
        allow: this.config.permissions?.env,
        extra: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_EDITOR: "true",
          GIT_MERGE_AUTOEDIT: "no",
          GCM_INTERACTIVE: "never",
          NO_COLOR: "1",
          TERM: "dumb",
          CI: "true",
        },
      }),
    });
  }

  /** Releases long-lived child processes (MCP servers, LSP servers). */
  dispose(): void {
    if (this.hookRunner.hasHooks("SessionEnd") && !this.hookSessionEnded) {
      this.hookSessionEnded = true;
      void this.hookRunner.run("SessionEnd", {
        sessionId: this.session.id,
        cwd: this.config.cwd,
        mode: this.config.mode,
      });
    }
    this.mcpManager.dispose();
    this.lspManager.dispose();
  }

  describePermissions(): string {
    const sandboxMode = this.config.sandbox ?? "workspace";
    const network = this.config.permissions?.network ?? "allow";
    const shellSandbox = new ShellSandbox({
      cwd: this.config.cwd,
      mode: sandboxMode,
      network,
    });
    const engine = new PermissionEngine({
      cwd: this.config.cwd,
      mode: this.config.mode,
      sandbox: sandboxMode,
      permissions: this.config.permissions,
      shellSandboxEnforced: shellSandbox.enforced,
    });
    return `${engine.describe()}\nOS shell sandbox: ${shellSandbox.describe()}`;
  }

  compactNow(): { beforeTokens: number; afterTokens: number } {
    const sys = buildSystemPrompt(
      this.config.cwd,
      this.config.mode,
      this.config.team,
      this.lspManager.hasServers(),
    );
    const beforeTokens = estimateConversationTokens(sys, this.session.messages);
    this.session.messages = compactConversation(this.session.messages, {
      keepRecentMessages: 4,
      todos: this.todos,
      modifiedFiles: this.checkpoints.listModifiedFiles(),
    });
    const afterTokens = estimateConversationTokens(sys, this.session.messages);
    this.persistSession(true);
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
    const sysPrompt = buildSystemPrompt(
      this.config.cwd,
      "plan",
      this.config.team,
      this.lspManager.hasServers(),
    );
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
    const sideCost = calculateTurnCostMicro(this.getActiveModelInfo(), res.usage);
    this.addSessionUsage(res.usage, sideCost.costMicro);
    this.persistSession(true);
    return res.text;
  }

  async executeTeamWorkflow(
    goal: string,
    teamId?: TeamId,
    signal?: AbortSignal,
  ): Promise<string> {
    return (await this.executeTeamWorkflowWithUsage(goal, teamId, signal)).text;
  }

  async executeTeamWorkflowWithUsage(
    goal: string,
    teamId?: TeamId,
    signal?: AbortSignal,
  ): Promise<TeamWorkflowResult> {
    const resolvedTeamId = teamId ?? this.config.team ?? detectRecommendedTeam(goal, this.config.cwd);
    const team = getAgentTeam(resolvedTeamId) ?? getAgentTeam("fullstack")!;
    const workflowSpan = this.tracer.startSpan("workflow", {
      kind: "workflow",
      attributes: {
        "workflow.team": resolvedTeamId,
        "workflow.stages": team.workflowStages.length,
        "workflow.goal_chars": goal.length,
      },
    });
    this.metrics.increment(
      "aivo_workflows_total",
      { team: resolvedTeamId },
      "Team workflows started",
    );
    try {
      const result = await this.executeTeamWorkflowInner(goal, resolvedTeamId, team, signal, workflowSpan);
      workflowSpan.end();
      return result;
    } catch (err) {
      workflowSpan.fail(err);
      workflowSpan.end();
      throw err;
    }
  }

  private async executeTeamWorkflowInner(
    goal: string,
    resolvedTeamId: TeamId,
    team: NonNullable<ReturnType<typeof getAgentTeam>>,
    signal: AbortSignal | undefined,
    workflowSpan: import("./telemetry.js").Span,
  ): Promise<TeamWorkflowResult> {

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

    const totalUsage: TurnUsageMetrics = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let totalCostMicro = 0n;
    let totalCacheSavedMicro = 0n;

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

        const subRecord: SubagentRunRecord = {
          id: `sub_${this.subagentRuns.length + 1}`,
          name: role.name,
          description: _stage.title,
          model: stageModel,
          status: "running",
          logs: [`Stage: ${_stage.title}`, `Objective: ${_stage.objective}`],
        };
        this.subagentRuns.push(subRecord);
        const stageSpan = this.tracer.startSpan(`stage.${role.badge ?? role.id}`, {
          kind: "subagent",
          parent: workflowSpan,
          attributes: {
            "stage.title": _stage.title,
            "subagent.role": role.name,
            "subagent.model": stageModel,
            "subagent.read_only": Boolean(role.readOnly),
          },
        });

        // Read-only roles never touch files, so they stay in the shared tree.
        const worktree =
          !role.readOnly && this.shouldIsolateSubagents()
            ? withWorktree({
                cwd: this.config.cwd,
                label: `${team.id}-${role.id}`,
              })
            : null;
        if (worktree?.info) {
          subRecord.logs.push(`Worktree: ${worktree.info.path} (branch ${worktree.info.branch})`);
        }

        const stageAgent = new AivoAgent({
          config: {
            ...this.config,
            cwd: worktree?.cwd ?? this.config.cwd,
            model: stageModel,
            team: team.id,
            reasoningEffort: stageEffort,
            strategy: "native",
            autoReviewFix: false,
          },
          catalog: this.catalog,
          sessionStore: this.sessionStore,
          checkpoints: this.checkpoints,
          ephemeralSession: true,
          memory: this.memory,
          skills: this.skills,
          backgroundJobs: this.backgroundJobs,
          mcpManager: this.mcpManager,
          lspManager: this.lspManager,
          hookRunner: this.hookRunner,
          plugins: this.plugins,
          customCommands: this.customCommands,
          fetchFn: this.fetchFn,
          sleepFn: this.sleepFn,
          maxSteps: 12,
          readOnlyOnly: role.readOnly || this.config.mode === "plan",
          allowSubagents: false,
          callbacks: {
            ...this.callbacks,
            onToolCall: (name, args) => {
              subRecord.logs.push(`▸ ${name}(${JSON.stringify(args).slice(0, 80)})`);
              this.callbacks.onToolCall?.(name, args);
            },
            onTextDelta: (d) => {
              this.callbacks.onTextDelta?.(d);
            },
          },
        });

        try {
          const res = await stageAgent.runUserPrompt(stagePrompt, signal);
          totalUsage.inputTokens += res.turnUsage.inputTokens;
          totalUsage.outputTokens += res.turnUsage.outputTokens;
          totalUsage.cacheReadTokens += res.turnUsage.cacheReadTokens;
          totalUsage.cacheWriteTokens += res.turnUsage.cacheWriteTokens;
          totalCostMicro += res.turnCostMicro;
          totalCacheSavedMicro += res.turnCacheSavedMicro;
          this.addSessionUsage(res.turnUsage, res.turnCostMicro);
          if (worktree) {
            const merged = worktree.finish();
            subRecord.logs.push("", `--- Worktree merge ---`, merged.summary);
            if (merged.conflicts.length > 0) {
              this.callbacks.onNotice?.(
                `Worktree merge conflicts in ${merged.conflicts.slice(0, 5).join(", ")} (stage "${_stage.title}")`,
              );
            }
          }
          subRecord.status = "completed";
          subRecord.logs.push("", "--- Final Stage Output ---", res.finalText);
          stageSpan.setAttribute("stage.cost_micro", res.turnCostMicro.toString());
          stageSpan.setAttribute("stage.output_tokens", res.turnUsage.outputTokens);
          stageSpan.end();
          return res.finalText || "(stage finished)";
        } catch (err) {
          stageSpan.fail(err);
          stageSpan.end();
          if (worktree) {
            const merged = worktree.finish();
            subRecord.logs.push("", `--- Worktree merge (after error) ---`, merged.summary);
          }
          subRecord.status = "error";
          subRecord.logs.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        } finally {
          stageAgent.dispose();
        }
      },
    });

    this.persistSession(true);
    this.pendingTeamWorkflowUsage = {
      usage: totalUsage,
      costMicro: totalCostMicro,
      cacheSavedMicro: totalCacheSavedMicro,
    };
    return {
      text: wfResult.finalSummary,
      usage: totalUsage,
      costMicro: totalCostMicro,
      cacheSavedMicro: totalCacheSavedMicro,
    };
  }

  /** Prompts blocked by a UserPromptSubmit hook throw, so the REPL can report them. */
  async runUserPrompt(rawPrompt: string, signal?: AbortSignal): Promise<RunPromptResult> {
    const turnSpan = this.tracer.startSpan("turn", {
      kind: "agent",
      attributes: {
        "session.id": this.session.id,
        "turn.mode": this.config.mode,
        "turn.model": this.config.model,
        "turn.prompt_chars": rawPrompt.length,
      },
    });
    this.metrics.increment("aivo_turns_total", { mode: this.config.mode }, "Agent turns started");
    try {
      const result = await this.runUserPromptInner(rawPrompt, signal, turnSpan);
      turnSpan.setAttribute("turn.steps", result.steps);
      turnSpan.setAttribute("turn.cost_micro", result.turnCostMicro.toString());
      turnSpan.setAttribute("turn.output_tokens", result.turnUsage.outputTokens);
      this.metrics.observe(
        "aivo_turn_duration_ms",
        turnSpan.durationMs,
        {},
        "Wall-clock turn duration",
      );
      this.metrics.add(
        "aivo_tokens_total",
        result.turnUsage.outputTokens,
        { kind: "output" },
        "Tokens processed",
      );
      this.metrics.add(
        "aivo_tokens_total",
        result.turnUsage.inputTokens + result.turnUsage.cacheReadTokens,
        { kind: "input" },
        "Tokens processed",
      );
      turnSpan.end();
      return result;
    } catch (err) {
      turnSpan.fail(err);
      turnSpan.end();
      this.metrics.increment(
        "aivo_turn_errors_total",
        { mode: this.config.mode },
        "Agent turns that failed",
      );
      throw err;
    }
  }

  private async runUserPromptInner(
    rawPrompt: string,
    signal: AbortSignal | undefined,
    turnSpan: import("./telemetry.js").Span,
  ): Promise<RunPromptResult> {
    if (!this.ephemeralSession) {
      this.checkpoints.beginTurn(`turn_${Date.now()}`);
    }
    this.pendingTeamWorkflowUsage = null;
    sanitizeDanglingToolCalls(this.session.messages);
    await this.loadPluginRuntime();

    if (this.hookRunner.hasHooks("SessionStart") && !this.hookSessionStarted) {
      this.hookSessionStarted = true;
      const started = await this.hookRunner.run("SessionStart", {
        sessionId: this.session.id,
        cwd: this.config.cwd,
        mode: this.config.mode,
        prompt: rawPrompt,
      });
      for (const line of started.additionalContext) {
        this.callbacks.onNotice?.(line);
      }
    }
    if (this.hookRunner.hasHooks("UserPromptSubmit")) {
      const submit = await this.hookRunner.run("UserPromptSubmit", {
        sessionId: this.session.id,
        cwd: this.config.cwd,
        mode: this.config.mode,
        prompt: rawPrompt,
      });
      if (submit.blocked) {
        throw new Error(`Prompt blocked by UserPromptSubmit hook: ${submit.reason ?? "no reason given"}`);
      }
      for (const line of submit.additionalContext) {
        this.callbacks.onNotice?.(line);
      }
    }

    await this.loadPluginRuntime();

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
          const wf = await this.executeTeamWorkflowWithUsage(rawPrompt, this.config.team, signal);
          this.pendingTeamWorkflowUsage = null;
          return {
            finalText: wf.text,
            steps: Math.max(1, strategy.autoTodos.length),
            turnUsage: wf.usage,
            turnCostMicro: wf.costMicro,
            turnCacheSavedMicro: wf.cacheSavedMicro,
          };
        }
      }
    }

    const isReadOnlyQa = this.readOnlyOnly || isReadOnlyQaPrompt(rawPrompt);
    let expandedPrompt = expandFileMentions(rawPrompt, this.config.cwd);
    const hasPrehydratedFiles = expandedPrompt.includes('<file path="');
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

    const baseSystemPrompt = buildSystemPrompt(
      this.config.cwd,
      this.config.mode,
      this.config.team,
      this.lspManager.hasServers(),
    );
    const skillSummaries = this.skills.listSkills();
    let systemPrompt =
      skillSummaries.length > 0
        ? `${baseSystemPrompt}\n\n## Available Skills (use skill_load id='<id>' when relevant)\n${skillSummaries
            .slice(0, 50)
            .map((skill) => `- ${skill.id} (${skill.name}): ${skill.description}`)
            .join("\n")}`
        : baseSystemPrompt;
    const modelInfo = this.getActiveModelInfo();
    const contextLimit = modelInfo?.contextWindow ?? 128_000;

    const estTokens = estimateConversationTokens(systemPrompt, this.session.messages);
    if (estTokens > Math.floor(contextLimit * 0.8)) {
      const c = this.compactNow();
      this.callbacks.onNotice?.(
        `Auto-compacted conversation (${c.beforeTokens.toLocaleString("en-US")} -> ${c.afterTokens.toLocaleString("en-US")} est. tokens)`,
      );
    }

    const totalUsage: TurnUsageMetrics = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let totalCostMicro = 0n;
    let totalCacheSavedMicro = 0n;

    const isPrimaryImageOutputModel =
      /\bimage\b/i.test(this.config.model) && !/vision/i.test(this.config.model);

    if (this.mcpManager.hasServers()) {
      if (!this.mcpManager.isStarted()) {
        this.callbacks.onNotice?.("Connecting MCP servers...");
      }
      await this.mcpManager.ensureStarted();
      const failed = this.mcpManager.getStatuses().filter((status) => status.state === "error");
      if (failed.length > 0) {
        this.callbacks.onNotice?.(
          `MCP server issue(s): ${failed.map((status) => `${status.name}${status.error ? ` (${status.error})` : ""}`).join(", ")}`,
        );
      }
    }
    const mcpInstructions = this.mcpManager.getInstructions();
    if (mcpInstructions.length > 0) {
      systemPrompt += `\n\n## MCP Server Instructions\n${mcpInstructions.join("\n\n")}`;
    }

    const shellSandbox = new ShellSandbox({
      cwd: this.config.cwd,
      mode: this.config.sandbox ?? "workspace",
      network: this.config.permissions?.network ?? "allow",
    });
    const permissionKey = [
      this.config.mode,
      this.config.sandbox ?? "workspace",
      this.config.permissions?.network ?? "allow",
      JSON.stringify(this.config.permissions ?? {}),
      shellSandbox.enforced ? "sandboxed" : "plain",
    ].join("|");
    if (!this.permissionEngine || this.permissionEngineKey !== permissionKey) {
      this.permissionEngine = new PermissionEngine({
        cwd: this.config.cwd,
        mode: this.config.mode,
        sandbox: this.config.sandbox ?? "workspace",
        permissions: this.config.permissions,
        confirmAction:
          this.callbacks.confirmActionChoice || this.callbacks.confirmAction
            ? (description) => this.confirmChoiceSerialized(description)
            : undefined,
        shellSandboxEnforced: shellSandbox.enforced,
      });
      this.permissionEngineKey = permissionKey;
    }
    const permissionEngine = this.permissionEngine;
    if (
      !this.ephemeralSession &&
      !this.sandboxNoticeShown &&
      (this.config.sandbox ?? "workspace") !== "danger-full-access" &&
      !shellSandbox.enforced
    ) {
      this.sandboxNoticeShown = true;
      this.callbacks.onNotice?.(
        `OS shell sandbox unavailable on ${process.platform}; file tools still enforce workspace path policy. Use --sandbox danger-full-access to silence this.`,
      );
    }

    const toolset = createToolset({
      cwd: this.config.cwd,
      mode: this.config.mode,
      checkpoints: this.checkpoints,
      todos: this.todos,
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      defaultImageModel: isPrimaryImageOutputModel ? this.config.model : "gemini-2.5-flash-image",
      memory: this.memory,
      skills: this.skills,
      backgroundJobs: this.backgroundJobs,
      webSearchEnabled: this.config.webSearch,
      readOnlyOnly: isReadOnlyQa,
      confirmAction: this.callbacks.confirmAction,
      fetchFn: this.fetchFn,
      webSearchRouter: this.webSearchRouter,
      mcpManager: this.mcpManager,
      lspManager: this.lspManager,
      extraTools: this.pluginTools,
      permissionEngine,
      shellSandbox,
      envAllow: this.config.permissions?.env,
      network: this.config.permissions?.network ?? "allow",
      hooks: this.hookRunner,
      sessionId: this.session.id,
      onHookContext: (toolName, context) => {
        this.callbacks.onNotice?.(`[hook:${toolName}] ${context}`);
      },
      signal,
      onSubagent: this.allowSubagents
        ? async ({ agent, description, prompt }) => {
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

            const subRecord: SubagentRunRecord = {
              id: `sub_${this.subagentRuns.length + 1}`,
              name: agent,
              description,
              model: subModel,
              status: "running",
              logs: [`Task: ${description}`, `Model: ${subModel} (effort: ${subEffort})`, ""],
            };
            this.subagentRuns.push(subRecord);
            this.callbacks.onNotice?.(
              `Spawning ${agent} subagent [${subRecord.id} · ${subModel}]: ${description}`,
            );

            // Explore subagents are read-only; general subagents may edit, so
            // isolate them in their own worktree to avoid parallel races.
            const isolate = agent !== "explore" && this.shouldIsolateSubagents();
            const worktree = isolate
              ? withWorktree({ cwd: this.config.cwd, label: `subagent-${agent}` })
              : null;
            if (worktree?.info) {
              subRecord.logs.push(
                `Worktree: ${worktree.info.path} (branch ${worktree.info.branch})`,
                "",
              );
            }

            const subAgent = new AivoAgent({
              config: {
                ...this.config,
                cwd: worktree?.cwd ?? this.config.cwd,
                model: subModel,
                reasoningEffort: subEffort,
                strategy: "native",
                autoReviewFix: false,
              },
              catalog: this.catalog,
              sessionStore: this.sessionStore,
              checkpoints: this.checkpoints,
              ephemeralSession: true,
              memory: this.memory,
              skills: this.skills,
              backgroundJobs: this.backgroundJobs,
              mcpManager: this.mcpManager,
              lspManager: this.lspManager,
              hookRunner: this.hookRunner,
              plugins: this.plugins,
              customCommands: this.customCommands,
              fetchFn: this.fetchFn,
              sleepFn: this.sleepFn,
              maxSteps: 10,
              readOnlyOnly: agent === "explore" || this.config.mode === "plan",
              allowSubagents: false,
              callbacks: {
                confirmAction: this.callbacks.confirmAction,
                confirmActionChoice: this.callbacks.confirmActionChoice,
                onToolCall: (tName, tArgs) => {
                  subRecord.logs.push(`▸ ${tName}(${JSON.stringify(tArgs).slice(0, 80)})`);
                },
                onToolResult: (tName, tOut, isErr) => {
                  subRecord.logs.push(
                    `  ${isErr ? "✗" : "✓"} ${tName}: ${tOut.split(/\r?\n/)[0]?.slice(0, 100) ?? ""}`,
                  );
                },
              },
            });
            try {
              const subRes = await subAgent.runUserPrompt(prompt, signal);
              totalUsage.inputTokens += subRes.turnUsage.inputTokens;
              totalUsage.outputTokens += subRes.turnUsage.outputTokens;
              totalUsage.cacheReadTokens += subRes.turnUsage.cacheReadTokens;
              totalUsage.cacheWriteTokens += subRes.turnUsage.cacheWriteTokens;
              totalCostMicro += subRes.turnCostMicro;
              totalCacheSavedMicro += subRes.turnCacheSavedMicro;
              this.addSessionUsage(subRes.turnUsage, subRes.turnCostMicro);
              if (worktree) {
                const merged = worktree.finish();
                subRecord.logs.push("", "--- Worktree merge ---", merged.summary);
                if (merged.conflicts.length > 0) {
                  this.callbacks.onNotice?.(
                    `Worktree merge conflicts in ${merged.conflicts.slice(0, 5).join(", ")} (subagent ${subRecord.id})`,
                  );
                }
              }
              subRecord.status = "completed";
              subRecord.logs.push("", "--- Subagent Report ---", subRes.finalText);
              return subRes.finalText || "(subagent completed with no output)";
            } catch (err) {
              if (worktree) {
                const merged = worktree.finish();
                subRecord.logs.push("", "--- Worktree merge (after error) ---", merged.summary);
              }
              subRecord.status = "error";
              subRecord.logs.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
              throw err;
            } finally {
              subAgent.dispose();
            }
          }
        : undefined,
      onTeamWorkflow: this.allowSubagents
        ? async ({ teamId, goal }) => {
            return this.executeTeamWorkflow(goal, teamId, signal);
          }
        : undefined,
    });

    let finalText = "";
    let steps = 0;
    let reviewFixPassDone = false;
    let stopContinuations = 0;
    let testsJustPassed = false;
    let lastStepHadError = false;
    let initialStepEffort: string | null = null;

    while (steps < this.maxSteps) {
      if (signal?.aborted) {
        throw new Error("Generation interrupted by user.");
      }
      steps++;
      this.pruneOldImagePayloads();

      const hasImagesInConversation = this.session.messages.some(
        (m) => m.images && m.images.length > 0,
      );
      const baseOrchestratorModel = isPrimaryImageOutputModel
        ? this.config.fastModel && !/\bimage\b/i.test(this.config.fastModel)
          ? this.config.fastModel
          : "deepseek-v4.1-flash"
        : this.config.model;
      const effectiveModel = hasImagesInConversation
        ? pickVisionCapableModel(baseOrchestratorModel, this.catalog)
        : baseOrchestratorModel;
      if (effectiveModel !== this.config.model && !isPrimaryImageOutputModel) {
        this.callbacks.onNotice?.(
          `Vision attachment detected — routing step via vision model '${effectiveModel}'`,
        );
      }

      const effectiveModelInfo = this.catalog.find((m) => m.id === effectiveModel) ?? modelInfo;
      const rawStepEffort = resolveStepReasoningEffort({
        configuredEffort: this.config.reasoningEffort,
        step: steps,
        isReadOnlyQa,
        hasPrehydratedFiles,
        testsJustPassed,
        lastStepHadError,
      });
      const stepEffort =
        effectiveModelInfo && !effectiveModelInfo.supportsReasoning ? "off" : rawStepEffort;
      if (initialStepEffort === null) {
        initialStepEffort = stepEffort;
      }

      let stepRes;
      let retryCount = 0;
      while (true) {
        const effortSuffix = stepEffort !== initialStepEffort ? `_${stepEffort}` : "";
        const retrySuffix = retryCount === 0 ? "" : `_r${retryCount}`;
        const stickySessionId = `${this.session.id}${effortSuffix}${retrySuffix}`;
        const modelSpan = this.tracer.startSpan("model.call", {
          kind: "model",
          parent: turnSpan,
          attributes: {
            "model.id": effectiveModel,
            "model.effort": stepEffort,
            "model.wire": this.config.wire,
            "model.step": steps,
            "model.retry": retryCount,
          },
        });
        try {
          stepRes = await streamTurn({
            baseUrl: this.config.baseUrl,
            apiKey: this.config.apiKey,
            sessionId: stickySessionId,
            wire: this.config.wire,
            model: effectiveModel,
            systemPrompt,
            messages: this.session.messages,
            // Keep read-only tools available even when referenced files were pre-hydrated;
            // removing every tool forced the model to guess instead of verifying.
            tools: toolset.specs,
            reasoningEffort: stepEffort,
            maxTokens:
              this.config.wire === "messages"
                ? Math.min(16384, modelInfo?.maxOutputTokens ?? 8192)
                : undefined,
            chunkIdleTimeoutMs: this.chunkIdleTimeoutMs,
            signal,
            fetchFn: this.fetchFn,
            onReasoningDelta: this.callbacks.onReasoningDelta,
            onTextDelta: this.callbacks.onTextDelta,
            onToolCallProgress: this.callbacks.onToolCallProgress,
          });
          modelSpan.setAttribute("model.request_id", stepRes.requestId ?? "");
          modelSpan.setAttribute("model.input_tokens", stepRes.usage.inputTokens);
          modelSpan.setAttribute("model.output_tokens", stepRes.usage.outputTokens);
          modelSpan.setAttribute("model.tool_calls", stepRes.toolCalls.length);
          modelSpan.end();
          break;
        } catch (err) {
          modelSpan.fail(err);
          modelSpan.end();
          this.metrics.increment(
            "aivo_model_errors_total",
            { model: effectiveModel },
            "Model calls that failed",
          );
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
              await this.sleepAbortable(waitS * 1000, signal);
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

      const stepCost = calculateTurnCostMicro(
        effectiveModelInfo ?? modelInfo,
        stepRes.usage,
      );
      totalCostMicro += stepCost.costMicro;
      totalCacheSavedMicro += stepCost.cacheSavedMicro;

      this.addSessionUsage(stepRes.usage, stepCost.costMicro);

      this.session.messages.push({
        role: "assistant",
        content: stepRes.text,
        ...(stepRes.reasoning ? { reasoning: stepRes.reasoning } : {}),
        ...(stepRes.toolCalls.length > 0 ? { toolCalls: stepRes.toolCalls } : {}),
      });
      this.persistSession();

      if (stepRes.toolCalls.length === 0) {
        // Separated Iterative Review -> Fix -> Re-Review -> Re-Fix Loop when files were modified
        const touched = this.checkpoints.listActiveTurnFiles();
        if (
          touched.length > 0 &&
          !reviewFixPassDone &&
          !this.readOnlyOnly &&
          this.config.autoReviewFix !== false
        ) {
          const staticCheck = verifyWorkspaceArtifacts(this.config.cwd, touched);
          if (!staticCheck.clean) {
            const reviewResult = await runIterativeReviewFixLoop({
              cwd: this.config.cwd,
              modifiedFiles: touched,
              maxRounds: 3,
              onEvent: (msg) => this.callbacks.onNotice?.(msg),
              runReviewerAgent: async (_round, staticFindings) => {
                if (!this.config.reviewerModel) {
                  // Static-only gate (default): no extra model call, but still fail honestly.
                  if (staticFindings.length > 0) {
                    return `VERDICT: NEEDS_FIX\n${staticFindings.map((f, idx) => `${idx + 1}. ${f}`).join("\n")}`;
                  }
                  return "VERDICT: PASS";
                }

                const reviewerAgent = new AivoAgent({
                  config: {
                    ...this.config,
                    model: this.config.reviewerModel,
                    reasoningEffort: this.config.subagentEffort ?? "low",
                    strategy: "native",
                    autoReviewFix: false,
                  },
                  catalog: this.catalog,
                  sessionStore: this.sessionStore,
                  checkpoints: this.checkpoints,
                  ephemeralSession: true,
                  memory: this.memory,
                  skills: this.skills,
                  backgroundJobs: this.backgroundJobs,
                  mcpManager: this.mcpManager,
                  lspManager: this.lspManager,
                  hookRunner: this.hookRunner,
                  plugins: this.plugins,
                  customCommands: this.customCommands,
                  fetchFn: this.fetchFn,
                  sleepFn: this.sleepFn,
                  maxSteps: 4,
                  readOnlyOnly: true,
                  allowSubagents: false,
                  callbacks: {},
                });
                try {
                  const reviewRes = await reviewerAgent.runUserPrompt(
                    [
                      "[Read-Only QA Review]",
                      `Review these modified files: ${touched.join(", ")}`,
                      "Inspect them with read_file/grep_search. Static findings:",
                      ...(staticFindings.length > 0
                        ? staticFindings.map((f, idx) => `${idx + 1}. ${f}`)
                        : ["(none)"]),
                      "",
                      "Reply exactly with one of:",
                      "VERDICT: PASS",
                      "or",
                      "VERDICT: NEEDS_FIX",
                      "1. <file:line — concrete issue>",
                    ].join("\n"),
                    signal,
                  );
                  totalUsage.inputTokens += reviewRes.turnUsage.inputTokens;
                  totalUsage.outputTokens += reviewRes.turnUsage.outputTokens;
                  totalUsage.cacheReadTokens += reviewRes.turnUsage.cacheReadTokens;
                  totalUsage.cacheWriteTokens += reviewRes.turnUsage.cacheWriteTokens;
                  totalCostMicro += reviewRes.turnCostMicro;
                  totalCacheSavedMicro += reviewRes.turnCacheSavedMicro;
                  this.addSessionUsage(reviewRes.turnUsage, reviewRes.turnCostMicro);
                  return reviewRes.finalText;
                } catch (err) {
                  if (signal?.aborted) throw err;
                  this.callbacks.onNotice?.(
                    `Reviewer model failed (${err instanceof Error ? err.message : String(err)}); falling back to static findings.`,
                  );
                  return staticFindings.length > 0
                    ? `VERDICT: NEEDS_FIX\n${staticFindings.map((f, idx) => `${idx + 1}. ${f}`).join("\n")}`
                    : "VERDICT: PASS";
                }
              },
              runFixerAgent: async (round, issuesToFix) => {
                const fixerAgent = new AivoAgent({
                  config: {
                    ...this.config,
                    model: this.config.builderModel || this.config.model,
                    strategy: "native",
                    autoReviewFix: false,
                  },
                  catalog: this.catalog,
                  sessionStore: this.sessionStore,
                  checkpoints: this.checkpoints,
                  ephemeralSession: true,
                  memory: this.memory,
                  skills: this.skills,
                  backgroundJobs: this.backgroundJobs,
                  mcpManager: this.mcpManager,
                  lspManager: this.lspManager,
                  hookRunner: this.hookRunner,
                  plugins: this.plugins,
                  customCommands: this.customCommands,
                  fetchFn: this.fetchFn,
                  sleepFn: this.sleepFn,
                  maxSteps: 8,
                  readOnlyOnly: false,
                  allowSubagents: false,
                  callbacks: this.callbacks,
                });
                const fixRes = await fixerAgent.runUserPrompt(
                  [
                    `[Dedicated Fix Round ${round}]`,
                    "Fix ONLY the following verified review issues in the workspace files:",
                    ...issuesToFix.map((iss, idx) => `${idx + 1}. ${iss}`),
                  ].join("\n"),
                  signal,
                );
                totalUsage.inputTokens += fixRes.turnUsage.inputTokens;
                totalUsage.outputTokens += fixRes.turnUsage.outputTokens;
                totalUsage.cacheReadTokens += fixRes.turnUsage.cacheReadTokens;
                totalUsage.cacheWriteTokens += fixRes.turnUsage.cacheWriteTokens;
                totalCostMicro += fixRes.turnCostMicro;
                totalCacheSavedMicro += fixRes.turnCacheSavedMicro;
                this.addSessionUsage(fixRes.turnUsage, fixRes.turnCostMicro);
                return fixRes.finalText;
              },
            });
            if (!reviewResult.passed && reviewResult.remainingIssues.length > 0) {
              this.callbacks.onNotice?.(
                `Review gate still found ${reviewResult.remainingIssues.length} issue(s): ${reviewResult.remainingIssues
                  .slice(0, 5)
                  .join(" | ")}`,
              );
            }
          }
          reviewFixPassDone = true;
        }

        // Mark all todos completed when turn finishes cleanly
        if (this.todos.length > 0) {
          for (const t of this.todos) t.status = "completed";
          this.callbacks.onTodoUpdate?.(this.todos);
        }

        // Stop hooks can request another pass (e.g. "tests must pass before finishing").
        if (this.hookRunner.hasHooks("Stop") && stopContinuations < 2 && steps < this.maxSteps) {
          const stopResult = await this.hookRunner.run("Stop", {
            sessionId: this.session.id,
            cwd: this.config.cwd,
            mode: this.config.mode,
            prompt: rawPrompt,
            stopReason: stepRes.text,
          });
          for (const line of stopResult.additionalContext) {
            this.callbacks.onNotice?.(line);
          }
          if (stopResult.blocked) {
            stopContinuations++;
            this.callbacks.onNotice?.(
              `Stop hook requested another pass: ${stopResult.reason ?? "no reason given"}`,
            );
            this.session.messages.push({
              role: "user",
              content: `[Stop hook] ${stopResult.reason ?? "Continue working; the task is not complete yet."}`,
            });
            this.persistSession();
            continue;
          }
        }

        finalText = stepRes.text;
        this.persistSession();
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
          "todo_write",
          "mcp_list_resources",
          "mcp_read_resource",
          "mcp_list_prompts",
          "mcp_get_prompt",
        ].includes(tc.name),
      );

      const pendingImages = [];
      testsJustPassed = false;
      lastStepHadError = false;

      const runToolWithSpan = async (tc: { name: string; arguments: Record<string, unknown> }) => {
        const t0 = Date.now();
        const toolSpan = this.tracer.startSpan(`tool.${tc.name}`, {
          kind: "tool",
          parent: turnSpan,
          attributes: {
            "tool.name": tc.name,
            "tool.arg_keys": Object.keys(tc.arguments).join(","),
          },
        });
        this.callbacks.onToolCall?.(tc.name, tc.arguments);
        try {
          const execRes = await toolset.execute(tc.name, tc.arguments);
          if (execRes.durationMs === undefined) execRes.durationMs = Date.now() - t0;
          toolSpan.setAttribute("tool.duration_ms", execRes.durationMs);
          toolSpan.setAttribute("tool.error", Boolean(execRes.isError));
          if (execRes.isError) toolSpan.setAttribute("tool.error_message", execRes.output.slice(0, 500));
          toolSpan.end(execRes.isError ? "error" : "ok");
          this.metrics.observe(
            "aivo_tool_duration_ms",
            execRes.durationMs,
            { tool: tc.name },
            "Tool execution duration",
          );
          this.metrics.increment(
            execRes.isError ? "aivo_tool_errors_total" : "aivo_tool_calls_total",
            { tool: tc.name },
            "Tool executions",
          );
          return execRes;
        } catch (err) {
          toolSpan.fail(err);
          toolSpan.end();
          this.metrics.increment("aivo_tool_errors_total", { tool: tc.name }, "Tool executions");
          throw err;
        }
      };

      if (allReadOnly && stepRes.toolCalls.length > 1) {
        const results = await Promise.all(
          stepRes.toolCalls.map(async (tc) => {
            const execRes = await runToolWithSpan(tc);
            if (autoAdvanceTodos(this.todos, tc.name, tc.arguments)) {
              this.callbacks.onTodoUpdate?.(this.todos);
            }
            this.callbacks.onToolResult?.(tc.name, execRes.output, execRes.isError, execRes, tc.arguments);
            return { tc, execRes };
          }),
        );
        for (const { tc, execRes } of results) {
          if (execRes.isError) lastStepHadError = true;
          this.session.messages.push({
            role: "tool",
            toolCallId: tc.id,
            toolName: tc.name,
            content: execRes.output,
            isError: execRes.isError,
          });
          if (execRes.imageAttachments && execRes.imageAttachments.length > 0) {
            pendingImages.push(...execRes.imageAttachments);
          } else if (execRes.imageAttachment) {
            pendingImages.push(execRes.imageAttachment);
          }
        }
      } else {
        for (const tc of stepRes.toolCalls) {
          const execRes = await runToolWithSpan(tc);
          if (execRes.isError) lastStepHadError = true;
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
          if (
            tc.name === "run_shell" &&
            !execRes.isError &&
            this.checkpoints.listActiveTurnFiles().length > 0 &&
            (/\b(test|vitest|jest|pytest|check)\b/i.test(String(tc.arguments.command ?? "")) ||
              /\bPASS(ED)?\b/.test(execRes.output))
          ) {
            testsJustPassed = true;
          }
          if (execRes.imageAttachments && execRes.imageAttachments.length > 0) {
            pendingImages.push(...execRes.imageAttachments);
          } else if (execRes.imageAttachment) {
            pendingImages.push(execRes.imageAttachment);
          }
        }
      }

      const wfUsage = this.takePendingTeamWorkflowUsage();
      if (wfUsage) {
        totalUsage.inputTokens += wfUsage.usage.inputTokens;
        totalUsage.outputTokens += wfUsage.usage.outputTokens;
        totalUsage.cacheReadTokens += wfUsage.usage.cacheReadTokens;
        totalUsage.cacheWriteTokens += wfUsage.usage.cacheWriteTokens;
        totalCostMicro += wfUsage.costMicro;
        totalCacheSavedMicro += wfUsage.cacheSavedMicro;
      }

      if (pendingImages.length > 0) {
        this.session.messages.push({
          role: "user",
          content: "Attached image(s) from tool execution for visual inspection:",
          images: pendingImages,
        });
      }

      if (signal?.aborted) {
        throw new Error("Generation interrupted by user.");
      }

      this.persistSession();
    }

    // OpenCode V2 rule: if `maxSteps` was reached while the last message was a tool result,
    // remove tools and request a final text summary so the agent NEVER stops silently!
    const lastMsg = this.session.messages[this.session.messages.length - 1];
    if (!finalText && lastMsg && lastMsg.role === "tool") {
      this.pruneOldImagePayloads();
      const hasImages = this.session.messages.some((m) => m.images && m.images.length > 0);
      const summaryModel = hasImages
        ? pickVisionCapableModel(this.config.model, this.catalog)
        : this.config.model;
      const summaryTurn = await streamTurn({
        baseUrl: this.config.baseUrl,
        apiKey: this.config.apiKey,
        sessionId: this.session.id,
        wire: this.config.wire,
        model: summaryModel,
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
      const summaryCost = calculateTurnCostMicro(
        this.catalog.find((m) => m.id === summaryModel) ?? modelInfo,
        summaryTurn.usage,
      );
      totalUsage.inputTokens += summaryTurn.usage.inputTokens;
      totalUsage.outputTokens += summaryTurn.usage.outputTokens;
      totalUsage.cacheReadTokens += summaryTurn.usage.cacheReadTokens;
      totalUsage.cacheWriteTokens += summaryTurn.usage.cacheWriteTokens;
      totalCostMicro += summaryCost.costMicro;
      totalCacheSavedMicro += summaryCost.cacheSavedMicro;
      this.addSessionUsage(summaryTurn.usage, summaryCost.costMicro);
      finalText = summaryTurn.text;
      this.session.messages.push({
        role: "assistant",
        content: finalText,
      });
      if (this.todos.length > 0) {
        for (const t of this.todos) t.status = "completed";
        this.callbacks.onTodoUpdate?.(this.todos);
      }
      this.persistSession();
    }

    // The browser is a long-lived child process; never leak it past a turn.
    try {
      (
        toolset as unknown as { disposeBrowser?: () => void }
      ).disposeBrowser?.();
    } catch {
      /* best-effort browser shutdown */
    }
    this.persistSession(true);
    return {
      finalText,
      steps,
      turnUsage: totalUsage,
      turnCostMicro: totalCostMicro,
      turnCacheSavedMicro: totalCacheSavedMicro,
    };
  }
}
