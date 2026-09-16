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
  const S = { enabled: false, map: {}, ledger: {}, orders: [], masters: {}, running: false, starting: false, enriching: null, results: [], log: [], xlsReady: false, seq: 0, fileGen: 0, fileName: '',
    //  진행 표시(스펙 2026-09-16 §3): phase 는 idle|reading|enriching|running, progress 는 스트립이 읽는 카운터·문구.
    phase: 'idle', progress: { done: 0, total: 0, m: [0, 0], c: [0, 0], s: [0, 0], key: '', label: '' } };

  /* ------------------------------------------------------------ storage */
  const sget = (q) => new Promise((res) => chrome.storage.local.get(q, res));
  const sset = (o) => new Promise((res) => chrome.storage.local.set(o, res));
  async function loadState() {
    const d = await sget({ ubSkin: false, ubOrderImport: true, [KEY_MAP]: {}, [KEY_LEDGER]: {} });
    S.enabled = !!(d.ubSkin && d.ubOrderImport);
    S.map = d[KEY_MAP] || {}; S.ledger = d[KEY_LEDGER] || {};
  }
  const saveMap = () => sset({ [KEY_MAP]: S.map });
  //  장부는 저장 직전에 다시 읽어 병합한다 — 다른 탭이 그 사이 넣은 항목을 통째로 덮어쓰지 않게(Opus 5 P2).
  async function saveLedger() {
    const d = await sget({ [KEY_LEDGER]: {} });
    S.ledger = Object.assign({}, d[KEY_LEDGER] || {}, S.ledger);
    await sset({ [KEY_LEDGER]: S.ledger });
  }

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
        if (d.ok) resolve({ rows: d.rows, numericPhoneRows: d.numericPhoneRows || [] }); else reject(new Error(d.error || '엑셀 읽기 실패'));
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
    o.prev = S.ledger[o.key] || null;
    //  장부와 주문번호·상품이 완전히 같으면 기본 체크를 풀어 두고 사람이 정하게 한다(스펙 2026-09-16 §5b). 첫 판정 때만 — 그 뒤는 사용자의 체크가 우선.
    const wasDup = !!(o.dup && o.dup.dup);
    o.dup = C.oiDupCheck(o, o.prev);
    //  첫 판정, 또는 판정 뒤에 새로 중복이 된 순간(다른 탭이 그 사이 등록 — 그때의 체크는 중복을 모르고 한 것)에만 기본값을 적용한다(Opus O1 P2-5).
    if (o.checked == null || (o.dup.dup && !wasDup && !o.ledgered)) o.checked = o.ready && !o.dup.dup;
    else if (!o.ready) o.checked = false;
  }
  function buildOrders(parsed) {
    const pr = C.oiParseRows(parsed.rows, { numericPhoneRows: parsed.numericPhoneRows });
    if (pr.error) throw new Error(pr.error);
    S.orders = C.oiGroupOrders(pr.lines);
    S.orders.forEach(refreshOrder);
  }
  //  읽기 전용 보강: 마스터 폼(k/색상 옵션·기본값)·고객 판정·추천 후보. 실패해도 검토 표는 뜬다.
  //  실행 중엔 같은 세션에 GET 을 끼우지 않는다 — 실행기의 sKey GET→POST 사이에 들어가면 안 된다(Fable F2). 진입 게이트만으론 파일 로드 직후
  //  이미 돌고 있는 enrich 가 [등록 시작] 뒤에도 남은 요청을 보낸다(Fable G1) → 진행 중 프라미스를 S.enriching 에 잡아 run() 이 기다리고,
  //  루프의 매 요청 앞에서도 다시 본다.
  async function enrich() {
    if (S.running || S.starting) return;
    const p = Promise.resolve(S.enriching).catch(() => {}).then(enrichBody);   // 겹치는 조회는 직렬화 — S.enriching 이 항상 마지막 조회를 가리키게
    if (!S.enriching) progInit(C.oiEnrichTotal(S.orders, S.masters));   // 시작 직후 스트립이 이전 실행의 카운터를 보이지 않게(GLM 1R P3)
    S.phase = 'enriching'; S.enriching = p; render();
    try { await p; } finally { if (S.enriching === p) { S.enriching = null; if (S.phase === 'enriching') S.phase = 'idle'; render(); } }
  }
  //  진행 카운터: 요청 하나 끝날 때마다 +1. 표는 사람이 입력 중이 아닐 때만 다시 그린다(입력 중 포커스를 뺏지 않게) — 스트립은 항상 갱신.
  function progInit(tot) { S.progress = { done: 0, total: tot.total, m: [0, tot.masters], c: [0, tot.customers], s: [0, tot.suggests], key: '', label: '' }; }
  function progStep(cat) { const pr = S.progress; pr.done++; pr[cat][0]++; renderSoft(); }
  async function enrichBody() {
    progInit(C.oiEnrichTotal(S.orders, S.masters)); renderSoft();
    const seqs = new Set();
    S.orders.forEach((o) => o.lines.forEach((l) => { if (l.mapping) seqs.add(l.mapping.entry.seq); }));
    for (const seq of seqs) {
      if (S.masters[seq]) continue;
      if (S.running) return;
      try { S.masters[seq] = await E.getWriteForm({ tradeJun: '', master: seq, client: '', clientName: '' }); } catch (e) { logLine('-', 'master_form_error', seq + ' ' + e.message); }
      progStep('m');
    }
    for (const o of S.orders) {
      if (o.customer || !o.market || !o.phone.ok) continue;
      if (S.running) return;
      try {
        const byName = await E.searchClient('clientName', o.clientName);
        const exact = byName.find((c) => c.name === o.clientName);
        if (exact) { o.customer = { mode: 'reuse', seq: exact.seq }; progStep('c'); continue; }
        if (S.running) return;
        const byPhone = await E.searchClient('phone', o.phone.phone);
        o.customer = { mode: byPhone.some((c) => c.phone === o.phone.phone) ? 'new_nophone' : 'new' };
      } catch (e) { o.customer = { mode: 'unknown', error: e.message }; }
      progStep('c');
    }
    for (const o of S.orders) for (const l of o.lines) {
      if (l.mapping || l.suggest) continue;
      l.suggest = [];
      for (const q of C.oiSuggestQueries(l.productName).slice(0, 3)) {
        if (S.running) return;
        try { const hits = await E.searchMaster(q); if (hits.length) { l.suggest = hits.slice(0, 10); l.suggestQuery = q; break; } } catch (_) {}
      }
      progStep('s');
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
      key: o.key, seller: o.seller, orderNo: o.orderNo, buyer: o.buyer, phone: o.phone, clientName: o.clientName,
      market: Object.assign({}, o.market, { clientJob: C.oiClientJob(o) }),   // 카페24 정산 차 60%↑ → 등록 마켓만 지인소개(스펙 §5d)
      sig: C.oiOrderSig(o),                                     // 장부에 남겨 다음 파일에서 "완전히 같은 주문장" 을 가린다(스펙 §5b)
      lines: o.lines.map((l) => ({
        master: { seq: l.mapping.entry.seq, code: l.mapping.entry.code, name: l.mapping.entry.name, colorFallback: l.mapping.entry.colorFallback || '' },
        spec: { k: l.spec.k || null, color: l.spec.color || null, itemSize: l.spec.itemSize == null ? '' : String(l.spec.itemSize), qty: Number(l.spec.qty), price: Number(l.spec.price), gift: !!l.gift, remark: l.spec.remark || '' }
      }))
    };
  }
  async function run() {
    //  첫 await 전에 선점한다 — 빠른 두 번 클릭이 둘 다 S.running 검사를 지나 이중 실행되던 경합(Terra 4R P1).
    if (S.running || S.starting) return;
    S.starting = true;
    let jobs = [];
    try {
      await loadState();                                     // 패널을 연 뒤 팝업에서 스위치를 껐을 수 있다(Terra 3R P2) — 실행 직전에 다시 읽는다
      if (!S.enabled) { alert('[유비샵 스킨모드]·[주문 가져오기] 스위치가 꺼져 있어 실행하지 않습니다.'); render(); return; }
      const targets = S.orders.filter((o) => o.checked && o.ready);
      if (!targets.length) { alert('실행할 주문장이 없습니다(문제 있는 주문장은 체크되지 않습니다).'); return; }
      const nDup = targets.filter((o) => o.dup && o.dup.dup).length;
      if (!confirm(targets.length + '개 주문장(' + targets.reduce((n, o) => n + o.lines.length, 0) + '줄)을 유비샵에 등록합니다.'
        + (nDup ? '\n※ 이미 등록된 것과 같은 주문장 ' + nDup + '개가 포함돼 있습니다(중복 등록).' : '')
        + '\n실행 중에는 주문 화면을 조작하지 마세요. 진행할까요?')) return;
      jobs = targets.map(toRunOrder);                          // confirm 한 집합을 그대로 실행한다 — 조회 대기 뒤 다시 거르지 않는다(Fable F3 Nit)
      while (S.enriching) { try { await S.enriching; } catch (_) {} }   // 진행 중인 조회가 실행기의 요청 사이에 끼지 않게 끝까지 기다린다(Fable G1)
      S.running = true;
    } finally { S.starting = false; if (!S.running) render(); }   // 조기 return(취소·대상 없음)이면 시작 대기 중 삼킨 체크박스 클릭의 표시를 모델과 다시 맞춘다(Fable F4 Nit)
    if (!S.running) return;
    await runTargets(jobs);
  }
  async function runTargets(jobs) {
    S.results = [];
    window.addEventListener('beforeunload', onUnload);
    S.phase = 'running'; S.progress = { done: 0, total: jobs.length, m: [0, 0], c: [0, 0], s: [0, 0], key: jobs.length ? jobs[0].key : '', label: '시작' };
    render();
    try {
      const results = await C.oiRunAll(jobs, E, {
        today: () => new Date(),
        log: (key, step, info) => {   // 진행 스트립 문구는 실행기 log 에서 온다(스펙 §3) — 표는 다시 그리지 않고 스트립만 갱신
          logLine(key, step, info);
          S.progress.key = key; S.progress.label = C.oiStepLabel(step, info, S.progress.label); progPatch();
        },
        onOrder: (r) => {
          S.results.push(r); S.progress.done++;
          //  체크 해제·장부 기록 판정은 core 의 순수 함수(Opus 5 P1 — 완료됐을 수 있는 fatal 이 체크된 채 남아 재클릭 때 중복 주문장이 생겼다)
          const ps = C.oiPostRunState(r, new Date().toISOString());
          if (ps.ledgerEntry) { S.ledger[r.key] = ps.ledgerEntry; saveLedger(); }
          const o = S.orders.find((x) => x.key === r.key); if (o) { o.result = r; o.ledgered = !!ps.ledgerEntry; if (ps.uncheck) o.checked = false; }
          render();
        }
      });
      S.results = results;
    } catch (e) { logLine('-', 'run_exception', String(e && e.message || e)); alert('실행 중 오류: ' + (e && e.message || e)); }
    S.running = false; S.phase = 'idle';
    window.removeEventListener('beforeunload', onUnload);
    S.orders.forEach(refreshOrder);
    render();
  }
  function onUnload(e) { e.preventDefault(); e.returnValue = ''; }

  /* ------------------------------------------------------------ UI */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const CSS = `
#${PANEL_ID}{--ub-bg:#ffffff;--ub-bg2:#f7f9fc;--ub-fg:#1b1b1b;--ub-sub:#6b7280;--ub-line:#e5e7eb;--ub-soft:#f9fafb;--ub-on:#35C5F0;--ub-on-hover:#2bb5e0;--ub-on-soft:#e0f4fc;--oi-ok:#12995a;--oi-warn:#c77a12;--oi-err:#e0483f;--oi-warn-bg:#fff7e6;--oi-err-bg:#fdecec;--oi-ok-bg:#e7f6ee;
  position:fixed;inset:24px;z-index:2147483647;display:flex;flex-direction:column;overflow:hidden;background:var(--ub-bg);color:var(--ub-fg);border:1px solid var(--ub-line);border-radius:12px;box-shadow:0 8px 24px rgba(15,20,25,.12),0 24px 64px rgba(15,20,25,.18);font:13px/1.45 'Pretendard','Malgun Gothic',sans-serif;-webkit-font-smoothing:antialiased}
#${PANEL_ID} *{box-sizing:border-box}
#${PANEL_ID} input,#${PANEL_ID} select,#${PANEL_ID} button,#${PANEL_ID} label{font:inherit;color:inherit}
/* 유비샵 pamas_main.css 의 body,td{font-family:"돋움";font-size:12px} 가 표의 모든 td 를 직접 때려(상속보다 우선) 셀 안 글자·칩·입력칸이 전부 돋움이 됐다(2026-09-16 실측). td/th 는 패널 글꼴을 다시 물려받는다. */
#${PANEL_ID} td,#${PANEL_ID} th{font:inherit}
#${PANEL_ID} svg.oi-ico{width:16px;height:16px;flex:none;stroke:currentColor;fill:none;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
#${PANEL_ID} .oi-h{display:flex;align-items:center;gap:16px;padding:12px 16px;background:var(--ub-bg2);border-bottom:1px solid var(--ub-line)}
#${PANEL_ID} .oi-title{font-size:15px;font-weight:700;letter-spacing:-.01em}
#${PANEL_ID} .oi-steps{display:flex;align-items:center;gap:8px;color:var(--ub-sub);font-size:12px}
#${PANEL_ID} .oi-step{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid transparent}
#${PANEL_ID} .oi-step .n{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:var(--ub-line);color:var(--ub-fg);font-size:11px;font-weight:700}
#${PANEL_ID} .oi-step.on{color:var(--ub-fg);font-weight:600;background:var(--ub-on-soft);border-color:#b9e6f5}
#${PANEL_ID} .oi-step.on .n{background:var(--ub-on);color:#fff}
#${PANEL_ID} .oi-step.done .n{background:var(--oi-ok);color:#fff}
#${PANEL_ID} .oi-step.done .n svg{width:11px;height:11px;stroke-width:2.5}
#${PANEL_ID} .oi-steps .sep{color:#c5cbd3}
#${PANEL_ID} .oi-x{margin-left:auto;width:32px;height:32px;border:0;background:none;border-radius:8px;color:var(--ub-sub);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
#${PANEL_ID} .oi-x:hover{background:var(--ub-line);color:var(--ub-fg)}
#${PANEL_ID} .oi-bar{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--ub-line);background:var(--ub-bg);flex-wrap:wrap}
#${PANEL_ID} .oi-count{display:inline-flex;gap:6px;align-items:center;margin-left:4px;color:var(--ub-sub)}
#${PANEL_ID} .oi-count b{color:var(--ub-fg);font-weight:600;font-variant-numeric:tabular-nums}
#${PANEL_ID} .oi-count i{font-style:normal;color:#c5cbd3}
#${PANEL_ID} .oi-spacer{margin-left:auto}
#${PANEL_ID} .oi-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:1px solid var(--ub-line);background:var(--ub-bg);border-radius:8px;font-size:12px;font-weight:600;color:var(--ub-fg);cursor:pointer;white-space:nowrap;transition:background-color .12s ease,border-color .12s ease,color .12s ease,transform .08s ease;user-select:none}
#${PANEL_ID} .oi-btn:hover{border-color:var(--ub-on);color:var(--ub-on);background:var(--ub-on-soft)}
#${PANEL_ID} .oi-btn:active{transform:translateY(1px)}
#${PANEL_ID} .oi-btn.pri{background:var(--ub-on);border-color:var(--ub-on);color:#fff;font-weight:700;padding:0 16px}
#${PANEL_ID} .oi-btn.pri:hover{background:var(--ub-on-hover);border-color:var(--ub-on-hover);color:#fff}
#${PANEL_ID} .oi-btn.quiet{border-color:transparent;color:var(--ub-sub);font-weight:500}
#${PANEL_ID} .oi-btn.quiet:hover{color:var(--ub-on);background:var(--ub-on-soft);border-color:transparent}
#${PANEL_ID} .oi-btn.sm{height:28px;padding:0 10px}
#${PANEL_ID} .oi-btn.icon{width:28px;padding:0}
#${PANEL_ID} .oi-btn:disabled{opacity:.45;cursor:default;transform:none}
#${PANEL_ID} .oi-btn:disabled:hover{border-color:var(--ub-line);color:var(--ub-fg);background:var(--ub-bg)}
#${PANEL_ID} .oi-btn.pri:disabled:hover{background:var(--ub-on);border-color:var(--ub-on);color:#fff}
#${PANEL_ID} :focus-visible{outline:2px solid var(--ub-on);outline-offset:2px}
#${PANEL_ID} .oi-prog{display:flex;align-items:center;gap:12px;padding:10px 16px;background:var(--ub-on-soft);border-bottom:1px solid #b9e6f5;color:var(--ub-fg)}
#${PANEL_ID} .oi-prog.run{background:var(--oi-warn-bg);border-bottom-color:#f0c36d}
#${PANEL_ID} .oi-prog .oi-spin{color:var(--ub-on)}
#${PANEL_ID} .oi-prog.run .oi-spin{color:var(--oi-warn)}
#${PANEL_ID} .oi-prog .txt{font-weight:600}
#${PANEL_ID} .oi-prog .sub{color:var(--ub-sub);font-weight:500}
#${PANEL_ID} .oi-prog .warn{color:#7a4b00;font-weight:700;margin-left:4px}
#${PANEL_ID} .oi-prog .bar{position:relative;flex:1;max-width:320px;height:6px;border-radius:999px;background:rgba(15,20,25,.08);overflow:hidden}
#${PANEL_ID} .oi-prog .bar>i{position:absolute;inset:0 auto 0 0;width:0;background:var(--ub-on);border-radius:999px;transition:width .25s ease}
#${PANEL_ID} .oi-prog.run .bar>i{background:var(--oi-warn)}
#${PANEL_ID} .oi-prog .bar.indet>i{width:35%;animation:oiIndet 1.1s ease-in-out infinite}
#${PANEL_ID} .oi-prog .cnt{font-variant-numeric:tabular-nums;color:var(--ub-sub);min-width:48px;text-align:right}
@keyframes oiSpin{to{transform:rotate(360deg)}}
@keyframes oiIndet{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
@keyframes oiShimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
#${PANEL_ID} .oi-spin{animation:oiSpin .9s linear infinite}
#${PANEL_ID} .oi-b{flex:1;overflow:auto;padding:0 16px 16px}
#${PANEL_ID} .oi-empty{padding:48px 16px;text-align:center;color:var(--ub-sub)}
#${PANEL_ID} .oi-banner{display:flex;align-items:center;gap:8px;margin-top:12px;padding:8px 12px;border-radius:8px;background:var(--oi-err-bg);color:#9f1d17;font-weight:600}
#${PANEL_ID} table.oi-t{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px;margin-top:12px}
#${PANEL_ID} table.oi-t th{position:sticky;top:0;z-index:1;background:var(--ub-bg2);color:var(--ub-sub);font-weight:600;font-size:12px;text-align:left;padding:8px 8px;border-bottom:1px solid var(--ub-line);white-space:nowrap}
#${PANEL_ID} table.oi-t td{padding:8px 8px;border-bottom:1px solid var(--ub-line);vertical-align:top}
#${PANEL_ID} table.oi-t th.num,#${PANEL_ID} table.oi-t td.num{text-align:right;font-variant-numeric:tabular-nums}
#${PANEL_ID} col.c-chk{width:36px}#${PANEL_ID} col.c-k{width:64px}#${PANEL_ID} col.c-color{width:72px}#${PANEL_ID} col.c-size{width:64px}#${PANEL_ID} col.c-qty{width:56px}#${PANEL_ID} col.c-price{width:96px}#${PANEL_ID} col.c-remark{width:180px}#${PANEL_ID} col.c-prod{width:34%}
#${PANEL_ID} tr.oi-o td{background:var(--ub-bg2);padding-top:10px;padding-bottom:10px}
#${PANEL_ID} tr.oi-o td:first-child{box-shadow:inset 3px 0 0 var(--ub-on)}
#${PANEL_ID} tr.oi-o.bad td:first-child{box-shadow:inset 3px 0 0 var(--oi-err)}
#${PANEL_ID} tr.oi-o.dup td:first-child{box-shadow:inset 3px 0 0 var(--oi-err)}
#${PANEL_ID} tr.oi-o.res-done td:first-child{box-shadow:inset 3px 0 0 var(--oi-ok)}
#${PANEL_ID} tr.oi-o.res-bad td:first-child{box-shadow:inset 3px 0 0 var(--oi-err)}
#${PANEL_ID} .oi-key{font-weight:700}
#${PANEL_ID} .oi-key .seller{display:inline-block;padding:1px 6px;margin-right:6px;border-radius:4px;background:var(--ub-bg);border:1px solid var(--ub-line);font-size:11px;font-weight:600;color:var(--ub-sub);vertical-align:1px}
#${PANEL_ID} .oi-cust{font-weight:600}
#${PANEL_ID} .oi-cust .oi-muted{font-weight:400;font-variant-numeric:tabular-nums}
#${PANEL_ID} tr.oi-l td:first-child{box-shadow:inset 3px 0 0 transparent}
#${PANEL_ID} tr.oi-l.oi-warn td:first-child{box-shadow:inset 3px 0 0 #f0c36d}
#${PANEL_ID} tr.oi-l.oi-cur td{background:#fffbf1}
#${PANEL_ID} .oi-name{font-weight:500}
#${PANEL_ID} .oi-opt{color:var(--ub-sub);font-size:12px;margin-top:1px}
#${PANEL_ID} .oi-issue{display:inline-flex;align-items:center;gap:4px;color:var(--oi-err);font-weight:600;font-size:12px;margin-top:3px}
#${PANEL_ID} .oi-issue svg.oi-ico{width:13px;height:13px}
#${PANEL_ID} .oi-muted{color:var(--ub-sub)}
#${PANEL_ID} .oi-note{color:var(--ub-sub);font-size:12px;margin-top:4px}
#${PANEL_ID} .oi-in{width:100%;height:28px;padding:0 8px;border:1px solid var(--ub-line);border-radius:6px;background:var(--ub-bg);color:var(--ub-fg);font-size:12.5px;transition:border-color .12s ease,box-shadow .12s ease}
#${PANEL_ID} .oi-in::placeholder{color:#9aa3ad}
#${PANEL_ID} .oi-in:focus{outline:none;border-color:var(--ub-on);box-shadow:0 0 0 3px rgba(53,197,240,.18)}
#${PANEL_ID} .oi-in.num{text-align:right;font-variant-numeric:tabular-nums}
#${PANEL_ID} .oi-in.sm{width:100%}
#${PANEL_ID} .oi-in:disabled{background:var(--ub-soft);color:var(--ub-sub)}
#${PANEL_ID} select.oi-in{padding-right:24px;appearance:none;background:var(--ub-bg) url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>") no-repeat right 8px center}
#${PANEL_ID} .oi-prod{display:flex;gap:6px;align-items:center}
#${PANEL_ID} .oi-prod .oi-in{flex:1;min-width:0}
#${PANEL_ID} .oi-prod .q{flex:0 0 150px}
#${PANEL_ID} .oi-mapped{display:flex;align-items:center;gap:6px}
#${PANEL_ID} .oi-mapped .nm{font-weight:600}
#${PANEL_ID} .oi-mapped .cd{color:var(--ub-sub);font-variant-numeric:tabular-nums}
#${PANEL_ID} .oi-sub-in{margin-top:6px}
#${PANEL_ID} .oi-mkt{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
#${PANEL_ID} .oi-mkt .oi-in{width:auto}
#${PANEL_ID} .oi-chip{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;font-size:11.5px;font-weight:600;line-height:1;white-space:nowrap;vertical-align:middle}
#${PANEL_ID} .oi-chip svg.oi-ico{width:12px;height:12px}
#${PANEL_ID} .oi-chip.reuse{background:var(--ub-on-soft);color:#0b7ea6}
#${PANEL_ID} .oi-chip.new{background:var(--ub-line);color:#374151}
#${PANEL_ID} .oi-chip.nophone{background:var(--oi-warn-bg);color:#7a4b00}
#${PANEL_ID} .oi-chip.fail,#${PANEL_ID} .oi-chip.fatal,#${PANEL_ID} .oi-chip.blocked,#${PANEL_ID} .oi-chip.dup{background:var(--oi-err-bg);color:#9f1d17}
#${PANEL_ID} .oi-chip.done{background:var(--oi-ok-bg);color:#0b6b3f}
#${PANEL_ID} .oi-chip.skipped,#${PANEL_ID} .oi-chip.prev{background:var(--oi-warn-bg);color:#7a4b00}
#${PANEL_ID} .oi-chip.busy{background:var(--ub-on-soft);color:#0b7ea6}
#${PANEL_ID} .oi-skel{position:relative;display:inline-block;height:14px;border-radius:4px;background:#e9edf1;overflow:hidden;vertical-align:middle}
#${PANEL_ID} .oi-skel::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.7),transparent);animation:oiShimmer 1.2s ease-in-out infinite}
#${PANEL_ID} .oi-skel.w1{width:88px}#${PANEL_ID} .oi-skel.w2{width:100%;height:28px;border-radius:6px}
#${PANEL_ID} .oi-chk{width:16px;height:16px;margin:0;accent-color:var(--ub-on);cursor:pointer}
#${PANEL_ID} .oi-res{margin-top:16px}
#${PANEL_ID} .oi-res h3{font-size:13px;margin:0 0 4px;display:flex;align-items:center;gap:10px}
#${PANEL_ID} .oi-res h3 .oi-muted{font-weight:500}
@media (prefers-reduced-motion: reduce){#${PANEL_ID} .oi-spin,#${PANEL_ID} .oi-skel::after,#${PANEL_ID} .oi-prog .bar.indet>i{animation:none}}
#ub-oi-veil{position:fixed;inset:0;z-index:2147483646;background:rgba(15,20,25,.45)}
`;
  function ensureStyle() { if (!document.getElementById(STYLE_ID)) { const s = document.createElement('style'); s.id = STYLE_ID; s.textContent = CSS; document.head.appendChild(s); } }
  //  아이콘은 인라인 SVG 심볼(이모지 금지 — 확장 디자인 지침). id 는 페이지와 안 겹치게 접두.
  const ICON_DEFS = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>'
    + '<symbol id="ub-oi-i-spin" viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9"/></symbol>'
    + '<symbol id="ub-oi-i-check" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></symbol>'
    + '<symbol id="ub-oi-i-warn" viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></symbol>'
    + '<symbol id="ub-oi-i-x" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></symbol>'
    + '<symbol id="ub-oi-i-file" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></symbol>'
    + '<symbol id="ub-oi-i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></symbol>'
    + '</defs></svg>';
  const ico = (n, cls) => '<svg class="oi-ico' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#ub-oi-i-' + n + '"/></svg>';
  const chip = (cls, text, icon) => '<span class="oi-chip ' + cls + '">' + (icon ? ico(icon, icon === 'spin' ? 'oi-spin' : '') : '') + esc(text) + '</span>';
  const fmtAt = (at) => esc(String(at || '').slice(0, 16).replace('T', ' '));

  //  코드표 밖 판매처: 이 세션에서만 접미·마켓을 정한다(스펙 §2.3, Terra 4R P2). 표에는 저장하지 않는다.
  const MARKET_OPTS = [['2', 'SSG'], ['3', 'CJ몰'], ['4', 'H몰'], ['5', '스마트스토어'], ['6', '카페24'], ['7', 'GS샵'], ['8', '쿠팡'], ['9', '위메프'], ['10', '롯데ON'], ['11', '카카오'], ['12', '11번가'], ['13', 'G마켓'], ['14', '옥션'], ['15', '더리본샵'], ['16', 'AK몰'], ['17', '지그재그'], ['18', '아몬즈'], ['19', '지인소개'], ['20', '퀸잇'], ['21', '에이블리'], ['22', '오늘룩']];
  function marketPick(o, oi) {
    const dis = S.running ? ' disabled' : '';
    return '<div class="oi-mkt"><span class="oi-issue">' + ico('warn') + '판매처 미등록(' + esc(o.seller) + ')</span> <span class="oi-muted">접미</span> <input class="oi-in sm" data-f="mkt-suffix" data-o="' + oi + '" placeholder="예: 십" maxlength="4" style="width:64px"' + dis + '> <span class="oi-muted">마켓</span> <select class="oi-in" style="width:auto" data-f="mkt-job" data-o="' + oi + '"' + dis + '><option value="">— 선택 —</option>'
      + MARKET_OPTS.map(([v, t]) => '<option value="' + v + '">' + esc(t) + '</option>').join('') + '</select> <button class="oi-btn sm" data-act="mkt-apply" data-o="' + oi + '"' + dis + '>적용</button></div>';
  }
  //  고객 처리 칩. 조회 전(enrich 중)은 스켈레톤 — 조회 대상이 아니면(마켓 없음·휴대폰 불량) 안내만.
  function custChip(o) {
    if (!o.customer) return (S.phase === 'enriching' && o.market && o.phone.ok) ? '<span class="oi-skel w1"></span>' : '<span class="oi-muted">조회 전</span>';
    const m = o.customer.mode;
    if (m === 'reuse') return chip('reuse', '재사용 #' + o.customer.seq);
    const ref = (o.market && C.oiClientJob(o) !== String(o.market.clientJob)) ? ' · 마켓 지인소개(정산 차 60%↑)' : '';
    if (m === 'new') return chip('new', '신규 등록' + ref);
    if (m === 'new_nophone') return chip('nophone', '신규 등록 · 휴대폰 비움(다른 고객이 사용 중)' + ref);
    return chip('fail', '조회 실패', 'warn');
  }
  function lineRow(o, oi, l, li) {
    const dis = S.running ? ' disabled' : '';   // 실행 중엔 줄 컨트롤 전부 잠금(Fable F2)
    const e = l.mapping ? l.mapping.entry : null;
    const pending = !e && l.suggest == null && S.phase === 'enriching';   // 추천 조회 전 → 스켈레톤
    const prod = e
      ? '<div class="oi-mapped"><span class="nm">' + esc(e.name) + '</span><span class="cd">' + esc(e.code) + '</span><button class="oi-btn sm icon quiet" aria-label="매핑 지우기" data-act="unmap" data-o="' + oi + '" data-l="' + li + '" title="매핑 지우기"' + dis + '>' + ico('x') + '</button></div>'
        + '<input class="oi-in oi-sub-in" data-f="suffix" data-o="' + oi + '" data-l="' + li + '" placeholder="비고 접미 (매핑표에 저장, 예: /블루칼세도니)" value="' + esc(e.remarkSuffix || '') + '"' + dis + '>'
      : pending ? '<span class="oi-skel w2"></span>'
      : '<div class="oi-prod"><select class="oi-in" data-f="pick" data-o="' + oi + '" data-l="' + li + '"' + dis + '><option value="">— 유비샵 상품 선택' + (l.suggestQuery ? ' (검색어: ' + esc(l.suggestQuery) + ')' : '') + ' —</option>'
        + (l.suggest || []).map((s) => '<option value="' + esc(s.seq + '|' + s.code + '|' + s.name) + '">' + esc(s.name) + ' · ' + esc(s.code) + '</option>').join('')
        + '</select><input class="oi-in q" placeholder="직접 검색(공백 없이)" data-f="q" data-o="' + oi + '" data-l="' + li + '" value="' + esc(l.q || '') + '"' + dis + '><button class="oi-btn sm icon" aria-label="검색" title="검색" data-act="search" data-o="' + oi + '" data-l="' + li + '"' + dis + '>' + ico('search') + '</button></div>';
    const inp = (f, v, cls) => '<input class="oi-in ' + (cls || 'sm') + '" data-f="' + f + '" data-o="' + oi + '" data-l="' + li + '" value="' + esc(v == null ? '' : v) + '"' + dis + '>';
    const issues = l.issues.length ? '<div class="oi-issue">' + ico('warn') + l.issues.map(esc).join(' · ') + '</div>' : '';
    const note = (!e && l.searchNote) ? '<div class="oi-note">' + esc(l.searchNote) + '</div>' : '';
    const cur = S.phase === 'running' && S.progress.key === o.key && !o.result;
    return '<tr class="oi-l' + (l.issues.length ? ' oi-warn' : '') + (cur ? ' oi-cur' : '') + '"><td></td><td colspan="2"><div class="oi-name">' + esc(l.productName) + '</div><div class="oi-opt">' + esc(l.optionText || '(옵션 없음)') + '</div>' + issues + '</td>'
      + '<td>' + prod + note + '</td><td>' + inp('k', l.spec.k) + '</td><td>' + inp('color', l.spec.color) + '</td><td>' + inp('itemSize', l.spec.itemSize) + '</td>'
      + '<td>' + inp('qty', l.spec.qty, 'sm num') + '</td><td>' + inp('price', Number.isInteger(l.spec.price) ? C.oiComma(l.spec.price) : l.spec.price, 'sm num') + '</td><td>' + inp('remark', l.spec.remark, '') + '</td></tr>';
  }
  function resultChip(r) {
    if (!r) return '';
    const juns = [...new Set((r.junNums || []).map((j) => j.junNum).filter(Boolean))];
    if (r.status === 'done') return chip('done', '완료' + (juns.length ? ' · 관리번호 ' + juns.join(',') : ''), 'check');
    return chip(r.status === 'skipped' ? 'skipped' : 'fatal', (r.status === 'skipped' ? '건너뜀' : r.status === 'blocked' ? '중단(앞 주문장 fatal)' : '중단') + (r.reason ? ' · ' + r.reason : ''), 'warn');
  }
  //  중복/이전 등록 칩(스펙 §5b): 완전 중복은 빨강, 주문번호만 같은 것은 주황 안내.
  function prevChip(o) {
    const d = o.dup; if (!d || !d.entry) return '';
    const e = d.entry;
    const when = fmtAt(e.at) + (e.junNums && e.junNums.length ? ' · 관리번호 ' + esc([...new Set(e.junNums)].join(',')) : '');
    if (e.unverified) return chip('dup', '이전 시도 미확인 ' + when + (e.reason ? ' · ' + e.reason : '') + ' — 주문전표에서 확인', 'warn');
    if (d.kind === 'same') return chip('dup', '이미 등록 ' + when + ' · 상품 동일', 'warn');
    if (d.kind === 'legacy') return chip('dup', '이미 등록 ' + when + ' (상품 대조 불가)', 'warn');
    return chip('prev', '이전에 넣음 ' + when + ' · 상품은 다름');
  }
  function orderRow(o, oi) {
    const cur = S.phase === 'running' && S.progress.key === o.key && !o.result;
    //  이번 실행의 결과가 있으면 그 칩만 — 방금 등록한 주문장이 장부에 오르며 '이미 등록' 으로도 보이는 중복 표시를 막는다.
    const chips = (o.market ? custChip(o) : marketPick(o, oi)) + ' ' + (o.result ? resultChip(o.result) : '') + (o.ledgered ? '' : ' ' + prevChip(o)) + (cur ? ' ' + chip('busy', '등록 중 · ' + (S.progress.label || ''), 'spin') : '');
    return '<tr class="oi-o' + (o.ready ? '' : ' bad') + (o.dup && o.dup.dup ? ' dup' : '') + (o.result ? (o.result.status === 'done' ? ' res-done' : ' res-bad') : '') + '"><td><input type="checkbox" class="oi-chk" data-f="chk" data-o="' + oi + '"' + (o.checked ? ' checked' : '') + (o.ready && !S.running ? '' : ' disabled') + '></td>'
      + '<td><span class="oi-key"><span class="seller">' + esc(o.seller) + '</span>' + esc(o.orderNo) + '</span></td><td><span class="oi-cust">' + (o.clientName ? esc(o.clientName) : '<span class="oi-muted">(' + esc(o.seller) + ' 미등록)</span>') + '<br><span class="oi-muted">' + esc(o.phone.phone || o.phone.raw) + '</span></span></td>'
      + '<td colspan="7">' + chips + '</td></tr>' + o.lines.map((l, li) => lineRow(o, oi, l, li)).join('');
  }
  //  진행 스트립(스펙 §3). 세 단계에서만 그려지고, 실행 중엔 log 훅이 progPatch 로 문구만 갱신한다.
  function progStrip() {
    const pr = S.progress;
    const bar = (done, total) => '<span class="bar"><i style="width:' + (total ? Math.round(done / total * 100) : 0) + '%"></i></span><span class="cnt">' + done + '/' + total + '</span>';
    if (S.phase === 'reading') return '<div class="oi-prog" role="status" aria-live="polite">' + ico('spin', 'oi-spin') + '<span class="txt">xls 읽는 중…</span><span class="bar indet"><i></i></span></div>';
    if (S.phase === 'enriching') return '<div class="oi-prog" role="status" aria-live="polite">' + ico('spin', 'oi-spin') + '<span class="txt">유비샵 조회 중</span><span class="sub">— 상품 ' + pr.m[0] + '/' + pr.m[1] + ' · 고객 ' + pr.c[0] + '/' + pr.c[1] + ' · 추천 ' + pr.s[0] + '/' + pr.s[1] + '</span>' + bar(pr.done, pr.total) + '</div>';
    if (S.phase === 'running') return '<div class="oi-prog run" role="status" aria-live="polite">' + ico('spin', 'oi-spin') + '<span class="txt">등록 중 ' + Math.min(pr.done + 1, pr.total) + '/' + pr.total + '</span><span class="sub">— ' + esc(String(pr.key).replace('|', ' ')) + (pr.label ? ' · ' + esc(pr.label) : '') + '</span>' + bar(pr.done, pr.total) + '<span class="warn">이 창과 유비샵 주문 화면을 조작하지 마세요</span></div>';
    return '';
  }
  //  스트립 텍스트만 갱신(표 재렌더 없음 — 입력 중 값 소실·깜빡임 방지).
  function progPatch() {
    const p = document.getElementById(PANEL_ID); if (!p) return;
    const el = p.querySelector('.oi-prog'); if (!el) return;
    const tmp = document.createElement('div'); tmp.innerHTML = progStrip();
    if (tmp.firstChild) el.replaceWith(tmp.firstChild);
    const b = p.querySelector('.oi-chip.busy');   // 현재 주문장 행의 칩 문구도 따라간다(표 재렌더 없이 텍스트 노드만)
    if (b && b.lastChild && b.lastChild.nodeType === 3) b.lastChild.textContent = '등록 중 · ' + (S.progress.label || '');
  }
  //  사람이 패널 안 입력칸에 있으면 표를 다시 그리지 않는다(포커스·입력 보호). 스트립은 갱신.
  //  진행 중(조회) 갱신: 툴바(.oi-bar — 파일 input 포함)는 건드리지 않는다(Opus O1 P2 — 열려 있던 파일 선택창의 input 이 떨어져 나갔다).
  //  사람이 패널 안 입력칸에 있으면 표도 다시 그리지 않고 스트립만 갱신(포커스·입력 보호). 아니면 표만 다시 그린다.
  //  포커스가 표 영역(.oi-b) 안 어디든(입력칸·셀렉트·체크박스·버튼) 있으면 표를 다시 그리지 않는다 — mousedown~mouseup 사이에 표가 교체되면
  //  클릭이 사라지고 마켓 픽커 값이 지워진다(Opus O2 P2-B). 조회가 끝나는 전체 렌더는 종전대로 무조건 그린다(입력 중 값 1회 소실은 감수 — O2 P2-A 로 지연 렌더 철회).
  function renderSoft() {
    if (focusInTable()) { progPatch(); return; }
    renderBody(); progPatch();
  }
  function focusInTable() {
    const a = document.activeElement;
    const p = document.getElementById(PANEL_ID);
    const b = p && p.querySelector('.oi-b');
    return !!(b && a && b.contains(a));
  }
  function stepsHtml() {
    const hasFile = S.orders.length > 0, running = S.phase === 'running' || S.results.length > 0;
    const st = (n, label, state) => '<span class="oi-step' + (state ? ' ' + state : '') + '"><span class="n">' + (state === 'done' ? ico('check') : n) + '</span>' + label + '</span>';
    return '<div class="oi-steps">' + st(1, '파일', hasFile ? 'done' : 'on') + '<span class="sep">›</span>' + st(2, '검토', running ? 'done' : hasFile ? 'on' : '') + '<span class="sep">›</span>' + st(3, '등록', running ? 'on' : '') + '</div>';
  }
  function counts() {
    const nOrd = S.orders.length, nReady = S.orders.filter((o) => o.ready).length, nChk = S.orders.filter((o) => o.checked && o.ready).length;
    const nDup = S.orders.filter((o) => o.dup && o.dup.dup && !o.ledgered).length, nDupUnchecked = S.orders.filter((o) => o.dup && o.dup.dup && !o.ledgered && !o.checked).length;
    //  머리글 체크 상태는 '중복 아닌 실행 가능' 주문장만 센다 — 손으로 켠 중복이 섞이면 양방향으로 틀린다(Opus O2 Nit-C).
    const nAll = S.orders.filter((o) => o.ready && !(o.dup && o.dup.dup)).length, nChkAll = S.orders.filter((o) => o.checked && o.ready && !(o.dup && o.dup.dup)).length;
    const nLines = S.orders.reduce((n, o) => n + o.lines.length, 0);
    return { nOrd, nReady, nChk, nDup, nDupUnchecked, nAll, nChkAll, nLines };
  }
  function render() {
    const p = document.getElementById(PANEL_ID); if (!p) return;
    const { nOrd, nReady, nChk, nLines } = counts();
    const lock = S.running ? ' disabled' : '';
    p.querySelector('.oi-steps-slot').innerHTML = stepsHtml();
    p.querySelector('.oi-top').innerHTML =
      '<div class="oi-bar"><label class="oi-btn">' + ico('file') + 'xls 선택<input type="file" id="ub-oi-file" accept=".xls,.xlsx" hidden' + lock + '></label>'
      + (nOrd ? '<span class="oi-file">' + esc(S.fileName) + '</span><span class="oi-count">주문장 <b>' + nOrd + '</b> <i>·</i> 줄 <b>' + nLines + '</b> <i>·</i> 실행 가능 <b>' + nReady + '</b> <i>·</i> 체크 <b>' + nChk + '</b></span>' : '<span class="oi-muted">이지어드민 확장주문검색 xls(판매가 열 포함)를 선택하세요</span>')
      + '<span class="oi-spacer"></span>'
      + '<button class="oi-btn pri" data-act="run"' + (nChk && !S.running && !S.enriching && S.enabled ? '' : ' disabled') + (S.enabled ? '' : ' title="스위치가 꺼져 있습니다"') + '>' + (S.running ? '등록 중…' : '등록 시작') + '</button>'
      + '<button class="oi-btn quiet" data-act="export-map">매핑표 내보내기</button><label class="oi-btn quiet">매핑표 가져오기<input type="file" id="ub-oi-mapfile" accept=".json" hidden' + (S.running ? ' disabled' : '') + '></label>'
      + '<button class="oi-btn quiet" data-act="export-log">로그 JSON</button></div>'
      + progStrip();
    renderBody();
  }
  //  표·결과만 다시 그린다(툴바 제외). 배너 문구는 실제 체크 상태를 말한다(Opus O1 P2-5 — 체크된 채 남은 중복이 있으면 "풀어 두었다" 고 하지 않는다).
  function renderBody() {
    const p = document.getElementById(PANEL_ID); if (!p) return;
    const { nOrd, nDup, nDupUnchecked, nAll, nChkAll } = counts();
    const done = S.results.filter((r) => r.status === 'done').length, skipped = S.results.filter((r) => r.status !== 'done').length;
    const banner = !nDup ? '' : (nDupUnchecked === nDup
      ? '이미 등록된 것과 같은 주문장 ' + nDup + '개는 체크를 풀어 두었습니다 — 다시 넣으려면 직접 체크하세요.'
      : '이미 등록된 것과 같은 주문장 ' + nDup + '개 중 ' + (nDup - nDupUnchecked) + '개가 체크돼 있습니다 — 그대로 등록하면 중복 주문장이 됩니다.');
    p.querySelector('.oi-b').innerHTML =
      (banner ? '<div class="oi-banner">' + ico('warn') + banner + '</div>' : '')
      + (nOrd ? '<table class="oi-t"><colgroup><col class="c-chk"><col><col><col class="c-prod"><col class="c-k"><col class="c-color"><col class="c-size"><col class="c-qty"><col class="c-price"><col class="c-remark"></colgroup>'
        + '<thead><tr><th><input type="checkbox" class="oi-chk" data-f="chkall" title="실행 가능한 주문장 전체 체크/해제(중복 제외)"' + (nAll && nChkAll === nAll ? ' checked' : '') + (nAll && !S.running ? '' : ' disabled') + '></th><th>판매처 · 주문번호</th><th>고객명 · 휴대폰</th><th>유비샵 상품</th><th>품위</th><th>색상</th><th>사이즈</th><th class="num">수량</th><th class="num">판매가</th><th>비고</th></tr></thead><tbody>'
        + S.orders.map(orderRow).join('') + '</tbody></table>' : (S.phase === 'reading' ? '' : '<div class="oi-empty">파일을 선택하면 주문장 검토 표가 여기에 뜹니다.</div>'))
      + (S.results.length ? '<div class="oi-res"><h3>결과 <span class="oi-muted">— 완료 ' + done + ' · 건너뜀/중단 ' + skipped + '</span></h3><table class="oi-t" style="margin-top:6px"><thead><tr><th>주문장</th><th>상태</th><th>사유</th><th>고객</th><th>관리번호</th><th class="num">되돌림</th></tr></thead><tbody>'
        + S.results.map((r) => '<tr><td>' + esc(r.key) + '</td><td>' + resultChip(Object.assign({}, r, { reason: '' })) + '</td><td>' + esc(r.reason || '') + '</td><td>' + esc(r.client ? r.client.name + ' #' + r.client.seq + ' (' + r.client.mode + ')' : '') + '</td><td>' + esc([...new Set((r.junNums || []).map((j) => j.junNum))].join(', ')) + '</td><td class="num">' + esc(r.rolledBack || 0) + '</td></tr>').join('')
        + '</tbody></table></div>' : '');
  }
  function openPanel() {
    ensureStyle();
    if (document.getElementById(PANEL_ID)) return;
    const veil = document.createElement('div'); veil.id = 'ub-oi-veil'; document.body.appendChild(veil);
    const p = document.createElement('div'); p.id = PANEL_ID;
    p.innerHTML = ICON_DEFS + '<div class="oi-h"><span class="oi-title">주문 가져오기</span><span class="oi-steps-slot"></span><button class="oi-x" data-act="close" title="닫기" aria-label="닫기">' + ico('x') + '</button></div><div class="oi-top"></div><div class="oi-b"></div>';
    document.body.appendChild(p);
    p.addEventListener('click', onClick);
    p.addEventListener('change', onChange);
    p.addEventListener('keydown', onKeydown);
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
    if ((S.running || S.starting) && act !== 'close' && act !== 'export-log' && act !== 'export-map') return;   // 실행 중(시작 대기 포함) 조작 차단(Fable F2·F3 Nit) — 다운로드·닫기만 허용
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
    else if (act === 'unmap') {
      const l = S.orders[+btn.dataset.o].lines[+btn.dataset.l];
      //  지우기 전에 부가정보를 줄에 보관 — 같은 상품을 다시 고르면 접미·색상 폴백이 살아난다(Terra 13R P2)
      const e = l.mapping && l.mapping.entry; if (e) l.priorMeta = { seq: String(e.seq), remarkSuffix: e.remarkSuffix || '', colorFallback: e.colorFallback || '' };
      l.keys.forEach((k) => { delete S.map[k]; }); l.suggest = null; await saveMap(); S.orders.forEach(refreshOrder); await enrich(); render();
    }
    else if (act === 'search') await searchLine(+btn.dataset.o, +btn.dataset.l, btn.parentElement.querySelector('input[data-f="q"]'));
  }
  //  직접 검색 — 버튼 클릭과 입력칸 Enter 가 같은 함수를 부른다. 친 검색어는 줄(l.q)에 남겨 재렌더에도 살아남게.
  //  (2026-09-16 사장님 제보: 검색칸 change 가 표 전체를 다시 그려 글자가 사라지고 클릭이 떨어져 나간 옛 버튼에 붙어 아무 반응이 없었다)
  async function searchLine(oi, li, inputEl) {
    const o = S.orders[oi]; const l = o && o.lines[li]; if (!l) return;
    const q = String(inputEl ? inputEl.value : (l.q || '')).trim();   // 입력칸이 있으면 그 값만 — 비웠으면 빈 것(이전 검색어 재사용 금지, Luna 1R)
    l.q = q;
    const gen = l.qGen = (l.qGen || 0) + 1;   // 줄 단위 세대 토큰 — 늦게 온 옛 응답이 새 검색을 덮지 않게(Luna 2R, 파일 선택의 fileGen 과 같은 이유)
    if (!q) { l.searchNote = ''; render(); return; }
    l.searchNote = '검색 중…'; render();
    try {
      const hits = await E.searchMaster(q.replace(/\s+/g, ''));
      if (gen !== l.qGen) return;
      l.suggest = hits.slice(0, 10); l.suggestQuery = q;
      l.searchNote = hits.length ? hits.length + '건 — 위 목록에서 선택' : '검색 결과 0건 (공백 없이·부분일치)';
    } catch (err) { if (gen !== l.qGen) return; l.searchNote = '검색 실패: ' + (err && err.message || err); }
    render();
  }
  function onKeydown(e) {
    const el = e.target;
    if (!el || el.dataset.f !== 'q' || e.key !== 'Enter') return;
    e.preventDefault();
    if (S.running || S.starting) return;
    searchLine(+el.dataset.o, +el.dataset.l, el);
  }
  async function onChange(e) {
    if (S.running || S.starting) return;   // 실행 중(시작 대기 포함) 조작 차단(Fable F2·F3 Nit)
    const el = e.target;
    if (el.id === 'ub-oi-file') { const f = el.files && el.files[0]; if (f) await loadFile(f); return; }
    if (el.id === 'ub-oi-mapfile') { const f = el.files && el.files[0]; if (f) await importMap(f); return; }
    const f = el.dataset.f; if (!f) return;
    if (f === 'chk') { const o = S.orders[+el.dataset.o]; o.checked = el.checked && o.ready; render(); return; }
    if (f === 'chkall') { S.orders.forEach((o) => { if (o.dup.dup) return; o.checked = el.checked && o.ready; }); render(); return; }   // 일괄 체크(사장님 요청 2026-09-15) — 문제 있는 주문장과 중복 주문장(§5b, 개별 체크로만)은 제외
    const o = S.orders[+el.dataset.o]; const l = o && o.lines[+el.dataset.l];
    if (f === 'q') { l.q = el.value; return; }   // 검색어는 줄에만 남기고 다시 그리지 않는다 — 그리면 글자가 사라진다
    if (f === 'mkt-suffix' || f === 'mkt-job') return;   // 미등록 판매처 접미·마켓 — [적용] 이 DOM 에서 읽는다. 재렌더하면 값이 사라져 적용이 절대 안 됐다(Opus O1 P2-3, 검색 버그와 같은 종류)
    if (f === 'pick') {
      if (!el.value) return;
      const [seq, code, name] = el.value.split('|');
      const entry = { seq, code, name };
      if (l.priorMeta && l.priorMeta.seq === String(seq)) { if (l.priorMeta.remarkSuffix) entry.remarkSuffix = l.priorMeta.remarkSuffix; if (l.priorMeta.colorFallback) entry.colorFallback = l.priorMeta.colorFallback; }
      S.map = C.oiLearn(S.map, l.keys, entry, new Date().toISOString());
      await saveMap();
      S.orders.forEach(refreshOrder);        // 같은 키의 다른 줄에도 즉시 전파
      await enrich(); render(); return;
    }
    if (f === 'k' || f === 'color') {
      l.spec[f] = el.value.trim() || null; l.spec.optOverride = true;     // 사람이 보정 → 원문 미해석 토큰은 차단 사유에서 제외(Terra 4R P2)
      //  옵션도 마스터 기본값도 없는 상품에 색상을 손으로 넣었으면 그 상품의 매핑에 colorFallback 으로 학습(Terra 13R P2) — 다음 파일부터 자동
      if (f === 'color' && l.spec.color && l.mapping && !l.parsed.color) {
        const seq = String(l.mapping.entry.seq); const fb = l.spec.color.toUpperCase();
        Object.keys(S.map).forEach((k) => { if (S.map[k] && String(S.map[k].seq) === seq) S.map[k] = Object.assign({}, S.map[k], { colorFallback: fb }); });
        await saveMap();
      }
    }
    else if (f === 'itemSize') { l.spec.itemSize = el.value.trim(); l.spec.optOverride = true; }
    else if (f === 'qty') l.spec.qty = C.oiMoney(el.value);
    else if (f === 'price') l.spec.price = l.gift ? C.oiMoney0(el.value) : C.oiMoney(el.value);   // 사은품은 0 허용
    else if (f === 'remark') { l.spec.remark = el.value; l.spec.remarkAuto = false; }
    else if (f === 'suffix') {                                 // 비고 접미 — 이 상품의 매핑 항목에 저장(스펙 §2.4, Terra 12R P2)
      if (!l.mapping) return;
      const suf = el.value.trim(); const seq = String(l.mapping.entry.seq);
      Object.keys(S.map).forEach((k) => { if (S.map[k] && String(S.map[k].seq) === seq) S.map[k] = Object.assign({}, S.map[k], { remarkSuffix: suf }); });
      await saveMap();
      S.orders.forEach((oo) => oo.lines.forEach((ll) => { if (ll.spec) ll.spec.remarkAuto = ll.spec.remarkAuto !== false; }));
      S.orders.forEach(refreshOrder); render(); return;
    }
    refreshOrder(o); render();
  }
  async function loadFile(file) {
    //  파일을 연달아 고르면 먼저 고른(큰) 파일의 파싱이 나중에 끝나 나중 파일의 표를 덮어쓴다(Terra 8R P1) — 세대 토큰으로 최신 선택만 반영.
    const gen = ++S.fileGen;
    try {
      S.fileName = file.name; S.results = []; S.orders = [];
      S.phase = 'reading'; render();
      const parsed = await readXls(file);
      if (gen !== S.fileGen) return;
      buildOrders(parsed);
      S.phase = 'idle'; render();
      await enrich();
      if (gen !== S.fileGen) return;
      render();
    } catch (err) { if (gen !== S.fileGen) return; S.phase = 'idle'; alert('파일을 읽지 못했습니다: ' + (err && err.message || err)); S.orders = []; render(); }
  }
  async function importMap(file) {
    try {
      const obj = JSON.parse(await file.text());
      if (!obj || typeof obj !== 'object') throw new Error('JSON 객체가 아닙니다');
      let n = 0, bad = 0;
      Object.keys(obj).forEach((k) => { if (C.oiValidMapEntry(obj[k])) { S.map[k] = obj[k]; n++; } else bad++; });   // seq·code 둘 다 없는 항목은 버린다(Terra 8R P2)
      await saveMap(); S.orders.forEach(refreshOrder); await enrich(); render();   // 새로 매핑된 줄의 품위·색상 옵션 검사가 검토 단계에서 빠지지 않게(Fable F5)
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
    if (ch[KEY_MAP]) { S.map = ch[KEY_MAP].newValue || {}; if (!S.running) { S.orders.forEach(refreshOrder); render(); } }   // 실행 중에도 표는 받아 둔다(실행 배치는 스냅샷이라 영향 없음) — Opus 5 P2
    if (ch[KEY_LEDGER]) { S.ledger = Object.assign({}, S.ledger, ch[KEY_LEDGER].newValue || {}); if (!S.running) { S.orders.forEach(refreshOrder); render(); } }
  });
  loadState();
})();
