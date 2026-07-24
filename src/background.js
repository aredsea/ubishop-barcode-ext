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

  // ---- 자동화 오케스트레이터 ----
  if (msg.type === 'ubAutoCreateJob')  { sendResponse(ubAutoCreateJob(msg, sender)); return false; }
  if (msg.type === 'ubAutoFrameReady') { ubAutoOnFrameReady(msg, sender).then(sendResponse).catch(e => sendResponse({ ok:false, error:String(e&&e.message||e) })); return true; }
  if (msg.type === 'ubAutoEndJob')     { sendResponse(ubAutoEndJob(msg.jobId, 'controller_end', sender)); return false; }
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
  // 사용자가 '직접 풀어야 하는' 캡차만 트리거한다: honsu114 텍스트 캡차(sysUser.fcaptcha)가
  // 실제로 보이거나, reCAPTCHA 이미지 챌린지 팝업(api2/bframe)이 떠 있을 때. 항상 떠 있는
  // invisible reCAPTCHA 배지/앵커는 로그인 클릭 시 자동 검증되므로 제외 — 이걸 캡차로
  // 오인해 아이디·비번은 채워진 채 login.ubs 에서 반자동이 멈춰 있었다(사용자 실측).
  const captcha = vis(q('input[name="sysUser.fcaptcha"]')) || vis(q('iframe[src*="recaptcha/api2/bframe" i]'));
  // 로그인된 홈의 현재 계정 표시(li.user "쇼핑몰 님" 등) → "님" 접미사·중복공백 제거.
  // PMS 관리자 화면 등 표시 요소가 없으면 '' (비교 불가로 안전하게 일반 진행).
  const u = q('li.user') || q('.user');
  const loginName = u ? (u.textContent || '').replace(/\s*님\s*$/, '').replace(/\s+/g, ' ').trim() : '';
  const hasForm = !!(pw && pw.form);
  // 진단 — 로그인 페이지(폼 존재)에 도달했음을 F12 콘솔에 남긴다.
  if (hasForm) { try { console.log('[UB][login] reached-login', { path: location.pathname }); } catch (e) {} }
  return { url: location.href, host: location.hostname, path: location.pathname,
    hasForm, hasLogout: !!logout, hasPms: onPms, pmsHref: pms ? pms.href : null, captcha: !!captcha, loginName, ambiguous: false };
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
  const idEl = q('input[name="sysUser.fuserid"]');
  const pwEl = q('input[name="sysUser.fpasswd"]');
  // Chrome 저장 비밀번호 자동완성이 우리 값을 이전 계정으로 되돌리는 걸 막는다:
  //  ① 대상 input·form 의 autocomplete 를 끄고
  //  ② 네이티브 value setter 로 값을 넣어(프레임워크/브라우저의 value 추적을 우회)
  //  ③ input·change 를 버블로 발사해 페이지 로직이 값을 정상 인식하게 한다.
  const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const set = (el, v) => {
    if (!el) return false;
    try { el.setAttribute('autocomplete', 'off'); } catch (e) {}
    try { nativeSet.call(el, v); } catch (e) { el.value = v; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  try { const f = (idEl && idEl.form) || (pwEl && pwEl.form); if (f) f.setAttribute('autocomplete', 'off'); } catch (e) {}
  const okId = set(idEl, userid);
  const okPw = set(pwEl, pw);
  // 진단(비밀번호 값은 절대 로그하지 않는다 — 길이만). F12 로그인 페이지 콘솔에서 어느 계정으로 채웠는지 확인.
  try { console.log('[UB][login] fill', { okId, okPw, useridPrefix: String(userid).slice(0, 4), pwLen: String(pw).length }); } catch (e) {}
  // 제출 직전 아이디를 다시 못박는다 — 그 사이 자동완성이 값을 되돌렸을 수 있다.
  if (idEl) {
    try { nativeSet.call(idEl, userid); } catch (e) { idEl.value = userid; }
    idEl.dispatchEvent(new Event('input', { bubbles: true }));
    idEl.dispatchEvent(new Event('change', { bubbles: true }));
  }
  let via = '';
  try { if (typeof login === 'function') { login(); via = 'login()'; } } catch (e) { via = 'err'; }
  if (via !== 'login()') {
    const btn = document.querySelector('a.btn_submit, [onclick*="login" i]');
    if (btn) { btn.click(); via += '|btn'; }
    else { const f = pwEl && pwEl.form; if (f) { try { f.submit(); via += '|submit'; } catch (e) {} } }
  }
  try { console.log('[UB][login] submit', { via, useridPrefix: String(userid).slice(0, 4) }); } catch (e) {}
  return { okId, okPw, via };
}

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
const _ubStepTimer = {};
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
    // 진단 — 채우려는 대상 계정이 팝업이 요청한 target 인지 확인(이전 계정 아님).
    ubLog('target', { phase: flow.phase, requested: flow.accountId, useridPrefix: String(acc.userid).slice(0, 4) });
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
  // 진단 — 팝업이 요청한 accountId 가 어느 계정으로 해석됐는지 확인(전환 대상 = target).
  ubLog('target', { requested: msg.accountId, useridPrefix: String(acc.userid).slice(0, 4), loginName: acc.loginName || null });
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
    // 트레일링 디바운스 — 한 navigation 이 여러 complete(리다이렉트 체인)를 내면 '마지막'
    // 것만 처리한다. 이전 리딩 디바운스는 중간 리다이렉트의 첫 complete 만 처리하고 실제
    // 로그인 폼 페이지의 마지막 complete 를 400ms 창에서 버려, 자동입력이 안 걸렸다.
    // setTimeout 이 유실돼도(SW 종료 등) 30초 watchdog 알람이 복구한다.
    if (_ubStepTimer[tabId]) clearTimeout(_ubStepTimer[tabId]);
    _ubStepTimer[tabId] = setTimeout(() => {
      delete _ubStepTimer[tabId];
      chrome.storage.local.get('ubLoginFlow', ({ ubLoginFlow }) => {
        if (!ubLoginFlow || !ubLoginFlow.active || ubLoginFlow.tabId !== tabId) return;
        ubStep(tabId, ubLoginFlow.flowId);
      });
    }, 300);
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

/* =============================================================================
 *  자동화 오케스트레이터 (Phase 0 — 읽기 전용 스파이크)
 *  스펙: docs/superpowers/specs/2026-07-20-orderitem-batch-design.md §3.2
 *
 *  ★불변식 1 — background 가 operation 과 인자를 독점한다.
 *    자식 프레임(skin.js 자동화 러너)은 "준비됐다 + 내가 어떤 문서인가"만 보고한다.
 *    무엇을 어떤 인자로 실행할지는 전적으로 여기서 정한다. 허용 목록이 있어도
 *    자식이 operation 이나 대상을 고를 수 있으면 그건 경계가 아니다.
 *
 *  ★불변식 2 — MAIN world 로만 페이지 함수를 부른다.
 *    ISOLATED content script 는 MV3 CSP 때문에 javascript: 링크·inline handler 를
 *    실행하지 못한다(Chrome 공식 문서·samples#769). 페이지 전역 함수를 부르는
 *    유일한 길이 world:'MAIN' 주입이다. 계정전환도 같은 이유로 이 경로를 쓴다(296행~).
 *
 *  ★불변식 3 — frameId 가 아니라 documentId 로 타겟한다.
 *    frameId 는 navigation 후 같은 번호가 새 문서에 재사용될 수 있어 로드/주입
 *    사이에 경합이 난다. 대신 worker '슬롯'의 동일성은 frameId 로 고정한다.
 *
 *  ⚠ Phase 0 범위: 읽기(READ_PAGE_FACTS) 하나뿐이다. 쓰기 operation 은 Phase 0
 *    체크리스트를 통과한 뒤에 추가한다. 저널(§3.7)도 그때 함께 들어간다.
 * ========================================================================== */
const UB_AUTO_ORIGINS = ['http://ubdstore.ubshop.biz', 'https://ubdstore.ubshop.biz'];
const UB_AUTO_CONTROLLER_PATH = '/jun/orderitem/orderItemList.do';
const UB_AUTO_IDLE_TTL_MS = 5 * 60 * 1000;    // lastActivity 기준
const UB_AUTO_HARD_TTL_MS = 10 * 60 * 1000;   // createdAt 기준 — READY 반복으로 무한 연장되는 걸 막는다
const UB_AUTO_MAX_RESULTS = 32;

// operation → 허용 경로(exact). 다른 페이지에서 온 요청은 거부한다.
const UB_AUTO_OPS = {
  READ_PAGE_FACTS: {
    write: false,
    paths: [
      '/jun/orderitem/orderItemList.do',
      '/jun/orderitem/orderItemPopCurrentSettingModifyForm.do',
      '/jun/orderitem/orderItemModifyForm.do'
    ]
  }
};

/* ★단계는 background 가 소유한다 — 자식이 어느 페이지를 태울지 고르지 못한다.
 *  expectReject:true 는 "이 경로는 op 허용목록 밖이므로 거부되어야 정상" 이라는 뜻이다.
 *  거부 단계도 반드시 같은 worker 프레임으로 와야 한다(다른 프레임이면 frame_mismatch 라
 *  경로 검사에 도달하지 못해 아무것도 증명하지 못한다). */
const UB_AUTO_SPIKE_STEPS = Object.freeze([
  Object.freeze({ key: 'list',       path: '/jun/orderitem/orderItemList.do',       expectReject: false }),
  Object.freeze({ key: 'modifyForm', path: '/jun/orderitem/orderItemModifyForm.do', expectReject: false }),
  Object.freeze({ key: 'denied',     path: '/info/item/infoItemList.do',            expectReject: true  })
]);

const ubAutoJobs = new Map();   // jobId → job
const ubAutoLog = (...a) => { try { console.log('[UB][auto]', ...a); } catch (_) {} };

function ubAutoNewId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return 'ubauto_' + Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

// 문자열 prefix 가 아니라 URL 로 파싱해 origin·path 를 정확히 본다.
function ubAutoParse(url) {
  try { const u = new URL(url); return { origin: u.origin, path: u.pathname }; }
  catch (_) { return null; }
}

function ubAutoExpired(job, now) {
  return (now - job.createdAt > UB_AUTO_HARD_TTL_MS) || (now - job.lastActivity > UB_AUTO_IDLE_TTL_MS);
}

// 컨트롤러 메시지 공통 검증 — jobId 만 알면 아무나 조작할 수 있으면 경계가 아니다.
function ubAutoCheckController(job, sender) {
  if (!sender || !sender.tab || sender.tab.id !== job.tabId) return 'tab_mismatch';
  if (sender.frameId !== 0) return 'not_controller_frame';
  if (!sender.documentId || sender.documentId !== job.controllerDocumentId) return 'controller_document_mismatch';
  const loc = ubAutoParse(sender.url || '');
  if (!loc || !UB_AUTO_ORIGINS.includes(loc.origin) || loc.path !== UB_AUTO_CONTROLLER_PATH) return 'controller_path_mismatch';
  return null;
}

function ubAutoCreateJob(msg, sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (tabId == null) return { ok: false, error: 'no_tab' };
  if (sender.frameId !== 0) return { ok: false, error: 'controller_must_be_top' };
  if (!sender.documentId) return { ok: false, error: 'no_document_id' };
  const loc = ubAutoParse(sender.url || '');
  if (!loc || !UB_AUTO_ORIGINS.includes(loc.origin)) return { ok: false, error: 'bad_origin' };
  if (loc.path !== UB_AUTO_CONTROLLER_PATH) return { ok: false, error: 'controller_path_not_allowed' };
  // Phase 0 은 스파이크뿐. 임의 feature 문자열을 받지 않는다.
  if (msg && msg.feature !== 'spike') return { ok: false, error: 'feature_not_allowed' };

  const now = Date.now();
  for (const [id, j] of ubAutoJobs) if (ubAutoExpired(j, now)) ubAutoJobs.delete(id);
  for (const j of ubAutoJobs.values()) if (j.tabId === tabId) return { ok: false, error: 'job_already_running' };

  const job = {
    jobId: ubAutoNewId(),
    feature: 'spike',
    tabId,
    controllerDocumentId: sender.documentId,
    workerFrameId: null,            // ★경로 검증을 통과한 뒤에야 고정된다
    steps: UB_AUTO_SPIKE_STEPS,
    cursor: 0,
    // documentId 단독 — 한 문서는 한 번만 handshake 한다.
    // ⚠ 쓰기 operation 을 붙일 때 이걸 'operation dedupe' 로 재사용하면 안 된다.
    //   같은 문서에서 read 후 write 를 하려면 READY 는 문서 bind 전용으로 두고,
    //   operation 중복은 별도 nonce(+저널)로 막아야 한다.
    seen: new Set(),
    inFlight: false,
    createdAt: now,
    lastActivity: now,
    results: []
  };
  ubAutoJobs.set(job.jobId, job);
  ubAutoLog('job 생성', job.jobId, 'tab=' + tabId, '단계 ' + job.steps.length);
  return { ok: true, jobId: job.jobId, steps: job.steps.map(s => s.key) };
}

function ubAutoEndJob(jobId, reason, sender) {
  const job = ubAutoJobs.get(jobId);
  if (!job) return { ok: false, error: 'unknown_job' };
  // 컨트롤러가 부른 종료면 발신자를 검증한다(같은 탭의 다른 프레임이 끝내지 못하게).
  if (sender) {
    const bad = ubAutoCheckController(job, sender);
    if (bad) return { ok: false, error: bad };
  }
  ubAutoJobs.delete(jobId);
  const verdict = ubAutoVerdict(job);
  ubAutoLog('job 종료', jobId, reason, verdict.pass ? 'PASS' : ('FAIL: ' + verdict.reasons.join(', ')));
  return { ok: true, results: job.results, verdict };
}

/* 스파이크 판정을 background 가 계산한다 — 컨트롤러가 로그만 보고 눈대중하지 않게. */
function ubAutoVerdict(job) {
  const reasons = [];
  const byStep = new Map(job.results.map(r => [r.stepKey, r]));
  for (const step of job.steps) {
    const r = byStep.get(step.key);
    if (!r) { reasons.push(step.key + ': 결과 없음'); continue; }
    if (step.expectReject) {
      if (r.outcome !== 'rejected' || r.error !== 'path_not_allowed') {
        reasons.push(step.key + ': 거부되어야 하는데 ' + r.outcome + '/' + r.error);
      }
    } else {
      if (r.outcome !== 'ok') { reasons.push(step.key + ': ' + r.outcome + ' ' + (r.error || '')); continue; }
      if (!r.facts || r.facts.path !== step.path) reasons.push(step.key + ': facts.path 불일치');
    }
  }
  const ok = job.results.filter(r => r.outcome === 'ok');
  const docIds = new Set(ok.map(r => r.senderDocumentId));
  const frameIds = new Set(ok.map(r => r.frameId));
  // 재-handshake 증명: 같은 worker 슬롯(frameId 1개)에서 문서만 바뀌어야 한다.
  if (ok.length >= 2) {
    if (frameIds.size !== 1) reasons.push('worker frameId 가 ' + frameIds.size + '개 — 같은 슬롯이 아니다');
    if (docIds.size !== ok.length) reasons.push('documentId 가 재사용됐다 — navigation 재-handshake 미증명');
  } else {
    reasons.push('성공 단계가 2개 미만이라 재-handshake 를 증명할 수 없다');
  }
  return { pass: reasons.length === 0, reasons, okSteps: ok.length, documentIds: docIds.size, frameIds: frameIds.size };
}

function ubAutoRecord(job, entry) {
  if (job.results.length < UB_AUTO_MAX_RESULTS) job.results.push(entry);
  ubAutoLog('단계', entry.stepKey, entry.path, entry.outcome, entry.error || '');
}

/* 자식 프레임의 READY. 검증 순서가 안전 경계 자체다 —
 * 경로를 확인하기 전에 worker 슬롯을 내주면 페이지 스크립트가 슬롯을 선점할 수 있다. */
async function ubAutoOnFrameReady(msg, sender) {
  const now = Date.now();
  const job = ubAutoJobs.get(msg && msg.jobId);
  if (!job) return { ok: false, error: 'unknown_job' };
  if (ubAutoExpired(job, now)) { ubAutoJobs.delete(job.jobId); return { ok: false, error: 'expired' }; }

  // ① 발신자 신뢰 경계
  if (!sender || !sender.tab || sender.tab.id !== job.tabId) return { ok: false, error: 'tab_mismatch' };
  if (!Number.isInteger(sender.frameId) || sender.frameId <= 0) return { ok: false, error: 'not_subframe' };
  if (!sender.documentId) return { ok: false, error: 'no_document_id' };

  // ② URL — 문자열 prefix 가 아니라 파싱해서 exact 로
  const loc = ubAutoParse(sender.url || '');
  if (!loc || !UB_AUTO_ORIGINS.includes(loc.origin)) return { ok: false, error: 'bad_origin' };

  // ③ replay 차단 — 한 문서는 한 번만 처리한다.
  //    ⚠ 반드시 경로 검사보다 '먼저' 봐야 한다. 하나의 문서에서 DOMContentLoaded 와
  //      load 가 각각 READY 를 보내는데, 첫 READY 로 커서가 이미 다음 단계로 가 있어서
  //      두 번째를 나중에 보면 duplicate 가 아니라 unexpected_path 로 오분류된다.
  //      쓰기 operation 이 붙는 순간 이 오분류가 곧 중복 쓰기 창이 된다.
  if (job.seen.has(sender.documentId)) return { ok: false, error: 'duplicate_ready' };
  if (job.inFlight) return { ok: false, error: 'busy' };

  // ④ 지금 단계가 기대하는 경로인가 (background 가 소유한 단계)
  const step = job.steps[job.cursor];
  if (!step) return { ok: false, error: 'no_more_steps' };
  if (loc.path !== step.path) return { ok: false, error: 'unexpected_path', expected: step.path, got: loc.path };

  // ⑤ 여기까지 통과한 뒤에야 worker 슬롯을 고정/비교한다
  if (job.workerFrameId == null) job.workerFrameId = sender.frameId;
  else if (job.workerFrameId !== sender.frameId) return { ok: false, error: 'frame_mismatch' };

  job.seen.add(sender.documentId);
  job.lastActivity = now;

  // ⑥ operation 은 background 가 고른다. 경로가 허용목록 밖이면 여기서 거부된다.
  const op = 'READ_PAGE_FACTS';
  const spec = UB_AUTO_OPS[op];
  const base = { stepKey: step.key, op, path: loc.path, frameId: sender.frameId,
                 senderDocumentId: sender.documentId, at: now };
  if (!spec.paths.includes(loc.path)) {
    const entry = Object.assign({ outcome: 'rejected', error: 'path_not_allowed', facts: null }, base);
    ubAutoRecord(job, entry);
    job.cursor += 1;
    return { ok: false, error: 'path_not_allowed', entry };
  }

  // ⑦ 실행 — 정확히 그 문서에만
  job.inFlight = true;
  let entry;
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: job.tabId, documentIds: [sender.documentId] },
      world: 'MAIN',
      func: UB_AUTO_READ_FACTS
    });
    const bad = ubAutoBadInjection(res, sender, loc.path);
    entry = bad
      ? Object.assign({ outcome: 'invalid', error: bad, facts: null, injectionDocumentId: res && res[0] && res[0].documentId }, base)
      : Object.assign({ outcome: 'ok', error: null, facts: res[0].result, injectionDocumentId: res[0].documentId }, base);
  } catch (e) {
    entry = Object.assign({ outcome: 'error', error: String(e && e.message || e), facts: null }, base);
  } finally {
    job.inFlight = false;
  }
  ubAutoRecord(job, entry);
  job.cursor += 1;
  return { ok: entry.outcome === 'ok', entry };
}

