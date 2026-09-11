# 주문 전표 일괄취소 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 주문 전표 목록에 [일괄취소] 버튼을 넣어, 체크한 주문완료(O--) 건을 순서대로 네이티브 [취소]+확인과 같은 GET 쓰기로 주문취소(OC-)로 만들고 재조회로 판정한다.

**Architecture:** `src/skin.js`(SHELL, ISOLATED world content script) §5.10 작업C의 배관(`fetchOrderRow`·`cFetchSKey`·`cReadSearchFields`·`cReadCheckedRows`·`cUpdateRow`·`ensureHqStyle`·`cBatchBusy`)을 재사용하고, 취소 고유의 순수 판정부(`cc*`)와 루프·승인창·버튼만 §5.11로 추가한다. 스펙: `docs/superpowers/specs/2026-09-11-orderitem-bulk-cancel-design.md`.

**Tech Stack:** Vanilla JS(MV3 content script, `fetch(credentials:'include')`), `node --test`(순수 함수는 skin.js 소스에서 extractFn 으로 추출해 평가), PowerShell(`build-shell-index.ps1`).

## Global Constraints

- 취소 가능 상태는 **정확히 `O--`** 하나. 상태 판정은 canonical code EXACT match(prefix·괄호 절단 금지).
- 쓰기는 `GET /jun/orderitem/orderItemCancel.do?tcode=order_item&seq=<orderSeq>&sKey=<sKey>&reqPage=1&<ASG_SEARCH_FIELDS>` 하나. **GET 자체가 쓰기라 조회 목적으로 절대 부르지 않는다.** 테스트는 URL 문자열만 본다.
- `sKey` 는 건마다 `cFetchSKey()` 로 새로 받는다. 재사용 금지.
- 순차 처리, 첫 실패·미확정에서 중단. dispatch 후 non-success 는 자동 재시도 금지.
- 게이트 `state.ubSkin && state.ubHqConfirm`(작업C 와 공유). `cBatchBusy` 공유(두 배치 상호 배타).
- 버튼 id `ub-cancel-btn`, 라벨 `일괄취소`, 빨간 outline. 승인창 제목 `일괄취소 — 사전검증`, 경고 `취소된 주문서는 복구되지 않습니다.`, 진행 버튼 `취소 진행`.
- 팝업 스위치 라벨 `주문전표 일괄 처리`, 설명 `⚠ 본사확인+입고완료 · 일괄취소 버튼을 켭니다. 실제로 서버에 씁니다(되돌리려면 수동)`. 키 `ubHqConfirm` 유지.
- manifest `4.1.8 → 4.1.9`. 껍데기 배포 = `pwsh build-shell-index.ps1` → `node tests/loader-integrity.test.js` → push.
- `src/skin.js` 는 **LF** 로 유지한다(`core.autocrlf=true` 라 checkout 이 CRLF 로 쓰면 `factory-live-search.test.js` 변이 검사가 깨진다 — 2026-09-11 실측).
- 이 파일을 PowerShell `Set-Content` 로 편집하지 않는다(한글 깨짐). Write/Edit 도구 또는 python 으로만.

---

### Task 1: 순수 판정부 `cc*` + 단위테스트

**Files:**
- Modify: `src/skin.js` — `injectHqConfirmButton()` 정의 직후, `function init()` 직전에 §5.11 블록 삽입
- Test: `tests/orderitem-cancel.test.js`

