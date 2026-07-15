importScripts('fsm.js');

/* =============================================================================
 *  background.js — MV3 서비스워커.
 *  ① 로컬 인쇄 프로그램 fetch 전담 (PNA 우회).
 *  ② 확장 자동 갱신 체크 (raw GitHub manifest, chrome.runtime.reload).
 *  ③ 전표 자동 분할조회 캐시 brigade(/cache/* + /telemetry/event)
 *     + 큰 날짜 범위를 chunk 단위로 ubdstore에 fetch → 결과 누적.
 *
 *  메시지 프로토콜 (page → bridge → SW):
 *    {source:'ub', type:'ping'|'print'|'cacheGet'|'cachePut'|'cacheSearch'|'telemetry', ...}
 *
 *  cacheSearch payload:
 *    { path, url, startDate, endDate, chunkDays }
 *  → 응답: { ok, chunks: [{date, hit, ms, bytes}], totalMs, savedMs }
 * ========================================================================== */
const PRINT_URL = 'http://127.0.0.1:17600/print';
const PING_URL = 'http://127.0.0.1:17600/ping';
const CACHE_GET = 'http://127.0.0.1:17600/cache/get';
const CACHE_PUT = 'http://127.0.0.1:17600/cache/put';
const TELE_URL  = 'http://127.0.0.1:17600/telemetry/event';
const REMOTE_SHELL = 'https://raw.githubusercontent.com/aredsea/ubishop-barcode-ext/main/shell-files.json';
const UPDATE_ALARM = 'ubUpdateCheck';

/* ---- 메시지 라우터 -------------------------------------------------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.source !== 'ub') return;

  if (msg.type === 'ping')  { proxyJson(PING_URL, null, sendResponse); return true; }
  if (msg.type === 'print') { proxyJson(PRINT_URL, { items: msg.items || [] }, sendResponse); return true; }

  if (msg.type === 'cacheGet')   { cacheGet(msg.path, msg.date).then(sendResponse); return true; }
  if (msg.type === 'cachePut')   { cachePut(msg.path, msg.date, msg.html).then(sendResponse); return true; }
  if (msg.type === 'telemetry')  { sendTelemetry(msg.payload).then(sendResponse); return true; }
  if (msg.type === 'cacheSearch') { runCacheSearch(msg, sender).then(sendResponse).catch(e => sendResponse({ ok:false, error:String(e&&e.message||e) })); return true; }

  // ---- Phase 2: transparent caching (form submit 가로채기용) ----
  // path 슬롯에 'search:<page>' 사용. date 슬롯에 form value SHA-256 hash.
  if (msg.type === 'cacheGetSearch')   { cacheGet(msg.pathKey || 'search', msg.key).then(sendResponse); return true; }
  if (msg.type === 'cachePutSearch')   { cachePut(msg.pathKey || 'search', msg.key, msg.html).then(sendResponse); return true; }
  if (msg.type === 'cacheFetchSearch') { fetchUbdstore(msg.url).then(sendResponse); return true; }

  // ---- 계정 빠른 전환 오케스트레이션(팝업 → SW) ----
  if (msg.type === 'ubSwitchAccount') { startSwitch(msg).then(sendResponse).catch(e => sendResponse({ ok:false, error:String(e&&e.message||e) })); return true; }
});

/* ---- transparent caching용 — ubdstore에서 단일 URL fetch ----
 *  v3.1.1 fix:
 *  - Bug B: 8초 AbortController timeout (이전엔 무한 대기로 "한참 로딩")
 *  - Bug C: Content-Type 우선 → UTF-8 mojibake(>5 replacement chars in 4KB)
 *    감지 시 EUC-KR 자동 fallback. 이전엔 fatal:false라 절대 fallback 안 됨.
 *  - Bug D: 빈 응답 판정을 1KB → t_list 마커 존재 + bytes>500 두 조건으로
 *    명확화 (template 오버헤드 큰 빈 결과 페이지의 false positive 방지).
 *  - 진단을 위해 decoder/bytes/status/aborted/elapsedMs 모두 응답에 포함.
 */
