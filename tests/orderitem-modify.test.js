/* =============================================================================
 *  orderitem-modify.test.js — 작업B 수정 팝업(slice 1 + slice 2b) 순수 헬퍼 단위테스트.
 *
 *  skin.js 는 content script IIFE 라 require 할 수 없다.
 *  → 소스에서 DOM 비의존 함수 선언만 이름으로 추출해 샌드박스에서 평가한다.
 *
 *  ⚠ 이 파일을 PowerShell 로 편집하지 마라 — Set-Content 가 한글을 깨뜨린다.
 *  스펙: docs/superpowers/specs/2026-07-20-orderitem-batch-design.md §4.1·§10
 *  실행: node --test tests/orderitem-modify.test.js
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

const NAMES = ['parseModifyArgs', 'classifyModifySave', 'decideRowUpdateMode',
               'epClassifyUrl', 'epNormalizeOrderDate', 'epOrderDateColIndex',
               'epFieldsMatch', 'epMembershipChanged', 'epSortMembershipChanged'];
const sandbox = {};

// eslint-disable-next-line no-new-func
new Function('exports',
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => 'exports.' + n + ' = ' + n + ';').join('\n')
)(sandbox);

const { parseModifyArgs, classifyModifySave, decideRowUpdateMode,
        epClassifyUrl, epNormalizeOrderDate, epOrderDateColIndex,
        epFieldsMatch, epMembershipChanged, epSortMembershipChanged } = sandbox;

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

/* ── slice 2b ───────────────────────────────────────────────────────────── */

test('epClassifyUrl: 편집폼·저장·목록을 pathname exact로 가른다', () => {
  assert.equal(epClassifyUrl('http://ubdstore.ubshop.biz/jun/orderitem/orderItemModifyForm.do?x=1'), 'form');
  assert.equal(epClassifyUrl('http://ubdstore.ubshop.biz/jun/orderitem/orderItemModify.do'), 'save');
  assert.equal(epClassifyUrl('http://ubdstore.ubshop.biz/jun/orderitem/orderItemList.do?tcode=order_item'), 'list');
  assert.equal(epClassifyUrl('/jun/orderitem/orderItemModifyForm.do?master=A&orderSeq=1'), 'form');
  assert.equal(epClassifyUrl('/jun/orderitem/orderItemModify.do'), 'save');
  assert.equal(epClassifyUrl('/jun/orderitem/orderItemList.do'), 'list');
});

test('★epClassifyUrl: ModifyForm.do(읽기)와 Modify.do(쓰기)가 절대 섞이지 않는다', () => {
  // 한 글자 차이다. 부분일치로 판정하면 읽기 URL 이 쓰기로, 쓰기 URL 이 읽기로 새어나간다.
  assert.notEqual(epClassifyUrl('/jun/orderitem/orderItemModifyForm.do'), 'save');
  assert.notEqual(epClassifyUrl('/jun/orderitem/orderItemModify.do'), 'form');
  // 쿼리·해시·후행 문자열이 붙어도 pathname 만 본다.
  assert.equal(epClassifyUrl('/jun/orderitem/orderItemModify.do?orderSeq=1#top'), 'save');
  assert.equal(epClassifyUrl('/jun/orderitem/orderItemModifyForm.do#top'), 'form');
});

test('epClassifyUrl: 그 밖의 경로·빈값·이상값은 other다', () => {
  assert.equal(epClassifyUrl('/jun/orderitem/orderItemPopCurrentSettingModify.do'), 'other');
  assert.equal(epClassifyUrl('/jun/orderitem/orderItemStandby.do'), 'other');
  assert.equal(epClassifyUrl('/login.do'), 'other');
  assert.equal(epClassifyUrl('/jun/orderitem/orderItemModifyForm.do/extra'), 'other');
  assert.equal(epClassifyUrl(''), 'other');
  assert.equal(epClassifyUrl(null), 'other');
  assert.equal(epClassifyUrl({}), 'other');
});

test('epNormalizeOrderDate: 구분자만 걷어내고 8자리일 때만 값을 낸다', () => {
  assert.equal(epNormalizeOrderDate('20260724'), '20260724');
  assert.equal(epNormalizeOrderDate('2026.07.24'), '20260724');
  assert.equal(epNormalizeOrderDate('2026-07-24'), '20260724');
  assert.equal(epNormalizeOrderDate(' 2026 / 07 / 24 '), '20260724');
});

test('epNormalizeOrderDate: 8자리가 아니면 전부 fail closed로 빈 값이다', () => {
  assert.equal(epNormalizeOrderDate('2026.07.24 15:30'), '');   // 시각이 붙은 셀
  assert.equal(epNormalizeOrderDate('2026.07'), '');
  assert.equal(epNormalizeOrderDate(''), '');
  assert.equal(epNormalizeOrderDate(null), '');
  assert.equal(epNormalizeOrderDate(undefined), '');
  assert.equal(epNormalizeOrderDate('주문일'), '');
});

