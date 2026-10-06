/* saleimport 아몬즈(§10.8) 테스트 — 원장 줄 매칭(ledgerMatch) + 행 수 대조 + 결제 금액 범위 대조.
 * 금액은 실측 사례의 숫자만 쓰고 이름·연락처는 가명(고객A…, 010-0000-xxxx)이다. 네트워크·브라우저 없음.
 * 실행: node --test tests/saleimport-amondz.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'src', 'saleimport-core.js'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const HEAD = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'saleimport', 'rows-amondz.json'), 'utf8'))[0];
const ad = C.SL_ADAPTERS.find((a) => a.id === 'amondz-settle');
const RANGE = '원장 금액이 결제 금액과 맞지 않음 — 직접 처리';

//  파일 한 행 — 주문번호(ledgerNo)·정산금액 F·판매금액 S·총 결제 금액·쿠폰 분담액(amondz).
function frow(o) {
  const v = Object.assign({ '주문번호': 'AM-A', '상품주문번호': 'AM-A-1', '구분': '상품 구매', '상품명': '팔찌', '수취인명': '고객A', '수취인 연락처': '010-0000-1234',
    '판매금액': '25,650', '총 결제 금액': '13,338', '쿠폰 분담액(amondz)': '6,156', '정산금액': '12,255' }, o || {});
  return HEAD.map((h) => (v[h] == null ? '' : v[h]));
}
const file = (...rows) => [HEAD].concat(rows);
const parsed = (...rows) => { const p = C.slParseFile(file(...rows)); assert.equal(p.ok, true, p.error); return p.rows; };
const LR = (o) => Object.assign({ order_no: 'AM-A', market: '아몬즈', recipient: '고객A', phone: '010-0000-1234', product: 'x', opt: '', amount: 18409, is_gift: false, status: '정상', order_date: '2026-09-20' }, o || {});
const lmap = (...rows) => C.slLedgerIndex(rows, '아몬즈');
const O = (o) => Object.assign({ date: '26-09-20', barcode: '2609A1', code: 'F-BF-Z-WG-ZZ-0001', name: '팔찌', gift: false, settle: 18409, qty: 1, price: 40000, cancel: false }, o || {});
const OPTS = { amountCheck: 'count', payRange: true };

/* ---------------------------------------------------------------- 어댑터·파싱 */
test('어댑터: 원장 줄 매칭 + 행 수 대조 + 결제 금액 범위 대조 + 원장에서만 고객(없으면 차단)', () => {
  assert.deepEqual([ad.clientRule, ad.matchMode, ad.ledgerMatch, ad.ledgerAmountCheck, ad.ledgerPayRange, ad.ledgerMarket, ad.suffix], ['ledger', 'ledger', true, 'count', true, '아몬즈', '아']);
  assert.equal(C.slMatchModeFor(ad, true), 'ledger');
  assert.equal(C.SL_ADAPTERS.filter((a) => a.ledgerPayRange).map((a) => a.id).join(), 'amondz-settle');
});

test('파싱: payTotal = 총 결제 금액 + 쿠폰 분담액(amondz), grossSale = 판매금액, 상품 행에서 읽을 수 없으면 파일 거부, 배송비 행의 #NUM! 은 봐준다', () => {
  const rows = parsed(frow());
  assert.equal(rows[0].amount, 12255); assert.equal(rows[0].payTotal, 13338 + 6156); assert.equal(rows[0].grossSale, 25650); assert.equal(rows[0].ledgerNo, 'AM-A');
  assert.equal(C.slParseFile(file(frow({ '판매금액': '' }))).ok, false);
  assert.equal(C.slParseFile(file(frow({ '판매금액': '#NUM!' }))).ok, false);
  const h4 = HEAD.map((h) => (h === '판매금액' ? 'x' : h));
  assert.equal(C.slParseFile([h4, frow()]).ok, false);
  assert.equal(C.slParseFile(file(frow({ '쿠폰 분담액(amondz)': '#NUM!' }))).ok, false);
  assert.equal(C.slParseFile(file(frow({ '총 결제 금액': '' }))).ok, false);
  assert.equal(C.slParseFile(file(frow({ '총 결제 금액': 'abc' }))).ok, false);
  const ship = C.slParseFile(file(frow(), frow({ '상품주문번호': 'AM-A-S', '구분': '추가 배송비', '상품명': '-', '쿠폰 분담액(amondz)': '#NUM!', '정산금액': '2,453' })));
  assert.equal(ship.ok, true);
  assert.equal(ship.rows.filter((r) => r.isReturn).length, 1);
  //  열이 아예 없으면 파일 거부
  const h2 = HEAD.map((h) => (h === '총 결제 금액' ? 'x' : h));
  assert.equal(C.slParseFile([h2, frow()]).ok, false);
  const h3 = HEAD.map((h) => (h === '쿠폰 분담액(amondz)' ? 'x' : h));
  assert.equal(C.slParseFile([h3, frow()]).ok, false);
});

