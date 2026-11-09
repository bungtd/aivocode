/**
 * Lifecycle hooks and user-defined slash commands.
 *
 * Hooks are shell commands declared in `~/.aivokey/config.json` or
 * `.aivokey.json` under a `hooks` object. Each hook receives a JSON payload on
 * stdin and may return JSON on stdout:
 *
 *   { "decision": "block", "reason": "...", "args": { ... },
 *     "additionalContext": "..." }
 *
 * Exit code 0 means "continue"; exit code 2 blocks the operation; any other
 * exit code is reported as a non-blocking warning. Hooks run with a scrubbed
 * environment (see `buildChildEnv`), so secrets are not inherited unless the
 * user allowlists them via `permissions.env`.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { buildChildEnv } from "./env-utils.js";
import type { PermissionMode } from "./config.js";

export type HookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SessionEnd";

export const HOOK_EVENTS: readonly HookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
];

export interface HookCommandConfig {
  /** Regex tested against the tool name (PreToolUse/PostToolUse). Omit to match all. */
  matcher?: string;
  /** Shell command; receives the hook payload as JSON on stdin. */
  command: string;
  /** Timeout in milliseconds (default 30s, max 120s). */
  timeoutMs?: number;
  enabled?: boolean;
}

export type HooksConfig = Partial<Record<HookEvent, HookCommandConfig[]>>;

export interface HookResult {
  blocked: boolean;
  reason?: string;
  /** Replacement tool arguments returned by a PreToolUse hook. */
  args?: Record<string, unknown>;
  additionalContext: string[];
  warnings: string[];
}

