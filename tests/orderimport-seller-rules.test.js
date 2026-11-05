/* 주문 가져오기 판매처 규칙: 이마트 → SSG, D102 패션 기본 숨김(사장님 2026-11-05). 픽스처는 전부 가명.
 * 실행: node --test tests/orderimport-seller-rules.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'src', 'orderimport-core.js'));
//  옛 양식 픽스처(주문수량 열 없음)에 수량 1 열을 붙여 읽는다 — 수량 규칙 자체는 tests/orderimport-qty.test.js 가 맡는다.
const withQty = (rows) => { if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0])) return rows; const h = rows[0].map((c) => String(c).replace(/\s+/g, '')); if (h.includes('수량') || h.includes('주문수량')) return rows; return rows.map((r, i) => (Array.isArray(r) ? (i === 0 ? r.concat(['수량']) : (String(r[0] == null ? '' : r[0]).trim() === '합계' ? r : r.concat([1]))) : r)); };
const parseRows = (rows, meta) => C.oiParseRows(withQty(rows), meta);
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const HEAD = ['판매처', '주문번호', '상품명', '옵션명', '판매가', '정산금액', '수령자이름', '수령자휴대폰'];
const row = (seller, no) => [seller, no, '반지', '', '10000', '7000', '고객가', '010-0000-1234'];
const orders = (...rows) => C.oiGroupOrders(parseRows([HEAD].concat(rows)).lines);

test('이마트는 SSG 마켓으로 연결된다(접미 s · 등록 마켓 2) · 공백은 무시', () => {
  ['이마트', ' 이 마트 '].forEach((s) => {
    const m = C.oiMarket(s);
    assert.equal(m.name, 'SSG');
    assert.equal(m.suffix, 's');
    assert.equal(m.clientJob, '2');
  });
  assert.deepEqual(C.oiMarket('이마트'), C.oiMarket('SSG'));
});

test('이마트 주문: 고객명은 /s, 판매처 표기와 주문장 키는 파일 값 그대로(장부 키 유지)', () => {
  const [o] = orders(row('이마트', 'A1'));
  assert.equal(o.clientName, '고객가1234/s');
  assert.equal(o.seller, '이마트');
  assert.equal(o.key, '이마트|A1');
  assert.equal(C.oiClientJob(o), '2');
});

test('별칭은 이마트뿐 — 다른 미등록 판매처는 그대로 미등록', () => {
  assert.equal(C.oiMarket('E마트'), null);
  assert.equal(C.oiMarket('홈플러스'), null);
});

test('D102 패션 판별: 공백·대소문자만 무시, 다른 판매처는 아님', () => {
  ['D102 패션', 'D102패션', 'd102 패션', ' D102  패션 '].forEach((s) => assert.equal(C.oiHiddenSeller(s), true, s));
  ['D102', 'D102 예물', '패션', '카페24', '', null].forEach((s) => assert.equal(C.oiHiddenSeller(s), false, String(s)));
});

test('oiSplitHidden: D102 패션 주문장만 숨김으로 가르고 순서를 유지한다', () => {
  const all = orders(row('카페24', 'A1'), row('D102 패션', 'B1'), row('SSG', 'A2'), row('D102패션', 'B2'));
  const { visible, hidden } = C.oiSplitHidden(all);
  assert.deepEqual(visible.map((o) => o.orderNo), ['A1', 'A2']);
  assert.deepEqual(hidden.map((o) => o.orderNo), ['B1', 'B2']);
  assert.deepEqual(C.oiSplitHidden([]), { visible: [], hidden: [] });
});

/* ---------------------------------------------------------------- 패널 배선 */
const UI = read('src/orderimport.js');
const body = (name) => { const i = UI.indexOf(name); assert.ok(i >= 0, name); const rest = UI.slice(i); return rest.slice(0, rest.search(/\r?\n  \}\r?\n/)); };

test('패널: 파일을 읽을 때 숨김을 가르고, S.orders 에는 보이는 주문장만 들어간다', () => {
  const b = body('function buildOrders');
  assert.ok(/C\.oiSplitHidden\(C\.oiGroupOrders\(pr\.lines\)\)/.test(b));
  assert.ok(/S\.orders = split\.visible/.test(b));
  assert.ok(/S\.hiddenOrders = split\.hidden/.test(b));
});

test('패널: 파일을 다시 고르거나 실패하면 이전 파일의 숨김이 남지 않는다', () => {
  const b = body('async function loadFile');
  const n = (b.match(/S\.hiddenOrders = \[\]/g) || []).length;
  assert.equal(n, 2, '시작·실패 두 곳');
});

test('패널: 숨김 안내 배너와 [보기] — 눌렀을 때만 표로 옮기고 조회한다', () => {
  assert.ok(UI.includes('data-act="show-hidden"'));
  const i = UI.indexOf("act === 'show-hidden'"), b = UI.slice(i, UI.indexOf('else if', i + 10));
  assert.ok(i >= 0);
  assert.ok(/S\.orders = S\.orders\.concat\(S\.hiddenOrders\)/.test(b));
  assert.ok(/S\.hiddenOrders = \[\]/.test(b));
  assert.ok(/await enrich\(\)/.test(b));
});

test('패널: 숨긴 주문장은 등록 대상 계산에 쓰이지 않는다(hiddenOrders 는 보기·초기화에서만)', () => {
  const uses = UI.split('\n').filter((l) => l.includes('hiddenOrders'));
  uses.forEach((l) => assert.ok(!/toRunOrder|\.checked/.test(l), l.trim()));
  assert.ok(!/hiddenOrders/.test(body('async function run')));
});
