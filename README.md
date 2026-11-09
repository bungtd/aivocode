# AivoCode (`aivocode` / `aivo`) v1.1.1

**AivoCode (`aivo`)** adalah Full-Screen AI Coding Studio & Agent Harness di terminal yang dirancang khusus untuk ekosistem **AivoKey** (`https://api.aivokey.dev`).

Menggabungkan arsitektur terbaik dari **OpenCode V2**, **Claude Code**, **DeepSeek Harness (`dsh`)**, **Pi (`pi-coding-agent`)**, **Codex CLI**, **CommandCode**, dan **Hermes Agent**, sekaligus memperbaiki seluruh kelemahannya saat berjalan di atas AivoKey.

---

## Instalasi

```bash
# Node.js >= 20
npm install -g aivocode

# Verifikasi
aivo --version
aivo doctor
```

Atau dari tarball rilis:

```bash
npm install -g --force https://aivokey.dev/cli/download/aivocode-1.1.1.tgz
```

Konfigurasi disimpan di `~/.aivokey/config.json` (permission `0600`). Key juga dapat diberikan lewat `AIVOKEY_API_KEY`.
Project dapat menimpa sebagian setting melalui `.aivokey.json` di root workspace; **jangan menaruh API key di file project yang di-commit**.

---

## Fitur Utama AivoCode v1.1
### 1. Full-Screen Alt-Buffer TUI Studio (100% Viewport Terminal)
- Menggunakan **Alternate Screen Buffer (`\x1b[?1049h`)** yang mengisi **100% lebar × tinggi (`columns × rows`)** terminal Anda dan otomatis menyesuaikan ukuran saat window di-resize.
- **Split-Pane Studio Layout:**
  - **Top Header Bar:** Menampilkan versi, path workspace, branch Git (`⎇ main*`), mode aktif (`AUTO · BUILD`, `PLAN · ARCHITECT`, `SAFE · CONFIRM`), dan model aktif.
  - **Main Conversation & Streaming Pane (Kiri ~72%):** Menampilkan percakapan, *Thinking block* (`💭`), kartu eksekusi tool (`● Read`, `● Edit`, `● Bash`), **Colored Unified Diff** bernomor baris (`+` hijau, `-` merah), dan output Markdown.
  - **Right Telemetry & Workspace Sidebar (Kanan ~28%, toggle `Ctrl+B`):** Menampilkan saldo live `/v1/key`, kuota Plan/Faucet, persentase pemakaian *Context Window*, *Prompt Cache Hit %*, biaya mikro-USD, **Active Specialist Team (`[ARCH → BACK → FRONT → QA]`)**, **Task Board (`todo_write`)**, dan **Touched Files**.
  - **Bottom Docked Composer Box + Floating Overlays:**
    - Ketik **`/`** → langsung memunculkan **Floating Slash Command Palette** secara *real-time*.
    - Ketik **`@`** → langsung memunculkan **Floating `@file` Fuzzy Finder** (mendukung `@file.ts#10-40` rentang baris & `@image.png` lampiran gambar Vision).
- **Mode Ringkas (`aivo mini` / `--mini`):** Tersedia juga mode inline seperti `opencode mini`.

### 2. Pintasan Keyboard Global (Single-Keystroke Hotkeys)
| Tombol | Fungsi |
|---|---|
| **`Shift+Tab`** / **`Ctrl+T`** | Memutar mode izin secara *live*: `AUTO (Build)` → `PLAN (Architect)` → `SAFE (Confirm)` |
| **`Ctrl+K`** | Membuka **Interactive Model Switcher Modal** (43+ model live AivoKey) |
| **`Ctrl+G`** | Memilih model untuk subagent & role spesialis |
| **`Ctrl+R`** | Membuka **Session Switcher** (berpindah & melanjutkan sesi tersimpan) |
| **`Ctrl+U`** | Inspeksi subagent: daftar run, log, dan output |
| **`Alt+J`** | Inspeksi background terminal job (log, kill, relaunch) |
| **`Ctrl+A`** | Membuka **Specialist Agent Team & Workflow Modal** |
| **`Ctrl+P`** | Membuka **Command Palette Modal** (semua perintah & aksi) |
| **`Ctrl+E`** | Memutar *Reasoning Effort* secara *live* (`off` → `minimal` → `low` → `medium` → `high` → `xhigh` → `max`) |
| **`Ctrl+W`** | Memutar protokol Wire AivoKey (`chat` → `messages` → `responses`) |
| **`Ctrl+B`** | Menampilkan / menyembunyikan *Right Telemetry Sidebar* |
| **`F2`** | Memutar cepat antar model di katalog |
| **`PgUp` / `PgDn`** | Menggulir (*scroll*) riwayat percakapan di viewport utama |
| **`Esc`** | Membatalkan streaming LLM yang sedang berjalan atau menutup modal |

