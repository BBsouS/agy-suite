import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBrainDirs, sanitizeChildEnv } from '../../hooks/constants.mjs';
import {
  BRAIN_DIRS,
  SIDECAR_VIEWER_HEARTBEAT_PATH,
  atomicWriteSync,
} from '../../hooks/core.mjs';
import { createControlRoomServer } from '../../hooks/server.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const __dirname = path.dirname(SCRIPT_PATH);

const CONV_ID_RE = /^[a-zA-Z0-9_-]{4,80}$/;
export const COMPACTION_DROP_RATIO = 0.7;
export const QUOTA_CACHE_TTL_MS = 120 * 1000;
export const QUOTA_STALE_MAX_AGE_MS = 10 * 60 * 1000;
export const QUOTA_FORCE_COOLDOWN_MS = 10 * 1000;
export const QUOTA_WATCHDOG_MS = 30 * 1000;

const MAX_CONTEXT_CACHE_ENTRIES = 64;
const MAX_SINGLE_READ_BYTES = 2 * 1024 * 1024;
const MAX_METER_READ_WINDOW_BYTES = 16 * 1024 * 1024;
const MANUAL_COMPACT_RE = /(?:<USER_REQUEST>\s*|^)\/compact\b/i;

const AGY_BIN_CANDIDATES = [
  process.env.AGY_CLI_PATH,
  path.join(os.homedir(), '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy'),
  process.platform === 'win32' ? 'agy.exe' : 'agy',
].filter(Boolean);

export function getModelFamily(modelName) {
  const m = String(modelName || '').toLowerCase();
  if (!m) return 'unknown';
  if (m.includes('gpt-oss')) return 'gpt-oss';
  if (m.includes('claude')) return 'claude';
  if (
    m.includes('gemini') ||
    m.includes('carbon') ||
    m.includes('neon') ||
    m.includes('hydrogen') ||
    m.includes('argon')
  ) {
    return 'gemini';
  }
  return 'other';
}

export function isSameModelFamily(prevModel, curModel) {
  const a = getModelFamily(prevModel);
  const b = getModelFamily(curModel);
  return a === b || a === 'unknown' || b === 'unknown';
}

const contextMeterCache = new Map(); // convId -> { path, offset, mtimeMs, size, lastKnownModel, rawEvents, rows, result }
const seenPeakByConv = new Map();
const seenDropsByConv = new Map();

let quotaCache = null; // { ok, fetchedAt, groups, error }
let quotaInFlight = null;
let lastQuotaForceMs = 0;

