import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { execSync } from "node:child_process";
import {
  normalizeModelId,
  saveUserConfig,
  VALID_EFFORTS,
  VALID_MODES,
  VALID_WIRES,
  type AivoWire,
  type PermissionMode,
  type ReasoningEffort,
} from "./config.js";
import {
  formatKeyStatusSummary,
  formatMicroUsd,
  inspectKey,
  isModelUsableByKey,
  type AivoModelInfo,
  type KeyInspectStatus,
} from "./aivokey-client.js";
import { formatTodoList } from "./tools/index.js";
import type { AivoAgent } from "./agent.js";

export interface SlashCommandResult {
  output: string;
  shouldExit?: boolean;
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
    return `No models matched '${filter ?? ""}'.`;
  }

  const lines: string[] = [
    "Model ID                  Ctx     In/Out ($/1M)   Badges",
    "──────────────────────────────────────────────────────────────────────────",
  ];

  for (const m of filtered) {
    const marker = m.id === activeModel ? "* " : "  ";
    const idCol = (marker + m.id).padEnd(25).slice(0, 25);
    const ctxCol = `${Math.round(m.contextWindow / 1000)}K`.padEnd(7);
    const inUsd = (Number(m.inputMicroPer1M) / 1_000_000).toFixed(2);
    const outUsd = (Number(m.outputMicroPer1M) / 1_000_000).toFixed(2);
    const priceCol = `$${inUsd}/$${outUsd}`.padEnd(15);

    const badges: string[] = [];
    if (m.supportsTools) badges.push("tools");
    if (m.supportsReasoning) badges.push("reasoning");
    if (m.supportsPromptCache) badges.push("cache");
    if (m.supportsVision) badges.push("vision");
    const free = keyStatus?.freeTokens.find((f) => f.model === m.id && f.remainingTokens > 0n);
    if (free) badges.push(`FREE:${Number(free.remainingTokens).toLocaleString()}`);
    if (keyStatus && !isModelUsableByKey(m.id, keyStatus)) badges.push("locked");

    lines.push(`${idCol} ${ctxCol} ${priceCol} [${badges.join(", ")}]`);
  }

  return lines.join("\n");
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
    `── AivoCode Status ────────────────────────────────────────────────────────`,
    `Gateway     : ${agent.config.baseUrl}`,
    `Session ID  : ${s.id} (sticky cache affinity active)`,
    `Model       : ${agent.config.model}${agent.config.fastModel ? ` (fast explorer: ${agent.config.fastModel})` : ""}`,
    `Wire / Mode : ${agent.config.wire} · mode=${agent.config.mode} · effort=${agent.config.reasoningEffort} · webSearch=${agent.config.webSearch ? "on" : "off"}`,
    `Session Use : in=${s.totalInputTokens.toLocaleString()} · cache_read=${s.totalCacheReadTokens.toLocaleString()} (${cacheHitPct}% hit) · out=${s.totalOutputTokens.toLocaleString()} · cost=${formatMicroUsd(BigInt(s.totalCostMicro || "0"))}`,
  ];

  if (keyStatus) {
    lines.push(`Account     : ${formatKeyStatusSummary(keyStatus)}`);
    if (keyStatus.mode === "plan" && keyStatus.models.length > 0) {
      lines.push(`Plan Windows:`);
      for (const m of keyStatus.models) {
        lines.push(
          `  - ${m.model}: 5h ${formatMicroUsd(m.w5h.usedMicro)}/${formatMicroUsd(m.w5h.limitMicro)} · month ${formatMicroUsd(m.month.usedMicro)}/${formatMicroUsd(m.month.limitMicro)}`,
        );
      }
    }
    if (keyStatus.mode === "plan" && keyStatus.global) {
      const g = keyStatus.global;
      lines.push(
        `Global Pool : 5h ${formatMicroUsd(g.w5h.usedMicro)}/${formatMicroUsd(g.w5h.limitMicro)} · month ${formatMicroUsd(g.month.usedMicro)}/${formatMicroUsd(g.month.limitMicro)}`,
      );
    }
  }

  return lines.join("\n");
}

