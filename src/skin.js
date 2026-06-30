/* =============================================================================
 *  skin.js — 유비샵 스킨모드. ISOLATED, all_frames, document_start.
 *
 *  세부옵션 (모두 ubSkin 게이팅, ubSkin은 마스터):
 *    ubDark        : 다크 테마(실제 색상 매핑)
 *    ubThumbEdit   : 기초상품관리 이미지보기 썸네일 클릭 → 상품수정 새 창
 *    ubSidebar     : 좌측/플로팅 D102 도구 사이드바
 *    ubPageSize    : 리스트 페이지 기본 100 + 옵션 100/300/500
 *    ubAutoSync    : 전표 자동 분할조회+캐시(아직 미구현, 토글만)
 *
 *  영구 상태:
 *    ubSbMode  : 'docked' | 'floating'   (default docked)
 *    ubSbX, ubSbY : floating 위치(px)
 *    ubSbCollapsed: true 면 접힘
 *    ubBarcodes : 사용자 복사 바코드 [{c,t}] (최대 12, FIFO)
 *
 *  v2.7.0 — 날짜=select 변경(검색X) / 사이드바 floating·드래그·핸들 / 바코드 클립보드.
 *  v2.6.0 — invert 폐기, 실제 다크 / 사이드바 / 페이지사이즈 / 썸네일 보강.
 * ========================================================================== */
