# 주문 전표 일괄취소 확장 — 상태 사슬 취소 설계 (2026-09-16)

주문전표(`orderItemList.do`)의 `[일괄취소]`(v4.1.9, `skin.js` §5.11)를 **주문완료(O--) 밖의 상태까지** 넓힌다.
출고완료·입고완료·본사확인 건을 체크하면, 네이티브에서 사람이 손으로 거치는 순서 그대로
**출고장 삭제 → 선택취소 → 본사확인취소 → 취소** 를 건마다 이어서 실행해 주문취소(OC-)까지 보낸다.

- 사장님 요청(2026-09-16): "출고 전표(`delivItemList.do?tcode=deliv_item`)에서 해당 바코드 전체 날짜 검색으로 출고 내역 삭제 후 →
  입고완료 상태일 때 클릭 후 뜨는 팝업창에서 선택취소를 누른 후 본사확인 상태가 되면, 기존처럼 취소까지 이어지게".
- 이 문서는 `2026-09-11-orderitem-bulk-cancel-design.md` 위에 얹는다. 그 문서 §2 "본사확인(OS-) 행 제외" 와 §8 "OS- 자동 본사확인취소 → 취소 연쇄는 범위 외"
  는 **이 결정으로 뒤집힌다**(사장님 결정, 2026-09-16). 나머지(URL 계약·판정 규약·승인창·busy·게이트)는 그대로 유효하다.

---

## 1. 라이브 실측 사실 (2026-09-16, 운영 ERP, 읽기만)

추측이 아니라 실제 응답·인라인 함수 소스에서 확인한 계약이다. 이 값이 바뀌면 설계가 깨진다.

### 1.1 상태별 행 모양 (최근 60일, 상태 필터 조회)

| 상태 | 행 수 | `currentSetting(...)` 링크 | 상태 셀 |
|---|---|---|---|
| 입고완료 `I--` | 100 | **96** — 없는 4건은 전부 **발주주문**(`고객(메인석)발주주문`·`고객(상품)발주주문`, 공장 발주 → 입고) | `입고완료 (2608ET)` |
| 출고완료 `T--` | 96 | **0** | `출고완료 (250HHL)` — 괄호 안이 바코드 |
| 출고확인 `TS-` | 100 | **0** | `출고확인 (2609DH)` |
| 본사확인 `OS-` | 22 | 22 — 3번째 인자(바코드) `''` | `본사확인` |

→ 출고완료·출고확인 행에는 배정 팝업 링크가 없다. **출고장을 지워야 입고완료로 돌아가고 그때 팝업이 열린다** — 사장님이 말한 순서와 일치한다.
→ 입고완료라도 **발주주문은 팝업 자체가 없다**(선택취소 경로가 없다) → 이 설계의 대상이 아니다.

### 1.2 출고전표(`delivItemList.do`) 행의 `idx` 값 = `<출고seq>,<바코드>,<?>,<주문 orderSeq>`

- 예: `426106,250HHL,47295,389513` — 2번째 바코드, **4번째가 주문전표의 orderSeq**.
- 출고완료 주문 9건의 바코드로 전체기간(2000-01-01~오늘, `searchSortType=seq`, `searchDateType=delivDate`) 조회: **9/9 에서 바코드 일치 행이 정확히 1건이고 4번째 토큰 == 그 주문의 orderSeq.**
- 주문과 무관한 출고(기존 출고취소 스펙의 예 `423961,26079J,46885,0`)는 4번째가 `0`.
- 행 마지막 셀(상태) = `출고완료` / `출고확인`. 입고완료 바코드(2608ET·250HHM)는 출고 기록 0건.
- 삭제 계약은 기존 §5.5a 그대로: `POST /jun/delivitem/delivItemDelete.do?tcode=deliv_item` + 검색조건, 본문 `sKey`(그 목록 응답의 hidden) + `idx`; 성공 = 리다이렉트 URL 에 `msg` 없음.

### 1.3 배정 팝업의 [선택취소] = `cancelForm(barcode)` (팝업 `orderItemPopCurrentSettingModifyForm.do`, EUC-KR)

```js
function cancelForm(barcode) {
  var barcode = form1.barcode.value;                   // readonly 입력칸 = 현재 배정 바코드
  if (barcode == '') { alert("선택된 상품이 없습니다. 확인하세요."); return; }
  var url = "/jun/orderitem/orderItemPopCurrentSettingCancel.do?tcode=order_item"
          + "&barcode=" + barcode + "&orderSeq=389520"
          + "&reqPage=1&pageSize=100&searchSortType=seq&searchOrderType=…(팝업을 열 때 받은 검색조건 24종)…";
  location.href = url;
}
```

