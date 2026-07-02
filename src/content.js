/* =============================================================================
 *  content.js — 얇은 호출자 (v2.1.0)
 *  유비샵 `바코드인쇄`(window.sendBarPrint) 를 가로채:
 *   1) 체크된 상품을 infoItemBarPrint.do 파싱(collector)
 *   2) 백그라운드(service worker)로 데이터 전달 → 프로그램에 POST → ZPL 인쇄
 *      (http 페이지는 PNA 정책으로 127.0.0.1 직접 fetch가 막혀서 백그라운드 경유)
 *   3) 로딩 오버레이 + 결과 안내
 * ========================================================================== */
(function () {
  'use strict';

  const log = (...a) => { if (window.UBCFG && window.UBCFG.debug) console.log('[UB][content]', ...a); };
  const original = window.sendBarPrint;

  // collector 의 LabelData → 프로그램 item (per-item 필드만; 고정문구/레이아웃은 프로그램 보유)
  function toItems(data) {
    return data.map(d => ({
      barcode: d.barcode, itemName: d.itemName, itemNo: d.itemNo,
      price: d.price, metal: d.metal, diameter: d.diameter, weight: d.weight,
      category: d.category, partner: d.partner, setNo: d.setNo,
      store: d.store, vendor: d.vendor, extraDesc: d.extraDesc
    }));
  }

  // 백그라운드(service worker)에 요청 — localbridge.js(ISOLATED)가 중계.
  // http 유비샵 페이지에서의 127.0.0.1 직접 fetch는 크롬 PNA로 차단되므로 우회.
  let _seq = 0;
  function sendToProgram(type, items) {
    return new Promise((resolve) => {
      const id = ++_seq;
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve({ ok: false, error: 'timeout(브리지 무응답 — 확장 재로드 필요?)' });
      }, 15000);
      function onMsg(e) {
        const d = e.data;
        if (!d || d.source !== 'ub-bridge' || d.id !== id || e.source !== window) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(d);
      }
      window.addEventListener('message', onMsg);
      window.postMessage({ source: 'ub-page', id, type, items }, '*');
    });
  }

  async function sendBarPrintReplacement() {
    try {
      window.UBOverlay && window.UBOverlay.show('인쇄 준비 중…');
      const data = await window.UBCollector.collect();
      if (!data || !data.length) { window.UBOverlay && window.UBOverlay.hide(); return false; } // 미선택 시 collector가 alert

      const items = toItems(data);
      log('인쇄 요청', items);
      window.UBOverlay && window.UBOverlay.show('인쇄 중…');

      const resp = await sendToProgram('print', items);
      window.UBOverlay && window.UBOverlay.hide();

      if (!resp || !resp.ok) {
        const err = (resp && resp.error) || '알 수 없는 오류';
        if (/Failed to fetch|timeout|연결|refused|fetch/i.test(err)) {
          alert('D102 인쇄 프로그램에 연결할 수 없습니다.\n\n' +
                '작업표시줄 트레이에 "D102 라벨 인쇄"가 실행 중인지 확인하세요.\n' +
                '없으면 프로그램을 실행한 뒤 다시 시도하세요.\n\n(' + err + ')');
        } else {
          alert('인쇄 실패: ' + err);
        }
      } else {
        log('인쇄 완료', resp.result);
      }
    } catch (e) {
      window.UBOverlay && window.UBOverlay.hide();
      console.error('[UB] 인쇄 처리 오류:', e);
      alert('인쇄 중 오류가 발생했습니다.\n' + (e && e.message));
    }
    return false; // javascript: href 기본 동작 방지
  }

  window.sendBarPrint = sendBarPrintReplacement;
  window.__ubOriginalSendBarPrint = original;

  console.log('%c[유비샵 바코드 라벨] 활성화됨 (v2.1.0 — 백그라운드 인쇄)', 'color:#0a7;font-weight:bold');
  console.log('[UB] 바코드인쇄 → 백그라운드 → D102 인쇄 프로그램. 위치/문구 설정은 프로그램에서.');
})();

