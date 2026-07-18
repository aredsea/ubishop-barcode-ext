/* =============================================================================
 *  factory-tabpref.test.js — 매입처 정보창 / 전표 기본탭(v3.7.0) 순수 헬퍼 테스트.
 *
 *  skin.js 는 content script IIFE 라 require 할 수 없다 → 소스에서 DOM 비의존 함수
 *  선언만 이름으로 추출해 평가한다(리네임되면 즉시 죽어 조용한 드리프트가 안 생긴다).
 *
 *  헤더 문자열은 2026-07-19 라이브 실측값이다:
 *    주문전표   '발주처명발주일'      발주장   '매입처코드' / '매입처'
 *    발주내역   '매입처(매장명)'      입고내역 '매입처입고일'
 *    ⚠ '매입처상품코드상품코드/고객명' 은 상품 코드 컬럼이라 반드시 제외돼야 한다.
 *
 *  실행: node tests/factory-tabpref.test.js
 * ========================================================================== */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'skin.js'), 'utf8');

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

// TAB_MENUS 는 실제 소스 것을 그대로 쓴다 — 경로 오타가 테스트에 걸리도록.
const TM = SRC.match(/const\s+TAB_MENUS\s*=\s*\[[\s\S]*?\n\s*\];/);
assert.ok(TM, 'skin.js 에서 TAB_MENUS 를 찾지 못했습니다');

const NAMES = ['isFactoryHeader', 'tabPrefFor', 'isTabPrefPath'];
const sandbox = {};
// eslint-disable-next-line no-new-func
new Function('exports',
  TM[0] + '\n' +
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => `exports.${n} = ${n};`).join('\n') + '\nexports.TAB_MENUS = TAB_MENUS;'
)(sandbox);
const { isFactoryHeader, tabPrefFor, isTabPrefPath, TAB_MENUS } = sandbox;

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

console.log('isFactoryHeader — 매입처명 칸을 찾는 기준');
t('실측 헤더들을 모두 인식', () => {
  ['발주처명발주일', '매입처', '매입처코드', '매입처(매장명)', '매입처입고일']
    .forEach(h => assert.strictEqual(isFactoryHeader(h), true, h));
});
// ★'매입처상품코드'는 상품 코드 컬럼이다. 이걸 매입처명으로 잘못 잡으면 상품코드에
//   링크가 걸리고, 이름 대조도 전부 빗나간다.
t('매입처상품코드는 제외한다', () => {
  assert.strictEqual(isFactoryHeader('매입처상품코드상품코드/고객명'), false);
  assert.strictEqual(isFactoryHeader('매입처상품코드'), false);
});
t('무관한 헤더는 false', () => {
  ['No', '바코드', '상품정보', '매장명(주문직원)', '수량', ''].forEach(h =>
    assert.strictEqual(isFactoryHeader(h), false, h));
  assert.strictEqual(isFactoryHeader(null), false);
});
t('공백·줄바꿈이 섞여도 인식', () => {
  assert.strictEqual(isFactoryHeader(' 발주처명\n발주일 '), true);
});

console.log('tabPrefFor — 전표 기본탭 결정');
t('off 면 손대지 않는다(null)', () => {
  assert.strictEqual(tabPrefFor('input', 'off', 'list', { input: 'list' }), null);
});
t('global 은 전 전표에 같은 값', () => {
  assert.strictEqual(tabPrefFor('input', 'global', 'list', {}), 'list');
  assert.strictEqual(tabPrefFor('deliv', 'global', 'list', {}), 'list');
  assert.strictEqual(tabPrefFor('input', 'global', 'jun', { input: 'list' }), 'jun');   // each 는 무시
});
t('global 값이 이상하면 장으로 안전하게', () => {
  assert.strictEqual(tabPrefFor('input', 'global', undefined, {}), 'jun');
  assert.strictEqual(tabPrefFor('input', 'global', 'xxx', {}), 'jun');
});
t('each 는 전표별로 따로', () => {
  const each = { input: 'list', balju: 'jun' };
  assert.strictEqual(tabPrefFor('input', 'each', 'jun', each), 'list');
  assert.strictEqual(tabPrefFor('balju', 'each', 'list', each), 'jun');
});
// ★each 인데 그 전표를 아직 안 정했으면 null — 서버 기본값(장)을 그대로 두는 게 맞다.
//   여기서 'jun' 을 반환하면 '되돌리기' 경로가 매번 돌아 불필요한 DOM 조작이 생긴다.
t('each 에서 미지정 전표는 null(원본 유지)', () => {
  assert.strictEqual(tabPrefFor('stone', 'each', 'list', { input: 'list' }), null);
  assert.strictEqual(tabPrefFor('stone', 'each', 'list', null), null);
});
t('모르는 모드는 null', () => {
  assert.strictEqual(tabPrefFor('input', 'weird', 'list', {}), null);
});

// 설정 UI 를 어디에 띄울지 — 장/내역 탭이 실제로 있는 전표 화면에서만.
console.log('isTabPrefPath — 설정 UI 노출 화면');
t('5개 전표 × 장/내역 = 10개 경로 전부 인식', () => {
  assert.strictEqual(TAB_MENUS.length, 5);
  TAB_MENUS.forEach(m => {
    assert.strictEqual(isTabPrefPath(m.jun.split('?')[0], TAB_MENUS), true, m.label + ' 장');
    assert.strictEqual(isTabPrefPath(m.list.split('?')[0], TAB_MENUS), true, m.label + ' 내역');
  });
});
t('무관한 화면에서는 안 띄운다', () => {
  ['/jun/orderitem/orderItemList.do',      // 주문전표 — 장/내역 탭이 없다
   '/info/item/infoItemList.do',
   '/basic/factory/factoryList.do',
   '/main.do', '/'].forEach(p =>
    assert.strictEqual(isTabPrefPath(p, TAB_MENUS), false, p));
});
// ★부분일치로 판정하면 엉뚱한 화면에서도 뜬다. 경로 완전일치여야 한다.
t('부분일치로 오탐하지 않는다', () => {
  assert.strictEqual(isTabPrefPath('/jun/inputitem/inputItemJunList.do.bak', TAB_MENUS), false);
  assert.strictEqual(isTabPrefPath('/x/jun/inputitem/inputItemList.do', TAB_MENUS), false);
});
t('빈 입력은 false', () => {
  assert.strictEqual(isTabPrefPath('', TAB_MENUS), false);
  assert.strictEqual(isTabPrefPath(null, TAB_MENUS), false);
  assert.strictEqual(isTabPrefPath('/jun/inputitem/inputItemList.do', null), false);
});

console.log(`\n${pass} pass`);
