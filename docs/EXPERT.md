# AGY SUITE — Expert Reference (`docs/EXPERT.md`)

Deep technical reference for architecture decisions, prefix-cache math, compaction calibration, fail-closed adapter boundaries, state layout, and non-interactive CLI usage.

---

## 1. Why 3 Static Sibling Plugins Instead of 1 Monolith?

Antigravity already provides native per-plugin enable/disable toggles in Customizations. Dynamically rewriting `hooks.json` or `rules/` inside a single monolithic plugin creates brittle upgrade states and mixes incompatible trust boundaries:

| Plugin | Trust Boundary | Network Egress (Default) | Hooks | Rules |
| :--- | :--- | :--- | :--- | :--- |
| **`agy-suite-hud`** | Read-only observability & sidecar UI | `0 bytes` (`raw` mode) | `PostInvocation`, `Stop` (0 spawns in `raw` or closed pane) | Optional `--auto-open-hud` only |
| **`agy-suite-core`** | Local diagnostics, safe JSONC patching, session archiving | `0 bytes` | None | `rules/AGENTS.md` (`~1.2KB` Anti-Stall) |
| **`agy-suite-sync`** *(Labs)* | Persistent 2-tier memory, async Git sync, external Markdown inbox | `0 bytes` (Local-Only) / User's private Git remote (Multi-PC) | `SessionStart`, `Stop` (fast-path dirty check) | `rules/MEMORY-LOADER.md` (`@[MEMORY.md](...)`) |

Splitting into 3 static manifests means:
- Users who only want the read-only HUD never install Git hooks or workspace patchers.
- Disabling `agy-suite-sync` in Antigravity Customizations cleanly disables both its memory loader rule and its Git hooks without running any script.
- `install.mjs` never mutates `~/.gemini/config/config.json`; it only warns in `/doctor` if an existing disabled entry shadows a reinstalled plugin.

---

## 2. Prefix-Cache Math & 2-Tier Memory Discipline

LLM prompt-caching (KV prefix cache) hashes the exact leading token sequence of each request:
- Every file loaded via `rules/` is injected near the top of the prompt prefix on every turn.
- Mutating a `rules/`-loaded file mid-session invalidates the cached prefix from that point onward, forcing a full cache rebuild on the next turn.

