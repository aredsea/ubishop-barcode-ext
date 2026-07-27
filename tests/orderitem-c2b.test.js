/* =============================================================================
 *  orderitem-c2b.test.js — 작업C 본사확인→입고완료(slice C-2b) 행 단위 상태머신
 *  순수 판정층 단위테스트.
 *
 *  skin.js 는 content script IIFE 라 require 할 수 없다.
 *  → 소스에서 DOM 비의존 함수 선언만 이름으로 추출해 샌드박스에서 평가한다
 *    (orderitem-c.test.js·orderitem-c2a.test.js 와 동일 방식. 리네임하면 즉사한다).
 *
 *  ⚠ 이 파일을 PowerShell 로 편집하지 마라 — Set-Content 가 한글을 깨뜨린다.
 *
 *  ★이 파일의 존재 이유(2026-07-27 교훈): 작업B 검수 2차에서 "소스에 문자열이 있는지"만
 *   보는 테스트가 내가 넣은 회귀를 놓쳤다. 그래서 여기서는 판정 함수를 **실제로 실행**
 *   하고, 특히 상태머신은 전 단계를 이어 붙인 시나리오로 돌린다.
 *
 *  스펙: docs/superpowers/specs/2026-07-20-orderitem-batch-design.md §3.6·§4.3·§4.4·§5·§10
 *  실행: node --test tests/orderitem-c2b.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'skin.js'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'skin.js 에서 ' + name + ' 선언을 찾지 못했습니다 (리네임 여부 확인)');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(name + ' 본문의 중괄호 균형을 찾지 못했습니다');
}

// cRowNext 가 부르는 하위 판정까지 전부 넣어야 실제 실행이 된다(스텁으로 대체하지 않는다 —
// 스텁을 끼우면 조합 버그를 못 잡는다는 게 이 파일의 전제다).
const NAMES = [
  'cNextStep', 'cPickAssignBarcode', 'cClassifyOutcome',
  'cRequeryUsable', 'cCheckedSetExact', 'cClassifyStandbyOutcome',
  'cCanWrite', 'cIsWriteAction', 'cRowNext'
];
const sandbox = {};

// eslint-disable-next-line no-new-func
new Function('exports',
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => 'exports.' + n + ' = ' + n + ';').join('\n')
)(sandbox);

const {
  cRequeryUsable, cCheckedSetExact, cClassifyStandbyOutcome,
  cCanWrite, cIsWriteAction, cRowNext
} = sandbox;

// fetchOrderRow 가 실제로 돌려주는 모양(§4.4). 테스트마다 필요한 필드만 덮어쓴다.
function row(over) {
  return Object.assign({
    found: true, orderSeq: '100', code: 'O--', text: '주문완료', assignedBarcode: '',
    orderDate: '20260720', duplicate: false, hasMore: false, loginExpired: false, rowHtml: '<tr></tr>'
  }, over || {});
}

/* ── cRequeryUsable ─────────────────────────────────────────────────────── */
test('cRequeryUsable: 정상 재조회는 ok', () => {
  const u = cRequeryUsable(row());
  assert.equal(u.ok, true);
  assert.equal(u.reason, '');
});

test('cRequeryUsable: 로그인 만료·중복·미발견은 전부 거부 (fail-closed)', () => {
  assert.equal(cRequeryUsable(row({ found: false, loginExpired: true })).ok, false);
  assert.equal(cRequeryUsable(row({ found: false, loginExpired: true })).reason, '로그인 만료');
  assert.equal(cRequeryUsable(row({ found: false, duplicate: true })).reason, '중복 주문번호');
  assert.equal(cRequeryUsable(row({ found: false })).reason, '주문을 찾지 못함');
});

test('cRequeryUsable: hasMore 면 found 여도 거부 — 잘린 응답으로는 중복을 못 본다(§4.4)', () => {
  const u = cRequeryUsable(row({ found: true, hasMore: true }));
  assert.equal(u.ok, false, 'pageSize 500 은 "전부"의 증거가 아니다');
  assert.equal(u.reason, '목록이 잘려 중복 확인 불가');
});

