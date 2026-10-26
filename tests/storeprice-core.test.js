/* =============================================================================
 *  storeprice-core.test.js — 매장 제품 가격 변경: 출고 행 파싱·분류·재출고 본문·실행기.
 *  네트워크 없음. erp 는 스텁. 실행: node --test tests/storeprice-core.test.js
 *  스펙: docs/superpowers/specs/2026-10-23-store-price-change-design.md
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const S = require(path.join(__dirname, '..', 'src', 'storeprice-core.js'));

//  실측 배치(2026-10-23 매장출고전표): 첫 t_list 행은 합계, 다음 헤더, 그다음 데이터.
function delivRow(no, idx, jun, kind, shop, status) {
  return '<tr><td>' + no + '</td><td><input type="checkbox" name="idx" value="' + idx + '"></td><td>' + jun + '</td><td>가네샤26-10-23</td><td>26-10-23</td><td></td>'
    + '<td>' + idx.split(',')[1] + ' F-BF-Q-WG-QB-0092 임현규</td><td>' + kind + '</td><td>' + shop + '</td><td>1</td><td>66,000</td><td>0</td><td>36,000</td><td></td><td>' + status + '</td></tr>';
}
function delivHtml(rows, echo) {
  return '<form name="form1"><input type="text" name="searchBarcode" value="' + (echo || '') + '"></form>'
    + '<table class="t_list"><tr><td>합 계</td><td>45</td></tr>'
    + '<tr><th>No</th><th></th><th>출고장번호</th><th>매입처입고일</th><th>출고일(확인일)</th><th>이미지</th><th>바코드상품번호 / 고객명</th><th>구분</th><th>매장명상품정보</th><th>수량</th><th>상품입고가</th><th>멜리입고가</th><th>판매가</th><th>연결번호</th><th>상태</th></tr>'
    + rows.join('') + '</table>';
}
const SHOPS = [{ value: '', text: '--' }, { value: 'NU', text: '누리엔점' }, { value: 'GJ', text: '광주점' }, { value: 'LT', text: 'FASHION' }, { value: '00', text: 'D102본사' }];

test('spParsePrice — 쉼표 허용 양의 정수만', () => {
  assert.equal(S.spParsePrice('1,234,000'), 1234000);
  assert.equal(S.spParsePrice('36000'), 36000);
  assert.equal(S.spParsePrice(' 9,000 '), 9000);
  for (const bad of ['', '0', '-1000', '1,2a', '12,34', '1.5', 'abc', '1,000,000,000']) assert.equal(S.spParsePrice(bad), null, bad);
  assert.equal(S.spComma(1234000), '1,234,000');
});

test('spDelivRows — 헤더 이름으로 열을 찾고 구분을 코드로 바꾼다', () => {
  const rows = S.spDelivRows(delivHtml([delivRow(1, '427695,260AIM,47585,390275', '00000010PT', '일반 (상품)', '누리엔점925 1 g (15.5+3.5)', '출고완료')]));
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.barcode, '260AIM');
  assert.equal(r.junNum, '00000010PT');
  assert.equal(r.orderType, 'A');
  assert.equal(r.itemType, '1');
  assert.equal(r.status, '출고완료');
  assert.equal(r.salePrice, '36,000');
  assert.match(r.shopText, /^누리엔점/);
});

test('spClassify — 일반·회전 + 출고완료 + 매장 판독일 때만 진행', () => {
  const html = delivHtml([
    delivRow(5, '1,AAAAA1,1,1', 'J1', '일반 (상품)', '누리엔점18K 2 g', '출고완료'),
    delivRow(4, '2,AAAAA2,1,1', 'J2', '회전 (상품)', '광주점18K', '출고완료'),
    delivRow(4, '10,AAAAB0,1,1', 'J10', '회전 (메인석)', '광주점18K', '출고완료'),
    delivRow(3, '3,AAAAA3,1,1', 'J3', '고객 (상품)', '누리엔점', '출고완료'),
    delivRow(2, '4,AAAAA4,1,1', 'J4', '수리 (상품)', '누리엔점', '출고완료'),
    delivRow(1, '5,AAAAA5,1,1', 'J5', '일반 (상품)', '누리엔점', '판매완료'),
    delivRow(1, '6,AAAAA6,1,1', 'J6', '일반 (상품)', '없는점14K', '출고완료'),
    delivRow(1, '7,AAAAA7,1,1', 'J7', '알수없음', '누리엔점', '출고완료'),
    delivRow(1, '8,AAAAA8,1,1', 'J8', '일반(상품)', '누리엔점', '출고확인'),
    delivRow(1, '9,AAAAA9,1,1', 'J9', '일반 (상품)', '누리엔점', '출고오확인(NU)')
  ]);
  const rows = S.spDelivRows(html);
  const a = S.spClassify('aaaaa1', rows, SHOPS);
  assert.equal(a.go, true);
  assert.deepEqual(a.target.shop, { code: 'NU', name: '누리엔점' });
  assert.equal(a.target.orderType, 'A');
  const z = S.spClassify('AAAAA2', rows, SHOPS);
  assert.equal(z.go, true);
  assert.equal(z.target.orderType, 'Z');
  assert.equal(z.target.itemType, '1');
  assert.equal(z.target.shop.code, 'GJ');
  assert.match(S.spClassify('AAAAB0', rows, SHOPS).reason, /메인석/);   // 입고 경로가 달라 지원 안 함
  assert.match(S.spClassify('AAAAA3', rows, SHOPS).reason, /고객/);
  assert.match(S.spClassify('AAAAA4', rows, SHOPS).reason, /수리/);
  assert.match(S.spClassify('AAAAA5', rows, SHOPS).reason, /판매완료/);
  assert.match(S.spClassify('AAAAA6', rows, SHOPS).reason, /매장 판독 불가/);
  assert.match(S.spClassify('AAAAA7', rows, SHOPS).reason, /구분 판독 불가/);
  const confirmed = S.spClassify('AAAAA8', rows, SHOPS);   // 매장 확인 재고 · 괄호 앞 공백 없는 표기
  assert.equal(confirmed.go, true);
  assert.equal(confirmed.target.orderType, 'A');
  assert.match(S.spClassify('AAAAA9', rows, SHOPS).reason, /출고오확인/);
});

test('spClassify — 검색폼 echo 만 있고 행이 없으면 출고 내역 없음', () => {
  const rows = S.spDelivRows(delivHtml([], 'ZZZZZ9'));
  assert.equal(S.spClassify('ZZZZZ9', rows, SHOPS).reason, '출고 내역 없음');
});

test('spClassify — 같은 바코드 여러 행이면 첫 행(최신)', () => {
  const rows = S.spDelivRows(delivHtml([
    delivRow(2, '9,BBBBB1,1,1', 'NEW', '일반 (상품)', '광주점', '출고완료'),
    delivRow(1, '8,BBBBB1,1,1', 'OLD', '일반 (상품)', '누리엔점', '출고완료')
  ]));
  const c = S.spClassify('BBBBB1', rows, SHOPS);
  assert.equal(c.target.junNum, 'NEW');
  assert.equal(c.target.shop.code, 'GJ');
});

//  출고 화면: form1(바코드) · form10(출고장) · form2 · form3 이 sKey·searchShop·printFlag 를 겹쳐 쓴다(실측).
const WRITE_HTML =
  '<form name="form1" action="/deliv/item/delivItemWrite.do?tcode=deliv_item" method="post">'
  + '<input type="hidden" name="sKey" value="K1"><input type="hidden" name="pageSize" value="20"><input type="hidden" name="searchSortType" value="seq"><input type="hidden" name="listFlag" value="0">'
  + '<select name="searchShop"><option value="">--</option><option value="NU">누리엔점</option></select>'
  + '<input type="text" name="barcode" value=""><input type="checkbox" name="printFlag" value="1" checked><input type="hidden" name="printFlag" value="1">'
  + '<form name="form10" action="/jun/delivitem/delivItemJunWrite.do"><input type="hidden" name="sKey" value="K10"><input type="hidden" name="pageSize" value="20"><input type="hidden" name="searchShop" value=""><input type="hidden" name="printFlag" value="1">'
  + '<input type="text" name="junNum" value="" readonly><select name="delivyear" gname="deliv"><option value="2026">2026</option></select><select name="delivmonth" gname="deliv"><option value="01">01</option></select><select name="delivday" gname="deliv"><option value="01">01</option></select>'
  + '<input type="text" name="regId" value="쇼핑몰01" readonly></form>'
  + '<form name="form2"><input type="hidden" name="sKey" value="K2"><input type="hidden" name="searchShop" value=""></form>';

test('spRedelivPairs — form1 hidden + 매장·구분·바코드, printFlag=0 하나만', () => {
  const t = { barcode: 'AAAAA1', shop: { code: 'NU', name: '누리엔점' }, orderType: 'Z', itemType: '1' };
  const { pairs, missing } = S.spRedelivPairs(WRITE_HTML, t);
  assert.deepEqual(missing, []);
  const m = new Map(); pairs.forEach(([k, v]) => m.set(k, (m.get(k) || []).concat(v)));
  assert.deepEqual(m.get('sKey'), ['K1']);
  assert.deepEqual(m.get('printFlag'), ['0']);
  assert.deepEqual(m.get('searchShop'), ['NU']);
  assert.deepEqual(m.get('searchOrderType'), ['Z']);
  assert.deepEqual(m.get('searchItemType'), ['1']);
  assert.deepEqual(m.get('barcode'), ['AAAAA1']);
  assert.deepEqual(m.get('listFlag'), ['1']);   // 페이지 값(0=리스트 감추기)과 무관하게 1 — 대기 목록을 대조해야 한다
});

test('spCompletePairs — form10 hidden + 새 출고장·오늘 출고일·담당자, printFlag=0 하나만', () => {
  const { pairs, missing } = S.spCompletePairs(WRITE_HTML, new Date(2026, 9, 3));
  assert.deepEqual(missing, []);
  const m = new Map(); pairs.forEach(([k, v]) => m.set(k, (m.get(k) || []).concat(v)));
  assert.deepEqual(m.get('sKey'), ['K10']);      // form1(K1)·form2(K2) 의 sKey 가 섞이지 않는다
  assert.deepEqual(m.get('printFlag'), ['0']);
  assert.deepEqual(m.get('junNum'), ['']);
  assert.deepEqual([m.get('delivyear'), m.get('delivmonth'), m.get('delivday')], [['2026'], ['10'], ['03']]);
  assert.deepEqual(m.get('regId'), ['쇼핑몰01']);
});

test('spCompletePairs — form10 이 없으면 missing', () => {
  assert.ok(S.spCompletePairs('<form name="form1"></form>').missing.includes('sKey'));
});

test('spRedelivPairs — sKey 없으면 missing', () => {
  const t = { barcode: 'AAAAA1', shop: { code: 'NU' }, orderType: 'A', itemType: '1' };
  assert.deepEqual(S.spRedelivPairs('<form name="form1"><input type="text" name="barcode"></form>', t).missing, ['sKey']);
});

/* ------------------------------------------------------------ 실행기 */
const TARGET = (bc) => ({ barcode: bc, idx: '1,' + bc + ',1,1', junNum: 'J', shop: { code: 'NU', name: '누리엔점' }, orderType: 'A', itemType: '1', salePrice: '36,000' });
function stub(over) {
  const calls = [];
  const E = {
    log: () => true,
    deleteDeliv: async (t) => { calls.push('delete:' + t.barcode); return { ok: true }; },
    findVoucherItem: async (bc) => { calls.push('find:' + bc); return { ok: true, modifyUrl: 'M' }; },
    savePrice: async () => { calls.push('save'); return { ok: true }; },
    verifyPrice: async () => { calls.push('verify'); return { ok: true }; },
    redeliver: async (t) => { calls.push('redeliver:' + t.shop.code); return { ok: true }; },
    verifyRedeliv: async () => { calls.push('verifyRedeliv'); return { ok: true }; }
  };
  Object.assign(E, over || {});
  return { E, calls };
}

