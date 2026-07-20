/* =============================================================================
 *  statis.js — 상품집계(sheetStatisList) 제품별 판매 통계 (v1)
 *  loader 동적로드(MAIN world). 상품집계 페이지에서만 동작.
 *
 *  흐름: [제품별 통계화] 버튼 → 월 전체 데이터 POST 재조회(pageSize=500 순차)
 *        → 전표 조인 → 제품별 그룹핑 → 통계 오버레이 → XLSX 다운로드.
 *
 *  그룹핑 규칙(사용자 확정 2026-07-02):
 *   · 단가(총공급가 ÷ 수량) 범위 필터는 기본 무제한이다. 오버레이 상단에 사용자가
 *     최소/최대를 입력했을 때만 thresholdFilter 가 적용된다(0 = 무제한).
 *     ⚠ 구 파이프라인의 고정 하한 50,000원(PRICE_MIN)은 폐기됐다.
 *   · 자사(상품명이 "D자사/"로 시작): "D자사/" 제거 후 제품명 뒤 성별표기
 *     (SR·LR·S·L 모두)와 그 이후(옵션·괄호·/·*개) 잘라낸 것이 제품명.
 *     성별(SR/LR/S/L) 달라도 같은 제품명이면 합산.
 *     예) 루센트-폴드SR / 루센트-폴드LR → "루센트-폴드",
 *         피앙세SR-1(가드링) / 피앙세S-LR(1부DIA)/무광 → "피앙세",
 *         블링썸 메인-S → "블링썸 메인", 블링썸-L → "블링썸".
 *   · 사입(그 외): 이름 앞부분을 '(' 또는 '/' 전까지 코드로, 끝의 성별 S/L 1글자는
 *     떼어 병합. 예) E0121RS + E0121RL → "E0121R", N9405R/N9406R 는 숫자가 달라 별개.
 *
 *  loader 관리 파일이라 규칙 수정은 push 만으로 반영(crx 재배포 불필요).
 * ========================================================================== */
