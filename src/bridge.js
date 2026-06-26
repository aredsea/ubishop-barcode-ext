/* =============================================================================
 *  bridge.js — chrome.storage ↔ 페이지(MAIN world) 다리 (ISOLATED world)
 *
 *  콘텐츠 로직은 MAIN world 라 chrome.* 에 접근 못 한다. 이 브리지가:
 *   1) chrome.storage.local['UB_LAYOUT'] 을 읽어 window.__UB_SAVED_LAYOUT 에 주입
 *   2) MAIN 에서 postMessage({__ub:1,type:'save'|'reset'}) 오면 chrome.storage 에 반영
 *   3) 다른 곳(옵션페이지 등)에서 바뀌면 다시 주입(라이브 동기화)
 *  → 옵션페이지와 콘텐츠가 같은 저장값을 공유한다.
 * ========================================================================== */
(function () {
  'use strict';
  var KEY = 'UB_LAYOUT';

  function inject(layout) {
    // MAIN world 전역에 값 주입 + 준비 플래그 + 이벤트
    var s = document.createElement('script');
    s.textContent =
      'window.__UB_SAVED_LAYOUT=' + JSON.stringify(layout === undefined ? null : layout) + ';' +
      'window.__UB_LAYOUT_LOADED=true;' +
      'try{window.dispatchEvent(new Event("ub-layout"))}catch(e){}';
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  }

  // 1) 초기 로드
  try {
    chrome.storage.local.get(KEY, function (o) {
      inject(o && o[KEY] ? o[KEY] : null);
    });
  } catch (e) {
    inject(null);
  }

  // 2) MAIN → 저장/리셋 요청 수신
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.__ub !== 1) return;
    try {
      if (d.type === 'save') chrome.storage.local.set({ UB_LAYOUT: d.layout });
      else if (d.type === 'reset') chrome.storage.local.remove(KEY);
    } catch (err) {}
  });

  // 3) 외부 변경 → 재주입(라이브 동기화)
  try {
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area === 'local' && ch[KEY]) inject(ch[KEY].newValue || null);
    });
  } catch (e) {}
})();
