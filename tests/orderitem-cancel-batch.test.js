/* =============================================================================
 *  orderitem-cancel-batch.test.js — 주문전표 일괄취소 오케스트레이터(ccRunCancelBatch) 배선 테스트.
 *
 *  순수 헬퍼만 테스트하면 "호출을 빼먹는" 변이가 살아남는다(masterprice v2.9.7 교훈). 그래서
 *  skin.js 에서 ccRunCancelBatch·ccDoCancel 본문을 추출해, 의존(fetchOrderRow·cFetchSKey·
 *  cReadSearchFields·cUpdateRow·fetch·state·cBatchBusy)을 스텁으로 갈아 끼우고 실제로 돌린다.
 *  ⚠ 실제 네트워크 접근 없음 — fetch 는 스텁이다. 취소 GET 은 URL 만 캡처한다.
 *  ⚠ 이 파일을 PowerShell 로 편집하지 마라 — Set-Content 가 한글을 깨뜨린다.
 *  스펙: docs/superpowers/specs/2026-09-11-orderitem-bulk-cancel-design.md §4.3·§5
 *  실행: node --test tests/orderitem-cancel-batch.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'skin.js'), 'utf8');

//  async 함수도 그대로 추출한다('async ' 접두 포함). 리네임하면 추출 실패로 즉사.
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'skin.js 에서 ' + name + ' 선언을 찾지 못했습니다 (리네임 여부 확인)');
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(name + ' 본문의 중괄호 균형을 찾지 못했습니다');
}

const NAMES = ['ccTargetStatus', 'ccBuildCancelUrl', 'ccRedirectMsg', 'ccClassifyOutcome', 'ccRowCancelSeq',
               'ccRequeryReason', 'ccRowCurrentSetting', 'parseCurrentSettingArgs', 'ccNextStep', 'ccStepOutcome',
               'ccBuildUnassignUrl', 'cBuildStandbyUrl', 'ccDoCancel', 'ccDoStandbyOff', 'ccDoUnassign', 'ccDoDelivDelete', 'ccDoStep',
               'ccRunCancelBatch'];

//  샌드박스: deps 로 의존을 주입하고, 추출한 함수들을 같은 스코프에 둔다.
//  setTimeout 은 판정 폴링의 1.5s 대기(정확히 1500ms)만 0 으로 줄인다 — ccDoCancel 의 8000ms abort 타이머는 실제.
function build(deps) {
  // eslint-disable-next-line no-new-func
  const factory = new Function('deps',
    'const state = deps.state;\n' +
    'const ASG_FETCH_MS = 8000; const ASG_VERIFY_MS = deps.verifyMs;\n' +
    'let cBatchBusy = !!deps.busy;\n' +
    'const fetch = deps.fetch; const fetchOrderRow = deps.fetchOrderRow; const cFetchSKey = deps.cFetchSKey;\n' +
    'const cReadSearchFields = deps.cReadSearchFields; const cUpdateRow = deps.cUpdateRow;\n' +
    'const ccFindDelivRow = deps.ccFindDelivRow; const dcmDelete = deps.dcmDelete; const dcmAppendLog = deps.dcmAppendLog;\n' +
    'const CC_MAX_STEPS = 6;\n' +
    'const ccLog = () => {};\n' +
    'const setTimeout = (fn, ms) => globalThis.setTimeout(fn, ms === 1500 ? 0 : ms);\n' +
    'const clearTimeout = (id) => globalThis.clearTimeout(id);\n' +
    NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
    'return { ccRunCancelBatch, ccDoCancel, ccDoStep, ccDoStandbyOff, ccDoUnassign, ccDoDelivDelete, busy: () => cBatchBusy };'
  );
  return factory(deps);
}

//  재조회 스텁: orderSeq 별로 호출 순서대로 상태를 낸다(마지막 값 반복). 호출 기록과 돌려준 객체를 남긴다.
//  실제 fetchOrderRow 처럼 응답마다 새 sKey(렌더 시각 타임스탬프)를 싣는다 — 호출마다 고유값.
let requerySeq = 0;
function makeRequery(script) {
  const calls = [];
  const cursor = {};
  const fn = async (orderSeq, orderDate) => {
    const seq = script[orderSeq] || [];
    const i = Math.min(cursor[orderSeq] || 0, seq.length - 1);
    cursor[orderSeq] = (cursor[orderSeq] || 0) + 1;
    const r = seq[i];
    const sKey = '2609111512' + String(++requerySeq).padStart(5, '0');
    // 서버처럼: O-- 행엔 [취소] 링크 del('<seq>')(2026-09-11 실측: 332/332, 취소된 행엔 없음), I--/OS- 행엔 배정 팝업 링크
    //  currentSetting(...)(바코드 = r.assignedBarcode; r.link===false 면 발주주문처럼 링크 없음), T-- 는 링크 없음(2026-09-16 실측).
    let rowHtml = '<tr><td>' + (r ? r.code : '') + '</td></tr>';
    if (r && r.code === 'O--') rowHtml = '<tr><td>' + r.code + '</td><td><a href="javascript:del(\'' + orderSeq + '\');">취소</a></td></tr>';
    else if (r && (r.code === 'I--' || r.code === 'OS-') && r.link !== false) rowHtml = '<tr><td>' + r.code + '</td><td><a href="javascript:currentSetting(\'7043\',\'' + orderSeq + '\',\'' + (r.assignedBarcode || '') + '\',\'NU\',\'1\',\'20260915\')">x</a></td></tr>';
    const ret = !r
      ? { found: false, orderSeq, code: null, text: '', assignedBarcode: '', duplicate: false, hasMore: false, loginExpired: false, rowHtml: '', sKey }
      : Object.assign({ found: true, orderSeq, text: r.code, assignedBarcode: '', duplicate: false, hasMore: false, loginExpired: false, rowHtml, sKey }, r);
    calls.push({ orderSeq, orderDate, ret });
    return ret;
  };
  fn.calls = calls;
  return fn;
}
//  fetch 스텁: 호출 URL 을 캡처하고 리다이렉트 도착 URL 을 흉내낸다.
function makeFetch(finalUrl) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return { url: finalUrl || 'http://h/jun/orderitem/orderItemList.do?tcode=order_item' }; };
  fn.calls = calls;
  return fn;
}
function baseDeps(over) {
  const updates = [];
  return Object.assign({
    state: { ubSkin: true, ubHqConfirm: true },
    verifyMs: 50,
    busy: false,
    fetch: makeFetch(),
    fetchOrderRow: makeRequery({}),
    cFetchSKey: async () => '260911135039701',
    cReadSearchFields: () => ({ reqPage: '1', pageSize: '100' }),
    cUpdateRow: (seq, row) => { updates.push({ seq, code: row && row.code }); },
    ccFindDelivRow: async () => ({ ok: false, reason: '스텁: 출고 건 없음' }),
    dcmDelete: async () => ({ ok: true, msg: '' }),
    dcmAppendLog: () => true,
    updates
  }, over || {});
}
const T1 = { orderSeq: '101', code: 'O--', orderDate: '20260911' };
const T2 = { orderSeq: '102', code: 'O--', orderDate: '20260911' };

test('성공 경로: 재조회 O-- → 취소 GET 1회(정확한 URL) → 재조회 OC- → success, 행 갱신', async () => {
  const deps = baseDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'O--' }, { code: 'OC-' }] }) });
  const sb = build(deps);
  const r = await sb.ccRunCancelBatch([T1], () => {}, () => false);
  assert.equal(r.success, 1);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.uncertain, []);
  assert.equal(r.processed, 1);
  assert.equal(deps.fetch.calls.length, 1, '취소 GET 은 정확히 1회');
  const p = new URL('http://x' + deps.fetch.calls[0].url).searchParams;
  assert.ok(deps.fetch.calls[0].url.startsWith('/jun/orderitem/orderItemCancel.do?'));
  assert.equal(p.get('seq'), '101');
  assert.equal(p.get('sKey'), deps.fetchOrderRow.calls[0].ret.sKey, '키는 상태를 확인한 그 응답의 것');
  assert.equal(p.get('tcode'), 'order_item');
  assert.equal(p.get('pageSize'), '100');
  assert.equal(deps.fetch.calls[0].opts.method, 'GET');
  assert.equal(deps.fetch.calls[0].opts.credentials, 'include');
  assert.deepEqual(deps.updates, [{ seq: '101', code: 'OC-' }]);
  assert.equal(sb.busy(), false, '끝나면 busy 해제');
});

test('두 건 순차: 둘 다 성공하면 success=2, 취소 GET 2회, 두 번째는 첫 번째가 끝난 뒤', async () => {
  const deps = baseDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'O--' }, { code: 'OC-' }], '102': [{ code: 'O--' }, { code: 'OC-' }] }) });
  const sb = build(deps);
  const r = await sb.ccRunCancelBatch([T1, T2], () => {}, () => false);
  assert.equal(r.success, 2);
  assert.equal(deps.fetch.calls.length, 2);
  assert.equal(new URL('http://x' + deps.fetch.calls[1].url).searchParams.get('seq'), '102');
  // 재조회 순서: 101 확인 → 101 판정 → 102 확인 → 102 판정 (교차 없음)
  assert.deepEqual(deps.fetchOrderRow.calls.map(c => c.orderSeq), ['101', '101', '102', '102']);
});

test('건마다 fresh sKey(원자성): 각 취소 URL 의 sKey 는 그 건의 상태를 확인한 재조회 응답의 키다(2R Terra P2 · Opus P2-3)', async () => {
  const deps = baseDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'O--' }, { code: 'OC-' }], '102': [{ code: 'O--' }, { code: 'OC-' }] }) });
  const r = await build(deps).ccRunCancelBatch([T1, T2], () => {}, () => false);
  assert.equal(r.success, 2);
  const used = deps.fetch.calls.map(c => new URL('http://x' + c.url).searchParams.get('sKey'));
  const checks = deps.fetchOrderRow.calls.filter((c, i) => i % 2 === 0).map(c => c.ret.sKey);   // 건별 첫 재조회(상태 확인)
  assert.deepEqual(used, checks, '별도 GET 으로 받은 키가 아니라, 상태를 본 응답의 키');
  assert.notEqual(used[0], used[1], '건마다 다른(새) 키');
});

test('재조회 OS-(본사확인): 이제 대상 — 본사확인취소 POST → O-- → 취소 GET → OC- (쓰기 2회, 각 sKey 는 직전 응답의 것)', async () => {
  const deps = baseDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'OS-' }, { code: 'O--' }, { code: 'OC-' }] }) });
  const sb = build(deps);
  const r = await sb.ccRunCancelBatch([{ orderSeq: '101', code: 'OS-', orderDate: '20260911' }], () => {}, () => false);
  assert.equal(r.success, 1); assert.deepEqual(r.failed, []); assert.deepEqual(r.uncertain, []);
  assert.deepEqual(deps.fetch.calls.map(c => c.url.split('?')[0]), ['/jun/orderitem/orderItemStandby.do', '/jun/orderitem/orderItemCancel.do']);
  const q = deps.fetchOrderRow.calls;
  assert.equal(new URL('http://x' + deps.fetch.calls[0].url).searchParams.get('sKey'), q[0].ret.sKey, '본사확인취소 키 = OS- 를 본 응답');
  assert.equal(new URL('http://x' + deps.fetch.calls[1].url).searchParams.get('sKey'), q[1].ret.sKey, '취소 키 = O-- 를 본(직전 확인) 응답');
  assert.deepEqual(q.map(c => c.orderSeq), ['101', '101', '101'], '재조회 3회: 처음 + 단계 확인 2회(확인 응답이 다음 단계의 근거)');
  assert.deepEqual(deps.updates, [{ seq: '101', code: 'OC-' }]);
});

test('이미 취소됨(재조회 OC-): 목표 상태라 쓰기 없이 success', async () => {
  const deps = baseDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'OC-' }] }) });
  const r = await build(deps).ccRunCancelBatch([T1], () => {}, () => false);
  assert.equal(r.success, 1); assert.equal(deps.fetch.calls.length, 0);
  assert.deepEqual(deps.updates, [{ seq: '101', code: 'OC-' }]);
});

test('미확정: dispatch 후 재조회가 계속 O-- 이면 uncertain(실패 아님) + 서버 msg 첨부, 중단', async () => {
  const deps = baseDeps({
    fetchOrderRow: makeRequery({ '101': [{ code: 'O--' }, { code: 'O--' }] }),
    fetch: makeFetch('http://h/jun/orderitem/orderItemList.do?tcode=order_item&msg=%EC%B7%A8%EC%86%8C%20%EB%B6%88%EA%B0%80')
  });
  const r = await build(deps).ccRunCancelBatch([T1, T2], () => {}, () => false);
  assert.equal(deps.fetch.calls.length, 1, '재시도 금지 — 취소 GET 은 1회뿐');
  assert.equal(r.success, 0);
  assert.deepEqual(r.failed, []);
  assert.equal(r.uncertain.length, 1);
  assert.equal(r.uncertain[0].orderSeq, '101');
  assert.match(r.uncertain[0].reason, /^취소 처리 미확정 — 현재 상태: O-- · 수동 확인 필요 · 서버: 취소 불가$/);   // 문구에 단계·현재 상태(스펙 2026-09-16 §4.3)
  assert.equal(r.processed, 1);
  assert.deepEqual(deps.updates, [{ seq: '101', code: 'O--' }], '현재 서버 상태로 화면 갱신');
});

test('미확정: dispatch 후 재조회 자체가 실패(found=false)해도 uncertain, 재시도 없음', async () => {
  const deps = baseDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'O--' }, null] }) });
  const r = await build(deps).ccRunCancelBatch([T1], () => {}, () => false);
  assert.equal(deps.fetch.calls.length, 1);
  assert.equal(r.uncertain.length, 1);
  assert.deepEqual(deps.updates, [], 'found=false 면 화면을 건드리지 않는다');
});

test('fetch 예외(네트워크/타임아웃): 서버 도달 여부 불명 → dispatched 로 취급해 재조회 판정(성공이면 success)', async () => {
  const f = async () => { throw new Error('Failed to fetch'); }; f.calls = [];
  const deps = baseDeps({ fetch: f, fetchOrderRow: makeRequery({ '101': [{ code: 'O--' }, { code: 'OC-' }] }) });
  const r = await build(deps).ccRunCancelBatch([T1], () => {}, () => false);
  assert.equal(r.success, 1);
});

test('sKey 추출 실패: 재조회 응답에 키가 없으면 취소 GET 없이 실패 중단', async () => {
  const deps = baseDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'O--', sKey: null }] }) });
  const r = await build(deps).ccRunCancelBatch([T1], () => {}, () => false);
  assert.equal(deps.fetch.calls.length, 0);
  assert.equal(r.failed[0].reason, 'sKey 추출 실패');
});

test('재조회 found=false 사유 구분: 로그인 만료 / 중복 / 결과 잘림 / 행 없음', async () => {
  const cases = [
    [{ found: false, loginExpired: true }, '로그인 만료'],
    [{ found: false, duplicate: true }, '중복 orderSeq(재조회)'],
    [{ found: false, hasMore: true }, '재조회 실패(결과 잘림 — 조건을 좁혀라)'],
    [{ found: false }, '재조회 실패(행 없음)']
  ];
  for (const [row, reason] of cases) {
    const deps = baseDeps({ fetchOrderRow: async () => row });
    const r = await build(deps).ccRunCancelBatch([T1], () => {}, () => false);
    assert.equal(deps.fetch.calls.length, 0, reason);
    assert.equal(r.failed[0].reason, reason);
  }
});

test('주문일 없음: 재조회도 쓰기도 없이 실패', async () => {
  const deps = baseDeps();
  const r = await build(deps).ccRunCancelBatch([{ orderSeq: '101', code: 'O--', orderDate: '' }], () => {}, () => false);
  assert.equal(deps.fetchOrderRow.calls.length, 0);
  assert.equal(deps.fetch.calls.length, 0);
  assert.equal(r.failed[0].reason, '주문일 파싱 실패');
});

test('게이트 OFF: 아무 건도 처리하지 않는다', async () => {
  const deps = baseDeps({ state: { ubSkin: true, ubHqConfirm: false }, fetchOrderRow: makeRequery({ '101': [{ code: 'O--' }, { code: 'OC-' }] }) });
  const r = await build(deps).ccRunCancelBatch([T1], () => {}, () => false);
  assert.equal(r.processed, 0);
  assert.equal(deps.fetch.calls.length, 0);
});

test('중단 요청: 첫 건이 끝난 뒤 다음 건 경계에서 멈춘다', async () => {
  let aborted = false;
  const deps = baseDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'O--' }, { code: 'OC-' }], '102': [{ code: 'O--' }, { code: 'OC-' }] }) });
  // dispatch 뒤 판정 단계('… · 취소 처리 확인', '상태 확인' 아님)에서 [중단] — 이미 쓴 건은 판정까지 마치고 다음 건은 시작하지 않는다
  const r = await build(deps).ccRunCancelBatch([T1, T2], (msg) => { if (msg === '1/2 · 101 · 취소 처리 확인') aborted = true; }, () => aborted);
  assert.equal(r.success, 1);
  assert.equal(r.processed, 1);
  assert.equal(deps.fetch.calls.length, 1);
});

test('busy(다른 배치 진행 중): 즉시 빈 결과, 아무 것도 하지 않는다', async () => {
  const deps = baseDeps({ busy: true, fetchOrderRow: makeRequery({ '101': [{ code: 'O--' }, { code: 'OC-' }] }) });
  const sb = build(deps);
  const r = await sb.ccRunCancelBatch([T1], () => {}, () => false);
  assert.deepEqual(r, { success: 0, failed: [], uncertain: [], processed: 0, total: 1 });
  assert.equal(deps.fetch.calls.length, 0);
  assert.equal(sb.busy(), true, '남의 busy 를 풀지 않는다');
});

test('ccDoCancel: URL 을 못 만들면 dispatched=false 로 확정 실패, fetch 호출 없음', async () => {
  const deps = baseDeps();
  const sb = build(deps);
  const d = await sb.ccDoCancel('', 'k', {});
  assert.equal(d.dispatched, false);
  assert.equal(deps.fetch.calls.length, 0);
});

// ── 재진입 가드 (1R Terra P1) ─────────────────────────────────────────────
//  배치가 도는 동안 툴바 [일괄취소] 를 다시 누르면 진행 중 승인창이 지워져 [중단] 을 잃는다.
//  두 겹으로 막는다: ① 진입점 onBulkCancelClick 이 cBatchBusy 면 승인창을 아예 열지 않는다
//  ② ccShowApprovalDialog 가 dataset.ubRunning='1' 인 기존 창을 교체하지 않는다.
function buildReentry(deps) {
  const names = ['ccTargetStatus', 'ccClassifyChecked', 'onBulkCancelClick', 'ccShowApprovalDialog'];
  // eslint-disable-next-line no-new-func
  const factory = new Function('deps',
    'const state = deps.state; let cBatchBusy = !!deps.busy;\n' +
    'const CC_MODAL_ID = "ub-cc-modal";\n' +
    'const ccLog = () => {}; const ensureCcStyle = () => {};\n' +
    'const cReadCheckedRows = deps.cReadCheckedRows; const ccRunCancelBatch = deps.ccRunCancelBatch;\n' +
    'const document = deps.document;\n' +
    names.map(n => extractFn(SRC, n)).join('\n') + '\n' +
    // onBulkCancelClick 이 부르는 ccShowApprovalDialog 를 스파이로 감싼다
    'const dialogCalls = [];\n' +
    'const realDialog = ccShowApprovalDialog;\n' +
    'const wrapped = (cls) => { dialogCalls.push(cls); return deps.useRealDialog ? realDialog(cls) : undefined; };\n' +
    'const click = (e) => { const f = onBulkCancelClick.toString().replace("ccShowApprovalDialog(cls)", "wrapped(cls)"); return eval("(" + f + ")")(e); };\n' +
    'return { click, dialogCalls, realDialog };'
  );
  return factory(deps);
}

test('재진입 ①: 배치 진행 중(cBatchBusy) 이면 [일괄취소] 클릭이 승인창을 열지 않는다', () => {
  const sb = buildReentry({ state: { ubSkin: true, ubHqConfirm: true }, busy: true,
    cReadCheckedRows: () => [{ orderSeq: '1', code: 'O--', orderDate: '20260911' }], document: {} });
  sb.click({ isTrusted: true });
  assert.equal(sb.dialogCalls.length, 0);
});
test('재진입 ①: 배치가 돌지 않으면 정상적으로 승인창을 연다(가드가 과하지 않다)', () => {
  const sb = buildReentry({ state: { ubSkin: true, ubHqConfirm: true }, busy: false,
    cReadCheckedRows: () => [{ orderSeq: '1', code: 'O--', orderDate: '20260911' }], document: {} });
  sb.click({ isTrusted: true });
  assert.equal(sb.dialogCalls.length, 1);
  assert.equal(sb.dialogCalls[0].targets.length, 1);
});
test('재진입 ②: 진행 중(dataset.ubRunning=1) 승인창이 있으면 ccShowApprovalDialog 가 그 창을 지우지 않고 물러난다', () => {
  let removed = 0, created = 0;
  const prev = { dataset: { ubRunning: '1' }, remove: () => { removed++; } };
  const document = { getElementById: (id) => (id === 'ub-cc-modal' ? prev : null),
                     createElement: () => { created++; throw new Error('새 창을 만들면 안 된다'); }, body: {} };
  const sb = buildReentry({ state: { ubSkin: true, ubHqConfirm: true }, busy: true, cReadCheckedRows: () => [], document });
  sb.realDialog({ targets: [{ orderSeq: '1', code: 'O--' }], excluded: [], duplicate: false });
  assert.equal(removed, 0, '진행 중 창을 지우면 안 된다');
  assert.equal(created, 0, '새 창을 만들면 안 된다');
});
test('재진입 ②: 진행 중이 아닌 옛 창은 교체된다(가드가 과하지 않다)', () => {
  let removed = 0;
  const prev = { dataset: {}, remove: () => { removed++; } };
  const document = { getElementById: (id) => (id === 'ub-cc-modal' ? prev : null),
                     createElement: () => { throw new Error('stop-after-remove'); }, body: {} };
  const sb = buildReentry({ state: { ubSkin: true, ubHqConfirm: true }, busy: false, cReadCheckedRows: () => [], document });
  sb.realDialog({ targets: [], excluded: [], duplicate: false });   // createElement 에서 멈춘다(try/catch 로 삼킴)
  assert.equal(removed, 1, '옛 창은 지우고 새로 그린다');
});

// ── 승인창 [취소 진행] 은 신뢰된 클릭만 (2R Terra P1) ────────────────────────
//  ccShowApprovalDialog 를 최소 가짜 DOM 위에서 실제로 실행해, 페이지 스크립트의 .click()(isTrusted=false)
//  으로는 ccRunCancelBatch 가 시작되지 않고 사용자 클릭(isTrusted=true)으로는 시작되는지 본다.
function fakeDom() {
  const mk = (tag) => {
    const el = { tag, children: [], handlers: {}, dataset: {}, style: {}, classList: { contains: () => false, add() {} },
      addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
      dispatch(type, ev) { return Promise.all((this.handlers[type] || []).map(fn => fn(Object.assign({ target: this }, ev)))); },
      appendChild(c) { this.children.push(c); c.parent = this; return c; },
      // innerHTML 은 파싱하지 않는다 — 셀렉터마다 빈 요소 하나를 만들어 자식으로 붙여 두고(멱등) 돌려준다
      querySelector(sel) { this.q = this.q || {}; if (!this.q[sel]) { this.q[sel] = mk('div'); this.q[sel].sel = sel; this.appendChild(this.q[sel]); } return this.q[sel]; },
      remove() { this.removed = true; } };
    return el;
  };
  const body = mk('body');
  return { getElementById: () => null, createElement: mk, body, mk };
}
function buildDialog(deps) {
  const names = ['ccChainLabel', 'ccShowApprovalDialog'];
  // eslint-disable-next-line no-new-func
  const factory = new Function('deps',
    'let cBatchBusy = false; const CC_MODAL_ID = "ub-cc-modal";\n' +
    'const ccLog = () => {}; const ensureCcStyle = () => {};\n' +
    'const ccRunCancelBatch = deps.ccRunCancelBatch; const document = deps.document;\n' +
    names.map(n => extractFn(SRC, n)).join('\n') + '\n' +
    'return { ccShowApprovalDialog };');
  return factory(deps);
}
function openDialogAndFindGo(runs) {
  const document = fakeDom();
  const sb = buildDialog({ document, ccRunCancelBatch: async (targets) => { runs.push(targets); return { success: 0, failed: [], uncertain: [], processed: 0, total: targets.length }; } });
  sb.ccShowApprovalDialog({ targets: [{ orderSeq: '1', code: 'O--', orderDate: '20260911' }], excluded: [], duplicate: false });
  const ov = document.body.children[0];
  assert.ok(ov, '승인창이 body 에 붙어야 한다');
  const card = ov.children[0];
  const foot = card.children.find(c => c.sel === '.ub-hq-f');
  const go = foot.children.find(b => b.tag === 'button' && b.textContent === '취소 진행');
  assert.ok(go, '[취소 진행] 버튼이 있어야 한다');
  const other = foot.children.find(b => b.tag === 'button' && b !== go);
  assert.equal(other && other.textContent, '닫기', "닫는 버튼은 '닫기' — '취소' 는 주문취소와 헷갈린다(Opus P2-4)");
  return { go, ov };
}
test('[취소 진행]: isTrusted=false(페이지 스크립트의 .click()) 는 배치를 시작하지 않는다', async () => {
  const runs = [];
  const { go } = openDialogAndFindGo(runs);
  await go.dispatch('click', { isTrusted: false });
  assert.equal(runs.length, 0);
  assert.equal(go.disabled, undefined, '비신뢰 클릭은 상태도 바꾸지 않는다');
});
test('[취소 진행]: 사용자 클릭(isTrusted=true) 은 배치를 시작하고 진행 표식을 세운다', async () => {
  const runs = [];
  const { go, ov } = openDialogAndFindGo(runs);
  await go.dispatch('click', { isTrusted: true });
  assert.equal(runs.length, 1);
  assert.equal(runs[0][0].orderSeq, '1');
  assert.equal(ov.dataset.ubRunning, undefined, '끝나면 진행 표식이 지워진다');
});


// ── 쓰기 직전 게이트·중단 재확인 (4R Terra P1) + 미처리 집계 (Opus P2-1) ──────────
test('재조회 대기 중 팝업에서 게이트를 끄면 취소 GET 이 나가지 않고, 그 건은 미처리로 남는다', async () => {
  const state = { ubSkin: true, ubHqConfirm: true };
  const inner = makeRequery({ '101': [{ code: 'O--' }, { code: 'OC-' }] });
  const flipping = async (seq, date) => { const r = await inner(seq, date); state.ubHqConfirm = false; return r; };   // 응답 직후 OFF
  const deps = baseDeps({ state, fetchOrderRow: flipping });
  const r = await build(deps).ccRunCancelBatch([T1], () => {}, () => false);
  assert.equal(deps.fetch.calls.length, 0);
  assert.deepEqual(r, { success: 0, failed: [], uncertain: [], processed: 0, total: 1 }, '손대지 않은 건은 processed 에 안 센다');
});
test('재조회 대기 중 [중단] 을 누르면 취소 GET 이 나가지 않고, 그 건은 미처리로 남는다', async () => {
  let abort = false;
  const inner = makeRequery({ '101': [{ code: 'O--' }, { code: 'OC-' }] });
  const flipping = async (seq, date) => { const r = await inner(seq, date); abort = true; return r; };
  const deps = baseDeps({ fetchOrderRow: flipping });
  const r = await build(deps).ccRunCancelBatch([T1, T2], () => {}, () => abort);
  assert.equal(deps.fetch.calls.length, 0);
  assert.equal(r.processed, 0);
  assert.equal(r.total - r.processed, 2, '요약은 미처리 2건');
});
test('실행 중 예외: 그 건이 실패로 남아 요약이 "처리 완료" 가 되지 않는다(Opus P2-1)', async () => {
  const deps = baseDeps({ fetchOrderRow: async () => { throw new Error('boom'); } });
  const sb = build(deps);
  const r = await sb.ccRunCancelBatch([T1], () => {}, () => false);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].orderSeq, '101');
  assert.match(r.failed[0].reason, /^실행 오류: boom/);
  assert.equal(sb.busy(), false, '예외여도 busy 는 풀린다');
});
// ── 실행 중 상호 배타 표식 (Opus P2-2) ────────────────────────────────────────
test('배치가 도는 동안 cBatchBusy 가 세워져 있다(작업C 와 상호 배타 — §5.4)', async () => {
  const seen = [];
  const inner = makeRequery({ '101': [{ code: 'O--' }, { code: 'OC-' }] });
  let sb;
  const observing = async (seq, date) => { seen.push(sb.busy()); return inner(seq, date); };
  const deps = baseDeps({ fetchOrderRow: observing });
  sb = build(deps);
  const r = await sb.ccRunCancelBatch([T1], () => {}, () => false);
  assert.equal(r.success, 1);
  assert.deepEqual(seen, [true, true], '재조회 시점마다 busy 였어야 한다');
  assert.equal(sb.busy(), false);
});

// ── 취소 링크 가드 (Fable P1) ─────────────────────────────────────────────────
//  쓰기 직전, 같은 응답의 행 HTML 에 서버가 렌더한 del('<seq>') 가 있고 orderSeq 와 정확히 같아야 GET 이 나간다.
test('취소 링크 가드: 행에 del() 링크가 없으면(라벨은 주문완료여도) GET 없이 실패', async () => {
  const deps = baseDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'O--', rowHtml: '<tr><td>주문완료</td></tr>' }] }) });
  const r = await build(deps).ccRunCancelBatch([T1], () => {}, () => false);
  assert.equal(deps.fetch.calls.length, 0);
  assert.equal(r.failed[0].reason, '취소 링크 없음(서버 렌더 기준 취소 불가)');
});
test('취소 링크 가드: 링크 인자가 다른 주문번호면 GET 없이 실패(다른 행이 취소되는 경로 차단)', async () => {
  const deps = baseDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'O--', rowHtml: '<tr><td>주문완료</td><td><a href="javascript:del(\'999\');">취소</a></td></tr>' }] }) });
  const r = await build(deps).ccRunCancelBatch([T1], () => {}, () => false);
  assert.equal(deps.fetch.calls.length, 0);
  assert.equal(r.failed[0].reason, '취소 링크 불일치(999)');
});
test('취소 링크 가드: 인자가 일치하면 GET 이 나간다(가드가 과하지 않다)', async () => {
  const deps = baseDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'O--', rowHtml: '<tr><td>주문완료</td><td><a href="javascript:del(\'101\');">취소</a></td></tr>' }, { code: 'OC-' }] }) });
  const r = await build(deps).ccRunCancelBatch([T1], () => {}, () => false);
  assert.equal(deps.fetch.calls.length, 1);
  assert.equal(r.success, 1);
});
test('ccRowCancelSeq: del 링크 인자 추출 — 따옴표 유무·공백·없음', () => {
  const sb = build(baseDeps());
  // 순수 함수라 샌드박스에서 바로 꺼내 쓴다
  const f = new Function(extractFn(SRC, 'ccRowCancelSeq') + '; return ccRowCancelSeq;')();
  assert.equal(f('<a href="javascript:del(\'389315\');">취소</a>'), '389315');
  assert.equal(f("<a href='javascript:del(389315)'>취소</a>"), '389315');
  assert.equal(f('<a href="javascript: del( "7" )">x</a>'), '7');
  assert.equal(f('<tr><td>주문취소</td></tr>'), null);
  assert.equal(f(null), null);
  assert.equal(f('<a href="javascript:modify(\'1\',\'2\')">수정</a>'), null);
  void sb;
});

// ── 툴바 버튼 주입·배선 (Fable P2-1) ────────────────────────────────────────────
function fakeToolbarDoc(anchorCount) {
  const mk = (tag) => ({ tag, children: [], handlers: {}, style: {}, dataset: {},
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
    dispatch(type, ev) { return Promise.all((this.handlers[type] || []).map(fn => fn(Object.assign({ target: this }, ev)))); },
    appendChild(c) { this.children.push(c); return c; } });
  const cell = mk('td');
  const anchors = [];
  for (let i = 0; i < anchorCount; i++) {
    const a = mk('a'); a.parentNode = cell; a.href = 'javascript:standby(form1,form3,\'OS-\',\'O--\');';
    a.insertAdjacentElement = (where, el) => { const k = cell.children.indexOf(a); cell.children.splice(k + 1, 0, el); el.parentNode = cell; };
    cell.children.push(a); anchors.push(a);
  }
  const byId = {};
  const document = {
    anchors, cell,
    querySelectorAll: (sel) => (sel === 'a[href*="standby"]' ? anchors.slice() : []),
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => mk(tag),
    head: { appendChild() {} }, documentElement: { appendChild() {} }, body: mk('body')
  };
  document.register = (el) => { byId[el.id] = el; };
  return document;
}
function buildInject(deps) {
  const names = ['injectBulkCancelButton', 'onBulkCancelClick', 'ccClassifyChecked', 'ccTargetStatus'];
  // eslint-disable-next-line no-new-func
  const factory = new Function('deps',
    'const state = deps.state; let cBatchBusy = false; const CC_BTN_ID = "ub-cancel-btn";\n' +
    'const ccLog = () => {}; const ensureCcStyle = () => {}; const isOrderJunList = () => deps.onListPage;\n' +
    'const document = deps.document; const cReadCheckedRows = () => [];\n' +
    'const dialogCalls = []; const ccShowApprovalDialog = (cls) => { dialogCalls.push(cls); };\n' +
    names.map(n => extractFn(SRC, n)).join('\n') + '\n' +
    'return { injectBulkCancelButton, onBulkCancelClick, dialogCalls };');
  return factory(deps);
}
test('injectBulkCancelButton: 마지막 standby 앵커 뒤에 [일괄취소] 1개, 게이트 ON 이면 보이고 idempotent', () => {
  const document = fakeToolbarDoc(2);
  const sb = buildInject({ state: { ubSkin: true, ubHqConfirm: true }, document, onListPage: true });
  sb.injectBulkCancelButton();
  const btns = document.cell.children.filter(c => c.tag === 'button');
  assert.equal(btns.length, 1);
  assert.equal(btns[0].textContent, '일괄취소');
  assert.equal(btns[0].id, 'ub-cancel-btn');
  assert.equal(document.cell.children.indexOf(btns[0]), 2, '두 앵커([본사확인]·[본사확인취소]) 뒤');
  assert.equal(btns[0].style.display, '');
  document.register(btns[0]);
  sb.injectBulkCancelButton();   // 두 번 불러도 하나
  assert.equal(document.cell.children.filter(c => c.tag === 'button').length, 1);
});
test('injectBulkCancelButton: 게이트 OFF 면 주입은 하되 display:none, 목록 페이지가 아니면 주입 안 함', () => {
  const d1 = fakeToolbarDoc(2);
  buildInject({ state: { ubSkin: true, ubHqConfirm: false }, document: d1, onListPage: true }).injectBulkCancelButton();
  const b = d1.cell.children.find(c => c.tag === 'button');
  assert.ok(b); assert.equal(b.style.display, 'none');
  const d2 = fakeToolbarDoc(2);
  buildInject({ state: { ubSkin: true, ubHqConfirm: true }, document: d2, onListPage: false }).injectBulkCancelButton();
  assert.equal(d2.cell.children.filter(c => c.tag === 'button').length, 0);
  const d3 = fakeToolbarDoc(0);   // 툴바 앵커 없음 → 주입 안 함(fail-safe)
  buildInject({ state: { ubSkin: true, ubHqConfirm: true }, document: d3, onListPage: true }).injectBulkCancelButton();
  assert.equal(d3.cell.children.length, 0);
});
test('툴바 [일괄취소]: 페이지 스크립트의 .click()(isTrusted=false) 은 승인창을 열지 않는다', async () => {
  const document = fakeToolbarDoc(2);
  const sb = buildInject({ state: { ubSkin: true, ubHqConfirm: true }, document, onListPage: true });
  sb.injectBulkCancelButton();
  const btn = document.cell.children.find(c => c.tag === 'button');
  await btn.dispatch('click', { isTrusted: false });
  assert.equal(sb.dialogCalls.length, 0);
  await btn.dispatch('click', { isTrusted: true });
  assert.equal(sb.dialogCalls.length, 1, '사용자 클릭은 연다');
});
test('배선: init() 과 chrome.storage.onChanged 의 changed 블록이 injectBulkCancelButton() 을 부른다', () => {
  const init = extractFn(SRC, 'init');
  assert.match(init, /^\s*injectBulkCancelButton\(\);/m, 'init() 안 호출');
  // 같은 시그니처의 리스너가 여럿이라(2136·6734·6753행 계열) 'forceAlwaysOn' 을 부르는 상태 갱신 리스너로 특정한다
  const anchorIdx = SRC.indexOf('forceAlwaysOn();   // 외부에서 false 로 바뀌어도 매번 상시 ON 유지');
  assert.ok(anchorIdx > 0, '상태 갱신 onChanged 리스너의 forceAlwaysOn 줄');
  const i = SRC.lastIndexOf('chrome.storage.onChanged.addListener((ch, area) => {', anchorIdx);
  assert.ok(i > 0);
  // 리스너 본문은 forEach 의 '});' 가 먼저 나와 문자열 경계로 못 자른다 → 그 리스너 안의 changed 블록 끝(injectHqConfirmButton 호출 뒤)까지 본다
  const j = SRC.indexOf('injectHqConfirmButton();', i);
  assert.ok(j > i && j - i < 1500, 'onChanged 리스너 안에 injectHqConfirmButton 호출이 있어야 한다');
  const block = SRC.slice(i, SRC.indexOf('\n', SRC.indexOf('\n', j) + 1) + 1);   // 그 다음 줄까지
  assert.match(block, /injectBulkCancelButton\(\);/, 'onChanged 안 호출(injectHqConfirmButton 바로 다음 줄)');
});

// ── 진행 중 배경 클릭 가드 (Fable P2-2) ──────────────────────────────────────
test('승인창: 배치가 도는 동안 배경 클릭으로 닫히지 않고, 끝난 뒤에는 닫힌다', async () => {
  const document = fakeDom();
  let resolveBatch;
  const pending = new Promise((res) => { resolveBatch = res; });
  const sb = buildDialog({ document, ccRunCancelBatch: () => pending });
  sb.ccShowApprovalDialog({ targets: [{ orderSeq: '1', code: 'O--', orderDate: '20260911' }], excluded: [], duplicate: false });
  const ov = document.body.children[0];
  const foot = ov.children[0].children.find(c => c.sel === '.ub-hq-f');
  const go = foot.children.find(b => b.tag === 'button' && b.textContent === '취소 진행');
  const running = go.dispatch('click', { isTrusted: true });       // 배치 시작(미해결)
  await Promise.resolve();
  await ov.dispatch('click', {});                                    // 배경 클릭
  assert.notEqual(ov.removed, true, '진행 중에는 닫히지 않는다');
  resolveBatch({ success: 1, failed: [], uncertain: [], processed: 1, total: 1 });
  await running;
  await ov.dispatch('click', {});
  assert.equal(ov.removed, true, '끝난 뒤 배경 클릭은 닫는다');
});

// ── cReadCheckedRows 의 cs (DOM 함수 — 소스 핀) ──────────────────────────────
test('cReadCheckedRows: 행마다 배정 팝업 링크 여부와 바코드(cs)를 읽는다(소스 핀 — DOM 함수)', () => {
  const src = extractFn(SRC, 'cReadCheckedRows');
  assert.ok(/a\[href\*="currentSetting"\]/.test(src) && /parseCurrentSettingArgs\(/.test(src), '링크 인자를 파싱한다');
  assert.ok(/cs:\s*cs/.test(src) && /cs = \{ has: true, barcode: String\(args\.barcode \|\| ''\) \}/.test(src), 'cs 필드');
  assert.ok(/\\\(\(\[\^\(\)\]\+\)\\\)\\s\*\$/.test(src), '링크가 없으면 상태 셀 괄호값(출고완료 (250HHL))을 바코드로');
});

// ── 쓰기 4종 디스패치 (스펙 2026-09-16 §4.4) ────────────────────────────────
const F = () => ({ reqPage: '1', pageSize: '100' });
test('ccDoStandbyOff: POST orderItemStandby.do status1=O--&status2=OS-&sKey, 본문 idx=<seq>, dispatched=true', async () => {
  const deps = baseDeps(); const sb = build(deps);
  const d = await sb.ccDoStandbyOff('101', 'K1', F());
  assert.equal(d.dispatched, true);
  const c = deps.fetch.calls[0];
  assert.ok(c.url.startsWith('/jun/orderitem/orderItemStandby.do?'));
  const p = new URL('http://x' + c.url).searchParams;
  assert.equal(p.get('status1'), 'O--'); assert.equal(p.get('status2'), 'OS-'); assert.equal(p.get('sKey'), 'K1'); assert.equal(p.get('pageSize'), '100');
  assert.equal(c.opts.method, 'POST'); assert.equal(c.opts.credentials, 'include'); assert.equal(String(c.opts.body), 'idx=101');
});
test('ccDoStandbyOff: sKey 없으면 dispatched=false, fetch 없음 / fetch 예외는 dispatched=true(도달 불명)', async () => {
  const deps = baseDeps(); const sb = build(deps);
  assert.deepEqual(await sb.ccDoStandbyOff('101', '', F()), { dispatched: false, msg: 'URL 조립 실패(sKey 없음)' });
  assert.equal(deps.fetch.calls.length, 0);
  const deps2 = baseDeps({ fetch: async () => { throw new Error('net'); } }); const sb2 = build(deps2);
  assert.deepEqual(await sb2.ccDoStandbyOff('101', 'K1', F()), { dispatched: true, msg: '' });
});
test('ccDoUnassign: GET orderItemPopCurrentSettingCancel.do barcode+orderSeq+검색조건, dispatched=true; 빈 바코드면 false', async () => {
  const deps = baseDeps(); const sb = build(deps);
  const d = await sb.ccDoUnassign('2608ET', '101', F());
  assert.equal(d.dispatched, true);
  const c = deps.fetch.calls[0];
  assert.ok(c.url.startsWith('/jun/orderitem/orderItemPopCurrentSettingCancel.do?'));
  const p = new URL('http://x' + c.url).searchParams;
  assert.equal(p.get('barcode'), '2608ET'); assert.equal(p.get('orderSeq'), '101'); assert.equal(p.get('reqPage'), '1');
  assert.equal(c.opts.method, 'GET'); assert.equal(c.opts.credentials, 'include');
  assert.deepEqual(await sb.ccDoUnassign('', '101', F()), { dispatched: false, msg: 'URL 조립 실패(바코드/seq 없음)' });
  assert.equal(deps.fetch.calls.length, 1);
});
test('ccDoDelivDelete: 출고 건 찾기 → write-ahead 로그 → 삭제 POST 순서, 찾기 실패·로그 실패면 삭제 없음', async () => {
  const log = [], dels = [];
  const found = { ok: true, idx: '426106,250HHL,47295,101', sKey: 'DK', junNum: '000000010HR', delivDate: '26-09-15', shop: 'FASHION', status: '출고완료' };
  const deps = baseDeps({ ccFindDelivRow: async (bc, seq) => { log.push(['find', bc, seq]); return found; },
                          dcmAppendLog: (e) => { log.push(['log', e.phase, e.via, e.orderSeq, e.barcode, e.junNum, e.idx]); return true; },
                          dcmDelete: async (t, bc) => { dels.push([t.sKey, t.idx, bc]); log.push(['delete']); return { ok: true, msg: '' }; } });
  const sb = build(deps);
  assert.deepEqual(await sb.ccDoDelivDelete('250HHL', '101'), { dispatched: true, msg: '' });
  assert.deepEqual(dels, [['DK', '426106,250HHL,47295,101', '250HHL']]);
  assert.deepEqual(log.map(x => x[0]), ['find', 'log', 'delete', 'log'], '로그가 삭제보다 먼저(write-ahead), 뒤에 deleted 로그');
  assert.deepEqual(log[1], ['log', 'before_delete', 'bulkcancel', '101', '250HHL', '000000010HR', '426106,250HHL,47295,101']);
  // 찾기 실패
  const d2 = build(baseDeps({ ccFindDelivRow: async () => ({ ok: false, reason: '출고 건이 2건이라 특정 불가' }), dcmDelete: async () => { throw new Error('must not'); } }));
  assert.deepEqual(await d2.ccDoDelivDelete('250HHL', '101'), { dispatched: false, msg: '출고 건이 2건이라 특정 불가' });
  // 로그 실패
  const d3 = build(baseDeps({ ccFindDelivRow: async () => found, dcmAppendLog: () => false, dcmDelete: async () => { throw new Error('must not'); } }));
  assert.deepEqual(await d3.ccDoDelivDelete('250HHL', '101'), { dispatched: false, msg: '처리 로그를 남길 수 없어 삭제하지 않음' });
  // 삭제 POST 가 서버 msg 를 돌려주면 dispatched=true + msg(판정은 재조회가 한다)
  const d4 = build(baseDeps({ ccFindDelivRow: async () => found, dcmDelete: async () => ({ ok: false, msg: '삭제할 수 없습니다' }) }));
  assert.deepEqual(await d4.ccDoDelivDelete('250HHL', '101'), { dispatched: true, msg: '삭제할 수 없습니다' });
  // 삭제 POST 예외 → 도달 불명 → dispatched=true
  const d5 = build(baseDeps({ ccFindDelivRow: async () => found, dcmDelete: async () => { throw new Error('net'); } }));
  assert.deepEqual(await d5.ccDoDelivDelete('250HHL', '101'), { dispatched: true, msg: '' });
});
test('ccDoStep: 단계별로 알맞은 쓰기 함수 하나만 부른다, 모르는 단계는 dispatched=false', async () => {
  const deps = baseDeps({ ccFindDelivRow: async () => ({ ok: false, reason: 'x' }) }); const sb = build(deps);
  const row = { orderSeq: '101', sKey: 'K9' };
  await sb.ccDoStep({ kind: 'write', step: 'cancel', want: 'OC-' }, row, F());
  await sb.ccDoStep({ kind: 'write', step: 'standby-off', want: 'O--' }, row, F());
  await sb.ccDoStep({ kind: 'write', step: 'unassign', want: 'OS-', barcode: '2608ET' }, row, F());
  assert.deepEqual(deps.fetch.calls.map(c => c.url.split('?')[0]), ['/jun/orderitem/orderItemCancel.do', '/jun/orderitem/orderItemStandby.do', '/jun/orderitem/orderItemPopCurrentSettingCancel.do']);
  assert.equal(new URL('http://x' + deps.fetch.calls[0].url).searchParams.get('sKey'), 'K9');
  assert.deepEqual(await sb.ccDoStep({ kind: 'write', step: 'deliv-delete', want: 'I--', barcode: '250HHL' }, row, F()), { dispatched: false, msg: 'x' });
  assert.deepEqual(await sb.ccDoStep({ kind: 'write', step: 'nope' }, row, F()), { dispatched: false, msg: '알 수 없는 단계: nope' });
});

// ── 사슬 (스펙 2026-09-16 §4.3) ──────────────────────────────────────────────
const TT = { orderSeq: '101', code: 'T--', orderDate: '20260916' };
function chainDeps(over) {
  const dels = [], logs = [];
  return Object.assign(baseDeps({
    fetchOrderRow: makeRequery({ '101': [{ code: 'T--', assignedBarcode: '250HHL' }, { code: 'I--', assignedBarcode: '250HHL' }, { code: 'OS-', assignedBarcode: '' }, { code: 'O--' }, { code: 'OC-' }] }),
    ccFindDelivRow: async (bc, seq) => { logs.push(['find', bc, seq]); return { ok: true, idx: '426106,250HHL,47295,101', sKey: 'DK', junNum: '000000010HR', delivDate: '26-09-15', shop: 'FASHION', status: '출고완료' }; },
    dcmAppendLog: (e) => { logs.push(['log', e.phase]); return true; },
    dcmDelete: async (t, bc) => { dels.push([t.sKey, t.idx, bc]); return { ok: true, msg: '' }; }
  }), { dels, logs }, over || {});
}
test('사슬 전체: T-- → 출고장 삭제 → I-- → 선택취소 → OS- → 본사확인취소 → O-- → 취소 → OC- (요청 4개 순서·인자·sKey 원천)', async () => {
  const deps = chainDeps(); const sb = build(deps);
  const prog = [];
  const r = await sb.ccRunCancelBatch([TT], (m) => prog.push(m), () => false);
  assert.equal(r.success, 1, JSON.stringify(r)); assert.deepEqual(r.failed, []); assert.deepEqual(r.uncertain, []); assert.equal(r.processed, 1);
  assert.deepEqual(deps.dels, [['DK', '426106,250HHL,47295,101', '250HHL']]);
  assert.deepEqual(deps.logs, [['find', '250HHL', '101'], ['log', 'before_delete'], ['log', 'deleted']]);
  assert.deepEqual(deps.fetch.calls.map(c => c.url.split('?')[0]), ['/jun/orderitem/orderItemPopCurrentSettingCancel.do', '/jun/orderitem/orderItemStandby.do', '/jun/orderitem/orderItemCancel.do']);
  const u = new URL('http://x' + deps.fetch.calls[0].url).searchParams;
  assert.equal(u.get('barcode'), '250HHL'); assert.equal(u.get('orderSeq'), '101');
  const q = deps.fetchOrderRow.calls;
  assert.deepEqual(q.map(c => c.ret.code), ['T--', 'I--', 'OS-', 'O--', 'OC-'], '재조회 5회: 처음 + 단계 확인 4회');
  assert.equal(new URL('http://x' + deps.fetch.calls[1].url).searchParams.get('sKey'), q[2].ret.sKey, '본사확인취소 키 = OS- 확인 응답');
  assert.equal(new URL('http://x' + deps.fetch.calls[2].url).searchParams.get('sKey'), q[3].ret.sKey, '취소 키 = O-- 확인 응답');
  assert.deepEqual(deps.updates, [{ seq: '101', code: 'OC-' }], '화면 갱신은 끝 상태 1회');
  assert.ok(prog.some(m => /출고장 삭제\(250HHL\)/.test(m)) && prog.some(m => /선택취소\(250HHL\)/.test(m)) && prog.some(m => /본사확인취소/.test(m)) && prog.some(m => /취소 처리/.test(m)), prog.join(' | '));
  assert.equal(sb.busy(), false);
});
test('사슬: I-- 에서 시작하면 출고장 조회·삭제 없이 선택취소부터', async () => {
  const deps = chainDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'I--', assignedBarcode: '2608ET' }, { code: 'OS-' }, { code: 'O--' }, { code: 'OC-' }] }) });
  const r = await build(deps).ccRunCancelBatch([{ orderSeq: '101', code: 'I--', orderDate: '20260916' }], () => {}, () => false);
  assert.equal(r.success, 1); assert.deepEqual(deps.logs, []); assert.deepEqual(deps.dels, []);
  assert.equal(new URL('http://x' + deps.fetch.calls[0].url).searchParams.get('barcode'), '2608ET');
});
test('사슬 미확정: 선택취소 뒤 재조회가 계속 I-- 면 uncertain — 문구에 단계·현재 상태, 다음 건은 손대지 않는다', async () => {
  const deps = chainDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'T--', assignedBarcode: '250HHL' }, { code: 'I--', assignedBarcode: '250HHL' }], '102': [{ code: 'O--' }, { code: 'OC-' }] }) });
  const r = await build(deps).ccRunCancelBatch([TT, T2], () => {}, () => false);
  assert.equal(r.success, 0); assert.equal(r.processed, 1); assert.deepEqual(r.failed, []);
  assert.equal(r.uncertain.length, 1); assert.equal(r.uncertain[0].orderSeq, '101');
  assert.match(r.uncertain[0].reason, /^선택취소\(250HHL\) 미확정 — 현재 상태: I--/);
  assert.equal(deps.fetch.calls.length, 1, '선택취소 GET 1회, 그 뒤 쓰기 없음(102 도 안 감)');
  assert.deepEqual(deps.updates, [{ seq: '101', code: 'I--' }], '미확정이라도 서버 상태로 화면 갱신');
});
test('사슬 실패: 출고 건을 특정 못 하면 삭제 없이 failed(사유), 중단', async () => {
  const deps = chainDeps({ ccFindDelivRow: async () => ({ ok: false, reason: '출고 건이 2건이라 특정 불가' }) });
  const r = await build(deps).ccRunCancelBatch([TT], () => {}, () => false);
  assert.deepEqual(r.failed, [{ orderSeq: '101', reason: '출고장 삭제(250HHL) 실패: 출고 건이 2건이라 특정 불가' }]);
  assert.deepEqual(deps.dels, []); assert.equal(deps.fetch.calls.length, 0); assert.equal(r.processed, 1);
});
test('사슬 실패: 발주주문 입고완료(링크 없음)는 쓰기 없이 failed', async () => {
  const deps = chainDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'I--', assignedBarcode: '2609AY', link: false }] }) });
  const r = await build(deps).ccRunCancelBatch([{ orderSeq: '101', code: 'I--', orderDate: '20260916' }], () => {}, () => false);
  assert.deepEqual(r.failed, [{ orderSeq: '101', reason: '입고완료 — 배정 팝업 링크 없음(발주주문이거나 본사 계정이 아님), 수동' }]);
  assert.equal(deps.fetch.calls.length, 0); assert.deepEqual(deps.updates, [{ seq: '101', code: 'I--' }]);
});
test('사슬 실패: 링크 바코드와 상태 셀 바코드가 다르면 선택취소를 보내지 않는다', async () => {
  const deps = chainDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'I--', assignedBarcode: '2608ET', rowHtml: '<a href="javascript:currentSetting(\'1\',\'101\',\'2608EU\',\'NU\',\'1\',\'20260915\')">x</a>' }] }) });
  const r = await build(deps).ccRunCancelBatch([{ orderSeq: '101', code: 'I--', orderDate: '20260916' }], () => {}, () => false);
  assert.match(r.failed[0].reason, /배정 바코드 불일치/); assert.equal(deps.fetch.calls.length, 0);
});
test('사슬 중 중단: 한 단계 쓴 뒤 [중단] 이면 uncertain("중단 — 현재 상태") 로 남고 processed 는 줄지 않는다', async () => {
  let n = 0;
  const deps = chainDeps();
  // isAborted 호출: ① 건 시작 ② 첫 쓰기(출고장 삭제) 직전 ③ 두 번째 쓰기(선택취소) 직전 → ③ 에서 true
  const r = await build(deps).ccRunCancelBatch([TT], () => {}, () => (++n > 2));
  assert.equal(r.processed, 1);
  assert.equal(r.uncertain.length, 1); assert.match(r.uncertain[0].reason, /^중단 — 현재 상태: /);
  assert.ok(deps.dels.length === 1, '첫 쓰기는 나갔다');
});
test('사슬 중 재조회 실패(found=false): 확인 재조회가 죽으면 그 단계 미확정(현재 상태 불명)', async () => {
  const deps = chainDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'T--', assignedBarcode: '250HHL' }, { code: 'I--', assignedBarcode: '250HHL' }] }) });
  const inner = deps.fetchOrderRow; let k = 0;
  deps.fetchOrderRow = async (s, d) => { const r = await inner(s, d); k++; return k >= 3 ? Object.assign({}, r, { found: false, code: null }) : r; };
  const r = await build(deps).ccRunCancelBatch([TT], () => {}, () => false);
  // 출고장 삭제 확인(k=2, I--)은 성공이고 그 응답이 곧 다음 근거라 판정용 재조회는 없다 → 선택취소 GET 뒤 확인 재조회(k≥3)가 found=false → 미확정
  assert.deepEqual(r.failed, []);
  assert.equal(r.uncertain.length, 1); assert.match(r.uncertain[0].reason, /^선택취소\(250HHL\) 미확정 — 현재 상태: 불명/);
  assert.equal(deps.fetch.calls.length, 1);
});
test('단계 상한: 루프는 CC_MAX_STEPS(6) 로 막혀 있다(정상 전이로는 5회 안에 끝나 도달 불가 — 방어 상수 핀)', () => {
  const src = extractFn(SRC, 'ccRunCancelBatch');
  assert.ok(/step < CC_MAX_STEPS/.test(src) && /const CC_MAX_STEPS = 6;/.test(SRC), '상한 상수와 루프 조건');
});

// ── 승인창: 행별 사슬 표시·경고 (스펙 2026-09-16 §4.2) ───────────────────────
test('승인창: 대상 행마다 "orderSeq — 현재 상태 → 거칠 단계" 를 보여주고, 출고장 삭제·재고 반환 경고를 명시한다', () => {
  const document = fakeDom();
  const sb = buildDialog({ document, ccRunCancelBatch: async () => ({ success: 0, failed: [], uncertain: [], processed: 0, total: 0 }) });
  sb.ccShowApprovalDialog({ targets: [
      { orderSeq: '1', code: 'T--', orderDate: '20260916', cs: { has: false, barcode: '250HHL' } },
      { orderSeq: '2', code: 'I--', orderDate: '20260916', cs: { has: true, barcode: '2608ET' } },
      { orderSeq: '3', code: 'O--', orderDate: '20260916' }
    ], excluded: [{ orderSeq: '4', code: 'TS-', reason: '출고확인(매장재고) — 매장이 입고 확인한 건, 수동' }], duplicate: false });
  const card = document.body.children[0].children[0];
  const html = card.innerHTML;
  assert.ok(/1 — 출고완료 \(250HHL\) → 출고장 삭제 · 선택취소 · 본사확인취소 · 취소/.test(html), html);
  assert.ok(/2 — 입고완료 \(2608ET\) → 선택취소 · 본사확인취소 · 취소/.test(html));
  assert.ok(/3 — 주문완료 → 취소/.test(html));
  assert.ok(/4 — 출고확인\(매장재고\)/.test(html), '제외 사유');
  assert.ok(/출고완료 건은 출고장 삭제, 입고완료 건은 재고 반환\(선택취소\)이 함께 실행됩니다\. 되돌릴 수 없습니다\./.test(html));
  assert.ok(/취소된 주문서는 복구되지 않습니다\./.test(html), 'ERP 원문 경고는 그대로');
});
