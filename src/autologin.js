/* =============================================================================
 *  autologin.js — 계정 빠른 전환: honsu114 로그인 페이지 자동 입력/제출
 *  ISOLATED content script (honsu114.com/*). folder-locked(crx).
 *
 *  흐름: 팝업에서 계정 선택 → ubPendingLogin 저장 + 현재 탭 로그아웃(/logout.do)
 *        → honsu114 홈으로 리다이렉트 → (이 스크립트) 로그인 페이지로 이동
 *        → 로그인 폼에 아이디/비번(복호화) 자동 입력 → 자동 제출.
 *  ⚠ 캡차(비번 오답 시)에는 절대 손대지 않음 — 캡차 보이면 자동 제출 중단, 사람이 처리.
 *  ⚠ 비밀번호는 chrome.storage에 AES-GCM 암호화 저장(평문 아님). 여기서만 복호화해 입력.
 *
 *  실측(사용자 콘솔): 로그인 action=/mall/login.ubs POST,
 *    아이디=input[name="sysUser.fuserid"], 비번=input[name="sysUser.fpasswd"],
 *    캡차=sysUser.fcaptcha(문자) + g-recaptcha-response(reCAPTCHA), url=www.honsu114.com/mall/login.ubs.
 * ========================================================================== */
(function () {
  'use strict';
  if (!/(^|\.)honsu114\.com$/i.test(location.hostname)) return;

  const LOGIN_URL = 'https://www.honsu114.com/mall/login.ubs';
  const MAX_AGE = 120000;   // 전환 지시 유효 2분(오래된 pending 무시)
  const log = (...a) => { try { console.log('[UB][login]', ...a); } catch (_) {} };

  /* ---- AES-GCM 복호화 (popup.js 와 동일 파생) ---- */
  async function vaultKey() {
    const g = await chrome.storage.local.get('ubLoginSalt');
    let saltB64 = g && g.ubLoginSalt;
    if (!saltB64) return null;   // 소금 없으면 저장된 것도 없음
    const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
    const pass = new TextEncoder().encode('ubshop-acct-vault-v1|' + (chrome.runtime && chrome.runtime.id || 'x'));
    const base = await crypto.subtle.importKey('raw', pass, 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  }
  async function dec(obj) {
    const key = await vaultKey();
    if (!key || !obj) throw new Error('no key');
    const iv = Uint8Array.from(atob(obj.iv), c => c.charCodeAt(0));
    const ct = Uint8Array.from(atob(obj.ct), c => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  }

  /* ---- 폼/캡차 탐지 ---- */
  function loginForm() {
    const pw = document.querySelector('input[name="sysUser.fpasswd"]') ||
               document.querySelector('input[type=password]');
    return pw ? pw.form : null;
  }
  function isVisible(el) { return !!(el && el.offsetParent !== null && el.getClientRects().length); }
  function captchaVisible() {
    const rc = document.querySelector('iframe[src*="recaptcha"], .g-recaptcha');
    const cap = document.querySelector('input[name="sysUser.fcaptcha"]');
    return isVisible(rc) || isVisible(cap);
  }
  function setVal(el, v) {
    if (!el) return;
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function submitLogin(form) {
    // 사이트 검증 JS를 타도록 폼 내부 제출 컨트롤 우선 → 없으면 requestSubmit.
    const btn = form.querySelector('input[type=submit],button[type=submit],input[type=image]') ||
                form.querySelector('[onclick*="login" i],[onclick*="submit" i]');
    try {
      if (btn) { btn.click(); log('제출: 버튼 클릭'); }
      else if (form.requestSubmit) { form.requestSubmit(); log('제출: requestSubmit'); }
      else { form.submit(); log('제출: form.submit'); }
    } catch (e) { try { form.submit(); } catch (_) {} }
  }

  // 현재 페이지의 '로그아웃' 링크(로그인 상태 판정 겸용)
  function findLogout() {
    return [...document.querySelectorAll('a[href]')].find(a => {
      const t = (a.textContent || '').replace(/\s/g, '');
      const h = a.getAttribute('href') || '';
      return /로그아웃|logout/i.test(t) || /logout|logoff|signout/i.test(h);
    });
  }
  function goLogout(link) {
    const h = link.getAttribute('href') || '';
    if (h && h.indexOf('javascript:') !== 0) location.href = new URL(h, location.href).href;
    else { try { link.click(); } catch (_) {} }
  }

  async function run() {
    let pend;
    try { pend = (await chrome.storage.local.get('ubPendingLogin')).ubPendingLogin; } catch (_) { return; }
    if (!pend || !pend.accountId) return;
    if (pend.ts && Date.now() - pend.ts > MAX_AGE) { try { await chrome.storage.local.remove('ubPendingLogin'); } catch (_) {} return; }

    // ★무한루프 하드가드: 매 실행마다 step++, 한도 초과면 중단(더는 이동 안 함).
    const step = (pend.step || 0) + 1;
    if (step > 6) { log('반복 초과 — 자동전환 중단(로그아웃/로그인 흐름 점검 필요)'); await chrome.storage.local.remove('ubPendingLogin'); return; }

    const form = loginForm();

    // 1) 로그인 폼 있음(=로그아웃 상태) → 아이디/비번 채우고 제출
    if (form) {
      const accs = (await chrome.storage.local.get('ubAccounts')).ubAccounts || [];
      const acc = accs.find(a => a.id === pend.accountId);
      if (!acc) { await chrome.storage.local.remove('ubPendingLogin'); return; }
      let pw = '';
      try { pw = await dec(acc.pwEnc); }
      catch (e) { log('복호화 실패 — 취소'); await chrome.storage.local.remove('ubPendingLogin'); return; }
      setVal(form.querySelector('input[name="sysUser.fuserid"]'), acc.userid);
      setVal(form.querySelector('input[name="sysUser.fpasswd"]'), pw);
      pw = '';
      await chrome.storage.local.remove('ubPendingLogin');   // 소비(루프 방지)
      if (captchaVisible()) {
        log('캡차 표시 → 자동 제출 안 함(사람이 캡차 입력 후 로그인)');
        const cap = form.querySelector('input[name="sysUser.fcaptcha"]'); if (cap) cap.focus();
        return;
      }
      log('자동 로그인 제출 →', acc.alias || acc.userid);
      submitLogin(form);
      return;
    }

    // 2) 폼 없음 + 아직 로그인 상태(로그아웃 링크 존재) → 로그아웃 먼저
    const lo = findLogout();
    if (lo) {
      await chrome.storage.local.set({ ubPendingLogin: Object.assign({}, pend, { step }) });
      log('로그인 상태 감지 → 로그아웃', lo.getAttribute('href'));
      goLogout(lo);
      return;
    }

    // 3) 폼 없음 + 로그아웃 상태 → 로그인 페이지로 이동
    if (!/\/mall\/login\.ubs/i.test(location.pathname)) {
      await chrome.storage.local.set({ ubPendingLogin: Object.assign({}, pend, { step }) });
      log('로그인 페이지로 이동');
      location.href = LOGIN_URL;
      return;
    }

    // 4) 로그인 페이지인데 폼이 없음(이상) → 중단
    log('로그인 폼을 찾지 못함 — 중단');
    await chrome.storage.local.remove('ubPendingLogin');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
