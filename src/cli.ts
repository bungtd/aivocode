import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  DEFAULT_FAST_MODEL,
  DEFAULT_MODEL,
  maskApiKey,
  normalizeGatewayOrigin,
  normalizeModelId,
  resolveConfig,
  saveUserConfig,
  type AivoWire,
  type PermissionMode,
  type ReasoningEffort,
  type UserConfigFile,
} from "./config.js";
import {
  DEFAULT_AIVOKEY_CATALOG,
  fetchModels,
  filterEligibleModelsForAccount,
  formatKeyStatusSummary,
  formatMicroUsd,
  inspectKey,
  recommendCodingModels,
  type AivoModelInfo,
  type KeyInspectStatus,
} from "./aivokey-client.js";
import { interactiveSelect } from "./ui/select.js";
import { AivoAgent } from "./agent.js";
import { formatDetailedStatus, formatModelsTable, startInteractiveRepl } from "./repl.js";
import { startFullScreenTui } from "./ui/fullscreen.js";
import { AIVO_CLIENT_VERSION } from "./client-identity.js";
import { AGENT_TEAMS, type TeamId } from "./teams.js";
import { SessionStore } from "./session.js";
import {
  c,
  renderTodoBoard,
  renderToolCallCard,
  TerminalSpinner,
} from "./ui/theme.js";
import { renderUnifiedDiff } from "./ui/markdown.js";
import { interactiveConfirmBar } from "./ui/composer.js";

export type CliCommand =
  | "repl"
  | "mini"
  | "run"
  | "workflow"
  | "teams"
  | "config"
  | "models"
  | "status"
  | "doctor"
  | "login"
  | "sessions"
  | "version"
  | "help";

