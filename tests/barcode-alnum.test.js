/* =============================================================================
 *  barcode-alnum.test.js — 바코드 입력칸은 숫자·영문만 받는다(사장님 지시 2026-08-31).
 *
 *  skin.js 는 content script IIFE 라 require 할 수 없다.
 *  → 소스에서 DOM·chrome 비의존 함수 선언만 이름으로 추출해 샌드박스에서 평가한다.
 *    추출 실패(리네임/시그니처 변경) 시 즉시 죽으므로 조용한 드리프트가 안 생긴다.
 *
 *  대상 ①: 확장 사이드바 4칸(재고화·출고취소·회전입고·메인석)
 *  대상 ②: 유비샵 페이지 **자체**의 바코드 입력칸("바코드를 입력하는 모든 유비샵 입력 칸")
 *
 *  한글 IME 가 켜진 채 스캐너가 쏘면 영문 자리가 자모로 들어온다(`24027U` → `24027ㅕ`).
 *  숫자는 IME 와 무관하게 들어오므로 **말없이 털면 `24027` 로 짧아진 값이 조회되고 화면은
 *  깔끔해 보여** 원인을 못 본다. 그래서 실행 관문(bcRead)은 지워진 게 있으면 조회를 멈춘다.
 *  단 **여백만 사라진 것은 조용히 통과**시킨다(붙여넣기 공백 자동 제거가 지시사항).
 *
 *  ⚠ 순수함수가 통과해도 **배선이 없으면 화면에서는 아무 일도 안 일어난다.** 그래서 Task 7 로
 *   배선·읽기 경로·길이 가드를 소스에서 직접 못 박는다.
 *  ⚠ 이 파일에는 **보이지 않는 문자를 직접 쓰지 마라.** 전부 \uXXXX 이스케이프로 쓴다
 *   (에디터·도구가 조용히 망가뜨린다). Task 7 이 skin.js 에 대해 그걸 검사한다.
 *
 *  실행: node tests/barcode-alnum.test.js
 * ========================================================================== */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'skin.js'), 'utf8');

