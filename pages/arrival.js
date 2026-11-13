/* 입고 지연 목록 페이지 — background.js 가 저장한 storage(ubArrival)를 그린다. 스펙: docs/superpowers/specs/2026-11-13-arrival-delay-design.md §5
 * ⚠ 서버에서 온 문자열은 전부 textContent 로만 넣는다(HTML 주입 API 금지). 인라인 스크립트 금지(MV3 CSP). */
(function () {
  'use strict';
  const LIST_URL = 'http://ubdstore.ubshop.biz/jun/orderitem/orderItemList.do?tcode=order_item';
  const $ = (id) => document.getElementById(id);

  function el(tag, text, cls) {
    const e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }
  function fmtTime(ms) {
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms); const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function render(s) {
    const watch = !!s.ubArrivalWatch;
    const a = s.ubArrival && typeof s.ubArrival === 'object' ? s.ubArrival : null;
    const items = a && Array.isArray(a.items) ? a.items : [];
    const notes = $('notes'); notes.textContent = '';
    $('off').hidden = watch; $('none').hidden = true; $('tbl').hidden = true;
    $('head').textContent = '입고 지연 (FASHION · 14영업일 초과)' + (watch && a ? ' ' + items.length + '건' : '');
    $('refresh').disabled = !watch;
    if (!watch) { $('meta').textContent = ''; return; }
    $('meta').textContent = a ? '마지막 확인 ' + fmtTime(a.at) + (a.ok ? '' : ' (실패 — 아래 목록은 직전 성공 결과)') : '아직 확인한 적이 없습니다 — [지금 다시 확인]';
    if (a && !a.ok) {
      const err = String(a.error || '');
      let msg = '확인하지 못했습니다 (' + err + ')';
      if (err === 'login') msg = '유비샵 로그인이 끊겨 확인하지 못했습니다 — 유비샵에 로그인한 뒤 [지금 다시 확인]';
      else if (/^parse:/.test(err)) msg = '유비샵 목록 화면 구조를 읽지 못했습니다 (' + err + ') — 지연 없음이 아니라 확인 실패입니다';
      else if (/^net:/.test(err)) msg = '유비샵에 연결하지 못했습니다 (' + err + ')';
      notes.appendChild(el('div', msg, 'note warn'));
    }
    if (a && a.capped) notes.appendChild(el('div', '조회가 500행에서 잘렸습니다 — 일부 지연 건이 빠졌을 수 있습니다', 'note warn'));
    if (a && a.ok && a.holidaysOk === false) notes.appendChild(el('div', '공휴일 정보를 새로 받지 못했습니다(지연 판정이 하루이틀 어긋날 수 있음)', 'note'));
    if (!a) return;
    if (!items.length) { if (a.ok) $('none').hidden = false; return; }
    const body = $('body'); body.textContent = '';
    items.forEach((it) => {
      const tr = document.createElement('tr');
      const st = el('td'); st.appendChild(el('span', it.stage === 'post' ? '발주 후' : '발주 전', 'tag' + (it.stage === 'post' ? ' post' : '')));
      tr.appendChild(st);
      tr.appendChild(el('td', String(it.elapsed), 'num el'));
      tr.appendChild(el('td', it.orderDate || ''));
      tr.appendChild(el('td', it.stage === 'post' ? (it.baseFallback ? '미확인' : (it.baljuDate || '')) : ''));
      tr.appendChild(el('td', it.supplier || ''));
      tr.appendChild(el('td', it.title || ''));
      tr.appendChild(el('td', it.qty || '', 'num'));
      tr.appendChild(el('td', it.status || ''));
      const jn = el('td');
      const link = document.createElement('a');
      link.href = LIST_URL; link.target = '_blank'; link.rel = 'noopener';
      link.textContent = it.junNum || it.orderSeq || '열기';
      jn.appendChild(link);
      tr.appendChild(jn);
      body.appendChild(tr);
    });
    $('tbl').hidden = false;
  }

  function load() { chrome.storage.local.get({ ubArrivalWatch: false, ubArrival: null }, render); }
  load();
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.ubArrival || ch.ubArrivalWatch)) load(); });

  $('refresh').addEventListener('click', () => {
    const b = $('refresh'); const orig = b.textContent;
    b.disabled = true; b.textContent = '확인 중…';
    chrome.runtime.sendMessage({ source: 'ub', type: 'arrivalRefresh' }, () => {
      void chrome.runtime.lastError;
      b.textContent = orig; load();
    });
  });
})();
