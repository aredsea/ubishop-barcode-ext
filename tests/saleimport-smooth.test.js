/* saleimport 4.3.5 — 실사용에서 막힌 6가지 매끄러움 수정. 스펙 §10.7(검색 잘림) · §10.8(이름 형태·전부 반품·구분).
 * 실행: node --test tests/saleimport-smooth.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'src', 'saleimport-core.js'));
const FX = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'saleimport', n), 'utf8').replace(/\r\n/g, '\n');
const CP = JSON.parse(FX('rows-coupang.json'));
const AM = JSON.parse(FX('rows-amondz.json'));
const ROOT = path.join(__dirname, '..');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'saleimport.js'), 'utf8').replace(/\r\n/g, '\n');

/* ---- 1. 검색 잘림: 목록 전체 행 수로 비교 (선택 가능한 행만 세면 오탐) ---- */
test('slSearchResult: 20행 목록 중 13행만 선택 가능 — 잘림 아님(예비고객·타매장 행은 선택 불가)', () => {
  const r = C.slSearchResult(FX('client-search-mixed.html'));
  assert.equal(r.rows.length, 13);
  assert.equal(r.truncated, false);
});
test('slSearchResult: 진짜 잘림은 계속 차단 — 첫 No 가 목록 행 수보다 크거나 목록이 100행 이상', () => {
  const html = FX('client-search-mixed.html');
  const cut = html.replace('<td height="28">20</td>', '<td height="28">25</td>');
  assert.notEqual(cut, html);
  assert.equal(C.slSearchResult(cut).truncated, true);
  const row1 = html.match(/<tr align="center">[^\n]*<\/tr>/)[0];
  const big = html.replace(row1, new Array(100).fill(row1.replace('<td height="28">20</td>', '<td height="28">120</td>')).join('\n'));
  assert.equal(C.slSearchResult(big).truncated, true);
});

test('slSearchResult: 같은 t_list 표 밖의 뒤따르는 숫자 표는 세지 않는다 — 잘림을 숨기지 못함', () => {
  const html = FX('client-search-mixed.html');
  const cut = html.replace('<td height="28">20</td>', '<td height="28">25</td>');
  const trail = '<table class="other">' + new Array(10).fill('<tr><td>7</td><td>x</td></tr>').join('') + '</table>';
  const withTrail = cut.replace('</form>', trail + '</form>');
  assert.notEqual(withTrail, cut);
  assert.equal(C.slSearchResult(withTrail).truncated, true);
  assert.equal(C.slSearchResult(html.replace('</form>', trail + '</form>')).truncated, false);
});
test('slSearchResult: 선택 가능 행이 100 이상이면 잘림(옛 가드 복원)', () => {
  const html = FX('client-search-mixed.html');
  const row = (n) => '<tr align="center"> <td height="28">' + n + '</td> <td class="f_bold">고객Z' + n + '</td> <td>FASHION</td> <td></td> <td></td> <td> <a href="javascript:setSeting(form1,\'0\',\'' + (800000 + n) + '\');">x</a> </td> <td></td> </tr>';
  const many = html.replace(/<tr align="center">[\s\S]*<\/table>/, new Array(100).fill(0).map((_, i) => row(500 + i)).join('\n') + '</table>');
  assert.equal(C.slSearchResult(many).rows.length, 100);
  assert.equal(C.slSearchResult(many).truncated, true);
});

