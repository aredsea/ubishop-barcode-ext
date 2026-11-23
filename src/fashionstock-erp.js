/* =============================================================================
 *  fashionstock-erp.js — 패션 상품 재고화의 유비샵 읽기·쓰기 (v4.6.1).
 *  스펙: docs/superpowers/specs/2026-11-23-fashion-stock-design.md
 *
 *  쓰기는 saveItem · hqConfirm · assign 세 곳뿐. 나머지는 전부 읽기.
 *  ★숨은 iframe 은 dataset.ubAutoJob 을 src 보다 먼저 세운다 — skin.js(all_frames)가 그 안에서
 *   사이드바·가로채기·출고취소 대기(dcm) 이어받기를 돌리지 않게(skin.js 최상단 '자동화 프레임 가드').
 *  ★본사확인·배정은 skin.js 작업C 함수(globalThis.ubHqApi)를 그대로 쓴다. 배정은 후보 중
 *   **바코드 정확일치 행만** — 작업C 일괄의 첫 후보 고르기(cPickAssignBarcode)는 쓰지 않는다.
 * ========================================================================== */
(function () {
  'use strict';
  const C = globalThis.ubFsCore, SP = globalThis.ubSpErp, O = globalThis.ubOi;
  const LOG = (...a) => { try { console.log('[UB][fashion]', ...a); } catch (_) {} };
  const PRICE_URL = 'https://sshwwwavcbgyiyojngav.supabase.co/functions/v1/price-lookup';
  const VERIFY_MS = 12000, STEP_MS = 1500, SAVE_MS = 20000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const digits = (s) => String(s == null ? '' : s).replace(/[^\d]/g, '');
  const comma = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  function frame() {
    const fr = SP.openFrame();
    fr.dataset.ubAutoJob = 'ubfs_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    return fr;
  }
  async function postHtml(url, params) {
    const r = await fetch(url, {
      method: 'POST', credentials: 'include', cache: 'no-cache',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams(params).toString()
    });
    return globalThis.ubErp.decodeErpHtml(new Uint8Array(await r.arrayBuffer()));
  }

  /* ------------------------------------------------------------ 읽기 */
  async function readItem(barcode) {
    const v = await SP.findVoucherItem(barcode);
    if (!v.ok) return { ok: false, msg: v.msg };
    const fr = frame();
    try {
      const d = await SP.loadFrame(fr, v.modifyUrl);
      const f = d.forms['form1'];
      if (!f) return { ok: false, msg: '수정 화면 form1 없음' };
      const need = ['itemEtcRemark', 'basicSalePrice', 'salePrice', 'itemNum', 'k'];
      const miss = need.filter((n) => !f.elements[n]);
      if (miss.length) return { ok: false, msg: '입력칸 없음: ' + miss.join(',') };
      const img = [...d.querySelectorAll('img')].map((i) => i.getAttribute('src') || '').find((s) => /\/upload\//.test(s)) || '';
      return {
        ok: true, modifyUrl: v.modifyUrl, junNum: v.junNum,
        itemNum: String(f.elements.itemNum.value || '').trim(), k: String(f.elements.k.value || ''),
        desc: String(f.elements.itemEtcRemark.value || ''),
        basicSalePrice: digits(f.elements.basicSalePrice.value), salePrice: digits(f.elements.salePrice.value),
        img: img ? new URL(img, location.origin).href : ''
      };
    } catch (e) { return { ok: false, msg: String(e && e.message || e) }; }
    finally { fr.remove(); }
  }

  async function listCandidates(itemNum) {
    let html;
    try { html = await postHtml('/jun/orderitem/orderItemList.do?tcode=order_item', C.fsListParams(new Date())); }
    catch (e) { return { ok: false, msg: '주문 목록 조회 실패: ' + (e && e.message || e) }; }
    if (/name\s*=\s*["']?(passwd|password)/i.test(html)) return { ok: false, msg: '유비샵 로그인이 풀렸습니다' };
    const rows = globalThis.ubArrival.arRows(html);
    const list = C.fsCandidates(rows, itemNum);
    if (list == null) return { ok: false, msg: '주문 목록을 읽지 못했습니다' };
    const prices = C.fsOrderPrices(O.oiTListAllRows(html));
    list.forEach((c) => { c.orderPrice = prices && prices[c.orderSeq] != null ? prices[c.orderSeq] : null; });
    return { ok: true, list };
  }

  //  고객 → 판매가 출처. { ok, price, src } 또는 { ok:false, msg }(직접 입력).
  async function lookupPrice(cand, desc, k) {
    const s = C.fsPriceSource(cand.customer);
    if (!s) return { ok: false, msg: '마켓을 정할 수 없는 고객' };
    if (s.kind === 'order') {
      return cand.orderPrice > 0 ? { ok: true, price: cand.orderPrice, src: '주문전표 주문가(카페24 고객)' }
        : { ok: false, msg: '주문전표 주문가가 비어 있음' };
    }
    const names = C.fsAtelierNames(desc);
    if (!names.length) return { ok: false, msg: '아틀리에에서 찾을 이름이 없음' };
    const key = await new Promise((res) => {
      try { chrome.storage.local.get({ ubSlLedgerKey: '' }, (d) => res(String((d && d.ubSlLedgerKey) || '').trim())); }
      catch (_) { res(''); }
    });
    if (!key) return { ok: false, msg: '아틀리에 조회 열쇠가 없습니다(확장 팝업에서 등록)' };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await fetch(PRICE_URL, {
        method: 'POST', credentials: 'omit', signal: ac.signal,
        headers: { 'x-ledger-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ names, market: s.market, k }] })
      });
      if (!r.ok) return { ok: false, msg: '아틀리에 가격 조회 실패 HTTP ' + r.status };
      const row = ((await r.json()).rows || [])[0];
      if (!row) return { ok: false, msg: '아틀리에 가격 조회 응답 이상' };
      if (row.status !== 'ok') {
        return { ok: false, msg: ({ not_found: '아틀리에에 없는 제품(' + names.join(' / ') + ')', ambiguous: '아틀리에 제품 이름이 겹침',
          no_price: '아틀리에에 그 마켓 가격 없음', manual_price: '그 마켓은 직접 입력 가격이라 자동으로 넣지 않음' })[row.status] || row.status };
      }
      return { ok: true, price: row.base, src: '아틀리에 ' + s.market + ' 할인 전 판매가 (' + row.code + ')' };
    } catch (e) {
      return { ok: false, msg: '아틀리에 가격 조회 실패: ' + (e && e.name === 'AbortError' ? '시간 초과' : (e && e.message || e)) };
    } finally { clearTimeout(t); }
  }

  /* ------------------------------------------------------------ 쓰기 ① 품목 수정 */
  //  storeprice-erp savePrice 와 같은 판정(검증 alert 감시 + 리다이렉트 URL 의 msg) + 추가설명 칸.
  async function saveItem(modifyUrl, want) {
    const fr = frame();
    try {
      const d = await SP.loadFrame(fr, modifyUrl);
      const f = d.forms['form1'];
      if (!f) return { ok: false, msg: '수정 화면 form1 없음' };
      LOG({ phase: 'before_save', modifyUrl, before: { desc: f.elements.itemEtcRemark.value, basic: f.elements.basicSalePrice.value, sale: f.elements.salePrice.value } });
      f.elements.itemEtcRemark.value = want.desc;
      f.elements.basicSalePrice.value = comma(want.price);
      f.elements.salePrice.value = comma(want.price);
      //  저장 버튼은 input[type=image] — form.elements 에서 빠지고 form 의 DOM 자손이 아닐 수 있다.
      const btn = [...d.querySelectorAll('input[name="imageField22"]')].find((b) => b.form === f);
      if (!btn) return { ok: false, msg: '저장 버튼을 찾지 못해 저장하지 않았습니다' };
      const nav = SP.waitLoad(fr, SAVE_MS);
      btn.click();
      const blocked = new Promise((res) => {
        const iv = setInterval(() => {
          let a = null;
          try { a = d.documentElement.getAttribute('data-ub-sp-alert'); } catch (_) { clearInterval(iv); return; }
          if (a) { clearInterval(iv); res(a); }
        }, 200);
        nav.then(() => clearInterval(iv), () => clearInterval(iv));
      });
      const first = await Promise.race([nav.then(() => null), blocked]);
      if (first) return { ok: false, msg: '수정 화면 경고: ' + first };
      const res = O.oiSubmitResult(fr.contentWindow.location.href);
      return res.ok ? { ok: true } : { ok: false, msg: res.msg };
    } catch (e) { return { ok: false, msg: String(e && e.message || e) }; }
    finally { fr.remove(); }
  }
  async function verifyItem(modifyUrl, want) {
    const fr = frame();
    try {
      const f = (await SP.loadFrame(fr, modifyUrl)).forms['form1'];
      if (!f) return { ok: false, msg: '확인용 수정 화면 없음' };
      const bad = [];
      if (String(f.elements.itemEtcRemark.value || '').trim() !== String(want.desc).trim()) bad.push('추가설명=' + f.elements.itemEtcRemark.value);
      ['basicSalePrice', 'salePrice'].forEach((n) => { if (digits(f.elements[n].value) !== String(want.price)) bad.push(n + '=' + f.elements[n].value); });
      return bad.length ? { ok: false, msg: '저장값 불일치: ' + bad.join(', ') } : { ok: true };
    } catch (e) { return { ok: false, msg: String(e && e.message || e) }; }
    finally { fr.remove(); }
  }

  /* ------------------------------------------------------------ 쓰기 ② 본사확인 · ③ 배정 */
  async function pollRow(orderSeq, orderDate, until) {
    const H = globalThis.ubHqApi;
    const end = Date.now() + VERIFY_MS;
    let last = null;
    while (Date.now() < end) {
      last = await H.fetchOrderRow(orderSeq, orderDate);
      if (last && last.loginExpired) return { ok: false, msg: '유비샵 로그인이 풀렸습니다', row: last };
      if (last && last.found && !last.duplicate && until(last)) return { ok: true, row: last };
      await sleep(STEP_MS);
    }
    return { ok: false, row: last };
  }

  async function hqConfirm(cand) {
    const H = globalThis.ubHqApi;
    if (!H) return { ok: false, msg: 'skin.js 작업C 함수가 없습니다 — 새로고침' };
    const pre = await H.fetchOrderRow(cand.orderSeq, cand.orderDate);
    if (!pre || !pre.found) return { ok: false, msg: '주문 행을 다시 찾지 못했습니다' };
    if (pre.loginExpired) return { ok: false, msg: '유비샵 로그인이 풀렸습니다' };
    if (pre.duplicate) return { ok: false, msg: '같은 주문 행이 둘로 보여 진행하지 않습니다' };
    if (pre.code === 'OS-') return { ok: true, rowHtml: pre.rowHtml, note: '이미 본사확인' };
    if (pre.code !== 'O--') return { ok: false, msg: '주문 상태가 주문완료가 아닙니다(' + (pre.text || pre.code) + ')' };
    const sKey = await H.cFetchSKey();
    if (!sKey) return { ok: false, msg: 'sKey 를 얻지 못했습니다' };
    const sent = await H.cDoStandby(cand.orderSeq, sKey, {});
    if (!sent || !sent.ok) return { ok: false, msg: '본사확인 요청 실패: ' + ((sent && sent.msg) || '') };
    const p = await pollRow(cand.orderSeq, cand.orderDate, (r) => r.code === 'OS-');
    return p.ok ? { ok: true, rowHtml: p.row.rowHtml } : { ok: false, msg: p.msg || '본사확인이 확인되지 않았습니다(12초) — 주문전표에서 확인' };
  }

  async function assign(cand, barcode, rowHtml) {
    const H = globalThis.ubHqApi;
    const a = H.cExtractRowArgs(rowHtml);
    if (!a) return { ok: false, msg: '배정 인자를 읽지 못했습니다' };
    if (String(a.orderSeq) !== String(cand.orderSeq)) return { ok: false, msg: '배정 인자의 주문 번호가 다릅니다' };
    if (String(a.barcode || '').trim()) return { ok: false, msg: '이미 다른 바코드가 배정돼 있습니다(' + a.barcode + ')' };
    const c = await H.cFetchCandidates(a.master, a.orderSeq, a.shop, a.client, a.orderDate, {});
    if (!c || !c.ok) return { ok: false, msg: '배정 후보 조회 실패: ' + ((c && c.reason) || '') };
    const want = String(barcode).trim().toUpperCase();
    const hit = (c.candidates || []).find((x) => String(x.barcode).trim().toUpperCase() === want);
    if (!hit) return { ok: false, msg: '배정 후보에 ' + barcode + ' 가 없습니다 — 직접 배정' };
    const sent = await H.cDoAssign(hit.barcode, a.orderSeq, a.shop, a.client, a.orderDate, {});
    if (!sent || !sent.ok) return { ok: false, msg: '배정 요청 실패: ' + ((sent && sent.msg) || '') };
    const p = await pollRow(cand.orderSeq, cand.orderDate, (r) => r.code === 'I--' && String(r.assignedBarcode || '').trim().toUpperCase() === want);
    return p.ok ? { ok: true } : { ok: false, msg: p.msg || '배정이 확인되지 않았습니다(12초) — 주문전표에서 확인' };
  }

  globalThis.ubFsErp = { readItem, listCandidates, lookupPrice, saveItem, verifyItem, hqConfirm, assign };
})();
