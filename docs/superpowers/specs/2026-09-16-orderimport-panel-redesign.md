# 주문 가져오기 패널 리디자인 · 다크모드 제거 (2026-09-16)

사장님 요청: ① 주문 가져오기 팝업이 "세련되지도 직관적이지도 않고 폰트가 일관성이 없다" ② "불러온다는 내용이 없고 로딩 중 CSS 애니메이션이 없어 불편하다" ③ 다크모드는 패널에 넣지 말고 **확장 전체에서 걷어내라**.
브레인스토밍 확정: 사이드바와 같은 디자인 언어로 통일 · 한 표 유지(주문장 행 = 그룹 헤더) · 다크모드 없음.

## 1. 확정된 결정

| 결정 | 내용 | 근거 |
|---|---|---|
| 디자인 언어 | `src/skin.js` 사이드바 토큰을 그대로 쓴다: 시안 `#35C5F0`(hover `#2bb5e0`, soft `#e0f4fc`) · `--ub-bg #fff / --ub-bg2 #f7f9fc / --ub-fg #1b1b1b / --ub-sub #6b7280 / --ub-line #e5e7eb / --ub-soft #f9fafb` · Pretendard → 맑은 고딕 · 8/12px 그리드 · 이모지 없음(SVG) | 사장님 선택. 신규 토큰 0 |
| 폰트 불일치의 원인 제거 | 패널 안 **모든 `input/select/button/label` 에 `font: inherit`** + 패널 루트에 폰트 스택·`-webkit-font-smoothing: antialiased` | 지금은 폼 컨트롤이 브라우저 기본 UI 폰트로 찍혀 같은 행 안에서 글꼴이 갈린다 |
| 표 구조 | 한 표 유지. 주문장 행 = 그룹 헤더, 줄 행 = 데이터 행. 헤더 sticky | 사장님 선택(스크롤 적고 훑기 좋음) |
| 로딩 표시 | 툴바 아래 **진행 스트립** 하나로 세 단계(파일 읽기·유비샵 조회·등록)를 표시 + 조회 중인 셀은 스켈레톤, 등록 중인 주문장 행은 스피너 칩 | 요청 ② |
| 다크모드 | 패널 다크 없음. 확장 전체 다크모드 제거(§5) | 사장님 지시 |
| 실행·게이트 로직 불변 | `run/runTargets/enrich/onClick/onChange` 의 게이트(`S.running`·`S.starting`·`S.enriching`)와 `data-*` 배선 문자열은 그대로. 바뀌는 것은 CSS·마크업·진행 상태 표시뿐 | 기존 배선 테스트(`orderimport-wiring.test.js`)가 그 문자열을 고정하고 있고, 쓰기 경로에 손대지 않기 위해 |

## 2. 화면 구조

```
┌ 헤더 ─────────────────────────────────────────────────────────────┐
│ 주문 가져오기   ① 파일 → ② 검토 → ③ 등록   (현재 단계 시안, 지난 단계 ✓)      ✕ │
├ 툴바(sticky) ─────────────────────────────────────────────────────┤
│ [xls 선택]  확장주문검색_….xls · 주문장 10 · 줄 11 · 실행 가능 2 · 체크 2    [등록 시작] 매핑표 내보내기 · 가져오기 · 로그 JSON │
├ 진행 스트립(단계 중일 때만) ───────────────────────────────────────┤
│ ◌ 유비샵 조회 중 — 상품 3/5 · 고객 2/10 · 추천 4/11   ▓▓▓▓▓░░░░ 9/26      │
├ 표 ─────────────────────────────────────────────────────────────────┤
│ ☐ | 판매처 · 주문번호 | 고객명 · 휴대폰 | 유비샵 상품 | 품위 | 색상 | 사이즈 | 수량 | 판매가 | 비고 │
│ ▍GS샵 3472722134 | 손○정2287/G 0504-… | [신규 등록]                                   ← 그룹 헤더(bg2, 좌측 3px 시안 바)
│    14K, 18K 큐 라인 … [18K-옐로우골드-13호] ⚠ 상품 미매칭 | [— 유비샵 상품 선택 —][검색] | 18 | YG | 13 | 1 | 473,000 | 정산 331,… │
│ …                                                                        │
├ 결과(실행 후) ───────────────────────────────────────────────────────┤
│ 결과 — 완료 2 · 건너뜀/중단 0   표(주문장·상태 칩·사유·고객·관리번호·되돌림)         │
└──────────────────────────────────────────────────────────────────┘
```

