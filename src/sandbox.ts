import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { WINDOWS_SANDBOX_HELPER_SCRIPT } from "./win-sandbox-helper.js";

export type SandboxMode = "workspace" | "read-only" | "danger-full-access";
export type NetworkAccess = "allow" | "deny";

export const SANDBOX_MODES: ReadonlySet<SandboxMode> = new Set([
  "workspace",
  "read-only",
  "danger-full-access",
]);

export interface ShellSandboxOptions {
  cwd: string;
  mode: SandboxMode;
  network: NetworkAccess;
}

export interface SandboxedSpawn {
  bin: string;
  args: string[];
  /** False when no OS-level sandbox was available (path policy still applies to file tools). */
  enforced: boolean;
  description: string;
}

let bubblewrapAvailable: boolean | null = null;
let sandboxExecAvailable: boolean | null = null;
let windowsAppContainerAvailable: boolean | null = null;
let windowsHelperPath: string | null = null;

function ensureWindowsHelper(): string | null {
  if (process.platform !== "win32") return null;
  if (windowsHelperPath && existsSync(windowsHelperPath)) return windowsHelperPath;
  const dir = join(homedir(), ".aivokey");
  const path = join(dir, "win-sandbox.ps1");
  try {
    mkdirSync(dir, { recursive: true });
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current !== WINDOWS_SANDBOX_HELPER_SCRIPT) {
      writeFileSync(path, WINDOWS_SANDBOX_HELPER_SCRIPT, { encoding: "utf8", mode: 0o600 });
    }
    windowsHelperPath = path;
    return path;
  } catch {
    return null;
  }
}

function hasWindowsAppContainer(): boolean {
  if (process.platform !== "win32") return false;
  if (windowsAppContainerAvailable !== null) return windowsAppContainerAvailable;
  const helper = ensureWindowsHelper();
  if (!helper) {
    windowsAppContainerAvailable = false;
    return false;
  }
  let probeDir: string | null = null;
  try {
    probeDir = mkdtempSync(join(tmpdir(), "aivo-sandbox-probe-"));
    const probe = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        helper,
        "-Command",
        "Write-Output AIVO_SANDBOX_OK",
        "-Workspace",
        probeDir,
        "-Cwd",
        probeDir,
        "-Network",
        "deny",
        "-Probe",
      ],
      {
        timeout: 30_000,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    windowsAppContainerAvailable =
      probe.status === 0 && String(probe.stdout ?? "").includes("AIVO_SANDBOX_OK");
  } catch {
    windowsAppContainerAvailable = false;
  } finally {
    if (probeDir) {
      try {
        rmSync(probeDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the probe profile/ACL is removed by the helper.
      }
    }
  }
  return windowsAppContainerAvailable;
}

function hasBubblewrap(): boolean {
  if (bubblewrapAvailable !== null) return bubblewrapAvailable;
  try {
    const version = spawnSync("bwrap", ["--version"], {
      timeout: 2_000,
      stdio: "ignore",
      windowsHide: true,
    });
    if (version.status !== 0) {
      bubblewrapAvailable = false;
      return bubblewrapAvailable;
    }
    // Presence alone is not enough: user namespaces may be disabled on the host.
    const probe = spawnSync(
      "bwrap",
      ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "/bin/true"],
      {
        timeout: 3_000,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    bubblewrapAvailable = probe.status === 0;
  } catch {
    bubblewrapAvailable = false;
  }
  return bubblewrapAvailable;
}

function hasSandboxExec(): boolean {
  if (sandboxExecAvailable !== null) return sandboxExecAvailable;
  sandboxExecAvailable =
    process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
  return sandboxExecAvailable;
}

function existingWritableCaches(): string[] {
  const home = homedir();
  return [
    join(home, ".npm"),
    join(home, ".cache"),
    join(home, ".bun"),
    join(home, ".pnpm-store"),
    join(home, ".cargo", "registry"),
  ].filter((dir) => existsSync(dir));
}

function quoteSbplPath(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quotePowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function macSandboxProfile(opts: ShellSandboxOptions, workdir: string): string {
  const writable = [
    ...(opts.mode === "workspace"
      ? [...new Set([opts.cwd, workdir]), ...existingWritableCaches()]
      : []),
    "/tmp",
    "/private/tmp",
    "/dev",
  ];
  const writes = writable.map((path) => `(subpath ${quoteSbplPath(path)})`).join(" ");
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow signal)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read*)",
    "(allow file-read-metadata)",
    "(allow ipc-posix-shm)",
    `(allow file-write* ${writes})`,
    ...(opts.network === "allow" ? ["(allow network*)"] : []),
  ].join("\n");
}

/**
 * Best-effort OS-level sandbox for shell commands:
 * - Linux: bubblewrap (`bwrap`) when installed.
 * - macOS: `sandbox-exec` when available.
 * - Windows: AppContainer profile + Job Object through a PowerShell/C# helper.
 * `enforced` reports the truth so the UI and path guard can adapt.
 */
export class ShellSandbox {
  readonly options: ShellSandboxOptions;
  readonly kind: "bubblewrap" | "sandbox-exec" | "appcontainer" | "none";

