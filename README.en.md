# AGY SUITE (`agy-suite`)

**[한국어](./README.md) | English**

A zero-dependency, modular quality-of-life and observability suite for Antigravity. It ships as **3 independently toggleable static plugins** that address quota/compaction visibility, unexpected editor restarts, command stalls, sidebar session clutter, and cache-safe cross-session memory.

> **Note**: `AGY SUITE` is a standalone repository separate from legacy `AGY ORBIT`. Install only the plugins you need, and toggle each one natively inside Antigravity's Customizations UI.

---

## Symptom -> Solution Overview

| What You Are Experiencing | Plugin | What Changes |
| :--- | :--- | :--- |
| Anxious about remaining `5h`/weekly quota or how close you are to auto-compaction | **`agy-suite-hud`** | Adds a right-pane sidecar with model-family-aware compaction estimates, real KV cache hit %, and fail-closed `5h`/weekly quota gauges. |
| Want to watch the main agent and swarm workers' reasoning in real time | **`agy-suite-hud`** | Streams per-agent and per-swarm-worker reasoning tabs in offline `raw` mode by default. Zero background load when the pane is closed. |
| Editor restarts mid-task or fans spin loudly from watcher/search indexing loops | **`agy-suite-core`** | `/doctor` diagnoses common causes and patches IDE/workspace settings with a comment-preserving JSONC patcher and `.agy-bak-*` backups. |
| Shell commands or subagent waits hang indefinitely | **`agy-suite-core`** | Adds a compact `~1.2KB` Anti-Stall rule (`rules/AGENTS.md`) enforcing command timeouts and one-shot wait watchdogs. |
| 100+ old conversations cluttering the sidebar | **`agy-suite-core`** | `/cleanup` safely archives idle conversations (`archived: true`, dry-run first), protecting current, running, pinned, and starred sessions without deleting transcripts. |
| Context resets across sessions, or you want to queue tasks from another PC / bot | **`agy-suite-sync`** *(Opt-in / Labs)* | Provides cache-safe 2-tier memory (`MEMORY.md` + `MEMORY_ARCHIVE.md`), optional async Git sync, and a serverless `WORK_NOTES.md` Markdown inbox. |

---

## 3 Independently Toggleable Static Plugins

One deterministic CLI (`install.mjs`) installs up to 3 standalone plugins into `~/.gemini/config/plugins/`. Default installation (`hud,core`) sends `0 bytes` over the network; `sync` is opt-in.

1. **`agy-suite-hud` (`AGY SUITE — HUD`)**
   - Right-pane sidecar (`sidecar://agy-suite-hud/hud_pane/`) displaying per-agent and per-swarm-worker reasoning tabs alongside a bottom telemetry bar.
   - **Model-family-aware auto-calibrating compaction estimate**: Tracks separate baselines (`~515K` Gemini, `~160K` Claude, `~100K` GPT-OSS) and distinguishes `CHECKPOINT` drops after manual `/compact` from real auto-compaction events.
   - **Real KV cache hit %**: Computed directly from transcript usage metadata (`cache_read_tokens / (input_tokens + cache_read_tokens)`).
   - **Fail-closed `5h` / `weekly` quota gauges**: Enforces a 10-minute max stale window and immediately fails closed (`—`) on schema mismatch rather than displaying guessed numbers.
   - Offline `raw` mode by default; optional Gemini 1st-person restoration is strictly opt-in.
2. **`agy-suite-core` (`AGY SUITE — Core`)**
   - Read-only `/doctor` diagnostics + comment-preserving JSONC patcher (`.agy-bak-*` backups, `antigravity.heartbeatIntervalMs: 0`, `**/antigravity/**` watcher/search exclusions).
   - `/cleanup` safe bulk session archiver (`ConversationService` `archived: true`, dry-run default, never calls `DeleteConversation`).
   - Compact `~1.2KB` Anti-Stall rules (`rules/AGENTS.md`) and `/setup` helper.
3. **`agy-suite-sync` (`AGY SUITE — Memory & Bridge`, Opt-in / Labs)**
   - Cache-safe 2-tier memory: hot `MEMORY.md` (`<9,500 chars` / `18KB` budget with `SessionStart` warning) + on-demand `MEMORY_ARCHIVE.md`.
   - **Local-Only mode (default, zero Git)** vs. **Multi-PC async Git sync** (fast-path dirty check with `0` spawns on untouched turns, PID-liveness lock, `git merge-file` 3-way merge, best-effort pre-push secret-leak regex net).
   - Optional serverless `WORK_NOTES.md` Markdown inbox with `worknote:done` completion receipts.

---

## 4-Point Trust Shield & Honest Disclosure

1. **Zero External npm Dependencies (`dependencies: {}`, `devDependencies: {}`)**
   - No `node_modules`. Built strictly on Node.js `>= 18` built-in `node:*` modules.
