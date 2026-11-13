# 입고 지연 알림 · 목록 페이지 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** FASHION(LT) 미입고 주문 중 14영업일을 넘긴 것을 확장 전용 목록 페이지로 보여 주고, 새로 지연된 건이 생기면 크롬 알림을 띄운다.

**Architecture:** 순수 판정 로직은 `src/arrival-core.js`(node 테스트, SW 에선 `importScripts`). background SW 가 알람으로 유비샵 주문전표를 읽기 POST 해 판정·저장·알림·배지를 맡고, `pages/arrival.html` 이 storage 를 읽어 그린다. popup 에 스위치와 목록 버튼.

**Tech Stack:** Chrome MV3 (service worker `importScripts`, alarms, notifications, storage), node:test.

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-11-13-arrival-delay-design.md` 가 정본. 충돌하면 스펙을 따른다.
- 서비스워커엔 **DOMParser 가 없다** → HTML 파싱은 정규식/문자열 스캔만(`src/orderimport-core.js` 의 `oiTListAllRows` 를 재사용: SW 에서 `importScripts('orderimport-core.js')` 후 `globalThis.ubOi.oiTListAllRows`, node 에선 `require`).
- 쓰기 요청 금지. 유비샵은 `POST /jun/orderitem/orderItemList.do?tcode=order_item`(검색) 만, 외부는 공휴일 GET 만.
- 스위치 `ubArrivalWatch` 기본 **false**. false 면 조회·알림·배지 전부 안 한다(배지는 지운다).
- 임계값 `ARRIVAL_DAYS = 14`, 지연 = `elapsed > 14`.
- 상태 코드: 발주 전 `O--`(주문완료)·`OS-`(본사확인), 발주 후 `B--`(발주완료). 매장 `LT`.
- 공휴일: `GET https://sshwwwavcbgyiyojngav.supabase.co/functions/v1/holidays?year=YYYY` → `{year, days:{"YYYY-MM-DD":name}}`.
- 파일은 UTF-8. PowerShell Set-Content 금지(한글 깨짐). git commit/push 는 Advisor(메인)가 한다 — worker 는 하지 않는다.
- SHELL 배포 목록: 새 파일(`src/arrival-core.js`, `pages/arrival.html`, `pages/arrival.js`)을 `build-shell-index.ps1` 의 `$patterns` 와 `tests/loader-integrity.test.js` 의 `SHELL_PATTERNS` 에 **같은 순서로** 추가. 버전·빌드 실행은 메인이 한다.
- 다크모드 금지(`tests/no-darkmode.test.js` 가 새 파일도 검사하는지 확인하고 준수).

---

### Task 1: 판정 core (`src/arrival-core.js`)

**Files:**
- Create: `src/arrival-core.js`
- Test: `tests/arrival-core.test.js`

