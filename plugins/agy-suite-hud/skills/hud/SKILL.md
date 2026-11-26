---
name: hud
description: Open the AGY SUITE HUD sidecar auxiliary pane for live reasoning summaries, swarm worker tabs, auto-calibrating compaction meter, and fail-closed quota telemetry. Use when the user invokes /hud or asks to open the HUD pane.
---

# Open AGY SUITE HUD (`/hud`)

When the user invokes `/hud` or asks to open the HUD panel, respond directly with the native sidecar link below so Antigravity opens the auxiliary right pane immediately without unnecessary tool calls:

```markdown
[HUD](sidecar://agy-suite-hud/hud_pane/)
```

## Standalone Browser Window Fallback

Only if the user explicitly asks to launch the standalone browser control room window (for multi-session grid view or headless/external browser access), resolve the launcher script relative to **this `SKILL.md` file's own absolute path** (`<skill-dir>/../../hooks/open-room.mjs`) and run:

```bash
node "<skill-dir>/../../hooks/open-room.mjs"
```

On Windows PowerShell:

```powershell
node "<skill-dir>\..\..\hooks\open-room.mjs"
```

Report the local URL printed to stdout back to the user.

## Notes
- Operates strictly offline in `raw` mode by default (`0 bytes` external egress).
- Optional Gemini API first-person restoration or Google Translate can be configured inside the HUD settings drawer or standalone control room.
