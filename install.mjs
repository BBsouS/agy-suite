import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applySettingsPatch,
  formatDoctorReport,
  runDiagnostics,
} from './plugins/agy-suite-core/bin/doctor.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGINS_SRC_DIR = path.join(SCRIPT_DIR, 'plugins');
const RETRYABLE_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const FALLBACK_RENAME_CODES = new Set(['EXDEV', 'EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EEXIST']);

export const PLUGINS = Object.freeze({
  hud: {
    key: 'hud',
    slug: 'agy-suite-hud',
    displayName: 'AGY SUITE — HUD',
  },
  core: {
    key: 'core',
    slug: 'agy-suite-core',
    displayName: 'AGY SUITE — Core',
  },
  sync: {
    key: 'sync',
    slug: 'agy-suite-sync',
    displayName: 'AGY SUITE — Memory & Bridge',
  },
});

const ALL_MODULE_KEYS = ['hud', 'core', 'sync'];
const DEFAULT_INSTALL_MODULES = ['hud', 'core'];

const FALLBACK_STARTERS = Object.freeze({
  'MEMORY.md': `# Active Working Memory\n\nKeep this file concise (< 9,500 chars / 18 KB) to preserve KV prefix cache and avoid 24 KB rule truncation.\nMove completed details to MEMORY_ARCHIVE.md.\n`,
  'MEMORY_ARCHIVE.md': `# Memory Archive\n\nOn-demand historical notes (not always loaded into system rules).\n`,
  'WORK_NOTES.md': `# Work Notes Inbox\n\n<!-- External bots or mobile tools append worknote:start / worknote:end blocks below. -->\n`,
});

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

function rmDirSafe(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return;
  fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
}

function rmDirBestEffort(dirPath) {
  try {
    rmDirSafe(dirPath);
  } catch {
    // Ignore transient temp/AV cleanup locks so completed installs are preserved.
  }
}

function copyFileWithRetry(srcFile, dstFile, maxRetries = 5) {
  let lastErr = null;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      fs.copyFileSync(srcFile, dstFile);
      return;
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_FS_CODES.has(err?.code) || attempt === maxRetries - 1) {
        throw err;
      }
      syncSleepMs(20 * 2 ** attempt);
    }
  }
  throw lastErr;
}

function lstatSafe(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch {
    return null;
  }
}

function formatBackupTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Windows EPERM-safe in-place directory sync (adapted from agy-orbit/install.mjs).
 * Unlinks any existing symlinks at destination paths before copying so symlinks are never traversed or clobbered.
 */
export function syncDirInPlace(srcDir, dstDir, { copyFileImpl = copyFileWithRetry } = {}) {
  const dstDirStat = lstatSafe(dstDir);
  if (dstDirStat?.isSymbolicLink()) {
    fs.unlinkSync(dstDir);
  }
  fs.mkdirSync(dstDir, { recursive: true });
  const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true });
  const keepNames = new Set(srcEntries.map((e) => e.name));

  for (const entry of srcEntries) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    const dstStat = lstatSafe(dstPath);
    if (entry.isDirectory()) {
      if (dstStat) {
        if (dstStat.isSymbolicLink()) {
          fs.unlinkSync(dstPath);
        } else if (!dstStat.isDirectory()) {
          rmDirSafe(dstPath);
        }
      }
      syncDirInPlace(srcPath, dstPath, { copyFileImpl });
    } else if (entry.isFile()) {
      if (dstStat) {
        if (dstStat.isSymbolicLink()) {
          fs.unlinkSync(dstPath);
        } else if (dstStat.isDirectory()) {
          rmDirSafe(dstPath);
        }
      }
      copyFileImpl(srcPath, dstPath);
    }
  }

  for (const existing of fs.readdirSync(dstDir)) {
    if (!keepNames.has(existing)) {
      const extraPath = path.join(dstDir, existing);
      const extraStat = lstatSafe(extraPath);
      if (extraStat?.isSymbolicLink()) {
        try {
          fs.unlinkSync(extraPath);
        } catch {
          // Ignore transient cleanup lock.
        }
      } else {
        rmDirBestEffort(extraPath);
      }
    }
  }
}

export function moveOrCopyDirSync(
  src,
  dst,
  { renameImpl = fs.renameSync, copyFileImpl = copyFileWithRetry, maxRetries = 4 } = {},
) {
  if (fs.existsSync(dst) && renameImpl === fs.renameSync) {
    syncDirInPlace(src, dst, { copyFileImpl });
    rmDirBestEffort(src);
    return 'copied';
  }

  let lastErr = null;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      renameImpl(src, dst);
      return 'renamed';
    } catch (err) {
      lastErr = err;
      if (err?.code === 'EXDEV' || err?.code === 'ENOTEMPTY' || err?.code === 'EEXIST') {
        break;
      }
      if (!RETRYABLE_FS_CODES.has(err?.code)) {
        throw err;
      }
      if (attempt < maxRetries - 1) {
        syncSleepMs(25 * 2 ** attempt);
      }
    }
  }

  if (lastErr && FALLBACK_RENAME_CODES.has(lastErr.code)) {
    syncDirInPlace(src, dst, { copyFileImpl });
    rmDirBestEffort(src);
    return 'copied';
  }
  throw lastErr;
}

