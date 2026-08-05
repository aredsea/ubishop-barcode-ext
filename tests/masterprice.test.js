/* =============================================================================
 *  masterprice.test.js — 기초상품관리 적용시세 일괄변경(src/masterprice.js) 단위테스트.
 *
 *  masterprice.js 는 content script IIFE 라 require 할 수 없다. 소스에서 DOM 비의존
 *  함수 선언을 이름으로 추출해 새 Function 샌드박스에서 평가한다(orderitem-assign.test.js·
 *  write-journal.test.js 와 같은 방식). 추출 실패(리네임) 시 테스트가 즉시 죽는다.
 *
 *  2026-08-04 3자 검수 재재검수 반영판(G1~G10). processOneItem 이 이제 서버 재조회(G2)까지
 *  하므로 fetch 도 가짜로 주입한다. runBulkUpdate 자체도 window/document/localStorage/fetch
 *  전부 가짜 주입해 "실제 실행"으로 검증한다(정적 패턴 대조는 배선 순서 확인에만 보조로 쓴다).
 *
 *  스펙: docs/superpowers/specs/2026-08-04-barcode-uncheck-and-goldprice-bulk-design.md §2
 *  실행: node tests/masterprice.test.js
 * ========================================================================== */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'masterprice.js'), 'utf8');

