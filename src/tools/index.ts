import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { exec, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { endpointUrl, normalizeModelId, type PermissionMode } from "../config.js";
import { clientHeaders } from "../client-identity.js";
import type { ToolSpec } from "../protocol.js";
import type { CheckpointManager } from "../checkpoint.js";
import { ClientWebSearchRouter, clientWebFetch } from "../web.js";
import { detectImageMagic, isImageFilePath, loadImageAttachment, type ImageAttachment } from "../vision.js";
import { executeComputerUse, type ComputerUseAction, type ViewportPresetName } from "../computer-use.js";
import { BackgroundJobManager } from "../background-jobs.js";
import { SelfLearningMemory, type MemoryCategory } from "../memory.js";
import { SkillRegistry } from "../skills.js";
import { auditCodeForSlop } from "../anti-slop.js";
import type { TeamId } from "../teams.js";
import type { McpManager } from "../mcp.js";
import {
  formatLspLocation,
  severityLabel,
  type LspDocumentSymbol,
  type LspManager,
  type LspWorkspaceSymbol,
} from "../lsp.js";
import type { PermissionEngine, PermissionKind } from "../permissions.js";
import type { ShellSandbox } from "../sandbox.js";
import type { HookRunner } from "../hooks.js";
import { isPathInside } from "../path-utils.js";
import { buildChildEnv } from "../env-utils.js";
import { BrowserSession } from "../browser.js";
import {
  NotebookError,
  deleteNotebookCell,
  editNotebookCell,
  formatNotebook,
  insertNotebookCell,
  readNotebook,
} from "../notebook.js";

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ToolExecutionDiff {
  filePath: string;
  before: string;
  after: string;
}

export interface ToolExecutionResult {
  output: string;
  isError?: boolean;
  summary?: string;
  durationMs?: number;
  diff?: ToolExecutionDiff;
  imageAttachment?: ImageAttachment;
  imageAttachments?: ImageAttachment[];
}

export interface ToolsetOptions {
  cwd: string;
  mode: PermissionMode;
  checkpoints: CheckpointManager;
  todos: TodoItem[];
  apiKey?: string;
  baseUrl?: string;
  defaultImageModel?: string;
  memory?: SelfLearningMemory;
  skills?: SkillRegistry;
  backgroundJobs?: BackgroundJobManager;
  webSearchRouter?: ClientWebSearchRouter;
  webSearchEnabled?: boolean;
  readOnlyOnly?: boolean;
  confirmAction?: (description: string) => Promise<boolean>;
  onSubagent?: (input: {
    agent: "explore" | "general";
    description: string;
    prompt: string;
  }) => Promise<string>;
  onTeamWorkflow?: (input: { teamId: TeamId; goal: string }) => Promise<string>;
  fetchFn?: typeof fetch;
  /** Cancels long-running tools (shell, web fetch/search, image generation) when the turn is aborted. */
  signal?: AbortSignal;
  /** MCP manager (tools/resources from configured MCP servers). */
  mcpManager?: McpManager;
  /** LSP manager (diagnostics, definitions, references, hover, symbols). */
  lspManager?: LspManager;
  /** Lifecycle hooks (PreToolUse/PostToolUse). */
  hooks?: HookRunner;
  /** Session id passed to hook payloads. */
  sessionId?: string;
  /** Receives additional context emitted by hooks. */
  onHookContext?: (toolName: string, context: string) => void;
  /** Extra tools registered by plugins. */
  extraTools?: Array<{
    spec: ToolSpec;
    handler: (args: Record<string, unknown>) => Promise<ToolExecutionResult>;
  }>;
  permissionEngine?: PermissionEngine;
  shellSandbox?: ShellSandbox;
  /** Secret env-var name patterns explicitly allowed through to child processes. */
  envAllow?: string[];
  /** Session network policy, enforced by browser navigation. */
  network?: "allow" | "deny";
}

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".wrangler",
  ".pgdata",
  ".pgdata-gateway-test",
  ".tanstack",
  ".next",
  ".pnpm-store",
  "coverage",
]);

const DANGEROUS_SHELL_PATTERNS = [
  // Destructive root/home/current-directory removal
  /\brm\s+-[a-z]*[rf][a-z]*\s+(?:\/|~|\*|\.{1,2})(?:\s|$)/i,
  /\brm\s+-[a-z]*[rf][a-z]*\s+[a-z]:[\\/]?(?:\s|$)/i,
  /\bRemove-Item\b[^\n]*-Recurse[^\n]*(?:[A-Za-z]:[\\/]|~[\\/]|\/(?:\s|$))/i,
  // Repository-wide destructive operations
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*[fd][a-z]*x/i,
  /\bgit\s+push\s+.*--force\b/i,
  // Disk/device operations
  /\b(?:mkfs(?:\.\w+)?|diskpart)\b/i,
  /\bdd\b[^\n]*\bof=\/dev\//i,
  /\bformat\s+[a-z]:/i,
  // Fork bomb
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
];

const MAX_INLINE_OUTPUT_CHARS = 32_000;
const MAX_SHELL_CAPTURE_CHARS = 1_000_000;

function killProcessTree(child: ChildProcess): void {
  if (typeof child.pid === "number") {
    if (process.platform === "win32") {
      try {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        /* ignore */
      }
    } else {
      try {
        // Negative PID targets the whole process group (spawned detached on POSIX).
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* fall back to the direct child below */
      }
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}

let cachedWinPowerShellBin: string | null = null;

function detectWindowsPowerShellBin(): string {
  if (cachedWinPowerShellBin) return cachedWinPowerShellBin;
  if (process.platform !== "win32") {
    cachedWinPowerShellBin = "/bin/sh";
    return cachedWinPowerShellBin;
  }
  try {
    const check = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    if (check.status === 0 && Number(String(check.stdout).trim()) >= 7) {
      cachedWinPowerShellBin = "pwsh.exe";
      return cachedWinPowerShellBin;
    }
  } catch {
    /* fallback to powershell.exe */
  }
  cachedWinPowerShellBin = "powershell.exe";
  return cachedWinPowerShellBin;
}

/**
 * Normalizes common POSIX and cmd.exe idioms (`2>/dev/null`, `ls -la`, `del`, `rm -f`,
 * and `&&` / `||` when running on Windows PowerShell) so LLM shell commands succeed on the first try.
 */
export function normalizeWindowsShellCommand(
  rawCommand: string,
  hasPwsh7: boolean = detectWindowsPowerShellBin() === "pwsh.exe",
): string {
  let cmd = rawCommand.trim();
  if (!cmd) return cmd;

  if (/^dir\s+\/[a-z0-9]/i.test(cmd)) {
    return `cmd.exe /c "${cmd.replace(/"/g, '\\"')}"`;
  }

  // Replace POSIX /dev/null redirections with PowerShell $null
  cmd = cmd.replace(/2>\s*\/dev\/null\b/g, "2>$null");
  cmd = cmd.replace(/1>\s*\/dev\/null\b/g, ">$null");
  cmd = cmd.replace(/(?<![21])>\s*\/dev\/null\b/g, ">$null");

  // Normalize standalone or chained `ls -la`, `del <file>`, `rm -rf <path>` segments
  const transformSegment = (seg: string): string => {
    const s = seg.trim();
    if (/^ls\s+-[a-z0-9]+(\s+.*)?$/i.test(s)) {
      const tail = s.replace(/^ls\s+-[a-z0-9]+\s*/i, "").trim();
      return tail ? `Get-ChildItem -Force ${tail}` : "Get-ChildItem -Force";
    }
    if (/^del\s+([^\s;&|]+)$/i.test(s)) {
      const target = s.replace(/^del\s+/i, "").trim();
      return `Remove-Item -Force -ErrorAction SilentlyContinue ${target}`;
    }
    if (/^rm\s+-[rf]{1,2}\s+(.+)$/i.test(s)) {
      const target = s.replace(/^rm\s+-[rf]{1,2}\s+/i, "").trim();
      return `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue ${target}`;
    }
    return s;
  };

  // Split top-level `&&` and `||` outside quotes so each segment can be normalized
  const tokens: Array<{ type: "seg" | "op"; value: string }> = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      buf += ch;
      continue;
    }
    if (ch === '"' && !inSingle && cmd[i - 1] !== "\\") {
      inDouble = !inDouble;
      buf += ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === "&" && cmd[i + 1] === "&") {
        tokens.push({ type: "seg", value: transformSegment(buf) });
        tokens.push({ type: "op", value: "&&" });
        buf = "";
        i++;
        continue;
      }
      if (ch === "|" && cmd[i + 1] === "|") {
        tokens.push({ type: "seg", value: transformSegment(buf) });
        tokens.push({ type: "op", value: "||" });
        buf = "";
        i++;
        continue;
      }
    }
    buf += ch;
  }
  tokens.push({ type: "seg", value: transformSegment(buf) });

  if (hasPwsh7) {
    return tokens.map((t) => (t.type === "op" ? ` ${t.value} ` : t.value)).join("");
  }

  // Fallback for Windows PowerShell 5.1 which lacks `&&` and `||`
  let rebuilt = "";
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.type === "seg") {
      rebuilt += tok.value;
    } else if (tok.value === "&&") {
      rebuilt += "; ";
    } else if (tok.value === "||") {
      const nextSeg = tokens[i + 1]?.value ?? "";
      i++;
      rebuilt += `; if (-not $?) { ${nextSeg} }`;
    }
  }
  return rebuilt;
}

function resolveWorkspacePath(cwd: string, p: string): string {
  const cleaned = p.trim();
  return isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned);
}

const LSP_SYMBOL_KINDS: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enumMember",
  23: "struct",
  24: "event",
  25: "operator",
  26: "typeParameter",
};

function lspSymbolKind(kind: number): string {
  return LSP_SYMBOL_KINDS[kind] ?? `kind:${kind}`;
}

function formatDocumentSymbols(
  symbols: LspDocumentSymbol[],
  relativePath: string,
  depth = 0,
): string[] {
  const lines: string[] = [];
  for (const symbol of symbols) {
    const position = symbol.selectionRange ?? symbol.range;
    lines.push(
      `${"  ".repeat(depth)}${lspSymbolKind(symbol.kind)} ${symbol.name} — ${relativePath}:${position.start.line + 1}:${position.start.character + 1}`,
    );
    if (symbol.children && symbol.children.length > 0) {
      lines.push(...formatDocumentSymbols(symbol.children, relativePath, depth + 1));
    }
  }
  return lines;
}

function formatWorkspaceSymbols(symbols: LspWorkspaceSymbol[], cwd: string): string[] {
  return symbols.map((symbol) => {
    const location = formatLspLocation(
      {
        uri: symbol.location.uri,
        range:
          "range" in symbol.location && symbol.location.range
            ? symbol.location.range
            : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      },
      cwd,
    );
    const container = symbol.containerName ? ` — ${symbol.containerName}` : "";
    return `${lspSymbolKind(symbol.kind)} ${symbol.name}${container} — ${location}`;
  });
}

const AUTO_DIAGNOSTICS_TIMEOUT_MS = 1_500;
const AUTO_DIAGNOSTICS_MAX_ITEMS = 8;

/**
 * Runs a fast post-edit LSP diagnostics pass and returns a compact summary to
 * append to the tool output. Never throws: a missing or slow language server
 * must not fail the edit itself.
 */
