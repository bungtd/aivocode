# Changelog

All notable changes to AivoCode (`aivocode` / `aivo`) are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [1.1.1] — 2026-11-11

Patch release: the TUI now exposes every command and can switch sessions.

### Fixed

**Slash palette was incomplete and truncated**
- `SLASH_COMMANDS` listed 41 of the 55 commands `handleSlashCommand` handles, so
  `/sessions`, `/new`, `/agents`, `/bg`, `/ps`, `/logs`, `/kill`, `/inspect`,
  `/key`, `/usage`, `/web`, `/settings`, `/quit`, `/subagent-model` and
  `/fast-model` never appeared in the `/` dropdown, the `Ctrl+P` palette, or
  `/help`.
- `computeComposerSuggestions` sliced matches to 8, hiding the rest of the list.
  It now returns every match, and the dropdown scrolls with `↑/↓ N more` and a
  `26-35/54` position indicator instead of clipping.
- Prefix matches rank first, so `/mo` surfaces `/mode` before `/model` and
  `/memory`.

**Sessions could not be switched or resumed from the TUI**
- The `sessions` modal id existed in the type union but nothing ever opened it,
  and the TUI called `handleSlashCommand` with `interactive: false`, so
  `/sessions` only printed a list.
- New Session Switcher on `Ctrl+R` or `/sessions`: 50 recent sessions with
  model, message count, cost and timestamp. `Enter` resumes in place and the
  transcript replays from history; `Del` deletes a saved session (the active one
  is protected). `/new`, `/clear` and `/fork` use the same path.
- Starting with `-c` / `-s <id>` now replays the conversation into the
  transcript instead of opening an empty screen.

**Resuming leaked session-scoped state**
- Only `agent.session` was swapped, so `/undo` kept reading the previous
  session's checkpoint directory and `/jobs` the previous job directory.
- New `AivoAgent.switchSession()` rebuilds the `CheckpointManager` and
  `BackgroundJobManager` for the new session id, resets todos and subagent runs,
  and syncs model and wire.

**CLI**
- `aivo sessions` prints the resume hint (`-c`, `-s <id>`, `Ctrl+R`) and
  supports `--json`.

### Tests
- New `slash-command-coverage.test.ts` fails when a command is handled but
  unlisted, or listed but unhandled, and pins the untruncated palette.
- Added TUI render tests for a 54-item dropdown and the session modal, plus a
  `switchSession` isolation test.
- Fixed two Windows teardown races in the LSP and MCP suites.

## [1.1.0] — 2026-11-10

Feature release: closes the remaining capability gaps against other coding-agent
harnesses, plus the security and reliability fixes found while building them.

### Added

**MCP**
- Streamable HTTP, legacy SSE, and stdio transports with resources, prompts,
  pagination, and per-server `sandbox` / `network` / `approval` policy.
- OAuth 2.1 for remote servers: RFC 9728 discovery, Dynamic Client
  Registration, Authorization Code + PKCE, persisted tokens, and refresh.
- `aivo mcp auth [server]` for the interactive authorization flow.
- Sampling (`sampling/createMessage`), elicitation (`elicitation/create`), and
  server notifications (`notifications/message`, `notifications/progress`),
  advertised only when a handler is wired.

**Code intelligence**
- LSP client and `lsp_*` tools: diagnostics, hover, definitions, references,
  document symbols, and workspace symbols. Diagnostics are appended after edits.
- `aivo lsp [--json|restart [server]]`.

**Editor and headless integration**
- ACP v1 server (`aivo acp`) for Zed, Neovim, and VS Code bridges.
- Versioned JSONL event stream: `aivo run "<prompt>" --events-json`.

**Automation**
- Browser automation over the Chrome DevTools Protocol: `browser_navigate`,
  `browser_snapshot`, `browser_interact`, `browser_screenshot`.
- Jupyter notebook editing: `notebook_read`, `notebook_edit`.

**Durability**
- Persistent `/undo` checkpoints per session (`~/.aivokey/checkpoints/<id>`).
- Persistent background jobs (`~/.aivokey/jobs/<id>`) with lost-job detection
  and `/jobs restart <id>`.

**Extensibility**
- Lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `Stop`, `SessionEnd`) with JSON payloads and exit-code
  semantics.
- Custom slash commands from `.aivokey/commands/*.md`.
- In-process plugin runtime with tools and hooks.

**Observability**
- Span trees for turns, model calls, tools, workflow stages, and subagents.
- Prometheus/JSON metrics, Chrome Trace and OTLP export, `aivo trace`,
  `aivo metrics`.

**Security**
- `permissions.ts`: per-kind allow/ask/deny glob rules, plan-mode enforcement,
  and symlink-aware workspace containment.
- OS sandboxing: bubblewrap (Linux), `sandbox-exec` (macOS), and a native
  AppContainer + Job Object helper (Windows), with an advisory fallback.
- Child processes no longer inherit secrets: `run_shell`, background jobs,
  hooks, and MCP stdio get a scrubbed environment, and `AIVOKEY_API_KEY` is
  always denied.

### Fixed
- Plugin tools bypassed the permission gate entirely; mutating plugin tools now
  require approval and are hidden in plan/read-only mode.
- OAuth bearer tokens were written into the user's config object and could be
  printed or re-saved; they now live in private transport state.
- `web_fetch` SSRF guard did not recognize IPv4-mapped IPv6 literals such as
  `::ffff:127.0.0.1`.
- Browser automation leaked a `Page.loadEventFired` listener on every timeout
  or failed navigation, and never removed its screenshot temp directory.
- MCP servers answering `401`/`403` never recovered; the client now forces a
  token refresh and reconnects once.
- Worktree merge did not detect renames/copies and reported every changed file
  as newly added.
- Subagents that mutate files now run in isolated git worktrees and merge back,
  with a safe fallback when the workspace is not a git repo.

### Changed
- Subagent worktree isolation can be disabled with `worktreeIsolation: false`,
  `--no-worktrees`, or `AIVO_DISABLE_WORKTREES=1`.
- Tracing is opt-in; metrics are always available through `MetricsRegistry`.
- `AIVO_DISABLE_OS_SANDBOX=1` disables the OS shell sandbox (used by tests/CI)
  while path policy stays active.

## [1.0.2] — previous release

- In-place updates: `aivo update`, daily version notice.
