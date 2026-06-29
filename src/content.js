/* =============================================================================
 *  content.js — 얇은 호출자 (v2.0.0)
 *  유비샵 `바코드인쇄`(window.sendBarPrint) 를 가로채:
 *   1) 체크된 상품을 infoItemBarPrint.do 파싱(collector)
 *   2) D102 인쇄 프로그램(127.0.0.1)에 데이터 POST → 프로그램이 ZPL 로 Zebra 직접 인쇄
 *   3) 로딩 오버레이 + 결과 안내
 *  (라벨 렌더·위치편집·인쇄 미리보기는 프로그램이 담당 → 확장에서 제거)
 * ========================================================================== */
(function () {
  'use strict';

  const log = (...a) => { if (window.UBCFG && window.UBCFG.debug) console.log('[UB][content]', ...a); };
  const original = window.sendBarPrint;
  const PRINT_URL = (window.UBCFG.localPrint && window.UBCFG.localPrint.url) || 'http://127.0.0.1:17600/print';

  // collector 의 LabelData → 프로그램 item (per-item 필드만; 고정문구/레이아웃은 프로그램 보유)
  function toItems(data) {
    return data.map(d => ({
      barcode: d.barcode, itemName: d.itemName, itemNo: d.itemNo,
      price: d.price, metal: d.metal, diameter: d.diameter, weight: d.weight,
      category: d.category, partner: d.partner, setNo: d.setNo
    }));
  }

  async function sendBarPrintReplacement() {
    try {
      window.UBOverlay && window.UBOverlay.show('인쇄 준비 중…');
      const data = await window.UBCollector.collect();
      if (!data || !data.length) { window.UBOverlay && window.UBOverlay.hide(); return false; } // 미선택 시 collector가 alert

      const items = toItems(data);
      log('인쇄 요청', items);
      window.UBOverlay && window.UBOverlay.show('인쇄 중…');

      let res;
      try {
        res = await fetch(PRINT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items })
        });
      } catch (e) {
        window.UBOverlay && window.UBOverlay.hide();
        alert('D102 인쇄 프로그램에 연결할 수 없습니다.\n\n' +
              '작업표시줄 트레이에 "D102 라벨 인쇄"가 실행 중인지 확인하세요.\n' +
              '없으면 프로그램을 실행한 뒤 다시 시도하세요.');
        return false;
      }

      const j = await res.json().catch(() => ({ ok: false, error: '응답 파싱 실패' }));
      window.UBOverlay && window.UBOverlay.hide();
      if (!j.ok) {
        alert('인쇄 실패: ' + (j.error || '알 수 없는 오류'));
      } else {
        log('인쇄 완료', j);
      }
    } catch (e) {
      window.UBOverlay && window.UBOverlay.hide();
      console.error('[UB] 인쇄 처리 오류:', e);
      alert('인쇄 중 오류가 발생했습니다.\n' + (e && e.message));
    }
    return false; // javascript: href 기본 동작 방지
  }

  window.sendBarPrint = sendBarPrintReplacement;
  window.__ubOriginalSendBarPrint = original;

  console.log('%c[유비샵 바코드 라벨] 활성화됨 (v2.0.0 — 프로그램 인쇄)', 'color:#0a7;font-weight:bold');
  console.log('[UB] 바코드인쇄 → D102 인쇄 프로그램으로 전송. 위치/문구 설정은 프로그램에서.');
})();