export async function handleSlashCommand(
  line: string,
  agent: AivoAgent,
  keyStatus: KeyInspectStatus | null,
  fetchFn: typeof fetch = fetch,
): Promise<SlashCommandResult> {
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0]!.toLowerCase();
  const arg = parts.slice(1).join(" ").trim();

  switch (cmd) {
    case "/help":
      return {
        output: [
          "Available Slash Commands:",
          "  /models [filter]      List AivoKey models (try '/models --tools' or '/models --free')",
          "  /model <id>           Switch active canonical model (e.g. /model deepseek-v4-pro)",
          "  /effort <level>       Set reasoning effort (minimal|low|medium|high|xhigh|max|off)",
          "  /wire <type>          Switch AivoKey wire (chat|messages|responses)",
          "  /mode <mode>          Switch permission mode (auto|safe|plan)",
          "  /web <on|off>         Toggle AivoKey server-side web search",
          "  /status | /key        Inspect live AivoKey balance, free tokens, plan windows & session stats",
          "  /compact              Compact conversation history to free up context window",
          "  /undo                 Revert file changes from the last turn via checkpoints",
          "  /diff                 Show git status & modified files in this session",
          "  /todo                 Display active task checklist",
          "  /fork                 Fork current conversation into a new session ID",
          "  /clear | /new         Start a fresh session",
          "  /exit | /quit         Exit AivoCode",
          "",
          "Shortcuts:",
          "  @path/to/file.ts      Attach numbered file contents directly to your prompt",
          "  !<shell command>      Run a terminal command directly without spending tokens",
        ].join("\n"),
      };

    case "/models":
      return {
        output: formatModelsTable(agent.catalog, agent.config.model, keyStatus, arg),
      };

    case "/model": {
      if (!arg) {
        return { output: `Current model: ${agent.config.model}. Usage: /model <canonical-id>` };
      }
      const nextId = normalizeModelId(arg);
      const found = agent.catalog.find((m) => m.id === nextId);
      const warnings: string[] = [];
      if (found && !found.supportsTools) {
        warnings.push(`Warning: '${nextId}' does not advertise tool calling; agentic file edits may not work.`);
      }
      if (keyStatus && !isModelUsableByKey(nextId, keyStatus)) {
        warnings.push(`Warning: '${nextId}' may not be covered by your active plan/free tokens unless balance fallback is on.`);
      }
      agent.config.model = nextId;
      agent.session.model = nextId;
      saveUserConfig({ model: nextId }, agent.config.globalConfigPath);
      return {
        output: [`Switched active model to: ${nextId}`, ...warnings].join("\n"),
      };
    }

    case "/effort": {
      const level = arg.toLowerCase() as ReasoningEffort;
      if (!VALID_EFFORTS.has(level)) {
        return {
          output: `Current effort: ${agent.config.reasoningEffort}. Valid levels: ${[...VALID_EFFORTS].join(", ")}`,
        };
      }
      agent.config.reasoningEffort = level;
      saveUserConfig({ reasoningEffort: level }, agent.config.globalConfigPath);
      return { output: `Reasoning effort set to: ${level}` };
    }

    case "/wire": {
      const w = arg.toLowerCase() as AivoWire;
      if (!VALID_WIRES.has(w)) {
        return {
          output: `Current wire: ${agent.config.wire}. Valid wires: chat, messages, responses`,
        };
      }
      agent.config.wire = w;
      agent.session.wire = w;
      saveUserConfig({ wire: w }, agent.config.globalConfigPath);
      return { output: `Switched AivoKey wire protocol to: ${w}` };
    }

    case "/mode": {
      const m = arg.toLowerCase() as PermissionMode;
      if (!VALID_MODES.has(m)) {
        return {
          output: `Current mode: ${agent.config.mode}. Valid modes: auto, safe, plan`,
        };
      }
      agent.config.mode = m;
      saveUserConfig({ mode: m }, agent.config.globalConfigPath);
      return { output: `Permission mode set to: ${m}` };
    }

    case "/web": {
      const toggle = arg.toLowerCase();
      agent.config.webSearch =
        toggle === "on" || toggle === "true" || toggle === "1"
          ? true
          : toggle === "off" || toggle === "false" || toggle === "0"
            ? false
            : !agent.config.webSearch;
      return { output: `AivoKey server web search: ${agent.config.webSearch ? "ON" : "OFF"}` };
    }

    case "/status":
    case "/usage":
    case "/key": {
      let liveKey = keyStatus;
      if (!liveKey && agent.config.apiKey) {
        try {
          liveKey = await inspectKey(agent.config.baseUrl, agent.config.apiKey, fetchFn);
        } catch {
          /* use cached */
        }
      }
      return { output: formatDetailedStatus(agent, liveKey) };
    }

    case "/compact": {
      const c = agent.compactNow();
      return {
        output: `Compacted session history: ${c.beforeTokens.toLocaleString()} -> ${c.afterTokens.toLocaleString()} estimated tokens.`,
      };
    }

    case "/undo": {
      const res = agent.checkpoints.undoLastTurn();
      if (res.restoredFiles.length === 0) {
        return { output: "Nothing to undo." };
      }
      return {
        output: `Reverted ${res.restoredFiles.length} file(s) from ${res.turnId}:\n${res.restoredFiles.map((f) => `  - ${f}`).join("\n")}`,
      };
    }

    case "/diff": {
      try {
        const diff = execSync("git status -s", { cwd: agent.config.cwd, encoding: "utf8" }).trim();
        const touched = agent.checkpoints.listModifiedFiles();
        return {
          output: [
            `Session touched files (${touched.length}):`,
            ...(touched.length > 0 ? touched.map((f) => `  - ${f}`) : ["  (none)"]),
            "",
            "Git status:",
            diff || "  (working tree clean)",
          ].join("\n"),
        };
      } catch {
        return { output: "Unable to run git status in this directory." };
      }
    }

    case "/todo":
      return { output: formatTodoList(agent.todos) };

    case "/fork": {
      agent.sessionStore.saveSession(agent.session);
      const forked = agent.sessionStore.forkSession(agent.session.id);
      if (!forked) {
        return { output: "Failed to fork session." };
      }
      agent.session = forked;
      return { output: `Forked conversation into new sticky session: ${forked.id}` };
    }

    case "/clear":
    case "/new": {
      agent.session = agent.sessionStore.createSession({
        model: agent.config.model,
        wire: agent.config.wire,
        cwd: agent.config.cwd,
      });
      agent.todos.length = 0;
      return { output: `Started fresh session: ${agent.session.id}` };
    }

    case "/sessions": {
      const list = agent.sessionStore.listSessions(10);
      if (list.length === 0) return { output: "No saved sessions found." };
      return {
        output: list
          .map(
            (s) =>
              `${s.id}  [${s.model}]  msgs=${s.messageCount}  cost=${formatMicroUsd(BigInt(s.totalCostMicro || "0"))}  ${s.updatedAt}`,
          )
          .join("\n"),
      };
    }

    case "/exit":
    case "/quit":
      return { output: "Goodbye!", shouldExit: true };

    default:
      return {
        output: `Unknown command '${cmd}'. Type /help for available commands.`,
      };
  }
}

