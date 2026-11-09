/**
 * Lightweight observability: spans, metrics, and structured trace export.
 *
 * No OpenTelemetry dependency. A trace is a tree of spans with start/end times,
 * status, attributes, and events. Spans can be exported as:
 *
 * - Chrome Trace Event format (open `chrome://tracing` or Perfetto)
 * - OTLP-ish JSON (resourceSpans/scopeSpans) for collectors and dashboards
 * - Newline-delimited JSON events (`--trace-json`) for streaming consumers
 *
 * Metrics are cumulative counters/gauges/histograms rendered as Prometheus text
 * (`aivo metrics`) or JSON.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { AIVO_CLIENT_VERSION } from "./client-identity.js";

export type SpanKind = "agent" | "model" | "tool" | "subagent" | "workflow" | "mcp" | "lsp" | "other";
export type SpanStatus = "ok" | "error" | "cancelled";

export interface SpanEvent {
  name: string;
  at: number;
  attributes?: Record<string, unknown>;
}

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime: number | null;
  status: SpanStatus | null;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Record<string, unknown>;
  parent?: Span | null;
}

function newId(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly kind: SpanKind;
  readonly startTime: number;
  readonly attributes: Record<string, unknown>;
  readonly events: SpanEvent[] = [];
  endTime: number | null = null;
  status: SpanStatus | null = null;
  private ended = false;

  constructor(name: string, options: SpanOptions, tracer: Tracer) {
    this.traceId = options.parent?.traceId ?? tracer.newTraceId();
    this.spanId = newId(8);
    this.parentSpanId = options.parent?.spanId ?? null;
    this.name = name;
    this.kind = options.kind ?? "other";
    this.startTime = Date.now();
    this.attributes = { ...(options.attributes ?? {}) };
    this.tracer = tracer;
  }

  private readonly tracer: Tracer;

  setAttribute(key: string, value: unknown): this {
    this.attributes[key] = value;
    return this;
  }

  addEvent(name: string, attributes?: Record<string, unknown>): this {
    this.events.push({ name, at: Date.now(), attributes });
    return this;
  }

  /** Records an error and marks the span as failed. */
  fail(error: unknown): this {
    this.status = "error";
    this.attributes.error = error instanceof Error ? error.message : String(error);
    return this;
  }

  end(status?: SpanStatus): SpanRecord {
    if (this.ended) return this.toRecord();
    this.ended = true;
    this.endTime = Date.now();
    if (status) this.status = status;
    if (!this.status) this.status = "ok";
    const record = this.toRecord();
    this.tracer.record(record);
    return record;
  }

  get durationMs(): number {
    return (this.endTime ?? Date.now()) - this.startTime;
  }

  toRecord(): SpanRecord {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: this.kind,
      startTime: this.startTime,
      endTime: this.endTime,
      status: this.status,
      attributes: { ...this.attributes },
      events: this.events.map((event) => ({ ...event })),
    };
  }
}

export interface TelemetryOptions {
  /** When false, starting a span is a no-op that still supports the Span API. */
  enabled?: boolean;
  /** Maximum spans retained in memory (oldest dropped first). Default 5000. */
  maxSpans?: number;
  /** Append each finished span as one JSON line to this file. */
  jsonlPath?: string;
  /** Override clock for deterministic tests. */
  now?: () => number;
}

export class Tracer {
  readonly enabled: boolean;
  readonly traceId: string;
  private readonly spans: SpanRecord[] = [];
  private readonly maxSpans: number;
  private readonly jsonlPath: string | undefined;
  private jsonlReady = false;

  constructor(options: TelemetryOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.traceId = newId(16);
    this.maxSpans = Math.max(1, options.maxSpans ?? 5_000);
    this.jsonlPath = options.jsonlPath;
  }

  newTraceId(): string {
    return this.traceId;
  }

  startSpan(name: string, options: SpanOptions = {}): Span {
    return new Span(name, options, this);
  }

