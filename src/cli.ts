import {
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
  fetchModels,
  formatMicroUsd,
  inspectKey,
  recommendCodingModels,
  type AivoModelInfo,
  type KeyInspectStatus,
} from "./aivokey-client.js";
import { AivoAgent } from "./agent.js";
import { formatDetailedStatus, formatModelsTable, startInteractiveRepl } from "./repl.js";
import { SessionStore } from "./session.js";

export type CliCommand =
  | "repl"
  | "run"
  | "models"
  | "status"
  | "doctor"
  | "login"
  | "sessions"
  | "help";

export interface ParsedCliArgs {
  command: CliCommand;
  prompt: string;
  filter: string;
  sessionId?: string;
  continueLast?: boolean;
  json?: boolean;
  cliConfig: Partial<UserConfigFile>;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const cliConfig: Partial<UserConfigFile> = {};
  const positionals: string[] = [];
  let sessionId: string | undefined;
  let continueLast = false;
  let json = false;
  let explicitPrompt: string | undefined;
  let filterFlag = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-p" || arg === "--prompt") {
      explicitPrompt = argv[++i] ?? "";
    } else if (arg === "-m" || arg === "--model") {
      cliConfig.model = normalizeModelId(argv[++i]);
    } else if (arg === "--fast-model") {
      cliConfig.fastModel = normalizeModelId(argv[++i]);
    } else if (arg === "--wire") {
      cliConfig.wire = (argv[++i] ?? "chat") as AivoWire;
    } else if (arg === "--effort") {
      cliConfig.reasoningEffort = (argv[++i] ?? "medium") as ReasoningEffort;
    } else if (arg === "--mode") {
      cliConfig.mode = (argv[++i] ?? "auto") as PermissionMode;
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
    command: "repl",
    prompt: positionals.join(" "),
    filter: filterFlag,
    sessionId,
    continueLast,
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

  if (parsed.command === "help") {
    writeOut(
      [
        "AivoCode (`aivo`) — Native CLI Coding Harness for AivoKey",
        "",
        "Usage:",
        "  aivo                          Start interactive coding REPL",
        "  aivo run \"<prompt>\"           Run a coding task non-interactively",
        "  aivo -p \"<prompt>\"            Alias for `aivo run`",
        "  aivo models [--tools|--free]  List live AivoKey models, prices & capabilities",
        "  aivo status                   Inspect live AivoKey balance, free tokens & plan quota",
        "  aivo doctor                   Verify AivoKey gateway connectivity, key & model setup",
        "  aivo login <sk-aivo_...>      Save your AivoKey API key to ~/.aivokey/config.json",
        "  aivo sessions                 List recent saved sessions",
        "",
        "Flags:",
        "  -m, --model <id>              Canonical model ID (e.g. deepseek-v4-pro, glm-5.3)",
        "  --fast-model <id>             Fast model for explore subagents",
        "  --wire <chat|messages|responses> Protocol wire (default: chat)",
        "  --effort <minimal..max|off>   Reasoning effort level (default: medium)",
        "  --mode <auto|safe|plan>       Permission mode (default: auto)",
        "  --base-url <url>              AivoKey gateway URL (default: https://api.aivokey.dev)",
        "  --api-key <key>               AivoKey API key (or set AIVOKEY_API_KEY)",
        "  --web-search                  Enable AivoKey server-side web search",
        "  -c, --continue                Resume most recent session",
        "  -s, --session <id>            Resume specific session ID",
      ].join("\n"),
    );
    return 0;
  }

  if (parsed.command === "login") {
    const keyToSave = parsed.prompt || config.apiKey;
    if (!keyToSave) {
      writeOut("Usage: aivo login <sk-aivo_...> [--base-url https://api.aivokey.dev]");
      return 1;
    }
    saveUserConfig(
      {
        apiKey: keyToSave,
        baseUrl: config.baseUrl,
        model: config.model,
      },
      config.globalConfigPath,
    );
    writeOut(
      `Saved AivoKey configuration to ${config.globalConfigPath} (key: ${maskApiKey(keyToSave)}, gateway: ${config.baseUrl})`,
    );
    return 0;
  }

  // Load live catalog and key status best-effort
  let catalog: AivoModelInfo[] = [];
  let keyStatus = null as KeyInspectStatus | null;
  let catalogErr = null as string | null;
  let keyErr = null as string | null;

  await Promise.all([
    fetchModels(config.baseUrl, fetchFn)
      .then((m) => {
        catalog = m;
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

  if (catalog.length > 0 && !config.fastModel) {
    const rec = recommendCodingModels(catalog, keyStatus, config.model);
    config.fastModel = rec.fastModel;
  }

  if (parsed.command === "models") {
    writeOut(formatModelsTable(catalog, config.model, keyStatus, parsed.filter));
    return 0;
  }

  if (parsed.command === "doctor") {
    writeOut("── AivoCode Doctor ────────────────────────────────────────────────────────");
    writeOut(`Gateway Origin : ${config.baseUrl}`);
    writeOut(`API Key        : ${maskApiKey(config.apiKey)}`);
    writeOut(
      `Model Catalog  : ${catalogErr ? `FAILED (${catalogErr})` : `OK (${catalog.length} canonical models loaded)`}`,
    );
    if (!config.apiKey) {
      writeOut(`Key Inspection : MISSING (set AIVOKEY_API_KEY or run 'aivo login <key>')`);
    } else if (keyErr) {
      writeOut(`Key Inspection : FAILED (${keyErr})`);
    } else if (keyStatus) {
      writeOut(`Key Inspection : OK (mode=${keyStatus.mode}, balance=${formatMicroUsd(keyStatus.balanceMicro)})`);
    }
    const rec = recommendCodingModels(catalog, keyStatus, config.model);
    writeOut(`Active Model   : ${config.model} (recommended fast subagent: ${rec.fastModel})`);
    return catalogErr || keyErr ? 1 : 0;
  }

  const sessionStore = new SessionStore();
  let initialSession = parsed.sessionId ? sessionStore.loadSession(parsed.sessionId) ?? undefined : undefined;
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
          `${s.id}  [${s.model}]  msgs=${s.messageCount}  cost=${formatMicroUsd(BigInt(s.totalCostMicro || "0"))}  ${s.updatedAt}`,
        );
      }
    }
    return 0;
  }

  const agent = new AivoAgent({
    config,
    catalog,
    sessionStore,
    session: initialSession,
    fetchFn,
    callbacks: {
      onReasoningDelta: (d) => {
        if (!parsed.json) process.stderr.write(`\x1b[2m${d}\x1b[0m`);
      },
      onTextDelta: (d) => {
        if (!parsed.json) process.stdout.write(d);
      },
      onToolCall: (name, args) => {
        if (!parsed.json) {
          const argPreview = JSON.stringify(args).slice(0, 100);
          process.stderr.write(`\n\x1b[36m▸ ${name}\x1b[0m(${argPreview})\n`);
        }
      },
      onNotice: (msg) => {
        if (!parsed.json) process.stderr.write(`\n\x1b[33m[notice] ${msg}\x1b[0m\n`);
      },
    },
  });

  if (parsed.command === "status") {
    writeOut(formatDetailedStatus(agent, keyStatus));
    return 0;
  }

  if (parsed.command === "run") {
    if (!config.apiKey) {
      writeOut("Error: AIVOKEY_API_KEY is not set. Run `aivo login <sk-aivo_...>` or pass `--api-key`.");
      return 1;
    }
    const res = await agent.runUserPrompt(parsed.prompt);
    if (parsed.json) {
      writeOut(
        JSON.stringify({
          sessionId: agent.session.id,
          model: agent.config.model,
          text: res.finalText,
          steps: res.steps,
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

  await startInteractiveRepl(agent, keyStatus, fetchFn);
  return 0;
}
