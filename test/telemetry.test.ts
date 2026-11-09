import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetricsRegistry, Span, Tracer, globalMetrics } from "../src/telemetry.js";
import { formatTraceSummary, readTraceFile } from "../src/telemetry-cli.js";
import { parseCliArgs } from "../src/cli.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  globalMetrics.reset();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

describe("Tracing", () => {
  it("builds a span tree with parent links, attributes, events and status", () => {
    const tracer = new Tracer({ enabled: true });
    const turn = tracer.startSpan("turn", {
      kind: "agent",
      attributes: { "session.id": "ses_1" },
    });
    const model = tracer.startSpan("model.call", {
      kind: "model",
      parent: turn,
      attributes: { "model.id": "deepseek-v4-flash" },
    });
    model.addEvent("retry", { attempt: 1 });
    model.end();

    const tool = tracer.startSpan("tool.read_file", { kind: "tool", parent: turn });
    tool.setAttribute("tool.path", "src/a.ts");
    tool.fail(new Error("boom"));
    tool.end();

    turn.end();
    const spans = tracer.listSpans();
    expect(spans).toHaveLength(3);
    const turnRecord = spans.find((span) => span.name === "turn")!;
    const modelRecord = spans.find((span) => span.name === "model.call")!;
    const toolRecord = spans.find((span) => span.name === "tool.read_file")!;

    expect(modelRecord.parentSpanId).toBe(turnRecord.spanId);
    expect(toolRecord.parentSpanId).toBe(turnRecord.spanId);
    expect(modelRecord.kind).toBe("model");
    expect(modelRecord.events[0]?.name).toBe("retry");
    expect(toolRecord.status).toBe("error");
    expect(toolRecord.attributes.error).toContain("boom");
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
  });

  it("ends spans exactly once and aggregates a summary", () => {
    const tracer = new Tracer({ enabled: true });
    const span = tracer.startSpan("tool.edit_file", { kind: "tool" });
    const first = span.end();
    const second = span.end();
    expect(second.endTime).toBe(first.endTime);
    expect(tracer.listSpans()).toHaveLength(1);

    const summary = tracer.summary();
    expect(summary[0]?.kind).toBe("tool");
    expect(summary[0]?.count).toBe(1);
  });

  it("records failures from withSpan and rethrows", async () => {
    const tracer = new Tracer({ enabled: true });
    await expect(
      tracer.withSpan("model.call", { kind: "model" }, async () => {
        throw new Error("upstream 503");
      }),
    ).rejects.toThrow("upstream 503");
    const span = tracer.listSpans()[0]!;
    expect(span.status).toBe("error");
    expect(span.attributes.error).toBe("upstream 503");
  });

  it("exports Chrome Trace and OTLP JSON shapes", () => {
    const tracer = new Tracer({ enabled: true });
    const parent = tracer.startSpan("turn", { kind: "agent", attributes: { "turn.model": "m1" } });
    const child = tracer.startSpan("tool.read_file", { kind: "tool", parent });
    child.end();
    parent.end();

    const chrome = JSON.parse(tracer.toChromeTrace()) as {
      traceEvents: Array<{ name: string; ph: string; ts: number; tid: number; args: unknown }>;
    };
    expect(chrome.traceEvents).toHaveLength(2);
    expect(chrome.traceEvents.every((event) => event.ph === "X")).toBe(true);
    expect(chrome.traceEvents[0]?.ts).toBeGreaterThan(0);

    const otlp = JSON.parse(tracer.toOtlpJson("aivocode-test")) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ value: { stringValue: string } }> };
        scopeSpans: Array<{ spans: Array<{ parentSpanId?: string; attributes: unknown[] }> }>;
      }>;
    };
    expect(otlp.resourceSpans[0]?.resource.attributes[0]?.value.stringValue).toBe("aivocode-test");
    const spans = otlp.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(2);
    expect(spans.some((span) => span.parentSpanId)).toBe(true);
  });

  it("appends spans to a JSONL file and reads them back", () => {
    const dir = tempDir("aivo-trace-");
    const path = join(dir, "trace.jsonl");
    const tracer = new Tracer({ enabled: true, jsonlPath: path });
    const turn = tracer.startSpan("turn", { kind: "agent" });
    const tool = tracer.startSpan("tool.write_file", { kind: "tool", parent: turn });
    tool.end();
    turn.end();

    const spans = readTraceFile(path);
    expect(spans).toHaveLength(2);
    expect(spans?.map((span) => span.name)).toContain("tool.write_file");

    const summary = formatTraceSummary(spans!);
    expect(summary).toContain("Trace ");
    expect(summary).toContain("2 span(s)");
    expect(summary).toContain("tool.write_file");
  });

  it("tolerates a truncated trailing trace line", () => {
    const dir = tempDir("aivo-trace-trunc-");
    const path = join(dir, "trace.jsonl");
    const tracer = new Tracer({ enabled: true, jsonlPath: path });
    tracer.startSpan("turn", { kind: "agent" }).end();
    const good = readTraceFile(path);
    expect(good).toHaveLength(1);

    const raw = require("node:fs").readFileSync(path, "utf8") as string;
    require("node:fs").writeFileSync(path, raw + '{"spanId":"broken"', "utf8");
    const after = readTraceFile(path);
    expect(after).toHaveLength(1);
    expect(readTraceFile(join(dir, "missing.jsonl"))).toBeNull();
  });
});

