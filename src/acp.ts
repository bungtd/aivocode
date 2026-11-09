/**
 * Agent Client Protocol (ACP) server.
 *
 * Implements the ACP v1 JSON-RPC subset that code editors (Zed, Neovim, VS Code
 * bridges, ...) need to drive AivoCode: initialize, session/new, session/load,
 * session/prompt, session/cancel and optional session/set_mode.
 *
 * Transport: newline-delimited JSON on stdin/stdout (the ACP stdio transport).
 * Diagnostics go to stderr so stdout stays a clean protocol stream.
 *
 * Spec: https://agentclientprotocol.com/protocol/overview
 */
import { createInterface } from "node:readline";
import { basename, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import { AivoAgent } from "./agent.js";
import type { AivoConfig, PermissionMode } from "./config.js";
import type { AivoModelInfo } from "./aivokey-client.js";
import type { SessionStore } from "./session.js";
import type { ToolExecutionResult } from "./tools/index.js";
import type { ImageAttachment } from "./vision.js";
import { AIVO_CLIENT_VERSION } from "./client-identity.js";

const ACP_PROTOCOL_VERSION = 1;

type JsonRpcId = string | number;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface AcpContentBlock {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
  uri?: string;
  resource?: { uri?: string; mimeType?: string; text?: string };
}

interface AcpPromptParams {
  sessionId?: string;
  prompt?: AcpContentBlock[];
}

interface AcpSessionNewParams {
  cwd?: string;
  mcpServers?: unknown[];
  additionalDirectories?: string[];
}

interface AcpSessionState {
  id: string;
  agent: AivoAgent;
  cwd: string;
  abort: AbortController | null;
  cancelRequested: boolean;
  toolCalls: Map<string, { title: string; kind: string }>;
  lastToolCallId: string | null;
  messageSeq: number;
  promptSeq: number;
}

export interface AcpServerOptions {
  config: AivoConfig;
  catalog?: AivoModelInfo[];
  sessionStore: SessionStore;
  fetchFn?: typeof fetch;
  writeErr?: (text: string) => void;
  input?: Readable;
  output?: Writable;
}

interface AcpClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  session?: { notices?: unknown; compaction?: unknown };
}

const ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  authRequired: -32000,
  unknownSession: -32002,
} as const;

/** Maps AivoCode tools to the coarse ACP tool kinds editors use for icons/UX. */
function toolKind(name: string): string {
  if (name === "read_file" || name === "vision_analyze" || name === "lsp_diagnostics") return "read";
  if (name === "grep_search" || name === "glob_files" || name === "code_search" || name === "web_search") {
    return "search";
  }
  if (name === "web_fetch") return "fetch";
  if (name === "write_file" || name === "edit_file" || name === "apply_patch") return "edit";
  if (name === "run_shell") return "execute";
  if (name === "todo_write" || name === "memory_remember" || name === "skill_create") return "other";
  if (name === "subagent" || name === "team_workflow") return "think";
  return "other";
}

function toolTitle(name: string, args: Record<string, unknown>): string {
  const target =
    typeof args.path === "string"
      ? args.path
      : typeof args.command === "string"
        ? args.command
        : typeof args.query === "string"
          ? args.query
          : typeof args.description === "string"
            ? args.description
            : "";
  return target ? `${name}: ${target.slice(0, 120)}` : name;
}

/** Extracts file locations a tool touched, so editors can follow along. */
function toolLocations(
  cwd: string,
  name: string,
  args: Record<string, unknown>,
  result: ToolExecutionResult | undefined,
): Array<{ path: string; line?: number }> {
  const candidates: string[] = [];
  if (typeof args.path === "string") candidates.push(args.path);
  if (typeof result?.diff?.filePath === "string") candidates.push(result.diff.filePath);
  void name;
  const locations: Array<{ path: string; line?: number }> = [];
  for (const candidate of candidates) {
    const abs = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    if (!locations.some((location) => location.path === abs)) locations.push({ path: abs });
  }
  return locations;
}

function textFromPrompt(prompt: AcpContentBlock[] | undefined, cwd: string): string {
  if (!Array.isArray(prompt)) return "";
  const parts: string[] = [];
  for (const block of prompt) {
    if (typeof block !== "object" || block === null) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "resource_link" && typeof block.uri === "string") {
      parts.push(`@${block.uri}`);
      continue;
    }
    if (block.type === "resource" && typeof block.resource === "object" && block.resource) {
      const uri = block.resource.uri ?? "";
      if (block.resource.text) {
        parts.push(`<file path="${uri}">\n${block.resource.text}\n</file>`);
      } else if (uri) {
        parts.push(`@${uri}`);
      }
      continue;
    }
    if (block.type === "image") {
      parts.push(`[image attachment: ${block.mimeType ?? "image"}]`);
    }
  }
  void cwd;
  return parts.join("\n\n").trim();
}

