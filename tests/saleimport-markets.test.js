/* saleimport 마켓 어댑터·perOrder 매칭 테스트. 스펙 §10.
 * 실행: node --test tests/saleimport-markets.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'src', 'saleimport-core.js'));
const FX = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'saleimport', n), 'utf8').replace(/\r\n/g, '\n');
const GS = JSON.parse(FX('rows-gs.json'));
const INI = JSON.parse(FX('rows-inicis-card.json'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const adapter = (id) => C.SL_ADAPTERS.find((a) => a.id === id);

test('slDetectAdapter: gs / 이니시스 / 알 수 없음', () => {
  assert.equal(C.slDetectAdapter(GS[0]).id, 'gs');
  assert.equal(C.slDetectAdapter(INI[0]).id, 'cafe24-inicis-card');
  assert.equal(C.slDetectAdapter(['a', 'b']), null);
  assert.equal(C.slDetectAdapter(null), null);
});

test('slParseFile: 이니시스 7행·반품 1행·첫 행/외1건 금액', () => {
  const p = C.slParseFile(INI);
  assert.equal(p.ok, true);
  assert.equal(p.adapter.id, 'cafe24-inicis-card');
  assert.equal(p.rows.length, 7);
  assert.equal(p.rows.filter((r) => r.isReturn).length, 1);
  const ret = p.rows.find((r) => r.isReturn);
  assert.equal(ret.amount, -177685);
  assert.equal(p.rows[0].key, 89996);
  assert.equal(p.rows[0].amount, 89996);
  assert.equal(p.rows[0].qty, null);
  assert.equal(p.rows[0].phone, '');
  const multi = p.rows.find((r) => /외1건$/.test(r.name));
  assert.equal(multi.amount, 5365);
});

test('slParseFile: 합계 불일치·합계 행 없음·알 수 없는 양식', () => {
  const bad = clone(INI);
  bad[bad.length - 1][bad[0].indexOf('지급액')] = '1,637,224';
  assert.deepEqual(C.slParseFile(bad), { ok: false, error: '검산 불일치' });
  const noTot = clone(INI).slice(0, -1);
  assert.equal(C.slParseFile(noTot).ok, false);
  assert.deepEqual(C.slParseFile([['a', 'b']]), { ok: false, error: '알 수 없는 파일 양식' });
  const nonInt = clone(INI);
  nonInt[1][nonInt[0].indexOf('지급액')] = 'abc';
  assert.equal(C.slParseFile(nonInt).ok, false);
});

test('slParseFile: GS 는 기존 계산과 같다', () => {
  const p = C.slParseFile(GS);
  assert.equal(p.ok, true);
  assert.equal(p.adapter.id, 'gs');
  assert.equal(p.rows.length, 18);
  assert.equal(p.rows[0].amount, 28396);
  assert.equal(p.rows[0].key, 29400);
  assert.equal(p.rows[0].qty, 1);
  const ref = C.slComputeFinals(C.slParseSheet(GS));
  assert.deepEqual(p.rows.map((r) => r.isReturn), ref.rows.map((r) => C.slIsReturn(r)));
});

test('slGroupByClient: 이니시스 반품 제외 6묶음, 키 가명/카', () => {
  const p = C.slParseFile(INI);
  const g = C.slGroupByClient(p.rows, p.adapter);
  assert.equal(g.length, 6);
  assert.ok(g.every((x) => /^고객[A-G]\/카$/.test(x.key)));
  assert.ok(g.every((x) => /^고객[A-G]$/.test(x.buyer)));
  assert.ok(!g.some((x) => x.key === '고객D/카'));
});

test('slGroupByClient: 같은 구매자 여러 결제는 한 묶음', () => {
  const ad = adapter('cafe24-inicis-card');
  const mk = (n, a) => ({ orderNo: n, buyer: '홍', phone: '', key: a, amount: a, isReturn: false });
  const g = C.slGroupByClient([mk('1', 10), mk('2', 20)], ad);
  assert.equal(g.length, 1);
  assert.equal(g[0].rows.length, 2);
});

test('slClientCandidates: prefix4 만 통과, 정규식 특수문자 안전', () => {
  const ad = adapter('cafe24-inicis-card');
  const hits = [{ seq: 1, name: '홍길동1234/카' }, { seq: 2, name: '홍길동/임나영' }, { seq: 3, name: '홍길동12340/카' }, { seq: 4, name: '홍길동1234/아' }];
  assert.deepEqual(C.slClientCandidates(hits, { buyer: '홍길동', key: '홍길동/카' }, ad), [hits[0]]);
  const sp = [{ seq: 1, name: '김(a)1234/카' }, { seq: 2, name: '김a1234/카' }];
  assert.deepEqual(C.slClientCandidates(sp, { buyer: '김(a)', key: '김(a)/카' }, ad), [sp[0]]);
  const gs = adapter('gs');
  assert.deepEqual(C.slClientCandidates([{ seq: 1, name: 'A1234/G' }, { seq: 2, name: 'B1234/G' }], { key: 'A1234/G' }, gs), [{ seq: 1, name: 'A1234/G' }]);
});

test('slAllocateByWeight', () => {
  assert.deepEqual(C.slAllocateByWeight(5365, [18000, 50000]), [1421, 3944]);
  assert.equal(C.slAllocateByWeight(100, [0, 0]), null);
});

/* ---- perOrder 매칭 ---- */
const ord = (o) => Object.assign({ date: '26-09-11', barcode: '', code: 'C-X1-A-BB-CC-0001', name: '상품', gift: false, settle: null, qty: 1, price: 0 }, o);
const row = (key, extra) => Object.assign({ orderNo: 'N' + key, key, amount: key, qty: null }, extra);