test('spRunOne — 성공 순서: 삭제 → 찾기 → 저장 → 확인 → 재출고 → 재출고 확인', async () => {
  const { E, calls } = stub();
  const r = await S.spRunOne(TARGET('AAAAA1'), 50000, E);
  assert.equal(r.status, 'ok');
  assert.equal(r.to, '50,000');
  assert.deepEqual(calls, ['delete:AAAAA1', 'find:AAAAA1', 'save', 'verify', 'redeliver:NU', 'verifyRedeliv']);
});

for (const [name, over] of [
  ['찾기 실패', { findVoucherItem: async () => ({ ok: false, msg: 'x' }) }],
  ['저장 실패', { savePrice: async () => ({ ok: false, msg: 'x' }) }],
  ['저장 예외', { savePrice: async () => { throw new Error('boom'); } }],
  ['확인 불일치', { verifyPrice: async () => ({ ok: false, msg: 'x' }) }]
]) {
  test('spRunOne — ' + name + '여도 원래 매장으로 재출고하고 price_failed', async () => {
    const { E, calls } = stub(over);
    const r = await S.spRunOne(TARGET('AAAAA1'), 50000, E);
    assert.equal(r.status, 'price_failed');
    assert.ok(calls.includes('redeliver:NU'), calls.join(','));
  });
}

