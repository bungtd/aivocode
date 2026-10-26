import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { TodoItem } from "./tools/index.js";
import { detectRecommendedTeam, getAgentTeam, type TeamId } from "./teams.js";
import { auditCodeForSlop } from "./anti-slop.js";

export type ExecutionStrategyMode = "subagent-driven" | "native" | "ask";

export interface TaskStrategyDecision {
  isSubstantialBuild: boolean;
  recommendedMode: "subagent-driven" | "native";
  teamId: TeamId;
  teamName: string;
  autoTodos: TodoItem[];
}

/**
 * Classifies a user prompt into an execution strategy (`subagent-driven` vs `native`),
 * selects the appropriate Specialist Team, and pre-populates live tasks.
 */
export function classifyTaskStrategy(prompt: string, cwd?: string): TaskStrategyDecision {
  const p = prompt.trim();
  const teamId = detectRecommendedTeam(p, cwd);
  const team = getAgentTeam(teamId) ?? getAgentTeam("fullstack")!;

  const isSubstantialBuild =
    p.length > 28 &&
    /\b(buat|buatkan|buatlah|bangun|bikin|develop|build|create|implement|scaffold|refactor|landing\s+page|aplikasi|website|sistem|fitur|game|script|api|full\s*stack)\b/i.test(
      p,
    );

  if (!isSubstantialBuild) {
    return {
      isSubstantialBuild: false,
      recommendedMode: "native",
      teamId,
      teamName: team.name,
      autoTodos: [],
    };
  }

  const autoTodos: TodoItem[] = team.workflowStages.map((stage, idx) => ({
    id: String(idx + 1),
    content: stage.title.replace(/^\d+\.\s*/, ""),
    status: idx === 0 ? "in_progress" : "pending",
  }));

  if (autoTodos.length < 4) {
    autoTodos.push({
      id: String(autoTodos.length + 1),
      content: "Automated Review, Fix & Final Verification",
      status: "pending",
    });
  }

  return {
    isSubstantialBuild: true,
    recommendedMode: "subagent-driven",
    teamId,
    teamName: team.name,
    autoTodos,
  };
}

/**
 * Automatically progresses `todos` in real time as tools execute so the Live Task Board
 * always reflects actual progress even when the LLM forgets to call `todo_write` after every file.
 */
export function autoAdvanceTodos(
  todos: TodoItem[],
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  if (todos.length === 0) return false;
  let changed = false;
  const pathArg = typeof args.path === "string" ? args.path.toLowerCase() : "";

  const markMatchingDone = (pattern: RegExp) => {
    for (const t of todos) {
      if (t.status !== "completed" && pattern.test(t.content.toLowerCase())) {
        t.status = "completed";
        changed = true;
      }
    }
  };

  if (toolName === "write_file" || toolName === "edit_file" || toolName === "apply_patch") {
    if (pathArg.endsWith(".html") || pathArg.endsWith(".htm")) {
      markMatchingDone(/\b(scaffold|structure|html|markup|ux|spec|blueprint|architecture)\b/i);
    } else if (pathArg.endsWith(".css") || pathArg.endsWith(".scss")) {
      markMatchingDone(/\b(scaffold|html|css|style|design|token|layout|ui)\b/i);
    } else if (/\.(js|mjs|ts|tsx|jsx|kt|py|gd|cs)$/.test(pathArg)) {
      markMatchingDone(/\b(scaffold|javascript|js|interaction|component|implement|kotlin|bpy|gameplay|code|build)\b/i);
    }
  } else if (
    toolName === "anti_slop_audit" ||
    toolName === "computer_use" ||
    (toolName === "run_shell" &&
      /\b(test|vitest|jest|tsc|check|lint|gradle)\b/i.test(String(args.command ?? "")))
  ) {
    markMatchingDone(/\b(audit|verify|verification|qa|review|test|polish|launch)\b/i);
  }

  // Ensure that if no item is currently `in_progress`, the first `pending` item becomes `in_progress`
  const hasInProgress = todos.some((t) => t.status === "in_progress");
  if (!hasInProgress) {
    const nextPending = todos.find((t) => t.status === "pending");
    if (nextPending) {
      nextPending.status = "in_progress";
      changed = true;
    }
  }

  return changed;
}

export interface WorkspaceVerificationResult {
  clean: boolean;
  findings: string[];
}

/**
 * Automated Review & Verification Gate:
 * - Audits modified files for AI slop (`// TODO`, truncated placeholders, blind `any`)
 * - Verifies `.json` syntax
 * - Cross-checks `.html` files for missing local `<link href="...">` stylesheets and `<script src="...">` scripts
 */
export function verifyWorkspaceArtifacts(
  cwd: string,
  modifiedFiles: string[],
): WorkspaceVerificationResult {
  const findings: string[] = [];

  for (const absPath of modifiedFiles) {
    if (!existsSync(absPath)) continue;
    let st;
    try {
      st = statSync(absPath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;

    const rel = relative(cwd, absPath).replace(/\\/g, "/");
    let content: string;
    try {
      content = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }

    // 1. Anti-AI-Slop check
    const slop = auditCodeForSlop(rel, content);
    for (const iss of slop.issues) {
      if (iss.severity === "error") {
        findings.push(`${rel}:${iss.line} — ${iss.message} (${iss.excerpt})`);
      }
    }

    // 2. JSON validity check
    if (rel.endsWith(".json")) {
      try {
        JSON.parse(content);
      } catch (err) {
        findings.push(
          `${rel} — Invalid JSON syntax: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 3. HTML local asset reference check (<link href="..."> and <script src="...">)
    if (rel.endsWith(".html") || rel.endsWith(".htm")) {
      const htmlDir = dirname(absPath);
      const assetRx = /<(?:link[^>]+href|script[^>]+src)=["']([^"']+)["']/gi;
      let match: RegExpExecArray | null;
      while ((match = assetRx.exec(content)) !== null) {
        const ref = (match[1] ?? "").trim();
        if (
          !ref ||
          ref.startsWith("http://") ||
          ref.startsWith("https://") ||
          ref.startsWith("//") ||
          ref.startsWith("data:") ||
          ref.startsWith("#")
        ) {
          continue;
        }
        const cleanRef = ref.split("?")[0]!.split("#")[0]!;
        if (!/\.(css|js|mjs|svg|png|jpe?g|webp|ico)$/i.test(cleanRef)) continue;
        const targetPath = resolve(htmlDir, cleanRef);
        if (!existsSync(targetPath)) {
          findings.push(
            `${rel} — Referenced local asset '${cleanRef}' does not exist at ${relative(cwd, targetPath).replace(/\\/g, "/")}`,
          );
        }
      }
    }
  }

  return {
    clean: findings.length === 0,
    findings,
  };
}
