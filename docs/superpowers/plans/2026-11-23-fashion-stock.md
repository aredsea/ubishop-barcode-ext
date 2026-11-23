# 패션 상품 재고화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 상품입고 화면 사이드바에 「패션 상품 재고화」를 추가해, 바코드 하나로 추가설명·판매가 수정 → 그 고객 주문 본사확인 → 그 바코드 배정까지 확인 창 한 번으로 끝낸다.

**Architecture:** 순수 판정은 `src/fashionstock-core.js`(node 테스트), 유비샵 읽기·쓰기는 `src/fashionstock-erp.js`(숨은 iframe·fetch, 기존 storeprice-erp·skin.js 작업C 함수 재사용), 화면·진행은 `src/fashionstock.js`. 판매가는 아틀리에 새 Edge 함수 `price-lookup` 이 마켓 가격표에서 돌려준다.

**Tech Stack:** Chrome MV3 content script(ISOLATED, 셸 파일 — ExtSync 배포), node:test, Supabase Edge(Deno) + d102-atelier node 테스트(.mjs).

## Global Constraints

- 스펙 정본: `docs/superpowers/specs/2026-11-23-fashion-stock-design.md`
- 확인 창까지 유비샵 쓰기 0. [진행] 한 번 = 한 품목. 쓰기 순서 고정: ① 품목 수정 → ② 본사확인 → ③ 배정 (배정되면 입고장 행에서 [수정] 링크가 사라지므로 순서를 바꾸면 안 된다 — 2026-11-23 실측).
- 배정은 **후보 중 바코드 정확일치 행만**. 없으면 멈춤. `cPickAssignBarcode`(첫 후보) 금지.
- 실패 시 자동 되돌리기 없음. 남은 단계를 화면에 적는다.
- 수정폼 칸 이름(2026-11-23 실측): 추가설명 `itemEtcRemark` · 소비자가 `basicSalePrice` · 판매가 `salePrice` · 상품번호 `itemNum`(대시 없음, 예 `FBFIPGPA0091`) · 품위 `k` · 저장 `input[name=imageField22]`(form1 의 DOM 자손 아님 — `b.form===f` 로 찾는다).
- 저장 성공 판정 = 리다이렉트 URL 에 `msg` 없음(`ubOi.oiSubmitResult`). 본문 alert 문구 스캔 금지.
- `AUTO_WRITE_MARKERS` URL(Standby·CurrentSettingModify·orderItemModify)은 "확인용"으로도 GET 금지.
- 🔴 테스트·검증에서 운영 데이터 쓰기 금지. 라이브 쓰기 첫 실행은 사장님 입회 1건.
- 🔴 공개 저장소 — 픽스처·테스트에 실명·전화 금지(가명: `김가명1234/카` 등).
- 버전: 4.6.0 → **4.6.1**(패치). manifest·shell-files.json 함께.
- UI: D102 디자인 시스템, 브랜드 틸 `#4abcc7`, 해요체 금지 아님(유비샵 확장 기존 문체 = 평서 짧게).

---

## File Structure

| 파일 | 책임 |
|---|---|
| `src/fashionstock-core.js` (신규) | 순수 함수: 접미→마켓, 종류 글자, 추가설명 조합, 가격 선택, 주문 행 → 후보, 7일 범위 |
| `tests/fashionstock-core.test.js` (신규) | 위 단위 테스트 |
| `src/fashionstock-erp.js` (신규) | 품목 읽기(iframe) · 후보 조회 · 가격 조회 · 품목 저장/검증 · 본사확인 · 배정 |
| `src/fashionstock.js` (신규) | 확인 창 UI · 진행 오케스트레이션 · 잠금 |
| `tests/fashionstock-wiring.test.js` (신규) | manifest·skin.js·셸 인덱스 배선 검사 |
| `src/skin.js` (수정) | `globalThis.ubHqApi` 노출 · 사이드바 섹션 + 배선 |
| `src/storeprice-erp.js` (수정) | `openFrame, loadFrame, waitLoad` 를 `ubSpErp` 에 추가 노출(동작 무변경) |
| `manifest.json`, `build-shell-index.ps1`, `shell-files.json` (수정) | 콘텐츠 스크립트 등록·셸 목록·버전 |
| `../d102-atelier/supabase/functions/price-lookup/index.ts` (신규) | 할인 전 판매가 조회 Edge |
| `../d102-atelier/supabase/functions/_shared/price-pick.mjs` (신규) | 순수 매칭(테스트 대상) |
| `../d102-atelier/tests/price-lookup.test.mjs` (신규) | 매칭 단위 테스트 |

---

### Task 1: 순수 코어 `fashionstock-core.js`

**Files:**
- Create: `src/fashionstock-core.js`
- Test: `tests/fashionstock-core.test.js`

**Interfaces:**
- Produces (globalThis.ubFsCore / module.exports):
  - `fsSuffixMarket(customer: string) → string|null` (아틀리에 marketId)
  - `fsNormCode(code: string) → string` (대시·공백 제거, 대문자)
  - `fsCategoryLetter(code: string) → string|null`
  - `fsComposeDesc(desc: string, letter: string|null, customer: string) → string`
  - `fsCustomerName(customer: string) → string` (꼬리 `/…` 제거)
  - `fsPickPrice(rec: {base?,price?}|null) → number|null`
  - `fsSplitTitle(title: string) → {code: string, customer: string}`
  - `fsCandidates(rows: arRows[], itemNum: string) → [{orderSeq, junNum, orderDate, customer, code}]`
  - `fsListParams(now: Date) → object` (orderItemList POST 본문)

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/fashionstock-core.test.js`

```js
const test = require('node:test');
const assert = require('node:assert');
const F = require('../src/fashionstock-core.js');

test('fsSuffixMarket — 주문 가져오기 접미 규칙과 아틀리에 marketId', () => {
  assert.equal(F.fsSuffixMarket('김가명1234/카'), 'own');
  assert.equal(F.fsSuffixMarket('김가명1234/스'), 'smartstore');
  assert.equal(F.fsSuffixMarket('김가명1234/쿠'), 'coupang');
  assert.equal(F.fsSuffixMarket('김가명1234/K'), 'kakao');
  assert.equal(F.fsSuffixMarket('김가명1234/아'), 'amonds');
  assert.equal(F.fsSuffixMarket('김가명1234/G'), 'homeshop');
  assert.equal(F.fsSuffixMarket('김가명1234/s'), 'homeshop');
  assert.equal(F.fsSuffixMarket('김가명1234/옥'), 'gmarket');
  assert.equal(F.fsSuffixMarket('김가명1234/에'), 'ably');
  assert.equal(F.fsSuffixMarket('김가명1234/지'), null, 'G마켓·지그재그 겹침');
  assert.equal(F.fsSuffixMarket('김가명1754/협찬'), null);
  assert.equal(F.fsSuffixMarket('김가명1234'), null);
});

