import { describe, expect, it } from "vitest";
import {
  buildJobOptions,
  buildModelOptions,
  buildSessionOptions,
  buildSubagentOptions,
  buildTeamOptions,
  modelForRole,
  sidebarTaskRows,
  teamSummary,
} from "../src/ui/modal-options.js";
import { DEFAULT_AIVOKEY_CATALOG } from "../src/aivokey-client.js";

const formatCost = (micro: bigint) => `$${(Number(micro) / 1_000_000).toFixed(2)}`;

describe("modal option builders", () => {
  it("labels models with capabilities and price", () => {
    const rows = buildModelOptions(DEFAULT_AIVOKEY_CATALOG, null);
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0]!;
    expect(first.value.length).toBeGreaterThan(0);
    expect(first.detail).toContain("ctx");
    expect(first.detail).toContain("$");
  });

  it("offers every specialist team with its role chain", () => {
    const rows = buildTeamOptions();
    expect(rows.map((r) => r.value)).toContain("fullstack");
    expect(rows.map((r) => r.value)).toContain("autopilot");
    expect(rows[0]!.badge).toMatch(/\[.*→.*\]/);
  });

  it("marks the active session and shows its stats", () => {
    const rows = buildSessionOptions(
      [
        {
          id: "ses_a",
          model: "deepseek-v4.1-flash",
          messageCount: 12,
          totalCostMicro: "1200000",
          updatedAt: "2026-11-09T10:00:00.000Z",
        },
        {
          id: "ses_b",
          model: "glm-5.3",
          messageCount: 3,
          totalCostMicro: "0",
          updatedAt: "2026-11-08T18:22:00.000Z",
        },
      ],
      "ses_a",
      formatCost,
    );
    expect(rows[0]!.label).toContain("(current)");
    expect(rows[1]!.label).not.toContain("(current)");
    expect(rows[0]!.detail).toContain("12 msgs");
    expect(rows[0]!.detail).toContain("$1.20");
    expect(rows[0]!.badge).toBe("[deepseek-v4.1-flash]");
  });

  it("summarises subagent runs and background jobs", () => {
    const subs = buildSubagentOptions([
      { id: "sub_1", name: "general", description: "fix tests", model: "glm-5.3", status: "completed", logs: [] },
    ]);
    expect(subs[0]!.label).toContain("sub_1");
    expect(subs[0]!.badge).toContain("COMPLETED");

    const jobs = buildJobOptions([
      {
        id: "job_1",
        command: "npm run dev",
        status: "running",
        logs: [],
        detectedUrl: "http://localhost:3000",
        pid: 1,
        startedAt: "",
      } as never,
    ]);
    expect(jobs[0]!.badge).toContain("RUNNING");
  });

  it("caps sidebar task rows and marks state", () => {
    const todos = Array.from({ length: 9 }, (_, i) => ({
      id: String(i),
      content: `task ${i}`,
      status: i === 0 ? "completed" : i === 1 ? "in_progress" : "pending",
    })) as never;
    const rows = sidebarTaskRows(todos);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ done: true, active: false });
    expect(rows[1]).toMatchObject({ done: false, active: true });
  });

  it("resolves the configured model per subagent role", () => {
    const config = {
      model: "primary",
      fastModel: "fast",
      architectModel: "arch",
      builderModel: null,
      reviewerModel: "review",
    };
    expect(modelForRole("explore", config)).toBe("fast");
    expect(modelForRole("architect", config)).toBe("arch");
    expect(modelForRole("builder", config)).toBe("primary");
    expect(modelForRole("reviewer", config)).toBe("review");
    expect(modelForRole("all", config)).toBe("fast");
  });

  it("summarises the active team for the sidebar", () => {
    const summary = teamSummary("backend");
    expect(summary.label.length).toBeGreaterThan(0);
    expect(summary.badges).toContain("→");
  });
});