describe("Metrics", () => {
  it("renders counters, gauges and histograms in Prometheus format", () => {
    const registry = new MetricsRegistry();
    registry.increment("aivo_turns_total", { mode: "auto" }, "Turns");
    registry.increment("aivo_turns_total", { mode: "auto" });
    registry.increment("aivo_turns_total", { mode: "plan" });
    registry.set("aivo_context_tokens", 42, { session: "ses_1" }, "Context usage");
    registry.observe("aivo_tool_duration_ms", 12, { tool: "read_file" }, "Tool duration");
    registry.observe("aivo_tool_duration_ms", 800, { tool: "read_file" });

    const text = registry.toPrometheus();
    expect(text).toContain("# TYPE aivo_turns_total counter");
    expect(text).toContain('aivo_turns_total{mode="auto"} 2');
    expect(text).toContain('aivo_turns_total{mode="plan"} 1');
    expect(text).toContain('aivo_context_tokens{session="ses_1"} 42');
    expect(text).toContain("# TYPE aivo_tool_duration_ms histogram");
    expect(text).toContain('aivo_tool_duration_ms_bucket{tool="read_file",le="10"} 0');
    expect(text).toContain('aivo_tool_duration_ms_bucket{tool="read_file",le="25"} 1');
    expect(text).toContain('aivo_tool_duration_ms_count{tool="read_file"} 2');
    expect(text).toContain('aivo_tool_duration_ms_sum{tool="read_file"} 812');
  });

  it("escapes label values and exports JSON", () => {
    const registry = new MetricsRegistry();
    registry.increment("aivo_errors_total", { reason: 'bad "quote"\nline' });
    const text = registry.toPrometheus();
    expect(text).not.toContain("\nline");
    const json = registry.toJSON() as Record<string, { values: Record<string, number> }>;
    // The key is derived from the sanitized label set.
    const values = Object.values(json.aivo_errors_total!.values);
    expect(values).toEqual([1]);
  });

  it("resets cleanly and shares the global registry", () => {
    globalMetrics.increment("aivo_test_total");
    expect(globalMetrics.toPrometheus()).toContain("aivo_test_total 1");
    globalMetrics.reset();
    expect(globalMetrics.toPrometheus()).toBe("");
  });
});

describe("Telemetry CLI flags", () => {
  it("parses --trace, --metrics-json and --metrics-prom", () => {
    const parsed = parseCliArgs([
      "run",
      "hello",
      "--trace",
      "trace.jsonl",
      "--metrics-prom",
    ]);
    expect(parsed.tracePath).toBe("trace.jsonl");
    expect(parsed.metricsProm).toBe(true);
    expect(parseCliArgs(["metrics"]).command).toBe("metrics");
    expect(parseCliArgs(["trace", "file.jsonl"]).command).toBe("trace");
  });
});
