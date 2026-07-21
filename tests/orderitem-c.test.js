/* =============================================================================
 *  orderitem-c.test.js — 작업C 본사확인→입고완료(slice 1) 순수 헬퍼 단위테스트.
 *
 *  skin.js 는 content script IIFE 라 require 할 수 없다.
 *  → 소스에서 DOM 비의존 함수 선언만 이름으로 추출해 샌드박스에서 평가한다
 *    (orderitem-modify.test.js 와 동일 방식. 리네임하면 추출 실패로 즉사한다).
 *
 *  ⚠ 이 파일을 PowerShell 로 편집하지 마라 — Set-Content 가 한글을 깨뜨린다.
 *  스펙: docs/superpowers/specs/2026-07-20-orderitem-batch-design.md §3.6·§4.3·§5
 *  실행: node --test tests/orderitem-c.test.js
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

const NAMES = ['cTargetStatus', 'cClassifyChecked', 'cNextStep', 'cPickAssignBarcode', 'cClassifyOutcome'];
const sandbox = {};

// eslint-disable-next-line no-new-func
new Function('exports',
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => 'exports.' + n + ' = ' + n + ';').join('\n')
)(sandbox);

const { cTargetStatus, cClassifyChecked, cNextStep, cPickAssignBarcode, cClassifyOutcome } = sandbox;

/* ── cTargetStatus ──────────────────────────────────────────────────────── */
test('cTargetStatus: O-- 와 OS- 만 true', () => {
  assert.equal(cTargetStatus('O--'), true);
  assert.equal(cTargetStatus('OS-'), true);
});

test('cTargetStatus: 그 외·미지·빈값·null 은 전부 false (fail-closed, exact match)', () => {
  for (const c of ['I--', 'OC-', 'T--', 'TS-', 'TE-', 'S--', 'B--', '', 'O', 'OS', 'o--', 'O-- ', 'XXX']) {
    assert.equal(cTargetStatus(c), false, JSON.stringify(c) + ' 가 true 로 새면 안 된다');
  }
  assert.equal(cTargetStatus(null), false);
  assert.equal(cTargetStatus(undefined), false);
});

/* ── cClassifyChecked ───────────────────────────────────────────────────── */
test('cClassifyChecked: 대상/제외를 사유와 함께 가른다', () => {
  const rows = [
    { orderSeq: '1', code: 'O--' },
    { orderSeq: '2', code: 'OS-' },
    { orderSeq: '3', code: 'I--' },
    { orderSeq: '4', code: 'OC-' },
    { orderSeq: '5', code: 'B--' },
    { orderSeq: '6', code: '???' }
  ];
  const r = cClassifyChecked(rows);
  assert.equal(r.duplicate, false);
  assert.deepEqual(r.targets, [{ orderSeq: '1', code: 'O--' }, { orderSeq: '2', code: 'OS-' }]);
  assert.deepEqual(r.excluded, [
    { orderSeq: '3', code: 'I--', reason: '이미 입고완료' },
    { orderSeq: '4', code: 'OC-', reason: '주문취소' },
    { orderSeq: '5', code: 'B--', reason: '발주완료' },
    { orderSeq: '6', code: '???', reason: '상태 불명' }
  ]);
});

test('cClassifyChecked: 모든 제외 사유 매핑', () => {
  const rows = [
    { orderSeq: 'a', code: 'I--' }, { orderSeq: 'b', code: 'OC-' },
    { orderSeq: 'c', code: 'T--' }, { orderSeq: 'd', code: 'TS-' },
    { orderSeq: 'e', code: 'TE-' }, { orderSeq: 'f', code: 'S--' },
    { orderSeq: 'g', code: 'B--' }, { orderSeq: 'h', code: 'ZZZ' }
  ];
  const reasons = cClassifyChecked(rows).excluded.map(x => x.reason);
  assert.deepEqual(reasons, ['이미 입고완료', '주문취소', '출고완료', '출고확인',
                             '출고오확인', '판매완료', '발주완료', '상태 불명']);
});

test('cClassifyChecked: 같은 orderSeq 가 두 번이면 duplicate:true (dedupe 안 함)', () => {
  const rows = [
    { orderSeq: '10', code: 'O--' },
    { orderSeq: '11', code: 'OS-' },
    { orderSeq: '10', code: 'O--' }
  ];
  const r = cClassifyChecked(rows);
  assert.equal(r.duplicate, true);
  assert.equal(r.targets.length, 3, 'dedupe 하지 말 것 — 중복이어도 조용히 지우지 않는다');
});

test('cClassifyChecked: 중복이 제외 행에서 나도 duplicate:true', () => {
  const r = cClassifyChecked([
    { orderSeq: '9', code: 'I--' }, { orderSeq: '9', code: 'OC-' }
  ]);
  assert.equal(r.duplicate, true);
});

test('cClassifyChecked: 빈 입력·비배열은 빈 분할(쓰기 대상 0 → 안전)', () => {
  assert.deepEqual(cClassifyChecked([]), { targets: [], excluded: [], duplicate: false });
  assert.deepEqual(cClassifyChecked(null), { targets: [], excluded: [], duplicate: false });
  assert.deepEqual(cClassifyChecked(undefined), { targets: [], excluded: [], duplicate: false });
});