test('epOrderDateColIndex: 공백 제거 후 exact 일치하는 열을 찾는다', () => {
  assert.equal(epOrderDateColIndex(['No', '주문일', '매장', '상태']), 1);
  assert.equal(epOrderDateColIndex(['No', ' 주문 일 ', '상태']), 1);
  assert.equal(epOrderDateColIndex(['주문일']), 0);
});

test('epOrderDateColIndex: 없거나 중복이면 fail closed로 -1이다', () => {
  assert.equal(epOrderDateColIndex(['No', '주문일자', '상태']), -1);   // 부분일치 금지
  assert.equal(epOrderDateColIndex(['No', '인도예정일', '상태']), -1);
  assert.equal(epOrderDateColIndex(['주문일', '주문일']), -1);          // 어느 열인지 확정 불가
  assert.equal(epOrderDateColIndex([]), -1);
  assert.equal(epOrderDateColIndex(null), -1);
  assert.equal(epOrderDateColIndex('주문일'), -1);
});

test('epFieldsMatch: 같은 값이면 true, 서버 trim·개행 정규화는 흡수한다', () => {
  assert.equal(epFieldsMatch({ shopRemark: '급함', orderQty: '1' },
                             { shopRemark: '급함', orderQty: '1' }), true);
  assert.equal(epFieldsMatch({ remark: '한 줄\r\n두 줄' }, { remark: '한 줄\n두 줄' }), true);
  assert.equal(epFieldsMatch({ remark: '  값  ' }, { remark: '값' }), true);
  assert.equal(epFieldsMatch({ remark: '' }, { remark: '' }), true);
});

test('epFieldsMatch: 값이 다르면 false다', () => {
  assert.equal(epFieldsMatch({ shopRemark: '급함' }, { shopRemark: '보통' }), false);
  assert.equal(epFieldsMatch({ orderQty: '1' }, { orderQty: '2' }), false);
  assert.equal(epFieldsMatch({ remark: '값' }, { remark: '' }), false);
});

test('epFieldsMatch: 못 읽었거나 스냅샷이 비면 fail closed로 false다', () => {
  assert.equal(epFieldsMatch(null, { remark: '값' }), false);
  assert.equal(epFieldsMatch({ remark: '값' }, null), false);
  assert.equal(epFieldsMatch({}, {}), false);                       // 스냅샷 없음 = 검증 안 됨
  assert.equal(epFieldsMatch({ remark: '값' }, {}), false);          // 서버 응답에 그 필드 없음
  assert.equal(epFieldsMatch({ remark: null }, { remark: null }), false);
});

test('epMembershipChanged: 걸린 조건이 없으면 그 행은 목록에 남는다', () => {
  const sv = { searchK: '', searchColor: '', searchItemSize: '' };
  assert.equal(epMembershipChanged(sv, { k: '18K', color: 'W', itemSize: '11' }), false);
});

test('epMembershipChanged: 조건과 제출값이 같으면 false다', () => {
  const sv = { searchK: '14K', searchColor: '', searchItemSize: '' };
  assert.equal(epMembershipChanged(sv, { k: '14K', color: 'W', itemSize: '11' }), false);
  assert.equal(epMembershipChanged({ searchK: ' 14K ' }, { k: '14K' }), false);
});

test('epMembershipChanged: 조건에서 벗어나는 값으로 바꾸면 true다(목록 reload)', () => {
  assert.equal(epMembershipChanged({ searchK: '14K' }, { k: '18K' }), true);
  assert.equal(epMembershipChanged({ searchColor: 'W' }, { color: 'Y' }), true);
  assert.equal(epMembershipChanged({ searchItemSize: '11' }, { itemSize: '12' }), true);
});

test('epMembershipChanged: 비교할 수 없으면 fail closed로 true다', () => {
  assert.equal(epMembershipChanged(null, { k: '14K' }), true);
  assert.equal(epMembershipChanged({ searchK: '14K' }, null), true);
  assert.equal(epMembershipChanged({ searchK: '14K' }, { color: 'W' }), true);   // k 를 못 읽음
});

test('epSortMembershipChanged: seq 정렬일 때만 제자리 교체가 성립한다', () => {
  assert.equal(epSortMembershipChanged('seq'), false);
  assert.equal(epSortMembershipChanged(' seq '), false);
  assert.equal(epSortMembershipChanged(''), true);
  assert.equal(epSortMembershipChanged('barcode'), true);
  assert.equal(epSortMembershipChanged(null), true);
  assert.equal(epSortMembershipChanged(undefined), true);
});