test('fsCategoryLetter — 둘째 칸 첫 글자', () => {
  assert.equal(F.fsCategoryLetter('F-BF-I-PG-PA-0091'), 'B');
  assert.equal(F.fsCategoryLetter('FBFIPGPA0091'), 'B');
  assert.equal(F.fsCategoryLetter('F-RF-P-PG-PA-00G3'), 'R');
  assert.equal(F.fsCategoryLetter('F-NF-Q-WG-QB-00EQ'), 'N');
  assert.equal(F.fsCategoryLetter(''), null);
});

test('fsComposeDesc — 접두 FD- 제거 · 종류 낱말 치환 · 고객명', () => {
  assert.equal(F.fsComposeDesc('Silver925물방울오팔팔찌', 'B', '김가명1234/카'), 'Silver925물방울오팔B/김가명1234');
  assert.equal(F.fsComposeDesc('FD-Silver925물방울오팔B', 'B', '김가명1234/카'), 'Silver925물방울오팔B/김가명1234');
  assert.equal(F.fsComposeDesc('FD-Silver925심플바게트오팔R', 'R', '김가명1234/쿠'), 'Silver925심플바게트오팔R/김가명1234');
  assert.equal(F.fsComposeDesc('Silver925누드2라인목걸이', 'N', '김가명1234/스'), 'Silver925누드2라인N/김가명1234');
  assert.equal(F.fsComposeDesc('Silver925물방울오팔B/이전고객', 'B', '김가명1234/카'), 'Silver925물방울오팔B/김가명1234', '기존 고객 꼬리 교체');
  assert.equal(F.fsComposeDesc('하트펜던트', null, '김가명1234/카'), '하트펜던트/김가명1234', '글자 모르면 낱말 유지');
});

test('fsPickPrice — base 우선, 없으면 price', () => {
  assert.equal(F.fsPickPrice({ base: 52000, price: 45000 }), 52000);
  assert.equal(F.fsPickPrice({ price: 45000 }), 45000);
  assert.equal(F.fsPickPrice({}), null);
  assert.equal(F.fsPickPrice(null), null);
});

test('fsSplitTitle — 상품명 코드 고객명 비고', () => {
  assert.deepEqual(F.fsSplitTitle('[925실버]물방울오팔팔찌 F-BF-I-PG-PA-0091 김가명4672/카'),
    { code: 'F-BF-I-PG-PA-0091', customer: '김가명4672/카' });
  assert.deepEqual(F.fsSplitTitle('[925실버]물방울오팔팔찌 F-BF-I-PG-PA-0091 김가명4672/카 주문 비고 : 정산 30,000 원'),
    { code: 'F-BF-I-PG-PA-0091', customer: '김가명4672/카' });
  assert.deepEqual(F.fsSplitTitle('코드없음'), { code: '', customer: '' });
});

test('fsCandidates — 같은 상품코드 · 주문완료만', () => {
  const rows = [
    { orderSeq: '11', junNum: '0000002Z2A', orderDate: '20261123', title: '[925실버]물방울오팔팔찌 F-BF-I-PG-PA-0091 김가명4672/카', status: '주문완료' },
    { orderSeq: '12', junNum: '0000002Z2B', orderDate: '20261122', title: '[925실버]물방울오팔팔찌 F-BF-I-PG-PA-0091 박가명1111/쿠', status: '본사확인' },
    { orderSeq: '13', junNum: '0000002Z2C', orderDate: '20261121', title: '다른상품 F-RF-P-PG-PA-00G3 이가명2222/카', status: '주문완료' },
  ];
  assert.deepEqual(F.fsCandidates(rows, 'FBFIPGPA0091'),
    [{ orderSeq: '11', junNum: '0000002Z2A', orderDate: '20261123', customer: '김가명4672/카', code: 'F-BF-I-PG-PA-0091' }]);
  assert.deepEqual(F.fsCandidates(null, 'FBFIPGPA0091'), null, '파싱 실패는 null 그대로');
});

