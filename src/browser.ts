/**
 * Browser automation over the Chrome DevTools Protocol.
 *
 * AivoCode already locates a local Chrome/Edge binary for viewport screenshots.
 * This module drives that same browser for real interaction: navigate, inspect
 * the DOM, click, fill inputs, evaluate JS, capture screenshots, and collect
 * console/network errors — without adding Playwright or a native dependency.
 *
 * The client speaks CDP over a minimal RFC 6455 WebSocket implemented here, so
 * it works on Node 20+ where `globalThis.WebSocket` is not guaranteed.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadImageAttachment, type ImageAttachment } from "./vision.js";
import { findHeadlessBrowserBinary } from "./computer-use.js";
import { isPrivateOrLocalHost } from "./web.js";

const DEFAULT_ACTION_TIMEOUT_MS = 20_000;
const MAX_TEXT_CHARS = 24_000;
const MAX_CONSOLE_ENTRIES = 100;

export interface BrowserActionOptions {
  cwd: string;
  /** Network policy from the session; `deny` blocks non-local navigation. */
  network?: "allow" | "deny";
  timeoutMs?: number;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  text: string;
  links: Array<{ text: string; href: string }>;
  buttons: Array<{ text: string; index: number; disabled: boolean }>;
  inputs: Array<{
    index: number;
    tag: string;
    type: string;
    name: string;
    placeholder: string;
    value: string;
  }>;
  console: Array<{ level: string; text: string }>;
  networkErrors: string[];
}

export interface BrowserResult {
  output: string;
  isError?: boolean;
  screenshot?: ImageAttachment;
  snapshot?: BrowserSnapshot;
}

// ── Minimal WebSocket (RFC 6455 client) ─────────────────────────────────────

class WebSocketClient {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly listeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>();
  private closed = false;

