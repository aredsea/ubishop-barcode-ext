/* =============================================================================
 *  autologin.js — 계정 빠른 전환 상태머신 (honsu114 + ubdstore 양쪽)
 *  ISOLATED content script. folder-locked(crx).
 *
 *  유비샵 구조(실측): 로그인 전 = honsu114 GNSHOP 홈 / 로그인 후 = ubdstore PMS 관리자.
 *  워크플로우(사용자 확정 6단계):
 *   1) 현재 화면 감지(홈 vs PMS)
 *   2) 그 화면의 로그아웃 프로토콜로 로그아웃
 *        · PMS(ubdstore): <a href="/logout.do">  (일반 이동)
 *        · 홈(honsu114):  <a href="javascript:link('logout')>  (link 함수 실행)
 *   3) honsu114 홈에서 로그아웃(이미 로그아웃이면 skip)
 *   4) honsu114 홈 → 로그인 페이지(login.ubs)
 *   5) 아이디/비번 입력 → 로그인 버튼(<a class=btn_submit onclick="login()">) → login()
 *   6) 로그인된 홈의 PMS 버튼(<a href=".../pamasLogin.do?...ssId=...">) 클릭 → 관리자 진입
 *
 *  ⚠ 크롬은 "스크립트가 만든 클릭"으로 javascript: 내비게이션을 막음 → javascript:link()
 *    는 href 코드를 MAIN world 에 주입 실행(사이트 방식 그대로). onclick 핸들러(login())는
 *    합성 click 으로 정상 실행됨.
 *  ⚠ 캡차(비번 오답 시에만)에는 손대지 않음 — 뜨면 중단, 사람이 처리.
 *  ⚠ 비번은 chrome.storage 에 AES-GCM 암호화 저장. 여기서만 복호화해 입력.
 * ========================================================================== */
