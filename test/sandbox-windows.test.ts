import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ShellSandbox } from "../src/sandbox.js";
import { WINDOWS_SANDBOX_HELPER_SCRIPT } from "../src/win-sandbox-helper.js";

function syntheticSandbox(
  kind: "appcontainer" | "none",
  cwd: string,
  options: Partial<{ mode: "workspace" | "read-only"; network: "allow" | "deny" }> = {},
): ShellSandbox {
  const sandbox = Object.create(ShellSandbox.prototype) as ShellSandbox;
  Object.assign(sandbox, {
    kind,
    options: {
      cwd,
      mode: options.mode ?? "workspace",
      network: options.network ?? "deny",
    },
  });
  return sandbox;
}

describe("Windows AppContainer sandbox helper", () => {
  it("embeds a native helper with profile, Job Object, capability and drive-mapping support", () => {
    expect(WINDOWS_SANDBOX_HELPER_SCRIPT).toContain("CreateAppContainerProfile");
    expect(WINDOWS_SANDBOX_HELPER_SCRIPT).toContain("DeriveAppContainerSidFromAppContainerName");
    expect(WINDOWS_SANDBOX_HELPER_SCRIPT).toContain("0x00020009");
    expect(WINDOWS_SANDBOX_HELPER_SCRIPT).toContain("0x00002000");
    expect(WINDOWS_SANDBOX_HELPER_SCRIPT).toContain("S-1-15-3-1");
    expect(WINDOWS_SANDBOX_HELPER_SCRIPT).toContain("S-1-15-3-3");
    expect(WINDOWS_SANDBOX_HELPER_SCRIPT).toContain("subst.exe");
    expect(WINDOWS_SANDBOX_HELPER_SCRIPT).toContain("AivoCode Sandbox");
    // A literal ${...} would be consumed by the JS template before PowerShell sees it.
    expect(WINDOWS_SANDBOX_HELPER_SCRIPT).not.toContain("${");
    expect(WINDOWS_SANDBOX_HELPER_SCRIPT).not.toContain("`");
  });

  it.skipIf(process.platform !== "win32")(
    "wraps appcontainer commands with the helper, host shell, policy and read-only flag",
    () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-win-sandbox-"));
    try {
      const sandbox = syntheticSandbox("appcontainer", dir, {
        mode: "read-only",
        network: "deny",
      });
      const wrapped = sandbox.wrap("npm test", "pwsh.exe", ["-Command", "npm test"], dir);
      expect(wrapped.enforced).toBe(true);
      expect(wrapped.bin).toBe("powershell.exe");
      expect(wrapped.args).toContain("-File");
      expect(wrapped.args).toContain("-Command");
      expect(wrapped.args).toContain("npm test");
      expect(wrapped.args).toContain("-Workspace");
      expect(wrapped.args).toContain("-Cwd");
      expect(wrapped.args).toContain("-Network");
      expect(wrapped.args).toContain("-Shell");
      expect(wrapped.args).toContain("pwsh.exe");
      expect(wrapped.args).toContain("-ReadOnly");
      expect(wrapped.description).toContain("AppContainer");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "wraps direct MCP executables without an intermediate shell",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "aivo-win-sandbox-direct-"));
      try {
        const sandbox = syntheticSandbox("appcontainer", dir, {
          mode: "workspace",
          network: "allow",
        });
        const wrapped = sandbox.wrapDirect("node", ["server.mjs", "--stdio"], dir);
        expect(wrapped.enforced).toBe(true);
        expect(wrapped.bin).toBe("powershell.exe");
        expect(wrapped.args).toContain("-File");
        expect(wrapped.args.join(" ")).toContain("'node' 'server.mjs' '--stdio'");
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },
  );

  it("falls back to a plain spawn when no OS sandbox is active", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-win-sandbox-none-"));
    try {
      const sandbox = syntheticSandbox("none", dir);
      const wrapped = sandbox.wrap("echo hi", "/bin/sh", ["-c", "echo hi"], dir);
      expect(wrapped.enforced).toBe(false);
      expect(wrapped.bin).toBe("/bin/sh");
      expect(wrapped.args).toEqual(["-c", "echo hi"]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("never probes or wraps danger-full-access", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-win-sandbox-danger-"));
    try {
      const sandbox = new ShellSandbox({
        cwd: dir,
        mode: "danger-full-access",
        network: "allow",
      });
      expect(sandbox.kind).toBe("none");
      expect(sandbox.enforced).toBe(false);
      const wrapped = sandbox.wrap("echo hi", "powershell.exe", ["-Command", "echo hi"], dir);
      expect(wrapped.enforced).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
