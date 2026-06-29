/* =============================================================================
 *  skin.js — 유비샵 스킨모드(샘플: 다크모드). ISOLATED 콘텐츠 스크립트.
 *  팝업 메뉴에서 chrome.storage.local.ubSkin 토글 → 모든 유비샵 페이지/프레임에
 *  다크모드 적용. 기본 OFF. (레거시 인라인색 테이블이라 invert 기법 사용)
 * ========================================================================== */
(function () {
  'use strict';
  const STYLE_ID = 'ub-skin-dark-style';
  const CSS = [
    'html.ub-skin-dark{ filter: invert(0.92) hue-rotate(180deg) !important; background:#1b1b1b !important; }',
    // 이미지/미디어/배경이미지는 되돌려 정상 색으로
    'html.ub-skin-dark img, html.ub-skin-dark video, html.ub-skin-dark iframe,',
    'html.ub-skin-dark embed, html.ub-skin-dark object, html.ub-skin-dark canvas,',
    'html.ub-skin-dark [style*="background-image"]{ filter: invert(1) hue-rotate(180deg) !important; }'
  ].join('\n');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  function apply(on) {
    ensureStyle();
    if (document.documentElement) document.documentElement.classList.toggle('ub-skin-dark', !!on);
  }

  try {
    chrome.storage.local.get({ ubSkin: false }, d => apply(d && d.ubSkin));
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.ubSkin) apply(ch.ubSkin.newValue);
    });
  } catch (e) { /* storage 권한 없거나 컨텍스트 무효 */ }
})();
