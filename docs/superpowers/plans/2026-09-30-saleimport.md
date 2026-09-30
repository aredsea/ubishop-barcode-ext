# GS샵 판매 처리 가져오기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 상품판매 화면 사이드바에 atelier GS샵 판처 xlsx 를 올리면 고객·주문 줄·바코드·실판매가를 매칭한 검토 표를 보여 주고, 체크한 고객을 판매 처리한다.

**Architecture:** 주문 가져오기(`orderimport*`)와 같은 3층 — 순수 함수 `saleimport-core.js`(node 테스트) · fetch 어댑터 `saleimport-erp.js` · 패널/실행기 배선 `saleimport.js`. xlsx 읽기는 기존 `ubOiInjectXls` + `orderimport-xls.js` 재사용. 판매 쓰기 계약은 Task 4(Phase 0, 사장님 입회)에서 실측으로 확정한 뒤 Task 5~6 을 **이 문서에 보강**하고 진행한다.

**Tech Stack:** Chrome MV3 content script(ISOLATED) · 바닐라 JS · SheetJS 0.20.3(vendor) · `node --test`.

**스펙:** `docs/superpowers/specs/2026-09-30-saleimport-design.md`

## Global Constraints

- 판매처는 GS샵 하나. 고객명 = `수취인 + 휴대전화 숫자 뒤4 + '/G'`, **정확일치만 자동**(D5).
- 최종 = `W − X − Y합·W/ΣW − Z합·W/ΣW + AA합·W/ΣW`, 원 단위 반올림(0.5 올림). ΣW 는 반품 행 포함 전체 데이터 행.
- 반품(`주문유형 = 반품주문` 또는 수량 < 0) 제외(D3). 사은품 줄은 실판매가 0(D2). 판매전표 = 고객 1명당 1장(D6).
- 유비샵 폼 hidden 은 **HTML 문자열 정규식**으로 뽑는다(DOMParser `form.elements` 는 hidden 을 놓친다).
- `sKey` 는 쓰기 직전 GET 에서 받고, 그 GET 과 POST 사이에 다른 GET 을 끼우지 않는다.
- Task 4 완료 전에는 **판매 쓰기 요청을 라이브에 보내는 코드를 실행하지 않는다.**
- 로컬 테스트 중 트레이 D102LabelPrinter 는 끈다(ExtSync 가 stable 폴더를 main 으로 되돌림).
- 픽스처의 고객 휴대전화는 `0504-0000-<뒤4>` 로 치환한다(뒤4는 고객명 생성에 쓰이므로 유지). 이름은 원래 마스킹돼 있어 그대로.
- 검수 T3. 버전 4.2.9 → **4.3.0**(minor, SHELL).

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| Create `src/saleimport-core.js` | 순수 함수: 헤더·행 파싱, 최종금액·검산, 반품 분류, 고객명, 거래내역 HTML 파싱, 고객 단위 매칭·배분·판정, (Task 5) 실행기 |
| Create `src/saleimport-erp.js` | (Task 5) 유비샵 호출: 고객검색·주문/판매내역·판매 쓰기 |
| Create `src/saleimport.js` | (Task 6) 패널·검토 표·실행 배선 |
| Create `tests/saleimport-core.test.js` | Task 1~3 단위 테스트 |
| Create `tests/fixtures/saleimport/rows-gs.json` | 실제 xlsx 를 SheetJS 로 뽑은 행 배열(전화 치환) |
| Create `tests/fixtures/saleimport/trade-order-*.html`, `trade-sale-*.html` | 거래내역 화면 HTML(Task 2 에서 라이브 읽기로 캡처) |
| Create `tools/make-saleimport-fixture.js` | xlsx → rows-gs.json 생성기(재생성용) |
| Modify (Task 6) `manifest.json` `src/skin.js` `popup/popup.*` `build-shell-index.ps1` `tests/loader-integrity.test.js` | 배선·배포 |

core 노출: 브라우저 `globalThis.ubSl`, node `module.exports`. 고객검색 행 파서는 `orderimport-core.js` 의 `oiClientSearchRows` 를 재사용한다(Task 5 에서 manifest 가 `orderimport-core.js` 를 같이 싣는다).

---

### Task 1: xlsx 행 파싱과 최종 판처금액

**Files:**
- Create: `tools/make-saleimport-fixture.js`, `tests/fixtures/saleimport/rows-gs.json`, `src/saleimport-core.js`, `tests/saleimport-core.test.js`

**Interfaces:**
- Produces:
  - `slHeaderMap(header: string[]) → { idx: {orderNo,type,name,option,buyer,phone,qty,W,X,Y,Z,AA,final}: number, missing: string[] }`
  - `slMoney(v) → number | null` (`"29,400"`→29400, `"-288,120"`→-288120, `''`→null)
  - `slRound(x) → number` (0.5 는 0에서 먼 쪽으로)
  - `slParseSheet(rows: string[][]) → { ok: true, rows: Row[], totals: {Y,Z,AA} } | { ok: false, error: string }`
    - `Row = { r, orderNo, type, name, option, buyer, phone, qty, W, X, cachedFinal: number|null }`
  - `slComputeFinals(parsed) → { ok: true, rows: (Row & {Yr,Zr,AAr,final,amount})[], sumW } | { ok:false, error }` — `amount = slRound(final)`
  - `slIsReturn(row) → boolean`
  - `slClientName(buyer, phone) → string`

