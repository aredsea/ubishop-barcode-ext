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
부모 목록                              팝업(우리가 noopener 로 염)
  │                                      │
  ├─ 본사확인 링크 클릭                    │
  │   capture 단계에서 가로채              │
  │   preventDefault + stopImmediate      │
  │   window.open(url,'_blank','noopener…')──▶ 재고상품 검색 (네이티브 그대로)
  │                                      │   검색·페이징 전부 네이티브
  │                                      ├─ 재고 선택 = 네이티브 setCurrent
  │                                      │   → Modify.do 로 이동, 서버가 실제 배정 수행
  │                                      │
  │                                      ├─ Modify.do 응답이 opener 새로고침 시도
  │                                      │   → opener 가 null 이라 그 줄에서 죽음
  │                                      │   → 부모는 손도 안 탐  ★
  │                                      │
  │                                      └─ skin.js(Modify 페이지)가 URL 에서
  │                                          orderSeq·barcode 를 읽어
  │                                          localStorage 에 신호 기록 후 self.close()
  │                                              │
  ◀── storage 이벤트 ───────────────────────────┘
  │
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
- `window.open(url, '_blank', 'noopener,width=400,height=300,scrollbars=yes,resizable=yes')`
  - 반환값은 스펙상 **null** (핸들 확보 불가) → 팝업 상태 폴링은 설계에서 배제.

### 3.2 팝업 Modify 페이지: 신호 기록

- 게이트: `location.pathname` 이 `/jun/orderitem/orderItemPopCurrentSettingModify.do`.
- `location.search` 에서 `orderSeq`, `barcode` 추출.
- `localStorage.setItem('UB_ORDER_ASSIGN_v1', JSON.stringify({ orderSeq, barcode, ts }))`
  - **localStorage 를 쓰는 이유**: 동일 origin 의 다른 창에 `storage` 이벤트가 발생하며,
    `opener` 없이도 부모에 닿는 유일한 무권한 채널. (`sessionStorage` 는 탭 단위라 안 됨.)
- 그 후 `window.close()`.
  - opener 가 null 이라 네이티브 `self.close()` 가 앞선 TypeError 로 실행 안 될 수 있으므로
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
- **어떤 예외든 네이티브로 폴백.** `window.open` 이 팝업 차단으로 null-and-blocked 이거나,
  form1 이 없거나, localStorage 가 막혔거나, 조립 실패 시 → 가로채지 않고 원래 링크가 돌게 둔다.
  (가로챈 뒤 실패하면 사용자가 아무것도 못 하게 되므로, **가로채기 전에** 사전조건을 전부 검사한다.)
- **상태 신호는 1회 소비.** 처리 후 즉시 `removeItem`. 60초 만료.
- **`storage` 이벤트는 다른 창에서만 발생**하므로 자기 자신이 쓴 신호를 되먹는 문제는 없다.
  단 부모가 여러 탭 열려 있으면 모두 수신 → 각자 자기 DOM 에 해당 행이 있을 때만 갱신(무해).

## 4. 검증

- **순수 함수 단위테스트**(`tests/orderitem-assign.test.js`, node 직접 실행):
  - `parseCurrentSettingArgs(href)` — 인자 6개 파싱, 따옴표/공백 변형
  - `isUnassigned(args)` — barcode 공백 판정
  - `pickStatusCell(html, orderSeq)` — 응답에서 대상 행 상태셀 추출
  - `assignSignal` 만료/형식 판정
- **라이브**: 사용자가 실제 1건 처리 →
  1. 부모가 이동하지 않는다(스크롤·필터 그대로) 2. 해당 행이 `입고완료(바코드)`로 바뀐다
  3. ERP 상 상태가 실제로 변경돼 있다(다른 조회로 교차확인)
- 콘솔 태그 `[UB][assign]` 로 각 단계 로그.

## 5. 배포

- **SHELL 채널**: `manifest.json` 3.6.7 → **3.6.8**, `build-shell-index.ps1` 재생성, push.
- 반영은 **다음 크롬 재시작**. 재설치 불필요.
- 회사 PC 는 `%LocalAppData%\D102LabelExtension` 이 실제 로드 폴더이므로 그쪽 sync 확인 필요.

## 6. 범위 밖

- 상단 일괄 버튼(`standby`)의 검색조건 미전달 결함 — 별개 이슈로 남긴다.
- 이미 배정된 건의 **취소**(`cancelForm`) 흐름.
- 체크박스 선택 상태 복원, 자동 일괄 배정 등 자동화 — 사용자가 "나중에" 로 보류.
