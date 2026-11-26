import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const EXPECTED_PLUGINS = ['agy-suite-hud', 'agy-suite-core', 'agy-suite-sync'];

const ALLOWED_PLUGIN_MANIFEST_FIELDS = new Set([
  'name',
  'displayName',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'logo',
  'suggestedPrompts',
  'disabled',
  'license',
]);

const BASE_LEAKAGE_PATTERNS = [
  { label: 'hardcoded-windows-user-path', regex: /[A-Za-z]:[\\/]+Users[\\/]+(?!<|your|user\b)[A-Za-z0-9._-]+[\\/]/i },
  { label: 'hardcoded-macos-user-path', regex: /\/Users\/(?!<|your|user\b)[A-Za-z0-9._-]+\// },
  { label: 'private-key-header', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { label: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'github-pat', regex: /\b(?:ghp_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{22,})\b/ },
];

function loadAuditPatterns() {
  const patterns = [...BASE_LEAKAGE_PATTERNS];
  const localFile = path.join(REPO_ROOT, '.local-audit-patterns.json');
  if (fs.existsSync(localFile)) {
    const entries = JSON.parse(fs.readFileSync(localFile, 'utf8'));
    for (const item of entries) {
      if (item && item.pattern) {
        patterns.push({
          label: String(item.label || item.pattern),
          regex: new RegExp(item.pattern, String(item.flags || '')),
        });
      }
    }
  }
  return patterns;
}

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.mjs',
  '.js',
  '.cjs',
  '.json',
  '.html',
  '.css',
  '.svg',
  '.txt',
  '.yml',
  '.yaml',
  '.sh',
  '.ps1',
]);

const SKIP_DIRS = new Set(['.git', 'node_modules']);

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function toPosixRel(filePath) {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

function stripJsComments(source) {
  let out = '';
  let i = 0;
  let state = 'code'; // code | single | double | template | line | block
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      out += ch;
      i += 1;
    } else if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        out += '\n';
      }
      i += 1;
    } else if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i += 2;
      } else {
        if (ch === '\n') out += '\n';
        i += 1;
      }
    } else if (state === 'single' || state === 'double' || state === 'template') {
      const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
      if (ch === '\\') {
        out += ch + (next ?? '');
        i += 2;
        continue;
      }
      if (ch === quote) state = 'code';
      out += ch;
      i += 1;
    }
  }
  return out;
}

