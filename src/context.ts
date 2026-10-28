import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { PermissionMode, ReasoningEffort } from "./config.js";
import type { ChatMessage } from "./protocol.js";
import type { TodoItem } from "./tools/index.js";
import { getAgentTeam, type TeamId } from "./teams.js";
import { isImageFilePath, loadImageAttachment, type ImageAttachment } from "./vision.js";

const INSTRUCTION_CANDIDATES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".aivokey/instructions.md",
  ".github/copilot-instructions.md",
];

const KNOWN_FILE_EXT_REGEX =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|mdx|yaml|yml|toml|py|rs|go|java|kt|c|cpp|h|hpp|cs|css|scss|html|htm|sql|sh|ps1|log|txt|env|xml|csv|ini|cfg|conf|lock)$/i;

/**
 * Checks whether all source/data files explicitly named in backticks in the prompt
 * have already been hydrated in full as `<file path="...">` blocks.
 */
export function areAllPromptFilesHydrated(rawPrompt: string, expandedPrompt: string): boolean {
  if (!expandedPrompt.includes('<file path="')) return false;
  const backtickRegex = /`([^`\r\n]{1,120})`/g;
  let match: RegExpExecArray | null;
  let foundAnyFileRef = false;

  while ((match = backtickRegex.exec(rawPrompt)) !== null) {
    const token = match[1]!.trim();
    if (!KNOWN_FILE_EXT_REGEX.test(token)) continue;
    if (token.includes(" ") || token.includes("*")) continue;
    foundAnyFileRef = true;
    const norm = token.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!expandedPrompt.includes(`<file path="${norm}">`) && !expandedPrompt.includes(`/${norm}">`)) {
      return false;
    }
  }
  return foundAnyFileRef;
}

/**
 * Detects whether a user prompt is a strict read-only repository Q&A / code-tracing task.
 */
export function isReadOnlyQaPrompt(prompt: string): boolean {
  const p = prompt.trim();
  if (/\bdo\s+not\s+(modify|edit|create|write|change|touch)\s+(or\s+create\s+)?(any\s+)?files\b/i.test(p)) {
    return true;
  }
  if (/\bread-only\s+(q&a|qa|question|task)\b/i.test(p)) {
    return true;
  }
  return false;
}

/**
 * Computes step-aware adaptive reasoning effort so AivoCode reasons deeply when debugging errors
 * or complex unhydrated problems, while avoiding slow redundant thinking when files are already
 * pre-hydrated or verification tests have already passed.
 */
export function resolveStepReasoningEffort(opts: {
  configuredEffort: ReasoningEffort;
  step: number;
  isReadOnlyQa: boolean;
  hasPrehydratedFiles: boolean;
  testsJustPassed: boolean;
  lastStepHadError?: boolean;
}): ReasoningEffort {
  const {
    configuredEffort,
    isReadOnlyQa,
    hasPrehydratedFiles,
    testsJustPassed,
    lastStepHadError,
  } = opts;
  if (configuredEffort === "off" || configuredEffort === "minimal" || configuredEffort === "low") {
    return configuredEffort;
  }
  // Once verification tests have passed on modified files, step down to 'low' for fast final summary
  if (testsJustPassed) {
    return "low";
  }
  // If the previous step had a tool/test error, escalate to 'high' (avoiding 60s+ 'max' over-thinking)
  if (lastStepHadError) {
    return configuredEffort === "max" || configuredEffort === "xhigh" ? "high" : configuredEffort;
  }
  // When a read-only Q&A task or pre-hydrated workspace task runs without errors,
  // or on follow-up steps (step >= 2), use 'low' consistently across steps
  if (isReadOnlyQa || hasPrehydratedFiles || opts.step >= 2) {
    return "low";
  }
  // On Step 1 of unhydrated tasks, cap 'max'/'xhigh' to 'high' so initial prefill never stalls >30s
  if (configuredEffort === "max" || configuredEffort === "xhigh") {
    return "high";
  }
  return configuredEffort;
}

/**
 * Builds a 100% deterministic system prompt (no dynamic timestamps or random tokens)
 * so AivoKey's sticky-session upstream prompt cache hits across every turn.
 */
