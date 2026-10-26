import { endpointUrl, type AivoWire, type ReasoningEffort } from "./config.js";
import type { TurnUsageMetrics } from "./aivokey-client.js";
import { parseAivoErrorResponse } from "./errors.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface StreamTurnOptions {
  baseUrl: string;
  apiKey: string;
  sessionId: string;
  wire: AivoWire;
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
  webSearch?: boolean;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onToolCallStart?: (id: string, name: string) => void;
}

export interface StreamTurnResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: TurnUsageMetrics;
  requestId: string | null;
  resolvedModel: string | null;
}

function safeParseJsonObj(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function* iterateSseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
        buffer = buffer.slice(newlineIdx + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload) yield payload;
        }
      }
    }
    const remaining = buffer.trim();
    if (remaining.startsWith("data:")) {
      const payload = remaining.slice(5).trim();
      if (payload) yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

function stickyHeaders(apiKey: string, sessionId: string, wire: AivoWire): Record<string, string> {
  const base: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "x-opencode-session": sessionId,
    "x-opencode-session-id": sessionId,
    "x-session-id": sessionId,
    "x-claude-code-session-id": sessionId,
  };
  if (wire === "messages") {
    base["x-api-key"] = apiKey;
    base["anthropic-version"] = "2023-06-01";
  } else {
    base.authorization = `Bearer ${apiKey}`;
  }
  return base;
}

function buildChatCompletionsBody(opts: StreamTurnOptions): Record<string, unknown> {
  const apiMessages: Array<Record<string, unknown>> = [
    { role: "system", content: opts.systemPrompt },
  ];

  for (const m of opts.messages) {
    if (m.role === "user") {
      apiMessages.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const msg: Record<string, unknown> = {
        role: "assistant",
        content: m.content || null,
      };
      if (m.reasoning) {
        msg.reasoning_content = m.reasoning;
      }
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: tc.rawArguments || JSON.stringify(tc.arguments),
          },
        }));
      }
      apiMessages.push(msg);
    } else if (m.role === "tool") {
      apiMessages.push({
        role: "tool",
        tool_call_id: m.toolCallId ?? "call_0",
        content: m.content,
      });
    }
  }

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: apiMessages,
    stream: true,
    stream_options: { include_usage: true },
    prompt_cache_key: opts.sessionId,
    session_id: opts.sessionId,
  };

  if (opts.maxTokens && opts.maxTokens > 0) {
    body.max_tokens = opts.maxTokens;
  }

  if (opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  if (opts.reasoningEffort && opts.reasoningEffort !== "off") {
    body.reasoning = { effort: opts.reasoningEffort };
  }

  return body;
}

function buildAnthropicMessagesBody(opts: StreamTurnOptions): Record<string, unknown> {
  const anthropicMessages: Array<Record<string, unknown>> = [];

  for (const m of opts.messages) {
    if (m.role === "user") {
      anthropicMessages.push({
        role: "user",
        content: [{ type: "text", text: m.content }],
      });
    } else if (m.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      if (m.content) {
        blocks.push({ type: "text", text: m.content });
      }
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
      }
      if (blocks.length > 0) {
        anthropicMessages.push({ role: "assistant", content: blocks });
      }
    } else if (m.role === "tool") {
      const last = anthropicMessages[anthropicMessages.length - 1];
      const toolResultBlock = {
        type: "tool_result",
        tool_use_id: m.toolCallId ?? "toolu_0",
        content: m.content,
        ...(m.isError ? { is_error: true } : {}),
      };
      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as Array<Record<string, unknown>>).push(toolResultBlock);
      } else {
        anthropicMessages.push({
          role: "user",
          content: [toolResultBlock],
        });
      }
    }
  }

  // Add ephemeral cache_control breakpoint to the last message block for prompt cache hits
  if (anthropicMessages.length > 0) {
    const lastMsg = anthropicMessages[anthropicMessages.length - 1]!;
    if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
      const lastBlock = lastMsg.content[lastMsg.content.length - 1] as Record<string, unknown>;
      lastBlock.cache_control = { type: "ephemeral" };
    }
  }

  const tools: Array<Record<string, unknown>> = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  if (opts.webSearch) {
    tools.push(
      { type: "web_search_20250305", name: "web_search", max_uses: 5 },
      { type: "web_fetch_20250910", name: "web_fetch", max_uses: 5 },
    );
  }

  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 8192,
    system: [
      {
        type: "text",
        text: opts.systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: anthropicMessages,
    stream: true,
    session_id: opts.sessionId,
  };

  if (tools.length > 0) {
    body.tools = tools;
  }

  if (opts.reasoningEffort && opts.reasoningEffort !== "off") {
    body.reasoning = { effort: opts.reasoningEffort };
  }

  return body;
}

