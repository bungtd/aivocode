/**
 * Keymap for the full-screen TUI.
 *
 * The interactive loop used to decide every hotkey inline, which meant the
 * keyboard contract could only be verified by hand in a real terminal. This
 * module answers one question — "what does this key mean right now?" — as a
 * pure function, so it is testable and the UI cannot drift from `/help`.
 */

export interface KeyLike {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  sequence?: string;
}

export interface KeymapContext {
  /** A centered modal is open; it owns every key. */
  modalOpen: boolean;
  /** A turn or tool is running, so Esc/Ctrl+C interrupt instead of editing. */
  busy: boolean;
  /** The composer holds text. */
  hasInput: boolean;
  /** A model catalog is loaded, so F2 can cycle. */
  hasCatalog: boolean;
}

export type HotkeyAction =
  | { type: "interrupt" }
  | { type: "clear_input" }
  | { type: "copy" }
  | { type: "cut" }
  | { type: "cycle_model" }
  | { type: "cycle_mode" }
  | { type: "cycle_effort" }
  | { type: "cycle_wire" }
  | { type: "toggle_sidebar" }
  | { type: "exit" }
  | { type: "open_modal"; modal: ModalId }
  | { type: "scroll"; delta: number };

export type ModalId =
  | "model"
  | "subagent_roles"
  | "config"
  | "team"
  | "command"
  | "sessions"
  | "subagents"
  | "jobs"
  | "permissions"
  | "effort"
  | "mode"
  | "wire"
  | "strategy";

/**
 * True when the keypress should insert a newline instead of submitting.
 *
 * Terminals disagree: Node readline emits `enter` for `\n` (Ctrl+Enter, Ctrl+J,
 * and translated Shift+Enter) but `return` for plain `\r`, while modern
 * terminals send CSI-u / modifyOtherKeys sequences instead.
 */
export function isNewlineKey(key: KeyLike | undefined, str?: string): boolean {
  const raw = str ?? key?.sequence ?? "";
  // eslint-disable-next-line no-control-regex
  if (/\x1b\[(?:13;[2-8]u|27;[2-8];13~)/.test(raw)) return true;
  if (!key) return false;
  if (key.ctrl === true && key.name === "j") return true;
  if (key.name === "enter") return true;
  if (key.name === "return" && Boolean(key.shift || key.meta || key.ctrl)) return true;
  return false;
}

/**
 * Resolves a keypress to a global action, or null when the key belongs to text
 * editing (the composer handles it).
 *
 * Priority is deliberate and part of the contract:
 *   1. modal open  → the modal handles everything
 *   2. busy        → only interrupt + read-only inspectors
 *   3. idle        → the full editor keymap
 */
export function resolveHotkey(
  key: KeyLike | undefined,
  ctx: KeymapContext,
): HotkeyAction | null {
  if (!key) return null;
  const name = key.name;
  const ctrl = key.ctrl === true;
  const meta = key.meta === true;
  const shift = key.shift === true;

  // A modal owns the keyboard; the loop handles modal navigation itself.
  if (ctx.modalOpen) return null;

  // Scrolling is always available, even mid-turn.
  if (name === "pageup") return { type: "scroll", delta: 8 };
  if (name === "pagedown") return { type: "scroll", delta: -8 };

  if (ctx.busy) {
    if (name === "escape" || (ctrl && name === "c")) return { type: "interrupt" };
    // Monitoring stays reachable while the agent works.
    if (meta && name === "u") return { type: "open_modal", modal: "subagents" };
    if (meta && name === "j") return { type: "open_modal", modal: "jobs" };
    if (ctrl && name === "b") return { type: "toggle_sidebar" };
    // Editing the buffer is allowed; opening pickers is not (it would race the
    // turn that is already running).
    if (ctrl && name === "u" && ctx.hasInput) return { type: "clear_input" };
    return null;
  }

  // Editor and inspector modals.
  if (ctrl && name === "k") return { type: "open_modal", modal: "model" };
  if (ctrl && name === "g") return { type: "open_modal", modal: "subagent_roles" };
  if (ctrl && name === "o") return { type: "open_modal", modal: "config" };
  if (ctrl && name === "a") return { type: "open_modal", modal: "team" };
  if (ctrl && name === "p") return { type: "open_modal", modal: "command" };
  if (ctrl && name === "r") return { type: "open_modal", modal: "sessions" };
  if (meta && name === "u") return { type: "open_modal", modal: "subagents" };
  if (meta && name === "j") return { type: "open_modal", modal: "jobs" };

  // Input and clipboard. Ctrl+U keeps its readline meaning (clear the line) in
  // both composers; subagent inspection is Alt+U.
  if (ctrl && name === "u") return ctx.hasInput ? { type: "clear_input" } : null;
  if (ctrl && name === "b") return { type: "toggle_sidebar" };
  if (ctrl && name === "y") return { type: "copy" };
  if (ctrl && name === "x") return { type: "cut" };
  if (name === "f2" && ctx.hasCatalog) return { type: "cycle_model" };

  // Cycles.
  if ((name === "tab" && shift) || (ctrl && name === "t") || (meta && name === "m")) {
    return { type: "cycle_mode" };
  }
  if (ctrl && name === "e") return { type: "cycle_effort" };
  if (ctrl && name === "w") return { type: "cycle_wire" };

  // Exit / clear.
  if (ctrl && (name === "c" || name === "d")) {
    return ctx.hasInput ? { type: "clear_input" } : { type: "exit" };
  }

  return null;
}
