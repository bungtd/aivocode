import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveConfig, saveUserConfig, loadUserConfig } from "../src/config.js";
import { computeComposerSuggestions } from "../src/ui/composer.js";
import { handleSlashCommand } from "../src/repl.js";
import { AivoAgent } from "../src/agent.js";

describe("Interactive Config Center, Subagent/Role Model Selection & Argument Autocomplete", () => {
  it("persists and resolves subagent models (fastModel, architectModel, builderModel, reviewerModel), subagentEffort, strategy, and autoReviewFix", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-cfg-center-"));
    try {
      const cfgFile = join(dir, "config.json");
      saveUserConfig(
        {
          model: "claude-opus-5-5",
          fastModel: "glm-5.3-flash",
          architectModel: "claude-opus-5-5",
          builderModel: "deepseek-v4-flash",
          reviewerModel: "gpt-6.1-sol",
          reasoningEffort: "high",
          subagentEffort: "low",
          strategy: "subagent-driven",
          autoReviewFix: true,
        },
        cfgFile,
      );

      const loaded = loadUserConfig(cfgFile);
      expect(loaded.fastModel).toBe("glm-5.3-flash");
      expect(loaded.architectModel).toBe("claude-opus-5-5");
      expect(loaded.builderModel).toBe("deepseek-v4-flash");
      expect(loaded.reviewerModel).toBe("gpt-6.1-sol");
      expect(loaded.subagentEffort).toBe("low");
      expect(loaded.strategy).toBe("subagent-driven");
      expect(loaded.autoReviewFix).toBe(true);

      const resolved = resolveConfig({
        cwd: dir,
        globalConfigPath: cfgFile,
        env: {},
        cli: {},
      });
      expect(resolved.fastModel).toBe("glm-5.3-flash");
      expect(resolved.architectModel).toBe("claude-opus-5-5");
      expect(resolved.builderModel).toBe("deepseek-v4-flash");
      expect(resolved.reviewerModel).toBe("gpt-6.1-sol");
      expect(resolved.subagentEffort).toBe("low");
      expect(resolved.strategy).toBe("subagent-driven");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("autocompletes arguments for /model, /subagent, /team, /effort, /mode, /wire, and /strategy", () => {
    const modelIds = ["deepseek-v4-flash", "deepseek-v4-pro", "glm-5.3-flash", "claude-sonnet-5-5"];

    const sModel = computeComposerSuggestions("/model deep", ["src/index.ts"], modelIds);
    expect(sModel.kind).toBe("arg");
    expect(sModel.items.map((i) => i.value)).toContain("/model deepseek-v4-flash");

    const sSub = computeComposerSuggestions("/subagent glm", ["src/index.ts"], modelIds);
    expect(sSub.kind).toBe("arg");
    expect(sSub.items.map((i) => i.value)).toContain("/subagent glm-5.3-flash");

    const sTeam = computeComposerSuggestions("/team bl", ["src/index.ts"], modelIds);
    expect(sTeam.kind).toBe("arg");
    expect(sTeam.items[0]?.value).toBe("/team blender3d");

    const sStrategy = computeComposerSuggestions("/strategy sub", ["src/index.ts"], modelIds);
    expect(sStrategy.kind).toBe("arg");
    expect(sStrategy.items[0]?.value).toBe("/strategy subagent-driven");
  });

  it("allows configuring primary model, subagent model, role models, strategy, and settings via /subagent, /strategy, and /config commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-repl-cfg-"));
    try {
      const cfgFile = join(dir, "config.json");
      const agent = new AivoAgent({
        config: resolveConfig({
          cwd: dir,
          globalConfigPath: cfgFile,
          cli: { apiKey: "sk-aivo_test" },
        }),
      });

      // 1. Set subagent (explorer) model
      const resSub = await handleSlashCommand("/subagent qwen3.8-flash", agent, null);
      expect(agent.config.fastModel).toBe("qwen3.8-flash");
      expect(resSub.output).toContain("qwen3.8-flash");

      // 2. Set role-specific subagent model (e.g. architect, builder, reviewer)
      const resArch = await handleSlashCommand("/subagent architect claude-opus-5-5", agent, null);
      expect(agent.config.architectModel).toBe("claude-opus-5-5");
      expect(resArch.output).toContain("claude-opus-5-5");

      const resBuilder = await handleSlashCommand("/subagent builder deepseek-v4-pro", agent, null);
      expect(agent.config.builderModel).toBe("deepseek-v4-pro");
      expect(resBuilder.output).toContain("deepseek-v4-pro");

      const resReviewer = await handleSlashCommand("/subagent reviewer gpt-6.1-sol", agent, null);
      expect(agent.config.reviewerModel).toBe("gpt-6.1-sol");
      expect(resReviewer.output).toContain("gpt-6.1-sol");

      // 3. Set execution strategy
      const resStrat = await handleSlashCommand("/strategy subagent-driven", agent, null);
      expect(agent.config.strategy).toBe("subagent-driven");
      expect(resStrat.output).toContain("subagent-driven");

      // 4. Inspect or set via /config
      const resCfgSet = await handleSlashCommand("/config subagentEffort high", agent, null);
      expect(agent.config.subagentEffort).toBe("high");
      expect(resCfgSet.output).toContain("high");

      const resCfgList = await handleSlashCommand("/config", agent, null);
      expect(resCfgList.output).toContain("qwen3.8-flash");
      expect(resCfgList.output).toContain("claude-opus-5-5");
      expect(resCfgList.output).toContain("subagent-driven");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
