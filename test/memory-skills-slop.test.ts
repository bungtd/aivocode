import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SelfLearningMemory } from "../src/memory.js";
import { SkillRegistry } from "../src/skills.js";
import { auditCodeForSlop } from "../src/anti-slop.js";

describe("Self-Learning Memory, Self-Evolving Skills & Anti-AI-Slop Guard", () => {
  it("stores, deduplicates, recalls, and auto-reflects lessons in SelfLearningMemory", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-mem-"));
    try {
      const mem = new SelfLearningMemory(join(dir, "memories.jsonl"));
      mem.remember({
        category: "bug_lesson",
        title: "Vitest embedded postgres port conflict",
        content: "Kill embedded-postgres on port 54329 before running pnpm test.",
        tags: ["vitest", "postgres", "test"],
        projectScope: "aivokey",
      });

      mem.remember({
        category: "preference",
        title: "Package manager preference",
        content: "Always use pnpm instead of npm or yarn.",
        tags: ["pnpm", "workflow"],
        projectScope: "global",
      });

      const hits = mem.recall("postgres test failure", "aivokey", 5);
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0]?.title).toContain("postgres");

      const block = mem.formatRecallBlock("postgres test", "aivokey");
      expect(block).toContain("Kill embedded-postgres on port 54329");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers skills across .opencode/.dsh/.aivokey and creates new self-evolving skills", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-skills-"));
    try {
      const dshSkillDir = join(dir, ".dsh", "skills", "neon-postgres");
      mkdirSync(dshSkillDir, { recursive: true });
      writeFileSync(
        join(dshSkillDir, "SKILL.md"),
        "---\nname: Neon Postgres\ndescription: Best practices for Lakebase Postgres on Neon\n---\nAlways use pooled connections for serverless.",
        "utf8",
      );

      const registry = new SkillRegistry({
        cwd: dir,
        globalSkillsDir: join(dir, "global-skills"),
      });

      const list = registry.listSkills();
      expect(list.some((s) => s.id === "neon-postgres")).toBe(true);

      const loaded = registry.loadSkill("neon-postgres");
      expect(loaded).not.toBeNull();
      expect(loaded?.body).toContain("Always use pooled connections");

      // Self-evolve a brand new skill!
      const evolved = registry.createOrEvolveSkill({
        id: "blender-procedural-rig",
        name: "Blender Procedural Rig",
        description: "Automated armature and weight painting in Blender bpy",
        body: "## Steps\n1. Create armature in bpy\n2. Parent mesh with automatic weights",
        scope: "global",
      });
      expect(evolved.id).toBe("blender-procedural-rig");
      expect(registry.loadSkill("blender-procedural-rig")?.body).toContain("Create armature in bpy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects AI slop patterns (placeholder comments, unimplemented stubs, blind as any)", () => {
    const sloppyCode = [
      "export function processOrder(input: any) {",
      "  // TODO: implement payment validation",
      "  // ... rest of implementation here",
      "  const x = (input as any).value;",
      "  return x;",
      "}",
    ].join("\n");

    const report = auditCodeForSlop("src/order.ts", sloppyCode);
    expect(report.clean).toBe(false);
    expect(report.issues.length).toBeGreaterThanOrEqual(3);
    expect(report.issues.some((i) => i.rule === "placeholder_truncation")).toBe(true);
    expect(report.issues.some((i) => i.rule === "todo_stub")).toBe(true);
  });
});
