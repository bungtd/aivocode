import { c } from "./theme.js";

/**
 * Generates a colored, line-numbered unified diff block (Claude Code / OpenCode style)
 * when `edit_file` or `write_file` modifies a file.
 */
export function renderUnifiedDiff(
  filePath: string,
  before: string,
  after: string,
  contextLines: number = 3,
): string {
  const oldLines = before.replace(/\r\n/g, "\n").split("\n");
  const newLines = after.replace(/\r\n/g, "\n").split("\n");

  // Compute simple LCS / prefix-suffix + line diff
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }

  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (
    oldSuffix >= prefix &&
    newSuffix >= prefix &&
    oldLines[oldSuffix] === newLines[newSuffix]
  ) {
    oldSuffix--;
    newSuffix--;
  }

  const removedSlice = oldLines.slice(prefix, oldSuffix + 1);
  const addedSlice = newLines.slice(prefix, newSuffix + 1);

  const addedCount = addedSlice.length;
  const removedCount = removedSlice.length;

  const ctxStart = Math.max(0, prefix - contextLines);
  const ctxEnd = Math.min(newLines.length - 1, newSuffix + contextLines);

  const out: string[] = [
    `${c.slate("  ╭─")} ${c.bold(filePath)} ${c.emerald(`+${addedCount}`)} ${c.rose(`-${removedCount}`)} ${c.slate("─".repeat(Math.max(4, 48 - filePath.length)))}`,
  ];

  // Context before
  for (let i = ctxStart; i < prefix; i++) {
    const ln = String(i + 1).padStart(4, " ");
    out.push(`${c.slate(`  │ ${ln}`)}   ${c.dim(oldLines[i] ?? "")}`);
  }

  // Removed lines (cap at 30 lines for readability)
  const maxShow = 30;
  for (let i = 0; i < Math.min(removedSlice.length, maxShow); i++) {
    const ln = String(prefix + i + 1).padStart(4, " ");
    out.push(`${c.slate("  │")} ${c.diffDelLine(`${ln} - ${removedSlice[i] ?? ""}`)}`);
  }
  if (removedSlice.length > maxShow) {
    out.push(`${c.slate("  │")} ${c.dim(`     ... (${removedSlice.length - maxShow} more removed lines)`)}`);
  }

  // Added lines (cap at 30 lines for readability)
  for (let i = 0; i < Math.min(addedSlice.length, maxShow); i++) {
    const ln = String(prefix + i + 1).padStart(4, " ");
    out.push(`${c.slate("  │")} ${c.diffAddLine(`${ln} + ${addedSlice[i] ?? ""}`)}`);
  }
  if (addedSlice.length > maxShow) {
    out.push(`${c.slate("  │")} ${c.dim(`     ... (${addedSlice.length - maxShow} more added lines)`)}`);
  }

  // Context after
  for (let i = newSuffix + 1; i <= ctxEnd; i++) {
    const ln = String(i + 1).padStart(4, " ");
    out.push(`${c.slate(`  │ ${ln}`)}   ${c.dim(newLines[i] ?? "")}`);
  }

  out.push(`${c.slate("  ╰" + "─".repeat(62))}`);
  return out.join("\n");
}

function highlightCodeLine(line: string): string {
  // Lightweight terminal syntax highlighting for keywords, strings, comments
  if (/^\s*(\/\/|#)/.test(line)) {
    return c.slate(line);
  }
  return line
    .replace(
      /\b(import|export|from|const|let|var|function|async|await|return|if|else|for|while|switch|case|type|interface|class|new|try|catch|throw)\b/g,
      (m) => c.violet(m),
    )
    .replace(/(["'`][^"'`\n]*["'`])/g, (m) => c.emerald(m));
}

function formatInlineMarkdown(line: string): string {
  return line
    .replace(/\*\*([^*]+)\*\*/g, (_, inner) => c.bold(c.white(inner)))
    .replace(/`([^`]+)`/g, (_, code) => c.cyan(code));
}

export function renderTerminalMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLang = "";

  for (const rawLine of lines) {
    const fenceMatch = rawLine.match(/^```(\w*)\s*$/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = fenceMatch[1] || "code";
        out.push(`${c.slate("  ╭─")} ${c.amber(codeLang)} ${c.slate("─".repeat(Math.max(4, 52 - codeLang.length)))}`);
      } else {
        inCodeBlock = false;
        codeLang = "";
        out.push(`${c.slate("  ╰" + "─".repeat(58))}`);
      }
      continue;
    }

    if (inCodeBlock) {
      out.push(`${c.slate("  │")} ${highlightCodeLine(rawLine)}`);
      continue;
    }

    if (/^#{1,3}\s+/.test(rawLine)) {
      const headingText = rawLine.replace(/^#{1,3}\s+/, "");
      out.push(`\n${c.cyan("◆")} ${c.bold(c.white(headingText))}`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(rawLine)) {
      const bulletContent = rawLine.replace(/^\s*[-*]\s+/, "");
      out.push(`  ${c.cyan("•")} ${formatInlineMarkdown(bulletContent)}`);
      continue;
    }

    out.push(formatInlineMarkdown(rawLine));
  }

  if (inCodeBlock) {
    out.push(`${c.slate("  ╰" + "─".repeat(58))}`);
  }

  return out.join("\n");
}