- [ ] **Step 1: 픽스처 생성기 작성**

`tools/make-saleimport-fixture.js`:
```js
//  사용: node tools/make-saleimport-fixture.js "<GS샵_판매처리_….xlsx>"  → tests/fixtures/saleimport/rows-gs.json
//  브라우저(orderimport-xls.js)와 같은 옵션으로 첫 시트를 읽고, 휴대전화만 0504-0000-<뒤4> 로 치환한다.
const X = require('../vendor/xlsx.full.min.js');
const fs = require('fs'), path = require('path');
const src = process.argv[2];
if (!src) { console.error('xlsx 경로가 필요합니다'); process.exit(1); }
const wb = X.read(fs.readFileSync(src), { type: 'buffer', cellText: true });
const rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
const pc = rows[0].indexOf('휴대전화');
for (let i = 1; i < rows.length; i++) {
  const d = String(rows[i][pc] || '').replace(/\D/g, '');
  if (d.length >= 4) rows[i][pc] = '0504-0000-' + d.slice(-4);
}
const out = path.join(__dirname, '..', 'tests', 'fixtures', 'saleimport', 'rows-gs.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(rows, null, 1));
console.log('rows', rows.length, '→', out);
```

- [ ] **Step 2: 픽스처 생성**

Run: `node tools/make-saleimport-fixture.js "C:/Users/D102/Downloads/GS샵_판매처리_20260911~20260920.xlsx"`
Expected: `rows 23 → …rows-gs.json`. 파일 2행 `휴대전화` = `0504-0000-3785`, 20행 첫 칸 `합계`, `반품유보`=`577,900`.

- [ ] **Step 3: 실패하는 테스트 작성**

`tests/saleimport-core.test.js`:
```js
/* saleimport-core 단위 테스트. 스펙: docs/superpowers/specs/2026-09-30-saleimport-design.md
 * 실행: node --test tests/saleimport-core.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'src', 'saleimport-core.js'));
const FX = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'saleimport', n), 'utf8');
const ROWS = JSON.parse(FX('rows-gs.json'));

test('slHeaderMap: 이름으로 찾고 공백 무시, 빠지면 missing', () => {
  const h = C.slHeaderMap(ROWS[0]);
  assert.deepEqual(h.missing, []);
  assert.equal(ROWS[0][h.idx.AA], '반품유보 지급');
  const cut = ROWS[0].filter((x) => x !== '협력사지급금액');
  assert.deepEqual(C.slHeaderMap(cut).missing, ['협력사지급금액']);
});

test('slMoney / slRound', () => {
  assert.equal(C.slMoney('29,400'), 29400);
  assert.equal(C.slMoney('-288,120'), -288120);
  assert.equal(C.slMoney(''), null);
  assert.equal(C.slMoney('abc'), null);
  assert.equal(C.slRound(28395.82), 28396);
  assert.equal(C.slRound(10.5), 11);
  assert.equal(C.slRound(-10.5), -11);
});

test('slParseSheet: 데이터 18행, 합계 행에서 Y·Z·AA 합', () => {
  const p = C.slParseSheet(ROWS);
  assert.equal(p.ok, true);
  assert.equal(p.rows.length, 18);
  assert.deepEqual(p.totals, { Y: 577900, Z: 66000, AA: 859200 });
  assert.equal(p.rows[0].orderNo, '3471785121');
  assert.equal(p.rows[0].W, 29400);
  assert.equal(p.rows[0].X, 2100);
  assert.equal(p.rows[7].X, 0);            // 할인쿠폰 빈칸 = 0
  assert.equal(p.rows[0].cachedFinal, null); // 수식만 있고 값 없음
});

test('slParseSheet: 합계 행·필수 열 없으면 거부', () => {
  assert.equal(C.slParseSheet(ROWS.filter((r) => r[0] !== '합계')).ok, false);
  const noCol = ROWS.map((r) => r.slice(0, 22));
  const p = C.slParseSheet(noCol);
  assert.equal(p.ok, false);
  assert.match(p.error, /협력사지급금액/);
});

test('slComputeFinals: 하*이 28,396 · 합 검산', () => {
  const f = C.slComputeFinals(C.slParseSheet(ROWS));
  assert.equal(f.ok, true);
  assert.equal(f.rows[0].amount, 28396);
  assert.equal(f.rows[1].amount, 75722);          // 민*금
  assert.equal(f.rows[13].amount, 537307);        // 박*주 수량 2 합계
  const sum = f.rows.reduce((s, r) => s + r.final, 0);
  assert.ok(Math.abs(sum - 5919640) < 0.01);
});

test('slComputeFinals: 캐시값이 1원 넘게 어긋나면 거부', () => {
  const rows = ROWS.map((r) => r.slice());
  const h = C.slHeaderMap(rows[0]);
  rows[1][h.idx.final] = '28,396';
  assert.equal(C.slComputeFinals(C.slParseSheet(rows)).ok, true);
  rows[1][h.idx.final] = '28,500';
  const bad = C.slComputeFinals(C.slParseSheet(rows));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /3471785121/);
});

test('slIsReturn / slClientName', () => {
  const p = C.slParseSheet(ROWS);
  assert.equal(C.slIsReturn(p.rows[11]), true);   // 반품주문
  assert.equal(C.slIsReturn(p.rows[0]), false);
  assert.equal(C.slClientName('하*이', '0504-0000-3785'), '하*이3785/G');
  assert.equal(C.slClientName('민*금', ''), '민*금/G');
});
```

