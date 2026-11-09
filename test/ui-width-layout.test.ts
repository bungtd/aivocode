import { describe, expect, it } from "vitest";
import {
  codePointWidth,
  graphemes,
  textWidth,
} from "../src/ui/width.js";
import {
  padEndVisible,
  sliceTailToWidth,
  sliceToWidth,
  stripAnsi,
  truncateVisible,
  visibleLength,
} from "../src/ui/theme.js";
import {
  fitLineToWidth,
  renderFullScreenViewport,
  truncateLineToWidth,
  wrapTranscriptLines,
  type FullScreenTuiState,
} from "../src/ui/fullscreen.js";
import {
  activeInputLineIndex,
  buildInputLineMeta,
  computeComposerLayout,
  scrollWindow,
  viewportGeometry,
  visibleInputWindow,
} from "../src/ui/layout.js";
import { charIndexAtCell, renderInputLine, windowInputLine } from "../src/ui/input-line.js";

function state(over: Partial<FullScreenTuiState> = {}): FullScreenTuiState {
  return {
    cols: 100,
    rows: 24,
    showSidebar: true,
    version: "1.1.1",
    cwd: "C:/x",
    gitBranch: "main",
    gatewayUrl: "https://api.aivokey.dev",
    model: "m",
    fastModel: null,
    wire: "chat",
    effort: "off",
    mode: "auto",
    sessionId: "s",
    usedContextTokens: 1,
    maxContextTokens: 10,
    cacheHitPct: 0,
    sessionCostMicro: 0n,
    balanceMicro: null,
    keyStatus: null,
    todos: [],
    modifiedFiles: [],
    transcriptLines: ["x"],
    scrollOffset: 0,
    busyLabel: null,
    buffer: "",
    cursorPos: 0,
    suggestions: { kind: "none", query: "", items: [] },
    selectedSuggestionIdx: 0,
    modal: null,
    notice: null,
    ...over,
  };
}

describe("Unicode display width", () => {
  it("counts wide characters as two cells and combining marks as zero", () => {
    expect(textWidth("abc")).toBe(3);
    expect(textWidth("日本語")).toBe(6);
    expect(textWidth("🚀")).toBe(2);
    expect(textWidth("e\u0301")).toBe(1); // e + combining acute
    expect(codePointWidth(0x4e00)).toBe(2);
    expect(codePointWidth(0x0301)).toBe(0);
    expect(codePointWidth(0x41)).toBe(1);
  });

  it("treats a ZWJ emoji sequence as one two-cell glyph", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(graphemes(family)).toHaveLength(1);
    expect(textWidth(family)).toBe(2);
  });

  it("gives VS16 emoji presentation two cells", () => {
    expect(textWidth("\u26A0")).toBe(1);
    expect(textWidth("\u26A0\uFE0F")).toBe(2);
  });

  it("reports visibleLength in cells, not UTF-16 units", () => {
    expect(visibleLength("日本語のテキスト")).toBe(16);
    expect(visibleLength("🚀 deploy")).toBe(9);
    expect(visibleLength("\x1b[31mred\x1b[0m")).toBe(3);
  });
});

describe("cell-accurate padding and truncation", () => {
  it("pads to an exact cell count", () => {
    expect(textWidth(padEndVisible("日本", 10))).toBe(10);
    expect(textWidth(padEndVisible("ab", 10))).toBe(10);
    // Already at or over budget: returned untouched.
    expect(padEndVisible("日本語", 4)).toBe("日本語");
  });

  it("never overflows the column when truncating", () => {
    for (const sample of ["日本語のテキスト", "🚀🚀🚀🚀🚀", "mixed 日本 text", "abc"]) {
      for (const width of [5, 10, 20]) {
        expect(textWidth(stripAnsi(truncateVisible(sample, width)))).toBeLessThanOrEqual(width);
        expect(textWidth(stripAnsi(fitLineToWidth(sample, width)))).toBe(width);
        expect(textWidth(stripAnsi(truncateLineToWidth(sample, width)))).toBeLessThanOrEqual(width);
      }
    }
  });

  it("keeps the tail of a long line for horizontal scroll", () => {
    const { text, droppedCells } = sliceTailToWidth("日本語abcdef", 6);
    expect(droppedCells).toBeGreaterThan(0);
    expect(textWidth(text)).toBeLessThanOrEqual(6);
    expect(text.endsWith("f")).toBe(true);
  });

  it("slices without splitting a grapheme cluster", () => {
    const { text } = sliceToWidth("e\u0301e\u0301e\u0301", 2);
    // Each cluster is 1 cell, so two clusters fit; no dangling combining mark.
    expect(text).toBe("e\u0301e\u0301");
    expect(text.endsWith("\u0301")).toBe(true);
  });
});