function setBoundedMap(map, key, value, max = MAX_CONTEXT_CACHE_ENTRIES) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function isTimestampAfter(a, b) {
  if (!a) return false;
  if (!b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta > tb;
  return String(a) > String(b);
}

function parseTranscriptLine(line, lastKnownModelRef) {
  if (!line) return null;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const evType = String(obj?.type || '').toUpperCase();
  const evModel = String(obj?.model || '').trim();
  if (evModel) lastKnownModelRef.value = evModel;
  const isManualCompactCmd =
    evType === 'USER_INPUT' && MANUAL_COMPACT_RE.test(String(obj?.content || ''));
  const inputTokens = Number(obj?.input_tokens) || 0;
  const cacheReadTokens = Number(obj?.cache_read_tokens) || 0;
  const totalTokens = inputTokens + cacheReadTokens;
  return {
    type: evType,
    isManualCompactCmd,
    createdAt: String(obj?.created_at || ''),
    model: evModel || lastKnownModelRef.value,
    inputTokens,
    cacheReadTokens,
    totalTokens,
  };
}

function readTranscriptIncremental(filePath, stat, prevState, bypassCache) {
  let state;
  const sameSizeOverwritten =
    prevState && stat.size === prevState.offset && stat.mtimeMs !== prevState.mtimeMs;
  if (
    !bypassCache &&
    prevState &&
    prevState.path === filePath &&
    stat.size >= prevState.offset &&
    !sameSizeOverwritten
  ) {
    state = prevState;
  } else {
    state = {
      path: filePath,
      offset: 0,
      mtimeMs: 0,
      size: 0,
      lastKnownModel: '',
      rawEvents: [],
      rows: [],
      result: null,
    };
  }

  let ephemeralEvents = null;
  let ephemeralRows = null;

  if (stat.size > state.offset) {
    let cursor = state.offset;
    let skipFirstPartialLine = false;
    if (stat.size - cursor > MAX_METER_READ_WINDOW_BYTES) {
      state = {
        path: filePath,
        offset: Math.max(0, stat.size - MAX_METER_READ_WINDOW_BYTES),
        mtimeMs: 0,
        size: 0,
        lastKnownModel: '',
        rawEvents: [],
        rows: [],
        result: null,
      };
      cursor = state.offset;
      skipFirstPartialLine = cursor > 0;
    }

    const lastModelRef = { value: state.lastKnownModel };
    const fd = fs.openSync(filePath, 'r');
    try {
      let skippingOversizedLine = false;
      while (cursor < stat.size) {
        const chunkLen = Math.min(MAX_SINGLE_READ_BYTES, stat.size - cursor);
        const buf = Buffer.allocUnsafe(chunkLen);
        const bytesRead = fs.readSync(fd, buf, 0, chunkLen, cursor);
        if (bytesRead <= 0) break;
        const slice = buf.subarray(0, bytesRead);

        if (skippingOversizedLine) {
          const nlIdx = slice.indexOf(0x0a);
          if (nlIdx < 0) {
            cursor += bytesRead;
            state.offset = cursor;
            continue;
          }
          cursor += nlIdx + 1;
          state.offset = cursor;
          skippingOversizedLine = false;
          continue;
        }

        const lastNl = slice.lastIndexOf(0x0a);
        if (lastNl >= 0) {
          let text = slice.subarray(0, lastNl + 1).toString('utf8');
          if (skipFirstPartialLine) {
            const firstNl = text.indexOf('\n');
            text = firstNl >= 0 ? text.slice(firstNl + 1) : '';
            skipFirstPartialLine = false;
          }
          for (const line of text.split(/\r?\n/)) {
            const ev = parseTranscriptLine(line, lastModelRef);
            if (!ev) continue;
            state.rawEvents.push(ev);
            if (ev.totalTokens > 0) {
              state.rows.push({
                eventIdx: state.rawEvents.length - 1,
                type: ev.type,
                createdAt: ev.createdAt,
                model: ev.model,
                inputTokens: ev.inputTokens,
                cacheReadTokens: ev.cacheReadTokens,
                totalTokens: ev.totalTokens,
              });
            }
          }
          cursor += lastNl + 1;
          state.offset = cursor;
          if (lastNl + 1 < bytesRead && cursor + (bytesRead - (lastNl + 1)) >= stat.size) {
            const trailingText = slice.subarray(lastNl + 1).toString('utf8').trim();
            const trailingEv = parseTranscriptLine(trailingText, { value: lastModelRef.value });
            if (trailingEv) {
              ephemeralEvents = [trailingEv];
              if (trailingEv.totalTokens > 0) {
                ephemeralRows = [
                  {
                    eventIdx: state.rawEvents.length,
                    type: trailingEv.type,
                    createdAt: trailingEv.createdAt,
                    model: trailingEv.model,
                    inputTokens: trailingEv.inputTokens,
                    cacheReadTokens: trailingEv.cacheReadTokens,
                    totalTokens: trailingEv.totalTokens,
                  },
                ];
              }
            }
            break;
          }
        } else if (cursor + bytesRead < stat.size) {
          // Single line larger than MAX_SINGLE_READ_BYTES: skip gracefully until next newline.
          cursor += bytesRead;
          state.offset = cursor;
          skippingOversizedLine = true;
          skipFirstPartialLine = false;
        } else {
          // EOF without trailing newline: evaluate ephemerally without advancing offset.
          const trailingText = skipFirstPartialLine ? '' : slice.toString('utf8').trim();
          const trailingEv = parseTranscriptLine(trailingText, { value: lastModelRef.value });
          if (trailingEv) {
            ephemeralEvents = [trailingEv];
            if (trailingEv.totalTokens > 0) {
              ephemeralRows = [
                {
                  eventIdx: state.rawEvents.length,
                  type: trailingEv.type,
                  createdAt: trailingEv.createdAt,
                  model: trailingEv.model,
                  inputTokens: trailingEv.inputTokens,
                  cacheReadTokens: trailingEv.cacheReadTokens,
                  totalTokens: trailingEv.totalTokens,
                },
              ];
            }
          }
          break;
        }
      }
      state.lastKnownModel = lastModelRef.value;
    } finally {
      fs.closeSync(fd);
    }
  }

  state.mtimeMs = stat.mtimeMs;
  state.size = stat.size;
  return { state, ephemeralEvents, ephemeralRows };
}

export function resetContextMeterCache() {
  contextMeterCache.clear();
  seenPeakByConv.clear();
  seenDropsByConv.clear();
}

export function resetQuotaCache() {
  quotaCache = null;
  quotaInFlight = null;
  lastQuotaForceMs = 0;
}

function findTranscriptFileForConv(convId, brainDirs = BRAIN_DIRS) {
  if (!CONV_ID_RE.test(convId)) return null;
  const roots = Array.isArray(brainDirs) && brainDirs.length > 0 ? brainDirs : resolveBrainDirs();
  for (const brainRoot of roots) {
    const logsDir = path.join(brainRoot, convId, '.system_generated', 'logs');
    const fullPath = path.join(logsDir, 'transcript_full.jsonl');
    if (fs.existsSync(fullPath)) return fullPath;
    const compactPath = path.join(logsDir, 'transcript.jsonl');
    if (fs.existsSync(compactPath)) return compactPath;
  }
  return null;
}

export function readContextMeter(
  convId,
  { brainDirs = BRAIN_DIRS, transcriptPath = '', bypassCache = false } = {},
) {
  const cleanId = String(convId || '').trim();
  if (!CONV_ID_RE.test(cleanId)) {
    return { ok: false, error: 'Invalid conversation ID' };
  }
  const filePath =
    transcriptPath && fs.existsSync(transcriptPath)
      ? transcriptPath
      : findTranscriptFileForConv(cleanId, brainDirs);
  if (!filePath) {
    return { ok: true, available: false, conversationId: cleanId };
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: true, available: false, conversationId: cleanId };
  }

  const prevState = contextMeterCache.get(cleanId);
  if (
    !bypassCache &&
    prevState &&
    prevState.path === filePath &&
    prevState.mtimeMs === stat.mtimeMs &&
    prevState.size === stat.size &&
    prevState.result
  ) {
    return prevState.result;
  }

  let incremental;
  try {
    incremental = readTranscriptIncremental(filePath, stat, prevState, bypassCache);
  } catch {
    return { ok: true, available: false, conversationId: cleanId };
  }

  const { state, ephemeralEvents, ephemeralRows } = incremental;
  const rawEvents = ephemeralEvents ? [...state.rawEvents, ...ephemeralEvents] : state.rawEvents;
  const rows = ephemeralRows ? [...state.rows, ...ephemeralRows] : state.rows;

  if (rows.length === 0) {
    const emptyRes = { ok: true, available: false, conversationId: cleanId };
    state.result = emptyRes;
    setBoundedMap(contextMeterCache, cleanId, state, MAX_CONTEXT_CACHE_ENTRIES);
    return emptyRes;
  }

  function hasRecentManualCompactBefore(evIdx) {
    // Scan backward to the nearest USER_INPUT with no event-count cap.
    for (let k = evIdx - 1; k >= 0; k -= 1) {
      if (rawEvents[k].isManualCompactCmd) return true;
      if (rawEvents[k].type === 'USER_INPUT') return false;
    }
    return false;
  }

  const drops = [];
  const checkpointEventIndices = [];

  // Primary authoritative signal: scan rawEvents directly for CHECKPOINT (both token-bearing and token-less).
  let rowPtr = 0;
  for (let evIdx = 0; evIdx < rawEvents.length; evIdx += 1) {
    const ev = rawEvents[evIdx];
    while (rowPtr < rows.length && rows[rowPtr].eventIdx < evIdx) {
      rowPtr += 1;
    }
    if (ev.type !== 'CHECKPOINT') continue;
    checkpointEventIndices.push(evIdx);

    const prevTokenRow = rowPtr > 0 ? rows[rowPtr - 1] : null;
    let nextRowIdx = rowPtr;
    while (nextRowIdx < rows.length && rows[nextRowIdx].eventIdx <= evIdx) {
      nextRowIdx += 1;
    }
    const nextTokenRow = nextRowIdx < rows.length ? rows[nextRowIdx] : null;

    // Defer drop until a post-checkpoint token row exists instead of emitting to: 0.
    if (!nextTokenRow) continue;

    const fromTokens = ev.totalTokens > 0 ? ev.totalTokens : prevTokenRow?.totalTokens || 0;
    if (fromTokens <= 0) continue;

    const manual = hasRecentManualCompactBefore(evIdx);
    const dropModel = ev.model || prevTokenRow?.model || nextTokenRow.model || '';
    const fam = getModelFamily(dropModel);
    drops.push({
      at: ev.createdAt || nextTokenRow.createdAt || '',
      from: fromTokens,
      to: nextTokenRow.totalTokens,
      model: dropModel,
      modelFamily: fam,
      kind: manual ? 'manual' : 'auto',
    });
  }

  function hasCheckpointBetween(startEventIdx, endEventIdx) {
    for (const cpIdx of checkpointEventIndices) {
      if (cpIdx > startEventIdx && cpIdx < endEventIdx) return true;
      if (cpIdx >= endEventIdx) break;
    }
    return false;
  }

  let peakTokens = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].totalTokens > peakTokens) peakTokens = rows[i].totalTokens;
    if (i === 0) continue;
    const prevRow = rows[i - 1];
    const curRow = rows[i];
    if (prevRow.type === 'CHECKPOINT' || curRow.type === 'CHECKPOINT') continue;
    if (hasCheckpointBetween(prevRow.eventIdx, curRow.eventIdx)) continue;
    if (
      !isSameModelFamily(prevRow.model, curRow.model) ||
      !(curRow.totalTokens < prevRow.totalTokens * COMPACTION_DROP_RATIO)
    ) {
      continue;
    }

    // Rebound guard: confirm fallback drop only when a subsequent same-family token row stays below threshold.
    let confirmed = false;
    for (let j = i + 1; j < rows.length; j += 1) {
      if (rows[j].type === 'CHECKPOINT') continue;
      if (!isSameModelFamily(prevRow.model, rows[j].model)) continue;
      confirmed = rows[j].totalTokens < prevRow.totalTokens * COMPACTION_DROP_RATIO;
      break;
    }
    if (!confirmed) continue;

    let manual = false;
    for (let k = prevRow.eventIdx + 1; k < curRow.eventIdx; k += 1) {
      if (rawEvents[k].isManualCompactCmd) {
        manual = true;
        break;
      }
    }
    if (!manual) {
      manual = hasRecentManualCompactBefore(prevRow.eventIdx);
    }

    const fam = getModelFamily(prevRow.model);
    drops.push({
      at: curRow.createdAt,
      from: prevRow.totalTokens,
      to: curRow.totalTokens,
      model: prevRow.model || curRow.model || '',
      modelFamily: fam !== 'unknown' ? fam : getModelFamily(curRow.model),
      kind: manual ? 'manual' : 'auto',
    });
  }

  let latest = rows[rows.length - 1];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].type !== 'CHECKPOINT') {
      latest = rows[i];
      break;
    }
  }
  const latestFamily = getModelFamily(latest.model);
  const prevSeen = seenPeakByConv.get(cleanId);
  const coveredByFileDrop =
    prevSeen && drops.some((d) => isTimestampAfter(d.at, prevSeen.updatedAt));
  if (
    prevSeen &&
    !coveredByFileDrop &&
    isSameModelFamily(prevSeen.model, latest.model) &&
    latest.totalTokens < prevSeen.tokens * COMPACTION_DROP_RATIO &&
    !drops.some((d) => d.from === prevSeen.tokens && d.to === latest.totalTokens)
  ) {
    const manual = hasRecentManualCompactBefore(latest.eventIdx);
    const memDrops = [...(seenDropsByConv.get(cleanId) || [])];
    const fam = getModelFamily(prevSeen.model);
    memDrops.push({
      at: latest.createdAt,
      from: prevSeen.tokens,
      to: latest.totalTokens,
      model: prevSeen.model || latest.model || '',
      modelFamily: fam !== 'unknown' ? fam : latestFamily,
      kind: manual ? 'manual' : 'auto',
    });
    setBoundedMap(seenDropsByConv, cleanId, memDrops.slice(-8), MAX_CONTEXT_CACHE_ENTRIES);
  }
  setBoundedMap(
    seenPeakByConv,
    cleanId,
    { tokens: latest.totalTokens, model: latest.model, updatedAt: latest.createdAt },
    MAX_CONTEXT_CACHE_ENTRIES,
  );

  const mergedDrops = [...drops];
  for (const d of seenDropsByConv.get(cleanId) || []) {
    if (!mergedDrops.some((x) => x.from === d.from && x.to === d.to)) {
      mergedDrops.push(d);
    }
  }
  mergedDrops.sort((a, b) => {
    const ta = Date.parse(a.at || '');
    const tb = Date.parse(b.at || '');
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
    return String(a.at || '').localeCompare(String(b.at || ''));
  });

  const autoDrops = mergedDrops.filter((d) => d.kind !== 'manual');
  const dropsByFamily = {};
  for (const d of autoDrops) {
    const fam = d.modelFamily || getModelFamily(d.model);
    dropsByFamily[fam] = d;
  }

  const cacheHitPct =
    latest.totalTokens > 0 ? Math.round((latest.cacheReadTokens / latest.totalTokens) * 100) : 0;
  const familyAutoDrops = autoDrops.filter(
    (d) =>
      !d.modelFamily ||
      d.modelFamily === 'unknown' ||
      latestFamily === 'unknown' ||
      d.modelFamily === latestFamily,
  );
  const lastAutoDrop = familyAutoDrops.length > 0 ? familyAutoDrops[familyAutoDrops.length - 1] : null;
  const lastDrop = mergedDrops.length > 0 ? mergedDrops[mergedDrops.length - 1] : null;

  const result = {
    ok: true,
    available: true,
    conversationId: cleanId,
    totalTokens: latest.totalTokens,
    inputTokens: latest.inputTokens,
    cacheReadTokens: latest.cacheReadTokens,
    cacheHitPct,
    peakTokens,
    model: latest.model,
    modelFamily: latestFamily,
    updatedAt: latest.createdAt,
    samples: rows.length,
    compactionCount: mergedDrops.length,
    autoCompactionCount: autoDrops.length,
    manualCompactionCount: mergedDrops.length - autoDrops.length,
    lastDrop,
    lastAutoDrop,
    dropsByFamily,
  };

  state.result = result;
  setBoundedMap(contextMeterCache, cleanId, state, MAX_CONTEXT_CACHE_ENTRIES);
  return result;
}

