import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { exec } from "node:child_process";
import type { PermissionMode } from "../config.js";
import type { ToolSpec } from "../protocol.js";
import type { CheckpointManager } from "../checkpoint.js";

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ToolExecutionResult {
  output: string;
  isError?: boolean;
}

export interface ToolsetOptions {
  cwd: string;
  mode: PermissionMode;
  checkpoints: CheckpointManager;
  todos: TodoItem[];
  readOnlyOnly?: boolean;
  confirmAction?: (description: string) => Promise<boolean>;
  onSubagent?: (input: {
    agent: "explore" | "general";
    description: string;
    prompt: string;
  }) => Promise<string>;
  fetchFn?: typeof fetch;
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
  /\brm\s+-rf\s+\/(?:\s|$)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bformat\s+[a-z]:/i,
];

const MAX_INLINE_OUTPUT_CHARS = 32_000;

function resolveWorkspacePath(cwd: string, p: string): string {
  const cleaned = p.trim();
  return isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned);
}

/**
 * Strip accidental `12: ` line-number prefixes when a model copies lines from `read_file`.
 */
export function stripLineNumberPrefixes(text: string): string {
  const lines = text.split("\n");
  const allHavePrefix =
    lines.length > 0 &&
    lines.every((l) => l.trim() === "" || /^\s*\d+:\s?/.test(l));
  if (!allHavePrefix) return text;
  return lines.map((l) => l.replace(/^\s*\d+:\s?/, "")).join("\n");
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/");
  let regexStr = "^";
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
  regexStr += "$";
  return new RegExp(regexStr, "i");
}

