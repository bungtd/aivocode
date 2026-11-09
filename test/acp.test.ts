import { afterEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcpServer } from "../src/acp.js";
import { createJsonlEventSink, toolEndEvent } from "../src/events.js";
import { SessionStore } from "../src/session.js";
import { DEFAULT_AIVOKEY_CATALOG } from "../src/aivokey-client.js";
import type { AivoConfig } from "../src/config.js";
import { parseCliArgs } from "../src/cli.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "aivo-acp-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

function configFor(cwd: string): AivoConfig {
  return {
    apiKey: "sk-aivo_test",
    baseUrl: "https://api.example.test",
    model: "deepseek-v4-flash",
    fastModel: null,
    wire: "chat",
    reasoningEffort: "off",
    mode: "auto",
    webSearch: false,
    sandbox: "workspace",
    cwd,
    globalConfigPath: join(cwd, "config.json"),
  };
}

/**
 * Drives an AcpServer over PassThrough streams so tests exercise the real
 * JSON-RPC framing instead of poking at private methods.
 */
function startServer(cwd: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Array<Record<string, unknown>> = [];
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) messages.push(JSON.parse(line) as Record<string, unknown>);
      newline = buffer.indexOf("\n");
    }
  });

  const server = new AcpServer({
    config: configFor(cwd),
    catalog: DEFAULT_AIVOKEY_CATALOG,
    sessionStore: new SessionStore(join(cwd, "sessions")),
    input,
    output,
    writeErr: () => {},
  });
  const done = server.serve();
  let counter = 0;
  const stderr: string[] = [];

  const send = (message: Record<string, unknown>) => {
    input.write(JSON.stringify(message) + "\n");
  };

  const request = async (
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const id = ++counter;
    send({ jsonrpc: "2.0", id, method, params });
    return waitFor((message) => message.id === id, messages);
  };

  const notify = (method: string, params: Record<string, unknown> = {}) => {
    send({ jsonrpc: "2.0", method, params });
  };

  return {
    server,
    messages,
    stderr,
    request,
    notify,
    close: async () => {
      input.end();
      await done;
    },
  };
}

async function waitFor<T>(
  predicate: (message: Record<string, unknown>) => boolean,
  messages: Array<Record<string, unknown>>,
  timeoutMs = 8_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = messages.find(predicate);
    if (found) return found as T;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("Timed out waiting for ACP message");
}

function updates(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return messages
    .filter((message) => message.method === "session/update")
    .map((message) => (message.params as { update?: Record<string, unknown> })?.update ?? {});
}

