/**
 * Drop-in plugin runtime.
 *
 * Plugins are ES modules discovered in `.aivokey/plugins/*.mjs` (workspace) and
 * `~/.aivokey/plugins/*.mjs` (user). The default export receives a small API:
 *
 *   export default function plugin(api) {
 *     api.on("PreToolUse", { matcher: "write_file" }, async ({ tool }) => {
 *       if (String(tool.args.path).endsWith(".lock")) {
 *         return { block: "Do not edit lock files" };
 *       }
 *     });
 *     api.addTool(
 *       {
 *         name: "project_info",
 *         description: "Print project metadata",
 *         parameters: { type: "object", properties: {} },
 *       },
 *       async (_args, ctx) => ({ output: `cwd=${ctx.cwd}` }),
 *     );
 *   }
 *
 * Plugins run in-process with full Node privileges — the same trust model as
 * other coding harnesses. Only install plugins you have reviewed.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { HookEvent, HookResult, HookRunPayload } from "./hooks.js";
import { HOOK_EVENTS } from "./hooks.js";
import type { ToolExecutionResult } from "./tools/index.js";
import type { ToolSpec } from "./protocol.js";

export interface PluginContext {
  cwd: string;
  sessionId?: string;
  mode: string;
}

export type PluginHookHandler = (
  payload: HookRunPayload,
) => Promise<
  | void
  | { block?: string; reason?: string; additionalContext?: string | string[] }
  | HookResult
>;

export interface PluginTool {
  spec: ToolSpec;
  handler: (args: Record<string, unknown>, ctx: PluginContext) => Promise<ToolExecutionResult>;
}

export interface ProgrammaticHook {
  event: HookEvent;
  matcher?: string;
  handler: PluginHookHandler;
}

export interface PluginApi {
  on(event: string, handler: PluginHookHandler): void;
  on(event: string, options: { matcher?: string }, handler: PluginHookHandler): void;
  addTool(
    spec: ToolSpec,
    handler: (args: Record<string, unknown>, ctx: PluginContext) => Promise<ToolExecutionResult>,
  ): void;
  log(message: string): void;
}

interface PluginModule {
  default?: unknown;
}

export class PluginRuntime {
  readonly tools = new Map<string, PluginTool>();
  readonly hooks: ProgrammaticHook[] = [];
  readonly errors: string[] = [];
  readonly loaded: string[] = [];
  private loadedOnce = false;
  private loadPromise: Promise<void> | null = null;

  constructor(
    private readonly opts: {
      cwd: string;
      onNotice?: (message: string) => void;
    },
  ) {}

  static pluginDirectories(cwd: string): string[] {
    return [join(cwd, ".aivokey", "plugins"), join(homedir(), ".aivokey", "plugins")];
  }

  /** Loads plugin modules once. Safe to call repeatedly (subagents share the runtime). */
  async ensureLoaded(): Promise<void> {
    if (this.loadedOnce) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadAll();
    try {
      await this.loadPromise;
    } finally {
      this.loadedOnce = true;
    }
  }

  private async loadAll(): Promise<void> {
    const seen = new Set<string>();
    for (const dir of PluginRuntime.pluginDirectories(this.opts.cwd)) {
      if (!existsSync(dir)) continue;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!/\.(?:mjs|js)$/i.test(entry)) continue;
        const name = entry.replace(/\.(?:mjs|js)$/i, "");
        if (seen.has(name)) continue;
        seen.add(name);
        const pluginPath = resolve(dir, entry);
        const api = new PluginApiImpl(name, this.opts.cwd);
        try {
          const module = (await import(pathToFileURL(pluginPath).href)) as PluginModule;
          if (typeof module.default !== "function") {
            this.errors.push(`${pluginPath}: default export must be a function`);
            continue;
          }
          await (module.default as (api: PluginApi) => unknown)(api);
          for (const tool of api.tools.values()) {
            if (this.tools.has(tool.spec.name)) {
              this.errors.push(`${pluginPath}: duplicate tool '${tool.spec.name}' ignored`);
              continue;
            }
            this.tools.set(tool.spec.name, tool);
          }
          this.hooks.push(...api.hooks);
          this.loaded.push(name);
          for (const line of api.logs) this.opts.onNotice?.(line);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.errors.push(`${pluginPath}: ${message}`);
          this.opts.onNotice?.(`[plugin:${name}] failed to load: ${message}`);
        }
      }
    }
  }

  /** Tool specs ready for `createToolset({ extraTools })`. */
  async getExtraTools(): Promise<
    Array<{ spec: ToolSpec; handler: (args: Record<string, unknown>) => Promise<ToolExecutionResult> }>
  > {
    await this.ensureLoaded();
    return [...this.tools.values()].map((tool) => ({
      spec: tool.spec,
      handler: (args: Record<string, unknown>) =>
        tool.handler(args, {
          cwd: this.opts.cwd,
          sessionId: this.sessionId,
          mode: this.mode,
        }),
    }));
  }

  sessionId: string | undefined;
  mode = "auto";

  formatStatus(): string {
    if (this.loaded.length === 0 && this.errors.length === 0) {
      return [
        "No plugins loaded.",
        "",
        "Drop an ES module into .aivokey/plugins/<name>.mjs:",
        "  export default function plugin(api) {",
        '    api.on("PreToolUse", { matcher: "write_file" }, async ({ tool }) => {',
        '      if (String(tool.args.path).endsWith(".lock")) return { block: "lock files are protected" };',
        "    });",
        '    api.addTool({ name: "hello", description: "Say hi", parameters: { type: "object", properties: {} } },',
        '      async () => ({ output: "hi" }));',
        "  }",
      ].join("\n");
    }
    const lines: string[] = [];
    if (this.loaded.length > 0) {
      lines.push(`Plugins: ${this.loaded.join(", ")}`);
      if (this.tools.size > 0) {
        lines.push(`Plugin tools: ${[...this.tools.keys()].join(", ")}`);
      }
      if (this.hooks.length > 0) {
        lines.push(
          `Plugin hooks: ${this.hooks
            .map((hook) => `${hook.event}${hook.matcher ? `(${hook.matcher})` : ""}`)
            .join(", ")}`,
        );
      }
    }
    if (this.errors.length > 0) {
      lines.push("Plugin errors:");
      for (const error of this.errors) lines.push(`  - ${error}`);
    }
    return lines.join("\n");
  }
}

