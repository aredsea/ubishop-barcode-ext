/* 계정 전환 진행 문구·짧은 재탐침 회귀 테스트. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const POPUP = fs.readFileSync(path.join(__dirname, '..', 'popup', 'popup.js'), 'utf8');
const BG = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');

function extractFn(src, name, where) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `${where} 에서 ${name} 선언을 찾지 못했습니다`);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} 본문의 중괄호 균형을 찾지 못했습니다`);
}

function extractConst(src, name, where) {
  const match = new RegExp('const\\s+' + name + '\\s*=').exec(src);
  assert.ok(match, `${where} 에서 ${name} 상수를 찾지 못했습니다`);
  let depth = 0;
  for (let i = match.index; i < src.length; i++) {
    const char = src[i];
    if (char === '[' || char === '{' || char === '(') depth += 1;
    else if (char === ']' || char === '}' || char === ')') depth -= 1;
    else if (char === ';' && depth === 0) return src.slice(match.index, i + 1);
  }
  throw new Error(`${name} 선언의 끝을 찾지 못했습니다`);
}

const status = {};
new Function('exports',
  ['failureText', 'terminalText', 'phaseText']
    .map(name => extractConst(POPUP, name, 'popup.js')).join('\n') + '\n' +
  extractFn(POPUP, 'flowStatusText', 'popup.js') + '\n' +
  'exports.flowStatusText = flowStatusText;'
)(status);

test('active submitted 5초는 진행 중 문구이며 지연 안내가 없다', () => {
  const now = 100000;
  const text = status.flowStatusText({ active: true, phase: 'submitted', startedAt: now - 5000 }, now);
  assert.equal(text, '로그인 제출됨 · 결과 확인 중 · 5초 경과');
  assert.equal(text.includes('예상보다 오래 걸립니다'), false);
});

test('active 25초는 예상보다 오래 걸린다는 안내를 포함한다', () => {
  const now = 100000;
  const text = status.flowStatusText({ active: true, phase: 'loggingOut', startedAt: now - 25000 }, now);
  assert.equal(text, '로그아웃 중 · 25초 경과 · 예상보다 오래 걸립니다 — 그대로 두시면 자동으로 계속됩니다');
  assert.equal(text.includes('예상보다 오래 걸립니다'), true);
});

test('inactive 실패는 기존 실패 문구를 유지한다', () => {
  const text = status.flowStatusText({ active: false, lastFailureCode: 'wrong_account' }, Date.now());
  assert.equal(text, '다른 계정으로 로그인됨');
});

test('Phase 5 전용 실패 코드는 사용자의 다음 행동을 정확히 안내한다', () => {
  assert.equal(
    status.flowStatusText({ active: false, lastFailureCode: 'logout_no_effect' }, Date.now()),
    '로그아웃이 되지 않았습니다 — 직접 로그아웃한 뒤 다시 시도하세요'
  );
  assert.equal(
    status.flowStatusText({ active: false, lastFailureCode: 'pms_entry_bounced' }, Date.now()),
    'PMS 진입이 거부됐습니다 — PMS 버튼을 직접 눌러 주세요'
  );
});

test('flow가 없으면 문구도 없다', () => {
  assert.equal(status.flowStatusText(null, Date.now()), null);
});

test('ubQuickRepoll은 1·2·4초 타이머로 같은 flow를 세 번 재탐침한다', () => {
  const scheduled = [];
  const calls = [];
  const quick = {};
  new Function('exports', 'setTimeout', 'ubStep',
    extractFn(BG, 'ubQuickRepoll', 'background.js') + '\n' +
    'exports.ubQuickRepoll = ubQuickRepoll;'
  )(quick, (fn, ms) => { scheduled.push({ fn, ms }); }, (tabId, flowId) => calls.push({ tabId, flowId }));

  quick.ubQuickRepoll(7, 'flow-1');
  assert.deepEqual(scheduled.map(item => item.ms), [1000, 2000, 4000]);
  scheduled.forEach(item => item.fn());
  assert.deepEqual(calls, [
    { tabId: 7, flowId: 'flow-1' },
    { tabId: 7, flowId: 'flow-1' },
    { tabId: 7, flowId: 'flow-1' }
  ]);
});

test('ubAcctDiag는 비밀 없이 현재 flow와 watchdog 예약 상태를 돌려준다', async () => {
  const now = Date.now();
  const storedFlow = {
    active: true, phase: 'toLogin', startedAt: now - 8000, enteredAt: now - 3000,
    lastFailureCode: null, terminalReason: null, attempts: { loggingOut: 1 },
    accountId: 'secret-user-id', submittedFor: 'secret-user-id'
  };
  const chrome = {
    storage: { local: { async get(keys) {
      if (keys === 'ubLoginFlow') return { ubLoginFlow: storedFlow };
      return { ubAccounts: [], ubLoginSalt: '' };
    } } },
    alarms: { async get(name) { return name === 'ubWatchdog' ? { name } : null; } }
  };
  const diag = {};
  new Function('exports', 'chrome', 'ubDecrypt',
    "const UB_WATCHDOG = 'ubWatchdog';\n" +
    extractFn(BG, 'ubAcctDiag', 'background.js') + '\n' +
    'exports.ubAcctDiag = ubAcctDiag;'
  )(diag, chrome, async () => { throw new Error('복호화가 호출되면 안 됩니다'); });

  const out = await diag.ubAcctDiag();
  assert.equal(out.flow.active, true);
  assert.equal(out.flow.phase, 'toLogin');
  assert.deepEqual(out.flow.attempts, { loggingOut: 1 });
  assert.ok(out.flow.ageMs >= 3000);
  assert.equal(out.watchdogScheduled, true);
  assert.equal(JSON.stringify(out).includes('secret-user-id'), false);
});