- **GET 이 쓰기다**(setCurrent 와 같은 유형). **sKey 없음** — 팝업 HTML 어디에도 sKey 가 없다. 필수 파라미터는 `barcode`·`orderSeq` 뿐이고 나머지는 되돌아갈 검색조건.
- 트리거: `<input type="button" value="선택취소" onclick="cancelForm('2608ET')">`. 결과 페이지 `orderItemPopCurrentSettingCancel.do` 는 기존 §5.4 가로채기(`isAssignCancel`)가 아는 그 페이지다.
- 결과 = 그 주문이 본사확인(OS-)·바코드 빈 값으로 돌아간다(§5.4 가로채기의 성공 판정 `'2604O0' → ''` 와 같은 사실).

### 1.4 툴바 [본사확인취소] = `standby(form1, form3, 'O--', 'OS-')`

```js
var url = "/jun/orderitem/orderItemStandby.do?tcode=order_item"
        + "&status1=" + status1 + "&status2=" + status2 + "&sKey=<페이지 sKey>" + CONST_URL;
idx_form.action = url; idx_form.submit();             // 본문: 체크된 idx 들
```

- `status1` = 목표, `status2` = 서버가 요구하는 현재 상태. 본사확인은 `OS-/O--`, **본사확인취소는 `O--/OS-`** — 함수·URL·sKey 규약이 완전히 같다.
  기존 `cBuildStandbyUrl`/`cDoStandby` 는 `OS-/O--` 를 하드코딩하고 있으므로 상태 두 개를 인자로 뺀다.

### 1.5 취소 [취소] = `del(seq)` — 2026-09-11 스펙 §1 그대로

GET `/jun/orderitem/orderItemCancel.do?tcode=order_item&seq=&sKey=&<검색조건>`, 주문완료(O--) 행에만 링크, `idx` == `del()` 인자.

---

## 2. 확정된 결정 (사장님, 2026-09-16)

| 결정 | 선택 | 근거 |
|---|---|---|
| 대상 상태 | **출고완료(T--)·입고완료(I--)·본사확인(OS-)** + 기존 주문완료(O--) | 사장님 요청의 사슬 그대로. **출고확인(TS-)은 제외** — 매장이 이미 입고 확인한 재고라 출고장 삭제가 매장 재고 확인을 조용히 풀고, 서버가 삭제를 거부할 수도 있다(미실측) |
| 승인 | **사전 승인창 1번** | 기존 일괄취소와 같다. 승인창에 행마다 "현재 상태 → 거칠 단계" 를 보여주고 [취소 진행] 한 번. 진행 중 단계별 표시 + [중단] |
| 구현 경로 | **A — 기존 `[일괄취소]` 루프를 "재조회 → 다음 쓰기 하나" 상태기계로 확장** | B(별도 버튼)는 중복이고 요청과 어긋남, C(네이티브 UI 구동)는 2026-09-11 에 기각한 경로 |
| 실패·미확정 | **즉시 중단**(기존) — 그 건의 **현재 상태를 결과에 명시** | 사슬 중간에 멈추면 행이 중간 상태(예: 출고장은 지워지고 입고완료)로 남는다. 어디서 멈췄는지 모르는 것이 가장 위험하다 |
| 출고 건 특정 | **바코드 + orderSeq 둘 다 일치하는 행 정확히 1건** | 바코드만 맞는 건(4번째 토큰 `0` 또는 다른 주문)은 지우지 않는다 — 다른 주문의 출고를 지우는 사고를 구조로 막는다 |
| 발주주문 입고완료 | **제외 + 사유 표시** | 팝업(선택취소)이 없어 자동화 경로가 없다. "입고완료(발주주문) — 배정 팝업이 없어 수동" |

---

## 3. 아키텍처

작업C(§5.10)·일괄취소(§5.11)·출고취소(§5.5a)의 실행부를 그대로 쓰고, **"다음 단계 판정"·"출고 건 특정"·"선택취소 URL"** 순수부와 루프의 상태기계만 새로 쓴다.

