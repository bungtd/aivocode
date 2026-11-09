import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { c, sanitizeTerminalText } from "./theme.js";

/**
 * Every slash command the CLI understands, in the order a new user should meet
 * them. `handleSlashCommand` is the source of truth for behaviour; this list is
 * the discoverability surface (palette, `/` autocomplete, `/help`). A command
 * that works but is missing here is effectively invisible, so keep the two in
 * step — `test/slash-command-coverage.test.ts` fails when they drift.
 */
export const SLASH_COMMANDS: Array<{ cmd: string; description: string }> = [
  // Models & reasoning
  { cmd: "/model", description: "Interactive model picker, or switch directly (/model <id>)" },
  { cmd: "/models", description: "Browse the live AivoKey catalog (--tools, --free)" },
  { cmd: "/subagent", description: "Model for subagents & specialist roles (/subagent [explore|architect|builder|reviewer] <id>)" },
  { cmd: "/subagent-model", description: "Alias for /subagent" },
  { cmd: "/fast-model", description: "Set the fast/explore subagent model" },
  { cmd: "/effort", description: "Reasoning effort (off · minimal · low · medium · high · xhigh · max)" },
  { cmd: "/wire", description: "Wire protocol (chat · messages · responses)" },
  { cmd: "/strategy", description: "Execution strategy (auto · subagent-driven · native · ask)" },

  // Sessions
  { cmd: "/sessions", description: "Browse, switch and resume saved sessions (Ctrl+R)" },
  { cmd: "/new", description: "Start a fresh session (same as /clear)" },
  { cmd: "/clear", description: "Start a fresh session" },
  { cmd: "/fork", description: "Fork the current conversation into a new session" },
  { cmd: "/compact", description: "Compress conversation history to free context window" },
  { cmd: "/undo", description: "Revert file edits from the last turn (persisted across restarts)" },
  { cmd: "/redo", description: "Restore file edits reverted by /undo" },
  { cmd: "/checkpoints", description: "Show persisted undo/redo checkpoint history for this session" },
  { cmd: "/diff", description: "Show git diff & files modified in this session" },

  // Agents & orchestration
  { cmd: "/subagents", description: "Inspect subagent runs, logs & outputs (Ctrl+U)" },
  { cmd: "/inspect", description: "Show the full log of one subagent (/inspect <id>)" },
  { cmd: "/team", description: "Switch specialist Agent Team (fullstack · backend · frontend · android · blender3d · gamedev · autopilot)" },
  { cmd: "/agents", description: "Alias for /team" },
  { cmd: "/workflow", description: "Run a multi-stage specialist team workflow (/workflow <goal>)" },
  { cmd: "/todo", description: "View the active task progress board" },
  { cmd: "/btw", description: "Ask a quick side question without polluting history (/btw <question>)" },

  // Background jobs
  { cmd: "/jobs", description: "View & manage background terminal jobs (Ctrl+J)" },
  { cmd: "/ps", description: "Alias for /jobs" },
  { cmd: "/bg", description: "Start a background shell command (/bg <cmd>)" },
  { cmd: "/logs", description: "Tail one background job's output (/logs <id>)" },
  { cmd: "/kill", description: "Stop a background job (/kill <id>)" },

  // Policy & permissions
  { cmd: "/mode", description: "Agent mode (auto · safe · plan)" },
  { cmd: "/sandbox", description: "Sandbox policy (workspace · read-only · danger-full-access)" },
  { cmd: "/permissions", description: "Edit allow/ask/deny rules, or show sandbox status" },
  { cmd: "/config", description: "Interactive settings & configuration center (/config [key] [value])" },
  { cmd: "/settings", description: "Alias for /config" },

  // Integrations
  { cmd: "/mcp", description: "MCP servers: state, tools, resources (/mcp restart [server])" },
  { cmd: "/lsp", description: "LSP servers & status, or restart one (/lsp restart [server])" },
  { cmd: "/browser", description: "Browser automation status and browser_* tools" },
  { cmd: "/web", description: "Web search & fetch configuration and provider status" },
  { cmd: "/hooks", description: "Configured lifecycle hooks (SessionStart, PreToolUse, PostToolUse, Stop, …)" },
  { cmd: "/plugins", description: "Loaded plugin modules, plugin tools and plugin hooks" },
  { cmd: "/commands", description: "Custom slash commands from .aivokey/commands and plugins" },
  { cmd: "/skills", description: "List or load discovered skills (.aivokey, .opencode, .dsh, .claude)" },
  { cmd: "/acp", description: "Run AivoCode as an Agent Client Protocol server (aivo acp)" },

  // Account & diagnostics
  { cmd: "/status", description: "Live balance, faucet tokens, plan quota & cache stats" },
  { cmd: "/usage", description: "Session token usage and cost breakdown" },
  { cmd: "/key", description: "Inspect the current API key and plan limits" },
  { cmd: "/login", description: "Configure AivoKey API key & gateway URL" },
  { cmd: "/audit", description: "Anti-AI-Slop quality audit on modified files" },
  { cmd: "/memory", description: "View or search self-learning persistent memories" },
  { cmd: "/telemetry", description: "Span counts, duration by kind, and metric series for this session" },
  { cmd: "/screenshot", description: "Capture a desktop screenshot and attach it to Vision" },
  { cmd: "/copy", description: "Copy the last assistant response (or '/copy code' for the last code block)" },

  // Help & exit
  { cmd: "/help", description: "Show all commands and keyboard shortcuts" },
  { cmd: "/quit", description: "Exit AivoCode" },
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
      `${c.cyan("◆")} ${c.bold(sanitizeTerminalText(opts.title))} ${c.slate("(↑/↓ navigate · type to filter · Enter select · Esc cancel)")}`,
    );
    lines.push(
      `  ${c.slate("Filter:")} ${filter ? c.white(sanitizeTerminalText(filter)) : c.dim("all")} ${c.slate(`(${filtered.length} items)`)}`,
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
        const safeLabel = sanitizeTerminalText(item.label);
        const label = isCurrent ? c.bold(c.cyan(safeLabel)) : c.white(safeLabel);
        const badge = item.badge ? ` ${sanitizeTerminalText(item.badge)}` : "";
        const detail = item.detail ? ` ${c.slate(sanitizeTerminalText(item.detail))}` : "";
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
