import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_FAST_MODEL,
  DEFAULT_MODEL,
  looksLikeApiKey,
  maskApiKey,
  normalizeGatewayOrigin,
  normalizeModelId,
  resolveConfig,
  saveConfigForWorkspace,
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
import { ShellSandbox, type NetworkAccess, type SandboxMode } from "./sandbox.js";
import { formatDetailedStatus, formatModelsTable, startInteractiveRepl } from "./repl.js";
import { startFullScreenTui } from "./ui/fullscreen.js";
import { AIVO_CLIENT_VERSION } from "./client-identity.js";
import { EVENT_STREAM_VERSION, createJsonlEventSink, toolEndEvent } from "./events.js";
import { Tracer } from "./telemetry.js";
import { checkForUpdate, formatUpdateNotice, runUpdate } from "./update.js";
import { AGENT_TEAMS, type TeamId } from "./teams.js";
import { SessionStore } from "./session.js";
import { McpManager } from "./mcp.js";
import { McpAuthStore } from "./mcp-oauth.js";
import { LspManager } from "./lsp.js";
import { HookRunner, loadCustomCommands } from "./hooks.js";
import { PluginRuntime } from "./plugins.js";
import {
  c,
  createTerminalSanitizer,
  renderTodoBoard,
  renderToolCallCard,
  sanitizeTerminalText,
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
  | "mcp"
  | "lsp"
  | "hooks"
  | "plugins"
  | "acp"
  | "trace"
  | "metrics"
  | "update"
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
  /** `aivo run --events-json`: newline-delimited JSON event stream. */
  eventsJson?: boolean;
  /** `aivo run --events-json`: include full tool output in events. */
  fullOutput?: boolean;
  /** `--trace <path>`: write a JSONL span trace. */
  tracePath?: string;
  /** `--metrics-json`: print Prometheus metrics at the end of a run. */
  metricsJson?: boolean;
  /** `--metrics-prom`: print Prometheus text at the end of a run. */
  metricsProm?: boolean;
  /** `aivo update --check`: report the newest release without installing. */
  checkUpdate?: boolean;
  cliConfig: Partial<UserConfigFile>;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const cliConfig: Partial<UserConfigFile> = {};
  const positionals: string[] = [];
  let sessionId: string | undefined;
  let continueLast = false;
  let mini = false;
  let json = false;
  let eventsJson = false;
  let fullOutput = false;
  let tracePath: string | undefined;
  let metricsJson = false;
  let metricsProm = false;
  let checkUpdate = false;
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
    } else if (arg === "--sandbox") {
      cliConfig.sandbox = (argv[++i] ?? "workspace") as SandboxMode;
    } else if (arg === "--no-worktrees") {
      cliConfig.worktreeIsolation = false;
    } else if (arg === "--worktrees") {
      cliConfig.worktreeIsolation = true;
    } else if (arg === "--network") {
      const network = (argv[++i] ?? "allow") as NetworkAccess;
      cliConfig.permissions = {
        ...(cliConfig.permissions ?? {}),
        network: network === "deny" ? "deny" : "allow",
      };
    } else if (arg === "--allow-outside-workspace") {
      cliConfig.permissions = {
        ...(cliConfig.permissions ?? {}),
        allowOutsideWorkspace: true,
      };
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
    } else if (arg === "--events-json") {
      eventsJson = true;
    } else if (arg === "--full-output") {
      fullOutput = true;
    } else if (arg === "--trace") {
      tracePath = argv[++i];
    } else if (arg === "--metrics-json") {
      metricsJson = true;
    } else if (arg === "--metrics-prom") {
      metricsProm = true;
    } else if (arg === "--check") {
      checkUpdate = true;
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
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
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
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
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
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
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
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
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
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
      cliConfig,
    };
  }
  if (first === "update" || first === "upgrade") {
    return {
      command: "update",
      prompt: "",
      filter: "",
      sessionId,
      continueLast,
      checkUpdate,
      json,
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
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
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
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
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
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
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
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
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
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
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
      cliConfig,
    };
  }
  if (first === "mcp") {
    return {
      command: "mcp",
      prompt: positionals.slice(1).join(" "),
      filter: "",
      sessionId,
      continueLast,
      json,
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
      cliConfig,
    };
  }

  if (first === "lsp") {
    return {
      command: "lsp",
      prompt: positionals.slice(1).join(" "),
      filter: "",
      sessionId,
      continueLast,
      json,
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
      cliConfig,
    };
  }
  if (first === "hooks") {
    return {
      command: "hooks",
      prompt: "",
      filter: "",
      sessionId,
      continueLast,
      json,
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
      cliConfig,
    };
  }
  if (first === "plugins") {
    return {
      command: "plugins",
      prompt: "",
      filter: "",
      sessionId,
      continueLast,
      json,
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
      cliConfig,
    };
  }
  if (first === "acp") {
    return {
      command: "acp",
      prompt: positionals.slice(1).join(" "),
      filter: "",
      sessionId,
      continueLast,
      json,
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
      cliConfig,
    };
  }
  if (first === "trace" || first === "metrics") {
    return {
      command: first,
      prompt: positionals.slice(1).join(" "),
      filter: "",
      sessionId,
      continueLast,
      json,
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
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
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
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
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
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
      eventsJson,
      fullOutput,
      tracePath,
      metricsJson,
      metricsProm,
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
  /** Diagnostics channel; the update notice goes here so stdout stays parseable. */
  writeErr?: (text: string) => void;
}

/**
 * The startup version notice.
 *
 * Deliberately conservative: only interactive launches ask, only once per day
 * (the answer is cached next to the user config), never in CI or when the user
 * opted out, and never on a non-TTY stdout where it would corrupt piped output.
 */
async function maybeUpdateNotice(
  parsed: ParsedCliArgs,
  options: { env?: Record<string, string | undefined>; fetchFn: typeof fetch; globalConfigPath?: string },
): Promise<string | null> {
  if (parsed.json) return null;
  if (parsed.command !== "repl" && parsed.command !== "mini" && !parsed.mini) return null;
  const env = options.env ?? process.env;
  if (env.CI || env.AIVO_NO_UPDATE_CHECK) return null;
  if (!process.stdout.isTTY) return null;
  try {
    const status = await checkForUpdate({
      currentVersion: AIVO_CLIENT_VERSION,
      fetchFn: options.fetchFn,
      globalConfigPath: options.globalConfigPath,
    });
    return formatUpdateNotice(status);
  } catch {
    return null;
  }
}

async function readPipedStdin(): Promise<string> {
  let text = "";
  for await (const chunk of stdin) {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
  }
  return text;
}

export async function runCli(argv: string[], opts: RunCliOptions = {}): Promise<number> {
  const parsed = parseCliArgs(argv);
  // `echo "..." | aivo` (or `cat prompt.txt | aivo`) behaves like a one-shot run.
  if (parsed.command === "repl" && !parsed.prompt && !opts.writeOut && !stdin.isTTY) {
    const piped = (await readPipedStdin()).trim();
    if (piped) {
      parsed.command = "run";
      parsed.prompt = piped;
    }
  }
  const writeOut = opts.writeOut ?? ((text: string) => process.stdout.write(text + "\n"));
  const writeErr = opts.writeErr ?? ((text: string) => process.stderr.write(text + "\n"));
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

  // One-shot commands cannot prompt for a key or a prompt, so fail fast before network work.
  if (parsed.command === "run" && !parsed.prompt.trim()) {
    writeOut('Usage: aivo run "<prompt>" (or aivo -p "<prompt>")');
    return 1;
  }
  if (parsed.command === "workflow" && !parsed.prompt.trim()) {
    writeOut('Usage: aivo workflow "<goal>" [--team <id>]');
    return 1;
  }
  if (
    (parsed.command === "run" || parsed.command === "workflow") &&
    !config.apiKey
  ) {
    writeOut(
      "Error: AIVOKEY_API_KEY is not set. Run `aivo login <sk-aivo_...>` or pass `--api-key`.",
    );
    return 1;
  }

  if (parsed.command === "help") {
    writeOut(
      [
        `${c.cyan(c.bold(`◆ AivoCode (\`aivo\`) v${AIVO_CLIENT_VERSION}`))} — Native AI Coding Studio for AivoKey`,
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
        "  aivo mcp [--json|restart [srv]]  Inspect or restart configured MCP servers/tools",
        "  aivo mcp auth [srv]           Authorize remote MCP servers with OAuth (PKCE + DCR)",
        "  aivo lsp [--json|restart [srv]]  Inspect or restart LSP servers for code intelligence",
        "  aivo hooks [--json]           Show lifecycle hooks and custom slash commands",
        "  aivo plugins [--json]         Show loaded plugins, plugin tools and plugin hooks",
        "  aivo acp                      Run the Agent Client Protocol server (editor integration)",
        "  aivo metrics [--json]         Print Prometheus or JSON metrics for the current process",
        "  aivo trace <trace.jsonl>      Summarize or export a recorded trace (--json)",
        "  aivo update [--check]         Upgrade to the newest release in place (no reinstall)",
        "",
        c.bold("Flags:"),
        `  -m, --model <id>              Canonical model ID (default: ${DEFAULT_MODEL})`,
        "  --fast-model <id>             Fast model for explore subagents",
        "  -t, --team <id>               Specialist team (fullstack|backend|frontend|android|blender3d|gamedev|autopilot)",
        "  --wire <chat|messages|responses> Protocol wire (default: chat)",
        "  --effort <off|minimal..max>   Reasoning effort level (default: off for instant streaming)",
        "  --mode <auto|safe|plan>       Permission mode (default: auto)",
        "  --sandbox <workspace|read-only|danger-full-access>",
        "                                OS/path sandbox policy (default: workspace)",
        "  --network <allow|deny>        Allow/deny network for permissions and shell sandbox",
        "  --allow-outside-workspace     Allow read/write outside the workspace without asking",
        "  --no-worktrees                Disable per-subagent git worktree isolation",
        "  --mini                        Use inline terminal mode instead of TUI Studio",
        "  --base-url <url>              AivoKey gateway URL (default: https://api.aivokey.dev)",
        "  --api-key <key>               AivoKey API key (or set AIVOKEY_API_KEY)",
        "  -c, --continue                Resume most recent session",
        "  -s, --session <id>            Resume specific session ID",
        "  --json                        Machine-readable final result for one-shot runs",
        "  --events-json                 Newline-delimited JSON event stream (headless/CI)",
        "  --full-output                 Include full tool output in --events-json",
      ].join("\n"),
    );
    return 0;
  }

  if (parsed.command === "update") {
    const { code } = await runUpdate({
      checkOnly: parsed.checkUpdate,
      json: parsed.json,
      currentVersion: AIVO_CLIENT_VERSION,
      fetchFn,
      globalConfigPath: opts.globalConfigPath,
      writeOut,
    });
    return code;
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

  if (parsed.command === "mcp") {
    const authMatch = parsed.prompt.match(/^auth(?:\s+(\S+))?$/i);
    if (authMatch) {
      const serverName = authMatch[1]?.trim();
      const servers = config.mcpServers ?? {};
      const names = serverName ? [serverName] : Object.keys(servers);
      if (names.length === 0) {
        writeOut("No MCP servers configured.");
        return 1;
      }
      const { authorizeMcpServer } = await import("./mcp-oauth.js");
      const authStore = new McpAuthStore(config.mcpAuthPath);
      let failed = false;
      for (const name of names) {
        const server = servers[name];
        if (!server?.url) {
          writeOut(`${c.amber("skip")} ${name}: not a remote (HTTP/SSE) server`);
          continue;
        }
        writeOut(`${c.cyan("◆")} Authorizing ${name} (${server.url})...`);
        try {
          const result = await authorizeMcpServer({
            serverName: name,
            serverUrl: server.url,
            fetchFn,
            presentUrl: (url) => writeOut(`Open: ${url}`),
          });
          authStore.set(server.url, {
            serverUrl: server.url,
            tokens: result.tokens,
            registration: result.registration,
            metadata: result.metadata,
            resource: result.resource,
          });
          writeOut(`${c.emerald("✓")} Saved OAuth tokens for ${name}`);
        } catch (err) {
          failed = true;
          writeOut(`${c.rose("✗")} ${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return failed ? 1 : 0;
    }
    const manager = new McpManager(config.mcpServers ?? {}, {
      cwd: config.cwd,
      fetchFn,
      sandbox: {
        mode: config.sandbox ?? "workspace",
        network: config.permissions?.network ?? "allow",
        envAllow: config.permissions?.env,
      },
      oauth: { authPath: config.mcpAuthPath },
    });
    try {
      const restartMatch = parsed.prompt.match(/^restart(?:\s+(.+))?$/i);
      if (restartMatch) {
        const target = restartMatch[1]?.trim();
        try {
          await manager.restart(target);
        } catch (err) {
          writeOut(`MCP restart failed: ${err instanceof Error ? err.message : String(err)}`);
          return 1;
        }
      } else {
        await manager.ensureStarted();
      }
      if (parsed.json) {
        writeOut(JSON.stringify({ servers: manager.getStatuses() }, null, 2));
      } else {
        writeOut(manager.formatStatus());
      }
      return 0;
    } finally {
      manager.dispose();
    }
  }

  if (parsed.command === "lsp") {
    const manager = new LspManager({
      cwd: config.cwd,
      servers: config.lspServers,
      envAllow: config.permissions?.env,
    });
    try {
      const restartMatch = parsed.prompt.match(/^restart(?:\s+(.+))?$/i);
      if (restartMatch) {
        await manager.restart(restartMatch[1]?.trim());
      }
      if (parsed.json) {
        writeOut(JSON.stringify({ servers: manager.getStatuses() }, null, 2));
      } else {
        writeOut(manager.formatStatus());
      }
      return 0;
    } finally {
      manager.dispose();
    }
  }

  if (parsed.command === "hooks") {
    const runner = new HookRunner({
      cwd: config.cwd,
      config: config.hooks,
      envAllow: config.permissions?.env,
    });
    if (parsed.json) {
      writeOut(
        JSON.stringify(
          {
            hooks: config.hooks ?? {},
            customCommands: loadCustomCommands(config.cwd).map((command) => ({
              name: command.name,
              description: command.description,
              scope: command.scope,
            })),
          },
          null,
          2,
        ),
      );
    } else {
      writeOut(runner.formatStatus());
      const commands = loadCustomCommands(config.cwd);
      if (commands.length > 0) {
        writeOut("");
        writeOut(
          `Custom commands: ${commands.map((command) => `/${command.name}`).join(", ")}`,
        );
      }
    }
    return 0;
  }

  if (parsed.command === "plugins") {
    const runtime = new PluginRuntime({
      cwd: config.cwd,
      onNotice: (message) => writeOut(message),
    });
    await runtime.ensureLoaded();
    if (parsed.json) {
      writeOut(
        JSON.stringify(
          {
            loaded: runtime.loaded,
            tools: [...runtime.tools.keys()],
            hooks: runtime.hooks.map((hook) => ({
              event: hook.event,
              matcher: hook.matcher,
            })),
            errors: runtime.errors,
          },
          null,
          2,
        ),
      );
    } else {
      writeOut(runtime.formatStatus());
    }
    return 0;
  }

  if (parsed.command === "acp") {
    if (!config.apiKey) {
      writeErr(
        "Error: AIVOKEY_API_KEY is not set. Run `aivo login <sk-aivo_...>` or pass `--api-key`.\n",
      );
      return 1;
    }
    const { runAcpServer } = await import("./acp.js");
    return runAcpServer({
      config,
      catalog: DEFAULT_AIVOKEY_CATALOG,
      sessionStore: new SessionStore(),
      fetchFn,
      writeErr,
    });
  }

  if (parsed.command === "trace" || parsed.command === "metrics") {
    const { readTraceFile, formatTraceSummary } = await import("./telemetry-cli.js");
    if (parsed.command === "metrics") {
      const { globalMetrics } = await import("./telemetry.js");
      writeOut(parsed.json ? JSON.stringify(globalMetrics.toJSON(), null, 2) : globalMetrics.toPrometheus());
      return 0;
    }
    const tracePath = parsed.prompt.trim();
    if (!tracePath) {
      writeOut("Usage: aivo trace <trace.jsonl> [--json]");
      return 1;
    }
    const spans = readTraceFile(tracePath);
    if (spans === null) {
      writeOut(`Trace file not found or unreadable: ${tracePath}`);
      return 1;
    }
    if (parsed.json) {
      writeOut(JSON.stringify({ spans }, null, 2));
    } else {
      writeOut(formatTraceSummary(spans));
    }
    return 0;
  }

  if (parsed.command === "login") {
    const keyToSave = parsed.prompt || config.apiKey;
    if (!keyToSave) {
      writeOut("Usage: aivo login <sk-aivo_...> [--base-url https://api.aivokey.dev]");
      return 1;
    }
    if (!looksLikeApiKey(keyToSave)) {
      writeOut(
        `${c.amber("⚠")} This does not look like a standard AivoKey key (sk-...). Saving it anyway.`,
      );
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
        `\n${c.emerald("✓")} Verified AivoKey Account: ${loginKeyStatus ? sanitizeTerminalText(formatKeyStatusSummary(loginKeyStatus)) : "Connected"}`,
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

    saveConfigForWorkspace(config, {
      apiKey: keyToSave,
      baseUrl: config.baseUrl,
      model: chosenPrimary,
      fastModel: chosenFast,
      reasoningEffort: chosenEffort,
      subagentEffort: chosenSubEffort,
      setupCompleted: true,
    });
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
    const nodeMajor = Number(process.versions.node.split(".")[0] ?? 0);
    const gitCheck = spawnSync("git", ["--version"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    const gitOk = gitCheck.status === 0;
    writeOut(`${c.cyan("╭─")} ${c.bold("AivoCode Doctor")} ${c.cyan("─".repeat(55))}`);
    writeOut(
      `${c.cyan("│")} Node.js        : ${nodeMajor >= 20 ? c.emerald(`OK (v${process.versions.node})`) : c.rose(`UNSUPPORTED (v${process.versions.node}; need >=20)`)}`,
    );
    writeOut(
      `${c.cyan("│")} Git            : ${gitOk ? c.emerald("OK") : c.amber("not found (optional, needed for /diff and branches)")}`,
    );
    const doctorSandbox = new ShellSandbox({
      cwd: config.cwd,
      mode: config.sandbox ?? "workspace",
      network: config.permissions?.network ?? "allow",
    });
    writeOut(`${c.cyan("│")} Sandbox        : ${c.white(doctorSandbox.describe())}`);
    const doctorLsp = new LspManager({
      cwd: config.cwd,
      servers: config.lspServers,
      envAllow: config.permissions?.env,
    });
    const lspStatuses = doctorLsp.getStatuses();
    doctorLsp.dispose();
    writeOut(
      `${c.cyan("│")} LSP            : ${
        lspStatuses.length === 0
          ? c.amber("not configured (add lspServers to ~/.aivokey/config.json)")
          : c.emerald(
              `${lspStatuses.length} server(s): ${lspStatuses.map((status) => status.name).join(", ")}`,
            )
      }`,
    );
    writeOut(`${c.cyan("│")} Gateway Origin : ${c.white(sanitizeTerminalText(config.baseUrl))}`);
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
    return catalogErr || keyErr || !config.apiKey || nodeMajor < 20 ? 1 : 0;
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
  const textSanitizer = createTerminalSanitizer();
  const reasoningSanitizer = createTerminalSanitizer();
  const emitEvent = parsed.eventsJson
    ? createJsonlEventSink((line) => writeOut(line.replace(/\n$/, "")))
    : null;
  const streamStartMs = Date.now();
  const traceEnabled =
    Boolean(parsed.tracePath) || Boolean(parsed.metricsJson) || Boolean(parsed.metricsProm);
  const tracer = new Tracer({
    enabled: traceEnabled,
    jsonlPath: parsed.tracePath,
  });

  const agent = new AivoAgent({
    config,
    catalog,
    sessionStore,
    session: initialSession,
    fetchFn,
    tracer,
    callbacks: {
      onReasoningDelta: (d) => {
        if (emitEvent) {
          emitEvent({ type: "reasoning", text: d });
          return;
        }
        if (parsed.json) return;
        turnSpinner.stop();
        const safe = reasoningSanitizer.push(d);
        if (!safe) return;
        if (!inThinkingBlock) {
          inThinkingBlock = true;
          thinkingStartMs = Date.now();
          process.stderr.write(
            `\n${c.slate(`╭─ 💭 Thinking (${config.reasoningEffort}) ──────────────────────────────`)}\n${c.slate("│ ")}`,
          );
        }
        const formatted = safe.replace(/\n/g, `\n${c.slate("│ ")}`);
        process.stderr.write(c.dim(formatted));
      },
      onTextDelta: (d) => {
        if (emitEvent) {
          emitEvent({ type: "text", text: d });
          return;
        }
        if (parsed.json) return;
        turnSpinner.stop();
        if (inThinkingBlock) {
          const secs = ((Date.now() - thinkingStartMs) / 1000).toFixed(1);
          process.stderr.write(
            `\n${c.slate(`╰─ Thought for ${secs}s ───────────────────────────────────────`)}\n\n`,
          );
          inThinkingBlock = false;
        }
        const safe = textSanitizer.push(d);
        if (safe) process.stdout.write(safe);
      },
      onToolCall: (name, args) => {
        if (emitEvent) {
          emitEvent({ type: "tool_start", name, args });
          return;
        }
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
      onToolCallProgress: (target, bytes, lines, preview) => {
        if (emitEvent) {
          emitEvent({ type: "tool_progress", name: target, bytes, lines, preview });
          return;
        }
        if (parsed.json) return;
        const kb = (bytes / 1024).toFixed(1);
        turnSpinner.update(
          `Streaming ${sanitizeTerminalText(target)} · ${lines} lines (${kb} KB)...`,
        );
      },
      onToolResult: (name, output, isError, details, args) => {
        if (emitEvent) {
          const event = toolEndEvent(name, output, Boolean(isError), details);
          if (!parsed.fullOutput && event.type === "tool_end") {
            event.output = event.output.slice(0, 2_000);
          }
          emitEvent(event);
          return;
        }
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
        if (emitEvent) {
          emitEvent({ type: "notice", message: msg, level: "info" });
          return;
        }
        if (!parsed.json) {
          turnSpinner.stop();
          process.stderr.write(`\n${c.amber(`⚡ ${sanitizeTerminalText(msg)}`)}\n`);
        }
      },
      confirmAction: async (description) => {
        if (emitEvent || parsed.json || !stdin.isTTY) return false;
        turnSpinner.stop();
        const decision = await interactiveConfirmBar(description);
        return decision !== "no";
      },
      confirmActionChoice: async (description) => {
        if (emitEvent || parsed.json || !stdin.isTTY) return "no";
        turnSpinner.stop();
        return interactiveConfirmBar(description);
      },
      chooseStrategy: async ({ teamName, recommendedMode }) => {
        if (!stdin.isTTY || !stdout.isTTY || opts.writeOut) return recommendedMode;
        turnSpinner.stop();
        const picked = await interactiveSelect<"subagent-driven" | "native">({
          title: `Choose Execution Strategy — ${teamName}`,
          initialValue: recommendedMode,
          items: [
            {
              value: "subagent-driven",
              label: "Subagent-Driven Team Workflow",
              badge: "[Recommended]",
              detail: `Multi-stage specialist workflow (${teamName})`,
            },
            {
              value: "native",
              label: "Native Direct Execution",
              badge: "[Fast]",
              detail: "Implement directly in this session + review gate",
            },
          ],
        });
        return picked ?? recommendedMode;
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
    if (!parsed.prompt.trim()) {
      writeOut('Usage: aivo workflow "<goal>" [--team <id>]');
      return 1;
    }
    if (!config.apiKey) {
      writeOut(
        "Error: AIVOKEY_API_KEY is not set. Run `aivo login <sk-aivo_...>` or pass `--api-key`.",
      );
      return 1;
    }
    const out = await agent.executeTeamWorkflow(parsed.prompt, config.team);
    agent.backgroundJobs.stopAll();
    agent.dispose();
    writeOut(out);
    return 0;
  }

  if (parsed.command === "run") {
    if (!parsed.prompt.trim()) {
      writeOut('Usage: aivo run "<prompt>" (or aivo -p "<prompt>")');
      return 1;
    }
    if (!config.apiKey) {
      writeOut(
        "Error: AIVOKEY_API_KEY is not set. Run `aivo login <sk-aivo_...>` or pass `--api-key`.",
      );
      return 1;
    }
    const agentT0 = Date.now();
    emitEvent?.({
      type: "start",
      version: EVENT_STREAM_VERSION,
      sessionId: agent.session.id,
      model: agent.config.model,
      cwd: agent.config.cwd,
    });
    let res;
    try {
      res = await agent.runUserPrompt(parsed.prompt);
    } catch (err) {
      emitEvent?.({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    const agentTimeMs = Math.max(1, Date.now() - agentT0);
    emitEvent?.({
      type: "result",
      text: res.finalText,
      steps: res.steps,
      usage: {
        inputTokens: res.turnUsage.inputTokens,
        outputTokens: res.turnUsage.outputTokens,
        cacheReadTokens: res.turnUsage.cacheReadTokens,
        cacheWriteTokens: res.turnUsage.cacheWriteTokens,
      },
      costMicro: res.turnCostMicro.toString(),
      cacheSavedMicro: res.turnCacheSavedMicro.toString(),
      elapsedMs: Date.now() - streamStartMs,
    });
    if (parsed.json && !parsed.eventsJson) {
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
    } else if (!parsed.eventsJson) {
      writeOut("");
    }
    if (parsed.metricsProm || parsed.metricsJson) {
      const metrics = agent.metrics;
      if (parsed.metricsJson) {
        writeOut(JSON.stringify(metrics.toJSON(), null, 2));
      } else {
        writeOut(metrics.toPrometheus());
      }
    }
    if (parsed.tracePath) {
      writeErr(`Trace written to ${parsed.tracePath} (${agent.tracer.listSpans().length} spans)`);
    }
    agent.backgroundJobs.stopAll();
    agent.dispose();
    return 0;
  }

  const updateNotice = await maybeUpdateNotice(parsed, {
    env: opts.env,
    fetchFn,
    globalConfigPath: opts.globalConfigPath,
  });

  if (parsed.command === "mini" || parsed.mini) {
    if ((!stdin.isTTY || !stdout.isTTY) && !opts.writeOut) {
      writeOut(
        "`aivo mini` requires an interactive terminal. Use `aivo -p \"<prompt>\"` for one-shot runs.",
      );
      agent.backgroundJobs.stopAll();
      agent.dispose();
      return 1;
    }
    if (updateNotice) writeErr(c.amber(`◆ ${updateNotice}`));
    await startInteractiveRepl(
      agent,
      keyStatus,
      fetchFn,
      (label) => turnSpinner.start(label),
      () => turnSpinner.stop(),
    );
    agent.backgroundJobs.stopAll();
    agent.dispose();
    return 0;
  }

  if (parsed.command === "repl" && (!stdin.isTTY || !stdout.isTTY)) {
    writeOut(
      "AivoCode TUI requires an interactive terminal. Use `aivo -p \"<prompt>\"` for one-shot runs or `aivo mini` in a TTY.",
    );
    agent.backgroundJobs.stopAll();
    agent.dispose();
    return 1;
  }

  const noKeyNotice = !config.apiKey
    ? "No AivoKey API key configured. Run `aivo login <key>` or use /login inside the TUI."
    : null;
  await startFullScreenTui(
    agent,
    keyStatus,
    fetchFn,
    parsed.prompt,
    [noKeyNotice, updateNotice].filter(Boolean).join(" · ") || null,
  );
  agent.dispose();
  return 0;
}