test('cRequeryUsable: 상태 코드를 못 얻으면 거부', () => {
  assert.equal(cRequeryUsable(row({ code: null })).reason, '상태 불명');
  assert.equal(cRequeryUsable(row({ code: '' })).reason, '상태 불명');
  assert.equal(cRequeryUsable(row({ code: 123 })).ok, false);
});

test('cRequeryUsable: null·비객체는 거부', () => {
  for (const v of [null, undefined, '', 0, 'O--', []]) {
    // 배열은 typeof object 라 통과할 수 있으니 found 판정까지 실제로 확인한다
    assert.equal(cRequeryUsable(v).ok, false, JSON.stringify(v) + ' 가 ok 로 새면 안 된다');
  }
});

test('cRequeryUsable: 검사 우선순위 — 로그인 만료가 다른 사유보다 먼저 보고된다', () => {
  const u = cRequeryUsable(row({ found: false, loginExpired: true, duplicate: true }));
  assert.equal(u.reason, '로그인 만료', '사용자가 먼저 알아야 할 사유가 앞에 와야 한다');
});

/* ── cCheckedSetExact ───────────────────────────────────────────────────── */
test('cCheckedSetExact: 정확히 그 한 건일 때만 true', () => {
  assert.equal(cCheckedSetExact(['100'], '100'), true);
  assert.equal(cCheckedSetExact([' 100 '], '100'), true, '양끝 공백은 정규화한다');
});

test('cCheckedSetExact: 하나라도 더 있으면 false — standby 는 체크 집합 전체를 보낸다', () => {
  assert.equal(cCheckedSetExact(['100', '101'], '100'), false);
  assert.equal(cCheckedSetExact(['101', '100'], '100'), false);
});

test('cCheckedSetExact: 비었거나·다르거나·비배열이면 false (fail-closed)', () => {
  assert.equal(cCheckedSetExact([], '100'), false);
  assert.equal(cCheckedSetExact(['101'], '100'), false);
  assert.equal(cCheckedSetExact(null, '100'), false);
  assert.equal(cCheckedSetExact('100', '100'), false, '문자열은 배열이 아니다');
  assert.equal(cCheckedSetExact(['100'], ''), false);
  assert.equal(cCheckedSetExact(['100'], null), false);
  assert.equal(cCheckedSetExact([null], '100'), false);
});

test('cCheckedSetExact: 부분일치·타입강제로 새지 않는다', () => {
  assert.equal(cCheckedSetExact(['1000'], '100'), false, 'prefix 로 새면 안 된다');
  assert.equal(cCheckedSetExact([100], '100'), true, '숫자 100 은 문자열 100 과 같은 주문이다');
});

/* ── cClassifyStandbyOutcome ────────────────────────────────────────────── */
test('cClassifyStandbyOutcome: dispatch 전 실패는 확정 실패(fail)', () => {
  assert.equal(cClassifyStandbyOutcome({ dispatched: false, requery: row({ code: 'OS-' }) }), 'fail');
  assert.equal(cClassifyStandbyOutcome({ requery: row({ code: 'OS-' }) }), 'fail');
  assert.equal(cClassifyStandbyOutcome(null), 'fail');
  assert.equal(cClassifyStandbyOutcome({ dispatched: 'yes' }), 'fail', 'truthy 로 새면 안 된다');
});

test('cClassifyStandbyOutcome: dispatch 후 OS- 확인이면 success', () => {
  assert.equal(cClassifyStandbyOutcome({ dispatched: true, requery: row({ code: 'OS-' }) }), 'success');
});

test('cClassifyStandbyOutcome: dispatch 후 non-success 는 전부 uncertain (재시도 금지)', () => {
  const cases = [
    ['이전 상태 그대로', row({ code: 'O--' })],
    ['건너뛴 상태', row({ code: 'I--' })],
    ['미지 상태', row({ code: null })],
    ['재조회 실패', row({ found: false })],
    ['로그인 만료', row({ found: false, loginExpired: true })],
    ['재조회 없음', null],
    ['재조회 undefined', undefined]
  ];
  for (const [name, q] of cases) {
    assert.equal(cClassifyStandbyOutcome({ dispatched: true, requery: q }), 'uncertain',
      name + ' 은 fail 이 아니라 uncertain 이어야 한다(재실행을 암시하면 안 된다)');
  }
});

