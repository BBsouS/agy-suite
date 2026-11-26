import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY_MS = 86_400_000;
const ALLOWED_METHODS = new Set(['ListConversations', 'UpdateConversation']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const MAX_PAGES = 50;

export function parseLoopbackLsAddress(rawAddress) {
  const trimmed = String(rawAddress || '').trim();
  if (!trimmed) {
    throw new Error('ANTIGRAVITY_LS_ADDRESS is empty');
  }
  if (/[\x00-\x1f\x7f\s]/.test(trimmed)) {
    throw new Error('Invalid ANTIGRAVITY_LS_ADDRESS: contains whitespace or control characters');
  }

  let withScheme;
  if (/^https?:\/\//i.test(trimmed)) {
    withScheme = trimmed;
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    throw new Error(`Refusing non-HTTP scheme in ANTIGRAVITY_LS_ADDRESS: "${trimmed}"`);
  } else {
    withScheme = `http://${trimmed}`;
  }

  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Malformed ANTIGRAVITY_LS_ADDRESS: "${trimmed}"`);
  }

  if (parsed.protocol !== 'http:') {
    throw new Error(`Refusing non-http ANTIGRAVITY_LS_ADDRESS protocol "${parsed.protocol}"`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Refusing ANTIGRAVITY_LS_ADDRESS with embedded credentials');
  }
  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Refusing non-loopback ANTIGRAVITY_LS_ADDRESS host "${parsed.hostname}" (only 127.0.0.1, ::1, or localhost is permitted to protect ANTIGRAVITY_CSRF_TOKEN).`,
    );
  }
  if (parsed.pathname && parsed.pathname !== '/') {
    throw new Error(`Refusing ANTIGRAVITY_LS_ADDRESS with unexpected path "${parsed.pathname}"`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Refusing ANTIGRAVITY_LS_ADDRESS with query or hash');
  }
  return parsed.origin;
}

export function parseArchiveArgs(argv) {
  const opts = {
    days: 7,
    apply: false,
    allowMissingCurrentId: false,
    max: 50,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      opts.apply = true;
    } else if (arg === '--allow-missing-current-id') {
      opts.allowMissingCurrentId = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--days' && argv[i + 1]) {
      opts.days = Number(argv[++i]);
    } else if (arg.startsWith('--days=')) {
      opts.days = Number(arg.slice('--days='.length));
    } else if (arg === '--max' && argv[i + 1]) {
      opts.max = Number(argv[++i]);
    } else if (arg.startsWith('--max=')) {
      opts.max = Number(arg.slice('--max='.length));
    }
  }

  if (!Number.isFinite(opts.days) || opts.days < 0) {
    throw new Error(`Invalid --days value: ${opts.days}`);
  }
  if (!Number.isInteger(opts.max) || opts.max < 1) {
    throw new Error(`Invalid --max value: ${opts.max}`);
  }
  return opts;
}

/**
 * Pure filter selecting idle conversations older than `days`, while always
 * protecting current, pinned, starred, already-archived, and non-idle sessions.
 */
