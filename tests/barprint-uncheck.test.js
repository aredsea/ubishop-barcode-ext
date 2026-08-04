/* =============================================================================
 *  barprint-uncheck.test.js — 바코드 인쇄 후 선택 자동 해제(content.js) 단위테스트.
 *
 *  content.js 는 content script IIFE 라 require 할 수 없다(skin.js 와 동일 사정).
 *
 *  ⚠ 2026-08-04 공동 검수(Opus 5 + 로컬 Codex CLI)에서 최초 버전의 한계가 지적됐다:
 *   그 버전은 if/else 블록 텍스트만 문자열로 대조해 "호출이 있는가/없는가"만 봤다.
 *   그래서 (1) 호출을 if/else **바깥**(예: catch 앞)에 추가해 항상 실행되게 만들거나,
 *   (2) clearBarPrintSelection 의 셀렉터를 넓혀 무관한 필드까지 지우게 만들어도
 *   문자열 대조로는 안 잡혔다 — 텍스트는 그대로인데 **실제 동작**이 달라지기 때문이다.
 *   → 그래서 이 파일은 sendBarPrintReplacement 를 **실제로 실행**해 검증한다.
 *   최상위 IIFE 전체를 소스에서 추출해 가짜 window/document/alert 위에서 돌리고,
 *   성공/실패/예외 세 경로 각각에서 체크박스의 **진짜 checked 상태**를 확인한다.
 *   이러면 호출이 코드의 어디에 있든, 셀렉터가 어떻게 바뀌든 실행 결과로 잡힌다.
 *
 *  기존의 if/else 소스 대조 단언(더 좁고 빠른 가드)은 중복 가드로 남겨 둔다 —
 *  실행 기반 테스트가 실패했을 때 "if/else 배선 자체가 깨졌는지"를 더 빨리 좁혀준다.
 *
 *  ⚠ 이 파일을 PowerShell 로 편집하지 마라 — Set-Content 가 한글을 깨뜨릴 수 있다.
 *  실행: node tests/barprint-uncheck.test.js
 * ========================================================================== */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8');