  /** Wraps an async operation in a span, recording failures and ending it automatically. */
  async withSpan<T>(
    name: string,
    options: SpanOptions,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    const span = this.startSpan(name, options);
    try {
      const result = await fn(span);
      span.end();
      return result;
    } catch (err) {
      span.fail(err);
      span.end();
      throw err;
    }
  }

  record(span: SpanRecord): void {
    this.spans.push(span);
    if (this.spans.length > this.maxSpans) this.spans.splice(0, this.spans.length - this.maxSpans);
    if (this.jsonlPath) {
      try {
        if (!this.jsonlReady) {
          mkdirSync(dirname(this.jsonlPath), { recursive: true });
          writeFileSync(this.jsonlPath, "", "utf8");
          this.jsonlReady = true;
        }
        appendFileSync(this.jsonlPath, JSON.stringify(span) + "\n", "utf8");
      } catch {
        // Tracing must never break the agent.
      }
    }
  }

  listSpans(): SpanRecord[] {
    return this.spans.map((span) => ({ ...span }));
  }

  /** Spans grouped by kind with aggregate duration. */
  summary(): Array<{ kind: SpanKind; count: number; totalMs: number; errors: number }> {
    const groups = new Map<SpanKind, { count: number; totalMs: number; errors: number }>();
    for (const span of this.spans) {
      const entry = groups.get(span.kind) ?? { count: 0, totalMs: 0, errors: 0 };
      entry.count++;
      entry.totalMs += (span.endTime ?? span.startTime) - span.startTime;
      if (span.status === "error") entry.errors++;
      groups.set(span.kind, entry);
    }
    return [...groups.entries()]
      .map(([kind, value]) => ({ kind, ...value }))
      .sort((a, b) => b.totalMs - a.totalMs);
  }

  /** Chrome Trace Event format (`chrome://tracing`, Perfetto). */
  toChromeTrace(): string {
    const events = this.spans.map((span) => ({
      name: span.name,
      cat: span.kind,
      ph: "X",
      ts: span.startTime * 1000,
      dur: Math.max(0, ((span.endTime ?? span.startTime) - span.startTime) * 1000),
      pid: 1,
      tid: 1,
      args: { ...span.attributes, status: span.status },
    }));
    return JSON.stringify({ traceEvents: events });
  }

  /** OTLP-compatible JSON (`resourceSpans`) for generic collectors. */
  toOtlpJson(serviceName = "aivocode"): string {
    return JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: serviceName } }],
          },
          scopeSpans: [
            {
              scope: { name: "aivo.agent", version: AIVO_CLIENT_VERSION },
              spans: this.spans.map((span) => ({
                traceId: span.traceId,
                spanId: span.spanId,
                parentSpanId: span.parentSpanId ?? undefined,
                name: span.name,
                kind: span.kind,
                startTimeUnixNano: String(span.startTime * 1_000_000),
                endTimeUnixNano: String((span.endTime ?? span.startTime) * 1_000_000),
                status: { code: span.status === "error" ? 2 : 1 },
                attributes: Object.entries(span.attributes).map(([key, value]) => ({
                  key,
                  value:
                    typeof value === "number"
                      ? { doubleValue: value }
                      : typeof value === "boolean"
                        ? { boolValue: value }
                        : { stringValue: String(value) },
                })),
                events: span.events.map((event) => ({
                  name: event.name,
                  timeUnixNano: String(event.at * 1_000_000),
                })),
              })),
            },
          ],
        },
      ],
    });
  }
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export type MetricKind = "counter" | "gauge" | "histogram";

interface MetricSeries {
  kind: MetricKind;
  help: string;
  values: Map<string, { value: number; count: number; sum: number; buckets: Map<number, number> }>;
}

const HISTOGRAM_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000];

export class MetricsRegistry {
  private readonly metrics = new Map<string, MetricSeries>();

