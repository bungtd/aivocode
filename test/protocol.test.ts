import { describe, expect, it } from "vitest";
import { streamTurn, type ChatMessage, type ToolSpec } from "../src/protocol.js";

function sseResponse(lines: string[], headers: Record<string, string> = {}): Response {
  const payload = lines.join("\n") + "\n\n";
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "x-air-request-id": "req_stream_123",
      "x-air-model": "deepseek-v4-pro",
      ...headers,
    },
  });
}

const SAMPLE_TOOLS: ToolSpec[] = [
  {
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

describe("Multi-wire AivoKey protocol engine (chat, messages, responses)", () => {
  it("streams /v1/chat/completions with sticky session headers, reasoning deltas, tool calls, and cache usage", async () => {
    let capturedHeaders: Headers | null = null;
    let capturedBody: Record<string, unknown> | null = null;

    const mockFetch: typeof fetch = async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Thinking about src/index.ts... " } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Let me read the file." } }] })}`,
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "read_file", arguments: '{"path":' },
                  },
                ],
              },
            },
          ],
        })}`,
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '"src/index.ts"}' },
                  },
                ],
              },
            },
          ],
        })}`,
        `data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 85,
            prompt_tokens_details: {
              cached_tokens: 900,
              cache_creation_input_tokens: 100,
            },
          },
        })}`,
        "data: [DONE]",
      ]);
    };

    const reasoningDeltas: string[] = [];
    const textDeltas: string[] = [];

    const messages: ChatMessage[] = [{ role: "user", content: "Inspect src/index.ts" }];
    const result = await streamTurn({
      baseUrl: "https://api.aivokey.dev",
      apiKey: "sk-aivo_key",
      sessionId: "ses_sticky_01",
      wire: "chat",
      model: "deepseek-v4-pro",
      systemPrompt: "You are AivoCode.",
      messages,
      tools: SAMPLE_TOOLS,
      reasoningEffort: "high",
      fetchFn: mockFetch,
      onReasoningDelta: (d) => reasoningDeltas.push(d),
      onTextDelta: (d) => textDeltas.push(d),
    });

    expect(capturedHeaders!.get("x-opencode-session")).toBe("ses_sticky_01");
    expect(capturedHeaders!.get("x-claude-code-session-id")).toBe("ses_sticky_01");
    expect(capturedBody!.prompt_cache_key).toBe("ses_sticky_01");
    expect(capturedBody!.reasoning).toEqual({ effort: "high" });

    expect(reasoningDeltas.join("")).toBe("Thinking about src/index.ts... ");
    expect(textDeltas.join("")).toBe("Let me read the file.");
    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        name: "read_file",
        arguments: { path: "src/index.ts" },
        rawArguments: '{"path":"src/index.ts"}',
      },
    ]);
    // 1200 prompt_tokens total with 900 cached_tokens => 300 uncached inputTokens, 900 cacheReadTokens
    expect(result.usage.inputTokens).toBe(300);
    expect(result.usage.cacheReadTokens).toBe(900);
    expect(result.usage.cacheWriteTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(85);
    expect(result.requestId).toBe("req_stream_123");
  });

  it("streams /v1/messages (Anthropic wire) with cache_control, thinking, tool_use, and client-side tools only (no server web_search)", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    const mockFetch: typeof fetch = async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        "event: message_start",
        `data: ${JSON.stringify({
          type: "message_start",
          message: {
            usage: {
              input_tokens: 250,
              cache_read_input_tokens: 1500,
              cache_creation_input_tokens: 0,
            },
          },
        })}`,
        "event: content_block_start",
        `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}`,
        "event: content_block_delta",
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Deep thought..." } })}`,
        "event: content_block_start",
        `data: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })}`,
        "event: content_block_delta",
        `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Checking file." } })}`,
        "event: content_block_start",
        `data: ${JSON.stringify({
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
        })}`,
        "event: content_block_delta",
        `data: ${JSON.stringify({
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' },
        })}`,
        "event: message_delta",
        `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 60 } })}`,
        "event: message_stop",
        `data: ${JSON.stringify({ type: "message_stop" })}`,
      ]);
    };

    const result = await streamTurn({
      baseUrl: "https://api.aivokey.dev",
      apiKey: "sk-aivo_key",
      sessionId: "ses_anth_01",
      wire: "messages",
      model: "claude-sonnet-4.5",
      systemPrompt: "You are AivoCode.",
      messages: [{ role: "user", content: "Read README.md" }],
      tools: SAMPLE_TOOLS,
      reasoningEffort: "medium",
      fetchFn: mockFetch,
    });

    const toolsSent = capturedBody!.tools as Array<Record<string, unknown>>;
    // Must NEVER inject AivoKey server-side web_search_20250305
    expect(toolsSent.some((t) => t.type === "web_search_20250305")).toBe(false);
    expect(result.reasoning).toBe("Deep thought...");
    expect(result.text).toBe("Checking file.");
    expect(result.toolCalls).toEqual([
      {
        id: "toolu_1",
        name: "read_file",
        arguments: { path: "README.md" },
        rawArguments: '{"path":"README.md"}',
      },
    ]);
    expect(result.usage.inputTokens).toBe(250);
    expect(result.usage.cacheReadTokens).toBe(1500);
    expect(result.usage.outputTokens).toBe(60);
  });

  it("streams /v1/responses (OpenAI Responses wire) with reasoning summary and function calls (no hosted server web_search)", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    const mockFetch: typeof fetch = async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        `data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "Planning step..." })}`,
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Reading package.json" })}`,
        `data: ${JSON.stringify({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "fc_99",
            name: "read_file",
            arguments: '{"path":"package.json"}',
          },
        })}`,
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 800,
              output_tokens: 45,
              input_tokens_details: { cached_tokens: 600 },
            },
          },
        })}`,
      ]);
    };

    const result = await streamTurn({
      baseUrl: "https://api.aivokey.dev",
      apiKey: "sk-aivo_key",
      sessionId: "ses_resp_01",
      wire: "responses",
      model: "gpt-5.5",
      systemPrompt: "You are AivoCode.",
      messages: [{ role: "user", content: "Check package.json" }],
      tools: SAMPLE_TOOLS,
      reasoningEffort: "xhigh",
      fetchFn: mockFetch,
    });

    const toolsSent = capturedBody!.tools as Array<Record<string, unknown>>;
    expect(toolsSent.some((t) => t.type === "web_search")).toBe(false);
    expect(result.reasoning).toBe("Planning step...");
    expect(result.text).toBe("Reading package.json");
    expect(result.toolCalls).toEqual([
      {
        id: "fc_99",
        name: "read_file",
        arguments: { path: "package.json" },
        rawArguments: '{"path":"package.json"}',
      },
    ]);
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.cacheReadTokens).toBe(600);
    expect(result.usage.outputTokens).toBe(45);
  });
});
