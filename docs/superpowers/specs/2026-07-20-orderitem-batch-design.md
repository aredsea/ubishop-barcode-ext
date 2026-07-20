# 주문 전표 일괄 자동화 설계 (2026-07-20, rev2.1)

주문 전표(`/jun/orderitem/orderItemList.do`)에 세 기능을 추가한다.

| # | 기능 | 요약 |
|---|---|---|
| A | 일괄 수정 | 체크한 건들의 주문비고/발주비고를 한 번에 교체 |
| B | 수정 팝업 | [수정] 클릭 시 화면 이동 대신 플로팅 창에서 편집 |
| C | 본사확인 → 입고완료 | 체크 → 본사확인 → 재고 배정까지 버튼 하나로 |

배포 채널은 **SHELL**(`skin.js`, `background.js`, `manifest.json`, `popup/*`)이라 적용에 크롬 재시작이 필요하다.

> **rev2.1 (2026-07-20)** — 적대적 검수 2라운드를 거쳤다.
> **rev1 → rev2**: P1 6건. 각각을 우리 소스·라이브 화면·Chrome 공식 문서로 독립 확인한 뒤 고쳤다.
> **rev1의 핵심 메커니즘(ISOLATED에서 `javascript:` 클릭)은 아예 동작하지 않는다** — 구현 전에 잡았다.
> **rev2 → rev2.1**: 원래 6건은 닫혔음이 확인됐고, rev2가 새로 들여온 오케스트레이터의 안전 경계에서
> P1 4건이 더 나와 반영했다. 전체 이력은 9절.
>
> **현재 상태: Phase 0 스파이크는 착수 가능. 실제 쓰기가 들어가는 A·B·C는 Phase 0 통과 후.**

---

## 1. 라이브 실측 사실 (2026-07-20, 운영 ERP)

추측이 아니라 실제 화면에서 확인한 계약이다. 이 값들이 바뀌면 설계가 깨진다.

### 목록 페이지

| 항목 | 값 |
|---|---|
| 체크박스 | `input[name=idx]`, value = orderSeq (이 페이지는 단일값, 콤마 없음) |
| 전체선택 | `checkAll(...)` |
| 상태 열 | 헤더 `상태` (관측 시 인덱스 12 — **하드코딩 금지, 헤더에서 찾을 것**) |
| 수정 버튼 | `<a href="javascript:modify('<master>','<seq>')">` → `location.href` 전체 이동 |
| 취소 버튼 | `<a href="javascript:del('<...>')">` |
| 상태 링크 | `<a href="...currentSetting(master, orderSeq, barcode, shop, client, orderDate)">` — **주문완료 행에는 이 링크가 없다** |
| 프레임 | **이 페이지에 iframe이 10개 있다.** 전부 same-origin, `isTop=false` |

### 상단 일괄 버튼 — `standby`

라벨이 `<img>`라 텍스트 검색으로는 찾을 수 없다. 둘 다 `TD.left` 안에 있다.

```
standby(form1, form3, 'OS-', 'O--')   → [본사확인]      주문완료 → 본사확인
standby(form1, form3, 'O--', 'OS-')   → [본사확인취소]  본사확인 → 주문완료
```

`standby`는 체크박스를 읽고 `form3.action`을 세팅해 submit 한다(643자). 실행하면 **페이지가 이동하고 검색조건이 날아간다** — 저장소의 기존 미해결 항목 "상단 일괄 standby 검색조건 미전달"과 같은 함수다.

**미확인**: `standby`의 전체 본문, `form3`의 필드 구성, 실제 POST 페이로드, 제출 후 도착 페이지. → Phase 0에서 캡처한다(6절).

### 상태 코드

`O--` 주문완료 · `OC-` 주문취소 · `OS-` 본사확인 · `B--` 발주완료 · `I--` 입고완료 · `T--` 출고완료 · `TS-` 출고확인(매장재고) · `TE-` 출고오확인 · `S--` 판매완료

### 수정 폼 (`orderItemModifyForm.do`)

- `form1` → `POST /jun/orderitem/orderItemModify.do`
- **`textarea[shopRemark]` = 주문비고**, **`textarea[remark]` = 발주비고**
- 그 외 필드: `weight` `doc`(hidden) `diaColor`(hidden) `clarity`(hidden) `surface`(hidden) `k` `color` `itemSize` `orderQty` `orderPrice` `orderPrice2` `exdelivedyear/month/day`
- 응답 **디코딩**은 UTF-8로 깨끗했다(U+FFFD 0개). 단 이는 **읽기** 증거일 뿐 쓰기 charset의 증거가 아니다

### 배정 팝업 (`orderItemPopCurrentSettingModifyForm.do`)

- **EUC-KR** — UTF-8로 읽으면 U+FFFD 56개, EUC-KR로 읽으면 0개
- 표 4열: `No | 입고일자 | 바코드 | 선택`, 각 행 `<a href="javascript:setCurrent('<바코드>')">`
- `setCurrent`는 인라인 정의. `form1`(POST, action 속성 없음, 이름있는 필드 없음)을 동적으로 채워 제출
- 관측 사례: 후보 **144건**, 전부 입고일자 `2026.05.08` 동일, 페이징 링크 0

> **⚠ 사이트 인코딩이 섞여 있다.** 수정폼 응답은 UTF-8, 배정 팝업은 EUC-KR이다.

### 프레임 관련 실측 (rev2에서 추가)

