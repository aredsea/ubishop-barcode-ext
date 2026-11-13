/* =============================================================================
 *  orderitem-vfilter.test.js — 주문전표 가상 필터(품위 14K+18K · 매장 전매장 FASHION 제외) 순수 헬퍼 + 배선.
 *  skin.js 에서 함수 본문을 추출(extractFn)해 DOM 없이 검증한다. 네트워크·DOM 접근 없음.
 *  ⚠ 이 파일을 PowerShell 로 편집하지 마라 — Set-Content 가 한글을 깨뜨린다.
 *  실행: node --test tests/orderitem-vfilter.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'skin.js'), 'utf8');

function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'skin.js 에서 ' + name + ' 선언을 찾지 못했습니다 (리네임 여부 확인)');
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(name + ' 본문의 중괄호 균형을 찾지 못했습니다');
}

const NAMES = ['ojNormIntent', 'ojVirtualRowKeep', 'ojParseSum', 'ojCombineSums', 'ojFmtGold', 'ojFmtInt',
               'ojIntentApply', 'ojSumPlan'];
// eslint-disable-next-line no-new-func
const H = new Function(
  "const OJ_K_TOKENS = ['14K', '18K'];\n" +
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  'return { ' + NAMES.join(', ') + ' };'
)();

const K = { k: '14+18', shop: null };
const S = { k: null, shop: 'noFashion' };
const KS = { k: '14+18', shop: 'noFashion' };

test('품위 — 14K/18K 는 남기고 925·24K·기타는 제거', () => {
  assert.equal(H.ojVirtualRowKeep({ product: '14K 1.68 g 핑크 ()', store: '울산점 (홍)' }, K), true);
  assert.equal(H.ojVirtualRowKeep({ product: '18K 2 g 화이트 (46)', store: '울산점 (홍)' }, K), true);
  assert.equal(H.ojVirtualRowKeep({ product: '925 0 g 기타등 (46+5cm)', store: '울산점' }, K), false);
  assert.equal(H.ojVirtualRowKeep({ product: '24K 1 g', store: '울산점' }, K), false);
});

test('품위 — 첫 토큰 정확일치(14K금·114K·공백/개행 섞임)', () => {
  assert.equal(H.ojVirtualRowKeep({ product: '14K금 1 g', store: 'a' }, K), false);
  assert.equal(H.ojVirtualRowKeep({ product: '114K 1 g', store: 'a' }, K), false);
  assert.equal(H.ojVirtualRowKeep({ product: '\n  14K \n 1.68 g', store: 'a' }, K), true);
  assert.equal(H.ojVirtualRowKeep({ product: '핑크 14K', store: 'a' }, K), false);   // 첫 토큰이 아니면 제외
});

test('매장 — FASHION 제거, D102본사·다른 매장 유지', () => {
  assert.equal(H.ojVirtualRowKeep({ product: '14K', store: 'FASHION (홍해진)' }, S), false);
  assert.equal(H.ojVirtualRowKeep({ product: '14K', store: '  FASHION' }, S), false);
  assert.equal(H.ojVirtualRowKeep({ product: '14K', store: 'D102본사 (김)' }, S), true);
  assert.equal(H.ojVirtualRowKeep({ product: '14K', store: '울산점 (FASHION 담당)' }, S), true);   // 시작이 아니면 유지
});

test('품위·매장 동시 — 둘 다 만족해야 유지', () => {
  assert.equal(H.ojVirtualRowKeep({ product: '14K 1 g', store: '울산점' }, KS), true);
  assert.equal(H.ojVirtualRowKeep({ product: '14K 1 g', store: 'FASHION (a)' }, KS), false);
  assert.equal(H.ojVirtualRowKeep({ product: '925 1 g', store: '울산점' }, KS), false);
});

test('의도 없음/이상한 의도 — 항상 유지, 읽을 셀이 없으면 의도가 있을 때 제거(fail-closed)', () => {
  assert.equal(H.ojVirtualRowKeep({ product: '925', store: 'FASHION' }, null), true);
  assert.equal(H.ojVirtualRowKeep({ product: '925', store: 'FASHION' }, { k: 'x', shop: 'y' }), true);
  assert.equal(H.ojVirtualRowKeep({ store: '울산점' }, K), false);
  assert.equal(H.ojVirtualRowKeep({ product: '14K' }, S), false);
});

test('합계 파싱 — 순금 : 8.9689 g | 18 | 8,805,400', () => {
  const r = H.ojParseSum(['합 계', '순금 : 8.9689 g', '18', '8,805,400', '']);
  assert.deepEqual(r, { gold4: 89689, count: 18, amount: 8805400, idx: { gold: 1, count: 2, amount: 3 } });
  assert.equal(H.ojParseSum(['합 계', '순금 : 0 g', '0', '0', ''])?.count, 0);
  assert.equal(H.ojParseSum(['합 계', '\n순금 :\n 1,234.5 g ', '1,020', '1,000', ''])?.gold4, 12345000);
});

test('합계 파싱 — 형식이 다르면 null(추측 금지)', () => {
  assert.equal(H.ojParseSum(null), null);
  assert.equal(H.ojParseSum([]), null);
  assert.equal(H.ojParseSum(['합 계', '순금 : 8.9689 g', 'abc', '1', '']), null);
  assert.equal(H.ojParseSum(['합 계', '순금 : 8.9689 g', '18']), null);
  assert.equal(H.ojParseSum(['합 계', '중량 : 8.9689 g', '18', '1']), null);
});

test('합계 조합 — plus − minus, 두 K 합, 정수 연산(부동소수 오차 없음)', () => {
  const s = (g, c, a) => ({ gold4: g, count: c, amount: a });
  // K=3: 전체 10.0 g/10건/1000 − FASHION 2.5 g/3건/300 = 7.5/7/700 ; K=2: 5/5/500 − 1/1/100 = 4/4/400
  const r = H.ojCombineSums([
    { sign: 1, sum: s(100000, 10, 1000) }, { sign: -1, sum: s(25000, 3, 300) },
    { sign: 1, sum: s(50000, 5, 500) }, { sign: -1, sum: s(10000, 1, 100) }
  ]);
  assert.deepEqual(r, { gold4: 115000, count: 11, amount: 1100 });
  const r2 = H.ojCombineSums([{ sign: 1, sum: s(1, 1, 1) }, { sign: 1, sum: s(2, 2, 2) }]);   // 0.0001+0.0002
  assert.equal(r2.gold4, 3);
});

test('합계 조합 — 하나라도 null·음수 결과·빈 목록·잘못된 sign 이면 null', () => {
  const s = (g, c, a) => ({ gold4: g, count: c, amount: a });
  assert.equal(H.ojCombineSums([{ sign: 1, sum: s(1, 1, 1) }, { sign: 1, sum: null }]), null);
  assert.equal(H.ojCombineSums([{ sign: 1, sum: s(1, 1, 1) }, { sign: -1, sum: s(1, 2, 1) }]), null);   // count 음수
  assert.equal(H.ojCombineSums([{ sign: 1, sum: s(1, 1, 1) }, { sign: -1, sum: s(5, 1, 1) }]), null);   // gold 음수
  assert.equal(H.ojCombineSums([]), null);
  assert.equal(H.ojCombineSums(null), null);
  assert.equal(H.ojCombineSums([{ sign: 2, sum: s(1, 1, 1) }]), null);
  assert.equal(H.ojCombineSums([{ sign: 1, sum: s(NaN, 1, 1) }]), null);
});

test('표시 형식 — 순금 소수 4자리, 금액 콤마', () => {
  assert.equal(H.ojFmtGold(89689), '8.9689');
  assert.equal(H.ojFmtGold(115000), '11.5000');
  assert.equal(H.ojFmtGold(3), '0.0003');
  assert.equal(H.ojFmtGold(0), '0.0000');
  assert.equal(H.ojFmtInt(8805400), '8,805,400');
  assert.equal(H.ojFmtInt(999), '999');
  assert.equal(H.ojFmtInt(1000), '1,000');
});

test('의도 적용 — 서버 select 값이 빈 값(\'\')일 때만 적용, 다른 값이면 그 항목 해제', () => {
  assert.deepEqual(H.ojIntentApply({ k: '', shop: '' }, KS), KS);
  assert.deepEqual(H.ojIntentApply({ k: '', shop: 'GE' }, KS), K);        // 매장을 직접 골라 검색 → 매장 의도만 해제
  assert.deepEqual(H.ojIntentApply({ k: '1', shop: '' }, KS), S);
  assert.equal(H.ojIntentApply({ k: '1', shop: 'GE' }, KS), null);
  assert.equal(H.ojIntentApply({ k: '', shop: '' }, null), null);
  assert.equal(H.ojIntentApply({ k: '', shop: '' }, { k: null, shop: null }), null);
  assert.equal(H.ojIntentApply({}, KS), null);                             // select 를 못 찾으면(undefined) 적용 안 함
  assert.equal(H.ojIntentApply(null, KS), null);
});

test('합계 조회 계획 — K 집합 × (전체 − LT)', () => {
  assert.deepEqual(H.ojSumPlan(KS, { k: '', shop: '' }), [
    { k: '3', shop: '', sign: 1 }, { k: '3', shop: 'LT', sign: -1 },
    { k: '2', shop: '', sign: 1 }, { k: '2', shop: 'LT', sign: -1 }
  ]);
  assert.deepEqual(H.ojSumPlan(K, { k: '', shop: 'GE' }), [
    { k: '3', shop: 'GE', sign: 1 }, { k: '2', shop: 'GE', sign: 1 }
  ]);
  assert.deepEqual(H.ojSumPlan(S, { k: '1', shop: '' }), [
    { k: '1', shop: '', sign: 1 }, { k: '1', shop: 'LT', sign: -1 }
  ]);
});

// ── 배선(정적) ──────────────────────────────────────────────────────────
const BLOCK = SRC.slice(SRC.indexOf("const OJ_KEY = "), SRC.indexOf('  function init() {'));

test('★배선 — 필터 초기화는 isOrderJunList 게이트·최상위 프레임 가드 안에 있고 init() 이 부른다', () => {
  const fn = extractFn(SRC, 'initOrderVFilter');
  assert.ok(/isOrderJunList\(\)/.test(fn), 'isOrderJunList 게이트 없음');
  assert.ok(fn.indexOf('isOrderJunList()') < fn.indexOf('ojApply('), '게이트가 적용 호출보다 뒤');
  assert.ok(/window\s*!==\s*window\.top/.test(fn), 'iframe 가드 없음');
  assert.ok(/state\.ubSkin/.test(fn), 'ubSkin 게이트 없음');
  assert.ok(/ojIntentApply\(/.test(fn) && /ojLoadIntent\(\)/.test(fn), '의도 판정 호출 누락');
  const init = extractFn(SRC, 'init');
  assert.ok(/initOrderVFilter\(\)/.test(init), 'init() 이 initOrderVFilter 를 부르지 않음');
});

test('★배선 — 검색 제출을 가로채지 않는다 + 읽기 조회 말고는 부르지 않는다', () => {
  assert.ok(BLOCK.length > 1000, '블록 추출 실패');
  assert.ok(!/addEventListener\(\s*['"]submit/.test(BLOCK), 'submit 리스너');
  assert.ok(!/\.submit\s*\(/.test(BLOCK), 'form.submit 호출');
  assert.ok(!/onsubmit|preventDefault|stopPropagation/i.test(BLOCK), '제출/이벤트 가로채기');
  assert.ok(!/orderItem(Standby|PopCurrentSetting|Modify|Delete|Cancel)/i.test(BLOCK), '쓰기 URL');
  assert.equal((BLOCK.match(/fetch\(|postDoc\(/g) || []).length, 1, '네트워크 호출은 ojReadSum 의 postDoc 한 곳뿐');
  assert.ok(/postDoc\(EP_LIST_PATH \+ '\?tcode=order_item'/.test(BLOCK));
});

test('★배선 — 조건 밖 행은 숨김이 아니라 제거(전체 체크가 엉뚱한 행에 안 가게)', () => {
  const fn = extractFn(SRC, 'ojApply');
  assert.ok(/tr\.remove\(\)/.test(fn), 'DOM 제거 없음');
  assert.ok(!/display\s*=\s*['"]none|style\.display|hidden/.test(fn), '숨김 방식 금지');
});
