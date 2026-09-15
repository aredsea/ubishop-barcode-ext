/* =============================================================================
 *  orderimport.js — 판매처 주문 가져오기 UI·실행기 배선 (ISOLATED, orderItemWriteForm.do 전용).
 *  사이드바(skin.js) 의 [주문 가져오기] 버튼 → 패널: 파일 → 검토 표 → [등록 시작] → 진행/결과.
 *  로직은 orderimport-core.js(순수), 서버 호출은 orderimport-erp.js. 이 파일은 DOM·storage·배선만.
 *  스펙: docs/superpowers/specs/2026-09-14-orderimport-design.md §3·§5·§6
 * ========================================================================== */
(function () {
  'use strict';
  if (window.top !== window) return;
  if (!/\/order\/item\/orderItemWriteForm\.do/.test(location.pathname)) return;
  const C = globalThis.ubOi, E = globalThis.ubOiErp;
  if (!C || !E) { console.warn('[UB][oi] core/erp 미로드 — manifest 순서 확인'); return; }

  const KEY_MAP = 'ubOiMap', KEY_LEDGER = 'ubOiLedger', PANEL_ID = 'ub-oi-panel', STYLE_ID = 'ub-oi-style';
  const S = { enabled: false, map: {}, ledger: {}, orders: [], masters: {}, running: false, starting: false, results: [], log: [], xlsReady: false, seq: 0, fileGen: 0, fileName: '' };

  /* ------------------------------------------------------------ storage */
  const sget = (q) => new Promise((res) => chrome.storage.local.get(q, res));
  const sset = (o) => new Promise((res) => chrome.storage.local.set(o, res));
  async function loadState() {
    const d = await sget({ ubSkin: false, ubOrderImport: true, [KEY_MAP]: {}, [KEY_LEDGER]: {} });
    S.enabled = !!(d.ubSkin && d.ubOrderImport);
    S.map = d[KEY_MAP] || {}; S.ledger = d[KEY_LEDGER] || {};
  }
  const saveMap = () => sset({ [KEY_MAP]: S.map });
  const saveLedger = () => sset({ [KEY_LEDGER]: S.ledger });

  /* ------------------------------------------------------------ xls (MAIN 주입) */
  function ensureXls() {
    if (S.xlsReady) return Promise.resolve(true);
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ source: 'ub', type: 'ubOiInjectXls' }, (r) => {
          if (chrome.runtime.lastError) { res(false); return; }
          S.xlsReady = !!(r && r.ok); res(S.xlsReady);
        });
      } catch (_) { res(false); }
    });
  }
  async function readXls(file) {
    if (!(await ensureXls())) throw new Error('엑셀 읽기 모듈을 못 불러왔습니다. 다시 시도하거나 브라우저를 재시작하세요.');
    const buf = await file.arrayBuffer();
    const id = 'oi' + (++S.seq) + '-' + Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener('message', on); reject(new Error('엑셀 읽기 응답 없음(20초)')); }, 20000);
      function on(e) {
        const d = e.data;
        if (!d || e.source !== window || d.source !== 'ub-oi-xls' || d.id !== id) return;
        clearTimeout(timer); window.removeEventListener('message', on);
        if (d.ok) resolve(d.rows); else reject(new Error(d.error || '엑셀 읽기 실패'));
      }
      window.addEventListener('message', on);
      window.postMessage({ source: 'ub-oi', type: 'parse', id, buf }, '*');
    });
  }

  /* ------------------------------------------------------------ 모델 */
  function refreshLine(line) {
    line.parsed = C.oiParseOption(line.optionText);
    line.keys = C.oiMapKeys(line.productName, line.parsed);
    line.mapping = C.oiLookupMap(S.map, line.keys);
    const entry = line.mapping ? line.mapping.entry : null;
    if (!line.spec) line.spec = {};
    const sp = line.spec;
    if (sp.k == null) sp.k = line.parsed.k;
    if (sp.color == null) sp.color = line.parsed.color;
    if (sp.itemSize == null) sp.itemSize = line.parsed.itemSize;
    if (sp.qty == null) sp.qty = line.qty;
    if (sp.price == null) sp.price = line.price;
    if (sp.remark == null || sp.remarkAuto !== false) { sp.remark = C.oiRemark(line.settle, entry && entry.remarkSuffix); sp.remarkAuto = true; }
    const form = entry ? S.masters[entry.seq] : null;
    line.issues = C.oiLineIssues(Object.assign({}, line, { price: sp.price, qty: sp.qty }), { mapping: line.mapping, parsed: Object.assign({}, line.parsed, { k: sp.k, color: sp.color, itemSize: sp.itemSize }), form, optOverride: !!sp.optOverride });
  }
  function refreshOrder(o) {
    o.lines.forEach(refreshLine);
    o.ready = o.lines.every((l) => !l.issues.length) && !!o.market && o.phone.ok;
    if (o.checked == null || !o.ready) o.checked = o.ready;
    o.prev = S.ledger[o.key] || null;
  }
  function buildOrders(rows) {
    const pr = C.oiParseRows(rows);
    if (pr.error) throw new Error(pr.error);
    S.orders = C.oiGroupOrders(pr.lines);
    S.orders.forEach(refreshOrder);
  }
  //  읽기 전용 보강: 마스터 폼(k/색상 옵션·기본값)·고객 판정·추천 후보. 실패해도 검토 표는 뜬다.
  async function enrich() {
    const seqs = new Set();
    S.orders.forEach((o) => o.lines.forEach((l) => { if (l.mapping) seqs.add(l.mapping.entry.seq); }));
    for (const seq of seqs) {
      if (S.masters[seq]) continue;
      try { S.masters[seq] = await E.getWriteForm({ tradeJun: '', master: seq, client: '', clientName: '' }); } catch (e) { logLine('-', 'master_form_error', seq + ' ' + e.message); }
    }
    for (const o of S.orders) {
      if (o.customer || !o.market || !o.phone.ok) continue;
      try {
        const byName = await E.searchClient('clientName', o.clientName);
        const exact = byName.find((c) => c.name === o.clientName);
        if (exact) { o.customer = { mode: 'reuse', seq: exact.seq }; continue; }
        const byPhone = await E.searchClient('phone', o.phone.phone);
        o.customer = { mode: byPhone.some((c) => c.phone === o.phone.phone) ? 'new_nophone' : 'new' };
      } catch (e) { o.customer = { mode: 'unknown', error: e.message }; }
    }
    for (const o of S.orders) for (const l of o.lines) {
      if (l.mapping || l.suggest) continue;
      l.suggest = [];
      for (const q of C.oiSuggestQueries(l.productName).slice(0, 3)) {
        try { const hits = await E.searchMaster(q); if (hits.length) { l.suggest = hits.slice(0, 10); l.suggestQuery = q; break; } } catch (_) {}
      }
    }
    S.orders.forEach(refreshOrder);
  }

  /* ------------------------------------------------------------ 실행 */
  function logLine(key, step, info) {
    S.log.push({ t: new Date().toISOString(), key, step, info: (typeof info === 'string') ? info : JSON.parse(JSON.stringify(info || null)) });
    if (S.log.length > 5000) S.log.splice(0, S.log.length - 5000);
  }
  function toRunOrder(o) {
    return {
      key: o.key, seller: o.seller, orderNo: o.orderNo, market: o.market, buyer: o.buyer, phone: o.phone, clientName: o.clientName,
      lines: o.lines.map((l) => ({
        master: { seq: l.mapping.entry.seq, code: l.mapping.entry.code, name: l.mapping.entry.name, colorFallback: l.mapping.entry.colorFallback || '' },
        spec: { k: l.spec.k || null, color: l.spec.color || null, itemSize: l.spec.itemSize == null ? '' : String(l.spec.itemSize), qty: Number(l.spec.qty), price: Number(l.spec.price), remark: l.spec.remark || '' }
      }))
    };
  }
  async function run() {
    //  첫 await 전에 선점한다 — 빠른 두 번 클릭이 둘 다 S.running 검사를 지나 이중 실행되던 경합(Terra 4R P1).
    if (S.running || S.starting) return;
    S.starting = true;
    try {
      await loadState();                                     // 패널을 연 뒤 팝업에서 스위치를 껐을 수 있다(Terra 3R P2) — 실행 직전에 다시 읽는다
      if (!S.enabled) { alert('[유비샵 스킨모드]·[주문 가져오기] 스위치가 꺼져 있어 실행하지 않습니다.'); render(); return; }
      const targets = S.orders.filter((o) => o.checked && o.ready);
      if (!targets.length) { alert('실행할 주문장이 없습니다(문제 있는 주문장은 체크되지 않습니다).'); return; }
      if (!confirm(targets.length + '개 주문장(' + targets.reduce((n, o) => n + o.lines.length, 0) + '줄)을 유비샵에 등록합니다.\n실행 중에는 주문 화면을 조작하지 마세요. 진행할까요?')) return;
      S.running = true;
    } finally { S.starting = false; }
    if (!S.running) return;
    await runTargets(S.orders.filter((o) => o.checked && o.ready));
  }
  async function runTargets(targets) {
    S.results = [];
    window.addEventListener('beforeunload', onUnload);
    render();
    try {
      const results = await C.oiRunAll(targets.map(toRunOrder), E, {
        today: () => new Date(),
        log: logLine,
        onOrder: (r) => {
          S.results.push(r);
          if (r.status === 'done') { S.ledger[r.key] = { at: new Date().toISOString(), tradeJun: r.tradeJun, junNums: r.junNums.map((j) => j.junNum), lines: r.orderSeqs.length }; saveLedger(); }
          const o = S.orders.find((x) => x.key === r.key); if (o) { o.result = r; if (r.status === 'done') o.checked = false; }
          render();
        }
      });
      S.results = results;
    } catch (e) { logLine('-', 'run_exception', String(e && e.message || e)); alert('실행 중 오류: ' + (e && e.message || e)); }
    S.running = false;
    window.removeEventListener('beforeunload', onUnload);
    S.orders.forEach(refreshOrder);
    render();
  }
  function onUnload(e) { e.preventDefault(); e.returnValue = ''; }

  /* ------------------------------------------------------------ UI */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const CSS = `
#${PANEL_ID}{position:fixed;inset:24px;z-index:2147483647;background:#fff;border:1px solid #cfd6dd;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:flex;flex-direction:column;font:13px/1.45 Pretendard,"Malgun Gothic",sans-serif;color:#222}
#${PANEL_ID} *{box-sizing:border-box}
#${PANEL_ID} .oi-h{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #e6eaef;background:#f7f9fb;border-radius:10px 10px 0 0}
#${PANEL_ID} .oi-h b{font-size:15px}
#${PANEL_ID} .oi-h .oi-x{margin-left:auto;border:0;background:none;font-size:20px;cursor:pointer;color:#666}
#${PANEL_ID} .oi-b{flex:1;overflow:auto;padding:12px 14px}
#${PANEL_ID} .oi-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
#${PANEL_ID} .oi-btn{border:1px solid #b8c2cc;background:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px}
#${PANEL_ID} .oi-btn.pri{background:#4abcc7;border-color:#4abcc7;color:#fff;font-weight:700}
#${PANEL_ID} .oi-btn:disabled{opacity:.45;cursor:default}
#${PANEL_ID} .oi-lock{background:#fff4e5;border:1px solid #f0c36d;color:#7a4b00;padding:8px 12px;border-radius:6px;font-weight:700;margin-bottom:10px}
#${PANEL_ID} table.oi-t{width:100%;border-collapse:collapse;font-size:12px}
#${PANEL_ID} table.oi-t th,#${PANEL_ID} table.oi-t td{border:1px solid #e3e8ee;padding:4px 6px;vertical-align:top;text-align:left}
#${PANEL_ID} table.oi-t th{background:#f3f6f9;font-weight:600;white-space:nowrap}
#${PANEL_ID} tr.oi-o td{background:#eef7f8;font-weight:600}
#${PANEL_ID} tr.oi-o.bad td{background:#fdecec}
#${PANEL_ID} .oi-issue{color:#b42318;font-weight:600}
#${PANEL_ID} .oi-warn{background:#fff8e1}
#${PANEL_ID} input.oi-in{width:100%;border:1px solid #c9d2dc;border-radius:4px;padding:3px 5px;font-size:12px}
#${PANEL_ID} input.oi-in.sm{width:64px}
#${PANEL_ID} select.oi-in{width:100%;border:1px solid #c9d2dc;border-radius:4px;padding:3px;font-size:12px}
#${PANEL_ID} .oi-muted{color:#777}
#${PANEL_ID} .oi-res{margin-top:12px}
#${PANEL_ID} .st-done{color:#087a3f;font-weight:700}.st-skipped{color:#b45309;font-weight:700}.st-fatal,.st-blocked{color:#b42318;font-weight:700}
#ub-oi-veil{position:fixed;inset:0;z-index:2147483646;background:rgba(20,30,40,.35)}
`;
  function ensureStyle() { if (!document.getElementById(STYLE_ID)) { const s = document.createElement('style'); s.id = STYLE_ID; s.textContent = CSS; document.head.appendChild(s); } }

  //  코드표 밖 판매처: 이 세션에서만 접미·마켓을 정한다(스펙 §2.3, Terra 4R P2). 표에는 저장하지 않는다.
  const MARKET_OPTS = [['2', 'SSG'], ['3', 'CJ몰'], ['4', 'H몰'], ['5', '스마트스토어'], ['6', '카페24'], ['7', 'GS샵'], ['8', '쿠팡'], ['9', '위메프'], ['10', '롯데ON'], ['11', '카카오'], ['12', '11번가'], ['13', 'G마켓'], ['14', '옥션'], ['15', '더리본샵'], ['16', 'AK몰'], ['17', '지그재그'], ['18', '아몬즈'], ['19', '지인소개'], ['20', '퀸잇'], ['21', '에이블리'], ['22', '오늘룩']];
  function marketPick(o, oi) {
    return '<span class="oi-issue">판매처 미등록(' + esc(o.seller) + ')</span> 접미 <input class="oi-in sm" data-f="mkt-suffix" data-o="' + oi + '" placeholder="예: 십" maxlength="4"> 마켓 <select class="oi-in" style="width:auto" data-f="mkt-job" data-o="' + oi + '"><option value="">— 선택 —</option>'
      + MARKET_OPTS.map(([v, t]) => '<option value="' + v + '">' + esc(t) + '</option>').join('') + '</select> <button class="oi-btn" data-act="mkt-apply" data-o="' + oi + '">적용</button>';
  }
  function custText(o) {
    if (!o.customer) return '<span class="oi-muted">조회 전</span>';
    const m = o.customer.mode;
    if (m === 'reuse') return '재사용 #' + esc(o.customer.seq);
    if (m === 'new') return '신규 등록';
    if (m === 'new_nophone') return '신규 등록 <b>(휴대폰 비움 — 다른 고객이 사용 중)</b>';
    return '<span class="oi-issue">조회 실패</span>';
  }
  function lineRow(o, oi, l, li) {
    const e = l.mapping ? l.mapping.entry : null;
    const prod = e
      ? esc(e.name) + ' <span class="oi-muted">' + esc(e.code) + '</span> <button class="oi-btn" data-act="unmap" data-o="' + oi + '" data-l="' + li + '" title="매핑 지우기">✕</button>'
      : '<select class="oi-in" data-f="pick" data-o="' + oi + '" data-l="' + li + '"><option value="">— 유비샵 상품 선택' + (l.suggestQuery ? ' (검색어: ' + esc(l.suggestQuery) + ')' : '') + ' —</option>'
        + (l.suggest || []).map((s) => '<option value="' + esc(s.seq + '|' + s.code + '|' + s.name) + '">' + esc(s.name) + ' · ' + esc(s.code) + '</option>').join('')
        + '</select><div style="display:flex;gap:4px;margin-top:3px"><input class="oi-in" placeholder="직접 검색(공백 없이)" data-f="q" data-o="' + oi + '" data-l="' + li + '"><button class="oi-btn" data-act="search" data-o="' + oi + '" data-l="' + li + '">검색</button></div>';
    const inp = (f, v, cls) => '<input class="oi-in ' + (cls || 'sm') + '" data-f="' + f + '" data-o="' + oi + '" data-l="' + li + '" value="' + esc(v == null ? '' : v) + '">';
    const issues = l.issues.length ? '<div class="oi-issue">' + l.issues.map(esc).join('<br>') + '</div>' : '';
    return '<tr class="oi-l' + (l.issues.length ? ' oi-warn' : '') + '"><td></td><td colspan="2">' + esc(l.productName) + '<br><span class="oi-muted">' + esc(l.optionText || '(옵션 없음)') + '</span>' + issues + '</td>'
      + '<td>' + prod + '</td><td>' + inp('k', l.spec.k) + '</td><td>' + inp('color', l.spec.color) + '</td><td>' + inp('itemSize', l.spec.itemSize) + '</td>'
      + '<td>' + inp('qty', l.spec.qty) + '</td><td>' + inp('price', l.spec.price) + '</td><td>' + inp('remark', l.spec.remark, '') + '</td></tr>';
  }
  function orderRow(o, oi) {
    const st = o.result ? '<span class="st-' + esc(o.result.status) + '">' + esc(o.result.status) + '</span> ' + esc(o.result.reason || '') + (o.result.junNums && o.result.junNums.length ? ' · 관리번호 ' + o.result.junNums.map((j) => esc(j.junNum)).join(',') : '') : '';
    const prev = o.prev ? '<div class="oi-issue">이전에 넣음 ' + esc(String(o.prev.at).slice(0, 16).replace('T', ' ')) + (o.prev.junNums ? ' · ' + esc(o.prev.junNums.join(',')) : '') + '</div>' : '';
    return '<tr class="oi-o' + (o.ready ? '' : ' bad') + '"><td><input type="checkbox" data-f="chk" data-o="' + oi + '"' + (o.checked ? ' checked' : '') + (o.ready && !S.running ? '' : ' disabled') + '></td>'
      + '<td>' + esc(o.seller) + ' ' + esc(o.orderNo) + prev + '</td><td>' + (o.clientName ? esc(o.clientName) : '(' + esc(o.seller) + ' 미등록)') + '<br><span class="oi-muted">' + esc(o.phone.phone || o.phone.raw) + '</span></td>'
      + '<td colspan="7">' + (o.market ? custText(o) : marketPick(o, oi)) + (st ? ' · ' + st : '') + '</td></tr>' + o.lines.map((l, li) => lineRow(o, oi, l, li)).join('');
  }
  function render() {
    const p = document.getElementById(PANEL_ID); if (!p) return;
    const nOrd = S.orders.length, nReady = S.orders.filter((o) => o.ready).length, nChk = S.orders.filter((o) => o.checked && o.ready).length;
    const nLines = S.orders.reduce((n, o) => n + o.lines.length, 0);
    const done = S.results.filter((r) => r.status === 'done').length, skipped = S.results.filter((r) => r.status !== 'done').length;
    p.querySelector('.oi-b').innerHTML =
      (S.running ? '<div class="oi-lock">⏳ 실행 중 — 이 창과 유비샵 주문 화면을 조작하지 마세요 (' + S.results.length + '/' + nChk + ')</div>' : '')
      + '<div class="oi-bar"><input type="file" id="ub-oi-file" accept=".xls,.xlsx"' + (S.running ? ' disabled' : '') + '> '
      + (nOrd ? '<span>' + esc(S.fileName) + ' · 주문장 ' + nOrd + ' · 줄 ' + nLines + ' · 실행 가능 ' + nReady + ' · 체크 ' + nChk + '</span>' : '<span class="oi-muted">이지어드민 확장주문검색 xls(판매가 열 포함)를 선택하세요</span>')
      + '<span style="margin-left:auto"></span>'
      + '<button class="oi-btn pri" data-act="run"' + (nChk && !S.running && S.enabled ? '' : ' disabled') + (S.enabled ? '' : ' title="스위치가 꺼져 있습니다"') + '>등록 시작</button>'
      + '<button class="oi-btn" data-act="export-map">매핑표 내보내기</button><label class="oi-btn">매핑표 가져오기<input type="file" id="ub-oi-mapfile" accept=".json" hidden></label>'
      + '<button class="oi-btn" data-act="export-log">로그 JSON</button></div>'
      + (nOrd ? '<table class="oi-t"><thead><tr><th><input type="checkbox" data-f="chkall" title="실행 가능한 주문장 전체 체크/해제"' + (nReady && nChk === nReady ? ' checked' : '') + (nReady && !S.running ? '' : ' disabled') + '></th><th>판매처 · 주문번호</th><th>고객명 · 휴대폰</th><th>유비샵 상품</th><th>품위</th><th>색상</th><th>사이즈</th><th>수량</th><th>판매가</th><th>비고</th></tr></thead><tbody>'
        + S.orders.map(orderRow).join('') + '</tbody></table>' : '')
      + (S.results.length ? '<div class="oi-res"><b>결과</b> — 완료 ' + done + ' · 건너뜀/중단 ' + skipped + '<table class="oi-t"><thead><tr><th>주문장</th><th>상태</th><th>사유</th><th>고객</th><th>관리번호</th><th>되돌림</th></tr></thead><tbody>'
        + S.results.map((r) => '<tr><td>' + esc(r.key) + '</td><td class="st-' + esc(r.status) + '">' + esc(r.status) + '</td><td>' + esc(r.reason || '') + '</td><td>' + esc(r.client ? r.client.name + ' #' + r.client.seq + ' (' + r.client.mode + ')' : '') + '</td><td>' + esc((r.junNums || []).map((j) => j.junNum).join(', ')) + '</td><td>' + esc(r.rolledBack || 0) + '</td></tr>').join('')
        + '</tbody></table></div>' : '');
  }
  function openPanel() {
    ensureStyle();
    if (document.getElementById(PANEL_ID)) return;
    const veil = document.createElement('div'); veil.id = 'ub-oi-veil'; document.body.appendChild(veil);
    const p = document.createElement('div'); p.id = PANEL_ID;
    p.innerHTML = '<div class="oi-h"><b>주문 가져오기</b><span class="oi-muted">이지어드민 xls → 고객·줄 등록 → 주문장 완료</span><button class="oi-x" data-act="close" title="닫기">×</button></div><div class="oi-b"></div>';
    document.body.appendChild(p);
    p.addEventListener('click', onClick);
    p.addEventListener('change', onChange);
    render();
  }
  function closePanel() {
    if (S.running && !confirm('실행 중입니다. 정말 닫을까요? (진행 중인 주문장은 서버에 남을 수 있습니다)')) return;
    const p = document.getElementById(PANEL_ID); if (p) p.remove();
    const v = document.getElementById('ub-oi-veil'); if (v) v.remove();
  }
  function download(name, obj) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
    a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  async function onClick(e) {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'close') closePanel();
    else if (act === 'run') run();
    else if (act === 'export-map') download('ub-orderimport-map-' + new Date().toISOString().slice(0, 10) + '.json', S.map);
    else if (act === 'export-log') download('ub-orderimport-log-' + Date.now() + '.json', { results: S.results, log: S.log });
    else if (act === 'mkt-apply') {
      const o = S.orders[+btn.dataset.o]; const wrap = btn.parentElement;
      const suf = (wrap.querySelector('input[data-f="mkt-suffix"]') || {}).value || '';
      const job = (wrap.querySelector('select[data-f="mkt-job"]') || {}).value || '';
      if (!suf.trim() || !job) { alert('접미와 마켓을 모두 고르세요.'); return; }
      if (!C.oiApplyMarket(o, suf, job)) return;
      o.customer = null; refreshOrder(o); render(); await enrich(); render();
    }
    else if (act === 'unmap') { const l = S.orders[+btn.dataset.o].lines[+btn.dataset.l]; l.keys.forEach((k) => { delete S.map[k]; }); l.suggest = null; await saveMap(); S.orders.forEach(refreshOrder); await enrich(); render(); }
    else if (act === 'search') {
      const l = S.orders[+btn.dataset.o].lines[+btn.dataset.l];
      const q = (btn.parentElement.querySelector('input[data-f="q"]') || {}).value || '';
      if (!q.trim()) return;
      try { l.suggest = (await E.searchMaster(q.replace(/\s+/g, ''))).slice(0, 10); l.suggestQuery = q; } catch (err) { alert('검색 실패: ' + err.message); }
      render();
    }
  }
  async function onChange(e) {
    const el = e.target;
    if (el.id === 'ub-oi-file') { const f = el.files && el.files[0]; if (f) await loadFile(f); return; }
    if (el.id === 'ub-oi-mapfile') { const f = el.files && el.files[0]; if (f) await importMap(f); return; }
    const f = el.dataset.f; if (!f) return;
    if (f === 'chk') { const o = S.orders[+el.dataset.o]; o.checked = el.checked && o.ready; render(); return; }
    if (f === 'chkall') { S.orders.forEach((o) => { o.checked = el.checked && o.ready; }); render(); return; }   // 일괄 체크(사장님 요청 2026-09-15) — 문제 있는 주문장은 원래대로 제외
    const o = S.orders[+el.dataset.o]; const l = o.lines[+el.dataset.l];
    if (f === 'pick') {
      if (!el.value) return;
      const [seq, code, name] = el.value.split('|');
      S.map = C.oiLearn(S.map, l.keys, { seq, code, name }, new Date().toISOString());
      await saveMap();
      S.orders.forEach(refreshOrder);        // 같은 키의 다른 줄에도 즉시 전파
      await enrich(); render(); return;
    }
    if (f === 'k' || f === 'color') { l.spec[f] = el.value.trim() || null; l.spec.optOverride = true; }     // 사람이 보정 → 원문 미해석 토큰은 차단 사유에서 제외(Terra 4R P2)
    else if (f === 'itemSize') { l.spec.itemSize = el.value.trim(); l.spec.optOverride = true; }
    else if (f === 'qty') l.spec.qty = C.oiMoney(el.value);
    else if (f === 'price') l.spec.price = C.oiMoney(el.value);
    else if (f === 'remark') { l.spec.remark = el.value; l.spec.remarkAuto = false; }
    refreshOrder(o); render();
  }
  async function loadFile(file) {
    //  파일을 연달아 고르면 먼저 고른(큰) 파일의 파싱이 나중에 끝나 나중 파일의 표를 덮어쓴다(Terra 8R P1) — 세대 토큰으로 최신 선택만 반영.
    const gen = ++S.fileGen;
    try {
      S.fileName = file.name; S.results = []; S.orders = [];
      const rows = await readXls(file);
      if (gen !== S.fileGen) return;
      buildOrders(rows);
      render();
      await enrich();
      if (gen !== S.fileGen) return;
      render();
    } catch (err) { if (gen !== S.fileGen) return; alert('파일을 읽지 못했습니다: ' + (err && err.message || err)); S.orders = []; render(); }
  }
  async function importMap(file) {
    try {
      const obj = JSON.parse(await file.text());
      if (!obj || typeof obj !== 'object') throw new Error('JSON 객체가 아닙니다');
      let n = 0, bad = 0;
      Object.keys(obj).forEach((k) => { if (C.oiValidMapEntry(obj[k])) { S.map[k] = obj[k]; n++; } else bad++; });   // seq·code 둘 다 없는 항목은 버린다(Terra 8R P2)
      await saveMap(); S.orders.forEach(refreshOrder); render();
      alert(n + '개 항목을 매핑표에 합쳤습니다.' + (bad ? ' (seq/code 가 없는 ' + bad + '개는 건너뜀)' : ''));
    } catch (err) { alert('매핑표 가져오기 실패: ' + (err && err.message || err)); }
  }

  /* ------------------------------------------------------------ 배선 */
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('#ub-oi-open');
    if (!b) return;
    e.preventDefault();
    if (!S.enabled) { alert('팝업에서 [유비샵 스킨모드]와 [주문 가져오기]를 켜세요.'); return; }
    openPanel();
  }, true);
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.ubSkin || ch.ubOrderImport) loadState().then(() => { if (!S.running) render(); });   // 열린 패널의 실행 버튼도 즉시 잠근다
    if (ch[KEY_MAP] && !S.running) { S.map = ch[KEY_MAP].newValue || {}; S.orders.forEach(refreshOrder); render(); }
  });
  loadState();
})();