/* 주입 결과 검증 — 빈 결과·다른 문서·스키마 불일치를 성공으로 세면
 * Phase 0 의 핵심 주장("정확한 문서에 MAIN 주입이 됐다")이 false positive 가 된다. */
function ubAutoBadInjection(res, sender, expectedPath) {
  if (!Array.isArray(res)) return 'injection_not_array';
  if (res.length !== 1) return 'injection_count_' + res.length;
  const r = res[0];
  if (!r || typeof r !== 'object') return 'injection_no_entry';
  // ⚠ "있으면 비교" 로 두면 필드가 없는 결과가 통과해 '정확한 문서에 주입됐다'는
  //   Phase 0 의 핵심 주장이 false positive 가 된다. 존재까지 요구한다.
  if (typeof r.documentId !== 'string' || !r.documentId) return 'injection_no_document_id';
  if (r.documentId !== sender.documentId) return 'injection_document_mismatch';
  if (!Number.isInteger(r.frameId)) return 'injection_no_frame_id';
  if (r.frameId !== sender.frameId) return 'injection_frame_mismatch';
  const f = r.result;
  if (!f || typeof f !== 'object') return 'facts_not_object';
  if (f.path !== expectedPath) return 'facts_path_mismatch';
  for (const [k, t] of Object.entries({
    charset: 'string', readyState: 'string', hasForm1: 'boolean', hasForm3: 'boolean',
    hasStandby: 'boolean', hasSetCurrent: 'boolean', idxCount: 'number',
    checkedCount: 'number', setCurrentLinks: 'number', statusColIdx: 'number',
    tListRows: 'number', hasPasswordInput: 'boolean'
  })) {
    if (typeof f[k] !== t) return 'facts_schema_' + k;
  }
  return null;
}