| 재사용 (무변경) | 재사용 (인자 확장) | 신규 |
|---|---|---|
| `fetchOrderRow`(상태·`assignedBarcode`·`rowHtml`·`sKey` 한 응답) · `cReadSearchFields` · `cUpdateRow` · `cStatusColFor`/`cListStatusCode` · `ccBuildCancelUrl`·`ccDoCancel`·`ccRowCancelSeq`·`ccRedirectMsg` · `dcmPostRaw`·`dcmSearchParams`·`dcmHidden`·`dcmDelete`·`dcmAppendLog` · 승인창 CSS·`ensureCcStyle` · `cBatchBusy` | `cReadCheckedRows`(행에 `cs` 링크 여부·바코드 추가) · `cBuildStandbyUrl(sKey, fields, status1='OS-', status2='O--')` — 기존 호출은 기본값으로 무변경(`cDoStandby` 는 손대지 않는다) · `ccTargetStatus`/`ccClassifyChecked`(대상 확장) · `ccShowApprovalDialog`(행별 사슬 표시) · `ccRunCancelBatch`(상태기계) | 순수: `ccNextStep` · `ccStepOutcome` · `ccChainLabel` · `ccRequeryReason` · `ccRowCurrentSetting` · `ccPickDelivIdx` · `ccBuildUnassignUrl` / 실행: `ccFindDelivRow` · `ccDoStandbyOff`(본사확인취소 POST — ccDoCancel 과 같은 dispatch 규약이라 cDoStandby 를 감싸지 않고 따로 둔다) · `ccDoUnassign` · `ccDoDelivDelete` · `ccDoStep` |

- 모든 쓰기는 `fetch(credentials:'include')`. ISOLATED world 라 `form.submit`·`location` 대입·팝업 열기는 쓰지 않는다.
- 접두 `cc` 유지. 순수 판정부는 DOM·네트워크·`chrome.*`·타이머 무접촉 → `tests/orderitem-cancel.test.js`.

---

## 4. 명세

### 4.1 대상 판정 (승인창용, 화면 행 기준) — `ccClassifyChecked(rows)`

`cReadCheckedRows` 가 행마다 `{ orderSeq, code, orderDate, cs: { has, barcode } }` 를 준다(`cs` = `a[href*="currentSetting"]` 존재 여부와 3번째 인자).

| 화면 상태 | 판정 | 승인창 표시 |
|---|---|---|
| `O--` | 대상 | `주문완료 → 취소` |
| `OS-` | 대상 | `본사확인 → 본사확인취소 · 취소` |
| `I--` + `cs.has && cs.barcode` | 대상 | `입고완료 (바코드) → 선택취소 · 본사확인취소 · 취소` |
| `I--` + 링크 없음 | **제외** | `입고완료(발주주문) — 배정 팝업이 없어 수동` |
| `T--` | 대상 | `출고완료 (바코드) → 출고장 삭제 · 선택취소 · 본사확인취소 · 취소` |
| `TS-` | 제외 | `출고확인(매장재고) — 매장이 입고 확인한 건, 수동` |
| `OC-` | 제외 | `이미 취소됨` |
| `B--` · `TE-` · `S--` · 불명 | 제외 | `취소 불가 상태(…)` |

`duplicate`(같은 orderSeq 둘 이상) 규약은 그대로. `ccTargetStatus(code)` 는 `O-- / OS- / I-- / T--` EXACT.
**화면 판정은 승인용이다** — 쓰기 근거는 언제나 4.3 의 재조회다(발주주문 여부도 재조회 `rowHtml` 의 링크로 다시 본다).

### 4.2 승인창 — `ccShowApprovalDialog(cls)`

기존 창에 두 가지만 더한다.
- 대상 목록을 행마다 `orderSeq · 현재 상태 → 거칠 단계`(4.1 표의 문구) 로 보여준다. 제외 목록은 사유 그대로.
- ERP 원문 경고(`취소 된 주문서는 복구되지 않습니다…`) 아래에 **"출고완료 건은 출고장 삭제, 입고완료 건은 재고 반환(선택취소)이 함께 실행됩니다. 되돌릴 수 없습니다."** 를 명시한다.
[취소 진행]/[닫기]→[중단]·`isTrusted` 게이트·진행 중 창 유지·배경 클릭 무시는 그대로.

### 4.3 건별 루프 — `ccRunCancelBatch(targets, progress, isAborted)` 상태기계

건마다 아래를 **OC- 가 보일 때까지** 돈다(최대 `CC_MAX_STEPS = 6` 회 — 4 쓰기 + 여유, 넘으면 미확정 중단).