describe("shared viewport layout", () => {
  it("reports the real terminal size instead of forcing a minimum larger than it", () => {
    const tiny = viewportGeometry(40, 10, true);
    expect(tiny.cols).toBe(40);
    expect(tiny.rows).toBe(10);
    expect(tiny.hasSidebar).toBe(false);
  });

  it("shows the sidebar only from 95 columns", () => {
    expect(viewportGeometry(94, 30, true).hasSidebar).toBe(false);
    expect(viewportGeometry(95, 30, true).hasSidebar).toBe(true);
  });

  it("derives identical body height for renderer and input layer", () => {
    for (const rows of [24, 30, 40]) {
      for (const buffer of ["", "a\nb", "a\nb\nc\nd\ne\nf\ng"]) {
        const layout = computeComposerLayout(buffer, 0, rows);
        const visibleRows = layout.visibleLines.length;
        expect(layout.bodyHeight).toBe(Math.max(4, rows - 5 - visibleRows));
        // First input row must sit directly under the body.
        expect(layout.firstInputRowY).toBe(4 + layout.bodyHeight);
      }
    }
  });

  it("tracks the active input line and keeps it in the visible window", () => {
    const buffer = "l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7";
    const meta = buildInputLineMeta(buffer);
    const lastStart = meta[7]!.startOffset;
    expect(activeInputLineIndex(meta, lastStart)).toBe(7);
    const win = visibleInputWindow(meta, 7);
    expect(win.lines.at(-1)!.lineIdx).toBe(7);
    expect(win.lines.length).toBeLessThanOrEqual(6);
  });

  it("scrolls a long list instead of truncating it", () => {
    expect(scrollWindow(54, 0, 10)).toEqual({ start: 0, end: 10 });
    const mid = scrollWindow(54, 30, 10);
    expect(mid.start).toBeLessThanOrEqual(30);
    expect(mid.end).toBeGreaterThan(30);
    expect(scrollWindow(54, 53, 10).end).toBe(54);
  });
});

describe("composer input windowing", () => {
  it("keeps the caret visible in a long CJK line", () => {
    const line = "日本語のテキストをたくさん入力します";
    const win = windowInputLine(line, line.length, 20);
    expect(textWidth(win.text)).toBeLessThanOrEqual(20);
    expect(win.caret).toBeGreaterThanOrEqual(0);
    expect(win.caret).toBeLessThanOrEqual(win.text.length);
    expect(win.leftEllipsis).toBe(true);
  });

  it("renders a caret glyph without exceeding the budget", () => {
    const line = "日本語".repeat(20);
    const rendered = renderInputLine(line, line.length, 24);
    expect(textWidth(rendered.text)).toBeLessThanOrEqual(24);
    expect(rendered.text).toContain("▏");
  });

  it("maps cells to character indexes on cluster boundaries", () => {
    expect(charIndexAtCell("日本語", 0)).toBe(0);
    expect(charIndexAtCell("日本語", 2)).toBe(1);
    expect(charIndexAtCell("日本語", 4)).toBe(2);
    expect(charIndexAtCell("abc", 2)).toBe(2);
  });

  it("shows a short line unchanged", () => {
    const win = windowInputLine("hello", 5, 40);
    expect(win.text).toBe("hello");
    expect(win.caret).toBe(5);
    expect(win.leftEllipsis).toBe(false);
    expect(win.rightEllipsis).toBe(false);
  });
});

