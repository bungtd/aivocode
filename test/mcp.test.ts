import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { McpManager } from "../src/mcp.js";
import { createToolset } from "../src/tools/index.js";
import { CheckpointManager } from "../src/checkpoint.js";
import { loadUserConfig, parseMcpServerConfig, resolveConfig } from "../src/config.js";
import { parseCliArgs, runCli } from "../src/cli.js";
import { AivoAgent } from "../src/agent.js";
import { SessionStore } from "../src/session.js";
import { DEFAULT_AIVOKEY_CATALOG } from "../src/aivokey-client.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));

const managers: McpManager[] = [];

function track(manager: McpManager): McpManager {
  managers.push(manager);
  return manager;
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

describe("MCP client: stdio, resources, permissions and config", () => {
  it("connects to a stdio server, discovers tools/resources, and calls a read-only tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-mcp-stdio-"));
    let manager: McpManager | undefined;
    try {
      manager = track(
        new McpManager(
          {
            fixture: {
              command: "node",
              args: [FIXTURE],
              transport: "stdio",
              timeoutMs: 10_000,
            },
          },
          { cwd: dir, fetchFn: fetch },
        ),
      );

      await manager.ensureStarted();
      const statuses = manager.getStatuses();
      expect(statuses).toHaveLength(1);
      expect(statuses[0]?.state).toBe("ready");
      expect(statuses[0]?.toolCount).toBe(6);
      expect(statuses[0]?.resourcesSupported).toBe(true);
      expect(statuses[0]?.promptsSupported).toBe(true);
      expect(statuses[0]?.hasInstructions).toBe(true);
      expect(manager.getInstructions().join("\n")).toContain("Use echo");

      const specs = manager.getToolSpecs({ mode: "auto", readOnlyOnly: false });
      const names = specs.map((spec) => spec.name);
      expect(names).toContain("mcp__fixture__echo");
      expect(names).toContain("mcp__fixture__write_note");
      expect(names).toContain("mcp__fixture__env");
      expect(names).toContain("mcp__fixture__sample");
      expect(names).toContain("mcp_list_resources");
      expect(names).toContain("mcp_read_resource");
      expect(names).toContain("mcp_list_prompts");
      expect(names).toContain("mcp_get_prompt");

      const readOnlySpecs = manager.getToolSpecs({ mode: "plan", readOnlyOnly: false });
      expect(readOnlySpecs.map((spec) => spec.name)).toContain("mcp__fixture__echo");
      expect(readOnlySpecs.map((spec) => spec.name)).not.toContain("mcp__fixture__write_note");

      const result = await manager.callTool("mcp__fixture__echo", { text: "hello mcp" });
      expect(result.isError).toBeFalsy();
      expect(result.output).toBe("hello mcp");

      const resources = await manager.listResources();
      expect(resources).toContain("fixture://doc");

      const resource = await manager.readResource("fixture", "fixture://doc");
      expect(resource.isError).toBeFalsy();
      expect(resource.output).toContain("hello from resource");

      const prompts = await manager.listPrompts();
      expect(prompts).toContain("greet");
      const prompt = await manager.getPromptResult("fixture", "greet", { name: "Aivo" });
      expect(prompt.isError).toBeFalsy();
      expect(prompt.output).toContain("Hello Aivo");

      await manager.restart("fixture");
      expect(manager.getStatuses()[0]?.state).toBe("ready");
    } finally {
      manager?.dispose();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("scrubs inherited secrets and requires approval for mutating MCP tools in auto mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-mcp-env-"));
    const previousKey = process.env.AIVOKEY_API_KEY;
    const previousGithub = process.env.GITHUB_TOKEN;
    process.env.AIVOKEY_API_KEY = "sk-aivo_test_secret";
    process.env.GITHUB_TOKEN = "ghp_test_secret";
    let manager: McpManager | undefined;
    try {
      manager = track(
        new McpManager(
          {
            fixture: {
              command: "node",
              args: [FIXTURE],
              transport: "stdio",
              env: { MCP_CUSTOM: "yes" },
            },
          },
          { cwd: dir, fetchFn: fetch },
        ),
      );
      await manager.ensureStarted();

      const envResult = await manager.callTool("mcp__fixture__env", {});
      expect(envResult.isError).toBeFalsy();
      const parsed = JSON.parse(envResult.output) as Record<string, unknown>;
      expect(parsed.aivokey).toBeNull();
      expect(parsed.github).toBeNull();
      expect(parsed.custom).toBe("yes");
      expect(envResult.output).not.toContain("sk-aivo_test_secret");
      expect(envResult.output).not.toContain("ghp_test_secret");

      let asked = 0;
      const tools = createToolset({
        cwd: dir,
        mode: "auto",
        checkpoints: new CheckpointManager(),
        todos: [],
        mcpManager: manager,
        confirmAction: async () => {
          asked++;
          return false;
        },
      });
      const readOnly = await tools.execute("mcp__fixture__echo", { text: "hi" });
      expect(readOnly.isError).toBeFalsy();
      expect(asked).toBe(0);

      const mutating = await tools.execute("mcp__fixture__write_note", { text: "nope" });
      expect(mutating.isError).toBe(true);
      expect(asked).toBe(1);
    } finally {
      if (previousKey === undefined) delete process.env.AIVOKEY_API_KEY;
      else process.env.AIVOKEY_API_KEY = previousKey;
      if (previousGithub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGithub;
      manager?.dispose();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("honors explicit auto/deny approval policies for MCP servers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-mcp-approval-"));
    let trusted: McpManager | undefined;
    let denied: McpManager | undefined;
    try {
      trusted = track(
        new McpManager(
          {
            fixture: {
              command: "node",
              args: [FIXTURE],
              transport: "stdio",
              approval: "auto",
            },
          },
          { cwd: dir, fetchFn: fetch },
        ),
      );
      await trusted.ensureStarted();
      const untrusted = createToolset({
        cwd: dir,
        mode: "auto",
        checkpoints: new CheckpointManager(),
        todos: [],
        mcpManager: trusted,
      });
      const trustedResult = await untrusted.execute("mcp__fixture__write_note", {
        text: "trusted",
      });
      expect(trustedResult.isError).toBeFalsy();
      expect(trustedResult.output).toContain("wrote: trusted");

      denied = track(
        new McpManager(
          {
            fixture: {
              command: "node",
              args: [FIXTURE],
              transport: "stdio",
              approval: "deny",
            },
          },
          { cwd: dir, fetchFn: fetch },
        ),
      );
      await denied.ensureStarted();
      const deniedTools = createToolset({
        cwd: dir,
        mode: "auto",
        checkpoints: new CheckpointManager(),
        todos: [],
        mcpManager: denied,
      });
      const deniedResult = await deniedTools.execute("mcp__fixture__write_note", {
        text: "nope",
      });
      expect(deniedResult.isError).toBe(true);
      expect(deniedResult.output).toContain("denied");
    } finally {
      trusted?.dispose();
      denied?.dispose();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("enforces plan mode and safe-mode confirmation on MCP tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-mcp-perm-"));
    let manager: McpManager | undefined;
    try {
      manager = track(
        new McpManager(
          { fixture: { command: "node", args: [FIXTURE], transport: "stdio" } },
          { cwd: dir, fetchFn: fetch },
        ),
      );
      await manager.ensureStarted();

      const planTools = createToolset({
        cwd: dir,
        mode: "plan",
        checkpoints: new CheckpointManager(),
        todos: [],
        mcpManager: manager,
      });
      const planRes = await planTools.execute("mcp__fixture__write_note", { text: "nope" });
      expect(planRes.isError).toBe(true);
      expect(planRes.output).toContain("plan mode");

      const safeTools = createToolset({
        cwd: dir,
        mode: "safe",
        checkpoints: new CheckpointManager(),
        todos: [],
        confirmAction: async () => false,
        mcpManager: manager,
      });
      const safeRes = await safeTools.execute("mcp__fixture__echo", { text: "hi" });
      expect(safeRes.isError).toBe(true);
      expect(safeRes.output).toContain("declined");
    } finally {
      manager?.dispose();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("connects over legacy SSE transport", async () => {
    const encoder = new TextEncoder();
    let sseController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        sseController = controller;
      },
    });

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/sse") && (init?.method ?? "GET") === "GET") {
        sseController?.enqueue(
          encoder.encode(
            "event: endpoint\ndata: https://sse.example/messages?session=1\n\n",
          ),
        );
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.includes("/messages")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const reply = (result: unknown) => {
          sseController?.enqueue(
            encoder.encode(
              `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`,
            ),
          );
        };
        if (body.method === "initialize") {
          reply({
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "sse-fixture", version: "1.0.0" },
          });
        } else if (body.method === "tools/list") {
          reply({
            tools: [
              {
                name: "sse_echo",
                description: "SSE echo",
                inputSchema: { type: "object", properties: { text: { type: "string" } } },
                annotations: { readOnlyHint: true },
              },
            ],
          });
        } else if (body.method === "tools/call") {
          const args = (body.params as { arguments?: { text?: string } } | undefined)?.arguments;
          reply({ content: [{ type: "text", text: `sse:${args?.text ?? ""}` }] });
        } else {
          reply({});
        }
        return new Response(null, { status: 202 });
      }
      return new Response("not found", { status: 404 });
    };

    const manager = track(
      new McpManager(
        { legacy: { url: "https://sse.example/sse", transport: "sse" } },
        { cwd: process.cwd(), fetchFn: mockFetch },
      ),
    );
    await manager.ensureStarted();
    expect(manager.getStatuses()[0]?.transport).toBe("sse");
    expect(manager.getStatuses()[0]?.state).toBe("ready");
    const result = await manager.callTool("mcp__legacy__sse_echo", { text: "ok" });
    expect(result.output).toBe("sse:ok");
  }, 15_000);

  it("connects over Streamable HTTP and carries/reinitializes the session id", async () => {
    const calls: Array<{ method: string; session: string | null }> = [];
    let expireSessionOnce = true;
    const mockFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const method = String(body.method ?? "");
      const headers = new Headers(init?.headers);
      calls.push({ method, session: headers.get("mcp-session-id") });

      const reply = (result: unknown, extraHeaders: Record<string, string> = {}) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          status: 200,
          headers: { "content-type": "application/json", ...extraHeaders },
        });

      if (method === "initialize") {
        return reply(
          {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "http-fixture", version: "1.0.0" },
          },
          { "mcp-session-id": "session-abc" },
        );
      }
      if (method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (method === "tools/list") {
        return reply({
          tools: [
            {
              name: "remote_echo",
              description: "Remote echo",
              inputSchema: { type: "object", properties: { text: { type: "string" } } },
              annotations: { readOnlyHint: true },
            },
          ],
        });
      }
      if (method === "tools/call") {
        if (expireSessionOnce && headers.get("mcp-session-id")) {
          expireSessionOnce = false;
          return new Response("session expired", { status: 404 });
        }
        const args = (body.params as { arguments?: { text?: string } } | undefined)?.arguments;
        return reply({ content: [{ type: "text", text: `remote:${args?.text ?? ""}` }] });
      }
      return reply({});
    };

    const manager = track(
      new McpManager(
        { remote: { url: "https://mcp.example/mcp", transport: "http" } },
        { cwd: process.cwd(), fetchFn: mockFetch },
      ),
    );
    await manager.ensureStarted();
    expect(manager.getStatuses()[0]?.state).toBe("ready");
    const result = await manager.callTool("mcp__remote__remote_echo", { text: "x" });
    expect(result.output).toBe("remote:x");
    expect(calls.map((call) => call.method)).toContain("tools/list");
    expect(calls.find((call) => call.method === "tools/list")?.session).toBe("session-abc");
  }, 15_000);

  it("refreshes the bearer token once when the server answers 401", async () => {
    const calls: Array<{ method: string; authorization: string | null }> = [];
    let authCalls = 0;
    let rejected = false;
    const mockFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const method = String(body.method ?? "");
      const headers = new Headers(init?.headers);
      calls.push({ method, authorization: headers.get("authorization") });

      const reply = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });

      if (method === "initialize") {
        return reply({
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "oauth-fixture", version: "1.0.0" },
        });
      }
      if (method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (method === "tools/list") {
        return reply({
          tools: [
            {
              name: "ping",
              description: "Ping",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        });
      }
      if (method === "tools/call") {
        // Reject the first cached token, then accept the refreshed one.
        if (!rejected && headers.get("authorization") === "Bearer stale") {
          rejected = true;
          return new Response("token expired", { status: 401 });
        }
        return reply({ content: [{ type: "text", text: "ok" }] });
      }
      return reply({});
    };

    const manager = track(
      new McpManager(
        { remote: { url: "https://mcp.example/mcp", transport: "http" } },
        {
          cwd: process.cwd(),
          fetchFn: mockFetch,
          handlers: {
            authProvider: async (_name, _url, options) => {
              authCalls++;
              return { accessToken: options?.forceRefresh ? "fresh" : "stale" };
            },
          },
        },
      ),
    );
    await manager.ensureStarted();
    const result = await manager.callTool("mcp__remote__ping", {});
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("ok");
    expect(authCalls).toBeGreaterThanOrEqual(2);
    expect(calls.some((call) => call.authorization === "Bearer stale")).toBe(true);
    expect(calls.some((call) => call.authorization === "Bearer fresh")).toBe(true);
  }, 15_000);

  it("injects MCP tool specs into the agent request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-mcp-agent-"));
    let agent: AivoAgent | undefined;
    try {
      let requestToolNames: string[] = [];
      let systemText = "";
      const mockFetch: typeof fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const tools = Array.isArray(body.tools) ? body.tools : [];
        requestToolNames = tools.map((tool) => {
          const row = tool as { function?: { name?: string } };
          return row.function?.name ?? "";
        });
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const systemMessage = messages.find(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            (message as Record<string, unknown>).role === "system",
        ) as Record<string, unknown> | undefined;
        systemText = typeof systemMessage?.content === "string" ? systemMessage.content : "";
        const sse = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "mcp done" } }] })}`,
          "data: [DONE]",
          "",
        ].join("\n");
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };

      const config = resolveConfig({
        cwd: dir,
        globalConfigPath: join(dir, "config.json"),
        env: {},
        cli: {
          apiKey: "sk-aivo_test_key",
          model: "deepseek-v4.1-flash",
          mcpServers: {
            fixture: { command: "node", args: [FIXTURE], transport: "stdio" },
          },
        },
      });
      agent = new AivoAgent({
        config,
        catalog: DEFAULT_AIVOKEY_CATALOG,
        sessionStore: new SessionStore(join(dir, "sessions")),
        fetchFn: mockFetch,
        ephemeralSession: true,
      });
      const result = await agent.runUserPrompt("say hello via mcp");
      expect(result.finalText).toBe("mcp done");
      expect(requestToolNames).toContain("mcp__fixture__echo");
      expect(requestToolNames).toContain("mcp_list_resources");
      expect(requestToolNames).toContain("mcp_list_prompts");
      expect(systemText).toContain("Use echo for MCP integration tests.");
    } finally {
      agent?.mcpManager.dispose();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("supports `aivo mcp --json`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-mcp-cli-"));
    try {
      writeFileSync(
        join(dir, ".aivokey.json"),
        JSON.stringify({
          mcpServers: {
            fixture: { command: "node", args: [FIXTURE], transport: "stdio" },
          },
        }),
        "utf8",
      );
      const lines: string[] = [];
      const code = await runCli(["mcp", "--json"], {
        cwd: dir,
        globalConfigPath: join(dir, "config.json"),
        env: {},
        writeOut: (line) => lines.push(line),
      });
      expect(code).toBe(0);
      const payload = JSON.parse(lines.join("\n")) as {
        servers?: Array<{ name: string; state: string; toolCount: number }>;
      };
      expect(payload.servers?.[0]?.name).toBe("fixture");
      expect(payload.servers?.[0]?.state).toBe("ready");
      expect(payload.servers?.[0]?.toolCount).toBe(6);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("parses and merges MCP server configuration", () => {
    const parsedServer = parseMcpServerConfig({
      command: "node",
      sandbox: "read-only",
      approval: "deny",
    });
    expect(parsedServer?.sandbox).toBe("read-only");
    expect(parsedServer?.approval).toBe("deny");
    expect(parseMcpServerConfig({ command: "node", sandbox: "nonsense" })?.sandbox).toBeUndefined();
    expect(parseCliArgs(["mcp"]).command).toBe("mcp");
    expect(parseMcpServerConfig({ command: "npx", args: ["-y", "pkg"] })).toMatchObject({
      command: "npx",
      args: ["-y", "pkg"],
    });
    expect(parseMcpServerConfig({})).toBeNull();
    expect(parseMcpServerConfig({ url: "https://mcp.example/mcp", transport: "http" })).toMatchObject({
      url: "https://mcp.example/mcp",
      transport: "http",
    });

    const dir = mkdtempSync(join(tmpdir(), "aivo-mcp-config-"));
    try {
      const globalPath = join(dir, "global.json");
      writeFileSync(
        globalPath,
        JSON.stringify({
          mcpServers: {
            global: { command: "node", args: ["global.mjs"] },
            shared: { command: "old", args: [] },
          },
        }),
        "utf8",
      );
      writeFileSync(
        join(dir, ".aivokey.json"),
        JSON.stringify({
          mcpServers: {
            workspace: { url: "https://workspace.example/mcp", transport: "http" },
            shared: { command: "new", args: [] },
          },
        }),
        "utf8",
      );

      const globalConfig = loadUserConfig(globalPath);
      expect(globalConfig.mcpServers?.global?.command).toBe("node");

      const resolved = resolveConfig({ cwd: dir, globalConfigPath: globalPath, env: {} });
      expect(Object.keys(resolved.mcpServers ?? {}).sort()).toEqual([
        "global",
        "shared",
        "workspace",
      ]);
      expect(resolved.mcpServers?.shared?.command).toBe("new");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
