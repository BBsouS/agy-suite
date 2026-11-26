import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECOMMENDED_EXCLUDES = Object.freeze({
  '**/antigravity/**': true,
  '**/node_modules/**': true,
  '**/.venv/**': true,
  '**/.git/objects/**': true,
});

export const DEFAULT_PATCH_SPEC = Object.freeze({
  scalars: {
    'antigravity.heartbeatIntervalMs': 0,
  },
  mergeObjects: {
    'files.watcherExclude': RECOMMENDED_EXCLUDES,
    'search.exclude': RECOMMENDED_EXCLUDES,
  },
});

export const SUITE_PLUGIN_SLUGS = Object.freeze([
  'agy-suite-hud',
  'agy-suite-core',
  'agy-suite-sync',
]);

const GEMINI_WARN_CHARS = 12_000;
const MEMORY_WARN_CHARS = 9_500;
const RULE_WARN_BYTES = 18_000;
const RULE_CRITICAL_BYTES = 24_000;
const LINUX_MIN_INOTIFY_WATCHES = 65_536;
const BRAIN_WARN_BYTES = 2 * 1024 * 1024 * 1024;
const BRAIN_WARN_SESSIONS = 200;
const RETRYABLE_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

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

/**
 * Strip single-line (//) and block comments plus trailing commas from JSONC
 * while keeping string literals (including URLs and comment-like tokens) intact.
 */
export function stripJsonc(rawText) {
  if (typeof rawText !== 'string') {
    throw new TypeError('JSONC input must be a string');
  }
  const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
  let noComments = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n' || ch === '\r') {
        inLineComment = false;
        noComments += ch;
      } else {
        noComments += ' ';
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        noComments += '  ';
        i += 1;
      } else if (ch === '\n' || ch === '\r') {
        noComments += ch;
      } else {
        noComments += ' ';
      }
      continue;
    }

    if (inString) {
      noComments += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      noComments += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      noComments += '  ';
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      noComments += '  ';
      i += 1;
      continue;
    }

    noComments += ch;
  }

  if (inString) {
    throw new SyntaxError('Unterminated string literal in JSONC');
  }
  if (inBlockComment) {
    throw new SyntaxError('Unterminated block comment in JSONC');
  }

  // Second pass: remove trailing commas before } or ] outside strings.
  let out = '';
  inString = false;
  escaped = false;
  for (let i = 0; i < noComments.length; i += 1) {
    const ch = noComments[i];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) {
        j += 1;
      }
      if (noComments[j] === '}' || noComments[j] === ']') {
        out += ' ';
        continue;
      }
    }
    out += ch;
  }

  return out;
}

