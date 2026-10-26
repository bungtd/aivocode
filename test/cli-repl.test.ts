import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCliArgs, runCli } from "../src/cli.js";
import { handleSlashCommand } from "../src/repl.js";
import { AivoAgent } from "../src/agent.js";

describe("CLI subcommands & interactive REPL slash commands", () => {
  it("parses CLI arguments and flags accurately", () => {
    const parsed1 = parseCliArgs([
      "run",
      "Fix the router bug",
      "--model",
      "aivokey/deepseek-v4-pro",
      "--wire",
      "messages",
      "--effort",
      "xhigh",
      "--mode",
      "plan",
      "--web-search",
    ]);
    expect(parsed1.command).toBe("run");
    expect(parsed1.prompt).toBe("Fix the router bug");
    expect(parsed1.cliConfig.model).toBe("deepseek-v4-pro");
    expect(parsed1.cliConfig.wire).toBe("messages");
    expect(parsed1.cliConfig.reasoningEffort).toBe("xhigh");
    expect(parsed1.cliConfig.mode).toBe("plan");
    expect(parsed1.cliConfig.webSearch).toBe(true);

    const parsed2 = parseCliArgs(["-p", "Summarize @README.md", "-m", "glm-5.3"]);
    expect(parsed2.command).toBe("run");
    expect(parsed2.prompt).toBe("Summarize @README.md");
    expect(parsed2.cliConfig.model).toBe("glm-5.3");
  });

  it("handles REPL slash commands (/model, /effort, /wire, /mode, /status, /compact, /undo, /todo, /fork)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-repl-"));
    try {
      const agent = new AivoAgent({
        config: {
          apiKey: "sk-aivo_1234567890abcdef",
          baseUrl: "https://api.aivokey.dev",
          model: "deepseek-v4-pro",
          fastModel: "glm-5.3",
          wire: "chat",
          reasoningEffort: "medium",
          mode: "auto",
          webSearch: false,
          cwd: dir,
          globalConfigPath: join(dir, "config.json"),
        },
        catalog: [
          {
            id: "deepseek-v4-pro",
            name: "DeepSeek V4 Pro",
            contextWindow: 256000,
            maxOutputTokens: 32768,
            supportsTools: true,
            supportsVision: true,
            supportsReasoning: true,
            supportsPromptCache: true,
            supportsJsonMode: true,
            supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
            inputMicroPer1M: 1_000_000n,
            outputMicroPer1M: 4_000_000n,
            cacheReadMicroPer1M: 100_000n,
            cacheWriteMicroPer1M: null,
            category: "flagship",
          },
          {
            id: "glm-5.3",
            name: "GLM 5.3",
            contextWindow: 128000,
            maxOutputTokens: 16384,
            supportsTools: true,
            supportsVision: false,
            supportsReasoning: false,
            supportsPromptCache: true,
            supportsJsonMode: true,
            supportedEfforts: [],
            inputMicroPer1M: 300_000n,
            outputMicroPer1M: 1_200_000n,
            cacheReadMicroPer1M: 50_000n,
            cacheWriteMicroPer1M: null,
            category: "coding",
          },
        ],
      });

      const outModel = await handleSlashCommand("/model aivokey/glm-5.3", agent, null);
      expect(agent.config.model).toBe("glm-5.3");
      expect(outModel.output).toContain("glm-5.3");

      const outEffort = await handleSlashCommand("/effort xhigh", agent, null);
      expect(agent.config.reasoningEffort).toBe("xhigh");
      expect(outEffort.output).toContain("xhigh");

      const outWire = await handleSlashCommand("/wire messages", agent, null);
      expect(agent.config.wire).toBe("messages");
      expect(outWire.output).toContain("messages");

      const outMode = await handleSlashCommand("/mode plan", agent, null);
      expect(agent.config.mode).toBe("plan");
      expect(outMode.output).toContain("plan");

      const outStatus = await handleSlashCommand("/status", agent, {
        mode: "payg",
        balanceMicro: 5_500_000n,
        fallbackEnabled: false,
        freeTokens: [{ model: "glm-5.3", remainingTokens: 200_000n }],
        purchasedTokens: [],
        plan: null,
        models: [],
        global: null,
      });
      expect(outStatus.output).toContain("$5.50");
      expect(outStatus.output).toContain("200,000");

      const oldSessionId = agent.session.id;
      const outFork = await handleSlashCommand("/fork", agent, null);
      expect(agent.session.id).not.toBe(oldSessionId);
      expect(outFork.output).toContain(agent.session.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs CLI subcommands (models, status, doctor)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-cli-"));
    try {
      const logs: string[] = [];
      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url.endsWith("/v1/models")) {
          return new Response(
            JSON.stringify({
              object: "list",
              data: [
                {
                  id: "deepseek-v4-pro",
                  name: "DeepSeek V4 Pro",
                  context_length: 256000,
                  pricing: { prompt: "0.000001", completion: "0.000004" },
                  supported_parameters: ["tools", "reasoning"],
                  prompt_cache: true,
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/v1/key")) {
          return new Response(
            JSON.stringify({
              mode: "payg",
              balance_micro: "3000000",
              fallback_enabled: false,
              free_tokens: [{ model: "deepseek-v4-pro", remaining: "100000" }],
              models: [],
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      };

      const code = await runCli(["doctor", "--api-key", "sk-aivo_1234567890abcdef"], {
        cwd: dir,
        fetchFn: mockFetch,
        writeOut: (msg) => logs.push(msg),
      });
      expect(code).toBe(0);
      const joined = logs.join("\n");
      expect(joined).toContain("deepseek-v4-pro");
      expect(joined).toContain("$3.00");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
