import { basename, resolve } from "node:path";
import type { PermissionMode } from "./config.js";
import type { NetworkAccess, SandboxMode } from "./sandbox.js";
import { isPathInside, toWorkspaceRelative } from "./path-utils.js";

export type PermissionAction = "allow" | "ask" | "deny";
export type PermissionKind = "read" | "write" | "shell" | "webfetch";

export interface PermissionRuleConfig {
  pattern: string;
  action: PermissionAction;
}

export interface PermissionsConfig {
  read?: PermissionRuleConfig[];
  write?: PermissionRuleConfig[];
  shell?: PermissionRuleConfig[];
  webfetch?: PermissionRuleConfig[];
  defaults?: Partial<Record<PermissionKind, PermissionAction>>;
  allowOutsideWorkspace?: boolean;
  network?: NetworkAccess;
  /**
   * Environment variable name patterns that may be inherited by shell commands
   * and MCP servers. Secret-looking variables (API keys, tokens, passwords) are
   * stripped by default unless listed here, e.g. ["GITHUB_TOKEN", "NPM_TOKEN"].
   */
  env?: string[];
}

export interface PermissionDecision {
  action: PermissionAction;
  reason: string;
}

export interface AuthorizationResult {
  allowed: boolean;
  reason?: string;
}

export type PermissionConfirmResult = boolean | "yes" | "always" | "no";

export interface PermissionEngineOptions {
  cwd: string;
  mode: PermissionMode;
  sandbox: SandboxMode;
  permissions?: PermissionsConfig;
  confirmAction?: (description: string) => Promise<PermissionConfirmResult>;
  /** Whether an OS shell sandbox is actually active for this platform. */
  shellSandboxEnforced?: boolean;
}

const ACTIONS = new Set<PermissionAction>(["allow", "ask", "deny"]);
const KINDS: PermissionKind[] = ["read", "write", "shell", "webfetch"];

export function parsePermissionsConfig(value: unknown): PermissionsConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out: PermissionsConfig = {};

  for (const kind of KINDS) {
    const list = raw[kind];
    if (!Array.isArray(list)) continue;
    const rules: PermissionRuleConfig[] = [];
    for (const row of list) {
      if (typeof row !== "object" || row === null) continue;
      const item = row as Record<string, unknown>;
      if (typeof item.pattern !== "string" || !item.pattern.trim()) continue;
      if (item.action !== "allow" && item.action !== "ask" && item.action !== "deny") continue;
      rules.push({ pattern: item.pattern.trim(), action: item.action });
    }
    if (rules.length > 0) out[kind] = rules;
  }

  const defaults = raw.defaults;
  if (typeof defaults === "object" && defaults !== null && !Array.isArray(defaults)) {
    const parsedDefaults: Partial<Record<PermissionKind, PermissionAction>> = {};
    for (const kind of KINDS) {
      const action = (defaults as Record<string, unknown>)[kind];
      if (typeof action === "string" && ACTIONS.has(action as PermissionAction)) {
        parsedDefaults[kind] = action as PermissionAction;
      }
    }
    if (Object.keys(parsedDefaults).length > 0) out.defaults = parsedDefaults;
  }

  if (typeof raw.allowOutsideWorkspace === "boolean") {
    out.allowOutsideWorkspace = raw.allowOutsideWorkspace;
  }
  if (raw.network === "allow" || raw.network === "deny") {
    out.network = raw.network;
  }
  if (Array.isArray(raw.env)) {
    const env = [
      ...new Set(
        raw.env
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
    if (env.length > 0) out.env = env;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let source = "^";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      source += "\\" + ch;
    } else {
      source += ch;
    }
  }
  return new RegExp(source + "$", "i");
}

function matchesPattern(
  pattern: string,
  subject: string,
  candidates: string[],
): boolean {
  const regex = globToRegExp(pattern);
  return candidates.some((candidate) => regex.test(candidate.replace(/\\/g, "/")));
}

function lastMatchingRule(
  rules: PermissionRuleConfig[] | undefined,
  subject: string,
  candidates: string[],
  kind: PermissionKind,
): PermissionRuleConfig | undefined {
  if (!rules || rules.length === 0) return undefined;
  let match: PermissionRuleConfig | undefined;
  for (const rule of rules) {
    // Shell commands often contain slashes (`rm -rf /tmp`), so '*' must span them.
    const pattern =
      kind === "shell" ? rule.pattern.replace(/(?<!\*)\*(?!\*)/g, "**") : rule.pattern;
    if (matchesPattern(pattern, subject, candidates)) match = rule;
  }
  return match;
}

/**
 * Central permission policy for built-in tools.
 *
 * Explicit config rules win over defaults, but plan mode and read-only sandbox are hard
 * constraints: a rule cannot re-enable writes in those states. `ask` without an
 * interactive `confirmAction` is denied (safe for CI/one-shot runs).
 */
export class PermissionEngine {
  private readonly cwd: string;
  private readonly mode: PermissionMode;
  private readonly sandbox: SandboxMode;
  private readonly permissions: PermissionsConfig;
  private readonly confirmAction?: (description: string) => Promise<PermissionConfirmResult>;
  private readonly shellSandboxEnforced: boolean;
  private readonly sessionAllowed = new Set<string>();