```
loop:
  1) 재조회 row = fetchOrderRow(orderSeq, orderDate)           ← 상태·assignedBarcode·rowHtml·sKey 를 한 응답에서
     found 아니면 실패(로그인 만료/중복/잘림/행 없음 — 기존 사유), 중단
  2) step = ccNextStep(row)                                    ← 순수. 4.5 표
     step.done   → 그 건 성공(OC-), cUpdateRow, 다음 건
     step.fail   → 실패(사유), cUpdateRow(서버 진실), 중단
  3) 게이트(state.ubSkin && state.ubHqConfirm)·isAborted() 재확인 — 꺼졌으면 중단. 이 건에 아직 쓰기가 하나도 없었으면 processed-- (손대지 않은 건),
     이미 한 단계 이상 썼으면 results.uncertain 에 '중단 — 현재 상태: <row.text>' 로 남긴다(중간 상태를 숨기지 않는다)
  4) progress(tag + step.label)
  5) 쓰기 1회 (4.4) → {dispatched, msg}. dispatched=false 면 실패(쓰기 없었음), 중단
  6) 목표 상태 확인: 최대 ASG_VERIFY_MS(12s) 동안 1.5s 간격 재조회, ccStepOutcome(step, vRow) === 'success' 까지
     성공 → row = vRow 로 2) 부터(그 확인 응답이 곧 다음 단계의 근거 — 새 sKey·링크·상태. 별도 재조회를 더 하지 않는다)
     미확정 → results.uncertain.push({ orderSeq, reason: '<단계> 미확정 — 현재 상태: <vRow.text 또는 불명> · 수동 확인 필요' + 서버 msg }), 중단
  화면 갱신(cUpdateRow)은 그 건이 끝날 때 1회 — 성공(OC- 행)·실패(서버 진실 행)·미확정(확인 재조회 행, found 일 때). 첫 재조회가 이미 OC- 면 쓰기 없이 성공으로 센다.
```

- **쓰기마다 fresh 근거**: 각 단계의 근거는 직전 확인 재조회 응답이라 sKey 도 그 응답의 것이다(2026-09-11 §4.3 "같은 응답의 상태와 키" 원칙 유지). 기존 O-- 건은 종전과 같이 재조회 2회(상태 확인 + 취소 확인)·GET 1회.
- 출고장 삭제 단계만 재조회가 둘이다: 주문 재조회(상태 T-- 확인) + **출고전표 조회**(`ccFindDelivRow`, 그 응답의 sKey 로 즉시 삭제). 그 사이에 다른 GET 을 끼우지 않는다.
- 결과 요약: `success`(OC- 도달) / `failed` / `uncertain` 에 더해 **각 건의 마지막 확인 상태**를 문구에 싣는다.
  예: `389513 · 출고장 삭제 완료 → 선택취소 미확정 — 현재 상태: 입고완료 (250HHL) · 수동 확인 필요`.
- 진행 문구: `1/3 · 389513 · 출고장 000000010HR 삭제` → `… · 선택취소(250HHL)` → `… · 본사확인취소` → `… · 취소 처리` → `… · 확인`.
- `cBatchBusy`·첫 실패 중단·예외 시 failed 기록·finally 해제는 그대로.

### 4.4 쓰기 계약 4종

| 단계 | 함수 | 요청 | 근거 응답 | 성공 확인(재조회) |
|---|---|---|---|---|
| 출고장 삭제 | `ccFindDelivRow(barcode, orderSeq)` → `dcmAppendLog(before_delete)` → `dcmDelete({sKey, idx}, barcode)` | `POST delivItemList.do?tcode=deliv_item`(전체기간·seq 정렬·`searchBarcode`) → `POST delivItemDelete.do?tcode=deliv_item` + 같은 검색조건, 본문 `sKey`+`idx` | 출고전표 응답: `idx` 토큰 `[1]===barcode && [3]===orderSeq` 인 행 **정확히 1건**, 그 행 상태 셀 `출고완료`, hidden `sKey` | `code === 'I--'` |
| 선택취소 | `ccDoUnassign(barcode, orderSeq, fields)` | `GET /jun/orderitem/orderItemPopCurrentSettingCancel.do?tcode=order_item&barcode=&orderSeq=&<cReadSearchFields()>` | 주문 재조회: `code === 'I--'`, `rowHtml` 에 `currentSetting` 링크, 링크 3번째 인자 === `assignedBarcode`(빈 값 아님) | `code === 'OS-' && assignedBarcode === ''` |
| 본사확인취소 | `ccDoStandbyOff(orderSeq, sKey, fields)` (= `cBuildStandbyUrl(sKey, fields, 'O--', 'OS-')` POST) | `POST orderItemStandby.do?tcode=order_item&status1=O--&status2=OS-&sKey=&<fields>`, 본문 `idx=<orderSeq>` | 주문 재조회: `code === 'OS-'`, `sKey` | `code === 'O--'` |
| 취소 | `ccDoCancel(orderSeq, sKey, fields)` (기존) | `GET orderItemCancel.do?…` | 주문 재조회: `code === 'O--'`, `sKey`, `ccRowCancelSeq(rowHtml) === orderSeq` | `code === 'OC-'` |

