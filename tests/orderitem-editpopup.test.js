/* =============================================================================
 *  orderitem-editpopup.test.js — 작업B 수정 팝업(별도 브라우저 창) 순수 헬퍼 단위테스트.
 *
 *  skin.js 는 content script IIFE 라 require 할 수 없다.
 *  → 소스에서 DOM 비의존 선언만 이름으로 추출해 샌드박스에서 **실제로 실행**한다
 *    (orderitem-c2a.test.js 와 동일 방식. 리네임하면 추출 실패로 즉사한다).
 *
 *  ⚠ 소스에 토큰이 있는지만 보는 검사는 쓰지 않는다 — 조합 버그를 못 잡는다.
 *  ⚠ 이 파일을 PowerShell 로 편집하지 마라 — Set-Content 가 한글을 깨뜨린다.
 *  실행: node --test tests/orderitem-editpopup.test.js
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

//  상수도 소스에서 뽑는다 — 테스트가 자기 사본을 들고 있으면 경로가 바뀌어도 안 깨져
//  '수정폼 판정'이 조용히 어긋난다.
function extractConst(src, name) {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*(.+?);').exec(src);
  assert.ok(m, 'skin.js 에서 상수 ' + name + ' 를 찾지 못했습니다');
  return 'const ' + name + ' = ' + m[1] + ';';
}

const NAMES = ['parseModifyArgs', 'epModifyRowMatches', 'epPopupAction'];
const sandbox = {};

// eslint-disable-next-line no-new-func
new Function('exports',
  extractConst(SRC, 'EP_FORM_PATH') + '\n' +
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => 'exports.' + n + ' = ' + n + ';').join('\n') + '\n' +
  'exports.EP_FORM_PATH = EP_FORM_PATH;'
)(sandbox);

const { parseModifyArgs, epModifyRowMatches, epPopupAction, EP_FORM_PATH } = sandbox;

/* ── parseModifyArgs — 목록의 [수정] 앵커 인자 파싱 ──────────────────────── */

test('modify() 인자를 파싱한다 — 홑따옴표·쌍따옴표·javascript: 접두·세미콜론', () => {
  // 실측된 형태(2026-07-27 라이브 DevTools): javascript:modify('387897','140540...')
  assert.deepEqual(parseModifyArgs("javascript:modify('387897','1405401')"), { master: '387897', seq: '1405401' });
  assert.deepEqual(parseModifyArgs("modify('a','b')"), { master: 'a', seq: 'b' });
  assert.deepEqual(parseModifyArgs('javascript:modify("a","b");'), { master: 'a', seq: 'b' });
  assert.deepEqual(parseModifyArgs("  javascript : modify( 'a' , 'b' ) ; "), { master: 'a', seq: 'b' });
});

test('modify() 가 아니거나 형식이 어긋나면 null — 가로채지 않고 네이티브로 흘린다', () => {
  assert.equal(parseModifyArgs("javascript:del('387897')"), null);      // 취소 링크
  assert.equal(parseModifyArgs("javascript:modify('a')"), null);        // 인자 1개
  assert.equal(parseModifyArgs("javascript:modify('a','b','c')"), null); // 인자 3개
  assert.equal(parseModifyArgs("modifyOther('a','b')"), null);          // 다른 함수
  assert.equal(parseModifyArgs(''), null);
  assert.equal(parseModifyArgs(null), null);
  assert.equal(parseModifyArgs(undefined), null);
});

/* ── epModifyRowMatches — 행 일치 fail-closed ─────────────────────────────── */

test('행 idx 와 modify() 인자가 둘 다 있고 같을 때만 가로챈다', () => {
  assert.equal(epModifyRowMatches('1405401', '1405401'), true);
  assert.equal(epModifyRowMatches(' 1405401 ', '1405401'), true);   // 공백은 정규화
  assert.equal(epModifyRowMatches(1405401, '1405401'), true);       // 숫자 입력도 허용
});

test('행 키가 없거나 다르면 fail-closed — 다른 주문을 열 수 있는 경로를 막는다', () => {
  assert.equal(epModifyRowMatches('1405401', '9999999'), false);   // 불일치
  assert.equal(epModifyRowMatches('', '1405401'), false);          // 행에 idx 없음
  assert.equal(epModifyRowMatches('1405401', ''), false);          // 인자 없음
  assert.equal(epModifyRowMatches(null, null), false);
  assert.equal(epModifyRowMatches(undefined, undefined), false);
  assert.equal(epModifyRowMatches('  ', '1405401'), false);        // 공백뿐
});

/* ── epPopupAction — 팝업 창이 지금 어디냐 ────────────────────────────────── */

test('수정폼 경로면 화면을 정리한다(dress)', () => {
  assert.equal(EP_FORM_PATH, '/jun/orderitem/orderItemModifyForm.do');   // ⚠ Form 접미사 = 읽기
  assert.equal(epPopupAction(EP_FORM_PATH), 'dress');
});

test('수정폼이 아니면 폼을 떠난 것으로 보고 목록 갱신·창 닫기(done)', () => {
  assert.equal(epPopupAction('/jun/orderitem/orderItemModify.do'), 'done');   // 저장 엔드포인트
  assert.equal(epPopupAction('/jun/orderitem/orderItemList.do'), 'done');     // 목록으로 리다이렉트
  assert.equal(epPopupAction('/mall/login.ubs'), 'done');                     // 로그인(호출부가 별도 처리)
  assert.equal(epPopupAction('/'), 'done');
  assert.equal(epPopupAction(''), 'done');
  assert.equal(epPopupAction(null), 'done');
});

test('⚠ 저장 엔드포인트(Modify.do)와 읽기 폼(ModifyForm.do)은 한 글자 차이 — 섞이면 안 된다', () => {
  // ModifyForm.do 는 폼을 보여주는 읽기 경로, Modify.do 는 저장(POST) 경로다.
  // 접두 일치로 판정하면 저장 경로까지 'dress' 로 잡혀 창이 안 닫힌다.
  assert.equal(epPopupAction('/jun/orderitem/orderItemModifyForm.do'), 'dress');
  assert.notEqual(epPopupAction('/jun/orderitem/orderItemModify.do'), 'dress');
});
