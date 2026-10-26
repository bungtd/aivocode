import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

export interface WebSearchSource {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
}

export interface WebSearchResult {
  provider: string;
  sources: WebSearchSource[];
}

export type WebSearchProviderKind = "exa" | "tavily" | "firecrawl" | "brave" | "duckduckgo";

interface ProviderHealth {
  cooldownUntil: number;
  failures: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const AUTH_COOLDOWN_MS = 600_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AivoCode/1.0";

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function loadDshCredentialFallbacks(): Record<string, string> {
  const out: Record<string, string> = {};
  const credPath = join(homedir(), ".dsh", ".credentials.yaml");
  if (!existsSync(credPath)) return out;
  try {
    const raw = readFileSync(credPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s+(EXA_API_KEY|TAVILY_API_KEY|FIRECRAWL_API_KEY|BRAVE_API_KEY):\s*(.+)$/);
      if (m && m[1] && m[2]) {
        out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

export interface ClientWebSearchRouterOptions {
  env?: Record<string, string | undefined>;
  preferredProvider?: WebSearchProviderKind | "auto" | "random";
  loadLocalDshCredentials?: boolean;
  fetchFn?: typeof fetch;
}

/**
 * Client-side Multi-Provider WebSearch Router (learned from OpenCode V2 & DSH web-search-router).
 * Never uses AivoKey server-side websearch; executes searches directly from the client
 * with automatic cooldown tracking and zero-key DuckDuckGo fallback.
 */
export class ClientWebSearchRouter {
  private env: Record<string, string | undefined>;
  private preferred: WebSearchProviderKind | "auto" | "random";
  private fetchFn: typeof fetch;
  private health = new Map<string, ProviderHealth>();

  constructor(opts: ClientWebSearchRouterOptions = {}) {
    const dshFallbacks =
      opts.loadLocalDshCredentials !== false ? loadDshCredentialFallbacks() : {};
    this.env = { ...dshFallbacks, ...(opts.env ?? process.env) };
    this.preferred = opts.preferredProvider ?? "auto";
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private isCoolingDown(id: string): boolean {
    const st = this.health.get(id);
    return st !== undefined && st.cooldownUntil > Date.now();
  }

  private markCooldown(id: string, status: number, retryAfterHeader: string | null): void {
    const parsedRetry = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    let durationMs = DEFAULT_COOLDOWN_MS;
    if (Number.isFinite(parsedRetry) && parsedRetry > 0) {
      durationMs = Math.ceil(parsedRetry * 1000);
    } else if (status === 401 || status === 403) {
      durationMs = AUTH_COOLDOWN_MS;
    }
    const prev = this.health.get(id) ?? { cooldownUntil: 0, failures: 0 };
    this.health.set(id, {
      failures: prev.failures + 1,
      cooldownUntil: Date.now() + durationMs,
    });
  }

  private markSuccess(id: string): void {
    this.health.set(id, { failures: 0, cooldownUntil: 0 });
  }

  private resolveCandidates(): WebSearchProviderKind[] {
    const configured: WebSearchProviderKind[] = [];
    if (this.env.EXA_API_KEY?.trim()) configured.push("exa");
    if (this.env.TAVILY_API_KEY?.trim()) configured.push("tavily");
    if (this.env.FIRECRAWL_API_KEY?.trim()) configured.push("firecrawl");
    if (this.env.BRAVE_API_KEY?.trim()) configured.push("brave");

    if (this.preferred === "random" && configured.length > 1) {
      configured.sort(() => Math.random() - 0.5);
    } else if (
      this.preferred !== "auto" &&
      this.preferred !== "random" &&
      configured.includes(this.preferred)
    ) {
      const idx = configured.indexOf(this.preferred);
      configured.splice(idx, 1);
      configured.unshift(this.preferred);
    }

    // Always append zero-key DuckDuckGo fallback last
    configured.push("duckduckgo");

    const healthy = configured.filter((p) => !this.isCoolingDown(p));
    const cooling = configured.filter((p) => this.isCoolingDown(p));
    return [...healthy, ...cooling];
  }

  async search(input: {
    query: string;
    maxResults?: number;
    signal?: AbortSignal;
  }): Promise<WebSearchResult> {
    const query = input.query.trim();
    const maxResults = Math.min(20, Math.max(1, input.maxResults ?? 8));
    const candidates = this.resolveCandidates();
    const errors: string[] = [];

    for (const provider of candidates) {
      if (this.isCoolingDown(provider) && provider !== "duckduckgo") {
        continue;
      }
      try {
        const sources = await this.executeProvider(provider, query, maxResults, input.signal);
        this.markSuccess(provider);
        return { provider, sources };
      } catch (err) {
        errors.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw new Error(`All web search providers failed (${errors.join("; ")})`);
  }

  private async executeProvider(
    provider: WebSearchProviderKind,
    query: string,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<WebSearchSource[]> {
    if (provider === "exa") {
      const apiKey = this.env.EXA_API_KEY!.trim();
      const res = await this.fetchFn("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({
          query,
          type: "auto",
          numResults: maxResults,
          contents: { text: { maxCharacters: 600 } },
        }),
        signal,
      });
      if (!res.ok) {
        this.markCooldown("exa", res.status, res.headers.get("retry-after"));
        throw new Error(`Exa HTTP ${res.status}`);
      }
      const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
      return (data.results ?? [])
        .filter((r) => typeof r.url === "string")
        .map((r) => ({
          title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : String(r.url),
          url: String(r.url),
          snippet:
            typeof r.text === "string"
              ? r.text.replace(/\s+/g, " ").trim().slice(0, 600)
              : typeof r.summary === "string"
                ? r.summary.replace(/\s+/g, " ").trim().slice(0, 600)
                : undefined,
          publishedAt: typeof r.publishedDate === "string" ? r.publishedDate : undefined,
        }));
    }

    if (provider === "tavily") {
      const apiKey = this.env.TAVILY_API_KEY!.trim();
      const res = await this.fetchFn("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({
          query,
          max_results: maxResults,
          search_depth: "basic",
          include_answer: false,
        }),
        signal,
      });
      if (!res.ok) {
        this.markCooldown("tavily", res.status, res.headers.get("retry-after"));
        throw new Error(`Tavily HTTP ${res.status}`);
      }
      const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
      return (data.results ?? [])
        .filter((r) => typeof r.url === "string")
        .map((r) => ({
          title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : String(r.url),
          url: String(r.url),
          snippet:
            typeof r.content === "string"
              ? r.content.replace(/\s+/g, " ").trim().slice(0, 600)
              : undefined,
        }));
    }

    if (provider === "firecrawl") {
      const apiKey = this.env.FIRECRAWL_API_KEY!.trim();
      const res = await this.fetchFn("https://api.firecrawl.dev/v1/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({ query, limit: maxResults }),
        signal,
      });
      if (!res.ok) {
        this.markCooldown("firecrawl", res.status, res.headers.get("retry-after"));
        throw new Error(`Firecrawl HTTP ${res.status}`);
      }
      const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
      return (data.data ?? [])
        .filter((r) => typeof r.url === "string")
        .map((r) => ({
          title: typeof r.title === "string" ? r.title : String(r.url),
          url: String(r.url),
          snippet:
            typeof r.description === "string"
              ? r.description.slice(0, 600)
              : typeof r.markdown === "string"
                ? r.markdown.slice(0, 600)
                : undefined,
        }));
    }

    if (provider === "brave") {
      const apiKey = this.env.BRAVE_API_KEY!.trim();
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
      const res = await this.fetchFn(url, {
        headers: {
          accept: "application/json",
          "x-subscription-token": apiKey,
          "user-agent": USER_AGENT,
        },
        signal,
      });
      if (!res.ok) {
        this.markCooldown("brave", res.status, res.headers.get("retry-after"));
        throw new Error(`Brave HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        web?: { results?: Array<Record<string, unknown>> };
      };
      return (data.web?.results ?? [])
        .filter((r) => typeof r.url === "string")
        .map((r) => ({
          title: typeof r.title === "string" ? r.title : String(r.url),
          url: String(r.url),
          snippet: typeof r.description === "string" ? r.description.slice(0, 600) : undefined,
        }));
    }

    // Zero-key DuckDuckGo HTML search fallback
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await this.fetchFn(ddgUrl, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html",
      },
      signal,
    });
    if (!res.ok) {
      throw new Error(`DuckDuckGo HTTP ${res.status}`);
    }
    const html = await res.text();
    const sources: WebSearchSource[] = [];
    const blockRx =
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>)?/gi;

    let match: RegExpExecArray | null;
    while ((match = blockRx.exec(html)) !== null && sources.length < maxResults) {
      let rawUrl = decodeHtmlEntities(match[1] ?? "").trim();
      // Unwrap DuckDuckGo uddg redirect URL if present
      const uddgMatch = rawUrl.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch?.[1]) {
        try {
          rawUrl = decodeURIComponent(uddgMatch[1]);
        } catch {
          /* keep rawUrl */
        }
      }
      if (!/^https?:\/\//i.test(rawUrl)) continue;
      const title = decodeHtmlEntities((match[2] ?? "").replace(/<[^>]+>/g, "").trim());
      const snippet = decodeHtmlEntities((match[3] ?? "").replace(/<[^>]+>/g, "").trim());
      sources.push({
        title: title || rawUrl,
        url: rawUrl,
        ...(snippet ? { snippet } : {}),
      });
    }

    return sources;
  }
}

/**
 * Converts HTML into clean, readable Markdown (OpenCode V2 webfetch style).
 */
export function htmlToMarkdown(html: string): string {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<(nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, "");

  // Fenced code blocks <pre><code>...</code></pre>
  cleaned = cleaned.replace(
    /<pre[^>]*>\s*(?:<code[^>]*>)?([\s\S]*?)(?:<\/code>)?\s*<\/pre>/gi,
    (_, code) => `\n\`\`\`\n${decodeHtmlEntities(String(code).replace(/<[^>]+>/g, "").trim())}\n\`\`\`\n`,
  );

  // Inline <code>
  cleaned = cleaned.replace(
    /<code[^>]*>([\s\S]*?)<\/code>/gi,
    (_, code) => `\`${decodeHtmlEntities(String(code).replace(/<[^>]+>/g, "").trim())}\``,
  );

  // Headings <h1>..<h6>
  cleaned = cleaned.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, level, inner) =>
      `\n${"#".repeat(Number(level))} ${decodeHtmlEntities(String(inner).replace(/<[^>]+>/g, "").trim())}\n`,
  );

  // Links <a href="...">text</a>
  cleaned = cleaned.replace(
    /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, inner) => {
      const text = decodeHtmlEntities(String(inner).replace(/<[^>]+>/g, "").trim());
      if (!text) return "";
      return `[${text}](${href})`;
    },
  );

  // Bold / strong
  cleaned = cleaned.replace(
    /<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_, _tag, inner) => `**${decodeHtmlEntities(String(inner).replace(/<[^>]+>/g, "").trim())}**`,
  );

