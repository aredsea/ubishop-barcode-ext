/* =============================================================================
 *  rotate-flow.test.js — 회전입고 자동화 보강(2026-09-15) 순수 판정부 + 배선 대조.
 *   스펙: docs/superpowers/specs/2026-09-15-rotate-passthrough-newbarcode-design.md
 *
 *  skin.js 는 content script IIFE 라 require 할 수 없다 → 소스에서 DOM·chrome 비의존 함수
 *  선언만 이름으로 잘라 샌드박스에서 평가한다(stock-recent.test.js 와 같은 방식).
 *
 *  실행: node --test tests/rotate-flow.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'skin.js'), 'utf8');

// function NAME( ... ) { ... } 를 중괄호 균형으로 잘라낸다(async 접두 포함).
function extractFn(src, name) {
  const kw = src.indexOf('function ' + name + '(');
  assert.ok(kw >= 0, `skin.js 에서 ${name} 선언을 찾지 못했습니다 (리네임 여부 확인)`);
  const start = (src.slice(kw - 6, kw) === 'async ') ? kw - 6 : kw;
  const open = src.indexOf('{', kw);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 본문의 중괄호 균형을 찾지 못했습니다`);
}
const NAMES = ['rotStep1Outcome', 'rotNewBarcodeFromCells'];
const F = {};
new Function('exports', NAMES.map((n) => extractFn(SRC, n)).join('\n') + '\n' + NAMES.map((n) => `exports.${n} = ${n};`).join('\n'))(F);

// ── Task 1: 1단계 판정 ─────────────────────────────────────────────────────
test('rotStep1Outcome: ok 면 그대로 진행(note 없음)', () => {
  assert.deepStrictEqual(F.rotStep1Outcome({ ok: true }), { proceed: true, note: '' });
});
test('rotStep1Outcome: "가능한 상태가 아닙니다" 실패는 건너뛰고 진행', () => {
  const r = F.rotStep1Outcome({ ok: false, msg: '본사반품확인 가능한 상태가 아닙니다' });
  assert.equal(r.proceed, true);
  assert.equal(r.note, '본사반품확인 건너뜀(이미 확인됐거나 대상 아님)');
});
test('rotStep1Outcome: 다른 문구 실패는 중단하고 문구를 그대로 전달', () => {
  const r = F.rotStep1Outcome({ ok: false, msg: '폼페이지 구조 변경(관리자 문의)' });
  assert.deepStrictEqual(r, { proceed: false, note: '폼페이지 구조 변경(관리자 문의)' });
});
test('rotStep1Outcome: msg 없는 실패·이상한 입력은 중단 + 기본 안내 문구', () => {
  assert.deepStrictEqual(F.rotStep1Outcome({ ok: false }), { proceed: false, note: '반품 신청된 건인지 확인' });
  assert.deepStrictEqual(F.rotStep1Outcome(null), { proceed: false, note: '반품 신청된 건인지 확인' });
});

// ── 배선 대조(소스): 판정 함수가 실제 실행 경로에 걸려 있는가 ─────────────────
test('rotateRun 은 rotStep1Outcome 으로 판정하고 proceed 거짓이면 return 한다', () => {
  const body = extractFn(SRC, 'rotateRun');
  assert.ok(/const step1 = rotStep1Outcome\(await confirmOpdelivedReturn\(barcode\)\);/.test(body), '판정 호출');
  assert.ok(/if \(!step1\.proceed\) \{ setStatus\('본사반품확인 실패: ' \+ step1\.note, 'err'\); return; \}/.test(body), '중단 분기');
  assert.ok(/setStatus\(\(step1\.note \? step1\.note \+ ' → ' : ''\) \+ '회전입고 실행 중…', 'go'\);/.test(body), '건너뜀 안내가 상태에 붙는다');
  assert.ok(!/if \(!res\.ok\) \{ setStatus\('본사반품확인 실패/.test(body), '옛 분기(모든 실패 중단)가 남아 있다');
});

// ── Task 2: 새 바코드 읽기(순수) — 2026-09-15 회전입고장 표 실측 텍스트 그대로 ─────
//  헤더 셀은 <br> 이 지워져 '새바코드새상품번호' 처럼 붙어 온다. 데이터 셀 첫 토큰이 새바코드.
const HDR = ['No', '', '새바코드새상품번호', '새매장명새상품정보', '새시세(새배수)', '수량', '새판매가', '예정DC', '기존바코드 / 기존판매가중량 (사이즈) 색상', '기존시세(기존배수)', '연결번호', '수정'];
const ROW = ['1', '', '2609I8 F-NF-P-WG-PA-00DU 매입처상품코드 : 실버925', 'D102본사925 1 g ()', '0(5)', '1', '48,000', '0(0 %)', '240H1B / 22,000 1 g () WG', '0(5)', '', ''];

test('rotNewBarcodeFromCells: 실측 표에서 새바코드를 읽는다', () => {
  assert.equal(F.rotNewBarcodeFromCells(HDR, ROW, '240H1B'), '2609I8');
});
test('rotNewBarcodeFromCells: 헤더 텍스트가 "새바코드<br>새상품번호" 처럼 줄바꿈·공백을 품어도 잡힌다', () => {
  const hdr = HDR.slice(); hdr[2] = ' 새바코드\n 새상품번호 ';
  assert.equal(F.rotNewBarcodeFromCells(hdr, ROW, '240H1B'), '2609I8');
});
test('rotNewBarcodeFromCells: 소문자로 와도 대문자로 돌려준다(유비샵은 대문자 저장)', () => {
  const row = ROW.slice(); row[2] = '2609i8 F-NF-P-WG-PA-00DU';
  assert.equal(F.rotNewBarcodeFromCells(HDR, row, '240h1b'), '2609I8');
});
test('rotNewBarcodeFromCells: 헤더에 새바코드 열이 없으면 빈 문자열', () => {
  const hdr = HDR.slice(); hdr[2] = '바코드상품번호';
  assert.equal(F.rotNewBarcodeFromCells(hdr, ROW, '240H1B'), '');
});
test('rotNewBarcodeFromCells: 첫 토큰이 6자 영숫자가 아니면 빈 문자열', () => {
  for (const bad of ['2609I', '2609I8X', '2609-8', '', '검색된 결과가 없습니다.']) {
    const row = ROW.slice(); row[2] = bad + ' F-NF-P-WG-PA-00DU';
    assert.equal(F.rotNewBarcodeFromCells(HDR, row, '240H1B'), '', JSON.stringify(bad));
  }
});
test('rotNewBarcodeFromCells: 기존 바코드와 같으면(열이 밀린 경우) 빈 문자열', () => {
  const row = ROW.slice(); row[2] = '240H1B F-NF-P-WG-PA-00DU';
  assert.equal(F.rotNewBarcodeFromCells(HDR, row, '240h1b'), '');
});
test('rotNewBarcodeFromCells: 행 셀이 헤더보다 짧거나 입력이 배열이 아니면 빈 문자열', () => {
  assert.equal(F.rotNewBarcodeFromCells(HDR, ROW.slice(0, 2), '240H1B'), '');
  assert.equal(F.rotNewBarcodeFromCells(null, ROW, '240H1B'), '');
  assert.equal(F.rotNewBarcodeFromCells(HDR, null, '240H1B'), '');
});

// ── 배선 대조(소스): 공용 폴러의 훅과 결과 화면 상태줄 ──────────────────────────
test('ubHighlightPending: 행 발견 시 회전입고 페이지면 rotAfterRowFound, 소진 시 rotAfterRowMissing', () => {
  const body = extractFn(SRC, 'ubHighlightPending');
  assert.ok(/msLog\('강조\+스크롤', bc\);\s*ubHlPolling = false;\s*if \(isRotateWrite\(\)\) rotAfterRowFound\(row, bc\);/.test(body), '행 발견 훅');
  assert.ok(/if \(\+\+tries < 25\) \{ setTimeout\(tick, 300\); return; \}[^\n]*\n\s*ubHlPolling = false;[^\n]*\n\s*if \(isRotateWrite\(\)\) rotAfterRowMissing\(\);/.test(body), '소진 훅');
});
test('rotAfterRowFound: 새바코드를 읽으면 보관함에 넣고 ok, 못 읽으면 warn (return 경로 2개)', () => {
  const body = extractFn(SRC, 'rotAfterRowFound');
  assert.ok(/const nb = rotNewBarcodeFromRow\(tr, oldBc\);/.test(body));
  assert.ok(/if \(!nb\) \{[^}]*rotSetResultStatus\('행은 찾았으나 새바코드를 못 읽음\(표 구조 변경\?\)', 'warn'\); return; \}/.test(body));
  assert.ok(/await stkRecentAdd\(nb\);/.test(body), '보관함 저장');
  assert.ok(/rotSetResultStatus\(stkNorm\(oldBc\) \+ ' → 새바코드 ' \+ nb \+ ' · 본사확인 팝업 강조 등록', 'ok'\);/.test(body));
});
test('rotAfterRowMissing: 서버 msg 가 이미 떠 있으면 덮어쓰지 않는다', () => {
  const body = extractFn(SRC, 'rotAfterRowMissing');
  assert.ok(/if \(rotMsgShown\) return;/.test(body));
  assert.ok(/rotSetResultStatus\('회전입고 결과 행을 못 찾음 — 화면 메시지 확인', 'warn'\);/.test(body));
});
test('회전입고 배선: 로드 시 URL msg 를 읽어 err 로 띄우고 rotMsgShown 을 세운다', () => {
  const i = SRC.indexOf("const rotIn = bar.querySelector('#ub-rot-in');");
  assert.ok(i >= 0, '회전입고 배선 블록');
  const block = SRC.slice(i, i + 3000);
  assert.ok(/const m = new URLSearchParams\(location\.search\)\.get\('msg'\) \|\| '';\s*if \(m\.trim\(\)\) \{ rotMsgShown = true; setRotStatus\('회전입고 실패: ' \+ m\.trim\(\), 'err'\); \}/.test(block), 'msg 읽기');
  assert.ok(block.indexOf('UB_ROTATE_LAST') < block.indexOf("get('msg')"), 'msg 표시가 "직전:" 뒤라 우선한다(스펙 §4)');
});
