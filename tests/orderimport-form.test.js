/* =============================================================================
 *  orderimport-form.test.js — 판매처 주문 가져오기 순수 함수 단위 테스트 2/2 (폼 추출·목록·페이로드·대조).
 *  픽스처: tests/fixtures/orderimport/ (xls 행 배열은 실제 파일에서 뽑아 이름·전화만 가명 치환,
 *          HTML 은 2026-09-14 라이브 실측 마크업을 그대로 본뜬 합성본).
 *  스펙: docs/superpowers/specs/2026-09-14-orderimport-design.md §2·§4·§5
 *  실행: node --test tests/orderimport-form.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'src', 'orderimport-core.js'));
const FX = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'orderimport', name), 'utf8');

/* ---------------------------------------------------------- §4 폼 추출 */
const WRITE = FX('orderwrite-master.html');
test('oiReadWriteForm: form1 25필드 전부, k/color 옵션, 배열, 목록 1행(중첩 테이블 무시)', () => {
  const f = C.oiReadWriteForm(WRITE);
  assert.deepEqual(f.missing, []);
  assert.equal(f.values.sKey, '260914143005123'); assert.equal(f.values.tradeJun, '141240');
  assert.equal(f.values.master, '7083'); assert.equal(f.values.itemNum, 'FRFIWGPA00F6');
  assert.equal(f.values.k, '5'); assert.equal(f.values.color, 'WG'); assert.equal(f.values.itemSize, '11');
  assert.equal(f.values.orderPrice, '19,000'); assert.equal(f.values.shopRemark, '');
  assert.deepEqual(f.kOpts, [{ value: '5', text: '925', selected: true }]);
  assert.equal(f.colorOpts.length, 21); assert.equal(f.colorOpts[0].value, '');
  assert.deepEqual(f.arrays, { arr_weight: [0, 0], arr_salePrice: [19000, 0], arr_inputSupply: [4500, 0] });
  assert.equal(f.rows.length, 1);
  assert.deepEqual(f.rows[0], { orderSeq: '389463', tradeJun: '141240', code: 'F-RF-I-WG-PA-00F6', remark: '정산 12,133 원', name: 'F-퓨어컷팅(실버)R', k: '925', weight: '0 g', color: '화이트', size: '11', qty: '1', price: '17,000' });
  assert.deepEqual(f.defaults, { k: '5', color: 'WG', itemSize: '11' });
});

test('oiFieldValue: 이름 접두 오매치 방지·select 기본값·textarea', () => {
  const html = '<input type="hidden" name="pageSizeX" value="9"><input type=hidden name=pageSize value=20><select name="s"><option value="a">A</option><option value="b" selected>B</option></select><textarea name="t">hi</textarea>';
  assert.equal(C.oiFieldValue(html, 'pageSize'), '20');
  assert.equal(C.oiFieldValue(html, 's'), 'b');
  assert.equal(C.oiFieldValue(html, 't'), 'hi');
  assert.equal(C.oiFieldValue(html, 'nope'), null);
});

test('oiReadForm10: form10 구간만 읽어 form1 과 이름이 겹쳐도 안전, 인도예정월은 01(스크립트가 채우던 값)', () => {
  const f = C.oiReadForm10(WRITE);
  assert.deepEqual(f.missing, []);
  assert.equal(f.values.regId, '담당자'); assert.equal(f.values.txtOrderDate, '26-09-14');
  assert.equal(f.values.exdelivedmonth, '01');
  assert.equal(f.values.payEtc, '0'); assert.equal(f.values.payRemark, '');
  assert.equal(f.rows.length, 1);
});

test('oiForm10Payload: 인도예정일은 오늘로 명시, 결제 빈값은 0', () => {
  const v = C.oiReadForm10(WRITE).values;
  const p = Object.fromEntries(C.oiForm10Payload(Object.assign({}, v, { payCard: '' }), new Date(2026, 8, 14)));
  assert.equal(p.exdelivedyear, '2026'); assert.equal(p.exdelivedmonth, '09'); assert.equal(p.exdelivedday, '14');
  assert.equal(p.payCard, '0'); assert.equal(p.tradeJun, '141240');
  assert.equal(Object.keys(p).length, 23);
});