function imageAttachmentsFromPrompt(
  prompt: AcpContentBlock[] | undefined,
): ImageAttachment[] {
  if (!Array.isArray(prompt)) return [];
  const images: ImageAttachment[] = [];
  for (const block of prompt) {
    if (block?.type !== "image" || typeof block.data !== "string") continue;
    const mimeType = block.mimeType ?? "image/png";
    if (!mimeType.startsWith("image/")) continue;
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)) continue;
    const base64 = block.data;
    const byteSize = Math.ceil((base64.length * 3) / 4);
    images.push({
      filePath: `acp-image-${images.length + 1}`,
      mimeType: mimeType as ImageAttachment["mimeType"],
      width: 0,
      height: 0,
      byteSize,
      base64,
      dataUrl: `data:${mimeType};base64,${base64}`,
    });
  }
  return images;
}

function toPermissionMode(value: string): PermissionMode | null {
  return value === "auto" || value === "safe" || value === "plan" ? value : null;
}

export class AcpServer {
  private readonly sessions = new Map<string, AcpSessionState>();
  private readonly output: Writable;
  private readonly writeErr: (text: string) => void;
  private initialized = false;
  private clientCapabilities: AcpClientCapabilities = {};
  private closed = false;
  private messageCounter = 0;

  constructor(private readonly options: AcpServerOptions) {
    this.output = options.output ?? process.stdout;
    this.writeErr = options.writeErr ?? ((text) => process.stderr.write(text));
  }