test('fsListParams — 오늘 포함 7일 · FASHION · 주문완료', () => {
  const p = F.fsListParams(new Date(2026, 10, 23));
  assert.equal(p.syear + p.smonth + p.sday, '20261117');
  assert.equal(p.eyear + p.emonth + p.eday, '20261123');
  assert.equal(p.searchShop, 'LT');
  assert.equal(p.searchItemStatus, 'O--');
  assert.equal(p.searchDateType, 'a.orderDate');
  assert.equal(p.pageSize, '500');
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test tests/fashionstock-core.test.js` · Expected: FAIL `Cannot find module '../src/fashionstock-core.js'`

- [ ] **Step 3: 구현** — `src/fashionstock-core.js`

```js
/* =============================================================================
 *  fashionstock-core.js — 패션 상품 재고화 순수 판정(DOM·chrome 무관).
 *  스펙: docs/superpowers/specs/2026-11-23-fashion-stock-design.md
 *  노출: node → module.exports, content script → globalThis.ubFsCore
 * ========================================================================== */
(function () {
  'use strict';
  //  유비샵 고객명 접미(orderimport-core MARKETS) → 아틀리에 settings.markets id.
  //  '지'(G마켓·지그재그 겹침)·퀸·롯·H·협찬·없음 → null(판매가 직접 입력).
  const SUFFIX_MARKET = Object.freeze({
    '카': 'own', '스': 'smartstore', '쿠': 'coupang', 'K': 'kakao', '아': 'amonds',
    'G': 'homeshop', 's': 'homeshop', '옥': 'gmarket', '에': 'ably'
  });
  const CATEGORY_WORDS = ['팔찌', '반지', '목걸이', '귀걸이', '이어링', '발찌', '브로치', '피어싱', '펜던트', '링'];
  const CODE_RE = /[A-Za-z0-9]+(?:-[A-Za-z0-9]+){4,}/;

  function fsSuffixMarket(customer) {
    const m = /\/([^/\s]+)\s*$/.exec(String(customer || ''));
    return m && Object.prototype.hasOwnProperty.call(SUFFIX_MARKET, m[1]) ? SUFFIX_MARKET[m[1]] : null;
  }
  function fsNormCode(code) { return String(code || '').replace(/[\s-]/g, '').toUpperCase(); }
  function fsCategoryLetter(code) {
    const c = fsNormCode(code);
    return c.length >= 2 && /[A-Z]/.test(c[1]) ? c[1] : null;
  }
  function fsCustomerName(customer) { return String(customer || '').trim().replace(/\/[^/]*$/, '').trim(); }
  function fsComposeDesc(desc, letter, customer) {
    let s = String(desc || '').trim();
    s = s.replace(/\/.*$/, '').trim();          // 기존 고객 꼬리
    s = s.replace(/^[A-Z]{1,4}-/, '');          // 매입처 접두(FD- 등)
    if (letter && !/[A-Z]$/.test(s)) {
      const w = CATEGORY_WORDS.find((x) => s.endsWith(x));
      if (w) s = s.slice(0, -w.length) + letter;
    }
    const name = fsCustomerName(customer);
    return name ? s + '/' + name : s;
  }
  function fsPickPrice(rec) {
    if (!rec) return null;
    const n = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);
    return n(rec.base) != null ? n(rec.base) : n(rec.price);
  }
  function fsSplitTitle(title) {
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    const m = CODE_RE.exec(t);
    if (!m) return { code: '', customer: '' };
    let rest = t.slice(m.index + m[0].length).trim();
    rest = rest.replace(/\s*(주문\s*)?비고\s*:.*$/, '').trim();
    return { code: m[0], customer: rest.split(' ')[0] || '' };
  }
  function fsCandidates(rows, itemNum) {
    if (!Array.isArray(rows)) return null;
    const want = fsNormCode(itemNum);
    const out = [];
    for (const r of rows) {
      if (String(r.status || '').replace(/\s+/g, '') !== '주문완료') continue;
      const s = fsSplitTitle(r.title);
      if (!s.code || fsNormCode(s.code) !== want || !s.customer) continue;
      out.push({ orderSeq: r.orderSeq, junNum: r.junNum, orderDate: r.orderDate, customer: s.customer, code: s.code });
    }
    return out;
  }
  const p2 = (n) => String(n).padStart(2, '0');
  function fsListParams(now) {
    const e = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const s = new Date(e); s.setDate(s.getDate() - 6);
    return {
      tcode: 'order_item', reqPage: '1', pageSize: '500', searchSortType: 'seq',
      searchItemStatus: 'O--', searchShop: 'LT', searchDateType: 'a.orderDate',
      syear: String(s.getFullYear()), smonth: p2(s.getMonth() + 1), sday: p2(s.getDate()),
      eyear: String(e.getFullYear()), emonth: p2(e.getMonth() + 1), eday: p2(e.getDate())
    };
  }

  const api = { fsSuffixMarket, fsNormCode, fsCategoryLetter, fsCustomerName, fsComposeDesc, fsPickPrice,
    fsSplitTitle, fsCandidates, fsListParams, SUFFIX_MARKET };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof globalThis !== 'undefined') { globalThis.ubFsCore = api; }
})();
```

- [ ] **Step 4: 통과 확인** — Run: `node --test tests/fashionstock-core.test.js` · Expected: PASS 7/7

- [ ] **Step 5: 커밋**

```bash
git add src/fashionstock-core.js tests/fashionstock-core.test.js
git commit -m "feat(패션 재고화): 순수 코어 — 접미→마켓·추가설명 조합·후보 추리기"
```

---

### Task 2: 아틀리에 `price-lookup` Edge 함수

**Files (repo `C:\Clauede Code\d102-atelier`):**
- Create: `supabase/functions/_shared/price-pick.mjs`
- Create: `supabase/functions/price-lookup/index.ts`
- Test: `tests/price-lookup.test.mjs`

**Interfaces:**
- Produces HTTP: `POST {SUPABASE_URL}/functions/v1/price-lookup`, 헤더 `x-ledger-key`, 본문 `{ items: [{ code: "F-BF-I-PG-PA-0091", market: "own", k: "925" }] }`(최대 20) → `{ rows: [{ code, market, status: "ok"|"not_found"|"ambiguous"|"no_price", base, price }] }`
- `pickPrice(products, marketData, item) → row` (순수, price-pick.mjs)

- [ ] **Step 1: 실패하는 테스트** — `tests/price-lookup.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert';
import { pickPrice } from '../supabase/functions/_shared/price-pick.mjs';

const products = [
  { code: 'A100', code_ubishop: 'F-BF-I-PG-PA-0091' },
  { code: 'G200', code_ubishop: 'F-RF-Q-YG-QB-0001' },
  { code: 'D1', code_ubishop: 'F-NF-Q-WG-QB-0002' }, { code: 'D2', code_ubishop: 'FNFQWGQB0002' },
];
const md = { prices: {
  A100: { own: { price: 45000, base: 52000 } },
  G200: { 'own:14k': { price: 300000 }, 'own:18k': { price: 400000 } },
} };

