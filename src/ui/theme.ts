import { execSync } from "node:child_process";
import type { AivoWire, PermissionMode, ReasoningEffort } from "../config.js";
import { formatMicroUsd, type KeyInspectStatus } from "../aivokey-client.js";
import type { TodoItem } from "../tools/index.js";

const ESC = "\x1b[";

export const c = {
  reset: `${ESC}0m`,
  bold: (s: string) => `${ESC}1m${s}${ESC}22m`,
  dim: (s: string) => `${ESC}2m${s}${ESC}22m`,
  italic: (s: string) => `${ESC}3m${s}${ESC}23m`,
  cyan: (s: string) => `${ESC}38;5;81m${s}${ESC}39m`,
  teal: (s: string) => `${ESC}38;5;43m${s}${ESC}39m`,
  emerald: (s: string) => `${ESC}38;5;48m${s}${ESC}39m`,
  amber: (s: string) => `${ESC}38;5;214m${s}${ESC}39m`,
  rose: (s: string) => `${ESC}38;5;204m${s}${ESC}39m`,
  violet: (s: string) => `${ESC}38;5;141m${s}${ESC}39m`,
  blue: (s: string) => `${ESC}38;5;75m${s}${ESC}39m`,
  slate: (s: string) => `${ESC}38;5;245m${s}${ESC}39m`,
  white: (s: string) => `${ESC}38;5;255m${s}${ESC}39m`,
  bgCyanBadge: (s: string) => `${ESC}48;5;24m${ESC}38;5;255m${ESC}1m ${s} ${ESC}0m`,
  bgAmberBadge: (s: string) => `${ESC}48;5;136m${ESC}38;5;255m${ESC}1m ${s} ${ESC}0m`,
  bgVioletBadge: (s: string) => `${ESC}48;5;55m${ESC}38;5;255m${ESC}1m ${s} ${ESC}0m`,
  bgEmeraldBadge: (s: string) => `${ESC}48;5;29m${ESC}38;5;255m${ESC}1m ${s} ${ESC}0m`,
  bgDarkBadge: (s: string) => `${ESC}48;5;236m${ESC}38;5;252m ${s} ${ESC}0m`,
  diffAddLine: (s: string) => `${ESC}48;5;22m${ESC}38;5;120m${s}${ESC}0m`,
  diffDelLine: (s: string) => `${ESC}48;5;52m${ESC}38;5;210m${s}${ESC}0m`,
};

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

export function padEndVisible(text: string, width: number): string {
  const len = visibleLength(text);
  if (len >= width) return text;
  return text + " ".repeat(width - len);
}

export function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  return String(tokens);
}

export function modeBadge(mode: PermissionMode): string {
  if (mode === "plan") return c.bgVioletBadge("PLAN · ARCHITECT");
  if (mode === "safe") return c.bgAmberBadge("SAFE · CONFIRM");
  return c.bgCyanBadge("AUTO · BUILD");
}

export function getGitBranchLabel(cwd: string): string {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!branch) return "";
    const status = execSync("git status --porcelain", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return status.length > 0 ? `${branch}*` : branch;
  } catch {
    return "";
  }
}

export interface HeaderBannerOptions {
  version: string;
  cwd: string;
  gitBranch?: string;
  gatewayUrl: string;
  model: string;
  fastModel?: string | null;
  wire: AivoWire;
  effort: ReasoningEffort;
  mode: PermissionMode;
  sessionId: string;
  keyStatus: KeyInspectStatus | null;
}

