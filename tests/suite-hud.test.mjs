import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  COOKIE_NAME,
  DEFAULT_PORT,
  PLUGIN_SLUG,
  getDataPaths,
  resolveDataDir,
  sanitizeChildEnv,
} from '../plugins/agy-suite-hud/hooks/constants.mjs';
import {
  loadSecrets,
  readDaemonState,
  saveSecrets,
  saveSettings,
} from '../plugins/agy-suite-hud/hooks/core.mjs';
import {
  handleHookPayload,
  writeHookStdout,
} from '../plugins/agy-suite-hud/hooks/hook-entry.mjs';
import { createControlRoomServer } from '../plugins/agy-suite-hud/hooks/server.mjs';
import {
  QUOTA_STALE_MAX_AGE_MS,
  fetchQuotaSnapshot,
  getModelFamily,
  isSameModelFamily,
  parseQuotaOutput,
  readContextMeter,
  resetContextMeterCache,
  resetQuotaCache,
  slimPaneStatePayload,
} from '../plugins/agy-suite-hud/sidecars/hud_pane/main.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', 'plugins', 'agy-suite-hud');
const HOOK_ENTRY_PATH = path.join(PLUGIN_ROOT, 'hooks', 'hook-entry.mjs');

const tempDirs = [];

function makeTempDir(prefix = 'agy-suite-hud-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeTranscript(brainDir, convId, events, fileName = 'transcript_full.jsonl') {
  const logsDir = path.join(brainDir, convId, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const fp = path.join(logsDir, fileName);
  const body = events.map((ev) => JSON.stringify(ev)).join('\n') + '\n';
  fs.writeFileSync(fp, body, 'utf8');
  return fp;
}

function makeUsagePayload(groups) {
  return JSON.stringify({
    command: {
      name: '/usage',
      data: { groups },
    },
  });
}

afterEach(() => {
  resetContextMeterCache();
  resetQuotaCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup race on Windows.
    }
  }
});

