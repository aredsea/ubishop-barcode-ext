/* =============================================================================
 *  orderitem-assign.test.js — 주문전표 재고배정(v3.6.8) 순수 헬퍼 단위테스트.
 *
 *  skin.js 는 content script IIFE 라 require 할 수 없다(fsm.js/erp.js 와 달리 module.exports 없음).
 *  → 소스에서 DOM 비의존 함수 선언만 이름으로 추출해 샌드박스에서 평가한다.
 *    추출 실패(리네임/시그니처 변경) 시 테스트가 즉시 죽으므로 조용한 드리프트가 안 생긴다.
 *
 *  픽스처는 전부 2026-07-18 라이브 실측값.
 *    미배정: currentSetting('6536','387392','','LT','123082','20260713')  → 상태 '본사확인'
 *    배정됨: currentSetting('6536','387503','2604O0','LT','123104','20260715') → '입고완료(2604O0)'
 *
 *  실행: node tests/orderitem-assign.test.js
 * ========================================================================== */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'skin.js'), 'utf8');

// function NAME( ... ) { ... } 를 중괄호 균형으로 잘라낸다(문자열/주석 안 중괄호는 이 함수들엔 없다).
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `skin.js 에서 ${name} 선언을 찾지 못했습니다 (리네임 여부 확인)`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 본문의 중괄호 균형을 찾지 못했습니다`);
}

const NAMES = ['parseCurrentSettingArgs', 'isUnassigned', 'parseSetCurrentBarcode',
               'oneDayParams', 'assignConfirmed', 'asgSignalFresh'];
const ASG_TTL_SRC = SRC.match(/const\s+ASG_TTL\s*=\s*(\d+)/);
assert.ok(ASG_TTL_SRC, 'skin.js 에서 ASG_TTL 상수를 찾지 못했습니다');
const ASG_TTL = Number(ASG_TTL_SRC[1]);

const sandbox = {};
// eslint-disable-next-line no-new-func
new Function('exports', 'ASG_TTL',
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => `exports.${n} = ${n};`).join('\n')
)(sandbox, ASG_TTL);

const { parseCurrentSettingArgs, isUnassigned, parseSetCurrentBarcode,
        oneDayParams, assignConfirmed, asgSignalFresh } = sandbox;

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

console.log('parseCurrentSettingArgs');
t('실측 미배정 링크를 6개 인자로 파싱', () => {
  const a = parseCurrentSettingArgs("javascript:currentSetting('6536','387392','','LT','123082','20260713')");
  assert.deepStrictEqual(a, { master: '6536', orderSeq: '387392', barcode: '',
                              shop: 'LT', client: '123082', orderDate: '20260713' });
});
t('실측 배정된 링크의 barcode 를 보존', () => {
  const a = parseCurrentSettingArgs("javascript:currentSetting('6536','387503','2604O0','LT','123104','20260715')");
  assert.strictEqual(a.barcode, '2604O0');
  assert.strictEqual(a.orderSeq, '387503');
});
t('쌍따옴표·공백 변형 허용', () => {
  const a = parseCurrentSettingArgs('currentSetting( "1", "2", "", "LT", "3", "20260101" )');
  assert.strictEqual(a.orderSeq, '2');
  assert.strictEqual(a.shop, 'LT');
});
t('무관한 href 는 null', () => {
  assert.strictEqual(parseCurrentSettingArgs('javascript:setCurrent(\'26078I\')'), null);
  assert.strictEqual(parseCurrentSettingArgs(''), null);
  assert.strictEqual(parseCurrentSettingArgs(null), null);
});
t('인자가 모자라면 null (부분 파싱으로 오동작 금지)', () => {
  assert.strictEqual(parseCurrentSettingArgs("currentSetting('1','2','3')"), null);
});

console.log('isUnassigned — 가로챌지 말지의 유일한 판정');
t('barcode 가 빈 값이면 미배정', () => {
  assert.strictEqual(isUnassigned({ orderSeq: '387392', barcode: '' }), true);
  assert.strictEqual(isUnassigned({ orderSeq: '387392', barcode: '   ' }), true);
});
t('barcode 가 있으면 배정됨 → 가로채지 않는다', () => {
  assert.strictEqual(isUnassigned({ orderSeq: '387503', barcode: '2604O0' }), false);
});
t('orderSeq 없으면 false (행 식별 불가 시 네이티브로)', () => {
  assert.strictEqual(isUnassigned({ orderSeq: '', barcode: '' }), false);
  assert.strictEqual(isUnassigned(null), false);
});

console.log('parseSetCurrentBarcode');
t('실측 팝업 링크에서 바코드 추출', () => {
  assert.strictEqual(parseSetCurrentBarcode("javascript:setCurrent('26078I');"), '26078I');
  assert.strictEqual(parseSetCurrentBarcode('setCurrent( "2604O6" )'), '2604O6');
});
t('없으면 빈 문자열', () => {
  assert.strictEqual(parseSetCurrentBarcode('javascript:cancelForm()'), '');
  assert.strictEqual(parseSetCurrentBarcode(null), '');
});

console.log('oneDayParams — 대상 행이 반드시 응답에 들어오게 그 하루로 좁힌다');
t('yyyymmdd 를 시작=종료 하루로', () => {
  assert.deepStrictEqual(oneDayParams('20260715'), {
    syear: '2026', smonth: '07', sday: '15', eyear: '2026', emonth: '07', eday: '15'
  });
});
t('형식이 아니면 null (날짜 범위를 건드리지 않음)', () => {
  assert.strictEqual(oneDayParams('2026-07-15'), null);
  assert.strictEqual(oneDayParams('202607'), null);
  assert.strictEqual(oneDayParams(''), null);
  assert.strictEqual(oneDayParams(null), null);
});

// assignConfirmed(상태텍스트, 응답링크의 관측바코드, 기대바코드)
console.log('assignConfirmed — 성공 판정(서버 재조회 결과 기준)');
t('입고완료 + 바코드 정확일치면 성공', () => {
  assert.strictEqual(assignConfirmed('입고완료(2604O0)', '2604O0', '2604O0'), true);
  assert.strictEqual(assignConfirmed(' 입고완료 (2604O0) ', '2604O0', '2604o0'), true);   // 대소문자 무시
});
t('아직 본사확인이면 실패 (아직 반영 전)', () => {
  assert.strictEqual(assignConfirmed('본사확인', '', '2604O0'), false);
});
t('다른 바코드가 배정됐으면 실패 (경합 감지)', () => {
  assert.strictEqual(assignConfirmed('입고완료(2604O9)', '2604O9', '2604O0'), false);
});
// ★부분일치(indexOf)로 판정하면 '2604O' 를 기대할 때 '2604O1' 을 성공으로 오인한다.
t('접두사 관계인 바코드를 성공으로 오인하지 않는다', () => {
  assert.strictEqual(assignConfirmed('입고완료(2604O1)', '2604O1', '2604O'), false);
  assert.strictEqual(assignConfirmed('입고완료(2604O)', '2604O', '2604O1'), false);
});
// ★바코드 없이 '입고완료'만으로 성공 판정하면, 같은 Modify.do 를 타는 배정취소 흐름에서
//   방금 취소한 행을 '입고완료'로 되칠하고 고착시킨다(리뷰 지적). 바코드 대조는 필수.
t('바코드를 모르면 성공 판정하지 않는다 (배정취소 오인 차단)', () => {
  assert.strictEqual(assignConfirmed('입고완료(2604O0)', '2604O0', ''), false);
  assert.strictEqual(assignConfirmed('입고완료(2604O0)', '2604O0', null), false);
  assert.strictEqual(assignConfirmed('입고완료(2604O0)', '', '2604O0'), false);   // 관측 실패
});
t('빈/널 입력은 실패', () => {
  assert.strictEqual(assignConfirmed('', '2604O0', '2604O0'), false);
  assert.strictEqual(assignConfirmed(null, '2604O0', '2604O0'), false);
});

console.log('asgSignalFresh — 신호 만료');
t('방금 신호는 유효', () => {
  const now = 1_800_000_000_000;
  assert.strictEqual(asgSignalFresh({ orderSeq: '1', ts: now - 1000 }, now), true);
});
t('TTL 초과 신호는 무시', () => {
  const now = 1_800_000_000_000;
  assert.strictEqual(asgSignalFresh({ orderSeq: '1', ts: now - ASG_TTL - 1 }, now), false);
});
t('형식 불량은 무시', () => {
  const now = 1_800_000_000_000;
  assert.strictEqual(asgSignalFresh(null, now), false);
  assert.strictEqual(asgSignalFresh({ ts: now }, now), false);
  assert.strictEqual(asgSignalFresh({ orderSeq: '1' }, now), false);
});

console.log(`\n${pass} pass`);
