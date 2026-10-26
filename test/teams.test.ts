import { describe, expect, it } from "vitest";
import {
  AGENT_TEAMS,
  getAgentTeam,
  detectRecommendedTeam,
  runTeamWorkflow,
  runParallelSubagents,
} from "../src/teams.js";

describe("Multi-Agent Teams & Domain Workflows (Fullstack, Backend, Frontend, Android, Blender 3D, GameDev, Autopilot)", () => {
  it("defines all 7 production specialist agent teams with complete roles and workflow stages", () => {
    const teamIds = AGENT_TEAMS.map((t) => t.id);
    expect(teamIds).toEqual([
      "fullstack",
      "backend",
      "frontend",
      "android",
      "blender3d",
      "gamedev",
      "autopilot",
    ]);

    for (const team of AGENT_TEAMS) {
      expect(team.roles.length).toBeGreaterThanOrEqual(3);
      expect(team.workflowStages.length).toBeGreaterThanOrEqual(3);
      expect(team.systemPromptAddendum.length).toBeGreaterThan(50);
    }
  });

  it("auto-detects the appropriate specialist team from user prompt and project context", () => {
    expect(detectRecommendedTeam("Buatkan script bpy untuk rigging karakter 3D di Blender")).toBe("blender3d");
    expect(detectRecommendedTeam("Buat aplikasi Android dengan Jetpack Compose dan Room database")).toBe("android");
    expect(detectRecommendedTeam("Buat game 2D platformer di Godot 4 dengan GDScript")).toBe("gamedev");
    expect(detectRecommendedTeam("Optimasi query Postgres dan endpoint REST API di gateway")).toBe("backend");
    expect(detectRecommendedTeam("Perbaiki animasi komponen navbar dan responsive CSS Tailwind")).toBe("frontend");
    expect(detectRecommendedTeam("Saya tidak mengerti coding, tolong buatkan aplikasi kasir siap pakai")).toBe("autopilot");
    expect(detectRecommendedTeam("Bangun fitur checkout lengkap dari database, API hingga halaman pembayaran React")).toBe("fullstack");
  });

  it("executes a multi-stage team workflow passing handoff context from Architect -> Builder -> QA Reviewer", async () => {
    const team = getAgentTeam("backend")!;
    const executedStages: Array<{ stageId: string; roleId: string; readOnly: boolean }> = [];

    const result = await runTeamWorkflow({
      team,
      goal: "Add rate limiting to POST /v1/login",
      executeStageAgent: async (stage, role, stagePrompt) => {
        executedStages.push({
          stageId: stage.id,
          roleId: role.id,
          readOnly: role.readOnly,
        });
        expect(stagePrompt).toContain("Add rate limiting to POST /v1/login");
        return `Completed ${stage.title} by ${role.name}`;
      },
    });

    expect(executedStages).toHaveLength(team.workflowStages.length);
    // First stage (Architect) is read-only
    expect(executedStages[0]?.readOnly).toBe(true);
    // Second stage (Implementer) is read-write
    expect(executedStages[1]?.readOnly).toBe(false);
    expect(result.finalSummary).toContain("Completed");
    expect(result.stageOutputs).toHaveLength(team.workflowStages.length);
  });

  it("dispatches parallel subagents concurrently and aggregates their reports", async () => {
    const tasks = [
      { id: "t1", agent: "explore" as const, description: "Check auth routes", prompt: "Inspect src/auth" },
      { id: "t2", agent: "explore" as const, description: "Check db schema", prompt: "Inspect src/db" },
    ];

    const results = await runParallelSubagents(tasks, async (task) => {
      return `Report for ${task.id}: ${task.description} OK`;
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.output).toContain("Report for t1");
    expect(results[1]?.output).toContain("Report for t2");
  });
});