class PluginApiImpl implements PluginApi {
  readonly hooks: ProgrammaticHook[] = [];
  readonly tools = new Map<string, PluginTool>();
  readonly logs: string[] = [];

  constructor(
    private readonly pluginName: string,
    private readonly cwd: string,
  ) {}

  on(
    event: string,
    handlerOrOptions: PluginHookHandler | { matcher?: string },
    maybeHandler?: PluginHookHandler,
  ): void {
    const handler =
      typeof handlerOrOptions === "function" ? handlerOrOptions : maybeHandler;
    if (typeof handler !== "function") {
      this.logs.push(`[plugin:${this.pluginName}] 'on' requires a handler function`);
      return;
    }
    const normalized = normalizeEvent(event);
    if (!normalized) {
      this.logs.push(`[plugin:${this.pluginName}] unknown hook event '${event}'`);
      return;
    }
    const matcher =
      typeof handlerOrOptions === "object" && handlerOrOptions?.matcher
        ? handlerOrOptions.matcher
        : undefined;
    this.hooks.push({ event: normalized, matcher, handler });
  }

  addTool(
    spec: ToolSpec,
    handler: (args: Record<string, unknown>, ctx: PluginContext) => Promise<ToolExecutionResult>,
  ): void {
    if (!spec?.name || !/^[a-zA-Z0-9_-]{1,64}$/.test(spec.name)) {
      this.logs.push(`[plugin:${this.pluginName}] invalid tool name '${String(spec?.name)}'`);
      return;
    }
    if (typeof handler !== "function") {
      this.logs.push(`[plugin:${this.pluginName}] tool '${spec.name}' has no handler`);
      return;
    }
    if (this.tools.has(spec.name)) {
      this.logs.push(`[plugin:${this.pluginName}] duplicate tool '${spec.name}' ignored`);
      return;
    }
    this.tools.set(spec.name, { spec, handler });
  }

  log(message: string): void {
    this.logs.push(`[plugin:${this.pluginName}] ${String(message)}`);
  }

  get resolvedCwd(): string {
    return this.cwd;
  }
}

function normalizeEvent(raw: string): HookEvent | null {
  const compact = raw.replace(/[-_\s]/g, "").toLowerCase();
  return HOOK_EVENTS.find((event) => event.toLowerCase() === compact) ?? null;
}