(function () {
  'use strict';
  const IS_HONSU = /(^|\.)honsu114\.com$/i.test(location.hostname);
  const IS_UB = /(^|\.)ubshop\.biz$/i.test(location.hostname);
  if (!IS_HONSU && !IS_UB) return;

  const LOGIN_URL = 'https://www.honsu114.com/mall/login.ubs';
  const MAX_AGE = 180000;
  const log = (...a) => { try { console.log('[UB][login]', ...a); } catch (_) {} };
  let _acted = false;   // 이 페이지 로드에서 1회만 행동(중복 실행 방지)

  /* ---- 복호화 (popup.js 와 동일 파생) ---- */
  async function vaultKey() {
    const g = await chrome.storage.local.get('ubLoginSalt');
    const saltB64 = g && g.ubLoginSalt;
    if (!saltB64) return null;
    const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
    const pass = new TextEncoder().encode('ubshop-acct-vault-v1|' + (chrome.runtime && chrome.runtime.id || 'x'));
    const base = await crypto.subtle.importKey('raw', pass, 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  }
  async function dec(obj) {
    const key = await vaultKey();
    if (!key || !obj) throw new Error('no key');
    const iv = Uint8Array.from(atob(obj.iv), c => c.charCodeAt(0));
    const ct = Uint8Array.from(atob(obj.ct), c => c.charCodeAt(0));
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
  }

  /* ---- DOM 감지/조작 ---- */
  function loginForm() {
    const pw = document.querySelector('input[name="sysUser.fpasswd"]') || document.querySelector('input[type=password]');
    return pw ? pw.form : null;
  }
  function isVisible(el) { return !!(el && el.offsetParent !== null && el.getClientRects().length); }
  function captchaVisible() {
    return isVisible(document.querySelector('iframe[src*="recaptcha"], .g-recaptcha')) ||
           isVisible(document.querySelector('input[name="sysUser.fcaptcha"]'));
  }
  function findLogout() {
    return [...document.querySelectorAll('a[href]')].find(a => {
      const t = (a.textContent || '').replace(/\s/g, '');
      const h = a.getAttribute('href') || '';
      return /로그아웃|logout/i.test(t) || /logout|logoff|signout/i.test(h);
    });
  }
  function findPms() { return document.querySelector('a.pms, a[href*="pamasLogin.do" i]'); }
  function setVal(el, v) {
    if (!el) return;
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // ISOLATED → MAIN 주입(페이지 함수 직접 실행). 사이트가 javascript:href 를 쓰므로 inline 허용됨.
  function injectMain(code) {
    try { const s = document.createElement('script'); s.textContent = code; (document.head || document.documentElement).appendChild(s); s.remove(); return true; }
    catch (_) { return false; }
  }
  function goLogout(lo) {
    const h = lo.getAttribute('href') || '';
    if (/^javascript:/i.test(h)) { log('로그아웃(link 함수 직접 실행)'); if (!injectMain(h.replace(/^javascript:/i, ''))) { try { lo.click(); } catch (_) {} } }
    else if (h) { log('로그아웃(이동)', h); location.href = new URL(h, location.href).href; }
    else { try { lo.click(); } catch (_) {} }
  }
  function submitLogin(form) {
    // 로그인 버튼은 <a class=btn_submit onclick="login()"> — onclick 은 합성 click 으로 실행됨.
    let btn = form.querySelector('a.btn_submit, [onclick*="login" i], input[type=submit], button[type=submit], input[type=image]')
           || document.querySelector('a.btn_submit, [onclick*="login" i]');
    if (btn) { log('로그인 버튼 클릭'); try { btn.click(); } catch (_) { injectMain('try{login()}catch(e){}'); } }
    else { log('login() 직접 호출'); if (!injectMain('try{login()}catch(e){}')) { try { form.requestSubmit ? form.requestSubmit() : form.submit(); } catch (_) {} } }
  }

  const setPending = (o) => chrome.storage.local.set({ ubPendingLogin: o });
  const clearPending = () => chrome.storage.local.remove('ubPendingLogin');

  async function run() {
    let pend;
    try { pend = (await chrome.storage.local.get('ubPendingLogin')).ubPendingLogin; } catch (_) { return; }
    if (!pend || !pend.accountId) return;
    if (_acted) return;
    if (pend.ts && Date.now() - pend.ts > MAX_AGE) { await clearPending(); return; }
    const step = (pend.step || 0) + 1;
    if (step > 8) { log('반복 초과 — 자동전환 중단'); await clearPending(); return; }
    _acted = true;

    const form = loginForm();

    // A) 로그인 폼 있음 → 아이디/비번 채우고 login()
    if (form) {
      const accs = (await chrome.storage.local.get('ubAccounts')).ubAccounts || [];
      const acc = accs.find(a => a.id === pend.accountId);
      if (!acc) { await clearPending(); return; }
      if (captchaVisible()) {
        log('캡차 표시 → 자동 로그인 중단(비번 확인/캡차 직접 입력)');
        const cap = form.querySelector('input[name="sysUser.fcaptcha"]'); if (cap) cap.focus();
        await clearPending(); return;
      }
      let pw = '';
      try { pw = await dec(acc.pwEnc); } catch (e) { log('복호화 실패'); await clearPending(); return; }
      setVal(form.querySelector('input[name="sysUser.fuserid"]'), acc.userid);
      setVal(form.querySelector('input[name="sysUser.fpasswd"]'), pw);
      pw = '';
      await setPending(Object.assign({}, pend, { step, didLogin: true }));   // 로그인 시도 → 다음 로그인상태면 PMS
      log('자동 로그인 제출 →', acc.alias || acc.userid);
      submitLogin(form);
      return;
    }

    // B) 로그인 상태(로그아웃 링크 존재)
    const lo = findLogout();
    if (lo) {
      if (pend.didLogin) {
        // 로그인 성공(새 계정) → PMS 진입
        const pms = findPms();
        if (pms && pms.href) { log('로그인 완료 → PMS 진입'); await clearPending(); location.href = pms.href; return; }
        log('로그인 완료(홈) — PMS 링크 없음, 종료'); await clearPending(); return;
      }
      await setPending(Object.assign({}, pend, { step }));
      goLogout(lo);   // 아직 로그아웃 안 함 → 로그아웃
      return;
    }

    // C) 로그아웃 상태 + 폼 없음 → 로그인 페이지로
    if (!/\/mall\/login\.ubs/i.test(location.pathname)) {
      await setPending(Object.assign({}, pend, { step }));
      log('로그인 페이지로 이동');
      location.href = LOGIN_URL;
      return;
    }

    // D) login.ubs 인데 폼이 없음(이상) → 중단
    log('로그인 폼 못 찾음 — 중단');
    await clearPending();
  }

  // 팝업 [전환] → ubPendingLogin 저장 시 현재 탭에서 즉시 실행(내비게이션 없이도 시작).
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.ubPendingLogin && ch.ubPendingLogin.newValue) { log('전환 지시 감지 → 실행'); run(); }
    });
  } catch (_) {}
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