async function fetchUbdstore(url) {
  // 8초 → 20초로 확장 (v3.1.1 사용자 보고: 결과 수십~수백 record 검색 시 ubdstore
  // 자체 응답이 8초 이상 걸리는 케이스 빈발 → 캐시 미저장으로 fallback 자주 발생).
  const FETCH_TIMEOUT_MS = 20000;
  const ctrl = new AbortController();
  const t0 = Date.now();
  const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      credentials: 'include',
      cache: 'no-cache',
      signal: ctrl.signal,
      redirect: 'follow'
    });
    clearTimeout(tid);
    const buf = await r.arrayBuffer();
    const bytes = buf.byteLength;

    // 인코딩 결정: Content-Type 헤더 우선 → UTF-8 mojibake 감지 → 기본 UTF-8
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    let decoder = 'utf-8';
    if (ct.includes('euc-kr') || ct.includes('ks_c_5601') || ct.includes('ksc5601')) {
      decoder = 'euc-kr';
    } else if (!ct.includes('utf-8') && bytes > 0) {
      // Content-Type에 charset 명시 없음 → UTF-8 디코더로 샘플 보고 mojibake 감지
      try {
        const sample = new TextDecoder('utf-8', { fatal: false })
          .decode(buf.slice(0, Math.min(4096, bytes)));
        const replCount = (sample.match(/�/g) || []).length;
        if (replCount > 5) decoder = 'euc-kr';
      } catch (_) {}
    }
    let html = '';
    try { html = new TextDecoder(decoder).decode(buf); }
    catch (_) {
      try { html = new TextDecoder(decoder === 'utf-8' ? 'euc-kr' : 'utf-8').decode(buf); } catch (__) {}
    }

    // 빈 응답 판정: t_list 마커가 본문에 존재하는지 + 최소 크기
    const hasResultsMarker = html.indexOf('class="t_list"') >= 0 || html.indexOf("class='t_list'") >= 0;
    const ok = r.ok && bytes > 500 && hasResultsMarker;

    return {
      ok, html, bytes, status: r.status,
      decoder, contentType: ct,
      elapsedMs: Date.now() - t0
    };
  } catch (e) {
    clearTimeout(tid);
    const aborted = e && e.name === 'AbortError';
    return {
      ok: false,
      error: aborted ? ('timeout after ' + FETCH_TIMEOUT_MS + 'ms') : String(e && e.message || e),
      aborted,
      elapsedMs: Date.now() - t0
    };
  }
}

function proxyJson(url, body, cb) {
  const init = body == null
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  fetch(url, init)
    .then(r => r.json().catch(() => ({ ok: false, error: '응답 파싱 실패' })))
    .then(j => cb({ ok: !!j.ok, result: j, body: j, error: j.error }))
    .catch(e => cb({ ok: false, error: String(e && e.message || e) }));
}

async function cacheGet(path, date) {
  try {
    const r = await fetch(`${CACHE_GET}?path=${encodeURIComponent(path)}&date=${encodeURIComponent(date)}`);
    const j = await r.json();
    return { ok: !!j.ok, hit: !!j.hit, entry: j.entry || null };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
async function cachePut(path, date, html) {
  try {
    const r = await fetch(CACHE_PUT, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, date, html }) });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
async function sendTelemetry(payload) {
  try {
    const r = await fetch(TELE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}) });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

/* ---- chunk 분할 ----------------------------------------------------------- */
function ymd(d) { return d.toISOString().slice(0, 10); }
function pad2(n) { return String(n).padStart(2, '0'); }
function* dateChunks(startISO, endISO, chunkDays) {
  // chunkDays = 1 → 하루씩. >1 → 시작일 + N-1까지 묶음.
  let s = new Date(startISO + 'T00:00:00');
  const end = new Date(endISO + 'T00:00:00');
  while (s <= end) {
    let e = new Date(s); e.setDate(s.getDate() + Math.max(1, chunkDays) - 1);
    if (e > end) e = end;
    yield { s: ymd(s), e: ymd(e) };
    s = new Date(e); s.setDate(e.getDate() + 1);
  }
}
/**
 * chunkDateRange → ubdstore URL 생성. 원본 url의 syear/sday/eyear/eday만 갈아끼움.
 */
