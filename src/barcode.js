/* =============================================================================
 *  barcode.js — JsBarcode 래퍼 (기획서 8절 [UI] 바코드 렌더)
 *  바코드값 → SVG 문자열. 라벨의 바코드 박스에 맞춰 100% 채워진다.
 *  window.UBBarcode.svg(code, opts) 로 노출. (opts 는 비율 계산용; CSS가 박스에 맞춤)
 * ========================================================================== */
(function () {
  'use strict';

  function svg(code, opts) {
    const C = window.UBCFG.barcode;
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    try {
      // 막대 비율만 결정(픽셀). 실제 표시 크기는 라벨 CSS(width/height:100%)가 박스에 맞춤.
      JsBarcode(el, String(code || ''), {
        format: C.format,
        displayValue: C.displayValue,
        margin: 0,
        width: C.width,
        height: 48
      });
      // viewBox 기반 자동 스케일을 위해 고정 width/height 속성 제거(없으면 추가 안 함)
      el.removeAttribute('width');
      el.removeAttribute('height');
      el.setAttribute('preserveAspectRatio', 'none');
    } catch (e) {
      console.error('[UB] barcode render error:', code, e);
    }
    return el.outerHTML;
  }

  window.UBBarcode = { svg };
})();
