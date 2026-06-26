/* =============================================================================
 *  editor.js — 라벨 미리보기 + 위치 정밀 편집 모달 (신규)
 *
 *  요구사항:
 *   - 바코드인쇄 → 곧바로 크롬 인쇄창이 뜨지 않는다. 먼저 "우리 미리보기" 모달.
 *   - 각 항목을 드래그 또는 수치(mm)로 정밀 위치 조정 → 저장(localStorage).
 *   - 저장된 위치는 이후 모든 인쇄에 적용.
 *
 *  공개: window.UBEditor.open(dataArr)
 * ========================================================================== */
(function () {
  'use strict';

  const ID = 'ub-ed-root';
  let state = null;  // { data, layout, idx, editMode, selKey }

  /* ---- 스타일 (1회 주입) ---------------------------------------------- */
  function ensureStyle() {
    if (document.getElementById('ub-ed-style')) return;
    const css = `
      #${ID}{position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.55);
             display:flex;align-items:center;justify-content:center;
             font-family:"Malgun Gothic",sans-serif;color:#222;}
      #${ID} *{box-sizing:border-box;}
      .ub-ed-modal{background:#f4f4f5;width:min(960px,95vw);max-height:94vh;
             display:flex;flex-direction:column;border-radius:8px;overflow:hidden;
             box-shadow:0 10px 40px rgba(0,0,0,.4);}
      .ub-ed-head{display:flex;align-items:center;gap:8px;padding:10px 14px;
             background:#1f2937;color:#fff;}
      .ub-ed-head h2{font-size:15px;margin:0;font-weight:600;}
      .ub-ed-head .sp{flex:1;}
      .ub-ed-pager{display:flex;align-items:center;gap:6px;font-size:13px;}
      .ub-ed-btn{padding:6px 11px;border:0;border-radius:5px;cursor:pointer;font-size:13px;}
      .ub-ed-btn.ghost{background:#374151;color:#fff;}
      .ub-ed-btn.primary{background:#2563eb;color:#fff;font-weight:600;}
      .ub-ed-btn.warn{background:#b45309;color:#fff;}
      .ub-ed-btn.on{background:#10b981;color:#fff;}
      .ub-ed-btn:hover{filter:brightness(1.1);}
      .ub-ed-body{display:flex;gap:0;min-height:0;}
      .ub-ed-canvaswrap{flex:1;overflow:auto;background:#6b7280;
             display:flex;align-items:center;justify-content:center;padding:24px;}
      .ub-ed-canvas{position:relative;background:#fff;outline:1px solid #000;
             box-shadow:0 2px 10px rgba(0,0,0,.3);}
      .ub-ed-canvas .ub-f{cursor:default;}
      .ub-ed-canvas.edit .ub-f{cursor:move;outline:1px dotted rgba(37,99,235,.45);}
      .ub-ed-canvas.edit .ub-f:hover{outline:1px solid #2563eb;}
      .ub-ed-canvas .ub-f.sel{outline:2px solid #2563eb !important;
             box-shadow:0 0 0 2px rgba(37,99,235,.25);}
      .ub-ed-canvas .ub-rz{position:absolute;width:13px;height:13px;background:#2563eb;
             border:2px solid #fff;border-radius:3px;cursor:nwse-resize;z-index:6;
             box-shadow:0 1px 3px rgba(0,0,0,.45);}
      .ub-ed-canvas .ub-rz:hover{background:#1d4ed8;transform:scale(1.12);}
      .ub-ed-props{width:250px;background:#fff;border-left:1px solid #d1d5db;
             padding:12px;overflow:auto;font-size:12.5px;}
      .ub-ed-props h3{margin:0 0 8px;font-size:13px;}
      .ub-ed-row{display:flex;align-items:center;gap:6px;margin:6px 0;}
      .ub-ed-row label{width:62px;color:#555;}
      .ub-ed-row input[type=number]{width:70px;padding:3px 5px;border:1px solid #cbd5e1;border-radius:4px;}
      .ub-ed-row select{padding:3px;border:1px solid #cbd5e1;border-radius:4px;}
      .ub-ed-fieldlist{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px;}
      .ub-ed-chip{padding:3px 7px;border:1px solid #cbd5e1;border-radius:11px;
             background:#f8fafc;cursor:pointer;font-size:11.5px;}
      .ub-ed-chip.sel{background:#2563eb;color:#fff;border-color:#2563eb;}
      .ub-ed-chip.off{opacity:.45;text-decoration:line-through;}
      .ub-ed-foot{padding:8px 14px;background:#e5e7eb;font-size:11.5px;color:#555;}
      .ub-ed-hint{color:#94a3b8;font-size:11px;margin-top:4px;}
      .ub-ed-banner{padding:9px 14px;background:#fffbeb;color:#92400e;font-size:13px;
            border-bottom:1px solid #fde68a;font-weight:600;}
    `;
    const st = document.createElement('style');
    st.id = 'ub-ed-style';
    st.textContent = css + '\n' + window.UBLabel.baseCss({ pxmm: window.UBCFG.editor.pxmm });
    document.head.appendChild(st);
  }

  /* ---- 모달 골격 ------------------------------------------------------- */
  function buildShell() {
    const root = document.createElement('div');
    root.id = ID;
    root.innerHTML = `
      <div class="ub-ed-modal">
        <div class="ub-ed-head">
          <h2>바코드 라벨 미리보기</h2>
          <div class="ub-ed-pager">
            <button class="ub-ed-btn ghost" data-act="prev">◀</button>
            <span data-el="page">1 / 1</span>
            <button class="ub-ed-btn ghost" data-act="next">▶</button>
          </div>
          <div class="sp"></div>
          <button class="ub-ed-btn ghost" data-act="edit">✎ 위치 편집</button>
          <button class="ub-ed-btn ghost" data-act="save">저장</button>
          <button class="ub-ed-btn warn" data-act="reset">기본값</button>
          <button class="ub-ed-btn primary" data-act="print">🖨 인쇄</button>
          <button class="ub-ed-btn ghost" data-act="close">✕</button>
        </div>
        <div class="ub-ed-banner" data-el="banner" style="display:none"></div>
        <div class="ub-ed-body">
          <div class="ub-ed-canvaswrap">
            <div class="ub-ed-canvas" data-el="canvas"></div>
          </div>
          <div class="ub-ed-props" data-el="props" style="display:none"></div>
        </div>
        <div class="ub-ed-foot" data-el="foot">미리보기입니다. 위치를 바꾸려면 "위치 편집"을 켜고 항목을 드래그하거나 수치를 입력한 뒤 "저장"하세요.</div>
      </div>`;
    return root;
  }

  /* ---- 렌더 ------------------------------------------------------------ */
  function render() {
    const CFG = window.UBCFG;
    const pxmm = CFG.editor.pxmm;
    const canvas = state.root.querySelector('[data-el=canvas]');
    const d = state.data[state.idx];

    canvas.className = 'ub-ed-canvas' + (state.editMode ? ' edit' : '');
    canvas.innerHTML = window.UBLabel.buildLabel(d, {
      pxmm, layout: state.layout, editable: state.editMode
    });
    // buildLabel 은 .ub-label 래퍼를 만든다 → 캔버스 크기를 라벨에 맞춤
    const lbl = canvas.querySelector('.ub-label');
    if (lbl) { lbl.style.position = 'static'; }
    canvas.style.width = (CFG.label.wmm * pxmm) + 'px';
    canvas.style.height = (CFG.label.hmm * pxmm) + 'px';

    // 선택 표시 + 리사이즈 핸들 + 드래그 바인딩
    if (state.editMode) {
      if (state.selKey) {
        const sel = canvas.querySelector(`[data-key="${state.selKey}"]`);
        if (sel) { sel.classList.add('sel'); addHandle(canvas, sel); }
      }
      bindDrag(canvas);
    }

    state.root.querySelector('[data-el=page]').textContent =
      (state.idx + 1) + ' / ' + state.data.length;
    state.root.querySelector('[data-act=edit]').classList.toggle('on', state.editMode);
    state.root.querySelector('[data-el=props]').style.display = state.editMode ? 'block' : 'none';
    if (state.editMode) renderProps();
  }

  function field(key) { return state.layout.find(f => f.key === key); }

  function renderProps() {
    const props = state.root.querySelector('[data-el=props]');
    const chips = state.layout.map(f =>
      `<span class="ub-ed-chip ${f.key === state.selKey ? 'sel' : ''} ${f.visible === false ? 'off' : ''}" data-chip="${f.key}">${f.name}</span>`
    ).join('');

    let body = '';
    const f = field(state.selKey);
    if (f) {
      const numRow = (lab, prop, step) =>
        `<div class="ub-ed-row"><label>${lab}</label>
           <input type="number" step="${step}" data-prop="${prop}" value="${f[prop] != null ? f[prop] : ''}"> mm</div>`;
      body += `<h3>${f.name} <span style="color:#94a3b8">(${f.key})</span></h3>`;
      body += numRow('X (가로)', 'x', 0.1);
      body += numRow('Y (세로)', 'y', 0.1);
      body += numRow('너비 W', 'w', 0.1);
      if (f.type === 'barcode' || f.type === 'box') body += numRow('높이 H', 'h', 0.1);
      if (f.type === 'text') {
        body += numRow('글자크기', 'fs', 0.1);
        body += `<div class="ub-ed-row"><label>정렬</label>
          <select data-prop="align">
            <option value="left"${f.align === 'left' ? ' selected' : ''}>왼쪽</option>
            <option value="center"${f.align === 'center' ? ' selected' : ''}>가운데</option>
            <option value="right"${f.align === 'right' ? ' selected' : ''}>오른쪽</option>
          </select></div>`;
        body += `<div class="ub-ed-row"><label>굵게</label>
          <input type="checkbox" data-prop="bold"${f.bold ? ' checked' : ''}></div>`;
      }
      body += `<div class="ub-ed-row"><label>표시</label>
        <input type="checkbox" data-prop="visible"${f.visible !== false ? ' checked' : ''}></div>`;
      body += `<div class="ub-ed-hint">드래그로 이동 · 선택 후 ←↑↓→ 0.5mm 이동 (Shift=0.1mm)</div>`;
    } else {
      body = `<div class="ub-ed-hint">아래에서 항목을 클릭하거나, 캔버스에서 항목을 클릭해 선택하세요.</div>`;
    }

    props.innerHTML = `<div class="ub-ed-fieldlist">${chips}</div>${body}`;

    // 칩 클릭 → 선택
    props.querySelectorAll('[data-chip]').forEach(ch => {
      ch.addEventListener('click', () => { state.selKey = ch.dataset.chip; render(); });
    });
    // 수치 입력 → 반영
    props.querySelectorAll('[data-prop]').forEach(inp => {
      const ev = inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'input';
      inp.addEventListener(ev, () => {
        const f2 = field(state.selKey); if (!f2) return;
        const p = inp.dataset.prop;
        if (inp.type === 'checkbox') f2[p] = inp.checked;
        else if (inp.tagName === 'SELECT') f2[p] = inp.value;
        else f2[p] = parseFloat(inp.value);
        render();
        // 입력 포커스 유지: 다시 같은 입력으로
        const again = state.root.querySelector(`[data-el=props] [data-prop="${p}"]`);
        if (again && ev === 'input') { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      });
    });
  }

  /* ---- 리사이즈 핸들 배치(선택 필드 우하단) -------------------------- */
  function addHandle(canvas, sel) {
    const old = canvas.querySelector('.ub-rz'); if (old) old.remove();
    const h = document.createElement('div');
    h.className = 'ub-rz';
    h.style.left = (sel.offsetLeft + sel.offsetWidth - 7) + 'px';
    h.style.top = (sel.offsetTop + sel.offsetHeight - 7) + 'px';
    canvas.appendChild(h);
    return h;
  }
  function moveHandle(canvas, sel) {
    const h = canvas.querySelector('.ub-rz'); if (!h) return;
    h.style.left = (sel.offsetLeft + sel.offsetWidth - 7) + 'px';
    h.style.top = (sel.offsetTop + sel.offsetHeight - 7) + 'px';
  }

  /* ---- 드래그(이동) + 리사이즈(대각선) ------------------------------- */
  function bindDrag(canvas) {
    canvas.onmousedown = (e) => {
      const pxmm = window.UBCFG.editor.pxmm;

      // 1) 리사이즈 핸들 → 대각선 크기 조절
      if (e.target.classList.contains('ub-rz')) {
        e.preventDefault();
        const f = field(state.selKey); if (!f) return;
        const sel = canvas.querySelector(`[data-key="${state.selKey}"]`);
        const isBox = (f.type === 'barcode' || f.type === 'box');
        const sx = e.clientX, sy = e.clientY;
        const ow = f.w, oh = (f.h != null ? f.h : 3), ofs = (f.fs != null ? f.fs : 2);
        const rzMove = (ev) => {
          const dx = (ev.clientX - sx) / pxmm;
          const dy = (ev.clientY - sy) / pxmm;
          f.w = clamp(round1(ow + dx), 2, window.UBCFG.label.wmm);
          if (isBox) f.h = clamp(round1(oh + dy), 1, window.UBCFG.label.hmm);
          else f.fs = clamp(round1(ofs + dy), 0.8, 9);
          if (sel) {
            sel.style.width = (f.w * pxmm) + 'px';
            if (isBox) sel.style.height = (f.h * pxmm) + 'px';
            else sel.style.fontSize = (f.fs * pxmm) + 'px';
            moveHandle(canvas, sel);
          }
          syncNum('w', f.w); if (isBox) syncNum('h', f.h); else syncNum('fs', f.fs);
        };
        const rzUp = () => {
          document.removeEventListener('mousemove', rzMove);
          document.removeEventListener('mouseup', rzUp);
          render();   // 최종 동기화(바코드 SVG 재맞춤 등)
        };
        document.addEventListener('mousemove', rzMove);
        document.addEventListener('mouseup', rzUp);
        return;
      }

      // 2) 필드 본체 → 이동
      const el = e.target.closest('[data-key]');
      if (!el) return;
      e.preventDefault();
      state.selKey = el.dataset.key;
      const f = field(state.selKey);
      const startX = e.clientX, startY = e.clientY;
      const ox = f.x, oy = f.y;
      canvas.querySelectorAll('.ub-f').forEach(n => n.classList.remove('sel'));
      el.classList.add('sel');
      addHandle(canvas, el);
      renderProps();

      const move = (ev) => {
        const dx = (ev.clientX - startX) / pxmm;
        const dy = (ev.clientY - startY) / pxmm;
        f.x = clamp(round1(ox + dx), 0, window.UBCFG.label.wmm - 1);
        f.y = clamp(round1(oy + dy), 0, window.UBCFG.label.hmm - 0.3);
        el.style.left = (f.x * pxmm) + 'px';
        el.style.top = (f.y * pxmm) + 'px';
        moveHandle(canvas, el);
        syncNum('x', f.x); syncNum('y', f.y);
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    };
  }

  function syncNum(prop, val) {
    const inp = state.root.querySelector(`[data-el=props] [data-prop="${prop}"]`);
    if (inp && document.activeElement !== inp) inp.value = val;
  }

  /* ---- 키보드 넛지 ----------------------------------------------------- */
  function onKey(e) {
    if (!state || !state.editMode || !state.selKey) return;
    const map = { ArrowLeft: ['x', -1], ArrowRight: ['x', 1], ArrowUp: ['y', -1], ArrowDown: ['y', 1] };
    const m = map[e.key]; if (!m) return;
    // 입력칸에 포커스 중이면 기본 동작
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    e.preventDefault();
    const step = e.shiftKey ? 0.1 : window.UBCFG.editor.grid;
    const f = field(state.selKey); if (!f) return;
    const [prop, dir] = m;
    const max = prop === 'x' ? window.UBCFG.label.wmm - 1 : window.UBCFG.label.hmm - 0.3;
    f[prop] = clamp(round1(f[prop] + dir * step), 0, max);
    render();
  }

  /* ---- 버튼 액션 ------------------------------------------------------- */
  function onAct(act) {
    switch (act) {
      case 'prev': state.idx = (state.idx - 1 + state.data.length) % state.data.length; render(); break;
      case 'next': state.idx = (state.idx + 1) % state.data.length; render(); break;
      case 'edit':
        state.editMode = !state.editMode;
        if (state.editMode && !state.selKey) state.selKey = state.layout[0].key;
        render(); break;
      case 'save': {
        const ok = window.UBLabel.saveLayout(state.layout);
        // 저장 확인을 눈에 띄게: 배너로 표시
        const b = state.root.querySelector('[data-el=banner]');
        if (b) {
          b.style.display = 'block';
          if (ok) {
            b.style.background = '#ecfdf5'; b.style.color = '#047857'; b.style.borderColor = '#a7f3d0';
            b.textContent = state.opts && state.opts.firstRun
              ? '✔ 저장 완료! "✕"로 닫고 바코드인쇄 하면 이 위치로 인쇄됩니다.'
              : '✔ 저장 완료 — 이후 인쇄에 이 위치가 적용됩니다.';
          } else {
            b.style.background = '#fef2f2'; b.style.color = '#b91c1c'; b.style.borderColor = '#fecaca';
            b.textContent = '⚠ 저장 실패(localStorage 차단). 시크릿/쿠키 차단 설정을 확인하세요.';
          }
        }
        toast(ok ? '저장됨 — 이후 인쇄에 적용됩니다.' : '저장 실패');
        if (state.opts && state.opts.firstRun) document.addEventListener('keydown', escClose, true);
        break;
      }
      case 'reset':
        if (confirm('라벨 위치를 기본값으로 되돌릴까요? (저장된 위치 삭제)')) {
          window.UBLabel.resetLayout();
          state.layout = window.UBLabel.getLayout();
          render(); toast('기본값으로 초기화됨');
        }
        break;
      case 'print':
        // 화면의 현재(미저장 포함) 레이아웃 그대로 인쇄
        window.UBPrint.printDocument(window.UBLabel.buildDocument(state.data, state.layout));
        break;
      case 'close': close(); break;
    }
  }

  function toast(msg) {
    const foot = state.root.querySelector('[data-el=foot]');
    foot.textContent = '✔ ' + msg;
    foot.style.color = '#047857';
    setTimeout(() => { foot.style.color = ''; }, 2500);
  }

  /* ---- 유틸 ------------------------------------------------------------ */
  const round1 = (v) => Math.round(v * 10) / 10;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ---- 열기/닫기 ------------------------------------------------------- */
  function open(dataArr, opts) {
    if (!dataArr || !dataArr.length) return;
    opts = opts || {};
    ensureStyle();
    close(); // 중복 방지
    const root = buildShell();
    document.body.appendChild(root);
    const firstRun = !!opts.firstRun;
    state = {
      root, data: dataArr, layout: window.UBLabel.getLayout(), idx: 0,
      editMode: firstRun, selKey: firstRun ? window.UBLabel.getLayout()[0].key : null,
      opts: opts
    };

    // 제목/배너
    if (opts.title) root.querySelector('h2').textContent = opts.title;
    if (firstRun || opts.banner) {
      const b = root.querySelector('[data-el=banner]');
      b.style.display = 'block';
      b.textContent = opts.banner ||
        '⚠ 최초 설정: 항목을 드래그/수치로 라벨 위치에 맞춘 뒤 반드시 "저장"을 누르세요. 저장해야 인쇄에 적용됩니다.';
    }
    // 인쇄/페이저 숨김(옵션페이지 등 데이터 없는 곳)
    if (opts.hidePrint) {
      const pb = root.querySelector('[data-act=print]'); if (pb) pb.style.display = 'none';
      const pg = root.querySelector('.ub-ed-pager'); if (pg && dataArr.length <= 1) pg.style.display = 'none';
    }

    root.querySelectorAll('[data-act]').forEach(b =>
      b.addEventListener('click', () => onAct(b.dataset.act)));
    // 최초설정 중에는 바깥/ESC 로 무심코 닫히지 않게(저장 유도)
    if (!firstRun) {
      root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
      document.addEventListener('keydown', escClose, true);
    }
    document.addEventListener('keydown', onKey, true);
    render();
  }

  function escClose(e) { if (e.key === 'Escape') close(); }

  function close() {
    const old = document.getElementById(ID);
    if (old) old.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('keydown', escClose, true);
    state = null;
  }

  window.UBEditor = { open, close };
})();