**Session switcher (`Ctrl+R` atau `/sessions`).** Sesi disimpan per-`sessionId` di `~/.aivokey/sessions/*.jsonl`. Modal menampilkan 50 sesi terbaru lengkap dengan model, jumlah pesan, biaya, dan waktu; `Enter` melanjutkan sesi itu **tanpa keluar dari TUI** (transkrip langsung diputar ulang), `Del` menghapus sesi tersimpan (sesi yang sedang aktif tidak bisa dihapus). Dari CLI: `aivo -c` melanjutkan sesi terakhir, `aivo -s <id>` melanjutkan sesi tertentu, `aivo sessions` mendaftar sesi.

Saat berpindah sesi, `switchSession()` juga memindahkan state yang terikat sesi: checkpoint `/undo` dan background job dibaca dari direktori sesi baru, sementara todo, daftar subagent, dan id plugin di-reset — jadi `/undo` tidak pernah memutar file dari sesi lain.

**Palet `/` menampilkan seluruh perintah.** Daftar perintah adalah satu sumber (`src/ui/select.ts`) yang dipakai bersama oleh autocomplete `/`, Command Palette (`Ctrl+P`), dan `/help`; test `slash-command-coverage` gagal bila sebuah perintah ada di handler tetapi tidak terdaftar. Dropdown menampilkan jendela bergulir (bukan memotong daftar) dengan indikator `↑/↓ N more`.

### 3. 7 Specialist Agent Teams & Multi-Stage Workflows (`src/teams.ts`)
Pilih tim lewat **`Ctrl+A`**, perintah **`/team <id>`**, atau jalankan workflow penuh lewat **`/workflow <tujuan>`** / **`aivo workflow "<tujuan>"`**:
1. **`fullstack` — Full-Stack Engineering Team (`[ARCH → BACK → FRONT → QA]`)**:
   - *Full-Stack System Architect* → *Backend & Database Engineer* → *Frontend & UX Engineer* → *Full-Stack QA & Anti-Slop Reviewer*.
2. **`backend` — Backend, API & Distributed Systems Team (`[ARCH → IMPL → SEC]`)**:
   - *Distributed Systems Architect* → *API & Database Implementer* → *Security, Egress & Performance Auditor*.
3. **`frontend` — Frontend, Design System & Web UX Team (`[UX → UI → A11Y]`)**:
   - *UX & Design System Director* → *Frontend Component Engineer* → *Accessibility & Web Perf Reviewer*.
4. **`android` — Android & Mobile Engineering Team (`[ARCH → KT → QA]`)**:
   - *Android Clean Architecture Lead* → *Kotlin & Jetpack Compose Developer* → *Android Lifecycle & Build QA*.
5. **`blender3d` — 3D Blender & Procedural Asset Team (`[3D-ART → BPY → 3D-QA]`)**:
   - *3D Technical Art Director* → *Blender Python (`bpy`/`bmesh`) Engineer* → *3D Mesh & Vision QA Validator*.
6. **`gamedev` — Game Development Team (`[DESIGN → GAME → QA]`)**:
   - *Lead Game Systems Designer* → *Gameplay & Shader Programmer* → *Frame-Budget & Playability QA* (Godot, Unity, Unreal, Three.js, WebGL).
7. **`autopilot` — Guided Beginner Autopilot Team (`[GUIDE → BUILD → LAUNCH]`)**:
   - Dirancang khusus untuk pengguna **tanpa latar belakang IT/coding**: menerjemahkan ide bahasa sehari-hari menjadi aplikasi siap pakai dan memberikan panduan penggunaan bebas jargon teknis.

