import { describe, expect, it } from "vitest";
import { resolveHotkey, type KeymapContext } from "../src/ui/keymap.js";

const idle: KeymapContext = {
  modalOpen: false,
  busy: false,
  hasInput: false,
  hasCatalog: true,
};

const typing: KeymapContext = { ...idle, hasInput: true };
const busy: KeymapContext = { ...idle, busy: true };
const busyTyping: KeymapContext = { ...idle, busy: true, hasInput: true };
const modal: KeymapContext = { ...idle, modalOpen: true };

describe("TUI hotkey keymap", () => {
  it("maps every advertised hotkey to one action", () => {
    expect(resolveHotkey({ name: "k", ctrl: true }, idle)).toEqual({ type: "open_modal", modal: "model" });
    expect(resolveHotkey({ name: "g", ctrl: true }, idle)).toEqual({ type: "open_modal", modal: "subagent_roles" });
    expect(resolveHotkey({ name: "o", ctrl: true }, idle)).toEqual({ type: "open_modal", modal: "config" });
    expect(resolveHotkey({ name: "a", ctrl: true }, idle)).toEqual({ type: "open_modal", modal: "team" });
    expect(resolveHotkey({ name: "p", ctrl: true }, idle)).toEqual({ type: "open_modal", modal: "command" });
    expect(resolveHotkey({ name: "r", ctrl: true }, idle)).toEqual({ type: "open_modal", modal: "sessions" });
    expect(resolveHotkey({ name: "u", meta: true }, idle)).toEqual({ type: "open_modal", modal: "subagents" });
    expect(resolveHotkey({ name: "j", meta: true }, idle)).toEqual({ type: "open_modal", modal: "jobs" });
    expect(resolveHotkey({ name: "b", ctrl: true }, idle)).toEqual({ type: "toggle_sidebar" });
    expect(resolveHotkey({ name: "y", ctrl: true }, idle)).toEqual({ type: "copy" });
    expect(resolveHotkey({ name: "x", ctrl: true }, idle)).toEqual({ type: "cut" });
    expect(resolveHotkey({ name: "f2" }, idle)).toEqual({ type: "cycle_model" });
    expect(resolveHotkey({ name: "tab", shift: true }, idle)).toEqual({ type: "cycle_mode" });
    expect(resolveHotkey({ name: "e", ctrl: true }, idle)).toEqual({ type: "cycle_effort" });
    expect(resolveHotkey({ name: "w", ctrl: true }, idle)).toEqual({ type: "cycle_wire" });
  });

  it("gives Ctrl+U one meaning: clear the line, never open a panel", () => {
    expect(resolveHotkey({ name: "u", ctrl: true }, typing)).toEqual({ type: "clear_input" });
    // Nothing to clear, so the key is inert rather than surprising.
    expect(resolveHotkey({ name: "u", ctrl: true }, idle)).toBeNull();
  });

  it("exits on Ctrl+C only when there is no input to clear", () => {
    expect(resolveHotkey({ name: "c", ctrl: true }, idle)).toEqual({ type: "exit" });
    expect(resolveHotkey({ name: "c", ctrl: true }, typing)).toEqual({ type: "clear_input" });
    expect(resolveHotkey({ name: "d", ctrl: true }, idle)).toEqual({ type: "exit" });
  });

  it("interrupts on Esc and Ctrl+C while a turn streams", () => {
    expect(resolveHotkey({ name: "escape" }, busy)).toEqual({ type: "interrupt" });
    expect(resolveHotkey({ name: "c", ctrl: true }, busy)).toEqual({ type: "interrupt" });
  });

  it("keeps monitoring available mid-turn", () => {
    expect(resolveHotkey({ name: "u", meta: true }, busy)).toEqual({ type: "open_modal", modal: "subagents" });
    expect(resolveHotkey({ name: "j", meta: true }, busy)).toEqual({ type: "open_modal", modal: "jobs" });
    expect(resolveHotkey({ name: "b", ctrl: true }, busy)).toEqual({ type: "toggle_sidebar" });
  });

  it("refuses to open editor pickers mid-turn", () => {
    expect(resolveHotkey({ name: "k", ctrl: true }, busy)).toBeNull();
    expect(resolveHotkey({ name: "p", ctrl: true }, busy)).toBeNull();
    expect(resolveHotkey({ name: "r", ctrl: true }, busy)).toBeNull();
  });

  it("still allows clearing a half-typed follow-up mid-turn", () => {
    expect(resolveHotkey({ name: "u", ctrl: true }, busyTyping)).toEqual({ type: "clear_input" });
  });

  it("gives the keyboard to an open modal", () => {
    expect(resolveHotkey({ name: "k", ctrl: true }, modal)).toBeNull();
    expect(resolveHotkey({ name: "escape" }, modal)).toBeNull();
    expect(resolveHotkey({ name: "c", ctrl: true }, modal)).toBeNull();
    expect(resolveHotkey({ name: "f2" }, modal)).toBeNull();
  });

  it("scrolls in every state, including with a modal open", () => {
    expect(resolveHotkey({ name: "pageup" }, idle)).toEqual({ type: "scroll", delta: 8 });
    expect(resolveHotkey({ name: "pagedown" }, busy)).toEqual({ type: "scroll", delta: -8 });
  });

  it("does not cycle models without a catalog", () => {
    expect(resolveHotkey({ name: "f2" }, { ...idle, hasCatalog: false })).toBeNull();
  });

  it("leaves plain typing and editing keys to the composer", () => {
    for (const name of ["a", "z", "1", "space", "backspace", "left", "right", "home", "end"]) {
      expect(resolveHotkey({ name }, idle), name).toBeNull();
    }
  });
});
