/* saleimport-core 단위 테스트. 스펙: docs/superpowers/specs/2026-09-30-saleimport-design.md
 * 실행: node --test tests/saleimport-core.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'src', 'saleimport-core.js'));
//  autocrlf=true 체크아웃은 픽스처를 CRLF 로 쓴다 — 테스트의 '\n' 치환이 빗나가지 않게 LF 로 맞춘다.
const FX = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'saleimport', n), 'utf8').replace(/\r\n/g, '\n');
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

test('slOrderRows: 사은품 포함 2줄', () => {
  const o = C.slOrderRows(FX('trade-order-gift.html'));
  assert.equal(o.length, 2);
  const main = o.find((x) => !x.gift), gift = o.find((x) => x.gift);
  assert.deepEqual([main.barcode, main.settle, main.qty, main.price], ['2609E8', 389900, 1, 557000]);
  assert.deepEqual([gift.barcode, gift.settle, gift.price], ['2604PG', null, 1400]);
  assert.equal(main.date, gift.date);
});

test('slOrderRows: 수량 2 는 정산 259,000 줄 2개 + 사은품 1줄', () => {
  const o = C.slOrderRows(FX('trade-order-qty2.html'));
  assert.equal(o.length, 3);
  assert.deepEqual(o.filter((x) => !x.gift).map((x) => [x.barcode, x.settle, x.name]).sort(), [['2609RX', 259000, 'F-위스퍼샤인R'], ['2609RY', 259000, 'F-위스퍼샤인R']]);
  assert.deepEqual(o.filter((x) => x.gift).map((x) => x.barcode), ['2604P6']);
});

test('slOrderRows: 비고에 색상이 앞에 붙은 정산', () => {
  const o = C.slOrderRows(FX('trade-order-sold.html'));
  assert.deepEqual([o[0].barcode, o[0].settle, o[0].date, o[0].code], ['240CKK', 29400, '26-09-10', 'F-BF-Z-XX-ZZ-002Q']);
});

test('slSaleRows: 판매내역 바코드·실판매가, 빈 목록', () => {
  const s = C.slSaleRows(FX('trade-sale-sold.html'));
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].barcode, s[0].price, s[0].dc, s[0].amount], ['240CKK', 42000, 13604, 28396]);
  assert.deepEqual(C.slSaleRows(FX('trade-sale-empty.html')), []);
});

test('slTradeUrl', () => {
  const u = C.slTradeUrl('orderitem', '123734', '하*이3785/G');
  assert.match(u, /^\/info\/clienttrade\/infoClientTradeView\.do\?tcode=sale_item&vcode=orderitem&/);
  assert.match(u, /client=123734&/);
  assert.match(u, /clientName=%ED%95%98\*%EC%9D%B43785%2FG$/);
});

/* ---------------------------------------------------------------- Task 5: 판매 폼 읽기·페이로드 */
const SALEFORM = FX('saleform-line.html'), MODIFY = FX('modifyform.html'), CASHPAY = FX('cashpay-form.html');
const CASHPAY_UNPAID = CASHPAY.replace('name="payJun" value="280453"', 'name="payJun" value=""');

test('slComma: 콤마 문자열, 음수 부호 유지', () => {
  assert.equal(C.slComma(75722), '75,722');
  assert.equal(C.slComma(0), '0');
  assert.equal(C.slComma(999), '999');
  assert.equal(C.slComma(-5), '-5');
  assert.equal(C.slComma(-1234567), '-1,234,567');
});

test('SL_FORM10_NAMES: 스펙 §4.1-4 이름 그대로 순서대로', () => {
  assert.deepEqual(C.SL_FORM10_NAMES, ['sKey', 'pageSize', 'searchSortType', 'tradeJun', 'payJun', 'shop', 'client', 'payBank', 'payDia', 'payCard',
    'paySaleOldGold', 'payCash', 'payCashPaper', 'payRemark', 'payEtc', 'txtSaleDate', 'regId', 'beforePrice', 'beforePoint', 'saleDcPrice',
    'usePoint', 'payPrice', 'savePoint', 'afterPrice', 'afterPoint']);
});