test('perOrder (a) 같은 정산 2줄 → 주문가 비율 배분', () => {
  const orders = [ord({ barcode: '25AAAA', code: 'C-A', settle: 5365, price: 18000 }), ord({ barcode: '25BBBB', code: 'C-B', settle: 5365, price: 50000 })];
  const m = C.slMatchClient([row(5365, { name: 'Silver925퓨어컷팅반지외1건' })], orders, [], 'perOrder');
  assert.equal(m.status, 'ok');
  assert.deepEqual(m.lines.map((l) => l.amount), [1421, 3944]);
  assert.equal(m.cash, 5365);
});

test('perOrder (b) 같은 주문일 사은품은 0원 포함', () => {
  const orders = [ord({ barcode: '25AAAA', code: 'C-A', settle: 5365, price: 18000 }), ord({ barcode: '25BBBB', code: 'C-B', settle: 5365, price: 50000 }),
    ord({ barcode: '25GGGG', gift: true, date: '26-09-11' }), ord({ barcode: '25HHHH', gift: true, date: '26-01-01' })];
  const m = C.slMatchClient([row(5365, { name: '반지외1건' })], orders, [], 'perOrder');
  assert.equal(m.status, 'ok');
  assert.equal(m.lines.length, 3);
  assert.deepEqual(m.lines[2], { barcode: '25GGGG', code: 'C-X1-A-BB-CC-0001', name: '상품', gift: true, orderNo: '', amount: 0 });
  assert.equal(m.cash, 5365);
});

test('perOrder (c) 정산 줄이 이미 판매 → sold', () => {
  const orders = [ord({ barcode: '25AAAA', settle: 5365, price: 18000 })];
  const m = C.slMatchClient([row(5365)], orders, [{ barcode: '25AAAA' }], 'perOrder');
  assert.equal(m.status, 'sold');
});

test('perOrder (d) 정산 일치 줄 0 → block', () => {
  const m = C.slMatchClient([row(5365)], [ord({ barcode: '25AAAA', settle: 111, price: 1 })], [], 'perOrder');
  assert.equal(m.status, 'block');
  assert.match(m.reason, /정산 5,365 주문 줄 없음/);
});

test('perOrder (e) 바코드 없는 줄 → block', () => {
  const m = C.slMatchClient([row(5365)], [ord({ barcode: '', settle: 5365, price: 100 })], [], 'perOrder');
  assert.equal(m.status, 'block');
  assert.match(m.reason, /바코드 없는 주문 줄/);
});

