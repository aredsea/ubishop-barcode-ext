/* saleimport 아틀리에 원장 연동(§10.8) 테스트 — 쿠팡·퀸잇·아몬즈 파싱, 원장 고객·매칭, erp ledgerLookup(가짜 fetch), 열쇠 안전.
 * 픽스처는 가명화된 것(고객A…, 010-0000-xxxx). 네트워크·브라우저 없음.
 * 실행: node --test tests/saleimport-ledger.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'src', 'saleimport-core.js'));
const FX = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'saleimport', n), 'utf8').replace(/\r\n/g, '\n');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const CP = JSON.parse(FX('rows-coupang.json'));
const QN = JSON.parse(FX('rows-queenit.json'));
const AM = JSON.parse(FX('rows-amondz.json'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const ad = (id) => C.SL_ADAPTERS.find((a) => a.id === id);

/* ---------------------------------------------------------------- 파싱 */
test('쿠팡: 정산금액 0 인 배송료 행은 버리고, 0 이 아닌 배송료·환불 행은 수동 목록(isReturn)', () => {
  const p = C.slParseFile(CP);
  assert.equal(p.ok, true);
  assert.equal(p.adapter.id, 'coupang-revenue');
  //  상품 3행(주문 3건 중 하나는 환불 쌍) + 정산금액 5,802 배송료 1행. 정산 0 배송료 6행은 없다.
  assert.equal(p.rows.length, 5);
  assert.ok(!p.rows.some((r) => r.amount === 0));
  const live = p.rows.filter((r) => !r.isReturn);
  assert.deepEqual(live.map((r) => [r.ledgerNo, r.amount]), [['1102547057228', 18008], ['29101961497624', 248448], ['9102334328404', 15567]]);
  const manual = p.rows.filter((r) => r.isReturn);
  assert.deepEqual(manual.map((r) => r.amount).sort((a, b) => a - b), [-15567, 5802]);
  assert.ok(manual.some((r) => /기본배송료/.test(r.name)));
  assert.equal(live[0].buyer, '***');
  assert.equal(live[0].qty, 1);
});

test('쿠팡: 환불수량>0(정산 양수)도 반품, 숫자 아닌 정산금액은 파일 거부, 필수 열 없으면 거부', () => {
  const r = clone(CP);
  const h = r[0], i = r.findIndex((x, k) => k > 0 && x[h.indexOf('주문번호')] === '1102547057228' && !String(x[h.indexOf('옵션 ID')]).startsWith('<'));
  r[i][h.indexOf('환불수량')] = '1';
  assert.equal(C.slParseFile(r).rows.find((x) => x.ledgerNo === '1102547057228' && x.amount === 18008).isReturn, true);
  const bad = clone(CP); bad[i][h.indexOf('정산금액')] = 'abc';
  assert.equal(C.slParseFile(bad).ok, false);
  const miss = clone(CP); miss[0][h.indexOf('옵션명')] = 'x';
  assert.equal(C.slParseFile(miss).ok, false);
});

test('퀸잇: 상품 구매 행만 처리, ledgerNo = 주문번호(개별주문번호 아님), 그 외 거래유형·음수는 반품(수동)', () => {
  const p = C.slParseFile(QN);
  assert.equal(p.ok, true);
  assert.equal(p.adapter.id, 'queenit-settle');
  assert.equal(p.rows.length, 2);
  assert.ok(p.rows.every((r) => !r.isReturn));
  assert.deepEqual(p.rows.map((r) => [r.ledgerNo, r.orderNo, r.amount]), [
    ['ORD2609240958169DCE3', 'ORD2609240958169DCE3X83S84', 45941], ['ORD260904205623644CC', 'ORD260904205623644CCA05Z06', 245016]]);
  assert.equal(p.rows[0].note, '정산상태 대기');
  const h = QN[0], t = clone(QN); t[1][h.indexOf('거래유형')] = '환불';
  assert.equal(C.slParseFile(t).rows[0].isReturn, true);
  const n = clone(QN); n[2][h.indexOf('정산금액(A-B-C+D)')] = '-100';
  assert.equal(C.slParseFile(n).rows[1].isReturn, true);
});

test('아몬즈: 배송비 행은 제외(수동), 합성 상품 행은 수취인+연락처 뒤4 로 이름을 만든다(원장 없이도)', () => {
  const p0 = C.slParseFile(AM);
  assert.equal(p0.ok, true);
  assert.equal(p0.adapter.id, 'amondz-settle');
  assert.equal(p0.rows.length, 1);
  assert.equal(p0.rows[0].isReturn, true);
  //  합성 상품 행(픽스처 생성기 출력에는 넣지 않는다)
  const h = AM[0], row = clone(AM[1]);
  row[h.indexOf('상품주문번호')] = '2026091200000001'; row[h.indexOf('구분')] = '상품 구매'; row[h.indexOf('상품명')] = '테스트 반지';
  row[h.indexOf('정산금액')] = '45,000';
  const rows = AM.concat([row]);
  const p = C.slParseFile(rows);
  assert.equal(p.ok, true);
  const prod = p.rows.filter((r) => !r.isReturn);
  assert.equal(prod.length, 1);
  assert.equal(prod[0].amount, 45000);
  assert.equal(prod[0].orderNo, '2026091200000001');
  assert.equal(prod[0].ledgerNo, AM[1][h.indexOf('주문번호')]);
  const g = C.slGroupByClient(p.rows, p.adapter);
  assert.equal(g.length, 1);
  assert.equal(g[0].key, '고객A1234/아');
  assert.equal(g[0].source, '파일 연락처');
  assert.equal(C.slClientName('고객A', '010-0000-1234', '아'), '고객A1234/아');
  assert.equal(C.slClientName('고객A', '010-0000-1234'), '고객A1234/G');
});

