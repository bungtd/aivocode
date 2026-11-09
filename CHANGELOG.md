# Changelog

All notable changes to AivoCode (`aivocode` / `aivo`) are documented here.
This project follows [Semantic Versioning](https://semver.org/).

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
