/**
 * Newline-delimited JSON (JSONL) event stream for headless integrations.
 *
 * `aivo run --events-json` prints one JSON object per line on stdout instead of
 * human-readable streaming text. Editors, CI jobs, and wrappers can consume the
 * stream without screen-scraping. Events are stable, versioned, and never
 * contain ANSI escapes.
 */
import type { ToolExecutionResult } from "./tools/index.js";
import type { TodoItem } from "./tools/index.js";

export const EVENT_STREAM_VERSION = 1;

export type AgentStreamEvent =
  | { type: "start"; version: number; sessionId: string; model: string; cwd: string }
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | {
      type: "tool_progress";
      name: string;
      bytes: number;
      lines: number;
      preview: string;
    }
  | {
      type: "tool_end";
      name: string;
      output: string;
      isError: boolean;
      summary?: string;
      durationMs?: number;
      diff?: { filePath: string; before: string; after: string };
    }
  | { type: "todo"; todos: Array<{ id: string; content: string; status: string }> }
  | { type: "notice"; message: string; level: "info" | "warning" | "error" }
  | {
      type: "result";
      text: string;
      steps: number;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
      };
      costMicro: string;
      cacheSavedMicro: string;
      elapsedMs: number;
    }
  | { type: "error"; message: string; code?: string };

export type EventSink = (event: AgentStreamEvent) => void;

/** Writes one JSON object per line, flushing immediately for streaming clients. */
export function createJsonlEventSink(
  write: (line: string) => void = (line) => process.stdout.write(line),
): EventSink {
  return (event) => {
    write(JSON.stringify(event) + "\n");
  };
}

export function todoEvent(todos: TodoItem[]): AgentStreamEvent {
  return {
    type: "todo",
    todos: todos.map((todo) => ({
      id: todo.id,
      content: todo.content,
      status: todo.status,
    })),
  };
}

export function toolEndEvent(
  name: string,
  output: string,
  isError: boolean,
  details?: ToolExecutionResult,
): AgentStreamEvent {
  return {
    type: "tool_end",
    name,
    output,
    isError,
    summary: details?.summary,
    durationMs: details?.durationMs,
    diff: details?.diff
      ? {
          filePath: details.diff.filePath,
          before: details.diff.before,
          after: details.diff.after,
        }
      : undefined,
  };
}
