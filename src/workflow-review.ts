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

export interface ParsedReviewerVerdict {
  passed: boolean;
  issues: string[];
  rawText: string;
}

/**
 * Parses the structured output of a dedicated Read-Only Reviewer pass:
 * - `VERDICT: PASS` -> `{ passed: true, issues: [] }`
 * - `VERDICT: NEEDS_FIX` followed by numbered/bulleted findings -> `{ passed: false, issues: [...] }`
 */
export function parseReviewerVerdict(rawText: string): ParsedReviewerVerdict {
  const text = rawText.trim();
  const hasNeedsFix = /VERDICT:\s*NEEDS_FIX/i.test(text);
  const hasPass = /VERDICT:\s*PASS/i.test(text) && !hasNeedsFix;

  if (hasPass) {
    return { passed: true, issues: [], rawText: text };
  }

  const lines = text.split(/\r?\n/);
  const issues: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(?:\d+\.|[-*•])\s+(.+)$/.test(trimmed)) {
      issues.push(trimmed.replace(/^(?:\d+\.|[-*•])\s+/, ""));
    }
  }

  if (!hasNeedsFix && issues.length === 0) {
    return { passed: true, issues: [], rawText: text };
  }

  if (hasNeedsFix && issues.length === 0) {
    issues.push(text.replace(/VERDICT:\s*NEEDS_FIX/i, "").trim() || "Reviewer requested fixes");
  }

  return {
    passed: false,
    issues,
    rawText: text,
  };
}

export interface IterativeReviewFixOptions {
  cwd: string;
  modifiedFiles: string[];
  maxRounds?: number;
  onEvent?: (message: string) => void;
  runReviewerAgent: (round: number, staticFindings: string[]) => Promise<string>;
  runFixerAgent: (round: number, issuesToFix: string[]) => Promise<string>;
}

export interface IterativeReviewFixResult {
  passed: boolean;
  roundsRun: number;
  remainingIssues: string[];
}

/**
 * Separated Iterative Review -> Fix -> Re-Review -> Re-Fix Loop:
 * 1. Runs a dedicated Read-Only Review pass (static artifact audit + Reviewer agent).
 * 2. If issues are found, runs a separate Read-Write Fixer pass.
 * 3. Re-runs the Read-Only Review pass from scratch to verify the fixes and check for regressions.
 * 4. Repeats until VERDICT: PASS (0 issues) or maxRounds is reached.
 */
export async function runIterativeReviewFixLoop(
  opts: IterativeReviewFixOptions,
): Promise<IterativeReviewFixResult> {
  const maxRounds = Math.max(1, opts.maxRounds ?? 3);
  let remainingIssues: string[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    opts.onEvent?.(`Review Round ${round}/${maxRounds}: Auditing modified files (read-only)...`);
    const staticCheck = verifyWorkspaceArtifacts(opts.cwd, opts.modifiedFiles);
    const reviewerOutput = await opts.runReviewerAgent(round, staticCheck.findings);
    const verdict = parseReviewerVerdict(reviewerOutput);

    const combinedIssues = [
      ...staticCheck.findings,
      ...verdict.issues.filter((i) => !staticCheck.findings.includes(i)),
    ];

    if (staticCheck.clean && verdict.passed && combinedIssues.length === 0) {
      opts.onEvent?.(`Review Round ${round} PASSED (0 issues found).`);
      return {
        passed: true,
        roundsRun: round,
        remainingIssues: [],
      };
    }

    remainingIssues = combinedIssues;
    opts.onEvent?.(
      `Review Round ${round} found ${remainingIssues.length} issue(s) — starting Fix Round ${round}...`,
    );

    await opts.runFixerAgent(round, remainingIssues);
  }

  // Final verification check after last fix round
  const finalStatic = verifyWorkspaceArtifacts(opts.cwd, opts.modifiedFiles);
  if (finalStatic.clean) {
    const finalReview = await opts.runReviewerAgent(maxRounds + 1, []);
    const finalVerdict = parseReviewerVerdict(finalReview);
    if (finalVerdict.passed) {
      opts.onEvent?.(`Final Re-Review PASSED (0 issues remaining).`);
      return {
        passed: true,
        roundsRun: maxRounds,
        remainingIssues: [],
      };
    }
    remainingIssues = finalVerdict.issues;
  } else {
    remainingIssues = finalStatic.findings;
  }

  return {
    passed: remainingIssues.length === 0,
    roundsRun: maxRounds,
    remainingIssues,
  };
}
