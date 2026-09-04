/* =============================================================================
 *  factory-live-search.test.js — 매입처 목록 실시간 검색 순수 헬퍼 테스트.
 *
 *  skin.js 는 content script IIFE 라 require 할 수 없다 → 소스에서 DOM 비의존 함수
 *  선언만 이름으로 추출해 평가한다(리네임되면 즉시 죽어 조용한 드리프트가 안 생긴다).
 *  factory-tabpref.test.js 와 같은 방식.
 *
 *  실행: node tests/factory-live-search.test.js
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

// FACTORY_LIST_PAGES 는 소스의 것을 그대로 쓴다 — 경로 오타가 테스트에 걸리도록.
const FLP = SRC.match(/const\s+FACTORY_LIST_PAGES\s*=\s*\{[\s\S]*?\n\s*\};/);
assert.ok(FLP, 'skin.js 에서 FACTORY_LIST_PAGES 를 찾지 못했습니다');

const NAMES = ['factoryListCfg', 'flNorm', 'flHit', 'flPartialJamo', 'flFixedHdrVisible'];
const sandbox = {};
// eslint-disable-next-line no-new-func
new Function('exports',
  FLP[0] + '\n' +
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => `exports.${n} = ${n};`).join('\n') + '\nexports.FACTORY_LIST_PAGES = FACTORY_LIST_PAGES;'
)(sandbox);
const { factoryListCfg, flNorm, flHit, flPartialJamo, flFixedHdrVisible, FACTORY_LIST_PAGES } = sandbox;

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

console.log('factoryListCfg — 대상 화면 인식');
t('두 매입처 목록 경로를 인식', () => {
  assert.strictEqual(factoryListCfg('/basic/factory/factoryList.do'), FACTORY_LIST_PAGES['/basic/factory/factoryList.do']);
  assert.strictEqual(factoryListCfg('/info/factory/infoFactoryList.do'), FACTORY_LIST_PAGES['/info/factory/infoFactoryList.do']);
});
t('무관한 경로는 null', () => {
  assert.strictEqual(factoryListCfg('/main.do'), null);
  assert.strictEqual(factoryListCfg('/basic/factory/factoryList.do.bak'), null);   // 부분일치 금지
  assert.strictEqual(factoryListCfg('/basic/factory/'), null);
});
t('빈/null 입력은 null', () => {
  assert.strictEqual(factoryListCfg(''), null);
  assert.strictEqual(factoryListCfg(null), null);
  assert.strictEqual(factoryListCfg(undefined), null);
});

console.log('flNorm — 소문자화 + 모든 공백 제거');
t('"MS골드 (금매입)" → "ms골드(금매입)"', () => {
  assert.strictEqual(flNorm('MS골드 (금매입)'), 'ms골드(금매입)');
});
t('공백·탭·줄바꿈 전부 제거', () => {
  assert.strictEqual(flNorm('  세 이  (F)\n\t'), '세이(f)');
});
t('null/undefined → 빈 문자열', () => {
  assert.strictEqual(flNorm(null), '');
  assert.strictEqual(flNorm(undefined), '');
});

console.log('flHit — 부분일치 판정(인자는 둘 다 flNorm 된 값)');
t('"세" 가 "세이(f)" 에 걸린다', () => {
  assert.strictEqual(flHit(flNorm('세이(F)'), flNorm('세')), true);
});
t('"00347" 이 코드로 걸린다', () => {
  assert.strictEqual(flHit(flNorm('00347'), flNorm('00347')), true);
  assert.strictEqual(flHit(flNorm('금화도금'), flNorm('00347')), false);
});
t('"ms골드" 가 "MS골드(금매입/시세)" 에 걸린다', () => {
  assert.strictEqual(flHit(flNorm('MS골드(금매입/시세)'), flNorm('ms골드')), true);
});
t('안 맞는 건 false', () => {
  assert.strictEqual(flHit(flNorm('세이(F)'), flNorm('xxx')), false);
  assert.strictEqual(flHit('', flNorm('세')), false);
});
t('빈 쿼리는 false(전부 매칭 방지)', () => {
  assert.strictEqual(flHit('아무거나', ''), false);
});

console.log('flPartialJamo — 미완성 자모 판정');
t('"ㅅ" 은 true', () => {
  assert.strictEqual(flPartialJamo('ㅅ'), true);
});
t('"세" 는 false(완성된 음절)', () => {
  assert.strictEqual(flPartialJamo('세'), false);
});
t('빈 문자열은 false', () => {
  assert.strictEqual(flPartialJamo(''), false);
});
t('"세ㅇ" 은 true(마지막 글자가 자모)', () => {
  assert.strictEqual(flPartialJamo('세ㅇ'), true);
});
t('null/undefined 는 false', () => {
  assert.strictEqual(flPartialJamo(null), false);
  assert.strictEqual(flPartialJamo(undefined), false);
});

console.log('FACTORY_LIST_PAGES — 컬럼 인덱스 실측값 대조');
t('A(factoryList): name=3, code=1', () => {
  const a = FACTORY_LIST_PAGES['/basic/factory/factoryList.do'];
  assert.ok(a, 'A 화면 설정 없음');
  assert.strictEqual(a.nameCol, 3);
  assert.strictEqual(a.codeCol, 1);
});
t('B(infoFactoryList): name=1, code=1(한 칸에 둘 다)', () => {
  const b = FACTORY_LIST_PAGES['/info/factory/infoFactoryList.do'];
  assert.ok(b, 'B 화면 설정 없음');
  assert.strictEqual(b.nameCol, 1);
  assert.strictEqual(b.codeCol, 1);
});

console.log('flFixedHdrVisible — position:fixed 헤더 복제본 표시 판정');
t('표가 위로 스크롤되고 데이터가 있으면 표시', () => {
  assert.strictEqual(flFixedHdrVisible(-100, 500, 40, true), true);
});
t('tableTop >= 0 이면 미표시(아직 안 내려감)', () => {
  assert.strictEqual(flFixedHdrVisible(0, 500, 40, true), false);
  assert.strictEqual(flFixedHdrVisible(50, 500, 40, true), false);
});
t('tableBottom <= hdrH + 40 이면 미표시(표가 거의 다 지나감)', () => {
  assert.strictEqual(flFixedHdrVisible(-500, 70, 40, true), false);   // 70 <= 40+40
  assert.strictEqual(flFixedHdrVisible(-500, 79, 40, true), false);  // 79 <= 80
});
t('데이터가 없으면 미표시', () => {
  assert.strictEqual(flFixedHdrVisible(-100, 500, 40, false), false);
  assert.strictEqual(flFixedHdrVisible(-100, 500, 40, null), false);
  assert.strictEqual(flFixedHdrVisible(-100, 500, 40, undefined), false);
});
t('경계값 — tableBottom 이 hdrH+40 보다 클 때 표시', () => {
  assert.strictEqual(flFixedHdrVisible(-100, 81, 40, true), true);   // 81 > 80
  assert.strictEqual(flFixedHdrVisible(-100, 80, 40, true), false);  // 80 = 80 (not >)
});
t('hdrH 가 0 이어도 판정 가능', () => {
  assert.strictEqual(flFixedHdrVisible(-1, 41, 0, true), true);
  assert.strictEqual(flFixedHdrVisible(-1, 40, 0, true), false);
});


// ── 배선 테스트(wiring) — 소스 대조로 회귀를 잡는다. 주석을 걷어낸 뒤에 평가한다. ──
//  ★주석 처리된 줄도 통과한 전례가 있으므로 반드시 주석 제거 후 대조한다.
function stripComments(src) {
  // 🔴 예전 휴리스틱("// 앞에 따옴표가 있으면 그 줄을 통째로 보존")은 뚫린다 —
  //   `const _dead = ''; // if (!state.ubSkin) return;` 가 그대로 남아 정규식이
  //   **주석 텍스트**에 매치되고, 런타임 게이트는 사라진 채 통과했다(검수 2R F2 실증).
  //   그래서 줄 안에서 문자열 상태를 실제로 추적해 **주석 위치에서 자른다**.
  //   ⚠ 줄 단위로 도는 이유: 파일 전체를 한 번에 훑으면 정규식 리터럴(`/^\/jun\//`)의
  //     `\//` 를 주석 시작으로 오인해 그 뒤가 통째로 날아간다. 줄 단위면 피해가 그 줄에 갇힌다.
  let inBlock = false;
  return src.split(/\r?\n/).map(line => {
    let out = '';
    let q = 0;   // 0=코드 1=' 2=" 3=`
    for (let i = 0; i < line.length; i++) {
      const c = line[i], d = line[i + 1];
      if (inBlock) { if (c === '*' && d === '/') { inBlock = false; i++; } continue; }
      if (q === 0) {
        if (c === '/' && d === '/') break;                 // 주석 시작 → 줄 나머지 버림
        if (c === '/' && d === '*') { inBlock = true; i++; continue; }
        if (c === "'") q = 1; else if (c === '"') q = 2; else if (c === '`') q = 3;
        out += c;
        continue;
      }
      if (c === '\\') { out += c + (d || ''); i++; continue; }   // 이스케이프는 통째로
      if ((q === 1 && c === "'") || (q === 2 && c === '"') || (q === 3 && c === '`')) q = 0;
      out += c;
    }
    return out;
  }).join('\n');
}
const SRC_NAKED = stripComments(SRC);

function findFnBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' 선언을 찾지 못했습니다');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(name + ' 본문 끝을 찾지 못했습니다');
}

console.log('배선 테스트 — init() 본문에 initFactoryLiveSearch 가 autoFocusByPage 뒤에 온다');
t('init() 본문에 initFactoryLiveSearch() 호출이 존재', () => {
  const initBody = findFnBody(SRC_NAKED, 'init');
  assert.ok(/initFactoryLiveSearch\(\)/.test(initBody), 'init() 에서 initFactoryLiveSearch() 호출을 찾지 못했습니다');
});
t('initFactoryLiveSearch() 가 autoFocusByPage() 뒤에 온다', () => {
  const initBody = findFnBody(SRC_NAKED, 'init');
  const afIdx = initBody.indexOf('autoFocusByPage()');
  const flIdx = initBody.indexOf('initFactoryLiveSearch()');
  assert.ok(afIdx >= 0, 'autoFocusByPage() 를 찾지 못했습니다');
  assert.ok(flIdx >= 0, 'initFactoryLiveSearch() 를 찾지 못했습니다');
  assert.ok(flIdx > afIdx, 'initFactoryLiveSearch() 가 autoFocusByPage() 뒤에 있어야 합니다');
});

console.log('배선 테스트 — AUTO_FOCUS_PAGES 기존 3화면 라벨 배열 고정');
t('AUTO_FOCUS_PAGES 3화면 값이 정확히 고객명/매입처명,매입처/입고장번호', () => {
  const afp = SRC_NAKED.match(/const\s+AUTO_FOCUS_PAGES\s*=\s*\{[\s\S]*?\n\s*\};/);
  assert.ok(afp, 'AUTO_FOCUS_PAGES 를 찾지 못했습니다');
  const block = afp[0];
  // 각 화면의 배열 값이 정확히 일치하는지 확인 — eval 로 안전하게 평가(구조만).
  const evalBlock = block.replace('AUTO_FOCUS_PAGES', 'AUTO_FOCUS_PAGES_LOCAL');
  const sb2 = {};
  new Function('exports', evalBlock + '\nexports.AUTO_FOCUS_PAGES = AUTO_FOCUS_PAGES_LOCAL;')(sb2);
  const A = sb2.AUTO_FOCUS_PAGES;
  assert.deepStrictEqual(A['/jun/orderitem/orderItemList.do'], ['고객명']);
  assert.deepStrictEqual(A['/jun/baljuitem/baljuItemJunList.do'], ['매입처명', '매입처']);
  assert.deepStrictEqual(A['/jun/inputitem/inputItemJunList.do'], ['입고장번호']);
});
t('autoFocusByPage 분기 — 배열 입력이면 labels === cfg 가 된다', () => {
  const fnBody = findFnBody(SRC_NAKED, 'autoFocusByPage');
  // 분기 소스 추출: const isObj = ...; const labels = isObj ? ... : cfg;
  assert.ok(/const\s+isObj\s*=\s*!Array\.isArray\(cfg\)/.test(fnBody), 'isObj 판정을 찾지 못했습니다');
  assert.ok(/const\s+labels\s*=\s*isObj\s*\?/.test(fnBody), 'labels 삼항식을 찾지 못했습니다');
  // labels = isObj ? (cfg.labels || []) : cfg  — 배열이면 cfg 그대로.
  const sb3 = {};
  new Function('exports',
    'var Array = Array; var location = { pathname: "/x" };' +
    'function findLabeledInput() { return null; } function attachImeIndicator() {} function focusableInputs() { return []; }' +
    'var state = { ubSkin: true };' +
    fnBody + '\nexports.autoFocusByPage = autoFocusByPage;'
  )(sb3);
  // 함수가 문법적으로 평가되면 됨 — labels === cfg 검증은 소스 분석으로.
  // cfg 가 배열일 때 labels === cfg 가 되는지 정적 확인.
  const labelsLine = fnBody.match(/const\s+labels\s*=\s*isObj\s*\?\s*\([^)]*\)\s*:\s*(\w+)/);
  assert.ok(labelsLine, 'labels 삼항식의 else 분기를 찾지 못했습니다');
  assert.strictEqual(labelsLine[1], 'cfg', '배열이면 labels = cfg 여야 합니다(현재: ' + labelsLine[1] + ')');
});

console.log('배선 테스트 — input 이벤트 리스너 배선 존재');
t("initFactoryLiveSearch 에 input.addEventListener('input', ...) 가 존재", () => {
  const fnBody = findFnBody(SRC_NAKED, 'initFactoryLiveSearch');
  assert.ok(/input\.addEventListener\('input'[^)]*\)\s*=>\s*flOnInput\(input\)/.test(fnBody), "input.addEventListener('input', () => flOnInput(input)) 를 찾지 못했습니다");
});

console.log('배선 테스트 — flOnInput / flSyncFix 런타임 게이트');
t('flOnInput 진입점에 state.ubSkin 게이트가 존재', () => {
  // 🔴 본문 전체를 보면 안 된다 — 디바운스 콜백 안의 게이트가 대신 매치돼 진입점 게이트를
  //   지우는 변이가 생존한다(실측으로 뚫렸다). setTimeout **앞**만 본다.
  const fnBody = findFnBody(SRC_NAKED, 'flOnInput');
  const st = fnBody.indexOf('setTimeout');
  const head = fnBody.slice(0, st >= 0 ? st : fnBody.length);
  assert.ok(/if\s*\(\s*!state\.ubSkin\s*\)\s*return\s*;/.test(head), 'flOnInput 진입점에 state.ubSkin 게이트가 없습니다');
});
t('flOnInput 디바운스 콜백 안에도 게이트가 존재', () => {
  const fnBody = findFnBody(SRC_NAKED, 'flOnInput');
  const st = fnBody.indexOf('setTimeout');
  assert.ok(st >= 0, 'flOnInput 에서 setTimeout 을 찾지 못했습니다');
  assert.ok(/if\s*\(\s*!state\.ubSkin\s*\)\s*return\s*;/.test(fnBody.slice(st)),
    'flOnInput 디바운스 콜백에 state.ubSkin 게이트가 없습니다');
});
t('flSyncFix 에 state.ubSkin 게이트가 존재', () => {
  const fnBody = findFnBody(SRC_NAKED, 'flSyncFix');
  assert.ok(/if\s*\(\s*!state\.ubSkin\s*\)\s*return\s*;/.test(fnBody), 'flSyncFix 에 state.ubSkin 게이트가 없습니다');
});

console.log('배선 테스트 — 프리페치 불완전 캐시 가드 / 복제본 배제 셀렉터');
t('flPrefetchAll 이 불완전 캐시를 승격시키지 않는다', () => {
  // 검수 지적(Important 2): span 을 못 찾거나 페이지 상한에 걸려 행이 모자라면
  // 그 부분 집합을 '전체'로 신뢰해 검색이 0건을 낸다. 캐시를 아예 만들지 않아야 한다.
  const body = findFnBody(SRC_NAKED, 'flPrefetchAll');
  assert.ok(/allRows\.length\s*<\s*total/.test(body), '불완전 판정(allRows.length < total)이 없습니다');
  const guard = body.slice(body.indexOf('allRows.length < total'));
  assert.ok(/flCache\s*=\s*null/.test(guard), '불완전일 때 flCache = null 로 막지 않습니다');
  assert.ok(/total = -1/.test(body), 'span 미발견 시 total = -1 유지가 없습니다');
});
t('flGetTable 이 고정헤더 복제본을 배제한다', () => {
  // 복제본도 class="t_list" 라 배제하지 않으면 querySelector 후보가 2개가 된다.
  const body = findFnBody(SRC_NAKED, 'flGetTable');
  assert.ok(/:not\(#ub-fl-fixhdr\)/.test(body), 'flGetTable 이 복제본을 배제하지 않습니다');
});

console.log('배선 테스트 — applyAll() 에 applyFactoryLiveSearch() 호출 존재');
t('applyAll() 본문에 applyFactoryLiveSearch() 호출이 존재', () => {
  const fnBody = findFnBody(SRC_NAKED, 'applyAll');
  assert.ok(/applyFactoryLiveSearch\(\)/.test(fnBody), 'applyAll() 에 applyFactoryLiveSearch() 호출이 없습니다');
});

// ── 변이 3종이 각각 죽는지 확인(소스 문자열 치환으로 평가 — 저장소를 더럽히지 않는다) ──
function runWiringChecks(src) {
  const naked = stripComments(src);
  const errors = [];
  // 1. init() 에 initFactoryLiveSearch() 가 autoFocusByPage() 뒤에
  const initBody = findFnBody(naked, 'init');
  const afIdx = initBody.indexOf('autoFocusByPage()');
  const flIdx = initBody.indexOf('initFactoryLiveSearch()');
  if (afIdx < 0 || flIdx < 0 || flIdx <= afIdx) errors.push('init() 순서 위반');
  // 2. autoFocusByPage labels = isObj ? ... : cfg
  const afBody = findFnBody(naked, 'autoFocusByPage');
  if (!/const\s+labels\s*=\s*isObj\s*\?/.test(afBody)) errors.push('labels 삼항식 없음');
  // 3. input.addEventListener('input' 배선 + flOnInput(input) 호출
  const initfl = findFnBody(naked, 'initFactoryLiveSearch');
  if (!/input\.addEventListener\('input'[^)]*\)\s*=>\s*flOnInput\(input\)/.test(initfl)) errors.push('input 리스너 배선 없음');
  // 4. flOnInput 진입점 게이트
  //  🔴 본문 전체를 훑으면 안 된다 — 디바운스 콜백 안의 게이트(검사 7)가 대신 매치돼
  //    진입점 게이트를 지우는 변이가 생존한다(실측으로 뚫렸다). setTimeout **앞**만 본다.
  const onBody = findFnBody(naked, 'flOnInput');
  const onHead = onBody.slice(0, onBody.indexOf('setTimeout') >= 0 ? onBody.indexOf('setTimeout') : onBody.length);
  if (!/if\s*\(\s*!state\.ubSkin\s*\)\s*return\s*;/.test(onHead)) errors.push('flOnInput 진입점 게이트 없음');
  // 5. applyAll 에 applyFactoryLiveSearch
  const aaBody = findFnBody(naked, 'applyAll');
  if (!/applyFactoryLiveSearch\(\)/.test(aaBody)) errors.push('applyAll applyFactoryLiveSearch 없음');
  // 6. 리스너 중복 배선 방지 가드 — 게이트를 ON→OFF→ON 반복하면 applyFactoryLiveSearch 가
  //    initFactoryLiveSearch 를 다시 부른다. 이 가드가 없으면 input 리스너가 토글 횟수만큼 쌓인다.
  //    ⚠ `if (input.dataset.ubFlBound) return;` 와 표식 세팅이 **둘 다** 있어야 한다 —
  //      조건만 두고 세팅을 빼면 가드가 영원히 거짓이라 아무것도 막지 못한다.
  if (!/if\s*\(\s*input\.dataset\.ubFlBound\s*\)\s*return/.test(initfl)) errors.push('리스너 중복방지 가드 없음');
  if (!/input\.dataset\.ubFlBound\s*=/.test(initfl)) errors.push('리스너 중복방지 표식 세팅 없음');
  // 7. \uc9c0\uc5f0 \ucf5c\ubc31\uc758 \uac8c\uc774\ud2b8 \u2014 \uc9c4\uc785\uc810\ub9cc \ub9c9\uc73c\uba74 120ms \ub514\ubc14\uc6b4\uc2a4\u00b7\ud504\ub9ac\ud398\uce58 \uc644\ub8cc \uc0ac\uc774\uc5d0
  //    \uc2a4\ud0a8\uc744 \uaebc\ub3c4 \ub4a4\ub2a6\uac8c \ud544\ud130\uac00 \ub2e4\uc2dc \uac78\ub9b0\ub2e4(\uac80\uc218 2\ub77c\uc6b4\ub4dc \uc9c0\uc801).
  const deferBody = initfl;
  const timerBody = onBody.slice(onBody.indexOf('setTimeout'));
  if (!/if\s*\(\s*!state\.ubSkin\s*\)\s*return\s*;/.test(timerBody)) errors.push('\ub514\ubc14\uc6b4\uc2a4 \ucf5c\ubc31 \uac8c\uc774\ud2b8 \uc5c6\uc74c');
  const thenBody = deferBody.slice(deferBody.indexOf('flPrefetchAll('));
  if (!/if\s*\(\s*!state\.ubSkin\s*\)\s*return\s*;/.test(thenBody)) errors.push('\ud504\ub9ac\ud398\uce58 \ucf5c\ubc31 \uac8c\uc774\ud2b8 \uc5c6\uc74c');
  // 8. applyFactoryLiveSearch 본체 — 1R Critical 수정의 본체다.
  //    🔴 "존재하나" 만 보면 안 된다 — 맨 앞에 `if (true) return;` 를 꽂아 **단락**시켜도
  //      나머지 문자열이 그대로 남아 통과한다(검수 2R 이 실증). 첫 문장을 고정한다.
  const applyBody = findFnBody(naked, 'applyFactoryLiveSearch');
  //  ⚠ 이 방식의 한계를 알고 써라(검수 3R 이 실증) —
  //    ① 첫 문장은 남기고 **두 번째 문장**에 `if (true) return;` 을 꽂는 변이는 잡지 못한다.
  //       문자열 대조는 존재를 증명할 뿐 **도달성**을 증명하지 못한다. 사고로 나오는 형태가 아니라 감수한다.
  //    ② 중괄호를 Allman 로 내리거나 `if (!state.ubSkin) { return; }` 로 바꾸는 **무해한 리팩터링에
  //       거짓 실패한다.** 나중에 이 함수 스타일을 손보다 테스트가 깨지면 회귀가 아니라 이 고정 방식 탓이다.
  const applyFirst = applyBody.slice(applyBody.indexOf('{') + 1).trim().split('\n')[0].trim();
  if (!/^if\s*\(\s*state\.ubSkin\s*\)\s*\{/.test(applyFirst)) errors.push('applyFactoryLiveSearch 게이트 분기 없음');
  if (!/initFactoryLiveSearch\(\)/.test(applyBody)) errors.push('applyFactoryLiveSearch ON 분기 없음');
  if (!/classList\.remove\(FL_SCOPE_CLASS\)/.test(applyBody)) errors.push('applyFactoryLiveSearch OFF 클래스 제거 없음');
  if (!/flRestore\(\)/.test(applyBody)) errors.push('applyFactoryLiveSearch OFF 복원 없음');
  // 9. initFactoryLiveSearch 의 **첫 문장**이 진입 게이트여야 한다.
  //    ⚠ 뒷부분을 보면 안 된다 — 그 슬라이스엔 게이트가 없으므로 항상 통과한다.
  const initflBody = findFnBody(naked, 'initFactoryLiveSearch');
  const firstStmt = initflBody.slice(initflBody.indexOf('{') + 1).trim().split('\n')[0].trim();
  if (!/^if\s*\(\s*!state\.ubSkin\s*\)\s*return\s*;/.test(firstStmt)) errors.push('initFactoryLiveSearch 진입 게이트 없음');
  // 10. flFilterRows 의 소스 우선순위(캐시 → 스냅샷 → 화면). 캐시 분기를 지우면
  //     '세이'→'세' 단조감소 회귀가 되살아난다.
  const filterBody = findFnBody(naked, 'flFilterRows');
  if (!/flCache && flCache\.rows\.length\) source = flCache\.rows/.test(filterBody)) errors.push('flFilterRows 캐시 우선순위 없음');
  if (!/flRestoreSnapshot && flRestoreSnapshot\.rows\.length\) source = flRestoreSnapshot\.rows/.test(filterBody)) errors.push('flFilterRows 스냅샷 폴백 없음');
  // 11. applyFactoryLiveSearch ON 분기가 flSyncFix() 를 부른다 — 재-ON 시 고정헤더가
  //     OFF 때 박힌 인라인 display:none 에 갇혀 스크롤 전까지 안 보인다(검수 2R F3).
  const onBranch = applyBody.slice(0, applyBody.indexOf('} else {') >= 0 ? applyBody.indexOf('} else {') : applyBody.length);
  if (!/flSyncFix\(\)/.test(onBranch)) errors.push('applyFactoryLiveSearch ON 분기 flSyncFix 없음');
  // 12. 프리페치 루프의 마지막 페이지 판정 — 서버가 reqPage 를 무시/클램프하면 같은 페이지를
  //     최대 10회 이어붙여 중복 캐시를 '전체'로 승격시킨다(검수 2R F4).
  const preBody = findFnBody(naked, 'flPrefetchAll');
  if (!/dataRows\.length < FL_PREFETCH_PAGE_SIZE/.test(preBody)) errors.push('프리페치 마지막 페이지 판정 없음');
  return errors;
}

console.log('배선 테스트 — 실제 소스가 모든 배선 검사를 통과한다');
t('runWiringChecks(SRC) 가 빈 배열', () => {
  // 🔴 이 테스트가 없으면 runWiringChecks 의 검사들이 **변이 테스트 안에서만** 돌고
  //   실제 소스에는 한 번도 적용되지 않는다. 그러면 배선이 실제로 끊겨도 전부 통과한다
  //   (검수 2R 에서 이 구멍으로 변이 3종이 생존했다).
  assert.deepStrictEqual(runWiringChecks(SRC), []);
});

console.log('변이 검증 — 3종이 각각 배선 테스트를 죽인다');
t('변이 ① labels = [] (autoFocusByPage 자동포커스 파괴) → 실패', () => {
  const mutant = SRC.replace(
    /const\s+labels\s*=\s*isObj\s*\?\s*\(cfg\.labels\s*\|\|\s*\[\]\)\s*:\s*cfg/,
    'const labels = [];'
  );
  assert.notStrictEqual(mutant, SRC, '변이 ① 치환이 일어나지 않았습니다');
  const errs = runWiringChecks(mutant);
  assert.ok(errs.some(e => e.includes('labels 삼항식')), '변이 ① 이 labels 삼항식 검증을 죽이지 않았습니다: ' + JSON.stringify(errs));
});
t('변이 ② flOnInput(input) → void 0 (실시간 검색 배선 절단) → 실패', () => {
  const mutant = SRC.replace(
    /input\.addEventListener\('input',\s*\(\)\s*=>\s*flOnInput\(input\)\)/,
    "input.addEventListener('input', () => void 0)"
  );
  assert.notStrictEqual(mutant, SRC, '변이 ② 치환이 일어나지 않았습니다');
  const errs = runWiringChecks(mutant);
  assert.ok(errs.some(e => e.includes('input 리스너 배선')), '변이 ② 가 input 리스너 검증을 죽이지 않았습니다: ' + JSON.stringify(errs));
});
t('변이 ③ init() 의 initFactoryLiveSearch() 삭제 → 실패', () => {
  const mutant = SRC.replace(
    '    initFactoryLiveSearch();   // v3.9.x: 매입처 목록 실시간 검색 + 표 가독성(factoryList/infoFactoryList)',
    '    /* mutation: initFactoryLiveSearch removed */'
  );
  assert.notStrictEqual(mutant, SRC, '변이 ③ 치환이 일어나지 않았습니다');
  const errs = runWiringChecks(mutant);
  assert.ok(errs.some(e => e.includes('init() 순서')), '변이 ③ 이 init() 검증을 죽이지 않았습니다: ' + JSON.stringify(errs));
});

