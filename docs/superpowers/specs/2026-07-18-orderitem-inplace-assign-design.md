# 상품주문전표 재고배정 — 부모 새로고침 제거 (제자리 갱신) 설계

- 작성 2026-07-18 · 대상 `src/skin.js` (SHELL 채널) · 페이지 `/jun/orderitem/orderItemList.do`
- 승인: 사용자(2026-07-18). 배포 시점 휴일 = 매장 운영 영향 없음.

## 1. 문제 (실측 확정)

상태 필터를 `본사확인`으로 걸고 작업하는데, 행의 `본사확인` 링크 → 팝업 → 재고 바코드 선택을
하면 **부모 목록이 새로고침되면서 상태 필터만 풀린다.**

라이브 실측(사용자가 실제 1건 처리, 확장 미개입 상태):

| 관측 | 값 |
|---|---|
| `performance` navigation type | `navigate` (부모가 실제 이동) |
| `searchItemStatus` | **빈 값** ← 이것만 탈락 |
| `searchShop` / `pageSize` / `searchSortType` / 날짜 | `LT` / `100` / `seq` / `06-19~07-18` — **전부 보존** |
| 대상 건의 상태 | `입고완료(바코드)` — **상태 변경 자체는 정상** |
| 결과 목록 | 100건 혼재(발주완료 20 · 주문완료 9 · 출고완료/출고확인 다수) |

즉 파라미터 30여 개 중 **`searchItemStatus` 하나만** 비워져서 돌아온다. 상태를 바꾼 건은
원래 필터(`본사확인`)에서 빠지므로 개발자가 의도적으로 비웠을 가능성도 있으나, 실사용에서는
매번 목록을 다시 잡아야 하는 손해다.

### 잘못 짚었던 가설 (기록 — 재발 방지)

1. **상단 일괄 버튼 `standby`** — `standby(form1, form3, ...)`가 인자로 받은 `search_form`을
   본문에서 전혀 쓰지 않고 `form3`(=`all`+`idx`만)을 제출한다. **별개의 진짜 결함이 맞지만**
   사용자가 쓰는 경로가 아니다. 이번 범위 밖.
2. **`currentSetting`이 검색조건을 안 넘긴다** — 틀렸다. `CONST_URL`에 현재 검색상태가
   전부 들어 있고(`searchItemStatus=OS-` 포함) 팝업까지 정상 전달된다. 조사 중 직접 fetch 할 때
   `CONST_URL`을 빼먹어 생긴 인공물을 증거로 착각했던 것.
3. **부모가 파라미터 없는 GET으로 reload 된다** — 틀렸다. 파라미터를 가득 실은 GET으로 온다.

## 2. 관련 사실 (모두 실측)

- 버튼/링크는 **이미지**(`btn_confirm_ok.gif` 등)라 DOM 텍스트 검색으로 안 잡힌다.
- 상태 링크: `<a href="javascript:currentSetting(master,orderSeq,barcode,shop,client,orderDate)">`
  - **3번째 인자(barcode)가 빈 값이면 미배정(`본사확인`)**, 채워져 있으면 이미 배정됨.
- **행 식별**: `input[name=idx]`의 value === `currentSetting`의 2번째 인자(`orderSeq`). 샘플 3/3 일치.
- 상태셀 형식
  ```html
  <!-- 배정 전 -->
  <a href="javascript:currentSetting('6536','387392','','LT',…)"><span class="f_bold">본사확인</span></a>
  <!-- 배정 후 -->
  <a href="javascript:currentSetting('6536','387503','2604O0','LT',…)"><span class="f_bold">입고완료</span></a><br>(2604O0)
  ```
- 팝업(`orderItemPopCurrentSettingModifyForm.do`, 제목 "재고상품 검색")
  - 미배정 건: `setCurrent('바코드')` 후보 **145개**
  - 배정된 건: 후보 **0개** + `cancelForm` 노출
  - hidden 29개에 **Struts TOKEN 없음** (토큰 재현 이슈 해당 없음)
  - 자체 HTML에 `opener` 참조 **없음** → 팝업은 opener를 쓰지 않는다
- `setCurrent(barcode)` → `location.href = ".../orderItemPopCurrentSettingModify.do?...&barcode=…&orderSeq=…"`
- `manifest.json`: **skin.js는 `ubdstore.ubshop.biz/*` + `all_frames:true` + `document_start`**
  → 팝업과 Modify 응답 페이지에도 이미 주입된다.

