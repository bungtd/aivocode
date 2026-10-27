import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import type { AivoWire, PermissionMode, ReasoningEffort } from "../config.js";
import { c, padEndVisible, renderStatusBar, visibleLength } from "./theme.js";
import { SLASH_COMMANDS } from "./select.js";

import { DEFAULT_AIVOKEY_CATALOG } from "../aivokey-client.js";
import { AGENT_TEAMS } from "../teams.js";

export interface SuggestionItem {
  value: string;
  label: string;
  description: string;
}

export interface ComposerSuggestions {
  kind: "none" | "slash" | "arg" | "file";
  query: string;
  items: SuggestionItem[];
}

const MODE_ORDER: PermissionMode[] = ["auto", "plan", "safe"];
const EFFORT_ORDER: ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "off",
];
const WIRE_ORDER: AivoWire[] = ["chat", "messages", "responses"];

export function fuzzyScore(query: string, candidate: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const cand = candidate.toLowerCase();
  const baseName = cand.split("/").pop() ?? cand;

  if (baseName === q) return 200;
  if (baseName.startsWith(q)) return 150 - baseName.length;
  if (cand.startsWith(q)) return 120 - cand.length * 0.5;
  if (baseName.includes(q)) return 100 - baseName.length * 0.5;
  if (cand.includes(q)) return 80 - cand.length * 0.3;

  // Subsequence fuzzy match (e.g. "aivoclient" -> "src/aivokey-client.ts")
  let qIdx = 0;
  let consecutiveBonus = 0;
  let lastMatchIdx = -2;
  for (let i = 0; i < cand.length && qIdx < q.length; i++) {
    if (cand[i] === q[qIdx]) {
      if (i === lastMatchIdx + 1) consecutiveBonus += 4;
      lastMatchIdx = i;
      qIdx++;
    }
  }
  if (qIdx === q.length) {
    return 30 + consecutiveBonus - cand.length * 0.2;
  }
  return -1;
}

