/* 주문 가져오기 주문수량 — 덜 주문되는 일을 막는다(사장님 2026-11-05). 스펙 §2.1. 픽스처는 전부 가명.
 * 실행: node --test tests/orderimport-qty.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'src', 'orderimport-core.js'));

//  실제 새 양식의 열 순서(2026-11-05) — 주문수량이 옵션명 뒤에 있고 합계 행에도 주문수량 합이 있다.
const HEAD = ['관리번호', '판매처', '주문번호', '상태', 'CS', '상품명', '옵션명', '주문수량', '판매가', '정산금액', '주문일', '수령자이름', '수령자전화', '수령자휴대폰', '판매처 상품명', ''];
const R = (no, qty, o) => {
  const x = Object.assign({ seller: '아몬즈', name: '피어싱 (1개)', price: 20000, settle: 13850 }, o || {});
  return ['1', x.seller, no, '접수', '정상', x.name, '', qty, x.price, x.settle, '2026-11-05', '고객가', '', '010-0000-1234', x.name, ''];
};
const TOTAL = (qty) => ['합계', '', '', '', '', '', '', qty, 0, 0, '', '', '', '', '', ''];
const parse = (...rows) => C.oiParseRows([HEAD].concat(rows));
const mapped = { mapping: { entry: { seq: '1', code: 'X' } }, parsed: C.oiParseOption('') };

test('옛 양식: 수량 열이 없으면 1개로 추측하지 않고 파일을 거부한다', () => {
  const noQty = HEAD.filter((h) => h !== '주문수량');
  const row = R('A1', 2).filter((_, i) => i !== HEAD.indexOf('주문수량'));
  const r = C.oiParseRows([noQty, row]);
  assert.match(r.error, /필수 열 없음.*주문수량/);
  assert.equal(r.lines.length, 0);
});

test('열 이름: 주문수량 · 수량 둘 다 읽고, 공백은 무시하며, 주문수량이 우선한다', () => {
  assert.equal(C.oiParseRows([HEAD, R('A1', 1)]).error, null);
  const h2 = HEAD.map((h) => (h === '주문수량' ? '수량' : h));
  assert.equal(C.oiParseRows([h2, R('A1', 2)]).lines.length, 2);
  const h3 = HEAD.map((h) => (h === '주문수량' ? '주문 수량' : h));
  assert.equal(C.oiParseRows([h3, R('A1', 2)]).lines.length, 2);
  const both = HEAD.concat(['수량']);
  assert.equal(C.oiParseRows([both, R('A1', 2).concat([1])]).lines.length, 2, '주문수량 2');
  assert.equal(C.oiHeaderMap(HEAD).idx.qty, HEAD.indexOf('주문수량'));
});

test('2개 주문은 1개씩 2줄 — 줄 합이 주문수량과 같고 판매가·정산은 줄마다 그대로', () => {
  const { lines, error } = parse(R('A1', 2));
  assert.equal(error, null);
  assert.equal(lines.length, 2);
  lines.forEach((l) => { assert.equal(l.qty, 1); assert.equal(l.price, 20000); assert.equal(l.settle, 13850); });
  assert.notEqual(lines[0], lines[1], '줄마다 별도 객체 — 줄 하나를 고쳐도 다른 줄이 안 바뀐다');
  assert.deepEqual(lines.map((l) => l.qtySplit), [{ of: 2, n: 1 }, { of: 2, n: 2 }]);
  const orders = C.oiGroupOrders(lines);
  assert.equal(orders.length, 1, '한 주문장');
  assert.equal(orders[0].lines.length, 2);
  assert.equal(orders[0].lines.reduce((s, l) => s + l.qty, 0), 2);
  assert.equal(orders[0].lines[0].groupMismatch, false);
  assert.equal(orders[0].lines[1].groupMismatch, false);
});

test('나눈 줄은 경고로 알리되 체크는 막지 않는다 · 1개 주문엔 경고 없음', () => {
  const { lines } = parse(R('A1', 2), R('A2', 1));
  const rv = C.oiLineReview(lines[0], mapped);
  assert.deepEqual(rv.issues, []);
  assert.ok(rv.warnings.some((w) => /주문수량 2개/.test(w) && /1개 기준/.test(w)), rv.warnings.join('|'));
  assert.ok(!C.oiLineReview(lines[2], mapped).warnings.some((w) => /주문수량/.test(w)));
});

test('수량 칸이 비었거나 0·소수·문자면 1로 추측하지 않고 그 줄을 차단한다', () => {
  ['', 0, '0', 1.5, '두개', -1].forEach((q) => {
    const { lines, error } = parse(R('A1', q));
    assert.equal(error, null, String(q));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].qty, null, String(q));
    assert.ok(C.oiLineReview(lines[0], mapped).issues.includes('수량'), String(q));
  });
});

test('20개 초과는 줄을 만들지 않고 차단한다(최대 줄 수와 같은 20개는 나눈다)', () => {
  const over = parse(R('A1', 21)).lines;
  assert.equal(over.length, 1);
  assert.ok(C.oiLineReview(over[0], mapped).issues.some((s) => /주문수량 21개/.test(s)));
  assert.equal(parse(R('A1', 20)).lines.length, 20);
  const orders = C.oiGroupOrders(parse(R('A1', 20), R('A1', 1)).lines);
  assert.ok(orders[0].lines.every((l) => l.tooMany === 21), '합쳐서 20줄을 넘으면 기존 줄 수 차단');
});

test('합계 행 검산: 주문수량 합이 다르면 파일 거부 · 같으면 통과 · 합계 행이 없어도 통과', () => {
  assert.equal(parse(R('A1', 2), R('A2', 1), TOTAL(3)).error, null);
  const bad = parse(R('A1', 2), R('A2', 1), TOTAL(4));
  assert.match(bad.error, /주문수량.*합계 4.*3/);
  assert.equal(bad.lines.length, 0);
  assert.equal(parse(R('A1', 2)).error, null);
});

test('합계 행 검산: 값을 못 읽은 줄이 있으면 합이 안 맞아 파일 거부 · 합계 칸이 비면 검산 안 함', () => {
  assert.match(parse(R('A1', ''), TOTAL(1)).error, /주문수량/);
  assert.equal(parse(R('A1', 1), TOTAL('')).error, null);
  assert.match(parse(R('A1', 1), TOTAL('많음')).error, /주문수량/);
});

test('판매처·주문번호가 모두 빈 행도 상품이 있으면 버리지 않고 차단 줄로 올린다 · 완전한 빈 행만 버린다', () => {
  const blank = R('', 2, { seller: '' });
  const r = parse(blank, HEAD.map(() => ''));
  assert.equal(r.error, null);
  assert.equal(r.lines.length, 2, '주문수량 2 만큼');
  const rv = C.oiLineReview(r.lines[0], mapped);
  assert.ok(rv.issues.some((s) => /판매처 미등록/.test(s)));
  assert.ok(rv.issues.includes('주문번호 없음'));
});

test('합계 행은 어느 열에 있어도 합계다 — 주문 줄이 되지 않고 검산에 쓰인다 · 상품이 있으면 합계로 보지 않는다', () => {
  const inSeller = TOTAL(9).slice(); inSeller[0] = ''; inSeller[1] = '합계';
  const bad = parse(R('A1', 1), inSeller);
  assert.match(bad.error, /주문수량.*합계 9/);
  inSeller[HEAD.indexOf('주문수량')] = 1;
  const ok = parse(R('A1', 1), inSeller);
  assert.equal(ok.error, null);
  assert.equal(ok.lines.length, 1);
  assert.equal(parse(R('A1', 1, { name: '합계' })).lines.length, 1, '상품명이 합계인 주문은 주문 줄');
});

test('주문장 서명: 줄이 늘어나면 옛 1줄 등록과 다른 서명 — 완전 중복으로 숨지 않는다', () => {
  const two = C.oiGroupOrders(parse(R('A1', 2)).lines)[0];
  const one = C.oiGroupOrders(parse(R('A1', 1)).lines)[0];
  assert.notEqual(C.oiOrderSig(two), C.oiOrderSig(one));
});

test('사은품 2개도 나누고 판매가 0 은 유지한다', () => {
  const { lines } = parse(R('A1', 2, { name: '[사은품] 트레이', price: 0, settle: 0 }));
  assert.equal(lines.length, 2);
  lines.forEach((l) => { assert.equal(l.gift, true); assert.equal(l.price, 0); });
});

test('등록 페이로드: 나눈 줄은 orderQty 1 — 수량 2 한 줄로 나가지 않는다', () => {
  const { lines } = parse(R('A1', 2));
  assert.equal(lines[0].qty, 1);
  const form = { values: { master: '1', color: 'WG' }, kOpts: [], colorOpts: [], arrays: {}, missing: [] };
  const p = C.oiLinePayload(form, { seq: '1', code: 'X' }, { qty: lines[0].qty, price: lines[0].price, remark: '' });
  assert.equal(p.values.orderQty, '1');
  assert.deepEqual(p.issues, []);
});
