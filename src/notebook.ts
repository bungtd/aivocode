/**
 * Jupyter notebook (`.ipynb`) editing helpers.
 *
 * Notebooks are JSON documents. Editing them as plain text corrupts cell
 * boundaries, so the agent gets dedicated read/edit operations that preserve
 * cell structure, ids, metadata, and outputs.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type NotebookCellType = "code" | "markdown" | "raw";

export interface NotebookCell {
  cell_type: NotebookCellType;
  id?: string;
  metadata: Record<string, unknown>;
  source: string[];
  execution_count?: number | null;
  outputs?: unknown[];
  attachments?: Record<string, unknown>;
}

export interface NotebookDocument {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

export class NotebookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotebookError";
  }
}

function sourceToLines(source: unknown): string[] {
  if (Array.isArray(source)) {
    return source.filter((line): line is string => typeof line === "string");
  }
  if (typeof source === "string") {
    // nbformat stores multi-line sources as arrays; keep the line structure so
    // round-tripping a hand-written file does not rewrite every cell.
    const lines = source.split("\n");
    return lines.map((line, index) => (index === lines.length - 1 ? line : `${line}\n`));
  }
  return [];
}

export function parseNotebook(raw: string): NotebookDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new NotebookError(
      `Invalid notebook JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new NotebookError("Invalid notebook: expected a JSON object");
  }
  const doc = parsed as Record<string, unknown>;
  if (!Array.isArray(doc.cells)) {
    throw new NotebookError("Invalid notebook: missing 'cells' array");
  }
  const cells: NotebookCell[] = [];
  for (const rawCell of doc.cells) {
    if (typeof rawCell !== "object" || rawCell === null) continue;
    const cell = rawCell as Record<string, unknown>;
    const type = cell.cell_type;
    if (type !== "code" && type !== "markdown" && type !== "raw") continue;
    cells.push({
      cell_type: type,
      id: typeof cell.id === "string" ? cell.id : undefined,
      metadata:
        typeof cell.metadata === "object" && cell.metadata !== null && !Array.isArray(cell.metadata)
          ? (cell.metadata as Record<string, unknown>)
          : {},
      source: sourceToLines(cell.source),
      ...(type === "code"
        ? {
            execution_count:
              typeof cell.execution_count === "number" ? cell.execution_count : null,
            outputs: Array.isArray(cell.outputs) ? cell.outputs : [],
          }
        : {}),
      ...(cell.attachments && typeof cell.attachments === "object"
        ? { attachments: cell.attachments as Record<string, unknown> }
        : {}),
    });
  }
  return {
    cells,
    metadata:
      typeof doc.metadata === "object" && doc.metadata !== null && !Array.isArray(doc.metadata)
        ? (doc.metadata as Record<string, unknown>)
        : {},
    nbformat: typeof doc.nbformat === "number" ? doc.nbformat : 4,
    nbformat_minor: typeof doc.nbformat_minor === "number" ? doc.nbformat_minor : 5,
  };
}

export function serializeNotebook(doc: NotebookDocument): string {
  const cells = doc.cells.map((cell) => {
    if (cell.cell_type === "code") {
      return {
        cell_type: "code",
        ...(cell.id ? { id: cell.id } : {}),
        metadata: cell.metadata,
        execution_count: cell.execution_count ?? null,
        outputs: cell.outputs ?? [],
        source: cell.source,
      };
    }
    return {
      cell_type: cell.cell_type,
      ...(cell.id ? { id: cell.id } : {}),
      metadata: cell.metadata,
      source: cell.source,
      ...(cell.attachments ? { attachments: cell.attachments } : {}),
    };
  });
  return JSON.stringify(
    {
      cells,
      metadata: doc.metadata,
      nbformat: doc.nbformat,
      nbformat_minor: doc.nbformat_minor,
    },
    null,
    1,
  ) + "\n";
}

export function cellSource(cell: NotebookCell): string {
  return cell.source.join("");
}

export function readNotebook(path: string): NotebookDocument {
  if (!existsSync(path)) throw new NotebookError(`Notebook not found: ${path}`);
  return parseNotebook(readFileSync(path, "utf8"));
}

export function writeNotebook(path: string, doc: NotebookDocument): void {
  writeFileSync(path, serializeNotebook(doc), "utf8");
}

/** Human/agent-friendly rendering with 1-based cell indices. */
export function formatNotebook(doc: NotebookDocument, maxCellChars = 4_000): string {
  const lines: string[] = [
    `Notebook: ${doc.cells.length} cell(s) · nbformat ${doc.nbformat}.${doc.nbformat_minor}`,
  ];
  for (const [index, cell] of doc.cells.entries()) {
    const label = `${index + 1}. [${cell.cell_type}]`;
    const source = cellSource(cell);
    const truncated =
      source.length > maxCellChars
        ? `${source.slice(0, maxCellChars)}\n… [${source.length - maxCellChars} chars truncated]`
        : source;
    lines.push("", label);
    if (cell.cell_type === "code") {
      lines.push("```" + (typeof cell.metadata.language === "string" ? cell.metadata.language : ""));
      lines.push(truncated || "(empty cell)");
      lines.push("```");
      const outputCount = cell.outputs?.length ?? 0;
      if (outputCount > 0) {
        lines.push(`(${outputCount} saved output(s))`);
      }
    } else {
      lines.push(truncated || "(empty cell)");
    }
  }
  return lines.join("\n");
}