- 헤더 단계 표시: `S.phase`/데이터로 결정 — 파일 없음 → ① 강조, 파일 있음(검토) → ②, 실행 중/결과 있음 → ③.
- 툴바의 파일 입력은 네이티브 위젯을 숨기고 `<label class="oi-btn">xls 선택<input type=file hidden></label>` 로. 파일명은 요약 칩에.
- 툴바 secondary 버튼(매핑표 내보내기/가져오기·로그 JSON)은 테두리 없는 조용한 버튼(`.oi-btn.quiet`).

## 3. 진행 상태 모델

`S.phase ∈ {'idle','reading','enriching','running'}` · `S.progress = { done, total, label }`.

| 단계 | 진입/종료 | 스트립 | 표 |
|---|---|---|---|
| reading | `loadFile` 시작 → `buildOrders` 직전 | 스피너 + "xls 읽는 중…" + 불확정 바(왕복 애니메이션) | 이전 표 유지(파일 재선택 시) 또는 빈 상태 문구 |
| enriching | `enrichBody` 시작 → 종료(finally) | 스피너 + "유비샵 조회 중 — 상품 a/A · 고객 b/B · 추천 c/C" + 확정 바(done/total). total = 조회할 마스터 seq 수 + 고객 조회 대상 주문장 수 + 추천 대상 줄 수, 요청 하나 끝날 때마다 done+1, `render()` 는 300ms 스로틀 | 고객 칩 자리·상품 셀렉트 자리에 **스켈레톤**(회색 바 shimmer) — 해당 항목이 아직 조회 전일 때만(`o.customer == null` / `l.suggest == null && !l.mapping`) |
| running | `runTargets` 시작 → 종료 | 진행 바 n/N(주문장) + "GS샵 3472722134 · 고객 확인 / 줄 1/2 등록 / 완료 / 전표 조회" + 굵은 경고 "이 창과 유비샵 주문 화면을 조작하지 마세요" | 현재 주문장 행에 스피너 칩 "등록 중", 끝난 행에 상태 칩(완료/건너뜀/중단), 대기 행은 그대로 |
| idle | 그 외 | 없음 | 없음 |

- 단계 문구는 `runTargets` 의 `log` 훅(`logLine(key, step, info)`)에서 온다: `guard/client/register → '고객 확인'`, `line → '줄 i/n 등록'`, `complete → '완료 요청'`, `junlist/findJun → '전표 조회'`, `fail/rollback → '되돌리는 중'`. 매핑에 없는 step 은 마지막 문구 유지.
- 스피너·shimmer·불확정 바는 CSS `@keyframes`(transform/opacity 만). `@media (prefers-reduced-motion: reduce)` 면 애니메이션 정지(정적 표시).
- 진행 스트립은 `render()` 가 그린다(별도 DOM 아님). `S.running` 중 `render()` 호출 빈도는 지금과 같다(onOrder 마다) + 진행 문구 갱신을 위해 `log` 훅에서 스트립 요소만 `textContent` 로 갱신(표 재렌더 없음 — 입력 중 값 소실·깜빡임 방지).

## 4. 스타일 규격

