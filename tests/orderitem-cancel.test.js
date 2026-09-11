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

const NAMES = ['ccTargetStatus', 'ccClassifyChecked', 'ccBuildCancelUrl', 'ccRedirectMsg', 'ccClassifyOutcome'];
const sandbox = {};

// eslint-disable-next-line no-new-func
new Function('exports',
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => 'exports.' + n + ' = ' + n + ';').join('\n')
)(sandbox);

const { ccTargetStatus, ccClassifyChecked, ccBuildCancelUrl, ccRedirectMsg, ccClassifyOutcome } = sandbox;

// ── ccTargetStatus ───────────────────────────────────────────────────────────
test('ccTargetStatus: 정확히 O-- 만 true', () => {
  assert.equal(ccTargetStatus('O--'), true);
});
test('ccTargetStatus: OS-/OC-/B--/I-- 등은 false (본사확인도 취소 대상이 아니다)', () => {
  for (const c of ['OS-', 'OC-', 'B--', 'I--', 'T--', 'TS-', 'TE-', 'S--']) {
    assert.equal(ccTargetStatus(c), false, c);
  }
});
test('ccTargetStatus: null/undefined/빈값/prefix/소문자/공백 전부 false (EXACT)', () => {
  for (const c of [null, undefined, '', 'O', 'O-', 'O---', 'o--', ' O--', 'O-- ', 'OS', 0, {}]) {
    assert.equal(ccTargetStatus(c), false, String(c));
  }
});

// ── ccClassifyChecked ────────────────────────────────────────────────────────
test('ccClassifyChecked: O-- 는 targets(원본 객체 그대로, 순서 보존), 나머지는 excluded', () => {
  const rows = [
    { orderSeq: '1', code: 'O--', orderDate: '20260911' },
    { orderSeq: '2', code: 'OS-', orderDate: '20260911' },
    { orderSeq: '3', code: 'O--', orderDate: '20260910' }
  ];
  const r = ccClassifyChecked(rows);
  assert.deepEqual(r.targets, [rows[0], rows[2]]);
  assert.equal(r.targets[0], rows[0]);
  assert.equal(r.excluded.length, 1);
  assert.equal(r.duplicate, false);
});
test('ccClassifyChecked: 제외 사유 매핑', () => {
  const r = ccClassifyChecked([
    { orderSeq: 'a', code: 'OS-' }, { orderSeq: 'b', code: 'OC-' }, { orderSeq: 'c', code: 'B--' },
    { orderSeq: 'd', code: 'I--' }, { orderSeq: 'e', code: 'T--' }, { orderSeq: 'f', code: 'TS-' },
    { orderSeq: 'g', code: 'TE-' }, { orderSeq: 'h', code: 'S--' }, { orderSeq: 'i', code: null },
    { orderSeq: 'j', code: 'ZZZ' }
  ]);
  const by = Object.fromEntries(r.excluded.map(x => [x.orderSeq, x.reason]));
  assert.equal(by.a, '본사확인 상태 — [본사확인취소] 후 다시');
  assert.equal(by.b, '이미 취소됨');
  assert.equal(by.c, '취소 불가 상태(발주완료)');
  assert.equal(by.d, '취소 불가 상태(입고완료)');
  assert.equal(by.e, '취소 불가 상태(출고완료)');
  assert.equal(by.f, '취소 불가 상태(출고확인)');
  assert.equal(by.g, '취소 불가 상태(출고오확인)');
  assert.equal(by.h, '취소 불가 상태(판매완료)');
  assert.equal(by.i, '상태 불명');
  assert.equal(by.j, '상태 불명');
  assert.equal(r.excluded.find(x => x.orderSeq === 'a').code, 'OS-');
  assert.equal(r.targets.length, 0);
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