### 4. Client-Side WebSearch Router & HTML-to-Markdown WebFetch (`src/web.ts`)
- **Tidak menggunakan server-side websearch AivoKey.**
- **`web_search`:** Merutekan pencarian secara client-side lintas **Exa (`EXA_API_KEY`)**, **Tavily (`TAVILY_API_KEY`)**, **Firecrawl (`FIRECRAWL_API_KEY`)**, **Brave (`BRAVE_API_KEY`)**, dan **Zero-Key DuckDuckGo HTML Fallback** (otomatis berfungsi meskipun tanpa API key pencari tambahan!), lengkap dengan *cooldown* `Retry-After` saat HTTP 429 dan rotasi otomatis.
- **`web_fetch`:** Mengambil halaman web (`markdown` | `text` | `html`) dan mengonversi HTML menjadi Markdown bersih (headings, links, code blocks, lists) seperti OpenCode V2.

### 5. MCP Client — Tools & Resources (`src/mcp.ts`)
- Mendukung **stdio** (`command` + `args`), **Streamable HTTP** (`transport: "http"`), dan **legacy SSE** (`transport: "sse"`).
- Server dikonfigurasi lewat `mcpServers` di `~/.aivokey/config.json` atau `.aivokey.json`:
  ```json
  {
    "mcpServers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\work"]
      },
      "remote": {
        "url": "https://mcp.example.com/mcp",
        "transport": "http",
        "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
      },
      "untrusted": {
        "command": "npx",
        "args": ["-y", "@example/mcp-server"],
        "sandbox": "workspace",
        "network": "deny",
        "approval": "ask"
      }
    }
  }
  ```
- **Isolasi MCP:** server `stdio` berjalan di OS sandbox yang sama dengan `run_shell` (AppContainer di Windows, bwrap/sandbox-exec di Unix) dan **tidak mewarisi seluruh environment**. Variabel sensitif (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, password, credential, dsb.) dibuang; secret hanya masuk lewat `env` server yang eksplisit.
- **Policy per server:** `sandbox` (`inherit` default, `workspace`, `read-only`, `danger-full-access`), `network` (`allow`/`deny`), dan `approval` (`ask` default untuk tool non-read-only di mode auto, `auto`, `deny`).
- Server yang butuh membaca config/kredensial di luar workspace harus dipindahkan ke workspace, diberi `sandbox: "danger-full-access"`, atau dijalankan lewat transport HTTP yang sudah dikelola server itu sendiri. Server dengan `approval: "ask"` akan gagal di `aivo run` headless tanpa prompt; set `approval: "auto"` hanya untuk server yang dipercaya.
- Perubahan `sandbox`, `network`, `env`, atau `approval` pada server yang sedang berjalan berlaku setelah `/mcp restart [server]` (atau `aivo mcp restart [server]`).
- Tool MCP muncul sebagai `mcp__<server>__<tool>` dan otomatis mengikuti permission mode:
  - `plan`: hanya tool dengan `annotations.readOnlyHint: true`.
  - `safe`: setiap pemanggilan MCP dimintai konfirmasi.
- Resource MCP tersedia lewat tool `mcp_list_resources` dan `mcp_read_resource`; prompt template lewat `mcp_list_prompts` dan `mcp_get_prompt`.
- Client mengiklankan capability `roots` dan menjawab `roots/list`/`ping`; `instructions` dari server MCP otomatis masuk ke system prompt.
- Server yang gagal dicoba ulang otomatis setelah cooldown 30 detik; restart manual dengan `/mcp restart [server]` atau `aivo mcp restart [server]`. HTTP session yang kedaluwarsa di-reinitialize otomatis.
- Cek koneksi dengan `/mcp` atau `aivo mcp`; output JSON dengan `aivo mcp --json`.
- OAuth dapat memakai header statis/token environment (`Authorization: Bearer ${MCP_TOKEN}`); flow OAuth interaktif tersedia lewat `aivo mcp auth`.
- `${VAR}` di `env`/`headers`/`url` diekspansi dari environment.
- **OAuth untuk server remote (HTTP/SSE):**
  - Discovery `/.well-known/oauth-protected-resource` (RFC 9728) → authorization-server metadata (`/.well-known/oauth-authorization-server` atau `/.well-known/openid-configuration`).
  - **Dynamic Client Registration** (RFC 7591) dan **Authorization Code + PKCE (S256)** dengan callback server lokal di `127.0.0.1`.
  - Token disimpan di `~/.aivokey/mcp-auth.json` (mode 0600) per origin; refresh otomatis dilakukan bila `expiresAt` < 60 detik dan refresh token tersedia, atau saat server membalas `401`/`403` (reconnect sekali dengan token baru).
  - `aivo mcp auth [server]` menjalankan alur interaktif; `McpAuthStore` bisa dipakai untuk inspeksi/clear.
