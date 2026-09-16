# 주문 전표 일괄취소 확장 — 상태 사슬 취소 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `[일괄취소]` 가 출고완료(T--)·입고완료(I--)·본사확인(OS-) 건도 **출고장 삭제 → 선택취소 → 본사확인취소 → 취소** 사슬로 주문취소(OC-)까지 보낸다.

**Architecture:** `skin.js` §5.11 의 건별 루프를 "재조회 → `ccNextStep` 이 고른 쓰기 하나 → 목표 상태 재조회 확인" 상태기계로 바꾼다. 쓰기 4종은 기존 배관(`ccDoCancel`·`cBuildStandbyUrl`·`dcmPostRaw/dcmDelete/dcmAppendLog`)을 재사용하고, 판정은 전부 순수 함수(`ccNextStep`·`ccStepOutcome`·`ccPickDelivIdx`·`ccBuildUnassignUrl`·`ccChainLabel`·`ccRequeryReason`)로 뺀다. 스펙: `docs/superpowers/specs/2026-09-16-orderitem-cancel-chain-design.md`.

**Tech Stack:** Chrome MV3 content script(ISOLATED world, `fetch(credentials:'include')`), `node --test` + `new Function` 추출 하네스(`tests/orderitem-cancel*.test.js`), SHELL 채널 배포(`build-shell-index.ps1`).

## Global Constraints

- 상태 판정은 canonical code **EXACT**(`O-- OS- I-- T-- OC- TS- TE- S-- B--`). prefix·부분일치 금지.
- 쓰기 근거는 언제나 **쓰기 직전 재조회 응답 하나**(상태·`assignedBarcode`·`rowHtml`·`sKey`). 화면 행·승인창 값은 근거가 아니다.
- dispatch 뒤 재시도 없음. 목표 상태가 재조회로 확인되기 전에는 다음 단계로 넘어가지 않는다.
- 조회 목적으로 쓰기 URL(`orderItemCancel.do`·`orderItemPopCurrentSettingCancel.do`·`orderItemStandby.do`·`delivItemDelete.do`)을 부르지 않는다. 테스트의 `fetch` 는 스텁이다.
- `skin.js` 편집은 **Write 로 만든 패치 스크립트나 Edit 도구**로만(Bash heredoc 은 백슬래시를 벗긴다 — 정규식이 깨진다). PowerShell `Set-Content` 로 한글 파일을 쓰지 않는다.
- 기존 O-- 경로의 테스트(`orderitem-cancel-batch.test.js` 성공 경로·순차·fresh sKey·미확정·게이트·중단·busy·링크 가드)는 **재조회 호출 수·GET 수·갱신 수가 그대로** 통과해야 한다.
- 함수 이름은 테스트가 `extractFn(src, name)` 으로 뽑는다 — **이름을 바꾸지 마라**(`function 이름(` 형태, async 는 `async function`).
- 버전: `manifest.json` 4.2.7. 커밋 메시지 끝 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- 라이브 쓰기 검증은 사장님이 지정한 실제 건 1건으로, 검수 뒤에 사장님 입회로만. 그 전에는 읽기 조회만.

---

### Task 1: 순수 판정부 — 대상 상태·사슬 표시·재조회 사유

**Files:**
- Modify: `src/skin.js` (§5.11 `ccTargetStatus` ~6354, `ccClassifyChecked` ~6359)
- Test: `tests/orderitem-cancel.test.js`

**Interfaces:**
- Produces: `ccTargetStatus(code) → boolean` (O--/OS-/I--/T--), `ccClassifyChecked(rows) → {targets, excluded, duplicate}` (rows 에 `cs:{has,barcode}`), `ccChainLabel(code, cs) → string`, `ccRequeryReason(row) → string`.

- [x] **Step 1: 기존 테스트를 새 계약으로 고치고 새 테스트를 추가한다 (RED)**

`tests/orderitem-cancel.test.js` 의 `NAMES` 를 바꾸고 아래 테스트를 교체·추가한다.

```js
const NAMES = ['ccTargetStatus', 'ccClassifyChecked', 'ccBuildCancelUrl', 'ccRedirectMsg', 'ccClassifyOutcome',
               'ccChainLabel', 'ccRequeryReason'];
// … destructuring 에도 ccChainLabel, ccRequeryReason 추가
```

기존 `ccTargetStatus` 3개 테스트를 이렇게 교체한다:

```js
test('ccTargetStatus: O--/OS-/I--/T-- 만 true (사슬 대상, 스펙 2026-09-16 §4.1)', () => {
  for (const c of ['O--', 'OS-', 'I--', 'T--']) assert.equal(ccTargetStatus(c), true, c);
});
test('ccTargetStatus: OC-/TS-/TE-/S--/B-- 는 false', () => {
  for (const c of ['OC-', 'TS-', 'TE-', 'S--', 'B--']) assert.equal(ccTargetStatus(c), false, c);
});
test('ccTargetStatus: null/undefined/빈값/prefix/소문자/공백 전부 false (EXACT)', () => {
  for (const c of [null, undefined, '', 'O', 'O--x', 'o--', ' O--', 'O-- ', 'os-', 'I', 'T']) assert.equal(ccTargetStatus(c), false, String(c));
});
```

기존 `ccClassifyChecked` 의 "O-- 는 targets…" 와 "제외 사유 매핑" 테스트를 이렇게 교체한다:

```js
test('ccClassifyChecked: O--/OS-/T--/링크 있는 I-- 는 targets(원본 객체·순서 보존), 나머지는 excluded', () => {
  const rows = [
    { orderSeq: '1', code: 'O--', orderDate: '20260916' },
    { orderSeq: '2', code: 'OS-', orderDate: '20260916', cs: { has: true, barcode: '' } },
    { orderSeq: '3', code: 'I--', orderDate: '20260916', cs: { has: true, barcode: '2608ET' } },
    { orderSeq: '4', code: 'T--', orderDate: '20260916', cs: { has: false, barcode: '250HHL' } },
    { orderSeq: '5', code: 'OC-', orderDate: '20260916' }
  ];
  const r = ccClassifyChecked(rows);
  assert.deepEqual(r.targets, [rows[0], rows[1], rows[2], rows[3]]);
  assert.equal(r.targets[2], rows[2], '원본 객체 그대로');
  assert.deepEqual(r.excluded, [{ orderSeq: '5', code: 'OC-', reason: '이미 취소됨' }]);
  assert.equal(r.duplicate, false);
});
test('ccClassifyChecked: 제외 사유 매핑 — 발주주문 입고완료·출고확인·불명', () => {
  const r = ccClassifyChecked([
    { orderSeq: '1', code: 'I--' },                                   // cs 없음 = 링크 없음
    { orderSeq: '2', code: 'I--', cs: { has: false, barcode: '' } },
    { orderSeq: '3', code: 'I--', cs: { has: true, barcode: '' } },    // 링크는 있는데 바코드 빈값 → 자동 처리 불가
    { orderSeq: '4', code: 'TS-' }, { orderSeq: '5', code: 'TE-' }, { orderSeq: '6', code: 'S--' }, { orderSeq: '7', code: 'B--' },
    { orderSeq: '8', code: null }, { orderSeq: '9', code: 'ZZZ' }
  ]);
  assert.deepEqual(r.targets, []);
  assert.deepEqual(r.excluded.map(x => x.reason), [
    '입고완료 — 배정 팝업 링크 없음(발주주문이거나 본사 계정이 아님), 수동', '입고완료 — 배정 팝업 링크 없음(발주주문이거나 본사 계정이 아님), 수동', '입고완료 — 배정 팝업 링크 없음(발주주문이거나 본사 계정이 아님), 수동',
    '출고확인(매장재고) — 매장이 입고 확인한 건, 수동', '취소 불가 상태(출고오확인)', '취소 불가 상태(판매완료)', '취소 불가 상태(발주완료)',
    '상태 불명', '상태 불명'
  ]);
});
```

새 테스트를 파일 끝에 추가한다:

```js
// ── ccChainLabel (승인창 표시 전용) ─────────────────────────────────────────
test('ccChainLabel: 상태별 거칠 단계 문구, 바코드는 괄호로, 대상 아니면 빈 문자열', () => {
  assert.equal(ccChainLabel('O--', null), '주문완료 → 취소');
  assert.equal(ccChainLabel('OS-', { has: true, barcode: '' }), '본사확인 → 본사확인취소 · 취소');
  assert.equal(ccChainLabel('I--', { has: true, barcode: '2608ET' }), '입고완료 (2608ET) → 선택취소 · 본사확인취소 · 취소');
  assert.equal(ccChainLabel('T--', { has: false, barcode: '250HHL' }), '출고완료 (250HHL) → 출고장 삭제 · 선택취소 · 본사확인취소 · 취소');
  assert.equal(ccChainLabel('T--', null), '출고완료 → 출고장 삭제 · 선택취소 · 본사확인취소 · 취소');
  assert.equal(ccChainLabel('TS-', null), ''); assert.equal(ccChainLabel(null, null), '');
});
// ── ccRequeryReason ─────────────────────────────────────────────────────────
test('ccRequeryReason: found=false 사유 구분 — 로그인 만료 > 중복 > 잘림 > 행 없음', () => {
  assert.equal(ccRequeryReason({ found: false, loginExpired: true, duplicate: true }), '로그인 만료');
  assert.equal(ccRequeryReason({ found: false, duplicate: true, hasMore: true }), '중복 orderSeq(재조회)');
  assert.equal(ccRequeryReason({ found: false, hasMore: true }), '재조회 실패(결과 잘림 — 조건을 좁혀라)');
  assert.equal(ccRequeryReason({ found: false }), '재조회 실패(행 없음)');
  assert.equal(ccRequeryReason(null), '재조회 실패(행 없음)');
});
```

- [x] **Step 2: 실패 확인**

Run: `node --test tests/orderitem-cancel.test.js`
Expected: FAIL — `ccChainLabel 선언을 찾지 못했습니다` (추출 즉사) 또는 ccTargetStatus/ccClassifyChecked 단언 실패.

- [x] **Step 3: 구현**

`src/skin.js` §5.11 순수 판정부를 이렇게 바꾼다(`ccTargetStatus`·`ccClassifyChecked` 교체, 두 함수 추가):

