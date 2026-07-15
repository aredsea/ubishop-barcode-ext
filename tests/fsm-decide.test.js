const assert = require('node:assert');
const { decide, normalizeProbe, DEADLINE } = require('../src/fsm.js');

function probe(patch) {
  return {
    host: 'www.honsu114.com',
    url: 'https://www.honsu114.com/',
    path: '/',
    hasForm: false,
    hasLogout: false,
    hasPms: false,
    pmsHref: null,
    captcha: false,
    loginName: '',
    ambiguous: false,
    ...(patch || {})
  };
}

function flow(phase, patch) {
  return {
    phase,
    enteredAt: 0,
    startedAt: 0,
    attempts: {},
    submittedFor: null,
    accountId: 'B',
    ...(patch || {})
  };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('normalizeProbe marks null and partial probes ambiguous', () => {
  assert.equal(normalizeProbe(null).ambiguous, true);
  assert.equal(normalizeProbe({ hasForm: true }).ambiguous, true);
  assert.equal(normalizeProbe(probe()).ambiguous, false);
});

test('scenario 1: normal A to B follows observed transitions into PMS', () => {
  let result = decide(flow('start'), probe({ hasLogout: true, loginName: 'A' }), 100);
  assert.equal(result.action, 'logout');
  assert.equal(result.nextPhase, 'loggingOut');

  result = decide(flow('loggingOut'), probe(), 200);
  assert.equal(result.action, 'navigateLogin');
  assert.equal(result.nextPhase, 'toLogin');

  result = decide(flow('toLogin'), probe({ path: '/mall/login.ubs', hasForm: true }), 300);
  assert.equal(result.action, 'fillLogin');
  assert.equal(result.nextPhase, 'submitted');
  assert.equal(result.setSubmittedFor, 'B');

  result = decide(flow('submitted', { submittedFor: 'B' }), probe({ hasLogout: true, loginName: ' b ', pmsHref: 'https://pms.example/' }), 400);
  assert.equal(result.action, 'navigatePms');
  assert.equal(result.nextPhase, 'enteringPms');

  result = decide(flow('enteringPms', { submittedFor: 'B' }), probe({ host: 'ubdstore.ubshop.biz', url: 'https://ubdstore.ubshop.biz/', hasPms: true }), 500);
  assert.equal(result.action, 'succeed');
});

test('scenario 2: submitted form reappearance fails without resubmission', () => {
  const result = decide(flow('submitted', { submittedFor: 'B' }), probe({ path: '/mall/login.ubs', hasForm: true }), 100);
  assert.equal(result.action, 'fail');
  assert.equal(result.failureCode, 'login_reappeared');
  assert.equal(result.setSubmittedFor, undefined);
});

test('scenario 3: captcha on a login form fails immediately', () => {
  const result = decide(flow('toLogin'), probe({ path: '/mall/login.ubs', hasForm: true, captcha: true }), 100);
  assert.equal(result.action, 'fail');
  assert.equal(result.failureCode, 'captcha');
});

test('scenario 4: blank navigation reaches a phase deadline', () => {
  const result = decide(flow('toLogin'), probe(), DEADLINE.toLogin + 1);
  assert.equal(result.action, 'fail');
  assert.equal(result.failureCode, 'nav_timeout');
});

test('scenario 4: overall flow deadline is enforced independently', () => {
  const result = decide(flow('toLogin', { enteredAt: DEADLINE.flow - 1000 }), probe(), DEADLINE.flow + 1);
  assert.equal(result.action, 'fail');
  assert.equal(result.terminalReason, 'flow_deadline');
});

test('observed target postcondition wins at the overall deadline', () => {
  const result = decide(
    flow('submitted', { submittedFor: 'B', enteredAt: DEADLINE.flow - 1000 }),
    probe({ hasLogout: true, loginName: 'B' }),
    DEADLINE.flow + 1
  );
  assert.equal(result.action, 'succeed');
});

test('scenario 5: conflicting signals wait then fail ambiguous_page', () => {
  const conflict = probe({ hasForm: true, hasLogout: true });
  assert.equal(decide(flow('loggingOut'), conflict, 100).action, 'wait');
  const expired = decide(flow('loggingOut'), conflict, DEADLINE.loggingOut + 1);
  assert.equal(expired.action, 'fail');
  assert.equal(expired.failureCode, 'ambiguous_page');
});

test('scenario 5: normalized partial probe never advances', () => {
  assert.equal(decide(flow('toLogin'), { hasForm: false }, 100).action, 'wait');
  const expired = decide(flow('toLogin'), { hasForm: false }, DEADLINE.toLogin + 1);
  assert.equal(expired.failureCode, 'ambiguous_page');
});

test('scenario 6: submitted login under another account fails', () => {
  const result = decide(flow('submitted', { submittedFor: 'B', targetLoginName: 'B' }), probe({ hasLogout: true, loginName: 'C' }), 100);
  assert.equal(result.action, 'fail');
  assert.equal(result.failureCode, 'wrong_account');
});

test('first submitted login bootstraps an unknown targetLoginName', () => {
  const result = decide(
    flow('submitted', { accountId: '홍해진@디102', submittedFor: '홍해진@디102' }),
    probe({ hasLogout: true, loginName: '홍해진' }),
    100
  );
  assert.equal(result.action, 'succeed');
  assert.equal(result.terminalReason, 'target_login_bootstrapped');
  assert.notEqual(result.failureCode, 'wrong_account');
});

test('scenario 7: resumed submitted flow trusts live target evidence', () => {
  const withPms = decide(flow('submitted', { submittedFor: 'B' }), probe({ hasLogout: true, loginName: 'B', pmsHref: 'https://pms.example/' }), 100);
  assert.equal(withPms.action, 'navigatePms');
  const withoutPms = decide(flow('submitted', { submittedFor: 'B' }), probe({ hasLogout: true, loginName: 'B' }), 100);
  assert.equal(withoutPms.action, 'succeed');
});

test('targetLoginName verifies display identity without changing submittedFor accountId', () => {
  const result = decide(
    flow('submitted', { accountId: 'userid-b', targetLoginName: 'Shop B', submittedFor: 'userid-b' }),
    probe({ hasLogout: true, loginName: ' shop b ' }),
    100
  );
  assert.equal(result.action, 'succeed');
});

test('scenario 7: resumed submitted flow never fills a reappeared form', () => {
  const result = decide(flow('submitted', { submittedFor: 'B' }), probe({ path: '/mall/login.ubs', hasForm: true }), 100);
  assert.equal(result.failureCode, 'login_reappeared');
  assert.notEqual(result.action, 'fillLogin');
});

test('scenario 7: submitted phase never resubmits when submittedFor was lost', () => {
  const result = decide(flow('submitted'), probe({ path: '/mall/login.ubs', hasForm: true }), 100);
  assert.equal(result.action, 'fail');
  assert.equal(result.failureCode, 'login_reappeared');
});

test('scenario 7: submitted phase rejects a wrong account when submittedFor was lost', () => {
  const result = decide(flow('submitted', { targetLoginName: 'B' }), probe({ hasLogout: true, loginName: 'C' }), 100);
  assert.equal(result.action, 'fail');
  assert.equal(result.failureCode, 'wrong_account');
});

test('scenario 8: unrelated host aborts instead of navigating blindly', () => {
  const result = decide(flow('loggingOut'), probe({ host: 'example.com', url: 'https://example.com/' }), 100);
  assert.equal(result.action, 'fail');
  assert.equal(result.failureCode, 'ambiguous_page');
  assert.equal(result.terminalReason, 'unrelated_host');
});

test('scenario 8: unrelated page during logout aborts instead of navigating blindly', () => {
  const result = decide(flow('loggingOut'), probe({
    url: 'https://www.honsu114.com/mall/orders.ubs',
    path: '/mall/orders.ubs'
  }), 100);
  assert.equal(result.action, 'fail');
  assert.equal(result.failureCode, 'ambiguous_page');
  assert.equal(result.terminalReason, 'unrelated_page');
});

test('scenario 9: start on the target account skips logout', () => {
  const withPms = decide(flow('start'), probe({ hasLogout: true, loginName: 'B', pmsHref: 'https://pms.example/' }), 100);
  assert.equal(withPms.action, 'navigatePms');
  const withoutPms = decide(flow('start'), probe({ hasLogout: true, loginName: 'B' }), 100);
  assert.equal(withoutPms.action, 'skip');
});

test('start with an unknown targetLoginName does not skip the current login', () => {
  const result = decide(
    flow('start', { accountId: '홍해진@디102' }),
    probe({ hasLogout: true, loginName: '홍해진' }),
    100
  );
  assert.equal(result.action, 'logout');
});

test('submitted login without an observable name waits then fails ambiguous', () => {
  const loggedInWithoutName = probe({ hasLogout: true, loginName: '' });
  assert.equal(decide(flow('submitted', { submittedFor: 'B' }), loggedInWithoutName, 100).action, 'wait');
  const expired = decide(flow('submitted', { submittedFor: 'B' }), loggedInWithoutName, DEADLINE.submitted + 1);
  assert.equal(expired.failureCode, 'ambiguous_page');
});

test('submitted login without an observable name stays ambiguous at the flow deadline', () => {
  const result = decide(
    flow('submitted', { submittedFor: 'B', enteredAt: DEADLINE.flow - 1000 }),
    probe({ hasLogout: true, loginName: '' }),
    DEADLINE.flow + 1
  );
  assert.equal(result.failureCode, 'ambiguous_page');
});

test('submitted flow without a login postcondition reaches probe_timeout', () => {
  const result = decide(flow('submitted', { submittedFor: 'B' }), probe(), DEADLINE.submitted + 1);
  assert.equal(result.failureCode, 'probe_timeout');
});

test('credentials are submitted only when submittedFor is unset', () => {
  const loginForm = probe({ path: '/mall/login.ubs', hasForm: true });
  const first = decide(flow('toLogin'), loginForm, 100);
  assert.equal(first.action, 'fillLogin');
  assert.equal(first.setSubmittedFor, 'B');
  const second = decide(flow('toLogin', { submittedFor: 'B' }), loginForm, 100);
  assert.equal(second.failureCode, 'login_reappeared');
});

test('phase attempt cap prevents a fourth side effect', () => {
  const result = decide(flow('start', { attempts: { start: DEADLINE.maxAttempts } }), probe({ hasLogout: true, loginName: 'A' }), 100);
  assert.equal(result.action, 'fail');
  assert.equal(result.failureCode, 'max_attempts');
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log('PASS', name);
  } catch (error) {
    console.error('FAIL', name);
    throw error;
  }
}
console.log(`PASS ${passed}/${tests.length} tests`);