export async function startInteractiveRepl(
  agent: AivoAgent,
  initialKeyStatus: KeyInspectStatus | null,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const keySummary = initialKeyStatus
    ? formatKeyStatusSummary(initialKeyStatus)
    : "API key not verified yet (/status)";

  stdout.write(
    [
      `╭──────────────────────────────────────────────────────────────────────────╮`,
      `│ AivoCode — Native CLI Coding Harness for AivoKey                         │`,
      `╰──────────────────────────────────────────────────────────────────────────╯`,
      `  Gateway : ${agent.config.baseUrl}`,
      `  Model   : ${agent.config.model} (wire=${agent.config.wire}, effort=${agent.config.reasoningEffort}, mode=${agent.config.mode})`,
      `  Account : ${keySummary}`,
      `  Tip     : Type /help for commands, @file to attach files, !cmd for shell`,
      ``,
    ].join("\n") + "\n",
  );

  try {
    while (true) {
      const promptLabel = `\n[${agent.config.model} · ${agent.config.mode}] > `;
      let line: string;
      try {
        line = (await rl.question(promptLabel)).trim();
      } catch {
        break;
      }
      if (!line) continue;

      if (line.startsWith("!")) {
        const shellCmd = line.slice(1).trim();
        if (shellCmd) {
          try {
            const out = execSync(shellCmd, {
              cwd: agent.config.cwd,
              encoding: "utf8",
              stdio: "pipe",
            });
            if (out) stdout.write(out + "\n");
          } catch (err) {
            stdout.write(
              `Command failed: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
        continue;
      }

      if (line.startsWith("/")) {
        const res = await handleSlashCommand(line, agent, initialKeyStatus, fetchFn);
        stdout.write(res.output + "\n");
        if (res.shouldExit) break;
        continue;
      }

      try {
        let inReasoning = false;
        const turnRes = await agent.runUserPrompt(line);
        void inReasoning;
        const totalIn = turnRes.turnUsage.inputTokens + turnRes.turnUsage.cacheReadTokens;
        const cachePct =
          totalIn > 0 ? Math.round((turnRes.turnUsage.cacheReadTokens / totalIn) * 100) : 0;
        stdout.write(
          `\n  [tokens: in=${turnRes.turnUsage.inputTokens} · cache=${turnRes.turnUsage.cacheReadTokens} (${cachePct}%) · out=${turnRes.turnUsage.outputTokens} · cost=${formatMicroUsd(turnRes.turnCostMicro)}${turnRes.turnCacheSavedMicro > 0n ? ` (saved ${formatMicroUsd(turnRes.turnCacheSavedMicro)})` : ""}]\n`,
        );
      } catch (err) {
        if (err && typeof (err as { formatUserAdvice?: unknown }).formatUserAdvice === "function") {
          stdout.write(`\nError: ${(err as { formatUserAdvice(): string }).formatUserAdvice()}\n`);
        } else {
          stdout.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    }
  } finally {
    rl.close();
  }
}