export function selectArchivableConversations(
  conversations,
  { nowMs = Date.now(), days = 7, max = 50, currentConversationId = '' } = {},
) {
  const thresholdMs = days * DAY_MS;
  const eligible = [];
  const skipped = {
    current: 0,
    pinned: 0,
    starred: 0,
    alreadyArchived: 0,
    notIdle: 0,
    tooRecent: 0,
    invalidTime: 0,
    malformed: 0,
  };

  for (const conv of Array.isArray(conversations) ? conversations : []) {
    if (!conv || typeof conv !== 'object' || typeof conv.id !== 'string' || !conv.id) {
      skipped.malformed += 1;
      continue;
    }

    if (currentConversationId && conv.id === currentConversationId) {
      skipped.current += 1;
      continue;
    }
    if (conv.annotations?.archived === true) {
      skipped.alreadyArchived += 1;
      continue;
    }
    if (conv.annotations?.pinned === true) {
      skipped.pinned += 1;
      continue;
    }
    if (conv.annotations?.starred === true) {
      skipped.starred += 1;
      continue;
    }
    if (conv.state?.runState !== 'RUN_STATE_IDLE') {
      skipped.notIdle += 1;
      continue;
    }

    const rawTime = conv.state?.updateTime || conv.metadata?.createTime || '';
    const tsMs = Date.parse(rawTime);
    if (!Number.isFinite(tsMs)) {
      skipped.invalidTime += 1;
      continue;
    }

    const ageMs = nowMs - tsMs;
    if (ageMs < thresholdMs) {
      skipped.tooRecent += 1;
      continue;
    }

    eligible.push({
      id: conv.id,
      title: conv.annotations?.title || conv.state?.summary || '(untitled)',
      updateTime: rawTime,
      ageDays: Number((ageMs / DAY_MS).toFixed(1)),
      tsMs,
    });
  }

  // Archive oldest first for deterministic cap enforcement.
  eligible.sort((a, b) => a.tsMs - b.tsMs);
  const candidates = eligible.slice(0, max).map(({ tsMs, ...rest }) => rest);
  const truncatedByMax = Math.max(0, eligible.length - candidates.length);

  return {
    totalScanned: Array.isArray(conversations) ? conversations.length : 0,
    totalEligible: eligible.length,
    truncatedByMax,
    candidates,
    skipped,
  };
}

