/* =============================================================================
 *  storeprice.js — 매장 제품 가격 변경(원버튼) UI·배선 (ISOLATED, infoItemList.do 전용).
 *  [바코드 인쇄] 옆 버튼 → 패널: 금액 1칸 · [조회] 표 · [첫 1건 시범] → [나머지 진행].
 *  로직은 storeprice-core.js(순수·실행기), 서버 호출은 storeprice-erp.js. 이 파일은 DOM·storage·배선만.
 *  스펙: docs/superpowers/specs/2026-10-23-store-price-change-design.md
 * ========================================================================== */
(function () {
  'use strict';
  if (window.top !== window) return;
  if (!/\/info\/item\/infoItemList\.do/.test(location.pathname)) return;
  const C = globalThis.ubSp, E = globalThis.ubSpErp;
  if (!C || !E) { console.warn('[UB][sp] core/erp 미로드 — manifest 순서 확인'); return; }

  const BTN_ID = 'ub-sp-btn', PANEL_ID = 'ub-sp-panel', STYLE_ID = 'ub-sp-style';
  const S = { enabled: false, barcodes: [], price: null, items: [], running: false, results: [], phase: 'idle' };
  //  items: [{ barcode, cls:{go,target,reason,row} | null, err }]  phase: idle | looking | ready | trial_done | done | stopped

  const sget = (q) => new Promise((res) => chrome.storage.local.get(q, res));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ------------------------------------------------------------ 버튼 */
  function anchor() { return document.querySelector('a[href*="sendBarPrint"]'); }
  function mountButton() {
    if (!S.enabled) { const b = document.getElementById(BTN_ID); if (b) b.remove(); return; }
    if (document.getElementById(BTN_ID)) return;
    const a = anchor();
    if (!a) return;
    const b = document.createElement('button');
    b.type = 'button'; b.id = BTN_ID; b.textContent = '매장 제품 가격 변경';
    b.addEventListener('click', openPanel);
    a.insertAdjacentElement('afterend', b);
  }
  function checkedBarcodes() {
    const f = document.forms['form2'];
    const boxes = f ? [...document.querySelectorAll('input[name="idx"]')].filter((c) => c.form === f) : [];
    const seen = new Set();
    return boxes.filter((c) => c.checked).map((c) => String(c.value || '').trim().toUpperCase()).filter((v) => v && !seen.has(v) && seen.add(v));
  }

  /* ------------------------------------------------------------ 패널 */
  function openPanel() {
    if (S.running) return;
    const bcs = checkedBarcodes();
    if (!bcs.length) { alert('가격을 바꿀 제품을 체크하세요.'); return; }
    Object.assign(S, { barcodes: bcs, items: bcs.map((b) => ({ barcode: b, cls: null, err: '' })), results: [], phase: 'idle', price: null });
    render();
  }
  function closePanel() {
    if (S.running) { alert('처리 중에는 닫을 수 없습니다. 현재 제품 처리가 끝나면 멈춥니다.'); return; }
    const p = document.getElementById(PANEL_ID); if (p) p.remove();
  }
  const targets = () => S.items.filter((it) => it.cls && it.cls.go).map((it) => it.cls.target);
  const doneSet = () => new Set(S.results.map((r) => r.barcode));

  async function doLookup() {
    const inp = document.querySelector('#' + PANEL_ID + ' .sp-price');
    const price = C.spParsePrice(inp ? inp.value : '');
    if (!price) { alert('변경할 금액을 숫자로 입력하세요. (예: 1,250,000)'); return; }
    S.price = price; S.phase = 'looking'; render();
    for (const it of S.items) {
      try { it.cls = await E.lookup(it.barcode); it.err = ''; }
      catch (e) { it.cls = null; it.err = String(e && e.message || e); }
      render();
    }
    S.phase = 'ready'; render();
  }

  async function run(limit) {
    const pending = targets().filter((t) => !doneSet().has(t.barcode));
    if (!pending.length) return;
    const n = limit == null ? pending.length : Math.min(limit, pending.length);
    const msg = (limit === 1 ? '시범으로 1건만 처리합니다.\n\n' : '나머지 ' + n + '건을 처리합니다.\n\n')
      + '금액: ' + C.spComma(S.price) + '원 (소비자가·판매가)\n'
      + '제품마다 출고 삭제 → 가격 저장 → 원래 매장 재출고(인쇄 없음) 순서로 진행합니다.\n'
      + '재출고 출고장은 새 번호·오늘 날짜로 잡힙니다.\n\n계속할까요?';
    if (!confirm(msg)) return;
    if (!S.enabled) { alert('[유비샵 스킨모드]가 꺼져 있어 실행하지 않습니다.'); return; }
    S.running = true; render();
    try {
      const res = await C.spRunAll(pending, S.price, E, { limit: n, shouldStop: () => !S.enabled, onItem: (r) => { S.results.push(r); render(); } });
      const bad = res.find((r) => r.status !== 'ok');
      S.phase = (bad || (!S.enabled && res.length < n)) ? 'stopped' : (doneSet().size >= targets().length ? 'done' : 'trial_done');
    } catch (e) {
      S.phase = 'stopped';
      S.results.push({ barcode: '-', status: 'stranded', step: 'run', msg: '실행 오류: ' + (e && e.message || e) + ' — 처리 로그(UB_SP_LOG)를 확인하세요' });
    } finally { S.running = false; render(); }
  }

  const STATUS_TEXT = {
    ok: ['성공', 'ok'],
    price_failed: ['가격 변경 실패 — 원래 매장으로 복귀함', 'warn'],
    delete_failed: ['출고 삭제 실패 — 바뀐 것 없음', 'warn'],
    stranded: ['본사에 남아 있음 — 직접 출고 필요', 'err']
  };
  function rowHtml(it) {
    const r = S.results.find((x) => x.barcode === it.barcode);
    const c = it.cls;
    let judge = '';
    if (r) {
      const [t, k] = STATUS_TEXT[r.status] || [r.status, 'err'];
      judge = '<span class="sp-' + k + '">' + esc(t) + '</span>' + (r.msg ? '<div class="sp-sub">' + esc(r.msg) + '</div>' : '') + (r.warn ? '<div class="sp-sub sp-warn">' + esc(r.warn) + '</div>' : '');
    } else if (it.err) judge = '<span class="sp-err">조회 실패</span><div class="sp-sub">' + esc(it.err) + '</div>';
    else if (!c) judge = S.phase === 'looking' ? '<span class="sp-sub">조회 중…</span>' : '';
    else if (c.go) judge = '<span class="sp-ok">처리 예정</span>';
    else judge = '<span class="sp-skip">건너뜀</span><div class="sp-sub">' + esc(c.reason) + '</div>';
    const row = c && (c.target || c.row);
    const shop = c && c.target ? c.target.shop.name : (c && c.row ? c.row.shopText.slice(0, 12) : '');
    return '<tr><td class="sp-bc">' + esc(it.barcode) + '</td><td>' + esc(shop) + '</td><td>' + esc(row ? (row.kind || '') : '') + '</td>'
      + '<td class="sp-num">' + esc(row ? (row.salePrice || '') : '') + '</td><td>' + judge + '</td></tr>';
  }
  function render() {
    let p = document.getElementById(PANEL_ID);
    if (!p) {
      p = document.createElement('div'); p.id = PANEL_ID; p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', '매장 제품 가격 변경');
      document.body.appendChild(p);
      p.addEventListener('click', onClick);
      p.addEventListener('input', onInput);
    }
    const nGo = targets().length, nDone = doneSet().size;
    const left = targets().filter((t) => !doneSet().has(t.barcode)).length;
    const locked = S.phase !== 'idle';
    let actions = '';
    if (S.phase === 'idle') actions = '<button class="sp-primary" data-act="lookup">조회</button>';
    else if (S.phase === 'ready' && nGo && !nDone) actions = '<button class="sp-primary" data-act="trial"' + (S.running ? ' disabled' : '') + '>시작 — 첫 1건 시범</button>';
    else if (S.phase === 'trial_done' && left) actions = '<button class="sp-primary" data-act="rest"' + (S.running ? ' disabled' : '') + '>나머지 ' + left + '건 진행</button>';
    const note = S.running ? '처리 중… 창을 닫거나 페이지를 옮기지 마세요.'
      : S.phase === 'ready' ? (nGo ? '처리 예정 ' + nGo + '건 · 건너뜀 ' + (S.items.length - nGo) + '건' : '처리할 제품이 없습니다.')
      : S.phase === 'trial_done' ? '시범 1건이 끝났습니다. 결과를 확인하고 나머지를 진행하세요.'
      : S.phase === 'done' ? '모두 끝났습니다.'
      : S.phase === 'stopped' ? '실패가 있어 멈췄습니다. 아래 결과를 확인하세요.' : '';
    p.innerHTML =
      '<div class="sp-h"><b>매장 제품 가격 변경</b><span class="sp-sub">체크 ' + S.items.length + '건 · 일반·회전 출고 제품만</span>'
      + '<button class="sp-x" data-act="close" aria-label="닫기">×</button></div>'
      + '<div class="sp-bar"><label>변경 금액 <input class="sp-price" inputmode="numeric" autocomplete="off" placeholder="예: 1,250,000"'
      + (locked ? ' disabled value="' + esc(C.spComma(S.price || '')) + '"' : '') + '> 원</label>'
      + '<span class="sp-sub">소비자가·판매가에 같은 금액</span></div>'
      + '<div class="sp-body"><table><thead><tr><th>바코드</th><th>매장</th><th>구분</th><th class="sp-num">현재 판매가</th><th>판정</th></tr></thead><tbody>'
      + S.items.map(rowHtml).join('') + '</tbody></table></div>'
      + '<div class="sp-f"><span class="sp-note">' + esc(note) + '</span>' + actions + '</div>';
    if (!locked) { const i = p.querySelector('.sp-price'); if (i && document.activeElement !== i) i.focus(); }
  }
  function onInput(e) {
    if (!e.target.classList.contains('sp-price')) return;
    const el = e.target;
    const before = el.value.slice(0, el.selectionStart).replace(/[^\d]/g, '').length;
    const d = el.value.replace(/[^\d]/g, '').replace(/^0+/, '');
    el.value = d.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    let pos = 0, seen = 0;
    while (pos < el.value.length && seen < before) { if (/\d/.test(el.value[pos])) seen++; pos++; }
    el.setSelectionRange(pos, pos);
  }
  function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'close') closePanel();
    else if (act === 'lookup') doLookup();
    else if (act === 'trial') run(1);
    else if (act === 'rest') run(null);
  }
  window.addEventListener('beforeunload', (e) => { if (S.running) { e.preventDefault(); e.returnValue = ''; } });

  /* ------------------------------------------------------------ 스타일 */
  const CSS = `
#${BTN_ID}{margin-left:6px;height:22px;padding:0 10px;vertical-align:middle;border:1px solid #2bb5e0;border-radius:4px;background:#35C5F0;color:#fff;font:600 12px/20px 'Pretendard','Malgun Gothic',sans-serif;cursor:pointer}
#${BTN_ID}:hover{background:#2bb5e0}
#${BTN_ID}:focus-visible{outline:2px solid #1b1b1b;outline-offset:2px}
#${PANEL_ID}{--ub-bg:#ffffff;--ub-bg2:#f7f9fc;--ub-fg:#1b1b1b;--ub-sub:#6b7280;--ub-line:#e5e7eb;--ub-on:#35C5F0;--ub-on-hover:#2bb5e0;--sp-ok:#12995a;--sp-warn:#c77a12;--sp-err:#e0483f;
  position:fixed;top:24px;right:24px;bottom:24px;width:620px;max-width:calc(100vw - 48px);z-index:2147483647;display:flex;flex-direction:column;overflow:hidden;background:var(--ub-bg);color:var(--ub-fg);border:1px solid var(--ub-line);border-radius:12px;box-shadow:0 8px 24px rgba(15,20,25,.12),0 24px 64px rgba(15,20,25,.18);font:13px/1.45 'Pretendard','Malgun Gothic',sans-serif;-webkit-font-smoothing:antialiased}
#${PANEL_ID} .sp-h{display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--ub-bg2);border-bottom:1px solid var(--ub-line)}
#${PANEL_ID} .sp-h b{font-size:15px}
#${PANEL_ID} .sp-x{margin-left:auto;width:32px;height:32px;border:0;background:none;border-radius:8px;color:var(--ub-sub);font-size:20px;cursor:pointer}
#${PANEL_ID} .sp-x:hover{background:var(--ub-line)}
#${PANEL_ID} .sp-bar{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--ub-line)}
#${PANEL_ID} .sp-price{width:150px;height:32px;padding:0 10px;margin:0 4px;border:1px solid var(--ub-line);border-radius:6px;font:600 15px/30px 'Pretendard','Malgun Gothic',sans-serif;text-align:right;font-variant-numeric:tabular-nums}
#${PANEL_ID} .sp-price:focus{outline:2px solid var(--ub-on);outline-offset:0;border-color:var(--ub-on)}
#${PANEL_ID} .sp-body{flex:1;overflow:auto;padding:0 16px}
#${PANEL_ID} table{width:100%;border-collapse:collapse}
#${PANEL_ID} th{position:sticky;top:0;background:var(--ub-bg);text-align:left;font-weight:600;color:var(--ub-sub);font-size:12px;padding:10px 6px;border-bottom:1px solid var(--ub-line)}
#${PANEL_ID} td{padding:8px 6px;border-bottom:1px solid var(--ub-line);vertical-align:top}
#${PANEL_ID} .sp-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
#${PANEL_ID} .sp-bc{font-family:Consolas,monospace;font-weight:600}
#${PANEL_ID} .sp-sub{color:var(--ub-sub);font-size:12px}
#${PANEL_ID} .sp-ok{color:var(--sp-ok);font-weight:600}
#${PANEL_ID} .sp-skip{color:var(--ub-sub);font-weight:600}
#${PANEL_ID} .sp-warn{color:var(--sp-warn);font-weight:600}
#${PANEL_ID} .sp-err{color:var(--sp-err);font-weight:700}
#${PANEL_ID} .sp-f{display:flex;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid var(--ub-line);background:var(--ub-bg2)}
#${PANEL_ID} .sp-note{flex:1;color:var(--ub-sub)}
#${PANEL_ID} .sp-primary{height:36px;padding:0 16px;border:0;border-radius:8px;background:var(--ub-on);color:#fff;font:600 13px 'Pretendard','Malgun Gothic',sans-serif;cursor:pointer}
#${PANEL_ID} .sp-primary:hover{background:var(--ub-on-hover)}
#${PANEL_ID} .sp-primary:disabled{opacity:.5;cursor:default}
#${PANEL_ID} button:focus-visible{outline:2px solid var(--ub-fg);outline-offset:2px}`;
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style'); s.id = STYLE_ID; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ------------------------------------------------------------ 시작 */
  async function init() {
    const d = await sget({ ubSkin: false });
    S.enabled = !!d.ubSkin;
    ensureStyle();
    mountButton();
  }
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch.ubSkin) return;
    S.enabled = !!ch.ubSkin.newValue;
    mountButton();
    //  꺼지면 열린 패널도 닫는다. 실행 중이면 spRunAll 이 shouldStop 으로 다음 제품 전에 멈춘다(Terra 2R P1).
    if (!S.enabled && !S.running) { const p = document.getElementById(PANEL_ID); if (p) p.remove(); }
  });
  init();
})();
