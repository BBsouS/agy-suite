import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALLOWED_MODES,
  ALLOWED_PRESET_IDS,
  CONTROL_ROOM_APP_ID,
  CONV_ID_REGEX,
  DEFAULT_MODELS,
  DEFAULT_SETTINGS,
  FILE_PREFIX,
  MAX_MODELS,
  MODEL_NAME_REGEX,
  TARGET_LANG_REGEX,
  buildSystemPrompt,
  getDataPaths,
  resolveBrainDirs,
  resolveControlRoomPort,
  resolveDataDir,
} from './constants.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const BRAIN_DIRS = resolveBrainDirs();
export const SIDECAR_VIEWER_HEARTBEAT_PATH = getDataPaths().sidecarViewerHeartbeatPath;
export const SIDECAR_VIEWER_TTL_MS = 18 * 1000;

export const MAX_TAIL_BYTES = 4 * 1024 * 1024;
export const BACKWARD_SCAN_CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_BACKWARD_SCAN_BYTES = 16 * 1024 * 1024;
export const MAX_FOUND_TURN_SLICE_BYTES = 8 * 1024 * 1024;
export const FIRST_TOPIC_HEAD_BYTES = 64 * 1024;
export const HEAD_HASH_SAMPLE_BYTES = 512;
export const MAX_CACHE_ENTRIES = 2000;
export const MAX_NEG_CACHE_ENTRIES = 200;
export const LONG_THOUGHT_CHUNK_CHARS = 5500;
export const MAX_SLOTS = 4;
export const ACTIVE_SESSION_WINDOW_MS = 30 * 60 * 1000;
export const IDLE_SESSION_RETENTION_MS = 6 * 60 * 60 * 1000;
export const RUNNING_PROTECT_MS = 2 * 60 * 1000;
export const WORKER_STALE_LOCK_MS = 90 * 1000;
export const SHORT_STALE_LOCK_MS = 8 * 1000;
export const STALE_TEMP_MAX_AGE_MS = 5 * 60 * 1000;
export const STDIN_READ_TIMEOUT_MS = 2500;

export const SAFETY_SETTINGS_BLOCK_NONE = Object.freeze([
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
]);

// 5 known few-shot boilerplate leak patterns emitted by upstream reasoning summaries.
const LEAKED_BOILERPLATE_PREFIX_PATTERNS = [
  /^(?:[-*]\s+)?Thinking Process:\s*/i,
  /^(?:[-*]\s+)?I['’]m thinking through how to approach this\.?\s*/i,
  /^(?:[-*]\s+)?Initial (?:suspicion|hypothesis) was a cache miss,\s*but traces show database latency is the actual bottleneck\.\s*/i,
  /^(?:[-*]\s+)?The error points to the handler where the port binding is mismatched\.\s*/i,
  /^(?:[-*]\s+)?Checking if updating the port resolves the failure\.\s*/i,
];

const STANDALONE_BOILERPLATE_LINE_PATTERNS = [
  /^(?:[-*]\s+)?Thinking Process:$/i,
  /^(?:[-*]\s+)?I['’]m thinking through how to approach this\.?$/i,
  /^(?:[-*]\s+)?Initial (?:suspicion|hypothesis) was a cache miss,\s*but traces show database latency is the actual bottleneck\.$/i,
  /^(?:[-*]\s+)?The error points to the handler where the port binding is mismatched\.$/i,
  /^(?:[-*]\s+)?Checking if updating the port resolves the failure\.$/i,
];

const RETRYABLE_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function syncSleepMs(ms) {
  if (ms <= 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Fallback spin if SharedArrayBuffer is unavailable.
    }
  }
}

export function atomicWriteSync(
  filePath,
  content,
  { mode = 0o600, onlyIfChanged = false, maxRetries = 5 } = {},
) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (onlyIfChanged) {
    try {
      if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content) {
        return false;
      }
    } catch {
      // Proceed with overwrite if existing file cannot be read.
    }
  }

  const rand = crypto.randomBytes(6).toString('hex');
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${rand}`;
  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode });
    if (process.platform !== 'win32' && mode) {
      try {
        fs.chmodSync(tempPath, mode);
      } catch {
        // Ignore chmod failure on restricted filesystems.
      }
    }

    let lastErr = null;
    const attempts = Math.max(1, maxRetries);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        fs.renameSync(tempPath, filePath);
        return true;
      } catch (err) {
        lastErr = err;
        if (!RETRYABLE_FS_CODES.has(err?.code) || attempt === attempts - 1) {
          throw err;
        }
        syncSleepMs(15 * (2 ** attempt));
      }
    }
    throw lastErr;
  } finally {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup race if already renamed or unlinked.
    }
  }
}

export function purgeStaleTempFiles(dirPath = resolveDataDir(), maxAgeMs = STALE_TEMP_MAX_AGE_MS) {
  try {
    if (!fs.existsSync(dirPath)) return 0;
    const now = Date.now();
    let removed = 0;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (
        !entry.name.startsWith(FILE_PREFIX) &&
        !entry.name.startsWith('settings.json') &&
        !entry.name.startsWith('secrets.json')
      ) {
        continue;
      }
      if (!entry.name.includes('.tmp-') && !entry.name.includes('.stale-')) continue;
      const fullPath = path.join(dirPath, entry.name);
      try {
        const st = fs.statSync(fullPath);
        if (now - st.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fullPath);
          removed += 1;
        }
      } catch {
        // Ignore race with concurrent unlink.
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

export function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

export function isValidModelName(name) {
  return typeof name === 'string' && MODEL_NAME_REGEX.test(name.trim());
}

export function formatTimestamp(isoString, timeZone = DEFAULT_SETTINGS.timezone) {
  if (!isoString) return '-';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return String(isoString);
  const safeTz = isValidTimezone(timeZone) ? timeZone.trim() : 'UTC';
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: safeTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

export function formatTimeOnly(isoString, timeZone = DEFAULT_SETTINGS.timezone) {
  const full = formatTimestamp(isoString, timeZone);
  const match = full.match(/\d{2}:\d{2}:\d{2}$/);
  return match ? match[0] : full;
}

export function hashText(text, prefix = '') {
  return `${prefix}${crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 24)}`;
}

export function maskApiKey(apiKey) {
  const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!trimmed) return '';
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}****`;
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export function normalizeSettings(raw) {
  const base = {
    version: 1,
    mode: DEFAULT_SETTINGS.mode,
    targetLang: DEFAULT_SETTINGS.targetLang,
    models: [...DEFAULT_MODELS],
    presetId: DEFAULT_SETTINGS.presetId,
    customPrompt: '',
    timezone: DEFAULT_SETTINGS.timezone,
    settingsRevision: 1,
  };
  if (!raw || typeof raw !== 'object') {
    return base;
  }

  if (typeof raw.mode === 'string' && ALLOWED_MODES.includes(raw.mode)) {
    base.mode = raw.mode;
  }
  if (typeof raw.targetLang === 'string' && TARGET_LANG_REGEX.test(raw.targetLang.trim())) {
    base.targetLang = raw.targetLang.trim();
  }
  if (Array.isArray(raw.models)) {
    const valid = [];
    const seen = new Set();
    for (const item of raw.models) {
      const m = typeof item === 'string' ? item.trim() : '';
      if (!m || !isValidModelName(m) || seen.has(m)) continue;
      seen.add(m);
      valid.push(m);
      if (valid.length >= MAX_MODELS) break;
    }
    if (valid.length > 0) {
      base.models = valid;
    }
  }
  if (typeof raw.presetId === 'string' && ALLOWED_PRESET_IDS.includes(raw.presetId)) {
    base.presetId = raw.presetId;
  }
  if (typeof raw.customPrompt === 'string') {
    base.customPrompt = raw.customPrompt.slice(0, 4000);
  }
  if (typeof raw.timezone === 'string' && isValidTimezone(raw.timezone)) {
    base.timezone = raw.timezone.trim();
  }
  if (Number.isInteger(raw.settingsRevision) && raw.settingsRevision >= 1) {
    base.settingsRevision = raw.settingsRevision;
  }
  return base;
}

export function validateSettingsPatch(patch, currentSettings) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'Invalid settings payload' };
  }
  const next = normalizeSettings(currentSettings);

  if (patch.mode !== undefined) {
    if (typeof patch.mode !== 'string' || !ALLOWED_MODES.includes(patch.mode)) {
      return { ok: false, error: 'Invalid restoration mode' };
    }
    next.mode = patch.mode;
  }

  if (patch.targetLang !== undefined) {
    const lang = typeof patch.targetLang === 'string' ? patch.targetLang.trim() : '';
    if (!lang || !TARGET_LANG_REGEX.test(lang)) {
      return { ok: false, error: 'Invalid target language code' };
    }
    next.targetLang = lang;
  }

  if (patch.models !== undefined) {
    if (!Array.isArray(patch.models) || patch.models.length === 0 || patch.models.length > MAX_MODELS) {
      return { ok: false, error: `Models must be a list of 1 to ${MAX_MODELS} valid model IDs` };
    }
    const cleaned = [];
    const seen = new Set();
    for (const rawModel of patch.models) {
      const m = typeof rawModel === 'string' ? rawModel.trim() : '';
      if (!m || !isValidModelName(m)) {
        return { ok: false, error: `Invalid model identifier: ${String(rawModel).slice(0, 40)}` };
      }
      if (!seen.has(m)) {
        seen.add(m);
        cleaned.push(m);
      }
    }
    if (cleaned.length === 0) {
      return { ok: false, error: 'At least one valid model is required' };
    }
    next.models = cleaned;
  }

  if (patch.presetId !== undefined) {
    if (typeof patch.presetId !== 'string' || !ALLOWED_PRESET_IDS.includes(patch.presetId)) {
      return { ok: false, error: 'Invalid prompt preset' };
    }
    next.presetId = patch.presetId;
  }

  if (patch.customPrompt !== undefined) {
    if (typeof patch.customPrompt !== 'string') {
      return { ok: false, error: 'Custom prompt must be a string' };
    }
    if (patch.customPrompt.length > 4000) {
      return { ok: false, error: 'Custom prompt exceeds 4000 characters' };
    }
    next.customPrompt = patch.customPrompt;
  }

  if (patch.timezone !== undefined) {
    const tz = typeof patch.timezone === 'string' ? patch.timezone.trim() : '';
    if (!isValidTimezone(tz)) {
      return { ok: false, error: 'Invalid IANA timezone' };
    }
    next.timezone = tz;
  }

  return { ok: true, settings: next };
}

export function loadSettings(dataDir = resolveDataDir()) {
  const { settingsPath } = getDataPaths(dataDir);
  try {
    if (!fs.existsSync(settingsPath)) {
      return normalizeSettings(null);
    }
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return normalizeSettings(parsed);
  } catch {
    return normalizeSettings(null);
  }
}

