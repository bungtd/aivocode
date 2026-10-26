import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { c } from "./theme.js";

export const SLASH_COMMANDS: Array<{ cmd: string; description: string }> = [
  { cmd: "/model", description: "Interactive model picker or switch model (/model <id>)" },
  { cmd: "/team", description: "Switch specialist Agent Team (fullstack · backend · frontend · android · blender3d · gamedev · autopilot)" },
  { cmd: "/workflow", description: "Run multi-stage specialist team workflow (/workflow <goal>)" },
  { cmd: "/models", description: "Browse live AivoKey catalog (--tools, --free)" },
  { cmd: "/effort", description: "Select reasoning effort (off · minimal · low · medium · high · xhigh · max)" },
  { cmd: "/mode", description: "Switch agent mode (auto · safe · plan)" },
  { cmd: "/wire", description: "Switch AivoKey wire protocol (chat · messages · responses)" },
  { cmd: "/btw", description: "Ask a quick side question without polluting session history (/btw <question>)" },
  { cmd: "/skills", description: "List or load discovered skills (.aivokey, .opencode, .dsh, .claude)" },
  { cmd: "/memory", description: "View or search self-learning persistent memories" },
  { cmd: "/audit", description: "Run Anti-AI-Slop code quality audit on modified files" },
  { cmd: "/screenshot", description: "Capture desktop screenshot and attach to Vision" },
  { cmd: "/status", description: "Live AivoKey balance, faucet tokens, plan quota & cache stats" },
  { cmd: "/compact", description: "Compress conversation history to free context window" },
  { cmd: "/undo", description: "Revert file edits from the last turn via checkpoints" },
  { cmd: "/redo", description: "Restore file edits reverted by /undo" },
  { cmd: "/diff", description: "Show git diff & files modified in this session" },
  { cmd: "/todo", description: "View active task progress board" },
  { cmd: "/fork", description: "Fork conversation into a new sticky session" },
  { cmd: "/sessions", description: "Browse & resume saved sessions" },
  { cmd: "/login", description: "Configure AivoKey API key & gateway URL" },
  { cmd: "/clear", description: "Start a fresh session" },
  { cmd: "/help", description: "Show all commands and keyboard shortcuts" },
  { cmd: "/exit", description: "Exit AivoCode" },
];

export interface AutocompleteResult {
  completedLine: string;
  matches: string[];
}

/**
 * Autocompletes `/slash` commands and `@path/to/file` mentions when pressing Tab.
 */
export function completeInputToken(
  line: string,
  workspaceFiles: string[],
): AutocompleteResult {
  // 1. Slash command completion at start of line
  if (line.startsWith("/") && !line.includes(" ")) {
    const prefix = line.toLowerCase();
    const matches = SLASH_COMMANDS.map((s) => s.cmd).filter((cmd) =>
      cmd.startsWith(prefix),
    );
    if (matches.length === 1) {
      return { completedLine: `${matches[0]} `, matches };
    }
    return { completedLine: line, matches };
  }

  // 2. @file mention completion on the last token
  const atMatch = line.match(/(^|.*\s)@([^\s]*)$/);
  if (atMatch) {
    const before = atMatch[1] ?? "";
    const query = (atMatch[2] ?? "").toLowerCase().replace(/\\/g, "/");
    const matches = workspaceFiles.filter(
      (f) =>
        f.toLowerCase().startsWith(query) ||
        f.toLowerCase().includes(query),
    );
    if (matches.length === 1) {
      return {
        completedLine: `${before}@${matches[0]} `,
        matches: matches.map((m) => `@${m}`),
      };
    }
    return {
      completedLine: line,
      matches: matches.slice(0, 8).map((m) => `@${m}`),
    };
  }

  return { completedLine: line, matches: [] };
}

export interface SelectOption<T> {
  value: T;
  label: string;
  detail?: string;
  badge?: string;
}

/**
 * Interactive arrow-key (`↑/↓`), live type-to-filter, `Enter` to select, `Esc` to cancel picker.
 * Falls back gracefully if stdin is not a TTY.
 */
