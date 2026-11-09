import { exec } from "node:child_process";

export interface ShellCaptureOptions {
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
}

/**
 * Promise-based captured shell execution used by the TUI / mini REPL `!cmd` and `/diff`.
 * Unlike execSync it does not block the event loop, so the terminal stays responsive.
 */
export function execShellCapture(
  command: string,
  opts: ShellCaptureOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd: opts.cwd,
        encoding: "utf8",
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
        signal: opts.signal,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr ?? "").trim() || err.message;
          reject(new Error(detail));
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}