test('perOrder (f) 같은 고객 두 결제가 같은 key → block', () => {
  const orders = [ord({ barcode: '25AAAA', settle: 5365, price: 100 })];
  const m = C.slMatchClient([row(5365, { orderNo: 'A' }), row(5365, { orderNo: 'B' })], orders, [], 'perOrder');
  assert.equal(m.status, 'block');
  assert.match(m.reason, /같은 정산 5,365 결제가 2건 — 어느 줄인지 모름/);
});

test('perOrder: 가중치 합 0 → block, 서로 다른 key 두 결제는 각자 매칭', () => {
  const z = C.slMatchClient([row(100)], [ord({ barcode: '25AAAA', settle: 100, price: 0 })], [], 'perOrder');
  assert.equal(z.status, 'block');
  const orders = [ord({ barcode: '25AAAA', settle: 100, price: 1 }), ord({ barcode: '25BBBB', settle: 200, price: 1 })];
  const m = C.slMatchClient([row(100), row(200)], orders, [], 'perOrder');
  assert.equal(m.status, 'ok');
  assert.equal(m.cash, 300);
});

test('perOrder (h) 같은 정산이 서로 다른 주문일에 걸치면 block', () => {
  const orders = [ord({ barcode: '25AAAA', code: 'C-A', settle: 5365, price: 1, date: '26-09-11' }), ord({ barcode: '25BBBB', code: 'C-B', settle: 5365, price: 1, date: '26-09-12' })];
  const m = C.slMatchClient([row(5365, { name: '반지외1건' })], orders, [], 'perOrder');
  assert.equal(m.status, 'block');
  assert.equal(m.reason, '정산 5,365 줄이 여러 주문일(26-09-11, 26-09-12)에 걸침 — 직접 처리');
});

test('perOrder (i) 외N건 없는데 code 2종 → block, 같은 code 2줄(수량)은 ok', () => {
  const two = [ord({ barcode: '25AAAA', code: 'C-A', settle: 5365, price: 1 }), ord({ barcode: '25BBBB', code: 'C-B', settle: 5365, price: 1 })];
  const m = C.slMatchClient([row(5365, { name: '반지' })], two, [], 'perOrder');
  assert.equal(m.status, 'block');
  assert.equal(m.reason, '상품 수 불일치(파일 1종 · 주문 줄 2종) — 직접 처리');
  const same = [ord({ barcode: '25AAAA', code: 'C-A', settle: 5365, price: 1 }), ord({ barcode: '25BBBB', code: 'C-A', settle: 5365, price: 1 })];
  assert.equal(C.slMatchClient([row(5365, { name: '반지' })], same, [], 'perOrder').status, 'ok');
  assert.equal(C.slMatchClient([row(5365, { name: '반지외2건' })], two, [], 'perOrder').status, 'block');
});

test('slOverlaps: ok 묶음끼리 같은 바코드면 양쪽 모두, 다른 고객이어도', () => {
  const E = (key, seq, st, bcs) => ({ key, client: { seq }, st, match: { lines: bcs.map((barcode) => ({ barcode })) } });
  const set = C.slOverlaps([E('a', 1, 'ok', ['X1', 'X2']), E('b', 2, 'ok', ['X2']), E('c', 3, 'ok', ['Y1']), E('d', 4, 'block', ['X1']), E('e', 1, 'ok', ['Z1'])]);
  assert.deepEqual([...set].sort(), ['a', 'b']);
  assert.equal(C.slOverlaps([]).size, 0);
});

