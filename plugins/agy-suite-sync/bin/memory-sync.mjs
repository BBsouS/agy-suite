import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..');
const INSTALL_META_PATH = path.join(PLUGIN_ROOT, 'install-meta.json');
const TEMPLATES_DIR = path.join(PLUGIN_ROOT, 'templates');

const WORK_NOTES_FILE = 'WORK_NOTES.md';
const GEMINI_MD_FILE = 'GEMINI.md';
const WORK_NOTE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const WORK_NOTE_BLOCK_RE =
  /^<!--\s*worknote:start\s+id=(["']?)([^\s>"']+)\1[^>]*-->[\s\S]*?^<!--\s*worknote:end(?:\s+id=(["']?)([^\s>"']+)\3)?\s*-->/gm;
const WORK_NOTE_DONE_RE = /^<!--\s*worknote:done\s+id=(["']?)([^\s>"']+)\1[^>]*-->\s*$/gm;

export const MEMORY_WARN_CHARS = 9500;
export const MEMORY_WARN_BYTES = 18000;
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;

const DEFAULT_PULL_COOLDOWN_MS = 45_000;
const CORRUPT_LOCK_GRACE_MS = 5_000;
const MAX_LOCK_AGE_MS = 2 * 60 * 1000;
const WORKER_PENDING_STALE_MS = 2 * 60 * 1000;
const STDIN_READ_TIMEOUT_MS = 500;
const RETRYABLE_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const FAILURE_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];

const FALLBACK_STARTERS = Object.freeze({
  'MEMORY.md': `# Active Working Memory\n\nKeep this file concise (< 9,500 chars / 18 KB) to preserve KV prefix cache and avoid 24 KB rule truncation.\nMove completed details to MEMORY_ARCHIVE.md.\n`,
  'MEMORY_ARCHIVE.md': `# Memory Archive\n\nOn-demand historical notes (not always loaded into system rules).\n`,
  'WORK_NOTES.md': `# Work Notes Inbox\n\n<!-- External bots or mobile tools append worknote:start / worknote:end blocks below. -->\n`,
});

export const SECRET_PATTERNS = [
  { name: 'private_key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'github_token', re: /\b(?:ghp_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{22,})\b/ },
  { name: 'anthropic_or_openai_key', re: /\bsk-(?:ant-(?:api\d+-)?[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{24,})\b/ },
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'slack_token', re: /\bxox[baprs]-[0-9A-Za-z-]{16,}\b/ },
];

export function normLf(s) {
  return String(s ?? '').replace(/\r\n/g, '\n');
}

function normalizeWhitespace(s) {
  return normLf(s).replace(/\s+/g, ' ').trim();
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
      // Spin fallback when SharedArrayBuffer is unavailable.
    }
  }
}

export function redactSecrets(text) {
  let out = String(text ?? '');
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s@]+)@/g, '$1***@');
  for (const pat of SECRET_PATTERNS) {
    const globalRe = new RegExp(pat.re.source, 'g');
    out = out.replace(globalRe, `[REDACTED:${pat.name}]`);
  }
  return out;
}

function readInstallMeta(metaPath = INSTALL_META_PATH) {
  try {
    if (fs.existsSync(metaPath)) {
      const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    // Ignore invalid install-meta.json.
  }
  return null;
}

function readJsonSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    // Ignore invalid JSON.
  }
  return null;
}

export function resolvePaths(env = process.env, { metaPath = INSTALL_META_PATH } = {}) {
  const meta = readInstallMeta(metaPath);
  const envGeminiDir = (env.AGY_SUITE_SYNC_GEMINI_DIR || env.AGY_SUITE_GEMINI_DIR || '').trim();
  const metaGeminiDir = typeof meta?.geminiDir === 'string' ? meta.geminiDir.trim() : '';
  const baseGeminiDir = envGeminiDir || metaGeminiDir || path.join(os.homedir(), '.gemini');

  const envDataDir = (env.AGY_SUITE_SYNC_DATA_DIR || '').trim();
  const metaDataDir = typeof meta?.dataDir === 'string' ? meta.dataDir.trim() : '';
  const dataDir = envDataDir || metaDataDir || path.join(baseGeminiDir, 'agy-suite', 'sync');

  const configPath = path.join(dataDir, 'config.json');
  let geminiDir = baseGeminiDir;
  if (!envGeminiDir) {
    const cfgObj = readJsonSafe(configPath);
    if (typeof cfgObj?.geminiDir === 'string' && cfgObj.geminiDir.trim()) {
      geminiDir = cfgObj.geminiDir.trim();
    }
  }

  return {
    dataDir,
    geminiDir,
    configPath,
    statePath: path.join(dataDir, 'sync-state.json'),
    lockPath: path.join(dataDir, 'sync.lock'),
    pullLockPath: path.join(dataDir, 'pull.lock'),
    dirtyPath: path.join(dataDir, 'sync.dirty'),
    workerPendingPath: path.join(dataDir, 'worker.pending'),
    basesDir: path.join(dataDir, 'bases'),
    repoDir: path.join(dataDir, 'sync-repo'),
  };
}

export function loadConfig(env = process.env, options = {}) {
  const paths = resolvePaths(env, options);
  const fileCfg = readJsonSafe(paths.configPath) || {};

  let mode = 'local';
  if (fileCfg.mode === 'git') mode = 'git';
  else if (fileCfg.mode === 'local') mode = 'local';
  else if (typeof fileCfg.gitEnabled === 'boolean') mode = fileCfg.gitEnabled ? 'git' : 'local';

  if (env.AGY_SUITE_SYNC_MODE === 'git') mode = 'git';
  else if (env.AGY_SUITE_SYNC_MODE === 'local') mode = 'local';
  if (env.AGY_SUITE_SYNC_GIT_ENABLED === '1' || env.AGY_SUITE_SYNC_GIT_ENABLED === 'true') mode = 'git';
  if (env.AGY_SUITE_SYNC_GIT_ENABLED === '0' || env.AGY_SUITE_SYNC_GIT_ENABLED === 'false') mode = 'local';

  const workNotesEnabled =
    typeof fileCfg.workNotesEnabled === 'boolean'
      ? fileCfg.workNotesEnabled
      : typeof fileCfg.syncWorkNotes === 'boolean'
        ? fileCfg.syncWorkNotes
        : false;

  const syncGeminiMd =
    env.AGY_SUITE_SYNC_GEMINI_MD === '1' || env.AGY_SUITE_SYNC_GEMINI_MD === 'true'
      ? true
      : env.AGY_SUITE_SYNC_GEMINI_MD === '0' || env.AGY_SUITE_SYNC_GEMINI_MD === 'false'
        ? false
        : fileCfg.syncGeminiMd === true;

  const allowCreateGeminiMd =
    env.AGY_SUITE_SYNC_ALLOW_CREATE_GEMINI_MD === '1' ||
    env.AGY_SUITE_SYNC_ALLOW_CREATE_GEMINI_MD === 'true' ||
    fileCfg.allowCreateGeminiMd === true ||
    fileCfg.createGeminiMd === true;

  const cfg = {
    mode,
    gitEnabled: mode === 'git',
    geminiDir: paths.geminiDir,
    remoteUrl: typeof fileCfg.remoteUrl === 'string' ? fileCfg.remoteUrl.trim() : '',
    branch: typeof fileCfg.branch === 'string' && fileCfg.branch.trim() ? fileCfg.branch.trim() : 'main',
    workNotesEnabled,
    syncWorkNotes: workNotesEnabled,
    syncGeminiMd,
    allowCreateGeminiMd,
    pullCooldownMs:
      typeof fileCfg.pullCooldownMs === 'number' && fileCfg.pullCooldownMs >= 0
        ? fileCfg.pullCooldownMs
        : DEFAULT_PULL_COOLDOWN_MS,
  };
  if (env.AGY_SUITE_SYNC_REMOTE_URL) cfg.remoteUrl = env.AGY_SUITE_SYNC_REMOTE_URL.trim();
  if (env.AGY_SUITE_SYNC_BRANCH) cfg.branch = env.AGY_SUITE_SYNC_BRANCH.trim();
  if (env.AGY_SUITE_SYNC_PULL_COOLDOWN_MS !== undefined) {
    const n = Number(env.AGY_SUITE_SYNC_PULL_COOLDOWN_MS);
    if (Number.isFinite(n) && n >= 0) cfg.pullCooldownMs = n;
  }
  return cfg;
}

