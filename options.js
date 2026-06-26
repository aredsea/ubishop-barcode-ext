/* =============================================================================
 *  options.js — 확장 옵션 페이지 로직 (확장 컨텍스트, chrome.storage 직접)
 *  콘텐츠와 같은 label.js/editor.js 를 써서 동일한 양식으로 위치를 편집·저장한다.
 * ========================================================================== */
(function () {
  'use strict';

  const F = window.UBCFG.fixed;
  // 미리보기용 샘플(사진의 실제 항목)
  function sample() {
    return [{
      company: F.company, itemName: 'F-볼륨하트언발체인', itemNo: 'F-BF-Q-YG-ZZ-0096',
      price: 1830000, barcode: '2606RL', barcodePrefix: window.UBCFG.barcodePrefix,
      metal: '18K', diameter: '17', weight: '4.36g',
      category: 'FASHION', partner: '백*심9932/G', setNo: '',
      brandTop: F.brandTop, brandUrl: F.brandUrl
    }];
  }

  const $ = s => document.querySelector(s);

  function refreshStatus() {
    chrome.storage.local.get('UB_LAYOUT', o => {
      window.__UB_SAVED_LAYOUT = o.UB_LAYOUT || null;
      window.__UB_LAYOUT_LOADED = true;
      const el = $('[data-el=status]');
      if (o.UB_LAYOUT && o.UB_LAYOUT.length) {
        el.innerHTML = '<span class="ok">● 저장된 위치 설정 있음</span> — "위치 설정 열기"로 수정할 수 있습니다.';
      } else {
        el.innerHTML = '<span class="no">● 아직 위치 설정이 없습니다</span> — "위치 설정 열기"에서 맞추고 저장하세요.';
      }
    });
  }

  function openEditor() {
    // 최신 저장값을 전역에 반영 후 편집기 오픈
    chrome.storage.local.get('UB_LAYOUT', o => {
      window.__UB_SAVED_LAYOUT = o.UB_LAYOUT || null;
      window.__UB_LAYOUT_LOADED = true;
      window.UBEditor.open(sample(), {
        hidePrint: true,
        title: '라벨 위치 설정',
        banner: '드래그/수치로 위치를 맞춘 뒤 "저장"을 누르세요. 저장하면 인쇄에 적용됩니다.'
      });
    });
  }

  $('[data-el=open]').addEventListener('click', openEditor);
  $('[data-el=reset]').addEventListener('click', () => {
    if (confirm('저장된 위치 설정을 지우고 기본값으로 되돌릴까요?')) {
      window.UBLabel.resetLayout();   // chrome.storage 직접 삭제됨(옵션 컨텍스트)
      setTimeout(refreshStatus, 100);
    }
  });

  // 저장 시 상태 갱신(편집기 저장은 chrome.storage.set → onChanged)
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.UB_LAYOUT) refreshStatus();
  });

  refreshStatus();
})();
