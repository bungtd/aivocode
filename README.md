# AivoCode (`@aivokey/cli` / `aivo`)

**AivoCode (`aivo`)** adalah CLI coding harness mandiri yang dirancang khusus untuk ekosistem **AivoKey** (`https://api.aivokey.dev`).

Dirancang dengan mempelajari kelebihan dan memperbaiki kelemahan dari coding harness besar (**Claude Code**, **OpenCode**, **Pi**, **DeepSeek Harness / Codex CLI**, **CommandCode**, dan **Hermes Agent**) saat digunakan di atas AivoKey.

---

## Mengapa AivoCode? (Perbandingan dengan Harness Lain di AivoKey)

| Masalah di Harness Umum saat memakai AivoKey | Solusi Native di AivoCode (`aivo`) |
|---|---|
| **Claude Code** diam-diam memanggil model background `claude-3-5-haiku` jika 6 env var tidak di-set manual → memicu error `403 model_not_in_plan` atau `404 not_found`. | **Smart Model & Subagent Routing:** Memeriksa `/v1/models` dan `/v1/key` secara otomatis. Subagent `explore` otomatis memilih model cepat yang diizinkan oleh paket/free token Anda. |
| **Jebakan `/v1` di Base URL:** Claude Code gagal (`404`) jika diberi `/v1`, sedangkan OpenCode/Codex gagal (`404`) jika lupa menambahkan `/v1`. | **Auto-Normalized Gateway Origin:** Mau diisi `https://api.aivokey.dev`, `https://api.aivokey.dev/`, atau `https://api.aivokey.dev/v1`, AivoCode otomatis menormalisasi setiap endpoint (`/v1/models`, `/v1/key`, `/v1/chat/completions`, `/v1/messages`, `/v1/responses`). |
| **OpenCode / Aider** mengharuskan prefix `aivokey/model` atau `openai/model` serta mendaftarkan daftar model secara manual di file JSON, padahal AivoKey menggunakan *bare canonical model ID* (`deepseek-v4-pro`, `glm-5.3`). | **Zero-Config Bare Canonical Discovery:** Otomatis menyinkronkan katalog `/v1/models` secara live dan membersihkan prefix provider yang tidak sengaja diketik (`aivokey/deepseek-v4-pro` → `deepseek-v4-pro`). |
| **Prompt Cache Miss:** Harness yang menyisipkan timestamp/reminder dinamis di awal percakapan merusak *message-hash* dan *prefix prompt cache* upstream. | **Deterministic Prefix + Sticky Session Header:** Mengirim `x-opencode-session`, `x-session-id`, `x-claude-code-session-id` yang stabil per sesi serta menjaga prefix `systemPrompt` + `AGENTS.md` 100% deterministik agar *cache read* maksimal. |
| **Tidak tahu sisa kuota/faucet/paket AivoKey:** Pengguna harus bolak-balik membuka web console untuk mengecek sisa saldo, free token faucet, atau jendela kuota 5 jam / 7 hari / bulanan. | **Live `/v1/key` Inspector:** Perintah `aivo status` atau `/status` menampilkan saldo mikro-USD, sisa *Free Faucet Tokens* per model, *Purchased Token Packs*, dan progres kuota `5h` / `7d` / `month` langsung di terminal. |
| **Retry buta saat error:** Harness lain terus melakukan retry saat `503 no_supply` tanpa `Retry-After` (padahal itu masalah konfigurasi *discount floor*). | **Canonical AivoKey Error Recovery:** Auto-compact saat `400 context_length_exceeded`, menghormati `Retry-After` pada `429`/`503`, dan berhenti cepat (*fail-fast*) dengan menampilkan `x-air-request-id` saat `503 no_supply` tanpa `Retry-After`. |

---

## Instalasi & Menjalankan

Repositori ini berada di `C:\Dev\Projects\aivokey-cli` (terpisah sepenuhnya dari repositori `aivokey`).

```bash
cd C:\Dev\Projects\aivokey-cli
pnpm install
pnpm build
```

Untuk memasang perintah `aivo` secara global di mesin lokal Anda:

```bash
npm link
```

Atau jalankan langsung:

```bash
node C:\Dev\Projects\aivokey-cli\dist\bin.js --help
```

---

## Quickstart

### 1. Simpan API Key AivoKey Anda

```bash
aivo login sk-aivo_YOUR_KEY
```

Atau gunakan environment variable:

```powershell
$env:AIVOKEY_API_KEY="sk-aivo_YOUR_KEY"
$env:AIVOKEY_BASE_URL="https://api.aivokey.dev"
```

### 2. Cek Koneksi, Kuota & Model (`doctor` / `status` / `models`)

```bash
aivo doctor
aivo status
aivo models --tools
aivo models --free
```

### 3. Mode Interaktif (REPL)

```bash
aivo
```

Di dalam sesi interaktif:
- Ketik tugas coding seperti biasa.
- Gunakan `@path/to/file.ts` untuk melampirkan isi file bernomor baris langsung ke prompt.
- Gunakan `!git status` atau `!pnpm test` untuk menjalankan perintah shell langsung tanpa memakai token LLM.
- Gunakan `/undo` kapan saja untuk membatalkan perubahan file pada giliran terakhir (menggunakan *File Checkpoint* otomatis tanpa `git reset --hard`).

### 4. Mode Non-Interaktif (One-Shot / Otomasi)

```bash
aivo -p "Perbaiki bug validasi di @src/index.ts dan jalankan test"
aivo run "Refactor router" --model deepseek-v4-pro --effort xhigh --wire chat
```

---

## Daftar Slash Commands di Mode Interaktif

| Perintah | Fungsi |
|---|---|
| `/help` | Menampilkan daftar perintah & pintasan |
| `/models [filter]` | Menampilkan katalog model live dari `/v1/models` (`--tools`, `--free`, atau kata kunci) |
| `/model <id>` | Mengganti model aktif (mis. `/model deepseek-v4-pro`, `/model glm-5.3`) |
| `/effort <level>` | Mengatur *reasoning effort* (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `off`) |
| `/wire <wire>` | Mengganti protokol wire AivoKey (`chat`, `messages`, `responses`) |
| `/mode <mode>` | Mengganti mode izin: `auto` (eksekusi penuh), `safe` (konfirmasi sebelum edit/shell), `plan` (read-only arsitek) |
| `/web <on\|off>` | Mengaktifkan/menonaktifkan server-side web search AivoKey |
| `/status` / `/key` | Menampilkan saldo `/v1/key`, token faucet gratis, token pack, kuota plan (`5h`/`7d`/`month`), & statistik cache sesi |
| `/compact` | Memadatkan riwayat percakapan untuk menghemat *context window* dan biaya |
| `/undo` | Mengembalikan file yang diubah/dibuat pada giliran terakhir melalui *CheckpointManager* |
| `/diff` | Menampilkan daftar file yang disentuh sesi ini beserta `git status -s` |
| `/todo` | Menampilkan checklist tugas agen saat ini |
| `/fork` | Mencabangkan percakapan saat ini ke *sticky session ID* baru |
| `/clear` / `/new` | Memulai sesi baru yang bersih |
| `/sessions` | Menampilkan daftar sesi yang tersimpan di `~/.aivokey/sessions` |
| `/exit` / `/quit` | Keluar dari AivoCode |