- [ ] **Step 4: 실패 확인**

Run: `node --test tests/saleimport-core.test.js`
Expected: FAIL — `Cannot find module …saleimport-core.js`

- [ ] **Step 5: 구현**

`src/saleimport-core.js`:
```js
/* =============================================================================
 *  saleimport-core.js — GS샵 판매 처리 가져오기 **순수 함수** 모듈 (DOM·fetch·chrome 없음).
 *  ISOLATED content_script 로 saleItemWriteForm.do 에만 실리고, node 에서는 module.exports 로 테스트한다.
 *  스펙: docs/superpowers/specs/2026-09-30-saleimport-design.md
 *  노출: 브라우저 → globalThis.ubSl, node → module.exports (orderimport-core 와 같은 방식).
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------ §2.1 헤더 */
  const COLS = Object.freeze({
    orderNo: '주문번호', type: '주문유형', name: '상품명', option: '주문옵션', buyer: '수취인', phone: '휴대전화',
    qty: '수량', W: '협력사지급금액', X: '할인쿠폰', Y: '반품유보', Z: '딜광고', AA: '반품유보 지급', final: '최종 판처금액'
  });
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
  function slHeaderMap(header) {
    const idx = {}, missing = [];
    const h = (header || []).map(norm);
    Object.keys(COLS).forEach((k) => {
      const i = h.indexOf(norm(COLS[k]));
      if (i < 0) missing.push(COLS[k]); else idx[k] = i;
    });
    return { idx, missing };
  }

  function slMoney(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v == null ? '' : v).replace(/[,\s원]/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return Number(s);
  }
  function slRound(x) { return Math.sign(x) * Math.floor(Math.abs(x) + 0.5); }

  /* ------------------------------------------------------------ §2.1 파싱 */
  function slParseSheet(rows) {
    if (!Array.isArray(rows) || !rows.length) return { ok: false, error: '빈 파일' };
    const hm = slHeaderMap(rows[0]);
    if (hm.missing.length) return { ok: false, error: '필수 열 없음: ' + hm.missing.join(', ') };
    const ix = hm.idx;
    const cell = (r, k) => String(r[ix[k]] == null ? '' : r[ix[k]]).trim();
    const tIdx = rows.findIndex((r, i) => i > 0 && String(r[0] == null ? '' : r[0]).trim() === '합계');
    if (tIdx < 0) return { ok: false, error: '합계 행 없음' };
    const out = [];
    for (let i = 1; i < tIdx; i++) {
      const r = rows[i] || [];
      const orderNo = cell(r, 'orderNo');
      if (!orderNo) continue;
      const W = slMoney(cell(r, 'W')), qty = slMoney(cell(r, 'qty'));
      if (W == null) return { ok: false, error: orderNo + ': 협력사지급금액 없음' };
      if (qty == null || qty === 0) return { ok: false, error: orderNo + ': 수량 없음' };
      out.push({
        r: i, orderNo, type: cell(r, 'type'), name: cell(r, 'name'), option: cell(r, 'option'),
        buyer: cell(r, 'buyer'), phone: cell(r, 'phone'), qty, W, X: slMoney(cell(r, 'X')) || 0,
        cachedFinal: slMoney(cell(r, 'final'))
      });
    }
    if (!out.length) return { ok: false, error: '데이터 행 없음' };
    const t = rows[tIdx];
    const tot = (k) => slMoney(String(t[ix[k]] == null ? '' : t[ix[k]]).trim()) || 0;
    return { ok: true, rows: out, totals: { Y: tot('Y'), Z: tot('Z'), AA: tot('AA') } };
  }

  /* ------------------------------------------------------------ §2.2 최종금액 */
  function slComputeFinals(p) {
    if (!p || !p.ok) return { ok: false, error: (p && p.error) || '파싱 실패' };
    const sumW = p.rows.reduce((s, r) => s + r.W, 0);
    if (sumW === 0) return { ok: false, error: '협력사지급금액 합계가 0' };
    const T = p.totals;
    const rows = p.rows.map((r) => {
      const share = r.W / sumW;
      const Yr = T.Y * share, Zr = T.Z * share, AAr = T.AA * share;
      const final = r.W - r.X - Yr - Zr + AAr;
      return Object.assign({}, r, { Yr, Zr, AAr, final, amount: slRound(final) });
    });
    const bad = rows.find((r) => r.cachedFinal != null && Math.abs(r.cachedFinal - r.final) > 1);
    if (bad) return { ok: false, error: bad.orderNo + ': 파일의 최종 판처금액(' + bad.cachedFinal + ')과 계산값(' + slRound(bad.final) + ')이 다름' };
    const sumX = rows.reduce((s, r) => s + r.X, 0);
    const sumF = rows.reduce((s, r) => s + r.final, 0);
    if (Math.abs(sumF - (sumW - sumX - T.Y - T.Z + T.AA)) > 0.5) return { ok: false, error: '검산 불일치' };
    return { ok: true, rows, sumW };
  }

  /* ------------------------------------------------------------ §2.3 분류 · §3.1 고객명 */
  function slIsReturn(row) { return row.type === '반품주문' || row.qty < 0; }
  function slClientName(buyer, phone) {
    const d = String(phone == null ? '' : phone).replace(/\D/g, '');
    return String(buyer || '').trim() + (d.length >= 4 ? d.slice(-4) : '') + '/G';
  }

  const api = { COLS, slHeaderMap, slMoney, slRound, slParseSheet, slComputeFinals, slIsReturn, slClientName };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof globalThis !== 'undefined') { globalThis.ubSl = Object.assign(globalThis.ubSl || {}, api); }
})();
```

