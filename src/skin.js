/* =============================================================================
 *  skin.js — 유비샵 스킨모드. ISOLATED, all_frames, document_start.
 *  팝업(확장 액션)에서 마스터(ubSkin) + 세부옵션을 토글한다. 기본 OFF.
 *
 *  세부옵션 (모두 ubSkin 게이팅):
 *    ubDark      : 다크 테마(실제 색상 매핑, invert 폐기)
 *    ubThumbEdit : 기초상품관리 이미지보기에서 썸네일 클릭 → 상품수정 새 창
 *    ubSidebar   : 좌측 플로팅 사이드바(날짜 빠른선택 등) — 기본 ON
 *    ubPageSize  : 리스트 페이지 기본 100 + 옵션 100/300/500 — 기본 ON
 *    ubAutoSync  : 전표 자동 분할조회+캐시(아직 미구현, 토글만) — 기본 OFF
 *
 *  v2.6.0 — invert 다크 폐기, 실제 다크 테마. 사이드바/페이지사이즈/A안 토글 추가.
 *  v2.5.0 — frameset safety + 썸네일 보강(stopImmediatePropagation).
 * ========================================================================== */
(function () {
  'use strict';

  const D = {
    ubSkin: false, ubDark: false, ubThumbEdit: true,
    ubSidebar: true, ubPageSize: true, ubAutoSync: false
  };
  const state = Object.assign({}, D);
  const on = (k) => state.ubSkin && state[k];

  try { console.log('[UB][skin] v2.6 loaded', { isTop: window === window.top, path: location.pathname }); } catch (_) {}

  /* ==========================================================================
   *  1) 다크 테마 — invert 폐기, 실제 색상 매핑.
   *     팔레트: GitHub dark dimmed + 시안 액센트(#35C5F0).
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
    /* 검색 결과 강조행/합계행이 inline bgcolor 쓰는 경우 흔함 — 어둡게 덮어쓰기 */
    html.ub-dark [bgcolor], html.ub-dark [style*="background-color"], html.ub-dark [style*="background:"] {
      background-color: #161b22 !important;
    }
    html.ub-dark [bgcolor="#EFEFEF"], html.ub-dark [bgcolor="#efefef"] { background-color: #1f242c !important; }
    html.ub-dark [bgcolor="#FFFFFF"], html.ub-dark [bgcolor="#ffffff"], html.ub-dark [bgcolor="white"] {
      background-color: #161b22 !important;
    }
    /* note 툴팁(div.tooltip2) */
    html.ub-dark div.tooltip2, html.ub-dark .tooltip2 {
      background-color: #21262d !important; color: #e6edf3 !important;
      border: 1px solid #30363d !important; box-shadow: 0 8px 24px rgba(0,0,0,.4) !important;
    }
    /* select option 풀다운 */
    html.ub-dark option { background-color: #161b22 !important; color: #e6edf3 !important; }
    /* placeholder */
    html.ub-dark ::placeholder { color: #6e7681 !important; opacity: 1 !important; }
    /* 강조 텍스트 흰색 유지 */
    html.ub-dark b, html.ub-dark strong { color: #e6edf3 !important; }
    /* 셀렉션 색 */
    html.ub-dark ::selection { background: rgba(53,197,240,.35) !important; color: #fff !important; }
    /* 우리 사이드바 본체는 다크의 영향 받지 않게 (자기 CSS 사용) */
    html.ub-dark .ub-sidebar, html.ub-dark .ub-sidebar * {
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
   *  2) 썸네일 → 상품수정 새 창 (기초상품관리 이미지보기)
   *     - MutationObserver 로 동적 추가 img 도 잡음
   *     - capture 단계 + stopImmediatePropagation + mousedown/mouseup/click 다 차단
   *     - 부모 a 태그 navigation 도 무력화
   * ========================================================================== */
  const MASTER_RE = /\/master\/item\/masterItemList/i;
  function isThumb(im) {
    const s = im.src || im.getAttribute('src') || '';
    return /\/s_\d+\.(jpe?g|png|gif)/i.test(s) || /no_image\.gif/i.test(s);
  }
  function editUrl(seq) {
    return '/master/item/masterItemModifyForm.do?tcode=master_item&seq=' + encodeURIComponent(seq);
  }
  function attachThumb(img, seq) {
    if (img.dataset.ubEdit) return;
    img.dataset.ubEdit = seq;
    img.style.cursor = 'pointer';
    img.title = '상품 수정 (새 창으로 열기)';
    const block = (e) => {
      if (!on('ubThumbEdit')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'click') window.open(editUrl(seq), '_blank');
    };
    ['mousedown', 'mouseup', 'click'].forEach(ev => img.addEventListener(ev, block, true));
    img.addEventListener('mouseenter', () => { if (on('ubThumbEdit')) img.style.outline = '2px solid #35C5F0'; });
    img.addEventListener('mouseleave', () => { img.style.outline = ''; });
    // 부모 a 태그 navigation 도 차단
    const a = img.closest('a');
    if (a && !a.dataset.ubEdit) {
      a.dataset.ubEdit = seq;
      ['mousedown', 'mouseup', 'click'].forEach(ev => a.addEventListener(ev, (e) => {
        if (!on('ubThumbEdit')) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.type === 'click') window.open(editUrl(seq), '_blank');
      }, true));
    }
  }
  // 썸네일 IMG 바로 뒤 idx 체크박스(value=seq) 페어링
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
   *  3) 페이지사이즈 — 검색/주문전표/발주전표/입고전표/매장출고전표 등
   *     리스트 페이지에서 pageSize 옵션에 100/300/500 추가 + 첫 진입 100.
   * ========================================================================== */
  // pageSize 파라미터를 쓰는 페이지(URL 쿼리에 명시적으로 등장)인지 확인.
  function hasPageSizeParam() {
    return /[?&]pageSize=/.test(location.search);
  }
  // 진입 시 pageSize 파라미터 없으면 기본 100으로 1회 redirect.
  function ensureDefaultPageSize() {
    if (!on('ubPageSize')) return;
    if (hasPageSizeParam()) return;
    if (sessionStorage.getItem('ub_ps_redirected_' + location.pathname)) return;
    // 리스트 페이지로 보이는 경우만(가벼운 휴리스틱): URL 끝이 List.do 또는 ListForm.do
    if (!/(List|ListForm)\.do$/i.test(location.pathname)) return;
    sessionStorage.setItem('ub_ps_redirected_' + location.pathname, '1');
    const u = new URL(location.href);
    u.searchParams.set('pageSize', '100');
    location.replace(u.toString());
  }
  // select[name=pageSize] 옵션 추가(중복 방지) + 100 selected.
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
      // 현재 URL pageSize 와 select 값 동기화
      const cur = new URL(location.href).searchParams.get('pageSize') || '20';
      if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
    });
  }

  /* ==========================================================================
   *  4) 좌측 사이드바 — floating fixed, 항상 유지.
   *     첫 기능: 날짜 빠른선택(오늘/어제/3일/7일/한달/분기/일년).
   * ========================================================================== */
  const SIDEBAR_ID = 'ub-sidebar';
  const SIDEBAR_STYLE_ID = 'ub-sidebar-style';
  const SIDEBAR_CSS = `
    .ub-sidebar {
      position: fixed; top: 0; left: 0; width: 220px; height: 100vh;
      background: linear-gradient(180deg, #ffffff 0%, #f7f9fc 100%);
      border-right: 1px solid #e5e7eb; box-shadow: 2px 0 12px rgba(15,20,25,.06);
      z-index: 2147483646; font-family: 'Pretendard','Malgun Gothic',sans-serif;
      color: #1b1b1b; padding: 14px 12px; box-sizing: border-box; overflow-y: auto;
      transition: transform .2s ease;
    }
    .ub-sidebar.ub-collapsed { transform: translateX(-200px); }
    html.ub-dark .ub-sidebar {
      background: linear-gradient(180deg, #161b22 0%, #0d1117 100%) !important;
      border-right-color: #30363d !important; color: #c9d1d9 !important;
      box-shadow: 2px 0 12px rgba(0,0,0,.4) !important;
    }
    .ub-sidebar .ub-sb-hd {
      display: flex; align-items: center; gap: 8px;
      padding: 4px 4px 12px; border-bottom: 1px solid #eef0f3; margin-bottom: 12px;
    }
    html.ub-dark .ub-sidebar .ub-sb-hd { border-bottom-color: #30363d !important; }
    .ub-sidebar .ub-sb-hd .ub-sb-dot { width: 8px; height: 8px; border-radius: 50%; background: #35C5F0; }
    .ub-sidebar .ub-sb-hd .ub-sb-title { font-size: 13px; font-weight: 700; }
    .ub-sidebar .ub-sb-hd .ub-sb-toggle {
      margin-left: auto; width: 22px; height: 22px; border: 1px solid #e5e7eb; background: #fff;
      border-radius: 6px; cursor: pointer; font-size: 11px; color: #6b7280; line-height: 1;
    }
    html.ub-dark .ub-sidebar .ub-sb-hd .ub-sb-toggle {
      background: #0d1117 !important; border-color: #30363d !important; color: #9ca5b5 !important;
    }
    .ub-sidebar .ub-sb-sect { margin-bottom: 16px; }
    .ub-sidebar .ub-sb-sect-t {
      font-size: 10.5px; font-weight: 700; letter-spacing: .03em;
      color: #6b7280; text-transform: uppercase; margin: 0 4px 8px;
    }
    html.ub-dark .ub-sidebar .ub-sb-sect-t { color: #8b949e !important; }
    .ub-sidebar .ub-sb-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .ub-sidebar .ub-sb-btn {
      display: flex; align-items: center; justify-content: center; gap: 4px;
      padding: 9px 6px; border: 1px solid #e5e7eb; background: #fff; border-radius: 8px;
      font-size: 12px; font-weight: 600; color: #374151; cursor: pointer;
      transition: all .12s ease; user-select: none;
    }
    html.ub-dark .ub-sidebar .ub-sb-btn {
      background: #0d1117 !important; border-color: #30363d !important; color: #c9d1d9 !important;
    }
    .ub-sidebar .ub-sb-btn:hover {
      border-color: #35C5F0; color: #0f8fb8; background: #f0f9ff;
    }
    html.ub-dark .ub-sidebar .ub-sb-btn:hover {
      background: #1c2733 !important; color: #58c5f0 !important; border-color: #35C5F0 !important;
    }
    .ub-sidebar .ub-sb-btn.ub-sb-wide { grid-column: 1 / -1; }
    .ub-sidebar .ub-sb-empty {
      padding: 12px; text-align: center; font-size: 11px; color: #9ca3af;
      background: #f9fafb; border-radius: 8px; border: 1px dashed #e5e7eb;
    }
    html.ub-dark .ub-sidebar .ub-sb-empty {
      background: #161b22 !important; color: #6e7681 !important; border-color: #30363d !important;
    }
    /* 페이지 본문 좌측 여백 — 사이드바 너비만큼 밀기 */
    html.ub-sidebar-on body { margin-left: 224px !important; }
    /* 작은 화면: 사이드바 접힘 + 본문 여백 제거 */
    @media (max-width: 900px) {
      html.ub-sidebar-on body { margin-left: 0 !important; }
      .ub-sidebar { transform: translateX(-200px); }
      .ub-sidebar:hover { transform: none; }
    }
  `;
  function ensureSidebarStyle() {
    if (document.getElementById(SIDEBAR_STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = SIDEBAR_STYLE_ID; s.textContent = SIDEBAR_CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  // YYYY-MM-DD 분해
  function ymd(d) { return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }; }
  function dateRange(kind) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(today), end = new Date(today);
    switch (kind) {
      case 'today':     break;
      case 'yesterday': start.setDate(today.getDate() - 1); end.setDate(today.getDate() - 1); break;
      case 'd3':        start.setDate(today.getDate() - 2); break;        // today 포함 3일
      case 'd7':        start.setDate(today.getDate() - 6); break;        // today 포함 7일
      case 'm1':        start.setMonth(today.getMonth() - 1); break;
      case 'q1':        start.setMonth(today.getMonth() - 3); break;
      case 'y1':        start.setFullYear(today.getFullYear() - 1); break;
    }
    return { s: ymd(start), e: ymd(end) };
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  // 현재 URL에 syear/smonth/sday/eyear/emonth/eday 만 갈아끼우고 navigate.
  // (pageSize/searchSortType 등 다른 파라미터는 보존)
  function applyDateRange(kind) {
    const r = dateRange(kind);
    const u = new URL(location.href);
    u.searchParams.set('syear', String(r.s.y));
    u.searchParams.set('smonth', pad2(r.s.m));
    u.searchParams.set('sday',  pad2(r.s.d));
    u.searchParams.set('eyear', String(r.e.y));
    u.searchParams.set('emonth', pad2(r.e.m));
    u.searchParams.set('eday',  pad2(r.e.d));
    u.searchParams.set('reqPage', '1');
    // 페이지사이즈 옵션 켜져 있고 명시 안 됐으면 100
    if (on('ubPageSize') && !u.searchParams.has('pageSize')) u.searchParams.set('pageSize', '100');
    location.href = u.toString();
  }
  // 현재 페이지가 날짜 파라미터를 받는 페이지인지(syear 파라미터가 있거나, 리스트 페이지 패턴)
  function isDateSearchPage() {
    const sp = new URLSearchParams(location.search);
    if (sp.has('syear') || sp.has('eyear')) return true;
    return /(List|ListForm)\.do$/i.test(location.pathname);
  }
  function renderSidebar() {
    if (!on('ubSidebar')) {
      const old = document.getElementById(SIDEBAR_ID);
      if (old) old.remove();
      document.documentElement.classList.remove('ub-sidebar-on');
      return;
    }
    if (!document.body) return;
    ensureSidebarStyle();
    document.documentElement.classList.add('ub-sidebar-on');
    let bar = document.getElementById(SIDEBAR_ID);
    if (!bar) {
      bar = document.createElement('aside');
      bar.id = SIDEBAR_ID; bar.className = 'ub-sidebar';
      document.body.appendChild(bar);
    }
    const dateSect = isDateSearchPage() ? `
      <div class="ub-sb-sect">
        <div class="ub-sb-sect-t">날짜 빠른선택</div>
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
    `;
    bar.innerHTML = `
      <div class="ub-sb-hd">
        <div class="ub-sb-dot"></div>
        <div class="ub-sb-title">D102 도구</div>
        <button class="ub-sb-toggle" title="사이드바 접기">‹</button>
      </div>
      ${dateSect}
    `;
    // 이벤트
    bar.querySelectorAll('.ub-sb-btn').forEach(b => {
      b.addEventListener('click', () => applyDateRange(b.dataset.r));
    });
    const toggle = bar.querySelector('.ub-sb-toggle');
    toggle && toggle.addEventListener('click', () => {
      const collapsed = bar.classList.toggle('ub-collapsed');
      toggle.textContent = collapsed ? '›' : '‹';
      document.documentElement.classList.toggle('ub-sidebar-on', !collapsed);
    });
  }

  /* ==========================================================================
   *  적용 / 구독
   * ========================================================================== */
  function applyAll() {
    applyDark();
    renderSidebar();
    injectPageSizeOptions();
    // 썸네일 스타일 재적용(이미 attach 된 것들의 cursor/title)
    document.querySelectorAll('img[data-ub-edit]').forEach(img => {
      img.style.cursor = on('ubThumbEdit') ? 'pointer' : '';
      img.title = on('ubThumbEdit') ? '상품 수정 (새 창)' : '';
    });
  }
  // 페이지 변경/동적 추가 대응
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
      // 사이드바가 사라졌으면 다시 추가
      if (!document.getElementById(SIDEBAR_ID) && on('ubSidebar')) needSidebar = true;
      if (needSidebar) renderSidebar();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
  function init() {
    ensureDefaultPageSize();          // 첫 진입 시 redirect (있을 경우)
    bindThumbEdit(document);
    applyAll();
    startObserver();
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
  } catch (e) { /* storage 권한/컨텍스트 문제 시 무시 */ }
})();