**Interfaces (Produces):** `globalThis.ubArrival` 와 `module.exports` 에 같은 객체:
- `arParseYmd(s) → 'YYYY-MM-DD' | null` — `'26-11-13'`(앞 8자) 또는 `'26-11-130000002Z02'` 같은 셀에서 첫 `YY-MM-DD` 를 20YY 로.
- `arRows(html) → [{orderSeq, junNum, orderDate, supplier, baljuDate, title, kind, product, qty, status}] | null` — 헤더 이름으로 열을 찾는다: '주문일'(주문일+주문장번호 셀), '발주처'(발주처명+발주일 셀, 없을 수 있음), '고객명'(상품코드/고객명 셀 → title), '구분', '상품정보', '수량', '상태'. 헤더를 못 찾으면 `null`(fail-closed). `orderSeq` = `row.idx` 의 콤마 앞(기존 `oiJunListRows` 와 같음), `junNum` = 주문일 셀 끝 `\d{7}[0-9A-Z]{3}`. 발주처 셀 `'키골드(F) 26-11-13'` → supplier `'키골드(F)'`, baljuDate `'2026-11-13'`; 날짜 없으면 baljuDate `null`.
- `arBizDaysAfter(baseYmd, todayYmd, holidaySet) → number` — base 다음 날부터 today 까지(포함) 토·일·공휴일을 뺀 날 수. today ≤ base 면 0.
- `arJudge(rows, {stage, todayYmd, holidaySet, days=14}) → items[]` — stage `'pre'`(O--·OS- 조회분) / `'post'`(B-- 조회분). 기준일 = pre → orderDate, post → baljuDate(없으면 orderDate + `baseFallback:true`). 각 item = row + `{stage, baseYmd, baseFallback, elapsed, key: orderSeq+'|'+stage}`. `elapsed > days` 인 것만 반환.
- `arSort(items) → items` — elapsed 내림차순, 같으면 orderDate 오름차순.
- `arNewKeys(currentKeys, notifiedKeys) → {fresh:[], nextNotified:[]}` — fresh = current 중 notified 에 없는 것. nextNotified = (notified ∩ current) ∪ fresh.

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/arrival-core.test.js`(node:test). 픽스처 HTML 은 실제 구조를 흉내 낸다: `<table class="t_list">` 안에 헤더 `<tr>`(셀: `No`,``,`주문일<br>주문장번호`,`발주처명<br>발주일`,`이미지`,`매입처상품코드<br>상품코드 / 고객명`,`구분`,`상품정보`,`수량`,`주문가`,`매장명(주문직원)`,`인도예정일`,`상태`,`수정/취소`)와 데이터 `<tr>`(두 번째 셀에 `<input type="checkbox" name="idx" value="9001,0000002Z02">`). 13열 변형(발주처 열 없음)도 하나. 반드시 덮을 것:
  - `arParseYmd('26-11-130000002Z02') === '2026-11-13'`, `arParseYmd('') === null`
  - 영업일: `arBizDaysAfter('2026-11-13','2026-11-13',S)===0`; 금요일 `2026-11-13` → 월 `2026-11-16` = 1; `2026-12-31`→`2027-01-04`(1/1 공휴일) = 1(1/4 만); 공휴일 Set 이 비면 주말만 뺀다.
  - 경계: elapsed 14 → 제외, 15 → 포함(days=14).
  - pre 는 orderDate 기준, post 는 baljuDate 기준, post 인데 baljuDate 없으면 orderDate + baseFallback true.
  - `arRows` 헤더 없는 HTML → `null`; 13열 → supplier '' · baljuDate null.
  - `arNewKeys(['a','b'],['b','c'])` → fresh `['a']`, nextNotified 에 `'a','b'` 만(‘c’ 제거).
- [ ] **Step 2:** `node --test tests/arrival-core.test.js` → 모듈 없음으로 FAIL 확인.
- [ ] **Step 3:** 구현. 파일 머리에 다른 core 들과 같은 형식의 주석 블록(목적·스펙 경로). UMD 꼴: `(function (root) { … const api = {…}; if (typeof module === 'object' && module.exports) module.exports = api; root.ubArrival = api; })(typeof globalThis !== 'undefined' ? globalThis : this);` 행 스캔은 `ubOi.oiTListAllRows`(SW: 전역, node: `require('./orderimport-core.js')`) 를 쓴다. 헤더 행 = `idx === null` 이고 셀에 '상태'·'주문일' 이 있는 행.
- [ ] **Step 4:** 테스트 PASS 확인.

### Task 2: background 배선 + 목록 페이지 + popup

**Files:**
- Modify: `src/background.js` (머리의 `importScripts('fsm.js')` 옆에 `importScripts('orderimport-core.js', 'arrival-core.js')` — 경로 기준은 SW 파일 위치 `src/`)
- Create: `pages/arrival.html`, `pages/arrival.js`
- Modify: `popup/popup.html`, `popup/popup.js` (스위치 `arrivalWatch` ↔ storage `ubArrivalWatch`, 버튼 '입고 지연 목록' → `chrome.tabs.create({url: chrome.runtime.getURL('pages/arrival.html')})`)
- Modify: `build-shell-index.ps1`, `tests/loader-integrity.test.js` (SHELL 목록)
- Test: `tests/arrival-wiring.test.js` (정적 검사)

**Interfaces (Consumes):** Task 1 의 `ubArrival.*`.
**Produces (storage):** `ubArrival = {at, ok, error, capped, holidaysOk, items}` · `ubArrivalNotified = [key…]` · `ubArrivalHolidays = {YYYY: {days, at}}` · `ubArrivalLastOk = ISO`.
**메시지:** 목록 페이지 → SW `{source:'ub', type:'arrivalRefresh'}` → 조회 후 `{ok, error}` 응답.

- [ ] **Step 1:** background 에 `arrivalCheck({force})` 구현:
  1. `ubArrivalWatch` false → 배지 지우고 return.
  2. force 가 아니면: 로컬 시각 09:00~19:00 이고 `ubArrivalLastOk` 에서 2시간 이상 지났을 때만.
  3. 공휴일: 올해·(today-365 의 해)·필요 연도별 캐시(과거 연도 영구, 올해·내년 7일 TTL). 실패 연도는 빈 Set + holidaysOk false.
  4. 상태 `O--`,`OS-`,`B--` 순차 POST(`credentials:'include'`, 30초 abort). 응답 URL 의 host 가 `ubshop.biz` 가 아니거나 path 가 `/jun/orderitem/orderItemList.do` 가 아니면 `error:'login'`. 본문은 arrayBuffer → `�` 가 20개 넘으면 `euc-kr` 로 다시 디코드(기존 skin 관례). `arRows` 가 null 이면 `error:'parse:<상태>'`. 500행이면 capped.
  5. 실패면 `ubArrival` 의 `ok:false,error,at` 만 갱신(items 는 직전 성공 유지), 알림 없음.
  6. 성공이면 judge(pre 두 상태 + post) → sort → 저장, `ubArrivalLastOk` 갱신, 배지(지연 수, 빨강 `#e0483f`; 단 `ubUpdateAvailable` 이 현재 버전보다 새로우면 'NEW' 유지), `arNewKeys` 로 fresh 가 있으면 `chrome.notifications.create('ub-arrival-' + Date.now(), {type:'basic', iconUrl:'icons/icon128.png', title:'입고 지연 새로 '+fresh.length+'건', message:'전체 '+items.length+'건 · 가장 오래된 것 '+items[0].elapsed+'영업일'})`, 그 뒤 `ubArrivalNotified = nextNotified`.
