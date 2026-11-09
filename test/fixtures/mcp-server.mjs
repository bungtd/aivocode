// Minimal MCP stdio server used by the AivoCode integration tests.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

let nextServerRequestId = 9000;
const pendingCalls = new Map();
const pendingServerRequests = new Map();

function notify(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

/** Sends a server→client request and resolves when the client replies. */
function requestClient(method, params) {
  const id = nextServerRequestId++;
  return new Promise((resolve, reject) => {
    pendingServerRequests.set(id, { resolve, reject });
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pendingServerRequests.delete(id)) reject(new Error(`client request ${method} timed out`));
    }, 8000).unref?.();
  });
}

async function finishSampling() {
  const pending = pendingCalls.get("sample");
  if (!pending) return;
  pendingCalls.delete("sample");
  try {
    const result = await requestClient("sampling/createMessage", {
      messages: [
        {
          role: "user",
          content: { type: "text", text: String(pending.args.text ?? "sample me") },
        },
      ],
      maxTokens: 64,
      systemPrompt: "Reply with one short sentence for the sampling fixture.",
    });
    const text =
      result?.content?.text ??
      result?.content?.[0]?.text ??
      JSON.stringify(result ?? null);
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: pending.id,
        result: { content: [{ type: "text", text: `sampled: ${String(text)}` }] },
      }) + "\n",
    );
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: pending.id,
        result: {
          content: [{ type: "text", text: `sampling-failed: ${err instanceof Error ? err.message : String(err)}` }],
        },
      }) + "\n",
    );
  }
}

async function finishElicitation() {
  const pending = pendingCalls.get("elicit");
  if (!pending) return;
  pendingCalls.delete("elicit");
  try {
    const result = await requestClient("elicitation/create", {
      message: "Please provide a project name",
      requestedSchema: {
        type: "object",
        properties: { project: { type: "string" } },
        required: ["project"],
      },
    });
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: pending.id,
        result: { content: [{ type: "text", text: `elicited: ${JSON.stringify(result ?? null)}` }] },
      }) + "\n",
    );
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: pending.id,
        result: {
          content: [{ type: "text", text: `elicitation-failed: ${err instanceof Error ? err.message : String(err)}` }],
        },
      }) + "\n",
    );
  }
}

const TOOLS = [
  {
    name: "echo",
    description: "Echo the provided text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write_note",
    description: "Pretend to write a note (mutating tool)",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "env",
    description: "Report selected environment values (for isolation tests)",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "sample",
    description: "Ask the client to sample from the model (sampling test)",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "elicit",
    description: "Ask the client to elicit structured input",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "progress_and_log",
    description: "Emit progress/log notifications then answer",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  // Responses to server→client requests (sampling/elicitation).
  if (message.method === undefined && message.id !== undefined) {
    const pending = pendingServerRequests.get(Number(message.id));
    if (pending) {
      pendingServerRequests.delete(Number(message.id));
      if (message.error) pending.reject(new Error(String(message.error.message ?? "client error")));
      else pending.resolve(message.result);
    }
    return;
  }

  // Notifications have no id and must not receive a response.
  if (message.id === undefined) {
    return;
  }

  const reply = (result) =>
    send({ jsonrpc: "2.0", id: message.id, result });
  const fail = (code, text) =>
    send({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });

  switch (message.method) {
    case "initialize":
      reply({
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
        serverInfo: { name: "fixture-mcp", version: "0.0.1" },
        instructions: "Use echo for MCP integration tests.",
      });
      break;
    case "tools/list":
      reply({ tools: TOOLS });
      break;
    case "tools/call": {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (name === "echo") {
        reply({ content: [{ type: "text", text: String(args.text ?? "") }] });
      } else if (name === "write_note") {
        reply({ content: [{ type: "text", text: `wrote: ${String(args.text ?? "")}` }] });
      } else if (name === "env") {
        reply({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                aivokey: process.env.AIVOKEY_API_KEY ?? null,
                github: process.env.GITHUB_TOKEN ?? null,
                custom: process.env.MCP_CUSTOM ?? null,
                path: Boolean(process.env.PATH),
              }),
            },
          ],
        });
      } else if (name === "sample") {
        pendingCalls.set("sample", { id: message.id, args });
        void finishSampling();
      } else if (name === "elicit") {
        pendingCalls.set("elicit", { id: message.id, args });
        void finishElicitation();
      } else if (name === "progress_and_log") {
        notify("notifications/progress", {
          progressToken: "progress-1",
          progress: 50,
          total: 100,
          message: "halfway",
        });
        notify("notifications/message", { level: "info", data: "fixture log line" });
        reply({ content: [{ type: "text", text: "progress done" }] });
      } else {
        fail(-32602, `Unknown tool: ${String(name)}`);
      }
      break;
    }
    case "resources/list":
      reply({
        resources: [
          { uri: "fixture://doc", name: "Fixture Doc", mimeType: "text/plain" },
        ],
      });
      break;
    case "resources/read":
      reply({
        contents: [
          { uri: "fixture://doc", mimeType: "text/plain", text: "hello from resource" },
        ],
      });
      break;
    case "prompts/list":
      reply({
        prompts: [
          {
            name: "greet",
            description: "Greet someone",
            arguments: [{ name: "name", description: "Person name", required: true }],
          },
        ],
      });
      break;
    case "prompts/get":
      reply({
        description: "Greeting",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Hello ${String(message.params?.arguments?.name ?? "world")}`,
            },
          },
        ],
      });
      break;
    default:
      fail(-32601, `Method not found: ${String(message.method)}`);
  }
});