export function loadState(statePath) {
  const fallback = {
    hashes: {},
    conflictHashes: {},
    lastSyncAt: 0,
    lastPullAttemptAt: 0,
    lastFailureAt: 0,
    lastStatus: 'ok',
    consecutiveFailures: 0,
    lastError: '',
  };
  try {
    if (!fs.existsSync(statePath)) return fallback;
    const p = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return {
      hashes: p?.hashes && typeof p.hashes === 'object' ? p.hashes : {},
      conflictHashes: p?.conflictHashes && typeof p.conflictHashes === 'object' ? p.conflictHashes : {},
      lastSyncAt: typeof p?.lastSyncAt === 'number' ? p.lastSyncAt : 0,
      lastPullAttemptAt: typeof p?.lastPullAttemptAt === 'number' ? p.lastPullAttemptAt : 0,
      lastFailureAt: typeof p?.lastFailureAt === 'number' ? p.lastFailureAt : 0,
      lastStatus: typeof p?.lastStatus === 'string' ? p.lastStatus : 'ok',
      consecutiveFailures: typeof p?.consecutiveFailures === 'number' ? p.consecutiveFailures : 0,
      lastError: typeof p?.lastError === 'string' ? p.lastError : '',
    };
  } catch {
    return fallback;
  }
}

export function atomicWriteText(dstPath, content) {
  const normalized = normLf(content);
  let targetPath = dstPath;
  let origMode;
  if (fs.existsSync(dstPath)) {
    try {
      targetPath = fs.realpathSync(dstPath);
    } catch {
      targetPath = dstPath;
    }
    try {
      origMode = fs.statSync(targetPath).mode & 0o777;
    } catch {
      origMode = undefined;
    }
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, normalized, origMode !== undefined ? { encoding: 'utf8', mode: origMode } : 'utf8');
    if (origMode !== undefined) {
      try {
        fs.chmodSync(tmp, origMode);
      } catch {
        // Best-effort mode preservation on platforms that ignore chmod bits.
      }
    }

    let renameErr = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.renameSync(tmp, targetPath);
        renameErr = null;
        break;
      } catch (err) {
        renameErr = err;
        if (err?.code === 'EXDEV') break;
        if (!RETRYABLE_FS_CODES.has(err?.code) || attempt === 4) break;
        syncSleepMs(15 * 2 ** attempt);
      }
    }

    if (renameErr) {
      if (renameErr.code === 'EXDEV' || RETRYABLE_FS_CODES.has(renameErr.code)) {
        let copyErr = null;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            fs.copyFileSync(tmp, targetPath);
            copyErr = null;
            break;
          } catch (err) {
            copyErr = err;
            if (!RETRYABLE_FS_CODES.has(err?.code) || attempt === 4) break;
            syncSleepMs(15 * 2 ** attempt);
          }
        }
        if (copyErr) throw copyErr;
        if (origMode !== undefined) {
          try {
            fs.chmodSync(targetPath, origMode);
          } catch {
            // Best-effort mode preservation.
          }
        }
      } else {
        throw renameErr;
      }
    }
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup of temp file.
    }
  }
}

export function saveState(statePath, state) {
  const sanitized = {
    ...state,
    lastError: redactSecrets(state?.lastError || ''),
  };
  const serialized = `${JSON.stringify(sanitized, null, 2)}\n`;
  try {
    atomicWriteText(statePath, serialized);
    return true;
  } catch (err) {
    // Retry direct fallback write before giving up so hashes are not silently lost.
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, serialized, 'utf8');
      return true;
    } catch (fallbackErr) {
      try {
        process.stderr.write(
          `[agy-suite-sync] Failed to persist state (${statePath}): ${redactSecrets(fallbackErr?.message || err?.message || 'unknown error')}\n`,
        );
      } catch {
        // Ignore stderr write failure.
      }
      return false;
    }
  }
}

export function sha256Normalized(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const text = normLf(fs.readFileSync(filePath, 'utf8'));
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(normLf(text), 'utf8').digest('hex');
}

function atomicWriteTextIfChanged(dstPath, content) {
  const normalized = normLf(content);
  if (fs.existsSync(dstPath) && normLf(fs.readFileSync(dstPath, 'utf8')) === normalized) return false;
  atomicWriteText(dstPath, normalized);
  return true;
}

function getBaseFilePath(basesDir, name) {
  const safeName = path.basename(name);
  if (!safeName || safeName !== name || safeName === '.' || safeName === '..') {
    throw new Error(`Invalid tracked file name: ${name}`);
  }
  return path.join(basesDir, safeName);
}

function readPersistedBase(basesDir, name) {
  const p = getBaseFilePath(basesDir, name);
  if (!fs.existsSync(p)) return { exists: false, content: '' };
  return { exists: true, content: normLf(fs.readFileSync(p, 'utf8')) };
}

function writePersistedBase(basesDir, name, content) {
  const p = getBaseFilePath(basesDir, name);
  atomicWriteTextIfChanged(p, normLf(content));
}

export function isStarterOrEmpty(name, text, templatesDir = TEMPLATES_DIR) {
  const norm = normalizeWhitespace(text);
  if (!norm) return true;
  const tplPath = path.join(templatesDir, path.basename(name));
  try {
    if (fs.existsSync(tplPath)) {
      const tpl = fs.readFileSync(tplPath, 'utf8');
      if (norm === normalizeWhitespace(tpl)) return true;
    }
  } catch {
    // Ignore template read error.
  }
  if (Object.prototype.hasOwnProperty.call(FALLBACK_STARTERS, name)) {
    if (norm === normalizeWhitespace(FALLBACK_STARTERS[name])) return true;
  }
  return false;
}

export function detectHighConfidenceSecret(text) {
  const s = String(text || '');
  for (const pat of SECRET_PATTERNS) {
    if (pat.re.test(s)) return pat.name;
  }
  return '';
}

export function extractAddedLines(oldText, newText) {
  const oldLines = normLf(oldText).split('\n');
  const newLines = normLf(newText).split('\n');
  const oldCounts = new Map();
  for (const line of oldLines) {
    oldCounts.set(line, (oldCounts.get(line) || 0) + 1);
  }
  const added = [];
  for (const line of newLines) {
    const rem = oldCounts.get(line) || 0;
    if (rem > 0) {
      oldCounts.set(line, rem - 1);
    } else {
      added.push(line);
    }
  }
  return added.join('\n');
}

export function getTrackedItems(geminiDir, cfg) {
  const items = [
    { name: 'MEMORY.md', localPath: path.join(geminiDir, 'MEMORY.md') },
    { name: 'MEMORY_ARCHIVE.md', localPath: path.join(geminiDir, 'MEMORY_ARCHIVE.md') },
  ];
  if (cfg.syncGeminiMd === true) {
    const geminiMdPath = path.join(geminiDir, GEMINI_MD_FILE);
    if (fs.existsSync(geminiMdPath) || cfg.allowCreateGeminiMd === true) {
      items.push({ name: GEMINI_MD_FILE, localPath: geminiMdPath });
    }
  }
  const trackWorkNotes =
    typeof cfg.workNotesEnabled === 'boolean' ? cfg.workNotesEnabled : cfg.syncWorkNotes === true;
  if (trackWorkNotes) {
    items.push({ name: WORK_NOTES_FILE, localPath: path.join(geminiDir, WORK_NOTES_FILE) });
  }
  return items;
}

export function hasLocalEdits(paths, cfg) {
  const state = loadState(paths.statePath);
  for (const { name, localPath } of getTrackedItems(paths.geminiDir, cfg)) {
    const h = sha256Normalized(localPath);
    if (h && h !== state.hashes[name]) return true;
  }
  return false;
}

export function getFailureBackoffMs(consecutiveFailures) {
  if (!Number.isFinite(consecutiveFailures) || consecutiveFailures <= 0) return 0;
  const idx = Math.min(Math.floor(consecutiveFailures) - 1, FAILURE_BACKOFF_MS.length - 1);
  return FAILURE_BACKOFF_MS[idx];
}

function hasConflictLocalHashChanged(paths, cfg, state) {
  const conflictHashes = state?.conflictHashes || {};
  const keys = Object.keys(conflictHashes);
  if (keys.length === 0) return false;
  for (const name of keys) {
    const localPath = path.join(paths.geminiDir, path.basename(name));
    const curHash = sha256Normalized(localPath);
    if (curHash !== conflictHashes[name]) return true;
  }
  return false;
}

export function shouldBackoffWorkerSpawn(paths, cfg, state, now = Date.now()) {
  if (state.lastStatus === 'conflict') {
    return !hasConflictLocalHashChanged(paths, cfg, state);
  }
  if (state.consecutiveFailures > 0) {
    const backoffMs = getFailureBackoffMs(state.consecutiveFailures);
    const lastAttempt = Math.max(state.lastFailureAt || 0, state.lastPullAttemptAt || 0);
    if (now - lastAttempt < backoffMs) return true;
  }
  return false;
}