`agy-suite-sync` protects prefix cache hit rates through three rules:
1. **Strict Hot-Tier Budget**: `MEMORY.md` stays under `9,500 chars` / `18KB` (well below Antigravity's `24,000-byte` per-rule truncation ceiling). `SessionStart` emits a 1-line budget warning only when `MEMORY.md` approaches or exceeds `9,500 chars`.
2. **Boundary-Only Updates**: `MEMORY-LOADER.md` instructs the agent to update `MEMORY.md` at session boundaries or milestone completions rather than on every intermediate turn.
3. **Zero-Idle-Token Cold Tiers**: `MEMORY_ARCHIVE.md` and `WORK_NOTES.md` are **never** loaded via `rules/`. They consume `0` prefix tokens unless explicitly read on demand (`read_file` or `/work-notes`).

---

## 3. Compaction Calibration & `CHECKPOINT` Separation (`agy-suite-hud`)

Antigravity does not expose a public API for the exact auto-compaction threshold per model. `agy-suite-hud` estimates proximity to compaction from `transcript_full.jsonl` usage records while guarding against statistical false positives:

### Model-Family Separation
Thresholds are tracked and calibrated independently per model family:
- **`gemini`**: `~515K` baseline
- **`claude`**: `~160K` baseline
- **`gpt-oss`**: `~100K` baseline
- **`other`**: fallback baseline

Each family applies outlier bounds (`minAutoCap..maxAutoCap`) so abnormal jumps (e.g., switching models mid-conversation or forked sessions) do not corrupt the learned estimate.

### Manual `/compact` vs. Real Auto-Compaction
A sudden drop in `input_tokens` can be caused by either manual `/compact` or automatic compaction. The HUD inspects `CHECKPOINT` markers together with a preceding `<USER_REQUEST>\s*/compact\b` pattern to classify drops deterministically as `kind: 'manual'` vs. `kind: 'auto'`:
- `manual` drops are recorded in `lastDrop` for display (`CHECKPOINT`) but **excluded** from auto-compaction cap calibration (`lastAutoDrop`).
- UI labels explicitly mark the threshold as an estimate (`~` / `est.`).

### Real KV Cache Hit %
Unlike the compaction threshold, KV cache hit percentage is not estimated. It is calculated directly from transcript usage metadata:

```text
cacheHitPct = cache_read_tokens / (input_tokens + cache_read_tokens)
```

### Standalone Browser Fallback (`open-room.mjs`)
If the sidecar pane is unavailable or you prefer opening the HUD in an external browser, run `node plugins/agy-suite-hud/hooks/open-room.mjs` (or pass `--print-auth-url` to print a single-use authenticated URL to stdout without spawning a browser).

---

## 4. Fail-Closed Adapter Contract

`AGY SUITE` isolates all Antigravity internal surfaces behind dedicated adapter functions so upstream schema changes fail safely instead of showing misleading telemetry or corrupting files:

| Internal Surface | Used By | Failure / Drift Behavior |
| :--- | :--- | :--- |
| `agy -p /usage` | `agy-suite-hud` | **Fail-closed**: schema parse error immediately clears cached quota and renders `—` (`ok: false, schemaError: true`). Transient CLI errors show a `stale` badge for at most `10 minutes` (`QUOTA_STALE_MAX_AGE_MS`), then expire to `—`. |
| `transcript_full.jsonl` | `agy-suite-hud` | Missing/malformed lines are skipped safely; meter falls back to unavailable state without crashing the sidecar. |
| `ConversationService` (`ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CSRF_TOKEN`) | `agy-suite-core` (`/cleanup`) | Fails cleanly with an explicit message if env vars are absent (e.g., standalone terminal) or RPC fails. Dry-run by default; never invokes `DeleteConversation`. |
| `Antigravity IDE/User/settings.json` (`antigravity.heartbeatIntervalMs`) | `agy-suite-core` (`/doctor`) | Lexical string-aware JSONC parser validates candidate output with `JSON.parse()` before writing `.agy-bak-*` backup and atomic rename. Refuses mutation if existing JSONC is malformed. Never fabricates `User/settings.json` inside standalone Antigravity 2.0 (`%APPDATA%\antigravity\`). |

---

## 5. Swarm Hook Storm Guard & Non-Interactive Git Safety (`agy-suite-sync`)

Because hook payloads do not distinguish subagents or parallel swarm workers from the main session, `agy-suite-sync` enforces two fast paths:
- **`SessionStart`**: Checks a `45s` cooldown and acquires a non-blocking `wx` `pull.lock` before `git fetch`. Concurrent swarm workers exit `{}` in `<5ms` without `.git/index.lock` contention.
- **`Stop`**: Computes CRLF-normalized `SHA-256` hashes of tracked files against `sync-state.json` and checks `payload.continuationActive`. On untouched turns (`95%+` of turns and read-only swarm workers), it returns `{"decision":"stop"}` immediately with **0 background spawns**. If dirty while another worker holds a live-PID `sync.lock`, it touches `sync.dirty` so the active worker coalesces up to 2 passes.

All Git subprocesses run non-interactively with bounded timeouts:
- `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_ASKPASS=""`, `SSH_ASKPASS=""`, `SSH_ASKPASS_REQUIRE=never`
- Default `GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=5"` (only if user has not set one)
- `-c credential.interactive=never -c commit.gpgsign=false -c tag.gpgsign=false -c core.autocrlf=false --no-verify`

**Git Remote Trust Boundary & Canonical Sync Config (`sync/config.json`)**:
- Canonical keys: `{ mode: "local" | "git", geminiDir, remoteUrl, branch: "main", workNotesEnabled: false, syncGeminiMd: false }`.
- Anyone with push access to the `MEMORY.md` sync repo is effectively trusted (since `MEMORY.md` is always loaded into session rules). Use a private, single-owner repository only.
- `GEMINI.md` is **never synced** unless explicitly opted in via `"syncGeminiMd": true`.
- External bots (`workNotesEnabled: true`) should only access a trusted private single-owner repository or a separate `WORK_NOTES`-only repository.
- On conflict, resolve explicitly via `node plugins/agy-suite-sync/bin/memory-sync.mjs --resolve=local|remote`.

**Pre-Push Secret-Leak Guard (Best-Effort Safety Net)**:
Before pushing, tracked files are scanned against high-confidence key patterns (`PRIVATE KEY`, `AIza...`, `ghp_`, `github_pat_`, `sk-...`, `sk-ant-...`, `AKIA...`, `xox[baprs]-`). Matches abort the push, set `lastStatus: "secret_blocked"` in `sync-state.json`, and surface a 1-line warning on the next `SessionStart`. This is a last-line mistake net, not a DLP replacement.

---

## 6. Full CLI Flags Reference (`install.mjs`)

```bash
node install.mjs [options]
```

| Flag | Description |
| :--- | :--- |
| `--doctor` | Run read-only environment diagnostics (delegates to `doctor.mjs --check`). |
| `--json` | Emit machine-readable JSON output (redacts credentials in `remoteUrl` and omits full settings `previewText`). |
| `--workspace <path>` | Explicitly target a `.code-workspace` file (with `--doctor` or `--apply-settings`), taking precedence over global IDE profiles. |
| `--dry-run` | Print planned operations without creating or modifying any files. |
| `--modules=<list>` | Comma-separated subset of `hud`, `core`, `sync`, or `all`. Default: `hud,core`. |
| `--apply-settings` | Validate and apply comment-preserving JSONC settings patch via `doctor.mjs` (aborts before plugin mutation if malformed; creates `.agy-bak-*` backups). |
| `--auto-open-hud` | Copy optional `auto-open-hud.md` rule into installed `agy-suite-hud/rules/`. |
| `--git-remote <url>` | Configure Multi-PC async Git sync remote URL in `sync/config.json` (requires `sync` module; skips starter creation so first sync pulls cleanly). |
| `--branch <name>` | Configure Git sync branch name (default `main`; requires `sync` module). |
| `--work-notes` | Enable `WORK_NOTES.md` inbox (`workNotesEnabled: true`; requires `sync` module). |
| `--uninstall` | Remove installed `agy-suite-*` plugin directories (respects `--modules=...`, default `all`; defaults `--target-root` from `install-manifest.json`). Never edits `config.json`. |
| `--restore-backups` | Used with full `--uninstall` to restore the earliest pre-suite `.agy-bak-*` backup recorded in `install-manifest.json` (backs up the current file first). |
| `--target-root <dir>` | Override plugin install root (default: `~/.gemini/config/plugins`). Useful for isolated testing. |
| `--data-dir <dir>` | Override persistent state directory (default: `~/.gemini/agy-suite`). |
| `--gemini-dir <dir>` | Override `~/.gemini` root for isolated testing. |

---

## 7. State & Directory Layout

```text
~/.gemini/config/plugins/           # Installed static plugins (safe to reinstall/replace)
├── agy-suite-hud/                  # Sidecar HUD + offline reasoning core (+ install-meta.json)
├── agy-suite-core/                 # doctor.mjs, archive-sessions.mjs, Anti-Stall rules, skills
└── agy-suite-sync/                 # memory-sync.mjs, MEMORY-LOADER.md, /work-notes skill (+ install-meta.json)

~/.gemini/agy-suite/                # Persistent user data (preserved across upgrades)
├── install-manifest.json           # Recorded targetRoot, installedModules & .agy-bak-* backup paths
├── hud/                            # HUD settings.json, optional secrets.json (0600), heartbeat
└── sync/                           # config.json, sync-state.json, locks, sync-repo/ mirror
```