test('기존 어댑터에 ledgerNo/ledgerMarket 이 붙고, 판별은 여전히 어댑터 하나', () => {
  const INI = JSON.parse(FX('rows-inicis-card.json')), SSG = JSON.parse(FX('rows-ssg.json'));
  const pi = C.slParseFile(INI), ps = C.slParseFile(SSG);
  assert.equal(pi.adapter.ledgerMarket, '카페24');
  assert.ok(pi.rows.every((r) => r.ledgerNo === r.orderNo));
  assert.equal(ps.adapter.ledgerMarket, 'SSG');
  assert.ok(ps.rows.every((r) => r.ledgerNo && r.orderNo === r.ledgerNo + '-' + r.orderNo.split('-').pop()));
  [[CP, 'coupang-revenue'], [QN, 'queenit-settle'], [AM, 'amondz-settle']].forEach(([rows, id]) => assert.equal(C.slDetectAdapter(rows[0]).id, id));
});

/* ---------------------------------------------------------------- 원장 고객 */
const LR = (o) => Object.assign({ order_no: '1102547057228', market: '쿠팡', recipient: '고객A', phone: '010-0000-1234', product: 'x', opt: '', amount: 18007, is_gift: false, status: '정상', order_date: '2026-08-26' }, o || {});

test('slLedgerIndex: 마켓이 다른 행·빈 주문번호는 버린다', () => {
  const idx = C.slLedgerIndex([LR(), LR({ market: 'SSG' }), LR({ order_no: '' }), LR({ order_no: ' 77770000 ' }), null], '쿠팡');
  assert.deepEqual([...idx.keys()], ['1102547057228', '77770000']);
  assert.equal(idx.get('1102547057228').length, 1);
});

test('slLedgerClient: 일관 → 이름, 수령자·전화 불일치 → 차단, 취소 → 차단, 전화 없음 → 차단', () => {
  const a = ad('coupang-revenue');
  assert.deepEqual(C.slLedgerClient([LR(), LR({ is_gift: true, amount: 0 })], a), { name: '고객A1234/쿠', recipient: '고객A' });
  assert.deepEqual(C.slLedgerClient([LR({ phone: '01000001234' })], a).name, '고객A1234/쿠');
  assert.match(C.slLedgerClient([LR(), LR({ recipient: '고객B' })], a).block, /불일치/);
  assert.match(C.slLedgerClient([LR(), LR({ phone: '010-0000-9999' })], a).block, /불일치/);
  assert.match(C.slLedgerClient([LR({ status: '취소완료' })], a).block, /취소/);
  assert.match(C.slLedgerClient([LR({ phone: '' })], a).block, /전화/);
  assert.match(C.slLedgerClient([], a).block, /원장에 없는/);
});

test('slGroupLedger: 원장에서 찾으면 원장 고객명 묶음(근거 원장) · 못 찾으면 쿠팡은 차단(직접 고르기) · 카페24 는 prefix4 로 되돌아감', () => {
  const p = C.slParseFile(CP);
  const idx = C.slLedgerIndex([LR(), LR({ order_no: '29101961497624', recipient: '고객B', phone: '010-0000-2345', amount: 248447 })], '쿠팡');
  const g = C.slGroupLedger(p.rows, p.adapter, idx);
  const byKey = Object.fromEntries(g.map((x) => [x.key, x]));
  assert.ok(byKey['고객A1234/쿠'] && byKey['고객B2345/쿠']);
  assert.equal(byKey['고객A1234/쿠'].source, '원장');
  assert.equal(byKey['고객A1234/쿠'].block, '');
  assert.ok(byKey['고객A1234/쿠'].ledger.has('1102547057228'));
  const nf = g.find((x) => /9102334328404/.test(x.key));
  assert.equal(nf.block, '원장에 없는 주문 — 직접 처리하세요');
  assert.equal(nf.pickable, false);   // 검색창 없음(§10.8)
  assert.equal(nf.ledger.size, 0);
  assert.ok(g.every((x) => x.rows.every((r) => !r.isReturn)));
  assert.equal(byKey['고객A1234/쿠'].retOrders.has('9102334328404'), true);
  //  취소 상태 → 처음부터 차단, 직접 고르기 불가
  const g2 = C.slGroupLedger(p.rows, p.adapter, C.slLedgerIndex([LR({ status: '취소' })], '쿠팡'));
  const h = g2.find((x) => /원장 주문/.test(x.key));
  assert.ok(h && /취소/.test(h.block) && h.pickable === false);
  //  열쇠 없음(idx=null): 쿠팡 전부 차단
  const g3 = C.slGroupLedger(p.rows, p.adapter, null);
  assert.ok(g3.length === 3 && g3.every((x) => x.block));
  //  카페24 — 원장에 없으면 기존 prefix4 묶음
  const INI = C.slParseFile(JSON.parse(FX('rows-inicis-card.json')));
  const g4 = C.slGroupLedger(INI.rows, INI.adapter, null);
  assert.ok(g4.length > 0 && g4.every((x) => !x.block && x.source === '이름 추정' && /\/카$/.test(x.key)));
});