test('slAutoDecision prefix4: 0 · 1 · 2 후보 · 잘림', () => {
  const ad = adapter('cafe24-inicis-card'), g = { buyer: '홍길동', key: '홍길동/카' };
  const h1 = { seq: 1, name: '홍길동1234/카' }, h2 = { seq: 2, name: '홍길동2345/카' };
  assert.deepEqual(C.slAutoDecision({ hits: [h1], truncated: false }, g, ad).auto, { seq: '1', name: '홍길동1234/카' });
  assert.equal(C.slAutoDecision({ hits: [], truncated: false }, g, ad).auto, null);
  assert.match(C.slAutoDecision({ hits: [], truncated: false }, g, ad).reason, /고객이 없음/);
  const two = C.slAutoDecision({ hits: [h1, h2], truncated: false }, g, ad);
  assert.equal(two.auto, null); assert.match(two.reason, /2명/);
  const tr = C.slAutoDecision({ hits: [h1], truncated: true }, g, ad);
  assert.equal(tr.auto, null); assert.equal(tr.reason, '검색 결과가 100건 이상 — 직접 고르세요');
});

test('slAutoDecision exact(GS): 0 · 1 · 2 후보 · 잘림', () => {
  const ad = adapter('gs'), g = { key: 'A1234/G' };
  const h = { seq: 5, name: 'A1234/G' };
  assert.deepEqual(C.slAutoDecision({ hits: [h], truncated: false }, g, ad).auto, { seq: '5', name: 'A1234/G' });
  assert.equal(C.slAutoDecision({ hits: [], truncated: false }, g, ad).auto, null);
  assert.equal(C.slAutoDecision({ hits: [h, { seq: 6, name: 'A1234/G' }], truncated: false }, g, ad).auto, null);
  assert.equal(C.slAutoDecision({ hits: [h], truncated: true }, g, ad).auto, null);
});

test('slMatchClient 기본 모드는 perUnit (GS 동작 유지)', () => {
  const r = { orderNo: '1', W: 1000, qty: 1, amount: 900 };
  const m = C.slMatchClient([r], [ord({ barcode: '25AAAA', settle: 1000 })], []);
  assert.equal(m.status, 'ok');
  assert.equal(m.lines[0].amount, 900);
});

test('perOrder (g) 같은 정산 줄 일부만 판매됨 → 나머지에 전액 배분하지 않고 block', () => {
  const orders = [ord({ barcode: '25AAAA', settle: 5365, price: 18000 }), ord({ barcode: '25BBBB', settle: 5365, price: 50000 })];
  const m = C.slMatchClient([row(5365)], orders, [{ barcode: '25AAAA' }], 'perOrder');
  assert.equal(m.status, 'block');
  assert.equal(m.reason, '정산 5,365 결제 일부만 판매됨 — 직접 처리');
  assert.deepEqual(m.lines, []);
});

test('slAllocateByWeight: 음수·NaN·무한 가중치 → null', () => {
  assert.equal(C.slAllocateByWeight(100, [10, -5]), null);
  assert.equal(C.slAllocateByWeight(100, [10, NaN]), null);
  assert.equal(C.slAllocateByWeight(100, [10, Infinity]), null);
  assert.deepEqual(C.slAllocateByWeight(100, [1, 1]), [50, 50]);
});

test('slParseFile: GS 행은 perUnit 매칭에 쓰는 W 를 가진다', () => {
  const p = C.slParseFile(GS);
  assert.equal(p.rows[0].W, 29400);
});

/* ---- Task 10: SSG · 스마트스토어 어댑터 (스펙 §10.5·§10.6) ---- */
const SSG = JSON.parse(FX('rows-ssg.json'));
const SMART = JSON.parse(FX('rows-smartstore.json'));

test('SSG: 판별·파싱 2행, key 179,550 / 30,800, orderNo 주문ID-주문순번, 반품 없음', () => {
  assert.equal(C.slDetectAdapter(SSG[0]).id, 'ssg-settle');
  const p = C.slParseFile(SSG);
  assert.equal(p.ok, true);
  assert.equal(p.adapter.id, 'ssg-settle');
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.rows.map((r) => r.key), [179550, 30800]);
  assert.deepEqual(p.rows.map((r) => r.amount), [179550, 30800]);
  assert.deepEqual(p.rows.map((r) => r.qty), [1, 1]);
  assert.deepEqual(p.rows.map((r) => r.orderNo), ['2026090377011A-1', '202609149D739D-1']);
  assert.ok(p.rows.every((r) => !r.isReturn && r.phone === ''));
  assert.deepEqual(p.rows.map((r) => r.buyer), ['고객A', '고객B']);
  assert.equal(p.adapter.suffix, 's');
  assert.equal(p.adapter.clientRule, 'prefix4');
  assert.equal(p.adapter.matchMode, 'perUnit');
});

