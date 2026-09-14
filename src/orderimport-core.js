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
  function oiTListRows(html) {
    const h = String(html);
    const tre = /<table\b[^>]*\bclass\s*=\s*["']?t_list["']?[^>]*>/gi; let tm;
    while ((tm = tre.exec(h))) {
      const rows = oiScanTable(h, tm.index);
      if (rows.some((r) => r.idx !== null)) return rows.filter((r) => r.idx !== null);
    }
    return [];
  }
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
  function oiJunListRows(html) {
    return oiTListRows(html).map((row) => {
      const c = row.cells || [];
      const jm = String(c[2] || '').match(/(\d{7}[0-9A-Z]{3})\s*$/);
      return { orderSeq: String(row.idx || '').split(',')[0], junNum: jm ? jm[1] : '', title: c[4] || '', status: c[11] || '' };
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
    if (!color) color = oiColorFromCode((master && (master.colorFallback || master.code)) || '', form.colorOpts) || '';
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
    return { ok: true, reason: '' };
  }
  //  완료 직전: 행 수·orderSeq·상품코드·사이즈·수량·주문가를 검토 표(lines)와 대조.
  function oiCheckFinal(form, expect) {
    const base = oiCheckForm(form, expect);
    if (!base.ok) return base;
    const rows = form.rows || [];
    const lines = expect.lines || [];
    if (rows.length !== lines.length) return { ok: false, reason: 'rows ' + rows.length + '≠' + lines.length };
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

  const api = {
    MARKETS, COLS, REQUIRED, FORM1_NAMES, FORM10_NAMES,
    oiMarket, oiHeaderMap, oiNormPhone, oiClientName, oiMoney, oiComma, oiRemark, oiParseRows,
    oiParseOption, oiColorFromCode, oiNormName, oiMapKeys, oiLookupMap, oiLearn, oiSuggestQueries,
    oiGroupOrders, oiResolveK, oiLineIssues,
    oiSelectOptions, oiFieldValue, oiExtractFields, oiExtractHidden, oiExtractArrays,
    oiTListRows, oiWriteListRows, oiJunListRows, oiClientSearchRows, oiMasterSearchRows,
    oiReadWriteForm, oiReadForm10, oiLinePayload, oiForm10Payload, oiSubmitResult,
    oiCheckForm, oiCheckFinal
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof globalThis !== 'undefined') { globalThis.ubOi = api; }
})();
