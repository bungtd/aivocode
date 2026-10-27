import { describe, expect, it } from "vitest";
import {
  ClientWebSearchRouter,
  htmlToMarkdown,
  clientWebFetch,
} from "../src/web.js";

describe("Client-side WebSearch router & OpenCode-style WebFetch (no AivoKey server websearch)", () => {
  it("routes web_search across Exa, Tavily, and zero-key DuckDuckGo fallback with 429 cooldown failover", async () => {
    const calledUrls: string[] = [];

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      calledUrls.push(url);

      if (url.includes("api.exa.ai")) {
        // Simulate Exa returning HTTP 429 rate limit
        return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
          status: 429,
          headers: { "retry-after": "60" },
        });
      }

      if (url.includes("api.tavily.com")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "Bun v1.3 Release Notes",
                url: "https://bun.sh/blog/bun-v1.3",
                content: "Bun 1.3 introduces faster startup and native S3 support.",
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    };

    const router = new ClientWebSearchRouter({
      env: {
        EXA_API_KEY: "exa_test_key",
        TAVILY_API_KEY: "tvly_test_key",
      },
      fetchFn: mockFetch,
    });

    const res1 = await router.search({ query: "latest bun release", maxResults: 5 });
    expect(res1.provider).toBe("tavily");
    expect(res1.sources).toHaveLength(1);
    expect(res1.sources[0]?.title).toBe("Bun v1.3 Release Notes");
    expect(res1.sources[0]?.url).toBe("https://bun.sh/blog/bun-v1.3");

    // Second search should skip Exa immediately because Exa is in cooldown!
    calledUrls.length = 0;
    const res2 = await router.search({ query: "bun s3 client", maxResults: 3 });
    expect(res2.provider).toBe("tavily");
    expect(calledUrls.some((u) => u.includes("api.exa.ai"))).toBe(false);
  });

  it("falls back to zero-key DuckDuckGo HTML search when no API keys are configured", async () => {
    const sampleDdgHtml = `
      <html><body>
        <div class="result">
          <a class="result__a" href="https://kotlinlang.org/docs/coroutines-overview.html">Kotlin Coroutines Guide</a>
          <a class="result__snippet">Asynchronous programming with Kotlin coroutines and structured concurrency.</a>
        </div>
      </body></html>
    `;

    const mockFetch: typeof fetch = async () =>
      new Response(sampleDdgHtml, { status: 200, headers: { "content-type": "text/html" } });

    const router = new ClientWebSearchRouter({
      env: {},
      loadLocalDshCredentials: false,
      fetchFn: mockFetch,
    });

    const res = await router.search({ query: "kotlin coroutines" });
    expect(res.provider).toBe("duckduckgo");
    expect(res.sources).toHaveLength(1);
    expect(res.sources[0]?.title).toBe("Kotlin Coroutines Guide");
    expect(res.sources[0]?.url).toBe("https://kotlinlang.org/docs/coroutines-overview.html");
  });

  it("converts HTML to structured Markdown in clientWebFetch", async () => {
    const html = `
      <html>
        <head><style>.hidden { display: none; }</style><script>alert(1)</script></head>
        <body>
          <nav> Top menu </nav>
          <h1>Getting Started</h1>
          <p>Install with <code>pnpm add aivo</code> and read the <a href="https://aivokey.dev/docs">official docs</a>.</p>
          <pre><code>const x = 42;\nconsole.log(x);</code></pre>
          <ul><li>Fast streaming</li><li>Multi-agent teams</li></ul>
        </body>
      </html>
    `;

    const md = htmlToMarkdown(html);
    expect(md).toContain("# Getting Started");
    expect(md).toContain("`pnpm add aivo`");
    expect(md).toContain("[official docs](https://aivokey.dev/docs)");
    expect(md).toContain("```\nconst x = 42;\nconsole.log(x);\n```");
    expect(md).toContain("- Fast streaming");
    expect(md).not.toContain("alert(1)");

    const mockFetch: typeof fetch = async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } });

    const fetched = await clientWebFetch({
      url: "https://aivokey.dev/docs",
      format: "markdown",
      fetchFn: mockFetch,
    });
    expect(fetched.content).toContain("# Getting Started");
  });

  it("4. OpenCode-style keyless MCP web search: uses Exa MCP (mcp.exa.ai) and Parallel MCP (search.parallel.ai) with ZERO API keys, plus keyless code search and web_fetch_exa fallback", async () => {
    let exaShouldRateLimit = false;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const bodyStr = init?.body ? String(init.body) : "";

      if (url.includes("mcp.exa.ai/mcp")) {
        if (exaShouldRateLimit && bodyStr.includes("web_search_exa")) {
          return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "30" } });
        }
        if (bodyStr.includes("get_code_context_exa")) {
          const sse =
            'event: message\ndata: {"result":{"content":[{"type":"text","text":"Title: React Hooks Docs\\nURL: https://react.dev/reference/react/useState\\nCode/Highlights:\\nconst [state, setState] = useState(initialState);"}]},"jsonrpc":"2.0","id":1}\n\n';
          return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        if (bodyStr.includes("web_fetch_exa")) {
          const sse =
            'event: message\ndata: {"result":{"content":[{"type":"text","text":"# Protected Docs\\nExtracted cleanly via Exa MCP web_fetch_exa."}]},"jsonrpc":"2.0","id":1}\n\n';
          return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        const sse = [
          "event: message",
          'data: {"result":{"content":[{"type":"text","text":"Title: Node.js 24 LTS Release\\nURL: https://nodejs.org/en/blog/release/v24.0.0\\nPublished: 2025-05-06\\nAuthor: N/A\\nHighlights:\\nNode.js 24 upgrades V8 to 13.6 and npm to 11.\\n\\n---\\n\\nTitle: Node.js Changelog\\nURL: https://github.com/nodejs/node/blob/main/CHANGELOG.md\\nPublished: N/A\\nAuthor: N/A\\nHighlights:\\nSecurity updates and AsyncContextFrame default."}]},"jsonrpc":"2.0","id":1}',
          "",
        ].join("\n");
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }

      if (url.includes("search.parallel.ai/mcp")) {
        const jsonRpc = {
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  search_id: "search_123",
                  results: [
                    {
                      url: "https://parallel.ai/blog/search",
                      title: "Parallel Search MCP",
                      publish_date: "2026-01-10",
                      excerpts: ["Fast keyless search via Parallel MCP endpoint."],
                    },
                  ],
                }),
              },
            ],
          },
        };
        return new Response(JSON.stringify(jsonRpc), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("protected.example.com")) {
        return new Response("Cloudflare 403 Forbidden", { status: 403 });
      }

      return new Response("not found", { status: 404 });
    };

    // Zero API keys in env!
    const router = new ClientWebSearchRouter({
      env: {},
      loadLocalDshCredentials: false,
      fetchFn: mockFetch,
    });

    // 1. Keyless Exa MCP search
    const exaRes = await router.search({ query: "Node.js 24 release notes", maxResults: 5 });
    expect(exaRes.provider).toBe("exa-mcp");
    expect(exaRes.sources).toHaveLength(2);
    expect(exaRes.sources[0]?.title).toBe("Node.js 24 LTS Release");
    expect(exaRes.sources[0]?.url).toBe("https://nodejs.org/en/blog/release/v24.0.0");
    expect(exaRes.sources[0]?.snippet).toContain("V8 to 13.6");

    // 2. When Exa MCP hits 429, automatically fails over to Keyless Parallel MCP
    exaShouldRateLimit = true;
    const parRes = await router.search({ query: "Parallel MCP search", maxResults: 5 });
    expect(parRes.provider).toBe("parallel-mcp");
    expect(parRes.sources).toHaveLength(1);
    expect(parRes.sources[0]?.url).toBe("https://parallel.ai/blog/search");
    expect(parRes.sources[0]?.snippet).toContain("Fast keyless search");

    // 3. Keyless Code Search via get_code_context_exa
    const codeRes = await router.search({ query: "React useState hook", type: "code", maxResults: 5 });
    expect(codeRes.provider).toBe("exa-mcp");
    expect(codeRes.sources[0]?.url).toBe("https://react.dev/reference/react/useState");
    expect(codeRes.sources[0]?.snippet).toContain("useState(initialState)");

    // 4. Keyless web_fetch_exa fallback when direct HTTP fetch gets 403 Forbidden
    const fetchedProtected = await clientWebFetch({
      url: "https://protected.example.com/docs",
      format: "markdown",
      fetchFn: mockFetch,
    });
    expect(fetchedProtected.content).toContain("# Protected Docs");
    expect(fetchedProtected.content).toContain("Extracted cleanly via Exa MCP web_fetch_exa.");
  });
});