function resolveAgyBinary() {
  for (const cand of AGY_BIN_CANDIDATES) {
    if (cand.includes(path.sep) || cand.includes('/')) {
      if (fs.existsSync(cand)) return cand;
    } else {
      return cand;
    }
  }
  return null;
}

export function parseQuotaOutput(rawStdout) {
  const trimmed = String(rawStdout || '').trim();
  if (!trimmed) throw new Error('Empty agy usage output');
  const parsed = JSON.parse(trimmed);
  const rawGroups = Array.isArray(parsed?.command?.data?.groups) ? parsed.command.data.groups : [];
  const groups = [];
  for (const g of rawGroups) {
    const name = String(g?.name || '').trim();
    const lower = name.toLowerCase();
    const key = lower.includes('gemini')
      ? 'gemini'
      : lower.includes('claude') || lower.includes('gpt')
        ? 'claude'
        : lower.replace(/[^a-z0-9]+/g, '-') || 'other';
    const label = key === 'gemini' ? 'Gemini' : key === 'claude' ? 'Claude·GPT' : name || 'Quota';
    const buckets = Array.isArray(g?.buckets) ? g.buckets : [];
    const pickBucket = (win) => {
      const b = buckets.find((item) => String(item?.window || '').toLowerCase() === win);
      if (!b) return null;
      if (
        typeof b.remaining_fraction !== 'number' ||
        !Number.isFinite(b.remaining_fraction) ||
        b.remaining_fraction < 0 ||
        b.remaining_fraction > 1
      ) {
        throw new Error('Invalid remaining_fraction in agy usage bucket');
      }
      const frac = b.remaining_fraction;
      const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
      return {
        id: String(b.id || ''),
        pct,
        remainingFraction: frac,
        resetTime: String(b.reset_time || ''),
        description: String(b.description || ''),
      };
    };
    groups.push({
      key,
      label,
      name,
      fiveHour: pickBucket('5h'),
      weekly: pickBucket('weekly'),
    });
  }
  const hasAnyBucket = groups.some(
    (g) => typeof g.fiveHour?.pct === 'number' || typeof g.weekly?.pct === 'number',
  );
  if (groups.length === 0 || !hasAnyBucket) {
    throw new Error('Unrecognized agy usage schema (no quota buckets)');
  }
  return groups;
}

