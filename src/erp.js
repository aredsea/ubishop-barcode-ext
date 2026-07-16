/* =============================================================================
 *  erp.js — 유비샵 ERP 응답 처리의 정규(SSOT) 순수 함수.
 *
 *  유비샵(옛 Struts)은 EUC-KR/UTF-8 응답이 혼재한다. 지금까지 각 파일이 서로 다른
 *  휴리스틱(threshold-20 / 헤더스니프+샘플 / score-both / utf→euc)으로 제각각 디코드했다.
 *  이 모듈이 그걸 가장 강건한 하나로 통합한다(작업 C, realm별 점진 이관).
 *
 *  ⚠ DOM/문서 API 를 쓰지 않는다 — MAIN world·ISOLATED·SW(DOMParser 없음) 어디서든 동작.
 *    TextDecoder(+URL) 만 사용.
 *  ⚠ SSOT. skin.js(ISOLATED)·background.js(SW)는 채널 결합 회피를 위해 이 알고리즘의
 *    로컬 복사본을 두되, 반드시 여기와 동일 동작을 유지한다(드리프트 테스트로 보증).
 *
 *  노출: node → module.exports, 브라우저/SW → globalThis.ubErp.
 * ========================================================================== */
(function () {
  'use strict';

  // 응답 바이트를 한글까지 올바르게 디코드. contentType=응답 Content-Type 헤더(없으면 ''/undefined).
  //  (a) 헤더가 euc-kr 계열 선언 → euc-kr,  (b) utf-8 선언 → utf-8,
  //  (c) 미선언/모호 → utf-8·euc-kr 둘 다 디코드해 U+FFFD(�) 적은 쪽 채택(동률 utf-8).
  function decodeErpHtml(bytes, contentType) {
    var u8 = (bytes instanceof Uint8Array) ? bytes
           : (bytes ? new Uint8Array(bytes) : new Uint8Array(0));
    var ct = String(contentType == null ? '' : contentType).toLowerCase();
    // content-type 파라미터에서 charset '값'만 추출 — 앞 경계(^|;|공백) 필수라 'notcharset=' 오탐 배제.
    var cs = (ct.match(/(?:^|[;\s])charset\s*=\s*["']?([^"';,\s]+)/) || ['', ''])[1];
    function dec(enc) {
      try { return new TextDecoder(enc, { fatal: false }).decode(u8); }
      catch (_) { return null; }
    }
    // (a) charset 이 euc-kr 계열(별칭 '정확일치' — 'cp9490' 등 오탐 배제). ICU 'euc-kr' 디코더가
    //     WHATWG 규격상 cp949/windows-949 전체를 커버하므로 별칭 전부 'euc-kr' 로 디코드.
    if (/^(?:x-)?(euc[-_]?kr|uhc|cp949|windows-949|ks[-_]?c[-_]?5601(?:-\d+)?)$/.test(cs)) {
      var e0 = dec('euc-kr'); return (e0 != null) ? e0 : (dec('utf-8') || '');
    }
    if (/^utf-?8$/.test(cs)) {                           // (b) charset = utf-8 (정확일치 — 'utf-80' 배제)
      var u0 = dec('utf-8'); return (u0 != null) ? u0 : (dec('euc-kr') || '');
    }
    var utf = dec('utf-8'), euc = dec('euc-kr');          // (c) charset 없음/미지 → score-both
    if (utf == null) return euc || '';
    if (euc == null) return utf;
    var badU = (utf.match(/�/g) || []).length;
    var badE = (euc.match(/�/g) || []).length;
    return (badE < badU) ? euc : utf;                     // 동률 → utf-8 선호
  }

  // 유비샵 폼 제출 성공판정: 성공·실패 모두 폼페이지로 리다이렉트되며 실패일 때만 리다이렉트
  //  URL 의 msg 파라미터에 에러문구가 실린다. → msg 비면 성공. url=fetch 응답의 resp.url.
  function submitResult(url) {
    try {
      var msg = new URL(url).searchParams.get('msg') || '';
      return { ok: !msg, msg: msg };
    } catch (_) {
      // URL 파싱 불가(실무상 resp.url 은 항상 유효 → 도달 불가). 기존 skin.js confirmOpdelivedReturn
      //  동작과 동일하게 msg 없음=성공으로 처리(무회귀). Phase 3/4 이관 시 각 소비처 의미 재확인.
      return { ok: true, msg: '' };
    }
  }

  var api = { decodeErpHtml: decodeErpHtml, submitResult: submitResult };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof globalThis !== 'undefined') { globalThis.ubErp = api; }
})();
