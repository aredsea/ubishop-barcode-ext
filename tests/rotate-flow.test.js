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
const NAMES = ['rotStep1Outcome'];
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