test('spRunOne — 저장 확인의 경고(다른 칸 변경)는 결과에 실린다', async () => {
  const { E } = stub({ verifyPrice: async () => ({ ok: true, warn: '다른 칸도 바뀜: k 5→6' }) });
  const r = await S.spRunOne(TARGET('AAAAA1'), 50000, E);
  assert.equal(r.status, 'ok');
  assert.match(r.warn, /k 5→6/);
});

test('spRunOne — 재출고 확인의 경고(같은 출고장에 남의 상품)는 결과에 실린다', async () => {
  const { E } = stub({ verifyRedeliv: async () => ({ ok: true, warn: '같은 출고장 J9에 다른 상품 1개(ZZZZZ1)도 함께 출고됨' }) });
  const r = await S.spRunOne(TARGET('AAAAA1'), 50000, E);
  assert.equal(r.status, 'ok');
  assert.match(r.warn, /ZZZZZ1/);
});

test('spRunOne — 재출고 실패면 stranded', async () => {
  const { E } = stub({ redeliver: async () => ({ ok: false, msg: 'msg' }) });
  assert.equal((await S.spRunOne(TARGET('AAAAA1'), 50000, E)).status, 'stranded');
  const { E: E2 } = stub({ verifyRedeliv: async () => ({ ok: false, msg: '안 보임' }) });
  assert.equal((await S.spRunOne(TARGET('AAAAA1'), 50000, E2)).status, 'stranded');
  const { E: E3 } = stub({ redeliver: async () => { throw new Error('timeout'); } });
  assert.equal((await S.spRunOne(TARGET('AAAAA1'), 50000, E3)).status, 'stranded');
});