  constructor(options: ShellSandboxOptions) {
    this.options = options;
    if (options.mode === "danger-full-access" || process.env.AIVO_DISABLE_OS_SANDBOX === "1") {
      this.kind = "none";
    } else if (process.platform === "linux" && hasBubblewrap()) {
      this.kind = "bubblewrap";
    } else if (process.platform === "darwin" && hasSandboxExec()) {
      this.kind = "sandbox-exec";
    } else if (process.platform === "win32" && hasWindowsAppContainer()) {
      this.kind = "appcontainer";
    } else {
      this.kind = "none";
    }
  }

  get enforced(): boolean {
    return this.kind !== "none";
  }

  wrap(
    command: string,
    shellBin: string,
    shellArgs: string[],
    workdir: string = this.options.cwd,
  ): SandboxedSpawn {
    if (this.kind === "none") {
      return {
        bin: shellBin,
        args: shellArgs,
        enforced: false,
        description: "no OS sandbox",
      };
    }
    if (this.kind === "bubblewrap") {
      const args = [
        "--die-with-parent",
        "--new-session",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        ...(this.options.network === "deny" ? ["--unshare-net"] : []),
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        ...(existsSync("/tmp") ? ["--bind", "/tmp", "/tmp"] : []),
        ...(existsSync("/var/tmp") ? ["--bind", "/var/tmp", "/var/tmp"] : []),
        ...(this.options.mode === "workspace"
          ? [...new Set([this.options.cwd, workdir])].flatMap((dir) => [
              "--bind",
              dir,
              dir,
            ])
          : []),
        ...existingWritableCaches().flatMap((dir) => ["--bind", dir, dir]),
        "--chdir",
        workdir,
        "--",
        shellBin,
        ...shellArgs,
      ];
      return {
        bin: "bwrap",
        args,
        enforced: true,
        description: `bubblewrap (${this.options.mode}, network ${this.options.network})`,
      };
    }
    if (this.kind === "appcontainer") {
      const helper = ensureWindowsHelper();
      if (!helper) {
        return { bin: shellBin, args: shellArgs, enforced: false, description: "no OS sandbox" };
      }
      const hostShell = shellBin === "/bin/sh" ? "powershell.exe" : shellBin;
      return {
        bin: "powershell.exe",
        args: [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          helper,
          "-Command",
          command,
          "-Workspace",
          this.options.cwd,
          "-Cwd",
          workdir,
          "-Network",
          this.options.network,
          "-Shell",
          hostShell,
          ...(this.options.mode === "read-only" ? ["-ReadOnly"] : []),
        ],
        enforced: true,
        description: `Windows AppContainer (${this.options.mode}, network ${this.options.network})`,
      };
    }
    const profile = macSandboxProfile(this.options, workdir);
    return {
      bin: "sandbox-exec",
      args: ["-p", profile, shellBin, ...shellArgs],
      enforced: true,
      description: `sandbox-exec (${this.options.mode}, network ${this.options.network})`,
    };
  }

  /**
   * Wraps a direct executable (no intermediate shell). Used by MCP stdio
   * servers, where arguments must be passed verbatim instead of interpreted by
   * a shell.
   */
  wrapDirect(
    bin: string,
    args: string[],
    workdir: string = this.options.cwd,
  ): SandboxedSpawn {
    if (this.kind === "none") {
      return { bin, args, enforced: false, description: "no OS sandbox" };
    }
    if (this.kind === "bubblewrap") {
      const wrapArgs = [
        "--die-with-parent",
        "--new-session",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        ...(this.options.network === "deny" ? ["--unshare-net"] : []),
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        ...(existsSync("/tmp") ? ["--bind", "/tmp", "/tmp"] : []),
        ...(existsSync("/var/tmp") ? ["--bind", "/var/tmp", "/var/tmp"] : []),
        ...(this.options.mode === "workspace"
          ? [...new Set([this.options.cwd, workdir])].flatMap((dir) => ["--bind", dir, dir])
          : []),
        ...existingWritableCaches().flatMap((dir) => ["--bind", dir, dir]),
        "--chdir",
        workdir,
        "--",
        bin,
        ...args,
      ];
      return {
        bin: "bwrap",
        args: wrapArgs,
        enforced: true,
        description: `bubblewrap (${this.options.mode}, network ${this.options.network})`,
      };
    }
    if (this.kind === "appcontainer") {
      const helper = ensureWindowsHelper();
      if (!helper) {
        return { bin, args, enforced: false, description: "no OS sandbox" };
      }
      const command = `& ${[bin, ...args].map(quotePowerShellArg).join(" ")}`;
      return this.wrap(command, "powershell.exe", [], workdir);
    }
    return {
      bin: "sandbox-exec",
      args: ["-p", macSandboxProfile(this.options, workdir), bin, ...args],
      enforced: true,
      description: `sandbox-exec (${this.options.mode}, network ${this.options.network})`,
    };
  }

  describe(): string {
    if (this.kind === "none") {
      return this.options.mode === "danger-full-access"
        ? "danger-full-access (no OS sandbox)"
        : `no OS sandbox available on ${process.platform}; file tools still enforce workspace path rules`;
    }
    return `${this.kind} · ${this.options.mode} · network ${this.options.network}`;
  }
}
