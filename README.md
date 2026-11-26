# AGY SUITE (`agy-suite`)

**한국어 | [English](./README.en.md)**

반중력(Antigravity) 실사용 중 자주 겪는 **할당량·컨텍스트 불안, 잦은 재기동, 무한 멈춤, 세션 비대화, 기억 휘발**을 외부 의존성 `0개`의 정적 플러그인 3종으로 해결하는 모듈형 개선 키트입니다.

> **안내**: `AGY SUITE`는 기존 `AGY ORBIT`과 별개인 독립 저장소입니다. 필요한 플러그인만 골라 설치하고, Antigravity의 Customizations 화면에서 개별 스위치로 언제든 켜고 끌 수 있습니다.

---

## 이런 증상이 있다면 바로 해결됩니다

| 겪고 있는 문제 | 해결해 주는 플러그인 | 달라지는 점 |
| :--- | :--- | :--- |
| 남은 할당량(`5h`/주간)과 자동 압축까지 얼마나 남았는지 몰라 불안함 | **`agy-suite-hud`** | 오른쪽 사이드카에 모델별 압축 추정 게이지, 실제 KV 캐시 적중률, `5h`/주간 할당량 계기판을 띄워줍니다. |
| 에이전트나 스웜 워커가 지금 무슨 생각을 하는지 실시간으로 보고 싶음 | **`agy-suite-hud`** | 에이전트·스웜 워커별 추론 탭을 오프라인(`raw`) 기본 모드로 실시간 표시합니다. 창을 닫으면 부하가 `0`입니다. |
| 작업 중 에디터가 갑자기 재기동되거나 팬이 심하게 돌며 버벅임 | **`agy-suite-core`** | `/doctor`로 원인을 점검하고, 기존 주석을 보존한 채 백업(`.agy-bak-*`) 후 안전하게 설정을 패치합니다. |
| 명령 실행이나 서브에이전트 대기 중 끝없이 멈춰 있음 | **`agy-suite-core`** | 약 `1.2KB`의 경량 멈춤 방지 수칙(`rules/AGENTS.md`)으로 타임아웃과 워치독 습관을 고정합니다. |
| 오래된 대화방이 100개 넘게 쌓여 왼쪽 목록이 지저분함 | **`agy-suite-core`** | `/cleanup`으로 현재·실행 중·핀·별표 대화를 보호한 채 유휴 세션만 삭제 없이 안전하게 보관(`archived: true`)합니다. |
| 새 대화를 열 때마다 이전 맥락을 잊어버리거나, 여러 PC/외부 봇과 작업 메모를 나누고 싶음 | **`agy-suite-sync`** *(선택 / Labs)* | 캐시를 깨지 않는 2단 기억장(`MEMORY.md` + `MEMORY_ARCHIVE.md`), 선택형 비동기 Git 동기화, 무서버 `WORK_NOTES.md` 인박스를 제공합니다. |

---

## 3개의 독립 정적 플러그인

하나의 결정론적 설치기(`install.mjs`)가 사용자의 `~/.gemini/config/plugins/`에 최대 3개의 독립 플러그인을 설치합니다. 기본 설치(`hud,core`)에서는 외부 네트워크 전송이 `0바이트`이며, `sync`는 명시적으로 선택할 때만 설치됩니다.

1. **`agy-suite-hud` (`AGY SUITE — HUD`)**
   - 우측 사이드카(`sidecar://agy-suite-hud/hud_pane/`)에 에이전트 및 스웜 워커별 추론 탭과 하단 계기판 바를 제공합니다.
   - **모델군별 자동 보정 압축 추정치**: `Gemini (~515K)`, `Claude (~160K)`, `GPT-OSS (~100K)` 기준선을 분리 추적하며, 수동 `/compact` 직후의 `CHECKPOINT`와 실제 자동 압축을 구분합니다.
   - **실제 KV 캐시 적중률**: 트랜스크립트 사용량 메타데이터(`cache_read_tokens / (input_tokens + cache_read_tokens)`)를 그대로 표시합니다.
   - **Fail-Closed 할당량 게이지**: `5h` / `weekly` 잔여량을 표시하되, 최대 `10분` 만료 제한과 스키마 불일치 시 즉시 닫힘(`—`) 정책을 적용합니다.
   - 기본 모드는 완전 오프라인 `raw`이며, 원할 때만 설정에서 Gemini 1인칭 복원을 Opt-In 할 수 있습니다.
