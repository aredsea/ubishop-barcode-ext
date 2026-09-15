/* =============================================================================
 *  orderimport-erp.js — 유비샵 호출 어댑터 (ISOLATED). orderimport-core.js 의 oiRunOrder 가 이 인터페이스만 쓴다.
 *  전부 같은 도메인 fetch(credentials include). 폼 hidden 은 HTML 정규식(core)로 뽑는다 — DOMParser form.elements 함정 회피.
 *  Phase 0(2026-09-14) 에서 실제 주문 4건으로 검증한 요청 그대로. deleteLines 만 미실측(스펙 §4.2).
 *  스펙: docs/superpowers/specs/2026-09-14-orderimport-design.md §4
 * ========================================================================== */
(function () {
  'use strict';
  const C = globalThis.ubOi;
  if (!C) return;
  const TIMEOUT_MS = 30000;
  const dec = (globalThis.ubErp && globalThis.ubErp.decodeErpHtml)
    ? (u8) => globalThis.ubErp.decodeErpHtml(u8)                 // 헤더를 안 보고 score-both(collector·statis 와 같은 정책)
    : (u8) => new TextDecoder('utf-8').decode(u8);

  //  세션이 끊기면 유비샵은 msg 없이 honsu114 로그인/메인으로 리다이렉트한다 → 'msg 없음 = 성공' 판정이 뚫린다(Terra 14R P2).
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
  const WRITE_RE = /\/order\/item\/orderItemWriteForm\.do$/;
  const enc = encodeURIComponent;
  const WRITE_URL = '/order/item/orderItemWriteForm.do?tcode=order_item';
  const POPUP_BASE = { formname: 'form1', url: '/order/item/orderItemWriteForm.do', actFlag: '1', shop: 'LT', shopName: 'FASHION' };

  //  '열린 주문장' 판정은 **파라미터 없는 GET** 으로만(완료된 tradeJun 을 명시하면 그 줄이 여전히 보인다 — 실측).
  async function state() {
    const r = await req(WRITE_URL + '&pageSize=20&searchSortType=seq', null, WRITE_RE);
    const f = C.oiReadWriteForm(r.html);
    if (f.missing.includes('sKey') || f.missing.includes('tradeJun')) throw new Error('unexpected_page: 주문폼 필드 없음');
    return { tradeJun: f.values.tradeJun || '', client: f.values.client || '', rows: f.rows.length };
  }
  async function searchClient(type, word) {
    const r = await post('/etc/client.do?tcode=order_item', Object.assign({}, POPUP_BASE, { searchWordType: type, searchWord: word, pageSize: '100' }), /\/etc\/client\.do$/);
    return C.oiClientSearchRows(r.html);
  }
  async function searchMaster(word) {
    const r = await post('/etc/orderMasterItem.do?tcode=order_item', { formname: 'form1', url: '/order/item/orderItemWriteForm.do', actFlag: '1', jun: '', searchItemType: '', client: '', clientName: '', searchWord2: word, pageSize: '100', searchSortType: 'seq' }, /\/etc\/orderMasterItem\.do$/);
    return C.oiMasterSearchRows(r.html);
  }
  //  등록 응답은 그 이름으로 검색된 고객검색 페이지로 리다이렉트된다(실측) → 그 행에서 seq 를 읽는다. 없으면 재검색.
  async function registerClient(name, phone, clientJob) {
    const g = await req('/etc/clientWriteForm.do?tcode=order_item&formname=form1&url=/order/item/orderItemWriteForm.do&actFlag=1&shop=LT&shopName=FASHION');
    const hidden = C.oiExtractHidden(g.html);
    if (!hidden.some(([n]) => n === 'sKey')) return { ok: false, msg: 'clientWriteForm sKey 없음', client: null };
    const d = new Date(); const p = (x) => String(x).padStart(2, '0');
    const fixed = {
      regShop: 'LT', clientName: name, phone: phone || '', tel: '', smsType: '1', emailType: '1', grade: '05',
      jumin1: '', jumin2: '', email: '', zipcode1: '', zipcode2: '', address: '', bunji: '', remark: '',
      inDate: '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()), clientType: '1', clientManager: '',
      sexType: '2', wedType: '0', birthDate: '', birthType: '1', birthLeapType: '0', weddingDate: '', weddingType: '1', weddingLeapType: '0',
      clientJob: clientJob || '', clientArea1: '', clientArea2: '', clientVisit1: '', clientVisit2Name: '',
      clientRelation3: '1', targetName3: '', clientMemorial3: '1', memorialDate3: '', memorialType3: '1', memorialLeapType3: '0',
      clientRelation4: '1', targetName4: '', clientMemorial4: '1', memorialDate4: '', memorialType4: '1', memorialLeapType4: '0',
      clientRelation5: '1', targetName5: '', clientMemorial5: '1', memorialDate5: '', memorialType5: '1', memorialLeapType5: '0'
    };
    const r = await post('/etc/clientWrite.do?tcode=order_item', hidden.concat(Object.entries(fixed)), /\/etc\/client(?:Write)?(?:Form)?\.do$/);
    const res = C.oiSubmitResult(r.url);
    let client = C.oiClientSearchRows(r.html).find((c) => c.name === name) || null;
    if (res.ok && !client) client = (await searchClient('clientName', name)).find((c) => c.name === name) || null;
    return { ok: res.ok && !!client, msg: res.msg || (client ? '' : '등록 후 고객을 찾지 못함'), client };
  }
  async function getWriteForm(p) {
    const r = await req(WRITE_URL + '&tradeJun=' + enc(p.tradeJun || '') + '&master=' + enc(p.master || '') + '&client=' + enc(p.client || '') + '&clientName=' + enc(p.clientName || ''), null, WRITE_RE);
    return C.oiReadWriteForm(r.html);
  }
  async function postLine(fields) {
    const r = await post('/order/item/orderItemWrite.do?tcode=order_item', fields, WRITE_RE);
    const res = C.oiSubmitResult(r.url);
    return { ok: res.ok, msg: res.msg, tradeJun: C.oiFieldValue(r.html, 'tradeJun') || '', rows: C.oiWriteListRows(r.html) };
  }
  async function getForm10(p) {
    const r = await req(WRITE_URL + '&tradeJun=' + enc(p.tradeJun || '') + '&client=' + enc(p.client || '') + '&clientName=' + enc(p.clientName || ''), null, WRITE_RE);
    return C.oiReadForm10(r.html);
  }
  async function postComplete(fields) {
    const r = await post('/jun/orderitem/orderItemJunWrite.do?tcode=order_item', fields, WRITE_RE);
    return C.oiSubmitResult(r.url);
  }
  //  되돌리기: 페이지 del(form2,form3) 그대로 — form3(sKey + idx…) 를 orderItemDelete.do + CONST_URL 로 POST. ⚠ 라이브 미실측(§4.2).
  async function deleteLines(tradeJun, client, clientName, idxValues) {
    const f = await getWriteForm({ tradeJun, master: '', client, clientName });
    const sKey = f.values.sKey || '';
    if (!sKey) return { ok: false, msg: 'sKey 없음' };
    const url = '/order/item/orderItemDelete.do?tcode=order_item&reqPage=1&pageSize=20&searchSortType=seq&tradeJun=' + enc(tradeJun || '')
      + '&payJun=&shop=LT&shopName=' + enc('FASHION') + '&client=' + enc(client || '') + '&clientName=' + enc(clientName || '');
    const pairs = [['sKey', sKey]].concat(idxValues.map((v) => ['idx', v]));
    const r = await post(url, pairs, WRITE_RE);
    return C.oiSubmitResult(r.url);
  }
  //  주문전표 목록(오늘 기본 범위, 최대 100행). 열 위치는 core 가 헤더 이름으로 찾는다.
  async function listJunRows() {
    const r = await req('/jun/orderitem/orderItemList.do?tcode=order_item&pageSize=100&searchSortType=seq', null, /\/jun\/orderitem\/orderItemList\.do$/);
    return C.oiJunListRows(r.html);
  }
  async function findJunNums(orderSeqs) {
    const want = new Set(orderSeqs.map(String));
    return (await listJunRows()).filter((x) => want.has(x.orderSeq));
  }

  globalThis.ubOiErp = { state, searchClient, searchMaster, registerClient, getWriteForm, postLine, getForm10, postComplete, deleteLines, findJunNums, listJunRows };
})();
