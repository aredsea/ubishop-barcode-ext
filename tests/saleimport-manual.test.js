/* saleimport §10.10 막힌 건 직접 해결 — 코어 헬퍼(분류·후보·배분·직접 매칭)와 패널 배선(소스 문자열) 회귀테스트. 이름·연락처는 가명, 네트워크 없음.
 * 실행: node --test tests/saleimport-manual.test.js */
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
const CL = { seq: '1', name: '고객X/아' };
const ent = (st, m, o) => Object.assign({ client: CL, st, match: m, hard: false, result: null }, o || {});
const ledger = (orders, sales, rows) => C.slMatchLedger(rows || parsed(frow()), lmap(LR()), orders, sales, OPTS);

/* ------------------------------------------------------------ 분류 */
test('분류: 주문 줄 못 맞춘 차단(줄 없음·개수·여러 주문일·일부 판매·같은 정산)은 kind=line → 직접 고르기 가능', () => {
  const none = ledger([], []);
  assert.equal(none.status, 'block'); assert.equal(none.kind, 'line');
  assert.match(none.reason, /주문 줄 0개 \(필요 1개\)/);   // 사유 문구는 그대로
  assert.equal(C.slManualResolvable(ent('block', none)), true);
  const two = ledger([O({ settle: 8464 }), O({ barcode: 'B00002', settle: 8464 })], []);
  assert.equal(two.kind, 'line'); assert.equal(C.slManualResolvable(ent('block', two)), true);
  const dates = C.slMatchLedger(parsed(frow(), frow({ '상품주문번호': 'AM-X-2' })), lmap(LR(), LR()), [O({ settle: 8464 }), O({ barcode: 'B00002', settle: 8464, date: '26-08-21' })], [], { amountCheck: 'count' });
  assert.equal(dates.kind, 'line', dates.reason);
});

test('분류: 취소 표시·바코드 없음·원장에 없음·반품·0원 같은 데이터·정책 차단은 kind=hard → 직접 고르기 불가', () => {
  for (const [name, m] of [
    ['취소 표시', ledger([O({ settle: 8464, cancel: true })], [])],
    ['바코드 없음', ledger([O({ settle: 8464, barcode: '' })], [])],
    ['원장에 없음', C.slMatchLedger(parsed(frow()), lmap(), [O({ settle: 8464 })], [], OPTS)]
  ]) {
    assert.equal(m.status, 'block', name); assert.equal(m.kind, 'hard', name + ': ' + m.reason);
    assert.equal(C.slManualResolvable(ent('block', m)), false, name);
  }
  const ret = C.slMatchLedger(parsed(frow()), lmap(LR()), [O({ settle: 8464 })], [], Object.assign({ retOrders: new Set(['AM-X']) }, OPTS));
  assert.equal(ret.kind, 'hard');
});

test('분류: 판매 추정(inferred sold)은 풀 수 있고, 확정된 이미 판매됨은 못 푼다', () => {
  const inf = ledger([O({ barcode: 'B00001' })], [S(8464)]);
  assert.equal(inf.status, 'sold'); assert.equal(inf.inferred, true);
  assert.equal(C.slManualResolvable(ent('sold', inf)), true);
  const done = ledger([O({ settle: 8464 })], [S(8464)]);
  assert.equal(done.status, 'sold'); assert.ok(!done.inferred);
  assert.equal(C.slManualResolvable(ent('sold', done)), false);
});

test('분류: 고객 미확정·hard·결과 있음·ok·match 없음(미수금·고객 확인 실패·겹침·조회 실패는 match 가 비어 있다)은 풀 수 없다', () => {
  const m = ledger([], []);
  assert.equal(C.slManualResolvable(ent('block', m, { client: null })), false);
  assert.equal(C.slManualResolvable(ent('block', m, { hard: true })), false);
  assert.equal(C.slManualResolvable(ent('block', m, { result: { status: 'done' } })), false);
  assert.equal(C.slManualResolvable(ent('ok', m)), false);
  assert.equal(C.slManualResolvable(ent('block', null)), false);
  assert.equal(C.slManualResolvable(null), false);
});

