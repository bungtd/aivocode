import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AivoAgent } from "../src/agent.js";
import type { AivoConfig } from "../src/config.js";

function sseChatResponse(chunks: Array<Record<string, unknown>>): Response {
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}`);
  lines.push("data: [DONE]");
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(encoder.encode(lines.join("\n") + "\n\n"));
      ctrl.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-air-request-id": "req_ag_1" },
  });
}

describe("AivoAgent multi-turn tool loop, subagent routing, and auto-recovery", () => {
  it("executes multi-turn tool calls, delegates explore subagent to fastModel, and tracks checkpoints", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-agent-"));
    try {
      writeFileSync(join(dir, "app.ts"), "export const version = 1;\n", "utf8");

      const modelsAsked: string[] = [];
      let callCount = 0;

      const mockFetch: typeof fetch = async (_input, init) => {
        callCount++;
        const reqBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        modelsAsked.push(String(reqBody.model));

        if (callCount === 1) {
          // Parent calls explore subagent
          return sseChatResponse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_sub_1",
                        type: "function",
                        function: {
                          name: "subagent",
                          arguments: JSON.stringify({
                            agent: "explore",
                            description: "Check version in app.ts",
                            prompt: "Read app.ts and report version",
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            },
            { choices: [], usage: { prompt_tokens: 500, completion_tokens: 40 } },
          ]);
        }

        if (callCount === 2) {
          // Subagent runs on fastModel ("glm-5.3") and finishes
          return sseChatResponse([
            {
              choices: [{ delta: { content: "app.ts has version = 1" } }],
            },
            { choices: [], usage: { prompt_tokens: 200, completion_tokens: 20 } },
          ]);
        }

        if (callCount === 3) {
          // Parent edits app.ts
          return sseChatResponse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_edit_1",
                        type: "function",
                        function: {
                          name: "edit_file",
                          arguments: JSON.stringify({
                            path: "app.ts",
                            oldString: "export const version = 1;",
                            newString: "export const version = 2;",
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            },
            { choices: [], usage: { prompt_tokens: 600, completion_tokens: 35 } },
          ]);
        }

        return sseChatResponse([
          { choices: [{ delta: { content: "Updated version to 2." } }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 700,
              completion_tokens: 15,
              prompt_tokens_details: { cached_tokens: 500 },
            },
          },
        ]);
      };

      const cfg: AivoConfig = {
        apiKey: "sk-aivo_test",
        baseUrl: "https://api.aivokey.dev",
        model: "deepseek-v4-pro",
        fastModel: "glm-5.3",
        wire: "chat",
        reasoningEffort: "high",
        mode: "auto",
        webSearch: false,
        cwd: dir,
        globalConfigPath: join(dir, "config.json"),
      };

      const agent = new AivoAgent({
        config: cfg,
        fetchFn: mockFetch,
      });

      const res = await agent.runUserPrompt("Upgrade version in app.ts to 2");
      expect(res.finalText).toBe("Updated version to 2.");
      expect(readFileSync(join(dir, "app.ts"), "utf8")).toBe("export const version = 2;\n");
      // Call 1: deepseek-v4-pro, Call 2 (explore subagent): glm-5.3, Call 3 & 4: deepseek-v4-pro
      expect(modelsAsked).toEqual([
        "deepseek-v4-pro",
        "glm-5.3",
        "deepseek-v4-pro",
        "deepseek-v4-pro",
      ]);

      // Verify undo works via agent checkpoints
      const undo = agent.checkpoints.undoLastTurn();
      expect(undo.restoredFiles).toHaveLength(1);
      expect(readFileSync(join(dir, "app.ts"), "utf8")).toBe("export const version = 1;\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-compacts and retries on 400 context_length_exceeded, and waits on 429 rate_limited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-recover-"));
    try {
      let attempt = 0;
      const sleptMs: number[] = [];

      const mockFetch: typeof fetch = async () => {
        attempt++;
        if (attempt === 1) {
          return new Response(
            JSON.stringify({
              error: {
                message: "Prompt exceeds context window",
                type: "invalid_request_error",
                code: "context_length_exceeded",
              },
            }),
            { status: 400, headers: { "x-air-request-id": "req_ctx_err" } },
          );
        }
        if (attempt === 2) {
          return new Response(
            JSON.stringify({
              error: {
                message: "Rate limit reached",
                type: "rate_limit_error",
                code: "rate_limited",
              },
            }),
            { status: 429, headers: { "retry-after": "2", "x-air-request-id": "req_rl_err" } },
          );
        }
        return sseChatResponse([
          { choices: [{ delta: { content: "Recovered and completed!" } }] },
          { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
        ]);
      };

      const cfg: AivoConfig = {
        apiKey: "sk-aivo_test",
        baseUrl: "https://api.aivokey.dev",
        model: "deepseek-v4-pro",
        fastModel: null,
        wire: "chat",
        reasoningEffort: "medium",
        mode: "auto",
        webSearch: false,
        cwd: dir,
        globalConfigPath: join(dir, "config.json"),
      };

      const agent = new AivoAgent({
        config: cfg,
        fetchFn: mockFetch,
        sleepFn: async (ms) => {
          sleptMs.push(ms);
        },
      });

      const res = await agent.runUserPrompt("Hello after recovery");
      expect(res.finalText).toBe("Recovered and completed!");
      expect(attempt).toBe(3);
      expect(sleptMs).toEqual([2000]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
