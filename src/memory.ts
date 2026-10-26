import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type MemoryCategory =
  | "preference"
  | "architecture"
  | "bug_lesson"
  | "workflow"
  | "skill_insight";

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  title: string;
  content: string;
  tags: string[];
  projectScope: string;
  createdAt: string;
  updatedAt: string;
  useCount: number;
}

export function defaultMemoryFilePath(): string {
  return join(homedir(), ".aivokey", "memory", "memories.jsonl");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

/**
 * Self-Learning Persistent Memory Engine (inspired by OpenViking in DSH & Hermes Agent).
 * Stores reusable engineering lessons, bug root-causes, and user preferences across sessions.
 * Recalled memories are injected as pre-step user context so the static system prompt cache
 * is never invalidated.
 */
export class SelfLearningMemory {
  readonly filePath: string;
  private entries: MemoryEntry[] = [];

  constructor(filePath: string = defaultMemoryFilePath()) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      this.entries = [];
      return;
    }
    try {
      const lines = readFileSync(this.filePath, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);
      this.entries = lines.map((l) => JSON.parse(l) as MemoryEntry);
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload = this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(this.filePath, payload, "utf8");
  }

  remember(input: {
    category: MemoryCategory;
    title: string;
    content: string;
    tags?: string[];
    projectScope?: string;
  }): MemoryEntry {
    const now = new Date().toISOString();
    const scope = (input.projectScope ?? "global").trim() || "global";
    const normTitle = input.title.trim().toLowerCase();

    const existing = this.entries.find(
      (e) =>
        e.title.trim().toLowerCase() === normTitle &&
        e.projectScope === scope,
    );

    if (existing) {
      existing.category = input.category;
      existing.content = input.content.trim();
      existing.tags = input.tags ?? existing.tags;
      existing.updatedAt = now;
      existing.useCount += 1;
      this.save();
      return existing;
    }

    const entry: MemoryEntry = {
      id: `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      category: input.category,
      title: input.title.trim(),
      content: input.content.trim(),
      tags: (input.tags ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean),
      projectScope: scope,
      createdAt: now,
      updatedAt: now,
      useCount: 1,
    };

    this.entries.push(entry);
    this.save();
    return entry;
  }

  recall(query: string, projectScope: string = "global", limit: number = 5): MemoryEntry[] {
    if (this.entries.length === 0) return [];
    const qTokens = new Set(tokenize(query));
    if (qTokens.size === 0) {
      return this.entries
        .filter((e) => e.projectScope === projectScope || e.projectScope === "global")
        .slice(-limit)
        .reverse();
    }

    const scored: Array<{ entry: MemoryEntry; score: number }> = [];
    for (const entry of this.entries) {
      if (
        entry.projectScope !== "global" &&
        projectScope !== "global" &&
        entry.projectScope !== projectScope
      ) {
        continue;
      }

      let score = 0;
      const hayTokens = tokenize(`${entry.title} ${entry.content} ${entry.tags.join(" ")}`);
      for (const t of hayTokens) {
        if (qTokens.has(t)) score += 3;
      }
      for (const tag of entry.tags) {
        if (qTokens.has(tag)) score += 5;
      }
      if (entry.projectScope === projectScope) score += 2;
      if (entry.category === "preference") score += 1;

      if (score > 0) {
        scored.push({ entry, score });
      }
    }

    scored.sort(
      (a, b) =>
        b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt),
    );
    return scored.slice(0, limit).map((s) => s.entry);
  }

  formatRecallBlock(query: string, projectScope: string = "global", limit: number = 4): string {
    const recalled = this.recall(query, projectScope, limit);
    if (recalled.length === 0) return "";
    const bullets = recalled.map(
      (m) => `- [${m.category}] **${m.title}**: ${m.content}`,
    );
    return `<recalled-memories>\n${bullets.join("\n")}\n</recalled-memories>`;
  }

  listAll(): MemoryEntry[] {
    return [...this.entries];
  }

  forget(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length !== before) {
      this.save();
      return true;
    }
    return false;
  }
}
