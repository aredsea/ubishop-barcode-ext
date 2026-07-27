/* =============================================================================
 *  orderitem-editpopup.test.js — 작업B 수정 팝업(별도 브라우저 창) 순수 헬퍼 단위테스트.
 *
 *  skin.js 는 content script IIFE 라 require 할 수 없다.
 *  → 소스에서 DOM 비의존 선언만 이름으로 추출해 샌드박스에서 **실제로 실행**한다
 *    (orderitem-c2a.test.js 와 동일 방식. 리네임하면 추출 실패로 즉사한다).
 *
 *  ⚠ 판정 로직은 전부 **실제로 실행**해 검증한다. 다만 아래 두 개(라우터 계약 가드)만은
 *    소스 대조다 — chrome.* 오케스트레이션은 node 로 실행할 수단이 없고, 그 계약이 깨지면
 *    라이브에서 조용히 죽기 때문에(실제로 겪었다) 최소한의 그물로 남겨둔다. 나머지 통합
 *    경로(창 생성·레지스트리·화면 정리)는 스펙 §7 의 브라우저 통합검증 몫이다.
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

const NAMES = ['parseModifyArgs', 'epModifyRowMatches', 'epModifyQuery', 'epPopupAction', 'epSubmitMarkValid'];
const sandbox = {};

// eslint-disable-next-line no-new-func
const CONSTS = ['EP_FORM_PATH', 'EP_SAVE_PATH', 'EP_LIST_PATH'];
new Function('exports',
  CONSTS.map(c => extractConst(SRC, c)).join('\n') + '\n' +
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => 'exports.' + n + ' = ' + n + ';').join('\n') + '\n' +
  CONSTS.map(c => 'exports.' + c + ' = ' + c + ';').join('\n')
)(sandbox);

const { parseModifyArgs, epModifyRowMatches, epModifyQuery, epPopupAction,
        epSubmitMarkValid, EP_FORM_PATH } = sandbox;

/* ── epSubmitMarkValid — 제출 증거가 다른 주문으로 승계되지 않는가 ────────── */

test('★제출 마커는 그 주문의 것일 때만 인정한다 — 창 재사용 승계 차단', () => {
  // 창은 재사용된다(같은 탭을 다른 주문 폼으로 이동). 마커가 boolean 이면 주문 A 의 신호가
  // 주문 B 로 넘어가, B 에서 저장하지 않고 목록에 가도 완료로 오인한다.
  assert.equal(epSubmitMarkValid('387898', '387898'), true);
  assert.equal(epSubmitMarkValid('387898', '387897'), false);   // 다른 주문의 증거
  assert.equal(epSubmitMarkValid(' 387898 ', '387898'), true);  // 공백 정규화
});

test('마커가 없거나 비면 증거로 치지 않는다', () => {
  assert.equal(epSubmitMarkValid(null, '387898'), false);
  assert.equal(epSubmitMarkValid('', '387898'), false);
  assert.equal(epSubmitMarkValid('  ', '387898'), false);
  assert.equal(epSubmitMarkValid('387898', null), false);
  assert.equal(epSubmitMarkValid('387898', ''), false);
  assert.equal(epSubmitMarkValid('1', true), false);            // 옛 boolean 마커는 무효
});

/* ── epModifyQuery — 네이티브 modify() 와 같은 주소를 만드는가 ────────────── */

test('★수정폼 쿼리가 네이티브와 정확히 같다 — tcode·seq·tradeJun 셋뿐', () => {
  // 실측: function modify(seq, jun) → ...ModifyForm.do?tcode=order_item&seq=<seq>&tradeJun=<jun>
  const args = parseModifyArgs("javascript:modify('387898','140546');");
  assert.equal(epModifyQuery(args), 'tcode=order_item&seq=387898&tradeJun=140546');
});

