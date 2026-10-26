import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSystemPrompt,
  expandFileMentions,
  compactConversation,
  estimateConversationTokens,
} from "../src/context.js";
import { SessionStore } from "../src/session.js";
import type { ChatMessage } from "../src/protocol.js";

describe("Context manager, @file mentions, compaction, and JSONL sessions", () => {
  it("builds a deterministic cache-friendly system prompt including AGENTS.md and expands @file mentions", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-ctx-"));
    try {
      writeFileSync(join(dir, "AGENTS.md"), "Always use pnpm test.");
      writeFileSync(join(dir, "src-hello.ts"), "export const greeting = 'Halo AivoKey';\n");

      const p1 = buildSystemPrompt(dir, "auto");
      const p2 = buildSystemPrompt(dir, "auto");
      // Must be byte-for-byte identical across calls so prompt cache is never invalidated
      expect(p1).toBe(p2);
      expect(p1).toContain("Always use pnpm test.");

      const expanded = expandFileMentions("Please review @src-hello.ts#1-1 now", dir);
      expect(expanded).toContain('<file path="src-hello.ts" lines="1-1">');
      expect(expanded).toContain("1: export const greeting = 'Halo AivoKey';");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compacts bulky tool outputs and older turns while keeping recent turns intact", () => {
    const bigOutput = "line of output\n".repeat(1500);
    const messages: ChatMessage[] = [
      { role: "user", content: "Find all files and inspect them" },
      {
        role: "assistant",
        content: "Running search",
        toolCalls: [{ id: "c1", name: "grep_search", arguments: { pattern: "foo" }, rawArguments: "{}" }],
      },
      { role: "tool", toolCallId: "c1", content: bigOutput },
      { role: "assistant", content: "Found matches in foo.ts" },
      { role: "user", content: "Now update bar.ts" },
      { role: "assistant", content: "Updated bar.ts" },
    ];

    const beforeTokens = estimateConversationTokens("system", messages);
    const compacted = compactConversation(messages, { keepRecentMessages: 2 });
    const afterTokens = estimateConversationTokens("system", compacted);

    expect(afterTokens).toBeLessThan(beforeTokens / 3);
    expect(compacted[compacted.length - 1]?.content).toBe("Updated bar.ts");
    expect(compacted[0]?.content).toContain("[Compacted Session Summary]");
  });

  it("persists, lists, loads, and forks JSONL sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-sess-"));
    try {
      const store = new SessionStore(dir);
      const session = store.createSession({
        model: "deepseek-v4-pro",
        wire: "chat",
        cwd: "/workspace",
      });

      expect(session.id).toMatch(/^ses_/);
      session.messages.push({ role: "user", content: "Hello" });
      session.messages.push({ role: "assistant", content: "Hi there!" });
      store.saveSession(session);

      const loaded = store.loadSession(session.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.messages).toHaveLength(2);

      const forked = store.forkSession(session.id);
      expect(forked).not.toBeNull();
      expect(forked!.id).not.toBe(session.id);
      expect(forked!.messages).toHaveLength(2);

      const list = store.listSessions();
      expect(list.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