/**
 * Format an absolute path as a forward-slash, Markdown-link-safe POSIX path.
 */
export function formatPosixFileRef(absPath) {
  return path
    .resolve(absPath)
    .replace(/\\/g, '/')
    .replace(/%/g, '%25')
    .replace(/ /g, '%20')
    .replace(/#/g, '%23')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\[/g, '%5B')
    .replace(/\]/g, '%5D');
}

export function validateGitRemoteUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    throw new Error('Invalid --git-remote URL: must be a string.');
  }
  if (/[\x00-\x1f\x7f]/.test(rawUrl)) {
    throw new Error('Invalid --git-remote URL: control characters are not allowed.');
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('Invalid --git-remote URL: cannot be empty.');
  }
  if (trimmed.startsWith('-')) {
    throw new Error(`Invalid --git-remote URL "${trimmed}": leading "-" is disallowed.`);
  }
  if (/(?:^|::)ext::/i.test(trimmed)) {
    throw new Error(`Invalid --git-remote URL "${trimmed}": git ext:: remote helper is disallowed.`);
  }
  return trimmed;
}

export function validateGitBranch(rawBranch) {
  if (typeof rawBranch !== 'string') {
    throw new Error('Invalid --branch value: must be a string.');
  }
  if (/[\x00-\x1f\x7f\s]/.test(rawBranch)) {
    throw new Error('Invalid --branch value: whitespace and control characters are not allowed.');
  }
  const trimmed = rawBranch.trim();
  if (!trimmed) {
    throw new Error('Invalid --branch value: cannot be empty.');
  }
  if (trimmed.startsWith('-')) {
    throw new Error(`Invalid --branch "${trimmed}": leading "-" is disallowed.`);
  }
  if (
    trimmed === '@' ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.startsWith('.') ||
    trimmed.endsWith('.') ||
    trimmed.endsWith('.lock') ||
    trimmed.includes('..') ||
    trimmed.includes('//') ||
    trimmed.includes('/.') ||
    trimmed.includes('.lock/') ||
    !/^[A-Za-z0-9._/-]+$/.test(trimmed)
  ) {
    throw new Error(`Invalid --branch "${trimmed}": not a safe Git branch name.`);
  }
  return trimmed;
}

export function redactRemoteUrl(url) {
  if (!url) return '';
  return String(url).replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@\s]+)@/g, '$1***@');
}

function sanitizeSyncSetupForJson(syncSetup) {
  if (!syncSetup) return null;
  return {
    ...syncSetup,
    config: syncSetup.config
      ? {
          ...syncSetup.config,
          remoteUrl: redactRemoteUrl(syncSetup.config.remoteUrl),
        }
      : syncSetup.config,
  };
}

function sanitizeSettingsResultForJson(settingsResult) {
  if (!settingsResult) return null;
  const appliedKeys = Array.isArray(settingsResult.changes)
    ? settingsResult.changes.map((c) => c.key)
    : [];
  return {
    ok: Boolean(settingsResult.ok),
    changed: Boolean(settingsResult.changed),
    appliedKeys,
    error: settingsResult.error || null,
  };
}

export function parseModulesList(raw, defaultList = DEFAULT_INSTALL_MODULES) {
  if (!raw) return [...defaultList];
  const trimmed = String(raw).trim().toLowerCase();
  if (!trimmed) return [...defaultList];
  if (trimmed === 'all') return [...ALL_MODULE_KEYS];

  const out = [];
  for (const token of trimmed.split(',').map((s) => s.trim()).filter(Boolean)) {
    const normalized = token.replace(/^agy-suite-/, '');
    if (!Object.prototype.hasOwnProperty.call(PLUGINS, normalized)) {
      throw new Error(`Unknown module "${token}". Valid modules: hud, core, sync, all`);
    }
    if (!out.includes(normalized)) out.push(normalized);
  }
  if (out.length === 0) {
    throw new Error('At least one valid module must be selected.');
  }
  return out;
}