- [ ] **Step 6: 통과 확인**

Run: `node --test tests/saleimport-core.test.js`
Expected: PASS 7/7. (실패하면 기대값 대신 **구현**을 고친다 — 28,396 은 라이브 실판매가다.)

- [ ] **Step 7: 커밋**
```bash
git add tools/make-saleimport-fixture.js tests/fixtures/saleimport/rows-gs.json src/saleimport-core.js tests/saleimport-core.test.js
git commit -m "feat(판매 처리): xlsx 행 파싱·최종 판처금액 계산(saleimport-core)"
```

---

### Task 2: 고객 거래내역(주문내역·판매내역) 파서

**Files:**
- Create: `tests/fixtures/saleimport/trade-order-gift.html`, `trade-order-qty2.html`, `trade-order-sold.html`, `trade-sale-sold.html`, `trade-sale-empty.html`
- Modify: `src/saleimport-core.js`, `tests/saleimport-core.test.js`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `slTradeUrl(vcode: 'orderitem'|'saleitem', client: string, clientName: string) → string`
  - `slOrderRows(html) → OrderLine[]` — `OrderLine = { date: 'YY-MM-DD', barcode: string ('' 이면 없음), code, name, gift: boolean, settle: number|null, qty: number, price: number }`
  - `slSaleRows(html) → SaleLine[]` — `SaleLine = { date, barcode, code, price, qty, dc, amount }`

- [ ] **Step 1: 픽스처 캡처(읽기 전용, 사장님 PC Chrome — 파일 다운로드 승인 필요)**

유비샵에 로그인된 Chrome 탭 콘솔(또는 Claude in Chrome javascript_tool)에서 실행. **GET 만** 한다:
```js
const base = '/info/clienttrade/infoClientTradeView.do?tcode=sale_item&searchImageType=0&reqPage=1&pageSize=20&searchSortType=seq&url=/sale/item/saleItemWriteForm.do&shop=LT&shopName=FASHION';
const pick = [['trade-order-gift.html','orderitem',123476,'윤*하9203/G'],['trade-order-qty2.html','orderitem',123438,'박*주0248/G'],
  ['trade-order-sold.html','orderitem',123734,'하*이3785/G'],['trade-sale-sold.html','saleitem',123734,'하*이3785/G'],['trade-sale-empty.html','saleitem',123438,'박*주0248/G']];
for (const [f, v, c, n] of pick) {
  const h = await (await fetch(base + '&vcode=' + v + '&client=' + c + '&clientName=' + encodeURIComponent(n))).text();
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([h], { type: 'text/html' })); a.download = f; a.click();
}
```
받은 5개 파일을 `tests/fixtures/saleimport/` 로 옮기고, 각 파일에서 고객 상단 정보 표(핸드폰·전화번호 칸)의 번호 숫자를 `0504-0000-<뒤4>` 로 바꾼다. 목록 표는 건드리지 않는다.

- [ ] **Step 2: 실패하는 테스트 추가**