- 삭제·취소·선택취소는 **dispatch 뒤 재시도 금지**(도달 여부 불명은 전부 미확정). 네트워크 예외도 `dispatched:true` 로 두고 재조회로만 판정(기존 `ccDoCancel` 규약).
- `ccDoUnassign`/`ccBuildUnassignUrl`: `barcode` 또는 `orderSeq` 가 비면 `null` → dispatched=false. 고정 키(`tcode/barcode/orderSeq`)는 검색조건이 덮지 못한다(`ccBuildCancelUrl` 과 같은 규율).
- 출고장 삭제 write-ahead 로그는 기존 `UB_DCM_LOG`(localStorage) 에 `{ phase:'before_delete', via:'bulkcancel', orderSeq, barcode, junNum, delivDate, shop, status, idx }` 로 남긴다. **로그를 못 남기면 지우지 않는다**(§5.5a 규칙 그대로).

### 4.5 순수 판정부

- `ccNextStep(row)` — 입력은 `fetchOrderRow` 결과. 반환 `{ kind: 'done' | 'fail' | 'write', step?, label?, reason? }`

  | `row.code` | 조건 | 반환 |
  |---|---|---|
  | `OC-` | — | `done` |
  | `O--` | `ccRowCancelSeq(rowHtml) === orderSeq` | `write: 'cancel'` / 아니면 `fail: 취소 링크 없음·불일치` |
  | `OS-` | — | `write: 'standby-off'` |
  | `I--` | `rowHtml` 의 `currentSetting` 3번째 인자 === `assignedBarcode` ≠ `''` | `write: 'unassign'` / 링크 없음 → `fail: 입고완료(발주주문) — 배정 팝업이 없어 수동` / 인자 불일치 → `fail: 배정 바코드 불일치` |
  | `T--` | `assignedBarcode` ≠ `''` | `write: 'deliv-delete'` / 없으면 `fail: 출고 바코드를 읽지 못함` |
  | `TS-` `TE-` `S--` `B--` `null` | — | `fail: 상태 부적합: <text>` |
  `sKey` 요구 단계(`standby-off`·`cancel`)는 `row.sKey` 가 없으면 `fail: sKey 추출 실패`.
- `ccStepOutcome(step, vRow)` — `{dispatched:true}` 뒤 재조회 결과로 `'success' | 'uncertain'` (4.4 마지막 열). found 아님·다른 상태·null 은 전부 `uncertain`(기존 `ccClassifyOutcome` 규약 일반화; `cancel` 단계는 기존 함수와 같은 답).
- `ccPickDelivIdx(idxValues, barcode, orderSeq)` — 문자열 배열에서 토큰 `[1]`(대소문자 무시 trim) 과 `[3]` 이 모두 일치하는 것만. **0건 → null, 2건 이상 → `{ ambiguous: n }`** (둘 다 fail-closed).
- `ccBuildUnassignUrl(barcode, orderSeq, searchFields)` — 1.3 계약. 빈 값이면 null.
- `ccChainLabel(code, cs)` — 4.1 표의 표시 문구. 승인창 전용, 판정에 쓰지 않는다.
- `cBuildStandbyUrl(sKey, fields, status1 = 'OS-', status2 = 'O--')` — 기존 테스트(2 인자 호출)가 그대로 통과해야 한다.

### 4.6 `ccFindDelivRow(barcode, orderSeq)` (실행부, 읽기)

`dcmPostRaw(delivItemList.do, dcmSearchParams(barcode))` → `ccPickDelivIdx([...doc.querySelectorAll('input[name=idx]')].map(v), barcode, orderSeq)`
→ `{ ok, idx, sKey, junNum, delivDate, shop, status, reason }`. 상태 셀이 `출고완료` 가 아니면 `ok:false`(reason 에 그 상태). `sKey` 없으면 `ok:false`.
`dcmFindDeliv`(사이드바 출고취소: 바코드만, 최신 1건)는 손대지 않는다 — 용도가 다르다.

---

