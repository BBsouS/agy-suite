import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
export const INSTALL_META_PATH = path.join(PLUGIN_ROOT_DIR, 'install-meta.json');

export const PLUGIN_SLUG = 'agy-suite-hud';
export const DISPLAY_NAME = 'AGY SUITE HUD';
export const DEFAULT_PORT = 18799;
export const COOKIE_NAME = 'agy_suite_hud_session';
export const STORAGE_PREFIX = 'agy_suite_hud_';
export const FILE_PREFIX = 'agy-suite-hud';
export const CONTROL_ROOM_APP_ID = 'agy-suite-hud';

export const DEFAULT_MODELS = Object.freeze(['gemini-2.5-flash', 'gemini-flash-lite-latest']);
export const MAX_MODELS = 5;
export const MODEL_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/;
export const CONV_ID_REGEX = /^[a-zA-Z0-9_-]{4,80}$/;
export const TARGET_LANG_REGEX = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,4})?$/;

export const ALLOWED_MODES = Object.freeze(['raw', 'gemini', 'translate']);
export const ALLOWED_PRESET_IDS = Object.freeze(['engineer-default', 'concise-bullet', 'custom']);

export const TARGET_LANG_LABELS = Object.freeze({
  ko: { ko: '한국어', en: 'Korean' },
  en: { ko: '영어', en: 'English' },
  ja: { ko: '일본어', en: 'Japanese' },
  'zh-CN': { ko: '중국어(간체)', en: 'Chinese (Simplified)' },
  es: { ko: '스페인어', en: 'Spanish' },
  fr: { ko: '프랑스어', en: 'French' },
  de: { ko: '독일어', en: 'German' },
});

export function detectSystemTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz.trim() ? tz.trim() : 'UTC';
  } catch {
    return 'UTC';
  }
}

export function detectSystemLang() {
  try {
    const loc = String(
      Intl.DateTimeFormat().resolvedOptions().locale ||
        process.env.LC_ALL ||
        process.env.LANG ||
        '',
    )
      .trim()
      .toLowerCase();
    return loc.startsWith('ko') ? 'ko' : 'en';
  } catch {
    return 'en';
  }
}

export const DEFAULT_TIMEZONE = detectSystemTimezone();
export const DEFAULT_TARGET_LANG = detectSystemLang();

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  mode: 'raw',
  targetLang: DEFAULT_TARGET_LANG,
  models: [...DEFAULT_MODELS],
  presetId: 'engineer-default',
  customPrompt: '',
  timezone: DEFAULT_TIMEZONE,
  settingsRevision: 1,
});

export const PROMPT_PRESETS = Object.freeze({
  'engineer-default': {
    id: 'engineer-default',
    labelKo: '담백한 1인칭 엔지니어 독백 (기본)',
    labelEn: 'Concise First-Person Engineer Monologue (Default)',
  },
  'concise-bullet': {
    id: 'concise-bullet',
    labelKo: '핵심 요약 불릿',
    labelEn: 'Key-Point Bullets',
  },
  custom: {
    id: 'custom',
    labelKo: '커스텀 프롬프트',
    labelEn: 'Custom Prompt',
  },
});

