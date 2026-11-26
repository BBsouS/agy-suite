# Anti-Stall & Timeout Discipline

- Always set `NotificationTimeoutSeconds` on every finite `run_command` (any command where `IsDaemon` is not `true`): use `60` for quick scripts, SSH/network checks, and headless browser runs, and `120`–`180` for builds, test suites, and deploys.
- When a timeout notification fires, inspect the background task immediately with `manage_task` (`status`). If output is stalled or blocked on an interactive prompt or file lock, `kill` it, fix the root cause (for example, add non-interactive flags or use an isolated temp `--user-data-dir`), and retry cleanly.
- Before ending a turn to wait on a subagent or swarm worker, arm a one-shot `schedule` watchdog (`DurationSeconds: 300`, `TimerCondition: "any"`) so normal replies cancel it at zero cost while silent stalls wake the session for inspection.
- Before retrying a failing command, classify the root cause (missing binary, PATH/alias shadowing, permission/sandbox restriction, or application error) and change approach instead of repeating the identical failing command.
