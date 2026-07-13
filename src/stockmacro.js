/* =============================================================================
 *  stockmacro.js — 상품입고 'D102 도구' 창 (재고화 매크로 호스트). loader 관리 → push.
 *  inputItemWriteForm.do 에서만. 창=이동/크기조절/잠금/접기, 위치·크기 localStorage 저장.
 *  · 재고화: 바코드 → inputItemList(입고장번호) → inputItemJunList(junSeq) → form2.jun 제출.
 *    ⚠ 등록(재고화 쓰기)은 절대 자동 안 함 — 입고장 로드까지만. 날짜=태초(2000-01-01)~오늘.
 *  · 앞으로 다른 작업 매크로도 이 창 body(.sec)에 섹션으로 추가.
 * ========================================================================== */
(function () {
  'use strict';
  if (!/\/input\/item\/inputItemWriteForm\.do/.test(location.pathname)) return;
  if (window.__ubStockMacro) return; window.__ubStockMacro = 1;

  const TAG = '[UB][stockmacro]';
  const log = (...a) => { try { console.log(TAG, ...a); } catch (_) {} };

  /* ---------- 재고화 매크로 로직 ---------- */
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
    if (!f2 || !f2.jun) { log('form2/jun 없음'); return false; }
    f2.jun.value = seq;
    log('form2.jun =', seq, '→ submit');
    f2.submit();
    return true;
  }

  let busy = false;
  async function run(barcode, setStatus) {
    barcode = (barcode || '').trim();
    if (!barcode) { setStatus('바코드를 입력하세요', 'warn'); return; }
    if (busy) return; busy = true;
    try {
      setStatus('전표 조회 중…', 'go');
      const junNum = await barcodeToJunNum(barcode);
      if (!junNum) { setStatus('입고장번호를 못 찾음 — 바코드 확인', 'err'); return; }
      setStatus('입고장 ' + junNum + ' 확인 중…', 'go');
      const seq = await junNumToSeq(junNum);
      if (!seq) { setStatus('입고장 seq를 못 찾음 (' + junNum + ')', 'err'); return; }
      try { localStorage.setItem('UB_STOCK_LAST', JSON.stringify({ barcode: barcode, junNum: junNum, seq: seq })); } catch (_) {}
      log('barcode', barcode, '→ junNum', junNum, '→ seq', seq);
      setStatus('입고장 ' + junNum + ' 불러오는 중…', 'go');
      loadVoucher(seq);   // 페이지 리로드 → 입고장 로드(사람이 확인 후 재고화 등록)
    } catch (e) {
      log('실패', e); setStatus('실패: ' + (e && e.message ? e.message : e), 'err');
    } finally { busy = false; }
  }

  /* ---------- D102 도구 창 (이동/리사이즈/잠금/접기) ---------- */
  const WKEY = 'UB_TOOL_WIN_v1';
  const DEF = { left: null, top: 118, w: 258, h: 176, locked: false, min: false };
  function loadWin() { try { return { ...DEF, ...(JSON.parse(localStorage.getItem(WKEY) || '{}')) }; } catch (_) { return { ...DEF }; } }
  function saveWin(s) { try { localStorage.setItem(WKEY, JSON.stringify(s)); } catch (_) {} }
  const LOCK_ON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  const LOCK_OFF = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V6a4 4 0 0 1 7.5-2"/></svg>';

  function ensureStyle() {
    if (document.getElementById('ub-tool-style')) return;
    const s = document.createElement('style');
    s.id = 'ub-tool-style';
    s.textContent = [
      "@font-face{font-family:'PretendardUB';font-style:normal;font-weight:100 900;font-display:swap;src:url('https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/variable/woff2/PretendardVariable.woff2') format('woff2-variations');}",
      "#ub-tool{position:fixed;z-index:2147483000;background:#fff;border:1px solid #dde7ee;border-radius:15px;box-shadow:0 10px 34px rgba(16,40,60,.22);font-family:'PretendardUB','Malgun Gothic',sans-serif;-webkit-font-smoothing:antialiased;display:flex;flex-direction:column;overflow:hidden;min-width:210px;}",
      '#ub-tool *{font-family:inherit;box-sizing:border-box;}',
      '#ub-tool .hd{flex:0 0 auto;background:linear-gradient(180deg,#123542,#0e2a37);color:#dff2f9;font-weight:700;font-size:12.5px;letter-spacing:-.01em;padding:9px 8px 9px 12px;display:flex;align-items:center;gap:7px;cursor:move;user-select:none;}',
      '#ub-tool.locked .hd{cursor:default;}',
      '#ub-tool .hd .dot{width:7px;height:7px;border-radius:50%;background:#35C5F0;box-shadow:0 0 0 3px rgba(53,197,240,.25);flex:0 0 auto;}',
      '#ub-tool .hd .ttl{flex:1;}',
      '#ub-tool .hd .ctl{display:flex;gap:1px;align-items:center;}',
      '#ub-tool .hd .btn{width:23px;height:23px;display:flex;align-items:center;justify-content:center;border:0;background:transparent;color:#9fc6d6;cursor:pointer;border-radius:7px;font-size:12px;line-height:1;padding:0;transition:.12s;}',
      '#ub-tool .hd .btn:hover{background:rgba(255,255,255,.13);color:#eaf7fc;}',
      '#ub-tool.locked .hd .lock{color:#ffd070;}',
      '#ub-tool .body{flex:1 1 auto;overflow:auto;padding:12px 13px 13px;}',
      '#ub-tool.min .body,#ub-tool.min .rz{display:none;}',
      '#ub-tool .sec-t{font-size:10.5px;font-weight:700;color:#0f6f8c;margin:0 0 7px 1px;letter-spacing:.03em;}',
      '#ub-tool .sec-row{display:flex;gap:6px;}',
      '#ub-tool .sec-row input{flex:1;min-width:0;padding:9px 11px;border:1px solid #cdd8e0;border-radius:10px;font-size:13px;font-weight:600;letter-spacing:.02em;color:#1e2a33;}',
      '#ub-tool .sec-row input:focus{outline:0;border-color:#35C5F0;box-shadow:0 0 0 3px rgba(53,197,240,.18);}',
      '#ub-tool .sec-row input::placeholder{color:#aab7c0;font-weight:500;letter-spacing:0;}',
      '#ub-tool .sec-row button{padding:9px 13px;border:0;border-radius:10px;background:linear-gradient(180deg,#3fcdf3,#22b6e6);color:#fff;font-weight:700;font-size:12.5px;cursor:pointer;white-space:nowrap;box-shadow:0 2px 9px rgba(34,182,230,.38);}',
      '#ub-tool .sec-row button:hover{filter:brightness(1.05);} #ub-tool .sec-row button:active{transform:translateY(1px);}',
      '#ub-tool .sec-st{margin-top:8px;font-size:11.5px;font-weight:600;min-height:15px;line-height:1.4;color:#5a6b76;}',
      '#ub-tool .sec-st.go{color:#0d7ba0;} #ub-tool .sec-st.ok{color:#12995a;} #ub-tool .sec-st.err{color:#e0483f;} #ub-tool .sec-st.warn{color:#c77a12;}',
      '#ub-tool .rz{position:absolute;right:3px;bottom:3px;width:16px;height:16px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 46%,#c3d3dd 46%,#c3d3dd 56%,transparent 56%,transparent 68%,#c3d3dd 68%,#c3d3dd 78%,transparent 78%);}',
      '#ub-tool.locked .rz{display:none;}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }

  function mount() {
    ensureStyle();
    if (document.getElementById('ub-tool')) return;
    const st = loadWin();
    const box = document.createElement('div'); box.id = 'ub-tool';
    box.innerHTML =
      '<div class="hd"><span class="dot"></span><span class="ttl">D102 도구</span><span class="ctl">' +
        '<button class="btn lock" title="크기·위치 잠금"></button>' +
        '<button class="btn min" title="접기/펼치기">▾</button>' +
        '<button class="btn cls" title="닫기">✕</button>' +
      '</span></div>' +
      '<div class="body"><div class="sec">' +
        '<div class="sec-t">상품 재고화</div>' +
        '<div class="sec-row"><input id="ub-stk-in" placeholder="바코드 입력 후 Enter" autocomplete="off" spellcheck="false"><button id="ub-stk-go">재고화</button></div>' +
        '<div class="sec-st" id="ub-stk-st"></div>' +
      '</div></div>' +
      '<div class="rz" title="크기 조절"></div>';
    document.body.appendChild(box);

    const lockBtn = box.querySelector('.lock'), minBtn = box.querySelector('.min');
    function applyGeom() {
      const w = Math.max(210, st.w | 0);
      const left = (st.left == null) ? (window.innerWidth - w - 20) : st.left;
      box.style.left = Math.max(4, Math.min(left, window.innerWidth - 60)) + 'px';
      box.style.top = Math.max(4, Math.min(st.top, window.innerHeight - 40)) + 'px';
      box.style.width = w + 'px';
      box.style.height = st.min ? 'auto' : Math.max(120, st.h | 0) + 'px';
      box.classList.toggle('locked', !!st.locked);
      box.classList.toggle('min', !!st.min);
      lockBtn.innerHTML = st.locked ? LOCK_ON : LOCK_OFF;
      lockBtn.title = st.locked ? '잠금 해제' : '크기·위치 잠금';
      minBtn.textContent = st.min ? '▸' : '▾';
    }
    applyGeom();

    // 이동(헤더 드래그)
    box.querySelector('.hd').addEventListener('mousedown', e => {
      if (st.locked || (e.target.closest && e.target.closest('.btn'))) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, ol = box.offsetLeft, ot = box.offsetTop;
      const mv = ev => { st.left = ol + (ev.clientX - sx); st.top = ot + (ev.clientY - sy); applyGeom(); };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); saveWin(st); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    // 크기 조절(우하단 그립)
    box.querySelector('.rz').addEventListener('mousedown', e => {
      if (st.locked) return;
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, ow = box.offsetWidth, oh = box.offsetHeight;
      const mv = ev => { st.w = Math.max(210, ow + (ev.clientX - sx)); st.h = Math.max(120, oh + (ev.clientY - sy)); st.min = false; applyGeom(); };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); saveWin(st); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    // 잠금 / 접기 / 닫기
    lockBtn.addEventListener('click', () => { st.locked = !st.locked; applyGeom(); saveWin(st); });
    minBtn.addEventListener('click', () => { st.min = !st.min; applyGeom(); saveWin(st); });
    box.querySelector('.cls').addEventListener('click', () => box.remove());
    window.addEventListener('resize', applyGeom);

    // 재고화 배선
    const inp = box.querySelector('#ub-stk-in'), stEl = box.querySelector('#ub-stk-st');
    const setStatus = (t, k) => { stEl.textContent = t || ''; stEl.className = 'sec-st' + (k ? ' ' + k : ''); };
    const go = () => run(inp.value, setStatus);
    box.querySelector('#ub-stk-go').addEventListener('click', go);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    try {
      const last = JSON.parse(localStorage.getItem('UB_STOCK_LAST') || 'null');
      if (last && last.junNum) setStatus('직전: ' + last.barcode + ' → 입고장 ' + last.junNum + ' 불러옴 ✓', 'ok');
    } catch (_) {}
    setTimeout(() => { try { if (!st.min) inp.focus(); } catch (_) {} }, 400);
    log('D102 도구 창 마운트');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