async function collectDiagnosticsSummary(
  lspManager: LspManager | undefined,
  absPath: string,
  cwd: string,
): Promise<string> {
  if (!lspManager?.hasServers() || !lspManager.getServerForFile(absPath)) return "";
  try {
    const { server, diagnostics } = await Promise.race([
      lspManager.diagnostics(absPath, AUTO_DIAGNOSTICS_TIMEOUT_MS),
      new Promise<{ server: string; diagnostics: never[] }>((resolvePromise) =>
        setTimeout(
          () => resolvePromise({ server: "", diagnostics: [] }),
          AUTO_DIAGNOSTICS_TIMEOUT_MS + 250,
        ),
      ),
    ]);
    if (!server || diagnostics.length === 0) return "";
    const relativePath = relative(cwd, absPath).replace(/\\/g, "/") || absPath;
    const lines = diagnostics.slice(0, AUTO_DIAGNOSTICS_MAX_ITEMS).map((diagnostic) => {
      const start = diagnostic.range?.start ?? { line: 0, character: 0 };
      return `${relativePath}:${start.line + 1}:${start.character + 1} [${severityLabel(diagnostic.severity)}] ${diagnostic.message}`;
    });
    const remaining = diagnostics.length - lines.length;
    return `\n\nLSP diagnostics (${server}): ${diagnostics.length}\n${lines.join("\n")}${remaining > 0 ? `\n… ${remaining} more` : ""}`;
  } catch {
    return "";
  }
}

