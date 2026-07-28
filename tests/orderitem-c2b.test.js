/* =============================================================================
 *  orderitem-c2b.test.js — 작업C 배치 실행(slice C-2b) 순수 헬퍼 단위테스트.
 *
 *  skin.js 는 content script IIFE 라 require 할 수 없다.
 *  → 소스에서 DOM 비의존 함수 선언만 이름으로 추출해 샌드박스에서 평가한다
 *    (orderitem-c2a.test.js 와 동일 방식. 리네임하면 추출 실패로 즉사한다).
 *
 *  ⚠ 이 파일을 PowerShell 로 편집하지 마라 — Set-Content 가 한글을 깨뜨린다.
 *  실행: node tests/orderitem-c2b.test.js
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

// cExtractRowArgs → parseCurrentSettingArgs 호출. 둘 다 추출해 같은 스코프에 둔다.
const NAMES = [
  'parseCurrentSettingArgs',
  'cExtractSKey', 'cParseCandidateRows',
  'cBuildStandbyUrl', 'cBuildCandidateFormUrl', 'cBuildAssignUrl',
  'cExtractRowArgs',
  'cOrderDateColIndex', 'cParseRowOrderDate',
  'cListStatusCode', 'cNextStep', 'cPickAssignBarcode', 'cClassifyOutcome'
];
const sandbox = {};

// eslint-disable-next-line no-new-func
new Function('exports',
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => 'exports.' + n + ' = ' + n + ';').join('\n')
)(sandbox);

const {
  parseCurrentSettingArgs,
  cExtractSKey, cParseCandidateRows,
  cBuildStandbyUrl, cBuildCandidateFormUrl, cBuildAssignUrl,
  cExtractRowArgs,
  cOrderDateColIndex, cParseRowOrderDate,
  cListStatusCode, cNextStep, cPickAssignBarcode, cClassifyOutcome
} = sandbox;

/* ── cExtractSKey ──────────────────────────────────────────────────────── */
test('cExtractSKey: 인라인 스크립트에서 sKey 15자리 추출', () => {
  const html = '<script>var url="orderItemStandby.do?tcode=order_item&status1=OS-&status2=O--&sKey=260728101357447&reqPage=1";</script>';
  assert.equal(cExtractSKey(html), '260728101357447');
});

test('cExtractSKey: ?sKey= 시작도 매칭', () => {
  assert.equal(cExtractSKey('action="foo.do?sKey=260728091200123"'), '260728091200123');
});

test('cExtractSKey: 14~16자리도 매칭', () => {
  assert.equal(cExtractSKey('&sKey=26072810135744'), '26072810135744');  // 14자리
  assert.equal(cExtractSKey('&sKey=2607281013574471'), '2607281013574471');  // 16자리
});

test('cExtractSKey: 숫자 아닌 값·빈 HTML·null 은 null', () => {
  assert.equal(cExtractSKey(''), null);
  assert.equal(cExtractSKey(null), null);
  assert.equal(cExtractSKey(undefined), null);
  assert.equal(cExtractSKey('sKey=abc'), null);
  assert.equal(cExtractSKey('no skey here'), null);
});

test('cExtractSKey: 13자리 이하·17자리 이상은 매칭 안 됨', () => {
  assert.equal(cExtractSKey('&sKey=2607281013574'), null);  // 13자리
  assert.equal(cExtractSKey('&sKey=26072810135744712'), null);  // 17자리
});

/* ── cParseCandidateRows ───────────────────────────────────────────────── */
test('cParseCandidateRows: setCurrent 링크에서 바코드 추출 (다수)', () => {
  const html = '<a href="javascript:setCurrent(\'2604O7\')">선택</a>' +
               '<a href="javascript:setCurrent(\'2604O9\')">선택</a>' +
               '<a href="javascript:setCurrent(\'2606WH\')">선택</a>';
  const rows = cParseCandidateRows(html);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].barcode, '2604O7');
  assert.equal(rows[1].barcode, '2604O9');
  assert.equal(rows[2].barcode, '2606WH');
});

