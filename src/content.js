/* =============================================================================
 *  content.js — 오케스트레이션 (기획서 8절 [INFRA])
 *  window.sendBarPrint 를 우리 구현으로 교체.
 *  버튼: <a href="javascript:sendBarPrint(form1,form2)">  → 클릭 시 여기로 진입.
 *
 *  기본 동작: 바코드인쇄 → 곧바로 인쇄(미리보기 모달 없음).
 *    크롬 인쇄창까지 없애려면 크롬을 --kiosk-printing 으로 실행(동봉 .bat).
 *  위치 조정: 페이지 우하단 "🏷 라벨위치" 버튼 → 편집기 모달(저장은 localStorage).
 * ========================================================================== */
(function () {
  'use strict';

  const log = (...a) => { if (window.UBCFG && window.UBCFG.debug) console.log('[UB][content]', ...a); };
  const original = window.sendBarPrint;

  function anyChecked() {
    return [...document.querySelectorAll('input[name="idx"]')].some(b => b.checked && b.value && b.value !== 'on');
  }

  // 위치 설정용 샘플(선택 항목이 없을 때 미리보기에 사용)
  function sampleData() {
    const F = window.UBCFG.fixed;
    return [{
      company: F.company, itemName: 'F-볼륨하트언발체인', itemNo: 'F-BF-Q-YG-ZZ-0096',
      price: 1830000, barcode: '2606RL', barcodePrefix: window.UBCFG.barcodePrefix,
      metal: '18K', diameter: '17', weight: '4.36g',
      category: 'FASHION', partner: '백*심9932/G', setNo: '',
      brandTop: F.brandTop, brandUrl: F.brandUrl
    }];
  }

  async function sendBarPrintReplacement() {
    try {
      window.UBOverlay && window.UBOverlay.show('인쇄 준비 중…');   // 즉시 피드백(수집/네트워크 동안)
      const data = await window.UBCollector.collect();
      if (!data || !data.length) {                 // 미선택 시 collector 가 alert
        window.UBOverlay && window.UBOverlay.hide();
        return false;
      }
      log('라벨 데이터:', data);
      if (window.UBCFG.print.previewBeforePrint) {
        window.UBOverlay && window.UBOverlay.hide();
        window.UBEditor.open(data);               // 미리보기 후 모달에서 인쇄
      } else {
        window.UBPrint.printDocument(window.UBLabel.buildDocument(data));  // 바로 인쇄(오버레이는 print.js 가 종료)
      }
    } catch (e) {
      window.UBOverlay && window.UBOverlay.hide();
      console.error('[UB] sendBarPrint 처리 중 오류:', e);
      alert('바코드 인쇄 중 오류가 발생했습니다. 콘솔(F12)을 확인하세요.\n' + (e && e.message));
    }
    return false;
  }

  window.sendBarPrint = sendBarPrintReplacement;
  window.__ubOriginalSendBarPrint = original;

  /* ---- 위치 설정 플로팅 버튼 ----------------------------------------- */
  function installSettingsButton() {
    const S = window.UBCFG.settingsButton;
    if (!S || !S.show) return;
    if (document.getElementById('ub-settings-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'ub-settings-btn';
    btn.type = 'button';
    btn.textContent = S.text;
    btn.style.cssText =
      `position:fixed;bottom:${S.bottom}px;right:${S.right}px;z-index:2147483000;` +
      `padding:8px 12px;background:#1f2937;color:#fff;border:0;border-radius:18px;` +
      `font:13px "Malgun Gothic",sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer;`;
    btn.addEventListener('mouseenter', () => btn.style.filter = 'brightness(1.15)');
    btn.addEventListener('mouseleave', () => btn.style.filter = '');
    btn.addEventListener('click', async () => {
      let data;
      if (anyChecked()) {
        data = await window.UBCollector.collect();   // 선택분 실데이터로 미리보기
      }
      if (!data || !data.length) data = sampleData();  // 없으면 샘플
      window.UBEditor.open(data);
    });
    document.body.appendChild(btn);
  }

  installSettingsButton();

  /* ---- 최초 실행: 위치 편집기 자동 오픈(저장 전까지 매번) -------------
   *  localStorage 동기 조회라 즉시 판별 가능(브리지 대기 불필요).            */
  setTimeout(() => {
    try {
      const editorOpen = !!document.getElementById('ub-ed-root');
      if (!editorOpen && !window.UBLabel.isConfigured()) {
        log('최초 실행(저장된 위치 없음) → 위치 편집기 자동 오픈');
        window.UBEditor.open(sampleData(), { firstRun: true });
      }
    } catch (e) { console.warn('[UB] 최초실행 체크 오류:', e); }
  }, 600);

  console.log('%c[유비샵 바코드 라벨] 활성화됨 (v1.7.0)', 'color:#0a7;font-weight:bold');
  console.log('[UB] 바코드인쇄=즉시인쇄, 우하단 "라벨위치"=위치설정. 설정: window.UBCFG');
})();