`tests/saleimport-core.test.js` 끝에 추가:
```js
test('slOrderRows: 사은품 포함 2줄', () => {
  const o = C.slOrderRows(FX('trade-order-gift.html'));
  assert.equal(o.length, 2);
  const main = o.find((x) => !x.gift), gift = o.find((x) => x.gift);
  assert.deepEqual([main.barcode, main.settle, main.qty, main.price], ['2609E8', 389900, 1, 557000]);
  assert.deepEqual([gift.barcode, gift.settle, gift.price], ['2604PG', null, 1400]);
  assert.equal(main.date, gift.date);
});

test('slOrderRows: 수량 2 는 정산 259,000 줄 2개', () => {
  const o = C.slOrderRows(FX('trade-order-qty2.html'));
  assert.deepEqual(o.map((x) => [x.barcode, x.settle]).sort(), [['2609RX', 259000], ['2609RY', 259000]]);
});

test('slSaleRows: 판매내역 바코드·실판매가, 빈 목록', () => {
  const s = C.slSaleRows(FX('trade-sale-sold.html'));
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].barcode, s[0].price, s[0].dc, s[0].amount], ['240CKK', 42000, 13604, 28396]);
  assert.deepEqual(C.slSaleRows(FX('trade-sale-empty.html')), []);
});

test('slTradeUrl', () => {
  const u = C.slTradeUrl('orderitem', '123734', '하*이3785/G');
  assert.match(u, /^\/info\/clienttrade\/infoClientTradeView\.do\?tcode=sale_item&vcode=orderitem&/);
  assert.match(u, /client=123734&/);
  assert.match(u, /clientName=%ED%95%98\*%EC%9D%B43785%2FG$/);
});
```

- [ ] **Step 3: 실패 확인** — Run: `node --test tests/saleimport-core.test.js` → Expected: 새 4건 FAIL(`C.slOrderRows is not a function`).

- [ ] **Step 4: 구현** — `src/saleimport-core.js` 의 `api` 선언 위에 추가하고 `api` 에 `slTradeUrl, slOrderRows, slSaleRows` 를 넣는다:
```js
  /* ------------------------------------------------------------ §3.2 거래내역 파싱 */
  //  목록 표는 헤더 셀(주문일/판매일)로 찾고, 각 <tr> 을 **행 텍스트 전체**로 본다(셀 묶음이 화면마다 달라도 견딘다).
  const BARCODE_RE = /(?:^|\s)(2[1-6](?=[0-9A-Z]{0,3}[A-Z])[0-9A-Z]{4})(?=\s|$)/;   // 년도 21~26 + 영숫자 4(영문 ≥1)
  const CODE_RE = /[A-Z]-[A-Z0-9]{2}-[A-Z]-[A-Z]{2}-[A-Z]{2}-[0-9A-Z]{4}/;
  const DATE_RE = /(\d\d-\d\d-\d\d)/;
  function textOf(h) {
    return String(h).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  }
  function listRows(html, headWord) {
    const s = String(html || '');
    const hi = s.search(new RegExp('<th[^>]*>[^<]*' + headWord));
    if (hi < 0) return [];
    const end = s.indexOf('</table>', hi);
    const seg = s.slice(hi, end < 0 ? undefined : end);
    return seg.split(/<tr\b/i).slice(1).map(textOf).filter((t) => DATE_RE.test(t) && /^\d+\s/.test(t));
  }
  const nums = (t) => (t.match(/-?\d[\d,]*(?:\.\d+)?/g) || []).map((x) => Number(x.replace(/,/g, '')));
  function slOrderRows(html) {
    return listRows(html, '주문일').map((t) => {
      const bc = t.match(BARCODE_RE); const code = t.match(CODE_RE);
      const st = t.match(/정산\s*([\d,]+)/);
      const tail = t.replace(/\s*\S+$/, '');                 // 끝의 접수직원 이름 제거
      const n = nums(tail);
      const after = code ? t.slice(t.indexOf(code[0]) + code[0].length).trim() : '';
      return {
        date: (t.match(DATE_RE) || [])[1] || '', barcode: bc ? bc[1] : '', code: code ? code[0] : '',
        name: after.split(' ')[0] || '', gift: /\(사은품\)/.test(t),
        settle: st ? Number(st[1].replace(/,/g, '')) : null, qty: n[n.length - 2], price: n[n.length - 1]
      };
    });
  }
  function slSaleRows(html) {
    return listRows(html, '판매일').map((t) => {
      const bc = t.match(BARCODE_RE); const code = t.match(CODE_RE);
      //  꼬리: … 판매가 수량 DC(DC율 %) 실판매가 판매직원  → 퍼센트 괄호를 빼고 숫자 4개
      const tail = t.replace(/\s*\S+$/, '').replace(/\([\d.]+\s*%\)/g, ' ');
      const n = nums(tail);
      return {
        date: (t.match(DATE_RE) || [])[1] || '', barcode: bc ? bc[1] : '', code: code ? code[0] : '',
        price: n[n.length - 4], qty: n[n.length - 3], dc: n[n.length - 2], amount: n[n.length - 1]
      };
    });
  }
  function slTradeUrl(vcode, client, clientName) {
    return '/info/clienttrade/infoClientTradeView.do?tcode=sale_item&vcode=' + vcode
      + '&searchImageType=0&reqPage=1&pageSize=100&searchSortType=seq&url=/sale/item/saleItemWriteForm.do'
      + '&shop=LT&shopName=FASHION&client=' + encodeURIComponent(client) + '&clientName=' + encodeURIComponent(clientName);
  }
```
주의: 판매직원 칸이 `홍해진(12345)` 처럼 연결번호를 붙이면 `\S+$` 한 토큰으로 지워진다. 픽스처로 확인하고, 다르면 **픽스처에 맞게** 꼬리 처리만 고친다.

- [ ] **Step 5: 통과 확인** — Run: `node --test tests/saleimport-core.test.js` → Expected: PASS 11/11.

