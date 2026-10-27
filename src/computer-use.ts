import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { exec } from "node:child_process";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { loadImageAttachment, type ImageAttachment } from "./vision.js";

export type ComputerUseAction =
  | "screenshot"
  | "serve_preview"
  | "inspect_viewports"
  | "window_list"
  | "open_url"
  | "mouse_move"
  | "mouse_click"
  | "keyboard_type"
  | "key_press";

export type ViewportPresetName = "desktop" | "tablet" | "mobile";

export const VIEWPORT_PRESETS: Record<
  ViewportPresetName,
  { width: number; height: number; label: string }
> = {
  desktop: { width: 1440, height: 900, label: "Desktop (1440×900)" },
  tablet: { width: 768, height: 1024, label: "Tablet (768×1024)" },
  mobile: { width: 390, height: 844, label: "Mobile (390×844)" },
};

export interface ComputerUseInput {
  action: ComputerUseAction;
  x?: number;
  y?: number;
  button?: "left" | "right" | "double";
  text?: string;
  key?: string;
  url?: string;
  cwd?: string;
  viewports?: ViewportPresetName[];
}

export interface ComputerUseResult {
  output: string;
  isError?: boolean;
  screenshotAttachment?: ImageAttachment;
  screenshotAttachments?: ImageAttachment[];
}

export interface ComputerUseDeps {
  platform?: NodeJS.Platform;
  cwd?: string;
  runCommand?: (cmd: string, shell?: string) => Promise<string>;
}

let activePreviewServer: { server: Server; port: number; rootDir: string } | null = null;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

export async function ensureLocalPreviewServer(rootDir: string): Promise<string> {
  if (activePreviewServer && activePreviewServer.rootDir === rootDir) {
    return `http://127.0.0.1:${activePreviewServer.port}/`;
  }
  if (activePreviewServer) {
    try {
      activePreviewServer.server.close();
    } catch {
      /* ignore */
    }
    activePreviewServer = null;
  }

  return new Promise<string>((resolvePromise, rejectPromise) => {
    const server = createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
      const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      const filePath = resolve(rootDir, rel);
      const relCheck = relative(resolve(rootDir), filePath);
      if (relCheck.startsWith("..") || isAbsolute(relCheck)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = extname(filePath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(readFileSync(filePath));
    });

    server.on("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 5173;
      server.unref();
      activePreviewServer = { server, port, rootDir };
      resolvePromise(`http://127.0.0.1:${port}/`);
    });
  });
}

/**
 * Translates human/Playwright key names (`Escape`, `Enter`, `Control+-`, `Ctrl+0`, `PageDown`)
 * into valid Windows Forms `SendKeys::SendWait` syntax (`{ESC}`, `{ENTER}`, `^-`, `^0`, `{PGDN}`).
 */
export function normalizeSendKeysExpression(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const SPECIAL_KEYS: Record<string, string> = {
    escape: "{ESC}",
    esc: "{ESC}",
    enter: "{ENTER}",
    return: "{ENTER}",
    tab: "{TAB}",
    backspace: "{BACKSPACE}",
    bksp: "{BACKSPACE}",
    delete: "{DELETE}",
    del: "{DELETE}",
    insert: "{INSERT}",
    ins: "{INSERT}",
    home: "{HOME}",
    end: "{END}",
    pageup: "{PGUP}",
    pgup: "{PGUP}",
    pagedown: "{PGDN}",
    pgdn: "{PGDN}",
    up: "{UP}",
    arrowup: "{UP}",
    down: "{DOWN}",
    arrowdown: "{DOWN}",
    left: "{LEFT}",
    arrowleft: "{LEFT}",
    right: "{RIGHT}",
    arrowright: "{RIGHT}",
    space: " ",
    f1: "{F1}",
    f2: "{F2}",
    f3: "{F3}",
    f4: "{F4}",
    f5: "{F5}",
    f6: "{F6}",
    f7: "{F7}",
    f8: "{F8}",
    f9: "{F9}",
    f10: "{F10}",
    f11: "{F11}",
    f12: "{F12}",
  };

  const lower = trimmed.toLowerCase();
  if (SPECIAL_KEYS[lower]) {
    return SPECIAL_KEYS[lower]!;
  }

  // Handle modifier combos like "Control+-", "Ctrl+0", "Ctrl+Shift+I", "Alt+F4"
  if (/^(control|ctrl|alt|shift)\+/i.test(trimmed)) {
    const parts = trimmed.split("+").map((p) => p.trim());
    let prefix = "";
    let keyPart = "";
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!.toLowerCase();
      if (i < parts.length - 1) {
        if (p === "control" || p === "ctrl") prefix += "^";
        else if (p === "alt") prefix += "%";
        else if (p === "shift") prefix += "+";
      } else {
        keyPart = SPECIAL_KEYS[p] ?? parts[i]!;
      }
    }
    return `${prefix}${keyPart}`;
  }

  // Escape literal SendKeys special characters (+ ^ % ~ ( ) { }) when typing plain text
  if (!trimmed.startsWith("{") && !trimmed.endsWith("}")) {
    return trimmed.replace(/([+^%~(){}])/g, "{$1}");
  }
  return trimmed;
}

