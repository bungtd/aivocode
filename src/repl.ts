import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { execSync } from "node:child_process";
import {
  maskApiKey,
  matchCatalogModelId,
  normalizeGatewayOrigin,
  saveUserConfig,
  VALID_EFFORTS,
  VALID_MODES,
  VALID_STRATEGIES,
  VALID_TEAMS,
  VALID_WIRES,
  type AivoWire,
  type ExecutionStrategy,
  type PermissionMode,
  type ReasoningEffort,
} from "./config.js";
import { AGENT_TEAMS, getAgentTeam, type TeamId } from "./teams.js";
import { auditCodeForSlop } from "./anti-slop.js";
import { executeComputerUse } from "./computer-use.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import {
  DEFAULT_AIVOKEY_CATALOG,
  fetchModels,
  filterEligibleModelsForAccount,
  formatKeyStatusSummary,
  formatMicroUsd,
  inspectKey,
  isModelUsableByKey,
  recommendCodingModels,
  type AivoModelInfo,
  type KeyInspectStatus,
} from "./aivokey-client.js";
import { walkWorkspaceFiles } from "./tools/index.js";
import { buildSystemPrompt, estimateConversationTokens } from "./context.js";
import type { AivoAgent } from "./agent.js";
import {
  c,
  formatCompactTokens,
  getGitBranchLabel,
  renderHeaderBanner,
  renderTodoBoard,
  TerminalSpinner,
} from "./ui/theme.js";
import { interactiveSelect, SLASH_COMMANDS } from "./ui/select.js";
import { readInteractiveComposerLine } from "./ui/composer.js";

export interface SlashCommandResult {
  output: string;
  shouldExit?: boolean;
  updatedKeyStatus?: KeyInspectStatus | null;
}

export function formatModelsTable(
  models: AivoModelInfo[],
  activeModel: string,
  keyStatus: KeyInspectStatus | null,
  filter?: string,
): string {
  const q = (filter ?? "").trim().toLowerCase();
  const filtered = models.filter((m) => {
    if (!q) return true;
    if (q === "--tools" || q === "tools") return m.supportsTools;
    if (q === "--free" || q === "free") {
      return keyStatus?.freeTokens.some((f) => f.model === m.id && f.remainingTokens > 0n) ?? false;
    }
    return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
  });

  if (filtered.length === 0) {
    return c.amber(`No models matched '${filter ?? ""}'.`);
  }

  const lines: string[] = [
    `${c.cyan("╭─")} ${c.bold(`AivoKey Live Model Catalog (${filtered.length})`)} ${c.cyan("─".repeat(42))}`,
    `${c.cyan("│")} ${c.slate("Model ID                  Ctx      In / Out ($/1M)   Capabilities & Quota")}`,
    `${c.cyan("├" + "─".repeat(74))}`,
  ];

  for (const m of filtered) {
    const isCurrent = m.id === activeModel;
    const marker = isCurrent ? c.emerald("❯ ") : "  ";
    const idPadded = m.id.padEnd(23).slice(0, 23);
    const idCol = isCurrent ? c.bold(c.emerald(idPadded)) : c.white(idPadded);
    const ctxCol = formatCompactTokens(m.contextWindow).padEnd(8);
    const inUsd = (Number(m.inputMicroPer1M) / 1_000_000).toFixed(2);
    const outUsd = (Number(m.outputMicroPer1M) / 1_000_000).toFixed(2);
    const priceCol = `$${inUsd} / $${outUsd}`.padEnd(17);

    const badges: string[] = [];
    if (m.supportsTools) badges.push(c.cyan("tools"));
    if (m.supportsReasoning) badges.push(c.violet("reasoning"));
    if (m.supportsPromptCache) badges.push(c.teal("cache"));
    if (m.supportsVision) badges.push(c.blue("vision"));
    const free = keyStatus?.freeTokens.find((f) => f.model === m.id && f.remainingTokens > 0n);
    if (free) {
      badges.push(c.amber(`FREE:${Number(free.remainingTokens).toLocaleString("en-US")}`));
    }
    if (keyStatus && !isModelUsableByKey(m.id, keyStatus)) {
      badges.push(c.rose("locked"));
    }

    lines.push(
      `${c.cyan("│")} ${marker}${idCol} ${c.slate(ctxCol)} ${c.slate(priceCol)} ${badges.join(c.slate(" · "))}`,
    );
  }

  lines.push(`${c.cyan("╰" + "─".repeat(74))}`);
  return lines.join("\n");
}

function renderProgressBar(used: bigint, limit: bigint, width: number = 16): string {
  if (limit <= 0n) return c.slate("─".repeat(width));
  const ratio = Math.min(1, Math.max(0, Number(used) / Number(limit)));
  const filled = Math.round(ratio * width);
  const empty = Math.max(0, width - filled);
  const barColor = ratio >= 0.9 ? c.rose : ratio >= 0.7 ? c.amber : c.emerald;
  return `${barColor("█".repeat(filled))}${c.slate("░".repeat(empty))} ${Math.round(ratio * 100)}%`;
}

export function formatDetailedStatus(
  agent: AivoAgent,
  keyStatus: KeyInspectStatus | null,
): string {
  const s = agent.session;
  const totalPrompt = s.totalInputTokens + s.totalCacheReadTokens;
  const cacheHitPct =
    totalPrompt > 0 ? Math.round((s.totalCacheReadTokens / totalPrompt) * 100) : 0;

  const lines: string[] = [
    `${c.cyan("╭─")} ${c.bold("AivoCode Telemetry & Quota Inspector")} ${c.cyan("─".repeat(36))}`,
    `${c.cyan("│")} ${c.slate("Gateway     :")} ${c.white(agent.config.baseUrl)}`,
    `${c.cyan("│")} ${c.slate("Session ID  :")} ${c.white(s.id)} ${c.teal("(sticky prompt-cache affinity)")}`,
    `${c.cyan("│")} ${c.slate("Active Model:")} ${c.emerald(c.bold(agent.config.model))}${agent.config.fastModel ? c.slate(` (subagent explorer: ${c.teal(agent.config.fastModel)})`) : ""}`,
    `${c.cyan("│")} ${c.slate("Config      :")} wire=${c.cyan(agent.config.wire)} · mode=${c.amber(agent.config.mode)} · effort=${c.violet(agent.config.reasoningEffort)} · webSearch=${agent.config.webSearch ? c.emerald("on") : c.slate("off")}`,
    `${c.cyan("│")} ${c.slate("Session Use :")} in=${s.totalInputTokens.toLocaleString("en-US")} · cache_read=${s.totalCacheReadTokens.toLocaleString("en-US")} (${c.teal(`${cacheHitPct}% hit`)}) · out=${s.totalOutputTokens.toLocaleString("en-US")} · cost=${c.emerald(formatMicroUsd(BigInt(s.totalCostMicro || "0")))}`,
  ];

  if (keyStatus) {
    lines.push(`${c.cyan("├" + "─".repeat(74))}`);
    lines.push(`${c.cyan("│")} ${c.slate("Account     :")} ${formatKeyStatusSummary(keyStatus)}`);
    if (keyStatus.mode === "plan" && keyStatus.models.length > 0) {
      lines.push(`${c.cyan("│")} ${c.bold("Per-Model Plan Windows:")}`);
      for (const m of keyStatus.models) {
        const bar5h = renderProgressBar(m.w5h.usedMicro, m.w5h.limitMicro, 12);
        const barMo = renderProgressBar(m.month.usedMicro, m.month.limitMicro, 12);
        lines.push(
          `${c.cyan("│")}   • ${c.bold(m.model.padEnd(20))} 5h [${bar5h}] ${formatMicroUsd(m.w5h.usedMicro)}/${formatMicroUsd(m.w5h.limitMicro)} · 30d [${barMo}] ${formatMicroUsd(m.month.usedMicro)}/${formatMicroUsd(m.month.limitMicro)}`,
        );
      }
    }
    if (keyStatus.mode === "plan" && keyStatus.global) {
      const g = keyStatus.global;
      const bar5h = renderProgressBar(g.w5h.usedMicro, g.w5h.limitMicro, 12);
      const barMo = renderProgressBar(g.month.usedMicro, g.month.limitMicro, 12);
      lines.push(
        `${c.cyan("│")} ${c.bold("Global Pool :")} 5h [${bar5h}] ${formatMicroUsd(g.w5h.usedMicro)}/${formatMicroUsd(g.w5h.limitMicro)} · 30d [${barMo}] ${formatMicroUsd(g.month.usedMicro)}/${formatMicroUsd(g.month.limitMicro)}`,
      );
    }
  } else {
    lines.push(
      `${c.cyan("│")} ${c.amber("Account     : API key not verified yet. Run /login <sk-aivo_...> to connect.")}`,
    );
  }

  lines.push(`${c.cyan("╰" + "─".repeat(74))}`);
  return lines.join("\n");
}

