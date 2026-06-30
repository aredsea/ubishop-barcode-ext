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
const REMOTE_MANIFEST = 'https://raw.githubusercontent.com/aredsea/ubishop-barcode-ext/main/manifest.json';
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
});

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
    const r = await fetch(REMOTE_MANIFEST + '?_=' + Date.now(), { cache: 'no-cache' });
    if (!r.ok) return;
    const remote = await r.json();
    const local = chrome.runtime.getManifest().version;
    if (remote.version && remote.version !== local) {
      console.log('[UB][bg] new version', remote.version, 'local', local, '(restart chrome to apply)');
      try { chrome.action.setBadgeText({ text: 'NEW' }); } catch (_) {}
      try { chrome.action.setBadgeBackgroundColor({ color: '#35C5F0' }); } catch (_) {}
      try { chrome.storage.local.set({ ubUpdateAvailable: remote.version }); } catch (_) {}
    } else {
      try { chrome.action.setBadgeText({ text: '' }); } catch (_) {}
      try { chrome.storage.local.set({ ubUpdateAvailable: '' }); } catch (_) {}
    }
  } catch (e) { console.warn('[UB][bg] update check failed:', e && e.message); }
}
chrome.runtime.onStartup.addListener(checkUpdate);
chrome.runtime.onInstalled.addListener(checkUpdate);
try {
  // 60분(이전 30분) 주기. fetch 1회만 + reload 없음.
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 60 });
  chrome.alarms.onAlarm.addListener(a => { if (a.name === UPDATE_ALARM) checkUpdate(); });
} catch (e) {}
// ★ SW 깨어날 때마다 호출하던 checkUpdate(); 즉시호출 제거 — onStartup/onInstalled/알람만.
