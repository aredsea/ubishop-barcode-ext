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
const UB_HOME_URL = 'https://www.honsu114.com/';
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
  const captcha = vis(q('iframe[src*="recaptcha"]')) || vis(q('.g-recaptcha')) || vis(q('input[name="sysUser.fcaptcha"]'));
  // 로그인된 홈의 현재 계정 표시(li.user "쇼핑몰 님" 등) → "님" 접미사·중복공백 제거.
  // PMS 관리자 화면 등 표시 요소가 없으면 '' (비교 불가로 안전하게 일반 진행).
  const u = q('li.user') || q('.user');
  const loginName = u ? (u.textContent || '').replace(/\s*님\s*$/, '').replace(/\s+/g, ' ').trim() : '';
  return { url: location.href, host: location.hostname, path: location.pathname,
    hasForm: !!(pw && pw.form), hasLogout: !!logout, hasPms: !!pms, pmsHref: pms ? pms.href : null, captcha: !!captcha, loginName };
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
  } catch (e) { ubLog('exec 실패', e && e.message); return null; }
}
const ubGetFlow = async () => (await chrome.storage.local.get('ubLoginFlow')).ubLoginFlow;
const ubSetFlow = (f) => chrome.storage.local.set({ ubLoginFlow: f });
const ubEndFlow = () => chrome.storage.local.remove('ubLoginFlow');
// 표시명 비교용 정규화(공백 접기·소문자화). loginName 저장/비교에 공통 사용.
const ubNormName = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
// 대상 계정의 loginName 필드를 갱신해 저장(실패해도 흐름은 계속).
async function ubSaveLoginName(accountId, loginName) {
  try {
    const { ubAccounts } = await chrome.storage.local.get('ubAccounts');
    const list = ubAccounts || [];
    const acc = list.find(a => a.id === accountId);
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
async function ubAccount(id) { const { ubAccounts } = await chrome.storage.local.get('ubAccounts'); return (ubAccounts || []).find(a => a.id === id); }
async function ubDecrypt(acc) {
  const key = await ubVaultKey(); if (!key) throw new Error('no key');
  const o = acc.pwEnc; const iv = Uint8Array.from(atob(o.iv), c => c.charCodeAt(0)); const ct = Uint8Array.from(atob(o.ct), c => c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}

/* ---- 단계 진행 ---- */
async function ubStep(tabId) {
  const flow = await ubGetFlow();
  if (!flow || !flow.active || flow.tabId !== tabId) return;
  flow.tries = (flow.tries || 0) + 1;
  if (flow.tries > 12) { ubLog('반복 초과 — 중단'); await ubEndFlow(); return; }
  await ubSetFlow(flow);

  const p = await ubExec(tabId, UB_PROBE);
  if (!p) return;   // 페이지 준비 전 — 다음 complete 에 재시도
  ubLog('감지', p.host, JSON.stringify({ form: p.hasForm, logout: p.hasLogout, pms: p.hasPms, cap: p.captcha }), 'phase=' + flow.phase);

  // A) 로그인 폼
  if (p.hasForm) {
    if (p.captcha) { ubLog('캡차 표시 → 중단(비번 확인/캡차 직접 입력)'); await ubExec(tabId, UB_FOCUS_CAPTCHA); await ubEndFlow(); return; }
    if (flow.phase === 'submitted') { ubLog('로그인 폼 재표시 → 실패로 판단, 중단'); await ubEndFlow(); return; }
    const acc = await ubAccount(flow.accountId);
    if (!acc) { await ubEndFlow(); return; }
    let pw = ''; try { pw = await ubDecrypt(acc); } catch (e) { ubLog('복호화 실패'); await ubEndFlow(); return; }
    flow.phase = 'submitted'; await ubSetFlow(flow);
    const r = await ubExec(tabId, UB_FILL_LOGIN, [acc.userid, pw]);
    pw = '';
    ubLog('로그인 입력/제출 →', acc.alias || acc.userid, JSON.stringify(r));
    return;
  }

  // B) 로그인 상태(로그아웃 링크 존재)
  if (p.hasLogout) {
    if (flow.phase === 'submitted') {
      // 로그인 성공(새 계정) → 표시명 실시간 갱신 후 PMS 진입.
      if (p.loginName) await ubSaveLoginName(flow.accountId, p.loginName);
      if (p.pmsHref) { ubLog('로그인 완료 → PMS 진입'); await ubEndFlow(); chrome.tabs.update(tabId, { url: p.pmsHref }); return; }
      ubLog('로그인 완료(홈) — PMS 링크 없음, 종료'); await ubEndFlow(); return;
    }
    // 최초 진입(start)에 이미 로그인된 상태 → 대상 계정과 표시명 비교.
    // 일치하면 로그아웃/로그인 반복(꼬임)을 피하고 바로 PMS 진입 또는 종료.
    if (flow.phase === 'start' && p.loginName) {
      const acc = await ubAccount(flow.accountId);
      const saved = acc && acc.loginName;
      if (saved && ubNormName(saved) === ubNormName(p.loginName)) {
        ubLog('이미 해당 계정으로 로그인됨 — 전환 생략');
        if (p.pmsHref) { await ubEndFlow(); chrome.tabs.update(tabId, { url: p.pmsHref }); return; }
        await ubEndFlow(); return;
      }
    }
    ubLog('로그아웃 실행');
    await ubExec(tabId, UB_DO_LOGOUT);
    flow.phase = 'loggingout'; await ubSetFlow(flow);
    return;
  }

  // C) 로그아웃 상태 + 폼 없음 → 로그인 페이지로
  if (!/\/mall\/login\.ubs/i.test(p.path || '')) {
    ubLog('로그인 페이지로 이동');
    flow.phase = 'tologin'; await ubSetFlow(flow);
    chrome.tabs.update(tabId, { url: UB_LOGIN_URL });
    return;
  }
  ubLog('로그인 폼 못 찾음 — 중단'); await ubEndFlow();
}

async function startSwitch(msg) {
  const tabId = msg.tabId;
  if (tabId == null) return { ok: false, error: 'no tab' };
  await ubSetFlow({ active: true, accountId: msg.accountId, tabId, phase: 'start', tries: 0 });
  let host = ''; try { host = new URL(msg.tabUrl).hostname; } catch (_) {}
  ubLog('전환 시작', host || '(unknown)');
  if (!/ubshop\.biz$|honsu114\.com$/i.test(host)) {
    chrome.tabs.update(tabId, { url: UB_HOME_URL });   // 유비샵/GNSHOP 아닌 곳 → 홈으로
    return { ok: true, nav: 'home' };
  }
  ubStep(tabId);
  return { ok: true };
}

/* ---- 탭 로딩 완료마다 다음 단계 ---- */
const _ubLastStep = {};
try {
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== 'complete') return;
    chrome.storage.local.get('ubLoginFlow', ({ ubLoginFlow }) => {
      if (!ubLoginFlow || !ubLoginFlow.active || ubLoginFlow.tabId !== tabId) return;
      const now = Date.now();
      if (_ubLastStep[tabId] && now - _ubLastStep[tabId] < 400) return;  // 중복 complete 디바운스
      _ubLastStep[tabId] = now;
      ubStep(tabId);
    });
  });
} catch (e) {}