export async function handleSlashCommand(
  line: string,
  agent: AivoAgent,
  keyStatus: KeyInspectStatus | null,
  fetchFn: typeof fetch = fetch,
  interactive: boolean = false,
): Promise<SlashCommandResult> {
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0]!.toLowerCase();
  const arg = parts.slice(1).join(" ").trim();

  switch (cmd) {
    case "/help":
      return {
        output: [
          `${c.cyan("╭─")} ${c.bold("AivoCode Command & Hotkey Reference")} ${c.cyan("─".repeat(38))}`,
          `${c.cyan("│")} ${c.bold("Live Hotkeys (inside Composer):")}`,
          `${c.cyan("│")}  ${c.bold(c.amber("Shift+Tab / Ctrl+T"))} ${c.slate("Cycle Mode live: AUTO (Build) → PLAN (Architect) → SAFE (Confirm)")}`,
          `${c.cyan("│")}  ${c.bold(c.amber("Ctrl+K"))}             ${c.slate("Open Interactive Model Switcher Modal (search & arrow keys)")}`,
          `${c.cyan("│")}  ${c.bold(c.amber("Ctrl+E"))}             ${c.slate("Cycle Reasoning Effort live: minimal → low → medium → high → xhigh → max")}`,
          `${c.cyan("│")}  ${c.bold(c.amber("Ctrl+W"))}             ${c.slate("Cycle AivoKey Wire live: chat → messages → responses")}`,
          `${c.cyan("│")}  ${c.bold(c.amber("Ctrl+S"))}             ${c.slate("Open Live AivoKey Telemetry & Quota Inspector")}`,
          `${c.cyan("│")}  ${c.bold(c.amber("Type /"))}             ${c.slate("Opens Live Floating Slash Command Palette immediately")}`,
          `${c.cyan("│")}  ${c.bold(c.amber("Type @"))}             ${c.slate("Opens Live Fuzzy File Finder immediately")}`,
          `${c.cyan("│")}  ${c.bold(c.amber("!<command>"))}         ${c.slate("Execute shell command directly without spending LLM tokens")}`,
          `${c.cyan("│")}  ${c.bold(c.amber("Esc (while busy)"))}   ${c.slate("Interrupt active LLM stream or tool execution cleanly")}`,
          `${c.cyan("├" + "─".repeat(74))}`,
          `${c.cyan("│")} ${c.bold("Slash Commands:")}`,
          ...SLASH_COMMANDS.map(
            (s) => `${c.cyan("│")}  ${c.bold(c.emerald(s.cmd.padEnd(14)))} ${c.slate(s.description)}`,
          ),
          `${c.cyan("╰" + "─".repeat(74))}`,
        ].join("\n"),
      };

    case "/models":
      return {
        output: formatModelsTable(agent.catalog, agent.config.model, keyStatus, arg),
      };

    case "/model": {
      const availableCatalog =
        agent.catalog.length > 0 ? agent.catalog : DEFAULT_AIVOKEY_CATALOG;
      let chosenId = arg
        ? matchCatalogModelId(
            arg,
            availableCatalog.map((m) => m.id),
          )
        : "";
      if (!chosenId && interactive) {
        const picked = await interactiveSelect({
          title: "Select Active Primary Model",
          initialValue: agent.config.model,
          items: availableCatalog.map((m) => {
            const inUsd = (Number(m.inputMicroPer1M) / 1_000_000).toFixed(2);
            const outUsd = (Number(m.outputMicroPer1M) / 1_000_000).toFixed(2);
            const badges: string[] = [];
            if (m.supportsTools) badges.push("tools");
            if (m.supportsReasoning) badges.push("reasoning");
            if (m.supportsPromptCache) badges.push("cache");
            const free = keyStatus?.freeTokens.find(
              (f) => f.model === m.id && f.remainingTokens > 0n,
            );
            if (free) badges.push(`FREE:${formatCompactTokens(Number(free.remainingTokens))}`);
            return {
              value: m.id,
              label: m.id,
              badge: `[${badges.join("·")}]`,
              detail: `${formatCompactTokens(m.contextWindow)} ctx · $${inUsd}/$${outUsd}`,
            };
          }),
        });
        if (!picked) return { output: c.slate("Model selection cancelled.") };
        chosenId = picked;
      }

      if (!chosenId) {
        return {
          output: `Current primary model: ${c.emerald(c.bold(agent.config.model))}. Usage: ${c.cyan("/model <canonical-id>")}`,
        };
      }

      const found = availableCatalog.find((m) => m.id === chosenId);
      const warnings: string[] = [];
      if (found && !found.supportsTools) {
        warnings.push(
          c.amber(
            `  ⚠ '${chosenId}' does not advertise tool calling; agentic file edits may not work.`,
          ),
        );
      }
      if (keyStatus && !isModelUsableByKey(chosenId, keyStatus)) {
        warnings.push(
          c.amber(
            `  ⚠ '${chosenId}' may not be covered by your active plan/free tokens unless balance fallback is on.`,
          ),
        );
      }
      agent.config.model = chosenId;
      agent.session.model = chosenId;
      saveUserConfig({ model: chosenId }, agent.config.globalConfigPath);
      return {
        output: [
          `${c.emerald("✓")} Switched active primary model to ${c.bold(c.emerald(chosenId))}`,
          ...warnings,
        ].join("\n"),
      };
    }

    case "/subagent":
    case "/subagent-model":
    case "/fast-model": {
      const availableCatalog =
        agent.catalog.length > 0 ? agent.catalog : DEFAULT_AIVOKEY_CATALOG;
      const catalogIds = availableCatalog.map((m) => m.id);
      const tokens = arg.split(/\s+/).filter(Boolean);

      type SubRole = "explore" | "architect" | "builder" | "reviewer" | "all";
      const roleKeywords = new Set<SubRole>(["explore", "architect", "builder", "reviewer", "all"]);

      let roleTarget: SubRole = "explore";
      let rawModelArg = "";

      if (tokens.length === 1) {
        if (roleKeywords.has(tokens[0]!.toLowerCase() as SubRole)) {
          roleTarget = tokens[0]!.toLowerCase() as SubRole;
        } else {
          rawModelArg = tokens[0]!;
        }
      } else if (tokens.length >= 2) {
        const firstTok = tokens[0]!.toLowerCase() as SubRole;
        if (roleKeywords.has(firstTok)) {
          roleTarget = firstTok;
          rawModelArg = tokens.slice(1).join(" ");
        } else {
          rawModelArg = tokens.join(" ");
        }
      }

      if (!rawModelArg && interactive) {
        if (tokens.length === 0) {
          const pickedRole = await interactiveSelect<SubRole>({
            title: "Select Subagent / Role to Configure",
            initialValue: "explore",
            items: [
              {
                value: "explore",
                label: "Explore / Fast Subagent",
                badge: `[current: ${agent.config.fastModel ?? agent.config.model}]`,
                detail: "Used by fast read-only explore subagents",
              },
              {
                value: "architect",
                label: "Architect Role",
                badge: `[current: ${agent.config.architectModel ?? agent.config.model}]`,
                detail: "Used by Team Stage 1 (System / UX / 3D / Mobile Architect)",
              },
              {
                value: "builder",
                label: "Builder / Implementer Role",
                badge: `[current: ${agent.config.builderModel ?? agent.config.model}]`,
                detail: "Used by Team Stage 2 (Backend / Frontend / Kotlin / BPY / Gameplay Builder)",
              },
              {
                value: "reviewer",
                label: "QA & Reviewer Role",
                badge: `[current: ${agent.config.reviewerModel ?? agent.config.model}]`,
                detail: "Used by Team Stage 3/4 (Security / A11y / QA / Anti-Slop Reviewer)",
              },
              {
                value: "all",
                label: "All Subagent Roles",
                badge: "[sync all]",
                detail: "Set the same model for Explore, Architect, Builder, and Reviewer",
              },
            ],
          });
          if (!pickedRole) return { output: c.slate("Subagent configuration cancelled.") };
          roleTarget = pickedRole;
        }

        const pickedModel = await interactiveSelect({
          title: `Select Model for ${roleTarget.toUpperCase()} Subagent`,
          initialValue: agent.config.fastModel ?? agent.config.model,
          items: availableCatalog.map((m) => {
            const inUsd = (Number(m.inputMicroPer1M) / 1_000_000).toFixed(2);
            const outUsd = (Number(m.outputMicroPer1M) / 1_000_000).toFixed(2);
            return {
              value: m.id,
              label: m.id,
              badge: `[${formatCompactTokens(m.contextWindow)} ctx]`,
              detail: `$${inUsd}/$${outUsd} per 1M`,
            };
          }),
        });
        if (!pickedModel) return { output: c.slate("Subagent model selection cancelled.") };
        rawModelArg = pickedModel;
      }

      if (!rawModelArg) {
        return {
          output: [
            `${c.cyan("◆")} ${c.bold("Current Subagent & Role Models:")}`,
            `  • ${c.bold("explore  ")} (Fast Subagent) : ${c.emerald(agent.config.fastModel ?? `${agent.config.model} (inherited)`)}`,
            `  • ${c.bold("architect")} (Stage 1 Design): ${c.emerald(agent.config.architectModel ?? `${agent.config.model} (inherited)`)}`,
            `  • ${c.bold("builder  ")} (Stage 2 Code)  : ${c.emerald(agent.config.builderModel ?? `${agent.config.model} (inherited)`)}`,
            `  • ${c.bold("reviewer ")} (Stage 3/4 QA)  : ${c.emerald(agent.config.reviewerModel ?? `${agent.config.model} (inherited)`)}`,
            `  • ${c.bold("effort   ")} (Subagent)      : ${c.violet(agent.config.subagentEffort ?? "low")}`,
            "",
            `Usage: ${c.cyan("/subagent <model-id>")} or ${c.cyan("/subagent <explore|architect|builder|reviewer|all> <model-id>")}`,
          ].join("\n"),
        };
      }

      const resolvedModel = matchCatalogModelId(rawModelArg, catalogIds);
      if (roleTarget === "explore") {
        agent.config.fastModel = resolvedModel;
        saveUserConfig({ fastModel: resolvedModel }, agent.config.globalConfigPath);
      } else if (roleTarget === "architect") {
        agent.config.architectModel = resolvedModel;
        saveUserConfig({ architectModel: resolvedModel }, agent.config.globalConfigPath);
      } else if (roleTarget === "builder") {
        agent.config.builderModel = resolvedModel;
        saveUserConfig({ builderModel: resolvedModel }, agent.config.globalConfigPath);
      } else if (roleTarget === "reviewer") {
        agent.config.reviewerModel = resolvedModel;
        saveUserConfig({ reviewerModel: resolvedModel }, agent.config.globalConfigPath);
      } else if (roleTarget === "all") {
        agent.config.fastModel = resolvedModel;
        agent.config.architectModel = resolvedModel;
        agent.config.builderModel = resolvedModel;
        agent.config.reviewerModel = resolvedModel;
        saveUserConfig(
          {
            fastModel: resolvedModel,
            architectModel: resolvedModel,
            builderModel: resolvedModel,
            reviewerModel: resolvedModel,
          },
          agent.config.globalConfigPath,
        );
      }

      return {
        output: `${c.emerald("✓")} Set ${c.bold(roleTarget)} subagent model to ${c.bold(c.emerald(resolvedModel))}`,
      };
    }

    case "/strategy": {
      let strat = arg.toLowerCase() as ExecutionStrategy;
      if (!arg && interactive) {
        const picked = await interactiveSelect<ExecutionStrategy>({
          title: "Select Execution Strategy",
          initialValue: agent.config.strategy ?? "auto",
          items: [
            {
              value: "auto",
              label: "auto",
              detail: "Automatically detect team, seed live tasks, and run build + Review-Fix gate",
            },
            {
              value: "subagent-driven",
              label: "subagent-driven",
              detail: "Always run multi-stage specialist workflow (Architect → Builder → QA Reviewer)",
            },
            {
              value: "native",
              label: "native",
              detail: "Always run fast single-session build + automated Review-Fix gate",
            },
            {
              value: "ask",
              label: "ask",
              detail: "Prompt me to choose Subagent-Driven vs Native before substantial builds",
            },
          ],
        });
        if (!picked) return { output: c.slate("Strategy selection cancelled.") };
        strat = picked;
      }
      if (!VALID_STRATEGIES.has(strat)) {
        return {
          output: `Current strategy: ${c.cyan(agent.config.strategy ?? "auto")}. Valid strategies: auto, subagent-driven, native, ask`,
        };
      }
      agent.config.strategy = strat;
      saveUserConfig({ strategy: strat }, agent.config.globalConfigPath);
      return {
        output: `${c.emerald("✓")} Execution strategy set to: ${c.bold(c.cyan(strat))}`,
      };
    }

    case "/config":
    case "/settings": {
      const tokens = arg.split(/\s+/).filter(Boolean);
      if (tokens.length >= 2) {
        const keyName = tokens[0]!;
        const val = tokens.slice(1).join(" ").trim();
        const availableIds = (
          agent.catalog.length > 0 ? agent.catalog : DEFAULT_AIVOKEY_CATALOG
        ).map((m) => m.id);

        switch (keyName) {
          case "model": {
            const m = matchCatalogModelId(val, availableIds);
            agent.config.model = m;
            agent.session.model = m;
            saveUserConfig({ model: m }, agent.config.globalConfigPath);
            return { output: `${c.emerald("✓")} Set config.model = ${c.bold(c.emerald(m))}` };
          }
          case "fastModel":
          case "subagentModel": {
            const m = matchCatalogModelId(val, availableIds);
            agent.config.fastModel = m;
            saveUserConfig({ fastModel: m }, agent.config.globalConfigPath);
            return { output: `${c.emerald("✓")} Set config.fastModel = ${c.bold(c.emerald(m))}` };
          }
          case "architectModel": {
            const m = matchCatalogModelId(val, availableIds);
            agent.config.architectModel = m;
            saveUserConfig({ architectModel: m }, agent.config.globalConfigPath);
            return { output: `${c.emerald("✓")} Set config.architectModel = ${c.bold(c.emerald(m))}` };
          }
          case "builderModel": {
            const m = matchCatalogModelId(val, availableIds);
            agent.config.builderModel = m;
            saveUserConfig({ builderModel: m }, agent.config.globalConfigPath);
            return { output: `${c.emerald("✓")} Set config.builderModel = ${c.bold(c.emerald(m))}` };
          }
          case "reviewerModel": {
            const m = matchCatalogModelId(val, availableIds);
            agent.config.reviewerModel = m;
            saveUserConfig({ reviewerModel: m }, agent.config.globalConfigPath);
            return { output: `${c.emerald("✓")} Set config.reviewerModel = ${c.bold(c.emerald(m))}` };
          }
          case "reasoningEffort":
          case "effort": {
            if (!VALID_EFFORTS.has(val as ReasoningEffort)) {
              return { output: c.rose(`Invalid effort '${val}'. Valid: ${[...VALID_EFFORTS].join(", ")}`) };
            }
            agent.config.reasoningEffort = val as ReasoningEffort;
            saveUserConfig({ reasoningEffort: val as ReasoningEffort }, agent.config.globalConfigPath);
            return { output: `${c.emerald("✓")} Set config.reasoningEffort = ${c.bold(c.violet(val))}` };
          }
          case "subagentEffort": {
            if (!VALID_EFFORTS.has(val as ReasoningEffort)) {
              return { output: c.rose(`Invalid effort '${val}'. Valid: ${[...VALID_EFFORTS].join(", ")}`) };
            }
            agent.config.subagentEffort = val as ReasoningEffort;
            saveUserConfig({ subagentEffort: val as ReasoningEffort }, agent.config.globalConfigPath);
            return { output: `${c.emerald("✓")} Set config.subagentEffort = ${c.bold(c.violet(val))}` };
          }
          case "strategy": {
            if (!VALID_STRATEGIES.has(val as ExecutionStrategy)) {
              return { output: c.rose(`Invalid strategy '${val}'. Valid: auto, subagent-driven, native, ask`) };
            }
            agent.config.strategy = val as ExecutionStrategy;
            saveUserConfig({ strategy: val as ExecutionStrategy }, agent.config.globalConfigPath);
            return { output: `${c.emerald("✓")} Set config.strategy = ${c.bold(c.cyan(val))}` };
          }
          case "team": {
            if (!VALID_TEAMS.has(val as TeamId)) {
              return { output: c.rose(`Invalid team '${val}'. Valid: ${[...VALID_TEAMS].join(", ")}`) };
            }
            agent.config.team = val as TeamId;
            saveUserConfig({ team: val as TeamId }, agent.config.globalConfigPath);
            return { output: `${c.emerald("✓")} Set config.team = ${c.bold(c.amber(val))}` };
          }
          case "mode": {
            if (!VALID_MODES.has(val as PermissionMode)) {
              return { output: c.rose(`Invalid mode '${val}'. Valid: auto, plan, safe`) };
            }
            agent.config.mode = val as PermissionMode;
            saveUserConfig({ mode: val as PermissionMode }, agent.config.globalConfigPath);
            return { output: `${c.emerald("✓")} Set config.mode = ${c.bold(c.amber(val))}` };
          }
          case "wire": {
            if (!VALID_WIRES.has(val as AivoWire)) {
              return { output: c.rose(`Invalid wire '${val}'. Valid: chat, messages, responses`) };
            }
            agent.config.wire = val as AivoWire;
            agent.session.wire = val as AivoWire;
            saveUserConfig({ wire: val as AivoWire }, agent.config.globalConfigPath);
            return { output: `${c.emerald("✓")} Set config.wire = ${c.bold(c.cyan(val))}` };
          }
          case "autoReviewFix": {
            const b = val === "true" || val === "on" || val === "1";
            agent.config.autoReviewFix = b;
            saveUserConfig({ autoReviewFix: b }, agent.config.globalConfigPath);
            return { output: `${c.emerald("✓")} Set config.autoReviewFix = ${b}` };
          }
          case "baseUrl": {
            const norm = normalizeGatewayOrigin(val);
            agent.config.baseUrl = norm;
            saveUserConfig({ baseUrl: norm }, agent.config.globalConfigPath);
            return { output: `${c.emerald("✓")} Set config.baseUrl = ${norm}` };
          }
          case "apiKey": {
            agent.config.apiKey = val;
            saveUserConfig({ apiKey: val }, agent.config.globalConfigPath);
            return { output: `${c.emerald("✓")} Set config.apiKey = ${maskApiKey(val)}` };
          }
          default:
            return { output: c.amber(`Unknown config key '${keyName}'.`) };
        }
      }

      const cfg = agent.config;
      return {
        output: [
          `${c.cyan("╭─")} ${c.bold("AivoCode Configuration & Subagent Routing")} ${c.cyan("─".repeat(31))}`,
          `${c.cyan("│")} ${c.slate("Config File     :")} ${c.white(cfg.globalConfigPath)}`,
          `${c.cyan("│")} ${c.slate("Gateway Base URL:")} ${c.white(cfg.baseUrl)} · Key: ${c.white(maskApiKey(cfg.apiKey))}`,
          `${c.cyan("├" + "─".repeat(74))}`,
          `${c.cyan("│")} ${c.bold("Models & Subagents:")}`,
          `${c.cyan("│")}   • ${c.bold("model          ")} (Primary Agent)   : ${c.emerald(c.bold(cfg.model))}`,
          `${c.cyan("│")}   • ${c.bold("fastModel      ")} (Explore Subagent): ${c.teal(cfg.fastModel ?? `${cfg.model} (inherited)`)}`,
          `${c.cyan("│")}   • ${c.bold("architectModel ")} (Stage 1 Design)  : ${c.teal(cfg.architectModel ?? `${cfg.model} (inherited)`)}`,
          `${c.cyan("│")}   • ${c.bold("builderModel   ")} (Stage 2 Builder) : ${c.teal(cfg.builderModel ?? `${cfg.model} (inherited)`)}`,
          `${c.cyan("│")}   • ${c.bold("reviewerModel  ")} (Stage 3/4 QA)    : ${c.teal(cfg.reviewerModel ?? `${cfg.model} (inherited)`)}`,
          `${c.cyan("├" + "─".repeat(74))}`,
          `${c.cyan("│")} ${c.bold("Execution & Behavior:")}`,
          `${c.cyan("│")}   • ${c.bold("strategy       ")} (Workflow Mode)   : ${c.cyan(cfg.strategy ?? "auto")} ${c.slate("(auto | subagent-driven | native | ask)")}`,
          `${c.cyan("│")}   • ${c.bold("team           ")} (Specialist Team) : ${c.amber(cfg.team ?? "fullstack")}`,
          `${c.cyan("│")}   • ${c.bold("mode           ")} (Permissions)     : ${c.amber(cfg.mode)} ${c.slate("(auto | plan | safe)")}`,
          `${c.cyan("│")}   • ${c.bold("wire           ")} (Protocol Wire)   : ${c.cyan(cfg.wire)} ${c.slate("(chat | messages | responses)")}`,
          `${c.cyan("│")}   • ${c.bold("reasoningEffort")} (Primary Effort)  : ${c.violet(cfg.reasoningEffort)}`,
          `${c.cyan("│")}   • ${c.bold("subagentEffort ")} (Subagent Effort) : ${c.violet(cfg.subagentEffort ?? "low")}`,
          `${c.cyan("│")}   • ${c.bold("autoReviewFix  ")} (Review-Fix Gate) : ${cfg.autoReviewFix !== false ? c.emerald("true") : c.slate("false")}`,
          `${c.cyan("├" + "─".repeat(74))}`,
          `${c.cyan("│")} ${c.slate("Quick Commands:")}`,
          `${c.cyan("│")}   ${c.cyan("/model <id>")} · ${c.cyan("/subagent <explore|architect|builder|reviewer|all> <id>")}`,
          `${c.cyan("│")}   ${c.cyan("/strategy <auto|subagent-driven|native|ask>")} · ${c.cyan("/config <key> <value>")}`,
          `${c.cyan("╰" + "─".repeat(74))}`,
        ].join("\n"),
      };
    }

    case "/effort": {
      let level = arg.toLowerCase() as ReasoningEffort;
      if (!arg && interactive) {
        const picked = await interactiveSelect<ReasoningEffort>({
          title: "Select Reasoning Effort Level",
          initialValue: agent.config.reasoningEffort,
          items: [
            { value: "minimal", label: "minimal", detail: "Fastest responses, minimal thinking tokens" },
            { value: "low", label: "low", detail: "Light reasoning for quick edits" },
            { value: "medium", label: "medium", detail: "Balanced reasoning for daily coding (default)" },
            { value: "high", label: "high", detail: "Deep multi-file architectural reasoning" },
            { value: "xhigh", label: "xhigh", detail: "Extended reasoning for complex debugging" },
            { value: "max", label: "max", detail: "Maximum thinking budget supported by model" },
            { value: "off", label: "off", detail: "Disable reasoning / thinking blocks" },
          ],
        });
        if (!picked) return { output: c.slate("Effort selection cancelled.") };
        level = picked;
      }
      if (!VALID_EFFORTS.has(level)) {
        return {
          output: `Current effort: ${c.violet(agent.config.reasoningEffort)}. Valid levels: ${[...VALID_EFFORTS].join(", ")}`,
        };
      }
      agent.config.reasoningEffort = level;
      saveUserConfig({ reasoningEffort: level }, agent.config.globalConfigPath);
      return { output: `${c.emerald("✓")} Reasoning effort set to: ${c.bold(c.violet(level))}` };
    }

    case "/wire": {
      let w = arg.toLowerCase() as AivoWire;
      if (!arg && interactive) {
        const picked = await interactiveSelect<AivoWire>({
          title: "Select AivoKey Protocol Wire",
          initialValue: agent.config.wire,
          items: [
            { value: "chat", label: "chat", detail: "POST /v1/chat/completions (OpenAI Chat Completions)" },
            { value: "messages", label: "messages", detail: "POST /v1/messages (Anthropic Messages + ephemeral cache + server web tools)" },
            { value: "responses", label: "responses", detail: "POST /v1/responses (OpenAI Responses + hosted web_search)" },
          ],
        });
        if (!picked) return { output: c.slate("Wire selection cancelled.") };
        w = picked;
      }
      if (!VALID_WIRES.has(w)) {
        return {
          output: `Current wire: ${c.cyan(agent.config.wire)}. Valid wires: chat, messages, responses`,
        };
      }
      agent.config.wire = w;
      agent.session.wire = w;
      saveUserConfig({ wire: w }, agent.config.globalConfigPath);
      return { output: `${c.emerald("✓")} Switched AivoKey wire protocol to: ${c.bold(c.cyan(w))}` };
    }

    case "/mode": {
      let m = arg.toLowerCase() as PermissionMode;
      if (!arg && interactive) {
        const picked = await interactiveSelect<PermissionMode>({
          title: "Select Agent Permission Mode",
          initialValue: agent.config.mode,
          items: [
            { value: "auto", label: "auto", detail: "Full autonomous coding agent (read, edit, write, shell)" },
            { value: "safe", label: "safe", detail: "Ask confirmation before file mutations or shell commands" },
            { value: "plan", label: "plan", detail: "Read-only Architect Mode (explores & plans without touching files)" },
          ],
        });
        if (!picked) return { output: c.slate("Mode selection cancelled.") };
        m = picked;
      }
      if (!VALID_MODES.has(m)) {
        return {
          output: `Current mode: ${c.amber(agent.config.mode)}. Valid modes: auto, safe, plan`,
        };
      }
      agent.config.mode = m;
      saveUserConfig({ mode: m }, agent.config.globalConfigPath);
      return { output: `${c.emerald("✓")} Permission mode set to: ${c.bold(c.amber(m))}` };
    }

    case "/web": {
      const toggle = arg.toLowerCase();
      agent.config.webSearch =
        toggle === "on" || toggle === "true" || toggle === "1"
          ? true
          : toggle === "off" || toggle === "false" || toggle === "0"
            ? false
            : !agent.config.webSearch;
      saveUserConfig({ webSearch: agent.config.webSearch }, agent.config.globalConfigPath);
      return {
        output: `${c.emerald("✓")} AivoKey server web search: ${agent.config.webSearch ? c.emerald("ON") : c.slate("OFF")}`,
      };
    }

    case "/login": {
      if (!arg) {
        return {
          output: `Usage: ${c.cyan("/login sk-aivo_YOUR_KEY")} — verifies your key, detects models available on your plan/account, and configures default models.`,
        };
      }
      const cleanKey = arg.trim();
      agent.config.apiKey = cleanKey;
      try {
        const [models, verified] = await Promise.all([
          fetchModels(agent.config.baseUrl, fetchFn).catch(() => agent.catalog),
          inspectKey(agent.config.baseUrl, cleanKey, fetchFn),
        ]);
        if (models.length > 0) agent.catalog = models;
        const eligible = filterEligibleModelsForAccount(
          agent.catalog.length > 0 ? agent.catalog : DEFAULT_AIVOKEY_CATALOG,
          verified,
          { toolsOnly: true },
        );
        const defaultModelId = eligible.some((m) => m.id === "deepseek-v4.1-flash")
          ? "deepseek-v4.1-flash"
          : (eligible[0]?.id ?? "deepseek-v4.1-flash");

        agent.config.model = defaultModelId;
        agent.config.fastModel = defaultModelId;
        saveUserConfig(
          {
            apiKey: cleanKey,
            model: agent.config.model,
            fastModel: agent.config.fastModel,
            setupCompleted: true,
          },
          agent.config.globalConfigPath,
        );
        return {
          output: [
            `${c.emerald("✓")} API key verified: ${formatKeyStatusSummary(verified)}`,
            `${c.emerald("✓")} Eligible models for your account: ${c.bold(String(eligible.length))} models (${verified.mode === "plan" && !verified.fallbackEnabled ? "filtered to active plan & free tokens" : "all active catalog models"})`,
            `${c.emerald("✓")} Primary & Subagent default model set to: ${c.bold(c.emerald(defaultModelId))} (use /model, /subagent, or Ctrl+O to customize)`,
          ].join("\n"),
          updatedKeyStatus: verified,
        };
      } catch (err) {
        saveUserConfig({ apiKey: cleanKey }, agent.config.globalConfigPath);
        return {
          output: `${c.amber("⚠")} Saved key (${maskApiKey(cleanKey)}), but verification failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    case "/subagents":
    case "/inspect": {
      const runs = agent.subagentRuns;
      if (runs.length === 0) {
        return { output: c.slate("No subagent runs recorded in this session yet.") };
      }
      if (arg) {
        const target = runs.find((r) => r.id === arg.trim());
        if (!target) {
          return { output: c.amber(`Subagent '${arg}' not found. Available: ${runs.map((r) => r.id).join(", ")}`) };
        }
        return {
          output: [
            `${c.cyan("╭─")} ${c.bold(`Subagent ${target.id}: ${target.name} (${target.model} · ${target.status})`)}`,
            ...target.logs.map((l) => `${c.cyan("│")} ${l}`),
            `${c.cyan("╰" + "─".repeat(72))}`,
          ].join("\n"),
        };
      }
      return {
        output: [
          `${c.cyan("◆")} ${c.bold(`Session Subagents (${runs.length}) — run '/inspect <id>' to view full work:`)}`,
          ...runs.map(
            (r) =>
              `  • ${c.bold(c.cyan(r.id.padEnd(8)))} [${r.status}] ${c.white(r.name)} (${c.emerald(r.model)}) — ${c.slate(r.description)}`,
          ),
        ].join("\n"),
      };
    }

    case "/jobs":
    case "/ps": {
      const jobs = agent.backgroundJobs.listJobs();
      if (jobs.length === 0) {
        return { output: c.slate("No background terminal jobs. Start one with '/bg <command>' or run_shell(background:true).") };
      }
      return {
        output: [
          `${c.cyan("◆")} ${c.bold(`Background Terminal Jobs (${jobs.length}):`)}`,
          ...jobs.map(
            (j) =>
              `  • ${c.bold(c.cyan(j.id.padEnd(7)))} [PID ${j.pid ?? "-"} · ${j.status}] ${c.white(j.command)}${j.detectedUrl ? ` → ${c.emerald(j.detectedUrl)}` : ""}`,
          ),
        ].join("\n"),
      };
    }

    case "/bg": {
      if (!arg) {
        return { output: `Usage: ${c.cyan("/bg <command>")} — starts a background terminal job.` };
      }
      const job = agent.backgroundJobs.startJob({ command: arg, cwd: agent.config.cwd });
      return {
        output: `${c.emerald("✓")} Started background terminal ${c.bold(c.cyan(job.id))} (PID ${job.pid ?? "-"}): ${arg}`,
      };
    }

    case "/logs": {
      if (!arg) {
        return { output: `Usage: ${c.cyan("/logs <job_id>")} — displays captured stdout/stderr for a background job.` };
      }
      const job = agent.backgroundJobs.getJob(arg.trim());
      if (!job) {
        return { output: c.amber(`Background job '${arg}' not found.`) };
      }
      return {
        output: [
          `${c.cyan("╭─")} ${c.bold(`Logs for ${job.id} (${job.status}) — ${job.command}`)}`,
          ...(job.logs.length > 0 ? job.logs.slice(-40).map((l) => `${c.cyan("│")} ${l}`) : [`${c.cyan("│")} (no output yet)`]),
          `${c.cyan("╰" + "─".repeat(72))}`,
        ].join("\n"),
      };
    }

    case "/kill": {
      if (!arg) {
        return { output: `Usage: ${c.cyan("/kill <job_id>")} — terminates a background terminal job.` };
      }
      const ok = agent.backgroundJobs.killJob(arg.trim());
      return {
        output: ok
          ? `${c.emerald("✓")} Stopped background job ${c.bold(arg.trim())}.`
          : c.amber(`Background job '${arg}' not found.`),
      };
    }

    case "/status":
    case "/usage":
    case "/key": {
      let liveKey = keyStatus;
      if (agent.config.apiKey && (!liveKey || interactive)) {
        try {
          liveKey = await inspectKey(agent.config.baseUrl, agent.config.apiKey, fetchFn);
        } catch {
          /* fall back to cached keyStatus */
        }
      }
      return {
        output: formatDetailedStatus(agent, liveKey),
        updatedKeyStatus: liveKey,
      };
    }

    case "/compact": {
      const res = agent.compactNow();
      return {
        output: `${c.emerald("✓")} Compacted session history: ${res.beforeTokens.toLocaleString("en-US")} → ${res.afterTokens.toLocaleString("en-US")} estimated tokens.`,
      };
    }

    case "/undo": {
      const res = agent.checkpoints.undoLastTurn();
      if (res.restoredFiles.length === 0) {
        return { output: c.slate("Nothing to undo.") };
      }
      return {
        output: `${c.emerald("✓")} Reverted ${res.restoredFiles.length} file(s) from ${res.turnId} (use /redo to restore):\n${res.restoredFiles.map((f) => `  • ${c.white(f)}`).join("\n")}`,
      };
    }

    case "/redo": {
      const res = agent.checkpoints.redoLastUndo();
      if (res.restoredFiles.length === 0) {
        return { output: c.slate("Nothing to redo.") };
      }
      return {
        output: `${c.emerald("✓")} Restored ${res.restoredFiles.length} file(s) from ${res.turnId}:\n${res.restoredFiles.map((f) => `  • ${c.white(f)}`).join("\n")}`,
      };
    }

    case "/team":
    case "/agents": {
      let chosenTeam = arg.toLowerCase() as TeamId;
      if (!arg && interactive) {
        const picked = await interactiveSelect<TeamId>({
          title: "Select Specialist Agent Team & Workflow",
          initialValue: agent.config.team ?? "fullstack",
          items: AGENT_TEAMS.map((t) => ({
            value: t.id,
            label: t.id,
            badge: `[${t.roles.map((r) => r.badge).join("→")}]`,
            detail: `${t.name} — ${t.description.slice(0, 56)}`,
          })),
        });
        if (!picked) return { output: c.slate("Team selection cancelled.") };
        chosenTeam = picked;
      }
      if (!VALID_TEAMS.has(chosenTeam)) {
        const list = AGENT_TEAMS.map(
          (t) =>
            `  ${t.id === (agent.config.team ?? "fullstack") ? c.emerald("❯") : " "} ${c.bold(c.cyan(t.id.padEnd(12)))} ${c.white(t.name)} ${c.slate(`[${t.roles.map((r) => r.badge).join(" → ")}]`)}`,
        ).join("\n");
        return {
          output: `Active team: ${c.emerald(agent.config.team ?? "fullstack")}\nAvailable Specialist Teams:\n${list}\nUsage: ${c.cyan("/team <fullstack|backend|frontend|android|blender3d|gamedev|autopilot>")}`,
        };
      }
      agent.config.team = chosenTeam;
      saveUserConfig({ team: chosenTeam }, agent.config.globalConfigPath);
      const t = getAgentTeam(chosenTeam)!;
      return {
        output: [
          `${c.emerald("✓")} Activated Specialist Team: ${c.bold(c.emerald(t.name))} (${t.id})`,
          `  Roles   : ${t.roles.map((r) => `${c.cyan(r.name)} [${r.badge}]`).join(" → ")}`,
          `  Workflow: ${t.workflowStages.map((s) => s.title).join(" → ")}`,
        ].join("\n"),
      };
    }

    case "/workflow": {
      if (!arg) {
        return {
          output: `Usage: ${c.cyan("/workflow <goal>")} — runs the active team's (${agent.config.team ?? "fullstack"}) multi-stage Architect → Builder → QA workflow.`,
        };
      }
      const summary = await agent.executeTeamWorkflow(arg, agent.config.team);
      return { output: summary };
    }

    case "/btw": {
      if (!arg) {
        return {
          output: `Usage: ${c.cyan("/btw <question>")} — asks a quick side question without adding to session history.`,
        };
      }
      const answer = await agent.askSideQuestion(arg);
      return {
        output: `${c.cyan("╭─ /btw Side Answer ───────────────────────────────────────────────────────")}\n${answer}\n${c.cyan("╰──────────────────────────────────────────────────────────────────────────")}`,
      };
    }

    case "/skills": {
      agent.skills.refresh();
      const list = agent.skills.listSkills();
      if (list.length === 0) {
        return { output: c.slate("No skills discovered in .aivokey, .opencode, .dsh, or .claude.") };
      }
      return {
        output: [
          `${c.cyan("◆")} ${c.bold(`Discovered Skills (${list.length}):`)}`,
          ...list.map(
            (s) => `  • ${c.bold(c.emerald(s.id.padEnd(28)))} ${c.slate(s.description.slice(0, 72))}`,
          ),
        ].join("\n"),
      };
    }

    case "/memory": {
      const entries = arg
        ? agent.memory.recall(arg, agent.config.cwd, 10)
        : agent.memory.listAll().slice(-10);
      if (entries.length === 0) {
        return { output: c.slate("No self-learning memories recorded yet.") };
      }
      return {
        output: [
          `${c.cyan("◆")} ${c.bold(`Self-Learning Memory (${entries.length}):`)}`,
          ...entries.map(
            (m) => `  • [${c.violet(m.category)}] ${c.bold(c.white(m.title))}: ${c.slate(m.content)}`,
          ),
        ].join("\n"),
      };
    }

    case "/audit": {
      const files = agent.checkpoints.listModifiedFiles();
      if (files.length === 0) {
        return { output: c.emerald("✓ No modified files in session (clean).") };
      }
      const issues = files
        .filter((f) => existsSync(f) && statSync(f).isFile())
        .flatMap((f) => {
          const rep = auditCodeForSlop(relative(agent.config.cwd, f), readFileSync(f, "utf8"));
          return rep.issues.map((i) => `  • ${rep.filePath}:${i.line} [${i.severity}] ${i.message}`);
        });
      if (issues.length === 0) {
        return { output: c.emerald(`✓ Anti-AI-Slop Audit passed (${files.length} file(s) clean).`) };
      }
      return {
        output: `${c.amber(`⚠ Anti-AI-Slop Audit found ${issues.length} issue(s):`)}\n${issues.join("\n")}`,
      };
    }

    case "/screenshot": {
      const res = await executeComputerUse({ action: "screenshot" });
      if (res.screenshotAttachment) {
        agent.session.messages.push({
          role: "user",
          content: "Desktop screenshot attached by user via /screenshot:",
          images: [res.screenshotAttachment],
        });
      }
      return { output: `${c.emerald("✓")} ${res.output}` };
    }

    case "/diff": {
      try {
        const diff = execSync("git status -s", { cwd: agent.config.cwd, encoding: "utf8" }).trim();
        const touched = agent.checkpoints.listModifiedFiles();
        return {
          output: [
            `${c.cyan("◆")} ${c.bold(`Session Checkpointed Files (${touched.length}):`)}`,
            ...(touched.length > 0 ? touched.map((f) => `  • ${c.white(f)}`) : [`  ${c.slate("(none)")}`]),
            "",
            `${c.cyan("◆")} ${c.bold("Git Working Tree:")}`,
            diff ? diff.split("\n").map((l) => `  ${l}`).join("\n") : `  ${c.slate("(clean)")}`,
          ].join("\n"),
        };
      } catch {
        return { output: c.amber("Unable to run git status in this directory.") };
      }
    }

    case "/todo":
      return { output: renderTodoBoard(agent.todos) };

    case "/fork": {
      agent.sessionStore.saveSession(agent.session);
      const forked = agent.sessionStore.forkSession(agent.session.id);
      if (!forked) {
        return { output: c.rose("Failed to fork session.") };
      }
      agent.session = forked;
      return {
        output: `${c.emerald("✓")} Forked conversation into new sticky session: ${c.bold(c.cyan(forked.id))}`,
      };
    }

    case "/clear":
    case "/new": {
      agent.session = agent.sessionStore.createSession({
        model: agent.config.model,
        wire: agent.config.wire,
        cwd: agent.config.cwd,
      });
      agent.todos.length = 0;
      return { output: `${c.emerald("✓")} Started fresh session: ${c.bold(c.cyan(agent.session.id))}` };
    }

    case "/sessions": {
      const list = agent.sessionStore.listSessions(15);
      if (list.length === 0) return { output: c.slate("No saved sessions found.") };
      if (interactive) {
        const picked = await interactiveSelect({
          title: "Resume Saved Session",
          initialValue: agent.session.id,
          items: list.map((s) => ({
            value: s.id,
            label: s.id,
            badge: `[${s.model}]`,
            detail: `${s.messageCount} msgs · ${formatMicroUsd(BigInt(s.totalCostMicro || "0"))} · ${s.updatedAt.slice(0, 19).replace("T", " ")}`,
          })),
        });
        if (picked) {
          const loaded = agent.sessionStore.loadSession(picked);
          if (loaded) {
            agent.session = loaded;
            agent.config.model = loaded.model;
            return { output: `${c.emerald("✓")} Resumed session ${c.bold(c.cyan(loaded.id))} (${loaded.messages.length} messages)` };
          }
        }
        return { output: c.slate("Session resume cancelled.") };
      }
      return {
        output: list
          .map(
            (s) =>
              `${c.cyan(s.id)}  [${c.emerald(s.model)}]  msgs=${s.messageCount}  cost=${formatMicroUsd(BigInt(s.totalCostMicro || "0"))}  ${c.slate(s.updatedAt)}`,
          )
          .join("\n"),
      };
    }

    case "/exit":
    case "/quit":
      return { output: c.slate("Session saved. Goodbye!"), shouldExit: true };

    default:
      return {
        output: c.amber(`Unknown command '${cmd}'. Type /help for available commands.`),
      };
  }
}

