/* =============================================================================
 *  label.js — 좌표(mm) 기반 라벨 렌더 (기획서 5·8절 [UI])
 *  레이아웃(config.layout + localStorage 저장값)으로 각 항목을 절대배치한다.
 *  같은 렌더 함수를 ① 편집기 미리보기, ② 실제 인쇄가 공유한다(양식 드리프트 방지).
 *
 *  단위:
 *    - 인쇄:  unit='mm'  → 실제 60×10mm
 *    - 편집기: pxmm 지정 → 화면 px (확대 미리보기)
 * ========================================================================== */
(function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const won = (n) => (n == null || n === '') ? '' : Number(n).toLocaleString('ko-KR');

  /* ---- 저장소 추상화 -------------------------------------------------------
   *  레이아웃 저장값의 단일 소스 = chrome.storage.local['UB_LAYOUT'].
   *  - 옵션페이지/ISOLATED: chrome.storage 직접
   *  - 콘텐츠(MAIN world): chrome 접근 불가 → bridge.js 가 window.__UB_SAVED_LAYOUT
   *    에 주입해 둔 값을 읽고, 저장은 postMessage 로 bridge 에 위임
   *  - 구버전(브리지 없음): localStorage 폴백 (재설치 전까지 동작 유지)
   * ----------------------------------------------------------------------- */
  function hasChromeStorage() {
    try { return !!(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local); }
    catch (e) { return false; }
  }
  function readLocal() {
    try { const r = localStorage.getItem(window.UBCFG.storageKey); return r ? JSON.parse(r) : null; }
    catch (e) { return null; }
  }
  function slimLayout(layout) {
    return layout.map(f => ({
      key: f.key, x: f.x, y: f.y, w: f.w, h: f.h,
      fs: f.fs, bold: f.bold, align: f.align, visible: f.visible
    }));
  }

  // 현재 저장된 레이아웃(없으면 null). 동기.
  function savedLayout() {
    if (window.__UB_SAVED_LAYOUT !== undefined) return window.__UB_SAVED_LAYOUT; // 브리지/옵션이 주입
    return readLocal();                                                          // 구버전 폴백
  }
  // 설정 완료 여부(최초 실행 판별용)
  function isConfigured() {
    const s = savedLayout();
    return Array.isArray(s) && s.length > 0;
  }

  function getLayout() {
    const CFG = window.UBCFG;
    const base = CFG.layout.map(f => ({ ...f }));
    const saved = savedLayout();
    if (saved && Array.isArray(saved)) {
      const byKey = {};
      saved.forEach(s => { if (s && s.key) byKey[s.key] = s; });
      base.forEach(f => {
        const s = byKey[f.key];
        if (!s) return;
        ['x', 'y', 'w', 'h', 'fs', 'bold', 'align', 'visible'].forEach(k => {
          if (s[k] !== undefined) f[k] = s[k];
        });
      });
    }
    return base;
  }

  function persist(slim) {
    window.__UB_SAVED_LAYOUT = slim;                       // 즉시 반영(렌더용)
    if (hasChromeStorage()) {
      try { chrome.storage.local.set({ UB_LAYOUT: slim }); } catch (e) {}
    } else {
      try { window.postMessage({ __ub: 1, type: 'save', layout: slim }, '*'); } catch (e) {} // bridge 위임
    }
    try { localStorage.setItem(window.UBCFG.storageKey, JSON.stringify(slim)); } catch (e) {} // 백업
  }

  function saveLayout(layout) { persist(slimLayout(layout)); }

  function resetLayout() {
    window.__UB_SAVED_LAYOUT = null;
    if (hasChromeStorage()) {
      try { chrome.storage.local.remove('UB_LAYOUT'); } catch (e) {}
    } else {
      try { window.postMessage({ __ub: 1, type: 'reset' }, '*'); } catch (e) {}
    }
    try { localStorage.removeItem(window.UBCFG.storageKey); } catch (e) {}
  }

  /* ---- 데이터키 → 표시 문자열 매핑 ------------------------------------- */
  function fieldValue(key, d) {
    switch (key) {
      case 'company':      return esc(d.company);
      case 'itemName':     return esc(d.itemName);
      case 'price':        return won(d.price);
      case 'barcodeLabel': return d.barcodePrefix
                                  ? esc(d.barcodePrefix) + '&nbsp;&nbsp;' + esc(d.barcode)
                                  : esc(d.barcode);
      case 'bnum2':        return esc(d.barcode);
      case 'metal':        return esc([d.metal, d.diameter ? `(${d.diameter})` : ''].filter(Boolean).join(' '));
      case 'weight':       return esc(d.weight);
      case 'compCat':      return esc([d.company, d.category].filter(Boolean).join('  '));
      case 'namePartner':  return esc([d.itemName, [d.partner, d.setNo].filter(Boolean).join('')].filter(Boolean).join(''));
      case 'brandTop':     return esc(d.brandTop);
      case 'brandUrl':     return esc(d.brandUrl);
      default:             return '';
    }
  }

  // 단위 변환기: mm 모드 vs pxmm 모드
  function makeU(opts) {
    const pxmm = opts && opts.pxmm;
    return (v) => pxmm ? (v * pxmm) + 'px' : v + 'mm';
  }

  /* ---- 라벨 1장 렌더 ---------------------------------------------------- *
   *  opts: { pxmm?, layout?, editable? }  editable=true 면 드래그용 data-key 부여
   * --------------------------------------------------------------------- */
  function buildLabel(d, opts) {
    opts = opts || {};
    const CFG = window.UBCFG;
    const layout = opts.layout || getLayout();
    const u = makeU(opts);

    let inner = '';

    // 3분할 안내 구분선(인쇄 시 옅게)
    if (CFG.show.panelDividerLine && CFG.editor.showDividers) {
      CFG.editor.dividers.forEach(x => {
        inner += `<div class="ub-div" style="left:${u(x)}"></div>`;
      });
    }

    layout.forEach(f => {
      if (f.visible === false) return;
      const pos = `left:${u(f.x)};top:${u(f.y)};width:${u(f.w)};`;
      const dk = opts.editable ? ` data-key="${f.key}"` : '';

      if (f.type === 'barcode') {
        const h = f.h || 2.9;
        inner += `<div class="ub-f ub-bc"${dk} style="${pos}height:${u(h)}">`
               + window.UBBarcode.svg(d.barcode, { widthMm: f.w, heightMm: h, pxmm: opts.pxmm })
               + `</div>`;
      } else if (f.type === 'box') {
        const h = f.h || 3;
        inner += `<div class="ub-f ub-box"${dk} style="${pos}height:${u(h)}"></div>`;
      } else {
        const style = pos
          + `font-size:${u(f.fs)};`
          + `text-align:${f.align || 'left'};`
          + (f.bold ? 'font-weight:bold;' : '');
        inner += `<div class="ub-f ub-text"${dk} style="${style}">${fieldValue(f.key, d)}</div>`;
      }
    });

    const w = u(CFG.label.wmm), h = u(CFG.label.hmm);
    return `<div class="ub-label" style="width:${w};height:${h}">${inner}</div>`;
  }

  /* ---- Pretendard @font-face (오프라인 base64 임베드) ------------------- */
  function fontFaceCss() {
    const F = window.UB_FONT;
    if (!F) return '';
    return `
      @font-face{font-family:'Pretendard';font-style:normal;font-weight:400;
        src:url(${F.regular}) format('woff2');font-display:swap;}
      @font-face{font-family:'Pretendard';font-style:normal;font-weight:700;
        src:url(${F.bold}) format('woff2');font-display:swap;}
    `;
  }

  /* ---- 공통 CSS -------------------------------------------------------- */
  function baseCss(opts) {
    opts = opts || {};
    const CFG = window.UBCFG;
    const u = makeU(opts);
    const ff = (CFG.print && CFG.print.fontFamily) || '"돋움", Dotum, sans-serif';
    return fontFaceCss() + `
      .ub-label { position: relative; overflow: hidden; box-sizing: border-box;
                  background: #fff; color: #000;
                  font-family: ${ff}; }
      .ub-f { position: absolute; box-sizing: border-box; line-height: 1.0;
              white-space: nowrap; overflow: hidden; }
      .ub-text { text-overflow: ellipsis; }
      .ub-bc svg { width: 100%; height: 100%; display: block; }
      .ub-box { border: ${u(0.15)} solid #999; }
      .ub-div { position: absolute; top: 0; bottom: 0; width: 0;
                border-left: ${u(0.12)} dashed #bbb; }
    `;
  }

  /* ---- 인쇄용 전체 문서 (라벨당 1페이지) ------------------------------- */
  function buildDocument(dataArr, layoutOverride) {
    const CFG = window.UBCFG;
    const layout = layoutOverride || getLayout();
    const W = CFG.label.wmm, H = CFG.label.hmm;
    const css = `
      @page { size: ${W}mm ${H}mm; margin: 0; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; }
      ${baseCss({})}
      .ub-page { width: ${W}mm; height: ${H}mm; page-break-after: always; }
      /* 인쇄 시 안내선은 숨김(라벨에 점선 인쇄 방지) */
      @media print { .ub-div { display: none; } }
    `;
    const body = dataArr.map(d =>
      `<div class="ub-page">${buildLabel(d, { layout })}</div>`
    ).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>바코드 라벨 인쇄</title>`
         + `<style>${css}</style></head><body>${body}</body></html>`;
  }

  window.UBLabel = {
    getLayout, saveLayout, resetLayout, fieldValue,
    buildLabel, baseCss, buildDocument,
    isConfigured, savedLayout
  };
})();
