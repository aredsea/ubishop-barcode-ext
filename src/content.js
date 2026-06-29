/* =============================================================================
 *  content.js — 얇은 호출자 (v2.1.0)
 *  유비샵 `바코드인쇄`(window.sendBarPrint) 를 가로채:
 *   1) 체크된 상품을 infoItemBarPrint.do 파싱(collector)
 *   2) 백그라운드(service worker)로 데이터 전달 → 프로그램에 POST → ZPL 인쇄
 *      (http 페이지는 PNA 정책으로 127.0.0.1 직접 fetch가 막혀서 백그라운드 경유)
 *   3) 로딩 오버레이 + 결과 안내
 * ========================================================================== */
(function () {
  'use strict';

  const log = (...a) => { if (window.UBCFG && window.UBCFG.debug) console.log('[UB][content]', ...a); };
  const original = window.sendBarPrint;

  // collector 의 LabelData → 프로그램 item (per-item 필드만; 고정문구/레이아웃은 프로그램 보유)
  function toItems(data) {
    return data.map(d => ({
      barcode: d.barcode, itemName: d.itemName, itemNo: d.itemNo,
      price: d.price, metal: d.metal, diameter: d.diameter, weight: d.weight,
      category: d.category, partner: d.partner, setNo: d.setNo
    }));
  }

  // 백그라운드(service worker)에 요청 — localbridge.js(ISOLATED)가 중계.
  // http 유비샵 페이지에서의 127.0.0.1 직접 fetch는 크롬 PNA로 차단되므로 우회.
  let _seq = 0;
  function sendToProgram(type, items) {
    return new Promise((resolve) => {
      const id = ++_seq;
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve({ ok: false, error: 'timeout(브리지 무응답 — 확장 재로드 필요?)' });
      }, 15000);
      function onMsg(e) {
        const d = e.data;
        if (!d || d.source !== 'ub-bridge' || d.id !== id || e.source !== window) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(d);
      }
      window.addEventListener('message', onMsg);
      window.postMessage({ source: 'ub-page', id, type, items }, '*');
    });
  }

  async function sendBarPrintReplacement() {
    try {
      window.UBOverlay && window.UBOverlay.show('인쇄 준비 중…');
      const data = await window.UBCollector.collect();
      if (!data || !data.length) { window.UBOverlay && window.UBOverlay.hide(); return false; } // 미선택 시 collector가 alert

      const items = toItems(data);
      log('인쇄 요청', items);
      window.UBOverlay && window.UBOverlay.show('인쇄 중…');

      const resp = await sendToProgram('print', items);
      window.UBOverlay && window.UBOverlay.hide();

      if (!resp || !resp.ok) {
        const err = (resp && resp.error) || '알 수 없는 오류';
        if (/Failed to fetch|timeout|연결|refused|fetch/i.test(err)) {
          alert('D102 인쇄 프로그램에 연결할 수 없습니다.\n\n' +
                '작업표시줄 트레이에 "D102 라벨 인쇄"가 실행 중인지 확인하세요.\n' +
                '없으면 프로그램을 실행한 뒤 다시 시도하세요.\n\n(' + err + ')');
        } else {
          alert('인쇄 실패: ' + err);
        }
      } else {
        log('인쇄 완료', resp.result);
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

  console.log('%c[유비샵 바코드 라벨] 활성화됨 (v2.1.0 — 백그라운드 인쇄)', 'color:#0a7;font-weight:bold');
  console.log('[UB] 바코드인쇄 → 백그라운드 → D102 인쇄 프로그램. 위치/문구 설정은 프로그램에서.');
})();