  private series(name: string, kind: MetricKind, help: string): MetricSeries {
    const existing = this.metrics.get(name);
    if (existing) return existing;
    const created: MetricSeries = { kind, help, values: new Map() };
    this.metrics.set(name, created);
    return created;
  }

  private key(labels: Record<string, string | number | undefined>): string {
    const entries = Object.entries(labels)
      .filter(([, value]) => value !== undefined && value !== "")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}="${String(value).replace(/["\\\n]/g, "_")}"`);
    return entries.join(",");
  }

  increment(name: string, labels: Record<string, string | number | undefined> = {}, help = ""): void {
    const series = this.series(name, "counter", help);
    const key = this.key(labels);
    const entry = series.values.get(key) ?? { value: 0, count: 0, sum: 0, buckets: new Map() };
    entry.value += 1;
    series.values.set(key, entry);
  }

  add(
    name: string,
    value: number,
    labels: Record<string, string | number | undefined> = {},
    help = "",
  ): void {
    const series = this.series(name, "counter", help);
    const key = this.key(labels);
    const entry = series.values.get(key) ?? { value: 0, count: 0, sum: 0, buckets: new Map() };
    entry.value += value;
    series.values.set(key, entry);
  }

  set(
    name: string,
    value: number,
    labels: Record<string, string | number | undefined> = {},
    help = "",
  ): void {
    const series = this.series(name, "gauge", help);
    const key = this.key(labels);
    const entry = series.values.get(key) ?? { value: 0, count: 0, sum: 0, buckets: new Map() };
    entry.value = value;
    series.values.set(key, entry);
  }

  observe(
    name: string,
    value: number,
    labels: Record<string, string | number | undefined> = {},
    help = "",
  ): void {
    const series = this.series(name, "histogram", help);
    const key = this.key(labels);
    const entry = series.values.get(key) ?? { value: 0, count: 0, sum: 0, buckets: new Map() };
    entry.count += 1;
    entry.sum += value;
    for (const bucket of HISTOGRAM_BUCKETS) {
      if (value <= bucket) entry.buckets.set(bucket, (entry.buckets.get(bucket) ?? 0) + 1);
    }
    series.values.set(key, entry);
  }

  /** Prometheus text exposition format. */
  toPrometheus(): string {
    const lines: string[] = [];
    for (const [name, series] of [...this.metrics.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (series.help) lines.push(`# HELP ${name} ${series.help}`);
      lines.push(`# TYPE ${name} ${series.kind}`);
      for (const [labels, entry] of series.values) {
        const suffix = labels ? `{${labels}}` : "";
        if (series.kind === "histogram") {
          for (const bucket of HISTOGRAM_BUCKETS) {
            const count = entry.buckets.get(bucket) ?? 0;
            lines.push(`${name}_bucket{${labels}${labels ? "," : ""}le="${bucket}"} ${count}`);
          }
          lines.push(`${name}_bucket{${labels}${labels ? "," : ""}le="+Inf"} ${entry.count}`);
          lines.push(`${name}_sum${suffix} ${entry.sum}`);
          lines.push(`${name}_count${suffix} ${entry.count}`);
        } else {
          lines.push(`${name}${suffix} ${entry.value}`);
        }
      }
    }
    return lines.join("\n") + (lines.length > 0 ? "\n" : "");
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, series] of this.metrics) {
      const values: Record<string, unknown> = {};
      for (const [labels, entry] of series.values) {
        values[labels || "_"] =
          series.kind === "histogram"
            ? {
                count: entry.count,
                sum: entry.sum,
                buckets: Object.fromEntries(entry.buckets),
              }
            : entry.value;
      }
      out[name] = { type: series.kind, help: series.help, values };
    }
    return out;
  }

  reset(): void {
    this.metrics.clear();
  }
}

/** Process-wide registry used by the agent and CLI commands. */
export const globalMetrics = new MetricsRegistry();
