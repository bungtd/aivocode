/**
 * Shared viewport layout math for the full-screen TUI.
 *
 * Both the renderer (`renderFullScreenViewport`) and the input layer (mouse
 * hit-testing, cursor placement) must agree on where every row lives. Keeping
 * the arithmetic in one place is what stops the composer from drifting one row
 * away from where a click is mapped — the two used to duplicate the formulas.
 */

/** Minimum usable viewport. Below this the TUI cannot render a coherent frame. */
export const MIN_COLS = 40;
export const MIN_ROWS = 10;

/** Sidebar appears only when there is room for both panes. */
export const SIDEBAR_MIN_COLS = 95;

/** Input box shows at most this many lines before scrolling internally. */
export const MAX_INPUT_ROWS = 6;

/** Chrome rows outside the transcript pane: 2 header + composer top + bottom + footer. */
const CHROME_ROWS = 5;

export interface InputLineMeta {
  lineIdx: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface ComposerLayout {
  lineMeta: InputLineMeta[];
  visibleLines: InputLineMeta[];
  activeLineIdx: number;
  /** Rows available to the transcript pane. */
  bodyHeight: number;
  /** 1-based terminal row of the first visible input line. */
  firstInputRowY: number;
  /** 1-based terminal row of the last visible input line. */
  lastInputRowY: number;
}

/** Splits the input buffer into lines with absolute cursor offsets. */
export function buildInputLineMeta(buffer: string): InputLineMeta[] {
  const rawLines = buffer.length > 0 ? buffer.split("\n") : [""];
  const meta: InputLineMeta[] = [];
  let offset = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const text = rawLines[i]!;
    meta.push({
      lineIdx: i,
      text,
      startOffset: offset,
      endOffset: offset + text.length,
    });
    offset += text.length + 1; // +1 for "\n"
  }
  return meta;
}

/** Index of the line that contains `cursorPos` (clamped to the last line). */
export function activeInputLineIndex(lineMeta: InputLineMeta[], cursorPos: number): number {
  for (let i = 0; i < lineMeta.length; i++) {
    if (cursorPos >= lineMeta[i]!.startOffset && cursorPos <= lineMeta[i]!.endOffset) return i;
  }
  return Math.max(0, lineMeta.length - 1);
}

/**
 * Window of input lines to paint, centred on the active line.
 * Returns the slice plus the clamped start index.
 */
export function visibleInputWindow(
  lineMeta: InputLineMeta[],
  activeLineIdx: number,
  maxRows: number = MAX_INPUT_ROWS,
): { start: number; end: number; lines: InputLineMeta[] } {
  const rows = Math.min(maxRows, Math.max(1, lineMeta.length));
  let start = Math.max(0, activeLineIdx - Math.floor(rows / 2));
  const end = Math.min(lineMeta.length, start + rows);
  if (end - start < rows) start = Math.max(0, end - rows);
  return { start, end, lines: lineMeta.slice(start, end) };
}

/** Computes every row offset the input layer needs, from the same inputs as the renderer. */
export function computeComposerLayout(
  buffer: string,
  cursorPos: number,
  rows: number,
): ComposerLayout {
  const lineMeta = buildInputLineMeta(buffer);
  const activeLineIdx = activeInputLineIndex(lineMeta, cursorPos);
  const { lines: visibleLines } = visibleInputWindow(lineMeta, activeLineIdx);
  const bodyHeight = Math.max(4, rows - CHROME_ROWS - visibleLines.length);
  // Row 1..2 header, 3..(2+bodyHeight) body, (3+bodyHeight) composer top,
  // then the input lines, then the bottom border and footer bar.
  const firstInputRowY = 4 + bodyHeight;
  const lastInputRowY = firstInputRowY + visibleLines.length - 1;
  return {
    lineMeta,
    visibleLines,
    activeLineIdx,
    bodyHeight,
    firstInputRowY,
    lastInputRowY,
  };
}

/** Body height for a given terminal size and visible input row count. */
export function transcriptBodyHeight(rows: number, visibleInputRows: number): number {
  return Math.max(4, rows - CHROME_ROWS - visibleInputRows);
}

export interface ViewportGeometry {
  cols: number;
  rows: number;
  hasSidebar: boolean;
  sidebarWidth: number;
  mainWidth: number;
}

/**
 * Resolves the real viewport geometry. The terminal size is used as-is: forcing
 * a minimum larger than the terminal would emit more rows than exist, which
 * scrolls the alternate screen and corrupts every frame after it.
 */
export function viewportGeometry(
  cols: number | undefined,
  rows: number | undefined,
  showSidebar: boolean,
): ViewportGeometry {
  const safeCols = Math.max(MIN_COLS, cols || 100);
  const safeRows = Math.max(MIN_ROWS, rows || 28);
  const hasSidebar = showSidebar && safeCols >= SIDEBAR_MIN_COLS;
  const sidebarWidth = hasSidebar
    ? Math.min(36, Math.max(28, Math.floor(safeCols * 0.28)))
    : 0;
  const mainWidth = hasSidebar ? safeCols - sidebarWidth - 1 : safeCols;
  return {
    cols: safeCols,
    rows: safeRows,
    hasSidebar,
    sidebarWidth,
    mainWidth,
  };
}

/**
 * Keeps the highlighted row inside a fixed-size viewport, so a 50-command list
 * scrolls instead of being truncated to the first N entries.
 */
export function scrollWindow(
  total: number,
  selectedIdx: number,
  maxVisible: number,
): { start: number; end: number } {
  if (total <= maxVisible) return { start: 0, end: total };
  const half = Math.floor(maxVisible / 2);
  let start = Math.max(0, selectedIdx - half);
  const end = Math.min(total, start + maxVisible);
  if (end - start < maxVisible) start = Math.max(0, end - maxVisible);
  return { start, end };
}

/**
 * Maps a click on the input box to a buffer offset.
 *
 * `x`/`y` are 1-based terminal coordinates. The caller supplies the layout so
 * this stays pure and testable.
 */
export function inputOffsetFromMouse(
  x: number,
  y: number,
  cols: number,
  layout: ComposerLayout,
): number {
  const rowIdx = Math.max(0, Math.min(layout.visibleLines.length - 1, y - layout.firstInputRowY));
  const meta = layout.visibleLines[rowIdx];
  if (!meta) return 0;
  // The prompt glyph occupies the first two cells of the first input line.
  const prefixCells = meta.lineIdx === 0 ? 2 : 2;
  const col = Math.max(0, x - 1 - prefixCells);
  return Math.min(meta.endOffset, meta.startOffset + col);
}