```js
  // ── 일괄취소 순수 판정부 — DOM·네트워크·chrome.*·타이머 미접촉. tests/orderitem-cancel.test.js ──
  //  사슬 대상 = 주문완료(O--)·본사확인(OS-)·입고완료(I--)·출고완료(T--) 넷. EXACT(스펙 2026-09-16 §4.1).
  function ccTargetStatus(code) {
    return code === 'O--' || code === 'OS-' || code === 'I--' || code === 'T--';
  }
  //  승인창 표시 문구(판정에 쓰지 않는다). cs = { has: currentSetting 링크 유무, barcode: 링크 3번째 인자 또는 상태 셀 괄호값 }.
  //  표는 함수 안에 둔다 — 테스트 하네스가 함수 하나만 추출한다.
  function ccChainLabel(code, cs) {
    const CHAIN = {
      'O--': '주문완료 → 취소',
      'OS-': '본사확인 → 본사확인취소 · 취소',
      'I--': '입고완료%s → 선택취소 · 본사확인취소 · 취소',
      'T--': '출고완료%s → 출고장 삭제 · 선택취소 · 본사확인취소 · 취소'
    };
    const s = CHAIN[code];
    if (!s) return '';
    const bc = cs && cs.barcode ? ' (' + cs.barcode + ')' : '';
    return s.replace('%s', bc);
  }
  //  fetchOrderRow 가 found=false 를 낸 사유(표시용). 우선순위: 로그인 만료 > 중복 > 잘림 > 행 없음.
  function ccRequeryReason(row) {
    if (row && row.loginExpired) return '로그인 만료';
    if (row && row.duplicate) return '중복 orderSeq(재조회)';
    if (row && row.hasMore) return '재조회 실패(결과 잘림 — 조건을 좁혀라)';
    return '재조회 실패(행 없음)';
  }
  //  체크된 행 → 대상/제외. excluded 는 {orderSeq, code, reason}. 같은 orderSeq 둘 이상이면
  //  duplicate=true — 조용히 합치지 않고 호출부가 중단한다(cClassifyChecked 와 같은 규약).
  //  입고완료는 배정 팝업 링크(currentSetting)가 있고 바코드가 있을 때만 대상 — 발주주문(공장 발주→입고)은 팝업이 없어 선택취소 경로가 없다(실측 2026-09-16).
  function ccClassifyChecked(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const REASON = new Map([
      ['OC-', '이미 취소됨'], ['TS-', '출고확인(매장재고) — 매장이 입고 확인한 건, 수동'],
      ['B--', '취소 불가 상태(발주완료)'], ['TE-', '취소 불가 상태(출고오확인)'], ['S--', '취소 불가 상태(판매완료)']
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
      if (ccTargetStatus(code)) {
        if (code === 'I--' && !(r.cs && r.cs.has && r.cs.barcode)) {
          excluded.push({ orderSeq: r.orderSeq, code: code, reason: '입고완료 — 배정 팝업 링크 없음(발주주문이거나 본사 계정이 아님), 수동' });
          continue;
        }
        targets.push(r); continue;
      }
      excluded.push({ orderSeq: r ? r.orderSeq : undefined, code: code,
                      reason: REASON.get(code) || '상태 불명' });
    }
    return { targets: targets, excluded: excluded, duplicate: duplicate };
  }
```

- [x] **Step 4: 통과 확인**

Run: `node --test tests/orderitem-cancel.test.js`
Expected: PASS (전부).

- [x] **Step 5: 커밋**

```bash
git add src/skin.js tests/orderitem-cancel.test.js
git commit -m "feat(일괄취소): 사슬 대상 상태(O--/OS-/I--/T--)·승인창 사슬 문구·재조회 사유 순수부"
```

---

### Task 2: 순수 판정부 — 다음 단계·목표 확인·출고 건 특정·선택취소 URL

**Files:**
- Modify: `src/skin.js` (§5.11, Task 1 의 함수들 뒤)
- Test: `tests/orderitem-cancel.test.js`

**Interfaces:**
- Consumes: `ccRowCancelSeq(rowHtml)`, `parseCurrentSettingArgs(href)`(§5.4, 기존).
- Produces: `ccRowCurrentSetting(rowHtml) → {master,orderSeq,barcode,shop,client,orderDate}|null`, `ccNextStep(row) → {kind:'done'} | {kind:'fail', reason} | {kind:'write', step, label, want, barcode?}` (step ∈ `'deliv-delete'|'unassign'|'standby-off'|'cancel'`, want = 목표 상태 코드), `ccStepOutcome(next, vRow) → 'success'|'uncertain'`, `ccPickDelivIdx(values, barcode, orderSeq) → {idx}|{ambiguous:n}|null`, `ccBuildUnassignUrl(barcode, orderSeq, searchFields) → string|null`.

- [x] **Step 1: 테스트 추가 (RED)**

`NAMES` 에 `'ccRowCancelSeq', 'parseCurrentSettingArgs', 'ccRowCurrentSetting', 'ccNextStep', 'ccStepOutcome', 'ccPickDelivIdx', 'ccBuildUnassignUrl'` 을 추가하고(destructuring 도), 파일 끝에:

```js
// ── ccNextStep / ccStepOutcome (스펙 §4.5) ──────────────────────────────────
const CS = (seq, bc) => '<a href="javascript:currentSetting(\'7043\',\'' + seq + '\',\'' + bc + '\',\'NU\',\'123426\',\'20260915\')">x</a>';
const ROW = (o) => Object.assign({ found: true, orderSeq: '101', code: null, text: '', assignedBarcode: '', rowHtml: '', sKey: '260916125809911' }, o);
test('ccNextStep: OC- 는 done', () => { assert.deepEqual(ccNextStep(ROW({ code: 'OC-' })), { kind: 'done' }); });
test('ccNextStep: O-- 는 del 링크 인자 EXACT 일치 + sKey 있을 때만 cancel', () => {
  assert.deepEqual(ccNextStep(ROW({ code: 'O--', rowHtml: '<tr><td><a href="javascript:del(\'101\');">취소</a></td></tr>' })), { kind: 'write', step: 'cancel', label: '취소 처리', want: 'OC-' });
  assert.deepEqual(ccNextStep(ROW({ code: 'O--', rowHtml: '<tr><td>주문완료</td></tr>' })), { kind: 'fail', reason: '취소 링크 없음(서버 렌더 기준 취소 불가)' });
  assert.deepEqual(ccNextStep(ROW({ code: 'O--', rowHtml: '<a href="javascript:del(\'102\')">x</a>' })), { kind: 'fail', reason: '취소 링크 불일치(102)' });
  assert.deepEqual(ccNextStep(ROW({ code: 'O--', sKey: null, rowHtml: '<a href="javascript:del(\'101\')">x</a>' })), { kind: 'fail', reason: 'sKey 추출 실패' });
});
test('ccNextStep: OS- 는 standby-off(sKey 필수)', () => {
  assert.deepEqual(ccNextStep(ROW({ code: 'OS-', rowHtml: CS('101', '') })), { kind: 'write', step: 'standby-off', label: '본사확인취소', want: 'O--' });
  assert.deepEqual(ccNextStep(ROW({ code: 'OS-', sKey: '' })), { kind: 'fail', reason: 'sKey 추출 실패' });
});
test('ccNextStep: I-- 는 링크 바코드 == 상태 셀 바코드 일 때만 unassign, 링크 없으면 발주주문', () => {
  assert.deepEqual(ccNextStep(ROW({ code: 'I--', assignedBarcode: '2608ET', rowHtml: CS('101', '2608ET') })), { kind: 'write', step: 'unassign', label: '선택취소(2608ET)', want: 'OS-', barcode: '2608ET' });
  assert.deepEqual(ccNextStep(ROW({ code: 'I--', assignedBarcode: '2608ET', rowHtml: '<tr><td>입고완료 (2608ET)</td></tr>' })), { kind: 'fail', reason: '입고완료 — 배정 팝업 링크 없음(발주주문이거나 본사 계정이 아님), 수동' });
  assert.deepEqual(ccNextStep(ROW({ code: 'I--', assignedBarcode: '2608ET', rowHtml: CS('101', '2608EU') })), { kind: 'fail', reason: '배정 바코드 불일치(링크 2608EU / 상태 2608ET)' });
  assert.deepEqual(ccNextStep(ROW({ code: 'I--', assignedBarcode: '', rowHtml: CS('101', '') })), { kind: 'fail', reason: '배정 바코드 불일치(링크 없음 / 상태 없음)' });
  assert.equal(ccNextStep(ROW({ code: 'I--', sKey: null, assignedBarcode: '2608ET', rowHtml: CS('101', '2608ET') })).kind, 'write', '선택취소는 sKey 가 없어도 된다(팝업 GET 계약)');
});
test('ccNextStep: T-- 는 상태 셀 바코드가 있을 때만 deliv-delete', () => {
  assert.deepEqual(ccNextStep(ROW({ code: 'T--', assignedBarcode: '250HHL' })), { kind: 'write', step: 'deliv-delete', label: '출고장 삭제(250HHL)', want: 'I--', barcode: '250HHL' });
  assert.deepEqual(ccNextStep(ROW({ code: 'T--', assignedBarcode: '' })), { kind: 'fail', reason: '출고 바코드를 읽지 못함' });
});
test('ccNextStep: 그 외 상태·미지·found=false 는 fail', () => {
  assert.deepEqual(ccNextStep(ROW({ code: 'TS-', text: '출고확인(2609DH)' })), { kind: 'fail', reason: '상태 부적합: 출고확인(2609DH)' });
  for (const c of ['TE-', 'S--', 'B--', null, 'ZZZ']) assert.equal(ccNextStep(ROW({ code: c })).kind, 'fail', String(c));
  assert.deepEqual(ccNextStep({ found: false }), { kind: 'fail', reason: '재조회 실패(행 없음)' });
  assert.deepEqual(ccNextStep(null), { kind: 'fail', reason: '재조회 실패(행 없음)' });
});
test('ccStepOutcome: 단계별 목표 상태, unassign 은 바코드까지 비어야 success, 나머지는 uncertain', () => {
  const W = (step, want) => ({ kind: 'write', step, want });
  assert.equal(ccStepOutcome(W('cancel', 'OC-'), ROW({ code: 'OC-' })), 'success');
  assert.equal(ccStepOutcome(W('cancel', 'OC-'), ROW({ code: 'O--' })), 'uncertain');
  assert.equal(ccStepOutcome(W('standby-off', 'O--'), ROW({ code: 'O--' })), 'success');
  assert.equal(ccStepOutcome(W('deliv-delete', 'I--'), ROW({ code: 'I--', assignedBarcode: '250HHL' })), 'success');
  assert.equal(ccStepOutcome(W('unassign', 'OS-'), ROW({ code: 'OS-', assignedBarcode: '' })), 'success');
  assert.equal(ccStepOutcome(W('unassign', 'OS-'), ROW({ code: 'OS-', assignedBarcode: '2608ET' })), 'uncertain', '상태만 바뀌고 바코드가 남으면 미확정');
  assert.equal(ccStepOutcome(W('unassign', 'OS-'), ROW({ code: 'I--' })), 'uncertain');
  assert.equal(ccStepOutcome(W('cancel', 'OC-'), { found: false }), 'uncertain');
  assert.equal(ccStepOutcome(W('cancel', 'OC-'), null), 'uncertain');
  assert.equal(ccStepOutcome(null, ROW({ code: 'OC-' })), 'uncertain');
});
// ── ccRowCurrentSetting ─────────────────────────────────────────────────────
test('ccRowCurrentSetting: 행 HTML 의 currentSetting 6인자 파싱, 없거나 인자 수 다르면 null', () => {
  assert.deepEqual(ccRowCurrentSetting('<tr><td>' + CS('389520', '2608ET') + '</td></tr>'), { master: '7043', orderSeq: '389520', barcode: '2608ET', shop: 'NU', client: '123426', orderDate: '20260915' });
  assert.equal(ccRowCurrentSetting('<tr><td>출고완료 (250HHL)</td></tr>'), null);
  assert.equal(ccRowCurrentSetting('<a href="javascript:currentSetting(\'1\',\'2\')">x</a>'), null);
  assert.equal(ccRowCurrentSetting(''), null); assert.equal(ccRowCurrentSetting(null), null);
});
// ── ccPickDelivIdx (스펙 §1.2·§4.5) ─────────────────────────────────────────
test('ccPickDelivIdx: 2번째=바코드 && 4번째=orderSeq 인 값 정확히 1건만 {idx}', () => {
  const vals = ['426106,250HHL,47295,389513', '426105,250HHL,47290,0', '426054,2609DH,47281,389336'];
  assert.deepEqual(ccPickDelivIdx(vals, '250HHL', '389513'), { idx: '426106,250HHL,47295,389513' });
  assert.deepEqual(ccPickDelivIdx(vals, '250hhl', ' 389513 '), { idx: '426106,250HHL,47295,389513' }, '바코드 대소문자·공백 무시');
  assert.equal(ccPickDelivIdx(vals, '250HHL', '389514'), null, '바코드만 맞고 주문이 다르면 없음');
  assert.deepEqual(ccPickDelivIdx(vals, '250HHL', '0'), { idx: '426105,250HHL,47290,0' }, 'orderSeq 0(주문 없는 출고)도 값으로는 특정된다 — 호출부가 0 을 넘길 일은 없다');
  assert.deepEqual(ccPickDelivIdx(vals.concat(['999,250HHL,1,389513']), '250HHL', '389513'), { ambiguous: 2 });
  assert.equal(ccPickDelivIdx(vals, '', '389513'), null); assert.equal(ccPickDelivIdx(vals, '250HHL', ''), null);
  assert.equal(ccPickDelivIdx(['bad', '1,250HHL', null], '250HHL', '389513'), null, '토큰 4개 미만은 무시');
  assert.equal(ccPickDelivIdx(null, '250HHL', '389513'), null);
});
// ── ccBuildUnassignUrl (스펙 §1.3) ──────────────────────────────────────────
test('ccBuildUnassignUrl: 팝업 cancelForm 과 같은 모양 — tcode·barcode·orderSeq + 검색조건, 고정 키는 덮이지 않음', () => {
  const url = ccBuildUnassignUrl('2608ET', '389520', { reqPage: '1', pageSize: '100', searchSortType: 'seq', barcode: 'HACK', tcode: 'x' });
  assert.ok(url.startsWith('/jun/orderitem/orderItemPopCurrentSettingCancel.do?'));
  const p = new URL('http://x' + url).searchParams;
  assert.equal(p.get('tcode'), 'order_item'); assert.equal(p.get('barcode'), '2608ET'); assert.equal(p.get('orderSeq'), '389520');
  assert.equal(p.get('reqPage'), '1'); assert.equal(p.get('pageSize'), '100'); assert.equal(p.get('searchSortType'), 'seq');
  assert.equal(ccBuildUnassignUrl('', '389520', {}), null); assert.equal(ccBuildUnassignUrl('2608ET', '', {}), null);
  assert.equal(ccBuildUnassignUrl(' 2608ET ', 389520, null), '/jun/orderitem/orderItemPopCurrentSettingCancel.do?tcode=order_item&barcode=2608ET&orderSeq=389520');
});
```

