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
 *    ubSbWidth, ubSbHeight : 사이드바 크기(px, docked=너비만)
 *    ubSbLocked : true 면 이동·크기조절 잠금
 *    ubBarcodes : 사용자 복사 바코드 [{c,t}] (최대 12, FIFO)
 *
 *  v2.7.0 — 날짜=select 변경(검색X) / 사이드바 floating·드래그·핸들 / 바코드 클립보드.
 *  v2.6.0 — invert 폐기, 실제 다크 / 사이드바 / 페이지사이즈 / 썸네일 보강.
 * ========================================================================== */
(function () {
  'use strict';

  const D = {
    ubSkin: false, ubDark: false, ubThumbEdit: true,
    ubSidebar: true, ubPageSize: true, ubAutoSync: false,
    ubSbMode: 'docked', ubSbX: 24, ubSbY: 24, ubSbCollapsed: false,
    ubSbWidth: 256, ubSbHeight: 440, ubSbLocked: false,
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

  try { console.log('[UB][skin] v3.6.1 loaded', { isTop: window === window.top, path: location.pathname, popup: _IS_POPUP }); } catch (_) {}

  /* ==========================================================================
   *  pageSize redirect — document_start 시점에 IIFE로 즉시 결정.
   *  ⚠ init() 안에서 호출하면 DOMContentLoaded 후라 페이지가 이미 첫 결과를
   *    그리기 시작 → redirect되면 사용자 시각에 "20→100 두 번 깜빡임".
   *  document_start 시점에 location.replace 호출하면 chrome이 첫 HTML
   *  download를 취소하고 새 URL로 navigate → 사용자에겐 한 번만 보임.
   *
   *  storage는 비동기라 IIFE에서 못 읽음 → sessionStorage 미러 사용.
   *  init()/onChanged에서 ubSkin/ubPageSize 값을 sessionStorage에 저장 →
   *  같은 탭의 다음 navigate부터 IIFE가 즉시 판단.
   * ========================================================================== */
  (function ensurePageSizeAtStart() {
    try {
      // 1) popup 가드(IIFE는 _IS_POPUP 평가 전이라 직접 다시 검사)
      if (window.menubar && window.menubar.visible === false) return;
      if (window.toolbar && window.toolbar.visible === false) return;
      if (window.opener && window.opener !== window && window.outerWidth && window.outerWidth < 1300) return;

      // 2) URL/path 가드
      if (/[?&]pageSize=/.test(location.search)) return;
      if (!/(List|ListForm)\.do$/i.test(location.pathname)) return;

      // 3) referrer 가드 — 같은 페이지에서 form submit으로 도착한 검색 결과면 skip
      if (document.referrer) {
        try {
          const ref = new URL(document.referrer);
          if (ref.host === location.host && ref.pathname === location.pathname) return;
        } catch (_) {}
      }

      // 4) 사용자 옵션 가드(sessionStorage mirror).
      //    첫 진입엔 mirror 없음 → ubSkin default OFF → redirect 안 함.
      //    사용자가 popup에서 ubSkin ON 후엔 다음 navigate부터 적용.
      const skin = sessionStorage.getItem('ub_pref_skin');
      const ps = sessionStorage.getItem('ub_pref_ps');
      if (skin !== '1') return;          // ubSkin 마스터 ON 아니면 skip
      if (ps === '0') return;            // 사용자가 명시적 OFF면 skip

      // 5) document_start 시점 즉시 redirect → chrome이 첫 download 취소하고
      //    새 URL로 navigate. 사용자에겐 한 번만 로드됨.
      const u = new URL(location.href);
      u.searchParams.set('pageSize', '100');
      location.replace(u.toString());
    } catch (_) {}
  })();

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

  /* ==========================================================================
   *  Phase 2 Transparent Caching 은 v3.1.1부터 src/cache-intercept.js 로 분리.
   *  loader.js 메커니즘으로 GitHub raw에서 매 페이지 새로고침마다 자동 갱신.
   *  skin.js 에는 사이드바 통계 UI 표시용 stub 만 남김 (cacheStat). cache-intercept.js
   *  가 window.postMessage 'ub-cache-stat' 으로 stats 를 보내면 갱신.
   * ========================================================================== */
  const cacheStat = { hits: 0, miss: 0, savedMs: 0, lastMs: 0, fillMs: 0 };
  try {
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.source !== 'ub-cache-stat' || e.source !== window) return;
      if (d.hits)    cacheStat.hits    += d.hits;
      if (d.miss)    cacheStat.miss    += d.miss;
      if (d.fillMs)  cacheStat.fillMs  += d.fillMs;
      if (typeof d.lastMs === 'number') cacheStat.lastMs = d.lastMs;
      if (d.savedMs) cacheStat.savedMs += d.savedMs;
      try { renderSidebar && renderSidebar(); } catch (_) {}
    });
  } catch (_) {}

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
  // (구) ensureDefaultPageSize는 init() 안에서 호출되어 DOMContentLoaded
  // 후에 redirect → 두 번 로드 발생. v3.0.5부터 위 ensurePageSizeAtStart
  // IIFE가 document_start에서 즉시 처리. 이 함수는 더 이상 사용 안 함.
  function ensureDefaultPageSize() { /* noop — IIFE로 이전 */ }
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
      case 'm1':        start.setDate(today.getDate() - 29); break;
      case 'pm': {
        const s = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const e = new Date(today.getFullYear(), today.getMonth(), 0);
        return { s: ymd(s), e: ymd(e) };
      }
      case 'y1':        start.setFullYear(today.getFullYear() - 1); break;
      case 'origin':    start.setFullYear(2000, 0, 1); break;
    }
    return { s: ymd(start), e: ymd(end) };
  }
  // 페이지 폼의 syear/smonth/sday/eyear/emonth/eday 값만 변경. 검색은 X.
  // kind='custom' 이면 dateRange()를 거치지 않고 customRange({s,e})를 그대로 사용.
  function setDateSelects(kind, customRange) {
    const r = (kind === 'custom' && customRange) ? customRange : dateRange(kind);
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
  // 검색칸(바코드)에 수기 입력 후 검색하면, 검색 후 페이지에 그 값이 남아있으므로
  // 로드 시 바코드 검색칸 값을 읽어 클립보드에 자동 등록. (라벨 '바코드' 우선, name 폴백)
  function captureSearchBarcode() {
    try {
      if (!on('ubSidebar')) return;
      let el = findLabeledInput(['바코드']);
      if (!el || !el.value) {
        const n = document.querySelector('input[name*="barcode" i]:not([type="hidden"])');
        if (n && n.value) el = n;
      }
      const v = el && el.value ? el.value.trim() : '';
      if (!v) return;
      const codes = extractBarcodes(v);
      if (codes.length && addBarcodes(codes)) renderSidebar();
    } catch (_) {}
  }

  /* ==========================================================================
   *  5.5) 상품 재고화 — inputItemWriteForm.do 사이드바 섹션(stockmacro.js 이관).
   *   바코드 → inputItemList(입고장번호) → inputItemJunList(junSeq) → form2.jun 제출.
   *   ⚠ 등록(재고화 쓰기)은 절대 자동 안 함 — 입고장 로드까지만. 날짜=태초(2000-01-01)~오늘.
   *   skin.js 는 ISOLATED world 지만 fetch(credentials)·document.forms['form2'].submit()
   *   은 DOM 공유로 정상 동작.
   * ========================================================================== */
  const STK_TAG = '[UB][stock]';
  const stkLog = (...a) => { try { console.log(STK_TAG, ...a); } catch (_) {} };
  function isInboundWrite() { return /\/input\/item\/inputItemWriteForm\.do/.test(location.pathname); }
  function dateParams() {
    const d = new Date();
    return {
      syear: '2000', smonth: '01', sday: '01',
      eyear: String(d.getFullYear()),
      emonth: String(d.getMonth() + 1).padStart(2, '0'),
      eday: String(d.getDate()).padStart(2, '0')
    };
  }
  async function postDoc(action, params) {
    const r = await fetch(action, {
      method: 'POST', credentials: 'include', cache: 'no-cache',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: params.toString()
    });
    const buf = await r.arrayBuffer();
    let html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if ((html.match(/�/g) || []).length > 20) html = new TextDecoder('euc-kr').decode(buf);
    return new DOMParser().parseFromString(html, 'text/html');
  }
  function firstDataRow(doc) {
    for (const t of doc.querySelectorAll('table.t_list')) {
      let hi = -1, cells = null;
      for (const r of t.rows) {
        const cs = [...r.cells].map(c => c.textContent.replace(/\s+/g, ' ').trim());
        if (cs.some(c => /수량|입고장/.test(c))) { hi = r.rowIndex; cells = cs; break; }
      }
      if (hi < 0) continue;
      for (let i = hi + 1; i < t.rows.length; i++) {
        const r = t.rows[i];
        if (/^\d+$/.test((r.cells[0] ? r.cells[0].textContent : '').replace(/\s+/g, '')))
          return { headers: cells, row: r };
      }
    }
    return null;
  }
  const colIdx = (headers, re) => { for (let i = 0; i < headers.length; i++) if (re.test(headers[i])) return i; return -1; };
  async function barcodeToJunNum(barcode) {
    const p = new URLSearchParams({ ...dateParams(), searchBarcode: barcode, pageSize: '100' });
    const doc = await postDoc('/jun/inputitem/inputItemList.do?tcode=input_item', p);
    const g = firstDataRow(doc);
    if (!g) return null;
    const ci = colIdx(g.headers, /입고장번호/);
    if (ci < 0) return null;
    const jn = (g.row.cells[ci] ? g.row.cells[ci].textContent : '').replace(/\s+/g, '').trim();
    return jn || null;
  }
  async function junNumToSeq(junNum) {
    const p = new URLSearchParams({ ...dateParams(), searchJunNum: junNum, searchItemType: '1', pageSize: '100' });
    const doc = await postDoc('/jun/inputitem/inputItemJunList.do?tcode=input_item_jun', p);
    const g = firstDataRow(doc);
    if (!g) return null;
    const m = g.row.innerHTML.match(/view\(\s*'?(\d+)'?\s*\)/);
    return m ? m[1] : null;
  }
  function loadVoucher(seq) {
    const f2 = document.forms['form2'];
    if (!f2 || !f2.jun) { stkLog('form2/jun 없음'); return false; }
    f2.jun.value = seq;
    stkLog('form2.jun =', seq, '→ submit');
    f2.submit();
    return true;
  }
  let stkBusy = false;
  async function run(barcode, setStatus) {
    barcode = (barcode || '').trim();
    if (!barcode) { setStatus('바코드를 입력하세요', 'warn'); return; }
    if (stkBusy) return; stkBusy = true;
    try {
      setStatus('전표 조회 중…', 'go');
      const junNum = await barcodeToJunNum(barcode);
      if (!junNum) { setStatus('입고장번호를 못 찾음 — 바코드 확인', 'err'); return; }
      setStatus('입고장 ' + junNum + ' 확인 중…', 'go');
      const seq = await junNumToSeq(junNum);
      if (!seq) { setStatus('입고장 seq를 못 찾음 (' + junNum + ')', 'err'); return; }
      try { localStorage.setItem('UB_STOCK_LAST', JSON.stringify({ barcode: barcode, junNum: junNum, seq: seq })); } catch (_) {}
      stkLog('barcode', barcode, '→ junNum', junNum, '→ seq', seq);
      setStatus('입고장 ' + junNum + ' 불러오는 중…', 'go');
      ubHlStore(barcode);        // 검색 바코드 저장 → 로드된 새 문서 init 이 강조+스크롤
      loadVoucher(seq);   // 페이지 리로드 → 입고장 로드(사람이 확인 후 재고화 등록)
    } catch (e) {
      stkLog('실패', e); setStatus('실패: ' + (e && e.message ? e.message : e), 'err');
    } finally { stkBusy = false; }
  }

  /* ==========================================================================
   *  5.5b) 메인석 입고 자동화 — inputStoneWriteForm.do 사이드바 섹션.
   *   바코드1개로 ①inputStoneList.do(searchBarcode,태초~오늘)→입고장번호
   *   ②inputStoneJunList.do(searchJunNum)→seq(선택셀 setSeting(form2,'seq'))
   *   ③form2.jun=seq+submit→전표 로드. 재고화(input_item)와 구조 동일,
   *     차이: 엔드포인트 /jun/inputstone·/input/stone, seq=setSeting 인자(따옴표).
   *   ⭐신규: 전표 로드 후 그 바코드 행을 강조+스크롤(로드 전 sessionStorage 저장).
   *   ⚠ 등록(쓰기)은 절대 자동 안 함 — 전표 로드+강조까지만. postDoc/firstDataRow/colIdx 공용.
   * ========================================================================== */
  const MS_TAG = '[UB][mstone]';
  const msLog = (...a) => { try { console.log(MS_TAG, ...a); } catch (_) {} };
  const MS_HL_KEY = 'UB_MAINSTONE_HL';
  function isMainStoneWrite() { return /\/input\/stone\/inputStoneWriteForm\.do/.test(location.pathname); }
  async function msBarcodeToJun(barcode) {
    const p = new URLSearchParams({ ...dateParams(), searchBarcode: barcode, pageSize: '100' });
    const doc = await postDoc('/jun/inputstone/inputStoneList.do?tcode=input_stone', p);
    const g = firstDataRow(doc);
    if (!g) return null;
    const ci = colIdx(g.headers, /입고장번호/);
    if (ci < 0) return null;
    const jn = (g.row.cells[ci] ? g.row.cells[ci].textContent : '').replace(/\s+/g, '').trim();
    return jn || null;
  }
  async function msJunToSeq(junNum) {
    const p = new URLSearchParams({ ...dateParams(), searchJunNum: junNum, pageSize: '100' });
    const doc = await postDoc('/jun/inputstone/inputStoneJunList.do?tcode=input_stone', p);
    // 선택 셀 <a href="javascript:setSeting(form2,'90024')"> — seq 는 따옴표로 감싸짐.
    const html = doc.body ? doc.body.innerHTML : '';
    const m = html.match(/setSeting\s*\(\s*[^,]*,\s*'?(\d+)'?\s*\)/);
    return m ? m[1] : null;
  }
  function msLoadVoucher(seq, barcode) {
    const f2 = document.forms['form2'];
    if (!f2 || !f2.jun) { msLog('form2/jun 없음'); return false; }
    ubHlStore(barcode);        // 로드 전 강조 대상 저장 → 새 문서 init 이 읽어 강조
    f2.jun.value = seq;
    msLog('form2.jun =', seq, '→ submit');
    f2.submit();
    return true;
  }
  let msBusy = false;
  async function msRun(barcode, setStatus) {
    barcode = (barcode || '').trim();
    if (!barcode) { setStatus('바코드를 입력하세요', 'warn'); return; }
    if (msBusy) return; msBusy = true;
    try {
      setStatus('입고 전표 조회 중…', 'go');
      const junNum = await msBarcodeToJun(barcode);
      if (!junNum) { setStatus('입고장번호를 못 찾음 — 바코드 확인', 'err'); return; }
      setStatus('입고장 ' + junNum + ' 확인 중…', 'go');
      const seq = await msJunToSeq(junNum);
      if (!seq) { setStatus('입고장 seq를 못 찾음 (' + junNum + ')', 'err'); return; }
      try { localStorage.setItem('UB_MAINSTONE_LAST', JSON.stringify({ barcode: barcode, junNum: junNum, seq: seq })); } catch (_) {}
      msLog('barcode', barcode, '→ junNum', junNum, '→ seq', seq);
      setStatus('입고장 ' + junNum + ' 불러오는 중…', 'go');
      msLoadVoucher(seq, barcode);   // 전표 로드 → ubHighlightPending 이 검색 바코드 행 강조
    } catch (e) {
      msLog('실패', e); setStatus('실패: ' + (e && e.message ? e.message : e), 'err');
    } finally { msBusy = false; }
  }
  // ── 공용 강조/스크롤 (상품입고 재고화·회전입고·메인석입고 공용) ───────────────────────
  //  로드 전 ubHlStore(바코드) 로 sessionStorage(MS_HL_KEY)에 저장 → submit 이 전표 쓰기폼을 새로
  //  로드(full-nav)하면 새 문서의 init 이 그 flag 를 읽어 해당 행을 강조+스크롤한다.
  //  ⚠ "1번만 되고 그 다음 안 됨"의 진짜 원인 = 나가는(outgoing) 페이지가 자기 flag 를 조기 소비.
  //   → ubHlSetHere: flag 를 '세팅한' 문서는 절대 소비하지 않는다. full-nav 후 새 문서(fresh module,
  //     ubHlSetHere=false)만 소비 → outgoing/new 를 시간(지연) 아닌 '문서 정체성'으로 확정 구분.
  function ubHlPage() { return isInboundWrite() || isRotateWrite() || isMainStoneWrite(); }
  let ubHlSetHere = false;
  function ubHlStore(barcode) {
    try { sessionStorage.setItem(MS_HL_KEY, JSON.stringify({ bc: barcode, ts: Date.now() })); } catch (_) {}
    ubHlSetHere = true;   // 이 문서는 세팅자 → 자기 flag 소비 금지(P1 확정 차단)
  }
  // 행 찾기: ①idx 체크박스 value 토큰(seq,바코드,orderSeq) 대소문자 무시, ②폴백: 표 셀 공백구분
  //  첫 토큰이 바코드와 정확히 일치(부분일치 아님 → 오매칭 방지).
  //  ⚠ 유비샵은 바코드를 대문자로 저장, 사용자는 소문자 입력 가능(검색은 서버가 대소문자 무시하나
  //   강조는 클라 매칭이라 정규화 필수). 예: 입력 2607dl → 목록 2607DL.
  function ubFindRow(bc) {
    const want = String(bc == null ? '' : bc).trim().toUpperCase();
    if (!want) return null;
    const boxes = [...document.querySelectorAll('input[name=idx]')];
    const hit = boxes.find(b => (b.value || '').split(',').some(s => s.trim().toUpperCase() === want));
    if (hit) return hit.closest('tr');
    for (const t of document.querySelectorAll('table.t_list')) {   // 폴백: idx 구조가 다를 때 대비
      for (const r of t.rows) {
        for (const c of r.cells) {
          const first = (c.textContent || '').trim().split(/\s+/)[0] || '';
          if (first.toUpperCase() === want) return r;
        }
      }
    }
    return null;
  }
  let ubHlPolling = false;
  function ubHighlightPending() {
    // ubHlSetHere 가드: flag 를 세팅한(=submit 하고 나가는) 문서는 소비하지 않는다 → P1 확정 차단.
    if (!ubHlPage() || ubHlPolling || ubHlSetHere) return;
    let raw = null;
    try { raw = sessionStorage.getItem(MS_HL_KEY); } catch (_) {}
    if (!raw) return;               // 대상 없으면 폴 시작 안 함
    ubHlPolling = true;
    let tries = 0, lastKey = '';
    const tick = () => {
      // ⚠ 실행 중 폴도 매 틱 ubHlSetHere 재확인 — 폴 도중 사용자가 새 검색을 하면 이 문서가 '세팅자'가
      //  되어 곧 나간다. 그 순간부터 소비 금지(outgoing DOM 에서 새 flag 를 조기 소비하는 P1 결합 차단).
      //  JS 단일스레드라 ubHlStore 는 tick 사이에만 실행되므로 이 검사로 확정 안전.
      if (ubHlSetHere) { ubHlPolling = false; return; }
      // 매 틱 flag 를 새로 읽는다 — 새 검색이 덮어써도 최신 바코드를 쫓고(P2), identity 가 바뀌면
      //  재시도 예산(tries)도 리셋. 사라졌으면(소비됨) 종료.
      let cur = null;
      try { cur = sessionStorage.getItem(MS_HL_KEY); } catch (_) {}
      if (!cur) { ubHlPolling = false; return; }
      let bc = cur, ts = 0;
      try { const o = JSON.parse(cur); if (o && o.bc) { bc = o.bc; ts = o.ts || 0; } } catch (_) {}
      const key = bc + '|' + ts;
      if (key !== lastKey) { lastKey = key; tries = 0; }   // flag 교체 → 예산 리셋(P2)
      if (ts && (Date.now() - ts > 60000)) { try { sessionStorage.removeItem(MS_HL_KEY); } catch (_) {} ubHlPolling = false; return; }   // 만료
      const row = ubFindRow(bc);
      if (row) {
        try { sessionStorage.removeItem(MS_HL_KEY); } catch (_) {}
        row.classList.add('ub-ms-hl');
        try { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        catch (_) { try { row.scrollIntoView(); } catch (_) {} }
        msLog('강조+스크롤', bc);
        ubHlPolling = false;
        return;
      }
      if (++tries < 25) { setTimeout(tick, 300); return; }   // ~7.5s 폴링(렌더 지연 대비)
      ubHlPolling = false;   // 소진: flag 유지(60초 만료) → 옵저버/다음 로드가 재시도
    };
    tick();   // 첫 틱 동기 OK — ubHlSetHere 가드로 outgoing 소비가 원천 차단(시간 의존 없음)
  }

  /* ==========================================================================
   *  5.6) 회전입고 자동화 — rotateItemWriteForm.do 사이드바 섹션.
   *   본사반품확인(opdelivedItemWrite) → 회전입고(rotateItemWrite) 2단 자동화.
   *   사용자 수동 3단계(반품확인·새매장선택·회전입고)를 그대로 1건씩 재현.
   *   ⚠ skin.js 는 ISOLATED world → 페이지의 checkBarcode/movePageForm 호출 불가.
   *     필드세팅 + form1.submit() 로 대체(재고화 loadVoucher 와 동일 방식).
   * ========================================================================== */
  const ROT_TAG = '[UB][rotate]';
  const rotLog = (...a) => { try { console.log(ROT_TAG, ...a); } catch (_) {} };
  function isRotateWrite() { return /\/rotate\/item\/rotateItemWriteForm\.do/.test(location.pathname); }
  // 회전입고 새매장 옵션(tmpShop) — 실측 하드코딩(안정적).
  const ROT_SHOPS = [
    { v: '',   t: '--' },
    { v: 'GE', t: '거제점' },
    { v: 'GJ', t: '광주점' },
    { v: 'KH', t: '김해점' },
    { v: 'NU', t: '누리엔점' },
    { v: 'DG', t: '대구점' },
    { v: 'ME', t: '메리움점' },
    { v: 'CT', t: '센텀점' },
    { v: 'SW', t: '수원점' },
    { v: 'US', t: '울산점' },
    { v: 'IN', t: '인천점' },
    { v: 'CW', t: '창원점' },
    { v: 'LT', t: 'FASHION' },
    { v: '00', t: 'D102본사' }
  ];
  const rotShopName = (v) => { const s = ROT_SHOPS.find(o => o.v === v); return s ? s.t : (v || ''); };
  // form1 의 confirm 필수 hidden 필드. 이 페이지는 폼 중첩이 깨진 옛 HTML 이라
  //  DOMParser 의 form.elements 로는 hidden 들이 form1 밖으로 빠져 하나도 안 잡힌다(실측).
  //  → GET HTML 에서 정규식으로 직접 추출해야 서버가 실제로 확인 커밋을 한다.
  const OPDELIV_FIELDS = ['sKey', 'pageSize', 'searchSortType', 'jun', 'opdelivedDate', 'listFlag', 'searchShop'];
  // 본사반품확인: 폼페이지 GET → HTML 에서 form1 hidden 필드(GET마다 새로 발급되는 sKey 포함)
  //  정규식 추출 → POST opdelivedItemWrite.do(그 필드 + barcode).
  //  성공·실패 모두 opdelivedItemWriteForm.do 로 리다이렉트되며, 실패일 때만 리다이렉트 URL 의
  //  msg 파라미터에 에러문구(예 "본사반품확인 가능한 상태가 아닙니다...")가 실린다.
  //  → msg 비어있으면 성공. { ok, msg } 반환.
  async function confirmOpdelivedReturn(barcode) {
    try {
      const r = await fetch('/opdeliv/item/opdelivedItemWriteForm.do?tcode=opdeliv_item', {
        method: 'GET', credentials: 'include', cache: 'no-cache'
      });
      const buf = await r.arrayBuffer();
      let html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      if ((html.match(/�/g) || []).length > 20) html = new TextDecoder('euc-kr').decode(buf);
      const params = new URLSearchParams();
      const seen = new Set();
      const re = /<input\b[^>]*type=["']hidden["'][^>]*>/gi;
      let m;
      while ((m = re.exec(html))) {
        const tag = m[0];
        const nm = (tag.match(/name=["']([^"']+)["']/i) || [])[1];
        if (!nm || !OPDELIV_FIELDS.includes(nm) || seen.has(nm)) continue;
        seen.add(nm);
        params.append(nm, (tag.match(/value=["']([^"']*)["']/i) || [, ''])[1]);
      }
      if (!seen.has('sKey')) { rotLog('반품확인: sKey 추출 실패 — 폼페이지 구조 변경 의심'); return { ok: false, msg: '폼페이지 구조 변경(관리자 문의)' }; }
      params.set('barcode', barcode);
      const resp = await fetch('/opdeliv/item/opdelivedItemWrite.do?tcode=opdeliv_item', {
        method: 'POST', credentials: 'include', cache: 'no-cache',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: params.toString()
      });
      let msg = '';
      try { msg = new URL(resp.url).searchParams.get('msg') || ''; } catch (_) {}
      if (msg) { rotLog('반품확인 실패 msg:', msg); return { ok: false, msg }; }
      return { ok: true };
    } catch (e) { rotLog('반품확인 실패', e); return { ok: false, msg: (e && e.message) || String(e) }; }
  }
  let rotBusy = false;
  async function rotateRun(barcode, shop, setStatus) {
    barcode = (barcode || '').trim();
    if (barcode.length !== 6) { setStatus('바코드 6자리를 입력하세요', 'warn'); return; }
    if (rotBusy) return; rotBusy = true;
    try {
      setStatus('본사반품확인 처리 중…', 'go');
      const res = await confirmOpdelivedReturn(barcode);
      if (!res.ok) { setStatus('본사반품확인 실패: ' + (res.msg || '반품 신청된 건인지 확인'), 'err'); return; }
      setStatus('회전입고 실행 중…', 'go');
      const f = document.forms['form1'];
      if (!f || !f.barcode) { setStatus('회전입고 폼(form1)을 찾지 못함', 'err'); return; }
      if (f.tmpShop) f.tmpShop.value = shop;
      f.barcode.value = barcode;
      try { localStorage.setItem('UB_ROTATE_LAST', JSON.stringify({ barcode: barcode, shop: shop })); } catch (_) {}
      ubHlStore(barcode);        // 검색 바코드 저장 → 결과 페이지 init 이 강조+스크롤
      rotLog('barcode', barcode, '→ shop', shop, '→ form1.submit');
      f.submit();   // 전체제출 → 결과 페이지로 이동
    } catch (e) {
      rotLog('실패', e); setStatus('실패: ' + (e && e.message ? e.message : e), 'err');
    } finally { rotBusy = false; }
  }

  /* ==========================================================================
   *  5.7) 상품주문전표 재고배정 — 부모 새로고침 제거 (v3.6.8)
   *   /jun/orderitem/orderItemList.do 에서 상태 '본사확인' 행의 링크를 누르면 재고상품
   *   검색 팝업이 뜨고, 거기서 재고를 고르면 서버가 배정(본사확인→입고완료)한 뒤
   *   opener(부모)를 목록으로 새로고침한다. 이때 30여개 파라미터 중 searchItemStatus 만
   *   빈 값으로 와서 상태 필터가 풀린다(실측 확정 — searchShop·pageSize·정렬·날짜는 보존).
   *
   *   ★방침: 쓰기를 재현하지 않는다. 배정은 네이티브가 그대로 수행하고, 확장은
   *     ①부모가 이동하지 못하게 막고 ②바뀐 행만 제자리 갱신한다.
   *   - 팝업을 우리가 열고 핸들로 opener 를 끊는다 → 응답의 부모 새로고침 코드가 그 줄에서
   *     죽는다(부모 무손상). noopener 옵션은 쓰지 않는다 — 차단 감지가 불가능해지기 때문(아래).
   *   - location 가로채기는 스펙상 불가([LegacyUnforgeable]), ISOLATED world 에선
   *     window.opener 가 보이지 않아 팝업→부모 DOM 직접 접근도 불가.
   *     → 창간 신호는 chrome.storage.local + onChanged (이 파일이 이미 쓰는 검증된 경로).
   *   - 신호는 '의도'(팝업에서 재고 클릭 시점)로 먼저 남기고, 실제 성패는 부모가
   *     서버 재조회로 확인한다. 응답 문구 스캔은 이 앱에서 항상 오탐(폼페이지에 검증
   *     alert 이 상시 박혀 있음) — 상태를 다시 읽는 게 유일하게 믿을 수 있는 판정.
   * ========================================================================== */
  const ASG_TAG = '[UB][assign]';
  const asgLog = (...a) => { try { console.log(ASG_TAG, ...a); } catch (_) {} };
  // ★신호 채널 = chrome.storage.local (localStorage + storage 이벤트가 아님).
  //  ISOLATED world content script 가 window 의 storage 이벤트를 받는지는 검증된 바가 없고,
  //  안 오면 이 기능 전체가 예외 하나 없이 조용히 아무 일도 안 한다. 반면 chrome.storage
  //  .onChanged 는 이 파일이 이미 ISOLATED 에서 쓰고 있는(파일 하단 구독) 검증된 경로다.
  //  ⚠ storage 이벤트와 달리 '쓴 컨텍스트에도' 발화하므로, 지우기(newValue 없음)를 걸러야 한다.
  const ASG_KEY = 'ubOrderAssign';
  const ASG_OURS_KEY = 'UB_ORDER_ASSIGN_OURS';   // 팝업 sessionStorage 마커(= 발급받은 nonce)
  // ★nonce: '우리가 연 팝업'과 '이 신호를 소비할 부모'를 동시에 증명한다.
  //  없으면 ①네이티브로 열린 팝업까지 우리 것으로 오인하고(배정취소 흐름 오염)
  //        ②chrome.storage 는 모든 탭에 방송되므로 같은 주문이 보이는 다른 목록 탭들도
  //          제각각 재조회·갱신·토스트를 한다. 발급한 탭만 소비하게 막는다.
  const ASG_NONCE_PARAM = 'ubasg';
  const asgIssued = new Set();   // 이 문서가 발급한 nonce
  const ASG_TTL = 60000;          // 신호 만료
  const ASG_VERIFY_MS = 12000;    // 서버 반영 확인 최대 대기
  const ASG_FETCH_MS = 8000;      // 재조회 1회 타임아웃(무한 대기 방지)
  const ASG_DONE_TTL = 30000;     // 갱신 완료 기억 시간(취소 후 재배정을 막지 않도록 만료시킨다)
  function isOrderJunList() { return /\/jun\/orderitem\/orderItemList\.do/.test(location.pathname); }
  function isAssignPopupForm() { return /\/jun\/orderitem\/orderItemPopCurrentSettingModifyForm\.do/.test(location.pathname); }
  function isAssignModify() { return /\/jun\/orderitem\/orderItemPopCurrentSettingModify\.do/.test(location.pathname); }
  // 팝업 URL 에 실어 보내는 검색 파라미터(네이티브 CONST_URL 과 동일 구성).
  //  CONST_URL 은 페이지(MAIN world) 전역이라 ISOLATED 에서 못 읽는다 → form1 현재값으로 재구성.
  const ASG_SEARCH_FIELDS = [
    'pageSize', 'searchSortType', 'searchOrderType', 'searchBaljuType', 'searchItemType',
    'searchItemStatus', 'searchBranch', 'searchShop', 'searchK', 'searchColor',
    'searchWordType1', 'searchWordType2', 'searchWord1', 'searchWord2', 'searchRegId',
    'searchJunNum', 'searchItemSize', 'searchClientName', 'searchDateType',
    'syear', 'smonth', 'sday', 'eyear', 'emonth', 'eday'
  ];
  // ── 순수 헬퍼(DOM 비의존, 단위테스트 대상) ────────────────────────────────
  //  currentSetting('master','orderSeq','barcode','shop','client','orderDate')
  function parseCurrentSettingArgs(href) {
    const m = String(href == null ? '' : href).match(/currentSetting\s*\(([^)]*)\)/);
    if (!m) return null;
    const p = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
    // 정확히 6개가 아니면 버린다. 인자 안에 콤마가 섞이면 자리가 밀려 엉뚱한 orderDate 가
    //  팝업 URL·검증 쿼리로 흘러가므로, 부분 파싱으로 넘기지 않는다(네이티브로 fail-open).
    if (p.length !== 6) return null;
    return { master: p[0], orderSeq: p[1], barcode: p[2], shop: p[3], client: p[4], orderDate: p[5] };
  }
  // 미배정(=상태 '본사확인') 판정: 3번째 인자 barcode 가 빈 값. 이미 배정된 행은 건드리지 않는다.
  function isUnassigned(a) { return !!a && !!a.orderSeq && String(a.barcode == null ? '' : a.barcode).trim() === ''; }
  function parseSetCurrentBarcode(href) {
    const m = String(href == null ? '' : href).match(/setCurrent\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    return m ? m[1] : '';
  }
  // yyyymmdd → 검색폼 날짜 파라미터(그 하루로 좁혀 대상 행이 반드시 응답에 들어오게 한다)
  function oneDayParams(yyyymmdd) {
    const d = String(yyyymmdd == null ? '' : yyyymmdd).trim();
    if (!/^\d{8}$/.test(d)) return null;
    return { syear: d.slice(0, 4), smonth: d.slice(4, 6), sday: d.slice(6, 8),
             eyear: d.slice(0, 4), emonth: d.slice(4, 6), eday: d.slice(6, 8) };
  }
  // 배정 성공 판정: 상태가 입고완료 + 응답 행의 링크가 실은 바코드가 기대값과 '정확히' 일치.
  //  ⚠ 텍스트 부분일치(indexOf) 금지 — '2604O' 를 기대할 때 '2604O1' 을 성공으로 오인한다.
  //  ⚠ 바코드 없이 '입고완료'만으로 판정하면 같은 Modify.do 를 타는 배정취소(cancelForm)
  //    흐름을 오인해 방금 취소한 행을 '입고완료'로 되칠하고 고착시킨다.
  function assignConfirmed(statusText, observedBarcode, wantBarcode) {
    const t = String(statusText == null ? '' : statusText).replace(/\s+/g, '');
    if (!/입고완료/.test(t)) return false;
    const want = String(wantBarcode == null ? '' : wantBarcode).trim().toUpperCase();
    const got = String(observedBarcode == null ? '' : observedBarcode).trim().toUpperCase();
    if (!want || !got) return false;
    return got === want;
  }
  const asgDoneKey = (orderSeq, barcode) => String(orderSeq) + '|' + String(barcode || '').toUpperCase();
  function asgSignalFresh(sig, now) {
    return !!sig && !!sig.orderSeq && typeof sig.ts === 'number' && (now - sig.ts) <= ASG_TTL;
  }
  // ── 부모: 클릭 가로채기 ───────────────────────────────────────────────────
  function buildAssignPopupUrl(a, nonce) {
    const p = new URLSearchParams();
    p.set('tcode', 'order_item');
    p.set(ASG_NONCE_PARAM, nonce);
    p.set('master', a.master); p.set('orderSeq', a.orderSeq); p.set('barcode', a.barcode);
    p.set('shop', a.shop); p.set('client', a.client); p.set('orderDate', a.orderDate);
    p.set('reqPage', '1');
    const f = document.forms['form1'];
    if (f) ASG_SEARCH_FIELDS.forEach(n => {
      const el = f.elements[n];   // f[n] 은 동명 필드가 있으면 value 가 undefined 라 조용히 누락된다
      if (el && typeof el.value === 'string') p.set(n, el.value);
    });
    return '/jun/orderitem/orderItemPopCurrentSettingModifyForm.do?' + p.toString();
  }
  function bindAssignIntercept() {
    document.addEventListener('click', (e) => {
      let args = null;
      try {
        const a = e.target && e.target.closest ? e.target.closest('a[href*="currentSetting"]') : null;
        if (!a) return;
        args = parseCurrentSettingArgs(a.getAttribute('href'));
        if (!isUnassigned(args)) return;            // 이미 배정된 행 → 네이티브 그대로
        // ⚠ 사전조건은 가로채기 '전에' 전부 검사한다. 가로챈 뒤 실패하면 사용자가
        //   아무것도 못 하게 되므로, 조금이라도 미심쩍으면 네이티브로 흘려보낸다.
        if (!document.forms['form1']) return;
        if (!(window.chrome && chrome.storage && chrome.storage.local)) return;
        var nonce = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        var url = buildAssignPopupUrl(args, nonce);
      } catch (err) { asgLog('사전검사 실패 → 네이티브 진행', err); return; }
      try {
        // ★noopener 를 쓰지 않는다. noopener 면 차단돼도 성공해도 반환값이 항상 null 이라
        //  차단을 감지할 수 없고, 이미 preventDefault 한 뒤라 클릭이 조용히 먹통이 된다
        //  (= 설계 불변식 '차단되면 네이티브로 흘려보낸다'를 구현 자체가 못 지킴).
        //  대신 핸들을 받아 부모가 직접 opener 를 끊는다. 실측 확인: 자식이 보는 opener 는
        //  null 이 되고 다음 페이지로 이동한 뒤에도 유지되어 새로고침 차단 효과는 동일하며,
        //  창 이름(orderitem_win) 재사용도 살아나 클릭마다 창이 쌓이지 않는다.
        const w = window.open(url, 'orderitem_win', 'width=400,height=300,scrollbars=yes,resizable=yes');
        if (!w) { asgLog('팝업 차단됨 → 가로채지 않고 네이티브로 진행'); return; }
        // opener 를 못 끊으면 부모가 그대로 새로고침되어 이 기능의 존재 이유가 사라진다.
        //  '실패해도 일단 가로채기'는 최악 — 사용자는 고쳐진 줄 알고 쓰는데 필터가 계속 풀린다.
        //  끊기 확인에 실패하면 우리가 연 창을 닫고 네이티브에 그대로 넘긴다(창 이름이 같아
        //  네이티브 currentSetting 이 같은 창을 다시 쓴다).
        //  ⚠ 확인은 엄격하게: setter 가 조용히 무시되거나 getter 를 못 읽으면 '못 끊었다'로 본다.
        //   느슨하게 통과시키면 사용자는 고쳐진 줄 알고 쓰는데 필터가 계속 풀린다 — 그게 최악이다.
        //   반대로 과하게 엄격해서 폴백하면 손해는 '기능이 안 걸리는 것'뿐이라 안전한 방향이다.
        let cut = false;
        try { w.opener = null; cut = (w.opener === null); } catch (err) { asgLog('opener 차단/확인 예외', err); }
        if (!cut) {
          asgLog('opener 차단 확인 실패 → 가로채기 취소, 네이티브로 진행');
          try { w.close(); } catch (_) {}
          return;
        }
        asgIssued.add(nonce);
        e.preventDefault();
        e.stopImmediatePropagation();
        asgLog('가로챔 — orderSeq', args.orderSeq, '/ opener 끊고 팝업 오픈, nonce', nonce);
      } catch (err) { asgLog('팝업 오픈 실패 → 네이티브 진행', err); }
    }, true);
  }
  // ── 팝업: 배정 의도/완료 신호 기록 ────────────────────────────────────────
  function writeAssignSignal(orderSeq, barcode, orderDate, phase, diag, nonce) {
    try {
      if (!orderSeq || !nonce) return;
      const sig = { orderSeq: String(orderSeq), barcode: String(barcode || ''),
                    orderDate: String(orderDate || ''), phase: phase, ts: Date.now(),
                    nonce: String(nonce), diag: diag ? String(diag) : '' };
      // set 실패는 비동기라 바깥 try/catch 에 안 잡힌다 → 콜백에서 lastError 를 봐야
      //  '기록됐다고 로그만 남기고 실제로는 유실'되는 경우를 안 놓친다.
      chrome.storage.local.set({ [ASG_KEY]: sig }, () => {
        const e = chrome.runtime && chrome.runtime.lastError;
        if (e) asgLog('신호 기록 실패(비동기)', e.message || e);
        else asgLog('신호', phase, orderSeq, barcode);
      });
    } catch (e) { asgLog('신호 기록 실패', e); }
  }
  function bindAssignPopupForm() {
    // ★nonce 는 '팝업이 처음 열린 순간' 잡아 sessionStorage 에 박아둔다.
    //  클릭 시점의 location.search 에서 읽으면, 사용자가 팝업 안에서 검색하거나 다음 페이지로
    //  넘어간 뒤 고르는 순간 URL 에 ubasg 가 없어 신호가 통째로 끊긴다. 그러면 서버 배정은
    //  됐는데 부모는 opener 도 끊겨 있어 그 행이 영영 '본사확인'으로 남는다(후보가 100건 넘어
    //  페이징이 흔하므로 실사용에서 자주 터진다). sessionStorage 는 창 안 이동에 살아남는다.
    try {
      const urlNonce = new URLSearchParams(location.search).get(ASG_NONCE_PARAM);
      if (urlNonce) sessionStorage.setItem(ASG_OURS_KEY, urlNonce);
    } catch (_) {}
    const hidden = (n) => {
      const el = document.querySelector('input[name="' + n + '"]');
      return el ? el.value : '';
    };
    document.addEventListener('click', (e) => {
      try {
        const a = e.target && e.target.closest ? e.target.closest('a[href*="setCurrent"]') : null;
        if (!a) return;
        const bc = parseSetCurrentBarcode(a.getAttribute('href'));
        if (!bc) return;
        // 부모가 발급한 nonce 가 있을 때만 '우리가 연 팝업'이다(없으면 네이티브로 열린 창).
        //  검색·페이징으로 URL 에서 ubasg 가 빠졌을 수 있으니 보존해 둔 sessionStorage 가 1순위.
        let nonce = '';
        try { nonce = sessionStorage.getItem(ASG_OURS_KEY) || ''; } catch (_) {}
        if (!nonce) { try { nonce = new URLSearchParams(location.search).get(ASG_NONCE_PARAM) || ''; } catch (_) {} }
        if (!nonce) { asgLog('nonce 없는 팝업(네이티브) → 관여 안 함'); return; }
        // preventDefault 하지 않는다 — 배정은 네이티브가 그대로 수행한다.
        writeAssignSignal(hidden('orderSeq'), bc, hidden('orderDate'), 'intent', '', nonce);
      } catch (err) { asgLog('팝업 신호 실패', err); }
    }, true);
  }
  function bindAssignModifyPage() {
    // ★우리가 연 배정 팝업일 때만 관여한다. 이 판정이 없으면 같은 Modify.do 를 타는
    //  배정취소(cancelForm) 흐름까지 삼켜서, 방금 취소한 행을 '입고완료'로 되칠할 수 있다.
    let nonce = '';
    try { nonce = sessionStorage.getItem(ASG_OURS_KEY) || ''; } catch (_) {}
    if (!nonce) { asgLog('우리 팝업이 아님(nonce 없음) → 관여 안 함'); return; }
    try { sessionStorage.removeItem(ASG_OURS_KEY); } catch (_) {}
    const finish = () => {
      try {
        const sp = new URLSearchParams(location.search);
        const bc = sp.get('barcode');
        // ★진단: 이 응답이 부모를 '어떻게' 새로고침하려 했는지 아직 아무도 실물을 본 적이 없다.
        //  설계 전체가 'opener 접근이 첫 줄에서 죽는다'에 걸려 있으므로, opener 를 건드리는
        //  스크립트 원문을 신호에 실어 부모 콘솔([UB][assign])에 남긴다. 창은 곧 닫혀서
        //  여기서 console.log 해봐야 사라진다. 읽기만 하며 동작에는 영향 없음.
        let diag = '';
        try {
          diag = [...document.querySelectorAll('script')].map(s => s.textContent || '')
            .filter(t => /opener/.test(t)).join(' || ').replace(/\s+/g, ' ').slice(0, 600);
        } catch (_) {}
        if (bc) writeAssignSignal(sp.get('orderSeq'), bc, sp.get('orderDate'), 'done', diag, nonce);
        else asgLog('barcode 없는 Modify → 배정이 아님, 신호 생략');
      } catch (e) { asgLog('Modify 신호 실패', e); }
      // opener 를 끊었으므로 네이티브 self.close() 는 앞선 TypeError 로 실행되지 않는다 → 우리가 닫는다.
      setTimeout(() => { try { window.close(); } catch (_) {} }, 400);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', finish);
    else finish();
  }
  // ── 부모: 서버 재조회로 확인 + 그 행만 제자리 갱신 ────────────────────────
  function asgFindRow(orderSeq) {
    const box = [...document.querySelectorAll('input[name=idx]')]
      .find(b => String(b.value || '').split(',')[0].trim() === String(orderSeq));
    return box ? box.closest('tr') : null;
  }
  function asgStatusTd(tr) {
    const link = tr ? tr.querySelector('a[href*="currentSetting"]') : null;
    return link ? link.closest('td') : null;
  }
  function pickStatusCell(doc, orderSeq) {
    const box = [...doc.querySelectorAll('input[name=idx]')]
      .find(b => String(b.value || '').split(',')[0].trim() === String(orderSeq));
    const tr = box ? box.closest('tr') : null;
    const link = tr ? tr.querySelector('a[href*="currentSetting"]') : null;
    const td = link ? link.closest('td') : null;
    if (!td) return null;
    // 관측 바코드는 텍스트가 아니라 링크 인자에서 뽑는다(표시 문구가 바뀌어도 견디고, 정확일치 가능).
    const a = parseCurrentSettingArgs(link.getAttribute('href'));
    return { html: td.innerHTML, text: (td.textContent || '').replace(/\s+/g, ''),
             barcode: a ? a.barcode : '' };
  }
  async function fetchStatusCell(orderSeq, orderDate) {
    const f = document.forms['form1'];
    const p = new URLSearchParams();
    p.set('tcode', 'order_item');
    p.set('reqPage', '1');
    if (f) ASG_SEARCH_FIELDS.forEach(n => {
      const el = f.elements[n];
      if (el && typeof el.value === 'string') p.set(n, el.value);
    });
    p.set('searchItemStatus', '');   // ★ 상태가 바뀌므로 비워야 대상 행이 응답에 들어온다
    // 상태필터를 풀면 결과가 늘어나는데 reqPage=1 고정이라, 대상 행이 2페이지로 밀리면
    //  영원히 못 찾고 12초를 헛돈다. 날짜를 하루로 좁히는 것과 별개로 페이지도 넉넉히.
    p.set('pageSize', '500');
    const d = oneDayParams(orderDate);
    if (d) { p.set('searchDateType', 'a.orderDate'); Object.keys(d).forEach(k => p.set(k, d[k])); }
    const doc = await Promise.race([
      postDoc('/jun/orderitem/orderItemList.do?tcode=order_item', p),
      new Promise((_, rej) => setTimeout(() => rej(new Error('재조회 타임아웃')), ASG_FETCH_MS))
    ]);
    return pickStatusCell(doc, orderSeq);
  }
  function asgToast(msg) {
    const bar = document.getElementById(SIDEBAR_ID);
    if (bar) { try { showToast(bar, msg); return; } catch (_) {} }
    asgLog(msg);
  }
  const asgBusy = new Set();
  const asgDone = new Map();   // orderSeq → 완료시각. 'intent'/'done' 중복 갱신을 막되 영구는 아니다.
  // 완료 기억은 orderSeq 가 아니라 orderSeq+barcode 로. orderSeq 만 쓰면 배정→취소→다른
  //  바코드로 재배정을 30초간 막아버린다(정상 작업인데 화면이 안 바뀜).
  function asgRecentlyDone(seq, barcode) {
    const k = asgDoneKey(seq, barcode), ts = asgDone.get(k);
    if (!ts) return false;
    if (Date.now() - ts > ASG_DONE_TTL) { asgDone.delete(k); return false; }
    return true;
  }
  // 신호가 지워질 때, 그 사이 도착한 '더 새로운' 신호까지 날리지 않도록 ts 를 대조해 지운다.
  function asgClearSignalIfSame(sig) {
    try {
      chrome.storage.local.get(ASG_KEY, (d) => {
        const cur = d && d[ASG_KEY];
        if (cur && cur.ts === sig.ts) chrome.storage.local.remove(ASG_KEY, () => {
          const e = chrome.runtime && chrome.runtime.lastError; if (e) asgLog('신호 삭제 실패', e.message || e);
        });
      });
    } catch (_) {}
  }
  const asgPending = new Map();   // 검증 중 도착한 최신 신호(같은 orderSeq) — 끝나고 이어받는다
  async function verifyAndPatchRow(sig) {
    const key = String(sig.orderSeq);
    // 이미 반영한 배정이면 신호를 남겨두지 않는다(남기면 다음 로드에서 또 소비한다).
    if (asgRecentlyDone(sig.orderSeq, sig.barcode)) { asgClearSignalIfSame(sig); return; }
    // 검증 중 같은 주문이 다른 바코드로 재배정되면 그 신호를 버리지 않고 대기시켰다가 이어서 처리.
    //  ⚠ 콜백 도착 순서 ≠ 신호 생성 순서라, 더 새로운 것만 남긴다.
    if (asgBusy.has(key)) {
      const prev = asgPending.get(key);
      if (!prev || (sig.ts || 0) > (prev.ts || 0)) asgPending.set(key, sig);
      return;
    }
    // ★busy 는 첫 await 앞에서 잡는다. 행 대기(await) 뒤에 잡으면 intent/done 이 둘 다
    //  통과해 같은 주문에 폴링이 두 개 돌고, 오래된 응답이 최신 상태를 덮어쓸 수 있다.
    asgBusy.add(key);
    const deadline = Date.now() + ASG_VERIFY_MS;
    try {
      // 부모가 막 로드된 참이면 표가 아직 안 그려졌을 수 있다 → 바로 포기하지 말고 잠깐 기다린다.
      for (let i = 0; i < 6 && !asgFindRow(sig.orderSeq); i++) await new Promise(r => setTimeout(r, 500));
      if (!asgFindRow(sig.orderSeq)) return;   // 이 문서엔 해당 행이 없음(다른 검색화면) → 종료
      while (Date.now() < deadline) {
        let cell = null;
        try { cell = await fetchStatusCell(sig.orderSeq, sig.orderDate); } catch (err) { asgLog('재조회 실패', err); }
        if (cell && assignConfirmed(cell.text, cell.barcode, sig.barcode)) {
          // ⚠ 행 참조를 루프 밖에서 잡아두면 안 된다 — 폴링 수초 사이에 표가 다시 그려지면
          //   분리된(detached) 노드를 고치고도 성공으로 처리해 화면은 그대로인 사고가 난다.
          //   성공 직전에 다시 찾고 isConnected 까지 확인한 뒤, 실제로 바꾼 경우에만 완료 처리.
          const tr = asgFindRow(sig.orderSeq);
          const td = tr && tr.isConnected ? asgStatusTd(tr) : null;
          if (!td) { asgLog('갱신 대상 행이 사라짐 — 재시도', sig.orderSeq); await new Promise(r => setTimeout(r, 700)); continue; }
          // 서버가 렌더한 셀을 그대로 이식 → 손으로 만든 마크업이 아니라서
          // 이후 그 행에서 다시 링크를 눌러도 네이티브 동작이 그대로 이어진다.
          td.innerHTML = cell.html;
          tr.classList.add('ub-ms-hl');
          asgDone.set(asgDoneKey(sig.orderSeq, sig.barcode), Date.now());
          asgClearSignalIfSame(sig);
          asgLog('제자리 갱신 완료', sig.orderSeq, cell.text);
          asgToast('재고배정 반영: ' + cell.text);
          return;
        }
        await new Promise(r => setTimeout(r, 700));
      }
      asgLog('확인 시간초과 — 서버 반영을 확인하지 못함', sig.orderSeq);
      // 배정 자체는 네이티브가 수행했으므로 '실패'가 아니라 '확인 못 함'이다.
      //  이 기능이 없애려는 행동(새로고침)을 지시하지 않는다.
      asgToast('배정은 됐을 수 있습니다 — 상태만 확인하지 못했습니다');
    } finally {
      asgBusy.delete(key);
      // 검증 중 밀려온 최신 신호가 있으면 이어서 처리한다. 그냥 버리면 그 배정은
      //  화면에 영영 반영되지 않는다(취소 후 다른 바코드로 재배정한 경우).
      const next = asgPending.get(key);
      asgPending.delete(key);
      // 같은 배정의 intent/done 은 하나로 본다. 이미 12초를 폴링했으므로 같은 건을 또 돌리면
      //  검증 시간이 두 배가 되고 실패 토스트가 두 번 뜬다. 다른 바코드일 때만 이어서 처리.
      if (next && asgDoneKey(next.orderSeq, next.barcode) !== asgDoneKey(sig.orderSeq, sig.barcode)) {
        handleAssignSignal(next);
      }
    }
  }
  function handleAssignSignal(sig) {
    try {
      if (!asgSignalFresh(sig, Date.now())) return;
      // 이 문서가 발급한 nonce 만 소비한다. chrome.storage 는 모든 탭에 방송되므로,
      //  이게 없으면 같은 주문이 보이는 다른 목록 탭들도 제각각 재조회·갱신·토스트를 한다.
      if (!sig.nonce || !asgIssued.has(sig.nonce)) return;
      if (sig.diag) asgLog('Modify 응답의 opener 스크립트 원문 →', sig.diag);
      // await 하지 않으므로 rejection 을 반드시 삼킨다(unhandled rejection 방지).
      verifyAndPatchRow(sig).catch(err => asgLog('검증 중 예외', err));
    } catch (err) { asgLog('신호 처리 실패', err); }
  }
  function bindAssignStorage() {
    try {
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local' || !ch[ASG_KEY]) return;
        const sig = ch[ASG_KEY].newValue;
        if (!sig) return;   // 우리가 지운 경우(newValue 없음) — 쓴 컨텍스트에도 발화하므로 필수
        handleAssignSignal(sig);
      });
      // 부모 목록이 아직 로드 중일 때 팝업이 신호를 쓰면 받을 리스너가 없어 유실된다
      //  (값은 남는데 아무도 안 읽음) → 시작 시 남은 신호를 1회 소비한다.
      chrome.storage.local.get(ASG_KEY, (d) => {
        try {
          const sig = d && d[ASG_KEY];
          if (!sig) return;
          // 만료분은 청소한다 — 안 지우면 진단 문자열(응답 스크립트 원문)이 계속 남는다.
          if (!asgSignalFresh(sig, Date.now())) { chrome.storage.local.remove(ASG_KEY); return; }
          handleAssignSignal(sig);
        } catch (_) {}
      });
    } catch (e) { asgLog('storage 구독 실패', e); }
  }
  function initAssign() {
    // 페이지 동작을 바꾸는 다른 기능들과 같은 게이트. 이 기능은 그 중 유일하게 쓰기 흐름을
    //  가로채므로, 현장에서 오작동해도 팝업 토글로 끌 수 있어야 한다(확장은 다운그레이드 불가).
    if (!state.ubSkin) return;
    try {
      if (isOrderJunList()) { bindAssignIntercept(); bindAssignStorage(); }
      else if (isAssignModify()) bindAssignModifyPage();
      else if (isAssignPopupForm()) bindAssignPopupForm();
    } catch (e) { asgLog('초기화 실패', e); }
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
      position: fixed; top: 0; left: 0; height: 100vh; width: var(--ub-sb-w, 256px);
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
    html.ub-sidebar-docked body { margin-left: var(--ub-sb-w, 256px) !important; }
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

    /* 커스텀 날짜 — 그리드 밖 별도 블록 */
    .ub-sidebar .ub-sb-custom { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
    .ub-sidebar .ub-sb-custom-row { display: flex; align-items: center; gap: 6px; }
    .ub-sidebar .ub-sb-custom-sep { font-size: 11px; color: var(--ub-sub); flex: none; }
    .ub-sidebar .ub-sb-date {
      flex: 1 1 0; min-width: 0; padding: 7px 6px; border: 1px solid var(--ub-line);
      background: var(--ub-bg); border-radius: 8px; font-family: 'Pretendard','Malgun Gothic',sans-serif;
      font-size: 11px; font-weight: 600; color: var(--ub-fg);
    }
    .ub-sidebar .ub-sb-date:focus { outline: none; border-color: var(--ub-on); }

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

    /* 상품 재고화 (inputItemWriteForm) */
    .ub-sidebar .ub-stk-row { display: flex; gap: 6px; }
    .ub-sidebar .ub-stk-in {
      flex: 1 1 0; min-width: 0; padding: 8px 8px; border: 1px solid var(--ub-line);
      background: var(--ub-bg); border-radius: 8px;
      font-family: 'Pretendard','Malgun Gothic',sans-serif;
      font-size: 12px; font-weight: 600; letter-spacing: .02em; color: var(--ub-fg);
    }
    .ub-sidebar .ub-stk-in:focus { outline: none; border-color: var(--ub-on); }
    .ub-sidebar .ub-stk-in::placeholder { color: var(--ub-sub); font-weight: 500; letter-spacing: 0; }
    .ub-sidebar .ub-sb-btn.ub-stk-go { flex: none; padding: 10px 12px; }
    .ub-sidebar .ub-stk-st {
      margin-top: 7px; font-size: 11px; font-weight: 600; min-height: 14px;
      line-height: 1.4; color: var(--ub-sub);
    }
    .ub-sidebar .ub-stk-st.go { color: var(--ub-on); }
    .ub-sidebar .ub-stk-st.ok { color: #12995a; }
    .ub-sidebar .ub-stk-st.err { color: #e0483f; }
    .ub-sidebar .ub-stk-st.warn { color: #c77a12; }

    /* 회전입고 (rotateItemWriteForm) — 새매장 select + 재고화 input 톤 재사용 */
    .ub-sidebar .ub-rot-shop-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
    .ub-sidebar .ub-rot-lb { font-size: 11px; color: var(--ub-sub); flex: none; }
    .ub-sidebar .ub-rot-shop {
      flex: 1 1 0; min-width: 0; padding: 7px 6px; border: 1px solid var(--ub-line);
      background: var(--ub-bg); border-radius: 8px;
      font-family: 'Pretendard','Malgun Gothic',sans-serif;
      font-size: 11px; font-weight: 600; color: var(--ub-fg);
    }
    .ub-sidebar .ub-rot-shop:focus { outline: none; border-color: var(--ub-on); }

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

    /* 리사이즈 핸들 + 잠금 */
    .ub-sidebar .ub-sb-rz-x {
      position: absolute; right: 0; top: 0; width: 6px; height: 100%;
      cursor: ew-resize; z-index: 3;
    }
    .ub-sidebar .ub-sb-rz-x:hover { background: var(--ub-on-soft); }
    .ub-sidebar .ub-sb-rz {
      position: absolute; right: 2px; bottom: 2px; width: 16px; height: 16px;
      cursor: nwse-resize; z-index: 3;
      background: linear-gradient(135deg, transparent 46%, var(--ub-line) 46%, var(--ub-line) 56%, transparent 56%, transparent 68%, var(--ub-line) 68%, var(--ub-line) 78%, transparent 78%);
    }
    .ub-sidebar.ub-mode-docked .ub-sb-rz { display: none; }
    .ub-sidebar.ub-mode-floating .ub-sb-rz-x { display: none; }
    .ub-sidebar.ub-locked .ub-sb-rz, .ub-sidebar.ub-locked .ub-sb-rz-x { display: none; }
    .ub-sidebar.ub-locked.ub-mode-floating .ub-sb-hd { cursor: default; }
    .ub-sidebar .ub-ico.ub-on { color: var(--ub-on); border-color: var(--ub-on); background: var(--ub-on-soft); }

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

    /* 메인석 입고 — 로드된 전표에서 찾은 바코드 행 강조(언스코프: 페이지 표 대상, D102 틸) */
    tr.ub-ms-hl > td {
      background: rgba(74,188,199,.16) !important;
      border-top: 1px solid #4abcc7 !important;
      border-bottom: 1px solid #4abcc7 !important;
    }
    tr.ub-ms-hl > td:first-child { box-shadow: inset 4px 0 0 0 #4abcc7; }
    tr.ub-ms-hl { animation: ubMsHl .85s ease-in-out 3; }
    @keyframes ubMsHl {
      0%, 100% { outline: 2px solid rgba(74,188,199,.15); outline-offset: -2px; }
      50%      { outline: 3px solid rgba(74,188,199,.95); outline-offset: -3px; }
    }
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
  // 크기 적용: docked=너비만(CSS 변수 --ub-sb-w 로 body margin 과 동기), floating=너비+높이.
  function applySbSize(bar) {
    const w = Math.min(Math.max(200, state.ubSbWidth | 0), 480);
    if (state.ubSbMode === 'floating') {
      const h = Math.max(160, state.ubSbHeight | 0);
      bar.style.width = w + 'px';
      bar.style.height = h + 'px';
    } else {
      bar.style.width = ''; bar.style.height = '';   // 인라인 사이즈 해제 → CSS 변수 사용
      document.documentElement.style.setProperty('--ub-sb-w', w + 'px');
    }
  }
  function bindDrag(bar) {
    const hd = bar.querySelector('.ub-sb-hd');
    if (!hd) return;
    let dragging = false, ox = 0, oy = 0;
    hd.addEventListener('mousedown', (e) => {
      if (state.ubSbLocked) return;               // 잠금 시 이동 X
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
  // 리사이즈: docked=오른쪽 세로 핸들(너비), floating=우하단 코너 그립(너비+높이). 잠금 시 무시.
  function bindResize(bar) {
    const hx = bar.querySelector('.ub-sb-rz-x');   // docked 너비 핸들
    if (hx) hx.addEventListener('mousedown', (e) => {
      if (state.ubSbLocked || state.ubSbMode !== 'docked') return;
      e.preventDefault(); e.stopPropagation();
      const startX = e.clientX, startW = bar.getBoundingClientRect().width;
      const mv = (ev) => {
        const w = Math.min(Math.max(200, startW + (ev.clientX - startX)), 480);
        document.documentElement.style.setProperty('--ub-sb-w', w + 'px');
        state.ubSbWidth = w;
      };
      const up = () => {
        window.removeEventListener('mousemove', mv);
        window.removeEventListener('mouseup', up);
        try { chrome.storage.local.set({ ubSbWidth: state.ubSbWidth }); } catch (_) {}
      };
      window.addEventListener('mousemove', mv);
      window.addEventListener('mouseup', up);
    });
    const rz = bar.querySelector('.ub-sb-rz');     // floating 코너 그립
    if (rz) rz.addEventListener('mousedown', (e) => {
      if (state.ubSbLocked || state.ubSbMode !== 'floating') return;
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY;
      const r = bar.getBoundingClientRect(), ow = r.width, oh = r.height;
      const mv = (ev) => {
        const w = Math.min(Math.max(200, ow + (ev.clientX - sx)), 480);
        const h = Math.max(160, oh + (ev.clientY - sy));
        bar.style.width = w + 'px'; bar.style.height = h + 'px';
        state.ubSbWidth = w; state.ubSbHeight = h;
      };
      const up = () => {
        window.removeEventListener('mousemove', mv);
        window.removeEventListener('mouseup', up);
        try { chrome.storage.local.set({ ubSbWidth: state.ubSbWidth, ubSbHeight: state.ubSbHeight }); } catch (_) {}
      };
      window.addEventListener('mousemove', mv);
      window.addEventListener('mouseup', up);
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
    play:         '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
    lock:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    unlock:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V6a4 4 0 0 1 7.5-2"/></svg>'
  };

  /* 전표 자동 캐시 섹션 — 자동 작동 안내 + 세션 통계 */
  function renderCacheSection() {
    const page = currentCachePage();
    if (!page) return '';
    const active = on('ubAutoSync');
    const s = cacheStat;
    const total = s.hits + s.miss;
    const rate = total ? Math.round(s.hits / total * 100) : 0;
    const savedTxt = s.savedMs > 60000 ? `${(s.savedMs/60000).toFixed(1)}분` : `${(s.savedMs/1000).toFixed(1)}초`;
    const body = active ? `
      <div class="ub-sb-empty" style="text-align:left;font-size:11px;line-height:1.6;background:transparent;border:none;padding:6px 4px">
        평소처럼 검색하면 결과를 자동 캐시.<br>
        <b style="color:var(--ub-on)">같은 검색은 즉시 표시</b>됩니다.
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px;margin-top:6px">
        <div style="padding:8px;background:var(--ub-soft);border-radius:6px"><div style="color:var(--ub-sub);font-size:10px">이번 세션 hit</div><div style="font-weight:700;color:var(--ub-on)">${s.hits} / ${total}</div></div>
        <div style="padding:8px;background:var(--ub-soft);border-radius:6px"><div style="color:var(--ub-sub);font-size:10px">적중률</div><div style="font-weight:700">${rate}%</div></div>
        <div style="padding:8px;background:var(--ub-soft);border-radius:6px;grid-column:1 / -1"><div style="color:var(--ub-sub);font-size:10px">절약 시간(백그라운드 갱신)</div><div style="font-weight:700">${savedTxt}</div></div>
      </div>
    ` : `
      <div class="ub-sb-empty">popup에서 "전표 자동 캐시"<br>토글을 켜야 작동합니다.</div>
    `;
    return `
      <div class="ub-sb-sect">
        <div class="ub-sb-sect-t">${ICONS.database}<span>전표 자동 캐시 · ${page.label}</span></div>
        ${body}
      </div>
    `;
  }

  // 현재 페이지의 날짜 범위 추출 — URL params 우선, 없으면 form select fallback.
  function urlDateRange() {
    const u = new URL(location.href), sp = u.searchParams;
    let sy = sp.get('syear'), sm = sp.get('smonth'), sd = sp.get('sday');
    let ey = sp.get('eyear'), em = sp.get('emonth'), ed = sp.get('eday');
    // form fallback: 메뉴 첫 진입(URL 파라미터 없음)에도 form select default로 동작
    if (!sy || !sm || !sd || !ey || !em || !ed) {
      const get = n => {
        const el = document.querySelector(`select[name="${n}"], input[name="${n}"]`);
        return el ? el.value : '';
      };
      sy = sy || get('syear'); sm = sm || get('smonth'); sd = sd || get('sday');
      ey = ey || get('eyear'); em = em || get('emonth'); ed = ed || get('eday');
    }
    if (!sy || !sm || !sd || !ey || !em || !ed) return null;
    return { s: `${sy}-${sm.padStart(2,'0')}-${sd.padStart(2,'0')}`, e: `${ey}-${em.padStart(2,'0')}-${ed.padStart(2,'0')}` };
  }
  function startCacheJob() {
    const page = currentCachePage();
    if (!page || cacheJob.running) return;
    const range = urlDateRange();
    if (!range) {
      cacheJob.lastResult = { ok: false, error: '날짜 범위를 찾을 수 없음 (URL/form 둘 다 비어있음)' };
      renderSidebar();
      return;
    }
    console.log('[UB][cache] start', { page: page.path, range });
    cacheJob.running = true; cacheJob.current = 0; cacheJob.total = 0; cacheJob.date = ''; cacheJob.startMs = Date.now(); cacheJob.lastResult = null;
    renderSidebar();
    chrome.runtime.sendMessage({
      source: 'ub', type: 'cacheSearch',
      path: page.path, url: location.href,
      startDate: range.s, endDate: range.e, chunkDays: 1
    }, (resp) => {
      console.log('[UB][cache] done', resp, chrome.runtime.lastError);
      cacheJob.running = false;
      if (chrome.runtime.lastError) {
        cacheJob.lastResult = { ok: false, error: 'background 메시지 실패: ' + chrome.runtime.lastError.message };
      } else {
        cacheJob.lastResult = resp || { ok: false, error: '빈 응답 (background 미응답)' };
      }
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
    bar.className = 'ub-sidebar ub-mode-' + (state.ubSbMode === 'floating' ? 'floating' : 'docked')
      + (state.ubSbLocked ? ' ub-locked' : '');

    const isFloat = state.ubSbMode === 'floating';
    const dateBtns = isDateSearchPage();
    const codes = Array.isArray(state.ubBarcodes) ? state.ubBarcodes : [];
    const modeIcon  = isFloat ? ICONS.panelLeft : ICONS.move;
    const modeTitle = isFloat ? '왼쪽으로 붙이기' : '플로팅 모드로';
    let savedCustom = null;
    try { savedCustom = JSON.parse(localStorage.getItem('UB_CUSTOM_DATE_v1')); } catch (_) {}

    bar.innerHTML = `
      <div class="ub-sb-hd">
        <div class="ub-sb-brand">D</div>
        <div class="ub-sb-title">D102 도구</div>
        <div class="ub-sb-actions">
          <button class="ub-ico${state.ubSbLocked ? ' ub-on' : ''}" data-act="lock" title="${state.ubSbLocked ? '잠금 해제' : '크기·위치 잠금'}">${state.ubSbLocked ? ICONS.lock : ICONS.unlock}</button>
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
            <button class="ub-sb-btn" data-r="m1">30일간</button>
            <button class="ub-sb-btn" data-r="pm">전 달</button>
            <button class="ub-sb-btn" data-r="y1">일 년</button>
            <button class="ub-sb-btn" data-r="origin">태초</button>
          </div>
          <div class="ub-sb-custom">
            <div class="ub-sb-custom-row">
              <input type="date" class="ub-sb-date" id="ub-sb-cs" value="${savedCustom && savedCustom.s ? savedCustom.s : ''}">
              <span class="ub-sb-custom-sep">~</span>
              <input type="date" class="ub-sb-date" id="ub-sb-ce" value="${savedCustom && savedCustom.e ? savedCustom.e : ''}">
            </div>
            <button class="ub-sb-btn ub-sb-wide" data-act="custom-apply">커스텀 적용</button>
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

      ${isInboundWrite() ? `
        <div class="ub-sb-sect">
          <div class="ub-sb-sect-t">${ICONS.barcode}<span>상품 재고화</span></div>
          <div class="ub-stk-row">
            <input id="ub-stk-in" class="ub-stk-in" placeholder="바코드 입력 후 Enter" autocomplete="off" spellcheck="false">
            <button class="ub-sb-btn ub-stk-go" id="ub-stk-go">재고화</button>
          </div>
          <div class="ub-stk-st" id="ub-stk-st"></div>
        </div>
      ` : ''}

      ${isRotateWrite() ? `
        <div class="ub-sb-sect">
          <div class="ub-sb-sect-t">${ICONS.barcode}<span>회전입고 자동화</span></div>
          <div class="ub-rot-shop-row">
            <span class="ub-rot-lb">새매장</span>
            <select id="ub-rot-shop" class="ub-rot-shop">
              ${ROT_SHOPS.map(o => `<option value="${o.v}">${o.t}</option>`).join('')}
            </select>
          </div>
          <div class="ub-stk-row">
            <input id="ub-rot-in" class="ub-stk-in" placeholder="바코드 입력 후 Enter" autocomplete="off" spellcheck="false">
            <button class="ub-sb-btn ub-stk-go" id="ub-rot-go">회전입고</button>
          </div>
          <div class="ub-stk-st" id="ub-rot-st"></div>
        </div>
      ` : ''}

      ${isMainStoneWrite() ? `
        <div class="ub-sb-sect">
          <div class="ub-sb-sect-t">${ICONS.barcode}<span>메인석 입고</span></div>
          <div class="ub-stk-row">
            <input id="ub-ms-in" class="ub-stk-in" placeholder="바코드 입력 후 Enter" autocomplete="off" spellcheck="false">
            <button class="ub-sb-btn ub-stk-go" id="ub-ms-go">입고장 로드</button>
          </div>
          <div class="ub-stk-st" id="ub-ms-st"></div>
        </div>
      ` : ''}

      ${renderCacheSection()}

      <div class="ub-sb-rz-x" title="너비 조절 (드래그)"></div>
      <div class="ub-sb-rz" title="크기 조절 (드래그)"></div>
    `;

    // 위치 / 크기 적용
    applySbPosition(bar);
    applySbSize(bar);
    // 드래그 / 리사이즈
    bindDrag(bar);
    bindResize(bar);

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
      } else if (act === 'lock') {
        state.ubSbLocked = !state.ubSbLocked;
        try { chrome.storage.local.set({ ubSbLocked: state.ubSbLocked }); } catch (_) {}
        renderSidebar();
      }
    }));

    // 날짜 버튼 — select 값만 변경
    bar.querySelectorAll('[data-r]').forEach(b => b.addEventListener('click', () => {
      const n = setDateSelects(b.dataset.r);
      showToast(bar, n ? '날짜 변경됨 (' + n + '개 필드)' : '날짜 필드를 찾지 못함');
    }));

    // 커스텀 날짜 적용 — [data-r] 핸들러와 분리된 별도 리스너.
    const customApplyBtn = bar.querySelector('[data-act="custom-apply"]');
    if (customApplyBtn) customApplyBtn.addEventListener('click', () => {
      const csEl = bar.querySelector('#ub-sb-cs'), ceEl = bar.querySelector('#ub-sb-ce');
      let sVal = csEl ? csEl.value : '', eVal = ceEl ? ceEl.value : '';
      if (!sVal || !eVal) { showToast(bar, '시작/종료 날짜를 모두 입력하세요'); return; }
      if (sVal > eVal) { const t = sVal; sVal = eVal; eVal = t; }
      const [sy, sm, sd] = sVal.split('-').map(Number);
      const [ey, em, ed] = eVal.split('-').map(Number);
      const customRange = { s: { y: sy, m: sm, d: sd }, e: { y: ey, m: em, d: ed } };
      const n = setDateSelects('custom', customRange);
      try { localStorage.setItem('UB_CUSTOM_DATE_v1', JSON.stringify({ s: sVal, e: eVal })); } catch (_) {}
      showToast(bar, n ? '날짜 변경됨 (' + n + '개 필드)' : '날짜 필드를 찾지 못함');
    });

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

    // 상품 재고화 배선 (inputItemWriteForm.do) — 재렌더마다 재바인딩되니 정상.
    const stkIn = bar.querySelector('#ub-stk-in');
    const stkStEl = bar.querySelector('#ub-stk-st');
    if (stkIn && stkStEl) {
      const setStkStatus = (t, k) => { stkStEl.textContent = t || ''; stkStEl.className = 'ub-stk-st' + (k ? ' ' + k : ''); };
      const goStk = () => run(stkIn.value, setStkStatus);
      const stkGoBtn = bar.querySelector('#ub-stk-go');
      if (stkGoBtn) stkGoBtn.addEventListener('click', goStk);
      stkIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goStk(); } });
      try {
        const last = JSON.parse(localStorage.getItem('UB_STOCK_LAST') || 'null');
        if (last && last.junNum) setStkStatus('직전: ' + last.barcode + ' → 입고장 ' + last.junNum + ' 불러옴 ✓', 'ok');
      } catch (_) {}
      setTimeout(() => { try { stkIn.focus(); } catch (_) {} }, 400);
    }

    // 회전입고 배선 (rotateItemWriteForm.do) — 재렌더마다 재바인딩되니 정상.
    const rotIn = bar.querySelector('#ub-rot-in');
    const rotStEl = bar.querySelector('#ub-rot-st');
    const rotShopSel = bar.querySelector('#ub-rot-shop');
    if (rotIn && rotStEl && rotShopSel) {
      const setRotStatus = (t, k) => { rotStEl.textContent = t || ''; rotStEl.className = 'ub-stk-st' + (k ? ' ' + k : ''); };
      // 새매장 기본값 = localStorage(UB_ROTATE_SHOP) || '00'(D102본사)
      let savedShop = '00';
      try { savedShop = localStorage.getItem('UB_ROTATE_SHOP') || '00'; } catch (_) {}
      if ([...rotShopSel.options].some(o => o.value === savedShop)) rotShopSel.value = savedShop;
      rotShopSel.addEventListener('change', () => {
        try { localStorage.setItem('UB_ROTATE_SHOP', rotShopSel.value); } catch (_) {}
      });
      const goRot = () => rotateRun(rotIn.value, rotShopSel.value, setRotStatus);
      const rotGoBtn = bar.querySelector('#ub-rot-go');
      if (rotGoBtn) rotGoBtn.addEventListener('click', goRot);
      rotIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goRot(); } });
      try {
        const last = JSON.parse(localStorage.getItem('UB_ROTATE_LAST') || 'null');
        if (last && last.barcode) setRotStatus('직전: ' + last.barcode + ' → ' + rotShopName(last.shop) + ' 회전입고 실행됨', 'ok');
      } catch (_) {}
      setTimeout(() => { try { rotIn.focus(); } catch (_) {} }, 400);
    }

    // 메인석 입고 배선 (inputStoneWriteForm.do) — 재렌더마다 재바인딩되니 정상.
    const msIn = bar.querySelector('#ub-ms-in');
    const msStEl = bar.querySelector('#ub-ms-st');
    if (msIn && msStEl) {
      const setMsStatus = (t, k) => { msStEl.textContent = t || ''; msStEl.className = 'ub-stk-st' + (k ? ' ' + k : ''); };
      const goMs = () => msRun(msIn.value, setMsStatus);
      const msGoBtn = bar.querySelector('#ub-ms-go');
      if (msGoBtn) msGoBtn.addEventListener('click', goMs);
      msIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goMs(); } });
      try {
        const last = JSON.parse(localStorage.getItem('UB_MAINSTONE_LAST') || 'null');
        if (last && last.junNum) setMsStatus('직전: ' + last.barcode + ' → 입고장 ' + last.junNum + ' 불러옴 ✓', 'ok');
      } catch (_) {}
      setTimeout(() => { try { msIn.focus(); } catch (_) {} }, 400);
    }

    // (cache-run/cancel 핸들러는 Phase 2 본격 구현 시 form submit 가로채기로 대체됨)
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
    ubHighlightPending();   // 재고화·회전입고·메인석: 로드 후 검색 바코드 행 강조+스크롤
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
      if (needThumb) { bindThumbEdit(document); ubHighlightPending(); }   // idx 행 동적렌더 시 강조 재시도
      if (needPaging) injectPageSizeOptions();
      if (!document.getElementById(SIDEBAR_ID) && !document.getElementById(HANDLE_ID) && on('ubSidebar')) needSidebar = true;
      if (needSidebar) renderSidebar();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
  /* ==========================================================================
   *  페이지별 커서 자동 포커스 + 한/영 표시 아이콘 (v3.1.13) — 유비샵 도구 상시기능
   *   · 주문전표(orderItemList)              → 고객명 입력에 포커스
   *   · 발주전표(baljuItemJunList)           → 매입처명 입력에 포커스
   *   · 상품입고장 검색(inputItemJunList)    → 입고장번호 입력에 포커스
   *  타이틀이 이미지라 URL(pathname) 기반으로 판별.
   *  ⚠ 브라우저 정책상 IME(한/영) 상태를 JS로 강제할 수 없음 → 대신 입력칸 옆에
   *    한/영 상태 아이콘을 붙이고, 실제 타이핑(조합 이벤트)으로 한/영을 감지해
   *    live 로 아이콘을 갱신한다. 사용자가 아이콘 보고 한/영 키로 맞추면 됨.
   * ========================================================================== */
  const AUTO_FOCUS_PAGES = {
    '/jun/orderitem/orderItemList.do':    ['고객명'],
    '/jun/baljuitem/baljuItemJunList.do': ['매입처명', '매입처'],
    '/jun/inputitem/inputItemJunList.do': ['입고장번호']
  };
  // 특정 페이지에서 자동으로 채워지는 필드를 강제 공란 처리(로드 직후 여러 번 재확인).
  //  · 상품입고장 검색 팝업: 입고담당자(searchRegId=쇼핑몰01 자동주입)를 항상 비움.
  const CLEAR_FIELDS_PAGES = {
    '/jun/inputitem/inputItemJunList.do': { names: ['searchRegId'], labels: ['입고담당자'] }
  };
  function clearForcedFields() {
    try {
      if (!state.ubSkin) return;
      const cfg = CLEAR_FIELDS_PAGES[location.pathname];
      if (!cfg) return;
      const clearOnce = () => {
        let done = false;
        (cfg.names || []).forEach(nm => {
          const el = document.querySelector('input[name="' + nm + '"]');
          if (el && el.value) { el.value = ''; try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {} done = true; }
        });
        if (!done) {
          const el = findLabeledInput(cfg.labels || []);   // name 못 찾을 때 라벨 폴백
          if (el && el.value) { el.value = ''; try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {} }
        }
      };
      clearOnce();
      [150, 450, 900].forEach(ms => setTimeout(clearOnce, ms));   // 페이지 자동채움 이후 재확인
    } catch (_) {}
  }
  function focusableInputs() {
    return [...document.querySelectorAll('input[type="text"], input:not([type])')]
      .filter(el => el.offsetParent !== null && !el.disabled && !el.readOnly);
  }
  function labelMatch(t, L) {
    return t === L || t === L + ':' || t === L + '：' || t.replace(/[:：\s]/g, '') === L;
  }
  function findLabeledInput(labels) {
    const inputs = focusableInputs();   // 문서 순서(querySelectorAll)
    if (!inputs.length) return null;
    // 1) <label for> 정확 매칭 우선
    for (const lab of document.querySelectorAll('label[for]')) {
      const txt = (lab.textContent || '').replace(/\s+/g, '');
      if (labels.some(L => labelMatch(txt, L))) {
        const el = document.getElementById(lab.getAttribute('for'));
        if (el && inputs.includes(el)) return el;
      }
    }
    // 2) 라벨 텍스트 노드를 찾고 → 문서 순서상 그 라벨 "다음"에 오는 첫 input.
    //    (주문전표: 발주처명 select 는 고객명 라벨보다 앞에 있으므로 자연히 스킵됨)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    const labelEls = [];
    while ((node = walker.nextNode())) {
      const t = (node.nodeValue || '').replace(/\s+/g, '');
      if (t && labels.some(L => labelMatch(t, L))) labelEls.push(node.parentElement);
    }
    for (const le of labelEls) {
      if (!le) continue;
      for (const inp of inputs) {
        // 라벨 요소보다 문서상 뒤(FOLLOWING)에 있는 첫 input
        if (le.compareDocumentPosition(inp) & Node.DOCUMENT_POSITION_FOLLOWING) return inp;
      }
    }
    return null;
  }

  /* 한/영 상태 아이콘: 입력칸 바로 뒤에 pill 삽입. 조합(composition) 이벤트로 한글,
   * ASCII 알파벳 직접입력으로 영문 감지 → live 갱신. 초기값은 '한'(대상칸 기대 모드). */
  function attachImeIndicator(input) {
    if (!input || input.dataset.ubImeBound) return;
    input.dataset.ubImeBound = '1';
    const pill = document.createElement('span');
    pill.className = 'ub-ime-pill';
    pill.style.cssText = 'display:inline-block;min-width:20px;height:18px;line-height:18px;'
      + 'padding:0 6px;margin-left:6px;border-radius:9px;font:700 11px/18px Pretendard,sans-serif;'
      + 'text-align:center;color:#fff;vertical-align:middle;user-select:none;'
      + 'box-shadow:0 1px 2px rgba(0,0,0,.2);transition:background .12s;';
    const setLang = (lang) => {
      if (lang === 'ko') { pill.textContent = '한'; pill.style.background = '#2563eb'; pill.title = '한글 입력 상태'; }
      else               { pill.textContent = '영'; pill.style.background = '#dc2626'; pill.title = '영문 입력 상태 — 한/영 키를 누르세요'; }
      pill.dataset.lang = lang;
    };
    setLang('ko');   // 이 칸은 한글 입력이 기대값 → 기본 '한'(첫 영문 입력 시 '영'으로 정정)
    // 입력칸 바로 뒤에 삽입
    if (input.parentNode) input.parentNode.insertBefore(pill, input.nextSibling);
    // 감지
    input.addEventListener('compositionstart', () => setLang('ko'));
    input.addEventListener('input', (e) => {
      // 조합 중이 아니고, 방금 삽입된 글자가 ASCII 알파벳이면 영문 모드
      if (!e.isComposing && e.inputType === 'insertText' && e.data && /^[A-Za-z]$/.test(e.data)) setLang('en');
    });
    // keydown 백업: 조합 이벤트 미지원 브라우저 대비(한글 자모 keyCode 229 → 한)
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) setLang('ko');
    });
    return pill;
  }

  function autoFocusByPage() {
    try {
      if (!state.ubSkin) return;   // 유비샵 도구(스킨) 켜져 있을 때만
      const labels = AUTO_FOCUS_PAGES[location.pathname];
      if (!labels) return;         // 대상 페이지(주문/발주/입고 전표) 아님
      let logged = false;
      // 페이지 자체가 다른 검색칸(발주처명 등)에 기본 포커스를 주므로, 그걸 이기려고
      // 여러 시점에 재확인하며 대상칸으로 커서를 되돌린다(단, 값 있는 칸은 안 훔침).
      const pass = () => {
        const el = findLabeledInput(labels);
        if (!el) return false;
        attachImeIndicator(el);
        const ae = document.activeElement;
        // 사용자가 값 입력 중인 다른 칸이면 커서 안 훔침(빈 칸=페이지 기본포커스는 교정 대상)
        const userTyping = ae && ae.tagName === 'INPUT' && ae !== el && ae.value && ae.value.trim();
        if (!userTyping && !(el.value && el.value.trim()) && ae !== el) {
          el.focus();
          try { const n = el.value.length; el.setSelectionRange(n, n); } catch (_) {}
        }
        try { el.setAttribute('lang', 'ko'); } catch (_) {}
        if (!logged) { console.log('[UB][skin] auto-focus →', labels[0], '/', el.name || el.id || '(anon)'); logged = true; }
        return true;
      };
      // 즉시 + 페이지 onload focus 이후(150·450·900ms) 재확인
      let found = pass();
      [150, 450, 900, 1400].forEach(ms => setTimeout(() => {
        if (!pass() && !found && ms === 1400) {
          console.log('[UB][skin] auto-focus 대상 입력 못 찾음', { labels, path: location.pathname, inputs: focusableInputs().length });
        }
      }, ms));
    } catch (e) { console.warn('[UB][skin] auto-focus 실패', e); }
  }

  /* ==========================================================================
   *  상품집계(sheetStatisList) 수량 정렬 (v3.1.17) — 전체 데이터 기준(월단위 통계)
   *  기존 정렬은 '상품코드순'(서버) 하나뿐. select[name="searchSortType"] 옆에
   *  수량 적은순↑/많은순↓/기본 드롭다운 추가.
   *  ★전체 데이터 정렬: 현재 페이지 행만이 아니라, form1(POST)을 큰 pageSize(500)로
   *    재조회해 전체 결과를 받아온 뒤 정렬한다(500 초과면 reqPage 순차 병합).
   *    한 번 받은 전체 세트는 검색조건 키로 캐싱 → 정렬 방향만 바꿀 땐 재조회 없음.
   *  실측 구조(사용자 콘솔): form1 method=POST, action=/statis/sheet/saleitem/
   *    sheetStatisList.do, 결과 table.t_list, 헤더에 '수량' 컬럼, 데이터행=헤더
   *    이후+첫 셀 숫자(No), 각 상품 1행, 합계행은 별도 테이블, '총 N 개' 표기,
   *    pageSize 옵션 20/30/50/100/300/500.
   * ========================================================================== */
  const QTY_SORT_RE = /\/statis\/sheet\/(saleitem|orderitem)\/sheetStatisList\.do/;
  const QTY_FETCH_PS = 500;                          // 서버 지원 최대 옵션
  function numVal(s) {
    const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  }
  // 문서(현재 or 파싱본)에서 수량 헤더가 있는 t_list 와 데이터행 추출
  function findStatisGridIn(root) {
    for (const t of root.querySelectorAll('table.t_list')) {
      for (const r of t.rows) {
        const idx = [...r.cells].findIndex(c => c.textContent.replace(/\s+/g, '') === '수량');
        if (idx >= 0) {
          const rows = [...t.rows].filter(rr =>
            rr.rowIndex > r.rowIndex && rr.cells.length > idx &&
            /^\d+$/.test(rr.cells[0].textContent.replace(/\s+/g, '')));
          return { table: t, headerRowIndex: r.rowIndex, qtyCol: idx, rows };
        }
      }
    }
    return null;
  }
  function statisFormParams() {
    const sortSel = document.querySelector('select[name="searchSortType"]');
    const form = sortSel && sortSel.form;
    if (!form) return null;
    const params = new URLSearchParams();
    for (const el of form.elements) {
      if (!el.name) continue;
      const t = (el.type || '').toLowerCase();
      if (['submit', 'button', 'reset', 'image', 'file'].includes(t)) continue;
      if ((t === 'checkbox' || t === 'radio') && !el.checked) continue;
      params.append(el.name, el.value == null ? '' : el.value);
    }
    return { form, action: form.getAttribute('action') || location.pathname, params };
  }
  async function fetchStatisHtml(action, params) {
    const r = await fetch(action, {
      method: 'POST', credentials: 'include', cache: 'no-cache',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: params.toString()
    });
    const buf = await r.arrayBuffer();
    let html = '';
    try {
      html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      if ((html.match(/�/g) || []).length > 20) html = new TextDecoder('euc-kr').decode(buf);
    } catch (_) { try { html = new TextDecoder('euc-kr').decode(buf); } catch (__) {} }
    return html;
  }
  function readTotal() {
    const m = document.body.innerText.match(/총\s*:?\s*([0-9,]+)\s*개/);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  }
  // 전체 결과 행(현재 문서에 import된 <tr>) 배열 반환. 실패 시 null.
  async function fetchAllStatisRows(setStatus) {
    const fp = statisFormParams();
    if (!fp) return null;
    const total = readTotal();
    const pages = total > 0 ? Math.ceil(total / QTY_FETCH_PS) : 1;
    const all = [];
    let qtyCol = 2;
    for (let p = 1; p <= pages; p++) {
      setStatus && setStatus(`전체 ${total}건 불러오는 중… (${p}/${pages})`);
      const params = new URLSearchParams(fp.params);
      params.set('pageSize', String(QTY_FETCH_PS));
      params.set('reqPage', String(p));
      const html = await fetchStatisHtml(fp.action, params);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const g = findStatisGridIn(doc);
      if (!g) throw new Error('응답에 t_list/수량 헤더 없음 (로그인 만료?)');
      qtyCol = g.qtyCol;
      g.rows.forEach(r => all.push(document.importNode(r, true)));
    }
    return { rows: all, qtyCol };
  }
  function addQtySort() {
    try {
      if (!state.ubSkin) return;                     // 유비샵 도구 켜졌을 때만
      if (!QTY_SORT_RE.test(location.pathname)) return;
      const anchor = document.querySelector('select[name="searchSortType"]');
      if (!anchor || anchor.dataset.ubQtyBound) return;
      const grid = findStatisGridIn(document);
      if (!grid) { console.log('[UB][skin] 수량정렬: t_list/수량 헤더 못 찾음'); return; }
      anchor.dataset.ubQtyBound = '1';

      const tbody = grid.table.tBodies[0] || grid.table;
      const pageRows = grid.rows.slice();            // 현재 페이지에 보이는 행(원래 순서)

      // UI: 정렬 드롭다운 + 상태 문구
      const sel = document.createElement('select');
      sel.className = anchor.className || 'f_small';
      sel.style.marginLeft = '4px';
      sel.innerHTML = '<option value="">수량정렬 −</option>'
                    + '<option value="asc">수량 적은순 ↑</option>'
                    + '<option value="desc">수량 많은순 ↓</option>';
      sel.title = '전체 데이터를 수량 기준으로 정렬 (여러 페이지면 전체 재조회)';
      const status = document.createElement('span');
      status.style.cssText = 'margin-left:6px;font:600 11px/1 Pretendard,sans-serif;color:#2563eb;vertical-align:middle;';
      const setStatus = (t) => { status.textContent = t || ''; };

      let fullRows = null;                           // 전체 세트 캐시(import된 <tr>)
      let fullQtyCol = grid.qtyCol;
      let busy = false;

      const render = (rows, qtyCol, v) => {
        let order = rows;
        if (v === 'asc' || v === 'desc') {
          order = rows.slice().sort((a, b) => {
            const d = numVal(a.cells[qtyCol].textContent) - numVal(b.cells[qtyCol].textContent);
            return v === 'asc' ? d : -d;
          });
        }
        // 기존 데이터행 제거 후 새 순서로 채움(헤더/합계는 유지)
        [...grid.table.rows]
          .filter(r => r.rowIndex > grid.headerRowIndex && r.cells.length > qtyCol &&
                       /^\d+$/.test(r.cells[0].textContent.replace(/\s+/g, '')))
          .forEach(r => r.remove());
        order.forEach(r => tbody.appendChild(r));
      };

      sel.addEventListener('change', async () => {
        const v = sel.value;
        if (busy) return;
        const total = readTotal();
        // 전체가 이미 화면에 있으면(단일 페이지) 현재 행으로 즉시 정렬
        if (total <= pageRows.length && !fullRows) {
          render(pageRows, grid.qtyCol, v);
          return;
        }
        // 여러 페이지 → 전체 재조회(1회) 후 캐시로 정렬
        if (!fullRows) {
          busy = true; sel.disabled = true;
          try {
            const res = await fetchAllStatisRows(setStatus);
            if (!res) throw new Error('폼 재현 실패');
            fullRows = res.rows; fullQtyCol = res.qtyCol;
            setStatus(`전체 ${fullRows.length}건 정렬`);
            console.log('[UB][skin] 수량정렬 전체 로드', { rows: fullRows.length, qtyCol: fullQtyCol });
          } catch (e) {
            setStatus('전체 불러오기 실패 — 현재 페이지만 정렬');
            console.warn('[UB][skin] 수량정렬 전체 로드 실패', e);
            render(pageRows, grid.qtyCol, v);
            busy = false; sel.disabled = false;
            return;
          }
          busy = false; sel.disabled = false;
        }
        render(fullRows, fullQtyCol, v);
      });

      anchor.parentNode.insertBefore(status, anchor.nextSibling);
      anchor.parentNode.insertBefore(sel, anchor.nextSibling);
      console.log('[UB][skin] 수량정렬 드롭다운 추가', { qtyCol: grid.qtyCol, pageRows: pageRows.length });
    } catch (e) { console.warn('[UB][skin] 수량정렬 실패', e); }
  }

  // ===========================================================================
  //  계정 빠른전환 데이터 영속화 — chrome.storage.local(ubAccounts/ubLoginSalt)
  //  은 확장 ID 에 종속돼 압축해제 확장을 제거/재로드하면 소멸한다. ubdstore
  //  origin 의 localStorage 에 미러해 두고, 재설치 후 ubdstore 페이지를 한 번
  //  열면 여기서 자동 복원한다. (게이팅 없음 — 스킨 on/off 와 무관)
  // ===========================================================================
  const ACCT_MIRROR_KEY = 'UB_ACCOUNTS_MIRROR_v1';
  function mirrorAccounts() {
    try {
      chrome.storage.local.get(['ubAccounts', 'ubLoginSalt'], d => {
        try {
          // 계정이 하나라도 있을 때만 미러(빈 값으로 백업 덮어쓰지 않음).
          if (d && d.ubAccounts && d.ubAccounts.length) {
            localStorage.setItem(ACCT_MIRROR_KEY, JSON.stringify({
              ubAccounts: d.ubAccounts, ubLoginSalt: d.ubLoginSalt || ''
            }));
          }
        } catch (_) {}
      });
    } catch (_) {}
  }
  function restoreAccountsFromMirror() {
    try {
      chrome.storage.local.get(['ubAccounts', 'ubLoginSalt'], d => {
        try {
          // 이미 계정이 있으면 백업만 최신화하고 끝(복원 불필요).
          if (d && d.ubAccounts && d.ubAccounts.length) { mirrorAccounts(); return; }
          const raw = localStorage.getItem(ACCT_MIRROR_KEY);
          if (!raw) return;
          const m = JSON.parse(raw);
          if (m && m.ubAccounts && m.ubAccounts.length) {
            chrome.storage.local.set({ ubAccounts: m.ubAccounts, ubLoginSalt: m.ubLoginSalt || '' });
            try { console.log('[UB][skin] 계정 데이터 로컬 백업에서 복원 ' + m.ubAccounts.length + '건'); } catch (_) {}
          }
        } catch (_) {}
      });
    } catch (_) {}
  }

  function init() {
    ensureDefaultPageSize();
    bindThumbEdit(document);
    bindCopyListener();
    captureSearchBarcode();   // v3.3.3: 바코드 검색칸 입력값 → 클립보드 자동 등록
    autoFocusByPage();   // v3.1.12: 페이지별 커서 자동 포커스
    clearForcedFields(); // v3.3.4: 상품입고장 검색 팝업 입고담당자 항상 공란
    initAssign();        // v3.6.8: 주문전표 재고배정 — 부모 새로고침 제거 + 행 제자리 갱신
    addQtySort();        // v3.1.16: 상품집계 수량 정렬
    restoreAccountsFromMirror(); // 계정 빠른전환: 재설치 대비 로컬백업 복원/미러
    // v3.1.1: Phase 2 transparent caching 은 src/cache-intercept.js (loader 동적로드)
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

  // sessionStorage에 사용자 옵션 mirror — 다음 navigate의 IIFE가 sync로 읽음.
  // ub_pref_autosync: cache-intercept.js(MAIN world, chrome.storage 직접 접근 불가)
  // 가 여기 미러값을 보고 활성 여부 판단. skin 자체가 OFF면 캐시도 무조건 OFF.
  function mirrorPrefs() {
    try {
      sessionStorage.setItem('ub_pref_skin', state.ubSkin ? '1' : '0');
      sessionStorage.setItem('ub_pref_ps', state.ubPageSize ? '1' : '0');
      sessionStorage.setItem('ub_pref_autosync', (state.ubSkin && state.ubAutoSync) ? '1' : '0');
    } catch (_) {}
  }
  try {
    chrome.storage.local.get(D, d => {
      Object.assign(state, d || {});
      mirrorPrefs();
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
      else init();
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      let changed = false;
      Object.keys(D).forEach(k => { if (ch[k]) { state[k] = ch[k].newValue; changed = true; } });
      if (changed) {
        mirrorPrefs();
        applyAll();
        if (on('ubThumbEdit')) bindThumbEdit(document);
      }
    });
  } catch (e) {}
  // 계정 빠른전환: popup 에서 계정 추가/삭제 시(사용자가 ubdstore 탭에 있을 때)
  // 로컬백업을 실시간 갱신. mirrorAccounts 는 localStorage 만 쓰므로 이 onChanged
  // 를 재유발하지 않는다(무한루프 없음).
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && (ch.ubAccounts || ch.ubLoginSalt)) mirrorAccounts();
    });
  } catch (_) {}
})();