/* ---- 2. 공백·ASCII 대소문자만 다른 이름 ---- */
test('slSearchWord: 검색어에서 공백을 모두 뺀다', () => {
  assert.equal(C.slSearchWord('Ann Lee2827/쿠'), 'AnnLee2827/쿠');
  assert.equal(C.slSearchWord(' 가 나\t다 '), '가나다');
});
test('slSearchMerged: 두 형태가 다르면 항상 둘 다 검색 · seq 로 합침 · 같은 형태·잘림이면 한 번', async () => {
  const calls = [];
  const db = { 'Ann Lee2827/쿠': { rows: [], truncated: false }, 'AnnLee2827/쿠': { rows: [{ seq: '7', name: 'AnnLee2827/쿠', phone: '' }], truncated: false } };
  const search = async (w) => { calls.push(w); return db[w] || { rows: [], truncated: false }; };
  const r = await C.slSearchMerged(search, 'Ann Lee2827/쿠');
  assert.deepEqual(calls, ['Ann Lee2827/쿠', 'AnnLee2827/쿠']);
  assert.equal(r.rows.length, 1);
  calls.length = 0;
  db['Ann Lee2827/쿠'] = { rows: [{ seq: '8', name: 'Ann Lee2827/쿠', phone: '' }], truncated: false };
  assert.equal((await C.slSearchMerged(search, 'Ann Lee2827/쿠')).rows.length, 2);   // 원본에서 후보가 나와도 공백 제거형을 건너뛰지 않는다
  assert.deepEqual(calls, ['Ann Lee2827/쿠', 'AnnLee2827/쿠']);
  calls.length = 0;
  const m = await C.slSearchMerged(async (w) => { calls.push(w); return w === 'A B1' ? { rows: [{ seq: '1' }], truncated: false } : { rows: [{ seq: '1' }, { seq: '2' }], truncated: true }; }, 'A B1');
  assert.deepEqual(m.rows.map((x) => x.seq), ['1', '2']); assert.equal(m.truncated, true);
  calls.length = 0;
  const t = await C.slSearchMerged(async (w) => { calls.push(w); return { rows: [{ seq: '1' }], truncated: true }; }, 'A B1');
  assert.deepEqual(calls, ['A B1']); assert.equal(t.truncated, true);   // 첫 검색이 잘렸으면 그대로 잘림 — 두 번째는 하지 않는다
  calls.length = 0;
  await C.slSearchMerged(search, 'NoSpace');
  assert.deepEqual(calls, ['NoSpace']);
});
test('slSearchMerged + slAutoDecision: 원본 형태와 공백 제거형에 서로 다른 후보가 있으면 둘 다 보고 자동하지 않는다(정확 후보 2명 → 모호 차단)', async () => {
  const db = { 'Ann Lee2827/쿠': { rows: [{ seq: '11', name: 'Ann Lee2827/쿠', phone: '' }], truncated: false }, 'AnnLee2827/쿠': { rows: [{ seq: '22', name: 'AnnLee2827/쿠', phone: '' }], truncated: false } };
  const sr = await C.slSearchMerged(async (w) => db[w] || { rows: [], truncated: false }, 'Ann Lee2827/쿠');
  assert.deepEqual(sr.rows.map((x) => x.seq), ['11', '22']);
  const ad = { clientRule: 'exact', suffix: '쿠', ciSuffix: true };
  const g = { key: 'Ann Lee2827/쿠' };
  assert.equal(C.slClientCandidates(sr.rows, g, ad).length, 2);
  const dec = C.slAutoDecision({ hits: sr.rows, truncated: sr.truncated }, g, ad);
  assert.equal(dec.auto, null);
  const fbHits = [{ seq: '11', name: 'Ann Lee2827/쿠' }, { seq: '22', name: 'AnnLee2827/쿠' }];
  assert.equal(C.slFallbackCandidates(fbHits, 'Ann Lee').length, 2);
});
test('panel: 원장 묶음만 원본+공백 제거형 검색 · 그 밖의 정확 이름 경로는 원본 키로 검색 · 일찍 끝내는 accept 없음', () => {
  assert.ok(/viaLedger\(e\)\s*\?\s*await C\.slSearchMerged\(\(w\) => E\.searchClient\(w\), e\.key\)/.test(UI));
  assert.ok(/E\.searchClient\(p4 \? e\.buyer : e\.key\)/.test(UI));
  assert.ok(!/E\.searchClient\(p4 \? e\.buyer : C\.slSearchWord/.test(UI));
  assert.ok(/C\.slSearchMerged\(\(w\) => E\.searchClient\(w\), e\.buyer\)/.test(UI));
});
test('panel: 폴백 자동 선택을 다시 읽어 ok 가 아니거나 던지면 client·how 를 비우고 후보 목록은 고를 수 있게 둔다', () => {
  const m = UI.match(/if \(r\.auto\) \{[\s\S]*?return;/);
  assert.ok(m);
  assert.ok(/try \{ await matchEntry\(e\)/.test(m[0]) && /catch \(err\)/.test(m[0]));
  assert.ok(/e\.st !== 'ok'/.test(m[0]) && /e\.client = null; e\.how = ''/.test(m[0]) && /e\.cands = r\.cands/.test(m[0]));
});
test('slClientCandidates: 원장 고객명은 공백·ASCII 대소문자를 무시하고 비교(접미 대소문자는 기존대로)', () => {
  const ad = { clientRule: 'exact', suffix: '쿠', ciSuffix: true };
  const g = { key: 'Ann Lee2827/쿠' };
  assert.equal(C.slClientCandidates([{ name: 'AnnLee2827/쿠', seq: '1' }], g, ad).length, 1);
  assert.equal(C.slClientCandidates([{ name: 'ANNLEE2827/쿠', seq: '1' }], g, ad).length, 1);
  assert.equal(C.slClientCandidates([{ name: 'Ann Lee2827/쿠', seq: '1' }], { key: 'AnnLee2827/쿠' }, ad).length, 1);
  assert.equal(C.slClientCandidates([{ name: 'AnnLee2828/쿠', seq: '1' }], g, ad).length, 0);
  assert.equal(C.slClientCandidates([{ name: 'AnnLee2827', seq: '1' }], g, ad).length, 0);
  const s = { key: 'Bo Kim0021/s' };
  assert.equal(C.slClientCandidates([{ name: 'BoKim0021/S', seq: '1' }], s, { clientRule: 'exact', suffix: 's', ciSuffix: true }).length, 1);
});

/* ---- 3. 다른 이름 형태로 등록된 고객 — 주문이 입증할 때만 자동 ---- */
const H = (names) => names.map((name, i) => ({ name, seq: String(100 + i), phone: '' }));
test('slFallbackCandidates: ^수령자\\d{4}(/.*)?$ — 공백·ASCII 대소문자 무시, "수령자/타인" 꼴 제외', () => {
  const hits = H(['Ann Lee8275', 'ANNLEE0021/S', 'AnnLee2827/쿠', 'AnnLee/Bo Kim', 'Bo AnnLee1234', 'AnnLee12345', 'AnnLee123', 'AnnLeeX1234']);
  const got = C.slFallbackCandidates(hits, 'Ann Lee').map((h) => h.name);
  assert.deepEqual(got, ['Ann Lee8275', 'ANNLEE0021/S', 'AnnLee2827/쿠']);
  assert.deepEqual(C.slFallbackCandidates([], 'Ann Lee'), []);
  assert.deepEqual(C.slFallbackCandidates(hits, ''), []);
});
test('slFallbackDecide: 자동 = ok 1명 + 나머지 전부 none · 그 밖은 차단(사유에 후보별 결과)', () => {
  const c = (name, status, reason) => ({ cand: { name, seq: name }, result: { status, reason: reason || '' } });
  const one = C.slFallbackDecide([c('A1', 'none'), c('A2', 'ok')]);
  assert.equal(one.auto.name, 'A2');
  assert.equal(C.slFallbackDecide([c('A2', 'ok')]).auto.name, 'A2');
  const miss = C.slFallbackDecide([c('A1', 'block', '기존 미수금 있음'), c('A2', 'ok')]);
  assert.equal(miss.auto, null); assert.match(miss.reason, /A1/); assert.match(miss.reason, /미수금/); assert.match(miss.reason, /A2/);
  const sold = C.slFallbackDecide([c('A2', 'ok'), c('A3', 'sold')]);
  assert.equal(sold.auto, null); assert.match(sold.reason, /A3/);
  const bar = C.slFallbackDecide([c('A2', 'ok'), c('A4', 'block', '바코드 없는 주문 줄 — 입고 확인')]);
  assert.equal(bar.auto, null); assert.match(bar.reason, /바코드/);
  const two = C.slFallbackDecide([c('A1', 'ok'), c('A2', 'ok')]);
  assert.equal(two.auto, null); assert.match(two.reason, /A1/); assert.match(two.reason, /A2/);
  const none = C.slFallbackDecide([c('A1', 'block', '미수금'), c('A3', 'sold')]);
  assert.equal(none.auto, null); assert.match(none.reason, /A1/); assert.match(none.reason, /A3/);
  assert.equal(C.slFallbackDecide([c('A1', 'none'), c('A3', 'none')]).auto, null);
  assert.equal(C.slFallbackDecide([]).auto, null);
});
test('slProbeNone: 주문내역에 필요한 정산액 줄이 하나도 없을 때만 true (원장·perUnit·perOrder)', () => {
  const rows = parseCp([{ no: '9300000001', pay: 15567 }]).rows;
  const led = new Map([['9300000001', [{ order_no: '9300000001', market: '쿠팡', amount: 15567, is_gift: false }, { order_no: '9300000001', market: '쿠팡', amount: 0, is_gift: true }]]]);
  const o = (settle, extra) => Object.assign({ settle, gift: false, barcode: 'B' + settle, code: 'C', date: '2026-10-01', price: settle }, extra || {});
  assert.equal(C.slProbeNone(rows, led, [], 'ledger'), true);
  assert.equal(C.slProbeNone(rows, led, [o(999)], 'ledger'), true);
  assert.equal(C.slProbeNone(rows, led, [o(999), o(15567, { gift: true })], 'ledger'), true);
  assert.equal(C.slProbeNone(rows, led, [o(15567)], 'ledger'), false);
  assert.equal(C.slProbeNone(rows, led, [o(15567, { barcode: '' })], 'ledger'), false);
  assert.equal(C.slProbeNone(rows, new Map(), [], 'ledger'), false);   // 원장을 못 읽으면 판정 불가
  const pu = [{ orderNo: 'X', key: 20000, W: 20000, qty: 2, amount: 40000 }];
  assert.equal(C.slProbeNone(pu, null, [o(5000)], 'perUnit'), true);
  assert.equal(C.slProbeNone(pu, null, [o(5000), o(10000)], 'perUnit'), false);
  assert.equal(C.slProbeNone([{ orderNo: 'Y', key: 7001, W: 7001, qty: 2, amount: 7001 }], null, [], 'perUnit'), false);   // 나누어지지 않음 — 판정 불가
  assert.equal(C.slProbeNone([{ orderNo: 'Z', key: 8000, amount: 8000 }], null, [o(1)], 'perOrder'), true);
  assert.equal(C.slProbeNone([{ orderNo: 'Z', key: 8000, amount: 8000 }], null, [o(8000)], 'perOrder'), false);
});
test('panel: 후보 점검 결과는 slProbeNone 으로 none 을 가른다(정상 경로 e.match 는 그대로)', () => {
  assert.ok(/if \(probe\) \{[\s\S]*?C\.slProbeNone\(/.test(UI));
});
test('slFallbackResolve: 후보 6명 이상은 조회 없이 차단 · 1명만 ok 면 자동 · 순차 조회', async () => {
  let calls = 0, live = 0, maxLive = 0;
  const ev = async (cand) => { calls++; live++; maxLive = Math.max(maxLive, live); await null; live--; return { status: cand.name === 'AnnLee2222' ? 'ok' : 'none', reason: '' }; };
  const many = await C.slFallbackResolve(H(['AnnLee1111', 'AnnLee2222', 'AnnLee3333', 'AnnLee4444', 'AnnLee5555', 'AnnLee6666']), 'AnnLee', ev);
  assert.equal(calls, 0); assert.equal(many.auto, null); assert.match(many.reason, /후보가 너무 많음/); assert.equal(many.cands.length, 6);
  const five = await C.slFallbackResolve(H(['AnnLee1111', 'AnnLee2222', 'AnnLee3333', 'AnnLee4444', 'AnnLee5555']), 'AnnLee', ev);
  assert.equal(calls, 5); assert.equal(maxLive, 1);
  assert.equal(five.auto.name, 'AnnLee2222'); assert.ok(five.auto.result.status === 'ok');
  const zero = await C.slFallbackResolve(H(['Other/BoKim']), 'AnnLee', ev);
  assert.equal(zero.auto, null); assert.equal(zero.cands.length, 0);
});
test('panel: 폴백은 원장 출처 항목에서만, 읽기 대기열 안에서, 판매 시작되면 중단', () => {
  assert.ok(/e\.source === '원장'/.test(UI));
  assert.ok(/C\.slFallbackResolve\(/.test(UI));
  assert.ok(/S\.running \|\| S\.starting\) throw/.test(UI));
  assert.ok(/e\.how = '주문 확인'/.test(UI));
});

/* ---- 4·5. 전부 반품 · 구분(반품/배송비/조정) ---- */
const cpRow = (o) => {
  const h = CP[0], r = new Array(h.length).fill('');
  Object.entries({ '주문번호': o.no, '옵션 ID': o.opt || '9000', '상품명': o.name || '링', '옵션명': '', '판매수량': o.qty == null ? 1 : o.qty, '환불수량': o.ref || 0, '정산금액': o.pay, '구매자명': '고객A' })
    .forEach(([k, v]) => { r[h.indexOf(k)] = String(v); });
  return r;
};
const parseCp = (list) => C.slParseFile([CP[0]].concat(list.map(cpRow)));
test('slClassifyRows: 같은 주문번호의 판매 합 + 반품 합 = 0 이면 반품 행에 "전부 반품" 이름표만 — 판매 행은 빼지 않는다', () => {
  const p = parseCp([{ no: '9100000001', pay: 15567 }, { no: '9100000001', pay: -15567, ref: 1 }, { no: '9100000002', pay: 20000 }]);
  assert.equal(p.ok, true);
  const k = C.slClassifyRows(p.rows);
  assert.deepEqual(k.rows.filter((r) => !r.isReturn).map((r) => r.ledgerNo), ['9100000001', '9100000002']);
  assert.equal(k.rows.length, p.rows.length);
  const full = k.manual.filter((m) => m.kind === '전부 반품');
  assert.equal(full.length, 1); assert.equal(full[0].amount, -15567);
  assert.equal(full[0].note, '판매 행도 차단됨 — 유비샵 주문은 직접 정리');
  assert.equal(k.manual.filter((m) => m.kind === '반품').length, 0);
});
test('slClassifyRows: 같은 원장 주문번호라도 주문번호(orderNo)가 다르면(다른 옵션) 서로 상쇄하지 않는다 — 전부 반품 이름표 없음', () => {
  const p = parseCp([{ no: '9100000010', opt: '9000', pay: 15567 }, { no: '9100000010', opt: '9001', pay: -15567, ref: 1 }]);
  const k = C.slClassifyRows(p.rows);
  assert.equal(k.rows.filter((r) => !r.isReturn).length, 1);
  assert.equal(k.manual.filter((m) => m.kind === '전부 반품').length, 0);
  assert.equal(k.manual.filter((m) => m.kind === '반품').length, 1);
});
test('취소 후 재결제(이니시스 A001 +/A001 −/B002 +) — 판매 행을 그대로 두므로 같은 정산 줄 2개가 있어도 자동 판매하지 않고 차단', () => {
  const hdr = ['상점MID', 'TID', '주문번호', '구매자', '상품명', '거래금액', '지급액', '상태'];
  const p = C.slParseFile([hdr, ['m', 't1', 'A001', '고객A', '링', '50000', '49000', '승인'], ['m', 't2', 'A001', '고객A', '링', '-50000', '-49000', '취소'], ['m', 't3', 'B002', '고객A', '링', '50000', '49000', '승인'], ['합계', '', '', '', '', '50000', '49000', '']]);
  assert.equal(p.ok, true);
  const k = C.slClassifyRows(p.rows);
  assert.deepEqual(k.rows.filter((r) => !r.isReturn).map((r) => r.orderNo), ['A001', 'B002']);
  const L = (b) => ({ barcode: b, code: 'C', name: 'x', gift: false, settle: 49000, date: '26-10-01', cancel: false, price: 50000, qty: 1 });
  const grp = C.slGroupByClient(k.rows, p.adapter);
  assert.equal(grp.length, 1);
  const m = C.slMatchClient(grp[0].rows, [L('B1'), L('B2')], [], p.adapter.matchMode);
  assert.equal(m.status, 'block');
});
test('쿠팡 판매 + 같은 주문번호 전부 반품 — 이름표만 붙고 판매 행의 묶음은 "전부 반품된 주문" 사유로 차단', () => {
  const ad = C.SL_ADAPTERS.find((a) => a.id === 'coupang-revenue');
  const p = parseCp([{ no: '9100000020', pay: 39000 }, { no: '9100000020', pay: -39000, ref: 1 }]);
  const k = C.slClassifyRows(p.rows);
  assert.equal(k.manual.filter((m) => m.kind === '전부 반품').length, 1);
  const idx = C.slLedgerIndex([{ order_no: '9100000020', market: '쿠팡', recipient: 'Ann Lee', phone: '010-1111-5678', amount: 39000, is_gift: false, status: '정상' }], '쿠팡');
  const gs = C.slGroupLedger(k.rows, ad, idx, {});
  assert.equal(gs.length, 1);
  assert.ok(gs[0].retOrders.has('9100000020') && gs[0].retFull.has('9100000020'));
  const m = C.slMatchLedger(gs[0].rows, gs[0].ledger, [], [], { retOrders: gs[0].retOrders, retFull: gs[0].retFull });
  assert.equal(m.status, 'block'); assert.match(m.reason, /전부 반품된 주문 — 판매 안 함\(유비샵 주문은 직접 정리\)/);
  const part = parseCp([{ no: '9100000021', pay: 39000 }, { no: '9100000021', pay: -5000, ref: 1 }]);
  const idx2 = C.slLedgerIndex([{ order_no: '9100000021', market: '쿠팡', recipient: 'Ann Lee', phone: '010-1111-5678', amount: 39000, is_gift: false, status: '정상' }], '쿠팡');
  const g2 = C.slGroupLedger(C.slClassifyRows(part.rows).rows, ad, idx2, {})[0];
  assert.equal(g2.retFull.size, 0);
  assert.match(C.slMatchLedger(g2.rows, g2.ledger, [], [], { retOrders: g2.retOrders, retFull: g2.retFull }).reason, /같은 주문에 반품·제외 행이 있음/);
});
test('원장 주문의 다른 옵션끼리만 합이 0(9100000001-1001 +10,000 판매 / -1002 −10,000 반품)이면 이름표도 전부 반품 사유도 없다 — 종전 사유', () => {
  const ad = C.SL_ADAPTERS.find((a) => a.id === 'coupang-revenue');
  const p = parseCp([{ no: '9100000001', opt: '1001', pay: 10000 }, { no: '9100000001', opt: '1002', pay: -10000, ref: 1 }]);
  const k = C.slClassifyRows(p.rows);
  assert.equal(k.manual.filter((x) => x.kind === '전부 반품').length, 0);
  const idx = C.slLedgerIndex([{ order_no: '9100000001', market: '쿠팡', recipient: 'Ann Lee', phone: '010-1111-5678', amount: 10000, is_gift: false, status: '정상' }], '쿠팡');
  const g = C.slGroupLedger(k.rows, ad, idx, {})[0];
  assert.equal(g.retFull.size, 0);
  const r = C.slMatchLedger(g.rows, g.ledger, [], [], { retOrders: g.retOrders, retFull: g.retFull });
  assert.equal(r.status, 'block'); assert.match(r.reason, /같은 주문에 반품·제외 행이 있음/); assert.doesNotMatch(r.reason, /전부 반품된 주문/);
});
test('slClassifyRows: 부분 반품(합 ≠ 0)은 판매 행을 그대로 둔다(기존대로 원장 줄 매칭이 차단)', () => {
  const p = parseCp([{ no: '9100000003', pay: 15567 }, { no: '9100000003', pay: -5000, ref: 1 }]);
  const k = C.slClassifyRows(p.rows);
  assert.equal(k.rows.filter((r) => !r.isReturn).length, 1);
  assert.equal(k.manual.filter((m) => m.kind === '전부 반품').length, 0);
  const z = C.slClassifyRows(parseCp([{ no: '9100000004', pay: 0 }]).rows);
  assert.equal(z.manual.length, 0);
});
test('slClassifyRows: 배송비 행은 합계에서 빼고 구분 "배송비" — 쿠팡 <기본배송료>·아몬즈 추가 배송비', () => {
  const p = parseCp([{ no: '9100000005', pay: 15567 }, { no: '9100000005', pay: -15567, ref: 1 }, { no: '9100000005', opt: '<기본배송료>', pay: 5802, name: '<기본배송료>' }]);
  const k = C.slClassifyRows(p.rows);
  assert.equal(k.manual.find((m) => m.amount === 5802).kind, '배송비');
  assert.equal(k.manual.filter((m) => m.kind === '전부 반품').length, 1);
  assert.equal(k.rows.filter((r) => !r.isReturn).length, 1);
  const a = C.slParseFile(AM);
  const ka = C.slClassifyRows(a.rows);
  assert.ok(ka.manual.length >= 1 && ka.manual.every((m) => m.kind === '배송비'));
});
test('slClassifyRows: 전부 반품 외에는 판매 가능 행 집합이 그대로 · isReturn 행은 모두 수동 목록', () => {
  const p = parseCp([{ no: '9100000006', pay: 1000 }, { no: '9100000007', pay: -300, ref: 1 }, { no: '9100000008', pay: 2000 }]);
  const k = C.slClassifyRows(p.rows);
  assert.deepEqual(k.rows.filter((r) => !r.isReturn).map((r) => r.ledgerNo), ['9100000006', '9100000008']);
  assert.deepEqual(k.manual.map((m) => m.kind), ['반품']);
});

test('slHowChip: 주문 확인 자동 선택은 경고 칩(자동 · 주문 확인(이름 다름)) — 직접 선택으로 보이지 않는다', () => {
  assert.deepEqual(C.slHowChip('자동'), { cls: 'reuse', text: '자동 매칭' });
  const w = C.slHowChip('주문 확인');
  assert.equal(w.cls, 'skipped'); assert.equal(w.text, '자동 · 주문 확인(이름 다름)');
  assert.equal(C.slHowChip('선택').text, '직접 선택');
  assert.ok(/C\.slHowChip\(e\.how\)/.test(UI));
});
test('slClassifyRows: 자리표(time-)·ledgerBlock 행은 전부 반품 묶음에서 제외 — 서로 다른 에이블리 결제가 합쳐지지 않는다', () => {
  const mk = (extra) => Object.assign({ orderNo: 'A', amount: 1000, name: '링', isReturn: false }, extra);
  const rows = [mk({ orderNo: 'A1', ledgerNo: 'time-111', amount: 1000 }), mk({ orderNo: 'A1', ledgerNo: 'time-111', amount: -1000, isReturn: true })];
  const k = C.slClassifyRows(rows);
  assert.equal(k.manual.filter((m) => m.kind === '전부 반품').length, 0);
  assert.equal(k.rows.filter((r) => !r.isReturn).length, 1);
  const blk = [mk({ orderNo: 'B1', ledgerNo: 'L9', ledgerBlock: '모호', amount: 500 }), mk({ orderNo: 'B1', ledgerNo: 'L9', ledgerBlock: '모호', amount: -500, isReturn: true })];
  assert.equal(C.slClassifyRows(blk).manual.filter((m) => m.kind === '전부 반품').length, 0);
  const real = [mk({ orderNo: 'C1', ledgerNo: '1234567', amount: 500 }), mk({ orderNo: 'C1', ledgerNo: '1234567', amount: -500, isReturn: true })];
  assert.equal(C.slClassifyRows(real).manual.filter((m) => m.kind === '전부 반품').length, 1);
  assert.equal(C.slClassifyRows(real).rows.length, 2);
});
test('구분 표시: 스마트스토어 상품주문 외 행·퀸잇 상품 구매 외 거래는 자기 구분값을 보인다(배송비 이름은 그대로)', () => {
  const sm = [['상품주문번호', '구분', '상품명', '구매자명', '정산기준금액(A)', 'Npay 수수료(B)', '매출연동 수수료 합계(C)'],
    ['S1', '상품주문', '링', '고객A', '1000', '-10', '-10'], ['S2', '충전', '충전 건', '', '5000', '0', '0'], ['S3', '배송비', '배송비 정산', '', '3000', '0', '0']];
  const sp = C.slParseFile(sm);
  assert.equal(sp.ok, true);
  const km = C.slClassifyRows(sp.rows).manual;
  assert.equal(km.find((m) => m.orderNo === 'S2').kind, '충전');
  assert.equal(km.find((m) => m.orderNo === 'S3').kind, '배송비');
  const q = C.slParseFile([['주문번호', '개별주문번호', '거래유형', '상품명', '옵션명', '수량', '정산금액(A-B-C+D)'],
    ['Q1', 'Q1-1', '상품 구매', '링', '', '1', '1000'], ['Q2', 'Q2-1', '광고비 차감', '광고', '', '1', '2000'], ['Q3', 'Q3-1', '상품 구매', '링', '', '1', '-500']]);
  assert.equal(q.ok, true);
  const kq = C.slClassifyRows(q.rows).manual;
  assert.equal(kq.find((m) => m.orderNo === 'Q2-1').kind, '광고비 차감');
  assert.equal(kq.find((m) => m.orderNo === 'Q3-1').kind, '반품');
});

/* ---- 6. 빈 화면 ---- */
test('panel: 판매할 행이 없어도 파일명·마켓을 보이고 안내 문구를 낸다 · 수동 표에 구분 열', () => {
  assert.ok(UI.includes('판매할 행이 없습니다 — 아래 수동 처리 목록만 있습니다'));
  assert.ok(/<th>구분<\/th>/.test(UI));
  assert.ok(UI.includes('수동 처리 필요'));
  assert.ok(/C\.slClassifyRows\(/.test(UI));
  const top = UI.slice(UI.indexOf("p.querySelector('.sl-top').innerHTML"), UI.indexOf('const mk = '));
  assert.ok(/S\.adapter \?/.test(top) && /S\.fileName/.test(top));
});

test('panel: 원장 묶음의 buyer 는 원장 수령자(파일 구매자가 *** 로 가려져도 폴백 검색이 수령자로 돈다)', () => {
  assert.match(UI, /const buyer = g\.source === '원장' && g\.buyer \? g\.buyer : g\.rows\[0\]\.buyer;/);
  const g = C.slGroupLedger([{ r: 1, orderNo: 'A1', ledgerNo: 'L100', buyer: '***', isReturn: false, amount: 1000, key: 1000, qty: 1 }],
    { id: 'x', ledgerMarket: '쿠팡', suffix: '쿠', clientRule: 'ledger' },
    new Map([['L100', [{ order_no: 'L100', market: '쿠팡', recipient: 'Ann Lee', phone: '010-0000-1234', amount: 1000, is_gift: false, status: '정상' }]]]));
  assert.equal(g[0].source, '원장');
  assert.equal(g[0].buyer, 'Ann Lee');
});

/* ---- 4.3.5 R3: 전부 반품 — 모든 마켓에서 묶음 차단(slGroupByClient·slGroupLedger 공통) ---- */
const FULL_TAIL = '전부 반품된 주문 — 판매 안 함(유비샵 주문은 직접 정리)';
const FULL_REASON = (no) => no + ': ' + FULL_TAIL;
const AD = (id) => C.SL_ADAPTERS.find((a) => a.id === id);
const sRow = (o) => Object.assign({ r: 1, orderNo: 'A001', ledgerNo: 'A001', buyer: '고객A', phone: '010-1111-5678', name: '링', isReturn: false, amount: 49000, key: 49000, qty: 1 }, o);
const pair = (no, over) => [sRow(Object.assign({ orderNo: no, ledgerNo: no }, over)), sRow(Object.assign({ orderNo: no, ledgerNo: no, isReturn: true, amount: -49000, key: -49000 }, over))];
test('slFullReturnSet: 판매+반품 합 0 인 orderNo 만 · 배송비·조정·time-·ledgerBlock·다른 orderNo 상쇄는 제외 — 이름표와 같은 집합', () => {
  const rows = pair('A001').concat(pair('A002', { orderNo: 'A002-1' }).slice(0, 1), [sRow({ orderNo: 'A002-2', ledgerNo: 'A002', isReturn: true, amount: -49000 })],
    pair('A003').concat([sRow({ orderNo: 'A003', ledgerNo: 'A003', isReturn: true, name: '배송비', amount: 3000 })]), pair('time-1'), pair('A004', { ledgerBlock: 'x' }));
  const full = C.slFullReturnSet(rows);
  assert.deepEqual([...full].sort(), ['A001', 'A003']);
  assert.deepEqual(C.slClassifyRows(rows).manual.filter((m) => m.kind === '전부 반품').map((m) => m.orderNo).sort(), ['A001', 'A003']);
});
['cafe24-inicis-card', 'ssg-settle', 'smartstore-daily', 'amondz-settle', 'gs'].forEach((id) => {
  test('slGroupByClient(' + id + '): 같은 orderNo 전부 반품이면 묶음 차단(고를 수도 없음) · 판매 행은 그대로 · 판매만 있는 묶음은 통과', () => {
    const ad = AD(id);
    const gs = C.slGroupByClient(C.slClassifyRows(pair('A001').concat([sRow({ orderNo: 'B002', ledgerNo: 'B002', buyer: '고객B', phone: '010-2222-9999' })])).rows, ad);
    const a = gs.find((g) => g.rows.some((r) => r.orderNo === 'A001')), b = gs.find((g) => g.rows.some((r) => r.orderNo === 'B002'));
    assert.equal(a.block, FULL_REASON('A001')); assert.equal(a.pickable, false); assert.deepEqual(a.rows.map((r) => r.orderNo), ['A001']);
    assert.ok(!b.block);
  });
});
test('slGroupLedger(이니시스 원장 묶음·원장 없는 묶음): 전부 반품이면 둘 다 차단 · 판매만 있으면 통과', () => {
  const ad = AD('cafe24-inicis-card');
  const led = new Map([['A001', [{ order_no: 'A001', market: '카페24', recipient: '고객A', phone: '010-1111-5678', amount: 49000, is_gift: false, status: '정상' }]], ['C003', [{ order_no: 'C003', market: '카페24', recipient: '고객C', phone: '010-3333-1234', amount: 49000, is_gift: false, status: '정상' }]]]);
  const rows = pair('A001').concat(pair('D004', { buyer: '고객D' }), [sRow({ orderNo: 'C003', ledgerNo: 'C003', buyer: '고객C' })]);
  const gs = C.slGroupLedger(rows, ad, led, {});
  const by = (no) => gs.find((g) => g.rows.some((r) => r.orderNo === no));
  assert.equal(by('A001').source, '원장'); assert.equal(by('A001').block, FULL_REASON('A001')); assert.equal(by('A001').pickable, false);
  assert.equal(by('D004').block, FULL_REASON('D004'));
  assert.equal(by('C003').block, '');
  const none = C.slGroupLedger(pair('A001'), ad, null, {});
  assert.equal(none[0].block, FULL_REASON('A001'));
});
test('slGroupLedger(쿠팡): 전부 반품 쌍은 같은 사유로 차단 · 다른 옵션끼리 상쇄는 이 규칙으로 차단하지 않는다(종전 사유)', () => {
  const ad = AD('coupang-revenue');
  const led = (no) => C.slLedgerIndex([{ order_no: no, market: '쿠팡', recipient: 'Ann Lee', phone: '010-1111-5678', amount: 39000, is_gift: false, status: '정상' }], '쿠팡');
  const p = parseCp([{ no: '9100000030', pay: 39000 }, { no: '9100000030', pay: -39000, ref: 1 }]);
  const g = C.slGroupLedger(C.slClassifyRows(p.rows).rows, ad, led('9100000030'), {})[0];
  assert.equal(g.block, FULL_REASON(g.rows[0].orderNo)); assert.equal(g.pickable, false);
  const q = parseCp([{ no: '9100000031', opt: '1', pay: 39000 }, { no: '9100000031', opt: '2', pay: -39000, ref: 1 }]);
  const h = C.slGroupLedger(C.slClassifyRows(q.rows).rows, ad, led('9100000031'), {})[0];
  assert.equal(h.block, '');
});
test('slGroupByClient: 취소 후 재결제(A001 +/− · B002 +) — 묶음은 차단하되 사유는 A001 만 전부 반품·B002 는 판매해야 할 수 있음으로 말한다(묶음 전체 "판매 안 함" 금지)', () => {
  const gs = C.slGroupByClient(pair('A001').concat([sRow({ orderNo: 'B002', ledgerNo: 'B002' })]), AD('cafe24-inicis-card'));
  assert.equal(gs.length, 1); assert.equal(gs[0].pickable, false); assert.equal(gs[0].rows.length, 2);
  assert.equal(gs[0].block, 'A001: 전부 반품 — 같은 묶음의 다른 주문(B002)은 판매해야 할 수 있음 — 직접 처리');
  assert.doesNotMatch(gs[0].block, /판매 안 함/);
});
test('slBlockFullReturn 사유: 쿠팡 같은 주문 다른 옵션(111 ± + 222 정상) · 같은 고객 두 주문 · 이니시스 원장 묶음 — 전부 반품 주문을 짚고 나머지는 판매 가능 경고', () => {
  const cpAd = AD('coupang-revenue');
  const led = (rows) => C.slLedgerIndex(rows.map((x) => ({ order_no: x[0], market: '쿠팡', recipient: 'Ann Lee', phone: '010-1111-5678', amount: x[1], is_gift: false, status: '정상' })), '쿠팡');
  const MIX = (no) => /전부 반품 — 같은 묶음의 다른 주문\(.+\)은 판매해야 할 수 있음 — 직접 처리$/.test(no);
  // 쿠팡: 옵션 111 판매+환불(합 0, 주문번호가 옵션별로 달라지는 경우) + 옵션 222 정상
  const rows = pair('9100000001-111', { name: '링' }).concat([sRow({ orderNo: '9100000001-222', ledgerNo: '9100000001', amount: 20000 })]);
  const g1 = C.slGroupByClient(rows, cpAd);
  assert.equal(g1.length, 1); assert.equal(g1[0].pickable, false);
  assert.equal(g1[0].block, '9100000001-111: 전부 반품 — 같은 묶음의 다른 주문(9100000001-222)은 판매해야 할 수 있음 — 직접 처리'); assert.ok(MIX(g1[0].block));
  // 같은 고객 두 주문(N1 전부 반품 · N2 정상) — 원장 묶음
  const rows2 = pair('9100000001').concat([sRow({ orderNo: '9100000002', ledgerNo: '9100000002', amount: 20000 })]);
  const g2 = C.slGroupLedger(rows2, cpAd, led([['9100000001', 49000], ['9100000002', 20000]]), {});
  g2.forEach((g) => { assert.equal(g.pickable, false); assert.doesNotMatch(g.block, /판매 안 함/); });
  assert.ok(g2.some((g) => g.block === '9100000001: 전부 반품 — 같은 묶음의 다른 주문(9100000002)은 판매해야 할 수 있음 — 직접 처리'));
  // 이니시스: A001 ± + B002 재결제, 원장 묶음
  const ini = AD('cafe24-inicis-card');
  const iled = new Map([['A001', [{ order_no: 'A001', market: '카페24', recipient: '고객A', phone: '010-1111-5678', amount: 49000, is_gift: false, status: '정상' }]], ['B002', [{ order_no: 'B002', market: '카페24', recipient: '고객A', phone: '010-1111-5678', amount: 49000, is_gift: false, status: '정상' }]]]);
  const g3 = C.slGroupLedger(pair('A001').concat([sRow({ orderNo: 'B002', ledgerNo: 'B002' })]), ini, iled, {});
  assert.ok(g3.length >= 1); g3.forEach((g) => { assert.equal(g.pickable, false); assert.doesNotMatch(g.block, /판매 안 함/); assert.match(g.block, /^A001: 전부 반품 — 같은 묶음의 다른 주문\(B002\)은 판매해야 할 수 있음 — 직접 처리$/); });
});
test('slBlockFullReturn 사유: 묶음의 판매 주문이 전부 반품이면 주문번호를 앞에 붙인 "판매 안 함" · 번호가 많으면 3개 + 외 N건', () => {
  const ad = AD('cafe24-inicis-card');
  const all = C.slGroupByClient(pair('A001').concat(pair('A002')), ad);
  assert.equal(all.length, 1); assert.equal(all[0].block, 'A001, A002: ' + FULL_TAIL); assert.equal(all[0].pickable, false);
  const many = C.slGroupByClient(pair('A001').concat(pair('A002'), pair('A003'), pair('A004'), pair('A005')), ad);
  assert.equal(many[0].block, 'A001, A002, A003 외 2건: ' + FULL_TAIL);
  const mix = C.slGroupByClient(pair('A001').concat(pair('A002'), pair('A003'), pair('A004'), [sRow({ orderNo: 'B001', ledgerNo: 'B001' })]), ad);
  assert.equal(mix[0].block, 'A001, A002, A003 외 1건: 전부 반품 — 같은 묶음의 다른 주문(B001)은 판매해야 할 수 있음 — 직접 처리');
});
