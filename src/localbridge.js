/* =============================================================================
 *  localbridge.js — ISOLATED 콘텐츠 스크립트. 페이지(MAIN) ↔ 백그라운드 중계.
 *  MAIN 의 content.js / cache-intercept.js 가 window.postMessage 로 보낸
 *  요청을 받아 chrome.runtime 으로 백그라운드에 넘기고, 결과를 다시
 *  postMessage 로 돌려준다.
 *
 *  v3.1.1: cacheGetSearch / cachePutSearch / cacheFetchSearch / telemetry
 *          타입 forwarding 추가 (Phase 2 transparent caching 지원).
 * ========================================================================== */
(function () {
  'use strict';

  const FORWARD_TYPES = new Set([
    'print', 'ping',
    'cacheGetSearch', 'cachePutSearch', 'cacheFetchSearch', 'telemetry'
  ]);

  window.addEventListener('message', function (e) {
    const d = e.data;
    if (!d || d.source !== 'ub-page' || e.source !== window) return;
    if (!FORWARD_TYPES.has(d.type)) return;

    let replied = false;
    const reply = (resp) => {
      if (replied) return; replied = true;
      // 전체 resp 필드(html/hit/entry/aborted 등)를 spread 해서 caller가 모두 접근 가능
      const out = Object.assign({}, resp || {}, { source: 'ub-bridge', id: d.id });
      out.ok = resp ? (resp.ok !== false) : false;
      window.postMessage(out, '*');
    };
    try {
      // 필요한 필드만 추려서 SW로 전달
      const msg = { source: 'ub', type: d.type };
      if (d.items != null)    msg.items    = d.items;
      if (d.pathKey != null)  msg.pathKey  = d.pathKey;
      if (d.key != null)      msg.key      = d.key;
      if (d.url != null)      msg.url      = d.url;
      if (d.html != null)     msg.html     = d.html;
      if (d.payload != null)  msg.payload  = d.payload;

      chrome.runtime.sendMessage(msg, function (resp) {
        if (chrome.runtime.lastError) {
          reply({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        reply(resp || { ok: false, error: '빈 응답' });
      });
    } catch (err) {
      reply({ ok: false, error: String(err && err.message || err) });
    }
  });
})();
