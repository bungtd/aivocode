/**
 * Cell-accurate horizontal windowing for one composer input line.
 *
 * A terminal cell is not a character: CJK and emoji take two, combining marks
 * take none. Slicing the buffer by `String.length` overflows the input box and
 * leaves the caret a few columns off the text, so horizontal scrolling is
 * measured in cells and only ever cuts on grapheme boundaries.
 */
import { graphemes, textWidth } from "./width.js";

export interface InputLineWindow {
  /** Visible slice of the line. */
  text: string;
  /** Index in the original line where `text` begins. */
  startChar: number;
  /** Caret index inside `text`, or -1 when the caret is on another line. */
  caret: number;
  /** Content was dropped on the left (render a leading ellipsis). */
  leftEllipsis: boolean;
  /** Content was dropped on the right (render a trailing ellipsis). */
  rightEllipsis: boolean;
}

/** Character index reached after consuming `cells` cells from the start. */
export function charIndexAtCell(line: string, cells: number): number {
  if (cells <= 0) return 0;
  let used = 0;
  let index = 0;
  for (const cluster of graphemes(line)) {
    const w = textWidth(cluster);
    if (used + w > cells) break;
    used += w;
    index += cluster.length;
  }
  return index;
}

/**
 * Windows `line` to at most `width` cells, keeping the caret visible.
 *
 * `caret` is a character index into `line`, or -1 when the caret is on another
 * line (then the head of the line is shown). One cell is reserved for the caret
 * glyph and one for each ellipsis marker, so the rendered row never exceeds
 * `width`.
 */
export function windowInputLine(line: string, caret: number, width: number): InputLineWindow {
  const budget = Math.max(1, width);
  const totalCells = textWidth(line);
  const hasCaret = caret >= 0 && caret <= line.length;
  const caretCells = hasCaret ? textWidth(line.slice(0, caret)) : 0;

  if (totalCells + (hasCaret ? 1 : 0) <= budget) {
    return {
      text: line,
      startChar: 0,
      caret: hasCaret ? caret : -1,
      leftEllipsis: false,
      rightEllipsis: false,
    };
  }

  // Scroll just enough to keep the caret (plus a little context) on screen.
  // Reserve one cell for the leading ellipsis.
  const scrollRoom = Math.max(1, budget - 3);
  const startCells = hasCaret ? Math.max(0, caretCells - scrollRoom) : 0;
  const startChar = charIndexAtCell(line, startCells);
  const leftEllipsis = startChar > 0;

  const remaining = line.slice(startChar);
  const available = budget - (leftEllipsis ? 1 : 0) - (hasCaret ? 1 : 0);

  // Keep whole clusters until the cell budget is spent.
  let used = 0;
  let cut = 0;
  for (const cluster of graphemes(remaining)) {
    const w = textWidth(cluster);
    if (used + w > available) break;
    used += w;
    cut += cluster.length;
  }
  const rightEllipsis = cut < remaining.length;
  const text = remaining.slice(0, cut);

  return {
    text,
    startChar,
    caret: hasCaret ? Math.max(0, Math.min(text.length, caret - startChar)) : -1,
    leftEllipsis,
    rightEllipsis,
  };
}

/**
 * Renders one input line as display text with the caret glyph inserted, plus
 * the ellipsis markers the caller should style.
 */
export function renderInputLine(
  line: string,
  caret: number,
  width: number,
): { text: string; leftEllipsis: boolean; rightEllipsis: boolean; startChar: number } {
  const win = windowInputLine(line, caret, width);
  const withCaret =
    win.caret >= 0
      ? `${win.text.slice(0, win.caret)}▏${win.text.slice(win.caret)}`
      : win.text;
  const lead = win.leftEllipsis ? "…" : "";
  const tail = win.rightEllipsis ? "…" : "";
  return {
    text: `${lead}${withCaret}${tail}`,
    leftEllipsis: win.leftEllipsis,
    rightEllipsis: win.rightEllipsis,
    startChar: win.startChar,
  };
}