test('SSG: 수량<0 또는 정산금액<0 → 반품, 정산금액 못 읽으면 파일 거부', () => {
  const h = SSG[0], q = h.indexOf('수량'), k = h.indexOf('정산금액(VAT포함)');
  const neg = clone(SSG); neg[1][q] = '-1';
  assert.equal(C.slParseFile(neg).rows[0].isReturn, true);
  const neg2 = clone(SSG); neg2[1][k] = '-179,550';
  assert.equal(C.slParseFile(neg2).rows[0].isReturn, true);
  const bad = clone(SSG); bad[1][k] = 'abc';
  assert.equal(C.slParseFile(bad).ok, false);
});

test('SSG prefix4: 접미 s 는 대소문자 무시(/s·/S 통과, /스 거부)', () => {
  const ad = adapter('ssg-settle'), g = { buyer: '고객A', key: '고객A/s' };
  const hits = [{ seq: 1, name: '고객A1234/s' }, { seq: 2, name: '고객A1234/S' }, { seq: 3, name: '고객A1234/스' }, { seq: 4, name: '고객A12345/s' }];
  assert.deepEqual(C.slClientCandidates(hits, g, ad).map((h) => h.seq), [1, 2]);
});

test('스마트스토어: 판별·파싱 1행, key=A+B+C+D=146,718, qty 1, orderNo=상품주문번호', () => {
  assert.equal(C.slDetectAdapter(SMART[0]).id, 'smartstore-daily');
  const p = C.slParseFile(SMART);
  assert.equal(p.ok, true);
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].key, 146718);
  assert.equal(p.rows[0].amount, 146718);
  assert.equal(p.rows[0].qty, 1);
  assert.equal(p.rows[0].orderNo, '2026060281350531');
  assert.equal(p.rows[0].buyer, '고객A');
  assert.equal(p.rows[0].isReturn, false);
  assert.equal(p.adapter.suffix, '스');
  assert.equal(p.adapter.matchMode, 'perUnit');
  assert.deepEqual(C.slGroupByClient(p.rows, p.adapter).map((g) => g.key), ['고객A/스']);
});

test('스마트스토어: D 열 없으면 0, 빈칸은 0, 숫자 아님 → 파일 거부, A<0 → 반품', () => {
  const dCol = SMART[0].indexOf('무이자할부 수수료(D)');
  const noD = clone(SMART).map((r) => r.filter((_, j) => j !== dCol));
  assert.equal(C.slParseFile(noD).rows[0].key, 146718);
  const blank = clone(SMART); blank[1][SMART[0].indexOf('Npay 수수료(B)')] = ''; blank[1][dCol] = '';
  assert.equal(C.slParseFile(blank).rows[0].key, 156800 - 4562);
  const bad = clone(SMART); bad[1][SMART[0].indexOf('매출연동 수수료 합계(C)')] = 'x';
  assert.equal(C.slParseFile(bad).ok, false);
  const ret = clone(SMART); ret[1][SMART[0].indexOf('정산기준금액(A)')] = '-156800';
  assert.equal(C.slParseFile(ret).rows[0].isReturn, true);
});

test('스마트스토어: 구분≠상품주문 행은 수동 처리 목록(isReturn) 으로 제외', () => {
  const rows = clone(SMART);
  const extra = rows[1].slice(); extra[SMART[0].indexOf('구분')] = '배송비'; extra[SMART[0].indexOf('상품주문번호')] = '9999';
  rows.push(extra);
  const p = C.slParseFile(rows);
  assert.equal(p.ok, true);
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.rows.map((r) => r.isReturn), [false, true]);
  assert.equal(C.slGroupByClient(p.rows, p.adapter).length, 1);
});