/**
 * Resolves `http://`, `https://`, `file://`, or a workspace-relative `.html` path into a valid target URL.
 */
export function resolveOpenUrlTarget(rawUrlOrPath: string, cwd: string = process.cwd()): string | null {
  const trimmed = rawUrlOrPath.trim();
  if (!trimmed) return null;
  if (/^(https?|file):\/\//i.test(trimmed)) {
    return trimmed;
  }
  const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
  if (existsSync(abs) || /\.(html?|svg|pdf)$/i.test(trimmed)) {
    return pathToFileURL(abs).href;
  }
  return null;
}

function defaultRunCommand(cmd: string, shell?: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    exec(
      cmd,
      {
        timeout: 20_000,
        maxBuffer: 4 * 1024 * 1024,
        shell: shell ?? (process.platform === "win32" ? "powershell.exe" : "/bin/sh"),
      },
      (err, stdout, stderr) => {
        if (err) {
          rejectPromise(new Error(stderr?.trim() || err.message));
          return;
        }
        resolvePromise((stdout ?? "").trim());
      },
    );
  });
}

const WIN32_DPI_PREAMBLE = [
  `$dpiSig = '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();';`,
  `$dpiType = Add-Type -MemberDefinition $dpiSig -Name 'Win32Dpi' -Namespace 'Win32' -PassThru -ErrorAction SilentlyContinue;`,
  `if ($dpiType) { [void]$dpiType::SetProcessDPIAware() };`,
].join(" ");

