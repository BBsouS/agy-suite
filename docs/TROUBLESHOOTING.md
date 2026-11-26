# OS-Specific Troubleshooting (`docs/TROUBLESHOOTING.md`)

Practical fixes for platform-specific traps detected by `node install.mjs --doctor` and `/doctor`.

---

## 1. Windows: AdGuard WFP Network Driver (`adgnetworkwfpdrv.sys`)

### Symptom
Intermittent stream stalls, dropped local loopback connections (`127.0.0.1`), or sudden Antigravity language-server disconnects on Windows when AdGuard for Windows is installed.

### Why It Happens
AdGuard's WFP driver (`adgnetworkwfpdrv.sys`) intercepts TCP/HTTP traffic at the kernel level, which can interfere with Antigravity's local RPC / streaming connections. `/doctor` detects the driver read-only and never modifies AdGuard or Windows settings automatically.

### Manual Fix
1. Open **AdGuard for Windows** -> **Settings** -> **Network** -> **Filtered applications** (or **Traffic filtering**).
2. Add exclusions (disable filtering) for:
   - `Antigravity.exe` / `agy.exe`
   - `Code.exe` (if using Antigravity IDE)
   - `node.exe` (optional, if local sidecar/hook loopback connections stall)
3. Restart Antigravity and re-run `node install.mjs --doctor`.

---

## 2. Windows: PowerShell 7 `pwsh` WindowsApps Execution Alias Trap

### Symptom
Running `pwsh` in an agent shell fails with access-denied or Store-alias errors even though PowerShell 7 is installed.

### Why It Happens
On Windows, `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` can appear earlier in `PATH` than `C:\Program Files\PowerShell\7\pwsh.exe`.

### Fix
- Invoke PowerShell 7 explicitly via `"C:\Program Files\PowerShell\7\pwsh.exe"`, OR
- Move `C:\Program Files\PowerShell\7\` ahead of `%LOCALAPPDATA%\Microsoft\WindowsApps` in your User `PATH` environment variable, OR
- Disable the `pwsh.exe` alias in **Windows Settings** -> **Apps** -> **Advanced app settings** -> **App execution aliases**.

---

## 3. macOS: Non-Login Hook `PATH` (`launchd` / nvm / Homebrew)

### Symptom
`node install.mjs --doctor` reports `[WARN]` on the non-login hook `PATH` probe (`sh -c 'command -v node && command -v git'`), or hooks fail silently when triggered by Antigravity GUI.

### Why It Happens
GUI apps launched via macOS `launchd` do not load interactive shell profiles (`~/.zshrc`, `~/.bashrc`). Tools installed via `nvm`, `volta`, `fnm`, or Apple Silicon Homebrew (`/opt/homebrew/bin`) may be missing from the default non-login `PATH`.

### Fix
- Ensure `node` and `git` are symlinked or accessible in `/usr/local/bin` or `/opt/homebrew/bin`, OR
- Set your login environment `PATH` for GUI apps (e.g., via `launchctl config user path` or Homebrew's standard prefix) and restart Antigravity.

---

## 4. Linux: Low `fs.inotify.max_user_watches`

### Symptom
High CPU usage, `ENOSPC` file-watcher errors, or sluggish file updates in large workspaces.

### Fix
1. Check current limit:
   ```bash
   cat /proc/sys/fs/inotify/max_user_watches
   ```
2. Increase it persistently (if `< 65536`):
   ```bash
   echo "fs.inotify.max_user_watches=524288" | sudo tee -a /etc/sysctl.conf
   sudo sysctl -p
   ```
3. Also apply `agy-suite-core`'s watcher exclusions (`**/antigravity/**`, `**/node_modules/**`, `**/.venv/**`) via `node install.mjs --modules=core --apply-settings`.

---

## 5. Antigravity IDE vs. Antigravity 2.0 Settings Path Differences

### Why `/doctor` Might Show `[SKIP]` for IDE Settings
- **Antigravity IDE** (VS Code fork) stores editor settings at:
  - Windows: `%APPDATA%\Antigravity IDE\User\settings.json`
  - macOS: `~/Library/Application Support/Antigravity IDE/User/settings.json`
  - Linux: `${XDG_CONFIG_HOME:-~/.config}/Antigravity IDE/User/settings.json`
- **Standalone Antigravity 2.0** (`%APPDATA%\antigravity\` on Windows) is an Electron app that does **not** use `User\settings.json`.

To avoid creating useless phantom files, `doctor.mjs` probes `Antigravity IDE/User/settings.json` first and only falls back to legacy `Antigravity/User/settings.json` if `User/settings.json` or `User/globalStorage` already exists. If you use a workspace file instead, pass `--workspace <path/to/your.code-workspace>`.

---

## 6. Reinstalled Plugin Still Appears Disabled

`install.mjs` intentionally never edits `~/.gemini/config/config.json`. If you previously disabled a plugin in Antigravity Customizations, that `"enabled": false` entry remains in `config.json` across reinstalls. Re-enable it directly in Antigravity Customizations:
- `[AGY SUITE — HUD](customization://agy-suite-hud)`
- `[AGY SUITE — Core](customization://agy-suite-core)`
- `[AGY SUITE — Memory & Bridge](customization://agy-suite-sync)`