- 패널: `inset:24px`, 흰 배경, `border-radius:12px`, `box-shadow: 0 8px 24px rgba(15,20,25,.12)`, 헤더/툴바 `--ub-bg2`. 베일 `rgba(15,20,25,.45)`.
- 타이포: 13px/1.45 본문, 12px 보조(`--ub-sub`), 헤더 제목 15px/700. 숫자 셀 `font-variant-numeric: tabular-nums`, 우측 정렬(수량·판매가).
- 버튼: 높이 32px, `border-radius:8px`, primary = 시안 배경 흰 글자 700, secondary = 흰 배경 `--ub-line` 테두리, quiet = 테두리 없음 `--ub-sub` 글자, hover 는 사이드바와 같은 규칙(테두리·글자 시안, `--ub-on-soft` 배경). `:focus-visible` 2px 시안 링. disabled 는 opacity .45.
- 입력칸: 높이 28px, `border-radius:6px`, `--ub-line` 테두리, focus 시안 테두리+링. 열 너비 고정: 체크 32 · 품위 56 · 색상 64 · 사이즈 56 · 수량 48 · 판매가 88 · 비고 나머지(최소 160).
- 표: `border-collapse: separate; border-spacing:0`, 헤더 `position: sticky; top: 0`(툴바 아래), 행 구분은 하단 1px `--ub-line`. 그룹 헤더 행: `--ub-bg2` 배경, 좌측 3px 시안 바(첫 셀 `box-shadow: inset 3px 0 0 var(--ub-on)`), 판매처·주문번호 700. 문제 있는 그룹(실행 불가)은 좌측 바 빨강 `#e0483f`. 줄 행: 흰 배경, 이슈 있으면 좌측 바 노랑 `#f0c36d` + 이슈 문구 `#b42318` 600. 상품명 아래 옵션 텍스트 `--ub-sub`.
- 칩(`.oi-chip`): 높이 20px, 12px/600, `border-radius:999px`. 종류: 재사용(시안 soft) · 신규 등록(회색 soft) · 휴대폰 비움(노랑 soft) · 조회 실패(빨강 soft) · 완료 `#12995a` soft · 건너뜀 `#c77a12` soft · 중단 `#e0483f` soft · 등록 중(스피너 + 시안).
- 상태줄 색상은 사이드바와 동일: ok `#12995a` · warn `#c77a12` · err `#e0483f` · go `--ub-on`.
- 아이콘(인라인 SVG, `currentColor`, 1.5px 스트로크): 스피너(원호), 체크, 경고 삼각, 닫기 ✕, 파일. 이모지 0.
- 접근성: 닫기·매핑 지우기 등 아이콘 버튼에 `aria-label`, 진행 스트립에 `role="status" aria-live="polite"`, 체크박스 라벨 클릭 가능.

## 5. 다크모드 제거 (확장 전체)

| 위치 | 제거 |
|---|---|
| `popup/popup.html` | "디자인" 그룹 제목 + "다크 테마" 행(`#dark`) |
| `popup/popup.js` | `D.ubDark`, `dark` 참조 4곳(선언·render·disabled 목록·change 리스너) |
| `src/skin.js` | 머리말 `ubDark` 설명, `DEFAULTS.ubDark`, `DARK_STYLE_ID/DARK_CSS/ensureDarkStyle/applyDark` 와 init 의 `applyDark()` 호출, 사이드바 `html.ub-dark .ub-sidebar {…}` 토큰 블록, 매입처 라이브필터의 `html.<scope>.ub-dark …` 규칙 6개 + 🔴 주석, 본사확인 버튼의 `html.ub-dark a.<HQ_STANDBY_CLS>` 규칙 |
| 저장소 값 `ubDark` | 아무 데서도 읽지 않으므로 그대로 둔다(정리하지 않음 — YAGNI) |

제거 후 `grep -n "ub-dark\|ubDark"` 가 `src/`·`popup/` 에서 0건이어야 한다(테스트로 고정).

## 6. 테스트

- `tests/orderimport-wiring.test.js` 에 추가: 패널 CSS 에 `font: inherit` 규칙(input/select/button) · 패널 마크업 문자열에 이모지 없음(`/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u` 0건) · `@media (prefers-reduced-motion: reduce)` 규칙 · 진행 스트립이 `S.phase` 별로 렌더되는 문자열 대조 · `render()` 가 여전히 실행 중 컨트롤 `disabled` 문자열을 유지(기존 테스트 그대로 통과).
- `tests/orderimport-progress.test.js`(신규, 순수): 진행 문구 매핑 함수 `oiStepLabel(step, info)`(core 로 뺀다) 와 enrich total 계산 `oiEnrichTotal(orders, masters)` — 스텁 데이터로 4~5 케이스.
- 다크모드 제거: `tests/phase5-switch-ui.test.js` 또는 신규 `tests/no-darkmode.test.js` — `src/*.js`·`popup/*` 에 `ub-dark|ubDark` 0건, popup 에 `id="dark"` 없음.
- 렌더 확인(§28 게이트): 정적 목업 스크린샷(사장님 승인) → 구현 후 실제 xls 로 라이브 패널 스크린샷(데스크톱 1920 · 1366 두 폭).
- 검수 등급 **T1** — 런타임 표시 전용, 쓰기 경로·게이트 무변경, 되돌리기 쉬움(push 로 원복). 외부 1명(Luna) 최대 2라운드, Opus 5 생략.

## 7. 범위 밖

실행 로직·판정·되돌리기 변경 · 사이드바 자체 리디자인 · 팝업 리디자인(다크 행 제거만) · 표 구조 변경(카드형) · 모바일 폭 대응(유비샵 자체가 데스크톱 전용).
