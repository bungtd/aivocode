import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BackgroundJobManager } from "../src/background-jobs.js";
import {
  filterEligibleModelsForAccount,
  DEFAULT_AIVOKEY_CATALOG,
} from "../src/aivokey-client.js";
import {
  parseReviewerVerdict,
  runIterativeReviewFixLoop,
} from "../src/workflow-review.js";
import {
  parseSgrMouseEvent,
  stripMouseEscapeGarbage,
  formatSessionExitBanner,
  renderFullScreenAnsiBuffer,
  type FullScreenTuiState,
} from "../src/ui/fullscreen.js";
import { VIEWPORT_PRESETS } from "../src/computer-use.js";

describe("AivoCode v1.1 Fixes: Background Jobs, Plan-Aware Model Filtering, Iterative Review->Fix Loop, SGR Mouse/Scroll, Multi-Viewport & Exit Summary", () => {
  it("1. manages background terminal jobs, captures live stdout/stderr logs, detects listening URLs, and kills cleanly", async () => {
    const manager = new BackgroundJobManager();
    const job = manager.startJob({
      command: `node -e "console.log('Server listening on http://127.0.0.1:4321'); setTimeout(() => {}, 5000)"`,
      cwd: process.cwd(),
    });

    expect(job.id).toMatch(/^job_/);
    // Condition-based wait for stdout line (up to 3000ms for PowerShell startup on Windows)
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !manager.getJob(job.id)?.detectedUrl) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const updated = manager.getJob(job.id)!;
    expect(updated.logs.join("\n")).toContain("http://127.0.0.1:4321");
    expect(updated.detectedUrl).toBe("http://127.0.0.1:4321");

    const killed = manager.killJob(job.id);
    expect(killed).toBe(true);
    manager.stopAll();
  });

  it("2. filters eligible models for plan accounts (blocking models not in plan when fallback is off) vs PAYG accounts", () => {
    const planKeyStatus = {
      mode: "plan" as const,
      balanceMicro: 0n,
      fallbackEnabled: false,
      freeTokens: [{ model: "glm-5.3-flash", remainingTokens: 100_000n }],
      purchasedTokens: [],
      plan: { name: "Starter Plan", allowanceMode: "per_model" as const },
      models: [
        {
          model: "deepseek-v4-flash",
          w5h: { limitMicro: 5_000_000n, usedMicro: 100_000n, resetAt: "" },
          w7d: { limitMicro: 20_000_000n, usedMicro: 100_000n, resetAt: "" },
          month: { limitMicro: 50_000_000n, usedMicro: 100_000n, resetAt: "" },
        },
      ],
      global: null,
    };

    const eligibleForPlan = filterEligibleModelsForAccount(
      DEFAULT_AIVOKEY_CATALOG,
      planKeyStatus,
    );
    const eligibleIds = eligibleForPlan.map((m) => m.id);
    expect(eligibleIds).toContain("deepseek-v4-flash");
    expect(eligibleIds).toContain("glm-5.3-flash");
    expect(eligibleIds).not.toContain("claude-opus-5-5");

    const paygKeyStatus = {
      ...planKeyStatus,
      mode: "payg" as const,
      balanceMicro: 5_000_000n,
    };
    const eligibleForPayg = filterEligibleModelsForAccount(
      DEFAULT_AIVOKEY_CATALOG,
      paygKeyStatus,
    );
    expect(eligibleForPayg.length).toBe(DEFAULT_AIVOKEY_CATALOG.length);
  });

  it("3. executes separated iterative Review -> Fix -> Re-Review -> Re-Fix loop until VERDICT: PASS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-revfix-"));
    try {
      const targetFile = join(dir, "app.js");
      writeFileSync(targetFile, "// TODO: implement login\nconst x = 1;\n", "utf8");

      const events: string[] = [];
      let reviewRound = 0;

      const loopRes = await runIterativeReviewFixLoop({
        cwd: dir,
        modifiedFiles: [targetFile],
        maxRounds: 3,
        onEvent: (msg) => events.push(msg),
        runReviewerAgent: async (round, staticFindings) => {
          reviewRound = round;
          events.push(`reviewer_round_${round}`);
          if (round === 1) {
            expect(staticFindings.length).toBeGreaterThan(0);
            return "VERDICT: NEEDS_FIX\n1. app.js:1 — Remove TODO stub and complete login logic";
          }
          return "VERDICT: PASS\nAll files verified clean and ready.";
        },
        runFixerAgent: async (round, issuesToFix) => {
          events.push(`fixer_round_${round}`);
          expect(issuesToFix.join("\n")).toContain("Remove TODO stub");
          writeFileSync(targetFile, "export function login() { return true; }\n", "utf8");
          return "Fixed app.js";
        },
      });

      expect(loopRes.passed).toBe(true);
      expect(loopRes.roundsRun).toBe(2);
      expect(reviewRound).toBe(2);
      // Verify strict separation: reviewer_round_1 -> fixer_round_1 -> reviewer_round_2
      expect(events).toContain("reviewer_round_1");
      expect(events).toContain("fixer_round_1");
      expect(events).toContain("reviewer_round_2");
      expect(events.indexOf("reviewer_round_1")).toBeLessThan(events.indexOf("fixer_round_1"));
      expect(events.indexOf("fixer_round_1")).toBeLessThan(events.indexOf("reviewer_round_2"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("4. parses SGR mouse wheel and click events and renders synchronized non-scrolling ANSI buffer", () => {
    const wheelUp = parseSgrMouseEvent("\x1b[<64;45;12M");
    expect(wheelUp).toEqual({ type: "wheel_up", x: 45, y: 12 });

    const wheelDown = parseSgrMouseEvent("\x1b[<65;45;12M");
    expect(wheelDown).toEqual({ type: "wheel_down", x: 45, y: 12 });

    const leftClick = parseSgrMouseEvent("\x1b[<0;105;18M");
    expect(leftClick).toEqual({ type: "click", x: 105, y: 18 });

    // Verify both complete and character-by-character partial SGR mouse sequences are stripped immediately
    expect(stripMouseEscapeGarbage("halo<35;84;19M")).toBe("halo");
    expect(stripMouseEscapeGarbage("\x1b[<64;80;20M<0;45;12mtest")).toBe("test");
    expect(stripMouseEscapeGarbage("<35;102;24M")).toBe("");
    expect(stripMouseEscapeGarbage("halo<35;84;")).toBe("halo");

    // Simulate character-by-character arrival from Node's emitKeypressEvents
    let simulatedBuf = "cek ";
    for (const ch of "<35;84;19M<0;12;8m") {
      simulatedBuf += ch;
    }
    expect(stripMouseEscapeGarbage(simulatedBuf)).toBe("cek ");
    expect(stripMouseEscapeGarbage("cek 35;84;19M0;12;8m")).toBe("cek ");

    const dummyState: FullScreenTuiState = {
      cols: 100,
      rows: 24,
      showSidebar: true,
      version: "1.1.0",
      cwd: "C:/Dev/Projects/app",
      gitBranch: "main",
      gatewayUrl: "https://api.aivokey.dev",
      model: "deepseek-v4-flash",
      fastModel: "glm-5.3-flash",
      wire: "chat",
      effort: "off",
      mode: "auto",
      sessionId: "ses_test_sync",
      usedContextTokens: 500,
      maxContextTokens: 1_000_000,
      cacheHitPct: 90,
      sessionCostMicro: 1000n,
      balanceMicro: 5_000_000n,
      keyStatus: null,
      todos: [],
      modifiedFiles: [],
      subagentRuns: [
        {
          id: "sub_1",
          name: "explore",
          description: "Scan routes",
          model: "glm-5.3-flash",
          status: "completed",
          logs: ["Read src/index.ts"],
        },
      ],
      backgroundJobs: [],
      transcriptLines: ["Line 1", "Line 2"],
      scrollOffset: 0,
      busyLabel: null,
      buffer: "",
      cursorPos: 0,
      suggestions: { kind: "none", query: "", items: [] },
      selectedSuggestionIdx: 0,
      modal: null,
      notice: null,
    };

    const ansiBuf = renderFullScreenAnsiBuffer(dummyState);
    // Must wrap in DEC synchronized output (\x1b[?2026h ... \x1b[?2026l) and position rows explicitly (\x1b[1;1H)
    expect(ansiBuf).toContain("\x1b[?2026h");
    expect(ansiBuf).toContain("\x1b[1;1H");
    expect(ansiBuf).toContain("\x1b[24;1H");
    expect(ansiBuf).toContain("\x1b[?2026l");
  });

  it("5. defines desktop, tablet, and mobile viewports for computer_use and formats the exit session banner", () => {
    expect(VIEWPORT_PRESETS.desktop).toEqual({ width: 1440, height: 900, label: "Desktop (1440×900)" });
    expect(VIEWPORT_PRESETS.tablet).toEqual({ width: 768, height: 1024, label: "Tablet (768×1024)" });
    expect(VIEWPORT_PRESETS.mobile).toEqual({ width: 390, height: 844, label: "Mobile (390×844)" });

    const banner = formatSessionExitBanner({
      sessionId: "ses_exit_99",
      cwd: "C:/Dev/Projects/app",
      model: "deepseek-v4-flash",
      fastModel: "glm-5.3-flash",
      messageCount: 12,
      modifiedFilesCount: 3,
      inputTokens: 15_000,
      cacheReadTokens: 85_000,
      outputTokens: 4_200,
      costMicro: 24_000n,
    });
    expect(banner).toContain("ses_exit_99");
    expect(banner).toContain("aivo -c");
    expect(banner).toContain("aivo -s ses_exit_99");
  });

  it("6. parses reviewer verdict strings accurately", () => {
    const pass = parseReviewerVerdict("VERDICT: PASS\nEverything looks great.");
    expect(pass.passed).toBe(true);
    expect(pass.issues).toHaveLength(0);

    const fail = parseReviewerVerdict(
      "VERDICT: NEEDS_FIX\n1. index.html:42 — Missing closing div\n2. css/styles.css:108 — Broken var(--pos)",
    );
    expect(fail.passed).toBe(false);
    expect(fail.issues).toHaveLength(2);
  });
});