(function () {
  'use strict';
  if (!/\/statis\/sheet\/(saleitem|orderitem)\/sheetStatisList\.do/.test(location.pathname)) return;
  const IS_ORDER = /\/orderitem\//.test(location.pathname);

  const TAG = '[UB][statis]';
  const log = (...a) => { try { console.log(TAG, ...a); } catch (_) {} };
  const FETCH_PS = 500;
  const PAGE = IS_ORDER ? {
    lookup: buildLookup,
    joinKeyOf: (dRaw, prod, ss) => joinKey(dRaw, prod.barcode, ss.store, ss.staff),
    supLabel: '예상총공급가', priceLabel: '주문가',
    title: '주문 통계', subT: '예상총공급가=상품집계 · 직원·주문가=주문전표',
    staffColLabel: '주문직원', dateCol: /주문일/, xlsxName: orderXlsxName
  } : {
    lookup: buildSaleLookup,
    joinKeyOf: (dRaw, _prod, ss) => joinKey(dRaw, '', ss.store, ss.staff),
    supLabel: '공급가', priceLabel: '실판매가',
    title: '판매 통계', subT: '공급가·실판매가=상품집계 · 판매직원=매출전표',
    staffColLabel: '판매직원', dateCol: /판매일/, xlsxName: saleXlsxName
  };

  /* ---------- 숫자/문자 유틸 ---------- */
  // 셀에 두 줄로 숫자가 겹쳐 들어오는 경우가 있어 "첫 번째 숫자"만 취한다.
  function firstNum(s) {
    // ⚠유비샵 금액셀은 "206,111<br>206,111<br>0" 처럼 여러 숫자가 구분자 없이 붙는다.
    //   콤마 3자리 그룹으로 끝나는 '첫 정상 숫자'만 취한다(그리디 [\d,]+ 는 전체를 삼켜 오배).
    const m = String(s == null ? '' : s).match(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0].replace(/,/g, '')) : 0;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function nf(n) { try { return Math.round(n).toLocaleString('ko-KR'); } catch (_) { return String(n); } }
  function discountRate(sale, price) { return sale > 0 ? Math.round((sale - price) / sale * 1000) / 10 : null; }
  function discountText(sale, price) { const rate = discountRate(sale, price); return rate == null ? '—' : rate.toFixed(1) + '%'; }
  /* 이익율 = (실판매가 − 총입고가) ÷ 실판매가.
   *  집계에서는 '비율의 평균'이 아니라 **합계끼리 계산**한다(Σ실판매가, Σ총입고가).
   *  건별 비율을 평균내면 금액이 큰 건과 작은 건이 같은 무게가 되어 실제와 어긋난다.
   *
   *  값(profitRate)과 표시(profitText)를 나눈 이유:
   *   '0% 는 숨긴다'는 사용자 규칙은 **표의 행**을 위한 것이다(사은품이 많아 가독성을 해친다).
   *   요약 한 줄에까지 적용하면 '진짜 0%' 와 '낼 수 없음' 이 똑같이 '—' 로 보여 구분이 사라진다.
   *   그래서 은닉은 profitText 만 하고, 요약·정렬은 profitRate 를 직접 쓴다. */
  function profitRate(real, cost) {
    // ★원가 결측(null)은 0원이 아니다. 0으로 넘기면 이익율이 100% 로 부풀려 나온다 —
    //  '모르는 것'을 '이익 100%'로 보여주는 게 이 기능에서 제일 위험하다. 그래서 null.
    if (cost == null || !(real > 0)) return null;   // 실판매가 0 이하 = 사은품·100% 할인 → 나눌 수 없음
    return Math.round((real - cost) / real * 1000) / 10;
  }
  // 표의 행 표시. 낼 수 없거나(null) 정확히 0.0% 면 빈칸(사용자 요청 — 사은품 등 가독성).
  function profitText(real, cost) { const r = profitRate(real, cost); return (r == null || r === 0) ? '' : r.toFixed(1) + '%'; }
  // 금액 셀 → 숫자. 숫자가 하나도 없으면(빈 칸·'-') null = 결측. firstNum 은 0 을 돌려주므로 구분이 안 된다.
  function numOrNull(s) { return /\d/.test(String(s == null ? '' : s)) ? firstNum(s) : null; }

  const isJasa = (name) => /^D?자사\//.test(name);

  // 자사 제품명 추출: "D자사/" 제거 후
  //  ① 이름에 '보조' 포함 → 그 앞까지(부모 제품에 종속). 예) 프쉬케보조S → 프쉬케
  //  ② 성별표기 잘라내되 '피앙세'와 '피앙세S'는 별개 제품으로 구분:
  //     - SR·LR(2글자): 이름에 붙어 있어도 성별 → 앞까지. 예) 피앙세SR → 피앙세, 루센트-폴드SR → 루센트-폴드
  //     - 단독 S·L: '구분자(공백/하이픈) 뒤'일 때만 성별. 예) 블링썸 메인-S → 블링썸 메인, 블링썸-L → 블링썸
  //       (이름에 그대로 붙은 단독 S 는 제품명 일부: 피앙세S-LR → 피앙세S, 피앙세S → 피앙세S)
  function jasaBase(name) {
    let s = name.replace(/^D?자사\//, '').trim();
    const bo = s.indexOf('보조');
    if (bo > 0) return s.slice(0, bo).replace(/[\s\-/]+$/, '').trim() || name;
    let cut = -1;
    const m2 = s.match(/(SR|LR)(?=$|[\s\-(/*0-9])/);       // 2글자 성별(글자에 붙어도 성별)
    if (m2) cut = m2.index;
    const m1 = s.match(/[\s\-](S|L)(?=$|[\s\-(/*0-9])/);    // 구분자 뒤 단독 S/L (구분자 위치에서 자름)
    if (m1 && (cut < 0 || m1.index < cut)) cut = m1.index;
    if (cut < 0) { const p = s.search(/[(/]/); if (p >= 0) cut = p; }
    if (cut >= 0) s = s.slice(0, cut);
    return s.replace(/[\s\-/]+$/, '').trim() || name;
  }
  // 사입 코드: '(' 또는 '/' 전까지 → 끝 성별 S/L 1글자 제거(병합).
  function saipKey(name) {
    let s = String(name).split(/[(/]/)[0].trim();
    s = s.replace(/[SL]$/, '');
    return s.trim() || name;
  }

  /* ---------- 주문전표 셀 파서(order) ---------- */
  // 제품/고객 셀: "…제품명… <바코드(하이픈5+)> 고객1/고객2 주문 비고 …"
  //  · 바코드 = 영숫자 사이 하이픈 5개 이상. 앞쪽=매입처상품코드(제품명), '주문 비고' 앞=고객.
  function splitProdCell(cellText) {
    const t = String(cellText == null ? '' : cellText);
    const bc = t.match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+){4,}/);
    const barcode = bc ? bc[0] : '';
    const name = bc ? t.slice(0, bc.index).trim() : t.trim();
    const after = bc ? t.slice(bc.index + barcode.length) : '';
    const customer = after.split(/주문\s*비고/)[0].trim();
    return { barcode, name, customer };
  }
  // 상품집계(sheetStatisList) 제품셀: "<바코드> 옵션/제품명(…)/규격" → {barcode, name}
  //  · 주문전표와 달리 '주문 비고'·고객이 없음(고객은 매장셀 괄호 안). splitProdCell 응용.
  //  · 예) "T-BF-Q-WG-QB-00AN RD B/신주팔찌(Brass)/2.0m" → barcode=T-BF-Q-WG-QB-00AN,
  //    name=바코드 앞부분(있으면) 아니면 뒷부분. name 은 표시·그룹핑용(조인 키는 barcode).
  function splitSheetProd(cellText) {
    const t = String(cellText == null ? '' : cellText).replace(/\s+/g, ' ').trim();
    const bc = t.match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+){4,}/);
    const barcode = bc ? bc[0] : '';
    let name = t;
    if (bc) {
      const before = t.slice(0, bc.index).trim();
      const after = t.slice(bc.index + barcode.length).trim();
      name = before || after;   // 바코드가 맨 앞이면 뒷부분을 제품명으로
    }
    return { barcode, name };
  }
  // 매장/직원 셀: "매장명(직원명)" → {store, staff}
  //  · 상품집계에서는 괄호 안이 '고객명'이므로 호출부에서 staff→customer 로 해석해 재사용.
  function splitStoreStaff(ssText) {
    const s = String(ssText == null ? '' : ssText).replace(/\s+/g, ' ').trim();
    const mm = s.match(/^(.+?)\s*\((.+)\)\s*$/);
    return { store: mm ? mm[1].trim() : s, staff: mm ? mm[2].trim() : '' };
  }
  // 주문일 정규화: 숫자만 뽑아 YYMMDD 6자리(두 소스의 26-07-09 / 2026-07-09 형식 흡수).
  function normDate(s) {
    const d = String(s == null ? '' : s).replace(/\D/g, '');
    return d.length >= 6 ? d.slice(-6) : d;
  }
  // 조인 키 = 주문일|바코드|매장|고객 (상품집계 ↔ 주문전표 매칭용)
  function joinKey(date, barcode, store, customer) {
    return normDate(date) + '|' + String(barcode == null ? '' : barcode).trim() +
      '|' + String(store == null ? '' : store).trim() + '|' + String(customer == null ? '' : customer).trim();
  }
  // 헤더 셀 배열에서 정규식(배열) 중 하나라도 일치하는 첫 컬럼 인덱스
  function findCol(cells, res) {
    for (let i = 0; i < cells.length; i++) {
      for (const re of res) { if (re.test(cells[i])) return i; }
    }
    return -1;
  }

  /* ---------- 검색폼 → 전체 데이터 POST 재조회 ---------- */
  function formParams() {
    const f = document.querySelector('form[name="form1"]');
    if (!f) return null;
    const p = new URLSearchParams();
    for (const el of f.elements) {
      if (!el.name) continue;
      const t = (el.type || '').toLowerCase();
      if (['submit', 'button', 'reset', 'image', 'file'].includes(t)) continue;
      if ((t === 'checkbox' || t === 'radio') && !el.checked) continue;
      p.append(el.name, el.value == null ? '' : el.value);
    }
    return { action: f.getAttribute('action') || location.pathname, params: p };
  }
  function readTotal() {
    const m = document.body.innerText.match(/총\s*:?\s*([0-9,]+)\s*개/);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  }
  async function fetchHtml(action, params) {
    const r = await fetch(action, {
      method: 'POST', credentials: 'include', cache: 'no-cache',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: params.toString()
    });
    const buf = await r.arrayBuffer();
    return ubErp.decodeErpHtml(buf);
  }

  /* ---------- 주문전표(order) 조회·파싱 ---------- */
  // 집계 폼의 날짜(syear~eday)만 복사 + 주문전표 조회 파라미터 부여
  function orderParams() {
    const f = document.querySelector('form[name="form1"]');
    if (!f) return null;
    const g = n => { const el = f.elements[n]; return el ? (el.value == null ? '' : el.value) : ''; };
    const p = new URLSearchParams();
    ['syear', 'smonth', 'sday', 'eyear', 'emonth', 'eday'].forEach(n => p.set(n, g(n)));
    p.set('searchDateType', 'a.orderDate');
    p.set('tcode', 'order_item');
    p.set('searchSortType', 'seq');
    return p;
  }
  // 주문전표 응답 문서에서 t_list(수량 헤더 보유) → 컬럼 인덱스 + 데이터행
  function parseOrderDoc(doc) {
    for (const t of doc.querySelectorAll('table.t_list')) {
      let hi = -1, cells = null;
      for (const r of t.rows) {
        const cs = [...r.cells].map(c => c.textContent.replace(/\s+/g, ' ').trim());
        if (cs.some(c => /수량/.test(c))) { hi = r.rowIndex; cells = cs; break; }
      }
      if (hi < 0) continue;
      const rows = [];
      for (let i = hi + 1; i < t.rows.length; i++) {
        const r = t.rows[i];
        if (!/^\d+$/.test((r.cells[0] ? r.cells[0].textContent : '').replace(/\s+/g, ''))) continue;
        rows.push(r);
      }
      return {
        rows,
        cDate: findCol(cells, [/주문일/]),
        cProd: findCol(cells, [/고객명/, /매입처상품코드/]),
        cQty: findCol(cells, [/수량/]),
        cPrice: findCol(cells, [/주문가/]),
        cStore: findCol(cells, [/주문직원/, /매장명/])
      };
    }
    return null;
  }
  // 주문전표 응답 본문의 "총 : N 개" (렌더 안 된 문서라 textContent 사용)
  function readTotalDoc(doc) {
    const txt = doc && doc.body ? doc.body.textContent : '';
    const m = String(txt).match(/총\s*:?\s*([0-9,]+)\s*개/);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  }
  // 상품집계(sheetStatisList orderitem) 응답 → 컬럼 인덱스 + 데이터행
  //  예상총공급가(원가)·예상판매가의 primary 소스. 주문일/바코드/매장명/수량 컬럼 확보.
  function parseSheetOrderDoc(doc) {
    for (const t of doc.querySelectorAll('table.t_list')) {
      let hi = -1, cells = null;
      for (const r of t.rows) {
        const cs = [...r.cells].map(c => c.textContent.replace(/\s+/g, ' ').trim());
        if (cs.some(c => /수량/.test(c))) { hi = r.rowIndex; cells = cs; break; }
      }
      if (hi < 0) continue;
      const rows = [];
      for (let i = hi + 1; i < t.rows.length; i++) {
        const r = t.rows[i];
        if (!/^\d+$/.test((r.cells[0] ? r.cells[0].textContent : '').replace(/\s+/g, ''))) continue;
        rows.push(r);
      }
      return {
        rows,
        cDate: findCol(cells, [/주문일/]),
        cProd: findCol(cells, [/바코드/, /상품번호/]),
        cStore: findCol(cells, [/매장명/]),
        cQty: findCol(cells, [/수량/]),
        cSup: findCol(cells, [/예상총공급가|총공급가/]),
        cSale: findCol(cells, [/예상판매가|판매가/])
      };
    }
    return null;
  }

  /* ---------- 주문전표 lookup(직원·주문가) ---------- */
  // 날짜범위 키로 모듈 캐시(#4 페이지 직원열 주입과 통계 버튼이 공유, 1회 fetch).
  const _lookupCache = new Map();
  function orderDateKey() {
    const f = document.querySelector('form[name="form1"]');
    const g = n => { const el = f && f.elements[n]; return el ? el.value : ''; };
    return ['syear', 'smonth', 'sday', 'eyear', 'emonth', 'eday'].map(g).join('-');
  }
  async function buildLookup(setStatus) {
    const ckey = orderDateKey();
    if (_lookupCache.has(ckey)) return _lookupCache.get(ckey);
    const p0 = orderParams();
    if (!p0) return { map: new Map(), total: 0 };
    const action = location.origin + '/jun/orderitem/orderItemList.do?tcode=order_item';
    const map = new Map();
    let total = 0, pages = 1;
    for (let p = 1; p <= pages; p++) {
      if (setStatus) setStatus(p === 1 ? '주문전표 불러오는 중…' : `주문전표 ${total}건… (${p}/${pages})`);
      const params = new URLSearchParams(p0);
      params.set('pageSize', String(FETCH_PS));
      params.set('reqPage', String(p));
      const html = await fetchHtml(action, params);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      if (p === 1) { total = readTotalDoc(doc); pages = total > 0 ? Math.ceil(total / FETCH_PS) : 1; }
      const g = parseOrderDoc(doc);
      if (!g) break;
      for (const r of g.rows) {
        const prod = splitProdCell(g.cProd >= 0 && r.cells[g.cProd] ? r.cells[g.cProd].textContent : '');
        const ss = splitStoreStaff(g.cStore >= 0 && r.cells[g.cStore] ? r.cells[g.cStore].textContent : '');
        const dRaw = g.cDate >= 0 && r.cells[g.cDate] ? r.cells[g.cDate].textContent.replace(/\s+/g, '') : '';
        const price = g.cPrice >= 0 ? firstNum(r.cells[g.cPrice] && r.cells[g.cPrice].textContent) : 0;
        const k = PAGE.joinKeyOf(dRaw.slice(0, 8), prod, { store: ss.store, staff: prod.customer });
        if (!map.has(k)) map.set(k, { staff: ss.staff, price });
      }
    }
    const res = { map, total };
    _lookupCache.set(ckey, res);
    return res;
  }
  // 상품집계(primary) 전체 로드 → 주문전표 lookup 으로 직원·주문가 조인.
  async function orderLoadAll(setStatus) {
    const { map: lookup, total: orderTotal } = await PAGE.lookup(setStatus);
    const fp = formParams();
    if (!fp) throw new Error('검색폼(form1)을 찾지 못했습니다');
    const total = readTotal();
    const pages = total > 0 ? Math.ceil(total / FETCH_PS) : 1;
    const items = [];
    let matched = 0;
    for (let p = 1; p <= pages; p++) {
      setStatus(`상품집계 ${total}건 불러오는 중… (${p}/${pages})`);
      const params = new URLSearchParams(fp.params);
      params.set('tcode', 'statis_sheet_barcode');   // 상품집계(바코드) 강제
      params.set('pageSize', String(FETCH_PS));
      params.set('reqPage', String(p));
      const html = await fetchHtml(fp.action, params);
      const g = parseSheetOrderDoc(new DOMParser().parseFromString(html, 'text/html'));
      if (!g) throw new Error('상품집계 표(t_list)를 파싱하지 못했습니다 (로그인 만료?)');
      for (const r of g.rows) {
        const prod = splitSheetProd(g.cProd >= 0 && r.cells[g.cProd] ? r.cells[g.cProd].textContent : '');
        const ss = splitStoreStaff(g.cStore >= 0 && r.cells[g.cStore] ? r.cells[g.cStore].textContent : '');
        const store = ss.store, customer = ss.staff;   // 상품집계: 괄호 안 = 고객
        const dRaw = g.cDate >= 0 && r.cells[g.cDate] ? r.cells[g.cDate].textContent.replace(/\s+/g, '') : '';
        const hit = lookup.get(PAGE.joinKeyOf(dRaw, prod, ss));
        if (hit) matched++;
        items.push({
          date: dRaw, code: prod.barcode, name: prod.name, store, customer,
          qty: firstNum(r.cells[g.cQty] && r.cells[g.cQty].textContent),
          supExp: g.cSup >= 0 ? firstNum(r.cells[g.cSup] && r.cells[g.cSup].textContent) : 0,
          saleExp: g.cSale >= 0 ? firstNum(r.cells[g.cSale] && r.cells[g.cSale].textContent) : 0,
          price: hit ? hit.price : 0,
          staff: hit ? hit.staff : '(미지정)'
        });
      }
    }
    log('조인', matched + '/' + items.length);
    return { items, total, orderTotal, matched };
  }

  /* ---------- 매장매출전표 lookup(판매직원) ---------- */
  function saleParams() {
    const f = document.querySelector('form[name="form1"]');
    if (!f) return null;
    const g = n => { const el = f.elements[n]; return el ? (el.value == null ? '' : el.value) : ''; };
    const p = new URLSearchParams();
    ['syear', 'smonth', 'sday', 'eyear', 'emonth', 'eday'].forEach(n => p.set(n, g(n)));
    p.set('tcode', 'client_pay_jun');
    return p;
  }
  function parseSaleJunDoc(doc) {
    for (const t of doc.querySelectorAll('table.t_list')) {
      let hi = -1, cells = null;
      for (const r of t.rows) {
        const cs = [...r.cells].map(c => c.textContent.replace(/\s+/g, ' ').trim());
        if (cs.some(c => /매출장번호|거래구분/.test(c))) { hi = r.rowIndex; cells = cs; break; }
      }
      if (hi < 0) continue;
      const rows = [];
      for (let i = hi + 1; i < t.rows.length; i++) {
        const r = t.rows[i];
        if (!/^\d+$/.test((r.cells[0] ? r.cells[0].textContent : '').replace(/\s+/g, ''))) continue;
        rows.push(r);
      }
      return {
        rows,
        cStore: findCol(cells, [/매장명/]),
        cCustomer: findCol(cells, [/고객명/]),
        cKind: findCol(cells, [/거래구분/]),
        cStaff: findCol(cells, [/담당자/])
      };
    }
    return null;
  }
  async function buildSaleLookup(setStatus) {
    const ckey = 'sale|' + orderDateKey();
    if (_lookupCache.has(ckey)) return _lookupCache.get(ckey);
    const p0 = saleParams();
    if (!p0) return { map: new Map(), total: 0 };
    const action = location.origin + '/jun/clientpay/clientPayJunList.do?tcode=client_pay_jun';
    const map = new Map();
    let total = 0, pages = 1;
    for (let p = 1; p <= pages; p++) {
      if (setStatus) setStatus(p === 1 ? '매장매출전표 불러오는 중…' : `매장매출전표 ${total}건… (${p}/${pages})`);
      const params = new URLSearchParams(p0);
      params.set('pageSize', String(FETCH_PS));
      params.set('reqPage', String(p));
      const html = await fetchHtml(action, params);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      if (p === 1) { total = readTotalDoc(doc); pages = total > 0 ? Math.ceil(total / FETCH_PS) : 1; }
      const g = parseSaleJunDoc(doc);
      if (!g) break;
      for (const r of g.rows) {
        const kind = g.cKind >= 0 && r.cells[g.cKind] ? r.cells[g.cKind].textContent : '';
        if (!/상품판매/.test(kind)) continue;
        const storeRaw = g.cStore >= 0 && r.cells[g.cStore] ? r.cells[g.cStore].textContent.replace(/\s+/g, ' ').trim() : '';
        const sd = storeRaw.match(/^(.+?)(\d{2}-\d{2}-\d{2})/);
        if (!sd) continue;
        const customerRaw = g.cCustomer >= 0 && r.cells[g.cCustomer] ? r.cells[g.cCustomer].textContent : '';
        const customer = customerRaw.split('(')[0].trim();
        const staffCell = g.cStaff >= 0 ? r.cells[g.cStaff] : r.cells[r.cells.length - 1];
        const staff = staffCell ? staffCell.textContent.trim() : '';
        const k = PAGE.joinKeyOf(sd[2], { barcode: '' }, { store: sd[1].trim(), staff: customer });
        if (staff && !map.has(k)) map.set(k, { staff });
      }
    }
    const res = { map, total };
    _lookupCache.set(ckey, res);
    return res;
  }

  /* ---------- 판매 상품집계 + 매장매출전표 직원 조인 ---------- */
  function parseSheetSaleDoc(doc) {
    for (const t of doc.querySelectorAll('table.t_list')) {
      let hi = -1, cells = null;
      for (const r of t.rows) {
        const cs = [...r.cells].map(c => c.textContent.replace(/\s+/g, ' ').trim());
        if (cs.some(c => /수량/.test(c))) { hi = r.rowIndex; cells = cs; break; }
      }
      if (hi < 0) continue;
      const rows = [];
      for (let i = hi + 1; i < t.rows.length; i++) {
        const r = t.rows[i];
        if (!/^\d+$/.test((r.cells[0] ? r.cells[0].textContent : '').replace(/\s+/g, ''))) continue;
        rows.push(r);
      }
      return {
        rows,
        cDate: findCol(cells, [/판매일/]),
        cProd: findCol(cells, [/바코드/, /상품번호/]),
        cStore: findCol(cells, [/매장명/]),
        cQty: findCol(cells, [/수량/]),
        cSup: findCol(cells, [/^총공급가$/]),
        cSale: findCol(cells, [/^판매가$/]),
        cPrice: findCol(cells, [/실판매가/]),
        cCost: findCol(cells, [/^총입고가$/])   // 이익율 원가
      };
    }
    return null;
  }
  async function saleLoadAll(setStatus) {
    const { map: lookup, total: saleTotal } = await PAGE.lookup(setStatus);
    const fp = formParams();
    if (!fp) throw new Error('검색폼(form1)을 찾지 못했습니다');
    const total = readTotal();
    const pages = total > 0 ? Math.ceil(total / FETCH_PS) : 1;
    const action = location.origin + '/statis/sheet/saleitem/sheetStatisList.do?tcode=statis_sheet_barcode';
    const items = [];
    let matched = 0;
    for (let p = 1; p <= pages; p++) {
      setStatus(`상품집계 ${total}건 불러오는 중… (${p}/${pages})`);
      const params = new URLSearchParams(fp.params);
      params.set('tcode', 'statis_sheet_barcode');
      params.set('pageSize', String(FETCH_PS));
      params.set('reqPage', String(p));
      const html = await fetchHtml(action, params);
      const g = parseSheetSaleDoc(new DOMParser().parseFromString(html, 'text/html'));
      if (!g) throw new Error('상품집계 표(t_list)를 파싱하지 못했습니다 (로그인 만료?)');
      for (const r of g.rows) {
        const prod = splitSheetProd(g.cProd >= 0 && r.cells[g.cProd] ? r.cells[g.cProd].textContent : '');
        const ss = splitStoreStaff(g.cStore >= 0 && r.cells[g.cStore] ? r.cells[g.cStore].textContent : '');
        const store = ss.store, customer = ss.staff;
        const dRaw = g.cDate >= 0 && r.cells[g.cDate] ? r.cells[g.cDate].textContent.replace(/\s+/g, '') : '';
        const hit = lookup.get(PAGE.joinKeyOf(dRaw, prod, ss));
        if (hit) matched++;
        items.push({
          date: dRaw, code: prod.barcode, name: prod.name, store, customer,
          qty: firstNum(r.cells[g.cQty] && r.cells[g.cQty].textContent),
          supExp: g.cSup >= 0 ? firstNum(r.cells[g.cSup] && r.cells[g.cSup].textContent) : 0,
          saleExp: g.cSale >= 0 ? firstNum(r.cells[g.cSale] && r.cells[g.cSale].textContent) : 0,
          price: g.cPrice >= 0 ? firstNum(r.cells[g.cPrice] && r.cells[g.cPrice].textContent) : 0,
          // 원가(총입고가). 열이 없거나 칸이 비면 null = 결측 — 0 으로 두면 이익율이 100% 로 잘못 나온다.
          cost: g.cCost >= 0 ? numOrNull(r.cells[g.cCost] && r.cells[g.cCost].textContent) : null,
          staff: hit ? hit.staff : '(미지정)'
        });
      }
    }
    log('조인', matched + '/' + items.length);
    return { items, total, saleTotal, matched };
  }

  /* ---------- 수기 보정 매핑 ----------
   *  자동 그룹핑(jasaBase/saipKey)으로 안 잡히는 모델코드→제품명 변환 + 자사/사입 재분류.
   *  키 = 자동 그룹키(현재 제품명), 값 = { name?: 교정 제품명, type?: '자사'|'사입' }.
   *  같은 최종 제품명끼리는 자동 병합(예: A18/A18SR→쇼콜라티에, 블링썸/블링썸보조/블링썸 메인→블링썸).
   *  사용자가 엑셀 '변경된 제품명'·'변경된 구분' 열에 직접 채운 값에서 생성(2026-01~06 기준).
   *  새 코드가 생기면 이 표에 추가만 하면 됨(loader 파일이라 push 즉시 반영).
   */
  const OVERRIDE = {
    'H839': { name: '메이블리' },
    '라벤': { type: '사입' },
    '메리프': { type: '사입' },
    '토브': { type: '사입' },
    '시그니처라인': { name: '비투윈', type: '자사' },
    'N9405R': { name: '러스터S', type: '자사' },
    '웰리아': { type: '사입' },
    'N9402R': { name: '러스터 다이아', type: '자사' },
    '브라이트': { type: '사입' },
    'N9403R': { name: '러스터 다이아', type: '자사' },
    '미니시그니처라인': { name: '비투윈2', type: '자사' },
    'N9406R': { name: '러스터S', type: '자사' },
    'A18SR': { name: '쇼콜라티에', type: '자사' },
    '모어': { type: '사입' },
    'E0121R': { name: '모들 스퀘어', type: '자사' },
    '라움': { type: '사입' },
    '블링썸보조': { name: '블링썸', type: '자사' },
    'P1384': { name: '더-비투윈' },
    'E0101R': { name: '키싱유', type: '자사' },
    'A18': { name: '쇼콜라티에', type: '자사' },
    '프리메': { type: '사입' },
    '블링썸 메인': { name: '블링썸' },
    'N9043R-1': { name: '유우니S', type: '자사' },
    'MH1091': { name: '오웬' },
    'N9241SR-1': { name: '피앙세', type: '자사' },
    'E0102R': { name: '그리밍더블', type: '자사' },
    'N9395R-1': { name: '러스터 1부 다이아', type: '자사' },
    'N9422R-1': { name: '러스터 러브', type: '자사' },
    'IR652LR': { name: '에스텔라' }
  };

  /* ---------- 그룹핑 + 필터 ---------- */

  // 제품명 정규화 + 수기 보정(OVERRIDE) 적용 → {name, type}. 제품별·직원별 그룹 공용.
  function normProduct(rawName) {
    const jasa = isJasa(rawName);
    let name = jasa ? jasaBase(rawName) : saipKey(rawName);
    let type = jasa ? '자사' : '사입';
    const ov = OVERRIDE[name];
    if (ov) { if (ov.name) name = ov.name; if (ov.type) type = ov.type; }
    return { name, type };
  }
  // 라인단위 공급가 단가(공급가/수량) 범위 필터: min 이하·max 이상 제외(0=무제한).
  function thresholdFilter(items, min, max) {
    const lo = min > 0 ? min : 0, hi = max > 0 ? max : 0;
    if (!lo && !hi) return items;
    return items.filter(it => {
      const unit = it.qty > 0 ? it.supExp / it.qty : 0;
      if (lo && unit <= lo) return false;
      if (hi && unit >= hi) return false;
      return true;
    });
  }
  // 그룹에 원가를 더한다. 결측이 하나라도 있으면 그 그룹의 이익율은 내지 않는다
  //  (결측분을 빼고 합하면 분모는 그대로인데 원가만 작아져 이익율이 부풀려진다).
  function addCost(g, it) { if (it.cost == null) g.costMissing = true; else g.cost = (g.cost || 0) + it.cost; }
  /* ---------- 그룹핑(제품별): 수량/공급가/판매가 합산 ---------- */
  function buildOrderGroups(items) {
    const map = new Map();
    let gift = 0;
    for (const it of items) {
      const np = normProduct(it.name);   // 사은품 포함(제외 안 함) · 판매탭과 동일한 수기 보정 재사용
      let g = map.get(np.name);
      if (!g) { g = { type: np.type, name: np.name, qty: 0, supExp: 0, saleExp: 0, price: 0, cost: 0, costMissing: false, members: [] }; map.set(np.name, g); }
      g.type = np.type;
      g.qty += it.qty; g.supExp += it.supExp; g.saleExp += it.saleExp; g.price += it.price; addCost(g, it); g.members.push(it);
    }
    const groups = [...map.values()].sort((a, b) => b.qty - a.qty || b.supExp - a.supExp);
    return { groups, gift };
  }
  /* ---------- 그룹핑(직원별): 직원 → 그 직원이 계약한 제품 목록 ---------- */
  function buildStaffGroups(items) {
    const map = new Map();
    let gift = 0;
    for (const it of items) {
      const staff = it.staff || '(미지정)';
      let sg = map.get(staff);
      if (!sg) { sg = { staff, qty: 0, supExp: 0, saleExp: 0, price: 0, cost: 0, costMissing: false, products: new Map() }; map.set(staff, sg); }
      sg.qty += it.qty; sg.supExp += it.supExp; sg.saleExp += it.saleExp; sg.price += it.price; addCost(sg, it);
      const np = normProduct(it.name);
      let pg = sg.products.get(np.name);
      if (!pg) { pg = { name: np.name, type: np.type, qty: 0, supExp: 0, saleExp: 0, price: 0, cost: 0, costMissing: false, members: [] }; sg.products.set(np.name, pg); }
      pg.qty += it.qty; pg.supExp += it.supExp; pg.saleExp += it.saleExp; pg.price += it.price; addCost(pg, it); pg.members.push(it);
    }
    const groups = [...map.values()].sort((a, b) => b.qty - a.qty || b.supExp - a.supExp);
    groups.forEach(sg => { sg.productList = [...sg.products.values()].sort((a, b) => b.qty - a.qty || b.supExp - a.supExp); });
    return { groups, gift };
  }
  /* ---------- 그룹핑(매장별): 매장 → 해당 매장의 제품 목록 ---------- */
  function buildStoreGroups(items) {
    const map = new Map();
    for (const it of items) {
      const store = it.store || '(미지정)';
      let sg = map.get(store);
      if (!sg) { sg = { store, qty: 0, supExp: 0, saleExp: 0, price: 0, cost: 0, costMissing: false, products: new Map() }; map.set(store, sg); }
      sg.qty += it.qty; sg.supExp += it.supExp; sg.saleExp += it.saleExp; sg.price += it.price; addCost(sg, it);
      const np = normProduct(it.name);
      let pg = sg.products.get(np.name);
      if (!pg) { pg = { name: np.name, type: np.type, qty: 0, supExp: 0, saleExp: 0, price: 0, cost: 0, costMissing: false, members: [] }; sg.products.set(np.name, pg); }
      pg.qty += it.qty; pg.supExp += it.supExp; pg.saleExp += it.saleExp; pg.price += it.price; addCost(pg, it); pg.members.push(it);
    }
    const groups = [...map.values()].sort((a, b) => b.qty - a.qty || b.supExp - a.supExp);
    groups.forEach(sg => { sg.productList = [...sg.products.values()].sort((a, b) => b.qty - a.qty || b.supExp - a.supExp); });
    return groups;
  }

  /* ---------- XLSX (라이브러리 없이 최소 구현: stored ZIP) ---------- */
  const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_T[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(files) {
    const enc = new TextEncoder();
    const u16 = n => [n & 255, (n >>> 8) & 255];
    const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
    const parts = [], central = []; let offset = 0;
    for (const f of files) {
      const nameB = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const local = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(nameB.length), u16(0));
      parts.push(new Uint8Array(local), nameB, data);
      const cd = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(nameB.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(offset));
      central.push(new Uint8Array(cd), nameB);
      offset += local.length + nameB.length + data.length;
    }
    let cdSize = 0; for (const c of central) cdSize += c.length;
    const eocd = [].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(cdSize), u32(offset), u16(0));
    const all = parts.concat(central, [new Uint8Array(eocd)]);
    let total = 0; for (const a of all) total += a.length;
    const out = new Uint8Array(total); let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }
  function colRef(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = (i - (m + 1)) / 26; } return s; }
  function sheetXml(aoa) {
    let sd = '';
    aoa.forEach((row, ri) => {
      let cs = '';
      row.forEach((v, ci) => {
        const ref = colRef(ci) + (ri + 1);
        if (typeof v === 'number' && isFinite(v)) cs += `<c r="${ref}"><v>${v}</v></c>`;
        else cs += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      });
      sd += `<row r="${ri + 1}">${cs}</row>`;
    });
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      sd + '</sheetData></worksheet>';
  }
  function buildXlsx(aoa) {
    const enc = new TextEncoder();
    const files = [
      { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>') },
      { name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
      { name: 'xl/workbook.xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="제품별통계" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>') },
      { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml(aoa)) }
    ];
    return zipStore(files);
  }
  function downloadXlsx(aoa, fname) {
    const blob = new Blob([buildXlsx(aoa)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
  function orderXlsxName() {
    const f = document.querySelector('form[name="form1"]');
    const g = n => { const el = f && f.elements[n]; return el ? el.value : ''; };
    const s = `${g('syear')}${g('smonth')}${g('sday')}`;
    const e = `${g('eyear')}${g('emonth')}${g('eday')}`;
    return (s && e) ? `주문통계_${s}-${e}.xlsx` : '주문통계.xlsx';
  }
  function saleXlsxName() {
    const f = document.querySelector('form[name="form1"]');
    const g = n => { const el = f && f.elements[n]; return el ? el.value : ''; };
    const s = `${g('syear')}${g('smonth')}${g('sday')}`;
    const e = `${g('eyear')}${g('emonth')}${g('eday')}`;
    return (s && e) ? `판매통계_${s}-${e}.xlsx` : '판매통계.xlsx';
  }

  /* ---------- 통계 오버레이 ---------- */
  function ensureStyle() {
    if (document.getElementById('ub-stat-style')) return;
    const s = document.createElement('style');
    s.id = 'ub-stat-style';
    s.textContent = [
      // 디자인 지침: Pretendard. 페이지에 없어 폴백되던 문제 → 웹폰트 @font-face 로드.
      "@font-face{font-family:'PretendardUB';font-style:normal;font-weight:400 800;font-display:swap;src:url('https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/variable/woff2/PretendardVariable.woff2') format('woff2-variations');}",
      '#ub-stat-mask{position:fixed;inset:0;background:rgba(15,20,25,.55);z-index:2147483646;}',
      '#ub-stat{position:fixed;inset:4% 3%;background:#fff;border-radius:14px;z-index:2147483647;',
      " display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.4);font-family:'PretendardUB',Pretendard,'Malgun Gothic',sans-serif;color:#1b1b1b;overflow:hidden;}",
      '#ub-stat *{font-family:inherit;}',
      '#ub-stat .hd{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid #e5e7eb;}',
      '#ub-stat .hd .t{font-size:15px;font-weight:800;}',
      '#ub-stat .hd .sum{font-size:12px;color:#6b7280;}',
      '#ub-stat .hd .sp{margin-left:auto;display:flex;gap:8px;}',
      '#ub-stat .fbtns{display:flex;gap:4px;margin-left:8px;}',
      '#ub-stat .fbtn{padding:5px 12px;border-radius:999px;font-size:12px;font-weight:700;background:#eef1f5;color:#4b5563;border:0;cursor:pointer;}',
      '#ub-stat .fbtn.on{background:#35C5F0;color:#fff;}',
      '#ub-stat .osort{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#4b5563;font-weight:700;}',
      '#ub-stat .osort select{font-size:12px;padding:4px 6px;border:1px solid #d1d5db;border-radius:6px;background:#fff;color:#111;cursor:pointer;}',
      '#ub-stat .obtn{width:24px;height:24px;line-height:1;border:1px solid #d1d5db;border-radius:6px;background:#fff;color:#4b5563;cursor:pointer;font-size:11px;}',
      '#ub-stat .obtn:disabled{opacity:.4;cursor:default;}',
      '#ub-stat button{font-family:inherit;border:0;border-radius:8px;font-size:12.5px;font-weight:700;cursor:pointer;padding:8px 14px;}',
      '#ub-stat .bx{background:#1f8f52;color:#fff;} #ub-stat .bc{background:#eef1f5;color:#374151;}',
      '#ub-stat .bd{flex:1;overflow:auto;padding:0 18px 18px;}',
      '#ub-stat table{width:100%;border-collapse:collapse;font-size:12.5px;}',
      '#ub-stat thead th{position:sticky;top:0;background:#f3fbfe;color:#0f6f8c;font-weight:800;',
      ' padding:9px 8px;border-bottom:2px solid #35C5F0;text-align:right;white-space:nowrap;}',
      '#ub-stat thead th.l{text-align:left;}',
      // 정렬 가능한 헤더 — 현재 기준 열은 색으로, 방향은 ▲▼ 로 보여준다.
      '#ub-stat tbody td{padding:8px;border-bottom:1px solid #eef1f5;text-align:right;white-space:nowrap;}',
      '#ub-stat tbody td.l{text-align:left;} #ub-stat tbody tr.g{cursor:pointer;}',
      '#ub-stat tbody tr.g:hover{background:#f7fbfd;}',
      '#ub-stat .tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:700;}',
      '#ub-stat .tj{background:#e0f4fc;color:#0f8fb8;} #ub-stat .ts{background:#fdeede;color:#b8710f;}',
      '#ub-stat .rk{color:#9aa4af;font-weight:700;} #ub-stat .qty{font-weight:800;color:#111;}',
      '#ub-stat .exp{color:#35C5F0;font-weight:800;margin-left:5px;font-size:11px;user-select:none;}',
      '#ub-stat .det > td{background:#eef4f8;padding:8px 10px 12px 34px;}',
      '#ub-stat table.sub{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dbe6ee;border-radius:8px;overflow:hidden;}',
      '#ub-stat table.sub thead th{position:static;background:#f3f7fa;color:#54687a;font-weight:700;font-size:11px;',
      ' padding:6px 9px;border-bottom:1px solid #dce6ee;text-align:right;white-space:nowrap;}',
      '#ub-stat table.sub thead th.l{text-align:left;}',
      '#ub-stat table.sub tbody td{padding:5px 9px;border-bottom:1px solid #f1f5f8;text-align:right;font-size:11.5px;white-space:nowrap;color:#33414d;}',
      '#ub-stat table.sub tbody td.l{text-align:left;}',
      '#ub-stat table.sub tbody tr:nth-child(even){background:#fafcfe;}',
      '#ub-stat table.sub tbody tr:last-child td{border-bottom:0;}',
      '#ub-stat table.sub tbody td.c{color:#0f6f8c;font-weight:700;}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }
  // 직원별/제품별 오버레이 전용 스타일(orderitem·saleitem 공용).
  function ensureOrderStyle() {
    if (document.getElementById('ub-ostat-style')) return;
    const s = document.createElement('style');
    s.id = 'ub-ostat-style';
    s.textContent = [
      // 직원별/제품별 모달은 더 크게(기본 #ub-stat 은 미변경, 클래스로만 오버라이드)
      '#ub-stat.ub-o-wide{inset:2%;}',
      '#ub-stat .hd .sub-t{font-size:11.5px;color:#8a97a3;font-weight:600;margin-left:-6px;}',
      // 뷰 토글(직원별/제품별) 세그먼트
      '#ub-stat .vbtns{display:flex;gap:3px;background:#eef1f5;border-radius:9px;padding:3px;}',
      '#ub-stat .vbtn{padding:6px 15px;border-radius:7px;font-size:12.5px;font-weight:800;background:transparent;color:#5b6b78;border:0;cursor:pointer;}',
      '#ub-stat .vbtn.on{background:#1f8f52;color:#fff;box-shadow:0 1px 3px rgba(0,0,0,.15);}',
      // 필터 바(매장/직원/상품명/임계값)
      '#ub-stat .ofl{padding:11px 20px;border-bottom:1px solid #e5e7eb;display:flex;flex-direction:column;gap:8px;background:#fafcfe;}',
      '#ub-stat .ofl-row{display:flex;align-items:flex-start;gap:8px;font-size:12px;}',
      '#ub-stat .ofl-row2{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}',
      '#ub-stat .ofl-lb{flex:0 0 42px;font-weight:800;color:#0f6f8c;padding-top:3px;}',
      '#ub-stat .ofl-all{flex:0 0 auto;font-weight:700;color:#374151;padding-top:2px;white-space:nowrap;}',
      '#ub-stat .ofl-chips{display:flex;flex-wrap:wrap;gap:4px 10px;}',
      '#ub-stat .ofl-chip{display:inline-flex;align-items:center;gap:3px;color:#374151;white-space:nowrap;}',
      '#ub-stat .ofl-chip input,#ub-stat .ofl-all input,#ub-stat .ub-o-pick{vertical-align:middle;cursor:pointer;margin:0;}',
      '#ub-stat .ofl-search{flex:1;max-width:280px;padding:6px 10px;border:1px solid #cdd8e0;border-radius:7px;font-size:12px;}',
      '#ub-stat .ofl-thr{display:inline-flex;align-items:center;gap:6px;color:#374151;font-size:12px;font-weight:700;white-space:nowrap;}',
      '#ub-stat .ofl-thr input{width:88px;padding:6px 9px;border:1px solid #cdd8e0;border-radius:7px;font-size:12px;text-align:right;}',
      '#ub-stat .ofl-thr .u{color:#8a97a3;font-weight:600;}',
      // 표: 직원별/제품별 공통(밀도↑)
      '#ub-stat th.ub-ck,#ub-stat td.ub-ck{text-align:center;}',
      '#ub-stat .stf{font-weight:800;color:#111;}',
      '#ub-stat td.sup{color:#0f6f8c;font-weight:700;} #ub-stat td.prc{color:#1f8f52;font-weight:700;}',
      '#ub-stat table.sub tbody td.sup{color:#0f6f8c;} #ub-stat table.sub tbody td.prc{color:#1f8f52;}',
      '#ub-stat .miss{color:#b45309;font-weight:700;}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }
  function close() {
    ['ub-stat', 'ub-stat-mask'].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
  }
  /* ---------- 직원별/제품별/매장별 통계 오버레이(renderOrder) ---------- */
  //  기본 뷰 = 직원별(직원 → 그 직원 계약 제품). 제품별·매장별 토글 제공.
  //  공급가·판매가는 상품집계/PAGE 설정에 따르고 직원은 전표 조인. 임계값(공급가/수량) 이하 라인 숨김.
  function renderOrder(items, meta) {
    ensureStyle();
    ensureOrderStyle();
    close();
    const mask = document.createElement('div'); mask.id = 'ub-stat-mask';
    mask.addEventListener('click', close);
    const box = document.createElement('div'); box.id = 'ub-stat'; box.className = 'ub-o-wide';

    const stores = [...new Set(items.map(it => it.store).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
    const staffs = [...new Set(items.map(it => it.staff).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
    const selStores = new Set(stores);
    const selStaff = new Set(staffs);
    const excluded = new Set();       // 해제(제외)된 제품명(제품별 뷰) — 합계·XLSX에서 제외
    let view = 'staff';               // 'staff'(직원별, 기본) | 'product'(제품별) | 'store'(매장별)
    let typeFilter = 'all';
    let nameQuery = '';
    let thrMin = 0, thrMax = 0;       // 공급가 단가(공급가/수량) 범위. 이하·이상 숨김(0=무제한)
    let prodGroups = [];              // 매장∩직원∩임계값 라인 → 제품별 그룹
    let staffGroups = [];             // 동일 라인 → 직원별 그룹
    let storeGroups = [];             // 동일 라인 → 매장별 그룹
    let lastGift = 0;

    box.innerHTML =
      '<div class="hd">' +
        '<span class="t">' + esc(PAGE.title) + '</span>' +
        '<span class="sub-t">' + esc(PAGE.subT) + '</span>' +
        '<span class="vbtns">' +
          '<button class="vbtn on" data-v="staff">직원별</button>' +
          '<button class="vbtn" data-v="product">제품별</button>' +
          '<button class="vbtn" data-v="store">매장별</button>' +
        '</span>' +
        '<span class="fbtns">' +
          '<button class="fbtn on" data-f="all">전체</button>' +
          '<button class="fbtn" data-f="자사">자사</button>' +
          '<button class="fbtn" data-f="사입">타사</button>' +
        '</span>' +
        '<span class="osort">정렬 ' +
          '<select id="ub-o-sort">' +
            '<option value="">기본(수량)</option>' +
            '<option value="qty">수량</option>' +
            '<option value="supExp">' + esc(PAGE.supLabel) + '</option>' +
            '<option value="price">' + esc(PAGE.priceLabel) + '</option>' +
            (IS_ORDER ? '' : '<option value="disc">할인율</option><option value="profit">이익율</option>') +
          '</select>' +
          '<button class="obtn" id="ub-o-sortdir" title="오름/내림 전환">▼</button>' +
        '</span>' +
        '<span class="sp"><button class="bx" id="ub-stat-xlsx">엑셀(XLSX)</button><button class="bc" id="ub-stat-close">닫기</button></span>' +
      '</div>' +
      '<div class="ofl">' +
        '<div class="ofl-row"><span class="ofl-lb">매장</span>' +
          '<label class="ofl-all"><input type="checkbox" id="ub-o-store-all" checked> 전체</label>' +
          '<span class="ofl-chips" id="ub-o-stores"></span></div>' +
        '<div class="ofl-row"><span class="ofl-lb">직원</span>' +
          '<label class="ofl-all"><input type="checkbox" id="ub-o-staff-all" checked> 전체</label>' +
          '<span class="ofl-chips" id="ub-o-staffs"></span></div>' +
        '<div class="ofl-row2">' +
          '<input type="text" id="ub-o-search" class="ofl-search" placeholder="상품명으로 검색…">' +
          '<span class="ofl-thr">' + esc(PAGE.supLabel) + ' <input type="number" id="ub-o-thr-min" min="0" step="1000" value="0"> <span class="u">원 이하 ·</span> <input type="number" id="ub-o-thr-max" min="0" step="1000" value="0"> <span class="u">원 이상 숨김</span></span>' +
        '</div>' +
        '<div class="ofl-row"><span class="sum" id="ub-stat-sum"></span></div>' +
      '</div>' +
      '<div class="bd" id="ub-o-bd"></div>';

    document.body.appendChild(mask);
    document.body.appendChild(box);

    const bd = box.querySelector('#ub-o-bd');
    const sumEl = box.querySelector('#ub-stat-sum');
    const discountHead = IS_ORDER ? '' : '<th>할인율</th>';
    const discountCell = (sale, price) => IS_ORDER ? '' : `<td class="disc">${discountText(sale, price)}</td>`;
    const discountSummary = (sale, price) => IS_ORDER ? '' : ` · 할인율 ${discountText(sale, price)}`;
    // 이익율(판매탭 전용) — 할인율과 동일한 자리·방식. 원가 결측 그룹은 빈칸(부풀림 방지).
    const profitHead = IS_ORDER ? '' : '<th>이익율</th>';
    const profitCell = (o) => IS_ORDER ? '' : `<td class="disc">${o && o.costMissing ? '' : profitText(o ? o.price : 0, o ? o.cost : null)}</td>`;
    // 요약은 한 줄뿐이라 0% 를 숨기지 않는다 — 숨기면 '진짜 0%' 와 '낼 수 없음' 이 똑같이 '—' 가 된다.
    const profitSummary = (pr, cost, missing) => {
      if (IS_ORDER) return '';
      const r = missing ? null : profitRate(pr, cost);
      return ` · 이익율 ${r == null ? '—' : r.toFixed(1) + '%'}`;
    };

    /* ----- 정렬(헤더 바 컨트롤) : 기본은 기존과 같은 수량 내림차순 ----- */
    let oSortKey = '', oSortDesc = true;
    const oSortVal = (o, k) => {
      // 정렬은 '화면에 보이는 값' 기준이어야 한다 — 표에서 빈칸인 것(결측·0%)은 값이 없는 것으로
      //  보고 뒤로 보낸다. 그러지 않으면 빈 칸이 -5% 와 3% 사이에 끼어 오류처럼 보인다.
      if (k === 'profit') {
        const r = o.costMissing ? null : profitRate(o.price, o.cost);
        return r === 0 ? null : r;
      }
      if (k === 'disc') return discountRate(o.saleExp, o.price);
      return o[k] || 0;
    };
    function applySort(list) {
      if (!oSortKey) return list;
      const dir = oSortDesc ? -1 : 1;
      return list.slice().sort((a, b) => {
        const va = oSortVal(a, oSortKey), vb = oSortVal(b, oSortKey);
        // 이익율 '미표기'(원가 결측·사은품)는 정렬 방향과 무관하게 항상 뒤로 —
        //  0 으로 취급하면 오름차순에서 맨 앞을 채워 정작 보려는 낮은 이익율이 묻힌다.
        if (va == null && vb == null) return b.qty - a.qty;
        if (va == null) return 1;
        if (vb == null) return -1;
        return (va - vb) * dir || b.qty - a.qty;
      });
    }
    /* ----- 표시 필터(구분/검색) : 재그룹 없이 표시만 ----- */
    function productDisplay() {
      let list = prodGroups;
      if (typeFilter !== 'all') list = list.filter(g => g.type === typeFilter);
      if (nameQuery) { const q = nameQuery.toLowerCase(); list = list.filter(g => g.name.toLowerCase().indexOf(q) >= 0); }
      return applySort(list);
    }
    function countedProducts() { return productDisplay().filter(g => !excluded.has(g.name)); }
    function staffDisplay() {
      const q = nameQuery.toLowerCase();
      const out = [];
      staffGroups.forEach(sg => {
        let prods = sg.productList;
        if (typeFilter !== 'all') prods = prods.filter(p => p.type === typeFilter);
        if (q) prods = prods.filter(p => p.name.toLowerCase().indexOf(q) >= 0);
        if (!prods.length) return;
        out.push({
          staff: sg.staff, products: prods,
          qty: prods.reduce((a, p) => a + p.qty, 0),
          supExp: prods.reduce((a, p) => a + p.supExp, 0),
          saleExp: prods.reduce((a, p) => a + p.saleExp, 0),
          price: prods.reduce((a, p) => a + p.price, 0),
          // ★필터로 걸러진 목록에서 다시 합산한다 — 원본 그룹의 cost 를 쓰면 화면에 없는
          //  제품의 원가까지 섞여 이익율이 틀린다.
          cost: prods.reduce((a, p) => a + (p.cost || 0), 0),
          costMissing: prods.some(p => p.costMissing)
        });
      });
      out.sort((a, b) => b.qty - a.qty || b.supExp - a.supExp);
      return applySort(out);
    }
    function storeDisplay() {
      const q = nameQuery.toLowerCase();
      const out = [];
      storeGroups.forEach(sg => {
        let prods = sg.productList;
        if (typeFilter !== 'all') prods = prods.filter(p => p.type === typeFilter);
        if (q) prods = prods.filter(p => p.name.toLowerCase().indexOf(q) >= 0);
        if (!prods.length) return;
        out.push({
          store: sg.store, products: prods,
          qty: prods.reduce((a, p) => a + p.qty, 0),
          supExp: prods.reduce((a, p) => a + p.supExp, 0),
          saleExp: prods.reduce((a, p) => a + p.saleExp, 0),
          price: prods.reduce((a, p) => a + p.price, 0),
          // ★필터로 걸러진 목록에서 다시 합산한다 — 원본 그룹의 cost 를 쓰면 화면에 없는
          //  제품의 원가까지 섞여 이익율이 틀린다.
          cost: prods.reduce((a, p) => a + (p.cost || 0), 0),
          costMissing: prods.some(p => p.costMissing)
        });
      });
      out.sort((a, b) => b.qty - a.qty || b.supExp - a.supExp);
      return applySort(out);
    }
    const memStores = (mem) => [...new Set(mem.map(m => m.store).filter(Boolean))].join(', ');

    /* ----- 직원별 뷰 ----- */
    function renderStaffView() {
      const list = staffDisplay();
      let rows = '';
      list.forEach((sg, i) => {
        rows += '<tr class="g">' +
          `<td class="rk">${i + 1}</td>` +
          `<td class="l stf">${esc(sg.staff)} <span class="exp">▸</span></td>` +
          `<td class="qty">${nf(sg.qty)}</td>` +
          `<td class="sup">${nf(sg.supExp)}</td>` +
          `<td class="prc">${nf(sg.price)}</td>` +
          discountCell(sg.saleExp, sg.price) + profitCell(sg) +
          `<td>${sg.products.length}</td></tr>`;
        const pr = sg.products.map(p =>
          '<tr>' +
          `<td class="l">${esc(p.name)}</td>` +
          `<td>${nf(p.qty)}</td>` +
          `<td class="sup">${nf(p.supExp)}</td>` +
          `<td class="prc">${nf(p.price)}</td>` +
          discountCell(p.saleExp, p.price) + profitCell(p) +
          `<td class="l">${esc(memStores(p.members))}</td>` +
          '</tr>').join('');
        rows += '<tr class="det" style="display:none"><td></td><td colspan="' + (IS_ORDER ? 5 : 7) + '">' +
          '<table class="sub"><thead><tr>' +
          '<th class="l">제품명</th><th>수량</th><th>' + esc(PAGE.supLabel) + '</th><th>' + esc(PAGE.priceLabel) + '</th>' + discountHead + profitHead + '<th class="l">매장</th>' +
          `</tr></thead><tbody>${pr}</tbody></table></td></tr>`;
      });
      bd.innerHTML = '<table><thead><tr>' +
        '<th>#</th><th class="l">직원</th><th>총수량</th><th>총' + esc(PAGE.supLabel) + '</th><th>총' + esc(PAGE.priceLabel) + '</th>' + discountHead + profitHead + '<th>제품수</th>' +
        `</tr></thead><tbody>${rows}</tbody></table>`;
      bindExpanders();
    }

    /* ----- 제품별 뷰 ----- */
    function renderProductView() {
      const list = productDisplay();
      let rows = '';
      list.forEach((g, i) => {
        const on = !excluded.has(g.name);
        const tag = g.type === '자사' ? '<span class="tag tj">자사</span>' : '<span class="tag ts">사입</span>';
        rows += '<tr class="g">' +
          `<td class="ub-ck"><input type="checkbox" class="ub-o-pick"${on ? ' checked' : ''}></td>` +
          `<td class="rk">${i + 1}</td>` +
          `<td class="l">${esc(g.name)} <span class="exp">▸</span></td>` +
          `<td class="l">${tag}</td>` +
          `<td class="qty">${nf(g.qty)}</td>` +
          `<td class="sup">${nf(g.supExp)}</td>` +
          `<td class="prc">${nf(g.price)}</td>` +
          discountCell(g.saleExp, g.price) + profitCell(g) +
          `<td>${g.members.length}</td></tr>`;
        const memRows = g.members.slice().sort((a, b) => b.qty - a.qty).map(m =>
          '<tr>' +
          `<td class="l">${esc(m.name)}</td>` +
          `<td class="l">${esc(m.code)}</td>` +
          `<td>${nf(m.qty)}</td>` +
          `<td class="sup">${nf(m.supExp)}</td>` +
          `<td class="prc">${nf(m.price)}</td>` +
          discountCell(m.saleExp, m.price) + profitCell(m) +
          `<td class="l">${esc(m.store)}</td>` +
          `<td class="l${m.staff === '(미지정)' ? ' miss' : ''}">${esc(m.staff)}</td>` +
          `<td class="l">${esc(m.customer)}</td>` +
          '</tr>').join('');
        rows += '<tr class="det" style="display:none"><td></td><td colspan="' + (IS_ORDER ? 7 : 9) + '">' +
          '<table class="sub"><thead><tr>' +
          '<th class="l">상품명</th><th class="l">바코드</th><th>수량</th><th>' + esc(PAGE.supLabel) + '</th><th>' + esc(PAGE.priceLabel) + '</th>' + discountHead + profitHead + '<th class="l">매장</th><th class="l">직원</th><th class="l">고객</th>' +
          `</tr></thead><tbody>${memRows}</tbody></table></td></tr>`;
      });
      bd.innerHTML = '<table><thead><tr>' +
        '<th class="ub-ck"><input type="checkbox" id="ub-o-all" checked></th><th>#</th><th class="l">제품명</th><th class="l">구분</th><th>총수량</th><th>총' + esc(PAGE.supLabel) + '</th><th>총' + esc(PAGE.priceLabel) + '</th>' + discountHead + profitHead + '<th>코드수</th>' +
        `</tr></thead><tbody>${rows}</tbody></table>`;
      // 개별 ON/OFF 체크박스 배선(합계·XLSX 제외) — 제품별 뷰 전용, 현행 유지
      const allCb = bd.querySelector('#ub-o-all');
      const grows = [...bd.querySelectorAll('tr.g')];
      function syncAll() {
        const t = list.length, onN = list.filter(g => !excluded.has(g.name)).length;
        allCb.checked = t > 0 && onN === t;
        allCb.indeterminate = onN > 0 && onN < t;
      }
      grows.forEach((tr, idx) => {
        const g = list[idx];
        const cb = tr.querySelector('.ub-o-pick');
        cb.addEventListener('click', e => e.stopPropagation());
        cb.addEventListener('change', () => {
          if (cb.checked) excluded.delete(g.name); else excluded.add(g.name);
          renderSummary(); syncAll();
        });
      });
      allCb.addEventListener('change', function () {
        if (this.checked) list.forEach(g => excluded.delete(g.name));
        else list.forEach(g => excluded.add(g.name));
        this.indeterminate = false;
        renderProductView(); renderSummary();
      });
      bindExpanders(); syncAll();
    }

    /* ----- 매장별 뷰 ----- */
    function renderStoreView() {
      const list = storeDisplay();
      let rows = '';
      list.forEach((sg, i) => {
        rows += '<tr class="g">' +
          `<td class="rk">${i + 1}</td>` +
          `<td class="l stf">${esc(sg.store)} <span class="exp">▸</span></td>` +
          `<td class="qty">${nf(sg.qty)}</td>` +
          `<td class="sup">${nf(sg.supExp)}</td>` +
          `<td class="prc">${nf(sg.price)}</td>` +
          discountCell(sg.saleExp, sg.price) + profitCell(sg) +
          `<td>${sg.products.length}</td></tr>`;
        const pr = sg.products.map(p => {
          const tag = p.type === '자사' ? '<span class="tag tj">자사</span>' : '<span class="tag ts">사입</span>';
          return '<tr>' +
            `<td class="l">${esc(p.name)}</td>` +
            `<td class="l">${tag}</td>` +
            `<td>${nf(p.qty)}</td>` +
            `<td class="sup">${nf(p.supExp)}</td>` +
            `<td class="prc">${nf(p.price)}</td>` +
            discountCell(p.saleExp, p.price) + profitCell(p) +
            '</tr>';
        }).join('');
        rows += '<tr class="det" style="display:none"><td></td><td colspan="' + (IS_ORDER ? 5 : 7) + '">' +
          '<table class="sub"><thead><tr>' +
          '<th class="l">제품명</th><th class="l">구분</th><th>수량</th><th>' + esc(PAGE.supLabel) + '</th><th>' + esc(PAGE.priceLabel) + '</th>' + discountHead + profitHead +
          `</tr></thead><tbody>${pr}</tbody></table></td></tr>`;
      });
      bd.innerHTML = '<table><thead><tr>' +
        '<th>#</th><th class="l">매장</th><th>총수량</th><th>총' + esc(PAGE.supLabel) + '</th><th>총' + esc(PAGE.priceLabel) + '</th>' + discountHead + profitHead + '<th>제품수</th>' +
        `</tr></thead><tbody>${rows}</tbody></table>`;
      bindExpanders();
    }

    function bindExpanders() {
      bd.querySelectorAll('tr.g').forEach(tr => tr.addEventListener('click', () => {
        const det = tr.nextElementSibling;
        if (det && det.classList.contains('det')) {
          const open = det.style.display === 'none';
          det.style.display = open ? '' : 'none';
          const caret = tr.querySelector('.exp');
          if (caret) caret.textContent = open ? '▾' : '▸';
        }
      }));
    }

    function renderSummary() {
      if (view === 'staff') {
        const list = staffDisplay();
        const q = list.reduce((a, s) => a + s.qty, 0);
        const sup = list.reduce((a, s) => a + s.supExp, 0);
        const sale = list.reduce((a, s) => a + s.saleExp, 0);
        const pr = list.reduce((a, s) => a + s.price, 0);
        const cost = list.reduce((a, s) => a + (s.cost || 0), 0);
        const missing = list.some(s => s.costMissing);
        sumEl.textContent = `직원 ${list.length}명 · 총수량 ${nf(q)} · 총${PAGE.supLabel} ${nf(sup)}원 · 총${PAGE.priceLabel} ${nf(pr)}원${discountSummary(sale, pr)}${profitSummary(pr, cost, missing)} · 기간 ${meta}`;
      } else if (view === 'product') {
        const c = countedProducts();
        const q = c.reduce((a, g) => a + g.qty, 0);
        const sup = c.reduce((a, g) => a + g.supExp, 0);
        const sale = c.reduce((a, g) => a + g.saleExp, 0);
        const pr = c.reduce((a, g) => a + g.price, 0);
        const cost = c.reduce((a, g) => a + (g.cost || 0), 0);
        const missing = c.some(g => g.costMissing);
        sumEl.textContent = `제품군 ${c.length}개 · 총수량 ${nf(q)} · 총${PAGE.supLabel} ${nf(sup)}원 · 총${PAGE.priceLabel} ${nf(pr)}원${discountSummary(sale, pr)}${profitSummary(pr, cost, missing)} · 기간 ${meta}`;
      } else {
        const list = storeDisplay();
        const q = list.reduce((a, s) => a + s.qty, 0);
        const sup = list.reduce((a, s) => a + s.supExp, 0);
        const sale = list.reduce((a, s) => a + s.saleExp, 0);
        const pr = list.reduce((a, s) => a + s.price, 0);
        const cost = list.reduce((a, s) => a + (s.cost || 0), 0);
        const missing = list.some(s => s.costMissing);
        sumEl.textContent = `매장 ${list.length}개 · 총수량 ${nf(q)} · 총${PAGE.supLabel} ${nf(sup)}원 · 총${PAGE.priceLabel} ${nf(pr)}원${discountSummary(sale, pr)}${profitSummary(pr, cost, missing)} · 기간 ${meta}`;
      }
    }

    function render() {
      if (view === 'staff') renderStaffView();
      else if (view === 'product') renderProductView();
      else renderStoreView();
      box.querySelectorAll('.vbtn').forEach(b => b.classList.toggle('on', b.dataset.v === view));
      renderSummary();
    }
    function recompute() {
      const base = thresholdFilter(items.filter(it => selStores.has(it.store) && selStaff.has(it.staff)), thrMin, thrMax);
      const rp = buildOrderGroups(base); prodGroups = rp.groups; lastGift = rp.gift;
      const rs = buildStaffGroups(base); staffGroups = rs.groups;
      storeGroups = buildStoreGroups(base);
      render();
    }

    // 매장/직원 칩 생성 + 바인딩(변경 시 재계산)
    function buildChips(containerId, values, selSet, allId) {
      const cont = box.querySelector('#' + containerId);
      cont.innerHTML = values.map((v, i) =>
        `<label class="ofl-chip"><input type="checkbox" data-i="${i}" checked> ${esc(v)}</label>`).join('');
      const cbs = [...cont.querySelectorAll('input')];
      const all = box.querySelector('#' + allId);
      cbs.forEach((cb, i) => cb.addEventListener('change', () => {
        if (cb.checked) selSet.add(values[i]); else selSet.delete(values[i]);
        all.checked = cbs.every(x => x.checked);
        all.indeterminate = !all.checked && cbs.some(x => x.checked);
        recompute();
      }));
      all.addEventListener('change', () => {
        const on = all.checked;
        selSet.clear();
        cbs.forEach((cb, i) => { cb.checked = on; if (on) selSet.add(values[i]); });
        all.indeterminate = false;
        recompute();
      });
    }
    buildChips('ub-o-stores', stores, selStores, 'ub-o-store-all');
    buildChips('ub-o-staffs', staffs, selStaff, 'ub-o-staff-all');

    box.querySelector('#ub-stat-close').addEventListener('click', close);
    box.querySelectorAll('.vbtn').forEach(b => b.addEventListener('click', () => { view = b.dataset.v; render(); }));
    box.querySelectorAll('.fbtn').forEach(b => b.addEventListener('click', () => {
      typeFilter = b.dataset.f;
      box.querySelectorAll('.fbtn').forEach(x => x.classList.toggle('on', x.dataset.f === typeFilter));
      render();
    }));
    const sortDirBtn = box.querySelector('#ub-o-sortdir');
    const syncSortDir = () => {
      sortDirBtn.textContent = oSortDesc ? '▼' : '▲';
      sortDirBtn.disabled = !oSortKey;                       // 기본 정렬일 땐 방향이 의미 없다
      sortDirBtn.title = oSortKey ? (oSortDesc ? '내림차순 (클릭하면 오름차순)' : '오름차순 (클릭하면 내림차순)') : '정렬 기준을 먼저 고르세요';
    };
    box.querySelector('#ub-o-sort').addEventListener('change', e => {
      oSortKey = e.target.value;
      oSortDesc = true;                                      // 기준을 바꾸면 큰 값부터 — 매번 방향까지 맞추게 하지 않는다
      syncSortDir(); render();
    });
    sortDirBtn.addEventListener('click', () => { if (!oSortKey) return; oSortDesc = !oSortDesc; syncSortDir(); render(); });
    syncSortDir();
    box.querySelector('#ub-o-search').addEventListener('input', e => { nameQuery = e.target.value.trim(); render(); });
    let thrTimer = 0;
    const onThr = () => {
      clearTimeout(thrTimer);
      thrTimer = setTimeout(() => {
        thrMin = Math.max(0, firstNum(box.querySelector('#ub-o-thr-min').value));
        thrMax = Math.max(0, firstNum(box.querySelector('#ub-o-thr-max').value));
        recompute();
      }, 300);
    };
    box.querySelector('#ub-o-thr-min').addEventListener('input', onThr);
    box.querySelector('#ub-o-thr-max').addEventListener('input', onThr);
    box.querySelector('#ub-stat-xlsx').addEventListener('click', () => {
      let aoa;
      if (view === 'staff') {
        aoa = [['순위', '직원', '총수량', '총' + PAGE.supLabel, '총' + PAGE.priceLabel, '제품수']];
        if (!IS_ORDER) aoa[0].splice(5, 0, '할인율', '이익율');
        staffDisplay().forEach((s, i) => {
          const row = [i + 1, s.staff, s.qty, Math.round(s.supExp), Math.round(s.price), s.products.length];
          if (!IS_ORDER) row.splice(5, 0, discountText(s.saleExp, s.price), s.costMissing ? '' : profitText(s.price, s.cost));
          aoa.push(row);
        });
      } else if (view === 'product') {
        aoa = [['순위', '제품명', '구분', '총수량', '총' + PAGE.supLabel, '총' + PAGE.priceLabel, '코드수']];
        if (!IS_ORDER) aoa[0].splice(6, 0, '할인율', '이익율');
        countedProducts().forEach((g, i) => {
          const row = [i + 1, g.name, g.type, g.qty, Math.round(g.supExp), Math.round(g.price), g.members.length];
          if (!IS_ORDER) row.splice(6, 0, discountText(g.saleExp, g.price), g.costMissing ? '' : profitText(g.price, g.cost));
          aoa.push(row);
        });
      } else {
        aoa = [['순위', '매장', '총수량', '총' + PAGE.supLabel, '총' + PAGE.priceLabel, '제품수']];
        if (!IS_ORDER) aoa[0].splice(5, 0, '할인율', '이익율');
        storeDisplay().forEach((s, i) => {
          const row = [i + 1, s.store, s.qty, Math.round(s.supExp), Math.round(s.price), s.products.length];
          if (!IS_ORDER) row.splice(5, 0, discountText(s.saleExp, s.price), s.costMissing ? '' : profitText(s.price, s.cost));
          aoa.push(row);
        });
      }
      downloadXlsx(aoa, PAGE.xlsxName());
      log(PAGE.title.replace(' 통계', '') + ' xlsx 저장', PAGE.xlsxName(), aoa.length - 1, '행', 'view=' + view);
    });

    recompute();
    log(PAGE.title + ' 렌더', { items: items.length, stores: stores.length, staffs: staffs.length, products: prodGroups.length, staff: staffGroups.length, store: storeGroups.length });
  }

  /* ---------- 버튼 ---------- */
  let running = false;
  async function runStats(btn) {
    if (running) return; running = true;
    const orig = btn.textContent;
    const setStatus = (t) => { btn.textContent = t; };
    btn.disabled = true;
    try {
      const f = document.querySelector('form[name="form1"]');
      const g = n => { const el = f && f.elements[n]; return el ? el.value : ''; };
      if (IS_ORDER) {
        const { items, total, orderTotal, matched } = await orderLoadAll(setStatus);
        const meta = `${g('syear')}-${g('smonth')}-${g('sday')} ~ ${g('eyear')}-${g('emonth')}-${g('eday')} (집계 ${total}건 · 전표조인 ${matched}/${items.length}, 전표 ${orderTotal}건)`;
        renderOrder(items, meta);
      } else {
        const { items, total, saleTotal, matched } = await saleLoadAll(setStatus);
        const meta = `${g('syear')}-${g('smonth')}-${g('sday')} ~ ${g('eyear')}-${g('emonth')}-${g('eday')} (집계 ${total}건 · 매출전표조인 ${matched}/${items.length}, 전표 ${saleTotal}건)`;
        renderOrder(items, meta);
      }
    } catch (e) {
      log('실패', e);
      alert('통계화 실패: ' + (e && e.message ? e.message : e));
    } finally {
      running = false; btn.disabled = false; btn.textContent = orig;
    }
  }
  function addButton() {
    const anchor = document.querySelector('select[name="searchSortType"]');
    if (!anchor) { if (!addButton._n) { addButton._n = 1; setTimeout(addButton, 600); } return; }
    if (document.getElementById('ub-stat-btn')) return;
    const b = document.createElement('button');
    b.id = 'ub-stat-btn';
    b.type = 'button';
    b.textContent = '제품별 통계화';
    b.title = IS_ORDER ? '직원별/제품별/매장별 주문 통계(상품집계+주문전표 조인)' : '직원별/제품별/매장별 판매 통계(상품집계+매장매출전표 조인)';
    b.style.cssText = 'margin-left:6px;padding:3px 12px;background:#35C5F0;color:#fff;border:0;border-radius:6px;' +
      'font:700 12px/1.5 Pretendard,sans-serif;cursor:pointer;vertical-align:middle;';
    b.addEventListener('click', () => runStats(b));
    // skin.js 의 수량정렬 드롭다운 뒤에 오도록 약간 늦게 삽입
    anchor.parentNode.appendChild(b);
    log('통계화 버튼 추가');
  }

  /* ---------- #4 페이지 결과표에 '직원' 열 자동 주입 ---------- */
  //  상품집계 결과표 리디자인(2026) + 직원열(전표 조인) + 직원별 보기 그룹핑.
  let _injecting = false, _injTimer = 0, _mo = null, _groupOn = false;
  function ensureOrderTableStyle() {
    if (document.getElementById('ub-otbl-style')) return;
    const s = document.createElement('style');
    s.id = 'ub-otbl-style';
    s.textContent = [
      "@font-face{font-family:'PretendardUB';font-style:normal;font-weight:100 900;font-display:swap;src:url('https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/variable/woff2/PretendardVariable.woff2') format('woff2-variations');}",
      "table.t_list.ubm{border-collapse:separate;border-spacing:0;font-family:'PretendardUB','Malgun Gothic',sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-feature-settings:'tnum' 1;letter-spacing:-.01em;color:#3d4b57;}",
      'table.t_list.ubm *{font-family:inherit;}',   /* ★페이지 폰트 규칙(.f_bold 등) 무력화 → Pretendard 강제 */
      'table.t_list.ubm td,table.t_list.ubm th{border:0;vertical-align:middle;}',
      'table.t_list.ubm tr.sum1 td{background:#f2f9fc;color:#0e2a37;font-weight:700;font-size:12.5px;padding:13px 9px;border-bottom:1px solid #e2eef4;letter-spacing:0;}',
      'table.t_list.ubm tr.sum1 td[align=right]{font-variant-numeric:tabular-nums;}',
      'table.t_list.ubm tr.sum1 .f_gray{display:none;}',
      'table.t_list.ubm tr.title_line td,table.t_list.ubm tr.title_line th{background:linear-gradient(180deg,#123542,#0e2a37);color:#c6e8f4;font-weight:600;font-size:11.5px;padding:12px 8px;text-align:center;white-space:nowrap;border-bottom:2px solid #2fbfe8;line-height:1.3;letter-spacing:.01em;}',
      'table.t_list.ubm tr.title_line th.ub-staff-h{color:#86e8ff;}',
      'table.t_list.ubm tr.ubm-row td{padding:10px 9px;color:#3d4b57;border-bottom:1px solid #edf1f4;line-height:1.4;font-weight:450;font-size:12px;text-align:center;}',
      'table.t_list.ubm tr.ubm-row:nth-child(even) td{background:#fafcfd;}',
      'table.t_list.ubm tr.ubm-row:hover td{background:#eef8fc;}',
      'table.t_list.ubm tr.ubm-row td[align=right]{text-align:center;font-variant-numeric:tabular-nums;font-weight:500;color:#2a3742;}',
      'table.t_list.ubm tr.ubm-row td[align=right] .f_gray{display:none;}',
      'table.t_list.ubm tr.ubm-row td.ub-date-c{white-space:nowrap;}',
      'table.t_list.ubm .f_bold{font-weight:600;color:#1e2a33;}',
      'table.t_list.ubm .f_gray{color:#aeb9c3;font-size:10px;font-weight:400;}',
      'table.t_list.ubm .f_blue_note{color:#2b8db6;font-weight:500;}',
      'table.t_list.ubm .f_green{display:inline-block;padding:3px 10px;border-radius:999px;background:#e6f7ee;color:#12995a;font-weight:600;font-size:10.5px;letter-spacing:0;}',
      'table.t_list.ubm .f_red{display:inline-block;padding:3px 10px;border-radius:999px;background:#fdecec;color:#e0483f;font-weight:600;font-size:10.5px;letter-spacing:0;}',
      /* ★셀(td) 자체에 f_red/f_green 클래스가 붙는 경우(DC금액 등) inline-block pill 이 되면 셀이 행에서 이탈 → 일반 셀 + 색 텍스트로 복원(pill 은 셀 안 span 에만) */
      'table.t_list.ubm td.f_red,table.t_list.ubm td.f_green{display:table-cell;background:transparent;padding:10px 9px;border-radius:0;vertical-align:middle;font-size:12px;font-variant-numeric:tabular-nums;}',
      'table.t_list.ubm td.f_red{color:#d64b43;font-weight:600;}',
      'table.t_list.ubm td.f_green{color:#12995a;font-weight:600;}',
      'table.t_list.ubm img{border-radius:9px;box-shadow:0 1px 3px rgba(16,40,60,.16);}',
      'table.t_list.ubm td.ub-staff-c{text-align:center;}',
      'table.t_list.ubm td.ub-staff-c .stf{display:inline-block;padding:4px 11px;border-radius:999px;background:#e4f4fb;color:#0d7ba0;font-weight:700;font-size:11px;letter-spacing:-.01em;white-space:nowrap;}',
      'table.t_list.ubm td.ub-staff-c .stf.miss{background:#f1f3f5;color:#9aa6b0;}',
      'table.t_list.ubm tr.ubm-grp td{background:#0e2a37;color:#eaf7fc;font-weight:700;font-size:12px;padding:10px 15px;text-align:left;letter-spacing:0;}',
      'table.t_list.ubm tr.ubm-grp td .cnt{color:#86e8ff;font-weight:600;margin-left:8px;font-size:11px;}',
      'table.t_list.ubm tr.ubm-grp td .sub{float:right;color:#a9cede;font-weight:500;font-size:11px;font-variant-numeric:tabular-nums;}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }
  function restoreOrder(table) {
    const tb = table.tBodies[0] || table;
    [...table.querySelectorAll('tr.ubm-row')]
      .sort((a, b) => (+a.dataset.ubOrd || 0) - (+b.dataset.ubOrd || 0))
      .forEach(r => tb.appendChild(r));
  }
  function applyGroup(table, headRow, cSup) {
    const tb = table.tBodies[0] || table;
    const by = new Map();
    [...table.querySelectorAll('tr.ubm-row')].forEach(r => {
      const el = r.querySelector('.stf');
      const s = (el ? el.textContent : '').trim() || '(미지정)';
      if (!by.has(s)) by.set(s, []);
      by.get(s).push(r);
    });
    const colspan = headRow.cells.length;
    [...by.keys()].sort((a, b) => by.get(b).length - by.get(a).length).forEach(s => {
      const list = by.get(s);
      let sup = 0;
      if (cSup >= 0) list.forEach(r => { sup += firstNum(r.cells[cSup] ? r.cells[cSup].textContent : ''); });
      const g = document.createElement('tr');
      g.className = 'ubm-grp';
      g.innerHTML = '<td colspan="' + colspan + '">● ' + esc(s) + ' <span class="cnt">' + list.length + '건</span>' +
        (cSup >= 0 ? '<span class="sub">' + esc(PAGE.supLabel) + ' ' + Math.round(sup).toLocaleString('ko-KR') + '원</span>' : '') + '</td>';
      tb.appendChild(g);
      list.forEach(r => tb.appendChild(r));
    });
  }
  function addGroupToggle() {
    const anchor = document.querySelector('select[name="searchSortType"]');
    if (!anchor || document.getElementById('ub-grp-btn')) return;
    const b = document.createElement('button');
    b.id = 'ub-grp-btn';
    b.type = 'button';
    b.textContent = '직원별 보기';
    b.style.cssText = 'margin-left:6px;padding:3px 12px;border:0;border-radius:6px;font:700 12px/1.5 Pretendard,sans-serif;cursor:pointer;vertical-align:middle;';
    const paint = () => { b.style.background = _groupOn ? '#0e2a37' : '#eaf1f5'; b.style.color = _groupOn ? '#fff' : '#41525e'; };
    paint();
    b.addEventListener('click', () => { _groupOn = !_groupOn; paint(); safeInject(); });
    anchor.parentNode.appendChild(b);
  }
  async function enhanceOrderTable() {
    ensureOrderTableStyle();
    let table = null, headRow = null, cells = null;
    for (const t of document.querySelectorAll('table.t_list')) {
      for (const r of t.rows) {
        const cs = [...r.cells].map(c => c.textContent.replace(/\s+/g, ' ').trim());
        if (cs.some(c => /수량/.test(c))) { table = t; headRow = r; cells = cs; break; }
      }
      if (table) break;
    }
    if (!table || !headRow) return;
    table.classList.add('ubm');
    const cDate = findCol(cells, [PAGE.dateCol]);
    const cProd = findCol(cells, [/바코드/, /상품번호/]);
    const cStore = findCol(cells, [/매장명/]);
    const cSup = findCol(cells, [new RegExp(PAGE.supLabel), /총공급가/]);
    const cSale = findCol(cells, [/^판매가$/]);
    const cPrice = findCol(cells, [/실판매가/]);
    const cDc = findCol(cells, [/^DC금액$/]);
    const cConvert = findCol(cells, [/전환\s*P|전환포인트/, /^할인율$/]);
    const cCost = findCol(cells, [/^총입고가$/]);
    const cLink = findCol(cells, [/^연결번호$/, /^이익율$/]);   // 연결번호 슬롯을 이익율로 재사용
    // 데이터행: ubm-row 부여 + 인라인 hover 제거(CSS hover 적용) + 원본순서 기록
    let ord = 0;
    for (const r of table.rows) {
      if (r === headRow || r.classList.contains('sum1') || r.classList.contains('ubm-grp')) continue;
      if (!/^\d+$/.test((r.cells[0] ? r.cells[0].textContent : '').replace(/\s+/g, ''))) continue;
      if (!r.classList.contains('ubm-row')) { r.classList.add('ubm-row'); r.onmouseover = null; r.onmouseout = null; }
      if (!r.dataset.ubOrd) r.dataset.ubOrd = String(ord);
      if (cDate >= 0 && r.cells[cDate]) r.cells[cDate].classList.add('ub-date-c');
      ord++;
    }
    // 판매탭의 전환P 슬롯을 할인율로 재사용(열 추가/삭제 없음).
    if (!IS_ORDER && cConvert >= 0) {
      headRow.cells[cConvert].textContent = '할인율';
      for (const r of table.querySelectorAll('tr.ubm-row')) {
        const sale = cSale >= 0 && r.cells[cSale] ? firstNum(r.cells[cSale].textContent) : 0;
        const price = cPrice >= 0 && r.cells[cPrice] ? firstNum(r.cells[cPrice].textContent) : 0;
        const dc = cDc >= 0 && r.cells[cDc] ? firstNum(r.cells[cDc].textContent) : sale - price;
        r.cells[cConvert].textContent = sale > 0 ? (Math.round(dc / sale * 1000) / 10).toFixed(1) + '%' : '—';
      }
    }
    // 판매탭의 연결번호 슬롯을 이익율로 재사용(할인율과 같은 방식 — 열 추가/삭제 없음).
    //  ⚠ 0% 와 계산 불가(실판매가 0 = 사은품 등)는 빈칸으로 둔다 — 사용자 요청(가독성).
    //  ★총입고가 열이 없으면 아예 손대지 않는다(연결번호를 그대로 둔다). 원가를 0 으로 가정하면
    //   모든 행이 '이익율 100%' 로 표시되어 완전히 잘못된 숫자를 보여주게 된다.
    if (!IS_ORDER && cLink >= 0 && cCost >= 0) {
      headRow.cells[cLink].textContent = '이익율';
      for (const r of table.querySelectorAll('tr.ubm-row')) {
        const real = cPrice >= 0 && r.cells[cPrice] ? firstNum(r.cells[cPrice].textContent) : 0;
        const cost = r.cells[cCost] ? numOrNull(r.cells[cCost].textContent) : null;
        r.cells[cLink].textContent = profitText(real, cost);
      }
    }
    // 직원열(전표 조인) — lookup 있으면
    if (cProd >= 0 && cStore >= 0) {
      let lookup = null;
      try { lookup = (await PAGE.lookup(null)).map; } catch (_) {}
      if (lookup && lookup.size) {
        if (!headRow.querySelector('th.ub-staff-h')) {
          const th = document.createElement('th');
          th.className = 'ub-staff-h';
          th.textContent = PAGE.staffColLabel;
          headRow.appendChild(th);
        }
        for (const r of table.querySelectorAll('tr.ubm-row')) {
          if (r.querySelector('td.ub-staff-c')) continue;
          const prod = splitSheetProd(r.cells[cProd] ? r.cells[cProd].textContent : '');
          const ss = splitStoreStaff(r.cells[cStore] ? r.cells[cStore].textContent : '');
          const dRaw = cDate >= 0 && r.cells[cDate] ? r.cells[cDate].textContent.replace(/\s+/g, '') : '';
          const hit = lookup.get(PAGE.joinKeyOf(dRaw, prod, ss));   // 괄호 안 = 고객
          const td = document.createElement('td');
          td.className = 'ub-staff-c';
          const sp = document.createElement('span');
          sp.className = 'stf' + (hit ? '' : ' miss');
          sp.textContent = hit ? hit.staff : '-';
          td.appendChild(sp);
          r.appendChild(td);
        }
      }
    }
    // 직원별 보기: 그룹핑 or 원복
    [...table.querySelectorAll('tr.ubm-grp')].forEach(x => x.remove());
    if (_groupOn) { applyGroup(table, headRow, cSup); table.dataset.ubGrouped = '1'; }
    else if (table.dataset.ubGrouped) { restoreOrder(table); table.dataset.ubGrouped = ''; }
    addGroupToggle();
  }
  async function safeInject() {
    if (_injecting) return;
    _injecting = true;
    if (_mo) { try { _mo.disconnect(); } catch (_) {} }   // 우리 변경은 관측 안 함 → 루프 방지
    try { await enhanceOrderTable(); } catch (_) { /* 조용히 무시 */ }
    finally { _injecting = false; if (_mo) setTimeout(() => { try { _mo.observe(document.body, { childList: true, subtree: true }); } catch (_) {} }, 80); }
  }
  function scheduleInject() { clearTimeout(_injTimer); _injTimer = setTimeout(safeInject, 300); }
  function initStaffColumn() {
    safeInject();
    // 서버 재렌더(검색·페이지) 시 재적용. 우리 변경 중엔 옵저버 일시중단으로 루프 방지.
    _mo = new MutationObserver(() => scheduleInject());
    try { _mo.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
  }

  function init() {
    addButton();
    initStaffColumn();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
