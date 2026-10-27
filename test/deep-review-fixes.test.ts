import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  wrapTranscriptLines,
  renderFullScreenViewport,
  extractLastCodeBlock,
  extractPaneScopedSelection,
  splitMouseAndKeyboardBytes,
} from "../src/ui/fullscreen.js";
import { renderTerminalMarkdown } from "../src/ui/markdown.js";
import { c, stripAnsi } from "../src/ui/theme.js";
import { CheckpointManager } from "../src/checkpoint.js";
import { createToolset } from "../src/tools/index.js";
import { streamTurn, type ChatMessage } from "../src/protocol.js";
import { AivoAgent, sanitizeDanglingToolCalls } from "../src/agent.js";
import { SessionStore } from "../src/session.js";

describe("Deep Review Round 1 Fixes", () => {
  it("1. wraps long ANSI-styled markdown lines across multiple rows instead of truncating with ellipsis", () => {
    const longStyledLine = `${c.bold("Important:")} This is a very long ANSI-styled explanation about ${c.cyan("src/ui/fullscreen.ts")} that must wrap across multiple lines without losing the tail end of the sentence.`;
    const wrapped = wrapTranscriptLines([longStyledLine], 50);

    expect(wrapped.length).toBeGreaterThan(2);
    const reconstructed = wrapped.map((l) => stripAnsi(l).trim()).join(" ");
    expect(reconstructed).toContain("without losing the tail end of the sentence.");
    expect(reconstructed).not.toContain("…");
  });

  it("2. applies multi-hunk apply_patch with context lines and pure insertions, and returns a unified diff", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-patch-hunk-"));
    try {
      const target = join(dir, "service.ts");
      writeFileSync(
        target,
        [
          "export function alpha() {",
          "  return 1;",
          "}",
          "",
          "export function beta() {",
          "  return 2;",
          "}",
        ].join("\n") + "\n",
        "utf8",
      );

      const tools = createToolset({
        cwd: dir,
        mode: "auto",
        checkpoints: new CheckpointManager(),
        todos: [],
      });

      const patchRes = await tools.execute("apply_patch", {
        patchText: [
          "*** Update File: service.ts",
          "@@",
          " export function alpha() {",
          "-  return 1;",
          "+  return 10;",
          " }",
          "@@",
          " export function beta() {",
          "+  const bonus = 5;",
          "   return 2;",
          " }",
        ].join("\n"),
      });

      expect(patchRes.isError).toBeFalsy();
      expect(patchRes.diff).toBeDefined();
      const updated = readFileSync(target, "utf8");
      expect(updated).toContain("return 10;");
      expect(updated).toContain("const bonus = 5;");
      expect(updated).toContain("return 2;");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("3. shares CheckpointManager with child subagents/workflows, rolls up token usage, and prevents ephemeral child session spam", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-child-chk-"));
    try {
      const store = new SessionStore(join(dir, "sessions"));
      let callCount = 0;

      const mockFetch: typeof fetch = async () => {
        callCount++;
        const encoder = new TextEncoder();
        // Call 1: parent spawns general subagent
        if (callCount === 1) {
          const lines = [
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "tc_sub",
                        type: "function",
                        function: {
                          name: "subagent",
                          arguments: JSON.stringify({
                            agent: "general",
                            description: "Create helper.ts",
                            prompt: "Write helper.ts",
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            })}`,
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}`,
            "data: [DONE]",
          ];
          return new Response(
            new ReadableStream({
              start(ctrl) {
                ctrl.enqueue(encoder.encode(lines.join("\n") + "\n\n"));
                ctrl.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }

        // Call 2: child subagent writes helper.ts
        if (callCount === 2) {
          const lines = [
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "tc_write",
                        type: "function",
                        function: {
                          name: "write_file",
                          arguments: JSON.stringify({
                            path: "helper.ts",
                            content: "export const ok = true;\n",
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            })}`,
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 150, completion_tokens: 30 } })}`,
            "data: [DONE]",
          ];
          return new Response(
            new ReadableStream({
              start(ctrl) {
                ctrl.enqueue(encoder.encode(lines.join("\n") + "\n\n"));
                ctrl.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }

        // Call 3 (child finishes) & Call 4+ (parent finishes / review pass)
        const lines = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "VERDICT: PASS\nDone!" } }] })}`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 15 } })}`,
          "data: [DONE]",
        ];
        return new Response(
          new ReadableStream({
            start(ctrl) {
              ctrl.enqueue(encoder.encode(lines.join("\n") + "\n\n"));
              ctrl.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      };

      const agent = new AivoAgent({
        config: {
          apiKey: "sk-aivo_test",
          baseUrl: "https://api.aivokey.dev",
          model: "deepseek-v4.1-flash",
          fastModel: "deepseek-v4.1-flash",
          wire: "chat",
          reasoningEffort: "off",
          mode: "auto",
          webSearch: true,
          cwd: dir,
          globalConfigPath: join(dir, "cfg.json"),
        },
        sessionStore: store,
        fetchFn: mockFetch,
      });

      const res = await agent.runUserPrompt("Delegate writing helper.ts");
      // Parent checkpoints must include helper.ts written by the child subagent!
      expect(agent.checkpoints.listModifiedFiles().some((f) => f.endsWith("helper.ts"))).toBe(true);
      // Token usage must include child subagent's 150+120 prompt tokens!
      expect(res.turnUsage.inputTokens).toBeGreaterThanOrEqual(370);
      // Session store must only have 1 saved session (parent), not polluted by child subagents!
      expect(store.listSessions()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("4. merges consecutive user messages on Anthropic wire and sanitizes dangling interrupted toolCalls", async () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "Starting tool",
        toolCalls: [{ id: "dangling_1", name: "read_file", arguments: { path: "a.ts" }, rawArguments: "{}" }],
      },
      // No tool result because user pressed Esc!
      { role: "user", content: "[Compacted Session Summary]\nEarlier summary" },
      { role: "user", content: "Next user question" },
    ];

    sanitizeDanglingToolCalls(messages);
    // Dangling tool call now has a synthetic tool result right after it
    expect(messages[1]?.role).toBe("tool");
    expect(messages[1]?.toolCallId).toBe("dangling_1");

    let capturedAnthropicBody: Record<string, unknown> | null = null;
    const mockFetch: typeof fetch = async (_input, init) => {
      capturedAnthropicBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    await streamTurn({
      baseUrl: "https://api.aivokey.dev",
      apiKey: "sk-aivo_key",
      sessionId: "ses_merge_test",
      wire: "messages",
      model: "claude-sonnet-5-5",
      systemPrompt: "Sys",
      messages: [
        { role: "user", content: "[Compacted Session Summary]" },
        { role: "user", content: "Follow-up question" },
      ],
      tools: [],
      fetchFn: mockFetch,
    });

    const sentMsgs = capturedAnthropicBody!.messages as Array<{ role: string }>;
    // Consecutive user messages must be merged into a single user message so roles strictly alternate
    expect(sentMsgs).toHaveLength(1);
    expect(sentMsgs[0]?.role).toBe("user");
  });

  it("5. emits onToolCallProgress on OpenAI /v1/responses wire during function_call_arguments.delta", async () => {
    const progressCalls: number[] = [];
    const encoder = new TextEncoder();
    const mockFetch: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            const events = [
              `data: ${JSON.stringify({
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "function_call", call_id: "fc_1", name: "write_file" },
              })}`,
              `data: ${JSON.stringify({
                type: "response.function_call_arguments.delta",
                output_index: 0,
                delta: '{"path":"a.ts","content":"line1\\nline2"}',
              })}`,
              `data: ${JSON.stringify({
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  call_id: "fc_1",
                  name: "write_file",
                  arguments: '{"path":"a.ts","content":"line1\\nline2"}',
                },
              })}`,
              "data: [DONE]",
            ];
            c.enqueue(encoder.encode(events.join("\n") + "\n\n"));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    await streamTurn({
      baseUrl: "https://api.aivokey.dev",
      apiKey: "sk-aivo_key",
      sessionId: "ses_resp_prog",
      wire: "responses",
      model: "gpt-6.1-sol",
      systemPrompt: "Sys",
      messages: [{ role: "user", content: "Write a.ts" }],
      tools: [],
      fetchFn: mockFetch,
      onToolCallProgress: (_name, bytes) => {
        progressCalls.push(bytes);
      },
    });

    expect(progressCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("6. renders full-width clean-copyable transcript, code blocks, and input line with zero sidebar │ or border │ pollution", () => {
    const md = renderTerminalMarkdown("Here is code:\n```ts\nconst x = 1;\nconsole.log(x);\n```");
    const plainMd = stripAnsi(md);
    // Code lines inside fenced block must NOT have │ prefix so mouse copy-paste is valid code
    for (const line of plainMd.split("\n")) {
      if (line.includes("const x = 1;") || line.includes("console.log(x);")) {
        expect(line.trimStart().startsWith("│")).toBe(false);
      }
    }

    expect(extractLastCodeBlock("Text\n```js\nalert(1);\n```\nDone")).toBe("alert(1);");

    const viewport = stripAnsi(
      renderFullScreenViewport({
        cols: 100,
        rows: 20,
        showSidebar: false,
        version: "1.2.0",
        cwd: "C:/Dev/Projects/app",
        gitBranch: "main",
        gatewayUrl: "https://api.aivokey.dev",
        model: "deepseek-v4.1-flash",
        fastModel: "deepseek-v4.1-flash",
        wire: "chat",
        effort: "off",
        mode: "auto",
        sessionId: "ses_copy_clean",
        usedContextTokens: 500,
        maxContextTokens: 1_000_000,
        cacheHitPct: 90,
        sessionCostMicro: 1000n,
        balanceMicro: 5_000_000n,
        keyStatus: null,
        todos: [],
        modifiedFiles: [],
        transcriptLines: ["◆ deepseek-v4.1-flash", "  Halo, ini jawaban bersih untuk dicopy."],
        scrollOffset: 0,
        busyLabel: null,
        buffer: "ketikan input saya",
        cursorPos: 18,
        suggestions: { kind: "none", query: "", items: [] },
        selectedSuggestionIdx: 0,
        modal: null,
        notice: null,
      }),
    );

    const vLines = viewport.split("\n");
    const answerLine = vLines.find((l) => l.includes("Halo, ini jawaban bersih untuk dicopy."))!;
    expect(answerLine).toBeDefined();
    // Must not contain any sidebar │ separator or trailing 50-space padding
    expect(answerLine).not.toContain("│");
    expect(answerLine.endsWith("   ")).toBe(false);

    const inputLine = vLines.find((l) => l.includes("ketikan input saya"))!;
    expect(inputLine).toBeDefined();
    // Input line must not have │ box walls around it
    expect(inputLine).not.toContain("│");
    expect(inputLine.endsWith("   ")).toBe(false);
  });

  it("7. OpenTUI-style pane-scoped mouse selection: keeps sidebar visible while selecting ONLY left-pane text and filtering mouse bytes before readline", () => {
    const rawChunk = Buffer.from("a\x1b[<0;5;3M\x1b[<32;20;4M\x1b[<0;20;4mb");
    const split = splitMouseAndKeyboardBytes(rawChunk);
    expect(split.keyboardText).toBe("ab");
    expect(split.mouseEvents).toEqual([
      { type: "down", x: 5, y: 3 },
      { type: "drag", x: 20, y: 4 },
      { type: "up", x: 20, y: 4 },
    ]);

    const leftPaneLines = [
      "❯ halo",
      "◆ deepseek-v4.1-flash",
      "  Baris pertama jawaban agen.",
      "  Baris kedua jawaban agen.",
    ];
    const copied = extractPaneScopedSelection(leftPaneLines, {
      startRow: 2,
      startCol: 2,
      endRow: 3,
      endCol: 27,
    });
    expect(copied).toBe("Baris pertama jawaban agen.\nBaris kedua jawaban agen.");
    expect(copied).not.toContain("Cache");
    expect(copied).not.toContain("│");
  });
});