export function parseWorkNoteBlocks(rawText) {
  const txt = normLf(rawText);
  const matches = [];
  let m;

  const blockRe = new RegExp(WORK_NOTE_BLOCK_RE.source, 'gm');
  while ((m = blockRe.exec(txt)) !== null) {
    const startId = String(m[2] || '').trim();
    const endId = m[4] !== undefined ? String(m[4]).trim() : '';
    if (!WORK_NOTE_ID_RE.test(startId)) continue;
    if (endId && endId !== startId) continue;
    matches.push({
      kind: 'block',
      id: startId,
      start: m.index,
      end: m.index + m[0].length,
      text: m[0].trim(),
    });
  }

  const doneRe = new RegExp(WORK_NOTE_DONE_RE.source, 'gm');
  while ((m = doneRe.exec(txt)) !== null) {
    const id = String(m[2] || '').trim();
    if (!WORK_NOTE_ID_RE.test(id)) continue;
    matches.push({
      kind: 'receipt',
      id,
      start: m.index,
      end: m.index + m[0].length,
      text: m[0].trim(),
    });
  }

  matches.sort((a, b) => a.start - b.start || (a.kind === 'block' ? -1 : 1));
  const nonOverlapping = [];
  let cursor = 0;
  for (const item of matches) {
    if (item.start < cursor) continue;
    nonOverlapping.push(item);
    cursor = item.end;
  }

  const blocks = new Map();
  const order = [];
  const receipts = new Map();
  const receiptOrder = [];
  const afterFree = new Map();

  for (let i = 0; i < nonOverlapping.length; i += 1) {
    const item = nonOverlapping[i];
    if (item.kind === 'block') {
      if (!blocks.has(item.id)) order.push(item.id);
      blocks.set(item.id, item.text);
    } else {
      if (!receipts.has(item.id)) receiptOrder.push(item.id);
      receipts.set(item.id, item.text);
    }
    if (i < nonOverlapping.length - 1) {
      const gap = txt.slice(item.end, nonOverlapping[i + 1].start).trim();
      if (gap) {
        const key = `${item.kind}:${item.id}`;
        const prev = afterFree.get(key);
        afterFree.set(key, prev ? `${prev}\n\n${gap}` : gap);
      }
    }
  }

  const header = nonOverlapping.length > 0 ? txt.slice(0, nonOverlapping[0].start).trim() : txt.trim();
  const trailing =
    nonOverlapping.length > 0 ? txt.slice(nonOverlapping[nonOverlapping.length - 1].end).trim() : '';

  return { header, blocks, order, receipts, receiptOrder, afterFree, trailing };
}

function mergeTextThreeWaySimple(baseStr, localStr, remoteStr) {
  const b = normLf(baseStr || '').trim();
  const l = normLf(localStr || '').trim();
  const r = normLf(remoteStr || '').trim();
  if (l === b) return r;
  if (r === b || l === r) return l;
  if (!l) return r;
  if (!r) return l;
  const m3 = mergeFileThreeWay(b, l, r);
  if (m3.ok) return m3.content.trim();
  return `${l}\n\n${r}`;
}

export function mergeWorkNotesDetailed(baseText, localText, remoteText) {
  const baseP = parseWorkNoteBlocks(baseText);
  const localP = parseWorkNoteBlocks(localText);
  const remoteP = parseWorkNoteBlocks(remoteText);

  const conflictedIds = [];

  const outReceipts = [];
  const placedReceipts = new Set();
  for (const id of remoteP.receiptOrder) {
    if (baseP.receipts.has(id) && !localP.receipts.has(id)) continue;
    const baseRec = baseP.receipts.get(id);
    const localRec = localP.receipts.get(id);
    const remoteRec = remoteP.receipts.get(id);
    let chosen = remoteRec;
    if (localRec && localRec !== baseRec && remoteRec === baseRec) {
      chosen = localRec;
    } else if (localRec && remoteRec && localRec !== remoteRec && localRec !== baseRec && remoteRec !== baseRec) {
      chosen = `<<<<<<< local\n${localRec}\n=======\n${remoteRec}\n>>>>>>> remote`;
      conflictedIds.push(id);
    }
    outReceipts.push({ id, text: chosen });
    placedReceipts.add(id);
  }
  for (const id of localP.receiptOrder) {
    if (placedReceipts.has(id) || baseP.receipts.has(id)) continue; // Honor remote GC of older receipts.
    const localRec = localP.receipts.get(id);
    if (localRec) {
      outReceipts.push({ id, text: localRec });
      placedReceipts.add(id);
    }
  }

  const deletedLocally = new Set(baseP.order.filter((id) => !localP.blocks.has(id)));
  const outBlocks = [];
  const placed = new Set();
  for (const id of remoteP.order) {
    if (deletedLocally.has(id) || placedReceipts.has(id)) continue;
    const baseBlk = baseP.blocks.get(id);
    const localBlk = localP.blocks.get(id);
    const remoteBlk = remoteP.blocks.get(id);
    let chosen = remoteBlk;
    if (localBlk && localBlk !== baseBlk && remoteBlk === baseBlk) {
      chosen = localBlk;
    } else if (localBlk && remoteBlk && localBlk !== remoteBlk && localBlk !== baseBlk && remoteBlk !== baseBlk) {
      chosen = `<<<<<<< local\n${localBlk}\n=======\n${remoteBlk}\n>>>>>>> remote`;
      conflictedIds.push(id);
    }
    outBlocks.push({ id, text: chosen });
    placed.add(id);
  }
  for (const id of localP.order) {
    if (placed.has(id) || placedReceipts.has(id) || baseP.blocks.has(id)) continue;
    const localBlk = localP.blocks.get(id);
    if (localBlk) {
      outBlocks.push({ id, text: localBlk });
      placed.add(id);
    }
  }

  // Merge inter-block free text keyed by preceding item, carrying orphaned free text forward.
  const allFreeKeys = new Set([
    ...baseP.afterFree.keys(),
    ...localP.afterFree.keys(),
    ...remoteP.afterFree.keys(),
  ]);
  const mergedFreeByKey = new Map();
  for (const key of allFreeKeys) {
    const merged = mergeTextThreeWaySimple(
      baseP.afterFree.get(key) || '',
      localP.afterFree.get(key) || '',
      remoteP.afterFree.get(key) || '',
    );
    if (merged) mergedFreeByKey.set(key, merged);
  }

  const usedFreeKeys = new Set();
  const sections = [];
  for (const blk of outBlocks) {
    sections.push(blk.text);
    const key = `block:${blk.id}`;
    if (mergedFreeByKey.has(key)) {
      sections.push(mergedFreeByKey.get(key));
      usedFreeKeys.add(key);
    }
  }
  for (const rec of outReceipts) {
    sections.push(rec.text);
    const recKey = `receipt:${rec.id}`;
    const blkKey = `block:${rec.id}`;
    if (mergedFreeByKey.has(recKey)) {
      sections.push(mergedFreeByKey.get(recKey));
      usedFreeKeys.add(recKey);
    }
    if (mergedFreeByKey.has(blkKey) && !usedFreeKeys.has(blkKey)) {
      sections.push(mergedFreeByKey.get(blkKey));
      usedFreeKeys.add(blkKey);
    }
  }
  for (const [key, text] of mergedFreeByKey.entries()) {
    if (!usedFreeKeys.has(key) && text) {
      sections.push(text);
    }
  }

  const mergedTrailing = mergeTextThreeWaySimple(baseP.trailing, localP.trailing, remoteP.trailing);
  if (mergedTrailing) sections.push(mergedTrailing);

  const mergedHeader =
    mergeTextThreeWaySimple(baseP.header, localP.header, remoteP.header) || '# Work Notes Inbox';

  const content = sections.length
    ? `${mergedHeader.trimEnd()}\n\n${sections.join('\n\n')}\n`
    : `${mergedHeader.trimEnd()}\n`;

  return {
    content,
    hasConflict: conflictedIds.length > 0,
    conflictedIds,
  };
}

export function mergeWorkNotesByBlockId(baseText, localText, remoteText) {
  return mergeWorkNotesDetailed(baseText, localText, remoteText).content;
}

export function checkMemoryBudget(geminiDir) {
  const memPath = path.join(geminiDir, 'MEMORY.md');
  if (!fs.existsSync(memPath)) return { exists: false, chars: 0, bytes: 0, overBudget: false, warning: '' };
  const text = fs.readFileSync(memPath, 'utf8');
  const chars = text.length;
  const bytes = Buffer.byteLength(text, 'utf8');
  const overBudget = chars >= MEMORY_WARN_CHARS || bytes >= MEMORY_WARN_BYTES;
  const warning = overBudget
    ? `[agy-suite-sync] MEMORY.md budget warning: ${chars.toLocaleString('en-US')} chars / ${bytes.toLocaleString('en-US')} B (recommended < ${MEMORY_WARN_CHARS.toLocaleString('en-US')} chars & ${Math.round(MEMORY_WARN_BYTES / 1000)} KB). Archive completed entries to MEMORY_ARCHIVE.md.`
    : '';
  return { exists: true, chars, bytes, overBudget, warning };
}