test('실버 — 접미 없는 키, base 그대로', () => {
  assert.deepEqual(pickPrice(products, md, { code: 'FBFIPGPA0091', market: 'own', k: '925' }),
    { code: 'FBFIPGPA0091', market: 'own', status: 'ok', base: 52000, price: 45000 });
});
test('골드 — 품위로 :14k/:18k', () => {
  assert.equal(pickPrice(products, md, { code: 'F-RF-Q-YG-QB-0001', market: 'own', k: '14K' }).price, 300000);
  assert.equal(pickPrice(products, md, { code: 'F-RF-Q-YG-QB-0001', market: 'own', k: '18K' }).price, 400000);
});
test('없음·중복·가격 없음', () => {
  assert.equal(pickPrice(products, md, { code: 'X', market: 'own', k: '925' }).status, 'not_found');
  assert.equal(pickPrice(products, md, { code: 'F-NF-Q-WG-QB-0002', market: 'own', k: '925' }).status, 'ambiguous');
  assert.equal(pickPrice(products, md, { code: 'F-BF-I-PG-PA-0091', market: 'coupang', k: '925' }).status, 'no_price');
});
```

- [ ] **Step 2: 실패 확인** — Run (d102-atelier): `node --test tests/price-lookup.test.mjs` · Expected: FAIL `Cannot find module`

- [ ] **Step 3: 순수 매칭 구현** — `supabase/functions/_shared/price-pick.mjs`

```js
// 유비샵 상품코드 + 마켓 → 아틀리에 마켓 가격표 한 칸. 순수 함수(price-lookup Edge 와 테스트가 공유).
// 🔴 code_ubishop 이 두 제품 이상에 걸리면 ambiguous — 제품 code 는 중복이 흔하다(추측 금지).
const norm = (s) => String(s || '').replace(/[\s-]/g, '').toUpperCase();
function goldSuffix(k) {
  const t = String(k || '').toUpperCase();
  if (/14K/.test(t)) return ':14k';
  if (/18K/.test(t)) return ':18k';
  return '';
}
export function pickPrice(products, marketData, item) {
  const want = norm(item.code);
  const hits = (products || []).filter((p) => norm(p.code_ubishop) === want);
  const base = { code: item.code, market: item.market };
  if (!want || !hits.length) return { ...base, status: 'not_found', base: null, price: null };
  if (hits.length > 1) return { ...base, status: 'ambiguous', base: null, price: null };
  const cells = ((marketData && marketData.prices) || {})[hits[0].code] || {};
  const rec = cells[item.market + goldSuffix(item.k)] || cells[item.market] || null;
  const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);
  if (!rec || (num(rec.base) == null && num(rec.price) == null)) return { ...base, status: 'no_price', base: null, price: null };
  return { ...base, status: 'ok', base: num(rec.base), price: num(rec.price) };
}
```

- [ ] **Step 4: 통과 확인** — `node --test tests/price-lookup.test.mjs` · Expected: PASS 3/3

- [ ] **Step 5: Edge 함수** — `supabase/functions/price-lookup/index.ts`. `ledger-lookup/index.ts` 의 `ALLOWED_ORIGINS`·`cors`·`json`·`digest`·`safeEqual`·키 검사(LEDGER_LOOKUP_KEY, 32자 미만이면 503)를 **그대로 복사**하고 본문만:

```ts
import { pickPrice } from "../_shared/price-pick.mjs";
const MARKET_RE = /^[a-z0-9]{2,20}$/;
const MAX_ITEMS = 20;
// ... (ledger-lookup 에서 복사한 cors/json/digest/safeEqual) ...
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "method" }, 405);
  const secret = Deno.env.get("LEDGER_LOOKUP_KEY") || "";
  if (secret.length < 32) return json(req, { error: "not_configured" }, 503);
  const given = req.headers.get("x-ledger-key") || "";
  const ok = await safeEqual(given.slice(0, MAX_KEY_LEN), secret);
  if (!given || given.length > MAX_KEY_LEN || !ok) return json(req, { error: "unauthorized" }, 401);
  let body: { items?: unknown };
  try { body = await req.json(); } catch { return json(req, { error: "bad_json" }, 400); }
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length || items.length > MAX_ITEMS) return json(req, { error: "bad_items", max: MAX_ITEMS }, 400);
  for (const it of items as any[]) {
    if (!it || typeof it.code !== "string" || it.code.length > 40 || typeof it.market !== "string" || !MARKET_RE.test(it.market)) {
      return json(req, { error: "bad_item" }, 400);
    }
  }
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SB_SERVICE_ROLE_JWT") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json(req, { error: "not_configured" }, 503);
  const h = { apikey: key, Authorization: `Bearer ${key}` };
  const codes = [...new Set((items as any[]).map((i) => i.code))];
  //  code_ubishop 은 대시 있는/없는 표기가 섞여 있다 → 두 형태 모두로 찾는다.
  const forms = [...new Set(codes.flatMap((c) => [c, c.replace(/-/g, "")]))].map((c) => `"${c.replace(/"/g, "")}"`);
  const pr = await fetch(`${url}/rest/v1/products?select=code,code_ubishop&code_ubishop=in.(${encodeURIComponent(forms.join(","))})&limit=1000`, { headers: h });
  if (!pr.ok) return json(req, { error: "db_products" }, 502);
  const products = await pr.json();
  const mr = await fetch(`${url}/rest/v1/app_settings?select=value&key=eq.marketData`, { headers: h });
  if (!mr.ok) return json(req, { error: "db_market" }, 502);
  const md = ((await mr.json())[0] || {}).value || {};
  const rows = (items as any[]).map((it) => pickPrice(products, md, it));
  console.log("price-lookup", { n: rows.length, ok: rows.filter((r) => r.status === "ok").length });
  return json(req, { rows });
});
```

  ⚠️ 대시 없는 표기만 저장된 제품을 대시 있는 코드로 찾을 수 없는 경우가 남는다(`in.()` 은 정확일치). Step 6 에서 실데이터로 확인하고, 둘 다 안 맞는 표기가 있으면 보고한다(추측으로 like 검색 넣지 말 것).

- [ ] **Step 6: blast-radius + 배포 + 실측(읽기)**
  - 기존 함수·DB 무접촉(새 함수만) 확인: `git diff --stat` 이 3개 신규 파일뿐.
  - 배포: `python scripts/deploy_function.py price-lookup` (실패하면 메모리 「cafe24-sync 번들 배포」의 esbuild 번들 경로). verify_jwt=false.
  - 실측(사장님 PC, 열쇠는 `문서\D102-ledger-lookup-key.txt`): `F-BF-I-PG-PA-0091`·`own`·`925` → status/base/price 확인. 사장님이 2502N0 에 넣은 소비자가 45,000 과 대조해 보고(다르면 출처 재확인 — 설계 가정 검증).

- [ ] **Step 7: 커밋(d102-atelier, author 이메일 `4433286+aredsea@users.noreply.github.com`)**

```bash
git add supabase/functions/_shared/price-pick.mjs supabase/functions/price-lookup/index.ts tests/price-lookup.test.mjs
git commit -m "feat(price-lookup): 유비샵 코드+마켓 → 할인 전 판매가 조회 Edge"
```

---

### Task 3: 기존 기능 노출 + 사이드바 섹션 (skin.js · storeprice-erp.js)

**Files:**
- Modify: `src/skin.js` (작업C 함수 정의 뒤 노출 1줄 · `renderSidebar` 재고화 블록 3439-3456 · 배선 3608-3625 뒤)
- Modify: `src/storeprice-erp.js:329`
- Test: `tests/fashionstock-wiring.test.js`

**Interfaces:**
- Produces: `globalThis.ubHqApi = { cFetchSKey, cDoStandby, fetchOrderRow, cExtractRowArgs, cFetchCandidates, cDoAssign }` (skin.js 내부 함수 그대로, 시그니처 무변경)
- Produces: `globalThis.ubSpErp.openFrame/loadFrame/waitLoad` 추가
- Consumes (Task 5): `globalThis.ubFs.open(barcode, setStatus)`

- [ ] **Step 1: 실패하는 배선 테스트** — `tests/fashionstock-wiring.test.js`

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const skin = fs.readFileSync(path.join(ROOT, 'src/skin.js'), 'utf8');

test('skin.js — 작업C 함수 노출 · 패션 재고화 섹션', () => {
  assert.match(skin, /globalThis\.ubHqApi = \{ cFetchSKey, cDoStandby, fetchOrderRow, cExtractRowArgs, cFetchCandidates, cDoAssign \}/);
  assert.match(skin, /id="ub-fs-in"/);
  assert.match(skin, /<span>패션 상품 재고화<\/span>/);
  assert.match(skin, /globalThis\.ubFs && globalThis\.ubFs\.open\(/);
});
test('storeprice-erp — iframe 도우미 노출', () => {
  const sp = fs.readFileSync(path.join(ROOT, 'src/storeprice-erp.js'), 'utf8');
  assert.match(sp, /globalThis\.ubSpErp = \{[^}]*openFrame, loadFrame, waitLoad[^}]*\}/);
});
```

- [ ] **Step 2: 실패 확인** — `node --test tests/fashionstock-wiring.test.js` · Expected: FAIL 2

