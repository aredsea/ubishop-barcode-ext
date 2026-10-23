/* =============================================================================
 *  storeprice-core.js — 매장 제품 가격 변경(원버튼) 순수 로직·실행기 (ISOLATED, node 테스트 대상).
 *  흐름: 출고전표 최신 행 판정 → 출고 삭제 → 입고 소비자가·판매가 저장 → 원래 매장 재출고(printFlag=0).
 *  서버 호출은 storeprice-erp.js 어댑터만 쓴다. 표·폼 파싱은 orderimport-core(ubOi) 를 재사용한다.
 *  스펙: docs/superpowers/specs/2026-10-23-store-price-change-design.md
 * ========================================================================== */
(function () {
  'use strict';
  const O = (typeof module !== 'undefined' && module.exports) ? require('./orderimport-core.js') : globalThis.ubOi;
  if (!O) return;

  //  구분 열 "일반 (상품)" → 주문구분·상품구분 코드. 출고 화면 select 값(2026-10-23 실측).
  const ORDER_TYPES = Object.freeze({ '일반': 'A', '고객': 'B', '수리': 'X', '회전': 'Z' });
  const ITEM_TYPES = Object.freeze({ '상품': '1', '메인석': '2' });
  const TARGET_ORDER_TYPES = Object.freeze(['A', 'Z']);   // 일반·회전만(사장님 지시 2026-10-23)
  //  출고전표 상태 열 = 상품의 현재 상태(2026-10-23 실측: 출고완료·출고확인·판매완료·출고오확인(NU)).
  //  매장에 있는 상품만 — 출고완료(매장 미확인)·출고확인(매장 재고). 판매·오확인·반품 등은 건너뛴다.
  const IN_STORE_STATUSES = Object.freeze(['출고완료', '출고확인']);

  function spParsePrice(s) {
    const t = String(s == null ? '' : s).replace(/\s+/g, '');
    if (!/^\d{1,3}(,\d{3})*$|^\d+$/.test(t)) return null;
    const n = Number(t.replace(/,/g, ''));
    return Number.isSafeInteger(n) && n >= 1 && n <= 999999999 ? n : null;
  }
  const spComma = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  //  매장출고전표 목록 → 데이터 행. 열은 헤더 이름으로 찾고, 못 찾으면 실측 배치(2·4·7·8·12·14)로 폴백.
  //  ⚠ 바코드는 검색폼에 echo 되므로 행 판별은 idx value 의 2번째 칸으로만 한다.
  function spDelivRows(html) {
    const all = O.oiTListAllRows(html);
    const col = { jun: 2, date: 4, kind: 7, shop: 8, price: 12, status: 14 };
    const hdr = all.find((r) => r.idx === null && r.cells.some((t) => /출고장번호/.test(t)) && r.cells.some((t) => /^상태$/.test(String(t).replace(/\s+/g, ''))));
    if (hdr) {
      hdr.cells.forEach((t, i) => {
        const tx = String(t).replace(/\s+/g, '');
        if (/출고장번호/.test(tx)) col.jun = i;
        else if (/^출고일/.test(tx)) col.date = i;
        else if (tx === '구분') col.kind = i;
        else if (/^매장명/.test(tx)) col.shop = i;
        else if (tx === '판매가') col.price = i;
        else if (tx === '상태') col.status = i;
      });
    }
    return all.filter((r) => r.idx !== null).map((r) => {
      const c = r.cells || [];
      const kind = String(c[col.kind] || '');
      const km = kind.match(/^\s*(\S+)\s*\(\s*([^)]*?)\s*\)/);
      return {
        idx: String(r.idx),
        barcode: String(r.idx).split(',')[1] ? String(r.idx).split(',')[1].trim().toUpperCase() : '',
        junNum: String(c[col.jun] || '').trim(),
        delivDate: String(c[col.date] || '').trim(),
        kind: kind.trim(),
        orderType: km ? (ORDER_TYPES[km[1]] || null) : null,
        itemType: km ? (ITEM_TYPES[km[2]] || null) : null,
        shopText: String(c[col.shop] || '').trim(),
        salePrice: String(c[col.price] || '').trim(),
        status: String(c[col.status] || '').trim()
      };
    });
  }

  //  "누리엔점925 1 g …" → 출고 화면 searchShop 옵션 중 text 로 시작하는 가장 긴 것.
  function spShopCode(shopText, opts) {
    const t = String(shopText || '').replace(/\s+/g, '');
    let best = null;
    (opts || []).forEach((o) => {
      const name = String(o.text || '').replace(/\s+/g, '');
      if (!o.value || !name || /^-+$/.test(name)) return;
      if (t.indexOf(name) === 0 && (!best || name.length > best.name.length)) best = { code: o.value, name: name };
    });
    return best;
  }

  function spClassify(barcode, rows, shopOpts) {
    const want = String(barcode || '').trim().toUpperCase();
    const r = (rows || []).find((x) => x.barcode === want);   // 서버가 seq 내림차순 → 첫 행이 최신
    if (!r) return { go: false, reason: '출고 내역 없음' };
    const kindName = (r.kind.match(/^\s*(\S+)/) || [])[1] || '';
    if (!r.orderType || !r.itemType) return { go: false, reason: '구분 판독 불가 (' + r.kind + ')', row: r };
    if (TARGET_ORDER_TYPES.indexOf(r.orderType) < 0) return { go: false, reason: '구분 ' + kindName + ' — 대상 아님', row: r };
    //  메인석은 입고 경로(inputStone)가 달라 상품입고 수정 화면으로 가격을 바꿀 수 없다(Terra 1R P2).
    if (r.itemType !== '1') return { go: false, reason: '메인석 — 지원하지 않음', row: r };
    if (IN_STORE_STATUSES.indexOf(r.status) < 0) return { go: false, reason: '상태 ' + (r.status || '없음') + ' — 매장 재고 아님', row: r };
    const shop = spShopCode(r.shopText, shopOpts);
    if (!shop) return { go: false, reason: '매장 판독 불가 (' + r.shopText.slice(0, 20) + ')', row: r };
    return {
      go: true, row: r,
      target: { barcode: want, idx: r.idx, junNum: r.junNum, shop: shop, orderType: r.orderType, itemType: r.itemType, kind: r.kind, salePrice: r.salePrice }
    };
  }

  //  form1 구간만 — 출고 화면엔 form1·form10·form2·form3 이 같은 이름(sKey·searchShop…)을 겹쳐 쓴다.
  function spForm1Segment(html) {
    const h = String(html || '');
    const i0 = h.search(/<form\b[^>]*\bname\s*=\s*["']?form1["'\s>]/i);
    if (i0 < 0) return '';
    const rest = h.slice(i0 + 5);
    const i1 = rest.search(/<form\b/i);
    return h.slice(i0, i1 < 0 ? h.length : i0 + 5 + i1);
  }

  //  재출고 본문 — 페이지 checkBarcode 의 form1.submit 과 같은 필드. 인쇄 팝업을 막으려 printFlag=0.
  function spRedelivPairs(writeHtml, target) {
    const seg = spForm1Segment(writeHtml);
    const SET = ['searchShop', 'searchOrderType', 'searchItemType', 'barcode', 'printFlag'];
    const hidden = O.oiExtractHidden(seg).filter(([n]) => SET.indexOf(n) < 0);
    const missing = hidden.some(([n, v]) => n === 'sKey' && v) ? [] : ['sKey'];
    const pairs = hidden.concat([
      ['searchShop', target.shop.code], ['searchOrderType', target.orderType], ['searchItemType', target.itemType],
      ['barcode', target.barcode], ['printFlag', '0']
    ]);
    return { pairs, missing };
  }

  /* ------------------------------------------------------------ 실행기 */
  //  삭제 이후의 어떤 실패도 재출고를 거친다 — 제품을 본사에 남겨 두는 것이 가장 나쁜 결과다.
  async function spRunOne(target, price, E) {
    const out = { barcode: target.barcode, shop: target.shop.name, from: target.salePrice, to: spComma(price), status: '', step: '', msg: '' };
    if (!E.log({ phase: 'before_delete', barcode: target.barcode, junNum: target.junNum, shop: target.shop, orderType: target.orderType, itemType: target.itemType, idx: target.idx, price: price })) {
      return Object.assign(out, { status: 'delete_failed', step: 'log', msg: '처리 로그를 남길 수 없어 삭제하지 않았습니다' });
    }
    //  삭제 결과가 불확실하면(요청은 나갔는데 응답·확인이 끊김 — 어댑터의 uncertain 또는 예외) 지워졌다고 보고
    //  가격은 건드리지 않은 채 재출고만 시도한다. 안 지워졌다면 서버가 재출고를 거절할 뿐이다(Terra 1R P1).
    let d;
    try { d = await E.deleteDeliv(target); } catch (e) { d = { ok: false, uncertain: true, msg: String(e && e.message || e) }; }
    let fail = null;
    if (!d || !d.ok) {
      if (!(d && d.uncertain)) return Object.assign(out, { status: 'delete_failed', step: 'delete', msg: (d && d.msg) || '삭제 실패' });
      fail = { step: 'delete', msg: '출고 삭제 결과를 확인하지 못함(' + (d.msg || '') + ')' };
      E.log({ phase: 'delete_uncertain', barcode: target.barcode, junNum: target.junNum, msg: d.msg });
    } else E.log({ phase: 'deleted', barcode: target.barcode, junNum: target.junNum });

    if (!fail) try {
      const v = await E.findVoucherItem(target.barcode);
      if (!v || !v.ok) fail = { step: 'find', msg: (v && v.msg) || '입고장 품목을 못 찾음' };
      else {
        const s = await E.savePrice(v.modifyUrl, price);
        if (!s || !s.ok) fail = { step: 'save', msg: (s && s.msg) || '저장 실패' };
        else {
          const c = await E.verifyPrice(v.modifyUrl, price);
          if (!c || !c.ok) fail = { step: 'verify', msg: (c && c.msg) || '저장값 불일치' };
          else {
            E.log({ phase: 'price_saved', barcode: target.barcode, from: target.salePrice, to: price });
            if (c.warn) out.warn = c.warn;   // 가격은 저장됐지만 다른 칸이 바뀐 경우 — 결과에 드러낸다
          }
        }
      }
    } catch (e) { fail = { step: 'price', msg: String(e && e.message || e) }; }

    let rd;
    try {
      rd = await E.redeliver(target);
      if (rd && rd.ok) rd = await E.verifyRedeliv(target);
    } catch (e) { rd = { ok: false, msg: String(e && e.message || e) }; }
    if (!rd || !rd.ok) {
      E.log({ phase: 'stranded', barcode: target.barcode, shop: target.shop, msg: rd && rd.msg });
      return Object.assign(out, { status: 'stranded', step: 'redeliver', msg: ((fail ? fail.msg + ' / ' : '') + ((rd && rd.msg) || '재출고 실패')) });
    }
    E.log({ phase: 'redelivered', barcode: target.barcode, shop: target.shop });
    if (fail) return Object.assign(out, { status: 'price_failed', step: fail.step, msg: fail.msg + ' — 예전 가격으로 원래 매장 복귀' });
    return Object.assign(out, { status: 'ok' });
  }

  //  limit 건까지만(시범=1). ok 가 아니면 즉시 멈춘다. shouldStop() 이 참이면 다음 제품을 시작하지 않는다
  //  (진행 중인 제품은 재출고까지 끝낸다 — 중간에 끊으면 본사에 남는다).
  async function spRunAll(targets, price, E, opts) {
    const o = opts || {};
    const limit = o.limit == null ? targets.length : Math.min(o.limit, targets.length);
    const results = [];
    for (let i = 0; i < limit; i++) {
      if (o.shouldStop && o.shouldStop()) break;
      const r = await spRunOne(targets[i], price, E);
      results.push(r);
      try { o.onItem && o.onItem(r, i); } catch (_) {}
      if (r.status !== 'ok') break;
    }
    return results;
  }

  const api = {
    ORDER_TYPES, ITEM_TYPES, TARGET_ORDER_TYPES, IN_STORE_STATUSES,
    spParsePrice, spComma, spDelivRows, spShopCode, spClassify, spForm1Segment, spRedelivPairs, spRunOne, spRunAll
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof globalThis !== 'undefined') { globalThis.ubSp = api; }
})();