/* ---------------------------------------------------------------- 원장 매칭 */
const O = (o) => Object.assign({ date: '26-08-26', barcode: '2608A1', code: 'F-BF-Z-WG-ZZ-0001', name: '팔찌', gift: false, settle: 18007, qty: 1, price: 23140, cancel: false }, o || {});
const frow = (o) => Object.assign({ r: 1, orderNo: '1102547057228-1', ledgerNo: '1102547057228', buyer: '***', phone: '', qty: 1, key: 18008, amount: 18008, isReturn: false, name: '팔찌', option: '' }, o || {});
const lmap = (...rows) => C.slLedgerIndex(rows, '쿠팡');

test('slMatchLedger: 파일 금액이 아니라 원장 금액으로 줄을 찾고, 1원 차이는 파일 합으로 배분(Σ = 파일 합)', () => {
  const m = C.slMatchLedger([frow()], lmap(LR()), [O()], []);
  assert.equal(m.status, 'ok');
  assert.equal(m.lines.length, 1);
  assert.equal(m.lines[0].amount, 18008);
  assert.equal(m.lines[0].barcode, '2608A1');
  assert.equal(m.lines[0].ledgerNo, '1102547057228');
  assert.equal(m.cash, 18008);
});

test('slMatchLedger: 한 주문 두 줄 — 원장 비율 배분, floor, 나머지 원은 첫 줄, Σ = 파일 합', () => {
  const led = lmap(LR({ amount: 100000 }), LR({ amount: 148447, product: 'y' }));
  const orders = [O({ settle: 100000, barcode: '2608A1' }), O({ settle: 148447, barcode: '2608A2' })];
  const m = C.slMatchLedger([frow({ amount: 248448, key: 248448 })], led, orders, []);
  assert.equal(m.status, 'ok');
  assert.deepEqual(m.lines.map((l) => [l.barcode, l.amount]), [['2608A1', 100001], ['2608A2', 148447]]);
  assert.equal(m.cash, 248448);
  //  파일 합 = 원장 합 이면 줄별로 원장 금액 그대로
  const same = C.slMatchLedger([frow({ amount: 248447, key: 248447 })], led, orders, []);
  assert.deepEqual(same.lines.map((l) => l.amount), [100000, 148447]);
});

test('slMatchLedger: 같은 주문의 파일 행이 여러 개면 합쳐서 배분(첫 행에 줄이 붙는다)', () => {
  const led = lmap(LR({ amount: 1000 }), LR({ amount: 3000 }));
  const orders = [O({ settle: 1000, barcode: '2608A1' }), O({ settle: 3000, barcode: '2608A2' })];
  const m = C.slMatchLedger([frow({ orderNo: 'n-1', amount: 1500, key: 1500 }), frow({ orderNo: 'n-2', amount: 2500, key: 2500 })], led, orders, []);
  assert.equal(m.status, 'ok');
  assert.equal(m.cash, 4000);
  assert.ok(m.lines.every((l) => l.orderNo === 'n-1'));
});

test('slMatchLedger: 줄이 모자라거나 남으면 차단', () => {
  const led = lmap(LR({ amount: 100000 }), LR({ amount: 148447 }));
  const f = [frow({ amount: 248447, key: 248447 })];
  assert.match(C.slMatchLedger(f, led, [O({ settle: 100000 })], []).reason, /주문 줄 0개 \(필요 1개\)/);
  assert.match(C.slMatchLedger(f, led, [O({ settle: 100000, barcode: '2608A1' }), O({ settle: 100000, barcode: '2608A3' }), O({ settle: 148447, barcode: '2608A2' })], []).reason, /주문 줄 2개 \(필요 1개\)/);
});

test('slMatchLedger: 원장 사은품 행은 기대 줄이 아니고, 유비샵 사은품 줄은 같은 주문일이면 0원으로 같이', () => {
  const led = lmap(LR(), LR({ is_gift: true, amount: 0, product: '사은품' }));
  const orders = [O(), O({ gift: true, settle: null, barcode: '2608G1', name: '트레이(사은품)' }), O({ gift: true, settle: null, barcode: '2608G2', date: '26-07-01' })];
  const m = C.slMatchLedger([frow()], led, orders, []);
  assert.equal(m.status, 'ok');
  assert.deepEqual(m.lines.map((l) => [l.barcode, l.gift, l.amount]), [['2608A1', false, 18008], ['2608G1', true, 0]]);
  assert.equal(m.cash, 18008);
});

