/**
 * CLI helpers for reading and summarizing exported traces.
 */
import { existsSync, readFileSync } from "node:fs";
import type { SpanRecord } from "./telemetry.js";

/** Reads a JSONL trace file, tolerating truncated/corrupt lines. */
export function readTraceFile(path: string): SpanRecord[] | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const spans: SpanRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as SpanRecord;
      if (typeof parsed?.spanId === "string" && typeof parsed?.name === "string") {
        spans.push(parsed);
      }
    } catch {
      // Skip malformed lines; a crash may leave a partial trailing record.
    }
  }
  return spans;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(2)}m`;
}

/** Renders an indented span tree with duration and status. */
export function formatTraceSummary(spans: SpanRecord[]): string {
  if (spans.length === 0) return "No spans in this trace.";
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const children = new Map<string | null, SpanRecord[]>();
  for (const span of spans) {
    const parent = span.parentSpanId && byId.has(span.parentSpanId) ? span.parentSpanId : null;
    const list = children.get(parent) ?? [];
    list.push(span);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.startTime - b.startTime);

  const lines: string[] = [];
  const traceId = spans[0]?.traceId ?? "?";
  const rootStart = Math.min(...spans.map((span) => span.startTime));
  const rootEnd = Math.max(...spans.map((span) => span.endTime ?? span.startTime));
  lines.push(`Trace ${traceId} · ${spans.length} span(s) · ${formatDuration(rootEnd - rootStart)}`);

  const walk = (parentId: string | null, depth: number) => {
    const list = children.get(parentId) ?? [];
    for (const span of list) {
      const duration = (span.endTime ?? span.startTime) - span.startTime;
      const marker = span.status === "error" ? "✗" : span.status === "cancelled" ? "⊘" : "✓";
      const attributes = Object.entries(span.attributes)
        .filter(([, value]) => value !== "" && value !== undefined && value !== null)
        .slice(0, 4)
        .map(([key, value]) => `${key}=${String(value).slice(0, 40)}`)
        .join(" ");
      lines.push(
        `${"  ".repeat(depth)}${marker} ${span.name} [${span.kind}] ${formatDuration(duration)}${attributes ? ` · ${attributes}` : ""}`,
      );
      walk(span.spanId, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join("\n");
}