- **Sampling (`sampling/createMessage`):** server dapat meminta completion; AivoCode menjalankannya lewat model aktif dan mengembalikan `{ role, content, model, stopReason }`. Sampling hanya diiklankan saat handler tersedia; tanpa handler server menerima error `-32601`.
- **Elicitation (`elicitation/create`):** diteruskan ke prompt konfirmasi; `decline` dipakai otomatis di mode headless.
- **Notifikasi server:** `notifications/message` dan `notifications/progress` diteruskan ke UI; `notifications/tools/list_changed` tetap memicu refresh tool otomatis.
- Status `/mcp` menampilkan `oauth`, `sampling`, dan `elicitation` per server.

### 6. LSP Code Intelligence (`src/lsp.ts`)
- Client LSP stdio minimal (JSON-RPC 2.0, `Content-Length` framing) tanpa dependency tambahan.
- **Auto-detect** saat `lspServers` tidak dikonfigurasi: `typescript-language-server`, `pyright-langserver`, `pylsp`, `rust-analyzer`, `gopls` — hanya yang benar-benar ada di `PATH`.
- Konfigurasi eksplisit di `~/.aivokey/config.json` atau `.aivokey.json`:
  ```json
  {
    "lspServers": {
      "typescript": {
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "extensions": [".ts", ".tsx", ".js", ".jsx"],
        "languageId": "typescript"
      },
      "python": {
        "command": "pyright-langserver",
        "args": ["--stdio"],
        "extensions": [".py"],
        "settings": { "python": { "analysis": { "typeCheckingMode": "basic" } } }
      }
    }
  }
  ```
- Tool agent (read-only): `lsp_diagnostics`, `lsp_hover`, `lsp_definition`, `lsp_references`, `lsp_document_symbols`, `lsp_workspace_symbols`.
- **Auto-diagnostics setelah edit:** `write_file`, `edit_file`, dan `apply_patch` menambahkan ringkasan diagnostik (maks. 8 item, timeout 1.5 dtk) sehingga model langsung melihat error yang baru muncul.
- Server di-restart dengan `/lsp restart [server]` atau `aivo lsp restart [server]`; status lewat `/lsp`, `aivo lsp`, `aivo lsp --json`, dan `aivo doctor`.

### 7. Multimodal Vision & Computer Use (`src/vision.ts`, `src/computer-use.ts`)
- **Multimodal Vision:** Mendeteksi PNG, JPEG, GIF, dan WebP dari *magic bytes*, membaca dimensi piksel (`width × height`), dan mengirimkannya pada wire `chat`, `messages`, maupun `responses`. Jika model aktif belum mendukung vision, otomatis merutekan langkah tersebut ke model vision AivoKey (`deepseek-v4-flash`, `gemini-3.8-flash`, `claude-sonnet-5-5`).
- **Computer Use (`computer_use` / `/screenshot`):** Mengambil *screenshot* layar desktop secara langsung ke Vision, melihat daftar window aplikasi yang terbuka (`window_list`), membuka URL di browser (`open_url`), serta menggerakkan/klik mouse dan mengetik keyboard. Kontrol mouse/keyboard native tersedia di Windows; di macOS/Linux memerlukan `cliclick`/`xdotool` dan akan mengembalikan error yang jelas jika tidak tersedia (bukan sukses palsu).

### 8. Self-Learning Memory, Self-Evolving Skills & Anti-AI-Slop Guard
- **Self-Learning Memory (`~/.aivokey/memory/memories.jsonl`):** Menyimpan pelajaran bug, arsitektur proyek, dan preferensi pengguna (`memory_remember`, `memory_search`, `/memory`) serta menyuntikkannya sebagai konteks pre-step tanpa merusak *prompt cache* AivoKey.
- **Multi-Harness Skill Loader & Self-Evolving Skill Creator (`src/skills.ts`):** Memuat skill dari `.aivokey/skills`, `.opencode/skills`, `.dsh/skills`, `.claude/skills`, dan memungkinkan AivoCode menciptakan skill baru sendiri lewat tool `skill_create`!
- **Anti-AI-Slop Quality Guard (`src/anti-slop.ts` / `/audit`):** Mendeteksi dan menolak *placeholder* malas (`// TODO: implement`, `// ... rest of code`), fungsi stub belum selesai, dan penggunaan `as any` buta.
- **Snapshots `/undo` & `/redo` (`src/checkpoint.ts`) + `/btw` Side Questions:** Membatalkan atau mengembalikan perubahan file per giliran tanpa `git reset --hard`, serta menjawab pertanyaan sampingan cepat lewat `/btw <pertanyaan>` tanpa mengotori riwayat sesi.