export function renderHeaderBanner(opts: HeaderBannerOptions): string {
  const width = 76;
  const inner = width - 4;

  const boxRow = (content: string) =>
    `${c.slate("│")} ${padEndVisible(content, inner)} ${c.slate("│")}`;

  const top = `${c.slate("╭" + "─".repeat(width - 2) + "╮")}`;
  const divider = `${c.slate("├" + "─".repeat(width - 2) + "┤")}`;
  const bottom = `${c.slate("╰" + "─".repeat(width - 2) + "╯")}`;

  const titleLeft = `${c.cyan(c.bold("◆ AIVO CODE"))} ${c.slate(`v${opts.version}`)} ${c.dim("— Native AivoKey Agent Harness")}`;
  const badgeRight = modeBadge(opts.mode);
  const titleGap = Math.max(1, inner - visibleLength(titleLeft) - visibleLength(badgeRight));
  const headerLine = `${titleLeft}${" ".repeat(titleGap)}${badgeRight}`;

  const shortCwd =
    opts.cwd.length > 46 ? "…" + opts.cwd.slice(opts.cwd.length - 45) : opts.cwd;
  const gitTag = opts.gitBranch ? `  ${c.violet(`⎇ ${opts.gitBranch}`)}` : "";
  const wsLine = `${c.slate("Workspace :")} ${c.white(shortCwd)}${gitTag}`;

  const fastTag =
    opts.fastModel && opts.fastModel !== opts.model
      ? c.slate(` · subagent: ${c.teal(opts.fastModel)}`)
      : "";
  const modelLine = `${c.slate("Model     :")} ${c.emerald(c.bold(opts.model))} ${c.slate(`[wire:${opts.wire} · effort:${opts.effort}]`)}${fastTag}`;

  let accountLine: string;
  if (!opts.keyStatus) {
    accountLine = `${c.slate("Account   :")} ${c.amber("No API key verified")} ${c.dim("(run /login or aivo login <key>)")}`;
  } else {
    const ks = opts.keyStatus;
    const planLabel =
      ks.mode === "plan" && ks.plan
        ? `${c.violet(c.bold(ks.plan.name))} ${c.slate(`(${ks.plan.allowanceMode})`)}`
        : c.cyan("PAYG");
    const balLabel = `${c.emerald(formatMicroUsd(ks.balanceMicro))}`;
    const freeCount = ks.freeTokens.reduce((acc, f) => acc + f.remainingTokens, 0n);
    const freeLabel =
      freeCount > 0n
        ? ` · ${c.amber(`Faucet: ${formatCompactTokens(Number(freeCount))} tok`)}`
        : "";
    accountLine = `${c.slate("AivoKey   :")} ${planLabel} · Balance ${balLabel}${freeLabel} · ${c.dim(opts.sessionId)}`;
  }

  const shortcutsLine =
    `${c.dim("/model")} switch model · ${c.dim("/effort")} reasoning · ${c.dim("/mode")} plan/auto · ${c.dim("/status")} quota · ${c.dim("/undo")} revert · ${c.dim("@file")} attach`;

  return [
    top,
    boxRow(headerLine),
    divider,
    boxRow(wsLine),
    boxRow(modelLine),
    boxRow(accountLine),
    divider,
    boxRow(shortcutsLine),
    bottom,
  ].join("\n");
}

export interface StatusBarOptions {
  mode: PermissionMode;
  model: string;
  effort: ReasoningEffort;
  wire: AivoWire;
  usedContextTokens: number;
  maxContextTokens: number;
  cacheHitPct: number;
  sessionCostMicro: bigint;
  balanceMicro?: bigint | null;
  gitBranch?: string;
}

export function renderStatusBar(opts: StatusBarOptions): string {
  const modePill =
    opts.mode === "plan"
      ? c.bgVioletBadge("PLAN")
      : opts.mode === "safe"
        ? c.bgAmberBadge("SAFE")
        : c.bgCyanBadge("AUTO");

  const ctxPct =
    opts.maxContextTokens > 0
      ? Math.min(100, Math.round((opts.usedContextTokens / opts.maxContextTokens) * 100))
      : 0;
  const ctxRatio = `${formatCompactTokens(opts.usedContextTokens)}/${formatCompactTokens(opts.maxContextTokens)} (${ctxPct}%)`;
  const ctxColored =
    ctxPct >= 80 ? c.rose(ctxRatio) : ctxPct >= 60 ? c.amber(ctxRatio) : c.slate(ctxRatio);

  const segments: string[] = [
    modePill,
    `${c.emerald("◆")} ${c.bold(opts.model)} ${c.slate(`(${opts.effort}·${opts.wire})`)}`,
    `${c.slate("ctx")} ${ctxColored}`,
    `${c.slate("cache")} ${c.teal(`${opts.cacheHitPct}%`)}`,
    `${c.slate("cost")} ${c.white(formatMicroUsd(opts.sessionCostMicro))}`,
  ];

  if (opts.balanceMicro !== undefined && opts.balanceMicro !== null) {
    segments.push(`${c.slate("bal")} ${c.emerald(formatMicroUsd(opts.balanceMicro))}`);
  }
  if (opts.gitBranch) {
    segments.push(`${c.violet(`⎇ ${opts.gitBranch}`)}`);
  }

  return segments.join(c.slate(" │ "));
}

