/* =============================================================================
 *  fashionstock-core.js — 패션 상품 재고화 순수 판정(DOM·chrome 무관).
 *  스펙: docs/superpowers/specs/2026-11-23-fashion-stock-design.md
 *  노출: node → module.exports, content script → globalThis.ubFsCore
 * ========================================================================== */
(function () {
  'use strict';
  //  유비샵 고객명 접미(orderimport-core MARKETS) → 아틀리에 settings.markets id.
  //  '지'(G마켓·지그재그 겹침)·퀸·롯·H·협찬·없음 → null(판매가 직접 입력).
  const SUFFIX_MARKET = Object.freeze({
    '카': 'own', '스': 'smartstore', '쿠': 'coupang', 'K': 'kakao', '아': 'amonds',
    'G': 'homeshop', 's': 'homeshop', '옥': 'gmarket', '에': 'ably'
  });
  const CATEGORY_WORDS = ['팔찌', '반지', '목걸이', '귀걸이', '이어링', '발찌', '브로치', '피어싱', '펜던트', '링'];
  const CODE_RE = /[A-Za-z0-9]+(?:-[A-Za-z0-9]+){4,}/;

  function fsSuffixMarket(customer) {
    const m = /\/([^/\s]+)\s*$/.exec(String(customer || ''));
    return m && Object.prototype.hasOwnProperty.call(SUFFIX_MARKET, m[1]) ? SUFFIX_MARKET[m[1]] : null;
  }
  function fsNormCode(code) { return String(code || '').replace(/[\s-]/g, '').toUpperCase(); }
  function fsCategoryLetter(code) {
    const c = fsNormCode(code);
    return c.length >= 2 && /[A-Z]/.test(c[1]) ? c[1] : null;
  }
  function fsCustomerName(customer) { return String(customer || '').trim().replace(/\/[^/]*$/, '').trim(); }
  function fsComposeDesc(desc, letter, customer) {
    let s = String(desc || '').trim();
    s = s.replace(/\/.*$/, '').trim();          // 기존 고객 꼬리
    s = s.replace(/^[A-Z]{1,4}-/, '');          // 매입처 접두(FD- 등)
    if (letter && !/[A-Z]$/.test(s)) {
      const w = CATEGORY_WORDS.find((x) => s.endsWith(x));
      if (w) s = s.slice(0, -w.length) + letter;
    }
    const name = fsCustomerName(customer);
    return name ? s + '/' + name : s;
  }
  function fsPickPrice(rec) {
    if (!rec) return null;
    const n = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);
    return n(rec.base) != null ? n(rec.base) : n(rec.price);
  }
  function fsSplitTitle(title) {
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    const m = CODE_RE.exec(t);
    if (!m) return { code: '', customer: '' };
    let rest = t.slice(m.index + m[0].length).trim();
    rest = rest.replace(/\s*(주문\s*)?비고\s*:.*$/, '').trim();
    return { code: m[0], customer: rest.split(' ')[0] || '' };
  }
  function fsCandidates(rows, itemNum) {
    if (!Array.isArray(rows)) return null;
    const want = fsNormCode(itemNum);
    const out = [];
    for (const r of rows) {
      if (String(r.status || '').replace(/\s+/g, '') !== '주문완료') continue;
      const s = fsSplitTitle(r.title);
      if (!s.code || fsNormCode(s.code) !== want || !s.customer) continue;
      out.push({ orderSeq: r.orderSeq, junNum: r.junNum, orderDate: String(r.orderDate || '').replace(/-/g, ''), customer: s.customer, code: s.code });
    }
    return out;
  }
  const p2 = (n) => String(n).padStart(2, '0');
  function fsListParams(now) {
    const e = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const s = new Date(e); s.setDate(s.getDate() - 6);
    return {
      tcode: 'order_item', reqPage: '1', pageSize: '500', searchSortType: 'seq',
      searchItemStatus: 'O--', searchShop: 'LT', searchDateType: 'a.orderDate',
      syear: String(s.getFullYear()), smonth: p2(s.getMonth() + 1), sday: p2(s.getDate()),
      eyear: String(e.getFullYear()), emonth: p2(e.getMonth() + 1), eday: p2(e.getDate())
    };
  }

  //  판매가 출처(사장님 2026-11-23): 카페24(/카) 고객 = 유비샵 주문전표의 그 주문 '주문가',
  //   그 외 아는 마켓 = 아틀리에 API 마켓의 할인 전 판매가(직접 입력 가격이면 서버가 manual_price), 모르면 null(직접 입력).
  function fsPriceSource(customer) {
    const m = fsSuffixMarket(customer);
    if (!m) return null;
    return m === 'own' ? { kind: 'order' } : { kind: 'atelier', market: m };
  }
  //  아틀리에 제품 이름 후보 — 아틀리에는 「물방울오팔B」처럼 소재 머리 없이 적는다(2026-11-23 실측).
  //  price-lookup 의 NAME_RE 와 같은 글자만 보낸다(필터 문법 문자 차단).
  const NAME_RE = /^[0-9A-Za-z가-힣 (),.]{2,40}$/;
  function fsAtelierNames(desc) {
    const core = String(desc || '').replace(/\/.*$/, '').trim().replace(/^[A-Z]{1,4}-/, '').trim();
    const bare = core.replace(/^(silver\s*925|s925|925|1[48]k(\s*[,/]\s*1[48]k)?)\s*/i, '').trim();
    return [...new Set([core, bare])].filter((s) => NAME_RE.test(s));
  }
  //  주문 목록 전체 행(oiTListAllRows) → { orderSeq: 주문가 }. 주문가 열이 없으면 null(fail-closed).
  function fsOrderPrices(allRows) {
    const hdr = (allRows || []).find((r) => r.idx === null && (r.cells || []).some((t) => String(t).replace(/\s+/g, '') === '주문가'));
    if (!hdr) return null;
    const ci = hdr.cells.findIndex((t) => String(t).replace(/\s+/g, '') === '주문가');
    const out = {};
    for (const r of allRows) {
      if (r.idx === null) continue;
      const seq = String(r.idx).split(',')[0];
      const d = String((r.cells || [])[ci] || '').replace(/[^\d]/g, '');
      out[seq] = d ? +d : 0;
    }
    return out;
  }

  const api = { fsPriceSource, fsAtelierNames, fsOrderPrices, fsSuffixMarket, fsNormCode, fsCategoryLetter, fsCustomerName, fsComposeDesc, fsPickPrice,
    fsSplitTitle, fsCandidates, fsListParams, SUFFIX_MARKET };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof globalThis !== 'undefined') { globalThis.ubFsCore = api; }
})();
