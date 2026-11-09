# Changelog

All notable changes to AivoCode (`aivocode` / `aivo`) are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [1.1.2] — 2026-11-12

Patch release: the TUI now measures terminal cells instead of string length,
keeps its layout math in one place, and has a testable keyboard.

### Fixed

**Columns were counted in UTF-16 units, not terminal cells**
- `visibleLength` used `String.length`, so every CJK ideograph or emoji was
  measured as one cell while the terminal painted two. Borders, the sidebar
  divider, and the composer caret drifted by one column per wide character.
- New `src/ui/width.ts` implements East Asian Width (W/F = 2 cells), zero-width
  combining marks and joiners, and grapheme clustering via `Intl.Segmenter`, so a
  ZWJ emoji family paints as one two-cell glyph. `padEndVisible`,
  `truncateVisible`, `fitLineToWidth`, `truncateLineToWidth` and the new
  `sliceToWidth` / `sliceTailToWidth` all work in cells and cut only on grapheme
  boundaries.

**Terminal smaller than the viewport emitted more rows than existed**
- `renderFullScreenViewport` forced `cols >= 60` and `rows >= 16`, so an 80x12
  terminal still got 16 rows. That scrolls the alternate screen and corrupts
  every later frame.
- The real size is now used as-is. Below 40x10 the frame is a single notice plus
  blank rows, and it always fills exactly `rows` lines so no stale content
  survives a resize.

**Renderer and mouse hit-testing duplicated the composer layout**
- The row math for the input box lived twice: once in `renderFullScreenViewport`
  and once in `getComposerLineLayout` for clicks. They could drift apart.
- New `src/ui/layout.ts` owns `viewportGeometry`, `computeComposerLayout`,
  `visibleInputWindow` and `scrollWindow`; both paths call it.

**Composer overflowed and misplaced the caret on wide-character input**
- The input line was sliced with `slice(rawLine.length - maxChars)`, so a line of
  Japanese text overflowed the box and the caret sat several columns off.
- New `src/ui/input-line.ts` windows the line in display cells, budgets one cell
  for the caret and one per ellipsis, and maps clicks back to cluster
  boundaries (`charIndexAtCell`).

**Transcript wrap split words**
- `wrapTranscriptLines` hard-broke at the column, mid-word. It now backtracks to
  the last space, indents continuation lines, and reopens the active SGR style;
  only a single word wider than the pane is hard-broken.

**Transcript grew without bound**
- Every tool card, diff hunk and streamed paragraph appended a line, so a long
  session reached tens of megabytes.
- Capped at `MAX_TRANSCRIPT_LINES` (5000), trimmed from the top in `render()`,
  with the streaming assistant/reasoning/tool-progress indices shifted by the
  same amount so in-flight blocks keep splicing correctly. `scrollOffset` is
  clamped after trimming.

**Esc had three different meanings**
- It cleared the selection, then cleared the buffer, and also reset scroll, so
  the viewport could jump unexpectedly. It now does one thing per state in a
  fixed order (close overlay, clear selection, clear buffer) and never scrolls.

**`Ctrl+U` meant two different things**
- It opened the subagent inspector in the full-screen TUI but cleared the line in
  the inline composer.
- `Ctrl+U` now clears the input line in both (readline convention); subagent
  inspection moved to `Alt+U`. README, footer, welcome banner and `/help` updated.

**Dead and duplicated input decoding**
- `parseSgrMouseEvent` and the streaming splitter had separate button-bit
  decoders that could disagree. Both now share `decodeSgrMouse` in
  `src/ui/keyboard.ts`, which also owns CSI-u / modifyOtherKeys translation and
  paste normalization. `fullscreen.ts` re-exports the helpers for compatibility.

**Two input editors had two newline rules**
- `isNewlineKey()` in `src/ui/keymap.ts` is now the single rule for
  Shift+Enter, Alt+Enter, Ctrl+Enter, Ctrl+J and CSI-u modified Enter; the
  composer and the full-screen TUI both call it.

### Changed

- The hotkey contract is a pure function: `resolveHotkey(key, ctx)` with an
  explicit priority of modal, then streaming, then editor. While a turn streams
  only interrupt (`Esc`, `Ctrl+C`), monitoring (`Alt+U`, `Alt+J`, `Ctrl+B`) and
  `Ctrl+U` (clear input) are active.
- Modal filtering, selection wrapping, list windowing and the row builders moved
  to `src/ui/modal-nav.ts` and `src/ui/modal-options.ts`, so they are testable
  without a TTY.
- `fullscreen.ts` keeps only the imperative shell (render loop, agent callbacks,
  command execution) and documents the module split at the top of the file.

### Tests
- New `ui-width-layout.test.ts` (26) covers cell widths, padding/truncation,
  viewport geometry, input windowing, row integrity at 40x10 through 200x50, and
  word wrap for ASCII, CJK and long words.
- New `keymap.test.ts` (12) pins every hotkey and the modal/streaming priority.
- New `modal-nav.test.ts` (6) and `modal-options.test.ts` (7).
- Suite is 41 files / 281 tests, up from 39 / 268.

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
