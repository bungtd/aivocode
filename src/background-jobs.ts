import { exec, spawn, type ChildProcess } from "node:child_process";

export interface BackgroundJob {
  id: string;
  pid: number | null;
  command: string;
  cwd: string;
  status: "running" | "exited" | "killed" | "error";
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  detectedUrl: string | null;
  logs: string[];
}

const MAX_JOB_LOG_LINES = 500;
const URL_REGEX = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+(?:\/[^\s"']*)?/i;

export class BackgroundJobManager {
  private jobs = new Map<string, BackgroundJob>();
  private procs = new Map<string, ChildProcess>();
  private counter = 0;
  private onUpdate?: () => void;

  constructor(onUpdate?: () => void) {
    this.onUpdate = onUpdate;
  }

  setOnUpdate(fn: () => void): void {
    this.onUpdate = fn;
  }

  startJob(input: { command: string; cwd: string }): BackgroundJob {
    this.counter++;
    const id = `job_${this.counter}`;
    const shellBin = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    const shellArgs =
      process.platform === "win32"
        ? ["-NoProfile", "-Command", input.command]
        : ["-c", input.command];

    const child = spawn(shellBin, shellArgs, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

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
    };

    this.jobs.set(id, job);
    this.procs.set(id, child);

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
      this.onUpdate?.();
    };

    child.stdout?.on("data", appendLines);
    child.stderr?.on("data", appendLines);

    child.on("error", (err) => {
      job.status = "error";
      job.endedAt = new Date().toISOString();
      job.logs.push(`[error] ${err.message}`);
      this.procs.delete(id);
      this.onUpdate?.();
    });

    child.on("close", (code) => {
      if (job.status === "running") {
        job.status = "exited";
      }
      job.exitCode = code;
      job.endedAt = new Date().toISOString();
      this.procs.delete(id);
      this.onUpdate?.();
    });

    this.onUpdate?.();
    return job;
  }

  getJob(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
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
        exec(`taskkill /PID ${job.pid} /T /F`, () => {});
      }
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      this.procs.delete(id);
    }
    this.onUpdate?.();
    return true;
  }

  stopAll(): void {
    for (const id of this.procs.keys()) {
      this.killJob(id);
    }
  }
}
