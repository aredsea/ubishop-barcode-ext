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
    ubSidebar: true, ubPageSize: true, ubAutoSync: false,
    ubSbMode: 'docked', ubSbX: 24, ubSbY: 24, ubSbCollapsed: false,
    ubBarcodes: []
  };
  const state = Object.assign({}, D);
  const on = (k) => state.ubSkin && state[k];
  const MAX_BARCODES = 12;
  // 정확한 바코드 패턴: 년도(21~26) + 영숫자 4자리(영문 ≥1).
  // 예: 2606WH(26+06WH), 24010D(24+010D), 230M56(23+0M56).
  // "14K" 같은 짧은 단어/금속표기는 제외(년도 prefix 강제).
  const BARCODE_RE = /\b2[1-6][A-Z0-9]{4}\b/g;
  // 클립보드 버튼 → navigator.clipboard 실패 시 fallback execCommand가
  // 자체 copy 이벤트를 트리거 → addBarcodes 재진입으로 순서 어그러짐 방지.
  let _suppressNextCopy = false;

  try { console.log('[UB][skin] v2.8 loaded', { isTop: window === window.top, path: location.pathname }); } catch (_) {}

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
  // 썸네일 → 상품수정 새 창.
  // ⚠ capture+preventDefault만으로는 일부 환경에서 javascript:imageView가
  //   여전히 동작(원인 불명, v2.6 실측). 가장 확실한 방법: 부모 a.href를
  //   우리 수정 URL로 덮어쓰고 target=_blank 설정 → chrome native가 새 탭.
  //   추가로 click capture에서 직접 window.open으로 이중 보장.
  function reapplyThumbHref(a, seq) {
    if (!on('ubThumbEdit')) return;
    a.href = editUrl(seq);
    a.target = '_blank';
    a.rel = 'noopener';
    a.removeAttribute('onclick');   // 인라인 onclick 제거(있다면)
  }
  function attachThumb(img, seq) {
    if (img.dataset.ubEdit) return;
    img.dataset.ubEdit = seq;
    img.style.cursor = 'pointer';
    img.title = '상품 수정 (새 창)';

    const a = img.closest('a');
    if (a) {
      a.dataset.ubEdit = seq;
      if (!a.dataset.ubOrigHref) a.dataset.ubOrigHref = a.getAttribute('href') || '';
      reapplyThumbHref(a, seq);
      // 페이지가 href를 다시 javascript:imageView로 reset할 때 즉시 복원
      const mo = new MutationObserver(() => reapplyThumbHref(a, seq));
      try { mo.observe(a, { attributes: true, attributeFilter: ['href', 'target', 'onclick'] }); } catch (_) {}
      // 이중 보장: click capture에서 강제 새 탭
      a.addEventListener('click', (e) => {
        if (!on('ubThumbEdit')) return;
        // a.href가 우리 URL이면 chrome native가 알아서 새 탭, 그래도 명시적으로
        // window.open 호출 + default 막아 race condition 제거.
        e.preventDefault(); e.stopImmediatePropagation();
        window.open(editUrl(seq), '_blank', 'noopener');
      }, true);
    } else {
      // a 태그 없는 경우만 img 자체에 click attach (드문 케이스)
      img.addEventListener('click', (e) => {
        if (!on('ubThumbEdit')) return;
        e.preventDefault(); e.stopImmediatePropagation();
        window.open(editUrl(seq), '_blank', 'noopener');
      }, true);
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
  function ensureDefaultPageSize() {
    if (!on('ubPageSize')) return;
    if (hasPageSizeParam()) return;
    if (sessionStorage.getItem('ub_ps_redirected_' + location.pathname)) return;
    if (!/(List|ListForm)\.do$/i.test(location.pathname)) return;
    sessionStorage.setItem('ub_ps_redirected_' + location.pathname, '1');
    const u = new URL(location.href);
    u.searchParams.set('pageSize', '100');
    location.replace(u.toString());
  }
  function injectPageSizeOptions() {
    if (!on('ubPageSize')) return;
    const sels = document.querySelectorAll('select[name=pageSize]');
    const want = ['20', '50', '100', '300', '500'];
    sels.forEach(sel => {
      const existing = new Set([...sel.options].map(o => o.value));
      want.forEach(v => {
        if (!existing.has(v)) {
          const op = document.createElement('option');
          op.value = v; op.text = v + '개';
          sel.appendChild(op);
        }
      });
      const cur = new URL(location.href).searchParams.get('pageSize') || '20';
      if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
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
  const SIDEBAR_CSS = `
    .ub-sidebar {
      width: 240px; background: linear-gradient(180deg, #ffffff 0%, #f7f9fc 100%);
      border: 1px solid #e5e7eb; box-shadow: 0 8px 24px rgba(15,20,25,.08);
      border-radius: 12px; z-index: 2147483646;
      font-family: 'Pretendard','Malgun Gothic',sans-serif; color: #1b1b1b;
      padding: 12px; box-sizing: border-box; overflow-y: auto;
      transition: opacity .15s ease;
    }
    .ub-sidebar.ub-mode-docked {
      position: fixed; top: 0; left: 0; height: 100vh; width: 240px;
      border-radius: 0; border-left: none; border-top: none; border-bottom: none;
      box-shadow: 2px 0 12px rgba(15,20,25,.06);
      background: linear-gradient(180deg, #ffffff 0%, #f7f9fc 100%);
    }
    .ub-sidebar.ub-mode-floating {
      position: fixed; max-height: calc(100vh - 48px);
    }
    .ub-sidebar.ub-collapsed { display: none; }
    html.ub-dark .ub-sidebar {
      background: linear-gradient(180deg, #161b22 0%, #0d1117 100%) !important;
      border-color: #30363d !important; color: #c9d1d9 !important;
      box-shadow: 0 8px 24px rgba(0,0,0,.5) !important;
    }
    html.ub-sidebar-docked body { margin-left: 244px !important; }
    @media (max-width: 900px) { html.ub-sidebar-docked body { margin-left: 0 !important; } }

    .ub-sidebar .ub-sb-hd {
      display: flex; align-items: center; gap: 6px;
      padding: 2px 4px 10px; border-bottom: 1px solid #eef0f3; margin-bottom: 10px;
      cursor: default;
    }
    .ub-sidebar.ub-mode-floating .ub-sb-hd { cursor: move; }
    html.ub-dark .ub-sidebar .ub-sb-hd { border-bottom-color: #30363d !important; }
    .ub-sidebar .ub-sb-dot { width: 8px; height: 8px; border-radius: 50%; background: #35C5F0; flex: none; }
    .ub-sidebar .ub-sb-title { font-size: 13px; font-weight: 700; }
    .ub-sidebar .ub-sb-actions { margin-left: auto; display: flex; gap: 4px; }
    .ub-sidebar .ub-ico {
      width: 22px; height: 22px; border: 1px solid #e5e7eb; background: #fff;
      border-radius: 6px; cursor: pointer; font-size: 12px; color: #6b7280;
      line-height: 20px; text-align: center; padding: 0; flex: none;
    }
    .ub-sidebar .ub-ico:hover { border-color: #35C5F0; color: #0f8fb8; }
    html.ub-dark .ub-sidebar .ub-ico {
      background: #0d1117 !important; border-color: #30363d !important; color: #9ca5b5 !important;
    }
    html.ub-dark .ub-sidebar .ub-ico:hover { background: #1c2733 !important; color: #58c5f0 !important; }

    .ub-sidebar .ub-sb-sect { margin-bottom: 14px; }
    .ub-sidebar .ub-sb-sect-t {
      font-size: 10.5px; font-weight: 700; letter-spacing: .03em;
      color: #6b7280; text-transform: uppercase; margin: 0 4px 6px;
    }
    html.ub-dark .ub-sidebar .ub-sb-sect-t { color: #8b949e !important; }
    .ub-sidebar .ub-sb-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
    .ub-sidebar .ub-sb-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 5px; }
    .ub-sidebar .ub-sb-btn {
      display: flex; align-items: center; justify-content: center;
      padding: 8px 4px; border: 1px solid #e5e7eb; background: #fff; border-radius: 7px;
      font-size: 11.5px; font-weight: 600; color: #374151; cursor: pointer;
      transition: all .12s ease; user-select: none; line-height: 1.1;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    html.ub-dark .ub-sidebar .ub-sb-btn {
      background: #0d1117 !important; border-color: #30363d !important; color: #c9d1d9 !important;
    }
    .ub-sidebar .ub-sb-btn:hover { border-color: #35C5F0; color: #0f8fb8; background: #f0f9ff; }
    html.ub-dark .ub-sidebar .ub-sb-btn:hover {
      background: #1c2733 !important; color: #58c5f0 !important; border-color: #35C5F0 !important;
    }
    .ub-sidebar .ub-sb-btn.ub-sb-wide { grid-column: 1 / -1; }
    .ub-sidebar .ub-sb-btn.ub-bc-btn { font-family: ui-monospace, 'Consolas', monospace; font-size: 11px; padding: 7px 3px; }
    .ub-sidebar .ub-sb-empty {
      padding: 10px; text-align: center; font-size: 10.5px; color: #9ca3af;
      background: #f9fafb; border-radius: 7px; border: 1px dashed #e5e7eb;
      line-height: 1.5;
    }
    html.ub-dark .ub-sidebar .ub-sb-empty {
      background: #161b22 !important; color: #6e7681 !important; border-color: #30363d !important;
    }
    .ub-sidebar .ub-toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      padding: 8px 14px; background: rgba(15,20,25,.92); color: #fff;
      border-radius: 999px; font-size: 12px; z-index: 2147483647;
      pointer-events: none; opacity: 0; transition: opacity .2s;
    }
    .ub-sidebar .ub-toast.show { opacity: 1; }

    /* 접힌 상태 핸들 — 사이드바 숨김 시 좌측 가장자리에 노출 */
    #ub-sb-handle {
      position: fixed; top: 50%; left: 0; transform: translateY(-50%);
      width: 22px; height: 60px; background: #35C5F0; color: #fff;
      border: none; border-radius: 0 8px 8px 0; cursor: pointer;
      font-size: 14px; font-weight: 700; z-index: 2147483645;
      box-shadow: 2px 0 8px rgba(15,20,25,.15); padding: 0; line-height: 60px;
    }
    #ub-sb-handle:hover { background: #2bb5e0; width: 26px; }
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
  function ensureHandle() {
    if (document.getElementById(HANDLE_ID)) return;
    if (!document.body) return;
    const h = document.createElement('button');
    h.id = HANDLE_ID; h.textContent = '›'; h.title = 'D102 도구 열기';
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

    bar.innerHTML = `
      <div class="ub-sb-hd">
        <div class="ub-sb-dot"></div>
        <div class="ub-sb-title">D102 도구</div>
        <div class="ub-sb-actions">
          <button class="ub-ico" data-act="mode" title="${isFloat ? '왼쪽으로 붙이기' : '플로팅 모드'}">${isFloat ? '⇤' : '⇱'}</button>
          <button class="ub-ico" data-act="collapse" title="접기">×</button>
        </div>
      </div>

      ${dateBtns ? `
        <div class="ub-sb-sect">
          <div class="ub-sb-sect-t">날짜 빠른선택 (검색은 직접)</div>
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
        <div class="ub-sb-empty">날짜 검색이 가능한<br>리스트 페이지에서<br>빠른선택이 표시됩니다.</div>
      `}

      <div class="ub-sb-sect">
        <div class="ub-sb-sect-t">바코드 클립보드 (최대 ${MAX_BARCODES})</div>
        ${codes.length ? `
          <div class="ub-sb-grid-3">
            ${codes.map(b => `<button class="ub-sb-btn ub-bc-btn" data-bc="${b.c}" title="복사: ${b.c}">${b.c}</button>`).join('')}
          </div>
          <button class="ub-sb-btn ub-sb-wide" data-act="bc-clear" style="margin-top:6px;font-size:10.5px;color:#9ca3af">모두 지우기</button>
        ` : `
          <div class="ub-sb-empty">페이지에서 바코드 형태(예: 2606WH)<br>텍스트를 복사하면 자동 저장됩니다.</div>
        `}
      </div>
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
    // 윈도우 리사이즈 시 플로팅 사이드바 안 보이는 곳으로 가지 않게 보정
    window.addEventListener('resize', () => {
      const bar = document.getElementById(SIDEBAR_ID);
      if (bar && state.ubSbMode === 'floating') applySbPosition(bar);
    });
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