test('cParseCandidateRows: 쌍따옴표도 매칭', () => {
  const rows = cParseCandidateRows('<a href="javascript:setCurrent(&quot;ABC123&quot;)">');
  // &quot; 는 HTML 엔티티라 raw 파싱에선 안 잡힌다. 실제 href 에는 따옴표가 들어간다.
  // 실측에서는 홑따옴표만 쓰므로 이 케이스는 빈 결과가 맞다.
  // 실제 쌍따옴표가 들어오면:
  const rows2 = cParseCandidateRows('setCurrent("XYZ789")');
  assert.equal(rows2.length, 1);
  assert.equal(rows2[0].barcode, 'XYZ789');
});

test('cParseCandidateRows: 후보 0건 (빈 HTML·setCurrent 없음)', () => {
  assert.deepEqual(cParseCandidateRows(''), []);
  assert.deepEqual(cParseCandidateRows('<table></table>'), []);
  assert.deepEqual(cParseCandidateRows(null), []);
  assert.deepEqual(cParseCandidateRows(undefined), []);
});

/* ── cBuildStandbyUrl ──────────────────────────────────────────────────── */
test('cBuildStandbyUrl: sKey + 검색조건으로 올바른 URL 조립', () => {
  const url = cBuildStandbyUrl('260728101357447', { reqPage: '1', pageSize: '100', searchShop: 'LT' });
  assert.ok(url.startsWith('/jun/orderitem/orderItemStandby.do?'));
  const p = new URLSearchParams(url.split('?')[1]);
  assert.equal(p.get('tcode'), 'order_item');
  assert.equal(p.get('status1'), 'OS-');
  assert.equal(p.get('status2'), 'O--');
  assert.equal(p.get('sKey'), '260728101357447');
  assert.equal(p.get('reqPage'), '1');
  assert.equal(p.get('pageSize'), '100');
  assert.equal(p.get('searchShop'), 'LT');
});

test('cBuildStandbyUrl: sKey 없으면 null (fail-closed)', () => {
  assert.equal(cBuildStandbyUrl(null, {}), null);
  assert.equal(cBuildStandbyUrl('', {}), null);
  assert.equal(cBuildStandbyUrl(undefined, {}), null);
});

test('cBuildStandbyUrl: searchFields 가 null/undefined 여도 기본 파라미터는 포함', () => {
  const url = cBuildStandbyUrl('123456789012345', null);
  const p = new URLSearchParams(url.split('?')[1]);
  assert.equal(p.get('tcode'), 'order_item');
  assert.equal(p.get('sKey'), '123456789012345');
});

/* ── cBuildCandidateFormUrl ─────────────────────────────────────────────── */
test('cBuildCandidateFormUrl: master 포함 + 모든 인자 + 검색조건', () => {
  const url = cBuildCandidateFormUrl('6536', '387848', 'LT', '123213', '20260727', { pageSize: '100' });
  assert.ok(url.startsWith('/jun/orderitem/orderItemPopCurrentSettingModifyForm.do?'));
  const p = new URLSearchParams(url.split('?')[1]);
  assert.equal(p.get('tcode'), 'order_item');
  assert.equal(p.get('master'), '6536');
  assert.equal(p.get('orderSeq'), '387848');
  assert.equal(p.get('barcode'), '');
  assert.equal(p.get('shop'), 'LT');
  assert.equal(p.get('client'), '123213');
  assert.equal(p.get('orderDate'), '20260727');
  assert.equal(p.get('reqPage'), '1');
  assert.equal(p.get('pageSize'), '100');
});