function extractImportSpecifiers(source) {
  const cleaned = stripJsComments(source);
  const specifiers = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const regex of patterns) {
    let match;
    while ((match = regex.exec(cleaned)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function parseFrontmatterName(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const nameLine = match[1].match(/^name:\s*['"]?([^\r\n'"]+?)['"]?\s*$/m);
  return nameLine ? nameLine[1].trim() : null;
}

function collectHookEventNames(hooksJson) {
  const events = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node.hooks && typeof node.hooks === 'object' && !Array.isArray(node.hooks)) {
      for (const key of Object.keys(node.hooks)) {
        events.add(key);
        visit(node.hooks[key]);
      }
    }
    for (const [key, val] of Object.entries(node)) {
      if (key === 'SessionEnd') events.add(key);
      if (key === 'event' && typeof val === 'string') events.add(val);
      if (val && typeof val === 'object') visit(val);
    }
  };
  visit(hooksJson);
  return events;
}

test('package.json enforces zero external dependencies and Node >= 18', () => {
  const pkgPath = path.join(REPO_ROOT, 'package.json');
  assert.ok(fs.existsSync(pkgPath), 'package.json must exist');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  assert.deepEqual(pkg.dependencies ?? {}, {}, 'dependencies must be empty');
  assert.deepEqual(pkg.devDependencies ?? {}, {}, 'devDependencies must be empty');

  const nodeRange = String(pkg.engines?.node ?? '').trim();
  const match = nodeRange.match(/^>=\s*(\d+)(?:\.\d+\.\d+)?$/);
  assert.ok(match, `engines.node must specify a >= major version, got "${nodeRange}"`);
  assert.ok(Number(match[1]) >= 18, `engines.node must be >= 18, got "${nodeRange}"`);
});

test('repository contains zero personal leakage patterns across all source and doc files', () => {
  const selfRel = toPosixRel(__filename);
  const allFiles = walkFiles(REPO_ROOT);
  const auditPatterns = loadAuditPatterns();
  const violations = [];

  for (const file of allFiles) {
    const rel = toPosixRel(file);
    if (rel === selfRel || rel === '.local-audit-patterns.json') continue;
    const ext = path.extname(file).toLowerCase();
    const base = path.basename(file);
    if (!TEXT_EXTENSIONS.has(ext) && base !== 'LICENSE' && base !== '.gitignore') continue;

    const content = fs.readFileSync(file, 'utf8');
    for (const { label, regex } of auditPatterns) {
      if (rel === 'tests/suite-sync.test.mjs' && (label === 'google-api-key' || label === 'private-key-header')) {
        continue; // synthetic test fixtures for secret-leak guard verification
      }
      if (regex.test(content)) {
        violations.push(`${rel} matched forbidden pattern "${label}"`);
      }
    }
  }

  assert.deepEqual(violations, [], `Personal leakage detected:\n${violations.join('\n')}`);
});

test('all 3 sibling plugins have valid plugin.json, root hooks.json, and matching SKILL.md frontmatter', () => {
  const pluginsDir = path.join(REPO_ROOT, 'plugins');
  assert.ok(fs.existsSync(pluginsDir), 'plugins/ directory must exist');

  const kebabCase = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  for (const pluginName of EXPECTED_PLUGINS) {
    const pluginDir = path.join(pluginsDir, pluginName);
    assert.ok(fs.existsSync(pluginDir), `Missing plugin directory: plugins/${pluginName}`);

    // 1. plugin.json validation
    const manifestPath = path.join(pluginDir, 'plugin.json');
    assert.ok(fs.existsSync(manifestPath), `Missing plugin.json in plugins/${pluginName}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    assert.equal(
      manifest.name,
      pluginName,
      `plugins/${pluginName}/plugin.json name must match directory name`,
    );
    assert.match(manifest.name, kebabCase, `plugin.json name must be kebab-case: ${manifest.name}`);

    const unknownFields = Object.keys(manifest).filter(
      (key) => !ALLOWED_PLUGIN_MANIFEST_FIELDS.has(key),
    );
    assert.deepEqual(
      unknownFields,
      [],
      `plugins/${pluginName}/plugin.json contains disallowed fields: ${unknownFields.join(', ')}`,
    );

    // 2. Root hooks.json validation (no nested hooks/hooks.json, no invalid SessionEnd)
    const nestedHooksPath = path.join(pluginDir, 'hooks', 'hooks.json');
    assert.equal(
      fs.existsSync(nestedHooksPath),
      false,
      `plugins/${pluginName}/hooks/hooks.json must not exist; hooks.json belongs at plugin root`,
    );

    const rootHooksPath = path.join(pluginDir, 'hooks.json');
    if (fs.existsSync(rootHooksPath)) {
      const hooksJson = JSON.parse(fs.readFileSync(rootHooksPath, 'utf8'));
      const events = collectHookEventNames(hooksJson);
      assert.equal(
        events.has('SessionEnd'),
        false,
        `plugins/${pluginName}/hooks.json must not reference invalid event "SessionEnd"`,
      );
    }

    // 3. skills/<name>/SKILL.md frontmatter name matching
    const skillsDir = path.join(pluginDir, 'skills');
    if (fs.existsSync(skillsDir)) {
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
        assert.ok(
          fs.existsSync(skillMdPath),
          `Missing SKILL.md in plugins/${pluginName}/skills/${entry.name}/`,
        );
        const skillMd = fs.readFileSync(skillMdPath, 'utf8');
        const fmName = parseFrontmatterName(skillMd);
        assert.equal(
          fmName,
          entry.name,
          `plugins/${pluginName}/skills/${entry.name}/SKILL.md frontmatter name ("${fmName}") must match folder name`,
        );
      }
    }
  }
});

test('all .mjs files use node:* or relative imports only (sidecar_sdk exclusively in sidecars/*/main.mjs)', () => {
  const mjsFiles = walkFiles(REPO_ROOT).filter((file) => file.endsWith('.mjs'));
  assert.ok(mjsFiles.length > 0, 'Expected at least one .mjs file in repository');

  const violations = [];
  const sidecarMainPattern = /^plugins\/[^/]+\/sidecars\/[^/]+\/main\.mjs$/;

  for (const file of mjsFiles) {
    const rel = toPosixRel(file);
    const isSidecarMain = sidecarMainPattern.test(rel);
    const source = fs.readFileSync(file, 'utf8');
    const specifiers = extractImportSpecifiers(source);

    for (const spec of specifiers) {
      if (spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../')) {
        continue;
      }
      if (isSidecarMain && (spec === 'sidecar_sdk' || spec.startsWith('sidecar_sdk/'))) {
        continue;
      }
      violations.push(`${rel} imports disallowed specifier "${spec}"`);
    }
  }

  assert.deepEqual(violations, [], `Disallowed module imports found:\n${violations.join('\n')}`);
});
