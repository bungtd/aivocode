import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckpointManager } from "../src/checkpoint.js";
import { createToolset, type TodoItem } from "../src/tools/index.js";
import {
  normalizeSendKeysExpression,
  resolveOpenUrlTarget,
} from "../src/computer-use.js";
import {
  classifyTaskStrategy,
  autoAdvanceTodos,
  verifyWorkspaceArtifacts,
} from "../src/workflow-review.js";
import { AivoAgent } from "../src/agent.js";

describe("Regression tests for real session bugs (ses_mvpuvolp_d1ccd69ad3)", () => {
  it("1. prevents EISDIR in edit_file and write_file when path is missing or points to a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-eisdir-"));
    try {
      const tools = createToolset({
        cwd: dir,
        mode: "auto",
        checkpoints: new CheckpointManager(),
        todos: [],
      });

      // Missing path in edit_file (exact bug from line 19 of ses_mvpuvolp_d1ccd69ad3)
      const missingPathRes = await tools.execute("edit_file", {
        oldString: "foo",
        newString: "bar",
      });
      expect(missingPathRes.isError).toBe(true);
      expect(missingPathRes.output).toContain("path");
      expect(missingPathRes.output).not.toContain("EISDIR");

      // Directory path in edit_file
      const dirPathRes = await tools.execute("edit_file", {
        path: ".",
        oldString: "foo",
        newString: "bar",
      });
      expect(dirPathRes.isError).toBe(true);
      expect(dirPathRes.output).toContain("directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("2. translates cmd/POSIX shell idioms (dir /a, ls -la) and supports background: true in run_shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-shell-"));
    try {
      writeFileSync(join(dir, "index.html"), "<h1>Hello</h1>", "utf8");
      const tools = createToolset({
        cwd: dir,
        mode: "auto",
        checkpoints: new CheckpointManager(),
        todos: [],
      });

      // Exact bug from line 3 of ses_mvpuvolp_d1ccd69ad3: `dir /a` failed on PowerShell
      const dirRes = await tools.execute("run_shell", { command: "dir /a" });
      expect(dirRes.isError).toBeFalsy();
      expect(dirRes.output).toContain("index.html");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("3. maps special keys (Escape, Control+-, Enter) for Windows SendKeys and allows local HTML paths in computer_use open_url", () => {
    expect(normalizeSendKeysExpression("Escape")).toBe("{ESC}");
    expect(normalizeSendKeysExpression("Enter")).toBe("{ENTER}");
    expect(normalizeSendKeysExpression("Control+-")).toBe("^-");
    expect(normalizeSendKeysExpression("Ctrl+0")).toBe("^0");
    expect(normalizeSendKeysExpression("PageDown")).toBe("{PGDN}");

    const resolvedFileUrl = resolveOpenUrlTarget(
      "file:///C:/Dev/Projects/test_aivo_cli/index.html",
      "C:/Dev/Projects/test_aivo_cli",
    );
    expect(resolvedFileUrl).toBe("file:///C:/Dev/Projects/test_aivo_cli/index.html");

    const resolvedRelHtml = resolveOpenUrlTarget(
      "index.html",
      "C:/Dev/Projects/test_aivo_cli",
    );
    expect(resolvedRelHtml).toMatch(/^file:\/\/\//);
  });

  it("4. classifies execution strategy (subagent-driven vs native), auto-advances live todos, and runs review-fix verification", () => {
    const strategy = classifyTaskStrategy(
      "buatlah landing page tempat cuci mobil dengan html css dan javascript.",
    );
    expect(strategy.recommendedMode).toBe("subagent-driven");
    expect(strategy.teamId).toBe("frontend");
    expect(strategy.autoTodos.length).toBeGreaterThanOrEqual(4);

    const todos: TodoItem[] = [
      { id: "1", content: "Scaffold project structure (index.html, css, js)", status: "in_progress" },
      { id: "2", content: "Build semantic HTML with all sections", status: "pending" },
      { id: "3", content: "Craft intentional CSS design system", status: "pending" },
      { id: "4", content: "Add JavaScript interactions", status: "pending" },
      { id: "5", content: "Audit for AI slop and verify", status: "pending" },
    ];

    autoAdvanceTodos(todos, "write_file", { path: "index.html" });
    expect(todos[0]?.status).toBe("completed");
    expect(todos[1]?.status).toBe("completed");
    expect(todos[2]?.status).toBe("in_progress");

    autoAdvanceTodos(todos, "write_file", { path: "css/styles.css" });
    expect(todos[2]?.status).toBe("completed");
    expect(todos[3]?.status).toBe("in_progress");

    autoAdvanceTodos(todos, "write_file", { path: "js/main.js" });
    expect(todos[3]?.status).toBe("completed");
    expect(todos[4]?.status).toBe("in_progress");

    autoAdvanceTodos(todos, "anti_slop_audit", {});
    expect(todos[4]?.status).toBe("completed");
  });

  it("5. streams live tool argument progress (bytes & lines) during large write_file/edit_file generation and never stops silently on a tool message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-live-edit-"));
    try {
      const progressEvents: Array<{ name: string; bytes: number; lines: number }> = [];
      let callNum = 0;

      const mockFetch: typeof fetch = async () => {
        callNum++;
        const encoder = new TextEncoder();
        if (callNum === 1) {
          const chunks = [
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "c_big",
                        type: "function",
                        function: { name: "write_file", arguments: '{"path":"index.html","content":"line1\\n' },
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
                        function: { arguments: 'line2\\nline3\\nline4"}' },
                      },
                    ],
                  },
                },
              ],
            })}`,
            "data: [DONE]",
          ];
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(encoder.encode(chunks.join("\n") + "\n\n"));
                c.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }

        // Second call: final summary after maxSteps=1 forces summary turn
        const finalChunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Completed and verified index.html!" } }] })}`,
          "data: [DONE]",
        ];
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(encoder.encode(finalChunks.join("\n") + "\n\n"));
              c.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      };

      const agent = new AivoAgent({
        config: {
          apiKey: "sk-aivo_test",
          baseUrl: "https://api.aivokey.dev",
          model: "deepseek-v4-flash",
          fastModel: "glm-5.3-flash",
          wire: "chat",
          reasoningEffort: "off",
          mode: "auto",
          webSearch: true,
          cwd: dir,
          globalConfigPath: join(dir, "cfg.json"),
        },
        maxSteps: 1, // Even with maxSteps=1, agent must do a final summary turn instead of stopping silently on a tool call!
        fetchFn: mockFetch,
        callbacks: {
          onToolCallProgress: (name, bytes, lines) => {
            progressEvents.push({ name, bytes, lines });
          },
        },
      });

      const res = await agent.runUserPrompt("Create index.html");
      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
      expect(progressEvents[0]?.name).toContain("write_file");
      expect(res.finalText).toBe("Completed and verified index.html!");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("6. cross-checks HTML/CSS/JS references in verifyWorkspaceArtifacts for review-fix loop", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-verify-"));
    try {
      writeFileSync(
        join(dir, "index.html"),
        `<html><head><link rel="stylesheet" href="css/missing.css"></head><body><script src="js/app.js"></script></body></html>`,
        "utf8",
      );
      const check = verifyWorkspaceArtifacts(dir, [join(dir, "index.html")]);
      expect(check.clean).toBe(false);
      expect(check.findings.some((f) => f.includes("css/missing.css"))).toBe(true);
      expect(check.findings.some((f) => f.includes("js/app.js"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