export function countPendingWorkNotes(geminiDir) {
  const wnPath = path.join(geminiDir, WORK_NOTES_FILE);
  if (!fs.existsSync(wnPath)) return 0;
  try {
    return parseWorkNoteBlocks(fs.readFileSync(wnPath, 'utf8')).order.length;
  } catch {
    return 0;
  }
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

function isLockStale(lockPath, maxAgeMs = MAX_LOCK_AGE_MS) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    return false;
  }
  try {
    const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (!info || typeof info.pid !== 'number') {
      return Date.now() - stat.mtimeMs >= CORRUPT_LOCK_GRACE_MS;
    }
    const startedAt = typeof info.startedAt === 'number' ? info.startedAt : stat.mtimeMs;
    if (Date.now() - startedAt >= maxAgeMs) return true;
    return !isPidAlive(info.pid);
  } catch {
    return Date.now() - stat.mtimeMs >= CORRUPT_LOCK_GRACE_MS;
  }
}

function isLockHeldByLivePid(lockPath) {
  if (!fs.existsSync(lockPath)) return false;
  return !isLockStale(lockPath, MAX_LOCK_AGE_MS);
}

function tryStealStaleFileAtomically(filePath) {
  const stalePath = `${filePath}.stale-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(filePath, stalePath);
  } catch {
    return false;
  }
  try {
    fs.unlinkSync(stalePath);
  } catch {
    // Best-effort removal after atomic steal.
  }
  return true;
}

function tryAcquireLockOnce(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let i = 0; i < 2; i += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') return false;
      if (isLockStale(lockPath, MAX_LOCK_AGE_MS)) {
        if (tryStealStaleFileAtomically(lockPath)) continue;
      }
      return false;
    }
  }
  return false;
}

function releaseLock(lockPath) {
  try {
    const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (info?.pid === process.pid) fs.unlinkSync(lockPath);
  } catch {
    // Ignore cleanup race.
  }
}

function tryAcquireWorkerPending(pendingPath) {
  fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
  for (let i = 0; i < 2; i += 1) {
    try {
      const fd = fs.openSync(pendingPath, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') return false;
      try {
        const stat = fs.statSync(pendingPath);
        let createdAt = stat.mtimeMs;
        try {
          const parsed = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
          if (typeof parsed?.createdAt === 'number') createdAt = parsed.createdAt;
        } catch {
          // Use mtime fallback.
        }
        if (Date.now() - createdAt >= WORKER_PENDING_STALE_MS) {
          if (tryStealStaleFileAtomically(pendingPath)) continue;
        }
      } catch {
        continue;
      }
      return false;
    }
  }
  return false;
}

function clearWorkerPending(pendingPath) {
  try {
    if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
  } catch {
    // Ignore cleanup race.
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withLock(lockPath, fn, maxWaitMs = 15_000) {
  const deadline = Date.now() + maxWaitMs;
  let acquired = tryAcquireLockOnce(lockPath);
  while (!acquired && Date.now() < deadline) {
    await sleep(200);
    acquired = tryAcquireLockOnce(lockPath);
  }
  if (!acquired) return { synced: false, reason: 'lock_busy' };
  try {
    return await fn();
  } finally {
    releaseLock(lockPath);
  }
}

function hasGitCoreSshCommand(cwd, baseEnv) {
  try {
    const val = execFileSync('git', ['config', '--get', 'core.sshCommand'], {
      cwd: cwd && fs.existsSync(cwd) ? cwd : os.tmpdir(),
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: baseEnv,
    }).trim();
    return Boolean(val);
  } catch {
    return false;
  }
}

function buildGitEnv(env = process.env, cwd = undefined) {
  const baseEnv = {
    ...env,
    LC_ALL: 'C',
    LANGUAGE: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
  };
  if (env.AGY_SUITE_SYNC_GIT_SSH_COMMAND) {
    baseEnv.GIT_SSH_COMMAND = env.AGY_SUITE_SYNC_GIT_SSH_COMMAND;
  } else if (!env.GIT_SSH_COMMAND && !hasGitCoreSshCommand(cwd, baseEnv)) {
    baseEnv.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=5';
  }
  return baseEnv;
}

export function validateRemoteUrl(rawUrl) {
  const url = String(rawUrl ?? '').trim();
  if (!url) return { ok: false, error: 'remoteUrl is empty' };
  if (/[\x00-\x1f\x7f]/.test(url)) return { ok: false, error: 'remoteUrl contains control characters' };
  if (url.startsWith('-')) return { ok: false, error: 'remoteUrl must not start with "-"' };
  if (/(?:^|[\s/])ext::/i.test(url) || /^[A-Za-z0-9+.-]+::/i.test(url)) {
    return { ok: false, error: 'remoteUrl uses disallowed git remote helper transport' };
  }
  if (url.includes('://')) {
    if (/^(?:https|ssh|file):\/\/.+/i.test(url)) {
      if (/^file:\/\//i.test(url) && /ext::/i.test(url)) {
        return { ok: false, error: 'remoteUrl uses disallowed ext:: transport' };
      }
      return { ok: true, value: url };
    }
    return { ok: false, error: 'remoteUrl must use https://, ssh://, git@, file://, or a local path' };
  }
  if (/^git@[A-Za-z0-9._-]+:[^\s]+$/.test(url)) {
    return { ok: true, value: url };
  }
  // Allow local filesystem paths (including Windows drive paths and UNC paths) without leading '-' or helper '::'.
  if (/^[A-Za-z]:[\\/]/.test(url) || url.startsWith('\\\\') || url.startsWith('/') || url.startsWith('./') || url.startsWith('../') || !url.includes(':')) {
    return { ok: true, value: url };
  }
  return { ok: false, error: 'remoteUrl format is not allowed' };
}

export function validateBranch(rawBranch, { checkWithGit = true, env = process.env } = {}) {
  const branch = String(rawBranch ?? '').trim();
  if (!branch) return { ok: false, error: 'branch is empty' };
  if (/[\x00-\x1f\x7f]/.test(branch)) return { ok: false, error: 'branch contains control characters' };
  if (branch.startsWith('-')) return { ok: false, error: 'branch must not start with "-"' };
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
    return { ok: false, error: 'branch contains invalid characters' };
  }
  if (
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.endsWith('.lock') ||
    branch.split('/').some((seg) => !seg || seg === '.' || seg.startsWith('.') || seg.endsWith('.lock'))
  ) {
    return { ok: false, error: 'branch does not satisfy git ref format rules' };
  }
  if (checkWithGit) {
    try {
      execFileSync('git', ['check-ref-format', '--branch', branch], {
        cwd: os.tmpdir(),
        encoding: 'utf8',
        timeout: 4000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildGitEnv(env, os.tmpdir()),
      });
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        return { ok: false, error: `branch rejected by git check-ref-format: ${branch}` };
      }
    }
  }
  return { ok: true, value: branch };
}

function runGit(args, { cwd, timeout = 12_000, env = process.env } = {}) {
  const host = os.hostname() || 'local';
  const emailHost = host.toLowerCase().replace(/[^a-z0-9.-]/g, '-') || 'local';
  const gitEnv = buildGitEnv(env, cwd);
  const prefix = [
    '-c', 'protocol.ext.allow=never',
    '-c', 'credential.interactive=never',
    '-c', 'commit.gpgsign=false',
    '-c', 'tag.gpgsign=false',
    '-c', 'core.autocrlf=false',
    '-c', `user.name=AGY Suite (${host})`,
    '-c', `user.email=agy-suite@${emailHost}`,
  ];
  return execFileSync('git', [...prefix, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnv,
  }).trim();
}

export function readGitBlob(repoDir, rev, fileName, env = process.env) {
  const revStr = String(rev ?? '').trim();
  if (!revStr || revStr.startsWith('-')) {
    throw new Error(`Invalid git rev: ${revStr}`);
  }
  const gitEnv = buildGitEnv(env, repoDir);
  // Step 1: Verify rev is valid and check whether fileName exists in that tree.
  // Any invalid rev, corrupt object, or git/IO failure throws (fail-closed).
  const treeEntry = execFileSync(
    'git',
    ['-c', 'protocol.ext.allow=never', 'ls-tree', '-z', revStr, '--', String(fileName)],
    {
      cwd: repoDir,
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnv,
    },
  );
  if (!treeEntry.trim()) {
    return { exists: false, content: '' };
  }
  // Step 2: File exists in rev; read its exact blob bytes (throws on any IO/object/buffer error).
  const out = execFileSync(
    'git',
    ['-c', 'protocol.ext.allow=never', 'cat-file', '-p', `${revStr}:${fileName}`],
    {
      cwd: repoDir,
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnv,
    },
  );
  return { exists: true, content: normLf(out) };
}

export function mergeFileThreeWay(baseText, localText, remoteText, cwd = os.tmpdir(), env = process.env) {
  const b = normLf(baseText);
  const l = normLf(localText);
  const r = normLf(remoteText);
  if (l === b) return { ok: true, content: r };
  if (r === b || l === r) return { ok: true, content: l };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sync-m3-'));
  try {
    const fLocal = path.join(tmpDir, 'local.md');
    const fBase = path.join(tmpDir, 'base.md');
    const fRemote = path.join(tmpDir, 'remote.md');
    fs.writeFileSync(fLocal, l, 'utf8');
    fs.writeFileSync(fBase, b, 'utf8');
    fs.writeFileSync(fRemote, r, 'utf8');
    try {
      const merged = execFileSync('git', ['merge-file', '-p', '--quiet', fLocal, fBase, fRemote], {
        cwd,
        encoding: 'utf8',
        timeout: 6000,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildGitEnv(env, cwd),
      });
      return { ok: true, content: normLf(merged) };
    } catch {
      return { ok: false, content: null };
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function healRepoWorktree(repoDir, env) {
  const gitDir = path.join(repoDir, '.git');
  if (!fs.existsSync(gitDir)) return;

  // Caller holds exclusive sync.lock; remove stale git index.lock left by crashed runs.
  const indexLock = path.join(gitDir, 'index.lock');
  if (fs.existsSync(indexLock)) {
    try {
      fs.unlinkSync(indexLock);
    } catch {
      // Ignore removal error; subsequent git call will report if truly locked.
    }
  }

  // Abort any leftover in-progress merge.
  const mergeHead = path.join(gitDir, 'MERGE_HEAD');
  if (fs.existsSync(mergeHead)) {
    try {
      runGit(['merge', '--abort'], { cwd: repoDir, timeout: 4000, env });
    } catch {
      try {
        runGit(['reset', '--merge'], { cwd: repoDir, timeout: 4000, env });
      } catch {
        // Ignore fallback error.
      }
    }
  }
}

function ensureRepoInitialized(paths, cfg, env) {
  const parentDir = path.dirname(paths.repoDir);
  fs.mkdirSync(parentDir, { recursive: true });

  if (fs.existsSync(path.join(paths.repoDir, '.git'))) {
    healRepoWorktree(paths.repoDir, env);
    let currentOrigin = '';
    try {
      currentOrigin = runGit(['remote', 'get-url', 'origin'], { cwd: paths.repoDir, timeout: 4000, env });
    } catch {
      currentOrigin = '';
    }
    if (!currentOrigin) {
      runGit(['remote', 'add', 'origin', '--', cfg.remoteUrl], { cwd: paths.repoDir, timeout: 5000, env });
    } else if (currentOrigin !== cfg.remoteUrl) {
      runGit(['remote', 'set-url', 'origin', '--', cfg.remoteUrl], { cwd: paths.repoDir, timeout: 5000, env });
    }
    return;
  }

  // Remove partial/corrupt non-git sync-repo directory before cloning cleanly.
  if (fs.existsSync(paths.repoDir)) {
    fs.rmSync(paths.repoDir, { recursive: true, force: true });
  }

  const tempCloneDir = path.join(parentDir, `sync-repo.cloning-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  try {
    runGit(['clone', '--', cfg.remoteUrl, tempCloneDir], { cwd: parentDir, timeout: 15_000, env });
    const host = os.hostname() || 'local';
    const emailHost = host.toLowerCase().replace(/[^a-z0-9.-]/g, '-') || 'local';
    runGit(['config', 'user.name', `AGY Suite (${host})`], { cwd: tempCloneDir, env });
    runGit(['config', 'user.email', `agy-suite@${emailHost}`], { cwd: tempCloneDir, env });
    runGit(['config', 'core.autocrlf', 'false'], { cwd: tempCloneDir, env });
    fs.renameSync(tempCloneDir, paths.repoDir);
  } catch (err) {
    try {
      if (fs.existsSync(tempCloneDir)) fs.rmSync(tempCloneDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of temp clone directory.
    }
    throw err;
  }
}

function ensureGitattributes(repoDir) {
  const attrPath = path.join(repoDir, '.gitattributes');
  const desired = '*.md text eol=lf\n';
  if (fs.existsSync(attrPath) && normLf(fs.readFileSync(attrPath, 'utf8')) === desired) return false;
  atomicWriteText(attrPath, desired);
  return true;
}

function getRevOrEmpty(repoDir, ref, env) {
  try {
    return runGit(['rev-parse', '--verify', ref], { cwd: repoDir, timeout: 4000, env });
  } catch {
    return '';
  }
}

function isNonFastForwardError(err) {
  const msg = String(err?.stderr || err?.message || err || '');
  return /non-fast-forward|fetch first|\[rejected\]|failed to push some refs/i.test(msg);
}

function writeConflictBackupOnce(localPath, content) {
  const backupPath = `${localPath}.conflict.bak`;
  if (!fs.existsSync(backupPath)) {
    atomicWriteText(backupPath, content);
  }
  return backupPath;
}

function fetchOriginBranch(repoDir, branch, timeoutMs, env) {
  try {
    runGit(['fetch', '--', 'origin', branch], { cwd: repoDir, timeout: timeoutMs, env });
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err);
    if (!/couldn't find remote ref/i.test(msg)) throw err;
  }
}

export async function syncMemoryFiles({
  forcePull = false,
  timeoutMs = 12_000,
  lockWaitMs = 15_000,
  env = process.env,
} = {}) {
  const paths = resolvePaths(env);
  const cfg = loadConfig(env);
  if (!cfg.gitEnabled) return { synced: false, mode: 'local', reason: 'git_disabled' };

  const recordFailure = (status, error, extra = {}) => {
    const cur = loadState(paths.statePath);
    const now = Date.now();
    saveState(paths.statePath, {
      ...cur,
      ...extra,
      lastPullAttemptAt: now,
      lastFailureAt: now,
      lastStatus: status,
      consecutiveFailures: cur.consecutiveFailures + 1,
      lastError: redactSecrets(String(error)),
    });
  };

  if (!cfg.remoteUrl) {
    const error = 'Git sync is enabled but remoteUrl is not configured.';
    recordFailure('error', error);
    return { synced: false, status: 'error', error };
  }

  const urlCheck = validateRemoteUrl(cfg.remoteUrl);
  if (!urlCheck.ok) {
    const error = `Invalid remoteUrl: ${urlCheck.error}`;
    recordFailure('error', error);
    return { synced: false, status: 'error', error };
  }

  const branchCheck = validateBranch(cfg.branch, { checkWithGit: true, env });
  if (!branchCheck.ok) {
    const error = `Invalid branch: ${branchCheck.error}`;
    recordFailure('error', error);
    return { synced: false, status: 'error', error };
  }

  return withLock(paths.lockPath, async () => {
    const state = loadState(paths.statePath);
    const editedBefore = hasLocalEdits(paths, cfg);
    const lastActivity = Math.max(state.lastSyncAt, state.lastPullAttemptAt);
    if (!forcePull && !editedBefore && Date.now() - lastActivity < cfg.pullCooldownMs) {
      return { synced: false, reason: 'cooldown' };
    }

    try {
      ensureRepoInitialized(paths, cfg, env);
      const trackedItems = getTrackedItems(paths.geminiDir, cfg);
      const trackedNames = trackedItems.map((i) => i.name);

      // Snapshot local files & persisted bases BEFORE network operations.
      const startHashes = {};
      const localSnapshots = {};
      const persistedBases = {};
      for (const { name, localPath } of trackedItems) {
        const exists = fs.existsSync(localPath);
        const content = exists ? normLf(fs.readFileSync(localPath, 'utf8')) : '';
        startHashes[name] = exists ? sha256Text(content) : '';
        localSnapshots[name] = { exists, content };
        persistedBases[name] = readPersistedBase(paths.basesDir, name);
      }

      const branchRef = `origin/${cfg.branch}`;
      const localHeadAtStart = getRevOrEmpty(paths.repoDir, 'HEAD', env);

      let committedLocal = false;
      let pushed = false;
      let finalResolvedByFile = {};

      for (let attempt = 0; attempt < 2; attempt += 1) {
        fetchOriginBranch(paths.repoDir, cfg.branch, timeoutMs, env);
        const remoteHead = getRevOrEmpty(paths.repoDir, branchRef, env);

        const remoteBlobs = {};
        for (const name of trackedNames) {
          remoteBlobs[name] = remoteHead
            ? readGitBlob(paths.repoDir, remoteHead, name, env)
            : { exists: false, content: '' };
        }

        const resolvedByFile = {};
        const conflicts = [];
        const conflictHashes = {};
        let anyLocalChangeToPush = false;

        for (const item of trackedItems) {
          const { name, localPath } = item;
          const localSnap = localSnapshots[name];
          const remoteBlob = remoteBlobs[name];
          const stateHash = state.hashes[name] || '';
          const hasStateHash = Boolean(stateHash);

          // Determine base content when stateHash is present.
          let baseKnown = false;
          let baseText = '';
          if (hasStateHash) {
            if (persistedBases[name].exists) {
              baseKnown = true;
              baseText = persistedBases[name].content;
            } else if (localHeadAtStart) {
              try {
                const headBlob = readGitBlob(paths.repoDir, localHeadAtStart, name, env);
                if (headBlob.exists && sha256Text(headBlob.content) === stateHash) {
                  baseKnown = true;
                  baseText = headBlob.content;
                }
              } catch {
                baseKnown = false;
              }
            }
          }

          if (!hasStateHash || !baseKnown) {
            // P0: First sync or missing/corrupt state/base — NEVER blindly overwrite remote!
            if (remoteBlob.exists) {
              if (!localSnap.exists || localSnap.content === remoteBlob.content) {
                resolvedByFile[name] = remoteBlob.content;
              } else if (isStarterOrEmpty(name, localSnap.content)) {
                resolvedByFile[name] = remoteBlob.content;
              } else if (name === WORK_NOTES_FILE) {
                const wnRes = mergeWorkNotesDetailed('', localSnap.content, remoteBlob.content);
                if (wnRes.hasConflict) {
                  const backupPath = writeConflictBackupOnce(localPath, localSnap.content);
                  conflicts.push({ name, backupPath, conflictedIds: wnRes.conflictedIds });
                  conflictHashes[name] = startHashes[name];
                } else {
                  resolvedByFile[name] = wnRes.content;
                  if (wnRes.content !== remoteBlob.content) anyLocalChangeToPush = true;
                }
              } else {
                const m3 = mergeFileThreeWay('', localSnap.content, remoteBlob.content, paths.repoDir, env);
                if (m3.ok) {
                  resolvedByFile[name] = m3.content;
                  if (m3.content !== remoteBlob.content) anyLocalChangeToPush = true;
                } else {
                  const backupPath = writeConflictBackupOnce(localPath, localSnap.content);
                  conflicts.push({ name, backupPath });
                  conflictHashes[name] = startHashes[name];
                }
              }
            } else if (localSnap.exists) {
              resolvedByFile[name] = localSnap.content;
              anyLocalChangeToPush = true;
            }
            continue;
          }

          // Normal 3-way reconciliation using persisted base snapshot.
          const localChanged = localSnap.exists && localSnap.content !== baseText;
          const remoteChanged = remoteBlob.exists && remoteBlob.content !== baseText;

          if (!localSnap.exists && remoteBlob.exists) {
            resolvedByFile[name] = remoteBlob.content;
          } else if (!remoteBlob.exists && localSnap.exists) {
            resolvedByFile[name] = localSnap.content;
            anyLocalChangeToPush = true;
          } else if (!localChanged && !remoteChanged) {
            if (remoteBlob.exists) resolvedByFile[name] = remoteBlob.content;
            else if (localSnap.exists) resolvedByFile[name] = localSnap.content;
          } else if (localChanged && !remoteChanged) {
            resolvedByFile[name] = localSnap.content;
            if (!remoteBlob.exists || localSnap.content !== remoteBlob.content) {
              anyLocalChangeToPush = true;
            }
          } else if (!localChanged && remoteChanged) {
            resolvedByFile[name] = remoteBlob.content;
          } else if (localSnap.content === remoteBlob.content) {
            resolvedByFile[name] = remoteBlob.content;
          } else if (name === WORK_NOTES_FILE) {
            const wnRes = mergeWorkNotesDetailed(baseText, localSnap.content, remoteBlob.content);
            if (wnRes.hasConflict) {
              const backupPath = writeConflictBackupOnce(localPath, localSnap.content);
              conflicts.push({ name, backupPath, conflictedIds: wnRes.conflictedIds });
              conflictHashes[name] = startHashes[name];
            } else {
              resolvedByFile[name] = wnRes.content;
              if (wnRes.content !== remoteBlob.content) anyLocalChangeToPush = true;
            }
          } else {
            const m3 = mergeFileThreeWay(baseText, localSnap.content, remoteBlob.content, paths.repoDir, env);
            if (m3.ok) {
              resolvedByFile[name] = m3.content;
              if (m3.content !== remoteBlob.content) anyLocalChangeToPush = true;
            } else {
              const backupPath = writeConflictBackupOnce(localPath, localSnap.content);
              conflicts.push({ name, backupPath });
              conflictHashes[name] = startHashes[name];
            }
          }
        }

        if (conflicts.length > 0) {
          const desc = conflicts.map((c) => `${c.name} (backup: ${c.backupPath})`).join(', ');
          const errMsg = `3-way merge conflict requires manual review: ${desc}`;
          recordFailure('conflict', errMsg, { conflictHashes });
          return { synced: false, status: 'conflict', conflicts, error: errMsg };
        }

        // Prepare clean repo worktree aligned with remoteHead so untracked remote files are preserved.
        if (remoteHead) {
          runGit(['checkout', '-B', cfg.branch, remoteHead], { cwd: paths.repoDir, timeout: 6000, env });
          runGit(['reset', '--hard', remoteHead], { cwd: paths.repoDir, timeout: 6000, env });
        } else {
          runGit(['checkout', '-B', cfg.branch], { cwd: paths.repoDir, timeout: 5000, env });
        }

        const needsPush =
          anyLocalChangeToPush ||
          (!remoteHead && Object.keys(resolvedByFile).length > 0);

        if (needsPush) {
          ensureGitattributes(paths.repoDir);
          for (const [name, content] of Object.entries(resolvedByFile)) {
            atomicWriteTextIfChanged(path.join(paths.repoDir, name), content);
          }

          const toStage = ['.gitattributes', ...trackedNames].filter((n) =>
            fs.existsSync(path.join(paths.repoDir, n)),
          );
          if (toStage.length > 0) {
            runGit(['add', '--', ...toStage], { cwd: paths.repoDir, timeout: 5000, env });
          }

          const tree = runGit(['write-tree'], { cwd: paths.repoDir, timeout: 5000, env });
          const remoteTree = remoteHead
            ? runGit(['rev-parse', `${remoteHead}^{tree}`], { cwd: paths.repoDir, timeout: 4000, env })
            : '';

          if (!remoteHead || tree !== remoteTree) {
            const commitArgs = remoteHead
              ? ['commit-tree', tree, '-p', remoteHead, '-m', `sync(${os.hostname()}): publish memory`]
              : ['commit-tree', tree, '-m', `sync(${os.hostname()}): initial memory sync`];
            const published = runGit(commitArgs, { cwd: paths.repoDir, timeout: 5000, env });

            // Fail-closed pre-push secret-leak guard (delta-only vs remoteHead when remote exists).
            for (const name of trackedNames) {
              const candidateBlob = readGitBlob(paths.repoDir, published, name, env);
              if (!candidateBlob.exists) continue;
              const deltaText = remoteBlobs[name].exists
                ? extractAddedLines(remoteBlobs[name].content, candidateBlob.content)
                : candidateBlob.content;
              const leakedKind = detectHighConfidenceSecret(deltaText);
              if (leakedKind) {
                if (remoteHead) {
                  runGit(['reset', '--hard', remoteHead], { cwd: paths.repoDir, timeout: 5000, env });
                }
                const errMsg = `Blocked push: potential secret (${leakedKind}) detected in ${name}`;
                recordFailure('secret_blocked', errMsg);
                return {
                  synced: false,
                  status: 'secret_blocked',
                  secretKind: leakedKind,
                  fileName: name,
                  error: errMsg,
                };
              }
            }

            try {
              runGit(['push', '--no-verify', '--', 'origin', `${published}:refs/heads/${cfg.branch}`], {
                cwd: paths.repoDir,
                timeout: timeoutMs,
                env,
              });
              runGit(['update-ref', `refs/heads/${cfg.branch}`, published], { cwd: paths.repoDir, timeout: 5000, env });
              runGit(['checkout', '-B', cfg.branch, published], { cwd: paths.repoDir, timeout: 5000, env });
              committedLocal = true;
              pushed = true;
            } catch (pushErr) {
              if (attempt === 0 && isNonFastForwardError(pushErr)) {
                await sleep(120 + Math.floor(Math.random() * 200));
                continue;
              }
              throw pushErr;
            }
          }
        }

        finalResolvedByFile = resolvedByFile;
        break;
      }

      // Safely propagate resolved files back to geminiDir, skipping concurrent local edits.
      const pulledFiles = [];
      const skippedConcurrentEdits = [];
      const newHashes = { ...state.hashes };

      for (const { name, localPath } of trackedItems) {
        if (!(name in finalResolvedByFile)) continue;
        const curLocalHash = sha256Normalized(localPath);
        const startHash = startHashes[name] ?? '';
        if (curLocalHash !== startHash) {
          skippedConcurrentEdits.push(name);
          newHashes[name] = state.hashes[name] || '';
          continue;
        }
        if (name === GEMINI_MD_FILE && !localSnapshots[name].exists && cfg.allowCreateGeminiMd !== true) {
          continue;
        }
        if (atomicWriteTextIfChanged(localPath, finalResolvedByFile[name])) {
          pulledFiles.push(name);
        }
        newHashes[name] = sha256Normalized(localPath);
        writePersistedBase(paths.basesDir, name, finalResolvedByFile[name]);
      }

      const now = Date.now();
      saveState(paths.statePath, {
        hashes: newHashes,
        conflictHashes: {},
        lastSyncAt: now,
        lastPullAttemptAt: now,
        lastFailureAt: 0,
        lastStatus: 'ok',
        consecutiveFailures: 0,
        lastError: '',
      });
      return { synced: true, status: 'ok', committedLocal, pushed, pulledFiles, skippedConcurrentEdits };
    } catch (err) {
      const errMsg = redactSecrets(String(err?.message || err));
      recordFailure('error', errMsg);
      return { synced: false, status: 'error', error: errMsg };
    }
  }, lockWaitMs);
}

export async function resolveConflicts(strategy, { timeoutMs = 12_000, lockWaitMs = 15_000, env = process.env } = {}) {
  if (strategy !== 'local' && strategy !== 'remote') {
    return { resolved: false, status: 'error', error: `Invalid resolve strategy: ${strategy}. Expected "local" or "remote".` };
  }
  const paths = resolvePaths(env);
  const cfg = loadConfig(env);
  if (!cfg.gitEnabled) return { resolved: false, status: 'error', error: 'Git sync is not enabled.' };
  if (!cfg.remoteUrl) return { resolved: false, status: 'error', error: 'remoteUrl is not configured.' };

  const urlCheck = validateRemoteUrl(cfg.remoteUrl);
  if (!urlCheck.ok) return { resolved: false, status: 'error', error: `Invalid remoteUrl: ${urlCheck.error}` };
  const branchCheck = validateBranch(cfg.branch, { checkWithGit: true, env });
  if (!branchCheck.ok) return { resolved: false, status: 'error', error: `Invalid branch: ${branchCheck.error}` };

  return withLock(paths.lockPath, async () => {
    try {
      ensureRepoInitialized(paths, cfg, env);
      fetchOriginBranch(paths.repoDir, cfg.branch, timeoutMs, env);
      const branchRef = `origin/${cfg.branch}`;
      const remoteHead = getRevOrEmpty(paths.repoDir, branchRef, env);
      const trackedItems = getTrackedItems(paths.geminiDir, cfg);
      const trackedNames = trackedItems.map((i) => i.name);
      const state = loadState(paths.statePath);
      const newHashes = { ...state.hashes };
      const resolvedFiles = [];

      if (strategy === 'remote') {
        if (!remoteHead) {
          return { resolved: false, status: 'error', error: 'Remote branch has no commits to resolve from.' };
        }
        runGit(['checkout', '-B', cfg.branch, remoteHead], { cwd: paths.repoDir, timeout: 6000, env });
        runGit(['reset', '--hard', remoteHead], { cwd: paths.repoDir, timeout: 6000, env });
        for (const { name, localPath } of trackedItems) {
          const remoteBlob = readGitBlob(paths.repoDir, remoteHead, name, env);
          if (remoteBlob.exists) {
            if (name === GEMINI_MD_FILE && !fs.existsSync(localPath) && cfg.allowCreateGeminiMd !== true) {
              continue;
            }
            atomicWriteTextIfChanged(localPath, remoteBlob.content);
            newHashes[name] = sha256Normalized(localPath);
            writePersistedBase(paths.basesDir, name, remoteBlob.content);
            resolvedFiles.push(name);
          }
          const bakPath = `${localPath}.conflict.bak`;
          if (fs.existsSync(bakPath)) {
            try {
              fs.unlinkSync(bakPath);
            } catch {
              // Best-effort cleanup of conflict backup.
            }
          }
        }
        const now = Date.now();
        saveState(paths.statePath, {
          hashes: newHashes,
          conflictHashes: {},
          lastSyncAt: now,
          lastPullAttemptAt: now,
          lastFailureAt: 0,
          lastStatus: 'ok',
          consecutiveFailures: 0,
          lastError: '',
        });
        return { resolved: true, status: 'ok', strategy: 'remote', pushed: false, files: resolvedFiles };
      }

      // strategy === 'local'
      const remoteBlobs = {};
      for (const name of trackedNames) {
        remoteBlobs[name] = remoteHead
          ? readGitBlob(paths.repoDir, remoteHead, name, env)
          : { exists: false, content: '' };
      }

      if (remoteHead) {
        runGit(['checkout', '-B', cfg.branch, remoteHead], { cwd: paths.repoDir, timeout: 6000, env });
        runGit(['reset', '--hard', remoteHead], { cwd: paths.repoDir, timeout: 6000, env });
      } else {
        runGit(['checkout', '-B', cfg.branch], { cwd: paths.repoDir, timeout: 5000, env });
      }

      ensureGitattributes(paths.repoDir);
      const localContents = {};
      for (const { name, localPath } of trackedItems) {
        if (fs.existsSync(localPath)) {
          const txt = normLf(fs.readFileSync(localPath, 'utf8'));
          localContents[name] = txt;
          atomicWriteTextIfChanged(path.join(paths.repoDir, name), txt);
          resolvedFiles.push(name);
        }
      }

      const toStage = ['.gitattributes', ...trackedNames].filter((n) =>
        fs.existsSync(path.join(paths.repoDir, n)),
      );
      if (toStage.length > 0) {
        runGit(['add', '--', ...toStage], { cwd: paths.repoDir, timeout: 5000, env });
      }
      const tree = runGit(['write-tree'], { cwd: paths.repoDir, timeout: 5000, env });
      const remoteTree = remoteHead
        ? runGit(['rev-parse', `${remoteHead}^{tree}`], { cwd: paths.repoDir, timeout: 4000, env })
        : '';

      let pushed = false;
      if (!remoteHead || tree !== remoteTree) {
        const commitArgs = remoteHead
          ? ['commit-tree', tree, '-p', remoteHead, '-m', `sync(${os.hostname()}): resolve conflicts using local`]
          : ['commit-tree', tree, '-m', `sync(${os.hostname()}): resolve conflicts using local`];
        const published = runGit(commitArgs, { cwd: paths.repoDir, timeout: 5000, env });

        for (const name of trackedNames) {
          const candidateBlob = readGitBlob(paths.repoDir, published, name, env);
          if (!candidateBlob.exists) continue;
          const deltaText = remoteBlobs[name].exists
            ? extractAddedLines(remoteBlobs[name].content, candidateBlob.content)
            : candidateBlob.content;
          const leakedKind = detectHighConfidenceSecret(deltaText);
          if (leakedKind) {
            if (remoteHead) {
              runGit(['reset', '--hard', remoteHead], { cwd: paths.repoDir, timeout: 5000, env });
            }
            const errMsg = `Blocked push: potential secret (${leakedKind}) detected in ${name}`;
            const cur = loadState(paths.statePath);
            saveState(paths.statePath, {
              ...cur,
              lastFailureAt: Date.now(),
              lastStatus: 'secret_blocked',
              consecutiveFailures: cur.consecutiveFailures + 1,
              lastError: errMsg,
            });
            return { resolved: false, status: 'secret_blocked', secretKind: leakedKind, fileName: name, error: errMsg };
          }
        }

        runGit(['push', '--no-verify', '--', 'origin', `${published}:refs/heads/${cfg.branch}`], {
          cwd: paths.repoDir,
          timeout: timeoutMs,
          env,
        });
        runGit(['update-ref', `refs/heads/${cfg.branch}`, published], { cwd: paths.repoDir, timeout: 5000, env });
        runGit(['checkout', '-B', cfg.branch, published], { cwd: paths.repoDir, timeout: 5000, env });
        pushed = true;
      }

      for (const { name, localPath } of trackedItems) {
        if (name in localContents) {
          newHashes[name] = sha256Normalized(localPath);
          writePersistedBase(paths.basesDir, name, localContents[name]);
        }
        const bakPath = `${localPath}.conflict.bak`;
        if (fs.existsSync(bakPath)) {
          try {
            fs.unlinkSync(bakPath);
          } catch {
            // Best-effort cleanup of conflict backup.
          }
        }
      }

      const now = Date.now();
      saveState(paths.statePath, {
        hashes: newHashes,
        conflictHashes: {},
        lastSyncAt: now,
        lastPullAttemptAt: now,
        lastFailureAt: 0,
        lastStatus: 'ok',
        consecutiveFailures: 0,
        lastError: '',
      });
      return { resolved: true, status: 'ok', strategy: 'local', pushed, files: resolvedFiles };
    } catch (err) {
      return { resolved: false, status: 'error', error: redactSecrets(String(err?.message || err)) };
    }
  }, lockWaitMs);
}

function markDirty(dirtyPath) {
  try {
    fs.mkdirSync(path.dirname(dirtyPath), { recursive: true });
    fs.writeFileSync(dirtyPath, String(Date.now()), 'utf8');
  } catch {
    // Ignore dirty flag write error.
  }
}

function triggerBackgroundWorker(paths, { env = process.env, spawnWorker } = {}) {
  if (isLockHeldByLivePid(paths.lockPath)) {
    markDirty(paths.dirtyPath);
    return { spawned: false, coalesced: true };
  }
  if (!tryAcquireWorkerPending(paths.workerPendingPath)) {
    markDirty(paths.dirtyPath);
    return { spawned: false, coalesced: true };
  }
  const spawner =
    spawnWorker ||
    (() => {
      const child = spawn(process.execPath, [SCRIPT_PATH, '--worker'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env,
      });
      child.unref();
    });
  try {
    spawner();
    return { spawned: true, coalesced: false };
  } catch {
    clearWorkerPending(paths.workerPendingPath);
    return { spawned: false, coalesced: false };
  }
}

export async function handleSessionStart(env = process.env, { spawnWorker } = {}) {
  const paths = resolvePaths(env);
  const cfg = loadConfig(env);
  const st = loadState(paths.statePath);

  // Non-blocking SessionStart: NEVER block on git clone/fetch/merge/push under hook timeout.
  if (cfg.gitEnabled && cfg.remoteUrl) {
    const lastActivity = Math.max(st.lastSyncAt, st.lastPullAttemptAt);
    const inCooldown = Date.now() - lastActivity < cfg.pullCooldownMs;
    const backedOff = shouldBackoffWorkerSpawn(paths, cfg, st);
    if (!inCooldown && !backedOff) {
      triggerBackgroundWorker(paths, { env, spawnWorker });
    }
  }

  const notices = [];
  const budget = checkMemoryBudget(paths.geminiDir);
  if (budget.warning) notices.push(budget.warning);

  if (cfg.gitEnabled) {
    if (st.lastStatus === 'conflict') {
      notices.push(
        `[agy-suite-sync] Sync health (conflict, failures=${st.consecutiveFailures}): run --resolve=local or --resolve=remote, or inspect --status.`,
      );
    } else if (st.lastStatus === 'secret_blocked') {
      notices.push(
        `[agy-suite-sync] Sync health (secret_blocked, failures=${st.consecutiveFailures}): push blocked by secret guard; run --status for details.`,
      );
    } else if (st.consecutiveFailures >= 3) {
      notices.push(
        `[agy-suite-sync] Sync health (${st.lastStatus || 'error'}, failures=${st.consecutiveFailures}): run --status for details.`,
      );
    }
  }

  const pendingNotes = countPendingWorkNotes(paths.geminiDir);
  if (pendingNotes > 0) {
    notices.push(
      `[agy-suite-sync] WORK_NOTES.md has ${pendingNotes} pending item(s). Run /work-notes to review before acting.`,
    );
  }

  if (notices.length === 0) return {};
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: notices.join('\n'),
        },
      },
    ],
  };
}

