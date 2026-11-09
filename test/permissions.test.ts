import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PermissionEngine, parsePermissionsConfig } from "../src/permissions.js";
import { ShellSandbox } from "../src/sandbox.js";
import { createToolset } from "../src/tools/index.js";
import { CheckpointManager } from "../src/checkpoint.js";
import { expandFileMentions } from "../src/context.js";
import { loadUserConfig, resolveConfig } from "../src/config.js";
import { parseCliArgs } from "../src/cli.js";

describe("Permissions and sandbox policy", () => {
  it("applies workspace defaults, outside-workspace asks, and hard plan/read-only denials", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-perm-"));
    try {
      const engine = new PermissionEngine({
        cwd: dir,
        mode: "auto",
        sandbox: "workspace",
      });
      expect(engine.evaluate("read", "src/a.ts", { absPath: join(dir, "src/a.ts") }).action).toBe(
        "allow",
      );
      expect(
        engine.evaluate("read", "../secret.txt", { absPath: join(dir, "..", "secret.txt") }).action,
      ).toBe("ask");
      expect(
        engine.evaluate("write", "src/a.ts", { absPath: join(dir, "src/a.ts") }).action,
      ).toBe("allow");
      expect(
        engine.evaluate("write", "../secret.txt", { absPath: join(dir, "..", "secret.txt") })
          .action,
      ).toBe("ask");

      const safe = new PermissionEngine({ cwd: dir, mode: "safe", sandbox: "workspace" });
      expect(safe.evaluate("write", "src/a.ts", { absPath: join(dir, "src/a.ts") }).action).toBe(
        "ask",
      );
      expect(safe.evaluate("shell", "npm test").action).toBe("ask");

      const plan = new PermissionEngine({ cwd: dir, mode: "plan", sandbox: "workspace" });
      expect(plan.evaluate("write", "src/a.ts", { absPath: join(dir, "src/a.ts") }).action).toBe(
        "deny",
      );
      expect(plan.evaluate("shell", "npm test").action).toBe("deny");

      const readOnly = new PermissionEngine({
        cwd: dir,
        mode: "auto",
        sandbox: "read-only",
      });
      expect(
        readOnly.evaluate("write", "src/a.ts", { absPath: join(dir, "src/a.ts") }).action,
      ).toBe("deny");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("honors explicit allow/deny rules, allowOutsideWorkspace, and network policy", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-perm-rules-"));
    try {
      const parsed = parsePermissionsConfig({
        read: [{ pattern: "**/*.env", action: "deny" }],
        write: [
          { pattern: "src/**", action: "allow" },
          { pattern: "src/secrets/**", action: "deny" },
        ],
        shell: [
          { pattern: "npm *", action: "allow" },
          { pattern: "curl *", action: "deny" },
        ],
        allowOutsideWorkspace: true,
        network: "deny",
        env: ["GITHUB_TOKEN", "NPM_*", "GITHUB_TOKEN"],
      });
      expect(parsed?.read).toHaveLength(1);
      expect(parsed?.env).toEqual(["GITHUB_TOKEN", "NPM_*"]);

      const engine = new PermissionEngine({
        cwd: dir,
        mode: "auto",
        sandbox: "workspace",
        permissions: parsed ?? {},
      });
      expect(
        engine.evaluate("read", ".env", { absPath: join(dir, ".env") }).action,
      ).toBe("deny");
      expect(
        engine.evaluate("read", "../outside.txt", { absPath: join(dir, "..", "outside.txt") })
          .action,
      ).toBe("allow");
      expect(
        engine.evaluate("write", "src/secrets/key.ts", {
          absPath: join(dir, "src", "secrets", "key.ts"),
        }).action,
      ).toBe("deny");
      expect(engine.evaluate("shell", "npm test").action).toBe("allow");
      expect(engine.evaluate("shell", "curl example.com").action).toBe("deny");
      expect(engine.evaluate("webfetch", "example.com").action).toBe("deny");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("asks -> denies without a prompt, and confirms with a callback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-perm-ask-"));
    try {
      const noPrompt = new PermissionEngine({ cwd: dir, mode: "safe", sandbox: "workspace" });
      const denied = await noPrompt.authorize("write", "a.txt", {
        absPath: join(dir, "a.txt"),
      });
      expect(denied.allowed).toBe(false);

      let asked = 0;
      const withPrompt = new PermissionEngine({
        cwd: dir,
        mode: "safe",
        sandbox: "workspace",
        confirmAction: async () => {
          asked++;
          return true;
        },
      });
      const allowed = await withPrompt.authorize("write", "a.txt", {
        absPath: join(dir, "a.txt"),
      });
      expect(allowed.allowed).toBe(true);
      expect(asked).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("remembers 'always allow in session' for the exact operation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-perm-always-"));
    try {
      let asked = 0;
      const engine = new PermissionEngine({
        cwd: dir,
        mode: "safe",
        sandbox: "workspace",
        confirmAction: async () => {
          asked++;
          return "always";
        },
      });
      const target = join(dir, "a.txt");
      expect((await engine.authorize("write", "a.txt", { absPath: target })).allowed).toBe(true);
      expect((await engine.authorize("write", "a.txt", { absPath: target })).allowed).toBe(true);
      expect(asked).toBe(1);
      expect(
        (await engine.authorize("write", "b.txt", { absPath: join(dir, "b.txt") })).allowed,
      ).toBe(true);
      expect(asked).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("blocks outside-workspace reads/writes in a real toolset and can allow them explicitly", async () => {
    const root = mkdtempSync(join(tmpdir(), "aivo-perm-tool-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    try {
      writeFileSync(outside, "secret\n", "utf8");
      mkdirSync(workspace, { recursive: true });

      const strict = new PermissionEngine({
        cwd: workspace,
        mode: "auto",
        sandbox: "workspace",
      });
      const strictTools = createToolset({
        cwd: workspace,
        mode: "auto",
        checkpoints: new CheckpointManager(),
        todos: [],
        permissionEngine: strict,
      });
      const deniedRead = await strictTools.execute("read_file", { path: outside });
      expect(deniedRead.isError).toBe(true);
      expect(deniedRead.output).toContain("Blocked");
      const deniedWrite = await strictTools.execute("write_file", {
        path: outside,
        content: "changed",
      });
      expect(deniedWrite.isError).toBe(true);
      expect(readFileSync(outside, "utf8")).toBe("secret\n");

      const systemPath = process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/hosts";
      const deniedShell = await strictTools.execute("run_shell", {
        command: `echo "${systemPath}"`,
      });
      expect(deniedShell.isError).toBe(true);
      expect(deniedShell.output).toContain("Blocked");

      const permissive = new PermissionEngine({
        cwd: workspace,
        mode: "auto",
        sandbox: "workspace",
        permissions: { allowOutsideWorkspace: true },
      });
      const permissiveTools = createToolset({
        cwd: workspace,
        mode: "auto",
        checkpoints: new CheckpointManager(),
        todos: [],
        permissionEngine: permissive,
      });
      const allowedRead = await permissiveTools.execute("read_file", { path: outside });
      expect(allowedRead.isError).toBeFalsy();
      expect(allowedRead.output).toContain("secret");
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("does not auto-hydrate prompt mentions outside the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "aivo-perm-hydrate-"));
    const workspace = join(root, "workspace");
    try {
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(root, "secret.txt"), "outside\n", "utf8");
      const hydrated = expandFileMentions("Read `../secret.txt` and `./inside.txt`", workspace);
      expect(hydrated).not.toContain('<file path="../secret.txt">');
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("exposes sandbox state and resolves config/CLI flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-perm-config-"));
    try {
      const globalPath = join(dir, "config.json");
      writeFileSync(
        globalPath,
        JSON.stringify({
          sandbox: "read-only",
          permissions: {
            allowOutsideWorkspace: true,
            network: "deny",
            shell: [{ pattern: "npm *", action: "allow" }],
          },
        }),
        "utf8",
      );
      const cfg = loadUserConfig(globalPath);
      expect(cfg.sandbox).toBe("read-only");
      expect(cfg.permissions?.network).toBe("deny");

      const resolved = resolveConfig({
        cwd: dir,
        globalConfigPath: globalPath,
        env: {},
      });
      expect(resolved.sandbox).toBe("read-only");
      expect(resolved.permissions?.allowOutsideWorkspace).toBe(true);

      const parsed = parseCliArgs(["--sandbox", "danger-full-access", "--network", "deny"]);
      expect(parsed.cliConfig.sandbox).toBe("danger-full-access");
      expect(parsed.cliConfig.permissions?.network).toBe("deny");

      const sandbox = new ShellSandbox({
        cwd: dir,
        mode: "danger-full-access",
        network: "allow",
      });
      expect(sandbox.kind).toBe("none");
      expect(sandbox.enforced).toBe(false);
      expect(sandbox.describe()).toContain("danger-full-access");

      const workspaceSandbox = new ShellSandbox({
        cwd: dir,
        mode: "workspace",
        network: "allow",
      });
      const wrapped = workspaceSandbox.wrap("echo hi", "/bin/sh", ["-c", "echo hi"]);
      expect(Array.isArray(wrapped.args)).toBe(true);
      expect(typeof wrapped.enforced).toBe("boolean");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