### 9. Hooks, Custom Commands & Plugins (`src/hooks.ts`, `src/plugins.ts`)
- **Lifecycle hooks** dideklarasikan di `~/.aivokey/config.json` atau `.aivokey.json`:
  ```json
  {
    "hooks": {
      "SessionStart": [{ "command": "node .aivokey/hooks/greet.mjs" }],
      "UserPromptSubmit": [{ "command": "node .aivokey/hooks/guard-prompt.mjs" }],
      "PreToolUse": [
        { "matcher": "write_file|edit_file", "command": "node .aivokey/hooks/protect.mjs" }
      ],
      "PostToolUse": [{ "matcher": "edit_file", "command": "npm run lint --silent" }],
      "Stop": [{ "command": "node .aivokey/hooks/require-tests.mjs", "timeoutMs": 60000 }]
    }
  }
  ```
- Event yang didukung: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`. Nama bersifat case-insensitive dan menerima alias (`pre_tool_use`, `pretooluse`, dst.).
- Hook menerima **JSON payload di stdin** (`event`, `sessionId`, `cwd`, `mode`, `tool{name,args}`, `prompt`, `result`, `stopReason`) dan boleh menulis JSON di stdout:
  ```json
  { "decision": "block", "reason": "...", "args": { "...": "..." }, "additionalContext": "..." }
  ```
- **Exit code:** `0` = lanjut, `2` = blokir operasi, lainnya = warning non-blocking. `args` dari `PreToolUse` menggantikan argumen tool. `Stop` yang memblokir meminta satu pass tambahan (maks. 2).
- Hook berjalan dengan environment yang sudah dibersihkan (`permissions.env` tetap berlaku), timeout default 30 detik (maks. 120 detik).
- **Custom slash commands** dari `.aivokey/commands/<name>.md` (workspace) dan `~/.aivokey/commands` (user), dengan frontmatter `description` / `argument-hint` dan placeholder `$ARGUMENTS`, `$1`..`$9`. Command workspace menang jika namanya bentrok.
- **Plugins** berupa ES module di `.aivokey/plugins/*.mjs` atau `~/.aivokey/plugins/*.mjs`:
  ```js
  export default function plugin(api) {
    api.on("PreToolUse", { matcher: "write_file" }, async ({ tool }) => {
      if (String(tool.args.path).endsWith(".lock")) return { block: "lock files are protected" };
    });
    api.addTool(
      { name: "project_stats", description: "Workspace stats", parameters: { type: "object", properties: {} } },
      async (_args, ctx) => ({ output: `cwd=${ctx.cwd}` }),
    );
  }
  ```
- Plugin yang gagal dimuat dilaporkan dan dilewati; satu plugin rusak tidak menggagalkan sesi. Plugin berjalan in-process dengan hak Node penuh — hanya pasang plugin yang sudah direview.
- Tool dari plugin mengikuti gate permission yang sama seperti tool bawaan: di `plan` mode hanya tool dengan `annotations: { readOnlyHint: true }` yang diiklankan, dan tool yang memutasi tetap meminta konfirmasi di `safe` mode.
- Inspeksi: `/hooks`, `/commands`, `/plugins` di TUI/REPL, atau `aivo hooks`, `aivo plugins` (keduanya mendukung `--json`).

### 10. ACP & Headless Event Stream (`src/acp.ts`, `src/events.ts`)
- **Agent Client Protocol v1** lewat `aivo acp` (stdio, newline-delimited JSON-RPC). Cocok untuk Zed, Neovim, bridge VS Code, atau klien ACP lain.
- Method yang didukung: `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/set_mode`, `session/close`.
- Update yang dikirim ke editor: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update` (termasuk diff), `plan`, `current_mode_update`, `available_commands_update`, `usage_update`, dan `notice` bila klien mengiklankan dukungan.
- Membalas `session/request_permission` untuk konfirmasi tool; `allow_once`/`allow_always`/`reject_once`.
- History replay pada `session/load`; `session/cancel` membatalkan turn dan mengembalikan `stopReason: "cancelled"`.
- **JSONL event stream** untuk CI/headless: `aivo run "<prompt>" --events-json`.
  ```json
  {"type":"start","version":1,"sessionId":"ses_...","model":"...","cwd":"..."}
  {"type":"reasoning","text":"..."}
  {"type":"text","text":"..."}
  {"type":"tool_start","name":"edit_file","args":{...}}
  {"type":"tool_progress","name":"edit_file","bytes":123,"lines":4,"preview":"..."}
  {"type":"tool_end","name":"edit_file","output":"...","isError":false,"diff":{...}}
  {"type":"todo","todos":[...]}
  {"type":"notice","message":"...","level":"info"}
  {"type":"result","text":"...","steps":3,"usage":{...},"costMicro":"8","elapsedMs":1234}
  ```
- Tool output dipotong 2000 karakter secara default; pakai `--full-output` untuk output penuh. Event `error` dikirim sebelum proses gagal.

### 11. Browser & Notebook Automation (`src/browser.ts`, `src/notebook.ts`)
- **Browser automation lewat Chrome DevTools Protocol** — tanpa Playwright/Puppeteer, memakai Chrome/Edge yang sudah terdeteksi. WebSocket RFC 6455 diimplementasikan langsung di Node.
- Tool: `browser_navigate`, `browser_snapshot`, `browser_interact` (`click`, `fill`, `press`, `wait`, `eval`), `browser_screenshot`.
- Snapshot mengembalikan title, visible text, link, tombol, input, console messages, dan failed network requests.
- `browser_screenshot` mengembalikan PNG (viewport atau full-page) sebagai lampiran Vision.
- Navigasi tunduk pada `permissions.network`: `deny` hanya mengizinkan `file:`, `data:`, `about:`, localhost, dan host privat; host publik ditolak.
- Browser dijalankan headless dengan `--user-data-dir` sementara dan dimatikan di akhir turn (tidak ada proses yang bocor).
- **Notebook `.ipynb`**: `notebook_read` menampilkan sel bernomor, `notebook_edit` mendukung `edit` / `insert` / `delete` sambil mempertahankan `metadata`, `nbformat`, dan output sel lain. Edit sel code otomatis mengosongkan output lama. `notebookToScript()` mengekstrak kode yang bisa dijalankan tanpa Jupyter (magic `%`/`!` dibuang).

### 12. Subagent Worktree Isolation (`src/worktree.ts`)
- Setiap subagent yang boleh menulis (dan setiap stage team workflow yang bukan read-only) mendapat **git worktree sendiri** di `%TEMP%/aivokey-worktrees/<repo>/<label>-<rand>` dengan branch `aivo/<label>-<rand>`.
- Subagent berjalan dengan `cwd` worktree, jadi dua subagent paralel tidak saling menimpa file, `git checkout`, atau branch.
- Saat subagent selesai, diff-nya di-merge balik ke workspace utama memakai `git apply --3way`; konflik dilaporkan ke UI dan file yang bentrok dibiarkan.
- Worktree + branch dibersihkan otomatis (termasuk saat subagent error), dan `git worktree prune` dijalankan.
- Fallback aman: jika workspace bukan repo git atau belum punya commit, subagent memakai workspace bersama dan mencatat alasannya.
- Kontrol: `worktreeIsolation: false` di config, `--no-worktrees`, tombol **Subagent Worktree Isolation** di `/config`, atau environment `AIVO_DISABLE_WORKTREES=1`.

### 13. Durability (`src/checkpoint.ts`, `src/background-jobs.ts`)
- **Checkpoint persisten:** riwayat `/undo` dan `/redo` disimpan di `~/.aivokey/checkpoints/<sessionId>/` sehingga tetap ada setelah CLI ditutup atau crash.
  - Snapshot file disimpan base64 per turn; file yang baru dibuat dicatat sebagai "belum ada" agar undo menghapusnya.
  - Retensi: maksimal 30 turn dan 256 MiB per sesi (yang tertua dipangkas lebih dulu).
  - `redo.json` menyimpan tumpukan redo terpisah supaya tidak muncul sebagai turn undoable setelah restart.
  - File checkpoint yang korup dilewati, bukan menggagalkan sesi.
  - Subagent/reviewer ephemeral tetap in-memory agar tidak menumpuk direktori.
- **Background job persisten:** metadata job disimpan di `~/.aivokey/jobs/<sessionId>/`.
  - Job yang masih `running` saat proses lama mati ditandai `lost` setelah restart, lengkap dengan catatan di log.
  - `/jobs restart <id>` (atau pilihan **↻ Relaunch This Job** di modal job) menjalankan ulang command dengan shell/args yang sama.
  - Log ditulis maksimal sekali per detik agar dev server tidak menulis disk terus-menerus.
  - Retensi default 50 job per sesi.
- `/checkpoints` menampilkan jumlah turn undoable/redoable dan direktori sesi.

### 14. Observability (`src/telemetry.ts`, `src/telemetry-cli.ts`)
- **Tracing tanpa dependency** (tanpa OpenTelemetry SDK): span tree dengan `traceId`, `spanId`, `parentSpanId`, kind (`agent`, `model`, `tool`, `subagent`, `workflow`, ...), attributes, events, dan status.
- Span otomatis dibuat untuk: setiap turn (`turn`), setiap panggilan model (`model.call`), setiap tool (`tool.<name>`), setiap stage workflow (`stage.<badge>`), dan workflow (`workflow`).
- **Export**:
  - `--trace <file.jsonl>` menulis satu span per baris.
  - `aivo trace <file>` merender pohon span dengan durasi dan atribut; `--json` untuk data mentah.
  - `Tracer.toChromeTrace()` untuk `chrome://tracing` / Perfetto.
  - `Tracer.toOtlpJson()` untuk collector OTLP.
- **Metrics** (`MetricsRegistry`): counter, gauge, histogram.
  - Metrik bawaan: `aivo_turns_total`, `aivo_turn_duration_ms`, `aivo_tokens_total`, `aivo_model_errors_total`, `aivo_tool_calls_total`, `aivo_tool_errors_total`, `aivo_tool_duration_ms`, `aivo_workflows_total`, `aivo_turn_errors_total`.
  - `--metrics-prom` mencetak format Prometheus; `aivo metrics` juga tersedia. `--metrics-json` / `aivo metrics --json` untuk JSON.
- `/telemetry` di TUI menampilkan ringkasan span per kind dan jumlah metric series.
- Tracing bersifat opt-in; saat tidak aktif, span tetap bisa dibuat tapi tidak direkam sehingga tidak ada overhead I/O.

---

### 15. Permission Rules & Sandbox (`src/permissions.ts`, `src/sandbox.ts`)
- **Sandbox filesystem** untuk tool file: default `workspace`; baca/tulis di luar workspace akan meminta konfirmasi (atau ditolak di one-shot/CI karena tidak ada prompt interaktif).
- **Rule allow/ask/deny** per kategori (`read`, `write`, `shell`, `webfetch`) memakai glob:
  ```json
  {
    "sandbox": "workspace",
    "permissions": {
      "network": "allow",
      "allowOutsideWorkspace": false,
      "env": ["GITHUB_TOKEN", "NPM_TOKEN"],
      "read": [{ "pattern": "**/*.env", "action": "deny" }],
      "shell": [
        { "pattern": "npm *", "action": "allow" },
        { "pattern": "rm -rf *", "action": "deny" }
      ]
    }
  }
  ```
- **OS shell sandbox best-effort**:
  - Linux: `bubblewrap` (`bwrap`) jika terpasang → filesystem root read-only, cwd writable, network bisa di-`--unshare-net`.
  - macOS: `sandbox-exec` jika tersedia.
  - Windows: **AppContainer + Job Object native** lewat helper PowerShell/C# (`~/.aivokey/win-sandbox.ps1`). Workspace mendapat ACL sesuai mode, cwd dipetakan lewat drive `subst` sementara, network diblokir tanpa capability `internetClient`, dan child process dibunuh bersama Job Object. Profil AppContainer stabil per workspace+mode agar grant ACL hanya sekali.
  - Windows tool cache: `node`/`npm`/`npx` disalin sekali (sekitar 100 MB) ke `~/.aivokey/sandbox-tools/nodejs` karena instalasi Node di `Program Files` sering tidak punya ACE `ALL APPLICATION PACKAGES`. Repo dengan `node_modules` symlink ala pnpm yang menunjuk absolut ke `C:\...` masih bisa gagal karena AppContainer tidak bisa traverse root `C:\`; gunakan layout `node_modules` biasa/hoisted jika ingin menjalankan test di dalam sandbox.
- Mode `plan` selalu menolak write/shell; `sandbox: "read-only"` menolak write file tool.
- **Secret isolation:** `run_shell`, background jobs, dan MCP stdio tidak mewarisi seluruh environment. Nama variabel sensitif dibuang otomatis; tambahkan nama/glob yang memang dibutuhkan ke `permissions.env`, misalnya `["GITHUB_TOKEN", "NPM_*"]`. `AIVOKEY_API_KEY` selalu diblokir.
- `AIVO_DISABLE_OS_SANDBOX=1` mematikan OS shell sandbox (dipakai test/CI); path policy tool file tetap aktif.
- Opsi **Always allow in session** pada prompt konfirmasi hanya berlaku untuk operasi yang sama selama sesi berjalan.
- Tambah rule langsung dari TUI: `/permissions` membuka **editor modal fullscreen** (tambah rule per kategori, ubah allow/ask/deny, hapus dengan `Del`, toggle network/outside-workspace, clear). Di REPL non-fullscreen tetap bisa `/permissions allow|ask|deny <read|write|shell|webfetch> <pattern>` atau `/permissions clear`.
- Shell background dari `/bg` memakai sandbox yang sama dengan `run_shell`.
- Lihat/ubah lewat `/sandbox`, `/permissions`, `aivo --sandbox <mode>`, `aivo --network deny`, atau `aivo --allow-outside-workspace`.

## Cara Menggunakan

```powershell
# 1. Buka Full-Screen TUI Studio (100% layar terminal)
aivo

