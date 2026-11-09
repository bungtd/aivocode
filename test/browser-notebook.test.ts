import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { BrowserSession } from "../src/browser.js";
import { findHeadlessBrowserBinary } from "../src/computer-use.js";
import {
  NotebookError,
  cellSource,
  deleteNotebookCell,
  editNotebookCell,
  formatNotebook,
  insertNotebookCell,
  notebookToScript,
  parseNotebook,
  readNotebook,
  serializeNotebook,
} from "../src/notebook.js";

function notebookFixture() {
  return {
    cells: [
      {
        cell_type: "markdown",
        metadata: {},
        source: ["# Demo\n", "Notebook intro"],
      },
      {
        cell_type: "code",
        metadata: {},
        execution_count: 3,
        outputs: [{ output_type: "stream", name: "stdout", text: ["3\n"] }],
        source: ["x = 1\n", "x + 2"],
      },
      {
        cell_type: "code",
        metadata: {},
        execution_count: null,
        outputs: [],
        source: ["%matplotlib inline\n", "print('hi')"],
      },
    ],
    metadata: { kernelspec: { name: "python3" } },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

function tempNotebook(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "aivo-notebook-"));
  const path = join(dir, "demo.ipynb");
  writeFileSync(path, JSON.stringify(notebookFixture(), null, 1), "utf8");
  return { dir, path };
}

