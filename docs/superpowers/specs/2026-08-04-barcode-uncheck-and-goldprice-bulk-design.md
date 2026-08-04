# 바코드 인쇄 후 선택 해제 + 기초상품 적용시세 일괄변경 (2026-08-04)

두 건을 한 spec 에 담는다. 서로 독립이고 배포 경로가 달라 **따로 배포할 수 있다**.

| 작업 | 파일 | 배포 채널 | 크롬 재시작 |
|---|---|---|---|
| A. 바코드 인쇄 후 선택 자동 해제 | `src/content.js` | LOADER(`app-files.json`) | **불필요** — push 즉시 |
| B. 적용시세 일괄변경 | `manifest.json` + 신규 `src/masterprice.js` | SHELL + LOADER | **최초 1회 필요** |

> B 의 manifest 변경은 SHELL 이라 크롬 재시작을 부른다. 이 ERP 는 세션 쿠키라
> **재시작 = 재로그인**이다([[2026-07-19 확정]]). 운영시간을 피해 배포한다.
> 재시작 뒤로는 `masterprice.js` 가 LOADER 관리라 수정이 push 만으로 반영된다.

---

## 0. WorkContext — 저장소에서 도출 불가능한 라이브 실측 (2026-08-04, 회사 PC)

아래는 전부 `ubdstore.ubshop.biz` 라이브에서 직접 측정한 값이다. **저장소 어디에도 없다.**
구현자는 이 절을 근거로 쓰고, 어긋나면 코드가 아니라 이 문서를 먼저 의심하라.

### 0.1 상품검색 목록 (`/info/item/infoItemList.do`) — 작업 A

- 체크박스는 **두 종류**다.
  - 전체선택: `input[name="all"]`, `onclick="checkAll(form2,form2);"` — value 속성 없음
  - 개별: `input[name="idx"]`, value 는 행 식별자
- 폼은 `form1`(검색) + `form2`(체크박스) 두 개.
- 한 페이지(pageSize=20) 기준 checkbox 총 21개 = `all` 1 + `idx` 20.

### 0.2 기초상품관리 목록 (`/master/item/masterItemList.do`) — 작업 B

탭은 `tcode` 로 갈린다.

| tcode | 화면 | 시세 열 | `input[name=idx]` |
|---|---|---|---|
| `master_item` | 기본정보보기 | **없음** | **없음** |
| `master_item_k` | **품위정보보기** | **있음** | **없음** |
| `master_item_image` | 이미지보기 | 없음 | 있음(20/페이지) |

**→ 작업 B 의 화면은 `master_item_k` 다.** 시세를 목록에서 확인할 수 있는 유일한 탭이고,
체크박스는 없으므로 **확장이 직접 심어야 한다.**

`master_item_k` 데이터 행 = `table.t_list`(마지막) 안, **21셀**. 헤더 행도 `TD`(=`TH` 아님).

| # | 내용 | # | 내용 |
|---|---|---|---|
| 0 | No | 11 | 단가 |
| 1 | 돋보기 아이콘(`view(seq)` 링크 + img) | **12** | **입고공급가** |
| 2 | 마스터상품코드(`view(seq)` 링크) | 13 | 배수 |
| 3 | 매입처상품코드(상품명) | **14** | **판매가** |
| **4** | **시세 (= 적용시세)** | 15 | 단가구분 |
| 5 | 해리 | **16** | **판매가고정** |
| 6 | 공임 | 17~19 | 주문/반품/수리 가능 |
| 7 | 판매공임 | **20** | 수정/삭제 — `modify(seq)`·`del(seq)` |
| 8 | 멜리판매가/멜리수량 | | |
| 9 | 품위 | | |
| 10 | 중량 | | |

- **seq 추출원 = 마지막 셀(20)의 `javascript:modify('7646')`.** 셀 1·2 의 `view(seq)` 도 같은 값.
- 2품위 상품은 한 셀에 `18K(14K)`, `740,920(495,598)` 처럼 **괄호로 2값**이 들어온다.
- 전체 상품 **7,273건**. `pageSize` 는 20/30/50/100/300/500.