- [x] **Step 2: 실패 확인**

Run: `node --test tests/orderitem-cancel.test.js`
Expected: FAIL — `ccRowCurrentSetting 선언을 찾지 못했습니다`.

- [x] **Step 3: 구현** — Task 1 의 함수들 뒤에 추가:

```js
  //  행 HTML 의 배정 팝업 링크 currentSetting(master, orderSeq, barcode, shop, client, orderDate) 인자. 없거나 6개가 아니면 null(§5.4 parseCurrentSettingArgs 재사용).
  function ccRowCurrentSetting(rowHtml) {
    const m = String(rowHtml == null ? '' : rowHtml).match(/currentSetting\s*\([^)]*\)/);
    return m ? parseCurrentSettingArgs(m[0]) : null;
  }
  //  재조회 행(fetchOrderRow 결과) → 다음 쓰기 하나. 스펙 §4.5 표. 전부 fail-closed — 조건이 하나라도 안 맞으면 write 를 내지 않는다.
  //   반환 {kind:'done'} | {kind:'fail', reason} | {kind:'write', step, label, want[, barcode]}; want = 목표 상태(재조회로 확인할 코드).
  function ccNextStep(row) {
    const fail = (reason) => ({ kind: 'fail', reason: reason });
    if (!row || row.found !== true) return fail(ccRequeryReason(row));
    const code = row.code, seq = String(row.orderSeq == null ? '' : row.orderSeq);
    if (code === 'OC-') return { kind: 'done' };
    if (code === 'O--') {
      if (!row.sKey) return fail('sKey 추출 실패');
      const linkSeq = ccRowCancelSeq(row.rowHtml);
      if (linkSeq !== seq) return fail(linkSeq == null ? '취소 링크 없음(서버 렌더 기준 취소 불가)' : '취소 링크 불일치(' + linkSeq + ')');
      return { kind: 'write', step: 'cancel', label: '취소 처리', want: 'OC-' };
    }
    if (code === 'OS-') {
      if (!row.sKey) return fail('sKey 추출 실패');
      return { kind: 'write', step: 'standby-off', label: '본사확인취소', want: 'O--' };
    }
    if (code === 'I--') {
      const args = ccRowCurrentSetting(row.rowHtml);
      if (!args) return fail('입고완료 — 배정 팝업 링크 없음(발주주문이거나 본사 계정이 아님), 수동');
      const bc = String(row.assignedBarcode == null ? '' : row.assignedBarcode);
      if (!bc || args.barcode !== bc) return fail('배정 바코드 불일치(링크 ' + (args.barcode || '없음') + ' / 상태 ' + (bc || '없음') + ')');
      return { kind: 'write', step: 'unassign', label: '선택취소(' + bc + ')', want: 'OS-', barcode: bc };
    }
    if (code === 'T--') {
      const bc = String(row.assignedBarcode == null ? '' : row.assignedBarcode);
      if (!bc) return fail('출고 바코드를 읽지 못함');
      return { kind: 'write', step: 'deliv-delete', label: '출고장 삭제(' + bc + ')', want: 'I--', barcode: bc };
    }
    return fail('상태 부적합: ' + (row.text || code || '불명'));
  }
  //  dispatch 뒤 목표 확인 재조회의 판정. found 아님·다른 상태·null 은 전부 'uncertain'(재시도 금지 신호 — ccClassifyOutcome 과 같은 규약).
  //   선택취소는 상태(OS-)와 바코드 빈 값이 둘 다 보여야 success(바코드가 남아 있으면 떼어지지 않은 것).
  function ccStepOutcome(next, vRow) {
    if (!next || !vRow || vRow.found !== true) return 'uncertain';
    if (vRow.code !== next.want) return 'uncertain';
    if (next.step === 'unassign' && String(vRow.assignedBarcode == null ? '' : vRow.assignedBarcode) !== '') return 'uncertain';
    return 'success';
  }
  //  출고전표 idx 값(`<출고seq>,<바코드>,<?>,<주문 orderSeq>`, 실측 2026-09-16 9/9) 중 바코드와 주문이 둘 다 맞는 것.
  //   정확히 1건이면 {idx}, 2건 이상이면 {ambiguous:n}, 없으면 null — 바코드만 맞는 건(4번째 0·다른 주문)은 절대 고르지 않는다.
  function ccPickDelivIdx(values, barcode, orderSeq) {
    const bc = String(barcode == null ? '' : barcode).trim().toUpperCase();
    const seq = String(orderSeq == null ? '' : orderSeq).trim();
    if (!bc || !seq) return null;
    const hits = (Array.isArray(values) ? values : []).filter((v) => {
      const t = String(v == null ? '' : v).split(',');
      return t.length >= 4 && t[1].trim().toUpperCase() === bc && t[3].trim() === seq;
    });
    if (hits.length === 1) return { idx: hits[0] };
    return hits.length ? { ambiguous: hits.length } : null;
  }
  //  팝업 [선택취소] cancelForm 과 같은 모양(스펙 §1.3): tcode·barcode·orderSeq + 검색조건. sKey 없음(팝업에도 없다).
  //   빈 값이면 null(빈 값이 쓰기로 흘러가지 않게). 고정 키는 searchFields 가 덮지 못한다. ⚠⚠ 이 URL 의 GET 이 쓰기다.
  function ccBuildUnassignUrl(barcode, orderSeq, searchFields) {
    const bc = String(barcode == null ? '' : barcode).trim();
    const seq = String(orderSeq == null ? '' : orderSeq).trim();
    if (!bc || !seq) return null;
    const p = new URLSearchParams();
    p.set('tcode', 'order_item');
    p.set('barcode', bc);
    p.set('orderSeq', seq);
    if (searchFields) {
      const keys = Object.keys(searchFields);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!p.has(k)) p.set(k, String(searchFields[k] == null ? '' : searchFields[k]));
      }
    }
    return '/jun/orderitem/orderItemPopCurrentSettingCancel.do?' + p.toString();
  }
```

- [x] **Step 4: 통과 확인**

Run: `node --test tests/orderitem-cancel.test.js`
Expected: PASS.

- [x] **Step 5: 커밋**

```bash
git add src/skin.js tests/orderitem-cancel.test.js
git commit -m "feat(일괄취소): 다음 단계 판정(ccNextStep)·목표 확인·출고 건 특정·선택취소 URL 순수부"
```

---

### Task 3: `cBuildStandbyUrl` 상태 인자 + `cReadCheckedRows` 의 `cs`