/* ---------------------------------------------------------------- 실측 4건 */
test('주문 A: 파일 12,255 / 원장·비고 18,409 — 정산액 줄을 원장 금액으로 찾고 실판매가는 파일 12,255', () => {
  const m = C.slMatchLedger(parsed(frow()), lmap(LR()), [O()], [], OPTS);
  assert.equal(m.status, 'ok', m.reason);
  assert.equal(m.cash, 12255);
  assert.deepEqual(m.lines.map((l) => [l.barcode, l.amount]), [['2609A1', 12255]]);
});

test('주문 B: 파일 [67,620 + 21,785], 원장 [101,590, 32,727, 0(사은품)] — 합 89,405 를 원장 비율로 배분', () => {
  const rows = parsed(
    frow({ '주문번호': 'AM-B', '상품주문번호': 'AM-B-1', '정산금액': '67,620', '판매금액': '140,000', '총 결제 금액': '70,000', '쿠폰 분담액(amondz)': '60,000' }),
    frow({ '주문번호': 'AM-B', '상품주문번호': 'AM-B-2', '정산금액': '21,785', '판매금액': '45,000', '총 결제 금액': '25,000', '쿠폰 분담액(amondz)': '10,000' }));
  const led = lmap(LR({ order_no: 'AM-B', amount: 101590 }), LR({ order_no: 'AM-B', amount: 32727 }), LR({ order_no: 'AM-B', amount: 0, is_gift: true }));
  const orders = [O({ barcode: '2609B1', settle: 101590 }), O({ barcode: '2609B2', settle: 32727 }), O({ barcode: '2609G1', gift: true, settle: 0, name: '(사은품)' })];
  const m = C.slMatchLedger(rows, led, orders, [], OPTS);
  assert.equal(m.status, 'ok', m.reason);
  assert.equal(m.cash, 89405);
  const by = new Map(m.lines.filter((l) => !l.gift).map((l) => [l.barcode, l.amount]));
  assert.deepEqual(C.slAllocateByWeight(89405, [101590, 32727]), [by.get('2609B1'), by.get('2609B2')]);
  assert.ok(by.get('2609B1') > by.get('2609B2'));
  assert.equal(m.lines.find((l) => l.gift).amount, 0);
});

test('주문 C: 판매금액 39,600 · 파일 33,851 · 원장 6,938(비율 0.175, 수량 4 에 원장 1줄로 추정) → 하한(0.65×판매금액) 미달로 차단', () => {
  const rows = parsed(frow({ '주문번호': 'AM-C', '정산금액': '33,851', '판매금액': '39,600', '총 결제 금액': '40,000', '쿠폰 분담액(amondz)': '0' }));
  const m = C.slMatchLedger(rows, lmap(LR({ order_no: 'AM-C', amount: 6938 })), [O({ settle: 6938 })], [], OPTS);
  assert.equal(m.status, 'block');
  assert.match(m.reason, new RegExp(RANGE));
});

test('주문 D: 파일 1행 vs 원장 본품 2행 → 행 수 차단', () => {
  const rows = parsed(frow({ '주문번호': 'AM-D', '정산금액': '9,077', '총 결제 금액': '30,000', '쿠폰 분담액(amondz)': '0' }));
  const led = lmap(LR({ order_no: 'AM-D', amount: 13636 }), LR({ order_no: 'AM-D', amount: 12087 }));
  const m = C.slMatchLedger(rows, led, [O({ settle: 13636 }), O({ barcode: '2609A2', settle: 12087 })], [], OPTS);
  assert.equal(m.status, 'block');
  assert.match(m.reason, /파일 상품 수 ≠ 원장 상품 수/);
});

