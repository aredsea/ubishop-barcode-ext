/* 팝업 메뉴 — 유비샵 스킨모드(마스터) + 세부옵션(다크모드 / 썸네일수정).
 * 상태: chrome.storage.local { ubSkin(기본OFF), ubDark(기본ON), ubThumbEdit(기본ON) }.
 * 적용은 skin.js 가 ubSkin && 개별옵션 으로 게이팅. */
(function () {
  'use strict';
  const skin = document.getElementById('skin');
  const dark = document.getElementById('dark');
  const thumb = document.getElementById('thumb');
  const sub = document.getElementById('sub');

  try { document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) {}

  function render(s) {
    skin.checked = !!s.ubSkin;
    dark.checked = !!s.ubDark;
    thumb.checked = !!s.ubThumbEdit;
    sub.classList.toggle('hidden', !s.ubSkin);   // 마스터 OFF면 세부 숨김
    dark.disabled = !s.ubSkin;
    thumb.disabled = !s.ubSkin;
  }

  chrome.storage.local.get({ ubSkin: false, ubDark: false, ubThumbEdit: true }, render);

  skin.addEventListener('change', () => {
    chrome.storage.local.set({ ubSkin: skin.checked });
    chrome.storage.local.get({ ubSkin: false, ubDark: false, ubThumbEdit: true }, render);
  });
  dark.addEventListener('change', () => chrome.storage.local.set({ ubDark: dark.checked }));
  thumb.addEventListener('change', () => chrome.storage.local.set({ ubThumbEdit: thumb.checked }));
})();
