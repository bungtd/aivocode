import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { McpManager } from "../src/mcp.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const managers: McpManager[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose();
  // Windows keeps a handle on the child's cwd briefly after taskkill; retry the
  // temp-dir cleanup instead of failing an otherwise green assertion.
  for (const dir of tempDirs.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

function workspace(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createManager(
  cwd: string,
  handlers: ConstructorParameters<typeof McpManager>[1]["handlers"] = {},
): McpManager {
  const manager = new McpManager(
    { fixture: { command: "node", args: [FIXTURE], transport: "stdio", timeoutMs: 15_000 } },
    { cwd, fetchFn: fetch, handlers },
  );
  managers.push(manager);
  return manager;
}

describe("MCP client completeness: sampling, elicitation, notifications", () => {
  it("answers server-initiated sampling with model content", async () => {
    const dir = workspace("aivo-mcp-sampling-");
    const requests: Array<{ server: string; prompt: string }> = [];
    const manager = createManager(dir, {
      sampling: async (request) => {
        requests.push({
          server: request.server,
          prompt: String(
            (request.messages[0]?.content as { text?: string } | undefined)?.text ?? "",
          ),
        });
        return {
          role: "assistant",
          content: { type: "text", text: "sampled answer" },
          model: "deepseek-v4-flash",
        };
      },
    });
    await manager.ensureStarted();
    const result = await manager.callTool("mcp__fixture__sample", { text: "hello sampling" });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("sampled answer");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.server).toBe("fixture");
    expect(requests[0]?.prompt).toBe("hello sampling");
    expect(manager.getStatuses()[0]?.sampling).toBe(true);
  });

  it("declines sampling when no handler is configured and reports capabilities", async () => {
    const dir = workspace("aivo-mcp-sampling-off-");
    const manager = createManager(dir);
    await manager.ensureStarted();
    const result = await manager.callTool("mcp__fixture__sample", { text: "no handler" });
    expect(result.output.toLowerCase()).toContain("sampling");
    expect(manager.getStatuses()[0]?.sampling).toBe(false);
  });

  it("routes server-initiated elicitation to the client handler", async () => {
    const dir = workspace("aivo-mcp-elicit-");
    const seen: Array<{ server: string; message: string; fields: string[] }> = [];
    const manager = createManager(dir, {
      elicitation: async (request) => {
        const schema = request.requestedSchema as { properties?: Record<string, unknown> } | undefined;
        seen.push({
          server: request.server,
          message: request.message,
          fields: Object.keys(schema?.properties ?? {}),
        });
        return { action: "accept", content: { project: "aivo" } };
      },
    });
    await manager.ensureStarted();
    const result = await manager.callTool("mcp__fixture__elicit", {});
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('"action":"accept"');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toContain("project name");
    expect(seen[0]?.fields).toEqual(["project"]);
    expect(manager.getStatuses()[0]?.elicitation).toBe(true);
  });

  it("declines elicitation when the client declines", async () => {
    const dir = workspace("aivo-mcp-elicit-decline-");
    const manager = createManager(dir, {
      elicitation: async () => ({ action: "decline" }),
    });
    await manager.ensureStarted();
    const result = await manager.callTool("mcp__fixture__elicit", {});
    expect(result.output).toContain('"action":"decline"');
  });

  it("forwards notifications/message and notifications/progress to the client", async () => {
    const dir = workspace("aivo-mcp-notify-");
    const notifications: Array<{ method: string; params: unknown }> = [];
    const manager = createManager(dir, {
      notification: (_server, method, params) => {
        notifications.push({ method, params });
      },
    });
    await manager.ensureStarted();
    const result = await manager.callTool("mcp__fixture__progress_and_log", {});
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("progress done");
    // Give the stdio transport a tick to flush notifications.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const methods = notifications.map((entry) => entry.method);
    expect(methods).toContain("notifications/progress");
    expect(methods).toContain("notifications/message");
    const progress = notifications.find(
      (entry) => entry.method === "notifications/progress",
    )?.params as { progress?: number; total?: number } | undefined;
    expect(progress?.progress).toBe(50);
    expect(progress?.total).toBe(100);
  });
});