// function NAME( ... ) { ... } 를 중괄호 균형으로 잘라낸다(문자열/주석/정규식 안에 중괄호 없음 확인됨).
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `content.js 에서 ${name} 선언을 찾지 못했습니다 (리네임 여부 확인)`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 본문의 중괄호 균형을 찾지 못했습니다`);
}

// openIdx 가 가리키는 '{' 부터 짝이 맞는 '}' 까지(포함) 잘라낸다.
function extractBlock(src, openIdx) {
  assert.strictEqual(src[openIdx], '{', '중괄호 시작 위치가 아닙니다');
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  throw new Error('블록의 중괄호 균형을 찾지 못했습니다');
}

// content.js 맨 앞 최상위 IIFE `(function () { ... })();` 의 본문(중괄호 안쪽)을 통째로 잘라낸다.
// 두 번째(focus-keep) IIFE 는 건드리지 않는다 — indexOf 는 항상 먼저 나오는 자리를 찾는다.
function extractFirstIifeBody(src) {
  const marker = '(function () {';
  const start = src.indexOf(marker);
  assert.ok(start >= 0, 'content.js 에서 최상위 IIFE 시작부를 찾지 못했습니다(포맷 변경 여부 확인)');
  const open = start + marker.length - 1; // marker 마지막 글자가 '{' 이므로 그 위치
  assert.strictEqual(src[open], '{', 'IIFE 시작 중괄호 위치 계산이 어긋났습니다');
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  throw new Error('최상위 IIFE 본문의 중괄호 균형을 찾지 못했습니다');
}

/* ---- 가짜 DOM: name="..." 속성만으로 querySelectorAll 을 흉내낸다 ---- */
function box(name, checked) { return { name, checked: !!checked }; }
function fakeRoot(boxes) {
  return {
    querySelectorAll(sel) {
      const names = [...String(sel).matchAll(/name=["']([^"']+)["']/g)].map(m => m[1]);
      return boxes.filter(b => names.includes(b.name));
    }
  };
}

let pass = 0;
async function t(name, fn) { await fn(); pass++; console.log('  ok  ' + name); }

/* ══════════════════════════════════════════════════════════════════════════
 *  section 1 — clearBarPrintSelection 단독 실행(가장 좁고 빠른 계층)
 * ══════════════════════════════════════════════════════════════════════ */
const section1 = (function () {
  const sandbox = {};
  // eslint-disable-next-line no-new-func
  new Function('exports',
    extractFn(SRC, 'clearBarPrintSelection') + '\n' +
    'exports.clearBarPrintSelection = clearBarPrintSelection;'
  )(sandbox);
  const { clearBarPrintSelection } = sandbox;

  return [
    ['개별 idx 여러 개와 전체선택 all 을 모두 해제한다', () => {
      const boxes = [box('all', true), box('idx', true), box('idx', true), box('idx', false)];
      clearBarPrintSelection(fakeRoot(boxes));
      assert.ok(boxes.every(b => b.checked === false), '해제 대상(idx/all)이 전부 꺼져야 합니다');
    }],
    // M6(셀렉터를 sKey 까지 넓히는 회귀) 감지용 — etc 는 일반 무관 컨트롤, sKey 는 실제 지적된 이름.
    ['무관한 이름(etc, sKey)의 체크박스는 건드리지 않는다', () => {
      const other = box('etc', true), skey = box('sKey', true);
      const boxes = [box('idx', true), other, skey];
      clearBarPrintSelection(fakeRoot(boxes));
      assert.strictEqual(other.checked, true, 'idx/all 이 아닌 체크박스는 그대로여야 합니다');
      assert.strictEqual(skey.checked, true, 'sKey 는 idx/all 이 아니므로 그대로여야 합니다(선택자 확대 감지)');
    }],
    ['체크박스가 하나도 없어도 예외를 던지지 않는다', () => {
      assert.doesNotThrow(() => clearBarPrintSelection(fakeRoot([])));
    }]
  ];
})();

/* ══════════════════════════════════════════════════════════════════════════
 *  section 2 — sendBarPrintReplacement 성공/실패 분기 배선(소스 대조, 중복 가드)
 *  ⚠ 이 대조는 if/else "블록 텍스트 안"만 본다 — 호출이 블록 밖(예: catch 앞)에
 *  추가되는 회귀는 못 잡는다(2026-08-04 Codex 지적). section 3 이 그 구멍을 메운다.
 * ══════════════════════════════════════════════════════════════════════ */
const fnSrc = extractFn(SRC, 'sendBarPrintReplacement');
const IF_MARKER = 'if (!resp || !resp.ok) {';
const ifStart = fnSrc.indexOf(IF_MARKER);
assert.ok(ifStart >= 0, 'sendBarPrintReplacement 에서 성공/실패 분기를 찾지 못했습니다(리팩터 여부 확인)');
const ifOpenIdx = ifStart + IF_MARKER.length - 1; // '{' 위치
const ifBlock = extractBlock(fnSrc, ifOpenIdx);
const afterIf = fnSrc.slice(ifOpenIdx + ifBlock.length);
assert.ok(/^\s*else\s*\{/.test(afterIf), '실패 분기(if) 다음에서 else 를 찾지 못했습니다');
const elseOpenIdx = ifOpenIdx + ifBlock.length + afterIf.indexOf('{');
const elseBlock = extractBlock(fnSrc, elseOpenIdx);

/* ══════════════════════════════════════════════════════════════════════════
 *  section 3 — sendBarPrintReplacement 실제 실행(성공/실패/예외)
 *
 *  window.UBOverlay, window.UBCollector.collect(), window.postMessage 브리지,
 *  alert 를 전부 가짜로 채워 최상위 IIFE 를 통째로 돌린다. 그러면 try/if/else/catch
 *  전체가 실제 실행되므로, 호출이 소스의 어느 위치에 있든(블록 안/밖/catch 안)
 *  DOM 부작용(checked 값)으로 걸러진다.
 * ══════════════════════════════════════════════════════════════════════ */
const IIFE_BODY = extractFirstIifeBody(SRC);

// ub-page → ub-bridge 왕복(localbridge.js 가 실제로 하는 일)을 한 함수로 압축.
// postMessage 를 받으면 큐마이크로태스크로 즉시 응답 이벤트를 리스너에 흘려보낸다.
function makeFakeWindow({ collect, reply }) {
  const listeners = { message: [] };
  const win = {
    UBCollector: { collect },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const arr = listeners[type]; if (!arr) return;
      const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1);
    },
    postMessage(msg) {
      if (!msg || msg.source !== 'ub-page') return;
      queueMicrotask(() => {
        const r = reply(msg) || {};
        const evt = { data: Object.assign({ source: 'ub-bridge', id: msg.id }, r), source: win };
        listeners.message.slice().forEach(fn => fn(evt));
      });
    }
  };
  return win;
}

// content.js 최상위 IIFE 를 가짜 window/document/alert/console 위에서 실제로 실행하고
// window.sendBarPrint(=sendBarPrintReplacement 그 자체)를 돌려준다.
function loadSendBarPrint(win, doc, alertFn) {
  const silentConsole = { log() {}, error() {}, warn() {} };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'alert', 'console', IIFE_BODY)(win, doc, alertFn, silentConsole);
  assert.strictEqual(typeof win.sendBarPrint, 'function',
    'IIFE 실행 후 window.sendBarPrint 가 설정되지 않았습니다');
  return win.sendBarPrint;
}

function sampleItem() {
  return {
    barcode: 'B0001', itemName: '테스트상품', itemNo: 'T-0001', price: 10000,
    metal: '18K', diameter: '', weight: '3.5g', category: '', partner: '',
    setNo: '', store: '', vendor: '', extraDesc: ''
  };
}

// idx 2개 + all 1개(전부 체크 상태) + 무관 컨트롤 2개(etc, sKey — 전부 체크 상태로 시작해
// "그대로 유지"가 의미 있는 단언이 되게 한다. sKey 는 M6(셀렉터 확대)의 실제 지적 사례.
function makeBoxes() {
  return [box('all', true), box('idx', true), box('idx', true), box('etc', true), box('sKey', true)];
}
const byName = (boxes, n) => boxes.filter(b => b.name === n);

const section3 = [
  ['[실제 실행] 성공 응답이면 idx·all 은 해제되고 무관 컨트롤은 그대로다', async () => {
    const boxes = makeBoxes();
    const alerts = [];
    const win = makeFakeWindow({
      collect: async () => [sampleItem()],
      reply: () => ({ ok: true, result: { printed: 1 } })
    });
    const sendBarPrint = loadSendBarPrint(win, fakeRoot(boxes), (m) => alerts.push(m));
    await sendBarPrint();

    assert.ok(byName(boxes, 'idx').every(b => b.checked === false), 'idx 전부 해제되어야 합니다');
    assert.strictEqual(byName(boxes, 'all')[0].checked, false, 'all 이 해제되어야 합니다');
    assert.strictEqual(byName(boxes, 'etc')[0].checked, true, '무관 컨트롤(etc)은 그대로여야 합니다');
    assert.strictEqual(byName(boxes, 'sKey')[0].checked, true, '무관 컨트롤(sKey)은 그대로여야 합니다(선택자 확대 감지)');
    assert.strictEqual(alerts.length, 0, '성공 시에는 alert 가 뜨면 안 됩니다');
  }],
  ['[실제 실행] 실패 응답이면 어느 체크박스도 해제되지 않는다', async () => {
    const boxes = makeBoxes();
    const alerts = [];
    const win = makeFakeWindow({
      collect: async () => [sampleItem()],
      reply: () => ({ ok: false, error: '서버 오류(테스트)' })
    });
    const sendBarPrint = loadSendBarPrint(win, fakeRoot(boxes), (m) => alerts.push(m));
    await sendBarPrint();

    assert.ok(boxes.every(b => b.checked === true), '실패 시 어떤 체크박스도 건드리면 안 됩니다');
    assert.ok(alerts.length >= 1, '실패를 알리는 alert 가 호출되어야 합니다(경로 확인용)');
  }],
  ['[실제 실행] 처리 중 예외가 나도 체크박스를 건드리지 않는다', async () => {
    const boxes = makeBoxes();
    const alerts = [];
    const win = makeFakeWindow({
      collect: async () => { throw new Error('강제 예외(테스트)'); },
      reply: () => ({ ok: true }) // 도달하면 안 됨
    });
    const sendBarPrint = loadSendBarPrint(win, fakeRoot(boxes), (m) => alerts.push(m));
    await sendBarPrint();

    assert.ok(boxes.every(b => b.checked === true), '예외 발생 시 어떤 체크박스도 건드리면 안 됩니다');
    assert.ok(alerts.length >= 1, '예외를 알리는 alert 가 호출되어야 합니다(catch 경로 확인용)');
  }]
];

/* ══════════════════════════════════════════════════════════════════════════
 *  실행
 * ══════════════════════════════════════════════════════════════════════ */
(async () => {
  console.log('clearBarPrintSelection — 단독 실행');
  for (const [name, fn] of section1) await t(name, fn);

  console.log('sendBarPrintReplacement — 성공/실패 분기 배선(소스 대조, 중복 가드)');
  await t('실패 분기(if)는 clearBarPrintSelection 을 호출하지 않는다', () => {
    assert.ok(!ifBlock.includes('clearBarPrintSelection('),
      '실패해도 체크가 풀리면 처음부터 다시 선택해야 하는 부담이 생깁니다');
  });
  await t('성공 분기(else)는 clearBarPrintSelection 을 호출한다', () => {
    assert.ok(elseBlock.includes('clearBarPrintSelection('),
      '인쇄 성공 후 선택 해제 호출을 찾지 못했습니다');
  });

  console.log('sendBarPrintReplacement — 실제 실행(성공/실패/예외)');
  for (const [name, fn] of section3) await t(name, fn);

  console.log(`\n${pass} pass`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
