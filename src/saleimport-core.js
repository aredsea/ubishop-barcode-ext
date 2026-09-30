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

  const api = { COLS, slHeaderMap, slMoney, slRound, slParseSheet, slComputeFinals, slIsReturn, slClientName, slAllocate, slGroupByClient, slMatchClient, slTradeUrl, slOrderRows, slSaleRows };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof globalThis !== 'undefined') { globalThis.ubSl = Object.assign(globalThis.ubSl || {}, api); }
})();
