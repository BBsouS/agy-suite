---
name: doctor
description: >-
  Run read-only Antigravity environment diagnostics (heartbeat timeout config,
  watcher/search exclusions, Windows AdGuard WFP & PowerShell 7 alias traps,
  Linux inotify watches, non-login hook PATH, rule byte budgets, brain/ disk
  usage, and disabled plugin entries) and explain findings in plain language.
---

# AGY SUITE Doctor (`/doctor`)

Run the read-only environment diagnostic script and summarize the results clearly for the user.

## Steps

1. Locate `bin/doctor.mjs` inside this plugin directory (typically `~/.gemini/config/plugins/agy-suite-core/bin/doctor.mjs`, or inside the local `agy-suite` checkout if running from source).
2. Run a strictly read-only check with JSON output:

   ```bash
   node "<plugin-dir>/bin/doctor.mjs" --check --json
   ```

   If the user is working in a workspace that has a `.code-workspace` file, pass `--workspace "<path-to-.code-workspace>"`.
3. Present every finding grouped by severity (`CRITICAL`, `WARN`, `OK`, `INFO`, `SKIP`) in plain language:
   - Explain **why** each warning matters and **what** would change if fixed.
   - Note that `"antigravity.heartbeatIntervalMs": 0` is a community workaround for heartbeat timeout restarts and may evolve in future Antigravity releases.
   - Never modify system drivers, AdGuard configuration, or `~/.gemini/config/config.json`.
4. If fixable IDE or workspace JSONC settings issues were found, ask the user before making any edits:
   - Preview first with `node "<plugin-dir>/bin/doctor.mjs" --dry-run`.
   - Apply only after user confirmation with `node "<plugin-dir>/bin/doctor.mjs" --apply` (which preserves comments, validates JSONC before writing, and creates a `.agy-bak-<timestamp>` backup).
