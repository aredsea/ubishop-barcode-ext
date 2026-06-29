/* 팝업 메뉴 — 유비샵 스킨모드 토글. 상태는 chrome.storage.local.ubSkin (기본 OFF). */
(function () {
  'use strict';
  const cb = document.getElementById('skin');

  try {
    document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  } catch (e) {}

  chrome.storage.local.get({ ubSkin: false }, d => { cb.checked = !!(d && d.ubSkin); });

  cb.addEventListener('change', () => {
    chrome.storage.local.set({ ubSkin: cb.checked });
    // 열려 있는 유비샵 탭에 즉시 반영(스킨 콘텐츠 스크립트가 storage.onChanged 로도 받지만,
    // 새 탭/프레임 보장을 위해 reload 안내는 popup.html 하단 문구로 처리).
  });
})();