test('oiExtractHidden: 고객 등록 폼 hidden 28개(중복 이름·빈값 유지)', () => {
  const h = C.oiExtractHidden(FX('clientform.html'));
  assert.equal(h.length, 28);
  assert.deepEqual(h[0], ['sKey', '260914121512260']);
  assert.ok(h.some(([n, v]) => n === 'shopName' && v === 'FASHION'));
  assert.equal(C.oiSelectOptions(FX('clientform.html'), 'clientJob').find((o) => o.text === '아몬즈').value, '18');
});

test('oiClientSearchRows / oiMasterSearchRows / oiJunListRows', () => {
  const cl = C.oiClientSearchRows(FX('client-search.html'));
  assert.equal(cl.length, 4);
  assert.deepEqual(cl[1], { name: '가나다3269/카', shop: 'FASHION', phone: '', tel: '', seq: '123752' });
  assert.equal(cl[2].phone, '010-0000-2558');
  const ms = C.oiMasterSearchRows(FX('master-search.html'));
  assert.equal(ms.length, 4);
  assert.deepEqual(ms[0], { code: 'F-RF-I-WG-PA-00F6', name: 'F-퓨어컷팅(실버)R', seq: '7083' });
  const jn = C.oiJunListRows(FX('junlist.html'));
  assert.equal(jn.length, 2);
  assert.equal(jn[0].orderSeq, '389461'); assert.equal(jn[0].junNum, '0000002YF3'); assert.equal(jn[0].status, '주문완료');
  assert.equal(jn[1].junNum, '0000002YF1'); assert.equal(jn[1].status, '주문취소');
  assert.deepEqual(C.oiClientSearchRows('<html><body>검색된 결과가 없습니다.</body></html>'), []);
});

/* ------------------------------------------------------------ §4.2 페이로드 */
test('oiLinePayload: 스펙 덮어쓰기, 색상 폴백, orgOrderPrice 는 마스터가 그대로', () => {
  const f = C.oiReadWriteForm(WRITE);
  const master = { seq: '7083', code: 'F-RF-I-WG-PA-00F6' };
  const p = C.oiLinePayload(f, master, { k: '925', color: null, itemSize: '17', qty: 1, price: 17000, remark: '정산 12,033 원' });
  assert.deepEqual(p.issues, []);
  const o = Object.fromEntries(p.fields);
  assert.equal(p.fields.length, 25);
  assert.equal(o.k, '5'); assert.equal(o.color, 'WG'); assert.equal(o.itemSize, '17');
  assert.equal(o.orderQty, '1'); assert.equal(o.orderPrice, '17,000'); assert.equal(o.shopRemark, '정산 12,033 원');
  assert.equal(o.orgOrderPrice, '19000'); assert.equal(o.sKey, '260914143005123');
  //  색상 폴백: 마스터 기본 색상이 빈값이면 코드 4번째 토막
  const f2 = Object.assign({}, f, { values: Object.assign({}, f.values, { color: '' }) });
  assert.equal(Object.fromEntries(C.oiLinePayload(f2, master, { qty: 1, price: 82000, remark: '' }).fields).color, 'WG');
  const f3 = Object.assign({}, f2, { colorOpts: [{ value: '' }, { value: 'PG' }] });
  assert.ok(C.oiLinePayload(f3, master, { qty: 1, price: 82000, remark: '' }).issues.includes('색상 없음'));
  //  사이즈 미지정이면 마스터 기본값(문자열 그대로)
  const f4 = Object.assign({}, f, { values: Object.assign({}, f.values, { itemSize: '40+5' }) });
  assert.equal(Object.fromEntries(C.oiLinePayload(f4, master, { qty: 1, price: 42000, remark: '' }).fields).itemSize, '40+5');
  //  master 불일치·판매가 0·수량 0 은 issue
  assert.ok(C.oiLinePayload(f, { seq: '9999', code: 'X' }, { qty: 1, price: 1, remark: '' }).issues.some((s) => s.startsWith('master 불일치')));
  assert.ok(C.oiLinePayload(f, master, { qty: 0, price: 0, remark: '' }).issues.includes('수량'));
});