export function handleStop(payload = {}, { env = process.env, spawnWorker } = {}) {
  const paths = resolvePaths(env);
  const cfg = loadConfig(env);
  if (!cfg.gitEnabled || !cfg.remoteUrl || payload?.continuationActive) {
    return { response: { decision: 'stop' }, spawned: false, coalesced: false };
  }
  const st = loadState(paths.statePath);
  if (shouldBackoffWorkerSpawn(paths, cfg, st)) {
    return { response: { decision: 'stop' }, spawned: false, coalesced: false, backedOff: true };
  }
  if (!hasLocalEdits(paths, cfg)) {
    return { response: { decision: 'stop' }, spawned: false, coalesced: false };
  }
  const res = triggerBackgroundWorker(paths, { env, spawnWorker });
  return { response: { decision: 'stop' }, ...res };
}

async function runWorker(env = process.env) {
  const paths = resolvePaths(env);
  const delayMs = Number.isFinite(Number(env.AGY_SUITE_SYNC_WORKER_DELAY_MS))
    ? Math.max(0, Number(env.AGY_SUITE_SYNC_WORKER_DELAY_MS))
    : 800;
  try {
    if (delayMs > 0) await sleep(delayMs);

    for (let pass = 0; pass < 2; pass += 1) {
      try {
        await syncMemoryFiles({ forcePull: false, timeoutMs: 12_000, env });
      } catch {
        // Background worker fails silently; status is persisted in sync-state.json.
      }
      if (!fs.existsSync(paths.dirtyPath)) break;
      try {
        fs.unlinkSync(paths.dirtyPath);
      } catch {
        break;
      }
    }
  } finally {
    clearWorkerPending(paths.workerPendingPath);
  }
}

