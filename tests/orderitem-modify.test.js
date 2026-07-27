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

const NAMES = ['parseModifyArgs', 'epModifyRowMatches', 'classifyModifySave', 'decideRowUpdateMode',
               'epClassifyUrl', 'epDecideLoadAction', 'epNormalizeOrderDate', 'epOrderDateColIndex',
               'epFieldsMatch', 'epValuesDirtyState', 'epSaveValueEvidence', 'epVerifiedRowDisposition',
               'epReplacementRowMatches', 'epReplacementTargetAction',
               'epMembershipChanged', 'epSortMembershipChanged'];
const sandbox = {};

// eslint-disable-next-line no-new-func
new Function('exports',
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => 'exports.' + n + ' = ' + n + ';').join('\n')
)(sandbox);

const { parseModifyArgs, epModifyRowMatches, classifyModifySave, decideRowUpdateMode,
        epClassifyUrl, epDecideLoadAction, epNormalizeOrderDate, epOrderDateColIndex,
        epFieldsMatch, epValuesDirtyState, epSaveValueEvidence, epVerifiedRowDisposition,
        epReplacementRowMatches, epReplacementTargetAction,
        epMembershipChanged, epSortMembershipChanged } = sandbox;

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

test('epModifyRowMatches: 행 idx와 modify 인자가 둘 다 있고 같을 때만 true다', () => {
  assert.equal(epModifyRowMatches('12345', '12345'), true);
  assert.equal(epModifyRowMatches(' 12345 ', '12345'), true);
  assert.equal(epModifyRowMatches('12345', '54321'), false);
});