- `isPopupWindow()`는 iframe에서 **false**를 반환한다. iframe이 `menubar.visible`·`toolbar.visible`·`outerWidth`를 상위에서 상속하고 `opener`가 없기 때문. → 자동화 iframe이 `ub_is_popup_window` 마커를 잘못 켜서 **사용자 사이드바를 없앨 위험은 없다**(측정으로 확인)
- `skin.js`의 pageSize redirect는 `init()`이 아니라 **document_start 시점 IIFE**(`ensurePageSizeAtStart`, 86행)에서 `location.replace`를 부른다 → 프레임 가드는 그보다 **앞**에 있어야 한다

---

## 2. 확정된 결정 (사용자)

| 결정 | 선택 | 근거 |
|---|---|---|
| 배정 대상 선택 규칙 | **팝업 첫 행 그대로** | 현재 수작업 관행과 동일. 후보 144건의 입고일자가 전부 같아 FIFO가 성립하지 않으므로, 규칙을 새로 만들기보다 관행을 보존 |
| 자동화 범위 | **체크 → 본사확인 → 배정까지 버튼 하나** | 사용자 요청 |
| 실행 중 실패 | **즉시 중단** | 되돌리기 어려운 쓰기 |
| 시작 전 부적격 행 | **걸러내고 보여준 뒤 진행** | 실행 전에 규모를 알 수 있어야 함 |
| 비고 입력 | **덮어쓰기(교체)** | 사용자 선택 |
| 수정 팝업 성격 | **겉모습만 매입처 창과 동일, 내용은 편집 가능** | 사용자 선택 |

---

## 3. 아키텍처

### 3.1 쓰기는 네이티브가 한다 (유지)

저장소의 명시적 원칙은 **"쓰기를 재현하지 말 것"**(`skin.js:788`)이다. 확장은 서버 엔드포인트를 직접 호출하지 않고, 유비샵 자기 코드가 쓰기를 수행하게 한다.

rev2에서 이 원칙을 **A에도 일관 적용**한다. rev1은 A만 직접 POST였는데, 원칙에 어긋날 뿐 아니라 기술적으로도 위험했다(3.5).

### 3.2 네이티브 호출은 MAIN world RPC로 한다 (rev1에서 변경)

