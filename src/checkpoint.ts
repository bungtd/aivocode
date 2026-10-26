import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

/**
 * Tracks pre-modification file snapshots per turn so `/undo` can cleanly
 * revert file edits or newly created files without running destructive git resets.
 */
export class CheckpointManager {
  private turns: TurnCheckpoint[] = [];
  private activeTurn: TurnCheckpoint | null = null;

  beginTurn(turnId: string = `turn_${Date.now()}`): void {
    const turn: TurnCheckpoint = {
      turnId,
      createdAt: Date.now(),
      files: new Map(),
    };
    this.turns.push(turn);
    this.activeTurn = turn;
  }

  snapshotBeforeWrite(absPath: string): void {
    if (!this.activeTurn) {
      this.beginTurn();
    }
    const turn = this.activeTurn!;
    // Only record the first state before any modification in this turn
    if (turn.files.has(absPath)) return;

    if (existsSync(absPath)) {
      try {
        const content = readFileSync(absPath);
        turn.files.set(absPath, { existed: true, content });
      } catch {
        turn.files.set(absPath, { existed: false, content: null });
      }
    } else {
      turn.files.set(absPath, { existed: false, content: null });
    }
  }

  undoLastTurn(): UndoResult {
    // Find the most recent turn that actually touched files
    while (this.turns.length > 0) {
      const turn = this.turns.pop()!;
      if (this.activeTurn === turn) {
        this.activeTurn = this.turns[this.turns.length - 1] ?? null;
      }
      if (turn.files.size === 0) continue;

      const restoredFiles: string[] = [];
      for (const [absPath, snap] of turn.files.entries()) {
        if (snap.existed && snap.content !== null) {
          mkdirSync(dirname(absPath), { recursive: true });
          writeFileSync(absPath, snap.content);
          restoredFiles.push(absPath);
        } else if (!snap.existed && existsSync(absPath)) {
          rmSync(absPath, { force: true });
          restoredFiles.push(absPath);
        }
      }
      return { turnId: turn.turnId, restoredFiles };
    }
    return { turnId: null, restoredFiles: [] };
  }

  listModifiedFiles(): string[] {
    const all = new Set<string>();
    for (const t of this.turns) {
      for (const p of t.files.keys()) all.add(p);
    }
    return [...all];
  }
}
