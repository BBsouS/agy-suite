---
name: cleanup
description: >-
  Safely bulk-archive old idle Antigravity conversations via local
  ConversationService (sets archived: true, never deletes transcripts). Always
  previews with a dry-run first and asks user confirmation before applying.
---

# AGY SUITE Session Cleanup (`/cleanup`)

Archive old idle conversations to declutter the sidebar without ever deleting conversation transcripts.

## Safety Guarantees

- **Dry-run by default**: No conversation is modified unless `--apply` is explicitly passed.
- **Never deletes**: Uses only `UpdateConversation` with `annotations.archived = true`. `DeleteConversation` is never called.
- **Protected conversations**: Always skips the current conversation (`$ANTIGRAVITY_CONVERSATION_ID`), pinned conversations, starred conversations, and any conversation whose `runState` is not `RUN_STATE_IDLE`.

## Steps

1. Locate `bin/archive-sessions.mjs` inside this plugin directory (typically `~/.gemini/config/plugins/agy-suite-core/bin/archive-sessions.mjs`).
2. Run a dry-run preview first (default 7 days, cap 50 per run; adjust `--days` / `--max` if the user specified different values):

   ```bash
   node "<plugin-dir>/bin/archive-sessions.mjs" --days 7 --max 50
   ```

3. **Loopback sandbox note**: `ConversationService` runs on local loopback (`$ANTIGRAVITY_LS_ADDRESS`). If the terminal sandbox blocks local HTTP (connection refused, HTTP 403, or `"Port ... not allowed for HTTP"`), rerun **only** that command outside the sandbox so the user can approve local loopback access.
4. Show the user the exact count, protected count, and list of conversations that would be archived.
5. Wait for explicit user confirmation. Only after the user confirms, run:

   ```bash
   node "<plugin-dir>/bin/archive-sessions.mjs" --days 7 --max 50 --apply
   ```

6. Report how many conversations were archived (and any individual errors, if any).
