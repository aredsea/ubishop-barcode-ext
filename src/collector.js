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

  /* ====================================================================== *
   *  출처 B — 목록 행 스크래핑 (검증된 폴백)
   * ====================================================================== */
  function scrapeRow(cb) {
    const CFG = window.UBCFG;
    const cells = [...cb.closest('tr').children];
    const txt = i => (cells[i] ? cells[i].innerText : '').trim();

    const d = emptyLabel(cb.value);
    d._source = 'list';

    // 상품번호: itemNum 셀에서 바코드값이 아닌 줄
    const lines = txt(CFG.cell.itemNum).split('\n').map(s => s.trim()).filter(Boolean);
    const itemNum = lines.find(x => x !== d.barcode) || '';
    if (itemNum) d.itemName = d.itemName || itemNum;

    // 판매가
    const price = txt(CFG.cell.price).replace(/[^\d]/g, '');
    if (price) d.price = Number(price);

    // 금속/중량 (예: "14K 0.59 g")
    const mw = txt(CFG.cell.storeInfo).match(/(\d+\s*K)\s*([\d.]+)\s*g/i);
    if (mw) {
      d.metal = (mw[1] || '').replace(/\s+/g, '');
      d.weight = mw[2] ? mw[2] + 'g' : '';
    }

    // 구분
    const g = txt(CFG.cell.gubun);
    if (g) d.category = g;

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

    // 셀6: "FASHION (백*심9932/G)18K 4.36 g (17)"
    const c6 = txt(C.info);
    d.category = (c6.match(/^([A-Za-z가-힣]+)/) || [])[1] || '';
    d.partner  = (c6.match(/\(([^)]*)\)/) || [])[1] || '';
    d.metal    = (c6.match(/(\d+\s*K)/) || [])[1] || '';
    const wt   = (c6.match(/([\d.]+)\s*g/i) || [])[1] || '';
    d.weight   = wt ? wt + 'g' : '';
    d.diameter = (c6.match(/\((\d+)\)\s*$/) || [])[1] || '';   // 호수/외경

    // 상품명(한글): note 툴팁 "상품명 : X 해리/배수"
    if (note) {
      const ntx = (note.innerText || note.textContent || '');
      d.itemName = (ntx.match(/상품명\s*:\s*([^\n]+?)\s*(?:해리|배수|매입처|$)/) || [])[1] || '';
    }
    if (!d.itemName) d.itemName = d.itemNo;   // 상품명 없으면 상품번호로 폴백

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
   *  공개 API
   * ====================================================================== */
  async function collect() {
    const CFG = window.UBCFG;
    const chosen = getCheckedBarcodes();
    if (!chosen.length) {
      alert('인쇄할 상품을 먼저 선택하세요.');
      return null;
    }
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

  window.UBCollector = { collect };
})();
