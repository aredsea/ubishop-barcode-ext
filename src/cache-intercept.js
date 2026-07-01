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
 *
 *  v3.1.3 변경 내역:
 *  - 응답 inline script 재실행 로직 완전 폐기(이전 v3.1.1 tooltip 사이드 이슈
 *    보완용). 실측 결과: 재실행이 유비샵 selectDate.js SetCustomDate 를 다시
 *    호출해서 (a) formSnap 복원값을 2000/01/01 로 덮어쓰고 (b) 새 form 아직
 *    select option 미완성 상태에서 setLimitDate 가 undefined.value 접근 →
 *    TypeError chain. tooltip 은 별도 sync 로직(위쪽)으로 이미 커버되므로
 *    script 재실행 필요성 없음.
 *  - formSnap 복원 후 진단 로그 추가(복원된 실제 값 확인용).
 *
 *  v3.1.4 변경 내역:
 *  - 기본 OFF (사용자 명시 요청). v3.1.3 까지도 문제 재현 → 안정될 때까지 캐시
 *    자체를 opt-in 으로. sessionStorage.ub_pref_autosync === '1' 일 때만 활성.
 *    skin.js mirrorPrefs() 가 chrome.storage.ubSkin && ubAutoSync 조건 미러링.
 *    팝업에서 [유비샵 스킨모드] + [전표 자동 캐시] 둘 다 켜야 활성.
 *
 *  v3.1.5 변경 내역 (결정적 fix):
 *  - replaceTList(html) → replaceTList(html, srcForm). v3.1.1 부터 v3.1.4 까지
 *    이 함수 안에서 로컬 스코프에 없는 f 를 참조하는 코드가 있었고, try/catch
 *    가 ReferenceError 를 조용히 삼켜서 formSnap 이 항상 빈 상태였음. 결과:
 *    (a) 매출일 2000/01/01 리셋이 사용자 눈엔 계속 재현, (b) v3.1.3 script
 *    재실행 제거 후에도 formSnap 자체가 비어있어서 복원이 무의미. 이번 fix
 *    로 formSnap 이 실제로 채워지고 새 form 에 복원됨.
 *  - handleSearchSubmit 두 replaceTList 호출에 f 전달, refreshInBg 호출은
 *    현재 페이지 form1 fallback (별도 srcForm 없음).
 *  - form snap 진단 로그 추가: log('form snap', { fields, hadSrcForm }).
 *
 *  v3.1.6 변경 내역:
 *  - 화면 중앙 진행 오버레이(showProgress). 사용자 요청: "검색 버튼 눌렀을 때
 *    캐시 불러오는건지 실패한건지 시각적으로 알아야 한다". 5가지 상태:
 *    checking / fetching / hit / filled / fallback. 각각 아이콘·색·문구 다르고
 *    성공/실패는 2~4초 auto-close.
 *  - fallback 사유를 오버레이·토스트·pushHistory 셋 다에 상세 문구로: timeout
 *    /status/network/no-t_list 구분. 사용자 화면에서 즉시 원인 파악.
 *  - localStorage UB_CACHE_HISTORY_v1 (최근 20건, result/reason/시간). 다음
 *    turn 에 사이드바 뷰 추가 예정. 지금은 최소한 저장부터 확보.
 *  - hit 시나리오에서 replaceTList 실패해도 miss 흐름으로 자연스레 진입(진행
 *    오버레이 유지). 이전엔 hit 실패 시 진행표시 없이 갑자기 fallback.
 *
 *  v3.1.7 변경 내역 (날짜 리셋 + 2번째 검색 무응답 동시 fix 시도):
 *  - v3.1.6 실측 로그로 원인 확정: form restore {restored:0, missingField:15}.
 *    응답 form1 의 필드 구조가 페이지 form1 과 달라 값 복원이 전부 실패했고,
 *    그로 인해 (a) 날짜가 2000/01/01 로 남고 (b) 새 form 의 date 위젯 JS 상태가
 *    깨져서 다음 검색 클릭이 죽음(오버레이도 안 뜸 = handleSearchSubmit 미실행).
 *  - form1 DOM 노드 통째 보존(replaceChild). 그러나 실측 결과 날짜 여전히 리셋:
 *    날짜 select 가 form1 밖 형제라 wrapper innerHTML 교체 때 덮여버림.
 *
 *  v3.1.8 변경 내역 (실제 근본 해결):
 *  - wrapper.innerHTML 통째 교체 방식 자체를 폐기. 결과 그리드(table.t_list)만
 *    index 매칭으로 replaceChild. form·날짜 select·검색버튼·페이지 스크립트를
 *    아예 건드리지 않음 → (a) 날짜 리셋 원천 차단(skin.js 가 넣어둔 select 값
 *    유지), (b) document.focus 에러 + 2번째 검색 죽음 제거(페이지 DOM/스크립트
 *    무손상), (c) 합계·헤더·데이터가 모두 t_list 안이라 결과 갱신도 정상.
 *  - "총 N개" 레코드 카운트는 t_list 밖 텍스트라 별도 갱신(→ v3.1.9 에서 폐기).
 *  - tooltip 은 교체된 table 안에 함께 들어오고, body 직속 필요분만 응답에서 보강.
 *
 *  v3.1.9 변경 내역:
 *  - 총갯수·페이지네이션 미갱신 버그 fix. C# 캐시의 실제 응답 HTML 분석 결과,
 *    "총 N개"·페이지 링크·pageSize/정렬 select 가 전부 table.t_paging 안(상단은
 *    form1 내부, 하단은 form1 밖)이었음. t_list 만 갈던 v3.1.8 은 t_paging 을
 *    안 건드려서 총갯수·2페이지가 안 나왔음. → t_list + t_paging 둘 다 교체.
 *    날짜 select 는 t_paging 보다 앞의 검색 테이블이라 여전히 무손상.
 *  - fetch timeout 20초 → 300초(5분). 실제 검색이 20초를 아득히 넘는 게 정상이고
 *    그 느린 검색을 캐시로 저장하는 게 목적. 20초 폴백은 일반 검색도 똑같이 느려
 *    이득 없음 → 끝까지 기다려 저장. 진행 오버레이에 실시간 "N초 경과" 타이머.
 *
 *  v3.1.10 변경 내역 (v3.1.9 회귀 fix — 100 선택인데 20개만 조회):
 *  - v3.1.9 가 상단 t_paging 을 통째 교체하면서 그 안의 pageSize select 를
 *    응답 것으로 덮음. 응답 HTML 의 pageSize 는 selected 속성이 없어 첫 옵션(20)
 *    기본 → skin.js 가 세팅한 100 이 20 으로 리셋 → 다음 formToUrl 이 pageSize=20
 *    을 읽어 20개만 조회됨. → t_paging 교체 전 pageSize·searchSortType select
 *    노드를 확보했다가 교체 후 되돌림(skin.js 의 100·onChange 그대로 유지).
 *    캐시 키에 pageSize 가 포함되므로 옛 20개 엔트리는 키가 달라 자연 무효화.
 *
 *  v3.1.11 변경 내역 (refreshInBg 경쟁 조건 fix):
 *  - hit 후 refreshInBg 가 백그라운드로 최신본을 fetch → 완료 시 화면 갱신하는데,
 *    v3.1.9 에서 timeout 을 300초로 늘리면서 이 fetch 가 최대 5분까지 걸릴 수
 *    있게 됨. 그 사이 사용자가 다른 검색·페이지로 이동하면 옛 검색 결과로 현재
 *    화면을 덮어쓰는 문제 발생 가능. → 검색 시퀀스 토큰(_searchSeq) 도입, refresh
 *    완료 시 토큰이 그대로일 때만 DOM 갱신(캐시 저장은 항상). 정적 검증 중 발견.
 * ========================================================================== */