describe("Notebook editing", () => {
  it("parses and formats cells with 1-based indices and saved outputs", () => {
    const { dir, path } = tempNotebook();
    try {
      const doc = readNotebook(path);
      expect(doc.cells).toHaveLength(3);
      expect(doc.nbformat).toBe(4);
      const rendered = formatNotebook(doc);
      expect(rendered).toContain("1. [markdown]");
      expect(rendered).toContain("2. [code]");
      expect(rendered).toContain("(1 saved output(s))");
      expect(cellSource(doc.cells[1]!)).toBe("x = 1\nx + 2");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("edits, inserts and deletes cells while preserving notebook structure", () => {
    const { dir, path } = tempNotebook();
    try {
      const message = editNotebookCell(path, { cell: 2, source: "y = 40\ny + 2" });
      expect(message).toContain("Updated cell 2");

      let doc = readNotebook(path);
      expect(cellSource(doc.cells[1]!)).toBe("y = 40\ny + 2");
      // Editing code clears stale execution results.
      expect(doc.cells[1]!.execution_count).toBeNull();
      expect(doc.cells[1]!.outputs).toEqual([]);
      expect(doc.cells[0]!.cell_type).toBe("markdown");

      insertNotebookCell(path, { index: 2, source: "## Section", cellType: "markdown" });
      doc = readNotebook(path);
      expect(doc.cells).toHaveLength(4);
      expect(doc.cells[1]!.cell_type).toBe("markdown");

      deleteNotebookCell(path, 1);
      doc = readNotebook(path);
      expect(doc.cells).toHaveLength(3);
      expect(doc.cells[0]!.cell_type).toBe("markdown");
      expect(cellSource(doc.cells[0]!)).toContain("## Section");
      expect(doc.cells[1]!.cell_type).toBe("code");
      expect(cellSource(doc.cells[1]!)).toBe("y = 40\ny + 2");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("rejects out-of-range cells and invalid notebook JSON", () => {
    const { dir, path } = tempNotebook();
    try {
      expect(() => editNotebookCell(path, { cell: 9, source: "x" })).toThrow(NotebookError);
      expect(() => deleteNotebookCell(path, 0)).toThrow(NotebookError);
      expect(() => insertNotebookCell(path, { index: 99, source: "x" })).toThrow(NotebookError);

      const broken = join(dir, "broken.ipynb");
      writeFileSync(broken, "{not json", "utf8");
      expect(() => parseNotebook(readFileSync(broken, "utf8"))).toThrow(/Invalid notebook JSON/);
      expect(() => parseNotebook(JSON.stringify({ cells: "nope" }))).toThrow(/cells/);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("round-trips metadata and drops magic commands from runnable scripts", () => {
    const { dir, path } = tempNotebook();
    try {
      const doc = readNotebook(path);
      const roundTripped = parseNotebook(serializeNotebook(doc));
      expect(roundTripped.metadata).toEqual(doc.metadata);
      expect(roundTripped.nbformat_minor).toBe(5);

      const script = notebookToScript(doc);
      expect(script).toContain("x = 1");
      expect(script).not.toContain("%matplotlib");
      expect(script).toContain("print('hi')");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

const browserBinary = findHeadlessBrowserBinary();
const describeBrowser = browserBinary ? describe : describe.skip;

describeBrowser("Browser automation (Chrome DevTools Protocol)", () => {
  it("navigates a local page, reads the DOM, interacts, and captures a screenshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-browser-test-"));
    const server = createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html>
<html><head><title>Browser Fixture</title></head>
<body>
  <h1>Hello from fixture</h1>
  <a href="/about">About</a>
  <button id="increment" onclick="document.getElementById('count').textContent = String(Number(document.getElementById('count').textContent) + 1)">Increment</button>
  <span id="count">0</span>
  <input id="name" placeholder="Your name" />
  <div id="output"></div>
  <script>
    const input = document.getElementById("name");
    input.addEventListener("input", () => {
      document.getElementById("output").textContent = "Hello " + input.value;
      console.log("typed", input.value);
    });
  </script>
</body></html>`);
        return;
      }
      if (req.url === "/about") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><head><title>About</title></head><body><p>About page</p></body></html>");
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const session = new BrowserSession({ cwd: dir, network: "allow" });
    try {
      const opened = await session.open(`http://127.0.0.1:${port}/`);
      expect(opened.isError).toBeFalsy();
      expect(opened.snapshot?.title).toBe("Browser Fixture");
      expect(opened.snapshot?.text).toContain("Hello from fixture");
      expect(opened.snapshot?.links.some((link) => link.href.endsWith("/about"))).toBe(true);
      expect(opened.snapshot?.buttons.some((button) => button.text === "Increment")).toBe(true);
      expect(opened.snapshot?.inputs.some((input) => input.placeholder === "Your name")).toBe(true);

      const clicked = await session.click("#increment");
      expect(clicked.isError).toBeFalsy();
      const afterClick = await session.snapshot();
      expect(afterClick.text).toContain("1");

      const filled = await session.fill("#name", "Aivo");
      expect(filled.isError).toBeFalsy();
      const afterFill = await session.snapshot();
      expect(afterFill.text).toContain("Hello Aivo");
      expect(afterFill.console.some((entry) => entry.text.includes("typed Aivo"))).toBe(true);

      const waited = await session.waitFor("#output", 5_000);
      expect(waited.isError).toBeFalsy();

      const evaluated = await session.evaluateExpression("document.title");
      expect(evaluated.output).toBe("Browser Fixture");

      const shot = await session.screenshot(false);
      expect(shot.isError).toBeFalsy();
      expect(shot.screenshot?.width).toBeGreaterThan(0);

      // Navigation to a private host is blocked under network deny.
      const denied = new BrowserSession({ cwd: dir, network: "deny" });
      try {
        const blocked = await denied.open("https://example.com");
        expect(blocked.isError).toBe(true);
        expect(blocked.output).toContain("Network access is denied");
      } finally {
        denied.close();
      }
    } finally {
      session.close();
      server.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 90_000);

  it("reports a clear error for missing selectors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-browser-less-"));
    const session = new BrowserSession({ cwd: dir, network: "allow" });
    try {
      const page = join(dir, "index.html");
      writeFileSync(page, "<html><body><p>plain</p></body></html>", "utf8");
      const opened = await session.open(page);
      expect(opened.isError).toBeFalsy();
      const missing = await session.click("#does-not-exist");
      expect(missing.isError).toBe(true);
      expect(missing.output).toContain("No clickable element matched");
      const missingFill = await session.fill("#nope", "x");
      expect(missingFill.isError).toBe(true);
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60_000);
});
