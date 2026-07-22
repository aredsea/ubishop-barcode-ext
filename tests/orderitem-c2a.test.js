/* =============================================================================
 *  orderitem-c2a.test.js — 작업C 본사확인→입고완료(slice C-2a) 순수 헬퍼 단위테스트.
 *
 *  skin.js 는 content script IIFE 라 require 할 수 없다.
 *  → 소스에서 DOM 비의존 함수 선언만 이름으로 추출해 샌드박스에서 평가한다
 *    (orderitem-c.test.js 와 동일 방식. 리네임하면 추출 실패로 즉사한다).
 *
 *  ⚠ 이 파일을 PowerShell 로 편집하지 마라 — Set-Content 가 한글을 깨뜨린다.
 *  스펙: docs/superpowers/specs/2026-07-20-orderitem-batch-design.md §4.4·§5
 *  실행: node --test tests/orderitem-c2a.test.js
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

const NAMES = ['cListStatusCode', 'cStatusColIndex', 'cHasMore'];
const sandbox = {};

// eslint-disable-next-line no-new-func
new Function('exports',
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => 'exports.' + n + ' = ' + n + ';').join('\n')
)(sandbox);

const { cListStatusCode, cStatusColIndex, cHasMore } = sandbox;

/* ── cListStatusCode ────────────────────────────────────────────────────── */
test('cListStatusCode: 9개 상태 라벨을 canonical code 로 정확히 매핑', () => {
  assert.equal(cListStatusCode('주문완료'), 'O--');
  assert.equal(cListStatusCode('주문취소'), 'OC-');
  assert.equal(cListStatusCode('본사확인'), 'OS-');
  assert.equal(cListStatusCode('발주완료'), 'B--');
  assert.equal(cListStatusCode('입고완료'), 'I--');
  assert.equal(cListStatusCode('출고완료'), 'T--');
  assert.equal(cListStatusCode('출고확인'), 'TS-');
  assert.equal(cListStatusCode('출고오확인'), 'TE-');
  assert.equal(cListStatusCode('판매완료'), 'S--');
});

test('cListStatusCode: 말미 (바코드) 는 라벨 해석에 영향 없다', () => {
  assert.equal(cListStatusCode('입고완료(2604O7)'), 'I--');
  assert.equal(cListStatusCode('출고확인(240HTI)'), 'TS-');
  assert.equal(cListStatusCode('출고완료(2606WH)'), 'T--');
});

test('cListStatusCode: 내부·주변 공백은 무시(공백 제거 후 판정)', () => {
  assert.equal(cListStatusCode(' 주문완료 '), 'O--');
  assert.equal(cListStatusCode('입 고 완 료'), 'I--');
  assert.equal(cListStatusCode('출고확인 (240HTI)'), 'TS-');
});

test('cListStatusCode: 출고확인 vs 출고오확인 은 exact 라 섞이지 않는다', () => {
  assert.equal(cListStatusCode('출고확인'), 'TS-');
  assert.equal(cListStatusCode('출고오확인'), 'TE-');
});

test('cListStatusCode: 미지 라벨은 null(fail-closed)', () => {
  for (const t of ['배송중', '확인', '완료', '주문', '출고']) {
    assert.equal(cListStatusCode(t), null, JSON.stringify(t) + ' 가 code 로 새면 안 된다');
  }
});

test('cListStatusCode: 알 수 없는 접두/접미는 null(fail-closed, prefix 매칭 아님)', () => {
  assert.equal(cListStatusCode('주문완료X'), null);        // 접미 이물
  assert.equal(cListStatusCode('X주문완료'), null);        // 접두 이물
  assert.equal(cListStatusCode('주문완료(bc)extra'), null); // 괄호 뒤 이물
  assert.equal(cListStatusCode('입고완료(a)(b)'), null);   // 괄호 그룹 2개
  assert.equal(cListStatusCode('주문완료 판매완료'), null); // 라벨 2개(공백 제거 후 '주문완료판매완료')
});

test('cListStatusCode: code 문자열 자체를 넣어도 null(라벨만 받는다)', () => {
  for (const c of ['O--', 'OS-', 'I--', '']) assert.equal(cListStatusCode(c), null);
});

test('cListStatusCode: null·undefined·비문자열은 null', () => {
  assert.equal(cListStatusCode(null), null);
  assert.equal(cListStatusCode(undefined), null);
  assert.equal(cListStatusCode(123), null);
  assert.equal(cListStatusCode({}), null);
});

/* ── cStatusColIndex ────────────────────────────────────────────────────── */
test('cStatusColIndex: 헤더 배열에서 상태 열 인덱스(하드코딩 금지, 헤더로 찾기)', () => {
  assert.equal(cStatusColIndex(['No', '주문일', '바코드', '상태', '금액']), 3);
  assert.equal(cStatusColIndex(['상태']), 0);
  assert.equal(cStatusColIndex(['a', ' 상 태 ', 'b']), 1);   // 공백 제거 후 정확일치
});

test('cStatusColIndex: 정확일치만 — 부분일치(상태코드/주문상태)는 안 잡는다', () => {
  assert.equal(cStatusColIndex(['상태코드']), -1);
  assert.equal(cStatusColIndex(['주문상태']), -1);
  assert.equal(cStatusColIndex(['No', '바코드']), -1);
});

test('cStatusColIndex: 첫 매칭 인덱스를 반환', () => {
  assert.equal(cStatusColIndex(['상태', 'x', '상태']), 0);
});

test('cStatusColIndex: 빈 입력·비배열·null 원소는 안전하게 -1 또는 스킵', () => {
  assert.equal(cStatusColIndex([]), -1);
  assert.equal(cStatusColIndex(null), -1);
  assert.equal(cStatusColIndex(undefined), -1);
  assert.equal(cStatusColIndex([null, undefined, '상태']), 2);
});

/* ── cHasMore ───────────────────────────────────────────────────────────── */
test('cHasMore: total 이 반환 행 수보다 크면 true(pageSize 500 은 전부 아님)', () => {
  assert.equal(cHasMore(600, 500), true);
  assert.equal(cHasMore(36, 35), true);
});

test('cHasMore: total 이 반환 행 수 이하이면 false(전부 받음)', () => {
  assert.equal(cHasMore(35, 35), false);
  assert.equal(cHasMore(500, 500), false);
  assert.equal(cHasMore(10, 20), false);
  assert.equal(cHasMore(0, 0), false);
});

test('cHasMore: 수치로 못 읽으면 true(fail-closed — 완전성 미보장)', () => {
  assert.equal(cHasMore(NaN, 35), true);
  assert.equal(cHasMore(undefined, 35), true);
  assert.equal(cHasMore(null, 35), true);
  assert.equal(cHasMore('없음', 35), true);
  assert.equal(cHasMore(35, NaN), true);
});

test('cHasMore: 숫자 문자열도 수치로 비교', () => {
  assert.equal(cHasMore('600', '500'), true);
  assert.equal(cHasMore('35', '35'), false);
});
