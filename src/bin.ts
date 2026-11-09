#!/usr/bin/env node
import { runCli } from "./cli.js";
import { BackgroundJobManager } from "./background-jobs.js";
import { McpManager } from "./mcp.js";

// Ensure any stale terminal mouse-tracking modes from a prior crashed session are disabled on startup and exit
if (process.stdout.isTTY) {
  process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[>4;0m\x1b[<u");
}
process.on("exit", () => {
  try {
    BackgroundJobManager.stopAllActive();
  } catch {
    /* best-effort shutdown */
  }
  try {
    McpManager.stopAllActive();
  } catch {
    /* best-effort shutdown */
  }
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1007l\x1b[>4;0m\x1b[<u\x1b[?7h\x1b[?25h");
  }
});

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
