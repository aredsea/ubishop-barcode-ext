/* =============================================================================
 *  masterprice.js — 기초상품관리(품위정보보기) 적용시세 일괄변경
 *  loader 동적로드(MAIN world). tcode=master_item_k 목록에서만 UI 를 붙인다.
 *
 *  스펙: docs/superpowers/specs/2026-08-04-barcode-uncheck-and-goldprice-bulk-design.md §2
 *
 *  요구: 목록에서 체크한 상품 전부의 적용시세(goldPrice)를 하나의 값으로 통일한다.
 *  대상은 체크한 상품만(검색결과 전체 일괄 금지), 값은 하나로 통일(증감 모드 금지).
 *
 *  ★핵심 설계 — 계산식을 이식하지 않는다.
 *   적용시세를 바꾸면 페이지 자신의 calItemPrice(form) 가 입고공급가·판매가를 재계산한다.
 *   그 계산은 중량단위·품위별 비율표·순금 플래그·단가구분·판매가고정 분기를 쓰는데 전수
 *   검증하지 못했다. 그래서 상품 1건당 숨은 iframe 에 실제 수정폼(masterItemModifyForm.do)
 *   을 로드해 페이지 자신의 코드로 계산·검증·제출한다:
 *     iframe 로드 → alert/confirm 가로채기 → goldPrice 값 세팅 → calItemPrice(form1) 직접
 *     호출(재계산) → 재계산 불변식 검사(F2) → 저장버튼(imageField22, type=image) click() →
 *     응답 판정(F3·F5) → 저장 성공 판정 뒤에도 서버 재조회로 5값 대조(G2).
 *
 *  🔴 changeGoldPrice(obj,form) 를 부르지 않는다 — 첫 줄이 event.keyCode 를 읽어 프로그램
 *     호출 시 TypeError. calItemPrice(form) 을 직접 부른다.
 *  🔴 form.submit() 을 직접 부르지 않는다 — 저장버튼이 type=image 라 네이티브 클릭이어야
 *     imageField22.x/.y 가 실리고 onsubmit=checkForm 도 발화한다. 버튼을 click() 한다.
 *  🔴 alert 봉쇄는 필수 — checkForm 실패 경로가 alert() 를 띄우면 iframe 안에서 브라우저가
 *     멈춘다. 문서가 바뀔 때마다(iframe 의 매 load) 다시 걸어야 한다 — 전역 객체가 문서
 *     교체 시 통째로 갈려 한 번만 걸면 저장 응답 페이지에서는 무방비 상태가 된다(N2).
 *     ⚠ 재설치도 "load 이벤트 이후"에나 걸리므로, 응답 문서가 파싱 중 동기적으로 아주
 *     이르게 alert 를 띄우는 극단적인 경우까지는 못 막는다 — document_start 주입 없이
 *     순수 JS 로 iframe 을 제어하는 한 남는 구조적 한계다(manifest 결정은 메인 세션 §3.2).
 *
 *  ★hidden iframe 은 skin.js 의 '자동화 프레임 가드'(skin.js 26~74행)에 올라탄다.
 *   iframe.dataset.ubAutoJob 을 src 보다 먼저 세우면 skin.js(ISOLATED, all_frames)가 그
 *   프레임 안에서 사이드바·클릭가로채기·storage 방송을 전부 끄고 최소 러너만 돈다.
 *   여기서 쓰는 jobId 를 skin.js/background.js 의 자동화 job 레지스트리에 등록하지 않아도
 *   안전하다 — background.js 의 ubAutoOnFrameReady 는 모르는 jobId 를 조용히 무시하고,
 *   skin.js 의 ubAutoReport 는 그 응답을 아예 읽지 않는(fire-and-forget) 구조다.
 *
 *  ★성공/실패 판정과 응답 인코딩 디코드는 src/erp.js(SSOT, globalThis.ubErp)를 LOADER
 *   로드 순서상 우선 재사용하고, 없으면 이 파일 안의 로컬 폴백으로 떨어진다(erp.js 는
 *   수정하지 않는다). erp.js 의 submitResult 는 fetch 의 resp.url 전제(항상 유효)라
 *   location.href 기반인 이 파일의 착지-URL 판정에는 그대로 못 쓴다(F3) — judgeLandingUrl
 *   이 그 앞단에서 빈 URL·파싱 불가·예상 밖 경로를 먼저 fail-closed 로 걸러낸다.
 *
 *  ★1건 시범 후 정지의 서버 재조회는 masterItemModifyForm.do 를 seq 로 다시 GET 한다
 *   (목록 재검색이 아니다). 그 응답 HTML 에서 값을 읽을 때 DOMParser 를 쓰지 않는다 —
 *   이 ERP 는 폼 중첩이 깨진 옛 HTML 이라 DOMParser/form.elements 가 hidden 필드를 놓친
 *   전례가 있다. 대신 HTML 문자열에서 정규식으로 <input name="X" ... value="Y"> 를
 *   뽑는다(extractInputValue). iframe 안의 값 읽기/쓰기는 실제 브라우저가 렌더링한 라이브
 *   DOM 이라 DOMParser 문제가 없으므로 form.elements 를 그대로 쓴다.
 *   🔴 G2 — 저장 성공(착지 URL) 판정만으로는 서버가 시세는 저장하고 입고공급가·판매가를
 *   누락·오계산한 경우나 judgeLandingUrl 의 느슨한 판정이 실패 문서를 성공으로 오인하는
 *   경우를 못 잡는다. 그래서 매 상품 저장 뒤 서버 재조회로 5값(goldPrice·입고공급가1/2·
 *   판매가1/2) 을 재계산 결과와 대조한다(verifyAgainstServer). 트라이얼 게이트
 *   (decideTrialContinuation)도 같은 함수로 통일했다.
 *
 *  안전장치(전부 필수):
 *   1) 1건 시범 후 정지 — 첫 상품만 저장하고 서버 재조회 결과를 자동 비교(F6/G2)한 뒤,
 *      통과해야만 사용자가 [확인]을 눌러야 나머지를 진행한다.
 *   2) 순차 처리 — 동시에 두 상품을 처리하지 않는다(iframe 하나 재사용, sKey 충돌 방지).
 *   3) 실패 시 즉시 전체 중단 — runSequential 이 첫 실패에서 멈추고 이후 상품은 건드리지
 *      않는다.
 *   4) 처리 로그 — 상품코드·seq·전/후 값을 저장 클릭 '전에' write-ahead 로 먼저 남기고
 *      (F1), 클릭 직전에 실제 폼 스냅샷(before)을 얹는다(G3 — 목록 표시값은 다른 사람이
 *      먼저 고쳤을 수 있어 원본이 아닐 수 있다). 로그 기록 자체가 실패하면 그 상품은
 *      저장을 시도하지 않고 fail-closed 로 중단한다. 기존 로그가 손상돼 있으면 백업
 *      키로 옮기고 새로 시작하되, 그 백업 자체가 실패하면 역시 fail-closed 한다(G5) —
 *      안 그러면 백업도 못한 손상 전 원본이 새 배열로 덮여 영구 소실된다.
 *   5) 선택 0건/빈 시세/숫자 아닌 시세/비정상 범위는 실행 자체를 거부한다(validateBulkInput,
 *      G9 — 안전 정수 범위·상식적 상한).
 *   6) 반영 여부가 불확실한 실패(F5) — 저장버튼을 클릭'한 뒤'의 실패(검증경고 dialog·
 *      타임아웃·착지 URL 이상·서버 대조 불일치)는 서버에 이미 반영됐을 가능성을 배제할 수
 *      없어 'unknown' 으로 남긴다. 클릭 '전' 실패만 'not_applied'(확실히 미반영)로
 *      단정한다 — 예외가 클릭 전/후 어디서 났는지도 플래그로 가른다(G7).
 *
 *  로더 관리 파일이라 push 만으로 매장 PC 다음 새로고침에 반영된다(chrome.* API 사용 불가,
 *  MAIN world). manifest.json 에 이 페이지 경로 추가·app-files.json 등록은 메인 세션 담당.
 * ========================================================================== */
