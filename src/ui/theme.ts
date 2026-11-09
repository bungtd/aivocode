import { execSync } from "node:child_process";
import type { AivoWire, PermissionMode, ReasoningEffort } from "../config.js";
import { formatMicroUsd, type KeyInspectStatus } from "../aivokey-client.js";
import type { TodoItem } from "../tools/index.js";
import { graphemes, textWidth } from "./width.js";

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

/**
 * Removes terminal control sequences (OSC, CSI, two-char escapes) and control characters
 * from untrusted text (model output, file contents, tool arguments) before it is printed.
 * App-generated SGR styling must be applied *after* this function.
 */
export function sanitizeTerminalText(text: string): string {
  return text
    // OSC: ESC ] ... BEL or ST
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI (including SGR): ESC [ parameters final-byte
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // Two-character escapes (e.g. ESC 7, ESC c)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-_]/g, "")
    // C0 controls except tab/newline, plus DEL
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function isIncompleteEscape(tail: string): boolean {
  if (!tail.startsWith("\x1b")) return false;
  if (tail.length === 1) return true;
  if (tail[1] === "]") {
    // OSC terminates with BEL or ST (ESC \).
    return !tail.includes("\x07") && !tail.includes("\x1b\\");
  }
  if (tail[1] === "[") {
    // CSI terminates with a final byte in the @-~ range.
    return !/[\x40-\x7e]/.test(tail.slice(2));
  }
  return false;
}

/**
 * Streaming-safe terminal sanitizer. Holds back a trailing incomplete escape sequence so
 * an ANSI/OSC sequence split across model deltas cannot leak into stdout.
 */
export function createTerminalSanitizer(): {
  push: (chunk: string) => string;
  flush: () => string;
} {
  let pending = "";
  return {
    push(chunk: string): string {
      pending += chunk;
      const lastEsc = pending.lastIndexOf("\x1b");
      let cut = pending.length;
      if (lastEsc !== -1 && isIncompleteEscape(pending.slice(lastEsc))) {
        cut = lastEsc;
      }
      const ready = pending.slice(0, cut);
      pending = pending.slice(cut);
      return sanitizeTerminalText(ready);
    },
    flush(): string {
      const ready = sanitizeTerminalText(pending);
      pending = "";
      return ready;
    },
  };
}

/**
 * Display width in terminal cells, ignoring SGR styling. Wide characters (CJK,
 * emoji) count as two and combining marks as zero, matching what the terminal
 * actually paints — `.length` drifts by one cell per wide character.
 */
export function visibleLength(text: string): number {
  return textWidth(stripAnsi(text));
}

export function padEndVisible(text: string, width: number): string {
  const len = visibleLength(text);
  if (len >= width) return text;
  return text + " ".repeat(width - len);
}

/**
 * Truncates an ANSI-styled line to `width` cells without breaking SGR sequences
 * or splitting a grapheme cluster (combining mark, emoji ZWJ sequence).
 */
export function truncateVisible(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLength(text) <= width) return text;
  const budget = Math.max(0, width - 1); // leave room for the ellipsis
  const { text: head, truncated } = sliceToWidth(text, budget);
  return truncated ? `${head}\x1b[0m…` : head;
}

/**
 * Slices ANSI-styled text to at most `width` display cells, preserving escape
 * sequences and never splitting a grapheme cluster.
 *
 * Returns `truncated: true` when content was dropped, so callers can decide how
 * to signal that (ellipsis, ellipsis prefix for horizontal scroll, ...).
 */
export function sliceToWidth(
  text: string,
  width: number,
): { text: string; truncated: boolean } {
  if (width <= 0) return { text: "", truncated: text.length > 0 };
  let result = "";
  let used = 0;
  let truncated = false;

  // Walk ANSI runs and plain runs separately so escape bytes never count.
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const end = text.indexOf("m", i);
      if (end !== -1) {
        result += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    const nextEsc = text.indexOf("\x1b[", i);
    const plainEnd = nextEsc === -1 ? text.length : nextEsc;
    const plain = text.slice(i, plainEnd);
    for (const cluster of graphemes(plain)) {
      const w = textWidth(cluster);
      if (used + w > width) {
        truncated = true;
        break;
      }
      result += cluster;
      used += w;
    }
    if (truncated) break;
    i = plainEnd;
  }

  return { text: result, truncated };
}

/**
 * Keeps the last `width` display cells of plain text (horizontal scroll for a
 * long input line). Returns the kept text and how many cells were dropped.
 */
export function sliceTailToWidth(
  text: string,
  width: number,
): { text: string; droppedCells: number } {
  if (width <= 0) return { text: "", droppedCells: textWidth(text) };
  const clusters = graphemes(text);
  let total = 0;
  for (const cluster of clusters) total += textWidth(cluster);
  if (total <= width) return { text, droppedCells: 0 };

  let start = clusters.length;
  let kept = 0;
  while (start > 0) {
    const w = textWidth(clusters[start - 1]!);
    if (kept + w > width) break;
    kept += w;
    start--;
  }
  return { text: clusters.slice(start).join(""), droppedCells: total - kept };
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

  const safeCwd = sanitizeTerminalText(opts.cwd);
  const safeModel = sanitizeTerminalText(opts.model);
  const safeFastModel = opts.fastModel ? sanitizeTerminalText(opts.fastModel) : null;
  const safeBranch = opts.gitBranch ? sanitizeTerminalText(opts.gitBranch) : "";
  const shortCwd =
    safeCwd.length > 46 ? "…" + safeCwd.slice(safeCwd.length - 45) : safeCwd;
  const gitTag = safeBranch ? `  ${c.violet(`⎇ ${safeBranch}`)}` : "";
  const wsLine = `${c.slate("Workspace :")} ${c.white(shortCwd)}${gitTag}`;

  const fastTag =
    safeFastModel && safeFastModel !== safeModel
      ? c.slate(` · subagent: ${c.teal(safeFastModel)}`)
      : "";
  const modelLine = `${c.slate("Model     :")} ${c.emerald(c.bold(safeModel))} ${c.slate(`[wire:${opts.wire} · effort:${opts.effort}]`)}${fastTag}`;

  let accountLine: string;
  if (!opts.keyStatus) {
    accountLine = `${c.slate("Account   :")} ${c.amber("No API key verified")} ${c.dim("(run /login or aivo login <key>)")}`;
  } else {
    const ks = opts.keyStatus;
    const planLabel =
      ks.mode === "plan" && ks.plan
        ? `${c.violet(c.bold(sanitizeTerminalText(ks.plan.name)))} ${c.slate(`(${ks.plan.allowanceMode})`)}`
        : c.cyan("PAYG");
    const balLabel = `${c.emerald(formatMicroUsd(ks.balanceMicro))}`;
    const freeCount = ks.freeTokens.reduce((acc, f) => acc + f.remainingTokens, 0n);
    const freeLabel =
      freeCount > 0n
        ? ` · ${c.amber(`Faucet: ${formatCompactTokens(Number(freeCount))} tok`)}`
        : "";
    accountLine = `${c.slate("AivoKey   :")} ${planLabel} · Balance ${balLabel}${freeLabel} · ${c.dim(sanitizeTerminalText(opts.sessionId))}`;
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
    `${c.emerald("◆")} ${c.bold(sanitizeTerminalText(opts.model))} ${c.slate(`(${opts.effort}·${opts.wire})`)}`,
    `${c.slate("ctx")} ${ctxColored}`,
    `${c.slate("cache")} ${c.teal(`${opts.cacheHitPct}%`)}`,
    `${c.slate("cost")} ${c.white(formatMicroUsd(opts.sessionCostMicro))}`,
  ];

  if (opts.balanceMicro !== undefined && opts.balanceMicro !== null) {
    segments.push(`${c.slate("bal")} ${c.emerald(formatMicroUsd(opts.balanceMicro))}`);
  }
  if (opts.gitBranch) {
    segments.push(`${c.violet(`⎇ ${sanitizeTerminalText(opts.gitBranch)}`)}`);
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
  const meta = TOOL_DISPLAY_NAMES[opts.name] ?? {
    label: sanitizeTerminalText(opts.name),
    icon: "●",
  };
  const target = sanitizeTerminalText(formatToolTarget(opts.name, opts.args));
  const statusBullet =
    opts.status === "error"
      ? c.rose("✗")
      : opts.status === "ok"
        ? c.emerald("●")
        : c.cyan("◌");

  const timeTag =
    opts.durationMs !== undefined ? c.slate(` · ${opts.durationMs}ms`) : "";
  const summaryTag = opts.summary
    ? c.slate(` — ${sanitizeTerminalText(opts.summary)}`)
    : "";

  return `${statusBullet} ${c.bold(meta.label)}${target ? c.cyan(`(${target})`) : ""}${timeTag}${summaryTag}`;
}

export function renderTodoBoard(todos: TodoItem[]): string {
  if (todos.length === 0) return c.slate("  No active tasks.");
  const completedCount = todos.filter((t) => t.status === "completed").length;
  const lines: string[] = [
    `${c.cyan("╭─")} ${c.bold(`Tasks (${completedCount}/${todos.length})`)} ${c.cyan("─".repeat(44))}`,
  ];
  for (const t of todos) {
    const content = sanitizeTerminalText(t.content);
    if (t.status === "completed") {
      lines.push(`${c.cyan("│")} ${c.emerald("✓")} ${c.dim(content)}`);
    } else if (t.status === "in_progress") {
      lines.push(`${c.cyan("│")} ${c.amber("▸")} ${c.bold(c.white(content))}`);
    } else {
      lines.push(`${c.cyan("│")} ${c.slate("○")} ${c.slate(content)}`);
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
      `\r\x1b[2K${c.cyan(frame)} ${c.slate(sanitizeTerminalText(this.label))} ${c.dim(`(${elapsed}s)`)}`,
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