2. **`agy-suite-core` (`AGY SUITE — Core`)**
   - 읽기 전용 `/doctor` 환경 진단과 주석 보존형 JSONC 패처(`.agy-bak-*` 백업, `antigravity.heartbeatIntervalMs: 0`, `**/antigravity/**` 감시/검색 제외).
   - `/cleanup` 구형 유휴 세션 일괄 안전 아카이브(드라이런 기본, 삭제 API 호출 없음).
   - `~1.2KB` 초경량 멈춤 방지 수칙(`rules/AGENTS.md`) 및 `/setup` 안내.
3. **`agy-suite-sync` (`AGY SUITE — Memory & Bridge`, 선택 / Labs)**
   - 캐시 보존형 2단 기억장: 상시 로드되는 `MEMORY.md`(`9,500자` / `18KB` 이하 유지, 초과 시 `SessionStart` 경고) + 온디맨드 `MEMORY_ARCHIVE.md`.
   - **로컬 전용 모드(기본, Git 불필요)**와 **멀티 PC 비동기 Git 동기화 모드** 지원(변경 없는 턴은 스폰 `0회` 고속 통과, PID 생존 검증 락, `git merge-file` 3-way 병합, 푸시 직전 최후 안전망 시크릿 정규식 검사).
   - 선택형 무서버 마크다운 작업노트 인박스(`WORK_NOTES.md`, `worknote:done` 완료 영수증 기반).

---

## 4중 신뢰 방패 (Trust Shield) & 정직한 한계 고지

1. **외부 npm 패키지 의존성 `0개` (`dependencies: {}`, `devDependencies: {}`)**
   - `node_modules`가 없으며 Node.js `>= 18` 표준 내장 모듈(`node:*`)만 사용합니다.
2. **결정론적 CLI 및 자동 테스트가 1차 진실의 원천**
   - `npm test`, `node install.mjs --doctor`, `node install.mjs --dry-run`으로 변경 예정 사항과 안전성을 직접 검증할 수 있습니다. `INSTALL_FOR_AGENTS.md`는 편의용 래퍼일 뿐이며, 포크된 저장소의 프롬프트를 맹신하지 말고 직접 `npm test`와 `--dry-run` 출력을 확인하십시오.
3. **기본 오프라인 & 읽기 전용 우선**
   - `agy-suite-hud`의 기본 `raw` 모드와 `agy-suite-core`의 `/doctor`, `agy-suite-sync`의 로컬 전용 모드는 외부 네트워크로 단 `1바이트`도 전송하지 않습니다.
4. **비파괴 백업 및 원클릭 제거**
   - 설정을 수정할 때는 반드시 `.agy-bak-*` 백업을 만들고, `--uninstall --restore-backups`로 깔끔하게 되돌릴 수 있습니다. `~/.gemini/config/config.json`은 절대 수정하지 않습니다.