export function buildSystemPrompt(
  presetId,
  targetLang = DEFAULT_TARGET_LANG,
  customPrompt = '',
) {
  const safeLang = TARGET_LANG_REGEX.test(String(targetLang || ''))
    ? String(targetLang)
    : DEFAULT_TARGET_LANG;
  const langMeta = TARGET_LANG_LABELS[safeLang];
  const langNameEn = langMeta ? langMeta.en : safeLang;

  if (presetId === 'custom' && typeof customPrompt === 'string' && customPrompt.trim()) {
    return customPrompt.trim();
  }

  if (presetId === 'concise-bullet') {
    if (safeLang === 'ko') {
      return `당신은 AI 에이전트의 3인칭 영문 추론 요약을 깔끔한 **한국어 1인칭 핵심 불릿**으로 정리하는 변환기입니다.

원칙:
1. 원문에 있는 사실·판단·계획만 정확히 옮기고, 원문에 없는 문장·추측·꼬리 문단·인사말은 단 한 줄도 추가하지 마십시오.
2. 원문 문단 수를 초과해 새 문단이나 마무리 멘트를 창작하지 마십시오.
3. 백틱(\`...\`) 안의 코드·경로·파일명·식별자는 번역하지 말고 원형 그대로 유지하십시오.
4. 서론이나 코드펜스 감싸기 없이 한국어 마크다운 불릿 목록만 즉시 출력하십시오.`;
    }
    return `You convert third-person agent reasoning summaries into concise first-person bullet points in ${langNameEn}.

Rules:
1. Preserve every technical fact, judgment, and plan from the source. Never invent extra sentences, commentary, greetings, or trailing paragraphs.
2. Do not exceed the source paragraph count or add concluding remarks.
3. Keep code, paths, filenames, and identifiers inside backticks (\`...\`) verbatim.
4. Output only the markdown bullet list in ${langNameEn} with no preamble or outer code fence.`;
  }

  if (safeLang === 'ko') {
    return `당신은 AI 에이전트의 3인칭 수동태 영문 추론 요약을 차분하고 담백한 **한국어 1인칭 엔지니어 독백**으로 복원하는 전용 변환기입니다.

복원 원칙:
1. 문체만 1인칭 독백으로 복원 (창작·사족 절대 금지):
   - 원문에 적힌 사실·판단·계획만 빠짐없이 옮기되, 원문에 없는 문장·감정·농담·다짐·꼬리 문단은 단 한 줄도 창작해 덧붙이지 마십시오.
   - 원문의 "the agent", "the assistant" 또는 주어 없는 관찰문("Checking...", "Need to...")은 내가 직접 생각하고 판단하는 담백한 1인칭 반말 독백체(\`~다\`, \`~겠다\`, \`~네\`, \`~해야겠다\`)로 옮깁니다.
   - 원문의 "the user"는 \`사용자\`로 옮기며, 원문에 없는 호칭을 억지로 추가하지 마십시오.
2. 문단 수 보존 및 말 걸기 금지:
   - 참고 맥락은 대명사 지시 대상 파악에만 사용하십시오. 사용자에게 말을 걸거나 평가를 구하는 문장을 지어내거나, 원문 문단 수를 초과해 꼬리 문단을 추가하는 행위를 엄격히 금지합니다.
3. 소제목 및 식별자 보존:
   - 문단 묶음 위에 짧은 굵은 소제목(\`**소제목**\`)을 1~3개(단문이면 1개) 붙이고 줄바꿈 후 본문을 작성하십시오. 단, 짧은 소제목 한 줄만 \`**소제목**\`으로 감싸고 본문 문단 전체를 \`**...**\`로 감싸지 마십시오.
   - 백틱(\`...\`) 안의 코드·경로·파일명·식별자·원문 인용구는 번역하지 말고 그대로 유지하십시오.
4. 출력 형식:
   - 서론, 인사말, 해설, 전체 코드펜스 감싸기 없이 복원된 한국어 마크다운 본문만 즉시 출력하십시오.`;
  }

  return `You rewrite third-person passive agent reasoning summaries into a clear, matter-of-fact **first-person engineer monologue** in ${langNameEn}.

Rules:
1. Rewrite voice only (strictly no fabrication):
   - Preserve every fact, decision, and next step from the source text. Do not invent new facts, jokes, disclaimers, or trailing paragraphs.
   - Convert third-person phrases ("the agent", "the assistant", "Checking...", "Need to...") into concise first-person thinking ("I", "Let me check...", "I need to...").
2. Preserve paragraph structure:
   - Use any optional context snippet only to resolve pronouns. Never address the user directly and never exceed the source paragraph count by appending concluding paragraphs.
3. Subheadings and identifiers:
   - Add 1 to 3 short bold subheadings (\`**Subheading**\`) followed by a newline and the monologue body. Only wrap short single-line subheadings in \`**...**\` — never wrap entire body paragraphs in bold.
   - Keep code, file paths, identifiers, and backtick spans (\`...\`) verbatim.
4. Output format:
   - Output only the restored markdown body in ${langNameEn} with no preamble, explanation, or outer markdown fence.`;
}

