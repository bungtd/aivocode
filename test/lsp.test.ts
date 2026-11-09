import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { LspManager, documentUriKey } from "../src/lsp.js";
import { createToolset } from "../src/tools/index.js";
import { CheckpointManager } from "../src/checkpoint.js";
import { parseLspServerConfig } from "../src/config.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/lsp-server.mjs", import.meta.url));
const managers: LspManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose();
  // Windows keeps the language-server child's file handles open briefly after
  // dispose(); yielding here keeps rmSync from racing the OS.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

function createManager(cwd: string): LspManager {
  const manager = new LspManager({
    cwd,
    servers: {
      mock: {
        command: "node",
        args: [FIXTURE],
        extensions: [".ts"],
        languageId: "typescript",
        timeoutMs: 10_000,
      },
    },
  });
  managers.push(manager);
  return manager;
}

describe("LSP code intelligence", () => {
  it("parses LSP server configuration", () => {
    const config = parseLspServerConfig({
      command: "typescript-language-server",
      args: ["--stdio"],
      extensions: ["ts", ".tsx", "ts"],
      languageId: "typescript",
      timeoutMs: 5_000,
    });
    expect(config?.extensions).toEqual([".ts", ".tsx"]);
    expect(config?.languageId).toBe("typescript");
    expect(parseLspServerConfig({ args: ["--stdio"] })).toBeNull();
    expect(parseLspServerConfig({ command: "x", extensions: [] })?.extensions).toBeUndefined();
  });

  it("keys diagnostics by normalized document URI so server URI variants match", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-lsp-uri-"));
    try {
      const file = join(dir, "a.ts");
      const plain = `file:///${file.replace(/\\/g, "/")}`;
      const variant = plain.replace(/^file:\/\/([A-Za-z]):/, (_m, drive: string) => {
        return `file:///${drive.toLowerCase()}%3A`;
      });
      expect(documentUriKey(variant)).toBe(documentUriKey(plain));
      expect(documentUriKey("untitled:Untitled-1")).toBe("untitled:Untitled-1");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("auto-detects installed language servers when lspServers is not configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-lsp-auto-"));
    const binDir = mkdtempSync(join(tmpdir(), "aivo-lsp-bin-"));
    const previousPath = process.env.PATH;
    try {
      const isWin = process.platform === "win32";
      const shim = join(binDir, isWin ? "typescript-language-server.cmd" : "typescript-language-server");
      if (isWin) {
        writeFileSync(shim, `@echo off\r\nif "%1"=="--version" (echo 4.0.0& exit /b 0)\r\nnode "${FIXTURE}" %*\r\n`, "utf8");
      } else {
        writeFileSync(
          shim,
          `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 4.0.0; exit 0; fi\nexec node "${FIXTURE}" "$@"\n`,
          { mode: 0o755 },
        );
      }
      process.env.PATH = `${binDir}${isWin ? ";" : ":"}${previousPath ?? ""}`;

      const manager = new LspManager({ cwd: dir });
      managers.push(manager);
      const statuses = manager.getStatuses();
      expect(statuses.map((status) => status.name)).toContain("typescript");
      expect(statuses.find((status) => status.name === "typescript")?.extensions).toContain(".ts");
      expect(manager.getServerForFile(join(dir, "a.ts"))).toBe("typescript");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(binDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("starts a stdio server and exposes diagnostics, hover, definitions, references and symbols", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-lsp-"));
    try {
      const file = join(dir, "a.ts");
      writeFileSync(file, "export function mockFn() {\n  return 1;\n}\n", "utf8");
      const manager = createManager(dir);
      expect(manager.hasServers()).toBe(true);
      expect(manager.formatStatus()).toContain("mock");

      const diagnostics = await manager.diagnostics(file);
      expect(diagnostics.server).toBe("mock");
      expect(diagnostics.diagnostics[0]?.message).toContain("mock diagnostic");

      const hover = await manager.hover(file, { line: 0, character: 9 });
      expect(hover.hover?.contents).toContain("mock hover");

      const definition = await manager.definition(file, { line: 0, character: 9 });
      expect(definition.locations).toHaveLength(1);
      expect(definition.locations[0]?.range.start.line).toBe(1);

      const references = await manager.references(file, { line: 0, character: 9 });
      expect(references.locations).toHaveLength(2);

      const symbols = await manager.documentSymbols(file);
      expect(symbols.symbols[0]?.name).toBe("mockFn");

      const workspace = await manager.workspaceSymbols("mock");
      expect(workspace[0]?.symbols[0]?.name).toBe("mockFn");
      expect(manager.getStatuses()[0]?.state).toBe("ready");
      manager.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("registers lsp_* tools and formats results for the agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-lsp-tools-"));
    try {
      const file = join(dir, "a.ts");
      writeFileSync(file, "export function mockFn() {\n  return 1;\n}\n", "utf8");
      const manager = createManager(dir);
      const tools = createToolset({
        cwd: dir,
        mode: "auto",
        checkpoints: new CheckpointManager(),
        todos: [],
        lspManager: manager,
      });

      const specs = tools.specs;
      expect(specs.map((spec) => spec.name)).toContain("lsp_diagnostics");
      expect(specs.map((spec) => spec.name)).toContain("lsp_hover");

      const diagnostics = await tools.execute("lsp_diagnostics", { path: "a.ts" });
      expect(diagnostics.isError).toBeFalsy();
      expect(diagnostics.output).toContain("a.ts:1:1");
      expect(diagnostics.output).toContain("mock diagnostic");

      const hover = await tools.execute("lsp_hover", { path: "a.ts", line: 1, character: 10 });
      expect(hover.isError).toBeFalsy();
      expect(hover.output).toContain("mock hover");

      const definition = await tools.execute("lsp_definition", {
        path: "a.ts",
        line: 1,
        character: 10,
      });
      expect(definition.isError).toBeFalsy();
      expect(definition.output).toContain("a.ts:2:3");

      const references = await tools.execute("lsp_references", {
        path: "a.ts",
        line: 1,
        character: 10,
      });
      expect(references.isError).toBeFalsy();
      expect(references.output).toContain("2 location(s)");

      const symbols = await tools.execute("lsp_document_symbols", { path: "a.ts" });
      expect(symbols.isError).toBeFalsy();
      expect(symbols.output).toContain("function mockFn");

      const workspace = await tools.execute("lsp_workspace_symbols", { query: "mock" });
      expect(workspace.isError).toBeFalsy();
      expect(workspace.output).toContain("mockFn");

      // Edits automatically append LSP diagnostics so the model sees new errors.
      const edit = await tools.execute("edit_file", {
        path: "a.ts",
        oldString: "return 1;",
        newString: "return 2;",
      });
      expect(edit.isError).toBeFalsy();
      expect(edit.output).toContain("LSP diagnostics");
      expect(edit.output).toContain("mock diagnostic");
      manager.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