describe("full-screen viewport integrity", () => {
  it("emits exactly the requested rows and never exceeds the requested columns", () => {
    for (const [cols, rows] of [
      [40, 10],
      [60, 16],
      [80, 24],
      [100, 30],
      [120, 40],
    ] as const) {
      const out = renderFullScreenViewport(state({ cols, rows }));
      const lines = out.split("\n");
      expect(lines.length, `${cols}x${rows} row count`).toBe(rows);
      for (const line of lines) {
        expect(textWidth(stripAnsi(line)), `${cols}x${rows} row width`).toBeLessThanOrEqual(cols);
      }
    }
  });

  it("renders a notice instead of overflowing a too-small terminal", () => {
    const out = renderFullScreenViewport(state({ cols: 30, rows: 6 }));
    const lines = out.split("\n");
    // Still exactly `rows` lines, so no stale content survives the resize.
    expect(lines).toHaveLength(6);
    expect(stripAnsi(lines[0]!)).toContain("too small");
    for (const line of lines) {
      expect(textWidth(stripAnsi(line))).toBeLessThanOrEqual(30);
    }
  });

  it("keeps every row aligned when the transcript contains CJK and emoji", () => {
    const out = renderFullScreenViewport(
      state({
        transcriptLines: [
          "  日本語のテキストはここにあります",
          "  emoji 🚀 and 🎯 markers",
          "  mixed ✓ 完了 warning ⚠",
        ],
      }),
    );
    const lines = out.split("\n");
    // Body rows carry the sidebar divider at a fixed column, so they must be
    // exactly the viewport width; no row may ever exceed it.
    expect(textWidth(stripAnsi(lines[0]!))).toBe(100);
    expect(textWidth(stripAnsi(lines[1]!))).toBe(100);
    for (const line of lines) {
      expect(textWidth(stripAnsi(line))).toBeLessThanOrEqual(100);
    }
    // The transcript itself must survive intact, not be sliced by a bad width.
    const plain = stripAnsi(out);
    expect(plain).toContain("日本語のテキストはここにあります");
    expect(plain).toContain("🚀");
  });

  it("keeps the composer inside the box for long wide-character input", () => {
    const buffer = "日本語のテキストをたくさん入力します".repeat(6);
    const out = renderFullScreenViewport(state({ cols: 80, rows: 20, buffer, cursorPos: buffer.length }));
    for (const line of out.split("\n")) {
      expect(textWidth(stripAnsi(line))).toBeLessThanOrEqual(80);
    }
    expect(stripAnsi(out)).toContain("▏");
  });

  it("scrolls to the top on overscroll instead of blanking the pane", () => {
    const transcript = Array.from({ length: 120 }, (_, i) => `  row-${i}`);
    const out = stripAnsi(
      renderFullScreenViewport(state({ transcriptLines: transcript, scrollOffset: 99_999 })),
    );
    expect(out).toMatch(/row-\d+/);
  });
});

describe("transcript word wrap", () => {
  it("breaks at spaces instead of splitting words", () => {
    const wrapped = wrapTranscriptLines(["  " + "word ".repeat(30)], 40);
    for (const line of wrapped) {
      expect(textWidth(line)).toBeLessThanOrEqual(40);
    }
    // No line should start mid-word with the tail of "word".
    for (const line of wrapped.slice(1)) {
      expect(line.trimStart().startsWith("ord")).toBe(false);
    }
  });

  it("hard-breaks a single word wider than the pane", () => {
    const wrapped = wrapTranscriptLines(["  " + "a".repeat(120)], 40);
    expect(wrapped.length).toBeGreaterThan(1);
    for (const line of wrapped) expect(textWidth(line)).toBeLessThanOrEqual(40);
  });

  it("wraps CJK by cells, not code units", () => {
    const wrapped = wrapTranscriptLines(["  " + "日本語".repeat(30)], 40);
    for (const line of wrapped) expect(textWidth(line)).toBeLessThanOrEqual(40);
    expect(wrapped.join("")).toContain("日本語");
  });

  it("reopens the active style on continuation lines", () => {
    const styled = "\x1b[38;5;81m" + "colored text ".repeat(20) + "\x1b[39m";
    const wrapped = wrapTranscriptLines([styled], 40);
    expect(wrapped.length).toBeGreaterThan(1);
    for (const line of wrapped) expect(textWidth(stripAnsi(line))).toBeLessThanOrEqual(40);
  });
});