function buildChunkUrl(baseUrl, s, e) {
  const u = new URL(baseUrl);
  const [sy, sm, sd] = s.split('-');
  const [ey, em, ed] = e.split('-');
  u.searchParams.set('syear', sy);   u.searchParams.set('smonth', sm); u.searchParams.set('sday', sd);
  u.searchParams.set('eyear', ey);   u.searchParams.set('emonth', em); u.searchParams.set('eday', ed);
  u.searchParams.set('reqPage', '1');
  return u.toString();
}

/* ---- 진행 통지 ------------------------------------------------------------ */
function sendProgress(tabId, payload) {
  try { chrome.tabs.sendMessage(tabId, { source: 'ub-bg', type: 'cacheProgress', ...payload }, () => void chrome.runtime.lastError); } catch (_) {}
}

/* ---- 본 작업: cacheSearch ------------------------------------------------- */
async function runCacheSearch(msg, sender) {
  const { path, url, startDate, endDate, chunkDays } = msg;
  const tabId = sender?.tab?.id;
  const t0 = Date.now();
  const chunks = [...dateChunks(startDate, endDate, chunkDays || 1)];
  const out = [];
  let hits = 0, miss = 0, savedMs = 0;
  let i = 0;
  for (const c of chunks) {
    i++;
    sendProgress(tabId, { phase: 'fetch', current: i, total: chunks.length, date: c.s });
    // 1. 캐시 조회 (chunk 시작일을 키로)
    const g = await cacheGet(path, c.s);
    if (g && g.hit && g.entry) {
      hits++;
      out.push({ date: c.s, hit: true, bytes: g.entry.sizeBytes || 0 });
      sendTelemetry({ type: 'cache_hit', path, date: c.s });
      continue;
    }
    // 2. miss → ubdstore fetch
    miss++;
    sendTelemetry({ type: 'cache_miss', path, date: c.s });
    const cu = buildChunkUrl(url, c.s, c.e);
    const ft0 = Date.now();
    let html = '', bytes = 0, ok = false;
    try {
      const r = await fetch(cu, { credentials: 'include', cache: 'no-cache' });
      const buf = await r.arrayBuffer();
      bytes = buf.byteLength;
      // 응답 인코딩 자동 디코딩(infoItemBarPrint와 동일 패턴: UTF-8 우선)
      try { html = new TextDecoder('utf-8', { fatal: false }).decode(buf); }
      catch (_) { html = new TextDecoder('euc-kr').decode(buf); }
      ok = r.ok && bytes > 1000;   // 200이라도 빈 응답(<1KB)이면 fail로 간주
    } catch (e) { ok = false; }
    const ftMs = Date.now() - ft0;
    if (ok) {
      await cachePut(path, c.s, html);
      sendTelemetry({ type: 'chunk_fetch', path, date: c.s, ms: ftMs, bytes });
      // 캐시 hit 됐다면 절약됐을 시간 = 이 chunk fetch 시간 (다음번엔 0초)
      savedMs += ftMs;
    }
    out.push({ date: c.s, hit: false, ok, ms: ftMs, bytes });
  }
  const totalMs = Date.now() - t0;
  sendTelemetry({ type: 'search_done', path, chunks: chunks.length, hits, miss, totalMs, savedMs });
  sendProgress(tabId, { phase: 'done', current: chunks.length, total: chunks.length });
  return { ok: true, chunks: out, totalMs, hits, miss, savedMs };
}

/* ---- 자동 갱신 체크 -------------------------------------------------------
 * ⚠ v3.0.1 부터 chrome.runtime.reload() 자동 호출 폐기.
 *   reload 시 진행 중인 인쇄/캐시 메시지가 끊겨 사용자 인쇄 실패 사례 발생.
 *   대신 새 버전 감지 시 chrome.action badge 'NEW' + storage 플래그만 세팅.
 *   실제 적용은: ①다음 chrome 재시작 시 폴더 manifest 자동 로드(압축해제 확장),
 *               ②사용자가 popup에서 "지금 적용" 클릭 시 reload (수동).
 *   매장 PC는 매일 chrome 켜고 끄므로 자연 적용.
 * SW가 idle 후 깨어날 때마다 fetch 호출도 폐기 — 알람과 onStartup만으로 충분.
 * ----------------------------------------------------------------------- */
