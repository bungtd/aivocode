import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { writeFileAtomic } from "./fs-util.js";

export interface FileSnapshot {
  existed: boolean;
  content: Buffer | null;
}

export interface TurnCheckpoint {
  turnId: string;
  createdAt: number;
  files: Map<string, FileSnapshot>;
}

export interface UndoResult {
  turnId: string | null;
  restoredFiles: string[];
}

export interface CheckpointManagerOptions {
  /** Directory for on-disk persistence. Omit for in-memory only (tests, one-shot). */
  dir?: string;
  /** Maximum number of turns kept on disk (oldest pruned first). Default 30. */
  maxTurns?: number;
  /** Maximum total bytes of persisted snapshots. Default 256 MiB. */
  maxBytes?: number;
}

interface PersistedSnapshot {
  turnId: string;
  createdAt: number;
  files: Array<{ path: string; existed: boolean; content: string | null }>;
}

interface PersistedRedo {
  turns: PersistedSnapshot[];
}

const DEFAULT_MAX_TURNS = 30;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/** Default per-session checkpoint directory. */
export function defaultCheckpointDir(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  return join(homedir(), ".aivokey", "checkpoints", safe);
}

let checkpointCounter = 0;

function nextSequence(): string {
  checkpointCounter++;
  return `${Date.now().toString(36)}-${checkpointCounter.toString(36)}`;
}

/**
 * Tracks pre-modification file snapshots per turn so `/undo` and `/redo` can cleanly
 * revert and restore file edits without running destructive git resets.
 *
 * When `dir` is provided, turns are persisted as JSON files so undo history
 * survives a process restart and a crash. Snapshots are pruned by count and size.
 */
export class CheckpointManager {
  private turns: TurnCheckpoint[] = [];
  private redoStack: TurnCheckpoint[] = [];
  private activeTurn: TurnCheckpoint | null = null;
  /** Maps a turn ID to its on-disk file name (without directory). */
  private readonly persistNames = new Map<string, string>();
  private readonly dir: string | undefined;
  private readonly maxTurns: number;
  private readonly maxBytes: number;

  constructor(options: CheckpointManagerOptions = {}) {
    this.dir = options.dir;
    this.maxTurns = Math.max(1, options.maxTurns ?? DEFAULT_MAX_TURNS);
    this.maxBytes = Math.max(1_000_000, options.maxBytes ?? DEFAULT_MAX_BYTES);
    if (this.dir) {
      try {
        mkdirSync(this.dir, { recursive: true });
        this.restoreFromDisk();
      } catch {
        // A corrupt or unreadable checkpoint directory must never block a session.
        this.turns = [];
      }
    }
  }