- [ ] **Step 6: 라이브 대조(읽기)** — 스펙 §3.1 의 자동 13고객 전원에 대해 Chrome 에서 core 를 붙여 `slOrderRows` 결과의 `settle` 이 엑셀 `W/qty` 와 같은 줄이 있는지 확인한다. 불일치가 있으면 원인을 적고 멈춘다.

- [ ] **Step 7: 커밋**
```bash
git add src/saleimport-core.js tests/saleimport-core.test.js tests/fixtures/saleimport/*.html
git commit -m "feat(판매 처리): 고객 주문내역·판매내역 파서"
```

---

### Task 3: 고객 단위 매칭·배분·판정

**Files:**
- Modify: `src/saleimport-core.js`, `tests/saleimport-core.test.js`

**Interfaces:**
- Consumes: Task 1 `Row & {amount}`, Task 2 `OrderLine`, `SaleLine`
- Produces:
  - `slAllocate(total: number, q: number) → number[]` (합 = total, 나머지는 첫 칸)
  - `slGroupByClient(rows) → Group[]` — 반품 제외 행을 `slClientName` 으로 묶음. `Group = { key: expectedName, rows: Row[], client: null }`
  - `slMatchClient(rows: Row[], orders: OrderLine[], sales: SaleLine[]) → Match`
    - `Match = { status: 'ok'|'sold'|'block', reason: string, lines: SaleLinePlan[], cash: number }`
    - `SaleLinePlan = { barcode, code, name, gift, orderNo, amount }`

- [ ] **Step 1: 실패하는 테스트 추가**
```js
const R = (over) => Object.assign({ orderNo: 'A', qty: 1, W: 0, amount: 0 }, over);
const O = (over) => Object.assign({ date: '26-09-10', barcode: '', code: 'F-XX-Z-XX-ZZ-0001', name: 'x', gift: false, settle: null, qty: 1, price: 0 }, over);

test('slAllocate', () => {
  assert.deepEqual(C.slAllocate(537307, 2), [268654, 268653]);
  assert.deepEqual(C.slAllocate(100, 1), [100]);
});

test('slMatchClient: 본품+같은 날 사은품(0원), 현금 = 본품', () => {
  const m = C.slMatchClient([R({ orderNo: 'G1', W: 389900, amount: 376583 })],
    [O({ barcode: '2609E8', settle: 389900 }), O({ barcode: '2604PG', gift: true }), O({ barcode: '2604ZZ', gift: true, date: '26-01-01' })], []);
  assert.equal(m.status, 'ok');
  assert.deepEqual(m.lines.map((l) => [l.barcode, l.amount, l.gift]), [['2609E8', 376583, false], ['2604PG', 0, true]]);
  assert.equal(m.cash, 376583);
});

test('slMatchClient: 수량 2 → 정산 W/2 줄 2개, 금액 배분', () => {
  const m = C.slMatchClient([R({ orderNo: 'G2', qty: 2, W: 518000, amount: 537307 })],
    [O({ barcode: '2609RY', settle: 259000 }), O({ barcode: '2609RX', settle: 259000 })], []);
  assert.equal(m.status, 'ok');
  assert.deepEqual(m.lines.map((l) => l.amount), [268654, 268653]);
});

test('slMatchClient: 이미 판매됨', () => {
  const m = C.slMatchClient([R({ W: 29400, amount: 28396 })], [O({ barcode: '240CKK', settle: 29400 })], [{ barcode: '240CKK' }]);
  assert.equal(m.status, 'sold');
});

test('slMatchClient: 차단 — 후보 0 · 후보 과다 · 바코드 없음 · 금액 0 이하', () => {
  assert.equal(C.slMatchClient([R({ W: 1, amount: 1 })], [O({ barcode: '2609AA', settle: 2 })], []).status, 'block');
  assert.equal(C.slMatchClient([R({ W: 5, amount: 5 })], [O({ barcode: '2609AA', settle: 5 }), O({ barcode: '2609AB', settle: 5 })], []).status, 'block');
  const nb = C.slMatchClient([R({ W: 5, amount: 5 })], [O({ barcode: '', settle: 5 })], []);
  assert.equal(nb.status, 'block'); assert.match(nb.reason, /바코드/);
  assert.equal(C.slMatchClient([R({ W: 5, amount: 0 })], [O({ barcode: '2609AA', settle: 5 })], []).status, 'block');
});

test('slMatchClient: 같은 고객 두 행(다른 정산액)은 한 전표', () => {
  const m = C.slMatchClient([R({ orderNo: 'a', W: 10, amount: 9 }), R({ orderNo: 'b', W: 20, amount: 19 })],
    [O({ barcode: '2609AA', settle: 10 }), O({ barcode: '2609AB', settle: 20 })], []);
  assert.equal(m.status, 'ok');
  assert.equal(m.cash, 28);
});

test('slGroupByClient: 반품 제외, 이름 키로 묶음', () => {
  const f = C.slComputeFinals(C.slParseSheet(ROWS));
  const g = C.slGroupByClient(f.rows);
  assert.equal(g.length, 17);
  assert.ok(!g.some((x) => x.key === '박*미4371/G'));
  assert.ok(g.some((x) => x.key === '민*금/G'));
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test tests/saleimport-core.test.js` → Expected: 새 7건 FAIL.

