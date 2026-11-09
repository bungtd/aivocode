import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HookRunner,
  findCustomCommand,
  loadCustomCommands,
  normalizeHookEventName,
  parseHooksConfig,
  renderCustomCommand,
} from "../src/hooks.js";
import { PluginRuntime } from "../src/plugins.js";
import { createToolset } from "../src/tools/index.js";
import { CheckpointManager } from "../src/checkpoint.js";
import { PermissionEngine } from "../src/permissions.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

/** Writes a hook script that echoes a fixed JSON result; avoids shell quoting pitfalls. */
function writeHookScript(dir: string, name: string, body: string): string {
  const scriptPath = join(dir, `${name}.mjs`);
  writeFileSync(scriptPath, body, "utf8");
  return scriptPath;
}

function nodeCommand(scriptPath: string): string {
  // The hook command runs through PowerShell on Windows and /bin/sh elsewhere.
  return `node "${scriptPath.replace(/\\/g, "/")}"`;
}

describe("Lifecycle hooks", () => {
  it("parses hook config with aliases, matchers, timeouts and disabled entries", () => {
    const parsed = parseHooksConfig({
      pre_tool_use: [
        { matcher: "write_file|edit_file", command: "node guard.mjs", timeoutMs: 5_000 },
        { command: "  " },
        "node inline.mjs",
        { command: "node off.mjs", enabled: false },
      ],
      sessionstart: ["node start.mjs"],
      nonsense: ["node ignored.mjs"],
    });
    expect(parsed?.PreToolUse).toHaveLength(3);
    expect(parsed?.PreToolUse?.[0]?.matcher).toBe("write_file|edit_file");
    expect(parsed?.PreToolUse?.[0]?.timeoutMs).toBe(5_000);
    expect(parsed?.PreToolUse?.[2]?.enabled).toBe(false);
    expect(parsed?.SessionStart).toHaveLength(1);
    expect(normalizeHookEventName("PostToolUse")).toBe("PostToolUse");
    expect(normalizeHookEventName("unknown")).toBeNull();
    expect(parseHooksConfig({})).toBeNull();
  });

  it("blocks a matching tool with exit code 2 and skips non-matching tools", async () => {
    const dir = tempDir("aivo-hook-block-");
    const script = writeHookScript(
      dir,
      "block",
      `process.stdin.resume();
process.stdin.on("end", () => {
  console.error("lock files are protected");
  process.exit(2);
});`,
    );

    const runner = new HookRunner({
      cwd: dir,
      config: parseHooksConfig({
        PreToolUse: [{ matcher: "write_file", command: nodeCommand(script), timeoutMs: 20_000 }],
      }) ?? {},
    });

    const blocked = await runner.run("PreToolUse", {
      cwd: dir,
      mode: "auto",
      tool: { name: "write_file", args: { path: "package-lock.json" } },
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toContain("lock files are protected");

    const allowed = await runner.run("PreToolUse", {
      cwd: dir,
      mode: "auto",
      tool: { name: "read_file", args: { path: "src/a.ts" } },
    });
    expect(allowed.blocked).toBe(false);
  });

  it("returns additional context and replacement args from JSON stdout", async () => {
    const dir = tempDir("aivo-hook-json-");
    const script = writeHookScript(
      dir,
      "rewrite",
      `let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const payload = JSON.parse(raw);
  process.stdout.write(JSON.stringify({
    decision: "allow",
    args: { ...payload.tool.args, path: "rewritten.ts" },
    additionalContext: "hook rewrote the target path",
  }));
});`,
    );

    const runner = new HookRunner({
      cwd: dir,
      config: parseHooksConfig({
        PreToolUse: [{ command: nodeCommand(script), timeoutMs: 20_000 }],
      }) ?? {},
    });

    const result = await runner.run("PreToolUse", {
      cwd: dir,
      mode: "auto",
      tool: { name: "write_file", args: { path: "original.ts", content: "x" } },
    });
    expect(result.blocked).toBe(false);
    expect(result.args?.path).toBe("rewritten.ts");
    expect(result.additionalContext.join(" ")).toContain("rewrote the target path");
  });

  it("verifies hooks wrap the real tool execution path", async () => {
    const dir = tempDir("aivo-hook-tools-");
    const script = writeHookScript(
      dir,
      "guard",
      `process.stdin.resume();
process.stdin.on("end", () => process.exit(2));`,
    );
    const runner = new HookRunner({
      cwd: dir,
      config: parseHooksConfig({
        PreToolUse: [{ matcher: "write_file", command: nodeCommand(script), timeoutMs: 20_000 }],
      }) ?? {},
    });

    const tools = createToolset({
      cwd: dir,
      mode: "auto",
      checkpoints: new CheckpointManager(),
      todos: [],
      hooks: runner,
      sessionId: "ses_test",
    });
    const result = await tools.execute("write_file", { path: "blocked.ts", content: "nope" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("PreToolUse");

    // Matcher only covers write_file, so reads pass through untouched.
    writeFileSync(join(dir, "allowed.ts"), "ok", "utf8");
    const read = await tools.execute("read_file", { path: "allowed.ts" });
    expect(read.isError).toBeFalsy();
  });

  it("runs in-process plugin hooks and can block", async () => {
    const dir = tempDir("aivo-hook-plugin-");
    const runner = new HookRunner({
      cwd: dir,
      programmatic: [
        {
          event: "PreToolUse",
          matcher: "shell",
          handler: async (payload) => {
            if (String(payload.tool?.args.command).includes("rm -rf")) {
              return { block: "destructive command blocked by plugin" };
            }
          },
        },
      ],
    });
    const blocked = await runner.run("PreToolUse", {
      cwd: dir,
      mode: "auto",
      tool: { name: "shell", args: { command: "rm -rf /" } },
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toContain("blocked by plugin");

    const allowed = await runner.run("PreToolUse", {
      cwd: dir,
      mode: "auto",
      tool: { name: "shell", args: { command: "npm test" } },
    });
    expect(allowed.blocked).toBe(false);
  });

  it("treats a failing hook as a warning, never a hard failure", async () => {
    const dir = tempDir("aivo-hook-fail-");
    const script = writeHookScript(dir, "fail", "process.stdin.resume();\nprocess.stdin.on('end', () => process.exit(3));");
    const warnings: string[] = [];
    const runner = new HookRunner({
      cwd: dir,
      config: parseHooksConfig({
        PostToolUse: [{ command: nodeCommand(script), timeoutMs: 20_000 }],
      }) ?? {},
      onWarning: (message) => warnings.push(message),
    });
    const result = await runner.run("PostToolUse", {
      cwd: dir,
      mode: "auto",
      tool: { name: "edit_file", args: {} },
      result: { output: "ok" },
    });
    expect(result.blocked).toBe(false);
    expect(warnings.join(" ")).toContain("exited with code 3");
  });
});

describe("Custom slash commands", () => {
  it("loads workspace commands, parses frontmatter, and workspace wins on collision", () => {
    const workspace = tempDir("aivo-cmd-ws-");
    const commandDir = join(workspace, ".aivokey", "commands");
    mkdirSync(commandDir, { recursive: true });
    writeFileSync(
      join(commandDir, "review.md"),
      ["---", "description: Review the diff", "argument-hint: <path>", "---", "Review $1 with extra context: $ARGUMENTS"].join("\n"),
      "utf8",
    );
    writeFileSync(join(commandDir, "Bad Name.md"), "ignored", "utf8");

    const commands = loadCustomCommands(workspace);
    const review = commands.find((command) => command.name === "review");
    expect(review?.description).toBe("Review the diff");
    expect(review?.argumentHint).toBe("<path>");
    expect(review?.scope).toBe("workspace");
    expect(commands.some((command) => command.name === "bad name")).toBe(false);

    const rendered = renderCustomCommand(review!, "src/a.ts extra");
    expect(rendered).toBe("Review src/a.ts with extra context: src/a.ts extra");

    const found = findCustomCommand(commands, "/review src/a.ts");
    expect(found?.command.name).toBe("review");
    expect(found?.args).toBe("src/a.ts");
    expect(findCustomCommand(commands, "/unknown x")).toBeNull();
  });
});

describe("Plugin runtime", () => {
  it("loads plugin modules that add tools and hooks", async () => {
    const workspace = tempDir("aivo-plugin-");
    const pluginDir = join(workspace, ".aivokey", "plugins");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "demo.mjs"),
      `export default function plugin(api) {
  api.on("PreToolUse", { matcher: "write_file" }, async ({ tool }) => {
    if (String(tool.args.path).endsWith(".lock")) return { block: "lock files are protected" };
  });
  api.addTool(
    { name: "demo_tool", description: "Demo", parameters: { type: "object", properties: {} } },
    async (_args, ctx) => ({ output: "demo:" + ctx.cwd }),
  );
}`,
      "utf8",
    );

    const runtime = new PluginRuntime({ cwd: workspace });
    await runtime.ensureLoaded();
    expect(runtime.loaded).toContain("demo");
    expect(runtime.errors).toEqual([]);
    expect([...runtime.tools.keys()]).toContain("demo_tool");
    expect(runtime.hooks.some((hook) => hook.event === "PreToolUse")).toBe(true);

    // Plugin tools must be callable through the normal toolset path.
    const extraTools = await runtime.getExtraTools();
    const tools = createToolset({
      cwd: workspace,
      mode: "auto",
      checkpoints: new CheckpointManager(),
      todos: [],
      extraTools,
    });
    expect(tools.specs.map((spec) => spec.name)).toContain("demo_tool");
    const result = await tools.execute("demo_tool", {});
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("demo:");
  });

  it("gates mutating plugin tools in plan mode and requires permission otherwise", async () => {
    const workspace = tempDir("aivo-plugin-gate-");
    const pluginDir = join(workspace, ".aivokey", "plugins");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "tools.mjs"),
      `export default function plugin(api) {
  api.addTool(
    { name: "write_thing", description: "Mutates", parameters: { type: "object", properties: {} } },
    async () => ({ output: "wrote" }),
  );
  api.addTool(
    {
      name: "read_thing",
      description: "Read-only",
      parameters: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
    async () => ({ output: "read" }),
  );
}`,
      "utf8",
    );

    const runtime = new PluginRuntime({ cwd: workspace });
    await runtime.ensureLoaded();
    const extraTools = await runtime.getExtraTools();

    // Plan mode: mutating plugin tools are neither advertised nor executable.
    const planTools = createToolset({
      cwd: workspace,
      mode: "plan",
      checkpoints: new CheckpointManager(),
      todos: [],
      extraTools,
    });
    const planNames = planTools.specs.map((spec) => spec.name);
    expect(planNames).toContain("read_thing");
    expect(planNames).not.toContain("write_thing");
    const planWrite = await planTools.execute("write_thing", {});
    expect(planWrite.isError).toBe(true);

    // Auto mode: mutating plugin tool goes through the permission engine.
    let asked = 0;
    const engine = new PermissionEngine({
      cwd: workspace,
      mode: "safe",
      sandbox: "workspace",
      confirmAction: async () => {
        asked++;
        return true;
      },
    });
    const safeTools = createToolset({
      cwd: workspace,
      mode: "safe",
      checkpoints: new CheckpointManager(),
      todos: [],
      extraTools,
      permissionEngine: engine,
    });
    const allowed = await safeTools.execute("write_thing", {});
    expect(allowed.isError).toBeFalsy();
    expect(allowed.output).toBe("wrote");
    expect(asked).toBe(1);

    // Declining the prompt blocks the plugin tool.
    const denying = createToolset({
      cwd: workspace,
      mode: "safe",
      checkpoints: new CheckpointManager(),
      todos: [],
      extraTools,
      permissionEngine: new PermissionEngine({
        cwd: workspace,
        mode: "safe",
        sandbox: "workspace",
        confirmAction: async () => false,
      }),
    });
    const denied = await denying.execute("write_thing", {});
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("Blocked");
  });

  it("isolates a broken plugin instead of failing the session", async () => {
    const workspace = tempDir("aivo-plugin-bad-");
    const pluginDir = join(workspace, ".aivokey", "plugins");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "broken.mjs"), "export default function plugin( {", "utf8");
    writeFileSync(
      join(pluginDir, "good.mjs"),
      `export default function plugin(api) {
  api.addTool(
    { name: "good_tool", description: "Good", parameters: { type: "object", properties: {} } },
    async () => ({ output: "ok" }),
  );
}`,
      "utf8",
    );

    const runtime = new PluginRuntime({ cwd: workspace });
    await runtime.ensureLoaded();
    expect(runtime.loaded).toContain("good");
    expect(runtime.errors.join(" ")).toContain("broken.mjs");
    expect([...runtime.tools.keys()]).toContain("good_tool");
  });
});