function buildResponsesBody(opts: StreamTurnOptions): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];

  for (const m of opts.messages) {
    if (m.role === "user") {
      input.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.content) {
        input.push({ role: "assistant", content: m.content });
      }
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.name,
            arguments: tc.rawArguments || JSON.stringify(tc.arguments),
          });
        }
      }
    } else if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.toolCallId ?? "fc_0",
        output: m.content,
      });
    }
  }

  const tools: Array<Record<string, unknown>> = opts.tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  if (opts.webSearch) {
    tools.push({ type: "web_search" });
  }

  const body: Record<string, unknown> = {
    model: opts.model,
    instructions: opts.systemPrompt,
    input,
    stream: true,
    prompt_cache_key: opts.sessionId,
    session_id: opts.sessionId,
  };

  if (opts.maxTokens && opts.maxTokens > 0) {
    body.max_output_tokens = opts.maxTokens;
  }
  if (tools.length > 0) {
    body.tools = tools;
  }
  if (opts.reasoningEffort && opts.reasoningEffort !== "off") {
    body.reasoning = { effort: opts.reasoningEffort };
  }

  return body;
}

export async function streamTurn(opts: StreamTurnOptions): Promise<StreamTurnResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const url = endpointUrl(opts.baseUrl, opts.wire);
  const headers = stickyHeaders(opts.apiKey, opts.sessionId, opts.wire);

  const body =
    opts.wire === "messages"
      ? buildAnthropicMessagesBody(opts)
      : opts.wire === "responses"
        ? buildResponsesBody(opts)
        : buildChatCompletionsBody(opts);

  const res = await fetchFn(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    throw await parseAivoErrorResponse(res);
  }

  const requestId = res.headers.get("x-air-request-id");
  const resolvedModel = res.headers.get("x-air-model");

  if (!res.body) {
    return {
      text: "",
      reasoning: "",
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      requestId,
      resolvedModel,
    };
  }

  let text = "";
  let reasoning = "";
  const usage: TurnUsageMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  if (opts.wire === "chat") {
    const toolMap = new Map<number, { id: string; name: string; args: string }>();

    for await (const data of iterateSseData(res.body)) {
      if (data === "[DONE]") break;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }

      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      for (const ch of choices) {
        const delta =
          typeof ch === "object" && ch !== null
            ? ((ch as Record<string, unknown>).delta as Record<string, unknown> | undefined)
            : undefined;
        if (!delta) continue;

        const rDelta =
          typeof delta.reasoning_content === "string"
            ? delta.reasoning_content
            : typeof delta.reasoning === "string"
              ? delta.reasoning
              : "";
        if (rDelta) {
          reasoning += rDelta;
          opts.onReasoningDelta?.(rDelta);
        }

        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          opts.onTextDelta?.(delta.content);
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const rawTc of delta.tool_calls) {
            if (typeof rawTc !== "object" || rawTc === null) continue;
            const tc = rawTc as Record<string, unknown>;
            const idx = typeof tc.index === "number" ? tc.index : 0;
            let entry = toolMap.get(idx);
            if (!entry) {
              entry = { id: `call_${idx}`, name: "", args: "" };
              toolMap.set(idx, entry);
            }
            if (typeof tc.id === "string" && tc.id) entry.id = tc.id;
            const fn =
              typeof tc.function === "object" && tc.function !== null
                ? (tc.function as Record<string, unknown>)
                : undefined;
            if (fn) {
              if (typeof fn.name === "string" && fn.name) {
                entry.name += fn.name;
                opts.onToolCallStart?.(entry.id, entry.name);
              }
              if (typeof fn.arguments === "string" && fn.arguments) {
                entry.args += fn.arguments;
              }
            }
          }
        }
      }

      if (typeof chunk.usage === "object" && chunk.usage !== null) {
        const u = chunk.usage as Record<string, unknown>;
        const promptTokens = typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0;
        const completionTokens = typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
        const details =
          typeof u.prompt_tokens_details === "object" && u.prompt_tokens_details !== null
            ? (u.prompt_tokens_details as Record<string, unknown>)
            : {};
        const cached = typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
        const cacheWrite =
          typeof details.cache_creation_input_tokens === "number"
            ? details.cache_creation_input_tokens
            : 0;
        usage.cacheReadTokens = cached;
        usage.cacheWriteTokens = cacheWrite;
        usage.inputTokens = Math.max(0, promptTokens - cached);
        usage.outputTokens = completionTokens;
      }
    }

    const toolCalls: ToolCall[] = [...toolMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id,
        name: v.name,
        arguments: safeParseJsonObj(v.args),
        rawArguments: v.args || "{}",
      }))
      .filter((tc) => tc.name.length > 0);

    return { text, reasoning, toolCalls, usage, requestId, resolvedModel };
  }

  if (opts.wire === "messages") {
    const blockTools = new Map<number, { id: string; name: string; args: string }>();

    for await (const data of iterateSseData(res.body)) {
      if (data === "[DONE]") break;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }

      const type = event.type;
      if (type === "message_start" && typeof event.message === "object" && event.message !== null) {
        const msg = event.message as Record<string, unknown>;
        const u =
          typeof msg.usage === "object" && msg.usage !== null
            ? (msg.usage as Record<string, unknown>)
            : {};
        if (typeof u.input_tokens === "number") usage.inputTokens = u.input_tokens;
        if (typeof u.cache_read_input_tokens === "number") {
          usage.cacheReadTokens = u.cache_read_input_tokens;
        }
        if (typeof u.cache_creation_input_tokens === "number") {
          usage.cacheWriteTokens = u.cache_creation_input_tokens;
        }
      } else if (type === "content_block_start") {
        const idx = typeof event.index === "number" ? event.index : 0;
        const cb =
          typeof event.content_block === "object" && event.content_block !== null
            ? (event.content_block as Record<string, unknown>)
            : {};
        if (cb.type === "tool_use") {
          const id = typeof cb.id === "string" ? cb.id : `toolu_${idx}`;
          const name = typeof cb.name === "string" ? cb.name : "";
          blockTools.set(idx, { id, name, args: "" });
          if (name) opts.onToolCallStart?.(id, name);
        }
      } else if (type === "content_block_delta") {
        const idx = typeof event.index === "number" ? event.index : 0;
        const delta =
          typeof event.delta === "object" && event.delta !== null
            ? (event.delta as Record<string, unknown>)
            : {};
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          reasoning += delta.thinking;
          opts.onReasoningDelta?.(delta.thinking);
        } else if (delta.type === "text_delta" && typeof delta.text === "string") {
          text += delta.text;
          opts.onTextDelta?.(delta.text);
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const entry = blockTools.get(idx);
          if (entry) entry.args += delta.partial_json;
        }
      } else if (type === "message_delta") {
        const u =
          typeof event.usage === "object" && event.usage !== null
            ? (event.usage as Record<string, unknown>)
            : {};
        if (typeof u.output_tokens === "number") usage.outputTokens = u.output_tokens;
      }
    }

    const toolCalls: ToolCall[] = [...blockTools.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id,
        name: v.name,
        arguments: safeParseJsonObj(v.args),
        rawArguments: v.args || "{}",
      }))
      .filter((tc) => tc.name.length > 0);

    return { text, reasoning, toolCalls, usage, requestId, resolvedModel };
  }

  // wire === "responses"
  const toolCalls: ToolCall[] = [];
  for await (const data of iterateSseData(res.body)) {
    if (data === "[DONE]") break;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = event.type;
    if (
      (type === "response.reasoning_summary_text.delta" || type === "response.reasoning.delta") &&
      typeof event.delta === "string"
    ) {
      reasoning += event.delta;
      opts.onReasoningDelta?.(event.delta);
    } else if (type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
      opts.onTextDelta?.(event.delta);
    } else if (
      type === "response.output_item.done" &&
      typeof event.item === "object" &&
      event.item !== null
    ) {
      const item = event.item as Record<string, unknown>;
      if (item.type === "function_call") {
        const id =
          typeof item.call_id === "string"
            ? item.call_id
            : typeof item.id === "string"
              ? item.id
              : `fc_${toolCalls.length}`;
        const name = typeof item.name === "string" ? item.name : "";
        const rawArgs = typeof item.arguments === "string" ? item.arguments : "{}";
        if (name) {
          opts.onToolCallStart?.(id, name);
          toolCalls.push({
            id,
            name,
            arguments: safeParseJsonObj(rawArgs),
            rawArguments: rawArgs,
          });
        }
      }
    } else if (
      type === "response.completed" &&
      typeof event.response === "object" &&
      event.response !== null
    ) {
      const resp = event.response as Record<string, unknown>;
      const u =
        typeof resp.usage === "object" && resp.usage !== null
          ? (resp.usage as Record<string, unknown>)
          : {};
      const inputTokens = typeof u.input_tokens === "number" ? u.input_tokens : 0;
      const outputTokens = typeof u.output_tokens === "number" ? u.output_tokens : 0;
      const details =
        typeof u.input_tokens_details === "object" && u.input_tokens_details !== null
          ? (u.input_tokens_details as Record<string, unknown>)
          : {};
      const cached = typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
      usage.cacheReadTokens = cached;
      usage.inputTokens = Math.max(0, inputTokens - cached);
      usage.outputTokens = outputTokens;
    }
  }

  return { text, reasoning, toolCalls, usage, requestId, resolvedModel };
}
