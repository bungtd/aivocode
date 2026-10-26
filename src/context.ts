import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PermissionMode } from "./config.js";
import type { ChatMessage } from "./protocol.js";
import type { TodoItem } from "./tools/index.js";

const INSTRUCTION_CANDIDATES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".aivokey/instructions.md",
  ".github/copilot-instructions.md",
];

/**
 * Builds a 100% deterministic system prompt (no dynamic timestamps or random tokens)
 * so AivoKey's sticky-session upstream prompt cache hits across every turn.
 */
export function buildSystemPrompt(cwd: string, mode: PermissionMode): string {
  const sections: string[] = [
    `You are AivoCode, a fast, disciplined CLI coding agent purpose-built for AivoKey.`,
    `Workspace directory: ${cwd}`,
    `Platform: ${process.platform}`,
    `Permission mode: ${mode}`,
    [
      "## Core Rules",
      "- Prefer dedicated tools (`read_file`, `edit_file`, `write_file`, `glob_files`, `grep_search`) over shell commands whenever possible.",
      "- Before editing a file, read the relevant lines with `read_file`. Never include the `1: ` line-number prefix in `edit_file` oldString or newString.",
      "- Keep changes minimal, focused, and consistent with surrounding code style.",
      "- Track multi-step tasks using `todo_write`.",
      "- Use `subagent` with `agent: \"explore\"` to delegate broad codebase searches to a fast subagent and keep the main context compact.",
      mode === "plan"
        ? "- You are currently in PLAN mode (read-only). Do NOT call `write_file`, `edit_file`, or `run_shell`. Analyze the codebase and present a clear implementation plan."
        : "- Verify your changes by running relevant tests or typechecks via `run_shell`.",
    ].join("\n"),
  ];

  for (const rel of INSTRUCTION_CANDIDATES) {
    const full = join(cwd, rel);
    if (existsSync(full)) {
      try {
        const st = statSync(full);
        if (st.isFile() && st.size <= 64_000) {
          const text = readFileSync(full, "utf8").trim();
          if (text) {
            sections.push(`## Project Instructions (${rel})\n${text}`);
          }
        }
      } catch {
        /* ignore unreadable instruction file */
      }
    }
  }

  return sections.join("\n\n");
}

/**
 * Expands `@path/to/file` mentions in user prompts by appending numbered file contents.
 */
export function expandFileMentions(prompt: string, cwd: string): string {
  const mentionRegex = /(?:^|\s)@([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)\b/g;
  const attachments: string[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(prompt)) !== null) {
    const relPath = match[1]!;
    if (seen.has(relPath)) continue;
    seen.add(relPath);

    const absPath = resolve(cwd, relPath);
    if (!existsSync(absPath)) continue;
    try {
      const st = statSync(absPath);
      if (!st.isFile() || st.size > 256_000) continue;
      const content = readFileSync(absPath, "utf8");
      const numbered = content
        .split(/\r?\n/)
        .slice(0, 500)
        .map((line, idx) => `${idx + 1}: ${line}`)
        .join("\n");
      attachments.push(`<file path="${relPath}">\n${numbered}\n</file>`);
    } catch {
      /* ignore */
    }
  }

  if (attachments.length === 0) return prompt;
  return `${prompt}\n\n${attachments.join("\n\n")}`;
}

export function estimateConversationTokens(
  systemPrompt: string,
  messages: ChatMessage[],
): number {
  let chars = systemPrompt.length;
  for (const m of messages) {
    chars += m.content.length;
    if (m.reasoning) chars += m.reasoning.length;
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        chars += tc.name.length + tc.rawArguments.length + 24;
      }
    }
  }
  return Math.ceil(chars / 4);
}

export interface CompactOptions {
  keepRecentMessages?: number;
  todos?: TodoItem[];
  modifiedFiles?: string[];
}

/**
 * Compacts conversation history when approaching `context_length` or recovering
 * from AivoKey `400 context_length_exceeded`.
 */
export function compactConversation(
  messages: ChatMessage[],
  opts: CompactOptions = {},
): ChatMessage[] {
  const keepCount = Math.max(2, opts.keepRecentMessages ?? 6);
  if (messages.length <= keepCount) {
    // Still trim any huge tool outputs in-place
    return messages.map((m) =>
      m.role === "tool" && m.content.length > 2000
        ? {
            ...m,
            content:
              m.content.slice(0, 1500) +
              `\n... [Compacted ${m.content.length - 1500} chars of tool output]`,
          }
        : m,
    );
  }

  let splitIdx = messages.length - keepCount;
  // Avoid splitting right on a `tool` message so assistant toolCalls and their tool results stay paired
  while (splitIdx > 0 && messages[splitIdx]?.role === "tool") {
    splitIdx--;
  }

  const older = messages.slice(0, splitIdx);
  const recent = messages.slice(splitIdx).map((m) =>
    m.role === "tool" && m.content.length > 4000
      ? {
          ...m,
          content:
            m.content.slice(0, 3000) +
            `\n... [Compacted ${m.content.length - 3000} chars of tool output]`,
        }
      : m,
  );

  const summaryBullets: string[] = [];
  for (const m of older) {
    if (m.role === "user") {
      summaryBullets.push(`- User asked: ${m.content.slice(0, 200).replace(/\s+/g, " ")}`);
    } else if (m.role === "assistant") {
      if (m.toolCalls && m.toolCalls.length > 0) {
        const names = m.toolCalls.map((t) => t.name).join(", ");
        summaryBullets.push(`- Assistant called tools: ${names}`);
      }
      if (m.content) {
        summaryBullets.push(`- Assistant noted: ${m.content.slice(0, 200).replace(/\s+/g, " ")}`);
      }
    }
  }

  if (opts.modifiedFiles && opts.modifiedFiles.length > 0) {
    summaryBullets.push(`- Modified files so far: ${opts.modifiedFiles.join(", ")}`);
  }
  if (opts.todos && opts.todos.length > 0) {
    const todoLine = opts.todos.map((t) => `[${t.status}] ${t.content}`).join("; ");
    summaryBullets.push(`- Active tasks: ${todoLine}`);
  }

  const summaryMessage: ChatMessage = {
    role: "user",
    content: `[Compacted Session Summary]\nEarlier turns were compacted to preserve context window:\n${summaryBullets.slice(-25).join("\n")}`,
  };

  return [summaryMessage, ...recent];
}
