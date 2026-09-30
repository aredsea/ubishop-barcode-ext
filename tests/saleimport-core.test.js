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
