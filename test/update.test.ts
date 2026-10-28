import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkForUpdate,
  compareVersions,
  formatUpdateNotice,
  manualUpdateInstructions,
  parseUpdateManifest,
  readUpdateCache,
  runUpdate,
  updateCachePath,
  writeUpdateCache,
} from "../src/update.js";
import { parseCliArgs, runCli } from "../src/cli.js";

const MANIFEST = {
  version: "1.2.0",
  downloadUrl: "https://aivokey.dev/cli/download/aivocode-1.2.0.tgz",
  changelogUrl: "https://github.com/bungtd/aivocode/releases/tag/v1.2.0",
  publishedAt: "2026-01-01T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "aivo-update-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("update version comparison", () => {
  it("orders numeric cores, not strings", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.0.10", "1.0.9")).toBe(1);
    expect(compareVersions("1.0.1", "1.0.1")).toBe(0);
    expect(compareVersions("0.9.9", "1.0.0")).toBe(-1);
  });

  it("tolerates a leading v and missing segments", () => {
    expect(compareVersions("v1.2.0", "1.2")).toBe(0);
    expect(compareVersions("v2", "1.99.99")).toBe(1);
  });

  it("sorts a prerelease before its release", () => {
    expect(compareVersions("1.0.1-beta.2", "1.0.1")).toBe(-1);
    expect(compareVersions("1.0.1", "1.0.1-beta.2")).toBe(1);
    expect(compareVersions("1.0.1-beta.2", "1.0.1-beta.1")).toBe(1);
  });
});

describe("update manifest validation", () => {
  it("accepts a well-formed manifest and strips a leading v", () => {
    expect(parseUpdateManifest({ ...MANIFEST, version: "v1.2.0" })).toEqual(MANIFEST);
  });

  it("rejects malformed or dangerous payloads", () => {
    expect(parseUpdateManifest(null)).toBeNull();
    expect(parseUpdateManifest([])).toBeNull();
    expect(parseUpdateManifest("1.0.0")).toBeNull();
    expect(parseUpdateManifest({ ...MANIFEST, version: "latest" })).toBeNull();
    expect(parseUpdateManifest({ ...MANIFEST, downloadUrl: "" })).toBeNull();
    expect(parseUpdateManifest({ ...MANIFEST, downloadUrl: "javascript:alert(1)" })).toBeNull();
  });

  it("drops a non-http changelog instead of failing the whole manifest", () => {
    const parsed = parseUpdateManifest({ ...MANIFEST, changelogUrl: "not-a-url" });
    expect(parsed?.changelogUrl).toBeNull();
  });
});

describe("update cache", () => {
  it("lives beside the global config", () => {
    expect(updateCachePath(join("home", "user", ".aivokey", "config.json"))).toBe(
      join("home", "user", ".aivokey", "update-check.json"),
    );
  });

  it("survives a corrupt cache file", () => {
    withTempDir((dir) => {
      const path = join(dir, "update-check.json");
      writeUpdateCache(path, { checkedAt: 5, latest: "1.2.0", downloadUrl: MANIFEST.downloadUrl });
      expect(readUpdateCache(path)).toEqual({
        checkedAt: 5,
        latest: "1.2.0",
        downloadUrl: MANIFEST.downloadUrl,
      });
      expect(readUpdateCache(join(dir, "missing.json"))).toBeNull();
    });
  });

  it("rejects a cache with a non-numeric timestamp", () => {
    withTempDir((dir) => {
      const path = join(dir, "update-check.json");
      writeUpdateCache(path, { checkedAt: 0, latest: "1.2.0", downloadUrl: null });
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      raw.checkedAt = "yesterday";
      // Write the corrupt payload by hand; writeUpdateCache always writes a number.
      const corrupt = join(dir, "corrupt.json");
      writeFileSync(corrupt, JSON.stringify(raw));
      expect(readUpdateCache(corrupt)).toBeNull();
    });
  });
});

