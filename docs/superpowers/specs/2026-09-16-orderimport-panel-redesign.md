# 주문 가져오기 패널 리디자인 · 다크모드 제거 (2026-09-16)

사장님 요청: ① 주문 가져오기 팝업이 "세련되지도 직관적이지도 않고 폰트가 일관성이 없다" ② "불러온다는 내용이 없고 로딩 중 CSS 애니메이션이 없어 불편하다" ③ 다크모드는 패널에 넣지 말고 **확장 전체에서 걷어내라**.
브레인스토밍 확정: 사이드바와 같은 디자인 언어로 통일 · 한 표 유지(주문장 행 = 그룹 헤더) · 다크모드 없음.

## 1. 확정된 결정

| 결정 | 내용 | 근거 |
|---|---|---|
| 디자인 언어 | `src/skin.js` 사이드바 토큰을 그대로 쓴다: 시안 `#35C5F0`(hover `#2bb5e0`, soft `#e0f4fc`) · `--ub-bg #fff / --ub-bg2 #f7f9fc / --ub-fg #1b1b1b / --ub-sub #6b7280 / --ub-line #e5e7eb / --ub-soft #f9fafb` · Pretendard → 맑은 고딕 · 8/12px 그리드 · 이모지 없음(SVG) | 사장님 선택. 신규 토큰 0 |
| 폰트 불일치의 원인 제거 | 패널 안 **모든 `input/select/button/label` 에 `font: inherit`** + 패널 루트에 폰트 스택·`-webkit-font-smoothing: antialiased` | 지금은 폼 컨트롤이 브라우저 기본 UI 폰트로 찍혀 같은 행 안에서 글꼴이 갈린다 |
| (4.2.5 추가) 표 셀도 `font: inherit` | `#ub-oi-panel td, th { font: inherit }` | 4.2.4 배포 뒤에도 셀 안 글자·칩·입력칸이 돋움이었다(사장님 지적). 원인: 유비샵 `pamas_main.css` 의 `body,td{font-family:"돋움";font-size:12px}` 가 td 를 **직접** 때려 상속(패널 루트 Pretendard)을 이긴다. 폼 컨트롤은 `font: inherit` 라 td 의 돋움을 그대로 물려받았다. 하네스에 그 규칙을 넣어 재현(td 이하 전부 돋움 12px)·수정 후 전부 Pretendard 12.5px 확인 |
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
- 조회 중 갱신(`renderSoft`)은 **표(.oi-b)만** 다시 그리고 툴바(파일 input 포함)는 건드리지 않는다(열려 있던 파일 선택창의 input 이 떨어져 나가지 않게, Opus O1 P2-2). 포커스가 표 안 어디든(입력·셀렉트·체크박스·버튼) 있으면 표도 그리지 않고 스트립만 갱신한다(mousedown~mouseup 사이 표 교체로 클릭이 사라지지 않게, Opus O2 P2-B). 단계가 끝난 전체 렌더는 즉시 그린다 — 입력 중 값 1회 소실은 감수(지연 렌더는 focusout 꼬리 회귀로 철회, O2 P2-A).
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

## 5b. 중복 주문장 사전 경고 (사장님 추가 요청 2026-09-16)

"완전히 같은 주문번호와 제품이 있으면 사전에 경고해서 포함시킬지 말지 결정하게" — 지금은 장부에 있는 주문장이 '이전에 넣음' 글자만 달고 **체크된 채** 들어간다.

| 항목 | 내용 |
|---|---|
| 상품 서명 | `oiOrderSig(order)`(core, 순수): 줄마다 `norm(상품명)\|norm(옵션)\|수량`(norm = 공백 하나로·trim·소문자)을 만들어 정렬해 줄바꿈(`\n`)으로 이은 문자열 |
| 판정 | `oiDupCheck(order, entry)`(core, 순수) → `{dup, kind, entry}`: 장부 항목 없음 → `dup:false` · 항목에 `sig` 가 있고 같음 → `dup:true, kind:'same'` · 다름 → `dup:false, kind:'diff'`(주문번호는 같지만 상품이 다름 — 사은품 추가처럼 정상 재등록 가능, 기존 '이전에 넣음' 안내만) · 옛 항목(`sig` 없음) → `dup:true, kind:'legacy'`(보수적) |
| 장부 | `toRunOrder` 가 `sig` 를 실행 주문에 싣고, `oiRunOrder` 결과 `res.sig` → `oiPostRunState` 의 장부 항목(`done`·`unverified` 둘 다)에 `sig` 저장. 옛 항목은 그대로 |
| 기본 체크 | `refreshOrder`: 처음 판정할 때(`o.checked == null`) **와 판정 뒤 새로 중복이 된 순간**(다른 탭이 그 사이 등록 — 그때의 체크는 중복을 모르고 한 것, Opus O1 P2-5) `o.checked = o.ready && !dup`. 그 외엔 사용자의 체크가 우선(실행 불가면 해제) |
| 표시 | 중복 주문장 행에 빨간 칩 `이미 등록 2026-09-15 · 관리번호 0000002YF5 · 상품 동일`(미확인 항목이면 `이전 시도 미확인 · 사유`, legacy 면 `이미 등록(상품 대조 불가)`), 표 위 배너 "이미 등록된 것과 같은 주문장 N개는 체크를 풀어 두었습니다 — 다시 넣으려면 직접 체크하세요." |
| 일괄 체크 | 머리글 전체 체크는 **중복 주문장을 건너뛴다**(켜지도 끄지도 않음 — 개별 체크로만). 머리글 체크 상태도 중복을 뺀 실행 가능 주문장 기준. 배너는 실제 상태를 말한다: 전부 해제돼 있으면 "풀어 두었습니다", 켜진 것이 있으면 "N개 중 M개가 체크돼 있습니다 — 그대로 등록하면 중복" |
| 최종 확인 | [등록 시작] 확인창에 `※ 이미 등록된 것과 같은 주문장 N개가 포함돼 있습니다(중복 등록).` 한 줄 추가(N>0 일 때). 이번 실행의 결과가 있는 행은 결과 칩만 보이고 중복 칩·배너 집계에서 빠진다(방금 등록한 것이 '이미 등록'으로 겹쳐 보이지 않게) |
| 범위 밖 | 서버 쪽 중복 조회(주문전표 검색) — 장부는 PC 로컬이라 다른 PC 에서 넣은 것은 모른다(기존 설계 Q7 그대로) |