### 0.3 상품 수정 폼 (`/master/item/masterItemModifyForm.do?tcode=master_item&seq=<seq>`)

```
<form name="form1"
      action="/master/item/masterItemModify.do?tcode=master_item"
      method="post"
      enctype="multipart/form-data"
      onsubmit="return checkForm(this);">
```

- ★ **`enctype="multipart/form-data"`** (이미지 업로드 필드 때문). fetch 로 재현하려면
  multipart 본문을 손으로 만들어야 한다 — 이것이 접근법 B 를 기각한 결정타 중 하나다.
- ★ 저장 버튼 = `<input name="imageField22" type="image" src="/images/com/btn_modify.gif">`.
  **`type=image` 라 네이티브 제출 시 `imageField22.x` / `imageField22.y` 가 함께 전송된다.**
  `form.submit()` 을 직접 호출하면 이 두 값이 빠지고 **`onsubmit` 도 발화하지 않는다.**
- hidden 필드 약 40개. `sKey` 는 **GET 마다 서버가 새로 발급**하는 타임스탬프 키다.
- 외부 스크립트 `/js/util.js` `/js/validate.js` `/js/protectfunc.js` `/js/lib2.js` 등에
  `movePageForm` 등이 있다 — **수정폼 HTML 안에 인라인으로 없다.**

**적용시세 필드명 = `goldPrice`.** 화면 라벨 "적용 시세". 그 주변 필드 매핑:

| 화면 라벨 | name | 비고 |
|---|---|---|
| 중량단위 | `weightType` | select. 미선택(index 0)이면 계산이 전부 0 |
| 해리 | `hairi` | |
| **적용시세** | **`goldPrice`** | 이번 작업의 대상 |
| 판매공임 | `saleWate` | |
| 멜리판매가 | `meleeSalePrice` | readonly |
| 기본/컬러/메인스톤/서브스톤 공임 | `baseWate` `colorWate` `mainStoneWate` `subStoneWate` | |
| 공임합계 | `totalWate` | readonly |
| 품위 1/2 | `k1` `k2` | select |
| 중량 1/2 | `weight1` `weight2` | |
| 단가 1/2 | `price1` `price2` | |
| 배수 1/2 | `margin1` `margin2` | |
| **입고공급가 1/2** | `inputSupplyPrice1` `inputSupplyPrice2` | **시세 변경 시 재계산됨** |
| **판매가 1/2** | `salePrice1` `salePrice2` | **시세 변경 시 재계산됨** |
| 단가구분 / 판매가고정 | `priceFlag` / `fixPriceFlag` | 계산 분기에 쓰임 |

### 0.4 시세 변경의 파급 — 이 작업의 위험 지점

수정폼의 적용시세 칸에는 `changeGoldPrice(obj,form)` 가 걸려 있고, 그 끝에서
**`calItemPrice(form)` 가 입고공급가와 판매가를 다시 계산한다.**

```
function changeGoldPrice(obj, form) {
  if (event.keyCode != 9 && event.keyCode != 16) {
    var objVal = removeComma(obj.value);
    if (objVal != "") { obj.value = cashReturn(eval(objVal).toString()) }
    calItemPrice(form);          // ← 입고공급가·판매가 재계산
  }
}
```

`calItemPrice` 는 `weightType` 미선택이면 전부 0 으로 밀고, `priceFlag`(단가구분)와
`fixPriceFlag`(판매가고정)에 따라 분기하며, 중량단위별 `donRatio` 와 품위별 매입/판매 비율
테이블(`w_donRatio`, `buyRatio`, `saleRatio`)을 쓴다. **순금 여부 플래그도 따로 둔다.**

실측 대조로 계산 구조를 확인했다(seq 7646, 마스터상품코드 `T-R2-I-WG-QB-01I1`):

