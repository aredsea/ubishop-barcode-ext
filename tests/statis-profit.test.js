/* =============================================================================
 *  statis-profit.test.js — 상품집계 '이익율'(app v2.8.0) 순수 헬퍼 단위테스트.
 *
 *  이익율 = (실판매가 − 총입고가) ÷ 실판매가.
 *  statis.js 는 IIFE 라 require 할 수 없다 → 소스에서 DOM 비의존 함수만 이름으로 추출해 평가한다.
 *
 *  기대값은 2026-07-19 라이브 실측 행에서 가져왔다(화면 표시와 대조 완료):
 *    1,670,000 / 878,439 → 47.4%      1,330,000 / 669,673 → 49.6%
 *    1,100,000 / 764,381 → 30.5%      실판매가 0(사은품) → 빈칸
 *
 *  실행: node tests/statis-profit.test.js
 * ========================================================================== */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'statis.js'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `statis.js 에서 ${name} 선언을 찾지 못했습니다 (리네임 여부 확인)`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 본문의 중괄호 균형을 찾지 못했습니다`);
}

const NAMES = ['firstNum', 'numOrNull', 'profitRate', 'profitText'];
// eslint-disable-next-line no-new-func
const M = new Function(NAMES.map(n => extractFn(SRC, n)).join('\n') + '\nreturn {' + NAMES.join(',') + '};')();
const { firstNum, numOrNull, profitRate, profitText } = M;

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

console.log('profitText — 라이브 실측값과 일치');
t('실측 3건이 화면 표시와 같다', () => {
  assert.strictEqual(profitText(1670000, 878439), '47.4%');
  assert.strictEqual(profitText(1330000, 669673), '49.6%');
  assert.strictEqual(profitText(1100000, 764381), '30.5%');
});

console.log('미표기 규칙 — 사용자 요청(가독성)');
t('실판매가 0(사은품 등)은 빈칸', () => {
  assert.strictEqual(profitText(0, 165637), '');
  assert.strictEqual(profitText(-1, 100), '');
});
t('정확히 0% 도 빈칸', () => {
  assert.strictEqual(profitText(100000, 100000), '');
});
// ★은닉은 '표시'에서만 한다. 값까지 null 로 만들면 요약 한 줄에서 '진짜 0%' 와
//   '낼 수 없음(원가 결측·매출 0)' 이 똑같이 '—' 로 보여 구분이 사라진다.
t('0% 는 값으로는 0, 표시로만 빈칸', () => {
  assert.strictEqual(profitRate(100000, 100000), 0);
  assert.strictEqual(profitText(100000, 100000), '');
  assert.strictEqual(profitRate(0, 100000), null);      // 낼 수 없음은 값도 null
});
// ★원가 결측을 0원으로 보면 '이익율 100%' 라는 완전히 틀린 숫자가 나온다.
//   모르는 것을 100% 로 보여주는 게 이 기능에서 제일 위험하다 → 미표기.
t('원가 결측(null)은 빈칸 — 0원으로 취급 금지', () => {
  assert.strictEqual(profitText(100000, null), '');
  assert.strictEqual(profitText(100000, undefined), '');
  assert.strictEqual(profitRate(100000, null), null);
});
t('원가가 실제 0원이면 100% 로 표시(결측과 구분)', () => {
  assert.strictEqual(profitText(100000, 0), '100.0%');
});

console.log('경계');
t('원가가 매출보다 크면 음수로 표시(역마진은 보여야 한다)', () => {
  assert.strictEqual(profitText(100000, 150000), '-50.0%');
});
t('반올림은 소수 첫째자리', () => {
  assert.strictEqual(profitText(1000000, 555555), '44.4%');   // 44.4445% → 44.4
});

console.log('numOrNull — 결측과 0원 구분');
t('숫자가 없으면 null', () => {
  assert.strictEqual(numOrNull(''), null);
  assert.strictEqual(numOrNull('   '), null);
  assert.strictEqual(numOrNull('-'), null);
  assert.strictEqual(numOrNull(null), null);
});
t('0 은 결측이 아니다', () => {
  assert.strictEqual(numOrNull('0'), 0);
});
// ★유비샵 금액셀은 "165,637<br>165,637<br>0" 처럼 값이 구분자 없이 붙는다.
t('붙어 나오는 금액셀에서 첫 값만 집는다', () => {
  assert.strictEqual(numOrNull('165,637165,6370'), 165637);
  assert.strictEqual(firstNum('878,439878,4390'), 878439);
});

/* ---------------------------------------------------------------------------
 *  구조 불변식 — 상세행 colspan 이 실제 열 개수를 덮는가.
 *
 *  이익율 열을 늘리면서 colspan 을 안 올려 판매탭 3뷰의 상세행이 한 칸씩 모자랐다
 *  (표가 통째로 밀려 보임). 값 단위테스트로는 안 잡히던 종류라 소스에서 직접 세어 고정한다.
 *
 *  각 뷰: 헤더의 <th> 개수(+ 판매탭에만 붙는 discountHead/profitHead) == 1 + colspan.
 *   (상세행은 <td></td> 한 칸을 앞에 두고 나머지를 colspan 으로 덮는다)
 * ------------------------------------------------------------------------- */
// ★불변식은 실제로 그려지는 renderOrder 이후 구간에만 적용한다.
//   (v2.9.1 이전에는 같은 파일에 호출부 0개인 죽은 render(result, meta) 가 있어 그쪽 상세행까지
//    잡혔다. 그 죽은 코드는 제거됐지만, 앞 구간을 배제하는 이 범위 한정은 그대로 유효하다.)
const ALL = SRC.split(/\r?\n/);
const ORDER_AT = ALL.findIndex(l => l.includes('function renderOrder('));
assert.ok(ORDER_AT > 0, 'statis.js 에서 renderOrder 선언을 찾지 못했습니다');
const LINES = ALL.slice(ORDER_AT);
const headerLines = LINES.filter(l => l.includes('profitHead') && /<th>#<\/th>|id="ub-o-all"/.test(l));
const detailLines = LINES.filter(l => l.includes('class="det"') && l.includes('colspan'));

console.log('상세행 colspan — 헤더 열 개수와 일치');
t('그룹 헤더 3뷰와 상세행 3개를 모두 찾는다', () => {
  assert.strictEqual(headerLines.length, 3, '그룹 헤더 3개를 찾지 못했습니다: ' + headerLines.length);
  assert.strictEqual(detailLines.length, 3, '상세행 3개를 찾지 못했습니다: ' + detailLines.length);
});
t('주문/판매 두 모드 모두 colspan 이 열을 정확히 덮는다', () => {
  headerLines.forEach((h, i) => {
    const ths = (h.match(/<th/g) || []).length;                       // 두 모드 공통 열
    const opt = (h.match(/discountHead|profitHead/g) || []).length;   // 판매탭에만 나오는 열
    const m = detailLines[i].match(/IS_ORDER \? (\d+) : (\d+)/);
    assert.ok(m, '상세행 ' + i + ' 에서 colspan 식을 읽지 못했습니다');
    assert.strictEqual(1 + Number(m[1]), ths, '뷰 ' + i + ' 주문탭 열 ' + ths + ' != 1+' + m[1]);
    assert.strictEqual(1 + Number(m[2]), ths + opt, '뷰 ' + i + ' 판매탭 열 ' + (ths + opt) + ' != 1+' + m[2]);
  });
});

console.log(`\n${pass} pass`);