async function checkUpdate() {
  try {
    const r = await fetch(REMOTE_SHELL + '?_=' + Date.now(), { cache: 'no-cache' });
    if (!r.ok) return;
    const remote = await r.json();
    const local = chrome.runtime.getManifest().version;
    if (remote.version && remote.version !== local) {
      console.log('[UB][bg] new shell version', remote.version, 'local', local, '(program sync → restart to apply)');
      // 프로그램(ExtSync)에 즉시 동기화 트리거 — 20분 타이머를 기다리지 않고 폴더를 갱신.
      // SW 는 웹페이지가 아니라 PNA/CORS 면제. 실패해도 무해(프로그램 타이머가 결국 처리).
      try { fetch('http://127.0.0.1:17600/ext/sync').catch(() => {}); } catch (_) {}
      try { chrome.action.setBadgeText({ text: 'NEW' }); } catch (_) {}
      try { chrome.action.setBadgeBackgroundColor({ color: '#35C5F0' }); } catch (_) {}

      // 데스크톱 알림 — 같은 버전으로 이미 알렸으면 skip(스팸 방지).
      chrome.storage.local.get({ ubUpdateNotifiedVer: '' }, (s) => {
        try {
          chrome.storage.local.set({ ubUpdateAvailable: remote.version });
        } catch (_) {}
        if (s && s.ubUpdateNotifiedVer !== remote.version) {
          try {
            chrome.notifications.create('ub-update-' + remote.version, {
              type: 'basic',
              iconUrl: 'icons/icon128.png',
              title: '유비샵 확장 새 버전 v' + remote.version,
              message: '자동 동기화됨. 브라우저를 완전히 껐다 켜면 적용됩니다.',
              priority: 2,
              requireInteraction: true
            }, () => { void chrome.runtime.lastError; });
            chrome.storage.local.set({ ubUpdateNotifiedVer: remote.version });
          } catch (_) {}
        }
      });
    } else {
      try { chrome.action.setBadgeText({ text: '' }); } catch (_) {}
      try { chrome.storage.local.set({ ubUpdateAvailable: '', ubUpdateNotifiedVer: '' }); } catch (_) {}
    }
  } catch (e) { console.warn('[UB][bg] update check failed:', e && e.message); }
}

// v3.1.4: 알림 클릭 시 팝업 열기 힌트 — 실제 popup open 은 브라우저 정책상 불가하므로
// 알림 자체가 사용자 시선 유도. 클릭 시 알림 제거만.
try {
  chrome.notifications.onClicked.addListener((id) => {
    if (id && id.indexOf('ub-update-') === 0) {
      try { chrome.notifications.clear(id); } catch (_) {}
    }
  });
} catch (_) {}
chrome.runtime.onStartup.addListener(checkUpdate);
chrome.runtime.onInstalled.addListener(checkUpdate);
try {
  // 60분(이전 30분) 주기. fetch 1회만 + reload 없음.
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 60 });
  chrome.alarms.onAlarm.addListener(a => { if (a.name === UPDATE_ALARM) checkUpdate(); });
} catch (e) {}
// ★ SW 깨어날 때마다 호출하던 checkUpdate(); 즉시호출 제거 — onStartup/onInstalled/알람만.