```
18K : 3.54 g × 해리 1.1 × (900,000 ÷ 3.75) × 0.75  + 공임합계 40,000 = 740,920  ← 화면값 일치
14K : 2.95 g × 해리 1.1 × (900,000 ÷ 3.75) × 0.585 + 공임합계 40,000 = 495,598  ← 화면값 일치
```

> ⚠ **이 식은 "구조를 이해했다"는 증거일 뿐 이식 근거가 아니다.**
> 순금 제품·단가구분 Y·중량단위 변형·판매가고정 N 의 분기를 전수 검증하지 않았다.
> 잘못 이식하면 **선택한 전 상품의 입고공급가와 판매가가 조용히 어긋난다.**
> 그래서 아래 설계는 계산을 **페이지 자신에게 맡긴다.**

### 0.5 저장 검증 로직

```
function checkForm(form) {
  if (form.title.value == "")   { alert("신상 타이틀을 선택하세요! "); ...; return false; }
  if (form.factory.value == "") { alert("매입처를 선택하세요! ");     ...; return false; }
  if (form.k1.value != "" && form.k1.value == form.k2.value) {
      alert("기본 품위와 두번째 품위가 동일합니다. "); form.k2.focus(); return false; }
  return movePageForm(form);
}
```

- 검증 3종은 **기존 상품이라면 이미 통과한 값**이라 정상 경로에서 걸릴 일이 거의 없다.
- 실패 경로는 `alert()` 를 띄운다 — **iframe 안에서 뜨면 브라우저가 멈춘다.** 반드시 가로챈다.
- 실패 경로의 `document.all[...sourceIndex+1].focus()` 는 IE 레거시라 최신 크롬에서 예외를
  던진다. **`alert` 을 가로채 즉시 중단시키면 이 줄에 닿지 않는다.**

### 0.6 미확정 — 첫 실행에서 확인할 것

- `masterItemModify.do` 의 **성공/실패 응답 형태**를 아직 모른다. 이 ERP 의 다른 화면은
  POST-redirect-GET 이고 **실패일 때만 리다이렉트 URL 의 `msg` 파라미터에 사유**가 실린다
  (기존 실측 관용 — `project-ubishop-fetch-automation` 참조). 같으리라 가정하되,
  **§4.4 의 1건 시범이 이 확인을 겸한다.** 다르면 판정 로직을 그때 고친다.

---

## 1. 작업 A — 바코드 인쇄 후 선택 자동 해제

### 1.1 요구

상품검색에서 상품을 골라 바코드를 뽑고 나면 체크가 **자동으로 풀린다**. 한 번 뽑은 선택을
유지할 이유가 없고, 다음 작업 전에 손으로 푸는 일이 반복된다.

### 1.2 동작

- **인쇄가 성공했을 때만** 해제한다.
- 실패(프로그램 미실행·연결 실패·서버 오류)하면 **선택을 남긴다** — 다시 눌러야 하는데
  선택이 풀리면 처음부터 다시 골라야 한다.
- 해제 대상 = `input[name="idx"]` 전부 + 전체선택 `input[name="all"]`.
  전체선택을 안 풀면 머리 체크만 켜진 채 남아 다음 `checkAll` 이 반대로 동작한다.
- 페이지의 `checkAll()` 을 호출하지 않는다 — 토글 함수라 상태에 따라 켜버릴 수 있다.
  **`checked = false` 를 직접 쓴다.**

### 1.3 적용 범위

`sendBarPrint` 훅은 상품검색(`infoItemList.do`)과 상품입고(`inputItemWriteForm.do`) 양쪽이
공유한다. 두 화면 모두 뽑고 나면 선택 유지가 불필요하므로 **양쪽에 적용한다.**

### 1.4 구현 위치

`src/content.js` 의 `sendBarPrintReplacement()` — 성공 분기(`resp.ok` 가 참인 갈래) 안.
현재 그 자리는 `log('인쇄 완료', resp.result);` 한 줄뿐이다.