export function parseInstallArgs(argv) {
  const opts = {
    help: false,
    doctor: false,
    dryRun: false,
    json: false,
    uninstall: false,
    restoreBackups: false,
    applySettings: false,
    autoOpenHud: false,
    workNotes: false,
    gitRemote: '',
    hasGitRemote: false,
    branch: '',
    hasBranch: false,
    modulesRaw: '',
    workspacePath: '',
    settingsPath: '',
    targetRoot: '',
    dataDir: '',
    geminiDir: '',
    pluginsSrcDir: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--doctor') opts.doctor = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--uninstall') opts.uninstall = true;
    else if (arg === '--restore-backups') opts.restoreBackups = true;
    else if (arg === '--apply-settings') opts.applySettings = true;
    else if (arg === '--auto-open-hud') opts.autoOpenHud = true;
    else if (arg === '--work-notes') opts.workNotes = true;
    else if (arg === '--modules' && argv[i + 1] !== undefined) opts.modulesRaw = argv[++i];
    else if (arg.startsWith('--modules=')) opts.modulesRaw = arg.slice('--modules='.length);
    else if (arg === '--git-remote' && argv[i + 1] !== undefined) {
      opts.gitRemote = argv[++i];
      opts.hasGitRemote = true;
    } else if (arg.startsWith('--git-remote=')) {
      opts.gitRemote = arg.slice('--git-remote='.length);
      opts.hasGitRemote = true;
    } else if (arg === '--branch' && argv[i + 1] !== undefined) {
      opts.branch = argv[++i];
      opts.hasBranch = true;
    } else if (arg.startsWith('--branch=')) {
      opts.branch = arg.slice('--branch='.length);
      opts.hasBranch = true;
    } else if (arg === '--workspace' && argv[i + 1] !== undefined) opts.workspacePath = argv[++i];
    else if (arg.startsWith('--workspace=')) opts.workspacePath = arg.slice('--workspace='.length);
    else if (arg === '--settings-path' && argv[i + 1] !== undefined) opts.settingsPath = argv[++i];
    else if (arg.startsWith('--settings-path=')) opts.settingsPath = arg.slice('--settings-path='.length);
    else if (arg === '--target-root' && argv[i + 1] !== undefined) opts.targetRoot = argv[++i];
    else if (arg.startsWith('--target-root=')) opts.targetRoot = arg.slice('--target-root='.length);
    else if (arg === '--data-dir' && argv[i + 1] !== undefined) opts.dataDir = argv[++i];
    else if (arg.startsWith('--data-dir=')) opts.dataDir = arg.slice('--data-dir='.length);
    else if (arg === '--gemini-dir' && argv[i + 1] !== undefined) opts.geminiDir = argv[++i];
    else if (arg.startsWith('--gemini-dir=')) opts.geminiDir = arg.slice('--gemini-dir='.length);
    else if (arg === '--plugins-src-dir' && argv[i + 1] !== undefined) opts.pluginsSrcDir = argv[++i];
    else if (arg.startsWith('--plugins-src-dir=')) opts.pluginsSrcDir = arg.slice('--plugins-src-dir='.length);
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 18) {
    throw new Error(`Node.js >= 18 is required (current: ${process.versions.node})`);
  }
}

function readMatchingPluginManifest(dirPath, expectedSlug) {
  const manifestPath = path.join(dirPath, 'plugin.json');
  try {
    if (fs.existsSync(manifestPath)) {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (parsed && parsed.name === expectedSlug) {
        return parsed;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function readJsonFileSafe(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {
    // Fall back on corrupt/unreadable JSON.
  }
  return fallback;
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (err?.code === 'EPERM' || err?.code === 'EACCES' || err?.code === 'EXDEV') {
      fs.copyFileSync(tmp, filePath);
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Ignore cleanup lock.
      }
    } else {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Ignore cleanup lock.
      }
      throw err;
    }
  }
}

function resolveMemoryLoaderInDir(pluginDir, geminiDir) {
  const loaderPath = path.join(pluginDir, 'rules', 'MEMORY-LOADER.md');
  if (!fs.existsSync(loaderPath)) return false;
  const raw = fs.readFileSync(loaderPath, 'utf8');
  const memoryRef = formatPosixFileRef(path.join(geminiDir, 'MEMORY.md'));
  let updated = raw.replaceAll('{{MEMORY_MD_PATH}}', () => memoryRef);
  if (updated === raw) {
    updated = raw.replace(/@\[MEMORY\.md\]\([^)]*\)/, () => `@[MEMORY.md](${memoryRef})`);
  }
  if (updated !== raw) {
    fs.writeFileSync(loaderPath, updated, 'utf8');
    return true;
  }
  return false;
}