test('판별: 헤더가 어느 어댑터에도 안 맞거나 둘 이상 맞으면 거부', () => {
  assert.equal(C.slDetectAdapter(['상품주문번호', '구분']), null);
  assert.deepEqual(C.slParseFile([['상품주문번호', '구분'], ['1', '2']]), { ok: false, error: '알 수 없는 파일 양식' });
  //  GS 헤더 + 이니시스 헤더를 함께 가진 파일 (Nit-1)
  const both = GS[0].concat(INI[0]);
  assert.equal(C.slDetectAdapter(both), null);
  assert.deepEqual(C.slParseFile([both, both.map(() => '1')]), { ok: false, error: '알 수 없는 파일 양식' });
  //  SSG + 스마트스토어 혼합도 거부
  assert.equal(C.slDetectAdapter(SSG[0].concat(SMART[0])), null);
});

/* ---- Task 10: T3 차단 규칙 (스펙 §10.7) ---- */
test('perOrder: 외1건 묶음을 같은 날 두 번 산 경우(4줄·2종) → block', () => {
  const orders = [ord({ barcode: '25AAA1', code: 'C-A', settle: 5365, price: 1 }), ord({ barcode: '25BBB1', code: 'C-B', settle: 5365, price: 1 }),
    ord({ barcode: '25AAA2', code: 'C-A', settle: 5365, price: 1 }), ord({ barcode: '25BBB2', code: 'C-B', settle: 5365, price: 1 })];
  const m = C.slMatchClient([row(5365, { name: '반지외1건' })], orders, [], 'perOrder');
  assert.equal(m.status, 'block');
  assert.match(m.reason, /상품 수 불일치/);
});

test('perOrder: 외N건 은 줄 수 N+1 · 상품번호 모두 달라야 ok, N=0 은 같은 상품 여러 줄 허용', () => {
  const ok = [ord({ barcode: '25AAA1', code: 'C-A', settle: 5365, price: 1 }), ord({ barcode: '25BBB1', code: 'C-B', settle: 5365, price: 1 })];
  assert.equal(C.slMatchClient([row(5365, { name: '반지외1건' })], ok, [], 'perOrder').status, 'ok');
  //  외1건인데 같은 상품 2줄(종 1) → block
  const same = [ord({ barcode: '25AAA1', code: 'C-A', settle: 5365, price: 1 }), ord({ barcode: '25AAA2', code: 'C-A', settle: 5365, price: 1 })];
  assert.equal(C.slMatchClient([row(5365, { name: '반지외1건' })], same, [], 'perOrder').status, 'block');
  //  N=0 단일 상품 3줄(수량) → ok
  const qty = ['25AAA1', '25AAA2', '25AAA3'].map((b) => ord({ barcode: b, code: 'C-A', settle: 5365, price: 1 }));
  assert.equal(C.slMatchClient([row(5365, { name: '반지' })], qty, [], 'perOrder').status, 'ok');
});

test('perOrder: 열린 본품 줄 중 code 가 빈 줄이 있으면 block', () => {
  const empty1 = [ord({ barcode: '25AAA1', code: '', settle: 5365, price: 1 })];
  const m1 = C.slMatchClient([row(5365, { name: '반지' })], empty1, [], 'perOrder');
  assert.equal(m1.status, 'block');
  assert.match(m1.reason, /상품번호/);
  const mixed = [ord({ barcode: '25AAA1', code: 'C-A', settle: 5365, price: 1 }), ord({ barcode: '25BBB1', code: '', settle: 5365, price: 1 })];
  const m2 = C.slMatchClient([row(5365, { name: '반지외1건' })], mixed, [], 'perOrder');
  assert.equal(m2.status, 'block');
  assert.match(m2.reason, /상품번호/);
});

test('slOrderRows: 비고에 취소가 든 줄은 cancel:true', () => {
  const html = FX('trade-order-gift.html');
  assert.ok(C.slOrderRows(html).every((o) => o.cancel === false));
  const mod = html.replace('<span class="f_green">정산 389,900</span>', '<span class="f_green">정산 389,900</span><br>정계약 취소');
  assert.notEqual(mod, html);
  const o = C.slOrderRows(mod);
  assert.equal(o.find((x) => !x.gift).cancel, true);
  assert.equal(o.find((x) => x.gift).cancel, false);
});