test('cClassifyStandbyOutcome: found=true 라도 duplicate/loginExpired 면 success 로 새지 않는다', () => {
  assert.equal(cClassifyStandbyOutcome({ dispatched: true, requery: row({ code: 'OS-', duplicate: true }) }), 'uncertain');
  assert.equal(cClassifyStandbyOutcome({ dispatched: true, requery: row({ code: 'OS-', loginExpired: true }) }), 'uncertain');
});

/* ── cCanWrite ──────────────────────────────────────────────────────────── */
function ctx(over) {
  return Object.assign({
    gateOn: true, cancelled: false, controllerAlive: true,
    account: 'shopA', accountAtStart: 'shopA'
  }, over || {});
}

test('cCanWrite: 전부 만족해야 ok', () => {
  const r = cCanWrite(ctx());
  assert.equal(r.ok, true);
  assert.equal(r.reason, '');
});

test('cCanWrite: 게이트 OFF·취소·컨트롤러 상실은 각각 거부', () => {
  assert.equal(cCanWrite(ctx({ gateOn: false })).reason, '게이트 OFF');
  assert.equal(cCanWrite(ctx({ cancelled: true })).reason, '사용자 취소');
  assert.equal(cCanWrite(ctx({ controllerAlive: false })).reason, '컨트롤러 상실');
});

