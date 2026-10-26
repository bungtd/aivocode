import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckpointManager } from "../src/checkpoint.js";
import { createToolset, type TodoItem } from "../src/tools/index.js";

describe("File Checkpoints (/undo) & Coding Tools", () => {
  it("reads files with 1-based line numbers, edits preserving CRLF and stripping accidental line prefixes, and undoes turn changes via CheckpointManager", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-tools-"));
    try {
      const target = join(dir, "sample.ts");
      writeFileSync(target, "const a = 1;\r\nconst b = 2;\r\nexport const sum = a + b;\r\n", "utf8");

      const checkpoints = new CheckpointManager();
      checkpoints.beginTurn("turn_1");

      const todos: TodoItem[] = [];
      const tools = createToolset({
        cwd: dir,
        mode: "auto",
        checkpoints,
        todos,
      });

      const readRes = await tools.execute("read_file", { path: "sample.ts" });
      expect(readRes.isError).toBeFalsy();
      expect(readRes.output).toContain("1: const a = 1;");
      expect(readRes.output).toContain("2: const b = 2;");

      // Model accidentally includes line number prefix "2: " from read_file output
      const editRes = await tools.execute("edit_file", {
        path: "sample.ts",
        oldString: "2: const b = 2;",
        newString: "const b = 42;",
      });
      expect(editRes.isError).toBeFalsy();
      expect(editRes.diff).toBeDefined();
      expect(editRes.diff?.filePath).toBe("sample.ts");
      expect(editRes.diff?.before).toContain("const b = 2;");
      expect(editRes.diff?.after).toContain("const b = 42;");

      const updatedContent = readFileSync(target, "utf8");
      expect(updatedContent).toBe("const a = 1;\r\nconst b = 42;\r\nexport const sum = a + b;\r\n");

      // Also create a brand new file in the same turn
      const writeRes = await tools.execute("write_file", {
        path: "nested/newfile.ts",
        content: "export const created = true;\n",
      });
      expect(writeRes.isError).toBeFalsy();
      expect(existsSync(join(dir, "nested/newfile.ts"))).toBe(true);

      // Now undo the turn!
      const undoSummary = checkpoints.undoLastTurn();
      expect(undoSummary.restoredFiles).toHaveLength(2);
      expect(readFileSync(target, "utf8")).toBe(
        "const a = 1;\r\nconst b = 2;\r\nexport const sum = a + b;\r\n",
      );
      expect(existsSync(join(dir, "nested/newfile.ts"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports glob_files, grep_search, and todo_write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-search-"));
    try {
      writeFileSync(join(dir, "alpha.ts"), "export function greetUser() {\n  return 'hello';\n}\n");
      writeFileSync(join(dir, "beta.ts"), "export const magicNumber = 777;\n");

      const todos: TodoItem[] = [];
      const tools = createToolset({
        cwd: dir,
        mode: "auto",
        checkpoints: new CheckpointManager(),
        todos,
      });

      const globRes = await tools.execute("glob_files", { pattern: "*.ts" });
      expect(globRes.output).toContain("alpha.ts");
      expect(globRes.output).toContain("beta.ts");

      const grepRes = await tools.execute("grep_search", { pattern: "magicNumber" });
      expect(grepRes.output).toContain("beta.ts:1:");
      expect(grepRes.output).toContain("777");

      const todoRes = await tools.execute("todo_write", {
        todos: [
          { id: "1", content: "Inspect codebase", status: "completed" },
          { id: "2", content: "Implement fix", status: "in_progress" },
        ],
      });
      expect(todoRes.isError).toBeFalsy();
      expect(todos).toHaveLength(2);
      expect(todoRes.output).toContain("[x] Inspect codebase");
      expect(todoRes.output).toContain("[~] Implement fix");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces permission modes (blocks mutations in plan mode and prompts in safe mode)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-perm-"));
    try {
      const planTools = createToolset({
        cwd: dir,
        mode: "plan",
        checkpoints: new CheckpointManager(),
        todos: [],
      });

      const blockedWrite = await planTools.execute("write_file", {
        path: "test.txt",
        content: "nope",
      });
      expect(blockedWrite.isError).toBe(true);
      expect(blockedWrite.output).toContain("plan mode");

      const safeTools = createToolset({
        cwd: dir,
        mode: "safe",
        checkpoints: new CheckpointManager(),
        todos: [],
        confirmAction: async () => false,
      });

      const deniedShell = await safeTools.execute("run_shell", { command: "echo hi" });
      expect(deniedShell.isError).toBe(true);
      expect(deniedShell.output).toContain("declined");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
