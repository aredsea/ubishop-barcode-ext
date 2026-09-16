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
               'ccChainLabel', 'ccRequeryReason'];
const sandbox = {};

// eslint-disable-next-line no-new-func
new Function('exports',
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => 'exports.' + n + ' = ' + n + ';').join('\n')
)(sandbox);

const { ccTargetStatus, ccClassifyChecked, ccBuildCancelUrl, ccRedirectMsg, ccClassifyOutcome, ccChainLabel, ccRequeryReason } = sandbox;

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
    { orderSeq: '4', code: 'T--', orderDate: '20260916', cs: { has: false, barcode: '250HHL' } },
    { orderSeq: '5', code: 'OC-', orderDate: '20260916' }
  ];
  const r = ccClassifyChecked(rows);
  assert.deepEqual(r.targets, [rows[0], rows[1], rows[2], rows[3]]);
  assert.equal(r.targets[2], rows[2], '원본 객체 그대로');
  assert.deepEqual(r.excluded, [{ orderSeq: '5', code: 'OC-', reason: '이미 취소됨' }]);
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
    '입고완료(발주주문) — 배정 팝업이 없어 수동', '입고완료(발주주문) — 배정 팝업이 없어 수동', '입고완료(발주주문) — 배정 팝업이 없어 수동',
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
