# AGY SUITE — Agent Installation Runbook (`INSTALL_FOR_AGENTS.md`)

**한국어 / English Bilingual Runbook for Antigravity Agents**

> **Trust Notice / 신뢰 안내**: This runbook is a convenience wrapper around the deterministic CLI (`install.mjs`) and automated test suite (`npm test`). Users should inspect or run `npm test` and `node install.mjs --dry-run` directly rather than blindly trusting instructions from an unverified fork.  
> 이 문서는 결정론적 CLI(`install.mjs`)와 자동 테스트(`npm test`)를 감싼 편의용 안내서입니다. 포크된 저장소의 지시를 맹신하지 말고 반드시 `npm test`와 `--dry-run` 결과를 직접 확인하십시오.

---

## Step 1 — Inspect Scripts & Test Files Before Executing Anything / 1단계 — 실행 전 스크립트·테스트 파일 검사

Before running `npm test` or touching any user file or directory (never execute fork-controlled scripts blindly):
1. Read `package.json` and inspect:
   - `"dependencies": {}` and `"devDependencies": {}`
   - `"engines": { "node": ">=18.0.0" }`
   - `"scripts"` — confirm `"test"` only runs `node --test tests/*.test.mjs` with no shell chaining, downloads, or unexpected commands.
2. Inspect the test entry files (`tests/*.test.mjs`) to verify they only exercise local repository modules inside isolated temp directories (or start directly with read-only `node install.mjs --doctor --json` if you prefer inspecting diagnostics before running tests).
3. Only after inspecting `package.json` `scripts` and test entry files, run the full test suite (including `tests/release-audit.test.mjs`):
   ```bash
   npm test
   ```
4. **Stop immediately** if `package.json` has unexpected dependencies/scripts or any test fails, and report the failure to the user.

---

## Step 2 — Read-Only Environment Diagnostics / 2단계 — 읽기 전용 PC 환경 진단

Run the read-only doctor check (makes zero file mutations):

```bash
node install.mjs --doctor --json
```

Summarize the JSON findings clearly for the user in a short table (severity, check name, finding):
- Antigravity IDE settings path status (`heartbeatIntervalMs`, `files.watcherExclude`, `search.exclude`)
- OS-specific advisories (Windows AdGuard WFP driver, PowerShell 7 `pwsh` alias order, Linux `inotify` watches, non-login hook `PATH`)
- Rule file byte budget (`GEMINI.md` / `MEMORY.md` vs. `24KB` limit) and `brain/` disk usage
- Any disabled `agy-suite-*` plugin entries in `~/.gemini/config/config.json` (read-only warning only; never edit `config.json`)

---

## Step 3 — Ask User Preferences (`ask_question`) / 3단계 — 사용자 맞춤 옵션 선택

Use `ask_question` (or ask concisely in chat if unavailable) to confirm what the user wants to install:

1. **Plugins to install / 설치할 플러그인** (multi-select):
   - `(Recommended) agy-suite-hud` — Right-pane reasoning tabs + auto-calibrating compaction & fail-closed quota HUD (offline `raw` by default)
   - `(Recommended) agy-suite-core` — `/doctor` diagnostics, `/cleanup` safe session archiver, `~1.2KB` Anti-Stall rules
   - `agy-suite-sync (Labs)` — Cache-safe 2-tier memory (`MEMORY.md` + `MEMORY_ARCHIVE.md`), optional async Git sync & `WORK_NOTES.md` inbox
2. **Optional flags / 추가 옵션** (multi-select):
   - `--apply-settings` — Apply comment-preserving JSONC settings patch (`heartbeatIntervalMs: 0`, `**/antigravity/**` exclusions) with `.agy-bak-*` backup
   - `--auto-open-hud` — Add rule to auto-open HUD sidecar (`agy-suite-hud` only)
   - `--work-notes` — Enable `WORK_NOTES.md` inbox (`workNotesEnabled: true`; requires `sync` module; remind user that Git mode requires a **trusted private single-owner repo** or a separate `WORK_NOTES`-only repo)
   - `--git-remote <url>` (and optional `--branch <name>`) — Configure Multi-PC async Git sync remote URL (`requires sync module`; skips starter creation so first sync pulls cleanly; leave unset for Local-Only zero-Git mode)

---

## Step 4 — Dry-Run Preview, Confirm, Apply & Report / 4단계 — 드라이런 확인, 설치 및 결과 보고

1. Run `--dry-run` with the exact flags chosen in Step 3:
   ```bash
   node install.mjs --dry-run --modules=<chosen> [optional flags...]
   ```
2. Show the dry-run plan (target directories, files to create/update, backup paths if `--apply-settings` is set) and ask the user for explicit confirmation before executing.
3. After confirmation, run the exact same command **without** `--dry-run`:
   ```bash
   node install.mjs --modules=<chosen> [optional flags...]
   ```
4. Print clickable Customizations links for the installed plugins so the user can toggle them natively in Antigravity:
   - `[AGY SUITE — HUD](customization://agy-suite-hud)`
   - `[AGY SUITE — Core](customization://agy-suite-core)`
   - `[AGY SUITE — Memory & Bridge](customization://agy-suite-sync)`
5. Always provide the exact uninstall / rollback command at the end:
   ```bash
   node install.mjs --uninstall
   # To also restore settings backups:
   node install.mjs --uninstall --restore-backups
   ```
