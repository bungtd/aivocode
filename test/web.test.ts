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
});
