import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  expandFileMentions,
  isReadOnlyQaPrompt,
  resolveStepReasoningEffort,
} from "../src/context.js";
import { CheckpointManager } from "../src/checkpoint.js";
import {
  createToolset,
  normalizeWindowsShellCommand,
} from "../src/tools/index.js";
import { streamTurn } from "../src/protocol.js";
import { AivoAgent } from "../src/agent.js";
import type { AivoConfig } from "../src/config.js";

describe("AA Benchmark Optimizations: Shell Normalization, Auto-Hydration, Stream Stall Recovery & Adaptive Effort", () => {
  it("1. normalizes POSIX/cmd idioms (&&, ||, 2>/dev/null, del, rm -f, ls -la) and executes chained commands in run_shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-shell-norm-"));
    try {
      writeFileSync(join(dir, "temp.txt"), "hello\n", "utf8");
      const normalized = normalizeWindowsShellCommand(
        'del temp.txt && ls -la 2>/dev/null || echo "fallback"',
      );
      expect(normalized).not.toContain("2>/dev/null");

      const tools = createToolset({
        cwd: dir,
        mode: "auto",
        checkpoints: new CheckpointManager(),
        todos: [],
      });

      const res = await tools.execute("run_shell", {
        command: 'del temp.txt && node -v && ls -la 2>/dev/null || echo "fallback"',
      });
      expect(res.isError).toBeFalsy();
      expect(res.output).toMatch(/v\d+\.\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("2. auto-hydrates backtick-referenced workspace files and directory files in expandFileMentions, and read_file defaults to 2000 lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-hydrate-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "logs"), { recursive: true });
      writeFileSync(join(dir, "src/cache.mjs"), "export class Cache {}\n", "utf8");
      writeFileSync(join(dir, "logs/auth.log"), "2026-10-27 status=200\n", "utf8");

      const hydrated = expandFileMentions(
        "Fix the bug in `src/cache.mjs` and inspect `logs/` (`auth.log`)",
        dir,
      );
      expect(hydrated).toContain('<file path="src/cache.mjs">');
      expect(hydrated).toContain("1: export class Cache {}");
      expect(hydrated).toContain('<file path="logs/auth.log">');
      expect(hydrated).toContain("1: 2026-10-27 status=200");

      // Also verify read_file reads >500 lines without truncating at 500
      const lines800 = Array.from({ length: 800 }, (_, i) => `line_${i + 1}`).join("\n");
      writeFileSync(join(dir, "src/long.ts"), lines800, "utf8");

      const tools = createToolset({
        cwd: dir,
        mode: "auto",
        checkpoints: new CheckpointManager(),
        todos: [],
      });
      const readRes = await tools.execute("read_file", { path: "src/long.ts" });
      expect(readRes.output).toContain("800: line_800");
      expect(readRes.output).not.toContain("more lines; use offset=");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("3. detects read-only Q&A prompts and computes adaptive step-aware reasoning effort", () => {
    expect(
      isReadOnlyQaPrompt(
        "Read `src/agent.ts` and answer these questions. IMPORTANT: Do NOT modify or create any files.",
      ),
    ).toBe(true);
    expect(
      isReadOnlyQaPrompt("Fix the bug in `src/cache.mjs` and run `node test/cache.test.mjs`."),
    ).toBe(false);

    // When tests just passed after modifying files, step down from max to low for instant summary
    expect(
      resolveStepReasoningEffort({
        configuredEffort: "max",
        step: 3,
        isReadOnlyQa: false,
        hasPrehydratedFiles: true,
        testsJustPassed: true,
      }),
    ).toBe("low");

    // When read-only Q&A already has all referenced files pre-hydrated in context, use low instead of max
    expect(
      resolveStepReasoningEffort({
        configuredEffort: "max",
        step: 1,
        isReadOnlyQa: true,
        hasPrehydratedFiles: true,
        testsJustPassed: false,
      }),
    ).toBe("low");
  });

  it("4. aborts stalled SSE streams via chunkIdleTimeoutMs and auto-retries in AivoAgent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-stall-"));
    try {
      let attempt = 0;
      const mockFetch: typeof fetch = async () => {
        attempt++;
        if (attempt === 1) {
          // Return a stream that sends one header chunk and then stalls forever without closing
          const stalledStream = new ReadableStream({
            start(ctrl) {
              const enc = new TextEncoder();
              ctrl.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: "Partial..." } }] })}\n\n`,
                ),
              );
              // Never close or enqueue again
            },
          });
          return new Response(stalledStream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }

        // Attempt 2 succeeds cleanly
        const okStream = new ReadableStream({
          start(ctrl) {
            const enc = new TextEncoder();
            ctrl.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "Recovered from stalled stream!" } }] })}\n` +
                  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n` +
                  `data: [DONE]\n\n`,
              ),
            );
            ctrl.close();
          },
        });
        return new Response(okStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };

      // Direct streamTurn idle timeout test (50ms timeout)
      await expect(
        streamTurn({
          baseUrl: "https://api.aivokey.dev",
          apiKey: "sk-aivo_test",
          sessionId: "ses_stall_1",
          wire: "chat",
          model: "deepseek-v4.1-flash",
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          chunkIdleTimeoutMs: 50,
          fetchFn: mockFetch,
        }),
      ).rejects.toThrow(/stalled|timeout/i);

      // Reset attempt counter and test full AivoAgent auto-recovery
      attempt = 0;
      const cfg: AivoConfig = {
        apiKey: "sk-aivo_test",
        baseUrl: "https://api.aivokey.dev",
        model: "deepseek-v4.1-flash",
        fastModel: null,
        wire: "chat",
        reasoningEffort: "off",
        mode: "auto",
        webSearch: false,
        cwd: dir,
        globalConfigPath: join(dir, "config.json"),
      };

      const agent = new AivoAgent({
        config: cfg,
        fetchFn: mockFetch,
        sleepFn: async () => {},
        chunkIdleTimeoutMs: 50,
      });

      const res = await agent.runUserPrompt("Hello");
      expect(res.finalText).toBe("Recovered from stalled stream!");
      expect(attempt).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("5. executes built-in image_generate tool via /v1/images/generations and saves PNG to workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-img-gen-"));
    try {
      // Minimal valid 1x1 PNG base64
      const png1x1Base64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      let capturedUrl = "";
      let capturedBody: Record<string, unknown> = {};

      const tools = createToolset({
        cwd: dir,
        mode: "auto",
        checkpoints: new CheckpointManager(),
        todos: [],
        apiKey: "sk-aivo_test_img",
        baseUrl: "https://api.aivokey.dev",
        fetchFn: async (input, init) => {
          capturedUrl = String(input);
          capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(
            JSON.stringify({
              data: [{ b64_json: png1x1Base64 }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      });

      const res = await tools.execute("image_generate", {
        prompt: "A red sports car colliding with a sport motorcycle",
        model: "gemini-2.5-flash-image",
        outputPath: "crash.png",
      });
      expect(res.isError).toBeFalsy();
      expect(capturedUrl).toBe("https://api.aivokey.dev/v1/images/generations");
      expect(capturedBody.model).toBe("gemini-2.5-flash-image");
      expect(res.output).toContain("crash.png");
      expect(res.output).toContain("1x1 image/png");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
