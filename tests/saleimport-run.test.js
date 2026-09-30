/* =============================================================================
 *  saleimport-run.test.js — 실행기(slRunClient/slRunAll) 배선 테스트. erp 는 메모리 상태 머신 스텁.
 *  "가드 실패·외부 개입·최종 대조 실패·미수 발생 때 결제/판매하기를 보내지 않고, 결제 후에는 되돌리지 않는다" 를 고정한다. 네트워크 없음.
 *  스펙: docs/superpowers/specs/2026-09-30-saleimport-design.md §4
 *  실행: node --test tests/saleimport-run.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'src', 'saleimport-core.js'));
const FX = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'saleimport', n), 'utf8');
const MODIFY = FX('modifyform.html');
const CASHPAY = FX('cashpay-form.html');

const CLIENT = { seq: '123699', name: '민*금2837/G' };
const LINES = [
  { barcode: '2504L5', code: 'F-BF-Z-WG-ZZ-0098', name: '체인', gift: false, orderNo: '3471785121', amount: 75722 },
  { barcode: '2504L6', code: 'F-BF-Z-WG-ZZ-0099', name: '트레이(사은품)', gift: true, orderNo: '', amount: 0 }
];
const plan = (over) => Object.assign({ key: '민*금2837/G', client: CLIENT, lines: LINES.map((l) => Object.assign({}, l)), cash: 75722 }, over || {});
const hooks = { log() {} };

//  스텁 erp: 서버의 '열린 판매전표'(세션당 1개)를 흉내 낸다. opts 로 시나리오를 바꾼다.
function makeErp(opts) {
  opts = opts || {};
  const calls = [];
  const srv = { tradeJun: opts.openTrade || '', payJun: '', rows: [], seq: 376100, sold: [], keyN: 0, injected: false, cashPosts: 0, junPosts: 0 };
  const sum = () => srv.rows.reduce((s, r) => s + r.amount, 0);
  const form = (over) => {
    const cash = srv.payJun ? sum() : 0;
    const f10 = { sKey: 'k' + (++srv.keyN), pageSize: '20', searchSortType: 'seq', tradeJun: srv.tradeJun, payJun: srv.payJun, shop: 'LT', client: CLIENT.seq,
      payBank: '0', payDia: '0', payCard: '0', paySaleOldGold: '0', payCash: C.slComma(cash), payCashPaper: '0', payRemark: '', payEtc: '0',
      txtSaleDate: '26-09-30', regId: '홍해진', beforePrice: opts.beforePrice || '0', beforePoint: '0', saleDcPrice: C.slComma(sum()), usePoint: '0',
      payPrice: C.slComma(sum()), savePoint: '0', afterPrice: srv.payJun && opts.afterPrice ? opts.afterPrice : '0', afterPoint: '0' };
    if (opts.dropForm10 && srv.payJun) delete f10[opts.dropForm10];
    if (opts.switchAfterPay && srv.payJun) f10.tradeJun = '777';
    return Object.assign({ values: { sKey: opts.noSKey ? '' : f10.sKey, tradeJun: srv.tradeJun, payJun: srv.payJun, client: opts.wrongClient ? '999' : CLIENT.seq, clientName: CLIENT.name },
      form10: f10, missing: opts.missingAfterPay && srv.payJun ? ['form10.regId'] : [], rows: srv.rows.map((r) => Object.assign({}, r)) }, over || {});
  };
  return {
    calls, srv,
    async state() { calls.push(['state']); return { tradeJun: srv.tradeJun, payJun: srv.payJun, rows: srv.rows.length, form: form() }; },
    async openClient(client, clientName) { calls.push(['openClient', client, clientName]); return form(); },
    async getSaleForm(ctx) {
      calls.push(['getSaleForm', ctx.tradeJun, ctx.payJun]);
      if (opts.formThrowsAfterPay && srv.payJun) throw new Error('timeout');
      if (opts.foreignAfterCash && srv.payJun && !srv.injected) {
        srv.injected = true;
        srv.rows.push({ idx: '999997,XXXXXX', saleSeq: '999997', barcode: 'XXXXXX', salePrice: 30000, dcPrice: 30000, amount: 0 });   // 결제 뒤 다른 탭이 끼운 0원 줄
      }
      if (opts.foreign && !srv.injected && srv.rows.length === 1) {
        srv.injected = true;
        srv.rows.push({ idx: '999999,ZZZZZZ', saleSeq: '999999', barcode: 'ZZZZZZ', salePrice: 50000, dcPrice: 0, amount: 50000 });
      }
      return form();
    },
    async postLine(f, barcode) {
      calls.push(['postLine', barcode, f.values.sKey]);
      if (opts.lineThrowsAt != null && srv.rows.length === opts.lineThrowsAt) throw new Error('timeout');
      if (!srv.tradeJun) srv.tradeJun = '114348';
      const seq = String(++srv.seq);
      const bc = opts.wrongBarcode ? 'QQQQQQ' : barcode;
      srv.rows.push({ idx: seq + ',' + bc, saleSeq: seq, barcode: bc, salePrice: 112000, dcPrice: 0, amount: 112000 });
      return { ok: true, msg: '', form: form() };
    },
    async getModify(saleSeq, ctx) { calls.push(['getModify', saleSeq]); return (opts.noManager ? MODIFY.replace('form1.saleManager.value = "홍해진";', '') : MODIFY).replace('name="seq" value="376143"', 'name="seq" value="' + saleSeq + '"'); },
    async postModify(fields) {
      const m = Object.fromEntries(fields); calls.push(['postModify', m.seq, m.saleDcPrice]);
      const row = srv.rows.find((r) => r.saleSeq === m.seq);
      const want = Number(m.saleDcPrice.replace(/,/g, ''));
      row.amount = opts.storeWrongAt === m.seq ? want + 1 : want; row.dcPrice = 112000 - want;
      const f = form();
      if (opts.modifyExtraRow) f.rows.push({ idx: '999998,YYYYYY', saleSeq: '999998', barcode: 'YYYYYY', salePrice: 1, dcPrice: 0, amount: 1 });   // 응답에만 낯선 줄
      if (opts.foreignAfterModify && !srv.injected) { srv.injected = true; srv.rows.push({ idx: '999999,ZZZZZZ', saleSeq: '999999', barcode: 'ZZZZZZ', salePrice: 50000, dcPrice: 0, amount: 50000 }); }   // 응답 뒤 다른 탭이 끼워 넣음
      if (opts.storeWrongAt === m.seq) f.rows = f.rows.map((r) => (r.saleSeq === m.seq ? Object.assign({}, r, { amount: want }) : r));   // 응답은 정상처럼 보이고 저장만 다르다
      return { ok: true, msg: '', form: f };
    },
    async getCash(ctx) { calls.push(['getCash', ctx.tradeJun]); return CASHPAY.replace('name="payJun" value="280453"', 'name="payJun" value="' + (opts.cashAlreadyPaid ? '280453' : srv.payJun) + '"'); },
    async postCash(fields) {
      const m = Object.fromEntries(fields); calls.push(['postCash', m.payCash]); srv.cashPosts++;
      if (opts.cashThrows) throw new Error('timeout');
      srv.payJun = '280453';
      return { ok: true, msg: '', payJun: srv.payJun, payCash: m.payCash };
    },
    async postJun(fields) {
      calls.push(['postJun', Object.fromEntries(fields).payCash]); srv.junPosts++;
      if (opts.junFails) return { ok: false, msg: '실패' };
      srv.sold = srv.rows.map((r) => ({ barcode: r.barcode, amount: r.amount }));
      srv.tradeJun = ''; srv.payJun = ''; srv.rows = [];
      return { ok: true, msg: '' };
    },
    async deleteLines(ctx, idxValues) {
      calls.push(['deleteLines', idxValues.slice()]);
      const before = srv.rows.map((r) => Object.assign({}, r));
      const seqs = idxValues.map((v) => v.split(',')[0]);
      srv.rows = opts.overreach ? [] : srv.rows.filter((r) => !seqs.includes(r.saleSeq));
      if (!srv.rows.length) srv.tradeJun = '';
      return { ok: true, msg: '', before };
    },
    async trade(client, clientName) { calls.push(['trade']); return { orders: [], sales: opts.noSales ? [] : srv.sold.slice() }; }
  };
}
const names = (erp) => erp.calls.map((c) => c[0]);
const count = (erp, n) => names(erp).filter((x) => x === n).length;

test('1. 정상 2줄(본품 + 사은품 0원): 호출 순서·done·paid', async () => {
  const erp = makeErp();
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'done', r.reason);
  assert.deepEqual(names(erp), ['state', 'openClient', 'postLine', 'getSaleForm', 'postLine', 'getSaleForm', 'getModify', 'postModify', 'getSaleForm', 'getModify', 'postModify',
    'getSaleForm', 'getCash', 'postCash', 'getSaleForm', 'postJun', 'state', 'trade']);
  assert.equal(r.paid, true); assert.equal(r.tradeJun, '114348'); assert.equal(r.payJun, '280453');
  assert.equal(r.saleSeqs.length, 2); assert.equal(r.rolledBack, 0);
  assert.deepEqual(erp.calls.find((c) => c[0] === 'postCash'), ['postCash', '75,722']);
  assert.equal(erp.srv.cashPosts, 1); assert.equal(erp.srv.junPosts, 1);
  assert.deepEqual(erp.srv.sold, [{ barcode: '2504L5', amount: 75722 }, { barcode: '2504L6', amount: 0 }]);
  assert.deepEqual(erp.srv.rows, [], '판매 후 세션이 비어야 한다');
});

test('2. 시작 가드: 열린 판매전표가 있으면 skipped:open_trade, 쓰기 0', async () => {
  const erp = makeErp({ openTrade: '555' });
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'skipped'); assert.equal(r.reason, 'open_trade');
  assert.deepEqual(names(erp), ['state']);
  for (const w of ['openClient', 'postLine', 'postModify', 'postCash', 'postJun', 'deleteLines']) assert.equal(count(erp, w), 0, w);
});

test('3. 둘째 줄 전 세션에 남의 줄이 끼어듦 → 둘째 postLine 0, 내 줄만 삭제, 남은 줄이 있으니 fatal:foreign_rows_remain', async () => {
  const erp = makeErp({ foreign: true });
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'fatal', r.reason); assert.match(r.reason, /^foreign_rows_remain:foreign_row/);
  assert.equal(count(erp, 'postLine'), 1);
  const del = erp.calls.filter((c) => c[0] === 'deleteLines');
  assert.equal(del.length, 1); assert.equal(del[0][1].length, 1); assert.match(del[0][1][0], /^376101,2504L5$/);
  assert.equal(r.rolledBack, 1);
  assert.equal(count(erp, 'postCash'), 0); assert.equal(count(erp, 'postJun'), 0);
  assert.ok(erp.srv.rows.some((x) => x.saleSeq === '999999'), '남의 줄은 그대로');
});

test('4. 최종 대조 실패(한 행 저장 금액이 다름) → postCash 0, 되돌리기', async () => {
  const erp = makeErp({ storeWrongAt: '376101' });
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'skipped', r.reason); assert.match(r.reason, /final/);
  assert.equal(count(erp, 'postCash'), 0); assert.equal(count(erp, 'postJun'), 0);
  assert.equal(count(erp, 'deleteLines'), 1); assert.equal(r.rolledBack, 2); assert.equal(r.paid, false);
});

test('5. 결제 후 미수 발생(afterPrice ≠ 0) → postJun 0, fatal, deleteLines 0', async () => {
  const erp = makeErp({ afterPrice: '75,722' });
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'fatal'); assert.match(r.reason, /^receivable:.*afterPrice/);
  assert.equal(count(erp, 'postJun'), 0); assert.equal(count(erp, 'deleteLines'), 0);
  assert.equal(r.paid, true); assert.equal(erp.srv.cashPosts, 1);
});

test('5b. 거래 전 미수(beforePrice ≠ 0)면 결제 전 최종 대조에서 멈춘다(결제 0)', async () => {
  const erp = makeErp({ beforePrice: '1,000' });
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'skipped'); assert.equal(r.paid, false);
  assert.equal(count(erp, 'postCash'), 0); assert.equal(count(erp, 'postJun'), 0);
});

test('6. postCash 예외 → fatal, deleteLines 0, postJun 0, 결제 재전송 0', async () => {
  const erp = makeErp({ cashThrows: true });
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'fatal'); assert.equal(r.paid, true);
  assert.equal(count(erp, 'deleteLines'), 0); assert.equal(count(erp, 'postJun'), 0); assert.equal(erp.srv.cashPosts, 1);
});

test('7. postLine 예외 → fatal:line_unverified, deleteLines 0', async () => {
  const erp = makeErp({ lineThrowsAt: 0 });
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'fatal'); assert.match(r.reason, /^line_unverified/);
  assert.equal(count(erp, 'deleteLines'), 0);
  const erp2 = makeErp({ lineThrowsAt: 1 });
  const r2 = await C.slRunClient(plan(), erp2, hooks);
  assert.equal(r2.status, 'fatal'); assert.match(r2.reason, /^line_unverified/); assert.equal(count(erp2, 'deleteLines'), 0);
});

test('8. 되돌리기가 남의 줄까지 지움 → fatal:rollback_overreach', async () => {
  const erp = makeErp({ foreign: true, overreach: true });
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'fatal'); assert.match(r.reason, /^rollback_overreach:999999/);
});

test('9. slRunAll: 첫 고객 fatal → 둘째 고객 blocked, 둘째 고객의 erp 호출 0', async () => {
  const erp = makeErp({ cashThrows: true });
  const res = await C.slRunAll([plan({ key: 'A' }), plan({ key: 'B' })], erp, hooks);
  assert.equal(res.length, 2);
  assert.equal(res[0].status, 'fatal'); assert.equal(res[1].status, 'blocked'); assert.equal(res[1].reason, 'halted');
  assert.equal(res[1].key, 'B'); assert.equal(res[1].paid, false);
  assert.equal(count(erp, 'state'), 1, '둘째 고객은 가드 state() 조차 부르지 않는다');
  assert.equal(count(erp, 'openClient'), 1);
});

test('9b. slRunAll: 정상 두 고객은 순차로 done · 쓰기 전 예외(state)는 던지지 않고 skipped 결과', async () => {
  const erp = makeErp();
  const res = await C.slRunAll([plan({ key: 'A' }), plan({ key: 'B', lines: [{ barcode: '2504L9', code: '', name: '', gift: false, orderNo: 'x', amount: 1000 }], cash: 1000 })], erp, hooks);
  assert.equal(res[0].status, 'done', res[0].reason);
  assert.equal(res[1].status, 'done', res[1].reason);
  const boom = { state() { throw new Error('boom'); } };
  const r2 = await C.slRunAll([plan()], boom, hooks);
  assert.equal(r2[0].status, 'skipped'); assert.match(r2[0].reason, /exception:boom/);
});

test('10. 계획 자체가 이상하면(현금≠줄 합계·중복 바코드·빈 줄) 쓰기 0으로 skipped:bad_plan', async () => {
  for (const bad of [plan({ cash: 75000 }), plan({ lines: [] }), plan({ lines: [LINES[0], LINES[0]] }), plan({ cash: 0, lines: [Object.assign({}, LINES[1])] })]) {
    const erp = makeErp();
    const r = await C.slRunClient(bad, erp, hooks);
    assert.equal(r.status, 'skipped'); assert.match(r.reason, /^bad_plan/);
    assert.equal(erp.calls.length, 0);
  }
});

test('11. 응답 줄의 바코드가 다르면 어느 줄이 내 것인지 모른다 → fatal, 삭제 0', async () => {
  const erp = makeErp({ wrongBarcode: true });
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'fatal'); assert.match(r.reason, /^line_unverified:barcode/);
  assert.equal(count(erp, 'deleteLines'), 0);
});

test('12. 고객이 다른 세션이면(client 불일치) 첫 줄부터 쓰지 않는다', async () => {
  const erp = makeErp({ wrongClient: true });
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'skipped'); assert.match(r.reason, /client/);
  assert.equal(count(erp, 'postLine'), 0);
});

test('13. postJun 명시 실패 · 판매내역 미확인 → fatal(결제 후라 되돌리지 않음)', async () => {
  const a = makeErp({ junFails: true });
  const ra = await C.slRunClient(plan(), a, hooks);
  assert.equal(ra.status, 'fatal'); assert.match(ra.reason, /^jun_failed/); assert.equal(count(a, 'deleteLines'), 0);
  const b = makeErp({ noSales: true });
  const rb = await C.slRunClient(plan(), b, hooks);
  assert.equal(rb.status, 'fatal'); assert.match(rb.reason, /^sale_unverified/); assert.equal(rb.paid, true);
});

test('14. 결제 후 판매폼 GET 이 죽어도(예외) 되돌리지 않고 fatal — 넣은 줄 삭제 0 · 결제 재전송 0', async () => {
  const erp = makeErp({ formThrowsAfterPay: true });
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'fatal', r.reason); assert.equal(r.paid, true);
  assert.equal(count(erp, 'deleteLines'), 0); assert.equal(count(erp, 'postJun'), 0); assert.equal(erp.srv.cashPosts, 1);
});

test('15. 결제 후 판매폼의 form10 이 불완전하면(누락 필드·missing) postJun 0 · fatal:form10_incomplete', async () => {
  for (const o of [{ dropForm10: 'regId' }, { missingAfterPay: true }]) {
    const erp = makeErp(o);
    const r = await C.slRunClient(plan(), erp, hooks);
    assert.equal(r.status, 'fatal'); assert.match(r.reason, /^form10_incomplete:.*regId/); assert.equal(r.paid, true);
    assert.equal(count(erp, 'postJun'), 0); assert.equal(count(erp, 'deleteLines'), 0); assert.equal(erp.srv.cashPosts, 1);
  }
});

test('16. 판매폼에 sKey 가 없으면 postLine 0 (쓰기 전 중단)', async () => {
  const erp = makeErp({ noSKey: true });
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'skipped'); assert.equal(r.reason, 'no_sKey');
  assert.equal(count(erp, 'postLine'), 0); assert.equal(count(erp, 'deleteLines'), 0);
});

test('17. 결제 폼에 이미 payJun 이 있으면 already_paid — 삭제 0 · 결제 0 · fatal', async () => {
  const erp = makeErp({ cashAlreadyPaid: true });
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'fatal'); assert.equal(r.reason, 'already_paid');
  assert.equal(count(erp, 'deleteLines'), 0); assert.equal(count(erp, 'postCash'), 0); assert.equal(count(erp, 'postJun'), 0);
});

test('18. 결제 후 판매폼의 전표가 바뀌었으면(session_changed) postJun 0 · fatal', async () => {
  const erp = makeErp({ switchAfterPay: true });
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'fatal'); assert.match(r.reason, /^session_changed/);
  assert.equal(count(erp, 'postJun'), 0); assert.equal(count(erp, 'deleteLines'), 0);
});

test('19. 줄 수정 폼에서 판매직원을 못 읽으면(no_sale_manager) postModify 0 · 내 줄 되돌리기', async () => {
  const erp = makeErp({ noManager: true });
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'skipped', r.reason); assert.match(r.reason, /^modify_payload:.*no_sale_manager/);
  assert.equal(count(erp, 'postModify'), 0); assert.equal(count(erp, 'postCash'), 0);
  assert.equal(count(erp, 'deleteLines'), 1); assert.equal(r.rolledBack, 2);
});

test('20. 첫 수정 뒤 다른 탭이 줄을 끼워 넣음 → 둘째 postModify 0 · postCash 0 · 내 줄 되돌리고 fatal:foreign_rows_remain', async () => {
  const erp = makeErp({ foreignAfterModify: true });
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'fatal', r.reason); assert.match(r.reason, /^foreign_rows_remain:modify_session:rows/);
  assert.equal(count(erp, 'postModify'), 1); assert.equal(count(erp, 'postCash'), 0); assert.equal(count(erp, 'postJun'), 0);
  assert.equal(count(erp, 'deleteLines'), 1); assert.ok(erp.srv.rows.some((x) => x.saleSeq === '999999'), '남의 줄은 그대로');
});

test('21. 수정 POST 응답에 낯선 줄이 섞여 있으면 postCash 0 · 내 줄 되돌리고 skipped:modify_rows', async () => {
  const erp = makeErp({ modifyExtraRow: true });
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'skipped', r.reason); assert.match(r.reason, /^modify_rows:/);
  assert.equal(count(erp, 'postModify'), 1); assert.equal(count(erp, 'postCash'), 0); assert.equal(count(erp, 'deleteLines'), 1);
});

test('22. 결제 뒤 다른 탭이 0원 줄을 끼움 → postJun 0 · fatal:jun_rows · 삭제 0 · 결제 1회', async () => {
  const erp = makeErp({ foreignAfterCash: true });
  const r = await C.slRunClient(plan(), erp, hooks);
  assert.equal(r.status, 'fatal', r.reason); assert.match(r.reason, /^jun_rows/);
  assert.equal(count(erp, 'postJun'), 0); assert.equal(count(erp, 'deleteLines'), 0); assert.equal(erp.srv.cashPosts, 1);
});
