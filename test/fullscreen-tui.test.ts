import { describe, expect, it } from "vitest";
import { renderFullScreenViewport, type FullScreenTuiState } from "../src/ui/fullscreen.js";
import { stripAnsi } from "../src/ui/theme.js";

function createSampleState(overrides: Partial<FullScreenTuiState> = {}): FullScreenTuiState {
  return {
    cols: 120,
    rows: 32,
    showSidebar: true,
    version: "0.4.0",
    cwd: "C:/Dev/Projects/aivokey-cli",
    gitBranch: "main",
    gatewayUrl: "https://api.aivokey.dev",
    model: "deepseek-v4-flash",
    fastModel: "glm-5.3-flash",
    wire: "chat",
    effort: "off",
    mode: "auto",
    sessionId: "ses_fullscreen_01",
    usedContextTokens: 1850,
    maxContextTokens: 1_000_000,
    cacheHitPct: 85,
    sessionCostMicro: 3200n,
    balanceMicro: 9_929_530_000n,
    keyStatus: null,
    todos: [
      { id: "1", content: "Build full-screen TUI", status: "in_progress" },
    ],
    modifiedFiles: ["src/ui/fullscreen.ts"],
    transcriptLines: [
      "❯ Halo, analisa struktur proyek ini",
      "● Glob(**/*.ts) — 12ms",
      "◆ deepseek-v4-flash",
      "  Proyek ini memiliki modul agent, protocol, dan TUI.",
    ],
    scrollOffset: 0,
    busyLabel: null,
    buffer: "",
    cursorPos: 0,
    suggestions: { kind: "none", query: "", items: [] },
    selectedSuggestionIdx: 0,
    modal: null,
    notice: null,
    ...overrides,
  };
}

describe("Full-Screen Alt-Buffer TUI Viewport Renderer (100% columns × rows)", () => {
  it("renders exact rows × cols full-screen layout with main transcript pane, right telemetry sidebar, and bottom docked composer", () => {
    const state = createSampleState({ cols: 120, rows: 30 });
    const raw = renderFullScreenViewport(state);
    const lines = raw.split("\n");

    // Must fill the exact height of the terminal viewport (30 rows)
    expect(lines.length).toBe(30);

    const plain = stripAnsi(raw);
    expect(plain).toContain("AIVO CODE");
    expect(plain).toContain("deepseek-v4-flash");
    expect(plain).toContain("Halo, analisa struktur proyek ini");
    expect(plain).toContain("Build full-screen TUI");
    expect(plain).toContain("src/ui/fullscreen.ts");
    expect(plain).toContain("Shift+Tab: Mode");
  });

  it("adapts cleanly to narrow terminal widths (< 95 cols) by hiding the sidebar automatically", () => {
    const state = createSampleState({ cols: 80, rows: 24 });
    const raw = renderFullScreenViewport(state);
    const lines = raw.split("\n");
    expect(lines.length).toBe(24);
    const plain = stripAnsi(raw);
    expect(plain).toContain("deepseek-v4-flash");
    expect(plain).toContain("Halo, analisa struktur proyek ini");
  });

  it("renders floating command palette and centered modal overlays inside the full-screen viewport", () => {
    const stateWithModal = createSampleState({
      cols: 110,
      rows: 28,
      modal: {
        title: "Select Active AivoKey Model (43 models)",
        filter: "deepseek",
        selectedIdx: 0,
        items: [
          {
            value: "deepseek-v4-flash",
            label: "deepseek-v4-flash",
            badge: "[tools·cache]",
            detail: "1M ctx · $0.30/$1.20",
          },
          {
            value: "deepseek-v4-pro",
            label: "deepseek-v4-pro",
            badge: "[tools·reasoning]",
            detail: "1M ctx · $1.32/$3.96",
          },
        ],
      },
    });

    const raw = renderFullScreenViewport(stateWithModal);
    const lines = raw.split("\n");
    expect(lines.length).toBe(28);
    const plain = stripAnsi(raw);
    expect(plain).toContain("Select Active AivoKey Model");
    expect(plain).toContain("deepseek-v4-flash");
    expect(plain).toContain("$0.30/$1.20");
  });
});
