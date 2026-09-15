# 회전입고 자동화 보강(본사반품확인 건너뛰기 · 새 바코드 팝업 강조) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 회전입고 자동화가 "본사반품확인 가능한 상태가 아닙니다"로 1단계가 거절돼도 회전입고로 진행하고, 결과 화면에서 새로 발급된 바코드를 읽어 재고화 보관함에 넣어 본사확인 팝업이 강조하게 한다. 결과 상태줄은 서버 거부/행 발견/행 없음을 구분해 보여준다.

**Architecture:** 전부 `src/skin.js` §5.6(회전입고 자동화) 안. 순수 판정 함수 2개(`rotStep1Outcome`, `rotNewBarcodeFromCells`)를 두고 `rotateRun`·공용 `ubHighlightPending`·회전입고 사이드바 배선에 얇게 건다. 새 네트워크 요청 없음. 보관함(`stkRecentAdd`)·팝업 강조 코드는 기존 그대로 재사용.

**Tech Stack:** Chrome MV3 content script(ISOLATED), node:test(`node --test`), 소스 추출 하네스(`tests/stock-recent.test.js` 방식).

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-09-15-rotate-passthrough-newbarcode-design.md` (§4 상태줄 우선순위, §5 컴포넌트 계약이 정본).
- 1단계 통과 문구는 정확히 `가능한 상태가 아닙니다` 하나 — 다른 문구·통신 실패는 중단(fail-closed).
- 새 바코드 채택 조건: `/^[0-9A-Z]{6}$/` 이고 기존 바코드(대문자)와 다름. 아니면 `''`.
- 새 코드는 표시·보관함용 — 어떤 실패도 회전입고 제출을 막지 않는다. 쓰기 경로에 새 요청 없음.
- 재고화·메인석 페이지의 `ubHighlightPending` 동작은 불변(훅은 `isRotateWrite()` 로만).
- SHELL 채널: `manifest.json` 4.2.0 → **4.2.1**, `pwsh -File build-shell-index.ps1` 재생성, `node --test tests/loader-integrity.test.js` 통과 후 main push. ExtSync 가 20분 내 매장 반영.
- 검수 등급 **T2**: 외부 1명(GLM, 최대 3라운드) + Opus 5 + 완료 직전 교차 1회. **Fable 은 쓰지 않는다**(사장님 지시 2026-09-15). 대상은 diff 로 좁힌다.
- 커밋 메시지는 한국어, 끝에 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: 1단계(본사반품확인) 판정 — `rotStep1Outcome` + `rotateRun` 배선

**Files:**
- Modify: `src/skin.js` §5.6 — `confirmOpdelivedReturn` 바로 아래(약 1296행)에 함수 추가, `rotateRun`(약 1298-1318행) 3줄 변경
- Test: `tests/rotate-flow.test.js` (신규)

**Interfaces:**
- Produces: `rotStep1Outcome(res: {ok:boolean, msg?:string}) → {proceed:boolean, note:string}`

- [ ] **Step 1: 테스트 파일 생성(하네스 + Task 1 케이스)**

`tests/rotate-flow.test.js`:

```js
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
```

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/rotate-flow.test.js`
Expected: 하네스가 `skin.js 에서 rotStep1Outcome 선언을 찾지 못했습니다` 로 즉시 실패(fail 1 이상).

- [ ] **Step 3: `rotStep1Outcome` 추가 + `rotateRun` 변경**

`src/skin.js` — `confirmOpdelivedReturn` 함수의 닫는 `}` 바로 다음, `let rotBusy = false;` 앞에 추가:

```js
  // 1단계(본사반품확인) 결과 판정 — 순수. 서버가 "가능한 상태가 아닙니다" 로 거절한 건은 이미 본사반품확인이
  //  됐거나 애초에 대상이 아닌 건이다. 어느 쪽이든 회전입고를 서버가 다시 거른다(사장님 확인 2026-09-15)고 해서
  //  그 문구 **하나만** 통과시킨다(스펙 §1). 통신·sKey 추출 실패·다른 문구는 지금처럼 중단 — 문구가 바뀌면
  //  자동화가 예전처럼 멈추는 쪽으로 무너진다(fail-closed).
  function rotStep1Outcome(res) {
    if (res && res.ok) return { proceed: true, note: '' };
    const msg = String((res && res.msg) || '');
    if (/가능한 상태가 아닙니다/.test(msg)) return { proceed: true, note: '본사반품확인 건너뜀(이미 확인됐거나 대상 아님)' };
    return { proceed: false, note: msg || '반품 신청된 건인지 확인' };
  }
```

`rotateRun` 안의 세 줄

