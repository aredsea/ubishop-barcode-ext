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

/* =============================================================================
 *  계정 빠른 전환 — 다계정 관리 + 자동 로그아웃/로그인 트리거
 *  비번은 AES-GCM 으로 암호화해 chrome.storage.local 에 저장(평문 아님).
 *  [전환] → ubPendingLogin 저장 + 현재 탭 로그아웃 → autologin.js(honsu114) 가 이어받음.
 * ========================================================================== */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const listEl = $('acct-list'), formEl = $('acct-form');
  if (!listEl) return;

  // autologin.js 와 동일한 키 파생(AES-GCM). 소금은 최초 1회 생성해 저장.
  async function vaultKey() {
    let g = await chrome.storage.local.get('ubLoginSalt');
    let saltB64 = g && g.ubLoginSalt;
    if (!saltB64) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      saltB64 = btoa(String.fromCharCode(...salt));
      await chrome.storage.local.set({ ubLoginSalt: saltB64 });
    }
    const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
    const pass = new TextEncoder().encode('ubshop-acct-vault-v1|' + (chrome.runtime && chrome.runtime.id || 'x'));
    const base = await crypto.subtle.importKey('raw', pass, 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function enc(text) {
    const key = await vaultKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
    return { iv: btoa(String.fromCharCode(...iv)), ct: btoa(String.fromCharCode(...new Uint8Array(ct))) };
  }

  const uid = () => 'a' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  const getAccounts = async () => (await chrome.storage.local.get('ubAccounts')).ubAccounts || [];
  const setAccounts = (list) => chrome.storage.local.set({ ubAccounts: list });
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  async function renderList() {
    const accs = await getAccounts();
    if (!accs.length) { listEl.innerHTML = '<div class="acct-empty">등록된 계정이 없습니다. 아래에서 추가하세요.</div>'; return; }
    listEl.innerHTML = accs.map(a =>
      `<div class="acct-row"><div class="acct-meta"><b>${esc(a.alias || a.userid)}</b><span>${esc(a.userid)}</span></div>` +
      `<button class="acct-go" data-id="${a.id}">전환</button>` +
      `<button class="acct-del" data-id="${a.id}" title="삭제">✕</button></div>`).join('');
    listEl.querySelectorAll('.acct-go').forEach(b => b.addEventListener('click', () => switchTo(b.dataset.id)));
    listEl.querySelectorAll('.acct-del').forEach(b => b.addEventListener('click', () => del(b.dataset.id)));
  }
  async function del(id) {
    if (!confirm('이 계정을 삭제할까요?')) return;
    await setAccounts((await getAccounts()).filter(a => a.id !== id));
    renderList();
  }
  async function add() {
    const alias = $('acct-alias').value.trim();
    const userid = $('acct-id').value.trim();
    const pw = $('acct-pw').value;
    if (!userid || !pw) { alert('아이디와 비밀번호를 입력하세요.'); return; }
    const pwEnc = await enc(pw);
    const accs = await getAccounts();
    accs.push({ id: uid(), alias, userid, pwEnc });
    await setAccounts(accs);
    $('acct-alias').value = ''; $('acct-id').value = ''; $('acct-pw').value = '';
    formEl.style.display = 'none';
    renderList();
  }
  async function switchTo(id) {
    await chrome.storage.local.set({ ubPendingLogin: { accountId: id, ts: Date.now(), step: 0 } });
    let tab = null;
    try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (_) {}
    // 관리자(ubshop.biz)면 확인된 /logout.do 로, 그 외(honsu114 등)면 honsu114 홈으로 보내고
    // autologin.js 가 페이지의 실제 '로그아웃' 링크로 로그아웃→로그인 흐름을 이어받는다.
    let url = 'https://www.honsu114.com/';
    try { const u = new URL(tab.url); if (/ubshop\.biz$/i.test(u.hostname)) url = u.origin + '/logout.do'; } catch (_) {}
    try { await chrome.tabs.update(tab.id, { url }); } catch (_) {}
    window.close();
  }

  $('acct-add-btn').addEventListener('click', () => {
    formEl.style.display = formEl.style.display === 'none' ? 'block' : 'none';
  });
  $('acct-save').addEventListener('click', add);
  $('acct-cancel').addEventListener('click', () => { formEl.style.display = 'none'; });
  renderList();
})();