test('취소 줄이 후보에 섞이면 perUnit·perOrder 모두 block', () => {
  const orders = [ord({ barcode: '25AAA1', settle: 1000, price: 1, cancel: true })];
  const pu = C.slMatchClient([{ orderNo: '1', W: 1000, qty: 1, amount: 900 }], orders, []);
  assert.equal(pu.status, 'block'); assert.match(pu.reason, /취소/);
  const po = C.slMatchClient([row(1000, { name: '반지' })], orders, [], 'perOrder');
  assert.equal(po.status, 'block'); assert.match(po.reason, /취소/);
  //  취소 표시가 없으면 ok
  const clean = [ord({ barcode: '25AAA1', settle: 1000, price: 1, cancel: false })];
  assert.equal(C.slMatchClient([{ orderNo: '1', W: 1000, qty: 1, amount: 900 }], clean, []).status, 'ok');
  assert.equal(C.slMatchClient([row(1000, { name: '반지' })], clean, [], 'perOrder').status, 'ok');
});

test('slSearchResult: 첫 행 No 가 받은 행 수보다 크면 잘림(5 > 4), 100건 이상도 잘림', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'orderimport', 'client-search.html'), 'utf8').replace(/\r\n/g, '\n');
  const r = C.slSearchResult(html);
  assert.equal(r.rows.length, 4);
  assert.deepEqual(r.rows[1], { seq: '123752', name: '가나다3269/카', phone: '' });
  assert.equal(r.truncated, true);
  //  No 가 받은 행 수와 같으면 잘리지 않음
  const ok = html.replace('<td height="28">5</td>', '<td height="28">4</td>');
  assert.notEqual(ok, html);
  assert.equal(C.slSearchResult(ok).truncated, false);
  //  행 100개 이상
  const row1 = html.match(/<tr align="center"[^\n]*<\/tr>/)[0];
  const big = html.replace(row1, new Array(100).fill(row1.replace('<td height="28">5</td>', '<td height="28">103</td>')).join('\n'));
  assert.equal(C.slSearchResult(big).rows.length, 103);
  assert.equal(C.slSearchResult(big).truncated, true);
  assert.deepEqual(C.slSearchResult('<html><body>검색된 결과가 없습니다.</body></html>'), { rows: [], truncated: false });
});

/* ---- Task 10: 실행 결과 반영 — done 묶음은 st='done' (스펙 §10.7) ---- */
test('slApplyResults: done → st=done · checked 해제, skipped 는 그대로 재시도 가능, fatal 은 체크만 해제', () => {
  const E = (key) => ({ key, st: 'ok', checked: true, result: null });
  const es = [E('a'), E('b'), E('c'), E('d')];
  C.slApplyResults(es, [{ key: 'a', status: 'done' }, { key: 'b', status: 'skipped' }, { key: 'c', status: 'fatal' }, { key: 'd', status: 'blocked' }, { key: 'zzz', status: 'done' }]);
  assert.deepEqual(es.map((e) => e.st), ['done', 'ok', 'ok', 'ok']);
  assert.deepEqual(es.map((e) => e.checked), [false, true, false, true]);
  assert.deepEqual(es.map((e) => e.result && e.result.status), ['done', 'skipped', 'fatal', 'blocked']);
});

test('SSG·스마트스토어 행은 perUnit 매칭에 바로 쓸 수 있다(정산 = key, 줄 금액 = 정산금액)', () => {
  for (const [rows, i, settle] of [[SSG, 0, 179550], [SSG, 1, 30800], [SMART, 0, 146718]]) {
    const p = C.slParseFile(rows);
    const m = C.slMatchClient([p.rows[i]], [ord({ barcode: '25AAAA', settle })], [], p.adapter.matchMode);
    assert.equal(m.status, 'ok', rows === SSG ? 'ssg' : 'smart');
    assert.deepEqual(m.lines.map((l) => l.amount), [settle]);
    assert.equal(m.cash, settle);
  }
});