describe("checkForUpdate", () => {
  it("fetches the manifest and notes a newer version", async () => {
    await withTempDir(async (dir) => {
      const fetchFn = vi.fn(async () => jsonResponse(MANIFEST)) as unknown as typeof fetch;
      const status = await checkForUpdate({
        currentVersion: "1.0.2",
        cachePath: join(dir, "update-check.json"),
        fetchFn,
        now: 1_000,
      });
      expect(status).toEqual({
        current: "1.0.2",
        latest: "1.2.0",
        updateAvailable: true,
        fromCache: false,
      });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  it("does not flag the same or older version", async () => {
    await withTempDir(async (dir) => {
      const status = await checkForUpdate({
        currentVersion: "1.2.0",
        cachePath: join(dir, "update-check.json"),
        fetchFn: (async () => jsonResponse(MANIFEST)) as unknown as typeof fetch,
        now: 1_000,
      });
      expect(status.updateAvailable).toBe(false);
      expect(formatUpdateNotice(status)).toBeNull();
    });
  });

  it("uses the cache inside the interval instead of hitting the network", async () => {
    await withTempDir(async (dir) => {
      const cachePath = join(dir, "update-check.json");
      writeUpdateCache(cachePath, {
        checkedAt: 10_000,
        latest: "1.2.0",
        downloadUrl: MANIFEST.downloadUrl,
      });
      const fetchFn = vi.fn(async () => jsonResponse(MANIFEST)) as unknown as typeof fetch;
      const status = await checkForUpdate({
        currentVersion: "1.0.2",
        cachePath,
        fetchFn,
        now: 10_000 + 60_000,
      });
      expect(status.fromCache).toBe(true);
      expect(status.updateAvailable).toBe(true);
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  it("re-checks once the interval has elapsed", async () => {
    await withTempDir(async (dir) => {
      const cachePath = join(dir, "update-check.json");
      writeUpdateCache(cachePath, { checkedAt: 1_000, latest: null, downloadUrl: null });
      const fetchFn = vi.fn(async () => jsonResponse(MANIFEST)) as unknown as typeof fetch;
      const status = await checkForUpdate({
        currentVersion: "1.0.2",
        cachePath,
        fetchFn,
        now: 1_000 + 48 * 60 * 60 * 1_000,
      });
      expect(status.fromCache).toBe(false);
      expect(status.latest).toBe("1.2.0");
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  it("caches a failure as no news so offline machines do not retry every start", async () => {
    await withTempDir(async (dir) => {
      const cachePath = join(dir, "update-check.json");
      const failing = vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch;
      const first = await checkForUpdate({
        currentVersion: "1.0.2",
        cachePath,
        fetchFn: failing,
        now: 2_000,
      });
      expect(first.latest).toBeNull();
      expect(readUpdateCache(cachePath)).toEqual({
        checkedAt: 2_000,
        latest: null,
        downloadUrl: null,
      });

      const second = await checkForUpdate({
        currentVersion: "1.0.2",
        cachePath,
        fetchFn: failing,
        now: 3_000,
      });
      expect(second.fromCache).toBe(true);
      expect(failing).toHaveBeenCalledTimes(1);
    });
  });

  it("treats a non-200 manifest as no update", async () => {
    await withTempDir(async (dir) => {
      const status = await checkForUpdate({
        currentVersion: "1.0.2",
        cachePath: join(dir, "update-check.json"),
        fetchFn: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
        now: 1_000,
      });
      expect(status.latest).toBeNull();
      expect(status.updateAvailable).toBe(false);
    });
  });
});

describe("runUpdate", () => {
  it("is a no-op when already newer than the manifest", async () => {
    await withTempDir(async (dir) => {
      const spawn = vi.fn();
      const lines: string[] = [];
      const result = await runUpdate({
        currentVersion: "2.0.0",
        manifestUrl: "https://aivokey.dev/cli/update.json",
        fetchFn: (async () => jsonResponse(MANIFEST)) as unknown as typeof fetch,
        cachePath: join(dir, "update-check.json"),
        writeOut: (line) => lines.push(line),
        spawn: spawn as never,
      });
      expect(result.code).toBe(0);
      expect(result.outcome.updated).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
      expect(lines.join("\n")).toContain("up to date");
    });
  });

  it("only reports when --check is used", async () => {
    await withTempDir(async (dir) => {
      const spawn = vi.fn();
      const lines: string[] = [];
      const result = await runUpdate({
        currentVersion: "1.0.2",
        checkOnly: true,
        fetchFn: (async () => jsonResponse(MANIFEST)) as unknown as typeof fetch,
        cachePath: join(dir, "update-check.json"),
        writeOut: (line) => lines.push(line),
        spawn: spawn as never,
      });
      expect(result.code).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
      expect(lines.join("\n")).toContain("aivo update");
    });
  });

  it("installs the counted tarball with npm and refreshes the cache", async () => {
    await withTempDir(async (dir) => {
      const cachePath = join(dir, "update-check.json");
      const spawn = vi.fn(() => ({ status: 0 }));
      const lines: string[] = [];
      const result = await runUpdate({
        currentVersion: "1.0.2",
        platform: "linux",
        fetchFn: (async () => jsonResponse(MANIFEST)) as unknown as typeof fetch,
        cachePath,
        writeOut: (line) => lines.push(line),
        spawn: spawn as never,
        now: 9_000,
      });

      expect(result.code).toBe(0);
      expect(result.outcome.updated).toBe(true);
      expect(spawn).toHaveBeenCalledWith(
        "npm",
        ["install", "-g", "--force", MANIFEST.downloadUrl],
        { stdio: "inherit", shell: false },
      );
      expect(readUpdateCache(cachePath)).toEqual({
        checkedAt: 9_000,
        latest: "1.2.0",
        downloadUrl: MANIFEST.downloadUrl,
      });
      expect(lines.join("\n")).toContain("v1.2.0");
    });
  });

  it("uses the Windows command shim", async () => {
    await withTempDir(async (dir) => {
      const spawn = vi.fn(() => ({ status: 0 }));
      await runUpdate({
        currentVersion: "1.0.2",
        platform: "win32",
        fetchFn: (async () => jsonResponse(MANIFEST)) as unknown as typeof fetch,
        cachePath: join(dir, "update-check.json"),
        writeOut: () => {},
        spawn: spawn as never,
      });
      expect(spawn).toHaveBeenCalledWith(
        "npm.cmd",
        ["install", "-g", "--force", MANIFEST.downloadUrl],
        { stdio: "inherit", shell: true },
      );
    });
  });

  it("falls back to manual instructions when npm fails", async () => {
    await withTempDir(async (dir) => {
      const lines: string[] = [];
      const result = await runUpdate({
        currentVersion: "1.0.2",
        fetchFn: (async () => jsonResponse(MANIFEST)) as unknown as typeof fetch,
        cachePath: join(dir, "update-check.json"),
        writeOut: (line) => lines.push(line),
        spawn: (() => ({ status: 1 })) as never,
      });
      expect(result.code).toBe(1);
      expect(result.outcome.updated).toBe(false);
      expect(result.outcome.error).toContain("code 1");
      expect(lines.join("\n")).toContain(manualUpdateInstructions(MANIFEST.downloadUrl));
    });
  });

  it("reports a reachable-manifest failure with a manual command", async () => {
    await withTempDir(async (dir) => {
      const lines: string[] = [];
      const result = await runUpdate({
        currentVersion: "1.0.2",
        fetchFn: (async () => new Response("down", { status: 500 })) as unknown as typeof fetch,
        cachePath: join(dir, "update-check.json"),
        writeOut: (line) => lines.push(line),
        spawn: (() => ({ status: 0 })) as never,
      });
      expect(result.code).toBe(1);
      expect(lines.join("\n")).toContain("npm install -g --force");
    });
  });

  it("emits one JSON object for --json", async () => {
    await withTempDir(async (dir) => {
      const lines: string[] = [];
      const result = await runUpdate({
        currentVersion: "1.0.2",
        json: true,
        platform: "linux",
        fetchFn: (async () => jsonResponse(MANIFEST)) as unknown as typeof fetch,
        cachePath: join(dir, "update-check.json"),
        writeOut: (line) => lines.push(line),
        spawn: (() => ({ status: 0 })) as never,
      });
      expect(result.code).toBe(0);
      const payload = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(payload.updated).toBe(true);
      expect(payload.latest).toBe("1.2.0");
    });
  });
});
describe("aivo update command wiring", () => {
  it("parses update and upgrade aliases, with --check and --json", () => {
    const update = parseCliArgs(["update"]);
    expect(update.command).toBe("update");
    expect(update.checkUpdate).toBe(false);
    expect(parseCliArgs(["upgrade", "--check"]).command).toBe("update");
    expect(parseCliArgs(["update", "--check"]).checkUpdate).toBe(true);
    expect(parseCliArgs(["update", "--json"]).json).toBe(true);
  });

  it("prints the available version for --check without installing", async () => {
    await withTempDir(async (dir) => {
      const lines: string[] = [];
      const code = await runCli(["update", "--check"], {
        globalConfigPath: join(dir, "config.json"),
        fetchFn: (async () => jsonResponse(MANIFEST)) as unknown as typeof fetch,
        writeOut: (line) => lines.push(line),
      });
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("1.2.0");
    });
  });

  it("reports a manifest outage as a failed command, not a crash", async () => {
    await withTempDir(async (dir) => {
      const lines: string[] = [];
      const code = await runCli(["update", "--check"], {
        globalConfigPath: join(dir, "config.json"),
        fetchFn: (async () => new Response("down", { status: 500 })) as unknown as typeof fetch,
        writeOut: (line) => lines.push(line),
      });
      expect(code).toBe(1);
      expect(lines.join("\n")).toContain("npm install -g --force");
    });
  });

  it("mentions the update command in help", async () => {
    const lines: string[] = [];
    await runCli(["help"], { writeOut: (line) => lines.push(line) });
    expect(lines.join("\n")).toContain("aivo update");
  });
});