export async function startInteractiveRepl(
  agent: AivoAgent,
  initialKeyStatus: KeyInspectStatus | null,
  fetchFn: typeof fetch = fetch,
  onStartTurnSpinner?: (label: string) => void,
  onStopTurnSpinner?: () => void,
): Promise<void> {
  let keyStatus = initialKeyStatus;
  let workspaceFiles = walkWorkspaceFiles(agent.config.cwd);
  let gitBranch = getGitBranchLabel(agent.config.cwd);
  const history: string[] = [];

  stdout.write(
    "\n" +
      renderHeaderBanner({
        version: "0.3.0",
        cwd: agent.config.cwd,
        gitBranch,
        gatewayUrl: agent.config.baseUrl,
        model: agent.config.model,
        fastModel: agent.config.fastModel,
        wire: agent.config.wire,
        effort: agent.config.reasoningEffort,
        mode: agent.config.mode,
        sessionId: agent.session.id,
        keyStatus,
      }) +
      "\n",
  );

  // First-run onboarding wizard if no API key is configured
  if (!agent.config.apiKey && stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    stdout.write(
      `\n${c.cyan("◆")} ${c.bold("Welcome to AivoCode!")} ${c.slate("Let's connect your AivoKey account.")}\n` +
        `  ${c.slate("Get your API key at:")} ${c.cyan("https://app.aivokey.dev/console/keys")}\n`,
    );
    try {
      const enteredKey = (
        await rl.question(
          `  ${c.emerald("❯")} Paste your AivoKey API Key (${c.dim("sk-aivo_... or Enter to skip")}): `,
        )
      ).trim();
      rl.close();
      if (enteredKey) {
        agent.config.apiKey = enteredKey;
        saveUserConfig({ apiKey: enteredKey }, agent.config.globalConfigPath);
        const spinner = new TerminalSpinner();
        spinner.start("Verifying API key & syncing AivoKey catalog...");
        try {
          const [models, ks] = await Promise.all([
            fetchModels(agent.config.baseUrl, fetchFn).catch(() => agent.catalog),
            inspectKey(agent.config.baseUrl, enteredKey, fetchFn),
          ]);
          spinner.stop();
          if (models.length > 0) agent.catalog = models;
          keyStatus = ks;
          const rec = recommendCodingModels(agent.catalog, keyStatus, agent.config.model);
          agent.config.model = rec.primaryModel;
          agent.config.fastModel = rec.fastModel;
          saveUserConfig(
            { model: rec.primaryModel, fastModel: rec.fastModel },
            agent.config.globalConfigPath,
          );
          stdout.write(
            `  ${c.emerald("✓")} Connected! ${formatKeyStatusSummary(ks)}\n` +
              `  ${c.emerald("✓")} Selected model: ${c.bold(c.emerald(agent.config.model))} ${c.slate(`(fast explorer: ${agent.config.fastModel})`)}\n`,
          );
        } catch (err) {
          spinner.stop();
          stdout.write(
            `  ${c.amber("⚠")} Could not verify key (${err instanceof Error ? err.message : String(err)}). You can retry anytime with ${c.cyan("/login <key>")}.\n`,
          );
        }
      }
    } catch {
      rl.close();
    }
  }

  while (true) {
    const action = await readInteractiveComposerLine({
      getState: () => {
        const sysPrompt = buildSystemPrompt(agent.config.cwd, agent.config.mode);
        const usedCtx = estimateConversationTokens(sysPrompt, agent.session.messages);
        const modelInfo = agent.getActiveModelInfo();
        const maxCtx = modelInfo?.contextWindow ?? 128_000;
        const totalPrompt = agent.session.totalInputTokens + agent.session.totalCacheReadTokens;
        const cacheHitPct =
          totalPrompt > 0
            ? Math.round((agent.session.totalCacheReadTokens / totalPrompt) * 100)
            : 0;
        return {
          mode: agent.config.mode,
          model: agent.config.model,
          effort: agent.config.reasoningEffort,
          wire: agent.config.wire,
          usedContextTokens: usedCtx,
          maxContextTokens: maxCtx,
          cacheHitPct,
          sessionCostMicro: BigInt(agent.session.totalCostMicro || "0"),
          balanceMicro: keyStatus?.balanceMicro ?? null,
          gitBranch,
          workspaceFiles,
        };
      },
      onHotkeyChange: (next) => {
        agent.config.mode = next.mode;
        agent.config.reasoningEffort = next.effort;
        agent.config.wire = next.wire;
        agent.session.wire = next.wire;
        saveUserConfig(
          {
            mode: next.mode,
            reasoningEffort: next.effort,
            wire: next.wire,
          },
          agent.config.globalConfigPath,
        );
      },
      history,
    });

    if (action.type === "exit") {
      stdout.write(`\n${c.slate("Session saved. Goodbye!")}\n`);
      break;
    }

    if (action.type === "open_model_picker") {
      const res = await handleSlashCommand("/model", agent, keyStatus, fetchFn, true);
      stdout.write(res.output + "\n");
      continue;
    }

    if (action.type === "open_status") {
      const res = await handleSlashCommand("/status", agent, keyStatus, fetchFn, true);
      if (res.updatedKeyStatus !== undefined) keyStatus = res.updatedKeyStatus;
      stdout.write(res.output + "\n");
      continue;
    }

    const line = action.line.trim();
    if (!line) continue;
    if (history[history.length - 1] !== line) {
      history.push(line);
    }

    if (line.startsWith("!")) {
      const shellCmd = line.slice(1).trim();
      if (shellCmd) {
        stdout.write(`${c.slate(`$ ${shellCmd}`)}\n`);
        try {
          const out = execSync(shellCmd, {
            cwd: agent.config.cwd,
            encoding: "utf8",
            stdio: "pipe",
          });
          if (out) stdout.write(out.trimEnd() + "\n");
        } catch (err) {
          stdout.write(
            `${c.rose(`Command failed: ${err instanceof Error ? err.message : String(err)}`)}\n`,
          );
        }
        gitBranch = getGitBranchLabel(agent.config.cwd);
      }
      continue;
    }

    if (line.startsWith("/")) {
      const res = await handleSlashCommand(line, agent, keyStatus, fetchFn, true);
      if (res.updatedKeyStatus !== undefined) {
        keyStatus = res.updatedKeyStatus;
      }
      stdout.write(res.output + "\n");
      if (res.shouldExit) break;
      continue;
    }

    // Run agent turn with Esc / Ctrl+C stream interruption listener
    const abortCtrl = new AbortController();
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    const onStreamKey = (
      _str: string | undefined,
      key: { name?: string; ctrl?: boolean } | undefined,
    ) => {
      if (key?.name === "escape" || (key?.ctrl && key?.name === "c")) {
        abortCtrl.abort();
      }
    };
    stdin.on("keypress", onStreamKey);

    onStartTurnSpinner?.(`Waiting for ${agent.config.model} (Esc to interrupt)...`);

    try {
      const turnRes = await agent.runUserPrompt(line, abortCtrl.signal);
      onStopTurnSpinner?.();
      workspaceFiles = walkWorkspaceFiles(agent.config.cwd);
      gitBranch = getGitBranchLabel(agent.config.cwd);

      const totalIn = turnRes.turnUsage.inputTokens + turnRes.turnUsage.cacheReadTokens;
      const cachePct =
        totalIn > 0 ? Math.round((turnRes.turnUsage.cacheReadTokens / totalIn) * 100) : 0;
      const savedTag =
        turnRes.turnCacheSavedMicro > 0n
          ? ` · ${c.teal(`saved ${formatMicroUsd(turnRes.turnCacheSavedMicro)}`)}`
          : "";

      stdout.write(
        `\n${c.slate(`  ↳ in=${turnRes.turnUsage.inputTokens.toLocaleString("en-US")} · cache=${turnRes.turnUsage.cacheReadTokens.toLocaleString("en-US")} (${cachePct}%) · out=${turnRes.turnUsage.outputTokens.toLocaleString("en-US")} · turn=${formatMicroUsd(turnRes.turnCostMicro)}${savedTag}`)}\n`,
      );
    } catch (err) {
      onStopTurnSpinner?.();
      if (abortCtrl.signal.aborted) {
        stdout.write(`\n${c.amber("⚠ Generation interrupted by user (Esc).")}\n`);
      } else if (
        err &&
        typeof (err as { formatUserAdvice?: unknown }).formatUserAdvice === "function"
      ) {
        stdout.write(
          `\n${c.rose("✗")} ${c.bold((err as { formatUserAdvice(): string }).formatUserAdvice())}\n`,
        );
      } else {
        stdout.write(
          `\n${c.rose("✗")} ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    } finally {
      stdin.off("keypress", onStreamKey);
      if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
    }
  }
}
