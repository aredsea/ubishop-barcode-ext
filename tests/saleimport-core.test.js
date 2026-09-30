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