**Files:**
- Modify: `src/skin.js` (`cBuildStandbyUrl` ~1682, `cReadCheckedRows` ~5811)
- Test: `tests/orderitem-c.test.js` (cBuildStandbyUrl 이 여기서 테스트된다 — `grep -n cBuildStandbyUrl tests/*.js` 로 확인), `tests/orderitem-cancel-batch.test.js`(소스 핀)

**Interfaces:**
- Produces: `cBuildStandbyUrl(sKey, searchFields, status1 = 'OS-', status2 = 'O--')` — 2인자 호출은 종전과 같은 URL. `cReadCheckedRows()` 행에 `cs: { has, barcode }`.

- [x] **Step 1: 테스트 (RED)** — `tests/orderitem-c.test.js` 의 `cBuildStandbyUrl` 테스트 블록 뒤에 추가(그 파일의 추출 방식·변수명을 그대로 따른다):

```js
test('cBuildStandbyUrl: 상태 인자를 주면 본사확인취소(status1=O--, status2=OS-), 안 주면 종전(OS-/O--) 그대로', () => {
  const a = new URL('http://x' + cBuildStandbyUrl('260916125809911', { reqPage: '1' })).searchParams;
  assert.equal(a.get('status1'), 'OS-'); assert.equal(a.get('status2'), 'O--');
  const b = new URL('http://x' + cBuildStandbyUrl('260916125809911', { reqPage: '1', status1: 'HACK' }, 'O--', 'OS-')).searchParams;
  assert.equal(b.get('status1'), 'O--'); assert.equal(b.get('status2'), 'OS-'); assert.equal(b.get('sKey'), '260916125809911');
  assert.equal(cBuildStandbyUrl('', {}, 'O--', 'OS-'), null);
});
```

`tests/orderitem-cancel-batch.test.js` 끝에 소스 핀:

```js
test('cReadCheckedRows: 행마다 배정 팝업 링크 여부와 바코드(cs)를 읽는다(소스 핀 — DOM 함수)', () => {
  const src = extractFn(SRC, 'cReadCheckedRows');
  assert.ok(/a\[href\*="currentSetting"\]/.test(src) && /parseCurrentSettingArgs\(/.test(src), '링크 인자를 파싱한다');
  assert.ok(/cs:\s*\{\s*has:/.test(src), 'cs 필드');
  assert.ok(/\\\(\(\[\^\(\)\]\+\)\\\)\\s\*\$/.test(src), '링크가 없으면 상태 셀 괄호값(출고완료 (250HHL))을 바코드로');
});
```

- [x] **Step 2: 실패 확인** — `node --test tests/orderitem-c.test.js tests/orderitem-cancel-batch.test.js` → 새 테스트 2개 FAIL.

- [x] **Step 3: 구현**

`cBuildStandbyUrl`:

```js
  //  standby URL 조립. 기본은 본사확인(status1='OS-', status2='O--'); 일괄취소 사슬은 본사확인취소('O--','OS-')로 부른다 — 네이티브 standby 와 같은 규약(실측 2026-09-16).
  //  searchFields = {reqPage, pageSize, ...} — 호출부가 form1.elements 에서 읽어 넘긴다. sKey 가 없으면 null → 호출부 실패(fail-closed).
  function cBuildStandbyUrl(sKey, searchFields, status1, status2) {
    if (!sKey) return null;
    const p = new URLSearchParams();
    p.set('tcode', 'order_item');
    p.set('status1', status1 == null ? 'OS-' : String(status1));
    p.set('status2', status2 == null ? 'O--' : String(status2));
    p.set('sKey', sKey);
    if (searchFields) {
      const keys = Object.keys(searchFields);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!p.has(k)) p.set(k, String(searchFields[k] == null ? '' : searchFields[k]));
      }
    }
    return '/jun/orderitem/orderItemStandby.do?' + p.toString();
  }
```

`cReadCheckedRows` 의 `out.push(...)` 를 이렇게 바꾼다:

```js
        //  cs = 배정 팝업 링크 유무·바코드(일괄취소 사슬의 승인창 판정용 — 쓰기 근거는 재조회다). 링크가 없으면(출고완료) 상태 셀 괄호값.
        let cs = { has: false, barcode: '' };
        if (tr) {
          try {
            const a = tr.querySelector('a[href*="currentSetting"]');
            const args = a ? parseCurrentSettingArgs(a.getAttribute('href')) : null;
            if (args) cs = { has: true, barcode: String(args.barcode || '') };
            else {
              const si = cStatusColFor(tr.closest('table'));
              const st = (si >= 0 && tr.cells && tr.cells[si]) ? (tr.cells[si].textContent || '').replace(/\s+/g, '') : '';
              const mb = st.match(/\(([^()]+)\)\s*$/);
              if (mb) cs.barcode = mb[1];
            }
          } catch (_) {}
        }
        out.push({ orderSeq: orderSeq, code: tr ? cRowStatusCode(tr) : null, orderDate: orderDate, cs: cs });
```

- [x] **Step 4: 통과 확인** — `node --test tests/orderitem-c.test.js tests/orderitem-c2a.test.js tests/orderitem-c2b.test.js tests/orderitem-cancel-batch.test.js` → PASS (기존 standby URL 테스트 포함).

- [x] **Step 5: 커밋**

```bash
git add src/skin.js tests/orderitem-c.test.js tests/orderitem-cancel-batch.test.js
git commit -m "feat(일괄취소): standby URL 상태 인자(본사확인취소) · 체크 행에 배정 링크·바코드(cs)"
```

---

### Task 4: 실행부 — 쓰기 4종 디스패치(`ccDoStep`·`ccDoStandbyOff`·`ccDoUnassign`·`ccDoDelivDelete`·`ccFindDelivRow`)

**Files:**
- Modify: `src/skin.js` (§5.11 실행부, `ccDoCancel` 뒤)
- Test: `tests/orderitem-cancel-batch.test.js`

**Interfaces:**
- Consumes: `ccBuildUnassignUrl`, `cBuildStandbyUrl`, `ccRedirectMsg`, `ccPickDelivIdx`, `dcmPostRaw`, `dcmSearchParams`, `dcmHidden`, `dcmDelete`, `dcmAppendLog`, `ASG_FETCH_MS`.
- Produces: `ccDoStep(next, row, fields) → {dispatched, msg}`, `ccDoStandbyOff(orderSeq, sKey, fields)`, `ccDoUnassign(barcode, orderSeq, fields)`, `ccDoDelivDelete(barcode, orderSeq)`, `ccFindDelivRow(barcode, orderSeq) → {ok, idx, sKey, junNum, delivDate, shop, status, reason}`.

- [x] **Step 1: 하네스 확장 + 테스트 (RED)** — `tests/orderitem-cancel-batch.test.js` 의 `build()`:

```js
const NAMES = ['ccTargetStatus', 'ccBuildCancelUrl', 'ccRedirectMsg', 'ccClassifyOutcome', 'ccRowCancelSeq',
               'ccRequeryReason', 'ccRowCurrentSetting', 'parseCurrentSettingArgs', 'ccNextStep', 'ccStepOutcome',
               'ccBuildUnassignUrl', 'cBuildStandbyUrl', 'ccDoCancel', 'ccDoStandbyOff', 'ccDoUnassign', 'ccDoDelivDelete', 'ccDoStep',
               'ccRunCancelBatch'];
// build(deps) 의 팩토리 앞부분에 추가:
//   'const ccFindDelivRow = deps.ccFindDelivRow; const dcmDelete = deps.dcmDelete; const dcmAppendLog = deps.dcmAppendLog;\n' +
//   'const CC_MAX_STEPS = 6;\n' +
// return 에 추가: ccDoStep, ccDoStandbyOff, ccDoUnassign, ccDoDelivDelete
```

`baseDeps` 에 기본 스텁을 더한다:

```js
    ccFindDelivRow: async () => ({ ok: false, reason: '스텁: 출고 건 없음' }),
    dcmDelete: async () => ({ ok: true, msg: '' }),
    dcmAppendLog: () => true,
```

테스트 추가:

```js
// ── 쓰기 4종 디스패치 (스펙 §4.4) ───────────────────────────────────────────
const F = () => ({ reqPage: '1', pageSize: '100' });
test('ccDoStandbyOff: POST orderItemStandby.do status1=O--&status2=OS-&sKey, 본문 idx=<seq>, dispatched=true', async () => {
  const deps = baseDeps(); const sb = build(deps);
  const d = await sb.ccDoStandbyOff('101', 'K1', F());
  assert.equal(d.dispatched, true);
  const c = deps.fetch.calls[0];
  assert.ok(c.url.startsWith('/jun/orderitem/orderItemStandby.do?'));
  const p = new URL('http://x' + c.url).searchParams;
  assert.equal(p.get('status1'), 'O--'); assert.equal(p.get('status2'), 'OS-'); assert.equal(p.get('sKey'), 'K1'); assert.equal(p.get('pageSize'), '100');
  assert.equal(c.opts.method, 'POST'); assert.equal(c.opts.credentials, 'include'); assert.equal(String(c.opts.body), 'idx=101');
});
test('ccDoStandbyOff: sKey 없으면 dispatched=false, fetch 없음 / fetch 예외는 dispatched=true(도달 불명)', async () => {
  const deps = baseDeps(); const sb = build(deps);
  assert.deepEqual(await sb.ccDoStandbyOff('101', '', F()), { dispatched: false, msg: 'URL 조립 실패(sKey 없음)' });
  assert.equal(deps.fetch.calls.length, 0);
  const deps2 = baseDeps({ fetch: async () => { throw new Error('net'); } }); const sb2 = build(deps2);
  assert.deepEqual(await sb2.ccDoStandbyOff('101', 'K1', F()), { dispatched: true, msg: '' });
});
test('ccDoUnassign: GET orderItemPopCurrentSettingCancel.do barcode+orderSeq+검색조건, dispatched=true; 빈 바코드면 false', async () => {
  const deps = baseDeps(); const sb = build(deps);
  const d = await sb.ccDoUnassign('2608ET', '101', F());
  assert.equal(d.dispatched, true);
  const c = deps.fetch.calls[0];
  assert.ok(c.url.startsWith('/jun/orderitem/orderItemPopCurrentSettingCancel.do?'));
  const p = new URL('http://x' + c.url).searchParams;
  assert.equal(p.get('barcode'), '2608ET'); assert.equal(p.get('orderSeq'), '101'); assert.equal(p.get('reqPage'), '1');
  assert.equal(c.opts.method, 'GET'); assert.equal(c.opts.credentials, 'include');
  assert.deepEqual(await sb.ccDoUnassign('', '101', F()), { dispatched: false, msg: 'URL 조립 실패(바코드/seq 없음)' });
  assert.equal(deps.fetch.calls.length, 1);
});
test('ccDoDelivDelete: 출고 건 찾기 → write-ahead 로그 → 삭제 POST 순서, 찾기 실패·로그 실패면 삭제 없음', async () => {
  const log = [], dels = [];
  const found = { ok: true, idx: '426106,250HHL,47295,101', sKey: 'DK', junNum: '000000010HR', delivDate: '26-09-15', shop: 'FASHION', status: '출고완료' };
  const deps = baseDeps({ ccFindDelivRow: async (bc, seq) => { log.push(['find', bc, seq]); return found; },
                          dcmAppendLog: (e) => { log.push(['log', e.phase, e.via, e.orderSeq, e.barcode, e.junNum, e.idx]); return true; },
                          dcmDelete: async (t, bc) => { dels.push([t.sKey, t.idx, bc]); log.push(['delete']); return { ok: true, msg: '' }; } });
  const sb = build(deps);
  assert.deepEqual(await sb.ccDoDelivDelete('250HHL', '101'), { dispatched: true, msg: '' });
  assert.deepEqual(dels, [['DK', '426106,250HHL,47295,101', '250HHL']]);
  assert.deepEqual(log.map(x => x[0]), ['find', 'log', 'delete', 'log'], '로그가 삭제보다 먼저(write-ahead), 뒤에 deleted 로그');
  assert.deepEqual(log[1], ['log', 'before_delete', 'bulkcancel', '101', '250HHL', '000000010HR', '426106,250HHL,47295,101']);
  // 찾기 실패
  const d2 = build(baseDeps({ ccFindDelivRow: async () => ({ ok: false, reason: '출고 건이 2건이라 특정 불가' }), dcmDelete: async () => { throw new Error('must not'); } }));
  assert.deepEqual(await d2.ccDoDelivDelete('250HHL', '101'), { dispatched: false, msg: '출고 건이 2건이라 특정 불가' });
  // 로그 실패
  const d3 = build(baseDeps({ ccFindDelivRow: async () => found, dcmAppendLog: () => false, dcmDelete: async () => { throw new Error('must not'); } }));
  assert.deepEqual(await d3.ccDoDelivDelete('250HHL', '101'), { dispatched: false, msg: '처리 로그를 남길 수 없어 삭제하지 않음' });
  // 삭제 POST 가 서버 msg 를 돌려주면 dispatched=true + msg(판정은 재조회가 한다)
  const d4 = build(baseDeps({ ccFindDelivRow: async () => found, dcmDelete: async () => ({ ok: false, msg: '삭제할 수 없습니다' }) }));
  assert.deepEqual(await d4.ccDoDelivDelete('250HHL', '101'), { dispatched: true, msg: '삭제할 수 없습니다' });
  // 삭제 POST 예외 → 도달 불명 → dispatched=true
  const d5 = build(baseDeps({ ccFindDelivRow: async () => found, dcmDelete: async () => { throw new Error('net'); } }));
  assert.deepEqual(await d5.ccDoDelivDelete('250HHL', '101'), { dispatched: true, msg: '' });
});
test('ccDoStep: 단계별로 알맞은 쓰기 함수 하나만 부른다, 모르는 단계는 dispatched=false', async () => {
  const deps = baseDeps({ ccFindDelivRow: async () => ({ ok: false, reason: 'x' }) }); const sb = build(deps);
  const row = { orderSeq: '101', sKey: 'K9' };
  await sb.ccDoStep({ kind: 'write', step: 'cancel', want: 'OC-' }, row, F());
  await sb.ccDoStep({ kind: 'write', step: 'standby-off', want: 'O--' }, row, F());
  await sb.ccDoStep({ kind: 'write', step: 'unassign', want: 'OS-', barcode: '2608ET' }, row, F());
  assert.deepEqual(deps.fetch.calls.map(c => c.url.split('?')[0]), ['/jun/orderitem/orderItemCancel.do', '/jun/orderitem/orderItemStandby.do', '/jun/orderitem/orderItemPopCurrentSettingCancel.do']);
  assert.equal(new URL('http://x' + deps.fetch.calls[0].url).searchParams.get('sKey'), 'K9');
  assert.deepEqual(await sb.ccDoStep({ kind: 'write', step: 'deliv-delete', want: 'I--', barcode: '250HHL' }, row, F()), { dispatched: false, msg: 'x' });
  assert.deepEqual(await sb.ccDoStep({ kind: 'write', step: 'nope' }, row, F()), { dispatched: false, msg: '알 수 없는 단계: nope' });
});
```

- [x] **Step 2: 실패 확인** — `node --test tests/orderitem-cancel-batch.test.js` → `ccDoStandbyOff 선언을 찾지 못했습니다`.

- [x] **Step 3: 구현** — `ccDoCancel` 바로 뒤에 추가:

```js
  //  본사확인취소 POST(⚠ 쓰기) — 네이티브 standby(form1, form3, 'O--', 'OS-') 와 같은 URL·본문(idx=<seq>). ccDoCancel 과 같은 dispatch 규약:
  //  URL 을 못 만들면 dispatched=false(쓰기 없었음), 보낸 뒤의 네트워크 오류·타임아웃은 dispatched=true(도달 불명 → 재조회로만 판정).
  async function ccDoStandbyOff(orderSeq, sKey, searchFields) {
    const url = cBuildStandbyUrl(sKey, searchFields, 'O--', 'OS-');
    if (!url) return { dispatched: false, msg: 'URL 조립 실패(sKey 없음)' };
    const body = new URLSearchParams();
    body.set('idx', String(orderSeq == null ? '' : orderSeq));
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, ASG_FETCH_MS);
    try {
      const r = await fetch(url, { method: 'POST', credentials: 'include', cache: 'no-cache', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: body.toString() });
      return { dispatched: true, msg: ccRedirectMsg(r.url) };
    } catch (e) {
      ccLog('본사확인취소 POST 오류(도달 여부 불명)', (e && e.message) || e);
      return { dispatched: true, msg: '' };
    } finally { clearTimeout(timer); }
  }
  //  선택취소 GET(⚠ 쓰기) — 팝업 cancelForm 과 같은 URL(스펙 §1.3, sKey 없음). dispatch 규약은 ccDoCancel 과 같다.
  async function ccDoUnassign(barcode, orderSeq, searchFields) {
    const url = ccBuildUnassignUrl(barcode, orderSeq, searchFields);
    if (!url) return { dispatched: false, msg: 'URL 조립 실패(바코드/seq 없음)' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, ASG_FETCH_MS);
    try {
      const r = await fetch(url, { method: 'GET', credentials: 'include', cache: 'no-cache', signal: ctrl.signal });
      return { dispatched: true, msg: ccRedirectMsg(r.url) };
    } catch (e) {
      ccLog('선택취소 GET 오류(도달 여부 불명)', (e && e.message) || e);
      return { dispatched: true, msg: '' };
    } finally { clearTimeout(timer); }
  }
  //  출고전표에서 이 주문의 출고 건을 특정한다(읽기). idx 토큰 [1]==바코드 && [3]==orderSeq 정확히 1건 + 상태 셀 '출고완료' + 응답 sKey.
  //  사이드바 출고취소의 dcmFindDeliv(바코드만·최신 1건)와 용도가 달라 따로 둔다. 열 인덱스는 dcmFindDeliv 와 같다(0 No·2 출고장번호·4 출고일·8 매장·14 상태).
  async function ccFindDelivRow(barcode, orderSeq) {
    try {
      const { html, doc } = await dcmPostRaw('/jun/delivitem/delivItemList.do?tcode=deliv_item', new URLSearchParams(dcmSearchParams(barcode)));
      const boxes = [...doc.querySelectorAll('input[name=idx]')];
      const pick = ccPickDelivIdx(boxes.map((b) => b.value || ''), barcode, orderSeq);
      if (!pick) return { ok: false, reason: '출고전표에 이 주문(' + orderSeq + ')의 ' + barcode + ' 출고 건이 없음' };
      if (pick.ambiguous) return { ok: false, reason: '출고 건이 ' + pick.ambiguous + '건이라 특정 불가' };
      const sKey = dcmHidden(html, 'sKey');
      if (!sKey) return { ok: false, reason: '출고전표 sKey 추출 실패' };
      const box = boxes.find((b) => (b.value || '') === pick.idx);
      const tr = box && box.closest ? box.closest('tr') : null;
      const c = tr ? [...tr.cells].map((x) => (x.textContent || '').replace(/\s+/g, ' ').trim()) : [];
      const status = c[14] || '';
      if (status !== '출고완료') return { ok: false, reason: '출고 건 상태가 출고완료가 아님(' + (status || '불명') + ')' };
      return { ok: true, idx: pick.idx, sKey: sKey, junNum: c[2] || '', delivDate: c[4] || '', shop: (c[8] || '').slice(0, 30), status: status };
    } catch (e) {
      ccLog('출고전표 조회 실패', (e && e.message) || e);
      return { ok: false, reason: '출고전표 조회 실패(네트워크/타임아웃)' };
    }
  }
  //  출고장 삭제(⚠ 쓰기): 특정 → write-ahead 로그(UB_DCM_LOG, §5.5a 규칙: 못 남기면 지우지 않는다) → dcmDelete POST.
  //  서버 msg 는 표시용 — 삭제됐는지는 호출부가 주문 재조회(I--)로만 판정한다.
  async function ccDoDelivDelete(barcode, orderSeq) {
    const f = await ccFindDelivRow(barcode, orderSeq);
    if (!f.ok) return { dispatched: false, msg: f.reason };
    if (!dcmAppendLog({ phase: 'before_delete', via: 'bulkcancel', orderSeq: orderSeq, barcode: barcode, junNum: f.junNum,
                        delivDate: f.delivDate, shop: f.shop, status: f.status, idx: f.idx })) {
      return { dispatched: false, msg: '처리 로그를 남길 수 없어 삭제하지 않음' };
    }
    try {
      const d = await dcmDelete({ sKey: f.sKey, idx: f.idx }, barcode);
      if (d.ok) dcmAppendLog({ phase: 'deleted', via: 'bulkcancel', orderSeq: orderSeq, barcode: barcode, junNum: f.junNum });
      return { dispatched: true, msg: d.msg || '' };
    } catch (e) {
      ccLog('출고장 삭제 POST 오류(도달 여부 불명)', (e && e.message) || e);
      return { dispatched: true, msg: '' };
    }
  }
  //  단계 → 쓰기 하나. next 는 ccNextStep 의 write 결과, row 는 그 판정의 근거 응답(sKey 를 여기서 꺼낸다).
  async function ccDoStep(next, row, searchFields) {
    const step = next && next.step;
    if (step === 'cancel') return ccDoCancel(row.orderSeq, row.sKey, searchFields);
    if (step === 'standby-off') return ccDoStandbyOff(row.orderSeq, row.sKey, searchFields);
    if (step === 'unassign') return ccDoUnassign(next.barcode, row.orderSeq, searchFields);
    if (step === 'deliv-delete') return ccDoDelivDelete(next.barcode, row.orderSeq);
    return { dispatched: false, msg: '알 수 없는 단계: ' + step };
  }
```