describe('AGY SUITE HUD — Context Meter & Compaction Telemetry', () => {
  it('classifies CHECKPOINT after /compact as manual and never alters lastAutoDrop', () => {
    const brainDir = makeTempDir();
    const convId = 'conv-manual-compact-01';
    writeTranscript(brainDir, convId, [
      {
        type: 'USER_INPUT',
        step_index: 1,
        created_at: '2026-11-26T10:00:00Z',
        content: '<USER_REQUEST>Investigate build pipeline</USER_REQUEST>',
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 2,
        created_at: '2026-11-26T10:00:10Z',
        model: 'gemini-3.8-pro',
        input_tokens: 40000,
        cache_read_tokens: 200000,
      },
      {
        type: 'USER_INPUT',
        step_index: 3,
        created_at: '2026-11-26T10:01:00Z',
        content: '<USER_REQUEST>/compact keep only build state</USER_REQUEST>',
      },
      {
        type: 'CHECKPOINT',
        step_index: 4,
        created_at: '2026-11-26T10:01:05Z',
        model: 'gemini-3.8-pro',
        input_tokens: 50000,
        cache_read_tokens: 190000,
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 5,
        created_at: '2026-11-26T10:01:12Z',
        model: 'gemini-3.8-pro',
        input_tokens: 10000,
        cache_read_tokens: 40000,
      },
    ]);

    const res = readContextMeter(convId, { brainDirs: [brainDir], bypassCache: true });
    assert.equal(res.ok, true);
    assert.equal(res.available, true);
    assert.equal(res.compactionCount, 1);
    assert.equal(res.manualCompactionCount, 1);
    assert.equal(res.autoCompactionCount, 0);
    assert.equal(res.lastAutoDrop, null);
    assert.equal(res.lastDrop?.kind, 'manual');
    assert.equal(res.lastDrop?.from, 240000);
    assert.equal(res.lastDrop?.to, 50000);
  });

  it('classifies CHECKPOINT without /compact as auto and isolates per modelFamily', () => {
    const brainDir = makeTempDir();
    const convId = 'conv-auto-family-02';
    writeTranscript(brainDir, convId, [
      {
        type: 'USER_INPUT',
        step_index: 1,
        created_at: '2026-11-26T10:00:00Z',
        content: '<USER_REQUEST>Run deep analysis</USER_REQUEST>',
      },
      {
        type: 'CHECKPOINT',
        step_index: 2,
        created_at: '2026-11-26T10:05:00Z',
        model: 'gemini-3.8-pro',
        input_tokens: 15000,
        cache_read_tokens: 500000,
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 3,
        created_at: '2026-11-26T10:05:10Z',
        model: 'gemini-3.8-pro',
        input_tokens: 12000,
        cache_read_tokens: 88000,
      },
    ]);

    const geminiRes = readContextMeter(convId, { brainDirs: [brainDir], bypassCache: true });
    assert.equal(geminiRes.modelFamily, 'gemini');
    assert.equal(geminiRes.autoCompactionCount, 1);
    assert.equal(geminiRes.manualCompactionCount, 0);
    assert.equal(geminiRes.lastAutoDrop?.kind, 'auto');
    assert.equal(geminiRes.lastAutoDrop?.from, 515000);
    assert.equal(geminiRes.lastAutoDrop?.to, 100000);
    assert.equal(geminiRes.dropsByFamily.gemini?.from, 515000);

    // Now switch the active model in the same conversation to Claude: Gemini's auto-drop must NOT leak into Claude's lastAutoDrop.
    const claudeConvId = 'conv-auto-family-switch-03';
    writeTranscript(brainDir, claudeConvId, [
      {
        type: 'USER_INPUT',
        step_index: 1,
        created_at: '2026-11-26T10:00:00Z',
        content: '<USER_REQUEST>Analyze</USER_REQUEST>',
      },
      {
        type: 'CHECKPOINT',
        step_index: 2,
        created_at: '2026-11-26T10:05:00Z',
        model: 'gemini-3.8-pro',
        input_tokens: 15000,
        cache_read_tokens: 500000,
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 3,
        created_at: '2026-11-26T10:05:10Z',
        model: 'gemini-3.8-pro',
        input_tokens: 12000,
        cache_read_tokens: 88000,
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 4,
        created_at: '2026-11-26T10:06:00Z',
        model: 'claude-sonnet-4-6',
        input_tokens: 30000,
        cache_read_tokens: 90000,
      },
    ]);

    const switchedRes = readContextMeter(claudeConvId, { brainDirs: [brainDir], bypassCache: true });
    assert.equal(switchedRes.modelFamily, 'claude');
    assert.equal(switchedRes.dropsByFamily.gemini?.from, 515000);
    assert.equal(switchedRes.lastAutoDrop, null);
  });

  it('does NOT false-trigger a compaction drop on Gemini -> Claude model switch', () => {
    assert.equal(getModelFamily('gemini-3.8-pro'), 'gemini');
    assert.equal(getModelFamily('claude-opus-4-6'), 'claude');
    assert.equal(getModelFamily('gpt-oss-120b'), 'gpt-oss');
    assert.equal(isSameModelFamily('gemini-3.8-pro', 'claude-sonnet-4-6'), false);

    const brainDir = makeTempDir();
    const convId = 'conv-model-switch-04';
    writeTranscript(brainDir, convId, [
      {
        type: 'USER_INPUT',
        step_index: 1,
        created_at: '2026-11-26T10:00:00Z',
        content: '<USER_REQUEST>Switch model mid-session</USER_REQUEST>',
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 2,
        created_at: '2026-11-26T10:01:00Z',
        model: 'gemini-3.8-pro',
        input_tokens: 50000,
        cache_read_tokens: 400000,
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 3,
        created_at: '2026-11-26T10:02:00Z',
        model: 'claude-sonnet-4-6',
        input_tokens: 20000,
        cache_read_tokens: 65000,
      },
    ]);

    const res = readContextMeter(convId, { brainDirs: [brainDir], bypassCache: true });
    assert.equal(res.compactionCount, 0);
    assert.equal(res.autoCompactionCount, 0);
    assert.equal(res.lastDrop, null);
    assert.equal(res.lastAutoDrop, null);
  });

  it('computes real KV cacheHitPct from cache_read_tokens / (input_tokens + cache_read_tokens)', () => {
    const brainDir = makeTempDir();
    const convId = 'conv-kv-cache-05';
    writeTranscript(brainDir, convId, [
      {
        type: 'PLANNER_RESPONSE',
        step_index: 1,
        created_at: '2026-11-26T10:00:00Z',
        model: 'gemini-3.8-flash',
        input_tokens: 22500,
        cache_read_tokens: 77500,
      },
    ]);

    const res = readContextMeter(convId, { brainDirs: [brainDir], bypassCache: true });
    assert.equal(res.totalTokens, 100000);
    assert.equal(res.inputTokens, 22500);
    assert.equal(res.cacheReadTokens, 77500);
    assert.equal(res.cacheHitPct, 78);
  });

  it('handles token-less CHECKPOINT, defers drop until post-checkpoint row, and classifies /compact -> CHECKPOINT -> continue as manual (>6 events)', () => {
    const brainDir = makeTempDir();
    const convId = 'conv-tokenless-cp-06';
    const initialEvents = [
      {
        type: 'USER_INPUT',
        step_index: 1,
        created_at: '2026-11-26T10:00:00Z',
        content: '<USER_REQUEST>Build system audit</USER_REQUEST>',
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 2,
        created_at: '2026-11-26T10:00:10Z',
        model: 'gemini-3.8-pro',
        input_tokens: 40000,
        cache_read_tokens: 200000,
      },
      {
        type: 'USER_INPUT',
        step_index: 3,
        created_at: '2026-11-26T10:01:00Z',
        content: '<USER_REQUEST>/compact summarize context</USER_REQUEST>',
      },
      // More than 6 non-USER_INPUT intermediate events between /compact and CHECKPOINT
      ...Array.from({ length: 8 }, (_, idx) => ({
        type: 'TOOL_RESULT',
        step_index: 4 + idx,
        created_at: `2026-11-26T10:01:0${Math.min(9, idx + 1)}Z`,
      })),
      {
        type: 'CHECKPOINT',
        step_index: 12,
        created_at: '2026-11-26T10:01:20Z',
        // Token-less checkpoint (no input_tokens / cache_read_tokens)
      },
    ];
    const fp = writeTranscript(brainDir, convId, initialEvents);

    // Before post-checkpoint token row arrives: drop must be deferred (never emit to: 0).
    const beforeNext = readContextMeter(convId, { brainDirs: [brainDir] });
    assert.equal(beforeNext.ok, true);
    assert.equal(beforeNext.available, true);
    assert.equal(beforeNext.compactionCount, 0);
    assert.equal(beforeNext.lastDrop, null);
    assert.equal(beforeNext.totalTokens, 240000);
    assert.equal(beforeNext.cacheHitPct, 83);

    // Append USER_INPUT("continue") + post-checkpoint PLANNER_RESPONSE -> incremental read picks it up cleanly.
    const appended = [
      {
        type: 'USER_INPUT',
        step_index: 13,
        created_at: '2026-11-26T10:02:00Z',
        content: '<USER_REQUEST>continue</USER_REQUEST>',
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 14,
        created_at: '2026-11-26T10:02:05Z',
        model: 'gemini-3.8-pro',
        input_tokens: 10000,
        cache_read_tokens: 40000,
      },
    ];
    fs.appendFileSync(fp, appended.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const afterNext = readContextMeter(convId, { brainDirs: [brainDir] });
    assert.equal(afterNext.compactionCount, 1);
    assert.equal(afterNext.manualCompactionCount, 1);
    assert.equal(afterNext.autoCompactionCount, 0);
    assert.equal(afterNext.lastAutoDrop, null);
    assert.equal(afterNext.lastDrop?.kind, 'manual');
    assert.equal(afterNext.lastDrop?.from, 240000);
    assert.equal(afterNext.lastDrop?.to, 50000);
    assert.equal(afterNext.totalTokens, 50000);

    // Verify incremental cache resets cleanly when file shrinks/rotates.
    writeTranscript(brainDir, convId, [
      {
        type: 'PLANNER_RESPONSE',
        step_index: 1,
        created_at: '2026-11-26T10:05:00Z',
        model: 'gemini-3.8-pro',
        input_tokens: 5000,
        cache_read_tokens: 15000,
      },
    ]);
    const rotated = readContextMeter(convId, { brainDirs: [brainDir] });
    assert.equal(rotated.totalTokens, 20000);
    assert.equal(rotated.samples, 1);
  });

  it('rebound guard rejects single auxiliary dip and confirms sustained fallback drop', () => {
    const brainDir = makeTempDir();
    const auxConvId = 'conv-rebound-aux-07';
    writeTranscript(brainDir, auxConvId, [
      {
        type: 'PLANNER_RESPONSE',
        step_index: 1,
        created_at: '2026-11-26T10:00:00Z',
        model: 'gemini-3.8-pro',
        input_tokens: 50000,
        cache_read_tokens: 350000,
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 2,
        created_at: '2026-11-26T10:00:05Z',
        model: 'gemini-3.8-flash-lite',
        input_tokens: 5000,
        cache_read_tokens: 15000,
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 3,
        created_at: '2026-11-26T10:00:10Z',
        model: 'gemini-3.8-pro',
        input_tokens: 60000,
        cache_read_tokens: 350000,
      },
    ]);

    const auxRes = readContextMeter(auxConvId, { brainDirs: [brainDir], bypassCache: true });
    assert.equal(auxRes.compactionCount, 0);
    assert.equal(auxRes.autoCompactionCount, 0);
    assert.equal(auxRes.lastAutoDrop, null);

    const realDropConvId = 'conv-rebound-confirmed-08';
    writeTranscript(brainDir, realDropConvId, [
      {
        type: 'PLANNER_RESPONSE',
        step_index: 1,
        created_at: '2026-11-26T10:00:00Z',
        model: 'gemini-3.8-pro',
        input_tokens: 50000,
        cache_read_tokens: 350000,
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 2,
        created_at: '2026-11-26T10:01:00Z',
        model: 'gemini-3.8-pro',
        input_tokens: 10000,
        cache_read_tokens: 40000,
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 3,
        created_at: '2026-11-26T10:01:10Z',
        model: 'gemini-3.8-pro',
        input_tokens: 15000,
        cache_read_tokens: 45000,
      },
    ]);

    const realRes = readContextMeter(realDropConvId, { brainDirs: [brainDir], bypassCache: true });
    assert.equal(realRes.compactionCount, 1);
    assert.equal(realRes.autoCompactionCount, 1);
    assert.equal(realRes.lastAutoDrop?.from, 400000);
    assert.equal(realRes.lastAutoDrop?.to, 50000);
  });
});

describe('AGY SUITE HUD — Fail-Closed Quota Telemetry', () => {
  it('parses valid 5h and weekly quota buckets accurately', () => {
    const raw = makeUsagePayload([
      {
        name: 'Gemini Models',
        buckets: [
          {
            id: 'gem-5h',
            window: '5h',
            remaining_fraction: 0.824,
            reset_time: '2026-11-26T15:00:00Z',
            description: 'Gemini 5h rolling quota',
          },
          {
            id: 'gem-wk',
            window: 'weekly',
            remaining_fraction: 0.64,
            reset_time: '2026-12-01T00:00:00Z',
            description: 'Gemini weekly quota',
          },
        ],
      },
      {
        name: 'Claude & GPT',
        buckets: [
          {
            id: 'cl-5h',
            window: '5h',
            remaining_fraction: 0.15,
            reset_time: '2026-11-26T14:00:00Z',
            description: 'Claude 5h quota',
          },
          {
            id: 'cl-wk',
            window: 'weekly',
            remaining_fraction: 0.5,
            reset_time: '2026-12-01T00:00:00Z',
            description: 'Claude weekly quota',
          },
        ],
      },
    ]);

    const groups = parseQuotaOutput(raw);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].key, 'gemini');
    assert.equal(groups[0].label, 'Gemini');
    assert.equal(groups[0].fiveHour?.pct, 82);
    assert.equal(groups[0].weekly?.pct, 64);
    assert.equal(groups[1].key, 'claude');
    assert.equal(groups[1].label, 'Claude·GPT');
    assert.equal(groups[1].fiveHour?.pct, 15);
    assert.equal(groups[1].weekly?.pct, 50);
  });

  it('throws on unrecognized schema and fails closed without returning stale cache', async () => {
    assert.throws(() => parseQuotaOutput(''), /Empty agy usage output/);
    assert.throws(() => parseQuotaOutput('{}'), /Unrecognized agy usage schema/);
    assert.throws(
      () => parseQuotaOutput(makeUsagePayload([{ name: 'Gemini', buckets: [] }])),
      /Unrecognized agy usage schema/,
    );

    let now = 1_700_000_000_000;
    const validRaw = makeUsagePayload([
      {
        name: 'Gemini',
        buckets: [{ id: 'g5', window: '5h', remaining_fraction: 0.9, reset_time: '' }],
      },
    ]);

    // 1. Seed valid cache.
    const first = await fetchQuotaSnapshot({
      force: true,
      agyBinOverride: 'agy',
      nowFn: () => now,
      execFileImpl: (_bin, _args, _opts, cb) => cb(null, validRaw),
    });
    assert.equal(first.ok, true);
    assert.equal(first.groups[0].fiveHour?.pct, 90);

    // 2. Advance beyond cooldown and simulate schema drift -> must fail closed and clear cache!
    now += 30_000;
    const drifted = await fetchQuotaSnapshot({
      force: true,
      agyBinOverride: 'agy',
      nowFn: () => now,
      execFileImpl: (_bin, _args, _opts, cb) => cb(null, JSON.stringify({ unexpected: true })),
    });
    assert.equal(drifted.ok, false);
    assert.equal(drifted.schemaError, true);
    assert.deepEqual(drifted.groups, []);

    // 3. Subsequent transient error must NOT resurrect cleared cache.
    now += 30_000;
    const afterClear = await fetchQuotaSnapshot({
      force: true,
      agyBinOverride: 'agy',
      nowFn: () => now,
      execFileImpl: (_bin, _args, _opts, cb) => cb(new Error('ETIMEDOUT')),
    });
    assert.equal(afterClear.ok, false);
    assert.equal(afterClear.staleExpired, true);
    assert.deepEqual(afterClear.groups, []);
  });

  it('shows stale badge on transient CLI error up to 10 min then expires fail-closed', async () => {
    let now = 1_700_000_000_000;
    const validRaw = makeUsagePayload([
      {
        name: 'Gemini',
        buckets: [{ id: 'g5', window: '5h', remaining_fraction: 0.75, reset_time: '' }],
      },
    ]);

    const okRes = await fetchQuotaSnapshot({
      force: true,
      agyBinOverride: 'agy',
      nowFn: () => now,
      execFileImpl: (_bin, _args, _opts, cb) => cb(null, validRaw),
    });
    assert.equal(okRes.ok, true);

    // Transient error at +5 min (<= 10 min) -> cached stale response.
    now += 5 * 60 * 1000;
    const staleRes = await fetchQuotaSnapshot({
      force: true,
      agyBinOverride: 'agy',
      nowFn: () => now,
      execFileImpl: (_bin, _args, _opts, cb) => cb(new Error('temporary network blip')),
    });
    assert.equal(staleRes.ok, true);
    assert.equal(staleRes.stale, true);
    assert.equal(staleRes.groups[0].fiveHour?.pct, 75);

    // Transient error past QUOTA_STALE_MAX_AGE_MS -> expires fail-closed.
    now += QUOTA_STALE_MAX_AGE_MS + 1000;
    const expiredRes = await fetchQuotaSnapshot({
      force: true,
      agyBinOverride: 'agy',
      nowFn: () => now,
      execFileImpl: (_bin, _args, _opts, cb) => cb(new Error('still failing')),
    });
    assert.equal(expiredRes.ok, false);
    assert.equal(expiredRes.staleExpired, true);
    assert.deepEqual(expiredRes.groups, []);
  });

  it('strictly rejects invalid remaining_fraction values (null, "", true, 85, <0, >1)', () => {
    for (const badVal of [null, '', true, false, 85, -0.01, 1.01, '0.5', {}]) {
      const payload = makeUsagePayload([
        {
          name: 'Gemini',
          buckets: [{ id: 'g5', window: '5h', remaining_fraction: badVal, reset_time: '' }],
        },
      ]);
      assert.throws(
        () => parseQuotaOutput(payload),
        /Invalid remaining_fraction/,
        `Expected rejection for remaining_fraction=${JSON.stringify(badVal)}`,
      );
    }
  });

  it('enforces watchdog kill, sync-throw fail-closed recovery, and strips ambient API keys from child env', async () => {
    const prevGemini = process.env.GEMINI_API_KEY;
    const prevGoogle = process.env.GOOGLE_API_KEY;
    const prevGenai = process.env.GOOGLE_GENAI_USE_VERTEXAI;
    let seenEnv = null;
    let stdinEnded = false;
    let killSignal = '';
    try {
      process.env.GEMINI_API_KEY = 'secret-gemini';
      process.env.GOOGLE_API_KEY = 'secret-google';
      process.env.GOOGLE_GENAI_USE_VERTEXAI = '1';

      // 1. Watchdog fires when callback never invokes; child is SIGKILLed and quotaInFlight unpins.
      const timedOut = await fetchQuotaSnapshot({
        force: true,
        agyBinOverride: 'agy',
        watchdogMs: 40,
        execFileImpl: (_bin, _args, opts) => {
          seenEnv = opts.env;
          return {
            stdin: { end() { stdinEnded = true; } },
            kill(sig) { killSignal = sig; },
          };
        },
      });
      assert.equal(timedOut.ok, false);
      assert.match(timedOut.error, /watchdog timeout/i);
      assert.equal(stdinEnded, true);
      assert.equal(killSignal, 'SIGKILL');
      assert.equal(seenEnv.GEMINI_API_KEY, undefined);
      assert.equal(seenEnv.GOOGLE_API_KEY, undefined);
      assert.equal(seenEnv.GOOGLE_GENAI_USE_VERTEXAI, undefined);

      // 2. Sync throw (e.g. EINVAL on Windows .cmd) routes cleanly to fail-closed error branch.
      const syncFail = await fetchQuotaSnapshot({
        force: true,
        agyBinOverride: 'agy',
        execFileImpl: () => {
          throw new Error('EINVAL spawn error');
        },
      });
      assert.equal(syncFail.ok, false);
      assert.match(syncFail.error, /EINVAL/);
    } finally {
      if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGemini;
      if (prevGoogle === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = prevGoogle;
      if (prevGenai === undefined) delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
      else process.env.GOOGLE_GENAI_USE_VERTEXAI = prevGenai;
    }
  });
});