test('★존재하지 않는 파라미터를 지어내지 않는다 (옛 구현이 master·orderSeq 를 보냈다)', () => {
  const q = epModifyQuery({ seq: 'a', jun: 'b' });
  assert.ok(!/master=/.test(q), 'master 는 네이티브에 없는 이름이다');
  assert.ok(!/orderSeq=/.test(q), 'orderSeq 는 네이티브에 없는 이름이다');
  assert.ok(!/searchWord|syear|pageSize|reqPage/.test(q), '검색조건은 네이티브가 안 보낸다');
  assert.equal(q.split('&').length, 3, '파라미터는 정확히 3개');
});

test('빈 인자도 형태를 지키고, 값은 URL 인코딩된다', () => {
  assert.equal(epModifyQuery({}), 'tcode=order_item&seq=&tradeJun=');
  assert.equal(epModifyQuery(null), 'tcode=order_item&seq=&tradeJun=');
  assert.equal(epModifyQuery({ seq: 'a b', jun: 'c&d' }), 'tcode=order_item&seq=a+b&tradeJun=c%26d');
});

/* ── background 라우터 계약 — source:'ub' 누락은 침묵 실패다 ──────────────── */

test("★모든 ubEp 메시지에 source:'ub' 가 있다 — 없으면 라우터가 즉시 반환한다", () => {
  // background.js 첫 줄: if (!msg || msg.source !== 'ub') return;
  // 이걸 빠뜨리면 응답이 없어 'message port closed' 로 실패하고, 폴백이 목록 탭을
  // 이동시켜 마치 기능이 아예 없는 것처럼 보인다(2026-07-27 라이브에서 실제로 겪었다).
  const BG = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
  assert.match(BG, /msg\.source\s*!==\s*'ub'/, '라우터 가드가 사라졌다면 이 테스트를 갱신해야 한다');

  const calls = SRC.match(/chrome\.runtime\.sendMessage\(\s*\{[^}]*\}/g) || [];
  const epCalls = calls.filter(c => /type:\s*'ubEp/.test(c));
  assert.ok(epCalls.length >= 3, 'ubEp 메시지가 3개 이상이어야 한다 (열기·신원조회·완료), 실제 ' + epCalls.length);
  for (const c of epCalls) {
    const type = (/type:\s*'(ubEp\w+)'/.exec(c) || [])[1];
    assert.match(c, /source:\s*'ub'/, type + " 메시지에 source:'ub' 가 없다");
  }
});

test('background 가 세 ubEp 타입을 모두 라우팅한다', () => {
  const BG = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
  for (const t of ['ubEpOpen', 'ubEpWhoAmI', 'ubEpDone']) {
    assert.match(BG, new RegExp("msg\\.type === '" + t + "'"), t + ' 라우팅이 없다');
  }
});

/* ── parseModifyArgs — 목록의 [수정] 앵커 인자 파싱 ──────────────────────── */

test('modify() 인자를 파싱한다 — 첫 인자가 seq(행 키), 둘째가 jun(전표 묶음)', () => {
  // ★2026-07-27 라이브 실측 — 네이티브 원본이 function modify(seq, jun) 이다.
  //  옛 구현은 첫 인자를 master 로 부르고 URL 도 master/orderSeq 로 지어냈다(존재하지 않는 이름).
  assert.deepEqual(parseModifyArgs("javascript:modify('387898','140546');"), { seq: '387898', jun: '140546' });
  assert.deepEqual(parseModifyArgs("modify('a','b')"), { seq: 'a', jun: 'b' });
  assert.deepEqual(parseModifyArgs('javascript:modify("a","b");'), { seq: 'a', jun: 'b' });
  assert.deepEqual(parseModifyArgs("  javascript : modify( 'a' , 'b' ) ; "), { seq: 'a', jun: 'b' });
});

test('★행 키는 첫 인자다 — 실측 6행에서 idx === 첫 인자, idx !== 둘째 인자', () => {
  // 라이브 실측 표본(같은 jun 을 여러 행이 공유한다):
  const rows = [
    { idx: '387898', seq: '387898', jun: '140546' },
    { idx: '387897', seq: '387897', jun: '140546' },
    { idx: '387896', seq: '387896', jun: '140546' },
    { idx: '387894', seq: '387894', jun: '140545' },
  ];
  for (const r of rows) {
    assert.equal(epModifyRowMatches(r.idx, r.seq), true, r.idx + ' 는 첫 인자와 같아야 한다');
    // ⚠ 둘째 인자로 비교하면 전부 불일치 → 가로채기가 통째로 죽는다(이 버그로 기능이 안 됐다).
    assert.equal(epModifyRowMatches(r.idx, r.jun), false, r.idx + ' 는 둘째 인자와 달라야 한다');
  }
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

test('제출 신호 + 아는 저장 착지에서만 닫는다(done)', () => {
  assert.equal(epPopupAction('/jun/orderitem/orderItemModify.do', true), 'done');   // 저장(POST) 경로
  assert.equal(epPopupAction('/jun/orderitem/orderItemList.do', true), 'done');     // 목록 리다이렉트
});

test('★제출 증거가 없으면 아는 경로여도 닫지 않는다 — 인과 없이 완료로 치지 않는다', () => {
  // 사용자가 저장하지 않고 메뉴로 목록에 간 것도 경로만 보면 '저장 완료' 로 오인한다.
  assert.equal(epPopupAction('/jun/orderitem/orderItemList.do', false), 'stay');
  assert.equal(epPopupAction('/jun/orderitem/orderItemModify.do', false), 'stay');
  assert.equal(epPopupAction('/jun/orderitem/orderItemList.do'), 'stay');           // 인자 생략
  assert.equal(epPopupAction('/jun/orderitem/orderItemList.do', 'yes'), 'stay');    // true 만 인정
});

test("★모르는 곳에서는 창을 닫지 않는다(stay) — 저장 안 한 작업·오류 화면을 잃지 않게", () => {
  // '수정폼이 아니면 전부 done' 이면 사용자가 폼에서 다른 데로 이동하거나 서버 오류에
  // 착지했을 때도 창을 닫아버려, 저장 안 한 입력을 잃고 오류 내용을 못 본다.
  for (const submitted of [true, false]) {
    assert.equal(epPopupAction('/jun/orderitem/orderItemPopCurrentSettingModifyForm.do', submitted), 'stay');
    assert.equal(epPopupAction('/board/list.do', submitted), 'stay');
    assert.equal(epPopupAction('/mall/login.ubs', submitted), 'stay');
    assert.equal(epPopupAction('/error.jsp', submitted), 'stay');
    assert.equal(epPopupAction('/', submitted), 'stay');
    assert.equal(epPopupAction('', submitted), 'stay');
    assert.equal(epPopupAction(null, submitted), 'stay');
  }
});

test('수정폼은 제출 신호와 무관하게 항상 dress — 저장 후 폼이 다시 떠도 창을 유지한다', () => {
  assert.equal(epPopupAction(EP_FORM_PATH, false), 'dress');
  assert.equal(epPopupAction(EP_FORM_PATH, true), 'dress');   // 검증 실패로 폼 재표시 = 사용자가 봐야 한다
});

test('⚠ 저장 엔드포인트(Modify.do)와 읽기 폼(ModifyForm.do)은 한 글자 차이 — 섞이면 안 된다', () => {
  // ModifyForm.do 는 폼을 보여주는 읽기 경로, Modify.do 는 저장(POST) 경로다.
  // 접두 일치로 판정하면 저장 경로까지 'dress' 로 잡혀 창이 안 닫힌다.
  assert.equal(epPopupAction('/jun/orderitem/orderItemModifyForm.do', true), 'dress');
  assert.equal(epPopupAction('/jun/orderitem/orderItemModify.do', true), 'done');
});