  private restoreFromDisk(): void {
    if (!this.dir) return;
    let entries: string[];
    try {
      entries = readdirSync(this.dir).filter((name) => name.startsWith("turn-") && name.endsWith(".json"));
    } catch {
      return;
    }
    const turns: TurnCheckpoint[] = [];
    for (const name of entries.sort()) {
      const path = join(this.dir, name);
      try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw) as PersistedSnapshot;
        if (!parsed?.turnId || !Array.isArray(parsed.files)) continue;
        const files = new Map<string, FileSnapshot>();
        for (const file of parsed.files) {
          if (typeof file.path !== "string") continue;
          files.set(file.path, {
            existed: Boolean(file.existed),
            content: file.content === null ? null : Buffer.from(file.content, "base64"),
          });
        }
        const turn: TurnCheckpoint = {
          turnId: parsed.turnId,
          createdAt: Number(parsed.createdAt) || Date.now(),
          files,
        };
        this.persistNames.set(turn.turnId, name);
        turns.push(turn);
      } catch {
        // Skip individual corrupt checkpoint files.
      }
    }
    turns.sort((a, b) => a.createdAt - b.createdAt);
    this.turns = turns.slice(-this.maxTurns);
    this.restoreRedoFromDisk();
    this.prune();
  }

  private restoreRedoFromDisk(): void {
    if (!this.dir) return;
    const file = join(this.dir, "redo.json");
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as PersistedRedo;
      if (!Array.isArray(parsed?.turns)) return;
      for (const raw of parsed.turns) {
        if (!raw?.turnId || !Array.isArray(raw.files)) continue;
        const files = new Map<string, FileSnapshot>();
        for (const entry of raw.files) {
          if (typeof entry.path !== "string") continue;
          files.set(entry.path, {
            existed: Boolean(entry.existed),
            content: entry.content === null ? null : Buffer.from(entry.content, "base64"),
          });
        }
        this.redoStack.push({
          turnId: raw.turnId,
          createdAt: Number(raw.createdAt) || Date.now(),
          files,
        });
      }
    } catch {
      // ignore corrupt redo history
    }
  }

  private persistNameFor(turn: TurnCheckpoint): string {
    const existing = this.persistNames.get(turn.turnId);
    if (existing) return existing;
    const name = `turn-${nextSequence()}-${turn.turnId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)}.json`;
    this.persistNames.set(turn.turnId, name);
    return name;
  }

  private serialize(turn: TurnCheckpoint): PersistedSnapshot {
    return {
      turnId: turn.turnId,
      createdAt: turn.createdAt,
      files: [...turn.files.entries()].map(([path, snap]) => ({
        path,
        existed: snap.existed,
        content: snap.content ? snap.content.toString("base64") : null,
      })),
    };
  }

  private persist(turn: TurnCheckpoint): void {
    if (!this.dir) return;
    try {
      const name = this.persistNameFor(turn);
      writeFileAtomic(join(this.dir, name), JSON.stringify(this.serialize(turn)), 0o600);
    } catch {
      // Persistence is best-effort: the in-memory turn still works.
    }
  }

  private persistRedo(): void {
    if (!this.dir) return;
    try {
      const file = join(this.dir, "redo.json");
      if (this.redoStack.length === 0) {
        if (existsSync(file)) rmSync(file, { force: true });
        return;
      }
      const payload: PersistedRedo = { turns: this.redoStack.map((turn) => this.serialize(turn)) };
      writeFileAtomic(file, JSON.stringify(payload), 0o600);
    } catch {
      // ignore
    }
  }

  private removePersisted(turn: TurnCheckpoint): void {
    if (!this.dir) return;
    const name = this.persistNames.get(turn.turnId);
    if (!name) return;
    try {
      rmSync(join(this.dir, name), { force: true });
    } catch {
      // ignore
    }
    this.persistNames.delete(turn.turnId);
  }

  /** Drops the oldest turns and largest snapshots beyond the configured limits. */
  private prune(): void {
    while (this.turns.length > this.maxTurns) {
      const removed = this.turns.shift();
      if (removed) this.removePersisted(removed);
    }
    if (!this.dir) return;
    let total = 0;
    for (const turn of this.turns) {
      let size = 0;
      for (const snap of turn.files.values()) size += snap.content?.byteLength ?? 0;
      total += size;
    }
    while (total > this.maxBytes && this.turns.length > 1) {
      const removed = this.turns.shift();
      if (!removed) break;
      for (const snap of removed.files.values()) total -= snap.content?.byteLength ?? 0;
      this.removePersisted(removed);
    }
  }

  beginTurn(turnId: string = `turn_${Date.now()}`): void {
    const turn: TurnCheckpoint = {
      turnId,
      createdAt: Date.now(),
      files: new Map(),
    };
    this.turns.push(turn);
    this.redoStack.length = 0;
    this.activeTurn = turn;
    this.prune();
  }

  snapshotBeforeWrite(absPath: string): void {
    if (!this.activeTurn) {
      this.beginTurn();
    }
    const turn = this.activeTurn!;
    if (turn.files.has(absPath)) return;

    if (existsSync(absPath)) {
      try {
        const content = readFileSync(absPath);
        turn.files.set(absPath, { existed: true, content });
      } catch {
        // The file exists but its previous content could not be captured. Never record this
        // as "did not exist" because undo would then DELETE a file we failed to read.
        turn.files.set(absPath, { existed: true, content: null });
      }
    } else {
      turn.files.set(absPath, { existed: false, content: null });
    }
    this.persist(turn);
  }

  private captureCurrentStateForTurn(turn: TurnCheckpoint): TurnCheckpoint {
    const inverse: TurnCheckpoint = {
      turnId: turn.turnId,
      createdAt: Date.now(),
      files: new Map(),
    };
    for (const absPath of turn.files.keys()) {
      if (existsSync(absPath)) {
        try {
          inverse.files.set(absPath, { existed: true, content: readFileSync(absPath) });
        } catch {
          inverse.files.set(absPath, { existed: true, content: null });
        }
      } else {
        inverse.files.set(absPath, { existed: false, content: null });
      }
    }
    return inverse;
  }

  private applySnapshotMap(files: Map<string, FileSnapshot>): string[] {
    const restoredFiles: string[] = [];
    for (const [absPath, snap] of files.entries()) {
      if (snap.existed && snap.content !== null) {
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, snap.content);
        restoredFiles.push(absPath);
      } else if (!snap.existed && existsSync(absPath)) {
        rmSync(absPath, { force: true });
        restoredFiles.push(absPath);
      }
    }
    return restoredFiles;
  }

  undoLastTurn(): UndoResult {
    while (this.turns.length > 0) {
      const turn = this.turns.pop()!;
      if (this.activeTurn === turn) {
        this.activeTurn = this.turns[this.turns.length - 1] ?? null;
      }
      if (turn.files.size === 0) {
        this.removePersisted(turn);
        continue;
      }

      const redoTurn = this.captureCurrentStateForTurn(turn);
      const restoredFiles = this.applySnapshotMap(turn.files);
      this.redoStack.push(redoTurn);
      this.removePersisted(turn);
      // Redo state lives only in redo.json; persisting it as a turn-* file would
      // make it look undoable again after a restart.
      this.persistRedo();
      return { turnId: turn.turnId, restoredFiles };
    }
    return { turnId: null, restoredFiles: [] };
  }

  redoLastUndo(): UndoResult {
    const redoTurn = this.redoStack.pop();
    if (!redoTurn) {
      return { turnId: null, restoredFiles: [] };
    }
    const undoAgainTurn = this.captureCurrentStateForTurn(redoTurn);
    const restoredFiles = this.applySnapshotMap(redoTurn.files);
    this.turns.push(undoAgainTurn);
    this.activeTurn = undoAgainTurn;
    this.persist(undoAgainTurn);
    this.persistRedo();
    return { turnId: redoTurn.turnId, restoredFiles };
  }

  listModifiedFiles(): string[] {
    const all = new Set<string>();
    for (const t of this.turns) {
      for (const p of t.files.keys()) all.add(p);
    }
    return [...all];
  }

  /** Files touched by the currently active turn (used by the post-edit review gate). */
  listActiveTurnFiles(): string[] {
    return this.activeTurn ? [...this.activeTurn.files.keys()] : [];
  }

  /** Number of undoable turns still available (persisted turns included). */
  undoCount(): number {
    return this.turns.filter((turn) => turn.files.size > 0).length;
  }

  /** Number of redoable turns. */
  redoCount(): number {
    return this.redoStack.length;
  }

  /** Clears undo/redo history when the user starts a fresh session. */
  reset(): void {
    if (this.dir) {
      for (const turn of this.turns) this.removePersisted(turn);
      for (const turn of this.redoStack) this.removePersisted(turn);
      try {
        const redoFile = join(this.dir, "redo.json");
        if (existsSync(redoFile)) rmSync(redoFile, { force: true });
      } catch {
        // ignore
      }
    }
    this.turns = [];
    this.redoStack = [];
    this.activeTurn = null;
  }
}