/* ── 배선 회귀(소스 구조 고정) ──────────────────────────────────────────── */

test('★slice 2b 판정은 기존 3분기 헬퍼를 호출한다(로직 재구현 금지)', () => {
  const start = SRC.indexOf('async function epVerifyAndApply(');
  assert.ok(start >= 0, 'epVerifyAndApply 가 없다');
  const fn = extractFn(SRC, 'epVerifyAndApply');
  assert.ok(/classifyModifySave\(/.test(fn), '성공 판정이 classifyModifySave 를 안 쓴다');
  assert.ok(/decideRowUpdateMode\(/.test(fn), '행 갱신 모드가 decideRowUpdateMode 를 안 쓴다');
  assert.ok(/fetchOrderRow\(/.test(fn), '재조회가 fetchOrderRow 를 안 쓴다');
  assert.ok(!/resyncRow\(/.test(fn), 'resyncRow 는 상태 셀만 갈아서 여기 쓰면 안 된다');
});

test('★행 갱신은 <tr> 통째 교체다 — resyncRow 를 쓰지 않는다', () => {
  const fn = extractFn(SRC, 'epReplaceRow');
  assert.ok(/replaceWith\(/.test(fn), 'tr 통째 교체가 아니다');
  assert.ok(!/innerHTML/.test(fn), '셀 innerHTML 이식은 낡은 값을 남긴다');
  // 교체 후 확장 장식 재적용(§10 첫 항목)
  assert.ok(/bindFactoryNames\(\)/.test(fn), '교체 후 장식 재적용이 없다');
});

test('★목록 새로고침은 form1 재제출로 명시돼 있다(location.reload 아님)', () => {
  const fn = extractFn(SRC, 'epReloadList');
  assert.ok(/forms\['form1'\]/.test(fn), '검색폼(form1)을 쓰지 않는다');
  assert.ok(/\.submit\(\)/.test(fn), '폼 재제출이 아니다');
  assert.ok(!/location\.reload/.test(fn), 'POST 검색 화면에서 reload 는 재전송·조건유실을 부른다');
});

test('★slice 2b 는 어떤 쓰기도 하지 않는다(읽기 GET/조회만)', () => {
  const names = ['epVerifyAndApply', 'epFetchFormValues', 'epOnFrameLoad', 'epWatchForm'];
  const blob = names.map(n => extractFn(SRC, n)).join('\n');
  for (const bad of ['setCurrent', 'standby(', 'requestSubmit', 'window.open',
                     'location.assign', 'location.replace', 'orderItemModify.do?']) {
    assert.ok(!blob.includes(bad), 'slice 2b 에 쓰기 경로: ' + bad);
  }
  // 편집폼 재조회는 쓰기 URL 차단 가드를 통과해야 한다.
  assert.ok(/AUTO_WRITE_MARKERS/.test(extractFn(SRC, 'epFetchFormValues')),
    '재조회에 쓰기 URL 런타임 차단이 없다');
  assert.ok(/method: 'GET'/.test(extractFn(SRC, 'epFetchFormValues')), '편집폼 재조회가 GET 이 아니다');
});

test('★제출 스냅샷은 제출 시점에만 찍는다(편집 전 값이면 거짓 성공이 난다)', () => {
  const fn = extractFn(SRC, 'epWatchForm');
  assert.ok(/'submit'/.test(fn), 'submit 이벤트 감시가 없다');
  assert.ok(/beforeunload/.test(fn), 'form.submit() 경로(beforeunload) 감시가 없다');
  // 장착 직후 snap() 을 부르면 편집 '전' 값이 스냅샷이 되어, 저장 실패(서버가 그대로)가 값
  //  일치로 보인다 = 거짓 성공. 그래서 snap 호출은 제출 이벤트 안 한 곳뿐이어야 한다
  //  (beforeunload 에는 호출이 아니라 참조로 넘긴다).
  assert.equal((fn.match(/snap\(\)/g) || []).length, 1,
    'snap() 호출이 제출 시점 한 곳이 아니다 — 편집 전 값 스냅샷은 거짓 성공 경로다');
});

test('게이트는 기본 OFF 이고 리스너는 게이트와 무관하게 bind 된다(§5)', () => {
  assert.ok(/ubEditPopup:\s*false/.test(SRC), 'ubEditPopup 기본값이 OFF 가 아니다');
  const fn = extractFn(SRC, 'bindEditPopupIntercept');
  assert.ok(/dataset\.ubEpBound/.test(fn), 'idempotent bind 가드가 없다');
  assert.ok(/state\.ubSkin && state\.ubEditPopup/.test(fn), '클릭 시점 게이트 검사가 없다');
});
