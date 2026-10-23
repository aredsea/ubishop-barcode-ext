/* =============================================================================
 *  storeprice-erp.js — 매장 제품 가격 변경: 유비샵 호출 어댑터 (ISOLATED, 브라우저 전용).
 *  storeprice-core.js 의 spRunOne 이 이 인터페이스만 쓴다.
 *  · 출고 조회·삭제·재출고 = fetch(credentials include). hidden 은 HTML 정규식(ubOi) — DOMParser form.elements 함정 회피.
 *  · 🔴 입고 수정 저장 = 숨은 iframe 에서 실제 폼. 선택칸 6개(origin·orderType·shop·k·stoneStyle2·color)를
 *    페이지 스크립트가 로드 후 채우므로 HTML 직렬화로 보내면 빈값으로 덮인다(2026-10-23 실측).
 *  스펙: docs/superpowers/specs/2026-10-23-store-price-change-design.md
 * ========================================================================== */
(function () {
  'use strict';
  const O = globalThis.ubOi, S = globalThis.ubSp;
  if (!O || !S) return;
  const TIMEOUT_MS = 30000;
  const LOG_KEY = 'UB_SP_LOG';
  const DELIV_LIST = '/jun/delivitem/delivItemList.do?tcode=deliv_item';
  const DELIV_LIST_RE = /\/jun\/delivitem\/delivItemList\.do$/;
  const WRITE_FORM = '/deliv/item/delivItemWriteForm.do?tcode=deliv_item';
  const WRITE_RE = /\/deliv\/item\/delivItemWriteForm\.do$/;
  const dec = (globalThis.ubErp && globalThis.ubErp.decodeErpHtml)
    ? (u8) => globalThis.ubErp.decodeErpHtml(u8)
    : (u8) => new TextDecoder('utf-8').decode(u8);

  //  세션이 끊기면 msg 없이 다른 호스트로 리다이렉트된다 → 'msg 없음 = 성공' 이 뚫리므로 여기서 던진다.
  function assertUbdstore(url, pathRe) {
    let u; try { u = new URL(url, location.origin); } catch (_) { throw new Error('session_lost: bad url'); }
    if (!/(^|\.)ubshop\.biz$/i.test(u.hostname)) throw new Error('session_lost: ' + u.hostname + u.pathname);
    if (pathRe && !pathRe.test(u.pathname)) throw new Error('unexpected_page: ' + u.pathname);
  }
  async function req(url, init, pathRe) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, Object.assign({ credentials: 'include', cache: 'no-cache', signal: ctl.signal }, init || {}));
      const u8 = new Uint8Array(await r.arrayBuffer());
      assertUbdstore(r.url, pathRe);
      return { url: r.url, html: dec(u8) };
    } finally { clearTimeout(timer); }
  }
  function post(url, pairs, pathRe) {
    const fd = new URLSearchParams();
    (Array.isArray(pairs) ? pairs : Object.entries(pairs)).forEach(([k, v]) => fd.append(k, v == null ? '' : String(v)));
    return req(url, { method: 'POST', body: fd }, pathRe);
  }
  const doc = (html) => new DOMParser().parseFromString(html, 'text/html');
  function today() {
    const d = new Date();
    return { eyear: String(d.getFullYear()), emonth: String(d.getMonth() + 1).padStart(2, '0'), eday: String(d.getDate()).padStart(2, '0') };
  }
  //  전체 기간 · seq 내림차순 → 바코드의 첫 행이 최신 출고(skin.js dcmSearchParams 와 같음).
  function delivSearch(barcode) {
    return Object.assign({ syear: '2000', smonth: '01', sday: '01' }, today(),
      { pageSize: '100', searchSortType: 'seq', searchDateType: 'delivDate', searchBarcode: barcode });
  }
  async function delivList(barcode) {
    const r = await post(DELIV_LIST, delivSearch(barcode), DELIV_LIST_RE);
    const sKey = (O.oiExtractHidden(r.html).find(([n]) => n === 'sKey') || [])[1] || '';
    return { rows: S.spDelivRows(r.html), sKey };
  }

  /* ------------------------------------------------------------ 로그 */
  //  삭제는 되돌릴 수 없으므로 **삭제 전에** 남긴다. 되돌려야 할 때의 유일한 근거다.
  function log(entry) {
    try {
      let list = [];
      const raw = localStorage.getItem(LOG_KEY);
      if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) list = p; }
      list.push(Object.assign({ ts: Date.now() }, entry));
      if (list.length > 500) list.splice(0, list.length - 500);
      localStorage.setItem(LOG_KEY, JSON.stringify(list));
      return true;
    } catch (_) { return false; }
  }

  /* ------------------------------------------------------------ 조회 */
  let shopOptsCache = null;
  async function shopOpts() {
    if (shopOptsCache) return shopOptsCache;
    const r = await req(WRITE_FORM, null, WRITE_RE);
    shopOptsCache = O.oiSelectOptions(S.spForm1Segment(r.html), 'searchShop') || [];
    return shopOptsCache;
  }
  async function lookup(barcode) {
    const [{ rows }, opts] = await Promise.all([delivList(barcode), shopOpts()]);
    return S.spClassify(barcode, rows, opts);
  }

  /* ------------------------------------------------------------ 출고 삭제 */
  //  페이지 del() 과 같다: form2(sKey + 체크된 idx) → delivItemDelete.do + 현재 검색조건.
  //  삭제 직전에 다시 조회해 그 행이 그대로 최신인지 확인하고(그새 누가 바꿨으면 멈춤), 삭제 뒤 사라졌는지 본다.
  //  반환: {ok:true} 삭제 확인 · {ok:false} 요청 전 실패(아무것도 안 바뀜) · {ok:false, uncertain:true} 요청은 나갔는데 결과 불명.
  //  🔴 요청을 보낸 뒤의 실패를 '안 바뀜'으로 돌려주면 실행기가 재출고를 건너뛰어 제품이 본사에 남는다(Terra 1R P1).
  async function deleteDeliv(target) {
    let before;
    try { before = await delivList(target.barcode); } catch (e) { return { ok: false, msg: '삭제 전 조회 실패: ' + (e && e.message || e) }; }
    const cur = before.rows.find((x) => x.barcode === target.barcode);
    if (!cur || cur.idx !== target.idx) return { ok: false, msg: '출고 내역이 조회 뒤 바뀌었습니다' };
    if (!before.sKey) return { ok: false, msg: 'sKey 없음' };
    //  본문 구성은 실사용 중인 skin.js dcmDelete 와 같다(검색조건 + sKey + idx). 리다이렉트 경로는 단정하지 않는다(호스트만).
    const pairs = Object.entries(delivSearch(target.barcode)).concat([['sKey', before.sKey], ['idx', target.idx]]);
    let res;
    try {
      const r = await post('/jun/delivitem/delivItemDelete.do?tcode=deliv_item', pairs, null);
      res = O.oiSubmitResult(new URL(r.url, location.origin).href);
    } catch (e) { return { ok: false, uncertain: true, msg: '삭제 요청 응답 없음: ' + (e && e.message || e) }; }
    if (!res.ok) return { ok: false, msg: res.msg };
    try {
      const after = await delivList(target.barcode);
      if (after.rows.some((x) => x.idx === target.idx)) return { ok: false, msg: '삭제 응답은 성공인데 출고 행이 남아 있습니다' };
    } catch (e) { return { ok: false, uncertain: true, msg: '삭제 후 확인 조회 실패: ' + (e && e.message || e) }; }
    return { ok: true };
  }

  /* ------------------------------------------------------------ 입고장 찾기 */
  //  skin.js barcodeToJunNum → junNumToSeq → dcmPickVoucherItem 과 같은 경로(실사용 중).
  function firstDataRow(d, headRe) {
    for (const t of d.querySelectorAll('table.t_list')) {
      let hi = -1, heads = null;
      for (const r of t.rows) {
        const cs = [...r.cells].map((c) => c.textContent.replace(/\s+/g, ' ').trim());
        if (cs.some((c) => headRe.test(c))) { hi = r.rowIndex; heads = cs; break; }
      }
      if (hi < 0) continue;
      for (let i = hi + 1; i < t.rows.length; i++) {
        const r = t.rows[i];
        if (/^\d+$/.test((r.cells[0] ? r.cells[0].textContent : '').replace(/\s+/g, ''))) return { heads, row: r };
      }
    }
    return null;
  }
  async function findVoucherItem(barcode) {
    const base = Object.assign({ syear: '2000', smonth: '01', sday: '01' }, today());
    const l = await post('/jun/inputitem/inputItemList.do?tcode=input_item', Object.assign({}, base, { searchBarcode: barcode, pageSize: '100' }));
    const g = firstDataRow(doc(l.html), /수량|입고장/);
    const ci = g ? g.heads.findIndex((h) => /입고장번호/.test(h)) : -1;
    const junNum = ci >= 0 && g.row.cells[ci] ? g.row.cells[ci].textContent.replace(/\s+/g, '') : '';
    if (!junNum) return { ok: false, msg: '입고장번호를 못 찾음' };
    const j = await post('/jun/inputitem/inputItemJunList.do?tcode=input_item_jun', Object.assign({}, base, { searchJunNum: junNum, searchItemType: '1', pageSize: '100' }));
    const g2 = firstDataRow(doc(j.html), /수량|입고장/);
    const vm = g2 ? g2.row.innerHTML.match(/view\(\s*'?(\d+)'?\s*\)/) : null;
    if (!vm) return { ok: false, msg: '입고장 seq 를 못 찾음 (' + junNum + ')' };
    const v = await post('/input/item/inputItemWriteForm.do?tcode=input_item', { jun: vm[1] });
    const want = String(barcode).toUpperCase();
    for (const t of doc(v.html).querySelectorAll('table.t_list')) {
      for (const r of t.rows) {
        if (r.cells.length < 15) continue;
        const tok = (r.cells[2].textContent || '').replace(/\s+/g, ' ').trim().split(' ')[0].toUpperCase();
        if (tok !== want) continue;
        const m = r.innerHTML.match(/modify\(\s*'?(\d+)'?\s*\)/);
        if (!m) return { ok: false, msg: '입고장에 수정 링크가 없음 — 출고 삭제가 반영되지 않았을 수 있음' };
        return { ok: true, modifyUrl: '/input/item/inputItemModifyForm.do?tcode=input_item&seq=' + m[1] + '&jun=' + vm[1], junNum };
      }
    }
    return { ok: false, msg: '입고장에서 바코드 품목을 못 찾음 (' + junNum + ')' };
  }

  /* ------------------------------------------------------------ 입고 수정 (iframe) */
  function openFrame() {
    const fr = document.createElement('iframe');
    fr.setAttribute('aria-hidden', 'true');
    fr.tabIndex = -1;
    fr.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;visibility:hidden';
    document.body.appendChild(fr);
    return fr;
  }
  function waitLoad(fr, ms) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { fr.removeEventListener('load', on); rej(new Error('timeout')); }, ms);
      function on() { clearTimeout(t); fr.removeEventListener('load', on); res(); }
      fr.addEventListener('load', on);
    });
  }
  async function loadFrame(fr, url) {
    const p = waitLoad(fr, TIMEOUT_MS);
    fr.src = url;
    await p;
    const w = fr.contentWindow;
    assertUbdstore(w.location.href, /\/input\/item\/inputItemModifyForm\.do$/);
    //  페이지 alert/confirm 이 숨은 창을 멈추지 않게 기록 후 통과시킨다(iframe 의 MAIN world 에 주입).
    const d = fr.contentDocument;
    const s = d.createElement('script');
    s.textContent = '(function(){var r=document.documentElement;function k(m){r.setAttribute("data-ub-sp-alert",(r.getAttribute("data-ub-sp-alert")||"")+String(m)+" | ");}'
      + 'window.alert=function(m){k(m)};window.confirm=function(m){k(m);return true};})();';
    (d.head || d.documentElement).appendChild(s);
    s.remove();
    return d;
  }
  function snapshot(form) {
    const o = {};
    [...form.elements].forEach((e) => {
      if (!e.name || e.type === 'image' || e.name === 'sKey') return;
      if ((e.type === 'checkbox' || e.type === 'radio') && !e.checked) return;
      o[e.name] = String(e.value);
    });
    return o;
  }
  const digits = (s) => String(s == null ? '' : s).replace(/[^\d]/g, '');
  const PRICE_FIELDS = ['basicSalePrice', 'salePrice'];
  const lastSnap = new Map();

  async function savePrice(modifyUrl, price) {
    const fr = openFrame();
    try {
      const d = await loadFrame(fr, modifyUrl);
      const f = d.forms['form1'];
      if (!f) return { ok: false, msg: '수정 화면 form1 없음' };
      const missing = PRICE_FIELDS.filter((n) => !f.elements[n]);
      if (missing.length) return { ok: false, msg: '입력칸 없음: ' + missing.join(',') };
      lastSnap.set(modifyUrl, snapshot(f));
      log({ phase: 'before_save', modifyUrl, before: { basicSalePrice: f.elements.basicSalePrice.value, salePrice: f.elements.salePrice.value } });
      PRICE_FIELDS.forEach((n) => { f.elements[n].value = S.spComma(price); });
      //  저장 버튼은 input[type=image] — form.elements 에서 빠지고 form 의 DOM 자손이 아닐 수 있다(masterprice 함정).
      const btn = [...d.querySelectorAll('input[name="imageField22"]')].find((b) => b.form === f);
      if (!btn) return { ok: false, msg: '저장 버튼을 찾지 못해 저장하지 않았습니다' };
      const nav = waitLoad(fr, TIMEOUT_MS);
      btn.click();
      //  검증 alert 이면 이동하지 않는다 → 기록을 짧게 감시해 바로 실패로 돌린다.
      const blocked = new Promise((res) => {
        const iv = setInterval(() => {
          let a = null; try { a = d.documentElement.getAttribute('data-ub-sp-alert'); } catch (_) { clearInterval(iv); return; }
          if (a) { clearInterval(iv); res(a); }
        }, 200);
        nav.then(() => clearInterval(iv), () => clearInterval(iv));
      });
      const first = await Promise.race([nav.then(() => null), blocked]);
      if (first) return { ok: false, msg: '수정 화면 경고: ' + first };
      const url = fr.contentWindow.location.href;
      assertUbdstore(url);
      const res = O.oiSubmitResult(url);
      return res.ok ? { ok: true } : { ok: false, msg: res.msg };
    } catch (e) {
      return { ok: false, msg: String(e && e.message || e) };
    } finally { fr.remove(); }
  }

  //  저장 뒤 다시 열어 두 칸 = 금액인지. 다른 칸이 바뀌었으면 경고로 남긴다(가격 자체는 저장됨).
  async function verifyPrice(modifyUrl, price) {
    const fr = openFrame();
    try {
      const d = await loadFrame(fr, modifyUrl);
      const f = d.forms['form1'];
      if (!f) return { ok: false, msg: '확인용 수정 화면 form1 없음' };
      const bad = PRICE_FIELDS.filter((n) => !f.elements[n] || digits(f.elements[n].value) !== String(price));
      if (bad.length) return { ok: false, msg: '저장값 불일치: ' + bad.map((n) => n + '=' + (f.elements[n] ? f.elements[n].value : '없음')).join(', ') };
      const was = lastSnap.get(modifyUrl) || {};
      const now = snapshot(f);
      const diffs = Object.keys(was).filter((n) => PRICE_FIELDS.indexOf(n) < 0 && was[n] !== now[n]).map((n) => n + ' ' + was[n] + '→' + now[n]);
      if (diffs.length) log({ phase: 'save_side_diff', modifyUrl, diffs });
      return { ok: true, warn: diffs.length ? '다른 칸도 바뀜: ' + diffs.join(', ') : '' };
    } catch (e) {
      return { ok: false, msg: String(e && e.message || e) };
    } finally { fr.remove(); }
  }

  /* ------------------------------------------------------------ 재출고 */
  //  페이지 checkBarcode → form1.submit 과 같은 본문, printFlag=0(인쇄 창 없음).
  async function redeliver(target) {
    const g = await req(WRITE_FORM, null, WRITE_RE);
    const opts = O.oiSelectOptions(S.spForm1Segment(g.html), 'searchShop') || [];
    if (!opts.some((o) => o.value === target.shop.code)) return { ok: false, msg: '출고 화면에 매장 ' + target.shop.name + ' 이 없음' };
    const { pairs, missing } = S.spRedelivPairs(g.html, target);
    if (missing.length) return { ok: false, msg: '출고 화면 필드 없음: ' + missing.join(',') };
    const r = await post('/deliv/item/delivItemWrite.do?tcode=deliv_item', pairs, null);
    return O.oiSubmitResult(new URL(r.url, location.origin).href);
  }
  async function verifyRedeliv(target) {
    const [{ rows }, opts] = await Promise.all([delivList(target.barcode), shopOpts()]);
    const r = rows.find((x) => x.barcode === target.barcode);
    if (!r) return { ok: false, msg: '재출고 내역이 보이지 않습니다' };
    if (r.idx === target.idx || r.junNum === target.junNum) return { ok: false, msg: '최신 출고가 예전 출고장 그대로입니다' };
    const shop = S.spShopCode(r.shopText, opts);
    if (!shop || shop.code !== target.shop.code) return { ok: false, msg: '다른 매장으로 출고됨: ' + r.shopText.slice(0, 20) };
    if (r.orderType !== target.orderType || r.itemType !== target.itemType) return { ok: false, msg: '구분이 달라짐: ' + r.kind };
    return { ok: true, junNum: r.junNum };
  }

  globalThis.ubSpErp = { log, lookup, deleteDeliv, findVoucherItem, savePrice, verifyPrice, redeliver, verifyRedeliv };
})();