## 5c. 사은품은 판매가 0 으로 주문 (사장님 추가 요청 2026-09-16)

"사은품이라 표기된 항목은 판매가 0 이라도 주문이 되도록 — 유비샵에서도 판매가 0 으로 주문 가능." 지금은 `판매가 없음`(검토)·`판매가`(페이로드) 두 검사가 막는다.

- 파싱(`oiParseRows`): 상품명에 `사은품` 이 있으면 `gift:true`. 판매가가 비었으면 `0`, 있으면 `oiMoney0`(0 허용, 문자·소수·음수는 `null` → 검토). 일반 상품은 그대로 `oiMoney`(0 은 null).
- 페이로드(`oiLinePayload`): `spec.gift && spec.price === 0` 만 통과 → `orderPrice "0"`. 일반 상품 0 은 여전히 차단.
- UI: `toRunOrder` 가 `gift` 를 스펙에 싣고, 판매가 칸 편집은 사은품이면 `oiMoney0`(0 허용).
- 완료 대조(`oiCheckFinal`)의 주문가 비교는 서버 행이 `0` 을 돌려준다는 전제(미실측 — 다르면 되돌리기로 fail-closed, 라이브에서 확인).

## 6. 테스트

- `tests/orderimport-wiring.test.js` 에 추가: 패널 CSS 에 `font: inherit` 규칙(input/select/button) · 패널 마크업 문자열에 이모지 없음(`/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u` 0건) · `@media (prefers-reduced-motion: reduce)` 규칙 · 진행 스트립이 `S.phase` 별로 렌더되는 문자열 대조 · `render()` 가 여전히 실행 중 컨트롤 `disabled` 문자열을 유지(기존 테스트 그대로 통과).
- `tests/orderimport-progress.test.js`(신규, 순수): 진행 문구 매핑 함수 `oiStepLabel(step, info)`(core 로 뺀다) 와 enrich total 계산 `oiEnrichTotal(orders, masters)` — 스텁 데이터로 4~5 케이스.
- 다크모드 제거: `tests/phase5-switch-ui.test.js` 또는 신규 `tests/no-darkmode.test.js` — `src/*.js`·`popup/*` 에 `ub-dark|ubDark` 0건, popup 에 `id="dark"` 없음.
- 중복 경고(§5b): core 테스트 `oiOrderSig`(순서·공백·대소문자 무관, 수량 반영)·`oiDupCheck`(없음/same/diff/legacy) · `oiPostRunState` 가 `r.sig` 를 장부에 싣는다 · UI 배선: `refreshOrder` 의 기본 체크 규칙, 전체 체크가 중복을 건너뜀, 확인창 문구.
- 렌더 확인(§28 게이트): 정적 목업 스크린샷(사장님 승인) → 구현 후 실제 xls 로 라이브 패널 스크린샷(데스크톱 1920 · 1366 두 폭).
- 검수 등급 **T2** — 표시가 대부분이지만 §5b 가 **어떤 주문장이 실행 집합에 들어가는지**(기본 체크·전체 체크·확인창)를 바꾼다(안전한 쪽으로지만 주문 도메인). 외부 1명(GLM, 최대 3라운드) + Opus 5 + 완료 직전 교차 1회. Fable 없음.

## 7. 범위 밖

실행 로직·판정·되돌리기 변경 · 사이드바 자체 리디자인 · 팝업 리디자인(다크 행 제거만) · 표 구조 변경(카드형) · 모바일 폭 대응(유비샵 자체가 데스크톱 전용).