function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `masterprice.js 에서 ${name} 선언을 찾지 못했습니다 (리네임 여부 확인)`);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 본문의 중괄호 균형을 찾지 못했습니다`);
}
function extractConstLine(src, name) {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*[^;]+;').exec(src);
  assert.ok(m, `masterprice.js 에서 ${name} 상수를 찾지 못했습니다`);
  return m[0];
}

const ORIG_COL_SRC = SRC.match(/const\s+ORIG_COL\s*=\s*\{[^}]*\}/);
assert.ok(ORIG_COL_SRC, 'masterprice.js 에서 ORIG_COL 상수를 찾지 못했습니다');
// log 는 한 줄 화살표 함수라 extractConstLine 의 `[^;]+;` 로는 중간 세미콜론에서 잘린다.
// 줄 단위로 원본을 그대로 가져온다 — 진단 로그 분기(`if (!upd) log(...)`)를 실제로 실행하는
// 테스트가 있으므로 no-op 스텁으로 대체하지 않는다.
const LOG_SRC = SRC.match(/^[ \t]*const log = .*$/m);
assert.ok(LOG_SRC, 'masterprice.js 에서 log 정의를 찾지 못했습니다');
const CONST_LINES = ['LOG_KEY', 'LOG_CAP', 'SAVE_TIMEOUT_MS', 'MAX_GOLD_PRICE']
  .map(n => extractConstLine(SRC, n)).concat([LOG_SRC[0]]).join('\n');

/* ---- 가짜 localStorage ----
 *  lsThrows: 모든 접근 실패(F1 fail-closed 테스트용).
 *  lsThrowOnNewKey: 기존 키 setItem 은 성공, "새" 키 setItem 만 실패 — quota 총량은 찼지만
 *   기존 키 덮어쓰기는 되는 상황을 흉내(G5 — 손상 로그 백업 실패 테스트 전용).
 *  lsSetItemOkCount: 앞의 N 번 setItem 만 성공하고 그 뒤로는 전부 실패(null=제한 없음).
 *   appendPriceLog(쓰기 1회)는 통과시키고 그 다음 updatePriceLog 만 실패시키는 데 쓴다
 *   (G11 — write-ahead before 스냅샷 기록 실패 테스트 전용).
 * ------------------------------------------------------------------------ */
let lsStore = {};
let lsThrows = false;
let lsThrowOnNewKey = false;
let lsSetItemOkCount = null;
let lsSetItemCalls = 0;
const fakeLocalStorage = {
  getItem(k) {
    if (lsThrows) throw new Error('storage 접근 실패(TEST)');
    return Object.prototype.hasOwnProperty.call(lsStore, k) ? lsStore[k] : null;
  },
  setItem(k, v) {
    if (lsThrows) throw new Error('storage 접근 실패(TEST)');
    if (lsThrowOnNewKey && !Object.prototype.hasOwnProperty.call(lsStore, k)) {
      throw new Error('새 키 저장 실패(TEST — quota 총량 초과 흉내)');
    }
    lsSetItemCalls++;
    if (lsSetItemOkCount != null && lsSetItemCalls > lsSetItemOkCount) {
      throw new Error('setItem 실패(TEST — ' + lsSetItemOkCount + '회 이후 quota 초과 흉내)');
    }
    lsStore[k] = String(v);
  },
  removeItem(k) { delete lsStore[k]; }
};
function resetLS() {
  lsStore = {}; lsThrows = false; lsThrowOnNewKey = false;
  lsSetItemOkCount = null; lsSetItemCalls = 0;
}

/* ---- 가짜 fetch(MAIN 샌드박스용) ----
 *  processOneItem(G2)·decideTrialContinuation 표시용 재조회가 이제 fetch 를 쓴다.
 *  fetchFields 로 응답 HTML 의 5필드 값을 지정, resetFetch()/setServerFields() 로 제어.
 * ------------------------------------------------------------------------ */
function fieldsToHtml(fields) {
  return Object.keys(fields || {}).map((k) => '<input name="' + k + '" value="' + fields[k] + '">').join('');
}
let fetchFields = null;
let fetchShouldFail = false;
let fetchNeverResolves = false;   // F1 — 스톨한 서버 흉내. signal 을 실제로 존중한다.
const fakeFetchMain = async function (url, opts) {
  if (fetchShouldFail) throw new Error('네트워크 실패(TEST)');
  if (fetchNeverResolves) {
    // 진짜 fetch 처럼 abort 신호에만 반응해 AbortError 로 reject 한다. signal 을 무시하면
    // 타임아웃 테스트가 영원히 매달려 "그냥 느린 테스트" 로 위장된다.
    return new Promise((_resolve, reject) => {
      const sig = opts && opts.signal;
      if (!sig) return;
      sig.addEventListener('abort', () => {
        const e = new Error('The operation was aborted.');
        e.name = 'AbortError';
        reject(e);
      });
    });
  }
  return {
    ok: true, headers: { get: () => 'text/html; charset=utf-8' },
    arrayBuffer: async () => new TextEncoder().encode(fieldsToHtml(fetchFields || {})).buffer
  };
};
function setServerFields(fields) { fetchFields = fields; }
function resetFetch() { fetchFields = null; fetchShouldFail = false; fetchNeverResolves = false; }

const MAIN_NAMES = [
  'extractSeq', 'isTargetPage', 'parsePriceInput', 'formatComma', 'splitDualValue',
  'extractInputValue', 'localDecodeBytes', 'decodeResponseBytes',
  'localJudgeSubmitUrl', 'judgeSubmitUrl', 'judgeLandingUrl',
  'validateBulkInput', 'numOrNull', 'validateRecalc', 'serverValueMatches', 'verifyAgainstServer', 'decideTrialContinuation',
  'runSequential', 'augmentMasterTable', 'getSelectedItems',
  'escHtml', 'logFieldDisplay', 'buildLogViewerHtml',
  'modifyFormUrl', 'waitForLoadOrTimeout', 'waitForLoadOrDialog', 'readFormSnapshot', 'refetchFieldsForSeq', 'findSaveButton',
  'processOneItem', 'readPriceLogListOrRecover', 'appendPriceLog', 'updatePriceLog', 'processItemWithLog'
];

const sandboxWindow = {};   // ubErp 없음 → 로컬 폴백 경로(SSOT 위임 자체는 erp-decode.test.js 가 보증)

const sandbox = {};
// eslint-disable-next-line no-new-func
new Function('exports', 'TextDecoder', 'URL', 'window', 'localStorage', 'fetch',
  CONST_LINES + '\n' +
  ORIG_COL_SRC[0] + '\n' +
  MAIN_NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  MAIN_NAMES.map(n => `exports.${n} = ${n};`).join('\n') +
  '\nexports.ORIG_COL = ORIG_COL;'
)(sandbox, TextDecoder, URL, sandboxWindow, fakeLocalStorage, fakeFetchMain);

const {
  extractSeq, isTargetPage, parsePriceInput, formatComma, splitDualValue,
  extractInputValue, localDecodeBytes, decodeResponseBytes,
  localJudgeSubmitUrl, judgeSubmitUrl, judgeLandingUrl,
  validateBulkInput, numOrNull, validateRecalc, serverValueMatches, verifyAgainstServer, decideTrialContinuation,
  runSequential, augmentMasterTable, getSelectedItems,
  escHtml, logFieldDisplay, buildLogViewerHtml, refetchFieldsForSeq, findSaveButton,
  processOneItem, readPriceLogListOrRecover, appendPriceLog, updatePriceLog, processItemWithLog,
  ORIG_COL
} = sandbox;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ==========================================================================
 *  가짜 iframe 하네스 — processOneItem 을 실제 실행 검증하기 위한 최소 iframe/문서/창.
 * ------------------------------------------------------------------------ */
/* 🔴 이 가짜는 실제 DOM 의 두 가지 제약을 **반드시** 재현해야 한다(2026-08-05 라이브 실측으로
 *  확인, seq 7618). 종전 하네스는 저장 버튼을 form.elements 에 그냥 꽂아 넣어서, 실제로는
 *  절대 동작할 수 없는 코드가 4라운드·3인 검수를 통과했다:
 *   ① form.elements 는 <input type="image"> 를 제외한다(HTML 명세). named access 도 같다.
 *   ② 유비샵 마크업에서 저장 버튼은 <form> 의 DOM 자손이 아니다 → form.querySelector 실패.
 *      문서 전체 조회로만 찾히고, 소속은 btn.form 으로만 확인된다.
 *  그래서 form 쪽에는 querySelector 를 아예 두지 않고, 문서 쪽에만 둔다. */
function makeFakeFormDoc(fields, fixFlag) {
  const elements = {};
  Object.keys(fields || {}).forEach((k) => { elements[k] = { value: fields[k] }; });
  if (fixFlag != null) elements['fixPriceFlag'] = { value: String(fixFlag) };   // 실제로는 <select> Y/N
  const form = Object.assign({ elements: elements }, elements);
  const extra = [];   // form.elements 에 안 들어가는 컨트롤(= input[type=image])
  const doc = {
    forms: { form1: form },
    _elements: elements,
    _extra: extra,
    querySelectorAll(sel) {
      const m = /^input\[name="([^"]+)"\]$/.exec(String(sel == null ? '' : sel));
      if (!m) return [];   // 프로덕션이 다른 셀렉터를 쓰면 못 찾는다 — 일부러 그렇게 둔다
      return extra.filter((e) => e.name === m[1]);
    },
    querySelector(sel) { return doc.querySelectorAll(sel)[0] || null; }
  };
  return doc;
}

const GOOD_LANDING = 'https://ubdstore.ubshop.biz/master/item/masterItemModifyForm.do?tcode=master_item&seq=7646';
function badLandingWithMsg(msg) {
  return 'https://ubdstore.ubshop.biz/master/item/masterItemModifyForm.do?tcode=master_item&seq=7646&msg=' + encodeURIComponent(msg);
}
const LOGIN_LANDING = 'https://ubdstore.ubshop.biz/common/login.do';
const GOOD_FIELDS = {
  goldPrice: '900,000', inputSupplyPrice1: '740,920', inputSupplyPrice2: '495,598',
  salePrice1: '780,000', salePrice2: '520,000'
};

function makeScenario(scenario) {
  scenario = scenario || {};
  const loadCbs = new Set();
  let win = null, doc = null, clickCount = 0, nativeAlertCalls = 0, nativeConfirmCalls = 0;

  function mount(fields, href) {
    doc = makeFakeFormDoc(fields, scenario.fixPriceFlag);
    win = {
      location: { href: href },
      alert() { nativeAlertCalls++; },
      confirm() { nativeConfirmCalls++; return (scenario.defaultConfirmReturn != null) ? scenario.defaultConfirmReturn : false; },
      // 기본은 no-op 이다(재계산 결과를 바꾸지 않는다) — 기존 테스트들의 전제를 지킨다.
      // 판매가고정 동작을 보려는 테스트는 scenario.calItemPrice 로 직접 흉내낸다.
      calItemPrice(form) { if (typeof scenario.calItemPrice === 'function') scenario.calItemPrice(form, win); }
    };
    const btn = {
      click() {
        clickCount++;
        const ctx = {
          succeedTo(landingUrl, delayMs) {
            const fire = () => { mount(scenario.afterFields || scenario.initialFields || {}, landingUrl); emitLoad(); };
            if (delayMs == null) fire(); else setTimeout(fire, delayMs);
          },
          blockWithAlert(msg, delayMs) {
            const fire = () => { try { win.alert(msg); } catch (_) {} };
            if (delayMs == null) fire(); else setTimeout(fire, delayMs);
          },
          hang() { /* 아무 것도 안 함 — 타임아웃 흉내 */ }
        };
        (scenario.onClick || function (c) { c.succeedTo(GOOD_LANDING); })(ctx, win);
      }
    };
    // 실제 DOM 과 같게: form.elements 에도, form 의 자손으로도 넣지 않는다.
    // 문서 전체 조회로만 찾히고 소속은 btn.form 으로만 드러난다.
    btn.name = 'imageField22';
    btn.type = 'image';
    btn.form = doc.forms.form1;
    doc._extra.push(btn);
  }
  function emitLoad() { [...loadCbs].forEach((fn) => { try { fn(); } catch (_) {} }); }

  const iframe = {
    dataset: {}, style: {},
    set src(v) {
      if (typeof scenario.onSrcSet === 'function') scenario.onSrcSet(v);
      const delay = (scenario.loadDelayMs == null) ? 3 : scenario.loadDelayMs;
      setTimeout(() => { mount(scenario.initialFields || {}, v); emitLoad(); }, delay);
    },
    get src() { return ''; },
    get contentWindow() { return win; },
    get contentDocument() { return doc; },
    addEventListener(evt, fn) { if (evt === 'load') loadCbs.add(fn); },
    removeEventListener(evt, fn) { if (evt === 'load') loadCbs.delete(fn); },
    remove() {},
    _clickCount() { return clickCount; },
    _nativeAlertCalls() { return nativeAlertCalls; },
    _nativeConfirmCalls() { return nativeConfirmCalls; }
  };
  return iframe;
}

/* ── extractSeq ───────────────────────────────────────────────────────── */
test('modify(\'7646\') → seq 7646 추출(완료기준 명시 케이스)', () => {
  assert.strictEqual(extractSeq("javascript:modify('7646')"), '7646');
});
test('앵커 마크업 안에 있어도(innerHTML 그대로) 추출된다', () => {
  const html = '<a href="javascript:modify(\'7646\')">수정</a> <a href="javascript:del(\'7646\')">삭제</a>';
  assert.strictEqual(extractSeq(html), '7646');
});
test('쌍따옴표 변형도 허용', () => { assert.strictEqual(extractSeq('modify("8123")'), '8123'); });
test('공백 변형 허용', () => { assert.strictEqual(extractSeq("modify( '9001' )"), '9001'); });
test('헤더 행("수정/삭제" 라벨)에는 modify(...) 가 없어 null', () => { assert.strictEqual(extractSeq('수정/삭제'), null); });
test('"검색된 결과가 없습니다" 행에도 modify(...) 가 없어 null(빈 결과 케이스의 핵심 판별)', () => {
  assert.strictEqual(extractSeq('검색된 결과가 없습니다.'), null);
});
test('빈 값·null 은 null', () => { assert.strictEqual(extractSeq(''), null); assert.strictEqual(extractSeq(null), null); });

/* ── isTargetPage ─────────────────────────────────────────────────────── */
test('master_item_k 탭 → true', () => {
  assert.strictEqual(isTargetPage('/master/item/masterItemList.do', '?tcode=master_item_k'), true);
  assert.strictEqual(isTargetPage('/master/item/masterItemList.do', '?tcode=master_item_k&pageSize=100&page=2'), true);
});
test('master_item(기본정보보기) 탭 → UI 를 붙이지 않는다(false)', () => {
  assert.strictEqual(isTargetPage('/master/item/masterItemList.do', '?tcode=master_item'), false);
});
test('master_item_image(이미지보기) 탭 → UI 를 붙이지 않는다(false)', () => {
  assert.strictEqual(isTargetPage('/master/item/masterItemList.do', '?tcode=master_item_image'), false);
});
test('tcode 파라미터 자체가 없으면 false', () => {
  assert.strictEqual(isTargetPage('/master/item/masterItemList.do', ''), false);
  assert.strictEqual(isTargetPage('/master/item/masterItemList.do', '?pageSize=100'), false);
});
test('경로가 masterItemList.do 가 아니면 tcode 가 맞아도 false', () => {
  assert.strictEqual(isTargetPage('/master/item/masterItemModifyForm.do', '?tcode=master_item_k'), false);
});

/* ── parsePriceInput / validateBulkInput (G9 포함) ────────────────────── */
test('정상 숫자 입력', () => { assert.deepStrictEqual(parsePriceInput('900000'), { ok: true, value: 900000 }); });
test('콤마·공백 섞인 입력도 허용', () => { assert.deepStrictEqual(parsePriceInput('  900,000  '), { ok: true, value: 900000 }); });
test('빈 시세는 거부', () => { assert.strictEqual(parsePriceInput('').ok, false); assert.strictEqual(parsePriceInput('   ').ok, false); });
test('숫자가 아닌 시세는 거부', () => {
  assert.strictEqual(parsePriceInput('abc').ok, false);
  assert.strictEqual(parsePriceInput('90만원').ok, false);
  assert.strictEqual(parsePriceInput('12.5').ok, false);
  assert.strictEqual(parsePriceInput('-100').ok, false);
});
test('0 이하는 거부', () => { assert.strictEqual(parsePriceInput('0').ok, false); });
test('G9: 안전 정수 범위를 벗어나면 거부', () => {
  assert.strictEqual(parsePriceInput('99999999999999999999999').ok, false);
});
test('G9: 상식적 상한(1억)을 넘으면 거부, 상한 자체(1억)는 허용', () => {
  assert.strictEqual(parsePriceInput('100000001').ok, false);
  assert.strictEqual(parsePriceInput('100,000,000').ok, true);
});
test('validateBulkInput: 선택 0건은 시세가 정상이어도 거부', () => { assert.strictEqual(validateBulkInput(0, '900000').ok, false); });
test('validateBulkInput: 선택은 있어도 빈 시세면 거부', () => { assert.strictEqual(validateBulkInput(3, '').ok, false); });
test('validateBulkInput: 선택은 있어도 숫자 아닌 시세면 거부', () => { assert.strictEqual(validateBulkInput(3, 'abc').ok, false); });
test('validateBulkInput: 선택·시세 둘 다 정상이면 통과', () => {
  assert.deepStrictEqual(validateBulkInput(3, '900,000'), { ok: true, count: 3, price: 900000 });
});

/* ── formatComma / splitDualValue ─────────────────────────────────────── */
test('천단위 콤마 포맷', () => {
  assert.strictEqual(formatComma(900000), '900,000');
  assert.strictEqual(formatComma(0), '0');
  assert.strictEqual(formatComma(1234567), '1,234,567');
});
test('괄호 2값(740,920(495,598)) 분리', () => {
  assert.deepStrictEqual(splitDualValue('740,920(495,598)'), { first: '740,920', second: '495,598' });
});
test('품위 2값(18K(14K))도 같은 방식으로 분리', () => {
  assert.deepStrictEqual(splitDualValue('18K(14K)'), { first: '18K', second: '14K' });
});
test('괄호 없는 단일값은 second=null', () => { assert.deepStrictEqual(splitDualValue('900,000'), { first: '900,000', second: null }); });
test('빈 값도 예외 없이 처리', () => {
  assert.deepStrictEqual(splitDualValue(''), { first: '', second: null });
  assert.deepStrictEqual(splitDualValue(null), { first: '', second: null });
});

/* ── extractInputValue ────────────────────────────────────────────────── */
test('name=value 순서 정상', () => { assert.strictEqual(extractInputValue('<input type="text" name="goldPrice" value="900,000">', 'goldPrice'), '900,000'); });
test('value=name 순서(속성 순서 무관)', () => { assert.strictEqual(extractInputValue('<input value="900,000" name="goldPrice" type="text">', 'goldPrice'), '900,000'); });
test('홑따옴표 속성도 허용', () => { assert.strictEqual(extractInputValue("<input name='goldPrice' value='900,000'>", 'goldPrice'), '900,000'); });
test('필드는 있는데 value 속성이 없으면 빈 문자열(필드 부재와 구분)', () => {
  assert.strictEqual(extractInputValue('<input type="hidden" name="goldPrice">', 'goldPrice'), '');
});
test('필드 자체가 없으면 null', () => { assert.strictEqual(extractInputValue('<input name="other" value="x">', 'goldPrice'), null); });
test('이름이 정확히 일치해야 한다(부분일치 오탐 배제)', () => {
  assert.strictEqual(extractInputValue('<input name="goldPriceOld" value="1">', 'goldPrice'), null);
});
test('여러 input 중 정확한 이름의 값을 고른다', () => {
  const html = '<input name="k1" value="18K"><input name="k2" value="14K"><input name="goldPrice" value="900,000">';
  assert.strictEqual(extractInputValue(html, 'k2'), '14K');
  assert.strictEqual(extractInputValue(html, 'goldPrice'), '900,000');
});

/* ── decode ────────────────────────────────────────────────────────────── */
test('localDecodeBytes: utf-8 charset 헤더로 정상 디코드', () => {
  const s = '기초상품관리 900,000';
  assert.strictEqual(localDecodeBytes(new TextEncoder().encode(s), 'text/html; charset=utf-8'), s);
});
test('localDecodeBytes: 헤더 없어도 score-both 로 utf-8 채택(치환문자 0)', () => {
  const s = '적용시세';
  assert.strictEqual(localDecodeBytes(new TextEncoder().encode(s), ''), s);
});
test('decodeResponseBytes: win.ubErp.decodeErpHtml 이 있으면 위임한다(SSOT 우선)', () => {
  let called = null;
  const fakeWin = { ubErp: { decodeErpHtml: (bytes, ct) => { called = ct; return 'SSOT-RESULT'; } } };
  assert.strictEqual(decodeResponseBytes(new Uint8Array([1, 2, 3]), 'charset=utf-8', fakeWin), 'SSOT-RESULT');
  assert.strictEqual(called, 'charset=utf-8');
});
test('decodeResponseBytes: win 에 ubErp 가 없으면 로컬 폴백으로 정상 디코드', () => {
  const s = '폴백 디코드 확인';
  assert.strictEqual(decodeResponseBytes(new TextEncoder().encode(s), 'charset=utf-8', {}), s);
});

/* ── 성공/실패 판정 ────────────────────────────────────────────────────── */
test('localJudgeSubmitUrl: msg 없음 → 성공', () => {
  assert.deepStrictEqual(localJudgeSubmitUrl('http://x/master/item/masterItemModifyForm.do?tcode=master_item&seq=1'), { ok: true, msg: '' });
});
test('localJudgeSubmitUrl: msg 있음 → 실패 + 사유', () => {
  const m = '품위가 동일합니다';
  assert.deepStrictEqual(localJudgeSubmitUrl('http://x/a.do?msg=' + encodeURIComponent(m)), { ok: false, msg: m });
});
test('localJudgeSubmitUrl: URL 파싱 불가 → 성공 처리(erp.js 와 동일 무회귀 처리, fetch 전제 하)', () => {
  assert.strictEqual(localJudgeSubmitUrl('not a url').ok, true);
});
test('judgeSubmitUrl: win.ubErp.submitResult 가 있으면 위임한다(SSOT 우선)', () => {
  const fakeWin = { ubErp: { submitResult: () => ({ ok: false, msg: 'SSOT-MSG' }) } };
  assert.deepStrictEqual(judgeSubmitUrl('http://x/a.do', fakeWin), { ok: false, msg: 'SSOT-MSG' });
});
test('judgeSubmitUrl: win 에 ubErp 가 없으면 로컬 폴백 사용', () => {
  assert.deepStrictEqual(judgeSubmitUrl('http://x/a.do?msg=' + encodeURIComponent('사유'), {}), { ok: false, msg: '사유' });
});

/* ── judgeLandingUrl(F3) ──────────────────────────────────────────────── */
test('F3: 빈 URL 은 실패(불확정)', () => { assert.strictEqual(judgeLandingUrl('', {}).ok, false); });
test('F3: 파싱 불가 URL 은 실패(불확정)', () => { assert.strictEqual(judgeLandingUrl('not a url', {}).ok, false); });
test('F3: 세션 만료로 로그인 페이지 등 예상 밖 경로로 튕기면 msg 없어도 실패로 판정한다', () => {
  const r = judgeLandingUrl(LOGIN_LANDING, {});
  assert.strictEqual(r.ok, false);
  assert.match(r.msg, /예상과 다른 페이지/);
});
test('F3: master/item 경로 안이고 msg 없으면 성공', () => { assert.strictEqual(judgeLandingUrl(GOOD_LANDING, {}).ok, true); });
test('F3: master/item 경로 안이어도 msg 있으면 실패 + 사유', () => {
  const r = judgeLandingUrl(badLandingWithMsg('검증 실패'), {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.msg, '검증 실패');
});

/* ── numOrNull / validateRecalc(F2) ───────────────────────────────────── */
test('numOrNull: 콤마 제거 후 숫자로, 빈 값/비숫자는 null(0 과 구분)', () => {
  assert.strictEqual(numOrNull('740,920'), 740920);
  assert.strictEqual(numOrNull('0'), 0);
  assert.strictEqual(numOrNull(''), null);
  assert.strictEqual(numOrNull(null), null);
  assert.strictEqual(numOrNull('abc'), null);
});
test('F2: goldPrice 가 입력값과 다르면 실패', () => {
  const before = { inputSupplyPrice1: '1', inputSupplyPrice2: '1', salePrice1: '1', salePrice2: '1' };
  const recalced = Object.assign({ goldPrice: '850,000' }, before);
  const r = validateRecalc(before, recalced, '900,000');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /적용시세/);
});
test('F2(완료기준 핵심): before 에서 0 이 아니던 입고공급가/판매가가 재계산 후 0 이 되면 실패', () => {
  const before = { inputSupplyPrice1: '740,920', inputSupplyPrice2: '495,598', salePrice1: '780,000', salePrice2: '520,000' };
  const recalced = { goldPrice: '900,000', inputSupplyPrice1: '0', inputSupplyPrice2: '0', salePrice1: '0', salePrice2: '0' };
  const r = validateRecalc(before, recalced, '900,000');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /inputSupplyPrice1/);
});
test('F2: before 에서 0 이 아니던 값이 재계산 후 빈 값/비숫자가 돼도 실패', () => {
  const before = { inputSupplyPrice1: '740,920', inputSupplyPrice2: '1', salePrice1: '1', salePrice2: '1' };
  const recalced = { goldPrice: '900,000', inputSupplyPrice1: '', inputSupplyPrice2: '1', salePrice1: '1', salePrice2: '1' };
  assert.strictEqual(validateRecalc(before, recalced, '900,000').ok, false);
});
test('F2: before 에서 원래 0/빈 값이던 필드는 재계산 후에도 0/빈 값이어도 통과', () => {
  const before = { inputSupplyPrice1: '740,920', inputSupplyPrice2: '', salePrice1: '780,000', salePrice2: '0' };
  const recalced = { goldPrice: '900,000', inputSupplyPrice1: '800,000', inputSupplyPrice2: '', salePrice1: '820,000', salePrice2: '0' };
  assert.strictEqual(validateRecalc(before, recalced, '900,000').ok, true);
});
test('F2: 전부 정상이면 통과', () => {
  const before = { inputSupplyPrice1: '700,000', inputSupplyPrice2: '400,000', salePrice1: '750,000', salePrice2: '500,000' };
  const recalced = { goldPrice: '900,000', inputSupplyPrice1: '740,920', inputSupplyPrice2: '495,598', salePrice1: '780,000', salePrice2: '520,000' };
  assert.strictEqual(validateRecalc(before, recalced, '900,000').ok, true);
});

/* ── serverValueMatches / verifyAgainstServer(G2) / decideTrialContinuation(F6/G2) ──── */
test('serverValueMatches: 콤마·공백 정규화 후 일치 비교, 판독 불가는 불일치', () => {
  assert.strictEqual(serverValueMatches('900,000', '900,000'), true);
  assert.strictEqual(serverValueMatches('900000', '900,000'), true);
  assert.strictEqual(serverValueMatches(' 900,000 ', '900,000'), true);
  assert.strictEqual(serverValueMatches('850,000', '900,000'), false);
  assert.strictEqual(serverValueMatches(null, '900,000'), false);
  assert.strictEqual(serverValueMatches('', '900,000'), false);
  assert.strictEqual(serverValueMatches('abc', '900,000'), false);
});
test('G2: serverValueMatches — 둘 다 빈 값이면 일치(단일품위 상품의 2번 필드 오탐 방지)', () => {
  assert.strictEqual(serverValueMatches('', ''), true);
  assert.strictEqual(serverValueMatches(null, ''), true);
});
test('G2: verifyAgainstServer — 5값이 전부 일치하면 통과', () => {
  const recalced = { goldPrice: '900,000', inputSupplyPrice1: '740,920', inputSupplyPrice2: '495,598', salePrice1: '780,000', salePrice2: '520,000' };
  const serverAfter = Object.assign({}, recalced);
  assert.deepStrictEqual(verifyAgainstServer(recalced, serverAfter), { ok: true });
});
test('G2(완료기준 핵심): verifyAgainstServer — 시세는 맞아도 입고공급가1 이 다르면 실패', () => {
  const recalced = { goldPrice: '900,000', inputSupplyPrice1: '740,920', inputSupplyPrice2: '495,598', salePrice1: '780,000', salePrice2: '520,000' };
  const serverAfter = Object.assign({}, recalced, { inputSupplyPrice1: '0' });
  const r = verifyAgainstServer(recalced, serverAfter);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /inputSupplyPrice1/);
});
test('G2: verifyAgainstServer — 서버 값을 못 읽으면(null) 실패', () => {
  assert.strictEqual(verifyAgainstServer({ goldPrice: '900,000' }, null).ok, false);
  assert.strictEqual(verifyAgainstServer(null, { goldPrice: '900,000' }).ok, false);
});
test('decideTrialContinuation: 시범 자체가 실패면 진행 안 함', () => {
  assert.deepStrictEqual(decideTrialContinuation({ ok: false }, null, '', 3), { proceed: false, reason: 'trial_failed' });
});
test('decideTrialContinuation: 서버 재조회 자체가 실패하면 진행 안 함', () => {
  const d = decideTrialContinuation({ ok: true, recalced: { goldPrice: '900,000' } }, null, 'network error', 3);
  assert.strictEqual(d.proceed, false);
  assert.strictEqual(d.reason, 'refetch_failed');
});
test('decideTrialContinuation(G2 통일): 서버 5값 중 하나라도 다르면 진행 안 함', () => {
  const recalced = { goldPrice: '900,000', inputSupplyPrice1: '740,920', inputSupplyPrice2: '495,598', salePrice1: '780,000', salePrice2: '520,000' };
  const serverAfter = Object.assign({}, recalced, { salePrice2: '0' });
  const d = decideTrialContinuation({ ok: true, recalced: recalced }, serverAfter, '', 3);
  assert.strictEqual(d.proceed, false);
  assert.strictEqual(d.reason, 'server_mismatch');
});
test('decideTrialContinuation: 선택이 1건뿐이면(자동검증 통과해도) 진행 안 함', () => {
  const recalced = { goldPrice: '900,000', inputSupplyPrice1: '1', inputSupplyPrice2: '1', salePrice1: '1', salePrice2: '1' };
  const d = decideTrialContinuation({ ok: true, recalced: recalced }, recalced, '', 1);
  assert.strictEqual(d.proceed, false);
  assert.strictEqual(d.reason, 'only_one_item');
});
test('decideTrialContinuation: 전부 통과하면 사용자 확인이 필요하다는 상태로 진행 허용', () => {
  const recalced = { goldPrice: '900,000', inputSupplyPrice1: '1', inputSupplyPrice2: '1', salePrice1: '1', salePrice2: '1' };
  const d = decideTrialContinuation({ ok: true, recalced: recalced }, recalced, '', 3);
  assert.deepStrictEqual(d, { proceed: true, reason: 'needs_user_confirm' });
});

/* ── runSequential — 실패 1건이 나오면 뒤 상품을 시도하지 않는다 ─────────────────── */
test('실패 1건이 나오면 뒤 상품을 시도하지 않는다', async () => {
  const calls = [];
  const r = await runSequential(['A', 'B', 'C'], async (item) => {
    calls.push(item);
    return item === 'B' ? { ok: false, reason: 'B 실패' } : { ok: true };
  });
  assert.deepStrictEqual(calls, ['A', 'B']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.failedAt, 1);
});
test('전부 성공하면 ok:true, failedAt:-1, 전 항목 처리', async () => {
  const calls = [];
  const r = await runSequential(['A', 'B', 'C'], async (item) => { calls.push(item); return { ok: true, item }; });
  assert.deepStrictEqual(calls, ['A', 'B', 'C']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.failedAt, -1);
});
test('processFn 이 예외를 던져도 실패(status:unknown)로 흡수하고 뒤 항목을 시도하지 않는다', async () => {
  const calls = [];
  const r = await runSequential(['A', 'B', 'C'], async (item) => {
    calls.push(item);
    if (item === 'A') throw new Error('boom');
    return { ok: true };
  });
  assert.deepStrictEqual(calls, ['A']);
  assert.strictEqual(r.results[0].result.status, 'unknown');
  assert.match(r.results[0].result.reason, /boom/);
});
test('onProgress 콜백이 매 항목 처리 전에 (item, index, total) 로 호출된다', async () => {
  const seen = [];
  await runSequential(['X', 'Y'], async () => ({ ok: true }), (item, idx, total) => seen.push([item, idx, total]));
  assert.deepStrictEqual(seen, [['X', 0, 2], ['Y', 1, 2]]);
});

/* ── augmentMasterTable ───────────────────────────────────────────────── */
function fakeRow(cellHtmls) {
  const cells = cellHtmls.map((h) => ({ innerHTML: h }));
  return { cells, insertCell(i) { const c = { innerHTML: '' }; this.cells.splice(i, 0, c); return c; } };
}
function fakeTable(rowsOfCellHtmls) { return { rows: rowsOfCellHtmls.map(fakeRow) }; }
function headerCellsFixture() { const c = []; for (let i = 0; i < 21; i++) c.push('h' + i); c[20] = '수정/삭제'; return c; }
function dataRowCellsFixture(seq) {
  const c = []; for (let i = 0; i < 21; i++) c.push('d' + i + '_' + seq);
  c[2] = 'T-R2-I-WG-QB-' + seq; c[3] = 'ITEM-' + seq; c[4] = '900,000';
  c[12] = '740,920(495,598)'; c[14] = '780,000';
  c[20] = "<a href=\"javascript:modify('" + seq + "')\">수정</a> <a href=\"javascript:del('" + seq + "')\">삭제</a>";
  return c;
}
test('빈 결과 표(헤더 1행 + colspan 행 1개)는 체크박스를 0개 삽입하고 헤더 셀 수가 21 그대로다', () => {
  const table = fakeTable([headerCellsFixture(), ['검색된 결과가 없습니다.']]);
  const r = augmentMasterTable(table, () => {}, () => {});
  assert.strictEqual(r.augmented, false);
  assert.strictEqual(table.rows[0].cells.length, 21);
  assert.strictEqual(table.rows[1].cells.length, 1);
});
test('헤더만 있고 데이터 행이 아예 없는 표(1행)도 안전하게 아무것도 하지 않는다', () => {
  const table = fakeTable([headerCellsFixture()]);
  assert.strictEqual(augmentMasterTable(table, () => {}, () => {}).augmented, false);
});
test('데이터 행이 있으면 헤더·데이터 모두 맨 앞에 체크박스 칸이 삽입되고 seq 를 정확히 모은다', () => {
  const table = fakeTable([headerCellsFixture(), dataRowCellsFixture('7646'), dataRowCellsFixture('7647')]);
  const built = [];
  const r = augmentMasterTable(table, (cell) => { cell.innerHTML = 'ALL'; }, (cell, seq) => { cell.innerHTML = 'CHK:' + seq; built.push(seq); });
  assert.strictEqual(r.augmented, true);
  assert.deepStrictEqual(r.seqs, ['7646', '7647']);
  assert.deepStrictEqual(built, ['7646', '7647']);
  assert.strictEqual(table.rows[0].cells[0].innerHTML, 'ALL');
  assert.strictEqual(table.rows[1].cells[0].innerHTML, 'CHK:7646');
});
test('헤더 행과 데이터 행의 셀 수가 같다(체크박스 삽입 후에도)', () => {
  const table = fakeTable([headerCellsFixture(), dataRowCellsFixture('7646'), dataRowCellsFixture('7647')]);
  augmentMasterTable(table, () => {}, () => {});
  assert.deepStrictEqual(table.rows.map(r => r.cells.length), [22, 22, 22]);
});
test('삽입은 맨 앞에서만 일어나 기존 21셀은 유실·중복 없이 그대로 한 칸씩(+1) 밀린다', () => {
  const original = dataRowCellsFixture('7646');
  const table = fakeTable([headerCellsFixture(), original.slice()]);
  augmentMasterTable(table, () => {}, () => {});
  const row = table.rows[1];
  assert.strictEqual(row.cells.length, 22);
  assert.strictEqual(row.cells[1 + ORIG_COL.price].innerHTML, original[ORIG_COL.price]);
  assert.strictEqual(row.cells[1 + ORIG_COL.supply].innerHTML, original[ORIG_COL.supply]);
  assert.strictEqual(row.cells[1 + ORIG_COL.sale].innerHTML, original[ORIG_COL.sale]);
  assert.strictEqual(row.cells[1 + ORIG_COL.itemCode].innerHTML, original[ORIG_COL.itemCode]);
  const ORIG_MASTER_CODE_COL = 2, ORIG_MODIFY_COL = 20;
  assert.strictEqual(row.cells[1 + ORIG_MASTER_CODE_COL].innerHTML, original[ORIG_MASTER_CODE_COL]);
  assert.strictEqual(row.cells[row.cells.length - 1].innerHTML, original[ORIG_MODIFY_COL]);
});

/* ── ORIG_COL ─────────────────────────────────────────────────────────── */
test('ORIG_COL 상수가 spec §0.2 와 일치한다(완료기준 명시: 시세=4, 입고공급가=12, 판매가=14)', () => {
  assert.strictEqual(ORIG_COL.price, 4);
  assert.strictEqual(ORIG_COL.supply, 12);
  assert.strictEqual(ORIG_COL.sale, 14);
  assert.strictEqual(ORIG_COL.itemCode, 3);
});

/* ── getSelectedItems(M11) ────────────────────────────────────────────── */
function fakeCheckboxEl(seq, row) {
  return { getAttribute(name) { return name === 'data-ub-mp-seq' ? seq : null; }, closest(sel) { return sel === 'tr' ? row : null; } };
}
function fakeCellsRow(cellTexts) { return { cells: cellTexts.map((t) => ({ textContent: t })) }; }
function fakeSelectableTable(checkedList) {
  return { querySelectorAll(sel) { return sel === '.ub-mp-chk:checked' ? checkedList.map((c) => fakeCheckboxEl(c.seq, c.row)) : []; } };
}
test('M11: +1 오프셋으로 원래 3/4/12/14번 열을 정확히 읽는다', () => {
  const original = dataRowCellsFixture('7646');
  const augmented = ['[chk]'].concat(original);
  const row = fakeCellsRow(augmented);
  const out = getSelectedItems(fakeSelectableTable([{ seq: '7646', row }]));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].itemCode, original[ORIG_COL.itemCode], '오프셋이 빠지면 매입처상품코드 대신 마스터상품코드를 읽는다');
  assert.deepStrictEqual(out[0].listPrice, splitDualValue(original[ORIG_COL.price]));
  assert.deepStrictEqual(out[0].listSupply, splitDualValue(original[ORIG_COL.supply]));
  assert.deepStrictEqual(out[0].listSale, splitDualValue(original[ORIG_COL.sale]));
});
test('getSelectedItems: 체크된 게 없으면 빈 배열, 체크박스 없는 table 도 예외 없이', () => {
  assert.deepStrictEqual(getSelectedItems(fakeSelectableTable([])), []);
  assert.deepStrictEqual(getSelectedItems(null), []);
});

/* ── 처리 로그(F1/G5) ─────────────────────────────────────────────────── */
test('F1: appendPriceLog 는 항목을 남기고 id 를 돌려준다', () => {
  resetLS();
  const w = appendPriceLog({ seq: '1', itemCode: 'A' });
  assert.strictEqual(w.ok, true);
  assert.ok(w.id);
  const list = readPriceLogListOrRecover();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, w.id);
});
test('F1: updatePriceLog 는 write-ahead 로 남긴 항목을 찾아 갱신한다', () => {
  resetLS();
  const w = appendPriceLog({ seq: '1', itemCode: 'A', status: 'pending' });
  assert.strictEqual(updatePriceLog(w.id, { status: 'applied', ok: true }), true);
  const list = readPriceLogListOrRecover();
  assert.strictEqual(list[0].status, 'applied');
  assert.strictEqual(list[0].seq, '1', '갱신이 나머지 필드를 지우면 안 된다');
});
test('F1: 존재하지 않는 id 갱신은 조용히 false(죽지 않는다)', () => {
  resetLS();
  assert.strictEqual(updatePriceLog('없는id', { status: 'applied' }), false);
});
test('F1(완료기준): 손상된 기존 로그(JSON.parse 실패)는 백업 키로 옮기고 새로 시작한다', () => {
  resetLS();
  lsStore['UB_MASTERPRICE_LOG_v1'] = '이것은 JSON 이 아니다{{{';
  const w = appendPriceLog({ seq: '1' });
  assert.strictEqual(w.ok, true);
  assert.strictEqual(readPriceLogListOrRecover().length, 1);
  const backupKeys = Object.keys(lsStore).filter((k) => k.startsWith('UB_MASTERPRICE_LOG_v1_corrupt_'));
  assert.strictEqual(backupKeys.length, 1);
  assert.match(lsStore[backupKeys[0]], /이것은 JSON/);
});
test('F1(완료기준): storage 쓰기 자체가 실패하면 fail-closed', () => {
  resetLS();
  lsThrows = true;
  const w = appendPriceLog({ seq: '1' });
  lsThrows = false;
  assert.strictEqual(w.ok, false);
  assert.ok(w.reason);
});
test('G5(최우선 완료기준): 손상 로그의 백업(새 키 저장)까지 실패하면 fail-closed — LOG_KEY 를 덮어쓰지 않는다', () => {
  resetLS();
  const originalRaw = '깨진 원본{{{';
  lsStore['UB_MASTERPRICE_LOG_v1'] = originalRaw;
  lsThrowOnNewKey = true;   // 기존 키 덮어쓰기는 성공, 새 백업 키만 실패 — quota 총량 초과 흉내
  const w = appendPriceLog({ seq: '1' });
  lsThrowOnNewKey = false;
  assert.strictEqual(w.ok, false, '백업까지 실패했으면 fail-closed 로 거부해야 한다');
  assert.strictEqual(lsStore['UB_MASTERPRICE_LOG_v1'], originalRaw, 'LOG_KEY 를 덮어쓰면 안 된다(손상 전 원본이 백업도 없이 사라진다)');
});
test('F1: LOG_CAP 을 넘으면 오래된 항목부터 잘린다', () => {
  resetLS();
  for (let i = 0; i < 2005; i++) appendPriceLog({ seq: String(i) });
  const list = readPriceLogListOrRecover();
  assert.strictEqual(list.length, 2000);
  assert.strictEqual(list[0].seq, '5');
});

/* ── buildLogViewerHtml(G4) ───────────────────────────────────────────── */
test('G4: before 가 있으면 이전 시세·입고공급가·판매가를 폼 값 그대로 보여준다', () => {
  const html = buildLogViewerHtml([{
    ts: 1000, itemCode: 'A', seq: '1', status: 'applied', newPrice: 900000,
    before: { goldPrice: '850,000', inputSupplyPrice1: '700,000', inputSupplyPrice2: '400,000', salePrice1: '750,000', salePrice2: '500,000' }
  }]);
  assert.match(html, /850,000/);
  assert.match(html, /700,000/);
  assert.match(html, /400,000/);
  assert.match(html, /750,000/);
  assert.match(html, /500,000/);
});
test('G4(완료기준 핵심): before 가 없는 pending 항목은 목록 표시값(list*)으로 폴백한다 — "되돌릴 근거 없음" 오판 방지', () => {
  const html = buildLogViewerHtml([{
    ts: 1000, itemCode: 'B', seq: '2', status: 'pending', newPrice: 900000,
    listPrice: { first: '111,111', second: null }, listSupply: { first: '222,222', second: '333,333' }, listSale: { first: '444,444', second: null }
  }]);
  assert.match(html, /111,111/);
  assert.match(html, /222,222/);
  assert.match(html, /333,333/);
  assert.match(html, /444,444/);
});
test('G4: LOG_CAP 보관 한도 안내 문구가 포함된다', () => {
  assert.match(buildLogViewerHtml([]), /2,000건/);
});
test('G4: itemCode/사유에 HTML 특수문자가 있어도 이스케이프된다', () => {
  const html = buildLogViewerHtml([{ ts: 1000, itemCode: '<script>x</script>', seq: '1', status: 'unknown', reason: '<b>사유</b>' }]);
  assert.ok(!html.includes('<script>x</script>'));
  assert.match(html, /&lt;script&gt;/);
});
test('logFieldDisplay: before 필드가 빈 문자열이면 목록값으로 폴백한다', () => {
  const entry = { before: { goldPrice: '' }, listPrice: { first: '999,999', second: null } };
  assert.strictEqual(logFieldDisplay(entry, 'goldPrice', 'listPrice', 'first'), '999,999');
});

/* ── processOneItem(G2·G3·G7 포함) — 가짜 iframe+fetch 하네스로 실제 실행 ────────── */
test('정상 성공 경로: 재계산 검증 통과 → 클릭 → 서버 재조회 5값 대조 통과 → 착지 URL 갱신 확인(N2 관련)', async () => {
  resetFetch();
  const NEW_LANDING = 'https://ubdstore.ubshop.biz/master/item/masterItemModifyForm.do?tcode=master_item&seq=7646&saved=1';
  const afterFields = { goldPrice: '900,000', inputSupplyPrice1: '780,920', inputSupplyPrice2: '520,598', salePrice1: '810,000', salePrice2: '540,000' };
  setServerFields(afterFields);
  const iframe = makeScenario({
    initialFields: { goldPrice: '850,000', inputSupplyPrice1: '740,920', inputSupplyPrice2: '495,598', salePrice1: '780,000', salePrice2: '520,000' },
    calItemPrice(form) {
      Object.keys(afterFields).forEach((k) => { form.elements[k].value = afterFields[k]; });
    },
    onClick(ctx) { ctx.succeedTo(NEW_LANDING, 3); }
  });
  const r = await processOneItem(iframe, '7646', '900,000');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.status, 'applied');
  assert.strictEqual(r.resultUrl, NEW_LANDING, 'win 을 다시 획득하지 않으면 옛(수정폼) URL 이 남는다(N2 회귀)');
  assert.strictEqual(r.before.goldPrice, '850,000');
  assert.strictEqual(iframe._nativeAlertCalls(), 0);
});

test('G2(실행검증): 착지 URL 은 성공이어도 서버 재조회 값이 재계산과 다르면 unknown 으로 막는다', async () => {
  resetFetch();
  setServerFields(Object.assign({}, GOOD_FIELDS, { inputSupplyPrice1: '0' }));
  const iframe = makeScenario({ initialFields: GOOD_FIELDS, onClick(ctx) { ctx.succeedTo(GOOD_LANDING, 2); } });
  const r = await processOneItem(iframe, '7646', '900,000');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'unknown');
  assert.match(r.reason, /서버 대조 실패/);
  assert.match(r.reason, /inputSupplyPrice1/);
});
test('G2(실행검증): 서버 재조회 자체가 실패해도 unknown 으로 막는다(fail-closed)', async () => {
  resetFetch();
  fetchShouldFail = true;
  const iframe = makeScenario({ initialFields: GOOD_FIELDS, onClick(ctx) { ctx.succeedTo(GOOD_LANDING, 2); } });
  const r = await processOneItem(iframe, '7646', '900,000');
  fetchShouldFail = false;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'unknown');
  assert.match(r.reason, /서버 재조회 실패/);
});

test('F2(실행검증): 재계산 후 입고공급가/판매가가 0으로 밀리면 저장 클릭 자체를 하지 않는다', async () => {
  resetFetch();
  const iframe = makeScenario({
    initialFields: GOOD_FIELDS,
    calItemPrice(form) {
      form.elements.goldPrice.value = '900,000';
      form.elements.inputSupplyPrice1.value = '0'; form.elements.inputSupplyPrice2.value = '0';
      form.elements.salePrice1.value = '0'; form.elements.salePrice2.value = '0';
    },
    onClick() { throw new Error('F2 가 걸렸어야 하는데 클릭까지 갔다'); }
  });
  const r = await processOneItem(iframe, '7646', '900,000');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'not_applied');
  assert.match(r.reason, /재계산 검증 실패/);
  assert.strictEqual(iframe._clickCount(), 0);
});

test('F4(실행검증): 클릭 전에 이미 dialog 가 잡히면 클릭하지 않는다(확실히 미반영)', async () => {
  resetFetch();
  const iframe = makeScenario({
    initialFields: GOOD_FIELDS,
    calItemPrice(form, win) {
      form.elements.inputSupplyPrice1.value = '740,920'; form.elements.inputSupplyPrice2.value = '495,598';
      form.elements.salePrice1.value = '780,000'; form.elements.salePrice2.value = '520,000';
      win.alert('예상치 못한 사전 경고');
    },
    onClick() { throw new Error('사전 dialog 인데 클릭까지 갔다'); }
  });
  const r = await processOneItem(iframe, '7646', '900,000');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'not_applied');
  assert.match(r.reason, /저장 전 검증에서 막혔습니다/);
  assert.strictEqual(iframe._clickCount(), 0);
});

test('F4/M14(실행검증): 클릭 후 dialog(검증경고)가 뜨면 실패로 판정한다 — 반영여부는 unknown', async () => {
  resetFetch();
  const iframe = makeScenario({ initialFields: GOOD_FIELDS, onClick(ctx) { ctx.blockWithAlert('품위가 동일합니다', 3); } });
  const r = await processOneItem(iframe, '7646', '900,000');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'unknown', 'F5: 클릭 후 실패는 반영여부 불명이어야 한다');
  assert.match(r.reason, /검증 경고/);
  assert.strictEqual(iframe._clickCount(), 1);
});

test('M9(실행검증): 착지 URL 에 msg 가 있으면 실패로 판정한다', async () => {
  resetFetch();
  const iframe = makeScenario({ initialFields: GOOD_FIELDS, onClick(ctx) { ctx.succeedTo(badLandingWithMsg('검증 실패 문구'), 3); } });
  const r = await processOneItem(iframe, '7646', '900,000');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'unknown');
  assert.match(r.reason, /검증 실패 문구/);
});

test('F3(실행검증): 세션 만료로 로그인 페이지로 튕기면 msg 없어도 실패로 판정한다', async () => {
  resetFetch();
  const iframe = makeScenario({ initialFields: GOOD_FIELDS, onClick(ctx) { ctx.succeedTo(LOGIN_LANDING, 3); } });
  const r = await processOneItem(iframe, '7646', '900,000');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'unknown');
  assert.match(r.reason, /예상과 다른 페이지/);
});

test('M10(실행검증): win.confirm 가로채기가 없으면(카나리아 false) confirm 의존 흐름이 실패로 빠진다', async () => {
  resetFetch(); setServerFields(GOOD_FIELDS);
  const iframe = makeScenario({
    initialFields: GOOD_FIELDS,
    onClick(ctx, win) { if (win.confirm('진행?')) ctx.succeedTo(GOOD_LANDING, 3); else ctx.hang(); }
  });
  const r = await processOneItem(iframe, '7646', '900,000', 60);
  assert.strictEqual(r.ok, true, 'confirm 가로채기가 정상이면 성공해야 한다: ' + JSON.stringify(r));
});

test('M12(실행검증): 정상 범위(수 ms) 지연에서는 기본 타임아웃으로 성공한다(SAVE_TIMEOUT_MS 축소 변이에 민감)', async () => {
  resetFetch(); setServerFields(GOOD_FIELDS);
  const iframe = makeScenario({ initialFields: GOOD_FIELDS, loadDelayMs: 8, onClick(ctx) { ctx.succeedTo(GOOD_LANDING, 8); } });
  const r = await processOneItem(iframe, '7646', '900,000');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});
test('타임아웃 자체는 실패로 판정되고 반영 여부는 불명(unknown)으로 남는다', async () => {
  resetFetch();
  const iframe = makeScenario({ initialFields: GOOD_FIELDS, onClick(ctx) { ctx.hang(); } });
  const r = await processOneItem(iframe, '7646', '900,000', 30);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'unknown');
  assert.match(r.reason, /시간 초과/);
});

test('N2(실행검증, G6 재설계 — 결정론적 대기): 저장 응답 문서가 load 이후 자체적으로 alert() 를 불러도 재설치된 가로채기가 잡는다', async () => {
  resetFetch(); setServerFields(GOOD_FIELDS);
  let selfAlertFired = false;
  const iframe = makeScenario({
    initialFields: GOOD_FIELDS, afterFields: GOOD_FIELDS,
    onClick(ctx) {
      ctx.succeedTo(GOOD_LANDING, 3);
      setTimeout(() => {
        try { iframe.contentWindow && iframe.contentWindow.alert('응답 페이지 자체 alert'); } catch (_) {}
        selfAlertFired = true;
      }, 8);
    }
  });
  const r = await processOneItem(iframe, '7646', '900,000');
  // 🔴 G6 — processOneItem 은 여기서 이미 resolve 됐지만, 응답 문서의 "자체 alert" 이 아직
  // 안 터졌을 수 있다(주입 지연 8ms). 그 alert 이 실제로 발화할 때까지 결정론적으로 폴링
  // 대기한 뒤에만 단언한다 — 원본 테스트는 대기 없이 즉시 단언해 installDialogGuard 재설치를
  // 지우는 변이가 SURVIVED 했다(3자 검수 지적). 이제는 발화를 직접 관측하고서야 판정한다.
  await new Promise((resolve, reject) => {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (selfAlertFired) { clearInterval(iv); resolve(); }
      else if (tries > 100) { clearInterval(iv); reject(new Error('응답 문서 자체 alert 이 시간 내에 발화하지 않았다(하네스 결함)')); }
    }, 2);
  });
  assert.strictEqual(r.ok, true, 'N2 재설치가 되면 정상 성공해야 한다: ' + JSON.stringify(r));
  assert.strictEqual(iframe._nativeAlertCalls(), 0, '가로채기가 재설치되지 않아 네이티브 alert 가 불렸다(N2 회귀)');
});

test('실행 예외(폼 없음 등)는 status:unknown 이 아니라 not_applied 로 안전하게 반환된다(G7 — 클릭 전 예외)', async () => {
  const iframe = makeScenario({ initialFields: {} });
  const r = await processOneItem(iframe, '7646', '900,000');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'not_applied');
  assert.match(r.reason, /goldPrice/);
});
test('G7(실행검증): 클릭 전 예외(calItemPrice 가 던짐)는 not_applied 로 분류된다', async () => {
  const iframe = makeScenario({ initialFields: GOOD_FIELDS, calItemPrice() { throw new Error('페이지 계산 중 알 수 없는 오류'); } });
  const r = await processOneItem(iframe, '7646', '900,000');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'not_applied');
  assert.match(r.reason, /페이지 계산 중 알 수 없는 오류/);
});
test('G7(실행검증): 클릭 후 예외(클릭 처리 자체가 던짐)는 unknown 으로 분류된다(clickAttempted 플래그)', async () => {
  const iframe = makeScenario({ initialFields: GOOD_FIELDS, onClick() { throw new Error('클릭 처리 중 알 수 없는 오류'); } });
  const r = await processOneItem(iframe, '7646', '900,000');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'unknown');
  assert.match(r.reason, /클릭 처리 중 알 수 없는 오류/);
});

test('F1(실행검증): 서버 재조회가 응답하지 않으면 시간제한으로 끊는다(무기한 정지 방지)', async () => {
  // 이 GET 은 저장 클릭이 '이미 나간 뒤' 실행된다. 안 끊기면 runBulkUpdate 의 finally 가
  // 영원히 실행되지 않아 UI 가 얼고 부분 반영 요약 알림이 아예 안 뜬다.
  resetFetch();
  fetchNeverResolves = true;
  await assert.rejects(() => refetchFieldsForSeq('7646', 40), /시간 초과/);
  resetFetch();
});
test('F1(실행검증): 정상 응답이면 시간제한이 걸리지 않는다(타임아웃 상시발동 변이에 민감)', async () => {
  resetFetch(); setServerFields(GOOD_FIELDS);
  const r = await refetchFieldsForSeq('7646', 2000);
  assert.strictEqual(r.goldPrice, GOOD_FIELDS.goldPrice);
});

/* ── 판매가고정 강제 재계산(2026-08-05 라이브 실측 반영) ───────────────── */
test('판매가고정(Y) 상품도 판매가가 재계산된다 — 계산 동안만 N 으로 내린다', async () => {
  resetFetch(); setServerFields(GOOD_FIELDS);
  let flagSeenByCalc = null;
  const iframe = makeScenario({
    initialFields: GOOD_FIELDS, fixPriceFlag: 'Y',
    calItemPrice(form) {
      flagSeenByCalc = String(form.elements['fixPriceFlag'].value);
      // 페이지 실제 동작: 'N' 일 때만 판매가를 갱신한다
      if (flagSeenByCalc !== 'Y') form.elements['salePrice1'].value = '786,000';
    },
    onClick(ctx) { ctx.succeedTo(GOOD_LANDING, 2); }
  });
  const r = await processOneItem(iframe, '7646', '990,000', 60);
  assert.strictEqual(flagSeenByCalc, 'N', '계산 시점에 고정이 풀려 있어야 판매가가 재계산된다');
  assert.strictEqual(r.recalced.salePrice1, '786,000', '판매가가 실제로 갱신돼야 한다');
});
test('판매가고정은 저장 전에 반드시 원래 값으로 복원된다(상품 속성 훼손 방지)', async () => {
  resetFetch(); setServerFields(GOOD_FIELDS);
  let flagAtClick = null;
  const iframe = makeScenario({
    initialFields: GOOD_FIELDS, fixPriceFlag: 'Y',
    onClick(ctx, win) {
      flagAtClick = String(iframe.contentDocument.forms.form1.elements['fixPriceFlag'].value);
      ctx.succeedTo(GOOD_LANDING, 2);
    }
  });
  await processOneItem(iframe, '7646', '990,000', 60);
  assert.strictEqual(flagAtClick, 'Y', "저장 시점에 'N' 이 남아 있으면 사장님이 켜 둔 고정이 풀린다");
});
test('calItemPrice 가 던져도 판매가고정은 원복된다(finally)', async () => {
  resetFetch();
  const iframe = makeScenario({
    initialFields: GOOD_FIELDS, fixPriceFlag: 'Y',
    calItemPrice() { throw new Error('계산 중 오류'); }
  });
  const r = await processOneItem(iframe, '7646', '990,000', 60);
  assert.strictEqual(r.status, 'not_applied');
  assert.strictEqual(iframe.contentDocument.forms.form1.elements['fixPriceFlag'].value, 'Y');
  assert.strictEqual(iframe._clickCount(), 0);
});
test('판매가고정이 없는 상품(필드 부재)에서도 정상 동작한다', async () => {
  resetFetch(); setServerFields(GOOD_FIELDS);
  const iframe = makeScenario({
    initialFields: GOOD_FIELDS,   // fixPriceFlag 미설정
    onClick(ctx) { ctx.succeedTo(GOOD_LANDING, 2); }
  });
  const r = await processOneItem(iframe, '7646', '900,000', 60);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

/* ── findSaveButton — 라이브 실측 제약 고정(2026-08-05 seq 7618) ───────── */
test('저장버튼: form.elements 에 없고 form 자손도 아니어도 문서 조회+form 소속으로 찾는다', () => {
  const form = { elements: {} };                       // ← 실제로 image 버튼은 여기 없다
  const btn = { name: 'imageField22', type: 'image', form: form };
  const doc = {
    querySelectorAll(sel) { return sel === 'input[name="imageField22"]' ? [btn] : []; }
  };
  assert.strictEqual(findSaveButton(doc, form), btn);
});
test('저장버튼: 다른 폼 소속이면 누르지 않는다(fail-closed — 엉뚱한 폼 제출 방지)', () => {
  const form = { elements: {} }, otherForm = { elements: {} };
  const btn = { name: 'imageField22', type: 'image', form: otherForm };
  const doc = { querySelectorAll() { return [btn]; } };
  assert.strictEqual(findSaveButton(doc, form), null);
});
test('저장버튼: 소속을 알 수 없으면(form 미설정) 누르지 않는다', () => {
  const form = { elements: {} };
  const doc = { querySelectorAll() { return [{ name: 'imageField22', type: 'image' }]; } };
  assert.strictEqual(findSaveButton(doc, form), null);
});
test('저장버튼: 문서에 없으면 null(상위에서 not_applied 로 중단)', () => {
  assert.strictEqual(findSaveButton({ querySelectorAll() { return []; } }, { elements: {} }), null);
});

/* ── processItemWithLog(F1 write-ahead + G3 before 스냅샷) ────────────── */
test('F1(실행검증): 로그를 저장 클릭 전에 먼저 남긴다(write-ahead)', async () => {
  resetLS(); resetFetch(); setServerFields(GOOD_FIELDS);
  let sawLogAtClickTime = null;
  const iframe = makeScenario({
    initialFields: GOOD_FIELDS,
    onClick(ctx) { sawLogAtClickTime = readPriceLogListOrRecover().length; ctx.succeedTo(GOOD_LANDING, 2); }
  });
  const item = { seq: '7646', itemCode: 'ITEM-7646', listPrice: null, listSupply: null, listSale: null };
  const r = await processItemWithLog(iframe, item, '900,000', 900000);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(sawLogAtClickTime, 1, '클릭 시점에 write-ahead 로그가 이미 있어야 한다');
  const list = readPriceLogListOrRecover();
  assert.strictEqual(list[0].status, 'applied');
  assert.strictEqual(list[0].newPrice, 900000);
  assert.ok(r.logId, 'processItemWithLog 는 logId 를 반환해야 한다(G8 대비)');
});
test('G3(실행검증): write-ahead 항목에 클릭 전 실제 폼 before 스냅샷이 얹힌다(목록값이 아니라 진짜 원본)', async () => {
  resetLS(); resetFetch(); setServerFields(GOOD_FIELDS);
  let beforeAtClickTime = null;
  const iframe = makeScenario({
    initialFields: GOOD_FIELDS,
    onClick(ctx) { beforeAtClickTime = readPriceLogListOrRecover()[0].before; ctx.succeedTo(GOOD_LANDING, 2); }
  });
  const item = { seq: '7646', itemCode: 'ITEM-7646', listPrice: { first: '111,111', second: null }, listSupply: null, listSale: null };
  const r = await processItemWithLog(iframe, item, '900,000', 900000);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(beforeAtClickTime, '클릭 시점에 이미 before 가 얹혀 있어야 한다');
  assert.strictEqual(beforeAtClickTime.goldPrice, GOOD_FIELDS.goldPrice, '목록값이 아니라 실제 폼 값이어야 한다');
  assert.notStrictEqual(beforeAtClickTime.goldPrice, '111,111');
});
test('F1(실행검증): 로그 기록 자체가 실패하면 저장을 시도하지 않는다(fail-closed)', async () => {
  resetLS();
  lsThrows = true;
  const iframe = makeScenario({ initialFields: GOOD_FIELDS, onClick() { throw new Error('로그 실패인데 클릭까지 갔다'); } });
  const item = { seq: '7646', itemCode: 'ITEM-7646' };
  const r = await processItemWithLog(iframe, item, '900,000', 900000);
  lsThrows = false;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'not_applied');
  assert.match(r.reason, /처리 로그 기록 실패/);
  assert.strictEqual(iframe._clickCount(), 0);
});
test('G11(실행검증): before 스냅샷 기록이 실패하면 저장 클릭을 하지 않는다(되돌릴 근거 없이 운영 데이터를 쓰지 않는다)', async () => {
  resetLS(); resetFetch(); setServerFields(GOOD_FIELDS);
  // appendPriceLog 의 쓰기 1회만 통과시키고, 그 다음 updatePriceLog(before 갱신) 부터 실패시킨다.
  // pending 항목은 남지만 "우리가 실제로 덮어쓴 원본"은 기록되지 않은 상태 — 여기서 클릭이
  // 나가면 되돌릴 유일한 근거가 유실된 채 라이브 마스터 데이터가 바뀐다(3라운드 Codex P1).
  lsSetItemOkCount = 1;
  const iframe = makeScenario({
    initialFields: GOOD_FIELDS,
    onClick(ctx) { ctx.succeedTo(GOOD_LANDING, 2); }
  });
  const item = { seq: '7646', itemCode: 'ITEM-7646', listPrice: null, listSupply: null, listSale: null };
  const r = await processItemWithLog(iframe, item, '900,000', 900000);
  lsSetItemOkCount = null;
  assert.strictEqual(iframe._clickCount(), 0, 'before 를 못 남겼는데 저장 클릭이 나갔다(G11 회귀)');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'not_applied', '클릭 전에 멈췄으므로 확실히 미반영이어야 한다');
  // 🔴 '되돌릴 근거' 로 느슨하게 보면 appendPriceLog 실패 메시지에도 걸려 경로를 오인한다
  // (두 문구가 같은 말로 끝난다). before 스냅샷 경로만 잡도록 좁힌다.
  assert.match(r.reason, /원본 스냅샷 기록 실패/);
});
test('G11(실행검증): onBefore 가 예외를 던져도 클릭 전에 중단한다(방어 분기가 실제로 동작함)', async () => {
  // 이 분기는 현재 프로덕션 호출부에서는 도달 불가다(updatePriceLog·log 가 둘 다 내부
  // try/catch). 그래서 테스트 없이 두면 "catch 를 beforeOk = true 로 치환" 하는 변이가
  // 살아남는다(Opus 4라운드 실측). processOneItem 을 직접 불러 분기를 실행시킨다.
  resetFetch(); setServerFields(GOOD_FIELDS);
  const iframe = makeScenario({
    initialFields: GOOD_FIELDS,
    onClick(ctx) { ctx.succeedTo(GOOD_LANDING, 2); }
  });
  const r = await processOneItem(iframe, '7646', '900,000', 60, () => {
    throw new Error('스냅샷 기록 중 예외(TEST)');
  });
  assert.strictEqual(iframe._clickCount(), 0, 'onBefore 가 던졌는데 저장 클릭이 나갔다');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'not_applied');
  assert.match(r.reason, /원본 스냅샷 기록 실패/);
  assert.match(r.reason, /스냅샷 기록 중 예외/, '예외 메시지가 사유에 실려야 한다');
});

/* ==========================================================================
 *  runBulkUpdate(G1·G8·G10) — window/document/localStorage/fetch 전부 가짜 주입해
 *  "실제 실행"으로 검증한다(정적 인덱스 대조로 대체하지 않는다 — 3자 검수 핵심 지적).
 * ========================================================================== */
const FULL_NAMES = MAIN_NAMES.concat(['createHiddenFrame', 'fieldLine', 'compareLines', 'runBulkUpdate']);
function buildFullSandbox(fakeWin, fakeDoc, fakeLS, fakeFetch) {
  const box = {};
  // eslint-disable-next-line no-new-func
  new Function('exports', 'TextDecoder', 'URL', 'window', 'document', 'localStorage', 'fetch',
    CONST_LINES + '\n' +
    ORIG_COL_SRC[0] + '\n' +
    FULL_NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
    FULL_NAMES.map(n => `exports.${n} = ${n};`).join('\n')
  )(box, TextDecoder, URL, fakeWin, fakeDoc, fakeLS, fakeFetch);
  return box;
}
function makeFakeDocumentFor(scenarioIframe) {
  return {
    createElement(tag) { return tag === 'iframe' ? scenarioIframe : { style: {}, dataset: {}, appendChild() {} }; },
    body: { appendChild() {} }, head: { appendChild() {} }, getElementById() { return null; }, documentElement: {}
  };
}
function makeFakeFetchOk(html) {
  return async function () {
    return { ok: true, headers: { get: () => 'text/html; charset=utf-8' }, arrayBuffer: async () => new TextEncoder().encode(html).buffer };
  };
}
// G8 전용 — 호출 순서대로 다른 응답을 준다(1차 processOneItem 내부 재조회는 통과, 2차
// runBulkUpdate 표시용 재조회는 불일치시키는 식). 남은 게 없으면 마지막 것을 반복한다.
function makeFakeFetchSequence(htmls) {
  let i = 0;
  return async function () {
    const html = htmls[Math.min(i, htmls.length - 1)];
    i++;
    return { ok: true, headers: { get: () => 'text/html; charset=utf-8' }, arrayBuffer: async () => new TextEncoder().encode(html).buffer };
  };
}
function makeFakeTopWindow(confirmQueue) {
  const q = (confirmQueue || []).slice();
  const alerts = [];
  return { confirm(msg) { const v = q.length ? q.shift() : true; alerts.push(['confirm', msg]); return v; }, alert(msg) { alerts.push(['alert', msg]); }, _alerts: alerts };
}

test('M13(실행검증): 자동검증 통과 뒤 사용자가 [취소]하면 나머지를 처리하지 않고, [확인]하면 처리한다', async () => {
  const items = [{ seq: '7646', itemCode: 'A' }, { seq: '7647', itemCode: 'B' }, { seq: '7648', itemCode: 'C' }];
  const goodHtml = fieldsToHtml(GOOD_FIELDS);   // GOOD_FIELDS.goldPrice === '900,000' 이라 입력값과도 맞는다

  async function run(confirmQueue) {
    resetLS();
    const processedSeqs = [];
    const iframe = makeScenario({
      initialFields: GOOD_FIELDS, afterFields: GOOD_FIELDS,
      onSrcSet(v) { const m = /seq=([^&]+)/.exec(v); if (m) processedSeqs.push(m[1]); },
      onClick(ctx) { ctx.succeedTo(GOOD_LANDING, 2); }
    });
    const fakeWin = makeFakeTopWindow(confirmQueue);
    const fakeDoc = makeFakeDocumentFor(iframe);
    const fakeFetch = makeFakeFetchOk(goodHtml);
    const box = buildFullSandbox(fakeWin, fakeDoc, fakeLocalStorage, fakeFetch);
    await box.runBulkUpdate(null, items, '900,000', { setBusy() {}, setProgress() {} });
    return { processedSeqs, alerts: fakeWin._alerts };
  }

  const cancelled = await run([true, false]);   // 1차(진행?) 확인, 2차(나머지 진행?) 취소
  assert.deepStrictEqual(cancelled.processedSeqs, ['7646'], '취소했는데 나머지가 처리됐다(M13 회귀)');

  const proceeded = await run([true, true]);
  assert.deepStrictEqual(proceeded.processedSeqs, ['7646', '7647', '7648'], '확인했는데 나머지가 처리 안 됐다');
});

test('M13(실행검증): 서버 자동검증이 불일치하면 사용자에게 묻지도 않고 중단한다(나머지 미처리)', async () => {
  resetLS();
  const items = [{ seq: '7646', itemCode: 'A' }, { seq: '7647', itemCode: 'B' }];
  const mismatchHtml = fieldsToHtml(Object.assign({}, GOOD_FIELDS, { goldPrice: '850,000' }));
  const processedSeqs = [];
  const iframe = makeScenario({
    initialFields: GOOD_FIELDS, afterFields: GOOD_FIELDS,
    onSrcSet(v) { const m = /seq=([^&]+)/.exec(v); if (m) processedSeqs.push(m[1]); },
    onClick(ctx) { ctx.succeedTo(GOOD_LANDING, 2); }
  });
  const fakeWin = makeFakeTopWindow([true, true]);   // 2차 confirm 이 나오면 안 된다(그 전에 막혀야 함)
  const fakeDoc = makeFakeDocumentFor(iframe);
  // processOneItem 내부(G2) 재조회와 runBulkUpdate 표시용 재조회 둘 다 불일치 html 을 준다 —
  // 이러면 G2 단계에서 이미 막혀 시범 자체가 실패(trial_failed)로 끝난다. 여기서는 그
  // "시범 자체가 애초에 통과하지 못하는" 경로까지 포함해 나머지가 처리되지 않음을 확인한다.
  const fakeFetch = makeFakeFetchOk(mismatchHtml);
  const box = buildFullSandbox(fakeWin, fakeDoc, fakeLocalStorage, fakeFetch);
  await box.runBulkUpdate(null, items, '900,000', { setBusy() {}, setProgress() {} });
  assert.deepStrictEqual(processedSeqs, ['7646'], '자동검증 실패인데 나머지가 처리됐다');
  assert.strictEqual(fakeWin._alerts.filter(a => a[0] === 'confirm').length, 1, '자동검증 실패면 두 번째 진행 확인(confirm)을 아예 묻지 않아야 한다');
});

test('G1(완료기준 최우선/실행검증): 시도 건수가 off-by-one 없이 정확하다 — 성공/확인필요/미시도 건수 문구 고정', async () => {
  resetLS();
  const items = [
    { seq: 's0', itemCode: 'I0' }, { seq: 's1', itemCode: 'I1' }, { seq: 's2', itemCode: 'I2' },
    { seq: 's3', itemCode: 'I3' }, { seq: 's4', itemCode: 'I4' }
  ];
  let currentSeq = null;
  const iframe = makeScenario({
    initialFields: GOOD_FIELDS, afterFields: GOOD_FIELDS,
    onSrcSet(v) { const m = /seq=([^&]+)/.exec(v); currentSeq = m ? m[1] : null; },
    onClick(ctx) {
      if (currentSeq === 's2') ctx.blockWithAlert('의도적 실패', 2);   // 5건 중 3번째(rest 기준 1번째)에서 실패
      else ctx.succeedTo(GOOD_LANDING, 2);
    }
  });
  const fakeWin = makeFakeTopWindow([true, true]);
  const fakeDoc = makeFakeDocumentFor(iframe);
  const fakeFetch = makeFakeFetchOk(fieldsToHtml(GOOD_FIELDS));
  const box = buildFullSandbox(fakeWin, fakeDoc, fakeLocalStorage, fakeFetch);
  await box.runBulkUpdate(null, items, '900,000', { setBusy() {}, setProgress() {} });
  const alertMsgs = fakeWin._alerts.filter((a) => a[0] === 'alert').map((a) => a[1]);
  const failMsg = alertMsgs.find((m) => m.indexOf('실패 —') === 0);
  assert.ok(failMsg, '실패 알림을 못 찾았다: ' + JSON.stringify(alertMsgs));
  // s0(시범)+s1(rest[0]) 성공 = 2건, s2(rest[1])에서 실패, s3·s4 미시도.
  assert.match(failMsg, /성공 확인 2건/, 'G1 회귀: 시범(1) + rest 성공(1, s1) = 2건이어야 한다(구 코드는 "1건"으로 셌다)');
  assert.match(failMsg, /확인 필요 1건/);
  assert.match(failMsg, /미시도 2건/, 'G1 회귀: 5건 중 3건(시범+s1+실패한s2) 시도, 2건(s3,s4) 미시도');
});

test('G8(실행검증): processOneItem 내부(G2)는 통과했어도 표시용 재조회가 불일치하면 로그를 unknown 으로 재기록한다', async () => {
  resetLS();
  const items = [{ seq: '7646', itemCode: 'A' }];   // 1건이라도 불일치 판정은 only_one_item 보다 먼저 걸린다
  const goodHtml = fieldsToHtml(GOOD_FIELDS);
  const mismatchHtml = fieldsToHtml(Object.assign({}, GOOD_FIELDS, { goldPrice: '850,000' }));
  const iframe = makeScenario({
    initialFields: GOOD_FIELDS, afterFields: GOOD_FIELDS,
    onClick(ctx) { ctx.succeedTo(GOOD_LANDING, 2); }
  });
  const fakeWin = makeFakeTopWindow([true]);
  const fakeDoc = makeFakeDocumentFor(iframe);
  // 1번째 fetch 호출(processOneItem 내부 G2) = 일치 → 시범 저장은 applied 로 기록된다.
  // 2번째 fetch 호출(runBulkUpdate 의 표시용 재조회) = 불일치 → decideTrialContinuation 이 막는다.
  const fakeFetch = makeFakeFetchSequence([goodHtml, mismatchHtml]);
  const box = buildFullSandbox(fakeWin, fakeDoc, fakeLocalStorage, fakeFetch);
  await box.runBulkUpdate(null, items, '900,000', { setBusy() {}, setProgress() {} });
  const list = readPriceLogListOrRecover();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].status, 'unknown', 'processOneItem 내부는 통과했어도 표시용 재조회 불일치로 unknown 으로 재기록돼야 한다(G8)');
});

/* ── N1 — 이 테스트 파일 자신의 구조 회귀가드 정확도(부분일치 오탐 방지) ─────────── */
test('N1: dataset.ubAutoJob 순서 확인은 정확 일치라 dataset.ubAutoJobXxx 같은 오타를 통과시키지 않는다', () => {
  const good = extractFn(SRC, 'createHiddenFrame');
  assert.match(good, /\bdataset\.ubAutoJob\s*=/);
  const typoed = good.replace('dataset.ubAutoJob =', 'dataset.ubAutoJobXxx =');
  assert.ok(!/\bdataset\.ubAutoJob\s*=/.test(typoed));
});

/* ── 소스 패턴 회귀가드(보조) — 실행 검증이 비현실적인 배선(wiring) 순서만 보조로 고정한다. ── */
test('🔴 changeGoldPrice 를 호출하지 않는다 — calItemPrice(form) 을 직접 호출한다', () => {
  const fn = extractFn(SRC, 'processOneItem');
  assert.ok(!/changeGoldPrice\s*\(/.test(fn));
  assert.match(fn, /win\.calItemPrice\s*\(\s*form\s*\)/);
});
test('🔴 form.submit() 을 직접 호출하지 않는다 — 저장 버튼을 click() 한다', () => {
  const fn = extractFn(SRC, 'processOneItem');
  assert.ok(!/\bform\.submit\s*\(/.test(fn));
  assert.match(fn, /saveBtn\.click\s*\(\)/);
});
test('F2/F4 순서: 재계산 검증 → 사전 dialog 확인 → capturedAlert 리셋 → 클릭 → G2 서버 대조 순으로 배선돼 있다', () => {
  const fn = extractFn(SRC, 'processOneItem');
  const iRc = fn.indexOf('validateRecalc(');
  const iPreDialog = fn.indexOf('if (capturedAlert)');
  const iReset = fn.lastIndexOf('capturedAlert = null;');
  const iClick = fn.indexOf('saveBtn.click()');
  const iVerify = fn.indexOf('verifyAgainstServer(');
  assert.ok(iRc >= 0 && iPreDialog > iRc, 'F2 검증이 사전 dialog 확인보다 먼저여야 한다');
  assert.ok(iPreDialog >= 0 && iReset > iPreDialog, '사전 dialog 확인이 리셋보다 먼저여야 한다');
  assert.ok(iReset >= 0 && iClick > iReset, 'F4 핵심 — capturedAlert 리셋이 클릭 직전이어야 한다');
  assert.ok(iVerify > iClick, 'G2 — 서버 대조는 클릭 뒤여야 한다');
});
test('G7 배선: clickAttempted 플래그가 click() 호출 지점과 catch 분기 둘 다에 쓰인다', () => {
  const fn = extractFn(SRC, 'processOneItem');
  const iSetTrue = fn.indexOf('clickAttempted = true;');
  const iClick = fn.indexOf('saveBtn.click()');
  const iCatchUse = fn.indexOf('clickAttempted ?');
  assert.ok(iSetTrue >= 0 && iSetTrue < iClick, 'clickAttempted 는 click() 호출 전에 true 로 세팅돼야 한다');
  assert.ok(iCatchUse > iClick, 'catch 분기가 clickAttempted 값을 참조해 상태를 갈라야 한다');
});
test('숨은 iframe 은 dataset.ubAutoJob 을 src 보다 먼저 세운다(skin.js 자동화 프레임 가드 순서 불변식)', () => {
  const fn = extractFn(SRC, 'createHiddenFrame');
  const iDataset = fn.search(/\bdataset\.ubAutoJob\s*=/);
  const iAppend = fn.indexOf('appendChild(f)');
  assert.ok(iDataset >= 0 && iAppend >= 0 && iDataset < iAppend);
});
test('G10 배선: runBulkUpdate 는 decision.proceed 를 1차 게이트로 쓴다(개별 reason 분기가 아니라)', () => {
  const fn = extractFn(SRC, 'runBulkUpdate');
  assert.match(fn, /if\s*\(\s*!decision\.proceed\s*\)/, 'decision.proceed 기반 게이트가 없다 — 새 차단 사유가 늘면 진행 쪽으로 샐 수 있다(G10)');
});
test('M13/G8 배선: runBulkUpdate 는 decideTrialContinuation 의 판단과 두 번째 사용자 확인을 모두 거친 뒤에만 나머지를 처리하고, logId 로 로그를 재기록한다', () => {
  const fn = extractFn(SRC, 'runBulkUpdate');
  const iDecide = fn.indexOf('decideTrialContinuation(');
  const iGate = fn.indexOf('if (!decision.proceed)');
  const iLogId = fn.indexOf('r0.logId');
  const iConfirmSecond = fn.indexOf('window.confirm(', fn.indexOf('window.confirm(') + 1);
  const iRunSeq = fn.indexOf('runSequential(');
  assert.ok(iDecide >= 0 && iGate > iDecide);
  assert.ok(iLogId > iGate, 'G8 — logId 재기록 로직이 게이트 안에 있어야 한다');
  assert.ok(iConfirmSecond >= 0 && iRunSeq > iConfirmSecond, 'runSequential(나머지 처리)은 두 번째 확인보다 뒤여야 한다');
});

console.log(`\n${tests.length}건 정의됨 — 순수/실행 하네스 테스트 실행 중...\n`);

let passed = 0;
(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); passed += 1; console.log('PASS', name); }
    catch (error) { console.error('FAIL', name); throw error; }
  }
  console.log(`\nPASS ${passed}/${tests.length} tests`);
})();