/* MAIN world 에서 실행 — 고정 함수·고정 반환 스키마.
 * ⚠ selector 나 HTML 을 인자로 받지 않는다. 받으면 사실상 범용 page reader 가 된다. */
function UB_AUTO_READ_FACTS() {
  const rows = [...document.querySelectorAll('table.t_list tr')];
  const hdr = rows.find(r => [...r.cells].some(c => /^\s*상태\s*$/.test(c.textContent || '')));
  const statusColIdx = hdr ? [...hdr.cells].findIndex(c => /^\s*상태\s*$/.test(c.textContent || '')) : -1;
  return {
    path: location.pathname,
    charset: document.characterSet,
    readyState: document.readyState,
    hasForm1: !!document.forms['form1'],
    hasForm3: !!document.forms['form3'],
    hasStandby: typeof window.standby === 'function',
    hasSetCurrent: typeof window.setCurrent === 'function',
    idxCount: document.querySelectorAll('input[name=idx]').length,
    checkedCount: document.querySelectorAll('input[name=idx]:checked').length,
    setCurrentLinks: document.querySelectorAll('a[href*="setCurrent"]').length,
    statusColIdx,
    tListRows: rows.length,
    // 로그인 만료·오류 페이지 식별용(Phase 0 체크리스트 10)
    hasPasswordInput: !!document.querySelector('input[type=password]')
  };
}