  static async connect(url: string, timeoutMs = 15_000): Promise<WebSocketClient> {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new Error(`Unsupported WebSocket URL: ${url}`);
    }
    const client = new WebSocketClient();
    await client.handshake(parsed, timeoutMs);
    return client;
  }

  private handshake(url: URL, timeoutMs: number): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const host = url.hostname;
      const port = Number(url.port || (url.protocol === "wss:" ? 443 : 80));
      const key = randomBytes(16).toString("base64");
      const expectedAccept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");

      const socket = createConnection({ host, port });
      this.socket = socket;
      socket.setNoDelay(true);

      const timer = setTimeout(() => {
        socket.destroy();
        rejectPromise(new Error("Timed out connecting to the browser DevTools endpoint"));
      }, timeoutMs);

      let handshakeDone = false;
      const onData = (chunk: Buffer) => {
        if (!handshakeDone) {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          const headerEnd = this.buffer.indexOf("\r\n\r\n");
          if (headerEnd < 0) return;
          const header = this.buffer.subarray(0, headerEnd).toString("utf8");
          this.buffer = this.buffer.subarray(headerEnd + 4);
          clearTimeout(timer);
          if (!/^HTTP\/1\.1 101/i.test(header)) {
            rejectPromise(new Error(`WebSocket upgrade failed: ${header.split("\r\n")[0]}`));
            socket.destroy();
            return;
          }
          const accept = /sec-websocket-accept:\s*(\S+)/i.exec(header)?.[1];
          if (accept !== expectedAccept) {
            rejectPromise(new Error("WebSocket accept key mismatch"));
            socket.destroy();
            return;
          }
          handshakeDone = true;
          socket.off("data", onData);
          socket.on("data", (next: Buffer) => this.handleData(next));
          this.drainBufferedFrames();
          resolvePromise();
          return;
        }
        this.handleData(chunk);
      };
      socket.on("data", onData);

      const path = `${url.pathname}${url.search}`;
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
      socket.on("error", (err) => {
        clearTimeout(timer);
        if (!handshakeDone) rejectPromise(err);
        this.failAll(err);
      });
      socket.on("close", () => {
        this.closed = true;
        this.failAll(new Error("Browser DevTools connection closed"));
      });
    });
  }

  private drainBufferedFrames(): void {
    if (this.buffer.length > 0) {
      const buffered = this.buffer;
      this.buffer = Buffer.alloc(0);
      this.handleData(buffered);
    }
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const high = this.buffer.readUInt32BE(2);
        const low = this.buffer.readUInt32BE(6);
        length = high * 2 ** 32 + low;
        offset = 10;
      }
      let mask: Buffer | null = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      if (mask) {
        const unmasked = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i++) {
          unmasked[i] = payload[i]! ^ mask[i % 4]!;
        }
        payload = unmasked;
      }
      this.buffer = this.buffer.subarray(offset + length);

      if (opcode === 0x8) {
        this.closed = true;
        try {
          this.socket?.end();
        } catch {
          /* ignore */
        }
        this.failAll(new Error("Browser closed the DevTools WebSocket"));
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;

      if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        this.fragments.push(Buffer.from(payload));
        if (!fin) continue;
        const complete = Buffer.concat(this.fragments);
        this.fragments = [];
        try {
          this.handleMessage(complete.toString("utf8"));
        } catch {
          // Ignore malformed protocol messages.
        }
      }
    }
  }

  private handleMessage(text: string): void {
    const message = JSON.parse(text) as {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
      sessionId?: string;
    };
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "CDP error"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      const handlers = this.listeners.get(message.method);
      if (!handlers) return;
      for (const handler of handlers) handler(message.params, message.sessionId);
    }
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (!this.socket || this.closed) throw new Error("WebSocket is closed");
    const mask = randomBytes(4);
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.alloc(6);
      header[1] = 0x80 | length;
    } else if (length < 65_536) {
      header = Buffer.alloc(8);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(14);
      header[1] = 0x80 | 127;
      header.writeUInt32BE(Math.floor(length / 2 ** 32), 2);
      header.writeUInt32BE(length % 2 ** 32, 6);
    }
    header[0] = 0x80 | opcode;
    mask.copy(header, length < 126 ? 2 : length < 65_536 ? 4 : 10);
    const masked = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
    this.socket.write(Buffer.concat([header, masked]));
  }

  send(method: string, params: unknown, sessionId?: string): Promise<unknown> {
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`CDP ${method} timed out`));
      }, 30_000);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      try {
        this.sendFrame(0x1, Buffer.from(JSON.stringify(message), "utf8"));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectPromise(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  on(method: string, handler: (params: unknown, sessionId?: string) => void): void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(handler);
    this.listeners.set(method, set);
  }

  off(method: string, handler: (params: unknown, sessionId?: string) => void): void {
    const set = this.listeners.get(method);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.listeners.delete(method);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.sendFrame(0x8, Buffer.alloc(0));
    } catch {
      /* ignore */
    }
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
  }
}

// ── Browser session ────────────────────────────────────────────────────────

export class BrowserSession {
  private browser: ChildProcess | null = null;
  private client: WebSocketClient | null = null;
  private sessionId: string | null = null;
  private targetId: string | null = null;
  private userDataDir: string | null = null;
  private readonly consoleEntries: Array<{ level: string; text: string }> = [];
  private readonly networkErrors: string[] = [];
  private lastNavigationError: string | null = null;
  private launchedUrl: string | null = null;

  constructor(private readonly options: BrowserActionOptions) {}