---

## 2. 작업 B — 적용시세 일괄변경

### 2.1 요구

기초상품관리에서 **여러 상품의 적용시세를 한 번에 같은 값으로** 바꾼다.
지금은 상품마다 수정 화면을 열어 한 건씩 고쳐야 한다.

### 2.2 범위 결정 (사용자 확정)

- 대상 = **목록에서 체크한 상품만**. 검색결과 전체·시세값 기준 일괄은 하지 않는다.
- 값 = **하나의 값으로 통일**. 증감(+50,000) 모드는 만들지 않는다.

> 7,273건 전수는 상품당 수정폼 1회 로드가 필요해 몇 시간짜리다. 체크 방식이면
> 한 화면 최대 500건으로 자연히 제한된다.

### 2.3 화면과 UI

화면 = `masterItemList.do?tcode=master_item_k` (품위정보보기). 다른 탭에서는 **뜨지 않는다.**

1. 데이터 행마다 **맨 앞에 새 `<td>` 를 하나 삽입**하고 체크박스를 넣는다.
   헤더 행에도 같은 자리에 전체선택 체크박스를 넣어 **열 수를 맞춘다.**
   기존 셀 인덱스를 건드리지 않으려면 삽입은 반드시 **맨 앞**이어야 한다.
2. 목록 위에 바를 붙인다: `새 적용시세 [______]` + `[일괄 변경]` + 선택 건수 표시.
3. 실행 중에는 진행률(`n / N`)과 현재 상품코드를 보여준다.

### 2.4 저장 방식 — 접근법 A (채택)

**상품 1건당 숨은 iframe 에 그 상품의 수정폼을 실제로 로드하고, 페이지 자신의 코드로
계산·검증·제출한다.**

```
for (상품 in 선택목록) {
  1. iframe.src = masterItemModifyForm.do?tcode=master_item&seq=<seq>   (로드 완료 대기)
  2. iframe 의 window.alert 을 가로채기로 교체 (문구를 잡아 두고 절대 띄우지 않음)
  3. form1.goldPrice.value = 새 시세 (페이지와 같은 천단위 콤마 표기로)
  4. iframe 의 calItemPrice(form1) 을 직접 호출
     → 입고공급가·판매가가 페이지 로직으로 재계산됨
  5. 재계산 결과(inputSupplyPrice1/2, salePrice1/2)를 읽어 로그에 기록
  6. 저장 버튼(input[name="imageField22"][type=image])을 click()
     → onsubmit=checkForm 발화 → 통과하면 네이티브 multipart 제출
  7. iframe 이 응답으로 이동 완료할 때까지 대기 → 성공/실패 판정
  8. 실패면 즉시 전체 중단
}
```

**왜 이렇게 하는가**

- **계산식을 베끼지 않는다.** §0.4 의 분기를 이식하면 틀렸을 때 전 상품의 가격이 조용히
  어긋나고, 원값을 모르면 되돌릴 수도 없다.
- **`multipart/form-data` 본문을 손으로 만들 필요가 없다**(§0.3).
- **`type=image` 의 `.x`/`.y` 와 `onsubmit` 이 자연히 딸려 온다**(§0.3).
  `form.submit()` 호출로는 둘 다 빠진다.
- **`sKey` 가 GET 마다 새로 발급되는데 iframe 로드가 그것을 자동으로 가져온다.**
- **이 ERP 의 알려진 함정 — 폼 중첩이 깨진 옛 HTML 이라 `DOMParser` 가 hidden 필드를
  놓치는 문제**([[project-ubishop-fetch-automation]] 함정1) — 를 실제 브라우저 파서라
  겪지 않는다.
- 외부 `/js/*.js`(`movePageForm` 등)가 iframe 안에서 정상 로드된다.

