import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTROL_ROOM_APP_ID,
  CONV_ID_REGEX,
  COOKIE_NAME,
  DEFAULT_MODELS,
  DISPLAY_NAME,
  FILE_PREFIX,
  PROMPT_PRESETS,
  STORAGE_PREFIX,
  getDataPaths,
  resolveBrainDirs,
  resolveControlRoomPort,
  resolveDataDir,
} from './constants.mjs';
import {
  ACTIVE_SESSION_WINDOW_MS,
  SHORT_STALE_LOCK_MS,
  WORKER_STALE_LOCK_MS,
  atomicWriteSync,
  cleanUserInput,
  consumeWorkerDirty,
  detectSwarmWorkerMeta,
  extractAllTurns,
  extractFirstSessionTopic,
  extractWorkerTurns,
  formatTimeOnly,
  formatTimestamp,
  formatWorkerDisplayLabel,
  getWorkerDirtyPath,
  getWorkerLockPath,
  isValidModelName,
  loadSecrets,
  loadSessionsState,
  loadSettings,
  maskApiKey,
  parseJsonLines,
  purgeStaleTempFiles,
  restoreTurnSteps,
  saveSecrets,
  saveSessionsState,
  saveSettings,
  summarizeOneLine,
  validateSettingsPatch,
  verifyControlRoomHealth,
  withLock,
} from './core.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const UI_HTML_PATH = path.join(SCRIPT_DIR, 'ui.html');
const HOST = '127.0.0.1';

const MAX_SCAN_CONVERSATIONS = 40;
const MAX_TRANSCRIPT_MEMO = 64;
const MAX_PINNED_SESSIONS = 8;
const MAX_SWARM_WORKERS_PER_SESSION = 8;
const MAX_TRANSCRIPT_READ_BYTES = 8 * 1024 * 1024;
const FULL_BRAIN_SCAN_INTERVAL_MS = 4 * 1000;
const RECENT_SWARM_FINISH_GRACE_MS = 3 * 60 * 1000;
const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;
const TEST_KEY_COOLDOWN_MS = 3000;
const AUTO_RESTORE_COOLDOWN_MS = 30 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 64;

const CSP_POLICY =
  "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const CONTROL_CHAR_REGEX = /[\r\n\x00-\x1f]/;

function isValidApiKeyFormat(rawKey) {
  return typeof rawKey === 'string' && rawKey.length <= 512 && !CONTROL_CHAR_REGEX.test(rawKey);
}