(function () {
  'use strict';

  const log = (...a) => { try { if (window.UBCFG && window.UBCFG.debug) console.log('[UB][masterprice]', ...a); } catch (_) {} };

  /* ---------- 상수 ---------- */
  // 네이티브 목록(tcode=master_item_k)의 0-base 셀 인덱스(§0.2) 중 이 파일이 실제로 읽는 것만.
  // 체크박스는 항상 맨 앞(0)에 삽입하므로, 삽입 뒤 이 열들을 다시 읽을 때는 +1 오프셋을
  // 적용한다(getSelectedItems 참조).
  const ORIG_COL = { itemCode: 3, price: 4, supply: 12, sale: 14 };
  const LOG_KEY = 'UB_MASTERPRICE_LOG_v1';
  const LOG_CAP = 2000;
  const SAVE_TIMEOUT_MS = 30000;
  const MAX_GOLD_PRICE = 100000000;   // 1억 — 상식적 상한(G9). 실제 금 시세는 g 당 수십만원대라 이보다 훨씬 작다.

  /* ==========================================================================
   *  1) 순수 헬퍼 — DOM/iframe 비의존. tests/masterprice.test.js 가 이름으로
   *     추출해 직접 실행한다(orderitem-assign.test.js 와 같은 방식).
   * ========================================================================== */

  // 목록 마지막 셀의 javascript:modify('7646') 류 문자열에서 seq 를 뽑는다.
  // 헤더 행("수정/삭제" 라벨)과 "검색된 결과가 없습니다" 행에는 modify(...) 자체가 없으므로
  // 이 함수가 데이터 행 판별의 유일한 기준이 된다(셀 개수·행 인덱스로 거르지 않는다).
  function extractSeq(html) {
    const s = String(html == null ? '' : html);
    const m = /modify\(\s*(["'])([^"']*)\1/.exec(s);
    return m ? m[2] : null;
  }

  // UI 를 붙일 페이지인가 — masterItemList.do 이고 tcode 가 정확히 master_item_k 일 때만.
  function isTargetPage(pathname, search) {
    if (!/\/master\/item\/masterItemList\.do/i.test(String(pathname == null ? '' : pathname))) return false;
    const m = /[?&]tcode=([^&]*)/.exec(String(search == null ? '' : search));
    const tcode = m ? decodeURIComponent(m[1]) : '';
    return tcode === 'master_item_k';
  }

  // 사용자가 입력한 새 적용시세 검증. 콤마·공백은 허용해 벗겨내고, 숫자가 아니거나 비어
  // 있거나 0 이하거나 안전 정수 범위를 벗어나거나 상식적 상한을 넘으면 거부한다(G9,
  // Codex P2 지적 — parseInt 가 아주 긴 숫자를 반올림/Infinity 로 흘려보내는 경로 차단).
  function parsePriceInput(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return { ok: false, reason: '새 적용시세를 입력하세요' };
    const stripped = s.replace(/,/g, '');
    if (!/^\d+$/.test(stripped)) return { ok: false, reason: '적용시세는 숫자만 입력하세요' };
    const value = Number(stripped);
    if (!Number.isSafeInteger(value)) return { ok: false, reason: '적용시세가 처리 가능한 정수 범위를 벗어났습니다' };
    if (!(value > 0)) return { ok: false, reason: '적용시세는 0보다 커야 합니다' };
    if (value > MAX_GOLD_PRICE) {
      return { ok: false, reason: '적용시세가 상식적인 범위(' + MAX_GOLD_PRICE.toLocaleString('en-US') + '원 이하)를 넘습니다 — 오타가 아닌지 확인하세요' };
    }
    return { ok: true, value: value };
  }

  // 페이지가 쓰는 천단위 콤마 표기(cashReturn 스타일)로 포맷.
  function formatComma(n) {
    let s = String(Math.trunc(Number(n)));
    const neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return neg ? '-' + s : s;
  }

  // "740,920(495,598)" 같은 2품위 표기를 {first, second} 로 분리. 괄호가 없으면 second=null.
  function splitDualValue(text) {
    const s = String(text == null ? '' : text).trim();
    const m = /^(.*?)\(([^()]*)\)\s*$/.exec(s);
    if (m) return { first: m[1].trim(), second: m[2].trim() };
    return { first: s, second: null };
  }

  // HTML 문자열에서 <input name="X" ...> 의 value 속성을 정규식으로 뽑는다(DOMParser 금지 —
  // 파일 상단 주석 참조). 이름이 정확히 일치하는 첫 <input> 만 본다. 필드 자체가 없으면
  // null, 있는데 value 속성이 없으면 빈 문자열.
  function extractInputValue(html, name) {
    const src = String(html == null ? '' : html);
    const tagRe = /<input\b[^>]*>/gi;
    let m;
    while ((m = tagRe.exec(src))) {
      const tag = m[0];
      const nameM = /\bname\s*=\s*(["'])([^"']*)\1/i.exec(tag);
      if (!nameM || nameM[2] !== name) continue;
      const valM = /\bvalue\s*=\s*(["'])([^"']*)\1/i.exec(tag);
      return valM ? valM[2] : '';
    }
    return null;
  }

  // decodeErpHtml 의 로컬 폴백(erp.js SSOT 와 동일 알고리즘 유지) — window.ubErp 가 아직
  // 없을 때만 쓰인다.
  function localDecodeBytes(bytes, contentType) {
    const u8 = (bytes instanceof Uint8Array) ? bytes : (bytes ? new Uint8Array(bytes) : new Uint8Array(0));
    const ct = String(contentType == null ? '' : contentType).toLowerCase();
    const cs = (ct.match(/(?:^|[;\s])charset\s*=\s*["']?([^"';,\s]+)/) || ['', ''])[1];
    function dec(enc) {
      try { return new TextDecoder(enc, { fatal: false }).decode(u8); }
      catch (_) { return null; }
    }
    if (/^(?:x-)?(euc[-_]?kr|uhc|cp949|windows-949|ks[-_]?c[-_]?5601(?:-\d+)?)$/.test(cs)) {
      const e0 = dec('euc-kr'); return (e0 != null) ? e0 : (dec('utf-8') || '');
    }
    if (/^utf-?8$/.test(cs)) {
      const u0 = dec('utf-8'); return (u0 != null) ? u0 : (dec('euc-kr') || '');
    }
    const utf = dec('utf-8'), euc = dec('euc-kr');
    if (utf == null) return euc || '';
    if (euc == null) return utf;
    const badU = (utf.match(/�/g) || []).length;
    const badE = (euc.match(/�/g) || []).length;
    return (badE < badU) ? euc : utf;
  }

  // win 에 ubErp.decodeErpHtml 가 있으면 그걸 위임(SSOT, 드리프트 방지) — 없으면 로컬 폴백.
  function decodeResponseBytes(bytes, contentType, win) {
    const w = win || (typeof window !== 'undefined' ? window : undefined);
    if (w && w.ubErp && typeof w.ubErp.decodeErpHtml === 'function') {
      try { return w.ubErp.decodeErpHtml(bytes, contentType); } catch (_) { /* 폴백으로 진행 */ }
    }
    return localDecodeBytes(bytes, contentType);
  }

  // submitResult 의 로컬 폴백(erp.js SSOT 와 동일 알고리즘) — msg 파라미터 관용을 따른다.
  // ⚠ "URL 은 유효하다"는 erp.js 의 전제(fetch 의 resp.url)를 그대로 물려받는다 —
  // location.href 기반 호출부는 이 함수를 직접 쓰지 않고 judgeLandingUrl 을 거친다(F3).
  function localJudgeSubmitUrl(url) {
    try {
      const msg = new URL(url).searchParams.get('msg') || '';
      return { ok: !msg, msg: msg };
    } catch (_) {
      return { ok: true, msg: '' };   // resp.url 은 실무상 항상 유효 → 도달 불가(erp.js 와 동일 처리)
    }
  }

  // win 에 ubErp.submitResult 가 있으면 위임 — 없으면 로컬 폴백.
  function judgeSubmitUrl(url, win) {
    const w = win || (typeof window !== 'undefined' ? window : undefined);
    if (w && w.ubErp && typeof w.ubErp.submitResult === 'function') {
      try { return w.ubErp.submitResult(url); } catch (_) { /* 폴백으로 진행 */ }
    }
    return localJudgeSubmitUrl(url);
  }

  // 저장 클릭 뒤 iframe 이 착지한 location.href 를 판정한다(F3) — localJudgeSubmitUrl 은
  // "URL 은 항상 유효하다"는 fetch 응답 전제라 location.href 기반인 여기서 그대로 쓰면
  // fail-open 이 된다. 이 함수는 그 전에 ①URL 이 비었는지 ②파싱 가능한지 ③예상 화면
  // (master/item) 밖으로 튕겼는지(세션 만료로 로그인 페이지 등)를 먼저 fail-closed 로
  // 검사한 뒤에만 judgeSubmitUrl 에 위임한다.
  function judgeLandingUrl(url, win) {
    const s = String(url == null ? '' : url).trim();
    if (!s) return { ok: false, msg: '이동한 URL 을 확인할 수 없습니다(응답 판정 불가)' };
    let parsed;
    try { parsed = new URL(s); }
    catch (_) { return { ok: false, msg: 'URL 파싱 실패 — 응답 판정 불가: ' + s }; }
    if (!/^\/master\/item\//i.test(parsed.pathname)) {
      return { ok: false, msg: '예상과 다른 페이지로 이동했습니다(§0.6 가정 이탈 신호일 수 있음): ' + parsed.pathname };
    }
    return judgeSubmitUrl(s, win);
  }

  // 실행 게이트 — 선택 0건이거나 새 시세가 비었거나 숫자가 아니면 거부.
  function validateBulkInput(selectedCount, rawPrice) {
    const n = Number(selectedCount) || 0;
    if (n <= 0) return { ok: false, reason: '선택한 상품이 없습니다' };
    const p = parsePriceInput(rawPrice);
    if (!p.ok) return p;
    return { ok: true, count: n, price: p.value };
  }

  // 문자열을 숫자로(콤마 제거). 결측·빈 값·비숫자는 null(0 과 구분).
  function numOrNull(s) {
    if (s == null) return null;
    const t = String(s).trim().replace(/,/g, '');
    if (t === '') return null;
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
    return parseFloat(t);
  }

  // 재계산 결과 불변식 검사(F2) — calItemPrice 의 계산식은 이식하지 않고, 그 결과가 명백히
  // 잘못된 두 경로만 막는다: ①goldPrice 필드가 의도한 값과 다르다 ②before 에서 0 이
  // 아니던 입고공급가1/2·판매가1/2 가 recalced 에서 0/빈 값/비숫자가 됐다(§0.4 실측:
  // weightType 미선택이면 calItemPrice 가 전부 0 으로 민다).
  function validateRecalc(before, recalced, intendedPriceFormatted) {
    if (!recalced) return { ok: false, reason: '재계산 결과를 읽을 수 없습니다' };
    const wantPrice = String(intendedPriceFormatted == null ? '' : intendedPriceFormatted).replace(/,/g, '');
    const gotPrice = String(recalced.goldPrice == null ? '' : recalced.goldPrice).replace(/,/g, '');
    if (gotPrice !== wantPrice) {
      return { ok: false, reason: '적용시세가 입력한 값과 다릅니다(입력 ' + intendedPriceFormatted + ', 실제 ' + recalced.goldPrice + ')' };
    }
    const fields = ['inputSupplyPrice1', 'inputSupplyPrice2', 'salePrice1', 'salePrice2'];
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const b = numOrNull(before ? before[f] : null);
      const c = numOrNull(recalced[f]);
      if (b != null && b !== 0 && (c == null || c === 0)) {
        return { ok: false, reason: f + ' 이(가) 재계산 후 0/빈 값/숫자아님으로 바뀌었습니다(원래 ' + before[f] + ')' };
      }
    }
    return { ok: true };
  }

  // 서버 재조회값 하나가 기대값과 일치하는지 비교(F6/G2). 콤마·공백 정규화 후 비교하고,
  // 판독 불가(비숫자)는 불일치로 취급한다 — 단, 둘 다 빈 값이면 일치로 본다(단일품위 상품의
  // 2번 필드처럼 원래부터 비어 있는 게 정상인 필드를 오탐하지 않기 위함, G2 대응).
  function serverValueMatches(serverValue, intendedFormatted) {
    const a = String(serverValue == null ? '' : serverValue).replace(/[,\s]/g, '');
    const b = String(intendedFormatted == null ? '' : intendedFormatted).replace(/[,\s]/g, '');
    if (a === '' && b === '') return true;
    if (a === '' || b === '') return false;
    if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return false;
    return a === b;
  }

  // 저장 성공(착지 URL) 판정 뒤에도 goldPrice·입고공급가1/2·판매가1/2 5값을 서버 재조회로
  // 대조한다(G2, Codex P1 ×2 대응) — judgeLandingUrl 의 느슨한 판정이나 서버가 시세만
  // 저장하고 나머지를 누락하는 경로를 여기서 잡는다. decideTrialContinuation 도 이 함수로
  // 통일해 트라이얼 게이트와 본 처리가 같은 기준을 쓴다.
  function verifyAgainstServer(recalced, serverAfter) {
    if (!recalced) return { ok: false, reason: '재계산 값이 없어 서버 대조를 할 수 없습니다' };
    if (!serverAfter) return { ok: false, reason: '서버 값을 읽을 수 없습니다' };
    const fields = ['goldPrice', 'inputSupplyPrice1', 'inputSupplyPrice2', 'salePrice1', 'salePrice2'];
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (!serverValueMatches(serverAfter[f], recalced[f])) {
        const sv = serverAfter[f];
        const svDisp = (sv == null) ? '(필드 없음)' : (sv === '' ? '(빈 값)' : sv);
        const rc = recalced[f];
        const rcDisp = (rc == null || rc === '') ? '(빈 값)' : rc;
        return { ok: false, reason: f + ' 불일치(재계산 ' + rcDisp + ', 서버 ' + svDisp + ')' };
      }
    }
    return { ok: true };
  }

  // 1건 시범 뒤 나머지를 진행할지 결정한다(F6) — 순수 함수라 실제 confirm() 없이 그 자체를
  // 직접 실행 검증할 수 있다. runBulkUpdate 는 이 판단이 proceed:true(=needs_user_confirm)
  // 일 때만 실제 사용자 확인을 추가로 받고, 그 확인까지 통과해야 나머지를 처리한다.
  function decideTrialContinuation(r0, serverAfter, serverErr, itemsLength) {
    if (!r0 || !r0.ok) return { proceed: false, reason: 'trial_failed' };
    if (serverErr) return { proceed: false, reason: 'refetch_failed' };
    const v = verifyAgainstServer(r0.recalced, serverAfter);
    if (!v.ok) return { proceed: false, reason: 'server_mismatch' };
    if (itemsLength <= 1) return { proceed: false, reason: 'only_one_item' };
    return { proceed: true, reason: 'needs_user_confirm' };
  }

  // 순차 실행 — 한 번에 한 건만 처리하고, 실패가 나오면 그 즉시 멈추고 뒤는 시도하지 않는다.
  async function runSequential(items, processFn, onProgress) {
    const results = [];
    for (let i = 0; i < items.length; i++) {
      if (typeof onProgress === 'function') {
        try { onProgress(items[i], i, items.length); } catch (_) {}
      }
      let r;
      try { r = await processFn(items[i], i); }
      catch (e) { r = { ok: false, status: 'unknown', reason: '예외: ' + (e && e.message ? e.message : String(e)) }; }
      results.push({ item: items[i], result: r });
      if (!r || !r.ok) return { ok: false, results: results, failedAt: i };
    }
    return { ok: true, results: results, failedAt: -1 };
  }

  // table.t_list(마지막)에 체크박스 열을 붙인다. DOM 자체가 아니라 최소 서브셋
  // ({rows:[{cells:[{innerHTML}], insertCell(i)}]}) 에만 의존해 테스트에서 가짜 테이블로
  // 실행 가능하다. 행 0 = 헤더(고정 가정). 행 1.. 중 마지막 셀에서 seq 를 뽑을 수 있는
  // 행만 데이터 행으로 센다. 데이터 행이 하나도 없으면(빈 검색결과) 아무것도 건드리지 않는다.
  function augmentMasterTable(table, onHeaderCell, onDataCell) {
    if (!table || !table.rows || table.rows.length < 2) return { augmented: false, seqs: [] };
    const rows = table.rows;
    const headerRow = rows[0];
    const dataRows = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const cells = row.cells;
      if (!cells || !cells.length) continue;
      const seq = extractSeq(cells[cells.length - 1].innerHTML);
      if (seq) dataRows.push({ row: row, seq: seq });
    }
    if (!dataRows.length) return { augmented: false, seqs: [] };

    const headerCell = headerRow.insertCell(0);
    if (typeof onHeaderCell === 'function') onHeaderCell(headerCell);

    const seqs = [];
    for (let j = 0; j < dataRows.length; j++) {
      const cell = dataRows[j].row.insertCell(0);
      if (typeof onDataCell === 'function') onDataCell(cell, dataRows[j].seq, dataRows[j].row);
      seqs.push(dataRows[j].seq);
    }
    return { augmented: true, seqs: seqs };
  }

  // 체크된 행에서 seq·상품코드와 목록에 표시된 시세·입고공급가·판매가를 모은다. 체크박스가
  // 맨 앞(0)에 삽입돼 있으므로 원래 열 인덱스는 +1 해서 읽는다. 2품위 상품은
  // "740,920(495,598)" 식으로 오므로 splitDualValue 로 분리해 둔다.
  function getSelectedItems(table) {
    if (!table) return [];
    const boxes = table.querySelectorAll('.ub-mp-chk:checked');
    const out = [];
    for (let i = 0; i < boxes.length; i++) {
      const seq = boxes[i].getAttribute('data-ub-mp-seq');
      if (!seq) continue;
      let itemCode = '', listPrice = null, listSupply = null, listSale = null;
      try {
        const row = boxes[i].closest('tr');
        itemCode = (row.cells[1 + ORIG_COL.itemCode].textContent || '').trim();
        listPrice = splitDualValue(row.cells[1 + ORIG_COL.price].textContent);
        listSupply = splitDualValue(row.cells[1 + ORIG_COL.supply].textContent);
        listSale = splitDualValue(row.cells[1 + ORIG_COL.sale].textContent);
      } catch (_) {}
      out.push({ seq: seq, itemCode: itemCode, listPrice: listPrice, listSupply: listSupply, listSale: listSale });
    }
    return out;
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 손상된 기존 로그(JSON.parse 실패·배열 아님)를 백업 키로 옮기고 새 배열로 시작한다(F1).
  // 🔴 G5 — 그 백업 자체가 실패하면(예: quota 총량 초과로 새 키 추가만 실패) 여기서 []를
  // 돌려주면 안 된다. appendPriceLog 가 그 []를 "새로 시작"으로 오인해 LOG_KEY 를 덮어써,
  // 백업도 못한 손상 전 원본이 영구 소실된다. throw 해 appendPriceLog/updatePriceLog 의
  // catch 가 fail-closed 로 처리하게 한다(F1 규율의 확장).
  function readPriceLogListOrRecover() {
    let raw = null;
    try { raw = localStorage.getItem(LOG_KEY); } catch (_) { return []; }
    if (!raw) return [];
    try {
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) throw new Error('로그가 배열이 아님');
      return list;
    } catch (_) {
      try {
        localStorage.setItem(LOG_KEY + '_corrupt_' + Date.now(), raw);
      } catch (backupErr) {
        throw new Error('손상된 로그 백업 실패 — 복구를 위해 쓰기를 막습니다: ' + (backupErr && backupErr.message ? backupErr.message : backupErr));
      }
      return [];
    }
  }

  // 처리 로그 1건 추가. 실패를 삼키지 않는다(F1) — 로그를 못 남기면 되돌릴 근거가 사라지므로
  // 반환값을 호출부(processItemWithLog)가 반드시 확인해 fail-closed 로 처리해야 한다.
  function appendPriceLog(entry) {
    try {
      const list = readPriceLogListOrRecover();
      const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      list.push(Object.assign({ id: id, ts: Date.now() }, entry));
      if (list.length > LOG_CAP) list.splice(0, list.length - LOG_CAP);
      localStorage.setItem(LOG_KEY, JSON.stringify(list));
      return { ok: true, id: id };
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    }
  }

  // write-ahead 로 남긴 항목을 결과로 갱신(F1). 갱신 실패는 fail-closed 대상이 아니다 —
  // 최초 항목은 이미 안전하게 남아 있어, 갱신 실패는 최종 상태 표기가 낡은 채로 남는
  // 정도의 손해라 실행을 막지 않는다.
  function updatePriceLog(id, patch) {
    try {
      const list = readPriceLogListOrRecover();
      const idx = list.findIndex((e) => e.id === id);
      if (idx < 0) return false;
      list[idx] = Object.assign({}, list[idx], patch, { updatedTs: Date.now() });
      localStorage.setItem(LOG_KEY, JSON.stringify(list));
      return true;
    } catch (_) {
      return false;
    }
  }

  // 로그 항목에서 "이전 값"을 표시용으로 뽑는다(G4) — before(클릭 전 실제 폼 스냅샷, G3)가
  // 있고 비어있지 않으면 그걸 우선하고, 없으면(예: 로그 기록 직후 극히 이른 실패로 before
  // 를 못 얻은 경우) 목록에서 읽은 근사값(list*)으로 폴백한다. part='first'|'second'
  // (2품위 두 번째 값).
  function logFieldDisplay(entry, formField, listField, part) {
    if (entry && entry.before && entry.before[formField] != null && entry.before[formField] !== '') {
      return entry.before[formField];
    }
    const list = entry ? entry[listField] : null;
    if (!list) return '';
    const v = (part === 'second') ? list.second : list.first;
    return v == null ? '' : v;
  }

  // 처리 로그를 사람이 볼 수 있게 새 창에 표로 띄우기 위한 HTML 생성(N3) — 순수 문자열
  // 조립이라 DOM 없이 테스트 가능하다. 🔴 G4 — "이전 시세"만이 아니라 이전 입고공급가·
  // 판매가도 함께 보여준다(되돌릴 값 5개 중 1개만 보이면 안 된다). before 가 없는 pending
  // 항목은 listPrice/listSupply/listSale 로 폴백해 "되돌릴 근거가 없다"는 오판을 막는다.
  // LOG_CAP FIFO 로 오래된 항목이 잘려 나가는 사실도 화면에 명시한다.
  function buildLogViewerHtml(list) {
    const rows = (list || []).slice().reverse().map((e) => {
      const price = logFieldDisplay(e, 'goldPrice', 'listPrice', 'first');
      const supply1 = logFieldDisplay(e, 'inputSupplyPrice1', 'listSupply', 'first');
      const supply2 = logFieldDisplay(e, 'inputSupplyPrice2', 'listSupply', 'second');
      const sale1 = logFieldDisplay(e, 'salePrice1', 'listSale', 'first');
      const sale2 = logFieldDisplay(e, 'salePrice2', 'listSale', 'second');
      return '<tr><td>' + escHtml(e.ts ? new Date(e.ts).toLocaleString('ko-KR') : '') + '</td>' +
        '<td>' + escHtml(e.itemCode || '') + '</td><td>' + escHtml(e.seq || '') + '</td>' +
        '<td>' + escHtml(e.status || '') + '</td>' +
        '<td>' + escHtml(e.newPrice != null ? formatComma(e.newPrice) : '') + '</td>' +
        '<td>' + escHtml(price) + '</td>' +
        '<td>' + escHtml(supply1) + (supply2 ? '(' + escHtml(supply2) + ')' : '') + '</td>' +
        '<td>' + escHtml(sale1) + (sale2 ? '(' + escHtml(sale2) + ')' : '') + '</td>' +
        '<td>' + escHtml(e.reason || '') + '</td></tr>';
    }).join('');
    return '<!doctype html><meta charset="utf-8"><title>적용시세 일괄변경 로그</title>' +
      '<style>body{font-family:Pretendard,-apple-system,\'Malgun Gothic\',sans-serif;font-size:13px;padding:16px}' +
      'table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px 8px;text-align:left;' +
      'white-space:nowrap}th{background:#f7f9fc}</style>' +
      '<h3>적용시세 일괄변경 처리 로그 (' + (list ? list.length : 0) + '건, 최신순)</h3>' +
      '<p style="color:#888;font-size:12px">최근 ' + formatComma(LOG_CAP) + '건까지만 보관됩니다 — 그보다 오래된 기록은 자동으로 사라집니다.</p>' +
      '<table><thead><tr><th>시각</th><th>상품코드</th><th>seq</th><th>상태</th><th>새 시세</th>' +
      '<th>이전 시세</th><th>이전 입고공급가</th><th>이전 판매가</th><th>사유</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  /* ==========================================================================
   *  2) DOM/브라우저 전용 — 실제 document·iframe·fetch 를 쓴다. 대부분 라이브 검증(사람 +
   *     메인 세션) 몫이지만, processOneItem/processItemWithLog/runBulkUpdate 는
   *     {iframe,doc,win}/{table,checkbox,row}/{window,document,fetch} 최소 서브셋에만
   *     기대므로 가짜 하네스로 실제 실행 검증이 가능하다.
   * ========================================================================== */

  function modifyFormUrl(seq) {
    return '/master/item/masterItemModifyForm.do?tcode=master_item&seq=' + encodeURIComponent(seq);
  }

  function findLastList() {
    const tables = document.querySelectorAll('table.t_list');
    return tables.length ? tables[tables.length - 1] : null;
  }

  const TOOLBAR_STYLE_ID = 'ub-mp-style';
  const TOOLBAR_CSS = `
    .ub-mp-bar {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      padding: 12px 16px; margin: 0 0 12px 0;
      background: #f7f9fc; border: 1px solid #e5e7eb; border-radius: 10px;
      font-family: Pretendard, -apple-system, 'Malgun Gothic', sans-serif;
      font-size: 13px; color: #1b1b1b;
    }
    .ub-mp-bar label { display: flex; align-items: center; gap: 8px; font-weight: 600; }
    .ub-mp-input {
      width: 140px; padding: 6px 10px; border: 1px solid #d5dae1; border-radius: 6px;
      font-size: 13px; font-family: inherit; outline-color: #35C5F0;
    }
    .ub-mp-btn {
      padding: 7px 16px; border-radius: 6px; border: 1px solid #2badd6;
      background: #35C5F0; color: #fff; font-weight: 700; font-size: 13px; cursor: pointer;
      font-family: inherit;
    }
    .ub-mp-btn:hover { background: #2badd6; }
    .ub-mp-btn:disabled { background: #c9d2dc; border-color: #c9d2dc; cursor: not-allowed; }
    .ub-mp-btn-ghost {
      background: #fff; color: #35707a; border: 1px solid #d5dae1; font-weight: 600;
    }
    .ub-mp-btn-ghost:hover { background: #f2f6f7; }
    .ub-mp-btn-ghost:disabled { background: #fff; color: #b7bec7; border-color: #e5e7eb; }
    .ub-mp-count { color: #5b6472; font-size: 12.5px; }
    .ub-mp-progress { color: #0d8695; font-size: 12.5px; font-weight: 600; }
  `;
  function injectStyles() {
    if (document.getElementById(TOOLBAR_STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = TOOLBAR_STYLE_ID; s.textContent = TOOLBAR_CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function buildHeaderCheckbox(cell) {
    cell.innerHTML = '<input type="checkbox" class="ub-mp-all" title="전체 선택/해제">';
  }
  function buildDataCheckbox(cell, seq) {
    cell.innerHTML = '<input type="checkbox" class="ub-mp-chk" data-ub-mp-seq="' + escHtml(seq) + '">';
  }

  // 숨은 iframe 생성. dataset.ubAutoJob 을 src 보다 먼저 세운다 — 파일 상단 '자동화 프레임
  // 가드' 주석 참조. left:-10000px 오프스크린(display:none 대신)은 레이아웃 의존 스크립트가
  // 0 크기로 오동작하는 것을 피하기 위함(skin.js autoSpikeFrame 과 같은 관례).
  function createHiddenFrame() {
    const f = document.createElement('iframe');
    f.dataset.ubAutoJob = 'ubmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1024px;height:900px;border:0;';
    document.body.appendChild(f);
    return f;
  }

  function waitForLoadOrTimeout(iframe, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (done) return; done = true; resolve(false); }, timeoutMs);
      iframe.addEventListener('load', function onLoad() {
        if (done) return; done = true; clearTimeout(timer); resolve(true);
      }, { once: true });
    });
  }

  // 저장버튼 클릭 후를 위한 3원 대기 — 'load'(정상 이동) / 'dialog'(checkForm 이 alert 로
  // 막음) / 'timeout'. dialog 케이스를 짧은 폴링(150ms)으로 먼저 잡아, 검증 실패를
  // timeoutMs 끝까지 기다리지 않고 빠르게 실패 처리한다.
  function waitForLoadOrDialog(iframe, getDialog, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const poll = setInterval(() => {
        if (done) return;
        if (getDialog()) { done = true; clearInterval(poll); clearTimeout(timer); resolve('dialog'); }
      }, 150);
      const timer = setTimeout(() => {
        if (done) return; done = true; clearInterval(poll); resolve('timeout');
      }, timeoutMs);
      iframe.addEventListener('load', function onLoad() {
        if (done) return; done = true; clearInterval(poll); clearTimeout(timer); resolve('load');
      }, { once: true });
    });
  }

  function readFormSnapshot(doc) {
    const f = doc && doc.forms ? doc.forms['form1'] : null;
    if (!f) return null;
    function v(name) { const el = f.elements[name]; return el ? el.value : ''; }
    return {
      goldPrice: v('goldPrice'),
      inputSupplyPrice1: v('inputSupplyPrice1'), inputSupplyPrice2: v('inputSupplyPrice2'),
      salePrice1: v('salePrice1'), salePrice2: v('salePrice2')
    };
  }

  // 1건 시범 정지의 서버 재조회 — 목록이 아니라 수정폼을 seq 로 다시 GET(파일 상단 주석).
  // processOneItem(G2) 과 runBulkUpdate(트라이얼 표시) 둘 다 이 함수를 쓴다.
  async function refetchFieldsForSeq(seq) {
    const url = modifyFormUrl(seq);
    const resp = await fetch(url, { credentials: 'same-origin', cache: 'no-cache' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const buf = await resp.arrayBuffer();
    const ct = resp.headers.get('content-type') || '';
    const html = decodeResponseBytes(buf, ct, window);
    return {
      goldPrice: extractInputValue(html, 'goldPrice'),
      inputSupplyPrice1: extractInputValue(html, 'inputSupplyPrice1'),
      inputSupplyPrice2: extractInputValue(html, 'inputSupplyPrice2'),
      salePrice1: extractInputValue(html, 'salePrice1'),
      salePrice2: extractInputValue(html, 'salePrice2')
    };
  }

  // 상품 1건 처리 — design doc §2.4 의 7단계 + 3자 검수 반영판(G2·G3·G7 포함).
  // timeoutMs 는 테스트에서 짧은 값을 주입하기 위한 선택 인자(기본 SAVE_TIMEOUT_MS).
  // onBefore(before) — 클릭 전 실제 폼 스냅샷을 얻는 즉시 호출된다(G3, write-ahead 로그 보강용).
  // 반환: {ok, status, reason?, before?, recalced?, resultUrl?}
  //   status: 'applied'(확실히 반영) | 'not_applied'(클릭 전 실패 — 확실히 미반영) |
  //           'unknown'(클릭 후 실패 — 반영 여부 불명, F5)
  async function processOneItem(iframe, seq, newPriceFormatted, timeoutMs, onBefore) {
    const t = (timeoutMs == null) ? SAVE_TIMEOUT_MS : timeoutMs;
    let onReload = null;
    let clickAttempted = false;   // G7 — 예외가 클릭 전/후 어디서 났는지 가르는 유일한 근거.
    try {
      iframe.src = modifyFormUrl(seq);
      const loaded = await waitForLoadOrTimeout(iframe, t);
      if (!loaded) return { ok: false, status: 'not_applied', reason: '수정폼 로드 시간 초과(' + Math.round(t / 1000) + '초)' };

      let win = iframe.contentWindow, doc = iframe.contentDocument;
      if (!win || !doc) return { ok: false, status: 'not_applied', reason: '수정폼 문서를 읽을 수 없습니다(교차 출처?)' };

      // alert/confirm 가로채기 — 문서가 바뀔 때마다(iframe 의 매 load) 다시 건다(N2).
      let capturedAlert = null;
      function installDialogGuard(w) {
        if (!w) return;
        try {
          w.alert = function (msg) { capturedAlert = String(msg == null ? '' : msg); };
          w.confirm = function () { return true; };
        } catch (_) {}
      }
      installDialogGuard(win);
      onReload = function () { win = iframe.contentWindow; doc = iframe.contentDocument; installDialogGuard(win); };
      iframe.addEventListener('load', onReload);

      const form = doc.forms ? doc.forms['form1'] : null;
      if (!form || !form.elements['goldPrice']) {
        return { ok: false, status: 'not_applied', reason: 'form1.goldPrice 를 찾을 수 없습니다(폼 구조 변경?)' };
      }

      const before = readFormSnapshot(doc);
      if (typeof onBefore === 'function') { try { onBefore(before); } catch (_) {} }   // G3

      form.elements['goldPrice'].value = newPriceFormatted;

      if (typeof win.calItemPrice !== 'function') {
        return { ok: false, status: 'not_applied', reason: 'calItemPrice 함수를 찾을 수 없습니다(페이지 스크립트 로드 실패?)' };
      }
      win.calItemPrice(form);   // 🔴 changeGoldPrice 아님 — 파일 상단 주석 참조
      const recalced = readFormSnapshot(doc);

      // F2 — 계산식은 이식하지 않고 불변식만 검사한다. 걸리면 클릭하지 않는다(확실히 미반영).
      const rc = validateRecalc(before, recalced, newPriceFormatted);
      if (!rc.ok) return { ok: false, status: 'not_applied', reason: '재계산 검증 실패: ' + rc.reason, before: before, recalced: recalced };

      // F4 — calItemPrice 실행 중 등, 클릭 '전에' 이미 dialog 가 잡혔으면 클릭하지 않는다.
      if (capturedAlert) {
        return { ok: false, status: 'not_applied', reason: '저장 전 검증에서 막혔습니다: ' + capturedAlert, before: before, recalced: recalced };
      }

      const saveBtn = form.elements['imageField22'];
      if (!saveBtn) return { ok: false, status: 'not_applied', reason: '저장 버튼(imageField22)을 찾을 수 없습니다', before: before, recalced: recalced };

      capturedAlert = null;   // F4 핵심 — 클릭 '직전'에 리셋해 클릭 이후에 뜬 dialog 만 신호로 쓴다.
      const outcome = waitForLoadOrDialog(iframe, () => capturedAlert, t);
      clickAttempted = true;   // G7 핵심 — 이 지점 이후의 예외는 unknown, 이전은 not_applied.
      saveBtn.click();   // 🔴 폼을 직접 제출하지 않는다(네이티브 submit 금지) — 파일 상단 주석 참조
      const how = await outcome;

      // 여기부터는 클릭이 이미 나갔다 — 실패해도 서버에 도달·커밋됐을 가능성을 배제할 수
      // 없다. dialog·timeout·착지 URL 이상·서버 대조 불일치 전부 '반영 여부 불명'으로 남긴다(F5).
      if (how === 'dialog') return { ok: false, status: 'unknown', reason: '저장 후 확인 불가(검증 경고 감지): ' + capturedAlert, before: before, recalced: recalced };
      if (how === 'timeout') return { ok: false, status: 'unknown', reason: '저장 응답 시간 초과(' + Math.round(t / 1000) + '초) — 서버에 반영됐을 수 있습니다', before: before, recalced: recalced };

      win = iframe.contentWindow;   // 이동 후 새 문서의 win 을 다시 잡는다(전역 객체가 갈렸을 수 있다 — N2)
      let resultUrl = '';
      try { resultUrl = win.location.href; } catch (_) {}
      const judged = judgeLandingUrl(resultUrl, window);
      if (!judged.ok) return { ok: false, status: 'unknown', reason: judged.msg || '저장 실패(사유 미상)', before: before, recalced: recalced };

      // G2 — 착지 URL 판정만으로는 서버가 시세는 저장하고 입고공급가·판매가를 누락·오계산한
      // 경우나 judgeLandingUrl 의 느슨한 판정이 실패 문서를 성공으로 오인한 경우를 못 잡는다.
      // 그 상품을 서버에서 다시 읽어(iframe 재사용 없이 fetch — decideTrialContinuation 과
      // 같은 경로) 5값을 재계산 결과와 대조한다.
      let serverAfter, verify;
      try {
        serverAfter = await refetchFieldsForSeq(seq);
        verify = verifyAgainstServer(recalced, serverAfter);
      } catch (e) {
        verify = { ok: false, reason: '서버 재조회 실패: ' + (e && e.message ? e.message : String(e)) };
      }
      if (!verify.ok) return { ok: false, status: 'unknown', reason: '저장 후 서버 대조 실패 — ' + verify.reason, before: before, recalced: recalced };

      return { ok: true, status: 'applied', before: before, recalced: recalced, resultUrl: resultUrl };
    } catch (e) {
      // G7 — 클릭을 실제로 시도했는지에 따라 상태를 가른다. 서버 쓰기가 시작되지도 않은
      // 예외까지 전부 unknown 으로 보내면 진짜 unknown 의 경고가 무뎌진다.
      return { ok: false, status: clickAttempted ? 'unknown' : 'not_applied', reason: '예외: ' + (e && e.message ? e.message : String(e)) };
    } finally {
      if (onReload) { try { iframe.removeEventListener('load', onReload); } catch (_) {} }
    }
  }

  // 상품 1건을 처리하면서 로그를 '저장 클릭 전에' write-ahead 로 남기고, 끝나면 그 항목을
  // 결과로 갱신한다(F1). 로그 기록 자체가 실패하면 저장을 시도하지 않고 즉시 실패
  // 처리한다(fail-closed). 🔴 G3 — processOneItem 이 클릭 전에 얻는 실제 폼 before 스냅샷을
  // onBefore 콜백으로 받아 write-ahead 항목에 얹는다(목록 표시값보다 정확한 진짜 원본).
  // logId 를 반환값에 실어 호출부(runBulkUpdate)가 나중에(G8) 상태를 재기록할 수 있게 한다.
  async function processItemWithLog(iframe, item, priceFormatted, intendedValue, timeoutMs) {
    const base = {
      seq: item.seq, itemCode: item.itemCode, newPrice: intendedValue,
      listPrice: item.listPrice, listSupply: item.listSupply, listSale: item.listSale
    };
    const w = appendPriceLog(Object.assign({ status: 'pending' }, base));
    if (!w.ok) {
      return {
        ok: false, status: 'not_applied', logId: null,
        reason: '처리 로그 기록 실패 — 되돌릴 근거를 남길 수 없어 저장을 시도하지 않았습니다(' + (w.reason || '') + ')'
      };
    }
    const r = await processOneItem(iframe, item.seq, priceFormatted, timeoutMs, (before) => {
      const upd = updatePriceLog(w.id, { before: before });
      if (!upd) log('write-ahead before 갱신 실패(목록 표시값은 남아 있음):', item.seq);
    });
    const upd = updatePriceLog(w.id, Object.assign({ status: r.status || (r.ok ? 'applied' : 'unknown') }, r));
    if (!upd) log('처리 로그 갱신 실패(write-ahead 항목 자체는 이미 남아 있음):', item.seq);
    return Object.assign({ logId: w.id }, r);
  }

  // 처리 로그를 사람이 볼 수 있게 새 창에 표로 띄운다(N3) — 지금까지는 localStorage 를
  // F12 로 직접 뒤지는 게 유일한 열람 수단이라 "되돌릴 유일한 근거"를 사장님이 실제로는
  // 볼 수 없었다.
  function showLogViewer() {
    const list = readPriceLogListOrRecover();
    const html = buildLogViewerHtml(list);
    let w = null;
    try { w = window.open('', '_blank', 'width=960,height=600'); } catch (_) {}
    if (w && w.document) {
      w.document.open(); w.document.write(html); w.document.close();
    } else {
      window.alert('팝업이 차단된 것 같습니다. 팝업을 허용한 뒤 다시 시도하세요.\n\n(로그는 localStorage 키 ' + LOG_KEY + ' 에 있습니다)');
    }
  }

  // 전체 실행 — 검증 → 확인 → 1건 시범(+서버 재조회 자동 비교, F6/G2) → 사용자 승인 →
  // 나머지 순차. 트라이얼 정지·최종 확인은 confirm()/alert() 네이티브 dialog 를 쓴다(이
  // 세션에서 커스텀 모달의 실제 렌더링을 확인할 수 없어 신뢰성을 우선했다). 진행률 표시는
  // 툴바(ui)에 남아 있는 텍스트 영역을 갱신해 처리 중에도 보이게 한다.
  async function runBulkUpdate(table, items, rawPrice, ui) {
    const v = validateBulkInput(items.length, rawPrice);
    if (!v.ok) { window.alert(v.reason); return; }
    const priceFormatted = formatComma(v.price);

    const go = window.confirm(
      '선택한 ' + items.length + '건의 적용시세를 ' + priceFormatted + '원으로 일괄 변경합니다.\n\n' +
      '먼저 1건만 저장하고 서버에서 다시 읽은 값을 자동으로 비교합니다. 일치해야 나머지가 진행됩니다.\n\n' +
      '진행할까요?'
    );
    if (!go) return;

    ui.setBusy(true);
    const iframe = createHiddenFrame();
    try {
      ui.setProgress(1, items.length, items[0].itemCode);
      const r0 = await processItemWithLog(iframe, items[0], priceFormatted, v.price);

      if (!r0.ok) {
        const uncertain = r0.status === 'unknown';
        window.alert('1건 시범 실패 — 나머지 상품은 처리하지 않았습니다.\n\n' +
          items[0].itemCode + ' (seq ' + items[0].seq + ')\n사유: ' + r0.reason +
          (uncertain ? '\n\n주의: 이 1건은 반영 여부가 불확실합니다. 직접 확인하세요.' : '\n\n이 1건은 반영되지 않았습니다.'));
        return;
      }

      let serverAfter = null, serverErr = '';
      try { serverAfter = await refetchFieldsForSeq(items[0].seq); }
      catch (e) { serverErr = String(e && e.message ? e.message : e); }

      const decision = decideTrialContinuation(r0, serverAfter, serverErr, items.length);
      const cmp = compareLines(r0.before, r0.recalced, serverAfter, serverErr);
      const head = '1건 시범 완료 — ' + items[0].itemCode + ' (seq ' + items[0].seq + ')\n\n' + cmp;

      // G10 — decision.proceed 를 1차 게이트로 쓴다. 새 차단 사유가 늘어도 이 분기 밖으로
      // 떨어져 '진행' 쪽으로 새지 않는다(fail-closed 기본값 — else 분기 참조).
      if (!decision.proceed) {
        // G8 — processOneItem 내부(G2)에서는 통과했더라도, 이 표시용 재조회가 실패/불일치
        // 하면 로그에 'applied' 로 확정 반영된 것처럼 남지 않게 unknown 으로 재기록한다.
        if ((decision.reason === 'refetch_failed' || decision.reason === 'server_mismatch') && r0.logId) {
          updatePriceLog(r0.logId, {
            status: 'unknown',
            reason: decision.reason === 'refetch_failed'
              ? '표시용 서버 재조회 실패: ' + serverErr
              : '표시용 서버 재조회 불일치(서버 값이 재계산 결과와 다름)'
          });
        }
        if (decision.reason === 'refetch_failed') {
          window.alert(head + '\n\n서버 재조회 자체가 실패해 결과를 확인할 수 없습니다 — 자동 검증 불가로 여기서 중단합니다.\n방금 저장된 1건을 직접 확인하세요.');
        } else if (decision.reason === 'server_mismatch') {
          window.alert(head + '\n\n서버에서 다시 읽은 값이 재계산 결과와 다르거나 확인되지 않습니다 — 자동 검증 실패로 여기서 중단합니다.\n방금 저장된 1건을 직접 확인하세요.');
        } else if (decision.reason === 'only_one_item') {
          window.alert(head + '\n\n선택한 상품이 이 1건뿐이라 여기서 끝났습니다.');
        } else {
          window.alert(head + '\n\n자동 검증을 통과하지 못해 여기서 중단합니다(' + (decision.reason || '사유 미상') + ').\n방금 저장된 1건을 직접 확인하세요.');
        }
        return;
      }

      const cont = window.confirm(
        head + '\n\n자동 검증을 통과했습니다. [확인]을 눌러 나머지 ' + (items.length - 1) + '건을 계속하세요.\n' +
        '[취소]를 누르면 방금 바뀐 1건만 반영된 채로 멈춥니다.'
      );
      if (!cont) {
        window.alert('중단했습니다. 방금 저장된 1건(위 정보, 처리 로그 참고)은 그대로 남아 있습니다.');
        return;
      }

      const rest = items.slice(1);
      const summary = await runSequential(
        rest,
        (item) => processItemWithLog(iframe, item, priceFormatted, v.price),
        (item, idx, total) => ui.setProgress(idx + 2, items.length, item.itemCode)
      );

      if (!summary.ok) {
        const failedItem = rest[summary.failedAt];
        const failedResult = summary.results[summary.failedAt] && summary.results[summary.failedAt].result;
        const uncertain = failedResult && failedResult.status === 'unknown';
        // 🔴 G1 — rest 는 items.slice(1) 이라 failedAt 은 rest 기준 0-base. 실제 시도 총수
        // (시범 1건 + rest 에서 실패까지 포함한 건수) = failedAt + 2. 성공 확정 건수 =
        // 1(시범) + failedAt(그 실패 전 rest 성공 건수). "+1" 로 세면 반영 여부가 불확실한
        // 상품을 "손대지 않은 뒤 상품"으로 잘못 세어 확인 대상에서 빠진다.
        const confirmedApplied = 1 + summary.failedAt;
        const attempted = confirmedApplied + 1;
        const untouched = items.length - attempted;
        window.alert(
          '실패 — ' + (failedItem ? failedItem.itemCode + ' (seq ' + failedItem.seq + ')' : '알 수 없음') +
          '\n사유: ' + (failedResult && failedResult.reason || '알 수 없음') +
          (uncertain
            ? '\n\n주의: 이 상품은 반영 여부가 불확실합니다 — 응답을 받기 전에 실패로 판정됐을 수 있습니다. 반드시 직접 확인하세요.'
            : '\n\n이 상품은 반영되지 않았습니다.') +
          '\n\n성공 확인 ' + confirmedApplied + '건 / ' + (uncertain ? '확인 필요 1건' : '실패 1건') +
          ' / 미시도 ' + untouched + '건(그 뒤 상품은 손대지 않았습니다).'
        );
      } else {
        window.alert('완료 — 총 ' + items.length + '건의 적용시세를 ' + priceFormatted + '원으로 변경했습니다.');
      }
    } finally {
      ui.setBusy(false);
      try { iframe.remove(); } catch (_) {}
    }
  }

  function fieldLine(label, key, before, recalced, serverAfter, serverErr) {
    const b = before ? before[key] : '?';
    const c = recalced ? recalced[key] : '?';
    let s;
    if (serverAfter) {
      const v = serverAfter[key];
      s = (v == null) ? '(필드 없음)' : (v === '' ? '(빈 값)' : v);
    } else {
      s = serverErr ? '(재조회 실패: ' + serverErr + ')' : '(확인 안 됨)';
    }
    return label + ': ' + b + ' → ' + c + '  [서버 재조회: ' + s + ']';
  }
  function compareLines(before, recalced, serverAfter, serverErr) {
    return [
      fieldLine('적용시세', 'goldPrice', before, recalced, serverAfter, serverErr),
      fieldLine('입고공급가1', 'inputSupplyPrice1', before, recalced, serverAfter, serverErr),
      fieldLine('입고공급가2', 'inputSupplyPrice2', before, recalced, serverAfter, serverErr),
      fieldLine('판매가1', 'salePrice1', before, recalced, serverAfter, serverErr),
      fieldLine('판매가2', 'salePrice2', before, recalced, serverAfter, serverErr)
    ].join('\n');
  }

  function buildToolbar(table) {
    injectStyles();
    const bar = document.createElement('div');
    bar.className = 'ub-mp-bar';
    bar.innerHTML =
      '<span class="ub-mp-count"></span>' +
      '<label>새 적용시세 <input type="text" class="ub-mp-input" placeholder="예: 900000" inputmode="numeric"></label>' +
      '<button type="button" class="ub-mp-btn">일괄 변경</button>' +
      '<button type="button" class="ub-mp-btn ub-mp-btn-ghost">처리 로그 보기</button>' +
      '<span class="ub-mp-progress"></span>';
    table.parentNode.insertBefore(bar, table);

    const countEl = bar.querySelector('.ub-mp-count');
    const inputEl = bar.querySelector('.ub-mp-input');
    const btnEl = bar.querySelector('.ub-mp-btn:not(.ub-mp-btn-ghost)');
    const logBtnEl = bar.querySelector('.ub-mp-btn-ghost');
    const progEl = bar.querySelector('.ub-mp-progress');

    function refreshCount() { countEl.textContent = getSelectedItems(table).length + '건 선택됨'; }
    refreshCount();

    table.addEventListener('change', (e) => {
      const t = e.target;
      if (!t || !t.classList) return;
      if (t.classList.contains('ub-mp-all')) {
        table.querySelectorAll('.ub-mp-chk').forEach((b) => { b.checked = t.checked; });
        refreshCount();
      } else if (t.classList.contains('ub-mp-chk')) {
        refreshCount();
      }
    });

    const ui = {
      setBusy(busy) {
        inputEl.disabled = busy; btnEl.disabled = busy;
        // N4 — 실행 중에는 선택도 잠근다. 이전에는 입력창·버튼만 잠갔다.
        table.querySelectorAll('.ub-mp-chk, .ub-mp-all').forEach((el) => { el.disabled = busy; });
      },
      setProgress(n, total, itemCode) { progEl.textContent = total ? (n + ' / ' + total + (itemCode ? ' — ' + itemCode : '')) : ''; }
    };

    btnEl.addEventListener('click', () => {
      runBulkUpdate(table, getSelectedItems(table), inputEl.value, ui);
    });
    logBtnEl.addEventListener('click', showLogViewer);

    return bar;
  }

  function augmentPage() {
    const table = findLastList();
    if (!table) { log('table.t_list 를 찾지 못했습니다'); return; }
    const result = augmentMasterTable(table, buildHeaderCheckbox, buildDataCheckbox);
    if (!result.augmented) { log('데이터 행이 없어 UI 를 붙이지 않습니다(빈 검색결과 등)'); return; }
    buildToolbar(table);
    log('적용시세 일괄변경 UI 부착 완료 —', result.seqs.length, '건');
  }

  function init() {
    if (!isTargetPage(location.pathname, location.search)) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', augmentPage, { once: true });
    } else {
      augmentPage();
    }
  }

  init();
})();
