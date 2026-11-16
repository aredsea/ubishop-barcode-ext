/* 유비샵 페이지 안 '입고 지연' 메뉴 + 플로팅 패널 — 초록 링크 줄 끝에 항목을 넣고, 누르면 목록을 띄운다.
 * 스펙: docs/superpowers/specs/2026-11-13-arrival-delay-design.md · 목록 기준: pages/arrival.js(표 칸·문구·상태 줄 동일).
 * ⚠ 서버에서 온 문자열은 전부 textContent 로만 넣는다(HTML 주입 API 금지). 메뉴 링크 마크업은 상수 문자열이다.
 * ⚠ 페이지 JS 함수 호출 금지 · 네트워크 요청 없음(새로 고침은 서비스 워커 메시지만).
 * ⚠ 최상위 문서에서만 동작한다(프레임이면 즉시 종료). 초록 링크 줄을 못 찾으면 아무것도 하지 않는다. */
(function () {
  'use strict';

  //  ── 순수 함수(테스트용) ──
  function countSuffix(n) { return Number(n) > 0 ? ' ' + Number(n) : ''; }
  function delayCount(a) { return a && typeof a === 'object' && Array.isArray(a.items) ? a.items.length : 0; }
  function headText(watch, a) {
    return '입고 지연 (FASHION · 14영업일 초과)' + (watch && a ? ' ' + delayCount(a) + '건' : '');
  }
  function fmtTime(ms) {
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms); const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function metaText(a) {
    if (!a) return '아직 확인한 적이 없습니다 — [지금 다시 확인]';
    return '마지막 확인 ' + fmtTime(a.at) + (a.ok ? '' : ' (실패 — 아래 목록은 직전 성공 결과)');
  }
  //  → [{text, warn}]
  function noteList(a, atelier) {
    const out = [];
    if (a && !a.ok) {
      const err = String(a.error || '');
      let msg = '확인하지 못했습니다 (' + err + ')';
      if (err === 'login') msg = '유비샵 로그인이 끊겨 확인하지 못했습니다 — 유비샵에 로그인한 뒤 [지금 다시 확인]';
      else if (/^parse:/.test(err)) msg = '유비샵 목록 화면 구조를 읽지 못했습니다 (' + err + ') — 지연 없음이 아니라 확인 실패입니다';
      else if (/^net:/.test(err)) msg = '유비샵에 연결하지 못했습니다 (' + err + ')';
      out.push({ text: msg, warn: true });
    }
    if (a && a.capped) out.push({ text: '조회가 500행에서 잘렸습니다 — 일부 지연 건이 빠졌을 수 있습니다', warn: true });
    if (a && a.ok && a.holidaysOk === false) out.push({ text: '공휴일 정보를 새로 받지 못했습니다(지연 판정이 하루이틀 어긋날 수 있음)', warn: false });
    if (atelier && typeof atelier === 'object' && atelier.error) out.push({ text: '아틀리에 앱 알림 전송에 실패했습니다 (' + String(atelier.error) + ')', warn: false });
    return out;
  }
  function baljuCell(it) { return it.stage === 'post' ? (it.baseFallback ? '미확인' : (it.baljuDate || '')) : ''; }
  function findMenuTd(doc) {
    const as = Array.prototype.slice.call(doc.querySelectorAll('a'));
    const named = (t) => as.find((a) => String(a.textContent || '').replace(/\s+/g, '') === t);
    const a = named('본사매뉴얼') || named('상품상세검색');
    return a ? a.closest('td') : null;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { countSuffix, delayCount, headText, metaText, noteList, baljuCell, fmtTime };
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window !== window.top) return;

  const MENU_ID = 'ub-arr-menu';
  const PANEL_ID = 'ub-arr-panel';
  const STYLE_ID = 'ub-arr-style';
  const LIST_URL = 'http://ubdstore.ubshop.biz/jun/orderitem/orderItemList.do?tcode=order_item';
  let state = { watch: false, arrival: null, atelier: null };

  function el(tag, text, cls) {
    const e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }

  const CSS = '' +
    '#ub-arr-panel{--ub-on:#35C5F0;--ub-fg:#1b1b1b;--ub-sub:#6b7280;--ub-line:#e5e7eb;--ub-soft:#f7f9fc;--ub-bad:#e0483f;' +
    'position:fixed;top:6vh;left:50%;transform:translateX(-50%);width:min(1000px,calc(100vw - 32px));max-height:80vh;overflow:auto;' +
    'z-index:2147483647;background:#fff;color:var(--ub-fg);border:1px solid var(--ub-line);border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.25);' +
    'padding:16px 20px;font:13px/1.5 "Pretendard","Malgun Gothic",sans-serif;box-sizing:border-box}' +
    '#ub-arr-panel *{box-sizing:border-box;font-family:inherit}' +
    '#ub-arr-panel .ub-arr-top{display:flex;align-items:flex-start;gap:10px}' +
    '#ub-arr-panel h2{margin:0;font-size:16px;font-weight:700;flex:1}' +
    '#ub-arr-panel .ub-arr-x{border:0;background:none;font-size:18px;line-height:1;cursor:pointer;color:var(--ub-sub);padding:2px 6px}' +
    '#ub-arr-panel .ub-arr-meta{color:var(--ub-sub);font-size:12px;margin:4px 0 10px}' +
    '#ub-arr-panel .ub-arr-btn{padding:7px 14px;background:var(--ub-on);color:#fff;border:0;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;margin-bottom:10px}' +
    '#ub-arr-panel .ub-arr-btn:disabled{opacity:.5;cursor:default}' +
    '#ub-arr-panel .ub-arr-note{padding:8px 12px;margin-bottom:8px;border-radius:8px;font-size:12px;line-height:1.5;background:var(--ub-soft);border:1px solid var(--ub-line)}' +
    '#ub-arr-panel .ub-arr-note.warn{background:#fff3f3;border-color:#f0b4b4;color:#b42318;font-weight:700}' +
    '#ub-arr-panel .ub-arr-empty{padding:32px 0;text-align:center;color:var(--ub-sub)}' +
    '#ub-arr-panel table{width:100%;border-collapse:collapse}' +
    '#ub-arr-panel th,#ub-arr-panel td{padding:7px 9px;border-bottom:1px solid var(--ub-line);text-align:left;vertical-align:top;font-size:12px}' +
    '#ub-arr-panel th{font-size:11px;color:var(--ub-sub);background:var(--ub-soft);white-space:nowrap}' +
    '#ub-arr-panel .num{text-align:right}' +
    '#ub-arr-panel .el{font-weight:700;color:var(--ub-bad)}' +
    '#ub-arr-panel .tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:700;background:#e0f4fc;color:#0f8fb8}' +
    '#ub-arr-panel .tag.post{background:#eef4f8;color:#0f6f8c}' +
    '#ub-arr-panel a{color:#0f6f8c}';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style'); s.id = STYLE_ID; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  //  ── 메뉴 항목 ──
  function removeMenu() {
    const m = document.getElementById(MENU_ID);
    if (m) m.remove();
    document.querySelectorAll('[data-ub-arr-gap]').forEach((n) => n.remove());
  }
  function updateMenuCount() {
    const m = document.getElementById(MENU_ID); if (!m) return;
    const slot = m.querySelector('.ub-arr-cnt'); if (!slot) return;
    slot.textContent = '';
    const n = delayCount(state.arrival);
    if (n > 0) {
      slot.appendChild(document.createTextNode(' '));
      const b = el('b', String(n)); b.style.color = '#e0483f'; b.style.fontWeight = '700';
      slot.appendChild(b);
    }
  }
  function ensureMenu() {
    if (document.getElementById(MENU_ID)) { updateMenuCount(); return; }
    const td = findMenuTd(document);
    if (!td) return;
    const gap = document.createElement('span'); gap.setAttribute('data-ub-arr-gap', '1');
    gap.textContent = '  ';
    const a = document.createElement('a'); a.id = MENU_ID; a.href = '#';
    //  상수 마크업 — 서버 문자열 없음. 숫자는 updateMenuCount 가 textContent 로 넣는다.
    a.innerHTML = '<span class="f_green_note"><img src="/images/com/icon1.gif" width="10" height="10" align="absmiddle">입고 지연<span class="ub-arr-cnt"></span></span>';
    a.addEventListener('click', (e) => { e.preventDefault(); togglePanel(); });
    td.appendChild(gap); td.appendChild(a);
    updateMenuCount();
  }

  //  ── 패널 ──
  function closePanel() {
    const p = document.getElementById(PANEL_ID); if (p) p.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onOutside, true);
  }
  //  ESC 는 이 패널만 닫고 삼킨다 — 안 막으면 skin.js 의 매입처 정보 창(ESC 닫기)까지 같이 닫힌다(Luna R2 P2).
  function onKey(e) { if (e.key === 'Escape' && document.getElementById(PANEL_ID)) { e.stopPropagation(); e.preventDefault(); closePanel(); } }
  function onOutside(e) {
    const p = document.getElementById(PANEL_ID); if (!p) return;
    if (p.contains(e.target)) return;
    const m = document.getElementById(MENU_ID); if (m && m.contains(e.target)) return;
    closePanel();
  }
  function togglePanel() {
    if (document.getElementById(PANEL_ID)) { closePanel(); return; }
    ensureStyle();
    const p = document.createElement('div'); p.id = PANEL_ID;
    p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', '입고 지연 목록');
    document.body.appendChild(p);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onOutside, true);
    renderPanel();
  }
  function renderPanel() {
    const p = document.getElementById(PANEL_ID); if (!p) return;
    p.textContent = '';
    const a = state.arrival && typeof state.arrival === 'object' ? state.arrival : null;
    const items = a && Array.isArray(a.items) ? a.items : [];
    const top = el('div', null, 'ub-arr-top');
    top.appendChild(el('h2', headText(state.watch, a)));
    const x = el('button', '✕', 'ub-arr-x'); x.type = 'button'; x.setAttribute('aria-label', '닫기');
    x.addEventListener('click', closePanel);
    top.appendChild(x); p.appendChild(top);
    p.appendChild(el('div', metaText(a), 'ub-arr-meta'));
    const btn = el('button', '지금 다시 확인', 'ub-arr-btn'); btn.type = 'button';
    btn.addEventListener('click', () => {
      btn.disabled = true; btn.textContent = '확인 중…';
      try {
        chrome.runtime.sendMessage({ source: 'ub', type: 'arrivalRefresh' }, () => { void chrome.runtime.lastError; load(); });
      } catch (_) { load(); }
    });
    p.appendChild(btn);
    noteList(a, state.atelier).forEach((n) => p.appendChild(el('div', n.text, 'ub-arr-note' + (n.warn ? ' warn' : ''))));
    if (!a) return;
    if (!items.length) { if (a.ok) p.appendChild(el('div', '지연 없음 — 14영업일을 넘긴 미입고 주문이 없어요', 'ub-arr-empty')); return; }
    const tbl = document.createElement('table');
    const thead = document.createElement('thead'); const hr = document.createElement('tr');
    [['단계'], ['경과 영업일', 1], ['주문일'], ['발주일'], ['발주처'], ['상품'], ['수량', 1], ['상태'], ['주문장번호']].forEach((c) => {
      hr.appendChild(el('th', c[0], c[1] ? 'num' : ''));
    });
    thead.appendChild(hr); tbl.appendChild(thead);
    const body = document.createElement('tbody');
    items.forEach((it) => {
      const tr = document.createElement('tr');
      const st = el('td'); st.appendChild(el('span', it.stage === 'post' ? '발주 후' : '발주 전', 'tag' + (it.stage === 'post' ? ' post' : '')));
      tr.appendChild(st);
      tr.appendChild(el('td', String(it.elapsed), 'num el'));
      tr.appendChild(el('td', it.orderDate || ''));
      tr.appendChild(el('td', baljuCell(it)));
      tr.appendChild(el('td', it.supplier || ''));
      tr.appendChild(el('td', it.title || ''));
      tr.appendChild(el('td', it.qty || '', 'num'));
      tr.appendChild(el('td', it.status || ''));
      const jn = el('td');
      const link = document.createElement('a');
      link.href = LIST_URL; link.target = '_blank'; link.rel = 'noopener';
      link.textContent = it.junNum || it.orderSeq || '열기';
      jn.appendChild(link); tr.appendChild(jn);
      body.appendChild(tr);
    });
    tbl.appendChild(body); p.appendChild(tbl);
  }

  //  ── 상태 ──
  function apply() {
    if (!state.watch) { closePanel(); removeMenu(); return; }
    ensureMenu(); updateMenuCount(); renderPanel();
  }
  function load() {
    try {
      chrome.storage.local.get({ ubArrivalWatch: true, ubArrival: null, ubArrivalAtelier: null }, (s) => {
        //  읽기 실패(확장 재시작 직후 등)면 옛 메뉴·패널을 남기지 않고 걷어 낸다(Luna R1 P2).
        if (chrome.runtime.lastError || !s) { state = { watch: false, arrival: null, atelier: null }; closePanel(); removeMenu(); return; }
        state = { watch: !!s.ubArrivalWatch, arrival: s.ubArrival || null, atelier: s.ubArrivalAtelier || null };
        apply();
      });
    } catch (_) { state = { watch: false, arrival: null, atelier: null }; closePanel(); removeMenu(); }
  }
  function start() {
    load();
    try {
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && (ch.ubArrival || ch.ubArrivalWatch || ch.ubArrivalAtelier)) load();
      });
    } catch (_) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