  /**
   * Runs the server until stdin closes. Resolves with the process exit code so
   * `aivo acp` can be used directly as an editor subprocess.
   */
  async serve(): Promise<number> {
    const input = this.options.input ?? process.stdin;
    const rl = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
        try {
          message = JSON.parse(trimmed) as JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
        } catch {
          this.sendError(null, ERROR_CODES.parseError, "Invalid JSON");
          continue;
        }
        await this.handleMessage(message);
      }
    } finally {
      rl.close();
      this.disposeAll();
    }
    return 0;
  }

  private async handleMessage(
    message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse,
  ): Promise<void> {
    if (typeof message !== "object" || message === null) {
      this.sendError(null, ERROR_CODES.invalidRequest, "Invalid JSON-RPC message");
      return;
    }

    // Client response to a request we sent (e.g. session/request_permission).
    if (!("method" in message) && "id" in message && message.id !== undefined) {
      const numericId = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = this.pending.get(numericId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(numericId);
      const error = (message as JsonRpcResponse).error;
      if (error) {
        pending.reject(new AcpMethodError(error.code ?? ERROR_CODES.internal, error.message));
      } else {
        pending.resolve((message as JsonRpcResponse).result);
      }
      return;
    }

    if (!("method" in message) || typeof message.method !== "string") {
      return;
    }

    const isNotification = !("id" in message) || message.id === undefined;
    const id = isNotification ? null : (message as JsonRpcRequest).id;
    const method = message.method;
    const params = (message as JsonRpcRequest).params;

    // Prompt turns are long-running; dispatching them concurrently keeps
    // session/cancel (and other control messages) responsive while the agent works.
    if (method === "session/prompt" && !isNotification) {
      void this.dispatch(method, params, false)
        .then((result) => this.sendResult(id, result))
        .catch((err) => {
          const code = err instanceof AcpMethodError ? err.code : ERROR_CODES.internal;
          this.sendError(id, code, errorMessage(err));
        });
      return;
    }

    try {
      const result = await this.dispatch(method, params, isNotification);
      if (!isNotification) this.sendResult(id, result);
    } catch (err) {
      if (isNotification) {
        this.writeErr(`ACP notification '${method}' failed: ${errorMessage(err)}\n`);
        return;
      }
      const code =
        err instanceof AcpMethodError ? err.code : ERROR_CODES.internal;
      this.sendError(id, code, errorMessage(err));
    }
  }

  private async dispatch(
    method: string,
    params: unknown,
    isNotification: boolean,
  ): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "authenticate":
        return {};
      case "session/new":
        return this.newSession(params);
      case "session/load":
        return this.loadSession(params);
      case "session/prompt":
        return this.prompt(params);
      case "session/cancel":
        this.cancel(params);
        return {};
      case "session/set_mode":
        return this.setMode(params);
      case "session/close":
        this.closeSession(params);
        return {};
      default:
        if (isNotification) return {};
        throw new AcpMethodError(ERROR_CODES.methodNotFound, `Method not supported: ${method}`);
    }
  }

  private initialize(params: unknown): unknown {
    const row = (params ?? {}) as {
      protocolVersion?: number;
      clientCapabilities?: AcpClientCapabilities;
      clientInfo?: { name?: string; version?: string };
    };
    this.initialized = true;
    this.clientCapabilities = row.clientCapabilities ?? {};
    if (typeof row.clientInfo?.name === "string") {
      this.writeErr(`ACP client: ${row.clientInfo.name} ${row.clientInfo.version ?? ""}\n`);
    }
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      agentInfo: {
        name: "aivocode",
        title: "AivoCode",
        version: AIVO_CLIENT_VERSION,
      },
      authMethods: [],
      _meta: {
        sessionCapabilities: { close: {}, setMode: {} },
      },
    };
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new AcpMethodError(ERROR_CODES.invalidRequest, "Client must call initialize first");
    }
  }

  private sessionCwd(params: { cwd?: string; additionalDirectories?: string[] }): string {
    const requested = params.cwd;
    if (requested && !isAbsolute(requested)) {
      throw new AcpMethodError(ERROR_CODES.invalidParams, "cwd must be an absolute path");
    }
    return resolve(requested ?? this.options.config.cwd);
  }

  private createSessionAgent(cwd: string): AivoAgent {
    return new AivoAgent({
      config: { ...this.options.config, cwd },
      catalog: this.options.catalog,
      sessionStore: this.options.sessionStore,
      fetchFn: this.options.fetchFn,
      callbacks: {},
    });
  }

  private newSession(params: unknown): unknown {
    this.ensureInitialized();
    const row = (params ?? {}) as AcpSessionNewParams;
    const cwd = this.sessionCwd(row);
    const agent = this.createSessionAgent(cwd);
    const state: AcpSessionState = {
      id: agent.session.id,
      agent,
      cwd,
      abort: null,
      cancelRequested: false,
      toolCalls: new Map(),
      lastToolCallId: null,
      messageSeq: 0,
      promptSeq: 0,
    };
    this.sessions.set(state.id, state);
    void this.advertiseCommands(state);
    void this.sendUsage(state);
    return { sessionId: state.id };
  }

  private loadSession(params: unknown): unknown {
    this.ensureInitialized();
    const row = (params ?? {}) as AcpSessionNewParams & { sessionId?: string; mcpServers?: unknown[] };
    if (typeof row.sessionId !== "string" || !row.sessionId.trim()) {
      throw new AcpMethodError(ERROR_CODES.invalidParams, "sessionId is required");
    }
    const stored = this.options.sessionStore.loadSession(row.sessionId);
    if (!stored) {
      throw new AcpMethodError(ERROR_CODES.unknownSession, `Unknown session: ${row.sessionId}`);
    }
    const cwd = this.sessionCwd(row);
    const agent = new AivoAgent({
      config: { ...this.options.config, cwd },
      catalog: this.options.catalog,
      sessionStore: this.options.sessionStore,
      session: stored,
      fetchFn: this.options.fetchFn,
      callbacks: {},
    });
    const state: AcpSessionState = {
      id: agent.session.id,
      agent,
      cwd,
      abort: null,
      cancelRequested: false,
      toolCalls: new Map(),
      lastToolCallId: null,
      messageSeq: 0,
      promptSeq: 0,
    };
    this.sessions.set(state.id, state);

    // Replay history so the editor shows the restored conversation.
    for (const message of stored.messages) {
      if (message.role === "user" && typeof message.content === "string") {
        this.sendUpdate(state.id, {
          sessionUpdate: "user_message_chunk",
          messageId: `msg_replay_${state.messageSeq++}`,
          content: { type: "text", text: message.content },
        });
      } else if (message.role === "assistant" && typeof message.content === "string" && message.content) {
        this.sendUpdate(state.id, {
          sessionUpdate: "agent_message_chunk",
          messageId: `msg_replay_${state.messageSeq++}`,
          content: { type: "text", text: message.content },
        });
      }
    }
    void this.advertiseCommands(state);
    return {};
  }

  private async prompt(params: unknown): Promise<unknown> {
    this.ensureInitialized();
    const row = (params ?? {}) as AcpPromptParams;
    const state = this.requireSession(row.sessionId);
    if (state.abort) {
      throw new AcpMethodError(ERROR_CODES.invalidRequest, "A prompt turn is already running");
    }
    const text = textFromPrompt(row.prompt, state.cwd);
    if (!text) {
      throw new AcpMethodError(ERROR_CODES.invalidParams, "prompt must contain at least one text block");
    }

    const images = imageAttachmentsFromPrompt(row.prompt);
    const agent = state.agent;
    if (images.length > 0 && agent.session.messages.length >= 0) {
      agent.session.messages.push({
        role: "user",
        content: "Attached image(s) from the editor for visual inspection:",
        images,
      });
    }

    const abort = new AbortController();
    state.abort = abort;
    state.cancelRequested = false;
    const messageId = `msg_${state.id}_${state.promptSeq++}`;

    // Wire agent callbacks to ACP session/update notifications.
    agent.callbacks = {
      onTextDelta: (delta) => {
        this.sendUpdate(state.id, {
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text: delta },
        });
      },
      onReasoningDelta: (delta) => {
        this.sendUpdate(state.id, {
          sessionUpdate: "agent_thought_chunk",
          messageId,
          content: { type: "text", text: delta },
        });
      },
      onToolCall: (name, args) => {
        const toolCallId = `call_${state.id}_${state.toolCalls.size + 1}_${Date.now()}`;
        state.toolCalls.set(toolCallId, { title: toolTitle(name, args), kind: toolKind(name) });
        this.sendUpdate(state.id, {
          sessionUpdate: "tool_call",
          toolCallId,
          title: toolTitle(name, args),
          name,
          kind: toolKind(name),
          status: "pending",
          rawInput: args,
          locations: toolLocations(state.cwd, name, args, undefined),
        });
        state.lastToolCallId = toolCallId;
      },
      onToolResult: (name, output, isError, details, args) => {
        const toolCallId = state.lastToolCallId ?? `call_${state.id}_result_${Date.now()}`;
        state.lastToolCallId = null;
        const content: unknown[] = [
          {
            type: "content",
            content: { type: "text", text: output.slice(0, 16_000) },
          },
        ];
        if (details?.diff?.filePath) {
          const diffPath = isAbsolute(details.diff.filePath)
            ? details.diff.filePath
            : resolve(state.cwd, details.diff.filePath);
          content.push({
            type: "diff",
            path: diffPath,
            oldText: details.diff.before,
            newText: details.diff.after,
          });
        }
        this.sendUpdate(state.id, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: isError ? "failed" : "completed",
          content,
          rawOutput: output.slice(0, 16_000),
          locations: toolLocations(state.cwd, name, args ?? {}, details),
        });
      },
      onNotice: (message) => {
        this.sendNotice(state.id, message);
      },
      onTodoUpdate: (todos) => {
        this.sendUpdate(state.id, {
          sessionUpdate: "plan",
          entries: todos.map((todo) => ({
            content: todo.content,
            priority: todo.status === "in_progress" ? "high" : "medium",
            status:
              todo.status === "completed"
                ? "completed"
                : todo.status === "in_progress"
                  ? "in_progress"
                  : "pending",
          })),
        });
      },
      confirmAction: async (description) => {
        const outcome = await this.requestPermission(state, description);
        return outcome === "allow";
      },
      confirmActionChoice: async (description) => {
        const outcome = await this.requestPermission(state, description);
        return outcome === "allow" ? "yes" : "no";
      },
      chooseStrategy: async ({ recommendedMode }) => recommendedMode,
    };

    let stopReason = "end_turn";
    try {
      await agent.runUserPrompt(text, abort.signal);
      if (state.cancelRequested) stopReason = "cancelled";
    } catch (err) {
      if (state.cancelRequested || abort.signal.aborted) {
        stopReason = "cancelled";
      } else {
        stopReason = "refusal";
        this.sendNotice(state.id, `Agent error: ${errorMessage(err)}`, "error");
      }
    } finally {
      state.abort = null;
      state.cancelRequested = false;
      state.toolCalls.clear();
      void this.sendUsage(state);
    }
    return { stopReason };
  }

  private cancel(params: unknown): void {
    const row = (params ?? {}) as { sessionId?: string };
    const state = typeof row.sessionId === "string" ? this.sessions.get(row.sessionId) : undefined;
    if (!state) return;
    state.cancelRequested = true;
    state.abort?.abort();
    for (const [toolCallId] of state.toolCalls) {
      this.sendUpdate(state.id, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "cancelled",
      });
    }
    state.toolCalls.clear();
  }

  private setMode(params: unknown): unknown {
    const row = (params ?? {}) as { sessionId?: string; modeId?: string };
    const state = this.requireSession(row.sessionId);
    const mode = toPermissionMode(String(row.modeId ?? ""));
    if (!mode) {
      throw new AcpMethodError(
        ERROR_CODES.invalidParams,
        "modeId must be one of: auto, safe, plan",
      );
    }
    state.agent.config.mode = mode;
    this.sendUpdate(state.id, { sessionUpdate: "current_mode_update", currentModeId: mode });
    return {};
  }

  private closeSession(params: unknown): void {
    const row = (params ?? {}) as { sessionId?: string };
    if (typeof row.sessionId !== "string") return;
    const state = this.sessions.get(row.sessionId);
    if (!state) return;
    state.abort?.abort();
    state.agent.dispose();
    this.sessions.delete(row.sessionId);
  }

  private requireSession(sessionId: string | undefined): AcpSessionState {
    if (typeof sessionId !== "string" || !sessionId) {
      throw new AcpMethodError(ERROR_CODES.invalidParams, "sessionId is required");
    }
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new AcpMethodError(ERROR_CODES.unknownSession, `Unknown session: ${sessionId}`);
    }
    return state;
  }

  private async requestPermission(
    state: AcpSessionState,
    description: string,
  ): Promise<"allow" | "reject" | "cancelled"> {
    const id = ++this.messageCounter;
    const response = await this.request("session/request_permission", {
      sessionId: state.id,
      toolCall: { toolCallId: `permission_${id}`, title: description },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Allow for this session", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    const outcome = (response as { outcome?: { outcome?: string; optionId?: string } } | null)?.outcome;
    if (!outcome || outcome.outcome === "cancelled") return "cancelled";
    return outcome.optionId?.startsWith("allow") ? "allow" : "reject";
  }

  private async advertiseCommands(state: AcpSessionState): Promise<void> {
    const commands = state.agent.customCommands;
    if (commands.length === 0) return;
    this.sendUpdate(state.id, {
      sessionUpdate: "available_commands_update",
      availableCommands: commands.map((command) => ({
        name: command.name,
        description: command.description,
        input: command.argumentHint ? { hint: command.argumentHint } : null,
      })),
    });
  }

  private async sendUsage(state: AcpSessionState): Promise<void> {
    const modelInfo = state.agent.getActiveModelInfo();
    const size = modelInfo?.contextWindow ?? 128_000;
    const used =
      state.agent.session.totalInputTokens + state.agent.session.totalCacheReadTokens;
    const costMicro = BigInt(state.agent.session.totalCostMicro || "0");
    this.sendUpdate(state.id, {
      sessionUpdate: "usage_update",
      used: Math.min(used, size),
      size,
      cost: {
        amount: Number(costMicro) / 1_000_000,
        currency: "USD",
      },
    });
  }

  private sendNotice(sessionId: string, message: string, severity: "info" | "warning" | "error" = "info"): void {
    const notices = this.clientCapabilities.session?.notices;
    if (!notices) {
      // Fall back to an agent message so the user still sees the information.
      this.sendUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `\n_${message}_\n` },
      });
      return;
    }
    this.sendUpdate(sessionId, {
      sessionUpdate: "notice",
      severity,
      title: message.slice(0, 200),
    });
  }

  private sendUpdate(sessionId: string, update: Record<string, unknown>): void {
    this.sendNotification("session/update", { sessionId, update });
  }

  private sendNotification(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private sendResult(id: JsonRpcId | null, result: unknown): void {
    if (id === null) return;
    this.write({ jsonrpc: "2.0", id, result });
  }

  private sendError(id: JsonRpcId | null, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private write(message: unknown): void {
    if (this.closed) return;
    try {
      this.output.write(JSON.stringify(message) + "\n");
    } catch {
      this.closed = true;
    }
  }

  /** Sends a client-bound request and waits for its response. */
  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.messageCounter;
    return new Promise((resolvePromise, rejectPromise) => {
      const pending = this.pending.get(id);
      if (pending) clearTimeout(pending.timer);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new AcpMethodError(ERROR_CODES.internal, `Client request '${method}' timed out`));
      }, 120_000);
      this.pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  /** True once the transport is closed; used by the CLI to exit cleanly. */
  get isClosed(): boolean {
    return this.closed;
  }

  private disposeAll(): void {
    for (const state of this.sessions.values()) {
      state.abort?.abort();
      state.agent.dispose();
    }
    this.sessions.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("ACP connection closed"));
    }
    this.pending.clear();
  }
}

class AcpMethodError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "AcpMethodError";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Entry point used by `aivo acp`. */
export async function runAcpServer(options: AcpServerOptions): Promise<number> {
  const server = new AcpServer(options);
  return server.serve();
}