**Interfaces:**
- Produces: `ccTargetStatus(code) → boolean` · `ccClassifyChecked(rows) → {targets, excluded:[{orderSeq,code,reason}], duplicate}` · `ccBuildCancelUrl(orderSeq, sKey, searchFields) → string|null` · `ccRedirectMsg(url) → string` · `ccClassifyOutcome({dispatched, requery}) → 'fail'|'success'|'uncertain'`

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/orderitem-cancel.test.js`

```js
/* =============================================================================
 *  orderitem-cancel.test.js — 주문전표 일괄취소 순수 판정부 단위테스트.
 *  skin.js 는 content script IIFE 라 require 할 수 없다 → 소스에서 DOM 비의존 함수 선언만
 *  이름으로 추출해 샌드박스에서 평가한다(orderitem-c.test.js 와 동일. 리네임하면 즉사).
 *  ⚠ 이 파일을 PowerShell 로 편집하지 마라 — Set-Content 가 한글을 깨뜨린다.
 *  스펙: docs/superpowers/specs/2026-09-11-orderitem-bulk-cancel-design.md §4.2·§4.4·§4.5
 *  실행: node --test tests/orderitem-cancel.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'skin.js'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'skin.js 에서 ' + name + ' 선언을 찾지 못했습니다 (리네임 여부 확인)');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(name + ' 본문의 중괄호 균형을 찾지 못했습니다');
}

const NAMES = ['ccTargetStatus', 'ccClassifyChecked', 'ccBuildCancelUrl', 'ccRedirectMsg', 'ccClassifyOutcome'];
const sandbox = {};
// eslint-disable-next-line no-new-func
new Function('exports',
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => 'exports.' + n + ' = ' + n + ';').join('\n')
)(sandbox);
const { ccTargetStatus, ccClassifyChecked, ccBuildCancelUrl, ccRedirectMsg, ccClassifyOutcome } = sandbox;

// ── ccTargetStatus ───────────────────────────────────────────────────────────
test('ccTargetStatus: 정확히 O-- 만 true', () => {
  assert.equal(ccTargetStatus('O--'), true);
});
test('ccTargetStatus: OS-/OC-/B--/I-- 등은 false (본사확인도 취소 대상이 아니다)', () => {
  for (const c of ['OS-', 'OC-', 'B--', 'I--', 'T--', 'TS-', 'TE-', 'S--']) assert.equal(ccTargetStatus(c), false, c);
});
test('ccTargetStatus: null/undefined/빈값/prefix/소문자/공백 전부 false (EXACT)', () => {
  for (const c of [null, undefined, '', 'O', 'O-', 'O---', 'o--', ' O--', 'O-- ', 'OS', 0, {}]) assert.equal(ccTargetStatus(c), false, String(c));
});

// ── ccClassifyChecked ────────────────────────────────────────────────────────
test('ccClassifyChecked: O-- 는 targets(원본 객체 그대로, 순서 보존), 나머지는 excluded', () => {
  const rows = [
    { orderSeq: '1', code: 'O--', orderDate: '20260911' },
    { orderSeq: '2', code: 'OS-', orderDate: '20260911' },
    { orderSeq: '3', code: 'O--', orderDate: '20260910' }
  ];
  const r = ccClassifyChecked(rows);
  assert.deepEqual(r.targets, [rows[0], rows[2]]);
  assert.equal(r.targets[0], rows[0]);
  assert.equal(r.excluded.length, 1);
  assert.equal(r.duplicate, false);
});
test('ccClassifyChecked: 제외 사유 매핑', () => {
  const r = ccClassifyChecked([
    { orderSeq: 'a', code: 'OS-' }, { orderSeq: 'b', code: 'OC-' }, { orderSeq: 'c', code: 'B--' },
    { orderSeq: 'd', code: 'I--' }, { orderSeq: 'e', code: 'T--' }, { orderSeq: 'f', code: 'TS-' },
    { orderSeq: 'g', code: 'TE-' }, { orderSeq: 'h', code: 'S--' }, { orderSeq: 'i', code: null },
    { orderSeq: 'j', code: 'ZZZ' }
  ]);
  const by = Object.fromEntries(r.excluded.map(x => [x.orderSeq, x.reason]));
  assert.equal(by.a, '본사확인 상태 — [본사확인취소] 후 다시');
  assert.equal(by.b, '이미 취소됨');
  assert.equal(by.c, '취소 불가 상태(발주완료)');
  assert.equal(by.d, '취소 불가 상태(입고완료)');
  assert.equal(by.e, '취소 불가 상태(출고완료)');
  assert.equal(by.f, '취소 불가 상태(출고확인)');
  assert.equal(by.g, '취소 불가 상태(출고오확인)');
  assert.equal(by.h, '취소 불가 상태(판매완료)');
  assert.equal(by.i, '상태 불명');
  assert.equal(by.j, '상태 불명');
  assert.equal(r.excluded.find(x => x.orderSeq === 'a').code, 'OS-');
  assert.equal(r.targets.length, 0);
});
test('ccClassifyChecked: 같은 orderSeq 둘 이상 → duplicate=true (합치지 않는다)', () => {
  const r = ccClassifyChecked([{ orderSeq: '7', code: 'O--' }, { orderSeq: '7', code: 'O--' }]);
  assert.equal(r.duplicate, true);
  assert.equal(r.targets.length, 2);
});
test('ccClassifyChecked: 빈 입력·비배열은 빈 결과', () => {
  assert.deepEqual(ccClassifyChecked([]), { targets: [], excluded: [], duplicate: false });
  assert.deepEqual(ccClassifyChecked(null), { targets: [], excluded: [], duplicate: false });
});

// ── ccBuildCancelUrl ─────────────────────────────────────────────────────────
test('ccBuildCancelUrl: 네이티브 del() 과 같은 모양 — tcode·seq·sKey + 검색조건', () => {
  const u = ccBuildCancelUrl('12345', '260911135039701', { reqPage: '1', pageSize: '100', searchShop: '' });
  assert.ok(u.startsWith('/jun/orderitem/orderItemCancel.do?'), u);
  const p = new URL('http://x' + u).searchParams;
  assert.equal(p.get('tcode'), 'order_item');
  assert.equal(p.get('seq'), '12345');
  assert.equal(p.get('sKey'), '260911135039701');
  assert.equal(p.get('reqPage'), '1');
  assert.equal(p.get('pageSize'), '100');
  assert.equal(p.get('searchShop'), '');
});
test('ccBuildCancelUrl: seq 또는 sKey 가 비면 null (빈 값이 쓰기로 흘러가지 않는다)', () => {
  assert.equal(ccBuildCancelUrl('', 'k', {}), null);
  assert.equal(ccBuildCancelUrl('1', '', {}), null);
  assert.equal(ccBuildCancelUrl(null, 'k', {}), null);
  assert.equal(ccBuildCancelUrl('1', null, {}), null);
  assert.equal(ccBuildCancelUrl('  ', 'k', {}), null);
});
test('ccBuildCancelUrl: 검색조건이 고정 키(tcode/seq/sKey)를 덮지 못한다', () => {
  const u = ccBuildCancelUrl('1', 'k', { tcode: 'evil', seq: '999', sKey: 'zzz', searchWord1: '가나' });
  const p = new URL('http://x' + u).searchParams;
  assert.equal(p.get('tcode'), 'order_item');
  assert.equal(p.get('seq'), '1');
  assert.equal(p.get('sKey'), 'k');
  assert.equal(p.get('searchWord1'), '가나');
});
test('ccBuildCancelUrl: searchFields 없이도 동작, 숫자 seq 도 문자열로', () => {
  const u = ccBuildCancelUrl(42, 'k');
  assert.equal(new URL('http://x' + u).searchParams.get('seq'), '42');
});

// ── ccRedirectMsg ────────────────────────────────────────────────────────────
test('ccRedirectMsg: msg 있으면 trim 해서 반환', () => {
  assert.equal(ccRedirectMsg('http://h/jun/orderitem/orderItemList.do?tcode=order_item&msg=%20취소%20가능한%20상태가%20아닙니다%20'), '취소 가능한 상태가 아닙니다');
});
test('ccRedirectMsg: msg 없음·빈값·null·깨진 입력은 빈 문자열', () => {
  assert.equal(ccRedirectMsg('http://h/a.do?tcode=order_item'), '');
  assert.equal(ccRedirectMsg('http://h/a.do?msg='), '');
  assert.equal(ccRedirectMsg(null), '');
  assert.equal(ccRedirectMsg(''), '');
  assert.equal(ccRedirectMsg('::not a url::'), '');
});

// ── ccClassifyOutcome ────────────────────────────────────────────────────────
test('ccClassifyOutcome: dispatch 전은 fail (쓰기 없었음)', () => {
  assert.equal(ccClassifyOutcome({ dispatched: false, requery: { found: true, code: 'OC-' } }), 'fail');
  assert.equal(ccClassifyOutcome(null), 'fail');
  assert.equal(ccClassifyOutcome({}), 'fail');
});
test('ccClassifyOutcome: dispatch 후 재조회 found && OC- 만 success', () => {
  assert.equal(ccClassifyOutcome({ dispatched: true, requery: { found: true, code: 'OC-' } }), 'success');
});
test('ccClassifyOutcome: dispatch 후 그 외는 전부 uncertain (fail 아님 — 재시도 금지 신호)', () => {
  assert.equal(ccClassifyOutcome({ dispatched: true, requery: { found: true, code: 'O--' } }), 'uncertain');
  assert.equal(ccClassifyOutcome({ dispatched: true, requery: { found: true, code: 'OS-' } }), 'uncertain');
  assert.equal(ccClassifyOutcome({ dispatched: true, requery: { found: false, code: null } }), 'uncertain');
  assert.equal(ccClassifyOutcome({ dispatched: true, requery: null }), 'uncertain');
  assert.equal(ccClassifyOutcome({ dispatched: true }), 'uncertain');
});
```

- [ ] **Step 2: 실패 확인** — `node --test tests/orderitem-cancel.test.js` → `skin.js 에서 ccTargetStatus 선언을 찾지 못했습니다` 로 전부 실패.

- [ ] **Step 3: 순수 판정부 구현** — `src/skin.js` 의 `injectHqConfirmButton` 정의 끝(`}` 다음 빈 줄) 뒤, `function init() {` 앞에 삽입:

```js
  /* ==========================================================================
   *  5.11) 일괄취소 — 체크한 주문완료(O--) 건을 순서대로 주문취소(OC-)
   *   스펙: docs/superpowers/specs/2026-09-11-orderitem-bulk-cancel-design.md
   *   네이티브 [취소] = del(seq): confirm → GET orderItemCancel.do?tcode=order_item&seq=&sKey=&<검색조건>
   *   (⚠ GET 자체가 쓰기 — 조회 목적으로 절대 부르지 않는다. 라이브 실측 2026-09-11: [취소] 링크는
   *   주문완료 행에만 있다 → 취소 가능 상태는 O-- 하나뿐.)
   *   작업C(§5.10)의 배관을 그대로 쓴다: 재조회 fetchOrderRow · sKey cFetchSKey · 검색조건
   *   cReadSearchFields · 체크 행 cReadCheckedRows · 행 교체 cUpdateRow · 승인창 CSS ensureHqStyle ·
   *   busy 플래그 cBatchBusy(본사확인+입고완료와 상호 배타).
   *   게이트: state.ubSkin && state.ubHqConfirm(작업C 와 공유). 순차 처리, 첫 실패·미확정에서 중단,
   *   dispatch 후 non-success 는 자동 재시도 금지(작업C §3.6 과 동일 — 반영 지연·남이 덮음·타임아웃이
   *   모두 같은 모습이다).
   * ========================================================================== */
  const CC_TAG = '[UB][bulkcancel]';
  const ccLog = (...a) => { try { console.log(CC_TAG, ...a); } catch (_) {} };
  const CC_BTN_ID = 'ub-cancel-btn';
  const CC_STYLE_ID = 'ub-cc-style';
  const CC_MODAL_ID = 'ub-cc-modal';
  const CC_CSS = `
    /* 일괄취소 — 되돌릴 수 없는 동작이라 primary(파랑)가 아니라 빨간 outline 으로 구분 */
    #${CC_BTN_ID} { display: inline-block; margin-left: 6px; padding: 4px 12px; border-radius: 8px;
      font-family: 'Pretendard','Malgun Gothic',sans-serif; font-size: 12.5px; font-weight: 700;
      line-height: 1.5; text-align: center; vertical-align: middle; white-space: nowrap;
      box-sizing: border-box; cursor: pointer;
      border: 1px solid #f0b4b4; background: #fff; color: #b42318; }
    #${CC_BTN_ID}:hover { background: #fff3f3; border-color: #b42318; }
    .ub-cc-go { background: #b42318; color: #fff; }
    .ub-cc-go:disabled { background: #e7a4a4; cursor: default; }
  `;
  // ── 일괄취소 순수 판정부 — DOM·네트워크·chrome.*·타이머 미접촉. tests/orderitem-cancel.test.js ──
  //  취소 가능 상태 = 정확히 주문완료(O--) 하나뿐. EXACT, prefix 아님(cTargetStatus 와 같은 규율).
  function ccTargetStatus(code) {
    return code === 'O--';
  }
  //  체크된 행 → 대상/제외. excluded 는 {orderSeq, code, reason}. 같은 orderSeq 둘 이상이면
  //  duplicate=true — 조용히 합치지 않고 호출부가 중단한다(cClassifyChecked 와 같은 규약).
  function ccClassifyChecked(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const REASON = new Map([
      ['OS-', '본사확인 상태 — [본사확인취소] 후 다시'], ['OC-', '이미 취소됨'],
      ['B--', '취소 불가 상태(발주완료)'], ['I--', '취소 불가 상태(입고완료)'],
      ['T--', '취소 불가 상태(출고완료)'], ['TS-', '취소 불가 상태(출고확인)'],
      ['TE-', '취소 불가 상태(출고오확인)'], ['S--', '취소 불가 상태(판매완료)']
    ]);
    const seen = new Set();
    let duplicate = false;
    for (const r of list) {
      const key = String(r && r.orderSeq != null ? r.orderSeq : '');
      if (seen.has(key)) duplicate = true; else seen.add(key);
    }
    const targets = [];
    const excluded = [];
    for (const r of list) {
      const code = r ? r.code : undefined;
      if (ccTargetStatus(code)) { targets.push(r); continue; }
      excluded.push({ orderSeq: r ? r.orderSeq : undefined, code: code,
                      reason: REASON.get(code) || '상태 불명' });
    }
    return { targets: targets, excluded: excluded, duplicate: duplicate };
  }
  //  취소 URL — 네이티브 del(seq) 가 만드는 것과 같은 모양(tcode·seq·sKey + CONST_URL 검색조건).
  //  seq·sKey 가 비면 null(빈 값이 쓰기로 흘러가지 않게). 고정 키는 searchFields 가 덮지 못한다.
  //  ⚠⚠ 이 URL 의 GET 이 쓰기다 — 조회 목적으로 부르지 마라.
  function ccBuildCancelUrl(orderSeq, sKey, searchFields) {
    const seq = String(orderSeq == null ? '' : orderSeq).trim();
    const key = String(sKey == null ? '' : sKey).trim();
    if (!seq || !key) return null;
    const p = new URLSearchParams();
    p.set('tcode', 'order_item');
    p.set('seq', seq);
    p.set('sKey', key);
    if (searchFields) {
      const keys = Object.keys(searchFields);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!p.has(k)) p.set(k, String(searchFields[k] == null ? '' : searchFields[k]));
      }
    }
    return '/jun/orderitem/orderItemCancel.do?' + p.toString();
  }
  //  리다이렉트 도착 URL 의 msg(서버 거부 문구, 실패일 때만 실린다 — memory 함정2). 없거나 깨지면 ''.
  //  표시용이다 — 판정 근거가 아니다(이 ERP 의 응답 문구 스캔은 오탐 전례가 있다).
  function ccRedirectMsg(url) {
    try {
      const m = new URL(String(url == null ? '' : url), 'http://localhost').searchParams.get('msg');
      return m ? String(m).trim() : '';
    } catch (_) { return ''; }
  }
  //  dispatch 후 판정 3분기(cClassifyOutcome 과 같은 규약). dispatch 전 = 'fail'(쓰기 없었음, 안전).
  //  dispatch 후 재조회가 found && OC- 면 'success', 그 외(이전 상태·다른 상태·재조회 실패·null)는 전부
  //  'uncertain' — 절대 'fail' 아니고 자동 재시도 금지 신호다.
  function ccClassifyOutcome(input) {
    if (!input || input.dispatched !== true) return 'fail';
    const q = input.requery;
    if (q && q.found === true && q.code === 'OC-') return 'success';
    return 'uncertain';
  }
