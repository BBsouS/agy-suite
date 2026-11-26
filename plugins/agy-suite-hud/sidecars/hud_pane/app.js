(() => {
  const LIVE_POLL_MS = 1400;
  const HIDDEN_POLL_MS = 15000;
  const QUOTA_POLL_MS = 120000;
  const CONTEXT_CAPS = ['auto', 515000, 640000, 1000000];
  const STORAGE_PREFIX = 'agy_suite_hud_';
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(window.location.search);
  const hostConvId = () => String(window.sidecar?.conversationId || params.get('conversationId') || '').trim();

  function detectDefaultLang() {
    const saved = localStorage.getItem(`${STORAGE_PREFIX}lang`);
    if (saved === 'ko' || saved === 'en') return saved;
    const nav = String(navigator.language || '').toLowerCase();
    return nav.startsWith('ko') ? 'ko' : 'en';
  }

  function detectBrowserTimezone() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return typeof tz === 'string' && tz.trim() ? tz.trim() : 'UTC';
    } catch {
      return 'UTC';
    }
  }

  const I18N = {
    ko: {
      title: 'AGY SUITE HUD',
      autoFollow: '자동 추종',
      slotsMode: '4슬롯',
      salon: '살롱',
      native: '네이티브',
      restored: '복원',
      raw: '원문',
      mainLabel: '메인',
      liveTag: '동작 중',
      runningTag: '진행',
      swarmCount: (n) => `스웜 ${n}`,
      swarmRunningTip: (n) => `스웜 ${n}기 동작 중`,
      mainRunningTip: '메인 세션 추론 진행 중',
      prevTurn: '이전 턴',
      nextTurn: '다음 턴',
      restoreNow: '지금 복원',
      restoring: '복원 중…',
      settingsTitle: '복원 엔진 설정',
      close: '닫기',
      mode: '복원 모드',
      modeRaw: '원문 오프라인 (0바이트)',
      modeGemini: 'Gemini API 복원',
      modeTranslate: '구글 번역 (Opt-In)',
      targetLang: '목표 언어',
      preset: '프롬프트 프리셋',
      presetEngineer: '1인칭 엔지니어 독백 (기본)',
      presetBullet: '핵심 요약 불릿',
      presetCustom: '커스텀 프롬프트',
      timezone: '타임존 (IANA)',
      models: 'Gemini 모델 (쉼표 구분)',
      apiKey: '전용 Gemini API 키 (선택)',
      apiKeyPlaceholder: '비워두면 기존 키 유지',
      clearKey: '키 삭제',
      testKey: '연결 테스트',
      save: '저장',
      keyConfigured: (mask) => `API 키 저장됨 (${mask})`,
      keyNotSet: 'API 키 미설정 (오프라인 기본)',
      keyClearedPending: '저장 시 API 키 삭제 예정',
      settingsSaved: '설정을 저장했습니다. 다음 폴링부터 즉시 반영됩니다.',
      settingsLoadFail: (m) => `설정 로드 실패: ${m}`,
      saveFail: (m) => `저장 실패: ${m}`,
      testingConn: '연결 테스트 실행 중...',
      testOk: (m) => `연결 정상${m ? ` (${m})` : ''}`,
      testFail: (m) => `연결 실패 — ${m}`,
      emptyWaitTitle: '현재 대화의 추론 대기 중',
      emptyNoSessTitle: '표시할 세션이 없습니다',
      emptyWaitDesc: '첫 턴이 시작되면 추론 흐름이 자동으로 표시됩니다. 다른 활성 세션을 보려면 상단 4슬롯 버튼을 눌러 주세요.',
      emptyNoSessDesc: 'Antigravity에서 대화를 시작하면 실시간으로 추론 로그와 계기판이 연동됩니다.',
      emptyNoStepsTitle: '기록된 추론 단계가 아직 없습니다',
      emptyNoStepsDesc: '응답 생성이 진행되면 실시간으로 표시됩니다.',
      tagRaw: '원문',
      tagRestored: '복원됨',
      tagPending: '복원 대기',
      noContent: '(내용 없음)',
      meterCtx: '맥락',
      meterToggle: '계기판',
      cacheChip: (pct) => `캐시 ${pct}%`,
      compactChip: (n) => `압축 ${n}회`,
      quotaLoading: '할당량 조회 중…',
      quotaUnavailable: '할당량 조회 불가',
      quotaStale: '갱신 지연',
      quotaStaleTip: '최근 조회 실패로 캐시 표시 중',
      quotaWeekly: '주간',
      quotaRefreshTip: '할당량 새로고침 (토큰 0 소모)',
      statusLive: '실시간 연동 중',
      statusSleep: '절전 대기 (0바이트)',
      statusRetry: (m) => `연결 재시도 중 (${m})`,
      statusIdle: '대기',
      turnLoadFail: (m) => `턴 로드 실패: ${m}`,
      restoreFail: (m) => `복원 실패: ${m}`,
      modeShort: { raw: 'RAW 오프라인', gemini: 'Gemini API', translate: '번역' },
      capReasonManualFull: '수동 · 전체 창',
      capReasonManual: '수동 기준선',
      capReasonAutoObs: '자동 · 이 방 실측 자동 컴팩트선',
      capReasonAutoEst: '자동 · 예상 컴팩트선',
      dropManual: '수동 /compact',
      dropAuto: '자동 압축',
      ctxTipNow: (tot, inp, cac) => `현재 맥락: ${tot} tok (입력 ${inp} + 캐시 ${cac})`,
      ctxTipPeak: (pk, mod) => `최고치: ${pk} tok · 모델: ${mod}`,
      ctxTipCap: (cap, rsn, fw) => `기준선: ${cap} (${rsn} · 전체 창 ${fw})`,
      ctxTipCycle: '클릭 시 기준선 전환: 자동(컴팩트선) → 515K → 640K → 1M(전체 창)',
      ctxTipDrop: (kind, from, to) => `최근 압축(${kind}): ${from} → ${to} tok`,
      cacheTip: (cac, tot) => `캐시 읽기 ${cac} / 전체 ${tot} tok`,
      compactTipDrop: (from, to) => `최근 압축: ${from} → ${to} tok`,
      compactTipCount: (n) => `총 ${n}회 압축 감지`,
      resetPrefix: '리셋: ',
      relDays: (d, h) => `${d}일 ${h}시간 후`,
      relHours: (h, m) => `${h}시간 ${m}분 후`,
      relMins: (m) => `${m}분 후`,
    },
    en: {
      title: 'AGY SUITE HUD',
      autoFollow: 'Auto',
      slotsMode: 'Slots',
      salon: 'Salon',
      native: 'Native',
      restored: 'Restored',
      raw: 'Raw',
      mainLabel: 'Main',
      liveTag: 'Live',
      runningTag: 'Live',
      swarmCount: (n) => `Swarm ${n}`,
      swarmRunningTip: (n) => `${n} swarm worker(s) running`,
      mainRunningTip: 'Main session thinking',
      prevTurn: 'Previous turn',
      nextTurn: 'Next turn',
      restoreNow: 'Restore',
      restoring: 'Restoring…',
      settingsTitle: 'Engine Settings',
      close: 'Close',
      mode: 'Mode',
      modeRaw: 'Raw Offline (0 bytes)',
      modeGemini: 'Gemini API Restore',
      modeTranslate: 'Google Translate (Opt-In)',
      targetLang: 'Target Language',
      preset: 'Prompt Preset',
      presetEngineer: 'First-Person Monologue (Default)',
      presetBullet: 'Key-Point Bullets',
      presetCustom: 'Custom Prompt',
      timezone: 'Timezone (IANA)',
      models: 'Gemini Models (comma-separated)',
      apiKey: 'Dedicated Gemini API Key (optional)',
      apiKeyPlaceholder: 'Leave blank to keep existing key',
      clearKey: 'Clear',
      testKey: 'Test Key',
      save: 'Save',
      keyConfigured: (mask) => `API key saved (${mask})`,
      keyNotSet: 'No API key (offline default)',
      keyClearedPending: 'API key will be cleared on save',
      settingsSaved: 'Settings saved. Active on next poll.',
      settingsLoadFail: (m) => `Failed to load settings: ${m}`,
      saveFail: (m) => `Save failed: ${m}`,
      testingConn: 'Testing key...',
      testOk: (m) => `Connected${m ? ` (${m})` : ''}`,
      testFail: (m) => `Failed — ${m}`,
      emptyWaitTitle: 'Waiting for reasoning steps',
      emptyNoSessTitle: 'No active sessions',
      emptyWaitDesc: 'Reasoning steps will appear automatically once the first turn begins. Click Slots above to view other active sessions.',
      emptyNoSessDesc: 'Start a conversation in Antigravity to stream live reasoning and telemetry here.',
      emptyNoStepsTitle: 'No reasoning steps recorded yet',
      emptyNoStepsDesc: 'Steps appear live while the model is thinking.',
      tagRaw: 'Raw',
      tagRestored: 'Restored',
      tagPending: 'Pending',
      noContent: '(empty)',
      meterCtx: 'CTX',
      meterToggle: 'Meter',
      cacheChip: (pct) => `KV ${pct}%`,
      compactChip: (n) => `Compact ${n}`,
      quotaLoading: 'Loading quota…',
      quotaUnavailable: 'Quota unavailable',
      quotaStale: 'Stale',
      quotaStaleTip: 'Showing cached quota due to transient CLI error',
      quotaWeekly: 'Wk',
      quotaRefreshTip: 'Refresh quota (0 tokens)',
      statusLive: 'Live connected',
      statusSleep: 'Idle sleep (0 bytes)',
      statusRetry: (m) => `Reconnecting (${m})`,
      statusIdle: 'Idle',
      turnLoadFail: (m) => `Turn load failed: ${m}`,
      restoreFail: (m) => `Restore failed: ${m}`,
      modeShort: { raw: 'RAW Offline', gemini: 'Gemini API', translate: 'Translate' },
      capReasonManualFull: 'Manual · Full Window',
      capReasonManual: 'Manual Baseline',
      capReasonAutoObs: 'Auto · Observed Compaction Line',
      capReasonAutoEst: 'Auto · Estimated Compaction Line',
      dropManual: 'Manual /compact',
      dropAuto: 'Auto Compaction',
      ctxTipNow: (tot, inp, cac) => `Context: ${tot} tok (input ${inp} + cache ${cac})`,
      ctxTipPeak: (pk, mod) => `Peak: ${pk} tok · Model: ${mod}`,
      ctxTipCap: (cap, rsn, fw) => `Baseline: ${cap} (${rsn} · Window ${fw})`,
      ctxTipCycle: 'Click to cycle baseline: Auto → 515K → 640K → 1M',
      ctxTipDrop: (kind, from, to) => `Last compaction (${kind}): ${from} → ${to} tok`,
      cacheTip: (cac, tot) => `Cache read ${cac} / Total ${tot} tok`,
      compactTipDrop: (from, to) => `Last compaction: ${from} → ${to} tok`,
      compactTipCount: (n) => `${n} compaction(s) detected`,
      resetPrefix: 'Reset: ',
      relDays: (d, h) => `in ${d}d ${h}h`,
      relHours: (h, m) => `in ${h}h ${m}m`,
      relMins: (m) => `in ${m}m`,
    },
  };

  const rawSavedCap = localStorage.getItem(`${STORAGE_PREFIX}ctx_cap_v1`);
  const savedCap = rawSavedCap === 'auto' ? 'auto' : Number(rawSavedCap);
  const st = {
    lang: detectDefaultLang(),
    style: localStorage.getItem(`${STORAGE_PREFIX}style`) || 'salon',
    followHost: localStorage.getItem(`${STORAGE_PREFIX}follow`) !== '0',
    showRaw: localStorage.getItem(`${STORAGE_PREFIX}raw`) === '1',
    meterOpen: localStorage.getItem(`${STORAGE_PREFIX}meter_open`) !== '0',
    contextCap: CONTEXT_CAPS.includes(savedCap) ? savedCap : 'auto',
    selectedMainConvId: '',
    selectedSpeakerByMain: new Map(),
    turnOverrideByConv: new Map(),
    etag: '',
    snapshot: null,
    pollTimer: null,
    pollInFlight: false,
    restoringConv: false,
    settingsOpen: false,
    clearApiKeyPending: false,
    hasApiKey: false,
    apiKeyMask: '',
    lastRenderedSig: '',
    activeMeterConvId: '',
    lastMeterKey: '',
    contextMeter: null,
    quota: null,
    quotaInFlight: false,
    quotaLastFetchedAt: 0,
    quotaTimer: null,
  };

  const t = () => I18N[st.lang] || I18N.en;

  function syncThemeScheme() {
    try {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #0d111a)';
      document.documentElement.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      const nums = (c.match(/[\d.]+/g) || []).map(Number);
      if (nums.length < 3) return;
      const scale = c.startsWith('color(') ? 1 : 255;
      const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      document.documentElement.dataset.theme = lum > 0.5 ? 'light' : 'dark';
    } catch {
      // Fallback to dark theme.
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.data?.type === 'theme-change') {
      requestAnimationFrame(syncThemeScheme);
    }
  });

  async function apiGet(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  async function apiPost(path, body) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatInlineMarkdown(raw) {
    const codeTokens = [];
    let safe = escapeHtml(raw);
    safe = safe.replace(/`([^`\n]+)`/g, (_m, code) => {
      const idx = codeTokens.length;
      codeTokens.push(`<code>${code}</code>`);
      return `\u0000CODE${idx}\u0000`;
    });
    safe = safe.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx) => codeTokens[Number(idx)] || '');
    return safe;
  }

  function renderMarkdownSafe(text) {
    const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return `<p>${escapeHtml(t().noContent)}</p>`;

    const blocks = [];
    const lines = normalized.split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i += 1;
        continue;
      }

      if (trimmed.startsWith('```')) {
        const codeLines = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          codeLines.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        blocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        continue;
      }

      const boldHeading = trimmed.match(/^\*\*([^*\n]{1,90})\*\*$/);
      const hashHeading = trimmed.match(/^#{1,4}\s+(.+)$/);
      if (boldHeading) {
        blocks.push(`<div class="md-heading">${formatInlineMarkdown(boldHeading[1])}</div>`);
        i += 1;
        continue;
      }
      if (hashHeading) {
        blocks.push(`<div class="md-heading">${formatInlineMarkdown(hashHeading[1])}</div>`);
        i += 1;
        continue;
      }

      if (/^[-*]\s+/.test(trimmed)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(`<li>${formatInlineMarkdown(lines[i].trim().replace(/^[-*]\s+/, ''))}</li>`);
          i += 1;
        }
        blocks.push(`<ul>${items.join('')}</ul>`);
        continue;
      }

      const paraLines = [];
      while (i < lines.length) {
        const lt = lines[i].trim();
        if (!lt || lt.startsWith('```') || /^[-*]\s+/.test(lt) || /^\*\*([^*\n]{1,90})\*\*$/.test(lt) || /^#{1,4}\s+/.test(lt)) {
          break;
        }
        paraLines.push(formatInlineMarkdown(lines[i]));
        i += 1;
      }
      blocks.push(`<p>${paraLines.join('<br />')}</p>`);
    }

    return blocks.join('');
  }

  function resolveSessions() {
    const all = Array.isArray(st.snapshot?.sessions) ? st.snapshot.sessions : [];
    const visible = all.filter((s) => !s.isDismissed);
    return visible.length > 0 ? visible : all;
  }

  function findTargetSession(sessions) {
    const hc = hostConvId();
    if (st.followHost && hc) {
      const exactMain = sessions.find((s) => s.conversationId === hc);
      if (exactMain) return { session: exactMain, forcedWorkerId: '' };
      for (const s of sessions) {
        const matchedWorker = (s.swarmWorkers || []).find((w) => w.conversationId === hc);
        if (matchedWorker) return { session: s, forcedWorkerId: matchedWorker.conversationId };
      }
      return { session: null, forcedWorkerId: '' };
    }
    if (st.selectedMainConvId) {
      const found = sessions.find((s) => s.conversationId === st.selectedMainConvId);
      if (found) return { session: found, forcedWorkerId: '' };
    }
    if (st.snapshot?.selectedMainConvId) {
      const snapFound = sessions.find((s) => s.conversationId === st.snapshot.selectedMainConvId);
      if (snapFound) return { session: snapFound, forcedWorkerId: '' };
    }
    const active = sessions.find((s) => s.isActive) || sessions[0] || null;
    return { session: active, forcedWorkerId: '' };
  }

  function getActiveTarget(session, forcedWorkerId) {
    if (!session) return null;
    const workers = Array.isArray(session.swarmWorkers) ? session.swarmWorkers : [];
    let selectedKey = st.selectedSpeakerByMain.get(session.conversationId) || 'main';
    if (forcedWorkerId && !st.selectedSpeakerByMain.has(session.conversationId)) {
      selectedKey = forcedWorkerId;
    }
    if (selectedKey !== 'main') {
      const worker = workers.find((w) => w.conversationId === selectedKey);
      if (worker) {
        return {
          kind: 'worker',
          role: 'worker',
          mainConvId: session.conversationId,
          convId: worker.conversationId,
          label: worker.displayLabel || worker.workerName || 'worker',
          totalTurns: worker.totalTurns || 1,
          latestTurn: worker.latestTurn,
          isRunning: !worker.latestTurn?.isComplete,
        };
      }
    }
    return {
      kind: 'main',
      role: 'main',
      mainConvId: session.conversationId,
      convId: session.conversationId,
      label: t().mainLabel,
      totalTurns: session.totalTurns || 1,
      latestTurn: session.latestTurn,
      isRunning: !session.latestTurn?.isComplete,
    };
  }

  async function selectSpeaker(mainConvId, speakerKey) {
    st.selectedSpeakerByMain.set(mainConvId, speakerKey);
    render();
    try {
      if (speakerKey === 'main') {
        await apiPost('/api/select-worker', { conversationId: '', parentConvId: mainConvId });
      } else {
        await apiPost('/api/select-worker', { conversationId: speakerKey, parentConvId: mainConvId });
      }
    } catch {
      // Ignore worker selection sync error.
    }
  }

  async function navigateTurn(convId, nextIdx, totalTurns) {
    if (nextIdx < 0 || nextIdx >= totalTurns) return;
    if (nextIdx === totalTurns - 1) {
      st.turnOverrideByConv.delete(convId);
      render();
      return;
    }
    try {
      const data = await apiGet(
        `/api/turn?conversationId=${encodeURIComponent(convId)}&turnIndex=${encodeURIComponent(nextIdx)}`,
      );
      if (data?.ok && data.turn) {
        st.turnOverrideByConv.set(convId, {
          turnIndex: data.turn.turnIndex,
          turn: data.turn,
          totalTurns: data.totalTurns || totalTurns,
        });
        render();
      }
    } catch (err) {
      $('footerStatus').textContent = t().turnLoadFail(err.message);
    }
  }

  async function triggerManualRestore(target, displayTurn) {
    if (st.restoringConv || !target || !displayTurn) return;
    st.restoringConv = true;
    render();
    try {
      const res = await apiPost('/api/restore-turn', {
        conversationId: target.convId,
        turnIndex: displayTurn.turnIndex,
        userStepIndex: displayTurn.userStepIndex,
      });
      if (res?.ok && res.turn) {
        if (st.turnOverrideByConv.has(target.convId)) {
          st.turnOverrideByConv.set(target.convId, {
            turnIndex: res.turn.turnIndex,
            turn: res.turn,
            totalTurns: res.totalTurns || target.totalTurns,
          });
        }
        st.etag = '';
        await pollState(true);
      }
    } catch (err) {
      $('footerStatus').textContent = t().restoreFail(err.message);
    } finally {
      st.restoringConv = false;
      render();
    }
  }

  function formatTokensCompact(n) {
    const num = Number(n) || 0;
    if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(num >= 100000 ? 0 : 1)}K`;
    return String(num);
  }

  function formatResetTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const dict = t();
    const diffMs = d.getTime() - Date.now();
    let rel = '';
    if (diffMs > 0) {
      const mins = Math.round(diffMs / 60000);
      const days = Math.floor(mins / 1440);
      const hrs = Math.floor((mins % 1440) / 60);
      const remMins = mins % 60;
      if (days > 0) rel = dict.relDays(days, hrs);
      else if (hrs > 0) rel = dict.relHours(hrs, remMins);
      else rel = dict.relMins(remMins);
    }
    const tz = st.snapshot?.timezone || detectBrowserTimezone();
    const fmt = new Intl.DateTimeFormat(st.lang === 'ko' ? 'ko-KR' : 'en-US', {
      ...(tz ? { timeZone: tz } : {}),
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
    return rel ? `${fmt} (${rel})` : fmt;
  }

  function resolveContextCap(cm) {
    const dict = t();
    const m = String(cm?.model || '').toLowerCase();
    const isGptOss = m.includes('gpt-oss');
    const isClaude = m.includes('claude');
    const fullWindow = isGptOss ? 128000 : isClaude ? 200000 : 1000000;
    const minAutoCap = isGptOss ? 70000 : isClaude ? 110000 : 280000;
    const maxAutoCap = isGptOss ? 125000 : isClaude ? 195000 : 950000;
    if (st.contextCap !== 'auto' && Number.isFinite(Number(st.contextCap))) {
      const cap = Number(st.contextCap);
      return {
        cap,
        prefix: '',
        reason: cap >= fullWindow ? dict.capReasonManualFull : dict.capReasonManual,
        fullWindow,
      };
    }
    const observedAutoDropFrom = Number(cm?.lastAutoDrop?.from) || 0;
    if (observedAutoDropFrom >= minAutoCap && observedAutoDropFrom <= maxAutoCap) {
      return {
        cap: observedAutoDropFrom,
        prefix: '',
        reason: dict.capReasonAutoObs,
        fullWindow,
      };
    }
    if (isGptOss) {
      return { cap: 100000, prefix: '~', reason: dict.capReasonAutoEst, fullWindow };
    }
    if (isClaude) {
      return { cap: 160000, prefix: '~', reason: dict.capReasonAutoEst, fullWindow };
    }
    return { cap: 515000, prefix: '~', reason: dict.capReasonAutoEst, fullWindow };
  }

  function renderTelemetryDock() {
    const dict = t();
    $('telemetryDock').classList.toggle('hidden', !st.meterOpen);
    $('btnMeterToggle').classList.toggle('active', st.meterOpen);
    $('btnMeterToggle').textContent = dict.meterToggle;
    $('lblMeterCtx').textContent = dict.meterCtx;
    $('btnRefreshQuota').title = dict.quotaRefreshTip;

    // 1. Context meter
    const cm = st.contextMeter;
    const capBtn = $('btnContextCap');
    const fill = $('contextMeterFill');
    const pctEl = $('contextMeterPct');
    const cacheChip = $('cacheHitBadge');
    const compChip = $('compactionBadge');
    const { cap, prefix, reason, fullWindow } = resolveContextCap(cm);

    if (!cm || !cm.available) {
      capBtn.textContent = `-- / ${prefix}${formatTokensCompact(cap)}`;
      capBtn.title = dict.ctxTipCycle;
      fill.style.width = '0%';
      fill.className = 'meter-fill';
      pctEl.textContent = '--%';
      cacheChip.classList.add('hidden');
      compChip.classList.add('hidden');
    } else {
      const pctRaw = Math.round((cm.totalTokens / cap) * 100);
      const pctBar = Math.max(0, Math.min(100, pctRaw));
      capBtn.textContent = `${formatTokensCompact(cm.totalTokens)} / ${prefix}${formatTokensCompact(cap)}`;
      const tipLines = [
        dict.ctxTipNow(
          cm.totalTokens.toLocaleString(),
          cm.inputTokens.toLocaleString(),
          cm.cacheReadTokens.toLocaleString(),
        ),
        dict.ctxTipPeak(cm.peakTokens.toLocaleString(), cm.model || '-'),
        dict.ctxTipCap(`${prefix}${formatTokensCompact(cap)}`, reason, formatTokensCompact(fullWindow)),
        dict.ctxTipCycle,
      ];
      if (cm.lastDrop) {
        const dropKind = cm.lastDrop.kind === 'manual' ? dict.dropManual : dict.dropAuto;
        tipLines.push(
          dict.ctxTipDrop(dropKind, cm.lastDrop.from.toLocaleString(), cm.lastDrop.to.toLocaleString()),
        );
      }
      capBtn.title = tipLines.join('\n');
      fill.style.width = `${pctBar}%`;
      fill.className = `meter-fill${pctRaw >= 85 ? ' danger' : pctRaw >= 65 ? ' warn' : ''}`;
      pctEl.textContent = `${pctRaw}%`;

      cacheChip.classList.remove('hidden');
      cacheChip.textContent = dict.cacheChip(cm.cacheHitPct);
      cacheChip.className = `meter-chip${cm.cacheHitPct >= 75 ? ' chip-good' : ''}`;
      cacheChip.title = dict.cacheTip(
        cm.cacheReadTokens.toLocaleString(),
        cm.totalTokens.toLocaleString(),
      );

      if (cm.compactionCount > 0) {
        compChip.classList.remove('hidden');
        compChip.textContent = dict.compactChip(cm.compactionCount);
        compChip.title = cm.lastDrop
          ? dict.compactTipDrop(cm.lastDrop.from.toLocaleString(), cm.lastDrop.to.toLocaleString())
          : dict.compactTipCount(cm.compactionCount);
      } else {
        compChip.classList.add('hidden');
      }
    }

    // 2. Quota meter
    const qBox = $('quotaItems');
    const q = st.quota;
    $('btnRefreshQuota').disabled = st.quotaInFlight;
    if (!q) {
      qBox.innerHTML = `<span class="quota-loading">${escapeHtml(dict.quotaLoading)}</span>`;
      return;
    }
    if (!q.ok && (!Array.isArray(q.groups) || q.groups.length === 0)) {
      qBox.innerHTML = `<span class="quota-loading" title="${escapeHtml(q.error || '')}">${escapeHtml(dict.quotaUnavailable)}</span>`;
      return;
    }

    const renderBucket = (prefixLabel, b) => {
      if (!b || b.pct === null || b.pct === undefined) return '';
      const cls = b.pct <= 20 ? 'q-low' : b.pct <= 45 ? 'q-warn' : 'q-good';
      const resetTxt = formatResetTime(b.resetTime);
      const tip = [b.description, resetTxt ? `${dict.resetPrefix}${resetTxt}` : ''].filter(Boolean).join('\n');
      return `<span class="quota-pill ${cls}" title="${escapeHtml(tip)}">${escapeHtml(prefixLabel)} ${b.pct}%<span class="quota-mini-bar"><span class="quota-mini-fill" style="width:${b.pct}%"></span></span></span>`;
    };

    const staleSuffix = q.stale
      ? `<span class="quota-loading" title="${escapeHtml(q.staleError || dict.quotaStaleTip)}">${escapeHtml(dict.quotaStale)}</span>`
      : '';

    qBox.innerHTML =
      q.groups
        .map((g) => {
          const gCls = g.key === 'gemini' ? 'g-gemini' : g.key === 'claude' ? 'g-claude' : '';
          const h5 = renderBucket('5h', g.fiveHour);
          const wk = renderBucket(dict.quotaWeekly, g.weekly);
          return `<span class="quota-group"><span class="quota-gname ${gCls}">${escapeHtml(g.label)}</span>${h5}${wk}</span>`;
        })
        .join('') + staleSuffix;
  }

  async function refreshContextMeter(convId, stepSigKey = '') {
    if (!convId || !st.meterOpen) return;
    const key = `${convId}|${stepSigKey}`;
    if (st.lastMeterKey === key) return;
    st.lastMeterKey = key;
    st.activeMeterConvId = convId;
    try {
      const data = await apiGet(`/api/context-meter?conversationId=${encodeURIComponent(convId)}`);
      if (st.activeMeterConvId === convId) {
        st.contextMeter = data;
        renderTelemetryDock();
      }
    } catch {
      st.lastMeterKey = '';
      // Ignore transient meter read errors and allow retry on next render.
    }
  }

  async function refreshQuota(force = false) {
    if (st.quotaInFlight) return;
    if (!force && document.visibilityState === 'hidden') return;
    if (!force && st.quota && Date.now() - st.quotaLastFetchedAt < QUOTA_POLL_MS - 5000) return;
    st.quotaInFlight = true;
    renderTelemetryDock();
    try {
      const data = await apiGet(`/api/quota${force ? '?force=1' : ''}`);
      st.quota = data;
      st.quotaLastFetchedAt = data.fetchedAt || Date.now();
    } catch (err) {
      if (!st.quota || Date.now() - st.quotaLastFetchedAt > 10 * 60 * 1000) {
        st.quota = { ok: false, error: err.message, groups: [] };
      } else {
        st.quota = { ...st.quota, stale: true, staleError: err.message };
      }
    } finally {
      st.quotaInFlight = false;
      renderTelemetryDock();
    }
  }

  function scheduleQuotaPoll() {
    if (st.quotaTimer) clearTimeout(st.quotaTimer);
    st.quotaTimer = setTimeout(async () => {
      if (document.visibilityState !== 'hidden' && st.meterOpen) {
        await refreshQuota(false);
      }
      scheduleQuotaPoll();
    }, QUOTA_POLL_MS);
  }

  function applyStaticLabels() {
    const dict = t();
    document.documentElement.lang = st.lang;
    $('paneTitle').textContent = dict.title;
    $('btnLangToggle').textContent = st.lang === 'ko' ? '한국어' : 'EN';
    $('btnPrevTurn').title = dict.prevTurn;
    $('btnNextTurn').title = dict.nextTurn;
    $('lblSettingsTitle').textContent = dict.settingsTitle;
    $('btnCloseSettings').textContent = dict.close;
    $('lblMode').textContent = dict.mode;
    const modeSel = $('setMode');
    modeSel.options[0].textContent = dict.modeRaw;
    modeSel.options[1].textContent = dict.modeGemini;
    modeSel.options[2].textContent = dict.modeTranslate;
    $('lblTargetLang').textContent = dict.targetLang;
    $('lblPreset').textContent = dict.preset;
    const presetSel = $('setPreset');
    presetSel.options[0].textContent = dict.presetEngineer;
    presetSel.options[1].textContent = dict.presetBullet;
    presetSel.options[2].textContent = dict.presetCustom;
    $('lblTimezone').textContent = dict.timezone;
    $('lblModels').textContent = dict.models;
    $('lblApiKey').textContent = dict.apiKey;
    $('setApiKey').placeholder = dict.apiKeyPlaceholder;
    $('btnClearKey').textContent = dict.clearKey;
    $('btnTestConn').textContent = dict.testKey;
    $('btnSaveSettings').textContent = dict.save;
    updateCredSummary();
  }

  function updateCredSummary() {
    const dict = t();
    if (st.clearApiKeyPending) {
      $('credSummary').textContent = dict.keyClearedPending;
    } else if (st.hasApiKey) {
      $('credSummary').textContent = dict.keyConfigured(st.apiKeyMask || '****');
    } else {
      $('credSummary').textContent = dict.keyNotSet;
    }
  }

  function renderHeaderControls() {
    const dict = t();
    applyStaticLabels();
    document.body.dataset.style = st.style;
    $('modeBadge').textContent = st.followHost ? dict.autoFollow : dict.slotsMode;
    $('btnFollowToggle').textContent = st.followHost ? dict.slotsMode : dict.autoFollow;
    $('btnFollowToggle').classList.toggle('active', !st.followHost);
    $('btnStyleToggle').textContent = st.style === 'salon' ? dict.salon : dict.native;
    $('btnStyleToggle').classList.toggle('active', st.style === 'salon');
    $('btnRawToggle').textContent = st.showRaw ? dict.raw : dict.restored;
    $('btnRawToggle').classList.toggle('active', st.showRaw);
    $('btnSettings').classList.toggle('active', st.settingsOpen);
    renderTelemetryDock();
  }

  function getSessionDisplayTitle(s) {
    if (!s) return '';
    return (
      String(s.sessionTopic || '').trim() ||
      String(s.latestTurn?.userSummary || '').trim() ||
      String(s.conversationId || '').slice(0, 8)
    );
  }

  function renderSlotBar(sessions, activeSession) {
    const dict = t();
    const slotBar = $('slotBar');
    const shouldShow = !st.followHost || (!activeSession && sessions.length > 0);
    slotBar.classList.toggle('hidden', !shouldShow);
    if (!shouldShow) return;

    slotBar.innerHTML = '';
    for (const s of sessions.slice(0, 8)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isSelected = activeSession && activeSession.conversationId === s.conversationId;
      const runningWorkers = (s.swarmWorkers || []).filter(
        (w) => w.latestTurn && !w.latestTurn.isComplete,
      ).length;
      const mainRunning = Boolean(s.latestTurn && !s.latestTurn.isComplete);
      const isAnyRunning = mainRunning || runningWorkers > 0;

      btn.className = `slot-chip${isSelected ? ' active' : ''}${isAnyRunning ? ' is-running' : ''}`;
      const label = getSessionDisplayTitle(s);
      const tooltipParts = [label];
      if (runningWorkers > 0) tooltipParts.push(dict.swarmRunningTip(runningWorkers));
      else if (mainRunning) tooltipParts.push(dict.mainRunningTip);
      tooltipParts.push(`ID: ${s.conversationId.slice(0, 8)}`);
      btn.title = tooltipParts.join('\n');

      const runBadge =
        runningWorkers > 0
          ? `<span class="slot-run-tag">${escapeHtml(dict.swarmCount(runningWorkers))}</span>`
          : mainRunning
            ? `<span class="slot-run-tag">${escapeHtml(dict.runningTag)}</span>`
            : '';
      btn.innerHTML =
        (isAnyRunning || s.isActive ? '<span class="slot-live"></span>' : '') +
        `<span class="slot-label">${escapeHtml(label)}</span>` +
        runBadge;
      btn.addEventListener('click', () => {
        st.followHost = false;
        localStorage.setItem(`${STORAGE_PREFIX}follow`, '0');
        st.selectedMainConvId = s.conversationId;
        st.etag = '';
        render();
        pollState(true);
      });
      slotBar.appendChild(btn);
    }
  }

  function render() {
    const dict = t();
    renderHeaderControls();

    const sessions = resolveSessions();
    const { session, forcedWorkerId } = findTargetSession(sessions);
    renderSlotBar(sessions, session);

    const feed = $('thoughtFeed');
    const ctxBar = $('contextBar');
    const promptStrip = $('promptStrip');

    if (!session) {
      ctxBar.classList.add('hidden');
      promptStrip.classList.add('hidden');
      const hc = hostConvId();
      const emptySig = `empty:${st.lang}:${hc}:${sessions.length}:${st.followHost}`;
      if (st.lastRenderedSig !== emptySig) {
        st.lastRenderedSig = emptySig;
        feed.innerHTML = `
          <div class="empty-state">
            <div class="empty-title">${escapeHtml(hc ? dict.emptyWaitTitle : dict.emptyNoSessTitle)}</div>
            <div class="empty-desc">${escapeHtml(hc ? dict.emptyWaitDesc : dict.emptyNoSessDesc)}</div>
          </div>`;
      }
      $('footerRight').textContent = hc ? `conv ${hc.slice(0, 8)}` : dict.statusIdle;
      return;
    }

    ctxBar.classList.remove('hidden');
    const target = getActiveTarget(session, forcedWorkerId);
    const override = st.turnOverrideByConv.get(target.convId);
    const isViewingHistory = Boolean(override && override.turnIndex < target.totalTurns - 1);
    const displayTurn = isViewingHistory ? override.turn : target.latestTurn;
    const totalTurns = Math.max(1, target.totalTurns || 1);
    const curTurnIdx = displayTurn ? displayTurn.turnIndex : totalTurns - 1;

    const convTitle = getSessionDisplayTitle(session);
    $('convTopic').textContent = convTitle;
    $('convTopic').title = `${convTitle} (${session.conversationId.slice(0, 8)})`;
    $('turnIndicator').textContent = `${curTurnIdx + 1}/${totalTurns}`;
    $('btnPrevTurn').disabled = curTurnIdx <= 0;
    $('btnNextTurn').disabled = curTurnIdx >= totalTurns - 1;
    $('btnPrevTurn').onclick = () => navigateTurn(target.convId, curTurnIdx - 1, totalTurns);
    $('btnNextTurn').onclick = () => navigateTurn(target.convId, curTurnIdx + 1, totalTurns);

    const needsRestore = Number(displayTurn?.needsRestoreCount || 0) > 0;
    const restMode = st.snapshot?.restorationMode || 'raw';
    const restoreBtn = $('btnRestoreTurn');
    restoreBtn.classList.toggle('hidden', !needsRestore || restMode === 'raw');
    restoreBtn.disabled = st.restoringConv;
    restoreBtn.textContent = st.restoringConv ? dict.restoring : dict.restoreNow;
    restoreBtn.onclick = () => triggerManualRestore(target, displayTurn);

    // Speaker pills (Main + Swarm workers; float actively running workers first)
    const speakerRow = $('speakerRow');
    speakerRow.innerHTML = '';
    const workers = [...(Array.isArray(session.swarmWorkers) ? session.swarmWorkers : [])].sort(
      (a, b) => {
        const aRun = Boolean(a?.latestTurn && !a.latestTurn.isComplete);
        const bRun = Boolean(b?.latestTurn && !b.latestTurn.isComplete);
        if (aRun !== bRun) return aRun ? -1 : 1;
        return (b.lastActivityMs || 0) - (a.lastActivityMs || 0);
      },
    );

    const mainRunning = Boolean(session.latestTurn && !session.latestTurn.isComplete);
    const mainBtn = document.createElement('button');
    mainBtn.type = 'button';
    mainBtn.className = `speaker-pill${mainRunning ? ' running' : ''}${target.kind === 'main' ? ' active' : ''}`;
    mainBtn.dataset.role = 'main';
    mainBtn.innerHTML =
      (mainRunning ? '<span class="worker-live-dot"></span>' : '') +
      `<span>${escapeHtml(dict.mainLabel)}</span>` +
      (mainRunning ? `<span class="speaker-live-tag">${escapeHtml(dict.liveTag)}</span>` : '');
    mainBtn.addEventListener('click', () => selectSpeaker(session.conversationId, 'main'));
    speakerRow.appendChild(mainBtn);

    for (const w of workers) {
      const isRunning = Boolean(w.latestTurn && !w.latestTurn.isComplete);
      const wBtn = document.createElement('button');
      wBtn.type = 'button';
      wBtn.className = `speaker-pill${isRunning ? ' running' : ''}${target.convId === w.conversationId ? ' active' : ''}`;
      wBtn.dataset.role = 'worker';
      const liveDot = isRunning ? '<span class="worker-live-dot"></span>' : '';
      const liveTag = isRunning ? `<span class="speaker-live-tag">${escapeHtml(dict.liveTag)}</span>` : '';
      wBtn.innerHTML = `${liveDot}<span>${escapeHtml(w.displayLabel || w.workerName || 'worker')}</span>${liveTag}`;
      wBtn.addEventListener('click', () => selectSpeaker(session.conversationId, w.conversationId));
      speakerRow.appendChild(wBtn);
    }

    // Prompt quote
    const promptText = String(displayTurn?.userPrompt || displayTurn?.userSummary || '').trim();
    if (promptText && promptText !== '(empty)') {
      promptStrip.classList.remove('hidden');
      $('promptText').textContent = promptText;
      $('promptText').title = promptText;
    } else {
      promptStrip.classList.add('hidden');
    }

    // Thought step cards
    const steps = Array.isArray(displayTurn?.steps) ? displayTurn.steps : [];
    const renderSig = [
      st.lang,
      st.style,
      st.showRaw ? '1' : '0',
      restMode,
      target.convId,
      target.role,
      curTurnIdx,
      steps
        .map(
          (s) =>
            `${s.stepIndex}:${s.isRestored ? 1 : 0}:${(s.displayText || '').length}:${(s.enText || '').length}`,
        )
        .join(','),
    ].join('|');

    if (st.lastRenderedSig !== renderSig) {
      const wasNearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
      st.lastRenderedSig = renderSig;
      if (steps.length === 0) {
        feed.innerHTML = `
          <div class="empty-state">
            <div class="empty-title">${escapeHtml(dict.emptyNoStepsTitle)}</div>
            <div class="empty-desc">${escapeHtml(dict.emptyNoStepsDesc)}</div>
          </div>`;
      } else {
        const html = steps
          .map((step, idx) => {
            const useRaw = st.showRaw || restMode === 'raw' || !step.displayText;
            const text = useRaw ? step.enText || step.displayText || '' : step.displayText;
            const statusTag = useRaw
              ? `<span class="step-tag">${escapeHtml(dict.tagRaw)}</span>`
              : step.isRestored
                ? `<span class="step-tag">${escapeHtml(dict.tagRestored)}</span>`
                : `<span class="step-tag pending">${escapeHtml(dict.tagPending)}</span>`;
            const bodyHtml = useRaw ? escapeHtml(text) : renderMarkdownSafe(text);
            const bodyClass = useRaw ? 'step-body raw-mode' : 'step-body';
            return `
              <article class="step-card" data-role="${escapeHtml(target.role)}">
                <div class="step-head">
                  <div class="step-head-left">
                    <span class="step-badge">STEP ${idx + 1}</span>
                    ${statusTag}
                  </div>
                  <span class="step-time">${escapeHtml(step.timeFormatted || '')}</span>
                </div>
                <div class="${bodyClass}">${bodyHtml}</div>
              </article>`;
          })
          .join('');
        feed.innerHTML = html;
        if (wasNearBottom && !isViewingHistory) {
          feed.scrollTop = feed.scrollHeight;
        }
      }
    }

    const modeLabel = dict.modeShort[restMode] || restMode;
    $('footerRight').textContent = `${target.convId.slice(0, 8)} · ${modeLabel}`;
    refreshContextMeter(
      target.convId,
      `${totalTurns}:${steps.length}:${displayTurn?.lastTimestampIso || ''}`,
    );
  }

  async function pollState(force = false) {
    if (st.pollInFlight) return;
    st.pollInFlight = true;
    try {
      const visible = document.visibilityState !== 'hidden';
      const qs = new URLSearchParams();
      qs.set('visible', visible ? '1' : '0');
      const hc = hostConvId();
      if (hc) qs.set('conversationId', hc);
      const selectedTarget = st.followHost
        ? hc
        : st.selectedMainConvId || st.snapshot?.selectedMainConvId || hc;
      if (selectedTarget) qs.set('selectedConvId', selectedTarget);
      if (!force && st.etag) qs.set('etag', st.etag);

      const data = await apiGet(`/api/pane-state?${qs.toString()}`);
      $('liveDot').className = visible ? 'status-dot' : 'status-dot stale';
      if (data?.unchanged) {
        $('footerStatus').textContent = visible ? t().statusLive : t().statusSleep;
        return;
      }
      st.etag = data?.etag || '';
      st.snapshot = data;
      $('footerStatus').textContent = visible ? t().statusLive : t().statusSleep;
      render();
    } catch (err) {
      st.etag = '';
      $('liveDot').className = 'status-dot err';
      $('footerStatus').textContent = t().statusRetry(err.message);
    } finally {
      st.pollInFlight = false;
    }
  }

  function schedulePoll() {
    if (st.pollTimer) clearTimeout(st.pollTimer);
    const delay = document.visibilityState === 'hidden' ? HIDDEN_POLL_MS : LIVE_POLL_MS;
    st.pollTimer = setTimeout(async () => {
      await pollState(false);
      schedulePoll();
    }, delay);
  }

  async function openSettings() {
    st.settingsOpen = !st.settingsOpen;
    $('settingsDrawer').classList.toggle('hidden', !st.settingsOpen);
    st.clearApiKeyPending = false;
    $('setApiKey').value = '';
    renderHeaderControls();
    if (!st.settingsOpen) return;

    const msgEl = $('settingsMsg');
    msgEl.classList.add('hidden');
    try {
      const data = await apiGet('/api/settings');
      const s = data.settings || {};
      $('setMode').value = s.mode || 'raw';
      $('setTargetLang').value = s.targetLang || st.lang || 'en';
      $('setPreset').value = s.presetId || 'engineer-default';
      $('setTimezone').value = s.timezone || detectBrowserTimezone();
      $('setModels').value = (s.models || []).join(', ');
      st.hasApiKey = Boolean(data.hasApiKey);
      st.apiKeyMask = data.apiKeyMask || '';
      updateCredSummary();
    } catch (err) {
      msgEl.textContent = t().settingsLoadFail(err.message);
      msgEl.classList.remove('hidden');
    }
  }

  function parseModelCsv(raw) {
    return String(raw || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function saveSettings() {
    const dict = t();
    const msgEl = $('settingsMsg');
    try {
      const payload = {
        mode: $('setMode').value,
        targetLang: $('setTargetLang').value,
        presetId: $('setPreset').value,
        timezone: $('setTimezone').value.trim(),
        models: parseModelCsv($('setModels').value),
      };
      const enteredKey = $('setApiKey').value.trim();
      if (st.clearApiKeyPending) {
        payload.clearApiKey = true;
      } else if (enteredKey) {
        payload.apiKey = enteredKey;
      }
      const res = await apiPost('/api/settings', payload);
      st.hasApiKey = Boolean(res?.hasApiKey);
      st.apiKeyMask = res?.apiKeyMask || '';
      st.clearApiKeyPending = false;
      $('setApiKey').value = '';
      updateCredSummary();
      msgEl.textContent = dict.settingsSaved;
      msgEl.classList.remove('hidden');
      st.etag = '';
      await pollState(true);
    } catch (err) {
      msgEl.textContent = dict.saveFail(err.message);
      msgEl.classList.remove('hidden');
    }
  }

  async function testConnection() {
    const dict = t();
    const msgEl = $('settingsMsg');
    msgEl.textContent = dict.testingConn;
    msgEl.classList.remove('hidden');
    try {
      const firstModel = parseModelCsv($('setModels').value)[0] || '';
      const res = await apiPost('/api/test-key', {
        apiKey: $('setApiKey').value.trim(),
        model: firstModel,
      });
      if (res?.ok) {
        msgEl.textContent = dict.testOk(res.model || '');
      } else {
        msgEl.textContent = dict.testFail(res?.error || res?.code || `HTTP ${res?.status || '?'}`);
      }
    } catch (err) {
      msgEl.textContent = dict.testFail(err.message);
    }
  }

  // Bind UI events
  $('btnFollowToggle').addEventListener('click', () => {
    st.followHost = !st.followHost;
    localStorage.setItem(`${STORAGE_PREFIX}follow`, st.followHost ? '1' : '0');
    st.etag = '';
    render();
    pollState(true);
  });

  $('btnStyleToggle').addEventListener('click', () => {
    st.style = st.style === 'salon' ? 'native' : 'salon';
    localStorage.setItem(`${STORAGE_PREFIX}style`, st.style);
    render();
  });

  $('btnRawToggle').addEventListener('click', () => {
    st.showRaw = !st.showRaw;
    localStorage.setItem(`${STORAGE_PREFIX}raw`, st.showRaw ? '1' : '0');
    render();
  });

  $('btnLangToggle').addEventListener('click', () => {
    st.lang = st.lang === 'ko' ? 'en' : 'ko';
    localStorage.setItem(`${STORAGE_PREFIX}lang`, st.lang);
    render();
  });

  $('btnSettings').addEventListener('click', openSettings);
  $('btnCloseSettings').addEventListener('click', () => {
    st.settingsOpen = false;
    $('settingsDrawer').classList.add('hidden');
    renderHeaderControls();
  });
  $('btnClearKey').addEventListener('click', () => {
    st.clearApiKeyPending = true;
    $('setApiKey').value = '';
    updateCredSummary();
  });
  $('setApiKey').addEventListener('input', (ev) => {
    if (ev.target.value.trim().length > 0 && st.clearApiKeyPending) {
      st.clearApiKeyPending = false;
      updateCredSummary();
    }
  });
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('btnTestConn').addEventListener('click', testConnection);

  $('btnContextCap').addEventListener('click', () => {
    const idx = CONTEXT_CAPS.indexOf(st.contextCap);
    st.contextCap = CONTEXT_CAPS[(idx + 1) % CONTEXT_CAPS.length];
    localStorage.setItem(`${STORAGE_PREFIX}ctx_cap_v1`, String(st.contextCap));
    renderTelemetryDock();
  });

  $('btnRefreshQuota').addEventListener('click', () => {
    refreshQuota(true);
  });

  $('btnMeterToggle').addEventListener('click', () => {
    st.meterOpen = !st.meterOpen;
    localStorage.setItem(`${STORAGE_PREFIX}meter_open`, st.meterOpen ? '1' : '0');
    renderTelemetryDock();
    if (st.meterOpen) {
      st.lastMeterKey = '';
      if (st.activeMeterConvId) refreshContextMeter(st.activeMeterConvId, 'reopen');
      refreshQuota(false);
    }
  });

  document.addEventListener('visibilitychange', () => {
    pollState(false);
    schedulePoll();
    if (document.visibilityState !== 'hidden' && st.meterOpen) {
      refreshQuota(false);
    }
  });

  syncThemeScheme();
  renderHeaderControls();
  pollState(true).finally(schedulePoll);
  refreshQuota(false).finally(scheduleQuotaPoll);
})();
