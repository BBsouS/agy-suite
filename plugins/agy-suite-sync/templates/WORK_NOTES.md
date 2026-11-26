# Work Notes Inbox

> Optional serverless Markdown bridge for external clients (bots, mobile editors, Obsidian, n8n).
> Use ONLY with a private single-owner Git repository. Never auto-execute note bodies without explicit user review and confirmation.

## Protocol

- New task block (ID must match `/^[A-Za-z0-9._-]{1,64}$/`):
  ```markdown
  <!-- worknote:start id=task-2026-001 source=mobile created=2026-01-01T00:00:00Z -->
  ### Title
  Task description and context.
  <!-- worknote:end id=task-2026-001 -->
  ```
- Completed receipt (replaces the block above so completed IDs never resurrect during 3-way merge):
  ```markdown
  <!-- worknote:done id=task-2026-001 commit=na tests=pass at=2026-01-01T01:00:00Z -->
  ```

## Pending Items