describe("Agent Client Protocol server", () => {
  it("initializes with v1 capabilities and creates a session", async () => {
    const cwd = tempWorkspace();
    const client = startServer(cwd);
    try {
      const init = (await client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: { name: "vitest", version: "0.0.1" },
      })) as {
        result?: {
          protocolVersion: number;
          agentCapabilities: { loadSession: boolean; promptCapabilities: { image: boolean } };
          agentInfo: { name: string };
        };
      };
      expect(init.result?.protocolVersion).toBe(1);
      expect(init.result?.agentCapabilities.loadSession).toBe(true);
      expect(init.result?.agentCapabilities.promptCapabilities.image).toBe(true);
      expect(init.result?.agentInfo.name).toBe("aivocode");

      const created = (await client.request("session/new", { cwd, mcpServers: [] })) as {
        result?: { sessionId: string };
      };
      expect(created.result?.sessionId).toMatch(/^ses_/);

      const usage = updates(client.messages).find(
        (update) => update.sessionUpdate === "usage_update",
      );
      expect(usage).toBeDefined();
      expect(typeof usage?.size).toBe("number");
    } finally {
      await client.close();
    }
  });

  it("rejects requests before initialize and unknown sessions with ACP error codes", async () => {
    const cwd = tempWorkspace();
    const client = startServer(cwd);
    try {
      const premature = (await client.request("session/new", { cwd })) as {
        error?: { code: number };
      };
      expect(premature.error?.code).toBe(-32600);

      await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const unknown = (await client.request("session/prompt", {
        sessionId: "ses_missing",
        prompt: [{ type: "text", text: "hi" }],
      })) as { error?: { code: number } };
      expect(unknown.error?.code).toBe(-32002);

      const badMethod = (await client.request("nope/nothing", {})) as {
        error?: { code: number };
      };
      expect(badMethod.error?.code).toBe(-32601);
    } finally {
      await client.close();
    }
  });

  it("streams a prompt turn and cancels an in-flight request", async () => {
    const cwd = tempWorkspace();
    const client = startServer(cwd);
    let releaseFetch: (() => void) | null = null;
    try {
      await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const created = (await client.request("session/new", { cwd })) as {
        result?: { sessionId: string };
      };
      const sessionId = created.result?.sessionId;
      expect(sessionId).toBeTruthy();

      // Replace the agent's fetch so the test controls turn duration.
      const state = (client.server as unknown as {
        sessions: Map<string, { agent: { fetchFn: typeof fetch } }>;
      }).sessions.get(sessionId!);
      expect(state).toBeDefined();
      let sawAbort = false;
      const release: { fn: (() => void) | null } = { fn: null };
      state!.agent.fetchFn = ((_input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("aborted by client"));
          });
          release.fn = () => {};
        })) as unknown as typeof fetch;

      const promptPromise = client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "please do something slow" }],
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      client.notify("session/cancel", { sessionId });
      const prompt = (await promptPromise) as { result?: { stopReason: string } };
      expect(prompt.result?.stopReason).toBe("cancelled");
      expect(sawAbort).toBe(true);
      release.fn?.();
    } finally {
      await client.close();
    }
  });

  it("switches modes, closes sessions, and advertises custom commands", async () => {
    const cwd = tempWorkspace();
    const client = startServer(cwd);
    try {
      await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const created = (await client.request("session/new", { cwd })) as {
        result?: { sessionId: string };
      };
      const sessionId = created.result?.sessionId!;

      const mode = (await client.request("session/set_mode", {
        sessionId,
        modeId: "plan",
      })) as { error?: unknown };
      expect(mode.error).toBeUndefined();
      const modeUpdate = updates(client.messages).find(
        (update) => update.sessionUpdate === "current_mode_update",
      );
      expect(modeUpdate?.currentModeId).toBe("plan");

      const invalid = (await client.request("session/set_mode", {
        sessionId,
        modeId: "nonsense",
      })) as { error?: { code: number } };
      expect(invalid.error?.code).toBe(-32602);

      const closed = (await client.request("session/close", { sessionId })) as {
        error?: unknown;
      };
      expect(closed.error).toBeUndefined();
      const afterClose = (await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "hi" }],
      })) as { error?: { code: number } };
      expect(afterClose.error?.code).toBe(-32002);
    } finally {
      await client.close();
    }
  });
});

describe("JSONL event stream", () => {
  it("emits one valid JSON object per line", () => {
    const lines: string[] = [];
    const sink = createJsonlEventSink((line) => lines.push(line));
    sink({ type: "reasoning", text: "thinking" });
    sink({ type: "text", text: "hello\nworld" });
    sink(toolEndEvent("edit_file", "done", false, {
      output: "done",
      durationMs: 12,
      summary: "1 replacement",
      diff: { filePath: "src/a.ts", before: "a", after: "b" },
    }));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(line.trim()) as { type: string };
      expect(typeof parsed.type).toBe("string");
    }
    const tool = JSON.parse(lines[2]!.trim()) as {
      type: string;
      diff?: { filePath: string };
      output: string;
    };
    expect(tool.type).toBe("tool_end");
    expect(tool.diff?.filePath).toBe("src/a.ts");
    expect(tool.output).toBe("done");
  });

  it("parses --events-json and --full-output flags", () => {
    const parsed = parseCliArgs(["run", "hello", "--events-json", "--full-output"]);
    expect(parsed.eventsJson).toBe(true);
    expect(parsed.fullOutput).toBe(true);
    expect(parseCliArgs(["run", "hello"]).eventsJson).toBe(false);
  });
});