export async function fetchQuotaSnapshot({
  force = false,
  execFileImpl = execFile,
  agyBinOverride = undefined,
  nowFn = Date.now,
  watchdogMs = QUOTA_WATCHDOG_MS,
} = {}) {
  const now = nowFn();
  if (quotaInFlight) {
    return quotaInFlight;
  }
  if (
    quotaCache &&
    quotaCache.ok &&
    !force &&
    now - quotaCache.fetchedAt < QUOTA_CACHE_TTL_MS &&
    now - quotaCache.fetchedAt <= QUOTA_STALE_MAX_AGE_MS
  ) {
    return { ...quotaCache, cached: true };
  }
  if (
    force &&
    quotaCache &&
    quotaCache.ok &&
    now - quotaCache.fetchedAt <= QUOTA_STALE_MAX_AGE_MS &&
    now - lastQuotaForceMs < QUOTA_FORCE_COOLDOWN_MS
  ) {
    return { ...quotaCache, cached: true, throttled: true };
  }
  if (force) {
    lastQuotaForceMs = now;
  }

  const agyBin = agyBinOverride !== undefined ? agyBinOverride : resolveAgyBinary();
  if (!agyBin) {
    return { ok: false, error: 'agy CLI not found', fetchedAt: now, groups: [] };
  }

  const cleanEnv = sanitizeChildEnv(process.env, { stripAntigravity: true });
  const isWinBatch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(agyBin);
  const execCmd = isWinBatch ? process.env.ComSpec || 'cmd.exe' : agyBin;
  const execArgs = isWinBatch
    ? ['/d', '/s', '/c', agyBin, '-p', '/usage', '--output-format', 'json']
    : ['-p', '/usage', '--output-format', 'json'];

  quotaInFlight = new Promise((resolve) => {
    let settled = false;
    let child = null;
    let watchdogTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
      resolve(result);
    };

    const handleFailure = (err) => {
      const finishedAt = nowFn();
      const errMsg = String(err?.message || 'agy usage failed').slice(0, 160);
      const cacheFreshEnough =
        quotaCache && quotaCache.ok && finishedAt - quotaCache.fetchedAt <= QUOTA_STALE_MAX_AGE_MS;
      if (cacheFreshEnough) {
        finish({ ...quotaCache, cached: true, stale: true, staleError: errMsg });
      } else {
        quotaCache = null;
        finish({ ok: false, staleExpired: true, error: errMsg, fetchedAt: finishedAt, groups: [] });
      }
    };

    watchdogTimer = setTimeout(() => {
      try {
        child?.kill?.('SIGKILL');
      } catch {
        // Ignore kill race.
      }
      handleFailure(new Error('agy usage watchdog timeout'));
    }, watchdogMs);
    watchdogTimer.unref?.();

    try {
      child = execFileImpl(
        execCmd,
        execArgs,
        { encoding: 'utf8', timeout: 25000, windowsHide: true, maxBuffer: 1024 * 1024, env: cleanEnv },
        (err, stdout) => {
          if (settled) return;
          if (err) {
            handleFailure(err);
            return;
          }
          const finishedAt = nowFn();
          try {
            const groups = parseQuotaOutput(stdout);
            const fresh = { ok: true, fetchedAt: finishedAt, cached: false, stale: false, groups };
            quotaCache = fresh;
            finish(fresh);
          } catch (parseErr) {
            // Schema drift or invalid payload: fail closed instead of displaying potentially misleading cached numbers.
            const errMsg = String(parseErr?.message || 'Failed to parse usage JSON').slice(0, 160);
            quotaCache = null;
            finish({ ok: false, schemaError: true, error: errMsg, fetchedAt: finishedAt, groups: [] });
          }
        },
      );
      child?.stdin?.end?.();
    } catch (syncErr) {
      handleFailure(syncErr);
    }
  }).finally(() => {
    quotaInFlight = null;
  });

  return quotaInFlight;
}

