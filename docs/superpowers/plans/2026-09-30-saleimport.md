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

- [x] **Step 1: 픽스처 캡처 — 완료(2026-09-30, 컨트롤러)**

`tests/fixtures/saleimport/trade-*.html` 5개는 라이브 화면에서 **목록 표(`table.t_list`)만** 떠서 class·id 외 속성을 지운 것이다(전화번호 없음). 실측 구조:
- 헤더 행은 `<tr class="title_line">`(셀은 `<td>`, `<th>` 아님). 그 위에 합계 행 `<tr class="sum">`.
- **각 데이터 행의 이미지 칸 안에 중첩 `<table><tr><td><img></td></tr></table>` 이 있다** → `<tr` 로 단순 split 하면 행이 쪼개진다. 행은 중첩 깊이를 세서 **바깥 표의 최상위 `<tr>`** 만 잘라야 한다.
- 판매내역 DC 칸은 `13,604<br>(32.39 %)`, 판매직원 칸은 `홍해진`(연결번호 없음).
- 사은품 줄의 비고 칸은 `<span class="f_green"></span>`(빈 칸). `trade-order-qty2.html` 은 위스퍼샤인 2줄 + **사은품 1줄(2604P6)** = 3줄.
- 판매내역의 상품번호가 주문내역과 다를 수 있다(`F-BF-Z-XY-…` vs `F-BF-Z-XX-…`) → 매칭에 상품번호를 쓰지 않는다.
- 빈 판매내역은 `<td>검색된 판매내역이 없습니다.</td>` 한 행.

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

test('slOrderRows: 수량 2 는 정산 259,000 줄 2개 + 사은품 1줄', () => {
  const o = C.slOrderRows(FX('trade-order-qty2.html'));
  assert.equal(o.length, 3);
  assert.deepEqual(o.filter((x) => !x.gift).map((x) => [x.barcode, x.settle, x.name]).sort(), [['2609RX', 259000, 'F-위스퍼샤인R'], ['2609RY', 259000, 'F-위스퍼샤인R']]);
  assert.deepEqual(o.filter((x) => x.gift).map((x) => x.barcode), ['2604P6']);
});