```js
      setStatus('본사반품확인 처리 중…', 'go');
      const res = await confirmOpdelivedReturn(barcode);
      if (!res.ok) { setStatus('본사반품확인 실패: ' + (res.msg || '반품 신청된 건인지 확인'), 'err'); return; }
      setStatus('회전입고 실행 중…', 'go');
```

을 다음으로 교체:

```js
      setStatus('본사반품확인 처리 중…', 'go');
      const step1 = rotStep1Outcome(await confirmOpdelivedReturn(barcode));
      if (!step1.proceed) { setStatus('본사반품확인 실패: ' + step1.note, 'err'); return; }
      setStatus((step1.note ? step1.note + ' → ' : '') + '회전입고 실행 중…', 'go');
```

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/rotate-flow.test.js`
Expected: `ℹ pass 5` / `ℹ fail 0`. 그리고 `node -e "new Function(require('fs').readFileSync('src/skin.js','utf8'))"` 가 출력 없이 끝난다(문법).

- [ ] **Step 5: 커밋**

```bash
git add src/skin.js tests/rotate-flow.test.js
git commit -m "feat(회전입고): 본사반품확인이 '가능한 상태가 아닙니다' 로 거절돼도 회전입고로 진행(rotStep1Outcome) — 다른 실패는 여전히 중단

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: 결과 화면 — 새 바코드 읽기 → 보관함, 상태줄 우선순위

**Files:**
- Modify: `src/skin.js` — §5.6 에 순수 함수·DOM 래퍼·상태 함수 추가(Task 1 함수 아래), `ubHighlightPending`(약 1163-1200행) 행 발견/소진 분기에 훅 2줄, 회전입고 배선(약 3588-3591행 `UB_ROTATE_LAST` 블록 뒤)에 `msg` 읽기
- Test: `tests/rotate-flow.test.js` (Task 1 파일에 추가)

**Interfaces:**
- Consumes: `stkRecentAdd(barcode)`(재고화 보관함, `src/skin.js` 약 727행) · `stkNorm(bc)` · `isRotateWrite()` · `rotLog`
- Produces: `rotNewBarcodeFromCells(headerTexts: string[], rowTexts: string[], oldBc: string) → string`, `rotNewBarcodeFromRow(tr, oldBc) → string`, `rotSetResultStatus(text, kind)`, `rotAfterRowFound(tr, oldBc)`, `rotAfterRowMissing()`, 모듈 상태 `rotMsgShown`

- [ ] **Step 1: 테스트 추가(순수 함수 + 배선 대조)**

`tests/rotate-flow.test.js` 의 `const NAMES = ['rotStep1Outcome'];` 를 `const NAMES = ['rotStep1Outcome', 'rotNewBarcodeFromCells'];` 로 바꾸고, 파일 끝에 추가:

```js
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
  assert.ok(/if \(\+\+tries < 25\) \{ setTimeout\(tick, 300\); return; \}\s*ubHlPolling = false;[^\n]*\n\s*if \(isRotateWrite\(\)\) rotAfterRowMissing\(\);/.test(body), '소진 훅');
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
```

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/rotate-flow.test.js`
Expected: 하네스가 `skin.js 에서 rotNewBarcodeFromCells 선언을 찾지 못했습니다` 로 실패.

- [ ] **Step 3: 순수 함수·래퍼·상태 함수 추가**

`src/skin.js` — Task 1 의 `rotStep1Outcome` 바로 아래에 추가:

```js
  // 결과 화면(회전입고장 표)에서 새바코드 읽기 — 순수. 헤더가 '새바코드' 로 **시작**하는 열(실측 2026-09-15:
  //  헤더 셀 '새바코드<br>새상품번호', 데이터 셀 '<b>2609I8</b><br>F-NF-…')의 첫 토큰. idx 체크박스 값은
  //  'seq,기존바코드,상태' 라 새바코드가 없어 셀에서 읽는다(스펙 §3). 6자 영숫자이고 기존 바코드와 다를 때만 채택.
  function rotNewBarcodeFromCells(headerTexts, rowTexts, oldBc) {
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const hs = Array.isArray(headerTexts) ? headerTexts : [];
    const rs = Array.isArray(rowTexts) ? rowTexts : [];
    const i = hs.findIndex((h) => norm(h).indexOf('새바코드') === 0);
    if (i < 0 || i >= rs.length) return '';
    const tok = (norm(rs[i]).split(' ')[0] || '').toUpperCase();
    if (!/^[0-9A-Z]{6}$/.test(tok)) return '';
    if (tok === String(oldBc == null ? '' : oldBc).trim().toUpperCase()) return '';
    return tok;
  }
  // DOM 래퍼: 강조된 행이 속한 표에서 '새바코드' 를 품은 다른 행을 헤더로 삼는다. 못 찾으면 ''.
  function rotNewBarcodeFromRow(tr, oldBc) {
    try {
      const tbl = tr && tr.closest ? tr.closest('table') : null;
      if (!tbl) return '';
      const hdr = [...tbl.rows].find((r) => r !== tr && /새바코드/.test(r.textContent || ''));
      if (!hdr) return '';
      const texts = (r) => [...r.cells].map((c) => c.textContent || '');
      return rotNewBarcodeFromCells(texts(hdr), texts(tr), oldBc);
    } catch (_) { return ''; }
  }
  // 결과 화면 상태줄(#ub-rot-st). 사이드바가 아직/이미 없으면 무시 — 표시용이라 실패해도 아무 일도 안 일어난다.
  function rotSetResultStatus(text, kind) {
    const el = document.getElementById('ub-rot-st');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'ub-stk-st' + (kind ? ' ' + kind : '');
  }
  let rotMsgShown = false;   // 로드 시 URL msg(서버 거부)를 띄웠으면 '행 못 찾음' 경고로 덮지 않는다(스펙 §4)
  // 폴러가 기존 바코드 행을 찾은 순간: 같은 행에서 새바코드 → 재고화 보관함(본사확인 팝업이 강조) → 상태 ok.
  async function rotAfterRowFound(tr, oldBc) {
    const nb = rotNewBarcodeFromRow(tr, oldBc);
    if (!nb) { rotLog('새바코드 못 읽음', oldBc); rotSetResultStatus('행은 찾았으나 새바코드를 못 읽음(표 구조 변경?)', 'warn'); return; }
    try { await stkRecentAdd(nb); } catch (e) { rotLog('보관함 저장 실패', e); }
    rotLog('새바코드', oldBc, '→', nb, '보관함 등록');
    rotSetResultStatus(stkNorm(oldBc) + ' → 새바코드 ' + nb + ' · 본사확인 팝업 강조 등록', 'ok');
  }
  // 폴러가 소진(약 7.5초)될 때까지 행이 없음: 서버가 거부했거나 표가 안 떴다.
  function rotAfterRowMissing() {
    if (rotMsgShown) return;
    rotSetResultStatus('회전입고 결과 행을 못 찾음 — 화면 메시지 확인', 'warn');
  }
```

- [ ] **Step 4: `ubHighlightPending` 훅 2줄**

행 발견 분기의

```js
        msLog('강조+스크롤', bc);
        ubHlPolling = false;
        return;
```

을

```js
        msLog('강조+스크롤', bc);
        ubHlPolling = false;
        if (isRotateWrite()) rotAfterRowFound(row, bc);   // 회전입고: 같은 행에서 새바코드 → 보관함(스펙 §2)
        return;
```

으로, 소진 분기의

```js
      if (++tries < 25) { setTimeout(tick, 300); return; }   // ~7.5s 폴링(렌더 지연 대비)
      ubHlPolling = false;   // 소진: flag 유지(60초 만료) → 옵저버/다음 로드가 재시도
```

을

```js
      if (++tries < 25) { setTimeout(tick, 300); return; }   // ~7.5s 폴링(렌더 지연 대비)
      ubHlPolling = false;   // 소진: flag 유지(60초 만료) → 옵저버/다음 로드가 재시도
      if (isRotateWrite()) rotAfterRowMissing();          // 회전입고: 결과 행 없음 → 상태줄 경고(스펙 §4-4)
```

으로 바꾼다.

- [ ] **Step 5: 회전입고 배선에 `msg` 읽기**

회전입고 배선 블록의

```js
      try {
        const last = JSON.parse(localStorage.getItem('UB_ROTATE_LAST') || 'null');
        if (last && last.barcode) setRotStatus('직전: ' + last.barcode + ' → ' + rotShopName(last.shop) + ' 회전입고 실행됨', 'ok');
      } catch (_) {}
```

바로 뒤에 추가:

```js
      try {   // 서버가 회전입고를 거부하면 리다이렉트 URL msg 로 온다 → 그 문구 그대로 빨강(스펙 §4-1). '직전:' 보다 우선.
        const m = new URLSearchParams(location.search).get('msg') || '';
        if (m.trim()) { rotMsgShown = true; setRotStatus('회전입고 실패: ' + m.trim(), 'err'); }
      } catch (_) {}