export function buildSystemPrompt(
  cwd: string,
  mode: PermissionMode,
  teamId?: TeamId,
): string {
  const sections: string[] = [
    `You are AivoCode, a fast, disciplined CLI coding agent purpose-built for AivoKey.`,
    `Workspace directory: ${cwd}`,
    `Platform: ${process.platform}${process.platform === "win32" ? " (Shell: PowerShell 7 pwsh; Node.js and git are installed; python is not installed — use node for scripts)" : ""}`,
    `Permission mode: ${mode}`,
    [
      "## Core Engineering & Execution Rules",
      "- Prefer dedicated tools (`read_file`, `edit_file`, `write_file`, `apply_patch`, `glob_files`, `grep_search`, `image_generate`) over shell commands whenever possible, and batch independent tool calls in parallel in a single turn.",
      "- When asked to generate or edit an image (e.g. with `gemini-2.5-flash-image` or `gpt-image-2`), call the `image_generate` tool directly — never search the disk for API keys or write custom HTTP scripts for image generation.",
      "- When `<file path=\"...\">` or `<git_context>` blocks are already attached in the user message, use their contents directly without calling `read_file` or `git log` on those same items again.",
      "- Before editing an unattached file, read it with `read_file`. Never include the `1: ` line-number prefix in `edit_file` oldString or newString.",
      "- Anti-AI-Slop Mandate: NEVER leave `// TODO: implement`, `// ... rest of code`, fake mocked data, or unverified claims. Write complete, clean code.",
      "- Efficiency Rule: When an existing test command (e.g. `node test/*.mjs`) or output generation script succeeds (`exit 0`), finish immediately with a concise summary — do NOT create extra throwaway verification scripts (`verify.mjs`, `scratch.mjs`) or call `anti_slop_audit` manually.",
      "- Only use `todo_write` on large multi-file tasks (5+ files).",
      mode === "plan"
        ? "- You are currently in PLAN mode (read-only). Do NOT call `write_file`, `edit_file`, `apply_patch`, or `run_shell`. Analyze the codebase and present a clear implementation plan."
        : "- Verify code changes by running the relevant test command via `run_shell`.",
    ].join("\n"),
  ];

  if (teamId) {
    const team = getAgentTeam(teamId);
    if (team) {
      sections.push(team.systemPromptAddendum);
    }
  }

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
 * Expands `@path/to/file.ts`, `@path/to/file.ts#10-40` line-range mentions, AND
 * auto-hydrates existing workspace files/directories referenced in backticks (`src/foo.ts`, `logs/`)
 * so the agent starts Turn 1 with the exact referenced files already in context.
 */
export function expandFileMentions(prompt: string, cwd: string): string {
  const attachments: string[] = [];
  const seen = new Set<string>();

  const attachFileRange = (
    relPathRaw: string,
    startLineRaw: number | null = null,
    endLineRaw: number | null = null,
    maxLines: number = 1200,
    maxBytes: number = 256_000,
  ): boolean => {
    const relPath = relPathRaw.replace(/\\/g, "/").replace(/^\.\//, "");
    const cacheKey =
      startLineRaw !== null ? `${relPath}#${startLineRaw}-${endLineRaw ?? startLineRaw}` : relPath;
    if (seen.has(cacheKey) || seen.has(relPath)) return false;
    if (isImageFilePath(relPath)) return false;

    const absPath = resolve(cwd, relPath);
    if (!existsSync(absPath)) return false;
    try {
      const st = statSync(absPath);
      if (!st.isFile() || st.size > maxBytes) return false;
      const content = readFileSync(absPath, "utf8");
      if (content.includes("\0")) return false;
      const allLines = content.split(/\r?\n/);

      seen.add(cacheKey);
      seen.add(relPath);

      if (startLineRaw !== null && Number.isFinite(startLineRaw)) {
        const s = Math.max(1, startLineRaw);
        const e = Math.min(allLines.length, Math.max(s, endLineRaw ?? s));
        const slice = allLines.slice(s - 1, e);
        const numbered = slice.map((line, idx) => `${s + idx}: ${line}`).join("\n");
        attachments.push(`<file path="${relPath}" lines="${s}-${e}">\n${numbered}\n</file>`);
      } else {
        const numbered = allLines
          .slice(0, maxLines)
          .map((line, idx) => `${idx + 1}: ${line}`)
          .join("\n");
        attachments.push(`<file path="${relPath}">\n${numbered}\n</file>`);
      }
      return true;
    } catch {
      return false;
    }
  };

  // 1. Explicit @file.ext and @file.ext#start-end mentions
  const mentionRegex = /(?:^|\s)@([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)(?:#(\d+)(?:-(\d+))?)?/g;
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(prompt)) !== null) {
    const relPath = match[1]!;
    const startLineRaw = match[2] ? Number(match[2]) : null;
    const endLineRaw = match[3] ? Number(match[3]) : startLineRaw;
    attachFileRange(relPath, startLineRaw, endLineRaw, 1200, 256_000);
  }

  // 2. Auto-hydrate backtick-referenced workspace files and small directories (up to 6 files, <= 48 KB each)
  const referencedDirs: string[] = [];
  const bareFileTokens: string[] = [];
  const backtickRegex = /`([^`\r\n]{1,120})`/g;
  while ((match = backtickRegex.exec(prompt)) !== null && attachments.length < 6) {
    const token = match[1]!.trim();
    if (!token) continue;

    // Extract file tokens from commands like `node test/cache.test.mjs`
    const cmdFileMatch = token.match(
      /^(?:node|tsx|ts-node|npx\s+\S+)\s+([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)$/,
    );
    const candidate = cmdFileMatch ? cmdFileMatch[1]! : token;

    // Directory reference like `logs/` or `data/` or `src/`
    if (/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\/$/.test(candidate)) {
      const dirClean = candidate.replace(/\/+$/, "");
      const absDir = resolve(cwd, dirClean);
      if (existsSync(absDir)) {
        try {
          if (statSync(absDir).isDirectory()) {
            referencedDirs.push(dirClean);
          }
        } catch {
          /* ignore */
        }
      }
      continue;
    }

    if (KNOWN_FILE_EXT_REGEX.test(candidate) && /^[a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+$/.test(candidate)) {
      if (!attachFileRange(candidate, null, null, 1200, 48_000)) {
        if (!candidate.includes("/") && !candidate.includes("\\")) {
          bareFileTokens.push(candidate);
        }
      }
    }
  }

  // Resolve bare filenames (`auth.log`, `batch_1.jsonl`) inside referenced directories (`logs/`, `data/`)
  for (const dirRel of referencedDirs) {
    for (const bare of bareFileTokens) {
      if (attachments.length >= 6) break;
      attachFileRange(`${dirRel}/${bare}`, null, null, 1200, 48_000);
    }
    // If the referenced directory has <= 4 small files (<= 24 KB each), hydrate any remaining ones
    if (attachments.length < 6) {
      try {
        const entries = readdirSync(resolve(cwd, dirRel), { withFileTypes: true }).filter((e) =>
          e.isFile(),
        );
        if (entries.length > 0 && entries.length <= 4) {
          for (const entry of entries) {
            if (attachments.length >= 6) break;
            attachFileRange(`${dirRel}/${entry.name}`, null, null, 600, 24_000);
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  // 3. Auto-hydrate compact <git_context> when prompt asks about git history/branches/merges/commits
  if (
    /\b(git|commit|branch|merge|bisect|rebase|sha)\b/i.test(prompt) &&
    existsSync(join(cwd, ".git"))
  ) {
    try {
      const branches = spawnSync("git", ["branch", "-a"], {
        cwd,
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
      }).stdout?.trim();
      const logPatches = spawnSync(
        "git",
        ["log", "--all", "--graph", "--format=commit %H (%D) %s", "-p", "-n", "8"],
        {
          cwd,
          encoding: "utf8",
          timeout: 2500,
          windowsHide: true,
        },
      ).stdout?.trim();
      if (branches || logPatches) {
        attachments.push(
          `<git_context>\nBranches:\n${branches ?? ""}\n\nRecent Commits & Diffs:\n${(logPatches ?? "").slice(0, 12_000)}\n</git_context>`,
        );
      }
    } catch {
      /* ignore git context error */
    }
  }

  if (attachments.length === 0) return prompt;
  return `${prompt}\n\n${attachments.join("\n\n")}`;
}

/**
 * Extracts `@path/to/image.png` mentions from the prompt and loads them as multimodal Vision attachments.
 */
export function extractPromptImageAttachments(prompt: string, cwd: string): ImageAttachment[] {
  const mentionRegex = /(?:^|\s)@([a-zA-Z0-9_./\\-]+\.(?:png|jpe?g|gif|webp))\b/gi;
  const images: ImageAttachment[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(prompt)) !== null) {
    const relPath = match[1]!;
    if (seen.has(relPath)) continue;
    seen.add(relPath);

    const absPath = resolve(cwd, relPath);
    if (!existsSync(absPath)) continue;
    try {
      images.push(loadImageAttachment(absPath));
    } catch {
      /* ignore invalid image */
    }
  }
  return images;
}

export function estimateConversationTokens(
  systemPrompt: string,
  messages: ChatMessage[],
): number {
  let chars = systemPrompt.length;
  for (const m of messages) {
    chars += m.content.length;
    if (m.reasoning) chars += m.reasoning.length;
    if (m.images && m.images.length > 0) {
      chars += m.images.length * 4000; // ~1000 tokens per image estimate
    }
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

export function compactConversation(
  messages: ChatMessage[],
  opts: CompactOptions = {},
): ChatMessage[] {
  const keepCount = Math.max(2, opts.keepRecentMessages ?? 6);
  if (messages.length <= keepCount) {
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