- [ ] **Step 3: 구현** — `api` 선언 위에 추가, `api` 에 `slAllocate, slGroupByClient, slMatchClient` 추가:
```js
  /* ------------------------------------------------------------ §3.2~3.3 매칭·배분 */
  function slAllocate(total, q) {
    const base = Math.floor(total / q);
    const out = new Array(q).fill(base);
    out[0] += total - base * q;
    return out;
  }
  function slGroupByClient(rows) {
    const map = new Map();
    rows.filter((r) => !slIsReturn(r)).forEach((r) => {
      const key = slClientName(r.buyer, r.phone);
      if (!map.has(key)) map.set(key, { key, rows: [], client: null });
      map.get(key).rows.push(r);
    });
    return [...map.values()];
  }
  //  고객 한 명: 같은 단가(W/qty) 끼리 필요 개수를 모아, 판매 안 된 본품 줄이 **정확히 그 개수**일 때만 자동.
  function slMatchClient(rows, orders, sales) {
    const sold = new Set((sales || []).map((s) => s.barcode).filter(Boolean));
    const block = (reason) => ({ status: 'block', reason, lines: [], cash: 0 });
    const need = new Map();   // unit → [{row, amounts[]}]
    for (const r of rows) {
      if (!(r.amount > 0)) return block(r.orderNo + ': 실판매가가 0 이하');
      const unit = r.W / r.qty;
      if (!Number.isInteger(unit)) return block(r.orderNo + ': 협력사지급금액이 수량으로 나누어지지 않음');
      if (!need.has(unit)) need.set(unit, []);
      need.get(unit).push({ row: r, amounts: slAllocate(r.amount, r.qty) });
    }
    const lines = [], usedDates = new Set();
    let soldOnly = true;
    for (const [unit, list] of need) {
      const n = list.reduce((s, x) => s + x.row.qty, 0);
      const mains = orders.filter((o) => !o.gift && o.settle === unit);
      const open = mains.filter((o) => !o.barcode || !sold.has(o.barcode));
      if (open.length === 0 && mains.length >= n) continue;             // 전부 이미 판매됨
      soldOnly = false;
      if (open.length !== n) return block('정산 ' + unit.toLocaleString('en-US') + ' 주문 줄 ' + open.length + '개 (필요 ' + n + '개)');
      if (open.some((o) => !o.barcode)) return block('바코드 없는 주문 줄 — 입고 확인');
      let k = 0;
      for (const { row, amounts } of list) for (const a of amounts) {
        const o = open[k++];
        lines.push({ barcode: o.barcode, code: o.code, name: o.name, gift: false, orderNo: row.orderNo, amount: a });
        usedDates.add(o.date);
      }
    }
    if (soldOnly) return { status: 'sold', reason: '이미 판매됨', lines: [], cash: 0 };
    orders.filter((o) => o.gift && o.barcode && !sold.has(o.barcode) && usedDates.has(o.date))
      .forEach((o) => lines.push({ barcode: o.barcode, code: o.code, name: o.name, gift: true, orderNo: '', amount: 0 }));
    return { status: 'ok', reason: '', lines, cash: lines.reduce((s, l) => s + l.amount, 0) };
  }
```
주의: 한 고객 안에서 일부 단가는 이미 판매, 일부는 미판매면 미판매만 처리한다(`continue`). 이것이 테스트 의도와 맞는지 Step 4 에서 확인.

- [ ] **Step 4: 통과 확인** — Run: `node --test tests/saleimport-core.test.js` → Expected: PASS 18/18.

- [ ] **Step 5: 커밋**
```bash
git add src/saleimport-core.js tests/saleimport-core.test.js
git commit -m "feat(판매 처리): 고객 단위 주문 줄 매칭·실판매가 배분·사은품 0원"
```

---

### Task 4: Phase 0 — 판매 쓰기 계약 실측 (HITL, 사장님 입회 필수)

**Files:**
- Modify: `docs/superpowers/specs/2026-09-30-saleimport-design.md` §4·§5 (실측 표로 교체)
- Create: `tests/fixtures/saleimport/saleform-*.html`, `modifyform.html`, `cashpay-form.html` (응답 캡처, 전화 치환)