export async function callConversationService(
  method,
  body,
  { address, csrfToken, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {},
) {
  // Explicitly disallow DeleteConversation or any non-whitelisted RPC.
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`Disallowed ConversationService method: "${method}"`);
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable (Node.js >= 18 is required)');
  }

  const origin = parseLoopbackLsAddress(address);
  const url = `${origin}/product.v1.ConversationService/${method}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-antigravity-csrf-token': csrfToken,
      },
      body: JSON.stringify(body),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (err) {
    const msg = String(err?.message || err);
    throw new Error(
      `ConversationService/${method} request failed (${msg}). ` +
        'If running inside a restricted terminal sandbox blocking loopback HTTP, rerun this command outside the sandbox.',
    );
  }

  const text = await response.text();
  if (!response.ok) {
    const sandboxHint =
      response.status === 403 || /not allowed for HTTP/i.test(text)
        ? ' Terminal sandbox may be blocking local loopback HTTP; rerun outside the sandbox.'
        : '';
    throw new Error(`ConversationService/${method} returned HTTP ${response.status}: ${text.slice(0, 240)}${sandboxHint}`);
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`ConversationService/${method} returned invalid JSON: ${String(err?.message || err)}`);
  }
}

export async function runArchiveSessions(
  argv = process.argv.slice(2),
  { env = process.env, fetchImpl = globalThis.fetch, nowMs = Date.now() } = {},
) {
  const opts = parseArchiveArgs(argv);
  const address = String(env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrfToken = String(env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  const currentConversationId = String(env.ANTIGRAVITY_CONVERSATION_ID || '').trim();

  if (!address || !csrfToken) {
    const missing = [!address ? 'ANTIGRAVITY_LS_ADDRESS' : '', !csrfToken ? 'ANTIGRAVITY_CSRF_TOKEN' : '']
      .filter(Boolean)
      .join(', ');
    return {
      ok: false,
      dryRun: !opts.apply,
      error:
        `Missing required Antigravity environment variable(s): ${missing}. ` +
        'Run this script from inside an Antigravity agent session (not a standalone terminal).',
    };
  }

  try {
    parseLoopbackLsAddress(address);
  } catch (err) {
    return {
      ok: false,
      dryRun: !opts.apply,
      error: String(err?.message || err),
    };
  }

  if (opts.apply && !currentConversationId && !opts.allowMissingCurrentId) {
    return {
      ok: false,
      dryRun: false,
      error:
        'Refusing --apply without ANTIGRAVITY_CONVERSATION_ID set (current conversation cannot be guaranteed protected). ' +
        'Run inside an active Antigravity session or pass --allow-missing-current-id explicitly.',
    };
  }

  const allConversations = [];
  let pageToken = '';
  let truncatedPages = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const reqBody = { pageSize: 100, includeArchived: false };
    if (pageToken) reqBody.pageToken = pageToken;
    let res;
    try {
      res = await callConversationService('ListConversations', reqBody, {
        address,
        csrfToken,
        fetchImpl,
      });
    } catch (err) {
      return {
        ok: false,
        dryRun: !opts.apply,
        error: String(err?.message || err),
      };
    }

    const batch = Array.isArray(res?.conversations) ? res.conversations : [];
    allConversations.push(...batch);
    pageToken = typeof res?.nextPageToken === 'string' ? res.nextPageToken : '';
    if (!pageToken || batch.length === 0) break;
    if (page === MAX_PAGES - 1 && pageToken) {
      truncatedPages = true;
    }
  }

  const selection = selectArchivableConversations(allConversations, {
    nowMs,
    days: opts.days,
    max: opts.max,
    currentConversationId,
  });

  if (!opts.apply) {
    return {
      ok: true,
      dryRun: true,
      days: opts.days,
      max: opts.max,
      truncatedPages,
      ...selection,
      archivedCount: 0,
      archivedIds: [],
      errors: [],
    };
  }

  const archivedIds = [];
  const errors = [];
  for (const item of selection.candidates) {
    try {
      await callConversationService(
        'UpdateConversation',
        {
          conversationId: item.id,
          annotations: { archived: true },
        },
        { address, csrfToken, fetchImpl },
      );
      archivedIds.push(item.id);
    } catch (err) {
      errors.push({ id: item.id, error: String(err?.message || err) });
    }
  }

  return {
    ok: errors.length === 0,
    dryRun: false,
    days: opts.days,
    max: opts.max,
    truncatedPages,
    ...selection,
    archivedCount: archivedIds.length,
    archivedIds,
    errors,
  };
}

function formatArchiveOutput(result) {
  if (!result.ok && result.candidates === undefined) {
    return `[ERROR] ${result.error}`;
  }
  const lines = [
    result.dryRun
      ? `AGY SUITE Session Archiver [DRY-RUN] (days >= ${result.days}, max ${result.max})`
      : `AGY SUITE Session Archiver [APPLIED] (days >= ${result.days}, max ${result.max})`,
    `Scanned: ${result.totalScanned} | Eligible: ${result.totalEligible} | Selected: ${result.candidates.length}` +
      (result.truncatedByMax > 0 ? ` (capped by --max; ${result.truncatedByMax} more eligible)` : '') +
      (result.truncatedPages ? ' (truncated at MAX_PAGES; more pages exist)' : ''),
    `Protected/Skipped: current=${result.skipped.current}, pinned=${result.skipped.pinned}, starred=${result.skipped.starred}, notIdle=${result.skipped.notIdle}, tooRecent=${result.skipped.tooRecent}` +
      (result.skipped.malformed > 0 ? `, malformed=${result.skipped.malformed}` : ''),
  ];
  if (result.candidates.length > 0) {
    lines.push('');
    for (const c of result.candidates) {
      lines.push(`  - [${c.ageDays}d] ${c.id} — ${c.title}`);
    }
  }
  if (result.dryRun) {
    lines.push('');
    lines.push('No conversations were modified. Re-run with --apply to set archived: true (never deletes transcripts).');
  } else {
    lines.push('');
    lines.push(`Archived: ${result.archivedCount}/${result.candidates.length}`);
    for (const e of result.errors || []) {
      lines.push(`  [FAILED] ${e.id}: ${e.error}`);
    }
  }
  return lines.join('\n');
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
  (async () => {
    try {
      const opts = parseArchiveArgs(process.argv.slice(2));
      const result = await runArchiveSessions(process.argv.slice(2));
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else if (!result.ok && result.candidates === undefined) {
        process.stderr.write(`${formatArchiveOutput(result)}\n`);
      } else {
        process.stdout.write(`${formatArchiveOutput(result)}\n`);
      }
      if (!result.ok) {
        process.exitCode = 1;
      }
    } catch (err) {
      process.stderr.write(`Archive failed: ${String(err?.message || err)}\n`);
      process.exitCode = 1;
    }
  })();
}