test('spRunOne — 로그를 못 남기면 삭제하지 않는다', async () => {
  const { E, calls } = stub({ log: () => false });
  const r = await S.spRunOne(TARGET('AAAAA1'), 50000, E);
  assert.equal(r.status, 'delete_failed');
  assert.deepEqual(calls, []);
});

test('spRunOne — 삭제 실패면 재출고하지 않는다(아무것도 안 바뀜)', async () => {
  const { E, calls } = stub({ deleteDeliv: async () => ({ ok: false, msg: 'no' }) });
  const r = await S.spRunOne(TARGET('AAAAA1'), 50000, E);
  assert.equal(r.status, 'delete_failed');
  assert.ok(!calls.some((c) => c.startsWith('redeliver')));
});

for (const [name, over] of [
  ['삭제 결과 불명(uncertain)', { deleteDeliv: async () => ({ ok: false, uncertain: true, msg: 'timeout' }) }],
  ['삭제 예외', { deleteDeliv: async () => { throw new Error('boom'); } }]
]) {
  test('spRunOne — ' + name + '면 가격은 건드리지 않고 재출고를 시도한다', async () => {
    const { E, calls } = stub(over);
    const r = await S.spRunOne(TARGET('AAAAA1'), 50000, E);
    assert.deepEqual(calls, ['redeliver:NU', 'verifyRedeliv']);
    assert.equal(r.status, 'price_failed');
    assert.match(r.msg, /확인하지 못함/);
  });
}

test('spRunAll — limit=1 이면 1건만(시범)', async () => {
  const { E, calls } = stub();
  const res = await S.spRunAll([TARGET('AAAAA1'), TARGET('AAAAA2')], 50000, E, { limit: 1 });
  assert.equal(res.length, 1);
  assert.ok(!calls.includes('delete:AAAAA2'));
});

test('spRunAll — shouldStop 이 참이 되면 다음 제품을 시작하지 않는다', async () => {
  let stop = false;
  const { E, calls } = stub({ verifyRedeliv: async () => { stop = true; return { ok: true }; } });
  const res = await S.spRunAll([TARGET('AAAAA1'), TARGET('AAAAA2')], 50000, E, { shouldStop: () => stop });
  assert.equal(res.length, 1);
  assert.equal(res[0].status, 'ok');            // 진행 중이던 제품은 재출고까지 끝낸다
  assert.ok(!calls.includes('delete:AAAAA2'));
});

test('spRunAll — 실패하면 그 자리에서 멈춘다', async () => {
  let n = 0;
  const { E, calls } = stub({ savePrice: async () => (++n === 1 ? { ok: false, msg: 'x' } : { ok: true }) });
  const res = await S.spRunAll([TARGET('AAAAA1'), TARGET('AAAAA2')], 50000, E);
  assert.equal(res.length, 1);
  assert.equal(res[0].status, 'price_failed');
  assert.ok(!calls.includes('delete:AAAAA2'));
});

test('spStepPrice — 입력 금액에서 ±5%·10%, 만원 단위 올림', () => {
  assert.equal(S.spStepPrice(1000000, 5), 1050000);
  assert.equal(S.spStepPrice(1000000, -10), 900000);
  assert.equal(S.spStepPrice(3000400, 5), 3160000);     // 3,150,420 → 만원 올림
  assert.equal(S.spStepPrice(2700000, -5), 2570000);    // 2,565,000 → 만원 올림
  assert.equal(S.spStepPrice(12345, -10), 20000);       // 11,110.5 → 20,000
  for (const bad of [null, 0, -1, 1.5, NaN]) assert.equal(S.spStepPrice(bad, 5), null, String(bad));
  assert.equal(S.spStepPrice(999999999, 10), null);     // 상한(spParsePrice 와 같은 999,999,999) 초과
});