# 2. Atau buka mode inline ringkas
aivo mini

# 3. Lihat daftar 7 Specialist Agent Teams
aivo teams

# 4. Jalankan workflow tim spesialis secara langsung
aivo workflow "Buat REST API autentikasi JWT beserta unit test" --team backend
aivo workflow "Buat script Blender Python meja kayu low-poly" --team blender3d

# 5. Perintah one-shot cepat
aivo -p "Analisa @src/agent.ts#1-60"
```

---

## Variabel Environment

| Variabel | Fungsi |
|---|---|
| `AIVOKEY_API_KEY` | API key AivoKey (menimpa config file) |
| `AIVOKEY_BASE_URL` / `GATEWAY_URL` | Origin gateway alternatif |
| `AIVOKEY_MODEL`, `AIVOKEY_FAST_MODEL` | Model utama / subagent |
| `AIVOKEY_WIRE` | `chat`, `messages`, atau `responses` |
| `AIVOKEY_REASONING_EFFORT`, `AIVOKEY_SUBAGENT_EFFORT` | Effort reasoning |
| `AIVOKEY_MODE` | `auto`, `plan`, atau `safe` |
| `AIVOKEY_WEB_SEARCH` | `1`/`0` untuk mengaktifkan web search client-side |
| `AIVO_NO_UPDATE_CHECK` | Nonaktifkan pemeriksaan update harian |
| `AIVO_ALLOW_PRIVATE_FETCH` | Izinkan `web_fetch` ke localhost/IP privat (default: diblokir) |

---

## Batasan & Keamanan

- Mode default adalah `auto` (agent dapat menulis file dan menjalankan shell). Gunakan `--mode safe` atau `--mode plan` untuk pekerjaan yang berisiko.
- `run_shell`/background job/MCP stdio memakai environment yang sudah dibersihkan: variabel sensitif tidak diwariskan, dan `AIVOKEY_API_KEY` selalu diblokir. Secret yang memang diperlukan harus diizinkan eksplisit lewat `permissions.env` atau `mcpServers.<name>.env`.
- `web_fetch` memblokir localhost/IP privat secara default (SSRF guard). Override dengan `AIVO_ALLOW_PRIVATE_FETCHCH=1` untuk dev server lokal.
- Review-Fix Gate default menggunakan audit statis (anti-slop, JSON, referensi asset HTML). Reviewer model sungguhan hanya berjalan bila `reviewerModel` dikonfigurasi.
- Snapshot `/undo` dipersist per sesi di `~/.aivokey/checkpoints/<sessionId>` (maks. 30 turn / 256 MiB, otomatis dipangkas), sehingga undo tetap tersedia setelah CLI di-restart. Gunakan git untuk rewind jangka panjang.
- Background job dipersist per sesi di `~/.aivokey/jobs/<sessionId>` (maks. 50 job). Job yang prosesnya mati saat CLI keluar ditandai `lost` dan bisa dilanjutkan dengan `/jobs restart <id>`.
- TUI membutuhkan terminal interaktif; gunakan `aivo -p` di CI/pipe.
