/* saleimport §10.8 4.3.7 — 주문 줄 비고가 없거나 달라 막힌 고객이 이미 판매된 경우(판매내역 실판매가 대조). 이름·연락처는 가명, 네트워크 없음.
 * 실행: node --test tests/saleimport-soldbyprice.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'src', 'saleimport-core.js'));
const HEAD = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'saleimport', 'rows-amondz.json'), 'utf8'))[0];
const OPTS = { amountCheck: 'count', payRange: true };

function frow(o) {
  const v = Object.assign({ '주문번호': 'AM-X', '상품주문번호': 'AM-X-1', '구분': '상품 구매', '상품명': '팔찌', '수취인명': '고객X', '수취인 연락처': '010-0000-1111',
    '판매금액': '10,000', '총 결제 금액': '9,000', '쿠폰 분담액(amondz)': '1,000', '정산금액': '8,464' }, o || {});
  return HEAD.map((h) => (v[h] == null ? '' : v[h]));
}
const parsed = (...rows) => { const p = C.slParseFile([HEAD].concat(rows)); assert.equal(p.ok, true, p.error); return p.rows; };
const LR = (o) => Object.assign({ order_no: 'AM-X', market: '아몬즈', recipient: '고객X', phone: '010-0000-1111', product: 'x', opt: '', amount: 8464, is_gift: false, status: '정상', order_date: '2026-08-20' }, o || {});
const lmap = (...rows) => C.slLedgerIndex(rows, '아몬즈');
const O = (o) => Object.assign({ date: '26-08-20', barcode: 'B00001', code: 'F-BF-Z-WG-ZZ-0001', name: '팔찌', gift: false, settle: null, qty: 1, price: 20000, cancel: false }, o || {});
const S = (amount, o) => Object.assign({ date: '26-10-02', barcode: 'B00001', code: 'F-BF-Z-WG-ZZ-0001', price: 20000, qty: 1, dc: 0, amount }, o || {});
const HINT = '이미 판매된 것으로 보임 — 실판매가 일치(26-10-02) · 직접 확인';

test('고객 X: 비고 없는 주문 줄 + 10-02 판매 8,464 → sold', () => {
  const m = C.slMatchLedger(parsed(frow()), lmap(LR()), [O()], [S(8464)], OPTS);
  assert.equal(m.status, 'sold', m.reason);
  assert.equal(m.reason, HINT);
  assert.deepEqual(m.lines, []);
});

test('고객 Y: 주문 줄 3개(비고는 하나) + 판매 3줄 37,383 / 8,316 / 9,784 → sold', () => {
  const rows = parsed(
    frow({ '주문번호': 'AM-Y', '상품주문번호': 'AM-Y-1', '정산금액': '37,383', '판매금액': '80,000', '총 결제 금액': '40,000', '쿠폰 분담액(amondz)': '5,000' }),
    frow({ '주문번호': 'AM-Y', '상품주문번호': 'AM-Y-2', '정산금액': '8,316' }),
    frow({ '주문번호': 'AM-Y', '상품주문번호': 'AM-Y-3', '정산금액': '9,784' }));
  const led = lmap(LR({ order_no: 'AM-Y', amount: 13583 }), LR({ order_no: 'AM-Y', amount: 9000 }), LR({ order_no: 'AM-Y', amount: 9500 }));
  const orders = [O({ barcode: 'Y00001', settle: 13583 }), O({ barcode: 'Y00002' }), O({ barcode: 'Y00003' })];
  const sales = [S(37383, { barcode: 'Y00001' }), S(8316, { barcode: 'Y00002' }), S(9784, { barcode: 'Y00003' })];
  const m = C.slMatchLedger(rows, led, orders, sales, { amountCheck: 'count' });
  assert.equal(m.status, 'sold', m.reason);
});

test('고객 Z: 두 원장 주문(정산 13,682 비고 + 비고 없음) · 판매 8,008 / 9,077 → sold', () => {
  const rows = parsed(
    frow({ '주문번호': 'AM-Z1', '상품주문번호': 'AM-Z1-1', '정산금액': '8,008' }),
    frow({ '주문번호': 'AM-Z2', '상품주문번호': 'AM-Z2-1', '정산금액': '9,077' }));
  const led = lmap(LR({ order_no: 'AM-Z1', amount: 13636 }), LR({ order_no: 'AM-Z2', amount: 9100 }));
  const orders = [O({ barcode: 'Z00001', settle: 13682 }), O({ barcode: 'Z00002' }), O({ barcode: 'Z00003' })];
  const sales = [S(8008, { barcode: 'Z00002' }), S(9077, { barcode: 'Z00003' })];
  const m = C.slMatchLedger(rows, led, orders, sales, { amountCheck: 'count' });
  assert.equal(m.status, 'sold', m.reason);
});

test('음성: 실판매가가 1원 다르면 그대로 차단', () => {
  const m = C.slMatchLedger(parsed(frow()), lmap(LR()), [O()], [S(8465)], OPTS);
  assert.equal(m.status, 'block');
  assert.match(m.reason, /주문 줄 0개 \(필요 1개\)/);
  assert.doesNotMatch(m.reason, /이미 판매된/);
});

test('음성: 판매일이 원장 주문일보다 앞이면 차단', () => {
  const m = C.slMatchLedger(parsed(frow()), lmap(LR({ order_date: '2026-10-03' })), [O()], [S(8464)], OPTS);
  assert.equal(m.status, 'block');
  assert.doesNotMatch(m.reason, /이미 판매된/);
});

test('음성: 파일 두 행인데 판매 줄은 하나 → 차단 + 일부 판매 힌트', () => {
  const rows = parsed(frow(), frow({ '상품주문번호': 'AM-X-2', '정산금액': '9,000' }));
  const led = lmap(LR(), LR({ amount: 9100 }));
  const m = C.slMatchLedger(rows, led, [O(), O({ barcode: 'B00002' })], [S(8464)], OPTS);
  assert.equal(m.status, 'block');
  assert.match(m.reason, /주문 줄 0개/);
  assert.match(m.reason, / · 일부는 이미 판매된 것으로 보임$/);
});

test('음성: 같은 금액 두 행에 판매 줄 하나는 1:1 이라 재사용 불가 → 차단', () => {
  const rows = parsed(frow(), frow({ '상품주문번호': 'AM-X-2' }));
  const led = lmap(LR(), LR());
  const m = C.slMatchLedger(rows, led, [O(), O({ barcode: 'B00002' })], [S(8464)], OPTS);
  assert.equal(m.status, 'block');
});

test('다른 고객이 이미 쓴 판매 줄은 opts.usedSales 로 재사용하지 않는다', () => {
  const used = new Set();
  const sale = S(8464);
  const a = C.slMatchLedger(parsed(frow()), lmap(LR()), [O()], [sale], Object.assign({ usedSales: used }, OPTS));
  const b = C.slMatchLedger(parsed(frow()), lmap(LR()), [O()], [sale], Object.assign({ usedSales: used }, OPTS));
  assert.equal(a.status, 'sold');
  assert.equal(b.status, 'block');
});

test('절대 ok 로 만들지 않는다 — 주문 줄이 정상으로 있으면 기존대로 ok', () => {
  const m = C.slMatchLedger(parsed(frow()), lmap(LR()), [O({ settle: 8464 })], [S(8464, { barcode: 'OTHER1' })], OPTS);
  assert.equal(m.status, 'ok', m.reason);
});

/* ---------------------------------------------------------------- 검수 1R 반영 (F1~F5) */
const ordersOld = (extra) => [O({ barcode: '26BBBB', settle: 8500, date: '26-08-01' })].concat(extra || []);
const rd = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