- [ ] **Step 3: 구현**
  - `src/storeprice-erp.js:329` → `globalThis.ubSpErp = { log, lookup, deleteDeliv, findVoucherItem, savePrice, verifyPrice, redeliver, verifyRedeliv, openFrame, loadFrame, waitLoad };`
  - `src/skin.js`: `cDoAssign` 정의(6070 근처) **바로 뒤**에
    ```js
    //  패션 상품 재고화(fashionstock-erp.js)가 같은 ISOLATED 세계에서 재사용한다 — 시그니처를 바꾸면 그쪽도 같이(4.6.1).
    globalThis.ubHqApi = { cFetchSKey, cDoStandby, fetchOrderRow, cExtractRowArgs, cFetchCandidates, cDoAssign };
    ```
    (6가지가 모두 그 지점에서 스코프에 있는지 grep 으로 먼저 확인. 함수 선언이 IIFE 안 어디든 호이스팅되므로 같은 함수 스코프면 된다.)
  - `renderSidebar` 의 `isInboundWrite()` 템플릿, 출고취소 섹션 `</div>` 뒤:
    ```html
    <div class="ub-sb-sect">
      <div class="ub-sb-sect-t">${ICONS.barcode}<span>패션 상품 재고화</span></div>
      <div class="ub-stk-row"><input class="ub-stk-in" id="ub-fs-in" placeholder="바코드 입력 후 Enter" autocomplete="off"><button class="ub-sb-btn ub-stk-go" id="ub-fs-go">불러오기</button></div>
      <div class="ub-stk-st" id="ub-fs-st"></div>
    </div>
    ```
  - 배선(출고취소 배선 블록 바로 뒤, 같은 패턴 — 포커스 뺏지 않음):
    ```js
    {
      const fin = document.getElementById('ub-fs-in'), fgo = document.getElementById('ub-fs-go'), fst = document.getElementById('ub-fs-st');
      if (fin && fgo && fst) {
        const setFs = (t, k) => { fst.textContent = t; fst.className = 'ub-stk-st' + (k ? ' ' + k : ''); };
        bindSidebarBcInput(fin, setFs);
        const goFs = () => {
          const bc = bcRead(fin, setFs); if (!bc) return;
          if (!(globalThis.ubFs && globalThis.ubFs.open)) { setFs('패션 재고화 모듈이 아직 로드되지 않았습니다 — 새로고침', 'err'); return; }
          globalThis.ubFs && globalThis.ubFs.open(bc, setFs);
        };
        fin.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goFs(); } });
        fgo.addEventListener('click', goFs);
      }
    }
    ```
    (`bindSidebarBcInput`·`bcRead` 의 실제 시그니처를 3276·3285 에서 확인하고 맞춘다.)

- [ ] **Step 4: 통과 확인** — `node --test tests/fashionstock-wiring.test.js` + `node --check src/skin.js` · Expected: PASS, 문법 OK

- [ ] **Step 5: 커밋** — `git commit -m "feat(패션 재고화): 작업C 함수 노출 · 사이드바 섹션"`

---

### Task 4: 유비샵 읽기·쓰기 `fashionstock-erp.js`

**Files:**
- Create: `src/fashionstock-erp.js`
- Test: 실측(읽기만) — 아래 Step 3

**Interfaces:**
- Consumes: `globalThis.ubFsCore`(Task 1), `globalThis.ubSpErp.{findVoucherItem, openFrame, loadFrame, waitLoad}`(Task 3), `globalThis.ubHqApi`(Task 3), `globalThis.ubArrival.arRows`, `globalThis.ubOi.oiSubmitResult`, `globalThis.ubErp.decodeErpHtml`
- Produces `globalThis.ubFsErp`:
  - `readItem(barcode) → {ok, msg?, modifyUrl, itemNum, k, desc, basicSalePrice, salePrice, img}`
  - `listCandidates(itemNum) → {ok, msg?, list: fsCandidates[]}`
  - `lookupPrice(itemNum, market, k) → {ok, msg?, price, base, status}`
  - `saveItem(modifyUrl, {desc, price}) → {ok, msg?}` + `verifyItem(modifyUrl, {desc, price}) → {ok, msg?}`
  - `hqConfirm(cand) → {ok, msg?, rowHtml}`
  - `assign(cand, barcode, rowHtml) → {ok, msg?}`

- [ ] **Step 1: 구현** — `src/fashionstock-erp.js`

