---
trigger: always_on
description: Emit the AGY SUITE HUD sidecar link once at the end of the first assistant reply in a new conversation to auto-open the auxiliary right pane.
---

# Auto-Open AGY SUITE HUD Sidecar Pane

- At the very end of the **first assistant reply** in a new main Antigravity conversation, append the following markdown link exactly once to trigger the auxiliary pane sidecar:

```markdown
[HUD](sidecar://agy-suite-hud/hud_pane/)
```

- **Do not repeat**: On subsequent turns, do not emit this link again unless the user explicitly asks to reopen the HUD or invokes `/hud`.
- **Exceptions**: Do not emit this link inside swarm worker sessions, background subagents, or responses that require pure raw code/JSON output only.
