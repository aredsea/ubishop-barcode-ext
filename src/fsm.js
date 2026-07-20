const DEADLINE = Object.freeze({
  start: 15000,
  loggingOut: 15000,
  toLogin: 15000,
  submitted: 10000,
  enteringPms: 15000,
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
  const flowExpired = Number.isFinite(flow.startedAt) && now - flow.startedAt > DEADLINE.flow;

  if (!probe.ambiguous && probe.host && !/(^|\.)(ubshop\.biz|honsu114\.com)$/i.test(probe.host)) {
    return fsmFail('ambiguous_page', 'unrelated_host');
  }

  if (probe.ambiguous || (probe.hasForm && probe.hasLogout)) {
    return expired || flowExpired
      ? fsmFail('ambiguous_page', flowExpired ? 'flow_deadline' : 'ambiguous_page')
      : { action: 'wait' };
  }

  if (probe.hasForm && probe.captcha) return fsmFail('captcha');
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
    if (!fsmIsLogoutLanding(probe)) return fsmFail('ambiguous_page', 'unrelated_page');
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
