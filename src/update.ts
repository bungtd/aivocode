import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AIVO_CLIENT_VERSION } from "./client-identity.js";
import { defaultGlobalConfigPath } from "./config.js";

/**
 * In-place update support for AivoCode.
 *
 * The CLI is installed as a global npm package (from the counted tarball URL),
 * so upgrading is the same operation as installing: `npm install -g --force
 * <tarball>`. Users should never have to re-run an installer for a routine
 * release, and they should not be surprised by a silent swap mid-task either —
 * so this module separates the two concerns:
 *
 *  - `checkForUpdate` runs at most once per day and only reports;
 *  - `runUpdate` (the `aivo update` command) performs the install.
 */

/** Where the newest published stable release is advertised. */
export const UPDATE_MANIFEST_URL = "https://aivokey.dev/cli/update.json";

/** One network check per day; the result is cached in `~/.aivokey`. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A notice must never make startup feel slow, so the check is short. */
const CHECK_TIMEOUT_MS = 1_500;

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface UpdateManifest {
  /** Semantic version, no leading `v`. */
  version: string;
  /** Direct (counted) tarball URL for that version. */
  downloadUrl: string;
  changelogUrl: string | null;
  publishedAt: string | null;
}

export interface UpdateCache {
  /** When the last network check happened (epoch ms). Failures are cached too, so an offline machine does not pay the timeout every start. */
  checkedAt: number;
  /** Newest version seen, or null when the check failed. */
  latest: string | null;
  downloadUrl: string | null;
}

export interface SpawnResult {
  status: number | null;
  error?: Error;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: "inherit"; shell: boolean },
) => SpawnResult;

/** Compare two semantic versions. Prereleases sort before their release. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const clean = value.trim().replace(/^v/i, "");
    const dash = clean.indexOf("-");
    const core = dash === -1 ? clean : clean.slice(0, dash);
    const pre = dash === -1 ? "" : clean.slice(dash + 1);
    const parts = core.split(".").map((n) => {
      const parsed = Number.parseInt(n, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
    while (parts.length < 3) parts.push(0);
    return { core: parts.slice(0, 3), pre };
  };

  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i]! > right.core[i]! ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  // A release outranks any prerelease of the same core version.
  if (left.pre === "") return 1;
  if (right.pre === "") return -1;
  return left.pre > right.pre ? 1 : -1;
}

/** Validate a manifest payload; anything malformed is ignored, never trusted. */
export function parseUpdateManifest(value: unknown): UpdateManifest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const version = typeof raw.version === "string" ? raw.version.trim().replace(/^v/i, "") : "";
  const downloadUrl = typeof raw.downloadUrl === "string" ? raw.downloadUrl.trim() : "";
  if (!VERSION_RE.test(version) || !/^https?:\/\//.test(downloadUrl)) return null;
  const changelogUrl =
    typeof raw.changelogUrl === "string" && /^https?:\/\//.test(raw.changelogUrl.trim())
      ? raw.changelogUrl.trim()
      : null;
  const publishedAt = typeof raw.publishedAt === "string" ? raw.publishedAt : null;
  return { version, downloadUrl, changelogUrl, publishedAt };
}

/**
 * Fetch the published-release manifest. Never throws: a CLI that cannot reach
 * the update host must behave exactly like one that is up to date.
 */