// 탭이 닫히면 그 탭의 job 을 정리한다(컨트롤러 상실).
try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    for (const [id, j] of ubAutoJobs) if (j.tabId === tabId) ubAutoEndJob(id, 'tab_closed');
  });
} catch (_) {}

/* =============================================================================
 *  write-ahead 저널 + 계정 전역 writer lock (rev2.1 §3.7·§5)
 *  스펙: docs/superpowers/specs/2026-07-20-orderitem-batch-design.md §3.7·§5·§3.6
 *
 *  ⚠ 이번 slice 는 API + 테스트까지다. 이 블록의 함수는 아무도 호출하지 않는다 —
 *    실제 쓰기 operation(CALL_STANDBY·CALL_SET_CURRENT·SET_REMARK_AND_SUBMIT)을 붙일 때
 *    A·C 가 사용한다. 위 Phase 0 스파이크·계정전환·캐시 동작은 이 블록과 무관하다.
 *
 *  ★핵심 불변식(§3.7) — "쓰기 dispatch 전에 저널을 먼저 남기고 그 기록을 await 한다"를
 *    관용이 아니라 API 모양으로 강제한다. ubAutoDispatchNativeWrite 는 호출 시점에
 *    storage 를 다시 읽어 해당 nonce 의 저널이 WRITE_DISPATCHING 이 아니면 writeFn 을
 *    아예 부르지 않는다 — 호출자가 persistJournal 을 안 부르거나 await 을 빼먹었어도(즉
 *    storage 에 실제로 반영되지 않았으면) dispatch 는 무조건 거부된다. 판단 기준은 항상
 *    "storage 에 관측 가능한 상태"이지 호출자의 코드 순서에 대한 신뢰가 아니다.
 *
 *  ★계정 식별 — 새 개념을 만들지 않는다. 이 파일의 계정전환 오케스트레이터(313행~)가
 *    이미 쓰는 것과 동일한 값·비교 규칙을 그대로 쓴다:
 *      · 계정 키 = userid 문자열 (ubLoginFlow.accountId · ubAccounts[].userid 와 같은 종류)
 *      · 비교는 ubNormName()(401행) — 공백 접기·소문자화 후 비교
 *    "지금 실제로 로그인된 계정이 무엇인가"를 알아내는 것(라이브 probe 등)은 호출자(A·C)
 *    몫이다. 아래 ubAutoCurrentAccountKey() 는 그 값을 얻는 가장 단순한 기존 경로
 *    (ubLoginFlow.accountId)를 감싼 편의 함수일 뿐 — 새 저장소·새 식별 개념이 아니다.
 *
 *  ★lock 은 "계정 전역" 한 종류뿐이다(§5 3층 중 1층). 탭 로컬 lock·orderSeq lock 은
 *    이번 범위 밖 — A·B·C 가 각자 얹는다.
 *
 *  저장 위치는 chrome.storage.session — 스펙 지정대로 SW 재시작엔 살아남고 브라우저
 *  종료 시 사라진다. TTL 은 기존 job 관용을 그대로 재사용한다(idle 5분/hard 10분, 694~695행).
 * ========================================================================== */