test('slMatchLedger: 이미 판매됨 → sold, 취소·바코드 없음·여러 주문일·반품 행 동반·원장 없음·금액 0 → 차단', () => {
  const f = [frow()];
  assert.equal(C.slMatchLedger(f, lmap(LR()), [O()], [{ barcode: '2608A1' }]).status, 'sold');
  assert.match(C.slMatchLedger(f, lmap(LR()), [O({ cancel: true })], []).reason, /취소/);
  assert.match(C.slMatchLedger(f, lmap(LR()), [O({ barcode: '' })], []).reason, /바코드/);
  assert.match(C.slMatchLedger([frow({ amount: 2, key: 2 })], lmap(LR({ amount: 1 }), LR({ amount: 1 })), [O({ settle: 1 }), O({ settle: 1, date: '26-08-27', barcode: '2608A2' })], []).reason, /여러 주문일/);
  assert.match(C.slMatchLedger(f, lmap(LR()), [O()], [], { retOrders: new Set(['1102547057228']) }).reason, /반품/);
  assert.match(C.slMatchLedger(f, new Map(), [O()], []).reason, /원장에 없는/);
  assert.match(C.slMatchLedger([frow({ amount: 0, key: 0 })], lmap(LR()), [O()], []).reason, /0 이하/);
  assert.match(C.slMatchLedger(f, lmap(LR({ amount: 0 })), [O()], []).reason, /원장 금액/);
  assert.match(C.slMatchLedger(f, lmap(LR({ is_gift: true })), [O()], []).reason, /본품 줄이 없음/);
});

test('slMatchLedger: 다른 묶음과 줄이 겹치면 slOverlaps 가 둘 다 잡는다', () => {
  const m1 = C.slMatchLedger([frow()], lmap(LR()), [O()], []);
  const m2 = C.slMatchLedger([frow({ ledgerNo: '55550000' })], C.slLedgerIndex([LR({ order_no: '55550000' })], '쿠팡'), [O()], []);
  const ov = C.slOverlaps([{ key: 'A', st: 'ok', match: m1 }, { key: 'B', st: 'ok', match: m2 }]);
  assert.deepEqual([...ov].sort(), ['A', 'B']);
});

/* ---------------------------------------------------------------- erp ledgerLookup */
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

test('ledgerLookup: 200개씩 나눠 보내고, 중복·잘못된 번호는 빼며, 열쇠는 헤더에만 있다', async () => {
  const E = loadErp();
  const nos = []; for (let i = 0; i < 450; i++) nos.push('ORD' + String(10000 + i));
  nos.push('ORD10000', 'ab', 'bad no!', '', 'x'.repeat(41), '한글주문1234', null);
  const f = fakeFetch((n, u, init) => okJson(JSON.parse(init.body).orderNos.map((o) => ({ order_no: o }))));
  const prev = globalThis.fetch; globalThis.fetch = f;
  try {
    const rows = await E.ledgerLookup(nos, KEY);
    assert.equal(f.calls.length, 3);
    assert.deepEqual(f.calls.map((c) => JSON.parse(c.init.body).orderNos.length), [200, 200, 50]);
    assert.equal(rows.length, 450);
    f.calls.forEach((c) => {
      assert.equal(c.url, 'https://sshwwwavcbgyiyojngav.supabase.co/functions/v1/ledger-lookup');
      assert.equal(c.init.method, 'POST');
      assert.equal(c.init.headers['x-ledger-key'], KEY);
      assert.ok(!c.url.includes(KEY), '열쇠가 URL 에');
      assert.ok(!c.init.body.includes(KEY), '열쇠가 본문에');
      assert.equal(c.init.credentials, 'omit');
      assert.ok(c.init.signal, '타임아웃 신호');
    });
  } finally { globalThis.fetch = prev; }
});

test('ledgerLookup: 번호가 하나도 유효하지 않으면 fetch 0 · 빈 배열, 열쇠가 없으면 던진다', async () => {
  const E = loadErp();
  const f = fakeFetch(() => okJson([]));
  const prev = globalThis.fetch; globalThis.fetch = f;
  try {
    assert.deepEqual(await E.ledgerLookup(['a', '!!!!'], KEY), []);
    assert.equal(f.calls.length, 0);
    await assert.rejects(() => E.ledgerLookup(['ORD1234'], ''), /ledger_key_missing/);
    await assert.rejects(() => E.ledgerLookup(['ORD1234'], '   '), /ledger_key_missing/);
    assert.equal(f.calls.length, 0);
  } finally { globalThis.fetch = prev; }
});

test('ledgerLookup: fail-closed — 둘째 덩어리가 non-2xx 면 일부 결과를 돌려주지 않고 던진다(오류에 열쇠 없음)', async () => {
  const E = loadErp();
  const nos = []; for (let i = 0; i < 250; i++) nos.push('ORD' + String(10000 + i));
  const f = fakeFetch((n, u, init) => (n === 2 ? { ok: false, status: 502, json: async () => ({ error: KEY }) } : okJson([{ order_no: 'ORD10000' }])));
  const prev = globalThis.fetch; globalThis.fetch = f;
  try {
    await assert.rejects(() => E.ledgerLookup(nos, KEY), (e) => /ledger_lookup_http_502/.test(e.message) && !e.message.includes(KEY));
    assert.equal(f.calls.length, 2);
    for (const status of [400, 401, 403, 500]) {
      globalThis.fetch = fakeFetch(() => ({ ok: false, status, json: async () => ({}) }));
      await assert.rejects(() => E.ledgerLookup(['ORD1234'], KEY), new RegExp('http_' + status));
    }
    globalThis.fetch = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }));
    await assert.rejects(() => E.ledgerLookup(['ORD1234'], KEY), /bad_shape/);
    globalThis.fetch = fakeFetch(() => { throw new Error('boom ' + KEY); });
    await assert.rejects(() => E.ledgerLookup(['ORD1234'], KEY), (e) => /network/.test(e.message) && !e.message.includes(KEY));
  } finally { globalThis.fetch = prev; }
});