> 🔴 **`changeGoldPrice` 를 호출하지 마라.** 첫 줄이 `event.keyCode` 를 읽는데, 프로그램에서
> 부르면 `event`(= `window.event`)가 `undefined` 라 그 자리에서 TypeError 가 난다.
> 계산만 필요하므로 **`calItemPrice(form1)` 을 직접 부른다.**
> `calItemPrice` 는 값을 `removeComma` 로 정규화해 읽으므로 콤마 유무는 계산에 영향이 없다.
> 다만 **저장되는 값은 필드에 든 문자열 그대로**이니, 표기는 페이지가 쓰는 형식
> (`cashReturn` 이 만드는 천단위 콤마)에 맞춘다.

**비용**: 상품당 페이지 1회 로드(약 88KB). 100건 ≈ 3분 예상. 순차 처리로 서버를 밀지 않는다.

### 2.5 안전장치

1. **1건 시범 후 정지 (필수)**
   첫 상품만 저장하고 멈춘다. 그 상품을 **서버에서 다시 읽어** 시세·입고공급가·판매가를
   변경 전 값과 나란히 보여주고, 사용자가 `[나머지 N건 계속]` 을 눌러야 진행한다.
   이 단계가 §0.6 의 미확정(응답 형태)을 확인하는 자리이기도 하다.
2. **순차 처리.** 동시 실행 금지 — 같은 폼을 여러 개 띄우면 `sKey` 충돌 위험이 있다.
3. **실패 시 즉시 중단.** 그 지점까지만 반영되고, 남은 건은 손대지 않는다. 사유를 그대로 표시.
4. **처리 로그.** 상품코드·seq·전/후(시세·입고공급가·판매가)를 `localStorage` 에 남긴다.
   되돌려야 할 때의 유일한 근거다.
5. **alert 봉쇄.** iframe 의 `alert`/`confirm` 을 실행 동안 가로챈다. 안 하면 검증 실패
   한 건이 브라우저 전체를 멈춘다(§0.5).
6. **선택 0건이면 실행 자체를 막는다.** 새 시세가 비었거나 숫자가 아니어도 막는다.

### 2.6 하지 않는 것 (YAGNI)

- 증감(+/-) 모드
- 검색결과 전체 / 페이지 넘김 일괄
- 되돌리기(rollback) 실행 기능 — 로그만 남기고 되돌림은 사람이 판단한다
- 기본정보보기·이미지보기 탭 지원
- 시세관리(`/basic/gold/goldList.do`) 연동 — 마스터 상품의 적용시세는 그 화면과 자동
  연동되지 않는 별개 값이다(실측: 상품 900,000 vs 시세관리 금 현시세 180,000/190,000)

---

## 3. 배포

### 3.1 작업 A

`app-files.json` version 올림 → `git push`. 매장 PC 다음 페이지 로드에 반영. **재시작 불필요.**

### 3.2 작업 B

1. `manifest.json` 의 `content_scripts` 두 항목(ISOLATED `localbridge.js`, MAIN `loader.js`)에
   `http(s)://ubdstore.ubshop.biz/master/item/masterItemList.do*` 를 추가.
   `statis.js` 를 붙일 때와 **같은 방식**이다.
2. `app-files.json` 의 `files` 에 `src/masterprice.js` 추가 + version 올림.
3. manifest `version` 올림 — 규칙은 patch 9 초과 시 minor([[feedback-program-version-semver]]).
4. `pwsh build-shell-index.ps1` 로 `shell-files.json` 재생성.
5. **`node tests/loader-integrity.test.js`** 실행.
6. `git push`.

> ⚠ 4번과 5번 사이에 소스를 또 고치면 해시가 조용히 낡는다. 실제로 3번 밟은 함정이다.
> **인덱스 재생성은 코드 확정 뒤에** 한다.
> ⚠ `build-shell-index.ps1` 은 PowerShell 5.1 에서도 돌지만, 한글·BOM·들여쓰기가 pwsh 와
> 달라 diff 가 지저분해진다. 가능하면 `pwsh` 로 돌린다.