/* =============================================================================
 *  계정 빠른 전환 오케스트레이터 (v3.3.0)
 *  ⚠ honsu114 는 CSP(script-src) 로 inline <script> 주입을 막는다 → content-script
 *    주입 방식은 로그아웃/로그인 함수 실행이 통째로 차단됨. 대신 확장 권한으로
 *    chrome.scripting.executeScript({world:'MAIN'}) 를 쓰면 페이지 CSP 무관하게
 *    페이지 전역 함수(link/login)를 직접 호출할 수 있다(= 이 파일이 SW인 이유).
 *
 *  6단계 흐름(사용자 확정): 현재화면 감지 → 로그아웃(홈=link('logout'), PMS=/logout.do)
 *    → honsu114 홈 로그아웃(이미면 skip) → login.ubs → 아이디/비번+login() → PMS 진입.
 *
 *  탭 로딩 완료(onUpdated complete)를 신호로 단계 전진. 상태는 storage(ubLoginFlow).
 * ========================================================================== */
const UB_LOGIN_URL = 'https://www.honsu114.com/mall/login.ubs';
const UB_WATCHDOG = 'ubWatchdog';
const ubLog = (...a) => { try { console.log('[UB][login]', ...a); } catch (_) {} };

/* ---- MAIN world 주입 함수(직렬화되어 페이지에서 실행, 외부변수 사용불가) ---- */
function UB_PROBE() {
  const q = s => document.querySelector(s);
  const pw = q('input[name="sysUser.fpasswd"]') || q('input[type=password]');
  const vis = el => !!(el && el.offsetParent !== null && el.getClientRects().length);
  const logout = [...document.querySelectorAll('a[href]')].find(a => {
    const t = (a.textContent || '').replace(/\s/g, ''); const h = a.getAttribute('href') || '';
    return /로그아웃|logout/i.test(t) || /logout|logoff|signout/i.test(h);
  });
  const pms = q('a.pms') || q('a[href*="pamasLogin.do" i]');
  const onPms = /(^|\.)ubshop\.biz$/i.test(location.hostname);
  const captcha = vis(q('iframe[src*="recaptcha"]')) || vis(q('.g-recaptcha')) || vis(q('input[name="sysUser.fcaptcha"]'));
  // 로그인된 홈의 현재 계정 표시(li.user "쇼핑몰 님" 등) → "님" 접미사·중복공백 제거.
  // PMS 관리자 화면 등 표시 요소가 없으면 '' (비교 불가로 안전하게 일반 진행).
  const u = q('li.user') || q('.user');
  const loginName = u ? (u.textContent || '').replace(/\s*님\s*$/, '').replace(/\s+/g, ' ').trim() : '';
  return { url: location.href, host: location.hostname, path: location.pathname,
    hasForm: !!(pw && pw.form), hasLogout: !!logout, hasPms: onPms, pmsHref: pms ? pms.href : null, captcha: !!captcha, loginName, ambiguous: false };
}
function UB_DO_LOGOUT() {
  try { if (typeof link === 'function') { link('logout'); return { via: 'link' }; } } catch (e) {}
  const a = [...document.querySelectorAll('a[href]')].find(x => {
    const t = (x.textContent || '').replace(/\s/g, ''); const h = x.getAttribute('href') || '';
    return /로그아웃|logout/i.test(t) || /logout/i.test(h);
  });
  if (a) { const h = a.getAttribute('href') || ''; if (!/^javascript:/i.test(h)) { location.href = new URL(h, location.href).href; return { via: 'href' }; } }
  location.href = '/logout.do'; return { via: 'fallback' };
}
function UB_FILL_LOGIN(userid, pw) {
  const q = s => document.querySelector(s);
  const set = (el, v) => { if (!el) return false; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; };
  const okId = set(q('input[name="sysUser.fuserid"]'), userid);
  const okPw = set(q('input[name="sysUser.fpasswd"]'), pw);
  let via = '';
  try { if (typeof login === 'function') { login(); via = 'login()'; } } catch (e) { via = 'err'; }
  if (via !== 'login()') {
    const btn = document.querySelector('a.btn_submit, [onclick*="login" i]');
    if (btn) { btn.click(); via += '|btn'; }
    else { const f = q('input[name="sysUser.fpasswd"]') && q('input[name="sysUser.fpasswd"]').form; if (f) { try { f.submit(); via += '|submit'; } catch (e) {} } }
  }
  return { okId, okPw, via };
}
function UB_FOCUS_CAPTCHA() { const c = document.querySelector('input[name="sysUser.fcaptcha"]'); if (c) c.focus(); }