/* ---------------------------------------------------------------- 열쇠 안전(소스 구조) */
test('열쇠 안전: 팝업 입력은 password, 저장 키 ubSlLedgerKey, 패널은 열쇠를 지역 변수로만 쓰고 로그·상태·화면에 싣지 않는다', () => {
  const html = read('popup/popup.html'), pjs = read('popup/popup.js'), ui = read('src/saleimport.js'), erp = read('src/saleimport-erp.js');
  assert.ok(/<input id="ledgerKey" type="password"/.test(html), '입력란 type=password');
  assert.ok(/아틀리에 조회 열쇠/.test(html));
  assert.ok(pjs.includes("const LKEY = 'ubSlLedgerKey'"));
  assert.ok(/lkInput\.value = ''/.test(pjs), '저장 뒤 입력란 비움');
  assert.ok(!/textContent\s*=\s*[^;]*lkInput|innerHTML[^;]*LKEY/.test(pjs), '열쇠 값을 화면에 쓰지 않음');
  assert.ok(ui.includes("KEY_LKEY = 'ubSlLedgerKey'"));
  //  열쇠는 fetchLedgerIndex 지역 변수 — S(상태·로그 원천)에 키 필드가 없고, 로그·console·로그JSON 에 안 간다
  assert.ok(!/S\.(ledgerKey|lkey|key)\b/.test(ui));
  assert.ok(!/(logLine|console\.\w+)\([^)]*\bkey\b[^)]*\)/.test(ui.replace(/logLine\(key, step/g, '')), '로그에 열쇠');
  const fn = ui.slice(ui.indexOf('async function fetchLedgerIndex'), ui.indexOf('\n  }\n', ui.indexOf('async function fetchLedgerIndex')));
  assert.ok(/const key = String\(d\[KEY_LKEY\]/.test(fn) && /E\.ledgerLookup\(nos, key\)/.test(fn));
  assert.ok(!/notice = [^;]*\bkey\b/.test(fn.replace(/notice = '아틀리에 조회 열쇠[^']*'/, '')), '알림에 열쇠 값');
  assert.ok(/enqueue\(\(\) => E\.ledgerLookup/.test(fn), '읽기 대기열 안에서 조회');
  //  erp: 열쇠는 헤더만 — URL·본문에 없다. 오류 메시지에 변수 k 를 쓰지 않는다.
  const lk = erp.slice(erp.indexOf('async function ledgerLookup'), erp.indexOf('globalThis.ubSlErp'));
  assert.ok(/headers: \{ 'x-ledger-key': k,/.test(lk));
  assert.ok(!/JSON\.stringify\(\{[^}]*\bk\b/.test(lk));
  assert.ok(!/new Error\([^)]*\bk\b/.test(lk));
  assert.ok(!/console\./.test(lk));
});

test('패널 배선: 조회는 파싱 뒤 · 묶음 전, 열쇠 없으면 한 줄 안내, 마켓 문구 7종', () => {
  const ui = read('src/saleimport.js');
  const i = ui.indexOf('async function loadFile'), b = ui.slice(i, ui.indexOf('\n  }\n', i));
  assert.ok(b.indexOf('parseEntries(parsed)') < b.indexOf('fetchLedgerIndex()') && b.indexOf('fetchLedgerIndex()') < b.indexOf('buildEntries(li.idx)'));
  assert.ok(ui.includes("'아틀리에 조회 열쇠가 없어요 — 팝업에서 넣어 주세요'"));
  assert.ok(ui.includes("chip('gray', '근거 ' + e.source)"));
  assert.ok(ui.includes('GS샵 · 카페24 이니시스(신용카드) · SSG · 스마트스토어 · 쿠팡 · 퀸잇 · 아몬즈'));
});

test('slMatchLedger: 같은 금액 줄이 여러 주문일(두 주문)이거나 한 주문의 줄이 다른 날짜면 각각 차단', () => {
  const two = C.slMatchLedger([frow({ ledgerNo: 'AAAA0001', orderNo: 'a', amount: 1000, key: 1000 })],
    C.slLedgerIndex([LR({ order_no: 'AAAA0001', amount: 500 }), LR({ order_no: 'AAAA0001', amount: 500 })], '쿠팡'),
    [O({ settle: 500, barcode: '2608A1' }), O({ settle: 500, barcode: '2608A2', date: '26-08-27' })], []);
  assert.match(two.reason, /정산 500 줄이 여러 주문일/);
  const one = C.slMatchLedger([frow({ amount: 4000, key: 4000 })], lmap(LR({ amount: 1000 }), LR({ amount: 3000 })),
    [O({ settle: 1000, barcode: '2608A1' }), O({ settle: 3000, barcode: '2608A2', date: '26-08-27' })], []);
  assert.match(one.reason, /한 주문의 줄이 여러 주문일/);
});

/* ---------------------------------------------------------------- T3 3차 검수 반영(§10.8) */
const CAFE = () => ad('cafe24-inicis-card');
const crow = (o) => Object.assign({ r: 1, orderNo: 'N1', ledgerNo: 'ORD00001', buyer: '고객C', phone: '', qty: null, key: 5000, amount: 5000, isReturn: false, name: '반지', option: '' }, o || {});

test('규칙1: 키가 있는데 조회가 실패하면 원장 연동 어댑터는 전부 차단(폴백 없음) · 키 없음(idx null)은 기존 폴백', () => {
  const FAILED = '원장 조회 실패 — 다시 시도하세요';
  const pc = C.slParseFile(CP);
  const gc = C.slGroupLedger(pc.rows, pc.adapter, null, { lookupFailed: true });
  assert.ok(gc.length > 0 && gc.every((x) => x.block === FAILED && x.pickable === false && x.ledger.size === 0));
  const gk = C.slGroupLedger([crow(), crow({ orderNo: 'N2', ledgerNo: 'ORD00002', buyer: '고객D' })], CAFE(), null, { lookupFailed: true });
  assert.equal(gk.length, 2);
  assert.ok(gk.every((x) => x.block === FAILED && x.pickable === false));
  const ga = C.slGroupLedger([crow({ buyer: '고객A', phone: '010-0000-1234' })], ad('amondz-settle'), null, { lookupFailed: true });
  assert.ok(ga.every((x) => x.block === FAILED));
  //  키 없음 = 기존 §10.8 폴백
  const g0 = C.slGroupLedger([crow()], CAFE(), null);
  assert.ok(g0.length === 1 && !g0[0].block && g0[0].key === '고객C/카');
  //  조회 성공 + 주문 없음 ≠ 조회 실패
  const gn = C.slGroupLedger([crow()], CAFE(), new Map());
  assert.ok(gn.length === 1 && !gn[0].block);
});

test('규칙1 배선: 조회 실패는 파일 세대 확인 뒤에만 S.ledgerFailed 로 반영 — fetchLedgerIndex 는 S 를 건드리지 않음', () => {
  const ui = read('src/saleimport.js');
  const i = ui.indexOf('async function fetchLedgerIndex'), fn = ui.slice(i, ui.indexOf('\n  }\n', i));
  assert.ok((fn.match(/failed: true/g) || []).length >= 2, '던짐·null 두 경로');
  assert.ok(!/S\.ledgerFailed|S\.notice/.test(fn), '조회 함수가 S 에 직접 쓰면 늦은 이전 파일 실패가 번진다');
  assert.ok(!/S\.adapter/.test(fn.slice(fn.indexOf('await'))), 'await 뒤에 S.adapter 를 읽으면 파일이 바뀐 사이 null');
  const l = ui.indexOf('async function loadFile'), lb = ui.slice(l, ui.indexOf('\n  }\n', l));
  const f0 = lb.indexOf('await fetchLedgerIndex()'), g0 = lb.indexOf('gen !== S.fileGen', f0);
  assert.ok(f0 > 0 && g0 > f0 && g0 < lb.indexOf('S.ledgerFailed = li.failed'), '세대 확인 뒤에 반영');
  assert.ok(/lookupFailed: S\.ledgerFailed/.test(ui));
  assert.ok(!/원장 없이 진행합니다/.test(fn), '실패했는데 원장 없이 진행한다고 안내하면 안 됨');
});

test('규칙2: 원장 번호 형식 오류는 조용히 빠지지 않고 차단(폴백 없음)', () => {
  const idx = C.slLedgerIndex([], '카페24');
  for (const bad of ['ab', 'bad no!', 'x'.repeat(41), '한글주문1234', '']) {
    const g = C.slGroupLedger([crow({ ledgerNo: bad })], CAFE(), idx);
    assert.equal(g.length, 1, bad);
    assert.equal(g[0].block, '원장 번호 형식 오류', bad);
    assert.equal(g[0].pickable, false);
  }
  const gc = C.slGroupLedger([crow({ ledgerNo: 'bad no!' })], ad('coupang-revenue'), C.slLedgerIndex([], '쿠팡'));
  assert.equal(gc[0].block, '원장 번호 형식 오류');
  assert.equal(C.slGroupLedger([crow()], CAFE(), idx)[0].block, '');
});

test('규칙3: 같은 고객의 서로 다른 두 원장 주문이 같은 정산액이면 차단(어느 줄인지 모름), 한 주문 안의 같은 금액은 허용', () => {
  const led = C.slLedgerIndex([LR({ order_no: 'AAAA0001', amount: 500 }), LR({ order_no: 'BBBB0002', amount: 500 })], '쿠팡');
  const m = C.slMatchLedger([frow({ ledgerNo: 'AAAA0001', orderNo: 'a', amount: 500, key: 500 }), frow({ ledgerNo: 'BBBB0002', orderNo: 'b', amount: 500, key: 500 })], led,
    [O({ settle: 500, barcode: '2608A1' }), O({ settle: 500, barcode: '2608A2' })], []);
  assert.equal(m.status, 'block');
  assert.match(m.reason, /같은 정산액 주문이 2건 — 어느 줄인지 모름/);
  const one = C.slMatchLedger([frow({ ledgerNo: 'AAAA0001', orderNo: 'a', amount: 1000, key: 1000 })], C.slLedgerIndex([LR({ order_no: 'AAAA0001', amount: 500 }), LR({ order_no: 'AAAA0001', amount: 500 })], '쿠팡'),
    [O({ settle: 500, barcode: '2608A1' }), O({ settle: 500, barcode: '2608A2' })], []);
  assert.equal(one.status, 'ok');
});

test('규칙4: 주문별 파일 합 F 와 원장 합 L 의 차이가 파일 행 수(원)를 넘으면 차단 · 1원 차이(실측 248,448/248,447)는 통과', () => {
  const orders = [O({ settle: 248447 })];
  const ok = C.slMatchLedger([frow({ amount: 248448, key: 248448 })], lmap(LR({ amount: 248447 })), orders, []);
  assert.equal(ok.status, 'ok');
  const bad = C.slMatchLedger([frow({ amount: 200000, key: 200000 })], lmap(LR({ amount: 248447 })), orders, []);
  assert.equal(bad.status, 'block');
  assert.match(bad.reason, /파일 금액 .*200,000.* ≠ 원장 .*248,447.* 주문 일부만 정산됐을 수 있음/);
  //  행 2개면 허용 오차 2원
  const two = [frow({ orderNo: 'n-1', amount: 124224, key: 124224 }), frow({ orderNo: 'n-2', amount: 124225, key: 124225 })];
  assert.equal(C.slMatchLedger(two, lmap(LR({ amount: 248447 })), orders, []).status, 'ok');
  assert.equal(C.slMatchLedger([frow({ orderNo: 'n-1', amount: 124222, key: 124222 }), frow({ orderNo: 'n-2', amount: 124222, key: 124222 })], lmap(LR({ amount: 248447 })), orders, []).status, 'block');
});

test('규칙5: 원장 줄 매칭(ledgerMatch)은 쿠팡·퀸잇만 — 카페24·SSG·아몬즈는 원장을 고객명에만 쓴다', () => {
  assert.equal(ad('coupang-revenue').ledgerMatch, true);
  assert.equal(ad('queenit-settle').ledgerMatch, true);
  ['gs', 'cafe24-inicis-card', 'ssg-settle', 'smartstore-daily', 'amondz-settle'].forEach((id) => assert.ok(!ad(id).ledgerMatch, id));
  assert.equal(ad('cafe24-inicis-card').matchMode, 'perOrder');
  assert.equal(ad('ssg-settle').matchMode, 'perUnit');
  assert.equal(ad('amondz-settle').matchMode, 'perUnit');
  const ui = read('src/saleimport.js');
  const i = ui.indexOf('async function matchEntry'), b = ui.slice(i, ui.indexOf('\n  }\n', i));
  assert.ok(/S\.adapter\.ledgerMatch/.test(b), 'matchEntry 가 ledgerMatch 로 갈림');
  assert.ok(!/S\.adapter\.matchMode === 'ledger'/.test(b));
  assert.ok(/C\.slMatchModeFor\(S\.adapter, viaLedger\(e\)\)/.test(b), '모드 결정은 코어 함수');
  assert.ok(/slMatchClient\(e\.rows, tr\.orders, tr\.sales, mode\)/.test(b), '그 외는 어댑터 고유 모드');
  const g = C.slGroupLedger([crow()], CAFE(), C.slLedgerIndex([LR({ order_no: 'ORD00001', market: '카페24', recipient: '고객C', phone: '010-0000-7777', amount: 5000 })], '카페24'));
  assert.equal(g[0].key, '고객C7777/카');
  assert.equal(g[0].source, '원장');
});

test('규칙6: 같은 구매자의 결제 일부만 원장에서 확인되면 그 구매자의 묶음을 전부(원장 묶음 포함) 차단 · 다른 구매자는 영향 없음', () => {
  const R = '같은 구매자의 결제 일부만 원장에서 확인됨 — 직접 처리';
  const idx = C.slLedgerIndex([LR({ order_no: 'ORD00001', market: '카페24', recipient: '고객C', phone: '010-0000-7777', amount: 5000 })], '카페24');
  //  P1(원장) · P2(원장 없음) — 같은 구매자·같은 날·같은 상품 한 줄·같은 지급액 5,000
  const g = C.slGroupLedger([crow(), crow({ orderNo: 'N2', ledgerNo: 'ORD00002' }), crow({ orderNo: 'N3', ledgerNo: 'ORD00003', buyer: '고객Z' })], CAFE(), idx);
  const fb = g.find((x) => x.key === '고객C/카'), lg = g.find((x) => x.key === '고객C7777/카');
  assert.ok(fb && lg);
  assert.equal(fb.block, R);
  assert.equal(fb.pickable, false);
  assert.equal(lg.block, R, '원장 묶음도 차단');
  assert.equal(lg.pickable, false);
  assert.equal(g.find((x) => x.key === '고객Z/카').block, '');
  //  전부 원장이면(폴백 없음) 차단 없음
  assert.equal(C.slGroupLedger([crow()], CAFE(), idx)[0].block, '');
});

test('규칙6: 구매자 이름이 띄어쓰기·대소문자만 달라도 같은 구매자로 보고 전부 차단 (Opus 5R Nit-1)', () => {
  const R = '같은 구매자의 결제 일부만 원장에서 확인됨 — 직접 처리';
  const idx = C.slLedgerIndex([LR({ order_no: 'ORD00001', market: '카페24', recipient: '고객C', phone: '010-0000-7777', amount: 5000 })], '카페24');
  [['고객C', '고객 C'], ['Kim', 'KIM']].forEach(([b1, b2]) => {
    const g = C.slGroupLedger([crow({ buyer: b1 }), crow({ orderNo: 'N2', ledgerNo: 'ORD00002', buyer: b2 })], CAFE(), idx);
    assert.ok(g.length >= 2, b1 + '/' + b2);
    g.forEach((x) => assert.equal(x.block, R, b1 + '/' + b2 + ' → ' + x.key));
  });
});

test('규칙6: 원장 고객이 차단(수령자 불일치)돼도 같은 구매자의 이름 묶음은 차단 (Opus 5R Nit-2)', () => {
  const idx = C.slLedgerIndex([
    LR({ order_no: 'ORD00001', market: '카페24', recipient: '고객C', phone: '010-0000-7777', amount: 5000 }),
    LR({ order_no: 'ORD00001', market: '카페24', recipient: '고객C', phone: '010-0000-8888', amount: 5000 }),
  ], '카페24');
  const g = C.slGroupLedger([crow(), crow({ orderNo: 'N2', ledgerNo: 'ORD00002' })], CAFE(), idx);
  const fb = g.find((x) => x.key === '고객C/카');
  assert.ok(fb, '이름 묶음 존재');
  assert.equal(fb.block, '같은 구매자의 결제 일부만 원장에서 확인됨 — 직접 처리');
});

test('slMatchModeFor: 원장 줄 매칭 어댑터(쿠팡·퀸잇)만 원장 묶음에서 ledger, 그 밖은 자기 모드', () => {
  ['coupang-revenue', 'queenit-settle'].forEach((id) => assert.equal(C.slMatchModeFor(ad(id), true), 'ledger', id));
  [['cafe24-inicis-card', 'perOrder'], ['ssg-settle', 'perUnit'], ['amondz-settle', 'perUnit'], ['gs', 'perUnit']].forEach(([id, m]) => assert.equal(C.slMatchModeFor(ad(id), true), m, id));
  ['gs', 'smartstore-daily', 'cafe24-inicis-card', 'ssg-settle', 'amondz-settle'].forEach((id) => assert.equal(C.slMatchModeFor(ad(id), false), ad(id).matchMode, id));
});

test('넛 a: ledgerLookup 의 타임아웃은 응답 본문을 다 읽은 뒤에 해제한다(본문 읽기 중 멈춤도 timeout)', { timeout: 5000 }, async () => {
  const E = loadErp();
  const events = [];
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout, prev = globalThis.fetch;
  let abortTimer = null;
  globalThis.setTimeout = (fn, ms, ...a) => { const t = realSet(fn, ms >= 1000 ? 5 : ms, ...a); if (ms >= 1000) abortTimer = t; return t; };
  globalThis.clearTimeout = (t) => { if (t === abortTimer) events.push('clear'); return realClear(t); };
  try {
    globalThis.fetch = fakeFetch((n, u, init) => ({ ok: true, status: 200, json: () => new Promise((res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))) }));
    await assert.rejects(() => E.ledgerLookup(['ORD1234'], KEY), /ledger_lookup_timeout/);
    events.length = 0;
    globalThis.fetch = fakeFetch(() => ({ ok: true, status: 200, json: async () => { events.push('json'); return { rows: [] }; } }));
    await E.ledgerLookup(['ORD1234'], KEY);
    assert.deepEqual(events, ['json', 'clear']);
  } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; globalThis.fetch = prev; }
});

test('넛 b: 원장 전용 어댑터(쿠팡·퀸잇)에서 원장에 없는 주문은 검색창 없는 차단', () => {
  for (const [rows, id, mk] of [[CP, 'coupang-revenue', '쿠팡'], [QN, 'queenit-settle', '퀸잇']]) {
    const p = C.slParseFile(rows);
    const g = C.slGroupLedger(p.rows, p.adapter, C.slLedgerIndex([], mk));
    assert.ok(g.length > 0 && g.every((x) => x.block === '원장에 없는 주문 — 직접 처리하세요' && x.pickable === false), id);
  }
});

test('넛 c: 원장 고객명과 ERP 검색 결과는 접미 대소문자를 무시하고 비교(SSG /s·/S), 접두는 정확일치', () => {
  const grp = { key: '고객C7777/s', buyer: '고객C' };
  const ci = { clientRule: 'exact', suffix: 's', ciSuffix: true };
  const hits = [{ seq: 1, name: '고객C7777/S' }, { seq: 2, name: '고객C7778/s' }, { seq: 3, name: '고객c7777/s' }];
  assert.deepEqual(C.slClientCandidates(hits, grp, ci).map((h) => h.seq), [1]);
  assert.deepEqual(C.slClientCandidates([{ seq: 1, name: '고객C7777/S' }], grp, { clientRule: 'exact', suffix: 's' }).map((h) => h.seq), []);
  assert.ok(/ciSuffix: true/.test(read('src/saleimport.js')));
});
