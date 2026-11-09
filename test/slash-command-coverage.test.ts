import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SLASH_COMMANDS, completeInputToken } from "../src/ui/select.js";
import { computeComposerSuggestions, scrollWindow } from "../src/ui/composer.js";
import { SessionStore } from "../src/session.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = process.cwd();

describe("slash command discoverability", () => {
  it("lists every command that the REPL actually handles", () => {
    const repl = readFileSync(join(root, "src/repl.ts"), "utf8");
    const handled = new Set<string>();
    for (const match of repl.matchAll(/case "(\/[a-z0-9-]+)"/g)) {
      const cmd = match[1];
      if (typeof cmd === "string") handled.add(cmd);
    }
    const listed = new Set<string>(SLASH_COMMANDS.map((s) => s.cmd));
    const missing = [...handled].filter((cmd) => !listed.has(cmd)).sort();
    expect(missing).toEqual([]);
  });

  it("has no duplicate or dangling palette entries", () => {
    const seen = new Set<string>();
    for (const entry of SLASH_COMMANDS) {
      expect(seen.has(entry.cmd), `duplicate ${entry.cmd}`).toBe(false);
      seen.add(entry.cmd);
      expect(entry.description.trim().length).toBeGreaterThan(0);
    }
    const repl = readFileSync(join(root, "src/repl.ts"), "utf8");
    const dangling = SLASH_COMMANDS.map((s) => s.cmd).filter(
      (cmd) => !repl.includes(`case "${cmd}"`),
    );
    expect(dangling).toEqual([]);
  });

  it("completes a slash command by prefix", () => {
    const res = completeInputToken("/sess", []);
    expect(res.matches).toContain("/sessions");
  });
});

describe("slash palette is not truncated", () => {
  it("returns every match instead of the first 8", () => {
    const suggestions = computeComposerSuggestions("/", []);
    expect(suggestions.kind).toBe("slash");
    expect(suggestions.items.length).toBe(SLASH_COMMANDS.length);
    expect(suggestions.items.length).toBeGreaterThan(8);
  });

  it("ranks prefix matches first", () => {
    const suggestions = computeComposerSuggestions("/mo", []);
    expect(suggestions.items[0]?.label).toBe("/mode");
    const labels = suggestions.items.map((i) => i.label);
    expect(labels).toContain("/model");
    expect(labels).toContain("/memory");
  });

  it("scrolls the viewport to keep the selection visible", () => {
    const total = 50;
    expect(scrollWindow(total, 0, 10)).toEqual({ start: 0, end: 10 });
    const mid = scrollWindow(total, 25, 10);
    expect(mid.start).toBeLessThanOrEqual(25);
    expect(mid.end).toBeGreaterThan(25);
    const last = scrollWindow(total, 49, 10);
    expect(last.end).toBe(50);
    expect(last.start).toBe(40);
  });
});

describe("session store switching", () => {
  it("lists, loads, forks and deletes sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-sessions-"));
    try {
      const store = new SessionStore(dir);
      const first = store.createSession({ model: "m1", wire: "chat", cwd: root });
      first.messages.push({ role: "user", content: "hello" });
      store.saveSession(first);

      const second = store.createSession({ model: "m2", wire: "chat", cwd: root });
      store.saveSession(second);

      const list = store.listSessions(10);
      expect(list.map((s) => s.id).sort()).toEqual([first.id, second.id].sort());

      const loaded = store.loadSession(first.id);
      expect(loaded?.messages[0]?.content).toBe("hello");
      expect(loaded?.model).toBe("m1");

      const forked = store.forkSession(first.id);
      expect(forked?.parentSessionId).toBe(first.id);
      expect(forked?.messages).toHaveLength(1);

      expect(store.deleteSession(second.id)).toBe(true);
      expect(store.loadSession(second.id)).toBeNull();
      expect(store.deleteSession("ses_missing")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("keeps sessions isolated so resuming one does not leak the other's history", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-sessions-iso-"));
    try {
      const store = new SessionStore(dir);
      const a = store.createSession({ model: "m1", wire: "chat", cwd: root });
      a.messages.push({ role: "user", content: "alpha" });
      store.saveSession(a);

      const b = store.createSession({ model: "m2", wire: "chat", cwd: root });
      b.messages.push({ role: "user", content: "beta" });
      store.saveSession(b);

      // Reloading must return exactly that session's messages, not the union.
      expect(store.loadSession(a.id)?.messages.map((m) => m.content)).toEqual(["alpha"]);
      expect(store.loadSession(b.id)?.messages.map((m) => m.content)).toEqual(["beta"]);
      expect(store.loadSession(a.id)?.model).toBe("m1");
      expect(store.loadSession(b.id)?.model).toBe("m2");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
