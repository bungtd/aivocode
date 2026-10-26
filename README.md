# AivoCode (`@aivokey/cli` / `aivo`) v1.0

**AivoCode (`aivo`)** adalah Full-Screen AI Coding Studio & Agent Harness di terminal yang dirancang khusus untuk ekosistem **AivoKey** (`https://api.aivokey.dev`).

Menggabungkan arsitektur terbaik dari **OpenCode V2**, **Claude Code**, **DeepSeek Harness (`dsh`)**, **Pi (`pi-coding-agent`)**, **Codex CLI**, **CommandCode**, dan **Hermes Agent**, sekaligus memperbaiki seluruh kelemahannya saat berjalan di atas AivoKey.

---

## Fitur Utama AivoCode v1.0

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
| **`Ctrl+A`** | Membuka **Specialist Agent Team & Workflow Modal** |
| **`Ctrl+P`** | Membuka **Command Palette Modal** (semua perintah & aksi) |
| **`Ctrl+E`** | Memutar *Reasoning Effort* secara *live* (`off` → `minimal` → `low` → `medium` → `high` → `xhigh` → `max`) |
| **`Ctrl+W`** | Memutar protokol Wire AivoKey (`chat` → `messages` → `responses`) |
| **`Ctrl+B`** | Menampilkan / menyembunyikan *Right Telemetry Sidebar* |
| **`F2`** | Memutar cepat antar model di katalog |
| **`PgUp` / `PgDn`** | Menggulir (*scroll*) riwayat percakapan di viewport utama |
| **`Esc`** | Membatalkan streaming LLM yang sedang berjalan atau menutup modal |

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

### 5. Multimodal Vision & Computer Use (`src/vision.ts`, `src/computer-use.ts`)
- **Multimodal Vision:** Mendeteksi PNG, JPEG, GIF, dan WebP dari *magic bytes*, membaca dimensi piksel (`width × height`), dan mengirimkannya pada wire `chat`, `messages`, maupun `responses`. Jika model aktif belum mendukung vision, otomatis merutekan langkah tersebut ke model vision AivoKey (`deepseek-v4-flash`, `gemini-3.8-flash`, `claude-sonnet-5-5`).
- **Computer Use (`computer_use` / `/screenshot`):** Mengambil *screenshot* layar desktop secara langsung ke Vision, melihat daftar window aplikasi yang terbuka (`window_list`), membuka URL di browser (`open_url`), serta menggerakkan/klik mouse dan mengetik keyboard.

### 6. Self-Learning Memory, Self-Evolving Skills & Anti-AI-Slop Guard
- **Self-Learning Memory (`~/.aivokey/memory/memories.jsonl`):** Menyimpan pelajaran bug, arsitektur proyek, dan preferensi pengguna (`memory_remember`, `memory_search`, `/memory`) serta menyuntikkannya sebagai konteks pre-step tanpa merusak *prompt cache* AivoKey.
- **Multi-Harness Skill Loader & Self-Evolving Skill Creator (`src/skills.ts`):** Memuat skill dari `.aivokey/skills`, `.opencode/skills`, `.dsh/skills`, `.claude/skills`, dan memungkinkan AivoCode menciptakan skill baru sendiri lewat tool `skill_create`!
- **Anti-AI-Slop Quality Guard (`src/anti-slop.ts` / `/audit`):** Mendeteksi dan menolak *placeholder* malas (`// TODO: implement`, `// ... rest of code`), fungsi stub belum selesai, dan penggunaan `as any` buta.
- **Snapshots `/undo` & `/redo` (`src/checkpoint.ts`) + `/btw` Side Questions:** Membatalkan atau mengembalikan perubahan file per giliran tanpa `git reset --hard`, serta menjawab pertanyaan sampingan cepat lewat `/btw <pertanyaan>` tanpa mengotori riwayat sesi.

---

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