t('\ubcc0\uc774 \u2463 \ub9ac\uc2a4\ub108 \uc911\ubcf5\ubc29\uc9c0 \uac00\ub4dc \ubb34\ub825\ud654 \u2192 \uc2e4\ud328', () => {
  const mutant = SRC.replace(
    'if (input.dataset.ubFlBound) return;',
    'if (false) return;'
  );
  assert.notStrictEqual(mutant, SRC, '\ubcc0\uc774 \u2463 \uce58\ud658\uc774 \uc77c\uc5b4\ub098\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4');
  const errs = runWiringChecks(mutant);
  assert.ok(errs.some(e => e.includes('\uc911\ubcf5\ubc29\uc9c0 \uac00\ub4dc')), '\ubcc0\uc774 \u2463 \uac00 \uac00\ub4dc \uac80\uc99d\uc744 \uc8fd\uc774\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4: ' + JSON.stringify(errs));
});
t('\ubcc0\uc774 \u2464 \uc911\ubcf5\ubc29\uc9c0 \ud45c\uc2dd \uc138\ud305 \uc0ad\uc81c \u2192 \uc2e4\ud328', () => {
  const mutant = SRC.replace("    input.dataset.ubFlBound = '1';\n", '');
  assert.notStrictEqual(mutant, SRC, '\ubcc0\uc774 \u2464 \uce58\ud658\uc774 \uc77c\uc5b4\ub098\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4');
  const errs = runWiringChecks(mutant);
  assert.ok(errs.some(e => e.includes('\ud45c\uc2dd \uc138\ud305')), '\ubcc0\uc774 \u2464 \uac00 \ud45c\uc2dd \uac80\uc99d\uc744 \uc8fd\uc774\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4: ' + JSON.stringify(errs));
});