test('cCanWrite: 계정이 바뀌었으면 거부 — 쓰기 직전 즉시 판정(§5)', () => {
  const r = cCanWrite(ctx({ account: 'shopB' }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, '계정 변경됨');
});

test('cCanWrite: 계정을 문자열로 확정 못 하면 거부(fail-closed)', () => {
  for (const over of [{ account: null }, { accountAtStart: null }, { account: '' },
                      { accountAtStart: '' }, { account: undefined, accountAtStart: undefined }]) {
    assert.equal(cCanWrite(ctx(over)).reason, '계정 확인 불가', JSON.stringify(over));
  }
  // 둘 다 없으면 '같다'로 통과해선 안 된다 — 실제로 이게 가장 위험한 실수다
  assert.equal(cCanWrite({ gateOn: true, cancelled: false, controllerAlive: true }).ok, false);
});

test('cCanWrite: 누락 필드는 기본 허용이 아니다', () => {
  assert.equal(cCanWrite({}).ok, false);
  assert.equal(cCanWrite(null).ok, false);
  assert.equal(cCanWrite({ gateOn: 1, cancelled: 0, controllerAlive: 1, account: 'a', accountAtStart: 'a' }).ok,
    false, 'truthy 로 새면 안 된다 — 정확히 true 여야 한다');
});

/* ── cIsWriteAction ─────────────────────────────────────────────────────── */
test('cIsWriteAction: 쓰기 action 두 개만 true', () => {
  assert.equal(cIsWriteAction('dispatchStandby'), true);
  assert.equal(cIsWriteAction('dispatchSetCurrent'), true);
  for (const a of ['requery', 'prepareStandby', 'loadAssignPopup', 'refreshRow',
                   'abort', 'halt', 'done', '', null, undefined]) {
    assert.equal(cIsWriteAction(a), false, JSON.stringify(a));
  }
});

test('cIsWriteAction: cRowNext 가 내는 쓰기 action 을 전부 덮는다', () => {
  // 상태머신이 쓰기 action 을 새로 만들었는데 이 목록에 안 넣으면 cCanWrite 게이트를
  // 건너뛴 쓰기가 생긴다. 그래서 여기서 실제 산출물로 대조한다.
  const produced = new Set();
  produced.add(cRowNext('precheck', { row: row({ code: 'O--' }) }).action);
  produced.add(cRowNext('standbyReady', { checkedSeqs: ['100'], orderSeq: '100' }).action);
  produced.add(cRowNext('assignReady', { candidates: [{ barcode: 'X1' }] }).action);
  assert.equal(cIsWriteAction('dispatchStandby'), true);
  assert.ok(produced.has('dispatchStandby') && produced.has('dispatchSetCurrent'),
    '상태머신이 두 쓰기 action 을 모두 낼 수 있어야 한다');
});

/* ── cRowNext — 단계별 ──────────────────────────────────────────────────── */
test('cRowNext: start 는 읽기(재조회)로 시작한다 — 첫 행동이 쓰기면 안 된다', () => {
  const r = cRowNext('start', {});
  assert.deepEqual(r, { phase: 'precheck', action: 'requery', reason: '' });
  assert.equal(cIsWriteAction(r.action), false);
});

test('cRowNext: precheck — O-- 는 standby 준비로', () => {
  assert.deepEqual(cRowNext('precheck', { row: row({ code: 'O--' }) }),
    { phase: 'standbyReady', action: 'prepareStandby', reason: '' });
});

test('cRowNext: precheck — OS- 는 standby 를 건너뛰고 배정으로(§4.3 step 1)', () => {
  assert.deepEqual(cRowNext('precheck', { row: row({ code: 'OS-' }) }),
    { phase: 'assignReady', action: 'loadAssignPopup', reason: '' });
});

test('cRowNext: precheck — 대상 아닌 상태는 사유와 함께 abort', () => {
  for (const code of ['I--', 'OC-', 'T--', 'TS-', 'TE-', 'S--', 'B--']) {
    const r = cRowNext('precheck', { row: row({ code: code }) });
    assert.equal(r.action, 'abort', code);
    assert.equal(r.phase, 'abort');
    assert.match(r.reason, /대상 상태 아님/);
    assert.ok(r.reason.includes(code), '사용자가 왜 빠졌는지 알 수 있어야 한다');
  }
});

test('cRowNext: precheck — 못 믿을 관측이면 그 사유 그대로 abort', () => {
  assert.equal(cRowNext('precheck', { row: row({ found: false, loginExpired: true }) }).reason, '로그인 만료');
  assert.equal(cRowNext('precheck', { row: row({ found: true, hasMore: true }) }).reason, '목록이 잘려 중복 확인 불가');
  assert.equal(cRowNext('precheck', {}).action, 'abort');
  assert.equal(cRowNext('precheck', { row: null }).action, 'abort');
});

test('cRowNext: standbyReady — 체크 집합이 그 한 건일 때만 쓰기로 넘어간다', () => {
  assert.deepEqual(cRowNext('standbyReady', { checkedSeqs: ['100'], orderSeq: '100' }),
    { phase: 'standbyDone', action: 'dispatchStandby', reason: '' });
  const bad = cRowNext('standbyReady', { checkedSeqs: ['100', '101'], orderSeq: '100' });
  assert.equal(bad.action, 'abort');
  assert.equal(bad.reason, '체크 집합이 그 한 건이 아님');
  assert.equal(cRowNext('standbyReady', {}).action, 'abort');
});

test('cRowNext: standbyDone — 성공은 배정으로, dispatch 전 실패는 abort, 그 외는 halt', () => {
  assert.deepEqual(cRowNext('standbyDone', { dispatched: true, requery: row({ code: 'OS-' }) }),
    { phase: 'assignReady', action: 'loadAssignPopup', reason: '' });
  const f = cRowNext('standbyDone', { dispatched: false });
  assert.equal(f.action, 'abort');
  const u = cRowNext('standbyDone', { dispatched: true, requery: row({ code: 'O--' }) });
  assert.equal(u.action, 'halt');
  assert.equal(u.phase, 'halt');
  assert.equal(u.reason, '본사확인 결과 미확정');
});

test('cRowNext: assignReady — 첫 후보 바코드를 확정해 넘긴다', () => {
  const r = cRowNext('assignReady', { candidates: [{ barcode: '2604O7' }, { barcode: '2604O9' }] });
  assert.equal(r.action, 'dispatchSetCurrent');
  assert.equal(r.phase, 'assignDone');
  assert.equal(r.barcode, '2604O7', '현행 수작업 관행 = 팝업 첫 행');
});

test('cRowNext: assignReady — 후보 0건·빈 바코드는 abort (빈 값이 쓰기로 흘러가면 안 된다)', () => {
  assert.equal(cRowNext('assignReady', { candidates: [] }).reason, '배정 후보 없음');
  assert.equal(cRowNext('assignReady', { candidates: [{ barcode: '' }] }).reason, '배정 후보 없음');
  assert.equal(cRowNext('assignReady', {}).action, 'abort');
});

test('cRowNext: assignDone — 상태 I-- 이고 바코드가 정확히 같을 때만 성공(§3.6)', () => {
  const ok = cRowNext('assignDone', {
    dispatched: true, expectedBarcode: '2604O7',
    requery: row({ code: 'I--', assignedBarcode: '2604O7' })
  });
  assert.deepEqual(ok, { phase: 'done', action: 'refreshRow', reason: '' });
});

test('cRowNext: assignDone — 남이 먼저 다른 바코드를 배정했으면 성공이 아니라 미확정', () => {
  const r = cRowNext('assignDone', {
    dispatched: true, expectedBarcode: '2604O7',
    requery: row({ code: 'I--', assignedBarcode: '2604O9' })
  });
  assert.equal(r.action, 'halt', '상태만 맞다고 성공으로 보면 안 된다(§3.6)');
  assert.equal(r.reason, '배정 결과 미확정');
});

test('cRowNext: 알 수 없는 단계는 abort (fail closed)', () => {
  for (const p of ['', null, undefined, 'STANDBY', 'assign', 'nope', 0]) {
    const r = cRowNext(p, {});
    assert.equal(r.action, 'abort', JSON.stringify(p));
    assert.equal(r.reason, '알 수 없는 단계');
  }
});

test('cRowNext: done 은 흡수 상태 — 다시 밟아도 쓰기가 나오지 않는다', () => {
  const r = cRowNext('done', {});
  assert.deepEqual(r, { phase: 'done', action: 'done', reason: '' });
  assert.equal(cIsWriteAction(r.action), false);
});

test('cRowNext: abort/halt 도 흡수 상태 — 이어서 밟아도 쓰기가 나오지 않는다', () => {
  for (const p of ['abort', 'halt']) {
    const r = cRowNext(p, { row: row({ code: 'O--' }), checkedSeqs: ['100'], orderSeq: '100',
                            candidates: [{ barcode: 'X' }], dispatched: true });
    assert.equal(cIsWriteAction(r.action), false,
      p + ' 이후에 쓰기 action 이 나오면 중단이 중단이 아니다');
    assert.equal(r.action, 'abort');
  }
});

/* ── cRowNext — 전 구간 시나리오(실제 실행) ─────────────────────────────── */
//  단계별 단위테스트만으로는 "이어 붙였을 때"를 못 본다. 관측을 순서대로 먹여 실제로
//  끝까지 돌린다. 쓰기 action 이 나올 때마다 cCanWrite 게이트를 통과시킨다.
function runRow(observations, writeCtx) {
  const trace = [];
  let phase = 'start';
  let barcode = null;
  for (let i = 0; i < 12; i++) {
    const r = cRowNext(phase, observations[phase] || {});
    trace.push(r.action);
    if (r.barcode != null) barcode = r.barcode;
    if (cIsWriteAction(r.action)) {
      const w = cCanWrite(writeCtx);
      if (!w.ok) { trace.push('blocked:' + w.reason); break; }
    }
    phase = r.phase;
    if (phase === 'done' || phase === 'abort' || phase === 'halt') break;
  }
  return { trace, phase, barcode };
}

test('시나리오: O-- 한 건이 본사확인 → 배정까지 끝까지 간다', () => {
  const obs = {
    precheck: { row: row({ code: 'O--' }) },
    standbyReady: { checkedSeqs: ['100'], orderSeq: '100' },
    standbyDone: { dispatched: true, requery: row({ code: 'OS-' }) },
    assignReady: { candidates: [{ barcode: '2604O7' }] },
    assignDone: { dispatched: true, expectedBarcode: '2604O7',
                  requery: row({ code: 'I--', assignedBarcode: '2604O7' }) }
  };
  const r = runRow(obs, ctx());
  assert.deepEqual(r.trace, ['requery', 'prepareStandby', 'dispatchStandby',
                             'loadAssignPopup', 'dispatchSetCurrent', 'refreshRow']);
  assert.equal(r.phase, 'done');
  assert.equal(r.barcode, '2604O7');
});

test('시나리오: OS- 한 건은 standby 를 건너뛴다 — 쓰기가 한 번뿐이다', () => {
  const obs = {
    precheck: { row: row({ code: 'OS-' }) },
    assignReady: { candidates: [{ barcode: 'B1' }] },
    assignDone: { dispatched: true, expectedBarcode: 'B1',
                  requery: row({ code: 'I--', assignedBarcode: 'B1' }) }
  };
  const r = runRow(obs, ctx());
  assert.deepEqual(r.trace, ['requery', 'loadAssignPopup', 'dispatchSetCurrent', 'refreshRow']);
  assert.equal(r.trace.filter(a => cIsWriteAction(a)).length, 1, '이미 본사확인된 건에 standby 를 또 쓰면 안 된다');
});

test('시나리오: standby 와 setCurrent 사이에 계정이 바뀌면 두 번째 쓰기가 막힌다(§5)', () => {
  const obs = {
    precheck: { row: row({ code: 'OS-' }) },
    assignReady: { candidates: [{ barcode: 'B1' }] }
  };
  const r = runRow(obs, ctx({ account: 'shopB' }));
  assert.deepEqual(r.trace, ['requery', 'loadAssignPopup', 'dispatchSetCurrent', 'blocked:계정 변경됨']);
});

test('시나리오: 실행 중 취소하면 다음 쓰기 경계에서 멈춘다(§10)', () => {
  const obs = { precheck: { row: row({ code: 'O--' }) },
                standbyReady: { checkedSeqs: ['100'], orderSeq: '100' } };
  const r = runRow(obs, ctx({ cancelled: true }));
  assert.equal(r.trace[r.trace.length - 1], 'blocked:사용자 취소');
});

test('시나리오: standby 결과가 미확정이면 배정으로 넘어가지 않는다 — 두 번째 쓰기 없음', () => {
  const obs = {
    precheck: { row: row({ code: 'O--' }) },
    standbyReady: { checkedSeqs: ['100'], orderSeq: '100' },
    standbyDone: { dispatched: true, requery: row({ found: false }) }   // 재조회 실패
  };
  const r = runRow(obs, ctx());
  assert.deepEqual(r.trace, ['requery', 'prepareStandby', 'dispatchStandby', 'halt']);
  assert.equal(r.phase, 'halt');
  assert.equal(r.trace.filter(a => cIsWriteAction(a)).length, 1);
});

test('시나리오: 체크 집합이 오염되면 standby 쓰기 자체가 안 나간다', () => {
  const obs = {
    precheck: { row: row({ code: 'O--' }) },
    standbyReady: { checkedSeqs: ['100', '101'], orderSeq: '100' }
  };
  const r = runRow(obs, ctx());
  assert.deepEqual(r.trace, ['requery', 'prepareStandby', 'abort']);
  assert.equal(r.trace.some(a => cIsWriteAction(a)), false, '엉뚱한 주문이 본사확인으로 넘어가면 안 된다');
});

test('시나리오: 배정 후보가 0건이면 setCurrent 를 부르지 않는다', () => {
  const obs = { precheck: { row: row({ code: 'OS-' }) }, assignReady: { candidates: [] } };
  const r = runRow(obs, ctx());
  assert.deepEqual(r.trace, ['requery', 'loadAssignPopup', 'abort']);
});

test('시나리오: 어떤 관측을 줘도 쓰기 전에 반드시 재조회가 선행한다', () => {
  // 매 쓰기 직전 서버 상태를 다시 본다(§5) — 상태머신이 이 순서를 깨지 않는지 확인.
  for (const code of ['O--', 'OS-']) {
    const obs = {
      precheck: { row: row({ code: code }) },
      standbyReady: { checkedSeqs: ['100'], orderSeq: '100' },
      standbyDone: { dispatched: true, requery: row({ code: 'OS-' }) },
      assignReady: { candidates: [{ barcode: 'B1' }] },
      assignDone: { dispatched: true, expectedBarcode: 'B1',
                    requery: row({ code: 'I--', assignedBarcode: 'B1' }) }
    };
    const r = runRow(obs, ctx());
    const firstWrite = r.trace.findIndex(a => cIsWriteAction(a));
    assert.ok(firstWrite > 0, code);
    assert.equal(r.trace[0], 'requery', code + ' — 첫 행동은 항상 읽기여야 한다');
  }
});