const UB_AUTO_JOURNAL_KEY = 'ubAutoWriteJournal';   // chrome.storage.session: { [nonce]: entry }
const UB_AUTO_LOCK_KEY = 'ubAutoWriterLock';        // chrome.storage.session: 단일 lock 객체 또는 없음
const UB_AUTO_JOURNAL_STATES = Object.freeze(
  ['PREPARED', 'WRITE_DISPATCHING', 'WRITE_DISPATCHED', 'VERIFIED_SUCCESS', 'NEEDS_REVIEW']);
// pending = "아직 결론이 안 난 쓰기". writer lock 신규 발급을 막는 기준이자
// §3.6 "dispatch 후 non-success 는 전부 재시도 금지"의 저장소 쪽 표현이다.
const UB_AUTO_JOURNAL_PENDING_STATES = Object.freeze(
  ['WRITE_DISPATCHING', 'WRITE_DISPATCHED', 'NEEDS_REVIEW']);

/* ---- storage read-modify-write 직렬화 ----
 *  chrome.storage.session 은 비동기라 get→set 사이에 다른 호출이 끼어들 수 있다.
 *  MV3 SW 는 인스턴스가 하나뿐이므로(동시에 두 개가 뜨지 않는다), 이 파일 안의 모든
 *  변형(mutate) 호출을 promise 체인 하나로 직렬화하면 진짜 락 없이도 "동시 요청 중
 *  하나만 성공"을 정확히 지킬 수 있다 — 두 호출이 같은 tick 에 들어와도 각자의 임계구역
 *  (get→판단→set)이 절대 겹치지 않는다.
 *  ⚠ 재진입 금지: Inner 함수는 이 큐를 다시 타지 않는다(타면 자기 자신을 기다리는 데드락).
 */
