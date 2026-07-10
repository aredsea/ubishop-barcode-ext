/* =============================================================================
 *  stockmacro.js — 상품입고 '상품 재고화' 매크로 (loader 관리 → push 반영)
 *  inputItemWriteForm.do 에서만 동작. 바코드 하나로 아래를 팝업 없이 재현:
 *   ① 전표관리(inputItemList.do, searchBarcode) → 입고장번호
 *   ② 입고장목록(inputItemJunList.do, searchJunNum) → junSeq ( view('seq') )
 *   ③ form2.jun = junSeq → form2.submit() → 해당 입고장 로드
 *  ⚠ 등록(재고화 쓰기)은 절대 자동 안 함 — 입고장 로드까지만. 날짜=태초(2000-01-01)~오늘.
 *
 *  실측 확정(2026-07): 바코드필드=searchBarcode, inputItemList 결과 '입고장번호' 열,
 *   inputItemJunList 행에 view('89977') = junSeq, form2=[jun] 빈폼+form= 연결 인풋,
 *   action=/input/item/inputItemWriteForm.do?tcode=input_item POST.
 * ========================================================================== */
(function () {
  'use strict';
  if (!/\/input\/item\/inputItemWriteForm\.do/.test(location.pathname)) return;
  if (window.__ubStockMacro) return; window.__ubStockMacro = 1;

  const TAG = '[UB][stockmacro]';
  const log = (...a) => { try { console.log(TAG, ...a); } catch (_) {} };

  // 태초(2000-01-01) ~ 오늘
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
  // t_list(수량/입고장 헤더) 첫 데이터행 반환
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

  // ① 바코드 → 입고장번호
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
  // ② 입고장번호 → junSeq ( view('seq') )
  async function junNumToSeq(junNum) {
    const p = new URLSearchParams({ ...dateParams(), searchJunNum: junNum, searchItemType: '1', pageSize: '100' });
    const doc = await postDoc('/jun/inputitem/inputItemJunList.do?tcode=input_item_jun', p);
    const g = firstDataRow(doc);
    if (!g) return null;
    const m = g.row.innerHTML.match(/view\(\s*'?(\d+)'?\s*\)/);
    return m ? m[1] : null;
  }
  // ③ form2.jun = seq → 제출(그 입고장 로드). 등록은 안 함.
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
      loadVoucher(seq);   // 페이지 리로드 → 입고장 로드(여기서 사람이 확인 후 재고화 등록)
    } catch (e) {
      log('실패', e); setStatus('실패: ' + (e && e.message ? e.message : e), 'err');
    } finally { busy = false; }
  }

  /* ---------- UI ---------- */
  function ensureStyle() {
    if (document.getElementById('ub-stk-style')) return;
    const s = document.createElement('style');
    s.id = 'ub-stk-style';
    s.textContent = [
      "@font-face{font-family:'PretendardUB';font-style:normal;font-weight:100 900;font-display:swap;src:url('https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/variable/woff2/PretendardVariable.woff2') format('woff2-variations');}",
      "#ub-stk{position:fixed;bottom:22px;right:20px;z-index:2147483000;width:258px;background:#fff;border:1px solid #e2ecf1;border-radius:16px;box-shadow:0 8px 30px rgba(16,40,60,.20);font-family:'PretendardUB','Malgun Gothic',sans-serif;-webkit-font-smoothing:antialiased;overflow:hidden;}",
      '#ub-stk *{font-family:inherit;box-sizing:border-box;}',
      '#ub-stk .hd{background:linear-gradient(180deg,#123542,#0e2a37);color:#dff2f9;font-weight:700;font-size:12.5px;letter-spacing:-.01em;padding:10px 13px;display:flex;align-items:center;gap:7px;}',
      '#ub-stk .hd .dot{width:7px;height:7px;border-radius:50%;background:#35C5F0;box-shadow:0 0 0 3px rgba(53,197,240,.25);}',
      '#ub-stk .hd .x{margin-left:auto;cursor:pointer;color:#7fa8ba;font-size:13px;line-height:1;padding:2px;}',
      '#ub-stk .hd .x:hover{color:#dff2f9;}',
      '#ub-stk .bd{display:flex;gap:6px;padding:12px 13px 9px;}',
      '#ub-stk .bd input{flex:1;min-width:0;padding:9px 11px;border:1px solid #cdd8e0;border-radius:10px;font-size:13px;font-weight:600;letter-spacing:.02em;color:#1e2a33;}',
      '#ub-stk .bd input::placeholder{color:#aab7c0;font-weight:500;letter-spacing:0;}',
      '#ub-stk .bd input:focus{outline:0;border-color:#35C5F0;box-shadow:0 0 0 3px rgba(53,197,240,.18);}',
      '#ub-stk .bd button{padding:9px 13px;border:0;border-radius:10px;background:linear-gradient(180deg,#3fcdf3,#22b6e6);color:#fff;font-weight:700;font-size:12.5px;cursor:pointer;white-space:nowrap;box-shadow:0 2px 9px rgba(34,182,230,.38);transition:.12s;}',
      '#ub-stk .bd button:hover{filter:brightness(1.05);}',
      '#ub-stk .bd button:active{transform:translateY(1px);}',
      '#ub-stk .st{padding:0 13px 12px;font-size:11.5px;font-weight:600;min-height:15px;line-height:1.4;color:#5a6b76;}',
      '#ub-stk .st.go{color:#0d7ba0;} #ub-stk .st.ok{color:#12995a;} #ub-stk .st.err{color:#e0483f;} #ub-stk .st.warn{color:#c77a12;}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }
  function mount() {
    ensureStyle();
    if (document.getElementById('ub-stk')) return;
    const box = document.createElement('div');
    box.id = 'ub-stk';
    box.innerHTML =
      '<div class="hd"><span class="dot"></span>상품 재고화<span class="x" title="숨기기">✕</span></div>' +
      '<div class="bd"><input id="ub-stk-in" placeholder="바코드 입력 후 Enter" autocomplete="off" spellcheck="false"><button id="ub-stk-go">재고화</button></div>' +
      '<div class="st" id="ub-stk-st"></div>';
    document.body.appendChild(box);
    const inp = box.querySelector('#ub-stk-in');
    const stEl = box.querySelector('#ub-stk-st');
    const setStatus = (t, k) => { stEl.textContent = t || ''; stEl.className = 'st' + (k ? ' ' + k : ''); };
    const go = () => run(inp.value, setStatus);
    box.querySelector('#ub-stk-go').addEventListener('click', go);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    box.querySelector('.x').addEventListener('click', () => box.remove());
    // 리로드 후 직전 로드 결과 표시
    try {
      const last = JSON.parse(localStorage.getItem('UB_STOCK_LAST') || 'null');
      if (last && last.junNum) setStatus('직전: ' + last.barcode + ' → 입고장 ' + last.junNum + ' 불러옴 ✓', 'ok');
    } catch (_) {}
    setTimeout(() => { try { inp.focus(); } catch (_) {} }, 400);
    log('위젯 마운트');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
