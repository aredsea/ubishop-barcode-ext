/* =============================================================================
 *  print.js — 숨은 iframe 인쇄 (기획서 8절 [PRINT])
 *  팝업 차단을 피하려고 새 창 대신 숨은 iframe 에 문서를 써서 인쇄한다.
 *  라벨당 1페이지(@page + page-break-after:always 는 label.js CSS 에서 처리).
 * ========================================================================== */
(function () {
  'use strict';

  const FRAME_ID = '__ubBarFrame';

  function printDocument(html) {
    const old = document.getElementById(FRAME_ID);
    if (old) old.remove();

    const frame = document.createElement('iframe');
    frame.id = FRAME_ID;
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    document.body.appendChild(frame);

    const fdoc = frame.contentWindow.document;
    fdoc.open();
    fdoc.write(html);
    fdoc.close();

    if (window.UBOverlay) window.UBOverlay.show('인쇄 중…');

    // SVG 바코드 렌더 + Pretendard 폰트 로드가 끝난 뒤 인쇄 트리거.
    const cfgWait = (window.UBCFG && window.UBCFG.print && window.UBCFG.print.waitFontsMs) || 200;
    const fire = () => {
      const fdocReady = frame.contentWindow.document;
      const go = () => {
        try {
          frame.contentWindow.focus();
          frame.contentWindow.print();   // --kiosk-printing 이면 다이얼로그 없이 즉시 인쇄
        } catch (e) {
          console.error('[UB] print 실패:', e);
        } finally {
          // 인쇄창(또는 무다이얼로그 인쇄) 처리 후 오버레이 제거
          if (window.UBOverlay) setTimeout(() => window.UBOverlay.hide(), 600);
        }
      };
      // 폰트 로딩 완료를 기다린다(Pretendard 첫 인쇄 누락 방지)
      if (fdocReady.fonts && fdocReady.fonts.ready) {
        Promise.race([
          fdocReady.fonts.ready,
          new Promise(r => setTimeout(r, 1500))   // 최대 대기 안전장치
        ]).then(() => setTimeout(go, cfgWait));
      } else {
        setTimeout(go, cfgWait);
      }
    };
    if (frame.contentWindow.document.readyState === 'complete') {
      setTimeout(fire, 50);
    } else {
      frame.addEventListener('load', () => setTimeout(fire, 50), { once: true });
    }
  }

  window.UBPrint = { printDocument };
})();