let ubAutoStorageChain = Promise.resolve();
function ubAutoSerialize(fn) {
  const run = ubAutoStorageChain.then(fn, fn);
  ubAutoStorageChain = run.then(() => {}, () => {});
  return run;
}

/* ---- 저널: storage 원시 접근 ---- */
async function ubAutoJournalStorageGet() {
  const got = await chrome.storage.session.get(UB_AUTO_JOURNAL_KEY);
  return (got && got[UB_AUTO_JOURNAL_KEY]) || {};
}
function ubAutoJournalStorageSet(map) {
  return chrome.storage.session.set({ [UB_AUTO_JOURNAL_KEY]: map });
}

// nonce 없이는 저널할 수 없고(식별 불가 → fail closed), state 는 5개 값만 허용한다.
// account·orderSeq·operation 도 필수 — 락·게이트가 이 값들로 비교하므로 비어 있으면
// "계정 불명"과 똑같이 위험하다.
function ubAutoValidateJournalEntry(entry) {
  if (!entry || typeof entry !== 'object') return 'invalid_entry';
  if (!entry.nonce || typeof entry.nonce !== 'string') return 'missing_nonce';
  if (!UB_AUTO_JOURNAL_STATES.includes(entry.state)) return 'invalid_state';
  if (!entry.account || typeof entry.account !== 'string') return 'missing_account';
  if (entry.orderSeq == null || entry.orderSeq === '') return 'missing_orderSeq';
  if (!entry.operation || typeof entry.operation !== 'string') return 'missing_operation';
  return null;
}

// persist 는 항상 "완전한 다음 상태"를 받는다(부분 patch 가 아니다) — merge 는 이전 값
// 보존용일 뿐, 호출자가 넘긴 필드가 항상 이긴다. createdAt 만 최초값을 지킨다.
async function ubAutoJournalPersistInner(entry) {
  const now = Date.now();
  const bad = ubAutoValidateJournalEntry(entry);
  if (bad) return { ok: false, error: bad };
  const map = await ubAutoJournalStorageGet();
  const prev = map[entry.nonce] || null;
  const merged = Object.assign({}, prev, entry, {
    createdAt: (prev && Number.isFinite(prev.createdAt)) ? prev.createdAt : now,
    updatedAt: now
  });
  map[entry.nonce] = merged;
  await ubAutoJournalStorageSet(map);
  return { ok: true, entry: merged };
}
function ubAutoJournalPersist(entry) {
  return ubAutoSerialize(() => ubAutoJournalPersistInner(entry));
}

async function ubAutoJournalGet(nonce) {
  const map = await ubAutoJournalStorageGet();
  return map[nonce] || null;
}
async function ubAutoJournalAll() {
  const map = await ubAutoJournalStorageGet();
  return Object.values(map);
}
// account/orderSeq 로 좁힌 "미해결" 저널 조회. 둘 다 생략하면 전역 전체를 본다
// (writer lock 신규 발급 게이트가 이 형태로 쓴다).
async function ubAutoJournalPendingEntries(filter) {
  const all = await ubAutoJournalAll();
  return all.filter(e => {
    if (!UB_AUTO_JOURNAL_PENDING_STATES.includes(e.state)) return false;
    if (filter && filter.account && ubNormName(e.account) !== ubNormName(filter.account)) return false;
    if (filter && filter.orderSeq != null && String(e.orderSeq) !== String(filter.orderSeq)) return false;
    return true;
  });
}