function installSinglePlugin(
  pluginMeta,
  { pluginsSrcDir, targetRoot, dataDir, geminiDir, autoOpenHud, renameImpl, copyFileImpl },
) {
  const srcDir = path.join(pluginsSrcDir, pluginMeta.slug);
  const dstDir = path.join(targetRoot, pluginMeta.slug);

  if (!fs.existsSync(path.join(srcDir, 'plugin.json'))) {
    throw new Error(`Missing plugin source manifest at ${srcDir}`);
  }

  if (fs.existsSync(dstDir)) {
    const stat = fs.lstatSync(dstDir);
    if (!stat.isDirectory()) {
      throw new Error(`Refusing to overwrite non-directory path "${dstDir}".`);
    }
    const existingEntries = fs.readdirSync(dstDir);
    if (existingEntries.length > 0 && !readMatchingPluginManifest(dstDir, pluginMeta.slug)) {
      throw new Error(
        `Refusing to overwrite existing non-empty directory "${dstDir}": missing valid plugin.json with name "${pluginMeta.slug}".`,
      );
    }
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const stagingDir = path.join(os.tmpdir(), `agy-suite-stage-${pluginMeta.slug}-${token}`);
  const backupDir = path.join(os.tmpdir(), `agy-suite-backup-${pluginMeta.slug}-${token}`);
  let hasBackup = false;
  let autoOpenCopied = false;
  let memoryLoaderResolved = false;
  let installMetaWritten = false;

  try {
    syncDirInPlace(srcDir, stagingDir);

    if (pluginMeta.key === 'hud' && autoOpenHud) {
      const tplPath = path.join(stagingDir, 'templates', 'auto-open-hud.md');
      if (fs.existsSync(tplPath)) {
        const rulesDir = path.join(stagingDir, 'rules');
        fs.mkdirSync(rulesDir, { recursive: true });
        fs.copyFileSync(tplPath, path.join(rulesDir, 'auto-open-hud.md'));
        autoOpenCopied = true;
      }
    }

    if (pluginMeta.key === 'sync') {
      memoryLoaderResolved = resolveMemoryLoaderInDir(stagingDir, geminiDir);
    }

    if (pluginMeta.key === 'sync' || pluginMeta.key === 'hud') {
      const installMeta = {
        geminiDir,
        dataDir: path.join(dataDir, pluginMeta.key),
        installedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(stagingDir, 'install-meta.json'),
        `${JSON.stringify(installMeta, null, 2)}\n`,
        'utf8',
      );
      installMetaWritten = true;
    }

    if (fs.existsSync(dstDir)) {
      syncDirInPlace(dstDir, backupDir);
      hasBackup = true;
    }

    moveOrCopyDirSync(stagingDir, dstDir, { renameImpl, copyFileImpl });
  } catch (err) {
    rmDirBestEffort(stagingDir);
    if (hasBackup && fs.existsSync(backupDir)) {
      try {
        syncDirInPlace(backupDir, dstDir);
        rmDirBestEffort(backupDir);
      } catch (rollbackErr) {
        throw new Error(
          `${String(err?.message || err)} (Rollback failed: ${String(
            rollbackErr?.message || rollbackErr,
          )}; backup preserved at "${backupDir}")`,
        );
      }
    }
    throw err;
  }

  rmDirBestEffort(stagingDir);
  rmDirBestEffort(backupDir);

  return {
    module: pluginMeta.key,
    slug: pluginMeta.slug,
    targetDir: dstDir,
    autoOpenCopied,
    memoryLoaderResolved,
    installMetaWritten,
  };
}

function initializeSyncUserFiles({
  pluginsSrcDir,
  geminiDir,
  dataDir,
  gitRemote,
  branch,
  workNotes,
  dryRun,
}) {
  const syncSrcTemplates = path.join(pluginsSrcDir, PLUGINS.sync.slug, 'templates');
  const syncDataDir = path.join(dataDir, 'sync');
  const syncConfigPath = path.join(syncDataDir, 'config.json');

  const existingConfig = readJsonFileSafe(syncConfigPath, {});
  const existingGitMode =
    existingConfig.mode === 'git' || (existingConfig.mode === undefined && Boolean(existingConfig.gitEnabled));
  const mode = gitRemote || existingGitMode ? 'git' : 'local';
  const effectiveRemoteUrl =
    gitRemote || (typeof existingConfig.remoteUrl === 'string' ? existingConfig.remoteUrl.trim() : '');
  const effectiveBranch =
    branch ||
    (typeof existingConfig.branch === 'string' && existingConfig.branch.trim()
      ? existingConfig.branch.trim()
      : 'main');
  const effectiveWorkNotes = workNotes
    ? true
    : Boolean(existingConfig.workNotesEnabled ?? existingConfig.syncWorkNotes);
  const effectiveSyncGeminiMd =
    typeof existingConfig.syncGeminiMd === 'boolean' ? existingConfig.syncGeminiMd : false;

  const nextConfig = {
    ...existingConfig,
    mode,
    geminiDir,
    remoteUrl: effectiveRemoteUrl,
    branch: effectiveBranch,
    workNotesEnabled: effectiveWorkNotes,
    syncGeminiMd: effectiveSyncGeminiMd,
  };
  delete nextConfig.gitEnabled;
  delete nextConfig.syncWorkNotes;

  const candidateStarters = ['MEMORY.md', 'MEMORY_ARCHIVE.md'];
  if (workNotes) {
    candidateStarters.push('WORK_NOTES.md');
  }

  const createdFiles = [];
  const preservedFiles = [];
  const skippedStarterFiles = [];

  for (const name of candidateStarters) {
    const dest = path.join(geminiDir, name);
    if (fs.existsSync(dest)) {
      preservedFiles.push(dest);
      continue;
    }
    // P0: When --git-remote is passed, do NOT create starter MEMORY.md / MEMORY_ARCHIVE.md (or WORK_NOTES.md)
    // so first sync pulls cleanly from the remote repo without risking starter files overwriting PC1.
    if (gitRemote) {
      skippedStarterFiles.push(dest);
      continue;
    }
    createdFiles.push(dest);
    if (!dryRun) {
      fs.mkdirSync(geminiDir, { recursive: true });
      const tpl = path.join(syncSrcTemplates, name);
      const content = fs.existsSync(tpl) ? fs.readFileSync(tpl, 'utf8') : FALLBACK_STARTERS[name];
      fs.writeFileSync(dest, content, 'utf8');
    }
  }

  if (!dryRun) {
    writeJsonAtomic(syncConfigPath, nextConfig);
  }

  return {
    syncConfigPath,
    config: nextConfig,
    createdFiles,
    preservedFiles,
    skippedStarterFiles,
  };
}

function printHelp() {
  const text = `AGY SUITE Installer (zero dependencies, Node.js >= 18)

Usage:
  node install.mjs [options]

Options:
  --doctor                     Run read-only environment diagnostics
  --dry-run                    Preview all actions without writing any files
  --modules=<list|all>         Modules to install/uninstall: hud,core,sync (default install: hud,core; default uninstall: all)
  --apply-settings             Patch IDE/workspace JSONC settings with .agy-bak-* backups
  --auto-open-hud              Copy optional auto-open-hud.md rule into installed agy-suite-hud/rules/
  --git-remote <url>           Configure multi-PC Git sync remote URL in sync/config.json (requires sync module)
  --branch <name>              Git branch for sync/config.json (default: main; requires sync module)
  --work-notes                 Enable WORK_NOTES.md bridge (requires sync module)
  --uninstall                  Remove installed agy-suite-* plugins (never edits config.json)
  --restore-backups            With full --uninstall, restore earliest pre-suite settings backups (backs up current file first)
  --workspace <path>           Target .code-workspace file for --doctor or --apply-settings (takes precedence over global IDE profile)
  --settings-path <path>       Explicit settings.json path override
  --target-root <dir>          Override plugin install root (default: <gemini-dir>/config/plugins)
  --data-dir <dir>             Override persistent data dir (default: <gemini-dir>/agy-suite)
  --gemini-dir <dir>           Override ~/.gemini base directory
  --json                       Emit JSON output (redacts credentials and omits full settings preview)
  -h, --help                   Show this help text
`;
  process.stdout.write(text);
}

export function runInstaller(
  argv = process.argv.slice(2),
  {
    pluginsSrcDir = '',
    renameImpl = fs.renameSync,
    copyFileImpl = copyFileWithRetry,
    silent = false,
  } = {},
) {
  checkNodeVersion();
  const opts = parseInstallArgs(argv);
  const log = (msg) => {
    if (!silent) process.stdout.write(`${msg}\n`);
  };

  if (opts.help) {
    if (!silent) printHelp();
    return { action: 'help' };
  }

  const geminiDir = opts.geminiDir ? path.resolve(opts.geminiDir) : path.join(os.homedir(), '.gemini');
  const targetRoot = opts.targetRoot
    ? path.resolve(opts.targetRoot)
    : path.join(geminiDir, 'config', 'plugins');
  const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : path.join(geminiDir, 'agy-suite');
  const manifestPath = path.join(dataDir, 'install-manifest.json');
  const resolvedPluginsSrcDir = path.resolve(
    pluginsSrcDir || opts.pluginsSrcDir || DEFAULT_PLUGINS_SRC_DIR,
  );

  // Mode 1: Doctor delegation
  if (opts.doctor) {
    const report = runDiagnostics({
      geminiDir,
      settingsPath: opts.settingsPath,
      workspacePath: opts.workspacePath,
    });
    if (opts.json) {
      log(JSON.stringify(report, null, 2));
    } else {
      log(formatDoctorReport(report));
    }
    return { action: 'doctor', report };
  }

  // Mode 2: Uninstall
  if (opts.uninstall) {
    const manifest = readJsonFileSafe(manifestPath, null);
    const uninstallTargetRoot = opts.targetRoot
      ? path.resolve(opts.targetRoot)
      : typeof manifest?.targetRoot === 'string' && manifest.targetRoot.trim()
        ? path.resolve(manifest.targetRoot)
        : targetRoot;

    const modules = parseModulesList(opts.modulesRaw, ALL_MODULE_KEYS);
    const presentBeforeUninstall = ALL_MODULE_KEYS.filter((k) =>
      fs.existsSync(path.join(uninstallTargetRoot, PLUGINS[k].slug)),
    );
    const installedSet = new Set([
      ...(Array.isArray(manifest?.installedModules) ? manifest.installedModules : []),
      ...presentBeforeUninstall,
    ]);
    const remainingAfterUninstall = [...installedSet].filter((m) => !modules.includes(m));
    const isFullUninstall = remainingAfterUninstall.length === 0;

    const removed = [];
    const notFound = [];
    const restoredBackups = [];
    let restoreSkippedReason = null;

    for (const modKey of modules) {
      const meta = PLUGINS[modKey];
      const dstDir = path.join(uninstallTargetRoot, meta.slug);
      if (!fs.existsSync(dstDir)) {
        notFound.push(dstDir);
        continue;
      }
      if (!readMatchingPluginManifest(dstDir, meta.slug)) {
        throw new Error(
          `Refusing to uninstall "${dstDir}": missing valid plugin.json with name "${meta.slug}".`,
        );
      }
      if (!opts.dryRun) {
        rmDirSafe(dstDir);
      }
      removed.push({ module: modKey, slug: meta.slug, targetDir: dstDir });
    }

    if (opts.restoreBackups) {
      if (!isFullUninstall) {
        restoreSkippedReason = `Partial uninstall (${remainingAfterUninstall.join(', ')} still installed): --restore-backups only restores settings when all installed suite modules are removed.`;
      } else {
        const backups = Array.isArray(manifest?.backups) ? manifest.backups : [];
        // Keep EARLIEST existing pre-suite backup per originalPath.
        const earliestByOriginal = new Map();
        for (const entry of backups) {
          if (entry?.originalPath && entry?.backupPath && fs.existsSync(entry.backupPath)) {
            const existing = earliestByOriginal.get(entry.originalPath);
            if (!existing) {
              earliestByOriginal.set(entry.originalPath, entry);
            } else {
              const existingTs = Date.parse(existing.createdAt || '');
              const entryTs = Date.parse(entry.createdAt || '');
              if (Number.isFinite(entryTs) && (!Number.isFinite(existingTs) || entryTs < existingTs)) {
                earliestByOriginal.set(entry.originalPath, entry);
              }
            }
          }
        }
        for (const entry of earliestByOriginal.values()) {
          let preRestoreBackupPath = null;
          if (!opts.dryRun) {
            fs.mkdirSync(path.dirname(entry.originalPath), { recursive: true });
            if (fs.existsSync(entry.originalPath)) {
              const ts = formatBackupTimestamp(new Date());
              preRestoreBackupPath = `${entry.originalPath}.agy-pre-restore-${ts}`;
              if (fs.existsSync(preRestoreBackupPath)) {
                preRestoreBackupPath = `${entry.originalPath}.agy-pre-restore-${ts}-${crypto.randomBytes(2).toString('hex')}`;
              }
              fs.copyFileSync(entry.originalPath, preRestoreBackupPath);
            }
            fs.copyFileSync(entry.backupPath, entry.originalPath);
          }
          restoredBackups.push({
            originalPath: entry.originalPath,
            backupPath: entry.backupPath,
            preRestoreBackupPath,
          });
        }
      }
    }

    if (!opts.dryRun && fs.existsSync(manifestPath)) {
      const currentManifest = readJsonFileSafe(manifestPath, {});
      const remaining = (Array.isArray(currentManifest.installedModules)
        ? currentManifest.installedModules
        : []
      ).filter((m) => !modules.includes(m));
      writeJsonAtomic(manifestPath, {
        ...currentManifest,
        updatedAt: new Date().toISOString(),
        installedModules: remaining,
      });
    }

    const result = {
      action: 'uninstall',
      dryRun: opts.dryRun,
      modules,
      targetRoot: uninstallTargetRoot,
      removed,
      notFound,
      restoredBackups,
      restoreSkippedReason,
    };

    if (opts.json) {
      log(JSON.stringify(result, null, 2));
    } else {
      const prefix = opts.dryRun ? '[dry-run] ' : '';
      log(`${prefix}Uninstall complete for modules: ${modules.join(', ')}`);
      for (const item of removed) {
        log(`  - ${opts.dryRun ? 'Would remove' : 'Removed'} ${item.targetDir}`);
      }
      if (restoreSkippedReason) {
        log(`  - [SKIP] ${restoreSkippedReason}`);
      }
      for (const b of restoredBackups) {
        log(
          `  - ${opts.dryRun ? 'Would restore' : 'Restored'} ${b.originalPath} from ${b.backupPath}` +
            (b.preRestoreBackupPath ? ` (pre-restore backup: ${b.preRestoreBackupPath})` : ''),
        );
      }
      log('Note: ~/.gemini/config/config.json is never modified; user data in ~/.gemini/agy-suite/ and MEMORY.md was preserved.');
    }
    return result;
  }

  // Mode 3: Install
  const modules = parseModulesList(opts.modulesRaw, DEFAULT_INSTALL_MODULES);

  if (!modules.includes('sync') && (opts.hasGitRemote || opts.workNotes || opts.hasBranch)) {
    throw new Error(
      'Options --git-remote, --branch, and --work-notes require the "sync" module. Include "sync" in --modules (e.g. --modules=hud,core,sync).',
    );
  }

  const validatedGitRemote = opts.hasGitRemote ? validateGitRemoteUrl(opts.gitRemote) : '';
  const validatedBranch = opts.hasBranch ? validateGitBranch(opts.branch) : '';

  const installed = [];
  let syncSetup = null;
  let settingsResult = null;

  if (opts.dryRun) {
    for (const modKey of modules) {
      const meta = PLUGINS[modKey];
      const srcDir = path.join(resolvedPluginsSrcDir, meta.slug);
      const dstDir = path.join(targetRoot, meta.slug);
      if (!fs.existsSync(path.join(srcDir, 'plugin.json'))) {
        throw new Error(`Missing plugin source manifest at ${srcDir}`);
      }
      installed.push({
        module: modKey,
        slug: meta.slug,
        sourceDir: srcDir,
        targetDir: dstDir,
        autoOpenPlanned: modKey === 'hud' && opts.autoOpenHud,
        memoryLoaderPlanned: modKey === 'sync',
        installMetaPlanned: modKey === 'sync' || modKey === 'hud',
      });
    }

    if (modules.includes('sync')) {
      syncSetup = initializeSyncUserFiles({
        pluginsSrcDir: resolvedPluginsSrcDir,
        geminiDir,
        dataDir,
        gitRemote: validatedGitRemote,
        branch: validatedBranch,
        workNotes: opts.workNotes,
        dryRun: true,
      });
    }

    if (opts.applySettings) {
      settingsResult = applySettingsPatch({
        settingsPath: opts.settingsPath,
        workspacePath: opts.workspacePath,
        dryRun: true,
      });
    }

    const dryOk = settingsResult ? Boolean(settingsResult.ok) : true;
    const dryResult = {
      ok: dryOk,
      action: 'install',
      dryRun: true,
      modules,
      targetRoot,
      dataDir,
      geminiDir,
      installed,
      syncSetup: opts.json ? sanitizeSyncSetupForJson(syncSetup) : syncSetup,
      settingsResult: opts.json ? sanitizeSettingsResultForJson(settingsResult) : settingsResult,
    };

    if (opts.json) {
      log(JSON.stringify(dryResult, null, 2));
    } else {
      log(`[dry-run] Would install modules (${modules.join(', ')}) into ${targetRoot}:`);
      for (const item of installed) {
        log(`  - ${item.slug} -> ${item.targetDir}`);
        if (item.autoOpenPlanned) log('      + copy templates/auto-open-hud.md -> rules/auto-open-hud.md');
        if (item.memoryLoaderPlanned) {
          log(`      + resolve MEMORY-LOADER.md -> ${formatPosixFileRef(path.join(geminiDir, 'MEMORY.md'))}`);
        }
        if (item.installMetaPlanned) {
          log(`      + write install-meta.json (dataDir: ${path.join(dataDir, item.module)})`);
        }
      }
      if (syncSetup) {
        log(`[dry-run] Would write sync config: ${syncSetup.syncConfigPath}`);
        for (const f of syncSetup.createdFiles) log(`  + create starter ${f}`);
        for (const f of syncSetup.preservedFiles) log(`  = preserve existing ${f}`);
        for (const f of syncSetup.skippedStarterFiles || []) {
          log(`  ~ skip starter ${f} (--git-remote set; first sync will pull from remote)`);
        }
      }
      if (settingsResult) {
        if (!settingsResult.ok) {
          log(
            `[dry-run] Settings patch FAILED/REFUSED (${settingsResult.target?.path || 'settings'}): ${settingsResult.error}`,
          );
        } else {
          log(
            `[dry-run] Settings patch preview: ${
              settingsResult.changed ? 'changes pending' : settingsResult.skipped ? 'skipped' : 'already up to date'
            }`,
          );
        }
      }
      log('[dry-run] config.json is NEVER modified by this installer.');
    }
    return dryResult;
  }

  // P1: Validate --apply-settings BEFORE mutating any plugin files or user data.
  if (opts.applySettings) {
    const preflight = applySettingsPatch({
      settingsPath: opts.settingsPath,
      workspacePath: opts.workspacePath,
      dryRun: true,
    });
    if (!preflight.ok) {
      throw new Error(
        `Settings patch refused for "${preflight.target?.path || 'settings'}": ${preflight.error}`,
      );
    }
  }

  for (const modKey of modules) {
    const meta = PLUGINS[modKey];
    installed.push(
      installSinglePlugin(meta, {
        pluginsSrcDir: resolvedPluginsSrcDir,
        targetRoot,
        dataDir,
        geminiDir,
        autoOpenHud: opts.autoOpenHud,
        renameImpl,
        copyFileImpl,
      }),
    );
  }

  if (modules.includes('sync')) {
    syncSetup = initializeSyncUserFiles({
      pluginsSrcDir: resolvedPluginsSrcDir,
      geminiDir,
      dataDir,
      gitRemote: validatedGitRemote,
      branch: validatedBranch,
      workNotes: opts.workNotes,
      dryRun: false,
    });
  }

  // Write manifest BEFORE patching settings so installed modules & targetRoot are recorded even if settings write fails.
  const prevManifest = readJsonFileSafe(manifestPath, {
    version: '1.0.0',
    installedModules: [],
    backups: [],
  });
  const mergedModules = Array.from(new Set([...(prevManifest.installedModules || []), ...modules]));
  const backups = Array.isArray(prevManifest.backups) ? [...prevManifest.backups] : [];

  const nextManifest = {
    version: '1.0.0',
    updatedAt: new Date().toISOString(),
    targetRoot,
    geminiDir,
    installedModules: mergedModules,
    backups,
  };
  writeJsonAtomic(manifestPath, nextManifest);

  if (opts.applySettings) {
    settingsResult = applySettingsPatch({
      settingsPath: opts.settingsPath,
      workspacePath: opts.workspacePath,
      dryRun: false,
    });
    if (!settingsResult.ok) {
      throw new Error(
        `Settings patch refused for "${settingsResult.target?.path || 'settings'}": ${settingsResult.error}`,
      );
    }
    if (settingsResult.backupPath && settingsResult.target?.path) {
      backups.push({
        originalPath: settingsResult.target.path,
        backupPath: settingsResult.backupPath,
        createdAt: new Date().toISOString(),
      });
      writeJsonAtomic(manifestPath, {
        ...nextManifest,
        updatedAt: new Date().toISOString(),
        backups,
      });
    }
  }

  const result = {
    ok: true,
    action: 'install',
    dryRun: false,
    modules,
    targetRoot,
    dataDir,
    geminiDir,
    manifestPath,
    installed,
    syncSetup: opts.json ? sanitizeSyncSetupForJson(syncSetup) : syncSetup,
    settingsResult: opts.json ? sanitizeSettingsResultForJson(settingsResult) : settingsResult,
  };

  if (opts.json) {
    log(JSON.stringify(result, null, 2));
  } else {
    log(`Installed AGY SUITE modules (${modules.join(', ')}) to ${targetRoot}:`);
    for (const item of installed) {
      const meta = PLUGINS[item.module];
      log(`  - [${meta.displayName}](customization://${item.slug}) -> ${item.targetDir}`);
    }
    if (syncSetup) {
      log(`Sync config written to ${syncSetup.syncConfigPath}`);
      if (syncSetup.preservedFiles.length > 0) {
        log(`Preserved existing user files: ${syncSetup.preservedFiles.join(', ')}`);
      }
      if ((syncSetup.skippedStarterFiles || []).length > 0) {
        log(
          `Skipped starter file creation (--git-remote configured; first sync will pull from remote): ${syncSetup.skippedStarterFiles.join(', ')}`,
        );
      }
    }
    if (settingsResult?.changed) {
      log(`Patched IDE settings: ${settingsResult.target.path} (backup: ${settingsResult.backupPath || 'none'})`);
    } else if (settingsResult?.skipped) {
      log(`[SKIP] Settings patch skipped: ${settingsResult.reason}`);
    }
    log('Note: ~/.gemini/config/config.json is never modified. Uninstall anytime with: node install.mjs --uninstall');
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
    const res = runInstaller();
    if (res && res.ok === false) {
      process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`Install failed: ${String(err?.message || err)}\n`);
    process.exitCode = 1;
  }
}