test('epModifyRowMatches: 행 idx나 modify 인자가 없으면 fail closed다', () => {
  assert.equal(epModifyRowMatches('', '12345'), false);
  assert.equal(epModifyRowMatches(null, '12345'), false);
  assert.equal(epModifyRowMatches('12345', ''), false);
  assert.equal(epModifyRowMatches('12345', null), false);
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

test('classifyModifySave: form.submit 경로는 leftForm으로 제출을 인정한다', () => {
  assert.equal(classifyModifySave({
    dispatched: false, leftForm: true, landedPathAllowed: true, isLoginOrError: false,
    requery: { found: true, valueEvidence: 'changed-saved' }
  }), 'success');
});

test('classifyModifySave: 제출값==baseline이면 성공으로 단정하지 않고 unchanged다', () => {
  assert.equal(classifyModifySave({
    dispatched: false, leftForm: true, landedPathAllowed: true, isLoginOrError: false,
    requery: { found: true, valueEvidence: 'unchanged' }
  }), 'unchanged');
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

test('epDecideLoadAction: 4개 경로 × valuesDirty 3상태 전 조합을 실행한다', () => {
  const paths = ['save', 'list', 'form', 'other'];
  const signals = [
    { dispatched: false, leftForm: false, valuesDirty: false },
    { dispatched: false, leftForm: false, valuesDirty: true },
    { dispatched: false, leftForm: false, valuesDirty: 'unknown' },
    { dispatched: false, leftForm: true, valuesDirty: false },
    { dispatched: false, leftForm: true, valuesDirty: true },
    { dispatched: false, leftForm: true, valuesDirty: 'unknown' },
    { dispatched: true,  leftForm: false, valuesDirty: false },
    { dispatched: true,  leftForm: false, valuesDirty: true },
    { dispatched: true,  leftForm: false, valuesDirty: 'unknown' },
    { dispatched: true,  leftForm: true,  valuesDirty: false },
    { dispatched: true,  leftForm: true,  valuesDirty: true },
    { dispatched: true,  leftForm: true,  valuesDirty: 'unknown' }
  ];
  const expected = {
    save:  ['verify', 'verify', 'verify', 'verify', 'verify', 'verify',
            'verify', 'verify', 'verify', 'verify', 'verify', 'verify'],
    list:  ['ignore', 'ignore', 'ignore', 'ignore', 'verify', 'verify',
            'verify', 'verify', 'verify', 'verify', 'verify', 'verify'],
    form:  ['editing', 'editing', 'editing', 'editing', 'verify', 'verify',
            'verify', 'verify', 'verify', 'verify', 'verify', 'verify'],
    other: ['ignore', 'ignore', 'ignore', 'ignore', 'verify', 'verify',
            'verify', 'verify', 'verify', 'verify', 'verify', 'verify']
  };
  for (const pathClass of paths) {
    signals.forEach((s, i) => {
      assert.equal(epDecideLoadAction(pathClass, s), expected[pathClass][i],
        pathClass + ' ' + JSON.stringify(s));
    });
  }
});

test('★A form.submit 후 form 재착지는 leftForm 신호로 verify다', () => {
  assert.equal(epDecideLoadAction('form', {
    dispatched: false, leftForm: true, valuesDirty: true
  }), 'verify');
});

test('★leftForm이어도 값이 안 바뀌었으면 저장 검증으로 가지 않는다', () => {
  const signals = { dispatched: false, leftForm: true, valuesDirty: false };
  assert.equal(epDecideLoadAction('form', signals), 'editing');
  assert.equal(epDecideLoadAction('list', signals), 'ignore');
  assert.equal(epDecideLoadAction('other', signals), 'ignore');
});

test('★leftForm에서 값 비교가 불가능하면 fail-closed로 verify다', () => {
  const signals = { dispatched: false, leftForm: true, valuesDirty: 'unknown' };
  assert.equal(epDecideLoadAction('form', signals), 'verify');
  assert.equal(epDecideLoadAction('list', signals), 'verify');
  assert.equal(epDecideLoadAction('other', signals), 'verify');
});

test('★B dispatch 후 other/login 착지는 verify로 내려가 미확정 판정을 받는다', () => {
  assert.equal(epDecideLoadAction('other', {
    dispatched: true, leftForm: false, valuesDirty: false
  }), 'verify');
});

test('★C 제출 플래그를 놓쳐도 save 도착 자체가 verify 증거다', () => {
  assert.equal(epDecideLoadAction('save', {
    dispatched: false, leftForm: false, valuesDirty: false
  }), 'verify');
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

test('epValuesDirtyState: 같음·변경·비교 불가를 3상태로 구분한다', () => {
  assert.equal(epValuesDirtyState({ remark: '같음' }, { remark: '같음' }), false);
  assert.equal(epValuesDirtyState({ remark: '바꿈' }, { remark: '원래' }), true);
  assert.equal(epValuesDirtyState(null, { remark: '원래' }), 'unknown');
  assert.equal(epValuesDirtyState({ remark: '바꿈' }, null), 'unknown');
  assert.equal(epValuesDirtyState({}, {}), 'unknown');
  assert.equal(epValuesDirtyState({ remark: '값' }, { remark: '값', orderQty: '1' }), 'unknown');
});

test('epSaveValueEvidence: 변경한 snapshot이 서버에 있으면 changed-saved다', () => {
  assert.equal(epSaveValueEvidence(
    { remark: '바꿈' }, { remark: '원래' }, { remark: '바꿈' }
  ), 'changed-saved');
});

test('epSaveValueEvidence: 변경했는데 서버가 baseline이면 not-saved다', () => {
  assert.equal(epSaveValueEvidence(
    { remark: '바꿈' }, { remark: '원래' }, { remark: '원래' }
  ), 'not-saved');
});

test('epSaveValueEvidence: snapshot==baseline이면 값 일치를 저장 성공으로 단정하지 않는다', () => {
  assert.equal(epSaveValueEvidence(
    { remark: '같음' }, { remark: '같음' }, { remark: '같음' }
  ), 'unchanged');
  assert.equal(epSaveValueEvidence(
    { remark: '같음' }, { remark: '같음' }, { remark: '다름' }
  ), 'uncertain');
});

test('epVerifiedRowDisposition: 값은 맞지만 원래 하루에서 행이 없으면 목록 재조회다', () => {
  assert.equal(epVerifiedRowDisposition({
    valuesMatched: true, found: false, duplicate: false, hasMore: false,
    loginExpired: false, hasRowHtml: false
  }), 'list-reload');
});

test('epVerifiedRowDisposition: hasMore면 유일성을 단정하지 않고 목록 재조회다', () => {
  assert.equal(epVerifiedRowDisposition({
    valuesMatched: true, found: true, duplicate: false, hasMore: true,
    loginExpired: false, hasRowHtml: true
  }), 'list-reload');
});

test('epVerifiedRowDisposition: 로그인·중복은 목록 재조회로 덮지 않고 미확정이다', () => {
  const base = { valuesMatched: true, found: true, hasMore: false, hasRowHtml: true };
  assert.equal(epVerifiedRowDisposition(Object.assign({}, base, {
    duplicate: true, loginExpired: false
  })), 'uncertain');
  assert.equal(epVerifiedRowDisposition(Object.assign({}, base, {
    duplicate: false, loginExpired: true
  })), 'uncertain');
});

test('epVerifiedRowDisposition: 유일한 행과 HTML이 있을 때만 제자리 갱신 후보가 된다', () => {
  assert.equal(epVerifiedRowDisposition({
    valuesMatched: true, found: true, duplicate: false, hasMore: false,
    loginExpired: false, hasRowHtml: true
  }), 'row-ready');
});

test('epReplacementRowMatches: 서버 rowHtml의 idx가 같은 주문일 때만 교체를 허용한다', () => {
  assert.equal(epReplacementRowMatches('12345', '12345'), true);
  assert.equal(epReplacementRowMatches('12345', '54321'), false);
  assert.equal(epReplacementRowMatches('12345', ''), false);
  assert.equal(epReplacementRowMatches('', '12345'), false);
  assert.equal(epReplacementRowMatches(null, '12345'), false);
});

test('epReplacementTargetAction: 연결된 클릭 행은 현재 키까지 맞을 때만 교체한다', () => {
  assert.equal(epReplacementTargetAction({
    clickedConnected: true, clickedKeyMatches: true, fallbackCount: 2
  }), 'replace');
  assert.equal(epReplacementTargetAction({
    clickedConnected: true, clickedKeyMatches: false, fallbackCount: 0
  }), 'list-reload');
});

test('epReplacementTargetAction: 클릭 행을 못 쓰면 재탐색 후보가 정확히 하나여야 한다', () => {
  assert.equal(epReplacementTargetAction({
    clickedConnected: false, clickedKeyMatches: false, fallbackCount: 1
  }), 'replace');
  assert.equal(epReplacementTargetAction({
    clickedConnected: false, clickedKeyMatches: false, fallbackCount: 0
  }), 'list-reload');
  assert.equal(epReplacementTargetAction({
    clickedConnected: false, clickedKeyMatches: false, fallbackCount: 2
  }), 'list-reload');
  assert.equal(epReplacementTargetAction(null), 'list-reload');
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

test('★slice 2b 판정은 순수 헬퍼를 호출한다(로직 재구현 금지)', () => {
  const start = SRC.indexOf('async function epVerifyAndApply(');
  assert.ok(start >= 0, 'epVerifyAndApply 가 없다');
  const fn = extractFn(SRC, 'epVerifyAndApply');
  assert.ok(/classifyModifySave\(/.test(fn), '성공 판정이 classifyModifySave 를 안 쓴다');
  assert.ok(/epSaveValueEvidence\(/.test(fn), 'baseline/snapshot 판정 헬퍼를 안 쓴다');
  assert.ok(/epVerifiedRowDisposition\(/.test(fn), '행 유일성·폴백 판정 헬퍼를 안 쓴다');
  assert.ok(/decideRowUpdateMode\(/.test(fn), '행 갱신 모드가 decideRowUpdateMode 를 안 쓴다');
  assert.ok(/fetchOrderRow\(/.test(fn), '재조회가 fetchOrderRow 를 안 쓴다');
  assert.ok(!/resyncRow\(/.test(fn), 'resyncRow 는 상태 셀만 갈아서 여기 쓰면 안 된다');
});

test('★행 갱신은 <tr> 통째 교체다 — resyncRow 를 쓰지 않는다', () => {
  const fn = extractFn(SRC, 'epReplaceRow');
  assert.ok(/replaceWith\(/.test(fn), 'tr 통째 교체가 아니다');
  assert.ok(!/innerHTML/.test(fn), '셀 innerHTML 이식은 낡은 값을 남긴다');
  assert.ok(/st\s*&&\s*st\.clickedRow/.test(fn), '클릭한 행 참조를 우선하지 않는다');
  assert.ok(/clicked\s*&&\s*clicked\.isConnected/.test(fn), '클릭한 행의 연결 상태를 확인하지 않는다');
  assert.ok(/epRowOrderSeq\(clicked\)/.test(fn), '보관한 클릭 행의 현재 idx를 재확인하지 않는다');
  assert.ok(/querySelectorAll\('input\[name=idx\]'\)/.test(fn), '현재 DOM 재탐색 폴백이 없다');
  assert.ok(/new Set\(/.test(fn), '재탐색 후보 행의 유일성 계산이 없다');
  assert.ok(/epReplacementTargetAction\(/.test(fn), '교체 대상 키·유일성 순수 판정을 사용하지 않는다');
  assert.ok(/epRowOrderSeq\(nu\)/.test(fn), '서버 rowHtml의 idx를 읽지 않는다');
  assert.ok(/epReplacementRowMatches\(/.test(fn), '서버 행 idx 순수 판정을 사용하지 않는다');
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

test('★baseline은 최초 편집폼에서, snapshot은 제출/이탈 시점에 따로 기록한다', () => {
  const loadFn = extractFn(SRC, 'epOnFrameLoad');
  const watchFn = extractFn(SRC, 'epWatchForm');
  assert.ok(/st\.baseline\s*=\s*epReadFormValues\(doc\)/.test(loadFn), '최초 baseline 장착이 없다');
  assert.ok(/'submit'/.test(watchFn), 'submit 이벤트 감시가 없다');
  assert.ok(/beforeunload/.test(watchFn), 'form.submit() 경로(beforeunload) 감시가 없다');
  assert.ok(/st\.snapshot\s*=\s*epReadFormValues\(doc\)/.test(watchFn), '제출 시점 snapshot이 없다');
  assert.ok(/st\.leftForm\s*=\s*true/.test(watchFn), 'beforeunload가 leftForm을 세우지 않는다');
});

test('★capture submit은 validation 취소 확인 전 dispatched를 확정하지 않는다', () => {
  const fn = extractFn(SRC, 'epWatchForm');
  const prevented = fn.indexOf('e.defaultPrevented');
  const dispatched = fn.indexOf('st.dispatched = true');
  assert.ok(prevented >= 0, 'submit 취소(defaultPrevented) 확인이 없다');
  assert.ok(dispatched > prevented, 'validation 취소 확인 전에 dispatched를 세운다');
  assert.ok(/setTimeout\(/.test(fn), '이벤트 전파가 끝난 뒤 취소 여부를 확인하지 않는다');
});

test('★제출 시도마다 세대를 올리고 검증은 그 세대 snapshot을 고정한다', () => {
  const watchFn = extractFn(SRC, 'epWatchForm');
  const loadFn = extractFn(SRC, 'epOnFrameLoad');
  const verifyFn = extractFn(SRC, 'epVerifyAndApply');
  assert.ok(/\+\+st\.attemptGen/.test(watchFn), '제출 시도 세대 증가가 없다');
  assert.ok(/gen:\s*st\.attemptGen/.test(loadFn), '검증 입력에 제출 세대를 고정하지 않는다');
  assert.ok(/attempt\.gen !== st\.attemptGen/.test(verifyFn), '비동기 검증의 세대 혼합 가드가 없다');
  assert.ok(/attempt\.snapshot/.test(verifyFn), '검증이 고정 snapshot 대신 가변 상태를 읽는다');
});

test('★iframe load 상태 전이는 epDecideLoadAction 한 곳만 진입점으로 쓴다', () => {
  const fn = extractFn(SRC, 'epOnFrameLoad');
  const openFn = extractFn(SRC, 'epOpenPanel');
  assert.ok(/epDecideLoadAction\(/.test(fn), '로드 액션 순수 판정을 사용하지 않는다');
  assert.ok(!/epShouldVerifyLoad/.test(fn), '옛 로드 판정이 함께 남아 있다');
  assert.ok(/cls\s*===\s*'save'[\s\S]*?st\.dispatched\s*=\s*true/.test(fn),
    'save 도착의 dispatch 증거 복구가 없다');
  assert.ok(/epValuesDirtyState\(st\.snapshot,\s*st\.baseline\)/.test(fn),
    'valuesDirty 3상태 순수 판정을 사용하지 않는다');
  assert.ok(/valuesDirty:\s*valuesDirty/.test(fn), '로드 판정에 valuesDirty를 넘기지 않는다');
  assert.ok(/verifyingGen:\s*null/.test(openFn),
    '제출 세대 0인 save 복구가 검증 중복 가드에 막힐 수 있다');
});

test('★행 idx 일치 확인이 패널 생성보다 먼저고 불일치면 false다', () => {
  const fn = extractFn(SRC, 'epOpenPanel');
  const match = fn.indexOf('epModifyRowMatches(');
  const panel = fn.indexOf('epEnsurePanel(');
  assert.ok(match >= 0, '행 idx와 modify 인자 일치 검사가 없다');
  assert.ok(panel > match, '행 일치 확인 전에 패널을 만들었다');
  assert.ok(/if\s*\(!epModifyRowMatches[\s\S]*?return false;/.test(fn),
    '행 불일치/누락이 네이티브 이동으로 fail closed 되지 않는다');
  assert.ok(/clickedRow:\s*row/.test(fn), '클릭한 tr 참조를 작업 상태에 보관하지 않는다');
});

test('★첫 iframe load는 실제 편집폼·비로그인 문서인지 확인한 뒤에만 성공 처리한다', () => {
  const fn = extractFn(SRC, 'epOpenPanel');
  assert.ok(/epClassifyUrl\(href\)\s*===\s*'form'/.test(fn), '첫 load 경로 확인이 없다');
  assert.ok(/epDocLooksLoginOrError\(doc\)/.test(fn), '첫 load 로그인/오류 확인이 없다');
  assert.ok(/doc\.forms\s*&&\s*doc\.forms\['form1'\]/.test(fn), '첫 load form1 확인이 없다');
  assert.ok(/showFallback\(why\)/.test(fn), '첫 load 검증 실패 폴백이 없다');
  assert.ok(/why\s*=\s*'document-access'/.test(fn), 'iframe 문서 접근 예외 폴백이 없다');
});

test('★행 없음·hasMore는 자동 목록 재조회, 로그인·중복은 미확정으로 남긴다', () => {
  const fn = extractFn(SRC, 'epVerifyAndApply');
  assert.ok(/row\.hasMore/.test(fn), 'fetchOrderRow.hasMore를 읽지 않는다');
  assert.ok(/disposition === 'list-reload'/.test(fn), '행 없음/hasMore 목록 폴백 배선이 없다');
  assert.ok(/epReloadList\(\)/.test(fn), '목록 폴백을 실제 실행하지 않는다');
  assert.ok(/disposition === 'uncertain'/.test(fn), '로그인·중복 미확정 분기가 없다');
});

test('★검증 상한 초과는 콘솔뿐 아니라 패널 메시지로 알린다', () => {
  const fn = extractFn(SRC, 'epVerifyAndApply');
  const limit = fn.indexOf('EP_VERIFY_MAX_RUNS');
  const show = fn.indexOf('epShowMsg(', limit);
  assert.ok(limit >= 0 && show > limit, '검증 상한 초과 epShowMsg가 없다');
});

test('★비동기 검증 예외는 콘솔과 패널 양쪽에 알린다', () => {
  const fn = extractFn(SRC, 'epOnFrameLoad');
  const caught = fn.indexOf(".catch((e) => {");
  const logged = fn.indexOf("epLog('검증 예외'", caught);
  const shown = fn.indexOf('epShowMsg(st.panel', caught);
  assert.ok(caught >= 0 && logged > caught, '비동기 검증 예외 로그가 없다');
  assert.ok(shown > caught, '비동기 검증 예외 패널 메시지가 없다');
});

test('작업B는 C-2b 전까지 락·저널 미참여임을 명시한다', () => {
  const start = SRC.indexOf('5.9) 작업B');
  const end = SRC.indexOf('const EP_TAG', start);
  const comment = SRC.slice(start, end);
  assert.match(comment, /락·저널 미참여\s*—\s*C-2b 에서 배선/);
});

test('게이트는 기본 OFF 이고 리스너는 게이트와 무관하게 bind 된다(§5)', () => {
  assert.ok(/ubEditPopup:\s*false/.test(SRC), 'ubEditPopup 기본값이 OFF 가 아니다');
  const fn = extractFn(SRC, 'bindEditPopupIntercept');
  assert.ok(/dataset\.ubEpBound/.test(fn), 'idempotent bind 가드가 없다');
  assert.ok(/state\.ubSkin && state\.ubEditPopup/.test(fn), '클릭 시점 게이트 검사가 없다');
});