// 화해(reconcile) — 서버 재조회 결과를 이 함수 하나로 기록한다. verified:true 만 성공,
// 그 외(불일치·재조회 실패·타임아웃·계정변경 등)는 전부 NEEDS_REVIEW — §3.6 "dispatch 후
// non-success 는 전부 미확정"을 여기서 강제한다(성공이 아니면 실패가 아니라 미확정이다).
async function ubAutoJournalReconcileInner(nonce, outcome) {
  const now = Date.now();
  const map = await ubAutoJournalStorageGet();
  const prev = map[nonce] || null;
  if (!prev) return { ok: false, error: 'not_found' };
  const verified = !!(outcome && outcome.verified === true);
  const merged = Object.assign({}, prev, {
    state: verified ? 'VERIFIED_SUCCESS' : 'NEEDS_REVIEW',
    lastCheckResult: outcome || null,
    lastCheckedAt: now,
    updatedAt: now
  });
  map[nonce] = merged;
  await ubAutoJournalStorageSet(map);
  return { ok: true, entry: merged };
}
function ubAutoJournalReconcile(nonce, outcome) {
  return ubAutoSerialize(() => ubAutoJournalReconcileInner(nonce, outcome));
}

// SW 재시작 복구(§3.7) — 서버를 재조회하지 않는다(그건 컨트롤러 몫). WRITE_DISPATCHING/
// WRITE_DISPATCHED 로 남은 건은 전부 "쓰기를 시도했는지조차 지금은 알 수 없음"이므로
// NEEDS_REVIEW 로 내린다. 이 함수는 chrome.scripting 을 절대 호출하지 않는다 —
// "자동 재시도 절대 금지"의 실제 구현이 바로 이 부재(不在)다.
async function ubAutoJournalRecoverOnStartup() {
  const all = await ubAutoJournalAll();
  const recovered = [];
  for (const entry of all) {
    if (entry.state === 'WRITE_DISPATCHING' || entry.state === 'WRITE_DISPATCHED') {
      const r = await ubAutoJournalReconcile(entry.nonce,
        { verified: false, reason: 'sw_restart', previousState: entry.state });
      if (r.ok) { recovered.push(r.entry); ubAutoLog('저널 복구 NEEDS_REVIEW', entry.nonce, 'was', entry.state); }
    }
  }
  return recovered;
}

/* ---- 계정 전역 writer lock ---- */
// job TTL 과 같은 관용(694~695행 상수 재사용) — idle 은 lastRenewedAt, hard 는 acquiredAt 기준.
function ubAutoWriterLockExpired(lock, now) {
  if (!lock) return true;
  return (now - lock.acquiredAt > UB_AUTO_HARD_TTL_MS) || (now - lock.lastRenewedAt > UB_AUTO_IDLE_TTL_MS);
}
async function ubAutoWriterLockStorageGet() {
  const got = await chrome.storage.session.get(UB_AUTO_LOCK_KEY);
  return (got && got[UB_AUTO_LOCK_KEY]) || null;
}
function ubAutoWriterLockStorageSet(lock) {
  return chrome.storage.session.set({ [UB_AUTO_LOCK_KEY]: lock });
}
function ubAutoWriterLockStorageClear() {
  return chrome.storage.session.remove(UB_AUTO_LOCK_KEY);
}
async function ubAutoWriterLockRead() {
  const now = Date.now();
  const lock = await ubAutoWriterLockStorageGet();
  return { lock, expired: ubAutoWriterLockExpired(lock, now) };
}
// 소유자 동일성은 스펙 문구 그대로 tabId+documentId 로만 본다(jobId 는 참고용 메타데이터).
function ubAutoLockOwnerMatches(lock, owner) {
  return !!(lock && lock.owner && owner &&
    lock.owner.tabId === owner.tabId && lock.owner.documentId === owner.documentId);
}

async function ubAutoAcquireWriterLockInner(req) {
  const now = Date.now();
  const account = req && req.account;
  if (!account) return { ok: false, error: 'account_unknown' };
  if (!req || req.tabId == null || !req.documentId) return { ok: false, error: 'owner_unknown' };
  const lock = await ubAutoWriterLockStorageGet();
  const expired = ubAutoWriterLockExpired(lock, now);
  if (lock && !expired) {
    if (ubAutoLockOwnerMatches(lock, req)) {
      // 같은 소유자의 재요청 = 갱신(heartbeat). 계정까지 같아야 한다 — 같은 탭·문서인데
      // 계정이 달라졌다는 건 뭔가 잘못됐다는 신호이므로 조용히 덮어쓰지 않고 거부한다.
      if (ubNormName(lock.account) !== ubNormName(account)) {
        return { ok: false, error: 'owner_account_mismatch' };
      }
      const renewed = Object.assign({}, lock, { lastRenewedAt: now });
      await ubAutoWriterLockStorageSet(renewed);
      return { ok: true, lock: renewed, renewed: true };
    }
    return { ok: false, error: 'lock_held', owner: lock.owner };
  }
  // 락이 없거나 만료 — 새로 발급하기 전에 미해결 저널부터 본다. 강제 해제(steal) 는 금지이고,
  // pending 저널이 있으면 락이 비어 있어도(또는 막 만료됐어도) 신규 발급을 거부한다(fail closed).
  const pending = await ubAutoJournalPendingEntries();
  if (pending.length) return { ok: false, error: 'pending_journal', pending };
  const fresh = {
    owner: { jobId: req.jobId || null, tabId: req.tabId, documentId: req.documentId },
    account,
    acquiredAt: now,
    lastRenewedAt: now
  };
  await ubAutoWriterLockStorageSet(fresh);
  ubAutoLog('writer lock 발급', account, 'tab=' + req.tabId, lock ? '(만료 회수)' : '(신규)');
  return { ok: true, lock: fresh, renewed: false, reclaimed: !!lock };
}
function ubAutoAcquireWriterLock(req) {
  return ubAutoSerialize(() => ubAutoAcquireWriterLockInner(req));
}

