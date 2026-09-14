/* =============================================================================
 *  orderimport-core.js — 판매처 주문 가져오기 **순수 함수** 모듈 (DOM·fetch·chrome 없음).
 *  ISOLATED content_script 로 orderItemWriteForm.do 에만 실리고, node 에서는 module.exports 로 테스트한다.
 *  스펙: docs/superpowers/specs/2026-09-14-orderimport-design.md §2·§3·§4·§5
 *  노출: 브라우저 → globalThis.ubOi, node → module.exports (fsm.js / erp.js 와 같은 방식).
 * ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- §2.3 마켓 */
  const MARKETS = Object.freeze({
    '쿠팡':      { suffix: '쿠', clientJob: '8' },
    '아몬즈':    { suffix: '아', clientJob: '18' },
    '카페24':    { suffix: '카', clientJob: '6' },
    'GS샵':      { suffix: 'G', clientJob: '7' },
    '스마트스토어': { suffix: '스', clientJob: '5' },
    'SSG':       { suffix: 's', clientJob: '2' },
    'G마켓':     { suffix: '지', clientJob: '13' },
    '지그재그':  { suffix: '지', clientJob: '17' },
    '옥션':      { suffix: '옥', clientJob: '14' },
    '카카오':    { suffix: 'K', clientJob: '11' },
    '롯데ON':    { suffix: '롯', clientJob: '10' },
    'H몰':       { suffix: 'H', clientJob: '4' },
    '퀸잇':      { suffix: '퀸', clientJob: '20' },
    '에이블리':  { suffix: '에', clientJob: '21' }
  });
  const MARKET_INDEX = {};
  Object.keys(MARKETS).forEach((k) => { MARKET_INDEX[k.replace(/\s+/g, '').toLowerCase()] = k; });

  //  판매처 문자열 → { name, suffix, clientJob } | null. 공백·대소문자만 무시(별칭 추측 없음 — 표에 없으면 검토).
  function oiMarket(seller) {
    const key = String(seller == null ? '' : seller).replace(/\s+/g, '').toLowerCase();
    const name = MARKET_INDEX[key];
    return name ? { name, suffix: MARKETS[name].suffix, clientJob: MARKETS[name].clientJob } : null;
  }

  /* --------------------------------------------------------------- §2.1 헤더 */
  const COLS = Object.freeze({
    seller: '판매처', orderNo: '주문번호', name: '상품명', option: '옵션명', price: '판매가',
    settle: '정산금액', buyer: '수령자이름', phone: '수령자휴대폰', qty: '수량', status: '상태'
  });
  const REQUIRED = ['seller', 'orderNo', 'name', 'price', 'buyer', 'phone'];

  //  첫 행(헤더) → 열 인덱스. 이름으로만 찾는다(순서·추가 열 무관). 공백은 무시.
  function oiHeaderMap(headerRow) {
    const cells = (headerRow || []).map((c) => String(c == null ? '' : c).replace(/\s+/g, ''));
    const idx = {};
    Object.keys(COLS).forEach((key) => { const i = cells.indexOf(COLS[key]); if (i >= 0) idx[key] = i; });
    const missing = REQUIRED.filter((k) => !(k in idx)).map((k) => COLS[k]);
    return { idx, missing };
  }

  /* ------------------------------------------------------------ §2.2 정규화 */
  //  숫자만 남긴 뒤 하이픈 재구성. 유비샵은 하이픈 형식으로 저장·검색한다(실측). 그 외 길이는 ok:false.
  function oiNormPhone(raw) {
    const text = String(raw == null ? '' : raw).trim();
    const digits = text.replace(/\D/g, '');
    let phone = '';
    if (digits.length === 11) phone = digits.replace(/^(\d{3})(\d{4})(\d{4})$/, '$1-$2-$3');
    else if (digits.length === 12) phone = digits.replace(/^(\d{4})(\d{4})(\d{4})$/, '$1-$2-$3');
    else if (digits.length === 10) phone = digits.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3');
    return { raw: text, phone, last4: digits.slice(-4), ok: !!phone };
  }

  function oiClientName(buyer, last4, suffix) {
    return String(buyer == null ? '' : buyer).trim() + String(last4 || '') + '/' + String(suffix || '');
  }

  //  '17,000' · 17000 · ' 17000 ' → 17000. 비었거나 숫자가 아니거나 0 이하면 null.
  function oiMoney(v) {
    if (v == null) return null;
    const s = String(v).replace(/[,\s원]/g, '');
    if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return n > 0 ? n : null;
  }
  function oiComma(n) { return String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  //  비고 = '정산 12,133 원' (+ ' ' + 매핑표 remarkSuffix). 정산금액이 없으면 접미만(없으면 빈 문자열).
  function oiRemark(settle, suffix) {
    const parts = [];
    if (settle != null && Number.isFinite(Number(settle)) && Number(settle) >= 0) parts.push('정산 ' + oiComma(settle) + ' 원');
    if (suffix) parts.push(String(suffix).trim());
    return parts.join(' ');
  }

  //  SheetJS header:1 행 배열 → 줄 목록. 합계 행·빈 행은 버린다. 첫 행이 헤더.
  function oiParseRows(rows) {
    if (!Array.isArray(rows) || !rows.length) return { error: '빈 파일', lines: [] };
    const hm = oiHeaderMap(rows[0]);
    if (hm.missing.length) return { error: '필수 열 없음: ' + hm.missing.join(', '), lines: [] };
    const lines = [];
    rows.slice(1).forEach((r, i) => {
      const row = Array.isArray(r) ? r : [];
      const cell = (k) => (k in hm.idx) ? String(row[hm.idx[k]] == null ? '' : row[hm.idx[k]]).trim() : '';
      const seller = cell('seller'), orderNo = cell('orderNo');
      if (!seller && !orderNo) return;                      // 빈 행·'합계' 행(판매처·주문번호가 없다)
      const qtyRaw = cell('qty');
      lines.push({
        row: i + 2,                                          // 엑셀 행 번호(헤더=1)
        seller, orderNo,
        market: oiMarket(seller),
        buyer: cell('buyer'),
        phone: oiNormPhone(cell('phone')),
        productName: cell('name'),
        optionText: cell('option'),
        price: oiMoney(cell('price')),
        settle: (k => (k in hm.idx) ? oiMoney(cell('settle')) : null)('settle'),
        qty: qtyRaw ? oiMoney(qtyRaw) : 1,
        status: cell('status')
      });
    });
    return { error: null, lines };
  }

  /* ------------------------------------------------------------ §2.2 옵션 */
  const COLOR_WORDS = Object.freeze({
    '로즈골드': 'PG', '핑크골드': 'PG', '핑크': 'PG',
    '옐로우골드': 'YG', '옐로골드': 'YG', '옐로우': 'YG', '옐로': 'YG',
    '화이트골드': 'WG', '화이트': 'WG',
    '리얼화이트': 'RW', '블랙': 'BK', '플래티넘': 'PT', '플레티넘': 'PT'
  });

  //  '[14K-로즈골드-15호]' → { k:'14', color:'PG', itemSize:'15', unresolved:[] }. 셀렉트 대조는 oiLinePayload 가 한다.
  function oiParseOption(text) {
    const out = { k: null, color: null, itemSize: null, unresolved: [], tokens: [] };
    let s = String(text == null ? '' : text).trim();
    if (!s) return out;
    s = s.replace(/^\[+/, '').replace(/\]+$/, '').trim();
    const tokens = s.split(/\s*-\s*/).map((t) => t.trim()).filter(Boolean);
    out.tokens = tokens;
    tokens.forEach((t) => {
      const tn = t.replace(/\s+/g, '');
      let m;
      if ((m = tn.match(/^(\d{2})[kK]$/))) { out.k = m[1]; return; }
      if (tn === '925' || /^silver925$/i.test(tn)) { out.k = '925'; return; }
      if (COLOR_WORDS[tn]) { out.color = COLOR_WORDS[tn]; return; }
      if ((m = tn.match(/^(\d+(?:\.\d+)?)(호|cm|CM|㎝)$/))) { out.itemSize = m[1]; return; }
      if (/^\d+(?:\.\d+)?$/.test(tn)) { out.itemSize = tn; return; }
      out.unresolved.push(t);
    });
    return out;
  }

  //  마스터 기본 색상이 비었을 때: 상품코드 4번째 토막(F-NF-P-WG-UU-00DH → WG)이 셀렉트에 있으면 그 값.
  function oiColorFromCode(code, colorOpts) {
    const seg = String(code == null ? '' : code).split('-')[3] || '';
    if (!/^[A-Z]{2}$/.test(seg)) return null;
    if (colorOpts && !colorOpts.some((o) => o.value === seg)) return null;
    return seg;
  }

  /* ------------------------------------------------------------- §2.4 매핑 */
  function oiNormName(s) {
    return String(s == null ? '' : s).replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')').toLowerCase();
  }
  //  키 1순위 '상품명|품위-색상'(사이즈 제외), 2순위 '상품명'. 옵션에 품위·색상이 없으면 2순위만.
  function oiMapKeys(productName, parsed) {
    const base = oiNormName(productName);
    const k = parsed && parsed.k ? parsed.k : '';
    const c = parsed && parsed.color ? parsed.color : '';
    const keys = [];
    if (k || c) keys.push(base + '|' + k + '-' + c);
    keys.push(base);
    return keys;
  }
  function oiLookupMap(map, keys) {
    for (const k of keys || []) if (map && map[k]) return { key: k, entry: map[k] };
    return null;
  }
  //  학습: 주어진 키 전부에 같은 항목을 쓴다(원본 map 은 건드리지 않고 새 객체).
  function oiLearn(map, keys, entry, now) {
    const next = Object.assign({}, map || {});
    const rec = Object.assign({}, entry, { learnedAt: now || new Date().toISOString() });
    (keys || []).forEach((k) => { next[k] = rec; });
    return next;
  }

  //  추천 검색어: 뒤 괄호 안 문자열(있으면 1순위) → 범주어 뺀 토큰 결합 → 토큰 하나씩. 전부 공백 제거.
  const CATEGORY_RE = /(silver925|실버925|14k\s*,\s*18k|14k|18k|반지|목걸이|귀걸이|팔찌|피어싱|이어커프|발찌|앵클릿|브로치|펜던트|\[사은품\]|사은품|\(\s*1\s*개\s*\)|\(\s*1\s*쌍\s*\))/gi;
  function oiSuggestQueries(productName) {
    const name = String(productName == null ? '' : productName).trim();
    const out = [];
    const paren = name.match(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/);
    if (paren && !/^\s*1\s*(개|쌍)\s*$/.test(paren[1])) out.push(paren[1].replace(/\s+/g, ''));
    const core = name.replace(paren ? paren[0] : /$^/, ' ').replace(CATEGORY_RE, ' ').replace(/[\[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
    if (core) {
      out.push(core.replace(/\s+/g, ''));
      core.split(' ').filter((t) => t.length >= 2).forEach((t) => out.push(t));
    }
    return out.filter((q, i, a) => q && a.indexOf(q) === i);
  }

  /* --------------------------------------------------------- §2.2 주문장 묶기 */
  function oiGroupOrders(lines) {
    const map = new Map();
    (lines || []).forEach((ln) => {
      const key = ln.seller + '|' + ln.orderNo;
      if (!map.has(key)) {
        map.set(key, {
          key, seller: ln.seller, orderNo: ln.orderNo, market: ln.market, buyer: ln.buyer, phone: ln.phone,
          clientName: ln.market ? oiClientName(ln.buyer, ln.phone.last4, ln.market.suffix) : '',
          lines: []
        });
      }
      map.get(key).lines.push(ln);
    });
    return [...map.values()];
  }

  //  품위 '14'/'18'/'925' → k 셀렉트 옵션(텍스트 '14K'/'18K'/'925' 대조). 없으면 null.
  function oiResolveK(k, kOpts) {
    if (!k) return null;
    const want = (k === '925') ? '925' : (k + 'K');
    const hit = (kOpts || []).find((o) => String(o.text).replace(/\s+/g, '').toUpperCase() === want) || (kOpts || []).find((o) => o.value === k);
    return hit || null;
  }

  /* ------------------------------------------------------ §3.3 검토 판정 */
  //  줄 하나의 문제 목록. resolved = { mapping, parsed, form:{kOpts,colorOpts,defaults} } (form 은 있을 때만 대조).
  function oiLineIssues(line, resolved) {
    const issues = [];
    if (!line.market) issues.push('판매처 미등록: ' + line.seller);
    if (!line.phone || !line.phone.ok) issues.push('휴대폰 형식: ' + (line.phone ? line.phone.raw : ''));
    if (!line.buyer) issues.push('수령자 없음');
    if (line.price == null) issues.push('판매가 없음');
    if (line.qty == null) issues.push('수량');
    const parsed = resolved && resolved.parsed;
    if (parsed && parsed.unresolved.length) issues.push('옵션 해석 불가: ' + parsed.unresolved.join(', '));
    if (!resolved || !resolved.mapping) issues.push('상품 미매칭');
    const form = resolved && resolved.form;
    if (form && parsed) {
      if (parsed.k && !oiResolveK(parsed.k, form.kOpts)) issues.push('품위 옵션 없음: ' + parsed.k);
      if (parsed.color && !(form.colorOpts || []).some((o) => o.value === parsed.color)) issues.push('색상 없음: ' + parsed.color);
    }
    if (form && parsed && !parsed.color && !(form.defaults && form.defaults.color)) {
      const fb = resolved.mapping ? oiColorFromCode(resolved.mapping.entry.colorFallback || resolved.mapping.entry.code, form.colorOpts) : null;
      if (!fb) issues.push('색상 없음(마스터 기본값 빈값)');
    }
    return issues;
  }

  const api = {
    MARKETS, COLS, REQUIRED,
    oiMarket, oiHeaderMap, oiNormPhone, oiClientName, oiMoney, oiComma, oiRemark, oiParseRows,
    oiParseOption, oiColorFromCode, oiNormName, oiMapKeys, oiLookupMap, oiLearn, oiSuggestQueries,
    oiGroupOrders, oiResolveK, oiLineIssues
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof globalThis !== 'undefined') { globalThis.ubOi = api; }
})();