test('분류: 가격 대조 일부 판매 힌트가 붙은 차단도 kind 를 유지한다(줄 문제면 line)', () => {
  const rows = parsed(frow({ '상품주문번호': 'AM-X-1' }), frow({ '상품주문번호': 'AM-X-2', '정산금액': '5,000' }));
  const m = C.slMatchLedger(rows, lmap(LR(), LR({ amount: 5000 })), [O({ settle: 8464 })], [S(8464)], { amountCheck: 'count' });
  assert.equal(m.status, 'block'); assert.equal(m.kind, 'line', m.reason);
});

/* ------------------------------------------------------------ 후보·배분·합계 */
test('slManualCandidates: 안 팔린 본품 줄만 · 바코드 없음/취소/중복은 비활성 · 사은품·판매된 줄은 빠진다', () => {
  const orders = [O({ barcode: 'A1', settle: 8464, date: '26-08-20' }), O({ barcode: 'S1' }), O({ barcode: '' , date: '26-09-01' }), O({ barcode: 'C1', cancel: true }), O({ barcode: 'A1' }), O({ barcode: 'G1', gift: true })];
  const c = C.slManualCandidates(orders, [S(1, { barcode: 'S1' })]);
  assert.deepEqual(c.map((x) => [x.barcode, x.disabled, x.why]), [['A1', true, '바코드 중복'], ['', true, '입고 전'], ['C1', true, '취소 표시'], ['A1', true, '바코드 중복']]);
  //  Terra T3 1R P1: 중복 바코드는 첫 줄도 고를 수 없다 — 어느 주문 줄인지 모르면 판매하지 않는다.
  assert.equal(C.slManualMatch(orders, [S(1, { barcode: 'S1' })], [{ barcode: 'A1', price: 8464 }], 8464).status, 'block');
  assert.equal(c[0].note, '정산 8,464'); assert.equal(c[0].price, 20000); assert.equal(c[0].date, '26-08-20');
});

test('slManualAllocate: 판매가 비율 배분 Σ=F · 판매가 전부 0 이면 고르게 · 잘못된 입력은 null', () => {
  const a = C.slManualAllocate(10001, [30000, 10000, 20000]);
  assert.equal(a.reduce((s, x) => s + x, 0), 10001); assert.equal(a.length, 3);
  assert.deepEqual(C.slManualAllocate(10, [0, 0, 0]), [4, 3, 3]);
  assert.equal(C.slManualAllocate(-1, [1]), null); assert.equal(C.slManualAllocate(10, []), null);
  for (let F = 1; F < 400; F += 7) assert.equal(C.slManualAllocate(F, [333, 777, 1, 20000]).reduce((s, x) => s + x, 0), F);
});

test('slManualTotal: 행 금액 합 · 하나라도 양의 정수가 아니면 null', () => {
  assert.equal(C.slManualTotal([{ amount: 100 }, { amount: 250 }]), 350);
  assert.equal(C.slManualTotal([{ amount: 100 }, { amount: 0 }]), null);
  assert.equal(C.slManualTotal([{ amount: 1.5 }]), null);
  assert.equal(C.slManualTotal([]), null);
});

/* ------------------------------------------------------------ 직접 매칭 */
const ORD = [O({ barcode: 'A1', code: 'C-A', name: '반지', price: 30000 }), O({ barcode: 'A2', code: 'C-B', name: '팔찌', price: 10000 }), O({ barcode: 'S1' })];
const SAL = [S(1, { barcode: 'S1' })];

