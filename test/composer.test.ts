import { describe, expect, it } from "vitest";
import {
  computeComposerSuggestions,
  fuzzyMatchFiles,
  applyComposerHotkeys,
  renderComposerFrame,
} from "../src/ui/composer.js";
import { stripAnsi } from "../src/ui/theme.js";

describe("Interactive TUI Composer, Live / Command Palette, @file Fuzzy Finder & Hotkeys", () => {
  it("opens live slash command palette as soon as user types '/'", () => {
    const state1 = computeComposerSuggestions("/", ["src/index.ts"]);
    expect(state1.kind).toBe("slash");
    expect(state1.items.length).toBeGreaterThan(5);
    expect(state1.items[0]?.value).toBe("/model");

    const state2 = computeComposerSuggestions("/ef", ["src/index.ts"]);
    expect(state2.kind).toBe("slash");
    expect(state2.items[0]?.value).toBe("/effort");
  });

  it("opens live @file fuzzy finder as soon as user types '@' anywhere in the prompt", () => {
    const files = [
      "package.json",
      "src/index.ts",
      "src/aivokey-client.ts",
      "src/ui/composer.ts",
      "test/agent.test.ts",
    ];

    const s1 = computeComposerSuggestions("Please check @", files);
    expect(s1.kind).toBe("file");
    expect(s1.items.length).toBe(5);

    const s2 = computeComposerSuggestions("Refactor @aivoclient", files);
    expect(s2.kind).toBe("file");
    expect(s2.items[0]?.value).toBe("src/aivokey-client.ts");
  });

  it("scores and ranks fuzzy file matches accurately", () => {
    const files = ["README.md", "src/repl.ts", "src/ui/theme.ts", "src/aivokey-client.ts"];
    const ranked = fuzzyMatchFiles("theme", files);
    expect(ranked[0]).toBe("src/ui/theme.ts");
  });

  it("cycles mode (Shift+Tab), effort (Ctrl+E), and wire (Ctrl+W) via single-keystroke hotkeys", () => {
    const initial = {
      mode: "auto" as const,
      effort: "medium" as const,
      wire: "chat" as const,
    };

    // Shift+Tab cycles mode: auto -> plan -> safe -> auto
    const afterShiftTab = applyComposerHotkeys(initial, { name: "tab", shift: true });
    expect(afterShiftTab?.mode).toBe("plan");

    const afterSecondShiftTab = applyComposerHotkeys(
      { ...initial, mode: "plan" },
      { name: "tab", shift: true },
    );
    expect(afterSecondShiftTab?.mode).toBe("safe");

    // Ctrl+E cycles effort: medium -> high
    const afterCtrlE = applyComposerHotkeys(initial, { name: "e", ctrl: true });
    expect(afterCtrlE?.effort).toBe("high");

    // Ctrl+W cycles wire: chat -> messages
    const afterCtrlW = applyComposerHotkeys(initial, { name: "w", ctrl: true });
    expect(afterCtrlW?.wire).toBe("messages");
  });

  it("renders a bordered composer frame with live dropdown popover and hotkey footer", () => {
    const suggestions = computeComposerSuggestions("/mo", ["src/index.ts"]);
    const frame = stripAnsi(
      renderComposerFrame({
        buffer: "/mo",
        cursorPos: 3,
        mode: "auto",
        model: "deepseek-v4.1-flash",
        effort: "high",
        wire: "chat",
        usedContextTokens: 2400,
        maxContextTokens: 1_000_000,
        cacheHitPct: 88,
        sessionCostMicro: 4200n,
        balanceMicro: 9_929_530_000n,
        gitBranch: "main",
        suggestions,
        selectedSuggestionIdx: 0,
      }),
    );

    expect(frame).toContain("AUTO");
    expect(frame).toContain("deepseek-v4.1-flash");
    expect(frame).toContain("❯ /mo");
    expect(frame).toContain("/model");
    expect(frame).toContain("/models");
    expect(frame).toContain("/mode");
    expect(frame).toContain("Shift+Tab");
    expect(frame).toContain("Ctrl+K");
    expect(frame).toContain("Ctrl+E");
  });
});
