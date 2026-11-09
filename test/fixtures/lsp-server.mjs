// Minimal LSP stdio fixture used by AivoCode code-intelligence tests.
let buffer = Buffer.alloc(0);

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function publishDiagnostics(uri, text) {
  const line = text.includes("const x") ? 0 : 0;
  // Real language servers normalize file URIs (lowercase drive, encoded colon on
  // Windows), so publish in that normalized form to exercise the client's URI keying.
  const normalizedUri = uri.replace(/^file:\/\/([A-Za-z]):/, (_match, drive) => {
    return `file:///${String(drive).toLowerCase()}%3A`;
  });
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri: normalizedUri,
      diagnostics: [
        {
          range: {
            start: { line, character: 0 },
            end: { line, character: 3 },
          },
          severity: 1,
          source: "mock-lsp",
          message: "mock diagnostic from fixture",
        },
      ],
    },
  });
}

function handle(message) {
  if (message.id === undefined) {
    if (message.method === "textDocument/didOpen") {
      const doc = message.params?.textDocument;
      if (doc?.uri) publishDiagnostics(doc.uri, String(doc.text ?? ""));
    }
    return;
  }

  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  const fail = (code, text) =>
    send({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });

  switch (message.method) {
    case "initialize":
      reply({
        capabilities: {
          hoverProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
        },
        serverInfo: { name: "mock-lsp", version: "1.0.0" },
      });
      break;
    case "textDocument/hover":
      reply({
        contents: { kind: "markdown", value: "**mock hover**" },
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 3 },
        },
      });
      break;
    case "textDocument/definition":
      reply([
        {
          uri: message.params?.textDocument?.uri,
          range: {
            start: { line: 1, character: 2 },
            end: { line: 1, character: 8 },
          },
        },
      ]);
      break;
    case "textDocument/references":
      reply([
        {
          uri: message.params?.textDocument?.uri,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 3 },
          },
        },
        {
          uri: message.params?.textDocument?.uri,
          range: {
            start: { line: 2, character: 1 },
            end: { line: 2, character: 4 },
          },
        },
      ]);
      break;
    case "textDocument/documentSymbol":
      reply([
        {
          name: "mockFn",
          kind: 12,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 3, character: 0 },
          },
          selectionRange: {
            start: { line: 0, character: 9 },
            end: { line: 0, character: 15 },
          },
        },
      ]);
      break;
    case "workspace/symbol":
      reply([
        {
          name: "mockFn",
          kind: 12,
          containerName: "fixture",
          location: {
            uri: message.params?.query === "empty" ? "file:///missing.ts" : "file:///fixture.ts",
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 3 },
            },
          },
        },
      ]);
      break;
    case "shutdown":
      reply(null);
      break;
    default:
      fail(-32601, `Method not found: ${String(message.method)}`);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    try {
      handle(JSON.parse(body));
    } catch {
      // Ignore malformed frames.
    }
  }
});