  private async ensureStarted(): Promise<void> {
    if (this.client && this.sessionId) return;
    const binary = findHeadlessBrowserBinary();
    if (!binary) {
      throw new Error(
        "No Chrome/Edge binary found. Install Google Chrome or Microsoft Edge to use browser automation.",
      );
    }
    const userDataDir = mkdtempSync(join(tmpdir(), "aivo-browser-"));
    this.userDataDir = userDataDir;
    const child = spawn(
      binary,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-extensions",
        "--disable-sync",
        "--mute-audio",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank",
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    this.browser = child;

    const wsUrl = await new Promise<string>((resolvePromise, rejectPromise) => {
      let stderr = "";
      const timer = setTimeout(() => {
        rejectPromise(new Error(`Timed out launching headless browser (${stderr.slice(-400)})`));
      }, 20_000);
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
        if (match?.[1]) {
          clearTimeout(timer);
          resolvePromise(match[1]);
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        rejectPromise(new Error(`Headless browser exited early (code ${code ?? "null"})`));
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        rejectPromise(err);
      });
    });

    const client = await WebSocketClient.connect(wsUrl);
    this.client = client;

    const target = (await client.send("Target.createTarget", { url: "about:blank" })) as {
      targetId: string;
    };
    this.targetId = target.targetId;
    const attached = (await client.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    })) as { sessionId: string };
    this.sessionId = attached.sessionId;

    await this.send("Page.enable", {});
    await this.send("Runtime.enable", {});
    await this.send("Log.enable", {});
    await this.send("Network.enable", {});

    client.on("Runtime.consoleAPICalled", (params) => {
      const row = params as { type?: string; args?: Array<{ value?: unknown; description?: string }> };
      const text = (row.args ?? [])
        .map((arg) =>
          arg.value !== undefined ? String(arg.value) : (arg.description ?? ""),
        )
        .join(" ")
        .slice(0, 2_000);
      if (!text) return;
      this.pushConsole(row.type ?? "log", text);
    });
    client.on("Runtime.exceptionThrown", (params) => {
      const row = params as {
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };
      const text =
        row.exceptionDetails?.exception?.description ??
        row.exceptionDetails?.text ??
        "Uncaught exception";
      this.pushConsole("error", text.slice(0, 2_000));
    });
    client.on("Log.entryAdded", (params) => {
      const row = params as { entry?: { level?: string; text?: string } };
      if (row.entry?.text) this.pushConsole(row.entry.level ?? "log", row.entry.text);
    });
    client.on("Network.loadingFailed", (params) => {
      const row = params as { errorText?: string; type?: string; canceled?: boolean };
      if (row.canceled) return;
      const entry = `${row.type ?? "request"}: ${row.errorText ?? "failed"}`;
      this.networkErrors.push(entry);
      if (this.networkErrors.length > MAX_CONSOLE_ENTRIES) this.networkErrors.shift();
    });
  }

  private pushConsole(level: string, text: string): void {
    // Suppress noisy DevTools self-diagnostics and favicon noise.
    if (/favicon\.ico/i.test(text)) return;
    this.consoleEntries.push({ level, text });
    if (this.consoleEntries.length > MAX_CONSOLE_ENTRIES) this.consoleEntries.shift();
  }

  private send(method: string, params: unknown): Promise<unknown> {
    if (!this.client || !this.sessionId) {
      throw new Error("Browser session is not running");
    }
    return this.client.send(method, params, this.sessionId);
  }

  private assertNavigationAllowed(url: string): void {
    if (this.options.network !== "deny") return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    if (parsed.protocol === "file:" || parsed.protocol === "data:" || parsed.protocol === "about:") {
      return;
    }
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return;
    if (isPrivateOrLocalHost(host)) return;
    throw new Error(
      `Network access is denied for this session; refusing to navigate to ${host}. Use --network allow to permit it.`,
    );
  }

  private resolveUrl(raw: string): string {
    const trimmed = raw.trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
    // Bare path: resolve relative to the workspace and load from disk.
    const abs = join(this.options.cwd, trimmed.replace(/^\.?\//, ""));
    return pathToFileURL(abs).href;
  }

  async open(rawUrl: string): Promise<BrowserResult> {
    const url = this.resolveUrl(rawUrl);
    try {
      this.assertNavigationAllowed(url);
    } catch (err) {
      return { isError: true, output: err instanceof Error ? err.message : String(err) };
    }
    await this.ensureStarted();
    this.consoleEntries.length = 0;
    this.networkErrors.length = 0;
    this.lastNavigationError = null;

    const client = this.client!;
    let resolveLoad: () => void = () => {};
    const loadPromise = new Promise<void>((res) => {
      resolveLoad = res;
    });
    let loadTimer: ReturnType<typeof setTimeout> | null = null;
    const onLoad = (_params: unknown, sessionId?: string): void => {
      if (sessionId && sessionId !== this.sessionId) return;
      cleanupLoad();
      resolveLoad();
    };
    const cleanupLoad = () => {
      if (loadTimer) {
        clearTimeout(loadTimer);
        loadTimer = null;
      }
      client.off("Page.loadEventFired", onLoad);
    };
    loadTimer = setTimeout(() => {
      cleanupLoad();
      resolveLoad();
    }, this.timeoutMs());
    client.on("Page.loadEventFired", onLoad);

    const result = (await this.send("Page.navigate", { url })) as {
      errorText?: string;
      loaderId?: string;
    };
    if (result.errorText) {
      // Detach the pending load listener so a failed navigation cannot leak it.
      cleanupLoad();
      this.lastNavigationError = result.errorText;
      return { isError: true, output: `Navigation failed: ${result.errorText}` };
    }
    await loadPromise;
    this.launchedUrl = url;
    const snapshot = await this.snapshot();
    return {
      output: `Opened ${snapshot.url}\nTitle: ${snapshot.title}\n\n${snapshot.text.slice(0, 4_000)}`,
      snapshot,
    };
  }

  private timeoutMs(): number {
    return Math.max(1_000, this.options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS);
  }

  private async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = (await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })) as {
      result?: { value?: T };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "JavaScript evaluation failed",
      );
    }
    return result.result?.value as T;
  }

  async snapshot(): Promise<BrowserSnapshot> {
    await this.ensureStarted();
    const data = await this.evaluate<Omit<BrowserSnapshot, "console" | "networkErrors">>(`(() => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const clean = (text) => String(text ?? "").replace(/\\s+/g, " ").trim();
      const bodyText = clean(document.body ? document.body.innerText : "").slice(0, ${MAX_TEXT_CHARS});
      const links = Array.from(document.querySelectorAll("a[href]"))
        .filter(visible)
        .slice(0, 60)
        .map((a) => ({ text: clean(a.textContent).slice(0, 120), href: a.href }));
      const buttons = Array.from(document.querySelectorAll("button, [role=button], input[type=submit], input[type=button]"))
        .filter(visible)
        .slice(0, 60)
        .map((el, index) => ({
          text: clean(el.textContent || el.value || el.getAttribute("aria-label")).slice(0, 120),
          index,
          disabled: Boolean(el.disabled),
        }));
      const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
        .filter(visible)
        .slice(0, 60)
        .map((el, index) => ({
          index,
          tag: el.tagName.toLowerCase(),
          type: (el.getAttribute("type") || "").toLowerCase(),
          name: el.getAttribute("name") || el.id || "",
          placeholder: el.getAttribute("placeholder") || "",
          value: String(el.value ?? "").slice(0, 160),
        }));
      return {
        url: location.href,
        title: document.title || "",
        text: bodyText,
        links,
        buttons,
        inputs,
      };
    })()`);
    return {
      ...data,
      console: [...this.consoleEntries],
      networkErrors: [...this.networkErrors],
    };
  }

  formatSnapshot(snapshot: BrowserSnapshot): string {
    const lines: string[] = [
      `URL: ${snapshot.url}`,
      `Title: ${snapshot.title || "(none)"}`,
      "",
      "Text:",
      snapshot.text || "(empty)",
    ];
    if (snapshot.buttons.length > 0) {
      lines.push("", "Buttons:");
      for (const button of snapshot.buttons) {
        lines.push(`  [${button.index}] ${button.text || "(unlabeled)"}${button.disabled ? " (disabled)" : ""}`);
      }
    }
    if (snapshot.inputs.length > 0) {
      lines.push("", "Inputs:");
      for (const input of snapshot.inputs) {
        const label = input.name || input.placeholder || "(unnamed)";
        lines.push(
          `  [${input.index}] <${input.tag}${input.type ? ` type=${input.type}` : ""}> ${label} = ${JSON.stringify(input.value)}`,
        );
      }
    }
    if (snapshot.links.length > 0) {
      lines.push("", "Links:");
      for (const link of snapshot.links.slice(0, 25)) {
        lines.push(`  ${link.text || "(no text)"} -> ${link.href}`);
      }
    }
    if (snapshot.console.length > 0) {
      lines.push("", "Console:");
      for (const entry of snapshot.console.slice(-20)) {
        lines.push(`  [${entry.level}] ${entry.text}`);
      }
    }
    if (snapshot.networkErrors.length > 0) {
      lines.push("", "Network errors:");
      for (const error of snapshot.networkErrors.slice(-10)) lines.push(`  ${error}`);
    }
    return lines.join("\n");
  }

  async click(selector: string): Promise<BrowserResult> {
    await this.ensureStarted();
    const point = await this.evaluate<{ x: number; y: number; text: string } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        text: String(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 120),
      };
    })()`);
    if (!point) {
      return { isError: true, output: `No clickable element matched selector: ${selector}` };
    }
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await this.waitForIdle();
    const snapshot = await this.snapshot();
    return {
      output: `Clicked ${selector}${point.text ? ` ("${point.text}")` : ""}\n\nURL: ${snapshot.url}\nTitle: ${snapshot.title}`,
      snapshot,
    };
  }

  async fill(selector: string, value: string): Promise<BrowserResult> {
    await this.ensureStarted();
    const ok = await this.evaluate<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, ${JSON.stringify(value)});
      else el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    if (!ok) {
      return { isError: true, output: `No input element matched selector: ${selector}` };
    }
    await this.waitForIdle();
    return { output: `Filled ${selector} with ${value.length} character(s).` };
  }

  async pressKey(key: string): Promise<BrowserResult> {
    await this.ensureStarted();
    const mapping: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
      Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
      Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
      Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
      Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    };
    const spec = mapping[key] ?? {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
    };
    for (const type of ["keyDown", "keyUp"] as const) {
      await this.send("Input.dispatchKeyEvent", { type, ...spec });
    }
    await this.waitForIdle();
    return { output: `Pressed ${key}.` };
  }

  async waitFor(selector: string, timeoutMs = this.timeoutMs()): Promise<BrowserResult> {
    await this.ensureStarted();
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = await this.evaluate<boolean>(
        `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      );
      if (found) {
        return { output: `Selector appeared after ${Date.now() - started}ms: ${selector}` };
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    return {
      isError: true,
      output: `Timed out after ${timeoutMs}ms waiting for selector: ${selector}`,
    };
  }

  async evaluateExpression(expression: string): Promise<BrowserResult> {
    await this.ensureStarted();
    const value = await this.evaluate<unknown>(expression);
    const rendered =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return { output: rendered.slice(0, MAX_TEXT_CHARS) };
  }

  async screenshot(fullPage = false): Promise<BrowserResult> {
    await this.ensureStarted();
    const params: Record<string, unknown> = { format: "png" };
    if (fullPage) {
      const metrics = (await this.send("Page.getLayoutMetrics", {})) as {
        cssContentSize?: { width: number; height: number };
        contentSize?: { width: number; height: number };
      };
      const size = metrics.cssContentSize ?? metrics.contentSize;
      if (size) {
        params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
        params.captureBeyondViewport = true;
      }
    }
    const result = (await this.send("Page.captureScreenshot", params)) as { data?: string };
    if (!result.data) return { isError: true, output: "Browser returned no screenshot data" };
    const buffer = Buffer.from(result.data, "base64");
    const dir = mkdtempSync(join(tmpdir(), "aivo-browser-shot-"));
    const outPath = join(dir, "browser.png");
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(outPath, buffer);
      const attachment = loadImageAttachment(outPath);
      return {
        output: `Captured ${attachment.width}x${attachment.height} browser screenshot (${Math.round(buffer.length / 1024)} KB).`,
        screenshot: attachment,
      };
    } finally {
      // loadImageAttachment reads the bytes into memory, so the temp file is disposable.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  private async waitForIdle(): Promise<void> {
    // Give the page a short moment to react to the action, then wait for load state.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    try {
      await this.evaluate<boolean>("document.readyState !== 'loading'");
    } catch {
      // Ignore pages that block evaluation during navigation.
    }
  }

  currentUrl(): string | null {
    return this.launchedUrl;
  }

  close(): void {
    this.client?.close();
    this.client = null;
    this.sessionId = null;
    if (this.browser && !this.browser.killed) {
      try {
        this.browser.kill();
      } catch {
        /* ignore */
      }
    }
    this.browser = null;
    if (this.userDataDir) {
      try {
        rmSync(this.userDataDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
      this.userDataDir = null;
    }
  }
}
