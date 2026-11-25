/* =============================================================================
 *  baljuremark.js — 상품주문전표 '발주비고 정산 문구 지우기' (v4.6.2).
 *  ISOLATED, top frame only(all_frames:false), document_idle. orderItemList.do 전용.
 *
 *  사장님 요청(2026-11-25): 체크한 주문들의 **발주비고**에서 '정산 N 원' 문구를 버튼 하나로 지운다.
 *   · 발주비고(remark)만. 주문비고(shopRemark)는 건드리지 않는다.
 *   · 확인 창 없이 바로 저장(사장님 선택).
 *  ★저장은 숨은 iframe 에 네이티브 수정폼(orderItemModifyForm.do)을 열어 remark 만 바꾸고 네이티브
 *   저장 버튼을 누른다 — 폼을 직렬화해 보내면 스크립트가 채우는 select 가 비어 저장될 수 있다.
 *  ★성공 판정 = 저장 뒤 수정폼을 **다시 읽어** 발주비고가 기대값과 같은가. 착지 주소만 믿지 않는다.
 *  ★한 건씩 차례로. 실패한 건은 건너뛰고 행에 사유를 적는다. 자동 되돌리기 없음.
 * ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------------
   *  1) 순수 — tests/baljuremark.test.js
   * ------------------------------------------------------------------------- */
  //  '정산 756,124 원' · '정산 1,731원' · '정산 -2,000 원'. 뒤가 숫자·원이 아니면('정산 예정') 그대로.
  //  ★줄 단위로만 본다(줄바꿈을 넘어 매치하지 않게). 문구가 **있는 줄만** 손대고 나머지 줄은 글자 그대로 —
  //   탭·연속 공백·들여쓰기를 바꾸지 않는다(Opus 4.7 T1 1R). 문구를 지워 빈 줄이 된 줄은 뺀다.
  const SETTLE_RE = /[ \t]*정산[ \t]*-?\d[\d,]*[ \t]*원[ \t]*/g;
  function brStrip(text) {
    const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const lines = s.split('\n');
    let changed = false;
    const out = [];
    for (const line of lines) {
      if (!new RegExp(SETTLE_RE.source).test(line)) { out.push(line); continue; }
      changed = true;
      const rest = line.replace(SETTLE_RE, ' ').replace(/^ +| +$/g, '');
      if (rest.trim()) out.push(rest);
    }
    if (!changed) return { text: s.trim(), changed: false };
    //  맨 앞·맨 뒤의 빈 줄만 걷는다 — 첫 줄 들여쓰기는 남긴다.
    return { text: out.join('\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, ''), changed: true };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { brStrip };
    return;
  }

  /* ---------------------------------------------------------------------------
   *  2) 화면
   * ------------------------------------------------------------------------- */
  if (window !== window.top) return;
  if (!/\/jun\/orderitem\/orderItemList\.do/i.test(location.pathname)) return;

  const BTN_ID = 'ub-br-btn';
  const ST_ID = 'ub-br-st';
  const FORM_PATH = '/jun/orderitem/orderItemModifyForm.do';
  const LOAD_MS = 20000;
  const log = (...a) => { try { console.log('[UB][baljuremark]', ...a); } catch (_) {} };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function decode(buf) {
    let h = new TextDecoder('utf-8').decode(buf);
    if ((h.match(/�/g) || []).length > 20) h = new TextDecoder('euc-kr').decode(buf);
    return h;
  }
  function formUrl(seq, jun) {
    const p = new URLSearchParams();
    p.set('tcode', 'order_item'); p.set('seq', seq); p.set('tradeJun', jun);
    return FORM_PATH + '?' + p.toString();
  }
  //  저장 뒤 확인용 — 읽기 GET 으로 발주비고를 다시 읽는다.
  async function readRemark(seq, jun) {
    const r = await fetch(formUrl(seq, jun), { credentials: 'include', cache: 'no-cache' });
    const d = new DOMParser().parseFromString(decode(await r.arrayBuffer()), 'text/html');
    const f = d.forms['form1'];
    const ta = f && f.elements && f.elements.remark;
    return ta ? String(ta.value) : null;
  }

  function openFrame() {
    const fr = document.createElement('iframe');
    fr.setAttribute('aria-hidden', 'true');
    fr.tabIndex = -1;
    //  src 보다 먼저 — skin.js(all_frames)가 이 프레임에서 수정 패널·가로채기를 돌리지 않게.
    fr.dataset.ubAutoJob = 'ubbr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    fr.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;visibility:hidden';
    document.body.appendChild(fr);
    return fr;
  }
  function waitLoad(fr, ms) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { fr.removeEventListener('load', on); rej(new Error('시간 초과')); }, ms);
      function on() { clearTimeout(t); fr.removeEventListener('load', on); res(); }
      fr.addEventListener('load', on);
    });
  }
  //  네이티브 alert/confirm 이 숨은 창을 멈추지 않게 기록 후 통과(iframe 의 MAIN world 에 주입).
  function trapDialogs(d) {
    const s = d.createElement('script');
    s.textContent = '(function(){var r=document.documentElement;function k(m){r.setAttribute("data-ub-br-alert",(r.getAttribute("data-ub-br-alert")||"")+String(m)+" | ");}'
      + 'window.alert=function(m){k(m)};window.confirm=function(m){k(m);return true};})();';
    (d.head || d.documentElement).appendChild(s);
    s.remove();
  }

  //  한 건: { ok, skip?, msg }
  async function cleanOne(seq, jun) {
    const fr = openFrame();
    try {
      const url = formUrl(seq, jun);
      const p0 = waitLoad(fr, LOAD_MS);
      fr.src = url;
      await p0;
      const w = fr.contentWindow;
      if (w.location.host !== location.host || w.location.pathname !== FORM_PATH) return { ok: false, msg: '수정 화면이 열리지 않음' };
      const d = fr.contentDocument;
      trapDialogs(d);
      const f = d.forms['form1'];
      if (!f || !f.elements.remark) return { ok: false, msg: '발주비고 칸 없음' };
      const before = String(f.elements.remark.value);
      const st = brStrip(before);
      if (!st.changed) return { ok: true, skip: true, msg: '정산 문구 없음' };
      const btn = [...d.querySelectorAll('input[name="imageField22"]')].find((b) => b.form === f);
      if (!btn) return { ok: false, msg: '저장 버튼 없음' };
      log({ phase: 'before_save', seq, before });
      f.elements.remark.value = st.text;
      const nav = waitLoad(fr, LOAD_MS);
      btn.click();
      const blocked = new Promise((res) => {
        const iv = setInterval(() => {
          let a = null;
          try { a = d.documentElement.getAttribute('data-ub-br-alert'); } catch (_) { clearInterval(iv); return; }
          if (a) { clearInterval(iv); res(a); }
        }, 200);
        nav.then(() => clearInterval(iv), () => clearInterval(iv));
      });
      const first = await Promise.race([nav.then(() => null), blocked]);
      if (first) return { ok: false, msg: '경고: ' + first };
      const after = await readRemark(seq, jun);
      if (after == null) return { ok: false, msg: '저장 뒤 확인 실패(수정 화면을 못 읽음)' };
      if (after.trim() !== st.text.trim()) return { ok: false, msg: '저장값 다름: ' + after.slice(0, 40) };
      return { ok: true, msg: '지움' };
    } catch (e) {
      return { ok: false, msg: String(e && e.message || e) };
    } finally { fr.remove(); }
  }

  function rowMark(tr, ok, msg) {
    if (!tr) return;
    let m = tr.querySelector('.ub-br-mark');
    if (!m) {
      m = document.createElement('div');
      m.className = 'ub-br-mark';
      const cell = [...tr.cells].find((c) => /발주\s*비고/.test(c.textContent)) || tr.cells[tr.cells.length - 1];
      cell.appendChild(m);
    }
    m.textContent = (ok ? '✔ 발주비고 ' : '✖ 발주비고 ') + msg;
    m.style.cssText = 'margin-top:2px;font-size:11px;font-weight:600;color:' + (ok ? '#1f7f88' : '#d93a32');
  }

  let busy = false;
  async function onClick() {
    if (busy) return;
    const st = document.getElementById(ST_ID);
    const set = (t, err) => { if (st) { st.textContent = t; st.style.color = err ? '#d93a32' : '#1f7f88'; } };
    const checked = [...document.querySelectorAll('input[name=idx]:checked')];
    if (!checked.length) { set('체크한 주문이 없습니다', true); return; }
    busy = true;
    const btn = document.getElementById(BTN_ID);
    if (btn) btn.disabled = true;
    let done = 0, skip = 0, fail = 0;
    try {
      for (let i = 0; i < checked.length; i++) {
        const tr = checked[i].closest('tr');
        const a = tr && tr.querySelector('a[href^="javascript:modify("]');
        const m = a && String(a.getAttribute('href')).match(/modify\(\s*'(\d+)'\s*,\s*'([^']*)'\s*\)/);
        set('발주비고 정리 중… ' + (i + 1) + '/' + checked.length);
        if (!m) { fail++; rowMark(tr, false, '수정 링크 없음(수정할 수 없는 상태)'); continue; }
        const r = await cleanOne(m[1], m[2]);
        if (r.ok && r.skip) skip++; else if (r.ok) done++; else fail++;
        rowMark(tr, r.ok, r.msg);
        await sleep(150);
      }
      set('발주비고 정산 문구 — 지움 ' + done + ' · 없음 ' + skip + (fail ? ' · 실패 ' + fail : ''), fail > 0);
    } finally {
      busy = false;
      if (btn) btn.disabled = false;
    }
  }

  function inject() {
    if (document.getElementById(BTN_ID)) return;
    const anchors = document.querySelectorAll('a[href*="standby"]');
    const after = document.getElementById('ub-cancel-btn') || (anchors.length ? anchors[anchors.length - 1] : null);
    if (!after || !after.parentNode) return;
    const btn = document.createElement('button');
    btn.id = BTN_ID; btn.type = 'button';
    btn.textContent = '발주비고 정산 지우기';
    btn.title = '체크한 주문의 발주비고에서 "정산 N 원" 문구를 지웁니다(주문비고는 그대로)';
    btn.style.cssText = 'margin-left:8px;height:28px;padding:0 12px;border:1px solid #4abcc7;border-radius:6px;background:#fff;color:#1f7f88;'
      + "font:600 12px Pretendard,'Malgun Gothic',sans-serif;cursor:pointer;vertical-align:middle";
    btn.addEventListener('click', onClick);
    const st = document.createElement('span');
    st.id = ST_ID;
    st.setAttribute('aria-live', 'polite');
    st.style.cssText = "margin-left:8px;font:600 12px Pretendard,'Malgun Gothic',sans-serif;vertical-align:middle";
    after.insertAdjacentElement('afterend', btn);
    btn.insertAdjacentElement('afterend', st);
  }

  //  스킨모드(ubSkin)가 꺼져 있으면 원래 화면 그대로 — 다른 스킨 기능과 같은 규칙.
  //  일괄취소 버튼(skin.js)이 늦게 붙을 수 있어 잠깐 기다렸다 그 뒤에 붙인다(없으면 본사확인 버튼 뒤).
  try {
    chrome.storage.local.get({ ubSkin: false }, async (d) => {
      if (!d || !d.ubSkin) return;
      for (let i = 0; i < 10 && !document.getElementById('ub-cancel-btn'); i++) await sleep(200);
      inject();
    });
  } catch (e) { log('시작 실패', e); }
})();
