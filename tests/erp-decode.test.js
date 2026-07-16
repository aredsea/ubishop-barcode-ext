// erp-decode.test.js — src/erp.js 정규 디코드/성공판정 검증.
// 픽스처는 합성: 한글 문자열을 EUC-KR(cp949)·UTF-8 양쪽 바이트로. EUC-KR 바이트는
// 셋업에서 TextDecoder('euc-kr') 왕복으로 자기검증(잘못된 바이트 방지). node tests/erp-decode.test.js.
const assert = require('node:assert');
const { decodeErpHtml, submitResult } = require('../src/erp.js');

const ORIG = '입고장번호 감정서 판매가 매입처 다이아 12,100원 성별SR';
// Python cp949 로 생성한 EUC-KR 바이트(base64). UTF-8 은 node 네이티브로 생성.
const EUCKR = Uint8Array.from(Buffer.from('wNSw7cDlufjIoyCwqMGkvK0gxse4xbChILjFwNTDsyC02cDMvsYgMTIsMTAwv/ggvLq6sFNS', 'base64'));
const UTF8 = Uint8Array.from(Buffer.from(ORIG, 'utf8'));

// ── 픽스처 자기검증 (바이트가 정말 원문의 해당 인코딩인지 왕복 확인) ──
assert.strictEqual(new TextDecoder('euc-kr').decode(EUCKR), ORIG, 'fixture EUCKR round-trip');
assert.strictEqual(new TextDecoder('utf-8').decode(UTF8), ORIG, 'fixture UTF8 round-trip');
// score-both 전제: EUC-KR 바이트를 utf-8 로 디코드하면 �(U+FFFD)가 나와야 판별이 성립
assert.ok((new TextDecoder('utf-8', { fatal: false }).decode(EUCKR).match(/�/g) || []).length > 0,
  'EUC-KR 바이트는 utf-8 디코드 시 � 발생(전제)');

// 판별용 바이트 C2 A1 — utf-8=U+00A1"¡"(0 �), euc-kr(cp949)=다른 글자(0 �). 양쪽 replacement 가
//  0 이라 '별칭 헤더 우선(euc-kr 분기)'과 '미선언 동률 tie-break(utf-8)'를 서로 구별한다(mutant 잡음).
const DISC = Uint8Array.from([0xC2, 0xA1]);
const DISC_UTF = new TextDecoder('utf-8', { fatal: false }).decode(DISC);
const DISC_EUC = new TextDecoder('euc-kr').decode(DISC);
assert.notStrictEqual(DISC_UTF, DISC_EUC, 'DISC: 두 인코딩 결과가 달라야 판별 가능');
assert.strictEqual((DISC_UTF.match(/�/g) || []).length, 0, 'DISC utf-8 �=0');
assert.strictEqual((DISC_EUC.match(/�/g) || []).length, 0, 'DISC euc-kr �=0');

let n = 0;
function eq(name, a, b) { assert.strictEqual(a, b, name + ` (got ${JSON.stringify(a)})`); console.log('  ✓', name); n++; }
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓', name); n++; }

console.log('[a] 헤더가 euc-kr 계열 선언 → euc-kr');
eq('charset=euc-kr → 원문', decodeErpHtml(EUCKR, 'text/html; charset=euc-kr'), ORIG);
eq('charset=ks_c_5601-1987 → 원문', decodeErpHtml(EUCKR, 'text/html; charset=ks_c_5601-1987'), ORIG);
eq('charset=ksc5601 → 원문', decodeErpHtml(EUCKR, 'charset=ksc5601'), ORIG);
eq('charset=cp949 → 원문(별칭)', decodeErpHtml(EUCKR, 'charset=cp949'), ORIG);
eq('charset=windows-949 → 원문(별칭)', decodeErpHtml(EUCKR, 'text/html;charset=windows-949'), ORIG);
eq('charset=euc_kr → 원문(별칭)', decodeErpHtml(EUCKR, 'charset=euc_kr'), ORIG);

console.log('[b] 헤더가 utf-8 선언 → utf-8');
eq('charset=utf-8 → 원문', decodeErpHtml(UTF8, 'text/html; charset=utf-8'), ORIG);
eq('charset=utf8 → 원문', decodeErpHtml(UTF8, 'charset=utf8'), ORIG);