- [x] **Step 4: 통과 확인** — `node --test tests/orderitem-cancel-batch.test.js` → 새 테스트 PASS, 기존 테스트도 PASS(ccRunCancelBatch 는 아직 옛 본문 — 추출만 늘어남).

- [x] **Step 5: 커밋**

```bash
git add src/skin.js tests/orderitem-cancel-batch.test.js
git commit -m "feat(일괄취소): 쓰기 4종 디스패치 — 본사확인취소 POST·선택취소 GET·출고장 삭제(특정+write-ahead)"
```

---

### Task 5: 건별 루프 상태기계 (`ccRunCancelBatch`)

**Files:**
- Modify: `src/skin.js` (`ccRunCancelBatch` ~6456 전체 교체)
- Test: `tests/orderitem-cancel-batch.test.js`

**Interfaces:**
- Consumes: Task 2·4 의 함수 전부, `fetchOrderRow`, `cReadSearchFields`, `cUpdateRow`, `ASG_VERIFY_MS`, `cBatchBusy`.
- Produces: `ccRunCancelBatch(targets, progress, isAborted) → {success, failed:[{orderSeq, reason}], uncertain:[{orderSeq, reason}], processed, total}` (모양 불변).

- [x] **Step 1: 하네스의 재조회 스텁을 사슬용으로 넓히고 테스트 추가 (RED)**

`makeRequery` 의 `rowHtml`/반환을 이렇게 바꾼다(기존 O-- 동작은 그대로):

```js
    // 서버처럼: O-- 행엔 del('<seq>') 링크, I--/OS- 행엔 currentSetting(...) 링크(바코드 = r.assignedBarcode; r.link===false 면 발주주문처럼 링크 없음), T-- 는 링크 없음.
    let rowHtml = '<tr><td>' + (r ? r.code : '') + '</td></tr>';
    if (r && r.code === 'O--') rowHtml = '<tr><td>' + r.code + '</td><td><a href="javascript:del(\'' + orderSeq + '\');">취소</a></td></tr>';
    else if (r && (r.code === 'I--' || r.code === 'OS-') && r.link !== false) rowHtml = '<tr><td>' + r.code + '</td><td><a href="javascript:currentSetting(\'7043\',\'' + orderSeq + '\',\'' + (r.assignedBarcode || '') + '\',\'NU\',\'1\',\'20260915\')">x</a></td></tr>';
    const ret = !r
      ? { found: false, orderSeq, code: null, text: '', assignedBarcode: '', duplicate: false, hasMore: false, loginExpired: false, rowHtml: '', sKey }
      : Object.assign({ found: true, orderSeq, text: r.code, assignedBarcode: '', duplicate: false, hasMore: false, loginExpired: false, rowHtml, sKey }, r);
```

기존 테스트 3개를 새 계약으로 바꾼다. 먼저 '미확정: dispatch 후 재조회가 계속 O-- 이면 …' 의 단언 한 줄:

```js
  assert.match(r.uncertain[0].reason, /^취소 처리 미확정 — 현재 상태: O-- · 수동 확인 필요 · 서버: 취소 불가$/);   // 문구에 단계·현재 상태가 들어간다(스펙 §4.3)
```

그리고 아래 두 개:

```js
test('재조회 OS-(본사확인): 이제 대상 — 본사확인취소 POST → O-- → 취소 GET → OC- (쓰기 2회, 각 sKey 는 직전 응답의 것)', async () => {
  const deps = baseDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'OS-' }, { code: 'O--' }, { code: 'OC-' }] }) });
  const sb = build(deps);
  const r = await sb.ccRunCancelBatch([{ orderSeq: '101', code: 'OS-', orderDate: '20260911' }], () => {}, () => false);
  assert.equal(r.success, 1); assert.deepEqual(r.failed, []); assert.deepEqual(r.uncertain, []);
  assert.deepEqual(deps.fetch.calls.map(c => c.url.split('?')[0]), ['/jun/orderitem/orderItemStandby.do', '/jun/orderitem/orderItemCancel.do']);
  const q = deps.fetchOrderRow.calls;
  assert.equal(new URL('http://x' + deps.fetch.calls[0].url).searchParams.get('sKey'), q[0].ret.sKey, '본사확인취소 키 = OS- 를 본 응답');
  assert.equal(new URL('http://x' + deps.fetch.calls[1].url).searchParams.get('sKey'), q[1].ret.sKey, '취소 키 = O-- 를 본(직전 확인) 응답');
  assert.deepEqual(q.map(c => c.orderSeq), ['101', '101', '101'], '재조회 3회: 처음 + 단계 확인 2회(확인 응답이 다음 단계의 근거)');
  assert.deepEqual(deps.updates, [{ seq: '101', code: 'OC-' }]);
});
test('이미 취소됨(재조회 OC-): 목표 상태라 쓰기 없이 success', async () => {
  const deps = baseDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'OC-' }] }) });
  const r = await build(deps).ccRunCancelBatch([T1], () => {}, () => false);
  assert.equal(r.success, 1); assert.equal(deps.fetch.calls.length, 0);
  assert.deepEqual(deps.updates, [{ seq: '101', code: 'OC-' }]);
});
```

새 테스트를 추가한다:

```js
// ── 사슬 (스펙 §4.3) ─────────────────────────────────────────────────────────
const TT = { orderSeq: '101', code: 'T--', orderDate: '20260916' };
function chainDeps(over) {
  const dels = [], logs = [];
  return Object.assign(baseDeps({
    fetchOrderRow: makeRequery({ '101': [{ code: 'T--', assignedBarcode: '250HHL' }, { code: 'I--', assignedBarcode: '250HHL' }, { code: 'OS-', assignedBarcode: '' }, { code: 'O--' }, { code: 'OC-' }] }),
    ccFindDelivRow: async (bc, seq) => { logs.push(['find', bc, seq]); return { ok: true, idx: '426106,250HHL,47295,101', sKey: 'DK', junNum: '000000010HR', delivDate: '26-09-15', shop: 'FASHION', status: '출고완료' }; },
    dcmAppendLog: (e) => { logs.push(['log', e.phase]); return true; },
    dcmDelete: async (t, bc) => { dels.push([t.sKey, t.idx, bc]); return { ok: true, msg: '' }; }
  }), { dels, logs }, over || {});
}
test('사슬 전체: T-- → 출고장 삭제 → I-- → 선택취소 → OS- → 본사확인취소 → O-- → 취소 → OC- (요청 4개 순서·인자·sKey 원천)', async () => {
  const deps = chainDeps(); const sb = build(deps);
  const prog = [];
  const r = await sb.ccRunCancelBatch([TT], (m) => prog.push(m), () => false);
  assert.equal(r.success, 1, JSON.stringify(r)); assert.deepEqual(r.failed, []); assert.deepEqual(r.uncertain, []); assert.equal(r.processed, 1);
  assert.deepEqual(deps.dels, [['DK', '426106,250HHL,47295,101', '250HHL']]);
  assert.deepEqual(deps.logs, [['find', '250HHL', '101'], ['log', 'before_delete'], ['log', 'deleted']]);
  assert.deepEqual(deps.fetch.calls.map(c => c.url.split('?')[0]), ['/jun/orderitem/orderItemPopCurrentSettingCancel.do', '/jun/orderitem/orderItemStandby.do', '/jun/orderitem/orderItemCancel.do']);
  const u = new URL('http://x' + deps.fetch.calls[0].url).searchParams;
  assert.equal(u.get('barcode'), '250HHL'); assert.equal(u.get('orderSeq'), '101');
  const q = deps.fetchOrderRow.calls;
  assert.deepEqual(q.map(c => c.ret.code), ['T--', 'I--', 'OS-', 'O--', 'OC-'], '재조회 5회: 처음 + 단계 확인 4회');
  assert.equal(new URL('http://x' + deps.fetch.calls[1].url).searchParams.get('sKey'), q[2].ret.sKey, '본사확인취소 키 = OS- 확인 응답');
  assert.equal(new URL('http://x' + deps.fetch.calls[2].url).searchParams.get('sKey'), q[3].ret.sKey, '취소 키 = O-- 확인 응답');
  assert.deepEqual(deps.updates, [{ seq: '101', code: 'OC-' }], '화면 갱신은 끝 상태 1회');
  assert.ok(prog.some(m => /출고장 삭제\(250HHL\)/.test(m)) && prog.some(m => /선택취소\(250HHL\)/.test(m)) && prog.some(m => /본사확인취소/.test(m)) && prog.some(m => /취소 처리/.test(m)), prog.join(' | '));
  assert.equal(sb.busy(), false);
});
test('사슬: I-- 에서 시작하면 출고장 조회·삭제 없이 선택취소부터', async () => {
  const deps = chainDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'I--', assignedBarcode: '2608ET' }, { code: 'OS-' }, { code: 'O--' }, { code: 'OC-' }] }) });
  const r = await build(deps).ccRunCancelBatch([{ orderSeq: '101', code: 'I--', orderDate: '20260916' }], () => {}, () => false);
  assert.equal(r.success, 1); assert.deepEqual(deps.logs, []); assert.deepEqual(deps.dels, []);
  assert.equal(new URL('http://x' + deps.fetch.calls[0].url).searchParams.get('barcode'), '2608ET');
});
test('사슬 미확정: 선택취소 뒤 재조회가 계속 I-- 면 uncertain — 문구에 단계·현재 상태, 다음 건은 손대지 않는다', async () => {
  const deps = chainDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'T--', assignedBarcode: '250HHL' }, { code: 'I--', assignedBarcode: '250HHL' }], '102': [{ code: 'O--' }, { code: 'OC-' }] }) });
  const r = await build(deps).ccRunCancelBatch([TT, T2], () => {}, () => false);
  assert.equal(r.success, 0); assert.equal(r.processed, 1); assert.deepEqual(r.failed, []);
  assert.equal(r.uncertain.length, 1); assert.equal(r.uncertain[0].orderSeq, '101');
  assert.match(r.uncertain[0].reason, /^선택취소\(250HHL\) 미확정 — 현재 상태: I--/);
  assert.equal(deps.fetch.calls.length, 1, '선택취소 GET 1회, 그 뒤 쓰기 없음(102 도 안 감)');
  assert.deepEqual(deps.updates, [{ seq: '101', code: 'I--' }], '미확정이라도 서버 상태로 화면 갱신');
});
test('사슬 실패: 출고 건을 특정 못 하면 삭제 없이 failed(사유), 중단', async () => {
  const deps = chainDeps({ ccFindDelivRow: async () => ({ ok: false, reason: '출고 건이 2건이라 특정 불가' }) });
  const r = await build(deps).ccRunCancelBatch([TT], () => {}, () => false);
  assert.deepEqual(r.failed, [{ orderSeq: '101', reason: '출고장 삭제(250HHL) 실패: 출고 건이 2건이라 특정 불가' }]);
  assert.deepEqual(deps.dels, []); assert.equal(deps.fetch.calls.length, 0); assert.equal(r.processed, 1);
});
test('사슬 실패: 발주주문 입고완료(링크 없음)는 쓰기 없이 failed', async () => {
  const deps = chainDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'I--', assignedBarcode: '2609AY', link: false }] }) });
  const r = await build(deps).ccRunCancelBatch([{ orderSeq: '101', code: 'I--', orderDate: '20260916' }], () => {}, () => false);
  assert.deepEqual(r.failed, [{ orderSeq: '101', reason: '입고완료 — 배정 팝업 링크 없음(발주주문이거나 본사 계정이 아님), 수동' }]);
  assert.equal(deps.fetch.calls.length, 0); assert.deepEqual(deps.updates, [{ seq: '101', code: 'I--' }]);
});
test('사슬 실패: 링크 바코드와 상태 셀 바코드가 다르면 선택취소를 보내지 않는다', async () => {
  const deps = chainDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'I--', assignedBarcode: '2608ET', rowHtml: '<a href="javascript:currentSetting(\'1\',\'101\',\'2608EU\',\'NU\',\'1\',\'20260915\')">x</a>' }] }) });
  const r = await build(deps).ccRunCancelBatch([{ orderSeq: '101', code: 'I--', orderDate: '20260916' }], () => {}, () => false);
  assert.match(r.failed[0].reason, /배정 바코드 불일치/); assert.equal(deps.fetch.calls.length, 0);
});
test('사슬 중 중단: 한 단계 쓴 뒤 [중단] 이면 uncertain("중단 — 현재 상태") 로 남고 processed 는 줄지 않는다', async () => {
  let n = 0;
  const deps = chainDeps();
  // isAborted 호출: ① 건 시작 ② 첫 쓰기(출고장 삭제) 직전 ③ 두 번째 쓰기(선택취소) 직전 → ③ 에서 true
  const r = await build(deps).ccRunCancelBatch([TT], () => {}, () => (++n > 2));
  assert.equal(r.processed, 1);
  assert.equal(r.uncertain.length, 1); assert.match(r.uncertain[0].reason, /^중단 — 현재 상태: /);
  assert.ok(deps.dels.length === 1, '첫 쓰기는 나갔다');
});
test('사슬 중 재조회 실패(found=false): 이미 쓴 단계 수를 문구에 남기고 failed', async () => {
  const deps = chainDeps({ fetchOrderRow: makeRequery({ '101': [{ code: 'T--', assignedBarcode: '250HHL' }, { code: 'I--', assignedBarcode: '250HHL' }] }) });
  // 두 번째 이후 재조회를 found=false 로: 스크립트가 끝난 뒤의 값은 마지막 값 반복이라, 확인 뒤 다음 단계 판정에서 found=false 를 내려면 스텁을 감싼다
  const inner = deps.fetchOrderRow; let k = 0;
  deps.fetchOrderRow = async (s, d) => { const r = await inner(s, d); k++; return k >= 3 ? Object.assign({}, r, { found: false, code: null }) : r; };
  const r = await build(deps).ccRunCancelBatch([TT], () => {}, () => false);
  // 출고장 삭제 확인(k=2, I--)은 성공이고 그 응답이 곧 다음 근거라 판정용 재조회는 없다 → 선택취소 GET 뒤 확인 재조회(k≥3)가 found=false → 미확정
  assert.deepEqual(r.failed, []);
  assert.equal(r.uncertain.length, 1); assert.match(r.uncertain[0].reason, /^선택취소\(250HHL\) 미확정 — 현재 상태: 불명/);
  assert.equal(deps.fetch.calls.length, 1);
});
test('단계 상한: 루프는 CC_MAX_STEPS(6) 로 막혀 있다(정상 전이로는 5회 안에 끝나 도달 불가 — 방어 상수 핀)', () => {
  const src = extractFn(SRC, 'ccRunCancelBatch');
  assert.ok(/step < CC_MAX_STEPS/.test(src) && /const CC_MAX_STEPS = 6;/.test(SRC), '상한 상수와 루프 조건');
});
```