동반 저장소 `d102-label-printer` 의 동봉 확장 번들도 같은 버전으로 맞춰야 한다. 안 맞추면
프로그램 재시작 시 `SyncStableExtension` 이 회사·매장 PC 를 **옛 버전으로 되돌린다.**

---

## 4. 완료 기준

### 4.1 결정론적 게이트

- `node --check` — 손댄 모든 `.js`
- `node tests/loader-integrity.test.js` — 인덱스/해시 정합
- 신규 단위 테스트 전부 통과 + 기존 151건 회귀 없음

### 4.2 단위 테스트 (신규)

작업 A — `tests/barprint-uncheck.test.js`
- 성공 응답이면 `idx` 와 `all` 이 모두 해제된다
- 실패 응답이면 **어느 것도 해제되지 않는다**
- 체크박스가 하나도 없는 페이지에서 예외를 던지지 않는다

작업 B — `tests/masterprice.test.js`
- `master_item_k` 행에서 seq 를 뽑는다(`modify('7646')` → `7646`)
- `master_item` / `master_item_image` tcode 에서는 UI 를 붙이지 않는다
- 체크박스 삽입 후에도 기존 셀 인덱스(시세=4, 입고공급가=12, 판매가=14)가 그대로다
- 헤더와 데이터 행의 셀 수가 같다
- 선택 0건 / 빈 시세 / 숫자 아닌 시세는 실행이 거부된다
- 실패 1건이 나오면 뒤 상품을 시도하지 않는다

### 4.3 검수

`docs` 만 바뀐 게 아니라 **실행 코드**라, 결정론적 게이트 뒤에 **Opus 5 xhigh 검수와 로컬
Codex CLI 검수를 둘 다** 통과해야 한다(Critical/Important 0). 통합 여부는 사람이 정한다.

### 4.4 라이브 검증 (사람 + 메인 세션)

작업 A
- 상품검색에서 2건 체크 → 바코드인쇄 → **인쇄 성공 후 체크가 풀리는지**
- 프로그램을 끈 채 인쇄 → 실패 안내가 뜨고 **체크가 남아 있는지**

작업 B — **반드시 이 순서로**
1. `master_item_k` 에서 **1건만** 체크 → 현재 시세를 그대로 다시 입력(값 무변화) → 실행
   → 시범 정지 화면에서 입고공급가·판매가가 **변하지 않았는지** 확인. 여기서 어긋나면
   계산 경로가 잘못된 것이므로 **즉시 중단한다.**
2. 1건을 실제 다른 값으로 변경 → 시범 정지 → 서버 재조회값 확인 → **원래 값으로 되돌린다.**
3. 그 뒤에야 여러 건 실행.

> 🔴 라이브 운영 데이터다. 2번에서 되돌리기까지 마치기 전에는 다건 실행하지 않는다.

---

## 5. 소유권 (worker 별 수정 허용 경로)

| 작업 | 수정 허용 | 금지 |
|---|---|---|
| A | `src/content.js`, `tests/barprint-uncheck.test.js` | 그 외 전부 |
| B | `src/masterprice.js`(신규), `tests/masterprice.test.js` | 그 외 전부 |

🔴 **인덱스·배포 파일은 worker 가 건드리지 않는다.**
`app-files.json` · `manifest.json` · `shell-files.json` 은 **메인 세션이 단독 소유**한다.

이유가 둘이다.
1. A 와 B 가 `app-files.json` 을 공유해, 둘 다 쓰면 같은 파일을 동시에 고치는 금지 상황이 된다.
2. `shell-files.json` 은 **코드가 확정된 뒤에** 재생성해야 한다. worker 가 중간에 만들면
   그 뒤 수정으로 해시가 조용히 낡고, 그대로 push 하면 매장이 낡은 인덱스를 받는다
   (이 저장소에서 3번 밟은 함정).

이 분리 덕에 **A 와 B 는 병렬로 돌려도 된다.**
