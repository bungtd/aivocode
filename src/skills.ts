import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  sourcePath: string;
  baseDir: string;
}

export interface LoadedSkill extends SkillSummary {
  body: string;
  supportingFiles: string[];
}

export interface SkillRegistryOptions {
  cwd?: string;
  globalSkillsDir?: string;
}

function parseMarkdownSkill(raw: string, fallbackId: string): {
  name: string;
  description: string;
  body: string;
} {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) {
    return {
      name: fallbackId,
      description: `Skill ${fallbackId}`,
      body: raw.trim(),
    };
  }
  const frontmatter = fmMatch[1] ?? "";
  const body = (fmMatch[2] ?? "").trim();

  let name = fallbackId;
  let description = "";
  for (const line of frontmatter.split(/\r?\n/)) {
    const mName = line.match(/^name:\s*(.+)$/i);
    if (mName?.[1]) name = mName[1].trim().replace(/^["']|["']$/g, "");
    const mDesc = line.match(/^description:\s*(.+)$/i);
    if (mDesc?.[1]) description = mDesc[1].trim().replace(/^["']|["']$/g, "");
  }

  return { name, description, body };
}

/**
 * Multi-Harness Skill Discovery & Self-Evolving Skill Creator.
 * Discovers skills from `.claude/skills`, `.agents/skills`, `.dsh/skills`, `.opencode/skills`,
 * and `.aivokey/skills`, and allows AivoCode to create/evolve new `SKILL.md` capabilities.
 */
export class SkillRegistry {
  readonly cwd: string;
  readonly globalSkillsDir: string;
  private skillsMap = new Map<string, SkillSummary>();

  constructor(opts: SkillRegistryOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.globalSkillsDir =
      opts.globalSkillsDir ?? join(homedir(), ".aivokey", "skills");
    this.refresh();
  }

  refresh(): void {
    this.skillsMap.clear();
    const home = homedir();
    const roots = [
      join(home, ".claude", "skills"),
      join(home, ".agents", "skills"),
      join(home, ".dsh", "skills"),
      join(home, ".config", "opencode", "skills"),
      this.globalSkillsDir,
      join(this.cwd, ".claude", "skills"),
      join(this.cwd, ".agents", "skills"),
      join(this.cwd, ".dsh", "skills"),
      join(this.cwd, ".opencode", "skills"),
      join(this.cwd, ".aivokey", "skills"),
    ];

    for (const root of roots) {
      this.scanRoot(root);
    }
  }

  private scanRoot(rootDir: string): void {
    if (!existsSync(rootDir)) return;
    let entries;
    try {
      entries = readdirSync(rootDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = join(rootDir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const id = entry.name.replace(/\.md$/i, "");
        this.registerSkillFile(id, fullPath, rootDir);
      } else if (entry.isDirectory()) {
        const skillMd = join(fullPath, "SKILL.md");
        if (existsSync(skillMd)) {
          this.registerSkillFile(entry.name, skillMd, fullPath);
        }
      }
    }
  }

  private registerSkillFile(id: string, filePath: string, baseDir: string): void {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = parseMarkdownSkill(raw, id);
      if (!parsed.description) return;
      this.skillsMap.set(id, {
        id,
        name: parsed.name,
        description: parsed.description,
        sourcePath: filePath,
        baseDir,
      });
    } catch {
      /* ignore unreadable skill */
    }
  }

  listSkills(): SkillSummary[] {
    return [...this.skillsMap.values()];
  }

  loadSkill(id: string): LoadedSkill | null {
    const summary = this.skillsMap.get(id);
    if (!summary || !existsSync(summary.sourcePath)) return null;
    try {
      const raw = readFileSync(summary.sourcePath, "utf8");
      const parsed = parseMarkdownSkill(raw, id);
      const supportingFiles: string[] = [];
      try {
        const entries = readdirSync(summary.baseDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name === "SKILL.md" || e.name.startsWith(".")) continue;
          supportingFiles.push(join(summary.baseDir, e.name));
          if (supportingFiles.length >= 10) break;
        }
      } catch {
        /* ignore */
      }
      return {
        ...summary,
        body: parsed.body,
        supportingFiles,
      };
    } catch {
      return null;
    }
  }

  /**
   * Self-evolving capability: creates or updates a reusable `SKILL.md` so AivoCode
   * permanently retains new workflows, domain patterns, and engineering techniques.
   */
  createOrEvolveSkill(input: {
    id: string;
    name: string;
    description: string;
    body: string;
    scope?: "global" | "project";
  }): LoadedSkill {
    const cleanId = input.id
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!cleanId) {
      throw new Error("Skill ID cannot be empty");
    }

    const targetRoot =
      input.scope === "project"
        ? join(this.cwd, ".aivokey", "skills")
        : this.globalSkillsDir;
    const skillDir = join(targetRoot, cleanId);
    const skillFile = join(skillDir, "SKILL.md");

    mkdirSync( dirname(skillFile), { recursive: true });
    const markdown = [
      "---",
      `name: ${input.name.trim() || cleanId}`,
      `description: ${input.description.trim()}`,
      "---",
      "",
      input.body.trim(),
      "",
    ].join("\n");

    writeFileSync(skillFile, markdown, "utf8");
    this.refresh();
    return this.loadSkill(cleanId)!;
  }
}