/* =============================================================================
 *  focus-keep — 상품검색(infoItemList.do) 검색 후 커서(포커스+캐럿) 유지
 *
 *  이 페이지의 검색은 전표 페이지와 달리 전체 페이지 이동(full reload)이라,
 *  검색·엔터를 치면 새 페이지가 뜨면서 방금 입력하던 칸의 커서가 사라진다.
 *  → 검색 직전 "마지막으로 커서가 있던 텍스트 칸의 name + 캐럿 위치"를
 *    sessionStorage 에 저장하고, 새 페이지 로드 후 그 칸으로 포커스·캐럿을 복원.
 *  검색 후 폼 값이 그대로 다시 렌더되므로(유비샵 기본 동작) 캐럿 위치도 유효.
 *  loader 관리 파일이라 push 만으로 매장 PC 다음 새로고침에 자동 반영.
 * ========================================================================== */
(function () {
  'use strict';
  if (!/\/info\/item\/infoItemList\.do/.test(location.pathname)) return;

  const KEY = 'UB_FOCUS_KEEP_infoItemList';
  const isTextField = (el) => !!el && (
    (el.tagName === 'INPUT' && /^(text|search|number|tel|)$/i.test(el.type || 'text')) ||
    el.tagName === 'TEXTAREA'
  );

  // 마지막으로 커서가 있던 텍스트 칸 정보(name + 캐럿). 클릭으로 [검색] 버튼을
  // 누르면 activeElement 가 버튼이 되므로, 텍스트 칸에서 벗어나기 전에 여기 저장해 둠.
  let last = null;
  function snap(el) {
    if (!isTextField(el) || !el.name) return;
    let s = null, e = null;
    try { s = el.selectionStart; e = el.selectionEnd; } catch (_) {}
    last = { name: el.name, start: s, end: e };
  }
  document.addEventListener('focusin', (ev) => snap(ev.target), true);
  // 캐럿 이동을 실시간 반영(active 텍스트 칸 기준)
  document.addEventListener('selectionchange', () => {
    const el = document.activeElement;
    if (isTextField(el) && el.name) snap(el);
  }, true);

  function save() {
    const el = document.activeElement;
    if (isTextField(el) && el.name) snap(el);   // 엔터/submit 시 활성 칸 캐럿 최신화
    if (!last) return;
    try { sessionStorage.setItem(KEY, JSON.stringify(last)); } catch (_) {}
  }
  // 검색은 form submit, 엔터, 또는 JS 이동으로 일어날 수 있어 세 경로 모두 저장.
  window.addEventListener('submit', save, true);
  window.addEventListener('beforeunload', save, true);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); }, true);

  // ---- 복원 ----
  function scheduleRestore() {
    let raw; try { raw = sessionStorage.getItem(KEY); } catch (_) { return; }
    if (!raw) return;
    try { sessionStorage.removeItem(KEY); } catch (_) {}   // 이번 로드에서만 1회 소비
    let info; try { info = JSON.parse(raw); } catch (_) { return; }
    if (!info || !info.name) return;

    let cancelled = false;
    // 사용자가 직접 다른 곳을 클릭하면 커서 복원 중단(억지로 안 뺏음)
    document.addEventListener('mousedown', () => { cancelled = true; }, { capture: true, once: true });

    const apply = () => {
      if (cancelled) return;
      const el = document.getElementsByName(info.name)[0];
      if (!isTextField(el)) return;
      const ae = document.activeElement;
      // 사용자가 이미 다른 칸에 값 입력 중이면 건드리지 않음
      if (isTextField(ae) && ae !== el && ae.value) { cancelled = true; return; }
      try {
        el.focus({ preventScroll: true });
        const len = (el.value || '').length;
        const s = info.start == null ? len : Math.min(info.start, len);
        const e = info.end == null ? len : Math.min(info.end, len);
        if (typeof el.setSelectionRange === 'function') el.setSelectionRange(s, e);
      } catch (_) {}
    };
    // 페이지가 로드 후 자체적으로 다른 칸에 포커스를 줄 수 있어 여러 번 재확인.
    [0, 80, 200, 450, 900].forEach(t => setTimeout(apply, t));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleRestore);
  } else {
    scheduleRestore();
  }
  console.log('[UB][focus-keep] 상품검색 커서 유지 활성화');
})();