```

- [ ] **Step 6: 통과 확인 + 문법**

Run: `node --test tests/rotate-flow.test.js`
Expected: `ℹ pass 16` / `ℹ fail 0`.
Run: `node -e "new Function(require('fs').readFileSync('src/skin.js','utf8'))"` → 출력 없음.
Run: `node --test tests/stock-recent.test.js tests/orderitem-assign.test.js` → 기존 통과 유지(보관함·팝업 코드는 손대지 않았다).

- [ ] **Step 7: 변이 확인(테스트가 그물인지)**

각각 스크래치 사본에서 걸고 `node --test tests/rotate-flow.test.js` 가 **정확히 그 테스트만** 실패하는지 본다: ① `if (isRotateWrite()) rotAfterRowFound(row, bc);` 제거 ② `if (isRotateWrite()) rotAfterRowMissing();` 제거 ③ `if (rotMsgShown) return;` 제거 ④ `rotNewBarcodeFromCells` 의 `tok === …oldBc…` 검사 제거 ⑤ `rotateRun` 의 `if (!step1.proceed)` 를 `if (false)` 로. 살아남는 변이가 있으면 테스트를 보강한 뒤 진행.

- [ ] **Step 8: 커밋**

```bash
git add src/skin.js tests/rotate-flow.test.js
git commit -m "feat(회전입고): 결과 화면에서 새 바코드를 읽어 재고화 보관함에 등록(본사확인 팝업 강조) · 상태줄에 서버 거부/행 발견/행 없음 구분 표시

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: 배포 준비 — 버전 4.2.1 · SHELL 인덱스 · 무결성

**Files:**
- Modify: `manifest.json`(version), `src/skin.js` 머리말 버전 주석(있으면), `shell-files.json`(재생성), `docs/superpowers/specs/2026-09-15-rotate-passthrough-newbarcode-design.md`(변경 없음 확인)

- [ ] **Step 1: 버전 상향**

`manifest.json` 의 `"version": "4.2.0"` → `"version": "4.2.1"`. `src/skin.js` 상단 변경 이력 주석에 한 줄 추가(형식은 기존 `v4.2.0 …` 줄과 같게):

```
 *  v4.2.1 — 회전입고: 본사반품확인 '가능한 상태가 아닙니다' 통과 · 결과 새바코드 → 재고화 보관함(본사확인 팝업 강조) · 상태줄 거부/발견/없음.
```

- [ ] **Step 2: 인덱스 재생성 + 무결성**

Run: `pwsh -NoProfile -File build-shell-index.ps1`
Expected: `shell-files.json v4.2.1: 18 files (LF-normalized text hashes)`
Run: `node --test tests/loader-integrity.test.js`
Expected: `ℹ pass 1` / `ℹ fail 0`
Run: `node --test tests/rotate-flow.test.js tests/stock-recent.test.js tests/orderitem-assign.test.js tests/orderimport-wiring.test.js`
Expected: 전부 fail 0.

- [ ] **Step 3: 커밋**

```bash
git add manifest.json src/skin.js shell-files.json
git commit -m "chore(shell): 4.2.1 — 회전입고 보강 인덱스 재생성

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: 검수(T2) → 배포 → 라이브 확인

**Files:**
- Create: `REVIEW-BRIEF.tmp.md`(검수 브리프, 병합 전 삭제)
- Modify: `docs/REVIEW-LEDGER.md`(회차 기록), `docs/superpowers/specs/…design.md`(라이브 확인 결과 1줄)

- [ ] **Step 1: 검수 브리프** — 대상 `git diff <Task1 직전 커밋>..HEAD -- src/skin.js tests/rotate-flow.test.js manifest.json`. 저장소 밖 사실(스펙 §3 실측: 표 구조·idx 토큰·서버 거부는 msg·사장님 확인 "본사반품확인 안 된 건은 회전입고가 거부됨")과 원장 「누적 판정」을 붙인다. 관점: ① 1단계 통과 문구가 진짜 하나뿐인가 ② 재고화·메인석 페이지 회귀 0 ③ 상태줄 우선순위 ④ 보관함 오염(잘못된 토큰 등록) 경로.
- [ ] **Step 2: GLM 1R**(`z-ai/glm-5.2`, `review "Read REVIEW-BRIEF.tmp.md …"`) → 지적을 코드로 재현해 채택/기각 → 수정 시 같은 모델 재검수(최대 3라운드).
- [ ] **Step 3: Opus 5**(`opus-reviewer`) → 판정 → 수정 시 재검수.
- [ ] **Step 4: 교차 1회**(`deepseek/deepseek-v4-pro`, 탐색 최소화 지시, CJK 통짜 스캔) → 판정.
- [ ] **Step 5: 원장 기록**(등급·근거·모델·라운드·비용·채택/기각) → `REVIEW-BRIEF.tmp.md` 삭제 → 커밋 → `git push origin main`.
- [ ] **Step 6: 라이브 확인**(사장님 실제 회전입고 1건, 이미 본사반품확인된 건이면 더 좋음): 사이드바 상태줄이 `… → 새바코드 XXXXXX · 본사확인 팝업 강조 등록` 을 띄우고, 주문전표 본사확인 팝업에서 그 바코드 행이 강조되는지. 결과를 스펙 §3 끝에 한 줄 기록.
