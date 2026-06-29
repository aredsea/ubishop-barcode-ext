/* =============================================================================
 *  collector.js — 선택 항목 수집 + 라벨 데이터 모델 생성 (기획서 4·8절 [DATA])
 *
 *  반환: Promise<LabelData[]>  (기획서 7.4 모델)
 *  전략:
 *    1) form2(체크된 idx[] + sKey) 수집
 *    2) sourceMode 에 따라:
 *         - 출처 A: infoItemBarPrint.do 로 POST → 응답 HTML 파싱
 *         - 출처 B: 목록 행 스크래핑 (프로토타입에서 검증된 경로)
 *         - auto : A 시도 → 부족하면 B로 보강/대체
 * ========================================================================== */
(function () {
  'use strict';

  const log = (...a) => { if (window.UBCFG.debug) console.log('[UB][collector]', ...a); };

  /* ---- 빈 LabelData 템플릿 (기획서 7.4) -------------------------------- */
  function emptyLabel(barcode) {
    const F = window.UBCFG.fixed;
    return {
      company: F.company,
      itemName: '',
      itemNo: '',
      price: null,
      barcode: barcode || '',
      barcodePrefix: window.UBCFG.barcodePrefix,
      metal: '',
      diameter: '',
      weight: '',
      category: '',
      partner: '',
      setNo: '',
      store: '',        // 매장명(라벨 접두코드·다이아 매장표기용)
      vendor: '',       // 매입처명(다이아 지표: 본디/캐럿)
      extraDesc: '',    // 추가설명(다이아 상품명으로 사용)
      brandTop: F.brandTop,
      brandUrl: F.brandUrl,
      _source: ''
    };
  }

  /* ====================================================================== *
   *  선택된 체크박스 + 폼 수집
   * ====================================================================== */
  function getForm2() {
    // 체크박스 idx 가 들어있는 폼을 찾는다(보통 form2/idx_form).
    const box = document.querySelector('input[name="idx"]');
    return box ? box.form : null;
  }

  function getCheckedBarcodes() {
    const boxes = [...document.querySelectorAll('input[name="idx"]')]
      .filter(b => b.value && b.value !== 'on');
    return boxes.filter(b => b.checked);
  }

  function getSKey(form) {
    const el = form && form.querySelector('input[name="sKey"]');
    return el ? el.value : '';
  }

  /* ---- note 툴팁에서 상품명(한글) 추출 ---------------------------------- *
   *  구조: <span ...>상품명 : </span>링오너먼트(랜덤)<br>
   *  → "상품명" span 바로 다음 텍스트노드(br 전까지)를 정확히 가져온다.        */
  // note 툴팁의 "<label> : 값<br>" 에서 값 추출(span 다음 텍스트노드~br).
  // ⚠ '상품명' 은 '매입처상품코드' 끝에도 들어가므로 ":" 직전 글자로 정확 매칭.
  function noteField(note, label) {
    if (!note) return '';
    const spans = note.querySelectorAll('span');
    for (const sp of spans) {
      const t = (sp.textContent || '').replace(/\s+/g, '');
      // "상품명:" 매칭이 "매입처상품코드:" 에 걸리지 않도록, 라벨이 정확히 그 토큰으로 시작/끝나게.
      const idx = t.indexOf(label + ':');
      if (idx >= 0 && (idx === 0 || !/[가-힣A-Za-z]/.test(t[idx - 1]))) {
        let n = sp.nextSibling, out = '';
        while (n && n.nodeName !== 'BR') {
          out += (n.nodeType === 3 ? n.nodeValue : (n.textContent || ''));
          n = n.nextSibling;
        }
        out = out.trim();
        if (out) return out;
      }
    }
    return '';
  }

  function nameFromNote(note) {
    const v = noteField(note, '상품명');
    if (v) return v;
    // 폴백: innerText 정규식
    const ntx = (note && (note.innerText || note.textContent)) || '';
    return (ntx.match(/상품명\s*:\s*([^\n]+?)\s*(?:해리|배수|매입처|추가설명|각인|원산지|상세스톤|$)/) || [])[1] || '';
  }

  // 목록 행 → 연결된 note_N 툴팁 요소
  function findRowNote(tr) {
    const cell = tr.querySelector('[onmouseover*="note_"]');
    if (cell) {
      const m = (cell.getAttribute('onmouseover') || '').match(/note_\d+/);
      if (m) { const el = document.getElementById(m[0]); if (el) return el; }
    }
    return tr.querySelector('div.tooltip2[id^=note]') || null;
  }

  /* ====================================================================== *
   *  출처 B — 목록 행 스크래핑 (검증된 폴백)
   * ====================================================================== */
  function scrapeRow(cb) {
    const CFG = window.UBCFG;
    const tr = cb.closest('tr');
    const cells = [...tr.children];
    const txt = i => (cells[i] ? cells[i].innerText : '').trim();

    const d = emptyLabel(cb.value);
    d._source = 'list';

    // 상품번호(영문코드): itemNum 셀에서 바코드값이 아닌 줄
    const lines = txt(CFG.cell.itemNum).split('\n').map(s => s.trim()).filter(Boolean);
    const itemNum = lines.find(x => x !== d.barcode) || '';
    d.itemNo = itemNum;
    // 상품명(한글): 행 note 툴팁의 "상품명 :" → 없으면 상품번호 폴백
    d.itemName = nameFromNote(findRowNote(tr)) || itemNum;

    // 판매가
    const price = txt(CFG.cell.price).replace(/[^\d]/g, '');
    if (price) d.price = Number(price);

    // 매장명/고객명/금속/중량 (storeInfo 셀: "광주점 (김재완/김민정) 14K 0.59 g")
    const si = txt(CFG.cell.storeInfo);
    d.store    = (si.match(/^([^(]+)/) || [])[1] ? si.match(/^([^(]+)/)[1].trim() : '';
    d.category = d.store;
    d.partner  = (si.match(/\(([^)]*)\)/) || [])[1] || '';
    const mw = si.match(/(\d+\s*K)\s*([\d.]+)\s*g/i);
    if (mw) {
      d.metal = (mw[1] || '').replace(/\s+/g, '');
      d.weight = mw[2] ? mw[2] + 'g' : '';
    }

    // 매입처(다이아 지표) + 추가설명(다이아 상품명)
    d.vendor    = (txt(CFG.cell.vendor).match(/^[^\d]+/) || [])[0] ? txt(CFG.cell.vendor).match(/^[^\d]+/)[0].trim() : '';
    d.extraDesc = noteField(findRowNote(tr), '추가설명');

    return d;
  }

  function collectFromList() {
    const chosen = getCheckedBarcodes();
    return chosen.map(scrapeRow);
  }

  /* ====================================================================== *
   *  출처 A — infoItemBarPrint.do POST → 응답 HTML 파싱
   *
   *  ⚠ 구현자 필수 확인(기획서 4·6절):
   *    실제 응답 HTML 구조를 직접 열어 per-item 데이터 위치를 확정하고,
   *    아래 parseBarPrintDoc() 의 추출 규칙을 맞춰라.
   *    debug=true 면 응답 HTML 전체가 window.__UB_LAST_BARPRINT_HTML 에 저장된다.
   *    (콘솔에서  copy(window.__UB_LAST_BARPRINT_HTML)  로 클립보드 복사 가능)
   * ====================================================================== */
  async function fetchBarPrintHtml(form, barcodes) {
    const CFG = window.UBCFG;
    const url = CFG.barPrint.path + '?tcode=' + encodeURIComponent(CFG.barPrint.tcode);

    // form2 와 동일한 본문을 만든다: sKey + idx[] (+ 폼의 기존 hidden 값들)
    const fd = new URLSearchParams();
    if (form) {
      for (const el of form.elements) {
        if (!el.name) continue;
        if (el.name === 'idx') continue;            // 체크박스는 선택분만 따로 추가
        if (el.type === 'checkbox' || el.type === 'radio') {
          if (el.checked) fd.append(el.name, el.value);
        } else {
          fd.append(el.name, el.value);
        }
      }
    }
    barcodes.forEach(v => fd.append('idx', v));

    log('POST', url, '본문:', fd.toString());

    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: fd.toString()
    });
    if (!res.ok) throw new Error('infoItemBarPrint.do HTTP ' + res.status);

    // 유비샵은 EUC-KR 가능성이 높다. 바이트로 받아 디코딩 시도.
    const buf = await res.arrayBuffer();
    let html = decodeKr(buf);
    if (CFG.debug) {
      window.__UB_LAST_BARPRINT_HTML = html;
      log('응답 HTML 저장됨 → window.__UB_LAST_BARPRINT_HTML (length=' + html.length + ')');
    }
    return html;
  }

  // UTF-8/EUC-KR 자동 판별 디코딩 — 치환문자(�)가 적은 쪽 채택.
  // 실측: infoItemBarPrint.do 응답은 UTF-8 (2026-06 확인).
  function decodeKr(buf) {
    const score = (enc) => {
      try {
        const s = new TextDecoder(enc, { fatal: false }).decode(buf);
        return { s, bad: (s.match(/�/g) || []).length };
      } catch (e) { return { s: null, bad: Infinity }; }
    };
    const u = score('utf-8');
    if (u.bad === 0) return u.s;          // 깨끗한 UTF-8 → 바로 채택
    const e = score('euc-kr');
    return (e.bad < u.bad ? e.s : u.s) || '';
  }

  /**
   * 응답 HTML → LabelData[] (실측 확정 파서, 2026-06)
   *  구조: table.t_list(마지막) 의 idx-체크박스 행들 + div.tooltip2#note_N(상품명).
   *  응답은 검색결과 전체이므로, 호출자가 requestedBarcodes 로 필터한다.
   */
  function parseRow(tr, note) {
    const CFG = window.UBCFG;
    const C = CFG.barPrintCell;
    const cells = [...tr.children];
    const txt = i => ((cells[i] && (cells[i].innerText || cells[i].textContent)) || '')
      .replace(/\s+/g, ' ').trim();

    const barcode = (tr.querySelector('input[name=idx]') || {}).value || '';
    const d = emptyLabel(barcode);
    d._source = 'barPrint';

    // 셀4: "<바코드> <상품번호> 매입처상품코드 : ..." → 상품번호
    const cell4 = txt(C.itemNo);
    d.itemNo = (cell4.replace(barcode, '').match(/([A-Z][\w-]{3,})/) || [])[1] || '';

    // 셀6: "광주점 (김재완/김민정)0.32 ct ()" / "FASHION (백*심9932/G)18K 4.36 g (17)"
    //  → 괄호 앞=매장명, 괄호 안=고객명, 그 뒤=금속/중량/호수
    const c6 = txt(C.info);
    d.store    = (c6.match(/^([^(]+)/) || [])[1] ? c6.match(/^([^(]+)/)[1].trim() : '';
    d.category = d.store;                                        // 회사+구분 표기엔 매장명 사용(기존 동일값)
    d.partner  = (c6.match(/\(([^)]*)\)/) || [])[1] || '';
    d.metal    = (c6.match(/(\d+\s*K)/) || [])[1] || '';
    const wt   = (c6.match(/([\d.]+)\s*g/i) || [])[1] || '';
    d.weight   = wt ? wt + 'g' : '';
    d.diameter = (c6.match(/\((\d+)\)\s*$/) || [])[1] || '';   // 호수/외경

    // 매입처(다이아 지표): 셀2 "본디26-06-05" → 날짜 앞 글자만
    d.vendor    = (txt(C.vendor).match(/^[^\d]+/) || [])[0] ? txt(C.vendor).match(/^[^\d]+/)[0].trim() : '';
    // 추가설명(다이아 상품명으로 사용)
    d.extraDesc = noteField(note, '추가설명');

    // 상품명(한글): note 툴팁 "상품명 :" span 다음 텍스트
    d.itemName = nameFromNote(note) || d.itemNo;   // 없으면 상품번호 폴백

    // 판매가
    const p = (txt(C.price).match(/[\d,]+/) || [])[0] || '';
    if (p) d.price = Number(p.replace(/,/g, ''));

    return d;
  }

  function parseBarPrintDoc(html, requestedBarcodes) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const tables = [...doc.querySelectorAll('table.t_list')];
    if (!tables.length) { log('table.t_list 없음 → 파싱 불가'); return []; }
    const t = tables[tables.length - 1];   // 데이터 테이블(마지막)
    const notes = [...doc.querySelectorAll('div.tooltip2[id^=note]')];
    const rows = [...t.querySelectorAll('tr')].filter(r => r.querySelector('input[name=idx]'));

    const byBarcode = {};
    rows.forEach((r, i) => {
      const d = parseRow(r, notes[i]);
      if (d.barcode) byBarcode[d.barcode] = d;
    });
    log('파싱된 항목 수:', Object.keys(byBarcode).length);

    // 요청한 바코드만, 요청 순서대로 반환
    const want = (requestedBarcodes && requestedBarcodes.length)
      ? requestedBarcodes : Object.keys(byBarcode);
    return want.map(bc => byBarcode[bc]).filter(Boolean);
  }

  /* ====================================================================== *
   *  병합: A 결과를 B(목록)로 보강 (빈 필드만 채움)
   * ====================================================================== */
  function mergeFill(primary, listByBarcode) {
    return primary.map(p => {
      const l = listByBarcode[p.barcode];
      if (!l) return p;
      const out = { ...p };
      for (const k of Object.keys(out)) {
        if (k.startsWith('_')) continue;
        const empty = out[k] === '' || out[k] == null;
        if (empty && l[k] != null && l[k] !== '') out[k] = l[k];
      }
      return out;
    });
  }

  function countFields(d) {
    let n = 0;
    ['itemName', 'price', 'metal', 'weight', 'diameter', 'category', 'partner', 'setNo']
      .forEach(k => { if (d[k] != null && d[k] !== '') n++; });
    return n;
  }

  /* ====================================================================== *
   *  고객명(거래처) 표시 규칙 — 인쇄 시 partner 에 적용 (공통)
   *   1) 예물:  "이름/이름" (양쪽 2~4 한글, 숫자 없음) → 뒤쪽 이름만
   *             예) 최원형/이보람 → 이보람
   *   2) 일반:  "이름+숫자4개/문자1개" (한글|영문 1글자) → 이름+숫자까지
   *             예) 이*영6877/G → 이*영6877,  구수진1266/S → 구수진1266
   *   3) 그 외: 원문 전체 그대로
   * ====================================================================== */
  function customerName(raw) {
    const s = (raw || '').trim();
    if (!s) return s;
    // 규칙 2 먼저(숫자 보유) → 규칙 1
    let m = s.match(/^(.+\d{4})\/[A-Za-z가-힣]$/);
    if (m) return m[1];
    m = s.match(/^([가-힣*]{2,4})\/([가-힣*]{2,4})$/);
    if (m) return m[2];
    return s;
  }

  /* ====================================================================== *
   *  출처 C — 상품입고 페이지(inputItemWriteForm.do) 목록 스크래핑
   * ====================================================================== */
  function isInboundPage() {
    const cfg = window.UBCFG.inbound;
    return !!(cfg && cfg.match && cfg.match.test(location.pathname));
  }

  // 입고장 헤더의 매입처명(행별 열이 없어 시트 단위). 다이아 지표(본디/캐럿)용 — best-effort.
  let _inboundVendor;
  function inboundVendor() {
    if (_inboundVendor !== undefined) return _inboundVendor;
    _inboundVendor = '';
    const els = document.querySelectorAll('td,th,span,label,div');
    for (const el of els) {
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue).join('').replace(/\s+/g, '');
      if (own === '매입처' || own === '매입처:') {       // "매입처상품코드" 제외(정확매칭)
        // 같은 행의 다음 셀 또는 형제에서 값
        const tr = el.closest('tr');
        let val = '';
        if (tr) {
          const tds = [...tr.children];
          const i = tds.findIndex(td => td.contains(el));
          for (let k = i + 1; k < tds.length && !val; k++) val = (tds[k].innerText || '').trim();
        }
        if (!val && el.nextElementSibling) val = (el.nextElementSibling.innerText || '').trim();
        _inboundVendor = (val.match(/^[^\d(]+/) || [])[0] ? val.match(/^[^\d(]+/)[0].trim() : val.trim();
        if (_inboundVendor) break;
      }
    }
    return _inboundVendor;
  }

  function scrapeInboundRow(cb) {
    const C = window.UBCFG.inbound.cell;
    const tr = cb.closest('tr');
    const cells = [...tr.children];
    const lines = i => ((cells[i] && cells[i].innerText) || '')
      .split('\n').map(s => s.trim()).filter(Boolean);

    // 셀2: [바코드, 매입처코드, 상품번호+상품명]  (idx value 는 복합이라 셀2 첫 줄을 바코드로)
    const c2 = lines(C.info2);
    const d = emptyLabel(c2[0] || '');
    d._source = 'inbound';

    const codeName = c2[c2.length - 1] || '';        // 예) "B0492피어싱" / "B2359R"
    const mm = codeName.match(/^([A-Za-z0-9-]+)([가-힣].*)?$/);
    d.itemNo   = (mm && mm[1]) || codeName;
    d.itemName = (mm && mm[2] ? mm[2].trim() : '') || d.itemNo;

    // 셀4: line0="FASHION (이*영6877/G)", line1="18K 0.46 g ()"
    const c4 = lines(C.store);
    const head = c4[0] || '';
    d.store    = (head.match(/^([^(]+)/) || [])[1] ? head.match(/^([^(]+)/)[1].trim() : '';
    d.category = d.store;
    d.partner  = (head.match(/\(([^)]*)\)/) || [])[1] || '';
    const info = c4[1] || head;
    const mk = info.match(/(\d+\s*K)/);
    d.metal    = mk ? mk[1].replace(/\s+/g, '') : '';
    const wt   = (info.match(/([\d.]+)\s*g/i) || [])[1] || '';
    d.weight   = wt ? wt + 'g' : '';
    d.diameter = ((info.match(/\(([^)]*)\)\s*$/) || [])[1] || '').trim();

    // 매입처(시트단위·다이아 지표) + 추가설명(다이아 상품명)
    d.vendor    = inboundVendor();
    d.extraDesc = noteField(findRowNote(tr), '추가설명');

    // 셀11: 판매가
    const p = (((cells[C.price] && cells[C.price].innerText) || '')).replace(/[^\d]/g, '');
    if (p) d.price = Number(p);

    return d;
  }

  /* ====================================================================== *
   *  공개 API
   * ====================================================================== */
  async function collectSearch(chosen) {
    const CFG = window.UBCFG;
    const form = getForm2();
    const barcodes = chosen.map(b => b.value);
    log('선택 바코드:', barcodes, 'sKey:', getSKey(form));

    // 목록 데이터는 항상 미리 확보(폴백/보강용)
    const listData = collectFromList();
    const listByBarcode = {};
    listData.forEach(d => { listByBarcode[d.barcode] = d; });

    if (CFG.sourceMode === 'listOnly') {
      log('listOnly 모드 → 목록 스크래핑 결과 사용');
      return listData;
    }

    // 출처 A 시도
    let aData = null;
    try {
      const html = await fetchBarPrintHtml(form, barcodes);
      aData = parseBarPrintDoc(html, barcodes);
      log('출처 A 파싱 결과:', aData);
    } catch (e) {
      console.warn('[UB] 출처 A 실패:', e);
      aData = null;
    }

    if (CFG.sourceMode === 'barPrintOnly') {
      return aData && aData.length ? aData : [];
    }

    // auto: 요청 바코드 전부를 보장. A에 있으면 A(목록으로 빈칸 보강),
    //       A에 없으면 목록 항목으로 대체.
    const aByBarcode = {};
    (aData || []).forEach(d => { aByBarcode[d.barcode] = d; });
    const result = barcodes.map(bc => {
      const a = aByBarcode[bc];
      if (a) return mergeFill([a], listByBarcode)[0];
      log('출처 A에 없음 → 목록 폴백:', bc);
      return listByBarcode[bc] || emptyLabel(bc);
    });
    return result;
  }

  /* 페이지 종류에 따라 수집 경로를 고르고, 고객명을 공통 정규화한다. */
  async function collect() {
    const chosen = getCheckedBarcodes();
    if (!chosen.length) {
      alert('인쇄할 상품을 먼저 선택하세요.');
      return null;
    }
    const result = isInboundPage()
      ? chosen.map(scrapeInboundRow)            // 출처 C: 상품입고 목록
      : await collectSearch(chosen);            // 출처 A/B: 검색 페이지
    (result || []).forEach(d => { if (d && d.partner) d.partner = customerName(d.partner); });
    return result;
  }

  window.UBCollector = { collect };
})();