### 웹 조사에서 확정된 제약

- `Location` 인터페이스는 스펙상 `[LegacyUnforgeable]` → `location.href`/`reload` **가로채기 불가**
  (MAIN world 에서도 불가). 폐기.
- **ISOLATED world 에서는 `window.opener`가 보이지 않는다**(Chromium 확정) → 팝업 content script 가
  부모 DOM 을 직접 만지는 설계는 성립하지 않는다.
- `window.opener` 자체는 unforgeable 이 아니라 `noopener` 로 **링크를 끊는 것은 스펙 보장**.

## 3. 설계

**핵심 방침: 쓰기를 재현하지 않는다.** 실제 재고 배정은 네이티브 흐름이 그대로 수행하고,
확장은 **부모가 이동하지 못하게 만드는 것**과 **행을 제자리에서 갱신하는 것**만 한다.

```
부모 목록                              팝업(우리가 열고 opener 를 끊음)
  │                                      │
  ├─ 본사확인 링크 클릭                    │
  │   capture 단계에서 가로채              │
  │   nonce 발급 + window.open(…&ubasg=n) ──▶ 재고상품 검색 (네이티브 그대로)
  │   핸들 없으면(차단) 폴백 ↺            │   검색·페이징 전부 네이티브
  │   w.opener = null 확인되면            ├─ 로드 시 nonce 를 sessionStorage 에 보존
  │   preventDefault + stopImmediate      ├─ 재고 선택 = 네이티브 setCurrent
  │                                      │   → Modify.do 로 이동, 서버가 실제 배정 수행
  │                                      │
  │                                      ├─ Modify.do 응답이 opener 새로고침 시도
  │                                      │   → opener 가 null 이라 그 줄에서 죽음
  │                                      │   → 부모는 손도 안 탐  ★
  │                                      │
  │                                      └─ skin.js(Modify 페이지)가 URL 의
  │                                          orderSeq·barcode + 보존한 nonce 로
  │                                          chrome.storage 에 신호 기록 후 self.close()
  │                                              │
  ◀── chrome.storage.onChanged ─────────────────┘
  │   (자기가 발급한 nonce 만 소비)
  └─ 그 행만 서버에서 다시 읽어 상태셀 교체(검증 + 바이트 동일 갱신)
```

### 3.1 부모: 클릭 가로채기

- 게이트: `location.pathname` 이 `/jun/orderitem/orderItemList.do` 일 때만.
- 대상: `a[href^="javascript:currentSetting"]` 중 **3번째 인자(barcode)가 빈 값인 것만**.
  - 이미 배정된 행(입고완료/출고완료 등)은 **가로채지 않고 네이티브로 통과** — 그쪽 팝업은
    취소(`cancelForm`) 흐름이라 이번 범위 밖이고, 건드리면 위험만 는다.
- `preventDefault()` + `stopImmediatePropagation()` (인라인 href 실행 차단).
- 팝업 URL 은 **네이티브와 동일하게** 조립: 6개 인자 + 부모 form1 에서 만든 검색 파라미터.
  - `CONST_URL` 은 MAIN world 전역이라 ISOLATED 에서 못 읽는다 → **form1 의 현재 값으로 재구성**.
  - 사실 이 파라미터들은 팝업이 `setCurrent`/`cancelForm` URL 에 굽는 용도라 우리 흐름엔
    불필요하지만, 네이티브와 동일 요청을 유지해 서버 측 분기 차이를 없앤다.
- `window.open(url, 'orderitem_win', 'width=400,height=300,scrollbars=yes,resizable=yes')` 후
  부모가 직접 `w.opener = null`.
  - **`noopener` 옵션은 쓰지 않는다**(초안에서 폐기). `noopener` 면 차단되든 성공하든 반환값이
    항상 null 이라 **팝업 차단을 감지할 수 없고**, 이미 `preventDefault` 한 뒤라 클릭이 조용히
    먹통이 된다 — §3.4 의 폴백 불변식을 구현 자체가 못 지킨다. 창 이름 재사용도 죽어 팝업이 쌓인다.
  - 실측(Chrome 150): 핸들 방식에서도 자식이 보는 `opener` 는 null 이고 **다음 페이지로 이동한
    뒤에도 유지**되어 새로고침 차단 효과는 동일. 크기·self-close 도 그대로 동작.
  - `w.opener === null` 로 **확인될 때만** 가로챈다. getter 예외·확인 실패는 전부 '못 끊음'으로
    보고 우리가 연 창을 닫은 뒤 네이티브에 넘긴다. 느슨하게 통과시키면 사용자는 고쳐진 줄 알고
    쓰는데 필터가 계속 풀리는 최악이 된다(폴백은 손해가 '기능 미적용'뿐이라 안전한 방향).