export function parseJsonc(rawText) {
  try {
    const stripped = stripJsonc(rawText);
    if (!stripped.trim()) {
      return { ok: true, value: {}, empty: true };
    }
    const value = JSON.parse(stripped);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

function skipWsAndComments(text, pos, end) {
  let i = pos;
  while (i < end) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\uFEFF') {
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < end && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < end && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      if (i >= end) throw new SyntaxError('Unterminated block comment');
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

function readStringToken(text, start, end) {
  let i = start + 1;
  let escaped = false;
  while (i < end) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '"') {
      return { start, end: i + 1, value: JSON.parse(text.slice(start, i + 1)) };
    }
    i += 1;
  }
  throw new SyntaxError('Unterminated string token');
}

function findMatchingCloser(text, openIndex, end) {
  const openChar = text[openIndex];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let i = openIndex;
  while (i < end) {
    i = skipWsAndComments(text, i, end);
    if (i >= end) break;
    const ch = text[i];
    if (ch === '"') {
      const str = readStringToken(text, i, end);
      i = str.end;
      continue;
    }
    if (ch === openChar) {
      depth += 1;
    } else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new SyntaxError(`Unmatched ${openChar}`);
}

function readValueSpan(text, start, end) {
  const ch = text[start];
  if (ch === '"') {
    const str = readStringToken(text, start, end);
    return { valueStart: str.start, valueEnd: str.end, isObject: false };
  }
  if (ch === '{') {
    const closeIdx = findMatchingCloser(text, start, end);
    return {
      valueStart: start,
      valueEnd: closeIdx + 1,
      isObject: true,
      objOpen: start,
      objClose: closeIdx,
    };
  }
  if (ch === '[') {
    const closeIdx = findMatchingCloser(text, start, end);
    return { valueStart: start, valueEnd: closeIdx + 1, isObject: false };
  }
  let i = start;
  while (i < end) {
    const c = text[i];
    if (c === ',' || c === '}' || c === ']' || c === '/' || /\s/.test(c)) {
      break;
    }
    i += 1;
  }
  return { valueStart: start, valueEnd: i, isObject: false };
}

export function scanObjectProperties(text, openBrace, closeBrace) {
  const props = [];
  let i = openBrace + 1;
  while (i < closeBrace) {
    i = skipWsAndComments(text, i, closeBrace);
    if (i >= closeBrace) break;
    if (text[i] === ',') {
      i += 1;
      continue;
    }
    if (text[i] !== '"') {
      throw new SyntaxError(`Expected string key at index ${i}`);
    }
    const keyTok = readStringToken(text, i, closeBrace);
    i = skipWsAndComments(text, keyTok.end, closeBrace);
    if (text[i] !== ':') {
      throw new SyntaxError(`Expected ':' after key "${keyTok.value}" at index ${i}`);
    }
    const colonIndex = i;
    i = skipWsAndComments(text, i + 1, closeBrace);
    const valSpan = readValueSpan(text, i, closeBrace);
    props.push({
      key: keyTok.value,
      keyStart: keyTok.start,
      keyEnd: keyTok.end,
      colonIndex,
      ...valSpan,
    });
    i = valSpan.valueEnd;
    i = skipWsAndComments(text, i, closeBrace);
    if (text[i] === ',') {
      i += 1;
    }
  }
  return props;
}

function findRootObjectBounds(text) {
  const start = skipWsAndComments(text, 0, text.length);
  if (start >= text.length || text[start] !== '{') {
    throw new SyntaxError('JSONC root must be an object');
  }
  const end = findMatchingCloser(text, start, text.length);
  return { open: start, close: end };
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function detectIndent(text) {
  const match = text.match(/^[ \t]+(?=")/m);
  if (match && match[0]) return match[0];
  return '  ';
}

function lineIndentBefore(text, index) {
  let lineStart = text.lastIndexOf('\n', index - 1);
  lineStart = lineStart === -1 ? 0 : lineStart + 1;
  const prefix = text.slice(lineStart, index);
  const ws = prefix.match(/^[ \t]*/);
  return {
    lineStart,
    isLineStartWsOnly: /^[ \t]*$/.test(prefix),
    indent: ws ? ws[0] : '',
  };
}

function hasCommaBetween(text, start, end) {
  let i = start;
  while (i < end) {
    i = skipWsAndComments(text, i, end);
    if (i >= end) return false;
    if (text[i] === ',') return true;
    i += 1;
  }
  return false;
}

function formatJsonValue(value, baseIndent, stepIndent, eol) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const childIndent = baseIndent + stepIndent;
    const lines = keys.map(
      (k) => `${childIndent}${JSON.stringify(k)}: ${formatJsonValue(value[k], childIndent, stepIndent, eol)}`,
    );
    return `{${eol}${lines.join(`,${eol}`)}${eol}${baseIndent}}`;
  }
  return JSON.stringify(value);
}

function insertPropertyInObject(text, openBrace, closeBrace, key, value, propIndent, stepIndent, eol) {
  const props = scanObjectProperties(text, openBrace, closeBrace);
  const formattedVal = formatJsonValue(value, propIndent, stepIndent, eol);
  const closeInfo = lineIndentBefore(text, closeBrace);
  const entry = `${propIndent}${JSON.stringify(key)}: ${formattedVal}`;

  if (props.length === 0) {
    const inner = text.slice(openBrace + 1, closeBrace);
    if (/^\s*$/.test(inner)) {
      const closingIndent = closeInfo.isLineStartWsOnly ? closeInfo.indent : propIndent.slice(0, Math.max(0, propIndent.length - stepIndent.length));
      return (
        text.slice(0, openBrace + 1) +
        `${eol}${entry}${eol}${closingIndent}` +
        text.slice(closeBrace)
      );
    }
    const insertPos = closeInfo.isLineStartWsOnly ? closeInfo.lineStart : closeBrace;
    const needsLeadingEol = insertPos > 0 && text[insertPos - 1] !== '\n';
    const closingPrefix = closeInfo.isLineStartWsOnly ? '' : closeInfo.indent;
    return (
      text.slice(0, insertPos) +
      `${needsLeadingEol ? eol : ''}${entry}${eol}${closingPrefix}` +
      text.slice(insertPos)
    );
  }

  const lastProp = props[props.length - 1];
  const trailingComma = hasCommaBetween(text, lastProp.valueEnd, closeBrace);
  let working = text;
  let adjustedClose = closeBrace;

  if (!trailingComma) {
    // Insert comma immediately after the last property's value, BEFORE any trailing inline comment.
    working = `${working.slice(0, lastProp.valueEnd)},${working.slice(lastProp.valueEnd)}`;
    adjustedClose += 1;
  }

  const updatedCloseInfo = lineIndentBefore(working, adjustedClose);
  const entryWithComma = trailingComma ? `${entry},` : entry;

  if (updatedCloseInfo.isLineStartWsOnly) {
    const insertPos = updatedCloseInfo.lineStart;
    const needsLeadingEol = insertPos > 0 && working[insertPos - 1] !== '\n';
    return (
      working.slice(0, insertPos) +
      `${needsLeadingEol ? eol : ''}${entryWithComma}${eol}` +
      working.slice(insertPos)
    );
  }

  // Single-line object like { "a": 1 }
  const closingIndent = propIndent.slice(0, Math.max(0, propIndent.length - stepIndent.length));
  return (
    working.slice(0, adjustedClose).replace(/[ \t]+$/, '') +
    `${eol}${entryWithComma}${eol}${closingIndent}` +
    working.slice(adjustedClose)
  );
}

export function buildManualSnippet(patchSpec = DEFAULT_PATCH_SPEC, isWorkspaceFile = false) {
  const payload = {
    ...(patchSpec.scalars || {}),
    ...(patchSpec.mergeObjects || {}),
  };
  return JSON.stringify(isWorkspaceFile ? { settings: payload } : payload, null, 2);
}

function findLastProp(props, key) {
  for (let i = props.length - 1; i >= 0; i -= 1) {
    if (props[i].key === key) return props[i];
  }
  return undefined;
}

/**
 * Comment-preserving, string-aware JSONC settings patcher.
 * Refuses mutation if the input JSONC is malformed and validates the result with JSON.parse.
 */
export function patchJsoncSettings(
  rawText,
  { patchSpec = DEFAULT_PATCH_SPEC, isWorkspaceFile = false } = {},
) {
  const parsed = parseJsonc(rawText);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return {
      ok: false,
      malformed: true,
      changed: false,
      error: parsed.ok ? 'Settings root must be a JSON object' : parsed.error,
      manualSnippet: buildManualSnippet(patchSpec, isWorkspaceFile),
    };
  }

  const eol = detectEol(rawText || '\n');
  let initialText = rawText;
  if (parsed.empty) {
    const emptySkeleton = isWorkspaceFile
      ? `{${eol}  "folders": [],${eol}  "settings": {}${eol}}${eol}`
      : `{}${eol}`;
    if (!rawText.trim()) {
      initialText = emptySkeleton;
    } else {
      const needsEol = !rawText.endsWith('\n') && !rawText.endsWith('\r');
      initialText = `${rawText}${needsEol ? eol : ''}${emptySkeleton}`;
    }
  }

  const stepIndent = detectIndent(initialText);
  let candidate = initialText;
  const changes = [];

  const resolveContainerBounds = (text) => {
    const root = findRootObjectBounds(text);
    if (!isWorkspaceFile) {
      return { open: root.open, close: root.close, propIndent: stepIndent, createdSettings: false };
    }
    const rootProps = scanObjectProperties(text, root.open, root.close);
    const settingsProp = findLastProp(rootProps, 'settings');
    if (!settingsProp) {
      return { open: root.open, close: root.close, propIndent: stepIndent, missingSettings: true };
    }
    if (!settingsProp.isObject) {
      throw new Error('Workspace "settings" property is not a JSON object');
    }
    return {
      open: settingsProp.objOpen,
      close: settingsProp.objClose,
      propIndent: stepIndent + stepIndent,
      missingSettings: false,
    };
  };

  try {
    let container = resolveContainerBounds(candidate);
    if (isWorkspaceFile && container.missingSettings) {
      candidate = insertPropertyInObject(
        candidate,
        container.open,
        container.close,
        'settings',
        {},
        stepIndent,
        stepIndent,
        eol,
      );
      container = resolveContainerBounds(candidate);
    }

    // 1. Scalar patches
    for (const [key, desiredVal] of Object.entries(patchSpec.scalars || {})) {
      container = resolveContainerBounds(candidate);
      const props = scanObjectProperties(candidate, container.open, container.close);
      const existing = findLastProp(props, key);
      if (existing) {
        const currentParsed = parseJsonc(candidate.slice(existing.valueStart, existing.valueEnd));
        if (currentParsed.ok && currentParsed.value === desiredVal) {
          continue;
        }
        candidate =
          candidate.slice(0, existing.valueStart) +
          JSON.stringify(desiredVal) +
          candidate.slice(existing.valueEnd);
        changes.push({ key, action: 'update', value: desiredVal });
      } else {
        candidate = insertPropertyInObject(
          candidate,
          container.open,
          container.close,
          key,
          desiredVal,
          container.propIndent,
          stepIndent,
          eol,
        );
        changes.push({ key, action: 'add', value: desiredVal });
      }
    }

    // 2. Object merge patches (only add missing keys; never overwrite explicit user values such as false)
    for (const [key, desiredMap] of Object.entries(patchSpec.mergeObjects || {})) {
      container = resolveContainerBounds(candidate);
      const props = scanObjectProperties(candidate, container.open, container.close);
      const existing = findLastProp(props, key);

      if (!existing) {
        candidate = insertPropertyInObject(
          candidate,
          container.open,
          container.close,
          key,
          desiredMap,
          container.propIndent,
          stepIndent,
          eol,
        );
        changes.push({ key, action: 'add', addedKeys: Object.keys(desiredMap) });
        continue;
      }

      if (!existing.isObject) {
        throw new Error(`Existing "${key}" property is not an object; refusing to overwrite`);
      }

      const addedKeys = [];
      for (const [subKey, subVal] of Object.entries(desiredMap)) {
        container = resolveContainerBounds(candidate);
        const curProps = scanObjectProperties(candidate, container.open, container.close);
        const curObjProp = findLastProp(curProps, key);
        const subProps = scanObjectProperties(candidate, curObjProp.objOpen, curObjProp.objClose);
        const existingSub = findLastProp(subProps, subKey);
        if (existingSub) {
          continue;
        }
        candidate = insertPropertyInObject(
          candidate,
          curObjProp.objOpen,
          curObjProp.objClose,
          subKey,
          subVal,
          container.propIndent + stepIndent,
          stepIndent,
          eol,
        );
        addedKeys.push(subKey);
      }

      if (addedKeys.length > 0) {
        changes.push({ key, action: 'merge', addedKeys });
      }
    }
  } catch (err) {
    return {
      ok: false,
      malformed: false,
      changed: false,
      error: String(err?.message || err),
      manualSnippet: buildManualSnippet(patchSpec, isWorkspaceFile),
    };
  }

  // Mandatory post-patch validation before any disk write.
  const verified = parseJsonc(candidate);
  if (!verified.ok) {
    return {
      ok: false,
      malformed: false,
      changed: false,
      error: `Post-patch JSONC validation failed: ${verified.error}`,
      manualSnippet: buildManualSnippet(patchSpec, isWorkspaceFile),
    };
  }

  return {
    ok: true,
    changed: changes.length > 0,
    changes,
    text: candidate,
    parsed: verified.value,
  };
}

function formatBackupTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export function writeSettingsWithBackup(targetPath, newText, { now = new Date() } = {}) {
  let resolvedTarget = targetPath;
  let originalMode = null;
  if (fs.existsSync(targetPath)) {
    try {
      resolvedTarget = fs.realpathSync(targetPath);
    } catch {
      resolvedTarget = targetPath;
    }
    try {
      originalMode = fs.statSync(resolvedTarget).mode;
    } catch {
      originalMode = null;
    }
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });

  let backupPath = null;
  if (fs.existsSync(resolvedTarget)) {
    const ts = formatBackupTimestamp(now);
    backupPath = `${targetPath}.agy-bak-${ts}`;
    if (fs.existsSync(backupPath)) {
      backupPath = `${targetPath}.agy-bak-${ts}-${crypto.randomBytes(2).toString('hex')}`;
    }
    fs.copyFileSync(resolvedTarget, backupPath);
  }

  const tmpPath = `${resolvedTarget}.agy-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmpPath, newText, 'utf8');
  if (originalMode !== null) {
    try {
      fs.chmodSync(tmpPath, originalMode);
    } catch {
      // Ignore chmod restrictions on platforms/filesystems that disallow it.
    }
  }

  let renamed = false;
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.renameSync(tmpPath, resolvedTarget);
      renamed = true;
      break;
    } catch (err) {
      lastErr = err;
      if (err?.code === 'EXDEV') break;
      if (!RETRYABLE_FS_CODES.has(err?.code) || attempt === 4) break;
      syncSleepMs(20 * 2 ** attempt);
    }
  }

  if (!renamed) {
    if (lastErr && (RETRYABLE_FS_CODES.has(lastErr.code) || lastErr.code === 'EXDEV')) {
      try {
        fs.copyFileSync(tmpPath, resolvedTarget);
        if (originalMode !== null) {
          try {
            fs.chmodSync(resolvedTarget, originalMode);
          } catch {
            // Ignore chmod restrictions.
          }
        }
      } finally {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // Ignore temp cleanup failure after copy.
        }
      }
    } else {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore temp cleanup failure.
      }
      throw lastErr;
    }
  }

  return { targetPath, resolvedTarget, backupPath };
}

function resolvePlatformConfigBase(platform, env, homeDir) {
  if (platform === 'win32') {
    return env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  }
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support');
  }
  return env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
}

function resolveWorkspaceFile(workspacePath) {
  if (!workspacePath) return null;
  const resolved = path.resolve(workspacePath);
  if (!fs.existsSync(resolved)) {
    return resolved.endsWith('.code-workspace') ? resolved : null;
  }
  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    return resolved;
  }
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(resolved).filter((name) => name.endsWith('.code-workspace')).sort();
    if (entries.length > 0) {
      return path.join(resolved, entries[0]);
    }
  }
  return null;
}

/**
 * Cross-platform IDE settings path resolver.
 * Probes "Antigravity IDE/User/settings.json" first, falls back to legacy
 * "Antigravity/User/settings.json" ONLY if User/settings.json or User/globalStorage
 * already exists (never fabricates User/ inside standalone Antigravity 2.0 profiles).
 */
export function resolveIdeSettingsTarget({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  settingsPath = '',
  workspacePath = '',
} = {}) {
  if (settingsPath) {
    const resolved = path.resolve(settingsPath);
    const isWorkspaceFile = resolved.toLowerCase().endsWith('.code-workspace');
    return {
      mode: 'explicit',
      path: resolved,
      exists: fs.existsSync(resolved),
      isWorkspaceFile,
      reason: 'Explicit --settings-path override',
    };
  }

  if (workspacePath) {
    const wsFile = resolveWorkspaceFile(workspacePath);
    if (wsFile) {
      return {
        mode: 'workspace',
        path: wsFile,
        exists: fs.existsSync(wsFile),
        isWorkspaceFile: true,
        reason: 'Explicit --workspace target',
      };
    }
    return {
      mode: 'skip',
      path: null,
      exists: false,
      isWorkspaceFile: false,
      reason: `No .code-workspace file found at "${path.resolve(workspacePath)}".`,
    };
  }

  const base = resolvePlatformConfigBase(platform, env, homeDir);
  const primaryProfileDir = path.join(base, 'Antigravity IDE');
  const primaryUserDir = path.join(primaryProfileDir, 'User');
  const primarySettings = path.join(primaryUserDir, 'settings.json');
  const primaryGlobalStorage = path.join(primaryUserDir, 'globalStorage');

  if (fs.existsSync(primarySettings)) {
    return {
      mode: 'ide-primary',
      path: primarySettings,
      exists: true,
      isWorkspaceFile: false,
      reason: 'Found Antigravity IDE User/settings.json',
    };
  }
  if (fs.existsSync(primaryGlobalStorage) || fs.existsSync(primaryUserDir)) {
    return {
      mode: 'ide-primary',
      path: primarySettings,
      exists: false,
      isWorkspaceFile: false,
      reason: 'Found Antigravity IDE User profile directory (settings.json not created yet)',
    };
  }

  // Legacy fallback: ONLY if User/settings.json or User/globalStorage already exists.
  const legacyUserDir = path.join(base, 'Antigravity', 'User');
  const legacySettings = path.join(legacyUserDir, 'settings.json');
  const legacyGlobalStorage = path.join(legacyUserDir, 'globalStorage');
  if (fs.existsSync(legacySettings) || fs.existsSync(legacyGlobalStorage)) {
    return {
      mode: 'ide-legacy',
      path: legacySettings,
      exists: fs.existsSync(legacySettings),
      isWorkspaceFile: false,
      reason: 'Found legacy Antigravity User profile (verified VS Code-fork structure)',
    };
  }

  return {
    mode: 'skip',
    path: null,
    exists: false,
    isWorkspaceFile: false,
    reason:
      'No VS Code-fork Antigravity IDE profile found (standalone Antigravity 2.0 does not use User/settings.json). Pass --workspace <file.code-workspace> to check or patch workspace settings.',
  };
}

function measureDirectorySafe(dirPath, maxEntries = 20_000) {
  if (!fs.existsSync(dirPath)) {
    return { exists: false, bytes: 0, files: 0, sessions: 0, truncated: false };
  }
  let bytes = 0;
  let files = 0;
  let visited = 0;
  let truncated = false;
  let sessions = 0;

  try {
    const top = fs.readdirSync(dirPath, { withFileTypes: true });
    sessions = top.filter((d) => d.isDirectory()).length;
  } catch {
    sessions = 0;
  }

  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) {
        truncated = true;
        return { exists: true, bytes, files, sessions, truncated };
      }
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          // Ignore disappearing temp files.
        }
      }
    }
  }

  return { exists: true, bytes, files, sessions, truncated };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function checkWindowsAdguard(systemRoot, spawnImpl) {
  const driverPath = path.join(systemRoot, 'System32', 'drivers', 'adgnetworkwfpdrv.sys');
  let detected = fs.existsSync(driverPath);
  let evidence = detected ? driverPath : '';

  if (!detected) {
    try {
      const sc = spawnImpl('sc.exe', ['query', 'AdguardSvc'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      if (sc.status === 0 && /SERVICE_NAME:\s*AdguardSvc/i.test(String(sc.stdout || ''))) {
        detected = true;
        evidence = 'AdguardSvc service';
      }
    } catch {
      // Ignore probe error.
    }
  }

  if (detected) {
    return {
      id: 'windows-adguard-wfp',
      severity: 'WARN',
      title: 'Windows AdGuard WFP Driver Detected',
      detail: `Detected ${evidence}. AdGuard WFP filtering can interfere with local Antigravity loopback connections or language-server streams.`,
      recommendation:
        'Advisory only (never auto-modified): if you see sudden disconnects or stalled responses, exclude Antigravity.exe, Code.exe, and agy.exe in AdGuard network settings.',
    };
  }
  return {
    id: 'windows-adguard-wfp',
    severity: 'OK',
    title: 'Windows AdGuard WFP Driver',
    detail: 'adgnetworkwfpdrv.sys / AdguardSvc not detected.',
  };
}

function checkWindowsPwshAlias(spawnImpl) {
  try {
    const res = spawnImpl('where.exe', ['pwsh'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    if (res.status !== 0 || !String(res.stdout || '').trim()) {
      return {
        id: 'windows-pwsh-alias',
        severity: 'INFO',
        title: 'PowerShell 7 (pwsh) PATH Order',
        detail: 'pwsh not found on PATH (Windows PowerShell fallback applies).',
      };
    }
    const lines = String(res.stdout)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const first = lines[0] || '';
    const hasWindowsAppsFirst = /\\WindowsApps\\pwsh\.exe$/i.test(first);
    const realPwsh = lines.find((l) => /\\PowerShell\\7\\pwsh\.exe$/i.test(l));

    if (hasWindowsAppsFirst) {
      return {
        id: 'windows-pwsh-alias',
        severity: 'WARN',
        title: 'PowerShell 7 WindowsApps Alias Trap',
        detail: `First pwsh on PATH is WindowsApps alias (${first})${realPwsh ? `; real binary is at ${realPwsh}` : ''}.`,
        recommendation:
          'Place "C:\\Program Files\\PowerShell\\7" ahead of WindowsApps in PATH or invoke PowerShell 7 via its full path.',
      };
    }
    return {
      id: 'windows-pwsh-alias',
      severity: 'OK',
      title: 'PowerShell 7 (pwsh) PATH Order',
      detail: `Resolved cleanly to ${first}.`,
    };
  } catch (err) {
    return {
      id: 'windows-pwsh-alias',
      severity: 'INFO',
      title: 'PowerShell 7 (pwsh) PATH Order',
      detail: `Could not probe where.exe pwsh: ${String(err?.message || err)}`,
    };
  }
}

function checkLinuxInotify(readFileImpl) {
  const procPath = '/proc/sys/fs/inotify/max_user_watches';
  try {
    const raw = readFileImpl(procPath, 'utf8').trim();
    const watches = Number.parseInt(raw, 10);
    if (!Number.isFinite(watches)) {
      return {
        id: 'linux-inotify',
        severity: 'INFO',
        title: 'Linux fs.inotify.max_user_watches',
        detail: `Unrecognized value in ${procPath}: "${raw}"`,
      };
    }
    if (watches < LINUX_MIN_INOTIFY_WATCHES) {
      return {
        id: 'linux-inotify',
        severity: 'WARN',
        title: 'Linux fs.inotify.max_user_watches Too Low',
        detail: `Current limit is ${watches} (recommended >= ${LINUX_MIN_INOTIFY_WATCHES}).`,
        recommendation: 'Increase with: sudo sysctl -w fs.inotify.max_user_watches=524288',
      };
    }
    return {
      id: 'linux-inotify',
      severity: 'OK',
      title: 'Linux fs.inotify.max_user_watches',
      detail: `Current limit is ${watches} (>= ${LINUX_MIN_INOTIFY_WATCHES}).`,
    };
  } catch (err) {
    return {
      id: 'linux-inotify',
      severity: 'INFO',
      title: 'Linux fs.inotify.max_user_watches',
      detail: `Unable to read ${procPath}: ${String(err?.message || err)}`,
    };
  }
}

function expandWindowsEnvVars(rawValue, baseEnv = process.env) {
  const envMap = new Map();
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (typeof v === 'string') envMap.set(k.toUpperCase(), v);
  }
  return String(rawValue || '').replace(/%([^%]+)%/g, (match, varName) => {
    const found = envMap.get(String(varName).toUpperCase());
    return found !== undefined ? found : match;
  });
}

function queryWindowsRegistryPath(regKey, spawnImpl) {
  try {
    const res = spawnImpl('reg.exe', ['query', regKey, '/v', 'Path'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    if (!res || res.error || res.status !== 0) return '';
    const stdout = String(res.stdout || '');
    const m = stdout.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

function buildWindowsCleanHookEnv(baseEnv, spawnImpl) {
  const machinePath = queryWindowsRegistryPath(
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    spawnImpl,
  );
  const userPath = queryWindowsRegistryPath('HKCU\\Environment', spawnImpl);
  const combinedRaw = [machinePath, userPath].filter(Boolean).join(';');
  const systemRoot = baseEnv?.SystemRoot || baseEnv?.SYSTEMROOT || 'C:\\Windows';
  const fallbackPath =
    baseEnv?.PATH || baseEnv?.Path || `${systemRoot}\\system32;${systemRoot};${systemRoot}\\System32\\Wbem`;
  const resolvedPath = combinedRaw ? expandWindowsEnvVars(combinedRaw, baseEnv) : fallbackPath;
  return {
    SystemRoot: systemRoot,
    ComSpec: baseEnv?.ComSpec || baseEnv?.COMSPEC || `${systemRoot}\\system32\\cmd.exe`,
    PATHEXT: baseEnv?.PATHEXT || '.COM;.EXE;.BAT;.CMD',
    PATH: resolvedPath,
  };
}

function checkNonLoginHookPath(platform, spawnImpl, env = process.env) {
  try {
    const isWin = platform === 'win32';
    const spawnOpts = {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    };
    let cmd;
    let bothArgs;
    let nodeOnlyArgs;

    if (isWin) {
      cmd = 'cmd.exe';
      bothArgs = ['/d', '/c', 'where node && where git'];
      nodeOnlyArgs = ['/d', '/c', 'where node'];
      spawnOpts.env = buildWindowsCleanHookEnv(env, spawnImpl);
    } else {
      cmd = 'env';
      bothArgs = [
        '-i',
        'PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin',
        'sh',
        '-c',
        'command -v node && command -v git',
      ];
      nodeOnlyArgs = [
        '-i',
        'PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin',
        'sh',
        '-c',
        'command -v node',
      ];
    }

    const res = spawnImpl(cmd, bothArgs, spawnOpts);
    if (!res || res.error || res.status === null) {
      return {
        id: 'non-login-hook-path',
        severity: 'INFO',
        title: 'Non-Login Hook PATH Probe',
        detail: `Could not complete sanitized PATH probe (${String(res?.error?.message || res?.error || 'no exit status')}).`,
      };
    }
    if (res.status === 0) {
      return {
        id: 'non-login-hook-path',
        severity: 'OK',
        title: 'Non-Login Hook PATH (node & git)',
        detail: 'Both node and git are reachable in non-login hook shells.',
      };
    }

    // Check node alone to distinguish missing node (CRITICAL) from missing git (WARN).
    const nodeRes = spawnImpl(cmd, nodeOnlyArgs, spawnOpts);
    if (!nodeRes || nodeRes.error || nodeRes.status === null) {
      return {
        id: 'non-login-hook-path',
        severity: 'INFO',
        title: 'Non-Login Hook PATH Probe',
        detail: `Could not complete sanitized node probe (${String(nodeRes?.error?.message || nodeRes?.error || 'no exit status')}).`,
      };
    }
    if (nodeRes.status !== 0) {
      return {
        id: 'non-login-hook-path',
        severity: 'CRITICAL',
        title: 'Non-Login Hook PATH Missing node',
        detail: 'Non-login hook shell cannot resolve `node`; Antigravity plugin hooks will fail.',
        recommendation: isWin
          ? 'Add Node.js installation directory to the System or User PATH in Windows Environment Variables.'
          : 'Symlink node into /usr/local/bin/node or export PATH in your system launch environment.',
      };
    }
    return {
      id: 'non-login-hook-path',
      severity: 'WARN',
      title: 'Non-Login Hook PATH Missing git',
      detail: '`node` is reachable, but `git` was not found in non-login hook shells.',
      recommendation: 'Install Git or add it to system PATH if you plan to enable agy-suite-sync Git mode.',
    };
  } catch (err) {
    return {
      id: 'non-login-hook-path',
      severity: 'INFO',
      title: 'Non-Login Hook PATH Probe',
      detail: `Probe failed: ${String(err?.message || err)}`,
    };
  }
}

function checkRuleByteBudget(geminiDir) {
  const targets = [
    { name: 'GEMINI.md', warnChars: GEMINI_WARN_CHARS, warnBytes: RULE_WARN_BYTES, criticalBytes: RULE_CRITICAL_BYTES },
    { name: 'MEMORY.md', warnChars: MEMORY_WARN_CHARS, warnBytes: RULE_WARN_BYTES, criticalBytes: RULE_CRITICAL_BYTES },
  ];
  const stats = [];
  let worst = 'OK';
  let foundAny = false;

  for (const target of targets) {
    const filePath = path.join(geminiDir, target.name);
    if (!fs.existsSync(filePath)) continue;
    foundAny = true;
    const text = fs.readFileSync(filePath, 'utf8');
    const chars = text.length;
    const bytes = Buffer.byteLength(text, 'utf8');
    let status = 'OK';
    if (bytes >= target.criticalBytes) {
      status = 'CRITICAL';
      worst = 'CRITICAL';
    } else if (chars >= target.warnChars || bytes >= target.warnBytes) {
      status = 'WARN';
      if (worst !== 'CRITICAL') worst = 'WARN';
    }
    stats.push(`${target.name}: ${chars} chars / ${bytes} bytes [${status}]`);
  }

  if (!foundAny) {
    return {
      id: 'rule-byte-budget',
      severity: 'INFO',
      title: 'Rule & Memory Byte Budget',
      detail: `Neither GEMINI.md nor MEMORY.md exists in ${geminiDir}.`,
    };
  }

  return {
    id: 'rule-byte-budget',
    severity: worst,
    title: 'Rule & Memory Byte Budget (MEMORY 9.5K / GEMINI 12K warn; 24KB limit)',
    detail: stats.join('; '),
    recommendation:
      worst !== 'OK'
        ? 'Antigravity truncates single always-loaded rule files past 24,000 bytes. Move cold details into MEMORY_ARCHIVE.md or trim GEMINI.md.'
        : undefined,
  };
}

function checkBrainDiskUsage(geminiDir) {
  const dirs = [
    path.join(geminiDir, 'antigravity', 'brain'),
    path.join(geminiDir, 'antigravity-ide', 'brain'),
  ];
  let totalBytes = 0;
  let totalSessions = 0;
  const parts = [];

  for (const d of dirs) {
    const m = measureDirectorySafe(d);
    if (m.exists) {
      totalBytes += m.bytes;
      totalSessions += m.sessions;
      parts.push(
        `${path.basename(path.dirname(d))}/brain: ${formatBytes(m.bytes)} (${m.sessions} dirs${m.truncated ? ', sampled' : ''})`,
      );
    }
  }

  if (parts.length === 0) {
    return {
      id: 'brain-disk-usage',
      severity: 'INFO',
      title: 'Brain Artifacts Disk Usage',
      detail: `No brain/ directories found under ${geminiDir}.`,
    };
  }

  const highUsage = totalBytes >= BRAIN_WARN_BYTES || totalSessions >= BRAIN_WARN_SESSIONS;
  return {
    id: 'brain-disk-usage',
    severity: highUsage ? 'WARN' : 'INFO',
    title: 'Brain Artifacts Disk Usage (Read-Only)',
    detail: `${parts.join('; ')} — total ${formatBytes(totalBytes)} across ${totalSessions} session dirs.`,
    recommendation: highUsage
      ? 'Run /cleanup to preview and safely archive old idle conversations.'
      : undefined,
  };
}

function checkDisabledPlugins(geminiDir) {
  const configPath = path.join(geminiDir, 'config', 'config.json');
  if (!fs.existsSync(configPath)) {
    return {
      id: 'disabled-plugins',
      severity: 'INFO',
      title: 'Antigravity config.json Plugin State',
      detail: `No config.json found at ${configPath}.`,
    };
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = parseJsonc(raw);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
      return {
        id: 'disabled-plugins',
        severity: 'WARN',
        title: 'Antigravity config.json Plugin State',
        detail: `Could not parse ${configPath} (read-only check; never edited by AGY SUITE).`,
      };
    }
    const pluginsMap = parsed.value.plugins || {};
    const disabled = SUITE_PLUGIN_SLUGS.filter(
      (slug) => pluginsMap[slug] && pluginsMap[slug].enabled === false,
    );
    if (disabled.length > 0) {
      return {
        id: 'disabled-plugins',
        severity: 'WARN',
        title: 'Disabled AGY SUITE Plugins in config.json',
        detail: `config.json has "enabled": false for: ${disabled.join(', ')}. Antigravity preserves this override across reinstalls.`,
        recommendation:
          'Re-enable in Antigravity Customizations UI or run `agy plugin enable <slug>` (AGY SUITE never edits config.json).',
      };
    }
    return {
      id: 'disabled-plugins',
      severity: 'OK',
      title: 'Antigravity config.json Plugin State',
      detail: 'No agy-suite-* plugins are force-disabled in config.json.',
    };
  } catch (err) {
    return {
      id: 'disabled-plugins',
      severity: 'INFO',
      title: 'Antigravity config.json Plugin State',
      detail: `Read-only check failed: ${String(err?.message || err)}`,
    };
  }
}

export function runDiagnostics({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  geminiDir = '',
  settingsPath = '',
  workspacePath = '',
  spawnImpl = spawnSync,
  readFileImpl = fs.readFileSync,
} = {}) {
  const resolvedGeminiDir = geminiDir ? path.resolve(geminiDir) : path.join(homeDir, '.gemini');
  const ideTarget = resolveIdeSettingsTarget({
    platform,
    env,
    homeDir,
    settingsPath,
    workspacePath,
  });

  const checks = [];
  let settingsRaw = '';
  let settingsParsed = null;
  let settingsMalformed = false;

  if (ideTarget.mode === 'skip') {
    checks.push({
      id: 'heartbeat-interval',
      severity: 'SKIP',
      title: 'Heartbeat Timeout Workaround (antigravity.heartbeatIntervalMs)',
      detail: ideTarget.reason,
    });
    checks.push({
      id: 'watcher-search-exclude',
      severity: 'SKIP',
      title: 'Watcher & Search Exclusions (**/antigravity/**)',
      detail: ideTarget.reason,
    });
  } else {
    if (ideTarget.exists) {
      settingsRaw = fs.readFileSync(ideTarget.path, 'utf8');
      const parsed = parseJsonc(settingsRaw);
      if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
        settingsMalformed = true;
        checks.push({
          id: 'settings-jsonc-syntax',
          severity: 'CRITICAL',
          title: 'Malformed IDE Settings JSONC',
          detail: `${ideTarget.path} failed JSONC parse: ${parsed.ok ? 'root is not an object' : parsed.error}. Automated patching will be refused.`,
          recommendation: `Fix JSONC syntax manually or merge this snippet:\n${buildManualSnippet(DEFAULT_PATCH_SPEC, ideTarget.isWorkspaceFile)}`,
        });
      } else {
        settingsParsed = ideTarget.isWorkspaceFile ? parsed.value.settings || {} : parsed.value;
      }
    } else {
      settingsParsed = {};
    }

    if (!settingsMalformed) {
      // 1. Heartbeat interval check
      const hb = settingsParsed['antigravity.heartbeatIntervalMs'];
      if (hb === 0) {
        checks.push({
          id: 'heartbeat-interval',
          severity: 'OK',
          title: 'Heartbeat Timeout Workaround (antigravity.heartbeatIntervalMs)',
          detail: `"antigravity.heartbeatIntervalMs" is 0 in ${ideTarget.path}.`,
        });
      } else {
        checks.push({
          id: 'heartbeat-interval',
          severity: 'WARN',
          title: 'Heartbeat Timeout Workaround (antigravity.heartbeatIntervalMs)',
          detail: `"antigravity.heartbeatIntervalMs" is ${hb === undefined ? 'unset' : JSON.stringify(hb)} in ${ideTarget.path}. Setting it to 0 is a community workaround for heartbeat timeout restarts.`,
          fixable: true,
          recommendation:
            'Run `node install.mjs --apply-settings` (or `node plugins/agy-suite-core/bin/doctor.mjs --apply`) to set "antigravity.heartbeatIntervalMs": 0.',
        });
      }

      // 2. files.watcherExclude & search.exclude check
      const watcherMap =
        settingsParsed['files.watcherExclude'] && typeof settingsParsed['files.watcherExclude'] === 'object'
          ? settingsParsed['files.watcherExclude']
          : {};
      const searchMap =
        settingsParsed['search.exclude'] && typeof settingsParsed['search.exclude'] === 'object'
          ? settingsParsed['search.exclude']
          : {};

      const missingWatcher = Object.keys(RECOMMENDED_EXCLUDES).filter(
        (k) => !Object.prototype.hasOwnProperty.call(watcherMap, k),
      );
      const missingSearch = Object.keys(RECOMMENDED_EXCLUDES).filter(
        (k) => !Object.prototype.hasOwnProperty.call(searchMap, k),
      );
      const missingSelfIndex =
        missingWatcher.includes('**/antigravity/**') || missingSearch.includes('**/antigravity/**');

      if (missingWatcher.length === 0 && missingSearch.length === 0) {
        checks.push({
          id: 'watcher-search-exclude',
          severity: 'OK',
          title: 'Watcher & Search Exclusions',
          detail: `Recommended exclusions are configured in ${ideTarget.path}.`,
        });
      } else {
        checks.push({
          id: 'watcher-search-exclude',
          severity: missingSelfIndex ? 'CRITICAL' : 'WARN',
          title: 'Watcher & Search Exclusions',
          detail:
            `Missing exclusions in ${ideTarget.path} — ` +
            `files.watcherExclude: [${missingWatcher.join(', ') || 'none'}], ` +
            `search.exclude: [${missingSearch.join(', ') || 'none'}].` +
            (missingSelfIndex ? ' Missing **/antigravity/** can trigger recursive self-indexing loops.' : ''),
          fixable: true,
          recommendation:
            'Run `node install.mjs --apply-settings` (or `node plugins/agy-suite-core/bin/doctor.mjs --apply`) to merge missing exclusions while preserving comments and explicit user overrides.',
        });
      }
    }
  }

  // 3. Windows-only checks
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || 'C:\\Windows';
    checks.push(checkWindowsAdguard(systemRoot, spawnImpl));
    checks.push(checkWindowsPwshAlias(spawnImpl));
  } else {
    checks.push({
      id: 'windows-checks',
      severity: 'SKIP',
      title: 'Windows AdGuard & PowerShell 7 Checks',
      detail: `Skipped on platform "${platform}".`,
    });
  }

  // 4. Linux-only check
  if (platform === 'linux') {
    checks.push(checkLinuxInotify(readFileImpl));
  } else {
    checks.push({
      id: 'linux-inotify',
      severity: 'SKIP',
      title: 'Linux fs.inotify.max_user_watches',
      detail: `Skipped on platform "${platform}".`,
    });
  }

  // 5. Non-login hook PATH probe
  checks.push(checkNonLoginHookPath(platform, spawnImpl, env));

  // 6. Rule byte-budget check
  checks.push(checkRuleByteBudget(resolvedGeminiDir));

  // 7. Read-only brain/ disk usage
  checks.push(checkBrainDiskUsage(resolvedGeminiDir));

  // 8. Read-only config.json disabled-plugin check
  checks.push(checkDisabledPlugins(resolvedGeminiDir));

  const summary = { CRITICAL: 0, WARN: 0, OK: 0, SKIP: 0, INFO: 0 };
  for (const c of checks) {
    if (Object.prototype.hasOwnProperty.call(summary, c.severity)) {
      summary[c.severity] += 1;
    }
  }

  return {
    platform,
    geminiDir: resolvedGeminiDir,
    ideTarget,
    settingsMalformed,
    summary,
    checks,
  };
}

export function applySettingsPatch({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  settingsPath = '',
  workspacePath = '',
  dryRun = true,
  patchSpec = DEFAULT_PATCH_SPEC,
} = {}) {
  const target = resolveIdeSettingsTarget({
    platform,
    env,
    homeDir,
    settingsPath,
    workspacePath,
  });

  if (target.mode === 'skip' || !target.path) {
    return {
      ok: true,
      skipped: true,
      changed: false,
      target,
      reason: target.reason,
    };
  }

  const rawText = target.exists ? fs.readFileSync(target.path, 'utf8') : '';
  const patchResult = patchJsoncSettings(rawText, {
    patchSpec,
    isWorkspaceFile: target.isWorkspaceFile,
  });

  if (!patchResult.ok) {
    return {
      ok: false,
      skipped: false,
      changed: false,
      malformed: patchResult.malformed,
      target,
      error: patchResult.error,
      manualSnippet: patchResult.manualSnippet,
    };
  }

  if (!patchResult.changed) {
    return {
      ok: true,
      skipped: false,
      changed: false,
      dryRun,
      target,
      changes: [],
    };
  }

  if (dryRun) {
    return {
      ok: true,
      skipped: false,
      changed: true,
      dryRun: true,
      target,
      changes: patchResult.changes,
      previewText: patchResult.text,
    };
  }

  const written = writeSettingsWithBackup(target.path, patchResult.text);
  return {
    ok: true,
    skipped: false,
    changed: true,
    dryRun: false,
    target,
    changes: patchResult.changes,
    backupPath: written.backupPath,
  };
}

export function parseDoctorArgs(argv) {
  const opts = {
    mode: 'check',
    json: false,
    workspacePath: '',
    settingsPath: '',
    geminiDir: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') opts.mode = 'check';
    else if (arg === '--dry-run') opts.mode = 'dry-run';
    else if (arg === '--apply') opts.mode = 'apply';
    else if (arg === '--json') opts.json = true;
    else if (arg === '--workspace' && argv[i + 1]) opts.workspacePath = argv[++i];
    else if (arg.startsWith('--workspace=')) opts.workspacePath = arg.slice('--workspace='.length);
    else if (arg === '--settings-path' && argv[i + 1]) opts.settingsPath = argv[++i];
    else if (arg.startsWith('--settings-path=')) opts.settingsPath = arg.slice('--settings-path='.length);
    else if (arg === '--gemini-dir' && argv[i + 1]) opts.geminiDir = argv[++i];
    else if (arg.startsWith('--gemini-dir=')) opts.geminiDir = arg.slice('--gemini-dir='.length);
  }
  return opts;
}

export function formatDoctorReport(report) {
  const lines = [
    `AGY SUITE Doctor (${report.platform})`,
    `IDE Settings Target: ${report.ideTarget.path || 'none'} (${report.ideTarget.mode})`,
    '',
  ];
  for (const c of report.checks) {
    lines.push(`[${c.severity}] ${c.title}`);
    lines.push(`  ${c.detail}`);
    if (c.recommendation) {
      lines.push(`  -> ${c.recommendation}`);
    }
  }
  lines.push('');
  lines.push(
    `Summary: CRITICAL=${report.summary.CRITICAL} WARN=${report.summary.WARN} OK=${report.summary.OK} INFO=${report.summary.INFO} SKIP=${report.summary.SKIP}`,
  );
  return lines.join('\n');
}

export function runDoctorCli(argv = process.argv.slice(2)) {
  const opts = parseDoctorArgs(argv);
  if (opts.mode === 'check') {
    const report = runDiagnostics({
      workspacePath: opts.workspacePath,
      settingsPath: opts.settingsPath,
      geminiDir: opts.geminiDir,
    });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatDoctorReport(report)}\n`);
    }
    return report;
  }

  const result = applySettingsPatch({
    workspacePath: opts.workspacePath,
    settingsPath: opts.settingsPath,
    dryRun: opts.mode === 'dry-run',
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!result.ok) {
    process.stderr.write(`[ERROR] Refused to patch ${result.target?.path || 'settings'}: ${result.error}\n`);
    if (result.manualSnippet) {
      process.stderr.write(`Manual paste snippet:\n${result.manualSnippet}\n`);
    }
    process.exitCode = 1;
  } else if (result.skipped) {
    process.stdout.write(`[SKIP] ${result.reason}\n`);
  } else if (!result.changed) {
    process.stdout.write(`[OK] ${result.target.path} already has all recommended settings.\n`);
  } else if (result.dryRun) {
    process.stdout.write(`[dry-run] Would patch ${result.target.path}:\n`);
    for (const ch of result.changes) {
      process.stdout.write(`  - ${ch.key} (${ch.action})\n`);
    }
  } else {
    process.stdout.write(`[APPLIED] Patched ${result.target.path}\n`);
    if (result.backupPath) {
      process.stdout.write(`  Backup saved to: ${result.backupPath}\n`);
    }
  }
  return result;
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
const selfPath = resolveRealPathLower(fileURLToPath(import.meta.url));
if (invokedPath && invokedPath === selfPath) {
  try {
    runDoctorCli();
  } catch (err) {
    process.stderr.write(`Doctor failed: ${String(err?.message || err)}\n`);
    process.exitCode = 1;
  }
}