test('slManualMatch: Σ=F 이고 모두 안 팔린 주문 줄이면 ok — 줄 모양은 일반 ok 결과와 같다(cash = F)', () => {
  const m = C.slManualMatch(ORD, SAL, [{ barcode: 'A1', price: 7500 }, { barcode: 'A2', price: 2500 }], 10000, { orderNo: 'AM-X', ledgerNo: 'AM-X' });
  assert.equal(m.status, 'ok', m.reason); assert.equal(m.cash, 10000); assert.equal(m.manual, true);
  assert.deepEqual(m.lines, [
    { barcode: 'A1', code: 'C-A', name: '반지', gift: false, orderNo: 'AM-X', amount: 7500, ledgerNo: 'AM-X' },
    { barcode: 'A2', code: 'C-B', name: '팔찌', gift: false, orderNo: 'AM-X', amount: 2500, ledgerNo: 'AM-X' }]);
  const auto = ledger([O({ settle: 8464 })], []);
  assert.deepEqual(Object.keys(m.lines[0]).filter((k) => k !== 'ledgerNo').sort(), Object.keys(auto.lines[0]).filter((k) => k !== 'ledgerNo').sort());
});

test('slManualMatch: Σ ≠ F → block', () => {
  const m = C.slManualMatch(ORD, SAL, [{ barcode: 'A1', price: 7500 }, { barcode: 'A2', price: 2499 }], 10000);
  assert.equal(m.status, 'block'); assert.match(m.reason, /합계 9,999원 ≠ 파일 정산금액 10,000원/); assert.deepEqual(m.lines, []);
});

test('slManualMatch: 같은 바코드 두 번 → block', () => {
  assert.equal(C.slManualMatch(ORD, SAL, [{ barcode: 'A1', price: 5000 }, { barcode: 'A1', price: 5000 }], 10000).status, 'block');
});

test('slManualMatch: 판매된 줄·없는 바코드·사은품·취소·바코드 없는 줄 → block', () => {
  const orders = ORD.concat([O({ barcode: 'G1', gift: true }), O({ barcode: 'C1', cancel: true })]);
  for (const bc of ['S1', 'ZZ', 'G1', 'C1', '']) assert.equal(C.slManualMatch(orders, SAL, [{ barcode: bc, price: 10000 }], 10000).status, 'block', bc);
});

test('slManualMatch: 음수·소수·문자열·NaN 가격 → block', () => {
  for (const price of [-1, 1.5, '5000', NaN, undefined]) assert.equal(C.slManualMatch(ORD, SAL, [{ barcode: 'A1', price }, { barcode: 'A2', price: 5000 }], 10000).status, 'block', String(price));
  assert.equal(C.slManualMatch(ORD, SAL, [{ barcode: 'A1', price: 0 }, { barcode: 'A2', price: 10000 }], 10000).status, 'ok');   // 0원 줄은 허용(합이 F)
});

test('slManualMatch: 빈 선택·F 가 정수 아님/0 → block', () => {
  assert.equal(C.slManualMatch(ORD, SAL, [], 10000).status, 'block');
  assert.equal(C.slManualMatch(ORD, SAL, [{ barcode: 'A1', price: 0 }], 0).status, 'block');
  assert.equal(C.slManualMatch(ORD, SAL, [{ barcode: 'A1', price: 10000 }], 10000.5).status, 'block');
});

test('slManualMatch: ok 결과를 그대로 plan 으로 만들면 실행기 계획 점검(bad_plan)을 통과한다', async () => {
  const m = C.slManualMatch(ORD, SAL, [{ barcode: 'A1', price: 7500 }, { barcode: 'A2', price: 2500 }], 10000, { orderNo: 'AM-X' });
  const plan = { key: 'k', client: { seq: '1', name: '고객X' }, lines: m.lines.map((l) => Object.assign({}, l)), cash: m.cash };
  const erp = { state: async () => ({ tradeJun: '9', payJun: '', rows: 0 }) };   // 가드에서 멈추게 — 계획 점검은 그 앞이다
  const r = await C.slRunClient(plan, erp, {});
  assert.equal(r.reason, 'open_trade');
  const bad = await C.slRunClient(Object.assign({}, plan, { cash: plan.cash + 1 }), erp, {});
  assert.equal(bad.reason, 'bad_plan');
});

test('slHowChip: 직접 지정은 별도 칩(manual)', () => {
  assert.deepEqual(C.slHowChip('직접 지정'), { cls: 'manual', text: '직접 지정' });
});

