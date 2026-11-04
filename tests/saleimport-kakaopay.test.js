/* saleimport 카페24 카카오페이 건별 정산내역 어댑터 테스트. 스펙 §10.11. 픽스처는 전부 가명·가짜 번호.
 * 실행: node --test tests/saleimport-kakaopay.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'src', 'saleimport-core.js'));

const HEAD = ['결제일', '가맹점코드(CID)', '결제상태', '결제세부상태', '결제수단', '기관', '가맹점주문번호', '결제번호(TID)', '개별결제번호(AID)', '총 결제금액', 'PG 수수료', '무이자 수수료', '환불대행 수수료', '수수료 VAT', '입금설명', '입금예정금액', '입금예정일자'];
//  한 행 — fee·vat 는 실측처럼 3.5%·10%, pay 는 총 결제금액 − 수수료들.
const K = (no, gross, status, sub, o) => {
  const x = Object.assign({ fee: Math.trunc(gross * 0.035), free: 0, refund: '', vat: null, pay: null }, o || {});
  const vat = x.vat == null ? Math.trunc(x.fee / 10) : x.vat;
  const pay = x.pay == null ? gross - x.fee - x.free - (Number(x.refund) || 0) - vat : x.pay;
  return [46290, 'CID', status, sub, '간편결제-카드', '-', no, 'T' + no, 'A' + no, gross, x.fee, x.free, x.refund, vat, '매장', pay, 46303];
};
const SALE = (no, gross, o) => K(no, gross, '결제', '일시불결제', o);
const CANCEL = (no, gross, o) => K(no, gross, '취소', '전체취소', o);
const AD = () => C.SL_ADAPTERS.find((a) => a.id === 'cafe24-kakaopay');
const parse = (...rows) => C.slParseFile([HEAD].concat(rows));
//  원장 행 — 카페24 카카오페이는 줄마다 같은 amount(결제 전체 입금예정금액)가 붙는다(실측).
const LR = (no, amount, o) => Object.assign({ order_no: no, market: '카페24', recipient: '고객가', phone: '010-0000-1234', product: '반지', opt: '', amount, is_gift: false, status: '접수', order_date: '2026-09-25' }, o || {});
const O = (o) => Object.assign({ date: '26-09-25', barcode: '2609A1', code: 'R-14-A-AA-AA-0001', name: '반지', gift: false, settle: 380754, qty: 1, price: 200000, cancel: false }, o || {});

test('판별: 카카오페이 헤더는 카카오페이 어댑터 하나로만 잡힌다', () => {
  assert.equal(C.slDetectAdapter(HEAD).id, 'cafe24-kakaopay');
  const a = AD();
  assert.equal(a.suffix, '카');
  assert.equal(a.clientRule, 'ledger');
  assert.equal(a.matchMode, 'perOrder');
  assert.equal(a.ledgerMarket, '카페24');
  assert.ok(!a.ledgerMatch, '줄 매칭은 원장이 아니라 결제 단위');
  assert.equal(C.slDetectAdapter(HEAD.filter((h) => h !== '입금예정금액')), null);
  assert.equal(C.slDetectAdapter(HEAD.filter((h) => h !== '가맹점주문번호')), null);
});

test('파싱: 실측 금액 규칙 — key = amount = 입금예정금액, 원장 번호 = 가맹점주문번호, 구매자 없음', () => {
  const p = parse(SALE('20260101-0000001', 396000, { fee: 13860, vat: 1386 }));
  assert.equal(p.ok, true);
  const r = p.rows[0];
  assert.equal(r.amount, 380754);
  assert.equal(r.key, 380754);
  assert.equal(r.orderNo, '20260101-0000001');
  assert.equal(r.ledgerNo, '20260101-0000001');
  assert.equal(r.buyer, '');
  assert.equal(r.isReturn, false);
});

test('파싱: 입금예정금액 검산(총 결제금액 − PG·무이자·환불대행 수수료 − VAT)이 어긋나면 파일 거부', () => {
  const bad = parse(SALE('20260101-0000001', 396000, { fee: 13860, vat: 1386, pay: 380755 }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /20260101-0000001.*검산 불일치/);
  //  무이자·환불대행 수수료도 뺀다 — 빈칸은 0
  assert.equal(parse(SALE('20260101-0000002', 100000, { fee: 3500, free: 1000, refund: 200, vat: 350 })).rows[0].amount, 94950);
});

test('파싱: 금액을 못 읽으면 조용히 0 으로 두지 않고 파일 거부', () => {
  const row = SALE('20260101-0000001', 100000);
  row[HEAD.indexOf('입금예정금액')] = '';
  assert.match(parse(row).error, /입금예정금액/);
  const r2 = SALE('20260101-0000001', 100000);
  r2[HEAD.indexOf('PG 수수료')] = '#REF!';
  assert.match(parse(r2).error, /PG 수수료/);
  const r3 = SALE('', 100000);
  assert.match(parse(r3).error, /가맹점주문번호/);
});

test('파싱: 취소·그 밖의 결제상태·0원 이하 결제는 판매 행이 아니라 수동 목록', () => {
  const p = parse(CANCEL('20260101-0000001', -4000, { fee: -140, vat: -14 }), K('20260101-0000002', 5000, '승인대기', '-'), K('20260101-0000003', 0, '결제', '일시불결제'));
  assert.equal(p.ok, true);
  assert.deepEqual(p.rows.map((r) => r.isReturn), [true, true, true]);
  assert.equal(C.slClassifyRows(p.rows).manual[0].kind, '전체취소');
  assert.equal(C.slClassifyRows(p.rows).manual[1].kind, '승인대기');
});

test('전체취소: 같은 파일의 결제+취소 쌍은 전부 반품 — 원장에 없어도 사유는 전부 반품, 직접 고르기 불가', () => {
  const no = '20260101-0000001';
  const p = parse(CANCEL(no, -4000, { fee: -140, vat: -14 }), SALE(no, 4000, { fee: 140, vat: 14 }));
  const manual = C.slClassifyRows(p.rows).manual;
  assert.equal(manual.length, 1);
  assert.equal(manual[0].kind, '전부 반품');
  const g = C.slGroupLedger(p.rows, p.adapter, C.slLedgerIndex([], '카페24'));
  assert.equal(g.length, 1);
  assert.match(g[0].block, /전부 반품된 주문/);
  assert.equal(g[0].pickable, false);
});

test('부분취소: 합이 0 이 아니면 판매 행을 처음부터 차단(취소 전 전액으로 판매 금지)', () => {
  const no = '20260101-0000001';
  const p = parse(SALE(no, 100000, { fee: 3500, vat: 350 }), K(no, -30000, '취소', '부분취소', { fee: -1050, vat: -105 }));
  const g = C.slGroupLedger(p.rows, p.adapter, C.slLedgerIndex([LR(no, 96150)], '카페24'));
  assert.equal(g.length, 1);
  assert.match(g[0].block, /부분취소/);
  assert.equal(g[0].pickable, false);
  assert.equal(g[0].ledger.size, 0, '원장 묶음으로 넘어가지 않는다');
  assert.ok(!/시각/.test(g[0].key), '다른 사유의 이름표를 쓰지 않는다');
  assert.equal(C.slClassifyRows(p.rows).manual[0].kind, '부분취소');
});

test('취소 뒤 같은 번호 재결제(+ − +)도 합이 0 이 아니라 차단', () => {
  const no = '20260101-0000001';
  const p = parse(SALE(no, 4000, { fee: 140, vat: 14 }), CANCEL(no, -4000, { fee: -140, vat: -14 }), SALE(no, 4000, { fee: 140, vat: 14 }));
  const g = C.slGroupLedger(p.rows, p.adapter, C.slLedgerIndex([LR(no, 3846)], '카페24'));
  assert.ok(g.every((x) => /부분취소|직접 처리/.test(x.block) && x.pickable === false));
});

test('같은 번호의 결제가 2건이면(금액이 달라도 같아도) 판매 행 전부 처음부터 차단 — 직접 고르기 불가', () => {
  const no = '20260101-0000001';
  [[100000, 200000], [100000, 100000]].forEach(([a, b]) => {
    const p = parse(SALE(no, a, { fee: 3500, vat: 350 }), SALE(no, b, { fee: 7000, vat: 700 }));
    const g = C.slGroupLedger(p.rows, p.adapter, C.slLedgerIndex([LR(no, 96150)], '카페24'));
    assert.equal(g.length, 1);
    assert.equal(g[0].rows.length, 2);
    assert.match(g[0].block, /결제가 2건/);
    assert.equal(g[0].pickable, false);
    assert.equal(g[0].ledger.size, 0);
  });
  //  번호가 다르면 그대로 — 고객의 두 결제는 정상
  const ok = parse(SALE(no, 100000, { fee: 3500, vat: 350 }), SALE('20260101-0000002', 200000, { fee: 7000, vat: 700 }));
  assert.ok(ok.rows.every((r) => !r.ledgerBlock));
});

test('원장 묶음: 고객명 = 수령자+뒤4/카, 원장에 없거나 취소면 차단(이름 폴백 없음)', () => {
  const p = parse(SALE('20260101-0000001', 396000, { fee: 13860, vat: 1386 }), SALE('20260101-0000002', 16200, { fee: 567, vat: 57 }));
  const idx = C.slLedgerIndex([LR('20260101-0000001', 380754)], '카페24');
  const g = C.slGroupLedger(p.rows, p.adapter, idx);
  const hit = g.find((x) => x.ledger.size), miss = g.find((x) => !x.ledger.size);
  assert.equal(hit.key, '고객가1234/카');
  assert.equal(hit.source, '원장');
  assert.equal(hit.block, '');
  assert.match(miss.block, /원장에 없는 주문/);
  const cancelled = C.slGroupLedger(parse(SALE('20260101-0000001', 396000, { fee: 13860, vat: 1386 })).rows, AD(), C.slLedgerIndex([LR('20260101-0000001', 380754, { status: '취소' })], '카페24'));
  assert.match(cancelled[0].block, /취소/);
  //  다른 마켓의 같은 번호는 쓰지 않는다 · 조회 실패는 전부 차단
  assert.match(C.slGroupLedger(p.rows, p.adapter, C.slLedgerIndex([LR('20260101-0000001', 380754, { market: '쿠팡' })], '카페24'))[0].block, /원장에 없는 주문/);
  assert.ok(C.slGroupLedger(p.rows, p.adapter, null, { lookupFailed: true }).every((x) => /원장 조회 실패/.test(x.block)));
});

test('상품 수는 원장에서: 파일에 상품명이 없어도 2종 주문이 perOrder 로 맞고, 금액은 주문가 비율', () => {
  const no = '20260101-0000001';
  const p = parse(SALE(no, 396000, { fee: 13860, vat: 1386 }));
  const g = C.slGroupLedger(p.rows, p.adapter, C.slLedgerIndex([LR(no, 380754, { product: '큐 반지' }), LR(no, 380754, { product: '컷팅 반지' })], '카페24'));
  assert.equal(g[0].rows[0].name, '큐 반지 외1건');
  assert.equal(p.rows[0].name, '', '파싱 행은 그대로 — 파일을 다시 묶어도 이름이 쌓이지 않는다');
  const orders = [O({ barcode: '2609A1', code: 'R-14-A-AA-AA-0001', price: 300000 }), O({ barcode: '2609A2', code: 'R-14-A-AA-AA-0002', price: 100000 })];
  const m = C.slMatchClient(g[0].rows, orders, [], 'perOrder');
  assert.equal(m.status, 'ok');
  assert.deepEqual(m.lines.map((l) => l.amount), [285566, 95188]);
  assert.equal(m.cash, 380754);
});

test('상품 수 대조: 원장 3종인데 유비샵 줄이 2줄이면 차단 — 줄 직접 고르기는 가능', () => {
  const no = '20260101-0000001';
  const p = parse(SALE(no, 396000, { fee: 13860, vat: 1386 }));
  const g = C.slGroupLedger(p.rows, p.adapter, C.slLedgerIndex(['A', 'B', 'C'].map((x) => LR(no, 380754, { product: x })), '카페24'));
  const m = C.slMatchClient(g[0].rows, [O({ barcode: '2609A1', code: 'R-14-A-AA-AA-0001' }), O({ barcode: '2609A2', code: 'R-14-A-AA-AA-0002' })], [], 'perOrder');
  assert.equal(m.status, 'block');
  assert.equal(m.kind, 'line');
  assert.match(m.reason, /상품 수 불일치/);
});

test('상품 수: 사은품 원장 줄은 세지 않고, 같은 상품·옵션의 여러 줄은 한 종류(수량)', () => {
  const no = '20260101-0000001';
  const p = parse(SALE(no, 396000, { fee: 13860, vat: 1386 }));
  const g = C.slGroupLedger(p.rows, p.adapter, C.slLedgerIndex([LR(no, 380754), LR(no, 380754), LR(no, 0, { product: '가죽트레이', is_gift: true })], '카페24'));
  assert.equal(g[0].rows[0].name, '반지');
  const m = C.slMatchClient(g[0].rows, [O({ barcode: '2609A1', price: 100000 }), O({ barcode: '2609A2', price: 100000 })], [], 'perOrder');
  assert.equal(m.status, 'ok');
  assert.equal(m.lines.length, 2);
  const opt = C.slGroupLedger(p.rows, p.adapter, C.slLedgerIndex([LR(no, 380754, { opt: '10호' }), LR(no, 380754, { opt: '12호' })], '카페24'));
  assert.equal(opt[0].rows[0].name, '반지 외1건', '옵션이 다르면 다른 품목');
});

test('원장에 본품 줄이 없으면(전부 사은품) 처음부터 차단 — 빈 상품명이 1종으로 통과하지 않는다', () => {
  const no = '20260101-0000001';
  const p = parse(SALE(no, 396000, { fee: 13860, vat: 1386 }));
  const g = C.slGroupLedger(p.rows, p.adapter, C.slLedgerIndex([LR(no, 380754, { is_gift: true })], '카페24'));
  assert.equal(g.length, 1);
  assert.match(g[0].block, /본품 줄이 없음/);
  assert.equal(g[0].pickable, false);
  assert.equal(g[0].ledger.size, 0);
});

test('상품 수 근거: 줄바꿈으로 겹치는 품목도 2종으로 세고, 원장 본품 상품명이 비면 차단', () => {
  const no = '20260101-0000001';
  const p = parse(SALE(no, 396000, { fee: 13860, vat: 1386 }));
  const g = C.slGroupLedger(p.rows, p.adapter, C.slLedgerIndex([LR(no, 380754, { product: 'A', opt: 'B\nC' }), LR(no, 380754, { product: 'A\nB', opt: 'C' })], '카페24'));
  assert.equal(g[0].rows[0].name, 'A 외1건');
  const empty = C.slGroupLedger(p.rows, p.adapter, C.slLedgerIndex([LR(no, 380754, { product: '  ' }), LR(no, 380754)], '카페24'));
  assert.match(empty[0].block, /상품명이 없음/);
  assert.equal(empty[0].pickable, false);
});

test('이미 판매됨 · 사은품 0원 · 같은 고객 두 결제는 한 묶음(기존 perOrder 규칙 그대로)', () => {
  const a = '20260101-0000001', b = '20260101-0000002';
  const p = parse(SALE(a, 396000, { fee: 13860, vat: 1386 }), SALE(b, 16200, { fee: 567, vat: 57 }));
  const g = C.slGroupLedger(p.rows, p.adapter, C.slLedgerIndex([LR(a, 380754), LR(b, 15576)], '카페24'));
  assert.equal(g.length, 1, 'D6 — 고객 1명당 전표 1장');
  const orders = [O({ barcode: '2609A1' }), O({ barcode: '2609A2', settle: 15576, price: 20000 }), O({ barcode: '2609G1', name: '가죽트레이(사은품)', gift: true, settle: null })];
  const ok = C.slMatchClient(g[0].rows, orders, [], 'perOrder');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.cash, 380754 + 15576);
  assert.deepEqual(ok.lines.filter((l) => l.gift).map((l) => l.amount), [0]);
  const sold = C.slMatchClient(g[0].rows, orders, [{ barcode: '2609A1' }, { barcode: '2609A2' }], 'perOrder');
  assert.equal(sold.status, 'sold');
});

test('회귀: 다른 원장 어댑터 행의 상품명은 원장으로 덮어쓰지 않는다', () => {
  const cafe = C.SL_ADAPTERS.find((a) => a.id === 'cafe24-inicis-card');
  const row = { r: 1, orderNo: 'N1', ledgerNo: 'ORD00001', buyer: '고객가', phone: '', qty: null, key: 5000, amount: 5000, isReturn: false, name: '파일 상품명 외1건', option: '' };
  const g = C.slGroupLedger([row], cafe, C.slLedgerIndex([LR('ORD00001', 5000, { product: '원장 상품명' })], '카페24'));
  assert.equal(g[0].rows[0].name, '파일 상품명 외1건');
});
