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
const NAMES = ['rotStep1Outcome', 'rotNewBarcodeFromCells', 'rotNewBarcodeFromRow'];
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
test('rotStep1Outcome: 근접 문구("…아닙니다" 만 같은)는 통과시키지 않는다', () => {
  //  Opus 5 Nit(2026-09-15): 정규식을 /아닙니다/ 로 느슨하게 바꿔도 살아남던 변이
  assert.equal(F.rotStep1Outcome({ ok: false, msg: '반품 대상이 아닙니다' }).proceed, false);
  assert.equal(F.rotStep1Outcome({ ok: false, msg: '본사반품확인 가능한 상태입니다' }).proceed, false);
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
  assert.ok(/if \(\+\+tries < 25\) \{ setTimeout\(tick, 300\); return; \}[^\n]*\n\s*ubHlPolling = false;[^\n]*\n\s*if \(isRotateWrite\(\)\) rotAfterRowMissing\(bc\);/.test(body), '소진 훅');
});
test('rotAfterRowFound: msg 거부면 무시, 새바코드를 읽으면 보관함에 넣고 ok(저장 실패는 warn), 못 읽으면 warn (return 경로 4개)', () => {
  const body = extractFn(SRC, 'rotAfterRowFound');
  //  Opus 5 P2(2026-09-15): 거부(msg)됐는데 열린 회전입고장의 옛 행을 찾아 초록 '등록' 이 빨강을 덮었다 → 첫 줄에서 무시
  assert.ok(/^async function rotAfterRowFound\(tr, oldBc\) \{\s*if \(rotServerMsg\(\)\) \{[^}]*return; \}/.test(body), 'msg 거부면 첫 줄에서 return');
  assert.ok(/const nb = rotNewBarcodeFromRow\(tr, oldBc\);/.test(body));
  assert.ok(/if \(!nb\) \{[^}]*rotSetResultStatus\('행은 찾았으나 새바코드를 못 읽음\(표 구조 변경\?\)', 'warn'\); return; \}/.test(body));
  assert.ok(/saved = await stkRecentAdd\(nb\) === true;/.test(body), '보관함 저장 결과를 본다');
  assert.ok(/if \(!saved\) \{ rotSetResultStatus\([^;]*보관함 저장 실패\(팝업 강조 안 됨\)', 'warn'\); return; \}/.test(body), '저장 실패는 등록이라 말하지 않는다');
  assert.ok(/rotSetResultStatus\(stkNorm\(oldBc\) \+ ' → 새바코드 ' \+ nb \+ ' · 본사확인 팝업 강조 등록', 'ok'\);/.test(body));
});
test('stkRecentAdd 는 저장 여부를 돌려준다(true 저장·false 실패) — 회전입고 상태줄이 이걸 믿는다', () => {
  const body = extractFn(SRC, 'stkRecentAdd');
  assert.ok(/if \(!bc\) return false;/.test(body));
  assert.ok(/if \(!cur\.ok\) \{[^}]*return false; \}/.test(body));
  assert.ok(/const saved = await stkRecentSave\(next\);[\s\S]*return saved;/.test(body));
  const save = extractFn(SRC, 'stkRecentSave');
  assert.ok(/resolve\(!e\);/.test(save) && /catch \(_\) \{ resolve\(false\); \}/.test(save));
});
test('rotAfterRowMissing: 서버 msg 가 떠 있거나 flag 바코드가 이 화면의 직전 회전입고가 아니면 경고하지 않는다', () => {
  const body = extractFn(SRC, 'rotAfterRowMissing');
  assert.ok(/^function rotAfterRowMissing\(bc\)/.test(body), 'flag 바코드를 받는다');
  assert.ok(/if \(rotServerMsg\(\)\) return;/.test(body));
  assert.ok(/if \(!last \|\| stkNorm\(last\.barcode\) !== stkNorm\(bc\)\) return;/.test(body), '남의 화면 flag 는 무시(Opus 5 Nit)');
  assert.ok(/rotSetResultStatus\('회전입고 결과 행을 못 찾음 — 화면 메시지 확인', 'warn'\);/.test(body));
  //  Opus 5 O2 Nit: 거부 문구는 배선 플래그가 아니라 URL 을 직접 읽는다(렌더 순서 무관)
  const helper = extractFn(SRC, 'rotServerMsg');
  assert.ok(/new URLSearchParams\(location\.search\)\.get\('msg'\)/.test(helper) && /\.trim\(\)/.test(helper) && /catch \(_\) \{ return ''; \}/.test(helper), 'rotServerMsg 는 location.search 의 msg 를 trim 해 돌려주고 실패 시 빈 문자열');
  assert.ok(!/rotMsgShown/.test(SRC), '렌더 경로 플래그(rotMsgShown)는 남아 있으면 안 된다');
  assert.ok(/if \(isRotateWrite\(\)\) rotAfterRowMissing\(bc\);/.test(extractFn(SRC, 'ubHighlightPending')), '폴러가 flag 바코드를 넘긴다');
});
test('rotSetResultStatus 는 마지막 결과를 기억하고 배선이 재렌더 뒤 다시 그린다', () => {
  const body = extractFn(SRC, 'rotSetResultStatus');
  assert.ok(/rotLastResult = \{ text: text \|\| '', kind: kind \|\| '' \};/.test(body));
  const i = SRC.indexOf("const rotIn = bar.querySelector('#ub-rot-in');");
  const block = SRC.slice(i, i + 3200);
  assert.ok(/rotServerMsg\(\);[\s\S]{0,400}?if \(rotLastResult\) setRotStatus\(rotLastResult\.text, rotLastResult\.kind\);/.test(block), 'msg 뒤에 마지막 결과 재적용');
  assert.ok(/rotBusy = true;\s*rotLastResult = null;/.test(extractFn(SRC, 'rotateRun')), '새 실행 시작 때 이전 결과를 비운다(Opus 5 O2 Nit)');
});
//  DOM 래퍼: 자식 노드를 공백으로 잇고(<br> 뒤 공백 없어도 첫 토큰이 바코드), 헤더는 자기 행이 아닌 '새바코드' 행.
function fakeCell(nodes) { return { childNodes: nodes.map((t) => ({ textContent: t })), textContent: nodes.join('') }; }
function fakeRow(cellNodes) { const r = { cells: cellNodes.map(fakeCell) }; r.textContent = r.cells.map((c) => c.textContent).join(''); return r; }
test('rotNewBarcodeFromRow: <br> 뒤 공백이 없어도(textContent 가 붙어 나와도) 새바코드를 읽는다', () => {
  const hdr = fakeRow([['No'], [''], ['새바코드', '새상품번호'], ['새매장명', '새상품정보'], [''], [''], [''], [''], ['기존바코드 / 기존판매가', '중량'], [''], [''], ['']]);
  const tr = fakeRow([['1'], [''], ['2609I8', 'F-NF-P-WG-PA-00DU'], ['D102본사', '925 1 g ()'], ['0'], ['1'], ['48,000'], ['0'], ['240H1B / 22,000', '1 g'], ['0'], [''], ['']]);
  const table = { rows: [hdr, tr] };
  tr.closest = (sel) => (sel === 'table' ? table : null);
  assert.equal(tr.cells[2].textContent, '2609I8F-NF-P-WG-PA-00DU', '픽스처가 붙은 textContent 를 흉내낸다');
  assert.equal(F.rotNewBarcodeFromRow(tr, '240H1B'), '2609I8');
});
test('rotNewBarcodeFromRow: 데이터 행 비고에 "새바코드" 가 있고 헤더보다 앞에 와도 자기 행을 헤더로 쓰지 않는다', () => {
  const hdr = fakeRow([['No'], [''], ['새바코드', '새상품번호'], ['']]);
  const tr = fakeRow([['1'], ['비고: 새바코드 재발급'], ['2609I8', 'F-NF-P'], ['']]);
  const table = { rows: [tr, hdr] };
  tr.closest = (sel) => (sel === 'table' ? table : null);
  assert.equal(F.rotNewBarcodeFromRow(tr, '240H1B'), '2609I8');
});
test('rotNewBarcodeFromRow: 셀 앞의 주석 노드는 토큰이 되지 않는다', () => {
  const hdr = fakeRow([['No'], [''], ['새바코드', '새상품번호'], ['']]);
  const tr = fakeRow([['1'], [''], ['2609I8', 'F-NF-P'], ['']]);
  tr.cells[2].childNodes.unshift({ nodeType: 8, textContent: ' seq 123456 ' });   // <!-- seq 123456 -->
  const table = { rows: [hdr, tr] };
  tr.closest = (sel) => (sel === 'table' ? table : null);
  assert.equal(F.rotNewBarcodeFromRow(tr, '240H1B'), '2609I8');
});
test('rotNewBarcodeFromRow: 표·헤더가 없거나 closest 가 없으면 빈 문자열', () => {
  const tr = fakeRow([['1'], ['2609I8']]);
  assert.equal(F.rotNewBarcodeFromRow(tr, '240H1B'), '');
  tr.closest = () => ({ rows: [tr] });
  assert.equal(F.rotNewBarcodeFromRow(tr, '240H1B'), '');
  assert.equal(F.rotNewBarcodeFromRow(null, '240H1B'), '');
});
test('회전입고 배선: 로드 시 URL msg 를 읽어 err 로 띄우고 rotMsgShown 을 세운다', () => {
  const i = SRC.indexOf("const rotIn = bar.querySelector('#ub-rot-in');");
  assert.ok(i >= 0, '회전입고 배선 블록');
  const block = SRC.slice(i, i + 3000);
  assert.ok(/const m = rotServerMsg\(\);\s*if \(m\) setRotStatus\('회전입고 실패: ' \+ m, 'err'\);/.test(block), 'msg 읽기');
  assert.ok(block.indexOf('UB_ROTATE_LAST') < block.indexOf('rotServerMsg()'), 'msg 표시가 "직전:" 뒤라 우선한다(스펙 §4)');
});