test('slReadSaleForm: values · rows(헤더 이름으로 열 찾기) · form10', () => {
  const f = C.slReadSaleForm(SALEFORM);
  assert.equal(f.values.tradeJun, '114348'); assert.equal(f.values.payJun, '280453');
  assert.equal(f.values.client, '123699'); assert.equal(f.values.clientName, '민*금2837/G');
  assert.equal(f.values.sKey, '260930154640668');
  assert.deepEqual(f.missing, []);
  assert.deepEqual(f.rows, [{ idx: '376143,2504L5', saleSeq: '376143', barcode: '2504L5', salePrice: 112000, dcPrice: 36278, amount: 75722 }]);
  assert.equal(f.form10.afterPrice, '0'); assert.equal(f.form10.payPrice, '75,722');
  assert.equal(f.form10.payRemark, '');
});

test('slReadSaleForm: 헤더 열 순서가 바뀌어도 이름으로 읽는다 / 열이 없으면 null', () => {
  //  판매가 ↔ 실판매가 헤더·데이터 칸을 함께 맞바꾼다
  const swapped = SALEFORM
    .replace('<td>판매가</td>', '<td>@@A</td>').replace('<td>실판매가</td>', '<td>판매가</td>').replace('<td>@@A</td>', '<td>실판매가</td>')
    .replace('<td>112,000</td>\n<td class="f_bold">1</td>', '<td>75,722</td>\n<td class="f_bold">1</td>')
    .replace('<td class="f_bold">75,722</td>', '<td class="f_bold">112,000</td>');
  const r = C.slReadSaleForm(swapped).rows[0];
  assert.equal(r.salePrice, 112000); assert.equal(r.amount, 75722);   // 위치가 바뀌어도 헤더 이름을 따라간다
  const noCol = C.slReadSaleForm(SALEFORM.replace('<td>실판매가</td>', '<td>xx</td>')).rows[0];
  assert.equal(noCol.amount, null);
});

test('slReadSaleForm: 빈 목록·필드 없음은 missing 으로', () => {
  const empty = SALEFORM.replace(/<table class="t_list">[\s\S]*<\/table>/, '');
  assert.deepEqual(C.slReadSaleForm(empty).rows, []);
  assert.ok(C.slReadSaleForm('<html></html>').missing.includes('sKey'));
});

test('slSaleManager: 인라인 스크립트에서 읽고 없으면 빈값', () => {
  assert.equal(C.slSaleManager(MODIFY), '홍해진');
  assert.equal(C.slSaleManager(MODIFY.replace('form1.saleManager.value = "홍해진";', '')), '');
});

test('slModifyPayload: 픽스처 + 75,722 → 실판매가·DC·DC율·판매직원', () => {
  const p = C.slModifyPayload(MODIFY, 75722);
  assert.deepEqual(p.issues, []);
  const m = Object.fromEntries(p.fields);
  assert.equal(m.saleDcPrice, '75,722'); assert.equal(m.dcPrice, '36,278'); assert.equal(m.dcRate, '32.39');
  assert.equal(m.saleManager, '홍해진'); assert.equal(m.seq, '376143'); assert.equal(m.tradeJun, '114348');
  assert.equal(m.salePrice, '112,000'); assert.equal(m.tmpSalePrice, '112,000'); assert.equal(m.cashPoint, '0');
  assert.deepEqual(p.fields.map((f) => f[0]), ['sKey', 'pageSize', 'searchSortType', 'tradeJun', 'payJun', 'seq', 'barcode', 'shop', 'client', 'shopName', 'clientName',
    'salePrice', 'saleQty', 'tmpSalePrice', 'dcRate', 'dcPrice', 'cashPoint', 'saleDcPrice', 'saleManager', 'tmpPoint', 'usePoint', 'remark']);
  assert.ok(!p.fields.some((f) => f[0] === 'imageField22'));
});

test('slModifyPayload: 사은품 0원 → DC 전액·DC율 100.00', () => {
  const m = Object.fromEntries(C.slModifyPayload(MODIFY, 0).fields);
  assert.equal(m.saleDcPrice, '0'); assert.equal(m.dcPrice, '112,000'); assert.equal(m.dcRate, '100.00');
});