test('oiLinePayload: 품위를 바꾸면 kchange 처럼 배열에서 weight/orgOrderPrice/inputPrice 를 다시 뽑는다', () => {
  const f = C.oiReadWriteForm(WRITE);
  f.kOpts = [{ value: '1', text: '14K', selected: true }, { value: '2', text: '18K' }];
  f.values.k = '1';
  f.arrays = { arr_weight: [1.29, 1.55], arr_salePrice: [446000, 512000], arr_inputSupply: [200000, 240000] };
  const o = Object.fromEntries(C.oiLinePayload(f, { seq: '7083', code: 'T-R6-Q-WG-QB-00CI' }, { k: '18', color: 'PG', itemSize: '15', qty: 1, price: 512000, remark: '' }).fields);
  assert.equal(o.k, '2'); assert.equal(o.weight, '1.55'); assert.equal(o.orgOrderPrice, '512000'); assert.equal(o.inputPrice, '240000'); assert.equal(o.color, 'PG');
  assert.ok(C.oiLinePayload(f, { seq: '7083', code: 'X' }, { k: '925', qty: 1, price: 1, remark: '' }).issues.some((s) => s.startsWith('품위 옵션 없음')));
});

test('oiSubmitResult: msg 비면 성공', () => {
  assert.deepEqual(C.oiSubmitResult('http://ubdstore.ubshop.biz/order/item/orderItemWriteForm.do?tcode=order_item&tradeJun=&client=1'), { ok: true, msg: '' });
  assert.deepEqual(C.oiSubmitResult('http://ubdstore.ubshop.biz/order/item/orderItemWriteForm.do?tcode=order_item&msg=%EC%8B%A4%ED%8C%A8'), { ok: false, msg: '실패' });
  assert.equal(C.oiSubmitResult('not a url').ok, false);
});

/* ---------------------------------------------------------- §5 기대치 대조 */
test('oiCheckForm / oiCheckFinal: client·행 수·orderSeq·코드·사이즈·수량·주문가 대조', () => {
  const f = C.oiReadWriteForm(WRITE);
  assert.equal(C.oiCheckForm(f, { client: '123790', master: '7083', tradeJun: '141240', orderSeqs: ['389463'] }).ok, true);
  assert.match(C.oiCheckForm(f, { client: '123790', master: '7083', tradeJun: '', orderSeqs: [] }).reason, /^rows 1≠0/);
  assert.match(C.oiCheckForm(f, { client: '999', master: '7083', tradeJun: '141240', orderSeqs: ['389463'] }).reason, /^client/);
  assert.match(C.oiCheckForm(f, { client: '123790', master: '7083', tradeJun: '141240', orderSeqs: ['1'] }).reason, /^foreign row 389463/);
  assert.match(C.oiCheckForm(f, { client: '123790', master: '7083', tradeJun: '999', orderSeqs: ['389463'] }).reason, /^tradeJun/);
  const f10 = C.oiReadForm10(WRITE);
  const line = { master: { code: 'F-RF-I-WG-PA-00F6' }, spec: { itemSize: '11', qty: 1, price: 17000 } };
  assert.equal(C.oiCheckFinal(f10, { client: '123790', tradeJun: '141240', orderSeqs: ['389463'], lines: [line] }).ok, true);
  const bad = { master: { code: 'F-RF-I-WG-PA-00F6' }, spec: { itemSize: '13', qty: 1, price: 17000 } };
  assert.match(C.oiCheckFinal(f10, { client: '123790', tradeJun: '141240', orderSeqs: ['389463'], lines: [bad] }).reason, /^size/);
  const badPrice = { master: { code: 'F-RF-I-WG-PA-00F6' }, spec: { itemSize: '11', qty: 1, price: 18000 } };
  assert.match(C.oiCheckFinal(f10, { client: '123790', tradeJun: '141240', orderSeqs: ['389463'], lines: [badPrice] }).reason, /^price/);
});
