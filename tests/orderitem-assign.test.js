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
               'oneDayParams', 'changeConfirmed', 'statusMatchesLabel', 'asgSignalFresh'];
const ASG_TTL_SRC = SRC.match(/const\s+ASG_TTL\s*=\s*(\d+)/);
assert.ok(ASG_TTL_SRC, 'skin.js 에서 ASG_TTL 상수를 찾지 못했습니다');
const ASG_TTL = Number(ASG_TTL_SRC[1]);

// changeConfirmed 는 파일 상단의 asgNorm 헬퍼를 쓴다 → 같이 실어준다.
const ASG_NORM_SRC = SRC.match(/const\s+asgNorm\s*=\s*[^;]+;/);
assert.ok(ASG_NORM_SRC, 'skin.js 에서 asgNorm 을 찾지 못했습니다');

const sandbox = {};
// eslint-disable-next-line no-new-func
new Function('exports', 'ASG_TTL',
  ASG_NORM_SRC[0] + '\n' +
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => `exports.${n} = ${n};`).join('\n')
)(sandbox, ASG_TTL);

const { parseCurrentSettingArgs, isUnassigned, parseSetCurrentBarcode,
        oneDayParams, changeConfirmed, statusMatchesLabel, asgSignalFresh } = sandbox;

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

// changeConfirmed(관측바코드, 기대바코드, 직전바코드) — 배정과 선택취소를 대칭으로 판정
console.log('changeConfirmed — 반영 완료 판정(배정/취소 공용)');
t('배정: 빈값 → 새 바코드', () => {
  assert.strictEqual(changeConfirmed('2604O0', '2604O0', ''), true);
  assert.strictEqual(changeConfirmed(' 2604o0 ', '2604O0', ''), true);   // 공백·대소문자 무시
});
t('취소: 바코드 → 빈값', () => {
  assert.strictEqual(changeConfirmed('', '', '2604O0'), true);
  assert.strictEqual(changeConfirmed(null, '', '2604O0'), true);
});
t('아직 반영 전이면 실패', () => {
  assert.strictEqual(changeConfirmed('', '2604O0', ''), false);          // 배정 대기
  assert.strictEqual(changeConfirmed('2604O0', '', '2604O0'), false);    // 취소 대기
});
t('기대와 다른 바코드가 붙었으면 실패 (경합 감지)', () => {
  assert.strictEqual(changeConfirmed('2604O9', '2604O0', ''), false);
});
// ★부분일치로 판정하면 '2604O' 기대 시 '2604O1' 을 성공으로 오인한다.
t('접두사 관계인 바코드를 성공으로 오인하지 않는다', () => {
  assert.strictEqual(changeConfirmed('2604O1', '2604O', ''), false);
  assert.strictEqual(changeConfirmed('2604O', '2604O1', ''), false);
});
// ★before === target 이면 애초에 바뀔 게 없다 — 성공으로 보면 안 된다(무변경을 성공 처리 금지).
t('직전 값과 기대값이 같으면 성공 아님', () => {
  assert.strictEqual(changeConfirmed('2604O0', '2604O0', '2604O0'), false);
  assert.strictEqual(changeConfirmed('', '', ''), false);
});

// statusMatchesLabel(상태셀텍스트, 상태필터 옵션라벨) — false 면 그 행을 목록에서 '지운다'.
//  잘못 false 가 나오면 멀쩡한 행이 사라지므로, 애매하면 남기는(true) 쪽으로 설계했다.
console.log('statusMatchesLabel — 행을 지울지 정하는 판단');
t('필터와 같은 상태면 남긴다', () => {
  assert.strictEqual(statusMatchesLabel('입고완료(2604O0)', '입고완료'), true);
  assert.strictEqual(statusMatchesLabel('본사확인', '본사확인'), true);
});
t('상태가 바뀌어 필터를 벗어나면 지운다', () => {
  assert.strictEqual(statusMatchesLabel('입고완료(2604O0)', '본사확인'), false);   // 배정 후
  assert.strictEqual(statusMatchesLabel('본사확인', '입고완료'), false);            // 취소 후
});
// ★옵션 라벨에 괄호가 있는 항목(출고확인(매장재고))을 그대로 비교하면 실제 셀
//   '출고확인(240HTI)' 과 안 맞아 멀쩡한 행을 지운다.
t('옵션 라벨의 괄호를 떼고 비교한다', () => {
  assert.strictEqual(statusMatchesLabel('출고확인(240HTI)', '출고확인(매장재고)'), true);
});
t('앞부분 일치만 인정한다 (다른 상태를 오인하지 않음)', () => {
  assert.strictEqual(statusMatchesLabel('주문취소', '주문완료'), false);
  assert.strictEqual(statusMatchesLabel('출고완료(2607KJ)', '출고확인(매장재고)'), false);
});
t('라벨을 못 읽으면 남긴다 (지우는 쪽이 더 위험)', () => {
  assert.strictEqual(statusMatchesLabel('본사확인', ''), true);
  assert.strictEqual(statusMatchesLabel('본사확인', null), true);
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
