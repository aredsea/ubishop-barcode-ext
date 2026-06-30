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
 * ========================================================================== */
(function () {
  'use strict';

  const CACHE_PAGES = {
    '/jun/delivitem/delivItemList.do':   '매장출고전표',
    '/jun/clientpay/clientPayJunList.do': '매장매출전표'
  };
  if (!CACHE_PAGES[location.pathname]) return;

  const log = (...a) => { try { console.log('[UB][cache]', ...a); } catch (_) {} };

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
  function replaceTList(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const newTables = doc.querySelectorAll('table.t_list');
      const curTables = document.querySelectorAll('table.t_list');
      if (!newTables.length || !curTables.length) {
        log('replaceTList: no t_list (new=' + newTables.length + ', cur=' + curTables.length + ')');
        return false;
      }
      const newPick = pickResultTList(newTables);
      const curPick = pickResultTList(curTables);
      if (!newPick || !curPick) return false;
      curPick.outerHTML = newPick.outerHTML;
      // tooltip2 note 동기화 (상품명 툴팁 등)
      try {
        const newNotes = doc.querySelectorAll('div.tooltip2[id^=note]');
        const oldNotes = document.querySelectorAll('div.tooltip2[id^=note]');
        oldNotes.forEach(n => n.remove());
        newNotes.forEach(n => document.body.appendChild(n.cloneNode(true)));
      } catch (_) {}
      return true;
    } catch (e) {
      console.warn('[UB][cache] replaceTList failed:', e);
      return false;
    }
  }

  /* ---- 토스트 ---- */
  function showToast(msg, kind) {
    let t = document.getElementById('ub-cache-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'ub-cache-toast';
      t.style.cssText = 'position:fixed;top:18px;right:18px;padding:10px 16px;color:#fff;border-radius:8px;font:600 12px/1.3 Pretendard,sans-serif;z-index:2147483647;pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,.25);transition:opacity .2s;max-width:280px';
      document.body.appendChild(t);
    }
    const colors = { ok: 'rgba(15,20,25,.92)', hit: 'linear-gradient(90deg,#35C5F0,#1aa0d4)', err: 'rgba(220,38,38,.92)' };
    t.style.background = colors[kind || 'ok'];
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(showToast._h);
    showToast._h = setTimeout(() => { t.style.opacity = '0'; }, 2200);
  }

  /* ---- 페이지 자체 로딩 스피너 끄기 + body display 복원 ----
   *  유비샵 페이지는 form submit 시 (a) #ajaxBox(loading.gif) 띄우고
   *  (b) <body> 자체를 display:none 처리한 다음 navigate 완료 시 둘 다 복원한다.
   *  우리가 가로채면 navigate 안 일어나서 body 가 영원히 hide → 흰 화면.
   *  → 우리 흐름에서는 ①스피너 끄고 ②body/html/주요 wrap display 강제 복원.
   */
  function hidePageLoaders() {
    try {
      // 1) 로딩 스피너 끄기
      const ajaxBox = document.getElementById('ajaxBox');
      if (ajaxBox) ajaxBox.style.display = 'none';
      document.querySelectorAll('#ajaxBox, .ajaxBox, .ajax_box, .ajax-box').forEach(el => {
        if (el && el.style) el.style.display = 'none';
      });
      // 2) body / html / 주요 컨테이너 display:none 복원 (페이지가 form submit 시 hide 함)
      if (document.body && document.body.style.display === 'none') document.body.style.display = '';
      if (document.documentElement && document.documentElement.style.display === 'none') document.documentElement.style.display = '';
      document.querySelectorAll('#wrap, #container, #content, #main, .wrap, .container, .content, .main').forEach(el => {
        if (el && el.style && el.style.display === 'none') el.style.display = '';
      });
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
    const cached = await sendBg({ type: 'cacheGetSearch', pathKey: 'search:' + location.pathname, key });
    if (cached && cached.hit && cached.entry && cached.entry.html) {
      const ok = replaceTList(cached.entry.html);
      log('hit', { ok });
      if (ok) {
        history.replaceState({}, '', url);
        hidePageLoaders();
        showToast('캐시 즉시 표시', 'hit');
        sendBg({ type: 'telemetry', payload: { type: 'cache_hit_search', path: location.pathname } });
        refreshInBg(url, key);
        return;
      }
    } else {
      log('cache miss (no entry)');
    }

    // 2) miss → 서버 fetch
    sendBg({ type: 'telemetry', payload: { type: 'cache_miss_search', path: location.pathname } });
    const t0 = Date.now();
    const resp = await sendBg({ type: 'cacheFetchSearch', url });
    const ms = Date.now() - t0;
    log('miss fetch result', { ok: resp && resp.ok, bytes: resp && resp.bytes, status: resp && resp.status, err: resp && resp.error, ms });
    if (resp && resp.ok && resp.html) {
      const ok = replaceTList(resp.html);
      log('miss replaceTList', { ok });
      if (ok) {
        history.replaceState({}, '', url);
        hidePageLoaders();
        showToast('서버 ' + (ms / 1000).toFixed(1) + '초 → 캐시 저장', 'ok');
        sendBg({ type: 'cachePutSearch', pathKey: 'search:' + location.pathname, key, html: resp.html });
        sendBg({ type: 'telemetry', payload: { type: 'cache_fill_search', path: location.pathname, ms } });
        return;
      }
    }

    // 3) 모두 실패 → 평소 form submit으로 fallback
    // (스피너는 fallback navigate가 끝낼 거라 hide 안 함 — navigate 중엔 정상이라 사용자에겐 자연스러움)
    showToast('캐시 실패 — 일반 검색으로', 'err');
    _bypassNextSubmit = true;
    setTimeout(() => { try { f.submit(); } catch (_) {} }, 200);
  }

  async function refreshInBg(url, key) {
    try {
      const resp = await sendBg({ type: 'cacheFetchSearch', url });
      if (resp && resp.ok && resp.html) {
        sendBg({ type: 'cachePutSearch', pathKey: 'search:' + location.pathname, key, html: resp.html });
        replaceTList(resp.html);
      }
    } catch (_) {}
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
    log('bound to form1 on', location.pathname, '(' + CACHE_PAGES[location.pathname] + ')');
  }

  bind();
})();
