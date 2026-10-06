/* saleimport 에이블리(§10.9) 테스트 — CSV 파싱, 결제 시각 → 원장 주문 연결, 행 수 대조, erp 시각 조회(가짜 fetch).
 * 픽스처에는 이름·연락처가 없다. 테스트용 원장 행은 가명(고객A…)·010-0000-xxxx. 네트워크·브라우저 없음.
 * 실행: node --test tests/saleimport-ably.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'src', 'saleimport-core.js'));
const FX = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'saleimport', n), 'utf8').replace(/\r\n/g, '\n');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const AB = JSON.parse(FX('rows-ably.json'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const PAID = Date.UTC(2026, 6, 31, 5, 35, 50);        // 2026-07-31 14:35:50 KST
const ORDER_NO = '1785476140397';                      // 2026-07-31 14:35:40.397 KST
const NEAR_NO = String(Number(ORDER_NO) - 20000);      // 20초 앞 — 같은 창 안의 다른 주문(주문은 결제보다 먼저)
const LR = (o) => Object.assign({ order_no: ORDER_NO, market: '에이블리', recipient: '고객A', phone: '010-0000-1234', product: 'x', opt: '', amount: 37324, is_gift: false, status: '정상', order_date: '2026-07-31' }, o || {});
const ad = C.SL_ADAPTERS.find((a) => a.id === 'ably-settle');

/* ---------------------------------------------------------------- 파싱 */
test('에이블리: CSV 1행 — 정산금 34,848, paidAt = 결제 완료일(KST) → epoch ms, 어댑터 플래그', () => {
  const p = C.slParseFile(AB);
  assert.equal(p.ok, true);
  assert.equal(p.adapter.id, 'ably-settle');
  assert.equal(p.rows.length, 1);
  const r = p.rows[0];
  assert.equal(r.amount, 34848); assert.equal(r.key, 34848); assert.equal(r.qty, 1);
  assert.equal(r.orderNo, '640601752'); assert.equal(r.paidAt, PAID); assert.equal(r.isReturn, false);
  assert.equal(r.ledgerNo, '');
  assert.deepEqual([ad.suffix, ad.clientRule, ad.ledgerMarket, ad.ledgerMatch, ad.ledgerAmountCheck, ad.ledgerBy], ['에', 'ledger', '에이블리', true, 'count', 'time']);
});

test('에이블리: 정산금 ≤ 0 은 반품(수동), 결제 완료일·정산금을 못 읽으면 파일 거부, 필수 열 없으면 거부, 판별은 하나', () => {
  const h = AB[0], zero = clone(AB); zero[1][h.indexOf('정산금')] = '0';
  assert.equal(C.slParseFile(zero).rows[0].isReturn, true);
  const neg = clone(AB); neg[1][h.indexOf('정산금')] = '-500';
  assert.equal(C.slParseFile(neg).rows[0].isReturn, true);
  for (const bad of ['2026-13-31 14:35:50', '2026-07-31', '', '2026-02-30 10:00:00']) {
    const t = clone(AB); t[1][h.indexOf('결제 완료일')] = bad;
    assert.equal(C.slParseFile(t).ok, false, bad);
  }
  const t2 = clone(AB); t2[1][h.indexOf('정산금')] = 'abc';
  assert.equal(C.slParseFile(t2).ok, false);
  const m = clone(AB); m[0][h.indexOf('플랫폼 수수료')] = 'x';
  assert.equal(C.slParseFile(m).ok, false);
  assert.equal(C.slDetectAdapter(AB[0]).id, 'ably-settle');
});