2. **Deterministic CLI & Automated Tests as Source of Truth**
   - Run `npm test`, `node install.mjs --doctor`, and `node install.mjs --dry-run` yourself to inspect exact behavior before mutating anything. `INSTALL_FOR_AGENTS.md` is a convenience wrapper—do not blindly trust a fork's prompt without inspecting the code or running `npm test`.
3. **Offline & Read-Only by Default**
   - `agy-suite-hud` (`raw` mode), `agy-suite-core` (`/doctor`), and `agy-suite-sync` (Local-Only mode) transmit `0 bytes` to external servers.
4. **Non-Destructive Backups & Clean Uninstall**
   - Every settings edit writes a timestamped `.agy-bak-*` backup and can be reverted via `--uninstall --restore-backups`. `~/.gemini/config/config.json` is never modified.

> **Honest Disclosure**
> - **100% Vibe-Coded Project**: All code, tests, and documentation in this repository were authored and iterated 100% through vibe coding with AI agents. While audited across 2 adversarial review passes and backed by `52` automated tests, please inspect the code and verify `npm test` and `--dry-run` output before applying it to your environment.
> - **Optional 1st-Person Restoration vs. Verbatim Reasoning**: The default offline `raw` mode displays Antigravity's reasoning summary verbatim with zero alteration. If you opt in to **1st-person monologue restoration (`gemini` mode)**, the translation and natural-phrasing polish step may slightly diverge from a literal 100% word-for-word translation of the original reasoning text (stay in `raw` mode whenever you need exact verbatim text).
> - **Internal Surface Dependencies**: `transcript_full.jsonl`, `agy -p /usage`, `ConversationService`, and `antigravity.heartbeatIntervalMs` rely on Antigravity internal surfaces that may change across releases. Adapters are isolated and fail closed when schemas drift.
> - **Git Remote Sync Trust Boundary**: Because `MEMORY.md` is always loaded into session rules, **anyone with push access to your `MEMORY.md` sync repository must be fully trusted** (use a private, single-owner repository only). `GEMINI.md` is **never synced by default** unless explicitly opted in via `"syncGeminiMd": true` in `sync/config.json`. Resolve merge conflicts explicitly with `memory-sync.mjs --resolve=local|remote`.
> - **`WORK_NOTES.md` Security Boundary**: When enabling external bots (`workNotesEnabled: true`), grant them access only to a **trusted private single-owner repository** or a **separate `WORK_NOTES`-only repository** isolated from `MEMORY.md`. `/work-notes` treats external block bodies as untrusted data and requires explicit user confirmation before executing any action.
> - **Secret-Leak Guard Scope**: The pre-push regex check in `agy-suite-sync` is a **best-effort last-line safety net**, not a DLP replacement.
> - **Platform Support**: Tested Windows-first; POSIX/macOS/Linux compatibility adapters are provided as-is. In headless or browser-restricted environments, use `open-room.mjs --print-auth-url` to print the HUD auth URL directly.

---

## Quick Start

Requirement: **Node.js `>= 18.0.0`**

### Option A: Drop Folder into Antigravity (Convenience Wrapper)

Clone or unzip this repository, open it in Antigravity, and paste this one-line prompt. Your agent will verify `dependencies: {}` and `npm test`, run read-only `--doctor`, ask which plugins/options you want, and preview `--dry-run` before applying.

```text
Read INSTALL_FOR_AGENTS.md in this folder. First inspect package.json (zero dependencies and scripts) and the test entry files before running `npm test`, then run read-only `node install.mjs --doctor --json`. Ask me which plugins and options I want, preview `--dry-run`, and install safely after my confirmation.
```

### Option B: Direct Deterministic CLI (Primary Verifiable Path)

```bash
# 0. Clone repository
git clone https://github.com/BBsouS/agy-suite.git
cd agy-suite

# 1. Run full automated test suite and release audit
npm test

# 2. Run read-only environment diagnostics
node install.mjs --doctor

# 3. Preview planned changes without writing files
node install.mjs --dry-run --modules=hud,core

# 4. Install selected plugins (default: hud,core; or hud,core,sync)
node install.mjs --modules=hud,core
# Full install with settings patch and auto-open HUD rule:
# node install.mjs --modules=hud,core,sync --apply-settings --auto-open-hud

# 5. Uninstall (optionally restoring settings backups)
node install.mjs --uninstall
# node install.mjs --uninstall --restore-backups
```

---

## Track 2 Expert & Integration Docs

- [Architecture, Prefix-Cache Math & Full CLI Reference (`docs/EXPERT.md`)](./docs/EXPERT.md)
- [5-Minute Work-Notes Bridge Guide for Bots, Obsidian & n8n (`docs/WORK_NOTES_BRIDGE.md`)](./docs/WORK_NOTES_BRIDGE.md)
- [OS-Specific Troubleshooting: AdGuard, PowerShell, macOS PATH, inotify (`docs/TROUBLESHOOTING.md`)](./docs/TROUBLESHOOTING.md)
- [Agent Installation Runbook (`INSTALL_FOR_AGENTS.md`)](./INSTALL_FOR_AGENTS.md)

## License

[MIT](./LICENSE)