function readStdinText(timeoutMs = STDIN_READ_TIMEOUT_MS) {
  if (process.stdin.isTTY || process.stdin.readableEnded) return Promise.resolve('');
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
      try {
        process.stdin.pause();
      } catch {
        // Ignore pause error.
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    };
    const onEnd = () => finish();
    const onError = () => finish();
    const timer = setTimeout(finish, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
    process.stdin.resume();
  });
}

function getArgvHookEvent(argv) {
  for (const arg of argv) {
    if (arg === 'SessionStart') return 'SessionStart';
    if (arg === 'Stop') return 'Stop';
  }
  const idx = argv.indexOf('--hook');
  if (idx >= 0 && idx + 1 < argv.length) {
    const val = argv[idx + 1];
    if (val === 'session-start' || val === 'SessionStart') return 'SessionStart';
    if (val === 'stop' || val === 'Stop') return 'Stop';
  }
  return '';
}

function getResolveStrategy(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--resolve=')) return arg.slice('--resolve='.length).trim();
    if (arg === '--resolve' && i + 1 < argv.length) return argv[i + 1].trim();
  }
  return '';
}

async function main() {
  const argv = process.argv.slice(2);
  const argvEvent = getArgvHookEvent(argv);

  try {
    if (argv.includes('--worker')) {
      await runWorker(process.env);
      return;
    }

    const resolveStrategy = getResolveStrategy(argv);
    if (resolveStrategy) {
      const res = await resolveConflicts(resolveStrategy, { env: process.env });
      process.stdout.write(`${JSON.stringify(res)}\n`);
      if (!res.resolved) process.exitCode = 1;
      return;
    }

    if (argv.includes('--status')) {
      const paths = resolvePaths(process.env);
      const cfg = loadConfig(process.env);
      const st = loadState(paths.statePath);
      const out = {
        mode: cfg.mode,
        dataDir: paths.dataDir,
        geminiDir: paths.geminiDir,
        config: {
          ...cfg,
          remoteUrl: redactSecrets(cfg.remoteUrl),
        },
        state: {
          ...st,
          lastError: redactSecrets(st.lastError),
        },
        memoryBudget: checkMemoryBudget(paths.geminiDir),
        pendingWorkNotes: countPendingWorkNotes(paths.geminiDir),
      };
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return;
    }

    if (argv.includes('--cli') || argv.includes('--sync-now')) {
      const res = await syncMemoryFiles({ forcePull: true, timeoutMs: 15_000, env: process.env });
      process.stdout.write(`${JSON.stringify(res)}\n`);
      if (res.status && res.status !== 'ok') process.exitCode = 1;
      return;
    }

    let payload = {};
    if (argvEvent !== 'SessionStart') {
      try {
        const raw = await readStdinText(STDIN_READ_TIMEOUT_MS);
        if (raw.trim()) payload = JSON.parse(raw);
      } catch {
        payload = {};
      }
    }

    const hookEvent = argvEvent || payload.hookEventName || '';

    if (hookEvent === 'SessionStart') {
      const out = await handleSessionStart(process.env);
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return;
    }
    if (hookEvent === 'Stop') {
      const { response } = handleStop(payload, { env: process.env });
      process.stdout.write(`${JSON.stringify(response)}\n`);
      return;
    }
    process.stdout.write('{}\n');
  } catch {
    if (argvEvent === 'Stop') {
      process.stdout.write('{"decision":"stop"}\n');
    } else {
      process.stdout.write('{}\n');
    }
  }
}

function resolveRealPathNormalized(targetPath) {
  if (!targetPath) return '';
  let resolved;
  try {
    resolved = fs.realpathSync(targetPath);
  } catch {
    resolved = path.resolve(targetPath);
  }
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved;
}

const isDirectMain =
  Boolean(process.argv[1]) &&
  resolveRealPathNormalized(process.argv[1]) === resolveRealPathNormalized(SCRIPT_PATH);

if (isDirectMain) {
  main();
}
