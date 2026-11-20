/* =============================================================================
 *  masteredit.js — 기초상품관리 '상품 수정' 창(masterItemModifyForm.do) 전용 화면.
 *  ISOLATED, top frame only(all_frames:false), document_idle.
 *
 *  사장님 요청(2026-11-20): 이미지보기 썸네일로 여는 수정 창이 엉망이다.
 *   ① D102 도구 사이드바 없이(억제는 skin.js 의 _IS_MASTER_EDIT)
 *   ② 폼의 모든 요소가 잘리지 않고 다 보이게
 *   ③ 상품 이미지를 크게, 확대/축소 가능하게
 *   ④ 유비샵 상단 메뉴(기초상품관리 화면의 머리 부분)도 포함하되 기본은 접어 둔다
 *
 *  ★원칙: 네이티브 폼 컨트롤은 **하나도 새로 만들지 않는다.** 노드를 옮기고(이동, 복제 아님)
 *   스타일만 입힌다. 저장(수정하기)·검색·이미지등록 버튼은 전부 원래 그대로 동작한다.
 *   이 페이지는 폼 중첩이 깨진 옛 표 마크업이라 컨트롤을 재구성하면 제출 대상이 어긋난다.
 *  ★표시 이미지는 네이티브 썸네일 <img> 의 src 를 따라간다(원래·삭제·이미지등록 후 바뀌면 같이).
 * ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------------
   *  1) 순수 헬퍼 — DOM 비의존. tests/masteredit.test.js 가 이름으로 검사한다.
   * ------------------------------------------------------------------------- */
  const MIN_SCALE = 0.05;
  const MAX_SCALE = 8;
  function clampScale(s) {
    if (!isFinite(s) || s <= 0) return MIN_SCALE;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  }
  // 상자 안에 이미지를 통째로 넣는 배율과 가운데 정렬 위치. 원본보다 키우지 않는다
  //  (작은 이미지를 억지로 늘리면 흐려 보여 오히려 확인이 어렵다).
  function fitView(natW, natH, boxW, boxH, pad) {
    const p = pad == null ? 16 : pad;
    if (!(natW > 0 && natH > 0 && boxW > 0 && boxH > 0)) return { s: 1, x: 0, y: 0 };
    const s = clampScale(Math.min((boxW - p * 2) / natW, (boxH - p * 2) / natH, 1));
    return { s, x: (boxW - natW * s) / 2, y: (boxH - natH * s) / 2 };
  }
  // (cx,cy) 지점을 고정한 채 배율을 factor 배로 바꾼다 — 휠·버튼 확대가 커서/중심을 따라가게.
  function zoomAt(v, factor, cx, cy) {
    const s = clampScale(v.s * factor);
    const k = s / v.s;
    return { s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
  }
  // 소수 배율을 사람이 읽는 퍼센트로.
  function pctLabel(s) { return Math.round(s * 100) + '%'; }
  // '마스터상품코드 : D-R2-…' 에서 코드만.
  function parseMasterCode(text) {
    const m = /마스터상품코드\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9\-_.]*)/.exec(String(text || ''));
    return m ? m[1] : '';
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { clampScale, fitView, zoomAt, pctLabel, parseMasterCode, MIN_SCALE, MAX_SCALE };
    return;
  }

  /* ---------------------------------------------------------------------------
   *  2) 화면
   * ------------------------------------------------------------------------- */
  if (window !== window.top) return;
  if (!/\/master\/item\/masterItemModifyForm\.do/i.test(location.pathname)) return;
  if (document.getElementById('ubme-root')) return;

  const ERP_OPEN_KEY = 'ubme_erp_open';
  const log = (...a) => { try { console.log('[UB][masteredit]', ...a); } catch (_) {} };

  const ICON = {
    chev: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    minus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    fit: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
  };

  const CSS = `
    html, body { margin: 0 !important; background: #f4f6f8 !important; }
    #ubme-root, #ubme-root * { box-sizing: border-box; }
    #ubme-root { font-family: Pretendard, 'Malgun Gothic', sans-serif; color: #1b1b1b; }
    #ubme-bar { position: sticky; top: 0; z-index: 50; display: flex; align-items: center; gap: 12px;
      height: 48px; padding: 0 16px; background: #fff; border-bottom: 1px solid #e3e7eb; }
    #ubme-bar .t { font-size: 15px; font-weight: 700; }
    #ubme-bar .code { font-size: 13px; font-weight: 600; color: #2a8f99; background: #eaf7f8;
      padding: 4px 8px; border-radius: 6px; font-variant-numeric: tabular-nums; user-select: all; }
    #ubme-bar .sp { flex: 1; }
    .ubme-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px;
      padding: 0 12px; border: 1px solid #d5dbe0; border-radius: 6px; background: #fff; color: #1b1b1b;
      font: 600 13px Pretendard, 'Malgun Gothic', sans-serif; cursor: pointer; }
    .ubme-btn:hover { border-color: #4abcc7; color: #1f7f88; }
    .ubme-btn:focus-visible { outline: 2px solid #4abcc7; outline-offset: 2px; }
    .ubme-btn.icon { width: 32px; padding: 0; }
    .ubme-btn svg { transition: transform 160ms ease-out; }
    .ubme-btn[aria-expanded="true"] svg { transform: rotate(180deg); }
    #ubme-erp { background: #fff; border-bottom: 1px solid #e3e7eb; overflow-x: auto; }
    #ubme-erp[hidden] { display: none !important; }
    #ubme-main { display: flex; align-items: flex-start; gap: 16px; padding: 16px; }
    #ubme-form { flex: 0 0 auto; background: #fff; border: 1px solid #e3e7eb; border-radius: 8px;
      padding: 8px; overflow-x: auto; }
    #ubme-viewer { flex: 1 1 auto; min-width: 360px; position: sticky; top: 64px;
      height: calc(100vh - 80px); display: flex; flex-direction: column; background: #fff;
      border: 1px solid #e3e7eb; border-radius: 8px; overflow: hidden; }
    #ubme-viewer .tb { display: flex; align-items: center; gap: 6px; padding: 8px; border-bottom: 1px solid #eef1f3; }
    #ubme-viewer .tb .pct { min-width: 52px; text-align: center; font-size: 13px; font-weight: 600;
      font-variant-numeric: tabular-nums; color: #4b5563; }
    #ubme-viewer .tb .note { margin-left: auto; font-size: 12px; color: #6b7280; }
    #ubme-viewer .tb .badge { font-size: 12px; font-weight: 600; color: #b45309; background: #fff7ed;
      padding: 3px 8px; border-radius: 6px; }
    #ubme-stage { position: relative; flex: 1; overflow: hidden; cursor: grab; touch-action: none;
      background: #fafbfc; }
    #ubme-stage.drag { cursor: grabbing; }
    #ubme-stage img { position: absolute; left: 0; top: 0; max-width: none !important; max-height: none !important;
      transform-origin: 0 0; user-select: none; -webkit-user-drag: none; image-rendering: auto; }
    #ubme-stage .empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      font-size: 14px; color: #6b7280; }
    @media (max-width: 1399px) {
      #ubme-main { flex-direction: column; }
      #ubme-viewer { position: relative; top: 0; width: 100%; min-width: 0; height: 460px; order: -1; }
    }
    @media (prefers-reduced-motion: reduce) { .ubme-btn svg { transition: none; } }
  `;

  function findFormTable() {
    const form = document.forms && document.forms['form1'];
    const kids = Array.from(document.body.children);
    //  form1 을 품은 블록이 먼저다. 제목 이미지는 form1 을 못 찾을 때만 쓰는 대체 단서
    //   (제목만 든 머리 블록을 폼으로 오인하면 진짜 폼이 카드 밖에 남는다 — Luna 1R).
    return (form && kids.find((c) => c.contains(form))) ||
      kids.find((c) => c.querySelector('img[src*="title_master_item"]')) || null;
  }
  function findProductImg(scope) {
    return Array.from(scope.querySelectorAll('img')).find((i) => {
      const s = i.getAttribute('src') || '';
      return /\/upload\//i.test(s) || /no_?image/i.test(s);
    }) || null;
  }

  function build() {
    if (!document.body || document.getElementById('ubme-root')) return;
    const formTable = findFormTable();
    if (!formTable) { log('폼 표를 못 찾음 → 화면을 손대지 않는다'); return; }

    const st = document.createElement('style');
    st.id = 'ubme-style';
    st.textContent = CSS;
    document.head ? document.head.appendChild(st) : document.documentElement.appendChild(st);

    const code = parseMasterCode(formTable.innerText);
    if (code) document.title = '상품 수정 · ' + code;

    const root = document.createElement('div');
    root.id = 'ubme-root';
    root.innerHTML =
      '<div id="ubme-bar">' +
        '<span class="t">기초상품관리 · 상품 수정</span>' +
        (code ? '<span class="code" title="마스터상품코드">' + code.replace(/[<>&"]/g, '') + '</span>' : '') +
        '<span class="sp"></span>' +
        '<button type="button" class="ubme-btn" id="ubme-erp-toggle" aria-controls="ubme-erp" aria-expanded="false">' +
          '<span class="lbl">유비샵 메뉴 펼치기</span>' + ICON.chev + '</button>' +
      '</div>' +
      '<div id="ubme-erp" hidden></div>' +
      '<div id="ubme-main">' +
        '<div id="ubme-form"></div>' +
        '<section id="ubme-viewer" aria-label="상품 이미지">' +
          '<div class="tb">' +
            '<button type="button" class="ubme-btn icon" data-z="out" aria-label="축소">' + ICON.minus + '</button>' +
            '<span class="pct" aria-live="polite">-</span>' +
            '<button type="button" class="ubme-btn icon" data-z="in" aria-label="확대">' + ICON.plus + '</button>' +
            '<button type="button" class="ubme-btn" data-z="fit">' + ICON.fit + '맞춤</button>' +
            '<button type="button" class="ubme-btn" data-z="one">원본 크기</button>' +
            '<span class="badge" hidden>저장 전 미리보기</span>' +
            '<span class="note">휠 확대 · 끌어서 이동 · 두 번 클릭 전환</span>' +
          '</div>' +
          '<div id="ubme-stage"><img alt="상품 이미지" draggable="false"><div class="empty" hidden>이미지 없음</div></div>' +
        '</section>' +
      '</div>';

    // ★노드 이동: 폼 표 앞의 블록(유비샵 머리 메뉴)은 접이식 칸으로, 폼 표와 그 뒤는 폼 칸으로.
    //  SCRIPT/STYLE 과 크기 없는 빈 상자(#ajaxBox 등)는 제자리에 둔다.
    const kids = Array.from(document.body.children);
    const at = kids.indexOf(formTable);
    const erpBox = root.querySelector('#ubme-erp');
    const formBox = root.querySelector('#ubme-form');
    kids.forEach((c, i) => {
      const tag = c.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'NOSCRIPT') return;
      if (c.id === 'ub-sidebar' || c.id === 'ub-sb-handle' || /^ub-/.test(c.id || '')) return;
      if (i < at) { if (c.offsetHeight > 0) erpBox.appendChild(c); }
      else if (i === at) formBox.appendChild(c);
    });
    document.body.insertBefore(root, document.body.firstChild);

    // 유비샵 메뉴 접기/펴기 — 기본 접힘, 마지막 상태 기억(이 PC 브라우저 한정).
    const tg = root.querySelector('#ubme-erp-toggle');
    const setErp = (open) => {
      erpBox.hidden = !open;
      tg.setAttribute('aria-expanded', open ? 'true' : 'false');
      tg.querySelector('.lbl').textContent = open ? '유비샵 메뉴 접기' : '유비샵 메뉴 펼치기';
      try { localStorage.setItem(ERP_OPEN_KEY, open ? '1' : '0'); } catch (_) {}
    };
    let erpOpen = false;
    try { erpOpen = localStorage.getItem(ERP_OPEN_KEY) === '1'; } catch (_) {}
    setErp(erpOpen);
    tg.addEventListener('click', () => setErp(erpBox.hidden));

    setupViewer(root, formTable);
    log('상품 수정 화면 구성 완료', code);
  }

  function setupViewer(root, formTable) {
    const stage = root.querySelector('#ubme-stage');
    const img = stage.querySelector('img');
    const empty = stage.querySelector('.empty');
    const pct = root.querySelector('#ubme-viewer .pct');
    const badge = root.querySelector('#ubme-viewer .badge');
    let v = { s: 1, x: 0, y: 0 };
    let fitMode = true;
    let objUrl = null;

    const paint = () => {
      img.style.transform = 'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.s + ')';
      pct.textContent = img.naturalWidth ? pctLabel(v.s) : '-';
    };
    const box = () => ({ w: stage.clientWidth, h: stage.clientHeight });
    const fit = () => {
      const b = box();
      v = fitView(img.naturalWidth, img.naturalHeight, b.w, b.h);
      fitMode = true; paint();
    };
    const zoomCenter = (f) => { const b = box(); v = zoomAt(v, f, b.w / 2, b.h / 2); fitMode = false; paint(); };
    const oneToOne = (cx, cy) => {
      const b = box();
      v = zoomAt(v, 1 / v.s, cx == null ? b.w / 2 : cx, cy == null ? b.h / 2 : cy);
      fitMode = false; paint();
    };

    const show = (src, preview) => {
      badge.hidden = !preview;
      if (!src || /no_?image/i.test(src)) {
        img.hidden = true; empty.hidden = false; empty.textContent = '이미지 없음'; pct.textContent = '-';
        img.removeAttribute('src');
        return;
      }
      img.hidden = false; empty.hidden = true;
      if (img.src !== src) img.src = src;
      else if (img.complete && img.naturalWidth) fit();
    };
    img.addEventListener('load', fit);
    img.addEventListener('error', () => {
      img.hidden = true; empty.hidden = false; empty.textContent = '이미지를 불러오지 못했습니다';
    });

    // 네이티브 썸네일을 따라간다(원래·삭제·이미지등록으로 src 가 바뀌면 같이 바뀐다).
    const native = findProductImg(formTable);
    const syncNative = () => {
      if (objUrl) return;   // 고른 파일 미리보기 중엔 그쪽이 우선
      show(native ? native.src : '', false);
    };
    if (native) {
      //  네이티브 썸네일이 바뀌면(원래·삭제·이미지등록) 고른 파일 미리보기보다 그쪽이 최신이다.
      const onNative = () => {
        if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch (_) {} objUrl = null; }
        syncNative();
      };
      try { new MutationObserver(onNative).observe(native, { attributes: true, attributeFilter: ['src'] }); } catch (_) {}
      native.style.cursor = 'zoom-in';
      native.title = '오른쪽 크게 보기에서 확대/축소';
      native.addEventListener('click', () => { if (!objUrl) fit(); });
    }
    syncNative();

    // 상품이미지 파일을 고르면 저장 전에 크게 미리 본다.
    Array.from(formTable.querySelectorAll('input[type=file]')).forEach((fi) => {
      fi.addEventListener('change', () => {
        if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch (_) {} objUrl = null; }
        const f = fi.files && fi.files[0];
        if (f && /^image\//.test(f.type)) { objUrl = URL.createObjectURL(f); show(objUrl, true); }
        else syncNative();
      });
    });

    root.querySelector('#ubme-viewer .tb').addEventListener('click', (e) => {
      const b = e.target.closest('[data-z]');
      if (!b || !img.naturalWidth) return;
      const z = b.getAttribute('data-z');
      if (z === 'in') zoomCenter(1.25);
      else if (z === 'out') zoomCenter(0.8);
      else if (z === 'fit') fit();
      else if (z === 'one') oneToOne();
    });

    stage.addEventListener('wheel', (e) => {
      if (!img.naturalWidth || img.hidden) return;
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      v = zoomAt(v, Math.exp(-dy * 0.0015), e.clientX - r.left, e.clientY - r.top);
      fitMode = false; paint();
    }, { passive: false });

    stage.addEventListener('dblclick', (e) => {
      if (!img.naturalWidth || img.hidden) return;
      const r = stage.getBoundingClientRect();
      if (fitMode) {
        const target = Math.max(1, v.s * 2);
        v = zoomAt(v, target / v.s, e.clientX - r.left, e.clientY - r.top);
        fitMode = false; paint();
      } else fit();
    });

    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !img.naturalWidth || img.hidden) return;
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: v.x, y: v.y };
      try { stage.setPointerCapture(e.pointerId); } catch (_) {}
      stage.classList.add('drag');
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      v = { s: v.s, x: drag.x + (e.clientX - drag.sx), y: drag.y + (e.clientY - drag.sy) };
      fitMode = false; paint();
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null; stage.classList.remove('drag');
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);

    try { new ResizeObserver(() => { if (fitMode && img.naturalWidth) fit(); }).observe(stage); } catch (_) {}
  }

  // ubSkin(스킨모드 마스터)이 꺼져 있으면 원래 화면 그대로 둔다 — 다른 스킨 기능과 같은 규칙.
  const start = () => {
    try {
      chrome.storage.local.get({ ubSkin: false }, (d) => {
        if (!d || !d.ubSkin) return;
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build, { once: true });
        else build();
      });
    } catch (e) { log('시작 실패', e); }
  };
  start();
})();
