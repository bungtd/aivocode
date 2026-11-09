import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createWorktree,
  findGitRoot,
  hasCommits,
  mergeWorktree,
  removeWorktree,
  withWorktree,
  worktreeChanges,
} from "../src/worktree.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function initRepo(): string {
  const parent = mkdtempSync(join(tmpdir(), "aivo-worktree-"));
  cleanups.push(() => rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const repo = join(parent, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Aivo Test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "README.md"), "# base\n", "utf8");
  writeFileSync(join(repo, "app.ts"), "export const version = 1;\n", "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

describe("Git worktree isolation", () => {
  it("detects git roots and commits", () => {
    const repo = initRepo();
    expect(findGitRoot(repo)).toBeTruthy();
    expect(hasCommits(repo)).toBe(true);

    const plain = mkdtempSync(join(tmpdir(), "aivo-not-git-"));
    cleanups.push(() => rmSync(plain, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    expect(findGitRoot(plain)).toBeNull();
    expect(createWorktree({ cwd: plain, label: "nope" })).toBeNull();
  }, 30_000);

  it("creates an isolated worktree whose edits do not touch the primary tree", () => {
    const repo = initRepo();
    const info = createWorktree({ cwd: repo, label: "agent-a" });
    expect(info).toBeTruthy();
    cleanups.push(() => removeWorktree(info!, true));

    expect(existsSync(info!.path)).toBe(true);
    expect(info!.branch.startsWith("aivo/agent-a")).toBe(true);
    expect(readFileSync(join(info!.path, "app.ts"), "utf8")).toContain("version = 1");

    writeFileSync(join(info!.path, "app.ts"), "export const version = 2;\n", "utf8");
    writeFileSync(join(info!.path, "new-file.ts"), "export const added = true;\n", "utf8");

    // Primary workspace is untouched until the merge.
    expect(readFileSync(join(repo, "app.ts"), "utf8")).toContain("version = 1");
    expect(existsSync(join(repo, "new-file.ts"))).toBe(false);

    const changes = worktreeChanges(info!);
    expect(changes).toContain("app.ts");
    expect(changes).toContain("new-file.ts");

    const merged = mergeWorktree(info!);
    expect(merged.conflicts).toEqual([]);
    expect(readFileSync(join(repo, "app.ts"), "utf8")).toContain("version = 2");
    expect(readFileSync(join(repo, "new-file.ts"), "utf8")).toContain("added = true");
  }, 30_000);

  it("supports two parallel worktrees editing the same file without losing either change", () => {
    const repo = initRepo();
    const a = createWorktree({ cwd: repo, label: "parallel-a" })!;
    const b = createWorktree({ cwd: repo, label: "parallel-b" })!;
    cleanups.push(() => removeWorktree(a, true));
    cleanups.push(() => removeWorktree(b, true));

    writeFileSync(join(a.path, "a-only.ts"), "export const fromA = 1;\n", "utf8");
    writeFileSync(join(b.path, "b-only.ts"), "export const fromB = 1;\n", "utf8");

    const mergedA = mergeWorktree(a);
    const mergedB = mergeWorktree(b);
    expect(mergedA.conflicts).toEqual([]);
    expect(mergedB.conflicts).toEqual([]);
    expect(existsSync(join(repo, "a-only.ts"))).toBe(true);
    expect(existsSync(join(repo, "b-only.ts"))).toBe(true);
  }, 30_000);

  it("falls back to the shared workspace when git isolation is unavailable", () => {
    const plain = mkdtempSync(join(tmpdir(), "aivo-worktree-fallback-"));
    cleanups.push(() => rmSync(plain, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const context = withWorktree({ cwd: plain, label: "fallback" });
    expect(context.info).toBeNull();
    expect(context.cwd).toBe(plain);
    const result = context.finish();
    expect(result.summary).toContain("shared workspace");
  });

  it("finishes idempotently and removes the worktree", () => {
    const repo = initRepo();
    const context = withWorktree({ cwd: repo, label: "idempotent" });
    expect(context.info).toBeTruthy();
    const worktreePath = context.cwd;
    writeFileSync(join(worktreePath, "done.ts"), "export const done = true;\n", "utf8");

    const first = context.finish();
    expect(first.added).toContain("done.ts");
    expect(existsSync(worktreePath)).toBe(false);

    const second = context.finish();
    expect(second.summary).toContain("already finished");
    expect(existsSync(join(repo, "done.ts"))).toBe(true);

    const worktrees = git(repo, ["worktree", "list"]);
    expect(worktrees.split("\n").filter(Boolean)).toHaveLength(1);
  }, 30_000);
});