**rev1의 "ISOLATED에서 `javascript:` 링크를 `click()`" 은 동작하지 않는다.** MV3 content script의 CSP(`script-src 'self' 'wasm-unsafe-eval' …`)가 `javascript:` URL 실행을 차단한다. Chrome 공식 샘플 저장소에 같은 이슈가 등록돼 있다(GoogleChrome/chrome-extensions-samples#769).

대신 이 저장소에 **이미 검증된 경로**를 일반화한다 — 계정전환 자동화가 CSP를 우회하려고 쓰는 `chrome.scripting.executeScript({ world: 'MAIN' })`(`background.js:296~`)다.

```
자동화 프레임(최소 러너, ISOLATED)
  └ background 에 AUTO_FRAME_READY 전송
       background 는 sender 에서 tabId · frameId · documentId · url 을 얻는다
  └ background 가 job 레지스트리로 권한 검사(활성 job · 허용 경로 · frameId>0)
  └ chrome.scripting.executeScript({
       target: { tabId, documentIds: [sender.documentId] },
       world: 'MAIN', func: 허용된RPC, args: [검증된인자]
     })
```

- **`frameId`가 아니라 `documentId`로 타겟한다.** `frameId`는 navigation 후 같은 번호가 새 문서에 재사용될 수 있어 로드/주입 사이 경합이 난다
- MAIN 함수 **내부에서도** 사전조건을 다시 검사한다(함수 존재·URL·form 구조·대상 행·예상 상태)

#### background가 operation과 인자를 독점한다

**자식 프레임은 무엇을 할지 고르지 못한다.** 허용 목록이 있어도 자식이 순서나 대상을 고를 수 있으면 경계가 아니다.

```
자식 러너가 보낼 수 있는 것:  READY  /  고정 스키마의 PAGE_FACTS   ← 그게 전부
background 가 정하는 것:      현재 job step → operation → 인자(레지스트리에서 꺼냄) → 주입
```

금지: `sendMessage({ op:'CALL_SET_CURRENT', args:[barcode] })` 처럼 자식이 op·인자를 실어 보내고 background가 검증만 하는 형태.

`READ_PAGE_FACTS`도 selector나 HTML을 인자로 받지 않는다 — 받으면 사실상 범용 page reader가 된다. **고정 함수 + 고정 반환 스키마**만 허용한다.

#### job 레지스트리 바인딩

| 고정(job 내내 불변) | 매 navigation 변경 |
|---|---|
| `jobId`(crypto 난수) · feature(A/B/C) · 불변 큐 + 커서 · `tabId` · **controller top-frame documentId** · origin · **계정 identity** · **worker frameId** | worker `documentId` · expected path · operation phase · expected orderSeq/state/barcode |

첫 READY 이후에는 `frameId > 0` 만이 아니라 **등록된 worker frameId와 같은지** 확인한다. documentId는 navigation마다 바뀌지만 worker 슬롯은 같아야 한다.

`sender.url`은 문자열 prefix가 아니라 `new URL()`로 파싱해 operation별 **exact** origin+path를 검사한다.

| Operation | 허용 페이지(exact) |
|---|---|
| `CALL_STANDBY` | `orderItemList.do` |
| `CALL_SET_CURRENT` | `orderItemPopCurrentSettingModifyForm.do` |
| `SET_REMARK_AND_SUBMIT` | `orderItemModifyForm.do` |
| `READ_PAGE_FACTS` | 현재 phase에 지정된 페이지 |

#### iframe 생성 순서도 불변식이다

```js
const f = document.createElement('iframe');
f.dataset.ubAutoJob = jobId;   // ① 먼저
f.src = expectedUrl;           // ②
container.append(f);           // ③
```

`src`/append 뒤에 dataset을 붙이면 document_start content script가 먼저 돌아 **가드가 풀린 채 실행**된다.

시작 버튼 핸들러는 `event.isTrusted`를 검사한다 — 페이지 스크립트가 우리 버튼을 `.click()`해 자동화를 시작시키지 못하게.

### 3.3 자동화 프레임 가드 (rev1에서 변경)

rev1의 `ubauto=<nonce>` URL 파라미터는 **첫 navigation에서 사라진다**. 이건 이 저장소가 이미 당한 함정이다 — `skin.js:993~997`이 팝업 안에서 검색·페이징하면 URL의 `ubasg`가 소실돼 신호가 끊긴다고 적어뒀다. `standby` 제출 후 새 문서에서는 가드가 통째로 풀린다.

대신 **iframe element에 붙은 표식**을 쓴다. iframe 엘리먼트는 내부 navigation 후에도 살아남는다.

```js
// 부모가 만든다
iframe.dataset.ubAutoJob = jobId;

// skin.js 최상단 — ensurePageSizeAtStart(86행)보다 앞
const AUTO = (() => {
  try { return window.frameElement && window.frameElement.dataset.ubAutoJob || null; }
  catch (_) { return null; }   // cross-origin 부모면 접근 불가 → 자동화 아님
})();
if (AUTO) { /* 최소 러너만 등록하고 나머지 전부 return */ }
```

**가드는 파일 최상단이어야 한다.** `init()` 안에 두면 늦다 — pageSize redirect IIFE가 `init()` 전에 `location.replace`를 부른다.

표식은 **식별자일 뿐 권한이 아니다.** 실제 권한은 background의 활성 job 레지스트리가 갖는다. URL 쿼리 nonce는 서버 로그·세션 히스토리·Referer로 새므로 권한 토큰으로 쓰지 않는다.

`all_frames:true`는 유지한다 — ERP 페이지 자체에 iframe이 10개라 끄면 영향 범위가 크다.

### 3.4 컨테이너는 기능마다 다르다 (rev2에서 추가)

세 기능이 같은 컨테이너를 쓸 이유가 없다.

| 기능 | 컨테이너 | 이유 |
|---|---|---|
| B | 패널 안 iframe | 사용자가 보는 편집창이므로 화면에 있어야 한다 |
| A | 숨은 iframe (네이티브 수정폼) | 사용자 개입 없이 순차 저장 |
| C | 숨은 iframe (엄격 격리) | 위와 같음. 다만 Phase 0에서 iframe 적합성이 확인 안 되면 **비활성 탭**으로 전환 |

offscreen document는 쓰지 않는다 — extension origin 아래에서 ERP가 cross-origin이 되어 `X-Frame-Options`/쿠키 파티셔닝 문제가 생기고, `tabId+frameId` scripting 경로도 못 쓴다.

### 3.5 폼 쓰기는 네이티브 제출로 (rev1에서 변경)

rev1의 "폼 전체를 직렬화해 직접 POST"는 두 가지로 틀렸다.

1. **우리 코드가 이미 반박한다.** `skin.js:717~719`: *"이 페이지는 form 중첩이 깨진 HTML이라 DOMParser 후 `form.elements`로는 hidden 들이 form1 밖으로 빠져나온다(실측). → GET HTML에서 정규식으로 직접 추출해야 서버가 실제로 확인 커밋을 한다."*
2. **HTML successful-controls 규칙은 `form.elements` 전량 전송이 아니다.** name 없는 필드 제외, disabled 제외, 미체크 checkbox/radio 제외, multiselect는 같은 name으로 다중 값, submitter는 하나만, `form="id"`로 밖에서 연결된 컨트롤 포함, 같은 name의 순서·중복 보존 등.

대신 **네이티브 폼을 그대로 제출한다**:

```
수정폼을 same-origin iframe에 로드
  → MAIN world 에서 정확히 그 textarea 하나를 찾아 값 설정 (+ input/change 이벤트)
  → 네이티브 저장 함수 또는 requestSubmit(실제 submitter) 실행
  → 별도 GET 으로 재조회해 확인
```

이러면 charset·검증·hidden 토큰·중복 필드·submitter 값·페이지 JS가 덧붙이는 필드를 **브라우저와 페이지가 원래 규칙대로** 처리한다.

**이 선택이 EUC-KR 문제도 함께 해소한다.** `URLSearchParams`는 항상 UTF-8로 percent-encode 하고 `TextEncoder`도 UTF-8만 지원하므로, 헤더에만 `charset=EUC-KR`이라 적는 것은 거짓말이다. 네이티브 제출은 우리가 EUC-KR 바디를 만들 필요 자체를 없앤다.

기존 `postDoc`(`skin.js:481`)은 **UTF-8 바디를 보내고 응답만 U+FFFD 개수로 폴백**한다. 읽기 전용으로만 쓴다.

### 3.6 성공 판정은 "작업 검증"과 "화면 맞춤"을 분리한다 (rev2에서 추가)

기존 resync 설계(`skin.js:1142~1148`)는 의도적으로 *"기대한 결과가 맞는지 검사하지 않고 서버의 현재 진실로 UI를 맞춘다"*. UI 복구 원칙으로는 옳지만 **자동화 성공 판정으로는 부족하다.**

우리가 A 바코드를 배정하려는 사이 다른 탭에서 B가 배정되면 상태는 `I--`, 화면 resync도 성공이지만 **우리 작업은 실패**다.

따라서 C의 성공 조건은 둘 다 만족해야 한다:

- 상태가 정확히 `I--`(입고완료)
- 배정된 바코드가 **우리가 고른 바코드와 정확히 동일**

그리고 분류의 기준선은 **네이티브 쓰기를 dispatch 했는가**이다. dispatch 이후에는 "이전 상태로 보인다"가 실패의 증거가 못 된다 — 서버 반영 지연, 읽기 replica 지연, 우리 쓰기 직후 남이 덮음, 응답 전 SW 중단이 전부 같은 모습으로 보인다.

| 시점 | 관측 | 분류 | 재시도 |
|---|---|---|---|
| dispatch **전** 검증 실패 | 쓰기가 호출되지 않은 것이 확실 | **확정 실패** | 안전 |
| dispatch **후** | 상태 + 바코드가 기대와 일치 | **성공** | — |
| dispatch **후** | 이전 상태로 보임 | **미확정** | **금지** |
| dispatch **후** | 다른 바코드·다른 상태 | **충돌 → 수동 확인** | **금지** |
| dispatch **후** | 재조회 실패·타임아웃 | **미확정** | **금지** |

> **쓰기를 dispatch한 뒤의 모든 non-success는 자동 재시도 금지다.** "불일치=실패"라는 이름이 사용자에게 안전한 재실행을 암시해서는 안 된다.

### 3.7 쓰기 전에 저널을 먼저 남긴다 (rev2.1에서 추가)

"SW 재시작 후 자동 재시도 금지"는 방향만으로는 부족하다. 레지스트리가 메모리에만 있으면 재시작 후 **pending 쓰기가 있었다는 사실 자체를 모르고**, lock도 사라져 사용자가 새 배치를 시작할 수 있다.

네이티브 쓰기 **직전에 persistent 저널을 먼저 기록하고 그 기록을 await 한다.**

```js
await persistJournal({ state: 'WRITE_DISPATCHING', ... });   // ① 반드시 먼저 await
await chrome.scripting.executeScript(...);                   // ② 그 다음 쓰기
```

순서를 지키지 않으면 crash window가 그대로 남는다.

저널 상태 전이:

```
PREPARED → WRITE_DISPATCHING → WRITE_DISPATCHED → (재조회) → VERIFIED_SUCCESS | NEEDS_REVIEW
```

저장 위치는 `chrome.storage.session`(탭 수명과 함께 사라짐). 더 강한 복구가 필요하면 `chrome.storage.local`.
기록 항목: job/feature/계정/tabId · operation nonce · orderSeq · operation 종류 · expected pre-state · expected 최종 상태·바코드(또는 remark) · dispatch 시각 · 마지막 확인 결과.

**재시작 시 복구 절차** — 쓰기를 하지 않는다:

1. `WRITE_DISPATCHING` / `WRITE_DISPATCHED` 발견
2. **서버 상태만 재조회**
3. 기대와 일치하면 성공으로 화해(reconcile)
4. 다르면 `NEEDS_REVIEW`
5. 사용자 확인 전까지 같은 계정·같은 주문에 **새 쓰기 금지**

---

## 4. 기능별 명세

구현 순서는 **Phase 0 → B → A → C**(6절).

### 4.1 기능 B — 수정 팝업

- **가로채기**: 목록의 `a[href*="modify("]`를 capture 단계에서 잡는다. **`preventDefault`는 인자 파싱·행 일치 확인·패널 생성이 전부 성공한 뒤에만** 호출한다(`skin.js:934` 원칙)
- **폴백 복구가 필요하다.** 패널 엘리먼트 생성은 동기적으로 확인되지만 **iframe의 실제 로드 성공은 클릭 핸들러가 끝난 뒤에야 안다.** `X-Frame-Options`·로그인 리다이렉트·handshake 실패로 로드가 깨지면, 이미 `preventDefault` 한 뒤라 사용자는 수정 기능을 잃는다.
  → 로드 실패를 감지하면 원래 `modify(...)` 네이티브 이동을 수행하거나, 최소한 패널에 **[기존 화면으로 열기]** 버튼을 띄운다
- **패널 내용**: 네이티브 수정폼을 iframe으로 그대로 로드. 폼을 재구성하지 않는다
- iframe 안 ERP 헤더·메뉴는 same-origin이므로 스타일 주입으로 가리고 폼만 보이게 한다
- **저장 성공 판정** — iframe navigation은 성공의 증거가 아니다. 정상 저장·검증 실패로 폼 유지·서버 오류·로그인 리다이렉트·네이티브 JS 오류·사용자의 단순 내부 이동이 전부 navigation으로 보인다.

```
EDITING
  → 예상 form 에서 실제 submit 이 발생했는지 감지 → SUBMITTED
  → 허용된 저장 경로로 이동했는지 · 로그인/오류/검증실패 화면이 아닌지 확인
  → 서버에서 해당 주문 재조회
  → 성공이면 행 전체 갱신 후 패널 닫기
  → 검증실패/오류/로그인/불명이면 패널을 열어둔 채 사용자에게 표시
```
- **저장 후 화면 갱신**: 수정폼은 비고뿐 아니라 **수량·중량·금액·인도예정일**도 바꾸며 이 값들은 목록에 보인다. 기존 `resyncRow`는 **상태 셀만** 교체하므로(`skin.js:1161~`) 그대로 쓰면 나머지가 낡은 채 남는다.
  → 서버 HTML에서 해당 `<tr>` 전체를 가져와 교체하고, 실패하면 현재 검색조건으로 목록을 새로고침한다. 조용히 낡은 값을 두지 않는다.
  → 주문일 자체가 바뀌면 "원래 주문일 하루" 기반 조회로는 행을 못 찾는다. 이 경우 목록 새로고침으로 폴백한다
- 게이트 OFF면 가로채지 않는다 — 네이티브 그대로 화면 이동

### 4.2 기능 A — 일괄 수정

- **버튼**: `TD.left` 안, `standby` 앵커 두 개 옆에 [일괄 수정]
- **팝업**: `☐ 주문비고` / `☐ 발주비고` 각각 체크박스 + textarea, [적용] [취소]
- **동작**: 체크한 칸만 적용. 덮어쓰기. 체크 안 한 칸은 건드리지 않는다
- **건별 처리** (3.5의 네이티브 제출)
  1. 행의 `modify('<master>','<seq>')` 인자를 읽는다
  2. 수정폼을 숨은 iframe에 로드
  3. MAIN world에서 대상 textarea가 **정확히 하나이고 그 form 소속인지 확인** 후 값 설정
  4. 네이티브 저장 실행
  5. **수정폼을 다시 GET 해서 textarea 값이 의도한 문자열과 같은지 대조**. 응답 문구는 읽지 않는다(`skin.js:796` — 이 앱에서 응답 문구 스캔은 항상 오탐)
     - 서버가 trim·길이제한·개행 정규화를 할 수 있으므로 비교는 그 규칙을 반영한다
- 순차 처리, **첫 실패에서 중단**. 미확정도 중단
- **화면 갱신 없음** — 비고는 목록에 표시되지 않는다. 결과 요약만 표시
- **lost-update 주의**: 우리가 폼을 연 뒤 저장하기까지 사이에 남이 다른 필드를 바꿨다면 그 변경을 덮는다. 건별로 즉시 열고 즉시 저장해 창을 좁힌다

### 4.3 기능 C — 본사확인 → 입고완료

**행 단위 상태 머신이다. rev1의 "전건 본사확인 후 전건 배정" 2단계 구조는 쓰지 않는다.**

rev1 구조는 6번째 배정에서 실패해도 7번째 이후가 이미 `OS-`로 옮겨져 있어 **되돌리기 어려운 상태가 불필요하게 넓어진다.** 또 `standby` 한 번으로 여러 행을 처리하면 서버가 일부만 반영했을 때 어디까지 성공했는지 알 수 없어 "첫 실패에서 중단"이 성립하지 않는다.

- **버튼**: `TD.left` 에 [본사확인+입고완료]
- **사전검증**: 체크된 행을 상태별로 분류 → "12건 중 9건 대상 / 3건 제외(사유)" 승인
  - 대상: `O--` `OS-` / 제외: `I--` `OC-` `T--` `TS-` `TE-` `S--` `B--`
- **건별 루프** (한 건이 끝나야 다음 건)

```
1. 서버에서 그 orderSeq 의 현재 상태를 재조회
     O--  → 2 로
     OS-  → 3 으로 (standby 생략)
     그 외 → 중단
2. standby 를 그 한 건에만 실행
     대상 체크박스 전체 해제 → 그 한 건만 체크
     → 체크된 집합을 다시 읽어 정확히 {그 orderSeq} 인지 확인
     → CALL_STANDBY → 재조회로 OS- 확인 (navigation 도착지로 판정하지 않는다)
3. 배정 팝업 로드 → 첫 데이터 행의 바코드 확정
     후보 0건이면 실패 → 중단
4. CALL_SET_CURRENT(그 바코드)
5. 재조회: 상태 I-- 이고 배정 바코드 == 4에서 고른 바코드 → 성공
     불일치 → 실패, 재조회 불가 → 미확정. 둘 다 중단
6. 그 행을 화면에서 갱신하고 다음 건
```

- **중단 시에도 이미 처리된 건까지는 반드시 화면 갱신한다.** 서버는 바뀌었는데 화면만 옛 상태로 남는 것이 이 서브시스템에서 반복해 당한 실패다(`skin.js:898` · `1142`)
- 팝업 URL은 기존 `buildAssignPopupUrl` 규약을 따른다(고정 6인자 + `form1`의 `ASG_SEARCH_FIELDS` 24개 복사, **`f.elements[n]` 사용** — `f[n]`은 동명 필드에서 조용히 누락된다, `skin.js:916`)

### 4.4 신규 헬퍼: `fetchOrderRow`

기존 `pickStatusCell`(`skin.js:1094`)은 `a[href*="currentSetting"]`이 있는 행을 전제한다. 그런데 **`O--` 행에는 그 링크가 없다.** 따라서 C의 1·2단계 검증에 쓸 수 없다.

`fetchOrderRow(orderSeq, orderDate)`를 새로 만든다. 반환:

- 정확히 일치하는 orderSeq / 상태 코드·텍스트 / 배정 바코드 / 주문일
- **중복 행 여부** (둘 이상이면 fail closed)
- total·pagination 정보 (**pageSize 500은 "전부 포함"의 증거가 아니다**)
- 로그인 만료·오류 페이지 구분

기존 `fetchStatusCell`의 좋은 성질은 이어받는다 — 화면 필터를 물려받지 않고(`skin.js:1107`), 그 하루로 좁히고, 타임아웃을 건다.

---

## 5. 안전 불변식

기존 주석에 축적된 함정에서 도출했다. 전부 **fail closed**다.

- 모든 job 메시지는 `documentId` + job nonce로 묶는다. 문서가 바뀐 뒤 이전 문서의 신호를 소비하지 않는다(`skin.js:620`)
- 같은 주문을 연속 실행할 수 있으므로 **orderSeq만으로 작업을 식별하지 않는다**(`skin.js:898`)
- 상태 열은 **헤더로 찾는다.** 인덱스를 박으면 깨진다(`skin.js:1266`). 헤더 행은 첫 매칭으로 한 번만 확정하고 그 아래만 처리한다 — 매 행에서 재판정하면 상품명에 열 이름이 든 데이터 행을 헤더로 오인한다(`skin.js:1376`). 중복·누락이면 중단
- **상태 문자열을 그대로 비교하지 않는다.** 옵션 라벨 `출고확인(매장재고)`를 셀 `출고확인(240HTI)`와 직접 비교해 **멀쩡한 행을 지운 적이 있다**(`skin.js:881~883`). 괄호 이후를 잘라 앞부분 일치로 본다. 사전검증 분류가 바로 이 비교를 하므로 그대로 적용한다
- `await` 사이에 행이 다시 그려진다. 매번 orderSeq로 재탐색하고 `isConnected` 확인(`skin.js:1179`)
- 사전조건이 전부 확인되기 전에는 intercept 하지 않는다(`skin.js:934`)
- 파서 실패·중복 행·예상 밖 상태는 전부 중단(`skin.js:1582` fail-open 금지)
- 한 번 읽은 화면 상태를 배치 전체에 재사용하지 않는다. **매 쓰기 직전 서버 상태를 다시 확인**한다
- **lock은 3층이다.** 브라우저 쿠키·세션은 탭별이 아니므로 `(tabId, account)` 하나로는 같은 계정의 두 탭이 동시에 돌 수 있다.
  - **계정 전역 exclusive writer lock** ← A·B·C 전부 여기에 참여한다
  - 탭 로컬 controller/panel lock
  - 같은 orderSeq operation lock
- **계정 변경은 "다음 건 전"이 아니라 즉시다.** 계정 A에서 standby 성공 → 다른 탭에서 계정 B로 전환 → 현재 행의 setCurrent 실행, 이 순서가 가능해진다.
  - 계정·세션 변경: **모든 RPC와 모든 네이티브 쓰기 직전에 즉시 거부**
  - 쓰기 실행 중에 계정이 바뀌었다면 그 건은 **미확정**
  - 옵션 OFF·사용자 취소: 현재 건을 마치고 중단(쓰기 도중 강제 중단하지 않는다)
- **상태 전이 판정은 코드로만 한다.** 괄호를 잘라 앞부분 일치로 보는 규칙은 `rowStillMatchesFilter()`의 **화면 필터 유지 여부**에만 쓴다. C의 쓰기 전 상태 판정에 쓰면 안 된다.
  - 화면 필터 membership: 괄호 절단 + prefix 허용
  - **쓰기 권한 판정: canonical code(`O--` `OS-` `I--`) exact match**
  - 코드를 얻지 못하면 명시적 label→code allowlist, 알 수 없는 접두·접미는 fail closed
  - `fetchOrderRow`는 code와 text를 둘 다 반환하되 **상태 머신은 code만 쓴다**
- **게이트 OFF 상태에서도 리스너는 한 번 idempotent 하게 bind 한다.** 초기 옵션이 OFF라 리스너를 아예 안 걸면 팝업에서 켜도 reload 전까지 기능이 안 생긴다 — 현재 `skin.js:2883`의 storage 변경 핸들러는 대부분 `applyAll()`만 부르고 새 intercept를 초기화하지 않는다. bind는 항상, 발동 여부는 클릭 시점 옵션 검사로 결정한다
- service worker 재시작 후 **pending 쓰기를 자동 재시도하지 않는다.** 미확정으로 복구한다
- 게이트는 초기화 시점과 클릭 시점 양쪽에서 확인한다(`skin.js:927` · `1608`)

---

## 6. 구현 순서

### Phase 0 — 쓰기 없는 기술 스파이크 (선행 필수)

여기서 확인되기 전에는 A·B·C 어느 것도 시작하지 않는다.

> **⚠ "쓰기 없음"을 어떻게 지키는가.** 네이티브 제출을 그냥 실행해 Network에서 관찰하면 **그게 곧 쓰기다.** rev2의 Phase 0 문구에는 이 모순이 있었다. 페이로드 캡처는 아래 중 하나로만 한다:
> ① 전송 **직전에 요청을 차단**하고 페이로드만 읽는다(가장 안전) · ② 네이티브 submit 진입점을 계측해 network dispatch를 막는다 · ③ 사용자가 **이미 수동으로 하는** 저장의 Network 기록을 관찰한다 · ④ 사용자 명시 승인 하에 no-op canary 1건.
> `standby`는 특히 **반드시 write-free dry run** 으로 확인한다.

| # | 확인 항목 |
|---|---|
| 1 | MAIN world RPC + `documentId` 라우팅 동작 |
| 2 | **iframe 생성 순서**(dataset → src → append)에서 첫 document_start부터 가드가 걸리는가 |
| 3 | navigation마다 **재-handshake**: 옛 documentId는 거부되고 새 것만 등록되는가, worker frameId는 동일한가 |
| 4 | **operation × 경로 매트릭스** — 각 RPC가 다른 페이지에서 반드시 거부되는가 |
| 5 | `standby` **write-free 페이로드 캡처** — 모든 idx 해제 → 하나만 체크 → 생성되는 action·필드 관찰 → **실제 dispatch 차단** → 페이로드에 그 orderSeq **하나만** 있는지 확인. `standby`가 별도 hidden 필드나 배열을 쓰는지 미확인이므로 "체크박스를 확인했다"만으로 부족 |
| 6 | `setCurrent` 실제 계약 — 첫 행 바코드·form action/method·동적 생성 필드·제출 후 경로 |
| 7 | 수정폼 **네이티브 저장 진입점** — submit 버튼인가 `javascript:` 앵커인가 별도 검증 함수인가. `requestSubmit()`만으로 같은 요청이 만들어지는가 |
| 8 | 수정폼 제출의 **실제 요청 바이트와 charset** |
| 9 | **모든 사용 페이지의 iframe 적합성** — B 수정폼뿐 아니라 C 목록·배정 팝업·standby 결과 페이지까지(`X-Frame-Options`) |
| 10 | 로그인 만료·오류 페이지 식별 방법 |
| 11 | `fetchOrderRow` fixture — `O--` / `OS-` / `I--` / 바코드 유·무 / 중복 orderSeq / 500건 초과·pagination / 로그인 만료 |
| 12 | **write-ahead 복구** — 저널 직후 · executeScript 직후 · 네이티브 navigation 중 · 검증 중 각각 SW를 죽였을 때 전부 미확정으로 복구되는가 |
| 13 | **계정 변경** — standby와 setCurrent 사이에 계정이 바뀌면 다음 쓰기가 거부되는가 |
| 14 | B 검증 실패 상태에서 패널이 닫히거나 목록이 갱신되지 **않는가** |
| 15 | 실제 polling 계약 — 서버 반영 소요시간 · poll 간격 · 전체 타임아웃 · 타임아웃 후 미확정 처리 |

**Phase 0 탈락 시 결정 (미리 정해둔다)**

| 통과 못한 항목 | 결정 |
|---|---|
| `standby`가 정확히 한 orderSeq만 보낸다는 증명 실패 | **C 중단** |
| iframe navigation·가드 불안정 | C를 **비활성 탭**으로 전환 |
| 네이티브 수정 저장 진입점 불명 | **A 중단** |
| B 수정폼 iframe 실패 | B는 **네이티브 화면 이동 유지** |
| 로그인·오류 페이지를 안정적으로 구분 못 함 | **자동화 전체 중단** |

### Phase 1 — B (수정 팝업)

사용자가 **한 번 명시적으로 저장**하므로 iframe·네이티브 제출·navigation·행 갱신을 가장 안전하게 검증한다. 자동 반복이 없어 실패해도 폭발반경이 1건이다.

> rev1은 A를 먼저 두었으나, rev1의 A는 iframe을 쓰지 않고 직접 POST라 공용 부품을 검증하지 못한다. rev2에서 A가 네이티브 제출로 바뀌면서 B가 선행 검증 역할을 하게 됐다.

### Phase 2 — A (일괄 수정)

1건 canary(한글 포함) → 재조회 대조 → 소량 배치 → 확대.

### Phase 3 — C (본사확인 → 입고완료)

행 단위 상태 머신. **기본값 OFF로 출시**하고, 실운영 1건 canary 후 켠다.

---

## 7. 테스트 전략

**순수 헬퍼는 DOM 비의존으로 분리**해 node 테스트로 고정한다.

- 상태 분류 / 대상·제외 필터링 / 중복 행 fail-closed
- 팝업 첫 행 선택 + 후보 0건 처리
- 성공 판정 3분기(성공·실패·미확정)와 "미확정은 재시도 안 함"
- 팝업 헬퍼 일반화 후 매입처 창 동작 동일(회귀)

> ⚠ `tests/orderitem-assign.test.js`는 `function 이름(` 문자열로 소스를 추출한다(21~31행). 대상 함수를 화살표 함수나 메서드로 쓰면 **테스트가 즉사**한다. `function` 선언으로 작성할 것.

**브라우저 통합 검증**(node 테스트로는 못 잡는다):

- ISOLATED `.click()`이 `javascript:` 링크를 실행하지 **않는다**는 것 자체를 fixture로 고정
- 자식 메시지 → `sender.documentId` → MAIN 주입 경로
- iframe POST·navigation 후 가드 유지
- 한글 네이티브 폼 왕복
- `standby` 부분 성공·결과 미확정
- 로그인 만료
- 같은 orderSeq 반복 작업의 nonce 구분
- 기대 바코드 ≠ 실제 바코드
- B 저장 후 행 전체 갱신
- 실행 중 옵션 OFF · 탭 닫힘 · 계정 전환

**라이브 검증**은 1건 canary로 시작한다. 되돌리기 어려우므로 사용자 확인 후 진행한다.

---

## 8. 옵션 등록

세 기능 모두 `D`(skin.js) + `popup/popup.html` + `popup/popup.js`(기본값·render·리스너·disabled 배열) 3곳에 등록한다. **C는 기본값 OFF.**

기존 `ubFactoryInfo`는 `D`에만 있고 popup UI에 없어 사실상 끌 수 없다. 이번에 같이 노출한다.

---

## 9. rev1 → rev2 변경 이력

Codex 적대적 검수에서 P1 6건. 각각 우리 소스·라이브·공식 문서로 독립 확인했다.

| # | rev1 | 왜 틀렸나 | rev2 |
|---|---|---|---|
| 1 | ISOLATED에서 `javascript:` 링크 `click()` | **MV3 content-script CSP가 차단.** Chrome 공식 샘플 이슈 #769. 웹 검색으로 독립 확인 | MAIN world RPC(`chrome.scripting`, `documentIds`) |
| 2 | 전건 본사확인 → 전건 배정 (2 Phase) | 부분 성공을 알 수 없고, 중간 실패 시 나머지가 이미 `OS-`로 이동해 폭발반경이 넓어짐 | 행 단위 상태 머신 |
| 3 | `ubauto=` URL nonce 가드 | navigation에서 소실. `skin.js:993` 이 이미 같은 함정을 기록. 게다가 `init()` 안 가드는 document_start IIFE보다 늦음 | `frameElement.dataset` + 파일 최상단 가드, 권한은 background job 레지스트리 |
| 4 | 폼 전체 직렬화 후 직접 POST | `skin.js:717` 이 *"DOMParser 후 form.elements 로는 hidden 이 빠져나온다(실측)"* 고 이미 반박. successful-controls 규칙과도 불일치 | 네이티브 폼 제출 |
| 5 | 헤더에 `charset=EUC-KR` | `URLSearchParams`·`TextEncoder`는 항상 UTF-8. 헤더만 바꾸면 거짓말 | 네이티브 제출로 문제 자체 제거 |
| 6 | B 저장 후 `fetchStatusCell`+`resyncRow` | `resyncRow`는 상태 셀만 교체(`skin.js:1161` 확인). 수량·금액·날짜가 낡은 채 남음 | 행 전체 교체, 실패 시 목록 새로고침 |

추가 반영: 구현 순서 A→B→C를 **Phase 0→B→A→C**로(P2), 성공 판정에 바코드 일치 추가, `fetchOrderRow` 신설, job lock·미확정 상태 도입.

측정으로 지운 위험: `isPopupWindow()`의 sessionStorage 마커가 자동화 iframe 때문에 오염될 가능성 → iframe에서 false 반환 확인, 해당 없음.

### rev2 → rev2.1

rev2 재검수에서 **원래 P1 6건은 전부 닫혔다고 확인**됐다. 대신 rev2가 새로 들여온 오케스트레이터의 안전 경계에서 P1 4건이 나왔다.

| # | rev2의 구멍 | rev2.1 |
|---|---|---|
| 1 | allowlist만으로는 권한 경계가 아니다 — 자식이 operation·인자·대상을 고를 수 있으면 목록이 있어도 소용없다 | **background가 operation과 인자를 독점**. 자식은 READY와 고정 스키마 PAGE_FACTS만 보고. 레지스트리 바인딩(worker frameId 고정), exact URL 매트릭스, iframe 생성 순서(dataset→src→append), `event.isTrusted` |
| 2 | "재시작 후 재시도 금지"만으로는 부족 — 레지스트리가 메모리면 pending 쓰기가 있었다는 사실 자체를 모른다 | **write-ahead 저널을 쓰기 전에 await**. 재시작 시 쓰기 없이 재조회로 화해, 다르면 `NEEDS_REVIEW` |
| 3 | B의 "저장 완료" 판정이 없다. iframe navigation은 성공의 증거가 아니다 | B 상태 머신(EDITING→SUBMITTED→검증) + `preventDefault` 후 로드 실패 시 **네이티브 경로 복구** |
| 4 | Phase 0이 "쓰기 없음"을 선언하면서 POST 페이로드 캡처를 요구 — 모순 | 캡처 방법 4종 명시(전송 직전 차단 등) + **탈락 시 결정표** |

추가 반영: 계정 변경은 "다음 건 전"이 아니라 **모든 쓰기 직전 즉시 거부**, lock 3층(계정 전역 writer lock — 쿠키는 탭별이 아니다), **상태 전이 판정은 label prefix가 아니라 canonical code exact match**, 게이트 OFF에서도 리스너는 idempotent bind, dispatch 이후 non-success는 전부 재시도 금지.

---

## 10. 실행 계약 (진행·타임아웃·취소)

행 단위 구조는 안전하지만 느리다. `O--` 한 건당 상태 GET → 목록 iframe 로드 → standby 쓰기 → `OS-` polling → 배정 팝업 로드 → setCurrent 쓰기 → `I--`·바코드 polling → 화면 갱신이 붙는다. 배치가 커지면 분 단위다.

- 진행 표시: `N/M` · orderSeq · 현재 phase
- 단계별 타임아웃 + 전체 job 타임아웃, polling backoff와 최대 횟수
- 읽기 취소는 `AbortController`, **네트워크 동시성 1**
- 다음 쓰기 전에 취소·옵션·계정을 검사한다
- **진행 중인 쓰기는 강제 중단하지 않는다.** 결과를 미확정으로 기록한다
- 숨은 iframe·리스너·타이머는 `finally`에서 정리한다
- 사용자가 탭을 닫거나 top document가 바뀌면 즉시 controller 상실로 처리한다
- 큐는 시작 시 **불변 스냅샷**으로 고정한다
- 같은 orderSeq가 두 번 선택되면 dedupe 하지 말고 **사전검증에서 중복으로 중단**한다

**"취소"의 의미를 UI에 명시한다** — 즉시 네트워크 중단이 아니라, 현재 네이티브 쓰기가 없을 때 다음 안전 경계에서 멈춘다. 이미 standby까지 진행된 행이 있으면 그 부분 진행 상태를 분명히 보여준다.

### 그 밖의 계약

- B에서 `<tr>`를 통째 교체한 뒤 확장의 장식·링크·observer가 **다시 적용되는지** 확인한다
- 수정한 값이 현재 필터·정렬 membership을 바꾸면 제자리 행 교체가 아니라 **목록 reload**가 맞다
- "현재 검색조건으로 reload"가 `location.reload()`인지 검색 폼 재제출인지 명시한다. POST 검색이면 조건이 날아가거나 재전송 확인창이 뜬다
- `documentIds`를 전제하므로 `minimum_chrome_version`을 검토한다
- remark는 `.innerHTML`이 아니라 **`.value`만** 쓰고 입력 길이 상한을 둔다
- **B·A도 단계별 라이브 승인 전까지는 기본 OFF**로 낸다(C는 이미 기본 OFF)

## 11. 범위 외

- `standby`의 "검색조건 미전달" 자체를 고치는 것 (별건, 기존 미해결 항목)
- 배정 규칙을 FIFO 등으로 바꾸는 것 (현행 관행 보존이 이번 결정)
- 매입처 팝업의 기능 변경 (일반화만 하고 동작은 보존)
- `all_frames:true` → `false` 전환 (ERP 페이지에 iframe이 10개라 영향 범위가 크다)
- 콜드 로드 이미지 최적화, 작업 C Phase 3/4 (별도 작업)