- **nonce**: 부모가 팝업 URL 에 `ubasg=<nonce>` 를 실어 발급하고 자신이 발급한 것만 소비한다.
  없으면 ①네이티브로 열린 팝업까지 우리 것으로 오인(배정취소 흐름 오염) ②`chrome.storage` 는
  모든 탭에 방송되므로 같은 주문이 보이는 **다른 목록 탭들이 제각각 재조회·갱신·토스트**를 한다.

### 3.2 팝업 Modify 페이지: 신호 기록

- **팝업 폼 페이지**: 로드 시 URL 의 `ubasg` 를 **즉시 `sessionStorage` 에 보존**한다.
  클릭 시점에 URL 에서 읽으면, 사용자가 팝업 안에서 검색하거나 페이지를 넘긴 뒤 고르는 순간
  URL 에 `ubasg` 가 없어 신호가 통째로 끊긴다 → 서버 배정은 됐는데 opener 도 끊겨 있어
  그 행이 **영영 `본사확인` 으로 남는다**. 후보가 100건을 넘어 페이징이 흔하므로 실사용 빈발.
- **Modify 페이지**: `location.search` 의 `orderSeq`·`barcode` + 보존한 nonce 로 신호 기록.
- **신호 채널 = `chrome.storage.local` + `onChanged`** (localStorage/`storage` 이벤트 아님).
  - ISOLATED world content script 가 window 의 `storage` 이벤트를 받는지는 **검증된 바가 없고**,
    안 오면 이 기능 전체가 예외 하나 없이 조용히 아무 일도 안 한다.
    `chrome.storage.onChanged` 는 이 파일이 이미 ISOLATED 에서 쓰는 검증된 경로다.
  - ⚠ `storage` 이벤트와 달리 **쓴 컨텍스트에도 발화**하므로 삭제(newValue 없음)를 걸러야 한다.
- 그 후 `window.close()`.
  - opener 를 끊었으므로 네이티브 `self.close()` 가 앞선 TypeError 로 실행 안 될 수 있어
    **우리가 닫는다**. 실패해도 기능상 문제 없음(사용자가 닫으면 됨).

### 3.3 부모: 행 제자리 갱신

- `window.addEventListener('storage', …)` 로 `UB_ORDER_ASSIGN_v1` 변경 수신 (60초 만료).
- 대상 행 = `input[name=idx][value^=orderSeq]` 의 `closest('tr')`. 없으면 조용히 종료.
- **검증 겸 갱신**: 목록을 서버에서 다시 읽어 그 행의 상태셀 HTML 을 가져와 교체한다.
  - 조회 조건 = 현재 form1 값 + `searchItemStatus=''` (상태가 바뀌어 현재 필터에서 빠지므로
    반드시 비워야 대상 행이 응답에 들어온다) + `searchJunNum=<그 행의 주문장번호>`(결과 축소).
  - 응답에서 같은 `orderSeq` 행을 찾아 상태셀 `innerHTML` 을 **그대로** 부모 셀에 대입.
    → 손으로 만든 마크업이 아니라 **서버가 렌더한 것과 동일**하므로, 이후 그 행에서 다시
    링크를 눌러도 네이티브 동작이 이어진다.
  - 응답의 상태가 여전히 `본사확인` 이면 **실패로 판정** → 토스트로 알리고 갱신하지 않는다.
- 성공 시 그 행에 강조(기존 `ub-ms-hl` 재사용)로 눈에 띄게 한다.

### 3.4 불변식 / 실패 시 동작

- **미배정 행만 가로챈다.** 판정은 `currentSetting` 3번째 인자의 공백 여부 하나로.
  인자가 정확히 6개가 아니면 파싱을 버린다(콤마가 섞이면 자리가 밀려 엉뚱한 orderDate 가 흐른다).
