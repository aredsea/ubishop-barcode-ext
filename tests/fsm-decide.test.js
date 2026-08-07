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

test('scenario 3: 보이는 캡차는 제출하지 않고 fail-closed, 없으면 fillLogin', () => {
  // P1-1(공동검수 2026-07-22): 보이는 캡차는 자격증명 문제 신호다(사용자 모델: 캡차=비번오답).
  // 채우지도 제출하지도 않고 captcha_present 로 안전 중단한다 — 무의미한 제출·락아웃 위험 제거.
  // 반자동 캡차 UX(fillCaptcha/captchaWait)는 재도입하지 않는다(사용자 결정 유지).
  const withCaptcha = decide(flow('toLogin'), probe({ path: '/mall/login.ubs', hasForm: true, captcha: true }), 100);
  assert.equal(withCaptcha.action, 'fail');
  assert.equal(withCaptcha.failureCode, 'captcha_present');
  assert.notEqual(withCaptcha.action, 'fillLogin');

  // 캡차 없음(정상 경로) — 폼이 있으면 fillLogin 으로 채우고 제출한다.
  const withoutCaptcha = decide(flow('toLogin'), probe({ path: '/mall/login.ubs', hasForm: true, captcha: false }), 100);
  assert.equal(withoutCaptcha.action, 'fillLogin');
  assert.equal(withoutCaptcha.nextPhase, 'submitted');
  assert.equal(withoutCaptcha.setSubmittedFor, 'B');
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

// 마감 시점에도 "관측된 대상" 이 우선한다는 원래 의도는 **PMS 링크가 있을 때** 그대로 유지된다.
test('observed target postcondition wins at the overall deadline (PMS 링크 있음)', () => {
  const result = decide(
    flow('submitted', { submittedFor: 'B', enteredAt: DEADLINE.flow - 1000 }),
    probe({ hasLogout: true, loginName: 'B', pmsHref: 'https://www.honsu114.com/pamasLogin.do' }),
    DEADLINE.flow + 1
  );
  assert.equal(result.action, 'navigatePms');
});

// 🔴 종전엔 PMS 링크가 없어도 succeed 로 끝냈다. 그래서 로그인은 됐는데 PMS 로 못 넘어간 채
//   main.ubs 에 남고, 성공 처리라 watchdog 도 꺼져 사용자는 "왜 멈췄는지" 알 수 없었다
//   (실제 사용자 신고 증상). 이제는 유예 뒤 pms_link_missing 으로 명시 실패시켜 문구를 띄운다.
//   로그인 자체는 성공했으므로 계정은 바뀌어 있다 — 문구가 다음 행동을 안내한다.
test('마감 시점에 PMS 링크가 없으면 pms_link_missing 으로 명시 실패한다 (조용한 멈춤 금지)', () => {
  const result = decide(
    flow('submitted', { submittedFor: 'B', enteredAt: DEADLINE.flow - 1000 }),
    probe({ hasLogout: true, loginName: 'B' }),
    DEADLINE.flow + 1
  );
  assert.equal(result.action, 'fail');
  assert.equal(result.failureCode, 'pms_link_missing');
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
  // PMS 링크가 아직 없으면 **성공으로 끝내지 않고 기다린다** — 링크가 늦게 그려지는 페이지가 있다.
  // 유예 안에 안 나타나면 위의 pms_link_missing 테스트가 명시 실패를 보증한다.
  const withoutPms = decide(flow('submitted', { submittedFor: 'B' }), probe({ hasLogout: true, loginName: 'B' }), 100);
  assert.equal(withoutPms.action, 'wait');
});

test('targetLoginName verifies display identity without changing submittedFor accountId', () => {
  const result = decide(
    flow('submitted', { accountId: 'userid-b', targetLoginName: 'Shop B', submittedFor: 'userid-b' }),
    // 이 테스트의 의도는 **표시명 정규화**(' shop b ' ↔ 'Shop B')가 통하는지다. PMS 동작이 아니므로
    // 링크를 줘서 그 축을 고정한다 — 링크가 없을 때의 동작은 pms_link_missing 테스트가 따로 본다.
    probe({ hasLogout: true, loginName: ' shop b ', pmsHref: 'https://www.honsu114.com/pamasLogin.do' }),
    100
  );
  assert.equal(result.action, 'navigatePms');
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

test('logout landing-independence: honsu114 비로그인 임의 페이지에서도 로그인으로 진행한다', () => {
  // v3.6.x 화이트리스트 회귀 반전 — /mall/orders.ubs 는 예전엔 unrelated_page 로 죽었지만
  // 이제 착지 경로 무관하게 로그인 페이지로 네비게이트한다(호스트 안전판만 유지).
  const result = decide(flow('loggingOut'), probe({
    url: 'https://www.honsu114.com/mall/orders.ubs',
    path: '/mall/orders.ubs',
    hasLogout: false
  }), 100);
  assert.equal(result.action, 'navigateLogin');
  assert.equal(result.nextPhase, 'toLogin');
});

test('logout landing-independence: ERP(ubshop.biz) 착지에서도 로그인으로 진행한다', () => {
  // ERP 탭에서 전환 시작 → 로그아웃이 ubshop.biz 로 떨어져도 로그인 페이지로 진행한다.
  const result = decide(flow('loggingOut'), probe({
    host: 'ubdstore.ubshop.biz',
    url: 'https://ubdstore.ubshop.biz/some/where.do',
    path: '/some/where.do',
    hasLogout: false
  }), 100);
  assert.equal(result.action, 'navigateLogin');
  assert.equal(result.nextPhase, 'toLogin');
});

// 회귀: v3.6.4(9a6df67)가 로그아웃 랜딩 화이트리스트를 도입하면서 실제 랜딩 경로를 빠뜨렸다.
// honsu114 는 '/' 로 가면 곧바로 '/mall/main.ubs' 로 리다이렉트하고, ERP 미인증 접근도 같은
// 곳으로 떨어진다(2026-07-20 라이브 실측). 그래서 로그아웃 직후엔 항상 '/mall/main.ubs' 인데
// 화이트리스트에 없어 unrelated_page 로 흐름이 죽었다 = "로그아웃만 되고 그 다음이 없음".
test('regression: 로그아웃이 실제로 떨어지는 /mall/main.ubs 에서 로그인 페이지로 진행한다', () => {
  const result = decide(flow('loggingOut'), probe({
    url: 'https://www.honsu114.com/mall/main.ubs',
    path: '/mall/main.ubs',
    hasLogout: false,   // 로그아웃이 실제로 완료됨
    hasForm: false      // 아직 로그인 폼 페이지는 아님
  }), 100);
  assert.equal(result.action, 'navigateLogin');
  assert.equal(result.nextPhase, 'toLogin');
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
