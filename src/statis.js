/* =============================================================================
 *  statis.js — 상품집계(sheetStatisList) 제품별 판매 통계 (v1)
 *  loader 동적로드(MAIN world). 상품집계 페이지에서만 동작.
 *
 *  흐름: [제품별 통계화] 버튼 → 월 전체 데이터 POST 재조회(pageSize=500 순차)
 *        → 단가(총공급가/수량) 50,000원 초과 행만 → 제품별 그룹핑 → 통계 오버레이
 *        → XLSX 다운로드.
 *
 *  그룹핑 규칙(사용자 확정 2026-07-02):
 *   · 단가 = 총공급가 ÷ 수량 > 50,000 인 행만 대상(이하 제외).
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
  const PRICE_MIN = 50000;
  const FETCH_PS = 500;

  /* ---------- 숫자/문자 유틸 ---------- */
  // 셀에 두 줄로 숫자가 겹쳐 들어오는 경우가 있어 "첫 번째 숫자"만 취한다.
  function firstNum(s) {
    const m = String(s == null ? '' : s).match(/-?[\d,]+(?:\.\d+)?/);
    return m ? parseFloat(m[0].replace(/,/g, '')) : 0;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function nf(n) { try { return Math.round(n).toLocaleString('ko-KR'); } catch (_) { return String(n); } }

  /* ---------- 상품코드 셀 → {code, name} ---------- */
  function splitCodeName(cellText) {
    const t = String(cellText || '').replace(/\s+/g, ' ').trim();
    // 앞 토큰이 코드(영숫자+하이픈), 나머지가 상품명
    const m = t.match(/^([A-Za-z0-9][A-Za-z0-9\-]*)\s+(.+)$/);
    if (m) return { code: m[1], name: m[2].trim() };
    return { code: t, name: t };
  }

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
  // 매장/직원 셀: "매장명(직원명)" → {store, staff}
  function splitStoreStaff(ssText) {
    const s = String(ssText == null ? '' : ssText).replace(/\s+/g, ' ').trim();
    const mm = s.match(/^(.+?)\s*\((.+)\)\s*$/);
    return { store: mm ? mm[1].trim() : s, staff: mm ? mm[2].trim() : '' };
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
    let html = '';
    try {
      html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      if ((html.match(/�/g) || []).length > 20) html = new TextDecoder('euc-kr').decode(buf);
    } catch (_) { try { html = new TextDecoder('euc-kr').decode(buf); } catch (__) {} }
    return html;
  }
  // 문서에서 t_list(수량 헤더 보유) 찾아 컬럼 인덱스 + 데이터행 반환
  function parseDoc(doc) {
    for (const t of doc.querySelectorAll('table.t_list')) {
      let hi = -1, cells = null;
      for (const r of t.rows) {
        const cs = [...r.cells].map(c => c.textContent.replace(/\s+/g, ' ').trim());
        if (cs.includes('수량')) { hi = r.rowIndex; cells = cs; break; }
      }
      if (hi < 0) continue;
      const idx = (nm) => cells.indexOf(nm);
      const rows = [];
      for (let i = hi + 1; i < t.rows.length; i++) {
        const r = t.rows[i];
        if (!/^\d+$/.test((r.cells[0] ? r.cells[0].textContent : '').replace(/\s+/g, ''))) continue;
        rows.push(r);
      }
      return { rows, cCode: idx('상품코드'), cQty: idx('수량'), cSup: idx('총공급가'), cSale: idx('판매가'), cDC: idx('DC금액'), cReal: idx('실판매가') };
    }
    return null;
  }
  async function loadAll(setStatus) {
    const fp = formParams();
    if (!fp) throw new Error('검색폼(form1)을 찾지 못했습니다');
    const total = readTotal();
    const pages = total > 0 ? Math.ceil(total / FETCH_PS) : 1;
    const items = [];
    let cSaleSeen = -1;
    for (let p = 1; p <= pages; p++) {
      setStatus(`전체 ${total}건 불러오는 중… (${p}/${pages})`);
      const params = new URLSearchParams(fp.params);
      params.set('pageSize', String(FETCH_PS));
      params.set('reqPage', String(p));
      const html = await fetchHtml(fp.action, params);
      const g = parseDoc(new DOMParser().parseFromString(html, 'text/html'));
      if (!g) throw new Error('결과 표(t_list)를 파싱하지 못했습니다 (로그인 만료?)');
      cSaleSeen = g.cSale;
      for (const r of g.rows) {
        const cn = splitCodeName(r.cells[g.cCode] ? r.cells[g.cCode].textContent : '');
        items.push({
          code: cn.code, name: cn.name,
          qty: firstNum(r.cells[g.cQty] && r.cells[g.cQty].textContent),
          sup: firstNum(r.cells[g.cSup] && r.cells[g.cSup].textContent),
          sale: g.cSale >= 0 ? firstNum(r.cells[g.cSale] && r.cells[g.cSale].textContent) : 0,
          dc: g.cDC >= 0 ? firstNum(r.cells[g.cDC] && r.cells[g.cDC].textContent) : 0,
          real: g.cReal >= 0 ? firstNum(r.cells[g.cReal] && r.cells[g.cReal].textContent) : 0
        });
      }
    }
    return { items, total, hasSale: cSaleSeen >= 0 };
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
  async function orderLoadAll(setStatus) {
    const p0 = orderParams();
    if (!p0) throw new Error('검색폼(form1)을 찾지 못했습니다');
    const action = location.origin + '/jun/orderitem/orderItemList.do?tcode=order_item';
    const items = [];
    let total = 0, pages = 1;
    for (let p = 1; p <= pages; p++) {
      setStatus(p === 1 ? '주문전표 불러오는 중…' : `주문전표 ${total}건 불러오는 중… (${p}/${pages})`);
      const params = new URLSearchParams(p0);
      params.set('pageSize', String(FETCH_PS));
      params.set('reqPage', String(p));
      const html = await fetchHtml(action, params);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      if (p === 1) { total = readTotalDoc(doc); pages = total > 0 ? Math.ceil(total / FETCH_PS) : 1; }
      const g = parseOrderDoc(doc);
      if (!g) throw new Error('주문전표 표(t_list)를 파싱하지 못했습니다 (로그인 만료?)');
      for (const r of g.rows) {
        const prod = splitProdCell(g.cProd >= 0 && r.cells[g.cProd] ? r.cells[g.cProd].textContent : '');
        const ss = splitStoreStaff(g.cStore >= 0 && r.cells[g.cStore] ? r.cells[g.cStore].textContent : '');
        items.push({
          code: prod.barcode, name: prod.name, customer: prod.customer,
          qty: firstNum(r.cells[g.cQty] && r.cells[g.cQty].textContent),
          price: g.cPrice >= 0 ? firstNum(r.cells[g.cPrice] && r.cells[g.cPrice].textContent) : 0,
          store: ss.store, staff: ss.staff
        });
      }
    }
    return { items, total };
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
  function buildGroups(items) {
    const map = new Map();
    let excluded = 0, kept = 0, gift = 0;
    for (const it of items) {
      if (/사은품/.test(it.name)) { gift++; continue; }   // 사은품은 순위에서 제외
      const unit = it.qty > 0 ? it.sup / it.qty : 0;   // 단가 = 총공급가 ÷ 수량
      if (unit <= PRICE_MIN) { excluded++; continue; }
      kept++;
      const jasa = isJasa(it.name);
      let name = jasa ? jasaBase(it.name) : saipKey(it.name);
      let type = jasa ? '자사' : '사입';
      const ov = OVERRIDE[name];   // 수기 보정 적용
      if (ov) { if (ov.name) name = ov.name; if (ov.type) type = ov.type; }
      const key = name;   // 같은 제품명끼리 병합(구분 무관)
      let g = map.get(key);
      if (!g) { g = { type, name, qty: 0, sup: 0, sale: 0, dc: 0, real: 0, members: [] }; map.set(key, g); }
      if (ov && ov.type) g.type = ov.type;   // 교정된 구분 우선
      g.qty += it.qty; g.sup += it.sup; g.sale += it.sale; g.dc += it.dc; g.real += it.real; g.members.push(it);
    }
    const groups = [...map.values()].sort((a, b) => b.qty - a.qty || b.sup - a.sup);
    return { groups, excluded, kept, gift };
  }

  /* ---------- 그룹핑(주문용): 단가필터 없음, 사은품만 제외, 수량/주문가 합산 ---------- */
  function buildOrderGroups(items) {
    const map = new Map();
    let gift = 0;
    for (const it of items) {
      if (/사은품/.test(it.name)) { gift++; continue; }   // 사은품은 순위에서 제외
      const jasa = isJasa(it.name);
      let name = jasa ? jasaBase(it.name) : saipKey(it.name);
      let type = jasa ? '자사' : '사입';
      const ov = OVERRIDE[name];   // 판매탭과 동일한 수기 보정 재사용
      if (ov) { if (ov.name) name = ov.name; if (ov.type) type = ov.type; }
      let g = map.get(name);
      if (!g) { g = { type, name, qty: 0, price: 0, members: [] }; map.set(name, g); }
      if (ov && ov.type) g.type = ov.type;
      g.qty += it.qty; g.price += it.price; g.members.push(it);
    }
    const groups = [...map.values()].sort((a, b) => b.qty - a.qty || b.price - a.price);
    return { groups, gift };
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
  function xlsxName() {
    const f = document.querySelector('form[name="form1"]');
    const g = n => { const el = f && f.elements[n]; return el ? el.value : ''; };
    const s = `${g('syear')}${g('smonth')}${g('sday')}`;
    const e = `${g('eyear')}${g('emonth')}${g('eday')}`;
    return (s && e) ? `상품집계_통계_${s}-${e}.xlsx` : '상품집계_통계.xlsx';
  }
  function orderXlsxName() {
    const f = document.querySelector('form[name="form1"]');
    const g = n => { const el = f && f.elements[n]; return el ? el.value : ''; };
    const s = `${g('syear')}${g('smonth')}${g('sday')}`;
    const e = `${g('eyear')}${g('emonth')}${g('eday')}`;
    return (s && e) ? `주문통계_${s}-${e}.xlsx` : '주문통계.xlsx';
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
      '#ub-stat button{font-family:inherit;border:0;border-radius:8px;font-size:12.5px;font-weight:700;cursor:pointer;padding:8px 14px;}',
      '#ub-stat .bx{background:#1f8f52;color:#fff;} #ub-stat .bc{background:#eef1f5;color:#374151;}',
      '#ub-stat .bd{flex:1;overflow:auto;padding:0 18px 18px;}',
      '#ub-stat table{width:100%;border-collapse:collapse;font-size:12.5px;}',
      '#ub-stat thead th{position:sticky;top:0;background:#f3fbfe;color:#0f6f8c;font-weight:800;',
      ' padding:9px 8px;border-bottom:2px solid #35C5F0;text-align:right;white-space:nowrap;}',
      '#ub-stat thead th.l{text-align:left;}',
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
  // 주문 오버레이 전용 스타일(판매탭에서 쓰지 않는 클래스만 추가 → 판매 경로 영향 없음)
  function ensureOrderStyle() {
    if (document.getElementById('ub-ostat-style')) return;
    const s = document.createElement('style');
    s.id = 'ub-ostat-style';
    s.textContent = [
      '#ub-stat .ofl{padding:10px 18px;border-bottom:1px solid #e5e7eb;display:flex;flex-direction:column;gap:7px;background:#fafcfe;}',
      '#ub-stat .ofl-row{display:flex;align-items:flex-start;gap:8px;font-size:12px;}',
      '#ub-stat .ofl-lb{flex:0 0 42px;font-weight:800;color:#0f6f8c;padding-top:3px;}',
      '#ub-stat .ofl-all{flex:0 0 auto;font-weight:700;color:#374151;padding-top:2px;white-space:nowrap;}',
      '#ub-stat .ofl-chips{display:flex;flex-wrap:wrap;gap:4px 10px;}',
      '#ub-stat .ofl-chip{display:inline-flex;align-items:center;gap:3px;color:#374151;white-space:nowrap;}',
      '#ub-stat .ofl-chip input,#ub-stat .ofl-all input,#ub-stat .ub-o-pick{vertical-align:middle;cursor:pointer;margin:0;}',
      '#ub-stat .ofl-search{flex:1;max-width:280px;padding:5px 9px;border:1px solid #cdd8e0;border-radius:7px;font-size:12px;}',
      '#ub-stat th.ub-ck,#ub-stat td.ub-ck{text-align:center;}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }
  function close() {
    ['ub-stat', 'ub-stat-mask'].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
  }
  function render(result, meta) {
    ensureStyle();
    close();
    const mask = document.createElement('div'); mask.id = 'ub-stat-mask';
    mask.addEventListener('click', close);
    const box = document.createElement('div'); box.id = 'ub-stat';
    const allGroups = result.groups;

    box.innerHTML =
      '<div class="hd">' +
        '<span class="t">제품별 판매 통계</span>' +
        '<span class="fbtns">' +
          '<button class="fbtn on" data-f="all">전체</button>' +
          '<button class="fbtn" data-f="자사">자사</button>' +
          '<button class="fbtn" data-f="사입">타사</button>' +
        '</span>' +
        '<span class="sum" id="ub-stat-sum"></span>' +
        '<span class="sp"><button class="bx" id="ub-stat-xlsx">엑셀 다운로드(XLSX)</button><button class="bc" id="ub-stat-close">닫기</button></span>' +
      '</div>' +
      '<div class="bd"><table>' +
        '<thead><tr><th>#</th><th class="l">제품명</th><th class="l">구분</th><th>총수량</th><th>총공급가</th><th>총판매가</th><th>총DC금액</th><th>총실판매가</th><th>코드수</th></tr></thead>' +
        '<tbody id="ub-stat-tbody"></tbody></table></div>';

    document.body.appendChild(mask);
    document.body.appendChild(box);

    let filter = 'all';
    let curList = allGroups;

    function rowsHtml(list) {
      let rows = '';
      list.forEach((g, i) => {
        const tag = g.type === '자사' ? '<span class="tag tj">자사</span>' : '<span class="tag ts">사입</span>';
        rows += `<tr class="g" data-i="${i}">` +
          `<td class="rk">${i + 1}</td>` +
          `<td class="l">${esc(g.name)} <span class="exp">▸</span></td>` +
          `<td class="l">${tag}</td>` +
          `<td class="qty">${nf(g.qty)}</td>` +
          `<td>${nf(g.sup)}</td>` +
          `<td>${nf(g.sale)}</td>` +
          `<td>${nf(g.dc)}</td>` +
          `<td>${nf(g.real)}</td>` +
          `<td>${g.members.length}</td></tr>`;
        const memRows = g.members.slice().sort((a, b) => b.qty - a.qty).map(m =>
          '<tr>' +
          `<td class="l">${esc(m.name)}</td>` +
          `<td>${nf(m.qty)}</td>` +
          `<td>${nf(m.sup)}</td>` +
          `<td>${nf(m.sale)}</td>` +
          `<td>${nf(m.dc)}</td>` +
          `<td>${nf(m.real)}</td>` +
          '</tr>').join('');
        rows += `<tr class="det" data-d="${i}" style="display:none"><td></td><td colspan="8">` +
          '<table class="sub"><thead><tr>' +
          '<th class="l">상품명</th><th>수량</th><th>총공급가</th><th>판매가</th><th>DC금액</th><th>실판매가</th>' +
          `</tr></thead><tbody>${memRows}</tbody></table></td></tr>`;
      });
      return rows;
    }
    function bindRows() {
      box.querySelectorAll('tr.g').forEach(tr => tr.addEventListener('click', () => {
        const d = box.querySelector(`tr.det[data-d="${tr.dataset.i}"]`);
        const caret = tr.querySelector('.exp');
        if (d) {
          const open = d.style.display === 'none';
          d.style.display = open ? '' : 'none';
          if (caret) caret.textContent = open ? '▾' : '▸';
        }
      }));
    }
    function apply() {
      curList = (filter === 'all') ? allGroups : allGroups.filter(g => g.type === filter);
      box.querySelector('#ub-stat-tbody').innerHTML = rowsHtml(curList);
      bindRows();
      const q = curList.reduce((a, g) => a + g.qty, 0);
      const sup = curList.reduce((a, g) => a + g.sup, 0);
      const real = curList.reduce((a, g) => a + g.real, 0);
      box.querySelector('#ub-stat-sum').textContent =
        `제품군 ${curList.length}개 · 총수량 ${nf(q)} · 총공급가 ${nf(sup)}원 · 총실판매가 ${nf(real)}원 · 단가 5만원 초과만 · 제외 ${result.excluded}행 · 사은품 제외 ${result.gift} · 기간 ${meta}`;
      box.querySelectorAll('.fbtn').forEach(b => b.classList.toggle('on', b.dataset.f === filter));
    }

    box.querySelector('#ub-stat-close').addEventListener('click', close);
    box.querySelectorAll('.fbtn').forEach(b => b.addEventListener('click', () => { filter = b.dataset.f; apply(); }));
    box.querySelector('#ub-stat-xlsx').addEventListener('click', () => {
      const aoa = [['순위', '제품명', '구분', '총수량', '총공급가', '총판매가', '총DC금액', '총실판매가', '코드수']];
      curList.forEach((g, i) => aoa.push([i + 1, g.name, g.type, g.qty, Math.round(g.sup), Math.round(g.sale), Math.round(g.dc), Math.round(g.real), g.members.length]));
      downloadXlsx(aoa, xlsxName());
      log('xlsx 저장', xlsxName(), aoa.length - 1, '행', 'filter=' + filter);
    });
    apply();
    log('통계 렌더', { groups: allGroups.length, excluded: result.excluded, kept: result.kept });
  }

  /* ---------- 주문 통계 오버레이(renderOrder) ---------- */
  function renderOrder(items, meta) {
    ensureStyle();
    ensureOrderStyle();
    close();
    const mask = document.createElement('div'); mask.id = 'ub-stat-mask';
    mask.addEventListener('click', close);
    const box = document.createElement('div'); box.id = 'ub-stat';

    const stores = [...new Set(items.map(it => it.store).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
    const staffs = [...new Set(items.map(it => it.staff).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
    const selStores = new Set(stores);
    const selStaff = new Set(staffs);
    const excluded = new Set();      // 해제(제외)된 제품명 — 합계·XLSX에서 제외
    let typeFilter = 'all';
    let nameQuery = '';
    let curGroups = [];              // 현재 매장∩직원 그룹(구분/검색과 무관한 전체)
    let lastGift = 0;

    box.innerHTML =
      '<div class="hd">' +
        '<span class="t">제품별 주문 통계 (전표 기준)</span>' +
        '<span class="fbtns">' +
          '<button class="fbtn on" data-f="all">전체</button>' +
          '<button class="fbtn" data-f="자사">자사</button>' +
          '<button class="fbtn" data-f="사입">타사</button>' +
        '</span>' +
        '<span class="sum" id="ub-stat-sum"></span>' +
        '<span class="sp"><button class="bx" id="ub-stat-xlsx">엑셀 다운로드(XLSX)</button><button class="bc" id="ub-stat-close">닫기</button></span>' +
      '</div>' +
      '<div class="ofl">' +
        '<div class="ofl-row"><span class="ofl-lb">매장</span>' +
          '<label class="ofl-all"><input type="checkbox" id="ub-o-store-all" checked> 전체</label>' +
          '<span class="ofl-chips" id="ub-o-stores"></span></div>' +
        '<div class="ofl-row"><span class="ofl-lb">직원</span>' +
          '<label class="ofl-all"><input type="checkbox" id="ub-o-staff-all" checked> 전체</label>' +
          '<span class="ofl-chips" id="ub-o-staffs"></span></div>' +
        '<div class="ofl-row"><span class="ofl-lb">상품명</span>' +
          '<input type="text" id="ub-o-search" class="ofl-search" placeholder="상품명으로 검색…"></div>' +
      '</div>' +
      '<div class="bd"><table>' +
        '<thead><tr><th class="ub-ck"><input type="checkbox" id="ub-o-all" checked></th><th>#</th><th class="l">제품명</th><th class="l">구분</th><th>총수량</th><th>총주문가</th><th>코드수</th></tr></thead>' +
        '<tbody id="ub-stat-tbody"></tbody></table></div>';

    document.body.appendChild(mask);
    document.body.appendChild(box);

    const tbody = box.querySelector('#ub-stat-tbody');
    const sumEl = box.querySelector('#ub-stat-sum');
    const allCb = box.querySelector('#ub-o-all');

    function countedGroups() { return curGroups.filter(g => !excluded.has(g.name)); }
    function displayGroups() {
      let list = curGroups;
      if (typeFilter !== 'all') list = list.filter(g => g.type === typeFilter);
      if (nameQuery) { const q = nameQuery.toLowerCase(); list = list.filter(g => g.name.toLowerCase().indexOf(q) >= 0); }
      return list;
    }
    function renderSummary() {
      const c = countedGroups();
      const q = c.reduce((a, g) => a + g.qty, 0);
      const pr = c.reduce((a, g) => a + g.price, 0);
      sumEl.textContent = `제품군 ${c.length}개 · 총수량 ${nf(q)} · 총주문가 ${nf(pr)}원 · 사은품 제외 ${lastGift} · 기간 ${meta}`;
    }
    function syncProductAll() {
      const total = curGroups.length;
      const on = curGroups.filter(g => !excluded.has(g.name)).length;
      allCb.checked = total > 0 && on === total;
      allCb.indeterminate = on > 0 && on < total;
    }
    function renderRows() {
      const list = displayGroups();
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
          `<td>${nf(g.price)}</td>` +
          `<td>${g.members.length}</td></tr>`;
        const memRows = g.members.slice().sort((a, b) => b.qty - a.qty).map(m =>
          '<tr>' +
          `<td class="l">${esc(m.name)}</td>` +
          `<td class="l">${esc(m.code)}</td>` +
          `<td>${nf(m.qty)}</td>` +
          `<td>${nf(m.price)}</td>` +
          `<td class="l">${esc(m.store)}</td>` +
          `<td class="l">${esc(m.staff)}</td>` +
          `<td class="l">${esc(m.customer)}</td>` +
          '</tr>').join('');
        rows += '<tr class="det" style="display:none"><td></td><td colspan="6">' +
          '<table class="sub"><thead><tr>' +
          '<th class="l">상품명</th><th class="l">바코드</th><th>수량</th><th>주문가</th><th class="l">매장</th><th class="l">직원</th><th class="l">고객</th>' +
          `</tr></thead><tbody>${memRows}</tbody></table></td></tr>`;
      });
      tbody.innerHTML = rows;
      const grows = [...tbody.querySelectorAll('tr.g')];
      grows.forEach((tr, idx) => {
        const g = list[idx];
        const cb = tr.querySelector('.ub-o-pick');
        cb.addEventListener('click', e => e.stopPropagation());
        cb.addEventListener('change', () => {
          if (cb.checked) excluded.delete(g.name); else excluded.add(g.name);
          renderSummary(); syncProductAll();
        });
        tr.addEventListener('click', () => {
          const det = tr.nextElementSibling;
          if (det && det.classList.contains('det')) {
            const open = det.style.display === 'none';
            det.style.display = open ? '' : 'none';
            const caret = tr.querySelector('.exp');
            if (caret) caret.textContent = open ? '▾' : '▸';
          }
        });
      });
      syncProductAll();
    }
    function recompute() {
      const base = items.filter(it => selStores.has(it.store) && selStaff.has(it.staff));
      const r = buildOrderGroups(base);
      curGroups = r.groups; lastGift = r.gift;
      renderRows(); renderSummary();
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
    box.querySelectorAll('.fbtn').forEach(b => b.addEventListener('click', () => {
      typeFilter = b.dataset.f;
      box.querySelectorAll('.fbtn').forEach(x => x.classList.toggle('on', x.dataset.f === typeFilter));
      renderRows();
    }));
    box.querySelector('#ub-o-search').addEventListener('input', e => { nameQuery = e.target.value.trim(); renderRows(); });
    allCb.addEventListener('change', function () {
      if (this.checked) curGroups.forEach(g => excluded.delete(g.name));
      else curGroups.forEach(g => excluded.add(g.name));
      this.indeterminate = false;
      renderRows(); renderSummary();
    });
    box.querySelector('#ub-stat-xlsx').addEventListener('click', () => {
      const c = countedGroups();
      const aoa = [['순위', '제품명', '구분', '총수량', '총주문가', '코드수']];
      c.forEach((g, i) => aoa.push([i + 1, g.name, g.type, g.qty, Math.round(g.price), g.members.length]));
      downloadXlsx(aoa, orderXlsxName());
      log('주문 xlsx 저장', orderXlsxName(), aoa.length - 1, '행');
    });

    recompute();
    log('주문 통계 렌더', { items: items.length, stores: stores.length, staffs: staffs.length, groups: curGroups.length });
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
        const { items, total } = await orderLoadAll(setStatus);
        const meta = `${g('syear')}-${g('smonth')}-${g('sday')} ~ ${g('eyear')}-${g('emonth')}-${g('eday')} (전표 ${total}건)`;
        renderOrder(items, meta);
      } else {
        const { items, total } = await loadAll(setStatus);
        const result = buildGroups(items);
        const meta = `${g('syear')}-${g('smonth')}-${g('sday')} ~ ${g('eyear')}-${g('emonth')}-${g('eday')} (원본 ${total}건)`;
        render(result, meta);
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
    b.title = IS_ORDER ? '주문전표 기준 제품별 통계' : '단가 5만원 초과 제품을 제품별로 묶어 판매 통계 + 엑셀 다운로드';
    b.style.cssText = 'margin-left:6px;padding:3px 12px;background:#35C5F0;color:#fff;border:0;border-radius:6px;' +
      'font:700 12px/1.5 Pretendard,sans-serif;cursor:pointer;vertical-align:middle;';
    b.addEventListener('click', () => runStats(b));
    // skin.js 의 수량정렬 드롭다운 뒤에 오도록 약간 늦게 삽입
    anchor.parentNode.appendChild(b);
    log('통계화 버튼 추가');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addButton);
  else addButton();
})();