const HEARTBEAT_WRITE_MIN_INTERVAL_MS = 2000;
let lastHeartbeatWriteMs = 0;

function writeSidecarHeartbeat(heartbeatPath = SIDECAR_VIEWER_HEARTBEAT_PATH, force = false) {
  const now = Date.now();
  if (!force && now - lastHeartbeatWriteMs < HEARTBEAT_WRITE_MIN_INTERVAL_MS) return;
  lastHeartbeatWriteMs = now;
  try {
    atomicWriteSync(
      heartbeatPath,
      JSON.stringify({ updatedAt: now, pid: process.pid, app: 'agy-suite-hud-sidecar' }),
      { mode: 0o600 },
    );
  } catch {
    // Ignore transient heartbeat write failures.
  }
}

function clearSidecarHeartbeat(heartbeatPath = SIDECAR_VIEWER_HEARTBEAT_PATH) {
  try {
    if (!fs.existsSync(heartbeatPath)) return;
    const raw = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8'));
    if (Number(raw?.pid) === process.pid) {
      fs.unlinkSync(heartbeatPath);
    }
  } catch {
    // Ignore cleanup race.
  }
}

function readStaticText(filename) {
  return fs.readFileSync(path.join(__dirname, filename), 'utf8');
}

function slimTurnMeta(turn) {
  if (!turn || typeof turn !== 'object') return null;
  return {
    turnIndex: turn.turnIndex,
    turnNumber: turn.turnNumber,
    totalTurns: turn.totalTurns,
    userStepIndex: turn.userStepIndex,
    userSummary: turn.userSummary || '',
    lastTimestampIso: turn.lastTimestampIso || '',
    timeFormatted: turn.timeFormatted || '',
    isComplete: Boolean(turn.isComplete),
    status: turn.status || (turn.isComplete ? 'complete' : 'thinking'),
    stepCount: Number(turn.stepCount) || 0,
    needsRestoreCount: Number(turn.needsRestoreCount) || 0,
    steps: [],
  };
}

