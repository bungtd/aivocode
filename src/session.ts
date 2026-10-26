import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { AivoWire } from "./config.js";
import type { ChatMessage } from "./protocol.js";

export interface AivoSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  wire: AivoWire;
  cwd: string;
  parentSessionId?: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCostMicro: string;
  messages: ChatMessage[];
}

export function generateSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(5).toString("hex");
  return `ses_${ts}_${rand}`;
}

export function defaultSessionsDir(): string {
  return join(homedir(), ".aivokey", "sessions");
}

export class SessionStore {
  readonly dir: string;

  constructor(dir: string = defaultSessionsDir()) {
    this.dir = dir;
  }

  createSession(init: {
    model: string;
    wire: AivoWire;
    cwd: string;
    parentSessionId?: string | null;
  }): AivoSession {
    const now = new Date().toISOString();
    return {
      id: generateSessionId(),
      createdAt: now,
      updatedAt: now,
      model: init.model,
      wire: init.wire,
      cwd: init.cwd,
      parentSessionId: init.parentSessionId ?? null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalCostMicro: "0",
      messages: [],
    };
  }

  private filePath(id: string): string {
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "");
    return join(this.dir, `${safeId}.jsonl`);
  }

  saveSession(session: AivoSession): void {
    mkdirSync(this.dir, { recursive: true });
    session.updatedAt = new Date().toISOString();
    const { messages, ...meta } = session;
    const lines = [
      JSON.stringify({ type: "meta", ...meta }),
      ...messages.map((m) => JSON.stringify({ type: "message", message: m })),
    ];
    writeFileSync(this.filePath(session.id), lines.join("\n") + "\n", "utf8");
  }

  loadSession(id: string): AivoSession | null {
    const path = this.filePath(id);
    if (!existsSync(path)) return null;
    try {
      const lines = readFileSync(path, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);
      if (lines.length === 0) return null;
      const meta = JSON.parse(lines[0]!) as Record<string, unknown>;
      const messages: ChatMessage[] = [];
      for (let i = 1; i < lines.length; i++) {
        const row = JSON.parse(lines[i]!) as { type?: string; message?: ChatMessage };
        if (row.type === "message" && row.message) {
          messages.push(row.message);
        }
      }
      return {
        id: String(meta.id ?? id),
        createdAt: String(meta.createdAt ?? new Date().toISOString()),
        updatedAt: String(meta.updatedAt ?? new Date().toISOString()),
        model: String(meta.model ?? "deepseek-v4-pro"),
        wire: (meta.wire === "messages" || meta.wire === "responses" ? meta.wire : "chat") as AivoWire,
        cwd: String(meta.cwd ?? process.cwd()),
        parentSessionId: typeof meta.parentSessionId === "string" ? meta.parentSessionId : null,
        totalInputTokens: Number(meta.totalInputTokens ?? 0),
        totalOutputTokens: Number(meta.totalOutputTokens ?? 0),
        totalCacheReadTokens: Number(meta.totalCacheReadTokens ?? 0),
        totalCacheWriteTokens: Number(meta.totalCacheWriteTokens ?? 0),
        totalCostMicro: String(meta.totalCostMicro ?? "0"),
        messages,
      };
    } catch {
      return null;
    }
  }

  forkSession(sourceId: string): AivoSession | null {
    const source = this.loadSession(sourceId);
    if (!source) return null;
    const forked = this.createSession({
      model: source.model,
      wire: source.wire,
      cwd: source.cwd,
      parentSessionId: source.id,
    });
    forked.messages = source.messages.map((m) => ({ ...m }));
    this.saveSession(forked);
    return forked;
  }

  listSessions(limit: number = 25): Array<Omit<AivoSession, "messages"> & { messageCount: number }> {
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".jsonl"));
    const items: Array<Omit<AivoSession, "messages"> & { messageCount: number }> = [];
    for (const f of files) {
      const id = f.replace(/\.jsonl$/, "");
      const s = this.loadSession(id);
      if (s) {
        const { messages, ...meta } = s;
        items.push({ ...meta, messageCount: messages.length });
      }
    }
    return items
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }
}
