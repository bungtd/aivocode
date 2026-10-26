import { describe, expect, it } from "vitest";
import {
  renderHeaderBanner,
  renderStatusBar,
  renderToolCallCard,
  renderTodoBoard,
  stripAnsi,
} from "../src/ui/theme.js";
import {
  renderUnifiedDiff,
  renderTerminalMarkdown,
} from "../src/ui/markdown.js";
import { completeInputToken } from "../src/ui/select.js";

describe("Professional TUI components (Banner, Status Bar, Colored Unified Diff, Markdown, Autocomplete)", () => {
  it("renders the professional header banner and bottom telemetry status bar", () => {
    const banner = stripAnsi(
      renderHeaderBanner({
        version: "0.2.0",
        cwd: "C:/Dev/Projects/my-app",
        gitBranch: "main*",
        gatewayUrl: "https://api.aivokey.dev",
        model: "deepseek-v4-pro",
        fastModel: "glm-5.3",
        wire: "chat",
        effort: "high",
        mode: "auto",
        sessionId: "ses_12345",
        keyStatus: {
          mode: "plan",
          balanceMicro: 4_250_000n,
          fallbackEnabled: true,
          freeTokens: [{ model: "glm-5.3", remainingTokens: 180_000n }],
          purchasedTokens: [],
          plan: { name: "Builder Pro", allowanceMode: "per_model" },
          models: [],
          global: null,
        },
      }),
    );

    expect(banner).toContain("AIVO CODE");
    expect(banner).toContain("deepseek-v4-pro");
    expect(banner).toContain("Builder Pro");
    expect(banner).toContain("$4.25");
    expect(banner).toContain("main*");

    const statusBar = stripAnsi(
      renderStatusBar({
        mode: "auto",
        model: "deepseek-v4-pro",
        effort: "high",
        wire: "chat",
        usedContextTokens: 14_200,
        maxContextTokens: 256_000,
        cacheHitPct: 91,
        sessionCostMicro: 18_500n,
        balanceMicro: 4_250_000n,
        gitBranch: "main*",
      }),
    );

    expect(statusBar).toContain("AUTO");
    expect(statusBar).toContain("deepseek-v4-pro");
    expect(statusBar).toContain("high");
    expect(statusBar).toContain("14.2K/256K");
    expect(statusBar).toContain("91%");
    expect(statusBar).toContain("$0.0185");
  });

  it("generates a line-numbered unified diff for file edits", () => {
    const before = [
      "export function add(a: number, b: number) {",
      "  return a - b;",
      "}",
    ].join("\n");

    const after = [
      "export function add(a: number, b: number) {",
      "  return a + b;",
      "}",
    ].join("\n");

    const diff = stripAnsi(renderUnifiedDiff("src/math.ts", before, after));
    expect(diff).toContain("src/math.ts");
    expect(diff).toContain("-   return a - b;");
    expect(diff).toContain("+   return a + b;");
    expect(diff).toContain("+1 -1");
  });

  it("renders tool call cards and todo progress boards cleanly", () => {
    const card = stripAnsi(
      renderToolCallCard({
        name: "edit_file",
        args: { path: "src/math.ts" },
        status: "ok",
        durationMs: 18,
        summary: "Edited src/math.ts (+1 -1)",
      }),
    );
    expect(card).toContain("Edit");
    expect(card).toContain("src/math.ts");
    expect(card).toContain("18ms");

    const board = stripAnsi(
      renderTodoBoard([
        { id: "1", content: "Inspect gateway routes", status: "completed" },
        { id: "2", content: "Implement TUI diff viewer", status: "in_progress" },
        { id: "3", content: "Run vitest suite", status: "pending" },
      ]),
    );
    expect(board).toContain("Tasks (1/3)");
    expect(board).toContain("✓ Inspect gateway routes");
    expect(board).toContain("▸ Implement TUI diff viewer");
    expect(board).toContain("○ Run vitest suite");
  });

  it("renders terminal markdown with code blocks, headings, and inline formatting", () => {
    const md = [
      "# Summary",
      "Updated `src/router.ts` with **sticky session** support:",
      "```ts",
      "const header = req.headers.get('x-opencode-session');",
      "```",
    ].join("\n");

    const rendered = stripAnsi(renderTerminalMarkdown(md));
    expect(rendered).toContain("Summary");
    expect(rendered).toContain("src/router.ts");
    expect(rendered).toContain("const header = req.headers.get('x-opencode-session');");
  });

  it("autocompletes slash commands and @file mentions on Tab", () => {
    const slashCompleted = completeInputToken("/mo", ["src/index.ts", "README.md"]);
    expect(slashCompleted.matches).toContain("/model");
    expect(slashCompleted.matches).toContain("/models");
    expect(slashCompleted.matches).toContain("/mode");

    const fileCompleted = completeInputToken("Check @src/in", ["src/index.ts", "src/cli.ts", "README.md"]);
    expect(fileCompleted.completedLine).toBe("Check @src/index.ts ");
  });
});