```js
/* =============================================================================
 *  fashionstock-erp.js — 패션 상품 재고화의 유비샵 읽기·쓰기.
 *  쓰기는 saveItem·hqConfirm·assign 세 곳뿐. 나머지는 읽기.
 * ========================================================================== */
(function () {
  'use strict';
  const C = globalThis.ubFsCore, SP = globalThis.ubSpErp, O = globalThis.ubOi;
  const LOG = (...a) => { try { console.log('[UB][fashion]', ...a); } catch (_) {} };
  const PRICE_URL = 'https://sshwwwavcbgyiyojngav.supabase.co/functions/v1/price-lookup';
  const VERIFY_MS = 12000, STEP_MS = 1500;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const digits = (s) => String(s == null ? '' : s).replace(/[^\d]/g, '');
  const comma = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  async function postHtml(url, params) {
    const r = await fetch(url, { method: 'POST', credentials: 'include', cache: 'no-cache',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: new URLSearchParams(params).toString() });
    return globalThis.ubErp.decodeErpHtml(new Uint8Array(await r.arrayBuffer()));
  }

  async function readItem(barcode) {
    const v = await SP.findVoucherItem(barcode);
    if (!v.ok) return { ok: false, msg: v.msg };
    const fr = SP.openFrame();
    try {
      const d = await SP.loadFrame(fr, v.modifyUrl);
      const f = d.forms['form1'];
      if (!f) return { ok: false, msg: '수정 화면 form1 없음' };
      const need = ['itemEtcRemark', 'basicSalePrice', 'salePrice', 'itemNum', 'k'];
      const miss = need.filter((n) => !f.elements[n]);
      if (miss.length) return { ok: false, msg: '입력칸 없음: ' + miss.join(',') };
      const img = [...d.querySelectorAll('img')].map((i) => i.getAttribute('src') || '').find((s) => /\/upload\//.test(s)) || '';
      return { ok: true, modifyUrl: v.modifyUrl, itemNum: f.elements.itemNum.value.trim(), k: f.elements.k.value,
        desc: f.elements.itemEtcRemark.value, basicSalePrice: digits(f.elements.basicSalePrice.value), salePrice: digits(f.elements.salePrice.value), img };
    } catch (e) { return { ok: false, msg: String(e && e.message || e) }; }
    finally { fr.remove(); }
  }

  async function listCandidates(itemNum) {
    const html = await postHtml('/jun/orderitem/orderItemList.do?tcode=order_item', C.fsListParams(new Date()));
    if (/login|로그인/i.test(html) && !/t_list/.test(html)) return { ok: false, msg: '유비샵 로그인이 풀렸습니다' };
    const rows = globalThis.ubArrival.arRows(html);
    const list = C.fsCandidates(rows, itemNum);
    if (list == null) return { ok: false, msg: '주문 목록을 읽지 못했습니다' };
    return { ok: true, list };
  }

  async function lookupPrice(itemNum, market, k) {
    if (!market) return { ok: false, msg: '마켓을 정할 수 없는 고객 — 판매가 직접 입력' };
    const key = await new Promise((res) => { try { chrome.storage.local.get({ ubSlLedgerKey: '' }, (d) => res(String(d.ubSlLedgerKey || '').trim())); } catch (_) { res(''); } });
    if (!key) return { ok: false, msg: '아틀리에 조회 열쇠가 없습니다(확장 팝업에서 등록)' };
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await fetch(PRICE_URL, { method: 'POST', credentials: 'omit', signal: ac.signal,
        headers: { 'x-ledger-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ code: itemNum, market, k }] }) });
      if (!r.ok) return { ok: false, msg: '가격 조회 실패 HTTP ' + r.status };
      const row = ((await r.json()).rows || [])[0];
      if (!row) return { ok: false, msg: '가격 조회 응답 이상' };
      if (row.status !== 'ok') return { ok: false, msg: { not_found: '아틀리에에 없는 제품', ambiguous: '아틀리에 제품이 여러 개로 겹침', no_price: '그 마켓 가격 없음' }[row.status] || row.status };
      return { ok: true, price: C.fsPickPrice(row), base: row.base };
    } catch (e) { return { ok: false, msg: '가격 조회 실패: ' + (e && e.name === 'AbortError' ? '시간 초과' : e) }; }
    finally { clearTimeout(t); }
  }

  //  storeprice-erp savePrice 와 같은 판정(리다이렉트 msg) + 추가설명 칸.
  async function saveItem(modifyUrl, want) {
    const fr = SP.openFrame();
    try {
      const d = await SP.loadFrame(fr, modifyUrl);
      const f = d.forms['form1'];
      if (!f) return { ok: false, msg: '수정 화면 form1 없음' };
      LOG({ phase: 'before_save', modifyUrl, before: { desc: f.elements.itemEtcRemark.value, basic: f.elements.basicSalePrice.value, sale: f.elements.salePrice.value } });
      f.elements.itemEtcRemark.value = want.desc;
      f.elements.basicSalePrice.value = comma(want.price);
      f.elements.salePrice.value = comma(want.price);
      const btn = [...d.querySelectorAll('input[name="imageField22"]')].find((b) => b.form === f);
      if (!btn) return { ok: false, msg: '저장 버튼을 찾지 못해 저장하지 않았습니다' };
      const nav = SP.waitLoad(fr, 20000);
      btn.click();
      const blocked = new Promise((res) => {
        const iv = setInterval(() => { let a = null; try { a = d.documentElement.getAttribute('data-ub-sp-alert'); } catch (_) { clearInterval(iv); return; } if (a) { clearInterval(iv); res(a); } }, 200);
        nav.then(() => clearInterval(iv), () => clearInterval(iv));
      });
      const first = await Promise.race([nav.then(() => null), blocked]);
      if (first) return { ok: false, msg: '수정 화면 경고: ' + first };
      const res = O.oiSubmitResult(fr.contentWindow.location.href);
      return res.ok ? { ok: true } : { ok: false, msg: res.msg };
    } catch (e) { return { ok: false, msg: String(e && e.message || e) }; }
    finally { fr.remove(); }
  }
  async function verifyItem(modifyUrl, want) {
    const fr = SP.openFrame();
    try {
      const f = (await SP.loadFrame(fr, modifyUrl)).forms['form1'];
      if (!f) return { ok: false, msg: '확인용 수정 화면 없음' };
      const bad = [];
      if (f.elements.itemEtcRemark.value.trim() !== want.desc.trim()) bad.push('추가설명=' + f.elements.itemEtcRemark.value);
      ['basicSalePrice', 'salePrice'].forEach((n) => { if (digits(f.elements[n].value) !== String(want.price)) bad.push(n + '=' + f.elements[n].value); });
      return bad.length ? { ok: false, msg: '저장값 불일치: ' + bad.join(', ') } : { ok: true };
    } catch (e) { return { ok: false, msg: String(e && e.message || e) }; }
    finally { fr.remove(); }
  }

  async function pollRow(cand, until) {
    const H = globalThis.ubHqApi;
    const end = Date.now() + VERIFY_MS;
    let last = null;
    while (Date.now() < end) {
      last = await H.fetchOrderRow(cand.orderSeq, cand.orderDate);
      if (last && last.loginExpired) return { ok: false, msg: '유비샵 로그인이 풀렸습니다', row: last };
      if (last && last.found && until(last)) return { ok: true, row: last };
      await sleep(STEP_MS);
    }
    return { ok: false, row: last };
  }

  async function hqConfirm(cand) {
    const H = globalThis.ubHqApi;
    const pre = await H.fetchOrderRow(cand.orderSeq, cand.orderDate);
    if (!pre || !pre.found) return { ok: false, msg: '주문 행을 다시 찾지 못했습니다' };
    if (pre.code === 'OS-') return { ok: true, rowHtml: pre.rowHtml, note: '이미 본사확인' };
    if (pre.code !== 'O--') return { ok: false, msg: '주문 상태가 주문완료가 아닙니다(' + pre.text + ')' };
    const sKey = await H.cFetchSKey();
    if (!sKey) return { ok: false, msg: 'sKey 를 얻지 못했습니다' };
    await H.cDoStandby(cand.orderSeq, sKey, {});
    const p = await pollRow(cand, (r) => r.code === 'OS-');
    return p.ok ? { ok: true, rowHtml: p.row.rowHtml } : { ok: false, msg: p.msg || '본사확인이 확인되지 않았습니다(12초)' };
  }

  async function assign(cand, barcode, rowHtml) {
    const H = globalThis.ubHqApi;
    const a = H.cExtractRowArgs(rowHtml);
    if (!a) return { ok: false, msg: '배정 인자를 읽지 못했습니다' };
    const c = await H.cFetchCandidates(a.master, cand.orderSeq, a.shop, a.client, cand.orderDate, {});
    if (!c.ok) return { ok: false, msg: '배정 후보 조회 실패: ' + (c.reason || '') };
    const want = String(barcode).toUpperCase();
    const hit = c.candidates.find((x) => String(x.barcode).toUpperCase() === want);
    if (!hit) return { ok: false, msg: '배정 후보에 ' + barcode + ' 가 없습니다 — 직접 배정' };
    await H.cDoAssign(hit.barcode, cand.orderSeq, a.shop, a.client, cand.orderDate, {});
    const p = await pollRow(cand, (r) => r.code === 'I--' && String(r.assignedBarcode).toUpperCase() === want);
    return p.ok ? { ok: true } : { ok: false, msg: p.msg || '배정이 확인되지 않았습니다(12초) — 주문전표에서 확인' };
  }

  globalThis.ubFsErp = { readItem, listCandidates, lookupPrice, saveItem, verifyItem, hqConfirm, assign };
})();
```

  ⚠️ 구현 전 확인(코드 읽기): `cExtractRowArgs` 반환 키 이름(master/shop/client), `cDoStandby`·`cFetchCandidates`·`cDoAssign` 의 searchFields 에 `{}` 를 넘겨도 되는지(URL 빌더가 undefined 를 붙이지 않는지), `fetchOrderRow` 의 orderDate 형식(yyyymmdd). 다르면 위 코드를 맞춘다.

- [ ] **Step 2: 문법** — `node --check src/fashionstock-erp.js`

