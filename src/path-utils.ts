import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Resolves symlinks for an existing path (or its nearest existing parent) so a symlink
 * inside the workspace cannot be used to read/write outside it unnoticed.
 */
export function policyRealPath(target: string): string {
  const abs = resolve(target);
  try {
    return realpathSync.native(abs);
  } catch {
    try {
      return join(realpathSync.native(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

/** True when `target` resolves to the same path as `root` or lives beneath it. */
export function isPathInside(root: string, target: string): boolean {
  const rel = relative(policyRealPath(root), policyRealPath(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Normalized workspace-relative path using forward slashes (or "." for the root). */
export function toWorkspaceRelative(root: string, target: string): string {
  const rel = relative(resolve(root), resolve(target)).replace(/\\/g, "/");
  return rel || ".";
}