test('slModifyPayload: issues — 판매직원 없음 · 금액 이상 · 필드 누락', () => {
  assert.ok(C.slModifyPayload(MODIFY.replace('form1.saleManager.value = "홍해진";', ''), 75722).issues.includes('no_sale_manager'));
  for (const bad of [-1, 112001, 1.5, NaN, '75722']) assert.ok(C.slModifyPayload(MODIFY, bad).issues.includes('bad_amount'), String(bad));
  assert.ok(C.slModifyPayload(MODIFY.replace(/<input[^>]*name="tmpSalePrice"[^>]*>/, ''), 75722).issues.includes('missing:tmpSalePrice'));
});

test('slCashPayload: payJun 이 있으면 already_paid, 비우면 payCash 로 등록 준비', () => {
  assert.ok(C.slCashPayload(CASHPAY, 75722).issues.includes('already_paid'));
  const p = C.slCashPayload(CASHPAY_UNPAID, 75722);
  assert.deepEqual(p.issues, []);
  const m = Object.fromEntries(p.fields);
  assert.equal(m.payCash, '75,722'); assert.equal(m.payCashPaper, '0'); assert.equal(m.payEtc, '0'); assert.equal(m.remark, '');
  assert.equal(m.tradeType, '3'); assert.equal(m.payJun, ''); assert.equal(m.tradeJun, '114348');
  assert.equal(p.fields.filter((f) => f[0] === 'payCash').length, 1);
  assert.equal(p.fields[0][0], 'sKey');
  assert.ok(!p.fields.some((f) => f[0] === 'imageField22'));
  assert.ok(C.slCashPayload(CASHPAY_UNPAID, 0).issues.includes('bad_cash'));
  assert.ok(C.slCashPayload(CASHPAY_UNPAID.replace(/<input[^>]*name="sKey"[^>]*>/, ''), 75722).issues.includes('missing:sKey'));
});

test('slJunCheck: D8 — 미수 0 · payPrice/payCash/saleDcPrice = 현금', () => {
  const f10 = C.slReadSaleForm(SALEFORM).form10;
  assert.deepEqual(C.slJunCheck(f10, 75722), { ok: true, reason: '' });
  const bad = (over, cash) => C.slJunCheck(Object.assign({}, f10, over), cash == null ? 75722 : cash);
  let r = bad({ afterPrice: '75,722' }); assert.equal(r.ok, false); assert.match(r.reason, /afterPrice/);
  r = bad({ beforePrice: '1,000' }); assert.equal(r.ok, false); assert.match(r.reason, /beforePrice/);
  r = bad({ payCash: '70,000' }); assert.equal(r.ok, false); assert.match(r.reason, /payCash/);
  r = bad({ payPrice: '' }); assert.equal(r.ok, false); assert.match(r.reason, /payPrice/);
  r = bad({ saleDcPrice: '1' }); assert.equal(r.ok, false); assert.match(r.reason, /saleDcPrice/);
  r = bad({}, 75721); assert.equal(r.ok, false);
  assert.equal(C.slJunCheck({}, 75722).ok, false);
});

test('slJunPayload: SL_FORM10_NAMES 순서', () => {
  const f10 = C.slReadSaleForm(SALEFORM).form10;
  const p = C.slJunPayload(f10);
  assert.deepEqual(p.map((x) => x[0]), C.SL_FORM10_NAMES);
  assert.equal(Object.fromEntries(p).payCash, '75,722'); assert.equal(Object.fromEntries(p).sKey, '260930154640668');
});

test('slParseSheet: 합계 행 금액을 못 읽으면 거부, 빈칸은 0', () => {
  const h = C.slHeaderMap(ROWS[0]);
  const bad = ROWS.map((r) => r.slice());
  const t = bad.findIndex((r) => r[0] === '합계');
  bad[t][h.idx.Z] = '확인중';
  const p = C.slParseSheet(bad);
  assert.equal(p.ok, false);
  assert.match(p.error, /딜광고/);
  const empty = ROWS.map((r) => r.slice());
  empty[t][h.idx.AA] = '';
  assert.equal(C.slParseSheet(empty).totals.AA, 0);
});