export async function fetchUpdateManifest(
  fetchFn: typeof fetch = fetch,
  manifestUrl: string = UPDATE_MANIFEST_URL,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<UpdateManifest | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs) as { unref?: () => void };
  timer.unref?.();
  try {
    const res = await fetchFn(manifestUrl, {
      headers: { accept: "application/json", "user-agent": `aivocode/${AIVO_CLIENT_VERSION}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return parseUpdateManifest(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
  }
}

/** `~/.aivokey/update-check.json` (next to the user config). */
export function updateCachePath(globalConfigPath: string = defaultGlobalConfigPath()): string {
  return join(dirname(globalConfigPath), "update-check.json");
}

export function readUpdateCache(path: string): UpdateCache | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof raw.checkedAt !== "number" || !Number.isFinite(raw.checkedAt)) return null;
    const latest =
      typeof raw.latest === "string" && VERSION_RE.test(raw.latest) ? raw.latest : null;
    const downloadUrl = typeof raw.downloadUrl === "string" ? raw.downloadUrl : null;
    return { checkedAt: raw.checkedAt, latest, downloadUrl };
  } catch {
    return null;
  }
}

/** Best-effort cache write: an unwritable HOME must not break the CLI. */
export function writeUpdateCache(path: string, cache: UpdateCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  } catch {
    /* ignore */
  }
}

export interface CheckForUpdateOptions {
  currentVersion?: string;
  fetchFn?: typeof fetch;
  cachePath?: string;
  globalConfigPath?: string;
  manifestUrl?: string;
  now?: number;
  intervalMs?: number;
  timeoutMs?: number;
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** True when the answer came from the cache, so no network was used. */
  fromCache: boolean;
}

/**
 * Check for a newer release, at most once per `intervalMs`.
 *
 * A failed check is cached as "no news" so an offline or firewalled machine
 * pays the timeout once a day instead of on every start.
 */
export async function checkForUpdate(options: CheckForUpdateOptions = {}): Promise<UpdateStatus> {
  const current = options.currentVersion ?? AIVO_CLIENT_VERSION;
  const cachePath = options.cachePath ?? updateCachePath(options.globalConfigPath);
  const now = options.now ?? Date.now();
  const interval = options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  const cached = readUpdateCache(cachePath);

  if (cached && now - cached.checkedAt >= 0 && now - cached.checkedAt < interval) {
    return {
      current,
      latest: cached.latest,
      updateAvailable: cached.latest !== null && compareVersions(cached.latest, current) > 0,
      fromCache: true,
    };
  }

  const manifest = await fetchUpdateManifest(
    options.fetchFn ?? fetch,
    options.manifestUrl ?? UPDATE_MANIFEST_URL,
    options.timeoutMs ?? CHECK_TIMEOUT_MS,
  );
  const next: UpdateCache = {
    checkedAt: now,
    latest: manifest?.version ?? null,
    downloadUrl: manifest?.downloadUrl ?? null,
  };
  writeUpdateCache(cachePath, next);

  return {
    current,
    latest: next.latest,
    updateAvailable: next.latest !== null && compareVersions(next.latest, current) > 0,
    fromCache: false,
  };
}

/** The one-line notice shown at startup (null when there is nothing to say). */
export function formatUpdateNotice(status: UpdateStatus): string | null {
  if (!status.updateAvailable || status.latest === null) return null;
  return `AivoCode v${status.latest} is available (you have v${status.current}). Run \`aivo update\` to upgrade.`;
}

/** Manual instructions used when npm cannot be run for us. */
export function manualUpdateInstructions(downloadUrl: string): string {
  return [
    "Update manually instead:",
    `  npm install -g --force ${downloadUrl}`,
    "  Windows (PowerShell): irm https://aivokey.dev/cli/download/install.ps1 | iex",
    "  macOS / Linux:        curl -fsSL https://aivokey.dev/cli/download/install.sh | sh",
  ].join("\n");
}

export interface RunUpdateOptions {
  /** Only report what is available; never install. */
  checkOnly?: boolean;
  /** Machine-readable output (`aivo update --json`). */
  json?: boolean;
  currentVersion?: string;
  fetchFn?: typeof fetch;
  manifestUrl?: string;
  cachePath?: string;
  globalConfigPath?: string;
  now?: number;
  writeOut?: (line: string) => void;
  spawn?: SpawnFn;
  platform?: NodeJS.Platform;
}

export interface UpdateOutcome {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  updated: boolean;
  error?: string;
}

/**
 * Upgrade the global install in place.
 *
 * `npm install -g --force <tarball>` is the same path the one-line installer
 * uses, so it also refreshes the bin links and works on Windows, macOS, and
 * Linux without a separate updater binary. The running process keeps the old
 * code; the next `aivo` invocation is the new version.
 */
export async function runUpdate(options: RunUpdateOptions = {}): Promise<{
  code: number;
  outcome: UpdateOutcome;
}> {
  const current = options.currentVersion ?? AIVO_CLIENT_VERSION;
  const out = options.writeOut ?? ((line: string) => process.stdout.write(line + "\n"));
  const manifest = await fetchUpdateManifest(
    options.fetchFn ?? fetch,
    options.manifestUrl ?? UPDATE_MANIFEST_URL,
    8_000,
  );

  if (!manifest) {
    const outcome: UpdateOutcome = {
      current,
      latest: null,
      updateAvailable: false,
      updated: false,
      error: "could not reach the AivoCode release manifest",
    };
    if (options.json) out(JSON.stringify(outcome));
    else
      out(
        "Could not reach the AivoCode release server. Check your connection, or install manually:\n" +
          `  npm install -g --force https://aivokey.dev/cli/download/aivocode-${current}.tgz`,
      );
    return { code: 1, outcome };
  }

  const updateAvailable = compareVersions(manifest.version, current) > 0;
  const outcome: UpdateOutcome = {
    current,
    latest: manifest.version,
    updateAvailable,
    updated: false,
  };

  if (options.json) {
    if (options.checkOnly || !updateAvailable) {
      out(JSON.stringify(outcome));
      return { code: 0, outcome };
    }
  } else if (!updateAvailable) {
    out(`AivoCode v${current} is up to date (latest is v${manifest.version}).`);
    return { code: 0, outcome };
  } else if (options.checkOnly) {
    out(`AivoCode v${manifest.version} is available (you have v${current}). Run \`aivo update\`.`);
    return { code: 0, outcome };
  }

  if (!options.json) out(`Updating AivoCode v${current} → v${manifest.version}…`);

  const spawn: SpawnFn =
    options.spawn ??
    ((command, args, spawnOptions) => spawnSync(command, args, spawnOptions) as SpawnResult);
  const npm = (options.platform ?? process.platform) === "win32" ? "npm.cmd" : "npm";
  let result: SpawnResult;
  try {
    result = spawn(npm, ["install", "-g", "--force", manifest.downloadUrl], {
      stdio: "inherit",
      shell: (options.platform ?? process.platform) === "win32",
    });
  } catch (err) {
    result = { status: null, error: err instanceof Error ? err : new Error(String(err)) };
  }

  if (result.error || result.status !== 0) {
    const reason = result.error ? result.error.message : `npm exited with code ${result.status}`;
    outcome.error = reason;
    if (options.json) out(JSON.stringify(outcome));
    else {
      out(`Update failed: ${reason}`);
      out(manualUpdateInstructions(manifest.downloadUrl));
    }
    return { code: 1, outcome };
  }

  writeUpdateCache(options.cachePath ?? updateCachePath(options.globalConfigPath), {
    checkedAt: options.now ?? Date.now(),
    latest: manifest.version,
    downloadUrl: manifest.downloadUrl,
  });
  outcome.updated = true;
  if (options.json) out(JSON.stringify(outcome));
  else {
    out(`Updated AivoCode to v${manifest.version}. Restart \`aivo\` to use it.`);
    if (manifest.changelogUrl) out(`Release notes: ${manifest.changelogUrl}`);
  }
  return { code: 0, outcome };
}