function walkFiles(
  rootDir: string,
  includeHidden: boolean = false,
  maxFiles: number = 2000,
): string[] {
  const results: string[] = [];
  function visit(currentDir: string) {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (!includeHidden && entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        visit(join(currentDir, entry.name));
      } else if (entry.isFile()) {
        results.push(join(currentDir, entry.name));
      }
    }
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
  const specs: ToolSpec[] = [
    {
      name: "read_file",
      description:
        "Read a file or directory. Returns 1-based line-numbered text (`1: content`). Use offset and limit for large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory path" },
          offset: { type: "number", description: "1-based starting line number (default: 1)" },
          limit: { type: "number", description: "Maximum lines to read (default: 500)" },
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
      name: "web_fetch",
      description: "Fetch a URL over HTTP/HTTPS and return its text content.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "HTTP/HTTPS URL to read" },
        },
        required: ["url"],
      },
    },
  ];

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
        name: "run_shell",
        description: "Execute a shell command in the workspace and return stdout/stderr.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to run" },
            workdir: { type: "string", description: "Working directory (optional)" },
            timeoutMs: { type: "number", description: "Timeout in milliseconds (default: 60000)" },
          },
          required: ["command"],
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
  }

  async function checkMutationAllowed(actionLabel: string): Promise<ToolExecutionResult | null> {
    if (opts.mode === "plan" || opts.readOnlyOnly) {
      return {
        isError: true,
        output: `Blocked: '${actionLabel}' is not allowed in plan mode (read-only). Formulate your plan using read/search tools only.`,
      };
    }
    if (opts.mode === "safe" && opts.confirmAction) {
      const ok = await opts.confirmAction(actionLabel);
      if (!ok) {
        return {
          isError: true,
          output: `User declined action: ${actionLabel}`,
        };
      }
    }
    return null;
  }

  async function execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    try {
      switch (name) {
        case "read_file": {
          const rawPath = String(args.path ?? "");
          const absPath = resolveWorkspacePath(opts.cwd, rawPath);
          if (!existsSync(absPath)) {
            return { isError: true, output: `File not found: ${rawPath}` };
          }
          const st = statSync(absPath);
          if (st.isDirectory()) {
            const entries = readdirSync(absPath, { withFileTypes: true }).map((e) =>
              e.isDirectory() ? `${e.name}/` : e.name,
            );
            return { output: `Directory ${rawPath}:\n${entries.join("\n")}` };
          }
          const content = readFileSync(absPath, "utf8");
          const lines = content.split(/\r?\n/);
          const offset = Math.max(1, typeof args.offset === "number" ? Math.floor(args.offset) : 1);
          const limit = Math.max(
            1,
            Math.min(2000, typeof args.limit === "number" ? Math.floor(args.limit) : 500),
          );
          const slice = lines.slice(offset - 1, offset - 1 + limit);
          const numbered = slice.map((line, i) => `${offset + i}: ${line}`).join("\n");
          const footer =
            offset - 1 + limit < lines.length
              ? `\n... (${lines.length - (offset - 1 + limit)} more lines; use offset=${offset + limit})`
              : "";
          return { output: numbered + footer };
        }

        case "write_file": {
          const rawPath = String(args.path ?? "");
          const content = String(args.content ?? "");
          const guard = await checkMutationAllowed(`write_file(${rawPath})`);
          if (guard) return guard;

          const absPath = resolveWorkspacePath(opts.cwd, rawPath);
          opts.checkpoints.snapshotBeforeWrite(absPath);
          mkdirSync(dirname(absPath), { recursive: true });
          writeFileSync(absPath, content, "utf8");
          const lineCount = content.split(/\r?\n/).length;
          return { output: `Wrote ${rawPath} (${lineCount} lines)` };
        }

        case "edit_file": {
          const rawPath = String(args.path ?? "");
          const rawOld = String(args.oldString ?? "");
          const rawNew = String(args.newString ?? "");
          const replaceAll = args.replaceAll === true;

          const guard = await checkMutationAllowed(`edit_file(${rawPath})`);
          if (guard) return guard;

          const absPath = resolveWorkspacePath(opts.cwd, rawPath);
          if (!existsSync(absPath)) {
            return { isError: true, output: `File not found: ${rawPath}` };
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
          return {
            output: `Edited ${rawPath} (${replaceAll ? occurrences : 1} replacement${occurrences > 1 && replaceAll ? "s" : ""})`,
          };
        }

        case "glob_files": {
          const pattern = String(args.pattern ?? "**/*");
          const searchRoot = args.path
            ? resolveWorkspacePath(opts.cwd, String(args.path))
            : opts.cwd;
          const includeHidden = args.hidden === true;
          const allFiles = walkFiles(searchRoot, includeHidden);
          const rx = globToRegExp(pattern);
          const matched = allFiles
            .map((abs) => relative(searchRoot, abs).replace(/\\/g, "/"))
            .filter((rel) => rx.test(rel) || rx.test(rel.split("/").pop() ?? ""));
          return {
            output:
              matched.length > 0
                ? matched.slice(0, 200).join("\n")
                : `No files matched pattern: ${pattern}`,
          };
        }

        case "grep_search": {
          const pattern = String(args.pattern ?? "");
          if (!pattern) return { isError: true, output: "pattern is required" };
          const searchTarget = args.path
            ? resolveWorkspacePath(opts.cwd, String(args.path))
            : opts.cwd;
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
          for (const file of files) {
            if (matches.length >= 100) break;
            const rel = relative(opts.cwd, file).replace(/\\/g, "/");
            if (includeRx && !includeRx.test(rel) && !includeRx.test(rel.split("/").pop() ?? "")) {
              continue;
            }
            let text: string;
            try {
              text = readFileSync(file, "utf8");
            } catch {
              continue;
            }
            if (text.includes("\0")) continue; // skip binary
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (rx.test(lines[i]!)) {
                matches.push(`${rel}:${i + 1}: ${lines[i]!.slice(0, 240)}`);
                if (matches.length >= 100) break;
              }
            }
          }

          return {
            output:
              matches.length > 0
                ? matches.join("\n")
                : `No matches found for: ${pattern}`,
          };
        }

        case "run_shell": {
          const command = String(args.command ?? "").trim();
          if (!command) return { isError: true, output: "Empty command" };

          for (const bad of DANGEROUS_SHELL_PATTERNS) {
            if (bad.test(command)) {
              return {
                isError: true,
                output: `Blocked dangerous command pattern: ${command}`,
              };
            }
          }

          const guard = await checkMutationAllowed(`run_shell: ${command}`);
          if (guard) return guard;

          const workdir = args.workdir
            ? resolveWorkspacePath(opts.cwd, String(args.workdir))
            : opts.cwd;
          const timeoutMs =
            typeof args.timeoutMs === "number" && args.timeoutMs > 0
              ? Math.min(args.timeoutMs, 300_000)
              : 60_000;

          const output = await new Promise<{ text: string; code: number }>((resPromise) => {
            exec(
              command,
              {
                cwd: workdir,
                timeout: timeoutMs,
                maxBuffer: 8 * 1024 * 1024,
                shell: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
              },
              (err, stdout, stderr) => {
                const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
                const exitCode =
                  err && typeof (err as { code?: unknown }).code === "number"
                    ? ((err as { code: number }).code)
                    : err
                      ? 1
                      : 0;
                resPromise({
                  text: combined || (exitCode === 0 ? "(no output)" : String(err?.message ?? "Command failed")),
                  code: exitCode,
                });
              },
            );
          });

          let formatted = output.text;
          if (formatted.length > MAX_INLINE_OUTPUT_CHARS) {
            const spillDir = join(tmpdir(), "aivokey-cli-spill");
            mkdirSync(spillDir, { recursive: true });
            const spillFile = join(spillDir, `cmd-${Date.now()}.log`);
            writeFileSync(spillFile, formatted, "utf8");
            formatted =
              formatted.slice(0, MAX_INLINE_OUTPUT_CHARS) +
              `\n\n... [Output truncated (${formatted.length} chars total). Full output saved to ${spillFile}]`;
          }

          if (output.code !== 0) {
            return {
              isError: true,
              output: `Exit code ${output.code}:\n${formatted}`,
            };
          }
          return { output: formatted };
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
          return { output: `Updated todos:\n${formatTodoList(opts.todos)}` };
        }

        case "web_fetch": {
          const url = String(args.url ?? "").trim();
          if (!/^https?:\/\//i.test(url)) {
            return { isError: true, output: `Invalid URL (must be http/https): ${url}` };
          }
          const fetchFn = opts.fetchFn ?? fetch;
          const res = await fetchFn(url, {
            headers: { "user-agent": "AivoCode-CLI/0.1" },
          });
          if (!res.ok) {
            return { isError: true, output: `HTTP ${res.status} fetching ${url}` };
          }
          const rawHtml = await res.text();
          const clean = rawHtml
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          return { output: clean.slice(0, 20_000) };
        }

        case "subagent": {
          if (!opts.onSubagent) {
            return { isError: true, output: "Subagent execution is not enabled in this context." };
          }
          const agent = args.agent === "explore" ? "explore" : "general";
          const description = String(args.description ?? "subtask");
          const prompt = String(args.prompt ?? "");
          const subResult = await opts.onSubagent({ agent, description, prompt });
          return { output: subResult };
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

  return { specs, execute };
}