async function ubAutoReleaseWriterLockInner(req) {
  const lock = await ubAutoWriterLockStorageGet();
  if (!lock) return { ok: true, released: false };
  if (!ubAutoLockOwnerMatches(lock, req)) return { ok: false, error: 'not_owner' };
  await ubAutoWriterLockStorageClear();
  return { ok: true, released: true };
}
function ubAutoReleaseWriterLock(req) {
  return ubAutoSerialize(() => ubAutoReleaseWriterLockInner(req));
}

// ubLoginFlow.accountId 를 그대로 반환한다 — 계정전환 오케스트레이터가 로그인 성공 시
// 채워두는 바로 그 값(516행 ubUpgradeFlow · 621행 startSwitch). 새 저장소·새 개념 없음.
// 한 번도 전환한 적 없으면 null(식별 불가) — 호출자는 이를 fail closed 로 다뤄야 한다.
async function ubAutoCurrentAccountKey() {
  const flow = await ubGetFlow();
  return (flow && flow.accountId) || null;
}

/* ---- 쓰기 전 게이트 ----
 *  §5: "계정·세션 변경: 모든 RPC 와 모든 네이티브 쓰기 직전에 즉시 거부."
 *  두 단계로 나눈다 — 모든 RPC(읽기 포함)에 필요한 공통 관문과, 쓰기에만 추가되는 저널 확인.
 */
// 공통 관문 — lock 소유자 확인 + 계정 불변 확인만 한다(저널은 안 본다). READ_PAGE_FACTS 같은
// 읽기 RPC 도 이 관문은 통과해야 하지만 저널 엔트리가 없어도 정상이다.
async function ubAutoGuardAccount(req) {
  const account = req && req.account;
  if (!account) return { ok: false, error: 'account_unknown' };
  const { lock, expired } = await ubAutoWriterLockRead();
  if (!lock || expired) return { ok: false, error: 'lock_not_held' };
  if (!ubAutoLockOwnerMatches(lock, req)) return { ok: false, error: 'lock_not_held' };
  if (ubNormName(lock.account) !== ubNormName(account)) return { ok: false, error: 'account_changed' };
  return { ok: true, lock };
}
// 네이티브 쓰기 전용 관문 — 공통 관문을 통과한 뒤 저널이 정확히 WRITE_DISPATCHING 인지까지
// 확인한다. 이게 §3.7 핵심 불변식의 실제 게이트: 저널이 그 상태가 아니면 dispatch 는 없다.
async function ubAutoGuardWrite(req) {
  const base = await ubAutoGuardAccount(req);
  if (!base.ok) return base;
  const entry = req.nonce ? await ubAutoJournalGet(req.nonce) : null;
  if (!entry || entry.state !== 'WRITE_DISPATCHING') return { ok: false, error: 'journal_not_ready' };
  if (ubNormName(entry.account) !== ubNormName(req.account)) return { ok: false, error: 'account_changed' };
  return { ok: true, lock: base.lock, entry };
}

// 저널+lock+계정 확인을 전부 통과해야만 writeFn 을 부른다. writeFn 실행 이후에는 성공이든
// 실패(throw)든 반드시 WRITE_DISPATCHED 로 남긴다 — §3.6 의 기준선("dispatch 했는가")이
// 바로 이 시점이고, 이후의 모든 non-success 는 재시도가 아니라 화해(reconcile) 대상이다.
async function ubAutoDispatchNativeWrite(req, writeFn) {
  const guard = await ubAutoGuardWrite(req);
  if (!guard.ok) {
    // 저널이 이미 WRITE_DISPATCHING 이던 건(=호출자 입장에서 "진행 중이던 쓰기")이 계정
    // 변경으로 막혔다면 "확정 실패"가 아니라 "미확정" 이다 — 다른 탭에서 이미 네이티브
    // 쓰기가 나갔을 가능성을 배제할 수 없다(§5).
    if (guard.error === 'account_changed' && req && req.nonce) {
      const entry = await ubAutoJournalGet(req.nonce);
      if (entry && entry.state === 'WRITE_DISPATCHING') {
        await ubAutoJournalReconcile(req.nonce, { verified: false, reason: 'account_changed_before_dispatch' });
      }
    }
    return guard;
  }
  let result = null, error = null;
  try { result = await writeFn(); }
  catch (e) { error = String(e && e.message || e); }
  await ubAutoJournalPersist(Object.assign({}, guard.entry, {
    state: 'WRITE_DISPATCHED',
    dispatchedAt: Number.isFinite(guard.entry.dispatchedAt) ? guard.entry.dispatchedAt : Date.now(),
    lastCheckResult: error ? { dispatchError: error } : (guard.entry.lastCheckResult || null)
  }));
  return error ? { ok: false, error, dispatched: true } : { ok: true, result, dispatched: true };
}