  // List items <li>
  cleaned = cleaned.replace(
    /<li[^>]*>([\s\S]*?)<\/li>/gi,
    (_, inner) => `\n- ${decodeHtmlEntities(String(inner).replace(/<[^>]+>/g, "").trim())}`,
  );

  // Paragraphs and line breaks
  cleaned = cleaned
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  cleaned = decodeHtmlEntities(cleaned);

  return cleaned
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface ClientWebFetchOptions {
  url: string;
  format?: "markdown" | "text" | "html";
  timeoutSec?: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}

export interface ClientWebFetchResult {
  url: string;
  contentType: string;
  content: string;
  savedFullPath?: string;
}

const MAX_WEBFETCH_INLINE_CHARS = 32_000;

export async function clientWebFetch(
  opts: ClientWebFetchOptions,
): Promise<ClientWebFetchResult> {
  const url = opts.url.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Invalid URL (must start with http:// or https://): ${url}`);
  }
  const format = opts.format ?? "markdown";
  const timeoutMs = Math.min(120_000, Math.max(1_000, (opts.timeoutSec ?? 30) * 1000));
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.8",
    },
    signal,
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${res.statusText}) fetching ${url}`);
  }

  const contentType = (res.headers.get("content-type") ?? "text/plain").toLowerCase();
  if (
    contentType.startsWith("image/") ||
    contentType.startsWith("video/") ||
    contentType.startsWith("audio/") ||
    contentType.includes("application/octet-stream")
  ) {
    throw new Error(`Binary content-type '${contentType}' is not supported by web_fetch; use vision tools for images.`);
  }

  const rawBody = await res.text();
  let formatted: string;
  if (format === "html") {
    formatted = rawBody;
  } else if (contentType.includes("html")) {
    formatted =
      format === "text"
        ? htmlToMarkdown(rawBody).replace(/[#*`[\]()]/g, "")
        : htmlToMarkdown(rawBody);
  } else {
    formatted = rawBody;
  }

  let savedFullPath: string | undefined;
  if (formatted.length > MAX_WEBFETCH_INLINE_CHARS) {
    const spillDir = join(tmpdir(), "aivokey-cli-webfetch");
    mkdirSync(spillDir, { recursive: true });
    savedFullPath = join(spillDir, `page-${Date.now()}.md`);
    writeFileSync(savedFullPath, formatted, "utf8");
    formatted =
      formatted.slice(0, MAX_WEBFETCH_INLINE_CHARS) +
      `\n\n... [Content truncated (${formatted.length} chars total). Full page saved to ${savedFullPath}]`;
  }

  return {
    url,
    contentType,
    content: formatted,
    savedFullPath,
  };
}