/* ── cNextStep ──────────────────────────────────────────────────────────── */
test('cNextStep: O--→standby, OS-→assign, 그 외·미지→abort (fail-closed)', () => {
  assert.equal(cNextStep('O--'), 'standby');
  assert.equal(cNextStep('OS-'), 'assign');
  for (const c of ['I--', 'OC-', 'T--', 'TS-', 'TE-', 'S--', 'B--', '', 'o--', 'ZZZ']) {
    assert.equal(cNextStep(c), 'abort', JSON.stringify(c) + ' 는 abort 여야 한다');
  }
  assert.equal(cNextStep(null), 'abort');
  assert.equal(cNextStep(undefined), 'abort');
});

/* ── cPickAssignBarcode ─────────────────────────────────────────────────── */
test('cPickAssignBarcode: 첫 후보의 바코드', () => {
  assert.equal(cPickAssignBarcode([{ barcode: '2604O7' }, { barcode: '2604O9' }]), '2604O7');
  assert.equal(cPickAssignBarcode([{ barcode: 'ABC', extra: 1 }]), 'ABC');
});

test('cPickAssignBarcode: 후보 0건이면 null (§4.3 step 3)', () => {
  assert.equal(cPickAssignBarcode([]), null);
  assert.equal(cPickAssignBarcode(null), null);
  assert.equal(cPickAssignBarcode(undefined), null);
});

test('cPickAssignBarcode: 첫 후보 바코드가 없거나 빈값이면 null (빈 값이 쓰기로 안 흘러가게)', () => {
  assert.equal(cPickAssignBarcode([{}]), null);
  assert.equal(cPickAssignBarcode([{ barcode: '' }]), null);
  assert.equal(cPickAssignBarcode([null]), null);
  assert.equal(cPickAssignBarcode([{ barcode: 123 }]), null);
});

/* ── cClassifyOutcome ───────────────────────────────────────────────────── */
test('cClassifyOutcome: dispatch 전(dispatched!==true)은 확정 실패 fail', () => {
  assert.equal(cClassifyOutcome({ dispatched: false, requery: null, expectedBarcode: 'B1' }), 'fail');
  assert.equal(cClassifyOutcome({ dispatched: undefined, requery: null, expectedBarcode: 'B1' }), 'fail');
  assert.equal(cClassifyOutcome(null), 'fail');
  assert.equal(cClassifyOutcome({}), 'fail');
});

test('cClassifyOutcome: dispatch 후 I-- 이고 바코드 일치일 때만 success', () => {
  assert.equal(cClassifyOutcome({
    dispatched: true, expectedBarcode: '2604O7',
    requery: { found: true, code: 'I--', assignedBarcode: '2604O7' }
  }), 'success');
});

test('cClassifyOutcome: dispatch 후 이전 상태로 보이면 uncertain (재시도 금지)', () => {
  const out = cClassifyOutcome({
    dispatched: true, expectedBarcode: '2604O7',
    requery: { found: true, code: 'OS-', assignedBarcode: '' }
  });
  assert.equal(out, 'uncertain');
  assert.notEqual(out, 'fail');
});

test('cClassifyOutcome: dispatch 후 다른 바코드면 uncertain', () => {
  assert.equal(cClassifyOutcome({
    dispatched: true, expectedBarcode: '2604O7',
    requery: { found: true, code: 'I--', assignedBarcode: '2604O9' }
  }), 'uncertain');
});

test('cClassifyOutcome: dispatch 후 다른 상태면 uncertain', () => {
  assert.equal(cClassifyOutcome({
    dispatched: true, expectedBarcode: '2604O7',
    requery: { found: true, code: 'S--', assignedBarcode: '2604O7' }
  }), 'uncertain');
});

test('cClassifyOutcome: dispatch 후 재조회 null/not-found/timeout 은 uncertain', () => {
  assert.equal(cClassifyOutcome({ dispatched: true, expectedBarcode: 'B1', requery: null }), 'uncertain');
  assert.equal(cClassifyOutcome({
    dispatched: true, expectedBarcode: 'B1',
    requery: { found: false, code: null, assignedBarcode: null }
  }), 'uncertain');
});

test('cClassifyOutcome: dispatch 후 non-success 는 전부 uncertain 이고 절대 fail/재시도 아님', () => {
  const post = [
    { dispatched: true, expectedBarcode: 'B1', requery: { found: true, code: 'OS-', assignedBarcode: '' } },
    { dispatched: true, expectedBarcode: 'B1', requery: { found: true, code: 'I--', assignedBarcode: 'B2' } },
    { dispatched: true, expectedBarcode: 'B1', requery: { found: true, code: 'T--', assignedBarcode: 'B1' } },
    { dispatched: true, expectedBarcode: 'B1', requery: { found: false, code: null, assignedBarcode: null } },
    { dispatched: true, expectedBarcode: 'B1', requery: null }
  ];
  for (const input of post) {
    const v = cClassifyOutcome(input);
    assert.equal(v, 'uncertain', JSON.stringify(input));
    assert.notEqual(v, 'fail', 'dispatch 후에는 절대 fail(=안전한 재실행 암시) 이 아니다');
  }
});
