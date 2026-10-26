import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeGatewayOrigin,
  normalizeModelId,
  maskApiKey,
  looksLikeApiKey,
  resolveConfig,
  saveUserConfig,
  loadUserConfig,
  endpointUrl,
  DEFAULT_GATEWAY_ORIGIN,
} from "../src/config.js";

describe("config & normalization", () => {
  it("normalizes gateway URLs regardless of trailing /v1 or slashes (fixes Claude Code vs OpenCode /v1 trap)", () => {
    expect(normalizeGatewayOrigin("https://api.aivokey.dev")).toBe("https://api.aivokey.dev");
    expect(normalizeGatewayOrigin("https://api.aivokey.dev/")).toBe("https://api.aivokey.dev");
    expect(normalizeGatewayOrigin("https://api.aivokey.dev/v1")).toBe("https://api.aivokey.dev");
    expect(normalizeGatewayOrigin("https://api.aivokey.dev/v1/")).toBe("https://api.aivokey.dev");
    expect(normalizeGatewayOrigin("http://localhost:8888/v1/chat/completions")).toBe("http://localhost:8888");
    expect(normalizeGatewayOrigin("")).toBe(DEFAULT_GATEWAY_ORIGIN);
  });

  it("constructs exact AivoKey wire endpoints from gateway origin", () => {
    expect(endpointUrl("https://api.aivokey.dev/v1", "models")).toBe("https://api.aivokey.dev/v1/models");
    expect(endpointUrl("https://api.aivokey.dev", "key")).toBe("https://api.aivokey.dev/v1/key");
    expect(endpointUrl("https://api.aivokey.dev", "chat")).toBe("https://api.aivokey.dev/v1/chat/completions");
    expect(endpointUrl("https://api.aivokey.dev", "messages")).toBe("https://api.aivokey.dev/v1/messages");
    expect(endpointUrl("https://api.aivokey.dev", "responses")).toBe("https://api.aivokey.dev/v1/responses");
  });

  it("strips accidental provider prefixes to preserve AivoKey bare canonical model IDs", () => {
    expect(normalizeModelId("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(normalizeModelId("aivokey/deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(normalizeModelId("openai/gpt-5.5")).toBe("gpt-5.5");
    expect(normalizeModelId("anthropic/claude-sonnet-4-5")).toBe("claude-sonnet-4.5");
    expect(normalizeModelId("  GLM-5.3  ")).toBe("glm-5.3");
  });

  it("masks API keys safely and detects credential strings", () => {
    expect(looksLikeApiKey("sk-aivo_1234567890abcdef")).toBe(true);
    expect(looksLikeApiKey("my-laptop-key")).toBe(false);
    expect(maskApiKey("sk-aivo_1234567890abcdef")).toBe("sk-aivo_...cdef");
  });

  it("resolves config with precedence: CLI flags > Env > Workspace .aivokey.json > Global config", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-cfg-"));
    try {
      const globalFile = join(dir, "global.json");
      const workspaceDir = join(dir, "workspace");
      saveUserConfig({
        apiKey: "sk-aivo_globalkey12345",
        baseUrl: "https://api.aivokey.dev/v1",
        model: "aivokey/glm-5.3",
        wire: "chat",
      }, globalFile);

      const loaded = loadUserConfig(globalFile);
      expect(loaded.apiKey).toBe("sk-aivo_globalkey12345");
      expect(loaded.baseUrl).toBe("https://api.aivokey.dev");
      expect(loaded.model).toBe("glm-5.3");

      writeFileSync(
        join(dir, ".aivokey.json"),
        JSON.stringify({ model: "openai/gpt-5.5", reasoningEffort: "high" }),
      );

      const resolvedFromEnv = resolveConfig({
        cwd: dir,
        globalConfigPath: globalFile,
        env: {
          AIVOKEY_MODEL: "aivokey/deepseek-v4-pro",
          AIVOKEY_REASONING_EFFORT: "xhigh",
        },
        cli: {},
      });
      expect(resolvedFromEnv.apiKey).toBe("sk-aivo_globalkey12345");
      expect(resolvedFromEnv.model).toBe("deepseek-v4-pro");
      expect(resolvedFromEnv.reasoningEffort).toBe("xhigh");

      const resolvedFromCli = resolveConfig({
        cwd: dir,
        globalConfigPath: globalFile,
        env: { AIVOKEY_MODEL: "deepseek-v4-pro" },
        cli: { model: "claude-sonnet-4-5", wire: "messages", mode: "plan" },
      });
      expect(resolvedFromCli.model).toBe("claude-sonnet-4.5");
      expect(resolvedFromCli.wire).toBe("messages");
      expect(resolvedFromCli.mode).toBe("plan");
      void workspaceDir;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
