/**
 * Git worktree isolation for parallel subagents.
 *
 * Parallel subagents that all edit the same working tree race each other: one
 * agent's `git checkout` or branch switch silently discards another's work. This
 * module gives each subagent its own `git worktree` checkout, then merges its
 * changes back (or reports conflicts) when the subagent finishes.
 *
 * Everything is best-effort: the primary workspace must be a git repository with
 * at least one commit. When those preconditions fail, callers fall back to the
 * shared workspace instead of breaking the turn.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

export interface WorktreeInfo {
  /** Absolute path of the isolated checkout. */
  path: string;
  /** Branch created for the subagent. */
  branch: string;
  /** Commit the worktree was created from. */
  baseCommit: string;
  /** Repository root. */
  repoRoot: string;
}

export interface WorktreeMergeResult {
  /** Files whose changes were applied cleanly. */
  merged: string[];
  /** Files that conflicted and were left in the primary workspace. */
  conflicts: string[];
  /** Paths that existed only in the worktree and were copied over. */
  added: string[];
  /** Human-readable summary for the agent/subagent log. */
  summary: string;
}

export interface WorktreeOptions {
  /** Directory that contains the git repository. */
  cwd: string;
  /** Label used in branch/worktree names. */
  label: string;
  /** Directory to place worktrees in. Defaults to a temp directory. */
  root?: string;
  /** Optional commit/branch to start from. */
  startPoint?: string;
}

function runGit(
  args: string[],
  cwd: string,
  options: { input?: string; trim?: boolean } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
  const trim = options.trim ?? true;
  const stdout = trim ? (result.stdout ?? "").trim() : (result.stdout ?? "");
  return {
    ok: result.status === 0,
    stdout,
    stderr: (result.stderr ?? "").trim(),
  };
}

/** Resolves the repository root, or null when `cwd` is not inside a git repo. */
export function findGitRoot(cwd: string): string | null {
  const result = runGit(["rev-parse", "--show-toplevel"], cwd);
  return result.ok && result.stdout ? result.stdout.split(/\r?\n/)[0]!.trim() : null;
}

/** True when the repository has at least one commit (worktrees need a HEAD). */
export function hasCommits(repoRoot: string): boolean {
  return runGit(["rev-parse", "--verify", "HEAD"], repoRoot).ok;
}

function sanitizeLabel(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "subagent"
  );
}

export function createWorktree(options: WorktreeOptions): WorktreeInfo | null {
  const repoRoot = findGitRoot(options.cwd);
  if (!repoRoot || !hasCommits(repoRoot)) return null;

  const head = runGit(["rev-parse", "HEAD"], repoRoot);
  if (!head.ok) return null;

  const root = options.root ?? join(tmpdir(), "aivokey-worktrees", sanitizeLabel(basename(repoRoot)));
  const label = sanitizeLabel(options.label);
  const suffix = Math.random().toString(36).slice(2, 8);
  const branch = `aivo/${label}-${suffix}`;
  const worktreePath = join(root, `${label}-${suffix}`);
  const startPoint = options.startPoint ?? "HEAD";

  const created = runGit(
    ["worktree", "add", "-b", branch, worktreePath, startPoint],
    repoRoot,
  );
  if (!created.ok) return null;

  return { path: worktreePath, branch, baseCommit: head.stdout, repoRoot };
}

export interface WorktreeChange {
  path: string;
  /** Two-letter porcelain status, e.g. " M", "??", "A ", "D ". */
  status: string;
}

/** Lists changed files with their porcelain status codes. */
export function worktreeChangeDetails(info: WorktreeInfo): WorktreeChange[] {
  const result = runGit(["status", "--porcelain", "-z"], info.path, { trim: false });
  if (!result.ok) return [];
  const entries = result.stdout.split("\0");
  const changes: WorktreeChange[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3).trim();
    if (path) changes.push({ path, status });
    if (status[0] === "R" || status[0] === "C") {
      const destination = entries[++index]?.trim();
      if (destination) changes.push({ path: destination, status: "A " });
    }
  }
  return changes;
}

/** Lists files changed in the worktree relative to its base commit. */
export function worktreeChanges(info: WorktreeInfo): string[] {
  return [...new Set(worktreeChangeDetails(info).map((change) => change.path))];
}

/** Unified diff of everything the subagent changed. */
export function worktreeDiff(info: WorktreeInfo): string {
  runGit(["add", "-A"], info.path);
  // Patches are whitespace-significant; trailing newlines must be preserved.
  const staged = runGit(["diff", "--cached", "--binary"], info.path, { trim: false });
  return staged.stdout;
}

/**
 * Copies changed/added files from the worktree into the primary workspace.
 *
 * Uses `git diff --binary` + `git apply --3way` so partial changes merge when
 * possible. Conflicts leave the primary workspace untouched for that file and
 * are reported back to the caller.
 */
export function mergeWorktree(info: WorktreeInfo): WorktreeMergeResult {
  const details = worktreeChangeDetails(info);
  if (details.length === 0) {
    return { merged: [], conflicts: [], added: [], summary: "No changes to merge." };
  }
  const changes = [...new Set(details.map((change) => change.path))];

  const diff = worktreeDiff(info);
  if (!diff) {
    return { merged: [], conflicts: [], added: [], summary: "No textual changes to merge." };
  }

  const apply = runGit(["apply", "--3way", "--whitespace=nowarn"], info.repoRoot, {
    input: diff,
  });
  if (!apply.ok) {
    return {
      merged: [],
      conflicts: changes,
      added: [],
      summary: `Could not merge ${changes.length} file(s) automatically: ${apply.stderr || "patch rejected"}`,
    };
  }

  const added = details
    .filter((change) => change.status === "??" || change.status.startsWith("A"))
    .map((change) => change.path);
  const merged = changes.filter((path) => !added.includes(path));
  return {
    merged,
    conflicts: [],
    added,
    summary: `Merged ${merged.length} changed and ${added.length} new file(s) from ${info.branch}.`,
  };
}

/** Removes a worktree and its branch. Safe to call multiple times. */
export function removeWorktree(info: WorktreeInfo, force = false): void {
  runGit(["worktree", "remove", ...(force ? ["--force"] : []), info.path], info.repoRoot);
  if (existsSync(info.path)) {
    try {
      rmSync(info.path, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; `git worktree prune` handles the metadata later.
    }
  }
  runGit(["branch", "-D", info.branch], info.repoRoot);
  runGit(["worktree", "prune"], info.repoRoot);
}

export interface WorktreeRunContext {
  /** Path the subagent should use as its workspace. */
  cwd: string;
  info: WorktreeInfo | null;
  /** Merges changes back and cleans up the worktree. */
  finish: () => WorktreeMergeResult;
}

/**
 * Creates an isolated worktree for one subagent run, or returns the shared
 * workspace when git isolation is unavailable.
 */
export function withWorktree(options: WorktreeOptions): WorktreeRunContext {
  const info = createWorktree(options);
  if (!info) {
    return {
      cwd: options.cwd,
      info: null,
      finish: () => ({
        merged: [],
        conflicts: [],
        added: [],
        summary: "Worktree isolation unavailable (not a git repo or no commits); used the shared workspace.",
      }),
    };
  }
  let finished = false;
  return {
    cwd: info.path,
    info,
    finish: () => {
      if (finished) {
        return { merged: [], conflicts: [], added: [], summary: "Worktree already finished." };
      }
      finished = true;
      const result = mergeWorktree(info);
      removeWorktree(info, true);
      return result;
    },
  };
}
