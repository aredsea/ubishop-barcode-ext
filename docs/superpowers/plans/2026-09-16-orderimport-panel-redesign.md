# 주문 가져오기 패널 리디자인 · 중복 경고 · 다크모드 제거 Implementation Plan

> **결과(2026-09-16)**: Task 1~4 완료 — main `1ec14be`(SHELL 4.2.4) 푸시. 사은품 0원(§5c)은 도중에 4.2.3 으로 먼저 배포. 검수 GLM 1R + Opus O1~O3(원장 #96~#101), 교차는 사장님 지시로 생략. 렌더는 하네스(`scratchpad/mock/harness.js`)로 확인. 라이브 화면 확인은 사장님 실제 xls 로.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 주문 가져오기 패널을 사이드바 디자인 언어(시안 #35C5F0·Pretendard·8/12px·SVG)로 통일하고, 파일 읽기/유비샵 조회/등록 세 단계의 진행을 스트립·스켈레톤·칩으로 보여주며, 장부와 주문번호·상품이 완전히 같은 주문장은 기본 체크 해제 + 경고로 사전 결정하게 한다. 확장 전체에서 다크모드를 걷어낸다.

**Architecture:** 순수 판정(`oiOrderSig`·`oiDupCheck`·`oiStepLabel`·`oiEnrichTotal`)은 `src/orderimport-core.js`, 표시·진행 상태(`S.phase`·`S.progress`)는 `src/orderimport.js`. 실행기·게이트·`data-*` 배선 문자열은 그대로. CSS 는 목업(`scratchpad/mock/oi-mock.html`, 사장님 확인)을 그대로 옮긴다. 다크모드는 `popup/*`·`src/skin.js` 에서 삭제.

**Tech Stack:** Chrome MV3 content script, node:test, 소스 추출 하네스, Playwright(headless Chrome channel)로 렌더 확인.

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-09-16-orderimport-panel-redesign.md` (§3 진행 모델·§4 스타일·§5 다크 제거·§5b 중복 경고가 정본).
- 기존 배선 테스트가 고정한 문자열은 유지: `data-act="run"' + (nChk && !S.running && !S.enriching && S.enabled ? '' : ' disabled')`, `data-f="pick" data-o="' + oi + '" data-l="' + li + '"' + dis + '>`, `data-act="unmap" … title="매핑 지우기"' + dis + '>`, `data-act="search" … ' + dis + '>`, `value="' + esc(v == null ? '' : v) + '"' + dis + '>'`, `data-act="mkt-apply" data-o="' + oi + '"' + dis + '>`, `id="ub-oi-mapfile" accept=".json" hidden' + (S.running ? ' disabled' : '') + '>`, `data-f="q" … value="' + esc(l.q || '') + '"' + dis + '>`, `'<td>' + prod + note + '</td><td>'`, onClick/onChange/enrich 게이트, `jobs = targets.map(toRunOrder)` 흐름.
- 이모지 0(SVG 만). 애니메이션은 transform/opacity 만, `prefers-reduced-motion` 존중. `transition: all` 금지.
- 다크모드 제거 후 `src/`·`popup/` 에 `ub-dark|ubDark` 0건.
- SHELL 4.2.2 → **4.2.3**. 검수 **T2**(GLM ≤3 + Opus 5 + 교차 1, Fable 없음). 커밋 메시지 한국어 + `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: core — 상품 서명·중복 판정·진행 문구·조회 총량 + 장부에 서명 저장

**Files:**
- Modify: `src/orderimport-core.js` (api 노출 `oiOrderSig, oiDupCheck, oiStepLabel, oiEnrichTotal`; `oiRunOrder` 의 `res` 에 `sig`; `oiPostRunState` 장부 항목에 `sig`)
- Test: `tests/orderimport-parse.test.js` (추가)

**Interfaces:**
- Produces: `oiOrderSig(order:{lines:[{productName,optionText,qty}]}) → string` · `oiDupCheck(order, entry) → {dup:boolean, kind:'none'|'same'|'diff'|'legacy', entry}` · `oiStepLabel(step, info, last) → string` · `oiEnrichTotal(orders, masters) → {masters, customers, suggests, total}` · 장부 항목 `{at, tradeJun, junNums, lines, sig, unverified?, reason?}`

- [x] **Step 1: 테스트(RED)** — `tests/orderimport-parse.test.js` 끝에:

```js
test('oiOrderSig: 상품명·옵션·수량으로 만든 서명은 순서·공백·대소문자와 무관하다', () => {
  const a = { lines: [{ productName: 'Silver925 퓨어 컷팅 반지', optionText: '[17호]', qty: 1 }, { productName: '[사은품] 박스', optionText: '', qty: 1 }] };
  const b = { lines: [{ productName: '[사은품]  박스 ', optionText: '', qty: 1 }, { productName: 'silver925 퓨어  컷팅 반지', optionText: ' [17호]', qty: 1 }] };
  assert.equal(C.oiOrderSig(a), C.oiOrderSig(b));
  assert.notEqual(C.oiOrderSig(a), C.oiOrderSig({ lines: [a.lines[0]] }), '줄이 빠지면 다른 서명');
  assert.notEqual(C.oiOrderSig(a), C.oiOrderSig({ lines: [Object.assign({}, a.lines[0], { qty: 2 }), a.lines[1]] }), '수량이 다르면 다른 서명');
  assert.equal(C.oiOrderSig({ lines: [] }), '');
});
test('oiDupCheck: 장부 없음/서명 같음/다름/옛 항목', () => {
  const o = { lines: [{ productName: 'A', optionText: '', qty: 1 }] };
  const sig = C.oiOrderSig(o);
  assert.deepStrictEqual(C.oiDupCheck(o, null), { dup: false, kind: 'none', entry: null });
  assert.equal(C.oiDupCheck(o, { at: 't', sig }).kind, 'same'); assert.equal(C.oiDupCheck(o, { at: 't', sig }).dup, true);
  assert.equal(C.oiDupCheck(o, { at: 't', sig: sig + 'x' }).kind, 'diff'); assert.equal(C.oiDupCheck(o, { at: 't', sig: sig + 'x' }).dup, false);
  assert.equal(C.oiDupCheck(o, { at: 't', lines: 1 }).kind, 'legacy'); assert.equal(C.oiDupCheck(o, { at: 't', lines: 1 }).dup, true);
});
test('oiPostRunState: 장부 항목에 상품 서명이 실린다(done·unverified 둘 다)', () => {
  const base = { key: 'K', status: 'done', reason: '', tradeJun: '1', orderSeqs: ['1'], junNums: [{ junNum: 'J' }], rolledBack: 0, sig: 'SIG' };
  assert.equal(C.oiPostRunState(base, 'now').ledgerEntry.sig, 'SIG');
  assert.equal(C.oiPostRunState(Object.assign({}, base, { status: 'fatal', completing: true, reason: 'complete_unverified:x' }), 'now').ledgerEntry.sig, 'SIG');
});
test('oiStepLabel: 실행기 log step → 사람 문구, 모르는 step 은 마지막 문구 유지', () => {
  assert.equal(C.oiStepLabel('guard', {}, ''), '세션 확인');
  assert.equal(C.oiStepLabel('register', {}, ''), '고객 등록');
  assert.equal(C.oiStepLabel('line', { i: 1, n: 2 }, ''), '줄 2/2 등록');
  assert.equal(C.oiStepLabel('complete', {}, ''), '주문장 완료 요청');
  assert.equal(C.oiStepLabel('rollback', {}, ''), '되돌리는 중');
  assert.equal(C.oiStepLabel('foreign_check_error', {}, '전표 조회'), '전표 조회');
});
test('oiEnrichTotal: 조회할 마스터·고객·추천 수를 센다', () => {
  const orders = [
    { market: { name: 'x' }, phone: { ok: true }, customer: null, lines: [{ mapping: { entry: { seq: '7' } }, suggest: null }, { mapping: null, suggest: null }] },
    { market: null, phone: { ok: true }, customer: null, lines: [{ mapping: { entry: { seq: '7' } }, suggest: null }] },
    { market: { name: 'y' }, phone: { ok: true }, customer: { mode: 'reuse' }, lines: [{ mapping: null, suggest: [] }] }
  ];
  assert.deepStrictEqual(C.oiEnrichTotal(orders, {}), { masters: 1, customers: 1, suggests: 1, total: 3 });
  assert.deepStrictEqual(C.oiEnrichTotal(orders, { 7: {} }), { masters: 0, customers: 1, suggests: 1, total: 2 });
});
```

- [x] **Step 2: 실패 확인** — `node --test tests/orderimport-parse.test.js` → `C.oiOrderSig is not a function` 류로 실패.

- [x] **Step 3: 구현** — `src/orderimport-core.js` `oiPostRunState` 앞에 추가:

```js
  //  주문장의 '상품 서명' — 줄마다 상품명|옵션|수량(공백 하나로·소문자)을 정렬해 잇는다. 장부 항목과 대조해 "완전히 같은 주문번호+상품" 을 가린다(스펙 §5b).
  function oiOrderSig(order) {
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
    return ((order && order.lines) || []).map((l) => norm(l.productName) + '|' + norm(l.optionText) + '|' + String(l.qty == null ? '' : l.qty)).sort().join('\n');
  }
  //  장부 항목과 대조. sig 가 있는 항목만 정확히 가리고, 옛 항목(sig 없음)은 보수적으로 중복으로 본다.
  function oiDupCheck(order, entry) {
    if (!entry) return { dup: false, kind: 'none', entry: null };
    if (!entry.sig) return { dup: true, kind: 'legacy', entry };
    return entry.sig === oiOrderSig(order) ? { dup: true, kind: 'same', entry } : { dup: false, kind: 'diff', entry };
  }
  //  실행기 log(step) → 진행 스트립 문구. 모르는 step 은 마지막 문구를 유지한다.
  const OI_STEP_LABEL = { guard: '세션 확인', client: '고객 확인', register: '고객 등록', complete: '주문장 완료 요청', junnum: '전표 조회', rollback: '되돌리는 중', fail: '되돌리는 중' };
  function oiStepLabel(step, info, last) {
    if (step === 'line') { const i = Number(info && info.i), n = Number(info && info.n); return '줄 ' + (isFinite(i) ? i + 1 : '?') + (isFinite(n) && n > 0 ? '/' + n : '') + ' 등록'; }
    return OI_STEP_LABEL[step] || last || '';
  }
  //  enrich 가 보낼 요청 수(진행 바 분모).
  function oiEnrichTotal(orders, masters) {
    const seqs = new Set();
    (orders || []).forEach((o) => (o.lines || []).forEach((l) => { if (l.mapping && !(masters || {})[l.mapping.entry.seq]) seqs.add(String(l.mapping.entry.seq)); }));
    const customers = (orders || []).filter((o) => !o.customer && o.market && o.phone && o.phone.ok).length;
    const suggests = (orders || []).reduce((n, o) => n + (o.lines || []).filter((l) => !l.mapping && !l.suggest).length, 0);
    return { masters: seqs.size, customers, suggests, total: seqs.size + customers + suggests };
  }
```

`oiRunOrder` 의 `res` 초기화에 `sig: order.sig || ''` 추가. `oiPostRunState` 의 두 `ledgerEntry` 에 `sig: r.sig || ''` 추가. `log('line', …)` 호출에 `n: order.lines.length` 가 있는지 확인하고 없으면 추가. api 객체에 `oiOrderSig, oiDupCheck, oiStepLabel, oiEnrichTotal` 노출.

- [x] **Step 4: 통과** — `node --test tests/orderimport-*.test.js` 전부 fail 0.
- [x] **Step 5: 커밋** — `feat(주문 가져오기): core — 상품 서명·중복 판정·진행 문구·조회 총량, 장부에 서명 저장`

---

### Task 2: 다크모드 제거 (popup + skin)

**Files:** `popup/popup.html`(다크 행·"디자인" 그룹 제목), `popup/popup.js`(ubDark 5곳), `src/skin.js`(머리말 5행·DEFAULTS·DARK_STYLE_ID/DARK_CSS/ensureDarkStyle/applyDark·init 의 `applyDark()`·사이드바 `html.ub-dark .ub-sidebar` 블록·라이브필터 dark 규칙 6줄+주석·HQ 앵커 dark 규칙) · Test: `tests/no-darkmode.test.js`(신규)

- [x] **Step 1: 테스트(RED)**:

```js
const test = require('node:test'); const assert = require('node:assert'); const fs = require('node:fs'); const path = require('node:path');
const ROOT = path.join(__dirname, '..');
test('다크모드는 걷어냈다 — src/·popup/ 에 ub-dark/ubDark 0건, 팝업에 다크 스위치 없음 (사장님 지시 2026-09-16)', () => {
  const files = ['src/skin.js', 'src/orderimport.js', 'src/content.js', 'src/statis.js', 'src/loader.js', 'src/background.js', 'popup/popup.html', 'popup/popup.js'];
  for (const f of files) { const t = fs.readFileSync(path.join(ROOT, f), 'utf8'); assert.equal((t.match(/ub-dark|ubDark/g) || []).length, 0, f + ' 에 다크모드 잔재'); }
  assert.ok(!/id="dark"/.test(fs.readFileSync(path.join(ROOT, 'popup/popup.html'), 'utf8')));
  assert.ok(!/applyDark|DARK_CSS|ensureDarkStyle/.test(fs.readFileSync(path.join(ROOT, 'src/skin.js'), 'utf8')));
});
```

- [x] **Step 2: 제거** — 스펙 §5 표대로 삭제. `popup.js` 의 `[dark, autoSync, …].forEach` 목록에서 `dark` 만 뺀다. 라이브필터 CSS 배열의 dark 줄 6개와 그 위 `// ── 다크모드 🔴` 주석 제거; `html.ub-dark a.${HQ_STANDBY_CLS}` 셀렉터는 그 규칙에서 지우고 라이트 셀렉터만 남긴다.
- [x] **Step 3: 통과** — `node --test tests/no-darkmode.test.js tests/phase5-switch-ui.test.js tests/orderitem-c.test.js tests/orderitem-c2a.test.js tests/orderitem-c2b.test.js tests/orderitem-assign.test.js tests/stock-recent.test.js tests/rotate-flow.test.js` fail 0. `node -e "new Function(require('fs').readFileSync('src/skin.js','utf8'))"` 통과.
- [x] **Step 4: 커밋** — `refactor(다크모드 제거): 팝업 스위치·페이지 강제 다크 CSS·사이드바/라이브필터/본사확인 dark 규칙 삭제`

---

### Task 3: 패널 UI — CSS·마크업·진행 상태·중복 경고

**Files:** `src/orderimport.js`(CSS 상수, `S` 에 `phase/progress`, `refreshOrder`, `render/orderRow/lineRow/custText/marketPick`, `openPanel`, `loadFile`, `enrich/enrichBody`, `runTargets`, `run` 확인창, `onChange` chk/chkall, `toRunOrder`) · Test: `tests/orderimport-wiring.test.js`(추가)

**Interfaces:** Consumes Task 1 의 `C.oiOrderSig/oiDupCheck/oiStepLabel/oiEnrichTotal`.

- [x] **Step 1: 테스트(RED)** — `tests/orderimport-wiring.test.js` 에:

```js
test('패널 리디자인: 폼 컨트롤 font inherit · 이모지 0 · reduced-motion · 진행 스트립 · 중복 기본 해제/전체 체크 제외/확인창 경고', () => {
  const ui = read('src/orderimport.js');
  const css = ui.slice(ui.indexOf('const CSS = `'), ui.indexOf('`;', ui.indexOf('const CSS = `')));
  assert.ok(/#\$\{PANEL_ID\} input,#\$\{PANEL_ID\} select,#\$\{PANEL_ID\} button,#\$\{PANEL_ID\} label\{font:inherit/.test(css), 'font: inherit');
  assert.ok(/--ub-on:#35C5F0/.test(css) && /@keyframes oiSpin/.test(css) && /@media \(prefers-reduced-motion: reduce\)/.test(css));
  assert.ok(!/transition:all/.test(css), 'transition: all 금지');
  assert.equal((ui.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{23F3}]/gu) || []).length, 0, '이모지 0');
  assert.ok(/function progStrip\(\)/.test(ui) && /S\.phase === 'reading'/.test(ui) && /S\.phase === 'enriching'/.test(ui) && /S\.phase === 'running'/.test(ui), '진행 스트립 3단계');
  assert.ok(/role="status" aria-live="polite"/.test(ui));
  assert.ok(/o\.dup = C\.oiDupCheck\(o, o\.prev\);/.test(ui) && /if \(o\.checked == null\) o\.checked = o\.ready && !o\.dup\.dup;/.test(ui), '중복은 기본 체크 해제');
  assert.ok(/o\.checked = el\.checked && o\.ready && !o\.dup\.dup;/.test(ui), '전체 체크는 중복을 건너뛴다');
  assert.ok(/이미 등록된 것과 같은 주문장 ' \+ nDup \+ '개가 포함돼 있습니다/.test(ui), '확인창 경고');
  assert.ok(/sig: C\.oiOrderSig\(o\)/.test(ui), 'toRunOrder 가 서명을 싣는다');
});
```

- [x] **Step 2: 구현** — 목업 CSS 를 `CSS` 상수로(셀렉터 `#${PANEL_ID}`), 마크업을 목업 구조로(`oi-h`·`oi-steps`·`oi-bar`·`oi-prog`·`oi-t` colgroup·`oi-chip`·`oi-skel`·SVG `<symbol>` 은 패널 루트에 한 번). `S.phase`·`S.progress` 갱신: `loadFile`(reading) · `enrich`(enriching, `oiEnrichTotal` 로 total, 요청마다 done++ 후 300ms 스로틀 `render`) · `runTargets`(running; `log` 훅에서 `S.progress.label = C.oiStepLabel(step, info, S.progress.label)` + 스트립 텍스트만 갱신; `onOrder` 마다 done++). `refreshOrder` 에 `o.dup`. chkall 은 `!o.dup.dup`. `run()` 확인창에 `nDup`. `custText` 를 칩으로, `orderRow` 에 중복 칩·등록 중/완료 칩, 표 위 중복 배너.
- [x] **Step 3: 통과** — `node --test tests/orderimport-*.test.js` fail 0 (기존 문자열 고정 테스트 포함). `node -e "new Function(require('fs').readFileSync('src/orderimport.js','utf8'))"`.
- [x] **Step 4: 렌더 확인** — 4.2.3 로컬 복사(트레이 앱은 사장님 허락 후 정지) 또는 배포 후, 실제 xls 로 패널을 열어 1920·1366 폭 스크린샷(조회 중·검토·등록 중). 어긋난 것은 여기서 고친다.
- [x] **Step 5: 커밋** — `feat(주문 가져오기): 패널 리디자인 — 사이드바 토큰·진행 스트립·스켈레톤·칩·중복 주문장 사전 경고`

---

### Task 4: 4.2.3 배포 준비 · T2 검수 · 배포

- [x] `manifest.json` 4.2.3 → `pwsh -NoProfile -File build-shell-index.ps1` → `node --test tests/loader-integrity.test.js`.
- [x] 브리프(`REVIEW-BRIEF.tmp.md`: 대상 diff, 저장소 밖 사실 — 게이트 계약·장부 로컬성·사장님 결정, 원장 누적 판정) → GLM 1R(≤3) → Opus 5 → DeepSeek 교차 → 채택 0.
- [x] 원장 기록 → 브리프 삭제 → main ff 병합 → push → 라이브 확인 스크린샷을 사장님께.
