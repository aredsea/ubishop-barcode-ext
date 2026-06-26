/* =============================================================================
 *  overlay.js — 인쇄 로딩 오버레이 (CSS 애니메이션)
 *  바코드인쇄 클릭 시 전체화면 반투명 + 스피너. window.UBOverlay.show/hide.
 * ========================================================================== */
(function () {
  'use strict';
  var ID = 'ub-print-overlay';

  function ensureStyle() {
    if (document.getElementById('ub-ov-style')) return;
    var css =
      '#' + ID + '{position:fixed;inset:0;z-index:2147483640;display:flex;' +
      'align-items:center;justify-content:center;background:rgba(17,24,39,.55);}' +
      '#' + ID + ' .ub-ov-box{display:flex;flex-direction:column;align-items:center;gap:16px;' +
      'color:#fff;font:600 15px "Malgun Gothic",sans-serif;}' +
      // 사용자 지정 CSS 로더
      '#' + ID + ' .loader{width:50px;padding:8px;aspect-ratio:1;border-radius:50%;' +
      'background:#25b09b;' +
      '--_m:conic-gradient(#0000 10%,#000),linear-gradient(#000 0 0) content-box;' +
      '-webkit-mask:var(--_m);mask:var(--_m);' +
      '-webkit-mask-composite:source-out;mask-composite:subtract;' +
      'animation:ub-l3 1s infinite linear;}' +
      '@keyframes ub-l3{to{transform:rotate(1turn)}}';
    var s = document.createElement('style');
    s.id = 'ub-ov-style';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  function show(msg) {
    ensureStyle();
    hide();
    var o = document.createElement('div');
    o.id = ID;
    o.innerHTML = '<div class="ub-ov-box"><div class="loader"></div><div>' +
      (msg || '인쇄 준비 중…') + '</div></div>';
    (document.body || document.documentElement).appendChild(o);
  }
  function hide() {
    var o = document.getElementById(ID);
    if (o) o.remove();
  }

  window.UBOverlay = { show: show, hide: hide };
})();