export function readInstallMeta(metaPath = INSTALL_META_PATH) {
  try {
    if (!metaPath || !fs.existsSync(metaPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function sanitizeChildEnv(baseEnv = process.env, { stripAntigravity = false } = {}) {
  const clean = { ...baseEnv };
  for (const k of Object.keys(clean)) {
    const upper = k.toUpperCase();
    if (
      upper === 'GEMINI_API_KEY' ||
      upper === 'GOOGLE_API_KEY' ||
      upper.startsWith('GOOGLE_GENAI_') ||
      (stripAntigravity && upper.startsWith('ANTIGRAVITY_'))
    ) {
      delete clean[k];
    }
  }
  return clean;
}

export function resolveDataDir(
  overrideDir = undefined,
  { metaPath = INSTALL_META_PATH } = {},
) {
  const explicit = overrideDir !== undefined ? overrideDir : process.env.AGY_SUITE_HUD_DATA_DIR;
  if (explicit && String(explicit).trim()) {
    return path.resolve(String(explicit).trim());
  }
  const meta = readInstallMeta(metaPath);
  if (meta && typeof meta.dataDir === 'string' && meta.dataDir.trim()) {
    return path.resolve(meta.dataDir.trim());
  }
  return path.join(os.homedir(), '.gemini', 'agy-suite', 'hud');
}

export function resolveBrainDirs(
  overrideBrainDir = process.env.AGY_SUITE_HUD_BRAIN_DIR,
  brainOnly = process.env.AGY_SUITE_HUD_BRAIN_ONLY === '1',
  { metaPath = INSTALL_META_PATH } = {},
) {
  const dirs = [];
  if (overrideBrainDir && String(overrideBrainDir).trim()) {
    dirs.push(path.resolve(String(overrideBrainDir).trim()));
    if (brainOnly) {
      return dirs;
    }
  }
  const geminiDirs = [];
  const meta = readInstallMeta(metaPath);
  if (meta && typeof meta.geminiDir === 'string' && meta.geminiDir.trim()) {
    geminiDirs.push(path.resolve(meta.geminiDir.trim()));
  }
  geminiDirs.push(path.join(os.homedir(), '.gemini'));
  for (const geminiDir of [...new Set(geminiDirs)]) {
    for (const edition of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
      dirs.push(path.join(geminiDir, edition, 'brain'));
    }
  }
  return [...new Set(dirs)];
}

export function resolveControlRoomPort(
  raw = process.env.AGY_SUITE_HUD_PORT,
  { allowZero = false } = {},
) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_PORT;
  }
  const num = Number(raw);
  const minPort = allowZero ? 0 : 1;
  return Number.isInteger(num) && num >= minPort && num <= 65535 ? num : DEFAULT_PORT;
}

export function getDataPaths(dataDir = resolveDataDir()) {
  const base = path.resolve(dataDir);
  return {
    dataDir: base,
    settingsPath: path.join(base, 'settings.json'),
    secretsPath: path.join(base, 'secrets.json'),
    cachePath: path.join(base, `${FILE_PREFIX}-cache.json`),
    sessionsStatePath: path.join(base, `${FILE_PREFIX}-sessions.json`),
    negCachePath: path.join(base, `${FILE_PREFIX}-negcache.json`),
    circuitBreakerPath: path.join(base, `${FILE_PREFIX}-cb.json`),
    roomUiStatePath: path.join(base, `${FILE_PREFIX}-room-state.json`),
    daemonStatePath: path.join(base, `${FILE_PREFIX}-daemon.json`),
    sidecarViewerHeartbeatPath: path.join(base, `${FILE_PREFIX}-sidecar-viewer.json`),
    stateLockPath: path.join(base, `${FILE_PREFIX}-state.lock`),
    cacheLockPath: path.join(base, `${FILE_PREFIX}-cache.lock`),
    daemonStartLockPath: path.join(base, `${FILE_PREFIX}-daemon-start.lock`),
  };
}
