---
name: setup
description: >-
  Review installed AGY SUITE plugins, open Antigravity Customizations toggles
  for each independent module (HUD, Core, Memory & Bridge), or reconfigure /
  uninstall via install.mjs.
---

# AGY SUITE Setup (`/setup`)

AGY SUITE ships as **3 independently toggleable static plugins** so users can enable or disable each capability natively in Antigravity Customizations without fragile config rewrites.

## Manage Installed Modules

Share these clickable Customizations links with the user so they can toggle any module directly:

- [AGY SUITE — HUD](customization://agy-suite-hud) — Right-pane reasoning, auto-calibrating compaction meter, and fail-closed quota HUD.
- [AGY SUITE — Core](customization://agy-suite-core) — `/doctor` diagnostics, comment-preserving JSONC patcher, `/cleanup` session archiver, and compact Anti-Stall rules.
- [AGY SUITE — Memory & Bridge](customization://agy-suite-sync) — Opt-in 2-tier `MEMORY.md` loader, local or multi-PC async Git sync, and serverless `WORK_NOTES.md` bridge.

## Reconfigure or Uninstall via CLI

If the user wants to add modules, apply settings patches, enable optional templates, or uninstall cleanly, guide them (or run after confirmation) using the deterministic installer from their `agy-suite` checkout:

```bash
# Preview changes (writes 0 files)
node install.mjs --dry-run --modules=hud,core,sync

# Install selected modules (default: hud,core; use all for hud,core,sync)
node install.mjs --modules=hud,core
node install.mjs --modules=all --auto-open-hud --work-notes

# Apply comment-preserving IDE stability patches (creates .agy-bak-* backups)
node install.mjs --apply-settings

# Configure multi-PC Git sync (private single-owner repo recommended)
node install.mjs --modules=sync --git-remote "<private-repo-url>"

# Uninstall plugins and optionally restore settings backups
node install.mjs --uninstall --modules=all --restore-backups
```

Note: `install.mjs` never modifies `~/.gemini/config/config.json`. If a plugin was previously disabled in Antigravity Customizations, re-enable it from the links above or with `agy plugin enable <plugin-name>`.
