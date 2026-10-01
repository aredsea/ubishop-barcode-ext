/* =============================================================================
 *  saleimport-erp.js — 유비샵 판매 호출 어댑터 (ISOLATED). saleimport-core.js 의 slRunClient 가 이 인터페이스만 쓴다.
 *  전부 같은 도메인 fetch(credentials include). 폼 hidden 은 HTML 정규식(core)로 뽑는다 — DOMParser form.elements 함정 회피.
 *  Phase 0(2026-09-30) 에서 실제 판매 1건으로 실측한 요청 그대로. deleteLines 만 미실측(스펙 §4.1-D).
 *  req/post/assertUbdstore 는 orderimport-erp.js 와 같은 방식(30초 타임아웃, 세션 만료 리다이렉트 검출).
 *  스펙: docs/superpowers/specs/2026-09-30-saleimport-design.md §4
 * ========================================================================== */
(function () {
  'use strict';
  const S = globalThis.ubSl;
  const O = globalThis.ubOi;
  if (!S || !O) return;
  const TIMEOUT_MS = 30000;
  const dec = (globalThis.ubErp && globalThis.ubErp.decodeErpHtml)
    ? (u8) => globalThis.ubErp.decodeErpHtml(u8)                 // 헤더를 안 보고 score-both(collector·statis 와 같은 정책)
    : (u8) => new TextDecoder('utf-8').decode(u8);

  //  세션이 끊기면 유비샵은 msg 없이 로그인/메인으로 리다이렉트한다 → 'msg 없음 = 성공' 판정이 뚫린다.
  //  응답이 ubdstore 의 기대 경로가 아니면 여기서 던져 실행기가 fatal(…_unverified) 로 멈추게 한다.
  function assertUbdstore(r, pathRe) {
    let u; try { u = new URL(r.url); } catch (_) { throw new Error('session_lost: bad url'); }
    if (!/(^|\.)ubshop\.biz$/i.test(u.hostname)) throw new Error('session_lost: redirected to ' + u.hostname + u.pathname);
    if (pathRe && !pathRe.test(u.pathname)) throw new Error('unexpected_page: ' + u.pathname);
    return r;
  }
  async function req(url, init, pathRe) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, Object.assign({ credentials: 'include', signal: ctl.signal }, init || {}));
      const u8 = new Uint8Array(await r.arrayBuffer());
      return assertUbdstore({ url: r.url, status: r.status, html: dec(u8) }, pathRe);
    } finally { clearTimeout(timer); }
  }
  const post = (url, pairs, pathRe) => {
    const fd = new URLSearchParams();
    (Array.isArray(pairs) ? pairs : Object.entries(pairs)).forEach(([k, v]) => fd.append(k, v == null ? '' : String(v)));
    return req(url, { method: 'POST', body: fd }, pathRe);
  };
  const enc = encodeURIComponent;
  const WRITE_RE = /\/sale\/item\/saleItemWriteForm\.do$/;
  const CASH_RE = /^\/pay\/client\/clientCashPay\w*\.do$/;
  const WRITE_URL = '/sale/item/saleItemWriteForm.do?tcode=sale_item';
  const LIST = '&pageSize=20&searchSortType=seq';
  const CTX_TAIL = (c) => '&tradeJun=' + enc(c.tradeJun || '') + '&payJun=' + enc(c.payJun || '') + '&shop=LT&client=' + enc(c.client || '')
    + '&shopName=FASHION&clientName=' + enc(c.clientName || '');
  const POPUP_BASE = { formname: 'form1', url: '/sale/item/saleItemWriteForm.do', actFlag: '1', jun: '', shop: 'LT', shopName: 'FASHION' };

  //  '열린 판매전표' 판정은 **파라미터 없는 GET** 으로만(tradeJun 을 명시하면 완료된 전표의 줄도 계속 보인다 — 주문 가져오기 실측).
  async function state() {
    const r = await req(WRITE_URL + LIST, null, WRITE_RE);
    const f = S.slReadSaleForm(r.html);
    if (f.missing.includes('sKey') || f.missing.includes('tradeJun') || f.missing.includes('payJun')) throw new Error('unexpected_page: 판매폼 필드 없음');
    return { tradeJun: f.values.tradeJun || '', payJun: f.values.payJun || '', rows: f.rows.length, form: f };
  }
  //  §4.1-0 고객 지정 GET — 고객 팝업 setSeting 이 하는 일 그대로(쓰기 없음).
  async function openClient(client, clientName) {
    const r = await req(WRITE_URL + '&client=' + enc(client) + '&clientName=' + enc(clientName) + '&shop=LT&shopName=FASHION', null, WRITE_RE);
    return S.slReadSaleForm(r.html);
  }
  async function getSaleForm(ctx) {
    const r = await req(WRITE_URL + CTX_TAIL(ctx) + LIST, null, WRITE_RE);
    return S.slReadSaleForm(r.html);
  }
  //  §4.1-1 줄 등록 — form1 10필드(barcode 만 채운다). sKey 는 직전 GET(form)의 것.
  async function postLine(form, barcode) {
    const v = form.values || {};
    const fields = [['sKey', v.sKey], ['pageSize', '20'], ['searchSortType', 'seq'], ['tradeJun', v.tradeJun], ['payJun', v.payJun], ['shop', 'LT'],
      ['client', v.client], ['shopName', 'FASHION'], ['clientName', v.clientName], ['barcode', barcode]];
    const r = await post('/sale/item/saleItemWrite.do?tcode=sale_item', fields, WRITE_RE);
    const res = O.oiSubmitResult(r.url);
    return { ok: res.ok, msg: res.msg, form: S.slReadSaleForm(r.html) };
  }
  //  §4.1-2 실판매가
  async function getModify(saleSeq, ctx) {
    const r = await req('/sale/item/saleItemModifyForm.do?tcode=sale_item&seq=' + enc(saleSeq) + '&reqPage=1' + LIST + CTX_TAIL(ctx), null, /\/sale\/item\/saleItemModifyForm\.do$/);
    return r.html;
  }
  async function postModify(fields) {
    const r = await post('/sale/item/saleItemModify.do?tcode=sale_item', fields, WRITE_RE);
    const res = O.oiSubmitResult(r.url);
    return { ok: res.ok, msg: res.msg, form: S.slReadSaleForm(r.html) };
  }
  //  §4.1-3 현금결제 — payJun(새 결제전표)은 응답 URL·hidden, payCash 는 html.
  async function getCash(ctx) {
    const r = await req('/pay/client/clientCashPayWriteForm.do?tcode=sale_item&url=/sale/item/saleItemWriteForm.do&tradeType=3&reqPage=1' + LIST + CTX_TAIL(ctx), null, CASH_RE);
    return r.html;
  }
  async function postCash(fields) {
    const r = await post('/pay/client/clientCashPayWrite.do', fields, CASH_RE);
    const res = O.oiSubmitResult(r.url);
    let payJun = '';
    try { payJun = new URL(r.url).searchParams.get('payJun') || ''; } catch (_) {}
    if (!payJun) payJun = O.oiFieldValue(r.html, 'payJun') || '';
    return { ok: res.ok, msg: res.msg, payJun, payCash: O.oiFieldValue(r.html, 'payCash') || '' };
  }
  //  §4.1-4 판매하기 — form10 25필드 그대로.
  async function postJun(fields) {
    const r = await post('/jun/saleitem/saleItemJunWrite.do?tcode=sale_item', fields, WRITE_RE);
    return O.oiSubmitResult(r.url);
  }
  //  §4.1-D 되돌리기: 페이지 del(form2,form3) 그대로 — form3(sKey + idx…) 를 saleItemDelete.do + CONST_URL 로 POST. ⚠ 라이브 미실측.
  async function deleteLines(ctx, idxValues) {
    const f = await getSaleForm(ctx);
    const sKey = f.values.sKey || '';
    if (!sKey) return { ok: false, msg: 'sKey 없음', before: f.rows || [] };
    const url = '/sale/item/saleItemDelete.do?tcode=sale_item&reqPage=1' + LIST + CTX_TAIL({ tradeJun: ctx.tradeJun, payJun: ctx.payJun, client: ctx.client, clientName: ctx.clientName });
    const pairs = [['sKey', sKey]].concat(idxValues.map((v) => ['idx', v]));
    const r = await post(url, pairs, WRITE_RE);
    return Object.assign(O.oiSubmitResult(r.url), { before: f.rows || [] });   // 삭제 직전 행 목록 — core 가 남의 줄 소실(초과 삭제)을 검사한다
  }
  //  고객의 주문내역·판매내역(읽기)
  async function trade(client, clientName) {
    const get = (vcode) => req(S.slTradeUrl(vcode, client, clientName), null, /\/info\/clienttrade\/infoClientTradeView\.do$/);
    const o = await get('orderitem');
    const s = await get('saleitem');
    return { orders: S.slOrderRows(o.html), sales: S.slSaleRows(s.html) };
  }
  async function searchClient(word) {
    const r = await post('/etc/client.do?tcode=sale_item', Object.assign({}, POPUP_BASE, { searchWordType: 'clientName', searchWord: word, pageSize: '100' }), /\/etc\/client\.do$/);
    return S.slSearchResult(r.html);   // pageSize 100 — 100건 이상이거나 첫 행 No 가 받은 행 수보다 크면 잘렸을 수 있다(§10.7)
  }

  //  §10.8 아틀리에 원장 조회(읽기 전용). 열쇠는 헤더로만 보낸다 — URL·본문·오류 메시지·로그에 넣지 않는다.
  //  fail-closed: 한 덩어리라도 non-2xx·타임아웃·형식 오류면 던진다(일부만 돌려주지 않는다).
  const LEDGER_URL = 'https://sshwwwavcbgyiyojngav.supabase.co/functions/v1/ledger-lookup';
  const LEDGER_NO_RE = /^[A-Za-z0-9-]{4,40}$/;
  const LEDGER_CHUNK = 200;
  //  본문 하나를 POST 해 rows 를 돌려준다(두 조회 방식 공통). 타임아웃은 응답 본문을 다 읽을 때까지 유지한다(본문 읽기 중 멈춤도 끊기게).
  async function ledgerPost(body, k) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let r, j;
    try {
      try {
        r = await fetch(LEDGER_URL, { method: 'POST', credentials: 'omit', signal: ctl.signal,
          headers: { 'x-ledger-key': k, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      } catch (e) { throw new Error(ctl.signal.aborted ? 'ledger_lookup_timeout' : 'ledger_lookup_network'); }
      if (!r || !r.ok) throw new Error('ledger_lookup_http_' + (r ? r.status : 0));
      try { j = await r.json(); } catch (_) { throw new Error(ctl.signal.aborted ? 'ledger_lookup_timeout' : 'ledger_lookup_bad_json'); }
    } finally { clearTimeout(timer); }
    if (!j || !Array.isArray(j.rows)) throw new Error('ledger_lookup_bad_shape');
    return j.rows;
  }
  async function ledgerLookup(orderNos, key) {
    const k = String(key == null ? '' : key).trim();
    if (!k) throw new Error('ledger_key_missing');
    const nos = [...new Set((Array.isArray(orderNos) ? orderNos : []).map((n) => String(n == null ? '' : n).trim()).filter((n) => LEDGER_NO_RE.test(n)))];
    const out = [];
    for (let i = 0; i < nos.length; i += LEDGER_CHUNK) (await ledgerPost({ orderNos: nos.slice(i, i + LEDGER_CHUNK) }, k)).forEach((x) => out.push(x));
    return out;
  }
  //  §10.9 시각 조회 — 파일에 원장 주문번호가 없는 마켓(에이블리). times = 결제 시각 epoch ms(정수만, 중복 제거, 한 번에 ≤100 — 넘으면 나눠 보낸다). fail-closed.
  const LEDGER_TIME_CHUNK = 100;
  async function ledgerLookupByTime(market, times, key) {
    const k = String(key == null ? '' : key).trim();
    if (!k) throw new Error('ledger_key_missing');
    const m = String(market == null ? '' : market).trim();
    if (!m) throw new Error('ledger_market_missing');
    const ts = [...new Set((Array.isArray(times) ? times : []).filter((t) => typeof t === 'number' && Number.isSafeInteger(t) && t > 0))];
    const out = [];
    for (let i = 0; i < ts.length; i += LEDGER_TIME_CHUNK) (await ledgerPost({ market: m, times: ts.slice(i, i + LEDGER_TIME_CHUNK) }, k)).forEach((x) => out.push(x));
    return out;
  }

  globalThis.ubSlErp = { ledgerLookup, ledgerLookupByTime, state, openClient, getSaleForm, postLine, getModify, postModify, getCash, postCash, postJun, deleteLines, trade, searchClient };
})();
