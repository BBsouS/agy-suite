import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applySettingsPatch,
  parseJsonc,
  patchJsoncSettings,
  resolveIdeSettingsTarget,
  runDiagnostics,
  stripJsonc,
} from '../plugins/agy-suite-core/bin/doctor.mjs';
import {
  callConversationService,
  parseLoopbackLsAddress,
  runArchiveSessions,
  selectArchivableConversations,
} from '../plugins/agy-suite-core/bin/archive-sessions.mjs';
import {
  formatPosixFileRef,
  redactRemoteUrl,
  runInstaller,
  syncDirInPlace,
  validateGitBranch,
  validateGitRemoteUrl,
} from '../install.mjs';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, '..');
const CORE_PLUGIN_SRC = path.join(REPO_ROOT, 'plugins', 'agy-suite-core');

function makeTempDir(prefix = 'agy-suite-core-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFixturePluginsRoot(baseDir) {
  const pluginsDir = path.join(baseDir, 'fixture-plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  // Use the real agy-suite-core plugin from this repo.
  syncDirInPlace(CORE_PLUGIN_SRC, path.join(pluginsDir, 'agy-suite-core'));

  // Minimal valid sibling fixtures for hud and sync so tests remain 100% self-contained.
  const hudDir = path.join(pluginsDir, 'agy-suite-hud');
  fs.mkdirSync(path.join(hudDir, 'templates'), { recursive: true });
  fs.writeFileSync(
    path.join(hudDir, 'plugin.json'),
    JSON.stringify({ name: 'agy-suite-hud', displayName: 'AGY SUITE — HUD', version: '1.0.0' }, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(hudDir, 'templates', 'auto-open-hud.md'),
    '# Auto-Open HUD\nOpen HUD sidecar on start.\n',
    'utf8',
  );

  const syncDir = path.join(pluginsDir, 'agy-suite-sync');
  fs.mkdirSync(path.join(syncDir, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(syncDir, 'templates'), { recursive: true });
  fs.writeFileSync(
    path.join(syncDir, 'plugin.json'),
    JSON.stringify({ name: 'agy-suite-sync', displayName: 'AGY SUITE — Memory & Bridge', version: '1.0.0' }, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(syncDir, 'rules', 'MEMORY-LOADER.md'),
    '# 2-Tier Memory Loader\n@[MEMORY.md]({{MEMORY_MD_PATH}})\n',
    'utf8',
  );
  fs.writeFileSync(path.join(syncDir, 'templates', 'MEMORY.md'), '# Starter Memory\n', 'utf8');
  fs.writeFileSync(path.join(syncDir, 'templates', 'MEMORY_ARCHIVE.md'), '# Starter Archive\n', 'utf8');
  fs.writeFileSync(path.join(syncDir, 'templates', 'WORK_NOTES.md'), '# Starter Work Notes\n', 'utf8');

  return pluginsDir;
}

test('rules/AGENTS.md stays razor-thin (<= 1.3KB)', () => {
  const rulesPath = path.join(CORE_PLUGIN_SRC, 'rules', 'AGENTS.md');
  const content = fs.readFileSync(rulesPath, 'utf8');
  assert.ok(Buffer.byteLength(content, 'utf8') <= 1300, `Expected <= 1300 bytes, got ${Buffer.byteLength(content, 'utf8')}`);
});

test('JSONC comment-preserving patcher preserves comments, URLs, block comments, and trailing commas', () => {
  const original = `{
  // Top user comment
  "editor.fontSize": 14, // inline font comment
  /* Multi-line
     block comment */
  "custom.homepage": "https://example.com/a//b/*keep*/",
  "files.watcherExclude": {
    // Existing exclude comment
    "**/.git/**": true,
  },
  "antigravity.heartbeatIntervalMs": 30000 /* old value */
}
`;

  const result = patchJsoncSettings(original);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);

  // Original comments and string literals must remain intact.
  assert.ok(result.text.includes('// Top user comment'));
  assert.ok(result.text.includes('// inline font comment'));
  assert.ok(result.text.includes('/* Multi-line\n     block comment */'));
  assert.ok(result.text.includes('"https://example.com/a//b/*keep*/"'));
  assert.ok(result.text.includes('// Existing exclude comment'));
  assert.ok(result.text.includes('/* old value */'));

  // Stripped output must be strict valid JSON with expected values.
  const reparsed = JSON.parse(stripJsonc(result.text));
  assert.equal(reparsed['antigravity.heartbeatIntervalMs'], 0);
  assert.equal(reparsed['custom.homepage'], 'https://example.com/a//b/*keep*/');
  assert.equal(reparsed['files.watcherExclude']['**/.git/**'], true);
  assert.equal(reparsed['files.watcherExclude']['**/antigravity/**'], true);
  assert.equal(reparsed['files.watcherExclude']['**/node_modules/**'], true);
  assert.equal(reparsed['files.watcherExclude']['**/.venv/**'], true);
  assert.equal(reparsed['files.watcherExclude']['**/.git/objects/**'], true);
  assert.equal(reparsed['search.exclude']['**/antigravity/**'], true);

  // Second pass must be a clean no-op.
  const second = patchJsoncSettings(result.text);
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
});

test('JSONC patcher handles inline comment after last property without trailing comma', () => {
  const original = `{
  "editor.tabSize": 2 // trailing inline comment with no comma
}
`;
  const result = patchJsoncSettings(original);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.ok(result.text.includes('"editor.tabSize": 2, // trailing inline comment with no comma'));
  const parsed = parseJsonc(result.text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value['editor.tabSize'], 2);
  assert.equal(parsed.value['antigravity.heartbeatIntervalMs'], 0);
});

test('JSONC patcher refuses malformed JSONC cleanly and emits manual snippet without writing', () => {
  const tmp = makeTempDir();
  try {
    const settingsPath = path.join(tmp, 'settings.json');
    const broken = '{\n  "editor.fontSize": 14\n  "broken": true\n}\n';
    fs.writeFileSync(settingsPath, broken, 'utf8');

    const res = applySettingsPatch({ settingsPath, dryRun: false });
    assert.equal(res.ok, false);
    assert.equal(res.malformed, true);
    assert.ok(res.manualSnippet.includes('antigravity.heartbeatIntervalMs'));

    // Original file untouched and no backup created.
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), broken);
    const files = fs.readdirSync(tmp);
    assert.equal(files.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applySettingsPatch creates .agy-bak-* backup preserving exact original bytes', () => {
  const tmp = makeTempDir();
  try {
    const settingsPath = path.join(tmp, 'settings.json');
    const original = '{\n  // keep me\n  "editor.wordWrap": "on"\n}\n';
    fs.writeFileSync(settingsPath, original, 'utf8');

    const res = applySettingsPatch({ settingsPath, dryRun: false });
    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.ok(res.backupPath && path.basename(res.backupPath).startsWith('settings.json.agy-bak-'));
    assert.equal(fs.readFileSync(res.backupPath, 'utf8'), original);

    const updated = parseJsonc(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(updated.ok, true);
    assert.equal(updated.value['antigravity.heartbeatIntervalMs'], 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveIdeSettingsTarget prefers Antigravity IDE and never fabricates User/ in standalone Antigravity 2.0', () => {
  const tmp = makeTempDir();
  try {
    const appData = path.join(tmp, 'AppData', 'Roaming');

    // Case 1: Only standalone Antigravity 2.0 profile exists (no User/settings.json or User/globalStorage).
    const standaloneDir = path.join(appData, 'antigravity');
    fs.mkdirSync(standaloneDir, { recursive: true });
    fs.writeFileSync(path.join(standaloneDir, 'Preferences'), '{}', 'utf8');

    const skipRes = resolveIdeSettingsTarget({
      platform: 'win32',
      env: { APPDATA: appData },
      homeDir: tmp,
    });
    assert.equal(skipRes.mode, 'skip');
    assert.equal(skipRes.path, null);
    assert.equal(fs.existsSync(path.join(standaloneDir, 'User')), false);

    // Case 1b: With --workspace fallback when no IDE profile exists.
    const wsPath = path.join(tmp, 'demo.code-workspace');
    fs.writeFileSync(wsPath, '{\n  "folders": []\n}\n', 'utf8');
    const wsRes = resolveIdeSettingsTarget({
      platform: 'win32',
      env: { APPDATA: appData },
      homeDir: tmp,
      workspacePath: wsPath,
    });
    assert.equal(wsRes.mode, 'workspace');
    assert.equal(wsRes.path, wsPath);
    assert.equal(wsRes.isWorkspaceFile, true);

    // Case 2: Legacy Antigravity/User/globalStorage exists -> allowed fallback.
    fs.mkdirSync(path.join(appData, 'Antigravity', 'User', 'globalStorage'), { recursive: true });
    const legacyRes = resolveIdeSettingsTarget({
      platform: 'win32',
      env: { APPDATA: appData },
      homeDir: tmp,
    });
    assert.equal(legacyRes.mode, 'ide-legacy');
    assert.equal(legacyRes.path, path.join(appData, 'Antigravity', 'User', 'settings.json'));

    // Case 3: Antigravity IDE/User/settings.json exists -> preferred over legacy.
    const primarySettings = path.join(appData, 'Antigravity IDE', 'User', 'settings.json');
    fs.mkdirSync(path.dirname(primarySettings), { recursive: true });
    fs.writeFileSync(primarySettings, '{}\n', 'utf8');
    const primaryRes = resolveIdeSettingsTarget({
      platform: 'win32',
      env: { APPDATA: appData },
      homeDir: tmp,
    });
    assert.equal(primaryRes.mode, 'ide-primary');
    assert.equal(primaryRes.path, primarySettings);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runDiagnostics detects rule byte budget, Linux inotify, and disabled plugins without editing config.json', () => {
  const tmp = makeTempDir();
  try {
    const geminiDir = path.join(tmp, '.gemini');
    fs.mkdirSync(path.join(geminiDir, 'config'), { recursive: true });
    const configPath = path.join(geminiDir, 'config', 'config.json');
    const configRaw = JSON.stringify({ plugins: { 'agy-suite-core': { enabled: false } } }, null, 2);
    fs.writeFileSync(configPath, configRaw, 'utf8');
    fs.writeFileSync(path.join(geminiDir, 'GEMINI.md'), 'x'.repeat(25_000), 'utf8');

    const report = runDiagnostics({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: path.join(tmp, 'xdg') },
      homeDir: tmp,
      geminiDir,
      spawnImpl: () => ({ status: 0, stdout: '/usr/bin/node\n/usr/bin/git\n' }),
      readFileImpl: () => '8192\n',
    });

    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.equal(byId['linux-inotify'].severity, 'WARN');
    assert.equal(byId['rule-byte-budget'].severity, 'CRITICAL');
    assert.equal(byId['disabled-plugins'].severity, 'WARN');
    assert.equal(fs.readFileSync(configPath, 'utf8'), configRaw);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('selectArchivableConversations protects current, pinned, starred, non-idle, and enforces --days & --max', () => {
  const nowMs = Date.parse('2026-11-26T12:00:00Z');
  const conversations = [
    {
      id: 'conv-current',
      annotations: { title: 'Current' },
      state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-01T00:00:00Z' },
    },
    {
      id: 'conv-pinned',
      annotations: { title: 'Pinned', pinned: true },
      state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-01T00:00:00Z' },
    },
    {
      id: 'conv-starred',
      annotations: { title: 'Starred', starred: true },
      state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-01T00:00:00Z' },
    },
    {
      id: 'conv-running',
      annotations: { title: 'Running' },
      state: { runState: 'RUN_STATE_RUNNING', updateTime: '2026-11-01T00:00:00Z' },
    },
    {
      id: 'conv-recent',
      annotations: { title: 'Recent' },
      state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-24T00:00:00Z' },
    },
    {
      id: 'conv-old-2',
      annotations: { title: 'Old 2' },
      state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-10T00:00:00Z' },
    },
    {
      id: 'conv-old-1',
      annotations: { title: 'Old 1 (oldest)' },
      state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-02T00:00:00Z' },
    },
    {
      id: 'conv-old-3',
      annotations: { title: 'Old 3' },
      state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-15T00:00:00Z' },
    },
  ];

  const sel = selectArchivableConversations(conversations, {
    nowMs,
    days: 7,
    max: 2,
    currentConversationId: 'conv-current',
  });

  assert.equal(sel.totalScanned, 8);
  assert.equal(sel.totalEligible, 3);
  assert.equal(sel.truncatedByMax, 1);
  assert.deepEqual(
    sel.candidates.map((c) => c.id),
    ['conv-old-1', 'conv-old-2'],
  );
  assert.equal(sel.skipped.current, 1);
  assert.equal(sel.skipped.pinned, 1);
  assert.equal(sel.skipped.starred, 1);
  assert.equal(sel.skipped.notIdle, 1);
  assert.equal(sel.skipped.tooRecent, 1);
});

test('runArchiveSessions dry-run makes 0 mutations, --apply archives via UpdateConversation only, missing env fails cleanly', async () => {
  // Missing env vars fail cleanly.
  const missingRes = await runArchiveSessions(['--days', '7'], { env: {} });
  assert.equal(missingRes.ok, false);
  assert.match(missingRes.error, /ANTIGRAVITY_LS_ADDRESS/);

  // Explicit guard against DeleteConversation.
  await assert.rejects(
    () =>
      callConversationService('DeleteConversation', { conversationId: 'x' }, {
        address: '127.0.0.1:9999',
        csrfToken: 'tok',
      }),
    /Disallowed ConversationService method/,
  );

  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (url.endsWith('/ListConversations')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            conversations: [
              {
                id: 'c-old',
                annotations: { title: 'Old idle' },
                state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-01T00:00:00Z' },
              },
              {
                id: 'c-cur',
                annotations: { title: 'Current' },
                state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-01T00:00:00Z' },
              },
            ],
            nextPageToken: '',
          }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'c-old', annotations: { archived: true } }),
    };
  };

  const env = {
    ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:43210',
    ANTIGRAVITY_CSRF_TOKEN: 'secret-csrf',
    ANTIGRAVITY_CONVERSATION_ID: 'c-cur',
  };
  const nowMs = Date.parse('2026-11-26T12:00:00Z');

  // Dry-run: only ListConversations called, 0 UpdateConversation calls.
  const dryRes = await runArchiveSessions(['--days', '7'], { env, fetchImpl: mockFetch, nowMs });
  assert.equal(dryRes.ok, true);
  assert.equal(dryRes.dryRun, true);
  assert.equal(dryRes.archivedCount, 0);
  assert.equal(dryRes.candidates.length, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/ListConversations'));
  assert.equal(calls[0].headers['Connect-Protocol-Version'], '1');
  assert.equal(calls[0].headers['x-antigravity-csrf-token'], 'secret-csrf');

  // Apply: calls UpdateConversation with archived: true.
  calls.length = 0;
  const applyRes = await runArchiveSessions(['--days', '7', '--apply'], { env, fetchImpl: mockFetch, nowMs });
  assert.equal(applyRes.ok, true);
  assert.equal(applyRes.dryRun, false);
  assert.equal(applyRes.archivedCount, 1);
  assert.deepEqual(applyRes.archivedIds, ['c-old']);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.endsWith('/UpdateConversation'));
  assert.deepEqual(calls[1].body, {
    conversationId: 'c-old',
    annotations: { archived: true },
  });
});

test('install.mjs end-to-end in os.tmpdir(): --dry-run writes 0 files, install resolves MEMORY-LOADER without overwriting MEMORY.md, --uninstall --restore-backups cleans up', () => {
  const tmp = makeTempDir('agy suite space test-');
  try {
    const pluginsSrcDir = createFixturePluginsRoot(tmp);
    const geminiDir = path.join(tmp, 'user home', '.gemini');
    const targetRoot = path.join(geminiDir, 'config', 'plugins');
    const dataDir = path.join(geminiDir, 'agy-suite');
    const settingsPath = path.join(tmp, 'ide', 'settings.json');
    const configJsonPath = path.join(geminiDir, 'config', 'config.json');

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.mkdirSync(path.dirname(configJsonPath), { recursive: true });
    const originalSettings = '{\n  // user comment\n  "editor.fontSize": 15\n}\n';
    const originalConfigJson = '{"plugins":{"agy-suite-hud":{"enabled":true}}}\n';
    const existingMemory = '# My Personal Notes\nDO NOT OVERWRITE!\n';
    fs.writeFileSync(settingsPath, originalSettings, 'utf8');
    fs.writeFileSync(configJsonPath, originalConfigJson, 'utf8');
    fs.writeFileSync(path.join(geminiDir, 'MEMORY.md'), existingMemory, 'utf8');

    // 1. --dry-run writes 0 files.
    const dryRes = runInstaller(
      [
        '--dry-run',
        '--modules=hud,core,sync',
        '--apply-settings',
        '--auto-open-hud',
        '--work-notes',
        '--git-remote',
        'https://example.invalid/private/memory.git',
        '--target-root',
        targetRoot,
        '--data-dir',
        dataDir,
        '--gemini-dir',
        geminiDir,
        '--settings-path',
        settingsPath,
      ],
      { pluginsSrcDir, silent: true },
    );
    assert.equal(dryRes.dryRun, true);
    assert.equal(fs.existsSync(targetRoot), false);
    assert.equal(fs.existsSync(dataDir), false);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), originalSettings);
    assert.equal(fs.existsSync(path.join(geminiDir, 'WORK_NOTES.md')), false);

    // 2. Real install of all 3 modules.
    const installRes = runInstaller(
      [
        '--modules=hud,core,sync',
        '--apply-settings',
        '--auto-open-hud',
        '--work-notes',
        '--git-remote',
        'https://example.invalid/private/memory.git',
        '--target-root',
        targetRoot,
        '--data-dir',
        dataDir,
        '--gemini-dir',
        geminiDir,
        '--settings-path',
        settingsPath,
      ],
      { pluginsSrcDir, silent: true },
    );
    assert.equal(installRes.installed.length, 3);
    assert.ok(fs.existsSync(path.join(targetRoot, 'agy-suite-hud', 'plugin.json')));
    assert.ok(fs.existsSync(path.join(targetRoot, 'agy-suite-core', 'plugin.json')));
    assert.ok(fs.existsSync(path.join(targetRoot, 'agy-suite-sync', 'plugin.json')));

    // Optional --auto-open-hud template copied into installed hud/rules/.
    assert.ok(fs.existsSync(path.join(targetRoot, 'agy-suite-hud', 'rules', 'auto-open-hud.md')));

    // MEMORY-LOADER.md dynamically resolved with forward-slash URL-safe space encoding.
    const loaderText = fs.readFileSync(
      path.join(targetRoot, 'agy-suite-sync', 'rules', 'MEMORY-LOADER.md'),
      'utf8',
    );
    const expectedRef = formatPosixFileRef(path.join(geminiDir, 'MEMORY.md'));
    assert.ok(expectedRef.includes('%20'));
    assert.ok(!expectedRef.includes('\\'));
    assert.ok(loaderText.includes(`@[MEMORY.md](${expectedRef})`));
    assert.ok(!loaderText.includes('{{MEMORY_MD_PATH}}'));

    // Existing MEMORY.md preserved; --git-remote skips creating missing starter MEMORY_ARCHIVE.md / WORK_NOTES.md.
    assert.equal(fs.readFileSync(path.join(geminiDir, 'MEMORY.md'), 'utf8'), existingMemory);
    assert.equal(fs.existsSync(path.join(geminiDir, 'MEMORY_ARCHIVE.md')), false);
    assert.equal(fs.existsSync(path.join(geminiDir, 'WORK_NOTES.md')), false);

    // install-meta.json written inside installed hud and sync plugin directories.
    const hudMeta = JSON.parse(fs.readFileSync(path.join(targetRoot, 'agy-suite-hud', 'install-meta.json'), 'utf8'));
    assert.equal(hudMeta.geminiDir, geminiDir);
    assert.equal(hudMeta.dataDir, path.join(dataDir, 'hud'));
    assert.ok(hudMeta.installedAt);
    const syncMeta = JSON.parse(fs.readFileSync(path.join(targetRoot, 'agy-suite-sync', 'install-meta.json'), 'utf8'));
    assert.equal(syncMeta.geminiDir, geminiDir);
    assert.equal(syncMeta.dataDir, path.join(dataDir, 'sync'));
    assert.ok(syncMeta.installedAt);

    // Sync config persisted with canonical schema.
    const syncCfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'sync', 'config.json'), 'utf8'));
    assert.equal(syncCfg.mode, 'git');
    assert.equal(syncCfg.geminiDir, geminiDir);
    assert.equal(syncCfg.remoteUrl, 'https://example.invalid/private/memory.git');
    assert.equal(syncCfg.branch, 'main');
    assert.equal(syncCfg.workNotesEnabled, true);
    assert.equal(syncCfg.syncGeminiMd, false);

    // Settings patched while preserving comments, and config.json untouched.
    const patchedSettings = fs.readFileSync(settingsPath, 'utf8');
    assert.ok(patchedSettings.includes('// user comment'));
    assert.equal(parseJsonc(patchedSettings).value['antigravity.heartbeatIntervalMs'], 0);
    assert.equal(fs.readFileSync(configJsonPath, 'utf8'), originalConfigJson);

    // 3. Uninstall with --restore-backups removes plugins and restores original settings.json.
    const uninstallRes = runInstaller(
      [
        '--uninstall',
        '--modules=all',
        '--restore-backups',
        '--target-root',
        targetRoot,
        '--data-dir',
        dataDir,
        '--gemini-dir',
        geminiDir,
      ],
      { pluginsSrcDir, silent: true },
    );
    assert.equal(uninstallRes.removed.length, 3);
    assert.equal(uninstallRes.restoredBackups.length, 1);
    assert.ok(uninstallRes.restoredBackups[0].preRestoreBackupPath);
    assert.equal(fs.readFileSync(uninstallRes.restoredBackups[0].preRestoreBackupPath, 'utf8'), patchedSettings);
    assert.equal(fs.existsSync(path.join(targetRoot, 'agy-suite-hud')), false);
    assert.equal(fs.existsSync(path.join(targetRoot, 'agy-suite-core')), false);
    assert.equal(fs.existsSync(path.join(targetRoot, 'agy-suite-sync')), false);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), originalSettings);
    assert.equal(fs.readFileSync(path.join(geminiDir, 'MEMORY.md'), 'utf8'), existingMemory);
    assert.equal(fs.readFileSync(configJsonPath, 'utf8'), originalConfigJson);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('JSONC patcher accepts whitespace-only and comment-only settings files cleanly as {}', () => {
  const wsOnly = '   \n\t  \n';
  assert.equal(parseJsonc(wsOnly).ok, true);
  assert.deepEqual(parseJsonc(wsOnly).value, {});
  const wsPatched = patchJsoncSettings(wsOnly);
  assert.equal(wsPatched.ok, true);
  assert.equal(wsPatched.changed, true);
  assert.equal(wsPatched.parsed['antigravity.heartbeatIntervalMs'], 0);

  const commentOnly = '// Top user header\n/* Keep this block comment */\n';
  assert.equal(parseJsonc(commentOnly).ok, true);
  assert.deepEqual(parseJsonc(commentOnly).value, {});
  const commentPatched = patchJsoncSettings(commentOnly);
  assert.equal(commentPatched.ok, true);
  assert.equal(commentPatched.changed, true);
  assert.ok(commentPatched.text.includes('// Top user header'));
  assert.ok(commentPatched.text.includes('/* Keep this block comment */'));
  assert.equal(parseJsonc(commentPatched.text).value['antigravity.heartbeatIntervalMs'], 0);
});

test('JSONC patcher matches LAST occurrence for duplicate keys (same semantics as JSON.parse)', () => {
  const duplicate = `{
  "antigravity.heartbeatIntervalMs": 30000,
  "antigravity.heartbeatIntervalMs": 15000,
  "files.watcherExclude": {
    "**/first/**": true
  },
  "files.watcherExclude": {
    "**/last/**": true
  }
}
`;
  const res = patchJsoncSettings(duplicate);
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  const parsed = parseJsonc(res.text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value['antigravity.heartbeatIntervalMs'], 0);
  assert.equal(parsed.value['files.watcherExclude']['**/last/**'], true);
  assert.equal(parsed.value['files.watcherExclude']['**/antigravity/**'], true);

  // Second pass must be a clean no-op because the last occurrence was updated.
  const second = patchJsoncSettings(res.text);
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
});

test('JSONC patcher preserves explicit user false in files.watcherExclude and search.exclude', () => {
  const original = `{
  "antigravity.heartbeatIntervalMs": 0,
  "files.watcherExclude": {
    "**/node_modules/**": false
  },
  "search.exclude": {
    "**/.venv/**": false
  }
}
`;
  const res = patchJsoncSettings(original);
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  const parsed = parseJsonc(res.text).value;
  assert.equal(parsed['files.watcherExclude']['**/node_modules/**'], false);
  assert.equal(parsed['files.watcherExclude']['**/antigravity/**'], true);
  assert.equal(parsed['search.exclude']['**/.venv/**'], false);
  assert.equal(parsed['search.exclude']['**/antigravity/**'], true);

  // Second pass must be a no-op (never tries to flip false to true).
  const second = patchJsoncSettings(res.text);
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
});

test('explicit --workspace takes precedence over global IDE profile and initializes nonexistent .code-workspace with folders+settings', () => {
  const tmp = makeTempDir('agy-ws-precedence-');
  try {
    const appData = path.join(tmp, 'AppData', 'Roaming');
    const primarySettings = path.join(appData, 'Antigravity IDE', 'User', 'settings.json');
    fs.mkdirSync(path.dirname(primarySettings), { recursive: true });
    fs.writeFileSync(primarySettings, '{"editor.fontSize": 14}\n', 'utf8');

    const newWsPath = path.join(tmp, 'new-project.code-workspace');
    const target = resolveIdeSettingsTarget({
      platform: 'win32',
      env: { APPDATA: appData },
      homeDir: tmp,
      workspacePath: newWsPath,
    });
    assert.equal(target.mode, 'workspace');
    assert.equal(target.path, newWsPath);
    assert.equal(target.isWorkspaceFile, true);
    assert.equal(target.exists, false);

    const patchRes = applySettingsPatch({
      platform: 'win32',
      env: { APPDATA: appData },
      homeDir: tmp,
      workspacePath: newWsPath,
      dryRun: false,
    });
    assert.equal(patchRes.ok, true);
    assert.equal(patchRes.changed, true);
    const written = JSON.parse(fs.readFileSync(newWsPath, 'utf8'));
    assert.deepEqual(written.folders, []);
    assert.equal(written.settings['antigravity.heartbeatIntervalMs'], 0);
    // Global IDE settings untouched.
    assert.equal(fs.readFileSync(primarySettings, 'utf8'), '{"editor.fontSize": 14}\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('doctor checks: sanitized non-login PATH probe treats spawn error/null status as INFO, MEMORY.md warns at 9500 chars, recommendation points to install.mjs --apply-settings', () => {
  const tmp = makeTempDir('agy-doc-checks-');
  try {
    const geminiDir = path.join(tmp, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(path.join(geminiDir, 'MEMORY.md'), 'a'.repeat(9600), 'utf8');
    const settingsPath = path.join(tmp, 'settings.json');
    fs.writeFileSync(settingsPath, '{}\n', 'utf8');

    const spawnedCalls = [];
    const report = runDiagnostics({
      platform: 'linux',
      env: { PATH: '/custom/user/only' },
      homeDir: tmp,
      geminiDir,
      settingsPath,
      spawnImpl: (cmd, args, opts) => {
        spawnedCalls.push({ cmd, args, opts });
        return { status: null, error: new Error('spawn ENOENT') };
      },
      readFileImpl: () => '524288\n',
    });

    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.equal(byId['non-login-hook-path'].severity, 'INFO');
    assert.equal(spawnedCalls[0].cmd, 'env');
    assert.equal(spawnedCalls[0].args[0], '-i');
    assert.match(spawnedCalls[0].args[1], /^PATH=\/usr\/bin:/);
    assert.equal(byId['rule-byte-budget'].severity, 'WARN');
    assert.match(byId['heartbeat-interval'].recommendation, /node install\.mjs --apply-settings/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('install.mjs aborts before plugin mutation on malformed settings, surfaces !ok in dry-run, and sanitizes --json output', () => {
  const tmp = makeTempDir('agy-install-guard-');
  try {
    const pluginsSrcDir = createFixturePluginsRoot(tmp);
    const geminiDir = path.join(tmp, '.gemini');
    const targetRoot = path.join(geminiDir, 'config', 'plugins');
    const dataDir = path.join(geminiDir, 'agy-suite');
    const settingsPath = path.join(tmp, 'settings.json');
    fs.writeFileSync(settingsPath, '{\n  "a": 1\n  "broken": true\n}\n', 'utf8');

    // Dry-run surfaces ok: false clearly.
    const dryRes = runInstaller(
      [
        '--dry-run',
        '--json',
        '--modules=core',
        '--apply-settings',
        '--target-root',
        targetRoot,
        '--data-dir',
        dataDir,
        '--gemini-dir',
        geminiDir,
        '--settings-path',
        settingsPath,
      ],
      { pluginsSrcDir, silent: true },
    );
    assert.equal(dryRes.ok, false);
    assert.equal(dryRes.settingsResult.ok, false);
    assert.equal('previewText' in dryRes.settingsResult, false);
    assert.ok(dryRes.settingsResult.error);

    // Real install aborts BEFORE creating targetRoot or installing any plugin.
    assert.throws(
      () =>
        runInstaller(
          [
            '--modules=core',
            '--apply-settings',
            '--target-root',
            targetRoot,
            '--data-dir',
            dataDir,
            '--gemini-dir',
            geminiDir,
            '--settings-path',
            settingsPath,
          ],
          { pluginsSrcDir, silent: true },
        ),
      /Settings patch refused/,
    );
    assert.equal(fs.existsSync(targetRoot), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'install-manifest.json')), false);

    // Valid settings + --dry-run --json redacts remoteUrl credentials and omits previewText.
    fs.writeFileSync(settingsPath, '{\n  "editor.fontSize": 14\n}\n', 'utf8');
    const jsonDry = runInstaller(
      [
        '--dry-run',
        '--json',
        '--modules=hud,core,sync',
        '--apply-settings',
        '--git-remote',
        'https://alice:supersecret@example.invalid/private/memory.git',
        '--branch',
        'sync-main',
        '--target-root',
        targetRoot,
        '--data-dir',
        dataDir,
        '--gemini-dir',
        geminiDir,
        '--settings-path',
        settingsPath,
      ],
      { pluginsSrcDir, silent: true },
    );
    assert.equal(jsonDry.ok, true);
    assert.equal(jsonDry.syncSetup.config.remoteUrl, 'https://***@example.invalid/private/memory.git');
    assert.equal(jsonDry.syncSetup.config.branch, 'sync-main');
    assert.equal('previewText' in jsonDry.settingsResult, false);
    assert.deepEqual(Object.keys(jsonDry.settingsResult).sort(), ['appliedKeys', 'changed', 'error', 'ok']);
    assert.ok(jsonDry.settingsResult.appliedKeys.includes('antigravity.heartbeatIntervalMs'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('install.mjs validates --git-remote / --branch, rejects sync flags without sync module, encodes special chars, and skips starters only with --git-remote', () => {
  const tmp = makeTempDir('agy-sync-flags-');
  try {
    const pluginsSrcDir = createFixturePluginsRoot(tmp);
    const geminiDir = path.join(tmp, 'dir$&$1#%[]', '.gemini');
    const targetRoot = path.join(tmp, 'custom-plugins');
    const dataDir = path.join(tmp, 'custom-data');

    // Validation unit checks
    assert.throws(() => validateGitRemoteUrl('--upload-pack=evil'), /leading "-"/);
    assert.throws(() => validateGitRemoteUrl('ext::sh -c id'), /ext::/);
    assert.throws(() => validateGitRemoteUrl('https://example.invalid/a\nb.git'), /control characters/);
    assert.throws(() => validateGitBranch('-evil'), /leading "-"/);
    assert.throws(() => validateGitBranch('a..b'), /safe Git branch/);
    assert.throws(() => validateGitBranch('main.lock'), /safe Git branch/);
    assert.equal(validateGitBranch('feature/sync-2'), 'feature/sync-2');
    assert.equal(redactRemoteUrl('https://u:p@host/repo.git'), 'https://***@host/repo.git');
    assert.equal(redactRemoteUrl('git@github.com:u/r.git'), 'git@github.com:u/r.git');

    // Sync flags without sync module throw clear usage error.
    assert.throws(
      () =>
        runInstaller(
          ['--modules=hud,core', '--git-remote', 'https://example.invalid/r.git', '--gemini-dir', geminiDir],
          { pluginsSrcDir, silent: true },
        ),
      /require the "sync" module/,
    );
    assert.throws(
      () => runInstaller(['--modules=core', '--work-notes', '--gemini-dir', geminiDir], { pluginsSrcDir, silent: true }),
      /require the "sync" module/,
    );

    // Local sync install (no --git-remote) DOES create starter MEMORY.md, MEMORY_ARCHIVE.md, WORK_NOTES.md,
    // and encodes % # [ ] without interpolating $& / $1 in MEMORY-LOADER.md.
    runInstaller(
      [
        '--modules=sync',
        '--work-notes',
        '--target-root',
        targetRoot,
        '--data-dir',
        dataDir,
        '--gemini-dir',
        geminiDir,
      ],
      { pluginsSrcDir, silent: true },
    );
    assert.ok(fs.existsSync(path.join(geminiDir, 'MEMORY.md')));
    assert.ok(fs.existsSync(path.join(geminiDir, 'MEMORY_ARCHIVE.md')));
    assert.ok(fs.existsSync(path.join(geminiDir, 'WORK_NOTES.md')));
    const loader = fs.readFileSync(path.join(targetRoot, 'agy-suite-sync', 'rules', 'MEMORY-LOADER.md'), 'utf8');
    const ref = formatPosixFileRef(path.join(geminiDir, 'MEMORY.md'));
    assert.ok(ref.includes('$&$1%23%25%5B%5D'));
    assert.ok(loader.includes(`@[MEMORY.md](${ref})`));
    assert.ok(!loader.includes('{{MEMORY_MD_PATH}}'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('install.mjs --uninstall reads manifest.targetRoot, skips restore on partial uninstall, and restores EARLIEST backup after backing up current file', () => {
  const tmp = makeTempDir('agy-uninstall-restore-');
  try {
    const pluginsSrcDir = createFixturePluginsRoot(tmp);
    const geminiDir = path.join(tmp, '.gemini');
    const customTargetRoot = path.join(tmp, 'custom-plugin-root');
    const dataDir = path.join(geminiDir, 'agy-suite');
    const settingsPath = path.join(tmp, 'settings.json');

    const v0Original = '{\n  // pre-suite v0\n  "editor.fontSize": 12\n}\n';
    fs.writeFileSync(settingsPath, v0Original, 'utf8');

    // First install -> creates earliest backup (v0Original).
    runInstaller(
      [
        '--modules=hud,core',
        '--apply-settings',
        '--target-root',
        customTargetRoot,
        '--data-dir',
        dataDir,
        '--gemini-dir',
        geminiDir,
        '--settings-path',
        settingsPath,
      ],
      { pluginsSrcDir, silent: true },
    );

    // User edits settings later, then reinstalls with --apply-settings -> creates second backup (v1Edited).
    const v1Edited = '{\n  // edited after first install\n  "editor.fontSize": 18\n}\n';
    fs.writeFileSync(settingsPath, v1Edited, 'utf8');
    runInstaller(
      [
        '--modules=hud,core',
        '--apply-settings',
        '--target-root',
        customTargetRoot,
        '--data-dir',
        dataDir,
        '--gemini-dir',
        geminiDir,
        '--settings-path',
        settingsPath,
      ],
      { pluginsSrcDir, silent: true },
    );
    const v2Current = fs.readFileSync(settingsPath, 'utf8');
    assert.notEqual(v2Current, v0Original);

    // Partial uninstall (--modules=hud) WITHOUT --target-root uses manifest.targetRoot and MUST NOT restore backups.
    const partialRes = runInstaller(
      [
        '--uninstall',
        '--modules=hud',
        '--restore-backups',
        '--data-dir',
        dataDir,
        '--gemini-dir',
        geminiDir,
      ],
      { pluginsSrcDir, silent: true },
    );
    assert.equal(partialRes.targetRoot, customTargetRoot);
    assert.equal(partialRes.removed.length, 1);
    assert.equal(partialRes.restoredBackups.length, 0);
    assert.match(partialRes.restoreSkippedReason, /Partial uninstall/);
    assert.equal(fs.existsSync(path.join(customTargetRoot, 'agy-suite-hud')), false);
    assert.equal(fs.existsSync(path.join(customTargetRoot, 'agy-suite-core')), true);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), v2Current);

    // Uninstall remaining module (--modules=core) WITHOUT --target-root -> full uninstall, backs up v2Current, restores v0Original (EARLIEST).
    const finalRes = runInstaller(
      [
        '--uninstall',
        '--modules=core',
        '--restore-backups',
        '--data-dir',
        dataDir,
        '--gemini-dir',
        geminiDir,
      ],
      { pluginsSrcDir, silent: true },
    );
    assert.equal(finalRes.targetRoot, customTargetRoot);
    assert.equal(finalRes.removed.length, 1);
    assert.equal(finalRes.restoredBackups.length, 1);
    assert.ok(finalRes.restoredBackups[0].preRestoreBackupPath);
    assert.equal(fs.readFileSync(finalRes.restoredBackups[0].preRestoreBackupPath, 'utf8'), v2Current);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), v0Original);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('archive-sessions enforces loopback ANTIGRAVITY_LS_ADDRESS, fails closed on --apply without current ID, counts malformed entries & truncatedPages', async () => {
  // Valid loopback formats
  assert.equal(parseLoopbackLsAddress('127.0.0.1:43210'), 'http://127.0.0.1:43210');
  assert.equal(parseLoopbackLsAddress('http://127.0.0.1:43210/'), 'http://127.0.0.1:43210');
  assert.equal(parseLoopbackLsAddress('http://localhost:43210'), 'http://localhost:43210');
  assert.equal(parseLoopbackLsAddress('[::1]:43210'), 'http://[::1]:43210');

  // Non-loopback / credential / malformed rejections (must never send CSRF token)
  let fetchCalled = false;
  const guardFetch = async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called');
  };
  for (const badAddr of [
    'evil.example.com:43210',
    'http://127.0.0.1.evil.com:43210',
    'http://127.0.0.1@evil.com:43210',
    'http://169.254.169.254:80',
    'https://127.0.0.1:43210',
    'http://127.0.0.1:43210/hijack',
  ]) {
    const res = await runArchiveSessions(['--days', '7'], {
      env: { ANTIGRAVITY_LS_ADDRESS: badAddr, ANTIGRAVITY_CSRF_TOKEN: 'secret-csrf' },
      fetchImpl: guardFetch,
    });
    assert.equal(res.ok, false, `Expected rejection for ${badAddr}`);
    await assert.rejects(() =>
      callConversationService('ListConversations', {}, { address: badAddr, csrfToken: 'tok', fetchImpl: guardFetch }),
    );
  }
  assert.equal(fetchCalled, false);

  // Missing ANTIGRAVITY_CONVERSATION_ID fails closed on --apply unless --allow-missing-current-id is passed.
  const noCurrentApply = await runArchiveSessions(['--days', '7', '--apply'], {
    env: { ANTIGRAVITY_LS_ADDRESS: 'http://127.0.0.1:43210', ANTIGRAVITY_CSRF_TOKEN: 'tok' },
    fetchImpl: guardFetch,
  });
  assert.equal(noCurrentApply.ok, false);
  assert.match(noCurrentApply.error, /ANTIGRAVITY_CONVERSATION_ID/);
  assert.equal(fetchCalled, false);

  // Explicit --allow-missing-current-id overrides the guard and archives cleanly.
  const overrideFetch = async (url) => {
    if (url.endsWith('/ListConversations')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            conversations: [
              null,
              { id: '' },
              {
                id: 'c-old',
                annotations: { title: 'Old' },
                state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-01T00:00:00Z' },
              },
            ],
            nextPageToken: '',
          }),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'c-old' }) };
  };
  const overrideRes = await runArchiveSessions(['--days', '7', '--apply', '--allow-missing-current-id'], {
    env: { ANTIGRAVITY_LS_ADDRESS: 'http://127.0.0.1:43210', ANTIGRAVITY_CSRF_TOKEN: 'tok' },
    fetchImpl: overrideFetch,
    nowMs: Date.parse('2026-11-26T12:00:00Z'),
  });
  assert.equal(overrideRes.ok, true);
  assert.equal(overrideRes.skipped.malformed, 2);
  assert.equal(overrideRes.truncatedPages, false);
  assert.deepEqual(overrideRes.archivedIds, ['c-old']);

  // MAX_PAGES limit sets truncatedPages: true.
  let pageCalls = 0;
  const infinitePagesFetch = async () => {
    pageCalls += 1;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          conversations: [
            {
              id: `c-${pageCalls}`,
              state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-25T00:00:00Z' },
            },
          ],
          nextPageToken: `tok-${pageCalls}`,
        }),
    };
  };
  const truncRes = await runArchiveSessions(['--days', '7'], {
    env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:43210', ANTIGRAVITY_CSRF_TOKEN: 'tok' },
    fetchImpl: infinitePagesFetch,
    nowMs: Date.parse('2026-11-26T12:00:00Z'),
  });
  assert.equal(truncRes.ok, true);
  assert.equal(truncRes.truncatedPages, true);
  assert.equal(pageCalls, 50);
});