/* ---- exec / 상태 / 복호화 ---- */
async function ubExec(tabId, func, args) {
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args: args || [] });
    return res && res[0] ? res[0].result : null;
  } catch (_) { ubLog('exec 실패'); return null; }
}
const ubGetFlow = async () => (await chrome.storage.local.get('ubLoginFlow')).ubLoginFlow;
const ubSetFlow = (f) => chrome.storage.local.set({ ubLoginFlow: f });
// 표시명 비교용 정규화(공백 접기·소문자화). loginName 저장/비교에 공통 사용.
const ubNormName = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
// 대상 계정의 loginName 필드를 갱신해 저장(실패해도 흐름은 계속).
async function ubSaveLoginName(accountId, loginName) {
  try {
    const { ubAccounts } = await chrome.storage.local.get('ubAccounts');
    const list = ubAccounts || [];
    const acc = list.find(a => a.id === accountId || ubNormName(a.loginName || a.userid) === ubNormName(accountId));
    if (!acc || acc.loginName === loginName) return;
    acc.loginName = loginName;
    await chrome.storage.local.set({ ubAccounts: list });
  } catch (e) { ubLog('loginName 저장 실패', e && e.message); }
}
async function ubVaultKey() {
  const { ubLoginSalt } = await chrome.storage.local.get('ubLoginSalt');
  if (!ubLoginSalt) return null;
  const salt = Uint8Array.from(atob(ubLoginSalt), c => c.charCodeAt(0));
  const pass = new TextEncoder().encode('ubshop-acct-vault-v2');
  const base = await crypto.subtle.importKey('raw', pass, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
async function ubAccount(id) {
  const { ubAccounts } = await chrome.storage.local.get('ubAccounts');
  return (ubAccounts || []).find(a => a.id === id || ubNormName(a.loginName || a.userid) === ubNormName(id));
}
async function ubDecrypt(acc) {
  const key = await ubVaultKey(); if (!key) throw new Error('no key');
  const o = acc.pwEnc; const iv = Uint8Array.from(atob(o.iv), c => c.charCodeAt(0)); const ct = Uint8Array.from(atob(o.ct), c => c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}

/* ---- 관측 기반 단계 진행 ---- */
const _ubLastStep = {};
const _ubStepInFlight = {};
let _ubActiveFlowId = null;

function ubArmWatchdog() {
  try { chrome.alarms.create(UB_WATCHDOG, { delayInMinutes: 0.5 }); } catch (_) {}
}

function ubClearWatchdog() {
  try { chrome.alarms.clear(UB_WATCHDOG); } catch (_) {}
}

function ubFlowId(now) {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : now + '-' + Math.random().toString(36).slice(2);
}

function ubObservedPage(probe) {
  let url = '';
  try { const u = new URL(probe.url); url = u.origin + u.pathname; } catch (_) {}
  return {
    url,
    host: probe.host,
    signals: {
      hasForm: probe.hasForm,
      hasLogout: probe.hasLogout,
      hasPms: probe.hasPms,
      captcha: probe.captcha,
      ambiguous: probe.ambiguous
    }
  };
}

function ubTransition(flow, decision, now) {
  const from = flow.phase;
  if (['logout', 'navigateLogin', 'fillLogin', 'navigatePms'].includes(decision.action)) {
    flow.attempts[from] = (flow.attempts[from] || 0) + 1;
  }
  if (decision.setSubmittedFor) flow.submittedFor = decision.setSubmittedFor;
  if (decision.nextPhase && decision.nextPhase !== from) {
    flow.phase = decision.nextPhase;
    flow.enteredAt = now;
  }
  flow.lastTransition = { from, to: flow.phase, at: now, reason: decision.action };
}

async function ubTerminal(flow, phase, failureCode, terminalReason, now) {
  if (_ubActiveFlowId && _ubActiveFlowId !== flow.flowId) return;
  const from = flow.phase;
  flow.active = false;
  flow.phase = phase;
  flow.enteredAt = now;
  flow.lastFailureCode = failureCode || null;
  flow.terminalReason = terminalReason || failureCode || 'completed';
  flow.lastTransition = { from, to: phase, at: now, reason: flow.terminalReason };
  await ubSetFlow(flow);
  ubClearWatchdog();
}

async function ubForeignProbe(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const u = new URL(tab && tab.url || '');
    if (/(^|\.)(ubshop\.biz|honsu114\.com)$/i.test(u.hostname)) return null;
    return normalizeProbe({
      host: u.hostname, url: u.href, path: u.pathname,
      hasForm: false, hasLogout: false, hasPms: false, pmsHref: null,
      captcha: false, loginName: '', ambiguous: false
    });
  } catch (_) { return null; }
}

async function ubUpgradeFlow(flow) {
  if (flow.flowId && flow.attempts && Number.isFinite(flow.enteredAt) && Number.isFinite(flow.startedAt)) return flow;
  const now = Date.now();
  const legacyPhase = { loggingout: 'loggingOut', tologin: 'toLogin' };
  flow.phase = legacyPhase[flow.phase] || flow.phase;
  flow.flowId = flow.flowId || ubFlowId(now);
  flow.enteredAt = Number.isFinite(flow.enteredAt) ? flow.enteredAt : now;
  flow.startedAt = Number.isFinite(flow.startedAt) ? flow.startedAt : flow.enteredAt;
  flow.attempts = flow.attempts || {};
  const acc = await ubAccount(flow.accountId);
  if (_ubActiveFlowId && _ubActiveFlowId !== flow.flowId) return null;
  if (acc) {
    flow.accountId = acc.userid;
    flow.targetLoginName = acc.loginName || null;
  }
  if (flow.submittedFor == null) flow.submittedFor = flow.phase === 'submitted' ? flow.accountId : null;
  if (!Object.prototype.hasOwnProperty.call(flow, 'lastObservedPage')) flow.lastObservedPage = null;
  if (!Object.prototype.hasOwnProperty.call(flow, 'lastTransition')) flow.lastTransition = null;
  if (!Object.prototype.hasOwnProperty.call(flow, 'lastFailureCode')) flow.lastFailureCode = null;
  if (!Object.prototype.hasOwnProperty.call(flow, 'terminalReason')) flow.terminalReason = null;
  await ubSetFlow(flow);
  return flow;
}

async function ubApplyDecision(flow, probe, decision, now) {
  if (_ubActiveFlowId !== flow.flowId) return;
  flow.lastObservedPage = ubObservedPage(probe);

  if (['navigatePms', 'succeed', 'skip'].includes(decision.action) && probe.loginName) {
    await ubSaveLoginName(flow.accountId, probe.loginName);
    if (_ubActiveFlowId !== flow.flowId) return;
  }

  if (decision.action === 'wait') {
    await ubSetFlow(flow);
    ubArmWatchdog();
    return;
  }
  if (decision.action === 'fail') {
    if (decision.failureCode === 'captcha') await ubExec(flow.tabId, UB_FOCUS_CAPTCHA);
    if (_ubActiveFlowId !== flow.flowId) return;
    await ubTerminal(flow, 'failed', decision.failureCode, decision.terminalReason, now);
    return;
  }
  if (decision.action === 'succeed' || decision.action === 'skip') {
    await ubTerminal(flow, 'done', null, decision.terminalReason, now);
    return;
  }

  if (decision.action === 'fillLogin') {
    const acc = await ubAccount(flow.accountId);
    if (!acc) { await ubTerminal(flow, 'failed', 'decrypt_fail', 'account_missing', now); return; }
    let pw = '';
    try {
      try { pw = await ubDecrypt(acc); }
      catch (_) { await ubTerminal(flow, 'failed', 'decrypt_fail', 'decrypt_fail', now); return; }
      if (_ubActiveFlowId !== flow.flowId) return;
      ubTransition(flow, decision, now);
      await ubSetFlow(flow);
      if (_ubActiveFlowId !== flow.flowId) return;
      ubArmWatchdog();
      await ubExec(flow.tabId, UB_FILL_LOGIN, [acc.userid, pw]);
    } finally { pw = ''; }
    return;
  }

  if (_ubActiveFlowId !== flow.flowId) return;
  ubTransition(flow, decision, now);
  await ubSetFlow(flow);
  if (_ubActiveFlowId !== flow.flowId) return;
  ubArmWatchdog();
  if (decision.action === 'logout') await ubExec(flow.tabId, UB_DO_LOGOUT);
  else if (decision.action === 'navigateLogin') await chrome.tabs.update(flow.tabId, { url: UB_LOGIN_URL });
  else if (decision.action === 'navigatePms' && probe.pmsHref) await chrome.tabs.update(flow.tabId, { url: probe.pmsHref });
}

async function ubStep(tabId, expectedFlowId) {
  const stepKey = expectedFlowId || 'tab-' + tabId;
  if (_ubStepInFlight[stepKey]) return;
  _ubStepInFlight[stepKey] = true;
  try {
    let flow = await ubGetFlow();
    if (!flow || !flow.active || flow.tabId !== tabId) return;
    if (expectedFlowId && flow.flowId !== expectedFlowId) return;
    if (!flow.flowId) flow.flowId = ubFlowId(Date.now());
    if (_ubActiveFlowId && _ubActiveFlowId !== flow.flowId) return;
    _ubActiveFlowId = flow.flowId;
    flow = await ubUpgradeFlow(flow);
    if (!flow || _ubActiveFlowId !== flow.flowId) return;
    if (!expectedFlowId) expectedFlowId = flow.flowId;
    ubArmWatchdog();

    let probe = await ubForeignProbe(tabId);
    if (!probe) probe = normalizeProbe(await ubExec(tabId, UB_PROBE));

    flow = await ubGetFlow();
    if (!flow || !flow.active || flow.tabId !== tabId || flow.flowId !== expectedFlowId) return;
    const now = Date.now();
    const decision = decide(flow, probe, now);
    await ubApplyDecision(flow, probe, decision, now);
  } finally {
    delete _ubStepInFlight[stepKey];
  }
}

async function startSwitch(msg) {
  const tabId = msg.tabId;
  if (tabId == null) return { ok: false, error: 'no tab' };
  const acc = await ubAccount(msg.accountId);
  if (!acc) return { ok: false, error: 'account not found' };
  const now = Date.now();
  const flow = {
    active: true,
    flowId: ubFlowId(now),
    accountId: acc.userid,
    targetLoginName: acc.loginName || null,
    tabId,
    phase: 'start',
    enteredAt: now,
    startedAt: now,
    attempts: {},
    submittedFor: null,
    lastObservedPage: null,
    lastTransition: null,
    lastFailureCode: null,
    terminalReason: null
  };
  _ubActiveFlowId = flow.flowId;
  await ubSetFlow(flow);
  ubArmWatchdog();
  ubStep(tabId, flow.flowId);
  return { ok: true, flowId: flow.flowId };
}

/* ---- 탭 로딩 완료마다 다음 단계 ---- */
try {
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== 'complete') return;
    chrome.storage.local.get('ubLoginFlow', ({ ubLoginFlow }) => {
      if (!ubLoginFlow || !ubLoginFlow.active || ubLoginFlow.tabId !== tabId) return;
      const now = Date.now();
      if (_ubLastStep[tabId] && now - _ubLastStep[tabId] < 400) return;  // 중복 complete 디바운스
      _ubLastStep[tabId] = now;
      ubStep(tabId, ubLoginFlow.flowId);
    });
  });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (!alarm || alarm.name !== UB_WATCHDOG) return;
    ubGetFlow().then(flow => {
      if (flow && flow.active) ubStep(flow.tabId, flow.flowId);
    });
  });
} catch (e) {}

// SW 재시작 시 저장 phase가 아니라 live probe로 재조정한다.
ubGetFlow().then(flow => {
  if (flow && flow.active) { ubArmWatchdog(); ubStep(flow.tabId, flow.flowId); }
});
