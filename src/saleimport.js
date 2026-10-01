/* =============================================================================
 *  saleimport.js — GS샵 판매 처리 가져오기 UI·실행기 배선 (ISOLATED, saleItemWriteForm.do 전용).
 *  사이드바(skin.js) 의 [GS 판처 xlsx 불러오기] 버튼 → 패널: 파일 → 검토 표 → [판매 시작] → 진행/결과.
 *  로직은 saleimport-core.js(순수), 서버 호출은 saleimport-erp.js. 이 파일은 DOM·storage·배선만.
 *  구조는 orderimport.js 와 같다(실행 잠금·beforeunload·로그 JSON·xls 읽기).
 *  스펙: docs/superpowers/specs/2026-09-30-saleimport-design.md §1·§3.4·§6·§7
 * ========================================================================== */
(function () {
  'use strict';
  if (window.top !== window) return;
  if (!/\/sale\/item\/saleItemWriteForm\.do/.test(location.pathname)) return;
  const C = globalThis.ubSl, E = globalThis.ubSlErp;
  if (!C || !E) { console.warn('[UB][sl] core/erp 미로드 — manifest 순서 확인'); return; }

  const KEY_LEDGER = 'ubSlLedger', KEY_LKEY = 'ubSlLedgerKey', PANEL_ID = 'ub-sl-panel', VEIL_ID = 'ub-sl-veil', STYLE_ID = 'ub-sl-style';
  //  entries = 고객 단위. st: pending(조회 전) | ok(체크 가능) | sold(이미 판매됨) | block(차단)
  const S = { enabled: false, ledger: {}, entries: [], returns: [], error: '', running: false, starting: false, enriching: null,
    results: [], log: [], xlsReady: false, seq: 0, fileGen: 0, fileName: '', adapter: null, parsed: null, notice: '', ledgerFailed: false,
    phase: 'idle', progress: { done: 0, total: 0, key: '', label: '' } };

  /* ------------------------------------------------------------ storage */
  const sget = (q) => new Promise((res) => chrome.storage.local.get(q, res));
  const sset = (o) => new Promise((res) => chrome.storage.local.set(o, res));
  async function loadState() {
    const d = await sget({ ubSkin: false, ubSaleImport: true, [KEY_LEDGER]: {} });
    S.enabled = !!(d.ubSkin && d.ubSaleImport);
    S.ledger = d[KEY_LEDGER] || {};
  }
  //  장부는 저장 직전에 다시 읽어 병합한다 — 다른 탭이 그 사이 넣은 항목을 통째로 덮어쓰지 않게.
  async function saveLedger() {
    const d = await sget({ [KEY_LEDGER]: {} });
    S.ledger = Object.assign({}, d[KEY_LEDGER] || {}, S.ledger);
    await sset({ [KEY_LEDGER]: S.ledger });
  }

  /* ------------------------------------------------------------ xls (MAIN 주입 — orderimport 것을 그대로 재사용) */
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
    const id = 'sl' + (++S.seq) + '-' + Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener('message', on); reject(new Error('엑셀 읽기 응답 없음(20초)')); }, 20000);
      function on(e) {
        const d = e.data;
        if (!d || e.source !== window || d.source !== 'ub-oi-xls' || d.id !== id) return;
        clearTimeout(timer); window.removeEventListener('message', on);
        if (d.ok) resolve({ rows: d.rows }); else reject(new Error(d.error || '엑셀 읽기 실패'));
      }
      window.addEventListener('message', on);
      window.postMessage({ source: 'ub-oi', type: 'parse', id, buf }, '*');
    });
  }

  /* ------------------------------------------------------------ 모델 */
  const fmt = (n) => Number(n).toLocaleString('en-US');
  function newEntry(g) {
    const buyer = g.rows[0].buyer;
    //  §10.8 — source: 원장 | 이름 추정 | 파일 연락처. ledger: 원장에서 찾은 주문 Map(있으면 원장 줄 매칭). block: 처음부터 차단 사유. pickable: 직접 고르기 허용.
    const blocked = !!g.block;
    return { key: g.key, rows: g.rows, buyer, client: null, how: '', st: blocked ? 'block' : 'pending', reason: g.block || '', match: null, checked: false, cands: null, q: /^\*+$/.test(buyer) ? '' : buyer, note: '', qGen: 0, result: null,
      source: g.source || '', ledger: g.ledger || new Map(), retOrders: g.retOrders || new Set(), hard: blocked && !g.pickable };
  }
  function parseEntries(parsed) {
    const p = C.slParseFile(parsed.rows);
    if (!p.ok) throw new Error(p.error === '알 수 없는 파일 양식' ? '알 수 없는 파일 양식 — 지원: GS샵 · 카페24 이니시스(신용카드) · SSG · 스마트스토어 · 쿠팡 · 퀸잇 · 아몬즈 · 에이블리' : p.error);
    S.adapter = p.adapter;
    S.parsed = p.rows;
    S.returns = p.rows.filter((r) => r.isReturn);
  }
  //  idx = 원장 색인(없으면 null). 원장 연동 마켓은 원장 고객명으로, 아니면 기존 규칙으로 묶는다.
  function buildEntries(idx) {
    S.entries = (S.adapter.ledgerMarket ? C.slGroupLedger(S.parsed, S.adapter, idx, { lookupFailed: S.ledgerFailed }) : C.slGroupByClient(S.parsed, S.adapter)).map(newEntry);
  }
  //  §10.8 — 원장 조회는 파일당 한 번, 읽기 대기열 안에서(실행기 요청 사이에 끼지 않게). 열쇠는 이 함수 지역 변수로만 다룬다.
  //  결과는 { idx, failed, notice } 로만 돌려준다 — S 는 건드리지 않는다(늦게 끝난 이전 파일의 실패가 지금 파일에 번지지 않게, 반영은 loadFile 이 세대 확인 뒤에).
  async function fetchLedgerIndex() {
    const ad = S.adapter, byTime = ad.ledgerBy === 'time', parsed = S.parsed;
    //  §10.9 에이블리 — 파일에 원장 번호가 없다: 결제 시각(ms)으로 조회한다(반품 행도 — 같은 주문의 반품을 알아야 한다).
    const nos = byTime ? [...new Set(parsed.map((r) => r.paidAt))] : [...new Set(parsed.filter((r) => !r.isReturn && r.ledgerNo).map((r) => r.ledgerNo))];
    const d = await sget({ [KEY_LKEY]: '' });
    const key = String(d[KEY_LKEY] || '').trim();
    if (!key) return { idx: null, failed: false, notice: '아틀리에 조회 열쇠가 없어요 — 팝업에서 넣어 주세요' };
    if (!nos.length) return { idx: C.slLedgerIndex([], ad.ledgerMarket), failed: false, notice: '' };   // 번호가 없는 행도 코어가 차단한다
    S.phase = 'ledger'; render();
    try {
      const rows = await enqueue(() => byTime ? E.ledgerLookupByTime(ad.ledgerMarket, nos, key) : E.ledgerLookup(nos, key));
      if (rows == null) return { idx: null, failed: true, notice: '아틀리에 원장을 조회하지 못했어요 — 원장 연동 주문은 차단했습니다. 파일을 다시 올려 주세요' };
      const mine = rows.filter((x) => x && String(x.market == null ? '' : x.market).trim() === ad.ledgerMarket);
      return { idx: C.slLedgerIndex(rows, ad.ledgerMarket), failed: false, notice: '', parsed: byTime ? C.slApplyTimeLedger(parsed, mine) : null };
    } catch (err) { return { idx: null, failed: true, notice: '아틀리에 원장 조회 실패(' + (err && err.message || err) + ') — 원장 연동 주문은 차단했습니다. 파일을 다시 올려 주세요' }; }
  }
  //  장부 키 — GS 는 기존 장부(주문번호 그대로)와 이어지게 두고, 다른 마켓은 어댑터 id 를 붙여 서로 겹치지 않게 한다.
  const ledgerKey = (r) => (!S.adapter || S.adapter.id === 'gs') ? r.orderNo : S.adapter.id + '|' + r.orderNo;
  //  D8 — 고객 판매폼 form10 의 거래 전 미수(beforePrice). 읽지 못했거나 0 이 아니면 차단(fail-closed).
  function receivable(form) {
    const raw = form && form.form10 ? form.form10.beforePrice : null;
    const s = String(raw == null ? '' : raw).replace(/,/g, '').trim();
    if (!/^-?\d+$/.test(s)) return { ok: false, reason: '미수금 확인 불가(beforePrice ' + (raw == null ? '없음' : raw) + ')' };
    return Number(s) === 0 ? { ok: true } : { ok: false, reason: '기존 미수금 있음 (' + fmt(Number(s)) + '원)' };
  }
  function setBlock(e, reason) { e.st = 'block'; e.reason = reason; e.match = null; e.checked = false; }
  //  고객이 확정된 뒤: 미수 확인(GET) → 주문·판매내역(GET) → 줄 매칭. 쓰기 없음.
  const viaLedger = (e) => !!(e.ledger && e.ledger.size);
  async function matchEntry(e) {
    const cl = e.client;
    if (e.hard) { setBlock(e, e.reason); return; }
    const lm = !!S.adapter.ledgerMatch;   // 원장 줄 매칭은 쿠팡·퀸잇만 — 그 밖의 마켓은 원장을 고객명에만 쓴다(§10.8)
    if (lm && !viaLedger(e)) { setBlock(e, '원장 없이는 주문 줄을 찾을 수 없음 — 직접 처리'); return; }
    const form = await E.openClient(String(cl.seq), cl.name);
    if (String((form.values || {}).client) !== String(cl.seq)) { setBlock(e, '고객 지정 확인 실패'); return; }
    const rc = receivable(form);
    if (!rc.ok) { setBlock(e, rc.reason); return; }
    const tr = await E.trade(String(cl.seq), cl.name);
    const mode = C.slMatchModeFor(S.adapter, viaLedger(e));
    const m = mode === 'ledger' ? C.slMatchLedger(e.rows, e.ledger, tr.orders, tr.sales, { retOrders: e.retOrders, amountCheck: S.adapter.ledgerAmountCheck }) : C.slMatchClient(e.rows, tr.orders, tr.sales, mode);
    e.match = m; e.st = m.status; e.reason = m.reason;
    e.checked = m.status === 'ok';
    applyOverlaps();
  }
  //  §10.4 — 다른 묶음이 같은 주문 줄(바코드)을 잡았으면 양쪽 모두 차단한다.
  function applyOverlaps() {
    C.slOverlaps(S.entries).forEach((k) => { const x = S.entries.find((y) => y.key === k); if (x) setBlock(x, '다른 묶음과 같은 주문 줄을 잡음 — 직접 처리'); });
  }
  async function resolveEntry(e) {
    try {
      //  원장 고객명은 '수령자+뒤4/접미' 정확일치 규칙(§10.8) — 어댑터가 prefix4 여도 그 묶음은 exact.
      const ad = viaLedger(e) ? { clientRule: 'exact', suffix: S.adapter.suffix, ciSuffix: true } : S.adapter;
      const p4 = ad.clientRule === 'prefix4';
      const sr = await E.searchClient(p4 ? e.buyer : e.key);
      const dec = C.slAutoDecision({ hits: sr.rows, truncated: sr.truncated }, e, ad);
      if (dec.auto) {
        e.client = dec.auto; e.how = '자동'; await matchEntry(e);
        //  §10.3 — 이름+4자리 후보는 주문내역 정산이 일치할 때만 자동. 아니면 자동 확정을 취소하고 사장님이 고르게 한다.
        if (p4 && e.st !== 'ok') { const why = e.reason; e.client = null; e.how = ''; setBlock(e, '후보 "' + dec.auto.name + '" 의 주문내역이 이 결제와 맞지 않음(' + why + ') — 아래에서 직접 고르세요'); }
        return;
      }
      setBlock(e, dec.reason);
    } catch (err) { setBlock(e, '조회 실패: ' + (err && err.message || err)); }
  }
  //  읽기 요청(GET/검색)은 한 줄로 직렬화한다 — 실행기의 sKey GET→POST 사이에 끼면 안 되므로 run() 이 S.enriching 을 끝까지 기다린다.
  function enqueue(fn) {
    const prev = Promise.resolve(S.enriching).catch(() => {});
    const p = prev.then(() => ((S.running || S.starting) ? null : fn()));
    S.enriching = p;
    const clear = () => { if (S.enriching === p) S.enriching = null; };
    p.then(clear, clear);
    return p;
  }
  async function enrich() {
    if (S.running || S.starting) return;
    const gen = S.fileGen;
    const targets = S.entries.filter((e) => e.st === 'pending');
    S.progress = { done: 0, total: targets.length, key: '', label: '' };
    S.phase = 'enriching'; render();
    try {
      await enqueue(async () => {
        for (const e of targets) {
          if (S.running || S.starting || gen !== S.fileGen) return;
          await resolveEntry(e);
          S.progress.done++; renderSoft();
        }
      });
    } finally { if (S.phase === 'enriching') S.phase = 'idle'; render(); }
  }
  //  차단 행에서 사장님이 고객을 직접 검색·선택(이 세션에서만).
  async function searchCands(ei, inputEl) {
    const e = S.entries[ei]; if (!e) return;
    const q = String(inputEl ? inputEl.value : e.q).trim();
    e.q = q;
    const gen = e.qGen = e.qGen + 1;
    if (!q) { e.note = ''; render(); return; }
    e.note = '검색 중…'; render();
    try {
      await enqueue(async () => {
        const sr = await E.searchClient(q);
        const hits = sr.rows;
        if (gen !== e.qGen) return;
        e.cands = hits.slice(0, 50);
        e.note = hits.length ? (sr.truncated ? '100건 이상(일부만 표시) — 검색어를 좁히세요' : hits.length + '건 — 목록에서 선택') : '검색 결과 0건';
      });
    } catch (err) { if (gen === e.qGen) e.note = '검색 실패: ' + (err && err.message || err); }
    render();
  }
  async function pickClient(ei, val) {
    const e = S.entries[ei]; if (!e || !val) return;
    const [seq, name] = val.split('|');
    e.client = { seq: String(seq), name }; e.how = '선택'; e.st = 'pending'; e.reason = ''; e.match = null; e.checked = false;
    render();
    try { await enqueue(() => matchEntry(e)); } catch (err) { setBlock(e, '조회 실패: ' + (err && err.message || err)); }
    render();
  }
  //  일부 행만 이미 판매된 경우 — ok 인데 줄이 하나도 안 붙은 GS 행.
  const rowLines = (e, r) => (e.match && (e.st === 'ok' || e.st === 'done')) ? e.match.lines.filter((l) => l.orderNo === r.orderNo) : [];
  //  원장 매칭은 줄이 '주문' 단위라 같은 주문의 첫 파일 행에만 붙는다 — 나머지 행은 '이미 판매됨'이 아니라 '위 줄에 합산'.
  const rowMerged = (e, r) => viaLedger(e) && (e.st === 'ok' || e.st === 'done') && !rowLines(e, r).length && !!e.match && e.match.lines.some((l) => l.ledgerNo && l.ledgerNo === r.ledgerNo);
  const rowSold = (e, r) => e.st === 'sold' || (e.st === 'ok' && !rowLines(e, r).length && !rowMerged(e, r));
  const entryReady = (e) => e.st === 'ok' && !!e.match && !!e.client;

  /* ------------------------------------------------------------ 실행 */
  function logLine(key, step, info) {
    S.log.push({ t: new Date().toISOString(), key, step, info: (typeof info === 'string') ? info : JSON.parse(JSON.stringify(info || null)) });
    if (S.log.length > 5000) S.log.splice(0, S.log.length - 5000);
  }
  function stepLabel(step, info, prev) {
    const i = info || {};
    if (step === 'guard') return '점검';
    if (step === 'line') return '줄 등록 ' + (i.i + 1) + '/' + i.n;
    if (step === 'modify') return '실판매가 ' + (i.i + 1);
    if (step === 'cash') return '현금결제';
    if (step === 'jun') return '판매하기';
    if (step === 'rollback') return '되돌리는 중';
    if (step === 'fail' || step === 'fatal') return '중단 처리';
    return prev || '';
  }
  const toPlan = (e) => ({ key: e.key, client: { seq: e.client.seq, name: e.client.name }, lines: e.match.lines.map((l) => Object.assign({}, l)), cash: e.match.cash });
  function setVeil(on) {
    const v = document.getElementById(VEIL_ID); if (!v) return;
    v.classList.toggle('run', on); v.textContent = on ? '실행 중 — 유비샵 판매 화면을 조작하지 마세요' : '';
  }
  async function run() {
    //  첫 await 전에 선점한다 — 빠른 두 번 클릭이 이중 실행되던 경합(orderimport 4R P1).
    if (S.running || S.starting) return;
    S.starting = true;
    let plans = [];
    try {
      await loadState();                                     // 패널을 연 뒤 팝업에서 스위치를 껐을 수 있다 — 실행 직전에 다시 읽는다
      if (!S.enabled) { alert('[유비샵 스킨모드]·[판매 처리 가져오기] 스위치가 꺼져 있어 실행하지 않습니다.'); render(); return; }
      applyOverlaps();
      const targets = S.entries.filter((e) => e.checked && entryReady(e));
      if (!targets.length) { alert('실행할 고객이 없습니다(차단·이미 판매된 고객은 체크되지 않습니다).'); return; }
      const cash = targets.reduce((s, e) => s + e.match.cash, 0);
      const nLines = targets.reduce((n, e) => n + e.match.lines.length, 0);
      const nPrev = targets.filter((e) => e.rows.some((r) => S.ledger[ledgerKey(r)])).length;
      if (!confirm(targets.length + '명(' + nLines + '줄)을 판매 처리합니다.\n현금 합계 ' + fmt(cash) + '원 (고객별 현금 = 실판매가 합계, 미수금 0)'
        + (nPrev ? '\n※ 이전에 처리한 적 있는 주문번호가 든 고객 ' + nPrev + '명이 포함돼 있습니다.' : '')
        + '\n실행 중에는 유비샵 판매 화면을 조작하지 마세요. 진행할까요?')) return;
      plans = targets.map(toPlan);                           // confirm 한 집합을 그대로 실행한다
      while (S.enriching) { try { await S.enriching; } catch (_) {} }   // 진행 중인 조회가 실행기의 요청 사이에 끼지 않게 끝까지 기다린다
      applyOverlaps();                                       // 기다리는 동안 끝난 조회가 새 겹침을 만들었을 수 있다
      if (!targets.every(entryReady)) { alert('그동안 조회 결과가 바뀌어 실행을 취소했습니다. 목록을 다시 확인하세요.'); return; }
      S.running = true;
    } finally { S.starting = false; if (!S.running) render(); }
    if (!S.running) return;
    await runPlans(plans);
  }
  async function runPlans(plans) {
    S.results = [];
    window.addEventListener('beforeunload', onUnload);
    S.phase = 'running'; S.progress = { done: 0, total: plans.length, key: plans[0].key, label: '시작' };
    setVeil(true); render();
    try {
      const results = await C.slRunAll(plans, E, {
        log: (key, step, info) => {
          logLine(key, step, info);
          S.progress.key = key; S.progress.done = Math.max(0, plans.findIndex((p) => p.key === key));
          S.progress.label = stepLabel(step, info, S.progress.label); progPatch();
        }
      });
      S.results = results;
      const at = new Date().toISOString();
      C.slApplyResults(S.entries, results);                  // done → st='done'(다시 체크·실행 불가), fatal 도 다시 체크되지 않게
      results.forEach((r) => {
        const e = S.entries.find((x) => x.key === r.key); if (!e) return;
        if (r.status === 'done') {
          const gifts = e.match.lines.filter((l) => l.gift).map((l) => l.barcode);
          e.rows.forEach((row, i) => {
            const bcs = e.match.lines.filter((l) => l.orderNo === row.orderNo || (l.ledgerNo && l.ledgerNo === row.ledgerNo)).map((l) => l.barcode);
            if (bcs.length) S.ledger[ledgerKey(row)] = { at, tradeJun: r.tradeJun, barcodes: i === 0 ? bcs.concat(gifts) : bcs };
          });
        }
      });
      await saveLedger();
    } catch (err) { logLine('-', 'run_exception', String(err && err.message || err)); alert('실행 중 오류: ' + (err && err.message || err)); }
    S.running = false; S.phase = 'idle';
    window.removeEventListener('beforeunload', onUnload);
    setVeil(false);
    render();
  }
  function onUnload(e) { e.preventDefault(); e.returnValue = ''; }

  /* ------------------------------------------------------------ UI */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const CSS = `
#${PANEL_ID}{--ub-bg:#ffffff;--ub-bg2:#f7f9fc;--ub-fg:#1b1b1b;--ub-sub:#6b7280;--ub-line:#e5e7eb;--ub-soft:#f9fafb;--ub-on:#35C5F0;--ub-on-hover:#2bb5e0;--ub-on-soft:#e0f4fc;--sl-ok:#12995a;--sl-warn:#c77a12;--sl-err:#e0483f;--sl-warn-bg:#fff7e6;--sl-err-bg:#fdecec;--sl-ok-bg:#e7f6ee;
  position:fixed;inset:24px;z-index:2147483647;display:flex;flex-direction:column;overflow:hidden;background:var(--ub-bg);color:var(--ub-fg);border:1px solid var(--ub-line);border-radius:12px;box-shadow:0 8px 24px rgba(15,20,25,.12),0 24px 64px rgba(15,20,25,.18);font:13px/1.45 'Pretendard','Malgun Gothic',sans-serif;-webkit-font-smoothing:antialiased}
#${PANEL_ID} *{box-sizing:border-box}
#${PANEL_ID} input,#${PANEL_ID} select,#${PANEL_ID} button,#${PANEL_ID} label{font:inherit;color:inherit}
/* 유비샵 pamas_main.css 의 body,td{font-family:"돋움";font-size:12px} 가 표의 모든 td 를 직접 때려(상속보다 우선) 셀 안 글자·칩·입력칸이 전부 돋움이 됐다(2026-09-16 실측). td/th 는 패널 글꼴을 다시 물려받는다. */
#${PANEL_ID} td,#${PANEL_ID} th{font:inherit}
#${PANEL_ID} svg.sl-ico{width:16px;height:16px;flex:none;stroke:currentColor;fill:none;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
#${PANEL_ID} .sl-h{display:flex;align-items:center;gap:16px;padding:12px 16px;background:var(--ub-bg2);border-bottom:1px solid var(--ub-line)}
#${PANEL_ID} .sl-title{font-size:15px;font-weight:700;letter-spacing:-.01em}
#${PANEL_ID} .sl-steps{display:flex;align-items:center;gap:8px;color:var(--ub-sub);font-size:12px}
#${PANEL_ID} .sl-step{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid transparent}
#${PANEL_ID} .sl-step .n{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:var(--ub-line);color:var(--ub-fg);font-size:11px;font-weight:700}
#${PANEL_ID} .sl-step.on{color:var(--ub-fg);font-weight:600;background:var(--ub-on-soft);border-color:#b9e6f5}
#${PANEL_ID} .sl-step.on .n{background:var(--ub-on);color:#fff}
#${PANEL_ID} .sl-step.done .n{background:var(--sl-ok);color:#fff}
#${PANEL_ID} .sl-step.done .n svg{width:11px;height:11px;stroke-width:2.5}
#${PANEL_ID} .sl-steps .sep{color:#c5cbd3}
#${PANEL_ID} .sl-x{margin-left:auto;width:32px;height:32px;border:0;background:none;border-radius:8px;color:var(--ub-sub);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
#${PANEL_ID} .sl-x:hover{background:var(--ub-line);color:var(--ub-fg)}
#${PANEL_ID} .sl-bar{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--ub-line);background:var(--ub-bg);flex-wrap:wrap}
#${PANEL_ID} .sl-count{display:inline-flex;gap:6px;align-items:center;margin-left:4px;color:var(--ub-sub)}
#${PANEL_ID} .sl-count b{color:var(--ub-fg);font-weight:600;font-variant-numeric:tabular-nums}
#${PANEL_ID} .sl-count i{font-style:normal;color:#c5cbd3}
#${PANEL_ID} .sl-spacer{margin-left:auto}
#${PANEL_ID} .sl-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:1px solid var(--ub-line);background:var(--ub-bg);border-radius:8px;font-size:12px;font-weight:600;color:var(--ub-fg);cursor:pointer;white-space:nowrap;transition:background-color .12s ease,border-color .12s ease,color .12s ease,transform .08s ease;user-select:none}
#${PANEL_ID} .sl-btn:hover{border-color:var(--ub-on);color:var(--ub-on);background:var(--ub-on-soft)}
#${PANEL_ID} .sl-btn:active{transform:translateY(1px)}
#${PANEL_ID} .sl-btn.pri{background:var(--ub-on);border-color:var(--ub-on);color:#fff;font-weight:700;padding:0 16px}
#${PANEL_ID} .sl-btn.pri:hover{background:var(--ub-on-hover);border-color:var(--ub-on-hover);color:#fff}
#${PANEL_ID} .sl-btn.quiet{border-color:transparent;color:var(--ub-sub);font-weight:500}
#${PANEL_ID} .sl-btn.quiet:hover{color:var(--ub-on);background:var(--ub-on-soft);border-color:transparent}
#${PANEL_ID} .sl-btn.sm{height:28px;padding:0 10px}
#${PANEL_ID} .sl-btn.icon{width:28px;padding:0}
#${PANEL_ID} .sl-btn:disabled{opacity:.45;cursor:default;transform:none}
#${PANEL_ID} .sl-btn:disabled:hover{border-color:var(--ub-line);color:var(--ub-fg);background:var(--ub-bg)}
#${PANEL_ID} .sl-btn.pri:disabled:hover{background:var(--ub-on);border-color:var(--ub-on);color:#fff}
#${PANEL_ID} :focus-visible{outline:2px solid var(--ub-on);outline-offset:2px}
#${PANEL_ID} .sl-prog{display:flex;align-items:center;gap:12px;padding:10px 16px;background:var(--ub-on-soft);border-bottom:1px solid #b9e6f5;color:var(--ub-fg)}
#${PANEL_ID} .sl-prog.run{background:var(--sl-warn-bg);border-bottom-color:#f0c36d}
#${PANEL_ID} .sl-prog .sl-spin{color:var(--ub-on)}
#${PANEL_ID} .sl-prog.run .sl-spin{color:var(--sl-warn)}
#${PANEL_ID} .sl-prog .txt{font-weight:600}
#${PANEL_ID} .sl-prog .sub{color:var(--ub-sub);font-weight:500}
#${PANEL_ID} .sl-prog .warn{color:#7a4b00;font-weight:700;margin-left:4px}
#${PANEL_ID} .sl-prog .bar{position:relative;flex:1;max-width:320px;height:6px;border-radius:999px;background:rgba(15,20,25,.08);overflow:hidden}
#${PANEL_ID} .sl-prog .bar>i{position:absolute;inset:0 auto 0 0;width:0;background:var(--ub-on);border-radius:999px;transition:width .25s ease}
#${PANEL_ID} .sl-prog.run .bar>i{background:var(--sl-warn)}
#${PANEL_ID} .sl-prog .bar.indet>i{width:35%;animation:slIndet 1.1s ease-in-out infinite}
#${PANEL_ID} .sl-prog .cnt{font-variant-numeric:tabular-nums;color:var(--ub-sub);min-width:48px;text-align:right}
@keyframes slSpin{to{transform:rotate(360deg)}}
@keyframes slIndet{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
#${PANEL_ID} .sl-spin{animation:slSpin .9s linear infinite}
#${PANEL_ID} .sl-b{flex:1;overflow:auto;padding:0 16px 16px}
#${PANEL_ID} .sl-empty{padding:48px 16px;text-align:center;color:var(--ub-sub)}
#${PANEL_ID} .sl-banner{display:flex;align-items:center;gap:8px;margin-top:12px;padding:8px 12px;border-radius:8px;background:var(--sl-err-bg);color:#9f1d17;font-weight:600}
#${PANEL_ID} .sl-banner.warn{background:var(--sl-warn-bg);color:#7a4b00}
#${PANEL_ID} table.sl-t{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px;margin-top:12px}
#${PANEL_ID} table.sl-t th{position:sticky;top:0;z-index:1;background:var(--ub-bg2);color:var(--ub-sub);font-weight:600;font-size:12px;text-align:left;padding:8px 8px;border-bottom:1px solid var(--ub-line);white-space:nowrap}
#${PANEL_ID} table.sl-t td{padding:8px 8px;border-bottom:1px solid var(--ub-line);vertical-align:top}
#${PANEL_ID} table.sl-t th.num,#${PANEL_ID} table.sl-t td.num{text-align:right;font-variant-numeric:tabular-nums}
#${PANEL_ID} tr.sl-o td{background:var(--ub-bg2);padding-top:10px;padding-bottom:10px}
#${PANEL_ID} tr.sl-o td:first-child{box-shadow:inset 3px 0 0 var(--ub-on)}
#${PANEL_ID} tr.sl-o.warn td:first-child{box-shadow:inset 3px 0 0 #f0c36d}
#${PANEL_ID} tr.sl-o.bad td:first-child{box-shadow:inset 3px 0 0 var(--sl-err)}
#${PANEL_ID} tr.sl-o.dup td:first-child{box-shadow:inset 3px 0 0 var(--sl-err)}
#${PANEL_ID} tr.sl-o.res-done td:first-child{box-shadow:inset 3px 0 0 var(--sl-ok)}
#${PANEL_ID} tr.sl-o.res-bad td:first-child{box-shadow:inset 3px 0 0 var(--sl-err)}
#${PANEL_ID} .sl-muted{color:var(--ub-sub)}
#${PANEL_ID} .sl-in{width:100%;height:28px;padding:0 8px;border:1px solid var(--ub-line);border-radius:6px;background:var(--ub-bg);color:var(--ub-fg);font-size:12.5px;transition:border-color .12s ease,box-shadow .12s ease}
#${PANEL_ID} .sl-in::placeholder{color:#9aa3ad}
#${PANEL_ID} .sl-in:focus{outline:none;border-color:var(--ub-on);box-shadow:0 0 0 3px rgba(53,197,240,.18)}
#${PANEL_ID} .sl-in.num{text-align:right;font-variant-numeric:tabular-nums}
#${PANEL_ID} .sl-in.sm{width:100%}
#${PANEL_ID} .sl-in:disabled{background:var(--ub-soft);color:var(--ub-sub)}
#${PANEL_ID} select.sl-in{padding-right:24px;appearance:none;background:var(--ub-bg) url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>") no-repeat right 8px center}
#${PANEL_ID} .sl-chip{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;font-size:11.5px;font-weight:600;line-height:1;white-space:nowrap;vertical-align:middle}
#${PANEL_ID} .sl-chip svg.sl-ico{width:12px;height:12px}
#${PANEL_ID} .sl-chip.reuse{background:var(--ub-on-soft);color:#0b7ea6}
#${PANEL_ID} .sl-chip.fail,#${PANEL_ID} .sl-chip.fatal,#${PANEL_ID} .sl-chip.blocked,#${PANEL_ID} .sl-chip.dup{background:var(--sl-err-bg);color:#9f1d17}
#${PANEL_ID} .sl-chip.done{background:var(--sl-ok-bg);color:#0b6b3f}
#${PANEL_ID} .sl-chip.skipped,#${PANEL_ID} .sl-chip.prev{background:var(--sl-warn-bg);color:#7a4b00}
#${PANEL_ID} .sl-chip.busy{background:var(--ub-on-soft);color:#0b7ea6}
#${PANEL_ID} .sl-chk{width:16px;height:16px;margin:0;accent-color:var(--ub-on);cursor:pointer}
#ub-sl-veil{position:fixed;inset:0;z-index:2147483646;background:rgba(15,20,25,.45)}
#${PANEL_ID} .sl-issue{display:inline-flex;align-items:center;gap:4px;color:var(--sl-err);font-weight:600;font-size:12px;margin-top:4px}
#${PANEL_ID} .sl-issue svg.sl-ico{width:13px;height:13px}
#${PANEL_ID} .sl-chip.gray{background:var(--ub-line);color:#4b5563}
#${PANEL_ID} .sl-cust{font-weight:700}
#${PANEL_ID} .sl-cust .sl-muted{font-weight:400;font-variant-numeric:tabular-nums}
#${PANEL_ID} tr.sl-o.sold td:first-child{box-shadow:inset 3px 0 0 #c5cbd3}
#${PANEL_ID} tr.sl-l.sold td{color:var(--ub-sub)}
#${PANEL_ID} tr.sl-l td:first-child{box-shadow:inset 3px 0 0 transparent}
#${PANEL_ID} .sl-uv{display:grid;gap:3px}
#${PANEL_ID} .sl-uv .bc{font-variant-numeric:tabular-nums;font-weight:600;margin-right:6px}
#${PANEL_ID} .sl-uv .amt{float:right;margin-left:12px;font-variant-numeric:tabular-nums;color:var(--ub-sub)}
#${PANEL_ID} .sl-uv .gift{color:var(--ub-sub)}
#${PANEL_ID} .sl-opt{color:var(--ub-sub);font-size:12px;margin-top:1px}
#${PANEL_ID} .sl-find{display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap}
#${PANEL_ID} .sl-find .sl-in{width:150px}
#${PANEL_ID} .sl-find select.sl-in{width:280px}
#${PANEL_ID} .sl-sum{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;padding:8px 12px;border-radius:8px;background:var(--ub-bg2);border:1px solid var(--ub-line)}
#${PANEL_ID} .sl-sum b{font-variant-numeric:tabular-nums}
#${PANEL_ID} .sl-res{margin-top:16px}
#${PANEL_ID} .sl-res h3{font-size:13px;margin:0 0 4px;display:flex;align-items:center;gap:10px}
#${PANEL_ID} .sl-res h3 .sl-muted{font-weight:500}
#${PANEL_ID} .sl-res.ret{opacity:.85}
#${PANEL_ID} col.c-no{width:150px}#${PANEL_ID} col.c-gs{width:28%}#${PANEL_ID} col.c-amt{width:110px}
#ub-sl-veil.run{display:flex;justify-content:center;align-items:flex-start;padding-top:3px;color:#fff;font-size:13px;font-weight:700}
@media (prefers-reduced-motion: reduce){#${PANEL_ID} .sl-spin,#${PANEL_ID} .sl-prog .bar.indet>i{animation:none}}
`;
  function ensureStyle() { if (!document.getElementById(STYLE_ID)) { const s = document.createElement('style'); s.id = STYLE_ID; s.textContent = CSS; document.head.appendChild(s); } }
  //  아이콘은 인라인 SVG 심볼(이모지 금지 — 확장 디자인 지침). id 는 페이지와 안 겹치게 접두.
  const ICON_DEFS = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>'
    + '<symbol id="ub-sl-i-spin" viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9"/></symbol>'
    + '<symbol id="ub-sl-i-check" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></symbol>'
    + '<symbol id="ub-sl-i-warn" viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></symbol>'
    + '<symbol id="ub-sl-i-x" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></symbol>'
    + '<symbol id="ub-sl-i-file" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></symbol>'
    + '<symbol id="ub-sl-i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></symbol>'
    + '</defs></svg>';
  const ico = (n, cls) => '<svg class="sl-ico' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#ub-sl-i-' + n + '"/></svg>';
  const chip = (cls, text, icon) => '<span class="sl-chip ' + cls + '">' + (icon ? ico(icon, icon === 'spin' ? 'sl-spin' : '') : '') + esc(text) + '</span>';
  const fmtAt = (at) => esc(String(at || '').slice(0, 16).replace('T', ' '));

  function verdictChips(e) {
    if (e.result) return resultChip(e.result);
    if (e.st === 'pending') return S.phase === 'enriching' || e.client ? chip('busy', '조회 중', 'spin') : '<span class="sl-muted">조회 전</span>';
    if (e.st === 'sold') return chip('gray', '이미 판매됨');
    if (e.st === 'block') return chip('fail', '차단');
    const partial = e.rows.filter((r) => rowSold(e, r)).length;
    return chip('done', '체크 가능', 'check') + (partial ? ' ' + chip('gray', '일부 이미 판매됨 ' + partial + '행') : '');
  }
  function resultChip(r) {
    if (r.status === 'done') return chip('done', '완료' + (r.tradeJun ? ' · 판매전표 ' + r.tradeJun : ''), 'check');
    return chip(r.status === 'skipped' ? 'skipped' : 'fatal', (r.status === 'skipped' ? '건너뜀' : r.status === 'blocked' ? '중단(앞 고객 fatal)' : '중단') + (r.reason ? ' · ' + r.reason : ''), 'warn');
  }
  function findUi(e, ei) {
    const dis = (S.running || S.starting) ? ' disabled' : '';
    const opts = (e.cands || []).map((c) => '<option value="' + esc(c.seq + '|' + c.name) + '">' + esc(c.name) + ' · ' + esc(c.phone || '') + ' · #' + esc(c.seq) + '</option>').join('');
    return '<div class="sl-find"><input class="sl-in" aria-label="고객 검색" data-f="q" data-o="' + ei + '" value="' + esc(e.q) + '" placeholder="고객명 검색"' + dis + '>'
      + '<button class="sl-btn sm icon" aria-label="검색" title="검색" data-act="search" data-o="' + ei + '"' + dis + '>' + ico('search') + '</button>'
      + (e.cands ? '<select class="sl-in" aria-label="검색 결과" data-f="pick" data-o="' + ei + '"' + dis + '><option value="">— 고객 선택 —</option>' + opts + '</select>' : '')
      + (e.note ? '<span class="sl-muted">' + esc(e.note) + '</span>' : '') + '</div>';
  }
  function entryRows(e, ei) {
    const cash = e.match && (e.st === 'ok' || e.st === 'done') ? e.match.cash : 0;
    const cls = e.result ? (e.result.status === 'done' ? ' res-done' : ' res-bad') : e.st === 'block' ? ' bad' : e.st === 'sold' ? ' sold' : '';
    const chkOn = e.checked && entryReady(e);
    const head = '<tr class="sl-o' + cls + '"><td><input type="checkbox" class="sl-chk" data-f="chk" data-o="' + ei + '"' + (chkOn ? ' checked' : '') + (entryReady(e) && !S.running && !S.starting ? '' : ' disabled') + '></td>'
      + '<td colspan="2"><span class="sl-cust">' + esc(e.key) + '</span> '
      + (e.client ? '<span class="sl-muted">→ ' + esc(e.client.name) + ' #' + esc(e.client.seq) + '</span> ' + chip(e.how === '자동' ? 'reuse' : 'gray', e.how === '자동' ? '자동 매칭' : '직접 선택') : '')
      + (e.source ? ' ' + chip('gray', '근거 ' + e.source) : '')
      + '</td><td>' + verdictChips(e)
      + (e.st === 'block' && !e.result ? '<div class="sl-issue">' + ico('warn') + esc(e.reason) + '</div>' + (e.hard ? '' : findUi(e, ei)) : '')
      + '</td>'
      + '<td class="num">' + (cash ? '현금 ' + fmt(cash) + '원' : '') + '</td></tr>';
    const body = e.rows.map((r) => {
      const sold = rowSold(e, r), lines = rowLines(e, r);
      const prev = S.ledger[ledgerKey(r)] && !e.result ? ' ' + chip('prev', '이전에 처리함 ' + fmtAt(S.ledger[ledgerKey(r)].at), 'warn') : '';
      const uv = sold ? chip('gray', '이미 판매됨') : rowMerged(e, r) ? '<span class="sl-muted">같은 주문 — 위 줄에 합산</span>'
        : lines.length ? '<div class="sl-uv">' + lines.map((l) => '<div><span class="amt">' + fmt(l.amount) + '원</span><span class="bc">' + esc(l.barcode) + '</span>' + esc(l.name) + '</div>').join('') + '</div>'
        : '<span class="sl-muted">—</span>';
      return '<tr class="sl-l' + (sold ? ' sold' : '') + '"><td></td><td>' + esc(r.orderNo) + prev + '</td>'
        + '<td><div>' + esc(r.name) + (r.qty > 1 ? ' × ' + r.qty : '') + '</div>' + (r.option ? '<div class="sl-opt">' + esc(r.option) + '</div>' : '') + (r.note ? '<div class="sl-opt">' + esc(r.note) + '</div>' : '') + '</td>'
        + '<td>' + uv + '</td><td class="num">' + (sold ? '' : fmt(r.amount) + '원') + '</td></tr>';
    }).join('');
    const gifts = (e.match && (e.st === 'ok' || e.st === 'done') ? e.match.lines.filter((l) => l.gift) : []).map((l) =>
      '<tr class="sl-l"><td></td><td class="sl-muted">사은품</td><td class="sl-muted">같은 주문일 사은품 줄</td><td><div class="sl-uv"><div class="gift"><span class="bc">' + esc(l.barcode) + '</span>' + esc(l.name) + '</div></div></td><td class="num sl-muted">0원</td></tr>').join('');
    return head + body + gifts;
  }
  //  진행 스트립. 조회·실행 중에만 그려지고, 실행 중엔 log 훅이 progPatch 로 문구만 갱신한다.
  function progStrip() {
    const pr = S.progress;
    const bar = (done, total) => '<span class="bar"><i style="width:' + (total ? Math.round(done / total * 100) : 0) + '%"></i></span><span class="cnt">' + done + '/' + total + '</span>';
    if (S.phase === 'reading') return '<div class="sl-prog" role="status" aria-live="polite">' + ico('spin', 'sl-spin') + '<span class="txt">xlsx 읽는 중…</span><span class="bar indet"><i></i></span></div>';
    if (S.phase === 'ledger') return '<div class="sl-prog" role="status" aria-live="polite">' + ico('spin', 'sl-spin') + '<span class="txt">아틀리에 원장 조회 중</span><span class="sub">— 주문번호로 수령자 찾기 (읽기만)</span><span class="bar indet"><i></i></span></div>';
    if (S.phase === 'enriching') return '<div class="sl-prog" role="status" aria-live="polite">' + ico('spin', 'sl-spin') + '<span class="txt">유비샵 조회 중</span><span class="sub">— 고객·주문내역·판매내역 (읽기만)</span>' + bar(pr.done, pr.total) + '</div>';
    if (S.phase === 'running') return '<div class="sl-prog run" role="status" aria-live="polite">' + ico('spin', 'sl-spin') + '<span class="txt">판매 중 ' + Math.min(pr.done + 1, pr.total) + '/' + pr.total + '</span><span class="sub">— ' + esc(pr.key) + (pr.label ? ' · ' + esc(pr.label) : '') + '</span>' + bar(pr.done, pr.total) + '<span class="warn">이 창과 유비샵 판매 화면을 조작하지 마세요</span></div>';
    return '';
  }
  function progPatch() {
    const p = document.getElementById(PANEL_ID); if (!p) return;
    const el = p.querySelector('.sl-prog'); if (!el) return;
    const tmp = document.createElement('div'); tmp.innerHTML = progStrip();
    if (tmp.firstChild) el.replaceWith(tmp.firstChild);
  }
  //  표 영역에 포커스가 있으면(검색창·셀렉트) 표를 다시 그리지 않는다 — 입력 중 값 소실·클릭 유실 방지. 스트립은 갱신.
  function renderSoft() {
    if (focusInTable()) { progPatch(); return; }
    renderBody(); progPatch();
  }
  function focusInTable() {
    const a = document.activeElement, p = document.getElementById(PANEL_ID), b = p && p.querySelector('.sl-b');
    return !!(b && a && b.contains(a));
  }
  function stepsHtml() {
    const hasFile = S.entries.length > 0, ran = S.phase === 'running' || S.results.length > 0;
    const st = (n, label, state) => '<span class="sl-step' + (state ? ' ' + state : '') + '"><span class="n">' + (state === 'done' ? ico('check') : n) + '</span>' + label + '</span>';
    return '<div class="sl-steps">' + st(1, '파일', hasFile ? 'done' : 'on') + '<span class="sep">›</span>' + st(2, '검토', ran ? 'done' : hasFile ? 'on' : '') + '<span class="sep">›</span>' + st(3, '판매', ran ? 'on' : '') + '</div>';
  }
  function counts() {
    const E_ = S.entries;
    const nOk = E_.filter((e) => e.st === 'ok').length, nSold = E_.filter((e) => e.st === 'sold').length, nBlock = E_.filter((e) => e.st === 'block').length;
    const chk = E_.filter((e) => e.checked && entryReady(e));
    return { nOk, nSold, nBlock, nRet: S.returns.length, nChk: chk.length, nLines: chk.reduce((n, e) => n + e.match.lines.length, 0), cash: chk.reduce((s, e) => s + e.match.cash, 0), nPending: E_.filter((e) => e.st === 'pending').length };
  }
  function render() {
    const p = document.getElementById(PANEL_ID); if (!p) return;
    const c = counts(), nEnt = S.entries.length;
    const lock = (S.running || S.starting) ? ' disabled' : '';
    p.querySelector('.sl-steps-slot').innerHTML = stepsHtml();
    p.querySelector('.sl-top').innerHTML =
      '<div class="sl-bar"><label class="sl-btn">' + ico('file') + '정산 파일 선택<input type="file" id="ub-sl-file" accept=".xls,.xlsx,.csv" hidden' + lock + '></label>'
      + (nEnt ? '<span class="sl-file">' + esc(S.fileName) + '</span><span class="sl-count">마켓 <b>' + esc(S.adapter ? S.adapter.label : '') + '</b></span><span class="sl-count">체크 가능 <b>' + c.nOk + '</b> <i>·</i> 이미 판매 <b>' + c.nSold + '</b> <i>·</i> 차단 <b>' + c.nBlock + '</b> <i>·</i> 반품 <b>' + c.nRet + '</b></span>' : '<span class="sl-muted">지원: GS샵 · 카페24 이니시스(신용카드) · SSG · 스마트스토어 · 쿠팡 · 퀸잇 · 아몬즈 · 에이블리 — xlsx 를 선택하세요</span>')
      + '<span class="sl-spacer"></span>'
      + '<button class="sl-btn pri" data-act="run"' + (c.nChk && !S.running && !S.starting && !S.enriching && S.enabled ? '' : ' disabled') + (S.enabled ? '' : ' title="스위치가 꺼져 있습니다"') + '>' + (S.running ? '판매 중…' : '판매 시작') + '</button>'
      + '<button class="sl-btn quiet" data-act="export-log">로그 JSON</button></div>'
      + progStrip();
    renderBody();
  }
  const mk = () => (!S.adapter || S.adapter.id === 'gs') ? 'GS ' : '';
  function renderBody() {
    const p = document.getElementById(PANEL_ID); if (!p) return;
    const c = counts(), nEnt = S.entries.length;
    const done = S.results.filter((r) => r.status === 'done').length, other = S.results.length - done;
    const nUnprev = S.entries.filter((e) => e.st === 'ok' && e.rows.some((r) => S.ledger[ledgerKey(r)])).length;
    const banners = [];
    if (S.error) banners.push({ cls: '', text: S.error });
    if (S.notice) banners.push({ cls: 'warn', text: S.notice });
    if (nUnprev && !S.results.length) banners.push({ cls: 'warn', text: '이전에 처리한 적 있는 주문번호가 든 고객 ' + nUnprev + '명이 있습니다 — 주황색 표시를 확인하고 판매하세요.' });
    const ret = S.returns.length ? '<div class="sl-res ret"><h3>수동 처리 필요 — 반품 <span class="sl-muted">' + S.returns.length + '건은 자동 처리에서 제외됩니다</span></h3><table class="sl-t" style="margin-top:6px"><thead><tr><th>' + mk() + '주문번호</th><th>수취인</th><th>상품</th><th class="num">수량</th><th class="num">' + (S.adapter && S.adapter.id === 'gs' ? '최종 판처금액' : '지급액') + '</th></tr></thead><tbody>'
      + S.returns.map((r) => '<tr class="sl-muted"><td>' + esc(r.orderNo) + '</td><td>' + esc(r.buyer) + '</td><td>' + esc(r.name) + '</td><td class="num">' + (r.qty == null ? '' : r.qty) + '</td><td class="num">' + fmt(r.amount) + '원</td></tr>').join('') + '</tbody></table></div>' : '';
    p.querySelector('.sl-b').innerHTML =
      banners.map((b) => '<div class="sl-banner ' + b.cls + '">' + ico('warn') + esc(b.text) + '</div>').join('')
      + (nEnt ? '<div class="sl-sum"><span>처리 대상 고객 <b>' + c.nChk + '</b>명</span><span>줄 <b>' + c.nLines + '</b></span><span>현금 합계 <b>' + fmt(c.cash) + '</b>원</span><span class="sl-muted">차단 ' + c.nBlock + ' · 제외 ' + (c.nSold + c.nRet) + '(이미 판매 ' + c.nSold + ' · 반품 ' + c.nRet + ')</span></div>' : '')
      + (nEnt ? '<table class="sl-t"><colgroup><col style="width:36px"><col class="c-no"><col class="c-gs"><col><col class="c-amt"></colgroup>'
        + '<thead><tr><th><input type="checkbox" class="sl-chk" data-f="chkall" title="체크 가능한 고객 전체 체크/해제"' + (c.nOk && c.nChk === c.nOk ? ' checked' : '') + (c.nOk && !S.running && !S.starting ? '' : ' disabled') + '></th><th>' + mk() + '주문번호</th><th>' + mk() + '상품</th><th>유비샵 바코드 · 상품</th><th class="num">실판매가</th></tr></thead><tbody>'
        + S.entries.map(entryRows).join('') + '</tbody></table>' : (S.phase === 'reading' || S.error ? '' : '<div class="sl-empty">파일을 선택하면 고객별 검토 표가 여기에 뜹니다.</div>'))
      + ret
      + (S.results.length ? '<div class="sl-res"><h3>결과 <span class="sl-muted">— 완료 ' + done + ' · 건너뜀/중단 ' + other + '</span></h3><table class="sl-t" style="margin-top:6px"><thead><tr><th>고객</th><th>상태</th><th>사유</th><th>판매전표</th><th>결제전표</th><th class="num">되돌림</th></tr></thead><tbody>'
        + S.results.map((r) => '<tr><td>' + esc(r.key) + '</td><td>' + resultChip(Object.assign({}, r, { reason: '' })) + '</td><td>' + esc(r.reason || '') + '</td><td>' + esc(r.tradeJun || '') + '</td><td>' + esc(r.payJun || '') + '</td><td class="num">' + esc(r.rolledBack || 0) + '</td></tr>').join('')
        + '</tbody></table></div>' : '');
  }
  function openPanel() {
    ensureStyle();
    if (document.getElementById(PANEL_ID)) return;
    const veil = document.createElement('div'); veil.id = VEIL_ID; document.body.appendChild(veil);
    const p = document.createElement('div'); p.id = PANEL_ID;
    p.innerHTML = ICON_DEFS + '<div class="sl-h"><span class="sl-title">판매 처리 가져오기</span><span class="sl-steps-slot"></span><button class="sl-x" data-act="close" title="닫기" aria-label="닫기">' + ico('x') + '</button></div><div class="sl-top"></div><div class="sl-b"></div>';
    document.body.appendChild(p);
    p.addEventListener('click', onClick);
    p.addEventListener('change', onChange);
    p.addEventListener('keydown', onKeydown);
    render();
    if (S.running) setVeil(true);
  }
  function closePanel() {
    if (S.running && !confirm('실행 중입니다. 정말 닫을까요? (진행 중인 판매전표는 서버에 남을 수 있습니다)')) return;
    const p = document.getElementById(PANEL_ID); if (p) p.remove();
    const v = document.getElementById(VEIL_ID); if (v) v.remove();
  }
  function download(name, obj) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
    a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  async function onClick(e) {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const act = btn.dataset.act;
    if ((S.running || S.starting) && act !== 'close' && act !== 'export-log') return;   // 실행 중(시작 대기 포함) 조작 차단 — 다운로드·닫기만 허용
    if (act === 'close') closePanel();
    else if (act === 'run') run();
    else if (act === 'export-log') download('ub-saleimport-log-' + Date.now() + '.json', { results: S.results, log: S.log });
    else if (act === 'search') await searchCands(+btn.dataset.o, btn.parentElement.querySelector('input[data-f="q"]'));
  }
  function onKeydown(e) {
    const el = e.target;
    if (!el || el.dataset.f !== 'q' || e.key !== 'Enter') return;
    e.preventDefault();
    if (S.running || S.starting) return;
    searchCands(+el.dataset.o, el);
  }
  async function onChange(e) {
    if (S.running || S.starting) return;
    const el = e.target;
    if (el.id === 'ub-sl-file') { const f = el.files && el.files[0]; if (f) await loadFile(f); return; }
    const f = el.dataset.f; if (!f) return;
    if (f === 'chk') { const en = S.entries[+el.dataset.o]; en.checked = el.checked && entryReady(en); render(); return; }
    if (f === 'chkall') { S.entries.forEach((en) => { en.checked = el.checked && entryReady(en); }); render(); return; }
    if (f === 'q') { S.entries[+el.dataset.o].q = el.value; return; }   // 검색어는 모델에만 — 다시 그리면 글자가 사라진다
    if (f === 'pick') await pickClient(+el.dataset.o, el.value);
  }
  async function loadFile(file) {
    //  파일을 연달아 고르면 먼저 고른 파일의 결과가 나중 표를 덮어쓴다 — 세대 토큰으로 최신 선택만 반영.
    const gen = ++S.fileGen;
    S.fileName = file.name; S.results = []; S.entries = []; S.returns = []; S.error = ''; S.adapter = null; S.parsed = null; S.notice = ''; S.ledgerFailed = false;
    try {
      S.phase = 'reading'; render();
      const parsed = await readXls(file);
      if (gen !== S.fileGen) return;
      parseEntries(parsed);
      const li = S.adapter.ledgerMarket ? await fetchLedgerIndex() : { idx: null, failed: false, notice: '' };
      if (gen !== S.fileGen) return;
      S.ledgerFailed = li.failed; if (li.notice) S.notice = li.notice;
      if (li.parsed) S.parsed = li.parsed;
      buildEntries(li.idx);
      S.phase = 'idle'; render();
      await enrich();
      if (gen !== S.fileGen) return;
      render();
    } catch (err) {
      if (gen !== S.fileGen) return;
      S.phase = 'idle'; S.entries = []; S.returns = []; S.adapter = null; S.parsed = null; S.error = '파일을 처리하지 못했습니다: ' + (err && err.message || err); render();
    }
  }

  /* ------------------------------------------------------------ 배선 */
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('#ub-sl-open');
    if (!b) return;
    e.preventDefault();
    if (!S.enabled) { alert('팝업에서 [유비샵 스킨모드]와 [판매 처리 가져오기]를 켜세요.'); return; }
    openPanel();
  }, true);
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.ubSkin || ch.ubSaleImport) loadState().then(() => { if (!S.running) render(); });   // 열린 패널의 실행 버튼도 즉시 잠근다
    if (ch[KEY_LEDGER]) { S.ledger = Object.assign({}, S.ledger, ch[KEY_LEDGER].newValue || {}); if (!S.running) render(); }
  });
  loadState();
})();