/* ── cBuildAssignUrl (★master 부재 검증) ───────────────────────────────── */
test('cBuildAssignUrl: master 파라미터가 없다 (실측 확인 — 핵심 안전 검증)', () => {
  const url = cBuildAssignUrl('2604O7', '387848', 'LT', '123213', '20260727', { pageSize: '100' });
  assert.ok(url.startsWith('/jun/orderitem/orderItemPopCurrentSettingModify.do?'));
  const p = new URLSearchParams(url.split('?')[1]);
  assert.equal(p.has('master'), false, 'Modify URL 에 master 가 있으면 안 된다');
  assert.equal(p.get('barcode'), '2604O7');
  assert.equal(p.get('orderSeq'), '387848');
  assert.equal(p.get('shop'), 'LT');
  assert.equal(p.get('client'), '123213');
  assert.equal(p.get('orderDate'), '20260727');
  assert.equal(p.get('reqPage'), '1');
  assert.equal(p.get('pageSize'), '100');
});

test('cBuildAssignUrl vs cBuildCandidateFormUrl: Form 은 master 있고, Modify 는 없다', () => {
  const sf = { pageSize: '100', searchShop: 'LT' };
  const formUrl = cBuildCandidateFormUrl('6536', '387848', 'LT', '123213', '20260727', sf);
  const modifyUrl = cBuildAssignUrl('2604O7', '387848', 'LT', '123213', '20260727', sf);
  const fp = new URLSearchParams(formUrl.split('?')[1]);
  const mp = new URLSearchParams(modifyUrl.split('?')[1]);
  assert.equal(fp.has('master'), true, 'Form URL 에는 master 가 있어야 한다');
  assert.equal(mp.has('master'), false, 'Modify URL 에는 master 가 없어야 한다');
  // 나머지 공통 파라미터는 같다
  assert.equal(fp.get('orderSeq'), mp.get('orderSeq'));
  assert.equal(fp.get('shop'), mp.get('shop'));
  assert.equal(fp.get('client'), mp.get('client'));
  assert.equal(fp.get('orderDate'), mp.get('orderDate'));
  assert.equal(fp.get('pageSize'), mp.get('pageSize'));
  assert.equal(fp.get('searchShop'), mp.get('searchShop'));
});

/* ── 검색조건 재구성 ───────────────────────────────────────────────────── */
test('URL 빌더: searchFields 의 키가 고정 파라미터와 겹치면 고정값 우선(중복 방지)', () => {
  // tcode, status1 등은 이미 설정되어 있으므로 searchFields 에서 온 값은 무시된다
  const url = cBuildStandbyUrl('111111111111111', { tcode: 'WRONG', status1: 'WRONG', reqPage: '99' });
  const p = new URLSearchParams(url.split('?')[1]);
  assert.equal(p.get('tcode'), 'order_item', 'tcode 는 고정값');
  assert.equal(p.get('status1'), 'OS-', 'status1 은 고정값');
  // reqPage 는 고정 파라미터가 아니므로 searchFields 값이 들어간다
  assert.equal(p.get('reqPage'), '99');
});

test('URL 빌더: searchFields 없으면 고정 파라미터만', () => {
  const url = cBuildAssignUrl('BC', '123', 'SH', 'CL', '20260101', undefined);
  const p = new URLSearchParams(url.split('?')[1]);
  assert.equal(p.get('barcode'), 'BC');
  assert.equal(p.get('orderSeq'), '123');
  // searchFields 가 없으므로 pageSize 등은 포함되지 않는다
  assert.equal(p.has('pageSize'), false);
});

/* ── cExtractRowArgs ───────────────────────────────────────────────────── */
test('cExtractRowArgs: rowHtml 에서 currentSetting 인자 6개 추출', () => {
  const html = '<tr><td><a href="javascript:currentSetting(\'6536\',\'387848\',\'2604O7\',\'LT\',\'123213\',\'20260727\')">링크</a></td></tr>';
  const args = cExtractRowArgs(html);
  assert.ok(args);
  assert.equal(args.master, '6536');
  assert.equal(args.orderSeq, '387848');
  assert.equal(args.barcode, '2604O7');
  assert.equal(args.shop, 'LT');
  assert.equal(args.client, '123213');
  assert.equal(args.orderDate, '20260727');
});