/* ---------------------------------------------------------------- 시각 연결 */
test('slLedgerIndexByTime: 창 안에 원장 주문이 정확히 1개면 그 주문(실측 10초 차이)', () => {
  const rows = C.slParseFile(AB).rows;
  assert.deepEqual(C.slLedgerIndexByTime(rows, [LR(), LR({ is_gift: true, amount: 0 })]), [{ no: ORDER_NO }]);   // 같은 주문의 두 행은 1개 주문
  assert.deepEqual(C.slLedgerIndexByTime(rows, [LR()], 5000), [{ absent: true }]);                              // 창을 5초로 좁히면 밖
  assert.deepEqual(C.slLedgerIndexByTime(rows, [LR({ order_no: String(PAID + 50000) })]), [{ absent: true }]);   // 결제보다 50초 뒤에 만든 주문은 연결하지 않는다(한쪽 창)
  assert.deepEqual(C.slLedgerIndexByTime(rows, [LR({ order_no: String(PAID + 5000) })]), [{ no: String(PAID + 5000) }]);   // 뒤쪽 경계 +5초는 포함
  assert.deepEqual(C.slLedgerIndexByTime(rows, [LR({ order_no: String(PAID + 5001) })]), [{ absent: true }]);
  assert.deepEqual(C.slLedgerIndexByTime(rows, [LR({ order_no: String(PAID - 60000) })]), [{ no: String(PAID - 60000) }]);   // 앞쪽 경계 −60초는 포함
  assert.deepEqual(C.slLedgerIndexByTime(rows, [LR({ order_no: String(PAID - 60001) })]), [{ absent: true }]);
});

test('slLedgerIndexByTime: 60초 안에 다른 주문이 또 있으면 모호(ambiguous) · 없으면 absent · 창 밖은 무시', () => {
  const rows = C.slParseFile(AB).rows;
  assert.deepEqual(C.slLedgerIndexByTime(rows, [LR(), LR({ order_no: NEAR_NO })]), [{ ambiguous: true }]);
  assert.deepEqual(C.slLedgerIndexByTime(rows, []), [{ absent: true }]);
  assert.deepEqual(C.slLedgerIndexByTime(rows, [LR({ order_no: String(Number(ORDER_NO) + 600000) })]), [{ absent: true }]);
  assert.deepEqual(C.slLedgerIndexByTime(rows, [LR({ order_no: 'abc-not-time' })]), [{ absent: true }]);
});

test('slApplyTimeLedger → slGroupLedger: 연결되면 원장 고객명 묶음, 모호·없음은 차단(검색창 없음), 열쇠 없음·조회 실패도 차단', () => {
  const rows = C.slParseFile(AB).rows;
  const good = C.slApplyTimeLedger(rows, [LR()]);
  assert.equal(good[0].ledgerNo, ORDER_NO);
  const g = C.slGroupLedger(good, ad, C.slLedgerIndex([LR()], '에이블리'));
  assert.equal(g.length, 1); assert.equal(g[0].key, '고객A1234/에'); assert.equal(g[0].block, ''); assert.equal(g[0].source, '원장');
  const two = [LR(), LR({ order_no: NEAR_NO })];
  const ga = C.slGroupLedger(C.slApplyTimeLedger(rows, two), ad, C.slLedgerIndex(two, '에이블리'));
  assert.equal(ga.length, 1); assert.equal(ga[0].block, '결제 시각이 가까운 주문이 여러 건 — 직접 처리'); assert.equal(ga[0].pickable, false);
  const gn = C.slGroupLedger(C.slApplyTimeLedger(rows, []), ad, C.slLedgerIndex([], '에이블리'));
  assert.equal(gn[0].block, '원장에 없는 주문 — 직접 처리하세요'); assert.equal(gn[0].pickable, false);
  const gk = C.slGroupLedger(rows, ad, null);   // 열쇠 없음 — 에이블리는 이름이 없으니 전부 차단
  assert.ok(gk.length === 1 && gk[0].block);
  const gf = C.slGroupLedger(rows, ad, null, { lookupFailed: true });
  assert.match(gf[0].block, /원장 조회 실패/);
});

/* ---------------------------------------------------------------- §10.9 T3 보강: 결제 혼입·금액 범위·조정 행 */
const kstMs = (str) => { const [d, t] = str.split(' '); const [y, m, dd] = d.split('-').map(Number); const [h, mi, se] = t.split(':').map(Number); return Date.UTC(y, m - 1, dd, h - 9, mi, se); };
const FR = (orderNo, paid, amt, o) => Object.assign({ r: 1, orderNo, ledgerNo: '', paidAt: kstMs(paid), buyer: '', phone: '', qty: 1, key: amt, amount: amt, payTotal: amt + 2000, isReturn: amt <= 0, name: '팔찌', option: '' }, o || {});
const XNO = String(kstMs('2026-07-31 14:35:20') + 397);   // 주문 X — 14:35:20.397
const X2 = [LR({ order_no: XNO, amount: 37324 }), LR({ order_no: XNO, amount: 19000 })];
const flow = (fileRows, ledger) => {
  const g = C.slGroupLedger(C.slApplyTimeLedger(fileRows, ledger), ad, C.slLedgerIndex(ledger, '에이블리'));
  return g.map((x) => ({ block: x.block, n: x.rows.length }));
};
const MIXED = '서로 다른 결제가 한 원장 주문에 연결됨 — 직접 처리', AMT = '원장 금액이 결제 금액과 맞지 않음 — 직접 처리';

