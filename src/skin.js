/* =============================================================================
 *  skin.js — 유비샵 스킨모드. ISOLATED 콘텐츠 스크립트. all_frames:true.
 *  팝업 메뉴(확장 아이콘)에서 마스터(ubSkin) + 세부옵션을 토글한다. 기본 OFF.
 *    - ubDark      : 다크모드 (전 페이지 invert)
 *    - ubThumbEdit : 기초상품관리 이미지보기에서 썸네일 클릭 → 상품수정 새 창
 *  적용 조건 = ubSkin && 개별옵션. 마스터 OFF면 전부 비활성.
 *
 *  [frameset 함정] 유비샵은 frameset 구조. all_frames:true 면 outer+inner 모두
 *   주입되어 양쪽에 invert 가 걸리면 시각적으로 원본 색 복귀(이중 invert).
 *   → 자기 document 에 <frameset> 이 있으면 invert 를 자식 frame에 위임하고
 *     자기는 배경만 어둡게 칠한다(시각 콘텐츠 없음).
 * ========================================================================== */
(function () {
  'use strict';

  const state = { ubSkin: false, ubDark: false, ubThumbEdit: true };
  const dark = () => state.ubSkin && state.ubDark;
  const thumb = () => state.ubSkin && state.ubThumbEdit;

  // 진단: 사용자가 F12 콘솔로 frame 구조와 적용 상태 확인할 수 있게 한 줄.
  try { console.log('[UB][skin] loaded', { isTop: window === window.top, path: location.pathname }); } catch (_) {}

  /* ---- 다크모드 ------------------------------------------------------------ */
  const STYLE_ID = 'ub-skin-dark-style';
  // ub-skin-dark : 실제 invert (콘텐츠 frame). ub-skin-dark-bg : 배경만(frameset outer).
  const DARK_CSS = [
    'html.ub-skin-dark{ filter: invert(0.92) hue-rotate(180deg) !important; background:#1b1b1b !important; }',
    'html.ub-skin-dark img, html.ub-skin-dark video, html.ub-skin-dark iframe,',
    'html.ub-skin-dark embed, html.ub-skin-dark object, html.ub-skin-dark canvas,',
    'html.ub-skin-dark frame, html.ub-skin-dark frameset,',
    'html.ub-skin-dark [style*="background-image"]{ filter: invert(1) hue-rotate(180deg) !important; }',
    'html.ub-skin-dark-bg, html.ub-skin-dark-bg body, html.ub-skin-dark-bg frameset{ background:#1b1b1b !important; }'
  ].join('\n');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = DARK_CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  // 이 frame 이 frameset 컨테이너인가? (자식 frame 들이 실제 콘텐츠를 가짐)
  function isFramesetHost() {
    return !!document.querySelector('frameset');
  }
  function applyDark() {
    ensureStyle();
    const el = document.documentElement;
    if (!el) return;
    const on = dark();
    if (on && isFramesetHost()) {
      // frameset 컨테이너: invert 는 자식 frame 에 위임. 자기는 배경만.
      el.classList.remove('ub-skin-dark');
      el.classList.add('ub-skin-dark-bg');
    } else {
      el.classList.toggle('ub-skin-dark', on);
      el.classList.remove('ub-skin-dark-bg');
    }
  }

  /* ---- 썸네일 클릭 → 상품수정 새 창 (기초상품관리 이미지보기) ------------- */
  const MASTER_RE = /\/master\/item\/masterItemList/i;
  function isThumb(im) {
    const s = im.src || '';
    return /\/s_\d+\.(jpe?g|png|gif)/i.test(s) || /no_image\.gif/i.test(s);
  }
  function editUrl(seq) {
    return '/master/item/masterItemModifyForm.do?tcode=master_item&seq=' + encodeURIComponent(seq);
  }
  function thumbStyle(img) {
    const on = thumb();
    img.style.cursor = on ? 'pointer' : '';
    img.title = on ? '상품 수정 (새 창)' : '';
    img.style.outline = on ? '2px solid rgba(53,197,240,.0)' : '';   // hover 시 강조는 CSS로
  }
  function attach(img, seq) {
    if (img.dataset.ubEdit) { thumbStyle(img); return; }
    img.dataset.ubEdit = seq;
    // capture + stopImmediatePropagation: 같은 element 의 다른 listener(인라인 onclick,
    // 별도 등록된 핸들러)도 차단해야 본래 "같은 창 이동" 동작이 안 일어난다.
    // mousedown 도 함께 막아 jsp 사이트의 mousedown 기반 navigation 차단.
    const handler = function (e) {
      if (!thumb()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'click') window.open(editUrl(seq), '_blank');
    };
    img.addEventListener('mousedown', handler, true);
    img.addEventListener('click', handler, true);
    // hover 강조
    img.addEventListener('mouseenter', function () { if (thumb()) img.style.outline = '2px solid #35C5F0'; });
    img.addEventListener('mouseleave', function () { img.style.outline = ''; });
    // 부모 a 태그가 있으면 그 navigation 도 무력화(href 백업 후 빈 처리).
    const a = img.closest('a');
    if (a && !a.dataset.ubEdit) {
      a.dataset.ubEdit = seq;
      a.addEventListener('click', function (e) {
        if (!thumb()) return;
        e.preventDefault(); e.stopImmediatePropagation();
        window.open(editUrl(seq), '_blank');
      }, true);
    }
    thumbStyle(img);
  }
  // 썸네일(IMG) 바로 뒤에 그 상품의 idx 체크박스(=seq)가 온다(실측). 순서로 페어링.
  function bindThumbEdit() {
    if (!MASTER_RE.test(location.pathname)) return;
    const nodes = [...document.querySelectorAll('img, input[name=idx]')];
    let last = null;
    for (const el of nodes) {
      if (el.tagName === 'IMG') { if (isThumb(el)) last = el; }
      else if (el.name === 'idx' && el.value && el.value !== 'on') {
        if (last) attach(last, el.value);
        last = null;
      }
    }
  }

  /* ---- 적용/구독 ---------------------------------------------------------- */
  function applyAll() {
    applyDark();
    document.querySelectorAll('img[data-ub-edit]').forEach(thumbStyle);
  }
  function init() {
    bindThumbEdit();
    applyAll();
  }

  try {
    chrome.storage.local.get({ ubSkin: false, ubDark: false, ubThumbEdit: true }, d => {
      Object.assign(state, d || {});
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
      else init();
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      let changed = false;
      ['ubSkin', 'ubDark', 'ubThumbEdit'].forEach(k => { if (ch[k]) { state[k] = ch[k].newValue; changed = true; } });
      if (changed) applyAll();
    });
  } catch (e) { /* storage 권한/컨텍스트 문제 시 무시 */ }
})();
