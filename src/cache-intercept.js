/* =============================================================================
 *  cache-intercept.js — Phase 2 Transparent Caching. MAIN world, loader 동적로드.
 *
 *  유비샵 매장매출전표·매장출고전표에서 사용자 form1 검색을 가로채:
 *  ① 같은 검색 캐시 hit → table.t_list 즉시 교체 (서버 fetch 0초)
 *  ② miss → SW가 ubdstore 단일 URL fetch → 캐시 저장 + 화면 갱신
 *  ③ 모두 실패 → _bypassNextSubmit 후 평소 form.submit() 폴백
 *
 *  loader.js 메커니즘으로 GitHub raw에서 매 페이지 로드마다 가져와 inject.
 *  → 코드 수정은 GitHub push 만으로 매장 PC 다음 새로고침 시 자동 반영.
 *
 *  v3.1.1 fix 내역:
 *  - Bug A: form[name="form1"]만 binding (이전 v3.1.0은 페이지의 모든 form에
 *    가로채기 걸려 form2(idx 일괄선택) 동작 망가질 위험 있었음)
 *  - Bug F: t_list "마지막 = 결과" 가정 폐기. rowCount 최대인 것을 결과로 선택.
 *  - 명시적 로깅 + 토스트로 분기 가시화. SW 응답 ok=false 시 어디서 실패했는지
 *    F12 콘솔에서 즉시 판단 가능.
 *
 *  v3.1.2 변경 내역:
 *  - fetch를 SW(background.js)가 아니라 여기서 직접 수행 (same-origin, MAIN
 *    world). 이유: background.js는 loader 관리 대상이 아니라 폴더 교체 없이는
 *    갱신 불가 → 매장 PC들은 여전히 구버전 SW(8s timeout)로 동작. 이 파일에서
 *    직접 fetch 하면 GitHub push 만으로 timeout/로직 즉시 적용.
 *  - 콘솔에 UB_CACHE_VERSION + body.dataset.ubCacheVer 심음 → F12 로 실제
 *    로드된 로직 버전 확인 가능(chrome://extensions 의 manifest 버전과 별개).
 *  - hit 토스트에 이전 refresh 시 잰 서버 실측시간 표시(persisted.lastMs).
 *    사용자가 "얼마 절약됐는지" 매 hit 마다 즉시 체감.
 * ========================================================================== */