- [ ] **Step 2:** 알람 `ub-arrival` periodInMinutes 30 → `arrivalCheck({})`. `onStartup`·`onInstalled` → `arrivalCheck({})`. `chrome.storage.onChanged` 에서 `ubArrivalWatch` 가 true 로 바뀌면 `arrivalCheck({force:true})`, false 면 배지 지움. `notifications.onClicked` 에 id 가 `ub-arrival-` 로 시작하면 목록 탭 열기(기존 업데이트 알림 리스너는 그대로). 메시지 `arrivalRefresh` 처리.
- [ ] **Step 3:** 목록 페이지(스펙 §5 그대로): 머리 문구·마지막 확인 시각·상태 줄(login→'유비샵 로그인이 끊겨 확인하지 못했습니다 — 유비샵에 로그인한 뒤 [지금 다시 확인]', capped, holidaysOk false)·[지금 다시 확인]. 표 칸: 단계(발주 전/발주 후) · 경과 영업일 · 주문일 · 발주일(baseFallback 이면 '미확인') · 발주처 · 상품(title) · 수량 · 상태 · 주문장번호(링크 → `http://ubdstore.ubshop.biz/jun/orderitem/orderItemList.do?tcode=order_item` 새 탭). 스위치 OFF 면 안내만. `storage.onChanged` 로 자동 갱신. 인라인 스크립트 금지(MV3 CSP) — `arrival.js` 로. 텍스트는 `textContent` 로 넣는다(innerHTML 에 서버 문자열 금지).
- [ ] **Step 4:** popup 스위치·버튼(기존 `orderImport` 스위치와 같은 마크업·저장 방식, 기본값 객체에 `ubArrivalWatch: false` 추가).
- [ ] **Step 5:** SHELL 목록 갱신(Global Constraints).
- [ ] **Step 6:** `tests/arrival-wiring.test.js` — 소스 정적 검사: background 가 `ubArrivalWatch` false 에서 조회 전에 return · 쓰기 URL 패턴(`Write\.do|Delete\.do|Modify\.do|Standby|CurrentSetting`) 없음 · `importScripts` 에 arrival-core 포함 · 알림 id 접두 `ub-arrival-` 와 onClicked 처리 · popup 기본값 `ubArrivalWatch: false` · arrival.js 에 `innerHTML` 로 서버 문자열 대입 없음.
- [ ] **Step 7:** `node --check` 각 JS · `node --test tests/arrival-*.test.js tests/loader-integrity.test.js tests/no-darkmode.test.js tests/orderimport-*.test.js tests/orderitem-*.test.js` 전부 PASS(loader-integrity 는 빌드 전이라 dirty 판정으로 건너뛸 수 있음 — 출력 그대로 보고).

### Task 3 (메인): 공휴일 함수 허용 목록 · 검수 · 배포 · 라이브

- [ ] d102-atelier `supabase/functions/holidays/index.ts` `ALLOWED_ORIGIN_HOSTS` 에 `kejfpekfhpjlaifonfdlegmnoglaaphf` 추가 → 배포 → `curl -H "Origin: chrome-extension://kejfpekfhpjlaifonfdlegmnoglaaphf"` 200 확인.
- [ ] 검수 등급 판정·검수·원장.
- [ ] 버전 4.5.1 → `build-shell-index.ps1` → loader-integrity → 커밋·push.
- [ ] 이 PC 에서 확장 새로고침(사장님) → 스위치 ON → 목록 페이지를 유비샵 같은 조건 화면과 대조.
