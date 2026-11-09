import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckpointManager } from "../src/checkpoint.js";
import { createToolset, expandGlobBraces, walkWorkspaceFiles } from "../src/tools/index.js";
import { parseReviewerVerdict } from "../src/workflow-review.js";
import { isReadOnlyQaPrompt } from "../src/context.js";
import { compareVersions } from "../src/update.js";
import { isPrivateOrLocalHost, clientWebFetch } from "../src/web.js";
import {
  createTerminalSanitizer,
  sanitizeTerminalText,
} from "../src/ui/theme.js";
import { saveConfigForWorkspace } from "../src/config.js";
import { SkillRegistry } from "../src/skills.js";
import { SelfLearningMemory } from "../src/memory.js";
import { runCli } from "../src/cli.js";

describe("Hardening: review gate, permissions, glob/gitignore, terminal safety", () => {
  it("fails fast for one-shot runs without an API key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-cli-nokey-"));
    try {
      const lines: string[] = [];
      const code = await runCli(["run", "hello"], {
        cwd: dir,
        globalConfigPath: join(dir, "config.json"),
        env: {},
        writeOut: (line) => lines.push(line),
        fetchFn: async () => {
          throw new Error("network should not be called");
        },
      });
      expect(code).toBe(1);
      expect(lines.join("\n")).toContain("AIVOKEY_API_KEY is not set");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("fails closed when a reviewer returns an unknown verdict", () => {
    expect(parseReviewerVerdict("VERDICT: PASS").passed).toBe(true);
    const unknown = parseReviewerVerdict("VERDICT: FAIL\nThe code has a bug.");
    expect(unknown.passed).toBe(false);
    expect(parseReviewerVerdict("").passed).toBe(false);
  });

  it("detects Indonesian read-only QA prompts without matching unrelated edit requests", () => {
    expect(isReadOnlyQaPrompt("Jangan ubah file apa pun, jelaskan arsitektur proyek ini")).toBe(
      true,
    );
    expect(isReadOnlyQaPrompt("tanpa mengubah file, analisa bug di src/agent.ts")).toBe(true);
    expect(isReadOnlyQaPrompt("Jangan ubah warna tombol, perbaiki layout navbar")).toBe(false);
  });

  it("keeps apply_patch atomic when one hunk does not match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-patch-atomic-"));
    try {
      writeFileSync(join(dir, "app.ts"), "const version = 1;\nconst name = 'aivo';\n", "utf8");
      const tools = createToolset({
        cwd: dir,
        mode: "auto",
        checkpoints: new CheckpointManager(),
        todos: [],
      });
      const res = await tools.execute("apply_patch", {
        patchText: [
          "*** Update File: app.ts",
          "@@",
          "-const version = 1;",
          "+const version = 2;",
          "@@",
          "-const missing = true;",
          "+const missing = false;",
        ].join("\n"),
      });
      expect(res.isError).toBe(true);
      expect(res.output).toContain("No files were changed");
      expect(readFileSync(join(dir, "app.ts"), "utf8")).toContain("const version = 1;");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("rejects an empty edit_file oldString instead of corrupting the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-edit-empty-"));
    try {
      const target = join(dir, "app.ts");
      writeFileSync(target, "const x = 1;\n", "utf8");
      const tools = createToolset({
        cwd: dir,
        mode: "auto",
        checkpoints: new CheckpointManager(),
        todos: [],
      });
      const res = await tools.execute("edit_file", {
        path: "app.ts",
        oldString: "",
        newString: "X",
        replaceAll: true,
      });
      expect(res.isError).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("const x = 1;\n");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("blocks skill_create in plan mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-plan-skill-"));
    try {
      const skills = new SkillRegistry({
        cwd: dir,
        globalSkillsDir: join(dir, "global-skills"),
      });
      const tools = createToolset({
        cwd: dir,
        mode: "plan",
        checkpoints: new CheckpointManager(),
        todos: [],
        skills,
      });
      const res = await tools.execute("skill_create", {
        id: "test-skill",
        name: "Test Skill",
        description: "test",
        body: "body",
      });
      expect(res.isError).toBe(true);
      expect(res.output).toContain("plan mode");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("expands braces in globs and respects .gitignore while walking", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-ignore-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "src", "a.ts"), "export {};\n", "utf8");
      writeFileSync(join(dir, "src", "b.tsx"), "export {};\n", "utf8");
      writeFileSync(join(dir, "dist", "bundle.js"), "x\n", "utf8");
      writeFileSync(join(dir, ".gitignore"), "dist/\n", "utf8");

      const files = walkWorkspaceFiles(dir);
      expect(files).toContain("src/a.ts");
      expect(files).not.toContain("dist/bundle.js");
      expect(expandGlobBraces("src/**/*.{ts,tsx}")).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("blocks SSRF targets in web_fetch before calling fetch", async () => {
    let called = false;
    const mockFetch: typeof fetch = async () => {
      called = true;
      return new Response("ok", { status: 200 });
    };
    await expect(
      clientWebFetch({ url: "http://127.0.0.1:8080/secret", fetchFn: mockFetch }),
    ).rejects.toThrow(/Refusing to fetch local\/private host/);
    expect(called).toBe(false);
    expect(isPrivateOrLocalHost("169.254.169.254")).toBe(true);
    expect(isPrivateOrLocalHost("example.com")).toBe(false);
  });

  it("sanitizes terminal escapes, including sequences split across stream chunks", () => {
    expect(sanitizeTerminalText("hello \x1b]52;c;evil\x07world")).toBe("hello world");
    expect(sanitizeTerminalText("a\x1b[2Jb")).toBe("ab");
    const sanitizer = createTerminalSanitizer();
    expect(sanitizer.push("hi \x1b]52;c;ev")).toBe("hi ");
    expect(sanitizer.push("il\x07 there")).toBe(" there");
  });

  it("compares numeric prerelease identifiers numerically", () => {
    expect(compareVersions("1.0.0-10", "1.0.0-2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10")).toBeLessThan(0);
  });

  it("keeps healthy memory entries when one JSONL line is corrupt", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-memory-corrupt-"));
    try {
      const file = join(dir, "memories.jsonl");
      writeFileSync(
        file,
        [
          JSON.stringify({
            id: "mem_1",
            category: "workflow",
            title: "Use pnpm",
            content: "Prefer pnpm in this repo",
            tags: [],
            projectScope: "global",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            useCount: 1,
          }),
          '{"id":"mem_2","title":',
        ].join("\n") + "\n",
        "utf8",
      );
      const memory = new SelfLearningMemory(file);
      expect(memory.listAll()).toHaveLength(1);
      expect(memory.listAll()[0]?.title).toBe("Use pnpm");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("writes a key to the workspace config only when that key is overridden there", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-config-scope-"));
    try {
      const globalPath = join(dir, "config.json");
      writeFileSync(globalPath, JSON.stringify({ model: "global-model" }), "utf8");
      writeFileSync(
        join(dir, ".aivokey.json"),
        JSON.stringify({ model: "workspace-model" }),
        "utf8",
      );
      saveConfigForWorkspace({ cwd: dir, globalConfigPath: globalPath }, { model: "new-model" });
      expect(JSON.parse(readFileSync(join(dir, ".aivokey.json"), "utf8")).model).toBe("new-model");
      expect(JSON.parse(readFileSync(globalPath, "utf8")).model).toBe("global-model");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