export interface ParsedCliArgs {
  command: CliCommand;
  prompt: string;
  filter: string;
  sessionId?: string;
  continueLast?: boolean;
  mini?: boolean;
  json?: boolean;
  cliConfig: Partial<UserConfigFile>;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const cliConfig: Partial<UserConfigFile> = {};
  const positionals: string[] = [];
  let sessionId: string | undefined;
  let continueLast = false;
  let mini = false;
  let json = false;
  let explicitPrompt: string | undefined;
  let filterFlag = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-p" || arg === "--prompt") {
      explicitPrompt = argv[++i] ?? "";
    } else if (arg === "-m" || arg === "--model") {
      cliConfig.model = normalizeModelId(argv[++i]);
    } else if (arg === "--fast-model" || arg === "--subagent-model") {
      cliConfig.fastModel = normalizeModelId(argv[++i]);
    } else if (arg === "--architect-model") {
      cliConfig.architectModel = normalizeModelId(argv[++i]);
    } else if (arg === "--builder-model") {
      cliConfig.builderModel = normalizeModelId(argv[++i]);
    } else if (arg === "--reviewer-model") {
      cliConfig.reviewerModel = normalizeModelId(argv[++i]);
    } else if (arg === "--strategy") {
      cliConfig.strategy = (argv[++i] ?? "auto") as UserConfigFile["strategy"];
    } else if (arg === "--wire") {
      cliConfig.wire = (argv[++i] ?? "chat") as AivoWire;
    } else if (arg === "--effort") {
      cliConfig.reasoningEffort = (argv[++i] ?? "off") as ReasoningEffort;
    } else if (arg === "--mode") {
      cliConfig.mode = (argv[++i] ?? "auto") as PermissionMode;
    } else if (arg === "--team" || arg === "-t") {
      cliConfig.team = (argv[++i] ?? "fullstack") as TeamId;
    } else if (arg === "--mini") {
      mini = true;
    } else if (arg === "--base-url") {
      cliConfig.baseUrl = normalizeGatewayOrigin(argv[++i]);
    } else if (arg === "--api-key") {
      cliConfig.apiKey = (argv[++i] ?? "").trim();
    } else if (arg === "--session" || arg === "-s") {
      sessionId = argv[++i];
    } else if (arg === "--continue" || arg === "-c") {
      continueLast = true;
    } else if (arg === "--web-search") {
      cliConfig.webSearch = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--tools") {
      filterFlag = "--tools";
    } else if (arg === "--free") {
      filterFlag = "--free";
    } else if (arg === "-h" || arg === "--help") {
      positionals.unshift("help");
    } else if (arg === "-v" || arg === "--version") {
      positionals.unshift("version");
    } else {
      positionals.push(arg);
    }
  }

  if (explicitPrompt !== undefined) {
    return {
      command: "run",
      prompt: explicitPrompt,
      filter: filterFlag,
      sessionId,
      continueLast,
      json,
      cliConfig,
    };
  }

  const first = (positionals[0] ?? "").toLowerCase();
  if (first === "mini") {
    return {
      command: "mini",
      prompt: positionals.slice(1).join(" "),
      filter: filterFlag,
      sessionId,
      continueLast,
      mini: true,
      json,
      cliConfig,
    };
  }
  if (first === "workflow") {
    return {
      command: "workflow",
      prompt: positionals.slice(1).join(" "),
      filter: filterFlag,
      sessionId,
      continueLast,
      mini,
      json,
      cliConfig,
    };
  }
  if (first === "teams") {
    return {
      command: "teams",
      prompt: "",
      filter: filterFlag,
      sessionId,
      continueLast,
      mini,
      json,
      cliConfig,
    };
  }
  if (first === "config" || first === "settings") {
    return {
      command: "config",
      prompt: positionals.slice(1).join(" "),
      filter: filterFlag,
      sessionId,
      continueLast,
      mini,
      json,
      cliConfig,
    };
  }
  if (first === "version") {
    return {
      command: "version",
      prompt: "",
      filter: filterFlag,
      sessionId,
      continueLast,
      json,
      cliConfig,
    };
  }
  if (first === "run") {
    return {
      command: "run",
      prompt: positionals.slice(1).join(" "),
      filter: filterFlag,
      sessionId,
      continueLast,
      json,
      cliConfig,
    };
  }
  if (first === "models") {
    return {
      command: "models",
      prompt: "",
      filter: filterFlag || positionals.slice(1).join(" "),
      sessionId,
      continueLast,
      json,
      cliConfig,
    };
  }
  if (first === "status" || first === "key" || first === "usage") {
    return {
      command: "status",
      prompt: "",
      filter: "",
      sessionId,
      continueLast,
      json,
      cliConfig,
    };
  }
  if (first === "doctor") {
    return {
      command: "doctor",
      prompt: "",
      filter: "",
      sessionId,
      continueLast,
      json,
      cliConfig,
    };
  }
  if (first === "login" || first === "auth") {
    return {
      command: "login",
      prompt: positionals[1] ?? "",
      filter: "",
      sessionId,
      continueLast,
      json,
      cliConfig,
    };
  }
  if (first === "sessions") {
    return {
      command: "sessions",
      prompt: "",
      filter: "",
      sessionId,
      continueLast,
      json,
      cliConfig,
    };
  }
  if (first === "help") {
    return {
      command: "help",
      prompt: "",
      filter: "",
      sessionId,
      continueLast,
      json,
      cliConfig,
    };
  }

  return {
    command: mini ? "mini" : "repl",
    prompt: positionals.join(" "),
    filter: filterFlag,
    sessionId,
    continueLast,
    mini,
    json,
    cliConfig,
  };
}

export interface RunCliOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
  fetchFn?: typeof fetch;
  writeOut?: (text: string) => void;
}

