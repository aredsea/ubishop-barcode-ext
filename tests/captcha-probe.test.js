// captcha-probe.test.js — UB_PROBE 의 캡차 게이트를 가짜 DOM 에서 실행 검증한다.
// 서버 원본에는 캡차 입력이 먼저 보이고 ready 핸들러가 나중에 숨기므로, 가시성이 아니라
// 사이트 정본인 #fcount 를 우선해야 한다. 구조가 바뀌어 fcount 가 없을 때만 엄격히 보이는
// 캡차 요소를 폴백으로 인정한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const BG = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `background.js 에서 ${name} 선언을 찾지 못했습니다`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} 함수의 닫는 중괄호를 찾지 못했습니다`);
}

const PROBE_SOURCE = extractFn(BG, 'UB_PROBE');

function element(options = {}) {
  const rect = options.rect || { width: 120, height: 24 };
  return {
    value: options.value,
    form: options.form,
    offsetParent: options.offsetParent === undefined ? {} : options.offsetParent,
    ownerDocument: null,
    textContent: options.textContent || '',
    href: options.href || '',
    getAttribute(name) { return name === 'href' ? (options.href || '') : null; },
    getClientRects() { return options.hasRects === false ? [] : [rect]; },
    getBoundingClientRect() { return rect; },
    computedStyle: {
      visibility: options.visibility || 'visible',
      opacity: options.opacity === undefined ? '1' : String(options.opacity)
    }
  };
}

function fixture(options = {}) {
  const form = {};
  const pw = element({ form });
  const fcount = options.fcount === undefined ? null : element({ value: options.fcount });
  const captcha = options.captcha ? element(options.captcha) : null;
  const bframe = options.bframe ? element(options.bframe) : null;
  const map = new Map([
    ['input[name="sysUser.fpasswd"]', pw],
    ['input[type=password]', pw],
    ['#fcount', fcount],
    ['input[name="comSysLoginCheck.fcount"]', fcount],
    ['input[name="sysUser.fcaptcha"]', captcha],
    ['iframe[src*="recaptcha/api2/bframe" i]', bframe]
  ]);
  const defaultView = { getComputedStyle: el => el.computedStyle };
  const document = {
    defaultView,
    querySelector: selector => map.get(selector) || null,
    querySelectorAll: selector => selector === 'a[href]' ? [] : []
  };
  for (const el of [pw, fcount, captcha, bframe]) if (el) el.ownerDocument = document;
  return { document, defaultView };
}

function runProbe(source, options) {
  const { document, defaultView } = fixture(options);
  const location = {
    href: 'https://www.honsu114.com/mall/login.ubs',
    hostname: 'www.honsu114.com',
    pathname: '/mall/login.ubs'
  };
  const silentConsole = { log() {} };
  // eslint-disable-next-line no-new-func
  return new Function('document', 'location', 'window', 'console',
    `${source}\nreturn UB_PROBE();`)(document, location, defaultView, silentConsole);
}

const cases = {
  readyRace: { fcount: '0', captcha: {} },
  accumulatedFailure: { fcount: '3', captcha: { visibility: 'hidden' } },
  fallbackVisible: { captcha: {} },
  fallbackVisibilityHidden: { captcha: { visibility: 'hidden' } },
  fallbackTransparentBframe: { bframe: { opacity: 0 } }
};

test('#fcount="0"이면 ready 전 캡차 입력이 보여도 captcha=false', () => {
  assert.equal(runProbe(PROBE_SOURCE, cases.readyRace).captcha, false);
});

test('#fcount="3"이면 가시성과 무관하게 captcha=true', () => {
  assert.equal(runProbe(PROBE_SOURCE, cases.accumulatedFailure).captcha, true);
});

test('#fcount가 없고 캡차 입력이 보이면 폴백으로 captcha=true', () => {
  assert.equal(runProbe(PROBE_SOURCE, cases.fallbackVisible).captcha, true);
});

test('#fcount가 없고 캡차 입력이 visibility:hidden이면 captcha=false', () => {
  assert.equal(runProbe(PROBE_SOURCE, cases.fallbackVisibilityHidden).captcha, false);
});

test('#fcount가 없고 bframe이 opacity:0이면 captcha=false', () => {
  assert.equal(runProbe(PROBE_SOURCE, cases.fallbackTransparentBframe).captcha, false);
});

function mutateOnce(source, from, to, label) {
  assert.ok(source.includes(from), `${label}: 변이 대상 내용을 찾지 못했습니다`);
  const mutant = source.replace(from, to);
  assert.notEqual(mutant, source, `${label}: 원본과 변이본 내용이 같아서는 안 됩니다`);
  assert.ok(mutant.includes(to), `${label}: 요청한 내용으로 치환되지 않았습니다`);
  return mutant;
}

test('변이: fcount 분기를 지우고 가시성만 보면 ready 경쟁 케이스가 죽는다', () => {
  const gate = `  let captcha;
  if (fcount !== null) {
    captcha = fcount !== '' && fcount !== '0';   // 사이트 기준: 실패 횟수가 0 이 아니면 캡차 필요
  } else {
    // #fcount 를 못 찾았다 = 페이지 구조가 바뀌었다. 그때만 가시성 폴백을 쓴다.
    captcha = visStrict(q('input[name="sysUser.fcaptcha"]')) || visStrict(q('iframe[src*="recaptcha/api2/bframe" i]'));
  }`;
  const visibleOnly = `  let captcha;
  captcha = visStrict(q('input[name="sysUser.fcaptcha"]')) || visStrict(q('iframe[src*="recaptcha/api2/bframe" i]'));`;
  const mutant = mutateOnce(PROBE_SOURCE, gate, visibleOnly, '가시성 전용 변이');
  assert.equal(runProbe(PROBE_SOURCE, cases.readyRace).captcha, false);
  assert.equal(runProbe(mutant, cases.readyRace).captcha, true);
});

test('변이: visStrict visibility 검사를 제거하면 hidden 폴백 케이스가 죽는다', () => {
  const check = "    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;";
  const mutant = mutateOnce(PROBE_SOURCE, check, '    // MUTANT: visibility 검사 제거', 'visibility 제거 변이');
  assert.equal(runProbe(PROBE_SOURCE, cases.fallbackVisibilityHidden).captcha, false);
  assert.equal(runProbe(mutant, cases.fallbackVisibilityHidden).captcha, true);
});

test("변이: fcount !== '0'을 fcount === '0'으로 뒤집으면 두 fcount 케이스가 죽는다", () => {
  const mutant = mutateOnce(PROBE_SOURCE,
    "fcount !== '' && fcount !== '0'",
    "fcount !== '' && fcount === '0'",
    'fcount 조건 반전 변이');
  assert.equal(runProbe(PROBE_SOURCE, cases.readyRace).captcha, false);
  assert.equal(runProbe(mutant, cases.readyRace).captcha, true);
  assert.equal(runProbe(PROBE_SOURCE, cases.accumulatedFailure).captcha, true);
  assert.equal(runProbe(mutant, cases.accumulatedFailure).captcha, false);
});