test('slOrderRows: 비고에 색상이 앞에 붙은 정산', () => {
  const o = C.slOrderRows(FX('trade-order-sold.html'));
  assert.deepEqual([o[0].barcode, o[0].settle, o[0].date, o[0].code], ['240CKK', 29400, '26-09-10', 'F-BF-Z-XX-ZZ-002Q']);
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
  //  바깥 표의 최상위 <tr> 만 자른다 — 이미지 칸에 중첩 <table><tr> 이 있어 단순 split 은 행을 쪼갠다(실측).
  function topRows(tableHtml) {
    const out = []; const re = /<(\/?)(table|tr)\b[^>]*>/gi;
    let depth = 0, start = -1, m;
    while ((m = re.exec(tableHtml))) {
      const close = m[1] === '/', tag = m[2].toLowerCase();
      if (tag === 'table') { depth += close ? -1 : 1; continue; }
      if (depth !== 1) continue;
      if (!close) start = m.index; else if (start >= 0) { out.push(tableHtml.slice(start, re.lastIndex)); start = -1; }
    }
    return out;
  }
  //  headWord('주문일'|'판매일') 가 든 title_line 행 이후의 행 텍스트. 표는 그 헤더를 품은 가장 가까운 <table class="t_list">.
  function listRows(html, headWord) {
    const s = String(html || '');
    const hi = s.search(new RegExp('<tr[^>]*class="title_line"[^>]*>(?:(?!</tr>)[\\s\\S])*' + headWord));
    if (hi < 0) return [];
    const ts = s.lastIndexOf('<table', hi);
    const rows = topRows(s.slice(ts));
    const hIdx = rows.findIndex((r) => /class="title_line"/.test(r) && r.indexOf(headWord) >= 0);
    return rows.slice(hIdx + 1).map(textOf).filter((t) => DATE_RE.test(t) && /^\d+\s/.test(t));
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
주의: 판매직원 칸은 실측상 이름만(`홍해진`). 끝 토큰 하나를 지우는 처리는 픽스처로 확인됐다.

- [ ] **Step 5: 통과 확인** — Run: `node --test tests/saleimport-core.test.js` → Expected: PASS 19/19 (Task 1·3 의 14 + 이 Task 의 5).

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

### Task 5: 판매 폼 읽기·페이로드·실행기 (core) + 유비샵 어댑터

**Files:**
- Modify: `src/saleimport-core.js`
- Create: `src/saleimport-erp.js`, `tests/saleimport-run.test.js`
- Modify: `tests/saleimport-core.test.js` (폼·페이로드 단위 테스트 추가)
- 읽기 전용 참고(수정 금지): `src/orderimport-core.js`(`oiFieldValue` `oiExtractHidden` `oiTListAllRows` `oiTListRows` `oiSubmitResult` `oiClientSearchRows` `oiRunOrder`), `src/orderimport-erp.js`(`req/post/assertUbdstore` 패턴)
- 픽스처(이미 있음, 수정 금지): `tests/fixtures/saleimport/saleform-line.html`, `modifyform.html`, `cashpay-form.html`

**계약의 정본은 스펙 §4.1(실측 표)과 D8(미수금 0)이다. 이 Task 를 시작하기 전에 스펙 §4 전체를 읽어라.**

**Interfaces:**
- Consumes: Task 1~3 의 `slMatchClient` 결과 `SaleLinePlan = { barcode, code, name, gift, orderNo, amount }`, `Match.cash`.
- core 는 브라우저에선 `globalThis.ubOi`(orderimport-core, manifest 에서 먼저 실림), node 에선 `require('./orderimport-core.js')` 로 폼 유틸을 얻는다:
  ```js
  const O = (typeof module !== 'undefined' && module.exports) ? require('./orderimport-core.js') : globalThis.ubOi;
  ```
- Produces (core):
  - `SL_FORM10_NAMES` — 스펙 §4.1-4 의 form10 24필드 이름 배열(순서 그대로).
  - `slComma(n: number) → string` (`75722`→`'75,722'`, 음수 부호 유지)
  - `slReadSaleForm(html) → { values: { sKey, tradeJun, payJun, client, clientName }, form10: {name→string}, missing: string[], rows: [{ idx, saleSeq, barcode, salePrice, dcPrice, amount }] }`
    - rows 는 `O.oiTListAllRows` 의 헤더 행(class title_line)에서 **헤더 이름으로** `판매가`·`DC금액`·`실판매가` 열 위치를 찾아 읽는다(첫 줄 숫자만, 콤마 제거). idx = `'<saleSeq>,<barcode>'`.
    - 픽스처 기대: values `{ tradeJun:'114348', payJun:'280453', client:'123699', clientName:'민*금2837/G' }`, rows `[{ idx:'376143,2504L5', saleSeq:'376143', barcode:'2504L5', salePrice:112000, dcPrice:36278, amount:75722 }]`, form10.afterPrice `'0'`, form10.payPrice `'75,722'`.
  - `slSaleManager(html) → string` — 인라인 스크립트 `form1.saleManager.value = "X";` 의 X. 없으면 `''`. 픽스처 기대 `'홍해진'`.
  - `slModifyPayload(html, amount) → { fields: [name, value][], issues: string[] }`
    - form1 의 모든 필드를 문서 순서대로(hidden 11 + `salePrice saleQty tmpSalePrice dcRate dcPrice cashPoint saleDcPrice saleManager tmpPoint usePoint remark`, `imageField22` 는 제외) 모은 뒤
    - `saleDcPrice = slComma(amount)`, `dcPrice = slComma(tmp − amount − cashPoint)`, `dcRate = (Math.round(dcPrice / tmp * 10000) / 100).toFixed(2)`(tmp=0 이면 `'0.00'`), `saleManager = slSaleManager(html)`.
    - issues: `saleManager` 빈값 → `'no_sale_manager'`; `amount` 가 정수 아님·음수·tmp 초과 → `'bad_amount'`; 필수 이름 누락 → `'missing:<name>'`.
    - 픽스처 + 75722 기대: `saleDcPrice='75,722' dcPrice='36,278' dcRate='32.39' saleManager='홍해진' seq='376143' tradeJun='114348'`. 0 원(사은품) 기대: `dcPrice='112,000' dcRate='100.00'`.
  - `slCashPayload(html, cash) → { fields, issues }` — hidden 전부(문서 순서) + `payCash=slComma(cash) payCashPaper='0' payEtc='0' remark=''`. **`payJun` 이 비어 있지 않으면 issue `'already_paid'`**(결제 1회 규칙, 스펙 §4.1). 픽스처는 payJun 280453 이라 `already_paid` 가 나와야 한다; payJun 을 비운 HTML 로는 issue 0·`payCash='75,722'`·`tradeType='3'`.
  - `slJunCheck(form10, cash) → { ok, reason }` — D8: `beforePrice`·`afterPrice` 가 `'0'`, `payPrice`·`payCash`·`saleDcPrice` 가 `slComma(cash)` 와 같아야 ok. 아니면 reason 에 어긋난 칸 이름.
  - `slJunPayload(form10) → [name, value][]` — `SL_FORM10_NAMES` 순서로.
  - `slRunClient(plan, erp, hooks) → Result`, `slRunAll(plans, erp, hooks) → Result[]`
    - `plan = { key, client: { seq, name }, lines: SaleLinePlan[], cash }`
    - `Result = { key, status: 'done'|'skipped'|'fatal'|'blocked', reason, tradeJun, payJun, saleSeqs: [], rolledBack: 0, paid: false }`
- Produces (erp, `globalThis.ubSlErp`) — 모두 `orderimport-erp.js` 의 `req/post/assertUbdstore` 를 복사해 같은 방식(30초 타임아웃, 세션 만료 리다이렉트 검출)으로:
  - `state() → { tradeJun, payJun, rows: number, form }` — plain GET `saleItemWriteForm.do?tcode=sale_item&pageSize=20&searchSortType=seq` → `slReadSaleForm`
  - `openClient(client, clientName) → form` — 스펙 §4.1-0 GET
  - `getSaleForm(ctx) → form` — `ctx = { tradeJun, payJun, client, clientName }` 로 판매폼 GET
  - `postLine(form, barcode) → { ok, msg, form }` — form 의 values 로 10필드 조립(barcode 만 채움) POST, 응답 HTML 을 `slReadSaleForm`
  - `getModify(saleSeq, ctx) → html` / `postModify(fields) → { ok, msg, form }`
  - `getCash(ctx) → html` / `postCash(fields) → { ok, msg, payJun, payCash }` — 응답 URL 의 payJun·html 의 payCash
  - `postJun(fields) → { ok, msg }`
  - `deleteLines(ctx, idxValues) → { ok, msg, before }` — 스펙 §4.1-D(미실측, `del()` 그대로): 판매폼 GET 으로 sKey·before rows → `POST /sale/item/saleItemDelete.do?tcode=sale_item&reqPage=1&pageSize=20&searchSortType=seq&tradeJun=…&payJun=…&shop=LT&client=…&shopName=FASHION&clientName=…` 에 `sKey` + `idx`…
  - `trade(client, clientName) → { orders, sales }` — `slTradeUrl` 두 개 GET → `slOrderRows` / `slSaleRows`
  - `searchClient(word) → [{ seq, name, phone }]` — `POST /etc/client.do?tcode=sale_item` (`formname=form1 url=/sale/item/saleItemWriteForm.do actFlag=1 jun= shop=LT shopName=FASHION searchWordType=clientName searchWord pageSize=100`) → `O.oiClientSearchRows`
  - 성공 판정은 항상 `O.oiSubmitResult(url)` (msg 빈값) **그리고** 상태 변화.

**slRunClient 흐름 (스펙 §4.2 — 순서·판정 그대로):**
1. `erp.state()` — tradeJun·payJun 빈값·rows 0 아니면 `skipped:'open_trade'`(쓰기 0).
2. 줄마다: 첫 줄은 `erp.openClient`, 이후 `erp.getSaleForm({tradeJun,…})` → form.values.client 가 plan.client.seq 와 다르면 중단 → rows 가 **내가 넣은 saleSeq 집합과 정확히 같아야**(남의 줄 끼어듦 검출) → `erp.postLine(form, barcode)` → 응답 rows 가 이전 + **정확히 1개 새 행이고 그 barcode 가 일치**해야 한다. 새 행 saleSeq 를 기록, 첫 줄이면 tradeJun 보관. POST 예외(응답 유실)는 `fatal:'line_unverified'`(되돌리지 않음 — orderimport 와 같은 이유).
3. 줄마다 실판매가: `erp.getModify(saleSeq, ctx)` → `slModifyPayload(html, line.amount)` issues 있으면 중단 → `postModify` → 응답 form 의 그 행 `amount === line.amount`.
4. 최종 대조: `getSaleForm` → rows 의 (barcode, amount) 다중집합 = plan.lines, Σamount = plan.cash, `form10.beforePrice === '0'`.
5. 결제: `getCash(ctx)` → `slCashPayload(html, plan.cash)` issues 있으면 중단 → `postCash` → payJun 비어 있지 않음·payCash = cash. **이 POST 를 보내는 순간부터 `res.paid = true`** — 이후 모든 실패는 `fatal`(되돌리지 않음). postCash 예외도 fatal.
6. 판매하기: `getSaleForm({tradeJun, payJun,…})` → `slJunCheck(form.form10, cash)` 실패면 **postJun 을 보내지 않고** `fatal:'receivable:<칸>'`(D8) → `postJun(slJunPayload(form.form10))` → `state()` 가 tradeJun·payJun 빈값·rows 0 → `erp.trade(client)` 의 sales 에 각 barcode 와 amount 가 있어야 `done`.
7. 실패(5 이전): 넣은 saleSeq 가 있으면 `state()` 로 세션 tradeJun 이 내 것인지 확인(아니면 fatal) → `deleteLines` → `getSaleForm` 으로 내 saleSeq 가 사라졌는지·남의 줄이 before 대비 사라지지 않았는지(`rollback_overreach`) → `state()` 비었는지. 하나라도 어긋나면 fatal. 되돌리기 성공이면 `skipped` + `rolledBack`.
8. `slRunAll`: 고객 순차, `fatal` 이면 이후 전부 `blocked:'halted'`. 한 고객 예외는 fatal 결과로 담는다(던지지 않는다).

- [ ] **Step 1: 폼·페이로드 단위 테스트 작성(RED)** — `tests/saleimport-core.test.js` 에 위 Produces 의 "픽스처 기대" 전부를 assert 로. 추가로: `slComma(-5)`→`'-5'`; `slModifyPayload` 에 스크립트를 지운 HTML → issues 에 `no_sale_manager`; `slJunCheck` 에 afterPrice `'75,722'` → ok false·reason 에 `afterPrice`; beforePrice `'1,000'` → reason 에 `beforePrice`; payCash 가 cash 와 다르면 reason 에 `payCash`.
- [ ] **Step 2: 실행해 실패 확인** — `node --test tests/saleimport-core.test.js`
- [ ] **Step 3: core 폼·페이로드 함수 구현 → 통과**
- [ ] **Step 4: 실행기 배선 테스트 작성(RED)** — `tests/saleimport-run.test.js`. 가짜 erp(메모리 상태 머신: 세션 tradeJun/payJun/rows, 호출 기록)를 테스트 파일 안에 만든다(`orderimport-run.test.js` 의 가짜 erp 패턴 참고). 필수 케이스:
  1. 정상 2줄(본품 1 + 사은품 0원): 호출 순서 = state → openClient → postLine → getSaleForm → postLine → getModify → postModify ×2 → getSaleForm → getCash → postCash → getSaleForm → postJun → state → trade; 결과 `done`, paid true.
  2. 시작 가드: state 에 tradeJun 있음 → `skipped:'open_trade'`, post* 호출 0.
  3. 둘째 줄 전 세션에 남의 줄이 끼어듦 → 둘째 postLine 호출 0, 내 줄만 deleteLines, 되돌린 뒤에도 남의 줄이 남으므로 **`fatal:foreign_rows_remain`**(스펙 §4.2-7 · 2026-09-30 Opus 검토로 정정 — 처음 이 줄에 `skipped` 로 잘못 적었다).
  4. 최종 대조 실패(한 행 amount 가 다르게 저장됨) → postCash 호출 0, 되돌리기.
  5. 결제 후 slJunCheck 실패(afterPrice ≠ 0) → **postJun 호출 0**, `fatal`, deleteLines 호출 0.
  6. postCash 예외 → `fatal`, deleteLines 0, postJun 0.
  7. postLine 예외 → `fatal:'line_unverified…'`, deleteLines 0.
  8. 되돌리기가 남의 줄까지 지움(before 에 있던 남의 saleSeq 사라짐) → `fatal:'rollback_overreach…'`.
  9. slRunAll: 첫 고객 fatal → 둘째 고객 `blocked`, 둘째 고객 erp 호출 0.
- [ ] **Step 5: 실패 확인 → `slRunClient`/`slRunAll` 구현 → 통과** — `node --test tests/saleimport-core.test.js tests/saleimport-run.test.js`
- [ ] **Step 6: 변이 확인** — 구현에서 (a) 시작 가드 (b) slJunCheck 호출 (c) 결제 후 fatal 처리 를 하나씩 지워 각각 테스트가 **실패**하는지 확인하고 되돌린다. 결과를 보고서에 표로.
- [ ] **Step 7: 어댑터 `src/saleimport-erp.js` 작성** — 위 erp 목록. node 테스트 대상 아님(fetch). 문법 확인: `node --check src/saleimport-erp.js`.
- [ ] **Step 8: 커밋** — `feat(판매 처리): 판매 폼 읽기·페이로드·실행기·유비샵 어댑터`

### Task 6: 패널·배선·배포 준비

**Files:**
- Create: `src/saleimport.js`
- Modify: `src/skin.js`(사이드바 섹션), `popup/popup.html`, `popup/popup.js`(스위치), `manifest.json`(content_scripts·version), `build-shell-index.ps1`, `tests/loader-integrity.test.js`(SHELL_PATTERNS), `shell-files.json`(생성물)
- 참고(수정 금지): `src/orderimport.js`(패널 구조·ensureXls/readXls·실행 잠금·beforeunload·로그 JSON — **같은 구조로 만든다**)

**Interfaces:**
- Consumes: `globalThis.ubSl`(core), `globalThis.ubSlErp`, background 메시지 `ubOiInjectXls` 와 MAIN 의 `orderimport-xls.js`(`source:'ub-oi'` 요청 / `source:'ub-oi-xls'` 응답) — **재사용, 수정 금지**.
- storage 키: 스위치 `ubSaleImport`(기본 true), 장부 `ubSlLedger` = `{ '<GS주문번호>': { at, tradeJun, barcodes } }`.

- [ ] **Step 1: `src/saleimport.js`** — `saleItemWriteForm.do` top window 에서만. 흐름:
  1. 사이드바 버튼 `#ub-sl-open` 클릭 → 패널(`#ub-sl-panel`, 반투명 덮개 `#ub-sl-veil`).
  2. 파일 선택 → `readXls` → `slParseSheet` → `slComputeFinals`(실패면 오류 배너, 끝) → `slGroupByClient`.
  3. 고객마다(읽기만, 순차): `E.searchClient(key)` 에서 이름 `===` 정확일치 1명이면 자동, 아니면 **차단 + 검색창**(수취인 이름을 미리 채움, 결과 목록에서 고르면 그 고객으로 확정). 확정되면 `E.trade(seq, name)` → `slMatchClient`. **고객 판매폼 form10 의 `beforePrice` 가 0 이 아니면 차단('기존 미수금 있음', D8)** — 이를 위해 `E.openClient` GET 결과의 form10 을 쓴다(쓰기 없음).
  4. 검토 표: 고객 단위 행(고객명·판정 칩·GS 주문번호들·바코드/상품명·실판매가·사은품 0원 줄·현금 합계). 반품 행은 별도 회색 '수동 처리 필요' 목록. 부분 판매(한 고객의 일부 행만 이미 판매)는 그 행을 '이미 판매됨' 으로 표시. 장부에 있는 GS 주문번호는 '이전에 처리함(날짜)' 경고. 체크 가능 = status 'ok' 이고 차단 없음, 기본 체크.
  5. 상단 요약: 처리 대상 고객 수 · 줄 수 · 현금 합계 · 차단/제외 수.
  6. [판매 시작] → 확인창(고객 수·현금 합계) → 실행 중 잠금(패널 컨트롤 disabled, 덮개 문구 "실행 중 — 유비샵 판매 화면을 조작하지 마세요", beforeunload) → `slRunAll` → 결과 표(상태·사유·판매전표·결제전표·되돌림) + 장부 기록(done 만) + [로그 JSON].
- [ ] **Step 2: `src/skin.js`** — `isOrderWrite()` 옆에 `isSaleWrite()`(`/sale/item/saleItemWriteForm.do`) 추가, 기본값 `ubSaleImport: true`, 섹션 문구 "GS 판처 xlsx 불러오기" / "파일 → 검토 → 판매 시작. 실행 중엔 판매 화면을 건드리지 마세요." (orderimport 섹션과 같은 마크업).
- [ ] **Step 3: popup 스위치** "GS 판매 처리 가져오기"(`ubSaleImport`).
- [ ] **Step 4: manifest** — content_scripts 항목 추가: matches `http(s)://ubdstore.ubshop.biz/sale/item/saleItemWriteForm.do*`, js `["src/erp.js","src/orderimport-core.js","src/saleimport-core.js","src/saleimport-erp.js","src/saleimport.js"]`, ISOLATED, document_idle. `"version": "4.3.0"`.
- [ ] **Step 5: SHELL 인덱스** — `build-shell-index.ps1` 의 `$patterns` 와 `tests/loader-integrity.test.js` 의 `SHELL_PATTERNS` 끝에 `'src/saleimport-core.js','src/saleimport-erp.js','src/saleimport.js'` 를 같은 순서로 추가 → `pwsh -File build-shell-index.ps1` → `node --test tests/loader-integrity.test.js tests/saleimport-*.test.js` 전부 PASS. ⚠ 트레이 D102LabelPrinter 를 끈 상태에서.
- [ ] **Step 6: 렌더 확인** — 스크래치패드에 가짜 chrome/erp 하네스(orderimport 4.2.9 때와 같은 방식: 가짜 `chrome.storage`·`chrome.runtime.sendMessage`, 가짜 `ubSlErp`, 실제 core+UI, 이 xlsx 행 배열)로 검토 표를 띄워 데스크톱 스크린샷 1장. 체크 가능 12 · 이미 판매 1(하*이) · 차단 4(이름 불일치 — 민*금 포함) · 반품 1 이 보여야 한다.
- [ ] **Step 7: 커밋** — `feat(판매 처리): 상품판매 사이드바 패널·스위치·SHELL 배선 (4.3.0)`

### Task 7: 검수(T3)·라이브 첫 실행

- gate: `node --test tests/saleimport-*.test.js tests/loader-integrity.test.js` 전부 PASS.
- 검수 T3: 외부 1명(Terra) 반복 + Opus 4.7/4.6(메인 Opus 가 직접 짠 코드일 때; Sonnet worker 코드면 opus-reviewer) + 교차 DeepSeek. **Fable 제외(2026-09-30 사장님 지시).** 원장 `docs/REVIEW-LEDGER.md` 갱신.
- 라이브: 사장님 입회로 1~2 고객만 체크해 실행 → 판매내역 대조 → main 머지·push → ExtSync.
