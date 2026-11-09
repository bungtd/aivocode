/**
 * Raw terminal input decoding for the full-screen TUI.
 *
 * `stdin` delivers bytes, and those bytes interleave three different protocols:
 * SGR mouse reports, modified-key escapes (CSI-u / xterm modifyOtherKeys), and
 * plain text. Feeding them straight to `readline` makes mouse movement type into
 * the prompt, so this module splits the stream *before* readline sees it.
 *
 * Kept separate from the TUI loop so the decoding rules are unit-testable
 * without a terminal.
 */

export interface SgrMouseEvent {
  type: "down" | "drag" | "up" | "wheel_up" | "wheel_down" | "click";
  /** 1-based terminal column. */
  x: number;
  /** 1-based terminal row. */
  y: number;
}

/**
 * Decodes one SGR mouse report. Single source of truth for the streaming
 * splitter and `parseSgrMouseEvent`, so both agree on what the button bits mean.
 */
function decodeSgrMouse(
  btn: number,
  x: number,
  y: number,
  isRelease: boolean,
): SgrMouseEvent | null {
  if (btn === 64) return { type: "wheel_up", x, y };
  if (btn === 65) return { type: "wheel_down", x, y };
  // Bit 32 marks motion; a release report never carries it.
  if ((btn & 32) !== 0 && !isRelease) return { type: "drag", x, y };
  if ((btn & 3) === 0) return { type: isRelease ? "up" : "down", x, y };
  return null;
}

/**
 * Translates a CSI-u / modifyOtherKeys key code back into the VT sequence
 * `readline` understands, so Shift+Enter, Ctrl+K, Shift+Tab, ... keep working on
 * terminals that use the newer encodings.
 */
function translateCsiKeyCode(code: number, mod: number): string {
  const modBits = Math.max(0, mod - 1);
  const shift = (modBits & 1) !== 0;
  const alt = (modBits & 2) !== 0;
  const ctrl = (modBits & 4) !== 0;

  if (code === 13) return mod > 1 ? "\n" : "\r";
  if (code === 27) return "\x1b";
  if (code === 9) return shift ? "\x1b[Z" : "\t";
  if (code === 32) return " ";
  if (code === 127 || code === 8) return "\x7f";
  if (code >= 97 && code <= 122) {
    if (ctrl) return String.fromCharCode(code - 96);
    const ch = shift ? String.fromCharCode(code - 32) : String.fromCharCode(code);
    return alt ? `\x1b${ch}` : ch;
  }
  if (code >= 65 && code <= 90) {
    if (ctrl) return String.fromCharCode(code - 64);
    const ch = String.fromCharCode(code);
    return alt ? `\x1b${ch}` : ch;
  }
  if (code >= 33 && code <= 126) {
    const ch = String.fromCharCode(code);
    return alt ? `\x1b${ch}` : ch;
  }
  return "";
}

/**
 * Strips complete and partial SGR / X10 mouse fragments (e.g. `<35;84;19M`,
 * `<35;84;`, `\x1b[<64;80;20M`) even when they arrive one character at a time
 * through `readline.emitKeypressEvents`, while preserving ordinary text such as
 * `1;2;3m`.
 */
export function stripMouseEscapeGarbage(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/(?:(?:\x1b\[<?|<)\d{1,3}|(?<!\d)(?:0|2|3[2-5]|6[45]));\d{1,4};\d{1,4}[Mm]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b?\[?<\d+;\d+;?\d*$/g, "");
}

/**
 * Splits a raw `stdin` chunk into parsed mouse events and pure keyboard text.
 *
 * Also normalizes multi-line paste chunks to `\n`, so pasting a block inserts
 * newlines instead of submitting the first line.
 */
export function splitMouseAndKeyboardBytes(chunk: Buffer | string): {
  keyboardText: string;
  mouseEvents: SgrMouseEvent[];
} {
  const raw = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const mouseEvents: SgrMouseEvent[] = [];
  // eslint-disable-next-line no-control-regex
  const sgrRegex = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

  let match: RegExpExecArray | null;
  while ((match = sgrRegex.exec(raw)) !== null) {
    const event = decodeSgrMouse(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      match[4] === "m",
    );
    if (event) mouseEvents.push(event);
  }

  let withoutMouse = raw
    .replace(sgrRegex, "")
    // Kitty CSI-u (\x1b[code;modu or \x1b[codeu)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[(\d+)(?:;(\d+)(?::\d+)?)?u/g, (_m, cStr, mStr) =>
      translateCsiKeyCode(Number(cStr), mStr ? Number(mStr) : 1),
    )
    // xterm modifyOtherKeys (\x1b[27;mod;code~)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[27;(\d+);(\d+)~/g, (_m, mStr, cStr) =>
      translateCsiKeyCode(Number(cStr), Number(mStr)),
    );

  withoutMouse = withoutMouse.replace(/\r\n/g, "\n");
  if (withoutMouse.length > 1 && withoutMouse.includes("\r")) {
    withoutMouse = withoutMouse.replace(/\r/g, "\n");
  }

  return { keyboardText: stripMouseEscapeGarbage(withoutMouse), mouseEvents };
}

/** Parses a single SGR mouse escape sequence (`\x1b[<btn;x;yM`). */
export function parseSgrMouseEvent(raw: string): SgrMouseEvent | null {
  const m = raw.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (!m) return null;
  const event = decodeSgrMouse(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === "m");
  if (!event) return null;
  // The public contract calls a press a "click"; the streaming splitter needs
  // the press/release pair, so it uses the raw "down".
  return event.type === "down" ? { ...event, type: "click" } : event;
}
