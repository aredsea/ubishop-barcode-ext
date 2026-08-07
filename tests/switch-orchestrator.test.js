/* 계정 전환 오케스트레이터 실행 회귀 테스트. */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { decide, normalizeProbe } = require('../src/fsm.js');

const BG = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');

function extractFn(src, name, where) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `${where} 에서 ${name} 선언을 찾지 못했습니다`);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
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

let storageState = {};
const alarms = new Map();
let executeScript = async () => [{ result: fullProbe() }];
let updateTab = async () => ({});

const fakeChrome = {
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === 'string') return { [keys]: storageState[keys] };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, storageState[key]]));
        const result = { ...(keys || {}) };
        for (const key of Object.keys(result)) {
          if (Object.prototype.hasOwnProperty.call(storageState, key)) result[key] = storageState[key];
        }
        return result;
      },
      async set(values) { Object.assign(storageState, values); }
    }
  },
  alarms: {
    create(name, info) { alarms.set(name, { ...info }); },
    clear(name) { alarms.delete(name); return Promise.resolve(true); }
  },
  scripting: { executeScript: options => executeScript(options) },
  tabs: { update: (tabId, options) => updateTab(tabId, options) }
};

const BG_CONSTS = [
  'UB_LOGIN_URL', 'UB_WATCHDOG', 'ubLog', 'ubGetFlow', 'ubSetFlow', 'ubNormName',
  '_ubStepInFlight'
];
const BG_FNS = [
  'UB_PROBE', 'UB_DO_LOGOUT', 'UB_SWITCH_OVERLAY', 'UB_BIND_SWITCH_OVERLAY',
  'UB_REMOVE_SWITCH_OVERLAY', 'UB_FILL_LOGIN', 'ubExec', 'ubShowSwitchOverlay',
  'ubRemoveSwitchOverlay', 'ubMatchAccount', 'ubAccount',
  'ubSaveLoginName', 'ubArmWatchdog', 'ubClearWatchdog', 'ubObservedPage', 'ubTransition',
  'ubTerminal', 'ubApplyDecision', 'ubStep', 'ubOnWatchdogAlarm', 'ubCancelSwitch'
];
const bg = {};

// eslint-disable-next-line no-new-func
new Function('exports', 'chrome', 'crypto', 'console', 'normalizeProbe', 'decide',
  'ubDecrypt', 'ubForeignProbe', 'ubUpgradeFlow', 'ubQuickRepoll',
  BG_CONSTS.map(name => extractConst(BG, name, 'background.js')).join('\n') + '\n' +
  'let _ubActiveFlowId = null;\n' +
  BG_FNS.map(name => extractFn(BG, name, 'background.js')).join('\n') + '\n' +
  [...BG_CONSTS, ...BG_FNS].map(name => `exports.${name} = ${name};`).join('\n') + '\n' +
  'exports.setActiveFlowId = value => { _ubActiveFlowId = value; };'
)(bg, fakeChrome, { randomUUID: () => 'generated-flow' }, { log() {} }, normalizeProbe, decide,
  async () => 'test-password', async () => null, async flow => flow, () => {});

function fullProbe(patch) {
  return {
    host: 'www.honsu114.com', url: 'https://www.honsu114.com/mall/main.ubs', path: '/mall/main.ubs',
    hasForm: false, hasLogout: false, hasPms: false, pmsHref: null, captcha: false,
    loginName: '', ambiguous: false, ...(patch || {})
  };
}

function activeFlow(patch) {
  const now = Date.now();
  return {
    active: true, flowId: 'flow-1', accountId: 'user-b', targetLoginName: 'B', tabId: 7,
    phase: 'submitted', enteredAt: now, startedAt: now, attempts: {}, submittedFor: 'user-b',
    lastObservedPage: null, lastTransition: null, lastFailureCode: null, terminalReason: null,
    ...(patch || {})
  };
}

