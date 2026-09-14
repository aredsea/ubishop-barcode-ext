# 판매처 주문 가져오기 구현 플랜 (2026-09-14)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이지어드민 `확장주문검색` xls 를 유비샵 판매처 주문 화면 사이드바에 올리면, 확장이 고객 검색/등록 → 상품 줄 등록 → 주문장 완료를 주문장 단위로 대신한다.

**Architecture:** 순수 함수 모듈(`orderimport-core.js`, node 테스트)이 파싱·정규화·매칭·페이로드·판정·실행 오케스트레이션을 맡고, 얇은 어댑터(`orderimport-erp.js`)가 유비샵 fetch 만 담당한다. UI(`orderimport.js`)는 사이드바 버튼 → 패널(파일 → 검토 표 → 실행 → 결과). xls 는 SheetJS 를 패널 첫 오픈 때 MAIN world 에 주입해 읽는다. 배포 채널은 SHELL(ExtSync).

**Tech Stack:** Chrome MV3 확장(ISOLATED content_script + background `chrome.scripting`), SheetJS CE 0.20.3(Apache-2.0, `vendor/`), `chrome.storage.local`, node 내장 `node:test`.

**스펙:** `docs/superpowers/specs/2026-09-14-orderimport-design.md` (§ 번호는 그 문서 기준)

## Global Constraints

- 유비샵 쓰기 계약은 스펙 §4.2 그대로(2026-09-14 실제 주문 4건으로 검증). 필드 이름·URL 을 바꾸지 않는다.
- 폼 hidden 은 **HTML 문자열 정규식**으로 뽑는다(DOMParser `form.elements` 가 hidden 을 놓치는 함정). `sKey` 는 매 쓰기 직전 GET 에서 새로 받는다.
- 쓰기 판정 = 리다이렉트 URL `msg` 빈값 **그리고** 상태 변화(목록 행 수·세션). 페이지에 박힌 `alert` 문구는 판정에 쓰지 않는다.
- "열린 주문장" 판정은 **파라미터 없는 GET**(`orderItemWriteForm.do?tcode=order_item&pageSize=20&searchSortType=seq`)으로만.
- 인도예정일(form10 `exdelived*`)은 **오늘로 명시**(HTML 에 selected 가 없어 추출값이 01/01).
- 새 파일은 전부 SHELL 채널: `build-shell-index.ps1` patterns 에 넣지 않으면 매장 PC 에 배포되지 않는다.
- manifest `version` 4.1.9 → **4.2.0**(patch>9 규칙). 배포 절차는 README 의 "껍데기 수정" 그대로: 버전 올림 → `pwsh build-shell-index.ps1` → `node tests/loader-integrity.test.js` → push.
- 검수 등급 **T3**(실행 코드 + 라이브 쓰기). 전역 지침의 검증 순서·검수자 선임·원장(`docs/REVIEW-LEDGER.md`) 규칙을 따른다.
- 픽스처의 이름·전화는 가명(`가나다`, `010-0000-xxxx`). 실제 고객 정보를 저장소에 넣지 않는다.
- 테스트 파일·한글 소스는 **PowerShell `Set-Content` 로 편집하지 않는다**(한글 깨짐). Write/Edit 도구 또는 node 로 쓴다.
- 코드 스타일: 기존 파일과 같이 2칸 들여쓰기·세미콜론·작은따옴표, 한글 주석에 "왜" 를 적는다.

## 파일 구조

| 파일 | 상태 | 책임 |
|---|---|---|
| `src/orderimport-core.js` | 신규 | 순수 함수(파싱·정규화·옵션·매핑·추천·묶기·검토·폼 추출·목록·페이로드·대조·실행기). node/브라우저 겸용(`module.exports` / `globalThis.ubOi`) |
| `src/orderimport-erp.js` | 신규 | 유비샵 fetch 어댑터(`globalThis.ubOiErp`) — 실행기가 쓰는 10개 함수 |
| `src/orderimport.js` | 신규 | 사이드바 버튼 위임 · 패널 UI · storage(매핑표·장부) · 실행 배선 |
| `src/orderimport-xls.js` | 신규 | MAIN world 브리지: postMessage 로 받은 ArrayBuffer → SheetJS → 행 배열 |
| `vendor/xlsx.full.min.js` | 신규 | SheetJS CE 0.20.3 full(952KB, sha256 고정) |
| `src/skin.js` | 수정 | `ubOrderImport` 기본값·`isOrderWrite()`·사이드바 섹션(버튼 `#ub-oi-open`) |
| `src/background.js` | 수정 | `ubOiInjectXls` 메시지 → `chrome.scripting.executeScript(MAIN, files)` |
| `manifest.json` | 수정 | orderItemWriteForm.do 전용 content_scripts 항목(erp → core → erp어댑터 → UI), version 4.2.0 |
| `popup/popup.html`, `popup/popup.js` | 수정 | 스위치 "주문 가져오기"(기본 ON) |
| `build-shell-index.ps1` | 수정 | patterns 에 새 파일 5개 + `src/erp.js` |
| `tests/orderimport-parse.test.js` | 신규 | core 1/2 단위 테스트 |
| `tests/orderimport-form.test.js` | 신규 | core 2/2 단위 테스트(HTML 픽스처) |
| `tests/orderimport-run.test.js` | 신규 | 실행기 배선 테스트(스텁 erp) |
| `tests/orderimport-wiring.test.js` | 신규 | manifest·background·shell 인덱스·popup·skin 배선 회귀 |
| `tests/fixtures/orderimport/*` | 신규(2개는 이미 커밋됨) | `rows-a.json` `rows-b.json`(가명 xls 행) + 합성 HTML 5종 |

---

### Task 1: core 1/2 — 파일 파싱·정규화·옵션·매핑·묶기·검토 판정

**Files:**
- Create: `src/orderimport-core.js`
- Test: `tests/orderimport-parse.test.js`
- Fixtures(이미 있음): `tests/fixtures/orderimport/rows-a.json`, `tests/fixtures/orderimport/rows-b.json`

**Interfaces:**
- Consumes: 없음(순수)
- Produces(`globalThis.ubOi` / `module.exports`):
  - `oiMarket(seller) → {name,suffix,clientJob}|null`
  - `oiHeaderMap(headerRow) → {idx:{seller,orderNo,name,option,price,settle,buyer,phone,qty,status}, missing:string[]}`
  - `oiNormPhone(raw) → {raw,phone,last4,ok}` · `oiClientName(buyer,last4,suffix) → string` · `oiMoney(v) → number|null` · `oiComma(n) → '17,000'` · `oiRemark(settle,suffix) → string`
  - `oiParseRows(rows) → {error:string|null, lines:Line[]}` — `Line = {row,seller,orderNo,market,buyer,phone,productName,optionText,price,settle,qty,status}`
  - `oiParseOption(text) → {k,color,itemSize,unresolved[],tokens[]}` · `oiColorFromCode(code,colorOpts) → 'WG'|null`
  - `oiNormName`, `oiMapKeys(productName,parsed) → string[]`, `oiLookupMap(map,keys) → {key,entry}|null`, `oiLearn(map,keys,entry,now) → newMap`, `oiSuggestQueries(productName) → string[]`
  - `oiGroupOrders(lines) → Order[]` — `Order = {key,seller,orderNo,market,buyer,phone,clientName,lines}`
  - `oiResolveK(k,kOpts) → option|null` · `oiLineIssues(line, {mapping,parsed,form}) → string[]`

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/orderimport-parse.test.js`


```js
/* =============================================================================
 *  orderimport-parse.test.js — 판매처 주문 가져오기 순수 함수 단위 테스트 1/2 (파일·정규화·옵션·매핑·묶기·검토).
 *  픽스처: tests/fixtures/orderimport/ (xls 행 배열은 실제 파일에서 뽑아 이름·전화만 가명 치환,
 *          HTML 은 2026-09-14 라이브 실측 마크업을 그대로 본뜬 합성본).
 *  스펙: docs/superpowers/specs/2026-09-14-orderimport-design.md §2·§4·§5
 *  실행: node --test tests/orderimport-parse.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'src', 'orderimport-core.js'));
const FX = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'orderimport', name), 'utf8');
const ROWS_A = JSON.parse(FX('rows-a.json'));   // 원본 양식(판매가 열 없음) 35행
const ROWS_B = JSON.parse(FX('rows-b.json'));   // 개선 양식(판매가 열 있음) 9행 + 합계 + 빈 행

/* ---------------------------------------------------------------- §2.1 헤더 */
test('oiHeaderMap: 열은 이름으로 찾고 순서·추가 열은 무관, 판매가 없으면 missing', () => {
  const b = C.oiHeaderMap(ROWS_B[0]);
  assert.deepEqual(b.missing, []);
  assert.equal(ROWS_B[0][b.idx.price], '판매가');
  assert.equal(ROWS_B[0][b.idx.phone], '수령자휴대폰');
  const a = C.oiHeaderMap(ROWS_A[0]);
  assert.deepEqual(a.missing, ['판매가']);
  const shuffled = ['수령자휴대폰', '판매가', '주문번호', '상품명', '옵션명', '판매처', '정산금액', '수령자이름', '수량'];
  const s = C.oiHeaderMap(shuffled);
  assert.deepEqual(s.missing, []);
  assert.equal(s.idx.qty, 8);
  assert.equal(C.oiHeaderMap([' 판 매 처 ', '주문번호']).idx.seller, 0, '헤더 공백은 무시');
});

test('oiParseRows: 개선 양식 9줄, 합계·빈 행 제외, 판매가·정산·마켓·휴대폰 정규화', () => {
  const r = C.oiParseRows(ROWS_B);
  assert.equal(r.error, null);
  assert.equal(r.lines.length, 9);
  const first = r.lines[0];
  assert.equal(first.row, 2);
  assert.equal(first.seller, 'GS샵'); assert.equal(first.market.suffix, 'G'); assert.equal(first.market.clientJob, '7');
  assert.equal(first.price, 125000); assert.equal(first.settle, 87500); assert.equal(first.qty, 1);
  assert.equal(first.phone.phone, '0504-0000-4166'); assert.equal(first.phone.last4, '4166');
  assert.equal(first.optionText, '[14K-옐로우골드-12호]');
  const r2 = C.oiParseRows(ROWS_A);
  assert.match(r2.error, /필수 열 없음: 판매가/);
  assert.deepEqual(C.oiParseRows([]).lines, []);
});

test('oiParseRows: 수량 열이 있으면 읽고, 판매가가 비면 null(검토 대상)', () => {
  const rows = [['판매처', '주문번호', '상품명', '옵션명', '판매가', '정산금액', '수령자이름', '수령자휴대폰', '수량'],
    ['쿠팡', '1', 'A', '', '', 100, '홍길동', '010-1234-5678', '2']];
  const r = C.oiParseRows(rows);
  assert.equal(r.lines[0].price, null);
  assert.equal(r.lines[0].qty, 2);
});

/* ------------------------------------------------------------- §2.2 정규화 */
test('oiNormPhone: 010/0504/1xx 하이픈 재구성, 그 외 ok:false', () => {
  assert.equal(C.oiNormPhone('01065783269').phone, '010-6578-3269');
  assert.equal(C.oiNormPhone('0504-2138-0399').phone, '0504-2138-0399');
  assert.equal(C.oiNormPhone('106-249-2567').phone, '106-249-2567');
  assert.equal(C.oiNormPhone('106 249 2567').last4, '2567');
  assert.equal(C.oiNormPhone('').ok, false);
  assert.equal(C.oiNormPhone('123').ok, false);
});

test('oiClientName / oiMarket / oiRemark', () => {
  assert.equal(C.oiClientName('장영주', '4492', '쿠'), '장영주4492/쿠');
  assert.equal(C.oiClientName(' 손*아 ', '0399', 'G'), '손*아0399/G');
  assert.deepEqual(C.oiMarket('스마트스토어'), { name: '스마트스토어', suffix: '스', clientJob: '5' });
  assert.deepEqual(C.oiMarket('ssg'), { name: 'SSG', suffix: 's', clientJob: '2' });
  assert.equal(C.oiMarket('11번가'), null, '표에 없는 판매처는 null(검토)');
  assert.equal(C.oiRemark(12133), '정산 12,133 원');
  assert.equal(C.oiRemark(44138, '/블루칼세도니'), '정산 44,138 원 /블루칼세도니');
  assert.equal(C.oiRemark(null, '/블루칼세도니'), '/블루칼세도니');
  assert.equal(C.oiRemark(null), '');
});

test('oiGroupOrders: 판매처+주문번호로 묶고 고객명을 만든다(박*정 3줄, 이지은 2줄)', () => {
  const g = C.oiGroupOrders(C.oiParseRows(ROWS_B).lines);
  assert.equal(g.length, 6);
  assert.equal(g[0].lines.length, 3); assert.equal(g[0].clientName, '카*타4166/G');
  const last = g[g.length - 1];
  assert.equal(last.lines.length, 2); assert.equal(last.clientName, '차카타2567/아');
  assert.deepEqual(last.lines.map((l) => l.optionText), ['[17호]', '[9호]']);
});

/* ---------------------------------------------------------------- §2.2 옵션 */
test('oiParseOption: 품위·색상·사이즈 분해, 못 푸는 토큰은 unresolved', () => {
  assert.deepEqual(C.oiParseOption('[14K-로즈골드-15호]'), { k: '14', color: 'PG', itemSize: '15', unresolved: [], tokens: ['14K', '로즈골드', '15호'] });
  assert.deepEqual(C.oiParseOption('[18K-옐로우골드-42cm]').itemSize, '42');
  assert.equal(C.oiParseOption('[18K-옐로우골드-42cm]').color, 'YG');
  assert.deepEqual(C.oiParseOption('[15호]'), { k: null, color: null, itemSize: '15', unresolved: [], tokens: ['15호'] });
  assert.deepEqual(C.oiParseOption('[14K-옐로우골드]').itemSize, null);
  const dia = C.oiParseOption('[14K-로즈골드-3푼-45cm]');
  assert.deepEqual(dia.unresolved, ['3푼']); assert.equal(dia.itemSize, '45');
  assert.deepEqual(C.oiParseOption('').tokens, []);
  assert.equal(C.oiParseOption('[리얼화이트-11호]').color, 'RW');
  assert.equal(C.oiParseOption('[925-11호]').k, '925');
});

test('oiColorFromCode: 코드 4번째 토막이 셀렉트에 있을 때만', () => {
  const opts = [{ value: 'WG' }, { value: 'PG' }];
  assert.equal(C.oiColorFromCode('F-NF-P-WG-UU-00DH', opts), 'WG');
  assert.equal(C.oiColorFromCode('F-AF-Z-XY-ZZ-004E', opts), null);
  assert.equal(C.oiColorFromCode('FNFPWGUU00DH', opts), null, '대시 없는 itemNum 은 못 쓴다');
  assert.equal(C.oiColorFromCode('', opts), null);
});

/* ---------------------------------------------------------------- §2.4 매핑 */
test('oiMapKeys / oiLookupMap / oiLearn: 2단 키, 사이즈 제외, 학습은 원본 불변', () => {
  const parsed = C.oiParseOption('[14K-옐로우골드-12호]');
  const keys = C.oiMapKeys('14K, 18K 샤인스키니 반지', parsed);
  assert.deepEqual(keys, ['14k,18k샤인스키니반지|14-YG', '14k,18k샤인스키니반지']);
  assert.deepEqual(C.oiMapKeys('Silver925 퓨어 컷팅 반지', C.oiParseOption('[11호]')), ['silver925퓨어컷팅반지']);
  const map0 = {};
  const map1 = C.oiLearn(map0, keys, { seq: '7777', code: 'T-R6-Q-YG-ZZ-0001', name: '샤인스키니R' }, '2026-09-14T00:00:00Z');
  assert.deepEqual(map0, {}, '원본은 그대로');
  assert.equal(map1[keys[0]].seq, '7777'); assert.equal(map1[keys[1]].learnedAt, '2026-09-14T00:00:00Z');
  const hit = C.oiLookupMap(map1, C.oiMapKeys('14K, 18K 샤인스키니 반지', C.oiParseOption('[14K-옐로우골드-14호]')));
  assert.equal(hit.key, keys[0], '사이즈만 다르면 1순위 키로 맞는다');
  const hit2 = C.oiLookupMap(map1, C.oiMapKeys('14K, 18K 샤인스키니 반지', C.oiParseOption('[18K-로즈골드-14호]')));
  assert.equal(hit2.key, keys[1], '품위·색상이 다르면 2순위(상품명) 키로 폴백');
  assert.equal(C.oiLookupMap(map1, ['없음']), null);
});

test('oiSuggestQueries: 괄호 안 우선 → 범주어 제거·공백 제거 → 토큰', () => {
  assert.deepEqual(C.oiSuggestQueries('14K, 18K 큐 라인 볼드 반지 (심플가드링R(대)2.3m)').slice(0, 2), ['심플가드링R(대)2.3m', '큐라인볼드']);
  assert.deepEqual(C.oiSuggestQueries('Silver925 퓨어 컷팅 반지'), ['퓨어컷팅', '퓨어', '컷팅']);
  assert.deepEqual(C.oiSuggestQueries('Silver925 이스키아 블루칼세도니 목걸이'), ['이스키아블루칼세도니', '이스키아', '블루칼세도니']);
  assert.deepEqual(C.oiSuggestQueries('[사은품] 가죽 트레이')[0], '가죽트레이');
  assert.deepEqual(C.oiSuggestQueries('Silver925 미니 트윈 스타 피어싱 (1개)')[0], '미니트윈스타');
  assert.deepEqual(C.oiSuggestQueries('14K,18K 핑크 로맨스 귀걸이')[0], '핑크로맨스');
});

