/* 팝업 메뉴 — 유비샵 스킨모드(마스터) + 세부옵션.
 * 상태: chrome.storage.local
 *   { ubSkin:OFF, ubDark:OFF, ubSidebar:ON, ubPageSize:ON, ubThumbEdit:ON, ubAutoSync:OFF }
 * 적용은 skin.js 가 ubSkin && 개별옵션 으로 게이팅.
 */
(function () {
  'use strict';

  const D = {
    ubSkin: false, ubDark: false, ubSidebar: true,
    ubPageSize: true, ubThumbEdit: true, ubAutoSync: true
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
})();
