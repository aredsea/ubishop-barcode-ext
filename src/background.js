/* =============================================================================
 *  background.js — MV3 서비스워커. 로컬 인쇄 프로그램으로의 fetch 전담.
 *  http 유비샵 페이지(MAIN)는 PNA 정책으로 127.0.0.1 fetch가 막힌다.
 *  확장 백그라운드는 host_permissions 권한으로 PNA/CORS 면제 → 여기서 fetch.
 * ========================================================================== */
const PRINT_URL = 'http://127.0.0.1:17600/print';
const PING_URL = 'http://127.0.0.1:17600/ping';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.source !== 'ub') return;

  if (msg.type === 'ping') {
    fetch(PING_URL, { method: 'GET' })
      .then(r => r.json())
      .then(j => sendResponse({ ok: true, body: j }))
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;  // 비동기 응답
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
    return true;  // 비동기 응답
  }
});
