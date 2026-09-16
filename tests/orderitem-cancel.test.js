/* =============================================================================
 *  orderitem-cancel.test.js — 주문전표 일괄취소 순수 판정부 단위테스트.
 *
 *  skin.js 는 content script IIFE 라 require 할 수 없다.
 *  → 소스에서 DOM 비의존 함수 선언만 이름으로 추출해 샌드박스에서 평가한다
 *    (orderitem-c.test.js 와 동일 방식. 리네임하면 추출 실패로 즉사한다).
 *
 *  ⚠ 이 파일을 PowerShell 로 편집하지 마라 — Set-Content 가 한글을 깨뜨린다.
 *  스펙: docs/superpowers/specs/2026-09-11-orderitem-bulk-cancel-design.md §4.2·§4.4·§4.5
 *  실행: node --test tests/orderitem-cancel.test.js
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

const NAMES = ['ccTargetStatus', 'ccClassifyChecked', 'ccBuildCancelUrl', 'ccRedirectMsg', 'ccClassifyOutcome',
               'ccChainLabel', 'ccRequeryReason',
               'ccRowCancelSeq', 'parseCurrentSettingArgs', 'ccRowCurrentSetting', 'ccCellBarcode', 'ccRowIsJaego', 'ccNextStep', 'ccStepOutcome', 'ccPickDelivIdx', 'ccBuildUnassignUrl'];
const sandbox = {};

// eslint-disable-next-line no-new-func
new Function('exports',
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => 'exports.' + n + ' = ' + n + ';').join('\n')
)(sandbox);

const { ccTargetStatus, ccClassifyChecked, ccBuildCancelUrl, ccRedirectMsg, ccClassifyOutcome, ccChainLabel, ccRequeryReason,
        ccRowCurrentSetting, ccCellBarcode, ccRowIsJaego, ccNextStep, ccStepOutcome, ccPickDelivIdx, ccBuildUnassignUrl } = sandbox;

// ── ccTargetStatus ───────────────────────────────────────────────────────────
test('ccTargetStatus: O--/OS-/I--/T-- 만 true (사슬 대상, 스펙 2026-09-16 §4.1)', () => {
  for (const c of ['O--', 'OS-', 'I--', 'T--']) assert.equal(ccTargetStatus(c), true, c);
});
test('ccTargetStatus: OC-/TS-/TE-/S--/B-- 는 false', () => {
  for (const c of ['OC-', 'TS-', 'TE-', 'S--', 'B--']) assert.equal(ccTargetStatus(c), false, c);
});
test('ccTargetStatus: null/undefined/빈값/prefix/소문자/공백 전부 false (EXACT)', () => {
  for (const c of [null, undefined, '', 'O', 'O--x', 'o--', ' O--', 'O-- ', 'os-', 'I', 'T']) assert.equal(ccTargetStatus(c), false, String(c));
});

// ── ccClassifyChecked ───────────────────────────────────────────────────────
test('ccClassifyChecked: O--/OS-/T--/링크 있는 I-- 는 targets(원본 객체·순서 보존), 나머지는 excluded', () => {
  const rows = [
    { orderSeq: '1', code: 'O--', orderDate: '20260916' },
    { orderSeq: '2', code: 'OS-', orderDate: '20260916', cs: { has: true, barcode: '' } },
    { orderSeq: '3', code: 'I--', orderDate: '20260916', cs: { has: true, barcode: '2608ET' } },
    { orderSeq: '4', code: 'T--', orderDate: '20260916', cs: { has: false, barcode: '250HHL', jaego: true } },
    { orderSeq: '5', code: 'OC-', orderDate: '20260916' },
    { orderSeq: '6', code: 'T--', orderDate: '20260916', cs: { has: false, barcode: '2609AY', jaego: false } },   // 발주주문·유형 불명·13열 목록 전부 여기
    { orderSeq: '7', code: 'T--', orderDate: '20260916', cs: { has: false, barcode: '', jaego: true } }
  ];
  const r = ccClassifyChecked(rows);
  assert.deepEqual(r.targets, [rows[0], rows[1], rows[2], rows[3]]);
  assert.equal(r.targets[2], rows[2], '원본 객체 그대로');
  assert.deepEqual(r.excluded, [
    { orderSeq: '5', code: 'OC-', reason: '이미 취소됨' },
    { orderSeq: '6', code: 'T--', reason: '출고완료 — 재고주문이 아님(발주주문 등), 출고장을 지워도 배정 팝업이 없어 수동' },   // Opus 1R P2: 첫 쓰기 전에 거른다(양성 판정)
    { orderSeq: '7', code: 'T--', reason: '출고완료 — 상태 셀에서 바코드를 읽지 못함, 수동' }              // Opus 1R Nit
  ]);
  assert.equal(r.duplicate, false);
});
test('ccClassifyChecked: 제외 사유 매핑 — 발주주문 입고완료·출고확인·불명', () => {
  const r = ccClassifyChecked([
    { orderSeq: '1', code: 'I--' },                                   // cs 없음 = 링크 없음
    { orderSeq: '2', code: 'I--', cs: { has: false, barcode: '' } },
    { orderSeq: '3', code: 'I--', cs: { has: true, barcode: '' } },    // 링크는 있는데 바코드 빈값 → 자동 처리 불가
    { orderSeq: '4', code: 'TS-' }, { orderSeq: '5', code: 'TE-' }, { orderSeq: '6', code: 'S--' }, { orderSeq: '7', code: 'B--' },
    { orderSeq: '8', code: null }, { orderSeq: '9', code: 'ZZZ' }
  ]);
  assert.deepEqual(r.targets, []);
  assert.deepEqual(r.excluded.map(x => x.reason), [
    '입고완료 — 배정 팝업 링크 없음(발주주문이거나 본사 계정이 아님), 수동', '입고완료 — 배정 팝업 링크 없음(발주주문이거나 본사 계정이 아님), 수동', '입고완료 — 배정 팝업 링크 없음(발주주문이거나 본사 계정이 아님), 수동',
    '출고확인(매장재고) — 매장이 입고 확인한 건, 수동', '취소 불가 상태(출고오확인)', '취소 불가 상태(판매완료)', '취소 불가 상태(발주완료)',
    '상태 불명', '상태 불명'
  ]);
});
test('ccClassifyChecked: 같은 orderSeq 둘 이상 → duplicate=true (합치지 않는다)', () => {
  const r = ccClassifyChecked([{ orderSeq: '7', code: 'O--' }, { orderSeq: '7', code: 'O--' }]);
  assert.equal(r.duplicate, true);
  assert.equal(r.targets.length, 2);
});
test('ccClassifyChecked: 빈 입력·비배열은 빈 결과', () => {
  assert.deepEqual(ccClassifyChecked([]), { targets: [], excluded: [], duplicate: false });
  assert.deepEqual(ccClassifyChecked(null), { targets: [], excluded: [], duplicate: false });
});

// ── ccBuildCancelUrl ─────────────────────────────────────────────────────────
test('ccBuildCancelUrl: 네이티브 del() 과 같은 모양 — tcode·seq·sKey + 검색조건', () => {
  const u = ccBuildCancelUrl('12345', '260911135039701', { reqPage: '1', pageSize: '100', searchShop: '' });
  assert.ok(u.startsWith('/jun/orderitem/orderItemCancel.do?'), u);
  const p = new URL('http://x' + u).searchParams;
  assert.equal(p.get('tcode'), 'order_item');
  assert.equal(p.get('seq'), '12345');
  assert.equal(p.get('sKey'), '260911135039701');
  assert.equal(p.get('reqPage'), '1');
  assert.equal(p.get('pageSize'), '100');
  assert.equal(p.get('searchShop'), '');
});
test('ccBuildCancelUrl: seq 또는 sKey 가 비면 null (빈 값이 쓰기로 흘러가지 않는다)', () => {
  assert.equal(ccBuildCancelUrl('', 'k', {}), null);
  assert.equal(ccBuildCancelUrl('1', '', {}), null);
  assert.equal(ccBuildCancelUrl(null, 'k', {}), null);
  assert.equal(ccBuildCancelUrl('1', null, {}), null);
  assert.equal(ccBuildCancelUrl('  ', 'k', {}), null);
});
test('ccBuildCancelUrl: 검색조건이 고정 키(tcode/seq/sKey)를 덮지 못한다', () => {
  const u = ccBuildCancelUrl('1', 'k', { tcode: 'evil', seq: '999', sKey: 'zzz', searchWord1: '가나' });
  const p = new URL('http://x' + u).searchParams;
  assert.equal(p.get('tcode'), 'order_item');
  assert.equal(p.get('seq'), '1');
  assert.equal(p.get('sKey'), 'k');
  assert.equal(p.get('searchWord1'), '가나');
});
test('ccBuildCancelUrl: searchFields 없이도 동작, 숫자 seq 도 문자열로', () => {
  const u = ccBuildCancelUrl(42, 'k');
  assert.equal(new URL('http://x' + u).searchParams.get('seq'), '42');
});

// ── ccRedirectMsg ────────────────────────────────────────────────────────────
test('ccRedirectMsg: msg 있으면 trim 해서 반환', () => {
  assert.equal(
    ccRedirectMsg('http://h/jun/orderitem/orderItemList.do?tcode=order_item&msg=%20취소%20가능한%20상태가%20아닙니다%20'),
    '취소 가능한 상태가 아닙니다');
});
test('ccRedirectMsg: msg 없음·빈값·null·깨진 입력은 빈 문자열', () => {
  assert.equal(ccRedirectMsg('http://h/a.do?tcode=order_item'), '');
  assert.equal(ccRedirectMsg('http://h/a.do?msg='), '');
  assert.equal(ccRedirectMsg(null), '');
  assert.equal(ccRedirectMsg(''), '');
  assert.equal(ccRedirectMsg('::not a url::'), '');
});

// ── ccClassifyOutcome ────────────────────────────────────────────────────────
test('ccClassifyOutcome: dispatch 전은 fail (쓰기 없었음)', () => {
  assert.equal(ccClassifyOutcome({ dispatched: false, requery: { found: true, code: 'OC-' } }), 'fail');
  assert.equal(ccClassifyOutcome(null), 'fail');
  assert.equal(ccClassifyOutcome({}), 'fail');
});
test('ccClassifyOutcome: dispatch 후 재조회 found && OC- 만 success', () => {
  assert.equal(ccClassifyOutcome({ dispatched: true, requery: { found: true, code: 'OC-' } }), 'success');
});
test('ccClassifyOutcome: dispatch 후 그 외는 전부 uncertain (fail 아님 — 재시도 금지 신호)', () => {
  assert.equal(ccClassifyOutcome({ dispatched: true, requery: { found: true, code: 'O--' } }), 'uncertain');
  assert.equal(ccClassifyOutcome({ dispatched: true, requery: { found: true, code: 'OS-' } }), 'uncertain');
  assert.equal(ccClassifyOutcome({ dispatched: true, requery: { found: false, code: null } }), 'uncertain');
  assert.equal(ccClassifyOutcome({ dispatched: true, requery: null }), 'uncertain');
  assert.equal(ccClassifyOutcome({ dispatched: true }), 'uncertain');
});

// ── ccChainLabel (승인창 표시 전용) ─────────────────────────────────────────
test('ccChainLabel: 상태별 거칠 단계 문구, 바코드는 괄호로, 대상 아니면 빈 문자열', () => {
  assert.equal(ccChainLabel('O--', null), '주문완료 → 취소');
  assert.equal(ccChainLabel('OS-', { has: true, barcode: '' }), '본사확인 → 본사확인취소 · 취소');
  assert.equal(ccChainLabel('I--', { has: true, barcode: '2608ET' }), '입고완료 (2608ET) → 선택취소 · 본사확인취소 · 취소');
  assert.equal(ccChainLabel('T--', { has: false, barcode: '250HHL' }), '출고완료 (250HHL) → 출고장 삭제 · 선택취소 · 본사확인취소 · 취소');
  assert.equal(ccChainLabel('T--', null), '출고완료 → 출고장 삭제 · 선택취소 · 본사확인취소 · 취소');
  assert.equal(ccChainLabel('TS-', null), ''); assert.equal(ccChainLabel(null, null), '');
});
// ── ccRequeryReason ─────────────────────────────────────────────────────────
test('ccRequeryReason: found=false 사유 구분 — 로그인 만료 > 중복 > 잘림 > 행 없음', () => {
  assert.equal(ccRequeryReason({ found: false, loginExpired: true, duplicate: true }), '로그인 만료');
  assert.equal(ccRequeryReason({ found: false, duplicate: true, hasMore: true }), '중복 orderSeq(재조회)');
  assert.equal(ccRequeryReason({ found: false, hasMore: true }), '재조회 실패(결과 잘림 — 조건을 좁혀라)');
  assert.equal(ccRequeryReason({ found: false }), '재조회 실패(행 없음)');
  assert.equal(ccRequeryReason(null), '재조회 실패(행 없음)');
});

// ── ccNextStep / ccStepOutcome (스펙 2026-09-16 §4.5) ──────────────────────
const CS = (seq, bc) => '<a href="javascript:currentSetting(\'7043\',\'' + seq + '\',\'' + bc + '\',\'NU\',\'123426\',\'20260915\')">x</a>';
const ROW = (o) => Object.assign({ found: true, orderSeq: '101', code: null, text: '', assignedBarcode: '', rowHtml: '', sKey: '260916125809911' }, o);
const IROW = (bc, linkBc, extra) => ROW(Object.assign({ code: 'I--', text: '입고완료(' + bc + ')', assignedBarcode: linkBc, rowHtml: '<tr><td>고객(상품)재고주문</td><td>' + CS('101', linkBc) + '</td></tr>' }, extra || {}));
test('ccNextStep: OC- 는 done', () => { assert.deepEqual(ccNextStep(ROW({ code: 'OC-' })), { kind: 'done' }); });
test('ccNextStep: O-- 는 del 링크 인자 EXACT 일치 + sKey 있을 때만 cancel', () => {
  assert.deepEqual(ccNextStep(ROW({ code: 'O--', rowHtml: '<tr><td><a href="javascript:del(\'101\');">취소</a></td></tr>' })), { kind: 'write', step: 'cancel', label: '취소 처리', want: 'OC-' });
  assert.deepEqual(ccNextStep(ROW({ code: 'O--', rowHtml: '<tr><td>주문완료</td></tr>' })), { kind: 'fail', reason: '취소 링크 없음(서버 렌더 기준 취소 불가)' });
  assert.deepEqual(ccNextStep(ROW({ code: 'O--', rowHtml: '<a href="javascript:del(\'102\')">x</a>' })), { kind: 'fail', reason: '취소 링크 불일치(102)' });
  assert.deepEqual(ccNextStep(ROW({ code: 'O--', sKey: null, rowHtml: '<a href="javascript:del(\'101\')">x</a>' })), { kind: 'fail', reason: 'sKey 추출 실패' });
});
test('ccNextStep: OS- 는 standby-off(sKey 필수)', () => {
  assert.deepEqual(ccNextStep(ROW({ code: 'OS-', rowHtml: CS('101', '') })), { kind: 'write', step: 'standby-off', label: '본사확인취소', want: 'O--' });
  assert.deepEqual(ccNextStep(ROW({ code: 'OS-', sKey: '' })), { kind: 'fail', reason: 'sKey 추출 실패' });
});
test('ccNextStep: I-- 는 링크 바코드 == 상태 셀 괄호 바코드(독립 출처) 이고 링크 주문번호 == 행 주문번호 일 때만 unassign', () => {
  assert.deepEqual(ccNextStep(IROW('2608ET', '2608ET')), { kind: 'write', step: 'unassign', label: '선택취소(2608ET)', want: 'OS-', barcode: '2608ET' });
  assert.deepEqual(ccNextStep(ROW({ code: 'I--', text: '입고완료(2608ET)', assignedBarcode: '2608ET', rowHtml: '<tr><td>입고완료 (2608ET)</td></tr>' })), { kind: 'fail', reason: '입고완료 — 배정 팝업 링크 없음(발주주문이거나 본사 계정이 아님), 수동' });
  //  Opus 1R P1: assignedBarcode 는 링크에서 오므로 같은 값 — 상태 셀 괄호와 대조해야 독립 검증이다. 프로덕션 입력 그대로(assignedBarcode = 링크 바코드).
  assert.deepEqual(ccNextStep(IROW('2608ET', '2608EU')), { kind: 'fail', reason: '배정 바코드 불일치(링크 2608EU / 상태 2608ET)' });
  assert.deepEqual(ccNextStep(ROW({ code: 'I--', text: '입고완료', assignedBarcode: '2608ET', rowHtml: CS('101', '2608ET') })), { kind: 'fail', reason: '배정 바코드 불일치(링크 2608ET / 상태 없음)' });
  assert.deepEqual(ccNextStep(ROW({ code: 'I--', text: '입고완료', assignedBarcode: '', rowHtml: CS('101', '') })), { kind: 'fail', reason: '배정 바코드 불일치(링크 없음 / 상태 없음)' });
  //  Terra 1R P1: 링크 주문번호가 다르면 절대 보내지 않는다
  assert.deepEqual(ccNextStep(ROW({ code: 'I--', text: '입고완료(2608ET)', assignedBarcode: '2608ET', rowHtml: CS('999', '2608ET') })), { kind: 'fail', reason: '배정 링크 주문번호 불일치(999)' });
  assert.equal(ccNextStep(IROW('2608ET', '2608ET', { sKey: null })).kind, 'write', '선택취소는 sKey 가 없어도 된다(팝업 GET 계약)');
});
test('ccNextStep: T-- 는 재고주문이고 상태 셀 바코드가 있을 때만 deliv-delete (양성 판정 — 발주주문·유형 불명은 첫 쓰기 전에 fail)', () => {
  assert.deepEqual(ccNextStep(ROW({ code: 'T--', text: '출고완료(250HHL)', assignedBarcode: '250HHL', rowHtml: '<tr><td>고객(상품)재고주문</td><td>출고완료 (250HHL)</td></tr>' })), { kind: 'write', step: 'deliv-delete', label: '출고장 삭제(250HHL)', want: 'I--', barcode: '250HHL' });
  assert.deepEqual(ccNextStep(ROW({ code: 'T--', text: '출고완료', assignedBarcode: '', rowHtml: '<tr><td>고객(상품)재고주문</td><td>출고완료</td></tr>' })), { kind: 'fail', reason: '출고 바코드를 읽지 못함' });
  //  Opus 1R P2: 출고완료 발주주문은 출고장만 지워지고 막힌다 → 첫 쓰기 전에 fail. O2 Nit: 모르는 유형·유형 없는 13열 목록도 같은 fail(양성 판정)
  const NOT_JAEGO = { kind: 'fail', reason: '출고완료 — 재고주문이 아님(발주주문 등), 출고장을 지워도 배정 팝업이 없어 수동' };
  assert.deepEqual(ccNextStep(ROW({ code: 'T--', text: '출고완료(2609AY)', assignedBarcode: '2609AY', rowHtml: '<tr><td>고객(메인석)발주주문</td><td>출고완료 (2609AY)</td></tr>' })), NOT_JAEGO);
  assert.deepEqual(ccNextStep(ROW({ code: 'T--', text: '출고완료(250HHL)', assignedBarcode: '250HHL', rowHtml: '<tr><td>고객(상품)</td><td>출고완료 (250HHL)</td></tr>' })), NOT_JAEGO, '13열 매장 목록(유형 접미 없음)');
  assert.deepEqual(ccNextStep(ROW({ code: 'T--', text: '출고완료(250HHL)', assignedBarcode: '250HHL', rowHtml: '' })), NOT_JAEGO);
});
test('ccCellBarcode / ccRowIsJaego', () => {
  assert.equal(ccCellBarcode('입고완료(2608ET)'), '2608ET'); assert.equal(ccCellBarcode('출고완료 (250HHL)'), '250HHL'); assert.equal(ccCellBarcode('본사확인'), '');
  assert.equal(ccCellBarcode('출고확인(매장재고)(2609DH)'), '2609DH'); assert.equal(ccCellBarcode(''), ''); assert.equal(ccCellBarcode(null), '');
  assert.equal(ccRowIsJaego('<td>고객(상품)재고주문</td>'), true); assert.equal(ccRowIsJaego('<td>일반(상품)재고주문</td>'), true);
  assert.equal(ccRowIsJaego('<td>고객(메인석)발주주문</td>'), false); assert.equal(ccRowIsJaego('<td>고객(상품)</td>'), false);
  assert.equal(ccRowIsJaego('<td class="재고주문">x</td>'), false, '태그 안 글자는 세지 않는다'); assert.equal(ccRowIsJaego(null), false);
});
test('ccNextStep: 그 외 상태·미지·found=false 는 fail', () => {
  assert.deepEqual(ccNextStep(ROW({ code: 'TS-', text: '출고확인(2609DH)' })), { kind: 'fail', reason: '상태 부적합: 출고확인(2609DH)' });
  for (const c of ['TE-', 'S--', 'B--', null, 'ZZZ']) assert.equal(ccNextStep(ROW({ code: c })).kind, 'fail', String(c));
  assert.deepEqual(ccNextStep({ found: false }), { kind: 'fail', reason: '재조회 실패(행 없음)' });
  assert.deepEqual(ccNextStep(null), { kind: 'fail', reason: '재조회 실패(행 없음)' });
});
test('ccStepOutcome: 단계별 목표 상태, unassign 은 바코드까지 비어야 success, 나머지는 uncertain', () => {
  const W = (step, want) => ({ kind: 'write', step, want });
  assert.equal(ccStepOutcome(W('cancel', 'OC-'), ROW({ code: 'OC-' })), 'success');
  assert.equal(ccStepOutcome(W('cancel', 'OC-'), ROW({ code: 'O--' })), 'uncertain');
  assert.equal(ccStepOutcome(W('standby-off', 'O--'), ROW({ code: 'O--' })), 'success');
  assert.equal(ccStepOutcome(W('deliv-delete', 'I--'), ROW({ code: 'I--', assignedBarcode: '250HHL' })), 'success');
  assert.equal(ccStepOutcome(W('unassign', 'OS-'), ROW({ code: 'OS-', assignedBarcode: '' })), 'success');
  assert.equal(ccStepOutcome(W('unassign', 'OS-'), ROW({ code: 'OS-', assignedBarcode: '2608ET' })), 'uncertain', '상태만 바뀌고 바코드가 남으면 미확정');
  assert.equal(ccStepOutcome(W('unassign', 'OS-'), ROW({ code: 'OS-', text: '본사확인(2608ET)' })), 'uncertain', '상태 셀 괄호에 바코드가 남아도 미확정');
  assert.equal(ccStepOutcome(W('unassign', 'OS-'), ROW({ code: 'I--' })), 'uncertain');
  assert.equal(ccStepOutcome(W('cancel', 'OC-'), { found: false }), 'uncertain');
  assert.equal(ccStepOutcome(W('cancel', 'OC-'), null), 'uncertain');
  assert.equal(ccStepOutcome(null, ROW({ code: 'OC-' })), 'uncertain');
});
// ── ccRowCurrentSetting ─────────────────────────────────────────────────────
test('ccRowCurrentSetting: 행 HTML 의 currentSetting 6인자 파싱, 없거나 인자 수 다르면 null', () => {
  assert.deepEqual(ccRowCurrentSetting('<tr><td>' + CS('389520', '2608ET') + '</td></tr>'), { master: '7043', orderSeq: '389520', barcode: '2608ET', shop: 'NU', client: '123426', orderDate: '20260915' });
  assert.equal(ccRowCurrentSetting('<tr><td>출고완료 (250HHL)</td></tr>'), null);
  assert.equal(ccRowCurrentSetting('<a href="javascript:currentSetting(\'1\',\'2\')">x</a>'), null);
  assert.equal(ccRowCurrentSetting(''), null); assert.equal(ccRowCurrentSetting(null), null);
});
// ── ccPickDelivIdx (스펙 §1.2·§4.5) ─────────────────────────────────────────
test('ccPickDelivIdx: 2번째=바코드 && 4번째=orderSeq 인 값 정확히 1건만 {idx}', () => {
  const vals = ['426106,250HHL,47295,389513', '426105,250HHL,47290,0', '426054,2609DH,47281,389336'];
  assert.deepEqual(ccPickDelivIdx(vals, '250HHL', '389513'), { idx: '426106,250HHL,47295,389513' });
  assert.deepEqual(ccPickDelivIdx(vals, '250hhl', ' 389513 '), { idx: '426106,250HHL,47295,389513' }, '바코드 대소문자·공백 무시');
  assert.equal(ccPickDelivIdx(vals, '250HHL', '389514'), null, '바코드만 맞고 주문이 다르면 없음');
  assert.deepEqual(ccPickDelivIdx(vals, '250HHL', '0'), { idx: '426105,250HHL,47290,0' }, 'orderSeq 0(주문 없는 출고)도 값으로는 특정된다 — 호출부가 0 을 넘길 일은 없다');
  assert.deepEqual(ccPickDelivIdx(vals.concat(['999,250HHL,1,389513']), '250HHL', '389513'), { ambiguous: 2 });
  assert.equal(ccPickDelivIdx(vals, '', '389513'), null); assert.equal(ccPickDelivIdx(vals, '250HHL', ''), null);
  assert.equal(ccPickDelivIdx(['bad', '1,250HHL', null], '250HHL', '389513'), null, '토큰 4개 미만은 무시');
  assert.equal(ccPickDelivIdx(null, '250HHL', '389513'), null);
});
// ── ccBuildUnassignUrl (스펙 §1.3) ──────────────────────────────────────────
test('ccBuildUnassignUrl: 팝업 cancelForm 과 같은 모양 — tcode·barcode·orderSeq + 검색조건, 고정 키는 덮이지 않음', () => {
  const url = ccBuildUnassignUrl('2608ET', '389520', { reqPage: '1', pageSize: '100', searchSortType: 'seq', barcode: 'HACK', tcode: 'x' });
  assert.ok(url.startsWith('/jun/orderitem/orderItemPopCurrentSettingCancel.do?'));
  const p = new URL('http://x' + url).searchParams;
  assert.equal(p.get('tcode'), 'order_item'); assert.equal(p.get('barcode'), '2608ET'); assert.equal(p.get('orderSeq'), '389520');
  assert.equal(p.get('reqPage'), '1'); assert.equal(p.get('pageSize'), '100'); assert.equal(p.get('searchSortType'), 'seq');
  assert.equal(ccBuildUnassignUrl('', '389520', {}), null); assert.equal(ccBuildUnassignUrl('2608ET', '', {}), null);
  assert.equal(ccBuildUnassignUrl(' 2608ET ', 389520, null), '/jun/orderitem/orderItemPopCurrentSettingCancel.do?tcode=order_item&barcode=2608ET&orderSeq=389520');
});