describe('AGY SUITE HUD — Hook Contract & Offline Defaults', () => {
  it('hooks.json defines agy-suite-hud-thoughts with PostInvocation and Stop argv event names', () => {
    const hooksPath = path.join(PLUGIN_ROOT, 'hooks.json');
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const entry = parsed['agy-suite-hud-thoughts'];
    assert.ok(entry, 'agy-suite-hud-thoughts hook must exist');
    assert.equal(entry.enabled, true);
    assert.equal(entry.PostInvocation[0].command, 'node hooks/hook-entry.mjs PostInvocation');
    assert.equal(entry.PostInvocation[0].timeout, 10);
    assert.equal(entry.Stop[0].command, 'node hooks/hook-entry.mjs Stop');
    assert.equal(entry.Stop[0].timeout, 10);
  });

  it('Stop emits {"decision":"stop"} and PostInvocation emits {}, spawning 0 workers in default raw mode', async () => {
    const dataDir = makeTempDir('hud-data-');
    const brainDir = makeTempDir('hud-brain-');
    const convId = 'conv-hook-raw-01';
    const tp = writeTranscript(brainDir, convId, [
      {
        type: 'USER_INPUT',
        step_index: 1,
        created_at: '2026-11-26T10:00:00Z',
        content: '<USER_REQUEST>Hello HUD</USER_REQUEST>',
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 2,
        created_at: '2026-11-26T10:00:05Z',
        thinking: 'Checking the test fixture cleanly.',
        content: 'Done.',
        tool_calls: [],
      },
    ]);

    let spawnCount = 0;
    const spySpawn = () => {
      spawnCount += 1;
      return { on() {}, unref() {} };
    };

    const stopRes = await handleHookPayload(
      { hookEventName: 'Stop', conversationId: convId, transcriptPath: tp },
      { dataDir, brainDirs: [brainDir], spawnImpl: spySpawn },
    );
    assert.equal(stopRes.spawnedWorker, false);
    assert.equal(spawnCount, 0);

    const postRes = await handleHookPayload(
      { hookEventName: 'PostInvocation', conversationId: convId, transcriptPath: tp },
      { dataDir, brainDirs: [brainDir], spawnImpl: spySpawn },
    );
    assert.equal(postRes.spawnedWorker, false);
    assert.equal(spawnCount, 0);

    // Even in gemini mode with a saved key, when viewer is closed -> 0 workers spawned.
    saveSettings({ mode: 'gemini' }, dataDir);
    saveSecrets({ geminiApiKey: 'test-key-123456' }, dataDir);
    const closedViewerRes = await handleHookPayload(
      { hookEventName: 'Stop', conversationId: convId, transcriptPath: tp },
      { dataDir, brainDirs: [brainDir], spawnImpl: spySpawn },
    );
    assert.equal(closedViewerRes.spawnedWorker, false);
    assert.equal(spawnCount, 0);

    // Direct stdout formatting test
    let stopOut = '';
    writeHookStdout('Stop', { write: (s) => { stopOut += s; } });
    assert.deepEqual(JSON.parse(stopOut), { decision: 'stop' });

    let postOut = '';
    writeHookStdout('PostInvocation', { write: (s) => { postOut += s; } });
    assert.deepEqual(JSON.parse(postOut), {});

    // Real subprocess contract test for Stop and PostInvocation
    const env = {
      ...process.env,
      AGY_SUITE_HUD_DATA_DIR: makeTempDir('hud-cli-data-'),
      AGY_SUITE_HUD_BRAIN_DIR: brainDir,
      AGY_SUITE_HUD_BRAIN_ONLY: '1',
    };
    const subStop = spawnSync(process.execPath, [HOOK_ENTRY_PATH], {
      input: JSON.stringify({ hookEventName: 'Stop', conversationId: convId, transcriptPath: tp }),
      encoding: 'utf8',
      env,
      timeout: 10000,
    });
    assert.equal(subStop.status, 0);
    assert.deepEqual(JSON.parse(subStop.stdout.trim()), { decision: 'stop' });

    const subPost = spawnSync(process.execPath, [HOOK_ENTRY_PATH, 'PostInvocation'], {
      input: JSON.stringify({ hookEventName: 'PostInvocation', conversationId: convId, transcriptPath: tp }),
      encoding: 'utf8',
      env,
      timeout: 10000,
    });
    assert.equal(subPost.status, 0);
    assert.deepEqual(JSON.parse(subPost.stdout.trim()), {});

    // Stop argv fallback on empty and malformed stdin must ALWAYS emit {"decision":"stop"}
    const subStopEmpty = spawnSync(process.execPath, [HOOK_ENTRY_PATH, 'Stop'], {
      input: '',
      encoding: 'utf8',
      env,
      timeout: 10000,
    });
    assert.equal(subStopEmpty.status, 0);
    assert.deepEqual(JSON.parse(subStopEmpty.stdout.trim()), { decision: 'stop' });

    const subStopBadJson = spawnSync(process.execPath, [HOOK_ENTRY_PATH, 'Stop'], {
      input: '{not valid json',
      encoding: 'utf8',
      env,
      timeout: 10000,
    });
    assert.equal(subStopBadJson.status, 0);
    assert.deepEqual(JSON.parse(subStopBadJson.stdout.trim()), { decision: 'stop' });

    const subPostBadJson = spawnSync(process.execPath, [HOOK_ENTRY_PATH, 'PostInvocation'], {
      input: '{bad',
      encoding: 'utf8',
      env,
      timeout: 10000,
    });
    assert.equal(subPostBadJson.status, 0);
    assert.deepEqual(JSON.parse(subPostBadJson.stdout.trim()), {});
  });

  it('never reads ambient GEMINI_API_KEY, strips child API keys, and resolves unified install-meta.json dataDir (ignoring PLUGIN_DATA)', () => {
    const emptyDataDir = makeTempDir('hud-secret-');
    const metaDir = makeTempDir('hud-meta-');
    const metaDataDir = path.join(metaDir, 'resolved-hud-data');
    const metaPath = path.join(metaDir, 'install-meta.json');
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        geminiDir: path.join(metaDir, '.gemini'),
        dataDir: metaDataDir,
        installedAt: '2026-11-26T00:00:00Z',
      }),
      'utf8',
    );

    const prevKey = process.env.GEMINI_API_KEY;
    const prevPluginData = process.env.PLUGIN_DATA;
    const prevHudData = process.env.AGY_SUITE_HUD_DATA_DIR;
    try {
      process.env.GEMINI_API_KEY = 'ambient-should-never-be-read';
      assert.equal(loadSecrets(emptyDataDir).geminiApiKey, '');

      // Ambient PLUGIN_DATA must NEVER hijack dataDir resolution.
      delete process.env.AGY_SUITE_HUD_DATA_DIR;
      process.env.PLUGIN_DATA = path.join(metaDir, 'ambient-plugin-data-wrong');
      assert.equal(resolveDataDir(undefined, { metaPath }), path.resolve(metaDataDir));

      // Explicit AGY_SUITE_HUD_DATA_DIR overrides install-meta.json.
      process.env.AGY_SUITE_HUD_DATA_DIR = emptyDataDir;
      assert.equal(resolveDataDir(undefined, { metaPath }), path.resolve(emptyDataDir));

      // Fallback when neither env nor install-meta.json exists.
      delete process.env.AGY_SUITE_HUD_DATA_DIR;
      const missingMeta = path.join(metaDir, 'missing-meta.json');
      assert.equal(
        resolveDataDir(undefined, { metaPath: missingMeta }),
        path.join(os.homedir(), '.gemini', 'agy-suite', 'hud'),
      );
    } finally {
      if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey;
      if (prevPluginData === undefined) delete process.env.PLUGIN_DATA;
      else process.env.PLUGIN_DATA = prevPluginData;
      if (prevHudData === undefined) delete process.env.AGY_SUITE_HUD_DATA_DIR;
      else process.env.AGY_SUITE_HUD_DATA_DIR = prevHudData;
    }

    const sanitized = sanitizeChildEnv(
      {
        PATH: '/usr/bin',
        GEMINI_API_KEY: 'a',
        GOOGLE_API_KEY: 'b',
        GOOGLE_GENAI_API_VERSION: 'v1',
        ANTIGRAVITY_TOKEN: 'c',
      },
      { stripAntigravity: true },
    );
    assert.equal(sanitized.PATH, '/usr/bin');
    assert.equal(sanitized.GEMINI_API_KEY, undefined);
    assert.equal(sanitized.GOOGLE_API_KEY, undefined);
    assert.equal(sanitized.GOOGLE_GENAI_API_VERSION, undefined);
    assert.equal(sanitized.ANTIGRAVITY_TOKEN, undefined);

    assert.equal(PLUGIN_SLUG, 'agy-suite-hud');
    assert.equal(DEFAULT_PORT, 18799);
    assert.equal(resolveDataDir(emptyDataDir), path.resolve(emptyDataDir));
    assert.ok(getDataPaths(emptyDataDir).sidecarViewerHeartbeatPath.endsWith('agy-suite-hud-sidecar-viewer.json'));
  });

  it('local control-room bridge serves authenticated /api/state with 40-char SHA-1 ETag diffing and slimPaneStatePayload', async () => {
    const dataDir = makeTempDir('hud-srv-data-');
    const brainDir = makeTempDir('hud-srv-brain-');
    const convId = 'conv-bridge-etag-01';
    writeTranscript(brainDir, convId, [
      {
        type: 'USER_INPUT',
        step_index: 1,
        created_at: '2026-11-26T10:00:00Z',
        content: '<USER_REQUEST>Verify sidecar bridge</USER_REQUEST>',
      },
      {
        type: 'PLANNER_RESPONSE',
        step_index: 2,
        created_at: '2026-11-26T10:00:05Z',
        thinking: 'Checking state endpoint and ETag contract.',
        content: 'Ready.',
        tool_calls: [],
      },
    ]);

    const srv = createControlRoomServer({
      port: 0,
      dataDir,
      brainDirs: [brainDir],
      writeDaemonFile: false,
      enableFsWatch: false,
    });
    const info = await srv.start();
    try {
      const base = `http://127.0.0.1:${info.port}`;
      const unauth = await fetch(`${base}/api/state`);
      assert.equal(unauth.status, 401);

      const authHeaders = {
        'X-Thoughts-Token': info.bridgeToken,
        'X-Room-Token': info.csrfToken,
      };
      const firstRes = await fetch(`${base}/api/state?viewerActive=1&focusConvId=${convId}`, {
        headers: authHeaders,
      });
      assert.equal(firstRes.status, 200);
      const firstBody = await firstRes.json();
      assert.match(firstBody.etag, /^[0-9a-f]{40}$/, 'ETag must be a 40-char SHA-1 hex digest');
      assert.equal(firstBody.sessions.length, 1);

      const slimmed = slimPaneStatePayload(firstBody, convId);
      assert.equal(slimmed.selectedMainConvId, convId);
      assert.ok(slimmed.etag.endsWith(`|sel:${convId}`));

      const secondRes = await fetch(
        `${base}/api/state?viewerActive=1&etag=${encodeURIComponent(firstBody.etag)}`,
        { headers: authHeaders },
      );
      assert.equal(secondRes.status, 200);
      const secondBody = await secondRes.json();
      assert.equal(secondBody.unchanged, true);
      assert.equal(secondBody.etag, firstBody.etag);
    } finally {
      await srv.stop();
    }
  });

  it('rotates single-use /auth bootstrapToken, issues per-auth random session cookies, and isolates bridgeToken', async () => {
    const dataDir = makeTempDir('hud-auth-data-');
    const brainDir = makeTempDir('hud-auth-brain-');
    const srv = createControlRoomServer({
      port: 0,
      dataDir,
      brainDirs: [brainDir],
      writeDaemonFile: true,
      enableFsWatch: false,
    });
    const info = await srv.start();
    try {
      const base = `http://127.0.0.1:${info.port}`;
      const token1 = info.bootstrapToken;
      const bridgeTok = info.bridgeToken;
      assert.ok(token1 && bridgeTok && token1 !== bridgeTok);

      // 1. Redeem token1 once -> 302 with random HttpOnly session cookie.
      const auth1 = await fetch(`${base}/auth?token=${encodeURIComponent(token1)}`, {
        redirect: 'manual',
      });
      assert.equal(auth1.status, 302);
      const setCookie1 = auth1.headers.get('set-cookie') || '';
      const sid1Match = setCookie1.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
      assert.ok(sid1Match, 'Set-Cookie must include session cookie');
      const sid1 = sid1Match[1];
      assert.notEqual(sid1, token1);
      assert.notEqual(sid1, bridgeTok);

      // 2. Replaying token1 must immediately fail (403).
      const replay = await fetch(`${base}/auth?token=${encodeURIComponent(token1)}`, {
        redirect: 'manual',
      });
      assert.equal(replay.status, 403);

      // 3. Daemon PID file on disk must have rotated bootstrapToken while preserving bridgeToken.
      const persisted = readDaemonState(dataDir);
      assert.ok(persisted?.bootstrapToken);
      assert.notEqual(persisted.bootstrapToken, token1);
      assert.equal(persisted.bridgeToken, bridgeTok);
      assert.equal(srv.bootstrapToken, persisted.bootstrapToken);

      // 4. Session cookie sid1 works on /api/state, forged cookie fails.
      const stateWithSid1 = await fetch(`${base}/api/state`, {
        headers: { Cookie: `${COOKIE_NAME}=${sid1}` },
      });
      assert.equal(stateWithSid1.status, 200);

      const stateForged = await fetch(`${base}/api/state`, {
        headers: { Cookie: `${COOKIE_NAME}=forged-invalid-cookie` },
      });
      assert.equal(stateForged.status, 401);

      // 5. Redeeming rotated token2 issues a distinct per-auth session cookie sid2.
      const auth2 = await fetch(`${base}/auth?token=${encodeURIComponent(persisted.bootstrapToken)}`, {
        redirect: 'manual',
      });
      assert.equal(auth2.status, 302);
      const sid2 = (auth2.headers.get('set-cookie') || '').match(
        new RegExp(`${COOKIE_NAME}=([^;]+)`),
      )?.[1];
      assert.ok(sid2 && sid2 !== sid1);

      // 6. bridgeToken stays valid across bootstrapToken rotations (both X-Thoughts-Token and Bearer).
      const bridgeHeaderRes = await fetch(`${base}/api/state`, {
        headers: { 'X-Thoughts-Token': bridgeTok },
      });
      assert.equal(bridgeHeaderRes.status, 200);

      const bearerRes = await fetch(`${base}/api/state`, {
        headers: { Authorization: `Bearer ${bridgeTok}` },
      });
      assert.equal(bearerRes.status, 200);
    } finally {
      await srv.stop();
    }
  });

  it('falls back to ephemeral port 0 when requested port is occupied by foreign process or mismatched data-dir daemon', async () => {
    const brainDir = makeTempDir('hud-port-brain-');

    // 1. Foreign HTTP server occupies a port
    const foreign = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('foreign');
    });
    await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve));
    const foreignPort = foreign.address().port;

    const dataDirA = makeTempDir('hud-port-a-');
    const dataDirB = makeTempDir('hud-port-b-');
    const srvA = createControlRoomServer({
      port: foreignPort,
      dataDir: dataDirA,
      brainDirs: [brainDir],
      writeDaemonFile: false,
      enableFsWatch: false,
    });
    let srvB = null;
    try {
      const infoA = await srvA.start();
      assert.ok(infoA.port > 0 && infoA.port !== foreignPort, 'must fall back from foreign occupied port');

      // 2. Mismatched data-dir HUD daemon occupies infoA.port -> srvB must fall back to port 0
      srvB = createControlRoomServer({
        port: infoA.port,
        dataDir: dataDirB,
        brainDirs: [brainDir],
        writeDaemonFile: false,
        enableFsWatch: false,
      });
      const infoB = await srvB.start();
      assert.ok(infoB.port > 0 && infoB.port !== infoA.port, 'must fall back from mismatched data-dir daemon');
    } finally {
      if (srvB) await srvB.stop();
      await srvA.stop();
      await new Promise((resolve) => foreign.close(resolve));
    }
  });
});