(function () {
  'use strict';

  const UB_CACHE_VERSION = '3.1.2';

  const CACHE_PAGES = {
    '/jun/delivitem/delivItemList.do':   '매장출고전표',
    '/jun/clientpay/clientPayJunList.do': '매장매출전표'
  };
  if (!CACHE_PAGES[location.pathname]) return;

  const log = (...a) => { try { console.log('[UB][cache]', ...a); } catch (_) {} };
  log('loaded v' + UB_CACHE_VERSION, 'on', location.pathname);
  try { if (document.body) document.body.dataset.ubCacheVer = UB_CACHE_VERSION; } catch (_) {}

  /* ---- bridge: MAIN ↔ localbridge(ISOLATED) ↔ SW ---- */
  let _seq = 0;
  function sendBg(msg) {
    return new Promise((resolve) => {
      const id = ++_seq;
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve({ ok: false, error: 'bridge timeout' });
      }, 12000);
      function onMsg(e) {
        const d = e.data;
        if (!d || d.source !== 'ub-bridge' || d.id !== id || e.source !== window) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(d);
      }
      window.addEventListener('message', onMsg);
      window.postMessage(Object.assign({}, msg, { source: 'ub-page', id }), '*');
    });
  }

  /* ---- form / cache key ---- */
  function getSearchForm() {
    return document.querySelector('form[name="form1"]');
  }
  function formKeySource(f) {
    const entries = [];
    for (const el of f.elements) {
      if (!el.name) continue;
      const t = (el.type || '').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image' || t === 'file') continue;
      if (t === 'checkbox' || t === 'radio') { if (!el.checked) continue; }
      entries.push(el.name + '=' + (el.value == null ? '' : el.value));
    }
    entries.sort();
    return location.pathname + '?' + entries.join('&');
  }
  async function sha256_16(s) {
    try {
      const buf = new TextEncoder().encode(s);
      const h = await crypto.subtle.digest('SHA-256', buf);
      return [...new Uint8Array(h)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (_) {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
      return 'h' + (h >>> 0).toString(16);
    }
  }
  /* ---- ubdstore 직접 fetch (v3.1.2: SW cacheFetchSearch 대체) ----
   *  MAIN world content script 는 same-origin(ubdstore.ubshop.biz) 이라 credentials
   *  포함 fetch 가능. SW 로직을 여기로 옮긴 이유는 파일 상단 주석 참고.
   *  응답 구조는 SW fetchUbdstore 와 동일하게 유지 → handleSearchSubmit 분기
   *  로직(ok/aborted/status/bytes) 그대로 재사용.
   */
  const FETCH_TIMEOUT_MS = 20000;
  async function fetchUbdstoreDirect(url) {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        credentials: 'include',
        cache: 'no-cache',
        signal: ctrl.signal,
        redirect: 'follow'
      });
      clearTimeout(tid);
      const buf = await r.arrayBuffer();
      const bytes = buf.byteLength;
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      let decoder = 'utf-8';
      if (ct.includes('euc-kr') || ct.includes('ks_c_5601') || ct.includes('ksc5601')) {
        decoder = 'euc-kr';
      } else if (!ct.includes('utf-8') && bytes > 0) {
        try {
          const sample = new TextDecoder('utf-8', { fatal: false })
            .decode(buf.slice(0, Math.min(4096, bytes)));
          const replCount = (sample.match(/�/g) || []).length;
          if (replCount > 5) decoder = 'euc-kr';
        } catch (_) {}
      }
      let html = '';
      try { html = new TextDecoder(decoder).decode(buf); }
      catch (_) {
        try { html = new TextDecoder(decoder === 'utf-8' ? 'euc-kr' : 'utf-8').decode(buf); } catch (__) {}
      }
      const hasResultsMarker = html.indexOf('class="t_list"') >= 0 || html.indexOf("class='t_list'") >= 0;
      const ok = r.ok && bytes > 500 && hasResultsMarker;
      return { ok, html, bytes, status: r.status, decoder, contentType: ct, elapsedMs: Date.now() - t0 };
    } catch (e) {
      clearTimeout(tid);
      const aborted = e && e.name === 'AbortError';
      return {
        ok: false,
        error: aborted ? ('timeout after ' + FETCH_TIMEOUT_MS + 'ms') : String(e && e.message || e),
        aborted,
        elapsedMs: Date.now() - t0
      };
    }
  }

  function formToUrl(f) {
    const action = f.getAttribute('action') || (location.pathname + location.search);
    const u = new URL(action, location.href);
    for (const el of f.elements) {
      if (!el.name) continue;
      const t = (el.type || '').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image' || t === 'file') continue;
      if (t === 'checkbox' || t === 'radio') { if (!el.checked) continue; }
      u.searchParams.set(el.name, el.value == null ? '' : el.value);
    }
    return u.toString();
  }

  /* ---- t_list 교체. Bug F fix: 행수 최대인 것을 결과로 선택 ---- */
  function pickResultTList(list) {
    if (!list || !list.length) return null;
    let best = list[0];
    let bestN = (best.rows && best.rows.length) || 0;
    for (let i = 1; i < list.length; i++) {
      const n = (list[i].rows && list[i].rows.length) || 0;
      if (n > bestN) { bestN = n; best = list[i]; }
    }
    return best;
  }
  /* ---- 응답 HTML 의 본문 wrapper 찾기 ----
   *  실측 페이지 구조:
   *    body
   *    ├─ #ajaxBox
   *    ├─ table (상단 메뉴)
   *    ├─ script (newWindow2 등 함수 정의)
   *    ├─ table  ← ★ 본문 wrapper. form[name="form1"] 과 결과 t_list,
   *    │           합계, 페이지 카운트, tooltip2 일부 가 모두 이 안.
   *    └─ aside#ub-sidebar  (우리 사이드바)
   *
   *  body 통째 교체는 일부 케이스에서 body 가 null 이 되어 후속 호출
   *  모두 실패하는 부작용 있었음(v3.1.1 사용자 보고). → body 안 건드리고
   *  본문 wrapper(form1 포함 body 직속 자식) outerHTML 만 교체.
   */
  function findContentWrapper(root) {
    const body = (root && root.body) || (root === document ? document.body : null);
    if (!body || !body.children) return null;
    for (const c of body.children) {
      if (c && c.querySelector && c.querySelector('form[name="form1"]')) return c;
    }
    return null;
  }

  function replaceTList(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      if (!doc || !doc.body) {
        log('replaceTList: response has no body');
        return false;
      }
      if (doc.querySelectorAll('table.t_list').length === 0) {
        log('replaceTList: response has no t_list — treat as fail');
        return false;
      }
      if (!document.body) {
        log('replaceTList: page body is null — abort');
        return false;
      }

      // 본문 wrapper 찾기
      const curWrap = findContentWrapper(document);
      const newWrap = findContentWrapper(doc);
      if (!curWrap || !newWrap) {
        log('replaceTList: content wrapper not found', { cur: !!curWrap, new: !!newWrap });
        return false;
      }

      // 스크롤 보존
      const oldScroll = window.scrollY || window.pageYOffset || 0;

      // 검색 시점 form 값 snapshot (응답의 select 기본값(2000/01/01 등)으로 reset 방지)
      const formSnap = {};
      try {
        for (const el of f.elements) {
          if (!el.name) continue;
          formSnap[el.name] = el.value;
        }
      } catch (_) {}

      // 본문 wrapper 의 innerHTML 만 교체 — wrapper element 자체(curWrap reference)는
      // 그대로 유지. outerHTML 로 하면 curWrap 이 detach 되어 후속 contains()
      // 검사가 항상 false 가 되는 버그(wrapper 안 tooltip 까지 모두 제거) 발생.
      curWrap.innerHTML = newWrap.innerHTML;

      // form 값 복원 — 새 form1 의 select 들이 응답의 default("2000/01") 가 아니라
      // 사용자가 검색한 그 값(06/30 등) 이 selected 상태 가 되도록.
      try {
        const newF = curWrap.querySelector('form[name="form1"]');
        if (newF) {
          for (const name in formSnap) {
            const el = newF.elements[name];
            if (!el) continue;
            try { el.value = formSnap[name]; } catch (_) {}
          }
        }
      } catch (_) {}

      // tooltip 강제 sync + 진단 — 응답에서 wrapper 안/밖 둘 다 모아 page 에 보장.
      // 페이지의 toolTip2.js previewMove() 가 document.getElementById(id) 로 찾는데
      // null 이면 fail(parentElement of null). → 우리가 tooltip element 존재 보장.
      let dbgWrapTC = 0, dbgBodyTC = 0, dbgRespWrapTC = 0, dbgRespBodyTC = 0;
      try {
        const respAll = doc.querySelectorAll('div.tooltip2');
        dbgRespBodyTC = respAll.length;
        dbgRespWrapTC = newWrap.querySelectorAll('div.tooltip2').length;

        // 사이드바 외 잔상 정리: wrapper 안의 새 응답 것은 보존, 그 외 제거
        document.querySelectorAll('div.tooltip2').forEach(t => {
          if (t.closest && t.closest('#ub-sidebar')) return;
          if (curWrap.contains(t)) return;
          t.remove();
        });

        // 응답의 모든 tooltip 중 wrapper 밖의 것 body 에 추가(페이지가 그렇게 구성된 경우)
        // + wrapper 안에 없는 tooltip 도 body 에 추가해서 getElementById 안전 보장.
        const wrapIds = new Set();
        curWrap.querySelectorAll('div.tooltip2[id]').forEach(t => wrapIds.add(t.id));
        respAll.forEach(t => {
          if (!t.id) return;
          if (wrapIds.has(t.id)) return;   // wrapper 안에 이미 같은 id 존재
          if (!document.body) return;
          document.body.appendChild(t.cloneNode(true));
          wrapIds.add(t.id);
        });

        dbgWrapTC = curWrap.querySelectorAll('div.tooltip2').length;
        dbgBodyTC = document.querySelectorAll('div.tooltip2').length;
      } catch (_) {}
      log('tooltip sync', { pageWrap: dbgWrapTC, pageBodyTotal: dbgBodyTC, respWrap: dbgRespWrapTC, respBodyTotal: dbgRespBodyTC });

      // 응답 inline script 재실행 — 본문 wrapper 안 + body 직속 script(wrapper 밖).
      // tooltip 데이터 매핑/함수 정의 등이 inline script 에 있으면 갱신 필요.
      try {
        // wrapper 안 script
        const wrapScripts = Array.from(newWrap.querySelectorAll('script'));
        // body 직속의 wrapper 밖 script
        const bodyScripts = doc.body ? Array.from(doc.body.children).filter(c => c.tagName === 'SCRIPT') : [];
        const allScripts = wrapScripts.concat(bodyScripts);
        allScripts.forEach(s => {
          if (s.src) return;
          const code = (s.textContent || '').trim();
          if (!code) return;
          // 위험 차단: document.write, location 변경, document.body 직접 조작
          if (/document\.write|location\.(href|replace|assign)\s*=|document\.body\s*=/.test(code)) return;
          try {
            const tmp = document.createElement('script');
            tmp.textContent = code;
            document.head.appendChild(tmp);
            document.head.removeChild(tmp);
          } catch (_) {}
        });
      } catch (_) {}

      // 스크롤 복원
      try { window.scrollTo(0, oldScroll); } catch (_) {}

      // 새 form 에 가로채기 재바인딩 (innerHTML 교체로 form1 element 새로 만들어짐)
      // — wrapper element 는 유지지만 그 안 form 은 새 element 이므로 dataset 도 새것.
      setTimeout(() => { try { bind(); } catch (_) {} }, 0);

      log('replaceTList: wrapper.innerHTML swap (body+wrapper intact, ref preserved)');
      return true;
    } catch (e) {
      console.warn('[UB][cache] replaceTList failed:', e);
      return false;
    }
  }

  /* ---- 토스트 (body null 방어) ---- */
  function showToast(msg, kind) {
    try {
      const host = document.body || document.documentElement;
      if (!host) return;   // body/html 둘 다 없으면 표시 자체 skip
      let t = document.getElementById('ub-cache-toast');
      if (!t) {
        t = document.createElement('div');
        t.id = 'ub-cache-toast';
        t.style.cssText = 'position:fixed;top:18px;right:18px;padding:10px 16px;color:#fff;border-radius:8px;font:600 12px/1.3 Pretendard,sans-serif;z-index:2147483647;pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,.25);transition:opacity .2s;max-width:280px';
        host.appendChild(t);
      }
      const colors = { ok: 'rgba(15,20,25,.92)', hit: 'linear-gradient(90deg,#35C5F0,#1aa0d4)', err: 'rgba(220,38,38,.92)' };
      t.style.background = colors[kind || 'ok'];
      t.textContent = msg;
      t.style.opacity = '1';
      clearTimeout(showToast._h);
      showToast._h = setTimeout(() => { try { t.style.opacity = '0'; } catch (_) {} }, 2200);
    } catch (_) {}
  }

  /* ---- 페이지 자체 로딩 스피너 끄기 + body display 복원 ----
   *  유비샵 페이지는 form submit 시 (a) #ajaxBox(loading.gif) 띄우고
   *  (b) <body> 자체를 display:none 처리한 다음 navigate 완료 시 둘 다 복원한다.
   *  우리가 가로채면 navigate 안 일어나서 body 가 영원히 hide → 흰 화면.
   *  capture-phase preventDefault + stopImmediatePropagation 만으로는 부족:
   *  페이지의 onsubmit attribute (target-phase) 또는 다른 element 핸들러는
   *  여전히 실행되어 body 를 hide 시킬 수 있음. → MutationObserver 로
   *  지속 감시하다 display:none 검출 즉시 복원.
   */
  function hidePageLoaders() {
    try {
      const ajaxBox = document.getElementById('ajaxBox');
      if (ajaxBox) ajaxBox.style.display = 'none';
      document.querySelectorAll('#ajaxBox, .ajaxBox, .ajax_box, .ajax-box').forEach(el => {
        if (el && el.style) el.style.display = 'none';
      });
      if (document.body && document.body.style.display === 'none') document.body.style.display = '';
      if (document.documentElement && document.documentElement.style.display === 'none') document.documentElement.style.display = '';
      document.querySelectorAll('#wrap, #container, #content, #main, .wrap, .container, .content, .main').forEach(el => {
        if (el && el.style && el.style.display === 'none') el.style.display = '';
      });
    } catch (_) {}
  }

  /* ---- body/html display:none 영구 감시 가드 ----
   *  IIFE 시작 시 1회 설치. body 와 html 의 style 속성 변화를 감시 → 누가
   *  display:none 으로 바꾸면 즉시 복원. 페이지의 onsubmit attribute 처럼
   *  capture phase 에서 차단 불가한 코드에 대한 최후 방어선.
   */
  function installVisibilityGuard() {
    try {
      if (window.__ubVisibilityGuard) return;
      window.__ubVisibilityGuard = true;
      const restore = () => {
        if (document.body && document.body.style.display === 'none') {
          document.body.style.display = '';
        }
        if (document.documentElement && document.documentElement.style.display === 'none') {
          document.documentElement.style.display = '';
        }
      };
      const mo = new MutationObserver(restore);
      const observe = () => {
        if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ['style'] });
        if (document.documentElement) mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
      };
      observe();
      // 초기 1회 — 이미 hide 되어 있을 수도
      restore();
      log('visibility guard installed');
    } catch (e) { console.warn('[UB][cache] visibility guard failed:', e); }
  }
  installVisibilityGuard();

  /* ---- 통계 영구 저장 (localStorage) ----
   *  cacheStat 은 skin.js 메모리에만 있어 F5 시 0으로 리셋. localStorage 에
   *  cache-intercept 측에서 누적값 저장 + 페이지 로드 시 그 누적값을 한 번에
   *  postMessage 로 skin.js 에 전달 → 사이드바 카드가 F5 후에도 누적값 유지.
   */
  const STATS_KEY = 'UB_CACHE_STATS_v1';
  function loadPersistedStats() {
    try {
      const raw = localStorage.getItem(STATS_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (s && typeof s === 'object') return s;
    } catch (_) {}
    return null;
  }
  function savePersistedStats(s) {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch (_) {}
  }
  const persisted = loadPersistedStats() || { hits: 0, miss: 0, fillMs: 0, savedMs: 0, lastMs: 0 };
  // 페이지 로드 시 skin.js 에 누적값 전달 (delta = 현재 저장된 절대값)
  // skin.js listener 는 += 누적 모델이라 boot 시 한 번 보내면 누적치 복원.
  setTimeout(() => {
    try {
      window.postMessage({
        source: 'ub-cache-stat',
        hits: persisted.hits, miss: persisted.miss,
        fillMs: persisted.fillMs, savedMs: persisted.savedMs,
        lastMs: persisted.lastMs
      }, '*');
    } catch (_) {}
  }, 300);   // skin.js renderSidebar 가 한 사이클 돈 후

  /* ---- 사이드바 통계 sync (skin.js ISOLATED world 가 listen) + 영구 저장 ----
   *  MAIN world 인 우리는 chrome.runtime 직접 못 씀 → window.postMessage 로
   *  같은 페이지의 skin.js 에 delta 보냄. skin.js 에는 이미 listener
   *  존재(message.source === 'ub-cache-stat').
   *  동시에 localStorage 의 누적값도 update → F5 후 boot 시 복원.
   */
  function postStats(delta) {
    try {
      const msg = Object.assign({ source: 'ub-cache-stat' }, delta || {});
      window.postMessage(msg, '*');
      // localStorage 누적 갱신
      if (delta && typeof delta === 'object') {
        if (delta.hits)    persisted.hits    += delta.hits;
        if (delta.miss)    persisted.miss    += delta.miss;
        if (delta.fillMs)  persisted.fillMs  += delta.fillMs;
        if (delta.savedMs) persisted.savedMs += delta.savedMs;
        if (typeof delta.lastMs === 'number') persisted.lastMs = delta.lastMs;
        savePersistedStats(persisted);
      }
    } catch (_) {}
  }

  /* ---- 핵심 가로채기 ---- */
  let _bypassNextSubmit = false;

  async function handleSearchSubmit(f, e) {
    if (_bypassNextSubmit) { _bypassNextSubmit = false; return; }

    e.preventDefault();
    // 페이지의 다른 submit 핸들러(스피너 띄움 + body hide)가 우리 뒤에 실행되지
    // 않도록 차단. 이렇게 하면 우리 흐름 동안 body 가 hide 되는 일도 막힘.
    e.stopImmediatePropagation();

    const url = formToUrl(f);
    const keySrc = formKeySource(f);
    const key = await sha256_16(keySrc);
    log('submit', { path: location.pathname, url: url.slice(0, 200), key });
    showToast('검색…', 'ok');

    // 1) 캐시 조회
    // D102LabelPrinter(C#) 는 entry 를 PascalCase 로 반환:
    //   { Path, Date, Html, FetchedAt, SizeBytes }
    // → camelCase/PascalCase 둘 다 시도 (서버 측 직렬화 변경에도 견고).
    const cached = await sendBg({ type: 'cacheGetSearch', pathKey: 'search:' + location.pathname, key });
    const cachedEntry = cached && cached.entry;
    const cachedHtml = cachedEntry && (cachedEntry.html || cachedEntry.Html);
    if (cached && cached.hit && cachedHtml) {
      const ok = replaceTList(cachedHtml);
      log('hit', { ok, htmlLen: cachedHtml.length });
      if (ok) {
        history.replaceState({}, '', url);
        hidePageLoaders();
        // hit 시 lastMs 는 건드리지 않음 (persisted 값 = 마지막 실측 서버시간)
        postStats({ hits: 1 });
        // "이번에 절약된 시간" = 마지막 refresh/miss 때 잰 서버 응답시간.
        // persisted.lastMs 가 있으면 hit 토스트에 함께 표시(체감 가시화).
        const saved = persisted && persisted.lastMs;
        const savedTxt = (saved && saved > 100) ? ' (서버 ' + (saved / 1000).toFixed(1) + '초 절약)' : '';
        showToast('캐시 즉시 표시' + savedTxt, 'hit');
        sendBg({ type: 'telemetry', payload: { type: 'cache_hit_search', path: location.pathname } });
        refreshInBg(url, key);
        return;
      }
    } else {
      log('cache miss', { hit: cached && cached.hit, hasEntry: !!cachedEntry, hasHtml: !!cachedHtml });
    }

    // 2) miss → 서버 fetch (v3.1.2: SW 경유 폐기, 같은 world 에서 직접 fetch)
    sendBg({ type: 'telemetry', payload: { type: 'cache_miss_search', path: location.pathname } });
    const t0 = Date.now();
    const resp = await fetchUbdstoreDirect(url);
    const ms = Date.now() - t0;
    log('miss fetch result', { ok: resp && resp.ok, bytes: resp && resp.bytes, status: resp && resp.status, err: resp && resp.error, ms });
    if (resp && resp.ok && resp.html) {
      const ok = replaceTList(resp.html);
      log('miss replaceTList', { ok });
      if (ok) {
        history.replaceState({}, '', url);
        hidePageLoaders();
        postStats({ miss: 1, fillMs: ms, lastMs: ms });
        showToast('서버 ' + (ms / 1000).toFixed(1) + '초 → 캐시 저장', 'ok');
        sendBg({ type: 'cachePutSearch', pathKey: 'search:' + location.pathname, key, html: resp.html });
        sendBg({ type: 'telemetry', payload: { type: 'cache_fill_search', path: location.pathname, ms } });
        return;
      }
    }

    // 3) 모두 실패 → 평소 form submit으로 fallback
    // (스피너는 fallback navigate가 끝낼 거라 hide 안 함 — navigate 중엔 정상이라 사용자에겐 자연스러움)
    // 사용자에게 어느 분기인지 명확히: timeout / 서버에러 / 응답 파싱 실패
    let reason = '캐시 실패';
    if (resp && resp.aborted) reason = '서버 ' + Math.round(resp.elapsedMs / 1000) + '초 timeout';
    else if (resp && !resp.ok) reason = '서버 응답 비정상(' + (resp.status || '?') + ' / ' + (resp.bytes || 0) + 'B)';
    else if (resp && resp.ok) reason = '캐시 교체 실패(t_list 매칭 안 됨)';
    showToast(reason + ' — 일반 검색으로', 'err');
    log('fallback', { reason, resp });
    _bypassNextSubmit = true;
    // hijack 적용된 f.submit 이 아니라 original 호출 (무한루프 방지)
    setTimeout(() => { try { (f._ubOriginalSubmit || HTMLFormElement.prototype.submit).call(f); } catch (_) {} }, 200);
  }

  async function refreshInBg(url, key) {
    try {
      const t0 = Date.now();
      const resp = await fetchUbdstoreDirect(url);
      const ms = Date.now() - t0;
      if (resp && resp.ok && resp.html) {
        // 캐시 hit 덕에 사용자가 절약한 시간 = 이번 백그라운드 fetch 시간.
        // lastMs 도 함께 업데이트 → 다음 hit 토스트가 최신 실측값을 반영.
        postStats({ savedMs: ms, lastMs: ms });
        sendBg({ type: 'cachePutSearch', pathKey: 'search:' + location.pathname, key, html: resp.html });
        replaceTList(resp.html);
      }
    } catch (_) {}
  }

  /* ---- form.submit() 메소드 hijack ----
   *  HTML 스펙상 form.submit() 메소드 직접 호출은 submit 이벤트를 발화시키지
   *  않음. 페이지의 "검색하기" 같은 버튼 onclick 이 document.form1.submit()
   *  을 직접 호출하면 우리 capture-phase listener 가 절대 못 잡음.
   *  → 메소드를 wrapper 로 교체해서 submit 이벤트를 dispatchEvent 로 발화.
   *     preventDefault 되면 그대로 종료(우리 흐름이 처리), 안 되면 original
   *     호출(평소 navigate).
   *
   *  fallback 분기에서는 f._ubOriginalSubmit 으로 호출해 무한루프 방지.
   */
  function hijackFormSubmitMethod(f) {
    try {
      if (f._ubOriginalSubmit) return;
      const original = HTMLFormElement.prototype.submit.bind(f);
      f._ubOriginalSubmit = original;
      f.submit = function () {
        const ev = new Event('submit', { bubbles: true, cancelable: true });
        f.dispatchEvent(ev);
        if (!ev.defaultPrevented) original();
      };
    } catch (e) {
      console.warn('[UB][cache] hijackFormSubmitMethod failed:', e);
    }
  }

  function bind() {
    const f = getSearchForm();
    if (!f) {
      // loader.js 는 document_idle 이지만 일부 페이지가 form 을 지연 렌더할 수도 있음.
      // 단발 retry 한 번만 (무한 루프 방지)
      if (!bind._retried) { bind._retried = true; setTimeout(bind, 500); }
      else { log('form[name="form1"] not found — caching disabled on this page'); }
      return;
    }
    if (f.dataset.ubCacheBound) return;
    f.dataset.ubCacheBound = '1';
    f.addEventListener('submit', (e) => handleSearchSubmit(f, e), true);
    hijackFormSubmitMethod(f);   // form.submit() 직접 호출도 가로채기
    log('bound to form1 on', location.pathname, '(' + CACHE_PAGES[location.pathname] + ')');
  }

  bind();
})();
