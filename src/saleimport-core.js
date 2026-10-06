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
    //  합계 칸은 빈칸만 0 — 숫자로 못 읽는 값을 0 으로 두면 공제가 빠진 금액이 조용히 나간다(Task 1 검토 Minor).
    const raw = (k) => String(t[ix[k]] == null ? '' : t[ix[k]]).trim();
    const badTot = ['Y', 'Z', 'AA'].filter((k) => raw(k) !== '' && slMoney(raw(k)) == null);
    if (badTot.length) return { ok: false, error: '합계 행 금액을 읽을 수 없음: ' + badTot.map((k) => COLS[k]).join(', ') };
    const tot = (k) => (raw(k) === '' ? 0 : slMoney(raw(k)));
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
  //  suffix 기본 'G'(GS). 아몬즈처럼 파일에 수취인+연락처가 있는 마켓은 자기 접미를 넘긴다(§10.8).
  function slClientName(buyer, phone, suffix) {
    const d = String(phone == null ? '' : phone).replace(/\D/g, '');
    return String(buyer || '').trim() + (d.length >= 4 ? d.slice(-4) : '') + '/' + (suffix || 'G');
  }

  /* ------------------------------------------------------------ §3.2~3.3 매칭·배분 */
  function slAllocate(total, q) {
    const base = Math.floor(total / q);
    const out = new Array(q).fill(base);
    out[0] += total - base * q;
    return out;
  }
  //  §10.8 — 전부 반품된 주문번호 집합(단일 계산). 같은 orderNo 의 판매 금액 합 + 반품 금액 합이 0 이고 판매·반품 행이 모두 있으면(배송비·조정·time-·ledgerBlock 제외) 전부 반품.
  //  수동 목록 이름표(slClassifyRows)와 묶음 차단(slGroupByClient·slGroupLedger)이 이 한 곳을 쓴다.
  const FULL_RETURN_BLOCK = '전부 반품된 주문 — 판매 안 함(유비샵 주문은 직접 정리)';
  function slFullReturnSet(rows) {
    const by = new Map();
    (Array.isArray(rows) ? rows : []).forEach((r) => {
      const no = trimS(r.orderNo), lno = trimS(r.ledgerNo); if (!no) return;
      if (/^time-/.test(lno) || r.ledgerBlock) return;   // 자리표·모호 행은 서로 다른 결제가 한 번호를 공유할 수 있다
      if (r.isReturn && (slIsShipRow(r) || r.adjust)) return;
      const g = by.get(no) || { sale: 0, ret: 0, sum: 0 }; by.set(no, g);
      if (r.isReturn) g.ret++; else g.sale++;
      g.sum += Number(r.amount);
    });
    const out = new Set();
    by.forEach((g, no) => { if (g.sale && g.ret && g.sum === 0) out.add(no); });
    return out;
  }
  //  전부 반품된 주문의 판매 행이 든 묶음은 처음부터 차단(직접 고르기도 불가). 행은 빼지 않는다(seen·SPLIT_BUYER 방어 유지). 이미 다른 사유로 차단된 묶음은 그 사유를 둔다.
  const slNoList = (nos) => nos.length > 3 ? nos.slice(0, 3).join(', ') + ' 외 ' + (nos.length - 3) + '건' : nos.join(', ');
  function slBlockFullReturn(groups, full) {
    if (!full || !full.size) return groups;
    groups.forEach((g) => {
      const sale = [...new Set(g.rows.filter((r) => !r.isReturn).map((r) => trimS(r.orderNo)))];
      const fr = sale.filter((no) => full.has(no)), rest = sale.filter((no) => !full.has(no));
      if (!fr.length) return;
      //  같은 묶음에 판매해야 할 다른 주문이 있으면 '판매 안 함' 을 묶음 전체에 붙이지 않는다(주문번호를 이름 붙여 직접 처리하게 한다).
      if (!g.block) g.block = rest.length ? slNoList(fr) + ': 전부 반품 — 같은 묶음의 다른 주문(' + slNoList(rest) + ')은 판매해야 할 수 있음 — 직접 처리' : slNoList(fr) + ': ' + FULL_RETURN_BLOCK;
      g.pickable = false;
    });
    return groups;
  }
  function slGroupByClient(rows, adapter, opts) {
    const map = new Map();
    const p4 = !!adapter && adapter.clientRule === 'prefix4';
    rows.filter((r) => !(adapter ? r.isReturn : slIsReturn(r))).forEach((r) => {
      const key = p4 ? String(r.buyer || '').trim() + '/' + adapter.suffix : slClientName(r.buyer, r.phone, adapter && adapter.suffix);
      if (!map.has(key)) map.set(key, { key, rows: [], client: null, buyer: p4 ? String(r.buyer || '').trim() : undefined, source: p4 ? '이름 추정' : '파일 연락처' });
      map.get(key).rows.push(r);
    });
    return slBlockFullReturn([...map.values()], (opts && opts.full) || slFullReturnSet(rows));
  }
  //  §10.3 — 검색 결과 중 이 묶음의 고객 후보. exact: 이름 정확일치, prefix4: ^구매자\d{4}/접미$.
  const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameKey = (n) => norm(n).replace(/[A-Z]/g, (c) => c.toLowerCase());   // 공백 제거 + ASCII 소문자(한글은 그대로)
  function slClientCandidates(hits, group, adapter) {
    if (adapter && adapter.clientRule === 'prefix4') {
      const re = new RegExp('^' + reEsc(group.buyer) + '\\d{4}/' + reEsc(adapter.suffix) + '$', 'i');   // SSG 는 /s·/S 둘 다 있다(§10.5)
      return (hits || []).filter((h) => re.test(h.name));
    }
    //  이름 비교는 공백을 무시하고 ASCII 대소문자도 무시한다(원장 고객명 한정) — 'Ann Lee' 와 'AnnLee' 는 같은 이름(§10.8).
    if (adapter && adapter.ciSuffix) {   // 원장 고객명(§10.8) — 접두·접미 모두 공백·ASCII 대소문자 무시(SSG /s·/S)
      const cut = (n) => { const t = nameKey(n), i = t.lastIndexOf('/'); return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i + 1)]; };
      const [gp, gs] = cut(group.key);
      return (hits || []).filter((h) => { const [hp, hs] = cut(h.name); return hp === gp && hs === gs; });
    }
    return (hits || []).filter((h) => h.name === group.key);
  }
  //  §10.8 — 고객 검색어: 공백 제거(ubishop 은 'Ann Lee' 로 찾으면 붙여 쓴 'AnnLee' 를 못 찾는다).
  function slSearchWord(key) { return norm(key); }
  //  ubishop 검색은 부분 일치이고 공백을 무시하지 않는다('Ann Lee' 는 못 찾고 'AnnLee' 는 찾음) — 두 형태가 다르면 항상 둘 다 찾아 seq 로 합친다(한쪽만 받아들일 만하다고 일찍 끝내면 다른 형태의 동명이인 후보를 못 본다).
  //  첫 검색이 잘렸으면 그 자체로 차단 사유라 두 번째는 하지 않는다.
  async function slSearchMerged(search, key) {
    const orig = trimS(key), alt = slSearchWord(key);
    const r1 = await search(orig);
    if (!alt || alt === orig || (r1 && r1.truncated)) return r1;
    const r2 = await search(alt);
    const seen = new Set(), rows = [];
    [].concat(r1.rows || [], r2.rows || []).forEach((x) => { const k = String(x.seq); if (!seen.has(k)) { seen.add(k); rows.push(x); } });
    return { rows, truncated: !!(r1.truncated || r2.truncated) };
  }
  //  §10.8 폴백 — 같은 수령자가 다른 이름 형태(접미 없음·다른 접미·다른 뒤4자리)로 등록된 고객. 후보 = ^수령자\d{4}(/.*)?$ ("수령자/타인" 매장 행 제외).
  const SL_FALLBACK_MAX = 5;
  function slFallbackCandidates(hits, recipient) {
    const r = nameKey(recipient);
    if (!r) return [];
    const re = new RegExp('^' + reEsc(r) + '\\d{4}(/.*)?$');
    return (hits || []).filter((h) => re.test(nameKey(h.name)));
  }
  //  후보별 읽기 점검 결과 [{cand, result:{status,reason}}] → 자동은 'ok' 가 정확히 1명이고 나머지가 전부 'none'(주문내역을 읽었고 필요한 정산액 줄이 하나도 없음)일 때만.
  //  다른 후보가 점검 불가(미수금·고객 지정 실패)이거나 근거(sold)·차단(바코드 없는 줄 등)이 있으면 그 후보가 진짜 고객일 수 있으니 자동하지 않는다.
  function slFallbackDecide(results) {
    const list = Array.isArray(results) ? results : [];
    const st = (x) => (x.result && x.result.status) || '';
    const ok = list.filter((x) => st(x) === 'ok');
    const label = (x) => st(x) === 'ok' ? '주문 일치' : st(x) === 'none' ? '주문 없음' : (x.result && x.result.reason) || '맞지 않음';
    const sum = list.map((x) => x.cand.name + '(' + label(x) + ')').join(', ');
    if (!list.length) return { auto: null, reason: '' };
    if (ok.length === 1 && list.every((x) => x === ok[0] || st(x) === 'none')) return { auto: { seq: String(ok[0].cand.seq), name: ok[0].cand.name, result: ok[0].result }, reason: '' };
    if (ok.length === 1) return { auto: null, reason: '주문과 맞는 후보가 1명이지만 다른 이름 형태의 후보를 확인하지 못했거나 근거가 있음 — 직접 고르세요: ' + sum };
    if (ok.length > 1) return { auto: null, reason: '주문과 맞는 다른 이름 형태의 고객이 ' + ok.length + '명 — 직접 고르세요: ' + sum };
    return { auto: null, reason: '다른 이름 형태의 고객 후보 ' + list.length + '명이 모두 주문과 맞지 않음 — 직접 고르세요: ' + sum };
  }
  //  후보 점검용 — 주문내역을 읽었는데 이 묶음이 필요로 하는 정산액 줄이 하나도 없으면 true. 필요한 금액을 알 수 없으면(원장 없음·나누어지지 않음 등) false.
  function slProbeNone(rows, ledgerByOrder, orders, mode) {
    const list = orders || [];
    const amts = [];
    if (mode === 'ledger') {
      const getL = (no) => (ledgerByOrder instanceof Map ? ledgerByOrder.get(no) : (ledgerByOrder || {})[no]);
      for (const no of new Set((rows || []).map((r) => r.ledgerNo))) {
        const lr = no ? getL(no) : null;
        const items = (lr || []).filter((x) => !isGiftRow(x));
        if (!items.length) return false;
        for (const x of items) { const a = slMoney(x.amount); if (a == null || !Number.isInteger(a) || a <= 0) return false; amts.push(a); }
      }
    } else if (mode === 'perOrder') {
      for (const r of rows || []) amts.push(r.key);
    } else {
      for (const r of rows || []) { const u = r.W / r.qty; if (!Number.isInteger(u)) return false; amts.push(u); }
    }
    if (!amts.length) return false;
    return amts.every((a) => Number.isFinite(a) && !list.some((o) => !o.gift && o.settle === a));
  }
  //  고객 선택 방식 칩 — '주문 확인' 은 이름이 다른 고객을 주문으로 입증해 자동 선택한 것이라 직접 선택과 구별해 경고색으로 보인다.
  function slHowChip(how) {
    if (how === '자동') return { cls: 'reuse', text: '자동 매칭' };
    if (how === '주문 확인') return { cls: 'skipped', text: '자동 · 주문 확인(이름 다름)' };
    return { cls: 'gray', text: '직접 선택' };
  }
  //  evalCand(cand) → {status, reason} (읽기 전용 점검 — 호출자가 구현). 후보는 순차로 점검한다.
  async function slFallbackResolve(hits, recipient, evalCand) {
    const cands = slFallbackCandidates(hits, recipient);
    if (!cands.length) return { auto: null, reason: '', cands };
    if (cands.length > SL_FALLBACK_MAX) return { auto: null, reason: '후보가 너무 많음(' + cands.length + '명) — 직접 고르세요', cands };
    const results = [];
    for (const cand of cands) results.push({ cand, result: await evalCand(cand) });
    const d = slFallbackDecide(results);
    return { auto: d.auto, reason: d.reason, cands };
  }
  //  자동 확정 판정(§10.3) — 검색이 100건에서 잘렸으면 후보를 신뢰할 수 없으므로 자동 확정하지 않는다.
  function slAutoDecision(res, group, adapter) {
    const p4 = !!adapter && adapter.clientRule === 'prefix4';
    if (res && res.truncated) return { auto: null, reason: '검색 결과가 100건 이상 — 직접 고르세요' };
    const cands = slClientCandidates(res && res.hits, group, adapter);
    if (cands.length === 1) return { auto: { seq: String(cands[0].seq), name: cands[0].name }, reason: '' };
    if (cands.length > 1) return { auto: null, reason: '같은 이름의 고객이 ' + cands.length + '명 — 아래에서 직접 고르세요' };
    const what = p4 ? '"' + group.buyer + '○○○○/' + adapter.suffix + '" 형태' : '"' + group.key + '"';
    return { auto: null, reason: '유비샵에 ' + what + ' 고객이 없음 — 아래에서 직접 찾아 고르세요' };
  }
  //  묶음 간 겹침 — ok 묶음끼리 같은 바코드를 잡았으면(고객이 달라도) 둘 다 돌려준다.
  function slOverlaps(entries) {
    const owner = new Map(), out = new Set();
    (entries || []).filter((e) => e && e.st === 'ok' && e.match).forEach((e) => {
      (e.match.lines || []).forEach((l) => {
        if (!l.barcode) return;
        if (owner.has(l.barcode) && owner.get(l.barcode) !== e.key) { out.add(e.key); out.add(owner.get(l.barcode)); }
        else owner.set(l.barcode, e.key);
      });
    });
    return out;
  }
  //  §10.4 — 비율 배분: 각 floor(total*w/Σw), 나머지 원은 첫 칸. Σw ≤ 0 이면 null.
  function slAllocateByWeight(total, weights) {
    if (weights.some((w) => !Number.isFinite(w) || w < 0)) return null;
    const sum = weights.reduce((s, w) => s + w, 0);
    if (!(sum > 0)) return null;
    const out = weights.map((w) => Math.floor(total * w / sum));
    out[0] += total - out.reduce((s, x) => s + x, 0);
    return out;
  }
  //  §10.4 perOrder — 정산 N = 결제 전체 금액이라 그 결제의 모든 줄에 같은 값이 붙는다.
  function matchPerOrder(rows, orders, sold, block) {
    const seen = new Set();
    for (const r of rows) {
      if (seen.has(r.key)) return block('같은 정산 ' + r.key.toLocaleString('en-US') + ' 결제가 2건 — 어느 줄인지 모름');
      seen.add(r.key);
    }
    const lines = [], usedDates = new Set();
    let soldOnly = true;
    for (const r of rows) {
      if (!(r.amount > 0)) return block(r.orderNo + ': 실판매가가 0 이하');
      const mains = orders.filter((o) => !o.gift && o.settle === r.key);
      const open = mains.filter((o) => !o.barcode || !sold.has(o.barcode));
      if (open.length === 0 && mains.length > 0) continue;               // 이미 판매됨
      if (open.length > 0 && mains.length > open.length) return block('정산 ' + r.key.toLocaleString('en-US') + ' 결제 일부만 판매됨 — 직접 처리');
      soldOnly = false;
      if (open.length === 0) return block('정산 ' + r.key.toLocaleString('en-US') + ' 주문 줄 없음');
      if (open.some((o) => !o.barcode)) return block('바코드 없는 주문 줄 — 입고 확인');
      //  같은 정산(결제 금액)이 서로 다른 주문의 줄에 걸쳐 있으면 한 결제로 묶을 수 없다.
      const dates = [...new Set(open.map((o) => o.date))];
      if (dates.length > 1) return block('정산 ' + r.key.toLocaleString('en-US') + ' 줄이 여러 주문일(' + dates.join(', ') + ')에 걸침 — 직접 처리');
      if (open.some((o) => o.cancel)) return block('주문 비고에 취소 표시가 있는 줄 — 직접 처리');
      if (open.some((o) => !o.code)) return block('상품번호를 못 읽은 주문 줄 — 직접 처리');
      //  파일 상품명 '…외N건' → 상품 N+1종(§10.7). N≥1 이면 줄 수가 정확히 N+1 이고 상품번호가 모두 달라야 한다(같은 날 묶음을 두 번 산 경우 차단).
      //  N=0 이면 상품번호가 하나여야 한다(같은 상품 여러 줄은 수량 — 허용).
      const mm = /외(\d+)건$/.exec(String(r.name == null ? '' : r.name).trim());
      const want = (mm ? Number(mm[1]) : 0) + 1;
      const have = new Set(open.map((o) => o.code)).size;
      if (want > 1 ? (open.length !== want || have !== want) : have !== 1) return block('상품 수 불일치(파일 ' + want + '종 · 주문 줄 ' + (want > 1 ? open.length + '줄/' : '') + have + '종) — 직접 처리');
      const amts = slAllocateByWeight(r.amount, open.map((o) => o.price));
      if (!amts) return block(r.orderNo + ': 주문가 합계가 0 — 배분 불가');
      open.forEach((o, i) => {
        lines.push({ barcode: o.barcode, code: o.code, name: o.name, gift: false, orderNo: r.orderNo, amount: amts[i] });
        usedDates.add(o.date);
      });
    }
    if (soldOnly) return { status: 'sold', reason: '이미 판매됨', lines: [], cash: 0 };
    orders.filter((o) => o.gift && o.barcode && !sold.has(o.barcode) && usedDates.has(o.date))
      .forEach((o) => lines.push({ barcode: o.barcode, code: o.code, name: o.name, gift: true, orderNo: '', amount: 0 }));
    return { status: 'ok', reason: '', lines, cash: lines.reduce((s, l) => s + l.amount, 0) };
  }
  //  고객 한 명: 같은 단가(W/qty) 끼리 필요 개수를 모아, 판매 안 된 본품 줄이 **정확히 그 개수**일 때만 자동.
  function slMatchClient(rows, orders, sales, mode) {
    const sold = new Set((sales || []).map((s) => s.barcode).filter(Boolean));
    const block = (reason) => ({ status: 'block', reason, lines: [], cash: 0 });
    if (mode === 'perOrder') return matchPerOrder(rows, orders, sold, block);
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
      if (open.some((o) => o.cancel)) return block('주문 비고에 취소 표시가 있는 줄 — 직접 처리');
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

  /* ------------------------------------------------------------ §10.8 아틀리에 원장 */
  const digitsOf = (v) => String(v == null ? '' : v).replace(/\D/g, '');
  const trimS = (v) => String(v == null ? '' : v).trim();
  const isGiftRow = (x) => x && (x.is_gift === true || x.is_gift === 1 || x.is_gift === 'true' || x.is_gift === 't');
  //  원장 행 → 주문번호별 Map. market 이 다른 행은 버린다(다른 마켓의 같은 번호와 섞이지 않게).
  function slLedgerIndex(rows, market) {
    const idx = new Map();
    (Array.isArray(rows) ? rows : []).forEach((x) => {
      if (!x || trimS(x.market) !== market) return;
      const no = trimS(x.order_no);
      if (!no) return;
      if (!idx.has(no)) idx.set(no, []);
      idx.get(no).push(x);
    });
    return idx;
  }
  //  §10.9 시각 연결 — 파일 행(paidAt ms)마다 원장 주문(order_no 숫자값 = 주문 시각 ms, 서로 다른 번호)을 찾는다.
  //  주문은 결제보다 먼저 만들어지므로 한쪽 창만 본다: paidAt − windowMs ≤ 주문 시각 ≤ paidAt + 5초.
  //  정확히 1개 → { no }, 0개 → { absent: true }, 2개 이상 → { ambiguous: true }. 행과 같은 순서의 배열을 돌려준다(순수 함수).
  const TIME_AFTER_MS = 5000;
  function slLedgerIndexByTime(rows, ledgerRows, windowMs) {
    const w = windowMs == null ? 60000 : windowMs;
    const times = new Map();
    (Array.isArray(ledgerRows) ? ledgerRows : []).forEach((x) => {
      const no = trimS(x && x.order_no);
      if (/^\d{9,}$/.test(no)) times.set(no, Number(no));
    });
    return (Array.isArray(rows) ? rows : []).map((r) => {
      const hit = [...times].filter(([, t]) => Number.isFinite(r.paidAt) && t >= r.paidAt - w && t <= r.paidAt + TIME_AFTER_MS).map(([no]) => no);
      return hit.length === 1 ? { no: hit[0] } : hit.length ? { ambiguous: true } : { absent: true };
    });
  }
  //  slLedgerIndexByTime 결과를 행에 입힌 새 행 배열. 없음 → 자리표 번호(원장 색인에 없으니 '원장에 없는 주문' 으로 차단), 모호 → ledgerBlock(차단).
  //  연결된 원장 주문마다 추가 검사(전부 fail-closed 차단):
  //   ① 연결된 파일 행의 결제 시각이 둘 이상이거나 상품 주문 번호가 겹치면 서로 다른 결제가 섞인 것
  //   ② 원장 본품 금액 합 L 이 Σ정산금 ≤ L ≤ Σ(결제 금액 + 프로모션 지원금) 범위 밖이면 남의 주문일 수 있다
  const AMBIG_TIME = '결제 시각이 가까운 주문이 여러 건 — 직접 처리';
  const MIXED_PAY = '서로 다른 결제가 한 원장 주문에 연결됨 — 직접 처리';
  const AMT_RANGE = '원장 금액이 결제 금액과 맞지 않음 — 직접 처리';
  function slApplyTimeLedger(rows, ledgerRows, windowMs) {
    const res = slLedgerIndexByTime(rows, ledgerRows, windowMs);
    const out = rows.map((r, i) => Object.assign({}, r, res[i].no ? { ledgerNo: res[i].no } : { ledgerNo: 'time-' + r.paidAt, ledgerBlock: res[i].ambiguous ? AMBIG_TIME : '' }));
    const byNo = new Map();
    out.forEach((r, i) => { if (res[i].no) { if (!byNo.has(res[i].no)) byNo.set(res[i].no, []); byNo.get(res[i].no).push(r); } });
    byNo.forEach((frs, no) => {
      let why = '';
      if (new Set(frs.map((r) => r.paidAt)).size > 1 || new Set(frs.map((r) => r.orderNo)).size < frs.length) why = MIXED_PAY;
      else {
        const sale = frs.filter((r) => !r.isReturn);
        const amts = (Array.isArray(ledgerRows) ? ledgerRows : []).filter((x) => x && trimS(x.order_no) === no && !isGiftRow(x)).map((x) => slMoney(x.amount));
        if (sale.length && ![...sale.map((r) => r.amount), ...sale.map((r) => r.payTotal)].every(Number.isFinite)) why = AMT_RANGE;
        else if (sale.length) {
          if (!amts.length || amts.some((a) => a == null || !Number.isInteger(a))) why = AMT_RANGE;
          else {
            const L = amts.reduce((a, b) => a + b, 0), lo = sale.reduce((a, r) => a + r.amount, 0), hi = sale.reduce((a, r) => a + r.payTotal, 0);
            if (L < lo || L > hi) why = AMT_RANGE;
          }
        }
      }
      if (why) frs.forEach((r) => { r.ledgerBlock = why; });
    });
    return out;
  }
  //  한 주문의 원장 행들 → 고객명({name, recipient}) 또는 차단({block}). 이름 = 수령자+전화 뒤4+/접미(주문 가져오기 규칙).
  function slLedgerClient(orderRows, adapter) {
    const rows = Array.isArray(orderRows) ? orderRows : [];
    if (!rows.length) return { block: '원장에 없는 주문' };
    if (rows.some((x) => /취소/.test(trimS(x.status)))) return { block: '원장 상태에 취소 — 직접 처리' };
    const rec = new Set(rows.map((x) => trimS(x.recipient))), ph = new Set(rows.map((x) => digitsOf(x.phone)));
    if (rec.size > 1 || ph.size > 1) return { block: '원장 수령자 불일치 — 직접 처리' };
    const recipient = [...rec][0], d = [...ph][0];
    if (!recipient) return { block: '원장 수령자 이름 없음 — 직접 처리' };
    if (d.length < 4) return { block: '원장 전화번호 없음 — 직접 처리' };
    return { name: recipient + d.slice(-4) + '/' + adapter.suffix, recipient };
  }
  //  파일 행 → 묶음. 원장에서 찾으면 원장 고객명으로, 못 찾으면 어댑터 기존 규칙(clientRule 'ledger' 는 차단).
  //  idx = null 이면 열쇠 없음(기존 폴백). opts.lookupFailed = 열쇠가 있는데 조회가 실패 → 원장 연동 행은 전부 차단(폴백 없음).
  //  idx 가 있는데 원장 번호 형식이 틀린 행도 조용히 빠지지 않고 차단한다.
  //  group = { key, rows, source, ledger: Map(주문번호→원장 행), retOrders: Set, retFull: Set, block, pickable }
  const SPLIT_BUYER = '같은 구매자의 결제 일부만 원장에서 확인됨 — 직접 처리';
  const LEDGER_NO_RE = /^[A-Za-z0-9-]{4,40}$/;
  function slGroupLedger(rows, adapter, idx, opts) {
    const failed = !!(opts && opts.lookupFailed), keyed = failed || !!idx;
    const full = slFullReturnSet(rows);
    const map = new Map();
    const add = (key, init, r) => { if (!map.has(key)) map.set(key, Object.assign({ key, rows: [], client: null, ledger: new Map(), block: '', pickable: false }, init)); map.get(key).rows.push(r); return map.get(key); };
    const retOrders = new Set(rows.filter((r) => r.isReturn && r.ledgerNo).map((r) => r.ledgerNo));
    //  retFull = retOrders 중 판매 행이 있는 모든 orderNo 가 자기 반품과 짝지어 합 0 인 것(배송비·조정 제외, 수동 목록 이름표와 같은 규칙) — 차단 사유를 '전부 반품된 주문' 으로 구분한다. 판매 행은 그대로 둔다.
    const retFull = new Set();
    retOrders.forEach((no) => {
      if (/^time-/.test(no)) return;
      const g = rows.filter((r) => r.ledgerNo === no && !r.ledgerBlock && !(r.isReturn && (slIsShipRow(r) || r.adjust)));
      const per = new Map();   // 주문번호(orderNo)별 — 판매 행이 있는 모든 orderNo 가 자기 반품과 짝지어 합 0 이어야 '전부 반품'(수동 목록 이름표와 같은 규칙)
      g.forEach((r) => { const k = trimS(r.orderNo), x = per.get(k) || { sale: 0, ret: 0, sum: 0 }; per.set(k, x); if (r.isReturn) x.ret++; else x.sale++; x.sum += Number(r.amount); });
      const sold = [...per.values()].filter((x) => x.sale);
      if (sold.length && sold.every((x) => x.ret && x.sum === 0)) retFull.add(no);
    });
    //  구매자 비교는 띄어쓰기·대소문자를 무시한다 — '고객C'·'고객 C'·'Kim'·'KIM' 이 갈려 규칙6 이 빠지지 않게(Opus 5R Nit-1).
    const buyerKey = (v) => norm(v).toLowerCase();
    const rest = [], ledgerBuyers = new Map();
    rows.filter((r) => !r.isReturn).forEach((r) => {
      const hard = (key, block) => add(key + (r.ledgerNo || r.orderNo), { source: '', buyer: trimS(r.buyer), retOrders, retFull, block }, r);
      if (failed) { hard('원장 조회 실패 ', '원장 조회 실패 — 다시 시도하세요'); return; }
      if (r.ledgerBlock) { hard('원장 시각 모호 ', r.ledgerBlock); return; }
      if (keyed && !LEDGER_NO_RE.test(trimS(r.ledgerNo))) { hard('원장 번호 오류 ', '원장 번호 형식 오류'); return; }
      const lr = idx && r.ledgerNo ? idx.get(r.ledgerNo) : null;
      if (lr && lr.length) {
        const cl = slLedgerClient(lr, adapter);
        const lg = cl.name ? add(cl.name, { source: '원장', buyer: cl.recipient, retOrders, retFull }, r) : null;
        if (lg) lg.ledger.set(r.ledgerNo, lr);
        if (trimS(r.buyer)) { const b = buyerKey(r.buyer); if (!ledgerBuyers.has(b)) ledgerBuyers.set(b, new Set()); if (lg) ledgerBuyers.get(b).add(lg); }
        if (!lg) add('원장 주문 ' + r.ledgerNo, { source: '원장', buyer: '', retOrders, retFull, block: cl.block }, r);
      } else rest.push(r);
    });
    if (adapter.clientRule === 'ledger') {
      rest.forEach((r) => add('원장 없음 ' + (r.ledgerNo || r.orderNo), { source: '', buyer: trimS(r.buyer), retOrders, retFull, block: '원장에 없는 주문 — 직접 처리하세요' }, r));
    } else {
      slGroupByClient(rest, adapter, { full }).forEach((g) => {
        //  같은 구매자의 결제 일부만 원장에서 확인됐으면 서로 다른 고객일 수 있다 — 그 구매자의 묶음을 전부(원장 묶음 포함) 차단.
        const split = adapter.clientRule === 'prefix4' && g.buyer && ledgerBuyers.has(buyerKey(g.buyer));
        if (split) ledgerBuyers.get(buyerKey(g.buyer)).forEach((lg) => { if (!lg.block) lg.block = SPLIT_BUYER; });
        const m = add(g.key, { source: g.source, buyer: g.buyer, retOrders, retFull, block: split ? SPLIT_BUYER : '' }, g.rows[0]);
        g.rows.slice(1).forEach((r) => m.rows.push(r));
      });
    }
    return slBlockFullReturn([...map.values()], full);
  }
  //  §10.8 — 행 분류. isReturn 행은 전부 수동 목록(구분: 반품 / 배송비 / 조정). 판매 행은 절대 빼지 않는다 — 빼면 같은 결제 중복 정산 방어(matchPerOrder 의 seen·SPLIT_BUYER)가 사라진다.
  //  같은 주문번호(orderNo)의 판매 금액 합 + 반품 금액 합이 0 이면(배송비·조정 제외) 그 반품 행에 '전부 반품' 이름표만 붙인다. 합이 0 이 아닌 부분 반품은 기존 구분 그대로.
  const FULL_RETURN_NOTE = '판매 행도 차단됨 — 유비샵 주문은 직접 정리';
  const slIsShipRow = (r) => /배송비|배송료/.test(String(r.name || ''));
  //  표시 구분 — 배송비 이름 > 조정 > 파서가 남긴 자기 구분값(스마트스토어 구분·퀸잇 거래유형) > 반품. 전부 반품 합산은 slIsShipRow·adjust 로만 가른다.
  function slRowKind(r) { return slIsShipRow(r) ? '배송비' : r.adjust ? '조정' : r.kindHint ? String(r.kindHint) : '반품'; }
  function slClassifyRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const fullSet = slFullReturnSet(list);
    const full = (r) => fullSet.has(trimS(r.orderNo));
    const manual = [];
    list.forEach((r) => {
      if (!r.isReturn) return;
      if (full(r) && !slIsShipRow(r) && !r.adjust && !/^time-/.test(trimS(r.ledgerNo)) && !r.ledgerBlock) manual.push(Object.assign({}, r, { kind: '전부 반품', note: FULL_RETURN_NOTE }));
      else manual.push(Object.assign({}, r, { kind: slRowKind(r), note: '' }));
    });
    return { rows: list.slice(), manual };
  }
  //  어떤 매칭 규칙으로 줄을 찾나 — 원장 줄 매칭(ledgerMatch: 쿠팡·퀸잇)이고 원장에서 찾은 묶음이면 'ledger', 아니면 어댑터 고유 모드.
  function slMatchModeFor(adapter, viaLedger) { return (viaLedger && adapter.ledgerMatch) ? 'ledger' : adapter.matchMode; }
  //  §10.8 원장 매칭 — 기대 줄 = 원장의 사은품 아닌 행들(열쇠 = 그 행 amount = 유비샵 비고 정산 N).
  //  실판매가 = 파일의 그 주문 최종 금액 합을 원장 amount 비율로 배분(floor, 나머지 첫 줄). 사은품은 0원. opts.retOrders = 같은 주문에 반품 행이 있는 주문번호.
  function slMatchLedger(rows, ledgerByOrder, orders, sales, opts) {
    const sold = new Set((sales || []).map((s) => s.barcode).filter(Boolean));
    const block = (reason) => ({ status: 'block', reason, lines: [], cash: 0 });
    const retOrders = (opts && opts.retOrders) || new Set(), retFull = (opts && opts.retFull) || new Set();
    const getL = (no) => (ledgerByOrder instanceof Map ? ledgerByOrder.get(no) : (ledgerByOrder || {})[no]);
    const byNo = new Map();
    for (const r of rows || []) {
      if (!r.ledgerNo) return block(r.orderNo + ': 원장 주문번호 없음');
      if (!(r.amount > 0)) return block(r.orderNo + ': 실판매가가 0 이하');
      if (!byNo.has(r.ledgerNo)) byNo.set(r.ledgerNo, []);
      byNo.get(r.ledgerNo).push(r);
    }
    if (!byNo.size) return block('파일 행 없음');
    const need = new Map();   // 금액 → [{no, orderNo, share}]
    for (const [no, frs] of byNo) {
      if (retOrders.has(no)) return block(no + (retFull.has(no) ? ': ' + FULL_RETURN_BLOCK : ': 같은 주문에 반품·제외 행이 있음 — 직접 처리'));
      const lr = getL(no);
      if (!lr || !lr.length) return block(no + ': 원장에 없는 주문');
      const items = lr.filter((x) => !isGiftRow(x));
      if (!items.length) return block(no + ': 원장에 본품 줄이 없음');
      const amts = items.map((x) => slMoney(x.amount));
      if (amts.some((a) => a == null || !Number.isInteger(a) || a <= 0)) return block(no + ': 원장 금액을 읽을 수 없음');
      //  파일 합 F 와 원장 합 L 이 행 수(원)보다 더 벌어지면 이 파일은 그 주문의 일부만 정산한 것일 수 있다.
      const F = frs.reduce((s, r) => s + r.amount, 0), L = amts.reduce((s, a) => s + a, 0);
      if (opts && opts.amountCheck === 'count') {   // §10.9 에이블리 — 금액 기준이 달라 행 수로 부분 정산을 막는다
        if (frs.length !== items.length) return block(no + ': 파일 상품 수 ≠ 원장 상품 수 — 주문 일부만 정산됐을 수 있음');
      } else if (Math.abs(F - L) > frs.length) return block(no + ': 파일 금액 ' + F.toLocaleString('en-US') + ' ≠ 원장 ' + L.toLocaleString('en-US') + ' — 주문 일부만 정산됐을 수 있음');
      const shares = slAllocateByWeight(F, amts);
      if (!shares) return block(no + ': 배분 불가');
      amts.forEach((a, i) => { if (!need.has(a)) need.set(a, []); need.get(a).push({ no, orderNo: frs[0].orderNo, share: shares[i] }); });
    }
    //  서로 다른 두 주문이 같은 정산액이면 어느 줄이 어느 주문인지 알 수 없다(한 주문 안의 같은 금액은 허용).
    for (const [, list] of need) {
      const nos = new Set(list.map((x) => x.no));
      if (nos.size > 1) return block('같은 정산액 주문이 ' + nos.size + '건 — 어느 줄인지 모름');
    }
    const lines = [], usedDates = new Set(), noDates = new Map();
    let soldOnly = true;
    for (const [a, list] of need) {
      const n = list.length;
      const mains = orders.filter((o) => !o.gift && o.settle === a);
      const open = mains.filter((o) => !o.barcode || !sold.has(o.barcode));
      if (open.length === 0 && mains.length >= n) continue;             // 전부 이미 판매됨
      soldOnly = false;
      if (open.some((o) => o.cancel)) return block('주문 비고에 취소 표시가 있는 줄 — 직접 처리');
      if (open.length !== n) return block('정산 ' + a.toLocaleString('en-US') + ' 주문 줄 ' + open.length + '개 (필요 ' + n + '개)');
      if (open.some((o) => !o.barcode)) return block('바코드 없는 주문 줄 — 입고 확인');
      const dates = [...new Set(open.map((o) => o.date))];
      if (dates.length > 1) return block('정산 ' + a.toLocaleString('en-US') + ' 줄이 여러 주문일(' + dates.join(', ') + ')에 걸침 — 직접 처리');
      list.forEach((x, k) => {
        const o = open[k];
        lines.push({ barcode: o.barcode, code: o.code, name: o.name, gift: false, orderNo: x.orderNo, ledgerNo: x.no, amount: x.share });
        usedDates.add(o.date);
        if (!noDates.has(x.no)) noDates.set(x.no, new Set());
        noDates.get(x.no).add(o.date);
      });
    }
    for (const [no, ds] of noDates) if (ds.size > 1) return block(no + ': 한 주문의 줄이 여러 주문일에 걸침 — 직접 처리');
    if (soldOnly) return { status: 'sold', reason: '이미 판매됨', lines: [], cash: 0 };
    orders.filter((o) => o.gift && o.barcode && !sold.has(o.barcode) && usedDates.has(o.date))
      .forEach((o) => lines.push({ barcode: o.barcode, code: o.code, name: o.name, gift: true, orderNo: '', amount: 0 }));
    return { status: 'ok', reason: '', lines, cash: lines.reduce((s, l) => s + l.amount, 0) };
  }

  /* ------------------------------------------------------------ §10 마켓 어댑터 */
  function parseGs(rows) {
    const f = slComputeFinals(slParseSheet(rows));
    if (!f.ok) return { ok: false, error: f.error };
    return { ok: true, rows: f.rows.map((r) => ({ r: r.r, orderNo: r.orderNo, buyer: r.buyer, phone: r.phone, qty: r.qty, W: r.W, key: r.W, amount: r.amount,
      isReturn: slIsReturn(r), name: r.name, option: r.option })) };
  }
  const INI_COLS = ['주문번호', '구매자', '상품명', '거래금액', '지급액', '상태'];
  function parseInicis(rows) {
    const h = (rows[0] || []).map(norm);
    const ix = {}; INI_COLS.forEach((c) => { ix[c] = h.indexOf(c); });
    const miss = INI_COLS.filter((c) => ix[c] < 0);
    if (miss.length) return { ok: false, error: '필수 열 없음: ' + miss.join(', ') };
    const cell = (r, c) => String(r[ix[c]] == null ? '' : r[ix[c]]).trim();
    const tIdx = rows.findIndex((r, i) => i > 0 && String((r || [])[0] == null ? '' : r[0]).trim() === '합계');
    if (tIdx < 0) return { ok: false, error: '합계 행 없음' };
    const out = []; let sum = 0;
    for (let i = 1; i < tIdx; i++) {
      const r = rows[i] || [];
      const orderNo = cell(r, '주문번호');
      if (!orderNo) continue;
      const pay = slMoney(cell(r, '지급액'));
      if (pay == null || !Number.isInteger(pay)) return { ok: false, error: orderNo + ': 지급액을 읽을 수 없음' };
      const gross = slMoney(cell(r, '거래금액'));
      sum += pay;
      out.push({ r: i, orderNo, ledgerNo: orderNo, buyer: cell(r, '구매자'), phone: '', qty: null, key: pay, amount: pay,
        isReturn: (gross != null && gross < 0) || /취소/.test(cell(r, '상태')), name: cell(r, '상품명'), option: '' });
    }
    if (!out.length) return { ok: false, error: '데이터 행 없음' };
    const total = slMoney(cell(rows[tIdx], '지급액'));
    if (total == null || total !== sum) return { ok: false, error: '검산 불일치' };
    return { ok: true, rows: out };
  }
  //  §10.5 SSG — 한 행 = 주문 줄 하나. 합계 행 없음. 정산금액(VAT포함) 그대로.
  const SSG_COLS = ['주문ID', '주문순번', '주문자명', '상품명', '수량', '정산금액(VAT포함)'];
  function parseSsg(rows) {
    const h = (rows[0] || []).map(norm);
    const ix = {}; SSG_COLS.concat(['단품']).forEach((c) => { ix[c] = h.indexOf(norm(c)); });
    const miss = SSG_COLS.filter((c) => ix[c] < 0);
    if (miss.length) return { ok: false, error: '필수 열 없음: ' + miss.join(', ') };
    const cell = (r, c) => (ix[c] < 0 ? '' : String(r[ix[c]] == null ? '' : r[ix[c]]).trim());
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const id = cell(r, '주문ID');
      if (!id) continue;
      const orderNo = id + '-' + cell(r, '주문순번');
      const pay = slMoney(cell(r, '정산금액(VAT포함)')), qty = slMoney(cell(r, '수량'));
      if (pay == null || !Number.isInteger(pay)) return { ok: false, error: orderNo + ': 정산금액을 읽을 수 없음' };
      if (qty == null || !Number.isInteger(qty) || qty === 0) return { ok: false, error: orderNo + ': 수량을 읽을 수 없음' };
      if (!cell(r, '주문자명')) return { ok: false, error: orderNo + ': 주문자명 없음' };
      out.push({ r: i, orderNo, ledgerNo: id, buyer: cell(r, '주문자명'), phone: '', qty, W: pay, key: pay, amount: pay,   // W: perUnit 매칭이 읽는 단가 원천(GS 와 같은 이름)
        isReturn: qty < 0 || pay < 0, name: cell(r, '상품명'), option: cell(r, '단품') });
    }
    if (!out.length) return { ok: false, error: '데이터 행 없음' };
    return { ok: true, rows: out };
  }
  //  §10.6 스마트스토어 — key = amount = A+B+C+D(수수료는 음수). D 열은 없을 수 있고, 빈칸은 0, 숫자가 아니면 파일 거부.
  const SMART_COLS = ['상품주문번호', '구분', '상품명', '구매자명', '정산기준금액(A)', 'Npay 수수료(B)', '매출연동 수수료 합계(C)'];
  function parseSmartstore(rows) {
    const h = (rows[0] || []).map(norm);
    const ix = {}; SMART_COLS.concat(['무이자할부 수수료(D)']).forEach((c) => { ix[c] = h.indexOf(norm(c)); });
    const miss = SMART_COLS.filter((c) => ix[c] < 0);
    if (miss.length) return { ok: false, error: '필수 열 없음: ' + miss.join(', ') };
    const cell = (r, c) => (ix[c] < 0 ? '' : String(r[ix[c]] == null ? '' : r[ix[c]]).trim());
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      if (!r.some((v) => String(v == null ? '' : v).trim() !== '')) continue;
      const orderNo = cell(r, '상품주문번호');
      if (!orderNo) return { ok: false, error: i + '행: 상품주문번호 없음' };
      const parts = {};
      for (const c of ['정산기준금액(A)', 'Npay 수수료(B)', '매출연동 수수료 합계(C)', '무이자할부 수수료(D)']) {
        const raw = cell(r, c);
        const v = raw === '' ? 0 : slMoney(raw);
        if (v == null || !Number.isInteger(v)) return { ok: false, error: orderNo + ': ' + c + ' 를 읽을 수 없음' };
        parts[c] = v;
      }
      const sum = parts['정산기준금액(A)'] + parts['Npay 수수료(B)'] + parts['매출연동 수수료 합계(C)'] + parts['무이자할부 수수료(D)'];
      const isItem = cell(r, '구분') === '상품주문';
      if (isItem && !cell(r, '구매자명')) return { ok: false, error: orderNo + ': 구매자명 없음' };
      out.push({ r: i, orderNo, buyer: cell(r, '구매자명'), phone: '', qty: 1, W: sum, key: sum, amount: sum,
        isReturn: !isItem || parts['정산기준금액(A)'] < 0, name: cell(r, '상품명'), option: '', kindHint: isItem ? '' : cell(r, '구분') });
    }
    if (!out.length) return { ok: false, error: '데이터 행 없음' };
    return { ok: true, rows: out };
  }
  //  표 공통: 헤더 이름(공백 무시)으로 열을 찾는다. 빠진 열이 있으면 {error}.
  function colsOf(rows, need, opt) {
    const h = (rows[0] || []).map(norm), ix = {};
    need.concat(opt || []).forEach((c) => { ix[c] = h.indexOf(norm(c)); });
    const miss = need.filter((c) => ix[c] < 0);
    if (miss.length) return { error: '필수 열 없음: ' + miss.join(', ') };
    return { cell: (r, c) => (ix[c] < 0 ? '' : String(r[ix[c]] == null ? '' : r[ix[c]]).trim()) };
  }
  const blankRow = (r) => !(r || []).some((v) => String(v == null ? '' : v).trim() !== '');
  const intOrNull = (raw) => { const v = raw === '' ? 0 : slMoney(raw); return v == null || !Number.isInteger(v) ? null : v; };
  //  §10.8 쿠팡 — 옵션 ID 가 '<' 로 시작하는 행(<기본배송료>…)은 처리 대상이 아니다. 정산금액 0 이면 버리고, 0 이 아니면 수동 목록.
  //  환불수량은 음수로 오기도 한다(실측 -1) → 0 이 아니면 반품.
  const CP_COLS = ['주문번호', '옵션 ID', '상품명', '옵션명', '판매수량', '환불수량', '정산금액', '구매자명'];
  function parseCoupang(rows) {
    const c = colsOf(rows, CP_COLS); if (c.error) return { ok: false, error: c.error };
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || []; if (blankRow(r)) continue;
      const no = c.cell(r, '주문번호'), opt = c.cell(r, '옵션 ID');
      if (!no) return { ok: false, error: i + '행: 주문번호 없음' };
      const pay = intOrNull(c.cell(r, '정산금액'));
      if (pay == null) return { ok: false, error: no + ': 정산금액을 읽을 수 없음' };
      const shipping = opt.charAt(0) === '<';
      if (shipping && pay === 0) continue;
      const qty = intOrNull(c.cell(r, '판매수량')), refund = intOrNull(c.cell(r, '환불수량'));
      if (qty == null || refund == null) return { ok: false, error: no + ': 수량을 읽을 수 없음' };
      out.push({ r: i, orderNo: no + '-' + opt, ledgerNo: no, buyer: c.cell(r, '구매자명'), phone: '', qty, key: pay, amount: pay,
        isReturn: shipping || refund !== 0 || pay < 0, name: shipping ? opt : c.cell(r, '상품명'), option: c.cell(r, '옵션명') });
    }
    if (!out.length) return { ok: false, error: '데이터 행 없음' };
    return { ok: true, rows: out };
  }
  //  §10.8 퀸잇 — 거래유형 '상품 구매' 만 처리. ledgerNo = 주문번호(개별주문번호 아님). 정산상태는 note 로 보인다.
  const QN_COLS = ['주문번호', '개별주문번호', '거래유형', '상품명', '옵션명', '수량', '정산금액(A-B-C+D)'];
  function parseQueenit(rows) {
    const c = colsOf(rows, QN_COLS, ['정산상태']); if (c.error) return { ok: false, error: c.error };
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || []; if (blankRow(r)) continue;
      const id = c.cell(r, '개별주문번호'), no = c.cell(r, '주문번호');
      if (!id || !no) return { ok: false, error: i + '행: 주문번호 없음' };
      const pay = intOrNull(c.cell(r, '정산금액(A-B-C+D)')), qty = intOrNull(c.cell(r, '수량'));
      if (pay == null) return { ok: false, error: id + ': 정산금액을 읽을 수 없음' };
      if (qty == null) return { ok: false, error: id + ': 수량을 읽을 수 없음' };
      const st = c.cell(r, '정산상태'), tt = c.cell(r, '거래유형');
      out.push({ r: i, orderNo: id, ledgerNo: no, buyer: '', phone: '', qty, key: pay, amount: pay,
        isReturn: c.cell(r, '거래유형') !== '상품 구매' || pay < 0, name: c.cell(r, '상품명'), option: c.cell(r, '옵션명'), note: st ? '정산상태 ' + st : '', kindHint: tt !== '상품 구매' ? tt : '' });
    }
    if (!out.length) return { ok: false, error: '데이터 행 없음' };
    return { ok: true, rows: out };
  }
  //  §10.8 아몬즈 — 구분에 '배송비' 가 든 행은 제외(수동 목록). 수취인명·수취인 연락처로 파일 안에서 이름을 만들 수 있다(원장 없이도).
  const AM_COLS = ['주문번호', '상품주문번호', '구분', '상품명', '수취인명', '수취인 연락처', '정산금액'];
  function parseAmondz(rows) {
    const c = colsOf(rows, AM_COLS); if (c.error) return { ok: false, error: c.error };
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || []; if (blankRow(r)) continue;
      const no = c.cell(r, '주문번호'), po = c.cell(r, '상품주문번호');
      if (!no) return { ok: false, error: i + '행: 주문번호 없음' };
      const orderNo = po && po !== '-' ? po : no;
      const pay = slMoney(c.cell(r, '정산금액'));
      if (pay == null || !Number.isInteger(pay)) return { ok: false, error: orderNo + ': 정산금액을 읽을 수 없음' };
      const ship = /배송비/.test(c.cell(r, '구분'));
      if (!ship && !c.cell(r, '수취인명')) return { ok: false, error: orderNo + ': 수취인명 없음' };
      out.push({ r: i, orderNo, ledgerNo: no, buyer: c.cell(r, '수취인명'), phone: c.cell(r, '수취인 연락처'), qty: 1, W: pay, key: pay, amount: pay,
        isReturn: ship || pay < 0, name: ship ? c.cell(r, '구분') : c.cell(r, '상품명'), option: '' });
    }
    if (!out.length) return { ok: false, error: '데이터 행 없음' };
    return { ok: true, rows: out };
  }
  //  §10.9 에이블리 — 정산금 ≤ 0 은 반품(수동 목록). 파일에 원장 주문번호가 없다: 결제 완료일(KST)을 epoch ms 로 바꿔 paidAt 에 두고 원장 시각 조회에 쓴다.
  const AB_COLS = ['상품 주문 번호', '결제 완료일', '정산금', '플랫폼 수수료', '결제 금액', '프로모션 지원금'];
  function slParseKst(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(trimS(v));
    if (!m) return null;
    const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
    const t = Date.UTC(y, mo - 1, d, h - 9, mi, se), k = new Date(t + 9 * 3600000);   // KST = UTC+9
    return k.getUTCFullYear() === y && k.getUTCMonth() === mo - 1 && k.getUTCDate() === d && k.getUTCHours() === h && k.getUTCMinutes() === mi && k.getUTCSeconds() === se ? t : null;
  }
  function parseAbly(rows) {
    const c = colsOf(rows, AB_COLS, ['카테고리', '조정 사유']); if (c.error) return { ok: false, error: c.error };
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || []; if (blankRow(r)) continue;
      const orderNo = c.cell(r, '상품 주문 번호');
      if (!orderNo) return { ok: false, error: i + '행: 상품 주문 번호 없음' };
      const pay = slMoney(c.cell(r, '정산금'));
      if (pay == null || !Number.isInteger(pay)) return { ok: false, error: orderNo + ': 정산금을 읽을 수 없음' };
      const paidAt = slParseKst(c.cell(r, '결제 완료일'));
      if (paidAt == null) return { ok: false, error: orderNo + ': 결제 완료일을 읽을 수 없음' };
      const gross = slMoney(c.cell(r, '결제 금액')), promo = slMoney(c.cell(r, '프로모션 지원금'));
      if (gross == null || !Number.isInteger(gross) || promo == null || !Number.isInteger(promo)) return { ok: false, error: orderNo + ': 결제 금액·프로모션 지원금을 읽을 수 없음' };
      out.push({ r: i, orderNo, ledgerNo: '', paidAt, buyer: '', phone: '', qty: 1, key: pay, amount: pay, payTotal: gross + promo,
        isReturn: pay <= 0 || !!c.cell(r, '조정 사유'), adjust: !!c.cell(r, '조정 사유'), name: c.cell(r, '카테고리'), option: '' });
    }
    if (!out.length) return { ok: false, error: '데이터 행 없음' };
    return { ok: true, rows: out };
  }
  const hasAll = (header, names) => { const h = (header || []).map(norm); return names.every((n) => h.indexOf(norm(n)) >= 0); };
  const SL_ADAPTERS = [
    { id: 'gs', label: 'GS샵', suffix: 'G', clientRule: 'exact', matchMode: 'perUnit',
      detect: (h) => hasAll(h, [COLS.W, COLS.AA, COLS.final]), parse: parseGs },
    { id: 'cafe24-inicis-card', label: '카페24 이니시스 신용카드', suffix: '카', clientRule: 'prefix4', matchMode: 'perOrder', ledgerMarket: '카페24',
      detect: (h) => hasAll(h, ['상점MID', 'TID', '구매자', '지급액', '상태']), parse: parseInicis },
    { id: 'ssg-settle', label: 'SSG', suffix: 's', clientRule: 'prefix4', matchMode: 'perUnit', ledgerMarket: 'SSG',
      detect: (h) => hasAll(h, ['원주문ID', '주문순번', '정산금액(VAT포함)', '순판매액']), parse: parseSsg },
    { id: 'smartstore-daily', label: '스마트스토어', suffix: '스', clientRule: 'prefix4', matchMode: 'perUnit',
      detect: (h) => hasAll(h, ['상품주문번호', '정산기준금액(A)', 'Npay 수수료(B)', '매출연동 수수료 합계(C)']), parse: parseSmartstore },
    //  §10.8 — 원장 연동 마켓. clientRule 'ledger' = 원장에서만 고객을 정한다(없으면 차단). ledgerMatch = 원장 줄 매칭(쿠팡·퀸잇만 — 나머지는 원장을 고객명에만 쓴다).
    { id: 'coupang-revenue', label: '쿠팡', suffix: '쿠', clientRule: 'ledger', matchMode: 'ledger', ledgerMatch: true, ledgerMarket: '쿠팡',
      detect: (h) => hasAll(h, ['옵션 ID', '판매수량', '환불수량', '정산금액', '구매확정(출고)유형']), parse: parseCoupang },
    { id: 'queenit-settle', label: '퀸잇', suffix: '퀸', clientRule: 'ledger', matchMode: 'ledger', ledgerMatch: true, ledgerMarket: '퀸잇',
      detect: (h) => hasAll(h, ['개별주문번호', '거래유형', '정산금액(A-B-C+D)']), parse: parseQueenit },
    { id: 'amondz-settle', label: '아몬즈', suffix: '아', clientRule: 'exact', matchMode: 'perUnit', ledgerMarket: '아몬즈',
      detect: (h) => hasAll(h, ['상품주문번호', '정산금액', '수취인명', '수취인 연락처']), parse: parseAmondz },
    //  §10.9 — 파일에 원장 번호가 없어 결제 시각으로 원장을 찾는다(ledgerBy 'time'). 파일 정산금과 원장 금액의 기준이 달라 금액 대조 대신 행 수 대조(ledgerAmountCheck 'count').
    { id: 'ably-settle', label: '에이블리', suffix: '에', clientRule: 'ledger', matchMode: 'ledger', ledgerMatch: true, ledgerMarket: '에이블리', ledgerBy: 'time', ledgerAmountCheck: 'count',
      detect: (h) => hasAll(h, AB_COLS), parse: parseAbly }
  ];
  function slDetectAdapter(header) {
    const hit = SL_ADAPTERS.filter((a) => a.detect(header));
    return hit.length === 1 ? hit[0] : null;
  }
  function slParseFile(rows) {
    const a = Array.isArray(rows) && rows.length ? slDetectAdapter(rows[0]) : null;
    if (!a) return { ok: false, error: '알 수 없는 파일 양식' };
    const p = a.parse(rows);
    return p.ok ? { ok: true, adapter: a, rows: p.rows } : p;
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
        settle: st ? Number(st[1].replace(/,/g, '')) : null, qty: n[n.length - 2], price: n[n.length - 1],
        cancel: /취소/.test(t)                                   // 비고에 '정계약 취소' 같은 문구 — 후보에 섞이면 매칭이 차단한다(§10.7)
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
  //  고객 검색 결과(/etc/client.do) → {rows, truncated}. 목록은 No 내림차순이라 첫 행 No = 전체 건수 —
  //  받은 행 수보다 크거나 100건 이상이면 잘렸을 수 있다(§10.7).
  function slSearchResult(html) {
    const h = String(html == null ? '' : html);
    const rows = O.oiClientSearchRows(h).map((c) => ({ seq: c.seq, name: c.name, phone: c.phone }));
    //  선택 가능한 행이 나온 바로 그 t_list 표 안에서만, 목록에 보이는 모든 데이터 행(첫 칸이 No 숫자)을 센다 — 예비고객·타 매장 행 때문에 잘림 오탐이 나지 않게(선택 가능 행만 세지 않는다),
    //  표 밖의 다른 숫자 표가 잘림을 가리지도 않게(닫는 </table> 에서 멈춘다).
    const tre = /<table\b[^>]*\bclass\s*=\s*["']?t_list["']?[^>]*>/gi;
    const tableEnd = (start) => {   // start 의 <table> 에 짝이 맞는 </table> 끝(중첩 표 고려) — 없으면 문서 끝
      const t = /<\/?table\b[^>]*>/gi; t.lastIndex = start;
      let d = 0, x;
      while ((x = t.exec(h))) { if (x[0][1] === '/') { d--; if (d === 0) return x.index + x[0].length; } else d++; }
      return h.length;
    };
    let seg = '', pick = '', tm;
    while ((tm = tre.exec(h))) {
      const cur = h.slice(tm.index, tableEnd(tm.index));
      if (!seg) seg = cur;
      if (/setSeting\s*\(\s*form1\s*,/.test(cur)) { pick = cur; break; }
    }
    seg = pick || seg;
    const re = /<tr\b[^>]*>\s*<td\b[^>]*>\s*(\d+)\s*<\/td>/gi;
    let listed = 0, first = NaN, m;
    while ((m = re.exec(seg))) { if (!listed) first = Number(m[1]); listed++; }
    return { rows, truncated: listed >= 100 || rows.length >= 100 || listed < rows.length || (Number.isFinite(first) && first > listed) };
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
      //  판매하기 직전 줄 대조 — 결제 뒤 다른 탭이 0원 줄을 끼워 넣어도 금액 필드는 그대로라, 줄 목록으로 다시 확인한다(이미 결제했으니 fatal).
      const jrows = f2.rows || [];
      if (!sameBag(jrows.map((r) => String(r.saleSeq)), res.saleSeqs.map(String))) return fatal('jun_rows:seq ' + jrows.map((r) => r.saleSeq).join(',') + '≠' + res.saleSeqs.join(','));
      if (!sameBag(jrows.map(bagKey), lines.map(bagKey))) return fatal('jun_rows:lines ' + jrows.map(bagKey).join('|') + '≠' + lines.map(bagKey).join('|'));
      if (jrows.reduce((s, r) => s + r.amount, 0) !== plan.cash) return fatal('jun_rows:sum≠' + plan.cash);
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

  //  실행 결과를 검토 표 묶음에 반영한다(§10.7) — done 은 st='done'(체크 불가·실행 대상 아님: 같은 줄 이중 판매 방지),
  //  skipped·blocked 는 아무것도 쓰지 않았으므로 체크 상태를 그대로 두고, fatal 은 완료됐을 수 있어 체크만 푼다.
  function slApplyResults(entries, results) {
    (results || []).forEach((r) => {
      const e = (entries || []).find((x) => x.key === r.key); if (!e) return;
      e.result = r;
      if (r.status !== 'skipped' && r.status !== 'blocked') e.checked = false;
      if (r.status === 'done') e.st = 'done';
    });
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

  const api = { COLS, slHeaderMap, slMoney, slRound, slParseSheet, slComputeFinals, slIsReturn, slClientName, slAllocate, slGroupByClient, slFullReturnSet, slLedgerIndex, slLedgerIndexByTime, slApplyTimeLedger, slLedgerClient, slGroupLedger, slMatchModeFor, slMatchLedger, slClientCandidates, slAutoDecision, slSearchWord, slSearchMerged, slFallbackCandidates, slFallbackDecide, slProbeNone, slHowChip, slFallbackResolve, slClassifyRows, slOverlaps, slAllocateByWeight, slMatchClient, SL_ADAPTERS, slDetectAdapter, slParseFile, slSearchResult, slTradeUrl, slOrderRows, slSaleRows,
    SL_FORM10_NAMES, slComma, slReadSaleForm, slSaleManager, slModifyPayload, slCashPayload, slJunCheck, slJunPayload, slNewResult, slRunClient, slApplyResults, slRunAll };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof globalThis !== 'undefined') { globalThis.ubSl = Object.assign(globalThis.ubSl || {}, api); }
})();
