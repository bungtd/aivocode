import { describe, expect, it } from "vitest";
import {
  appendFilterChar,
  backspaceFilter,
  chosenItem,
  clampSelection,
  filterModalItems,
  moveSelection,
  visibleModalRange,
} from "../src/ui/modal-nav.js";

const items = [
  { value: "model", label: "Select model", badge: "[tools]", detail: "1M ctx" },
  { value: "session", label: "Sessions", badge: "[glm-5.3]", detail: "resume" },
  { value: "jobs", label: "Background jobs", badge: "[running]", detail: "npm run dev" },
];

describe("modal navigation", () => {
  it("filters by label, badge, and detail case-insensitively", () => {
    expect(filterModalItems(items, "")).toHaveLength(3);
    expect(filterModalItems(items, "MODEL")).toHaveLength(1);
    expect(filterModalItems(items, "glm")).toHaveLength(1);
    expect(filterModalItems(items, "npm run")).toHaveLength(1);
    expect(filterModalItems(items, "zzz")).toHaveLength(0);
  });

  it("wraps selection at both ends", () => {
    expect(moveSelection(0, 3, -1)).toBe(2);
    expect(moveSelection(2, 3, 1)).toBe(0);
    expect(moveSelection(1, 3, 1)).toBe(2);
    // Empty list cannot produce an invalid index.
    expect(moveSelection(5, 0, 1)).toBe(0);
  });

  it("keeps the selected row inside a scrolling window", () => {
    const first = visibleModalRange(50, 0, 10);
    expect(first).toEqual({ start: 0, end: 10 });
    const mid = visibleModalRange(50, 25, 10);
    expect(mid.start).toBeLessThanOrEqual(25);
    expect(mid.end).toBeGreaterThan(25);
    const last = visibleModalRange(50, 49, 10);
    expect(last.end).toBe(50);
    // A short list is fully visible.
    expect(visibleModalRange(3, 1, 10)).toEqual({ start: 0, end: 3 });
  });

  it("clamps selection after the filter shrinks the list", () => {
    expect(clampSelection(9, 2)).toBe(1);
    expect(clampSelection(-3, 2)).toBe(0);
    expect(clampSelection(0, 0)).toBe(0);
  });

  it("appends printable characters and drops control bytes", () => {
    expect(appendFilterChar("mo", "d")).toBe("mod");
    expect(appendFilterChar("mo", "\x1b")).toBe("mo");
    expect(appendFilterChar("mo", "\n")).toBe("mo");
    expect(backspaceFilter("mod")).toBe("mo");
    expect(backspaceFilter("")).toBe("");
  });

  it("resolves the Enter target, or null when nothing matches", () => {
    expect(chosenItem(items, 1)?.value).toBe("session");
    expect(chosenItem(items, 99)?.value).toBe("jobs");
    expect(chosenItem([], 0)).toBeNull();
  });
});