console.log('[c] 미선언/모호 → score-both(� 적은 쪽, 동률 utf-8)');
eq('euc-kr 바이트 + 헤더없음 → euc-kr 채택', decodeErpHtml(EUCKR, ''), ORIG);
eq('euc-kr 바이트 + text/html(무charset) → euc-kr 채택', decodeErpHtml(EUCKR, 'text/html'), ORIG);
eq('utf-8 바이트 + 헤더없음(undefined) → utf-8 채택', decodeErpHtml(UTF8, undefined), ORIG);

console.log('[d] 입력 형태·엣지');
eq('ArrayBuffer 입력 허용', decodeErpHtml(UTF8.buffer, 'charset=utf-8'), ORIG);
eq('빈 Uint8Array → 빈 문자열', decodeErpHtml(new Uint8Array(0), ''), '');
eq('null bytes → 빈 문자열', decodeErpHtml(null, ''), '');
// 오선언(헤더 우선 원칙): utf-8 바이트를 euc-kr 로 잘못 선언하면 헤더 신뢰라 원문과 달라짐.
//  실무상 ERP 헤더는 정확하거나 없으며(→ score-both), 이는 '헤더 신뢰' 동작을 명문화하는 케이스.
ok('오선언 euc-kr(실제 utf-8) → 헤더 신뢰라 원문과 다름(문서화)', decodeErpHtml(UTF8, 'charset=euc-kr') !== ORIG);
eq('charset=utf-80(오탐 배제) → euc-kr 바이트 score-both → 원문', decodeErpHtml(EUCKR, 'charset=utf-80'), ORIG);
// C2 A1 판별 — 별칭 분기·tie-break·경계를 mutant 가 통과 못하게 실검증
eq('cp949 헤더 → euc-kr 분기(별칭 실검증: ¡ 아님)', decodeErpHtml(DISC, 'charset=cp949'), DISC_EUC);
eq('charset=euc_kr 헤더 → euc-kr 분기', decodeErpHtml(DISC, 'charset=euc_kr'), DISC_EUC);
eq('charset=x-euc-kr 헤더 → euc-kr 분기(x- 접두 별칭)', decodeErpHtml(DISC, 'charset=x-euc-kr'), DISC_EUC);
eq('미선언 동률(둘다 �=0) → utf-8 채택(tie-break 실검증)', decodeErpHtml(DISC, ''), DISC_UTF);
eq('notcharset=cp949(앞 경계 오탐 배제) → charset 아님 → 동률 utf-8', decodeErpHtml(DISC, 'text/html; notcharset=cp949'), DISC_UTF);
eq('charset=cp9490(별칭 정확일치 아님) → 미지 charset → 동률 utf-8', decodeErpHtml(DISC, 'charset=cp9490'), DISC_UTF);

console.log('[e] submitResult (msg 비면 성공)');
ok('msg 없음 → ok:true', (function () { const r = submitResult('http://x/opdelivedItemWriteForm.do?tcode=opdeliv_item'); return r.ok === true && r.msg === ''; })());
ok('msg 있음 → ok:false + msg', (function () { const m = '본사반품확인 가능한 상태가 아닙니다'; const r = submitResult('http://x/a.do?msg=' + encodeURIComponent(m)); return r.ok === false && r.msg === m; })());
ok('잘못된 URL → ok:true(기존 skin.js 동작 유지: resp.url 은 실무상 항상 유효)', submitResult('not a url').ok === true);

console.log('[f] differential — 정상 단일인코딩에서 collector.scoreBoth 와 일치(무회귀 근거)');
// ⚠ 실제 ERP 응답은 전체가 euc-kr 또는 utf-8 단일 인코딩(스트림 중간 혼합 없음). 혼합/부분손상
//   바이트는 병리적 케이스로 범위 외. threshold-20(skin) 은 �≤20 인 euc-kr 을 놓치는 약한 방식이라
//   신규가 이를 흡수(개선)한다. 실페이지 무회귀는 Phase 2 이관 시 실트래픽 대조로 최종 검증.
function legacyScoreBoth(u8) {   // collector.js decodeKr 방식(가장 강건한 레거시)
  const u = new TextDecoder('utf-8', { fatal: false }).decode(u8), ub = (u.match(/�/g) || []).length;
  if (ub === 0) return u;
  const e = new TextDecoder('euc-kr').decode(u8), eb = (e.match(/�/g) || []).length;
  return eb < ub ? e : u;
}
[['euc-kr', EUCKR], ['utf-8', UTF8]].forEach(function (p) {
  const got = decodeErpHtml(p[1], '');
  ok('differential(' + p[0] + '): 신규==collector.scoreBoth 이자 원문', got === ORIG && got === legacyScoreBoth(p[1]));
});

console.log(`\nerp-decode: ${n} pass`);