export function fuzzyMatchFiles(query: string, files: string[], limit: number = 8): string[] {
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    const score = fuzzyScore(query, file);
    if (score >= 0) {
      scored.push({ file, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((s) => s.file);
}

function fileCategoryTag(filePath: string): string {
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) return "TS";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "JS";
  if (filePath.endsWith(".json")) return "JSON";
  if (filePath.endsWith(".md")) return "MD";
  return "FILE";
}

export function computeComposerSuggestions(
  buffer: string,
  workspaceFiles: string[],
  catalogModelIds?: string[],
): ComposerSuggestions {
  const modelIds =
    catalogModelIds && catalogModelIds.length > 0
      ? catalogModelIds
      : DEFAULT_AIVOKEY_CATALOG.map((m) => m.id);

  // 1. Live `/` Command Palette when buffer starts with `/` and has no space yet
  if (buffer.startsWith("/") && !buffer.includes(" ")) {
    const q = buffer.slice(1).toLowerCase();
    const matched = SLASH_COMMANDS.filter(
      (s) =>
        s.cmd.slice(1).startsWith(q) ||
        s.cmd.slice(1).includes(q) ||
        s.description.toLowerCase().includes(q),
    );
    return {
      kind: "slash",
      query: q,
      items: matched.slice(0, 8).map((s) => ({
        value: s.cmd,
        label: s.cmd,
        description: s.description,
      })),
    };
  }

  // 2. Live Slash Argument Autocomplete (`/model ...`, `/subagent ...`, `/team ...`, `/effort ...`, `/mode ...`, `/wire ...`, `/strategy ...`, `/config ...`)
  if (buffer.startsWith("/") && buffer.includes(" ")) {
    const firstSpace = buffer.indexOf(" ");
    const cmd = buffer.slice(0, firstSpace).toLowerCase();
    const argQuery = buffer.slice(firstSpace + 1).trim().toLowerCase();

    if (cmd === "/model" || cmd === "/subagent" || cmd === "/fast-model" || cmd === "/subagent-model") {
      const subParts = argQuery.split(/\s+/).filter(Boolean);
      const roleKeywords = ["explore", "architect", "builder", "reviewer", "all"];
      let prefixCmd = cmd;
      let modelFilter = argQuery;
      if (
        (cmd === "/subagent" || cmd === "/subagent-model") &&
        subParts.length >= 1 &&
        roleKeywords.includes(subParts[0]!) &&
        buffer.slice(firstSpace + 1).includes(" ")
      ) {
        prefixCmd = `${cmd} ${subParts[0]}`;
        modelFilter = subParts.slice(1).join(" ");
      }

      const matchedModels = modelIds.filter((id) => !modelFilter || id.toLowerCase().includes(modelFilter));
      const roleSuggestions: SuggestionItem[] =
        (cmd === "/subagent" || cmd === "/subagent-model") && !buffer.slice(firstSpace + 1).trim().includes(" ")
          ? roleKeywords
              .filter((r) => !argQuery || r.startsWith(argQuery))
              .map((r) => ({
                value: `${cmd} ${r} `,
                label: `${r} <model>`,
                description: `Configure ${r} subagent role model`,
              }))
          : [];

      const items: SuggestionItem[] = [
        ...matchedModels.slice(0, 7).map((id) => ({
          value: `${prefixCmd} ${id}`,
          label: id,
          description:
            prefixCmd === "/model" ? "Switch primary model" : `Set ${prefixCmd.replace(/^\//, "")} model`,
        })),
        ...roleSuggestions,
      ].slice(0, 8);

      if (items.length > 0) {
        return { kind: "arg", query: argQuery, items };
      }
    }

    if (cmd === "/team" || cmd === "/agents") {
      const matched = AGENT_TEAMS.filter(
        (t) => !argQuery || t.id.includes(argQuery) || t.name.toLowerCase().includes(argQuery),
      );
      if (matched.length > 0) {
        return {
          kind: "arg",
          query: argQuery,
          items: matched.map((t) => ({
            value: `/team ${t.id}`,
            label: t.id,
            description: `${t.name} [${t.roles.map((r) => r.badge).join("→")}]`,
          })),
        };
      }
    }

    if (cmd === "/effort") {
      const efforts: Array<{ id: string; desc: string }> = [
        { id: "off", desc: "Fastest direct streaming (no thinking delay)" },
        { id: "minimal", desc: "Minimal thinking tokens" },
        { id: "low", desc: "Light reasoning for quick code edits" },
        { id: "medium", desc: "Balanced reasoning for multi-file tasks" },
        { id: "high", desc: "Deep architectural reasoning" },
        { id: "xhigh", desc: "Extended reasoning for complex bugs" },
        { id: "max", desc: "Maximum thinking budget" },
      ];
      const matched = efforts.filter((e) => !argQuery || e.id.includes(argQuery));
      if (matched.length > 0) {
        return {
          kind: "arg",
          query: argQuery,
          items: matched.map((e) => ({
            value: `/effort ${e.id}`,
            label: e.id,
            description: e.desc,
          })),
        };
      }
    }

    if (cmd === "/mode") {
      const modes = [
        { id: "auto", desc: "Full autonomous coding agent (read, edit, write, shell)" },
        { id: "plan", desc: "Read-only Architect Mode (explores & plans only)" },
        { id: "safe", desc: "Confirm before every file edit or shell command" },
      ].filter((m) => !argQuery || m.id.includes(argQuery));
      if (modes.length > 0) {
        return {
          kind: "arg",
          query: argQuery,
          items: modes.map((m) => ({
            value: `/mode ${m.id}`,
            label: m.id,
            description: m.desc,
          })),
        };
      }
    }

    if (cmd === "/wire") {
      const wires = [
        { id: "chat", desc: "POST /v1/chat/completions (OpenAI Chat Completions)" },
        { id: "messages", desc: "POST /v1/messages (Anthropic Messages + ephemeral cache)" },
        { id: "responses", desc: "POST /v1/responses (OpenAI Responses wire)" },
      ].filter((w) => !argQuery || w.id.includes(argQuery));
      if (wires.length > 0) {
        return {
          kind: "arg",
          query: argQuery,
          items: wires.map((w) => ({
            value: `/wire ${w.id}`,
            label: w.id,
            description: w.desc,
          })),
        };
      }
    }

    if (cmd === "/strategy") {
      const strategies = [
        { id: "auto", desc: "Auto-detect strategy & specialist team from prompt" },
        { id: "subagent-driven", desc: "Always run multi-stage Architect → Builder → QA team workflow" },
        { id: "native", desc: "Always run fast single-session build + automated Review-Fix gate" },
        { id: "ask", desc: "Ask me to choose Subagent-Driven vs Native before substantial builds" },
      ].filter((s) => !argQuery || s.id.includes(argQuery));
      if (strategies.length > 0) {
        return {
          kind: "arg",
          query: argQuery,
          items: strategies.map((s) => ({
            value: `/strategy ${s.id}`,
            label: s.id,
            description: s.desc,
          })),
        };
      }
    }

    if (cmd === "/config" || cmd === "/settings") {
      const keys = [
        { k: "model", desc: "Primary coding model" },
        { k: "fastModel", desc: "Subagent / Explorer fast model" },
        { k: "architectModel", desc: "Architect stage model" },
        { k: "builderModel", desc: "Builder stage model" },
        { k: "reviewerModel", desc: "QA Reviewer stage model" },
        { k: "reasoningEffort", desc: "Primary reasoning effort (off..max)" },
        { k: "subagentEffort", desc: "Subagent reasoning effort (off..max)" },
        { k: "strategy", desc: "Execution strategy (auto|subagent-driven|native|ask)" },
        { k: "team", desc: "Active specialist team" },
        { k: "mode", desc: "Permission mode (auto|plan|safe)" },
        { k: "wire", desc: "AivoKey wire protocol (chat|messages|responses)" },
        { k: "autoReviewFix", desc: "Toggle automated Review & Fix gate (true|false)" },
      ].filter((x) => !argQuery || x.k.toLowerCase().includes(argQuery));
      if (keys.length > 0 && !argQuery.includes(" ")) {
        return {
          kind: "arg",
          query: argQuery,
          items: keys.map((x) => ({
            value: `/config ${x.k} `,
            label: x.k,
            description: x.desc,
          })),
        };
      }
    }
  }

  // 3. Live `@file` Fuzzy Finder when the active token starts with `@`
  const atMatch = buffer.match(/(?:^|\s)@([^\s]*)$/);
  if (atMatch) {
    const query = atMatch[1] ?? "";
    const matchedFiles = fuzzyMatchFiles(query, workspaceFiles, 8);
    return {
      kind: "file",
      query,
      items: matchedFiles.map((f) => ({
        value: f,
        label: `@${f}`,
        description: fileCategoryTag(f),
      })),
    };
  }

  return { kind: "none", query: "", items: [] };
}

export interface HotkeyState {
  mode: PermissionMode;
  effort: ReasoningEffort;
  wire: AivoWire;
}

export function applyComposerHotkeys(
  state: HotkeyState,
  key: { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean } | undefined,
): HotkeyState | null {
  if (!key) return null;

  // Shift+Tab or Ctrl+T or Alt+M -> cycle mode (auto -> plan -> safe)
  if (
    (key.name === "tab" && key.shift) ||
    (key.ctrl && key.name === "t") ||
    (key.meta && key.name === "m")
  ) {
    const idx = MODE_ORDER.indexOf(state.mode);
    const nextMode = MODE_ORDER[(idx + 1) % MODE_ORDER.length]!;
    return { ...state, mode: nextMode };
  }

  // Ctrl+E -> cycle reasoning effort
  if (key.ctrl && key.name === "e") {
    const idx = EFFORT_ORDER.indexOf(state.effort);
    const nextEffort = EFFORT_ORDER[(idx + 1) % EFFORT_ORDER.length]!;
    return { ...state, effort: nextEffort };
  }

  // Ctrl+W -> cycle protocol wire
  if (key.ctrl && key.name === "w") {
    const idx = WIRE_ORDER.indexOf(state.wire);
    const nextWire = WIRE_ORDER[(idx + 1) % WIRE_ORDER.length]!;
    return { ...state, wire: nextWire };
  }

  return null;
}

export interface RenderComposerFrameOptions {
  buffer: string;
  cursorPos: number;
  mode: PermissionMode;
  model: string;
  effort: ReasoningEffort;
  wire: AivoWire;
  usedContextTokens: number;
  maxContextTokens: number;
  cacheHitPct: number;
  sessionCostMicro: bigint;
  balanceMicro?: bigint | null;
  gitBranch?: string;
  suggestions: ComposerSuggestions;
  selectedSuggestionIdx: number;
  notice?: string | null;
}

export function renderComposerFrame(opts: RenderComposerFrameOptions): string {
  const width = 76;
  const inner = width - 4;
  const borderColor =
    opts.mode === "plan" ? c.violet : opts.mode === "safe" ? c.amber : c.cyan;

  const statusBar = renderStatusBar({
    mode: opts.mode,
    model: opts.model,
    effort: opts.effort,
    wire: opts.wire,
    usedContextTokens: opts.usedContextTokens,
    maxContextTokens: opts.maxContextTokens,
    cacheHitPct: opts.cacheHitPct,
    sessionCostMicro: opts.sessionCostMicro,
    balanceMicro: opts.balanceMicro,
    gitBranch: opts.gitBranch,
  });

  const modeTitle =
    opts.mode === "plan"
      ? "PLAN · ARCHITECT (Read-Only)"
      : opts.mode === "safe"
        ? "SAFE · CONFIRM EDITS"
        : "AUTO · BUILD AGENT";

  const topTitle = `── ◆ ${modeTitle} `;
  const topDashCount = Math.max(2, width - topTitle.length);
  const topBorder = borderColor(`${topTitle}${"─".repeat(topDashCount)}`);

  const glyph =
    opts.mode === "plan"
      ? c.violet("❯ ")
      : opts.mode === "safe"
        ? c.amber("❯ ")
        : c.cyan("❯ ");

  let inputDisplay: string;
  if (!opts.buffer) {
    const placeholder = "Ask anything, @file to attach, / for commands, !cmd for shell…";
    inputDisplay = `${glyph}${c.white("▏")}${c.dim(placeholder)}`;
  } else {
    const beforeCursor = opts.buffer.slice(0, opts.cursorPos);
    const afterCursor = opts.buffer.slice(opts.cursorPos);
    const rawLine = `${beforeCursor}▏${afterCursor}`;
    const maxChars = inner - 3;
    const clipped =
      rawLine.length > maxChars ? "…" + rawLine.slice(rawLine.length - (maxChars - 1)) : rawLine;
    inputDisplay = `${glyph}${c.white(clipped)}`;
  }

  // Borderless left/right so mouse selection copies pure input text without │ borders!
  const middleRow = ` ${inputDisplay}`;

  const footerHint =
    "── Shift+Tab: Mode · Ctrl+K: Models · Ctrl+E: Effort · Ctrl+W: Wire · /: Cmds ";
  const bottomDashCount = Math.max(1, width - footerHint.length);
  const bottomBorder = borderColor(`${footerHint}${"─".repeat(bottomDashCount)}`);

  const lines: string[] = [statusBar, topBorder, middleRow, bottomBorder];

  if (opts.notice) {
    lines.push(`  ${c.teal("⚡")} ${c.slate(opts.notice)}`);
  }

  // Render live floating dropdown for `/` commands or `@file` fuzzy finder
  if (opts.suggestions.kind !== "none" && opts.suggestions.items.length > 0) {
    const headerLabel =
      opts.suggestions.kind === "slash"
        ? "Slash Commands (↑/↓ navigate · Tab/Enter select)"
        : "Workspace Files (↑/↓ navigate · Tab/Enter attach)";
    lines.push(`  ${c.cyan("╭─")} ${c.bold(headerLabel)} ${c.cyan("─".repeat(22))}`);
    opts.suggestions.items.forEach((item, idx) => {
      const isSelected = idx === opts.selectedSuggestionIdx;
      const pointer = isSelected ? c.cyan("❯") : " ";
      const labelPadded = item.label.padEnd(28).slice(0, 28);
      const labelStyled = isSelected ? c.bold(c.cyan(labelPadded)) : c.white(labelPadded);
      const descStyled = isSelected ? c.white(item.description) : c.slate(item.description);
      lines.push(`  ${c.cyan("│")} ${pointer} ${labelStyled} ${descStyled}`);
    });
    lines.push(`  ${c.cyan("╰" + "─".repeat(70))}`);
  }

  return lines.join("\n");
}

export type ComposerAction =
  | { type: "submit"; line: string }
  | { type: "open_model_picker" }
  | { type: "open_status" }
  | { type: "exit" };

export async function readInteractiveComposerLine(opts: {
  getState: () => {
    mode: PermissionMode;
    model: string;
    effort: ReasoningEffort;
    wire: AivoWire;
    usedContextTokens: number;
    maxContextTokens: number;
    cacheHitPct: number;
    sessionCostMicro: bigint;
    balanceMicro?: bigint | null;
    gitBranch?: string;
    workspaceFiles: string[];
  };
  onHotkeyChange: (next: HotkeyState, description: string) => void;
  history: string[];
}): Promise<ComposerAction> {
  let buffer = "";
  let cursorPos = 0;
  let selectedSuggestionIdx = 0;
  let historyIdx = opts.history.length;
  let notice: string | null = null;
  let renderedLineCount = 0;

  const clearFrame = () => {
    if (renderedLineCount <= 0) return;
    if ( renderedLineCount > 1) {
      stdout.write(`\x1b[${renderedLineCount - 1}A`);
    }
    stdout.write(`\r\x1b[J`);
    renderedLineCount = 0;
  };

  const render = () => {
    clearFrame();
    const st = opts.getState();
    const suggestions = computeComposerSuggestions(buffer, st.workspaceFiles);
    if (selectedSuggestionIdx >= suggestions.items.length) {
      selectedSuggestionIdx = Math.max(0, suggestions.items.length - 1);
    }

    const frame = renderComposerFrame({
      buffer,
      cursorPos,
      mode: st.mode,
      model: st.model,
      effort: st.effort,
      wire: st.wire,
      usedContextTokens: st.usedContextTokens,
      maxContextTokens: st.maxContextTokens,
      cacheHitPct: st.cacheHitPct,
      sessionCostMicro: st.sessionCostMicro,
      balanceMicro: st.balanceMicro,
      gitBranch: st.gitBranch,
      suggestions,
      selectedSuggestionIdx,
      notice,
    });

    stdout.write(frame);
    renderedLineCount = frame.split("\n").length;
  };

  const acceptSuggestion = (suggestions: ComposerSuggestions): boolean => {
    const chosen = suggestions.items[selectedSuggestionIdx];
    if (!chosen) return false;
    if (suggestions.kind === "slash" || suggestions.kind === "arg") {
      buffer = chosen.value;
      cursorPos = buffer.length;
      selectedSuggestionIdx = 0;
      return true;
    }
    if (suggestions.kind === "file") {
      buffer = buffer.replace(/(^|\s)@([^\s]*)$/, `$1@${chosen.value} `);
      cursorPos = buffer.length;
      selectedSuggestionIdx = 0;
      return true;
    }
    return false;
  };

  return new Promise<ComposerAction>((resolvePromise) => {
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    stdout.write("\n");
    render();

    const finish = (action: ComposerAction) => {
      stdin.off("keypress", onKeypress);
      clearFrame();
      if (action.type === "submit" && action.line.trim()) {
        const st = opts.getState();
        const glyph =
          st.mode === "plan"
            ? c.violet("❯")
            : st.mode === "safe"
              ? c.amber("❯")
              : c.cyan("❯");
        stdout.write(`${glyph} ${c.bold(c.white(action.line))}\n`);
      }
      if (stdin.isTTY) {
        stdin.setRawMode(Boolean(wasRaw));
      }
      resolvePromise(action);
    };

    const onKeypress = (
      str: string | undefined,
      key: { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean } | undefined,
    ) => {
      const st = opts.getState();
      const suggestions = computeComposerSuggestions(buffer, st.workspaceFiles);

      // Global Hotkeys: Shift+Tab / Ctrl+T (mode), Ctrl+E (effort), Ctrl+W (wire)
      const hotkeyNext = applyComposerHotkeys(
        { mode: st.mode, effort: st.effort, wire: st.wire },
        key,
      );
      if (hotkeyNext) {
        const changedDesc =
          hotkeyNext.mode !== st.mode
            ? `Mode switched to ${hotkeyNext.mode.toUpperCase()}`
            : hotkeyNext.effort !== st.effort
              ? `Reasoning effort set to ${hotkeyNext.effort}`
              : `Wire protocol set to ${hotkeyNext.wire}`;
        notice = changedDesc;
        opts.onHotkeyChange(hotkeyNext, changedDesc);
        render();
        return;
      }

      // Ctrl+K -> Interactive Model Picker Modal
      if (key?.ctrl && key.name === "k") {
        finish({ type: "open_model_picker" });
        return;
      }

      // Ctrl+S -> Live Quota & Status Inspector
      if (key?.ctrl && key.name === "s") {
        finish({ type: "open_status" });
        return;
      }

      // Ctrl+C or Ctrl+D
      if (key?.ctrl && (key.name === "c" || key.name === "d")) {
        if (buffer.length > 0) {
          buffer = "";
          cursorPos = 0;
          notice = "Cleared input line (press Ctrl+C again to exit)";
          render();
          return;
        }
        finish({ type: "exit" });
        return;
      }

      // Escape clears current buffer/dropdown
      if (key?.name === "escape") {
        buffer = "";
        cursorPos = 0;
        notice = null;
        render();
        return;
      }

      // Ctrl+U clears line
      if (key?.ctrl && key.name === "u") {
        buffer = "";
        cursorPos = 0;
        render();
        return;
      }

      // Up / Down arrows: navigate dropdown when open, else navigate history
      if (key?.name === "up") {
        if (suggestions.items.length > 0) {
          selectedSuggestionIdx =
            (selectedSuggestionIdx - 1 + suggestions.items.length) %
            suggestions.items.length;
          render();
          return;
        }
        if (opts.history.length > 0 && historyIdx > 0) {
          historyIdx--;
          buffer = opts.history[historyIdx] ?? "";
          cursorPos = buffer.length;
          render();
        }
        return;
      }

      if (key?.name === "down") {
        if (suggestions.items.length > 0) {
          selectedSuggestionIdx =
            (selectedSuggestionIdx + 1) % suggestions.items.length;
          render();
          return;
        }
        if (historyIdx < opts.history.length - 1) {
          historyIdx++;
          buffer = opts.history[historyIdx] ?? "";
          cursorPos = buffer.length;
          render();
        } else if (historyIdx === opts.history.length - 1) {
          historyIdx = opts.history.length;
          buffer = "";
          cursorPos = 0;
          render();
        }
        return;
      }

      // Left / Right / Home / End
      if (key?.name === "left") {
        cursorPos = Math.max(0, cursorPos - 1);
        render();
        return;
      }
      if (key?.name === "right") {
        cursorPos = Math.min(buffer.length, cursorPos + 1);
        render();
        return;
      }
      if (key?.name === "home" || (key?.ctrl && key.name === "a")) {
        cursorPos = 0;
        render();
        return;
      }
      if (key?.name === "end") {
        cursorPos = buffer.length;
        render();
        return;
      }

      // Tab: complete highlighted suggestion
      if (key?.name === "tab" && !key.shift) {
        if (suggestions.items.length > 0) {
          acceptSuggestion(suggestions);
          if (suggestions.kind === "slash") {
            buffer += " ";
            cursorPos = buffer.length;
          }
          render();
        }
        return;
      }

      // Enter / Return
      if (key?.name === "return" || key?.name === "enter") {
        if (suggestions.kind === "file" && suggestions.items.length > 0) {
          // Pressing Enter while @file dropdown is open attaches the file into the prompt
          acceptSuggestion(suggestions);
          render();
          return;
        }
        if (
          (suggestions.kind === "slash" || suggestions.kind === "arg") &&
          suggestions.items.length > 0
        ) {
          const chosen = suggestions.items[selectedSuggestionIdx];
          if (chosen && buffer.trim() !== chosen.value) {
            buffer = chosen.value;
            cursorPos = buffer.length;
            if (chosen.value.endsWith(" ")) {
              render();
              return;
            }
          }
        }
        const finalLine = buffer.trim();
        if (!finalLine) {
          render();
          return;
        }
        finish({ type: "submit", line: finalLine });
        return;
      }

      // Backspace / Delete
      if (key?.name === "backspace") {
        if (cursorPos > 0) {
          buffer = buffer.slice(0, cursorPos - 1) + buffer.slice(cursorPos);
          cursorPos--;
          selectedSuggestionIdx = 0;
          notice = null;
          render();
        }
        return;
      }
      if (key?.name === "delete") {
        if (cursorPos < buffer.length) {
          buffer = buffer.slice(0, cursorPos) + buffer.slice(cursorPos + 1);
          selectedSuggestionIdx = 0;
          render();
        }
        return;
      }

      // Printable text (including multi-char paste)
      if (str && !key?.ctrl && !key?.meta) {
        const clean = str.replace(/[\r\n]+/g, " ");
        if (clean.length > 0 && clean >= " ") {
          buffer = buffer.slice(0, cursorPos) + clean + buffer.slice(cursorPos);
          cursorPos += clean.length;
          selectedSuggestionIdx = 0;
          notice = null;
          render();
        }
      }
    };

    stdin.on("keypress", onKeypress);
  });
}

/**
 * Interactive single-keystroke approval bar for SAFE mode (`←`/`→` or `y`/`a`/`n`/`Esc`).
 */
export async function interactiveConfirmBar(
  description: string,
): Promise<"yes" | "always" | "no"> {
  if (!stdin.isTTY || !stdout.isTTY) return "no";

  const choices: Array<{ key: "yes" | "always" | "no"; label: string }> = [
    { key: "yes", label: "Yes, allow (y)" },
    { key: "always", label: "Always allow in session (a)" },
    { key: "no", label: "No, skip (n/Esc)" },
  ];
  let idx = 0;

  const render = () => {
    const pills = choices
      .map((ch, i) => {
        if (i === idx) {
          return ch.key === "no"
            ? c.bgAmberBadge(`❯ ${ch.label}`)
            : c.bgCyanBadge(`❯ ${ch.label}`);
        }
        return c.bgDarkBadge(ch.label);
      })
      .join("  ");
    stdout.write(`\r\x1b[2K  ${c.amber("?")} ${c.bold(description)}  ${pills}`);
  };

  return new Promise<"yes" | "always" | "no">((resolvePromise) => {
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    stdout.write("\n");
    render();

    const cleanup = (result: "yes" | "always" | "no") => {
      stdin.off("keypress", onKey);
      stdout.write("\r\x1b[2K");
      if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
      resolvePromise(result);
    };

    const onKey = (
      str: string | undefined,
      key: { name?: string; ctrl?: boolean } | undefined,
    ) => {
      if (key?.name === "left") {
        idx = (idx - 1 + choices.length) % choices.length;
        render();
        return;
      }
      if (key?.name === "right" || key?.name === "tab") {
        idx = (idx + 1) % choices.length;
        render();
        return;
      }
      if (key?.name === "return" || key?.name === "enter") {
        cleanup(choices[idx]!.key);
        return;
      }
      if (key?.name === "escape" || (key?.ctrl && key.name === "c") || str === "n" || str === "N") {
        cleanup("no");
        return;
      }
      if (str === "y" || str === "Y") {
        cleanup("yes");
        return;
      }
      if (str === "a" || str === "A") {
        cleanup("always");
      }
    };

    stdin.on("keypress", onKey);
  });
}
