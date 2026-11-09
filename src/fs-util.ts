import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Creates a directory with owner-only permissions where the platform supports it.
 * Windows ignores POSIX mode bits and relies on ACL inheritance instead.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best-effort: existing directory may not be owned by this user */
    }
  }
}

/**
 * Writes a file by first writing a temporary sibling and renaming it into place.
 * This prevents a crash mid-write from leaving a truncated config/session/memory file.
 */
export function writeFileAtomic(
  path: string,
  data: string | Buffer,
  mode: number = 0o600,
): void {
  ensurePrivateDir(dirname(path));
  const tmpPath = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tmpPath, data, { encoding: "utf8", mode });
    if (process.platform !== "win32") {
      try {
        chmodSync(tmpPath, mode);
      } catch {
        /* best-effort */
      }
    }
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}