- [x] **Step 2: 실패 확인** — `node --test tests/orderitem-cancel-batch.test.js` → 사슬 테스트들 FAIL(옛 루프는 T--/I--/OS- 를 '상태 부적합' 으로 실패시킨다).

- [x] **Step 3: 구현** — `ccRunCancelBatch` 를 통째로 교체:

```js
  //  건마다 최대 CC_MAX_STEPS 회: 재조회 → ccNextStep → 쓰기 1회 → 목표 상태 확인(폴링) → 그 확인 응답을 다음 단계의 근거로. 정상 전이는 5회 안에 끝난다.
  const CC_MAX_STEPS = 6;
  //  배치 오케스트레이터(스펙 2026-09-16 §4.3). 순차, 첫 실패·미확정에서 중단. progress(msg)=승인창 진행 표시,
  //  isAborted()=사용자 중단 요청(매 쓰기 직전에 본다). cBatchBusy 는 작업C 와 공유한다.
  //  한 건 = 상태기계: 재조회 row → ccNextStep(row) 가 고른 쓰기 하나 → 목표 상태를 재조회로 확인 → 그 응답(vRow)이 다음 단계의 근거(상태·sKey·링크가 한 응답).
  async function ccRunCancelBatch(targets, progress, isAborted) {
    const results = { success: 0, failed: [], uncertain: [], processed: 0, total: targets.length };
    if (cBatchBusy) return results;
    cBatchBusy = true;
    let curSeq = null;                                   // 예외 경로에서 어느 건이었는지 남기려고
    try {
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const orderSeq = t.orderSeq;
        curSeq = orderSeq;
        const tag = (i + 1) + '/' + targets.length + ' · ' + orderSeq + ' · ';
        if (!(state.ubSkin && state.ubHqConfirm)) { ccLog('게이트 해제 → 중단'); break; }
        if (isAborted && isAborted()) { ccLog('사용자 중단 요청 → 중단'); break; }
        results.processed++;
        const orderDate = t.orderDate || '';
        if (!orderDate) { results.failed.push({ orderSeq: orderSeq, reason: '주문일 파싱 실패' }); break; }
        // 1) 쓰기 직전 재조회 — 승인창의 상태는 승인용이지 쓰기 근거가 아니다
        progress(tag + '상태 확인');
        let row = await fetchOrderRow(orderSeq, orderDate);
        let written = 0;                                 // 이 건에 보낸 쓰기 수 — 중단 회계와 문구에 쓴다
        let stop = false;                                // 이 건에서 배치를 멈춘다
        let done = false;
        const stateText = (r) => (r && r.found) ? (r.text || r.code || '불명') : '불명';
        for (let step = 0; step < CC_MAX_STEPS && !stop && !done; step++) {
          if (!row.found) {
            results.failed.push({ orderSeq: orderSeq, reason: ccRequeryReason(row) + (written ? ' — ' + written + '단계 진행 뒤' : '') });
            stop = true; break;
          }
          // 2) 다음 쓰기 하나(순수 판정). done 이면 이 건 성공, fail 이면 서버 진실로 화면 갱신 후 중단.
          const next = ccNextStep(row);
          if (next.kind === 'done') { results.success++; cUpdateRow(orderSeq, row); done = true; break; }
          if (next.kind === 'fail') {
            results.failed.push({ orderSeq: orderSeq, reason: (written ? '진행 중 실패 — 현재 상태: ' + stateText(row) + ' · ' : '') + next.reason });
            cUpdateRow(orderSeq, row); stop = true; break;
          }
          // 3) 재조회를 기다리는 동안 게이트가 꺼졌거나 [중단] 을 눌렀으면 쓰지 않는다(4R Terra P1).
          //    아직 아무 것도 안 쓴 건은 processed 에서 되돌리고(요약이 '처리 완료' 로 나오면 안 된다 — Opus P2-1),
          //    이미 한 단계 이상 썼으면 중간 상태를 숨기지 않고 미확정으로 남긴다(스펙 §4.3).
          if (!(state.ubSkin && state.ubHqConfirm) || (isAborted && isAborted())) {
            if (!written) results.processed--;
            else results.uncertain.push({ orderSeq: orderSeq, reason: '중단 — 현재 상태: ' + stateText(row) + ' · 수동 확인' });
            ccLog('게이트 해제/중단 요청(쓰기 직전) → 중단'); stop = true; break;
          }
          progress(tag + next.label);
          // 4) 쓰기 1회(⚠) — dispatch. 못 보냈으면(URL·특정·로그 실패) 쓰기 없었음 = 확정 실패.
          const d = await ccDoStep(next, row, cReadSearchFields());
          if (!d.dispatched) {
            results.failed.push({ orderSeq: orderSeq, reason: next.label + ' 실패: ' + d.msg + (written ? ' — 현재 상태: ' + stateText(row) : '') });
            stop = true; break;
          }
          written++;
          // 5) 목표 상태를 재조회로만 판정 — 최대 ASG_VERIFY_MS. dispatch 뒤 재시도 없음.
          progress(tag + next.label + ' 확인');
          let vRow = null;
          const dl = Date.now() + ASG_VERIFY_MS;
          while (Date.now() < dl) {
            vRow = await fetchOrderRow(orderSeq, orderDate);
            if (ccStepOutcome(next, vRow) === 'success') break;
            await new Promise(function (r) { setTimeout(r, 1500); });
          }
          if (ccStepOutcome(next, vRow) !== 'success') {
            results.uncertain.push({ orderSeq: orderSeq, reason: next.label + ' 미확정 — 현재 상태: ' + stateText(vRow) + ' · 수동 확인 필요' + (d.msg ? ' · 서버: ' + d.msg : '') });
            if (vRow && vRow.found) cUpdateRow(orderSeq, vRow);
            stop = true; break;
          }
          row = vRow;                                    // 다음 단계의 근거 = 방금 목표를 확인한 그 응답(새 sKey·링크·상태)
        }
        if (!stop && !done) {
          results.uncertain.push({ orderSeq: orderSeq, reason: '단계 상한(' + CC_MAX_STEPS + ') 초과 — 현재 상태: ' + stateText(row) + ' · 수동 확인' });
          stop = true;
        }
        if (stop) break;
      }
    } catch (e) {
      ccLog('배치 실행 오류', e);
      // 예외로 끊긴 건은 실패로 남긴다 — 빈 결과가 '처리 완료' 로 보이면 안 된다(Opus P2-1)
      results.failed.push({ orderSeq: curSeq, reason: '실행 오류: ' + ((e && e.message) || e) });
    } finally {
      cBatchBusy = false;
    }
    return results;
  }
```