// function NAME( ... ) { ... } 를 중괄호 균형으로 잘라낸다.
function extractFn(src, name) {
  const kw = src.indexOf('function ' + name + '(');
  assert.ok(kw >= 0, `skin.js 에서 ${name} 선언을 찾지 못했습니다 (리네임 여부 확인)`);
  const start = (src.slice(kw - 6, kw) === 'async ') ? kw - 6 : kw;
  const open = src.indexOf('{', kw);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 본문의 중괄호 균형을 찾지 못했습니다`);
}

const NAMES = ['bcAlnum', 'bcLostVisible', 'bindBcInput', 'bindSidebarBcInput', 'bcRead',
               'pageBcInputs', 'bindPageBcInputs'];
//  bindSidebarBcInput 이 쓰는 문구 상수도 같이 넣는다(함수만 잘라내면 ReferenceError 가 난다).
const MSG_SRC = SRC.match(/const BC_IME_MSG = '([^']*)';/);
assert.ok(MSG_SRC, 'skin.js 에서 BC_IME_MSG 를 찾지 못했습니다');
assert.ok(/한\/영/.test(MSG_SRC[1]), 'BC_IME_MSG 가 원인(한/영)을 지목하지 않습니다: ' + MSG_SRC[1]);
const SANDBOX = MSG_SRC[0] + '\n' + NAMES.map((nm) => extractFn(SRC, nm)).join('\n');

// pageBcInputs·bindPageBcInputs 는 document·findLabeledInput·state 를 쓴다. 주입해 격리 평가한다.
function makeApi(env) {
  const e = env || {};
  // eslint-disable-next-line no-new-func
  return new Function('document', 'findLabeledInput', 'state',
    SANDBOX + '\nreturn { ' + NAMES.join(', ') + ' };'
  )(e.document || { querySelectorAll: () => [] }, e.findLabeledInput || (() => null), e.state || {});
}
const API = makeApi();
const bcAlnum = API.bcAlnum;
const bindBcInput = API.bindBcInput;
const bcRead = API.bcRead;
const bcLostVisible = API.bcLostVisible;
const bindSidebarBcInput = API.bindSidebarBcInput;

const NBSP = '\u00A0', ZWSP = '\u200B', ZWJ = '\u200D', WJ = '\u2060', BOM = '\uFEFF', FULL = '\u3000';
//  ⚠ '여백'을 목록으로 세면 계속 샌다 — 아래는 검수에서 실제로 새어 나온 것들이다(2026-08-31).
const INVISIBLE = ['\u200B', '\u200C', '\u200D', '\u200E', '\u200F', '\u2060', '\uFEFF',
                   '\u00AD', '\u034F', '\u061C', '\u180E', '\u2066', '\u00A0', '\u3000', ' ', '\t',
                   //  ⚠ 한글 필러 — `\\p{L}` 이지만 화면엔 빈칸이다. 한국어 페이지에서 복사하면 딸려온다.
                   '\u3164', '\u115F', '\u1160', '\uFFA0'];

/* --------------------------------------------------------------------------
 *  가짜 입력칸 — value/캐럿/dataset/리스너만 흉내낸다.
 * ------------------------------------------------------------------------ */
function makeInput(v, attrs) {
  const a = Object.assign({ type: 'text', name: '', id: '', disabled: false, readOnly: false }, attrs || {});
  const init = (v == null ? '' : String(v));
  const el = {
    tagName: 'INPUT',
    value: init,
    selectionStart: init.length,
    dataset: {},
    disabled: a.disabled,
    readOnly: a.readOnly,
    _h: {},
    getAttribute(n2) { return a[n2] == null ? null : a[n2]; },
    srCalls: 0,
    setSelectionRange(x) { el.selectionStart = x; el.srCalls++; },
    addEventListener(t, fn) { (el._h[t] = el._h[t] || []).push(fn); },
    listeners(t) { return (el._h[t] || []).length; },
    fire(t, ev) { (el._h[t] || []).forEach((fn) => fn(ev || {})); }
  };
  return el;
}

let n = 0;
const ok = (m) => { n++; console.log('  OK ' + m); };

/* ==========================================================================
 *  Task 1 — bcAlnum: 영숫자만 남는다
 * ========================================================================== */
console.log('Task 1 — bcAlnum');
assert.strictEqual(bcAlnum('24027ㅕ'), '24027');      // IME 켜진 채 스캔한 실제 모양(24027ㅕ)
assert.strictEqual(bcAlnum('2112BJ'), '2112BJ');          // 정상 바코드는 그대로
assert.strictEqual(bcAlnum('2606wh'), '2606wh');          // 대소문자는 안 건드린다(하류가 대문자화)
assert.strictEqual(bcAlnum(' 2606 WH '), '2606WH');       // 붙여넣기 여백 제거
assert.strictEqual(bcAlnum('21-12_BJ'), '2112BJ');        // 기호 제거
assert.strictEqual(bcAlnum('가나다'), '');    // 한글만 오면 빈 값
assert.strictEqual(bcAlnum('2112\tBJ\n'), '2112BJ');      // 탭·개행(스캐너 접미문자) 제거
assert.strictEqual(bcAlnum(NBSP + '2112BJ' + FULL), '2112BJ');   // NBSP·전각공백
assert.strictEqual(bcAlnum('2112BJ' + ZWSP + ZWJ), '2112BJ');    // 제로폭(눈에 안 보인다)
assert.strictEqual(bcAlnum(BOM + '2112' + WJ + 'BJ'), '2112BJ'); // BOM · WORD JOINER
assert.strictEqual(bcAlnum(null), '');
assert.strictEqual(bcAlnum(undefined), '');
assert.strictEqual(bcAlnum(24027), '24027');              // 숫자로 들어와도 죽지 않는다
ok('영숫자만 남기고 한글·여백·제로폭·기호·개행을 턴다');

//  bcLostVisible — "지워진 것이 사람이 의도한 글자였나". 목록으로 여백을 세는 대신 이걸 본다.
INVISIBLE.forEach((c) => assert.strictEqual(bcLostVisible(c + '2112BJ' + c), false,
  '비가시 문자를 보이는 글자로 잘못 봤다: U+' + c.codePointAt(0).toString(16).toUpperCase()));
[['24027ㅕ', '한글'], ['21-12BJ', '하이픈'], ['2112BJ%', '기호(Po)'],
 ['２１１２BJ', '전각 숫자'], ['2112BJ+', '수학기호(Sm)'], ['2112BJ₩', '통화기호(Sc)'],
 ['2112BJ^', '변형기호(Sk)'], ['2112BJ©', '기타기호(So)']]
  .forEach(([raw, what]) => assert.strictEqual(bcLostVisible(raw), true, what + '을 놓쳤다'));
assert.strictEqual(bcLostVisible('2112BJ'), false, '깨끗한 값인데 지워졌다고 봤다');
assert.strictEqual(bcLostVisible(null), false);
ok('bcLostVisible: 비가시 문자는 조용히, 보이는 글자가 지워진 것만 신호');

/* ==========================================================================
 *  Task 2 — bindBcInput: 조합 중에는 안 건드리고, 끝난 뒤 턴다
 * ========================================================================== */
console.log('Task 2 — bindBcInput');
{
  const el = makeInput('');
  bindBcInput(el);

  // 조합 중(isComposing)에 손대면 IME 상태가 깨진다 → 값을 그대로 둬야 한다.
  el.value = '24027ㅕ';
  el.fire('input', { isComposing: true });
  assert.strictEqual(el.value, '24027ㅕ', '조합 중에 value 를 건드렸다');

  // 조합이 끝나면 턴다.
  el.fire('compositionend', {});
  assert.strictEqual(el.value, '24027', 'compositionend 후에도 한글이 남았다');

  // 조합이 아닌 입력(붙여넣기·직접 타이핑)은 즉시 턴다.
  el.value = '21 12-BJ';
  el.selectionStart = el.value.length;
  el.fire('input', { isComposing: false });
  assert.strictEqual(el.value, '2112BJ');

  // isComposing 이 아예 없는 이벤트도 조합 아님으로 본다.
  el.value = '@@2606WH';
  el.selectionStart = el.value.length;
  el.fire('input', {});
  assert.strictEqual(el.value, '2606WH');
}
ok('조합 중에는 두고, compositionend·일반 input 에서 턴다');

/* ==========================================================================
 *  Task 3 — 캐럿 보정: 앞에서 지워진 만큼만 당긴다
 * ========================================================================== */
console.log('Task 3 — 캐럿 보정');
{
  const el = makeInput('');
  bindBcInput(el);

  // 'ab한cd' 에서 캐럿이 'c' 뒤(4). 앞에서 1자가 사라지므로 'abcd' 의 3 이어야 한다.
  el.value = 'ab한cd';
  el.selectionStart = 4;
  el.fire('input', { isComposing: false });
  assert.strictEqual(el.value, 'abcd');
  assert.strictEqual(el.selectionStart, 3, '캐럿이 제자리가 아니다');

  // 캐럿 뒤에서만 지워지면 캐럿은 그대로.
  el.value = 'ab한cd';
  el.selectionStart = 2;
  el.fire('input', { isComposing: false });
  assert.strictEqual(el.selectionStart, 2);

  // selectionStart 를 못 읽는 경우(null)엔 **맨 뒤**로 보낸다.
  //  ⚠ `>= 0` 만 보면 널 가드를 지워도 통과한다 — 가드가 없으면 캐럿이 0(맨 앞)으로 떨어지는데
  //   0 도 `>= 0` 이다. 검수에서 실제로 그 변이가 살아남았다(2026-08-31). 위치를 못 박는다.
  el.value = '한글' + '2112';   // 6자 중 한글 2자 제거 → '2112' 이므로 캐럿은 끝인 4
  el.selectionStart = null;
  el.fire('input', { isComposing: false });
  assert.strictEqual(el.value, '2112');
  assert.strictEqual(el.selectionStart, 4, '널 가드가 빠지면 캐럿이 맨 앞으로 간다');

  //  캐럿이 **0**(맨 앞)일 때. ⚠ 널 가드를 `el.selectionStart || v.length` 로 쓰면 0 이 falsy 라
  //   맨 뒤로 튄다 — 검수에서 그 변이가 살아남았다(2026-08-31).
  el.value = '한글abc';
  el.selectionStart = 0;
  el.fire('input', { isComposing: false });
  assert.strictEqual(el.value, 'abc');
  assert.strictEqual(el.selectionStart, 0, '캐럿 0 이 맨 뒤로 튀었다');

  // 이미 깨끗하면 아무것도 안 한다 — ⚠ 캐럿 '값' 만 보면 뚫린다(가드를 빼도 같은 위치가 된다).
  //  그래서 setSelectionRange 가 **아예 안 불렸는지**를 센다(검수 지적 2026-08-31).
  el.value = '2112BJ';
  el.selectionStart = 2;
  const before = el.srCalls;
  el.fire('input', { isComposing: false });
  assert.strictEqual(el.selectionStart, 2);
  assert.strictEqual(el.srCalls, before, '깨끗한 값인데 캐럿을 건드렸다');
}
ok('지워진 글자 수만큼만 캐럿을 당기고, 깨끗하면 손대지 않는다');

/* ==========================================================================
 *  Task 4 — 중복 배선 방지 · 게이트
 *   페이지 칸은 사이드바와 달리 같은 노드가 계속 살아 있고 applyAll 이 여러 번 불린다.
 * ========================================================================== */
console.log('Task 4 — 중복 배선 방지 · 게이트');
{
  const el = makeInput('');
  bindBcInput(el);
  bindBcInput(el);
  bindBcInput(el);
  assert.strictEqual(el.listeners('input'), 1, 'input 리스너가 겹쳐 붙었다');
  assert.strictEqual(el.listeners('compositionend'), 1, 'compositionend 리스너가 겹쳐 붙었다');
  assert.strictEqual(el.dataset.ubBcBound, '1', '배선 표식이 없다');

  el.value = '2112ㅂJ';
  el.selectionStart = el.value.length;
  el.fire('input', { isComposing: false });
  assert.strictEqual(el.value, '2112J', '표식이 붙은 뒤 필터가 안 돈다');

  // 게이트는 **리스너 안에서 매번** 봐야 한다 — 배선은 한 번뿐인데 스킨은 나중에 꺼질 수 있다.
  let on = true;
  const g = makeInput('');
  bindBcInput(g, () => on);
  g.value = '21-12BJ';
  g.selectionStart = g.value.length;
  g.fire('input', { isComposing: false });
  assert.strictEqual(g.value, '2112BJ', '게이트가 열려 있는데 필터가 안 돌았다');

  on = false;                       // 배선 뒤에 껐다
  g.value = '21-12BJ';
  g.selectionStart = g.value.length;
  g.fire('input', { isComposing: false });
  assert.strictEqual(g.value, '21-12BJ', '게이트를 닫았는데도 값을 고쳤다');
  g.fire('compositionend', {});
  assert.strictEqual(g.value, '21-12BJ', 'compositionend 경로가 게이트를 무시했다');
}
ok('리스너는 한 벌만 · 게이트는 배선 시점이 아니라 실행 시점에 본다');

/* ==========================================================================
 *  Task 4.5 — 사이드바 칸은 **털린 그 순간** 원인을 알려야 한다
 *   한/영이 한글이면 compositionend 에서 값이 이미 털려서 bcRead 까지 갈 때는
 *   '깨끗한 5자' 다. 그러면 사용자가 보는 건 '6자리를 입력하세요' 뿐이고
 *   원인은 어디에도 안 뜼다(검수 재현 2026-08-31).
 * ========================================================================== */
console.log('Task 4.5 — 사이드바 즉시 안내');
{
  const el = makeInput('');
  const msgs = [];
  bindSidebarBcInput(el, (t, k) => msgs.push([t, k]));

  // 조합이 끝나면서 한글이 털린다 → **바로** 원인을 알려야 한다.
  el.value = '24027ㅕ';
  el.fire('compositionend', {});
  assert.strictEqual(el.value, '24027');
  assert.strictEqual(msgs.length, 1, '털렸는데 상태줄에 아무 것도 안 떴다');
  assert.strictEqual(msgs[0][1], 'warn');
  assert.ok(/한\/영|한글/.test(msgs[0][0]), '원인(한/영)을 지목하지 않는다: ' + msgs[0][0]);

  // 여백만 털린 건 알리지 않는다.
  el.value = ' 2112BJ ';
  el.selectionStart = el.value.length;
  el.fire('input', { isComposing: false });
  assert.strictEqual(el.value, '2112BJ');
  assert.strictEqual(msgs.length, 1, '여백 제거에 경고를 떴다');

  // 🔴 알리는 것만으로는 부족하다 — 사용자가 Enter 를 다시 누르면 그때 값은 이미 '깨끗한 5자'라
  //  bcRead 가 통과시키고, 6자리 가드가 상태줄을 '바코드 6자리를 입력하세요' 로 **덮어써서**
  //  원인을 오지목했다(검수 재현 2026-08-31). 표식이 남아 있는 동안은 조회를 막아야 한다.
  const after = [];
  el.value = '24027ㅕ';
  el.fire('compositionend', {});          // 다시 털린다 → 표식 ON
  assert.strictEqual(el.value, '24027');
  assert.strictEqual(bcRead(el, (t, k) => after.push([t, k])), null,
    '털린 뒤인데 깨끗해 보인다고 조회를 통과시켰다 — 6자리 메시지가 원인을 덮는다');
  assert.ok(/한\/영|한글/.test(after[0][0]), '원인을 지목하지 않는다: ' + after[0][0]);

  // 값을 제대로 다시 넣으면 표식이 풀려 조회가 통과해야 한다.
  el.value = '24027U';
  el.selectionStart = el.value.length;
  el.fire('input', { isComposing: false });
  assert.strictEqual(bcRead(el, () => {}), '24027U', '제대로 다시 넣었는데도 계속 막힌다');

  // setStatus 가 없어도 죽지 않는다.
  const bare = makeInput('24027ㅕ');
  bindSidebarBcInput(bare, null);
  bare.fire('compositionend', {});
  assert.strictEqual(bare.value, '24027');
}
ok('사이드바도 털린 즉시 한/영을 지목한다(bcRead 까지 기다리지 않는다)');

/* ==========================================================================
 *  Task 5 — bcRead: 실행 직전 관문
 * ========================================================================== */
console.log('Task 5 — bcRead');
{
  // 깨끗하면 그대로 통과시킨다(경고도 없다).
  const clean = makeInput('2112BJ');
  const quiet = [];
  assert.strictEqual(bcRead(clean, (t, k) => quiet.push([t, k])), '2112BJ');
  assert.deepStrictEqual(quiet, [], '깨끗한 값에 경고를 띄웠다');

  // 여백만 사라진 것은 **조용히** 통과한다 — 붙여넣기 공백 자동 제거는 지시사항이다.
  //  ⚠ 제로폭 문자(ZWSP·ZWJ·WJ·BOM)도 여백으로 친다. JS 의 \s 는 그걸 못 잡아서, 안 챙기면
  //   눈에 보이지도 않는 글자 하나 때문에 "한글·기호가 섞였다"는 엉뚱한 경고가 뜬다.
  INVISIBLE.map((c) => c + '2112BJ' + c)
    .concat([' \t2112BJ ', NBSP + '2112BJ' + FULL, BOM + '2112' + WJ + 'BJ'])
    .forEach((raw) => {
      const el = makeInput(raw);
      const msg = [];
      assert.strictEqual(bcRead(el, (t, k) => msg.push([t, k])), '2112BJ',
        '여백만 있는데 막았다: ' + JSON.stringify(raw));
      assert.strictEqual(el.value, '2112BJ', '입력칸의 여백이 안 지워졌다: ' + JSON.stringify(raw));
      assert.deepStrictEqual(msg, [], '여백 제거에 경고를 띄웠다: ' + JSON.stringify(raw));
    });

  // Enter 로 조합이 확정될 때 compositionend/keydown 순서는 브라우저·IME 마다 다르다.
  //  그래서 여기까지 한글이 살아 오는 경로가 있는데, **말없이 털면 안 된다** —
  //  `24027ㅕ` → `24027` 로 짧아진 값이 조회되고 화면엔 깔끔한 숫자만 남아 원인을 못 본다.
  const dirty = makeInput('24027ㅕ');
  const msgs = [];
  assert.strictEqual(bcRead(dirty, (t, k) => msgs.push([t, k])), null, '잘린 값을 조회로 넘겼다');
  assert.strictEqual(dirty.value, '24027', '입력칸에 영숫자 외가 남았다');
  assert.strictEqual(msgs.length, 1, '원인을 알리는 경고가 없다');
  assert.strictEqual(msgs[0][1], 'warn');
  assert.ok(/한\/영|한글/.test(msgs[0][0]), '경고가 원인(한/영 키)을 지목하지 않는다: ' + msgs[0][0]);

  // 기호가 섞인 것도 막는다(여백과 달리 글자가 사라진 것이다).
  assert.strictEqual(bcRead(makeInput('21-12BJ'), () => {}), null);

  // setStatus 를 안 넘겨도 죽지 않고, 판정(null)은 같아야 한다.
  assert.strictEqual(bcRead(makeInput('24027ㅕ')), null);
  assert.strictEqual(bcRead(null), '', 'null 엘리먼트에서 죽으면 안 된다');
  assert.strictEqual(bcRead(undefined), '');
}
ok('여백·제로폭은 조용히 털고, 글자가 지워졌으면 조회를 멈추고 원인을 지목한다');

/* ==========================================================================
 *  Task 6 — 유비샵 페이지 자체 입력칸 고르기 · 배선
 *   🔴 hidden·checkbox 를 물면 안 된다. 특히 idx 는 쉼표로 이어진 다중 값이라
 *     거기서 쉼표를 털면 제출이 통째로 깨진다.
 * ========================================================================== */
console.log('Task 6 — 페이지 입력칸 선별 · 배선');
{
  //  ⚠ 스텁이 셀렉터를 무시하면 **셀렉터가 어떻게 바뀌어도 게이트가 green** 이다(검수 지적
  //   2026-08-31: `name*="bar"` 로 넓혀도, `input[name="__nope__"]` 로 기능을 죽여도 통과했다).
  //   그래서 여기서는 실제 셀렉터의 부분일치 문자열을 읽어 흉내낸다.
  const docOf = (list) => ({
    querySelectorAll: (sel) => {
      const subs = [...String(sel).matchAll(/\[(name|id)\*="([^"]+)"\s*i\]/g)]
        .map((m) => [m[1], m[2]]);
      assert.ok(subs.length > 0, '셀렉터에서 name/id 부분일치를 읽지 못했습니다: ' + sel);
      return list.filter((e) => subs.some(([attr, needle]) =>
        String(e.getAttribute(attr) || '').toLowerCase().includes(needle.toLowerCase())));
    }
  });

  const byName = makeInput('', { name: 'searchBarcode' });
  const byId = makeInput('', { id: 'barcodeInput', type: null });
  const decoy = makeInput('', { name: 'barPrefix' });     // 셀렉터를 'bar' 로 넓히면 이게 잡힌다
  const search = makeInput('', { name: 'barcodeSearch', type: 'search' });
  const hidden = makeInput('', { name: 'barcode', type: 'hidden' });
  const check = makeInput('', { name: 'idx_barcode', type: 'checkbox' });
  //  ⚠ 화이트리스트를 블랙리스트로 뒤집으면 이런 타입이 통과한다(검수 지적 2026-08-31).
  const pw = makeInput('', { name: 'barcodePw', type: 'password' });
  const num = makeInput('', { name: 'barcodeNo', type: 'number' });
  const ro = makeInput('', { name: 'barcode', readOnly: true });
  const dis = makeInput('', { name: 'barcode', disabled: true });
  const notInput = { tagName: 'TEXTAREA', getAttribute: () => null };

  const all = [byName, byId, search, decoy, hidden, check, ro, dis, notInput, pw, num];

  //  🔴 라벨 폴백은 **쓰면 안 된다.** findLabeledInput 은 라벨 텍스트 뒤의 '첫 편집 가능한 input'
  //   을 거리 검사 없이 돌려주므로, `<th>바코드</th>` 헤더나 readOnly 바코드칸이 있는 화면에서
  //   고객명 같은 한글 칸을 물어 **한글 입력을 지운다**(검수 재현 2026-08-31).
  //   호출되면 즉시 죽게 해서, 되살아나면 이 테스트가 알려주게 한다.
  let labelCalls = 0;
  const api = makeApi({
    document: docOf(all),
    findLabeledInput: (labels) => { labelCalls++; return makeInput('', { name: 'custName' }); },
    state: { ubSkin: true }
  });

  const picked = api.pageBcInputs();
  assert.strictEqual(labelCalls, 0,
    'pageBcInputs 가 라벨 폴백을 썼습니다 — 바코드와 무관한 한글 칸을 물어 글자를 지웁니다');
  assert.ok(picked.includes(byName), 'name 으로 찾는 바코드칸을 놓쳤다');
  assert.ok(picked.includes(byId), 'id 로만 식별되는 바코드칸을 놓쳤다');
  assert.ok(picked.includes(search), 'type="search" 칸을 놓쳤다');
  assert.ok(!picked.includes(pw), 'password 를 물었다 — 화이트리스트가 블랙리스트로 뒤집혔다');
  assert.ok(!picked.includes(num), 'number 를 물었다 — 화이트리스트가 블랙리스트로 뒤집혔다');
  assert.ok(!picked.includes(decoy), '셀렉터가 너무 넓다 — barPrefix 같은 무관한 칸을 물었다');
  assert.ok(!picked.includes(hidden), 'hidden 을 물었다 — 폼 상태가 깨진다');
  assert.ok(!picked.includes(check), 'checkbox 를 물었다 — idx 쉼표 값이 깨진다');
  assert.ok(!picked.includes(ro), 'readOnly 를 물었다');
  assert.ok(!picked.includes(dis), 'disabled 를 물었다');
  assert.ok(!picked.includes(notInput), 'INPUT 이 아닌 것을 물었다');
  assert.strictEqual(picked.length, 3, '고른 개수가 예상과 다르다: ' + picked.length);

  // 같은 노드가 name·id 양쪽으로 걸려도 한 번만.
  const both = makeInput('', { name: 'barcode', id: 'barcodeX' });
  assert.strictEqual(makeApi({ document: docOf([both]), state: { ubSkin: true } })
    .pageBcInputs().length, 1, '같은 노드가 중복으로 들어갔다');

  // 스킨이 꺼져 있으면 애초에 배선하지 않는다.
  const offEl = makeInput('', { name: 'barcode' });
  makeApi({ document: docOf([offEl]), state: { ubSkin: false } }).bindPageBcInputs();
  assert.strictEqual(offEl.listeners('input'), 0, '스킨 OFF 인데 페이지 칸을 건드렸다');

  // 켠 상태로 배선한 뒤 **나중에 끄면** 개입이 멈춰야 한다(리스너는 남아 있다).
  const st = { ubSkin: true };
  const onEl = makeInput('', { name: 'barcode' });
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a);
  try {
    makeApi({ document: docOf([onEl]), state: st }).bindPageBcInputs();
    assert.strictEqual(onEl.listeners('input'), 1, '스킨 ON 인데 페이지 칸을 안 걸었다');

    onEl.value = '2606ㅈH';
    onEl.selectionStart = onEl.value.length;
    onEl.fire('input', { isComposing: false });
    assert.strictEqual(onEl.value, '2606H', '페이지 칸에서 필터가 안 돈다');
    // 상태줄이 없는 자리라도 **말없이 지우면 안 된다** — title·콘솔에 흔적을 남긴다.
    assert.ok(onEl.title && /한\/영/.test(onEl.title), '페이지 칸에 원인 표시가 없다: ' + onEl.title);
    assert.strictEqual(warns.length, 1, '콘솔 경고가 없다');

    //  여백만 털린 건 알리지 않는다. ⚠ 그리고 **낡은 경고 툴팁을 코드가 지워야 한다** —
    //   여기서 손으로 비우면 '안 지워도 통과' 가 된다(검수 지적 2026-08-31).
    assert.ok(onEl.title, '앞 단계에서 title 이 세워졌어야 한다');
    onEl.value = ' 2606WH ';
    onEl.selectionStart = onEl.value.length;
    onEl.fire('input', { isComposing: false });
    assert.strictEqual(onEl.value, '2606WH');
    assert.strictEqual(onEl.title, '', '값을 바로잡았는데 낡은 경고 툴팁이 남아 있다');
    assert.strictEqual(warns.length, 1, '여백 제거에 콘솔 경고를 냈다');

    //  🔴 **완전히 깨끗한** 값으로 다시 넣어도 낡은 툴팁이 사라져야 한다. scrub 이 c === v 에서
    //   바로 return 하면 notify 가 안 불려 툴팁이 영영 남았다(검수 재현 2026-08-31).
    onEl.value = '2606ㅈH';
    onEl.selectionStart = onEl.value.length;
    onEl.fire('input', { isComposing: false });
    assert.ok(onEl.title, '경고가 세워졌어야 한다');
    onEl.value = '2606WH';                  // 여백조차 없는 정상 값
    onEl.selectionStart = onEl.value.length;
    onEl.fire('input', { isComposing: false });
    assert.strictEqual(onEl.title, '',
      '깨끗한 값을 다시 넣었는데 낡은 경고 툴팁이 남아 있다');

    st.ubSkin = false;                       // 배선 뒤에 스킨을 껐다
    onEl.value = '2606ㅈH';
    onEl.selectionStart = onEl.value.length;
    onEl.fire('input', { isComposing: false });
    assert.strictEqual(onEl.value, '2606ㅈH', '스킨을 껐는데도 페이지 값을 계속 고친다');
  } finally {
    console.warn = origWarn;
  }

  // document 접근이 통째로 터져도 죽지 않는다(팝업·iframe 에서 실제로 생긴다).
  const boomApi = makeApi({
    document: { querySelectorAll: () => { throw new Error('boom'); } },
    state: { ubSkin: true }
  });
  assert.deepStrictEqual(boomApi.pageBcInputs(), []);
  boomApi.bindPageBcInputs();
}
ok('name/id 로만 선별(라벨 폴백 금지) · hidden 제외 · 지운 흔적 남김 · 스킨 OFF 시 중단');

/* ==========================================================================
 *  Task 7 — 배선 회귀 가드 (소스 대조)
 *   순수함수만 통과하고 배선이 빠지면 화면에서는 아무 일도 안 일어난다.
 * ========================================================================== */
console.log('Task 7 — 배선');
{
  // (1) 사이드바 바코드 입력칸 네 개가 모두 같은 클래스를 달아야 일괄 배선이 전부를 덮는다.
  //  ⚠ 총 개수만 세면 뚫린다 — id 하나를 다른 id 로 바꿔치기해도 합계는 그대로다(외부 검수 지적
  //   2026-08-31, 실제로 ub-ms-in→ub-stk-in 변이가 통과했다). 그래서 **id 마다 정확히 1개**를 센다.
  const IDS = ['ub-stk-in', 'ub-dcm-in', 'ub-rot-in', 'ub-ms-in'];
  const inputTags = SRC.match(/<input\b[^>]*>/g) || [];
  //  ⚠ `includes('id="..."')` 는 **`data-id="..."` 에도 걸린다**(검수 지적 2026-08-31).
  //   id 를 data-id 로 바꾸는 변이가 통과하는데, 그러면 querySelector('#ub-stk-in') 가 null 이라
  //   실행 배선이 조용히 끊긴다. 속성 경계(문자열 시작이나 공백 뒤)를 본다.
  const hasAttr = (tag, attr, valRe) =>
    new RegExp('(^|\\s)' + attr + '="' + valRe + '"').test(tag);
  IDS.forEach((id) => {
    const tags = inputTags.filter((t) => hasAttr(t, 'id', id));
    assert.strictEqual(tags.length, 1,
      `바코드 입력칸 id="${id}" 이 정확히 1개가 아닙니다 (${tags.length}개)`);
    assert.ok(/(^|\s)class="[^"]*\bub-stk-in\b/.test(tags[0]),
      `id="${id}" 에 ub-stk-in 클래스가 없습니다 — 일괄 배선에서 빠집니다: ` + tags[0]);
  });
  const allBcClass = inputTags.filter((t) => /(^|\s)class="[^"]*\bub-stk-in\b/.test(t));
  assert.strictEqual(allBcClass.length, IDS.length,
    'ub-stk-in 입력칸 수가 목록과 다릅니다 — 새 바코드 칸이 생겼다면 IDS 에 추가하세요');

  //  🔴 **주석 처리된 줄은 호출이 아니다.** 정규식만 돌리면 `// bindPageBcInputs();` 도 통과한다.
  //   ⚠ 줄 접두(`//`·`*`)만 걷어내는 것으로는 부족했다 — **블록주석**으로 감싸면 안쪽 줄에
  //    `*` 접두가 없어 LIVE 로 남았다(검수 재현 2026-08-31). 블록주석을 먼저 통째로 지운다.
  const NO_BLOCK = SRC.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\r\n]/g, ' '));
  const LIVE_LINES = NO_BLOCK.split(/\r?\n/).filter((ln) => !/^\s*\/\//.test(ln));
  const LIVE = LIVE_LINES.join('\n');
  const liveHas = (re) => LIVE_LINES.some((ln) => re.test(ln));

  //  🔴 `if (false) { ... }` 로 감싸 기능을 통째로 죽여도 소스 대조는 전부 통과했다(검수 재현).
  //   실행 코드에 그런 스위치가 남아 있으면 배포 사고다. 트립와이어로 막는다.
  //  ⚠ 리터럴 false·0 만 보면 `!1`·`void 0`·`null` 로 우회된다(검수 실증). 흔한 형태를 함께 막는다.
   //  그래도 `if (someAlwaysFalseVar)` 같은 적대적 형태는 정적 대조로 못 잡는다 —
   //  그 한계는 원장에 적어 두었고, 아래 T6/T7/T8 처럼 **실수로 나올 수 있는 편집**을 우선 막는다.
  assert.ok(!/if\s*\(\s*(false|0|!1|void 0|null|undefined|0\s*>\s*1)\s*\)/.test(LIVE),
    'skin.js 실행 코드에 항상 거짓인 if 스위치가 있습니다 — 기능이 꺼진 채 배포됩니다');

  // (2) 사이드바 배선은 아래 GOS 루프에서 칸마다 확인한다(상태줄과 짝이어야 하므로).
  //  배선이 renderSidebar **본문 안**에 있어야 실제로 돈다. 주석·블록주석은 걷어낸 뒤에 본다.
  const SB_BODY = extractFn(NO_BLOCK, 'renderSidebar')
    .split(/\r?\n/).filter((ln) => !/^\s*\/\//.test(ln)).join('\n');

  // (3) 페이지 칸 배선 — applyAll 이 부르고, 게이트를 리스너에 넘겨야 한다.
  const aaStart = LIVE.indexOf('function applyAll()');
  assert.ok(aaStart >= 0, 'applyAll 를 찾지 못했습니다');
  const aaBody = LIVE.slice(aaStart, LIVE.indexOf('\n  }', aaStart));
  assert.ok(aaBody.split('\n').some((ln) => /^\s*bindPageBcInputs\(\);/.test(ln)),
    'applyAll 에서 bindPageBcInputs 를 부르지 않습니다 — 페이지 칸이 필터 밖입니다');
  const pgBind = LIVE.match(/pageBcInputs\(\)\.forEach\([^\n]*\)/);
  assert.ok(pgBind, '페이지 칸 일괄 배선을 찾지 못했습니다(주석 처리된 것은 배선이 아닙니다)');
  assert.ok(/bindBcInput\(\s*el\s*,/.test(pgBind[0]),
    '페이지 칸 배선이 gate 를 넘기지 않습니다: ' + pgBind[0]);
  assert.ok(/ubSkin/.test(pgBind[0]),
    '페이지 칸 gate 가 스킨 상태를 보지 않습니다: ' + pgBind[0]);
  assert.ok(liveHas(/^\s*if \(gate && !gate\(\)\) return;/),
    'scrub 안에 gate 검사가 살아 있지 않습니다 — 스킨을 꺼도 개입이 계속됩니다');
  //  늦게 그려지는 칸(팝업·부분 렌더)을 잡는 재시도. 지워도 조용히 통과하던 자리다.
  //  ⚠ 문자열 존재만 보면 `[150,450,900]` 을 `[]` 로 비워도 통과했다(검수 실증). 실제 값을 센다.
  const retry = LIVE.match(/\[([\d,\s]*)\]\.forEach\(ms => setTimeout\(bindPageBcInputs, ms\)\)/);
  assert.ok(retry, '늦게 그려지는 페이지 칸을 잡는 재시도가 없습니다');
  const delays = retry[1].split(',').map((x) => x.trim()).filter(Boolean).map(Number);
  assert.ok(delays.length >= 3 && delays.every((d) => d > 0),
    `재시도 시점이 부족합니다(${JSON.stringify(delays)}) — 늦게 그려지는 칸을 놓칩니다`);

  //  재시도보다 더 늦게 그려지는 칸은 MutationObserver 가 잡는다.
  //  ⚠ `needBc = true;` 존재만 보면 셀렉터를 엉뚱한 것으로 바꿔도 통과했다(검수 실증).
  //   옵저버 셀렉터가 pageBcInputs 의 것과 **같은지**까지 본다.
  const pageSel = extractFn(SRC, 'pageBcInputs').match(/querySelectorAll\('([^']+)'\)/);
  assert.ok(pageSel, 'pageBcInputs 의 셀렉터를 찾지 못했습니다');
  const obsLines = LIVE_LINES.filter((ln) => /needBc = true;/.test(ln));
  assert.strictEqual(obsLines.length, 2,
    'MutationObserver 가 새 바코드 칸을 감지하지 않습니다(matches·querySelector 두 줄이어야 합니다)');
  obsLines.forEach((ln) => {
    const m = ln.match(/\('([^']+)'\)/);
    assert.ok(m, '옵저버 감지 줄에서 셀렉터를 못 읽었습니다: ' + ln);
    assert.strictEqual(m[1], pageSel[1],
      '옵저버 셀렉터가 pageBcInputs 와 다릅니다: ' + m[1] + ' vs ' + pageSel[1]);
  });
  assert.ok(liveHas(/if \(needBc\) bindPageBcInputs\(\);/),
    '옵저버가 감지만 하고 재배선하지 않습니다');
  //  🔴 라벨 폴백은 되살아나면 안 된다 — 바코드와 무관한 한글 칸을 물어 글자를 지운다.
  const pgFn = extractFn(SRC, 'pageBcInputs');
  assert.ok(!/findLabeledInput/.test(pgFn),
    'pageBcInputs 에 라벨 폴백이 되살아났습니다 — 무관한 한글 칸을 물 수 있습니다');

  // (4) 실행 직전 읽기가 네 곳 모두 bcRead 를 타야 한다.
  //  ⚠ 'bcRead(' 만 보면 뚫린다 — `bcRead()` 로 인자를 빼도 통과하는데, 그러면 늘 빈 바코드로
  //   조회돼 기능이 통째로 죽는다(외부 검수 지적 2026-08-31, 변이 통과 확인).
  const GOS = [
    ['goStk', 'run', 'stkIn', 'ub-stk-in', 'setStkStatus'],
    ['goDcm', 'dcmRun', 'dcmIn', 'ub-dcm-in', 'setDcmStatus'],
    ['goRot', 'rotateRun', 'rotIn', 'ub-rot-in', 'setRotStatus'],
    ['goMs', 'msRun', 'msIn', 'ub-ms-in', 'setMsStatus']
  ];
  GOS.forEach((row) => {
    const go = row[0], runner = row[1], inp = row[2], id = row[3], setter = row[4];
    //  칸마다 **상태줄과 짝지어** 배선돼야 한다. 안 그러면 털려도 원인이 안 뜬다.
    //  ⚠ 파일 어디서든 찾으면 뚫린다 — 배선 4줄을 **호출되지 않는 함수로 옮겨도** 통과했다
    //   (검수 실증 2026-08-31). renderSidebar 본문 안에 있는지까지 본다.
    assert.ok(new RegExp('\\n\\s*bindSidebarBcInput\\(' + inp + ', ' + setter + '\\);').test(SB_BODY),
      `renderSidebar 안에 bindSidebarBcInput(${inp}, ${setter}) 배선이 없습니다 — 털려도 원인이 안 뜹니다`);
    const re = new RegExp('const\\s+' + go + '\\s*=\\s*\\(\\)\\s*=>\\s*\\{([^\\n]*)\\};');
    const m = LIVE.match(re);   // 주석 처리된 선언은 선언이 아니다
    assert.ok(m, `${go} 선언을 찾지 못했습니다`);
    const body = m[1];
    //  ⚠ 쉼표까지만 보면 `bcRead(stkIn, null)` 도 통과하는데, 그러면 **아무 메시지도 안 뜬다**
    //   (검수 재현 2026-08-31). 2번째 인자가 그 칸의 상태 setter 인지까지 못 박는다.
    assert.ok(new RegExp('bcRead\\(\\s*' + inp + '\\s*,\\s*' + setter + '\\s*\\)').test(body),
      `${go} 가 bcRead(${inp}, ${setter}) 를 타지 않습니다: ${m[0]}`);
    assert.ok(/if\s*\(\s*bc\s*!==\s*null\s*\)/.test(body),
      `${go} 에 '지워졌으면 조회 안 함' 가드가 없습니다: ${m[0]}`);
    assert.ok(new RegExp(runner + '\\(\\s*bc\\s*[,)]').test(body),
      `${go} 가 ${runner}(bc …) 를 호출하지 않습니다: ${m[0]}`);
    assert.ok(!/In\.value/.test(body), `${go} 가 아직 .value 를 직접 읽습니다: ${m[0]}`);

    const dre = new RegExp('const\\s+' + inp + '\\s*=\\s*bar\\.querySelector\\([\'"]#([\\w-]+)[\'"]\\)');
    const dm = LIVE.match(dre);
    assert.ok(dm, `${inp} 선언(bar.querySelector)을 찾지 못했습니다`);
    assert.strictEqual(dm[1], id, `${inp} 이 #${id} 가 아니라 #${dm[1]} 을 가리킵니다`);
  });

  // (5) 네 runner 모두 6자리 형식 가드를 가져야 한다(사장님 확인: 바코드는 항상 6자리).
  //  잘린 값이 조회로 새는 마지막 구멍을 막는 자리다. rotateRun 은 원래부터 갖고 있었다.
  //  ⚠ 문자열 존재만 보면 뚫린다 — `return;` 만 흘리면 경고만 띄우고 **그대로 조회로 진행**하는데
  //   테스트는 통과했다(검수 재현 2026-08-31). 가드 블록 안에 return 이 있는지까지 본다.
  //  ⚠ 가드가 **어디에 있는지**도 중요하다 — 첫 await(서버 조회) 뒤로 옮기면 잘린 바코드로
  //   요청이 먼저 나가는데 문자열 대조는 통과했다(검수 실증 2026-08-31).
  ['run', 'dcmRun', 'msRun', 'rotateRun'].forEach((fn) => {
    const fnBody = extractFn(SRC, fn);
    const gi = fnBody.indexOf('barcode.length !== 6');
    const ai = fnBody.indexOf('await ');
    assert.ok(gi >= 0, `${fn} 에 6자리 가드가 없습니다`);
    assert.ok(ai < 0 || gi < ai,
      `${fn} 의 6자리 가드가 첫 await 뒤에 있습니다 — 잘린 바코드로 서버 요청이 먼저 나갑니다`);
    const guard = fnBody.match(/if \(barcode\.length !== 6\) \{([^\n]*)\}/);
    assert.ok(guard, `${fn} 의 6자리 가드 블록을 읽지 못했습니다`);
    assert.ok(/\breturn;/.test(guard[1]),
      `${fn} 의 6자리 가드에 return 이 없습니다 — 경고만 하고 조회로 진행합니다: ${guard[0]}`);
  });

  // (6) 소스에 보이지 않는 문자가 섞이면 안 된다 — 눈으로 못 잡고 도구가 조용히 망가뜨린다.
  const invisible = SRC.match(/[\u200B-\u200F\u2060\uFEFF\u00AD]/g) || [];
  assert.strictEqual(invisible.length, 0,
    'skin.js 에 보이지 않는 문자가 들어갔습니다(\\uXXXX 이스케이프로 쓰세요): ' +
    JSON.stringify(invisible.slice(0, 5)));
}
ok('사이드바·페이지 배선 · bcRead 읽기 · 6자리 가드 · 보이지 않는 문자 0');

console.log('\nbarcode-alnum: ' + n + ' tasks OK');