function stripUnusedReply(turn) {
  if (!turn || typeof turn !== 'object') return turn;
  const { finalReply: _ignored, ...rest } = turn;
  return rest;
}

export function slimPaneStatePayload(rawState, requestedSelectedId = '') {
  if (!rawState || typeof rawState !== 'object' || !Array.isArray(rawState.sessions)) {
    return rawState;
  }
  const sessions = rawState.sessions;
  const visible = sessions.filter((s) => !s.isDismissed);
  const pool = visible.length > 0 ? visible : sessions;

  let keepMainId = '';
  if (requestedSelectedId) {
    const exact = sessions.find((s) => s.conversationId === requestedSelectedId);
    if (exact) {
      keepMainId = exact.conversationId;
    } else {
      for (const s of sessions) {
        if ((s.swarmWorkers || []).some((w) => w.conversationId === requestedSelectedId)) {
          keepMainId = s.conversationId;
          break;
        }
      }
    }
  }
  if (!keepMainId) {
    const fallback = pool.find((s) => s.isActive) || pool[0];
    keepMainId = fallback?.conversationId || '';
  }

  const slimmedSessions = sessions.map((s) => {
    if (s.conversationId === keepMainId) {
      return {
        ...s,
        latestTurn: stripUnusedReply(s.latestTurn),
        swarmWorkers: (s.swarmWorkers || []).map((w) => ({
          ...w,
          latestTurn: stripUnusedReply(w.latestTurn),
        })),
      };
    }
    return {
      conversationId: s.conversationId,
      shortId: s.shortId,
      slot: s.slot,
      sessionTopic: s.sessionTopic,
      lastActivityMs: s.lastActivityMs,
      ageMinutes: s.ageMinutes,
      isActive: s.isActive,
      isPinned: s.isPinned,
      isDismissed: s.isDismissed,
      totalTurns: s.totalTurns,
      latestTurn: slimTurnMeta(s.latestTurn),
      swarmWorkers: (s.swarmWorkers || []).map((w) => ({
        conversationId: w.conversationId,
        shortId: w.shortId,
        workerName: w.workerName,
        displayLabel: w.displayLabel,
        parentConvId: w.parentConvId,
        lastActivityMs: w.lastActivityMs,
        totalTurns: w.totalTurns,
        latestTurn: slimTurnMeta(w.latestTurn),
      })),
    };
  });

  const baseEtag = String(rawState.etag || '');
  return {
    ...rawState,
    selectedMainConvId: keepMainId,
    etag: baseEtag ? `${baseEtag}|sel:${keepMainId}` : '',
    sessions: slimmedSessions,
  };
}