export function saveSettings(nextSettings, dataDir = resolveDataDir(), { bumpRevision = true } = {}) {
  const { settingsPath } = getDataPaths(dataDir);
  const current = loadSettings(dataDir);
  const normalized = normalizeSettings(nextSettings);
  if (bumpRevision) {
    normalized.settingsRevision = Math.max(current.settingsRevision, normalized.settingsRevision) + 1;
  }
  atomicWriteSync(settingsPath, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  return normalized;
}

// Dedicated plugin-scoped secrets storage ONLY. Never reads ambient GEMINI_API_KEY env vars.
export function loadSecrets(dataDir = resolveDataDir()) {
  const { secretsPath } = getDataPaths(dataDir);
  try {
    if (!fs.existsSync(secretsPath)) {
      return { geminiApiKey: '' };
    }
    const parsed = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
    const key = typeof parsed?.geminiApiKey === 'string' ? parsed.geminiApiKey.trim() : '';
    return { geminiApiKey: key };
  } catch {
    return { geminiApiKey: '' };
  }
}

export function saveSecrets(secrets, dataDir = resolveDataDir()) {
  const { secretsPath } = getDataPaths(dataDir);
  const key = typeof secrets?.geminiApiKey === 'string' ? secrets.geminiApiKey.trim() : '';
  const payload = { version: 1, geminiApiKey: key };
  atomicWriteSync(secretsPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return { geminiApiKey: key };
}

export function computeProfileHash(settings) {
  const norm = normalizeSettings(settings);
  const primaryModel = norm.mode === 'gemini' ? norm.models[0] || DEFAULT_MODELS[0] : '';
  const presetId = norm.mode === 'gemini' ? norm.presetId : '';
  const customPromptHash =
    norm.mode === 'gemini' && norm.presetId === 'custom'
      ? hashText(norm.customPrompt.trim())
      : '';
  const signature = [norm.mode, norm.targetLang, presetId, customPromptHash, primaryModel].join('|');
  return crypto.createHash('sha256').update(signature, 'utf8').digest('hex').slice(0, 16);
}

export function buildStepCacheKey(enText, settings) {
  const profileHash = computeProfileHash(settings);
  const stepHash = hashText(enText);
  return `v1:${profileHash}:${stepHash}`;
}

export function cleanUserInput(rawContent) {
  if (typeof rawContent !== 'string' || !rawContent.trim()) {
    return '(empty)';
  }
  const reqMatch = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  if (reqMatch) {
    return reqMatch[1].trim() || '(attachment or empty input)';
  }
  return (
    rawContent
      .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
      .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
      .trim() || '(empty)'
  );
}

export function summarizeOneLine(text, maxLen = 44) {
  if (typeof text !== 'string') return '(empty)';
  const single = text.replace(/\s+/g, ' ').trim();
  if (!single) return '(empty)';
  if (single.length <= maxLen) return single;
  return `${single.slice(0, maxLen).trimEnd()}…`;
}

function stripBoilerplatePrefixChain(input) {
  let cur = input.trimStart();
  let changed = true;
  while (changed && cur.length > 0) {
    changed = false;
    for (const rx of LEAKED_BOILERPLATE_PREFIX_PATTERNS) {
      const m = cur.match(rx);
      if (m && m[0].length > 0) {
        cur = cur.slice(m[0].length).trimStart();
        changed = true;
        break;
      }
    }
  }
  return cur;
}

export function cleanThinkingParagraphs(rawThinking) {
  if (typeof rawThinking !== 'string') return [];
  const normalized = rawThinking.replace(/\x00/g, '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const rawParagraphs = normalized.split(/\n{2,}/);
  const cleaned = [];

  for (const rawPara of rawParagraphs) {
    const keptLines = [];
    let inFence = false;

    for (const rawLine of rawPara.split('\n')) {
      const trimmedLine = rawLine.trim();
      if (/^```/.test(trimmedLine)) {
        inFence = !inFence;
        keptLines.push(rawLine);
        continue;
      }
      if (inFence) {
        keptLines.push(rawLine);
        continue;
      }
      if (!trimmedLine) continue;

      if (STANDALONE_BOILERPLATE_LINE_PATTERNS.some((rx) => rx.test(trimmedLine))) {
        continue;
      }

      const stripped = stripBoilerplatePrefixChain(trimmedLine);
      if (!stripped) {
        continue;
      }
      keptLines.push(stripped !== trimmedLine ? stripped : rawLine);
    }

    if (keptLines.length === 0) continue;
    const joined = stripBoilerplatePrefixChain(keptLines.join('\n')).trim();
    if (joined) {
      cleaned.push(joined);
    }
  }

  return cleaned;
}

function sanitizeLockKey(id) {
  const cleaned = String(id || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36);
  return cleaned || 'default';
}

export function getWorkerLockPath(conversationId, dataDir = resolveDataDir()) {
  return path.join(dataDir, `${FILE_PREFIX}-worker-${sanitizeLockKey(conversationId)}.lock`);
}

export function getWorkerDirtyPath(conversationId, dataDir = resolveDataDir()) {
  return path.join(dataDir, `${FILE_PREFIX}-worker-${sanitizeLockKey(conversationId)}.dirty`);
}

export function markWorkerDirty(dirtyPath, meta = {}) {
  try {
    atomicWriteSync(dirtyPath, JSON.stringify({ updatedAt: Date.now(), ...meta }), {
      mode: 0o600,
      maxRetries: 3,
    });
  } catch {
    // Ignore dirty marker write errors in restricted environments.
  }
}

export function consumeWorkerDirty(dirtyPath) {
  try {
    if (!fs.existsSync(dirtyPath)) return false;
    const trash = `${dirtyPath}.stale-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    try {
      fs.renameSync(dirtyPath, trash);
      try {
        fs.unlinkSync(trash);
      } catch {
        // Ignore trash unlink error.
      }
      return true;
    } catch {
      if (fs.existsSync(dirtyPath)) {
        fs.unlinkSync(dirtyPath);
        return true;
      }
      return false;
    }
  } catch {
    return false;
  }
}

export function loadCircuitBreakerState(cbPath) {
  try {
    if (!fs.existsSync(cbPath)) {
      return { keys: {}, models: {}, steps: {}, incompatibleThinking: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(cbPath, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      return {
        keys: parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {},
        models: parsed.models && typeof parsed.models === 'object' ? parsed.models : {},
        steps: parsed.steps && typeof parsed.steps === 'object' ? parsed.steps : {},
        incompatibleThinking:
          parsed.incompatibleThinking && typeof parsed.incompatibleThinking === 'object'
            ? parsed.incompatibleThinking
            : {},
      };
    }
  } catch {
    // Ignore corrupt circuit breaker file.
  }
  return { keys: {}, models: {}, steps: {}, incompatibleThinking: {} };
}

export function saveCircuitBreakerState(cbState, cbPath) {
  try {
    const now = Date.now();
    const pruneTimed = (obj, limit = 200) => {
      const entries = Object.entries(obj || {}).filter(
        ([, v]) => v && typeof v.untilMs === 'number' && v.untilMs > now,
      );
      return Object.fromEntries(entries.slice(-limit));
    };
    const cleaned = {
      keys: pruneTimed(cbState.keys, 32),
      models: pruneTimed(cbState.models, 32),
      steps: pruneTimed(cbState.steps, 300),
      incompatibleThinking: pruneTimed(cbState.incompatibleThinking, 64),
    };
    atomicWriteSync(cbPath, JSON.stringify(cleaned), { mode: 0o600, maxRetries: 3 });
  } catch {
    // Ignore circuit breaker persistence errors.
  }
}

function parseRetryAfterMs(headerVal) {
  if (!headerVal) return 0;
  const secs = Number(headerVal);
  if (Number.isFinite(secs) && secs > 0) {
    return Math.min(300_000, Math.max(5_000, Math.round(secs * 1000)));
  }
  return 0;
}

export function loadTranslationCache(cachePath) {
  try {
    if (!fs.existsSync(cachePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveTranslationCache(cacheObj, cachePath, touchedKeys = []) {
  const lockPath = path.join(path.dirname(cachePath), `${FILE_PREFIX}-cache.lock`);
  await withLock(
    lockPath,
    async () => {
      try {
        const latestDisk = loadTranslationCache(cachePath);
        const merged = { ...latestDisk };
        for (const k of touchedKeys) {
          if (Object.prototype.hasOwnProperty.call(merged, k)) {
            const val = merged[k];
            delete merged[k];
            merged[k] = val;
          }
        }
        for (const [k, v] of Object.entries(cacheObj)) {
          delete merged[k];
          merged[k] = v;
        }
        const keys = Object.keys(merged);
        let trimmed = merged;
        if (keys.length > MAX_CACHE_ENTRIES) {
          trimmed = {};
          for (const k of keys.slice(keys.length - MAX_CACHE_ENTRIES)) {
            trimmed[k] = merged[k];
          }
        }
        atomicWriteSync(cachePath, JSON.stringify(trimmed), { mode: 0o600 });
      } catch {
        // Ignore cache write errors.
      }
    },
    { maxWaitMs: 3000, staleMs: SHORT_STALE_LOCK_MS, retryMs: 40 },
  );
}

function stripOuterMarkdownFence(text) {
  const trimmed = String(text || '').trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  return match ? match[1].trim() : trimmed;
}

function isLikelyHeadingText(inner) {
  const plain = String(inner || '')
    .replace(/`/g, '')
    .trim();
  if (!plain || plain.length > 90) return false;
  if (/[.?!。]$/.test(plain)) return false;
  if (/[.?!]\s+\S/.test(plain)) return false;
  return true;
}

export function sanitizeRestoredMonologue(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  const blocks = normalized.split(/\n{2,}/);
  const cleaned = blocks.map((rawBlock) => {
    const trimmed = rawBlock.trim();
    if (!trimmed || trimmed.startsWith('```')) return rawBlock;
    const lines = trimmed.split('\n').map((line) => {
      const t = line.trim();
      const m = t.match(/^\*\*([^*]+)\*\*$/);
      if (m && !isLikelyHeadingText(m[1])) {
        return m[1].trim();
      }
      return line;
    });
    return lines.join('\n');
  });
  return cleaned.join('\n\n').trim();
}

export function splitLongThoughtForGemini(text, maxChars = LONG_THOUGHT_CHUNK_CHARS) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized || normalized.length <= maxChars) {
    return normalized ? [normalized] : [];
  }

  const rawParagraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const pieces = [];

  for (const para of rawParagraphs) {
    if (para.length <= maxChars) {
      pieces.push(para);
      continue;
    }
    const lines = para.split('\n');
    let lineBuf = '';
    for (const line of lines) {
      if (line.length > maxChars) {
        if (lineBuf) {
          pieces.push(lineBuf);
          lineBuf = '';
        }
        const sentences = line.split(/(?<=[.?!])\s+/);
        let sentBuf = '';
        for (const sent of sentences) {
          if (sent.length > maxChars) {
            if (sentBuf) {
              pieces.push(sentBuf);
              sentBuf = '';
            }
            for (let i = 0; i < sent.length; i += maxChars) {
              pieces.push(sent.slice(i, i + maxChars));
            }
          } else if (!sentBuf) {
            sentBuf = sent;
          } else if (sentBuf.length + 1 + sent.length <= maxChars) {
            sentBuf += ` ${sent}`;
          } else {
            pieces.push(sentBuf);
            sentBuf = sent;
          }
        }
        if (sentBuf) pieces.push(sentBuf);
      } else if (!lineBuf) {
        lineBuf = line;
      } else if (lineBuf.length + 1 + line.length <= maxChars) {
        lineBuf += `\n${line}`;
      } else {
        pieces.push(lineBuf);
        lineBuf = line;
      }
    }
    if (lineBuf) pieces.push(lineBuf);
  }

  const chunks = [];
  let cur = '';
  for (const piece of pieces) {
    if (!cur) {
      cur = piece;
    } else if (cur.length + 2 + piece.length <= maxChars) {
      cur += `\n\n${piece}`;
    } else {
      chunks.push(cur);
      cur = piece;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function modelSupportsThinkingLevel(model) {
  return /^gemini-(?:[3-9]|\d{2,})(?:\.|-|$)/i.test(String(model || '').trim());
}

function buildGeminiRequestBody({ systemPrompt, userPrompt, includeThinkingLevel, includeSafetySettings }) {
  const generationConfig = { temperature: 0.2 };
  if (includeThinkingLevel) {
    generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
  }
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig,
  };
  if (includeSafetySettings) {
    body.safetySettings = SAFETY_SETTINGS_BLOCK_NONE;
  }
  return body;
}

export async function restoreStepWithGemini(
  enText,
  {
    apiKey,
    settings = DEFAULT_SETTINGS,
    userHint = '',
    timeoutMs = 25000,
    cbState = null,
    cbDirtyRef = null,
    manualTrigger = false,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  if (!apiKey) {
    throw new Error('Missing Gemini API key');
  }
  const norm = normalizeSettings(settings);
  const keyHash = hashText(apiKey, 'key:');
  const now = Date.now();
  if (!manualTrigger && cbState?.keys?.[keyHash]?.untilMs > now) {
    throw new Error('Gemini API key temporarily paused by circuit breaker');
  }

  const systemPrompt = buildSystemPrompt(norm.presetId, norm.targetLang, norm.customPrompt);
  const compactHint = typeof userHint === 'string' ? userHint.trim().slice(0, 320) : '';

  const restoreChunk = async (chunkText) => {
    const userPrompt = compactHint
      ? `[Context for pronoun resolution only — do not answer or add commentary]\n${compactHint}\n\n[Source reasoning summary]\n${chunkText}`
      : `[Source reasoning summary]\n${chunkText}`;
    const effectiveTimeoutMs = Math.min(
      60_000,
      Math.max(timeoutMs, 20_000 + Math.ceil(chunkText.length / 300) * 1000),
    );

    let lastErr = null;
    for (const rawModel of norm.models) {
      const model = String(rawModel || '').trim();
      if (!isValidModelName(model)) continue;

      const modelEntry = cbState?.models?.[model];
      if (modelEntry && modelEntry.untilMs > Date.now()) {
        if (!manualTrigger || modelEntry.status === 429) {
          lastErr = new Error(`Model ${model} in cooldown (${modelEntry.status})`);
          continue;
        }
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const cachedIncompatible = cbState?.incompatibleThinking?.[model]?.untilMs > Date.now();
      const wantThinkingLevel = modelSupportsThinkingLevel(model) && !cachedIncompatible;

      const invokeOnce = async ({ includeThinkingLevel, includeSafetySettings }) => {
        const body = buildGeminiRequestBody({
          systemPrompt,
          userPrompt,
          includeThinkingLevel,
          includeSafetySettings,
        });
        return fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(effectiveTimeoutMs),
        });
      };

      try {
        let res = await invokeOnce({
          includeThinkingLevel: wantThinkingLevel,
          includeSafetySettings: !cachedIncompatible,
        });

        // Critical 3: On HTTP 400, retry once with a minimal pure body (no thinkingConfig/safetySettings) and cache incompatibility.
        if (res.status === 400 && (wantThinkingLevel || !cachedIncompatible)) {
          await res.body?.cancel?.().catch(() => {});
          res = await invokeOnce({
            includeThinkingLevel: false,
            includeSafetySettings: false,
          });
          if (res.ok && cbState) {
            cbState.incompatibleThinking[model] = { untilMs: Date.now() + 24 * 60 * 60 * 1000 };
            if (cbDirtyRef) cbDirtyRef.dirty = true;
          }
        }

        if (!res.ok) {
          const retryAfterMs = parseRetryAfterMs(res.headers?.get?.('retry-after'));
          await res.body?.cancel?.().catch(() => {});
          if (cbState) {
            const ts = Date.now();
            if (res.status === 401 || res.status === 403) {
              cbState.keys[keyHash] = { status: res.status, untilMs: ts + 10 * 60 * 1000 };
              if (cbDirtyRef) cbDirtyRef.dirty = true;
              throw new Error(`Gemini HTTP ${res.status} (${model})`);
            }
            if (res.status === 404) {
              cbState.models[model] = { status: 404, failCount: 1, untilMs: ts + 15 * 60 * 1000 };
              if (cbDirtyRef) cbDirtyRef.dirty = true;
            } else if (res.status === 429) {
              const prevFails = cbState.models[model]?.failCount || 0;
              const backoff =
                retryAfterMs || Math.min(300_000, 15_000 * (2 ** Math.min(prevFails, 4)));
              cbState.models[model] = {
                status: 429,
                failCount: prevFails + 1,
                untilMs: ts + backoff,
              };
              if (cbDirtyRef) cbDirtyRef.dirty = true;
            }
          }
          throw new Error(`Gemini HTTP ${res.status} (${model})`);
        }

        if (cbState?.models?.[model]) {
          delete cbState.models[model];
          if (cbDirtyRef) cbDirtyRef.dirty = true;
        }

        const data = await res.json();
        const parts = data?.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) {
          throw new Error(`Invalid Gemini payload (${model})`);
        }
        const restored = sanitizeRestoredMonologue(
          stripOuterMarkdownFence(
            parts
              .filter((p) => !p?.thought && typeof p?.text === 'string')
              .map((p) => p.text)
              .join('')
              .trim(),
          ),
        );
        if (restored) {
          return restored;
        }
        throw new Error(`Empty Gemini output (${model})`);
      } catch (err) {
        lastErr = err;
        if (cbState?.keys?.[keyHash]?.untilMs > Date.now()) {
          break;
        }
      }
    }
    throw lastErr || new Error('All Gemini models failed');
  };

  const chunks = splitLongThoughtForGemini(enText, LONG_THOUGHT_CHUNK_CHARS);
  if (chunks.length <= 1) {
    return restoreChunk(enText);
  }
  const restoredChunks = await mapWithConcurrency(chunks, 3, (chunk) => restoreChunk(chunk));
  return restoredChunks.filter(Boolean).join('\n\n').trim();
}

export const DEFAULT_TRANSLATE_TIMEOUT_MS = 5000;
const TRANSLATE_CHUNK_MAX_CHARS = 1400;
const TRANSLATE_CHUNK_MAX_ENCODED_BYTES = 4000;

function fitsTranslateBudget(str, maxChars, maxEncodedBytes) {
  return str.length <= maxChars && encodeURIComponent(str).length <= maxEncodedBytes;
}

function sliceByCodePointBudget(text, maxChars, maxEncodedBytes) {
  const pieces = [];
  let buf = '';
  let bufEncoded = 0;
  for (const cp of text) {
    const cpEncoded = encodeURIComponent(cp).length;
    if (buf && (buf.length + cp.length > maxChars || bufEncoded + cpEncoded > maxEncodedBytes)) {
      pieces.push(buf);
      buf = cp;
      bufEncoded = cpEncoded;
    } else {
      buf += cp;
      bufEncoded += cpEncoded;
    }
  }
  if (buf) pieces.push(buf);
  return pieces;
}

function splitProseLine(line, maxChars, maxEncodedBytes) {
  if (fitsTranslateBudget(line, maxChars, maxEncodedBytes)) {
    return [{ sepBefore: '', text: line }];
  }

  // Split along whitespace tokens while preserving exact whitespace separators (never mid-word unless token itself exceeds budget).
  const tokens = line.split(/(\s+)/);
  const out = [];
  let curText = '';
  let curSepBefore = '';
  let pendingSep = '';

  const flush = () => {
    if (curText) {
      out.push({ sepBefore: curSepBefore, text: curText });
      curText = '';
      curSepBefore = '';
    }
  };

  for (const tok of tokens) {
    if (!tok) continue;
    if (/^\s+$/.test(tok)) {
      pendingSep += tok;
      continue;
    }

    if (!fitsTranslateBudget(tok, maxChars, maxEncodedBytes)) {
      flush();
      const subPieces = sliceByCodePointBudget(tok, maxChars, maxEncodedBytes);
      subPieces.forEach((piece, idx) => {
        out.push({ sepBefore: idx === 0 ? pendingSep : '', text: piece });
      });
      pendingSep = '';
      continue;
    }

    if (!curText) {
      curSepBefore = pendingSep;
      curText = tok;
      pendingSep = '';
      continue;
    }

    const combined = `${curText}${pendingSep}${tok}`;
    if (fitsTranslateBudget(combined, maxChars, maxEncodedBytes)) {
      curText = combined;
      pendingSep = '';
    } else {
      flush();
      curSepBefore = pendingSep;
      curText = tok;
      pendingSep = '';
    }
  }
  flush();
  return out;
}

export function splitTranslateSegments(
  text,
  maxChars = TRANSLATE_CHUNK_MAX_CHARS,
  maxEncodedBytes = TRANSLATE_CHUNK_MAX_ENCODED_BYTES,
) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  if (!normalized.trim()) return [];

  // Partition into fenced code blocks (kept raw/untranslated) and prose blocks, preserving exact newlines.
  const lines = normalized.split('\n');
  const blocks = [];
  let inFence = false;
  let fenceMarker = '';
  let buf = [];

  const pushBlock = (kind) => {
    if (buf.length === 0) return;
    blocks.push({ kind, text: buf.join('\n') });
    buf = [];
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    const m = trimmed.match(/^(`{3,}|~{3,})/);
    if (!inFence && m) {
      pushBlock('prose');
      inFence = true;
      fenceMarker = m[1][0].repeat(m[1].length);
      buf.push(line);
      continue;
    }
    if (inFence) {
      buf.push(line);
      if (trimmed.startsWith(fenceMarker) && new RegExp(`^${fenceMarker[0]}+\\s*$`).test(trimmed)) {
        pushBlock('raw');
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    buf.push(line);
  }
  pushBlock(inFence ? 'raw' : 'prose');

  // Expand prose blocks into atomic units with exact preceding separators, then coalesce adjacent prose units within budget.
  const atomic = [];
  blocks.forEach((blk, blkIdx) => {
    const blockJoinSep = blkIdx === 0 ? '' : '\n';
    if (blk.kind === 'raw') {
      atomic.push({ kind: 'raw', sepBefore: blockJoinSep, text: blk.text });
      return;
    }

    // Split prose block while capturing exact newline runs (\n or \n\n+)
    const parts = blk.text.split(/(\n+)/);
    let pendingSep = blockJoinSep;
    for (const part of parts) {
      if (part === '') continue;
      if (/^\n+$/.test(part)) {
        pendingSep += part;
        continue;
      }
      const linePieces = splitProseLine(part, maxChars, maxEncodedBytes);
      linePieces.forEach((piece, idx) => {
        atomic.push({
          kind: 'translate',
          sepBefore: idx === 0 ? pendingSep + piece.sepBefore : piece.sepBefore,
          text: piece.text,
        });
      });
      pendingSep = '';
    }
    if (pendingSep) {
      atomic.push({ kind: 'raw', sepBefore: '', text: pendingSep });
    }
  });

  const merged = [];
  for (const seg of atomic) {
    if (seg.kind === 'raw' || !seg.text.trim()) {
      merged.push({ kind: 'raw', sepBefore: seg.sepBefore, text: seg.text });
      continue;
    }
    const prev = merged[merged.length - 1];
    if (prev && prev.kind === 'translate') {
      const candidate = `${prev.text}${seg.sepBefore}${seg.text}`;
      if (fitsTranslateBudget(candidate, maxChars, maxEncodedBytes)) {
        prev.text = candidate;
        continue;
      }
    }
    merged.push({ kind: 'translate', sepBefore: seg.sepBefore, text: seg.text });
  }
  return merged;
}

async function fetchSingleTranslateChunk(chunk, safeLang, timeoutMs, fetchImpl) {
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'auto');
  url.searchParams.set('tl', safeLang);
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', chunk);

  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Translate HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('Invalid translation response');
  }
  return data[0]
    .map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
    .join('')
    .replace(/`\s*([^`\n]+?)\s*`/g, '`$1`')
    .trim();
}

export async function fetchGoogleTranslate(
  text,
  targetLang = 'ko',
  timeoutMs = DEFAULT_TRANSLATE_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
) {
  const safeLang = TARGET_LANG_REGEX.test(String(targetLang || '')) ? String(targetLang) : 'ko';
  const segments = splitTranslateSegments(text);
  if (segments.length === 0) return text;

  let out = '';
  for (const seg of segments) {
    if (seg.kind === 'raw') {
      out += `${seg.sepBefore}${seg.text}`;
    } else {
      const translated = await fetchSingleTranslateChunk(seg.text, safeLang, timeoutMs, fetchImpl);
      out += `${seg.sepBefore}${translated || seg.text}`;
    }
  }
  return out.trim() || text;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await mapper(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// Critical 4: Strict 3-mode isolation.
// - raw: 0 network calls, needsRestore = false
// - gemini: official generativelanguage.googleapis.com ONLY, never falls back to translate.googleapis.com
// - translate: translate.googleapis.com ONLY when user explicitly chose mode === 'translate'
export async function restoreTurnSteps(
  thoughtSteps,
  {
    allowNetwork = false,
    settings = null,
    dataDir = resolveDataDir(),
    apiKeyOverride = null,
    userHint = '',
    timeoutMs = 25000,
    translateTimeoutMs = 5000,
    preloadedCache = null,
    manualTrigger = false,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  const paths = getDataPaths(dataDir);
  const activeSettings = normalizeSettings(settings || loadSettings(dataDir));
  const mode = activeSettings.mode;

  if (mode === 'raw') {
    return thoughtSteps.map((step) => {
      const enText = step.paragraphs.join('\n\n');
      return {
        ...step,
        displayText: enText,
        enText,
        isRestored: true,
        needsRestore: false,
        showOriginalToggle: false,
      };
    });
  }

  let cache =
    preloadedCache && typeof preloadedCache === 'object'
      ? preloadedCache
      : loadTranslationCache(paths.cachePath);

  const newCacheEntries = {};
  const touchedKeys = [];
  let cacheDirty = false;

  const apiKey =
    mode === 'gemini' && allowNetwork
      ? (typeof apiKeyOverride === 'string' ? apiKeyOverride : loadSecrets(dataDir).geminiApiKey)
      : '';
  const canCallGemini = Boolean(mode === 'gemini' && allowNetwork && apiKey);
  const canCallTranslate = Boolean(mode === 'translate' && allowNetwork);

  const cbState = canCallGemini ? loadCircuitBreakerState(paths.circuitBreakerPath) : null;
  const cbDirtyRef = { dirty: false };
  const now = Date.now();

  const pending = [];
  const seenKeys = new Set();

  for (const step of thoughtSteps) {
    const enText = step.paragraphs.join('\n\n');
    const cacheKey = buildStepCacheKey(enText, activeSettings);
    if (cache[cacheKey]) {
      touchedKeys.push(cacheKey);
      continue;
    }

    if (canCallGemini) {
      const stepCooldown = cbState?.steps?.[cacheKey];
      const stepBlocked = !manualTrigger && stepCooldown && stepCooldown.untilMs > now;
      if (!stepBlocked && !seenKeys.has(cacheKey)) {
        seenKeys.add(cacheKey);
        pending.push({ cacheKey, enText });
      }
    } else if (canCallTranslate && !seenKeys.has(cacheKey)) {
      seenKeys.add(cacheKey);
      pending.push({ cacheKey, enText });
    }
  }

  if (pending.length > 0 && canCallGemini) {
    await mapWithConcurrency(pending, 3, async ({ cacheKey, enText }) => {
      try {
        const restored = await restoreStepWithGemini(enText, {
          apiKey,
          settings: activeSettings,
          userHint,
          timeoutMs,
          cbState,
          cbDirtyRef,
          manualTrigger,
          fetchImpl,
        });
        if (restored) {
          newCacheEntries[cacheKey] = restored;
          cacheDirty = true;
          if (cbState?.steps?.[cacheKey]) {
            delete cbState.steps[cacheKey];
            cbDirtyRef.dirty = true;
          }
        }
      } catch {
        // Strictly NO fallback to translate.googleapis.com in gemini mode.
        if (cbState) {
          const prevFails = cbState.steps[cacheKey]?.failCount || 0;
          const stepBackoff = Math.min(180_000, 10_000 * (2 ** Math.min(prevFails, 4)));
          cbState.steps[cacheKey] = {
            failCount: prevFails + 1,
            untilMs: Date.now() + stepBackoff,
          };
          cbDirtyRef.dirty = true;
        }
      }
    });
  } else if (pending.length > 0 && canCallTranslate) {
    await mapWithConcurrency(pending, 4, async ({ cacheKey, enText }) => {
      try {
        const translated = await fetchGoogleTranslate(
          enText,
          activeSettings.targetLang,
          translateTimeoutMs,
          fetchImpl,
        );
        if (translated) {
          newCacheEntries[cacheKey] = translated;
          cacheDirty = true;
        }
      } catch {
        // Leave uncached on network error.
      }
    });
  }

  if (cbState && cbDirtyRef.dirty) {
    saveCircuitBreakerState(cbState, paths.circuitBreakerPath);
  }

  if (cacheDirty) {
    await saveTranslationCache(newCacheEntries, paths.cachePath, touchedKeys);
    cache = { ...loadTranslationCache(paths.cachePath), ...newCacheEntries };
  }

  return thoughtSteps.map((step) => {
    const enText = step.paragraphs.join('\n\n');
    const cacheKey = buildStepCacheKey(enText, activeSettings);
    const cachedText = cache[cacheKey];
    const isRestored = Boolean(cachedText);
    const displayText = cachedText || enText;

    return {
      ...step,
      displayText,
      enText,
      isRestored,
      needsRestore: !isRestored,
      showOriginalToggle: Boolean(cachedText && cachedText !== enText),
    };
  });
}

function readSliceLines(fd, startOffset, endOffset) {
  const len = Math.max(0, endOffset - startOffset);
  if (len === 0) return [];
  const buf = Buffer.allocUnsafe(len);
  const bytesRead = fs.readSync(fd, buf, 0, len, startOffset);
  let text = buf.subarray(0, bytesRead).toString('utf8');
  if (startOffset > 0) {
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
  }
  return text ? text.split(/\r?\n/) : [];
}

export function readTailLines(filePath, maxBytes = MAX_TAIL_BYTES) {
  const stat = fs.statSync(filePath);
  if (stat.size <= 0) return [];
  const fd = fs.openSync(filePath, 'r');
  try {
    const startOffset = Math.max(0, stat.size - maxBytes);
    return readSliceLines(fd, startOffset, stat.size);
  } finally {
    fs.closeSync(fd);
  }
}

function computeFileHeadHash(fd, fileSize) {
  const sampleLen = Math.min(fileSize, HEAD_HASH_SAMPLE_BYTES);
  if (sampleLen <= 0) return 'empty';
  const buf = Buffer.allocUnsafe(sampleLen);
  const read = fs.readSync(fd, buf, 0, sampleLen, 0);
  return crypto.createHash('sha256').update(buf.subarray(0, read)).digest('hex').slice(0, 16);
}

function loadNegCache(negCachePath) {
  try {
    if (!fs.existsSync(negCachePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(negCachePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveNegCacheEntry(negCachePath, filePath, record) {
  try {
    const map = loadNegCache(negCachePath);
    delete map[filePath];
    map[filePath] = record;
    const keys = Object.keys(map);
    const trimmed = {};
    for (const k of keys.slice(Math.max(0, keys.length - MAX_NEG_CACHE_ENTRIES))) {
      trimmed[k] = map[k];
    }
    atomicWriteSync(negCachePath, JSON.stringify(trimmed), { mode: 0o600, maxRetries: 3 });
  } catch {
    // Ignore negative cache write errors.
  }
}

function removeNegCacheEntry(negCachePath, filePath) {
  try {
    const map = loadNegCache(negCachePath);
    if (Object.prototype.hasOwnProperty.call(map, filePath)) {
      delete map[filePath];
      atomicWriteSync(negCachePath, JSON.stringify(map), { mode: 0o600, maxRetries: 3 });
    }
  } catch {
    // Ignore negative cache cleanup errors.
  }
}

export function parseJsonLines(lines) {
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Ignore incomplete line mid-flush.
    }
  }
  return entries;
}

function hasUserInputStep(entries) {
  return entries.some((e) => e?.type === 'USER_INPUT');
}

function hasUserInputInHead(fd, fileSize) {
  const readLen = Math.min(fileSize, FIRST_TOPIC_HEAD_BYTES);
  if (readLen <= 0) return false;
  const buf = Buffer.allocUnsafe(readLen);
  const read = fs.readSync(fd, buf, 0, readLen, 0);
  const text = buf.subarray(0, read).toString('utf8');
  if (!text.includes('USER_INPUT')) return false;
  return hasUserInputStep(parseJsonLines(text.split(/\r?\n/)));
}

export function readLatestTurnBounded(filePath, { hookMode = false, negCachePath } = {}) {
  const resolvedNegPath = negCachePath || getDataPaths().negCachePath;
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    return { entries: [], turn: null, fileSize: 0, reason: 'subagent_no_user_turn' };
  }

  const negMap = loadNegCache(resolvedNegPath);
  const neg = negMap[filePath];
  if (neg && neg.mtimeMs === stat.mtimeMs && neg.size === stat.size) {
    return { entries: [], turn: null, fileSize: stat.size, reason: 'subagent_no_user_turn' };
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const headHash = computeFileHeadHash(fd, stat.size);

    if (
      neg &&
      neg.headHash === headHash &&
      typeof neg.checkedSize === 'number' &&
      stat.size >= neg.checkedSize
    ) {
      const deltaStart = Math.max(0, neg.checkedSize - 4096);
      const boundedDeltaStart = Math.max(deltaStart, stat.size - MAX_TAIL_BYTES);
      const deltaEntries = parseJsonLines(readSliceLines(fd, boundedDeltaStart, stat.size));
      if (hasUserInputStep(deltaEntries)) {
        removeNegCacheEntry(resolvedNegPath, filePath);
        const deltaTurn = extractLatestTurn(deltaEntries);
        if (deltaTurn) {
          return { entries: deltaEntries, turn: deltaTurn, fileSize: stat.size, reason: null };
        }
        return {
          entries: deltaEntries,
          turn: null,
          fileSize: stat.size,
          reason: 'user_turn_pending_thoughts',
        };
      }
      if (boundedDeltaStart <= neg.checkedSize) {
        saveNegCacheEntry(resolvedNegPath, filePath, {
          headHash,
          checkedSize: stat.size,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
        return { entries: [], turn: null, fileSize: stat.size, reason: 'subagent_no_user_turn' };
      }
    }

    const tailStart = Math.max(0, stat.size - MAX_TAIL_BYTES);
    const tailEntries = parseJsonLines(readSliceLines(fd, tailStart, stat.size));
    const tailTurn = extractLatestTurn(tailEntries);
    if (tailTurn) {
      if (neg) removeNegCacheEntry(resolvedNegPath, filePath);
      return { entries: tailEntries, turn: tailTurn, fileSize: stat.size, reason: null };
    }

    if (hasUserInputStep(tailEntries)) {
      if (neg) removeNegCacheEntry(resolvedNegPath, filePath);
      return {
        entries: tailEntries,
        turn: null,
        fileSize: stat.size,
        reason: 'user_turn_pending_thoughts',
      };
    }

    if (tailStart === 0) {
      const workerMeta = detectSwarmWorkerMeta(filePath, tailEntries);
      if (workerMeta.isSwarmWorker) {
        if (neg) removeNegCacheEntry(resolvedNegPath, filePath);
        return {
          entries: tailEntries,
          turn: null,
          fileSize: stat.size,
          reason: 'swarm_worker_detected',
          workerMeta,
        };
      }
      saveNegCacheEntry(resolvedNegPath, filePath, {
        headHash,
        checkedSize: stat.size,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      return { entries: [], turn: null, fileSize: stat.size, reason: 'subagent_no_user_turn' };
    }

    if (hookMode) {
      const workerMeta = detectSwarmWorkerMeta(filePath);
      if (workerMeta.isSwarmWorker) {
        if (neg) removeNegCacheEntry(resolvedNegPath, filePath);
        return {
          entries: tailEntries,
          turn: null,
          fileSize: stat.size,
          reason: 'swarm_worker_detected',
          workerMeta,
        };
      }
      return { entries: [], turn: null, fileSize: stat.size, reason: 'beyond_hook_tail_window' };
    }

    const headHasUser = hasUserInputInHead(fd, stat.size);

    let cursorEnd = tailStart;
    let scannedBytes = MAX_TAIL_BYTES;
    let carryHead = '';
    {
      const probeLen = Math.min(65536, stat.size - tailStart);
      const probeBuf = Buffer.allocUnsafe(probeLen);
      const pr = fs.readSync(fd, probeBuf, 0, probeLen, tailStart);
      const probeStr = probeBuf.subarray(0, pr).toString('utf8');
      const nl = probeStr.indexOf('\n');
      carryHead = nl >= 0 ? probeStr.slice(0, nl) : probeStr;
    }

    while (cursorEnd > 0 && scannedBytes < MAX_BACKWARD_SCAN_BYTES) {
      const chunkStart = Math.max(0, cursorEnd - BACKWARD_SCAN_CHUNK_BYTES);
      const chunkLen = cursorEnd - chunkStart;
      const buf = Buffer.allocUnsafe(chunkLen);
      const read = fs.readSync(fd, buf, 0, chunkLen, chunkStart);
      const raw = buf.subarray(0, read).toString('utf8') + carryHead;

      const lines = raw.split(/\r?\n/);
      if (chunkStart > 0) {
        carryHead = lines.shift() || '';
      } else {
        carryHead = '';
      }

      if (raw.includes('USER_INPUT')) {
        const chunkEntries = parseJsonLines(lines);
        if (hasUserInputStep(chunkEntries)) {
          if (neg) removeNegCacheEntry(resolvedNegPath, filePath);
          const sliceEnd = Math.min(stat.size, chunkStart + MAX_FOUND_TURN_SLICE_BYTES);
          const turnEntries = parseJsonLines(readSliceLines(fd, chunkStart, sliceEnd));
          const foundTurn = extractLatestTurn(turnEntries);
          if (foundTurn) {
            return { entries: turnEntries, turn: foundTurn, fileSize: stat.size, reason: null };
          }
          return {
            entries: turnEntries,
            turn: null,
            fileSize: stat.size,
            reason: 'user_turn_pending_thoughts',
          };
        }
      }

      cursorEnd = chunkStart;
      scannedBytes += chunkLen;
    }

    if (cursorEnd === 0 || !headHasUser) {
      const workerMeta = detectSwarmWorkerMeta(filePath);
      if (workerMeta.isSwarmWorker) {
        if (neg) removeNegCacheEntry(resolvedNegPath, filePath);
        return {
          entries: tailEntries,
          turn: null,
          fileSize: stat.size,
          reason: 'swarm_worker_detected',
          workerMeta,
        };
      }
      saveNegCacheEntry(resolvedNegPath, filePath, {
        headHash,
        checkedSize: stat.size,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      return { entries: [], turn: null, fileSize: stat.size, reason: 'subagent_no_user_turn' };
    }

    return {
      entries: [],
      turn: null,
      fileSize: stat.size,
      reason: 'no_user_turn_in_bounded_window',
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function extractFirstSessionTopic(filePath, fallbackEntries = []) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 0) {
      const readLen = Math.min(stat.size, FIRST_TOPIC_HEAD_BYTES);
      const fd = fs.openSync(filePath, 'r');
      try {
        const buffer = Buffer.allocUnsafe(readLen);
        const bytesRead = fs.readSync(fd, buffer, 0, readLen, 0);
        const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('{')) continue;
          try {
            const obj = JSON.parse(trimmed);
            if (obj?.type === 'USER_INPUT') {
              return summarizeOneLine(cleanUserInput(obj.content), 42);
            }
          } catch {
            // Ignore partial line at read boundary.
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    // Fall back to already loaded entries.
  }

  for (const entry of fallbackEntries) {
    if (entry?.type === 'USER_INPUT') {
      return summarizeOneLine(cleanUserInput(entry.content), 42);
    }
  }
  return '';
}

export function resolveTranscriptCandidate(
  hintPath,
  conversationId,
  { allowMtimeFallback = true, brainDirs = resolveBrainDirs() } = {},
) {
  const candidates = [];

  if (hintPath && typeof hintPath === 'string') {
    const dir = path.dirname(hintPath);
    candidates.push(path.join(dir, 'transcript_full.jsonl'));
    candidates.push(hintPath);
  }

  if (conversationId && typeof conversationId === 'string' && CONV_ID_REGEX.test(conversationId)) {
    for (const brainRoot of brainDirs) {
      const logsDir = path.join(brainRoot, conversationId, '.system_generated', 'logs');
      candidates.push(path.join(logsDir, 'transcript_full.jsonl'));
      candidates.push(path.join(logsDir, 'transcript.jsonl'));
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  if (!allowMtimeFallback) {
    return null;
  }

  let latestPath = null;
  let latestMtime = -1;

  for (const brainRoot of brainDirs) {
    if (!fs.existsSync(brainRoot)) continue;
    let dirs = [];
    try {
      dirs = fs.readdirSync(brainRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const dir of dirs) {
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
        const mtime = fs.statSync(chosen).mtimeMs;
        if (mtime > latestMtime) {
          latestMtime = mtime;
          latestPath = chosen;
        }
      } catch {
        // Ignore inaccessible entries.
      }
    }
  }

  return latestPath;
}

export function inferConversationId(transcriptFile, fallbackId) {
  if (fallbackId) return fallbackId;
  const normalized = String(transcriptFile || '').replace(/\\/g, '/');
  const match = normalized.match(/\/brain\/([^/]+)\/\.system_generated\/logs\//);
  return match ? match[1] : 'unknown';
}

const BG_TASK_START_RE = /Tool is running as a background task with task id:\s*([^\s\r\n]+)/i;
const BG_TASK_DONE_RE = /Task id\s+"([^"]+)"\s+(?:finished|was canceled|failed|exited|stopped)/i;
const SERVER_RESTART_NOTICE_RE = /All your subagents and background tasks have been stopped/i;

function computePendingTasksAndTrailingWakeup(slice, lastPlannerStep) {
  const pendingTasks = new Set();
  let lastPlannerSliceIdx = -1;
  let lastRunCmdWasDaemon = false;

  for (let idx = 0; idx < slice.length; idx += 1) {
    const entry = slice[idx];
    if (!entry) continue;
    if (entry === lastPlannerStep) {
      lastPlannerSliceIdx = idx;
    }
    if (entry.type === 'PLANNER_RESPONSE') {
      const calls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
      const runCalls = calls.filter((c) => c?.name === 'run_command');
      lastRunCmdWasDaemon =
        runCalls.length > 0 &&
        runCalls.every(
          (c) => c?.args?.IsDaemon === true || String(c?.args?.IsDaemon).toLowerCase() === 'true',
        );
      continue;
    }
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (entry.type === 'GENERIC') {
      const m = content.match(BG_TASK_START_RE);
      if (m && !lastRunCmdWasDaemon) {
        pendingTasks.add(m[1]);
      }
      continue;
    }
    if (entry.type === 'SYSTEM_MESSAGE') {
      if (SERVER_RESTART_NOTICE_RE.test(content)) {
        pendingTasks.clear();
        continue;
      }
      const m = content.match(BG_TASK_DONE_RE);
      if (m) {
        pendingTasks.delete(m[1]);
      }
    }
  }

  let hasTrailingWakeup = false;
  if (lastPlannerSliceIdx >= 0) {
    for (let idx = lastPlannerSliceIdx + 1; idx < slice.length; idx += 1) {
      const entry = slice[idx];
      if (entry?.type === 'SYSTEM_MESSAGE') {
        const content = typeof entry.content === 'string' ? entry.content : '';
        if (!SERVER_RESTART_NOTICE_RE.test(content)) {
          hasTrailingWakeup = true;
          break;
        }
      }
    }
  }

  return {
    hasPendingBgTask: pendingTasks.size > 0,
    hasTrailingWakeup,
  };
}

export function extractAllTurns(entries) {
  const userIndices = [];
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i]?.type === 'USER_INPUT') {
      userIndices.push(i);
    }
  }

  if (userIndices.length === 0) {
    return [];
  }

  const turns = [];
  for (let u = 0; u < userIndices.length; u += 1) {
    const startIdx = userIndices[u];
    const endIdx = u + 1 < userIndices.length ? userIndices[u + 1] : entries.length;
    const userStep = entries[startIdx];
    const slice = entries.slice(startIdx + 1, endIdx);
    const isLatestUserTurn = u === userIndices.length - 1;

    const plannerSteps = slice.filter((s) => s?.type === 'PLANNER_RESPONSE');
    const lastPlannerStep = plannerSteps.length > 0 ? plannerSteps[plannerSteps.length - 1] : null;
    const { hasPendingBgTask, hasTrailingWakeup } = isLatestUserTurn
      ? computePendingTasksAndTrailingWakeup(slice, lastPlannerStep)
      : { hasPendingBgTask: false, hasTrailingWakeup: false };

    const thoughtSteps = [];
    let finalReplyStep = null;

    for (const step of plannerSteps) {
      const paragraphs = cleanThinkingParagraphs(step.thinking);
      const toolNames = Array.isArray(step.tool_calls)
        ? step.tool_calls.map((t) => t?.name).filter(Boolean)
        : [];
      const hasFinalContent =
        typeof step.content === 'string' && step.content.trim().length > 0 && toolNames.length === 0;
      const isActualFinal =
        step === lastPlannerStep && hasFinalContent && !hasPendingBgTask && !hasTrailingWakeup;

      if (isActualFinal) {
        finalReplyStep = step;
      }

      if (paragraphs.length > 0) {
        thoughtSteps.push({
          stepIndex: step.step_index,
          createdAt: step.created_at,
          paragraphs,
          toolNames,
          isFinal: isActualFinal,
        });
      }
    }

    if (thoughtSteps.length > 0 || finalReplyStep || isLatestUserTurn) {
      const userStepIdx = typeof userStep?.step_index === 'number' ? userStep.step_index : null;
      const maxStepIdx = slice.reduce(
        (acc, s) => (typeof s?.step_index === 'number' && s.step_index > acc ? s.step_index : acc),
        userStepIdx ?? 0,
      );
      turns.push({
        turnNumber: turns.length + 1,
        userStep,
        userStepIndex: userStepIdx,
        thoughtSteps,
        finalReplyStep,
        isComplete: Boolean(finalReplyStep),
        maxStepIndex: maxStepIdx,
      });
    }
  }

  return turns;
}

export function extractLatestTurn(entries) {
  const turns = extractAllTurns(entries);
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i];
    const isLatest = i === turns.length - 1;
    if (t.thoughtSteps.length > 0 || (isLatest && t.finalReplyStep)) {
      return t;
    }
  }
  return null;
}

const SWARM_EXCLUDED_WORKER_RE = /^(?:monitor|narrator)(?:-|$)/i;

export function formatWorkerDisplayLabel(workerName) {
  const cleanName = String(workerName || '').trim();
  return cleanName || 'worker';
}

export function cleanWorkerTriggerContent(rawContent) {
  if (typeof rawContent !== 'string' || !rawContent.trim()) {
    return '(empty assignment)';
  }
  let text = rawContent.replace(/\r\n/g, '\n').trim();
  text = text
    .replace(/^The following is a <SYSTEM_MESSAGE>[\s\S]*?\n+(?=<SYSTEM_MESSAGE>)/i, '')
    .trim();
  const sysMatch = text.match(/^<SYSTEM_MESSAGE>\s*([\s\S]*?)\s*<\/SYSTEM_MESSAGE>\s*$/i);
  if (sysMatch) {
    text = sysMatch[1].trim();
  }
  const msgMatch = text.match(/^\[Message\][^\n]*?content=([\s\S]*)$/i);
  if (msgMatch) {
    text = msgMatch[1].trim();
  }
  text = text.replace(
    /^You have just started\.\s*Your assignment\s*\(recorded on the board as #\d+\s+for\s+@[a-z0-9][a-z0-9_-]{0,30}\):\s*/i,
    '',
  );
  return text.trim() || '(empty assignment)';
}

function readHeadEntriesBounded(filePath, maxBytes = FIRST_TOPIC_HEAD_BYTES) {
  if (!filePath) return [];
  try {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    if (stat.size <= 0) return [];
    const readLen = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(readLen);
      const read = fs.readSync(fd, buf, 0, readLen, 0);
      return parseJsonLines(buf.subarray(0, read).toString('utf8').split(/\r?\n/));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

export function detectSwarmWorkerMeta(transcriptPath, entries = []) {
  const empty = { isSwarmWorker: false, workerName: '', parentConvId: '' };
  const provided = Array.isArray(entries) ? entries : [];
  if (hasUserInputStep(provided)) {
    return empty;
  }

  let headEntries = provided;
  const needsHeadRead =
    Boolean(transcriptPath) &&
    (provided.length === 0 ||
      (typeof provided[0]?.step_index === 'number' && provided[0].step_index > 0));
  if (needsHeadRead) {
    const diskHead = readHeadEntriesBounded(transcriptPath, FIRST_TOPIC_HEAD_BYTES);
    if (hasUserInputStep(diskHead)) {
      return empty;
    }
    headEntries = diskHead.length > 0 ? diskHead : provided;
  }

  if (headEntries.length === 0 || hasUserInputStep(headEntries)) {
    return empty;
  }

  const scanSlice = headEntries.slice(0, 24);
  let assignmentEntry = null;
  let workerName = '';
  let parentConvId = '';
  let fallbackSender = '';

  for (const entry of scanSlice) {
    if (entry?.type !== 'SYSTEM_MESSAGE' || typeof entry.content !== 'string') continue;
    const content = entry.content;
    const senderMatch = content.match(/\bsender=([a-zA-Z0-9_-]{8,80})\b/);
    if (senderMatch && !fallbackSender) {
      fallbackSender = senderMatch[1];
    }

    const boardAssignMatch = content.match(
      /\brecorded on the board as #\d+\s+for\s+@([a-z0-9][a-z0-9_-]{0,30})\b/i,
    );
    const isAssignment = /You have just started\.\s*Your assignment/i.test(content);
    const assignForMatch =
      boardAssignMatch ||
      (isAssignment ? content.match(/\bfor\s+@([a-z0-9][a-z0-9_-]{0,30})\b/i) : null);

    if (assignForMatch) {
      const candidateName = assignForMatch[1].toLowerCase();
      if (!assignmentEntry || isAssignment) {
        assignmentEntry = entry;
        workerName = candidateName;
        if (senderMatch) {
          parentConvId = senderMatch[1];
        }
        if (isAssignment && parentConvId) {
          break;
        }
      }
    }
  }

  if (!workerName || SWARM_EXCLUDED_WORKER_RE.test(workerName)) {
    return empty;
  }

  if (!parentConvId) {
    parentConvId = fallbackSender;
  }
  if (!parentConvId || !CONV_ID_REGEX.test(parentConvId)) {
    return empty;
  }

  const selfConvId = transcriptPath ? inferConversationId(transcriptPath, '') : '';
  if (selfConvId && selfConvId !== 'unknown' && parentConvId === selfConvId) {
    return empty;
  }

  return {
    isSwarmWorker: true,
    workerName,
    parentConvId,
  };
}

function isSwarmTriggerSystemMessage(entry) {
  if (entry?.type !== 'SYSTEM_MESSAGE' || typeof entry.content !== 'string') return false;
  const content = entry.content;
  if (/\bsender=[^\s]+\/task-\d+\b/i.test(content) || /\bcontent=Task id\s+"/i.test(content)) {
    return false;
  }
  return (
    /\[swarm\]/i.test(content) ||
    /You have just started\.\s*Your assignment/i.test(content) ||
    /\[Message\][^\n]*content=/i.test(content)
  );
}

function unwrapToolStringArg(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed.trim();
    } catch {
      // Keep trimmed raw string if not valid JSON string literal.
    }
  }
  return trimmed;
}

function extractPostMessageText(step) {
  if (!Array.isArray(step?.tool_calls)) return '';
  const texts = [];
  for (const tc of step.tool_calls) {
    if (tc?.name !== 'post_message') continue;
    const rawText =
      tc?.args && typeof tc.args === 'object'
        ? tc.args.text
        : typeof tc?.args === 'string'
          ? tc.args
          : tc?.arguments?.text;
    const cleaned = unwrapToolStringArg(rawText);
    if (cleaned) texts.push(cleaned);
  }
  return texts.join('\n\n').trim();
}

export function extractWorkerTurns(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const groups = [];
  let i = 0;
  while (i < entries.length) {
    if (!isSwarmTriggerSystemMessage(entries[i])) {
      i += 1;
      continue;
    }
    const startIdx = i;
    let endTriggerIdx = i;
    let chosenIdx = i;
    let hasAssignment = /You have just started\.\s*Your assignment/i.test(entries[i].content);
    let j = i + 1;
    while (j < entries.length) {
      if (entries[j]?.type === 'PLANNER_RESPONSE') break;
      if (isSwarmTriggerSystemMessage(entries[j])) {
        endTriggerIdx = j;
        const jIsAssignment = /You have just started\.\s*Your assignment/i.test(entries[j].content);
        if (jIsAssignment || !hasAssignment) {
          chosenIdx = j;
          if (jIsAssignment) hasAssignment = true;
        }
      }
      j += 1;
    }
    groups.push({ startIdx, endTriggerIdx, chosenIdx });
    i = endTriggerIdx + 1;
  }

  if (groups.length === 0) return [];

  const turns = [];
  for (let g = 0; g < groups.length; g += 1) {
    const group = groups[g];
    const nextStartIdx = g + 1 < groups.length ? groups[g + 1].startIdx : entries.length;
    const rawTriggerStep = entries[group.chosenIdx];
    const cleanedTriggerStep = {
      ...rawTriggerStep,
      content: cleanWorkerTriggerContent(rawTriggerStep.content),
    };
    const slice = entries.slice(group.endTriggerIdx + 1, nextStartIdx);
    const isLatestGroup = g === groups.length - 1;
    const plannerSteps = slice.filter((s) => s?.type === 'PLANNER_RESPONSE');
    const lastPlannerStep = plannerSteps.length > 0 ? plannerSteps[plannerSteps.length - 1] : null;
    const { hasPendingBgTask, hasTrailingWakeup } = isLatestGroup
      ? computePendingTasksAndTrailingWakeup(slice, lastPlannerStep)
      : { hasPendingBgTask: false, hasTrailingWakeup: false };

    const thoughtSteps = [];
    let finalReplyStep = null;
    let lastPostMessageStep = null;
    let wentToWait = false;

    for (const step of plannerSteps) {
      const paragraphs = cleanThinkingParagraphs(step.thinking);
      const toolNames = Array.isArray(step.tool_calls)
        ? step.tool_calls.map((t) => t?.name).filter(Boolean)
        : [];
      const postMsgText = extractPostMessageText(step);
      const hasSwarmWait = toolNames.includes('swarm_wait');
      const hasFinalContent =
        typeof step.content === 'string' && step.content.trim().length > 0 && toolNames.length === 0;
      const isOnlyPostOrWait =
        toolNames.length > 0 && toolNames.every((n) => n === 'post_message' || n === 'swarm_wait');

      if (postMsgText) {
        lastPostMessageStep = {
          step_index: step.step_index,
          created_at: step.created_at,
          content: postMsgText,
        };
      }

      let isStepFinal = false;
      if (step === lastPlannerStep && !hasTrailingWakeup) {
        if (hasSwarmWait) {
          wentToWait = true;
          isStepFinal = true;
          if (!finalReplyStep && lastPostMessageStep) {
            finalReplyStep = lastPostMessageStep;
          }
        } else if (hasFinalContent && !hasPendingBgTask) {
          finalReplyStep = step;
          isStepFinal = true;
        } else if (postMsgText && isOnlyPostOrWait && !hasPendingBgTask) {
          finalReplyStep = lastPostMessageStep;
          isStepFinal = true;
        }
      }

      if (paragraphs.length > 0) {
        thoughtSteps.push({
          stepIndex: step.step_index,
          createdAt: step.created_at,
          paragraphs,
          toolNames,
          isFinal: isStepFinal,
        });
      }
    }

    if (thoughtSteps.length > 0 || finalReplyStep || wentToWait || isLatestGroup) {
      const triggerStepIdx =
        typeof rawTriggerStep?.step_index === 'number' ? rawTriggerStep.step_index : null;
      const maxStepIdx = slice.reduce(
        (acc, s) => (typeof s?.step_index === 'number' && s.step_index > acc ? s.step_index : acc),
        triggerStepIdx ?? 0,
      );
      turns.push({
        turnNumber: turns.length + 1,
        userStep: cleanedTriggerStep,
        userStepIndex: triggerStepIdx,
        thoughtSteps,
        finalReplyStep,
        isComplete: Boolean(finalReplyStep || wentToWait),
        maxStepIndex: maxStepIdx,
        isWorkerTurn: true,
      });
    }
  }

  return turns;
}

export function extractLatestWorkerTurn(entries) {
  const turns = extractWorkerTurns(entries);
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i];
    const isLatest = i === turns.length - 1;
    if (t.thoughtSteps.length > 0 || (isLatest && (t.finalReplyStep || t.isComplete))) {
      return t;
    }
  }
  return null;
}

export function loadSessionsState(statePath) {
  try {
    if (!fs.existsSync(statePath)) {
      return { version: 1, slots: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.slots && typeof parsed.slots === 'object') {
      return { version: 1, slots: parsed.slots };
    }
  } catch {
    // Ignore corrupt state and rebuild cleanly.
  }
  return { version: 1, slots: {} };
}

export function saveSessionsState(state, statePath) {
  atomicWriteSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function assignStickySlot(slotsObj, conversationId, nowMs) {
  for (let s = 1; s <= MAX_SLOTS; s += 1) {
    const rec = slotsObj[String(s)];
    if (rec && rec.conversationId === conversationId) {
      return s;
    }
  }

  for (let s = 1; s <= MAX_SLOTS; s += 1) {
    if (!slotsObj[String(s)]) {
      return s;
    }
  }

  const candidates = [];
  for (let s = 1; s <= MAX_SLOTS; s += 1) {
    const rec = slotsObj[String(s)];
    const lastAct = typeof rec?.lastActivityMs === 'number' ? rec.lastActivityMs : 0;
    const activelyRunning = !rec?.isComplete && nowMs - lastAct <= RUNNING_PROTECT_MS;
    const userDismissed =
      Boolean(rec?.userDismissedIso) && rec.userDismissedIso === rec?.lastTimestampIso;
    candidates.push({ slot: s, activelyRunning, userDismissed, lastAct });
  }

  candidates.sort((a, b) => {
    if (a.activelyRunning !== b.activelyRunning) {
      return a.activelyRunning ? 1 : -1;
    }
    if (a.userDismissed !== b.userDismissed) {
      return a.userDismissed ? -1 : 1;
    }
    return a.lastAct - b.lastAct;
  });

  return candidates[0].slot;
}

export function buildSessionSnapshot({
  conversationId,
  transcriptPath,
  transcriptSize,
  sessionTopic,
  turn,
  restoredSteps,
}) {
  const { userStep, userStepIndex, finalReplyStep, isComplete, maxStepIndex } = turn;
  const userText = cleanUserInput(userStep.content);
  const latestPrompt = summarizeOneLine(userText, 44);
  const lastTimestamp =
    finalReplyStep?.created_at ||
    restoredSteps[restoredSteps.length - 1]?.createdAt ||
    userStep.created_at ||
    new Date().toISOString();

  const parsedMs = Date.parse(lastTimestamp);
  const turnTimestampMs = Number.isFinite(parsedMs) ? parsedMs : Date.now();
  const resolvedUserStepIdx =
    typeof userStepIndex === 'number'
      ? userStepIndex
      : typeof userStep?.step_index === 'number'
        ? userStep.step_index
        : null;

  return {
    conversationId,
    shortId: String(conversationId || 'unknown').slice(0, 8),
    transcriptPath: transcriptPath || undefined,
    transcriptSize: typeof transcriptSize === 'number' ? transcriptSize : undefined,
    sessionTopic: sessionTopic || latestPrompt,
    latestPrompt,
    lastTimestampIso: lastTimestamp,
    turnTimestampMs,
    isComplete,
    status: isComplete ? 'complete' : 'thinking',
    stepCount: restoredSteps.length,
    userStepIndex: resolvedUserStepIdx,
    maxStepIndex: typeof maxStepIndex === 'number' ? maxStepIndex : 0,
    restoredCount: restoredSteps.filter((s) => s.isRestored).length,
    needsRestoreCount: restoredSteps.filter((s) => s.needsRestore).length,
  };
}

export async function commitSnapshot(
  snapshot,
  { dataDir = resolveDataDir(), allowStepRollback = false } = {},
) {
  const { sessionsStatePath, stateLockPath } = getDataPaths(dataDir);
  let assignedSlot = 1;
  let staleDetected = false;
  let updated = false;

  const lockRes = await withLock(
    stateLockPath,
    async () => {
      const nowMs = Date.now();
      const state = loadSessionsState(sessionsStatePath);
      assignedSlot = assignStickySlot(state.slots, snapshot.conversationId, nowMs);
      const slotKey = String(assignedSlot);
      const prev = state.slots[slotKey];

      if (
        !allowStepRollback &&
        prev &&
        prev.conversationId === snapshot.conversationId &&
        typeof prev.maxStepIndex === 'number' &&
        prev.maxStepIndex > snapshot.maxStepIndex
      ) {
        const newerUserStep =
          typeof snapshot.userStepIndex === 'number' &&
          typeof prev.userStepIndex === 'number' &&
          snapshot.userStepIndex > prev.userStepIndex;
        const fileShrank =
          typeof snapshot.transcriptSize === 'number' &&
          typeof prev.transcriptSize === 'number' &&
          snapshot.transcriptSize < prev.transcriptSize;
        if (!newerUserStep && !fileShrank) {
          staleDetected = true;
          return;
        }
      }

      const preservedFirstSeen =
        prev && prev.conversationId === snapshot.conversationId && prev.firstSeenAtMs
          ? prev.firstSeenAtMs
          : nowMs;
      const preservedTopic =
        prev && prev.conversationId === snapshot.conversationId && prev.sessionTopic
          ? prev.sessionTopic
          : snapshot.sessionTopic;
      const preservedTranscriptPath =
        snapshot.transcriptPath ||
        (prev && prev.conversationId === snapshot.conversationId ? prev.transcriptPath : undefined);

      const lastActivityMs = Math.max(
        snapshot.turnTimestampMs,
        prev &&
          prev.conversationId === snapshot.conversationId &&
          typeof prev.lastActivityMs === 'number'
          ? Math.min(prev.lastActivityMs, nowMs)
          : 0,
      );

      const preservedDismissedIso =
        prev &&
        prev.conversationId === snapshot.conversationId &&
        prev.userDismissedIso &&
        prev.userDismissedIso === snapshot.lastTimestampIso
          ? prev.userDismissedIso
          : undefined;

      state.slots[slotKey] = {
        ...snapshot,
        slot: assignedSlot,
        transcriptPath: preservedTranscriptPath,
        firstSeenAtMs: preservedFirstSeen,
        sessionTopic: preservedTopic,
        lastActivityMs: lastActivityMs || nowMs,
        userDismissedIso: preservedDismissedIso,
        updatedAtMs: nowMs,
      };
      saveSessionsState(state, sessionsStatePath);
      updated = true;
    },
    { maxWaitMs: 3500, staleMs: SHORT_STALE_LOCK_MS, retryMs: 40 },
  );

  return { updated, assignedSlot, staleDetected, lockAcquired: lockRes.acquired };
}

export async function exportLatestThoughts({
  transcriptPath,
  conversationId,
  dataDir = resolveDataDir(),
  brainDirs = resolveBrainDirs(),
  allowNetwork = true,
  hookMode = false,
  allowMtimeFallback = !hookMode,
  timeoutMs = 15000,
  translateTimeoutMs = DEFAULT_TRANSLATE_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const paths = getDataPaths(dataDir);
  const settings = loadSettings(dataDir);
  const resolvedTranscript = resolveTranscriptCandidate(transcriptPath, conversationId, {
    allowMtimeFallback,
    brainDirs,
  });
  if (!resolvedTranscript || !fs.existsSync(resolvedTranscript)) {
    return { updated: false, reason: 'transcript_not_found', mode: settings.mode };
  }

  let scanFailureReason = 'no_user_turn_or_subagent';
  let detectedWorkerMeta = null;
  let detectedWorkerEntries = null;

  const buildFromDisk = async (enableNetwork) => {
    const { entries, turn, fileSize, reason, workerMeta } = readLatestTurnBounded(resolvedTranscript, {
      hookMode,
      negCachePath: paths.negCachePath,
    });
    if (!turn) {
      if (reason) scanFailureReason = reason;
      if (workerMeta?.isSwarmWorker) {
        detectedWorkerMeta = workerMeta;
        detectedWorkerEntries = Array.isArray(entries) && entries.length > 0 ? entries : null;
      }
      return null;
    }

    const convId = inferConversationId(resolvedTranscript, conversationId);
    const sessionTopic = extractFirstSessionTopic(resolvedTranscript, entries);
    const userHint = cleanUserInput(turn.userStep?.content);
    const restoredSteps = await restoreTurnSteps(turn.thoughtSteps, {
      allowNetwork: hookMode ? false : enableNetwork,
      settings,
      dataDir,
      userHint,
      timeoutMs,
      translateTimeoutMs,
      fetchImpl,
    });

    return buildSessionSnapshot({
      conversationId: convId,
      transcriptPath: resolvedTranscript,
      transcriptSize: fileSize,
      sessionTopic,
      turn,
      restoredSteps,
    });
  };

  let snapshot = await buildFromDisk(allowNetwork);
  if (!snapshot) {
    if (
      scanFailureReason === 'swarm_worker_detected' ||
      scanFailureReason === 'subagent_no_user_turn' ||
      scanFailureReason === 'beyond_hook_tail_window'
    ) {
      const workerMeta = detectedWorkerMeta || detectSwarmWorkerMeta(resolvedTranscript);
      if (workerMeta.isSwarmWorker) {
        if (scanFailureReason === 'subagent_no_user_turn') {
          removeNegCacheEntry(paths.negCachePath, resolvedTranscript);
        }
        const workerEntries =
          detectedWorkerEntries || parseJsonLines(readTailLines(resolvedTranscript, MAX_TAIL_BYTES));
        let workerTurn = extractLatestWorkerTurn(workerEntries);
        if (!workerTurn) {
          const widerEntries = parseJsonLines(
            readTailLines(resolvedTranscript, MAX_FOUND_TURN_SLICE_BYTES),
          );
          workerTurn = extractLatestWorkerTurn(widerEntries);
        }
        const convId = inferConversationId(resolvedTranscript, conversationId);
        if (!workerTurn) {
          return {
            updated: false,
            reason: 'worker_turn_pending',
            isSwarmWorker: true,
            workerName: workerMeta.workerName,
            parentConvId: workerMeta.parentConvId,
            conversationId: convId,
            transcript: resolvedTranscript,
            needsRestoreCount: 0,
            mode: settings.mode,
          };
        }

        const workerHint = cleanUserInput(workerTurn.userStep?.content);
        const restoredSteps = await restoreTurnSteps(workerTurn.thoughtSteps, {
          allowNetwork: hookMode ? false : allowNetwork,
          settings,
          dataDir,
          userHint: workerHint,
          timeoutMs,
          translateTimeoutMs,
          fetchImpl,
        });
        return {
          updated: true,
          isSwarmWorker: true,
          workerName: workerMeta.workerName,
          parentConvId: workerMeta.parentConvId,
          conversationId: convId,
          transcript: resolvedTranscript,
          stepCount: restoredSteps.length,
          restoredCount: restoredSteps.filter((s) => s.isRestored).length,
          needsRestoreCount: restoredSteps.filter((s) => s.needsRestore).length,
          userStepIndex: workerTurn.userStepIndex,
          mode: settings.mode,
        };
      }
    }
    return { updated: false, reason: scanFailureReason, mode: settings.mode };
  }

  let commitResult = await commitSnapshot(snapshot, { dataDir });

  if (commitResult.staleDetected) {
    const refreshed = await buildFromDisk(false);
    if (refreshed) {
      snapshot = refreshed;
      commitResult = await commitSnapshot(snapshot, { dataDir, allowStepRollback: true });
    }
  }

  return {
    updated: commitResult.updated,
    reason: commitResult.updated ? undefined : 'unchanged',
    slot: commitResult.assignedSlot,
    conversationId: snapshot.conversationId,
    transcript: resolvedTranscript,
    stepCount: snapshot.stepCount,
    restoredCount: snapshot.restoredCount,
    needsRestoreCount: snapshot.needsRestoreCount,
    userStepIndex: snapshot.userStepIndex,
    mode: settings.mode,
  };
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export async function withLock(
  lockPath,
  fn,
  { maxWaitMs = 45000, staleMs = WORKER_STALE_LOCK_MS, retryMs = 120 } = {},
) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + Math.max(0, maxWaitMs);
  const lockToken = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  let acquired = false;

  const tryCreateLockExclusive = () => {
    const now = Date.now();
    const payload = JSON.stringify({
      pid: process.pid,
      token: lockToken,
      startedAt: now,
    });
    const tempLock = `${lockPath}.tmp-${lockToken}`;
    try {
      fs.writeFileSync(tempLock, payload, { encoding: 'utf8', mode: 0o600 });
      try {
        fs.linkSync(tempLock, lockPath);
        return { created: true, eexist: false };
      } catch (linkErr) {
        if (linkErr?.code === 'EEXIST') {
          return { created: false, eexist: true };
        }
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, payload, 'utf8');
        } finally {
          fs.closeSync(fd);
        }
        return { created: true, eexist: false };
      }
    } catch (err) {
      if (err?.code === 'EEXIST') {
        return { created: false, eexist: true };
      }
      throw err;
    } finally {
      try {
        if (fs.existsSync(tempLock)) {
          fs.unlinkSync(tempLock);
        }
      } catch {
        // Ignore temp lock cleanup race.
      }
    }
  };

  while (true) {
    let sawExistingLock = false;
    try {
      const res = tryCreateLockExclusive();
      if (res.created) {
        acquired = true;
        break;
      }
      sawExistingLock = res.eexist;
    } catch {
      sawExistingLock = false;
    }

    if (sawExistingLock) {
      try {
        const stat = fs.statSync(lockPath);
        let parsed = null;
        try {
          const raw = fs.readFileSync(lockPath, 'utf8');
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = null;
        }

        const now = Date.now();
        let isStale = false;
        if (parsed && typeof parsed === 'object') {
          const lastBeat = Math.max(
            typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
            typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
            stat.mtimeMs,
          );
          if (now - lastBeat > staleMs || !isPidAlive(parsed.pid)) {
            isStale = true;
          }
        } else if (now - stat.mtimeMs > staleMs) {
          isStale = true;
        }

        if (isStale) {
          const expectedToken = typeof parsed?.token === 'string' ? parsed.token : null;
          const expectedMtimeMs = stat.mtimeMs;
          const staleTrash = `${lockPath}.stale-${process.pid}-${now}-${Math.random().toString(16).slice(2, 8)}`;
          try {
            fs.renameSync(lockPath, staleTrash);
            let verifiedStale = false;
            try {
              const trashStat = fs.statSync(staleTrash);
              let trashParsed = null;
              try {
                const trashRaw = fs.readFileSync(staleTrash, 'utf8');
                trashParsed = trashRaw ? JSON.parse(trashRaw) : null;
              } catch {
                trashParsed = null;
              }
              verifiedStale = expectedToken
                ? trashParsed?.token === expectedToken
                : !trashParsed && trashStat.mtimeMs === expectedMtimeMs;

              if (!verifiedStale) {
                try {
                  fs.linkSync(staleTrash, lockPath);
                } catch {
                  // Another lock already took lockPath.
                }
              }
            } finally {
              try {
                fs.unlinkSync(staleTrash);
              } catch {
                // Ignore trash unlink error.
              }
            }
            if (verifiedStale) {
              continue;
            }
          } catch {
            // Another contender already evicted or replaced the stale lock.
          }
        }
      } catch (statErr) {
        if (statErr?.code === 'ENOENT' && Date.now() <= deadline) {
          continue;
        }
      }
    }

    if (Date.now() >= deadline) {
      break;
    }
    const remaining = deadline - Date.now();
    await sleep(Math.min(retryMs, Math.max(10, remaining)));
  }

  if (!acquired) {
    return { acquired: false };
  }

  const hbIntervalMs = Math.max(200, Math.min(10_000, Math.floor(staleMs / 3)));
  const heartbeatTimer = setInterval(() => {
    try {
      const raw = fs.readFileSync(lockPath, 'utf8');
      const info = JSON.parse(raw);
      if (info?.token !== lockToken) return;
      const nowSec = Date.now() / 1000;
      fs.utimesSync(lockPath, nowSec, nowSec);
    } catch {
      // Ignore transient heartbeat contention.
    }
  }, hbIntervalMs);
  heartbeatTimer.unref?.();

  try {
    const value = await fn();
    return { acquired: true, value };
  } finally {
    clearInterval(heartbeatTimer);
    try {
      const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (info?.token === lockToken) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Ignore cleanup races.
    }
  }
}

export async function readStdinText(timeoutMs = STDIN_READ_TIMEOUT_MS) {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
      try {
        process.stdin.pause();
        process.stdin.unref?.();
      } catch {
        // Ignore stream pause errors.
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    const onData = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    };
    const onEnd = () => finish();
    const onError = () => finish();

    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
    process.stdin.resume();
  });
}

export async function verifyControlRoomHealth(port, timeoutMs = 450, fetchImpl = globalThis.fetch) {
  try {
    const safePort = resolveControlRoomPort(port);
    const res = await fetchImpl(`http://127.0.0.1:${safePort}/api/health`, {
      headers: { Host: `127.0.0.1:${safePort}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.ok === true && data.app === CONTROL_ROOM_APP_ID) {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

export function readDaemonState(dataDir = resolveDataDir()) {
  const { daemonStatePath } = getDataPaths(dataDir);
  try {
    if (!fs.existsSync(daemonStatePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(daemonStatePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function isDaemonQuickAlive(dataDir = resolveDataDir()) {
  const info = readDaemonState(dataDir);
  return Boolean(
    info &&
      info.app === CONTROL_ROOM_APP_ID &&
      typeof info.pokeToken === 'string' &&
      info.pokeToken.length > 0 &&
      Number.isInteger(info.port) &&
      info.port >= 1 &&
      isPidAlive(info.pid),
  );
}

// On-demand daemon principle: NEVER start the daemon here; only poke if already alive.
export async function pokeControlRoom(
  dataDir = resolveDataDir(),
  timeoutMs = 250,
  fetchImpl = globalThis.fetch,
) {
  try {
    const info = readDaemonState(dataDir);
    if (!info || !info.pokeToken || !isPidAlive(info.pid)) return false;
    const safePort = resolveControlRoomPort(info.port);
    const res = await fetchImpl(`http://127.0.0.1:${safePort}/api/poke`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${safePort}`,
        'X-Poke-Token': info.pokeToken,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function isSidecarViewerActive(
  heartbeatPath = SIDECAR_VIEWER_HEARTBEAT_PATH,
  ttlMs = SIDECAR_VIEWER_TTL_MS,
) {
  try {
    if (!heartbeatPath || !fs.existsSync(heartbeatPath)) return false;
    const raw = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8'));
    const updatedAt = Number(raw?.updatedAt);
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > ttlMs) {
      return false;
    }
    const pid = Number(raw?.pid);
    if (Number.isInteger(pid) && pid > 0 && !isPidAlive(pid)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function runSingleFlightWorker({
  transcriptPath = '',
  conversationId = '',
  dataDir = resolveDataDir(),
  brainDirs = resolveBrainDirs(),
  allowNetwork = true,
  requireActiveClient = true,
  healthCheckImpl = verifyControlRoomHealth,
  initialDelayMs = 180,
  trailingDelayMs = 320,
  maxTrailingPasses = 6,
  fetchImpl = globalThis.fetch,
} = {}) {
  const resolvedForLock = resolveTranscriptCandidate(transcriptPath, conversationId, {
    allowMtimeFallback: false,
    brainDirs,
  });
  const lockConvId = inferConversationId(resolvedForLock || '', conversationId);
  const workerLockPath = getWorkerLockPath(lockConvId, dataDir);
  const workerDirtyPath = getWorkerDirtyPath(lockConvId, dataDir);
  let passesExecuted = 0;
  let lastResult = null;

  const statTargetTranscript = () => {
    const tp = resolveTranscriptCandidate(transcriptPath, conversationId, {
      allowMtimeFallback: false,
      brainDirs,
    });
    if (!tp) return { mtimeMs: 0, size: 0 };
    try {
      const st = fs.statSync(tp);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return { mtimeMs: 0, size: 0 };
    }
  };

  const executeWorkerCycle = async () => {
    let lastStat = { mtimeMs: 0, size: 0 };
    const runPass = async () => {
      lastStat = statTargetTranscript();
      passesExecuted += 1;
      try {
        const daemonInfo = isDaemonQuickAlive(dataDir) ? readDaemonState(dataDir) : null;
        let health = null;
        if (daemonInfo && Number.isInteger(daemonInfo.port) && daemonInfo.port >= 1) {
          health = await healthCheckImpl(daemonInfo.port, 350, fetchImpl);
        }
        const hasOpenClient = Boolean(
          (health && Number(health.clients) > 0) ||
            isSidecarViewerActive(getDataPaths(dataDir).sidecarViewerHeartbeatPath),
        );
        const effectiveAllowNetwork = Boolean(
          allowNetwork && (!requireActiveClient || hasOpenClient),
        );

        lastResult = await exportLatestThoughts({
          transcriptPath,
          conversationId,
          dataDir,
          brainDirs,
          allowNetwork: effectiveAllowNetwork,
          hookMode: false,
          allowMtimeFallback: false,
          timeoutMs: 15000,
          fetchImpl,
        });
        if (health) {
          await pokeControlRoom(dataDir, 250, fetchImpl);
        }
      } catch {
        // Ignore transient file contention.
      }
    };

    consumeWorkerDirty(workerDirtyPath);
    if (initialDelayMs > 0) await sleep(initialDelayMs);
    await runPass();

    for (let trailing = 0; trailing < maxTrailingPasses; trailing += 1) {
      if (trailingDelayMs > 0) await sleep(trailingDelayMs);
      const wasDirty = consumeWorkerDirty(workerDirtyPath);
      const curStat = statTargetTranscript();
      const changed = curStat.mtimeMs !== lastStat.mtimeMs || curStat.size !== lastStat.size;
      if (!wasDirty && !changed) {
        break;
      }
      await runPass();
    }
  };

  const firstAttempt = await withLock(workerLockPath, executeWorkerCycle, {
    maxWaitMs: 0,
    staleMs: WORKER_STALE_LOCK_MS,
  });

  if (!firstAttempt.acquired) {
    markWorkerDirty(workerDirtyPath, { conversationId: lockConvId });
    return { acquired: false, markedDirty: true, passesExecuted: 0, lastResult: null };
  }

  if (fs.existsSync(workerDirtyPath)) {
    await withLock(workerLockPath, executeWorkerCycle, {
      maxWaitMs: 0,
      staleMs: WORKER_STALE_LOCK_MS,
    });
  }

  return { acquired: true, markedDirty: false, passesExecuted, lastResult };
}

function parseWorkerCliArgs(argv) {
  const opts = {
    mode: '',
    transcriptPath: '',
    conversationId: '',
    dataDir: resolveDataDir(),
    allowNetwork: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--worker') opts.mode = 'worker';
    else if (arg === '--cli') opts.mode = 'cli';
    else if (arg === '--no-network') opts.allowNetwork = false;
    else if (arg === '--transcript' && argv[i + 1]) opts.transcriptPath = argv[++i];
    else if (arg === '--conv' && argv[i + 1]) opts.conversationId = argv[++i];
    else if (arg === '--data-dir' && argv[i + 1]) opts.dataDir = path.resolve(argv[++i]);
  }
  return opts;
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
  const cli = parseWorkerCliArgs(process.argv.slice(2));
  if (cli.mode === 'worker') {
    runSingleFlightWorker({
      transcriptPath: cli.transcriptPath,
      conversationId: cli.conversationId,
      dataDir: cli.dataDir,
      allowNetwork: cli.allowNetwork,
    }).catch(() => {});
  } else if (cli.mode === 'cli') {
    exportLatestThoughts({
      transcriptPath: cli.transcriptPath,
      conversationId: cli.conversationId,
      dataDir: cli.dataDir,
      allowNetwork: cli.allowNetwork,
      hookMode: false,
      allowMtimeFallback: true,
    })
      .then((res) => {
        process.stdout.write(`${JSON.stringify(res)}\n`);
      })
      .catch((err) => {
        process.stdout.write(`${JSON.stringify({ updated: false, error: String(err?.message || err) })}\n`);
        process.exitCode = 1;
      });
  }
}
