import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDataPaths, resolveBrainDirs, resolveDataDir, sanitizeChildEnv } from './constants.mjs';
import {
  STDIN_READ_TIMEOUT_MS,
  exportLatestThoughts,
  isDaemonQuickAlive,
  isSidecarViewerActive,
  loadSecrets,
  loadSettings,
  pokeControlRoom,
  readDaemonState,
  readStdinText,
  verifyControlRoomHealth,
} from './core.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CORE_SCRIPT_PATH = path.join(path.dirname(SCRIPT_PATH), 'core.mjs');

export function writeHookStdout(eventName, stdout = process.stdout) {
  if (eventName === 'Stop') {
    stdout.write('{"decision":"stop"}\n');
  } else {
    stdout.write('{}\n');
  }
}

export async function handleHookPayload(
  payload = {},
  {
    dataDir = resolveDataDir(),
    brainDirs = resolveBrainDirs(),
    spawnImpl = spawn,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  const eventName = String(payload.hookEventName || payload.hook_event_name || '');
  const transcriptPath = String(payload.transcriptPath || payload.transcript_path || '').trim();
  const conversationId = String(payload.conversationId || payload.conversation_id || '').trim();

  if (!transcriptPath && !conversationId) {
    return { eventName, spawnedWorker: false, poked: false, reason: 'missing_identifiers' };
  }

  const settings = loadSettings(dataDir);
  let syncResult = null;
  try {
    syncResult = await exportLatestThoughts({
      transcriptPath,
      conversationId,
      dataDir,
      brainDirs,
      allowNetwork: false,
      hookMode: true,
      allowMtimeFallback: false,
      fetchImpl,
    });
  } catch {
    // Never fail or block the agent loop on export errors.
  }

  const daemonAlive = isDaemonQuickAlive(dataDir);
  const paths = getDataPaths(dataDir);
  const sidecarActive = isSidecarViewerActive(paths.sidecarViewerHeartbeatPath);
  let poked = false;
  let spawnedWorker = false;

  const isConfirmedNonUserSession =
    syncResult?.reason === 'subagent_no_user_turn' ||
    syncResult?.reason === 'transcript_not_found';

  if (isConfirmedNonUserSession) {
    return { eventName, spawnedWorker: false, poked: false, syncResult };
  }

  const shouldPoke = Boolean(
    daemonAlive && (syncResult?.updated || syncResult?.reason === 'worker_turn_pending'),
  );

  // In raw mode (default) or when neither standalone daemon nor sidecar viewer is active, NEVER spawn a background worker.
  if (settings.mode === 'raw' || (!daemonAlive && !sidecarActive)) {
    if (shouldPoke) {
      poked = await pokeControlRoom(dataDir, 150, fetchImpl);
    }
    return { eventName, spawnedWorker: false, poked, syncResult };
  }

  // Viewer-active gate: skip spawning a background worker when no viewer tab or active sidecar pane is open.
  let hasOpenClient = sidecarActive;
  if (!hasOpenClient && daemonAlive) {
    const daemonInfo = readDaemonState(dataDir);
    const health =
      daemonInfo && Number.isInteger(daemonInfo.port) && daemonInfo.port >= 1
        ? await verifyControlRoomHealth(daemonInfo.port, 150, fetchImpl)
        : null;
    hasOpenClient = Boolean(health && Number(health.clients) > 0);
  }
  if (!hasOpenClient) {
    return { eventName, spawnedWorker: false, poked: false, syncResult };
  }

  const needsMoreRestore =
    !syncResult ||
    typeof syncResult.needsRestoreCount !== 'number' ||
    syncResult.needsRestoreCount > 0 ||
    syncResult.reason === 'beyond_hook_tail_window';

  const hasRequiredCreds =
    settings.mode === 'translate' ||
    (settings.mode === 'gemini' && Boolean(loadSecrets(dataDir).geminiApiKey));

  if (!needsMoreRestore || !hasRequiredCreds) {
    if (shouldPoke) {
      poked = await pokeControlRoom(dataDir, 150, fetchImpl);
    }
    return { eventName, spawnedWorker: false, poked, syncResult };
  }

  try {
    const workerArgs = [CORE_SCRIPT_PATH, '--worker', '--data-dir', dataDir];
    if (transcriptPath) workerArgs.push('--transcript', transcriptPath);
    if (conversationId) workerArgs.push('--conv', conversationId);

    const child = spawnImpl(process.execPath, workerArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: sanitizeChildEnv(process.env),
    });
    child?.on?.('error', () => {});
    child?.unref?.();
    spawnedWorker = true;
  } catch {
    // Ignore background spawn errors.
  }

  if (shouldPoke) {
    poked = await pokeControlRoom(dataDir, 150, fetchImpl);
  }

  return { eventName, spawnedWorker, poked, syncResult };
}

async function main() {
  const cliEventName = String(process.argv[2] || '').trim();
  let eventName = cliEventName;
  try {
    let payload = {};
    try {
      const raw = await readStdinText(STDIN_READ_TIMEOUT_MS);
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payload = parsed;
        }
      }
    } catch {
      payload = {};
    }

    eventName = cliEventName || String(payload.hookEventName || payload.hook_event_name || '');
    if (cliEventName && !payload.hookEventName && !payload.hook_event_name) {
      payload.hookEventName = cliEventName;
    }
    try {
      await handleHookPayload(payload);
    } catch {
      // Never block agent hook lifecycle.
    }
  } catch {
    // Outer guard: preserve guaranteed hook stdout contract.
  } finally {
    writeHookStdout(eventName);
  }
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
  main().catch(() => {
    writeHookStdout(String(process.argv[2] || '').trim());
  });
}
