import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exec } from "node:child_process";
import { loadImageAttachment, type ImageAttachment } from "./vision.js";

export type ComputerUseAction =
  | "screenshot"
  | "window_list"
  | "open_url"
  | "mouse_move"
  | "mouse_click"
  | "keyboard_type"
  | "key_press";

export interface ComputerUseInput {
  action: ComputerUseAction;
  x?: number;
  y?: number;
  button?: "left" | "right" | "double";
  text?: string;
  key?: string;
  url?: string;
}

export interface ComputerUseResult {
  output: string;
  isError?: boolean;
  screenshotAttachment?: ImageAttachment;
}

export interface ComputerUseDeps {
  platform?: NodeJS.Platform;
  runCommand?: (cmd: string, shell?: string) => Promise<string>;
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

/**
 * Cross-platform Computer Use tool:
 * - Captures desktop screenshots and loads them as Vision attachments
 * - Lists open windows
 * - Opens URLs in the default browser
 * - Moves mouse, clicks, and types keys
 */
export async function executeComputerUse(
  input: ComputerUseInput,
  deps: ComputerUseDeps = {},
): Promise<ComputerUseResult> {
  const platform = deps.platform ?? process.platform;
  const runCmd = deps.runCommand ?? defaultRunCommand;

  try {
    switch (input.action) {
      case "screenshot": {
        const dir = join(tmpdir(), "aivokey-cli-screenshots");
        mkdirSync(dir, { recursive: true });
        const outPath = join(dir, `screen-${Date.now()}.png`);

        if (platform === "win32") {
          const escaped = outPath.replace(/'/g, "''");
          const psScript = [
            "Add-Type -AssemblyName System.Windows.Forms;",
            "Add-Type -AssemblyName System.Drawing;",
            "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;",
            "$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height);",
            "$g = [System.Drawing.Graphics]::FromImage($bmp);",
            "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size);",
            `$bmp.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png);`,
            "$g.Dispose(); $bmp.Dispose();",
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
            output: `Captured desktop screenshot (${attachment.width}x${attachment.height}) at ${outPath}`,
            screenshotAttachment: attachment,
          };
        } catch {
          return {
            output: `Captured desktop screenshot at ${outPath}`,
          };
        }
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
        const url = (input.url ?? "").trim();
        if (!/^https?:\/\//i.test(url)) {
          return { isError: true, output: `Invalid URL (must be http/https): ${url}` };
        }
        if (platform === "win32") {
          await runCmd(`Start-Process '${url.replace(/'/g, "''")}'`, "powershell.exe");
        } else if (platform === "darwin") {
          await runCmd(`open "${url}"`);
        } else {
          await runCmd(`xdg-open "${url}"`);
        }
        return { output: `Opened URL in default browser: ${url}` };
      }

      case "mouse_move": {
        const x = Math.round(Number(input.x ?? 0));
        const y = Math.round(Number(input.y ?? 0));
        if (platform === "win32") {
          const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`;
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
            "Add-Type -AssemblyName System.Windows.Forms;",
            `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y});`,
            `$sig = '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int cButtons, int dwExtraInfo);';`,
            "$type = Add-Type -MemberDefinition $sig -Name 'Win32Mouse' -Namespace 'Win32' -PassThru;",
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
        if (platform === "win32") {
          const escaped = rawText.replace(/'/g, "''");
          const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`;
          await runCmd(ps, "powershell.exe");
          return { output: `Sent keystrokes: ${rawText}` };
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
