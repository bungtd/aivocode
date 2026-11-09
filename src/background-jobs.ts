import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeFileAtomic } from "./fs-util.js";
import { buildChildEnv } from "./env-utils.js";

export interface BackgroundJob {
  id: string;
  pid: number | null;
  command: string;
  cwd: string;
  status: "running" | "exited" | "killed" | "error" | "lost";
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  detectedUrl: string | null;
  logs: string[];
  /** Shell/args used to start the job, so it can be restarted after a crash. */
  shellBin?: string;
  shellArgs?: string[];
}

export interface BackgroundJobManagerOptions {
  /** Directory for persisted job metadata. Omit to keep jobs in memory only. */
  dir?: string;
  /** Maximum persisted jobs retained on disk. Default 50. */
  maxJobs?: number;
}

const MAX_JOB_LOG_LINES = 500;
const URL_REGEX = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+(?:\/[^\s"']*)?/i;

/** Default per-session background-job directory. */
export function defaultBackgroundJobsDir(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  return join(homedir(), ".aivokey", "jobs", safe);
}

export class BackgroundJobManager {
  private static activeManagers = new Set<BackgroundJobManager>();

  private jobs = new Map<string, BackgroundJob>();
  private procs = new Map<string, ChildProcess>();
  private counter = 0;
  private onUpdate?: () => void;
  private disposed = false;
  private readonly dir: string | undefined;
  private readonly maxJobs: number;

  constructor(onUpdate?: () => void, options: BackgroundJobManagerOptions = {}) {
    this.onUpdate = onUpdate;
    this.dir = options.dir;
    this.maxJobs = Math.max(1, options.maxJobs ?? 50);
    if (this.dir) {
      try {
        mkdirSync(this.dir, { recursive: true });
        this.restoreFromDisk();
      } catch {
        // Corrupt job directory must never block a session.
      }
    }
    BackgroundJobManager.activeManagers.add(this);
  }

  private jobPath(id: string): string {
    return join(this.dir!, `${id.replace(/[^a-zA-Z0-9_-]/g, "")}.json`);
  }

  private persist(job: BackgroundJob): void {
    if (!this.dir) return;
    try {
      writeFileAtomic(this.jobPath(job.id), JSON.stringify(job), 0o600);
    } catch {
      // Best-effort persistence.
    }
  }

  private restoreFromDisk(): void {
    if (!this.dir) return;
    let entries: string[];
    try {
      entries = readdirSync(this.dir).filter((name) => name.endsWith(".json"));
    } catch {
      return;
    }
    const restored: BackgroundJob[] = [];
    for (const name of entries) {
      try {
        const raw = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as BackgroundJob;
        if (!raw?.id || typeof raw.command !== "string") continue;
        // A job marked "running" cannot survive the process that hosted it.
        if (raw.status === "running") {
          raw.status = "lost";
          raw.endedAt = raw.endedAt ?? new Date().toISOString();
          raw.logs = [
            ...(raw.logs ?? []),
            "[lost] Process ended with the previous AivoCode session; use /jobs restart <id> to relaunch.",
          ];
        }
        restored.push({ ...raw, logs: raw.logs ?? [] });
      } catch {
        // Skip corrupt job files.
      }
    }
    restored.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const kept = restored.slice(-this.maxJobs);
    for (const job of kept) {
      this.jobs.set(job.id, job);
      const numeric = Number(job.id.replace(/[^0-9]/g, ""));
      if (Number.isFinite(numeric)) this.counter = Math.max(this.counter, numeric);
    }
    this.pruneDisk(kept);
  }

  private pruneDisk(kept: BackgroundJob[]): void {
    if (!this.dir) return;
    const keep = new Set(
      kept.map((job) => `${job.id.replace(/[^a-zA-Z0-9_-]/g, "")}.json`),
    );
    try {
      for (const name of readdirSync(this.dir)) {
        if (!keep.has(name)) {
          try {
            rmSync(join(this.dir, name), { force: true });
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  /** Relaunches a job that was lost when the previous process exited. */
  restartJob(id: string): BackgroundJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === "running") return job;
    const restarted = this.startJob({
      command: job.command,
      cwd: job.cwd,
      shellBin: job.shellBin,
      shellArgs: job.shellArgs,
    });
    // Keep the old log for context, then point the record at the new process.
    restarted.logs.unshift(`[restart] ${new Date().toISOString()} relaunched ${job.id} (was ${job.status})`);
    this.persist(restarted);
    return restarted;
  }

  /** Stops every job from every manager that is still alive (used by process shutdown hooks). */
  static stopAllActive(): void {
    for (const manager of [...BackgroundJobManager.activeManagers]) {
      manager.stopAll();
      manager.dispose();
    }
  }

  setOnUpdate(fn: () => void): void {
    this.onUpdate = fn;
  }

  startJob(input: {
    command: string;
    cwd: string;
    shellBin?: string;
    shellArgs?: string[];
    env?: NodeJS.ProcessEnv;
  }): BackgroundJob {
    this.counter++;
    const id = `job_${this.counter}`;
    const shellBin =
      input.shellBin ?? (process.platform === "win32" ? "powershell.exe" : "/bin/sh");
    const shellArgs =
      input.shellArgs ??
      (process.platform === "win32"
        ? ["-NoProfile", "-Command", input.command]
        : ["-c", input.command]);

    const child = spawn(shellBin, shellArgs, {
      cwd: input.cwd,
      env: input.env ?? buildChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      // POSIX: new process group so `killJob` can terminate grandchildren (npm/node/dev servers).
      // `unref` + unreferenced stdio keep the CLI process itself from hanging after it exits.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    child.unref();
    for (const stream of [child.stdout, child.stderr]) {
      (stream as unknown as { unref?: () => void } | null)?.unref?.();
    }

    const job: BackgroundJob = {
      id,
      pid: child.pid ?? null,
      command: input.command,
      cwd: input.cwd,
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      detectedUrl: null,
      logs: [],
      shellBin,
      shellArgs,
    };

    this.jobs.set(id, job);
    this.procs.set(id, child);
    this.persist(job);
    let lastPersistAt = Date.now();

    const appendLines = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
      for (const l of lines) {
        job.logs.push(l);
        if (!job.detectedUrl) {
          const m = l.match(URL_REGEX);
          if (m?.[0]) {
            job.detectedUrl = m[0].replace("0.0.0.0", "127.0.0.1");
          }
        }
      }
      if (job.logs.length > MAX_JOB_LOG_LINES) {
        job.logs.splice(0, job.logs.length - MAX_JOB_LOG_LINES);
      }
      // Coalesce log persistence so dev servers do not rewrite the file per line.
      if (Date.now() - lastPersistAt > 1_000) {
        lastPersistAt = Date.now();
        this.persist(job);
      }
      this.onUpdate?.();
    };

    child.stdout?.on("data", appendLines);
    child.stderr?.on("data", appendLines);

    child.on("error", (err) => {
      job.status = "error";
      job.endedAt = new Date().toISOString();
      job.logs.push(`[error] ${err.message}`);
      this.procs.delete(id);
      this.persist(job);
      this.onUpdate?.();
    });

    child.on("close", (code) => {
      if (job.status === "running") {
        job.status = "exited";
      }
      job.exitCode = code;
      job.endedAt = new Date().toISOString();
      this.procs.delete(id);
      this.persist(job);
      this.onUpdate?.();
    });

    this.onUpdate?.();
    return job;
  }

  getJob(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  /** Forces an immediate write of the job record (used by tests and shutdown). */
  persistNow(job: BackgroundJob): void {
    this.persist(job);
  }

  listJobs(): BackgroundJob[] {
    return [...this.jobs.values()];
  }

  killJob(id: string): boolean {
    const job = this.jobs.get(id);
    const proc = this.procs.get(id);
    if (!job) return false;
    job.status = "killed";
    job.endedAt = new Date().toISOString();
    if (proc) {
      if (process.platform === "win32" && typeof job.pid === "number") {
        try {
          spawnSync("taskkill", ["/PID", String(job.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          /* ignore */
        }
      } else if (typeof job.pid === "number") {
        try {
          // Negative PID targets the detached process group on POSIX.
          process.kill(-job.pid, "SIGKILL");
        } catch {
          /* fall back to the direct child below */
        }
      }
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      this.procs.delete(id);
    }
    this.persist(job);
    this.onUpdate?.();
    return true;
  }

  stopAll(): void {
    for (const id of [...this.procs.keys()]) {
      this.killJob(id);
    }
  }

  /** Removes this manager from the process-wide registry. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAll();
    BackgroundJobManager.activeManagers.delete(this);
  }
}