t('\ubcc0\uc774 \u2465 \ub514\ubc14\uc6b4\uc2a4 \ucf5c\ubc31 \uac8c\uc774\ud2b8 \uc0ad\uc81c \u2192 \uc2e4\ud328', () => {
  const mutant = SRC.replace(
    /flDebounceTimer = setTimeout\(\(\) => \{[\s\S]*?if \(!state\.ubSkin\) return;\n/,
    'flDebounceTimer = setTimeout(() => {\n'
  );
  assert.notStrictEqual(mutant, SRC, '\ubcc0\uc774 \u2465 \uce58\ud658\uc774 \uc77c\uc5b4\ub098\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4');
  const errs = runWiringChecks(mutant);
  assert.ok(errs.some(e => e.includes('\ub514\ubc14\uc6b4\uc2a4 \ucf5c\ubc31')), '\ubcc0\uc774 \u2465 \uac00 \uac80\uc99d\uc744 \uc8fd\uc774\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4: ' + JSON.stringify(errs));
});
t('\ubcc0\uc774 \u2466 \ud504\ub9ac\ud398\uce58 \ucf5c\ubc31 \uac8c\uc774\ud2b8 \uc0ad\uc81c \u2192 \uc2e4\ud328', () => {
  const mutant = SRC.replace(
    /flPrefetchAll\(action\)\.then\(\(\) => \{[\s\S]*?if \(!state\.ubSkin\) return;\n/,
    'flPrefetchAll(action).then(() => {\n'
  );
  assert.notStrictEqual(mutant, SRC, '\ubcc0\uc774 \u2466 \uce58\ud658\uc774 \uc77c\uc5b4\ub098\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4');
  const errs = runWiringChecks(mutant);
  assert.ok(errs.some(e => e.includes('\ud504\ub9ac\ud398\uce58 \ucf5c\ubc31')), '\ubcc0\uc774 \u2466 \uac00 \uac80\uc99d\uc744 \uc8fd\uc774\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4: ' + JSON.stringify(errs));
});

console.log('변이 검증 2R — 검수가 실증한 5종이 각각 죽는다');
t('변이 ⑧ applyFactoryLiveSearch 무력화 → 실패', () => {
  const mutant = SRC.replace('function applyFactoryLiveSearch() {', 'function applyFactoryLiveSearch() {\n    if (true) return;');
  assert.notStrictEqual(mutant, SRC, '변이 ⑧ 치환 실패');
  const errs = runWiringChecks(mutant);
  assert.ok(errs.some(e => e.includes('applyFactoryLiveSearch')), '변이 ⑧ 생존: ' + JSON.stringify(errs));
});
t('변이 ⑨ initFactoryLiveSearch 진입 게이트 삭제 → 실패', () => {
  const mutant = SRC.replace(/(function initFactoryLiveSearch\(\) \{\n)    if \(!state\.ubSkin\) return;\n/, '$1');
  assert.notStrictEqual(mutant, SRC, '변이 ⑨ 치환 실패');
  const errs = runWiringChecks(mutant);
  assert.ok(errs.some(e => e.includes('initFactoryLiveSearch 진입')), '변이 ⑨ 생존: ' + JSON.stringify(errs));
});
t('변이 ⑩ OFF 분기 flRestore 삭제 → 실패', () => {
  const mutant = SRC.replace(/\n      flRestore\(\);[^\n]*\n/, '\n');
  assert.notStrictEqual(mutant, SRC, '변이 ⑩ 치환 실패');
  const errs = runWiringChecks(mutant);
  assert.ok(errs.some(e => e.includes('OFF 복원')), '변이 ⑩ 생존: ' + JSON.stringify(errs));
});
t('변이 ⑪ flFilterRows 캐시 우선순위 파괴 → 실패', () => {
  const mutant = SRC.replace('if (flCache && flCache.rows.length) source = flCache.rows;\n', '');
  assert.notStrictEqual(mutant, SRC, '변이 ⑪ 치환 실패');
  const errs = runWiringChecks(mutant);
  assert.ok(errs.some(e => e.includes('캐시 우선순위')), '변이 ⑪ 생존: ' + JSON.stringify(errs));
});
t('변이 ⑫ 주석 속 decoy 로 stripComments 우회 → 실패', () => {
  // 실 게이트를 지우고 같은 문구를 주석에 남긴다. 스캐너가 아니면 이걸 못 잡는다.
  const mutant = SRC.replace(
    /(      if \(!state\.ubSkin\) return;\n)(      const cur = input\.value)/,
    "      const _dead = ''; // if (!state.ubSkin) return;\n$2"
  );
  assert.notStrictEqual(mutant, SRC, '변이 ⑫ 치환 실패');
  const errs = runWiringChecks(mutant);
  assert.ok(errs.some(e => e.includes('디바운스 콜백')), '변이 ⑫ 생존(주석 우회): ' + JSON.stringify(errs));
});

console.log(`\n${pass} pass`);