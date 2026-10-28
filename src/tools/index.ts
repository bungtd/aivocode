import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { exec, spawn, spawnSync } from "node:child_process";
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

export function walkWorkspaceFiles(
  rootDir: string,
  includeHidden: boolean = false,
  maxFiles: number = 2000,
): string[] {
  const absFiles = walkFiles(rootDir, includeHidden, maxFiles);
  return absFiles.map((f) => relative(rootDir, f).replace(/\\/g, "/"));
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
  const memory = opts.memory ?? new SelfLearningMemory();
  const skills = opts.skills ?? new SkillRegistry({ cwd: opts.cwd });
  const webSearchRouter =
    opts.webSearchRouter ??
    new ClientWebSearchRouter({
      loadLocalDshCredentials: opts.fetchFn === undefined,
      fetchFn: opts.fetchFn,
    });

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
      description: "Load specialized instructions from an installed or project skill (`SKILL.md`).",
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
          "Execute a shell command in the workspace and return stdout/stderr. Set background=true for dev servers or long-running processes.",
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
          const startedAt = Date.now();
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

          const content = readFileSync(absPath, "utf8");
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
          const guard = await checkMutationAllowed(`write_file(${rawPath})`);
          if (guard) return guard;

          const absPath = resolveWorkspacePath(opts.cwd, rawPath);
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
          return {
            output: `Wrote ${rawPath} (${lineCount} lines)`,
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
          const guard = await checkMutationAllowed(`image_generate(${rawOut})`);
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

          const guard = await checkMutationAllowed(`edit_file(${rawPath})`);
          if (guard) return guard;

          const absPath = resolveWorkspacePath(opts.cwd, rawPath);
          if (!existsSync(absPath)) {
            return { isError: true, output: `File not found: ${rawPath}` };
          }
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
          return {
            output: `Edited ${rawPath} (${replaceAll ? occurrences : 1} replacement${occurrences > 1 && replaceAll ? "s" : ""})`,
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
          const guard = await checkMutationAllowed("apply_patch");
          if (guard) return guard;

          const lines = patchText.replace(/\r\n/g, "\n").split("\n");
          const touched: string[] = [];
          let lastDiff: ToolExecutionDiff | undefined;
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
              const abs = resolveWorkspacePath(opts.cwd, relPath);
              const before = existsSync(abs) ? readFileSync(abs, "utf8") : "";
              const after = contentLines.join("\n") + "\n";
              opts.checkpoints.snapshotBeforeWrite(abs);
              mkdirSync(dirname(abs), { recursive: true });
              writeFileSync(abs, after, "utf8");
              lastDiff = { filePath: relPath, before, after };
              touched.push(`added ${relPath}`);
              continue;
            }
            if (line.startsWith("*** Delete File:")) {
              const relPath = line.slice("*** Delete File:".length).trim();
              const abs = resolveWorkspacePath(opts.cwd, relPath);
              const before = existsSync(abs) ? readFileSync(abs, "utf8") : "";
              opts.checkpoints.snapshotBeforeWrite(abs);
              if (existsSync(abs)) rmSync(abs, { force: true });
              lastDiff = { filePath: relPath, before, after: "" };
              touched.push(`deleted ${relPath}`);
              i++;
              continue;
            }
            if (line.startsWith("*** Update File:")) {
              const relPath = line.slice("*** Update File:".length).trim();
              const abs = resolveWorkspacePath(opts.cwd, relPath);
              i++;
              if (!existsSync(abs)) {
                return { isError: true, output: `apply_patch error: file not found: ${relPath}` };
              }
              const rawOriginal = readFileSync(abs, "utf8");
              const usesCrlf = rawOriginal.includes("\r\n");
              let cur = rawOriginal.replace(/\r\n/g, "\n");
              const before = cur;

              // Parse one or more @@ hunks inside this *** Update File section
              const hunks: Array<{ oldLines: string[]; newLines: string[] }> = [];
              let currentHunk: { oldLines: string[]; newLines: string[] } | null = null;

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
                if (!currentHunk) {
                  currentHunk = { oldLines: [], newLines: [] };
                }
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

              let appliedAny = false;
              for (const hunk of hunks) {
                const oldBlock = hunk.oldLines.join("\n");
                const newBlock = hunk.newLines.join("\n");
                if (oldBlock.length > 0 && cur.includes(oldBlock)) {
                  cur = cur.replace(oldBlock, () => newBlock);
                  appliedAny = true;
                } else if (oldBlock.length > 0) {
                  // Fallback: line-trimmed matching
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
                      appliedAny = true;
                      break;
                    }
                  }
                } else if (newBlock.length > 0) {
                  cur = cur + (cur.endsWith("\n") ? "" : "\n") + newBlock + "\n";
                  appliedAny = true;
                }
              }

              if (appliedAny) {
                opts.checkpoints.snapshotBeforeWrite(abs);
                writeFileSync(abs, usesCrlf ? cur.replace(/\n/g, "\r\n") : cur, "utf8");
                lastDiff = { filePath: relPath, before, after: cur };
                touched.push(`updated ${relPath}`);
              }
              continue;
            }
            i++;
          }

          if (touched.length === 0) {
            return { isError: true, output: "No valid *** Add/Update/Delete File sections matched in patchText." };
          }
          return {
            output: `Applied patch: ${touched.join(", ")}`,
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
            if (text.includes("\0")) continue;
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
          const res = await clientWebFetch({
            url,
            format,
            fetchFn: opts.fetchFn,
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

          const guard = await checkMutationAllowed(`run_shell: ${command}`);
          if (guard) return guard;

          // Translate cmd.exe / POSIX idioms on Windows PowerShell
          const winShellBin = detectWindowsPowerShellBin();
          if (process.platform === "win32") {
            command = normalizeWindowsShellCommand(command, winShellBin === "pwsh.exe");
          }

          const workdir = args.workdir
            ? resolveWorkspacePath(opts.cwd, String(args.workdir))
            : opts.cwd;

          if (args.background === true) {
            if (opts.backgroundJobs) {
              const job = opts.backgroundJobs.startJob({ command, cwd: workdir });
              return {
                output: `Started background job ${job.id} (PID: ${job.pid ?? "running"}): ${command}\nUse /jobs or /logs ${job.id} to view output.`,
                summary: `${job.id} (PID ${job.pid ?? "ok"})`,
                durationMs: Date.now() - startedAt,
              };
            }
            const shellBin = process.platform === "win32" ? winShellBin : "/bin/sh";
            const shellArgs =
              process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-c", command];
            const child = spawn(shellBin, shellArgs, {
              cwd: workdir,
              detached: true,
              stdio: "ignore",
            });
            child.unref();
            return {
              output: `Started background command (PID: ${child.pid ?? "detached"}): ${command}`,
              summary: `background PID ${child.pid ?? "ok"}`,
              durationMs: Date.now() - startedAt,
            };
          }

          const timeoutMs =
            typeof args.timeoutMs === "number" && args.timeoutMs > 0
              ? Math.min(args.timeoutMs, 300_000)
              : 60_000;

          const output = await new Promise<{ text: string; code: number }>((resPromise) => {
            const shellBin = process.platform === "win32" ? winShellBin : "/bin/sh";
            const shellArgs =
              process.platform === "win32"
                ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
                : ["-c", command];
            const child = spawn(shellBin, shellArgs, {
              cwd: workdir,
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
              env: {
                ...process.env,
                ...(opts.apiKey ? { AIVOKEY_API_KEY: opts.apiKey } : {}),
                ...(opts.baseUrl ? { AIVOKEY_BASE_URL: opts.baseUrl } : {}),
                GIT_TERMINAL_PROMPT: "0",
                GIT_EDITOR: "true",
                GIT_MERGE_AUTOEDIT: "no",
                GCM_INTERACTIVE: "never",
                NO_COLOR: "1",
                TERM: "dumb",
                CI: "true",
              },
            });
            let outBuf = "";
            let errBuf = "";
            let settled = false;

            const finish = (code: number, timedOut = false) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
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
                  (code === 0 ? "(no output)" : timedOut ? "Command timed out" : "Command failed"),
                code,
              });
            };

            child.stdout.on("data", (d: Buffer) => {
              if (outBuf.length < MAX_INLINE_OUTPUT_CHARS * 4) outBuf += d.toString("utf8");
            });
            child.stderr.on("data", (d: Buffer) => {
              if (errBuf.length < MAX_INLINE_OUTPUT_CHARS * 4) errBuf += d.toString("utf8");
            });

            const timer = setTimeout(() => {
              if (child.pid && process.platform === "win32") {
                try {
                  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                    stdio: "ignore",
                    windowsHide: true,
                  });
                } catch {
                  /* ignore */
                }
              } else {
                child.kill("SIGKILL");
              }
              finish(124, true);
            }, timeoutMs);

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
              `\n\n... [Output truncated (${formatted.length} chars total). Full output saved to ${spillFile}]`;
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
          return {
            output: `<skill name="${loaded.id}">\n# ${loaded.name}\n\n${loaded.body}\n</skill>`,
            summary: loaded.name,
          };
        }

        case "skill_create": {
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

  return { specs, execute, memory, skills, webSearchRouter };
}
