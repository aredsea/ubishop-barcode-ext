const DEADLINE = Object.freeze({
  start: 15000,
  loggingOut: 15000,
  toLogin: 15000,
  submitted: 10000,
  enteringPms: 15000,
  captchaWait: 300000,
  flow: 90000,
  maxAttempts: 3
});

function normalizeProbe(raw) {
  const required = ['host', 'url', 'path', 'hasForm', 'hasLogout', 'hasPms', 'pmsHref', 'captcha', 'loginName', 'ambiguous'];
  const partial = !raw || required.some(key => !Object.prototype.hasOwnProperty.call(raw, key));
  const source = raw || {};
  return {
    host: typeof source.host === 'string' ? source.host : '',
    url: typeof source.url === 'string' ? source.url : '',
    path: typeof source.path === 'string' ? source.path : '',
    hasForm: source.hasForm === true,
    hasLogout: source.hasLogout === true,
    hasPms: source.hasPms === true,
    pmsHref: typeof source.pmsHref === 'string' && source.pmsHref ? source.pmsHref : null,
    captcha: source.captcha === true,
    loginName: typeof source.loginName === 'string' ? source.loginName : '',
    ambiguous: partial || source.ambiguous === true
  };
}

function fsmNormName(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function fsmFail(failureCode, terminalReason) {
  return { action: 'fail', failureCode, terminalReason: terminalReason || failureCode };
}

function fsmExpired(flow, now) {
  const budget = DEADLINE[flow && flow.phase];
  return Number.isFinite(budget) && Number.isFinite(flow && flow.enteredAt) && now - flow.enteredAt > budget;
}

// 로그아웃 직후 '정상 착지' 판정. honsu114 는 '/' 를 '/mall/main.ubs' 로 리다이렉트하므로
// 루트만 허용하면 실제로는 어떤 경로도 통과하지 못한다(v3.6.4 회귀의 원인).
function fsmIsLogoutLanding(probe) {
  if (!/(^|\.)honsu114\.com$/i.test(probe.host)) return false;
  return /^(?:\/|\/mall\/?|\/mall\/(?:main|login)\.ubs)$/i.test(probe.path);
}

function fsmWithAttemptCap(flow, decision) {
  if (!['logout', 'navigateLogin', 'fillLogin', 'navigatePms'].includes(decision.action)) return decision;
  const attempts = flow && flow.attempts || {};
  if ((attempts[flow.phase] || 0) >= DEADLINE.maxAttempts) return fsmFail('max_attempts');
  return decision;
}

function decide(flow, rawProbe, now) {
  flow = flow || {};
  const probe = normalizeProbe(rawProbe);
  const phase = flow.phase;
  const expired = fsmExpired(flow, now);
  const accountId = fsmNormName(flow.accountId);
  const targetKnown = !!fsmNormName(flow.targetLoginName);
  const target = fsmNormName(flow.targetLoginName || flow.accountId);
  const observed = fsmNormName(probe.loginName);
  const submittedForTarget = !!flow.submittedFor && fsmNormName(flow.submittedFor) === accountId;
  // captchaWait 는 사용자가 캡차를 직접 푸는 user-paced 단계라 90초 flow 마감에서 면제한다.
  // 종료는 captchaWait 전용 phase 마감(DEADLINE.captchaWait)으로만 한다.
  const flowExpired = phase !== 'captchaWait' && Number.isFinite(flow.startedAt) && now - flow.startedAt > DEADLINE.flow;

  if (!probe.ambiguous && probe.host && !/(^|\.)(ubshop\.biz|honsu114\.com)$/i.test(probe.host)) {
    return fsmFail('ambiguous_page', 'unrelated_host');
  }

  if (probe.ambiguous || (probe.hasForm && probe.hasLogout)) {
    return expired || flowExpired
      ? fsmFail('ambiguous_page', flowExpired ? 'flow_deadline' : 'ambiguous_page')
      : { action: 'wait' };
  }

  // 로그인 폼에는 캡차가 항상 있다. 캡차를 절대 자동해결/우회하지 않는다(안전 규칙).
  // 반자동: 아직 안 채웠으면 id/pw 자동입력(제출 없음)+캡차 포커스로 전이하고,
  // 채운 뒤엔 사용자가 캡차를 푸는 동안 대기한다. 5분(captchaWait) 지나면 포기한다.
  if (probe.hasForm && probe.captcha) {
    if (!flow.filledCaptcha) return { action: 'fillCaptcha', nextPhase: 'captchaWait', setFilledCaptcha: true };
    return expired ? fsmFail('captcha_timeout', 'captcha_user_timeout') : { action: 'wait' };
  }
  if (phase === 'enteringPms' && probe.hasPms) {
    return { action: 'succeed', nextPhase: 'done', terminalReason: 'pms_observed' };
  }

  if (probe.hasLogout && observed && observed === target) {
    if (probe.pmsHref) return fsmWithAttemptCap(flow, { action: 'navigatePms', nextPhase: 'enteringPms' });
    if (phase === 'start') return { action: 'skip', nextPhase: 'done', terminalReason: 'already_target' };
    return { action: 'succeed', nextPhase: 'done', terminalReason: 'target_login_verified' };
  }

  if ((phase === 'submitted' || submittedForTarget) && probe.hasLogout && observed && !targetKnown) {
    if (probe.pmsHref) return fsmWithAttemptCap(flow, { action: 'navigatePms', nextPhase: 'enteringPms' });
    return { action: 'succeed', nextPhase: 'done', terminalReason: 'target_login_bootstrapped' };
  }

  if (phase === 'submitted' && probe.hasForm) return fsmFail('login_reappeared');
  if (phase === 'submitted' && probe.hasLogout && observed && targetKnown && observed !== target) return fsmFail('wrong_account');
  if (submittedForTarget && probe.hasForm) return fsmFail('login_reappeared');
  if (submittedForTarget && probe.hasLogout && observed && targetKnown && observed !== target) return fsmFail('wrong_account');
  if (phase === 'submitted' && probe.hasLogout && !observed) {
    return expired || flowExpired
      ? fsmFail('ambiguous_page', flowExpired ? 'flow_deadline' : 'login_identity_unavailable')
      : { action: 'wait' };
  }

  if (flowExpired) return fsmFail(phase === 'submitted' ? 'probe_timeout' : 'nav_timeout', 'flow_deadline');

  // captchaWait 꼬리 — 주 경로는 위 캡차 분기(성공은 line ~83 에서 이미 처리). 폼이 잠깐
  // 사라진 전이 상태 등 fall-through 를 여기서 잡아, captchaWait 중엔 절대 fillLogin(자동제출)
  // 로 새지 않게 한다(fail-closed). 5분 phase 마감까지 대기 후 captcha_timeout.
  if (phase === 'captchaWait') return expired ? fsmFail('captcha_timeout') : { action: 'wait' };

  if (probe.hasForm) {
    if (flow.submittedFor) return fsmFail('login_reappeared');
    return fsmWithAttemptCap(flow, {
      action: 'fillLogin',
      nextPhase: 'submitted',
      setSubmittedFor: flow.accountId
    });
  }

  if (phase === 'submitted') {
    return expired ? fsmFail('probe_timeout') : { action: 'wait' };
  }

  if (phase === 'enteringPms') {
    return expired ? fsmFail('nav_timeout') : { action: 'wait' };
  }

  if (phase === 'loggingOut') {
    if (probe.hasLogout) return expired ? fsmFail('nav_timeout') : { action: 'wait' };
    // 착지 경로 무관하게 진행한다 — 로그아웃 후 어느 탭(ERP=ubshop.biz 포함)에서 떨어져도
    // 로그아웃만 됐으면(로그아웃 링크 없음) 로그인 페이지로 네비게이트한다. 무관 호스트는
    // line ~68 의 호스트 안전판이 여전히 막고, ubshop.biz·honsu114.com 는 통과한다.
    return fsmWithAttemptCap(flow, { action: 'navigateLogin', nextPhase: 'toLogin' });
  }

  if (phase === 'toLogin') {
    if (probe.hasLogout) return fsmWithAttemptCap(flow, { action: 'logout', nextPhase: 'loggingOut' });
    return expired ? fsmFail('nav_timeout') : { action: 'wait' };
  }

  if (phase === 'start') {
    if (probe.hasLogout) return fsmWithAttemptCap(flow, { action: 'logout', nextPhase: 'loggingOut' });
    return fsmWithAttemptCap(flow, { action: 'navigateLogin', nextPhase: 'toLogin' });
  }

  if (phase === 'done') return { action: 'succeed', nextPhase: 'done', terminalReason: flow.terminalReason || 'already_done' };
  if (phase === 'failed') return fsmFail(flow.lastFailureCode || 'ambiguous_page', flow.terminalReason || 'already_failed');
  return fsmFail('ambiguous_page', 'unknown_phase');
}

if (typeof module !== 'undefined' && module.exports) { module.exports = { decide, normalizeProbe, DEADLINE }; }