function reset(state) {
  storageState = state || {};
  alarms.clear();
  for (const key of Object.keys(bg._ubStepInFlight)) delete bg._ubStepInFlight[key];
  bg.setActiveFlowId(null);
  executeScript = async () => [{ result: fullProbe() }];
  updateTab = async () => ({});
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('wait 결정은 30초 주기 watchdog을 예약한다', async () => {
  const flow = activeFlow();
  reset({ ubLoginFlow: flow });
  bg.setActiveFlowId(flow.flowId);
  await bg.ubApplyDecision(flow, fullProbe(), { action: 'wait' }, Date.now());
  assert.deepEqual(alarms.get(bg.UB_WATCHDOG), { periodInMinutes: 0.5 });
});

test('in-flight 가드 뒤에도 낡은 좀비는 다음 알람에서 복구되어 탐침한다', async () => {
  const flow = activeFlow();
  reset({ ubLoginFlow: flow });
  let probes = 0;
  executeScript = async () => { probes += 1; return [{ result: fullProbe() }]; };
  bg._ubStepInFlight[flow.flowId] = { startedAt: Date.now() };
  await bg.ubStep(flow.tabId, flow.flowId);
  assert.equal(probes, 0, '살아 있는 in-flight 가드를 무시했습니다');
  bg._ubStepInFlight[flow.flowId] = { startedAt: Date.now() - 45001 };
  await bg.ubOnWatchdogAlarm({ name: bg.UB_WATCHDOG });
  assert.equal(probes, 1, '45초 지난 좀비가 다음 알람에서도 탐침을 막았습니다');
  assert.ok(alarms.has(bg.UB_WATCHDOG), 'wait 뒤 watchdog이 유지되지 않았습니다');
});

test('fillLogin 거부는 즉시 실패하고 반환 사유를 flow에 남긴다', async () => {
  const flow = activeFlow({ phase: 'toLogin', submittedFor: null });
  reset({ ubLoginFlow: flow, ubAccounts: [{ id: 'account-b', userid: 'user-b', loginName: 'B' }] });
  bg.setActiveFlowId(flow.flowId);
  executeScript = async () => [{ result: { submitted: false, reason: 'readback_mismatch' } }];
  await bg.ubApplyDecision(flow, fullProbe({ hasForm: true }), {
    action: 'fillLogin', nextPhase: 'submitted', setSubmittedFor: 'user-b'
  }, Date.now());
  assert.equal(storageState.ubLoginFlow.active, false);
  assert.equal(storageState.ubLoginFlow.phase, 'failed');
  assert.equal(storageState.ubLoginFlow.lastFailureCode, 'readback_mismatch');
});

test('로그인 executeScript reject는 login_injection_failed로 끝난다', async () => {
  const flow = activeFlow({ phase: 'toLogin', submittedFor: null });
  reset({ ubLoginFlow: flow, ubAccounts: [{ id: 'account-b', userid: 'user-b', loginName: 'B' }] });
  bg.setActiveFlowId(flow.flowId);
  executeScript = async () => { throw new Error('tab disappeared'); };
  await bg.ubApplyDecision(flow, fullProbe({ hasForm: true }), {
    action: 'fillLogin', nextPhase: 'submitted', setSubmittedFor: 'user-b'
  }, Date.now());
  assert.equal(storageState.ubLoginFlow.active, false);
  assert.equal(storageState.ubLoginFlow.lastFailureCode, 'login_injection_failed');
  assert.equal(storageState.ubLoginFlow.terminalReason, 'exec_failed');
});

test('로그아웃 executeScript reject는 logout_injection_failed로 끝난다', async () => {
  const flow = activeFlow({ phase: 'start', submittedFor: null });
  reset({ ubLoginFlow: flow });
  bg.setActiveFlowId(flow.flowId);
  executeScript = async () => { throw new Error('cannot inject'); };
  await bg.ubApplyDecision(flow, fullProbe({ hasLogout: true, loginName: 'A' }), {
    action: 'logout', nextPhase: 'loggingOut'
  }, Date.now());
  assert.equal(storageState.ubLoginFlow.active, false);
  assert.equal(storageState.ubLoginFlow.lastFailureCode, 'logout_injection_failed');
});

test('로그아웃 수단이 없으면 logout_no_effect로 즉시 끝난다', async () => {
  const flow = activeFlow({ phase: 'start', submittedFor: null });
  reset({ ubLoginFlow: flow });
  bg.setActiveFlowId(flow.flowId);
  executeScript = async options => options.func === bg.UB_DO_LOGOUT
    ? [{ result: { via: 'none' } }]
    : [{ result: {} }];
  await bg.ubApplyDecision(flow, fullProbe({ hasLogout: true, loginName: 'A' }), {
    action: 'logout', nextPhase: 'loggingOut'
  }, Date.now());
  assert.equal(storageState.ubLoginFlow.active, false);
  assert.equal(storageState.ubLoginFlow.phase, 'failed');
  assert.equal(storageState.ubLoginFlow.lastFailureCode, 'logout_no_effect');
  assert.equal(storageState.ubLoginFlow.terminalReason, 'logout_no_effect');
});

test('로그아웃 링크를 실행했으면 흐름을 유지한다', async () => {
  const flow = activeFlow({ phase: 'start', submittedFor: null });
  reset({ ubLoginFlow: flow });
  bg.setActiveFlowId(flow.flowId);
  executeScript = async options => options.func === bg.UB_DO_LOGOUT
    ? [{ result: { via: 'link', navigated: true } }]
    : [{ result: {} }];
  await bg.ubApplyDecision(flow, fullProbe({ hasLogout: true, loginName: 'A' }), {
    action: 'logout', nextPhase: 'loggingOut'
  }, Date.now());
  assert.equal(storageState.ubLoginFlow.active, true);
  assert.equal(storageState.ubLoginFlow.phase, 'loggingOut');
});

test('로그아웃 주입 결과가 없어도 호환성을 위해 흐름을 유지한다', async () => {
  const flow = activeFlow({ phase: 'start', submittedFor: null });
  reset({ ubLoginFlow: flow });
  bg.setActiveFlowId(flow.flowId);
  executeScript = async options => options.func === bg.UB_DO_LOGOUT
    ? [{ result: undefined }]
    : [{ result: {} }];
  await bg.ubApplyDecision(flow, fullProbe({ hasLogout: true, loginName: 'A' }), {
    action: 'logout', nextPhase: 'loggingOut'
  }, Date.now());
  assert.equal(storageState.ubLoginFlow.active, true);
  assert.equal(storageState.ubLoginFlow.phase, 'loggingOut');
});

test('탭 네비게이션 reject는 기다리지 않고 tab_gone으로 끝난다', async () => {
  const flow = activeFlow({ phase: 'loggingOut', submittedFor: null });
  reset({ ubLoginFlow: flow });
  bg.setActiveFlowId(flow.flowId);
  updateTab = async () => { throw new Error('No tab with id'); };
  await bg.ubApplyDecision(flow, fullProbe(), {
    action: 'navigateLogin', nextPhase: 'toLogin'
  }, Date.now());
  assert.equal(storageState.ubLoginFlow.active, false);
  assert.equal(storageState.ubLoginFlow.lastFailureCode, 'tab_gone');
});

test('target_login_bootstrapped 성공은 관측 이름을 계정에 학습하지 않는다', async () => {
  const flow = activeFlow({ targetLoginName: null });
  reset({ ubLoginFlow: flow, ubAccounts: [{ id: 'account-b', userid: 'user-b', loginName: '' }] });
  bg.setActiveFlowId(flow.flowId);
  const probe = fullProbe({ hasLogout: true, loginName: '이전 계정' });
  const decision = decide(flow, probe, Date.now());
  assert.equal(decision.terminalReason, 'target_login_bootstrapped');
  await bg.ubApplyDecision(flow, probe, decision, Date.now());
  assert.equal(storageState.ubLoginFlow.phase, 'done');
  assert.equal(storageState.ubAccounts[0].loginName, '');
});

test('끝난 flow에서 watchdog이 발화하면 알람을 스스로 해제한다', async () => {
  reset({ ubLoginFlow: activeFlow({ active: false, phase: 'done' }) });
  bg.ubArmWatchdog();
  assert.ok(alarms.has(bg.UB_WATCHDOG));
  await bg.ubOnWatchdogAlarm({ name: bg.UB_WATCHDOG });
  assert.equal(alarms.has(bg.UB_WATCHDOG), false);
});

test('오버레이 주입 뒤 저장된 흐름이 끝났으면 방금 만든 오버레이를 제거한다', async () => {
  const staleFlow = activeFlow();
  reset({ ubLoginFlow: { ...staleFlow, active: false, phase: 'done' } });
  const injected = [];
  executeScript = async options => { injected.push(options.func); return [{ result: {} }]; };
  await bg.ubShowSwitchOverlay(staleFlow);
  assert.ok(injected.includes(bg.UB_REMOVE_SWITCH_OVERLAY));
});

test('오버레이 주입 뒤 같은 active flow가 유지되면 제거하지 않는다', async () => {
  const flow = activeFlow();
  reset({ ubLoginFlow: flow });
  const injected = [];
  executeScript = async options => { injected.push(options.func); return [{ result: {} }]; };
  await bg.ubShowSwitchOverlay(flow);
  assert.equal(injected.includes(bg.UB_REMOVE_SWITCH_OVERLAY), false);
});

test('오버레이 주입 뒤 flowId가 바뀌었으면 방금 만든 오버레이를 제거한다', async () => {
  const staleFlow = activeFlow();
  reset({ ubLoginFlow: activeFlow({ flowId: 'flow-2' }) });
  const injected = [];
  executeScript = async options => { injected.push(options.func); return [{ result: {} }]; };
  await bg.ubShowSwitchOverlay(staleFlow);
  assert.ok(injected.includes(bg.UB_REMOVE_SWITCH_OVERLAY));
});

test('오버레이 취소 메시지는 active flow를 user_cancelled로 끝낸다', async () => {
  const flow = activeFlow({ phase: 'loggingOut' });
  reset({ ubLoginFlow: flow });
  await bg.ubCancelSwitch({ flowId: flow.flowId, mode: 'cancel' }, { tab: { id: flow.tabId } });
  assert.equal(storageState.ubLoginFlow.active, false);
  assert.equal(storageState.ubLoginFlow.phase, 'failed');
  assert.equal(storageState.ubLoginFlow.lastFailureCode, 'user_cancelled');
  assert.equal(storageState.ubLoginFlow.terminalReason, 'user_cancelled');
  assert.equal(alarms.has(bg.UB_WATCHDOG), false);
});

test('취소 뒤 진행 중이던 같은 flow는 로그인을 주입하거나 흐름을 되살리지 않는다', async () => {
  const storedFlow = activeFlow({ phase: 'toLogin', submittedFor: null });
  const decisionFlow = { ...storedFlow, attempts: { ...storedFlow.attempts } };
  reset({
    ubLoginFlow: storedFlow,
    ubAccounts: [{ id: 'account-b', userid: 'user-b', loginName: 'B' }]
  });
  bg.setActiveFlowId(storedFlow.flowId);
  const injected = [];
  executeScript = async options => {
    injected.push(options.func);
    if (options.func === bg.UB_FILL_LOGIN) return [{ result: { submitted: true } }];
    return [{ result: {} }];
  };

  await bg.ubCancelSwitch(
    { flowId: storedFlow.flowId, mode: 'cancel' },
    { tab: { id: storedFlow.tabId } }
  );
  await bg.ubApplyDecision(decisionFlow, fullProbe({ hasForm: true }), {
    action: 'fillLogin', nextPhase: 'submitted', setSubmittedFor: 'user-b'
  }, Date.now());

  assert.equal(injected.includes(bg.UB_FILL_LOGIN), false);
  assert.equal(storageState.ubLoginFlow.active, false);
});

test('취소하지 않은 정상 flow는 로그인을 주입한다', async () => {
  const flow = activeFlow({ phase: 'toLogin', submittedFor: null });
  reset({
    ubLoginFlow: flow,
    ubAccounts: [{ id: 'account-b', userid: 'user-b', loginName: 'B' }]
  });
  bg.setActiveFlowId(flow.flowId);
  const injected = [];
  executeScript = async options => {
    injected.push(options.func);
    if (options.func === bg.UB_FILL_LOGIN) return [{ result: { submitted: true } }];
    return [{ result: {} }];
  };

  await bg.ubApplyDecision(flow, fullProbe({ hasForm: true }), {
    action: 'fillLogin', nextPhase: 'submitted', setSubmittedFor: 'user-b'
  }, Date.now());

  assert.equal(injected.includes(bg.UB_FILL_LOGIN), true);
});

test('ubStep의 예상 밖 예외는 orchestrator_error terminal로 기록한다', async () => {
  const badAccountId = { toString() { throw new Error('unexpected'); } };
  const flow = activeFlow({ phase: 'start', accountId: badAccountId, submittedFor: null });
  reset({ ubLoginFlow: flow });
  await bg.ubStep(flow.tabId, flow.flowId);
  assert.equal(storageState.ubLoginFlow.active, false);
  assert.equal(storageState.ubLoginFlow.phase, 'failed');
  assert.equal(storageState.ubLoginFlow.lastFailureCode, 'orchestrator_error');
});

test('대상 로그인 확인 후 PMS 링크가 없으면 유예 뒤 pms_link_missing으로 실패한다', () => {
  const now = Date.now();
  const flow = activeFlow({ enteredAt: now, startedAt: now });
  const probe = fullProbe({ hasLogout: true, loginName: 'B' });
  assert.equal(decide(flow, probe, now + 100).action, 'wait');
  const expired = decide(flow, probe, now + 45001);
  assert.equal(expired.action, 'fail');
  assert.equal(expired.failureCode, 'pms_link_missing');
});

test('start에서 이미 대상 계정이고 PMS 링크가 없어도 already_target 성공을 유지한다', () => {
  const flow = activeFlow({ phase: 'start', submittedFor: null });
  const result = decide(flow, fullProbe({ hasLogout: true, loginName: 'B' }), Date.now());
  assert.equal(result.action, 'skip');
  assert.equal(result.terminalReason, 'already_target');
});

let passed = 0;
(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); passed += 1; console.log('PASS', name); }
    catch (error) { console.error('FAIL', name); throw error; }
  }
  console.log(`PASS ${passed}/${tests.length} tests`);
})();
