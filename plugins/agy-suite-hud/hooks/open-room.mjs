import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DISPLAY_NAME,
  getDataPaths,
  resolveControlRoomPort,
  resolveDataDir,
  sanitizeChildEnv,
} from './constants.mjs';
import {
  readDaemonState,
  sleep,
  verifyControlRoomHealth,
  withLock,
} from './core.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const SERVER_SCRIPT = path.join(SCRIPT_DIR, 'server.mjs');

function getWindowsBrowserCandidates() {
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(
      path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    );
  }
  return [...new Set(candidates)];
}

const MACOS_BROWSER_CANDIDATES = [
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const LINUX_BROWSER_BINARIES = [
  'google-chrome',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
];

function findExecutableInPath(binName) {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, binName);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      if (fs.statSync(full).isFile()) {
        return full;
      }
    } catch {
      // Not executable here.
    }
  }
  return null;
}

function spawnDetachedSafe(
  command,
  args,
  { windowsHide = true, env = undefined, reportError = false } = {},
) {
  try {
    const spawnOpts = {
      detached: true,
      stdio: 'ignore',
      windowsHide,
      env: env || sanitizeChildEnv(process.env),
    };
    const child = spawn(command, args, spawnOpts);
    child.on('error', (err) => {
      if (reportError) {
        process.stderr.write(`Failed to launch ${command}: ${String(err?.message || err)}\n`);
      }
    });
    child.unref();
    return true;
  } catch (err) {
    if (reportError) {
      process.stderr.write(`Failed to launch ${command}: ${String(err?.message || err)}\n`);
    }
    return false;
  }
}

async function readVerifiedDaemon(dataDir, expectedPort) {
  const info = readDaemonState(dataDir);
  if (!info || !info.bootstrapToken) return null;
  const targetPort = info.port || expectedPort;
  const health = await verifyControlRoomHealth(targetPort, 500);
  if (!health || health.bootId !== info.bootId) {
    return null;
  }
  return {
    port: health.port,
    bootId: health.bootId,
    bootstrapToken: info.bootstrapToken,
    bridgeToken: info.bridgeToken || '',
  };
}

export async function ensureDaemonRunning({
  dataDir = resolveDataDir(),
  port = resolveControlRoomPort(process.env.AGY_SUITE_HUD_PORT, { allowZero: true }),
} = {}) {
  const existing = await readVerifiedDaemon(dataDir, port);
  if (existing) return existing;

  const resolvedDataDir = path.resolve(dataDir);
  const { daemonStartLockPath } = getDataPaths(resolvedDataDir);
  await withLock(
    daemonStartLockPath,
    async () => {
      const recheck = await readVerifiedDaemon(resolvedDataDir, port);
      if (recheck) return;
      spawnDetachedSafe(process.execPath, [SERVER_SCRIPT, '--daemon'], {
        windowsHide: true,
        reportError: true,
        env: {
          ...sanitizeChildEnv(process.env),
          AGY_SUITE_HUD_DATA_DIR: resolvedDataDir,
          AGY_SUITE_HUD_PORT: String(port),
        },
      });
    },
    { maxWaitMs: 1500, staleMs: 5000, retryMs: 80 },
  );

  for (let i = 0; i < 35; i += 1) {
    await sleep(120);
    const verified = await readVerifiedDaemon(resolvedDataDir, port);
    if (verified) return verified;
  }
  return null;
}

export function openFramelessWindow(authUrl, { daemonOnly = false } = {}) {
  if (daemonOnly) return false;

  const appArgs = [`--app=${authUrl}`, '--window-size=1180,860'];

  if (process.platform === 'win32') {
    for (const exe of getWindowsBrowserCandidates()) {
      if (fs.existsSync(exe)) {
        if (spawnDetachedSafe(exe, appArgs, { windowsHide: false, reportError: true })) {
          return true;
        }
      }
    }
    return spawnDetachedSafe('cmd.exe', ['/c', 'start', '', authUrl], {
      windowsHide: true,
      reportError: true,
    });
  }

  if (process.platform === 'darwin') {
    for (const exe of MACOS_BROWSER_CANDIDATES) {
      if (fs.existsSync(exe)) {
        if (spawnDetachedSafe(exe, appArgs, { windowsHide: false, reportError: true })) {
          return true;
        }
      }
    }
    return spawnDetachedSafe('open', [authUrl], { windowsHide: false, reportError: true });
  }

  for (const bin of LINUX_BROWSER_BINARIES) {
    const resolved = findExecutableInPath(bin);
    if (resolved && spawnDetachedSafe(resolved, appArgs, { windowsHide: false, reportError: true })) {
      return true;
    }
  }
  return spawnDetachedSafe('xdg-open', [authUrl], { windowsHide: true, reportError: true });
}

export async function launchControlRoom({
  dataDir = resolveDataDir(),
  port = resolveControlRoomPort(process.env.AGY_SUITE_HUD_PORT, { allowZero: true }),
  daemonOnly = process.argv.includes('--daemon-only'),
  printAuthUrl = process.argv.includes('--print-auth-url'),
} = {}) {
  const daemon = await ensureDaemonRunning({ dataDir, port });
  if (!daemon) {
    process.stderr.write(`Failed to start ${DISPLAY_NAME} daemon.\n`);
    process.exitCode = 1;
    return null;
  }

  const baseUrl = `http://127.0.0.1:${daemon.port}`;
  const authUrl = `${baseUrl}/auth?token=${encodeURIComponent(daemon.bootstrapToken)}`;
  if (printAuthUrl) {
    process.stdout.write(`${authUrl}\n`);
    return { baseUrl, authUrl, port: daemon.port };
  }
  if (!daemonOnly) {
    const opened = openFramelessWindow(authUrl, { daemonOnly: false });
    if (!opened) {
      process.stderr.write(
        `Failed to launch browser window for ${DISPLAY_NAME}. Run with --print-auth-url to obtain a single-use login URL.\n`,
      );
    }
  }
  process.stdout.write(`${DISPLAY_NAME} is running at ${baseUrl}\n`);
  return { baseUrl, port: daemon.port };
}

function resolveRealPathLower(targetPath) {
  if (!targetPath) return '';
  try {
    return fs.realpathSync(targetPath).toLowerCase();
  } catch {
    return path.resolve(targetPath).toLowerCase();
  }
}

const invokedPath = resolveRealPathLower(process.argv[1]);
const selfPath = resolveRealPathLower(SCRIPT_PATH);
if (invokedPath && invokedPath === selfPath) {
  launchControlRoom().catch((err) => {
    process.stderr.write(`Error launching ${DISPLAY_NAME}: ${String(err?.message || err)}\n`);
    process.exitCode = 1;
  });
}