test('cExtractRowArgs: 바코드가 빈 값(미배정=본사확인 상태)', () => {
  const html = '<a href="javascript:currentSetting(\'6536\',\'387848\',\'\',\'LT\',\'123213\',\'20260727\')">링크</a>';
  const args = cExtractRowArgs(html);
  assert.ok(args);
  assert.equal(args.barcode, '');
});

test('cExtractRowArgs: currentSetting 없으면 null (O-- 행)', () => {
  assert.equal(cExtractRowArgs('<tr><td>주문완료</td></tr>'), null);
  assert.equal(cExtractRowArgs(''), null);
  assert.equal(cExtractRowArgs(null), null);
  assert.equal(cExtractRowArgs(undefined), null);
});

test('cExtractRowArgs: 인자 6개가 아니면 null (fail-closed)', () => {
  assert.equal(cExtractRowArgs("currentSetting('a','b','c')"), null);
  assert.equal(cExtractRowArgs("currentSetting('a','b','c','d','e','f','g')"), null);
});

/* ── cListStatusCode (canonical 상태 절단 — 괄호 함정) ──────────────────── */
test('cListStatusCode: 괄호 뒤 바코드 무시 — 입고완료(2604O9) → I--', () => {
  assert.equal(cListStatusCode('입고완료(2604O9)'), 'I--');
  assert.equal(cListStatusCode('입고완료'), 'I--');
});

test('cListStatusCode: 출고확인(240HTI) 함정 — TS- (출고확인(매장재고) 라벨과 혼동 금지)', () => {
  // 셀 텍스트는 '출고확인(240HTI)' 이고 옵션 라벨은 '출고확인(매장재고)' 다.
  // 괄호 안 내용은 무시하고 한글 라벨만 판정해야 한다.
  assert.equal(cListStatusCode('출고확인(240HTI)'), 'TS-');
  assert.equal(cListStatusCode('출고확인'), 'TS-');
  assert.equal(cListStatusCode('출고오확인'), 'TE-');
});

test('cListStatusCode: 괄호 그룹 2개·접두/접미 이물은 null', () => {
  assert.equal(cListStatusCode('입고완료(a)(b)'), null);
  assert.equal(cListStatusCode('X입고완료'), null);
  assert.equal(cListStatusCode('입고완료X'), null);
});

/* ── cNextStep (다음 단계 판정) ─────────────────────────────────────────── */
test('cNextStep: 주문완료→standby, 본사확인→assign, 그 외→abort', () => {
  assert.equal(cNextStep('O--'), 'standby');
  assert.equal(cNextStep('OS-'), 'assign');
  assert.equal(cNextStep('I--'), 'abort');
  assert.equal(cNextStep('OC-'), 'abort');
  assert.equal(cNextStep(null), 'abort');
  assert.equal(cNextStep(undefined), 'abort');
  assert.equal(cNextStep(''), 'abort');
});

/* ── cPickAssignBarcode (후보 0건 처리) ─────────────────────────────────── */
test('cPickAssignBarcode: 후보 0건은 null — 쓰기로 빈 값이 흘러가지 않는다', () => {
  assert.equal(cPickAssignBarcode([]), null);
  assert.equal(cPickAssignBarcode(null), null);
});

test('cPickAssignBarcode: 첫 행 바코드 채택', () => {
  assert.equal(cPickAssignBarcode([{ barcode: '2604O7' }, { barcode: '2604O9' }]), '2604O7');
});

test('cPickAssignBarcode: 빈 바코드·비문자열은 null', () => {
  assert.equal(cPickAssignBarcode([{ barcode: '' }]), null);
  assert.equal(cPickAssignBarcode([{ barcode: null }]), null);
});

/* ── cClassifyOutcome (성공 3분기) ──────────────────────────────────────── */
test('cClassifyOutcome: dispatch 후 I-- + 바코드 일치 = success', () => {
  assert.equal(cClassifyOutcome({
    dispatched: true, expectedBarcode: '2604O7',
    requery: { found: true, code: 'I--', assignedBarcode: '2604O7' }
  }), 'success');
});

