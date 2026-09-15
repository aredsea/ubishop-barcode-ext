/* =============================================================================
 *  orderimport-run.test.js — 실행기(oiRunOrder/oiRunAll) 배선 테스트. erp 어댑터를 스텁으로 갈아 끼워
 *  "가드 실패·외부 개입·완료 실패 때 쓰기를 부르지 않고 되돌린다" 를 고정한다. 네트워크 없음.
 *  스펙: docs/superpowers/specs/2026-09-14-orderimport-design.md §3.4·§5
 *  실행: node --test tests/orderimport-run.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'src', 'orderimport-core.js'));

const MASTER = { seq: '7083', code: 'F-RF-I-WG-PA-00F6', name: 'F-퓨어컷팅(실버)R' };
function order(lines) {
  return {
    key: '아몬즈|2178934182592088', seller: '아몬즈', orderNo: '2178934182592088',
    market: { name: '아몬즈', suffix: '아', clientJob: '18' },
    buyer: '차카타', phone: { phone: '106-0000-2567', last4: '2567', ok: true, raw: '106-0000-2567' },
    clientName: '차카타2567/아',
    lines: lines || [
      { master: MASTER, spec: { k: '925', color: null, itemSize: '17', qty: 1, price: 17000, remark: '정산 12,033 원' } },
      { master: MASTER, spec: { k: '925', color: null, itemSize: '9', qty: 1, price: 17000, remark: '정산 12,087 원' } }
    ]
  };
}
const KOPTS = [{ value: '5', text: '925', selected: true }];
const COLOR = [{ value: '', text: '- 색상 -' }, { value: 'WG', text: 'WG (화이트)', selected: true }, { value: 'PG', text: 'PG (핑크)' }];
function formValues(over) {
  return Object.assign({ sKey: '1', pageSize: '20', searchSortType: 'seq', tradeJun: '', payJun: '', shop: 'LT', client: '123784', master: '7083', itemType: '1',
    inputPrice: '4500', orgOrderPrice: '19000', shopName: 'FASHION', clientName: '차카타2567/아', itemNum: 'FRFIWGPA00F6', weight: '0', doc: '', diaColor: '',
    clarity: '', surface: '', k: '5', color: 'WG', itemSize: '11', orderQty: '1', orderPrice: '19,000', shopRemark: '' }, over || {});
}
function form10Values(over) {
  return Object.assign({ sKey: '2', pageSize: '20', searchSortType: 'seq', tradeJun: '141236', payJun: '', shop: 'LT', client: '123784', payBank: '0', payDia: '0',
    txtOrderDate: '26-09-14', exdelivedyear: '2026', exdelivedmonth: '01', exdelivedday: '01', regId: '담당자', beforePrice: '0', payPrice: '0', afterPrice: '0',
    payCard: '0', paySaleOldGold: '0', payCash: '0', payCashPaper: '0', payEtc: '0', payRemark: '' }, over || {});
}
const row = (seq, tradeJun, size, remark) => ({ orderSeq: seq, tradeJun, code: MASTER.code, remark, name: MASTER.name, k: '925', weight: '0 g', color: '화이트', size, qty: '1', price: '17,000' });

//  스텁 erp: 서버의 '열린 주문장' 을 흉내 낸다. opts 로 시나리오를 바꾼다.
function makeErp(opts) {
  opts = opts || {};
  const calls = [];
  const srv = { tradeJun: opts.openTrade || '', rows: [], seqNo: 389460, clients: opts.clients || [] };
  const state = () => ({ tradeJun: srv.tradeJun, client: srv.tradeJun ? '123784' : '', rows: srv.rows.length });
  return {
    calls, srv,
    async state() { calls.push(['state']); return state(); },
    async searchClient(type, word) { calls.push(['searchClient', type, word]); return srv.clients.filter((c) => type === 'phone' ? c.phone === word : c.name.includes(word)); },
    async registerClient(name, phone, clientJob) { calls.push(['registerClient', name, phone, clientJob]); if (opts.registerFails) return { ok: false, msg: '등록 실패', client: null }; const c = { seq: '123784', name, phone }; srv.clients.push(c); return { ok: true, msg: '', client: c }; },
    async getWriteForm(p) { calls.push(['getWriteForm', p.tradeJun, p.master, p.client]); if (opts.foreignRowAt != null && !srv.injected && srv.rows.length === opts.foreignRowAt) { srv.injected = true; srv.rows.push(Object.assign(row('999999', srv.tradeJun || '141236', '40', ''), { code: 'T-EF-I-WG-ZZ-00H8' })); } return { values: formValues({ tradeJun: srv.tradeJun, client: p.client, master: p.master }), missing: [], kOpts: KOPTS, colorOpts: COLOR, arrays: { arr_weight: [0, 0], arr_salePrice: [19000, 0], arr_inputSupply: [4500, 0] }, rows: srv.rows.slice(), defaults: { k: '5', color: 'WG', itemSize: '11' } }; },
    async postLine(fields) { calls.push(['postLine', Object.fromEntries(fields)]); if (opts.lineFailsAt != null && srv.rows.length === opts.lineFailsAt) return { ok: false, msg: '실패', tradeJun: srv.tradeJun, rows: srv.rows.slice() }; if (!srv.tradeJun) srv.tradeJun = '141236'; const f = Object.fromEntries(fields); srv.rows.push(row(String(++srv.seqNo), srv.tradeJun, f.itemSize, f.shopRemark)); return { ok: true, msg: '', tradeJun: srv.tradeJun, rows: srv.rows.slice() }; },
    async getForm10(p) { calls.push(['getForm10', p.tradeJun]); return { values: form10Values({ tradeJun: srv.tradeJun, client: p.client }), missing: [], rows: srv.rows.slice() }; },
    async postComplete(fields) { calls.push(['postComplete', Object.fromEntries(fields)]); if (opts.completeFails) return { ok: false, msg: '완료 실패' }; srv.tradeJun = ''; srv.rows = []; return { ok: true, msg: '' }; },
    async deleteLines(tradeJun, client, clientName, idxValues) { calls.push(['deleteLines', tradeJun, idxValues.slice()]); if (opts.deleteFails) return { ok: false, msg: 'x' }; const seqs = idxValues.map((v) => v.split(',')[0]); srv.rows = srv.rows.filter((r) => !seqs.includes(r.orderSeq)); if (!srv.rows.length) srv.tradeJun = ''; return { ok: true, msg: '' }; },
    async findJunNums(orderSeqs) { calls.push(['findJunNums', orderSeqs.slice()]); return orderSeqs.map((s) => ({ orderSeq: s, junNum: '0000002YF5', status: '주문완료' })); }
  };
}
const hooks = { today: () => new Date(2026, 8, 14), log() {} };
const names = (erp) => erp.calls.map((c) => c[0]);

test('정상 경로: 신규 고객 등록 → 줄 2개 → 완료 → 관리번호', async () => {
  const erp = makeErp();
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'done');
  assert.deepEqual(r.client, { seq: '123784', name: '차카타2567/아', mode: 'new' });
  assert.equal(r.orderSeqs.length, 2);
  assert.equal(r.tradeJun, '141236');
  assert.equal(r.junNums[0].junNum, '0000002YF5');
  const posts = erp.calls.filter((c) => c[0] === 'postLine').map((c) => c[1]);
  assert.deepEqual(posts.map((p) => p.itemSize), ['17', '9']);
  assert.deepEqual(posts.map((p) => p.orderPrice), ['17,000', '17,000']);
  assert.equal(posts[1].tradeJun, '141236', '둘째 줄은 첫 줄이 만든 tradeJun 을 실어야 한다');
  const done = erp.calls.find((c) => c[0] === 'postComplete')[1];
  assert.equal(done.exdelivedmonth, '09'); assert.equal(done.exdelivedday, '14');
  assert.deepEqual(erp.srv.rows, [], '완료 후 서버 목록이 비어야 한다');
});

test('고객 재사용: 정확일치 고객이 있으면 등록하지 않는다(부분일치 후보는 무시)', async () => {
  const erp = makeErp({ clients: [{ seq: '111', name: '차카타2567/아', phone: '106-0000-2567' }, { seq: '222', name: '차카타2567/아(구)', phone: '' }] });
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'done');
  assert.equal(r.client.seq, '111'); assert.equal(r.client.mode, 'reuse');
  assert.ok(!names(erp).includes('registerClient'));
});

test('예물고객 충돌: 다른 이름이 같은 휴대폰이면 휴대폰 빈칸으로 등록', async () => {
  const erp = makeErp({ clients: [{ seq: '333', name: '라마바/차카타', phone: '106-0000-2567' }] });
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'done');
  const reg = erp.calls.find((c) => c[0] === 'registerClient');
  assert.equal(reg[2], '', '휴대폰이 비어야 한다'); assert.equal(reg[3], '18');
  assert.equal(r.client.mode, 'new_nophone');
});

test('가드: 열린 주문장이 있으면 아무 쓰기도 하지 않고 skipped', async () => {
  const erp = makeErp({ openTrade: '141228' });
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'skipped'); assert.equal(r.reason, 'open_trade');
  assert.deepEqual(names(erp), ['state']);
});

test('외부 개입: 줄 사이에 남의 줄이 끼면 내 줄만 되돌리고 fatal, 완료 POST 없음', async () => {
  const erp = makeErp({ foreignRowAt: 1 });          // 첫 줄 등록 뒤 GET 에서 남의 줄이 보인다
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'fatal', '남의 줄이 세션에 남아 있으면 다음 주문장도 못 가므로 전체 중단');
  assert.match(r.reason, /^foreign_rows_remain:mismatch:/);
  const del = erp.calls.find((c) => c[0] === 'deleteLines');
  assert.deepEqual(del[2], [r.orderSeqs[0] + ',141236'], '내가 넣은 orderSeq 만 삭제');
  assert.ok(!names(erp).includes('postComplete'));
  assert.equal(erp.srv.rows.length, 1); assert.equal(erp.srv.rows[0].orderSeq, '999999', '남의 줄은 남긴다');
  assert.equal(r.rolledBack, 1);
});

test('줄 등록 실패(msg): 되돌리고 skipped', async () => {
  const erp = makeErp({ lineFailsAt: 1 });
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'skipped'); assert.match(r.reason, /^line_failed/);
  assert.equal(erp.srv.rows.length, 0); assert.equal(r.rolledBack, 1);
});

test('완료 실패: 줄 전부 되돌리고 skipped', async () => {
  const erp = makeErp({ completeFails: true });
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'skipped'); assert.match(r.reason, /^complete_failed/);
  assert.equal(r.rolledBack, 2); assert.equal(erp.srv.rows.length, 0);
});

test('되돌리기 실패 → fatal, oiRunAll 은 다음 주문장을 blocked 로 남긴다', async () => {
  const erp = makeErp({ completeFails: true, deleteFails: true });
  const rs = await C.oiRunAll([order(), Object.assign(order(), { key: 'B' })], erp, hooks);
  assert.equal(rs[0].status, 'fatal'); assert.match(rs[0].reason, /^rollback_failed/);
  assert.equal(rs[1].status, 'blocked');
});

test('고객 등록 실패: 줄 POST 없이 skipped', async () => {
  const erp = makeErp({ registerFails: true });
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'skipped'); assert.match(r.reason, /^register_failed/);
  assert.ok(!names(erp).includes('postLine'));
});

test('페이로드 문제(품위 옵션 없음): POST 없이 skipped', async () => {
  const erp = makeErp();
  const o = order([{ master: MASTER, spec: { k: '14', color: null, itemSize: '17', qty: 1, price: 17000, remark: '' } }]);
  const r = await C.oiRunOrder(o, erp, hooks);
  assert.equal(r.status, 'skipped'); assert.match(r.reason, /^payload:품위 옵션 없음/);
  assert.ok(!names(erp).includes('postLine'));
});

//  Terra 1R P1 (2026-09-15): 완료 성공 뒤 확인 GET 이 죽으면 catch 가 fail() 로 들어가 **완료된 주문장의 줄을 지우려 했다**.
test('완료 성공 뒤 state() 가 던지면 deleteLines 를 부르지 않고 fatal(complete_unverified)', async () => {
  const erp = makeErp();
  const origState = erp.state.bind(erp); let n = 0;
  erp.state = async () => { n++; if (n === 2) throw new Error('timeout'); return origState(); };   // 1=가드, 2=완료 후 확인
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'fatal'); assert.match(r.reason, /^complete_unverified:/);
  assert.ok(!names(erp).includes('deleteLines'), '완료된 주문장에 삭제를 걸면 안 된다');
  assert.equal(r.orderSeqs.length, 2, '넣은 줄 기록은 남긴다(사람이 전표로 확인)');
});

//  Terra 1R P1 (2026-09-15): 되돌리기 자체가 던지면 fail() 이 던져 oiRunAll 까지 reject 됐다 — 결과에 fatal 이 남지 않았다.
test('deleteLines 가 던지면 fatal(rollback_exception) 로 끝나고 oiRunAll 은 다음 주문장을 blocked 로 남긴다', async () => {
  const erp = makeErp({ completeFails: true });
  erp.deleteLines = async () => { erp.calls.push(['deleteLines']); throw new Error('network'); };
  const rs = await C.oiRunAll([order(), Object.assign(order(), { key: 'B' })], erp, hooks);
  assert.equal(rs[0].status, 'fatal'); assert.match(rs[0].reason, /^rollback_exception:/);
  assert.equal(rs[1].status, 'blocked');
});

test('되돌리기 뒤 확인 GET 이 던져도 fatal 로 남는다', async () => {
  const erp = makeErp({ completeFails: true });
  const origGet = erp.getWriteForm.bind(erp); let deleted = false;
  const origDel = erp.deleteLines.bind(erp);
  erp.deleteLines = async (...a) => { deleted = true; return origDel(...a); };
  erp.getWriteForm = async (p) => { if (deleted) throw new Error('timeout'); return origGet(p); };
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'fatal'); assert.match(r.reason, /^rollback_exception:/);
});

test('oiRunAll: oiRunOrder 가 예외로 죽어도 fatal 결과를 남기고 나머지를 blocked 로', async () => {
  const erp = makeErp();
  erp.state = async () => { throw new Error('boom'); };
  erp.deleteLines = async () => { throw new Error('boom2'); };
  const rs = await C.oiRunAll([order(), Object.assign(order(), { key: 'B' })], erp, hooks);
  assert.equal(rs.length, 2);
  assert.ok(rs[0].status === 'fatal' || rs[0].status === 'skipped');
  if (rs[0].status === 'fatal') assert.equal(rs[1].status, 'blocked');
});

//  Terra 2R P1 (2026-09-15): 완료 POST 가 서버에서는 처리됐는데 응답만 유실(throw)되면 completed 가 안 서서 되돌리기로 들어갔다.
test('postComplete 가 던지면(응답 유실) 삭제하지 않고 fatal(complete_unverified), 다음 주문장 blocked', async () => {
  const erp = makeErp();
  erp.postComplete = async () => { erp.calls.push(['postComplete']); erp.srv.tradeJun = ''; erp.srv.rows = []; throw new Error('timeout'); };   // 서버는 완료됨
  const rs = await C.oiRunAll([order(), Object.assign(order(), { key: 'B' })], erp, hooks);
  assert.equal(rs[0].status, 'fatal'); assert.match(rs[0].reason, /^complete_unverified:/);
  assert.ok(!names(erp).includes('deleteLines'));
  assert.equal(rs[1].status, 'blocked');
});

//  Terra 2R P1 (2026-09-15): 첫 줄 POST 가 서버에 줄을 만든 뒤 응답 유실 → orderSeqs 가 비어 되돌릴 게 없다고 보고 skipped 로 계속 갔다.
test('postLine 이 던졌는데 서버에 줄이 남아 있으면 삭제 없이 fatal(line_unverified)', async () => {
  const erp = makeErp();
  const origPost = erp.postLine.bind(erp);
  erp.postLine = async (fields) => { await origPost(fields); throw new Error('connection reset'); };   // 줄은 생겼는데 응답이 죽음
  const rs = await C.oiRunAll([order(), Object.assign(order(), { key: 'B' })], erp, hooks);
  assert.equal(rs[0].status, 'fatal'); assert.match(rs[0].reason, /^line_unverified:/);
  assert.ok(!names(erp).includes('deleteLines'), '무엇이 들어갔는지 모르는 줄은 지우지 않는다');
  assert.equal(rs[1].status, 'blocked');
});

test('postLine 이 던졌고 서버에 아무것도 없으면 skipped(다음 주문장 계속)', async () => {
  const erp = makeErp();
  erp.postLine = async () => { erp.calls.push(['postLine']); throw new Error('connection reset'); };   // 서버에 줄이 안 생김
  const rs = await C.oiRunAll([order(), Object.assign(order(), { key: 'B' })], erp, hooks);
  assert.equal(rs[0].status, 'skipped'); assert.match(rs[0].reason, /^line_exception:/);
  assert.notEqual(rs[1].status, 'blocked');
});

test('완료 응답은 성공인데 세션에 남으면 fatal(세션 오염 신호)', async () => {
  const erp = makeErp();
  erp.postComplete = async (fields) => { erp.calls.push(['postComplete']); return { ok: true, msg: '' }; };   // 서버가 비우지 않음
  const r = await C.oiRunOrder(order(), erp, hooks);
  assert.equal(r.status, 'fatal'); assert.equal(r.reason, 'session_not_clear');
});