- **어떤 예외든 네이티브로 폴백.** 팝업 차단(핸들 null)·`w.opener` 차단 확인 실패·form1 없음·
  `chrome.storage` 없음·조립 실패 → 가로채지 않고 원래 링크가 돌게 둔다. 사전조건은
  **`preventDefault` 앞에서** 전부 검사하고, 창을 이미 열었으면 닫고 넘긴다.
- **`state.ubSkin` 게이트(킬스위치).** 페이지 동작을 바꾸는 다른 기능과 동일한 게이트를 둔다.
  이 기능은 그중 유일하게 쓰기 흐름을 가로채므로 현장에서 오작동해도 팝업 토글로 끌 수 있어야
  한다(확장은 다운그레이드가 불가능하다).
- **성공 판정은 바코드 정확일치.** `입고완료` 텍스트만으로 판정하면 같은 `Modify.do` 를 타는
  배정취소 흐름을 오인해 방금 취소한 행을 되칠하고 고착시킨다. 부분일치(indexOf)도 금지
  (`2604O` 기대 시 `2604O1` 오인).
- **행 참조는 성공 직전에 다시 찾는다.** 폴링 수초 사이 표가 다시 그려지면 분리된 노드를 고치고도
  성공 처리하는 사고가 난다 → `isConnected` 확인 후 실제 교체에 성공해야 완료로 본다.
- **신호는 발급한 문서만 소비**(nonce). 완료 기억 키는 `orderSeq+barcode`(취소 후 재배정 허용),
  60초 만료. 삭제는 `ts` 대조 후에만(더 새로운 신호를 지우지 않게).

## 4. 검증

- **순수 함수 단위테스트**(`tests/orderitem-assign.test.js`, node 직접 실행, **21 pass**):
  `parseCurrentSettingArgs` / `isUnassigned` / `parseSetCurrentBarcode` / `oneDayParams` /
  `assignConfirmed`(정확일치·접두사 오인·바코드 없음) / `asgSignalFresh`.
  skin.js 는 IIFE 라 require 가 안 되므로 소스에서 함수 선언을 이름으로 추출해 평가한다
  (리네임되면 테스트가 즉시 죽어 조용한 드리프트가 안 생긴다).
- **라이브**(사용자가 실제 1건 처리):
  1. 부모가 이동하지 않는다(필터·스크롤 그대로)  2. 해당 행이 `입고완료(바코드)` 로 바뀐다
  3. ERP 상 상태가 실제로 변경돼 있다(다른 조회로 교차확인)
  4. **팝업에서 검색·페이징을 거친 뒤 고르는 경로도 확인**(nonce 보존 검증)
- 콘솔 태그 `[UB][assign]` 로 각 단계 로그.

### ⚠ 배포 시점까지 남는 미검증 전제

**`orderItemPopCurrentSettingModify.do` 의 응답 스크립트를 아직 아무도 읽어본 적이 없다.**
설계 전체가 "그 응답의 첫 `opener.` 접근이 TypeError 로 죽는다"에 걸려 있는데, 실측된 것은
팝업 *폼* 페이지에 opener 참조가 없다는 사실뿐이다. 죽어서 안 도는 것이 `self.close()` 하나면
무해하지만, 그 블록에 2차 요청이 섞여 있다면 조용히 유실된다.

→ 그래서 Modify 페이지에서 **opener 를 건드리는 스크립트 원문을 신호에 실어 부모 콘솔에
남기는 진단**을 넣었다(읽기 전용, 동작 무영향). 라이브 1건이면 답이 나오므로 **첫 검증 때
반드시 이 로그를 확인**하고, 2차 요청이 있으면 설계를 재검토한다.

## 5. 배포

- **SHELL 채널**: `manifest.json` 3.6.7 → **3.6.8**, `build-shell-index.ps1` 재생성, push.
- 반영은 **다음 크롬 재시작**. 재설치 불필요.
- 회사 PC 는 `%LocalAppData%\D102LabelExtension` 이 실제 로드 폴더이므로 그쪽 sync 확인 필요.

## 6. 범위 밖

- 상단 일괄 버튼(`standby`)의 검색조건 미전달 결함 — 별개 이슈로 남긴다.
- 이미 배정된 건의 **취소**(`cancelForm`) 흐름.
- 체크박스 선택 상태 복원, 자동 일괄 배정 등 자동화 — 사용자가 "나중에" 로 보류.