- [ ] **Step 3: 실측(읽기만)** — 사장님 Chrome 의 상품입고 탭에서 콘솔 대신 Task 5 완료 후 확인 창을 띄워 readItem·listCandidates·lookupPrice 결과가 화면에 맞게 나오는지 본다. `saveItem`·`hqConfirm`·`assign` 은 여기서 호출하지 않는다.

- [ ] **Step 4: 커밋** — `git commit -m "feat(패션 재고화): 유비샵 읽기·쓰기 어댑터"`

---

### Task 5: 확인 창·진행 `fashionstock.js` + 등록·버전

**Files:**
- Create: `src/fashionstock.js`
- Modify: `manifest.json`(content_scripts 1개 추가, version 4.6.1), `build-shell-index.ps1`($patterns 에 3파일), `shell-files.json`(재생성)
- Modify: `tests/fashionstock-wiring.test.js`(manifest 검사 추가)

**Interfaces:**
- Consumes: `ubFsCore`, `ubFsErp`
- Produces: `globalThis.ubFs.open(barcode, setStatus)`

- [ ] **Step 1: 배선 테스트 추가** — `tests/fashionstock-wiring.test.js` 끝에

```js
test('manifest — 상품입고 화면에만, ISOLATED, top frame, 의존 순서', () => {
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const cs = man.content_scripts.find((c) => c.js.includes('src/fashionstock.js'));
  assert.ok(cs);
  assert.deepEqual(cs.js, ['src/erp.js', 'src/orderimport-core.js', 'src/arrival-core.js', 'src/storeprice-core.js', 'src/storeprice-erp.js', 'src/fashionstock-core.js', 'src/fashionstock-erp.js', 'src/fashionstock.js']);
  assert.ok(cs.matches.every((m) => /\/input\/item\/inputItemWriteForm\.do\*$/.test(m)));
  assert.equal(cs.all_frames, false);
  assert.equal(cs.world || 'ISOLATED', 'ISOLATED');
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'shell-files.json'), 'utf8'));
  ['src/fashionstock-core.js', 'src/fashionstock-erp.js', 'src/fashionstock.js'].forEach((p) => assert.ok(idx.files.some((f) => f.path === p), p));
  assert.equal(idx.version, man.version);
});
```

  ⚠️ `arrival-core.js` 가 content script 에서 `globalThis.ubArrival` 을 세우는지(185행 근처) 먼저 확인. node 전용 노출이면 `root.ubArrival = api` 한 줄을 추가한다(동작 무변경).

- [ ] **Step 2: 실패 확인** — `node --test tests/fashionstock-wiring.test.js` · Expected: FAIL(manifest)

- [ ] **Step 3: 구현** — `src/fashionstock.js`

```js
/* =============================================================================
 *  fashionstock.js — 패션 상품 재고화 확인 창 + 진행.
 *  확인 창까지 쓰기 0. [진행] = ① 품목 수정 → ② 본사확인 → ③ 배정. 실패하면 거기서 멈춘다.
 * ========================================================================== */
(function () {
  'use strict';
  const C = globalThis.ubFsCore, E = globalThis.ubFsErp;
  const ID = 'ub-fs-panel';
  const LOCK = 'ubFsLock';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CSS = `
    #${ID}{position:fixed;inset:0;z-index:2147483000;background:rgba(17,24,39,.35);display:flex;align-items:flex-start;justify-content:center;padding-top:64px;font:14px Pretendard,'Malgun Gothic',sans-serif;color:#1b1b1b}
    #${ID} .bx{width:560px;max-width:calc(100vw - 32px);background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.18);padding:20px}
    #${ID} h3{margin:0 0 12px;font-size:16px}
    #${ID} .it{display:flex;gap:12px;align-items:center;margin-bottom:12px}
    #${ID} .it img{width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid #e3e7eb}
    #${ID} label{display:block;font-size:12px;color:#4b5563;margin:12px 0 4px}
    #${ID} input[type=text]{width:100%;height:36px;border:1px solid #d5dbe0;border-radius:6px;padding:0 10px;font:inherit;box-sizing:border-box}
    #${ID} input[type=text]:focus{outline:2px solid #4abcc7;outline-offset:1px}
    #${ID} .cands label{display:flex;gap:8px;align-items:center;margin:4px 0;font-size:13px;color:#1b1b1b}
    #${ID} .src{font-size:12px;color:#6b7280;margin-top:4px}
    #${ID} .warn{color:#c77a12}
    #${ID} .err{color:#e0483f}
    #${ID} .steps{margin:12px 0 0;padding:0;list-style:none;font-size:13px}
    #${ID} .steps li{margin:4px 0}
    #${ID} .ft{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
    #${ID} button{height:36px;padding:0 16px;border-radius:6px;border:1px solid #d5dbe0;background:#fff;font:600 13px inherit;cursor:pointer}
    #${ID} button.pri{background:#4abcc7;border-color:#4abcc7;color:#fff}
    #${ID} button:disabled{opacity:.45;cursor:not-allowed}
  `;

  function close() { const el = document.getElementById(ID); if (el) el.remove(); }

  async function open(barcode, setStatus) {
    close();
    setStatus('불러오는 중… ' + barcode, 'go');
    const item = await E.readItem(barcode);
    if (!item.ok) { setStatus(item.msg, 'err'); return; }
    const cl = await E.listCandidates(item.itemNum);
    if (!cl.ok) { setStatus(cl.msg, 'err'); return; }
    setStatus('', '');
    render(barcode, item, cl.list, setStatus);
  }

  function render(barcode, item, cands, setStatus) {
    const root = document.createElement('div');
    root.id = ID;
    root.innerHTML = '<style>' + CSS + '</style><div class="bx" role="dialog" aria-label="패션 상품 재고화">' +
      '<h3>패션 상품 재고화 · ' + esc(barcode) + '</h3>' +
      '<div class="it">' + (item.img ? '<img src="' + esc(item.img) + '" alt="">' : '') +
        '<div>' + esc(item.itemNum) + '<div class="src">현재 추가설명: ' + esc(item.desc) + ' · 판매가 ' + esc(item.salePrice) + '</div></div></div>' +
      '<label>고객 (최근 7일 · 같은 상품 · 주문완료)</label><div class="cands">' +
        (cands.length ? cands.map((c, i) => '<label><input type="radio" name="ubfs-c" value="' + i + '"' + (cands.length === 1 ? ' checked' : '') + '> ' +
          esc(c.orderDate.slice(2, 4) + '-' + c.orderDate.slice(4, 6) + '-' + c.orderDate.slice(6)) + ' · <b>' + esc(c.customer) + '</b> · ' + esc(c.junNum) + '</label>').join('')
          : '<div class="err">후보 주문이 없습니다 — 진행할 수 없습니다</div>') + '</div>' +
      '<label for="ubfs-desc">추가설명</label><input type="text" id="ubfs-desc">' +
      '<label for="ubfs-price">소비자가 · 판매가</label><input type="text" id="ubfs-price" inputmode="numeric"><div class="src" id="ubfs-src"></div>' +
      '<ul class="steps" id="ubfs-steps" hidden></ul>' +
      '<div class="ft"><button type="button" id="ubfs-close">닫기</button><button type="button" class="pri" id="ubfs-go" disabled>진행</button></div></div>';
    document.body.appendChild(root);
    const $ = (s) => root.querySelector(s);
    const desc = $('#ubfs-desc'), price = $('#ubfs-price'), src = $('#ubfs-src'), go = $('#ubfs-go');
    let cand = null, priceSeq = 0;
    const digits = (s) => String(s || '').replace(/[^\d]/g, '');
    const refresh = () => { go.disabled = !(cand && digits(price.value) && desc.value.trim()); };
    const pick = async (i) => {
      cand = cands[i];
      desc.value = C.fsComposeDesc(item.desc, C.fsCategoryLetter(item.itemNum), cand.customer);
      price.value = ''; src.textContent = '판매가 조회 중…'; src.className = 'src'; refresh();
      const my = ++priceSeq;
      const market = C.fsSuffixMarket(cand.customer);
      const r = await E.lookupPrice(item.itemNum, market, item.k);
      if (my !== priceSeq) return;   // 그 사이 다른 고객을 골랐다
      if (r.ok) { price.value = String(r.price).replace(/\B(?=(\d{3})+(?!\d))/g, ','); src.textContent = '아틀리에 ' + market + ' ' + (r.base ? '할인 전 판매가' : '판매가(할인 전 값 없음)'); }
      else { src.textContent = r.msg + ' — 직접 입력'; src.className = 'src warn'; }
      refresh();
    };
    root.querySelectorAll('input[name=ubfs-c]').forEach((el) => el.addEventListener('change', () => pick(+el.value)));
    desc.addEventListener('input', refresh); price.addEventListener('input', refresh);
    $('#ubfs-close').addEventListener('click', close);
    if (cands.length === 1) pick(0);
    go.addEventListener('click', () => run(barcode, item, cand, desc.value.trim(), +digits(price.value), root, setStatus));
  }

  async function run(barcode, item, cand, desc, price, root, setStatus) {
    const go = root.querySelector('#ubfs-go'), steps = root.querySelector('#ubfs-steps');
    root.querySelectorAll('input,button').forEach((el) => { if (el.id !== 'ubfs-close') el.disabled = true; });
    steps.hidden = false;
    const li = (t) => { const e = document.createElement('li'); e.textContent = '… ' + t; steps.appendChild(e); return (ok, m) => { e.textContent = (ok ? '✔ ' : '✖ ') + t + (m ? ' — ' + m : ''); e.className = ok ? '' : 'err'; }; };
    const now = Date.now();
    const held = await new Promise((res) => chrome.storage.local.get({ [LOCK]: null }, (d) => res(d[LOCK])));
    if (held && held.bc === barcode && now - held.at < 120000) { li('잠금')(false, '같은 바코드가 다른 창에서 진행 중'); return; }
    await new Promise((res) => chrome.storage.local.set({ [LOCK]: { bc: barcode, at: now } }, res));
    try {
      let s = li('품목 수정(추가설명·판매가)');
      let r = await E.saveItem(item.modifyUrl, { desc, price });
      if (r.ok) r = await E.verifyItem(item.modifyUrl, { desc, price });
      s(r.ok, r.msg); if (!r.ok) { setStatus(barcode + ' 품목 수정 실패 — 아무것도 바뀌지 않았거나 일부만 저장됨, 직접 확인', 'err'); return; }
      s = li('본사확인 · ' + cand.customer);
      const h = await E.hqConfirm(cand);
      s(h.ok, h.msg || h.note); if (!h.ok) { setStatus(barcode + ' 품목 수정 완료 · 본사확인부터 직접', 'warn'); return; }
      s = li('배정 · ' + barcode);
      const a = await E.assign(cand, barcode, h.rowHtml);
      s(a.ok, a.msg); if (!a.ok) { setStatus(barcode + ' 수정·본사확인 완료 · 배정은 직접', 'warn'); return; }
      setStatus(barcode + ' → ' + cand.customer + ' 완료', 'ok');
    } finally {
      chrome.storage.local.remove(LOCK);
      root.querySelector('#ubfs-close').disabled = false;
    }
  }

  globalThis.ubFs = { open, close };
})();
```