- [x] **Step 4: 통과 확인** — `node --test tests/orderitem-cancel-batch.test.js tests/orderitem-cancel.test.js tests/orderitem-cancel-skey.test.js` → 전부 PASS. 기존 O-- 테스트의 재조회 횟수·GET 횟수·갱신 횟수 단언이 그대로 통과해야 한다(통과하지 않으면 루프가 재조회를 더 부르고 있다는 뜻 — `row = vRow` 를 확인).

- [x] **Step 5: 변이 확인 (수동)** — 다음을 하나씩 바꿔 대응 테스트가 FAIL 하는지 보고 되돌린다: ① `row = vRow;` 삭제 → 사슬 전체 테스트의 재조회 횟수/키 단언 FAIL ② `if (!written) results.processed--;` 의 조건 제거 → 중단 테스트 FAIL ③ `ccStepOutcome(next, vRow) !== 'success'` 를 `false` 로 → 미확정 테스트 FAIL ④ 출고장 삭제 분기에서 `dcmAppendLog` 결과 무시 → Task 4 로그 실패 테스트 FAIL.

- [x] **Step 6: 커밋**

```bash
git add src/skin.js tests/orderitem-cancel-batch.test.js
git commit -m "feat(일괄취소): 건별 루프를 상태 사슬로 — 재조회→다음 쓰기 하나→목표 확인, OC- 까지"
```

---

### Task 6: 승인창 — 행별 사슬 표시·경고 문구

**Files:**
- Modify: `src/skin.js` (`ccShowApprovalDialog` ~6536 의 bodyHtml 조립)
- Test: `tests/orderitem-cancel-batch.test.js` (`buildDialog` 하네스)

**Interfaces:**
- Consumes: `ccChainLabel(code, cs)`.

- [x] **Step 1: 테스트 (RED)** — `buildDialog` 의 `names` 를 `['ccChainLabel', 'ccShowApprovalDialog']` 로 바꾸고(ccChainLabel 은 표를 함수 안에 둬서 단독 추출된다 — Task 1) 다음을 추가:

```js
test('승인창: 대상 행마다 "orderSeq — 현재 상태 → 거칠 단계" 를 보여주고, 출고장 삭제·재고 반환 경고를 명시한다', () => {
  const document = fakeDom();
  const sb = buildDialog({ document, ccRunCancelBatch: async () => ({ success: 0, failed: [], uncertain: [], processed: 0, total: 0 }) });
  sb.ccShowApprovalDialog({ targets: [
      { orderSeq: '1', code: 'T--', orderDate: '20260916', cs: { has: false, barcode: '250HHL' } },
      { orderSeq: '2', code: 'I--', orderDate: '20260916', cs: { has: true, barcode: '2608ET' } },
      { orderSeq: '3', code: 'O--', orderDate: '20260916' }
    ], excluded: [{ orderSeq: '4', code: 'TS-', reason: '출고확인(매장재고) — 매장이 입고 확인한 건, 수동' }], duplicate: false });
  const card = document.body.children[0].children[0];
  const html = card.innerHTML;
  assert.ok(/1 — 출고완료 \(250HHL\) → 출고장 삭제 · 선택취소 · 본사확인취소 · 취소/.test(html), html);
  assert.ok(/2 — 입고완료 \(2608ET\) → 선택취소 · 본사확인취소 · 취소/.test(html));
  assert.ok(/3 — 주문완료 → 취소/.test(html));
  assert.ok(/4 — 출고확인\(매장재고\)/.test(html), '제외 사유');
  assert.ok(/출고완료 건은 출고장 삭제, 입고완료 건은 재고 반환\(선택취소\)이 함께 실행됩니다\. 되돌릴 수 없습니다\./.test(html));
  assert.ok(/취소된 주문서는 복구되지 않습니다\./.test(html), 'ERP 원문 경고는 그대로');
});
```

- [x] **Step 2: 실패 확인** — `node --test tests/orderitem-cancel-batch.test.js` → 새 테스트 FAIL.

- [x] **Step 3: 구현** — `ccShowApprovalDialog` 의 else 분기:

```js
      } else {
        bodyHtml = '<div class="ub-hq-sum">총 ' + total + '건 중 대상 <b>' + targets.length +
                   '건</b> / 제외 ' + excluded.length + '건</div>';
        if (targets.length) {
          //  행마다 현재 상태와 거칠 단계(표시 전용 — 쓰기 근거는 실행 중 재조회다)
          const items = targets.map(t => '<li>' + esc(t.orderSeq) + ' — ' + esc(ccChainLabel(t.code, t.cs) || t.code) + '</li>').join('');
          bodyHtml += '<div class="ub-hq-ex"><ul>' + items + '</ul></div>';
        }
        if (excluded.length) {
          const items = excluded.map(x => '<li>' + esc(x.orderSeq) + ' — ' + esc(x.reason) +
                        (x.code ? ' (' + esc(x.code) + ')' : '') + '</li>').join('');
          bodyHtml += '<div class="ub-hq-ex"><ul>' + items + '</ul></div>';
        }
        if (targets.length) {
          bodyHtml += '<div class="ub-hq-warn" style="margin-top:10px">취소된 주문서는 복구되지 않습니다.</div>' +
                      '<div class="ub-hq-note">출고완료 건은 출고장 삭제, 입고완료 건은 재고 반환(선택취소)이 함께 실행됩니다. 되돌릴 수 없습니다.</div>';
        }
      }
```

- [x] **Step 4: 통과 확인** — `node --test tests/orderitem-cancel-batch.test.js tests/orderitem-cancel.test.js` → PASS.

- [x] **Step 5: 커밋**

```bash
git add src/skin.js tests/orderitem-cancel-batch.test.js
git commit -m "feat(일괄취소): 승인창에 행별 사슬 단계와 출고장 삭제·재고 반환 경고"
```

---

### Task 7: 팝업 설명·문서·버전·배포 준비

**Files:**
- Modify: `popup/popup.html` (게이트 스위치 '주문전표 일괄 처리' 설명 문구 — `grep -n "일괄" popup/popup.html` 로 위치 확인)
- Modify: `docs/superpowers/specs/2026-09-16-orderitem-cancel-chain-design.md` (§3 표의 `cDoStandby` 인자 확장 → **미변경**으로, `ccDoStandbyOff` 신규로 정정 · §4.3 "성공 → cUpdateRow(vRow)" 를 "화면 갱신은 그 건이 끝날 때(성공·실패·미확정) 1회" 로 정정 · 첫 재조회가 OC- 면 쓰기 없이 성공으로 센다 명시)
- Modify: `docs/superpowers/specs/2026-09-11-orderitem-bulk-cancel-design.md` 머리에 한 줄: "2026-09-16 확장 — 대상 상태·루프는 `2026-09-16-orderitem-cancel-chain-design.md` 가 정본"
- Modify: `manifest.json` version `4.2.7` → `pwsh -NoProfile -File build-shell-index.ps1` → `shell-files.json`
- Test: `node --test tests/loader-integrity.test.js`

- [x] **Step 1: 팝업 문구** — 스위치 설명에 "출고완료·입고완료·본사확인 건은 출고장 삭제·선택취소·본사확인취소를 거쳐 취소" 한 구절을 덧붙인다(마크업 구조는 건드리지 않는다).
- [x] **Step 2: 스펙 정정** 위 3건.
- [x] **Step 3: 버전·인덱스** — `manifest.json` 4.2.7, `pwsh -NoProfile -File build-shell-index.ps1`, `node --test tests/loader-integrity.test.js` PASS.
- [x] **Step 4: 전체 게이트** — `node --test tests/orderitem-cancel.test.js tests/orderitem-cancel-batch.test.js tests/orderitem-cancel-skey.test.js tests/orderitem-c.test.js tests/orderitem-c2a.test.js tests/orderitem-c2b.test.js tests/orderitem-assign.test.js tests/loader-integrity.test.js` → fail 0.
- [x] **Step 5: 커밋**

```bash
git add popup/popup.html docs manifest.json shell-files.json
git commit -m "chore(일괄취소): 팝업 설명·스펙 정정·SHELL 4.2.7"
```

---

### Task 8: 읽기 전용 라이브 확인 + 검수(T3) + 배포

**Files:** `docs/REVIEW-LEDGER.md` (회차 기록), 메모리 `project_ubishop_barcode_ext.md`.

- [x] **Step 1: 읽기 전용 라이브 확인** — 로컬 stable 폴더에 브랜치 코드를 올리고(트레이 앱 D102LabelPrinter 를 먼저 끈다 — ExtSync 가 20분마다 되돌린다) 주문전표에서 출고완료·입고완료(재고주문/발주주문)·본사확인·출고확인 행을 하나씩 체크 → [일괄취소] → **승인창만 열어** 행별 문구·제외 사유를 확인하고 [닫기]. 쓰기는 하지 않는다. 결과를 스펙 §1 뒤에 한 줄로 남긴다.
- [x] **Step 2: 검수 T3** — `REVIEW-BRIEF.tmp.md`(원장 '누적 판정' 첨부, diff = `git diff main..HEAD -- src/skin.js tests/orderitem-cancel.test.js tests/orderitem-cancel-batch.test.js tests/orderitem-c.test.js popup/popup.html`)로 Terra 1R → 채택 지적 수정 → Terra 재검수(채택 0 까지) → Opus 5 1회 → DeepSeek 교차 1회. Fable 없음. 각 라운드 `usage_daily` 전후 측정. 채택/기각과 근거를 원장에.
- [x] **Step 3: 배포** — main 병합 → push → ExtSync 반영(20분). 메모리 갱신.
- [x] **Step 4: 라이브 쓰기 1건** — 사장님이 지정한 출고완료 실제 건 1건으로 사슬 전체를 사장님 입회 하에 실행하고, 결과(각 단계 상태·소요 시간·출고장 번호)를 스펙 §1 뒤에 기록한다.