describe('AGY SUITE HUD — Packaging & Zero Personal Leaks Audit', () => {
  it('validates plugin.json, sidecar.json, SKILL.md, logo.svg, and optional auto-open template', () => {
    const pluginJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'plugin.json'), 'utf8'));
    assert.equal(pluginJson.name, 'agy-suite-hud');
    assert.equal(pluginJson.displayName, 'AGY SUITE — HUD');
    assert.equal(pluginJson.version, '1.0.0');
    assert.equal(pluginJson.logo, 'assets/logo.svg');
    assert.equal(pluginJson.repository, 'https://github.com/BBsouS/agy-suite');
    assert.equal(pluginJson.suggestedPrompts.length, 3);

    const sidecarJson = JSON.parse(
      fs.readFileSync(path.join(PLUGIN_ROOT, 'sidecars', 'hud_pane', 'sidecar.json'), 'utf8'),
    );
    assert.equal(sidecarJson.display_name, 'AGY SUITE HUD');
    assert.equal(sidecarJson.ui_config.views[0].entrypoint, 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');
    assert.equal(sidecarJson.ui_config.views[0].title, 'HUD');

    assert.equal(
      fs.existsSync(path.join(PLUGIN_ROOT, 'rules')),
      false,
      'rules/ must NOT be bundled by default',
    );
    const templateMd = fs.readFileSync(path.join(PLUGIN_ROOT, 'templates', 'auto-open-hud.md'), 'utf8');
    assert.match(templateMd, /sidecar:\/\/agy-suite-hud\/hud_pane\//);

    const skillMd = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'hud', 'SKILL.md'), 'utf8');
    assert.match(skillMd, /sidecar:\/\/agy-suite-hud\/hud_pane\//);
    assert.match(skillMd, /open-room\.mjs/);

    const logoSvg = fs.readFileSync(path.join(PLUGIN_ROOT, 'assets', 'logo.svg'), 'utf8');
    assert.match(logoSvg, /viewBox="0 0 128 128"/);
  });

  it('contains zero hardcoded user paths or legacy brand leaks anywhere under plugins/agy-suite-hud/', () => {
    const forbiddenPatterns = [
      /[a-z]:[\\/]+users[\\/]+/i,
      /\/Users\/[a-z0-9._-]+\//i,
      /agy-orbit/i,
    ];

    const files = [];
    function walk(dir) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.isFile()) files.push(full);
      }
    }
    walk(PLUGIN_ROOT);
    assert.ok(files.length >= 12, `Expected at least 12 plugin files, found ${files.length}`);

    const violations = [];
    for (const fp of files) {
      const text = fs.readFileSync(fp, 'utf8');
      for (const rx of forbiddenPatterns) {
        if (rx.test(text)) {
          violations.push(`${path.relative(PLUGIN_ROOT, fp)} matched ${rx}`);
        }
      }
    }
    assert.deepEqual(violations, [], `Personal/brand leaks found: ${violations.join('; ')}`);
  });
});