test('T3-1 probe A: 결제 시각이 다른 두 행이 같은 원장 주문에 연결되면 전부 차단', () => {
  const g = flow([FR('640601752', '2026-07-31 14:35:30', 34848), FR('640699999', '2026-07-31 14:35:50', 20000)], X2);
  assert.ok(g.length >= 1 && g.every((x) => x.block === MIXED), JSON.stringify(g));
});

test('T3-1 probe B: 상품 주문 번호가 겹치는 두 행(조정 행)은 차단', () => {
  const g = flow([FR('640601752', '2026-07-31 14:35:30', 34848), FR('640601752', '2026-07-31 14:35:30', 5000)], X2);
  assert.ok(g.every((x) => x.block === MIXED), JSON.stringify(g));
});

test('T3-1 정상: 한 결제(같은 결제 시각)의 서로 다른 두 상품 주문 번호는 ok', () => {
  const g = flow([FR('640601752', '2026-07-31 14:35:30', 34848), FR('640601753', '2026-07-31 14:35:30', 18000)], X2);
  assert.deepEqual(g, [{ block: '', n: 2 }]);
});

test('T3-2 probe G: 원장 주문이 결제보다 50초 뒤면 연결되지 않아 차단(원장에 없는 주문)', () => {
  const g = flow([FR('640601752', '2026-07-31 14:35:30', 34848)], [LR({ order_no: String(kstMs('2026-07-31 14:36:20')), amount: 37324 })]);
  assert.deepEqual(g, [{ block: '원장에 없는 주문 — 직접 처리하세요', n: 1 }]);
});

test('T3-3 probe C: 남의 주문 P 가 창 안이어도 금액 범위(Σ정산금 ≤ L)를 벗어나면 차단', () => {
  const P = LR({ order_no: String(kstMs('2026-07-31 14:35:20')), amount: 37324 });
  const g = flow([FR('640699999', '2026-07-31 14:35:50', 90000)], [P]);
  assert.deepEqual(g, [{ block: AMT, n: 1 }]);
});

test('T3-3 금액 범위: 실측(정산금 34,848 · 결제 36,000+지원 2,000 · 원장 37,324)은 통과, L 이 상한(38,000) 초과·하한(34,848) 미만이면 차단', () => {
  const rows = C.slParseFile(AB).rows;
  const ok = C.slApplyTimeLedger(rows, [LR()]);
  assert.equal(rows[0].payTotal, 38000);
  assert.equal(ok[0].ledgerBlock, undefined);
  assert.equal(C.slApplyTimeLedger(rows, [LR({ amount: 38001 })])[0].ledgerBlock, AMT);
  assert.equal(C.slApplyTimeLedger(rows, [LR({ amount: 38000 })])[0].ledgerBlock, undefined);
  assert.equal(C.slApplyTimeLedger(rows, [LR({ amount: 34847 })])[0].ledgerBlock, AMT);
  assert.equal(C.slApplyTimeLedger(rows, [LR({ amount: 34848 })])[0].ledgerBlock, undefined);
  assert.equal(C.slApplyTimeLedger(rows, [LR(), LR({ is_gift: true, amount: 99999 })])[0].ledgerBlock, undefined);   // 사은품은 L 에 넣지 않는다
});

test('T3-4: 조정 사유가 있는 행은 정산금이 양수여도 수동 목록(반품 취급) · 결제 금액·프로모션 지원금을 못 읽으면 파일 거부', () => {
  const h = AB[0], adj = clone(AB); adj[1][h.indexOf('조정 사유')] = '정산 조정';
  const p = C.slParseFile(adj);
  assert.equal(p.ok, true); assert.equal(p.rows[0].isReturn, true);
  assert.equal(C.slParseFile(AB).rows[0].isReturn, false);
  const bad = clone(AB); bad[1][h.indexOf('결제 금액')] = 'x';
  assert.equal(C.slParseFile(bad).ok, false);
  const bad2 = clone(AB); bad2[1][h.indexOf('프로모션 지원금')] = '';
  assert.equal(C.slParseFile(bad2).ok, false);
});

