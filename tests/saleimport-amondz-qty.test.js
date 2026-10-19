/* saleimport 아몬즈 수량 주문(§10.8 4.3.7) — 원장에는 단가 한 줄뿐인데 유비샵 주문 줄은 수량만큼 여러 개. 이름·연락처는 가명, 네트워크 없음.
 * 실행: node --test tests/saleimport-amondz-qty.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'src', 'saleimport-core.js'));
const HEAD = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'saleimport', 'rows-amondz.json'), 'utf8'))[0];
const OPTS = { amountCheck: 'count', payRange: true };
const RANGE = '원장 금액이 결제 금액과 맞지 않음 — 직접 처리';

function frow(o) {
  const v = Object.assign({ '주문번호': 'AM-Q', '상품주문번호': 'AM-Q-1', '구분': '상품 구매', '상품명': '팔찌', '수취인명': '고객Q', '수취인 연락처': '010-0000-2222',
    '판매금액': '39,600', '총 결제 금액': '30,000', '쿠폰 분담액(amondz)': '5,000', '정산금액': '33,851' }, o || {});
  return HEAD.map((h) => (v[h] == null ? '' : v[h]));
}
const parsed = (...rows) => { const p = C.slParseFile([HEAD].concat(rows)); assert.equal(p.ok, true, p.error); return p.rows; };
const LR = (o) => Object.assign({ order_no: 'AM-Q', market: '아몬즈', recipient: '고객Q', phone: '010-0000-2222', product: 'x', opt: '', amount: 6938, is_gift: false, status: '정상', order_date: '2026-08-20' }, o || {});
const lmap = (...rows) => C.slLedgerIndex(rows, '아몬즈');
const O = (n, o) => Object.assign({ date: '26-08-20', barcode: 'Q0000' + n, code: 'F-BF-Z-WG-ZZ-0001', name: '팔찌', gift: false, settle: 6938, qty: 1, price: 17000, cancel: false }, o || {});
const four = (o) => [1, 2, 3, 4].map((n) => O(n, o));
const soldOf = (...ns) => ns.map((n) => ({ barcode: 'Q0000' + n }));
const run = (orders, sales, rows, led) => C.slMatchLedger(rows || parsed(frow()), led || lmap(LR()), orders, sales || [], OPTS);

test('수량 4 · 전부 안 팔림 → ok, 줄 4개, 실판매가 합 = 파일 정산금액 33,851 (고르게 나눔)', () => {
  const m = run(four(), []);
  assert.equal(m.status, 'ok', m.reason);
  assert.equal(m.lines.length, 4);
  assert.equal(m.lines.reduce((s, l) => s + l.amount, 0), 33851);
  assert.equal(m.cash, 33851);
  const a = m.lines.map((l) => l.amount);
  assert.ok(Math.max(...a) - Math.min(...a) <= 1, a.join());
  assert.deepEqual(m.lines.map((l) => l.barcode), ['Q00001', 'Q00002', 'Q00003', 'Q00004']);
});

test('수량 4 · 전부 이미 판매됨(바코드로 확인) → sold (추정 아님)', () => {
  const m = run(four(), soldOf(1, 2, 3, 4));
  assert.equal(m.status, 'sold'); assert.equal(m.inferred, undefined);
});

test('수량: 주문 줄이 3개뿐이면(3×6,938 은 하한 미달) 차단', () => {
  const m = run(four().slice(0, 3), []);
  assert.equal(m.status, 'block'); assert.match(m.reason, new RegExp(RANGE));
});

test('수량 4 · 2개 판매됨 + 2개 안 팔림 → 차단(일부만 판매됨)', () => {
  const m = run(four(), soldOf(1, 2));
  assert.equal(m.status, 'block'); assert.match(m.reason, /수량 4개 주문 — 일부만 판매됨\/줄 수 불일치 — 직접 처리/);
});

test('수량: 판매 추정으로 돌리지 않는다(일부 판매 + 판매내역에 금액 일치 줄이 있어도 차단)', () => {
  const sales = soldOf(1, 2).concat([{ barcode: 'Q00003', date: '26-10-02', code: 'F-BF-Z-WG-ZZ-0001', amount: 33851, price: 17000, qty: 1, dc: 0 }]);
  const m = run(four(), sales);
  assert.equal(m.status, 'block'); assert.doesNotMatch(m.reason, /이미 판매된/);
});

test('수량: 안 팔린 줄에 바코드가 없어도 판매 추정으로 돌리지 않는다', () => {
  const orders = [O(1), O(2), O(3, { barcode: '' }), O(4, { barcode: '' })];
  const sales = soldOf(1, 2).concat([{ barcode: 'Q00001', date: '26-10-02', code: 'F-BF-Z-WG-ZZ-0001', amount: 33851, price: 17000, qty: 1, dc: 0 }]);
  const m = run(orders, sales);
  assert.equal(m.status, 'block'); assert.match(m.reason, /수량 4개 주문/);
});

test('수량: k×L 이 판매금액 65% 에 못 미치면 차단', () => {
  const m = run(four(), [], parsed(frow({ '판매금액': '45,000' })));   // 0.65×45,000 = 29,250 > 27,752
  assert.equal(m.status, 'block'); assert.match(m.reason, new RegExp(RANGE));
});

test('수량: k×L 이 총 결제 금액+쿠폰을 넘으면 차단', () => {
  const m = run(four(), [], parsed(frow({ '총 결제 금액': '20,000' })));   // hi 25,000 < 27,752
  assert.equal(m.status, 'block'); assert.match(m.reason, new RegExp(RANGE));
});

test('수량: 주문일이 다른 줄은 세지 않는다 — 원장 주문일과 다른 날짜의 줄 2개는 k=2 로 모자라 차단', () => {
  const m = run([O(1), O(2), O(3, { date: '26-09-01' }), O(4, { date: '26-09-01' })], []);
  assert.equal(m.status, 'block'); assert.match(m.reason, new RegExp(RANGE));   // k=2 → 2×6,938 하한 미달
});

test('수량: 원장 주문일이 없으면 수량으로 읽지 않는다', () => {
  const m = run(four(), [], null, lmap(LR({ order_date: '' })));
  assert.equal(m.status, 'block'); assert.match(m.reason, new RegExp(RANGE));
});

test('단일 수량 주문은 그대로 — 범위 안이면 ok 1줄, 범위 밖이면 기존 범위 차단', () => {
  const one = run([O(1, { settle: 6938 })], [], parsed(frow({ '판매금액': '9,900', '총 결제 금액': '9,000', '쿠폰 분담액(amondz)': '900', '정산금액': '8,464' })));
  assert.equal(one.status, 'ok', one.reason); assert.equal(one.lines.length, 1); assert.equal(one.cash, 8464);
  const low = run([O(1)], [], parsed(frow()));   // 줄 1개 → k=1 이라 수량 아님
  assert.equal(low.status, 'block'); assert.match(low.reason, new RegExp(RANGE));
});

test('수량 경로는 아몬즈(payRange)만 — payRange 없이는 그대로 기존 동작', () => {
  const m = C.slMatchLedger(parsed(frow()), lmap(LR()), four(), [], { amountCheck: 'count' });
  assert.equal(m.status, 'block');   // 수량 분기는 payRange 에 묶여 있다 — 기대 줄 1개에 주문 줄 4개는 기존대로 줄 수 불일치
  assert.match(m.reason, /주문 줄 4개 \(필요 1개\)/);
});

test('수량: 원장 주문일 4줄이 이미 판매됨 + 다음 날 같은 정산 4줄 안 팔림 → 다음 날 줄을 팔지 않는다 (Terra T3 2R P1)', () => {
  const next = [5, 6, 7, 8].map((n) => O(n, { date: '26-08-21' }));
  const m = run(four().concat(next), soldOf(1, 2, 3, 4));
  assert.notEqual(m.status, 'ok', m.reason);
  assert.ok(!m.lines.some((l) => /Q0000[5-8]/.test(l.barcode)));
});