export async function runCli(argv: string[], opts: RunCliOptions = {}): Promise<number> {
  const parsed = parseCliArgs(argv);
  const writeOut = opts.writeOut ?? ((text: string) => process.stdout.write(text + "\n"));
  const fetchFn = opts.fetchFn ?? fetch;

  const config = resolveConfig({
    cwd: opts.cwd,
    env: opts.env,
    globalConfigPath: opts.globalConfigPath,
    cli: parsed.cliConfig,
  });
  if (parsed.command === "run" && !parsed.cliConfig.team) {
    delete config.team;
  }

  if (parsed.command === "version") {
    writeOut(`aivocode ${AIVO_CLIENT_VERSION}`);
    return 0;
  }

  if (parsed.command === "help") {
    writeOut(
      [
        `${c.cyan(c.bold("◆ AivoCode (`aivo`) v1.0"))} — Native AI Coding Studio for AivoKey`,
        "",
        c.bold("Usage:"),
        "  aivo                          Launch Interactive TUI Studio",
        "  aivo mini                     Launch compact inline terminal mode",
        "  aivo run \"<prompt>\"           Run a coding task non-interactively",
        "  aivo -p \"<prompt>\"            Alias for `aivo run`",
        "  aivo workflow \"<goal>\"        Execute a multi-stage Specialist Agent Team workflow",
        "  aivo teams                    List all 7 specialist Agent Teams (Full-Stack, Backend, Frontend, Android, Blender 3D, GameDev, Autopilot)",
        "  aivo models [--tools|--free]  List live AivoKey models, prices & capabilities",
        "  aivo status                   Inspect live AivoKey balance, free tokens & plan quota",
        "  aivo doctor                   Verify AivoKey gateway connectivity, key & model setup",
        "  aivo login <sk-aivo_...>      Save your AivoKey API key to ~/.aivokey/config.json",
        "  aivo sessions                 List recent saved sessions",
        "",
        c.bold("Flags:"),
        "  -m, --model <id>              Canonical model ID (default: deepseek-v4-flash)",
        "  --fast-model <id>             Fast model for explore subagents",
        "  -t, --team <id>               Specialist team (fullstack|backend|frontend|android|blender3d|gamedev|autopilot)",
        "  --wire <chat|messages|responses> Protocol wire (default: chat)",
        "  --effort <off|minimal..max>   Reasoning effort level (default: off for instant streaming)",
        "  --mode <auto|safe|plan>       Permission mode (default: auto)",
        "  --mini                        Use inline terminal mode instead of TUI Studio",
        "  --base-url <url>              AivoKey gateway URL (default: https://api.aivokey.dev)",
        "  --api-key <key>               AivoKey API key (or set AIVOKEY_API_KEY)",
        "  -c, --continue                Resume most recent session",
        "  -s, --session <id>            Resume specific session ID",
      ].join("\n"),
    );
    return 0;
  }

  if (parsed.command === "teams") {
    writeOut(`${c.cyan("╭─")} ${c.bold("AivoCode Specialist Agent Teams & Workflows")} ${c.cyan("─".repeat(28))}`);
    for (const t of AGENT_TEAMS) {
      writeOut(
        `${c.cyan("│")} ${c.bold(c.emerald(t.id.padEnd(11)))} ${c.bold(c.white(t.name))} ${c.slate(`[${t.roles.map((r) => r.badge).join(" → ")}]`)}`,
      );
      writeOut(`${c.cyan("│")}   ${c.slate(t.description)}`);
      writeOut(
        `${c.cyan("│")}   ${c.teal("Stages:")} ${c.dim(t.workflowStages.map((s) => s.title).join("  →  "))}`,
      );
      writeOut(`${c.cyan("├" + "─".repeat(74))}`);
    }
    writeOut(`${c.cyan("╰" + "─".repeat(74))}`);
    return 0;
  }

  if (parsed.command === "login") {
    const keyToSave = parsed.prompt || config.apiKey;
    if (!keyToSave) {
      writeOut("Usage: aivo login <sk-aivo_...> [--base-url https://api.aivokey.dev]");
      return 1;
    }

    let loginCatalog: AivoModelInfo[] = DEFAULT_AIVOKEY_CATALOG;
    let loginKeyStatus = null as KeyInspectStatus | null;
    await Promise.all([
      fetchModels(config.baseUrl, fetchFn)
        .then((m) => {
          if (m.length > 0) loginCatalog = m;
        })
        .catch(() => {}),
      inspectKey(config.baseUrl, keyToSave, fetchFn)
        .then((k) => {
          loginKeyStatus = k;
        })
        .catch(() => {}),
    ]);

    const eligible = filterEligibleModelsForAccount(loginCatalog, loginKeyStatus, {
      toolsOnly: true,
    });
    const fallbackDefault = eligible.some((m) => m.id === DEFAULT_MODEL)
      ? DEFAULT_MODEL
      : (eligible[0]?.id ?? DEFAULT_MODEL);

    let chosenPrimary = parsed.cliConfig.model ?? fallbackDefault;
    let chosenFast = parsed.cliConfig.fastModel ?? DEFAULT_FAST_MODEL;
    if (!eligible.some((m) => m.id === chosenFast)) {
      chosenFast = chosenPrimary;
    }
    let chosenEffort: ReasoningEffort = parsed.cliConfig.reasoningEffort ?? "off";
    let chosenSubEffort: ReasoningEffort = "low";

    if (stdin.isTTY && stdout.isTTY && !opts.writeOut) {
      writeOut(
        `\n${c.emerald("✓")} Verified AivoKey Account: ${loginKeyStatus ? formatKeyStatusSummary(loginKeyStatus) : "Connected"}`,
      );
      writeOut(
        `  ${c.cyan("◆")} Detected ${c.bold(String(eligible.length))} eligible models for your account (${loginKeyStatus?.mode === "plan" && !loginKeyStatus.fallbackEnabled ? "Plan-filtered" : "All active models"}).\n`,
      );

      const pickedPrimary = await interactiveSelect({
        title: "Step 1/4: Select Default Primary Agent Model (Enter for deepseek-v4.1-flash)",
        initialValue: fallbackDefault,
        items: eligible.map((m) => ({
          value: m.id,
          label: m.id,
          badge: m.id === DEFAULT_MODEL ? "[Default]" : undefined,
          detail: `${Math.round(m.contextWindow / 1000)}K ctx`,
        })),
      });
      if (pickedPrimary) chosenPrimary = pickedPrimary;

      const pickedEffort = await interactiveSelect<ReasoningEffort>({
        title: "Step 2/4: Select Primary Reasoning Effort",
        initialValue: "off",
        items: [
          { value: "off", label: "off", detail: "Fastest direct streaming" },
          { value: "low", label: "low", detail: "Light thinking" },
          { value: "medium", label: "medium", detail: "Balanced reasoning" },
          { value: "high", label: "high", detail: "Deep architectural reasoning" },
          { value: "xhigh", label: "xhigh", detail: "Extended reasoning" },
          { value: "max", label: "max", detail: "Maximum thinking budget" },
        ],
      });
      if (pickedEffort) chosenEffort = pickedEffort;

      const pickedFast = await interactiveSelect({
        title: "Step 3/4: Select Default Subagent / Fast Model (Enter for deepseek-v4.1-flash)",
        initialValue: eligible.some((m) => m.id === DEFAULT_FAST_MODEL)
          ? DEFAULT_FAST_MODEL
          : chosenPrimary,
        items: eligible.map((m) => ({
          value: m.id,
          label: m.id,
          badge: m.id === DEFAULT_FAST_MODEL ? "[Default]" : undefined,
          detail: `${Math.round(m.contextWindow / 1000)}K ctx`,
        })),
      });
      if (pickedFast) chosenFast = pickedFast;

      const pickedSubEffort = await interactiveSelect<ReasoningEffort>({
        title: "Step 4/4: Select Subagent Reasoning Effort",
        initialValue: "low",
        items: [
          { value: "off", label: "off", detail: "No thinking delay on subagents" },
          { value: "low", label: "low", detail: "Light reasoning (Recommended)" },
          { value: "medium", label: "medium", detail: "Balanced reasoning" },
          { value: "high", label: "high", detail: "Deep reasoning" },
          { value: "max", label: "max", detail: "Maximum thinking budget" },
        ],
      });
      if (pickedSubEffort) chosenSubEffort = pickedSubEffort;
    }

    saveUserConfig(
      {
        apiKey: keyToSave,
        baseUrl: config.baseUrl,
        model: chosenPrimary,
        fastModel: chosenFast,
        reasoningEffort: chosenEffort,
        subagentEffort: chosenSubEffort,
        setupCompleted: true,
      },
      config.globalConfigPath,
    );
    writeOut(
      `${c.emerald("✓")} Saved AivoKey configuration to ${config.globalConfigPath}\n` +
        `  • Key            : ${maskApiKey(keyToSave)}\n` +
        `  • Gateway        : ${config.baseUrl}\n` +
        `  • Primary Model  : ${c.bold(c.emerald(chosenPrimary))} (effort: ${chosenEffort})\n` +
        `  • Subagent Model : ${c.bold(c.teal(chosenFast))} (effort: ${chosenSubEffort})`,
    );
    return 0;
  }

  let catalog: AivoModelInfo[] = DEFAULT_AIVOKEY_CATALOG;
  let keyStatus = null as KeyInspectStatus | null;
  let catalogErr = null as string | null;
  let keyErr = null as string | null;

  const isFastRun =
    parsed.command === "run" &&
    DEFAULT_AIVOKEY_CATALOG.some((m) => m.id === config.model) &&
    !opts.fetchFn;

  if (!isFastRun) {
    const bootSpinner = new TerminalSpinner();
    if (!opts.writeOut) {
      bootSpinner.start("Connecting to AivoKey Gateway...");
    }

    await Promise.all([
      fetchModels(config.baseUrl, fetchFn)
        .then((m) => {
          if (m.length > 0) catalog = m;
        })
        .catch((e) => {
          catalogErr = e instanceof Error ? e.message : String(e);
        }),
      config.apiKey
        ? inspectKey(config.baseUrl, config.apiKey, fetchFn)
            .then((k) => {
              keyStatus = k;
            })
            .catch((e) => {
              keyErr = e instanceof Error ? e.message : String(e);
            })
        : Promise.resolve(),
    ]);

    bootSpinner.stop();
  }

  if (!config.fastModel) {
    config.fastModel = DEFAULT_FAST_MODEL;
  }

  if (parsed.command === "models") {
    writeOut(formatModelsTable(catalog, config.model, keyStatus, parsed.filter));
    return 0;
  }

  if (parsed.command === "doctor") {
    writeOut(`${c.cyan("╭─")} ${c.bold("AivoCode Doctor")} ${c.cyan("─".repeat(55))}`);
    writeOut(`${c.cyan("│")} Gateway Origin : ${c.white(config.baseUrl)}`);
    writeOut(`${c.cyan("│")} API Key        : ${c.white(maskApiKey(config.apiKey))}`);
    writeOut(
      `${c.cyan("│")} Model Catalog  : ${catalogErr ? c.rose(`FAILED (${catalogErr})`) : c.emerald(`OK (${catalog.length} canonical models loaded)`)}`,
    );
    if (!config.apiKey) {
      writeOut(
        `${c.cyan("│")} Key Inspection : ${c.amber("MISSING (set AIVOKEY_API_KEY or run 'aivo login <key>')")}`,
      );
    } else if (keyErr) {
      writeOut(`${c.cyan("│")} Key Inspection : ${c.rose(`FAILED (${keyErr})`)}`);
    } else if (keyStatus) {
      writeOut(
        `${c.cyan("│")} Key Inspection : ${c.emerald(`OK (mode=${keyStatus.mode}, balance=${formatMicroUsd(keyStatus.balanceMicro)})`)}`,
      );
    }
    const rec = recommendCodingModels(catalog, keyStatus, config.model);
    writeOut(
      `${c.cyan("│")} Active Model   : ${c.emerald(config.model)} (recommended fast subagent: ${c.teal(rec.fastModel)})`,
    );
    writeOut(`${c.cyan("╰" + "─".repeat(73))}`);
    return catalogErr || keyErr ? 1 : 0;
  }

  const sessionStore = new SessionStore();
  let initialSession = parsed.sessionId
    ? (sessionStore.loadSession(parsed.sessionId) ?? undefined)
    : undefined;
  if (!initialSession && parsed.continueLast) {
    const recent = sessionStore.listSessions(1)[0];
    if (recent) initialSession = sessionStore.loadSession(recent.id) ?? undefined;
  }

  if (parsed.command === "sessions") {
    const list = sessionStore.listSessions(15);
    if (list.length === 0) {
      writeOut("No saved sessions found.");
    } else {
      for (const s of list) {
        writeOut(
          `${c.cyan(s.id)}  [${c.emerald(s.model)}]  msgs=${s.messageCount}  cost=${formatMicroUsd(BigInt(s.totalCostMicro || "0"))}  ${c.slate(s.updatedAt)}`,
        );
      }
    }
    return 0;
  }

  let inThinkingBlock = false;
  let thinkingStartMs = 0;
  const turnSpinner = new TerminalSpinner();

  const agent = new AivoAgent({
    config,
    catalog,
    sessionStore,
    session: initialSession,
    fetchFn,
    callbacks: {
      onReasoningDelta: (d) => {
        if (parsed.json) return;
        turnSpinner.stop();
        if (!inThinkingBlock) {
          inThinkingBlock = true;
          thinkingStartMs = Date.now();
          process.stderr.write(
            `\n${c.slate(`╭─ 💭 Thinking (${config.reasoningEffort}) ──────────────────────────────`)}\n${c.slate("│ ")}`,
          );
        }
        const formatted = d.replace(/\n/g, `\n${c.slate("│ ")}`);
        process.stderr.write(c.dim(formatted));
      },
      onTextDelta: (d) => {
        if (parsed.json) return;
        turnSpinner.stop();
        if (inThinkingBlock) {
          const secs = ((Date.now() - thinkingStartMs) / 1000).toFixed(1);
          process.stderr.write(
            `\n${c.slate(`╰─ Thought for ${secs}s ───────────────────────────────────────`)}\n\n`,
          );
          inThinkingBlock = false;
        }
        process.stdout.write(d);
      },
      onToolCall: (name, args) => {
        if (parsed.json) return;
        turnSpinner.stop();
        if (inThinkingBlock) {
          const secs = ((Date.now() - thinkingStartMs) / 1000).toFixed(1);
          process.stderr.write(
            `\n${c.slate(`╰─ Thought for ${secs}s ───────────────────────────────────────`)}\n`,
          );
          inThinkingBlock = false;
        }
        turnSpinner.start(`Running ${name}...`);
        void args;
      },
      onToolCallProgress: (target, bytes, lines) => {
        if (parsed.json) return;
        const kb = (bytes / 1024).toFixed(1);
        turnSpinner.update(`Streaming ${target} · ${lines} lines (${kb} KB)...`);
      },
      onToolResult: (name, _output, isError, details, args) => {
        if (parsed.json) return;
        turnSpinner.stop();
        const card = renderToolCallCard({
          name,
          args: args ?? {},
          status: isError ? "error" : "ok",
          durationMs: details?.durationMs,
          summary: details?.summary,
        });
        process.stderr.write(`\n${card}\n`);
        if (!isError && details?.diff) {
          process.stderr.write(
            renderUnifiedDiff(
              details.diff.filePath,
              details.diff.before,
              details.diff.after,
            ) + "\n",
          );
        }
        if (!isError && name === "todo_write") {
          process.stderr.write(renderTodoBoard(agent.todos) + "\n");
        }
      },
      onNotice: (msg) => {
        if (!parsed.json) {
          turnSpinner.stop();
          process.stderr.write(`\n${c.amber(`⚡ ${msg}`)}\n`);
        }
      },
      confirmAction: async (description) => {
        turnSpinner.stop();
        const decision = await interactiveConfirmBar(description);
        if (decision === "always") {
          agent.config.mode = "auto";
          return true;
        }
        return decision === "yes";
      },
    },
  });

  if (parsed.command === "status") {
    writeOut(formatDetailedStatus(agent, keyStatus));
    return 0;
  }

  if (parsed.command === "config") {
    const { handleSlashCommand } = await import("./repl.js");
    const cleanArg = parsed.prompt.replace(/^set\s+/i, "").trim();
    const res = await handleSlashCommand(
      cleanArg ? `/config ${cleanArg}` : "/config",
      agent,
      keyStatus,
      fetchFn,
      false,
    );
    writeOut(res.output);
    return 0;
  }

  if (parsed.command === "workflow") {
    if (!config.apiKey) {
      writeOut(
        "Error: AIVOKEY_API_KEY is not set. Run `aivo login <sk-aivo_...>` or pass `--api-key`.",
      );
      return 1;
    }
    const out = await agent.executeTeamWorkflow(parsed.prompt, config.team);
    writeOut(out);
    return 0;
  }

  if (parsed.command === "run") {
    if (!config.apiKey) {
      writeOut(
        "Error: AIVOKEY_API_KEY is not set. Run `aivo login <sk-aivo_...>` or pass `--api-key`.",
      );
      return 1;
    }
    const agentT0 = Date.now();
    const res = await agent.runUserPrompt(parsed.prompt);
    const agentTimeMs = Math.max(1, Date.now() - agentT0);
    if (parsed.json) {
      writeOut(
        JSON.stringify({
          sessionId: agent.session.id,
          model: agent.config.model,
          text: res.finalText,
          steps: res.steps,
          agentTimeMs,
          usage: res.turnUsage,
          costMicro: res.turnCostMicro.toString(),
          cacheSavedMicro: res.turnCacheSavedMicro.toString(),
        }),
      );
    } else {
      writeOut("");
    }
    return 0;
  }

  if (parsed.command === "mini" || parsed.mini) {
    await startInteractiveRepl(
      agent,
      keyStatus,
      fetchFn,
      (label) => turnSpinner.start(label),
      () => turnSpinner.stop(),
    );
    return 0;
  }

  await startFullScreenTui(agent, keyStatus, fetchFn, parsed.prompt);
  return 0;
}