test('cClassifyOutcome: dispatch 전(dispatched!==true) = fail (확정 실패)', () => {
  assert.equal(cClassifyOutcome({ dispatched: false }), 'fail');
  assert.equal(cClassifyOutcome(null), 'fail');
});

test('cClassifyOutcome: dispatch 후 non-success = uncertain (미확정, 재시도 금지)', () => {
  // 이전 상태로 보임
  assert.equal(cClassifyOutcome({
    dispatched: true, expectedBarcode: 'B1',
    requery: { found: true, code: 'OS-', assignedBarcode: '' }
  }), 'uncertain');
  // 다른 바코드
  assert.equal(cClassifyOutcome({
    dispatched: true, expectedBarcode: 'B1',
    requery: { found: true, code: 'I--', assignedBarcode: 'B2' }
  }), 'uncertain');
  // 재조회 실패
  assert.equal(cClassifyOutcome({
    dispatched: true, expectedBarcode: 'B1', requery: null
  }), 'uncertain');
  // 미확정은 절대 fail 이 아님
  const v = cClassifyOutcome({
    dispatched: true, expectedBarcode: 'B1',
    requery: { found: false, code: null, assignedBarcode: null }
  });
  assert.equal(v, 'uncertain');
  assert.notEqual(v, 'fail', 'dispatch 후 non-success 는 fail(=재시도 암시) 이 아닌 uncertain');
});

/* ── cParseRowOrderDate (주문일 셀 파싱) ───────────────────────────────── */
test('cParseRowOrderDate: 실측 셀 텍스트에서 yyyymmdd 추출', () => {
  assert.equal(cParseRowOrderDate('26-07-27 0000002XW5'), '20260727');
});

test('cParseRowOrderDate: 빈문자열 → 빈문자열', () => {
  assert.equal(cParseRowOrderDate(''), '');
});

test('cParseRowOrderDate: 날짜 패턴 없으면 빈문자열 (fail-closed)', () => {
  assert.equal(cParseRowOrderDate('장번호만'), '');
  assert.equal(cParseRowOrderDate('20260727'), '', '대시 없는 8자리는 매칭 안 됨');
});

test('cParseRowOrderDate: 4자리 연도 형식도 앞 2자리만 채택', () => {
  // '2026-07-27' → 첫 \d{2}-\d{2}-\d{2} 매칭 = '20-26-07' → '20202607'
  // 이건 의미 없는 날짜지만 safe: fetchOrderRow 에서 그 날짜 행을 못 찾으면 found:false → 중단
  const result = cParseRowOrderDate('2026-07-27');
  assert.equal(typeof result, 'string');
  assert.ok(result.length === 8, '8자리 문자열이어야 한다');
});

test('cParseRowOrderDate: null/undefined → 빈문자열', () => {
  assert.equal(cParseRowOrderDate(null), '');
  assert.equal(cParseRowOrderDate(undefined), '');
});

/* ── cOrderDateColIndex (주문일 열 인덱스) ─────────────────────────────── */
test('cOrderDateColIndex: 실측 헤더 배열에서 주문일 열 찾기', () => {
  const headers = ['No', '', '주문일 주문장번호', '발주처명 발주일', '이미지',
    '매입처상품코드 상품코드 / 고객명', '구분', '상품정보', '수량', '주문가',
    '매장명 (주문직원)', '인도예정일', '상태', '수정/취소'];
  assert.equal(cOrderDateColIndex(headers), 2);
});

test('cOrderDateColIndex: 주문일 이 없으면 -1', () => {
  assert.equal(cOrderDateColIndex(['No', '바코드', '상태']), -1);
  assert.equal(cOrderDateColIndex([]), -1);
});

test('cOrderDateColIndex: null/undefined 입력 → -1', () => {
  assert.equal(cOrderDateColIndex(null), -1);
  assert.equal(cOrderDateColIndex(undefined), -1);
});

test('cOrderDateColIndex: 부분일치 — 주문일 을 포함하면 매칭', () => {
  assert.equal(cOrderDateColIndex(['No', '주문일주문장번호']), 1);
});