export async function startSidecar() {
  const { SidecarApp, Response } = await import('sidecar_sdk');

  const internalRoom = createControlRoomServer({
    port: 0,
    writeDaemonFile: false,
    enableFsWatch: false,
  });

  const bridgeInfo = await internalRoom.start();
  const bridgeBase = `http://127.0.0.1:${bridgeInfo.port}`;

  async function proxyBridge(method, routePath, bodyObj = null) {
    const headers = {
      Host: `127.0.0.1:${bridgeInfo.port}`,
      'X-Thoughts-Token': bridgeInfo.bridgeToken,
      'X-Room-Token': bridgeInfo.csrfToken,
    };
    const init = { method, headers };
    if (method !== 'GET' && bodyObj !== null) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(bodyObj);
    }
    const res = await fetch(`${bridgeBase}${routePath}`, init);
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { ok: false, error: text || 'Invalid bridge response' };
    }
    if (!res.ok) {
      return new Response(JSON.stringify(parsed), {
        status: res.status,
        contentType: 'application/json; charset=utf-8',
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    return parsed;
  }

  const app = new SidecarApp();

  app.page('/', () =>
    new Response(readStaticText('index.html'), {
      contentType: 'text/html; charset=utf-8',
      headers: { 'Cache-Control': 'no-store' },
    }),
  );

  app.api(
    '/styles.css',
    () =>
      new Response(readStaticText('styles.css'), {
        contentType: 'text/css; charset=utf-8',
        headers: { 'Cache-Control': 'no-store' },
      }),
    'GET',
  );

  app.api(
    '/app.js',
    () =>
      new Response(readStaticText('app.js'), {
        contentType: 'application/javascript; charset=utf-8',
        headers: { 'Cache-Control': 'no-store' },
      }),
    'GET',
  );

  app.api(
    '/api/pane-state',
    async (data) => {
      const visible = data.visible === '1' || data.visible === 'true';
      const convId = String(data.conversationId || app.config.conversationId || '').trim();
      const selectedId = String(data.selectedConvId || convId || '').trim();
      const rawEtag = String(data.etag || '').trim();
      let bridgeEtag = rawEtag;
      if (rawEtag.includes('|sel:')) {
        const [basePart, selPart] = rawEtag.split('|sel:');
        bridgeEtag = selPart === selectedId ? basePart : '';
      }
      if (visible) {
        writeSidecarHeartbeat();
      }
      const qs = new URLSearchParams();
      if (visible) qs.set('viewerActive', '1');
      if (selectedId) qs.set('focusConvId', selectedId);
      if (bridgeEtag) qs.set('etag', bridgeEtag);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const result = await proxyBridge('GET', `/api/state${suffix}`);
      if (result instanceof Response) return result;
      if (result?.unchanged) {
        return { ...result, etag: rawEtag };
      }
      return slimPaneStatePayload(result, selectedId);
    },
    'GET',
  );

  app.api(
    '/api/turn',
    async (data) => {
      const qs = new URLSearchParams();
      const conv = data.conv || data.conversationId || '';
      const idx = data.index !== undefined && data.index !== '' ? data.index : data.turnIndex;
      const step = data.userStep !== undefined && data.userStep !== '' ? data.userStep : data.userStepIndex;
      if (conv) qs.set('conv', String(conv));
      if (idx !== undefined && idx !== '') qs.set('index', String(idx));
      if (step !== undefined && step !== '') qs.set('userStep', String(step));
      return proxyBridge('GET', `/api/turn?${qs.toString()}`);
    },
    'GET',
  );

  app.api('/api/restore-turn', async (data) => {
    writeSidecarHeartbeat(SIDECAR_VIEWER_HEARTBEAT_PATH, true);
    return proxyBridge('POST', '/api/restore-turn', {
      conversationId: data.conversationId || '',
      turnIndex: data.turnIndex,
      userStepIndex: data.userStepIndex,
    });
  });

  app.api('/api/select-worker', async (data) => {
    writeSidecarHeartbeat();
    return proxyBridge('POST', '/api/select-worker', {
      conversationId: data.conversationId || '',
      parentConvId: data.parentConvId || '',
    });
  });

  app.api('/api/settings', async () => proxyBridge('GET', '/api/settings'), 'GET');

  app.api('/api/settings', async (data) => proxyBridge('POST', '/api/settings', data || {}));

  app.api('/api/test-key', async (data) => proxyBridge('POST', '/api/test-key', data || {}));

  app.api(
    '/api/context-meter',
    (data) => {
      const convId = String(data.conversationId || app.config.conversationId || '').trim();
      return readContextMeter(convId);
    },
    'GET',
  );

  app.api(
    '/api/quota',
    async (data) => {
      const force = data.force === '1' || data.force === 'true';
      return fetchQuotaSnapshot({ force });
    },
    'GET',
  );

  let shuttingDown = false;
  async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearSidecarHeartbeat();
    try {
      await internalRoom.stop();
    } catch {
      // Ignore close errors.
    }
    try {
      await app.close();
    } catch {
      // Ignore close errors.
    }
    if (code !== null) process.exit(code);
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('exit', () => clearSidecarHeartbeat());

  await app.run();
  console.log(`[hud_pane] internal bridge ready on 127.0.0.1:${bridgeInfo.port}`);

  // Local-only bridge warm-up (zero network egress until the pane requests /api/quota).
  setTimeout(() => {
    proxyBridge('GET', '/api/state').catch(() => {});
  }, 250).unref?.();
}

function resolveRealPathLower(targetPath) {
  if (!targetPath) return '';
  try {
    return fs.realpathSync(targetPath).toLowerCase();
  } catch {
    return path.resolve(targetPath).toLowerCase();
  }
}

const isDirectMain =
  Boolean(process.argv[1]) &&
  resolveRealPathLower(process.argv[1]) === resolveRealPathLower(SCRIPT_PATH);

if (isDirectMain) {
  await startSidecar();
}