const TOOL_DISPLAY_NAMES: Record<string, { label: string; icon: string }> = {
  read_file: { label: "Read", icon: "📖" },
  write_file: { label: "Write", icon: "📝" },
  edit_file: { label: "Edit", icon: "✏️" },
  glob_files: { label: "Glob", icon: "🔍" },
  grep_search: { label: "Grep", icon: "🔎" },
  run_shell: { label: "Bash", icon: "⚡" },
  todo_write: { label: "Todo", icon: "☑️" },
  web_fetch: { label: "Fetch", icon: "🌐" },
  subagent: { label: "Subagent", icon: "🤖" },
};

export interface ToolCallCardOptions {
  name: string;
  args: Record<string, unknown>;
  status: "running" | "ok" | "error";
  durationMs?: number;
  summary?: string;
}

export function formatToolTarget(name: string, args: Record<string, unknown>): string {
  if (typeof args.path === "string") {
    if (name === "read_file" && (args.offset || args.limit)) {
      return `${args.path} (offset=${args.offset ?? 1}, limit=${args.limit ?? 500})`;
    }
    return args.path;
  }
  if (typeof args.command === "string") {
    return args.command.length > 64 ? args.command.slice(0, 61) + "..." : args.command;
  }
  if (typeof args.pattern === "string") {
    return args.path ? `${args.pattern} in ${String(args.path)}` : args.pattern;
  }
  if (typeof args.url === "string") return args.url;
  if (typeof args.description === "string") {
    return `${String(args.agent ?? "explore")}: ${args.description}`;
  }
  return "";
}

export function renderToolCallCard(opts: ToolCallCardOptions): string {
  const meta = TOOL_DISPLAY_NAMES[opts.name] ?? { label: opts.name, icon: "●" };
  const target = formatToolTarget(opts.name, opts.args);
  const statusBullet =
    opts.status === "error"
      ? c.rose("✗")
      : opts.status === "ok"
        ? c.emerald("●")
        : c.cyan("◌");

  const timeTag =
    opts.durationMs !== undefined ? c.slate(` · ${opts.durationMs}ms`) : "";
  const summaryTag = opts.summary ? c.slate(` — ${opts.summary}`) : "";

  return `${statusBullet} ${c.bold(meta.label)}${target ? c.cyan(`(${target})`) : ""}${timeTag}${summaryTag}`;
}

export function renderTodoBoard(todos: TodoItem[]): string {
  if (todos.length === 0) return c.slate("  No active tasks.");
  const completedCount = todos.filter((t) => t.status === "completed").length;
  const lines: string[] = [
    `${c.cyan("╭─")} ${c.bold(`Tasks (${completedCount}/${todos.length})`)} ${c.cyan("─".repeat(44))}`,
  ];
  for (const t of todos) {
    if (t.status === "completed") {
      lines.push(`${c.cyan("│")} ${c.emerald("✓")} ${c.dim(t.content)}`);
    } else if (t.status === "in_progress") {
      lines.push(`${c.cyan("│")} ${c.amber("▸")} ${c.bold(c.white(t.content))}`);
    } else {
      lines.push(`${c.cyan("│")} ${c.slate("○")} ${c.slate(t.content)}`);
    }
  }
  lines.push(`${c.cyan("╰" + "─".repeat(58))}`);
  return lines.join("\n");
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class TerminalSpinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameIdx = 0;
  private startedAt = 0;
  private label = "";
  private active = false;

  start(label: string): void {
    if (!process.stderr.isTTY) return;
    this.stop();
    this.label = label;
    this.startedAt = Date.now();
    this.frameIdx = 0;
    this.active = true;
    this.render();
    this.timer = setInterval(() => this.render(), 80);
  }

  update(label: string): void {
    this.label = label;
    if (this.active) this.render();
  }

  private render(): void {
    if (!this.active) return;
    const frame = SPINNER_FRAMES[this.frameIdx % SPINNER_FRAMES.length]!;
    this.frameIdx++;
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    process.stderr.write(
      `\r\x1b[2K${c.cyan(frame)} ${c.slate(this.label)} ${c.dim(`(${elapsed}s)`)}`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.active) {
      this.active = false;
      if (process.stderr.isTTY) {
        process.stderr.write("\r\x1b[2K");
      }
    }
  }
}
