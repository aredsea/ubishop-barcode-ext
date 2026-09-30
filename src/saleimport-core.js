/* =============================================================================
 *  saleimport-core.js — GS샵 판매 처리 가져오기 **순수 함수** 모듈 (DOM·fetch·chrome 없음).
 *  ISOLATED content_script 로 saleItemWriteForm.do 에만 실리고, node 에서는 module.exports 로 테스트한다.
 *  스펙: docs/superpowers/specs/2026-09-30-saleimport-design.md
 *  노출: 브라우저 → globalThis.ubSl, node → module.exports (orderimport-core 와 같은 방식).
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------ §2.1 헤더 */
  const COLS = Object.freeze({
    orderNo: '주문번호', type: '주문유형', name: '상품명', option: '주문옵션', buyer: '수취인', phone: '휴대전화',
    qty: '수량', W: '협력사지급금액', X: '할인쿠폰', Y: '반품유보', Z: '딜광고', AA: '반품유보 지급', final: '최종 판처금액'
  });
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
  function slHeaderMap(header) {
    const idx = {}, missing = [];
    const h = (header || []).map(norm);
    Object.keys(COLS).forEach((k) => {
      const i = h.indexOf(norm(COLS[k]));
      if (i < 0) missing.push(COLS[k]); else idx[k] = i;
    });
    return { idx, missing };
  }

  function slMoney(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v == null ? '' : v).replace(/[,\s원]/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return Number(s);
  }
  function slRound(x) { return Math.sign(x) * Math.floor(Math.abs(x) + 0.5); }

  /* ------------------------------------------------------------ §2.1 파싱 */
  function slParseSheet(rows) {
    if (!Array.isArray(rows) || !rows.length) return { ok: false, error: '빈 파일' };
    const hm = slHeaderMap(rows[0]);
    if (hm.missing.length) return { ok: false, error: '필수 열 없음: ' + hm.missing.join(', ') };
    const ix = hm.idx;
    const cell = (r, k) => String(r[ix[k]] == null ? '' : r[ix[k]]).trim();
    const tIdx = rows.findIndex((r, i) => i > 0 && String(r[0] == null ? '' : r[0]).trim() === '합계');
    if (tIdx < 0) return { ok: false, error: '합계 행 없음' };
    const out = [];
    for (let i = 1; i < tIdx; i++) {
      const r = rows[i] || [];
      const orderNo = cell(r, 'orderNo');
      if (!orderNo) continue;
      const W = slMoney(cell(r, 'W')), qty = slMoney(cell(r, 'qty'));
      if (W == null) return { ok: false, error: orderNo + ': 협력사지급금액 없음' };
      if (qty == null || qty === 0) return { ok: false, error: orderNo + ': 수량 없음' };
      out.push({
        r: i, orderNo, type: cell(r, 'type'), name: cell(r, 'name'), option: cell(r, 'option'),
        buyer: cell(r, 'buyer'), phone: cell(r, 'phone'), qty, W, X: slMoney(cell(r, 'X')) || 0,
        cachedFinal: slMoney(cell(r, 'final'))
      });
    }
    if (!out.length) return { ok: false, error: '데이터 행 없음' };
    const t = rows[tIdx];
    const tot = (k) => slMoney(String(t[ix[k]] == null ? '' : t[ix[k]]).trim()) || 0;
    return { ok: true, rows: out, totals: { Y: tot('Y'), Z: tot('Z'), AA: tot('AA') } };
  }

  /* ------------------------------------------------------------ §2.2 최종금액 */
  function slComputeFinals(p) {
    if (!p || !p.ok) return { ok: false, error: (p && p.error) || '파싱 실패' };
    const sumW = p.rows.reduce((s, r) => s + r.W, 0);
    if (sumW === 0) return { ok: false, error: '협력사지급금액 합계가 0' };
    const T = p.totals;
    const rows = p.rows.map((r) => {
      const share = r.W / sumW;
      const Yr = T.Y * share, Zr = T.Z * share, AAr = T.AA * share;
      const final = r.W - r.X - Yr - Zr + AAr;
      return Object.assign({}, r, { Yr, Zr, AAr, final, amount: slRound(final) });
    });
    const bad = rows.find((r) => r.cachedFinal != null && Math.abs(r.cachedFinal - r.final) > 1);
    if (bad) return { ok: false, error: bad.orderNo + ': 파일의 최종 판처금액(' + bad.cachedFinal + ')과 계산값(' + slRound(bad.final) + ')이 다름' };
    const sumX = rows.reduce((s, r) => s + r.X, 0);
    const sumF = rows.reduce((s, r) => s + r.final, 0);
    if (Math.abs(sumF - (sumW - sumX - T.Y - T.Z + T.AA)) > 0.5) return { ok: false, error: '검산 불일치' };
    return { ok: true, rows, sumW };
  }

  /* ------------------------------------------------------------ §2.3 분류 · §3.1 고객명 */
  function slIsReturn(row) { return row.type === '반품주문' || row.qty < 0; }
  function slClientName(buyer, phone) {
    const d = String(phone == null ? '' : phone).replace(/\D/g, '');
    return String(buyer || '').trim() + (d.length >= 4 ? d.slice(-4) : '') + '/G';
  }

  /* ------------------------------------------------------------ §3.2~3.3 매칭·배분 */
  function slAllocate(total, q) {
    const base = Math.floor(total / q);
    const out = new Array(q).fill(base);
    out[0] += total - base * q;
    return out;
  }
  function slGroupByClient(rows) {
    const map = new Map();
    rows.filter((r) => !slIsReturn(r)).forEach((r) => {
      const key = slClientName(r.buyer, r.phone);
      if (!map.has(key)) map.set(key, { key, rows: [], client: null });
      map.get(key).rows.push(r);
    });
    return [...map.values()];
  }
  //  고객 한 명: 같은 단가(W/qty) 끼리 필요 개수를 모아, 판매 안 된 본품 줄이 **정확히 그 개수**일 때만 자동.
  function slMatchClient(rows, orders, sales) {
    const sold = new Set((sales || []).map((s) => s.barcode).filter(Boolean));
    const block = (reason) => ({ status: 'block', reason, lines: [], cash: 0 });
    const need = new Map();   // unit → [{row, amounts[]}]
    for (const r of rows) {
      if (!(r.amount > 0)) return block(r.orderNo + ': 실판매가가 0 이하');
      const unit = r.W / r.qty;
      if (!Number.isInteger(unit)) return block(r.orderNo + ': 협력사지급금액이 수량으로 나누어지지 않음');
      if (!need.has(unit)) need.set(unit, []);
      need.get(unit).push({ row: r, amounts: slAllocate(r.amount, r.qty) });
    }
    const lines = [], usedDates = new Set();
    let soldOnly = true;
    for (const [unit, list] of need) {
      const n = list.reduce((s, x) => s + x.row.qty, 0);
      const mains = orders.filter((o) => !o.gift && o.settle === unit);
      const open = mains.filter((o) => !o.barcode || !sold.has(o.barcode));
      if (open.length === 0 && mains.length >= n) continue;             // 전부 이미 판매됨
      soldOnly = false;
      if (open.length !== n) return block('정산 ' + unit.toLocaleString('en-US') + ' 주문 줄 ' + open.length + '개 (필요 ' + n + '개)');
      if (open.some((o) => !o.barcode)) return block('바코드 없는 주문 줄 — 입고 확인');
      let k = 0;
      for (const { row, amounts } of list) for (const a of amounts) {
        const o = open[k++];
        lines.push({ barcode: o.barcode, code: o.code, name: o.name, gift: false, orderNo: row.orderNo, amount: a });
        usedDates.add(o.date);
      }
    }
    if (soldOnly) return { status: 'sold', reason: '이미 판매됨', lines: [], cash: 0 };
    orders.filter((o) => o.gift && o.barcode && !sold.has(o.barcode) && usedDates.has(o.date))
      .forEach((o) => lines.push({ barcode: o.barcode, code: o.code, name: o.name, gift: true, orderNo: '', amount: 0 }));
    return { status: 'ok', reason: '', lines, cash: lines.reduce((s, l) => s + l.amount, 0) };
  }

  /* ------------------------------------------------------------ §3.2 거래내역 파싱 */
  //  목록 표는 헤더 셀(주문일/판매일)로 찾고, 각 <tr> 을 **행 텍스트 전체**로 본다(셀 묶음이 화면마다 달라도 견딘다).
  const BARCODE_RE = /(?:^|\s)(2[1-6](?=[0-9A-Z]{0,3}[A-Z])[0-9A-Z]{4})(?=\s|$)/;   // 년도 21~26 + 영숫자 4(영문 ≥1)
  const CODE_RE = /[A-Z]-[A-Z0-9]{2}-[A-Z]-[A-Z]{2}-[A-Z]{2}-[0-9A-Z]{4}/;
  const DATE_RE = /(\d\d-\d\d-\d\d)/;
  function textOf(h) {
    return String(h).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  }
  //  바깥 표의 최상위 <tr> 만 자른다 — 이미지 칸에 중첩 <table><tr> 이 있어 단순 split 은 행을 쪼갠다(실측).
  function topRows(tableHtml) {
    const out = []; const re = /<(\/?)(table|tr)\b[^>]*>/gi;
    let depth = 0, start = -1, m;
    while ((m = re.exec(tableHtml))) {
      const close = m[1] === '/', tag = m[2].toLowerCase();
      if (tag === 'table') { depth += close ? -1 : 1; continue; }
      if (depth !== 1) continue;
      if (!close) start = m.index; else if (start >= 0) { out.push(tableHtml.slice(start, re.lastIndex)); start = -1; }
    }
    return out;
  }
  //  headWord('주문일'|'판매일') 가 든 title_line 행 이후의 행 텍스트. 표는 그 헤더를 품은 가장 가까운 <table class="t_list">.
  function listRows(html, headWord) {
    const s = String(html || '');
    const hi = s.search(new RegExp('<tr[^>]*class="title_line"[^>]*>(?:(?!</tr>)[\\s\\S])*' + headWord));
    if (hi < 0) return [];
    const ts = s.lastIndexOf('<table', hi);
    const rows = topRows(s.slice(ts));
    const hIdx = rows.findIndex((r) => /class="title_line"/.test(r) && r.indexOf(headWord) >= 0);
    return rows.slice(hIdx + 1).map(textOf).filter((t) => DATE_RE.test(t) && /^\d+\s/.test(t));
  }
  const nums = (t) => (t.match(/-?\d[\d,]*(?:\.\d+)?/g) || []).map((x) => Number(x.replace(/,/g, '')));
  function slOrderRows(html) {
    return listRows(html, '주문일').map((t) => {
      const bc = t.match(BARCODE_RE); const code = t.match(CODE_RE);
      const st = t.match(/정산\s*([\d,]+)/);
      const tail = t.replace(/\s*\S+$/, '');                 // 끝의 접수직원 이름 제거
      const n = nums(tail);
      const after = code ? t.slice(t.indexOf(code[0]) + code[0].length).trim() : '';
      return {
        date: (t.match(DATE_RE) || [])[1] || '', barcode: bc ? bc[1] : '', code: code ? code[0] : '',
        name: after.split(' ')[0] || '', gift: /\(사은품\)/.test(t),
        settle: st ? Number(st[1].replace(/,/g, '')) : null, qty: n[n.length - 2], price: n[n.length - 1]
      };
    });
  }
  function slSaleRows(html) {
    return listRows(html, '판매일').map((t) => {
      const bc = t.match(BARCODE_RE); const code = t.match(CODE_RE);
      //  꼬리: … 판매가 수량 DC(DC율 %) 실판매가 판매직원  → 퍼센트 괄호를 빼고 숫자 4개
      const tail = t.replace(/\s*\S+$/, '').replace(/\([\d.]+\s*%\)/g, ' ');
      const n = nums(tail);
      return {
        date: (t.match(DATE_RE) || [])[1] || '', barcode: bc ? bc[1] : '', code: code ? code[0] : '',
        price: n[n.length - 4], qty: n[n.length - 3], dc: n[n.length - 2], amount: n[n.length - 1]
      };
    });
  }
  function slTradeUrl(vcode, client, clientName) {
    return '/info/clienttrade/infoClientTradeView.do?tcode=sale_item&vcode=' + vcode
      + '&searchImageType=0&reqPage=1&pageSize=100&searchSortType=seq&url=/sale/item/saleItemWriteForm.do'
      + '&shop=LT&shopName=FASHION&client=' + encodeURIComponent(client) + '&clientName=' + encodeURIComponent(clientName);
  }

  /* ------------------------------------------------------------ §4.1 판매 폼 읽기·페이로드 */
  //  폼 유틸은 orderimport-core 것을 쓴다(브라우저에선 manifest 에서 먼저 실림).
  const O = (typeof module !== 'undefined' && module.exports) ? require('./orderimport-core.js') : globalThis.ubOi;

  const SL_FORM10_NAMES = Object.freeze(['sKey', 'pageSize', 'searchSortType', 'tradeJun', 'payJun', 'shop', 'client', 'payBank', 'payDia', 'payCard',
    'paySaleOldGold', 'payCash', 'payCashPaper', 'payRemark', 'payEtc', 'txtSaleDate', 'regId', 'beforePrice', 'beforePoint', 'saleDcPrice',
    'usePoint', 'payPrice', 'savePoint', 'afterPrice', 'afterPoint']);
  const SL_VALUE_NAMES = ['sKey', 'tradeJun', 'payJun', 'client', 'clientName'];
  //  줄 수정 폼(form1)의 필드 — 문서 순서. imageField22(type=image)는 제외.
  const SL_MODIFY_NAMES = ['sKey', 'pageSize', 'searchSortType', 'tradeJun', 'payJun', 'seq', 'barcode', 'shop', 'client', 'shopName', 'clientName',
    'salePrice', 'saleQty', 'tmpSalePrice', 'dcRate', 'dcPrice', 'cashPoint', 'saleDcPrice', 'saleManager', 'tmpPoint', 'usePoint', 'remark'];

  function slComma(n) { return String(Math.trunc(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  const slInt = (s) => { const t = String(s == null ? '' : s).replace(/,/g, '').trim(); return /^-?\d+$/.test(t) ? Number(t) : NaN; };

  //  <form name=X> 구간(다음 </form> 또는 다음 <form 까지). 없으면 null.
  function formSeg(html, name) {
    const h = String(html);
    const m = h.match(new RegExp('<form\\b[^>]*\\bname\\s*=\\s*["\']?' + name + '["\']?(?=[\\s>"\'])', 'i'));
    if (!m) return null;
    const rest = h.slice(m.index + m[0].length);
    const e = rest.search(/<\/form>|<form\b/i);
    return e < 0 ? rest : rest.slice(0, e);
  }
  const firstNum = (cell) => { const m = String(cell == null ? '' : cell).match(/-?\d[\d,]*/); return m ? Number(m[0].replace(/,/g, '')) : null; };

  //  판매폼(saleItemWriteForm.do) → 값·form10·목록 행. 목록 열은 **헤더 이름으로** 찾는다(못 찾으면 그 값은 null → 대조가 실패한다).
  function slReadSaleForm(html) {
    const f1 = formSeg(html, 'form1') || String(html);
    const ex = O.oiExtractFields(f1, SL_VALUE_NAMES);
    const missing = ex.missing.slice();
    const seg10 = formSeg(html, 'form10');
    let form10 = {};
    if (seg10 == null) missing.push('form10');
    else { const e10 = O.oiExtractFields(seg10, SL_FORM10_NAMES); form10 = e10.values; e10.missing.forEach((n) => missing.push('form10.' + n)); }
    const all = O.oiTListAllRows(html);
    const head = all.find((r) => /class\s*=\s*["']?title_line/i.test(r.html));
    const cells = head ? head.cells : [];
    const col = { salePrice: cells.findIndex((c) => c === '판매가'), dc: cells.findIndex((c) => c.indexOf('DC금액') === 0), amount: cells.findIndex((c) => c === '실판매가') };
    const rows = all.filter((r) => r.idx !== null).map((r) => {
      const parts = String(r.idx).split(',');
      const at = (i) => (i < 0 ? null : firstNum(r.cells[i]));
      return { idx: String(r.idx), saleSeq: parts[0] || '', barcode: parts[1] || '', salePrice: at(col.salePrice), dcPrice: at(col.dc), amount: at(col.amount) };
    });
    return { values: ex.values, form10, missing, rows };
  }

  //  판매직원은 HTML selected 가 아니라 인라인 스크립트로 선택된다(실측, 스펙 §4.1).
  function slSaleManager(html) {
    const m = String(html).match(/form1\.saleManager\.value\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    return m ? (m[1] != null ? m[1] : m[2]) : '';
  }

  //  실판매가 수정 페이로드. dcPrice·dcRate 는 화면 JS(calDcPrice2·calDcRate)와 같은 규칙.
  function slModifyPayload(html, amount) {
    const f1 = formSeg(html, 'form1') || String(html);
    const fields = [], issues = [];
    const mgr = slSaleManager(html);
    SL_MODIFY_NAMES.forEach((n) => {
      const v = n === 'saleManager' ? mgr : O.oiFieldValue(f1, n);
      if (v === null) issues.push('missing:' + n); else fields.push([n, v]);
    });
    if (!mgr) issues.push('no_sale_manager');
    const get = (n) => { const f = fields.find((x) => x[0] === n); return f ? f[1] : ''; };
    const tmp = slInt(get('tmpSalePrice')), cashPoint = slInt(get('cashPoint'));
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || !Number.isFinite(tmp) || amount > tmp) { issues.push('bad_amount'); return { fields, issues }; }
    const dcPrice = tmp - amount - (Number.isFinite(cashPoint) ? cashPoint : 0);
    const dcRate = tmp === 0 ? '0.00' : (Math.round(dcPrice / tmp * 10000) / 100).toFixed(2);
    const set = (n, v) => { const f = fields.find((x) => x[0] === n); if (f) f[1] = v; };
    set('saleDcPrice', slComma(amount)); set('dcPrice', slComma(dcPrice)); set('dcRate', dcRate);
    return { fields, issues };
  }

  //  현금결제 페이로드. payJun 이 이미 있으면 결제는 이미 된 것 — 두 번 보내지 않는다(스펙 §4.1 결제 1회 규칙).
  function slCashPayload(html, cash) {
    const issues = [];
    const hidden = O.oiExtractHidden(html);
    ['sKey', 'tradeJun', 'payJun'].forEach((n) => { if (!hidden.some((h) => h[0] === n)) issues.push('missing:' + n); });
    const pj = hidden.find((h) => h[0] === 'payJun');
    if (pj && pj[1] !== '') issues.push('already_paid');
    if (typeof cash !== 'number' || !Number.isInteger(cash) || cash <= 0) issues.push('bad_cash');
    const fields = hidden.slice();
    fields.push(['payCash', slComma(cash)], ['payCashPaper', '0'], ['payEtc', '0'], ['remark', '']);
    return { fields, issues };
  }

  //  D8 — 판매하기 직전 미수 0: 거래 전·후 미수 0, 결제/현금/실판매가 합 = 현금. 하나라도 어긋나면 ok=false(판매하기를 보내지 않는다).
  function slJunCheck(form10, cash) {
    const f = form10 || {}; const bad = [];
    ['beforePrice', 'afterPrice'].forEach((n) => { if (slInt(f[n]) !== 0) bad.push(n + '=' + (f[n] == null ? '(없음)' : f[n])); });
    ['payPrice', 'payCash', 'saleDcPrice'].forEach((n) => { if (slInt(f[n]) !== cash || !Number.isFinite(cash)) bad.push(n + '=' + (f[n] == null ? '(없음)' : f[n]) + '≠' + cash); });
    return bad.length ? { ok: false, reason: bad.join(' ') } : { ok: true, reason: '' };
  }
  function slJunPayload(form10) { const f = form10 || {}; return SL_FORM10_NAMES.map((n) => [n, f[n] == null ? '' : String(f[n])]); }

  /* ------------------------------------------------------------ §4.2 실행기 (erp 주입) */
  //  erp 인터페이스(saleimport-erp.js 가 구현):
  //   state() → {tradeJun, payJun, rows:number, form}          openClient(client, clientName) → form
  //   getSaleForm({tradeJun,payJun,client,clientName}) → form   postLine(form, barcode) → {ok, msg, form}
  //   getModify(saleSeq, ctx) → html   postModify(fields) → {ok, msg, form}
  //   getCash(ctx) → html   postCash(fields) → {ok, msg, payJun, payCash}   postJun(fields) → {ok, msg}
  //   deleteLines(ctx, idxValues) → {ok, msg, before}   trade(client, clientName) → {orders, sales}
  //  hooks: { log(key, step, info) }
  //  plan = { key, client:{seq,name}, lines:[SaleLinePlan], cash }
  const errMsg = (e) => String((e && e.message) || e);
  const bagKey = (r) => r.barcode + ':' + r.amount;
  function sameBag(a, b) {
    if (a.length !== b.length) return false;
    const m = new Map();
    a.forEach((x) => m.set(x, (m.get(x) || 0) + 1));
    for (const x of b) { const n = m.get(x); if (!n) return false; m.set(x, n - 1); }
    return true;
  }
  function slNewResult(key) { return { key, status: 'pending', reason: '', tradeJun: '', payJun: '', saleSeqs: [], rolledBack: 0, paid: false }; }

  async function slRunClient(plan, erp, hooks) {
    const res = slNewResult(plan && plan.key);
    const log = (step, info) => { try { hooks && hooks.log && hooks.log(res.key, step, info); } catch (_) {} };
    const client = String(plan.client.seq), clientName = plan.client.name;
    const lines = plan.lines || [];
    const idxValues = [];
    let lineUnknown = false;
    const ctx = () => ({ tradeJun: res.tradeJun, payJun: res.payJun, client, clientName });
    const fatal = (reason) => { res.status = 'fatal'; res.reason = reason; log('fatal', reason); return res; };

    //  실패 처리. 🔴 결제 POST 를 보낸 뒤(paid)에는 무엇이든 fatal — 넣은 줄을 지우지 않고 결제를 취소하지도 않는다.
    //  줄 POST 의 결과를 모르는 상태(lineUnknown)도 fatal — 무엇이 들어갔는지 모르니 지우지도 계속하지도 않는다.
    const fail = async (reason) => {
      log('fail', reason);
      if (res.paid) return fatal('paid_unverified:' + reason);
      if (lineUnknown) return fatal('line_unverified:' + reason);
      if (idxValues.length) {
        try {
          //  삭제 직전에 세션의 열린 전표가 아직 내 tradeJun 인지 본다 — 남이 그 사이 완료했으면 완료된 전표를 지우게 된다.
          const now = await erp.state();
          if (String(now.tradeJun || '') !== String(res.tradeJun || '')) return fatal('rollback_aborted:trade_changed ' + (now.tradeJun || '(none)') + '≠' + res.tradeJun + ' (' + reason + ')');
          const del = await erp.deleteLines(ctx(), idxValues.slice());
          log('rollback', del);
          const after = await erp.getSaleForm(ctx());
          const remain = (after.rows || []).map((r) => String(r.saleSeq));
          if (!del.ok || remain.some((s) => res.saleSeqs.includes(s))) return fatal('rollback_failed:' + reason);
          if (!Array.isArray(del.before)) return fatal('rollback_unverifiable:' + reason);
          //  되돌리기가 내 줄 **밖**까지 지웠는지 — 삭제 직전 목록에 있던 남의 줄이 사라졌으면 서버 계약이 idx 단독 삭제가 아니다(미실측 → fail-closed).
          const foreign = del.before.map((r) => String(r.saleSeq)).filter((s) => s && !res.saleSeqs.includes(s));
          const lost = foreign.filter((s) => !remain.includes(s));
          if (lost.length) return fatal('rollback_overreach:' + lost.join(',') + ' (' + reason + ')');
          res.rolledBack = idxValues.length;
          const st = await erp.state();
          //  되돌린 뒤에도 세션에 줄이 남아 있으면(남의 줄이든 정체불명이든) 전체 중단 — 스펙 §4.2-7, oiRunOrder 와 같다.
          if (st.rows > 0) return fatal('foreign_rows_remain:' + reason + ' [rows ' + st.rows + (foreign.length ? ': ' + foreign.join(',') : '') + ']');
          if (st.rows !== foreign.length || st.tradeJun || st.payJun) return fatal('rollback_incomplete:trade ' + (st.tradeJun || '') + ' pay ' + (st.payJun || '') + ' rows ' + st.rows + ' (' + reason + ')');
          res.status = 'skipped'; res.reason = reason;
          return res;
        } catch (e) { return fatal('rollback_exception:' + errMsg(e) + ' (' + reason + ')'); }
      }
      res.status = 'skipped'; res.reason = reason; return res;
    };

    try {
      //  0. 계획 자체 점검(쓰기 전) — 현금 = 줄 실판매가 합, 바코드 유일·비어 있지 않음.
      const sum = lines.reduce((s, l) => s + l.amount, 0);
      const bcs = lines.map((l) => l.barcode);
      if (!lines.length || !Number.isInteger(plan.cash) || plan.cash <= 0 || sum !== plan.cash || lines.some((l) => !l.barcode || !Number.isInteger(l.amount) || l.amount < 0) || new Set(bcs).size !== bcs.length) {
        res.status = 'skipped'; res.reason = 'bad_plan'; return res;
      }
      //  1. 가드
      const st0 = await erp.state();
      log('guard', { tradeJun: st0.tradeJun, payJun: st0.payJun, rows: st0.rows });
      if (st0.tradeJun || st0.payJun || st0.rows > 0) { res.status = 'skipped'; res.reason = 'open_trade'; return res; }

      //  2. 줄 등록
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        const form = i === 0 ? await erp.openClient(client, clientName) : await erp.getSaleForm(ctx());
        const v = form.values || {};
        if (String(v.client) !== client) return await fail('client_mismatch:' + v.client + '≠' + client);
        if (!v.sKey) return await fail('no_sKey');
        const rows0 = form.rows || [];
        if (i === 0) {
          if (rows0.length || v.tradeJun || v.payJun) return await fail('session_not_empty');
        } else {
          if (String(v.tradeJun) !== String(res.tradeJun)) return await fail('trade_changed:' + v.tradeJun + '≠' + res.tradeJun);
          if (!sameBag(rows0.map((r) => String(r.saleSeq)), res.saleSeqs.map(String))) return await fail('foreign_row:' + rows0.map((r) => r.saleSeq).join(','));
        }
        let post;
        try { post = await erp.postLine(form, ln.barcode); }
        catch (e) { lineUnknown = true; return await fail('line_post_exception:' + errMsg(e)); }
        log('line', { i, n: lines.length, ok: post.ok, msg: post.msg });
        if (!post.ok) return await fail('line_failed:' + post.msg);
        const rows = (post.form && post.form.rows) || [];
        const fresh = rows.filter((r) => !res.saleSeqs.includes(String(r.saleSeq)));
        if (rows.length !== res.saleSeqs.length + 1 || fresh.length !== 1) { lineUnknown = true; return await fail('rowmismatch:rows=' + rows.length + ',fresh=' + fresh.map((r) => r.saleSeq + '/' + r.barcode).join('|')); }
        const gotTrade = post.form.values && post.form.values.tradeJun;
        if (!gotTrade) { lineUnknown = true; return await fail('trade_missing:line' + i); }
        if (res.tradeJun && String(gotTrade) !== String(res.tradeJun)) { lineUnknown = true; return await fail('trade_switched:' + gotTrade + '≠' + res.tradeJun); }
        //  새 줄이 정확히 하나인데 바코드가 다르면 그 줄이 내 것인지 확신할 수 없다 → 지우지도 계속하지도 않는다.
        if (fresh[0].barcode !== ln.barcode) { lineUnknown = true; return await fail('barcode:' + fresh[0].barcode + '≠' + ln.barcode); }
        res.saleSeqs.push(String(fresh[0].saleSeq));
        idxValues.push(fresh[0].saleSeq + ',' + fresh[0].barcode);
        res.tradeJun = String(gotTrade);
      }

      //  3. 줄마다 실판매가
      for (let i = 0; i < lines.length; i++) {
        const seq = res.saleSeqs[i], ln = lines[i];
        //  수정 POST 마다 직전에 판매 세션을 대조한다 — 같은 로그인의 다른 탭이 공유 전표에 줄을 끼워 넣었으면 다음 수정 POST 를 보내지 않는다.
        const chk = await erp.getSaleForm(ctx());
        const cv = chk.values || {};
        if (String(cv.client) !== client) return await fail('modify_session:client ' + cv.client + '≠' + client);
        if (String(cv.tradeJun) !== String(res.tradeJun)) return await fail('modify_session:trade ' + cv.tradeJun + '≠' + res.tradeJun);
        const crows = (chk.rows || []).map((r) => String(r.saleSeq));
        if (!sameBag(crows, res.saleSeqs.map(String))) return await fail('modify_session:rows ' + crows.join(',') + '≠' + res.saleSeqs.join(','));
        const html = await erp.getModify(seq, ctx());
        const pl = slModifyPayload(html, ln.amount);
        if (pl.issues.length) return await fail('modify_payload:' + pl.issues.join(','));
        const m = await erp.postModify(pl.fields);
        log('modify', { i, ok: m.ok, msg: m.msg });
        if (!m.ok) return await fail('modify_failed:' + m.msg);
        const mrows = ((m.form && m.form.rows) || []).map((r) => String(r.saleSeq));
        const mtrade = m.form && m.form.values && m.form.values.tradeJun;
        if (!sameBag(mrows, res.saleSeqs.map(String))) return await fail('modify_rows:' + mrows.join(',') + '≠' + res.saleSeqs.join(','));
        if (String(mtrade) !== String(res.tradeJun)) return await fail('modify_rows:trade ' + mtrade + '≠' + res.tradeJun);
        const row = ((m.form && m.form.rows) || []).find((r) => String(r.saleSeq) === String(seq));
        if (!row || row.amount !== ln.amount) return await fail('modify_unverified:' + seq + ' ' + (row ? row.amount : '(행 없음)') + '≠' + ln.amount);
      }

      //  4. 최종 대조 — 결제 전 마지막 관문
      const fin = await erp.getSaleForm(ctx());
      const fv = fin.values || {};
      if (String(fv.client) !== client) return await fail('final:client ' + fv.client + '≠' + client);
      if (String(fv.tradeJun) !== String(res.tradeJun)) return await fail('final:trade ' + fv.tradeJun + '≠' + res.tradeJun);
      const frows = fin.rows || [];
      if (!sameBag(frows.map((r) => String(r.saleSeq)), res.saleSeqs.map(String))) return await fail('final:rows ' + frows.map((r) => r.saleSeq).join(',') + '≠' + res.saleSeqs.join(','));
      if (!sameBag(frows.map(bagKey), lines.map(bagKey))) return await fail('final:lines ' + frows.map(bagKey).join('|') + '≠' + lines.map(bagKey).join('|'));
      if (frows.reduce((s, r) => s + r.amount, 0) !== plan.cash) return await fail('final:sum≠' + plan.cash);
      if (slInt(fin.form10 && fin.form10.beforePrice) !== 0) return await fail('final:beforePrice=' + (fin.form10 && fin.form10.beforePrice));

      //  5. 현금결제 — 이 POST 를 보내는 순간부터 paid. 이후 실패는 전부 fatal 이고 결제는 두 번 보내지 않는다.
      const cashHtml = await erp.getCash(ctx());
      const cp = slCashPayload(cashHtml, plan.cash);
      if (cp.issues.includes('already_paid')) return fatal('already_paid');   // 이미 결제가 있다 — 지우지도 다시 결제하지도 않는다
      if (cp.issues.length) return await fail('cash_payload:' + cp.issues.join(','));
      res.paid = true;
      let pc;
      try { pc = await erp.postCash(cp.fields); }
      catch (e) { return fatal('cash_unverified:exception:' + errMsg(e)); }
      log('cash', pc);
      if (!pc || !pc.ok) return fatal('cash_failed:' + (pc && pc.msg));
      if (!pc.payJun) return fatal('cash_unverified:payJun 없음');
      if (slInt(pc.payCash) !== plan.cash) return fatal('cash_unverified:payCash ' + pc.payCash + '≠' + plan.cash);
      res.payJun = String(pc.payJun);

      //  6. 판매하기 — D8: 미수 0 이 아니면 보내지 않는다.
      const f2 = await erp.getSaleForm(ctx());
      const v2 = f2.values || {}, t10 = f2.form10 || {};
      if (String(v2.client) !== client || String(t10.tradeJun) !== res.tradeJun || String(t10.payJun) !== res.payJun) return fatal('session_changed:' + [v2.client, t10.tradeJun, t10.payJun].join('/'));
      const lack = (f2.missing || []).concat(SL_FORM10_NAMES.filter((n) => t10[n] == null).map((n) => 'form10.' + n));
      if (lack.length) return fatal('form10_incomplete:' + [...new Set(lack)].join(','));   // 빈 값으로 판매하기를 보내지 않는다
      const jc = slJunCheck(t10, plan.cash);
      if (!jc.ok) return fatal('receivable:' + jc.reason);
      let jr;
      try { jr = await erp.postJun(slJunPayload(t10)); }
      catch (e) { return fatal('jun_unverified:exception:' + errMsg(e)); }
      log('jun', jr);
      if (!jr || !jr.ok) return fatal('jun_failed:' + (jr && jr.msg));
      const st2 = await erp.state();
      if (st2.tradeJun || st2.payJun || st2.rows > 0) return fatal('session_not_clear:trade ' + (st2.tradeJun || '') + ' pay ' + (st2.payJun || '') + ' rows ' + st2.rows);
      const tr = await erp.trade(client, clientName);
      const pool = ((tr && tr.sales) || []).map(bagKey);
      for (const ln of lines) {
        const k = bagKey(ln), at = pool.indexOf(k);
        if (at < 0) return fatal('sale_unverified:' + ln.barcode + ' ' + ln.amount);
        pool.splice(at, 1);
      }
      res.status = 'done'; return res;
    } catch (e) {
      return await fail('exception:' + errMsg(e));
    }
  }

  //  고객 순차 실행. fatal 이면 이후 전부 blocked. 한 고객의 예외는 fatal 결과로 담는다(던지지 않는다).
  async function slRunAll(plans, erp, hooks) {
    const out = []; let halted = false;
    for (const p of plans) {
      if (halted) { const r = slNewResult(p.key); r.status = 'blocked'; r.reason = 'halted'; out.push(r); continue; }
      let r;
      try { r = await slRunClient(p, erp, hooks); }
      catch (e) { r = slNewResult(p && p.key); r.status = 'fatal'; r.reason = 'exception:' + errMsg(e); }
      out.push(r);
      if (r.status === 'fatal') halted = true;
    }
    return out;
  }

  const api = { COLS, slHeaderMap, slMoney, slRound, slParseSheet, slComputeFinals, slIsReturn, slClientName, slAllocate, slGroupByClient, slMatchClient, slTradeUrl, slOrderRows, slSaleRows,
    SL_FORM10_NAMES, slComma, slReadSaleForm, slSaleManager, slModifyPayload, slCashPayload, slJunCheck, slJunPayload, slNewResult, slRunClient, slRunAll };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof globalThis !== 'undefined') { globalThis.ubSl = Object.assign(globalThis.ubSl || {}, api); }
})();
