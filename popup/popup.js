/* 팝업 메뉴 — 유비샵 스킨모드(마스터) + 세부옵션.
 * 상태: chrome.storage.local
 *   { ubSkin:OFF, ubDark:OFF, ubSidebar:ON, ubPageSize:ON, ubThumbEdit:ON, ubAutoSync:OFF }
 * 적용은 skin.js 가 ubSkin && 개별옵션 으로 게이팅.
 */
(function () {
  'use strict';

  const D = {
    ubSkin: false, ubDark: false, ubSidebar: true,
    ubPageSize: true, ubThumbEdit: true, ubAutoSync: false
  };

  const $ = id => document.getElementById(id);
  const skin = $('skin');
  const dark = $('dark');
  const sidebar = $('sidebar');
  const pageSize = $('pageSize');
  const thumb = $('thumb');
  const autoSync = $('autoSync');
  const sub = $('sub');

  try { $('ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) {}

  function render(s) {
    skin.checked = !!s.ubSkin;
    dark.checked = !!s.ubDark;
    sidebar.checked = !!s.ubSidebar;
    pageSize.checked = !!s.ubPageSize;
    thumb.checked = !!s.ubThumbEdit;
    autoSync.checked = !!s.ubAutoSync;
    sub.classList.toggle('hidden', !s.ubSkin);
    [dark, sidebar, pageSize, thumb, autoSync].forEach(el => { el.disabled = !s.ubSkin; });
  }

  function load(cb) { chrome.storage.local.get(D, cb); }
  function save(patch) { chrome.storage.local.set(patch); }

  load(render);

  skin.addEventListener('change', () => { save({ ubSkin: skin.checked }); load(render); });
  dark.addEventListener('change',     () => save({ ubDark: dark.checked }));
  sidebar.addEventListener('change',  () => save({ ubSidebar: sidebar.checked }));
  pageSize.addEventListener('change', () => save({ ubPageSize: pageSize.checked }));
  thumb.addEventListener('change',    () => save({ ubThumbEdit: thumb.checked }));
  autoSync.addEventListener('change', () => save({ ubAutoSync: autoSync.checked }));

  // 새 버전 감지 시 알림 블록 노출 + 재로드 버튼.
  // background.js checkUpdate 가 chrome.storage.local.ubUpdateAvailable 에 신버전
  // 문자열을 세팅한다(같지 않으면 반영). 팝업 열 때마다 이 값을 확인.
  try {
    chrome.storage.local.get({ ubUpdateAvailable: '' }, (r) => {
      const remoteVer = r && r.ubUpdateAvailable;
      const localVer = chrome.runtime.getManifest().version;
      if (remoteVer && remoteVer !== localVer) {
        const block = document.getElementById('update-block');
        const verLbl = document.getElementById('update-ver');
        if (verLbl) verLbl.textContent = 'v' + localVer + ' → v' + remoteVer;
        if (block) block.style.display = 'block';
      }
    });
    const btn = document.getElementById('update-btn');
    if (btn) btn.addEventListener('click', () => {
      // chrome.runtime.reload 는 확장 자체를 재시작. 팝업/뱃지 초기화됨.
      try { chrome.runtime.reload(); } catch (e) { alert('재로드 실패: ' + e); }
    });
  } catch (_) {}
})();
