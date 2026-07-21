/* =============================================================================
 *  orderitem-modify.test.js — 작업B 수정 팝업(slice 1) 순수 헬퍼 단위테스트.
 *
 *  skin.js 는 content script IIFE 라 require 할 수 없다.
 *  → 소스에서 DOM 비의존 함수 선언만 이름으로 추출해 샌드박스에서 평가한다.
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

const NAMES = ['parseModifyArgs', 'classifyModifySave', 'decideRowUpdateMode'];
const sandbox = {};

// eslint-disable-next-line no-new-func
new Function('exports',
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => 'exports.' + n + ' = ' + n + ';').join('\n')
)(sandbox);

const { parseModifyArgs, classifyModifySave, decideRowUpdateMode } = sandbox;

test('parseModifyArgs: single quote modify href를 파싱한다', () => {
  assert.deepEqual(parseModifyArgs("javascript:modify('D250101','12345')"), {
    master: 'D250101', seq: '12345'
  });
});

test('parseModifyArgs: double quote와 내부 공백을 허용한다', () => {
  assert.deepEqual(parseModifyArgs('  javascript: modify(  "D250101" , "12345"  ); '), {
    master: 'D250101', seq: '12345'
  });
});

test('parseModifyArgs: modify shape가 아니면 null이다', () => {
  assert.equal(parseModifyArgs("javascript:currentSetting('D250101','12345')"), null);
  assert.equal(parseModifyArgs(''), null);
  assert.equal(parseModifyArgs(null), null);
});

test('parseModifyArgs: malformed input에서 예외 없이 null이다', () => {
  assert.doesNotThrow(() => parseModifyArgs("javascript:modify('D250101')"));
  assert.equal(parseModifyArgs("javascript:modify('D250101')"), null);
  assert.equal(parseModifyArgs("javascript:modify('D250101','12345'"), null);
  assert.equal(parseModifyArgs({ href: "modify('D250101','12345')" }), null);
});

test('classifyModifySave: dispatch 전 사전검증 실패는 fail이다', () => {
  assert.equal(classifyModifySave({
    dispatched: false, landedPathAllowed: false, isLoginOrError: true, requery: null
  }), 'fail');
});

test('classifyModifySave: dispatch 후 기대값 재조회 성공은 success다', () => {
  assert.equal(classifyModifySave({
    dispatched: true, landedPathAllowed: true, isLoginOrError: false,
    requery: { found: true, orderSeq: '12345', state: 'I--', matchesExpected: true }
  }), 'success');
});

test('classifyModifySave: dispatch 후 이전 상태 관측은 uncertain이다', () => {
  assert.equal(classifyModifySave({
    dispatched: true, landedPathAllowed: true, isLoginOrError: false,
    requery: { found: true, orderSeq: '12345', state: 'O--', matchesExpected: false }
  }), 'uncertain');
});

test('classifyModifySave: dispatch 후 다른 상태나 값의 mismatch는 uncertain이다', () => {
  assert.equal(classifyModifySave({
    dispatched: true, landedPathAllowed: true, isLoginOrError: false,
    requery: { found: true, orderSeq: '12345', state: 'OS-', matchesExpected: false }
  }), 'uncertain');
});

test('classifyModifySave: dispatch 후 재조회 실패나 timeout은 uncertain이다', () => {
  assert.equal(classifyModifySave({
    dispatched: true, landedPathAllowed: true, isLoginOrError: false, requery: null
  }), 'uncertain');
  assert.equal(classifyModifySave({
    dispatched: true, landedPathAllowed: true, isLoginOrError: false,
    requery: { found: false, orderSeq: '12345', state: null, matchesExpected: false }
  }), 'uncertain');
});

test('classifyModifySave: dispatch 후 경로·로그인·검증 오류는 모두 uncertain이다', () => {
  const base = {
    dispatched: true, landedPathAllowed: true, isLoginOrError: false,
    requery: { found: true, orderSeq: '12345', state: 'I--', matchesExpected: true }
  };
  assert.equal(classifyModifySave(Object.assign({}, base, { landedPathAllowed: false })), 'uncertain');
  assert.equal(classifyModifySave(Object.assign({}, base, { isLoginOrError: true })), 'uncertain');
});

test('classifyModifySave: dispatch 후 non-success는 fail이 아니다', () => {
  const cases = [
    { dispatched: true, landedPathAllowed: false, isLoginOrError: false, requery: null },
    { dispatched: true, landedPathAllowed: true, isLoginOrError: true, requery: null },
    { dispatched: true, landedPathAllowed: true, isLoginOrError: false,
      requery: { found: true, orderSeq: '12345', state: 'O--', matchesExpected: false } },
    { dispatched: true, landedPathAllowed: true, isLoginOrError: false, requery: null }
  ];
  for (const input of cases) {
    assert.equal(classifyModifySave(input), 'uncertain');
    assert.notEqual(classifyModifySave(input), 'fail');
  }
});

test('decideRowUpdateMode: membership와 주문일이 유지되면 in-place다', () => {
  assert.equal(decideRowUpdateMode({
    orderDateChanged: false, filterMembershipChanged: false, sortMembershipChanged: false
  }), 'in-place');
});

test('decideRowUpdateMode: 주문일이 바뀌면 list-reload다', () => {
  assert.equal(decideRowUpdateMode({
    orderDateChanged: true, filterMembershipChanged: false, sortMembershipChanged: false
  }), 'list-reload');
});

test('decideRowUpdateMode: filter membership가 바뀌면 list-reload다', () => {
  assert.equal(decideRowUpdateMode({
    orderDateChanged: false, filterMembershipChanged: true, sortMembershipChanged: false
  }), 'list-reload');
});

test('decideRowUpdateMode: sort membership가 바뀌면 list-reload다', () => {
  assert.equal(decideRowUpdateMode({
    orderDateChanged: false, filterMembershipChanged: false, sortMembershipChanged: true
  }), 'list-reload');
});

test('decideRowUpdateMode: 신호가 불완전하면 fail closed로 list-reload다', () => {
  assert.equal(decideRowUpdateMode(null), 'list-reload');
  assert.equal(decideRowUpdateMode({}), 'list-reload');
});
