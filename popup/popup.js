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
    const msg = document.getElementById('update-msg');
    // 새 버전 다운로드가 끝나면(onUpdateAvailable) 즉시 재시작하여 적용.
    try {
      chrome.runtime.onUpdateAvailable.addListener(() => {
        try { chrome.runtime.reload(); } catch (_) {}
      });
    } catch (_) {}
    function setMsg(t) { if (msg) msg.textContent = t || ''; }
    if (btn) btn.addEventListener('click', () => {
      // ★ chrome.runtime.reload() 는 "재시작"일 뿐 새 crx 를 받아오지 못한다.
      //   force_installed 확장은 requestUpdateCheck() 로 update_url(GitHub update.xml)
      //   을 확인 → 새 crx 다운로드 → onUpdateAvailable 또는 reload() 로 적용해야 한다.
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = 'GitHub에서 새 버전 받는 중…';
      setMsg('update.xml 확인 중… (방금 올린 버전은 최대 5분 지연될 수 있어요)');
      let settled = false;
      const finish = (status) => {
        if (settled) return; settled = true;
        if (status === 'update_available') {
          btn.textContent = '새 버전 적용 중…';
          setMsg('새 버전을 받았습니다. 확장을 다시 시작합니다.');
          try { chrome.runtime.reload(); } catch (_) {}
          return;
        }
        if (status === 'no_update') {
          setMsg('아직 최신으로 안 보입니다. GitHub 반영 대기(~5분) 후 다시 눌러주세요. 급하면 크롬을 완전히 껐다 켜세요.');
        } else if (status === 'throttled') {
          setMsg('검사 빈도 제한입니다. 잠시 후 다시 눌러주세요.');
        } else {
          setMsg('업데이트 확인 실패. 크롬을 완전히 종료 후 다시 켜면 자동 적용됩니다.');
        }
        btn.textContent = orig; btn.disabled = false;
      };
      try {
        const p = chrome.runtime.requestUpdateCheck((status) => finish(status));
        // MV3 는 Promise 도 반환 → 콜백 미호출 환경 대비
        if (p && typeof p.then === 'function') {
          p.then((r) => finish(Array.isArray(r) ? r[0] : (r && r.status) || r))
           .catch(() => finish('error'));
        }
      } catch (e) { finish('error'); }
      // 안전망: 15초 내 응답 없으면 안내
      setTimeout(() => finish('timeout'), 15000);
    });
  } catch (_) {}
})();
