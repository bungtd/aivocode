/**
 * Pure navigation logic for the TUI's centered modals.
 *
 * The keypress handler used to inline filtering and index movement for every
 * modal, which made the behaviour impossible to test without a terminal. The
 * arithmetic lives here; the loop only reacts to the returned intent.
 */

export interface ModalItemLike {
  value: string;
  label: string;
  badge?: string;
  detail?: string;
}

/** Rows matching the typed filter (case-insensitive, label/badge/detail). */
export function filterModalItems<T extends ModalItemLike>(items: T[], filter: string): T[] {
  const query = filter.trim().toLowerCase();
  if (!query) return items;
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(query) ||
      (item.badge ?? "").toLowerCase().includes(query) ||
      (item.detail ?? "").toLowerCase().includes(query),
  );
}

/** Moves the selection by one, wrapping at both ends. */
export function moveSelection(
  selectedIdx: number,
  count: number,
  direction: 1 | -1,
): number {
  if (count <= 0) return 0;
  return (selectedIdx + direction + count) % count;
}

/** Keeps the selected row inside a fixed-height list window. */
export function visibleModalRange(
  count: number,
  selectedIdx: number,
  maxVisible: number,
): { start: number; end: number } {
  if (count <= maxVisible) return { start: 0, end: count };
  const half = Math.floor(maxVisible / 2);
  let start = Math.max(0, selectedIdx - half);
  const end = Math.min(count, start + maxVisible);
  if (end - start < maxVisible) start = Math.max(0, end - maxVisible);
  return { start, end };
}

/** Clamps the selection after the filter shrinks the list. */
export function clampSelection(selectedIdx: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(0, selectedIdx), count - 1);
}

/** Appends a printable character to the filter, dropping control bytes. */
export function appendFilterChar(filter: string, char: string): string {
  const printable = char.replace(/[\x00-\x1f\x7f]/g, "");
  return printable ? filter + printable : filter;
}

/** Removes the last character from the filter. */
export function backspaceFilter(filter: string): string {
  return filter.slice(0, -1);
}

/** Resolves which row Enter should act on, or null when nothing matches. */
export function chosenItem<T extends ModalItemLike>(
  items: T[],
  selectedIdx: number,
): T | null {
  return items[clampSelection(selectedIdx, items.length)] ?? null;
}