대상 고객: `민*금2837/G`(#123699) — 주문 줄 `2504L5`, 실판매가 **75,722**, 사은품 없음.

- [ ] **Step 1: 사장님께 시작 알림·동의** — "지금부터 민*금2837/G 한 건을 실제로 판매합니다. 그동안 유비샵 판매·결제 화면을 만지지 말아 주세요." 동의 없으면 멈춘다.
- [ ] **Step 2: 가드(읽기)** — plain GET `saleItemWriteForm.do?tcode=sale_item&pageSize=20&searchSortType=seq` → `tradeJun` 빈값·목록 0행 확인. 아니면 멈추고 보고.
- [ ] **Step 3: 화면으로 1건 진행하며 네트워크 기록** — Claude in Chrome 으로 사장님이 평소 하던 순서대로(고객 선택 → 바코드 `2504L5` Enter → 줄 수정에서 실판매가 75,722 → 결제 현금 75,722 → 판매하기) 진행하며, 각 단계에서 `read_network_requests` 로 POST URL·폼 필드·리다이렉트 URL(`msg`)을 기록한다. **각 쓰기 클릭 전에 사장님 확인을 받는다.**
- [ ] **Step 4: 확인 항목 기록** — (a) 줄 등록 응답에 새 tradeJun 이 hidden 으로 오는지 (b) 실판매가 입력 필드 이름과 DC 계산 주체(클라이언트/서버) (c) 현금결제 POST 필드와 판매폼 결제 합계 반영 (d) 판매하기 form10 필드 값(payCash 등) (e) 완료 후 plain GET 세션 비움 (f) 판매내역에 `2504L5 … 실판매가 75,722` (g) 판매 줄 삭제 form3 계약 — **삭제는 실행하지 않고** HTML 의 `del()` 스크립트와 form3 필드만 기록.
- [ ] **Step 5: 스펙 §4 를 실측 표로 교체·커밋**
```bash
git add docs/superpowers/specs/2026-09-30-saleimport-design.md tests/fixtures/saleimport/
git commit -m "docs(판매 처리): Phase 0 판매 쓰기 계약 실측(민*금 1건)"
```
- [ ] **Step 6: 이 계획서에 Task 5·6 상세(코드 포함)를 보강하고 커밋** — 아래 개요를 실측 필드로 구체화한다.

---

### Task 5 (개요 — Task 4 후 상세화): 어댑터와 실행기

- `src/saleimport-erp.js` — `orderimport-erp.js` 의 `req/post/assertUbdstore` 패턴 그대로. 함수: `state()` · `searchClient(word)`(`/etc/client.do?tcode=sale_item`, `oiClientSearchRows` 재사용) · `trade(vcode, client, clientName)` · 판매 쓰기 4종(Task 4 실측 이름) · `deleteLines`.
- `saleimport-core.js` 에 `slRunClient(plan, erp, hooks)` / `slRunAll` — 스펙 §4 흐름 1~6, fatal 이면 이후 'blocked'. 결제 전 실패 → 내 줄 삭제 후 다음, 결제 후 실패 → fatal.
- 테스트 `tests/saleimport-run.test.js`: 가짜 erp 로 (1) 가드 실패 시 쓰기 0 (2) 세션 client 불일치 시 결제·판매 POST 0 + 내 줄만 삭제 (3) 결제 후 실패 → fatal·이후 blocked (4) 최종 대조 실패 시 결제 POST 0. 변이(가드 제거·대조 제거)로 테스트가 실패하는지 확인.

### Task 6 (개요 — Task 4 후 상세화): 패널·배선·배포

- `src/saleimport.js`: orderimport.js 의 `ensureXls/readXls`(같은 `ubOiInjectXls`·`ub-oi` 메시지) · 파일 → `slParseSheet`/`slComputeFinals` → `slGroupByClient` → 고객 조회(정확일치 자동, 아니면 검색창) → 거래내역 읽기 → `slMatchClient` → 검토 표(차단/제외/이미 판매, 기본 체크) → [판매 시작] → 진행·결과·로그 JSON. 실행 중 패널 잠금·`beforeunload`.
- `src/skin.js`: `isSaleWrite()` 페이지에 `ubSaleImport` 섹션(버튼 `#ub-sl-open`), 기본값 `ubSaleImport: true`.
- `popup/popup.html/js`: 스위치 "판매 처리 가져오기".
- `manifest.json`: content_scripts `saleItemWriteForm.do` → `src/erp.js, src/orderimport-core.js, src/saleimport-core.js, src/saleimport-erp.js, src/saleimport.js`; version `4.3.0`.
- `build-shell-index.ps1` `$patterns` + `tests/loader-integrity.test.js` `SHELL_PATTERNS` 에 saleimport 3파일 추가 → `pwsh -File build-shell-index.ps1` → `node --test tests/loader-integrity.test.js`.
- UI 는 렌더 스크린샷(데스크톱)으로 확인.

### Task 7: 검수(T3)·라이브 첫 실행

- gate: `node --test tests/saleimport-*.test.js tests/loader-integrity.test.js` 전부 PASS.
- 검수 T3: 외부 1명(Terra) 반복 + Opus 5.5 가 아닌 Opus 4.7/4.6(메인 Opus 가 직접 짠 코드일 때) + 교차 DeepSeek + Fable 자리(되돌리기 어려운 라이브 쓰기 — 단 `feedback_no_fable_review` 메모리(09-15 호출 금지)가 있으므로 **착수 전 사장님께 Fable 자리 여부를 묻는다**). 원장 `docs/REVIEW-LEDGER.md` 갱신.
- 라이브: 사장님 입회로 1~2 고객만 체크해 실행 → 판매내역 대조 → main 머지·push → ExtSync.