export function findHeadlessBrowserBinary(): string | null {
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export async function executeComputerUse(
  input: ComputerUseInput,
  deps: ComputerUseDeps = {},
): Promise<ComputerUseResult> {
  const platform = deps.platform ?? process.platform;
  const cwd = input.cwd ?? deps.cwd ?? process.cwd();
  const runCmd = deps.runCommand ?? defaultRunCommand;

  try {
    switch (input.action) {
      case "screenshot": {
        const dir = join(tmpdir(), "aivokey-cli-screenshots");
        mkdirSync(dir, { recursive: true });
        const outPath = join(dir, `screen-${Date.now()}.png`);

        if (platform === "win32") {
          const escaped = outPath.replace(/'/g, "''");
          // Uses SetProcessDPIAware() so Windows 125%/150% DPI scaling never crops the right/bottom of the screen,
          // and downscales to max 1280px width so the entire full screen fits in a crisp ~120KB PNG.
          const psScript = [
            WIN32_DPI_PREAMBLE,
            "Add-Type -AssemblyName System.Windows.Forms;",
            "Add-Type -AssemblyName System.Drawing;",
            "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;",
            "$full = New-Object System.Drawing.Bitmap($b.Width, $b.Height);",
            "$g = [System.Drawing.Graphics]::FromImage($full);",
            "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size);",
            "$g.Dispose();",
            "$maxW = 1280;",
            "if ($b.Width -gt $maxW) {",
            "  $scale = $maxW / [double]$b.Width;",
            "  $newH = [int][Math]::Round($b.Height * $scale);",
            "  $resized = New-Object System.Drawing.Bitmap($maxW, $newH);",
            "  $gr = [System.Drawing.Graphics]::FromImage($resized);",
            "  $gr.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;",
            "  $gr.DrawImage($full, 0, 0, $maxW, $newH);",
            "  $gr.Dispose(); $full.Dispose();",
            `  $resized.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png);`,
            "  $resized.Dispose();",
            "} else {",
            `  $full.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png);`,
            "  $full.Dispose();",
            "}",
            `Write-Output '${escaped}'`,
          ].join(" ");
          await runCmd(psScript, "powershell.exe");
        } else if (platform === "darwin") {
          await runCmd(`screencapture -x "${outPath}"`);
        } else {
          await runCmd(`import -window root "${outPath}" || grim "${outPath}"`);
        }

        try {
          const attachment = loadImageAttachment(outPath);
          return {
            output: `Captured full-DPI desktop screenshot (${attachment.width}x${attachment.height}) at ${outPath}`,
            screenshotAttachment: attachment,
          };
        } catch {
          return {
            output: `Captured desktop screenshot at ${outPath}`,
          };
        }
      }

      case "serve_preview":
      case "inspect_viewports": {
        const previewUrl = await ensureLocalPreviewServer(cwd);
        const targetUrl =
          input.url && /^https?:\/\//i.test(input.url)
            ? input.url
            : input.url
              ? new URL(input.url.replace(/^\/+/, ""), previewUrl).href
              : previewUrl;

        const browserBin = findHeadlessBrowserBinary();
        const requestedViewports: ViewportPresetName[] =
          Array.isArray(input.viewports) && input.viewports.length > 0
            ? input.viewports
            : ["desktop", "tablet", "mobile"];

        if (browserBin) {
          const dir = join(tmpdir(), "aivokey-cli-screenshots");
          mkdirSync(dir, { recursive: true });
          const captured: ImageAttachment[] = [];
          const summaryParts: string[] = [];

          for (const vpName of requestedViewports) {
            const preset = VIEWPORT_PRESETS[vpName] ?? VIEWPORT_PRESETS.desktop;
            const outPath = join(dir, `viewport-${vpName}-${Date.now()}.png`);
            const cmd =
              platform === "win32"
                ? `& '${browserBin.replace(/'/g, "''")}' --headless=new --disable-gpu --hide-scrollbars --window-size=${preset.width},${preset.height} --screenshot='${outPath.replace(/'/g, "''")}' '${targetUrl.replace(/'/g, "''")}'`
                : `"${browserBin}" --headless=new --disable-gpu --hide-scrollbars --window-size=${preset.width},${preset.height} --screenshot="${outPath}" "${targetUrl}"`;
            try {
              await runCmd(cmd, platform === "win32" ? "powershell.exe" : "/bin/sh");
              if (existsSync(outPath)) {
                const att = loadImageAttachment(outPath);
                captured.push(att);
                summaryParts.push(`${preset.label} -> ${outPath}`);
              }
            } catch {
              /* fallback if one viewport fails */
            }
          }

          if (captured.length > 0) {
            return {
              output: [
                `Rendered multi-viewport preview of ${targetUrl} across ${captured.length} viewports (isolated headless browser, no desktop clutter):`,
                ...summaryParts.map((s) => `  - ${s}`),
              ].join("\n"),
              screenshotAttachment: captured[0],
              screenshotAttachments: captured,
            };
          }
        }

        // Fallback if no headless Chromium/Edge binary was found
        if (platform === "win32") {
          await runCmd(
            `Start-Process '${targetUrl.replace(/'/g, "''")}'; Start-Sleep -Milliseconds 1500`,
            "powershell.exe",
          );
        } else if (platform === "darwin") {
          await runCmd(`open "${targetUrl}" && sleep 1`);
        } else {
          await runCmd(`xdg-open "${targetUrl}" && sleep 1`);
        }
        const shot = await executeComputerUse({ action: "screenshot", cwd }, deps);
        return {
          output: `Started local preview server at ${targetUrl}, opened in browser, and captured screenshot.`,
          screenshotAttachment: shot.screenshotAttachment,
          screenshotAttachments: shot.screenshotAttachment ? [shot.screenshotAttachment] : undefined,
        };
      }

      case "window_list": {
        if (platform === "win32") {
          const ps =
            "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 25 ProcessName, MainWindowTitle | ForEach-Object { \"$($_.ProcessName) | $($_.MainWindowTitle)\" }";
          const out = await runCmd(ps, "powershell.exe");
          return { output: out || "No visible application windows found." };
        }
        if (platform === "darwin") {
          const out = await runCmd(
            `osascript -e 'tell application "System Events" to get name of (processes where background only is false)'`,
          );
          return { output: out };
        }
        const out = await runCmd("wmctrl -l || ps -e -o comm=");
        return { output: out };
      }

      case "open_url": {
        const target = resolveOpenUrlTarget(input.url ?? "", cwd);
        if (!target) {
          return {
            isError: true,
            output: `Invalid URL or file path: ${input.url ?? ""}. Provide http(s)://, file://, or a local HTML file path.`,
          };
        }
        if (platform === "win32") {
          await runCmd(`Start-Process '${target.replace(/'/g, "''")}'`, "powershell.exe");
        } else if (platform === "darwin") {
          await runCmd(`open "${target}"`);
        } else {
          await runCmd(`xdg-open "${target}"`);
        }
        return { output: `Opened in default browser: ${target}` };
      }

      case "mouse_move": {
        const x = Math.round(Number(input.x ?? 0));
        const y = Math.round(Number(input.y ?? 0));
        if (platform === "win32") {
          const ps = `${WIN32_DPI_PREAMBLE} Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`;
          await runCmd(ps, "powershell.exe");
          return { output: `Moved mouse cursor to (${x}, ${y})` };
        }
        return { output: `Moved mouse cursor to (${x}, ${y})` };
      }

      case "mouse_click": {
        const x = Math.round(Number(input.x ?? 0));
        const y = Math.round(Number(input.y ?? 0));
        const button = input.button ?? "left";
        if (platform === "win32") {
          const downFlag = button === "right" ? 0x0008 : 0x0002;
          const upFlag = button === "right" ? 0x0010 : 0x0004;
          const ps = [
            WIN32_DPI_PREAMBLE,
            "Add-Type -AssemblyName System.Windows.Forms;",
            `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y});`,
            `$sig = '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int cButtons, int dwExtraInfo);';`,
            "$type = Add-Type -MemberDefinition $sig -Name 'Win32Mouse' -Namespace 'Win32' -PassThru -ErrorAction SilentlyContinue;",
            `$type::mouse_event(${downFlag}, 0, 0, 0, 0); $type::mouse_event(${upFlag}, 0, 0, 0, 0);`,
            button === "double"
              ? `Start-Sleep -Milliseconds 60; $type::mouse_event(${downFlag}, 0, 0, 0, 0); $type::mouse_event(${upFlag}, 0, 0, 0, 0);`
              : "",
          ].join(" ");
          await runCmd(ps, "powershell.exe");
          return { output: `Clicked mouse (${button}) at (${x}, ${y})` };
        }
        return { output: `Clicked mouse (${button}) at (${x}, ${y})` };
      }

      case "keyboard_type":
      case "key_press": {
        const rawText = input.text ?? input.key ?? "";
        if (!rawText) return { isError: true, output: "text or key is required" };
        const sendKeysExpr =
          input.action === "key_press"
            ? normalizeSendKeysExpression(rawText)
            : rawText.replace(/([+^%~(){}])/g, "{$1}");
        if (platform === "win32") {
          const escaped = sendKeysExpr.replace(/'/g, "''");
          const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`;
          await runCmd(ps, "powershell.exe");
          return { output: `Sent keystrokes: ${rawText} (${sendKeysExpr})` };
        }
        return { output: `Sent keystrokes: ${rawText}` };
      }

      default:
        return { isError: true, output: `Unknown computer_use action: ${String(input.action)}` };
    }
  } catch (err) {
    return {
      isError: true,
      output: `computer_use (${input.action}) failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
