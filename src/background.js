/* =============================================================================
 *  background.js — MV3 서비스워커.
 *  ① 로컬 인쇄 프로그램으로의 fetch 전담(127.0.0.1, PNA 우회).
 *  ② 확장 자동 갱신 체크(압축해제 로드 환경에서도 동작) — raw GitHub manifest
 *     30분마다 fetch, 버전 다르면 chrome.runtime.reload()로 확장 재시작.
 *     SyncStableExtension가 폴더는 이미 최신으로 sync해두므로 reload만 하면 됨.
 * ========================================================================== */
const PRINT_URL = 'http://127.0.0.1:17600/print';
const PING_URL = 'http://127.0.0.1:17600/ping';
const REMOTE_MANIFEST = 'https://raw.githubusercontent.com/aredsea/ubishop-barcode-ext/main/manifest.json';
const UPDATE_ALARM = 'ubUpdateCheck';

/* ---- 인쇄 프록시 ---------------------------------------------------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.source !== 'ub') return;

  if (msg.type === 'ping') {
    fetch(PING_URL, { method: 'GET' })
      .then(r => r.json())
      .then(j => sendResponse({ ok: true, body: j }))
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  if (msg.type === 'print') {
    fetch(PRINT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: msg.items || [] })
    })
      .then(r => r.json().catch(() => ({ ok: false, error: '응답 파싱 실패' })))
      .then(j => sendResponse({ ok: !!j.ok, result: j, error: j.error }))
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
});

/* ---- 자동 갱신 체크 ------------------------------------------------------- */
async function checkUpdate() {
  try {
    const r = await fetch(REMOTE_MANIFEST + '?_=' + Date.now(), { cache: 'no-cache' });
    if (!r.ok) return;
    const remote = await r.json();
    const local = chrome.runtime.getManifest().version;
    if (remote.version && remote.version !== local) {
      console.log('[UB][bg] new version', remote.version, 'current', local, '→ reload');
      // chrome.runtime.reload() → 확장 재시작 → 폴더의 최신 manifest 적용
      chrome.runtime.reload();
    }
  } catch (e) {
    console.warn('[UB][bg] update check failed:', e && e.message);
  }
}

// 시작 시 1회 + 30분 알람
chrome.runtime.onStartup.addListener(checkUpdate);
chrome.runtime.onInstalled.addListener(checkUpdate);
try {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 30 });
  chrome.alarms.onAlarm.addListener(a => { if (a.name === UPDATE_ALARM) checkUpdate(); });
} catch (e) { /* alarms 권한 없으면 시작 시 1회만 */ }
// SW 처음 깨어날 때도 한 번
checkUpdate();