const EMPTY_RESULT: HookResult = {
  blocked: false,
  additionalContext: [],
  warnings: [],
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_HOOK_OUTPUT = 32_000;

const EVENT_ALIASES: Record<string, HookEvent> = {
  session_start: "SessionStart",
  sessionstart: "SessionStart",
  user_prompt_submit: "UserPromptSubmit",
  userpromptsubmit: "UserPromptSubmit",
  pre_tool_use: "PreToolUse",
  pretooluse: "PreToolUse",
  post_tool_use: "PostToolUse",
  posttooluse: "PostToolUse",
  stop: "Stop",
  session_end: "SessionEnd",
  sessionend: "SessionEnd",
};

export function normalizeHookEventName(raw: string): HookEvent | null {
  const compact = raw.replace(/[-_\s]/g, "").toLowerCase();
  if (EVENT_ALIASES[compact]) return EVENT_ALIASES[compact];
  const exact = HOOK_EVENTS.find((event) => event.toLowerCase() === compact);
  return exact ?? null;
}

export function parseHooksConfig(value: unknown): HooksConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: HooksConfig = {};
  for (const [rawEvent, rawList] of Object.entries(value as Record<string, unknown>)) {
    const event = normalizeHookEventName(rawEvent);
    if (!event || !Array.isArray(rawList)) continue;
    const commands: HookCommandConfig[] = [];
    for (const row of rawList) {
      if (typeof row === "string") {
        if (row.trim()) commands.push({ command: row.trim() });
        continue;
      }
      if (typeof row !== "object" || row === null) continue;
      const item = row as Record<string, unknown>;
      if (typeof item.command !== "string" || !item.command.trim()) continue;
      const entry: HookCommandConfig = { command: item.command.trim() };
      if (typeof item.matcher === "string" && item.matcher.trim()) {
        entry.matcher = item.matcher.trim();
      }
      if (typeof item.timeoutMs === "number" && Number.isFinite(item.timeoutMs) && item.timeoutMs > 0) {
        entry.timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.round(item.timeoutMs));
      }
      if (typeof item.enabled === "boolean") entry.enabled = item.enabled;
      commands.push(entry);
    }
    if (commands.length > 0) out[event] = commands;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export interface HookRunPayload {
  sessionId?: string;
  cwd: string;
  mode: PermissionMode;
  tool?: { name: string; args: Record<string, unknown> };
  prompt?: string;
  result?: { output: string; isError?: boolean };
  stopReason?: string;
}

export interface ProgrammaticHook {
  event: HookEvent;
  matcher?: string;
  handler: (
    payload: HookRunPayload,
  ) => Promise<void | { block?: string; reason?: string; additionalContext?: string | string[] }>;
}

export interface HookRunnerOptions {
  cwd: string;
  config?: HooksConfig;
  envAllow?: string[];
  /** Lazily resolved so plugins loaded after construction are picked up. */
  programmatic?: ProgrammaticHook[] | (() => ProgrammaticHook[]);
  /** Emits hook warnings to the UI; defaults to no-op. */
  onWarning?: (message: string) => void;
}

export class HookRunner {
  private readonly config: HooksConfig;

  constructor(private readonly opts: HookRunnerOptions) {
    this.config = opts.config ?? {};
  }

  private programmaticHooks(): ProgrammaticHook[] {
    if (!this.opts.programmatic) return [];
    return typeof this.opts.programmatic === "function"
      ? this.opts.programmatic()
      : this.opts.programmatic;
  }

  private matchingProgrammatic(event: HookEvent, toolName?: string): ProgrammaticHook[] {
    return this.programmaticHooks().filter((hook) => {
      if (hook.event !== event) return false;
      if (!hook.matcher || !toolName) return true;
      try {
        return new RegExp(hook.matcher).test(toolName);
      } catch {
        return true;
      }
    });
  }

  hasHooks(event?: HookEvent): boolean {
    if (event) {
      return (
        (this.config[event]?.length ?? 0) > 0 ||
        this.programmaticHooks().some((hook) => hook.event === event)
      );
    }
    return (
      Object.values(this.config).some((list) => (list?.length ?? 0) > 0) ||
      this.programmaticHooks().length > 0
    );
  }

  private matchingHooks(event: HookEvent, toolName?: string): HookCommandConfig[] {
    const list = this.config[event] ?? [];
    return list.filter((hook) => {
      if (hook.enabled === false) return false;
      if (!hook.matcher || !toolName) return true;
      try {
        return new RegExp(hook.matcher).test(toolName);
      } catch {
        return true;
      }
    });
  }

  async run(event: HookEvent, payload: HookRunPayload): Promise<HookResult> {
    const handlers = this.matchingProgrammatic(event, payload.tool?.name);
    const hooks = this.matchingHooks(event, payload.tool?.name);
    if (handlers.length === 0 && hooks.length === 0) return { ...EMPTY_RESULT };

    const merged: HookResult = {
      blocked: false,
      additionalContext: [],
      warnings: [],
      args: undefined,
    };

    // In-process plugin hooks first: they are cheap and can short-circuit.
    for (const handler of handlers) {
      try {
        const raw = await handler.handler(payload);
        if (typeof raw !== "object" || raw === null) continue;
        const row = raw as Record<string, unknown>;
        const contextRaw = row.additionalContext ?? row.additional_context;
        const additionalContext =
          typeof contextRaw === "string"
            ? [contextRaw]
            : Array.isArray(contextRaw)
              ? contextRaw.filter((item): item is string => typeof item === "string")
              : [];
        merged.additionalContext.push(...additionalContext);
        const replacementArgs =
          typeof row.args === "object" && row.args !== null && !Array.isArray(row.args)
            ? (row.args as Record<string, unknown>)
            : undefined;
        if (replacementArgs) merged.args = replacementArgs;
        const block = typeof row.block === "string" ? row.block : undefined;
        if (block) {
          merged.blocked = true;
          merged.reason = block;
          for (const warning of merged.warnings) this.opts.onWarning?.(warning);
          return merged;
        }
      } catch (err) {
        merged.warnings.push(
          `${event} plugin hook failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (hooks.length === 0) {
      for (const warning of merged.warnings) this.opts.onWarning?.(warning);
      return merged;
    }

    const input = JSON.stringify({
      event,
      sessionId: payload.sessionId,
      cwd: payload.cwd,
      mode: payload.mode,
      tool: payload.tool,
      prompt: payload.prompt,
      result: payload.result,
      stopReason: payload.stopReason,
    });

    for (const hook of hooks) {
      const outcome = await this.runOne(event, hook, input);
      merged.additionalContext.push(...outcome.additionalContext);
      merged.warnings.push(...outcome.warnings);
      if (outcome.args) merged.args = outcome.args;
      if (outcome.blocked) {
        merged.blocked = true;
        merged.reason = outcome.reason ?? `blocked by ${event} hook`;
        break;
      }
    }

    for (const warning of merged.warnings) this.opts.onWarning?.(warning);
    return merged;
  }

  private runOne(
    event: HookEvent,
    hook: HookCommandConfig,
    input: string,
  ): Promise<HookResult> {
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, hook.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return new Promise((resolvePromise) => {
      const isWindows = process.platform === "win32";
      // PowerShell exits 0 even when the last native command failed, so append an
      // explicit `exit $LASTEXITCODE` to preserve hook exit-code semantics.
      const shellArgs = isWindows
        ? [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `${hook.command}\nexit $LASTEXITCODE`,
          ]
        : ["-c", hook.command];
      const child = spawn(isWindows ? "powershell.exe" : "/bin/sh", shellArgs, {
        cwd: this.opts.cwd,
        env: buildChildEnv({ allow: this.opts.envAllow }),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: HookResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolvePromise(result);
      };

      timer = setTimeout(() => {
        try {
          if (process.platform === "win32" && child.pid) {
            spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
            });
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          child.kill();
        }
        finish({
          ...EMPTY_RESULT,
          warnings: [`${event} hook timed out after ${timeoutMs}ms: ${hook.command}`],
        });
      }, timeoutMs);

      child.stdin?.on("error", () => {});
      child.stdin?.end(input);

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout = (stdout + chunk.toString()).slice(-MAX_HOOK_OUTPUT);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = (stderr + chunk.toString()).slice(-MAX_HOOK_OUTPUT);
      });

      child.on("error", (err) => {
        finish({
          ...EMPTY_RESULT,
          warnings: [`${event} hook failed to start: ${err.message}`],
        });
      });

      child.on("close", (code) => {
        const parsed = parseHookOutput(stdout);
        const reason =
          parsed.reason ??
          (stderr.trim() ? stderr.trim().slice(0, 1_000) : undefined) ??
          (stdout.trim() && !parsed.json ? stdout.trim().slice(0, 1_000) : undefined);

        if (code === 2 || parsed.decision === "block" || parsed.decision === "deny") {
          finish({
            blocked: true,
            reason: reason ?? `${event} hook blocked the operation`,
            args: parsed.args,
            additionalContext: parsed.additionalContext,
            warnings: [],
          });
          return;
        }

        if (code !== 0) {
          finish({
            ...EMPTY_RESULT,
            args: parsed.args,
            additionalContext: parsed.additionalContext,
            warnings: [
              `${event} hook exited with code ${code ?? "null"}${reason ? `: ${reason}` : ""}`,
            ],
          });
          return;
        }

        finish({
          blocked: false,
          args: parsed.args,
          additionalContext: parsed.additionalContext,
          warnings: [],
        });
      });
    });
  }

  /** Renders configured hooks for `/hooks` and `aivo hooks`. */
  formatStatus(): string {
    if (!this.hasHooks()) {
      return [
        "No hooks configured.",
        "",
        "Add hooks to ~/.aivokey/config.json or .aivokey.json:",
        '  "hooks": {',
        '    "PreToolUse": [{ "matcher": "write_file|edit_file", "command": "node .aivokey/hooks/guard.mjs" }],',
        '    "PostToolUse": [{ "matcher": "edit_file", "command": "npm run lint --silent" }],',
        '    "SessionStart": [{ "command": "node .aivokey/hooks/greet.mjs" }]',
        "  }",
        "",
        "Custom slash commands live in .aivokey/commands/<name>.md (or ~/.aivokey/commands).",
      ].join("\n");
    }
    const lines = ["Hooks:"];
    for (const event of HOOK_EVENTS) {
      const hooks = this.config[event] ?? [];
      for (const hook of hooks) {
        if (hook.enabled === false) continue;
        const matcher = hook.matcher ? ` (matcher: ${hook.matcher})` : "";
        const timeout = hook.timeoutMs ? ` · ${hook.timeoutMs}ms` : "";
        lines.push(`- ${event}${matcher}${timeout}: ${hook.command}`);
      }
    }
    return lines.join("\n");
  }
}

interface ParsedHookOutput {
  json: boolean;
  decision?: string;
  reason?: string;
  args?: Record<string, unknown>;
  additionalContext: string[];
}

function parseHookOutput(stdout: string): ParsedHookOutput {
  const trimmed = stdout.trim();
  if (!trimmed) return { json: false, additionalContext: [] };
  const candidates = [trimmed];
  // Hooks may print log lines before/between JSON; try the last JSON object.
  const lastBrace = trimmed.lastIndexOf("{");
  if (lastBrace > 0) candidates.push(trimmed.slice(lastBrace));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof parsed !== "object" || parsed === null) continue;
      const decision =
        typeof parsed.decision === "string" ? parsed.decision.toLowerCase() : undefined;
      const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
      const args =
        typeof parsed.args === "object" && parsed.args !== null && !Array.isArray(parsed.args)
          ? (parsed.args as Record<string, unknown>)
          : undefined;
      const contextValue = parsed.additionalContext ?? parsed.additional_context;
      const additionalContext =
        typeof contextValue === "string"
          ? [contextValue]
          : Array.isArray(contextValue)
            ? contextValue.filter((item): item is string => typeof item === "string")
            : [];
      return { json: true, decision, reason, args, additionalContext };
    } catch {
      // Try the next candidate.
    }
  }
  return { json: false, additionalContext: [] };
}

// ── Custom slash commands ────────────────────────────────────────────────────

export interface CustomCommand {
  /** Command name without the leading slash. */
  name: string;
  description: string;
  argumentHint?: string;
  /** Absolute path to the Markdown file. */
  path: string;
  /** Scope where the command was discovered. */
  scope: "workspace" | "user";
  /** Markdown body with `$ARGUMENTS` placeholder. */
  template: string;
}

const COMMAND_NAME = /^[a-z0-9][a-z0-9_-]{0,48}$/i;

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith("---")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: raw };
  const header = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  const meta: Record<string, string> = {};
  for (const line of header.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (match) {
      meta[match[1]!.toLowerCase()] = match[2]!.trim().replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body };
}

function readCommandDir(dir: string, scope: "workspace" | "user"): CustomCommand[] {
  if (!existsSync(dir)) return [];
  const commands: CustomCommand[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    const name = basename(entry, entry.slice(-3));
    if (!COMMAND_NAME.test(name)) continue;
    const path = join(dir, entry);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > 128_000) continue;
      const raw = readFileSync(path, "utf8");
      const { meta, body } = parseFrontmatter(raw);
      if (meta.enabled === "false") continue;
      commands.push({
        name: name.toLowerCase(),
        description: meta.description ?? `Custom command /${name.toLowerCase()}`,
        argumentHint: meta.argument_hint ?? meta["argument-hint"],
        path,
        scope,
        template: body.trim(),
      });
    } catch {
      // Ignore unreadable command files.
    }
  }
  return commands;
}

/**
 * Discovers custom slash commands from `.aivokey/commands` (workspace) and
 * `~/.aivokey/commands` (user). Workspace definitions win on name collisions.
 */
export function loadCustomCommands(cwd: string): CustomCommand[] {
  const userCommands = readCommandDir(join(homedir(), ".aivokey", "commands"), "user");
  const workspaceCommands = readCommandDir(join(cwd, ".aivokey", "commands"), "workspace");
  const byName = new Map<string, CustomCommand>();
  for (const command of userCommands) byName.set(command.name, command);
  for (const command of workspaceCommands) byName.set(command.name, command);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Expands `$ARGUMENTS` (and `$1`..`$9`) in a custom command template. */
export function renderCustomCommand(command: CustomCommand, rawArguments: string): string {
  const args = rawArguments.trim();
  const positional = args.length > 0 ? args.split(/\s+/) : [];
  return command.template
    .replace(/\$ARGUMENTS\b/g, args)
    .replace(/\$([1-9])\b/g, (_match, index: string) => positional[Number(index) - 1] ?? "");
}

export function findCustomCommand(
  commands: readonly CustomCommand[],
  line: string,
): { command: CustomCommand; args: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  const command = commands.find((candidate) => candidate.name === name);
  if (!command) return null;
  return { command, args: match[2] ?? "" };
}