```

- [ ] **Step 4: 통과 확인** — `node --test tests/orderitem-cancel.test.js` → 전부 pass. `node --check src/skin.js` 도 통과.

- [ ] **Step 5: 커밋**

```bash
git add src/skin.js tests/orderitem-cancel.test.js
git commit -m "feat(주문전표): 일괄취소 순수 판정부(cc*) + 단위테스트"
```

---

### Task 2: 실행부 — 취소 GET·건별 루프·승인창·버튼·배선

**Files:**
- Modify: `src/skin.js` — Task 1 블록 바로 아래(같은 §5.11 안), `init()`의 `injectHqConfirmButton();` 다음 줄, `chrome.storage.onChanged` 핸들러의 `injectHqConfirmButton();` 다음 줄

**Interfaces:**
- Consumes: Task 1 의 `cc*` · 작업C 의 `fetchOrderRow(orderSeq, orderDate)`(→ `{found, code, text, rowHtml, loginExpired, duplicate, hasMore}`) · `cFetchSKey()`(→ string|null) · `cReadSearchFields()` · `cReadCheckedRows()`(→ `[{orderSeq, code, orderDate}]`) · `cUpdateRow(orderSeq, row)` · `ensureHqStyle()` · `cBatchBusy` · `ASG_FETCH_MS`/`ASG_VERIFY_MS` · `isOrderJunList()` · `state`
- Produces: `injectBulkCancelButton()`(idempotent, init·onChanged 에서 호출)

- [ ] **Step 1: 실행부 작성** — Task 1 의 `ccClassifyOutcome` 뒤에 이어 붙인다:

```js
  // ── 일괄취소 실행부 (DOM·네트워크) ──────────────────────────────────────
  function ensureCcStyle() {
    ensureHqStyle();                                   // 승인창 공용 CSS(.ub-hq-*)
    if (document.getElementById(CC_STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = CC_STYLE_ID; s.textContent = CC_CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  //  취소 GET(쓰기). 반환 {dispatched, msg}. URL 을 못 만들면 dispatched=false(쓰기 없었음 = 확정 실패).
  //  요청을 보낸 뒤의 네트워크 오류·타임아웃은 서버에 닿았는지 알 수 없으므로 dispatched=true 로 두고
  //  호출부가 재조회로만 판정한다(자동 재시도 금지). msg 는 리다이렉트 URL 의 서버 문구(표시용).
  async function ccDoCancel(orderSeq, sKey, searchFields) {
    const url = ccBuildCancelUrl(orderSeq, sKey, searchFields);
    if (!url) return { dispatched: false, msg: 'URL 조립 실패(seq/sKey 없음)' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, ASG_FETCH_MS);
    try {
      const r = await fetch(url, { method: 'GET', credentials: 'include', cache: 'no-cache', signal: ctrl.signal });
      return { dispatched: true, msg: ccRedirectMsg(r.url) };
    } catch (e) {
      ccLog('취소 GET 오류(도달 여부 불명)', (e && e.message) || e);
      return { dispatched: true, msg: '' };
    } finally { clearTimeout(timer); }
  }
  //  배치 오케스트레이터. 순차, 첫 실패·미확정에서 중단. progress(msg)=승인창 진행 표시,
  //  isAborted()=사용자 중단 요청(다음 건 경계에서 멈춤). cBatchBusy 는 작업C 와 공유한다.
  async function ccRunCancelBatch(targets, progress, isAborted) {
    const results = { success: 0, failed: [], uncertain: [], processed: 0, total: targets.length };
    if (cBatchBusy) return results;
    cBatchBusy = true;
    try {
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const orderSeq = t.orderSeq;
        const tag = (i + 1) + '/' + targets.length + ' · ' + orderSeq + ' · ';
        if (!(state.ubSkin && state.ubHqConfirm)) { ccLog('게이트 해제 → 중단'); break; }
        if (isAborted && isAborted()) { ccLog('사용자 중단 요청 → 중단'); break; }
        results.processed++;
        const orderDate = t.orderDate || '';
        if (!orderDate) { results.failed.push({ orderSeq: orderSeq, reason: '주문일 파싱 실패' }); break; }
        // 1) 쓰기 직전 재조회 — 승인창의 상태는 승인용이지 쓰기 근거가 아니다
        progress(tag + '상태 확인');
        const row = await fetchOrderRow(orderSeq, orderDate);
        if (!row.found) {
          results.failed.push({ orderSeq: orderSeq, reason:
            row.loginExpired ? '로그인 만료' :
            row.duplicate ? '중복 orderSeq(재조회)' :
            row.hasMore ? '재조회 실패(결과 잘림 — 조건을 좁혀라)' : '재조회 실패(행 없음)' });
          break;
        }
        // 2) 정확히 주문완료(O--) 만 — 그 사이 남이 취소·본사확인한 건도 여기서 걸린다
        if (!ccTargetStatus(row.code)) {
          results.failed.push({ orderSeq: orderSeq, reason: '상태 부적합: ' + (row.text || row.code || '불명') });
          cUpdateRow(orderSeq, row);                   // 화면을 서버 진실로
          break;
        }
        // 3) sKey — 건마다 새로
        progress(tag + '취소 처리');
        const sKey = await cFetchSKey();
        if (!sKey) { results.failed.push({ orderSeq: orderSeq, reason: 'sKey 추출 실패' }); break; }
        // 4) 취소 GET(⚠ 쓰기) — dispatch
        const d = await ccDoCancel(orderSeq, sKey, cReadSearchFields());
        if (!d.dispatched) { results.failed.push({ orderSeq: orderSeq, reason: d.msg }); break; }
        // 5) 재조회로만 판정 — OC- 가 보일 때까지 최대 ASG_VERIFY_MS
        progress(tag + '확인');
        let vRow = null;
        const dl = Date.now() + ASG_VERIFY_MS;
        while (Date.now() < dl) {
          vRow = await fetchOrderRow(orderSeq, orderDate);
          if (vRow && vRow.found && vRow.code === 'OC-') break;
          await new Promise(function (r) { setTimeout(r, 1500); });
        }
        const outcome = ccClassifyOutcome({ dispatched: true, requery: vRow });
        if (outcome === 'success') { results.success++; cUpdateRow(orderSeq, vRow); continue; }
        results.uncertain.push({ orderSeq: orderSeq,
          reason: '취소 미확정 — 수동 확인 필요' + (d.msg ? ' · 서버: ' + d.msg : '') });
        if (vRow && vRow.found) cUpdateRow(orderSeq, vRow);
        break;
      }
    } catch (e) {
      ccLog('배치 실행 오류', e);
    } finally {
      cBatchBusy = false;
    }
    return results;
  }
  //  사전검증 승인창. 총 N / 대상 K / 제외 M + 사유, ERP 원문 경고, [취소 진행]/[닫기].
  //  진행 중에는 [닫기]→[중단] 으로 바뀌고 배경 클릭으로 닫히지 않는다(진행 표시를 잃지 않게).
  function ccShowApprovalDialog(cls) {
    try {
      ensureCcStyle();
      const prev = document.getElementById(CC_MODAL_ID);
      if (prev) prev.remove();
      const targets = (cls && Array.isArray(cls.targets)) ? cls.targets : [];
      const excluded = (cls && Array.isArray(cls.excluded)) ? cls.excluded : [];
      const dup = !!(cls && cls.duplicate);
      const total = targets.length + excluded.length;
      const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const ov = document.createElement('div');
      ov.id = CC_MODAL_ID; ov.className = 'ub-hq-ov';
      const card = document.createElement('div'); card.className = 'ub-hq-card';
      let running = false;
      const close = () => { try { ov.remove(); } catch (_) {} };

      let bodyHtml = '';
      if (total === 0) {
        bodyHtml = '<div class="ub-hq-warn">선택된 항목이 없습니다.</div>';
      } else if (dup) {
        bodyHtml = '<div class="ub-hq-warn">중복 주문번호 — 중단</div>' +
                   '<div class="ub-hq-note">같은 주문번호가 두 번 이상 선택되었습니다. 중복을 풀고 다시 시도하세요.</div>';
      } else {
        bodyHtml = '<div class="ub-hq-sum">총 ' + total + '건 중 대상 <b>' + targets.length +
                   '건</b> / 제외 ' + excluded.length + '건</div>';
        if (excluded.length) {
          const items = excluded.map(x => '<li>' + esc(x.orderSeq) + ' — ' + esc(x.reason) +
                        (x.code ? ' (' + esc(x.code) + ')' : '') + '</li>').join('');
          bodyHtml += '<div class="ub-hq-ex"><ul>' + items + '</ul></div>';
        }
        if (targets.length) {
          bodyHtml += '<div class="ub-hq-warn" style="margin-top:10px">취소된 주문서는 복구되지 않습니다.</div>';
        }
      }
      card.innerHTML =
        '<div class="ub-hq-h">일괄취소 — 사전검증</div>' +
        '<div class="ub-hq-b">' + bodyHtml + '</div>' +
        '<div class="ub-hq-f"></div>';
      const foot = card.querySelector('.ub-hq-f');
      const canProceed = total > 0 && !dup && targets.length > 0;

      // [닫기]/[중단] 은 핸들러 하나를 갈아끼운다 — 리스너 두 개가 같이 불리면 진행 중에 창이 닫힌다
      let cancelHandler = close;
      const cancel = document.createElement('button');
      cancel.className = 'ub-hq-btn2 ub-hq-cancel'; cancel.type = 'button';
      cancel.textContent = canProceed ? '취소' : '닫기';
      cancel.addEventListener('click', () => cancelHandler());

      if (canProceed) {
        const go = document.createElement('button');
        go.className = 'ub-hq-btn2 ub-cc-go'; go.type = 'button'; go.textContent = '취소 진행';
        go.addEventListener('click', async () => {
          if (running || cBatchBusy) return;
          running = true;
          go.disabled = true;
          let abortReq = false;
          cancel.textContent = '중단';
          cancelHandler = () => { abortReq = true; cancel.textContent = '중단 요청됨'; };
          const note = document.createElement('div');
          note.className = 'ub-hq-note';
          note.textContent = '준비 중...';
          const b = card.querySelector('.ub-hq-b'); if (b) b.appendChild(note);
          const results = await ccRunCancelBatch(targets, (msg) => { note.textContent = msg; }, () => abortReq);
          const lines = [];
          if (results.success > 0) lines.push('성공 ' + results.success + '건');
          if (results.failed.length > 0) {
            const f = results.failed[0];
            lines.push('실패 1건: ' + f.orderSeq + ' — ' + f.reason);
          }
          if (results.uncertain.length > 0) {
            const u = results.uncertain[0];
            lines.push('미확정 1건: ' + u.orderSeq + ' — ' + u.reason);
          }
          const remaining = results.total - results.processed;
          if (remaining > 0) lines.push('미처리 ' + remaining + '건');
          note.textContent = lines.join(' / ') || '처리 완료';
          running = false;
          cancel.textContent = '닫기';
          cancelHandler = close;
        });
        foot.appendChild(go);
      }
      foot.appendChild(cancel);

      ov.addEventListener('click', (e) => { if (e.target === ov && !running) close(); });
      card.addEventListener('click', (e) => e.stopPropagation());
      ov.appendChild(card);
      document.body.appendChild(ov);
    } catch (e) { ccLog('승인창 표시 실패', e); }
  }
  //  클릭 핸들러(게이트 ON 시): 체크된 행을 분류해 승인창을 띄운다. 어떤 쓰기도 하지 않는다.
  function onBulkCancelClick(e) {
    try {
      if (e && e.isTrusted === false) return;             // 페이지 스크립트의 .click() 차단
      if (!(state.ubSkin && state.ubHqConfirm)) return;   // 게이트 OFF → 아무 것도 안 함
      const rows = cReadCheckedRows();
      const cls = ccClassifyChecked(rows);
      ccLog('사전검증 — 체크', rows.length, '대상', cls.targets.length, '제외', cls.excluded.length, 'dup', cls.duplicate);
      ccShowApprovalDialog(cls);
    } catch (err) { ccLog('클릭 처리 실패', err); }
  }
  //  standby 툴바(TD.left)의 마지막 standby 앵커([본사확인취소]) 뒤에 [일괄취소] 를 idempotent 하게
  //  주입한다. 게이트 OFF 면 숨김. 목록 페이지에서만. 툴바가 없으면 주입 안 함(fail-safe).
  function injectBulkCancelButton() {
    try {
      if (!isOrderJunList()) return;
      let btn = document.getElementById(CC_BTN_ID);
      const gated = !!(state.ubSkin && state.ubHqConfirm);
      if (!btn) {
        const anchors = document.querySelectorAll('a[href*="standby"]');
        const last = anchors.length ? anchors[anchors.length - 1] : null;
        if (!last || !last.parentNode) return;
        ensureCcStyle();
        btn = document.createElement('button');
        btn.id = CC_BTN_ID; btn.type = 'button';
        btn.textContent = '일괄취소';
        btn.addEventListener('click', onBulkCancelClick);
        last.insertAdjacentElement('afterend', btn);
        ccLog('버튼 주입');
      }
      btn.style.display = gated ? '' : 'none';
    } catch (e) { ccLog('버튼 주입 실패', e); }
  }
```

- [ ] **Step 2: 배선** — `init()` 안 `injectHqConfirmButton();` 줄 바로 아래에:

```js
    injectBulkCancelButton();  // v4.1.9 일괄취소: 체크한 주문완료 건 순차 취소 — 게이트 OFF 면 숨김(항상 idempotent 주입)
```

`chrome.storage.onChanged` 핸들러의 `injectHqConfirmButton();   // v3.8.x ...` 줄 바로 아래에:

```js
        injectBulkCancelButton();  // v4.1.9 일괄취소: 팝업 토글 시 reload 없이 버튼 표시/숨김 반영(idempotent)
```

- [ ] **Step 3: 정적 검증** — `node --check src/skin.js` 통과, `node --test tests/*.test.js` 전부 pass(기존 187 + Task 1). 접두 충돌 확인: `grep -c "function cc" src/skin.js` 가 새 함수 수와 같다.

- [ ] **Step 4: 라이브 스모크(쓰기 없음)** — 사장님 크롬(`http://ubdstore.ubshop.biz/jun/orderitem/orderItemList.do?tcode=order_item`)에서 확장 폴더를 새 skin.js 로 리로드 후: 툴바에 [일괄취소] 가 [본사확인취소] 뒤에 빨간 outline 으로 보이는가 · 주문완료 1건 + 본사확인 1건 체크 → 클릭 → "총 2건 중 대상 1건 / 제외 1건(본사확인 상태 — [본사확인취소] 후 다시)" + 빨간 경고 · [닫기] 로 종료(**[취소 진행] 은 누르지 않는다**).

- [ ] **Step 5: 커밋**

```bash
git add src/skin.js
git commit -m "feat(주문전표): [일괄취소] 버튼 — 체크한 주문완료 건 순차 취소 + 재조회 판정"
```

---

### Task 3: 팝업 라벨 · 버전 · 껍데기 인덱스

**Files:**
- Modify: `popup/popup.html:73` — 스위치 라벨/설명
- Modify: `manifest.json:4` — `"version": "4.1.9"`
- Regenerate: `shell-files.json` (`pwsh build-shell-index.ps1`)

- [ ] **Step 1: 팝업 라벨** — `popup/popup.html` 73행을

```html
      <div class="label"><span class="name">주문전표 일괄 처리</span><span class="desc">⚠ 본사확인+입고완료 · 일괄취소 버튼을 켭니다. 실제로 서버에 씁니다(되돌리려면 수동)</span></div>
```

- [ ] **Step 2: 버전** — `manifest.json` `"version": "4.1.8"` → `"4.1.9"`.

- [ ] **Step 3: 인덱스 재생성** — `pwsh -File build-shell-index.ps1` → `shell-files.json` version 4.1.9, skin.js/popup.html/manifest.json 해시 갱신.

- [ ] **Step 4: 무결성** — `node tests/loader-integrity.test.js` 통과(Task3 전량 대조가 켜진 상태에서). 이 뒤에 소스를 또 고치면 Step 3 부터 다시.

- [ ] **Step 5: 커밋**

```bash
git add popup/popup.html manifest.json shell-files.json
git commit -m "chore(release): SHELL v4.1.9 — 일괄취소 + 팝업 스위치 '주문전표 일괄 처리'"
```

---

### Task 4: 검수(T3) · 원장 · 라이브 검증 · push

- [ ] **Step 1: 등급** — T3(주문 데이터 · 되돌릴 수 없는 라이브 쓰기). 근거를 `docs/REVIEW-LEDGER.md` 에 적는다.
- [ ] **Step 2: 외부 검수** — 대상은 `git diff 7100c80..HEAD -- src/skin.js popup/popup.html manifest.json tests/orderitem-cancel.test.js`(diff 로 좁힌다). 선임: 고위험 자리 `openai/gpt-5.6-terra`(effort high) → 지적을 코드로 재현해 채택/기각 → 수정 시 같은 모델 재검수 → Opus 5(`opus-reviewer`) → 교차 1회 `deepseek/deepseek-v4-pro`(CJK 오염 통짜 스캔) → Fable 5(`fable-reviewer`, 되돌리기 어려운 라이브 쓰기 조건). 채택 0 에서 종료. 실행 직전·직후 `usage_daily` 로 비용 측정.
- [ ] **Step 3: 원장** — 누적 판정 + 회차 상세(등급·모델·라운드·지적/채택/기각·비용) 기록.
- [ ] **Step 4: 라이브 검증(쓰기 1건)** — 사장님이 지정한 취소해도 되는 주문완료 1건으로 [일괄취소] → [취소 진행] → 행이 '주문취소' 로 교체되는 것을 스크린샷으로 확인.
- [ ] **Step 5: push** — `git push origin main`. ExtSync 반영은 브라우저 재시작 후.
