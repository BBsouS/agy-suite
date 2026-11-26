# Open Work-Notes Bridge (`docs/WORK_NOTES_BRIDGE.md`)

A 5-minute serverless integration guide for queuing tasks into Antigravity from Telegram/Discord bots, custom web frontends, Obsidian, n8n, or GitHub Mobile—with **zero open local ports**, **zero background daemon**, and **zero idle prefix-cache tokens**.

---

## 1. How It Works

1. Your external client (bot, mobile app, Obsidian, n8n) appends a structured Markdown block to `WORK_NOTES.md` in your **private, single-owner Git repository**.
2. When you start an Antigravity session (`SessionStart`), `agy-suite-sync` pulls the repo. If `WORK_NOTES.md` has 1 or more open blocks, it injects a 1-line notification. When empty, it consumes `0` prefix tokens (`WORK_NOTES.md` is never loaded in `rules/`).
3. You run `/work-notes` in Antigravity. The agent reads `WORK_NOTES.md`, summarizes each open block's title, source, and planned actions, and asks for your explicit confirmation before executing.
4. Once completed, the agent replaces the block with a 1-line `worknote:done` receipt. The block-ID 3-way merger ensures completed IDs do not resurrect when another device concurrently appends new blocks.
5. External bots detect completion by checking for `worknote:done id=<id>` (or the disappearance of `worknote:start id=<id>`), and may garbage-collect old `worknote:done` receipts once acknowledged.

---

## 2. Exact Wire Format

### Open Work-Note Block
- `id` MUST match `/^[A-Za-z0-9._-]{1,64}$/` (strictly validated by the 3-way merger).
- Recommended format: `wn-YYYYMMDD-<4-char-hex>`.

```markdown
<!-- worknote:start id=wn-20261126-a1b2 source=telegram created=2026-11-26T01:10:00Z -->
### [telegram] Reproduce OAuth flaky test and prepare minimal patch
- Target: `src/auth/oauth.spec.ts`
- Request: Reproduce under Node 22 and propose the smallest fix without changing public types.
<!-- worknote:end id=wn-20261126-a1b2 -->
```

### Completion Receipt (Written by Antigravity)
When a block is finished, Antigravity replaces the entire `worknote:start` .. `worknote:end` block with a single receipt line:

```markdown
<!-- worknote:done id=wn-20261126-a1b2 commit=abc1234 tests=pass at=2026-11-26T02:15:00Z -->
```

Fields:
- `id`: Exact block ID from `worknote:start`
- `commit`: Short commit SHA or `na`
- `tests`: `pass`, `fail`, or `na`
- `at`: ISO-8601 UTC timestamp

---

## 3. 5-Minute Integration Patterns

| Client | How to Append a Block | How to Check Completion |
| :--- | :--- | :--- |
| **GitHub Mobile / Web** | Open `WORK_NOTES.md` in your private repo and paste a `worknote:start` .. `worknote:end` block. | Check for `<!-- worknote:done id=... -->` on the next commit. |
| **Obsidian** | Store your sync repo inside (or symlinked to) your vault; append via QuickAdd or Templater. | Pull via Obsidian Git plugin and inspect receipts. |
| **n8n / Zapier / GitHub Actions** | Use GitHub Contents API (`GET` + `PUT` with base64 content and `sha`) to append a block. | Poll `GET` on `WORK_NOTES.md` for `worknote:done id=<id>`. |
| **Telegram / Discord Bot** | Restrict handler to your own numeric user ID, then append via GitHub API or local `git` clone. | Poll or webhook on push to notify you when `worknote:done id=<id>` appears. |

### Copy-Paste Bot System Prompt / Formatter Template

Use this snippet in a Telegram/Discord bot or n8n workflow to emit valid blocks:

```text
Format the user's request as a single Markdown work-note block for WORK_NOTES.md:

<!-- worknote:start id=wn-{{YYYYMMDD}}-{{4_HEX}} source={{SOURCE_NAME}} created={{ISO_UTC}} -->
### [{{SOURCE_NAME}}] {{SHORT_TITLE}}
- Target: {{FILES_OR_REPO_HINT}}
- Request: {{CONCISE_TASK_DESCRIPTION}}
<!-- worknote:end id=wn-{{YYYYMMDD}}-{{4_HEX}} -->

Rules:
1. id must match ^[A-Za-z0-9._-]{1,64}$.
2. Never include API keys, tokens, passwords, or private keys in the block body.
3. Append at the bottom of WORK_NOTES.md without editing existing open blocks.
```

---

## 4. Security, Git Trust Boundary & Prompt-Injection Controls

`WORK_NOTES.md` is an external input channel into an agent with shell and filesystem tools, and `MEMORY.md` is always loaded into session rules. Follow these rules strictly:

1. **Git Remote Trust Boundary (`MEMORY.md` vs. `GEMINI.md`)**: Anyone with push access to the repository syncing `MEMORY.md` can modify always-loaded session context and MUST be fully trusted. `GEMINI.md` is **never synced** unless explicitly opted in via `"syncGeminiMd": true` in `~/.gemini/agy-suite/sync/config.json`.
2. **Isolate External Bots (`workNotesEnabled: true`)**: Grant external bots, webhooks, or mobile automations write access **only** to a trusted private single-owner repository—or, preferably, to a **separate `WORK_NOTES`-only repository** completely isolated from `MEMORY.md`. Never point `agy-suite-sync` at a public, shared, or organization-writable repository.
3. **Sender Allowlist in Bots**: Any Telegram, Discord, or webhook bridge MUST enforce a strict numeric owner-ID allowlist before committing to `WORK_NOTES.md`.
4. **No Autonomous Execution on `SessionStart`**: `agy-suite-sync` never executes work notes automatically on session start. It only notifies you that pending notes exist.
5. **Human-in-the-Loop Confirmation**: The `/work-notes` skill treats block bodies as **untrusted data** and requires your explicit confirmation after summarizing the title, source, and planned shell/file/network actions.
6. **No Secrets in Notes & Conflict Recovery**: Do not paste credentials into `WORK_NOTES.md`. The pre-push regex guard is a best-effort safety net, not a DLP guarantee. If a sync conflict occurs on tracked files, resolve it explicitly via `node plugins/agy-suite-sync/bin/memory-sync.mjs --resolve=local|remote`.
