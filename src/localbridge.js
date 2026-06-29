/* =============================================================================
 *  localbridge.js — ISOLATED 콘텐츠 스크립트. 페이지(MAIN) ↔ 백그라운드 중계.
 *  MAIN 의 content.js 가 window.postMessage 로 보낸 인쇄 요청을 받아
 *  chrome.runtime 으로 백그라운드에 넘기고, 결과를 다시 postMessage 로 돌려준다.
 * ========================================================================== */
(function () {
  'use strict';

  window.addEventListener('message', function (e) {
    const d = e.data;
    if (!d || d.source !== 'ub-page' || e.source !== window) return;

    if (d.type === 'print' || d.type === 'ping') {
      let replied = false;
      const reply = (resp) => {
        if (replied) return; replied = true;
        window.postMessage({ source: 'ub-bridge', id: d.id, ok: resp && resp.ok,
                             error: resp && resp.error, result: resp && resp.result, body: resp && resp.body }, '*');
      };
      try {
        chrome.runtime.sendMessage({ source: 'ub', type: d.type, items: d.items }, function (resp) {
          if (chrome.runtime.lastError) { reply({ ok: false, error: chrome.runtime.lastError.message }); return; }
          reply(resp || { ok: false, error: '빈 응답' });
        });
      } catch (err) {
        reply({ ok: false, error: String(err && err.message || err) });
      }
    }
  });
})();