/* ------------------------------------------------------------ 패널 배선(소스 문자열) */
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const UI = read('src/saleimport.js');
function body(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, head + ' 없음');
  const end = src.indexOf('\n  }\n', at);
  assert.ok(end > at, head + ' 끝을 못 찾음');
  return src.slice(at, end);
}

test('배선: 줄 직접 고르기 버튼은 풀 수 있는 항목(C.slManualResolvable)에만, 실행 중엔 잠긴다', () => {
  const b = body(UI, 'function manualBtn(e, ei) {');
  assert.ok(/C\.slManualResolvable\(e\)/.test(b));
  assert.ok(b.indexOf('slManualResolvable') < b.indexOf('data-act="pick-open"'), '분류 뒤에만 버튼');
  assert.ok(/줄 직접 고르기/.test(b));
  const er = body(UI, 'function entryRows(e, ei) {');
  assert.ok(/manualBtn\(e, ei\)/.test(er), 'entryRows 가 버튼을 그린다');
  assert.equal((UI.match(/data-act="pick-open"/g) || []).length, 1, '버튼 생성은 한 곳');
});

test('배선: 후보 읽기는 enqueue 안에서 — 열기·확정 모두 읽기 전용(E.openClient/E.trade 만)', () => {
  const b = body(UI, 'async function openPicker(ei) {');
  assert.ok(/enqueue\(/.test(b) && /manualRead\(/.test(b));
  const r = body(UI, 'async function manualRead(e) {');
  assert.ok(/E\.openClient\(/.test(r) && /E\.trade\(/.test(r) && /receivable\(/.test(r));
  assert.ok(!/E\.post|E\.delete|E\.getSaleForm/.test(r), '쓰기·세션 호출 없음');
  const c = body(UI, 'async function confirmPicker(ei) {');
  assert.ok(/enqueue\(/.test(c));
});

test('배선: 확정은 다시 읽어 slManualMatch 로 검증한 뒤에만 e.match·st=ok·how=직접 지정·checked 를 세우고 applyOverlaps 를 부른다', () => {
  const c = body(UI, 'async function confirmPicker(ei) {');
  const iRead = c.indexOf('manualRead(');
  const iSet = c.indexOf("e.how = '직접 지정'");
  assert.ok(iRead > 0 && iSet > iRead, '재조회가 먼저');
  assert.ok(/e\.st = 'ok'/.test(c) && /e\.checked = true/.test(c) && /e\.match = /.test(c));
  assert.ok(c.indexOf('applyOverlaps()') > iSet, '겹침 검사는 확정 뒤');
  assert.ok(/logLine\(who, 'manual_pick'/.test(c), '로그에 직접 지정 기록');
  assert.ok(/usedKeys/.test(c), '판매 추정이 잡았던 판매 줄을 풀어 준다');
});

test('배선: manualRead 는 슬롯 검증(slManualMatch)을 한 곳에서 한다 — 열기·확정·실행 직전이 같은 함수', () => {
  const r = body(UI, 'async function manualRead(e) {');
  assert.ok(/C\.slManualMatch\(/.test(r) || /C\.slManualCandidates\(/.test(r));
  const rv = body(UI, 'async function manualRevalidate(e) {');
  assert.ok(/manualRead\(e\)/.test(rv) && /C\.slManualMatch\(/.test(rv));
  assert.ok(/e\.manual\.chosen/.test(rv));
});

test('배선: run() 은 조회 대기 뒤·겹침 재검사·entryReady 전에 직접 지정 항목을 다시 읽어 검증하고, 실패하면 차단해 실행을 취소한다', () => {
  const b = body(UI, 'async function run() {');
  const iWait = b.indexOf('while (S.enriching)');
  const iRe = b.indexOf('manualRevalidate(');
  const iOv = b.indexOf('applyOverlaps()', iWait);
  const iEvery = b.indexOf('targets.every(entryReady)');
  const iRun = b.indexOf('S.running = true;');
  assert.ok(iWait > 0 && iRe > iWait, '조회 대기 뒤');
  assert.ok(iOv > iRe && iEvery > iOv && iRun > iEvery, '재검증 → 겹침 → entryReady → 실행');
  assert.ok(/e\.manual/.test(b.slice(iWait, iEvery)), '직접 지정 항목만 골라 읽는다');
  assert.ok(/setBlock\(/.test(b.slice(iRe, iEvery)), '실패는 차단으로');
});

test('배선: 자동 매칭 경로는 직접 지정을 덮어쓰지 않는다 — 직접 지정은 run() 이 matchEntry 를 다시 부르지 않고 따로 검증한다', () => {
  const b = body(UI, 'async function run() {');
  assert.ok(!/matchEntry\(/.test(b), 'run() 은 matchEntry 를 부르지 않는다');
  const rv = body(UI, 'async function manualRevalidate(e) {');
  assert.ok(!/matchEntry\(/.test(rv));
  const m = body(UI, 'async function matchEntry(e, probe) {');
  assert.ok(/e\.manual = null/.test(m), '자동 재매칭(고객 바꿈 등)은 직접 지정 기록을 비운다');
});

test('배선: 선택한 줄은 다른 묶음이 쓰는 바코드·사은품 없이 목록에서 비활성, 합계 ≠ 정산금액이면 확정 버튼이 꺼진다', () => {
  const h = body(UI, 'function pickerHtml(e, ei) {');
  assert.ok(/usedByOthers\(e\)/.test(h) && /다른 고객 묶음이 사용 중/.test(h));
  const st = body(UI, 'function pickState(e) {');
  assert.ok(/C\.slManualMatch\(/.test(st), '합계·검증은 slManualMatch 한 곳');
  const f = body(UI, 'function pickFoot(e, ei) {');
  assert.ok(/data-act="pick-ok"/.test(f) && /st\.m\.status === 'ok'/.test(f) && /' disabled'/.test(f), '검증 ok 일 때만 확정 버튼 활성');
  assert.ok(/slManualAllocate\(/.test(UI));
  assert.ok(/입고 전/.test(h) || /c\.why/.test(h));
});

test('배선: 칩·로그 — 직접 지정 칩 스타일, 로그 JSON 에 직접 지정(바코드·실판매가)', () => {
  assert.ok(/sl-chip\.manual/.test(UI));
  const click = body(UI, 'async function onClick(e) {');
  assert.ok(/manualPicks/.test(click) && /e\.manual/.test(click));
  assert.ok(/act === 'pick-open'/.test(click) && /act === 'pick-ok'/.test(click) && /act === 'pick-close'/.test(click));
});

test('배선: 직접 지정 줄은 첫 파일 행에 붙고 나머지 행은 합산 표시, 이전 처리 기록은 모든 행에 남는다', () => {
  assert.ok(/e\.match\.manual/.test(UI));
  const rp = body(UI, 'async function runPlans(plans) {');
  assert.ok(/e\.match\.manual/.test(rp), '장부 기록이 직접 지정 줄을 모든 행에');
});

/* ------------------------------------------------------------ 패널 동작(vm 하네스) — run()·확정이 실제로 다시 읽어 검증하는지 */
const { loadPanel } = require(path.join(ROOT, 'tools', 'saleimport-panel-harness.js'));
const ORDERS = [
  { date: '26-08-20', barcode: 'A1', code: 'C-A', name: '반지', gift: false, settle: null, qty: 1, price: 30000, cancel: false },
  { date: '26-08-20', barcode: 'A2', code: 'C-B', name: '팔찌', gift: false, settle: null, qty: 1, price: 10000, cancel: false },
  { date: '26-08-21', barcode: '', code: 'C-C', name: '입고 전', gift: false, settle: null, qty: 1, price: 5000, cancel: false }];
function mkEntry(o) {
  return Object.assign({ key: '고객X/아', rows: [{ orderNo: 'AM-X', ledgerNo: 'AM-X', amount: 10000, name: '팔찌', qty: 1 }], buyer: '고객X', client: { seq: '1', name: '고객X/아' }, how: '자동', st: 'block',
    reason: '정산 8,464 주문 줄 0개 (필요 1개)', match: { status: 'block', kind: 'line', reason: 'x', lines: [], cash: 0 }, checked: false, cands: null, q: '', note: '', qGen: 0, result: null,
    source: '원장', ledger: new Map([['AM-X', [{}]]]), retOrders: new Set(), retFull: new Set(), hard: false, manual: null, pick: null }, o || {});
}
function mkErp(state) {
  const st = state || {};
  if (st.sales === undefined) st.sales = []; if (st.before === undefined) st.before = '0';   // 테스트가 같은 객체를 고쳐 '그 사이' 를 만든다
  return {
    openClient: async () => ({ values: { client: '1' }, form10: { beforePrice: st.before } }),
    trade: async () => ({ orders: ORDERS, sales: st.sales }),
    state: async () => ({ tradeJun: '9', payJun: '', rows: 0 })   // 가드에서 멈춘다 — 실행기까지 갔다는 표시
  };
}
const manualOk = () => { const m = C.slManualMatch(ORDERS, [], [{ barcode: 'A1', price: 7500 }, { barcode: 'A2', price: 2500 }], 10000, { orderNo: 'AM-X', ledgerNo: 'AM-X' }); assert.equal(m.status, 'ok'); return m; };
const manualEntry = () => mkEntry({ st: 'ok', reason: '', how: '직접 지정', checked: true, match: manualOk(), manual: { chosen: [{ barcode: 'A1', price: 7500 }, { barcode: 'A2', price: 2500 }], F: 10000, at: 'x' } });

test('패널 run(): 직접 지정 항목은 실행 직전에 다시 읽어(E.openClient·E.trade) 검증하고, 그대로면 실행기까지 간다', async () => {
  const h = loadPanel(mkErp());
  h.S.entries = [manualEntry()];
  await h.api.run();
  assert.equal(h.alerts.length, 0, h.alerts.join('|'));
  assert.ok(h.calls.includes('openClient') && h.calls.includes('trade'), '재조회 했음');
  assert.ok(h.calls.indexOf('trade') < h.calls.indexOf('state'), '재조회가 실행기(state 가드)보다 먼저');
});

test('패널 run(): 고른 줄이 그 사이 판매됐으면 실행하지 않고 차단한다(실행기 state 호출 0)', async () => {
  const h = loadPanel(mkErp({ sales: [{ barcode: 'A2', date: '26-10-06', amount: 100, price: 100 }] }));
  h.S.entries = [manualEntry()];
  await h.api.run();
  assert.ok(h.alerts.some((a) => /조회 결과가 바뀌어/.test(a)), h.alerts.join('|'));
  assert.ok(!h.calls.includes('state'), '실행기가 시작되면 안 됨');
  assert.equal(h.S.entries[0].st, 'block'); assert.match(h.S.entries[0].reason, /직접 지정 재검증 실패/); assert.equal(h.S.entries[0].manual, null);
});

test('패널 run(): 그 사이 미수금이 생겼으면 실행하지 않는다', async () => {
  const h = loadPanel(mkErp({ before: '50,000' }));
  h.S.entries = [manualEntry()];
  await h.api.run();
  assert.ok(!h.calls.includes('state'));
  assert.match(h.S.entries[0].reason, /미수금/);
});

test('패널 run(): 자동 ok 항목은 다시 읽지 않는다(자동 매칭 동작 불변) — 직접 지정만 재검증', async () => {
  const h = loadPanel(mkErp());
  const auto = mkEntry({ st: 'ok', checked: true, how: '자동', match: manualOk() });
  h.S.entries = [auto];
  await h.api.run();
  assert.ok(!h.calls.includes('openClient') && !h.calls.includes('trade'));
  assert.ok(h.calls.includes('state'));
});

test('패널: 줄 직접 고르기 → 체크 → 자동 배분 Σ=F → 확정 → ok · 직접 지정 · 체크됨 (겹침 검사 포함)', async () => {
  const h = loadPanel(mkErp());
  const e = mkEntry();
  h.S.entries = [e];
  await h.api.openPicker(0);
  assert.equal(e.pick.loading, false); assert.equal(e.pick.err, '');
  assert.equal(JSON.stringify(e.pick.cands.map((c) => [c.barcode, c.disabled])), JSON.stringify([['A1', false], ['A2', false], ['', true]]));
  h.api.pickToggle(0, 'A1', true); h.api.pickToggle(0, 'A2', true);
  assert.equal(JSON.stringify(e.pick.sel), JSON.stringify(['A1', 'A2']));
  assert.equal(e.pick.price.A1 + e.pick.price.A2, 10000);
  assert.equal(e.pick.price.A1, 7500);   // 30000:10000 비율
  assert.equal(h.api.pickState(e).m.status, 'ok');
  e.pick.price.A2 = 1; assert.equal(h.api.pickState(e).m.status, 'block');   // 고쳐 쓴 합이 다르면 확정 불가
  e.pick.price.A2 = 2500;
  await h.api.confirmPicker(0);
  assert.equal(e.st, 'ok'); assert.equal(e.how, '직접 지정'); assert.equal(e.checked, true); assert.equal(e.pick, null);
  assert.equal(e.match.cash, 10000); assert.equal(e.match.manual, true);
  assert.equal(JSON.stringify(e.manual.chosen), JSON.stringify([{ barcode: 'A1', price: 7500 }, { barcode: 'A2', price: 2500 }]));
  assert.ok(h.api.entryReady(e));
  assert.ok(h.S.log.some((l) => l.step === 'manual_pick'));
});

test('패널: 확정 순간 다시 읽어 그 사이 판매된 줄이 있으면 확정하지 않는다', async () => {
  const st = { sales: [] };
  const h = loadPanel(mkErp(st));
  const e = mkEntry();
  h.S.entries = [e];
  await h.api.openPicker(0);
  h.api.pickToggle(0, 'A1', true); h.api.pickToggle(0, 'A2', true);
  st.sales = [{ barcode: 'A1', date: '26-10-06', amount: 1, price: 1 }];   // 열어 둔 사이 직원이 팔았다
  await h.api.confirmPicker(0);
  assert.equal(e.st, 'block'); assert.equal(e.manual, null); assert.ok(e.pick && /판매 안 된 주문 줄이 아님/.test(e.pick.msg), e.pick && e.pick.msg);
});

test('패널: 다른 묶음이 이미 잡은 바코드는 목록에서 비활성 · 풀 수 없는 항목엔 버튼이 없다', async () => {
  const h = loadPanel(mkErp());
  const other = mkEntry({ key: '다른고객', st: 'ok', checked: true, match: { status: 'ok', reason: '', lines: [{ barcode: 'A1', code: 'C-A', name: '반지', gift: false, orderNo: 'O2', amount: 1 }], cash: 1 }, client: { seq: '2', name: '다른고객' } });
  const e = mkEntry();
  h.S.entries = [e, other];
  await h.api.openPicker(0);
  const html = h.api.pickerHtml(e, 0);
  assert.match(html, /다른 고객 묶음이 사용 중/);
  assert.match(html, /data-b="A1"[^>]*disabled/);
  assert.match(html, /입고 전/);
  assert.match(h.api.manualBtn(mkEntry(), 0), /줄 직접 고르기/);
  assert.equal(h.api.manualBtn(mkEntry({ hard: true }), 0), '');
  assert.equal(h.api.manualBtn(mkEntry({ match: null, reason: '기존 미수금 있음 (1원)' }), 0), '');
  assert.equal(h.api.manualBtn(mkEntry({ st: 'sold', match: { status: 'sold', reason: '이미 판매됨', lines: [], cash: 0 } }), 0), '');
  assert.match(h.api.manualBtn(mkEntry({ st: 'sold', match: { status: 'sold', inferred: true, reason: 'r', lines: [], cash: 0 } }), 0), /줄 직접 고르기/);
});