export async function interactiveSelect<T>(opts: {
  title: string;
  items: SelectOption<T>[];
  initialValue?: T;
  maxVisible?: number;
}): Promise<T | null> {
  if (!stdin.isTTY || !stdout.isTTY || opts.items.length === 0) {
    return opts.items[0]?.value ?? null;
  }

  const maxVisible = opts.maxVisible ?? 10;
  let filter = "";
  let selectedIdx = Math.max(
    0,
    opts.initialValue !== undefined
      ? opts.items.findIndex((i) => i.value === opts.initialValue)
      : 0,
  );
  if (selectedIdx < 0) selectedIdx = 0;

  let renderedLines = 0;

  const getFiltered = () => {
    if (!filter.trim()) return opts.items;
    const q = filter.toLowerCase();
    return opts.items.filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        (i.detail ?? "").toLowerCase().includes(q) ||
        (i.badge ?? "").toLowerCase().includes(q),
    );
  };

  const clearRendered = () => {
    if (renderedLines <= 0) return;
    stdout.write(`\x1b[${renderedLines}A\r\x1b[J`);
    renderedLines = 0;
  };

  const render = () => {
    clearRendered();
    const filtered = getFiltered();
    if (selectedIdx >= filtered.length) {
      selectedIdx = Math.max(0, filtered.length - 1);
    }

    const lines: string[] = [];
    lines.push(
      `${c.cyan("◆")} ${c.bold(opts.title)} ${c.slate("(↑/↓ navigate · type to filter · Enter select · Esc cancel)")}`,
    );
    lines.push(
      `  ${c.slate("Filter:")} ${filter ? c.white(filter) : c.dim("all")} ${c.slate(`(${filtered.length} items)`)}`,
    );

    if (filtered.length === 0) {
      lines.push(`  ${c.rose("No matching items.")}`);
    } else {
      const half = Math.floor(maxVisible / 2);
      let start = Math.max(0, selectedIdx - half);
      const end = Math.min(filtered.length, start + maxVisible);
      if (end - start < maxVisible) {
        start = Math.max(0, end - maxVisible);
      }

      for (let i = start; i < end; i++) {
        const item = filtered[i]!;
        const isCurrent = i === selectedIdx;
        const cursor = isCurrent ? c.cyan("❯") : " ";
        const label = isCurrent ? c.bold(c.cyan(item.label)) : c.white(item.label);
        const badge = item.badge ? ` ${item.badge}` : "";
        const detail = item.detail ? ` ${c.slate(item.detail)}` : "";
        lines.push(`  ${cursor} ${label}${badge}${detail}`);
      }
    }

    stdout.write(lines.join("\n") + "\n");
    renderedLines = lines.length;
  };

  return new Promise<T | null>((resolvePromise) => {
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    render();

    const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
      const filtered = getFiltered();
      if (key?.name === "escape" || (key?.ctrl && key?.name === "c")) {
        cleanup();
        resolvePromise(null);
        return;
      }
      if (key?.name === "return" || key?.name === "enter") {
        const chosen = filtered[selectedIdx]?.value ?? null;
        cleanup();
        resolvePromise(chosen);
        return;
      }
      if (key?.name === "up") {
        selectedIdx = filtered.length > 0 ? (selectedIdx - 1 + filtered.length) % filtered.length : 0;
        render();
        return;
      }
      if (key?.name === "down") {
        selectedIdx = filtered.length > 0 ? (selectedIdx + 1) % filtered.length : 0;
        render();
        return;
      }
      if (key?.name === "backspace") {
        if (filter.length > 0) {
          filter = filter.slice(0, -1);
          selectedIdx = 0;
          render();
        }
        return;
      }
      if (str && str.length === 1 && str >= " " && !key?.ctrl) {
        filter += str;
        selectedIdx = 0;
        render();
      }
    };

    const cleanup = () => {
      stdin.off("keypress", onKeypress);
      clearRendered();
      if (stdin.isTTY) {
        stdin.setRawMode(Boolean(wasRaw));
      }
    };

    stdin.on("keypress", onKeypress);
  });
}