## 5. 안전 불변식 (전부 fail-closed)

1. 상태 판정은 canonical code **EXACT**. prefix·부분일치 금지(2026-09-11 §5 그대로).
2. **쓰기의 근거는 언제나 쓰기 직전 재조회 응답 하나**: 상태·바코드·링크·sKey 가 같은 응답에서 나온다. 화면 행·승인창의 값은 근거가 아니다.
3. 목표 상태가 **재조회로 확인되기 전에는 다음 단계로 넘어가지 않는다.** dispatch 뒤 재시도 없음.
4. 출고장은 **바코드 + orderSeq 둘 다 일치하는 행 1건**만, 상태 `출고완료` 일 때만, write-ahead 로그를 남긴 뒤에만 지운다.
5. 선택취소는 재조회 행의 `currentSetting` 링크 바코드가 상태 셀 바코드와 같을 때만 보낸다(엉뚱한 바코드를 떼는 경로 차단). 발주주문(링크 없음)은 절대 자동 처리하지 않는다.
6. 취소 GET 은 기존대로 `del('<seq>')` 링크 인자 EXACT 일치가 있어야 나간다.
7. 한 건은 최대 `CC_MAX_STEPS` 회 — 무한 루프 없음. 실패·미확정은 **그 건에서 배치 중단**, 처리된 건까지 화면 갱신, 결과에 현재 상태 명시.
8. 게이트(`ubSkin && ubHqConfirm`)·[중단]은 **매 쓰기 직전**에 다시 본다. `cBatchBusy` 공유(본사확인+입고완료와 배타).
9. 어떤 조회도 쓰기 URL(`Cancel.do`·`CurrentSettingCancel.do`·`Standby.do`·`delivItemDelete.do`)을 "확인용으로" 부르지 않는다.

---

## 6. 테스트

- `tests/orderitem-cancel.test.js`(순수, extractFn): `ccTargetStatus`(O--/OS-/I--/T-- 만) · `ccClassifyChecked`(발주주문 I-- 제외·TS- 제외·사유 문구) · `ccNextStep`(상태 8종 × 조건, 링크 불일치·sKey 없음 fail) · `ccStepOutcome`(단계별 목표·uncertain) · `ccPickDelivIdx`(0건/1건/2건·대소문자·토큰 자리) · `ccBuildUnassignUrl`(모양·빈값 null·고정 키 보호) · `cBuildStandbyUrl` 상태 인자(기본값이 옛 호출과 동일) · `ccChainLabel`.
- `tests/orderitem-cancel-batch.test.js`(루프, 의존 주입): T-- → I-- → OS- → O-- → OC- 전 단계에서 **요청 4개의 URL·본문·순서**와 각 단계 sKey 가 직전 재조회 응답의 것인지 · I--/OS- 시작 경로 · 선택취소 미확정에서 중단 + 결과 문구에 현재 상태 · 출고전표 0건/2건/상태 출고확인 → 삭제 없이 실패 · 로그 실패 → 삭제 없음 · 발주주문 → 쓰기 없이 실패 · 단계 상한 · 게이트/중단 재확인이 매 쓰기 직전에 걸림 · 기존 O-- 케이스 전부 무변경 통과.
- 변이 확인: 각 fail-closed 분기를 하나씩 제거해 대응 테스트가 FAIL 하는지(정적 문자열 대조가 아닌 동작 테스트).
- 라이브: 사장님이 지정한 출고완료 실제 건 1건으로 사슬 전체를 확인한다(회차 뒤, 사장님 입회). 그 전에는 읽기 조회만 실행한다.

## 7. 검수·배포

- 등급 **T3**(서버 쓰기 4종·되돌리기 불가·주문/재고 도메인). 사장님 지시로 Terra 반복 + Opus 5 + DeepSeek 교차 1회, **Fable 없음**, 라운드는 채택 0 이 되는 즉시 종료.
- SHELL 4.2.7(4.2.6 은 같은 날 고객 등록 보강이 썼다) — `manifest.json` → `build-shell-index.ps1` → `loader-integrity` → main push. 팝업 라벨 '주문전표 일괄 처리' 의 설명에 사슬 취소를 한 줄 추가.

## 8. 범위 외

- 출고확인(TS-)·출고오확인(TE-)·판매완료(S--)·발주완료(B--)·발주주문 입고완료의 자동 취소.
- 실패 건 건너뛰고 계속 진행 모드. 취소 사유 입력.
- 사이드바 출고취소(§5.5a)의 동작 변경.