/* ---------------------------------------------------------------- 행 수 대조 */
const O = (o) => Object.assign({ date: '26-07-31', barcode: '2607A1', code: 'F-BF-Z-WG-ZZ-0001', name: '팔찌', gift: false, settle: 37324, qty: 1, price: 40000, cancel: false }, o || {});
const frow = (o) => Object.assign({ r: 1, orderNo: '640601752', ledgerNo: ORDER_NO, buyer: '', phone: '', qty: 1, key: 34848, amount: 34848, isReturn: false, name: '팔찌', option: '' }, o || {});
const lmap = (...rows) => C.slLedgerIndex(rows, '에이블리');
const COUNT = { amountCheck: 'count' };

test('행 수 대조: 파일 1행 = 원장 본품 1행이면 금액이 달라도(34,848 vs 37,324) 통과 · 줄 금액은 파일 정산금', () => {
  const m = C.slMatchLedger([frow()], lmap(LR()), [O()], [], COUNT);
  assert.equal(m.status, 'ok');
  assert.equal(m.lines.length, 1);
  assert.equal(m.lines[0].barcode, '2607A1');
  assert.equal(m.lines[0].amount, 34848);
  assert.equal(m.cash, 34848);
});

test('행 수 대조: 파일 1행 vs 원장 본품 2행 → 차단 · 사은품 행은 세지 않는다', () => {
  const two = C.slMatchLedger([frow()], lmap(LR(), LR({ amount: 20000 })), [O(), O({ barcode: '2607A2', settle: 20000 })], [], COUNT);
  assert.equal(two.status, 'block');
  assert.match(two.reason, /파일 상품 수 ≠ 원장 상품 수 — 주문 일부만 정산됐을 수 있음/);
  const gift = C.slMatchLedger([frow()], lmap(LR(), LR({ is_gift: true, amount: 0 })), [O()], [], COUNT);
  assert.equal(gift.status, 'ok');
});

test('쿠팡·퀸잇은 여전히 금액 대조(|F−L| ≤ 행 수) — count 옵션 없이는 에이블리 금액도 차단', () => {
  const cp = (o) => Object.assign({ order_no: '1102547057228', market: '쿠팡', amount: 18007, is_gift: false }, o || {});
  const fr = (o) => frow(Object.assign({ ledgerNo: '1102547057228', amount: 200000, key: 200000 }, o || {}));
  const bad = C.slMatchLedger([fr()], C.slLedgerIndex([cp()], '쿠팡'), [O({ settle: 18007 })], []);
  assert.equal(bad.status, 'block');
  assert.match(bad.reason, /파일 금액 .* ≠ 원장 .* 주문 일부만 정산됐을 수 있음/);
  const noOpt = C.slMatchLedger([frow()], lmap(LR()), [O()], []);
  assert.equal(noOpt.status, 'block');
  assert.equal(C.SL_ADAPTERS.filter((a) => a.ledgerAmountCheck).map((a) => a.id).join(), 'ably-settle');
});

test('패널 배선: matchEntry 가 어댑터의 ledgerAmountCheck 를 slMatchLedger 로 넘긴다', () => {
  assert.ok(/slMatchLedger\(e\.rows, e\.ledger, tr\.orders, tr\.sales, \{ retOrders: e.retOrders, retFull: e.retFull, amountCheck: S\.adapter\.ledgerAmountCheck \}\)/.test(read('src/saleimport.js')));
});

/* ---------------------------------------------------------------- erp ledgerLookupByTime */
function loadErp() {
  globalThis.ubSl = C;
  globalThis.ubOi = require(path.join(ROOT, 'src', 'orderimport-core.js'));
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'saleimport-erp.js'))];
  require(path.join(ROOT, 'src', 'saleimport-erp.js'));
  return globalThis.ubSlErp;
}
const KEY = 'test-key-AbC123';
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return handler(calls.length, url, init); };
  f.calls = calls; return f;
}
const okJson = (rows) => ({ ok: true, status: 200, json: async () => ({ rows }) });