(function () {
  'use strict';

  const UB_CACHE_VERSION = '3.1.11';

  const CACHE_PAGES = {
    '/jun/delivitem/delivItemList.do':   '매장출고전표',
    '/jun/clientpay/clientPayJunList.do': '매장매출전표'
  };
  if (!CACHE_PAGES[location.pathname]) return;

  const log = (...a) => { try { console.log('[UB][cache]', ...a); } catch (_) {} };
  log('loaded v' + UB_CACHE_VERSION, 'on', location.pathname);
  try { if (document.body) document.body.dataset.ubCacheVer = UB_CACHE_VERSION; } catch (_) {}

  // v3.1.4: 기본 OFF. 사용자가 팝업 → 유비샵 스킨모드 ON + 전표 자동 캐시 ON 켠 뒤에만 활성.
  // skin.js 가 chrome.storage 값을 sessionStorage.ub_pref_autosync 로 미러링(document_start).
  // MAIN world 인 여기서는 chrome.storage 직접 접근 불가 → sessionStorage 로 읽음.
  // 미러값 없거나 '1' 아니면 bind 안 함(캐시 전체 무동작 → 유비샵 기본 흐름 그대로).
  function isCacheEnabled() {
    try { return sessionStorage.getItem('ub_pref_autosync') === '1'; }
    catch (_) { return false; }
  }
  if (!isCacheEnabled()) {
    log('disabled (ub_pref_autosync != "1") — 팝업에서 [유비샵 스킨모드]+[전표 자동 캐시] 켜면 활성');
    return;
  }

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
  // v3.1.9: 20초 → 300초(5분). 사용자 보고: 실제 검색이 20초를 아득히 넘는
  //   경우가 많고, 그런 느린 검색을 캐시로 저장하는 게 이 기능의 존재 이유임.
  //   20초에 폴백하면 일반 검색도 똑같이 오래 걸려 이득이 없음 → 우리 fetch 를
  //   끝까지 기다려 캐시에 저장. 300초는 무한 hang 방지용 최후 안전선.
  const FETCH_TIMEOUT_MS = 300000;
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

  // v3.1.5: srcForm 파라미터 추가. 이전 버전(v3.1.1~v3.1.4)까지 이 함수 안에서
  //          로컬 스코프에 없는 `f` 를 참조하고 있었음(handleSearchSubmit 의 인자명
  //          그대로 옮겨왔던 흔적) → 매번 ReferenceError 를 try/catch 가 삼켜서
  //          formSnap 이 항상 빈 상태 → 복원 로직이 아예 실행되지 않음 →
  //          2000/01/01 계속 표시. srcForm 이 없으면 현재 페이지 form1 fallback.
  function replaceTList(html, srcForm) {
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

      // v3.1.9: 결과 그리드(table.t_list) + 페이징바(table.t_paging) 만 외과 교체.
      //   실측(C# 캐시의 실제 응답 HTML) 구조 확정:
      //     form1 (검색바)
      //       ├─ 검색 테이블 (syear/smonth/sday… 날짜 select) ← 안 건드림
      //       └─ 상단 table.t_paging (총 N개 + pageSize/정렬 select + 상단 페이징)
      //     table.t_list (결과 그리드: 헤더+합계+데이터)       ← form1 밖
      //     하단 table.t_paging (하단 페이징)                  ← form1 밖
      //   v3.1.8 은 t_list 만 갈아서 총갯수·페이지네이션(둘 다 t_paging)이 안 바뀜.
      //   → t_list + t_paging 둘 다 교체. 날짜 select 는 t_paging 보다 앞의 검색
      //     테이블이라 안 건드림 → 날짜 유지. form1 엘리먼트 자체는 유지되므로
      //     submit 리스너·hijack 도 그대로(2번째 검색 정상).

      // v3.1.10: pageSize·searchSortType select 노드 보존.
      //   상단 t_paging 안에 pageSize select 가 들어있는데, 응답 HTML 의 pageSize
      //   에는 selected 속성이 없어(옵션 20/30/50/100 중 첫 20 기본) t_paging 을
      //   통째 교체하면 skin.js 가 세팅한 100 이 20 으로 덮임 → 다음 formToUrl 이
      //   pageSize=20 을 읽어 20개만 조회(v3.1.9 회귀). → 교체 전 이 select 노드를
      //   확보했다가 교체 후 새 노드 자리에 원래 노드로 되돌림. skin.js 의 100
      //   선택·onChange 가 그대로 유지 → 항상 100개.
      const PRESERVE_SELECTS = ['pageSize', 'searchSortType'];
      const preservedSel = {};
      PRESERVE_SELECTS.forEach(nm => {
        const el = curWrap.querySelector('select[name="' + nm + '"]');
        if (el) preservedSel[nm] = el;
      });

      function swapByClass(cls) {
        const cur = curWrap.querySelectorAll('table.' + cls);
        const neu = newWrap.querySelectorAll('table.' + cls);
        const n = Math.min(cur.length, neu.length);
        let c = 0;
        for (let i = 0; i < n; i++) {
          try {
            cur[i].parentNode.replaceChild(document.importNode(neu[i], true), cur[i]);
            c++;
          } catch (_) {}
        }
        return { swapped: c, cur: cur.length, neu: neu.length };
      }
      const rList = swapByClass('t_list');
      const rPage = swapByClass('t_paging');
      log('replaceTList: 교체', { t_list: rList, t_paging: rPage });
      if (!rList.swapped) {
        log('replaceTList: 결과표(t_list) 교체 실패 — fail 처리');
        return false;
      }

      // 보존해둔 pageSize·정렬 select 노드를 새 t_paging 안 새 노드 자리에 되돌림.
      let restoredSel = 0;
      PRESERVE_SELECTS.forEach(nm => {
        const oldEl = preservedSel[nm];
        if (!oldEl) return;
        const newEl = curWrap.querySelector('select[name="' + nm + '"]');
        if (newEl && newEl !== oldEl && newEl.parentNode) {
          try { newEl.parentNode.replaceChild(oldEl, newEl); restoredSel++; } catch (_) {}
        }
      });
      log('replaceTList: select 노드 보존', { restored: restoredSel, pageSize: preservedSel.pageSize ? preservedSel.pageSize.value : null });

      // tooltip 강제 sync — 새 결과행의 tooltip2 는 교체된 table 안에 함께 들어왔지만,
      // 페이지 toolTip2.js previewMove() 가 document.getElementById(id) 로 찾으므로
      // 혹시 table 밖(body 직속)에 있어야 하는 tooltip 은 응답에서 body 로 보강.
      let dbgBodyTC = 0, dbgRespBodyTC = 0;
      try {
        const respAll = doc.querySelectorAll('div.tooltip2');
        dbgRespBodyTC = respAll.length;
        const haveIds = new Set();
        curWrap.querySelectorAll('div.tooltip2[id]').forEach(t => haveIds.add(t.id));
        document.querySelectorAll('body > div.tooltip2[id]').forEach(t => haveIds.add(t.id));
        respAll.forEach(t => {
          if (!t.id || haveIds.has(t.id)) return;
          if (!document.body) return;
          document.body.appendChild(t.cloneNode(true));
          haveIds.add(t.id);
        });
        dbgBodyTC = document.querySelectorAll('div.tooltip2').length;
      } catch (_) {}
      log('tooltip sync', { pageBodyTotal: dbgBodyTC, respBodyTotal: dbgRespBodyTC });

      // 스크롤 복원
      try { window.scrollTo(0, oldScroll); } catch (_) {}

      // form·날짜 select·버튼 전부 그대로 → rebind/복원/스크립트 재실행 불필요.
      log('replaceTList: 결과 테이블만 교체 완료 (form·날짜 무손상)');
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

  /* ---- v3.1.6: 진행 오버레이 ----
   *  검색 클릭 순간 화면 중앙에 큰 카드 표시. 단계별 상태 시각화:
   *    checking (캐시 조회 중, 파란 스피너)
   *      → hit  (초록, 2초 auto-close, "서버 N초 절약")
   *      → miss + fetching (파란 스피너, "서버에서 가져오는 중")
   *          → filled  (초록, 2초 auto-close, "서버 N초 → 캐시 저장")
   *          → fallback (빨강, 3.5초 auto-close, 실패 원인 상세)
   *  toolTip2 clickthrough 방해 안 하도록 pointer-events:none, position:fixed.
   */
  function ensureOverlayStyle() {
    if (document.getElementById('ub-cache-overlay-style')) return;
    const s = document.createElement('style');
    s.id = 'ub-cache-overlay-style';
    s.textContent = ''
      + '@keyframes ub-po-spin { to { transform: rotate(360deg); } }'
      + '@keyframes ub-po-in { from { opacity:0; transform:translate(-50%,-50%) scale(.94); } to { opacity:1; transform:translate(-50%,-50%) scale(1); } }'
      + '#ub-cache-overlay { position:fixed; top:38%; left:50%; transform:translate(-50%,-50%);'
      + '  min-width:300px; max-width:440px; padding:22px 26px; border-radius:14px;'
      + '  background:rgba(15,20,25,.96); color:#fff; font:600 13px/1.4 Pretendard,sans-serif;'
      + '  z-index:2147483647; pointer-events:none; box-shadow:0 12px 40px rgba(0,0,0,.35);'
      + '  animation:ub-po-in .16s ease-out; display:none; text-align:center; }'
      + '#ub-cache-overlay.on { display:block; }'
      + '#ub-cache-overlay .ub-po-spin { width:36px; height:36px; margin:0 auto 12px auto;'
      + '  border:3px solid rgba(255,255,255,.15); border-top-color:#35C5F0; border-radius:50%;'
      + '  animation:ub-po-spin .9s linear infinite; }'
      + '#ub-cache-overlay .ub-po-check { width:36px; height:36px; margin:0 auto 12px auto;'
      + '  border-radius:50%; background:#22c55e; color:#fff; font:900 22px/36px Pretendard; }'
      + '#ub-cache-overlay .ub-po-x { width:36px; height:36px; margin:0 auto 12px auto;'
      + '  border-radius:50%; background:#dc2626; color:#fff; font:900 22px/36px Pretendard; }'
      + '#ub-cache-overlay .ub-po-title { font-size:15px; font-weight:800; margin-bottom:6px; }'
      + '#ub-cache-overlay .ub-po-detail { font-size:11.5px; font-weight:500; color:rgba(255,255,255,.72); line-height:1.5; }';
    (document.head || document.documentElement).appendChild(s);
  }
  function ensureOverlayDom() {
    let o = document.getElementById('ub-cache-overlay');
    if (o) return o;
    ensureOverlayStyle();
    const host = document.body || document.documentElement;
    if (!host) return null;
    o = document.createElement('div');
    o.id = 'ub-cache-overlay';
    o.innerHTML = '<div class="ub-po-icon"></div><div class="ub-po-title"></div><div class="ub-po-detail"></div>';
    host.appendChild(o);
    return o;
  }
  // state: 'checking' | 'fetching' | 'hit' | 'filled' | 'fallback'
  function showProgress(state, title, detail) {
    try {
      const o = ensureOverlayDom();
      if (!o) return;
      const icon = o.querySelector('.ub-po-icon');
      const t = o.querySelector('.ub-po-title');
      const d = o.querySelector('.ub-po-detail');
      // 아이콘 스타일
      icon.className = 'ub-po-icon ';
      if (state === 'checking' || state === 'fetching') icon.classList.add('ub-po-spin');
      else if (state === 'hit' || state === 'filled')   { icon.classList.add('ub-po-check'); icon.textContent = '✓'; }
      else if (state === 'fallback')                     { icon.classList.add('ub-po-x'); icon.textContent = '✕'; }
      // 텍스트
      t.textContent = title || '';
      d.textContent = detail || '';
      o.classList.add('on');
      clearTimeout(showProgress._h);
      // v3.1.9: fetching 은 오래 걸릴 수 있으니(최대 5분) 실시간 경과 타이머 표시.
      //   "정지한 게 아니라 서버가 느린 것"임을 사용자가 즉시 알 수 있게.
      clearInterval(showProgress._timer);
      if (state === 'fetching') {
        const base = detail || '';
        const start = Date.now();
        showProgress._timer = setInterval(() => {
          try {
            const dd = o.querySelector('.ub-po-detail');
            if (dd) dd.textContent = base + (base ? ' · ' : '') + Math.round((Date.now() - start) / 1000) + '초 경과';
          } catch (_) {}
        }, 500);
      }
      // auto-close (진행형 상태는 안 지움 — 다음 상태가 덮어씀)
      const autoMs = (state === 'hit' || state === 'filled') ? 2200
                    : (state === 'fallback') ? 4200
                    : 0;
      if (autoMs) showProgress._h = setTimeout(hideProgress, autoMs);
    } catch (_) {}
  }
  function hideProgress() {
    try {
      clearInterval(showProgress._timer);
      const o = document.getElementById('ub-cache-overlay');
      if (o) o.classList.remove('on');
    } catch (_) {}
  }

  /* ---- v3.1.6: 최근 검색 이력 (localStorage, 최근 20건) ----
   *  사용자가 F12 안 열어도 "지금 뭐가 실패했는지" 나중에 확인 가능.
   *  사이드바 뷰는 다음 turn (skin.js) 에서 추가. 우선 저장부터 확보.
   */
  const HISTORY_KEY = 'UB_CACHE_HISTORY_v1';
  function pushHistory(entry) {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const list = raw ? JSON.parse(raw) : [];
      list.unshift(Object.assign({ ts: Date.now(), path: location.pathname }, entry));
      if (list.length > 20) list.length = 20;
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
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
  // v3.1.11: 검색 시퀀스 토큰. 매 검색마다 증가. refreshInBg(백그라운드 갱신)가
  //   최대 5분 뒤 완료될 수 있는데(300초 timeout), 그 사이 사용자가 다른 검색이나
  //   페이지 이동을 했으면 옛 검색 결과로 현재 화면을 덮어쓰면 안 됨 → 완료 시점에
  //   토큰이 그대로일 때만 DOM 갱신(캐시 저장은 항상 수행).
  let _searchSeq = 0;

  async function handleSearchSubmit(f, e) {
    if (_bypassNextSubmit) { _bypassNextSubmit = false; return; }

    e.preventDefault();
    // 페이지의 다른 submit 핸들러(스피너 띄움 + body hide)가 우리 뒤에 실행되지
    // 않도록 차단. 이렇게 하면 우리 흐름 동안 body 가 hide 되는 일도 막힘.
    e.stopImmediatePropagation();

    const mySeq = ++_searchSeq;
    const url = formToUrl(f);
    const keySrc = formKeySource(f);
    const key = await sha256_16(keySrc);
    const submitTs = Date.now();
    log('submit', { path: location.pathname, url: url.slice(0, 200), key });
    showProgress('checking', '캐시 확인 중…', CACHE_PAGES[location.pathname] || location.pathname);

    // 1) 캐시 조회
    // D102LabelPrinter(C#) 는 entry 를 PascalCase 로 반환:
    //   { Path, Date, Html, FetchedAt, SizeBytes }
    // → camelCase/PascalCase 둘 다 시도 (서버 측 직렬화 변경에도 견고).
    const cached = await sendBg({ type: 'cacheGetSearch', pathKey: 'search:' + location.pathname, key });
    const cachedEntry = cached && cached.entry;
    const cachedHtml = cachedEntry && (cachedEntry.html || cachedEntry.Html);
    if (cached && cached.hit && cachedHtml) {
      const ok = replaceTList(cachedHtml, f);
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
        showProgress('hit', '캐시 즉시 표시', savedTxt ? '서버 대비' + savedTxt : '백그라운드에서 최신 갱신 중');
        showToast('캐시 즉시 표시' + savedTxt, 'hit');
        sendBg({ type: 'telemetry', payload: { type: 'cache_hit_search', path: location.pathname } });
        pushHistory({ result: 'hit', savedMs: saved || 0, htmlLen: cachedHtml.length, submitMs: Date.now() - submitTs });
        refreshInBg(url, key, mySeq);
        return;
      }
      // hit 인데 replaceTList 실패한 경우 → miss 흐름으로 이어짐. progress 그대로 유지.
      log('hit replaceTList failed → miss 흐름 진입');
    } else {
      log('cache miss', { hit: cached && cached.hit, hasEntry: !!cachedEntry, hasHtml: !!cachedHtml });
    }

    // 2) miss → 서버 fetch (v3.1.2: SW 경유 폐기, 같은 world 에서 직접 fetch)
    showProgress('fetching', '서버에서 가져오는 중…', '느린 검색도 끝까지 기다려 캐시에 저장');
    sendBg({ type: 'telemetry', payload: { type: 'cache_miss_search', path: location.pathname } });
    const t0 = Date.now();
    const resp = await fetchUbdstoreDirect(url);
    const ms = Date.now() - t0;
    log('miss fetch result', { ok: resp && resp.ok, bytes: resp && resp.bytes, status: resp && resp.status, err: resp && resp.error, ms });
    if (resp && resp.ok && resp.html) {
      const ok = replaceTList(resp.html, f);
      log('miss replaceTList', { ok });
      if (ok) {
        history.replaceState({}, '', url);
        hidePageLoaders();
        postStats({ miss: 1, fillMs: ms, lastMs: ms });
        showProgress('filled', '서버 ' + (ms / 1000).toFixed(1) + '초 → 캐시 저장', '다음 같은 조건 검색은 즉시 표시됩니다');
        showToast('서버 ' + (ms / 1000).toFixed(1) + '초 → 캐시 저장', 'ok');
        sendBg({ type: 'cachePutSearch', pathKey: 'search:' + location.pathname, key, html: resp.html });
        sendBg({ type: 'telemetry', payload: { type: 'cache_fill_search', path: location.pathname, ms } });
        pushHistory({ result: 'fill', serverMs: ms, bytes: resp.bytes, submitMs: Date.now() - submitTs });
        return;
      }
    }

    // 3) 모두 실패 → 평소 form submit으로 fallback
    // (스피너는 fallback navigate가 끝낼 거라 hide 안 함 — navigate 중엔 정상이라 사용자에겐 자연스러움)
    // 사용자에게 어느 분기인지 명확히: timeout / 서버에러 / 응답 파싱 실패
    let reason = '알 수 없는 실패';
    if (resp && resp.aborted) reason = '서버 ' + Math.round(resp.elapsedMs / 1000) + '초 timeout (5분 초과)';
    else if (resp && !resp.ok && resp.status) reason = '서버 응답 비정상 (status ' + resp.status + ', ' + (resp.bytes || 0) + 'B)';
    else if (resp && !resp.ok && resp.error) reason = '네트워크 오류: ' + String(resp.error).slice(0, 80);
    else if (resp && resp.ok) reason = '응답에 t_list 없음 (로그인 만료?)';
    showProgress('fallback', '캐시 실패 — 유비샵 기본검색으로', reason);
    showToast(reason, 'err');
    log('fallback', { reason, resp: resp ? { ok: resp.ok, status: resp.status, bytes: resp.bytes, elapsedMs: resp.elapsedMs, aborted: resp.aborted, error: resp.error } : null });
    pushHistory({ result: 'fallback', reason, respMs: (resp && resp.elapsedMs) || 0, submitMs: Date.now() - submitTs });
    _bypassNextSubmit = true;
    // hijack 적용된 f.submit 이 아니라 original 호출 (무한루프 방지)
    setTimeout(() => { try { (f._ubOriginalSubmit || HTMLFormElement.prototype.submit).call(f); } catch (_) {} }, 200);
  }

  async function refreshInBg(url, key, seq) {
    try {
      const t0 = Date.now();
      const resp = await fetchUbdstoreDirect(url);
      const ms = Date.now() - t0;
      if (resp && resp.ok && resp.html) {
        // 캐시 hit 덕에 사용자가 절약한 시간 = 이번 백그라운드 fetch 시간.
        // lastMs 도 함께 업데이트 → 다음 hit 토스트가 최신 실측값을 반영.
        postStats({ savedMs: ms, lastMs: ms });
        // 캐시 저장은 항상(이 검색의 최신본 확보).
        sendBg({ type: 'cachePutSearch', pathKey: 'search:' + location.pathname, key, html: resp.html });
        // v3.1.11: DOM 갱신은 사용자가 아직 같은 검색을 보고 있을 때만. 그 사이
        //   다른 검색/페이지로 이동했으면(_searchSeq 증가) 화면 안 덮음.
        if (typeof seq === 'number' && seq !== _searchSeq) {
          log('refreshInBg: 사용자가 다른 검색으로 이동 → 화면 갱신 skip(캐시만 저장)', { seq, cur: _searchSeq });
          return;
        }
        // refresh 시엔 별도 srcForm 없음. 현재 페이지 form1 자동 fallback 사용.
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