/* ---------------------------------------------------------- §3.3 검토 판정 */
test('oiLineIssues: 미매칭·옵션 미해석·판매처 미등록·판매가 없음', () => {
  const line = C.oiParseRows(ROWS_B).lines[0];
  assert.deepEqual(C.oiLineIssues(line, { mapping: null, parsed: C.oiParseOption(line.optionText) }), ['상품 미매칭']);
  const ok = C.oiLineIssues(line, { mapping: { entry: { code: 'X' } }, parsed: C.oiParseOption(line.optionText) });
  assert.deepEqual(ok, []);
  const bad = Object.assign({}, line, { market: null, price: null });
  const issues = C.oiLineIssues(bad, { mapping: { entry: {} }, parsed: C.oiParseOption('[3푼]') });
  assert.ok(issues.some((s) => s.startsWith('판매처 미등록')));
  assert.ok(issues.includes('판매가 없음'));
  assert.ok(issues.some((s) => s.startsWith('옵션 해석 불가: 3푼')));
  const form = { kOpts: [{ value: '5', text: '925' }], colorOpts: [{ value: 'WG' }], defaults: { color: '' } };
  const kIssue = C.oiLineIssues(line, { mapping: { entry: { code: 'F-RF-I-WG-PA-00F6' } }, parsed: C.oiParseOption('[14K-옐로우골드-12호]'), form });
  assert.ok(kIssue.some((s) => s.startsWith('품위 옵션 없음: 14')));
  assert.ok(kIssue.some((s) => s.startsWith('색상 없음: YG')));
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/orderimport-parse.test.js`
Expected: FAIL — `Cannot find module '.../src/orderimport-core.js'`

- [ ] **Step 3: 구현** — `src/orderimport-core.js` (파일 전체. Task 2·3 이 `const api = {` 앞에 함수를 덧붙이고 api 목록을 바꾼다)


```js
/* =============================================================================
 *  orderimport-core.js — 판매처 주문 가져오기 **순수 함수** 모듈 (DOM·fetch·chrome 없음).
 *  ISOLATED content_script 로 orderItemWriteForm.do 에만 실리고, node 에서는 module.exports 로 테스트한다.
 *  스펙: docs/superpowers/specs/2026-09-14-orderimport-design.md §2·§3·§4·§5
 *  노출: 브라우저 → globalThis.ubOi, node → module.exports (fsm.js / erp.js 와 같은 방식).
 * ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- §2.3 마켓 */
  const MARKETS = Object.freeze({
    '쿠팡':      { suffix: '쿠', clientJob: '8' },
    '아몬즈':    { suffix: '아', clientJob: '18' },
    '카페24':    { suffix: '카', clientJob: '6' },
    'GS샵':      { suffix: 'G', clientJob: '7' },
    '스마트스토어': { suffix: '스', clientJob: '5' },
    'SSG':       { suffix: 's', clientJob: '2' },
    'G마켓':     { suffix: '지', clientJob: '13' },
    '지그재그':  { suffix: '지', clientJob: '17' },
    '옥션':      { suffix: '옥', clientJob: '14' },
    '카카오':    { suffix: 'K', clientJob: '11' },
    '롯데ON':    { suffix: '롯', clientJob: '10' },
    'H몰':       { suffix: 'H', clientJob: '4' },
    '퀸잇':      { suffix: '퀸', clientJob: '20' },
    '에이블리':  { suffix: '에', clientJob: '21' }
  });
  const MARKET_INDEX = {};
  Object.keys(MARKETS).forEach((k) => { MARKET_INDEX[k.replace(/\s+/g, '').toLowerCase()] = k; });

  //  판매처 문자열 → { name, suffix, clientJob } | null. 공백·대소문자만 무시(별칭 추측 없음 — 표에 없으면 검토).
  function oiMarket(seller) {
    const key = String(seller == null ? '' : seller).replace(/\s+/g, '').toLowerCase();
    const name = MARKET_INDEX[key];
    return name ? { name, suffix: MARKETS[name].suffix, clientJob: MARKETS[name].clientJob } : null;
  }

  /* --------------------------------------------------------------- §2.1 헤더 */
  const COLS = Object.freeze({
    seller: '판매처', orderNo: '주문번호', name: '상품명', option: '옵션명', price: '판매가',
    settle: '정산금액', buyer: '수령자이름', phone: '수령자휴대폰', qty: '수량', status: '상태'
  });
  const REQUIRED = ['seller', 'orderNo', 'name', 'price', 'buyer', 'phone'];

  //  첫 행(헤더) → 열 인덱스. 이름으로만 찾는다(순서·추가 열 무관). 공백은 무시.
  function oiHeaderMap(headerRow) {
    const cells = (headerRow || []).map((c) => String(c == null ? '' : c).replace(/\s+/g, ''));
    const idx = {};
    Object.keys(COLS).forEach((key) => { const i = cells.indexOf(COLS[key]); if (i >= 0) idx[key] = i; });
    const missing = REQUIRED.filter((k) => !(k in idx)).map((k) => COLS[k]);
    return { idx, missing };
  }

  /* ------------------------------------------------------------ §2.2 정규화 */
  //  숫자만 남긴 뒤 하이픈 재구성. 유비샵은 하이픈 형식으로 저장·검색한다(실측). 그 외 길이는 ok:false.
  function oiNormPhone(raw) {
    const text = String(raw == null ? '' : raw).trim();
    const digits = text.replace(/\D/g, '');
    let phone = '';
    if (digits.length === 11) phone = digits.replace(/^(\d{3})(\d{4})(\d{4})$/, '$1-$2-$3');
    else if (digits.length === 12) phone = digits.replace(/^(\d{4})(\d{4})(\d{4})$/, '$1-$2-$3');
    else if (digits.length === 10) phone = digits.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3');
    return { raw: text, phone, last4: digits.slice(-4), ok: !!phone };
  }

  function oiClientName(buyer, last4, suffix) {
    return String(buyer == null ? '' : buyer).trim() + String(last4 || '') + '/' + String(suffix || '');
  }

  //  '17,000' · 17000 · ' 17000 ' → 17000. 비었거나 숫자가 아니거나 0 이하면 null.
  function oiMoney(v) {
    if (v == null) return null;
    const s = String(v).replace(/[,\s원]/g, '');
    if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return n > 0 ? n : null;
  }
  function oiComma(n) { return String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  //  비고 = '정산 12,133 원' (+ ' ' + 매핑표 remarkSuffix). 정산금액이 없으면 접미만(없으면 빈 문자열).
  function oiRemark(settle, suffix) {
    const parts = [];
    if (settle != null && Number.isFinite(Number(settle)) && Number(settle) >= 0) parts.push('정산 ' + oiComma(settle) + ' 원');
    if (suffix) parts.push(String(suffix).trim());
    return parts.join(' ');
  }

  //  SheetJS header:1 행 배열 → 줄 목록. 합계 행·빈 행은 버린다. 첫 행이 헤더.
  function oiParseRows(rows) {
    if (!Array.isArray(rows) || !rows.length) return { error: '빈 파일', lines: [] };
    const hm = oiHeaderMap(rows[0]);
    if (hm.missing.length) return { error: '필수 열 없음: ' + hm.missing.join(', '), lines: [] };
    const lines = [];
    rows.slice(1).forEach((r, i) => {
      const row = Array.isArray(r) ? r : [];
      const cell = (k) => (k in hm.idx) ? String(row[hm.idx[k]] == null ? '' : row[hm.idx[k]]).trim() : '';
      const seller = cell('seller'), orderNo = cell('orderNo');
      if (!seller && !orderNo) return;                      // 빈 행·'합계' 행(판매처·주문번호가 없다)
      const qtyRaw = cell('qty');
      lines.push({
        row: i + 2,                                          // 엑셀 행 번호(헤더=1)
        seller, orderNo,
        market: oiMarket(seller),
        buyer: cell('buyer'),
        phone: oiNormPhone(cell('phone')),
        productName: cell('name'),
        optionText: cell('option'),
        price: oiMoney(cell('price')),
        settle: (k => (k in hm.idx) ? oiMoney(cell('settle')) : null)('settle'),
        qty: qtyRaw ? oiMoney(qtyRaw) : 1,
        status: cell('status')
      });
    });
    return { error: null, lines };
  }

  /* ------------------------------------------------------------ §2.2 옵션 */
  const COLOR_WORDS = Object.freeze({
    '로즈골드': 'PG', '핑크골드': 'PG', '핑크': 'PG',
    '옐로우골드': 'YG', '옐로골드': 'YG', '옐로우': 'YG', '옐로': 'YG',
    '화이트골드': 'WG', '화이트': 'WG',
    '리얼화이트': 'RW', '블랙': 'BK', '플래티넘': 'PT', '플레티넘': 'PT'
  });

  //  '[14K-로즈골드-15호]' → { k:'14', color:'PG', itemSize:'15', unresolved:[] }. 셀렉트 대조는 oiLinePayload 가 한다.
  function oiParseOption(text) {
    const out = { k: null, color: null, itemSize: null, unresolved: [], tokens: [] };
    let s = String(text == null ? '' : text).trim();
    if (!s) return out;
    s = s.replace(/^\[+/, '').replace(/\]+$/, '').trim();
    const tokens = s.split(/\s*-\s*/).map((t) => t.trim()).filter(Boolean);
    out.tokens = tokens;
    tokens.forEach((t) => {
      const tn = t.replace(/\s+/g, '');
      let m;
      if ((m = tn.match(/^(\d{2})[kK]$/))) { out.k = m[1]; return; }
      if (tn === '925' || /^silver925$/i.test(tn)) { out.k = '925'; return; }
      if (COLOR_WORDS[tn]) { out.color = COLOR_WORDS[tn]; return; }
      if ((m = tn.match(/^(\d+(?:\.\d+)?)(호|cm|CM|㎝)$/))) { out.itemSize = m[1]; return; }
      if (/^\d+(?:\.\d+)?$/.test(tn)) { out.itemSize = tn; return; }
      out.unresolved.push(t);
    });
    return out;
  }

  //  마스터 기본 색상이 비었을 때: 상품코드 4번째 토막(F-NF-P-WG-UU-00DH → WG)이 셀렉트에 있으면 그 값.
  function oiColorFromCode(code, colorOpts) {
    const seg = String(code == null ? '' : code).split('-')[3] || '';
    if (!/^[A-Z]{2}$/.test(seg)) return null;
    if (colorOpts && !colorOpts.some((o) => o.value === seg)) return null;
    return seg;
  }

  /* ------------------------------------------------------------- §2.4 매핑 */
  function oiNormName(s) {
    return String(s == null ? '' : s).replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')').toLowerCase();
  }
  //  키 1순위 '상품명|품위-색상'(사이즈 제외), 2순위 '상품명'. 옵션에 품위·색상이 없으면 2순위만.
  function oiMapKeys(productName, parsed) {
    const base = oiNormName(productName);
    const k = parsed && parsed.k ? parsed.k : '';
    const c = parsed && parsed.color ? parsed.color : '';
    const keys = [];
    if (k || c) keys.push(base + '|' + k + '-' + c);
    keys.push(base);
    return keys;
  }
  function oiLookupMap(map, keys) {
    for (const k of keys || []) if (map && map[k]) return { key: k, entry: map[k] };
    return null;
  }
  //  학습: 주어진 키 전부에 같은 항목을 쓴다(원본 map 은 건드리지 않고 새 객체).
  function oiLearn(map, keys, entry, now) {
    const next = Object.assign({}, map || {});
    const rec = Object.assign({}, entry, { learnedAt: now || new Date().toISOString() });
    (keys || []).forEach((k) => { next[k] = rec; });
    return next;
  }

  //  추천 검색어: 뒤 괄호 안 문자열(있으면 1순위) → 범주어 뺀 토큰 결합 → 토큰 하나씩. 전부 공백 제거.
  const CATEGORY_RE = /(silver925|실버925|14k\s*,\s*18k|14k|18k|반지|목걸이|귀걸이|팔찌|피어싱|이어커프|발찌|앵클릿|브로치|펜던트|\[사은품\]|사은품|\(\s*1\s*개\s*\)|\(\s*1\s*쌍\s*\))/gi;
  function oiSuggestQueries(productName) {
    const name = String(productName == null ? '' : productName).trim();
    const out = [];
    const paren = name.match(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/);
    if (paren && !/^\s*1\s*(개|쌍)\s*$/.test(paren[1])) out.push(paren[1].replace(/\s+/g, ''));
    const core = name.replace(paren ? paren[0] : /$^/, ' ').replace(CATEGORY_RE, ' ').replace(/[\[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
    if (core) {
      out.push(core.replace(/\s+/g, ''));
      core.split(' ').filter((t) => t.length >= 2).forEach((t) => out.push(t));
    }
    return out.filter((q, i, a) => q && a.indexOf(q) === i);
  }

  /* --------------------------------------------------------- §2.2 주문장 묶기 */
  function oiGroupOrders(lines) {
    const map = new Map();
    (lines || []).forEach((ln) => {
      const key = ln.seller + '|' + ln.orderNo;
      if (!map.has(key)) {
        map.set(key, {
          key, seller: ln.seller, orderNo: ln.orderNo, market: ln.market, buyer: ln.buyer, phone: ln.phone,
          clientName: ln.market ? oiClientName(ln.buyer, ln.phone.last4, ln.market.suffix) : '',
          lines: []
        });
      }
      map.get(key).lines.push(ln);
    });
    return [...map.values()];
  }

  //  품위 '14'/'18'/'925' → k 셀렉트 옵션(텍스트 '14K'/'18K'/'925' 대조). 없으면 null.
  function oiResolveK(k, kOpts) {
    if (!k) return null;
    const want = (k === '925') ? '925' : (k + 'K');
    const hit = (kOpts || []).find((o) => String(o.text).replace(/\s+/g, '').toUpperCase() === want) || (kOpts || []).find((o) => o.value === k);
    return hit || null;
  }

  /* ------------------------------------------------------ §3.3 검토 판정 */
  //  줄 하나의 문제 목록. resolved = { mapping, parsed, form:{kOpts,colorOpts,defaults} } (form 은 있을 때만 대조).
  function oiLineIssues(line, resolved) {
    const issues = [];
    if (!line.market) issues.push('판매처 미등록: ' + line.seller);
    if (!line.phone || !line.phone.ok) issues.push('휴대폰 형식: ' + (line.phone ? line.phone.raw : ''));
    if (!line.buyer) issues.push('수령자 없음');
    if (line.price == null) issues.push('판매가 없음');
    if (line.qty == null) issues.push('수량');
    const parsed = resolved && resolved.parsed;
    if (parsed && parsed.unresolved.length) issues.push('옵션 해석 불가: ' + parsed.unresolved.join(', '));
    if (!resolved || !resolved.mapping) issues.push('상품 미매칭');
    const form = resolved && resolved.form;
    if (form && parsed) {
      if (parsed.k && !oiResolveK(parsed.k, form.kOpts)) issues.push('품위 옵션 없음: ' + parsed.k);
      if (parsed.color && !(form.colorOpts || []).some((o) => o.value === parsed.color)) issues.push('색상 없음: ' + parsed.color);
    }
    if (form && parsed && !parsed.color && !(form.defaults && form.defaults.color)) {
      const fb = resolved.mapping ? oiColorFromCode(resolved.mapping.entry.colorFallback || resolved.mapping.entry.code, form.colorOpts) : null;
      if (!fb) issues.push('색상 없음(마스터 기본값 빈값)');
    }
    return issues;
  }

  const api = {
    MARKETS, COLS, REQUIRED,
    oiMarket, oiHeaderMap, oiNormPhone, oiClientName, oiMoney, oiComma, oiRemark, oiParseRows,
    oiParseOption, oiColorFromCode, oiNormName, oiMapKeys, oiLookupMap, oiLearn, oiSuggestQueries,
    oiGroupOrders, oiResolveK, oiLineIssues
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof globalThis !== 'undefined') { globalThis.ubOi = api; }
})();
```

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/orderimport-parse.test.js`
Expected: `ℹ pass 11` / `ℹ fail 0`

- [ ] **Step 5: 커밋**

```bash
git add src/orderimport-core.js tests/orderimport-parse.test.js
git commit -m "feat(주문 가져오기): core 1/2 — xls 행 파싱·휴대폰/고객명 정규화·옵션 분해·매핑표·주문장 묶기·검토 판정 + 단위 테스트 11건"
```

---

### Task 2: core 2/2 — 폼 추출·목록 파싱·페이로드·기대치 대조 (HTML 픽스처)

**Files:**
- Modify: `src/orderimport-core.js` (Task 1 의 `const api = {` 바로 앞에 삽입 + api 교체)
- Create: `tests/fixtures/orderimport/orderwrite-master.html`, `client-search.html`, `master-search.html`, `junlist.html`, `clientform.html`
- Test: `tests/orderimport-form.test.js`

**Interfaces:**
- Consumes: Task 1 의 `oiResolveK`, `oiColorFromCode`, `oiComma`
- Produces:
  - `oiSelectOptions(html,name) → [{value,text,selected}]|null` · `oiFieldValue(html,name) → string|null` · `oiExtractFields(html,names) → {values,missing}` · `oiExtractHidden(html) → [[name,value]…]` · `oiExtractArrays(html) → {arr_weight,arr_salePrice,arr_inputSupply}`
  - `oiTListRows(html) → [{cells,idx,html}]` · `oiWriteListRows(html) → [{orderSeq,tradeJun,code,remark,name,k,weight,color,size,qty,price}]` · `oiJunListRows(html) → [{orderSeq,junNum,title,status}]` · `oiClientSearchRows(html) → [{name,shop,phone,tel,seq}]` · `oiMasterSearchRows(html) → [{code,name,seq}]`
  - `FORM1_NAMES`(25) · `FORM10_NAMES`(23) · `oiReadWriteForm(html) → {values,missing,kOpts,colorOpts,arrays,rows,defaults}` · `oiReadForm10(html) → {values,missing,rows}`
  - `oiLinePayload(form, master, spec) → {fields:[[n,v]…],issues,values}` · `oiForm10Payload(values, today) → [[n,v]…]` · `oiSubmitResult(url) → {ok,msg}`
  - `oiCheckForm(form, {client,master,tradeJun,orderSeqs}) → {ok,reason}` · `oiCheckFinal(form, {client,tradeJun,orderSeqs,lines}) → {ok,reason}`

- [ ] **Step 1: HTML 픽스처 5개 작성** (2026-09-14 라이브 마크업을 본뜬 합성본 — 중첩 테이블·툴팁·`selected` 없는 인도예정일까지 재현)

`tests/fixtures/orderimport/orderwrite-master.html`

```html
<html><head><title>Struts Board</title></head><body>
<script language="javascript">
<!--
//중량 배열 정보
var arr_weight = new Array(0,0);
//판매가 배열 정보
var arr_salePrice = new Array(19000,0);
//입고공급가 배열 정보
var arr_inputSupply = new Array(4500,0);
var CONST_URL = "&reqPage=1" + "&pageSize=20" + "&searchSortType=seq" + "&tradeJun=141240" + "&payJun=" + "&shop=LT" + "&shopName=" + encodeURIComponent('FASHION') + "&client=123790" + "&clientName=" + encodeURIComponent('홍길동7748/아');
function checkForm(form) {
  if (form.itemNum.value == "") { alert("상품번호를 입력하세요! "); return false; }
  if (eval(qty) == 0) { alert("수량을 입력하세요! "); return false; }
  return movePageForm(form);
}
//-->
</script>
<form name="form1" action="/order/item/orderItemWrite.do?tcode=order_item" method="post" onsubmit="return checkForm(this);">
<input type="hidden" name="sKey" value="260914143005123">
<input type="hidden" name="pageSize" value="20">
<input type="hidden" name="searchSortType" value="seq">
<input type="hidden" name="tradeJun" value="141240">
<input type="hidden" name="payJun" value="">
<input type="hidden" name="shop" value="LT">
<input type="hidden" name="client" value="123790">
<input type="hidden" name="master" value="7083">
<input type="hidden" name="itemType" value="1">
<input type="hidden" name="inputPrice" value="4500">
<input type="hidden" name="orgOrderPrice" value="19000">
<table width="100%" border="0" cellspacing="0" cellpadding="0" class="tb_write">
<tr><th>매장</th><td><input type="text" name="shopName" value="FASHION" class="input_gray" readonly REQUIRED title="매장"></td>
<th>고객</th><td><input type="text" name="clientName" value="홍길동7748/아" class="input_gray" readonly><a href="javascript:checkClient('form1');"><img src="/images/com/btn_search.gif"></a></td>
<th>상품번호</th><td><input type="text" name="itemNum" value="FRFIWGPA00F6" class="input_gray" readonly><a href="javascript:checkMasterItem('form1');"><img src="/images/com/btn_search.gif"></a></td></tr>
<tr><th>중량</th><td><input type="text" name="weight" value="0" class="input_gray" readonly> g</td></tr>
</table>
<input type="hidden" name="doc" value="">
<input type="hidden" name="diaColor" value="">
<input type="hidden" name="clarity" value="">
<input type="hidden" name="surface" value="">
<table>
<tr><th>품위</th><td><select name="k" onChange="javascript:kchange();"><option value="5" selected>925</option></select></td></tr>
<tr><th>색상</th><td><select name="color" REQUIRED title="색상">
<option value="">- 색상 -</option>
<option value="3C">3C (화이트+옐로+핑크)</option>
<option value="BK">BK (블랙)</option>
<option value="PB">PB (핑크+블랙)</option>
<option value="PG">PG (핑크)</option>
<option value="PR">PR (핑크+리얼화이트)</option>
<option value="PT">PT (플래티넘)</option>
<option value="PW">PW (핑크+화이트)</option>
<option value="PY">PY (핑크+옐로우)</option>
<option value="RP">RP (리얼화이트+핑크)</option>
<option value="RW">RW (리얼화이트)</option>
<option value="WB">WB (화이트+블랙)</option>
<option value="WG" selected>WG (화이트)</option>
<option value="WP">WP (화이트+핑크)</option>
<option value="WR">WR (화이트+리얼화이트)</option>
<option value="WY">WY (화이트+옐로우)</option>
<option value="XY">XY (기타등)</option>
<option value="YB">YB (옐로우+블랙)</option>
<option value="YG">YG (옐로우)</option>
<option value="YP">YP (옐로우+핑크)</option>
<option value="YW">YW (옐로우+화이트)</option>
</select></td></tr>
<tr><th>사이즈</th><td><input type="text" name="itemSize" value="11" class="input" size="10"></td></tr>
<tr><th>수량</th><td><input type="text" name="orderQty" value="1" class="input" size="5" onClick="this.select();" onKeyDown="numberOnly(this);" REQUIRED title="수량"> 개</td></tr>
<tr><th>주문가</th><td><input type="text" name="orderPrice" value="19,000" class="input" size="12" onClick="this.select();" onKeyUp="changeComma(this,form1);" REQUIRED title="주문가"> 원</td></tr>
<tr><th>비고</th><td><textarea name="shopRemark" cols="60" rows="3" onFocus="this.style.borderWidth='1px'"></textarea></td></tr>
</table>
<input type="image" name="imageField22" src="/images/com/btn_save.gif" alt="등록하기">
</form>
<form name="form10" action="/jun/orderitem/orderItemJunWrite.do?tcode=order_item" method="post" onsubmit="return checkForm2(this);">
<input type="hidden" name="sKey" value="260914143005123">
<input type="hidden" name="pageSize" value="20">
<input type="hidden" name="searchSortType" value="seq">
<input type="hidden" name="tradeJun" value="141240">
<input type="hidden" name="payJun" value="">
<input type="hidden" name="shop" value="LT">
<input type="hidden" name="client" value="123790">
<input type="hidden" name="payBank" value="0">
<input type="hidden" name="payDia" value="0">
<table class="tb_write">
<tr><th>주문일</th><td><input type="text" name="txtOrderDate" value="26-09-14" class="input_gray" readonly></td></tr>
<tr><th>인도예정일</th><td>
<select name="exdelivedyear" gname="exdelived" class="input_gray" tabindex="10"><option value="2026">2026</option><option value="2027">2027</option><option value="2028">2028</option></select> /
<select name="exdelivedmonth" gname="exdelived" class="input_gray" tabindex="11"><option value="01">01</option><option value="02">02</option><option value="03">03</option><option value="04">04</option><option value="05">05</option><option value="06">06</option><option value="07">07</option><option value="08">08</option><option value="09">09</option><option value="10">10</option><option value="11">11</option><option value="12">12</option></select> /
<select name="exdelivedday" gname="exdelived" class="input_gray" tabindex="12"><option value="01">01</option><option value="02">02</option><option value="03">03</option><option value="14">14</option><option value="30">30</option></select></td></tr>
<tr><th>주문담당자</th><td><input type="text" name="regId" value="담당자" class="input_gray" readonly></td></tr>
<tr><th>거래전 미수금</th><td><input type="text" name="beforePrice" value="0" class="input_gray" readonly REQUIRED></td></tr>
<tr><th>총 결제금액</th><td><input type="text" name="payPrice" value="0" class="input_gray" readonly REQUIRED></td></tr>
<tr><th>거래후 미수금</th><td><input type="text" name="afterPrice" value="0" class="input_gray" readonly REQUIRED></td></tr>
<tr><th>카드</th><td><input type="text" name="payCard" value="0" class="input_gray" readonly REQUIRED></td></tr>
<tr><th>고금</th><td><input type="text" name="paySaleOldGold" value="0" class="input_gray" readonly REQUIRED></td></tr>
<tr><th>현금</th><td><input type="text" name="payCash" value="0" class="input_gray" readonly REQUIRED></td></tr>
<tr><th>홈플러스</th><td><input type="text" name="payCashPaper" value="0" class="input_gray" readonly REQUIRED></td></tr>
<tr><th>기타</th><td><input type="text" name="payEtc" value="0" class="input_gray" readonly REQUIRED></td></tr>
<tr><th>결제비고</th><td><textarea name="payRemark" cols="30" rows="2"></textarea></td></tr>
</table>
<input type="image" name="imageField23" src="/images/com/btn_junwrite.gif" alt="주문장 완료">
</form>
<form name="form2" action="/order/item/orderItemWriteForm.do?tcode=order_item" method="post">
<input type="hidden" name="tradeJun" value="141240">
<input type="hidden" name="payJun" value="">
<input type="hidden" name="shop" value="LT">
<input type="hidden" name="client" value="123790">
<select name="pageSize" onChange="form2.submit();"><option value="20" selected>20</option><option value="100">100</option></select>
<select name="searchSortType" onChange="form2.submit();"><option value="seq" selected>최근순</option></select>
</form>
<form name="form3" method="post">
<input type="hidden" name="sKey" value="260914143005123">
<table width="100%" border="0" cellspacing="0" cellpadding="0" class="t_list">
<tr class="bg_1"><td colspan="10" align="right" class="f_bold">합 계</td><td>1</td><td>17,000</td><td></td></tr>
<tr align="center" onMouseOver="this.style.backgroundColor='#EFEFEF'" onMouseOut="this.style.backgroundColor=''">
 <td>1</td>
 <td><input type="checkbox" name="idx" value="389463,141240"></td>
 <td><table width="65" border="0" cellpadding="0" cellspacing="0" style="table-layout:fixed;"> <tr> <td height="60" align="center" bgcolor="#FFFFFF" style="border-bottom-style:none;"> <img src="/upload/catalog/00032/8000/thumnail/s_7083.JPG" width="60" height="60" border="0" style="cursor:hand;" onClick="imageView(this.src);" onError="this.src='/images/com/no_image2.gif';this.width='50';this.height='50';" alt="클릭하시면 큰 이미지를 볼 수 있습니다."> </td> </tr> </table></td>
 <td> F-RF-I-WG-PA-00F6 <span style="display:none;"><div id="note_0" class="tooltip2"> <span class="f_bold">비고 : </span>정산 12,133 원<br> </div></span> </td>
 <td>상품</td>
 <td>F-퓨어컷팅(실버)R</td>
 <td>925</td>
 <td>0 g</td>
 <td>화이트</td>
 <td>11</td>
 <td>1</td>
 <td>17,000</td>
 <td><a href="javascript:modify('389463');"><img src="/images/com/icon_modi.gif" width="22" height="20" border="0"></a></td>
</tr>
</table>
</form>
</body></html>
```

`tests/fixtures/orderimport/client-search.html`

```html
<html><head><title>고객 검색</title></head><body>
<form name="form1" action="/etc/client.do?tcode=order_item" method="post" onsubmit="return movePageForm(this);">
<input type="hidden" name="formname" value="form1">
<input type="hidden" name="url" value="/order/item/orderItemWriteForm.do">
<input type="hidden" name="actFlag" value="1">
<input type="hidden" name="shop" value="LT">
<input type="hidden" name="shopName" value="FASHION">
<select name="searchWordType"><option value="clientName" selected>고객명</option><option value="phone">휴대폰번호</option></select>
<input type="text" name="searchWord" value="가나다">
<input type="hidden" name="clientName" value="가나다">
<input type="hidden" name="clientName" value="가나다3269/카">
<input type="hidden" name="clientName" value="라마바/가나다">
<input type="hidden" name="clientName" value="사아자/가나다">
<table width="100%" border="0" cellspacing="0" cellpadding="0" class="t_list">
<tr class="bg_1"><td>No</td><td>고객명</td><td>매장명</td><td>휴대폰(신부)</td><td>전화(신랑)</td><td>선택</td><td>수정/삭제</td></tr>
<tr align="center" onmouseover="this.style.backgroundColor='#EFEFEF'" onmouseout="this.style.backgroundColor=''"> <td height="28">5</td> <td align="left" class="f_bold">가나다</td> <td>FASHION</td> <td>010-0000-5544</td> <td></td> <td> <a href="javascript:setSeting(form1,'0','47996');" tabindex="2"><img src="/images/com/btn_enter.gif" width="23" height="20" align="absmiddle"></a> </td> <td> <a href="javascript:modify('47996');"><img src="/images/com/icon_modi.gif" width="22" height="20" border="0" align="absmiddle"></a> <a href="javascript:del('47996');"><img src="/images/com/icon_del.gif" width="22" height="20" border="0" align="absmiddle"></a> </td> </tr>
<tr align="center" onmouseover="this.style.backgroundColor='#EFEFEF'" onmouseout="this.style.backgroundColor=''"> <td height="28">4</td> <td align="left" class="f_bold">가나다3269/카</td> <td>FASHION</td> <td></td> <td></td> <td> <a href="javascript:setSeting(form1,'1','123752');" tabindex="2"><img src="/images/com/btn_enter.gif" width="23" height="20" align="absmiddle"></a> </td> <td> <a href="javascript:modify('123752');"><img src="/images/com/icon_modi.gif"></a> </td> </tr>
<tr align="center" onmouseover="this.style.backgroundColor='#EFEFEF'" onmouseout="this.style.backgroundColor=''"> <td height="28">3</td> <td align="left" class="f_bold">라마바/가나다</td> <td>누리엔점</td> <td>010-0000-2558</td> <td>010-0000-9202</td> <td> <a href="javascript:setSeting(form1,'2','123521');" tabindex="2"><img src="/images/com/btn_enter.gif"></a> </td> <td></td> </tr>
<tr align="center" onmouseover="this.style.backgroundColor='#EFEFEF'" onmouseout="this.style.backgroundColor=''"> <td height="28">2</td> <td align="left" class="f_bold">사아자/가나다</td> <td>누리엔점</td> <td>010-0000-0515</td> <td>010-0000-1938</td> <td> <a href="javascript:setSeting(form1,'3','120001');" tabindex="2"><img src="/images/com/btn_enter.gif"></a> </td> <td></td> </tr>
</table>
</form>
</body></html>
```

`tests/fixtures/orderimport/master-search.html`

```html
<html><head><title>기초 상품 검색</title></head><body>
<form name="form1" action="/etc/orderMasterItem.do?tcode=order_item" method="post" onsubmit="return checkForm(this);">
<input type="hidden" name="formname" value="form1">
<input type="text" name="searchWord2" value="퓨어컷팅">
<table width="100%" border="0" cellspacing="0" cellpadding="0" class="t_list">
<tr class="bg_1"><td>No</td><td>이미지</td><td>상품코드</td><td>구분</td><td>상품명</td><td>선택</td></tr>
<tr align="center"> <td>4</td> <td><table width="65" border="0"><tr><td><img src="/upload/catalog/00032/8000/thumnail/s_7083.JPG" width="60" height="60"></td></tr></table></td> <td>F-RF-I-WG-PA-00F6</td> <td>상품</td> <td align="left">F-퓨어컷팅(실버)R</td> <td><a href="javascript:setSeting('7083');"><img src="/images/com/btn_enter.gif"></a></td> </tr>
<tr align="center"> <td>3</td> <td><table width="65" border="0"><tr><td><img src="/images/com/no_image.gif"></td></tr></table></td> <td>F-RF-I-PG-ZZ-00AY</td> <td>상품</td> <td align="left">F-볼드퓨어컷팅</td> <td><a href="javascript:setSeting('6156');"><img src="/images/com/btn_enter.gif"></a></td> </tr>
<tr align="center"> <td>2</td> <td></td> <td>F-RF-I-PG-ZZ-005G</td> <td>상품</td> <td align="left">F-퓨어컷팅R</td> <td><a href="javascript:setSeting('4673');"><img src="/images/com/btn_enter.gif"></a></td> </tr>
<tr align="center"> <td>1</td> <td></td> <td>F-G6-Z-PG-ZZ-000B</td> <td>상품</td> <td align="left">F-퓨어컷팅뒷장식E</td> <td><a href="javascript:setSeting('4542');"><img src="/images/com/btn_enter.gif"></a></td> </tr>
</table>
</form>
</body></html>
```

`tests/fixtures/orderimport/junlist.html`

```html
<html><head><title>Struts Board</title></head><body>
<form name="form3" method="post">
<input type="hidden" name="sKey" value="260914150011222">
<table width="100%" border="0" cellspacing="0" cellpadding="0" class="t_list">
<tr class="bg_1"><td>No</td><td><input type="checkbox" name="all" onClick="checkAll(form3,form3);"></td><td>주문일<br>주문장번호</td><td>이미지</td><td>상품명<br>상품코드 / 고객명</td><td>구분</td><td>상품정보</td><td>수량</td><td>주문가</td><td>매장명(주문직원)</td><td>인도예정일</td><td>상태</td><td>수정/취소</td></tr>
<tr align="center"> <td>20</td> <td><input type="checkbox" name="idx" value="389461"></td> <td>26-09-14<br><span class="f_gray">0000002YF3</span></td> <td><table width="65"><tr><td><img src="/upload/catalog/s_6965.JPG"></td></tr></table></td> <td align="left">F-이스키아N<br>F-NF-P-WG-UU-00DH<br><span class="f_blue">아자차8718/아</span> <span style="display:none;"><div id="note_20" class="tooltip2"><span class="f_bold">비고 : </span>정산 44,138 원 /블루칼세도니<br></div></span></td> <td>고객<br>(상품)</td> <td>925 1.2 g<br>화이트 (40)</td> <td>1</td> <td>82,000</td> <td>FASHION<br>(담당자)</td> <td>26-09-14</td> <td>주문완료</td> <td><a href="javascript:modify('389461');"><img src="/images/com/icon_modi.gif"></a> <a href="javascript:del('389461');"><img src="/images/com/icon_del.gif"></a></td> </tr>
<tr align="center"> <td>18</td> <td><input type="checkbox" name="idx" value="389455"></td> <td>26-09-14<br><span class="f_gray">0000002YF1</span></td> <td></td> <td align="left">F-Silver925미니트윈스타P<br>T-EF-I-WG-ZZ-00H8<br><span class="f_blue">차카타2567/아</span></td> <td>고객<br>(상품)</td> <td>925 0 g<br>화이트 ()</td> <td>1</td> <td>20,000</td> <td>FASHION<br>(담당자)</td> <td>26-09-14</td> <td>주문취소</td> <td></td> </tr>
</table>
</form>
</body></html>
```

`tests/fixtures/orderimport/clientform.html`

```html
<html><head><title>Struts Board</title></head><body>
<form name="form1" action="/etc/clientWrite.do?tcode=order_item" method="post" onsubmit="return movePageForm(this);">
<input type="hidden" name="sKey" value="260914121512260">
<input type="hidden" name="formname" value="form1">
<input type="hidden" name="url" value="/order/item/orderItemWriteForm.do">
<input type="hidden" name="actFlag" value="1">
<input type="hidden" name="shop" value="LT">
<input type="hidden" name="shopName" value="FASHION">
<input type="hidden" name="reqPage" value="1">
<input type="hidden" name="pageSize" value="20">
<input type="hidden" name="searchSortType" value="seq">
<input type="hidden" name="searchRegId" value="">
<input type="hidden" name="searchJunNum" value="">
<input type="hidden" name="searchTradeType" value="">
<input type="hidden" name="searchShop" value="">
<input type="hidden" name="searchWordType3" value="">
<input type="hidden" name="searchWord3" value="">
<input type="hidden" name="syear" value="">
<input type="hidden" name="smonth" value="">
<input type="hidden" name="sday" value="">
<input type="hidden" name="eyear" value="">
<input type="hidden" name="emonth" value="">
<input type="hidden" name="eday" value="">
<input type="hidden" name="searchWordType" value="">
<input type="hidden" name="searchWord" value="">
<input type="hidden" name="sido" value="">
<input type="hidden" name="gugun" value="">
<input type="hidden" name="dong" value="">
<input type="hidden" name="clientVisit2" value="">
<input type="hidden" name="jumin" value="">
<table class="tb_write">
<tr><th>매장</th><td><select name="regShop"><option value="LT">FASHION</option></select></td>
<th>등록일</th><td><input type="text" name="inDate" value="20260914" class="input" REQUIRED title="등록일"></td></tr>
<tr><th>고객명</th><td><input type="text" name="clientName" value="" class="input" REQUIRED title="고객명"></td>
<th>등록유형/전담직원</th><td><select name="clientType" REQUIRED title="등록유형"><option value="1" selected>계약고객</option><option value="2">상담고객</option><option value="5">취소고객</option><option value="6">환매고객</option><option value="7">딕스AS</option><option value="8">천안AS</option></select> <input type="text" name="clientManager" value=""></td></tr>
<tr><th>휴대폰(신규)</th><td><input type="text" name="phone" value="" class="input" MATCH="phone"></td>
<th>성별/결혼여부</th><td><select name="sexType" REQUIRED title="성별"><option value="2">여자분</option><option value="1">남자분</option></select> <select name="wedType" REQUIRED title="결혼여부"><option value="0">미혼</option><option value="1">기혼</option><option value="2">파혼</option></select></td></tr>
<tr><th>전화번호(신랑)</th><td><input type="text" name="tel" value="" class="input"></td></tr>
<tr><th>수신여부</th><td><select name="smsType" REQUIRED title="SMS수신여부"><option value="1">SMS 수신</option><option value="2">SMS 거부</option></select> <select name="emailType" REQUIRED title="메일수신여부"><option value="1">메일 수신</option><option value="2">메일 거부</option></select></td></tr>
<tr><th>고객분류</th><td><select name="grade" REQUIRED title="고객분류"><option value="">- 선택 -</option><option value="01">S(1000이상)</option><option value="02">A(500-999)</option><option value="03">B(300-499)</option><option value="04">C(100-299)</option><option value="05" selected>D(100이하)</option></select></td></tr>
<tr><th>마켓</th><td><select name="clientJob" title="마켓"><option value="">- 선택 -</option><option value="2">SSG</option><option value="3">CJ몰</option><option value="4">H몰</option><option value="5">스마트스토어</option><option value="6">카페24</option><option value="7">GS샵</option><option value="8">쿠팡</option><option value="9">위메프</option><option value="10">롯데ON</option><option value="11">카카오</option><option value="12">11번가</option><option value="13">G마켓</option><option value="14">옥션</option><option value="15">더리본샵</option><option value="16">AK몰</option><option value="17">지그재그</option><option value="18">아몬즈</option><option value="19">지인소개</option><option value="20">퀸잇</option><option value="21">에이블리</option><option value="22">오늘룩</option></select></td></tr>
<tr><th>기타기념일 1</th><td><select name="clientRelation3" REQUIRED><option value="1">본인</option><option value="8">가족</option></select> <input type="text" name="targetName3" value=""> / <select name="clientMemorial3" REQUIRED><option value="1">생일</option><option value="2">결혼기념일</option></select> <input type="text" name="memorialDate3" value=""> <select name="memorialType3"><option value="1">양력</option><option value="0">음력</option></select> <select name="memorialLeapType3"><option value="0">평달</option><option value="1">윤달</option></select></td></tr>
</table>
<input type="image" name="imageField22" src="/images/com/btn_save.gif" alt="등록하기">
</form>
</body></html>
```

- [ ] **Step 2: 실패하는 테스트 작성** — `tests/orderimport-form.test.js`


```js
/* =============================================================================
 *  orderimport-form.test.js — 판매처 주문 가져오기 순수 함수 단위 테스트 2/2 (폼 추출·목록·페이로드·대조).
 *  픽스처: tests/fixtures/orderimport/ (xls 행 배열은 실제 파일에서 뽑아 이름·전화만 가명 치환,
 *          HTML 은 2026-09-14 라이브 실측 마크업을 그대로 본뜬 합성본).
 *  스펙: docs/superpowers/specs/2026-09-14-orderimport-design.md §2·§4·§5
 *  실행: node --test tests/orderimport-form.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'src', 'orderimport-core.js'));
const FX = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'orderimport', name), 'utf8');

/* ---------------------------------------------------------- §4 폼 추출 */
const WRITE = FX('orderwrite-master.html');
test('oiReadWriteForm: form1 25필드 전부, k/color 옵션, 배열, 목록 1행(중첩 테이블 무시)', () => {
  const f = C.oiReadWriteForm(WRITE);
  assert.deepEqual(f.missing, []);
  assert.equal(f.values.sKey, '260914143005123'); assert.equal(f.values.tradeJun, '141240');
  assert.equal(f.values.master, '7083'); assert.equal(f.values.itemNum, 'FRFIWGPA00F6');
  assert.equal(f.values.k, '5'); assert.equal(f.values.color, 'WG'); assert.equal(f.values.itemSize, '11');
  assert.equal(f.values.orderPrice, '19,000'); assert.equal(f.values.shopRemark, '');
  assert.deepEqual(f.kOpts, [{ value: '5', text: '925', selected: true }]);
  assert.equal(f.colorOpts.length, 21); assert.equal(f.colorOpts[0].value, '');
  assert.deepEqual(f.arrays, { arr_weight: [0, 0], arr_salePrice: [19000, 0], arr_inputSupply: [4500, 0] });
  assert.equal(f.rows.length, 1);
  assert.deepEqual(f.rows[0], { orderSeq: '389463', tradeJun: '141240', code: 'F-RF-I-WG-PA-00F6', remark: '정산 12,133 원', name: 'F-퓨어컷팅(실버)R', k: '925', weight: '0 g', color: '화이트', size: '11', qty: '1', price: '17,000' });
  assert.deepEqual(f.defaults, { k: '5', color: 'WG', itemSize: '11' });
});

test('oiFieldValue: 이름 접두 오매치 방지·select 기본값·textarea', () => {
  const html = '<input type="hidden" name="pageSizeX" value="9"><input type=hidden name=pageSize value=20><select name="s"><option value="a">A</option><option value="b" selected>B</option></select><textarea name="t">hi</textarea>';
  assert.equal(C.oiFieldValue(html, 'pageSize'), '20');
  assert.equal(C.oiFieldValue(html, 's'), 'b');
  assert.equal(C.oiFieldValue(html, 't'), 'hi');
  assert.equal(C.oiFieldValue(html, 'nope'), null);
});

test('oiReadForm10: form10 구간만 읽어 form1 과 이름이 겹쳐도 안전, 인도예정월은 01(스크립트가 채우던 값)', () => {
  const f = C.oiReadForm10(WRITE);
  assert.deepEqual(f.missing, []);
  assert.equal(f.values.regId, '담당자'); assert.equal(f.values.txtOrderDate, '26-09-14');
  assert.equal(f.values.exdelivedmonth, '01');
  assert.equal(f.values.payEtc, '0'); assert.equal(f.values.payRemark, '');
  assert.equal(f.rows.length, 1);
});

test('oiForm10Payload: 인도예정일은 오늘로 명시, 결제 빈값은 0', () => {
  const v = C.oiReadForm10(WRITE).values;
  const p = Object.fromEntries(C.oiForm10Payload(Object.assign({}, v, { payCard: '' }), new Date(2026, 8, 14)));
  assert.equal(p.exdelivedyear, '2026'); assert.equal(p.exdelivedmonth, '09'); assert.equal(p.exdelivedday, '14');
  assert.equal(p.payCard, '0'); assert.equal(p.tradeJun, '141240');
  assert.equal(Object.keys(p).length, 23);
});

test('oiExtractHidden: 고객 등록 폼 hidden 28개(중복 이름·빈값 유지)', () => {
  const h = C.oiExtractHidden(FX('clientform.html'));
  assert.equal(h.length, 28);
  assert.deepEqual(h[0], ['sKey', '260914121512260']);
  assert.ok(h.some(([n, v]) => n === 'shopName' && v === 'FASHION'));
  assert.equal(C.oiSelectOptions(FX('clientform.html'), 'clientJob').find((o) => o.text === '아몬즈').value, '18');
});

test('oiClientSearchRows / oiMasterSearchRows / oiJunListRows', () => {
  const cl = C.oiClientSearchRows(FX('client-search.html'));
  assert.equal(cl.length, 4);
  assert.deepEqual(cl[1], { name: '가나다3269/카', shop: 'FASHION', phone: '', tel: '', seq: '123752' });
  assert.equal(cl[2].phone, '010-0000-2558');
  const ms = C.oiMasterSearchRows(FX('master-search.html'));
  assert.equal(ms.length, 4);
  assert.deepEqual(ms[0], { code: 'F-RF-I-WG-PA-00F6', name: 'F-퓨어컷팅(실버)R', seq: '7083' });
  const jn = C.oiJunListRows(FX('junlist.html'));
  assert.equal(jn.length, 2);
  assert.equal(jn[0].orderSeq, '389461'); assert.equal(jn[0].junNum, '0000002YF3'); assert.equal(jn[0].status, '주문완료');
  assert.equal(jn[1].junNum, '0000002YF1'); assert.equal(jn[1].status, '주문취소');
  assert.deepEqual(C.oiClientSearchRows('<html><body>검색된 결과가 없습니다.</body></html>'), []);
});

/* ------------------------------------------------------------ §4.2 페이로드 */
test('oiLinePayload: 스펙 덮어쓰기, 색상 폴백, orgOrderPrice 는 마스터가 그대로', () => {
  const f = C.oiReadWriteForm(WRITE);
  const master = { seq: '7083', code: 'F-RF-I-WG-PA-00F6' };
  const p = C.oiLinePayload(f, master, { k: '925', color: null, itemSize: '17', qty: 1, price: 17000, remark: '정산 12,033 원' });
  assert.deepEqual(p.issues, []);
  const o = Object.fromEntries(p.fields);
  assert.equal(p.fields.length, 25);
  assert.equal(o.k, '5'); assert.equal(o.color, 'WG'); assert.equal(o.itemSize, '17');
  assert.equal(o.orderQty, '1'); assert.equal(o.orderPrice, '17,000'); assert.equal(o.shopRemark, '정산 12,033 원');
  assert.equal(o.orgOrderPrice, '19000'); assert.equal(o.sKey, '260914143005123');
  //  색상 폴백: 마스터 기본 색상이 빈값이면 코드 4번째 토막
  const f2 = Object.assign({}, f, { values: Object.assign({}, f.values, { color: '' }) });
  assert.equal(Object.fromEntries(C.oiLinePayload(f2, master, { qty: 1, price: 82000, remark: '' }).fields).color, 'WG');
  const f3 = Object.assign({}, f2, { colorOpts: [{ value: '' }, { value: 'PG' }] });
  assert.ok(C.oiLinePayload(f3, master, { qty: 1, price: 82000, remark: '' }).issues.includes('색상 없음'));
  //  사이즈 미지정이면 마스터 기본값(문자열 그대로)
  const f4 = Object.assign({}, f, { values: Object.assign({}, f.values, { itemSize: '40+5' }) });
  assert.equal(Object.fromEntries(C.oiLinePayload(f4, master, { qty: 1, price: 42000, remark: '' }).fields).itemSize, '40+5');
  //  master 불일치·판매가 0·수량 0 은 issue
  assert.ok(C.oiLinePayload(f, { seq: '9999', code: 'X' }, { qty: 1, price: 1, remark: '' }).issues.some((s) => s.startsWith('master 불일치')));
  assert.ok(C.oiLinePayload(f, master, { qty: 0, price: 0, remark: '' }).issues.includes('수량'));
});

test('oiLinePayload: 품위를 바꾸면 kchange 처럼 배열에서 weight/orgOrderPrice/inputPrice 를 다시 뽑는다', () => {
  const f = C.oiReadWriteForm(WRITE);
  f.kOpts = [{ value: '1', text: '14K', selected: true }, { value: '2', text: '18K' }];
  f.values.k = '1';
  f.arrays = { arr_weight: [1.29, 1.55], arr_salePrice: [446000, 512000], arr_inputSupply: [200000, 240000] };
  const o = Object.fromEntries(C.oiLinePayload(f, { seq: '7083', code: 'T-R6-Q-WG-QB-00CI' }, { k: '18', color: 'PG', itemSize: '15', qty: 1, price: 512000, remark: '' }).fields);
  assert.equal(o.k, '2'); assert.equal(o.weight, '1.55'); assert.equal(o.orgOrderPrice, '512000'); assert.equal(o.inputPrice, '240000'); assert.equal(o.color, 'PG');
  assert.ok(C.oiLinePayload(f, { seq: '7083', code: 'X' }, { k: '925', qty: 1, price: 1, remark: '' }).issues.some((s) => s.startsWith('품위 옵션 없음')));
});

test('oiSubmitResult: msg 비면 성공', () => {
  assert.deepEqual(C.oiSubmitResult('http://ubdstore.ubshop.biz/order/item/orderItemWriteForm.do?tcode=order_item&tradeJun=&client=1'), { ok: true, msg: '' });
  assert.deepEqual(C.oiSubmitResult('http://ubdstore.ubshop.biz/order/item/orderItemWriteForm.do?tcode=order_item&msg=%EC%8B%A4%ED%8C%A8'), { ok: false, msg: '실패' });
  assert.equal(C.oiSubmitResult('not a url').ok, false);
});

/* ---------------------------------------------------------- §5 기대치 대조 */
test('oiCheckForm / oiCheckFinal: client·행 수·orderSeq·코드·사이즈·수량·주문가 대조', () => {
  const f = C.oiReadWriteForm(WRITE);
  assert.equal(C.oiCheckForm(f, { client: '123790', master: '7083', tradeJun: '141240', orderSeqs: ['389463'] }).ok, true);
  assert.match(C.oiCheckForm(f, { client: '123790', master: '7083', tradeJun: '', orderSeqs: [] }).reason, /^rows 1≠0/);
  assert.match(C.oiCheckForm(f, { client: '999', master: '7083', tradeJun: '141240', orderSeqs: ['389463'] }).reason, /^client/);
  assert.match(C.oiCheckForm(f, { client: '123790', master: '7083', tradeJun: '141240', orderSeqs: ['1'] }).reason, /^foreign row 389463/);
  assert.match(C.oiCheckForm(f, { client: '123790', master: '7083', tradeJun: '999', orderSeqs: ['389463'] }).reason, /^tradeJun/);
  const f10 = C.oiReadForm10(WRITE);
  const line = { master: { code: 'F-RF-I-WG-PA-00F6' }, spec: { itemSize: '11', qty: 1, price: 17000 } };
  assert.equal(C.oiCheckFinal(f10, { client: '123790', tradeJun: '141240', orderSeqs: ['389463'], lines: [line] }).ok, true);
  const bad = { master: { code: 'F-RF-I-WG-PA-00F6' }, spec: { itemSize: '13', qty: 1, price: 17000 } };
  assert.match(C.oiCheckFinal(f10, { client: '123790', tradeJun: '141240', orderSeqs: ['389463'], lines: [bad] }).reason, /^size/);
  const badPrice = { master: { code: 'F-RF-I-WG-PA-00F6' }, spec: { itemSize: '11', qty: 1, price: 18000 } };
  assert.match(C.oiCheckFinal(f10, { client: '123790', tradeJun: '141240', orderSeqs: ['389463'], lines: [badPrice] }).reason, /^price/);
});
```

- [ ] **Step 3: 실패 확인**

Run: `node --test tests/orderimport-form.test.js`
Expected: FAIL — `TypeError: C.oiReadWriteForm is not a function` (첫 테스트부터)

- [ ] **Step 4: 구현** — `src/orderimport-core.js` 의 `  const api = {` 줄 **바로 앞**에 아래 블록을 삽입


```js
  /* ------------------------------------------------------- §4 폼 추출 */
  function oiAttr(tag, attr) {
    const re = new RegExp('\\b' + attr + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>"\']+))', 'i');
    const m = tag.match(re);
    return m ? (m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3])) : null;
  }
  function oiEsc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function oiDecodeEntities(s) {
    return String(s).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }

  //  <select name=X> 의 옵션 [{value,text,selected}] | null
  function oiSelectOptions(html, name) {
    const re = new RegExp('<select\\b[^>]*\\bname\\s*=\\s*["\']?' + oiEsc(name) + '["\']?(?=[\\s>"\'])[^>]*>([\\s\\S]*?)<\\/select>', 'i');
    const m = String(html).match(re);
    if (!m) return null;
    const opts = [];
    const ore = /<option\b([^>]*)>([^<]*)/gi; let o;
    while ((o = ore.exec(m[1]))) {
      const attrs = o[1];
      const value = oiAttr('<option' + attrs + '>', 'value');
      const text = oiDecodeEntities(o[2]).trim();
      opts.push({ value: value == null ? text : value, text, selected: /\bselected\b/i.test(attrs) });
    }
    return opts;
  }

  //  이름으로 값 하나: input(value) → select(selected, 없으면 첫 옵션) → textarea. 없으면 null.
  function oiFieldValue(html, name) {
    const h = String(html);
    const ire = new RegExp('<input\\b[^>]*\\bname\\s*=\\s*["\']?' + oiEsc(name) + '["\']?(?=[\\s>"\'])[^>]*>', 'i');
    const im = h.match(ire);
    if (im) { const v = oiAttr(im[0], 'value'); return v == null ? '' : oiDecodeEntities(v); }
    const opts = oiSelectOptions(h, name);
    if (opts) { const sel = opts.find((o) => o.selected) || opts[0]; return sel ? sel.value : ''; }
    const tre = new RegExp('<textarea\\b[^>]*\\bname\\s*=\\s*["\']?' + oiEsc(name) + '["\']?(?=[\\s>"\'])[^>]*>([\\s\\S]*?)<\\/textarea>', 'i');
    const tm = h.match(tre);
    if (tm) return oiDecodeEntities(tm[1]);
    return null;
  }

  function oiExtractFields(html, names) {
    const values = {}; const missing = [];
    (names || []).forEach((n) => { const v = oiFieldValue(html, n); if (v === null) missing.push(n); else values[n] = v; });
    return { values, missing };
  }

  //  hidden input 전부 → [[name, value], …] (문서 순서, 중복 이름 유지). DOMParser form.elements 함정 회피.
  function oiExtractHidden(html) {
    const out = [];
    const re = /<input\b[^>]*>/gi; let m;
    while ((m = re.exec(String(html)))) {
      const tag = m[0];
      if (!/\btype\s*=\s*["']?hidden["']?/i.test(tag)) continue;
      const name = oiAttr(tag, 'name'); if (!name) continue;
      const v = oiAttr(tag, 'value');
      out.push([name, v == null ? '' : oiDecodeEntities(v)]);
    }
    return out;
  }

  //  var arr_weight = new Array(1.2,0); 류 → { arr_weight:[1.2,0], … }
  function oiExtractArrays(html) {
    const out = {};
    ['arr_weight', 'arr_salePrice', 'arr_inputSupply'].forEach((n) => {
      const m = String(html).match(new RegExp('var\\s+' + n + '\\s*=\\s*new\\s+Array\\(([^)]*)\\)'));
      out[n] = m ? m[1].split(',').map((x) => Number(String(x).trim())).map((x) => Number.isFinite(x) ? x : 0) : null;
    });
    return out;
  }

  /* --------------------------------------------- §4 목록(table.t_list) 파싱 */
  //  중첩 테이블(이미지 셀)이 있어 단순 <tr> 정규식은 안 된다 → 태그 스캐너로 깊이를 센다.
  function oiTListRows(html) {
    const h = String(html);
    const tre = /<table\b[^>]*\bclass\s*=\s*["']?t_list["']?[^>]*>/gi; let tm;
    while ((tm = tre.exec(h))) {
      const rows = oiScanTable(h, tm.index);
      if (rows.some((r) => r.idx !== null)) return rows.filter((r) => r.idx !== null);
    }
    return [];
  }
  function oiScanTable(h, start) {
    const tagRe = /<\/?(table|tr|td|th)\b[^>]*>/gi;
    tagRe.lastIndex = start;
    let depth = 0, row = null, cell = null; const rows = [];
    let t;
    while ((t = tagRe.exec(h))) {
      const tag = t[0]; const name = t[1].toLowerCase(); const close = tag[1] === '/';
      if (name === 'table') {
        if (!close) depth++; else { depth--; if (depth === 0) break; }
        continue;
      }
      if (depth !== 1) continue;                            // 중첩 테이블 안은 통째로 셀 내용
      if (name === 'tr') {
        if (!close) { row = { cells: [], idx: null, html: '' , _start: t.index }; }
        else if (row) { row.html = h.slice(row._start, t.index + tag.length); delete row._start; const im = row.html.match(/<input\b[^>]*\bname\s*=\s*["']?idx["']?[^>]*>/i); row.idx = im ? oiAttr(im[0], 'value') : null; rows.push(row); row = null; }
        continue;
      }
      if (!row) continue;
      if (!close) { cell = { _start: t.index + tag.length }; }
      else if (cell) { const raw = h.slice(cell._start, t.index); row.cells.push(oiDecodeEntities(raw.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()); cell = null; }
    }
    return rows;
  }

  //  주문폼 하단 목록 행: 셀 인덱스 고정(실측) 0 No·1 체크·2 이미지·3 상품코드+비고·4 구분·5 상품명·6 품위·7 중량·8 색상·9 사이즈·10 수량·11 주문가.
  function oiWriteListRow(row) {
    const c = row.cells || [];
    const idx = String(row.idx || '');
    const parts = idx.split(',');
    const codeCell = c[3] || '';
    const cm = codeCell.match(/^([A-Z0-9]+(?:-[A-Z0-9]+)+)/i);
    const rm = codeCell.match(/비고\s*:\s*(.*)$/);
    return {
      orderSeq: parts[0] || '', tradeJun: parts[1] || '',
      code: cm ? cm[1] : '', remark: rm ? rm[1].trim() : '',
      name: c[5] || '', k: c[6] || '', weight: c[7] || '', color: c[8] || '', size: c[9] || '',
      qty: c[10] || '', price: c[11] || ''
    };
  }
  function oiWriteListRows(html) { return oiTListRows(html).map(oiWriteListRow); }

  //  MD 주문전표 목록 행: 1 idx=orderSeq · 2 '26-09-14'+'0000002YF3' · 4 상품명 코드 / 고객명 · 11 상태.
  function oiJunListRows(html) {
    return oiTListRows(html).map((row) => {
      const c = row.cells || [];
      const jm = String(c[2] || '').match(/(\d{7}[0-9A-Z]{3})\s*$/);
      return { orderSeq: String(row.idx || '').split(',')[0], junNum: jm ? jm[1] : '', title: c[4] || '', status: c[11] || '' };
    });
  }

  //  고객 검색 결과 행: 1 고객명·2 매장·3 휴대폰·4 전화, 선택 링크 setSeting(form1,'i','<seq>'). (idx 가 없는 표라 링크로 고른다)
  function oiClientSearchRows(html) {
    const h = String(html); const out = [];
    const tre = /<table\b[^>]*\bclass\s*=\s*["']?t_list["']?[^>]*>/gi; let tm;
    while ((tm = tre.exec(h))) {
      const rows = oiScanTable(h, tm.index);
      rows.forEach((r) => {
        const sm = r.html.match(/setSeting\s*\(\s*form1\s*,\s*['"](\d+)['"]\s*,\s*['"](\d+)['"]\s*\)/);
        if (!sm) return;
        out.push({ name: r.cells[1] || '', shop: r.cells[2] || '', phone: r.cells[3] || '', tel: r.cells[4] || '', seq: sm[2] });
      });
      if (out.length) return out;
    }
    return out;
  }

  //  상품 검색 결과 행: 2 상품코드·4 상품명, 링크 setSeting('<masterSeq>').
  function oiMasterSearchRows(html) {
    const h = String(html); const out = [];
    const tre = /<table\b[^>]*\bclass\s*=\s*["']?t_list["']?[^>]*>/gi; let tm;
    while ((tm = tre.exec(h))) {
      oiScanTable(h, tm.index).forEach((r) => {
        const sm = r.html.match(/setSeting\s*\(\s*['"](\d+)['"]\s*\)/);
        if (!sm) return;
        out.push({ code: r.cells[2] || '', name: r.cells[4] || '', seq: sm[1] });
      });
      if (out.length) return out;
    }
    return out;
  }

  /* ------------------------------------------------------- §4.2 페이로드 */
  const FORM1_NAMES = Object.freeze(['sKey', 'pageSize', 'searchSortType', 'tradeJun', 'payJun', 'shop', 'client', 'master', 'itemType',
    'inputPrice', 'orgOrderPrice', 'shopName', 'clientName', 'itemNum', 'weight', 'doc', 'diaColor', 'clarity', 'surface',
    'k', 'color', 'itemSize', 'orderQty', 'orderPrice', 'shopRemark']);
  const FORM10_NAMES = Object.freeze(['sKey', 'pageSize', 'searchSortType', 'tradeJun', 'payJun', 'shop', 'client', 'payBank', 'payDia',
    'txtOrderDate', 'exdelivedyear', 'exdelivedmonth', 'exdelivedday', 'regId', 'beforePrice', 'payPrice', 'afterPrice',
    'payCard', 'paySaleOldGold', 'payCash', 'payCashPaper', 'payEtc', 'payRemark']);

  //  주문폼 GET 응답 → { values, missing, kOpts, colorOpts, arrays, rows, defaults }
  function oiReadWriteForm(html) {
    const ex = oiExtractFields(html, FORM1_NAMES);
    const kOpts = oiSelectOptions(html, 'k');
    const colorOpts = oiSelectOptions(html, 'color');
    return {
      values: ex.values, missing: ex.missing,
      kOpts: kOpts || [], colorOpts: colorOpts || [],
      arrays: oiExtractArrays(html),
      rows: oiWriteListRows(html),
      defaults: { k: ex.values.k || '', color: ex.values.color || '', itemSize: ex.values.itemSize || '' }
    };
  }
  //  form10 은 form1 과 이름이 겹치므로(sKey·client…) form10 구간만 잘라 읽는다. 구간이 없으면 전체.
  function oiReadForm10(html) {
    const h = String(html);
    const i0 = h.search(/<form\b[^>]*\bname\s*=\s*["']?form10["']?/i);
    let seg = h;
    if (i0 >= 0) { const rest = h.slice(i0); const i1 = rest.search(/<form\b[^>]*\bname\s*=\s*["']?form2["']?/i); seg = i1 > 0 ? rest.slice(0, i1) : rest; }
    const ex = oiExtractFields(seg, FORM10_NAMES);
    return { values: ex.values, missing: ex.missing, rows: oiWriteListRows(h) };
  }

  //  줄 페이로드: 추출값(25) + 스펙(k/color/itemSize/qty/price/remark) → { fields:[[n,v]…], issues:[] }
  //  k 를 바꾸면 페이지의 kchange() 처럼 arr_weight/arr_salePrice/arr_inputSupply[옵션 인덱스] 로 weight/orgOrderPrice/inputPrice 를 다시 뽑는다.
  function oiLinePayload(form, master, spec) {
    const issues = [];
    const v = Object.assign({}, form.values);
    if (form.missing && form.missing.length) issues.push('필드 누락: ' + form.missing.join(','));
    if (spec.k) {
      const opt = oiResolveK(spec.k, form.kOpts);
      if (!opt) issues.push('품위 옵션 없음: ' + spec.k);
      else if (opt.value !== v.k) {
        v.k = opt.value;
        const pos = form.kOpts.indexOf(opt);
        const a = form.arrays || {};
        if (a.arr_weight && pos < a.arr_weight.length) v.weight = String(a.arr_weight[pos]);
        if (a.arr_salePrice && pos < a.arr_salePrice.length) v.orgOrderPrice = String(a.arr_salePrice[pos]);
        if (a.arr_inputSupply && pos < a.arr_inputSupply.length) v.inputPrice = String(a.arr_inputSupply[pos]);
      }
    }
    let color = spec.color || v.color || '';
    if (!color) color = oiColorFromCode((master && (master.colorFallback || master.code)) || '', form.colorOpts) || '';
    if (!color) issues.push('색상 없음');
    else if (form.colorOpts && form.colorOpts.length && !form.colorOpts.some((o) => o.value === color)) issues.push('색상 없음: ' + color);
    v.color = color;
    if (spec.itemSize != null && spec.itemSize !== '') v.itemSize = String(spec.itemSize);
    if (!(spec.qty > 0)) issues.push('수량');
    v.orderQty = String(spec.qty);
    if (!(spec.price > 0)) issues.push('판매가');
    v.orderPrice = oiComma(spec.price);
    v.shopRemark = spec.remark || '';
    if (master && master.seq && String(v.master) !== String(master.seq)) issues.push('master 불일치: ' + v.master + '≠' + master.seq);
    return { fields: FORM1_NAMES.map((n) => [n, v[n] == null ? '' : String(v[n])]), issues, values: v };
  }

  //  주문장 완료 페이로드: 인도예정일은 오늘로 명시(HTML 에 selected 가 없어 추출값이 01/01). 결제 필드는 빈값이면 '0'.
  function oiForm10Payload(values, today) {
    const v = Object.assign({}, values);
    const d = today instanceof Date ? today : new Date();
    const p = (x) => String(x).padStart(2, '0');
    v.exdelivedyear = String(d.getFullYear()); v.exdelivedmonth = p(d.getMonth() + 1); v.exdelivedday = p(d.getDate());
    ['payBank', 'payDia', 'beforePrice', 'payPrice', 'afterPrice', 'payCard', 'paySaleOldGold', 'payCash', 'payCashPaper', 'payEtc']
      .forEach((n) => { if (v[n] == null || v[n] === '') v[n] = '0'; });
    if (v.payRemark == null) v.payRemark = '';
    return FORM10_NAMES.map((n) => [n, v[n] == null ? '' : String(v[n])]);
  }

  //  성공·실패 모두 폼페이지로 리다이렉트, 실패만 msg 에 문구(기존 메모리). url = fetch 응답 resp.url.
  function oiSubmitResult(url) {
    try { const msg = new URL(url).searchParams.get('msg') || ''; return { ok: !msg, msg }; }
    catch (_) { return { ok: false, msg: 'bad_url' }; }
  }

  /* ------------------------------------------------ §5 기대치 대조 */
  //  줄 등록 전: client 일치 · 행 수 = 내가 넣은 수 · 행의 orderSeq 집합 일치 · tradeJun 일치(첫 줄은 빈값 허용).
  function oiCheckForm(form, expect) {
    const v = form.values || {};
    if (String(v.client) !== String(expect.client)) return { ok: false, reason: 'client ' + v.client + '≠' + expect.client };
    if (expect.master != null && String(v.master) !== String(expect.master)) return { ok: false, reason: 'master ' + v.master + '≠' + expect.master };
    const rows = form.rows || [];
    const mine = expect.orderSeqs || [];
    if (rows.length !== mine.length) return { ok: false, reason: 'rows ' + rows.length + '≠' + mine.length };
    for (const r of rows) if (!mine.includes(r.orderSeq)) return { ok: false, reason: 'foreign row ' + r.orderSeq };
    if (mine.length && expect.tradeJun && String(v.tradeJun) !== String(expect.tradeJun)) return { ok: false, reason: 'tradeJun ' + v.tradeJun + '≠' + expect.tradeJun };
    return { ok: true, reason: '' };
  }
  //  완료 직전: 행 수·orderSeq·상품코드·사이즈·수량·주문가를 검토 표(lines)와 대조.
  function oiCheckFinal(form, expect) {
    const base = oiCheckForm(form, expect);
    if (!base.ok) return base;
    const rows = form.rows || [];
    const lines = expect.lines || [];
    if (rows.length !== lines.length) return { ok: false, reason: 'rows ' + rows.length + '≠' + lines.length };
    for (let i = 0; i < lines.length; i++) {
      const r = rows.find((x) => x.orderSeq === expect.orderSeqs[i]);
      const ln = lines[i];
      if (!r) return { ok: false, reason: 'missing row ' + expect.orderSeqs[i] };
      if (r.code !== ln.master.code) return { ok: false, reason: 'code ' + r.code + '≠' + ln.master.code };
      if (ln.spec.itemSize != null && ln.spec.itemSize !== '' && String(r.size) !== String(ln.spec.itemSize)) return { ok: false, reason: 'size ' + r.size + '≠' + ln.spec.itemSize };
      if (String(r.qty) !== String(ln.spec.qty)) return { ok: false, reason: 'qty ' + r.qty + '≠' + ln.spec.qty };
      if (r.price.replace(/,/g, '') !== String(ln.spec.price)) return { ok: false, reason: 'price ' + r.price + '≠' + ln.spec.price };
    }
    return { ok: true, reason: '' };
  }
```

그리고 Task 1 의 `const api = { … }` 블록 전체를 아래로 **교체**:


```js
  const api = {
    MARKETS, COLS, REQUIRED, FORM1_NAMES, FORM10_NAMES,
    oiMarket, oiHeaderMap, oiNormPhone, oiClientName, oiMoney, oiComma, oiRemark, oiParseRows,
    oiParseOption, oiColorFromCode, oiNormName, oiMapKeys, oiLookupMap, oiLearn, oiSuggestQueries,
    oiGroupOrders, oiResolveK, oiLineIssues,
    oiSelectOptions, oiFieldValue, oiExtractFields, oiExtractHidden, oiExtractArrays,
    oiTListRows, oiWriteListRows, oiJunListRows, oiClientSearchRows, oiMasterSearchRows,
    oiReadWriteForm, oiReadForm10, oiLinePayload, oiForm10Payload, oiSubmitResult,
    oiCheckForm, oiCheckFinal
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof globalThis !== 'undefined') { globalThis.ubOi = api; }
})();
```

- [ ] **Step 5: 통과 확인**

Run: `node --test tests/orderimport-parse.test.js tests/orderimport-form.test.js`
Expected: `ℹ pass 21` / `ℹ fail 0`

- [ ] **Step 6: 커밋**

```bash
git add src/orderimport-core.js tests/orderimport-form.test.js tests/fixtures/orderimport/
git commit -m "feat(주문 가져오기): core 2/2 — 폼 hidden/select 정규식 추출·t_list 중첩 테이블 스캐너·줄/완료 페이로드·기대치 대조 + 픽스처·테스트 10건"
```

---

### Task 3: 실행기 — `oiRunOrder` / `oiRunAll` (erp 주입, 스텁 테스트)

**Files:**
- Modify: `src/orderimport-core.js` (`const api = {` 앞에 삽입 + api 교체)
- Test: `tests/orderimport-run.test.js`

**Interfaces:**
- Consumes: Task 2 의 `oiCheckForm`, `oiLinePayload`, `oiCheckFinal`, `oiForm10Payload`
- Produces: `oiRunOrder(order, erp, hooks) → Result`, `oiRunAll(orders, erp, hooks) → Result[]`
  - `order = {key, clientName, phone:{phone}, market:{clientJob}, lines:[{master:{seq,code,name,colorFallback?}, spec:{k,color,itemSize,qty,price,remark}}]}`
  - `erp` 인터페이스(Task 4 가 구현): `state() → {tradeJun,client,rows:number}` · `searchClient(type,word) → [{name,shop,phone,tel,seq}]` · `registerClient(name,phone,clientJob) → {ok,msg,client:{seq,name,phone}|null}` · `getWriteForm({tradeJun,master,client,clientName}) → oiReadWriteForm 결과` · `postLine(fields) → {ok,msg,tradeJun,rows}` · `getForm10({tradeJun,client,clientName}) → oiReadForm10 결과` · `postComplete(fields) → {ok,msg}` · `deleteLines(tradeJun,client,clientName,idxValues) → {ok,msg}` · `findJunNums(orderSeqs) → [{orderSeq,junNum,status}]`
  - `hooks = { today():Date, log(key,step,info), onOrder(result)? }`
  - `Result = {key, status:'done'|'skipped'|'fatal'|'blocked'|'pending', reason, client:{seq,name,mode}|null, tradeJun, orderSeqs[], idxValues[], junNums[], rolledBack}`

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/orderimport-run.test.js`


```js
/* =============================================================================
 *  orderimport-run.test.js — 실행기(oiRunOrder/oiRunAll) 배선 테스트. erp 어댑터를 스텁으로 갈아 끼워
 *  "가드 실패·외부 개입·완료 실패 때 쓰기를 부르지 않고 되돌린다" 를 고정한다. 네트워크 없음.
 *  스펙: docs/superpowers/specs/2026-09-14-orderimport-design.md §3.4·§5
 *  실행: node --test tests/orderimport-run.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'src', 'orderimport-core.js'));

const MASTER = { seq: '7083', code: 'F-RF-I-WG-PA-00F6', name: 'F-퓨어컷팅(실버)R' };
function order(lines) {
  return {
    key: '아몬즈|2178934182592088', seller: '아몬즈', orderNo: '2178934182592088',
    market: { name: '아몬즈', suffix: '아', clientJob: '18' },
    buyer: '차카타', phone: { phone: '106-0000-2567', last4: '2567', ok: true, raw: '106-0000-2567' },
    clientName: '차카타2567/아',
    lines: lines || [
      { master: MASTER, spec: { k: '925', color: null, itemSize: '17', qty: 1, price: 17000, remark: '정산 12,033 원' } },
      { master: MASTER, spec: { k: '925', color: null, itemSize: '9', qty: 1, price: 17000, remark: '정산 12,087 원' } }
    ]
  };
}
const KOPTS = [{ value: '5', text: '925', selected: true }];
const COLOR = [{ value: '', text: '- 색상 -' }, { value: 'WG', text: 'WG (화이트)', selected: true }, { value: 'PG', text: 'PG (핑크)' }];
function formValues(over) {
  return Object.assign({ sKey: '1', pageSize: '20', searchSortType: 'seq', tradeJun: '', payJun: '', shop: 'LT', client: '123784', master: '7083', itemType: '1',
    inputPrice: '4500', orgOrderPrice: '19000', shopName: 'FASHION', clientName: '차카타2567/아', itemNum: 'FRFIWGPA00F6', weight: '0', doc: '', diaColor: '',
    clarity: '', surface: '', k: '5', color: 'WG', itemSize: '11', orderQty: '1', orderPrice: '19,000', shopRemark: '' }, over || {});
}
function form10Values(over) {
  return Object.assign({ sKey: '2', pageSize: '20', searchSortType: 'seq', tradeJun: '141236', payJun: '', shop: 'LT', client: '123784', payBank: '0', payDia: '0',
    txtOrderDate: '26-09-14', exdelivedyear: '2026', exdelivedmonth: '01', exdelivedday: '01', regId: '담당자', beforePrice: '0', payPrice: '0', afterPrice: '0',
    payCard: '0', paySaleOldGold: '0', payCash: '0', payCashPaper: '0', payEtc: '0', payRemark: '' }, over || {});
}
const row = (seq, tradeJun, size, remark) => ({ orderSeq: seq, tradeJun, code: MASTER.code, remark, name: MASTER.name, k: '925', weight: '0 g', color: '화이트', size, qty: '1', price: '17,000' });

//  스텁 erp: 서버의 '열린 주문장' 을 흉내 낸다. opts 로 시나리오를 바꾼다.
function makeErp(opts) {
  opts = opts || {};
  const calls = [];
  const srv = { tradeJun: opts.openTrade || '', rows: [], seqNo: 389460, clients: opts.clients || [] };
  const state = () => ({ tradeJun: srv.tradeJun, client: srv.tradeJun ? '123784' : '', rows: srv.rows.length });
  return {
    calls, srv,
    async state() { calls.push(['state']); return state(); },
    async searchClient(type, word) { calls.push(['searchClient', type, word]); return srv.clients.filter((c) => type === 'phone' ? c.phone === word : c.name.includes(word)); },
    async registerClient(name, phone, clientJob) { calls.push(['registerClient', name, phone, clientJob]); if (opts.registerFails) return { ok: false, msg: '등록 실패', client: null }; const c = { seq: '123784', name, phone }; srv.clients.push(c); return { ok: true, msg: '', client: c }; },
    async getWriteForm(p) { calls.push(['getWriteForm', p.tradeJun, p.master, p.client]); if (opts.foreignRowAt != null && !srv.injected && srv.rows.length === opts.foreignRowAt) { srv.injected = true; srv.rows.push(Object.assign(row('999999', srv.tradeJun || '141236', '40', ''), { code: 'T-EF-I-WG-ZZ-00H8' })); } return { values: formValues({ tradeJun: srv.tradeJun, client: p.client, master: p.master }), missing: [], kOpts: KOPTS, colorOpts: COLOR, arrays: { arr_weight: [0, 0], arr_salePrice: [19000, 0], arr_inputSupply: [4500, 0] }, rows: srv.rows.slice(), defaults: { k: '5', color: 'WG', itemSize: '11' } }; },
    async postLine(fields) { calls.push(['postLine', Object.fromEntries(fields)]); if (opts.lineFailsAt != null && srv.rows.length === opts.lineFailsAt) return { ok: false, msg: '실패', tradeJun: srv.tradeJun, rows: srv.rows.slice() }; if (!srv.tradeJun) srv.tradeJun = '141236'; const f = Object.fromEntries(fields); srv.rows.push(row(String(++srv.seqNo), srv.tradeJun, f.itemSize, f.shopRemark)); return { ok: true, msg: '', tradeJun: srv.tradeJun, rows: srv.rows.slice() }; },
    async getForm10(p) { calls.push(['getForm10', p.tradeJun]); return { values: form10Values({ tradeJun: srv.tradeJun, client: p.client }), missing: [], rows: srv.rows.slice() }; },
    async postComplete(fields) { calls.push(['postComplete', Object.fromEntries(fields)]); if (opts.completeFails) return { ok: false, msg: '완료 실패' }; srv.tradeJun = ''; srv.rows = []; return { ok: true, msg: '' }; },
    async deleteLines(tradeJun, client, clientName, idxValues) { calls.push(['deleteLines', tradeJun, idxValues.slice()]); if (opts.deleteFails) return { ok: false, msg: 'x' }; const seqs = idxValues.map((v) => v.split(',')[0]); srv.rows = srv.rows.filter((r) => !seqs.includes(r.orderSeq)); if (!srv.rows.length) srv.tradeJun = ''; return { ok: true, msg: '' }; },
    async findJunNums(orderSeqs) { calls.push(['findJunNums', orderSeqs.slice()]); return orderSeqs.map((s) => ({ orderSeq: s, junNum: '0000002YF5', status: '주문완료' })); }
  };
}
const hooks = { today: () => new Date(2026, 8, 14), log() {} };
const names = (erp) => erp.calls.map((c) => c[0]);

test('정상 경로: 신규 고객 등록 → 줄 2개 → 완료 → 관리번호', async () => {
  const erp = makeErp();
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'done');
  assert.deepEqual(r.client, { seq: '123784', name: '차카타2567/아', mode: 'new' });
  assert.equal(r.orderSeqs.length, 2);
  assert.equal(r.tradeJun, '141236');
  assert.equal(r.junNums[0].junNum, '0000002YF5');
  const posts = erp.calls.filter((c) => c[0] === 'postLine').map((c) => c[1]);
  assert.deepEqual(posts.map((p) => p.itemSize), ['17', '9']);
  assert.deepEqual(posts.map((p) => p.orderPrice), ['17,000', '17,000']);
  assert.equal(posts[1].tradeJun, '141236', '둘째 줄은 첫 줄이 만든 tradeJun 을 실어야 한다');
  const done = erp.calls.find((c) => c[0] === 'postComplete')[1];
  assert.equal(done.exdelivedmonth, '09'); assert.equal(done.exdelivedday, '14');
  assert.deepEqual(erp.srv.rows, [], '완료 후 서버 목록이 비어야 한다');
});

test('고객 재사용: 정확일치 고객이 있으면 등록하지 않는다(부분일치 후보는 무시)', async () => {
  const erp = makeErp({ clients: [{ seq: '111', name: '차카타2567/아', phone: '106-0000-2567' }, { seq: '222', name: '차카타2567/아(구)', phone: '' }] });
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'done');
  assert.equal(r.client.seq, '111'); assert.equal(r.client.mode, 'reuse');
  assert.ok(!names(erp).includes('registerClient'));
});

test('예물고객 충돌: 다른 이름이 같은 휴대폰이면 휴대폰 빈칸으로 등록', async () => {
  const erp = makeErp({ clients: [{ seq: '333', name: '라마바/차카타', phone: '106-0000-2567' }] });
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'done');
  const reg = erp.calls.find((c) => c[0] === 'registerClient');
  assert.equal(reg[2], '', '휴대폰이 비어야 한다'); assert.equal(reg[3], '18');
  assert.equal(r.client.mode, 'new_nophone');
});

test('가드: 열린 주문장이 있으면 아무 쓰기도 하지 않고 skipped', async () => {
  const erp = makeErp({ openTrade: '141228' });
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'skipped'); assert.equal(r.reason, 'open_trade');
  assert.deepEqual(names(erp), ['state']);
});

test('외부 개입: 줄 사이에 남의 줄이 끼면 내 줄만 되돌리고 fatal, 완료 POST 없음', async () => {
  const erp = makeErp({ foreignRowAt: 1 });          // 첫 줄 등록 뒤 GET 에서 남의 줄이 보인다
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'fatal', '남의 줄이 세션에 남아 있으면 다음 주문장도 못 가므로 전체 중단');
  assert.match(r.reason, /^foreign_rows_remain:mismatch:/);
  const del = erp.calls.find((c) => c[0] === 'deleteLines');
  assert.deepEqual(del[2], [r.orderSeqs[0] + ',141236'], '내가 넣은 orderSeq 만 삭제');
  assert.ok(!names(erp).includes('postComplete'));
  assert.equal(erp.srv.rows.length, 1); assert.equal(erp.srv.rows[0].orderSeq, '999999', '남의 줄은 남긴다');
  assert.equal(r.rolledBack, 1);
});

test('줄 등록 실패(msg): 되돌리고 skipped', async () => {
  const erp = makeErp({ lineFailsAt: 1 });
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'skipped'); assert.match(r.reason, /^line_failed/);
  assert.equal(erp.srv.rows.length, 0); assert.equal(r.rolledBack, 1);
});

test('완료 실패: 줄 전부 되돌리고 skipped', async () => {
  const erp = makeErp({ completeFails: true });
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'skipped'); assert.match(r.reason, /^complete_failed/);
  assert.equal(r.rolledBack, 2); assert.equal(erp.srv.rows.length, 0);
});

test('되돌리기 실패 → fatal, oiRunAll 은 다음 주문장을 blocked 로 남긴다', async () => {
  const erp = makeErp({ completeFails: true, deleteFails: true });
  const rs = await C.oiRunAll([order(), Object.assign(order(), { key: 'B' })], erp, hooks);
  assert.equal(rs[0].status, 'fatal'); assert.match(rs[0].reason, /^rollback_failed/);
  assert.equal(rs[1].status, 'blocked');
});

test('고객 등록 실패: 줄 POST 없이 skipped', async () => {
  const erp = makeErp({ registerFails: true });
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'skipped'); assert.match(r.reason, /^register_failed/);
  assert.ok(!names(erp).includes('postLine'));
});

test('페이로드 문제(품위 옵션 없음): POST 없이 skipped', async () => {
  const erp = makeErp();
  const o = order([{ master: MASTER, spec: { k: '14', color: null, itemSize: '17', qty: 1, price: 17000, remark: '' } }]);
  const r = await C.oiRunOrder(o, erp, hooks);
  assert.equal(r.status, 'skipped'); assert.match(r.reason, /^payload:품위 옵션 없음/);
  assert.ok(!names(erp).includes('postLine'));
});

test('완료 응답은 성공인데 세션에 남으면 fatal(세션 오염 신호)', async () => {
  const erp = makeErp();
  erp.postComplete = async (fields) => { erp.calls.push(['postComplete']); return { ok: true, msg: '' }; };   // 서버가 비우지 않음
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'fatal'); assert.equal(r.reason, 'session_not_clear');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/orderimport-run.test.js`
Expected: FAIL — `TypeError: C.oiRunOrder is not a function`

- [ ] **Step 3: 구현** — `src/orderimport-core.js` 의 `  const api = {` 줄 바로 앞에 삽입


```js
  /* ------------------------------------------------- §3.4 실행기 (erp 주입) */
  //  erp 인터페이스(orderimport-erp.js 가 구현):
  //   state() → {tradeJun, client, rows:number}
  //   searchClient(type,word) → [{name,shop,phone,tel,seq}]
  //   registerClient(name, phone, clientJob) → {ok, msg, client:{seq,name,phone}|null}
  //   getWriteForm({tradeJun,master,client,clientName}) → oiReadWriteForm 결과
  //   postLine(fields) → {ok, msg, tradeJun, rows}
  //   getForm10({tradeJun,client,clientName}) → oiReadForm10 결과
  //   postComplete(fields) → {ok, msg}
  //   deleteLines(tradeJun, client, clientName, idxValues) → {ok, msg}
  //   findJunNums(orderSeqs) → [{orderSeq, junNum, status}]
  //  hooks: { today():Date, log(key, step, info) }
  async function oiRunOrder(order, erp, hooks) {
    const log = (step, info) => { try { hooks && hooks.log && hooks.log(order.key, step, info); } catch (_) {} };
    const res = { key: order.key, status: 'pending', reason: '', client: null, tradeJun: '', orderSeqs: [], idxValues: [], junNums: [], rolledBack: 0 };
    const fail = async (status, reason) => {
      res.reason = reason; log('fail', reason);
      if (res.idxValues.length) {
        const del = await erp.deleteLines(res.tradeJun, res.client ? res.client.seq : '', res.client ? res.client.name : '', res.idxValues.slice());
        log('rollback', del);
        //  되돌린 뒤 서버 목록에서 **내 orderSeq** 가 사라졌는지 확인. 남의 줄이 남아 있으면 세션이 남의 주문장에
        //  묶인 것이라 다음 주문장도 시작할 수 없다 → fatal(사람이 정리해야 한다).
        const after = await erp.getWriteForm({ tradeJun: res.tradeJun, master: '', client: res.client ? res.client.seq : '', clientName: res.client ? res.client.name : '' });
        const remain = (after.rows || []).map((r) => r.orderSeq);
        if (!del.ok || remain.some((s) => res.orderSeqs.includes(s))) { res.status = 'fatal'; res.reason = 'rollback_failed:' + reason; return res; }
        res.rolledBack = res.idxValues.length;
        if (remain.length) { res.status = 'fatal'; res.reason = 'foreign_rows_remain:' + reason; return res; }
      }
      res.status = status; return res;
    };
    try {
      const st = await erp.state();
      log('guard', st);
      if (st.tradeJun || st.rows > 0) { res.status = 'skipped'; res.reason = 'open_trade'; return res; }

      const byName = await erp.searchClient('clientName', order.clientName);
      const exact = byName.find((c) => c.name === order.clientName);
      if (exact) res.client = { seq: exact.seq, name: exact.name, mode: 'reuse' };
      else {
        let phone = order.phone && order.phone.phone ? order.phone.phone : '';
        if (phone) { const byPhone = await erp.searchClient('phone', phone); if (byPhone.some((c) => c.phone === phone)) phone = ''; }
        const reg = await erp.registerClient(order.clientName, phone, order.market.clientJob);
        log('register', reg);
        if (!reg.ok || !reg.client) { res.status = 'skipped'; res.reason = 'register_failed:' + (reg.msg || ''); return res; }
        res.client = { seq: reg.client.seq, name: order.clientName, mode: phone ? 'new' : 'new_nophone' };
      }

      for (let i = 0; i < order.lines.length; i++) {
        const ln = order.lines[i];
        const form = await erp.getWriteForm({ tradeJun: res.tradeJun, master: ln.master.seq, client: res.client.seq, clientName: res.client.name });
        const chk = oiCheckForm(form, { client: res.client.seq, master: ln.master.seq, tradeJun: res.tradeJun, orderSeqs: res.orderSeqs });
        if (!chk.ok) return await fail('skipped', 'mismatch:' + chk.reason);
        const built = oiLinePayload(form, ln.master, ln.spec);
        if (built.issues.length) return await fail('skipped', 'payload:' + built.issues.join(','));
        const post = await erp.postLine(built.fields);
        log('line', { i, ok: post.ok, msg: post.msg, tradeJun: post.tradeJun, rows: (post.rows || []).length });
        if (!post.ok) return await fail('skipped', 'line_failed:' + post.msg);
        const rows = post.rows || [];
        if (rows.length !== res.orderSeqs.length + 1) return await fail('skipped', 'rowcount:' + rows.length);
        const fresh = rows.filter((r) => !res.orderSeqs.includes(r.orderSeq));
        if (fresh.length !== 1 || fresh[0].code !== ln.master.code) return await fail('skipped', 'newrow:' + (fresh[0] ? fresh[0].code : 'none'));
        res.orderSeqs.push(fresh[0].orderSeq);
        res.idxValues.push(fresh[0].orderSeq + ',' + (fresh[0].tradeJun || post.tradeJun));
        res.tradeJun = post.tradeJun || fresh[0].tradeJun;
      }

      const f10 = await erp.getForm10({ tradeJun: res.tradeJun, client: res.client.seq, clientName: res.client.name });
      const fin = oiCheckFinal(f10, { client: res.client.seq, tradeJun: res.tradeJun, orderSeqs: res.orderSeqs, lines: order.lines });
      if (!fin.ok) return await fail('skipped', 'final:' + fin.reason);
      if (f10.missing && f10.missing.length) return await fail('skipped', 'form10 필드 누락: ' + f10.missing.join(','));
      const done = await erp.postComplete(oiForm10Payload(f10.values, hooks && hooks.today ? hooks.today() : new Date()));
      log('complete', done);
      if (!done.ok) return await fail('skipped', 'complete_failed:' + done.msg);
      const st2 = await erp.state();
      if (st2.tradeJun || st2.rows > 0) { res.status = 'fatal'; res.reason = 'session_not_clear'; return res; }
      try { res.junNums = await erp.findJunNums(res.orderSeqs.slice()); } catch (e) { res.junNums = []; log('junnum_error', String(e && e.message || e)); }
      res.status = 'done'; return res;
    } catch (e) {
      return await fail('skipped', 'exception:' + String(e && e.message || e));
    }
  }

  //  주문장 순차 실행. fatal 이면 즉시 중단(이후 주문장은 'blocked').
  async function oiRunAll(orders, erp, hooks) {
    const results = [];
    let halted = false;
    for (const o of orders) {
      if (halted) { results.push({ key: o.key, status: 'blocked', reason: 'halted' }); continue; }
      const r = await oiRunOrder(o, erp, hooks);
      results.push(r);
      try { hooks && hooks.onOrder && hooks.onOrder(r); } catch (_) {}
      if (r.status === 'fatal') halted = true;
    }
    return results;
  }
```

그리고 `const api = { … }` 블록을 아래로 **교체**(최종):


```js
  const api = {
    MARKETS, COLS, REQUIRED, FORM1_NAMES, FORM10_NAMES,
    oiMarket, oiHeaderMap, oiNormPhone, oiClientName, oiMoney, oiComma, oiRemark, oiParseRows,
    oiParseOption, oiColorFromCode, oiNormName, oiMapKeys, oiLookupMap, oiLearn, oiSuggestQueries,
    oiGroupOrders, oiLineIssues,
    oiSelectOptions, oiFieldValue, oiExtractFields, oiExtractHidden, oiExtractArrays,
    oiTListRows, oiWriteListRows, oiJunListRows, oiClientSearchRows, oiMasterSearchRows,
    oiReadWriteForm, oiReadForm10, oiResolveK, oiLinePayload, oiForm10Payload, oiSubmitResult,
    oiCheckForm, oiCheckFinal, oiRunOrder, oiRunAll
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof globalThis !== 'undefined') { globalThis.ubOi = api; }
})();
```

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/orderimport-parse.test.js tests/orderimport-form.test.js tests/orderimport-run.test.js`
Expected: `ℹ pass 32` / `ℹ fail 0`

- [ ] **Step 5: 변이 확인(가드가 실제로 쓰기를 막는지)** — `oiRunOrder` 의 `if (st.tradeJun || st.rows > 0) { … return res; }` 줄을 잠시 주석 처리하고 실행

Run: `node --test tests/orderimport-run.test.js`
Expected: `가드: 열린 주문장이 있으면 아무 쓰기도 하지 않고 skipped` 가 **FAIL**(KILL). 확인 후 원복하고 다시 32/32 통과 확인.

- [ ] **Step 6: 커밋**

```bash
git add src/orderimport-core.js tests/orderimport-run.test.js
git commit -m "feat(주문 가져오기): 실행기 oiRunOrder/oiRunAll — 가드·고객 확정·줄별 기대치 대조·되돌리기·완료 후 세션 확인 + 스텁 배선 테스트 11건"
```

---

### Task 4: erp 어댑터 · xls 브리지 · vendor · background · manifest · shell 인덱스 (배선 테스트)

**Files:**
- Create: `src/orderimport-erp.js`, `src/orderimport-xls.js`, `vendor/xlsx.full.min.js`
- Modify: `src/background.js:54-55`(onMessage 라우터 끝), `manifest.json`(content_scripts·version), `build-shell-index.ps1:16-26`(patterns)
- Test: `tests/orderimport-wiring.test.js` (Task 5 의 popup/skin 항목도 이 테스트에 들어 있다 — Task 5 전까지 그 2건은 FAIL 이 정상)

**Interfaces:**
- Consumes: `globalThis.ubOi`(Task 1~3), `globalThis.ubErp.decodeErpHtml`(`src/erp.js`, 헤더 무시 1인자 호출)
- Produces: `globalThis.ubOiErp` = Task 3 에 적은 erp 인터페이스 10개 · MAIN 브리지 메시지 계약 `{source:'ub-oi',type:'parse',id,buf}` → `{source:'ub-oi-xls',id,ok,rows|error}` · background 메시지 `{source:'ub',type:'ubOiInjectXls'}` → `{ok}`

- [ ] **Step 1: 배선 테스트 작성** — `tests/orderimport-wiring.test.js`


```js
/* =============================================================================
 *  orderimport-wiring.test.js — 주문 가져오기 배선 구조 회귀테스트(소스 문자열·manifest·shell 인덱스 대상).
 *  브라우저 API 가 필요한 파일(erp 어댑터·UI·xls 브리지)은 node 로 실행할 수 없으므로 "파싱된다 + 기대한
 *  이름을 노출한다 + manifest/shell/background 에 정확히 배선됐다" 를 고정한다.
 *  실행: node --test tests/orderimport-wiring.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const NEW_FILES = ['src/orderimport-core.js', 'src/orderimport-erp.js', 'src/orderimport.js', 'src/orderimport-xls.js', 'vendor/xlsx.full.min.js'];
const CONTENT_ORDER = ['src/erp.js', 'src/orderimport-core.js', 'src/orderimport-erp.js', 'src/orderimport.js'];
const SHEETJS_SHA256 = 'cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41';   // xlsx-0.20.3 xlsx.full.min.js

test('새 파일이 존재하고 문법 오류 없이 파싱된다', () => {
  for (const f of NEW_FILES) assert.ok(fs.existsSync(path.join(ROOT, f)), f + ' 없음');
  for (const f of ['src/orderimport-core.js', 'src/orderimport-erp.js', 'src/orderimport.js', 'src/orderimport-xls.js']) {
    // eslint-disable-next-line no-new-func
    assert.doesNotThrow(() => new Function(read(f)), f + ' 문법 오류');
  }
});

test('vendor/xlsx.full.min.js 는 SheetJS 0.20.3 full 빌드 그대로(해시 고정)', () => {
  const buf = fs.readFileSync(path.join(ROOT, 'vendor/xlsx.full.min.js'));
  assert.ok(buf.length > 900000, 'full 빌드가 아니다(mini 는 xls 를 못 읽는다)');
  assert.ok(buf.slice(0, 200).toString('utf8').includes('SheetJS'));
  assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), SHEETJS_SHA256);
});

test('manifest: orderItemWriteForm.do 에 erp → core → erp어댑터 → UI 순서로 ISOLATED 주입', () => {
  const man = JSON.parse(read('manifest.json'));
  const cs = man.content_scripts.find((c) => Array.isArray(c.js) && c.js.includes('src/orderimport.js'));
  assert.ok(cs, 'orderimport.js 를 싣는 content_scripts 항목이 없다');
  assert.deepEqual(cs.js, CONTENT_ORDER);
  assert.equal(cs.world, 'ISOLATED');
  assert.equal(cs.all_frames, false);
  assert.equal(cs.run_at, 'document_idle');
  assert.deepEqual(cs.matches, ['http://ubdstore.ubshop.biz/order/item/orderItemWriteForm.do*', 'https://ubdstore.ubshop.biz/order/item/orderItemWriteForm.do*']);
  assert.ok(man.permissions.includes('scripting'), 'SheetJS MAIN 주입에 scripting 권한이 필요하다');
  assert.ok(/^4\.2\.\d+$/.test(man.version), 'SHELL 버전은 4.2.x 여야 한다(4.1.9 → patch>9 규칙)');
});

test('background: ubOiInjectXls 가 vendor+브리지를 MAIN 에 파일 주입한다', () => {
  const bg = read('src/background.js');
  assert.ok(bg.includes("msg.type === 'ubOiInjectXls'"));
  const m = bg.match(/ubOiInjectXls[\s\S]{0,600}?executeScript\(\{[\s\S]*?\}\)/);
  assert.ok(m, 'ubOiInjectXls 핸들러 안에 executeScript 가 없다');
  assert.ok(/world:\s*'MAIN'/.test(m[0]));
  assert.ok(/files:\s*\['vendor\/xlsx\.full\.min\.js',\s*'src\/orderimport-xls\.js'\]/.test(m[0]), 'files 순서는 vendor → 브리지');
});

test('build-shell-index.ps1 patterns 에 새 파일 + src/erp.js 가 들어 있다(ExtSync 배포 대상)', () => {
  const ps1 = read('build-shell-index.ps1');
  for (const f of NEW_FILES.concat(['src/erp.js'])) assert.ok(ps1.includes("'" + f + "'"), f + ' 가 patterns 에 없다');
});

test('popup: 스위치 orderImport, 기본 ON', () => {
  assert.ok(read('popup/popup.html').includes('id="orderImport"'));
  const js = read('popup/popup.js');
  assert.ok(/ubOrderImport:\s*true/.test(js), 'popup.js D 에 ubOrderImport:true');
  assert.ok(js.includes("save({ ubOrderImport: orderImport.checked })"));
});

test('skin.js: 기본값 ubOrderImport:true, 주문 화면 판별, 섹션 버튼 #ub-oi-open 은 on(ubOrderImport) 게이트', () => {
  const skin = read('src/skin.js');
  assert.ok(/ubOrderImport:\s*true/.test(skin));
  assert.ok(skin.includes("function isOrderWrite() { return /\\/order\\/item\\/orderItemWriteForm\\.do/.test(location.pathname); }"));
  const sect = skin.match(/\$\{isOrderWrite\(\) && on\('ubOrderImport'\) \? `[\s\S]*?` : ''\}/);
  assert.ok(sect, '주문 가져오기 섹션 템플릿이 없다');
  assert.ok(sect[0].includes('id="ub-oi-open"'));
});

test('erp 어댑터·UI·브리지가 기대한 이름을 노출한다', () => {
  const erp = read('src/orderimport-erp.js');
  assert.ok(erp.includes('globalThis.ubOiErp = { state, searchClient, searchMaster, registerClient, getWriteForm, postLine, getForm10, postComplete, deleteLines, findJunNums };'));
  const ui = read('src/orderimport.js');
  assert.ok(ui.includes("closest('#ub-oi-open')"), 'UI 는 사이드바 버튼을 문서 위임으로 받는다');
  assert.ok(ui.includes("type: 'ubOiInjectXls'"));
  assert.ok(ui.includes("source: 'ub-oi', type: 'parse'"));
  const xls = read('src/orderimport-xls.js');
  assert.ok(xls.includes("d.source !== 'ub-oi' || d.type !== 'parse'"));
  assert.ok(xls.includes("source: 'ub-oi-xls'"));
});

test('core 는 ISOLATED 에서 globalThis.ubOi, node 에서 module.exports 로 같은 api 를 낸다', () => {
  const core = read('src/orderimport-core.js');
  assert.ok(core.includes('globalThis.ubOi = api;'));
  const api = require(path.join(ROOT, 'src', 'orderimport-core.js'));
  for (const n of ['oiParseRows', 'oiGroupOrders', 'oiReadWriteForm', 'oiReadForm10', 'oiLinePayload', 'oiForm10Payload', 'oiRunOrder', 'oiRunAll'])
    assert.equal(typeof api[n], 'function', n);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/orderimport-wiring.test.js`
Expected: FAIL — `src/orderimport-core.js` 만 있고 나머지 파일 없음(`새 파일이 존재하고…` 부터 실패)

- [ ] **Step 3: SheetJS 내려받기 + 해시 확인** (bash)

```bash
mkdir -p vendor
curl -sSL -o vendor/xlsx.full.min.js "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"
sha256sum vendor/xlsx.full.min.js
```
Expected: `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41  vendor/xlsx.full.min.js` (951,904 bytes). 다르면 **쓰지 말고** 버전/URL 을 다시 확인한다. 라이선스 Apache-2.0(CE).

- [ ] **Step 4: erp 어댑터** — `src/orderimport-erp.js`


```js
/* =============================================================================
 *  orderimport-erp.js — 유비샵 호출 어댑터 (ISOLATED). orderimport-core.js 의 oiRunOrder 가 이 인터페이스만 쓴다.
 *  전부 같은 도메인 fetch(credentials include). 폼 hidden 은 HTML 정규식(core)로 뽑는다 — DOMParser form.elements 함정 회피.
 *  Phase 0(2026-09-14) 에서 실제 주문 4건으로 검증한 요청 그대로. deleteLines 만 미실측(스펙 §4.2).
 *  스펙: docs/superpowers/specs/2026-09-14-orderimport-design.md §4
 * ========================================================================== */
(function () {
  'use strict';
  const C = globalThis.ubOi;
  if (!C) return;
  const TIMEOUT_MS = 30000;
  const dec = (globalThis.ubErp && globalThis.ubErp.decodeErpHtml)
    ? (u8) => globalThis.ubErp.decodeErpHtml(u8)                 // 헤더를 안 보고 score-both(collector·statis 와 같은 정책)
    : (u8) => new TextDecoder('utf-8').decode(u8);

  async function req(url, init) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, Object.assign({ credentials: 'include', signal: ctl.signal }, init || {}));
      const u8 = new Uint8Array(await r.arrayBuffer());
      return { url: r.url, status: r.status, html: dec(u8) };
    } finally { clearTimeout(timer); }
  }
  const post = (url, pairs) => {
    const fd = new URLSearchParams();
    (Array.isArray(pairs) ? pairs : Object.entries(pairs)).forEach(([k, v]) => fd.append(k, v == null ? '' : String(v)));
    return req(url, { method: 'POST', body: fd });
  };
  const enc = encodeURIComponent;
  const WRITE_URL = '/order/item/orderItemWriteForm.do?tcode=order_item';
  const POPUP_BASE = { formname: 'form1', url: '/order/item/orderItemWriteForm.do', actFlag: '1', shop: 'LT', shopName: 'FASHION' };

  //  '열린 주문장' 판정은 **파라미터 없는 GET** 으로만(완료된 tradeJun 을 명시하면 그 줄이 여전히 보인다 — 실측).
  async function state() {
    const r = await req(WRITE_URL + '&pageSize=20&searchSortType=seq');
    const f = C.oiReadWriteForm(r.html);
    return { tradeJun: f.values.tradeJun || '', client: f.values.client || '', rows: f.rows.length };
  }
  async function searchClient(type, word) {
    const r = await post('/etc/client.do?tcode=order_item', Object.assign({}, POPUP_BASE, { searchWordType: type, searchWord: word, pageSize: '100' }));
    return C.oiClientSearchRows(r.html);
  }
  async function searchMaster(word) {
    const r = await post('/etc/orderMasterItem.do?tcode=order_item', { formname: 'form1', url: '/order/item/orderItemWriteForm.do', actFlag: '1', jun: '', searchItemType: '', client: '', clientName: '', searchWord2: word, pageSize: '100', searchSortType: 'seq' });
    return C.oiMasterSearchRows(r.html);
  }
  //  등록 응답은 그 이름으로 검색된 고객검색 페이지로 리다이렉트된다(실측) → 그 행에서 seq 를 읽는다. 없으면 재검색.
  async function registerClient(name, phone, clientJob) {
    const g = await req('/etc/clientWriteForm.do?tcode=order_item&formname=form1&url=/order/item/orderItemWriteForm.do&actFlag=1&shop=LT&shopName=FASHION');
    const hidden = C.oiExtractHidden(g.html);
    if (!hidden.some(([n]) => n === 'sKey')) return { ok: false, msg: 'clientWriteForm sKey 없음', client: null };
    const d = new Date(); const p = (x) => String(x).padStart(2, '0');
    const fixed = {
      regShop: 'LT', clientName: name, phone: phone || '', tel: '', smsType: '1', emailType: '1', grade: '05',
      jumin1: '', jumin2: '', email: '', zipcode1: '', zipcode2: '', address: '', bunji: '', remark: '',
      inDate: '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()), clientType: '1', clientManager: '',
      sexType: '2', wedType: '0', birthDate: '', birthType: '1', birthLeapType: '0', weddingDate: '', weddingType: '1', weddingLeapType: '0',
      clientJob: clientJob || '', clientArea1: '', clientArea2: '', clientVisit1: '', clientVisit2Name: '',
      clientRelation3: '1', targetName3: '', clientMemorial3: '1', memorialDate3: '', memorialType3: '1', memorialLeapType3: '0',
      clientRelation4: '1', targetName4: '', clientMemorial4: '1', memorialDate4: '', memorialType4: '1', memorialLeapType4: '0',
      clientRelation5: '1', targetName5: '', clientMemorial5: '1', memorialDate5: '', memorialType5: '1', memorialLeapType5: '0'
    };
    const r = await post('/etc/clientWrite.do?tcode=order_item', hidden.concat(Object.entries(fixed)));
    const res = C.oiSubmitResult(r.url);
    let client = C.oiClientSearchRows(r.html).find((c) => c.name === name) || null;
    if (res.ok && !client) client = (await searchClient('clientName', name)).find((c) => c.name === name) || null;
    return { ok: res.ok && !!client, msg: res.msg || (client ? '' : '등록 후 고객을 찾지 못함'), client };
  }
  async function getWriteForm(p) {
    const r = await req(WRITE_URL + '&tradeJun=' + enc(p.tradeJun || '') + '&master=' + enc(p.master || '') + '&client=' + enc(p.client || '') + '&clientName=' + enc(p.clientName || ''));
    return C.oiReadWriteForm(r.html);
  }
  async function postLine(fields) {
    const r = await post('/order/item/orderItemWrite.do?tcode=order_item', fields);
    const res = C.oiSubmitResult(r.url);
    return { ok: res.ok, msg: res.msg, tradeJun: C.oiFieldValue(r.html, 'tradeJun') || '', rows: C.oiWriteListRows(r.html) };
  }
  async function getForm10(p) {
    const r = await req(WRITE_URL + '&tradeJun=' + enc(p.tradeJun || '') + '&client=' + enc(p.client || '') + '&clientName=' + enc(p.clientName || ''));
    return C.oiReadForm10(r.html);
  }
  async function postComplete(fields) {
    const r = await post('/jun/orderitem/orderItemJunWrite.do?tcode=order_item', fields);
    return C.oiSubmitResult(r.url);
  }
  //  되돌리기: 페이지 del(form2,form3) 그대로 — form3(sKey + idx…) 를 orderItemDelete.do + CONST_URL 로 POST. ⚠ 라이브 미실측(§4.2).
  async function deleteLines(tradeJun, client, clientName, idxValues) {
    const f = await getWriteForm({ tradeJun, master: '', client, clientName });
    const sKey = f.values.sKey || '';
    if (!sKey) return { ok: false, msg: 'sKey 없음' };
    const url = '/order/item/orderItemDelete.do?tcode=order_item&reqPage=1&pageSize=20&searchSortType=seq&tradeJun=' + enc(tradeJun || '')
      + '&payJun=&shop=LT&shopName=' + enc('FASHION') + '&client=' + enc(client || '') + '&clientName=' + enc(clientName || '');
    const pairs = [['sKey', sKey]].concat(idxValues.map((v) => ['idx', v]));
    const r = await post(url, pairs);
    return C.oiSubmitResult(r.url);
  }
  async function findJunNums(orderSeqs) {
    const r = await req('/jun/orderitem/orderItemList.do?tcode=order_item&pageSize=100&searchSortType=seq');
    const want = new Set(orderSeqs.map(String));
    return C.oiJunListRows(r.html).filter((x) => want.has(x.orderSeq));
  }

  globalThis.ubOiErp = { state, searchClient, searchMaster, registerClient, getWriteForm, postLine, getForm10, postComplete, deleteLines, findJunNums };
})();
```

- [ ] **Step 5: MAIN 브리지** — `src/orderimport-xls.js`


```js
/* =============================================================================
 *  orderimport-xls.js — MAIN world. background 가 vendor/xlsx.full.min.js 와 함께 주입한다(패널 첫 오픈 때).
 *  ISOLATED(orderimport.js) 가 postMessage 로 보낸 ArrayBuffer 를 SheetJS 로 읽어 행 배열(header:1)만 돌려준다.
 *  스펙: docs/superpowers/specs/2026-09-14-orderimport-design.md §3.1
 * ========================================================================== */
(function () {
  'use strict';
  if (window.__ubOiXls) return;
  window.__ubOiXls = true;
  window.addEventListener('message', function (e) {
    const d = e.data;
    if (!d || e.source !== window || d.source !== 'ub-oi' || d.type !== 'parse') return;
    let out;
    try {
      if (typeof XLSX === 'undefined') throw new Error('XLSX 미로드');
      const wb = XLSX.read(new Uint8Array(d.buf), { type: 'array' });
      const name = wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
      out = { ok: true, rows: rows, sheet: name };
    } catch (err) {
      out = { ok: false, error: String(err && err.message || err) };
    }
    window.postMessage(Object.assign({ source: 'ub-oi-xls', id: d.id }, out), '*');
  });
})();
```

- [ ] **Step 6: background 메시지** — `src/background.js` 의 onMessage 라우터에서 `if (msg.type === 'ubAutoEndJob') …` 줄 **바로 아래**(닫는 `});` 앞)에 추가

```js
  //  주문 가져오기: SheetJS(952KB) 를 패널 첫 오픈 때만 MAIN 에 파일 주입(ISOLATED 는 eval 이 막혀 있어 MAIN 이어야 한다).
  if (msg.type === 'ubOiInjectXls') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId == null) { sendResponse({ ok: false, error: 'no tab' }); return false; }
    chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['vendor/xlsx.full.min.js', 'src/orderimport-xls.js'] })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
```

- [ ] **Step 7: manifest** — `manifest.json`
  1. `"version": "4.1.9"` → `"version": "4.2.0"`
  2. `content_scripts` 배열에서 **skin.js 항목(`"js": ["src/skin.js"]`) 앞**에 아래 항목 추가

```json
    {
      "matches": [
        "http://ubdstore.ubshop.biz/order/item/orderItemWriteForm.do*",
        "https://ubdstore.ubshop.biz/order/item/orderItemWriteForm.do*"
      ],
      "js": ["src/erp.js", "src/orderimport-core.js", "src/orderimport-erp.js", "src/orderimport.js"],
      "run_at": "document_idle",
      "all_frames": false,
      "world": "ISOLATED"
    },
```

- [ ] **Step 8: shell 인덱스 patterns** — `build-shell-index.ps1` 의 `$patterns = @(` 배열에서 `'rules/cache.json'` 뒤에 추가(쉼표 주의)

```powershell
  'rules/cache.json',
  'src/erp.js',
  'src/orderimport-core.js',
  'src/orderimport-erp.js',
  'src/orderimport.js',
  'src/orderimport-xls.js',
  'vendor/xlsx.full.min.js'
```

- [ ] **Step 9: 확인**

Run: `node --test tests/orderimport-wiring.test.js`
Expected: `ℹ pass 7` / `ℹ fail 2` — 실패 2건은 `popup: 스위치 orderImport…` 와 `skin.js: 기본값 ubOrderImport…` 뿐이어야 한다(Task 5 대상). **`새 파일이 존재하고…` 는 아직 `src/orderimport.js` 가 없어 FAIL 이면 Task 5 의 Step 3 을 먼저 한 뒤 다시 확인.**

- [ ] **Step 10: 커밋**

```bash
git add src/orderimport-erp.js src/orderimport-xls.js vendor/xlsx.full.min.js src/background.js manifest.json build-shell-index.ps1 tests/orderimport-wiring.test.js
git commit -m "feat(주문 가져오기): 유비샵 fetch 어댑터·SheetJS MAIN 주입 브리지·manifest/background/shell 배선 (SHELL 4.2.0)"
```

---

### Task 5: UI — 사이드바 섹션 · 팝업 스위치 · 패널(파일 → 검토 표 → 실행 → 결과)

**Files:**
- Create: `src/orderimport.js`
- Modify: `src/skin.js:94`(D 기본값), `src/skin.js:554`(페이지 판별 근처), `src/skin.js:3423-3433`(사이드바 템플릿 — 메인석 입고 섹션 뒤), `popup/popup.html:72-75`, `popup/popup.js:9-13,15-21,24-32,40-44`
- Test: `tests/orderimport-wiring.test.js`(Task 4) 전부 통과 + 라이브(쓰기 0)

**Interfaces:**
- Consumes: `globalThis.ubOi`, `globalThis.ubOiErp`, background `ubOiInjectXls`, storage 키 `ubSkin`·`ubOrderImport`·`ubOiMap`·`ubOiLedger`
- Produces: 사이드바 버튼 `#ub-oi-open`(skin.js 가 그림, orderimport.js 가 문서 위임으로 받음) · 패널 `#ub-oi-panel` · storage `ubOiMap`(§2.4 형식) `ubOiLedger`(`{key:{at,tradeJun,junNums[],lines}}`)

- [ ] **Step 1: skin.js — 기본값·판별·섹션** (세 군데)

(a) `src/skin.js` D 객체의 `ubHqConfirm: false` 줄을 아래로 교체:
```js
    ubHqConfirm: false,
    // v4.2.0 판매처 주문 가져오기(orderimport.js) — 주문 화면 사이드바 버튼. 기본 ON.
    ubOrderImport: true
```

(b) `function isInboundWrite() {…}` 줄 **바로 위**에 추가:
```js
  function isOrderWrite() { return /\/order\/item\/orderItemWriteForm\.do/.test(location.pathname); }
```

(c) `renderSidebar()` 템플릿에서 `${isMainStoneWrite() ? \`…\` : ''}` 블록 **바로 뒤**(`${renderCacheSection()}` 앞)에 추가:
```js
      ${isOrderWrite() && on('ubOrderImport') ? `
        <div class="ub-sb-sect">
          <div class="ub-sb-sect-t">${ICONS.database}<span>주문 가져오기</span></div>
          <button class="ub-sb-btn ub-sb-wide" id="ub-oi-open">이지어드민 xls 불러오기</button>
          <div class="ub-sb-empty" style="margin-top:6px">파일 → 검토 → 등록 시작.<br>실행 중엔 주문 화면을 건드리지 마세요.</div>
        </div>
      ` : ''}
```

- [ ] **Step 2: 팝업 스위치**

`popup/popup.html` — `hqConfirm` 행(`<label class="sw"><input type="checkbox" id="hqConfirm">…</label>` 를 감싼 `<div class="row">…</div>`) **바로 뒤**에 추가:
```html
    <div class="row">
      <div class="label"><span class="name">주문 가져오기</span><span class="desc">판매처 주문 화면 사이드바에 이지어드민 xls 가져오기 버튼(실제로 주문을 씁니다)</span></div>
      <label class="sw"><input type="checkbox" id="orderImport"><span class="track"></span></label>
    </div>
```

`popup/popup.js` — 네 군데:
```js
  // (1) D
  const D = {
    ubSkin: false, ubDark: false, ubAutoSync: false,
    ubEditPopup: false, ubHqConfirm: false, ubOrderImport: true
  };
  // (2) 요소 — hqConfirm 줄 아래
  const orderImport = $('orderImport');
  // (3) render() — hqConfirm.checked 줄 아래 + disabled 배열에 추가
    orderImport.checked = !!s.ubOrderImport;
    [dark, autoSync, editPopup, hqConfirm, orderImport].forEach(el => { el.disabled = !s.ubSkin; });
  // (4) 리스너 — hqConfirm 리스너 아래
  orderImport.addEventListener('change', () => save({ ubOrderImport: orderImport.checked }));
```
(주석 첫 줄 `{ ubSkin:OFF, … ubHqConfirm:OFF }` 에 `ubOrderImport:ON` 을 덧붙인다.)

- [ ] **Step 3: 패널 UI** — `src/orderimport.js`


```js
/* =============================================================================
 *  orderimport.js — 판매처 주문 가져오기 UI·실행기 배선 (ISOLATED, orderItemWriteForm.do 전용).
 *  사이드바(skin.js) 의 [주문 가져오기] 버튼 → 패널: 파일 → 검토 표 → [등록 시작] → 진행/결과.
 *  로직은 orderimport-core.js(순수), 서버 호출은 orderimport-erp.js. 이 파일은 DOM·storage·배선만.
 *  스펙: docs/superpowers/specs/2026-09-14-orderimport-design.md §3·§5·§6
 * ========================================================================== */
(function () {
  'use strict';
  if (window.top !== window) return;
  if (!/\/order\/item\/orderItemWriteForm\.do/.test(location.pathname)) return;
  const C = globalThis.ubOi, E = globalThis.ubOiErp;
  if (!C || !E) { console.warn('[UB][oi] core/erp 미로드 — manifest 순서 확인'); return; }

  const KEY_MAP = 'ubOiMap', KEY_LEDGER = 'ubOiLedger', PANEL_ID = 'ub-oi-panel', STYLE_ID = 'ub-oi-style';
  const S = { enabled: false, map: {}, ledger: {}, orders: [], masters: {}, running: false, results: [], log: [], xlsReady: false, seq: 0, fileName: '' };

  /* ------------------------------------------------------------ storage */
  const sget = (q) => new Promise((res) => chrome.storage.local.get(q, res));
  const sset = (o) => new Promise((res) => chrome.storage.local.set(o, res));
  async function loadState() {
    const d = await sget({ ubSkin: false, ubOrderImport: true, [KEY_MAP]: {}, [KEY_LEDGER]: {} });
    S.enabled = !!(d.ubSkin && d.ubOrderImport);
    S.map = d[KEY_MAP] || {}; S.ledger = d[KEY_LEDGER] || {};
  }
  const saveMap = () => sset({ [KEY_MAP]: S.map });
  const saveLedger = () => sset({ [KEY_LEDGER]: S.ledger });

  /* ------------------------------------------------------------ xls (MAIN 주입) */
  function ensureXls() {
    if (S.xlsReady) return Promise.resolve(true);
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ source: 'ub', type: 'ubOiInjectXls' }, (r) => {
          if (chrome.runtime.lastError) { res(false); return; }
          S.xlsReady = !!(r && r.ok); res(S.xlsReady);
        });
      } catch (_) { res(false); }
    });
  }
  async function readXls(file) {
    if (!(await ensureXls())) throw new Error('엑셀 읽기 모듈을 못 불러왔습니다. 다시 시도하거나 브라우저를 재시작하세요.');
    const buf = await file.arrayBuffer();
    const id = 'oi' + (++S.seq) + '-' + Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener('message', on); reject(new Error('엑셀 읽기 응답 없음(20초)')); }, 20000);
      function on(e) {
        const d = e.data;
        if (!d || e.source !== window || d.source !== 'ub-oi-xls' || d.id !== id) return;
        clearTimeout(timer); window.removeEventListener('message', on);
        if (d.ok) resolve(d.rows); else reject(new Error(d.error || '엑셀 읽기 실패'));
      }
      window.addEventListener('message', on);
      window.postMessage({ source: 'ub-oi', type: 'parse', id, buf }, '*');
    });
  }

  /* ------------------------------------------------------------ 모델 */
  function refreshLine(line) {
    line.parsed = C.oiParseOption(line.optionText);
    line.keys = C.oiMapKeys(line.productName, line.parsed);
    line.mapping = C.oiLookupMap(S.map, line.keys);
    const entry = line.mapping ? line.mapping.entry : null;
    if (!line.spec) line.spec = {};
    const sp = line.spec;
    if (sp.k == null) sp.k = line.parsed.k;
    if (sp.color == null) sp.color = line.parsed.color;
    if (sp.itemSize == null) sp.itemSize = line.parsed.itemSize;
    if (sp.qty == null) sp.qty = line.qty;
    if (sp.price == null) sp.price = line.price;
    if (sp.remark == null || sp.remarkAuto !== false) { sp.remark = C.oiRemark(line.settle, entry && entry.remarkSuffix); sp.remarkAuto = true; }
    const form = entry ? S.masters[entry.seq] : null;
    line.issues = C.oiLineIssues(Object.assign({}, line, { price: sp.price, qty: sp.qty }), { mapping: line.mapping, parsed: Object.assign({}, line.parsed, { k: sp.k, color: sp.color, itemSize: sp.itemSize }), form });
  }
  function refreshOrder(o) {
    o.lines.forEach(refreshLine);
    o.ready = o.lines.every((l) => !l.issues.length) && !!o.market && o.phone.ok;
    if (o.checked == null || !o.ready) o.checked = o.ready;
    o.prev = S.ledger[o.key] || null;
  }
  function buildOrders(rows) {
    const pr = C.oiParseRows(rows);
    if (pr.error) throw new Error(pr.error);
    S.orders = C.oiGroupOrders(pr.lines);
    S.orders.forEach(refreshOrder);
  }
  //  읽기 전용 보강: 마스터 폼(k/색상 옵션·기본값)·고객 판정·추천 후보. 실패해도 검토 표는 뜬다.
  async function enrich() {
    const seqs = new Set();
    S.orders.forEach((o) => o.lines.forEach((l) => { if (l.mapping) seqs.add(l.mapping.entry.seq); }));
    for (const seq of seqs) {
      if (S.masters[seq]) continue;
      try { S.masters[seq] = await E.getWriteForm({ tradeJun: '', master: seq, client: '', clientName: '' }); } catch (e) { logLine('-', 'master_form_error', seq + ' ' + e.message); }
    }
    for (const o of S.orders) {
      if (o.customer || !o.market || !o.phone.ok) continue;
      try {
        const byName = await E.searchClient('clientName', o.clientName);
        const exact = byName.find((c) => c.name === o.clientName);
        if (exact) { o.customer = { mode: 'reuse', seq: exact.seq }; continue; }
        const byPhone = await E.searchClient('phone', o.phone.phone);
        o.customer = { mode: byPhone.some((c) => c.phone === o.phone.phone) ? 'new_nophone' : 'new' };
      } catch (e) { o.customer = { mode: 'unknown', error: e.message }; }
    }
    for (const o of S.orders) for (const l of o.lines) {
      if (l.mapping || l.suggest) continue;
      l.suggest = [];
      for (const q of C.oiSuggestQueries(l.productName).slice(0, 3)) {
        try { const hits = await E.searchMaster(q); if (hits.length) { l.suggest = hits.slice(0, 10); l.suggestQuery = q; break; } } catch (_) {}
      }
    }
    S.orders.forEach(refreshOrder);
  }

  /* ------------------------------------------------------------ 실행 */
  function logLine(key, step, info) {
    S.log.push({ t: new Date().toISOString(), key, step, info: (typeof info === 'string') ? info : JSON.parse(JSON.stringify(info || null)) });
    if (S.log.length > 5000) S.log.splice(0, S.log.length - 5000);
  }
  function toRunOrder(o) {
    return {
      key: o.key, seller: o.seller, orderNo: o.orderNo, market: o.market, buyer: o.buyer, phone: o.phone, clientName: o.clientName,
      lines: o.lines.map((l) => ({
        master: { seq: l.mapping.entry.seq, code: l.mapping.entry.code, name: l.mapping.entry.name, colorFallback: l.mapping.entry.colorFallback || '' },
        spec: { k: l.spec.k || null, color: l.spec.color || null, itemSize: l.spec.itemSize == null ? '' : String(l.spec.itemSize), qty: Number(l.spec.qty), price: Number(l.spec.price), remark: l.spec.remark || '' }
      }))
    };
  }
  async function run() {
    if (S.running) return;
    const targets = S.orders.filter((o) => o.checked && o.ready);
    if (!targets.length) { alert('실행할 주문장이 없습니다(문제 있는 주문장은 체크되지 않습니다).'); return; }
    if (!confirm(targets.length + '개 주문장(' + targets.reduce((n, o) => n + o.lines.length, 0) + '줄)을 유비샵에 등록합니다.\n실행 중에는 주문 화면을 조작하지 마세요. 진행할까요?')) return;
    S.running = true; S.results = [];
    window.addEventListener('beforeunload', onUnload);
    render();
    try {
      const results = await C.oiRunAll(targets.map(toRunOrder), E, {
        today: () => new Date(),
        log: logLine,
        onOrder: (r) => {
          S.results.push(r);
          if (r.status === 'done') { S.ledger[r.key] = { at: new Date().toISOString(), tradeJun: r.tradeJun, junNums: r.junNums.map((j) => j.junNum), lines: r.orderSeqs.length }; saveLedger(); }
          const o = S.orders.find((x) => x.key === r.key); if (o) { o.result = r; if (r.status === 'done') o.checked = false; }
          render();
        }
      });
      S.results = results;
    } catch (e) { logLine('-', 'run_exception', String(e && e.message || e)); alert('실행 중 오류: ' + (e && e.message || e)); }
    S.running = false;
    window.removeEventListener('beforeunload', onUnload);
    S.orders.forEach(refreshOrder);
    render();
  }
  function onUnload(e) { e.preventDefault(); e.returnValue = ''; }

  /* ------------------------------------------------------------ UI */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const CSS = `
#${PANEL_ID}{position:fixed;inset:24px;z-index:2147483647;background:#fff;border:1px solid #cfd6dd;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:flex;flex-direction:column;font:13px/1.45 Pretendard,"Malgun Gothic",sans-serif;color:#222}
#${PANEL_ID} *{box-sizing:border-box}
#${PANEL_ID} .oi-h{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #e6eaef;background:#f7f9fb;border-radius:10px 10px 0 0}
#${PANEL_ID} .oi-h b{font-size:15px}
#${PANEL_ID} .oi-h .oi-x{margin-left:auto;border:0;background:none;font-size:20px;cursor:pointer;color:#666}
#${PANEL_ID} .oi-b{flex:1;overflow:auto;padding:12px 14px}
#${PANEL_ID} .oi-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
#${PANEL_ID} .oi-btn{border:1px solid #b8c2cc;background:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px}
#${PANEL_ID} .oi-btn.pri{background:#4abcc7;border-color:#4abcc7;color:#fff;font-weight:700}
#${PANEL_ID} .oi-btn:disabled{opacity:.45;cursor:default}
#${PANEL_ID} .oi-lock{background:#fff4e5;border:1px solid #f0c36d;color:#7a4b00;padding:8px 12px;border-radius:6px;font-weight:700;margin-bottom:10px}
#${PANEL_ID} table.oi-t{width:100%;border-collapse:collapse;font-size:12px}
#${PANEL_ID} table.oi-t th,#${PANEL_ID} table.oi-t td{border:1px solid #e3e8ee;padding:4px 6px;vertical-align:top;text-align:left}
#${PANEL_ID} table.oi-t th{background:#f3f6f9;font-weight:600;white-space:nowrap}
#${PANEL_ID} tr.oi-o td{background:#eef7f8;font-weight:600}
#${PANEL_ID} tr.oi-o.bad td{background:#fdecec}
#${PANEL_ID} .oi-issue{color:#b42318;font-weight:600}
#${PANEL_ID} .oi-warn{background:#fff8e1}
#${PANEL_ID} input.oi-in{width:100%;border:1px solid #c9d2dc;border-radius:4px;padding:3px 5px;font-size:12px}
#${PANEL_ID} input.oi-in.sm{width:64px}
#${PANEL_ID} select.oi-in{width:100%;border:1px solid #c9d2dc;border-radius:4px;padding:3px;font-size:12px}
#${PANEL_ID} .oi-muted{color:#777}
#${PANEL_ID} .oi-res{margin-top:12px}
#${PANEL_ID} .st-done{color:#087a3f;font-weight:700}.st-skipped{color:#b45309;font-weight:700}.st-fatal,.st-blocked{color:#b42318;font-weight:700}
#ub-oi-veil{position:fixed;inset:0;z-index:2147483646;background:rgba(20,30,40,.35)}
`;
  function ensureStyle() { if (!document.getElementById(STYLE_ID)) { const s = document.createElement('style'); s.id = STYLE_ID; s.textContent = CSS; document.head.appendChild(s); } }

  function custText(o) {
    if (!o.customer) return '<span class="oi-muted">조회 전</span>';
    const m = o.customer.mode;
    if (m === 'reuse') return '재사용 #' + esc(o.customer.seq);
    if (m === 'new') return '신규 등록';
    if (m === 'new_nophone') return '신규 등록 <b>(휴대폰 비움 — 다른 고객이 사용 중)</b>';
    return '<span class="oi-issue">조회 실패</span>';
  }
  function lineRow(o, oi, l, li) {
    const e = l.mapping ? l.mapping.entry : null;
    const prod = e
      ? esc(e.name) + ' <span class="oi-muted">' + esc(e.code) + '</span> <button class="oi-btn" data-act="unmap" data-o="' + oi + '" data-l="' + li + '" title="매핑 지우기">✕</button>'
      : '<select class="oi-in" data-f="pick" data-o="' + oi + '" data-l="' + li + '"><option value="">— 유비샵 상품 선택' + (l.suggestQuery ? ' (검색어: ' + esc(l.suggestQuery) + ')' : '') + ' —</option>'
        + (l.suggest || []).map((s) => '<option value="' + esc(s.seq + '|' + s.code + '|' + s.name) + '">' + esc(s.name) + ' · ' + esc(s.code) + '</option>').join('')
        + '</select><div style="display:flex;gap:4px;margin-top:3px"><input class="oi-in" placeholder="직접 검색(공백 없이)" data-f="q" data-o="' + oi + '" data-l="' + li + '"><button class="oi-btn" data-act="search" data-o="' + oi + '" data-l="' + li + '">검색</button></div>';
    const inp = (f, v, cls) => '<input class="oi-in ' + (cls || 'sm') + '" data-f="' + f + '" data-o="' + oi + '" data-l="' + li + '" value="' + esc(v == null ? '' : v) + '">';
    const issues = l.issues.length ? '<div class="oi-issue">' + l.issues.map(esc).join('<br>') + '</div>' : '';
    return '<tr class="oi-l' + (l.issues.length ? ' oi-warn' : '') + '"><td></td><td colspan="2">' + esc(l.productName) + '<br><span class="oi-muted">' + esc(l.optionText || '(옵션 없음)') + '</span>' + issues + '</td>'
      + '<td>' + prod + '</td><td>' + inp('k', l.spec.k) + '</td><td>' + inp('color', l.spec.color) + '</td><td>' + inp('itemSize', l.spec.itemSize) + '</td>'
      + '<td>' + inp('qty', l.spec.qty) + '</td><td>' + inp('price', l.spec.price) + '</td><td>' + inp('remark', l.spec.remark, '') + '</td></tr>';
  }
  function orderRow(o, oi) {
    const st = o.result ? '<span class="st-' + esc(o.result.status) + '">' + esc(o.result.status) + '</span> ' + esc(o.result.reason || '') + (o.result.junNums && o.result.junNums.length ? ' · 관리번호 ' + o.result.junNums.map((j) => esc(j.junNum)).join(',') : '') : '';
    const prev = o.prev ? '<div class="oi-issue">이전에 넣음 ' + esc(String(o.prev.at).slice(0, 16).replace('T', ' ')) + (o.prev.junNums ? ' · ' + esc(o.prev.junNums.join(',')) : '') + '</div>' : '';
    return '<tr class="oi-o' + (o.ready ? '' : ' bad') + '"><td><input type="checkbox" data-f="chk" data-o="' + oi + '"' + (o.checked ? ' checked' : '') + (o.ready && !S.running ? '' : ' disabled') + '></td>'
      + '<td>' + esc(o.seller) + ' ' + esc(o.orderNo) + prev + '</td><td>' + (o.clientName ? esc(o.clientName) : '(' + esc(o.seller) + ' 미등록)') + '<br><span class="oi-muted">' + esc(o.phone.phone || o.phone.raw) + '</span></td>'
      + '<td colspan="7">' + custText(o) + (st ? ' · ' + st : '') + '</td></tr>' + o.lines.map((l, li) => lineRow(o, oi, l, li)).join('');
  }
  function render() {
    const p = document.getElementById(PANEL_ID); if (!p) return;
    const nOrd = S.orders.length, nReady = S.orders.filter((o) => o.ready).length, nChk = S.orders.filter((o) => o.checked && o.ready).length;
    const nLines = S.orders.reduce((n, o) => n + o.lines.length, 0);
    const done = S.results.filter((r) => r.status === 'done').length, skipped = S.results.filter((r) => r.status !== 'done').length;
    p.querySelector('.oi-b').innerHTML =
      (S.running ? '<div class="oi-lock">⏳ 실행 중 — 이 창과 유비샵 주문 화면을 조작하지 마세요 (' + S.results.length + '/' + nChk + ')</div>' : '')
      + '<div class="oi-bar"><input type="file" id="ub-oi-file" accept=".xls,.xlsx"' + (S.running ? ' disabled' : '') + '> '
      + (nOrd ? '<span>' + esc(S.fileName) + ' · 주문장 ' + nOrd + ' · 줄 ' + nLines + ' · 실행 가능 ' + nReady + ' · 체크 ' + nChk + '</span>' : '<span class="oi-muted">이지어드민 확장주문검색 xls(판매가 열 포함)를 선택하세요</span>')
      + '<span style="margin-left:auto"></span>'
      + '<button class="oi-btn pri" data-act="run"' + (nChk && !S.running ? '' : ' disabled') + '>등록 시작</button>'
      + '<button class="oi-btn" data-act="export-map">매핑표 내보내기</button><label class="oi-btn">매핑표 가져오기<input type="file" id="ub-oi-mapfile" accept=".json" hidden></label>'
      + '<button class="oi-btn" data-act="export-log">로그 JSON</button></div>'
      + (nOrd ? '<table class="oi-t"><thead><tr><th></th><th>판매처 · 주문번호</th><th>고객명 · 휴대폰</th><th>유비샵 상품</th><th>품위</th><th>색상</th><th>사이즈</th><th>수량</th><th>판매가</th><th>비고</th></tr></thead><tbody>'
        + S.orders.map(orderRow).join('') + '</tbody></table>' : '')
      + (S.results.length ? '<div class="oi-res"><b>결과</b> — 완료 ' + done + ' · 건너뜀/중단 ' + skipped + '<table class="oi-t"><thead><tr><th>주문장</th><th>상태</th><th>사유</th><th>고객</th><th>관리번호</th><th>되돌림</th></tr></thead><tbody>'
        + S.results.map((r) => '<tr><td>' + esc(r.key) + '</td><td class="st-' + esc(r.status) + '">' + esc(r.status) + '</td><td>' + esc(r.reason || '') + '</td><td>' + esc(r.client ? r.client.name + ' #' + r.client.seq + ' (' + r.client.mode + ')' : '') + '</td><td>' + esc((r.junNums || []).map((j) => j.junNum).join(', ')) + '</td><td>' + esc(r.rolledBack || 0) + '</td></tr>').join('')
        + '</tbody></table></div>' : '');
  }
  function openPanel() {
    ensureStyle();
    if (document.getElementById(PANEL_ID)) return;
    const veil = document.createElement('div'); veil.id = 'ub-oi-veil'; document.body.appendChild(veil);
    const p = document.createElement('div'); p.id = PANEL_ID;
    p.innerHTML = '<div class="oi-h"><b>주문 가져오기</b><span class="oi-muted">이지어드민 xls → 고객·줄 등록 → 주문장 완료</span><button class="oi-x" data-act="close" title="닫기">×</button></div><div class="oi-b"></div>';
    document.body.appendChild(p);
    p.addEventListener('click', onClick);
    p.addEventListener('change', onChange);
    render();
  }
  function closePanel() {
    if (S.running && !confirm('실행 중입니다. 정말 닫을까요? (진행 중인 주문장은 서버에 남을 수 있습니다)')) return;
    const p = document.getElementById(PANEL_ID); if (p) p.remove();
    const v = document.getElementById('ub-oi-veil'); if (v) v.remove();
  }
  function download(name, obj) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
    a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  async function onClick(e) {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'close') closePanel();
    else if (act === 'run') run();
    else if (act === 'export-map') download('ub-orderimport-map-' + new Date().toISOString().slice(0, 10) + '.json', S.map);
    else if (act === 'export-log') download('ub-orderimport-log-' + Date.now() + '.json', { results: S.results, log: S.log });
    else if (act === 'unmap') { const l = S.orders[+btn.dataset.o].lines[+btn.dataset.l]; l.keys.forEach((k) => { delete S.map[k]; }); l.suggest = null; await saveMap(); S.orders.forEach(refreshOrder); await enrich(); render(); }
    else if (act === 'search') {
      const l = S.orders[+btn.dataset.o].lines[+btn.dataset.l];
      const q = (btn.parentElement.querySelector('input[data-f="q"]') || {}).value || '';
      if (!q.trim()) return;
      try { l.suggest = (await E.searchMaster(q.replace(/\s+/g, ''))).slice(0, 10); l.suggestQuery = q; } catch (err) { alert('검색 실패: ' + err.message); }
      render();
    }
  }
  async function onChange(e) {
    const el = e.target;
    if (el.id === 'ub-oi-file') { const f = el.files && el.files[0]; if (f) await loadFile(f); return; }
    if (el.id === 'ub-oi-mapfile') { const f = el.files && el.files[0]; if (f) await importMap(f); return; }
    const f = el.dataset.f; if (!f) return;
    if (f === 'chk') { const o = S.orders[+el.dataset.o]; o.checked = el.checked && o.ready; render(); return; }
    const o = S.orders[+el.dataset.o]; const l = o.lines[+el.dataset.l];
    if (f === 'pick') {
      if (!el.value) return;
      const [seq, code, name] = el.value.split('|');
      S.map = C.oiLearn(S.map, l.keys, { seq, code, name }, new Date().toISOString());
      await saveMap();
      S.orders.forEach(refreshOrder);        // 같은 키의 다른 줄에도 즉시 전파
      await enrich(); render(); return;
    }
    if (f === 'k' || f === 'color') l.spec[f] = el.value.trim() || null;
    else if (f === 'itemSize') l.spec.itemSize = el.value.trim();
    else if (f === 'qty') l.spec.qty = C.oiMoney(el.value);
    else if (f === 'price') l.spec.price = C.oiMoney(el.value);
    else if (f === 'remark') { l.spec.remark = el.value; l.spec.remarkAuto = false; }
    refreshOrder(o); render();
  }
  async function loadFile(file) {
    try {
      S.fileName = file.name; S.results = []; S.orders = [];
      const rows = await readXls(file);
      buildOrders(rows);
      render();
      await enrich();
      render();
    } catch (err) { alert('파일을 읽지 못했습니다: ' + (err && err.message || err)); S.orders = []; render(); }
  }
  async function importMap(file) {
    try {
      const obj = JSON.parse(await file.text());
      if (!obj || typeof obj !== 'object') throw new Error('JSON 객체가 아닙니다');
      let n = 0; Object.keys(obj).forEach((k) => { if (obj[k] && obj[k].seq) { S.map[k] = obj[k]; n++; } });
      await saveMap(); S.orders.forEach(refreshOrder); render();
      alert(n + '개 항목을 매핑표에 합쳤습니다.');
    } catch (err) { alert('매핑표 가져오기 실패: ' + (err && err.message || err)); }
  }

  /* ------------------------------------------------------------ 배선 */
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('#ub-oi-open');
    if (!b) return;
    e.preventDefault();
    if (!S.enabled) { alert('팝업에서 [유비샵 스킨모드]와 [주문 가져오기]를 켜세요.'); return; }
    openPanel();
  }, true);
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.ubSkin || ch.ubOrderImport) loadState();
    if (ch[KEY_MAP] && !S.running) { S.map = ch[KEY_MAP].newValue || {}; S.orders.forEach(refreshOrder); render(); }
  });
  loadState();
})();
```

- [ ] **Step 4: 배선 테스트 전부 통과 + 기존 테스트 회귀 없음**

Run: `node --test tests/orderimport-wiring.test.js tests/orderimport-parse.test.js tests/orderimport-form.test.js tests/orderimport-run.test.js`
Expected: `ℹ pass 41` / `ℹ fail 0`

Run: `node tests/erp-wiring.test.js && node tests/loader-integrity.test.js`
Expected: 둘 다 기존처럼 통과(`Task1 sha256 vectors OK …` / erp-wiring `ok` 줄들). ⚠ loader-integrity 의 shell 인덱스 검사는 Task 6 에서 인덱스를 재생성한 뒤 다시 돌린다.

- [ ] **Step 5: 라이브 확인(쓰기 0) — 이 PC 의 안정 폴더에 복사해 검토 표까지**

ExtSync 가 20분마다 원격(4.1.9) 기준으로 덮어쓰므로 복사 후 **바로** 확인한다(되돌아가면 다시 복사).
```powershell
$dst = "$env:LOCALAPPDATA\D102LabelExtension"
New-Item -ItemType Directory -Force "$dst\vendor" | Out-Null
Copy-Item manifest.json,build-shell-index.ps1 $dst -Force
Copy-Item src\skin.js,src\background.js,src\erp.js,src\orderimport-core.js,src\orderimport-erp.js,src\orderimport.js,src\orderimport-xls.js "$dst\src" -Force
Copy-Item vendor\xlsx.full.min.js "$dst\vendor" -Force
Copy-Item popup\popup.html,popup\popup.js "$dst\popup" -Force
```
1. `chrome://extensions` → 유비샵 바코드 라벨 → **새로고침**(버전 4.2.0 표시 확인) → 팝업에서 [유비샵 스킨모드] ON, [주문 가져오기] ON 확인.
2. `http://ubdstore.ubshop.biz/order/item/orderItemWriteForm.do?tcode=order_item&pageSize=20&searchSortType=seq` 열기 → 사이드바에 "주문 가져오기" 섹션 + 버튼.
3. 버튼 → 패널 → 오늘 파일(`확장주문검색_20260914135539_739980638.xls`, 판매가 열 포함) 선택 → 주문장 6·줄 9 요약, 검토 표에 고객 판정(재사용/신규)·미매칭 줄의 추천 셀렉트가 보인다. F12 Network 에 `orderItemWrite.do`/`clientWrite.do`/`orderItemJunWrite.do` **POST 가 없어야 한다**(client.do/orderMasterItem.do 검색 POST·GET 만).
4. 추천에서 `F-퓨어컷팅(실버)R` 을 고르면 같은 상품의 다른 줄에도 즉시 전파되고, 팝업을 닫았다 열어도(storage) 매핑이 남는다. [매핑표 내보내기] 로 JSON 이 내려온다.
5. 사이드바 잠금·접기 등 다른 섹션이 그대로 동작한다(회귀).
6. 문제가 있으면 소스를 고쳐 복사·새로고침을 반복. 완료되면 스크린샷을 남긴다(검토 표 + Network 탭).

- [ ] **Step 6: 커밋**

```bash
git add src/orderimport.js src/skin.js popup/popup.html popup/popup.js
git commit -m "feat(주문 가져오기): 사이드바 섹션·팝업 스위치·패널(파일→검토 표→실행→결과, 매핑 학습·장부·JSON 입출력)"
```

---

### Task 6: 감독 하 라이브 실행 · 되돌리기 실측 · SHELL 배포

**Files:**
- Modify: `shell-files.json`(재생성), `docs/superpowers/specs/2026-09-14-orderimport-design.md`(§4.2 되돌리기 실측 결과 1줄), `docs/REVIEW-LEDGER.md`(검수 회차)

**Interfaces:** 없음(운영 절차)

- [ ] **Step 1: 사장님 감독 하 실제 1~2 주문장 실행** (Task 5 Step 5 의 안정 폴더 상태에서)
  1. 사장님이 주문 화면을 **건드리지 않는** 시간을 받는다. 파일에서 1~2 주문장만 체크(나머지 체크 해제) → [등록 시작] → 확인창.
  2. 진행 표가 주문장별로 `done` 이 되고 관리번호가 뜬다. 유비샵 주문전표(`/jun/orderitem/orderItemList.do`)에서 같은 관리번호·고객명·비고 확인.
  3. 로그 JSON 내보내기 → 단계별 판정에 `msg` 빈값·행 수 +1·세션 비움이 찍혀 있는지 본다.

- [ ] **Step 2: 되돌리기(deleteLines) 실측** — 스펙 §4.2 의 유일한 미실측 계약
  1. F12 콘솔(ISOLATED 컨텍스트 선택: 상단 컨텍스트 드롭다운에서 확장 이름)에서 읽기 상태 확인: `await ubOiErp.state()` → `{tradeJun:'', rows:0}`.
  2. 사장님 동의 하에 줄 1개를 넣고(패널 실행 대신 콘솔):
     `const f = await ubOiErp.getWriteForm({tradeJun:'', master:'7083', client:'<테스트 고객 seq>', clientName:'<그 고객명>'}); const p = ubOi.oiLinePayload(f, {seq:'7083', code:'F-RF-I-WG-PA-00F6'}, {k:'925', itemSize:'11', qty:1, price:17000, remark:'되돌리기 테스트'}); const r = await ubOiErp.postLine(p.fields); r`
  3. `await ubOiErp.deleteLines(r.tradeJun, '<seq>', '<고객명>', [r.rows[0].orderSeq + ',' + r.tradeJun])` → `{ok:true}` 그리고 `await ubOiErp.state()` → `rows:0`. tradeJun 이 비워지는지도 기록.
  4. 결과를 스펙 §4.2 되돌리기 행의 "(미실측…)" 자리에 한 줄로 적는다(비워지지 않으면 `oiRunOrder` 의 fatal 판정 근거가 바뀌므로 §5 도 같이 고친다).

- [ ] **Step 3: 검수 게이트(T3)** — 전역 지침 '검증 순서' 대로. 대상은 **이 브랜치의 diff**(파일 통째 금지). `docs/REVIEW-LEDGER.md` 의 '누적 판정' 을 브리프에 붙이고, 끝나면 회차를 기록한다(등급 T3 근거: 실행 코드 + 라이브 쓰기·삭제).
  - 채택된 지적이 0 이 될 때까지 수정 → 재검수. 수정마다 `node --test tests/orderimport-*.test.js` 32+9 통과 유지.

- [ ] **Step 4: SHELL 인덱스 재생성 → 무결성 테스트 → 푸시** (README 절차)

```powershell
pwsh -File build-shell-index.ps1
node tests/loader-integrity.test.js
git add shell-files.json docs/
git commit -m "chore(release): SHELL v4.2.0 — 판매처 주문 가져오기"
git push
```
Expected: `shell-files.json` 의 `version` 이 `4.2.0`, files 에 `vendor/xlsx.full.min.js`·`src/orderimport*.js`·`src/erp.js` 가 sha256 과 함께 있다. 푸시 뒤 ExtSync(20분 주기) 가 받아 다음 브라우저 재시작 때 반영된다.

- [ ] **Step 5: 완료 보고** — 관리번호·검수 회차·되돌리기 실측 결과·남은 리스크(두 번째 PC 매핑표 공유는 범위 외)를 사장님께 보고.