- manifest content_scripts 에 추가(skin.js 항목 **앞**):
```json
{
  "matches": ["http://ubdstore.ubshop.biz/input/item/inputItemWriteForm.do*", "https://ubdstore.ubshop.biz/input/item/inputItemWriteForm.do*"],
  "js": ["src/erp.js", "src/orderimport-core.js", "src/arrival-core.js", "src/storeprice-core.js", "src/storeprice-erp.js", "src/fashionstock-core.js", "src/fashionstock-erp.js", "src/fashionstock.js"],
  "run_at": "document_idle", "all_frames": false, "world": "ISOLATED"
}
```
- manifest `"version": "4.6.1"`, `build-shell-index.ps1` `$patterns` 에 `'src/fashionstock-core.js','src/fashionstock-erp.js','src/fashionstock.js'`, 그다음 `powershell -NoProfile -File build-shell-index.ps1`.

- [ ] **Step 4: 통과 확인** — `node --test tests/fashionstock-core.test.js tests/fashionstock-wiring.test.js tests/loader-integrity.test.js` + `for f in tests/*.test.js; do node --test "$f" >/dev/null 2>&1 || echo FAIL $f; done` · Expected: 신규 PASS, 기존 실패는 `factory-live-search` 1건(기존)만

- [ ] **Step 5: 커밋** — `git commit -m "feat(패션 재고화): 확인 창·진행 + 등록 (4.6.1)"` (푸시는 Task 6 확인 후)

---

### Task 6: 실측(읽기) → 검수 → 배포 → 첫 실행

- [ ] **Step 1: 읽기 실측** — 배포 전, 사장님 Chrome 상품입고 탭에 4개 파일을 임시 주입(4.5.9 때와 같은 방식: 임시 브랜치 raw → `new Function`)하고, 아직 배정 안 된 실버 바코드 하나로 확인 창을 연다. 확인: 품목·현재 추가설명·후보·자동 추가설명·판매가·출처 문구. **[진행] 누르지 않는다.** 데스크톱·좁은 폭 스크린샷.
- [ ] **Step 2: 검수 T2** — 대상 diff(ubishop-barcode-ext 4개 신규·3개 수정, d102-atelier 3개 신규). 외부 1명(로컬 Codex 있으면 Codex, 없으면 OpenRouter 선임표) → Opus(opus47/46). `docs/REVIEW-LEDGER.md` 누적 판정 첨부·갱신. 상한 3R.
- [ ] **Step 3: 배포** — 아틀리에 price-lookup(Task 2 Step 6에서 이미) · 확장 `git push`(ExtSync).
- [ ] **Step 4: 첫 라이브 실행** — 사장님 입회 1건. 결과(입고장 추가설명·판매가 · 주문 상태 입고완료 · 배정 바코드)를 화면으로 확인하고 원장에 기록.
