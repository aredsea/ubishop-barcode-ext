/* =============================================================================
 *  loader.js — 라이브 자동업데이트 로더 (v1.3.0+)
 *
 *  설치본에는 이 로더 + JsBarcode + 폰트(고정 자산)만 들어간다.
 *  실제 로직(config/barcode/collector/label/print/editor/content)은 매 페이지
 *  로드 시 GitHub raw 에서 가져와 실행한다. → 저장소에 push 하면 매장 PC가
 *  다음 페이지 열 때 자동 반영(인터넷 연결 시). 오프라인은 마지막 캐시로 동작.
 *
 *  ⚠ 최초 1회는 인터넷 연결 필요(캐시 생성). 이후 오프라인 동작.
 * ========================================================================== */
(function () {
  'use strict';

  /* ====== 자동업데이트 소스 (저장소 정보) — 배포 시 여기만 맞추면 됨 ====== */
  var REPO = {
    owner: 'aredsea',              // GitHub 사용자명
    repo: 'ubishop-barcode-ext',
    branch: 'main'
  };
  /* ===================================================================== */

  var RAW = 'https://raw.githubusercontent.com/' + REPO.owner + '/' + REPO.repo + '/' + REPO.branch + '/';
  var CACHE_KEY = 'UB_APP_CACHE_v1';

  function log() {
    try { console.log.apply(console, ['[UB][loader]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  function inject(code) {
    var s = document.createElement('script');
    s.textContent = code;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  }

  async function fetchText(path) {
    var r = await fetch(RAW + path, { cache: 'no-cache', credentials: 'omit' });
    if (!r.ok) throw new Error(path + ' HTTP ' + r.status);
    return await r.text();
  }

  async function loadRemote() {
    var manifest = JSON.parse(await fetchText('app-files.json'));
    var parts = await Promise.all(manifest.files.map(fetchText));
    var code = '/* UB app v' + manifest.version + ' */\n' + parts.join('\n;\n');
    return { code: code, version: manifest.version };
  }

  async function boot() {
    var code = null, ver = null, src = 'remote';
    try {
      var r = await loadRemote();
      code = r.code; ver = r.version;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ version: ver, code: code, ts: Date.now() })); } catch (e) {}
      log('원격 로드 성공 v' + ver);
    } catch (e) {
      console.warn('[UB][loader] 원격 로드 실패 → 캐시 사용:', e && e.message);
      try {
        var c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (c && c.code) { code = c.code; ver = c.version; src = 'cache'; }
      } catch (_) {}
    }
    if (!code) {
      alert('유비샵 바코드 확장: 최초 1회는 인터넷 연결이 필요합니다.\n인터넷 연결 후 페이지를 새로고침하세요.');
      return;
    }
    try { inject(code); log('실행 완료 (' + src + ') v' + ver); }
    catch (e) { console.error('[UB][loader] 실행 오류:', e); }
  }

  boot();
})();