export interface NotebookEditOptions {
  /** 1-based cell index. */
  cell: number;
  source?: string;
  cellType?: NotebookCellType;
}

export function editNotebookCell(path: string, options: NotebookEditOptions): string {
  const doc = readNotebook(path);
  const index = options.cell - 1;
  if (!Number.isInteger(options.cell) || index < 0 || index >= doc.cells.length) {
    throw new NotebookError(
      `Cell ${options.cell} is out of range (notebook has ${doc.cells.length} cells).`,
    );
  }
  const cell = doc.cells[index]!;
  if (options.source !== undefined) {
    cell.source = sourceToLines(options.source);
    if (cell.cell_type === "code") {
      // Editing a code cell invalidates its previous execution output.
      cell.execution_count = null;
      cell.outputs = [];
    }
  }
  if (options.cellType && options.cellType !== cell.cell_type) {
    cell.cell_type = options.cellType;
    if (options.cellType !== "code") {
      delete cell.execution_count;
      delete cell.outputs;
    } else {
      cell.execution_count = null;
      cell.outputs = [];
    }
  }
  writeNotebook(path, doc);
  return `Updated cell ${options.cell} (${cell.cell_type}, ${cellSource(cell).split("\n").length} line(s)).`;
}

export interface NotebookInsertOptions {
  /** 1-based insertion position; `cells.length + 1` appends. */
  index: number;
  source: string;
  cellType?: NotebookCellType;
}

export function insertNotebookCell(path: string, options: NotebookInsertOptions): string {
  const doc = readNotebook(path);
  const position = options.index - 1;
  if (!Number.isInteger(options.index) || position < 0 || position > doc.cells.length) {
    throw new NotebookError(
      `Insert index ${options.index} is out of range (notebook has ${doc.cells.length} cells).`,
    );
  }
  const type = options.cellType ?? "code";
  const cell: NotebookCell = {
    cell_type: type,
    metadata: {},
    source: sourceToLines(options.source),
    ...(type === "code" ? { execution_count: null, outputs: [] } : {}),
  };
  doc.cells.splice(position, 0, cell);
  writeNotebook(path, doc);
  return `Inserted ${type} cell at position ${options.index} (notebook now has ${doc.cells.length} cells).`;
}

export function deleteNotebookCell(path: string, cellIndex: number): string {
  const doc = readNotebook(path);
  const index = cellIndex - 1;
  if (!Number.isInteger(cellIndex) || index < 0 || index >= doc.cells.length) {
    throw new NotebookError(
      `Cell ${cellIndex} is out of range (notebook has ${doc.cells.length} cells).`,
    );
  }
  const [removed] = doc.cells.splice(index, 1);
  writeNotebook(path, doc);
  return `Deleted cell ${cellIndex} (${removed?.cell_type ?? "unknown"}; notebook now has ${doc.cells.length} cells).`;
}

/**
 * Extracts code cells as a runnable script so the agent can execute a notebook
 * without requiring Jupyter to be installed.
 */
export function notebookToScript(doc: NotebookDocument): string {
  const blocks: string[] = [];
  for (const cell of doc.cells) {
    if (cell.cell_type !== "code") continue;
    const source = cellSource(cell)
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("%") && !line.trimStart().startsWith("!"))
      .join("\n")
      .trim();
    if (source) blocks.push(source);
  }
  return blocks.join("\n\n");
}
