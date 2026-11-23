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
      out.push({ orderSeq: r.orderSeq, junNum: r.junNum, orderDate: r.orderDate, customer: s.customer, code: s.code });
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

  const api = { fsSuffixMarket, fsNormCode, fsCategoryLetter, fsCustomerName, fsComposeDesc, fsPickPrice,
    fsSplitTitle, fsCandidates, fsListParams, SUFFIX_MARKET };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof globalThis !== 'undefined') { globalThis.ubFsCore = api; }
})();