function escapeHtmlBasic(raw) {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BASE_SECURITY_HEADERS = Object.freeze({
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

class HttpRequestError extends Error {
  constructor(statusCode, publicMessage) {
    super(publicMessage);
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function parseCookies(cookieHeader) {
  const out = Object.create(null);
  if (typeof cookieHeader !== 'string' || !cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function sanitizePinnedList(rawPinned) {
  if (!Array.isArray(rawPinned)) return [];
  const unique = [];
  const seen = new Set();
  for (const item of rawPinned) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (!id || !CONV_ID_REGEX.test(id) || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
    if (unique.length >= MAX_PINNED_SESSIONS) break;
  }
  return unique;
}

function readBoundedLines(filePath, maxBytes = MAX_TRANSCRIPT_READ_BYTES) {
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return [];
  if (stat.size <= maxBytes) {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const startOffset = stat.size - maxBytes;
    const buf = Buffer.allocUnsafe(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, startOffset);
    const text = buf.subarray(0, read).toString('utf8');
    const nl = text.indexOf('\n');
    return (nl >= 0 ? text.slice(nl + 1) : text).split(/\r?\n/);
  } finally {
    fs.closeSync(fd);
  }
}

function preferFullTranscriptPath(candidatePath) {
  if (!candidatePath || typeof candidatePath !== 'string') return null;
  const fullSibling = path.join(path.dirname(candidatePath), 'transcript_full.jsonl');
  if (fs.existsSync(fullSibling)) return fullSibling;
  if (fs.existsSync(candidatePath)) return candidatePath;
  return null;
}

function isStillDismissed(dismissEntry, totalTurns, latestTurn) {
  if (!dismissEntry || typeof dismissEntry !== 'object') return false;
  if (typeof dismissEntry.totalTurns === 'number' && totalTurns > dismissEntry.totalTurns) {
    return false;
  }
  if (
    typeof dismissEntry.totalTurns === 'number' &&
    totalTurns === dismissEntry.totalTurns &&
    typeof dismissEntry.stepCount === 'number' &&
    latestTurn.stepCount > dismissEntry.stepCount
  ) {
    return false;
  }
  if (dismissEntry.lastTimestampIso && latestTurn.lastTimestampIso) {
    const prevTs = Date.parse(dismissEntry.lastTimestampIso);
    const curTs = Date.parse(latestTurn.lastTimestampIso);
    if (Number.isFinite(prevTs) && Number.isFinite(curTs)) {
      if (curTs > prevTs) return false;
    } else if (latestTurn.lastTimestampIso > dismissEntry.lastTimestampIso) {
      return false;
    }
  }
  return true;
}

function resolveRequestedTurnIndex(turns, rawIndex, rawUserStep) {
  if (rawUserStep !== null && rawUserStep !== undefined && rawUserStep !== '') {
    const targetStep = Number(rawUserStep);
    if (Number.isInteger(targetStep)) {
      const matchedIdx = turns.findIndex((t) => t.userStepIndex === targetStep);
      if (matchedIdx >= 0) {
        return matchedIdx;
      }
    }
  }
  let idx =
    rawIndex === null || rawIndex === undefined || rawIndex === ''
      ? turns.length - 1
      : Number(rawIndex);
  if (!Number.isInteger(idx)) idx = turns.length - 1;
  return Math.max(0, Math.min(turns.length - 1, idx));
}

async function readRequestJson(req, maxBytes = 32768) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > maxBytes) {
      throw new HttpRequestError(413, 'Payload too large');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new HttpRequestError(400, 'Invalid JSON body');
  }
}

function sendJson(res, statusCode, body) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    ...BASE_SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

function renderAuthRequiredHtml() {
  const safeTitle = escapeHtmlBasic(DISPLAY_NAME);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle} — Authentication Required</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #090d16;
      color: #e5ecf6;
      font-family: "Segoe UI", system-ui, sans-serif;
      padding: 24px;
    }
    .card {
      max-width: 520px;
      background: #12192b;
      border: 1px solid rgba(148, 163, 184, 0.22);
      border-radius: 12px;
      padding: 24px;
      line-height: 1.6;
    }
    h1 { margin: 0 0 10px; font-size: 18px; color: #7dd3fc; }
    p { margin: 8px 0; font-size: 14px; color: #cbd5e1; }
    code {
      background: #090d16;
      border: 1px solid rgba(148, 163, 184, 0.2);
      padding: 2px 6px;
      border-radius: 4px;
      color: #bae6fd;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>${safeTitle}</h1>
    <p>A valid local session cookie is required to access reasoning logs and settings.</p>
    <p>Please open this control room via the <code>/hud</code> skill or the bundled launcher script (<code>open-room.mjs</code>).</p>
    <hr style="border:none;border-top:1px solid rgba(148,163,184,0.16);margin:14px 0" />
    <p>로컬 세션 쿠키 인증이 필요합니다. <code>/hud</code> 스킬 또는 전용 런처(<code>open-room.mjs</code>)를 통해 열어 주십시오.</p>
  </main>
</body>
</html>`;
}

function computeTurnStepsSignature(turn) {
  return (turn?.steps || [])
    .map((st) => `${st.stepIndex}:${st.isRestored ? 1 : 0}:${(st.displayText || '').length}`)
    .join(',');
}

export function computeStateSignature(state) {
  const pinsSig = (state.pinnedIds || []).join(',');
  const sessSig = (state.sessions || [])
    .map((s) => {
      const stepLens = computeTurnStepsSignature(s.latestTurn);
      const workersSig = (s.swarmWorkers || [])
        .map((w) => {
          const wSteps = computeTurnStepsSignature(w.latestTurn);
          return `${w.conversationId}:${w.workerName}:${w.totalTurns}:${w.latestTurn?.stepCount ?? 0}:${w.latestTurn?.status || ''}:${w.latestTurn?.needsRestoreCount ?? 0}:${w.latestTurn?.lastTimestampIso || ''}:${wSteps}`;
        })
        .join(';');
      return `${s.conversationId}:${s.slot || 0}:${s.isActive ? 1 : 0}:${s.isPinned ? 1 : 0}:${s.isDismissed ? 1 : 0}:${s.totalTurns}:${s.latestTurn.stepCount}:${s.latestTurn.status}:${s.latestTurn.needsRestoreCount}:${s.latestTurn.lastTimestampIso}:${stepLens}[${workersSig}]`;
    })
    .join('|');
  return `rev:${state.settingsRevision}|mode:${state.restorationMode}|${pinsSig}#${sessSig}`;
}

export function createControlRoomServer({
  port = resolveControlRoomPort(process.env.AGY_SUITE_HUD_PORT, { allowZero: true }),
  dataDir = resolveDataDir(),
  brainDirs = resolveBrainDirs(),
  fetchImpl = globalThis.fetch,
  writeDaemonFile = true,
  enableFsWatch = true,
  fallbackOnPortConflict = true,
  testKeyCooldownMs = TEST_KEY_COOLDOWN_MS,
  autoRestoreCooldownMs = AUTO_RESTORE_COOLDOWN_MS,
  livePollIntervalMs = 1500,
} = {}) {
  const paths = getDataPaths(dataDir);
  const dataDirHash = crypto.createHash('sha256').update(paths.dataDir).digest('hex').slice(0, 16);
  const startedAt = new Date().toISOString();
  const bootId = crypto.randomBytes(12).toString('hex');
  let bootstrapToken = crypto.randomBytes(24).toString('hex');
  const bridgeToken = crypto.randomBytes(24).toString('hex');
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const pokeToken = crypto.randomBytes(24).toString('hex');
  const sessions = new Map(); // sessionId -> { createdAt, expiresAt }

  let actualPort = port;
  const transcriptMemo = new Map();
  let cachedTranslationMap = {};
  let cachedTranslationMtimeMs = -1;
  let lastFullBrainScanMs = 0;
  let cachedDiscoveredPaths = new Map();
  let lastTestKeyAtMs = 0;

  const sseClients = new Set();
  const sseHeartbeats = new Set();
  let externalViewerActiveUntilMs = 0;
  let livePollTimer = null;
  let lastBroadcastSignature = '';
  let broadcastDebounceTimer = null;
  let fsWatcher = null;

  function markExternalViewerActive(ttlMs = 15000) {
    const until = Date.now() + Math.max(1000, ttlMs);
    if (until > externalViewerActiveUntilMs) {
      externalViewerActiveUntilMs = until;
    }
  }

  function hasActiveViewer() {
    return sseClients.size > 0 || externalViewerActiveUntilMs > Date.now();
  }

  const inFlightAutoRestore = new Set();
  const autoRestoreCooldownUntil = new Map();
  const selectedWorkerByParent = new Map();
  const observedLiveWorkers = new Map();

  function loadRoomUiState() {
    try {
      if (!fs.existsSync(paths.roomUiStatePath)) {
        return { version: 1, dismissed: {}, pinned: [] };
      }
      const parsed = JSON.parse(fs.readFileSync(paths.roomUiStatePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const dismissed =
          parsed.dismissed && typeof parsed.dismissed === 'object' ? parsed.dismissed : {};
        const pinned = sanitizePinnedList(parsed.pinned);
        return { version: 1, dismissed, pinned };
      }
    } catch {
      // Ignore corrupt state.
    }
    return { version: 1, dismissed: {}, pinned: [] };
  }

  function saveRoomUiState(state) {
    try {
      const normalized = {
        version: 1,
        dismissed: state?.dismissed && typeof state.dismissed === 'object' ? state.dismissed : {},
        pinned: sanitizePinnedList(state?.pinned),
      };
      atomicWriteSync(paths.roomUiStatePath, JSON.stringify(normalized, null, 2), { mode: 0o600 });
    } catch {
      // Ignore write failure.
    }
  }

  async function syncSlotDismissMark(convId, dismissedIsoOrNull) {
    await withLock(
      paths.stateLockPath,
      async () => {
        const state = loadSessionsState(paths.sessionsStatePath);
        let changed = false;
        for (const rec of Object.values(state.slots || {})) {
          if (rec && rec.conversationId === convId) {
            if (dismissedIsoOrNull) {
              rec.userDismissedIso = dismissedIsoOrNull;
            } else {
              delete rec.userDismissedIso;
            }
            changed = true;
          }
        }
        if (changed) {
          saveSessionsState(state, paths.sessionsStatePath);
        }
      },
      { maxWaitMs: 2500, staleMs: SHORT_STALE_LOCK_MS, retryMs: 35 },
    );
  }

  function getTranslationCacheFast() {
    try {
      if (!fs.existsSync(paths.cachePath)) {
        cachedTranslationMap = {};
        cachedTranslationMtimeMs = 0;
        return cachedTranslationMap;
      }
      const stat = fs.statSync(paths.cachePath);
      if (stat.mtimeMs !== cachedTranslationMtimeMs) {
        const parsed = JSON.parse(fs.readFileSync(paths.cachePath, 'utf8'));
        cachedTranslationMap = parsed && typeof parsed === 'object' ? parsed : {};
        cachedTranslationMtimeMs = stat.mtimeMs;
      }
    } catch {
      // Keep last valid in-memory map on transient rename collision.
    }
    return cachedTranslationMap;
  }

  function findTranscriptForConv(convId, hintedPath = '') {
    if (!convId || !CONV_ID_REGEX.test(convId)) return null;
    if (hintedPath) {
      const preferred = preferFullTranscriptPath(hintedPath);
      if (preferred) return preferred;
    }
    const memoized = transcriptMemo.get(convId);
    if (memoized?.transcriptPath) {
      const preferred = preferFullTranscriptPath(memoized.transcriptPath);
      if (preferred) return preferred;
    }
    const discovered = cachedDiscoveredPaths.get(convId);
    if (discovered) {
      const preferred = preferFullTranscriptPath(discovered);
      if (preferred) return preferred;
    }
    for (const brainRoot of brainDirs) {
      const logsDir = path.join(brainRoot, convId, '.system_generated', 'logs');
      const fullPath = path.join(logsDir, 'transcript_full.jsonl');
      if (fs.existsSync(fullPath)) return fullPath;
      const compactPath = path.join(logsDir, 'transcript.jsonl');
      if (fs.existsSync(compactPath)) return compactPath;
    }
    return null;
  }

  function putTranscriptMemoLru(convId, record) {
    transcriptMemo.delete(convId);
    transcriptMemo.set(convId, record);
    while (transcriptMemo.size > MAX_TRANSCRIPT_MEMO) {
      const oldestKey = transcriptMemo.keys().next().value;
      if (oldestKey === undefined) break;
      transcriptMemo.delete(oldestKey);
    }
  }

  function loadParsedConversation(convId, hintedPath = '') {
    if (!convId || !CONV_ID_REGEX.test(convId)) return null;
    const transcriptPath = findTranscriptForConv(convId, hintedPath);
    if (!transcriptPath) return null;

    let stat;
    try {
      stat = fs.statSync(transcriptPath);
    } catch {
      return null;
    }

    const prev = transcriptMemo.get(convId);
    if (
      prev &&
      prev.transcriptPath === transcriptPath &&
      prev.mtimeMs === stat.mtimeMs &&
      prev.size === stat.size
    ) {
      putTranscriptMemoLru(convId, prev);
      return prev;
    }

    let entries = [];
    try {
      entries = parseJsonLines(readBoundedLines(transcriptPath));
    } catch {
      return prev || null;
    }

    const turns = extractAllTurns(entries);
    if (turns.length > 0) {
      const sessionTopic = prev?.sessionTopic || extractFirstSessionTopic(transcriptPath, entries);
      const latestTurn = turns[turns.length - 1];
      const lastIso =
        latestTurn.finalReplyStep?.created_at ||
        latestTurn.thoughtSteps[latestTurn.thoughtSteps.length - 1]?.createdAt ||
        latestTurn.userStep?.created_at ||
        '';
      const parsedTs = Date.parse(lastIso);
      const lastActivityMs = Number.isFinite(parsedTs) ? parsedTs : stat.mtimeMs;

      const record = {
        conversationId: convId,
        transcriptPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        sessionTopic,
        turns,
        lastActivityMs,
        isSwarmWorker: false,
        workerName: '',
        parentConvId: '',
      };
      putTranscriptMemoLru(convId, record);
      return record;
    }

    const workerMeta = detectSwarmWorkerMeta(transcriptPath, entries);
    if (!workerMeta.isSwarmWorker) {
      return null;
    }

    const workerTurns = extractWorkerTurns(entries);
    if (workerTurns.length === 0) {
      return null;
    }

    const latestWorkerTurn = workerTurns[workerTurns.length - 1];
    const lastIso =
      latestWorkerTurn.finalReplyStep?.created_at ||
      latestWorkerTurn.thoughtSteps[latestWorkerTurn.thoughtSteps.length - 1]?.createdAt ||
      latestWorkerTurn.userStep?.created_at ||
      '';
    const parsedTs = Date.parse(lastIso);
    const lastActivityMs = Number.isFinite(parsedTs) ? parsedTs : stat.mtimeMs;

    const workerRecord = {
      conversationId: convId,
      transcriptPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sessionTopic: formatWorkerDisplayLabel(workerMeta.workerName),
      turns: workerTurns,
      lastActivityMs,
      isSwarmWorker: true,
      workerName: workerMeta.workerName,
      parentConvId: workerMeta.parentConvId,
    };
    putTranscriptMemoLru(convId, workerRecord);
    return workerRecord;
  }

  function resolveWorkerChain(workerRecord, mainParsedById = null, workerParsedById = null) {
    if (!workerRecord?.isSwarmWorker) return null;
    const visited = new Set([workerRecord.conversationId]);
    let curParentId = workerRecord.parentConvId;

    for (let depth = 0; depth < 8 && curParentId; depth += 1) {
      if (visited.has(curParentId)) break;
      visited.add(curParentId);

      if (mainParsedById?.has(curParentId)) {
        return { rootMainConvId: curParentId };
      }

      let parentRec = workerParsedById?.get(curParentId) || null;
      if (!parentRec) {
        parentRec = loadParsedConversation(curParentId);
      }
      if (!parentRec) return null;

      if (!parentRec.isSwarmWorker) {
        if (mainParsedById && !mainParsedById.has(parentRec.conversationId)) {
          mainParsedById.set(parentRec.conversationId, parentRec);
        }
        return { rootMainConvId: parentRec.conversationId };
      }

      curParentId = parentRec.parentConvId;
    }

    return null;
  }

  async function serializeTurn(
    turn,
    turnIndex,
    totalTurns,
    { settings, useNetworkRestore = false, manualTrigger = false } = {},
  ) {
    const activeSettings = settings || loadSettings(dataDir);
    const preloadedCache = useNetworkRestore ? null : getTranslationCacheFast();
    const userText = cleanUserInput(turn.userStep?.content);
    const restoredSteps = await restoreTurnSteps(turn.thoughtSteps, {
      allowNetwork: useNetworkRestore,
      settings: activeSettings,
      dataDir,
      userHint: userText,
      timeoutMs: 25000,
      translateTimeoutMs: 5000,
      preloadedCache,
      manualTrigger,
      fetchImpl,
    });

    const lastIso =
      turn.finalReplyStep?.created_at ||
      restoredSteps[restoredSteps.length - 1]?.createdAt ||
      turn.userStep?.created_at ||
      new Date().toISOString();

    let needsRestoreCount = 0;
    const steps = restoredSteps.map((s, idx) => {
      if (s.needsRestore) {
        needsRestoreCount += 1;
      }
      return {
        stepNumber: idx + 1,
        stepIndex: s.stepIndex,
        createdAt: s.createdAt,
        timeFormatted: formatTimeOnly(s.createdAt, activeSettings.timezone),
        toolNames: s.toolNames || [],
        isFinal: Boolean(s.isFinal),
        isRestored: Boolean(s.isRestored),
        needsRestore: Boolean(s.needsRestore),
        displayText: s.displayText,
        enText: s.enText,
        showOriginal: Boolean(s.showOriginalToggle),
      };
    });

    const userStepIndex =
      typeof turn.userStepIndex === 'number'
        ? turn.userStepIndex
        : typeof turn.userStep?.step_index === 'number'
          ? turn.userStep.step_index
          : null;

    return {
      turnIndex,
      turnNumber: turnIndex + 1,
      totalTurns,
      userStepIndex,
      userPrompt: userText,
      userSummary: summarizeOneLine(userText, 54),
      lastTimestampIso: lastIso,
      timestampFormatted: formatTimestamp(lastIso, activeSettings.timezone),
      timeFormatted: formatTimeOnly(lastIso, activeSettings.timezone),
      timezone: activeSettings.timezone,
      isComplete: Boolean(turn.isComplete),
      status: turn.isComplete ? 'complete' : 'thinking',
      stepCount: steps.length,
      needsRestoreCount,
      finalReply: turn.finalReplyStep?.content?.trim() || '',
      steps,
    };
  }

  function refreshFullBrainScanIfDue(force = false) {
    const now = Date.now();
    if (
      !force &&
      cachedDiscoveredPaths.size > 0 &&
      now - lastFullBrainScanMs < FULL_BRAIN_SCAN_INTERVAL_MS
    ) {
      return;
    }

    lastFullBrainScanMs = now;
    const recentByConv = new Map();

    for (const brainRoot of brainDirs) {
      if (!fs.existsSync(brainRoot)) continue;
      let dirs = [];
      try {
        dirs = fs.readdirSync(brainRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch {
        continue;
      }

      for (const dir of dirs) {
        if (!CONV_ID_REGEX.test(dir.name)) continue;
        const logsDir = path.join(brainRoot, dir.name, '.system_generated', 'logs');
        const fullPath = path.join(logsDir, 'transcript_full.jsonl');
        const compactPath = path.join(logsDir, 'transcript.jsonl');
        const chosen = fs.existsSync(fullPath)
          ? fullPath
          : fs.existsSync(compactPath)
            ? compactPath
            : null;
        if (!chosen) continue;
        try {
          const mtimeMs = fs.statSync(chosen).mtimeMs;
          const prev = recentByConv.get(dir.name);
          if (!prev || mtimeMs > prev.mtimeMs) {
            recentByConv.set(dir.name, { convId: dir.name, tp: chosen, mtimeMs });
          }
        } catch {
          // Ignore deleted/locked entries.
        }
      }
    }

    const topRecent = [...recentByConv.values()]
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_SCAN_CONVERSATIONS);

    const nextMap = new Map();
    for (const item of topRecent) {
      nextMap.set(item.convId, item.tp);
    }
    cachedDiscoveredPaths = nextMap;
  }

  function discoverCandidateConversations({
    slotRecordsByConvId,
    pinnedIds = [],
    forceFullScan = false,
  }) {
    refreshFullBrainScanIfDue(forceFullScan);
    const candidates = new Map();

    for (const [convId, rec] of slotRecordsByConvId.entries()) {
      const tp = findTranscriptForConv(convId, rec?.transcriptPath || '');
      if (tp) candidates.set(convId, tp);
    }

    for (const pinnedId of pinnedIds) {
      if (!candidates.has(pinnedId)) {
        const tp = findTranscriptForConv(pinnedId);
        if (tp) candidates.set(pinnedId, tp);
      }
    }

    for (const [convId, tp] of cachedDiscoveredPaths.entries()) {
      if (candidates.size >= MAX_TRANSCRIPT_MEMO) break;
      if (!candidates.has(convId)) {
        const verified = preferFullTranscriptPath(tp);
        if (verified) candidates.set(convId, verified);
      }
    }

    return candidates;
  }

  function getAllowedConversationMap({ forceFullScan = false } = {}) {
    const stateFile = loadSessionsState(paths.sessionsStatePath);
    const roomUiState = loadRoomUiState();
    const slotRecordsByConvId = new Map();
    for (const rec of Object.values(stateFile.slots || {})) {
      if (rec && rec.conversationId && CONV_ID_REGEX.test(rec.conversationId)) {
        slotRecordsByConvId.set(rec.conversationId, rec);
      }
    }
    const candidates = discoverCandidateConversations({
      slotRecordsByConvId,
      pinnedIds: roomUiState.pinned,
      forceFullScan,
    });
    // Include promoted root main sessions whose active swarm workers are in the candidate window.
    for (const [convId, hintedPath] of [...candidates.entries()]) {
      const parsed = loadParsedConversation(convId, hintedPath);
      if (!parsed?.isSwarmWorker) continue;
      const chain = resolveWorkerChain(parsed);
      if (chain?.rootMainConvId && !candidates.has(chain.rootMainConvId)) {
        const rootTp = findTranscriptForConv(chain.rootMainConvId);
        if (rootTp) {
          candidates.set(chain.rootMainConvId, rootTp);
        }
      }
    }
    return candidates;
  }

  function resolveAuthorizedConversation(convId) {
    if (!convId || !CONV_ID_REGEX.test(convId)) return null;
    const allowedMap = getAllowedConversationMap({ forceFullScan: false });
    if (allowedMap.has(convId)) {
      return loadParsedConversation(convId, allowedMap.get(convId));
    }
    const candidate = loadParsedConversation(convId);
    if (candidate?.isSwarmWorker) {
      const chain = resolveWorkerChain(candidate);
      if (chain?.rootMainConvId && allowedMap.has(chain.rootMainConvId)) {
        return candidate;
      }
    }
    return null;
  }

  async function buildFullState({ forceFullScan = false } = {}) {
    const nowMs = Date.now();
    const settings = loadSettings(dataDir);
    const stateFile = loadSessionsState(paths.sessionsStatePath);
    const roomUiState = loadRoomUiState();
    let roomUiDirty = false;

    const slotByConvId = new Map();
    const slotRecordsByConvId = new Map();
    for (const [slotKey, rec] of Object.entries(stateFile.slots || {})) {
      if (rec && rec.conversationId && CONV_ID_REGEX.test(rec.conversationId)) {
        slotByConvId.set(rec.conversationId, Number(slotKey));
        slotRecordsByConvId.set(rec.conversationId, rec);
      }
    }

    const pinnedSet = new Set(roomUiState.pinned);
    const candidateMap = discoverCandidateConversations({
      slotRecordsByConvId,
      pinnedIds: roomUiState.pinned,
      forceFullScan,
    });

    const mainParsedById = new Map();
    const workerParsedById = new Map();
    for (const [convId, hintedPath] of candidateMap.entries()) {
      const parsed = loadParsedConversation(convId, hintedPath);
      if (!parsed) continue;
      if (parsed.isSwarmWorker) {
        workerParsedById.set(parsed.conversationId, parsed);
      } else {
        mainParsedById.set(parsed.conversationId, parsed);
      }
    }

    // Attribute each swarm worker (including 2-stage helper -> worker -> main chains) to its root main session.
    const workersByMainId = new Map();
    for (const workerRec of workerParsedById.values()) {
      const chain = resolveWorkerChain(workerRec, mainParsedById, workerParsedById);
      if (!chain?.rootMainConvId) continue;
      if (!workersByMainId.has(chain.rootMainConvId)) {
        workersByMainId.set(chain.rootMainConvId, []);
      }
      workersByMainId.get(chain.rootMainConvId).push(workerRec);
    }

    const mainParsedList = [...mainParsedById.values()];
    const allActivityTs = [
      nowMs,
      ...mainParsedList.map((p) => p.lastActivityMs || 0),
      ...[...workerParsedById.values()].map((w) => w.lastActivityMs || 0),
    ];
    const refNowMs = Math.max(...allActivityTs);
    const sessions = [];

    for (const parsed of mainParsedList) {
      const latestIdx = parsed.turns.length - 1;
      const latestTurn = await serializeTurn(parsed.turns[latestIdx], latestIdx, parsed.turns.length, {
        settings,
        useNetworkRestore: false,
      });
      const assignedSlot = slotByConvId.get(parsed.conversationId) || null;

      const attachedRaw = (workersByMainId.get(parsed.conversationId) || [])
        .sort((a, b) => b.lastActivityMs - a.lastActivityMs)
        .slice(0, MAX_SWARM_WORKERS_PER_SESSION);

      const swarmWorkers = [];
      let maxWorkerActivityMs = 0;
      for (const w of attachedRaw) {
        const wLatestIdx = w.turns.length - 1;
        const wLatestTurn = await serializeTurn(w.turns[wLatestIdx], wLatestIdx, w.turns.length, {
          settings,
          useNetworkRestore: false,
        });
        if (w.lastActivityMs > maxWorkerActivityMs) {
          maxWorkerActivityMs = w.lastActivityMs;
        }
        swarmWorkers.push({
          conversationId: w.conversationId,
          shortId: w.conversationId.slice(0, 8),
          workerName: w.workerName,
          displayLabel: formatWorkerDisplayLabel(w.workerName),
          parentConvId: w.parentConvId,
          lastActivityMs: w.lastActivityMs,
          totalTurns: w.turns.length,
          turnUserStepIndices: w.turns.map((t) =>
            typeof t.userStepIndex === 'number' ? t.userStepIndex : null,
          ),
          latestTurn: wLatestTurn,
        });
      }

      const effectiveActivityMs = Math.max(parsed.lastActivityMs, maxWorkerActivityMs);
      const isActive = refNowMs - effectiveActivityMs <= ACTIVE_SESSION_WINDOW_MS;

      const dismissEntry = roomUiState.dismissed[parsed.conversationId];
      let isDismissed = false;
      if (dismissEntry) {
        if (isStillDismissed(dismissEntry, parsed.turns.length, latestTurn)) {
          isDismissed = true;
        } else {
          delete roomUiState.dismissed[parsed.conversationId];
          roomUiDirty = true;
        }
      }

      const turnUserStepIndices = parsed.turns.map((t) =>
        typeof t.userStepIndex === 'number' ? t.userStepIndex : null,
      );

      sessions.push({
        conversationId: parsed.conversationId,
        shortId: parsed.conversationId.slice(0, 8),
        slot: assignedSlot,
        sessionTopic: parsed.sessionTopic || latestTurn.userSummary,
        lastActivityMs: parsed.lastActivityMs,
        ageMinutes: Math.max(0, Math.round((refNowMs - effectiveActivityMs) / 60000)),
        isActive,
        isPinned: pinnedSet.has(parsed.conversationId),
        isDismissed,
        totalTurns: parsed.turns.length,
        turnUserStepIndices,
        latestTurn,
        swarmWorkers,
      });
    }

    if (roomUiDirty) {
      saveRoomUiState(roomUiState);
    }

    sessions.sort((a, b) => {
      const aHasSlot = typeof a.slot === 'number';
      const bHasSlot = typeof b.slot === 'number';
      if (aHasSlot && bHasSlot) return a.slot - b.slot;
      if (aHasSlot !== bHasSlot) return aHasSlot ? -1 : 1;
      return b.lastActivityMs - a.lastActivityMs;
    });

    if (sessions.length > 0 && !sessions.some((s) => s.isActive)) {
      const nonDismissed = sessions.filter((s) => !s.isDismissed);
      if (nonDismissed.length > 0) {
        let newest = nonDismissed[0];
        for (const s of nonDismissed) {
          if (s.lastActivityMs > newest.lastActivityMs) newest = s;
        }
        newest.isActive = true;
      }
    }

    return {
      bootId,
      serverTimeIso: new Date(nowMs).toISOString(),
      serverTimeMs: nowMs,
      activeWindowMinutes: Math.round(ACTIVE_SESSION_WINDOW_MS / 60000),
      restorationMode: settings.mode,
      targetLang: settings.targetLang,
      timezone: settings.timezone,
      settingsRevision: settings.settingsRevision,
      pinnedIds: [...pinnedSet],
      sessions,
    };
  }

  function pruneAutoRestoreCooldowns(now) {
    if (autoRestoreCooldownUntil.size <= 200) return;
    for (const [k, until] of autoRestoreCooldownUntil) {
      if (until <= now) autoRestoreCooldownUntil.delete(k);
    }
  }

  function triggerAutoRestoreVisible(state, { focusConvId = '' } = {}) {
    if (!hasActiveViewer() || !state || !Array.isArray(state.sessions)) {
      return [];
    }
    const settings = loadSettings(dataDir);
    if (settings.mode === 'raw') {
      return [];
    }
    if (settings.mode === 'gemini' && !loadSecrets(dataDir).geminiApiKey) {
      return [];
    }

    const now = Date.now();
    pruneAutoRestoreCooldowns(now);
    const normalizedFocus = typeof focusConvId === 'string' ? focusConvId.trim() : '';

    const targets = [];
    for (const s of state.sessions) {
      const isFocused = Boolean(normalizedFocus && s.conversationId === normalizedFocus);
      const isVisible = isFocused || (!s.isDismissed && (s.isActive || s.isPinned));
      if (!isVisible) continue;

      if (s.latestTurn && s.latestTurn.needsRestoreCount > 0) {
        targets.push({
          convId: s.conversationId,
          turnIndex: s.latestTurn.turnIndex,
          stepCount: s.latestTurn.stepCount,
        });
      }

      for (const w of s.swarmWorkers || []) {
        if (!w.latestTurn) continue;
        const isThinking = w.latestTurn.status === 'thinking';
        if (isThinking) {
          observedLiveWorkers.set(w.conversationId, now);
        }
        if (w.latestTurn.needsRestoreCount <= 0) {
          if (!isThinking) {
            observedLiveWorkers.delete(w.conversationId);
          }
          continue;
        }
        const observedLiveAt = observedLiveWorkers.get(w.conversationId) || 0;
        const recentlyObservedLive =
          observedLiveAt > 0 && now - observedLiveAt <= RECENT_SWARM_FINISH_GRACE_MS;
        // Restore running workers, workers that just finished after being observed live, or explicitly selected workers.
        const isLiveOrSelected =
          isThinking ||
          recentlyObservedLive ||
          selectedWorkerByParent.get(s.conversationId) === w.conversationId;
        if (!isLiveOrSelected) continue;
        targets.push({
          convId: w.conversationId,
          turnIndex: w.latestTurn.turnIndex,
          stepCount: w.latestTurn.stepCount,
        });
      }
    }

    if (observedLiveWorkers.size > 64) {
      for (const [wid, ts] of observedLiveWorkers) {
        if (now - ts > RECENT_SWARM_FINISH_GRACE_MS) {
          observedLiveWorkers.delete(wid);
        }
      }
    }

    const launched = [];
    for (const target of targets) {
      if (!hasActiveViewer()) break;
      if (inFlightAutoRestore.has(target.convId)) continue;
      const cooldownKey = `${target.convId}:${settings.settingsRevision}:${target.turnIndex}:${target.stepCount}`;
      if ((autoRestoreCooldownUntil.get(cooldownKey) || 0) > now) continue;

      inFlightAutoRestore.add(target.convId);

      const job = (async () => {
        let shouldFollowUpBroadcast = false;
        let forceFollowUpBroadcast = false;
        let followUpDelayMs = 250;
        try {
          if (!hasActiveViewer()) return;
          const workerLockPath = getWorkerLockPath(target.convId, dataDir);
          const workerDirtyPath = getWorkerDirtyPath(target.convId, dataDir);
          const lockRes = await withLock(
            workerLockPath,
            async () => {
              if (!hasActiveViewer()) return;
              const liveSettings = loadSettings(dataDir);
              if (liveSettings.mode === 'raw') return;
              if (liveSettings.mode === 'gemini' && !loadSecrets(dataDir).geminiApiKey) return;

              autoRestoreCooldownUntil.set(cooldownKey, Date.now() + autoRestoreCooldownMs);
              const parsed = loadParsedConversation(target.convId);
              if (!parsed || parsed.turns.length === 0) return;
              const latestIdx = parsed.turns.length - 1;
              const snapshotTurnCount = parsed.turns.length;
              const snapshotStepCount = parsed.turns[latestIdx]?.thoughtSteps?.length || 0;
              const snapshotComplete = Boolean(parsed.turns[latestIdx]?.isComplete);
              cachedTranslationMtimeMs = -1;
              const before = await serializeTurn(parsed.turns[latestIdx], latestIdx, parsed.turns.length, {
                settings: liveSettings,
                useNetworkRestore: false,
                manualTrigger: false,
              });
              if (before.needsRestoreCount === 0) {
                consumeWorkerDirty(workerDirtyPath);
                return;
              }
              const after = await serializeTurn(parsed.turns[latestIdx], latestIdx, parsed.turns.length, {
                settings: liveSettings,
                useNetworkRestore: true,
                manualTrigger: false,
              });
              const hadConcurrentDirty = consumeWorkerDirty(workerDirtyPath);
              cachedTranslationMtimeMs = -1;
              if (after.needsRestoreCount === 0) {
                autoRestoreCooldownUntil.delete(cooldownKey);
              }
              const refreshed = loadParsedConversation(target.convId);
              const refreshedLatest = refreshed?.turns?.[refreshed.turns.length - 1];
              const advancedOnDisk = Boolean(
                refreshed &&
                  (refreshed.turns.length > snapshotTurnCount ||
                    (refreshedLatest?.thoughtSteps?.length || 0) > snapshotStepCount ||
                    Boolean(refreshedLatest?.isComplete) !== snapshotComplete),
              );
              const changed =
                after.needsRestoreCount !== before.needsRestoreCount ||
                after.steps.some((st, idx) => st.displayText !== before.steps[idx]?.displayText);
              if (sseClients.size > 0 && (changed || hadConcurrentDirty || advancedOnDisk)) {
                shouldFollowUpBroadcast = true;
                forceFollowUpBroadcast = changed;
                followUpDelayMs = 30;
              }
            },
            { maxWaitMs: 0, staleMs: WORKER_STALE_LOCK_MS },
          );
          if (!lockRes.acquired && sseClients.size > 0) {
            shouldFollowUpBroadcast = true;
          }
        } catch {
          // Ignore transient auto-restore failures; cooldown prevents tight retry loops.
        } finally {
          inFlightAutoRestore.delete(target.convId);
          if (shouldFollowUpBroadcast && sseClients.size > 0) {
            scheduleBroadcast(followUpDelayMs, forceFollowUpBroadcast);
          }
        }
      })();
      launched.push(job);
    }

    return launched;
  }

  function updateLivePollTimer() {
    if (sseClients.size > 0 && !livePollTimer) {
      livePollTimer = setInterval(() => {
        broadcastState({ force: false });
      }, livePollIntervalMs);
      livePollTimer.unref?.();
    } else if (sseClients.size === 0) {
      if (livePollTimer) {
        clearInterval(livePollTimer);
        livePollTimer = null;
      }
      selectedWorkerByParent.clear();
      observedLiveWorkers.clear();
    }
  }

  function writeSseSafe(res, chunk) {
    const maxAllowedBytes = Math.max(MAX_SSE_BUFFER_BYTES, Buffer.byteLength(chunk, 'utf8') * 4);
    if (res.destroyed || res.writableEnded || res.writableLength > maxAllowedBytes) {
      try {
        res.destroy();
      } catch {
        // Ignore socket destroy error.
      }
      sseClients.delete(res);
      updateLivePollTimer();
      return false;
    }
    try {
      res.write(chunk);
      return true;
    } catch {
      sseClients.delete(res);
      updateLivePollTimer();
      return false;
    }
  }

  async function broadcastState({ force = false } = {}) {
    if (sseClients.size === 0) return;
    try {
      const state = await buildFullState({ forceFullScan: false });
      const sig = computeStateSignature(state);
      if (force || sig !== lastBroadcastSignature) {
        lastBroadcastSignature = sig;
        const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
        for (const res of [...sseClients]) {
          writeSseSafe(res, payload);
        }
      }
      triggerAutoRestoreVisible(state);
    } catch {
      // Ignore transient read race.
    }
  }

  function scheduleBroadcast(delayMs = 70, force = false) {
    if (sseClients.size === 0) return;
    if (broadcastDebounceTimer) {
      clearTimeout(broadcastDebounceTimer);
    }
    broadcastDebounceTimer = setTimeout(() => {
      broadcastDebounceTimer = null;
      broadcastState({ force });
    }, delayMs);
    broadcastDebounceTimer.unref?.();
  }

  function isAllowedHost(req) {
    const host = String(req.headers.host || '').trim().toLowerCase();
    return host === `127.0.0.1:${actualPort}` || host === `localhost:${actualPort}`;
  }

  function isAllowedSecFetchSite(req) {
    const raw = req.headers['sec-fetch-site'];
    if (!raw) return true;
    const val = String(raw).trim().toLowerCase();
    return val === 'same-origin' || val === 'none';
  }

  function isAllowedLocalOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    return origin === `http://127.0.0.1:${actualPort}` || origin === `http://localhost:${actualPort}`;
  }

  function pruneExpiredSessions(now = Date.now()) {
    for (const [sid, meta] of sessions.entries()) {
      if (!meta || meta.expiresAt <= now) {
        sessions.delete(sid);
      }
    }
  }

  function issueSession() {
    const now = Date.now();
    pruneExpiredSessions(now);
    while (sessions.size >= MAX_SESSIONS) {
      const oldestKey = sessions.keys().next().value;
      if (oldestKey === undefined) break;
      sessions.delete(oldestKey);
    }
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, { createdAt: now, expiresAt: now + SESSION_TTL_MS });
    return sid;
  }

  function hasValidSessionCookie(req) {
    const cookies = parseCookies(req.headers.cookie);
    const candidate = cookies[COOKIE_NAME] || '';
    if (!candidate) return false;
    const now = Date.now();
    let matched = false;
    for (const [sid, meta] of sessions.entries()) {
      if (!meta || meta.expiresAt <= now) {
        sessions.delete(sid);
        continue;
      }
      if (timingSafeEqualStr(candidate, sid)) {
        matched = true;
      }
    }
    return matched;
  }

  function hasValidBridgeAuth(req) {
    const thoughtsHeader = String(req.headers['x-thoughts-token'] || '').trim();
    if (thoughtsHeader && timingSafeEqualStr(thoughtsHeader, bridgeToken)) return true;
    const bridgeHeader = String(req.headers['x-bridge-token'] || '').trim();
    if (bridgeHeader && timingSafeEqualStr(bridgeHeader, bridgeToken)) return true;
    const authHeader = String(req.headers.authorization || '').trim();
    if (authHeader.toLowerCase().startsWith('bearer ')) {
      const bearer = authHeader.slice(7).trim();
      if (bearer && timingSafeEqualStr(bearer, bridgeToken)) return true;
    }
    return false;
  }

  function hasValidCsrfToken(req) {
    return timingSafeEqualStr(String(req.headers['x-room-token'] || ''), csrfToken);
  }

  function hasValidPokeToken(req) {
    return timingSafeEqualStr(String(req.headers['x-poke-token'] || ''), pokeToken);
  }

  function renderHtmlWithTokens(rawHtml) {
    const tokenMeta = `<meta name="room-token" content="${csrfToken}" />`;
    const bootMeta = `<meta name="server-boot-id" content="${bootId}" />`;
    const prefixMeta = `<meta name="storage-prefix" content="${STORAGE_PREFIX}" />`;

    let out = rawHtml;
    const replaceOrInsert = (name, tag) => {
      const rx = new RegExp(`<meta\\s+name="${name}"\\s+content="[^"]*"\\s*\\/?>`, 'i');
      if (rx.test(out)) {
        out = out.replace(rx, tag);
      } else {
        out = out.replace('</head>', `  ${tag}\n</head>`);
      }
    };
    replaceOrInsert('room-token', tokenMeta);
    replaceOrInsert('server-boot-id', bootMeta);
    replaceOrInsert('storage-prefix', prefixMeta);
    return out;
  }

  function writeDaemonPidFile() {
    if (!writeDaemonFile) return;
    try {
      atomicWriteSync(
        paths.daemonStatePath,
        JSON.stringify(
          {
            app: CONTROL_ROOM_APP_ID,
            pid: process.pid,
            port: actualPort,
            startedAt,
            bootId,
            dataDir: paths.dataDir,
            dataDirHash,
            bootstrapToken,
            bridgeToken,
            pokeToken,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } catch {
      // Ignore PID file write errors.
    }
  }

  function cleanupDaemonPidFile() {
    if (!writeDaemonFile) return;
    try {
      if (!fs.existsSync(paths.daemonStatePath)) return;
      const info = JSON.parse(fs.readFileSync(paths.daemonStatePath, 'utf8'));
      if (info?.pid === process.pid && info?.bootId === bootId) {
        fs.unlinkSync(paths.daemonStatePath);
      }
    } catch {
      // Ignore cleanup errors.
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!isAllowedHost(req)) {
        sendJson(res, 403, { ok: false, error: 'Forbidden host' });
        return;
      }

      if (!isAllowedSecFetchSite(req)) {
        sendJson(res, 403, { ok: false, error: 'Forbidden cross-site request' });
        return;
      }

      if (!isAllowedLocalOrigin(req)) {
        sendJson(res, 403, { ok: false, error: 'Forbidden origin' });
        return;
      }

      const url = new URL(req.url || '/', `http://${HOST}:${actualPort}`);

      // Public non-sensitive health probe (no tokens, no transcripts, no settings).
      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          app: CONTROL_ROOM_APP_ID,
          pid: process.pid,
          port: actualPort,
          bootId,
          dataDirHash,
          clients: sseClients.size,
        });
        return;
      }

      // Internal hook/worker wake-up endpoint authenticated with dedicated X-Poke-Token.
      if (req.method === 'POST' && url.pathname === '/api/poke') {
        if (!hasValidPokeToken(req)) {
          sendJson(res, 403, { ok: false, error: 'Forbidden poke token' });
          return;
        }
        cachedTranslationMtimeMs = -1;
        scheduleBroadcast(40, false);
        sendJson(res, 200, { ok: true });
        return;
      }

      // Single-use bootstrap token -> per-auth random HttpOnly; SameSite=Strict session cookie exchange.
      if (req.method === 'GET' && url.pathname === '/auth') {
        const provided = url.searchParams.get('token') || '';
        if (!timingSafeEqualStr(provided, bootstrapToken)) {
          sendJson(res, 403, { ok: false, error: 'Invalid bootstrap token' });
          return;
        }
        bootstrapToken = crypto.randomBytes(24).toString('hex');
        writeDaemonPidFile();
        const sid = issueSession();
        res.writeHead(302, {
          ...BASE_SECURITY_HEADERS,
          'Cache-Control': 'no-store',
          'Set-Cookie': `${COOKIE_NAME}=${sid}; HttpOnly; SameSite=Strict; Path=/`,
          Location: '/',
        });
        res.end();
        return;
      }

      // Root HTML: requires valid session cookie; otherwise returns token-free launcher notice (401).
      if (req.method === 'GET' && url.pathname === '/') {
        if (!hasValidSessionCookie(req)) {
          res.writeHead(401, {
            ...BASE_SECURITY_HEADERS,
            'Content-Security-Policy': CSP_POLICY,
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(renderAuthRequiredHtml());
          return;
        }
        const rawHtml = fs.readFileSync(UI_HTML_PATH, 'utf8');
        const html = renderHtmlWithTokens(rawHtml);
        res.writeHead(200, {
          ...BASE_SECURITY_HEADERS,
          'Content-Security-Policy': CSP_POLICY,
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
      }

      // All remaining routes require a valid HttpOnly session cookie or internal bridge token.
      const isBridgeAuth = hasValidBridgeAuth(req);
      if (!isBridgeAuth && !hasValidSessionCookie(req)) {
        sendJson(res, 401, { ok: false, error: 'Authentication required' });
        return;
      }

      // All state-mutating POST routes from browser sessions additionally require X-Room-Token (CSRF defense in depth).
      if (req.method === 'POST' && !isBridgeAuth && !hasValidCsrfToken(req)) {
        sendJson(res, 403, { ok: false, error: 'Forbidden room token' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const viewerActive = url.searchParams.get('viewerActive') === '1';
        const focusConvId = String(url.searchParams.get('focusConvId') || '').trim();
        const prevEtag = String(url.searchParams.get('etag') || '').trim();
        if (viewerActive) {
          markExternalViewerActive(15000);
        }
        const state = await buildFullState({ forceFullScan: false });
        const sig = computeStateSignature(state);
        const etag = crypto.createHash('sha1').update(sig).digest('hex');
        if (viewerActive) {
          triggerAutoRestoreVisible(state, { focusConvId });
        }
        if (prevEtag && prevEtag === etag) {
          sendJson(res, 200, { unchanged: true, etag, serverTimeIso: state.serverTimeIso });
          return;
        }
        sendJson(res, 200, { ...state, etag });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/settings') {
        const settings = loadSettings(dataDir);
        const { geminiApiKey } = loadSecrets(dataDir);
        sendJson(res, 200, {
          ok: true,
          settings,
          hasApiKey: Boolean(geminiApiKey),
          apiKeyMask: maskApiKey(geminiApiKey),
          presets: PROMPT_PRESETS,
          defaultModels: DEFAULT_MODELS,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const body = await readRequestJson(req);
        const current = loadSettings(dataDir);
        const validation = validateSettingsPatch(body, current);
        if (!validation.ok) {
          sendJson(res, 400, { ok: false, error: validation.error });
          return;
        }

        // Handle dedicated plugin API key cleanly: empty string keeps existing key; clearApiKey deletes it.
        const currentSecrets = loadSecrets(dataDir);
        if (body.clearApiKey === true) {
          saveSecrets({ geminiApiKey: '' }, dataDir);
        } else if (typeof body.apiKey === 'string' && body.apiKey.length > 0) {
          if (!isValidApiKeyFormat(body.apiKey)) {
            sendJson(res, 400, { ok: false, error: 'Invalid API key format' });
            return;
          }
          const candidateKey = body.apiKey.trim();
          if (candidateKey.length > 0) {
            saveSecrets({ geminiApiKey: candidateKey }, dataDir);
          }
        } else if (currentSecrets.geminiApiKey) {
          // Preserve existing key untouched.
        }

        const saved = saveSettings(validation.settings, dataDir, { bumpRevision: true });
        const refreshedSecrets = loadSecrets(dataDir);
        scheduleBroadcast(20, true);
        sendJson(res, 200, {
          ok: true,
          settings: saved,
          hasApiKey: Boolean(refreshedSecrets.geminiApiKey),
          apiKeyMask: maskApiKey(refreshedSecrets.geminiApiKey),
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/test-key') {
        const body = await readRequestJson(req);
        if (typeof body.apiKey === 'string' && body.apiKey.length > 0 && !isValidApiKeyFormat(body.apiKey)) {
          sendJson(res, 400, {
            ok: false,
            code: 'invalid_key',
            error: 'Invalid API key format.',
          });
          return;
        }

        const now = Date.now();
        if (now - lastTestKeyAtMs < testKeyCooldownMs) {
          sendJson(res, 429, {
            ok: false,
            code: 'rate_limited',
            error: 'Please wait a moment before testing again.',
          });
          return;
        }
        lastTestKeyAtMs = now;

        const settings = loadSettings(dataDir);
        const rawKey =
          typeof body.apiKey === 'string' && body.apiKey.trim()
            ? body.apiKey.trim()
            : loadSecrets(dataDir).geminiApiKey;

        if (!rawKey) {
          sendJson(res, 400, {
            ok: false,
            code: 'missing_key',
            error: 'No Gemini API key configured.',
          });
          return;
        }

        const requestedModel =
          typeof body.model === 'string' && body.model.trim()
            ? body.model.trim()
            : settings.models[0] || DEFAULT_MODELS[0];

        if (!isValidModelName(requestedModel)) {
          sendJson(res, 400, {
            ok: false,
            code: 'invalid_model',
            error: 'Invalid model identifier.',
          });
          return;
        }

        try {
          const probeUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(requestedModel)}`;
          const upstream = await fetchImpl(probeUrl, {
            method: 'GET',
            headers: { 'x-goog-api-key': rawKey },
            signal: AbortSignal.timeout(8000),
          });

          if (upstream.ok) {
            await upstream.body?.cancel?.().catch(() => {});
            sendJson(res, 200, {
              ok: true,
              status: upstream.status,
              code: 'connected',
              model: requestedModel,
            });
            return;
          }

          let errorSnippet = '';
          if (upstream.status === 400) {
            try {
              errorSnippet = (await upstream.text()).slice(0, 4096);
            } catch {
              errorSnippet = '';
            }
          } else {
            await upstream.body?.cancel?.().catch(() => {});
          }

          const isApiKeyInvalid400 =
            upstream.status === 400 && /API_KEY_INVALID/i.test(errorSnippet);
          const code =
            upstream.status === 401 || upstream.status === 403 || isApiKeyInvalid400
              ? 'invalid_key'
              : upstream.status === 404
                ? 'model_not_found'
                : upstream.status === 429
                  ? 'rate_limited'
                  : 'upstream_error';
          sendJson(res, 200, {
            ok: false,
            status: upstream.status,
            code,
            model: requestedModel,
          });
          return;
        } catch {
          sendJson(res, 200, {
            ok: false,
            status: 0,
            code: 'network_error',
            model: requestedModel,
          });
          return;
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/turn') {
        const convId = url.searchParams.get('conv') || '';
        const parsed = resolveAuthorizedConversation(convId);
        if (!parsed) {
          sendJson(res, 404, { ok: false, error: 'Conversation not found' });
          return;
        }

        const idx = resolveRequestedTurnIndex(
          parsed.turns,
          url.searchParams.get('index'),
          url.searchParams.get('userStep'),
        );

        const settings = loadSettings(dataDir);
        const turnData = await serializeTurn(parsed.turns[idx], idx, parsed.turns.length, {
          settings,
          useNetworkRestore: false,
        });
        sendJson(res, 200, {
          ok: true,
          conversationId: convId,
          isSwarmWorker: Boolean(parsed.isSwarmWorker),
          workerName: parsed.workerName || '',
          totalTurns: parsed.turns.length,
          turn: turnData,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/dismiss') {
        const body = await readRequestJson(req);
        const convId = String(body.conversationId || '');
        const allowedMap = getAllowedConversationMap({ forceFullScan: false });
        if (!allowedMap.has(convId)) {
          sendJson(res, 404, { ok: false, error: 'Conversation not found' });
          return;
        }
        const parsed = loadParsedConversation(convId, allowedMap.get(convId));
        if (!parsed || parsed.isSwarmWorker) {
          sendJson(res, 404, { ok: false, error: 'Conversation not found' });
          return;
        }
        const latestIdx = parsed.turns.length - 1;
        const latestTurn = await serializeTurn(parsed.turns[latestIdx], latestIdx, parsed.turns.length, {
          useNetworkRestore: false,
        });
        const uiState = loadRoomUiState();
        uiState.dismissed[convId] = {
          totalTurns: parsed.turns.length,
          stepCount: latestTurn.stepCount,
          lastTimestampIso: latestTurn.lastTimestampIso,
          dismissedAtMs: Date.now(),
        };
        uiState.pinned = uiState.pinned.filter((id) => id !== convId);
        saveRoomUiState(uiState);
        await syncSlotDismissMark(convId, latestTurn.lastTimestampIso);
        scheduleBroadcast(20, true);
        sendJson(res, 200, { ok: true, conversationId: convId, pinnedIds: uiState.pinned });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/undismiss') {
        const body = await readRequestJson(req);
        const uiState = loadRoomUiState();
        if (body.all) {
          const clearedIds = Object.keys(uiState.dismissed);
          uiState.dismissed = {};
          saveRoomUiState(uiState);
          for (const cid of clearedIds) {
            await syncSlotDismissMark(cid, null);
          }
        } else {
          const convId = String(body.conversationId || '').trim();
          if (!convId || !CONV_ID_REGEX.test(convId)) {
            sendJson(res, 400, { ok: false, error: 'Invalid conversation ID' });
            return;
          }
          delete uiState.dismissed[convId];
          saveRoomUiState(uiState);
          await syncSlotDismissMark(convId, null);
        }
        scheduleBroadcast(20, true);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/pin') {
        const body = await readRequestJson(req);
        const uiState = loadRoomUiState();
        const nextSet = new Set(uiState.pinned);

        if (Array.isArray(body.pinnedIds)) {
          for (const rawId of body.pinnedIds) {
            const cid = typeof rawId === 'string' ? rawId.trim() : '';
            if (!cid || !CONV_ID_REGEX.test(cid)) continue;
            const parsed = loadParsedConversation(cid);
            if (parsed && !parsed.isSwarmWorker) {
              nextSet.add(cid);
              if (nextSet.size >= MAX_PINNED_SESSIONS) break;
            }
          }
        } else {
          const convId = String(body.conversationId || '').trim();
          if (!convId || !CONV_ID_REGEX.test(convId)) {
            sendJson(res, 400, { ok: false, error: 'Invalid conversation ID' });
            return;
          }
          const shouldPin = Boolean(body.pinned);
          if (shouldPin) {
            const parsed = loadParsedConversation(convId);
            if (!parsed || parsed.isSwarmWorker) {
              sendJson(res, 404, { ok: false, error: 'Conversation not found' });
              return;
            }
            nextSet.add(convId);
            if (uiState.dismissed[convId]) {
              delete uiState.dismissed[convId];
              await syncSlotDismissMark(convId, null);
            }
          } else {
            nextSet.delete(convId);
          }
        }

        uiState.pinned = sanitizePinnedList([...nextSet]);
        saveRoomUiState(uiState);
        scheduleBroadcast(20, true);
        sendJson(res, 200, { ok: true, pinnedIds: uiState.pinned });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/select-worker') {
        const body = await readRequestJson(req);
        const workerId = String(body.conversationId || '').trim();
        const parentConvId = String(body.parentConvId || '').trim();

        if (!workerId) {
          if (!parentConvId || !CONV_ID_REGEX.test(parentConvId)) {
            sendJson(res, 400, { ok: false, error: 'Invalid conversation ID' });
            return;
          }
          selectedWorkerByParent.delete(parentConvId);
          sendJson(res, 200, { ok: true, parentConvId, cleared: true });
          return;
        }

        if (!CONV_ID_REGEX.test(workerId)) {
          sendJson(res, 400, { ok: false, error: 'Invalid conversation ID' });
          return;
        }
        const parsed = resolveAuthorizedConversation(workerId);
        if (!parsed || !parsed.isSwarmWorker) {
          sendJson(res, 404, { ok: false, error: 'Swarm worker not found' });
          return;
        }
        const chain = resolveWorkerChain(parsed);
        const resolvedParentId = chain?.rootMainConvId || '';
        if (!resolvedParentId) {
          sendJson(res, 404, { ok: false, error: 'Swarm worker parent not found' });
          return;
        }
        selectedWorkerByParent.delete(resolvedParentId);
        selectedWorkerByParent.set(resolvedParentId, workerId);
        while (selectedWorkerByParent.size > 16) {
          const oldest = selectedWorkerByParent.keys().next().value;
          if (oldest === undefined) break;
          selectedWorkerByParent.delete(oldest);
        }
        if (hasActiveViewer()) {
          const state = await buildFullState({ forceFullScan: false });
          triggerAutoRestoreVisible(state, { focusConvId: resolvedParentId });
        }
        sendJson(res, 200, { ok: true, parentConvId: resolvedParentId, conversationId: workerId });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/restore-turn') {
        const body = await readRequestJson(req);
        const convId = String(body.conversationId || '');
        const parsed = resolveAuthorizedConversation(convId);
        if (!parsed) {
          sendJson(res, 404, { ok: false, error: 'Conversation not found' });
          return;
        }
        const idx = resolveRequestedTurnIndex(parsed.turns, body.turnIndex, body.userStepIndex);
        const settings = loadSettings(dataDir);

        cachedTranslationMtimeMs = -1;
        const turnData = await serializeTurn(parsed.turns[idx], idx, parsed.turns.length, {
          settings,
          useNetworkRestore: settings.mode !== 'raw',
          manualTrigger: true,
        });
        cachedTranslationMtimeMs = -1;
        scheduleBroadcast(30, true);
        sendJson(res, 200, {
          ok: true,
          conversationId: convId,
          isSwarmWorker: Boolean(parsed.isSwarmWorker),
          workerName: parsed.workerName || '',
          totalTurns: parsed.turns.length,
          turn: turnData,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          ...BASE_SECURITY_HEADERS,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        let closed = false;
        let hb = null;
        const cleanupSse = () => {
          if (closed) return;
          closed = true;
          if (hb) {
            clearInterval(hb);
            sseHeartbeats.delete(hb);
            hb = null;
          }
          sseClients.delete(res);
          updateLivePollTimer();
        };
        req.on('close', cleanupSse);
        res.on('close', cleanupSse);

        res.write(': connected\n\n');
        sseClients.add(res);
        updateLivePollTimer();

        try {
          const initial = await buildFullState({ forceFullScan: false });
          if (closed || res.destroyed || res.writableEnded) {
            cleanupSse();
            return;
          }
          if (!writeSseSafe(res, `event: state\ndata: ${JSON.stringify(initial)}\n\n`)) {
            cleanupSse();
            return;
          }
          triggerAutoRestoreVisible(initial);
        } catch {
          // Ignore initial push error.
        }

        if (closed || res.destroyed || res.writableEnded) {
          cleanupSse();
          return;
        }

        hb = setInterval(() => {
          if (closed || !writeSseSafe(res, ': hb\n\n')) {
            cleanupSse();
          }
        }, 20000);
        hb.unref?.();
        sseHeartbeats.add(hb);
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (err) {
      if (err instanceof HttpRequestError) {
        sendJson(res, err.statusCode, { ok: false, error: err.publicMessage });
        return;
      }
      sendJson(res, 500, { ok: false, error: 'Internal server error' });
    }
  });

  function startWatcher() {
    fs.mkdirSync(paths.dataDir, { recursive: true });
    purgeStaleTempFiles(paths.dataDir);
    if (!enableFsWatch) return;
    try {
      fsWatcher = fs.watch(paths.dataDir, (_event, filename) => {
        const name = String(filename || '');
        if (
          !name ||
          name.includes('.tmp-') ||
          name.includes('.stale-') ||
          name.endsWith('.lock') ||
          name.endsWith('.dirty')
        ) {
          return;
        }
        if (
          name.includes(`${FILE_PREFIX}-sessions`) ||
          name.includes(`${FILE_PREFIX}-cache`) ||
          name.includes(`${FILE_PREFIX}-room-state`) ||
          name === 'settings.json'
        ) {
          if (name.includes(`${FILE_PREFIX}-cache`)) {
            cachedTranslationMtimeMs = -1;
          }
          scheduleBroadcast(50, name === 'settings.json');
        }
      });
      fsWatcher.unref?.();
    } catch {
      // Directory watch is optional; live poll + /api/poke cover updates.
    }
  }

  function listenOnPort(targetPort) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        const addr = server.address();
        actualPort = typeof addr === 'object' && addr ? addr.port : targetPort;
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(targetPort, HOST);
    });
  }

  async function start() {
    startWatcher();
    try {
      await listenOnPort(port);
    } catch (err) {
      if (err?.code === 'EADDRINUSE' && port > 0 && fallbackOnPortConflict) {
        const existing = await verifyControlRoomHealth(port, 400, fetchImpl);
        const isSameDataDirDaemon = Boolean(existing && existing.dataDirHash === dataDirHash);
        if (!isSameDataDirDaemon) {
          await listenOnPort(0);
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
    writeDaemonPidFile();
    return {
      port: actualPort,
      bootId,
      bootstrapToken,
      bridgeToken,
      csrfToken,
      pokeToken,
    };
  }

  async function stop() {
    if (livePollTimer) {
      clearInterval(livePollTimer);
      livePollTimer = null;
    }
    if (broadcastDebounceTimer) {
      clearTimeout(broadcastDebounceTimer);
      broadcastDebounceTimer = null;
    }
    if (fsWatcher) {
      try {
        fsWatcher.close();
      } catch {
        // Ignore watcher close errors.
      }
      fsWatcher = null;
    }
    for (const hb of [...sseHeartbeats]) {
      clearInterval(hb);
    }
    sseHeartbeats.clear();
    for (const res of [...sseClients]) {
      try {
        res.end();
      } catch {
        // Ignore client close errors.
      }
    }
    sseClients.clear();
    sessions.clear();
    selectedWorkerByParent.clear();
    observedLiveWorkers.clear();
    cleanupDaemonPidFile();
    server.closeIdleConnections?.();
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  return {
    server,
    start,
    stop,
    get port() {
      return actualPort;
    },
    get bootstrapToken() {
      return bootstrapToken;
    },
    bootId,
    bridgeToken,
    csrfToken,
    pokeToken,
  };
}

async function runCli() {
  const dataDir = resolveDataDir();
  const expectedDataDirHash = crypto
    .createHash('sha256')
    .update(path.resolve(dataDir))
    .digest('hex')
    .slice(0, 16);
  const requestedPort = resolveControlRoomPort(process.env.AGY_SUITE_HUD_PORT, { allowZero: true });
  let effectivePort = requestedPort;
  if (process.argv.includes('--daemon') && requestedPort > 0) {
    const existing = await verifyControlRoomHealth(requestedPort, 400);
    if (existing && existing.dataDirHash === expectedDataDirHash) {
      process.exit(0);
    }
    if (existing && existing.dataDirHash !== expectedDataDirHash) {
      effectivePort = 0;
    }
  }

  const instance = createControlRoomServer({
    port: effectivePort,
    dataDir,
    fallbackOnPortConflict: true,
  });

  let info;
  try {
    info = await instance.start();
  } catch (err) {
    if (err?.code === 'EADDRINUSE') {
      process.exit(0);
    }
    process.exit(1);
  }
  if (!process.argv.includes('--daemon')) {
    process.stdout.write(`${DISPLAY_NAME} listening on http://${HOST}:${info.port}\n`);
  }

  for (const sig of ['SIGINT', 'SIGTERM', 'exit']) {
    process.on(sig, () => {
      if (sig === 'exit') {
        try {
          const paths = getDataPaths(dataDir);
          if (fs.existsSync(paths.daemonStatePath)) {
            const d = JSON.parse(fs.readFileSync(paths.daemonStatePath, 'utf8'));
            if (d?.pid === process.pid && d?.bootId === info.bootId) {
              fs.unlinkSync(paths.daemonStatePath);
            }
          }
        } catch {
          // Ignore cleanup errors on exit.
        }
        return;
      }
      instance.stop().finally(() => process.exit(0));
    });
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
  runCli().catch(() => {
    process.exitCode = 1;
  });
}
