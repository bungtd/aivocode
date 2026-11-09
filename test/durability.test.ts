import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckpointManager, defaultCheckpointDir } from "../src/checkpoint.js";
import { BackgroundJobManager, defaultBackgroundJobsDir } from "../src/background-jobs.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

describe("Persistent checkpoints (/undo after restart)", () => {
  it("restores undo history from disk in a fresh manager", () => {
    const dir = tempDir("aivo-ckpt-restore-");
    const store = join(dir, "checkpoints");
    const file = join(dir, "file.txt");
    writeFileSync(file, "original\n", "utf8");

    const first = new CheckpointManager({ dir: store });
    first.beginTurn("turn_a");
    first.snapshotBeforeWrite(file);
    writeFileSync(file, "changed\n", "utf8");

    expect(first.undoCount()).toBe(1);

    // Simulate a process restart: new manager reads the same directory.
    const second = new CheckpointManager({ dir: store });
    expect(second.undoCount()).toBe(1);
    const result = second.undoLastTurn();
    expect(result.turnId).toBe("turn_a");
    expect(readFileSync(file, "utf8")).toBe("original\n");
    // Undo moved the turn to redo, and persisted that state.
    expect(second.redoCount()).toBe(1);

    const third = new CheckpointManager({ dir: store });
    expect(third.undoCount()).toBe(0);
    expect(third.redoCount()).toBe(1);
    const redo = third.redoLastUndo();
    expect(redo.turnId).toBe("turn_a");
    expect(readFileSync(file, "utf8")).toBe("changed\n");
  });

  it("records file creation so undo removes the new file after a restart", () => {
    const dir = tempDir("aivo-ckpt-create-");
    const store = join(dir, "checkpoints");
    const file = join(dir, "new.txt");

    const first = new CheckpointManager({ dir: store });
    first.beginTurn("turn_new");
    first.snapshotBeforeWrite(file);
    writeFileSync(file, "brand new\n", "utf8");

    const second = new CheckpointManager({ dir: store });
    second.undoLastTurn();
    expect(existsSync(file)).toBe(false);
  });

  it("prunes old turns beyond maxTurns and survives corrupt files", () => {
    const dir = tempDir("aivo-ckpt-prune-");
    const store = join(dir, "checkpoints");
    const manager = new CheckpointManager({ dir: store, maxTurns: 2 });
    const files: string[] = [];
    for (let i = 0; i < 5; i++) {
      const file = join(dir, `f${i}.txt`);
      writeFileSync(file, `v${i}\n`, "utf8");
      manager.beginTurn(`turn_${i}`);
      manager.snapshotBeforeWrite(file);
      writeFileSync(file, `changed${i}\n`, "utf8");
      files.push(file);
    }
    expect(manager.undoCount()).toBe(2);

    writeFileSync(join(store, "turn-corrupt.json"), "{not json", "utf8");
    const reloaded = new CheckpointManager({ dir: store, maxTurns: 2 });
    expect(reloaded.undoCount()).toBe(2);
  });

  it("clears persisted history on reset", () => {
    const dir = tempDir("aivo-ckpt-reset-");
    const store = join(dir, "checkpoints");
    const file = join(dir, "f.txt");
    writeFileSync(file, "a\n", "utf8");
    const manager = new CheckpointManager({ dir: store });
    manager.beginTurn("turn_reset");
    manager.snapshotBeforeWrite(file);
    writeFileSync(file, "b\n", "utf8");
    expect(manager.undoCount()).toBe(1);

    manager.reset();
    expect(manager.undoCount()).toBe(0);
    const reloaded = new CheckpointManager({ dir: store });
    expect(reloaded.undoCount()).toBe(0);
  });

  it("keeps in-memory behaviour when no directory is configured", () => {
    const dir = tempDir("aivo-ckpt-memory-");
    const file = join(dir, "mem.txt");
    writeFileSync(file, "before\n", "utf8");
    const manager = new CheckpointManager();
    manager.beginTurn("turn_mem");
    manager.snapshotBeforeWrite(file);
    writeFileSync(file, "after\n", "utf8");
    expect(manager.undoLastTurn().turnId).toBe("turn_mem");
    expect(readFileSync(file, "utf8")).toBe("before\n");
  });

  it("uses a per-session default directory", () => {
    expect(defaultCheckpointDir("ses_abc/../evil")).toContain("ses_abcevil");
    expect(defaultCheckpointDir("ses_abc")).not.toBe(defaultCheckpointDir("ses_def"));
  });
});

const isWindows = process.platform === "win32";
const sleepCommand = isWindows
  ? "Start-Sleep -Milliseconds 500; Write-Output JOB_DONE"
  : "sleep 0.5; echo JOB_DONE";

describe("Persistent background jobs", () => {
  it("marks jobs from a previous process as lost and can relaunch them", async () => {
    const dir = tempDir("aivo-jobs-restore-");
    const store = join(dir, "jobs");

    const first = new BackgroundJobManager(undefined, { dir: store });
    const job = first.startJob({ command: sleepCommand, cwd: dir });
    first.persistNow?.(job);
    await new Promise((resolve) => setTimeout(resolve, 50));
    first.stopAll();
    first.dispose();

    // Simulate a crash: the on-disk record still says "running".
    writeFileSync(
      join(store, `${job.id}.json`),
      JSON.stringify({ ...job, status: "running", endedAt: null }),
      "utf8",
    );

    const second = new BackgroundJobManager(undefined, { dir: store });
    const restored = second.getJob(job.id);
    expect(restored?.status).toBe("lost");
    expect(restored?.logs.join(" ")).toContain("lost");

    const relaunched = second.restartJob(job.id);
    expect(relaunched).toBeTruthy();
    expect(relaunched!.status).toBe("running");
    expect(relaunched!.logs[0]).toContain("[restart]");
    second.stopAll();
    second.dispose();
  }, 30_000);

  it("persists status transitions and log lines for non-running jobs", async () => {
    const dir = tempDir("aivo-jobs-persist-");
    const store = join(dir, "jobs");
    const manager = new BackgroundJobManager(undefined, { dir: store });
    try {
      const job = manager.startJob({ command: sleepCommand, cwd: dir });
      // Poll instead of assuming a fixed sleep duration; Windows process
      // startup can exceed the nominal command runtime.
      const deadline = Date.now() + 20_000;
      while (job.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(job.status).toBe("exited");
      const saved = JSON.parse(readFileSync(join(store, `${job.id}.json`), "utf8")) as {
        status: string;
        exitCode: number | null;
        logs: string[];
      };
      expect(saved.status).toBe("exited");
      expect(saved.exitCode).toBe(0);
    } finally {
      manager.stopAll();
      manager.dispose();
    }
  }, 30_000);

  it("uses a per-session default directory and prunes old job files", () => {
    expect(defaultBackgroundJobsDir("ses_abc")).toContain(join("jobs", "ses_abc"));
    const dir = tempDir("aivo-jobs-prune-");
    const store = join(dir, "jobs");
    const manager = new BackgroundJobManager(undefined, { dir: store, maxJobs: 2 });
    try {
      for (let i = 0; i < 4; i++) {
        const job = manager.startJob({ command: "echo hi", cwd: dir });
        manager.persistNow?.(job);
      }
    } finally {
      manager.stopAll();
      manager.dispose();
    }
    const reloaded = new BackgroundJobManager(undefined, { dir: store, maxJobs: 2 });
    try {
      expect(reloaded.listJobs().length).toBeLessThanOrEqual(2);
    } finally {
      reloaded.stopAll();
      reloaded.dispose();
    }
  }, 30_000);
});