  constructor(opts: PermissionEngineOptions) {
    this.cwd = resolve(opts.cwd);
    this.mode = opts.mode;
    this.sandbox = opts.sandbox;
    this.permissions = opts.permissions ?? {};
    this.confirmAction = opts.confirmAction;
    this.shellSandboxEnforced = opts.shellSandboxEnforced ?? false;
  }

  isWithinWorkspace(target: string): boolean {
    return isPathInside(this.cwd, target);
  }

  evaluate(
    kind: PermissionKind,
    subject: string,
    opts: { absPath?: string; outsideWorkspace?: boolean } = {},
  ): PermissionDecision {
    const absPath = opts.absPath ? resolve(opts.absPath) : undefined;
    const outsideWorkspace =
      opts.outsideWorkspace ?? (absPath ? !this.isWithinWorkspace(absPath) : false);
    const relPath = absPath ? toWorkspaceRelative(this.cwd, absPath) : subject;
    const candidates = absPath
      ? [subject, absPath, relPath, basename(absPath)]
      : [subject];

    // Hard security constraints first.
    if (this.mode === "plan" && (kind === "write" || kind === "shell")) {
      return {
        action: "deny",
        reason: `plan mode is read-only; ${kind} is not allowed`,
      };
    }
    if (this.sandbox === "read-only" && kind === "write") {
      return {
        action: "deny",
        reason: "sandbox=read-only blocks filesystem writes",
      };
    }
    if (this.sandbox === "read-only" && kind === "shell" && !this.shellSandboxEnforced) {
      return {
        action: "deny",
        reason:
          "sandbox=read-only cannot safely run shell commands without an OS sandbox on this platform",
      };
    }
    if (kind === "webfetch" && this.permissions.network === "deny") {
      return { action: "deny", reason: "network access is disabled by permissions.network" };
    }

    const rule = lastMatchingRule(this.permissions[kind], subject, candidates, kind);
    if (rule) {
      return {
        action: rule.action,
        reason: `permission rule '${rule.pattern}' matched ${kind} '${subject}'`,
      };
    }

    const defaultAction = this.permissions.defaults?.[kind];
    if (defaultAction) {
      return {
        action: defaultAction,
        reason: `permissions.defaults.${kind}=${defaultAction}`,
      };
    }

    if (kind === "read") {
      if (!outsideWorkspace) {
        return { action: "allow", reason: "read inside workspace" };
      }
      return {
        action: this.permissions.allowOutsideWorkspace ? "allow" : "ask",
        reason: "read outside workspace",
      };
    }

    if (kind === "write") {
      if (outsideWorkspace) {
        return {
          action: this.permissions.allowOutsideWorkspace ? "allow" : "ask",
          reason: "write outside workspace",
        };
      }
      return {
        action: this.mode === "safe" ? "ask" : "allow",
        reason: `write inside workspace (${this.mode} mode)`,
      };
    }

    if (kind === "shell") {
      return {
        action: this.mode === "safe" ? "ask" : "allow",
        reason: `shell command (${this.mode} mode)`,
      };
    }

    // webfetch
    return {
      action: this.permissions.network === "deny" ? "deny" : "allow",
      reason: "web fetch",
    };
  }

  async authorize(
    kind: PermissionKind,
    subject: string,
    opts: { absPath?: string; outsideWorkspace?: boolean; label?: string } = {},
  ): Promise<AuthorizationResult> {
    const decision = this.evaluate(kind, subject, opts);
    if (decision.action === "allow") return { allowed: true };
    if (decision.action === "deny") {
      return { allowed: false, reason: decision.reason };
    }
    const sessionKey = `${kind}:${opts.absPath ? resolve(opts.absPath) : subject}`;
    if (this.sessionAllowed.has(sessionKey)) {
      return { allowed: true };
    }
    const description = opts.label
      ? `${opts.label} — ${decision.reason}`
      : `${kind}: ${subject} (${decision.reason})`;
    if (!this.confirmAction) {
      return {
        allowed: false,
        reason: `${decision.reason}; confirmation is required but no interactive prompt is available`,
      };
    }
    const approved = await this.confirmAction(description);
    if (approved === true || approved === "yes") {
      return { allowed: true };
    }
    if (approved === "always") {
      this.sessionAllowed.add(sessionKey);
      return { allowed: true };
    }
    return { allowed: false, reason: `user declined ${kind}: ${subject}` };
  }

  describe(): string {
    const lines = [
      `mode=${this.mode} · sandbox=${this.sandbox} · network=${this.permissions.network ?? "allow"} · outsideWorkspace=${this.permissions.allowOutsideWorkspace ? "allow" : "ask"}`,
    ];
    for (const kind of KINDS) {
      const rules = this.permissions[kind];
      if (!rules || rules.length === 0) continue;
      lines.push(
        `${kind}: ${rules.map((rule) => `${rule.pattern}=${rule.action}`).join(", ")}`,
      );
    }
    const defaults = this.permissions.defaults;
    if (defaults && Object.keys(defaults).length > 0) {
      lines.push(
        `defaults: ${Object.entries(defaults)
          .map(([kind, action]) => `${kind}=${action}`)
          .join(", ")}`,
      );
    }
    if (this.permissions.env && this.permissions.env.length > 0) {
      lines.push(`env allow: ${this.permissions.env.join(", ")}`);
    }
    return lines.join("\n");
  }
}