test('F1: 가격 대조로 얻은 sold 는 inferred 표시와 쓴 판매 줄 열쇠를 돌려준다', () => {
  const m = C.slMatchLedger(parsed(frow()), lmap(LR()), [O()], [S(8464)], OPTS);
  assert.equal(m.status, 'sold');
  assert.equal(m.inferred, true);
  assert.equal(m.usedKeys.length, 1);
  const ok = C.slMatchLedger(parsed(frow()), lmap(LR()), [O({ settle: 8464 })], [{ barcode: 'B00001' }], OPTS);   // 바코드로 확인된 판매는 inferred 가 아니다
  assert.equal(ok.status, 'sold'); assert.equal(ok.inferred, undefined);
});

test('F1: 패널 — 추정 판매는 경고 칩 \'판매 추정 — 직접 확인\' + 사유, 따로 센다, 로그 JSON 에 사유', () => {
  const src = rd('src/saleimport.js');
  assert.match(src, /const inferredSold = \(e\) => e\.st === 'sold' && !!\(e\.match && e\.match\.inferred\)/);
  assert.match(src, /if \(inferredSold\(e\)\) return chip\('skipped', '판매 추정 — 직접 확인', 'warn'\) \+ '<div class="sl-opt">' \+ esc\(e\.reason\)/);
  assert.ok(src.indexOf("if (inferredSold(e)) return chip") < src.indexOf("if (e.st === 'sold') return chip('gray', '이미 판매됨')"));
  assert.match(src, /nSold = E_\.filter\(\(e\) => e\.st === 'sold' && !inferredSold\(e\)\)\.length, nInf = E_\.filter\(inferredSold\)\.length/);
  assert.match(src, /판매 추정 <b>' \+ c\.nInf/);
  assert.match(src, /inferredSold: S\.entries\.filter\(inferredSold\)\.map\(\(e\) => \(\{ key: e\.key, client: e\.client, reason: e\.reason/);
});

test('F2.3 P1: 옛 주문(다른 정산 비고)의 판매 줄이 우연히 같은 금액이어도 짝으로 치지 않는다', () => {
  const m = C.slMatchLedger(parsed(frow()), lmap(LR()), ordersOld([O({ barcode: 'B00001', settle: null })]), [S(8464, { barcode: '26BBBB', date: '26-09-05' })], OPTS);
  assert.equal(m.status, 'block'); assert.doesNotMatch(m.reason, /이미 판매된/);
});

test('F2.3: 판매 줄 바코드가 이 고객의 주문일 이후 주문 줄이 아니면 짝으로 치지 않는다', () => {
  const m = C.slMatchLedger(parsed(frow()), lmap(LR()), [O()], [S(8464, { barcode: '26ZZZZ' })], OPTS);
  assert.equal(m.status, 'block');
});

test('F2.1 P3: 비고가 맞는 안 팔린 바코드 줄이 필요 개수보다 많으면 우연한 금액 일치로 바꾸지 않는다', () => {
  const m = C.slMatchLedger(parsed(frow()), lmap(LR({ amount: 9100 })), [O({ barcode: 'B00001', settle: 9100 }), O({ barcode: 'B00002', settle: 9100, date: '26-08-22' }), O({ barcode: 'B00003' })], [S(8464, { barcode: 'B00003' })], OPTS);
  assert.equal(m.status, 'block'); assert.doesNotMatch(m.reason, /이미 판매된/);
});

test('F2.1 P4: 바코드 달린 안 팔린 비고 줄이 여러 주문일에 걸치면 막는다', () => {
  const rows = parsed(frow(), frow({ '상품주문번호': 'AM-X-2', '정산금액': '8,465' }));
  const m = C.slMatchLedger(rows, lmap(LR({ amount: 9100 }), LR({ amount: 9100 })),
    [O({ barcode: 'B00001', settle: 9100 }), O({ barcode: 'B00002', settle: 9100, date: '26-08-21' }), O({ barcode: 'B00003' }), O({ barcode: 'B00004' })], [S(8464, { barcode: 'B00003' }), S(8465, { barcode: 'B00004' })], OPTS);
  assert.equal(m.status, 'block'); assert.doesNotMatch(m.reason, /이미 판매된/);
});

test('F2.2 P5: 취소 표시는 순서와 상관없이 판매 추정보다 먼저 막는다', () => {
  const mk = (a, b) => parsed(frow({ '주문번호': a, '상품주문번호': a + '-1', '정산금액': a === 'AM-Z1' ? '8,008' : '9,077' }), frow({ '주문번호': b, '상품주문번호': b + '-1', '정산금액': b === 'AM-Z1' ? '8,008' : '9,077' }));
  const led = lmap(LR({ order_no: 'AM-Z1', amount: 9000 }), LR({ order_no: 'AM-Z2', amount: 9050 }));
  const orders = [O({ barcode: 'B00009', settle: 9050, cancel: true }), O({ barcode: 'B00001' }), O({ barcode: 'B00002' })];
  const sales = [S(8008, { barcode: 'B00001' }), S(9077, { barcode: 'B00002' })];
  [mk('AM-Z1', 'AM-Z2'), mk('AM-Z2', 'AM-Z1')].forEach((rows) => {
    const m = C.slMatchLedger(rows, led, orders, sales, { amountCheck: 'count' });
    assert.equal(m.status, 'block'); assert.match(m.reason, /취소 표시/);
  });
});

test('F2.4 P9: 한 주문이 비고로 그대로 처리 가능하면 항목 전체를 판매 추정으로 바꾸지 않는다', () => {
  const rows = parsed(frow({ '주문번호': 'AM-P', '상품주문번호': 'AM-P-1', '정산금액': '8,464' }), frow({ '주문번호': 'AM-Q', '상품주문번호': 'AM-Q-1', '정산금액': '9,077' }));
  const led = lmap(LR({ order_no: 'AM-P', amount: 9100 }), LR({ order_no: 'AM-Q', amount: 9050 }));
  const m = C.slMatchLedger(rows, led, [O({ barcode: 'B00001', settle: 9100 }), O({ barcode: 'B00002' })], [S(9077, { barcode: 'B00002' })], { amountCheck: 'count' });
  assert.equal(m.status, 'block'); assert.doesNotMatch(m.reason, /이미 판매된/);
});

test('F3 P2: 원장 주문일이 없으면 추정하지 않는다', () => {
  const m = C.slMatchLedger(parsed(frow()), lmap(LR({ order_date: '' })), [O()], [S(8464)], OPTS);
  assert.equal(m.status, 'block'); assert.doesNotMatch(m.reason, /이미 판매된/);
});

test('F4: usedSales 는 판매 줄 열쇠(바코드·날짜·금액·상품)로 센다 — 거래내역을 새로 읽어 객체가 달라도 재사용 불가', () => {
  const used = new Set();
  const a = C.slMatchLedger(parsed(frow()), lmap(LR()), [O()], [S(8464)], Object.assign({ usedSales: used }, OPTS));
  const b = C.slMatchLedger(parsed(frow()), lmap(LR()), [O()], [S(8464)], Object.assign({ usedSales: used }, OPTS));   // 다른 객체
  assert.equal(a.status, 'sold'); assert.equal(b.status, 'block');
});

test('F4: 패널 — 읽기 실행마다 Set 하나, 점검(probe)은 소비하지 않고, 같은 항목을 다시 읽으면 먼저 돌려준다', () => {
  const src = rd('src/saleimport.js');
  assert.match(src, /S\.usedSales = new Set\(\);\r?\n\s*const targets/);
  assert.match(src, /if \(!probe\) \{ if \(!S\.usedSales\) S\.usedSales = new Set\(\); \(\(e\.match && e\.match\.usedKeys\) \|\| \[\]\)\.forEach\(\(k\) => S\.usedSales\.delete\(k\)\); \}/);
});

test('F5: slSaleRows — 판매직원 칸이 비어도 실판매가가 밀리지 않는다 (열 이름으로 읽음)', () => {
  const head = '<tr class="title_line"><td>No</td><td>판매일</td><td>이미지</td><td>바코드 / 상품번호</td><td>구분</td><td>상품정보 / 판매비고</td><td>판매가</td><td>수량</td><td>DC금액<br>(DC율)</td><td>실판매가</td><td>판매직원<br>(연결번호)</td></tr>';
  const row = (staff) => '<tr><td>1</td><td>26-10-02</td><td><table><tr><td><img></td></tr></table></td><td><span>240CKK</span><br>F-BF-Z-XX-ZZ-002Q</td><td>일반</td><td>팔찌</td><td>20,000</td><td>1</td><td>11,536<br>(57.68 %)</td><td>8,464</td><td>' + staff + '</td></tr>';
  const html = (staff) => '<table class="t_list">' + head + row(staff) + '</table>';
  const a = C.slSaleRows(html('홍길동'))[0], b = C.slSaleRows(html(''))[0];
  assert.deepEqual([a.barcode, a.price, a.qty, a.dc, a.amount], ['240CKK', 20000, 1, 11536, 8464]);
  assert.deepEqual([b.barcode, b.price, b.qty, b.dc, b.amount], ['240CKK', 20000, 1, 11536, 8464]);
  //  셀 수가 헤더와 다르면 값을 추측하지 않는다
  const short = C.slSaleRows('<table class="t_list">' + head + row('x').replace('<td>일반</td>', '') + '</table>')[0];
  assert.equal(short.amount, undefined);
});

test('F2.3 P1b: 주문일 이후여도 다른 정산액 비고가 달린 주문 줄의 판매 줄은 짝으로 치지 않는다', () => {
  const m = C.slMatchLedger(parsed(frow()), lmap(LR()), [O({ barcode: 'B00007', settle: 8500, date: '26-08-25' }), O({ barcode: 'B00001', settle: null })], [S(8464, { barcode: 'B00007', date: '26-09-05' })], OPTS);
  assert.equal(m.status, 'block'); assert.doesNotMatch(m.reason, /이미 판매된/);
});
