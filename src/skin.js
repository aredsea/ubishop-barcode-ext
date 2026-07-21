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

  /* ==========================================================================
   *  ★자동화 프레임 가드 — 이 블록은 반드시 파일 최상단에 있어야 한다.
   *  스펙: docs/superpowers/specs/2026-07-20-orderitem-batch-design.md §3.3
   *
   *  확장이 만든 숨은 iframe 안에서도 이 파일 전체가 다시 실행된다
   *  (manifest all_frames:true. 주문전표 페이지엔 ERP 자체 iframe 도 10개 있다).
   *  방치하면 ①iframe 안에 사이드바가 그려지고 ②배정 클릭 가로채기가 우리
   *  프로그램적 클릭을 삼키고 ③storage.onChanged 가 모든 컨텍스트에 방송되어
   *  (805행 함정) 중복 반응이 난다.
   *
   *  ⚠ URL 파라미터로 판별하면 안 된다 — 첫 navigation 에서 사라진다.
   *    배정 팝업의 ubasg 에서 이미 당한 함정이다(993~997행). iframe 엘리먼트의
   *    dataset 은 그 안에서 몇 번을 이동하든 살아남는다.
   *
   *  ⚠ init() 안에 두면 늦다 — ensurePageSizeAtStart 가 document_start 시점에
   *    location.replace 를 부른다. 그래서 다른 무엇보다 먼저 여기서 판정한다.
   *
   *  ⚠ 이 표식은 '식별자'일 뿐 권한이 아니다. 무엇을 실행할지는 background 의
   *    활성 job 레지스트리가 정한다. 자식이 operation 을 고를 수 있으면 그건
   *    경계가 아니다(background.js 의 ubAuto* 참조).
   * ========================================================================== */
  const UB_AUTO_JOB = (() => {
    try {
      // cross-origin 부모면 frameElement 접근 자체가 throw → 우리 프레임이 아니다.
      const fe = window.frameElement;
      const v = fe && fe.dataset && fe.dataset.ubAutoJob;
      return (typeof v === 'string' && v) ? v : null;
    } catch (_) { return null; }
  })();

  if (UB_AUTO_JOB) {
    // 자동화 프레임 — UI 기능을 전부 끄고 최소 러너만 돈다.
    // 하는 일은 '나는 어떤 문서인가'를 보고하는 것뿐. sender 에서 background 가
    // tabId·frameId·documentId 를 얻어 정확히 이 문서에만 MAIN world 를 주입한다.
    const ubAutoReport = (phase) => {
      try {
        chrome.runtime.sendMessage({
          source: 'ub', type: 'ubAutoFrameReady',
          jobId: UB_AUTO_JOB, phase, url: location.href
        });
      } catch (_) {}
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => ubAutoReport('dom'), { once: true });
    } else {
      ubAutoReport('dom');
    }
    window.addEventListener('load', () => ubAutoReport('load'), { once: true });
    return;   // ★ 이 아래로 단 한 줄도 실행하지 않는다
  }

  const D = {
    ubSkin: false, ubDark: false, ubThumbEdit: true,
    ubSidebar: true, ubPageSize: true, ubAutoSync: false,
    ubSbMode: 'docked', ubSbX: 24, ubSbY: 24, ubSbCollapsed: false,
    ubSbWidth: 256, ubSbHeight: 440, ubSbLocked: false,
    ubBarcodes: [],
    // v3.7.0 매입처 정보창 / 전표 기본탭
    ubFactoryInfo: true,                       // 매입처·발주처명 클릭 → 정보 플로팅창
    ubFwX: null, ubFwY: null, ubFwW: 380, ubFwH: 470,   // 정보창 위치·크기(null=최초 자동배치)
    ubTabMode: 'off',                          // 'off' | 'global' | 'each'
    ubTabGlobal: 'jun',                        // global 일 때 'jun'(장) | 'list'(내역)
    ubTabEach: {},                             // each 일 때 { input:'list', balju:'jun', ... }
    // v3.8.0 작업B 수정 팝업(slice 2a) — 기본 OFF. 패널 위치·크기는 매입처창(ubFw*)과 별도 키.
    ubEditPopup: false,
    ubEpX: null, ubEpY: null, ubEpW: 900, ubEpH: 660
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
  //  이 문서가 발급한 nonce(소비 자격). ★sessionStorage 에도 남긴다 — 메모리에만 두면
  //  팝업을 열어둔 채 부모를 새로고침했을 때 새 문서엔 발급 기록이 없어 신호를 무시하고,
  //  opener 도 끊겨 있어 그 행이 영영 옛 상태로 남는다(같은 탭이라 sessionStorage 는 유지된다).
  const ASG_ISSUED_KEY = 'UB_ASG_ISSUED';
  const asgIssued = new Set();
  function asgLoadIssued() {
    try {
      const o = JSON.parse(sessionStorage.getItem(ASG_ISSUED_KEY) || '[]');
      const now = Date.now();
      (Array.isArray(o) ? o : []).forEach(e => { if (e && e.n && (now - (e.t || 0)) <= ASG_TTL) asgIssued.add(e.n); });
    } catch (_) {}
  }
  function asgSaveIssued(nonce) {
    asgIssued.add(nonce);
    try {
      const now = Date.now();
      const cur = JSON.parse(sessionStorage.getItem(ASG_ISSUED_KEY) || '[]');
      const keep = (Array.isArray(cur) ? cur : []).filter(e => e && e.n && (now - (e.t || 0)) <= ASG_TTL);
      keep.push({ n: nonce, t: now });
      sessionStorage.setItem(ASG_ISSUED_KEY, JSON.stringify(keep.slice(-20)));
    } catch (_) {}
  }
  const ASG_TTL = 60000;          // 신호 만료
  const ASG_VERIFY_MS = 12000;    // 서버 반영 확인 최대 대기
  const ASG_FETCH_MS = 8000;      // 재조회 1회 타임아웃(무한 대기 방지)
  function isOrderJunList() { return /\/jun\/orderitem\/orderItemList\.do/.test(location.pathname); }
  function isAssignPopupForm() { return /\/jun\/orderitem\/orderItemPopCurrentSettingModifyForm\.do/.test(location.pathname); }
  function isAssignModify() { return /\/jun\/orderitem\/orderItemPopCurrentSettingModify\.do/.test(location.pathname); }
  function isAssignCancel() { return /\/jun\/orderitem\/orderItemPopCurrentSettingCancel\.do/.test(location.pathname); }
  // 팝업 URL 에 실어 보내는 검색 파라미터(네이티브 CONST_URL 과 동일 구성).
  //  CONST_URL 은 페이지(MAIN world) 전역이라 ISOLATED 에서 못 읽는다 → form1 현재값으로 재구성.
  const ASG_SEARCH_FIELDS = [
    'pageSize', 'searchSortType', 'searchOrderType', 'searchBaljuType', 'searchItemType',
    'searchItemStatus', 'searchBranch', 'searchShop', 'searchK', 'searchColor',
    'searchWordType1', 'searchWordType2', 'searchWord1', 'searchWord2', 'searchRegId',
    'searchJunNum', 'searchItemSize', 'searchClientName', 'searchDateType',
    'syear', 'smonth', 'sday', 'eyear', 'emonth', 'eday'
  ];
  // ── 작업B 순수 헬퍼 (slice 1) ─────────────────────────────────────────────
  function parseModifyArgs(href) {
    const m = String(href == null ? '' : href).match(
      /^\s*(?:javascript\s*:\s*)?modify\s*\(\s*(['"])([^'"]*)\1\s*,\s*(['"])([^'"]*)\3\s*\)\s*;?\s*$/
    );
    return m ? { master: m[2], seq: m[4] } : null;
  }
  function classifyModifySave(input) {
    if (!input || input.dispatched !== true) return 'fail';
    const q = input.requery;
    if (input.landedPathAllowed === true && input.isLoginOrError === false &&
        q && q.found === true && q.matchesExpected === true) return 'success';
    return 'uncertain';
  }
  function decideRowUpdateMode(input) {
    if (!input || input.orderDateChanged !== false ||
        input.filterMembershipChanged !== false || input.sortMembershipChanged !== false) {
      return 'list-reload';
    }
    return 'in-place';
  }
  // ── 작업C 순수 헬퍼 (slice 1) ─────────────────────────────────────────────
  //  본사확인 → 입고완료 자동화의 순수 판정부. DOM·쓰기·chrome.*·타이머 미접촉.
  //  통합 슬라이스 전까지 의도적으로 미사용. C 는 되돌리기 어려운 라이브 쓰기(본사확인
  //  =POST, 재고배정=쓰는 GET)라 모든 판정은 fail-closed 다 — 알 수 없거나 애매하면
  //  '진행하지 않는다'로 떨어진다.
  //  ⚠ 상태 판정은 canonical code EXACT match 다(spec §5). 괄호 절단·접두 일치는
  //   화면 필터 membership 전용이라 여기(쓰기 권한 판정)에는 절대 쓰지 않는다.
  //  대상 상태인가 = 정확히 주문완료(O--) 또는 본사확인(OS-) 두 가지뿐.
  //  그 외·미지·빈값·null 은 전부 false. prefix 아님, exact.
  function cTargetStatus(code) {
    return code === 'O--' || code === 'OS-';
  }
  //  체크된 행들을 대상/제외로 가른다. targets 는 원본 행을 그대로 담고, excluded 는
  //  { orderSeq, code, reason } 로 사유를 붙인다. 같은 orderSeq 가 둘 이상이면 dedupe
  //  하지 말고 duplicate=true 로 알린다(spec §5·§10: 중복은 조용히 합치지 말고 중단).
  //  호출부는 duplicate 면 fail-closed 로 중단한다.
  function cClassifyChecked(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const REASON = new Map([
      ['I--', '이미 입고완료'], ['OC-', '주문취소'], ['T--', '출고완료'],
      ['TS-', '출고확인'], ['TE-', '출고오확인'], ['S--', '판매완료'], ['B--', '발주완료']
    ]);
    const seen = new Set();
    let duplicate = false;
    for (const r of list) {
      const key = String(r && r.orderSeq != null ? r.orderSeq : '');
      if (seen.has(key)) duplicate = true; else seen.add(key);
    }
    const targets = [];
    const excluded = [];
    for (const r of list) {
      const code = r ? r.code : undefined;
      if (cTargetStatus(code)) { targets.push(r); continue; }
      excluded.push({ orderSeq: r ? r.orderSeq : undefined, code: code,
                      reason: REASON.get(code) || '상태 불명' });
    }
    return { targets: targets, excluded: excluded, duplicate: duplicate };
  }
  //  재조회한 '현재' 상태(code) 기준 다음 단계(spec §4.3 step 1). O-- → standby,
  //  OS- → assign(standby 생략), 그 외·미지 → abort. 매 쓰기 직전 재조회 값으로만 판단.
  function cNextStep(currentCode) {
    if (currentCode === 'O--') return 'standby';
    if (currentCode === 'OS-') return 'assign';
    return 'abort';
  }
  //  배정 팝업의 데이터 행(문서 순서 배열)에서 첫 행 바코드를 고른다(현행 수작업 관행).
  //  후보 0건이면 null → 호출부 실패(spec §4.3 step 3). 첫 후보에 바코드가 없거나 빈
  //  값이어도 null(빈 값이 쓰기로 흘러가지 않게). 바코드는 그대로 반환한다 — 이후 성공
  //  판정이 이 값과 정확히 대조되므로 trim·대소문자 변형을 하지 않는다.
  function cPickAssignBarcode(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const first = candidates[0];
    const bc = first == null ? null : first.barcode;
    return (typeof bc === 'string' && bc !== '') ? bc : null;
  }
  //  쓰기(setCurrent) dispatch 후 한 건의 성공 3분기(spec §3.6·§4.3 step 5).
  //  기준선은 'dispatch 했는가'. dispatch 전 실패(dispatched!==true)는 쓰기가 없었던
  //  게 확실하므로 확정 실패('fail', 안전). dispatch 후에는 상태 I-- 이고 배정 바코드가
  //  우리가 고른 바코드와 정확히 같을 때만 'success'. 그 외(이전 상태·다른 바코드·다른
  //  상태·재조회 null/실패/타임아웃)는 전부 'uncertain' — 절대 'fail' 아니고, dispatch
  //  후 non-success 는 자동 재시도 금지다(§3.6).
  function cClassifyOutcome(input) {
    if (!input || input.dispatched !== true) return 'fail';
    const q = input.requery;
    if (q && q.found === true && q.code === 'I--' &&
        q.assignedBarcode === input.expectedBarcode) return 'success';
    return 'uncertain';
  }
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
  //  바코드 비교용 정규화. 화면값과 서버값이 '다른가'만 보면 되므로 이거면 충분하다.
  const asgNorm = (s) => String(s == null ? '' : s).trim().toUpperCase();
  // 지금 걸린 상태 필터에 이 행이 여전히 맞는가. 안 맞으면 목록에서 빠지는 게 맞다
  //  (본사확인 필터로 보다가 입고완료된 건 / 입고완료 필터로 보다가 취소된 건).
  //  상태 필터가 없으면 그 건은 목록에 계속 속하므로 제자리 갱신한다.
  //  순수 비교(단위테스트 대상) — 행을 '지울지' 정하는 판단이라 따로 뺐다.
  //  ⚠ 옵션 라벨의 괄호는 떼고 비교한다. 셀 텍스트의 괄호는 '바코드'인데 옵션에도 괄호가
  //   있는 항목이 있어(출고확인(매장재고)) 그대로 비교하면 실제 셀 '출고확인(240HTI)' 과
  //   안 맞아 멀쩡한 행을 지운다.
  function statusMatchesLabel(statusText, optionLabel) {
    const label = String(optionLabel == null ? '' : optionLabel).replace(/\s+/g, '').replace(/\(.*$/, '');
    if (!label) return true;               // 라벨을 못 읽으면 남긴다
    return String(statusText == null ? '' : statusText).replace(/\s+/g, '').indexOf(label) === 0;
  }
  function rowStillMatchesFilter(statusText) {
    try {
      const f = document.forms['form1'];
      const sel = f && f.elements['searchItemStatus'];
      if (!sel || !sel.value) return true;   // 상태 필터 없음 → 그대로 남는다
      const opt = sel.options[sel.selectedIndex];
      return statusMatchesLabel(statusText, opt ? opt.text : '');
    } catch (_) { return true; }   // 판단 못 하면 남긴다(잘못 지우는 쪽이 더 위험)
  }
  // ★작업 동일성은 nonce 로 잡는다. orderSeq+목표바코드로 잡으면 '취소'는 목표값이 항상 ''
  //  이라 같은 주문의 서로 다른 취소가 같은 작업으로 뭉개진다(A취소→B배정→B취소 를 30초 안에
  //  하면 두 번째 취소가 폐기되어, 서버는 바뀌었는데 부모 행만 옛 상태로 남는다).
  //  nonce 는 클릭마다 새로 발급되므로 같은 nonce 의 intent/done 만 하나로 병합된다.
  //  목표값·직전값은 '반영됐는지' 검증에만 쓴다.
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
        // ★킬스위치는 '클릭 시점'에도 본다. 초기화 때만 보면, 켜진 채 페이지를 열고 나서
        //  꺼도 이미 등록된 리스너가 계속 가로챈다(끌 수가 없다).
        if (!state.ubSkin) return;
        const a = e.target && e.target.closest ? e.target.closest('a[href*="currentSetting"]') : null;
        if (!a) return;
        args = parseCurrentSettingArgs(a.getAttribute('href'));
        // 미배정(본사확인→배정)과 배정됨(입고완료→선택취소) 둘 다 가로챈다. 취소도 같은
        //  팝업·같은 새로고침 문제를 겪는다. 판정은 '바코드가 달라졌는가' 하나로 대칭 처리.
        if (!args || !args.orderSeq) return;
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
          // ⚠ 여기서 창을 닫으면 안 된다. 이미 window.open 이 사용자 활성화를 썼기 때문에,
          //  이어서 도는 네이티브 currentSetting 의 두 번째 window.open 이 팝업 차단에 걸려
          //  '아무 일도 안 일어나는' 상태가 될 수 있다. 창은 그대로 두고 가로채기만 포기하면
          //  네이티브가 같은 이름(orderitem_win)으로 이 창을 재사용한다 → 기능 이전 동작으로 복귀.
          asgLog('opener 차단 확인 실패 → 가로채기 취소(창은 네이티브가 재사용)');
          return;
        }
        // 발급 기록에 '지금 바코드'를 남긴다 — 성공 판정이 이 값과의 차이로 이뤄진다.
        asgSaveIssued(nonce);
        e.preventDefault();
        e.stopImmediatePropagation();
        asgLog('가로챔 —', isUnassigned(args) ? '배정' : '선택취소', 'orderSeq', args.orderSeq,
               '/ before=' + (args.barcode || '(없음)') + ', nonce', nonce);
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
        const t = e.target;
        if (!t || !t.closest) return;
        // 이 동작이 끝나면 그 행의 바코드가 '무엇이 되어야 하는가'(=기대값)를 정한다.
        let target = null;
        const a = t.closest('a[href*="setCurrent"]');
        if (a) {
          const bc = parseSetCurrentBarcode(a.getAttribute('href'));
          if (!bc) return;
          target = bc;                        // 재고 배정 → 그 바코드가 붙는다
        } else if (t.closest('[onclick*="cancelForm"]')) {
          target = '';                        // 선택취소 → 바코드가 떨어진다
        } else return;
        // 부모가 발급한 nonce 가 있을 때만 '우리가 연 팝업'이다(없으면 네이티브로 열린 창).
        //  검색·페이징으로 URL 에서 ubasg 가 빠졌을 수 있으니 보존해 둔 sessionStorage 가 1순위.
        let nonce = '';
        try { nonce = sessionStorage.getItem(ASG_OURS_KEY) || ''; } catch (_) {}
        if (!nonce) { try { nonce = new URLSearchParams(location.search).get(ASG_NONCE_PARAM) || ''; } catch (_) {} }
        if (!nonce) { asgLog('nonce 없는 팝업(네이티브) → 관여 안 함'); return; }
        // preventDefault 하지 않는다 — 배정·취소는 네이티브가 그대로 수행한다.
        writeAssignSignal(hidden('orderSeq'), target, hidden('orderDate'), 'intent', '', nonce);
      } catch (err) { asgLog('팝업 신호 실패', err); }
    }, true);
  }
  function bindAssignResultPage(kind) {   // 'assign'(Modify.do) | 'cancel'(Cancel.do)
    // ★우리가 연 배정 팝업일 때만 관여한다. 이 판정이 없으면 같은 Modify.do 를 타는
    //  배정취소(cancelForm) 흐름까지 삼켜서, 방금 취소한 행을 '입고완료'로 되칠할 수 있다.
    let nonce = '';
    try { nonce = sessionStorage.getItem(ASG_OURS_KEY) || ''; } catch (_) {}
    if (!nonce) { asgLog('우리 팝업이 아님(nonce 없음) → 관여 안 함'); return; }
    try { sessionStorage.removeItem(ASG_OURS_KEY); } catch (_) {}
    const finish = () => {
      try {
        const sp = new URLSearchParams(location.search);
        const urlBc = sp.get('barcode');
        // ★취소 결과 페이지의 URL barcode 는 '방금 뗀' 바코드다. 끝난 뒤의 값은 빈 값이므로
        //  그걸 기대값으로 쓰면 영원히 확인되지 않는다.
        const target = (kind === 'cancel') ? '' : (urlBc || '');
        const ok = (kind === 'cancel') || !!urlBc;
        // ★진단: 이 응답이 부모를 '어떻게' 새로고침하려 했는지 아직 아무도 실물을 본 적이 없다.
        //  설계 전체가 'opener 접근이 첫 줄에서 죽는다'에 걸려 있으므로, opener 를 건드리는
        //  스크립트 원문을 신호에 실어 부모 콘솔([UB][assign])에 남긴다. 창은 곧 닫혀서
        //  여기서 console.log 해봐야 사라진다. 읽기만 하며 동작에는 영향 없음.
        let diag = '';
        try {
          diag = [...document.querySelectorAll('script')].map(s => s.textContent || '')
            .filter(t => /opener/.test(t)).join(' || ').replace(/\s+/g, ' ').slice(0, 600);
        } catch (_) {}
        if (ok) writeAssignSignal(sp.get('orderSeq'), target, sp.get('orderDate'), 'done', diag, nonce);
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
  // '총 : N 개' 도 같이 줄인다 — 안 줄이면 개수와 목록이 어긋나 사용자가 혼란스럽다.
  function asgDecrementTotal() {
    try {
      const el = [...document.querySelectorAll('span.f_bold')].find(s =>
        /^\d+$/.test((s.textContent || '').trim()) &&
        /총/.test(((s.previousElementSibling || {}).textContent) || ''));
      if (!el) return;
      const n = parseInt(el.textContent, 10);
      if (n > 0) el.textContent = String(n - 1);
    } catch (_) {}
  }
  function asgRemoveRow(tr) {
    try {
      // 사라지는 건 드문 일이라 짧게만 알린다(§25: 이탈은 ease-out, 300ms 미만, opacity 만).
      tr.style.transition = 'opacity .24s ease-out';
      tr.style.opacity = '0';
      setTimeout(() => { try { tr.remove(); } catch (_) {} }, 240);
    } catch (_) { try { tr.remove(); } catch (__) {} }
    asgDecrementTotal();
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
    // ★검증 조회는 화면 필터를 물려받지 않는다. 배정/취소로 **값이 바뀌는 필드가 검색조건이면
    //  그 행 자체가 응답에서 사라져**(예: 바코드로 검색해둔 행을 취소) 영영 '아직 반영 안 됨'
    //  으로 오해하고 낡은 행을 그대로 둔다. 그래서 조건은 '그 주문의 날짜' 하나로만 좁힌다.
    //  (실측: 한 달 주문이 1,013건 ≈ 하루 35건이라 pageSize 500 이면 1페이지에 다 들어온다.
    //   현재 화면 필터에 맞는지는 조회 결과를 받은 뒤 rowStillMatchesFilter 로 따로 판정한다.)
    const p = new URLSearchParams();
    p.set('tcode', 'order_item');
    p.set('reqPage', '1');
    p.set('pageSize', '500');
    p.set('searchItemStatus', '');
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
  const asgBusy = new Set();   // 같은 행에 재동기화가 겹쳐 돌지 않게
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
  /*  ★설계 단순화(2026-07-19, 검수 4라운드 끝에). 작업별 '기대값'을 재현·검증하지 않는다.
   *   이 로직이 원하는 건 하나다 — **지금 서버가 뭐라고 하는지를 그 행에 반영한다.**
   *   작업(nonce)별 완료기억·대기열·기대값 대조를 쌓을수록 유실·고착 경로만 늘었다
   *   (같은 주문의 서로 다른 취소가 뭉개짐 / 늦은 done 이 다음 작업을 밀어냄 /
   *    큐가 만료·중복에 걸려 뒤가 고립됨 …). 전부 '작업을 재현하려 한' 데서 나왔다.
   *   그래서 신호는 '이 행이 낡았다'는 뜻으로만 쓰고, 화면에 보이는 값과 서버 값이 다르면
   *   서버 쪽으로 맞춘다. 몇 개가 겹쳤든 마지막 재동기화가 진실을 보여준다.
   */
  const asgAgain = new Map();     // orderSeq → 진행 중에 온 '최신' 신호(끝나고 그걸로 한 번 더)
  //  이미 화면에 반영을 끝낸 작업(nonce). 같은 클릭의 intent 뒤에 오는 done 이 또 12초짜리
  //  폴링을 새로 시작해 700ms 간격 조회를 헛되이 퍼붓는 것을 막는다.
  //  ⚠ '반영에 성공한' nonce 만 넣는다 — 변화를 못 봤다면 done 에게 기회를 줘야 한다.
  const asgApplied = new Set();
  //  그 행에 지금 '표시돼 있는' 바코드(상태셀 링크의 3번째 인자)
  function asgShownBarcode(tr) {
    const a = tr ? tr.querySelector('a[href*="currentSetting"]') : null;
    const args = a ? parseCurrentSettingArgs(a.getAttribute('href')) : null;
    return args ? args.barcode : null;
  }
  async function resyncRow(sig) {
    const key = String(sig.orderSeq);
    // 이 클릭은 이미 반영 완료 — 다만 신호는 지우고 나간다(안 지우면 진단 문자열이 남는다).
    if (sig.nonce && asgApplied.has(sig.nonce)) { asgClearSignalIfSame(sig); return; }
    if (asgBusy.has(key)) { asgAgain.set(key, sig); return; }   // 진행 중 → 끝나고 최신 걸로 한 번 더
    asgBusy.add(key);
    try {
      // 부모가 막 로드된 참이면 표가 아직 안 그려졌을 수 있다 → 잠깐 기다린다.
      for (let i = 0; i < 6 && !asgFindRow(sig.orderSeq); i++) await new Promise(r => setTimeout(r, 500));
      const deadline = Date.now() + ASG_VERIFY_MS;
      while (Date.now() < deadline) {
        const tr = asgFindRow(sig.orderSeq);
        if (!tr || !tr.isConnected) return;   // 이 문서엔 없는 행(다른 검색화면) → 조용히 종료
        const shown = asgShownBarcode(tr);
        let cell = null;
        try { cell = await fetchStatusCell(sig.orderSeq, sig.orderDate); } catch (err) { asgLog('재조회 실패', err); }
        if (cell && asgNorm(cell.barcode) !== asgNorm(shown)) {
          // 서버가 화면과 다르다 → 서버 쪽으로 맞춘다.
          //  ⚠ 행은 await 사이에 다시 그려질 수 있으니 여기서 한 번 더 찾고 isConnected 확인.
          const tr2 = asgFindRow(sig.orderSeq);
          const td = tr2 && tr2.isConnected ? asgStatusTd(tr2) : null;
          if (!td) { await new Promise(r => setTimeout(r, 700)); continue; }
          if (rowStillMatchesFilter(cell.text)) {
            // 서버가 렌더한 셀을 그대로 이식 → 손으로 만든 마크업이 아니라서
            // 이후 그 행에서 다시 링크를 눌러도 네이티브 동작이 그대로 이어진다.
            td.innerHTML = cell.html;
            tr2.classList.add('ub-ms-hl');
            asgLog('재동기화', sig.orderSeq, cell.text);
            asgToast('반영: ' + cell.text);
          } else {
            // 상태가 바뀌어 지금 필터 조건에서 벗어난 건 → 목록에 남아 있으면 안 된다.
            asgRemoveRow(tr2);
            asgLog('필터 이탈 → 행 제거', sig.orderSeq, cell.text);
            asgToast('반영: ' + cell.text + ' (목록에서 제외)');
          }
          if (sig.nonce) asgApplied.add(sig.nonce);
          asgClearSignalIfSame(sig);
          return;
        }
        await new Promise(r => setTimeout(r, 700));
      }
      // 시간 안에 서버 값이 화면과 달라지지 않았다 = 바뀐 게 없다(작업 실패 등).
      //  화면이 이미 서버와 같으므로 고칠 것도 알릴 것도 없다 — 조용히 끝낸다.
      asgLog('변화 없음(화면이 이미 서버와 같음)', sig.orderSeq);
      asgClearSignalIfSame(sig);
    } finally {
      asgBusy.delete(key);
      // 도는 동안 또 신호가 왔으면 한 번 더. 큐가 아니라 '한 번 더'면 충분하다 —
      //  어차피 매번 서버의 현재값을 보므로, 중간 상태를 따로 재생할 이유가 없다.
      const again = asgAgain.get(key);
      if (again) { asgAgain.delete(key); resyncRow(again).catch(err => asgLog('재동기화 예외', err)); }
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
      resyncRow(sig).catch(err => asgLog('재동기화 예외', err));
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
      if (isOrderJunList()) { asgLoadIssued(); bindAssignIntercept(); bindAssignStorage(); }
      else if (isAssignModify()) bindAssignResultPage('assign');
      else if (isAssignCancel()) bindAssignResultPage('cancel');
      else if (isAssignPopupForm()) bindAssignPopupForm();
    } catch (e) { asgLog('초기화 실패', e); }
  }

  /* ==========================================================================
   *  5.8) 매입처 정보 플로팅창 + 전표 기본탭 (v3.7.0)
   *
   *  (A) 전표의 매입처·발주처명을 누르면 매입처관리의 상세(factoryView.do 의 table.t_form)를
   *      화면 위 플로팅창으로 띄운다. 원본 view(seq) 는 팝업이 아니라 **페이지 이동**이라
   *      그대로 쓰면 보던 목록·필터·스크롤이 날아간다(5.7 에서 없앤 바로 그 문제).
   *      ⚠ 전표의 매입처명은 링크가 아니라 그냥 텍스트라 seq 가 없다 → 매입처 목록에서
   *        '이름 → seq' 맵을 만들어 캐시한다(실측: 현재 화면 17종 전부 정확일치).
   *      ⚠ 컬럼명이 페이지마다 다르다(발주처명 / 매입처 / 매입처(매장명) / 매입처입고일).
   *        인덱스를 박으면 깨지므로 **헤더에서 컬럼을 찾는다**. '매입처상품코드'는 제외.
   *
   *  (B) 전표 메뉴 진입 시 '장' 과 '내역' 중 어느 쪽을 먼저 볼지 지정한다.
   *      두 탭은 사실 서로 다른 페이지다(○○JunList.do?tcode=xxx_jun ↔ ○○List.do?tcode=xxx).
   *      ★진입 후 리다이렉트하지 않고 **좌측 메뉴의 링크 자체를 바꾼다** — 페이지가 한 번 더
   *        뜨지 않고, 되돌아가는 루프도 없고, 탭 클릭은 네이티브 그대로 남는다.
   * ========================================================================== */
  const FW_TAG = '[UB][factory]';
  const fwLog = (...a) => { try { console.log(FW_TAG, ...a); } catch (_) {} };
  const FW_MAP_KEY = 'ubFactoryMap';       // { at, map:{이름:seq} }
  //  이 캐시에는 계정 식별자가 없다. **매입처 목록은 모든 계정이 같은 데이터를 공유한다(사용자
  //   확인, 2026-07-19)** — 계정마다 seq 가 달라 엉뚱한 업체가 열리는 경로는 성립하지 않는다.
  //   그래도 방어는 남겨둔다: 상세를 열 때 이름을 대조하고, 계정 전환 신호(ubAccounts 변경)에
  //   캐시를 버린다. TTL 은 위험이 아니라 '새 매입처가 언제 눌리게 되나' 기준으로 잡았다.
  const FW_MAP_TTL = 6 * 60 * 60 * 1000;
  const FW_ID = 'ub-fw';
  const FW_STYLE_ID = 'ub-fw-style';
  // 전표 기본탭 대상. jun=장, list=내역. 좌측 메뉴 링크는 항상 jun 쪽을 가리킨다.
  //  menu = 좌측 메뉴에 찍히는 글자. ★이걸로 메뉴 링크만 집는다 — 경로만 보면 같은 화면의
  //  페이지네이션([2][3])이 같은 pathname·같은 tcode 라 함께 바뀌어 페이징이 깨진다(Codex 지적).
  const TAB_MENUS = [
    { key: 'input',  label: '상품입고',   menu: '상품입고전표',   jun: '/jun/inputitem/inputItemJunList.do?tcode=input_item_jun&searchItemType=1', list: '/jun/inputitem/inputItemList.do?tcode=input_item' },
    { key: 'balju',  label: '상품발주',   menu: '상품발주전표',   jun: '/jun/baljuitem/baljuItemJunList.do?tcode=balju_item_jun',                  list: '/jun/baljuitem/baljuItemList.do?tcode=balju_item' },
    { key: 'stone',  label: '메인석입고', menu: '메인석입고전표', jun: '/jun/inputstone/inputStoneJunList.do?tcode=input_stone_jun&searchItemType=2', list: '/jun/inputstone/inputStoneList.do?tcode=input_stone' },
    { key: 'rotate', label: '회전입고',   menu: '회전입고전표',   jun: '/jun/rotateitem/rotateItemJunList.do?tcode=rotate_item_jun',                list: '/jun/rotateitem/rotateItemList.do?tcode=rotate_item' },
    { key: 'deliv',  label: '매장출고',   menu: '매장출고전표',   jun: '/jun/delivitem/delivItemJunList.do?tcode=deliv_item_jun',                   list: '/jun/delivitem/delivItemList.do?tcode=deliv_item' }
  ];
  // ── 순수 헬퍼(DOM 비의존, 단위테스트 대상) ────────────────────────────────
  //  헤더 라벨이 매입처/발주처 컬럼인가. '매입처상품코드'는 상품 코드라 제외해야 한다.
  function isFactoryHeader(label) {
    const t = String(label == null ? '' : label).replace(/\s+/g, '');
    if (!t || /상품코드/.test(t)) return false;
    return /매입처|발주처/.test(t);
  }
  //  이 설정이 의미 있는 페이지인가 = 장/내역 탭이 실제로 있는 전표 화면(전표당 2개 경로).
  //  다른 화면에서는 사이드바에 띄우지 않는다(관계없는 곳에서 자리만 차지한다).
  function isTabPrefPath(pathname, menus) {
    const p = String(pathname == null ? '' : pathname);
    return (menus || []).some(m => p === m.jun.split('?')[0] || p === m.list.split('?')[0]);
  }
  //  ○○JunList.do?tcode=xxx_jun ↔ ○○List.do?tcode=xxx 중 어느 쪽을 쓸지.
  //  mode 가 off 면 손대지 않는다(null 반환 = 원본 유지).
  function tabPrefFor(key, mode, global, each) {
    if (mode === 'global') return (global === 'list') ? 'list' : 'jun';
    if (mode === 'each') {
      const v = each && each[key];
      return (v === 'list') ? 'list' : (v === 'jun' ? 'jun' : null);
    }
    return null;
  }
  // ── 매입처 이름 → seq 맵 ─────────────────────────────────────────────────
  //  ⚠ 동명 매입처가 둘 이상이면 그 이름은 아예 링크하지 않는다. 첫 seq 로 확정하면
  //   두 번째 업체의 칸을 눌렀을 때 '다른 업체의 정보'가 뜬다 — 조용히 틀린 값을 보여주는
  //   쪽이 안 눌리는 것보다 나쁘다.
  function fwParseFactoryMap(doc) {
    const seen = {}, dup = {};
    doc.querySelectorAll('a[href*="view("]').forEach(a => {
      const m = (a.getAttribute('href') || '').match(/view\(\s*'?(\d+)'?\s*\)/);
      const name = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!m || !name) return;
      if (name in seen) { if (seen[name] !== m[1]) dup[name] = 1; return; }
      seen[name] = m[1];
    });
    const map = {};
    Object.keys(seen).forEach(n => { if (!dup[n]) map[n] = seen[n]; });
    const dn = Object.keys(dup);
    if (dn.length) fwLog('동명 매입처 → 링크 제외', dn.length, '건', dn.slice(0, 5));
    return map;
  }
  let fwMapMem = null, fwMapLoading = null;
  function fwGetMap() {
    if (fwMapMem) return Promise.resolve(fwMapMem);
    if (fwMapLoading) return fwMapLoading;
    fwMapLoading = new Promise((resolve) => {
      let done = false;
      const finish = (m) => { if (done) return; done = true; fwMapMem = m || {}; fwMapLoading = null; resolve(fwMapMem); };
      const fetchFresh = () => {
        // pageSize 를 넉넉히 — 한 번에 다 받아야 이름이 빠지지 않는다(실측 323개).
        postDoc('/basic/factory/factoryList.do?tcode=factory', new URLSearchParams({ tcode: 'factory', pageSize: '1000', reqPage: '1' }))
          .then(doc => {
            const map = fwParseFactoryMap(doc);
            fwLog('매입처 목록 로드', Object.keys(map).length, '건');
            try { chrome.storage.local.set({ [FW_MAP_KEY]: { at: Date.now(), map } }); } catch (_) {}
            finish(map);
          })
          .catch(err => { fwLog('매입처 목록 로드 실패', err); finish({}); });
      };
      try {
        chrome.storage.local.get(FW_MAP_KEY, (d) => {
          const c = d && d[FW_MAP_KEY];
          if (c && c.map && (Date.now() - (c.at || 0)) < FW_MAP_TTL && Object.keys(c.map).length) finish(c.map);
          else fetchFresh();
        });
      } catch (_) { fetchFresh(); }
    });
    return fwMapLoading;
  }
  // ── 전표에서 매입처명 셀 표시 ────────────────────────────────────────────
  //  셀 첫 줄만 이름이다(뒤에 발주일·매장명 등이 붙는 칸이 있다).
  function fwCellName(td) {
    if (!td) return '';
    const sp = td.querySelector('span.f_bold, b, strong');
    if (sp) return (sp.textContent || '').replace(/\s+/g, ' ').trim();
    const first = [...td.childNodes].find(n => n.nodeType === 3 && (n.nodeValue || '').trim());
    return first ? first.nodeValue.replace(/\s+/g, ' ').trim() : '';
  }
  //  table.t_list 의 매입처명 컬럼 인덱스. 마킹(장식)과 클릭(기능)이 '같은 기준'으로 컬럼을
  //  찾도록 하는 단일 출처다. 헤더 판정은 fwMarkNames 와 동일 — 첫 매칭 헤더 행만, '매입처상품
  //  코드'는 제외(isFactoryHeader). 클릭마다 재탐색하지 않도록 테이블에 캐시한다. 없으면 [].
  //  ★헤더는 '첫 매칭 행'으로 한 번만 정한다. 매 행에서 다시 판정하면 상품명·상품코드에
  //   '매입처'가 들어간 데이터 행을 헤더로 오인해 열 위치가 통째로 어긋난다(Codex 지적).
  function fwFactoryColsFor(table) {
    if (!table) return [];
    if (table.dataset.ubFwCols != null) {
      try { return JSON.parse(table.dataset.ubFwCols); } catch (_) { return []; }
    }
    const rows = [...table.rows];
    let cols = [];
    for (let r = 0; r < rows.length; r++) {
      const cs = [...rows[r].cells].map(c => c.textContent || '');
      const idxs = cs.map((c, i) => isFactoryHeader(c) ? i : -1).filter(i => i >= 0);
      if (idxs.length) { cols = idxs; break; }
    }
    try { table.dataset.ubFwCols = JSON.stringify(cols); } catch (_) {}
    return cols;
  }
  function fwMarkNames(map) {
    let n = 0;
    document.querySelectorAll('table.t_list').forEach(t => {
      const cols = fwFactoryColsFor(t);   // ★컬럼 탐지 단일 출처(클릭 폴백과 동일 기준)
      if (!cols.length) return;
      const rows = [...t.rows];
      // 헤더 행 = 그 컬럼이 매입처 헤더로 잡히는 첫 행(= fwFactoryColsFor 이 잡은 행). 아래 행만 처리.
      let hdr = 0;
      for (let r = 0; r < rows.length; r++) {
        if (cols.some(i => rows[r].cells[i] && isFactoryHeader(rows[r].cells[i].textContent || ''))) { hdr = r; break; }
      }
      for (let r = hdr + 1; r < rows.length; r++) {
        const row = rows[r];
        cols.forEach(i => {
          const td = row.cells[i];
          if (!td) return;
          const name = fwCellName(td);
          if (!name) return;
          const seq = map[name];
          const host = td.querySelector('span.f_bold, b, strong') || td;
          if (seq) {
            if (td.dataset.ubFw) return;   // 이미 확정
            td.dataset.ubFw = seq;
            host.classList.add('ub-fw-name');   // 즉시밑줄로 이미 있을 수 있음(idempotent)
            host.title = '매입처 정보 보기';
            n++;
          } else if (!td.dataset.ubFw && host.classList.contains('ub-fw-name')) {
            // 즉시 밑줄됐으나 맵에서 해결 불가(동명·미등록) → 밑줄 회수(클릭해도 안 열려 오해 방지)
            host.classList.remove('ub-fw-name'); host.title = '';
          }
        });
      }
    });
    if (n) fwLog('매입처명 표시', n, '칸');
  }
  // 진입 즉시(비동기 맵 대기 없이) 발주처명 칸을 밑줄 처리한다. 장식을 맵 로드에서 분리 —
  //  seq 는 클릭 폴백이 즉시 해결하고, 맵이 로드되면 fwMarkNames 가 dataset.ubFw(빠른경로)를
  //  달고 미등록·동명(해결 불가)인 칸의 밑줄은 회수한다. fwFactoryColsFor 로 컬럼만 보므로 sync.
  function fwMarkColumnsNow() {
    let n = 0;
    document.querySelectorAll('table.t_list').forEach(t => {
      const cols = fwFactoryColsFor(t);
      if (!cols.length) return;
      const rows = [...t.rows];
      let hdr = 0;
      for (let r = 0; r < rows.length; r++) {
        if (cols.some(i => rows[r].cells[i] && isFactoryHeader(rows[r].cells[i].textContent || ''))) { hdr = r; break; }
      }
      for (let r = hdr + 1; r < rows.length; r++) {
        const row = rows[r];
        cols.forEach(i => {
          const td = row.cells[i];
          if (!td || td.dataset.ubFw) return;   // 이미 확정된 칸은 둔다
          const name = fwCellName(td);
          if (!name) return;
          const host = td.querySelector('span.f_bold, b, strong') || td;
          if (host.classList.contains('ub-fw-name')) return;   // 이미 밑줄
          host.classList.add('ub-fw-name'); host.title = '매입처 정보 보기';
          n++;
        });
      }
    });
    if (n) fwLog('발주처명 즉시 밑줄', n, '칸');
  }
  function bindFactoryNames() {
    if (!on('ubFactoryInfo')) return;
    if (!/^\/jun\//.test(location.pathname)) return;   // 전표 화면에서만
    fwMarkColumnsNow();   // 진입 즉시 밑줄(맵 대기 없음). seq 는 클릭 폴백/맵 로드가 해결.
    fwGetMap().then(map => { if (map && Object.keys(map).length) fwMarkNames(map); });
  }
  // ── 플로팅 정보창 ────────────────────────────────────────────────────────
  const FW_CSS = `
    .ub-fw {
      position: fixed; z-index: 2147483647;
      background: #fff; color: #1b1b1b;
      border: 1px solid #e5e7eb; border-radius: 12px;
      box-shadow: 0 12px 32px rgba(15,20,25,.18);
      font-family: Pretendard, -apple-system, 'Malgun Gothic', sans-serif;
      display: flex; flex-direction: column; overflow: hidden;
      min-width: 280px; min-height: 200px;
    }
    .ub-fw-h {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 12px 12px 16px; cursor: move; user-select: none;
      border-bottom: 1px solid #e5e7eb; background: #f7f9fc;
    }
    .ub-fw-h b { font-size: 13px; font-weight: 700; letter-spacing: -.01em; flex: 1;
                 white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ub-fw-x {
      width: 24px; height: 24px; border: 0; background: transparent; cursor: pointer;
      border-radius: 6px; color: #6b7280; display: flex; align-items: center; justify-content: center;
      transition: background .16s ease-out, color .16s ease-out;
    }
    .ub-fw-x:hover { background: #eceff3; color: #1b1b1b; }
    .ub-fw-b { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 4px 16px 16px; font-size: 12px; }
    .ub-fw-dl { margin: 0; }
    .ub-fw-dl > div {
      display: flex; align-items: flex-start; gap: 12px;
      padding: 9px 0; border-bottom: 1px solid #f0f2f5;
    }
    .ub-fw-dl > div:last-child { border-bottom: 0; }
    .ub-fw-dl dt {
      flex: none; width: 76px; color: #6b7280; font-size: 11px; line-height: 1.6;
      letter-spacing: -.01em;
    }
    .ub-fw-dl dd {
      margin: 0; flex: 1; min-width: 0; line-height: 1.6; word-break: break-word;
      white-space: pre-wrap; color: #1b1b1b;
    }
    .ub-fw-dl dd.ub-fw-empty { color: #c7ccd4; }
    .ub-fw-msg { color: #6b7280; padding: 24px 4px; text-align: center; font-size: 12px; }
    .ub-fw-rz { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
                cursor: nwse-resize; }
    .ub-fw-rz::after { content: ''; position: absolute; right: 3px; bottom: 3px;
                       width: 7px; height: 7px; border-right: 2px solid #c7ccd4; border-bottom: 2px solid #c7ccd4; }
    .ub-fw-name { cursor: pointer; border-bottom: 1px dashed #35C5F0; }
    .ub-fw-name:hover { color: #2bb5e0; }
  `;
  function ensureFwStyle() {
    if (document.getElementById(FW_STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = FW_STYLE_ID; s.textContent = FW_CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  const FW_X_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  function fwSavePos(el) {
    try {
      chrome.storage.local.set({
        ubFwX: parseInt(el.style.left, 10) || 0, ubFwY: parseInt(el.style.top, 10) || 0,
        ubFwW: el.offsetWidth, ubFwH: el.offsetHeight
      });
    } catch (_) {}
  }
  function fwEnsurePanel() {
    ensureFwStyle();
    let el = document.getElementById(FW_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = FW_ID; el.className = 'ub-fw';
    el.innerHTML = '<div class="ub-fw-h"><b></b><button class="ub-fw-x" title="닫기">' + FW_X_SVG + '</button></div>'
                 + '<div class="ub-fw-b"></div><div class="ub-fw-rz"></div>';
    // 최초엔 화면 오른쪽 위 근처, 이후엔 사용자가 둔 자리.
    const w = Math.max(280, state.ubFwW | 0 || 380), h = Math.max(200, state.ubFwH | 0 || 470);
    // ⚠ `|| 기본값` 으로 판정하면 저장값 0(화면 맨 왼쪽·맨 위에 둔 경우)이 '미저장'으로 취급돼
    //   매번 기본 위치로 튄다. 숫자인지로 판정한다.
    const num = (v) => (typeof v === 'number' && isFinite(v));
    const x = num(state.ubFwX) ? state.ubFwX : Math.max(16, window.innerWidth - w - 40);
    const y = num(state.ubFwY) ? state.ubFwY : 80;
    el.style.width = w + 'px'; el.style.height = h + 'px';
    el.style.left = Math.min(x, Math.max(0, window.innerWidth - 80)) + 'px';
    el.style.top = Math.min(y, Math.max(0, window.innerHeight - 60)) + 'px';
    document.body.appendChild(el);
    el.querySelector('.ub-fw-x').addEventListener('click', () => { el.remove(); });
    // 드래그(헤더) — 버튼 위에서 시작하면 무시
    const hd = el.querySelector('.ub-fw-h');
    hd.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ub-fw-x')) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      const ox = parseInt(el.style.left, 10) || 0, oy = parseInt(el.style.top, 10) || 0;
      const mv = (ev) => {
        el.style.left = Math.max(0, Math.min(window.innerWidth - 60, ox + ev.clientX - sx)) + 'px';
        el.style.top  = Math.max(0, Math.min(window.innerHeight - 40, oy + ev.clientY - sy)) + 'px';
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); fwSavePos(el); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    // 크기조절(우하단)
    el.querySelector('.ub-fw-rz').addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, ow = el.offsetWidth, oh = el.offsetHeight;
      const mv = (ev) => {
        el.style.width  = Math.max(280, ow + ev.clientX - sx) + 'px';
        el.style.height = Math.max(200, oh + ev.clientY - sy) + 'px';
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); fwSavePos(el); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    return el;
  }
  //  값 칸에서 실제 값을 뽑는다. 대부분 readonly input, 거래유형만 체크박스 묶음이다.
  function fwCellValue(td) {
    const chks = [...td.querySelectorAll('input[type="checkbox"]')];
    if (chks.length) {
      // 체크박스 라벨은 보통 바로 뒤 텍스트노드에 있다. 없으면 칸 전체 텍스트를
      //  순서대로 토큰화해 위치로 맞춘다(마크업이 조금 달라도 버티도록).
      const toks = (td.textContent || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      const on = chks.map((c, i) => {
        if (!c.checked) return '';
        const n = c.nextSibling;
        const s = (n && n.nodeValue ? n.nodeValue : '').replace(/\s+/g, ' ').trim();
        return s || toks[i] || '';
      }).filter(Boolean);
      return on.join(', ');
    }
    const f = td.querySelector('input[type="text"], input:not([type]), textarea, select');
    if (f) {
      if (f.tagName === 'SELECT') { const o = f.options[f.selectedIndex]; return (o ? o.text : '').trim(); }
      return String(f.value == null ? '' : f.value).replace(/\s+/g, ' ').trim();
    }
    return (td.textContent || '').replace(/\s+/g, ' ').trim();
  }
  //  factoryView.do 의 table.t_form 은 [라벨][값] 2칸 행의 반복이다(실측).
  //  원본 표를 그대로 넣으면 고정폭 input 때문에 가로로 잘리므로 값만 뽑아 다시 그린다.
  function fwExtractPairs(table) {
    const out = [];
    table.querySelectorAll('tr').forEach(tr => {
      const cs = tr.cells;
      if (!cs || cs.length !== 2) return;
      // 라벨 칸에 입력요소나 중첩표가 있으면 그건 래퍼 행이지 라벨이 아니다.
      if (cs[0].querySelector('input, select, textarea, table')) return;
      const label = (cs[0].textContent || '').replace(/\s+/g, ' ').trim();
      if (!label || label.length > 12) return;
      out.push({ label: label, value: fwCellValue(cs[1]) });
    });
    return out;
  }
  const fwEsc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function fwRenderPairs(pairs) {
    if (!pairs.length) return '';
    return '<dl class="ub-fw-dl">' + pairs.map(p =>
      '<div><dt>' + fwEsc(p.label) + '</dt><dd' + (p.value ? '' : ' class="ub-fw-empty"') + '>'
      + (p.value ? fwEsc(p.value) : '—') + '</dd></div>').join('') + '</dl>';
  }
  let fwSeqShown = null;
  function fwShow(name, seq) {
    const el = fwEnsurePanel();
    el.querySelector('.ub-fw-h b').textContent = name || '매입처';
    const body = el.querySelector('.ub-fw-b');
    if (fwSeqShown === seq && body.dataset.ok === '1') return;   // 같은 곳 다시 눌러도 재요청 안 함
    fwSeqShown = seq; body.dataset.ok = '';
    body.innerHTML = '<div class="ub-fw-msg">불러오는 중…</div>';
    postDoc('/basic/factory/factoryView.do?tcode=factory', new URLSearchParams({ tcode: 'factory', seq: String(seq) }))
      .then(doc => {
        if (fwSeqShown !== seq) return;            // 그 사이 다른 매입처를 눌렀으면 버린다
        const t = doc.querySelector('table.t_form');
        const pairs = t ? fwExtractPairs(t) : [];
        if (!pairs.length) { body.innerHTML = '<div class="ub-fw-msg">상세 정보를 찾지 못했습니다.</div>'; return; }
        // ★검증: 받아온 상세의 매입처명이 누른 이름과 다르면 캐시(이름→seq)가 틀어진 것이다
        //  (계정 전환·매입처 재편 등). 조용히 '다른 업체 정보'를 보여주는 게 최악이므로,
        //  그때는 표시하지 않고 캐시를 버린 뒤 다시 누르도록 안내한다.
        // ⚠ fail-open 금지: 이름을 못 읽었으면(라벨 변경·빈 값) 검증이 성립하지 않은 것이므로
        //  그때도 표시하지 않는다. '확신이 없으면 보여주지 않는다'가 이 기능의 원칙이다.
        const got = (pairs.find(p => /매입처\s*명/.test(p.label)) || {}).value || '';
        const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
        if (!got || !name || norm(got) !== norm(name)) {
          fwLog('이름 검증 실패 — 캐시 폐기', { 누름: name, 받음: got || '(못읽음)', seq: seq });
          fwMapMem = null;
          try { chrome.storage.local.remove(FW_MAP_KEY); } catch (_) {}
          document.querySelectorAll('td[data-ub-fw]').forEach(td => {
            delete td.dataset.ubFw;
            const h = td.querySelector('.ub-fw-name'); if (h) h.classList.remove('ub-fw-name');
          });
          bindFactoryNames();
          body.innerHTML = '<div class="ub-fw-msg">매입처 목록이 바뀌었습니다.<br>목록을 새로 받았으니 다시 눌러주세요.</div>';
          return;
        }
        body.innerHTML = fwRenderPairs(pairs); body.dataset.ok = '1';
      })
      .catch(err => {
        fwLog('상세 로드 실패', err);
        if (fwSeqShown === seq) body.innerHTML = '<div class="ub-fw-msg">불러오지 못했습니다.</div>';
      });
  }
  function bindFactoryClick() {
    document.addEventListener('click', (e) => {
      try {
        if (!on('ubFactoryInfo')) return;   // 클릭 시점 킬스위치(초기화 때만 보면 끌 수 없다)
        // 빠른 경로: 이미 마킹된 칸(dataset.ubFw). 비동기 마킹이 끝난 뒤의 클릭.
        const host = e.target && e.target.closest ? e.target.closest('.ub-fw-name') : null;
        if (host) {
          const td = host.closest('td');
          const seq = td && td.dataset ? td.dataset.ubFw : '';
          if (seq) {
            e.preventDefault(); e.stopPropagation();
            fwShow(fwCellName(td), seq);
            return;
          }
        }
        // 폴백: 아직 마킹 전(비동기 fwGetMap→fwMarkNames 완료 전)이라도 첫 클릭에서 바로 연다.
        //  마킹은 '점선 장식'일 뿐 기능을 게이팅하지 않는다 — 클릭 시점에 컬럼으로 판정한다.
        const td = e.target && e.target.closest ? e.target.closest('td') : null;
        if (!td) return;
        const table = td.closest ? td.closest('table.t_list') : null;
        if (!table) return;
        const cols = fwFactoryColsFor(table);
        if (!cols.length || cols.indexOf(td.cellIndex) < 0) return;   // 매입처 컬럼 칸이 아니면 무시
        const name = fwCellName(td);
        if (!name) return;
        // 전표의 매입처명은 링크가 아니라 텍스트라 native 액션이 없다 → 낙관적 preventDefault 안전.
        e.preventDefault(); e.stopPropagation();
        fwGetMap().then(map => {
          const seq = map && map[name];
          if (!seq) return;   // ⚠ 동명 매입처(fwParseFactoryMap 에서 제외)·미등록 → 아무것도 안 함
          td.dataset.ubFw = seq;
          const h = td.querySelector('span.f_bold, b, strong') || td;
          h.classList.add('ub-fw-name'); h.title = '매입처 정보 보기';   // 장식도 즉시 부여
          fwShow(name, seq);   // ★fwShow 가 상세의 매입처명==클릭명 재검증(불일치 시 캐시 폐기)
        });
      } catch (err) { fwLog('클릭 처리 실패', err); }
    }, true);
    // ESC 로 닫기
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const el = document.getElementById(FW_ID);
      if (el) el.remove();
    });
  }
  // ── 전표 기본탭: 좌측 메뉴 링크 재작성 ───────────────────────────────────
  function applyTabPref() {
    // ★꺼졌을 때 그냥 return 하면 이미 바꿔둔 메뉴 링크가 그대로 남아 '껐는데도 계속 먹는' 상태가
    //  된다. 꺼짐은 '설정 없음(null)'으로 취급해 아래 복원 경로를 태운다.
    const off = !state.ubSkin;
    let n = 0;
    TAB_MENUS.forEach(m => {
      const pref = off ? null : tabPrefFor(m.key, state.ubTabMode, state.ubTabGlobal, state.ubTabEach);
      const junPath = m.jun.split('?')[0];
      const listPath = m.list.split('?')[0];
      document.querySelectorAll('a[href]').forEach(a => {
        // 메뉴 글자가 정확히 일치하는 링크만 — 페이지네이션·본문 링크는 건드리지 않는다.
        if ((a.textContent || '').replace(/\s+/g, '') !== m.menu) return;
        const href = a.getAttribute('href') || '';
        if (/^javascript:/i.test(href)) return;
        let p = '';
        try { p = new URL(href, location.origin).pathname; } catch (_) { return; }
        const isOurs = p === junPath || (a.dataset.ubTabOrig && p === listPath);
        if (!isOurs) return;
        if (pref === 'list') {
          if (href.indexOf(listPath) >= 0) return;              // 이미 내역
          if (!a.dataset.ubTabOrig) a.dataset.ubTabOrig = href;  // 되돌릴 원본 보관
          a.setAttribute('href', m.list); n++;
        } else if (a.dataset.ubTabOrig) {
          // 설정을 되돌렸다 → 원본 복원(페이지를 새로 열지 않아도 즉시 맞는다)
          a.setAttribute('href', a.dataset.ubTabOrig);
          delete a.dataset.ubTabOrig; n++;
        }
      });
    });
    if (n) fwLog('기본탭 메뉴 링크', n, '개 갱신');
  }
  // ── 사이드바: 전표 기본탭 설정 UI ────────────────────────────────────────
  const TAB_OPT = (v, cur) => `<option value="${v}"${cur === v ? ' selected' : ''}>${v === 'jun' ? '장' : '내역'}</option>`;
  function renderTabPrefSection() {
    if (!isTabPrefPath(location.pathname, TAB_MENUS)) return '';   // 해당 전표 화면에서만
    const mode = state.ubTabMode || 'off';
    const each = state.ubTabEach || {};
    const rows = TAB_MENUS.map(m => {
      const cur = each[m.key] === 'list' ? 'list' : 'jun';
      return `<div class="ub-tp-row"><span>${m.label}</span>
        <select class="ub-tp-sel" data-tp-each="${m.key}">${TAB_OPT('jun', cur)}${TAB_OPT('list', cur)}</select></div>`;
    }).join('');
    return `
      <div class="ub-sb-sect">
        <div class="ub-sb-sect-t">${ICONS.panelLeft}<span>전표 기본탭</span></div>
        <select class="ub-tp-sel" data-tp-mode>
          <option value="off"${mode === 'off' ? ' selected' : ''}>사용 안 함</option>
          <option value="global"${mode === 'global' ? ' selected' : ''}>전체 한 번에</option>
          <option value="each"${mode === 'each' ? ' selected' : ''}>전표별 개별</option>
        </select>
        ${mode === 'global' ? `
          <div class="ub-tp-row"><span>모든 전표</span>
            <select class="ub-tp-sel" data-tp-global>${TAB_OPT('jun', state.ubTabGlobal)}${TAB_OPT('list', state.ubTabGlobal)}</select>
          </div>` : ''}
        ${mode === 'each' ? rows : ''}
        ${mode === 'off' ? '' : '<div class="ub-tp-hint">메뉴 링크를 바꿔 처음부터 그 탭으로 엽니다. 화면의 탭 클릭은 그대로 동작합니다.</div>'}
      </div>`;
  }
  function bindTabPrefSection(bar) {
    const save = (patch) => {
      Object.assign(state, patch);
      try { chrome.storage.local.set(patch); } catch (_) {}
      applyTabPref();      // 지금 보고 있는 페이지의 메뉴에도 바로 반영
      renderSidebar();     // 모드가 바뀌면 하위 항목 구성이 달라진다
    };
    const modeSel = bar.querySelector('[data-tp-mode]');
    if (modeSel) modeSel.addEventListener('change', () => save({ ubTabMode: modeSel.value }));
    const gSel = bar.querySelector('[data-tp-global]');
    if (gSel) gSel.addEventListener('change', () => save({ ubTabGlobal: gSel.value }));
    bar.querySelectorAll('[data-tp-each]').forEach(sel => {
      sel.addEventListener('change', () => {
        const each = Object.assign({}, state.ubTabEach || {});
        each[sel.dataset.tpEach] = sel.value;
        save({ ubTabEach: each });
      });
    });
  }
  function initFactory() {
    try {
      if (!state.ubSkin) return;
      bindFactoryClick();
      bindFactoryNames();
      // applyTabPref 는 applyAll 에서 돈다(설정 변경·다른 탭 반영까지 한 곳으로).
    } catch (e) { fwLog('초기화 실패', e); }
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

    /* 전표 기본탭 설정 */
    .ub-sidebar .ub-tp-sel {
      width: 100%; height: 32px; padding: 0 8px; box-sizing: border-box;
      border: 1px solid var(--ub-line); border-radius: 8px; background: var(--ub-bg);
      color: var(--ub-fg); font-size: 12px; font-family: inherit; cursor: pointer;
    }
    .ub-sidebar .ub-tp-sel:focus { outline: none; border-color: var(--ub-on); }
    .ub-sidebar .ub-tp-row {
      display: flex; align-items: center; gap: 8px; margin-top: 8px;
    }
    .ub-sidebar .ub-tp-row span { flex: 1; font-size: 12px; color: var(--ub-sub); }
    .ub-sidebar .ub-tp-row .ub-tp-sel { width: 84px; flex: none; height: 28px; }
    .ub-sidebar .ub-tp-hint { margin-top: 8px; font-size: 11px; color: var(--ub-sub); line-height: 1.5; }
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

      ${renderTabPrefSection()}

      <div class="ub-sb-rz-x" title="너비 조절 (드래그)"></div>
      <div class="ub-sb-rz" title="크기 조절 (드래그)"></div>
    `;

    // 위치 / 크기 적용
    applySbPosition(bar);
    applySbSize(bar);
    // 드래그 / 리사이즈
    bindDrag(bar);
    bindResize(bar);

    bindTabPrefSection(bar);

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
    applyTabPref();         // v3.7.0: 전표 기본탭(설정 변경·다른 탭에서 바뀐 경우 포함)
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
      if (needThumb) { bindThumbEdit(document); ubHighlightPending(); bindFactoryNames(); }   // idx 행 동적렌더 시 강조·매입처명 재시도
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

  /* ==========================================================================
   *  Phase 0 스파이크 — 자동화 배관 검증 (읽기 전용, 임시 코드)
   *  스펙 §6 Phase 0. 확인 대상:
   *    ① iframe 생성순서(dataset→src→append)에서 첫 document_start 부터 가드가 걸리는가
   *    ② 자식 READY → background 가 sender.documentId 로 MAIN world 주입에 성공하는가
   *    ③ navigation 후 재-handshake 시 documentId 는 바뀌고 frameId 는 유지되는가
   *    ④ 허용 경로 밖에서 RPC 가 거부되는가
   *
   *  ⚠ 임시다. Phase 0 통과 후 실제 컨트롤러로 대체한다.
   *  ⚠ 기본 OFF. 켜려면 콘솔에서  sessionStorage.ub_auto_spike = '1'  후 새로고침.
   *    1회성이라 자동으로 꺼진다. 읽기 전용이라 데이터를 바꾸지 않는다.
   *  ⚠ 절대 orderItemPopCurrentSettingModify.do (Form 없는 쪽)를 열지 마라 —
   *    그건 GET 인데 실행하면 실제 배정이 나간다(1절 '쓰기 계약' 참조).
   * ========================================================================== */
  const AUTO_SPIKE_KEY = 'ub_auto_spike';

  function initAutoSpike() {
    let want = false;
    try { want = sessionStorage.getItem(AUTO_SPIKE_KEY) === '1'; } catch (_) {}
    if (!want) return;
    if (window !== window.top) return;      // 컨트롤러는 top frame 만
    if (!isOrderJunList()) return;
    try { sessionStorage.removeItem(AUTO_SPIKE_KEY); } catch (_) {}   // 1회성
    runAutoSpike();
  }

  function autoSpikeSend(m) {
    return new Promise(r => { try { chrome.runtime.sendMessage(m, x => r(x)); } catch (_) { r(null); } });
  }

  /* ★읽기 전용 URL 만 상수로 둔다. 임의 문자열을 받지 않는 게 방어선 1 이다.
   *  setCurrent 는 GET 이동으로 배정을 수행하므로(1절 '쓰기 계약'), 그 URL 을
   *  '확인용으로 한 번 여는' 순간이 곧 쓰기다. 실제로 그 실수를 한 번 했다. */
  const AUTO_SPIKE_URLS = Object.freeze({
    list:       '/jun/orderitem/orderItemList.do?tcode=order_item',
    modifyForm: '/jun/orderitem/orderItemModifyForm.do?tcode=order_item',
    denied:     '/info/item/infoItemList.do?tcode=info_item'
  });
  // 방어선 2 — 위 상수를 누가 잘못 고쳐도 쓰기로 보이는 경로면 거부한다.
  const AUTO_WRITE_MARKERS = /(?:Standby|CurrentSettingModify|CurrentSettingCancel|orderItemModify)\.do(?:[?#]|$)/i;

  function autoSpikeUrl(stepKey) {
    const u = AUTO_SPIKE_URLS[stepKey];
    if (!u) throw new Error('unknown_spike_step:' + stepKey);
    if (AUTO_WRITE_MARKERS.test(u)) throw new Error('write_url_blocked:' + stepKey);
    return u;
  }

  // dataset → src → append 순서가 불변식이다. src/append 뒤에 dataset 을 붙이면
  // document_start content script 가 먼저 돌아 가드가 풀린 채 실행된다.
  function autoSpikeFrame(jobId, url) {
    const f = document.createElement('iframe');
    f.dataset.ubAutoJob = jobId;                                   // ①
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1024px;height:700px;border:0;';
    f.src = url;                                                   // ②
    document.body.appendChild(f);                                  // ③
    return f;
  }

  async function runAutoSpike() {
    const log = (...a) => { try { console.log('[UB][spike]', ...a); } catch (_) {} };
    const created = await autoSpikeSend({ source: 'ub', type: 'ubAutoCreateJob', feature: 'spike' });
    if (!created || !created.ok) { log('job 생성 실패:', created); return; }
    const jobId = created.jobId;
    const steps = created.steps || [];
    log('job', jobId, '· 단계:', steps.join(' → '));

    let frame = null;
    try {
      for (const key of steps) {
        const url = autoSpikeUrl(key);
        if (!frame) frame = autoSpikeFrame(jobId, url);
        // ★같은 worker 슬롯을 재사용한다. 단계마다 새 iframe 을 만들면 frameId 가
        //   달라져 거부 단계가 frame_mismatch 에서 걸리고, 정작 검증하려던
        //   path_not_allowed 에는 도달하지 못한다(= 아무것도 증명 못 함).
        else frame.src = url;
        await new Promise(r => setTimeout(r, 3500));
      }
    } catch (e) {
      log('중단:', e && e.message);
    } finally {
      if (frame) { try { frame.remove(); } catch (_) {} }
      const ended = await autoSpikeSend({ source: 'ub', type: 'ubAutoEndJob', jobId });
      if (!ended || !ended.ok) {
        // SW 재시작 등으로 job 이 사라지면 결과를 못 받는다. 이걸 PASS 로 오해하면 안 된다.
        log('SPIKE_FAILED: job 결과를 받지 못함', ended);
        return;
      }
      const rs = ended.results || [];
      log('=== 단계 결과 ' + rs.length + '건 ===');
      rs.forEach(e => log(' ', e.stepKey, e.path, '→', e.outcome, e.error || '',
        'frame=' + e.frameId, 'doc=' + String(e.senderDocumentId).slice(0, 8)));
      const v = ended.verdict || {};
      log(v.pass ? 'SPIKE_PASS ✓' : 'SPIKE_FAILED ✗', JSON.stringify(v));
    }
  }

  /* ==========================================================================
   *  5.9) 작업B — 수정 팝업 (slice 2a: 가로채기 + 플로팅 패널 + iframe)
   *
   *  목록의 [수정](a[href*="modify("]) 클릭을 capture 단계에서 잡아, 화면 이동 대신
   *  매입처 정보창(ub-fw)과 '겉모습만 동일'한 플로팅 패널에 네이티브 수정폼
   *  (orderItemModifyForm.do)을 iframe 으로 띄운다.
   *
   *  ⚠ preventDefault 는 인자 파싱·행 확인·패널/iframe 생성이 전부 성공한 뒤에만 부른다
   *    (bindAssignIntercept 와 같은 규율 — skin.js:1006). 어느 단계든 실패하면 가로채지
   *    않고 네이티브 modify() 화면 이동을 그대로 흘려보낸다.
   *
   *  ⚠ slice 2a 범위: 저장 감지·제출 가로채기·재조회·행 갱신은 하지 않는다(→ slice 2b).
   *    사용자가 iframe 안 네이티브 폼에서 저장하면 네이티브 그대로 저장된다. 우리는 아직
   *    그 결과를 검증하거나 목록 행을 갱신하지 않는다.
   * ========================================================================== */
  const EP_TAG = '[UB][editpop]';
  const epLog = (...a) => { try { console.log(EP_TAG, ...a); } catch (_) {} };
  const EP_ID = 'ub-ep';
  const EP_STYLE_ID = 'ub-ep-style';
  const EP_LOAD_MS = 8000;   // iframe 로드 최대 대기 → 초과 시 폴백 버튼 노출
  // ub-fw(매입처 정보창) 룩을 그대로 재사용하고, iframe 바디·폴백 UI 용 최소 스타일만 덧붙인다.
  const EP_CSS = `
    .ub-ep .ub-ep-b { flex: 1; min-height: 0; display: flex; overflow: hidden; background: #fff; }
    .ub-ep .ub-ep-frame { flex: 1; width: 100%; height: 100%; border: 0; display: block; background: #fff; }
    .ub-ep .ub-ep-fb { margin: auto; text-align: center; padding: 24px 20px; font-size: 12px; color: #6b7280; line-height: 1.6; }
    .ub-ep .ub-ep-fb-btn { margin-top: 12px; padding: 9px 16px; border: 0; border-radius: 8px; background: #35C5F0; color: #fff; font-size: 12px; font-weight: 700; cursor: pointer; font-family: inherit; }
    .ub-ep .ub-ep-fb-btn:hover { background: #2bb5e0; }
  `;
  function ensureEpStyle() {
    if (document.getElementById(EP_STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = EP_STYLE_ID; s.textContent = EP_CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  function epSavePos(el) {
    try {
      chrome.storage.local.set({
        ubEpX: parseInt(el.style.left, 10) || 0, ubEpY: parseInt(el.style.top, 10) || 0,
        ubEpW: el.offsetWidth, ubEpH: el.offsetHeight
      });
    } catch (_) {}
  }
  // 매입처 정보창(fwEnsurePanel)의 생성·드래그·크기조절·닫기·위치저장을 그대로 본떠 만든다.
  //  바디에 dl 대신 iframe 을 담고, 위치는 별도 키(ubEp*)에 저장한다(정보창과 안 겹치게).
  function epEnsurePanel() {
    ensureFwStyle();   // .ub-fw 룩(테두리·헤더·닫기 버튼·크기조절 커서) 재사용
    ensureEpStyle();
    let el = document.getElementById(EP_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = EP_ID; el.className = 'ub-fw ub-ep';
    el.innerHTML = '<div class="ub-fw-h"><b>수정</b><button class="ub-fw-x" title="닫기">' + FW_X_SVG + '</button></div>'
                 + '<div class="ub-ep-b"></div><div class="ub-fw-rz"></div>';
    const num = (v) => (typeof v === 'number' && isFinite(v));
    const w = Math.max(360, state.ubEpW | 0 || 900), h = Math.max(240, state.ubEpH | 0 || 660);
    const x = num(state.ubEpX) ? state.ubEpX : Math.max(16, (window.innerWidth - w) / 2 | 0);
    const y = num(state.ubEpY) ? state.ubEpY : 64;
    el.style.width = w + 'px'; el.style.height = h + 'px';
    el.style.left = Math.min(x, Math.max(0, window.innerWidth - 80)) + 'px';
    el.style.top = Math.min(y, Math.max(0, window.innerHeight - 60)) + 'px';
    document.body.appendChild(el);
    el.querySelector('.ub-fw-x').addEventListener('click', () => { el.remove(); });
    const hd = el.querySelector('.ub-fw-h');
    hd.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ub-fw-x')) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      const ox = parseInt(el.style.left, 10) || 0, oy = parseInt(el.style.top, 10) || 0;
      const mv = (ev) => {
        el.style.left = Math.max(0, Math.min(window.innerWidth - 60, ox + ev.clientX - sx)) + 'px';
        el.style.top  = Math.max(0, Math.min(window.innerHeight - 40, oy + ev.clientY - sy)) + 'px';
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); epSavePos(el); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    el.querySelector('.ub-fw-rz').addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, ow = el.offsetWidth, oh = el.offsetHeight;
      const mv = (ev) => {
        el.style.width  = Math.max(360, ow + ev.clientX - sx) + 'px';
        el.style.height = Math.max(240, oh + ev.clientY - sy) + 'px';
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); epSavePos(el); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    return el;
  }
  // iframe 안(same-origin) ERP 전역 헤더·메뉴를 가리고 폼만 보이게 한다.
  //  ⚠ 보수적으로: 수정폼(form1)을 못 찾으면 아무것도 건드리지 않는다(문서 통째로 비우지 않음).
  //   폼 서브트리의 조상·자손은 절대 숨기지 않는다 — 조상을 숨기면 폼이 사라지고 자손을 숨기면
  //   폼 내부가 깨진다. 폼 밖 크롬만 display:none 한다.
  function epHideChrome(doc) {
    try {
      if (!doc) return;
      const form = doc.forms && doc.forms['form1'];
      if (!form) return;   // 기대한 폼 컨테이너 없음(로그인/오류 화면 등) → 보수적으로 손대지 않는다
      const CHROME_SEL = '#header,#top,#topWrap,#top_wrap,#gnb,#lnb,#snb,#nav,#footer,#left,#leftMenu,' +
                         '.header,.top_wrap,.gnb,.lnb,.snb,.nav,.footer,.leftmenu,.left_menu,.menu_wrap';
      let n = 0;
      doc.querySelectorAll(CHROME_SEL).forEach((el) => {
        try {
          if (el && el.style && !el.contains(form) && !form.contains(el)) { el.style.display = 'none'; n++; }
        } catch (_) {}
      });
      epLog('iframe 크롬 숨김', n, '개');
    } catch (_) { /* cross-origin·예외 → 네이티브 폼 그대로 둔다 */ }
  }
  // orderItemModifyForm.do URL 구성. buildAssignPopupUrl 의 form1 필드복사 규약을 그대로
  //  따른다(같은 목록 컨텍스트 전달). 최소 master+orderSeq+tcode 는 항상 싣는다.
  function buildEditPopupUrl(args) {
    const p = new URLSearchParams();
    p.set('tcode', 'order_item');
    p.set('master', args.master);
    p.set('orderSeq', args.seq);
    p.set('reqPage', '1');
    const f = document.forms['form1'];
    if (f) ASG_SEARCH_FIELDS.forEach((n) => {
      const el = f.elements[n];   // f[n] 은 동명 필드가 있으면 조용히 누락된다(skin.js:988)
      if (el && typeof el.value === 'string') p.set(n, el.value);
    });
    return '/jun/orderitem/orderItemModifyForm.do?' + p.toString();
  }
  // 패널을 열고 iframe 을 로드한다. 패널+iframe 이 DOM 에 성공적으로 붙으면 true 를 반환한다
  //  (호출자는 이 true 뒤에만 preventDefault 한다). 로드 실패/타임아웃이면 패널에
  //  [기존 화면으로 열기] 폴백을 띄운다 — 자동 이동보다 버튼을 우선한다(§4.1).
  function epOpenPanel(args, url) {
    const panel = epEnsurePanel();
    const body = panel.querySelector('.ub-ep-b');
    if (!body) return false;
    body.innerHTML = '';   // 같은 패널 재사용 시 이전 iframe/폴백 제거
    const frame = document.createElement('iframe');
    frame.className = 'ub-ep-frame';
    frame.setAttribute('title', '수정');
    let settled = false;
    const showFallback = (why) => {
      if (settled) return; settled = true;
      epLog('iframe 로드 실패 → 폴백', why);
      try {
        body.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'ub-ep-fb';
        box.textContent = '수정 화면을 이 창에 띄우지 못했습니다.';
        const btn = document.createElement('button');
        btn.className = 'ub-ep-fb-btn';
        btn.textContent = '기존 화면으로 열기';
        // 네이티브 modify() 는 location.href 전체 이동이다(설계 §1). ISOLATED 에서 페이지
        //  전역 modify() 를 직접 못 부르므로, 같은 목적지로 top 문서를 이동시켜 동등 복구한다.
        btn.addEventListener('click', () => { try { window.location.href = url; } catch (_) {} });
        box.appendChild(document.createElement('br'));
        box.appendChild(btn);
        body.appendChild(box);
      } catch (e) { epLog('폴백 렌더 실패', e); }
    };
    const timer = setTimeout(() => showFallback('timeout'), EP_LOAD_MS);
    frame.addEventListener('load', () => {
      if (settled) return;
      // navigation 은 '저장 성공'의 증거가 아니지만(§4.1) slice 2a 는 저장 검증을 하지 않는다.
      //  로드가 뜨면 크롬만 숨긴다. 로그인 리다이렉트면 form1 이 없어 epHideChrome 가 no-op.
      settled = true; clearTimeout(timer);
      epHideChrome(frame.contentDocument);
    });
    frame.addEventListener('error', () => { clearTimeout(timer); showFallback('error'); });
    frame.src = url;
    body.appendChild(frame);
    return true;
  }
  // ── 부모: [수정] 클릭 가로채기 ────────────────────────────────────────────
  //  게이트 OFF 에서도 한 번 idempotent 하게 bind 한다(§5). 발동 여부는 클릭 시점에 정한다.
  function bindEditPopupIntercept(root) {
    try {
      // 목록 페이지에서만 의미가 있다(modify 링크가 그 페이지에만 있다). 다른 페이지·서브
      //  iframe(all_frames) 에는 걸지 않는다.
      if (!isOrderJunList()) return;
      const host = (root && root.documentElement) || document.documentElement;
      if (!host || host.dataset.ubEpBound === '1') return;   // 이미 bind → 중복 방지
      host.dataset.ubEpBound = '1';
      (root || document).addEventListener('click', (e) => {
        try {
          // (a) 게이트 OFF → 즉시 반환, preventDefault 안 함(네이티브 modify() 실행).
          if (!(state.ubSkin && state.ubEditPopup)) return;
          const a = e.target && e.target.closest ? e.target.closest('a[href*="modify("]') : null;
          if (!a) return;
          // (b) 인자 파싱 실패 → 네이티브.
          const args = parseModifyArgs(a.getAttribute('href'));
          if (!args) return;
          // (c) 실제 데이터 행이 아니면 → 네이티브.
          const tr = a.closest('tr');
          if (!tr) return;
          // (d) 패널+iframe 생성. (e) 전부 성공한 뒤에만 preventDefault.
          const url = buildEditPopupUrl(args);
          if (!epOpenPanel(args, url)) return;   // 생성 실패 → 네이티브(preventDefault 안 함)
          e.preventDefault();
          e.stopPropagation();
          epLog('가로챔 — modify', args.master, args.seq);
        } catch (err) {
          // 어떤 예외든 preventDefault 없이 빠져나가 네이티브 링크를 살린다.
          epLog('클릭 처리 실패 → 네이티브 진행', err);
        }
      }, true);
      epLog('intercept bound');
    } catch (e) { epLog('bind 실패', e); }
  }

  function init() {
    ensureDefaultPageSize();
    bindThumbEdit(document);
    bindCopyListener();
    captureSearchBarcode();   // v3.3.3: 바코드 검색칸 입력값 → 클립보드 자동 등록
    autoFocusByPage();   // v3.1.12: 페이지별 커서 자동 포커스
    clearForcedFields(); // v3.3.4: 상품입고장 검색 팝업 입고담당자 항상 공란
    initAssign();        // v3.6.8: 주문전표 재고배정 — 부모 새로고침 제거 + 행 제자리 갱신
    initFactory();       // v3.7.0: 매입처 정보 플로팅창 + 전표 기본탭
    bindEditPopupIntercept(document);   // v3.8.0 작업B: [수정] 가로채기 — 게이트 OFF 여도 항상 idempotent bind(§5)
    initAutoSpike();     // Phase 0: 자동화 배관 검증(기본 OFF, 읽기 전용, 임시)
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
        bindEditPopupIntercept(document);   // v3.8.0 작업B: 팝업에서 켜면 reload 없이 즉시 intercept(idempotent)
      }
    });
  } catch (e) {}
  // 계정 빠른전환: popup 에서 계정 추가/삭제 시(사용자가 ubdstore 탭에 있을 때)
  // 로컬백업을 실시간 갱신. mirrorAccounts 는 localStorage 만 쓰므로 이 onChanged
  // 를 재유발하지 않는다(무한루프 없음).
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && (ch.ubAccounts || ch.ubLoginSalt)) {
        mirrorAccounts();
        // 계정이 바뀌면 매입처 '이름→seq' 캐시를 버린다. 계정마다 매입처 마스터가 다르면
        //  옛 seq 로 다른 업체 정보를 열 수 있다(이름 대조만으론 동명일 때 못 걸러진다).
        try { fwMapMem = null; chrome.storage.local.remove(FW_MAP_KEY); } catch (_) {}
      }
    });
  } catch (_) {}
})();