test('ledgerLookupByTime: 100개씩 나눠 보내고, 중복·정수 아닌 값은 빼며, 열쇠는 헤더에만 있다', async () => {
  const E = loadErp(), prev = globalThis.fetch;
  try {
    const times = []; for (let i = 0; i < 230; i++) times.push(1785476140397 + i * 1000);
    globalThis.fetch = fakeFetch((n) => okJson([{ order_no: 'c' + n }]));
    const rows = await E.ledgerLookupByTime('에이블리', times.concat([times[0], 1.5, '17854761403', NaN, -5, null]), KEY);
    assert.equal(globalThis.fetch.calls.length, 3);
    const bodies = globalThis.fetch.calls.map((c) => JSON.parse(c.init.body));
    assert.deepEqual(bodies.map((b) => b.times.length), [100, 100, 30]);
    assert.ok(bodies.every((b) => b.market === '에이블리' && Object.keys(b).sort().join() === 'market,times'));
    assert.ok(bodies.every((b) => b.times.every(Number.isInteger)));
    assert.deepEqual(rows.map((r) => r.order_no), ['c1', 'c2', 'c3']);
    assert.ok(globalThis.fetch.calls.every((c) => c.init.headers['x-ledger-key'] === KEY && c.init.method === 'POST' && c.init.credentials === 'omit'));
    assert.ok(globalThis.fetch.calls.every((c) => !c.url.includes(KEY) && !c.init.body.includes(KEY)));
  } finally { globalThis.fetch = prev; }
});

test('ledgerLookupByTime: 유효한 시각이 없으면 fetch 0 · 빈 배열, 열쇠·마켓이 없으면 던진다', async () => {
  const E = loadErp(), prev = globalThis.fetch;
  try {
    globalThis.fetch = fakeFetch(() => okJson([]));
    assert.deepEqual(await E.ledgerLookupByTime('에이블리', [1.5, 'x'], KEY), []);
    assert.equal(globalThis.fetch.calls.length, 0);
    await assert.rejects(() => E.ledgerLookupByTime('에이블리', [1785476140397], ' '), /ledger_key_missing/);
    await assert.rejects(() => E.ledgerLookupByTime('', [1785476140397], KEY), /ledger_market_missing/);
  } finally { globalThis.fetch = prev; }
});

test('ledgerLookupByTime: fail-closed — 둘째 덩어리가 non-2xx 면 일부 결과 없이 던진다(오류에 열쇠 없음) · 형식 오류·네트워크 오류도', async () => {
  const E = loadErp(), prev = globalThis.fetch;
  try {
    const times = []; for (let i = 0; i < 150; i++) times.push(1785476140397 + i * 1000);
    globalThis.fetch = fakeFetch((n) => n === 1 ? okJson([{ order_no: 'a' }]) : { ok: false, status: 502, json: async () => ({}) });
    await assert.rejects(() => E.ledgerLookupByTime('에이블리', times, KEY), (e) => /ledger_lookup_http_502/.test(e.message) && !e.message.includes(KEY));
    globalThis.fetch = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }));
    await assert.rejects(() => E.ledgerLookupByTime('에이블리', [1785476140397], KEY), /bad_shape/);
    globalThis.fetch = fakeFetch(() => { throw new Error('boom ' + KEY); });
    await assert.rejects(() => E.ledgerLookupByTime('에이블리', [1785476140397], KEY), (e) => /network/.test(e.message) && !e.message.includes(KEY));
  } finally { globalThis.fetch = prev; }
});

test('패널 파일 선택이 CSV(에이블리 정산세부내역)를 허용한다', () => {
  const m = read('src/saleimport.js').match(/id="ub-sl-file" accept="([^"]*)"/);
  assert.ok(m, '파일 입력 존재');
  const acc = m[1].split(',');
  ['.xls', '.xlsx', '.csv'].forEach((x) => assert.ok(acc.includes(x), x));
});

test('팝업: 아틀리에 조회 열쇠 설명이 한 줄 전체를 쓴다(입력칸·버튼과 한 줄에서 눌려 글자가 세로로 쪼개지지 않게)', () => {
  const html = read('popup/popup.html');
  const row = html.slice(html.indexOf('아틀리에 조회 열쇠') - 200, html.indexOf('id="ledgerKeySave"'));
  assert.match(row, /<div class="label" style="flex:1 1 100%">/);
  assert.ok(!/GS 판매 처리 가져오기/.test(html + read('src/saleimport.js')), '스위치 이름은 판매 처리 가져오기');
});