/** Extracts explicit filesystem path tokens from a shell command for advisory policy checks. */
export function extractShellPathCandidates(command: string): string[] {
  const found = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const value = raw.trim().replace(/[),;]+$/, "");
    if (!value || value.startsWith("http://") || value.startsWith("https://")) return;
    found.add(value);
  };
  for (const match of command.matchAll(/[A-Za-z]:[\\/][^\s"'`]+/g)) add(match[0]);
  for (const match of command.matchAll(/\\\\[^\s"'`]+/g)) add(match[0]);
  for (const match of command.matchAll(/(?:^|[\s"'`=])(\/[^\s"'`]+)/g)) add(match[1]);
  for (const match of command.matchAll(/(?:^|[\s"'`=])(~\/[^\s"'`]+)/g)) add(match[1]);
  for (const match of command.matchAll(/(?:^|[\s"'`=])(\$[A-Za-z_][A-Za-z0-9_]*\/[^\s"'`]+)/g)) {
    add(match[1]);
  }
  for (const match of command.matchAll(/(?:^|[\s"'`=])(%[A-Za-z_][A-Za-z0-9_]*%[\\/][^\s"'`]+)/g)) {
    add(match[1]);
  }
  for (const match of command.matchAll(/(?:^|[\s"'`=])(\.\.[\\/][^\s"'`]*)/g)) add(match[1]);
  return [...found];
}

function resolveShellPathCandidate(candidate: string, workdir: string): string | null {
  let expanded = candidate;
  if (expanded.startsWith("~/")) expanded = join(homedir(), expanded.slice(2));
  expanded = expanded.replace(/^\$([A-Za-z_][A-Za-z0-9_]*)/, (_m, name: string) => {
    if (name === "HOME") return homedir();
    return process.env[name] ?? "";
  });
  expanded = expanded.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, name: string) => {
    return process.env[name] ?? "";
  });
  if (!expanded || expanded.includes("$") || expanded.includes("%")) return null;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(workdir, expanded);
}

export function stripLineNumberPrefixes(text: string): string {
  const lines = text.split("\n");
  const allHavePrefix =
    lines.length > 0 &&
    lines.every((l) => l.trim() === "" || /^\s*\d+:\s?/.test(l));
  if (!allHavePrefix) return text;
  return lines.map((l) => l.replace(/^\s*\d+:\s?/, "")).join("\n");
}

/** Expands `{ts,tsx}` brace groups into a bounded list of plain glob patterns. */
export function expandGlobBraces(glob: string, limit: number = 64): string[] {
  const open = glob.indexOf("{");
  if (open === -1) return [glob];
  let depth = 0;
  let close = -1;
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === "{") depth++;
    else if (glob[i] === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [glob];
  const body = glob.slice(open + 1, close);
  const parts: string[] = [];
  let current = "";
  let nested = 0;
  for (const ch of body) {
    if (ch === "{") nested++;
    else if (ch === "}") nested--;
    if (ch === "," && nested === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  if (parts.length <= 1) return [glob];

  const prefix = glob.slice(0, open);
  const suffix = glob.slice(close + 1);
  const results: string[] = [];
  for (const part of parts) {
    for (const expanded of expandGlobBraces(`${prefix}${part}${suffix}`, limit)) {
      if (results.length < limit) results.push(expanded);
    }
  }
  return results;
}

function globSourceToRegExp(normalized: string): string {
  let regexStr = "";
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i]!;
    if (c === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          regexStr += "(?:.*/)?";
          i += 2;
        } else {
          regexStr += ".*";
          i += 1;
        }
      } else {
        regexStr += "[^/]*";
      }
    } else if (c === "?") {
      regexStr += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      regexStr += "\\" + c;
    } else {
      regexStr += c;
    }
  }
  return regexStr;
}

function globToRegExp(glob: string): RegExp {
  const expanded = expandGlobBraces(glob).map((g) => globSourceToRegExp(g.replace(/\\/g, "/")));
  return new RegExp(`^(?:${expanded.join("|")})$`, "i");
}

interface GitIgnoreRule {
  baseDir: string;
  regex: RegExp;
  negated: boolean;
  dirOnly: boolean;
  basenameOnly: boolean;
}

function readGitIgnoreRules(dir: string): GitIgnoreRule[] {
  const file = join(dir, ".gitignore");
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rules: GitIgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    if (!line) continue;
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    let anchored = false;
    if (line.startsWith("/")) {
      anchored = true;
      line = line.slice(1);
    }
    if (!line) continue;
    const hasSlash = line.includes("/");
    try {
      rules.push({
        baseDir: dir,
        regex: globToRegExp(line),
        negated,
        dirOnly,
        basenameOnly: !anchored && !hasSlash,
      });
    } catch {
      /* ignore invalid pattern */
    }
  }
  return rules;
}

function isIgnoredByRules(
  rules: GitIgnoreRule[],
  absPath: string,
  isDirectory: boolean,
): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDirectory) continue;
    const rel = relative(rule.baseDir, absPath).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    const target = rule.basenameOnly ? rel.split("/").pop() ?? rel : rel;
    if (rule.regex.test(target)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

/**
 * Walks the workspace while honoring `.gitignore` files (including nested ones) and
 * the built-in heavy-directory ignore list. This keeps glob/grep and the `@file`
 * picker from crawling `vendor/`, `target/`, `build/`, etc.
 */
export function walkWorkspaceFiles(
  rootDir: string,
  includeHidden: boolean = false,
  maxFiles: number = 2000,
  respectGitignore: boolean = true,
): string[] {
  const absFiles = walkFiles(rootDir, includeHidden, maxFiles, respectGitignore);
  return absFiles.map((f) => relative(rootDir, f).replace(/\\/g, "/"));
}

function walkFiles(
  rootDir: string,
  includeHidden: boolean = false,
  maxFiles: number = 2000,
  respectGitignore: boolean = true,
): string[] {
  const results: string[] = [];
  const ruleStack: GitIgnoreRule[] = [];

  function visit(currentDir: string) {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    const pushed = respectGitignore ? readGitIgnoreRules(currentDir) : [];
    if (pushed.length > 0) ruleStack.push(...pushed);

    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (!includeHidden && entry.name.startsWith(".")) continue;
      const entryPath = join(currentDir, entry.name);
      const isDirectory = entry.isDirectory();
      if (respectGitignore && isIgnoredByRules(ruleStack, entryPath, isDirectory)) continue;
      if (isDirectory) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        visit(entryPath);
      } else if (entry.isFile()) {
        results.push(entryPath);
      }
    }

    if (pushed.length > 0) ruleStack.length -= pushed.length;
  }
  visit(rootDir);
  return results;
}

export function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return "No todos tracked.";
  return todos
    .map((t) => {
      const box = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
      return `${box} ${t.content} (id: ${t.id})`;
    })
    .join("\n");
}

export function createToolset(opts: ToolsetOptions) {
  const memory = opts.memory ?? new SelfLearningMemory();
  const skills = opts.skills ?? new SkillRegistry({ cwd: opts.cwd });
  const webSearchRouter =
    opts.webSearchRouter ??
    new ClientWebSearchRouter({
      loadLocalDshCredentials: opts.fetchFn === undefined,
      fetchFn: opts.fetchFn,
    });
  const extraToolHandlers = new Map<
    string,
    { handler: (args: Record<string, unknown>) => Promise<ToolExecutionResult>; readOnly: boolean }
  >();
  let browserSession: BrowserSession | null = null;
  const getBrowserSession = (): BrowserSession => {
    if (!browserSession) {
      browserSession = new BrowserSession({
        cwd: opts.cwd,
        network: opts.network ?? "allow",
      });
    }
    return browserSession;
  };

  const specs: ToolSpec[] = [
    {
      name: "read_file",
      description:
        "Read a text file, directory, or image (PNG/JPEG/GIF/WebP). Text reads return 1-based line numbers (`1: content`).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory path" },
          offset: { type: "number", description: "1-based starting line number (default: 1)" },
          limit: { type: "number", description: "Maximum lines to read (default: 2000)" },
        },
        required: ["path"],
      },
    },
    {
      name: "glob_files",
      description: "Find files by glob pattern (e.g. '**/*.ts', 'src/**/*.tsx', '*.json').",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern" },
          path: { type: "string", description: "Subdirectory to search in (optional)" },
          hidden: { type: "boolean", description: "Include dotfiles (default: false)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "grep_search",
      description: "Search file contents using regular expression or literal string.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex or literal search pattern" },
          path: { type: "string", description: "File or directory to search in (optional)" },
          include: { type: "string", description: "Glob filter for filenames (e.g. '*.ts')" },
          literal: { type: "boolean", description: "Treat pattern as literal text" },
          caseSensitive: { type: "boolean", description: "Case sensitive search (default: true)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "web_search",
      description:
        "Search the web using OpenCode-style keyless Exa MCP (mcp.exa.ai) & Parallel MCP (search.parallel.ai) with zero API keys required (plus optional Exa/Tavily/Firecrawl/Brave/DuckDuckGo failover). Set type='code' for code examples & SDK documentation.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          maxResults: { type: "number", description: "Max results (default: 8)" },
          type: {
            type: "string",
            enum: ["auto", "fast", "deep", "code"],
            description: "Search mode: 'auto' (default), 'fast', 'deep', or 'code' (SDK/library code examples)",
          },
          livecrawl: {
            type: "string",
            enum: ["fallback", "preferred"],
            description: "Live crawl mode (default: 'fallback')",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "code_search",
      description:
        "Search for code examples, library/SDK documentation, and programming solutions via keyless Exa MCP (get_code_context_exa) with zero API keys required.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Programming/SDK query (e.g. 'React useState hook examples', 'Node.js test runner mocking')",
          },
          maxResults: { type: "number", description: "Max results (default: 8)" },
        },
        required: ["query"],
      },
    },
    ...(opts.lspManager?.hasServers()
      ? [
          {
            name: "lsp_diagnostics",
            description:
              "Return compiler/language-server diagnostics for a workspace file (errors, warnings, hints) at 1-based positions.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Workspace file path" },
              },
              required: ["path"],
            },
          },
          {
            name: "lsp_hover",
            description:
              "Return type/signature/documentation hover information at a 1-based line and character position.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Workspace file path" },
                line: { type: "number", description: "1-based line number" },
                character: { type: "number", description: "1-based column number" },
              },
              required: ["path", "line", "character"],
            },
          },
          {
            name: "lsp_definition",
            description: "Find the definition location for the symbol at a 1-based position.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Workspace file path" },
                line: { type: "number", description: "1-based line number" },
                character: { type: "number", description: "1-based column number" },
              },
              required: ["path", "line", "character"],
            },
          },
          {
            name: "lsp_references",
            description: "Find all references to the symbol at a 1-based position.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Workspace file path" },
                line: { type: "number", description: "1-based line number" },
                character: { type: "number", description: "1-based column number" },
              },
              required: ["path", "line", "character"],
            },
          },
          {
            name: "lsp_document_symbols",
            description: "List symbols (functions, classes, variables, ...) in a workspace file.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Workspace file path" },
              },
              required: ["path"],
            },
          },
          {
            name: "lsp_workspace_symbols",
            description: "Search workspace symbols by name across all configured LSP servers.",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string", description: "Symbol name or query" },
              },
              required: ["query"],
            },
          },
        ]
      : []),
    {
      name: "web_fetch",
      description:
        "Fetch an HTTP/HTTPS URL and return its content converted to clean Markdown, text, or HTML.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "HTTP/HTTPS URL to fetch" },
          format: { type: "string", enum: ["markdown", "text", "html"], description: "Output format (default: markdown)" },
        },
        required: ["url"],
      },
    },
    {
      name: "vision_analyze",
      description:
        "Attach a local image file (PNG, JPEG, GIF, WebP) so the model can visually inspect UI screenshots, diagrams, or 3D renders.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the image file" },
        },
        required: ["path"],
      },
    },
    {
      name: "todo_write",
      description: "Update the structured task checklist to track multi-step progress.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["id", "content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
    {
      name: "memory_search",
      description: "Search persistent self-learning memory for project conventions, past bug fixes, and user preferences.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Topic or keyword to search" },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_remember",
      description: "Save a durable engineering lesson, architectural decision, or user preference into persistent self-learning memory.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["preference", "architecture", "bug_lesson", "workflow", "skill_insight"],
          },
          title: { type: "string", description: "Short summary title" },
          content: { type: "string", description: "Concise reusable rule or lesson" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["category", "title", "content"],
      },
    },
    {
      name: "skill_load",
      description:
        "Load specialized instructions from an installed or project skill (`SKILL.md`). Use id='list' to discover available skills first.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Skill ID (or 'list' to list all available skills)" },
        },
        required: ["id"],
      },
    },
    {
      name: "anti_slop_audit",
      description: "Audit a file (or all modified files) for AI slop: placeholder comments, unfinished TODO stubs, or blind `any` casts.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to audit (optional; defaults to all modified files)" },
        },
      },
    },
  ];

  // Plugin tools are additional model-callable tools with their own handler.
  if (opts.extraTools && opts.extraTools.length > 0) {
    for (const tool of opts.extraTools) {
      const readOnly = tool.spec.annotations?.readOnlyHint === true;
      // Do not advertise mutating plugin tools in plan/read-only mode.
      if (!readOnly && (opts.readOnlyOnly || opts.mode === "plan")) continue;
      specs.push(tool.spec);
      extraToolHandlers.set(tool.spec.name, { handler: tool.handler, readOnly });
    }
  }

  if (opts.mcpManager) {
    specs.push(
      ...opts.mcpManager.getToolSpecs({
        mode: opts.mode,
        readOnlyOnly: opts.readOnlyOnly ?? false,
      }),
    );
  }

  if (!opts.readOnlyOnly) {
    specs.push(
      {
        name: "write_file",
        description:
          "Create or overwrite a file. Automatically creates parent directories and records an undo checkpoint.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path to write" },
            content: { type: "string", description: "Complete file content" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "image_generate",
        description:
          "Generate or edit an image using AivoKey's image models ('gemini-2.5-flash-image' or 'gpt-image-2') via /v1/images/generations or /v1/images/edits and save the resulting PNG/JPEG file to the workspace.",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Detailed image generation or edit prompt" },
            outputPath: {
              type: "string",
              description: "Workspace file path to save the generated image (default: 'generated-image.png')",
            },
            model: {
              type: "string",
              description: "Image model ID on AivoKey (default: 'gemini-2.5-flash-image'; also supports 'gpt-image-2')",
            },
            size: {
              type: "string",
              description: "Image size such as '1024x1024' (default: '1024x1024')",
            },
            sourceImagePath: {
              type: "string",
              description: "Optional existing local image file path to edit via /v1/images/edits",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "edit_file",
        description:
          "Replace exact text in a file (`oldString` -> `newString`). Preserves CRLF/LF line endings and records an undo checkpoint.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File to edit" },
            oldString: { type: "string", description: "Exact text to find (never include line number prefixes)" },
            newString: { type: "string", description: "Replacement text" },
            replaceAll: { type: "boolean", description: "Replace all occurrences (default: false)" },
          },
          required: ["path", "oldString", "newString"],
        },
      },
      {
        name: "apply_patch",
        description:
          "Apply a multi-file patch supporting '*** Add File: <path>', '*** Update File: <path>', and '*** Delete File: <path>' sections.",
        parameters: {
          type: "object",
          properties: {
            patchText: { type: "string", description: "Patch text" },
          },
          required: ["patchText"],
        },
      },
      {
        name: "run_shell",
        description:
          "Execute a shell command in the workspace and return stdout/stderr. Commands may run inside an OS sandbox (bubblewrap/sandbox-exec/Windows AppContainer) depending on --sandbox. Set background=true for dev servers or long-running processes.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to run" },
            workdir: { type: "string", description: "Working directory (optional)" },
            timeoutMs: { type: "number", description: "Timeout in milliseconds (default: 60000)" },
            background: { type: "boolean", description: "Run in background and return immediately (for servers)" },
          },
          required: ["command"],
        },
      },
      {
        name: "skill_create",
        description:
          "Self-evolving capability: create or update a reusable `SKILL.md` skill when you master a reusable workflow or domain pattern.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Kebab-case skill ID (e.g. 'blender-rigging')" },
            name: { type: "string", description: "Display name" },
            description: { type: "string", description: "When to use this skill" },
            body: { type: "string", description: "Complete Markdown instructions for the skill" },
            scope: { type: "string", enum: ["global", "project"] },
          },
          required: ["id", "name", "description", "body"],
        },
      },
      {
        name: "computer_use",
        description:
          "Inspect and interact with UI: 'inspect_viewports' / 'serve_preview' (renders web app in isolated headless Desktop 1440×900, Tablet 768×1024, and Mobile 390×844 viewports without desktop clutter), 'screenshot', 'window_list', 'open_url', 'mouse_move', 'mouse_click', 'keyboard_type', or 'key_press'.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "inspect_viewports",
                "serve_preview",
                "screenshot",
                "window_list",
                "open_url",
                "mouse_move",
                "mouse_click",
                "keyboard_type",
                "key_press",
              ],
            },
            viewports: {
              type: "array",
              items: { type: "string", enum: ["desktop", "tablet", "mobile"] },
              description: "Viewports to capture (default: ['desktop', 'tablet', 'mobile'])",
            },
            x: { type: "number" },
            y: { type: "number" },
            button: { type: "string", enum: ["left", "right", "double"] },
            text: { type: "string" },
            key: { type: "string" },
            url: { type: "string" },
          },
          required: ["action"],
        },
      },
    );

    specs.push(
      {
        name: "browser_navigate",
        description:
          "Open a URL or workspace HTML file in a real headless Chrome/Edge page and return its title, visible text, links, buttons, inputs, console messages, and network errors. Use this for web apps instead of screenshotting the desktop.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Absolute URL or workspace-relative path" },
          },
          required: ["url"],
        },
      },
      {
        name: "browser_snapshot",
        description:
          "Re-read the current browser page: text, links, buttons, inputs, console logs, and failed network requests.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "browser_interact",
        description:
          "Interact with the current page: 'click' a CSS selector, 'fill' an input, 'press' a key (Enter/Tab/Escape/Backspace), 'wait' for a selector, or 'eval' JavaScript. Returns the updated page state.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["click", "fill", "press", "wait", "eval"],
            },
            selector: { type: "string", description: "CSS selector for click/fill/wait" },
            value: { type: "string", description: "Value for fill, key for press, or JS for eval" },
            timeoutMs: { type: "number", description: "Timeout for wait (default 20000)" },
          },
          required: ["action"],
        },
      },
      {
        name: "browser_screenshot",
        description:
          "Capture a PNG of the current page (full page by default) and attach it for visual inspection.",
        parameters: {
          type: "object",
          properties: {
            fullPage: { type: "boolean", description: "Capture beyond the viewport (default true)" },
          },
        },
      },
      {
        name: "notebook_read",
        description:
          "Read a Jupyter .ipynb notebook as numbered cells (code/markdown) instead of raw JSON.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Notebook path" },
          },
          required: ["path"],
        },
      },
      {
        name: "notebook_edit",
        description:
          "Edit, insert, or delete notebook cells while preserving structure and outputs. Use action 'edit' with a 1-based cell index, 'insert' with an index, or 'delete'.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Notebook path" },
            action: { type: "string", enum: ["edit", "insert", "delete"] },
            cell: { type: "number", description: "1-based cell index (edit/delete)" },
            index: { type: "number", description: "1-based insert position (insert)" },
            source: { type: "string", description: "New cell source/markdown" },
            cellType: { type: "string", enum: ["code", "markdown", "raw"] },
          },
          required: ["path", "action"],
        },
      },
    );

    if (opts.onSubagent) {
      specs.push({
        name: "subagent",
        description:
          "Spawn an isolated child agent ('explore' for fast read-only codebase search on a cheaper model, or 'general' for multi-step coding tasks).",
        parameters: {
          type: "object",
          properties: {
            agent: { type: "string", enum: ["explore", "general"] },
            description: { type: "string", description: "Short 3-5 word label" },
            prompt: { type: "string", description: "Detailed task instructions for the subagent" },
          },
          required: ["agent", "description", "prompt"],
        },
      });
    }

    if (opts.onTeamWorkflow) {
      specs.push({
        name: "team_workflow",
        description:
          "Execute a structured multi-stage specialist Agent Team workflow ('fullstack', 'backend', 'frontend', 'android', 'blender3d', 'gamedev', 'autopilot').",
        parameters: {
          type: "object",
          properties: {
            team: {
              type: "string",
              enum: ["fullstack", "backend", "frontend", "android", "blender3d", "gamedev", "autopilot"],
            },
            goal: { type: "string", description: "Detailed goal for the specialist team" },
          },
          required: ["team", "goal"],
        },
      });
    }
  }

  async function authorizeTool(
    kind: PermissionKind,
    subject: string,
    extra: { absPath?: string; outsideWorkspace?: boolean; label?: string } = {},
  ): Promise<ToolExecutionResult | null> {
    if (opts.permissionEngine) {
      const result = await opts.permissionEngine.authorize(kind, subject, extra);
      if (!result.allowed) {
        return { isError: true, output: `Blocked: ${result.reason ?? `${kind} not allowed`}` };
      }
      return null;
    }
    // Legacy fallback for callers that construct a toolset without a PermissionEngine.
    if (kind === "read" || kind === "webfetch") return null;
    if (opts.mode === "plan" || opts.readOnlyOnly) {
      return {
        isError: true,
        output: `Blocked: '${subject}' is not allowed in plan mode (read-only). Formulate your plan using read/search tools only.`,
      };
    }
    if (opts.mode === "safe" && opts.confirmAction) {
      const ok = await opts.confirmAction(extra.label ?? subject);
      if (!ok) return { isError: true, output: `User declined action: ${subject}` };
    }
    return null;
  }

  async function checkMutationAllowed(actionLabel: string): Promise<ToolExecutionResult | null> {
    return authorizeTool("write", actionLabel, { label: actionLabel });
  }

  async function executeCore(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    try {
      if (opts.signal?.aborted) {
        return { isError: true, output: `Tool ${name} cancelled by user (turn aborted).` };
      }

      const extraTool = extraToolHandlers.get(name);
      if (extraTool) {
        // Plugin tools run in-process with full Node privileges, so they must obey
        // the same permission gate as built-in mutating tools.
        if ((opts.mode === "plan" || opts.readOnlyOnly) && !extraTool.readOnly) {
          return {
            isError: true,
            output: `Blocked: plugin tool '${name}' is not marked read-only (annotations.readOnlyHint) and plan/read-only mode is active.`,
          };
        }
        if (!extraTool.readOnly) {
          const guard = await checkMutationAllowed(`plugin tool ${name}`);
          if (guard) return guard;
        }
        return await extraTool.handler(args);
      }

      if (opts.mcpManager) {
        const binding = opts.mcpManager.resolveTool(name);
        if (binding) {
          if (binding.approval === "deny") {
            return {
              isError: true,
              output: `Blocked: MCP tool '${binding.server}/${binding.toolName}' is denied by this server's approval policy.`,
            };
          }
          if ((opts.mode === "plan" || opts.readOnlyOnly) && !binding.readOnlyHint) {
            return {
              isError: true,
              output: `Blocked: MCP tool '${binding.server}/${binding.toolName}' is not marked read-only and plan mode is active.`,
            };
          }
          const requiresApproval =
            opts.mode === "safe" ||
            (opts.mode === "auto" && !binding.readOnlyHint && binding.approval !== "auto");
          if (requiresApproval) {
            const description = `MCP tool ${binding.server}/${binding.toolName}(${JSON.stringify(args).slice(0, 120)})`;
            if (opts.mode === "safe" && opts.permissionEngine) {
              const decision = await opts.permissionEngine.authorize(
                "shell",
                `mcp:${binding.exposedName}`,
                { label: description },
              );
              if (!decision.allowed) {
                return {
                  isError: true,
                  output: `User declined MCP tool: ${binding.server}/${binding.toolName}`,
                };
              }
            } else if (opts.confirmAction) {
              const ok = await opts.confirmAction(description);
              if (!ok) {
                return {
                  isError: true,
                  output: `User declined MCP tool: ${binding.server}/${binding.toolName}`,
                };
              }
            } else {
              return {
                isError: true,
                output: `Blocked: MCP tool '${binding.server}/${binding.toolName}' requires approval, but no confirmation prompt is available. Set mcpServers.${binding.server}.approval to "auto" to trust this server.`,
              };
            }
          }
          const startedAt = Date.now();
          const result = await opts.mcpManager.callTool(name, args, opts.signal);
          return { ...result, durationMs: Date.now() - startedAt };
        }

        if (name === "mcp_list_resources") {
          const startedAt = Date.now();
          const server = typeof args.server === "string" ? args.server : undefined;
          const output = await opts.mcpManager.listResources(server, opts.signal);
          return {
            output,
            summary: server ? `resources:${server}` : "resources",
            durationMs: Date.now() - startedAt,
          };
        }

        if (name === "mcp_read_resource") {
          const server = typeof args.server === "string" ? args.server.trim() : "";
          const uri = typeof args.uri === "string" ? args.uri.trim() : "";
          if (!server || !uri) {
            return { isError: true, output: "mcp_read_resource requires 'server' and 'uri'." };
          }
          const startedAt = Date.now();
          const result = await opts.mcpManager.readResource(server, uri, opts.signal);
          return { ...result, durationMs: Date.now() - startedAt };
        }

        if (name === "mcp_list_prompts") {
          const startedAt = Date.now();
          const server = typeof args.server === "string" ? args.server : undefined;
          const output = await opts.mcpManager.listPrompts(server, opts.signal);
          return {
            output,
            summary: server ? `prompts:${server}` : "prompts",
            durationMs: Date.now() - startedAt,
          };
        }

        if (name === "mcp_get_prompt") {
          const server = typeof args.server === "string" ? args.server.trim() : "";
          const promptName = typeof args.name === "string" ? args.name.trim() : "";
          if (!server || !promptName) {
            return { isError: true, output: "mcp_get_prompt requires 'server' and 'name'." };
          }
          const rawArgs =
            typeof args.arguments === "object" && args.arguments !== null
              ? (args.arguments as Record<string, unknown>)
              : {};
          const promptArgs: Record<string, string> = {};
          for (const [key, value] of Object.entries(rawArgs)) {
            if (typeof value === "string") promptArgs[key] = value;
            else if (value !== undefined && value !== null) promptArgs[key] = String(value);
          }
          const startedAt = Date.now();
          const result = await opts.mcpManager.getPromptResult(
            server,
            promptName,
            promptArgs,
            opts.signal,
          );
          return { ...result, durationMs: Date.now() - startedAt };
        }
      }

      switch (name) {
        case "read_file": {
          const startedAt = Date.now();
          const rawPath = String(args.path ?? "");
          const absPath = resolveWorkspacePath(opts.cwd, rawPath);
          if (!existsSync(absPath)) {
            return { isError: true, output: `File not found: ${rawPath}` };
          }
          const readDenied = await authorizeTool("read", rawPath, {
            absPath,
            label: `read_file(${rawPath})`,
          });
          if (readDenied) return readDenied;
          const st = statSync(absPath);
          if (st.isDirectory()) {
            const entries = readdirSync(absPath, { withFileTypes: true }).map((e) =>
              e.isDirectory() ? `${e.name}/` : e.name,
            );
            return {
              output: `Directory ${rawPath}:\n${entries.join("\n")}`,
              summary: `${entries.length} entries`,
              durationMs: Date.now() - startedAt,
            };
          }

          // If image file, load as Vision attachment automatically (matching OpenCode V2!)
          if (isImageFilePath(absPath)) {
            const img = loadImageAttachment(absPath);
            return {
              output: `Loaded image ${rawPath} (${img.mimeType}, ${img.width}x${img.height}, ${Math.round(img.byteSize / 1024)} KB) for visual analysis.`,
              summary: `${img.width}x${img.height} ${img.mimeType}`,
              durationMs: Date.now() - startedAt,
              imageAttachment: img,
            };
          }

          if (st.size > 10 * 1024 * 1024) {
            return {
              isError: true,
              output: `read_file error: '${rawPath}' is ${(st.size / (1024 * 1024)).toFixed(1)} MB; read it in smaller ranges or use grep_search.`,
            };
          }
          const rawBuffer = readFileSync(absPath);
          if (rawBuffer.includes(0)) {
            return {
              isError: true,
              output: `read_file error: '${rawPath}' is a binary file. Use vision_analyze for images or run_shell for binary tooling.`,
            };
          }
          const content = rawBuffer.toString("utf8");
          const lines = content.split(/\r?\n/);
          const offset = Math.max(1, typeof args.offset === "number" ? Math.floor(args.offset) : 1);
          const limit = Math.max(
            1,
            Math.min(2000, typeof args.limit === "number" ? Math.floor(args.limit) : 2000),
          );
          const slice = lines.slice(offset - 1, offset - 1 + limit);
          const numbered = slice.map((line, i) => `${offset + i}: ${line}`).join("\n");
          const footer =
            offset - 1 + limit < lines.length
              ? `\n... (${lines.length - (offset - 1 + limit)} more lines; use offset=${offset + limit})`
              : "";
          return {
            output: numbered + footer,
            summary: `${slice.length} lines`,
            durationMs: Date.now() - startedAt,
          };
        }

        case "vision_analyze": {
          const startedAt = Date.now();
          const rawPath = String(args.path ?? "");
          const absPath = resolveWorkspacePath(opts.cwd, rawPath);
          const readDenied = await authorizeTool("read", rawPath, {
            absPath,
            label: `vision_analyze(${rawPath})`,
          });
          if (readDenied) return readDenied;
          const img = loadImageAttachment(absPath);
          return {
            output: `Attached image ${rawPath} (${img.mimeType}, ${img.width}x${img.height}) for vision inspection.`,
            summary: `${img.width}x${img.height}`,
            durationMs: Date.now() - startedAt,
            imageAttachment: img,
          };
        }

        case "write_file": {
          const startedAt = Date.now();
          const rawPath = typeof args.path === "string" ? args.path.trim() : "";
          if (!rawPath) {
            return {
              isError: true,
              output: "write_file error: 'path' parameter is required (must be a non-empty file path).",
            };
          }
          const content = String(args.content ?? "");
          const absPath = resolveWorkspacePath(opts.cwd, rawPath);
          const guard = await authorizeTool("write", rawPath, {
            absPath,
            label: `write_file(${rawPath})`,
          });
          if (guard) return guard;
          if (existsSync(absPath) && statSync(absPath).isDirectory()) {
            return {
              isError: true,
              output: `write_file error: '${rawPath}' is a directory, not a file.`,
            };
          }
          const before = existsSync(absPath) ? readFileSync(absPath, "utf8") : "";
          opts.checkpoints.snapshotBeforeWrite(absPath);
          mkdirSync(dirname(absPath), { recursive: true });
          writeFileSync(absPath, content, "utf8");
          const lineCount = content.split(/\r?\n/).length;
          const lspSummary = await collectDiagnosticsSummary(opts.lspManager, absPath, opts.cwd);
          return {
            output: `Wrote ${rawPath} (${lineCount} lines)${lspSummary}`,
            summary: `${lineCount} lines`,
            durationMs: Date.now() - startedAt,
            diff: { filePath: rawPath, before, after: content },
          };
        }

        case "image_generate": {
          const startedAt = Date.now();
          const prompt = String(args.prompt ?? "").trim();
          if (!prompt) {
            return { isError: true, output: "image_generate error: 'prompt' is required." };
          }
          const rawOut =
            typeof args.outputPath === "string" && args.outputPath.trim()
              ? args.outputPath.trim()
              : "generated-image.png";
          const guard = await authorizeTool("write", rawOut, {
            absPath: resolveWorkspacePath(opts.cwd, rawOut),
            label: `image_generate(${rawOut})`,
          });
          if (guard) return guard;

          const apiKey = (opts.apiKey || process.env.AIVOKEY_API_KEY || "").trim();
          if (!apiKey) {
            return {
              isError: true,
              output: "image_generate error: AivoKey API key is not configured.",
            };
          }
          const baseUrl = opts.baseUrl || "https://api.aivokey.dev";
          const requestedModel = normalizeModelId(
            typeof args.model === "string" && args.model.trim()
              ? args.model
              : opts.defaultImageModel || "gemini-2.5-flash-image",
          );
          const size =
            typeof args.size === "string" && args.size.trim() ? args.size.trim() : "1024x1024";
          const sourceRel =
            typeof args.sourceImagePath === "string" ? args.sourceImagePath.trim() : "";
          if (sourceRel) {
            const readDenied = await authorizeTool("read", sourceRel, {
              absPath: resolveWorkspacePath(opts.cwd, sourceRel),
              label: `image_generate(source=${sourceRel})`,
            });
            if (readDenied) return readDenied;
          }

          const fetchImpl = opts.fetchFn ?? fetch;
          const isEdit = sourceRel.length > 0;
          const url = isEdit
            ? `${endpointUrl(baseUrl, "images").replace(/\/generations$/, "")}/edits`
            : endpointUrl(baseUrl, "images");

          const reqBody: Record<string, unknown> = {
            model: requestedModel,
            prompt,
            size,
            n: 1,
          };
          if (isEdit) {
            const srcAttachment = loadImageAttachment(resolveWorkspacePath(opts.cwd, sourceRel));
            reqBody.image = srcAttachment.dataUrl;
          }

          const res = await fetchImpl(url, {
            method: "POST",
            headers: {
              ...clientHeaders(),
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(reqBody),
            signal: opts.signal,
          });

          const rawText = await res.text();
          if (!res.ok) {
            return {
              isError: true,
              output: `image_generate failed (${res.status}): ${rawText.slice(0, 500)}`,
            };
          }

          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(rawText) as Record<string, unknown>;
          } catch {
            return {
              isError: true,
              output: `image_generate returned invalid JSON: ${rawText.slice(0, 300)}`,
            };
          }

          const dataArr = Array.isArray(parsed.data) ? parsed.data : [];
          const firstItem =
            dataArr.length > 0 && typeof dataArr[0] === "object" && dataArr[0] !== null
              ? (dataArr[0] as Record<string, unknown>)
              : {};

          let imgBuffer: Buffer | null = null;
          if (typeof firstItem.b64_json === "string" && firstItem.b64_json.length > 0) {
            imgBuffer = Buffer.from(firstItem.b64_json, "base64");
          } else if (typeof firstItem.url === "string" && firstItem.url.length > 0) {
            const dl = await fetchImpl(firstItem.url);
            if (dl.ok) {
              imgBuffer = Buffer.from(await dl.arrayBuffer());
            }
          }

          if (!imgBuffer || imgBuffer.length === 0) {
            return {
              isError: true,
              output: `image_generate response contained no image payload: ${rawText.slice(0, 300)}`,
            };
          }

          const absOut = resolveWorkspacePath(opts.cwd, rawOut);
          opts.checkpoints.snapshotBeforeWrite(absOut);
          mkdirSync(dirname(absOut), { recursive: true });
          writeFileSync(absOut, imgBuffer);

          const magic = detectImageMagic(imgBuffer);
          const dimInfo = magic ? `${magic.width}x${magic.height} ${magic.mimeType}` : "image";
          const kb = Math.max(1, Math.round(imgBuffer.length / 1024));
          return {
            output: `Generated image using '${requestedModel}' and saved to ${rawOut} (${dimInfo}, ${kb} KB).`,
            summary: `${rawOut} (${dimInfo}, ${kb} KB)`,
            durationMs: Date.now() - startedAt,
          };
        }

        case "edit_file": {
          const startedAt = Date.now();
          const rawPath = typeof args.path === "string" ? args.path.trim() : "";
          if (!rawPath) {
            return {
              isError: true,
              output: "edit_file error: 'path' parameter is required (e.g. path: 'src/index.ts').",
            };
          }
          const rawOld = String(args.oldString ?? "");
          const rawNew = String(args.newString ?? "");
          const replaceAll = args.replaceAll === true;
          if (rawOld.length === 0) {
            return {
              isError: true,
              output:
                "edit_file error: 'oldString' must be a non-empty exact snippet. Use write_file for new files.",
            };
          }

          const absPath = resolveWorkspacePath(opts.cwd, rawPath);
          if (!existsSync(absPath)) {
            return { isError: true, output: `File not found: ${rawPath}` };
          }
          const guard = await authorizeTool("write", rawPath, {
            absPath,
            label: `edit_file(${rawPath})`,
          });
          if (guard) return guard;
          if (statSync(absPath).isDirectory()) {
            return {
              isError: true,
              output: `edit_file error: '${rawPath}' is a directory, not a file. Specify a file path.`,
            };
          }

          const original = readFileSync(absPath, "utf8");
          const usesCrlf = original.includes("\r\n");
          const normOriginal = original.replace(/\r\n/g, "\n");

          let targetOld = rawOld.replace(/\r\n/g, "\n");
          let targetNew = rawNew.replace(/\r\n/g, "\n");

          if (!normOriginal.includes(targetOld)) {
            const strippedOld = stripLineNumberPrefixes(targetOld);
            if (strippedOld !== targetOld && normOriginal.includes(strippedOld)) {
              targetOld = strippedOld;
              targetNew = stripLineNumberPrefixes(targetNew);
            }
          }

          // Fallback: trimmed line-by-line match if indentation/trailing spaces differed slightly
          if (!normOriginal.includes(targetOld)) {
            const origLines = normOriginal.split("\n");
            const oldLines = targetOld.split("\n");
            if (oldLines.length > 0 && oldLines.length <= origLines.length) {
              for (let start = 0; start <= origLines.length - oldLines.length; start++) {
                let allMatch = true;
                for (let k = 0; k < oldLines.length; k++) {
                  if (origLines[start + k]!.trim() !== oldLines[k]!.trim()) {
                    allMatch = false;
                    break;
                  }
                }
                if (allMatch) {
                  targetOld = origLines.slice(start, start + oldLines.length).join("\n");
                  break;
                }
              }
            }
          }

          if (!normOriginal.includes(targetOld)) {
            return {
              isError: true,
              output: `edit_file failed: oldString not found in ${rawPath}. Read the file again to verify exact contents.`,
            };
          }

          const occurrences = normOriginal.split(targetOld).length - 1;
          if (occurrences > 1 && !replaceAll) {
            return {
              isError: true,
              output: `edit_file failed: oldString matched ${occurrences} locations in ${rawPath}. Include more surrounding context or set replaceAll: true.`,
            };
          }

          const updatedLf = replaceAll
            ? normOriginal.split(targetOld).join(targetNew)
            : normOriginal.replace(targetOld, () => targetNew);

          const finalContent = usesCrlf ? updatedLf.replace(/\n/g, "\r\n") : updatedLf;
          opts.checkpoints.snapshotBeforeWrite(absPath);
          writeFileSync(absPath, finalContent, "utf8");
          const lspSummary = await collectDiagnosticsSummary(opts.lspManager, absPath, opts.cwd);
          return {
            output: `Edited ${rawPath} (${replaceAll ? occurrences : 1} replacement${occurrences > 1 && replaceAll ? "s" : ""})${lspSummary}`,
            summary: `${replaceAll ? occurrences : 1} replacement${occurrences > 1 && replaceAll ? "s" : ""}`,
            durationMs: Date.now() - startedAt,
            diff: { filePath: rawPath, before: normOriginal, after: updatedLf },
          };
        }

        case "apply_patch": {
          const startedAt = Date.now();
          const patchText = String(args.patchText ?? "");
          if (!patchText.trim()) {
            return { isError: true, output: "patchText is required" };
          }
          type Hunk = { oldLines: string[]; newLines: string[] };
          type PatchOp =
            | { kind: "add"; relPath: string; content: string }
            | { kind: "delete"; relPath: string }
            | { kind: "update"; relPath: string; hunks: Hunk[] };

          const lines = patchText.replace(/\r\n/g, "\n").split("\n");
          const ops: PatchOp[] = [];
          let i = 0;

          while (i < lines.length) {
            const line = lines[i]!;
            if (line.startsWith("*** Add File:")) {
              const relPath = line.slice("*** Add File:".length).trim();
              i++;
              const contentLines: string[] = [];
              while (i < lines.length && !lines[i]!.startsWith("*** ")) {
                const l = lines[i]!;
                contentLines.push(l.startsWith("+") ? l.slice(1) : l);
                i++;
              }
              if (!relPath) {
                return { isError: true, output: "apply_patch error: empty '*** Add File:' path." };
              }
              ops.push({ kind: "add", relPath, content: contentLines.join("\n") + "\n" });
              continue;
            }
            if (line.startsWith("*** Delete File:")) {
              const relPath = line.slice("*** Delete File:".length).trim();
              if (!relPath) {
                return { isError: true, output: "apply_patch error: empty '*** Delete File:' path." };
              }
              ops.push({ kind: "delete", relPath });
              i++;
              continue;
            }
            if (line.startsWith("*** Update File:")) {
              const relPath = line.slice("*** Update File:".length).trim();
              if (!relPath) {
                return { isError: true, output: "apply_patch error: empty '*** Update File:' path." };
              }
              i++;

              const hunks: Hunk[] = [];
              let currentHunk: Hunk | null = null;
              while (i < lines.length && !lines[i]!.startsWith("*** ")) {
                const l = lines[i]!;
                if (l.startsWith("@@")) {
                  if (currentHunk && (currentHunk.oldLines.length > 0 || currentHunk.newLines.length > 0)) {
                    hunks.push(currentHunk);
                  }
                  currentHunk = { oldLines: [], newLines: [] };
                  i++;
                  continue;
                }
                if (l.startsWith("---") || l.startsWith("+++")) {
                  i++;
                  continue;
                }
                if (!currentHunk) currentHunk = { oldLines: [], newLines: [] };
                if (l.startsWith("-")) {
                  currentHunk.oldLines.push(l.slice(1));
                } else if (l.startsWith("+")) {
                  currentHunk.newLines.push(l.slice(1));
                } else if (l.startsWith(" ")) {
                  currentHunk.oldLines.push(l.slice(1));
                  currentHunk.newLines.push(l.slice(1));
                } else if (l.length > 0) {
                  currentHunk.oldLines.push(l);
                  currentHunk.newLines.push(l);
                }
                i++;
              }
              if (currentHunk && (currentHunk.oldLines.length > 0 || currentHunk.newLines.length > 0)) {
                hunks.push(currentHunk);
              }
              ops.push({ kind: "update", relPath, hunks });
              continue;
            }
            i++;
          }

          if (ops.length === 0) {
            return { isError: true, output: "No valid *** Add/Update/Delete File sections matched in patchText." };
          }

          for (const op of ops) {
            const guard = await authorizeTool("write", op.relPath, {
              absPath: resolveWorkspacePath(opts.cwd, op.relPath),
              label: `apply_patch(${op.relPath})`,
            });
            if (guard) return guard;
          }

          // Stage every file in memory first. Nothing is written unless every hunk matches.
          type StagedWrite = {
            absPath: string;
            relPath: string;
            before: string;
            after: string | null;
            label: string;
          };
          const staged = new Map<string, StagedWrite>();

          for (const op of ops) {
            const absPath = resolveWorkspacePath(opts.cwd, op.relPath);
            const existing = staged.get(absPath);
            const diskBefore = existsSync(absPath) ? readFileSync(absPath, "utf8") : null;
            const original = existing
              ? (existing.after ?? existing.before)
              : (diskBefore ?? "");

            if (op.kind === "add") {
              staged.set(absPath, {
                absPath,
                relPath: op.relPath,
                before: original,
                after: op.content,
                label: `added ${op.relPath}`,
              });
              continue;
            }

            if (op.kind === "delete") {
              if (!existing && diskBefore === null) {
                return { isError: true, output: `apply_patch error: file not found: ${op.relPath}` };
              }
              staged.set(absPath, {
                absPath,
                relPath: op.relPath,
                before: original,
                after: null,
                label: `deleted ${op.relPath}`,
              });
              continue;
            }

            if (!existing && diskBefore === null) {
              return {
                isError: true,
                output: `apply_patch aborted: file not found: ${op.relPath}. No files were changed.`,
              };
            }
            if (op.hunks.length === 0) {
              return {
                isError: true,
                output: `apply_patch aborted: '*** Update File: ${op.relPath}' contained no hunks. No files were changed.`,
              };
            }

            const usesCrlf = (existing ? (existing.after ?? existing.before) : (diskBefore ?? "")).includes(
              "\r\n",
            );
            let cur = original.replace(/\r\n/g, "\n");
            for (let hunkIdx = 0; hunkIdx < op.hunks.length; hunkIdx++) {
              const hunk = op.hunks[hunkIdx]!;
              const oldBlock = hunk.oldLines.join("\n");
              const newBlock = hunk.newLines.join("\n");
              let applied = false;

              if (oldBlock.length > 0 && cur.includes(oldBlock)) {
                cur = cur.replace(oldBlock, () => newBlock);
                applied = true;
              } else if (oldBlock.length > 0) {
                const curArr = cur.split("\n");
                const oldArr = hunk.oldLines;
                for (let s = 0; s <= curArr.length - oldArr.length; s++) {
                  let ok = true;
                  for (let k = 0; k < oldArr.length; k++) {
                    if (curArr[s + k]!.trim() !== oldArr[k]!.trim()) {
                      ok = false;
                      break;
                    }
                  }
                  if (ok) {
                    curArr.splice(s, oldArr.length, ...hunk.newLines);
                    cur = curArr.join("\n");
                    applied = true;
                    break;
                  }
                }
              } else if (newBlock.length > 0) {
                cur = cur + (cur.endsWith("\n") ? "" : "\n") + newBlock + "\n";
                applied = true;
              }

              if (!applied) {
                return {
                  isError: true,
                  output: `apply_patch aborted: hunk ${hunkIdx + 1}/${op.hunks.length} for ${op.relPath} did not match the file. No files were changed; re-read the file and send a corrected patch.`,
                };
              }
            }

            staged.set(absPath, {
              absPath,
              relPath: op.relPath,
              before: existing ? existing.before : (diskBefore ?? ""),
              after: usesCrlf ? cur.replace(/\n/g, "\r\n") : cur,
              label: `updated ${op.relPath}`,
            });
          }

          const touched: string[] = [];
          let lastDiff: ToolExecutionDiff | undefined;
          const lspSummaries: string[] = [];
          for (const write of staged.values()) {
            opts.checkpoints.snapshotBeforeWrite(write.absPath);
            if (write.after === null) {
              rmSync(write.absPath, { force: true });
            } else {
              mkdirSync(dirname(write.absPath), { recursive: true });
              writeFileSync(write.absPath, write.after, "utf8");
            }
            lastDiff = {
              filePath: write.relPath,
              before: write.before,
              after: write.after ?? "",
            };
            touched.push(write.label);
            if (write.after !== null) {
              const summary = await collectDiagnosticsSummary(opts.lspManager, write.absPath, opts.cwd);
              if (summary) lspSummaries.push(summary.trim());
            }
          }

          return {
            output: `Applied patch: ${touched.join(", ")}${lspSummaries.length > 0 ? `\n\n${lspSummaries.join("\n\n")}` : ""}`,
            summary: touched.join(", "),
            durationMs: Date.now() - startedAt,
            diff: lastDiff,
          };
        }

        case "glob_files": {
          const startedAt = Date.now();
          const pattern = String(args.pattern ?? "**/*");
          const searchRoot = args.path
            ? resolveWorkspacePath(opts.cwd, String(args.path))
            : opts.cwd;
          const includeHidden = args.hidden === true;
          const readDenied = await authorizeTool("read", String(args.path ?? "."), {
            absPath: searchRoot,
            label: `glob_files(${String(args.path ?? ".")})`,
          });
          if (readDenied) return readDenied;
          const allFiles = walkFiles(searchRoot, includeHidden);
          const rx = globToRegExp(pattern);
          const matched = allFiles
            .map((abs) => relative(searchRoot, abs).replace(/\\/g, "/"))
            .filter((rel) => rx.test(rel) || rx.test(rel.split("/").pop() ?? ""));
          const shown = matched.slice(0, 200);
          return {
            output:
              matched.length > 0
                ? shown.join("\n") +
                  (matched.length > shown.length
                    ? `\n... (${matched.length - shown.length} more matches truncated; narrow the pattern or path)`
                    : "")
                : `No files matched pattern: ${pattern}`,
            summary: `${matched.length} files`,
            durationMs: Date.now() - startedAt,
          };
        }

        case "grep_search": {
          const startedAt = Date.now();
          const pattern = String(args.pattern ?? "");
          if (!pattern) return { isError: true, output: "pattern is required" };
          const searchTarget = args.path
            ? resolveWorkspacePath(opts.cwd, String(args.path))
            : opts.cwd;
          const readDenied = await authorizeTool("read", String(args.path ?? "."), {
            absPath: searchTarget,
            label: `grep_search(${String(args.path ?? ".")})`,
          });
          if (readDenied) return readDenied;
          const literal = args.literal === true;
          const caseSensitive = args.caseSensitive !== false;
          const flags = caseSensitive ? "" : "i";
          const rx = literal
            ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags)
            : new RegExp(pattern, flags);

          const includeRx =
            typeof args.include === "string" && args.include.trim()
              ? globToRegExp(args.include.trim())
              : null;

          const files =
            existsSync(searchTarget) && statSync(searchTarget).isFile()
              ? [searchTarget]
              : walkFiles(searchTarget, false);

          const matches: string[] = [];
          let truncated = false;
          let scanned = 0;
          for (const file of files) {
            if (opts.signal?.aborted) {
              return { isError: true, output: "grep_search cancelled by user." };
            }
            if (matches.length >= 100) {
              truncated = true;
              break;
            }
            const rel = relative(opts.cwd, file).replace(/\\/g, "/");
            if (includeRx && !includeRx.test(rel) && !includeRx.test(rel.split("/").pop() ?? "")) {
              continue;
            }
            try {
              if (statSync(file).size > 5 * 1024 * 1024) continue;
            } catch {
              continue;
            }
            let text: string;
            try {
              text = await readFile(file, "utf8");
            } catch {
              continue;
            }
            if (text.includes("\0")) continue;
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (rx.test(lines[i]!)) {
                matches.push(`${rel}:${i + 1}: ${lines[i]!.slice(0, 240)}`);
                if (matches.length >= 100) {
                  truncated = true;
                  break;
                }
              }
            }
            scanned++;
            // Give the TUI spinner / key handling a chance on large repositories.
            if (scanned % 25 === 0) {
              await new Promise<void>((resolveYield) => setImmediate(resolveYield));
            }
          }

          return {
            output:
              matches.length > 0
                ? matches.join("\n") +
                  (truncated ? "\n... (results capped at 100 matches; narrow the search)" : "")
                : `No matches found for: ${pattern}`,
            summary: `${matches.length} matches`,
            durationMs: Date.now() - startedAt,
          };
        }

        case "code_search":
        case "web_search": {
          if (opts.webSearchEnabled === false) {
            return {
              isError: true,
              output: "Web search is currently disabled in settings (enable with `/web on`).",
            };
          }
          const startedAt = Date.now();
          const query = String(args.query ?? "").trim();
          if (!query) return { isError: true, output: "query is required" };
          const networkDenied = await authorizeTool("webfetch", `search:${query}`, {
            label: "web_search",
          });
          if (networkDenied) return networkDenied;
          const maxResults = typeof args.maxResults === "number" ? args.maxResults : 8;
          const searchType =
            name === "code_search"
              ? "code"
              : args.type === "fast" || args.type === "deep" || args.type === "code"
                ? args.type
                : "auto";
          const livecrawl = args.livecrawl === "preferred" ? "preferred" : "fallback";
          const res = await webSearchRouter.search({
            query,
            maxResults,
            type: searchType,
            livecrawl,
            signal: opts.signal,
          });
          const formatted = res.sources
            .map(
              (s, idx) =>
                `${idx + 1}. **${s.title}**\n   URL: ${s.url}${s.publishedAt ? `\n   Published: ${s.publishedAt}` : ""}${s.snippet ? `\n   Highlights: ${s.snippet}` : ""}`,
            )
            .join("\n\n");
          return {
            output:
              res.sources.length > 0
                ? `Search results via ${res.provider} (${res.sources.length} sources):\n\n${formatted}`
                : `No web search results found for: ${query}`,
            summary: `${res.sources.length} results via ${res.provider}`,
            durationMs: Date.now() - startedAt,
          };
        }

        case "web_fetch": {
          const startedAt = Date.now();
          const url = String(args.url ?? "").trim();
          const format =
            args.format === "text" || args.format === "html" ? args.format : "markdown";
          let host = "";
          try {
            host = new URL(url).hostname;
          } catch {
            /* clientWebFetch will return a clearer invalid-URL error */
          }
          const networkDenied = await authorizeTool("webfetch", host || url, {
            label: `web_fetch(${url})`,
          });
          if (networkDenied) return networkDenied;
          const res = await clientWebFetch({
            url,
            format,
            fetchFn: opts.fetchFn,
            signal: opts.signal,
          });
          return {
            output: res.content,
            summary: `${res.contentType.split(";")[0]} (${res.content.length} chars)`,
            durationMs: Date.now() - startedAt,
          };
        }

        case "run_shell": {
          const startedAt = Date.now();
          let command = String(args.command ?? "").trim();
          if (!command) return { isError: true, output: "Empty command" };

          for (const bad of DANGEROUS_SHELL_PATTERNS) {
            if (bad.test(command)) {
              return {
                isError: true,
                output: `Blocked dangerous command pattern: ${command}`,
              };
            }
          }

          const guard = await authorizeTool("shell", command, {
            label: `run_shell: ${command}`,
          });
          if (guard) return guard;

          // Translate cmd.exe / POSIX idioms on Windows PowerShell
          const winShellBin = detectWindowsPowerShellBin();
          if (process.platform === "win32") {
            command = normalizeWindowsShellCommand(command, winShellBin === "pwsh.exe");
          }

          const workdir = args.workdir
            ? resolveWorkspacePath(opts.cwd, String(args.workdir))
            : opts.cwd;

          if (opts.permissionEngine && !opts.permissionEngine.isWithinWorkspace(workdir)) {
            const workdirGuard = await authorizeTool("write", workdir, {
              absPath: workdir,
              label: `run_shell workdir ${workdir}`,
            });
            if (workdirGuard) return workdirGuard;
          }

          // With no OS sandbox (notably Windows), inspect explicit path tokens so a shell
          // command cannot silently read/write outside the workspace. This is advisory,
          // not a security boundary, but it catches the common accidental case.
          if (opts.permissionEngine && !opts.shellSandbox?.enforced) {
            for (const candidate of extractShellPathCandidates(command)) {
              const absCandidate = resolveShellPathCandidate(candidate, workdir);
              if (!absCandidate) continue;
              if (opts.permissionEngine.isWithinWorkspace(absCandidate)) continue;
              if (isPathInside(tmpdir(), absCandidate)) continue;
              if (["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"].includes(candidate)) {
                continue;
              }
              const pathGuard = await authorizeTool("write", candidate, {
                absPath: absCandidate,
                label: `run_shell path ${candidate}`,
              });
              if (pathGuard) return pathGuard;
            }
          }

          if (opts.signal?.aborted) {
            return { isError: true, output: "Command cancelled by user before it started." };
          }

          const baseShellBin = process.platform === "win32" ? winShellBin : "/bin/sh";
          const baseShellArgs =
            process.platform === "win32"
              ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
              : ["-c", command];
          const sandboxed = opts.shellSandbox
            ? opts.shellSandbox.wrap(command, baseShellBin, baseShellArgs, workdir)
            : {
                bin: baseShellBin,
                args: baseShellArgs,
                enforced: false,
                description: "no OS sandbox",
              };
          const sandboxTag = sandboxed.enforced ? ` [sandbox: ${sandboxed.description}]` : "";
          const childEnv = buildChildEnv({
            allow: opts.envAllow,
            extra: {
              GIT_TERMINAL_PROMPT: "0",
              GIT_EDITOR: "true",
              GIT_MERGE_AUTOEDIT: "no",
              GCM_INTERACTIVE: "never",
              NO_COLOR: "1",
              TERM: "dumb",
              CI: "true",
            },
          });

          if (args.background === true) {
            if (opts.backgroundJobs) {
              const job = opts.backgroundJobs.startJob({
                command,
                cwd: workdir,
                shellBin: sandboxed.bin,
                shellArgs: sandboxed.args,
                env: childEnv,
              });
              return {
                output: `Started background job ${job.id} (PID: ${job.pid ?? "running"}): ${command}${sandboxTag}\nUse /jobs or /logs ${job.id} to view output.`,
                summary: `${job.id} (PID ${job.pid ?? "ok"})`,
                durationMs: Date.now() - startedAt,
              };
            }
            const child = spawn(sandboxed.bin, sandboxed.args, {
              cwd: workdir,
              env: childEnv,
              detached: process.platform !== "win32",
              stdio: "ignore",
              windowsHide: true,
            });
            child.unref();
            return {
              output: `Started background command (PID: ${child.pid ?? "detached"}): ${command}${sandboxTag}`,
              summary: `background PID ${child.pid ?? "ok"}`,
              durationMs: Date.now() - startedAt,
            };
          }

          const timeoutMs =
            typeof args.timeoutMs === "number" && args.timeoutMs > 0
              ? Math.min(args.timeoutMs, 300_000)
              : 60_000;

          const output = await new Promise<{ text: string; code: number }>((resPromise) => {
            const child = spawn(sandboxed.bin, sandboxed.args, {
              cwd: workdir,
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
              // POSIX: own process group so timeouts/aborts can terminate grandchildren too.
              detached: process.platform !== "win32",
              env: childEnv,
            });
            let outBuf = "";
            let errBuf = "";
            let settled = false;
            let aborted = false;

            const detachAbort = () => {
              opts.signal?.removeEventListener("abort", onAbort);
            };

            const finish = (code: number, timedOut = false) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              detachAbort();
              try {
                child.stdout?.destroy();
                child.stderr?.destroy();
              } catch {
                /* ignore */
              }
              const rawCombined = [outBuf, errBuf]
                .filter(Boolean)
                .join("\n")
                .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
                .trim();
              resPromise({
                text:
                  rawCombined ||
                  (code === 0
                    ? "(no output)"
                    : aborted
                      ? "Command cancelled by user"
                      : timedOut
                        ? "Command timed out"
                        : "Command failed"),
                code,
              });
            };

            child.stdout.on("data", (d: Buffer) => {
              if (outBuf.length < MAX_SHELL_CAPTURE_CHARS) outBuf += d.toString("utf8");
            });
            child.stderr.on("data", (d: Buffer) => {
              if (errBuf.length < MAX_SHELL_CAPTURE_CHARS) errBuf += d.toString("utf8");
            });

            const onAbort = () => {
              aborted = true;
              errBuf += "\n[Command cancelled by user]";
              killProcessTree(child);
              finish(130);
            };

            const timer = setTimeout(() => {
              killProcessTree(child);
              finish(124, true);
            }, timeoutMs);

            if (opts.signal) {
              if (opts.signal.aborted) {
                onAbort();
              } else {
                opts.signal.addEventListener("abort", onAbort, { once: true });
              }
            }

            child.on("exit", (code) => {
              setTimeout(() => finish(code ?? 0), 80);
            });
            child.on("error", (err) => {
              errBuf += `\n${err.message}`;
              finish(1);
            });
          });

          let formatted = output.text;
          if (formatted.length > MAX_INLINE_OUTPUT_CHARS) {
            const spillDir = join(tmpdir(), "aivokey-cli-spill");
            mkdirSync(spillDir, { recursive: true });
            const spillFile = join(spillDir, `cmd-${Date.now()}.log`);
            writeFileSync(spillFile, formatted, "utf8");
            formatted =
              formatted.slice(0, MAX_INLINE_OUTPUT_CHARS) +
              `\n\n... [Output truncated (${formatted.length} chars captured). Captured output saved to ${spillFile}]`;
          }

          if (output.code !== 0) {
            return {
              isError: true,
              output: `Exit code ${output.code}:\n${formatted}`,
              summary: `exit ${output.code}`,
              durationMs: Date.now() - startedAt,
            };
          }
          return {
            output: formatted,
            summary: "exit 0",
            durationMs: Date.now() - startedAt,
          };
        }

        case "lsp_diagnostics": {
          const startedAt = Date.now();
          if (!opts.lspManager) {
            return { isError: true, output: "LSP is not configured for this session." };
          }
          const rawPath = String(args.path ?? "").trim();
          if (!rawPath) return { isError: true, output: "lsp_diagnostics error: 'path' is required." };
          const absPath = resolveWorkspacePath(opts.cwd, rawPath);
          const readDenied = await authorizeTool("read", rawPath, { absPath });
          if (readDenied) return readDenied;
          try {
            const result = await opts.lspManager.diagnostics(absPath);
            const relativePath = relative(opts.cwd, absPath).replace(/\\/g, "/") || rawPath;
            if (result.diagnostics.length === 0) {
              return {
                output: `No diagnostics for ${relativePath} (${result.server}).`,
                summary: "0 diagnostics",
                durationMs: Date.now() - startedAt,
              };
            }
            const lines = result.diagnostics.map((diagnostic) => {
              const start = diagnostic.range?.start ?? { line: 0, character: 0 };
              return `${relativePath}:${start.line + 1}:${start.character + 1} [${severityLabel(diagnostic.severity)}] ${diagnostic.message}${diagnostic.source ? ` (${diagnostic.source})` : ""}`;
            });
            return {
              output: `${lines.join("\n")}\n\n${result.diagnostics.length} diagnostic(s) from ${result.server}.`,
              summary: `${result.diagnostics.length} diagnostics`,
              durationMs: Date.now() - startedAt,
            };
          } catch (err) {
            return {
              isError: true,
              output: `lsp_diagnostics error: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }
        case "lsp_hover":
        case "lsp_definition":
        case "lsp_references": {
          const startedAt = Date.now();
          if (!opts.lspManager) {
            return { isError: true, output: "LSP is not configured for this session." };
          }
          const rawPath = String(args.path ?? "").trim();
          const line = Number(args.line);
          const character = Number(args.character);
          if (!rawPath || !Number.isInteger(line) || line < 1 || !Number.isInteger(character) || character < 1) {
            return {
              isError: true,
              output: `${name} error: 'path', 1-based 'line', and 1-based 'character' are required.`,
            };
          }
          const absPath = resolveWorkspacePath(opts.cwd, rawPath);
          const readDenied = await authorizeTool("read", rawPath, { absPath });
          if (readDenied) return readDenied;
          const position = { line: line - 1, character: character - 1 };
          try {
            if (name === "lsp_hover") {
              const result = await opts.lspManager.hover(absPath, position);
              const text = result.hover?.contents?.trim();
              return {
                output: text
                  ? `${text}\n\n(${result.server})`
                  : `No hover information at ${rawPath}:${line}:${character}.`,
                summary: result.server,
                durationMs: Date.now() - startedAt,
              };
            }
            const result =
              name === "lsp_definition"
                ? await opts.lspManager.definition(absPath, position)
                : await opts.lspManager.references(absPath, position);
            if (result.locations.length === 0) {
              return {
                output: `No ${name === "lsp_definition" ? "definition" : "references"} found at ${rawPath}:${line}:${character}.`,
                summary: result.server,
                durationMs: Date.now() - startedAt,
              };
            }
            return {
              output: `${result.locations.map((location) => formatLspLocation(location, opts.cwd)).join("\n")}\n\n${result.locations.length} location(s) from ${result.server}.`,
              summary: `${result.locations.length} locations`,
              durationMs: Date.now() - startedAt,
            };
          } catch (err) {
            return {
              isError: true,
              output: `${name} error: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }
        case "lsp_document_symbols": {
          const startedAt = Date.now();
          if (!opts.lspManager) {
            return { isError: true, output: "LSP is not configured for this session." };
          }
          const rawPath = String(args.path ?? "").trim();
          if (!rawPath) {
            return { isError: true, output: "lsp_document_symbols error: 'path' is required." };
          }
          const absPath = resolveWorkspacePath(opts.cwd, rawPath);
          const readDenied = await authorizeTool("read", rawPath, { absPath });
          if (readDenied) return readDenied;
          try {
            const result = await opts.lspManager.documentSymbols(absPath);
            const relativePath = relative(opts.cwd, absPath).replace(/\\/g, "/") || rawPath;
            const lines = formatDocumentSymbols(result.symbols, relativePath);
            return {
              output:
                lines.length > 0
                  ? `${lines.join("\n")}\n\n${result.symbols.length} symbol(s) from ${result.server}.`
                  : `No symbols found in ${relativePath} (${result.server}).`,
              summary: `${result.symbols.length} symbols`,
              durationMs: Date.now() - startedAt,
            };
          } catch (err) {
            return {
              isError: true,
              output: `lsp_document_symbols error: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }
        case "lsp_workspace_symbols": {
          const startedAt = Date.now();
          if (!opts.lspManager) {
            return { isError: true, output: "LSP is not configured for this session." };
          }
          const query = String(args.query ?? "").trim();
          if (!query) {
            return { isError: true, output: "lsp_workspace_symbols error: 'query' is required." };
          }
          try {
            const results = await opts.lspManager.workspaceSymbols(query);
            const lines: string[] = [];
            for (const result of results) {
              if (result.symbols.length === 0) continue;
              lines.push(`[${result.server}]`);
              lines.push(...formatWorkspaceSymbols(result.symbols, opts.cwd));
            }
            return {
              output: lines.length > 0 ? lines.join("\n") : `No workspace symbols matched '${query}'.`,
              summary: `${results.reduce((total, item) => total + item.symbols.length, 0)} symbols`,
              durationMs: Date.now() - startedAt,
            };
          } catch (err) {
            return {
              isError: true,
              output: `lsp_workspace_symbols error: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }
        case "todo_write": {
          const incoming = Array.isArray(args.todos) ? args.todos : [];
          opts.todos.length = 0;
          for (const raw of incoming) {
            if (typeof raw !== "object" || raw === null) continue;
            const item = raw as Record<string, unknown>;
            const status =
              item.status === "completed" || item.status === "in_progress"
                ? item.status
                : "pending";
            opts.todos.push({
              id: String(item.id ?? opts.todos.length + 1),
              content: String(item.content ?? ""),
              status,
            });
          }
          const done = opts.todos.filter((t) => t.status === "completed").length;
          return {
            output: `Updated todos:\n${formatTodoList(opts.todos)}`,
            summary: `${done}/${opts.todos.length} completed`,
          };
        }

        case "memory_remember": {
          const guard = await checkMutationAllowed("memory_remember");
          if (guard) return guard;
          const category = (args.category ?? "workflow") as MemoryCategory;
          const title = String(args.title ?? "");
          const content = String(args.content ?? "");
          const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
          const entry = memory.remember({
            category,
            title,
            content,
            tags,
            projectScope: opts.cwd,
          });
          return {
            output: `Saved to self-learning memory [${entry.category}]: ${entry.title}`,
            summary: entry.title,
          };
        }

        case "memory_search": {
          const query = String(args.query ?? "");
          const hits = memory.recall(query, opts.cwd, 8);
          if (hits.length === 0) {
            return { output: `No memories found matching: ${query}` };
          }
          return {
            output: hits
              .map((m) => `- [${m.category}] **${m.title}**: ${m.content}`)
              .join("\n"),
            summary: `${hits.length} memories`,
          };
        }

        case "skill_load": {
          const id = String(args.id ?? "").trim();
          if (id === "list" || !id) {
            const list = skills.listSkills();
            if (list.length === 0) return { output: "No skills discovered." };
            return {
              output: list.map((s) => `- **${s.id}** (${s.name}): ${s.description}`).join("\n"),
              summary: `${list.length} skills`,
            };
          }
          const loaded = skills.loadSkill(id);
          if (!loaded) {
            return {
              isError: true,
              output: `Skill '${id}' not found. Call skill_load with id='list' to see available skills.`,
            };
          }
          const supporting =
            loaded.supportingFiles.length > 0
              ? `\n\nSupporting files:\n${loaded.supportingFiles.map((f) => `- ${f}`).join("\n")}`
              : "";
          return {
            output: `<skill name="${loaded.id}">\n# ${loaded.name}\n\n${loaded.body}${supporting}\n</skill>`,
            summary: loaded.name,
          };
        }

        case "skill_create": {
          const guard = await checkMutationAllowed("skill_create");
          if (guard) return guard;
          const id = String(args.id ?? "");
          const skillName = String(args.name ?? id);
          const description = String(args.description ?? "");
          const body = String(args.body ?? "");
          const scope = args.scope === "project" ? "project" : "global";
          const created = skills.createOrEvolveSkill({
            id,
            name: skillName,
            description,
            body,
            scope,
          });
          return {
            output: `Created/evolved skill '${created.id}' at ${created.sourcePath}`,
            summary: created.id,
          };
        }

        case "anti_slop_audit": {
          const targetRel = typeof args.path === "string" ? args.path.trim() : "";
          const filesToAudit = targetRel
            ? [resolveWorkspacePath(opts.cwd, targetRel)]
            : opts.checkpoints.listModifiedFiles();

          if (targetRel) {
            const readDenied = await authorizeTool("read", targetRel, {
              absPath: filesToAudit[0],
              label: `anti_slop_audit(${targetRel})`,
            });
            if (readDenied) return readDenied;
          }

          if (filesToAudit.length === 0) {
            return { output: "No files to audit (clean)." };
          }

          const reports = filesToAudit
            .filter((f) => existsSync(f) && statSync(f).isFile())
            .map((f) => auditCodeForSlop(relative(opts.cwd, f), readFileSync(f, "utf8")));

          const allIssues = reports.flatMap((r) =>
            r.issues.map((iss) => `${r.filePath}:${iss.line} [${iss.severity}] ${iss.message}: ${iss.excerpt}`),
          );

          if (allIssues.length === 0) {
            return {
              output: `Anti-AI-Slop Audit passed: ${reports.length} file(s) clean.`,
              summary: "clean",
            };
          }
          return {
            output: `Anti-AI-Slop Audit found ${allIssues.length} issue(s):\n${allIssues.join("\n")}`,
            summary: `${allIssues.length} issues`,
          };
        }

        case "browser_navigate":
        case "browser_snapshot":
        case "browser_interact":
        case "browser_screenshot": {
          const startedAt = Date.now();
          if (opts.mode === "plan" || opts.readOnlyOnly) {
            return {
              isError: true,
              output: `Blocked: ${name} mutates or navigates a live browser and is not available in plan/read-only mode.`,
            };
          }          const isReadOnlyAction =
            name === "browser_snapshot" || name === "browser_screenshot";
          if (!isReadOnlyAction) {
            const guard = await checkMutationAllowed(name);
            if (guard) return guard;
          }
          const browser = getBrowserSession();
          try {
            if (name === "browser_navigate") {
              const url = String(args.url ?? "").trim();
              if (!url) {
                return { isError: true, output: "browser_navigate error: 'url' is required." };
              }
              const result = await browser.open(url);
              return {
                output: result.snapshot ? browser.formatSnapshot(result.snapshot) : result.output,
                isError: result.isError,
                summary: "navigate",
                durationMs: Date.now() - startedAt,
              };
            }
            if (name === "browser_snapshot") {
              const snapshot = await browser.snapshot();
              return {
                output: browser.formatSnapshot(snapshot),
                summary: "snapshot",
                durationMs: Date.now() - startedAt,
              };
            }
            if (name === "browser_screenshot") {
              const fullPage = args.fullPage !== false;
              const result = await browser.screenshot(fullPage);
              return {
                output: result.output,
                isError: result.isError,
                summary: fullPage ? "full-page" : "viewport",
                durationMs: Date.now() - startedAt,
                imageAttachment: result.screenshot,
              };
            }
            const action = String(args.action ?? "");
            const selector = String(args.selector ?? "").trim();
            const value = typeof args.value === "string" ? args.value : "";
            let result;
            if (action === "click") {
              if (!selector) {
                return { isError: true, output: "browser_interact click error: 'selector' is required." };
              }
              result = await browser.click(selector);
            } else if (action === "fill") {
              if (!selector) {
                return { isError: true, output: "browser_interact fill error: 'selector' is required." };
              }
              result = await browser.fill(selector, value);
            } else if (action === "press") {
              if (!value) {
                return { isError: true, output: "browser_interact press error: 'value' key is required." };
              }
              result = await browser.pressKey(value);
            } else if (action === "wait") {
              if (!selector) {
                return { isError: true, output: "browser_interact wait error: 'selector' is required." };
              }
              result = await browser.waitFor(
                selector,
                typeof args.timeoutMs === "number" && args.timeoutMs > 0
                  ? Math.min(120_000, args.timeoutMs)
                  : undefined,
              );
            } else if (action === "eval") {
              if (!value) {
                return { isError: true, output: "browser_interact eval error: 'value' JS is required." };
              }
              result = await browser.evaluateExpression(value);
            } else {
              return {
                isError: true,
                output: `browser_interact error: action must be one of click, fill, press, wait, eval.`,
              };
            }
            const snapshot = action === "click" || action === "fill" || action === "press"
              ? await browser.snapshot()
              : undefined;
            return {
              output: snapshot ? `${result.output}\n\n${browser.formatSnapshot(snapshot)}` : result.output,
              isError: result.isError,
              summary: action,
              durationMs: Date.now() - startedAt,
            };
          } catch (err) {
            return {
              isError: true,
              output: `${name} error: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }

        case "notebook_read":
        case "notebook_edit": {
          const startedAt = Date.now();
          const rawPath = String(args.path ?? "").trim();
          if (!rawPath) {
            return { isError: true, output: `${name} error: 'path' is required.` };
          }
          const absPath = resolveWorkspacePath(opts.cwd, rawPath);
          const isEdit = name === "notebook_edit";
          const guard = await authorizeTool(isEdit ? "write" : "read", rawPath, {
            absPath,
            label: `${name}(${rawPath})`,
          });
          if (guard) return guard;
          try {
            if (!isEdit) {
              const doc = readNotebook(absPath);
              return {
                output: formatNotebook(doc),
                summary: `${doc.cells.length} cells`,
                durationMs: Date.now() - startedAt,
              };
            }
            const action = String(args.action ?? "edit");
            if (action !== "edit" && action !== "insert" && action !== "delete") {
              return {
                isError: true,
                output: "notebook_edit error: action must be edit, insert, or delete.",
              };
            }
            const before = readNotebook(absPath);
            const beforeText = formatNotebook(before, 0);
            let message: string;
            if (action === "insert") {
              const index = Number(args.index ?? before.cells.length + 1);
              if (!Number.isFinite(index)) {
                return { isError: true, output: "notebook_edit insert error: 'index' must be a number." };
              }
              message = insertNotebookCell(absPath, {
                index,
                source: String(args.source ?? ""),
                cellType:
                  args.cellType === "markdown" || args.cellType === "raw"
                    ? args.cellType
                    : "code",
              });
            } else if (action === "delete") {
              const cell = Number(args.cell);
              if (!Number.isFinite(cell)) {
                return { isError: true, output: "notebook_edit delete error: 'cell' must be a number." };
              }
              message = deleteNotebookCell(absPath, cell);
            } else {
              const cell = Number(args.cell);
              if (!Number.isFinite(cell)) {
                return { isError: true, output: "notebook_edit edit error: 'cell' must be a number." };
              }
              message = editNotebookCell(absPath, {
                cell,
                source: typeof args.source === "string" ? args.source : undefined,
                cellType:
                  args.cellType === "code" || args.cellType === "markdown" || args.cellType === "raw"
                    ? args.cellType
                    : undefined,
              });
            }
            opts.checkpoints.snapshotBeforeWrite(absPath);
            const after = readNotebook(absPath);
            const afterText = formatNotebook(after, 0);
            return {
              output: message,
              summary: action,
              durationMs: Date.now() - startedAt,
              diff: { filePath: rawPath, before: beforeText, after: afterText },
            };
          } catch (err) {
            const message =
              err instanceof NotebookError || err instanceof Error
                ? err.message
                : String(err);
            return { isError: true, output: `${name} error: ${message}` };
          }
        }

        case "computer_use": {
          const startedAt = Date.now();
          const action = String(args.action ?? "window_list") as ComputerUseAction;
          if (
            action !== "window_list" &&
            action !== "screenshot" &&
            action !== "serve_preview" &&
            action !== "inspect_viewports"
          ) {
            const guard = await checkMutationAllowed(`computer_use(${action})`);
            if (guard) return guard;
          }
          const viewports = Array.isArray(args.viewports)
            ? (args.viewports.filter((v) =>
                ["desktop", "tablet", "mobile"].includes(String(v)),
              ) as ViewportPresetName[])
            : undefined;
          const res = await executeComputerUse(
            {
              action,
              cwd: opts.cwd,
              viewports,
              x: typeof args.x === "number" ? args.x : undefined,
              y: typeof args.y === "number" ? args.y : undefined,
              button:
                args.button === "right" || args.button === "double" ? args.button : "left",
              text: typeof args.text === "string" ? args.text : undefined,
              key: typeof args.key === "string" ? args.key : undefined,
              url: typeof args.url === "string" ? args.url : undefined,
            },
            { cwd: opts.cwd },
          );
          return {
            output: res.output,
            isError: res.isError,
            summary: action,
            durationMs: Date.now() - startedAt,
            imageAttachment: res.screenshotAttachment,
            imageAttachments: res.screenshotAttachments,
          };
        }

        case "subagent": {
          if (!opts.onSubagent) {
            return { isError: true, output: "Subagent execution is not enabled in this context." };
          }
          const agent = args.agent === "explore" ? "explore" : "general";
          const description = String(args.description ?? "subtask");
          const prompt = String(args.prompt ?? "");
          const subResult = await opts.onSubagent({ agent, description, prompt });
          return { output: subResult, summary: `${agent}: ${description}` };
        }

        case "team_workflow": {
          if (!opts.onTeamWorkflow) {
            return { isError: true, output: "Team workflow execution is not enabled in this context." };
          }
          const teamId = (args.team ?? "fullstack") as TeamId;
          const goal = String(args.goal ?? "");
          const out = await opts.onTeamWorkflow({ teamId, goal });
          return { output: out, summary: `team: ${teamId}` };
        }

        default:
          return { isError: true, output: `Unknown tool: ${name}` };
      }
    } catch (err) {
      return {
        isError: true,
        output: `Tool ${name} error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** Runs PreToolUse/PostToolUse hooks around the tool implementation. */
  async function execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const hooks = opts.hooks;
    if (!hooks?.hasHooks("PreToolUse") && !hooks?.hasHooks("PostToolUse")) {
      return executeCore(name, args);
    }

    let effectiveArgs = args;
    if (hooks.hasHooks("PreToolUse")) {
      const pre = await hooks.run("PreToolUse", {
        sessionId: opts.sessionId,
        cwd: opts.cwd,
        mode: opts.mode,
        tool: { name, args },
      });
      if (pre.blocked) {
        return {
          isError: true,
          output: `Blocked by PreToolUse hook: ${pre.reason ?? "no reason given"}`,
        };
      }
      if (pre.args && typeof pre.args === "object") effectiveArgs = pre.args;
      for (const context of pre.additionalContext) {
        opts.onHookContext?.(name, context);
      }
    }

    const result = await executeCore(name, effectiveArgs);

    if (hooks.hasHooks("PostToolUse")) {
      const post = await hooks.run("PostToolUse", {
        sessionId: opts.sessionId,
        cwd: opts.cwd,
        mode: opts.mode,
        tool: { name, args: effectiveArgs },
        result: { output: result.output, isError: result.isError },
      });
      for (const context of post.additionalContext) {
        opts.onHookContext?.(name, context);
      }
    }

    return result;
  }

  return { specs, execute, memory, skills, webSearchRouter, browser: () => browserSession, disposeBrowser: () => browserSession?.close() };
}