(function () {
  'use strict';

  const D = {
    ubSkin: false, ubDark: false, ubThumbEdit: true,
    ubSidebar: true, ubPageSize: true, ubAutoSync: true,
    ubSbMode: 'docked', ubSbX: 24, ubSbY: 24, ubSbCollapsed: false,
    ubBarcodes: []
  };
  const state = Object.assign({}, D);
  const on = (k) => state.ubSkin && state[k];
  const MAX_BARCODES = 21;
  // 정확한 바코드 패턴: 년도(21~26) + 영숫자 4자리(영문 ≥1).
  // 예: 2606WH(26+06WH), 24010D(24+010D), 230M56(23+0M56).
  // "14K" 같은 짧은 단어/금속표기는 제외(년도 prefix 강제).
  const BARCODE_RE = /\b2[1-6][A-Z0-9]{4}\b/g;
  // 클립보드 버튼 → navigator.clipboard 실패 시 fallback execCommand가
  // 자체 copy 이벤트를 트리거 → addBarcodes 재진입으로 순서 어그러짐 방지.
  let _suppressNextCopy = false;

  // 팝업 창(window.open으로 띄운 별도 윈도우) 판정.
  // ⚠ window.opener 는 noopener로 열렸거나 chrome이 보안상 끊으면 null.
  //   새로고침/페이징 reload 후에도 popup window 자체는 유지되지만 opener는
  //   사라질 수 있다 → opener 의존하면 reload 후 사이드바가 다시 뜸(사용자 보고).
  //
  // 전략: ①window.menubar/toolbar.visible 우선(popup window의 표준 시그니처)
  //       ②opener+작은 크기 fallback
  //       ③첫 popup 판정이 나면 sessionStorage에 마커 → 같은 탭/윈도우의
  //         모든 후속 reload·navigation에서 즉시 popup 인식(가장 robust).
  const POPUP_MARK = 'ub_is_popup_window';
  function isPopupWindow() {
    try { if (sessionStorage.getItem(POPUP_MARK) === '1') return true; } catch (_) {}
    let popup = false;
    try {
      if (typeof window.menubar !== 'undefined' && window.menubar.visible === false) popup = true;
      else if (typeof window.toolbar !== 'undefined' && window.toolbar.visible === false) popup = true;
      else if (typeof window.locationbar !== 'undefined' && window.locationbar.visible === false) popup = true;
      else if (window.opener && window.opener !== window && window.outerWidth && window.outerWidth < 1300) popup = true;
    } catch (_) {}
    if (popup) { try { sessionStorage.setItem(POPUP_MARK, '1'); } catch (_) {} }
    return popup;
  }
  const _IS_POPUP = (() => { try { return isPopupWindow(); } catch (_) { return false; } })();

  try { console.log('[UB][skin] v3.0.4 loaded', { isTop: window === window.top, path: location.pathname, popup: _IS_POPUP }); } catch (_) {}

  // 썸네일 → 상품수정 팝업 창(새 탭 아님). 작은 별도 윈도우.
  const POPUP_FEATURES = 'width=1100,height=820,scrollbars=yes,resizable=yes,toolbar=no,location=yes,menubar=no,noopener';

  // 전표 자동 분할조회 캐시 대상 페이지.
  const CACHE_PAGES = {
    '/jun/delivitem/delivItemList.do':  '매장출고전표',
    '/jun/clientpay/clientPayJunList.do': '매장매출전표'
  };
  function currentCachePage() {
    const p = location.pathname;
    return CACHE_PAGES[p] ? { path: p, label: CACHE_PAGES[p] } : null;
  }
  // 진행 상태(메모리 only — 페이지 reload 시 사라짐).
  const cacheJob = { running: false, current: 0, total: 0, date: '', startMs: 0, lastResult: null };

  // page_load telemetry (sidebar 처음 그릴 때 1회).
  function reportPageLoad() {
    if (!on('ubSidebar')) return;
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      if (!nav) return;
      const totalLoad = Math.round(nav.loadEventEnd - nav.startTime);
      const ttfb = Math.round(nav.responseStart - nav.requestStart);
      const domNodes = document.getElementsByTagName('*').length;
      chrome.runtime.sendMessage({
        source: 'ub', type: 'telemetry',
        payload: { type: 'page_load', path: location.pathname, ttfb, totalLoad, domNodes }
      }, () => void chrome.runtime.lastError);
    } catch (_) {}
  }

  /* ==========================================================================
   *  1) 다크 테마 — invert 폐기, 실제 색상 매핑.
   * ========================================================================== */
  const DARK_STYLE_ID = 'ub-dark-style';
  const DARK_CSS = `
    html.ub-dark, html.ub-dark body { background-color: #0d1117 !important; color: #c9d1d9 !important; }
    html.ub-dark body, html.ub-dark td, html.ub-dark th, html.ub-dark div, html.ub-dark span,
    html.ub-dark p, html.ub-dark li, html.ub-dark dt, html.ub-dark dd, html.ub-dark label,
    html.ub-dark fieldset, html.ub-dark legend, html.ub-dark form, html.ub-dark center {
      background-color: transparent !important; color: #c9d1d9 !important;
      border-color: #30363d !important;
    }
    html.ub-dark table { background-color: #161b22 !important; border-color: #30363d !important; }
    html.ub-dark th { background-color: #21262d !important; color: #e6edf3 !important; border-color: #30363d !important; }
    html.ub-dark tr { background-color: transparent !important; }
    html.ub-dark tr:hover > td { background-color: #1f242c !important; }
    html.ub-dark td { border-color: #30363d !important; }
    html.ub-dark input, html.ub-dark select, html.ub-dark textarea {
      background-color: #0d1117 !important; color: #e6edf3 !important;
      border: 1px solid #30363d !important; outline-color: #35C5F0 !important;
    }
    html.ub-dark input[type=button], html.ub-dark input[type=submit], html.ub-dark button {
      background: linear-gradient(180deg, #21262d, #161b22) !important;
      color: #e6edf3 !important; border: 1px solid #30363d !important;
      box-shadow: 0 1px 0 rgba(255,255,255,.04) inset !important; cursor: pointer !important;
    }
    html.ub-dark input[type=button]:hover, html.ub-dark input[type=submit]:hover, html.ub-dark button:hover {
      background: #30363d !important; border-color: #35C5F0 !important;
    }
    html.ub-dark a, html.ub-dark a:visited { color: #58c5f0 !important; }
    html.ub-dark a:hover { color: #35C5F0 !important; }
    html.ub-dark img { opacity: 0.92; }
    html.ub-dark hr { border-color: #30363d !important; background-color: #30363d !important; }
    html.ub-dark [bgcolor], html.ub-dark [style*="background-color"], html.ub-dark [style*="background:"] {
      background-color: #161b22 !important;
    }
    html.ub-dark [bgcolor="#EFEFEF"], html.ub-dark [bgcolor="#efefef"] { background-color: #1f242c !important; }
    html.ub-dark [bgcolor="#FFFFFF"], html.ub-dark [bgcolor="#ffffff"], html.ub-dark [bgcolor="white"] {
      background-color: #161b22 !important;
    }
    html.ub-dark div.tooltip2, html.ub-dark .tooltip2 {
      background-color: #21262d !important; color: #e6edf3 !important;
      border: 1px solid #30363d !important; box-shadow: 0 8px 24px rgba(0,0,0,.4) !important;
    }
    html.ub-dark option { background-color: #161b22 !important; color: #e6edf3 !important; }
    html.ub-dark ::placeholder { color: #6e7681 !important; opacity: 1 !important; }
    html.ub-dark b, html.ub-dark strong { color: #e6edf3 !important; }
    html.ub-dark ::selection { background: rgba(53,197,240,.35) !important; color: #fff !important; }
    html.ub-dark .ub-sidebar, html.ub-dark .ub-sidebar *, html.ub-dark .ub-sb-handle, html.ub-dark .ub-sb-handle * {
      background-color: initial; color: initial; border-color: initial;
    }
  `;
  function ensureDarkStyle() {
    if (document.getElementById(DARK_STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = DARK_STYLE_ID; s.textContent = DARK_CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  function applyDark() {
    ensureDarkStyle();
    const el = document.documentElement;
    if (!el) return;
    el.classList.toggle('ub-dark', on('ubDark'));
  }

  /* ==========================================================================
   *  2) 썸네일 → 상품수정 새 창
   * ========================================================================== */
  const MASTER_RE = /\/master\/item\/masterItemList/i;
  function isThumb(im) {
    const s = im.src || im.getAttribute('src') || '';
    return /\/s_\d+\.(jpe?g|png|gif)/i.test(s) || /no_image\.gif/i.test(s);
  }
  function editUrl(seq) {
    return '/master/item/masterItemModifyForm.do?tcode=master_item&seq=' + encodeURIComponent(seq);
  }
  // 썸네일 → 상품수정 팝업 창.
  // a.href는 javascript:void(0)로 무력화(native navigation 없음) → click handler가
  // window.open(features)로 별도 팝업 윈도우 생성. 새 탭 아닌 분리된 작은 창.
  function neutralizeThumbAnchor(a) {
    if (!on('ubThumbEdit')) return;
    a.href = 'javascript:void(0)';
    a.removeAttribute('target');
    a.removeAttribute('onclick');
  }
  function attachThumb(img, seq) {
    if (img.dataset.ubEdit) return;
    img.dataset.ubEdit = seq;
    img.style.cursor = 'pointer';
    img.title = '상품 수정 (팝업 창)';

    const openPopup = (e) => {
      if (!on('ubThumbEdit')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      // 같은 seq면 같은 윈도우 이름 → 한 번 열린 팝업 재사용(전환).
      window.open(editUrl(seq), 'ubEdit_' + seq, POPUP_FEATURES);
    };

    const a = img.closest('a');
    if (a) {
      a.dataset.ubEdit = seq;
      if (!a.dataset.ubOrigHref) a.dataset.ubOrigHref = a.getAttribute('href') || '';
      neutralizeThumbAnchor(a);
      // 페이지가 href를 다시 javascript:imageView로 reset할 때 즉시 복원
      const mo = new MutationObserver(() => neutralizeThumbAnchor(a));
      try { mo.observe(a, { attributes: true, attributeFilter: ['href', 'target', 'onclick'] }); } catch (_) {}
      a.addEventListener('click', openPopup, true);
    } else {
      img.addEventListener('click', openPopup, true);
    }
    img.addEventListener('mouseenter', () => { if (on('ubThumbEdit')) img.style.outline = '2px solid #35C5F0'; });
    img.addEventListener('mouseleave', () => { img.style.outline = ''; });
  }
  function bindThumbEdit(root) {
    if (!MASTER_RE.test(location.pathname)) return;
    const scope = root || document;
    const nodes = [...scope.querySelectorAll('img, input[name=idx]')];
    let last = null;
    for (const el of nodes) {
      if (el.tagName === 'IMG') { if (isThumb(el)) last = el; }
      else if (el.name === 'idx' && el.value && el.value !== 'on') {
        if (last) attachThumb(last, el.value);
        last = null;
      }
    }
  }

  /* ==========================================================================
   *  3) 페이지사이즈
   * ========================================================================== */
  function hasPageSizeParam() { return /[?&]pageSize=/.test(location.search); }
  // 같은 페이지(form submit으로 온 검색 결과)인지 판정 — referrer 비교.
  function cameFromSameForm() {
    try {
      if (!document.referrer) return false;
      const ref = new URL(document.referrer);
      return ref.host === location.host && ref.pathname === location.pathname;
    } catch (_) { return false; }
  }
  function ensureDefaultPageSize() {
    if (_IS_POPUP) return;
    if (!on('ubPageSize')) return;
    if (!/(List|ListForm)\.do$/i.test(location.pathname)) return;
    if (hasPageSizeParam()) return;
    // ⚠ 같은 페이지에서 form submit으로 도착한 검색 결과면 redirect 금지.
    //   사용자가 검색 누른 직후 우리가 한 번 더 redirect하면 결과가 두 번
    //   바뀌어 보임(사용자 보고: "20→100 자동 재검색"). 대신 select 값만
    //   100으로 세팅(아래 injectPageSizeOptions) — 다음 검색은 100개로.
    if (cameFromSameForm()) return;
    // 메뉴/외부에서 깨끗하게 진입 → 100으로 1회 redirect
    const u = new URL(location.href);
    u.searchParams.set('pageSize', '100');
    location.replace(u.toString());
  }
  function injectPageSizeOptions() {
    if (!on('ubPageSize')) return;
    const sels = document.querySelectorAll('select[name=pageSize]');
    const want = ['20', '30', '50', '100', '300', '500'];
    sels.forEach(sel => {
      const existing = new Set([...sel.options].map(o => o.value));
      want.forEach(v => {
        if (!existing.has(v)) {
          const op = document.createElement('option');
          op.value = v; op.text = v;
          sel.appendChild(op);
        }
      });
      // URL에 pageSize 있으면 그 값으로(사용자가 select 변경 후 검색 결과),
      // 없으면 100으로 selected → 사용자가 다음 검색 누르면 form submit이
      // pageSize=100으로 보내짐 (우리가 추가 redirect 안 해도 됨).
      const cur = new URL(location.href).searchParams.get('pageSize');
      if (cur && [...sel.options].some(o => o.value === cur)) {
        sel.value = cur;
      } else {
        sel.value = '100';
      }
    });
  }

  /* ==========================================================================
   *  4) 날짜 빠른선택 — select 값만 변경(검색은 사용자가 직접).
   * ========================================================================== */
  function ymd(d) { return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function dateRange(kind) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(today), end = new Date(today);
    switch (kind) {
      case 'today':     break;
      case 'yesterday': start.setDate(today.getDate() - 1); end.setDate(today.getDate() - 1); break;
      case 'd3':        start.setDate(today.getDate() - 2); break;
      case 'd7':        start.setDate(today.getDate() - 6); break;
      case 'm1':        start.setMonth(today.getMonth() - 1); break;
      case 'q1':        start.setMonth(today.getMonth() - 3); break;
      case 'y1':        start.setFullYear(today.getFullYear() - 1); break;
    }
    return { s: ymd(start), e: ymd(end) };
  }
  // 페이지 폼의 syear/smonth/sday/eyear/emonth/eday 값만 변경. 검색은 X.
  function setDateSelects(kind) {
    const r = dateRange(kind);
    const map = {
      syear: String(r.s.y), smonth: pad2(r.s.m), sday: pad2(r.s.d),
      eyear: String(r.e.y), emonth: pad2(r.e.m), eday: pad2(r.e.d)
    };
    let changed = 0;
    for (const [name, val] of Object.entries(map)) {
      const els = document.querySelectorAll(`select[name="${name}"], input[name="${name}"]`);
      els.forEach(el => {
        if (el.tagName === 'SELECT') {
          // 옵션에 없으면 추가(예: pad2 미일치 등 edge case)
          if (![...el.options].some(o => o.value === val)) {
            const op = document.createElement('option');
            op.value = val; op.text = val;
            el.appendChild(op);
          }
          el.value = val;
        } else {
          el.value = val;
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        changed++;
      });
    }
    return changed;
  }

  /* ==========================================================================
   *  5) 바코드 클립보드 — 사용자 복사 시 자동 감지 + 사이드바 버튼 12개.
   * ========================================================================== */
  function extractBarcodes(text) {
    if (!text) return [];
    const raw = text.match(BARCODE_RE) || [];
    // 추가 검증: 년도 뒤 4자리에 영문 ≥1개. "240630" 같은 순수 숫자 제외.
    const codes = raw
      .map(s => s.toUpperCase())
      .filter(s => /[A-Z]/.test(s.slice(2)));
    return [...new Set(codes)];
  }
  function addBarcodes(list) {
    if (!list.length) return false;
    let cur = Array.isArray(state.ubBarcodes) ? [...state.ubBarcodes] : [];
    let added = false;
    const now = Date.now();
    for (const code of list) {
      // 중복: 같은 코드 있으면 최신으로 갱신(올림)
      const idx = cur.findIndex(b => b.c === code);
      if (idx >= 0) cur.splice(idx, 1);
      cur.unshift({ c: code, t: now });
      added = true;
    }
    cur = cur.slice(0, MAX_BARCODES);
    state.ubBarcodes = cur;
    try { chrome.storage.local.set({ ubBarcodes: cur }); } catch (_) {}
    return added;
  }
  function copyToClipboard(text) {
    // 우리 버튼이 트리거하는 복사는 copy 이벤트에서 무시 → 리스트 순서 보존.
    _suppressNextCopy = true;
    setTimeout(() => { _suppressNextCopy = false; }, 250);
    try {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } catch (_) { fallbackCopy(text); }
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    ta.remove();
  }
  function removeBarcode(code) {
    const cur = (Array.isArray(state.ubBarcodes) ? state.ubBarcodes : []).filter(b => b.c !== code);
    state.ubBarcodes = cur;
    try { chrome.storage.local.set({ ubBarcodes: cur }); } catch (_) {}
  }
  function bindCopyListener() {
    document.addEventListener('copy', () => {
      if (_suppressNextCopy) return;   // 우리 버튼 클릭은 무시(순서 보존)
      if (!on('ubSidebar')) return;
      const sel = window.getSelection ? window.getSelection().toString() : '';
      const codes = extractBarcodes(sel);
      if (codes.length && addBarcodes(codes)) renderSidebar();
    }, true);
  }

  /* ==========================================================================
   *  6) 좌측/플로팅 사이드바 + 드래그 + 접힌 핸들
   * ========================================================================== */
  const SIDEBAR_ID = 'ub-sidebar';
  const HANDLE_ID = 'ub-sb-handle';
  const SIDEBAR_STYLE_ID = 'ub-sidebar-style';
  // 디자인 토큰(CLAUDE.md 지침: 시안 #35C5F0 / Pretendard / 8·12px 그리드 / 이모지 없음 → SVG).
  // — 모든 패딩/갭/border-radius는 4의 배수, 폰트는 12/13/14px 단위.
  const SIDEBAR_CSS = `
    .ub-sidebar {
      --ub-bg: #ffffff;
      --ub-bg2: #f7f9fc;
      --ub-fg: #1b1b1b;
      --ub-sub: #6b7280;
      --ub-line: #e5e7eb;
      --ub-soft: #f9fafb;
      --ub-on:  #35C5F0;
      --ub-on-hover: #2bb5e0;
      --ub-on-soft: #e0f4fc;

      width: 248px;
      background: linear-gradient(180deg, var(--ub-bg) 0%, var(--ub-bg2) 100%);
      border: 1px solid var(--ub-line); box-shadow: 0 8px 24px rgba(15,20,25,.08);
      border-radius: 12px; z-index: 2147483646;
      font-family: 'Pretendard','Malgun Gothic',sans-serif; color: var(--ub-fg);
      padding: 16px 12px; box-sizing: border-box; overflow-y: auto;
      transition: opacity .15s ease;
      -webkit-font-smoothing: antialiased;
    }
    .ub-sidebar.ub-mode-docked {
      position: fixed; top: 0; left: 0; height: 100vh; width: 248px;
      border-radius: 0; border-left: none; border-top: none; border-bottom: none;
      box-shadow: 2px 0 12px rgba(15,20,25,.06);
    }
    .ub-sidebar.ub-mode-floating {
      position: fixed; max-height: calc(100vh - 48px);
    }
    .ub-sidebar.ub-collapsed { display: none; }
    html.ub-dark .ub-sidebar {
      --ub-bg: #161b22;
      --ub-bg2: #0d1117;
      --ub-fg: #c9d1d9;
      --ub-sub: #8b949e;
      --ub-line: #30363d;
      --ub-soft: #161b22;
      --ub-on-soft: #1c2733;
      box-shadow: 0 8px 24px rgba(0,0,0,.5) !important;
    }
    html.ub-sidebar-docked body { margin-left: 256px !important; }
    @media (max-width: 900px) { html.ub-sidebar-docked body { margin-left: 0 !important; } }

    /* 헤더 */
    .ub-sidebar .ub-sb-hd {
      display: flex; align-items: center; gap: 8px;
      padding: 0 4px 12px; border-bottom: 1px solid var(--ub-line); margin-bottom: 16px;
      cursor: default;
    }
    .ub-sidebar.ub-mode-floating .ub-sb-hd { cursor: move; }
    .ub-sidebar .ub-sb-brand {
      width: 24px; height: 24px; border-radius: 8px; flex: none;
      background: linear-gradient(135deg, var(--ub-on) 0%, #1aa0d4 100%);
      color: #fff; font-size: 12px; font-weight: 800; line-height: 24px;
      text-align: center; letter-spacing: -.02em;
    }
    .ub-sidebar .ub-sb-title { font-size: 13px; font-weight: 700; letter-spacing: -.01em; }
    .ub-sidebar .ub-sb-actions { margin-left: auto; display: flex; gap: 4px; }

    /* 아이콘 버튼 (헤더 토글) */
    .ub-sidebar .ub-ico {
      width: 28px; height: 28px; border: 1px solid var(--ub-line); background: var(--ub-bg);
      border-radius: 8px; cursor: pointer; color: var(--ub-sub);
      display: inline-flex; align-items: center; justify-content: center; padding: 0; flex: none;
      transition: all .12s ease;
    }
    .ub-sidebar .ub-ico:hover { border-color: var(--ub-on); color: var(--ub-on); background: var(--ub-on-soft); }
    .ub-sidebar .ub-ico svg { width: 16px; height: 16px; stroke-width: 2; }

    /* 섹션 */
    .ub-sidebar .ub-sb-sect { margin-bottom: 20px; }
    .ub-sidebar .ub-sb-sect:last-child { margin-bottom: 4px; }
    .ub-sidebar .ub-sb-sect-t {
      font-size: 11px; font-weight: 700; letter-spacing: .04em;
      color: var(--ub-sub); text-transform: uppercase;
      margin: 0 4px 8px; display: flex; align-items: center; gap: 6px;
    }
    .ub-sidebar .ub-sb-sect-t svg { width: 12px; height: 12px; stroke-width: 2.2; opacity: .7; }

    /* 그리드 */
    .ub-sidebar .ub-sb-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .ub-sidebar .ub-sb-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }

    /* 기본 버튼 */
    .ub-sidebar .ub-sb-btn {
      display: flex; align-items: center; justify-content: center;
      padding: 10px 6px; border: 1px solid var(--ub-line); background: var(--ub-bg); border-radius: 8px;
      font-family: 'Pretendard','Malgun Gothic',sans-serif;
      font-size: 12px; font-weight: 600; color: var(--ub-fg); cursor: pointer;
      transition: all .12s ease; user-select: none; line-height: 1.2;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ub-sidebar .ub-sb-btn:hover { border-color: var(--ub-on); color: var(--ub-on); background: var(--ub-on-soft); }
    .ub-sidebar .ub-sb-btn:active { transform: translateY(1px); }
    .ub-sidebar .ub-sb-btn.ub-sb-wide { grid-column: 1 / -1; }

    /* 바코드 버튼 — Pretendard, 13px, 모노 간격 */
    .ub-sidebar .ub-sb-btn.ub-bc-btn {
      font-family: 'Pretendard','Malgun Gothic',sans-serif;
      font-size: 13px; font-weight: 700; letter-spacing: .02em;
      padding: 10px 4px;
    }

    /* 보조 / 텍스트 버튼 */
    .ub-sidebar .ub-sb-btn.ub-sb-link {
      background: transparent; border-color: transparent; color: var(--ub-sub);
      font-size: 11px; font-weight: 500; padding: 6px;
    }
    .ub-sidebar .ub-sb-btn.ub-sb-link:hover { color: var(--ub-on); background: transparent; border-color: transparent; }

    /* 빈 상태 */
    .ub-sidebar .ub-sb-empty {
      padding: 12px; text-align: center; font-size: 11px; color: var(--ub-sub);
      background: var(--ub-soft); border-radius: 8px; border: 1px dashed var(--ub-line);
      line-height: 1.5;
    }

    /* 토스트 */
    .ub-sidebar .ub-toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      padding: 10px 16px; background: rgba(15,20,25,.92); color: #fff;
      border-radius: 999px; font-size: 12px; font-weight: 600; z-index: 2147483647;
      pointer-events: none; opacity: 0; transition: opacity .2s;
    }
    .ub-sidebar .ub-toast.show { opacity: 1; }

    /* 접힌 상태 핸들 — Lucide chevron-right SVG */
    #ub-sb-handle {
      position: fixed; top: 50%; left: 0; transform: translateY(-50%);
      width: 24px; height: 60px; background: var(--ub-on, #35C5F0); color: #fff;
      border: none; border-radius: 0 8px 8px 0; cursor: pointer;
      z-index: 2147483645; box-shadow: 2px 0 8px rgba(15,20,25,.15); padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      transition: width .15s ease, background .15s ease;
    }
    #ub-sb-handle:hover { background: #2bb5e0; width: 28px; }
    #ub-sb-handle svg { width: 16px; height: 16px; stroke-width: 2.4; }
  `;
  function ensureSidebarStyle() {
    if (document.getElementById(SIDEBAR_STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = SIDEBAR_STYLE_ID; s.textContent = SIDEBAR_CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  function isDateSearchPage() {
    const sp = new URLSearchParams(location.search);
    if (sp.has('syear') || sp.has('eyear')) return true;
    return /(List|ListForm)\.do$/i.test(location.pathname);
  }
  function showToast(bar, msg) {
    let t = bar.querySelector('.ub-toast');
    if (!t) { t = document.createElement('div'); t.className = 'ub-toast'; bar.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(showToast._h);
    showToast._h = setTimeout(() => t.classList.remove('show'), 1400);
  }
  function applySbPosition(bar) {
    if (state.ubSbMode === 'docked') {
      bar.style.left = ''; bar.style.top = '';
      document.documentElement.classList.add('ub-sidebar-docked');
    } else {
      const maxX = Math.max(0, window.innerWidth - 260);
      const maxY = Math.max(0, window.innerHeight - 200);
      const x = Math.min(Math.max(0, state.ubSbX | 0), maxX);
      const y = Math.min(Math.max(0, state.ubSbY | 0), maxY);
      bar.style.left = x + 'px'; bar.style.top = y + 'px';
      document.documentElement.classList.remove('ub-sidebar-docked');
    }
  }
  function bindDrag(bar) {
    const hd = bar.querySelector('.ub-sb-hd');
    if (!hd) return;
    let dragging = false, ox = 0, oy = 0;
    hd.addEventListener('mousedown', (e) => {
      if (state.ubSbMode !== 'floating') return;
      if (e.target.closest('.ub-ico')) return;   // 아이콘 클릭은 드래그 X
      dragging = true;
      const rect = bar.getBoundingClientRect();
      ox = e.clientX - rect.left; oy = e.clientY - rect.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      let x = e.clientX - ox, y = e.clientY - oy;
      x = Math.min(Math.max(0, x), window.innerWidth - 60);
      y = Math.min(Math.max(0, y), window.innerHeight - 60);
      bar.style.left = x + 'px'; bar.style.top = y + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const x = parseInt(bar.style.left) || 24, y = parseInt(bar.style.top) || 24;
      state.ubSbX = x; state.ubSbY = y;
      try { chrome.storage.local.set({ ubSbX: x, ubSbY: y }); } catch (_) {}
    });
  }
  // Lucide SVG 아이콘(인라인). stroke=currentColor, 24x24 viewBox.
  const ICONS = {
    chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    chevronLeft:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    x:            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    panelLeft:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>',
    move:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l-3 3 3 3"/><path d="M9 5l3-3 3 3"/><path d="M15 19l-3 3-3-3"/><path d="M19 9l3 3-3 3"/><path d="M2 12h20"/><path d="M12 2v20"/></svg>',
    calendar:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>',
    barcode:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5v14"/><path d="M8 5v14"/><path d="M12 5v14"/><path d="M17 5v14"/><path d="M21 5v14"/></svg>',
    database:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>',
    play:         '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>'
  };

  /* 전표 자동 캐시 섹션 렌더 + 시작 */
  function renderCacheSection() {
    const page = currentCachePage();
    if (!page) return '';
    const j = cacheJob;
    let body;
    if (j.running) {
      const pct = j.total ? Math.round(j.current / j.total * 100) : 0;
      body = `
        <div style="font-size:11.5px;color:var(--ub-sub);margin:0 4px 6px">
          ${j.current}/${j.total} (${pct}%) · ${j.date}
        </div>
        <div style="height:6px;background:var(--ub-soft);border-radius:999px;overflow:hidden;margin:0 4px 8px">
          <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,#35C5F0,#1aa0d4);transition:width .15s"></div>
        </div>
        <button class="ub-sb-btn ub-sb-link ub-sb-wide" data-act="cache-cancel">취소</button>
      `;
    } else if (j.lastResult) {
      const r = j.lastResult;
      const savedTxt = r.savedMs > 60000 ? `${(r.savedMs/60000).toFixed(1)}분` : `${(r.savedMs/1000).toFixed(1)}초`;
      body = `
        <div class="ub-sb-empty" style="text-align:left;font-size:11px;line-height:1.6">
          청크 ${r.chunks.length}개 · hit ${r.hits} / miss ${r.miss}<br>
          ${(r.totalMs/1000).toFixed(1)}초 소요 · 캐시 절약 ${savedTxt}
        </div>
        <button class="ub-sb-btn ub-sb-wide" data-act="cache-run" style="margin-top:6px">다시 캐시</button>
      `;
    } else {
      body = `
        <div class="ub-sb-empty">현재 화면의 날짜 범위를<br>1일씩 분할 캐싱 (1회만 오래 걸림,<br>다음부터 즉시).</div>
        <button class="ub-sb-btn ub-sb-wide" data-act="cache-run" style="margin-top:6px">${ICONS.play}<span style="margin-left:4px">캐시 시작</span></button>
      `;
    }
    return `
      <div class="ub-sb-sect">
        <div class="ub-sb-sect-t">${ICONS.database}<span>전표 자동 캐시 · ${page.label}</span></div>
        ${body}
      </div>
    `;
  }

  // 현재 URL의 syear/sday/eyear/eday → ISO 날짜 추출
  function urlDateRange() {
    const u = new URL(location.href), sp = u.searchParams;
    const sy = sp.get('syear'), sm = sp.get('smonth'), sd = sp.get('sday');
    const ey = sp.get('eyear'), em = sp.get('emonth'), ed = sp.get('eday');
    if (!sy || !sm || !sd || !ey || !em || !ed) return null;
    return { s: `${sy}-${sm}-${sd}`, e: `${ey}-${em}-${ed}` };
  }
  function startCacheJob() {
    const page = currentCachePage();
    if (!page || cacheJob.running) return;
    const range = urlDateRange();
    if (!range) { alert('현재 페이지 URL에 날짜 파라미터(syear/sday/eyear/eday)가 없어요. 한 번 검색해서 URL이 잡힌 뒤 다시 시도하세요.'); return; }
    cacheJob.running = true; cacheJob.current = 0; cacheJob.total = 0; cacheJob.date = ''; cacheJob.startMs = Date.now(); cacheJob.lastResult = null;
    renderSidebar();
    chrome.runtime.sendMessage({
      source: 'ub', type: 'cacheSearch',
      path: page.path, url: location.href,
      startDate: range.s, endDate: range.e, chunkDays: 1
    }, (resp) => {
      cacheJob.running = false;
      cacheJob.lastResult = resp || { ok: false };
      renderSidebar();
    });
  }
  function cancelCacheJob() {
    // 현재는 실제 cancel 없음(background fetch 진행 중). 상태만 reset 표시.
    cacheJob.running = false; cacheJob.lastResult = { chunks: [], hits: 0, miss: 0, totalMs: Date.now() - cacheJob.startMs, savedMs: 0 };
    renderSidebar();
  }

  function ensureHandle() {
    if (document.getElementById(HANDLE_ID)) return;
    if (!document.body) return;
    const h = document.createElement('button');
    h.id = HANDLE_ID; h.innerHTML = ICONS.chevronRight; h.title = 'D102 도구 열기';
    h.addEventListener('click', () => {
      state.ubSbCollapsed = false;
      try { chrome.storage.local.set({ ubSbCollapsed: false }); } catch (_) {}
      renderSidebar();
    });
    document.body.appendChild(h);
  }
  function removeHandle() {
    const h = document.getElementById(HANDLE_ID);
    if (h) h.remove();
  }
  function renderSidebar() {
    // 팝업 창(상품수정/공장검색/imageView 등)에서는 사이드바·핸들 안 뜨게.
    if (_IS_POPUP) {
      const old = document.getElementById(SIDEBAR_ID); if (old) old.remove();
      removeHandle();
      document.documentElement.classList.remove('ub-sidebar-docked');
      return;
    }
    // 마스터 OFF: 모두 제거
    if (!on('ubSidebar')) {
      const old = document.getElementById(SIDEBAR_ID); if (old) old.remove();
      removeHandle();
      document.documentElement.classList.remove('ub-sidebar-docked');
      return;
    }
    if (!document.body) return;
    ensureSidebarStyle();

    // 접힘 상태: 사이드바 숨기고 핸들만 노출
    if (state.ubSbCollapsed) {
      const old = document.getElementById(SIDEBAR_ID); if (old) old.remove();
      document.documentElement.classList.remove('ub-sidebar-docked');
      ensureHandle();
      return;
    }
    removeHandle();

    let bar = document.getElementById(SIDEBAR_ID);
    if (!bar) {
      bar = document.createElement('aside');
      bar.id = SIDEBAR_ID;
      document.body.appendChild(bar);
    }
    bar.className = 'ub-sidebar ub-mode-' + (state.ubSbMode === 'floating' ? 'floating' : 'docked');

    const isFloat = state.ubSbMode === 'floating';
    const dateBtns = isDateSearchPage();
    const codes = Array.isArray(state.ubBarcodes) ? state.ubBarcodes : [];
    const modeIcon  = isFloat ? ICONS.panelLeft : ICONS.move;
    const modeTitle = isFloat ? '왼쪽으로 붙이기' : '플로팅 모드로';

    bar.innerHTML = `
      <div class="ub-sb-hd">
        <div class="ub-sb-brand">D</div>
        <div class="ub-sb-title">D102 도구</div>
        <div class="ub-sb-actions">
          <button class="ub-ico" data-act="mode" title="${modeTitle}">${modeIcon}</button>
          <button class="ub-ico" data-act="collapse" title="접기">${ICONS.chevronLeft}</button>
        </div>
      </div>

      ${dateBtns ? `
        <div class="ub-sb-sect">
          <div class="ub-sb-sect-t">${ICONS.calendar}<span>날짜 빠른선택</span></div>
          <div class="ub-sb-grid">
            <button class="ub-sb-btn" data-r="today">오늘</button>
            <button class="ub-sb-btn" data-r="yesterday">어제</button>
            <button class="ub-sb-btn" data-r="d3">3일간</button>
            <button class="ub-sb-btn" data-r="d7">7일간</button>
            <button class="ub-sb-btn" data-r="m1">한 달</button>
            <button class="ub-sb-btn" data-r="q1">분기</button>
            <button class="ub-sb-btn ub-sb-wide" data-r="y1">일 년</button>
          </div>
        </div>
      ` : `
        <div class="ub-sb-sect">
          <div class="ub-sb-sect-t">${ICONS.calendar}<span>날짜 빠른선택</span></div>
          <div class="ub-sb-empty">날짜 검색이 가능한<br>리스트 페이지에서 표시됩니다.</div>
        </div>
      `}

      <div class="ub-sb-sect">
        <div class="ub-sb-sect-t">${ICONS.barcode}<span>바코드 클립보드 · ${codes.length}/${MAX_BARCODES}</span></div>
        ${codes.length ? `
          <div class="ub-sb-grid-3">
            ${codes.map(b => `<button class="ub-sb-btn ub-bc-btn" data-bc="${b.c}" title="클릭: 복사 / 더블클릭: 삭제 — ${b.c}">${b.c}</button>`).join('')}
          </div>
          <button class="ub-sb-btn ub-sb-link ub-sb-wide" data-act="bc-clear" style="margin-top:8px">모두 지우기</button>
        ` : `
          <div class="ub-sb-empty">2606WH 같은 바코드 텍스트를<br>복사하면 자동으로 저장됩니다.</div>
        `}
      </div>

      ${renderCacheSection()}
    `;

    // 위치 적용
    applySbPosition(bar);
    // 드래그
    bindDrag(bar);

    // 헤더 액션
    bar.querySelectorAll('.ub-ico').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'mode') {
        state.ubSbMode = (state.ubSbMode === 'floating') ? 'docked' : 'floating';
        try { chrome.storage.local.set({ ubSbMode: state.ubSbMode }); } catch (_) {}
        renderSidebar();
      } else if (act === 'collapse') {
        state.ubSbCollapsed = true;
        try { chrome.storage.local.set({ ubSbCollapsed: true }); } catch (_) {}
        renderSidebar();
      }
    }));

    // 날짜 버튼 — select 값만 변경
    bar.querySelectorAll('[data-r]').forEach(b => b.addEventListener('click', () => {
      const n = setDateSelects(b.dataset.r);
      showToast(bar, n ? '날짜 변경됨 (' + n + '개 필드)' : '날짜 필드를 찾지 못함');
    }));

    // 바코드 버튼 — 단일 클릭 = 복사, 더블 클릭 = 삭제.
    // 200ms timeout으로 단/더블 분리. 더블 시 단일 클릭 timeout 취소.
    bar.querySelectorAll('[data-bc]').forEach(b => {
      let clickTimer = null;
      b.addEventListener('click', () => {
        if (clickTimer) return;   // dblclick listener가 곧 timeout 취소
        clickTimer = setTimeout(() => {
          clickTimer = null;
          const c = b.dataset.bc;
          copyToClipboard(c);
          showToast(bar, c + ' 복사됨');
        }, 220);
      });
      b.addEventListener('dblclick', () => {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        const c = b.dataset.bc;
        removeBarcode(c);
        showToast(bar, c + ' 삭제됨');
        renderSidebar();
      });
      b.title = '클릭: 복사 / 더블클릭: 삭제 — ' + b.dataset.bc;
    });
    const clr = bar.querySelector('[data-act="bc-clear"]');
    if (clr) clr.addEventListener('click', () => {
      state.ubBarcodes = [];
      try { chrome.storage.local.set({ ubBarcodes: [] }); } catch (_) {}
      renderSidebar();
    });

    const runC = bar.querySelector('[data-act="cache-run"]');
    if (runC) runC.addEventListener('click', startCacheJob);
    const cancelC = bar.querySelector('[data-act="cache-cancel"]');
    if (cancelC) cancelC.addEventListener('click', cancelCacheJob);
  }

  /* ==========================================================================
   *  적용 / 구독
   * ========================================================================== */
  function applyAll() {
    applyDark();
    renderSidebar();
    injectPageSizeOptions();
    document.querySelectorAll('img[data-ub-edit]').forEach(img => {
      img.style.cursor = on('ubThumbEdit') ? 'pointer' : '';
      img.title = on('ubThumbEdit') ? '상품 수정 (새 창)' : '';
    });
  }
  let mo = null;
  function startObserver() {
    if (mo) return;
    mo = new MutationObserver((records) => {
      let needThumb = false, needPaging = false, needSidebar = false;
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (!(n instanceof Element)) continue;
          if (n.matches && (n.matches('img') || n.matches('input[name=idx]'))) needThumb = true;
          if (n.querySelector && (n.querySelector('img') || n.querySelector('input[name=idx]'))) needThumb = true;
          if (n.matches && n.matches('select[name=pageSize]')) needPaging = true;
          if (n.querySelector && n.querySelector('select[name=pageSize]')) needPaging = true;
        }
      }
      if (needThumb) bindThumbEdit(document);
      if (needPaging) injectPageSizeOptions();
      if (!document.getElementById(SIDEBAR_ID) && !document.getElementById(HANDLE_ID) && on('ubSidebar')) needSidebar = true;
      if (needSidebar) renderSidebar();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
  function init() {
    ensureDefaultPageSize();
    bindThumbEdit(document);
    bindCopyListener();
    applyAll();
    startObserver();
    // background → cacheProgress 메시지 수신
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || msg.source !== 'ub-bg' || msg.type !== 'cacheProgress') return;
        cacheJob.current = msg.current || 0;
        cacheJob.total = msg.total || 0;
        cacheJob.date = msg.date || '';
        if (msg.phase === 'done') cacheJob.running = false;
        renderSidebar();
      });
    } catch (_) {}
    // 윈도우 리사이즈 시 플로팅 사이드바 안 보이는 곳으로 가지 않게 보정
    window.addEventListener('resize', () => {
      const bar = document.getElementById(SIDEBAR_ID);
      if (bar && state.ubSbMode === 'floating') applySbPosition(bar);
    });
    // 페이지 로드 telemetry
    if (document.readyState === 'complete') reportPageLoad();
    else window.addEventListener('load', reportPageLoad);
  }

  try {
    chrome.storage.local.get(D, d => {
      Object.assign(state, d || {});
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
      else init();
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      let changed = false;
      Object.keys(D).forEach(k => { if (ch[k]) { state[k] = ch[k].newValue; changed = true; } });
      if (changed) {
        applyAll();
        if (on('ubThumbEdit')) bindThumbEdit(document);
      }
    });
  } catch (e) {}
})();
