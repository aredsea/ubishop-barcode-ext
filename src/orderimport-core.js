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
  //  유비샵은 하이픈 형식으로 저장·검색한다(실측). 원문이 이미 '토막-토막-토막' 이면 **그 하이픈을 그대로** 쓰고(0505-123-4567 처럼
  //  4-3-4 도 있다 — 재조립하면 다른 번호가 된다, Opus 5 P2), 숫자만 왔을 때만 자릿수로 재구성한다. 국가코드(+82/82…)·그 외 형태는 검토.
  function oiNormPhone(raw) {
    const text = String(raw == null ? '' : raw).trim();
    const digits = text.replace(/\D/g, '');
    let phone = '';
    if (/^\+/.test(text) || (digits.length === 12 && /^82/.test(digits))) phone = '';
    else if (/^\d{2,4}-\d{3,4}-\d{4}$/.test(text) && digits.length >= 10 && digits.length <= 12) phone = text;
    else if (/^\d+$/.test(text)) {
      if (digits.length === 11) phone = digits.replace(/^(\d{3})(\d{4})(\d{4})$/, '$1-$2-$3');
      else if (digits.length === 12) phone = digits.replace(/^(\d{4})(\d{4})(\d{4})$/, '$1-$2-$3');
      else if (digits.length === 10) phone = digits.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3');
    } else if (/^\d{2,4}\s+\d{3,4}\s+\d{4}$/.test(text) && digits.length >= 10 && digits.length <= 12) {
      phone = text.replace(/\s+/g, '-');   // 공백으로 나뉜 세 토막(예 '106 249 2567')도 토막을 유지한다(Opus O2 Nit)
    }
    return { raw: text, phone, last4: digits.slice(-4), ok: !!phone };
  }

  function oiClientName(buyer, last4, suffix) {
    return String(buyer == null ? '' : buyer).trim() + String(last4 || '') + '/' + String(suffix || '');
  }

  //  '17,000' · 17000 · ' 17000 ' → 17000. 비었거나 숫자가 아니거나 0 이하면 null.
  //  원 단위는 **정수만** — 소수(17000.5)를 받아 반올림하면 화면 값과 서버에 쓰는 값이 달라진다(Terra 11R P1).
  function oiMoney(v) {
    if (v == null) return null;
    const s = String(v).replace(/[,\s원]/g, '');
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return n > 0 && Number.isSafeInteger(n) ? n : null;
  }
  //  정산금액 전용: 0 을 허용한다(사은품 행). 비었거나 소수·음수·문자는 null(Terra 12R P2).
  function oiMoney0(v) {
    if (v == null) return null;
    const s = String(v).replace(/[,\s원]/g, '');
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
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
  //  meta.numericPhoneRows: 휴대폰 셀이 **숫자형**이었던 행 인덱스(0=헤더) — 앞 0 이 사라진 값이 유효 번호처럼 통과하는 것을 막는다(Terra 14R P1).
  function oiParseRows(rows, meta) {
    if (!Array.isArray(rows) || !rows.length) return { error: '빈 파일', lines: [] };
    const hm = oiHeaderMap(rows[0]);
    if (hm.missing.length) return { error: '필수 열 없음: ' + hm.missing.join(', '), lines: [] };
    const numericPhone = new Set(((meta && meta.numericPhoneRows) || []).map(Number));
    const lines = [];
    rows.slice(1).forEach((r, i) => {
      const row = Array.isArray(r) ? r : [];
      const cell = (k) => (k in hm.idx) ? String(row[hm.idx[k]] == null ? '' : row[hm.idx[k]]).trim() : '';
      const seller = cell('seller'), orderNo = cell('orderNo');
      if (!seller && !orderNo) return;                      // 빈 행·'합계' 행(판매처·주문번호가 없다)
      //  주문번호만 빈 행은 버리지도 합치지도 않는다 — 검토 표에 '주문번호 없음' 으로 올려 사람이 보게 한다(Terra 2R P2).
      const qtyRaw = cell('qty');
      lines.push({
        row: i + 2,                                          // 엑셀 행 번호(헤더=1)
        seller, orderNo,
        market: oiMarket(seller),
        buyer: cell('buyer'),
        phone: oiNormPhone(cell('phone')),
        phoneNumericCell: numericPhone.has(i + 1),
        productName: cell('name'),
        optionText: cell('option'),
        price: oiMoney(cell('price')),
        settle: (k => (k in hm.idx) ? oiMoney0(cell('settle')) : null)('settle'),
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

  //  마스터 기본 색상이 비었을 때의 색상: 매핑의 colorFallback(색상 코드 'WG' 같은 2글자)이 셀렉트에 있으면 그것, 아니면 상품코드 4번째 토막.
  //  (예전엔 colorFallback 을 코드 파서에 넣어 실제로 한 번도 동작하지 않았다 — 2026-09-15 Terra 13R 계기로 발견)
  function oiFallbackColor(master, colorOpts) {
    const fb = master && typeof master.colorFallback === 'string' ? master.colorFallback.trim().toUpperCase() : '';
    if (/^[A-Z0-9]{2}$/.test(fb) && (!colorOpts || colorOpts.some((o) => o.value === fb))) return fb;
    return oiColorFromCode(master ? master.code : '', colorOpts);
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
  //  매핑 항목은 seq·code 문자열이 둘 다 있어야 실행에 쓸 수 있다(가져온 JSON 이 불완전할 수 있다 — Terra 8R P2).
  function oiValidMapEntry(e) {
    return !!e && typeof e.seq === 'string' && !!e.seq.trim() && typeof e.code === 'string' && !!e.code.trim();
  }
  function oiLookupMap(map, keys) {
    for (const k of keys || []) if (map && map[k]) return { key: k, entry: map[k] };
    return null;
  }
  //  학습: 주어진 키 전부에 같은 항목을 쓴다(원본 map 은 건드리지 않고 새 객체).
  //  같은 seq(같은 유비샵 상품)의 기존 항목이 있으면 remarkSuffix·colorFallback 을 이어받는다 — [매핑 지우기] 뒤 다시 골라도
  //  부가정보가 사라지지 않게(Terra 12R P2). entry 에 명시한 값이 우선.
  function oiLearn(map, keys, entry, now) {
    const next = Object.assign({}, map || {});
    const prior = Object.values(map || {}).find((e) => e && entry && String(e.seq) === String(entry.seq) && (e.remarkSuffix || e.colorFallback));
    const carry = {};
    if (prior) { if (prior.remarkSuffix) carry.remarkSuffix = prior.remarkSuffix; if (prior.colorFallback) carry.colorFallback = prior.colorFallback; }
    const rec = Object.assign({}, carry, entry, { learnedAt: now || new Date().toISOString() });
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
      //  주문번호가 없으면 행마다 따로 묶는다(같은 판매처의 빈 주문번호끼리 한 주문장으로 합쳐지면 안 된다 — Terra 2R P2).
      const key = ln.orderNo ? ln.seller + '|' + ln.orderNo : ln.seller + '|(row ' + ln.row + ')';
      if (!map.has(key)) {
        map.set(key, {
          key, seller: ln.seller, orderNo: ln.orderNo, market: ln.market, buyer: ln.buyer, phone: ln.phone,
          clientName: ln.market ? oiClientName(ln.buyer, ln.phone.last4, ln.market.suffix) : '',
          lines: []
        });
      }
      const o = map.get(key);
      //  같은 주문장인데 수령자/휴대폰이 첫 줄과 다르면 그 줄을 검토로 올린다(Terra 4R P1 — 첫 줄 고객으로 조용히 합쳐지면 오배송).
      ln.groupMismatch = !!(o.lines.length && (ln.buyer !== o.buyer || (ln.phone && ln.phone.phone) !== (o.phone && o.phone.phone)));
      o.lines.push(ln);
    });
    const orders = [...map.values()];
    //  주문폼 하단 목록은 기본 pageSize 20 — 21줄부터 응답 목록이 잘려 행 수 대조가 깨진다(Terra 9R P1). 쓰기 전에 막는다.
    orders.forEach((o) => { if (o.lines.length > OI_MAX_LINES) o.lines.forEach((l) => { l.tooMany = o.lines.length; }); });
    return orders;
  }
  const OI_MAX_LINES = 20;

  //  코드표 밖 판매처를 **이 세션에서만** 보정(스펙 §2.3). 표에 저장하지 않는다. 접미가 비면 적용하지 않는다.
  function oiApplyMarket(order, suffix, clientJob) {
    const suf = String(suffix == null ? '' : suffix).trim();
    if (!order || !suf) return false;
    order.market = { name: order.seller, suffix: suf, clientJob: String(clientJob == null ? '' : clientJob), sessionOnly: true };
    order.clientName = oiClientName(order.buyer, order.phone ? order.phone.last4 : '', suf);
    (order.lines || []).forEach((l) => { l.market = order.market; });
    return true;
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
    if (!line.orderNo) issues.push('주문번호 없음');
    if (line.groupMismatch) issues.push('수령자 불일치: 같은 주문번호의 첫 줄과 수령자/휴대폰이 다름');
    if (line.tooMany) issues.push('줄 수 초과: 주문장 ' + line.tooMany + '줄 (최대 ' + OI_MAX_LINES + ') — 유비샵에서 나눠 넣으세요');
    if (!line.phone || !line.phone.ok) issues.push('휴대폰 형식: ' + (line.phone ? line.phone.raw : ''));
    if (line.phoneNumericCell) issues.push('휴대폰 숫자 셀: 앞 0 이 사라졌을 수 있음 — 엑셀에서 텍스트 서식으로 저장하세요');
    if (!line.buyer) issues.push('수령자 없음');
    if (line.price == null) issues.push('판매가 없음');
    if (line.qty == null) issues.push('수량');
    const parsed = resolved && resolved.parsed;
    //  사람이 품위·색상·사이즈를 직접 보정했으면(optOverride) 원문의 미해석 토큰은 더 이상 차단 사유가 아니다(Terra 4R P2).
    if (parsed && parsed.unresolved.length && !(resolved && resolved.optOverride)) issues.push('옵션 해석 불가: ' + parsed.unresolved.join(', '));
    if (!resolved || !resolved.mapping) issues.push('상품 미매칭');
    else if (!oiValidMapEntry(resolved.mapping.entry)) issues.push('매핑 불완전(seq/code 없음) — 매핑을 지우고 다시 고르세요');
    const form = resolved && resolved.form;
    if (form && parsed) {
      if (parsed.k && !oiResolveK(parsed.k, form.kOpts)) issues.push('품위 옵션 없음: ' + parsed.k);
      if (parsed.color && !(form.colorOpts || []).some((o) => o.value === parsed.color)) issues.push('색상 없음: ' + parsed.color);
    }
    if (form && parsed && !parsed.color && !(form.defaults && form.defaults.color)) {
      const fb = resolved.mapping ? oiFallbackColor(resolved.mapping.entry, form.colorOpts) : null;
      if (!fb) issues.push('색상 없음(마스터 기본값 빈값)');
    }
    return issues;
  }

  /* ------------------------------------------------------- §4 폼 추출 */
  function oiAttr(tag, attr) {
    const re = new RegExp('\\b' + attr + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>"\']+))', 'i');
    const m = tag.match(re);
    return m ? (m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3])) : null;
  }
  function oiEsc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function oiDecodeEntities(s) {
    return String(s).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }

  //  <select name=X> 의 옵션 [{value,text,selected}] | null
  function oiSelectOptions(html, name) {
    const re = new RegExp('<select\\b[^>]*\\bname\\s*=\\s*["\']?' + oiEsc(name) + '["\']?(?=[\\s>"\'])[^>]*>([\\s\\S]*?)<\\/select>', 'i');
    const m = String(html).match(re);
    if (!m) return null;
    const opts = [];
    const ore = /<option\b([^>]*)>([^<]*)/gi; let o;
    while ((o = ore.exec(m[1]))) {
      const attrs = o[1];
      const value = oiAttr('<option' + attrs + '>', 'value');
      const text = oiDecodeEntities(o[2]).trim();
      opts.push({ value: value == null ? text : value, text, selected: /\bselected\b/i.test(attrs) });
    }
    return opts;
  }

  //  이름으로 값 하나: input(value) → select(selected, 없으면 첫 옵션) → textarea. 없으면 null.
  function oiFieldValue(html, name) {
    const h = String(html);
    const ire = new RegExp('<input\\b[^>]*\\bname\\s*=\\s*["\']?' + oiEsc(name) + '["\']?(?=[\\s>"\'])[^>]*>', 'i');
    const im = h.match(ire);
    if (im) { const v = oiAttr(im[0], 'value'); return v == null ? '' : oiDecodeEntities(v); }
    const opts = oiSelectOptions(h, name);
    if (opts) { const sel = opts.find((o) => o.selected) || opts[0]; return sel ? sel.value : ''; }
    const tre = new RegExp('<textarea\\b[^>]*\\bname\\s*=\\s*["\']?' + oiEsc(name) + '["\']?(?=[\\s>"\'])[^>]*>([\\s\\S]*?)<\\/textarea>', 'i');
    const tm = h.match(tre);
    if (tm) return oiDecodeEntities(tm[1]);
    return null;
  }

  function oiExtractFields(html, names) {
    const values = {}; const missing = [];
    (names || []).forEach((n) => { const v = oiFieldValue(html, n); if (v === null) missing.push(n); else values[n] = v; });
    return { values, missing };
  }

  //  hidden input 전부 → [[name, value], …] (문서 순서, 중복 이름 유지). DOMParser form.elements 함정 회피.
  function oiExtractHidden(html) {
    const out = [];
    const re = /<input\b[^>]*>/gi; let m;
    while ((m = re.exec(String(html)))) {
      const tag = m[0];
      if (!/\btype\s*=\s*["']?hidden["']?/i.test(tag)) continue;
      const name = oiAttr(tag, 'name'); if (!name) continue;
      const v = oiAttr(tag, 'value');
      out.push([name, v == null ? '' : oiDecodeEntities(v)]);
    }
    return out;
  }

  //  var arr_weight = new Array(1.2,0); 류 → { arr_weight:[1.2,0], … }
  function oiExtractArrays(html) {
    const out = {};
    ['arr_weight', 'arr_salePrice', 'arr_inputSupply'].forEach((n) => {
      const m = String(html).match(new RegExp('var\\s+' + n + '\\s*=\\s*new\\s+Array\\(([^)]*)\\)'));
      out[n] = m ? m[1].split(',').map((x) => Number(String(x).trim())).map((x) => Number.isFinite(x) ? x : 0) : null;
    });
    return out;
  }

  /* --------------------------------------------- §4 목록(table.t_list) 파싱 */
  //  중첩 테이블(이미지 셀)이 있어 단순 <tr> 정규식은 안 된다 → 태그 스캐너로 깊이를 센다.
  //  idx 를 가진 첫 t_list 테이블의 행 전부(헤더 행 포함). 데이터 행만 필요하면 oiTListRows.
  function oiTListAllRows(html) {
    const h = String(html);
    const tre = /<table\b[^>]*\bclass\s*=\s*["']?t_list["']?[^>]*>/gi; let tm;
    while ((tm = tre.exec(h))) {
      const rows = oiScanTable(h, tm.index);
      if (rows.some((r) => r.idx !== null)) return rows;
    }
    return [];
  }
  function oiTListRows(html) { return oiTListAllRows(html).filter((r) => r.idx !== null); }
  function oiScanTable(h, start) {
    const tagRe = /<\/?(table|tr|td|th)\b[^>]*>/gi;
    tagRe.lastIndex = start;
    let depth = 0, row = null, cell = null; const rows = [];
    let t;
    while ((t = tagRe.exec(h))) {
      const tag = t[0]; const name = t[1].toLowerCase(); const close = tag[1] === '/';
      if (name === 'table') {
        if (!close) depth++; else { depth--; if (depth === 0) break; }
        continue;
      }
      if (depth !== 1) continue;                            // 중첩 테이블 안은 통째로 셀 내용
      if (name === 'tr') {
        if (!close) { row = { cells: [], idx: null, html: '' , _start: t.index }; }
        else if (row) { row.html = h.slice(row._start, t.index + tag.length); delete row._start; const im = row.html.match(/<input\b[^>]*\bname\s*=\s*["']?idx["']?[^>]*>/i); row.idx = im ? oiAttr(im[0], 'value') : null; rows.push(row); row = null; }
        continue;
      }
      if (!row) continue;
      if (!close) { cell = { _start: t.index + tag.length }; }
      else if (cell) { const raw = h.slice(cell._start, t.index); row.cells.push(oiDecodeEntities(raw.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()); cell = null; }
    }
    return rows;
  }

  //  주문폼 하단 목록 행: 셀 인덱스 고정(실측) 0 No·1 체크·2 이미지·3 상품코드+비고·4 구분·5 상품명·6 품위·7 중량·8 색상·9 사이즈·10 수량·11 주문가.
  function oiWriteListRow(row) {
    const c = row.cells || [];
    const idx = String(row.idx || '');
    const parts = idx.split(',');
    const codeCell = c[3] || '';
    const cm = codeCell.match(/^([A-Z0-9]+(?:-[A-Z0-9]+)+)/i);
    const rm = codeCell.match(/비고\s*:\s*(.*)$/);
    return {
      orderSeq: parts[0] || '', tradeJun: parts[1] || '',
      code: cm ? cm[1] : '', remark: rm ? rm[1].trim() : '',
      name: c[5] || '', k: c[6] || '', weight: c[7] || '', color: c[8] || '', size: c[9] || '',
      qty: c[10] || '', price: c[11] || ''
    };
  }
  function oiWriteListRows(html) { return oiTListRows(html).map(oiWriteListRow); }

  //  MD 주문전표 목록 행: 1 idx=orderSeq · 2 '26-09-14'+'0000002YF3' · 4 상품명 코드 / 고객명 · 11 상태.
  //  열 위치는 **헤더 이름으로** 찾는다 — 같은 목록이 계정·화면에 따라 열이 다르다(2026-09-14 13열: 2 주문장번호·4 고객명·11 상태,
  //  2026-09-15 14열: '발주처명' 이 3에 끼어 5 고객명·12 상태). 헤더를 못 찾으면 13열 배치로 폴백.
  function oiJunListRows(html) {
    const all = oiTListAllRows(html);
    const hdr = all.find((r) => r.idx === null && r.cells.some((t) => /상태/.test(t)) && r.cells.some((t) => /주문장번호/.test(t)));
    const col = { jun: 2, title: 4, status: 11 };
    if (hdr) {
      hdr.cells.forEach((t, i) => {
        const tx = String(t).replace(/\s+/g, '');
        if (/주문장번호/.test(tx)) col.jun = i;
        else if (/고객명/.test(tx)) col.title = i;
        else if (tx === '상태') col.status = i;
      });
    }
    return all.filter((r) => r.idx !== null).map((row) => {
      const c = row.cells || [];
      const jm = String(c[col.jun] || '').match(/(\d{7}[0-9A-Z]{3})\s*$/);
      return { orderSeq: String(row.idx || '').split(',')[0], junNum: jm ? jm[1] : '', title: c[col.title] || '', status: c[col.status] || '' };
    });
  }

  //  고객 검색 결과 행: 1 고객명·2 매장·3 휴대폰·4 전화, 선택 링크 setSeting(form1,'i','<seq>'). (idx 가 없는 표라 링크로 고른다)
  function oiClientSearchRows(html) {
    const h = String(html); const out = [];
    const tre = /<table\b[^>]*\bclass\s*=\s*["']?t_list["']?[^>]*>/gi; let tm;
    while ((tm = tre.exec(h))) {
      const rows = oiScanTable(h, tm.index);
      rows.forEach((r) => {
        const sm = r.html.match(/setSeting\s*\(\s*form1\s*,\s*['"](\d+)['"]\s*,\s*['"](\d+)['"]\s*\)/);
        if (!sm) return;
        out.push({ name: r.cells[1] || '', shop: r.cells[2] || '', phone: r.cells[3] || '', tel: r.cells[4] || '', seq: sm[2] });
      });
      if (out.length) return out;
    }
    return out;
  }

  //  상품 검색 결과 행: 2 상품코드·4 상품명, 링크 setSeting('<masterSeq>').
  function oiMasterSearchRows(html) {
    const h = String(html); const out = [];
    const tre = /<table\b[^>]*\bclass\s*=\s*["']?t_list["']?[^>]*>/gi; let tm;
    while ((tm = tre.exec(h))) {
      oiScanTable(h, tm.index).forEach((r) => {
        const sm = r.html.match(/setSeting\s*\(\s*['"](\d+)['"]\s*\)/);
        if (!sm) return;
        out.push({ code: r.cells[2] || '', name: r.cells[4] || '', seq: sm[1] });
      });
      if (out.length) return out;
    }
    return out;
  }

  /* ------------------------------------------------------- §4.2 페이로드 */
  const FORM1_NAMES = Object.freeze(['sKey', 'pageSize', 'searchSortType', 'tradeJun', 'payJun', 'shop', 'client', 'master', 'itemType',
    'inputPrice', 'orgOrderPrice', 'shopName', 'clientName', 'itemNum', 'weight', 'doc', 'diaColor', 'clarity', 'surface',
    'k', 'color', 'itemSize', 'orderQty', 'orderPrice', 'shopRemark']);
  const FORM10_NAMES = Object.freeze(['sKey', 'pageSize', 'searchSortType', 'tradeJun', 'payJun', 'shop', 'client', 'payBank', 'payDia',
    'txtOrderDate', 'exdelivedyear', 'exdelivedmonth', 'exdelivedday', 'regId', 'beforePrice', 'payPrice', 'afterPrice',
    'payCard', 'paySaleOldGold', 'payCash', 'payCashPaper', 'payEtc', 'payRemark']);

  //  주문폼 GET 응답 → { values, missing, kOpts, colorOpts, arrays, rows, defaults }
  function oiReadWriteForm(html) {
    const ex = oiExtractFields(html, FORM1_NAMES);
    const kOpts = oiSelectOptions(html, 'k');
    const colorOpts = oiSelectOptions(html, 'color');
    return {
      values: ex.values, missing: ex.missing,
      kOpts: kOpts || [], colorOpts: colorOpts || [],
      arrays: oiExtractArrays(html),
      rows: oiWriteListRows(html),
      defaults: { k: ex.values.k || '', color: ex.values.color || '', itemSize: ex.values.itemSize || '' }
    };
  }
  //  form10 은 form1 과 이름이 겹치므로(sKey·client…) form10 구간만 잘라 읽는다. 구간이 없으면 전체.
  function oiReadForm10(html) {
    const h = String(html);
    const i0 = h.search(/<form\b[^>]*\bname\s*=\s*["']?form10["']?/i);
    let seg = h;
    if (i0 >= 0) { const rest = h.slice(i0); const i1 = rest.search(/<form\b[^>]*\bname\s*=\s*["']?form2["']?/i); seg = i1 > 0 ? rest.slice(0, i1) : rest; }
    const ex = oiExtractFields(seg, FORM10_NAMES);
    return { values: ex.values, missing: ex.missing, rows: oiWriteListRows(h) };
  }

  //  줄 페이로드: 추출값(25) + 스펙(k/color/itemSize/qty/price/remark) → { fields:[[n,v]…], issues:[] }
  //  k 를 바꾸면 페이지의 kchange() 처럼 arr_weight/arr_salePrice/arr_inputSupply[옵션 인덱스] 로 weight/orgOrderPrice/inputPrice 를 다시 뽑는다.
  function oiLinePayload(form, master, spec) {
    const issues = [];
    const v = Object.assign({}, form.values);
    if (form.missing && form.missing.length) issues.push('필드 누락: ' + form.missing.join(','));
    if (spec.k) {
      const opt = oiResolveK(spec.k, form.kOpts);
      if (!opt) issues.push('품위 옵션 없음: ' + spec.k);
      else if (opt.value !== v.k) {
        v.k = opt.value;
        const pos = form.kOpts.indexOf(opt);
        const a = form.arrays || {};
        if (a.arr_weight && pos < a.arr_weight.length) v.weight = String(a.arr_weight[pos]);
        if (a.arr_salePrice && pos < a.arr_salePrice.length) v.orgOrderPrice = String(a.arr_salePrice[pos]);
        if (a.arr_inputSupply && pos < a.arr_inputSupply.length) v.inputPrice = String(a.arr_inputSupply[pos]);
      }
    }
    let color = spec.color || v.color || '';
    if (!color) color = oiFallbackColor(master, form.colorOpts) || '';
    if (!color) issues.push('색상 없음');
    else if (form.colorOpts && form.colorOpts.length && !form.colorOpts.some((o) => o.value === color)) issues.push('색상 없음: ' + color);
    v.color = color;
    if (spec.itemSize != null && spec.itemSize !== '') v.itemSize = String(spec.itemSize);
    if (!(spec.qty > 0)) issues.push('수량');
    v.orderQty = String(spec.qty);
    if (!(spec.price > 0)) issues.push('판매가');
    v.orderPrice = oiComma(spec.price);
    v.shopRemark = spec.remark || '';
    if (master && master.seq && String(v.master) !== String(master.seq)) issues.push('master 불일치: ' + v.master + '≠' + master.seq);
    return { fields: FORM1_NAMES.map((n) => [n, v[n] == null ? '' : String(v[n])]), issues, values: v };
  }

  //  주문장 완료 페이로드: 인도예정일은 오늘로 명시(HTML 에 selected 가 없어 추출값이 01/01). 결제 필드는 빈값이면 '0'.
  function oiForm10Payload(values, today) {
    const v = Object.assign({}, values);
    const d = today instanceof Date ? today : new Date();
    const p = (x) => String(x).padStart(2, '0');
    v.exdelivedyear = String(d.getFullYear()); v.exdelivedmonth = p(d.getMonth() + 1); v.exdelivedday = p(d.getDate());
    ['payBank', 'payDia', 'beforePrice', 'payPrice', 'afterPrice', 'payCard', 'paySaleOldGold', 'payCash', 'payCashPaper', 'payEtc']
      .forEach((n) => { if (v[n] == null || v[n] === '') v[n] = '0'; });
    if (v.payRemark == null) v.payRemark = '';
    return FORM10_NAMES.map((n) => [n, v[n] == null ? '' : String(v[n])]);
  }

  //  성공·실패 모두 폼페이지로 리다이렉트, 실패만 msg 에 문구(기존 메모리). url = fetch 응답 resp.url.
  function oiSubmitResult(url) {
    try { const msg = new URL(url).searchParams.get('msg') || ''; return { ok: !msg, msg }; }
    catch (_) { return { ok: false, msg: 'bad_url' }; }
  }

  /* ------------------------------------------------ §5 기대치 대조 */
  //  줄 등록 전: client 일치 · 행 수 = 내가 넣은 수 · 행의 orderSeq 집합 일치 · tradeJun 일치(첫 줄은 빈값 허용).
  function oiCheckForm(form, expect) {
    const v = form.values || {};
    if (String(v.client) !== String(expect.client)) return { ok: false, reason: 'client ' + v.client + '≠' + expect.client };
    if (expect.master != null && String(v.master) !== String(expect.master)) return { ok: false, reason: 'master ' + v.master + '≠' + expect.master };
    const rows = form.rows || [];
    const mine = expect.orderSeqs || [];
    if (rows.length !== mine.length) return { ok: false, reason: 'rows ' + rows.length + '≠' + mine.length };
    for (const r of rows) if (!mine.includes(r.orderSeq)) return { ok: false, reason: 'foreign row ' + r.orderSeq };
    if (mine.length && expect.tradeJun && String(v.tradeJun) !== String(expect.tradeJun)) return { ok: false, reason: 'tradeJun ' + v.tradeJun + '≠' + expect.tradeJun };
    //  첫 줄(내 줄 0개)인데 폼에 tradeJun 이 이미 있으면 가드 직후 다른 탭이 연 **빈 주문장**이다 — 거기에 붙이면 남의 주문장이 된다(Terra 5R P1).
    if (!mine.length && !expect.tradeJun && v.tradeJun) return { ok: false, reason: 'tradeJun open ' + v.tradeJun };
    return { ok: true, reason: '' };
  }
  //  완료 직전: 행 수·orderSeq·상품코드·사이즈·수량·주문가를 검토 표(lines)와 대조하고,
  //  등록 응답에서 받아 둔 행 스냅샷(expect.snaps)과 **모든 표시 필드**를 문자열 그대로 대조한다 —
  //  다른 탭이 그 사이 색상·품위·비고·기본 사이즈만 고쳐도 완료하지 않는다(Terra 6R P1).
  const SNAP_FIELDS = ['code', 'k', 'weight', 'color', 'size', 'qty', 'price', 'remark', 'name'];
  function oiCheckFinal(form, expect) {
    const base = oiCheckForm(form, expect);
    if (!base.ok) return base;
    const rows = form.rows || [];
    const lines = expect.lines || [];
    if (rows.length !== lines.length) return { ok: false, reason: 'rows ' + rows.length + '≠' + lines.length };
    const snaps = expect.snaps || [];
    for (let i = 0; i < snaps.length; i++) {
      const snap = snaps[i]; if (!snap) continue;
      const r = rows.find((x) => x.orderSeq === snap.orderSeq);
      if (!r) return { ok: false, reason: 'snapshot ' + snap.orderSeq + ' missing' };
      for (const f of SNAP_FIELDS) if (String(r[f] == null ? '' : r[f]) !== String(snap[f] == null ? '' : snap[f])) return { ok: false, reason: 'snapshot ' + snap.orderSeq + ' ' + f + ' ' + JSON.stringify(r[f]) + '≠' + JSON.stringify(snap[f]) };
    }
    for (let i = 0; i < lines.length; i++) {
      const r = rows.find((x) => x.orderSeq === expect.orderSeqs[i]);
      const ln = lines[i];
      if (!r) return { ok: false, reason: 'missing row ' + expect.orderSeqs[i] };
      if (r.code !== ln.master.code) return { ok: false, reason: 'code ' + r.code + '≠' + ln.master.code };
      if (ln.spec.itemSize != null && ln.spec.itemSize !== '' && String(r.size) !== String(ln.spec.itemSize)) return { ok: false, reason: 'size ' + r.size + '≠' + ln.spec.itemSize };
      if (String(r.qty) !== String(ln.spec.qty)) return { ok: false, reason: 'qty ' + r.qty + '≠' + ln.spec.qty };
      if (r.price.replace(/,/g, '') !== String(ln.spec.price)) return { ok: false, reason: 'price ' + r.price + '≠' + ln.spec.price };
    }
    return { ok: true, reason: '' };
  }

  /* ------------------------------------------------- §3.4 실행기 (erp 주입) */
  //  erp 인터페이스(orderimport-erp.js 가 구현):
  //   state() → {tradeJun, client, rows:number}
  //   searchClient(type,word) → [{name,shop,phone,tel,seq}]
  //   registerClient(name, phone, clientJob) → {ok, msg, client:{seq,name,phone}|null}
  //   getWriteForm({tradeJun,master,client,clientName}) → oiReadWriteForm 결과
  //   postLine(fields) → {ok, msg, tradeJun, rows}
  //   getForm10({tradeJun,client,clientName}) → oiReadForm10 결과
  //   postComplete(fields) → {ok, msg}
  //   deleteLines(tradeJun, client, clientName, idxValues) → {ok, msg}
  //   findJunNums(orderSeqs) → [{orderSeq, junNum, status}]
  //  hooks: { today():Date, log(key, step, info) }
  async function oiRunOrder(order, erp, hooks) {
    const log = (step, info) => { try { hooks && hooks.log && hooks.log(order.key, step, info); } catch (_) {} };
    const res = { key: order.key, sig: order.sig || '', status: 'pending', reason: '', client: null, tradeJun: '', orderSeqs: [], idxValues: [], rowSnaps: [], junNums: [], rolledBack: 0, completed: false, completing: false, lineUnknown: false };
    const fail = async (status, reason) => {
      res.reason = reason; log('fail', reason);
      //  🔴 완료 POST 가 성공한 뒤의 실패는 되돌리지 않는다 — 이미 주문장이 확정됐으므로 그 줄을 지우면 안 된다.
      //  (Terra 1R P1 2026-09-15: 완료 후 확인 GET 타임아웃이 catch 로 들어와 완료된 줄에 deleteLines 를 걸 뻔했다)
      if (res.completing) { res.status = 'fatal'; res.reason = 'complete_unverified:' + reason; return res; }
      //  줄 POST 의 결과를 모르는 상태(응답 유실)면 무엇이 들어갔는지 모르므로 지우지도, 계속하지도 않는다(Terra 2R·3R P1).
      //  당장 state() 가 비어 보여도 이 ERP 는 느려서 **나중에** 커밋될 수 있고, 그러면 다음 주문장에 섞인다 → 무조건 fatal.
      if (res.lineUnknown) { res.status = 'fatal'; res.reason = 'line_unverified:' + reason; return res; }
      if (res.idxValues.length) {
        //  되돌리기 통신 자체가 죽어도 결과에 fatal 로 남긴다 — 여기서 던지면 oiRunAll 까지 reject 돼 상태가 사라진다(Terra 1R P1).
        try {
          //  삭제 직전에 세션의 열린 주문장이 **아직 내 tradeJun** 인지 본다 — 그 사이 남이 완료했으면 완료된 전표를 지우게 된다(Terra 7R P1).
          const now = await erp.state();
          if (String(now.tradeJun || '') !== String(res.tradeJun || '')) { res.status = 'fatal'; res.reason = 'rollback_aborted:trade_changed ' + (now.tradeJun || '(none)') + '≠' + res.tradeJun + ' (' + reason + ')'; return res; }
          const del = await erp.deleteLines(res.tradeJun, res.client ? res.client.seq : '', res.client ? res.client.name : '', res.idxValues.slice());
          log('rollback', del);
          //  되돌린 뒤 서버 목록에서 **내 orderSeq** 가 사라졌는지 확인. 남의 줄이 남아 있으면 세션이 남의 주문장에
          //  묶인 것이라 다음 주문장도 시작할 수 없다 → fatal(사람이 정리해야 한다).
          const after = await erp.getWriteForm({ tradeJun: res.tradeJun, master: '', client: res.client ? res.client.seq : '', clientName: res.client ? res.client.name : '' });
          const remain = (after.rows || []).map((r) => r.orderSeq);
          if (!del.ok || remain.some((s) => res.orderSeqs.includes(s))) { res.status = 'fatal'; res.reason = 'rollback_failed:' + reason; return res; }
          res.rolledBack = res.idxValues.length;
          //  되돌리기가 내 줄 **밖**까지 지웠는지 — 삭제 직전 목록(어댑터의 키 발급 GET 응답 `before`)에 있던 남의 줄이 사라졌으면 서버 계약이
          //  idx 단독 삭제가 아니라는 뜻이라 사람이 봐야 한다(Fable F1). 되돌리기는 라이브 미실측이므로 계약이 틀렸을 때도 fail-closed 여야 한다.
          if (!Array.isArray(del.before)) { res.status = 'fatal'; res.reason = 'rollback_unverifiable:' + reason; return res; }
          const mine = res.orderSeqs.map(String);
          const lost = del.before.map((r) => String(r.orderSeq)).filter((s) => s && !mine.includes(s) && !remain.map(String).includes(s));
          if (lost.length) { res.status = 'fatal'; res.reason = 'rollback_overreach:' + lost.join(',') + ' (' + reason + ')'; return res; }
          if (remain.length) { res.status = 'fatal'; res.reason = 'foreign_rows_remain:' + reason; return res; }
          //  내 줄이 사라졌어도 세션에 빈 주문장이 남아 있으면 다음 주문장을 시작할 수 없다 — 조용히 skipped 로 넘기지 않는다(Terra 10R P2).
          const st = await erp.state();
          if (st.tradeJun || st.rows > 0) { res.status = 'fatal'; res.reason = 'rollback_incomplete:trade ' + (st.tradeJun || '') + ' rows ' + st.rows + ' (' + reason + ')'; return res; }
        } catch (e) {
          log('rollback_exception', String(e && e.message || e));
          res.status = 'fatal'; res.reason = 'rollback_exception:' + String(e && e.message || e) + ' (' + reason + ')'; return res;
        }
      }
      res.status = status; return res;
    };
    try {
      const st = await erp.state();
      log('guard', st);
      if (st.tradeJun || st.rows > 0) { res.status = 'skipped'; res.reason = 'open_trade'; return res; }

      const byName = await erp.searchClient('clientName', order.clientName);
      const exact = byName.find((c) => c.name === order.clientName);
      if (exact) res.client = { seq: exact.seq, name: exact.name, mode: 'reuse' };
      else {
        let phone = order.phone && order.phone.phone ? order.phone.phone : '';
        if (phone) { const byPhone = await erp.searchClient('phone', phone); if (byPhone.some((c) => c.phone === phone)) phone = ''; }
        const reg = await erp.registerClient(order.clientName, phone, order.market.clientJob);
        log('register', reg);
        if (!reg.ok || !reg.client) { res.status = 'skipped'; res.reason = 'register_failed:' + (reg.msg || ''); return res; }
        res.client = { seq: reg.client.seq, name: order.clientName, mode: phone ? 'new' : 'new_nophone' };
      }

      //  세션의 열린 주문장이 아직 내 tradeJun 인지 plain GET 으로 본다 — 명시 tradeJun GET 은 완료된 전표의 줄도 계속 보여주므로 그것만으론
      //  남이 그 사이 완료한 것을 못 잡는다(Opus 5 P2, 되돌리기 직전 대조와 같은 한 줄).
      const assertTradeOpen = async (where) => {
        const st = await erp.state();
        if (String(st.tradeJun || '') !== String(res.tradeJun || '')) return 'trade_changed:' + where + ' ' + (st.tradeJun || '(none)') + '≠' + (res.tradeJun || '(none)');
        return '';
      };
      for (let i = 0; i < order.lines.length; i++) {
        const ln = order.lines[i];
        if (i > 0) { const tc = await assertTradeOpen('line' + i); if (tc) return await fail('skipped', tc); }
        const form = await erp.getWriteForm({ tradeJun: res.tradeJun, master: ln.master.seq, client: res.client.seq, clientName: res.client.name });
        const chk = oiCheckForm(form, { client: res.client.seq, master: ln.master.seq, tradeJun: res.tradeJun, orderSeqs: res.orderSeqs });
        if (!chk.ok) return await fail('skipped', 'mismatch:' + chk.reason);
        const built = oiLinePayload(form, ln.master, ln.spec);
        if (built.issues.length) return await fail('skipped', 'payload:' + built.issues.join(','));
        let post;
        try { post = await erp.postLine(built.fields); }
        catch (e) { res.lineUnknown = true; return await fail('skipped', 'line_post_exception:' + String(e && e.message || e)); }
        log('line', { i, n: order.lines.length, ok: post.ok, msg: post.msg, tradeJun: post.tradeJun, rows: (post.rows || []).length });
        if (!post.ok) return await fail('skipped', 'line_failed:' + post.msg);
        const rows = post.rows || [];
        const fresh = rows.filter((r) => !res.orderSeqs.includes(r.orderSeq));
        //  POST 는 성공했는데 새 줄이 정확히 하나가 아니면 **어느 줄이 내 것인지 모른다** → 지우지 않고 멈춘다(Terra 4R P1).
        //  (남의 줄이 직전에 끼어든 경우 — 여기서 skipped 로 넘어가면 내 줄과 남의 줄이 열린 주문장에 남는다)
        if (rows.length !== res.orderSeqs.length + 1 || fresh.length !== 1) {
          res.lineUnknown = true;
          return await fail('skipped', 'rowmismatch:rows=' + rows.length + ',fresh=' + fresh.map((r) => r.orderSeq + '/' + r.code).join('|'));
        }
        //  둘째 줄부터 응답 tradeJun 이 바뀌면 어디에 붙었는지 모른다 → 코드 대조보다 **먼저** lineUnknown(Opus O2 P2 — 코드 불일치 분기가 먼저 잡으면 미검증 tradeJun 을 채택해 두 전표의 줄을 섞는다).
        const gotTrade = post.tradeJun || fresh[0].tradeJun;
        //  응답에 tradeJun 이 아예 없으면 내 줄이 어느 전표에 붙었는지 모른다 → 명시 사유로 lineUnknown(Opus O3 Nit — 이전엔 res.tradeJun 을 '' 로 덮어써 장부 tradeJun 이 사라지고 사유가 'T1≠' 로 남았다).
        if (!gotTrade) { res.lineUnknown = true; return await fail('skipped', 'trade_missing:line' + i); }
        if (res.tradeJun && String(gotTrade) !== String(res.tradeJun)) { res.lineUnknown = true; return await fail('skipped', 'trade_switched:' + gotTrade + '≠' + res.tradeJun); }
        //  새 줄이 정확히 하나인데 코드가 다르면 그 줄은 **내가 만든 줄이 확실**(매핑 seq 가 엉뚱한 상품) → 기록해 두고 일반 되돌리기(Terra 10R P1).
        if (fresh[0].code !== ln.master.code) {
          res.orderSeqs.push(fresh[0].orderSeq);
          res.idxValues.push(fresh[0].orderSeq + ',' + gotTrade);
          res.tradeJun = gotTrade;
          return await fail('skipped', 'code_mismatch:' + fresh[0].code + '≠' + ln.master.code);
        }
        res.orderSeqs.push(fresh[0].orderSeq);
        res.rowSnaps.push(Object.assign({}, fresh[0]));       // 등록 응답의 행 그대로 — 완료 직전 대조 기준(Terra 6R)
        res.idxValues.push(fresh[0].orderSeq + ',' + gotTrade);
        res.tradeJun = gotTrade;
      }
      //  세션 대조는 form10 GET **앞**에 둔다 — sKey 는 쓰기 직전 GET 의 것이어야 하므로(스펙 §4, Opus O2 P1) 그 사이에 다른 GET 을 끼우지 않는다. 줄 경로와 같은 모양.
      { const tc = await assertTradeOpen('complete'); if (tc) return await fail('skipped', tc); }
      const f10 = await erp.getForm10({ tradeJun: res.tradeJun, client: res.client.seq, clientName: res.client.name });
      const fin = oiCheckFinal(f10, { client: res.client.seq, tradeJun: res.tradeJun, orderSeqs: res.orderSeqs, lines: order.lines, snaps: res.rowSnaps });
      if (!fin.ok) return await fail('skipped', 'final:' + fin.reason);
      if (f10.missing && f10.missing.length) return await fail('skipped', 'form10 필드 누락: ' + f10.missing.join(','));
      //  완료 POST 를 **보내는 순간부터** 결과를 모르는 실패는 전부 '완료 미확인' 이다 — 응답이 유실돼도 서버는 완료했을 수 있다(Terra 2R P1).
      //  서버가 명시적으로 실패(msg)라고 답한 경우에만 되돌린다.
      res.completing = true;
      let done;
      try { done = await erp.postComplete(oiForm10Payload(f10.values, hooks && hooks.today ? hooks.today() : new Date())); }
      catch (e) { res.status = 'fatal'; res.reason = 'complete_unverified:exception:' + String(e && e.message || e); log('complete_exception', res.reason); return res; }
      log('complete', done);
      if (!done.ok) { res.completing = false; return await fail('skipped', 'complete_failed:' + done.msg); }
      res.completed = true;                                  // 이 시점부터는 어떤 실패도 되돌리지 않는다(위 fail 참조)
      const st2 = await erp.state();
      if (st2.tradeJun || st2.rows > 0) { res.status = 'fatal'; res.reason = 'session_not_clear'; return res; }
      //  관리번호 조회 실패/0건은 '완료는 됐지만 전표 미확인' 으로 남긴다 — done 으로만 보이면 사람이 확인할 계기가 없다(Terra 10R P2).
      try { res.junNums = await erp.findJunNums(res.orderSeqs.slice()); } catch (e) { res.junNums = []; log('junnum_error', String(e && e.message || e)); }
      if (!res.junNums.length) res.reason = '완료 응답 성공, 전표 미확인(관리번호 조회 실패) — 주문전표에서 직접 확인하세요';
      //  사후 검출(Terra 3R P1 부분 채택): 최종 대조 ~ 완료 POST 사이에 끼어든 남의 줄은 서버 잠금이 없어 막을 수 없다.
      //  대신 완료된 관리번호에 내 orderSeq 가 아닌 줄이 있으면 즉시 fatal 로 알린다(사람이 그 전표를 취소·재등록).
      if (res.junNums.length && typeof erp.listJunRows === 'function') {
        try {
          const mine = new Set(res.orderSeqs.map(String));
          const juns = new Set(res.junNums.map((j) => j.junNum).filter(Boolean));
          const foreign = (await erp.listJunRows()).filter((r) => juns.has(r.junNum) && !mine.has(String(r.orderSeq)));
          if (foreign.length) { res.status = 'fatal'; res.reason = 'foreign_line_completed:' + [...juns].join(',') + ' (' + foreign.map((r) => r.orderSeq).join(',') + ')'; log('foreign_line_completed', foreign); return res; }
        } catch (e) { log('foreign_check_error', String(e && e.message || e)); }
      }
      res.status = 'done'; return res;
    } catch (e) {
      return await fail('skipped', 'exception:' + String(e && e.message || e));
    }
  }

  //  주문장의 '상품 서명' — 줄마다 상품명|옵션|수량(공백 하나로·소문자)을 정렬해 잇는다. 장부 항목과 대조해
  //  "완전히 같은 주문번호+상품" 을 가린다(스펙 2026-09-16 §5b — 사장님: 그런 건은 사전에 경고해 포함 여부를 정하게).
  function oiOrderSig(order) {
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
    return ((order && order.lines) || []).map((l) => norm(l.productName) + '|' + norm(l.optionText) + '|' + String(l.qty == null ? '' : l.qty)).sort().join('\n');
  }
  //  장부 항목과 대조. sig 가 있는 항목만 정확히 가리고, 옛 항목(sig 없음)은 보수적으로 중복으로 본다.
  function oiDupCheck(order, entry) {
    if (!entry) return { dup: false, kind: 'none', entry: null };
    if (!entry.sig) return { dup: true, kind: 'legacy', entry };
    return entry.sig === oiOrderSig(order) ? { dup: true, kind: 'same', entry } : { dup: false, kind: 'diff', entry };
  }
  //  실행기 log(step) → 진행 스트립 문구. 모르는 step 은 마지막 문구를 유지한다(스펙 §3).
  const OI_STEP_LABEL = { guard: '세션 확인', client: '고객 확인', register: '고객 등록', complete: '주문장 완료 요청', junnum: '전표 조회', rollback: '되돌리는 중', fail: '되돌리는 중' };
  function oiStepLabel(step, info, last) {
    if (step === 'line') { const i = Number(info && info.i), n = Number(info && info.n); return '줄 ' + (isFinite(i) ? i + 1 : '?') + (isFinite(n) && n > 0 ? '/' + n : '') + ' 등록'; }
    return OI_STEP_LABEL[step] || last || '';
  }
  //  enrich 가 보낼 요청 수(진행 바 분모) — enrichBody 의 세 루프와 같은 조건.
  function oiEnrichTotal(orders, masters) {
    const seqs = new Set();
    (orders || []).forEach((o) => (o.lines || []).forEach((l) => { if (l.mapping && !(masters || {})[l.mapping.entry.seq]) seqs.add(String(l.mapping.entry.seq)); }));
    const customers = (orders || []).filter((o) => !o.customer && o.market && o.phone && o.phone.ok).length;
    const suggests = (orders || []).reduce((n, o) => n + (o.lines || []).filter((l) => !l.mapping && !l.suggest).length, 0);
    return { masters: seqs.size, customers, suggests, total: seqs.size + customers + suggests };
  }

  //  실행 결과 → UI 가 해야 할 일(체크 해제 여부·장부 기록). 순수 함수라 테스트로 고정한다(Opus 5 P1).
  //   - done → 해제 + 장부.  - 서버에 뭔가 남았을 수 있는 결과(완료 시도 이후 실패·되돌리지 못한 줄) → 해제 + 장부(unverified) → 재클릭 시 중복 주문장 방지·'이전에 넣음' 경고.
  //   - 완전히 되돌린 skipped·가드 skipped·blocked → 그대로(재시도 가능).
  function oiPostRunState(r, now) {
    if (!r) return { uncheck: false, ledgerEntry: null };
    const at = now || new Date().toISOString();
    const juns = (r.junNums || []).map((j) => j.junNum).filter(Boolean);
    const lines = (r.orderSeqs || []).length;
    if (r.status === 'done') return { uncheck: true, ledgerEntry: { at, tradeJun: r.tradeJun || '', junNums: juns, lines, sig: r.sig || '' } };
    //  lineUnknown(줄 POST 응답 유실)은 orderSeqs 가 비어 있어도 서버에 줄이 남았을 수 있다(Opus O2 P2).
    const mayRemain = !!(r.completing || r.completed || r.lineUnknown) || (lines > 0 && (r.rolledBack || 0) < lines);
    if (r.status !== 'blocked' && mayRemain) return { uncheck: true, ledgerEntry: { at, tradeJun: r.tradeJun || '', junNums: juns, lines, sig: r.sig || '', unverified: true, reason: r.reason || r.status } };
    return { uncheck: false, ledgerEntry: null };
  }

  //  주문장 순차 실행. fatal 이면 즉시 중단(이후 주문장은 'blocked').
  async function oiRunAll(orders, erp, hooks) {
    const results = [];
    let halted = false;
    for (const o of orders) {
      if (halted) { results.push({ key: o.key, status: 'blocked', reason: 'halted' }); continue; }
      let r;
      try { r = await oiRunOrder(o, erp, hooks); }
      catch (e) { r = { key: o.key, status: 'fatal', reason: 'runner_exception:' + String(e && e.message || e), client: null, tradeJun: '', orderSeqs: [], idxValues: [], junNums: [], rolledBack: 0, completed: false }; }
      results.push(r);
      try { hooks && hooks.onOrder && hooks.onOrder(r); } catch (_) {}
      if (r.status === 'fatal') halted = true;
    }
    return results;
  }

  const api = {
    MARKETS, COLS, REQUIRED, FORM1_NAMES, FORM10_NAMES, OI_MAX_LINES,
    oiMarket, oiHeaderMap, oiNormPhone, oiClientName, oiMoney, oiMoney0, oiComma, oiRemark, oiParseRows,
    oiParseOption, oiColorFromCode, oiFallbackColor, oiNormName, oiMapKeys, oiLookupMap, oiLearn, oiValidMapEntry, oiSuggestQueries,
    oiGroupOrders, oiApplyMarket, oiLineIssues,
    oiSelectOptions, oiFieldValue, oiExtractFields, oiExtractHidden, oiExtractArrays,
    oiTListAllRows, oiTListRows, oiWriteListRows, oiJunListRows, oiClientSearchRows, oiMasterSearchRows,
    oiReadWriteForm, oiReadForm10, oiResolveK, oiLinePayload, oiForm10Payload, oiSubmitResult,
    oiCheckForm, oiCheckFinal, oiRunOrder, oiRunAll, oiPostRunState,
    oiOrderSig, oiDupCheck, oiStepLabel, oiEnrichTotal
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof globalThis !== 'undefined') { globalThis.ubOi = api; }
})();