> **정직한 기술 고지 (Honest Disclosure)**
> - **100% 바이브 코딩 제작물**: 이 저장소의 코드·테스트·문서는 100% AI 에이전트와의 바이브 코딩으로 작성·검증되었습니다. 외부 모델 2패스 보안·품질 감사와 `52개` 자동 테스트를 거쳤지만, 실제 환경에 적용하기 전에는 반드시 `npm test`와 `--dry-run` 결과를 직접 확인하시고 사용하시기 바랍니다.
> - **속마음 1인칭 복원(Opt-In)의 원문 차이**: 기본 `raw` 모드는 추론 요약을 가공 없이 그대로 표시합니다. 다만 설정에서 선택형 **1인칭 독백 복원(`gemini` 모드)**을 켤 경우 번역 및 자연스러운 구어체 폴리싱 과정이 더해지므로, 출력 문장이 영문 원문 추론과 100% 직역 수준으로 일치하지 않을 수 있습니다(원문 그대로 보려면 기본 `raw` 모드를 사용하십시오).
> - **내부 규격 의존성**: `transcript_full.jsonl`, `agy -p /usage`, `ConversationService`, `antigravity.heartbeatIntervalMs`는 Antigravity의 비공개 내부 인터페이스에 의존하므로 향후 업데이트에 따라 동작이 달라질 수 있습니다. 이를 대비해 어댑터를 격리하고 파싱 실패 시 추측치를 띄우지 않는 `fail-closed` 방식으로 설계했습니다.
> - **Git 원격 동기화 신뢰 경계**: `MEMORY.md`는 `rules/`로 상시 로드되므로, 원격 저장소에 **푸시 권한이 있는 모든 주체는 완전 신뢰 대상**으로 간주해야 합니다(본인 단독 비공개 저장소만 사용). `GEMINI.md`는 기본값에서 **절대 동기화되지 않으며**, `sync/config.json`에서 `"syncGeminiMd": true`로 명시적 옵트인한 경우에만 추적됩니다. 충돌 복구가 필요할 때는 `memory-sync.mjs --resolve=local|remote`를 사용합니다.
> - **`WORK_NOTES.md` 보안 조건**: 외부 봇·모바일 연동(`workNotesEnabled: true`) 시 반드시 **신뢰할 수 있는 본인 단독 비공개 저장소** 또는 **`MEMORY.md`와 분리된 `WORK_NOTES` 전용 저장소**만 사용해야 하며, `/work-notes`는 외부 노트를 신뢰할 수 없는 데이터로 간주해 실행 전 사용자의 명시적 확인을 받습니다.
> - **시크릿 가드의 한계**: `agy-suite-sync`의 푸시 전 시크릿 정규식 검사는 실수 방지를 위한 **최후 안전망(best-effort)**이며, 상용 DLP 도구를 대체하지 않습니다.
> - **플랫폼 테스트 범위**: Windows 환경에서 1차 검증되었으며, macOS/Linux용 POSIX 어댑터는 호환성 지원 차원(as-is)으로 제공됩니다. 브라우저 자동 실행이 어려운 환경에서는 HUD 런처에 `--print-auth-url` 옵션을 사용할 수 있습니다.

---

## 빠른 시작 (Quick Start)

요구 사항: **Node.js `>= 18.0.0`**

### 방법 A: 반중력에 폴더째 던져서 대화형 설치 (편의 래퍼)

이 저장소를 클론하거나 압축을 푼 뒤 Antigravity 워크스페이스에 열고 아래 1줄을 입력하십시오. 에이전트가 먼저 `npm test`와 읽기 전용 `--doctor`를 실행한 뒤, 원하는 플러그인만 객관식으로 물어보고 `--dry-run` 확인 후 설치합니다.

```text
이 폴더의 INSTALL_FOR_AGENTS.md를 읽고, 먼저 package.json의 의존성 0개·scripts·테스트 파일을 직접 확인한 뒤 `npm test`와 읽기 전용 `node install.mjs --doctor --json`으로 내 PC를 진단해 줘. 그다음 내가 원하는 플러그인과 옵션만 물어보고 `--dry-run` 확인 후 안전하게 설치해 줘.
```

### 방법 B: 터미널에서 직접 결정론적 CLI 실행 (권장 검증 경로)

```bash
# 0. 저장소 클론
git clone https://github.com/BBsouS/agy-suite.git
cd agy-suite

# 1. 전체 자동 테스트 및 릴리스 감사 실행
npm test

# 2. 읽기 전용 환경 진단
node install.mjs --doctor

# 3. 변경 예정 사항 미리보기 (파일을 수정하지 않음)
node install.mjs --dry-run --modules=hud,core

# 4. 원하는 플러그인 설치 (예: hud + core, 또는 전체 hud,core,sync)
node install.mjs --modules=hud,core
# 전체 설치 + 설정 패치 + HUD 자동 열기 룰 포함 예시:
# node install.mjs --modules=hud,core,sync --apply-settings --auto-open-hud

# 5. 제거 (필요 시 백업 복원 포함)
node install.mjs --uninstall
# node install.mjs --uninstall --restore-backups
```

---

## 전문가 및 상세 문서 (Track 2 Docs)

- [아키텍처·캐시 수학·CLI 전체 레퍼런스 (`docs/EXPERT.md`)](./docs/EXPERT.md)
- [외부 봇·모바일·Obsidian 연동 가이드 (`docs/WORK_NOTES_BRIDGE.md`)](./docs/WORK_NOTES_BRIDGE.md)
- [OS별 트러블슈팅: AdGuard·PowerShell·macOS PATH·inotify (`docs/TROUBLESHOOTING.md`)](./docs/TROUBLESHOOTING.md)
- [에이전트용 설치 런북 (`INSTALL_FOR_AGENTS.md`)](./INSTALL_FOR_AGENTS.md)

## License

[MIT](./LICENSE)