test('범위 경계: 상한 Σ(결제+쿠폰) 는 포함, 1원 넘으면 차단 · payTotal 이 숫자가 아니면 차단', () => {
  const rows = parsed(frow());   // S 25,650 · hi 19,494 (하한 0.65×25,650 = 16,672.5 → 16,673)
  const run = (L, rs) => C.slMatchLedger(rs || rows, lmap(LR({ amount: L })), [O({ settle: L })], [], OPTS);
  assert.equal(run(19494).status, 'ok');
  assert.equal(run(18409).status, 'ok');
  assert.equal(run(19495).status, 'block');
  assert.match(run(19495).reason, new RegExp(RANGE));
  assert.match(run(18409, [Object.assign({}, rows[0], { payTotal: undefined })]).reason, new RegExp(RANGE));
  assert.match(run(18409, [Object.assign({}, rows[0], { grossSale: undefined })]).reason, new RegExp(RANGE));
  //  판매금액 0·음수면 하한이 무력해진다 — 차단(Opus R2 Nit 2)
  assert.match(run(1, [Object.assign({}, rows[0], { grossSale: 0 })]).reason, new RegExp(RANGE));
  assert.match(run(1, [Object.assign({}, rows[0], { grossSale: -25650 })]).reason, new RegExp(RANGE));
});

test('하한: 쿠폰 없는 9,900원 주문(F 8,464 · L 6,938)은 통과 — 파일 정산금보다 L 이 낮은 정상 주문', () => {
  const rows = parsed(frow({ '주문번호': 'AM-E', '판매금액': '9,900', '총 결제 금액': '9,900', '쿠폰 분담액(amondz)': '0', '정산금액': '8,464' }));
  const m = C.slMatchLedger(rows, lmap(LR({ order_no: 'AM-E', amount: 6938 })), [O({ settle: 6938 })], [], OPTS);
  assert.equal(m.status, 'ok', m.reason);
  assert.equal(m.cash, 8464);
});

test('하한 경계: L = 0.65×판매금액 정확히는 통과, 1원 아래는 차단 (정수 비교)', () => {
  const rows = parsed(frow({ '판매금액': '20,000', '총 결제 금액': '20,000', '쿠폰 분담액(amondz)': '0', '정산금액': '17,000' }));
  const run = (L) => C.slMatchLedger(rows, lmap(LR({ amount: L })), [O({ settle: L })], [], OPTS);
  assert.equal(C.SL_AMONDZ_MIN_RATIO_PCT, 65);
  assert.equal(run(13000).status, 'ok');
  assert.equal(run(12999).status, 'block');
  assert.match(run(12999).reason, new RegExp(RANGE));
});

test('범위 옵션이 없으면 범위 검사를 하지 않는다 — 쿠팡·퀸잇·에이블리는 그대로', () => {
  const rows = parsed(frow({ '주문번호': 'AM-C', '정산금액': '33,851', '총 결제 금액': '40,000', '쿠폰 분담액(amondz)': '0' }));
  const m = C.slMatchLedger(rows, lmap(LR({ order_no: 'AM-C', amount: 6938 })), [O({ settle: 6938 })], [], { amountCheck: 'count' });
  assert.equal(m.status, 'ok');
});

/* ---------------------------------------------------------------- 원장 없음 · 배선 */
test('원장에 없는 주문은 차단(파일 금액 폴백 없음) · 조회 실패도 차단', () => {
  const rows = parsed(frow());
  const g = C.slGroupLedger(rows, ad, lmap(LR({ order_no: 'OTHER' })), {});
  assert.equal(g.length, 1);
  assert.match(g[0].block, /원장에 없는 주문/);
  const g0 = C.slGroupLedger(rows, ad, null);
  assert.match(g0[0].block, /원장에 없는 주문/);
  const gf = C.slGroupLedger(rows, ad, null, { lookupFailed: true });
  assert.equal(gf[0].block, '원장 조회 실패 — 다시 시도하세요');
  const ok = C.slGroupLedger(rows, ad, lmap(LR()), {});
  assert.equal(ok[0].key, '고객A1234/아');
  assert.ok(!ok[0].block);
});

test('패널 배선: matchEntry 가 어댑터의 ledgerPayRange 를 slMatchLedger 로 넘긴다', () => {
  assert.ok(/amountCheck: S\.adapter\.ledgerAmountCheck, payRange: !!S\.adapter\.ledgerPayRange/.test(read('src/saleimport.js')));
});
