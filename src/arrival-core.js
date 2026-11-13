/* =============================================================================
 *  arrival-core.js — 입고 지연 알림 순수 로직 (SW importScripts · node 테스트 공용).
 *  FASHION(LT) 미입고 주문(O--·OS-·B--)의 목록 HTML 을 파싱하고, 영업일 14일 초과 여부를 판정한다.
 *  ⚠ DOMParser 가 없는 서비스워커에서도 돌도록 정규식/문자열 스캔만 쓴다 — 표 스캔은 ubOi.oiTListAllRows 재사용.
 *  스펙: docs/superpowers/specs/2026-11-13-arrival-delay-design.md
 *  노출: node → module.exports, SW → globalThis.ubArrival.
 * ========================================================================== */
(function (root) {
  'use strict';
  const O = (typeof module === 'object' && module.exports) ? require('./orderimport-core.js') : root.ubOi;

  const ARRIVAL_DAYS = 14;

  //  '26-11-13' · '26-11-130000002Z02' 같은 셀에서 첫 YY-MM-DD → 'YYYY-MM-DD'(20YY). 달력에 없는 날짜는 null.
  function arParseYmd(s) {
    const m = String(s == null ? '' : s).match(/(\d{2})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const y = 2000 + Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return y + '-' + m[2] + '-' + m[3];
  }

  const nospace = (t) => String(t == null ? '' : t).replace(/\s+/g, '');

  //  결과 0건인 목록 화면 = idx 행이 없어 oiTListAllRows 가 [] 를 준다. 첫 </tr> 까지(머리글 행)에
  //  주문일·고객명·상태가 모두 있는 t_list 표가 있으면 '정상 화면의 0건' 으로 본다(로그인 화면 등은 null 유지).
  function arEmptyListPage(html) {
    const h = String(html == null ? '' : html);
    const tre = /<table\b[^>]*\bclass\s*=\s*["']?t_list["']?[^>]*>/gi; let tm;
    while ((tm = tre.exec(h))) {
      const end = h.indexOf('</tr>', tm.index);
      if (end < 0) continue;
      const tx = nospace(h.slice(tm.index, end).replace(/<[^>]*>/g, ' '));
      if (/주문일/.test(tx) && /고객명/.test(tx) && /상태/.test(tx)) {
        //  표 안에 첫 칸이 번호인 행이 있으면 데이터가 있는데 idx 를 못 읽은 것 — '0건' 이 아니다(Luna R1 P1).
        const close = h.indexOf('</table>', end); const body = h.slice(end, close < 0 ? h.length : close);
        return !/<tr\b[^>]*>\s*<td\b[^>]*>\s*\d+\s*<\/td>/i.test(body);
      }
    }
    return false;
  }

  //  목록 HTML → 행 배열. 열은 헤더 이름으로 찾는다(14열·13열 계정 모두). 헤더를 못 찾거나 필수 열이 없거나
  //  데이터 행의 주문일을 못 읽으면 null(머리글만 있는 0건 화면은 []) — 빈 목록을 '지연 없음' 으로 오인하지 않게(fail-closed).
  function arRows(html) {
    const all = O.oiTListAllRows(html);
    const hdr = all.find((r) => r.idx === null && r.cells.some((t) => /상태/.test(nospace(t))) && r.cells.some((t) => /주문일/.test(nospace(t))));
    if (!hdr) return arEmptyListPage(html) ? [] : null;
    const col = { order: -1, supplier: -1, title: -1, kind: -1, product: -1, qty: -1, status: -1 };
    hdr.cells.forEach((t, i) => {
      const tx = nospace(t);
      if (/주문일/.test(tx) && col.order < 0) col.order = i;
      else if (/^발주처/.test(tx) && col.supplier < 0) col.supplier = i;
      else if (/고객명/.test(tx) && col.title < 0) col.title = i;
      else if (tx === '구분') col.kind = i;
      else if (tx === '상품정보') col.product = i;
      else if (tx === '수량') col.qty = i;
      else if (tx === '상태') col.status = i;
    });
    if (col.order < 0 || col.title < 0 || col.status < 0) return null;
    //  첫 칸이 번호인데 idx 체크박스가 없는 행 = 데이터 행인데 못 읽는다(마크업 변경·오류 화면) → 0건으로 오인하지 않게 실패(Luna R1 P1).
    if (all.some((r) => r.idx === null && r !== hdr && /^\d+$/.test(nospace(r.cells[0] || '')))) return null;
    const out = [];
    for (const row of all) {
      if (row.idx === null) continue;
      const c = row.cells || [];
      const oc = nospace(c[col.order]);
      const orderDate = arParseYmd(oc);
      if (!orderDate) return null;
      const jm = oc.match(/(\d{7}[0-9A-Z]{3})$/);
      let supplier = '', baljuDate = null;
      if (col.supplier >= 0) {
        const sc = String(c[col.supplier] || '').trim();
        const dm = sc.match(/(\d{2}-\d{2}-\d{2})\s*$/);
        if (dm) { baljuDate = arParseYmd(dm[1]); supplier = sc.slice(0, dm.index).trim(); }
        else supplier = sc;
      }
      out.push({
        orderSeq: String(row.idx || '').split(',')[0],
        junNum: jm ? jm[1] : '',
        orderDate, supplier, baljuDate,
        title: c[col.title] || '',
        kind: col.kind >= 0 ? (c[col.kind] || '') : '',
        product: col.product >= 0 ? (c[col.product] || '') : '',
        qty: col.qty >= 0 ? (c[col.qty] || '') : '',
        status: c[col.status] || ''
      });
    }
    return out;
  }

  function ymdToUtc(ymd) {
    const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  }
  function utcToYmd(ms) {
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  }

  //  base 다음 날부터 today(포함)까지 토·일·공휴일을 뺀 날 수. today ≤ base → 0. holidaySet 은 Set('YYYY-MM-DD')(없으면 주말만).
  function arBizDaysAfter(baseYmd, todayYmd, holidaySet) {
    const b = ymdToUtc(baseYmd), t = ymdToUtc(todayYmd);
    if (!Number.isFinite(b) || !Number.isFinite(t) || t <= b) return 0;
    const hol = holidaySet || new Set();
    let n = 0;
    for (let ms = b + 86400000; ms <= t; ms += 86400000) {
      const dow = new Date(ms).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      if (hol.has(utcToYmd(ms))) continue;
      n++;
    }
    return n;
  }

  //  stage 'pre'(O--·OS- 조회분: 기준 주문일) / 'post'(B-- 조회분: 기준 발주일, 없으면 주문일 + baseFallback). elapsed > days 만 반환.
  function arJudge(rows, opts) {
    const o = opts || {};
    const stage = o.stage === 'post' ? 'post' : 'pre';
    const days = o.days == null ? ARRIVAL_DAYS : o.days;
    const out = [];
    for (const r of rows || []) {
      let baseYmd = r.orderDate, baseFallback = false;
      if (stage === 'post') {
        if (r.baljuDate) baseYmd = r.baljuDate; else baseFallback = true;
      }
      if (!baseYmd) continue;
      const elapsed = arBizDaysAfter(baseYmd, o.todayYmd, o.holidaySet);
      if (elapsed > days) out.push(Object.assign({}, r, { stage, baseYmd, baseFallback, elapsed, key: r.orderSeq + '|' + stage }));
    }
    return out;
  }

  //  경과 영업일 내림차순, 같으면 주문일 오름차순.
  function arSort(items) {
    return (items || []).slice().sort((a, b) => (b.elapsed - a.elapsed) || String(a.orderDate).localeCompare(String(b.orderDate)));
  }

  //  fresh = 이번 지연 키 중 아직 안 알린 것. nextNotified = (알림 ∩ 이번) ∪ fresh — 지연에서 빠진 키는 버려 다시 지연되면 다시 알린다.
  function arNewKeys(currentKeys, notifiedKeys) {
    const cur = Array.from(new Set(currentKeys || []));
    const seen = new Set(notifiedKeys || []);
    const fresh = cur.filter((k) => !seen.has(k));
    const kept = cur.filter((k) => seen.has(k));
    return { fresh, nextNotified: kept.concat(fresh) };
  }

  const api = { ARRIVAL_DAYS, arParseYmd, arRows, arBizDaysAfter, arJudge, arSort, arNewKeys };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ubArrival = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
