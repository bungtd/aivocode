import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { execSync } from "node:child_process";
import {
  maskApiKey,
  matchCatalogModelId,
  saveUserConfig,
  VALID_EFFORTS,
  VALID_MODES,
  VALID_WIRES,
  type AivoWire,
  type PermissionMode,
  type ReasoningEffort,
} from "./config.js";
import {
  fetchModels,
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
      let chosenId = arg
        ? matchCatalogModelId(
            arg,
            agent.catalog.map((m) => m.id),
          )
        : "";
      if (!chosenId && interactive && agent.catalog.length > 0) {
        const picked = await interactiveSelect({
          title: "Select Active AivoKey Model",
          initialValue: agent.config.model,
          items: agent.catalog.map((m) => {
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
          output: `Current model: ${c.emerald(c.bold(agent.config.model))}. Usage: ${c.cyan("/model <canonical-id>")}`,
        };
      }

      const found = agent.catalog.find((m) => m.id === chosenId);
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
          `${c.emerald("✓")} Switched active model to ${c.bold(c.emerald(chosenId))}`,
          ...warnings,
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
          output: `Usage: ${c.cyan("/login sk-aivo_YOUR_KEY")} — saves and verifies your AivoKey API key immediately.`,
        };
      }
      const cleanKey = arg.trim();
      agent.config.apiKey = cleanKey;
      saveUserConfig({ apiKey: cleanKey }, agent.config.globalConfigPath);
      try {
        const verified = await inspectKey(agent.config.baseUrl, cleanKey, fetchFn);
        return {
          output: `${c.emerald("✓")} API key saved (${maskApiKey(cleanKey)}) & verified: ${formatKeyStatusSummary(verified)}`,
          updatedKeyStatus: verified,
        };
      } catch (err) {
        return {
          output: `${c.amber("⚠")} Saved key (${maskApiKey(cleanKey)}), but verification failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
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
        output: `${c.emerald("✓")} Reverted ${res.restoredFiles.length} file(s) from ${res.turnId}:\n${res.restoredFiles.map((f) => `  • ${c.white(f)}`).join("\n")}`,
      };
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
