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
 * Tracks pre-modification file snapshots per turn so `/undo` and `/redo` can cleanly
 * revert and restore file edits without running destructive git resets.
 */
export class CheckpointManager {
  private turns: TurnCheckpoint[] = [];
  private redoStack: TurnCheckpoint[] = [];
  private activeTurn: TurnCheckpoint | null = null;

  beginTurn(turnId: string = `turn_${Date.now()}`): void {
    const turn: TurnCheckpoint = {
      turnId,
      createdAt: Date.now(),
      files: new Map(),
    };
    this.turns.push(turn);
    this.redoStack.length = 0;
    this.activeTurn = turn;
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
        turn.files.set(absPath, { existed: false, content: null });
      }
    } else {
      turn.files.set(absPath, { existed: false, content: null });
    }
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
          inverse.files.set(absPath, { existed: false, content: null });
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
      if (turn.files.size === 0) continue;

      const redoTurn = this.captureCurrentStateForTurn(turn);
      const restoredFiles = this.applySnapshotMap(turn.files);
      this.redoStack.push(redoTurn);
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
    return { turnId: redoTurn.turnId, restoredFiles };
  }

  listModifiedFiles(): string[] {
    const all = new Set<string>();
    for (const t of this.turns) {
      for (const p of t.files.keys()) all.add(p);
    }
    return [...all];
  }
}
