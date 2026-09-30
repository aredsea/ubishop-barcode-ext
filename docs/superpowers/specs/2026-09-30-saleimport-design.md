# GS샵 판매 처리 가져오기 설계 (2026-09-30)

d102-atelier '판매 처리(판처)' 페이지가 내보낸 GS샵 xlsx(`GS샵_판매처리_<기간>.xlsx`)를 유비샵 **상품판매** 화면
(`/sale/item/saleItemWriteForm.do`) 사이드바에 올리면, 확장이 **고객 확정 → 주문 줄·바코드 매칭 → 판매 줄 등록 →
실판매가 입력 → 현금결제 → 판매하기**를 고객 단위로 대신 한다.

지금은 직원이 건마다 고객 구매정보 보기 → 주문내역에서 바코드 확인 → 상품판매에 바코드 입력 → 실판매가 입력 →
결제창 현금에 합계 입력 → 판매하기를 손으로 한다.

- 방식 **A 확정(2026-09-30 사장님)**: 주문 가져오기(`orderimport`)와 같은 fetch 어댑터 + 검토 표 + 순차 실행기.
  화면·팝업을 대신 클릭하는 방식(B)과 목록만 보여주는 방식(C)은 기각.
- 배포 채널: **SHELL**(manifest content_scripts 추가) — 적용에 브라우저 재시작 필요.
- 검수 등급: **T3**(되돌리기 어려운 라이브 쓰기 — 판매·결제).

---

## 1. 확정된 결정 (2026-09-30 사장님)

| # | 결정 |
|---|---|
| D1 | 입력 = atelier 판처 xlsx. 확장이 최종 판처금액을 **직접 계산**한다(파일에 수식만 있고 계산값이 없음 — 실측). |
| D2 | 사은품 주문 줄(예: `F-가죽트레이(사은품)`)은 **같은 판매전표에 같이 판매, 실판매가 0원**. |
| D3 | 반품 행(`주문유형 = 반품주문` 또는 수량 < 0)은 **자동 처리에서 제외** — 표에 '수동 처리 필요'로만 표시. |
| D4 | 실행 = 검토 표에서 체크한 고객을 **일괄 순차 실행**(주문 가져오기와 같은 방식). |
| D5 | 고객명이 `수취인+휴대전화 뒤4+/G` 와 **정확히 일치할 때만 자동**. 다르거나 없으면 **차단** — 사장님이 표에서 직접 고객을 검색해 고른다. 대체 매칭 후보를 자동 채택하지 않는다. |
| D6 | 판매전표 = **고객 1명당 1장**(같은 고객의 여러 행은 한 전표). |
| D7 | 이미 판매된 건(주문 줄의 바코드가 그 고객 판매내역에 있음)은 '이미 판매됨'으로 건너뛴다. 엑셀 첫 행 `하*이3785/G` 는 사장님이 테스트로 완료한 건(판매가 42,000 · DC 13,604 · 실판매가 28,396). |

---

## 2. 입력 계약과 계산

### 2.1 파일
- 첫 시트 `수수료매입상세_리스트_<기간>` (atelier 스펙 `2026-09-18-settle-gs-design.md` §D, 28열). **열은 헤더 이름으로 찾는다.**
- 사용하는 열: `주문번호` `주문유형` `상품명` `주문옵션` `수취인` `휴대전화` `수량` `협력사지급금액`(W) `할인쿠폰`(X)
  `반품유보`(Y) `딜광고`(Z) `반품유보 지급`(AA) `최종 판처금액`(AB).
- `합계` 행: Y·Z·AA 의 **입력 합계 값**(숫자)을 여기서 읽는다(행별 Y·Z·AA 는 수식이라 값이 없다).
- 데이터 행 = 헤더 다음부터 `합계` 행 전까지. 빈 행은 버린다.
- 필수 열이 없거나 `합계` 행이 없으면 **파일 거부**.

### 2.2 최종 판처금액
행 r 에 대해 (ΣW = 데이터 행 W 합, 반품 행 포함 — atelier 식과 동일):

```
Y_r  = Y합 × W_r / ΣW      Z_r = Z합 × W_r / ΣW      AA_r = AA합 × W_r / ΣW
최종_r = W_r − X_r − Y_r − Z_r + AA_r        (X 빈칸 = 0)
실판매 합계_r = round(최종_r)   — 원 단위 반올림(0.5 올림)
```
- 셀에 캐시된 계산값이 있으면(엑셀로 한 번 저장한 파일) 확장 계산과 **±1원 이내**인지 대조하고, 어긋나면 파일 거부.
- 실측 검증: `하*이3785` 행 28,395.82 → 28,396 = 사장님이 입력한 실판매가.

### 2.3 행 분류
| 분류 | 조건 | 처리 |
|---|---|---|
| 반품 | `주문유형 = 반품주문` 또는 수량 < 0 | 제외(수동 처리 필요 표시) |
| 일반 | 그 외 | 매칭 대상 |

---

## 3. 매칭 (검토 표 — 쓰기 0)

### 3.1 고객
1. 기대 고객명 = `수취인 + 휴대전화 숫자 뒤4 + '/G'`. 휴대전화가 비면 `수취인 + '/G'`(대부분 불일치 → 차단).
2. `POST /etc/client.do?tcode=sale_item`(`searchWordType=clientName`, 부분일치)로 검색 → 확장이 `이름 ===` 로 거른다.
   정확히 1명 → 자동. 0명·2명 이상 → **차단**.
3. 차단된 행: 표에 고객 검색창(수취인 이름을 미리 채움)과 결과 목록(고객명·휴대폰·seq). 사장님이 고르면 그 행은 그 고객으로 확정(이 세션에서만).
- 실측(2026-09-30): 17행 중 13행 자동, 4행 차단 — `이*성4691`(유비샵 `이*성 4691`), `최*순0254`(안심번호 바뀜, `최*순7951/G`로 추정), `최*순5922`(미발견), `민*금`(엑셀 번호 없음, 유비샵 `민*금2837/G`).

### 3.2 주문 줄과 바코드
고객이 확정되면 그 고객의 **주문내역**(`infoClientTradeView.do?vcode=orderitem`)과 **판매내역**(`vcode=saleitem`)을 읽는다.

- 주문 줄에서 뽑는 값: 주문일 · 바코드(6자리) · 상품번호 · 상품명 · 비고의 `정산 N` · 수량 · 주문가.
- **본품 매칭**: 판매되지 않은 주문 줄(바코드가 판매내역에 없음) 중 `정산 N` 이 다음과 같은 줄.
  - 수량 1: `정산 N = W_r`.
  - 수량 q > 1: `정산 N = W_r / q` 인 줄을 **q개**(실측: `박*주0248` 수량 2 → 정산 259,000 줄 2개, W=518,000).
  - 후보 수가 정확히 필요한 개수와 같아야 자동. 모자라거나 남으면 **차단**(사장님이 줄을 체크해 고름).
- **이미 판매됨**: `정산 N = W_r` 인 줄이 있는데 그 바코드가 판매내역에 있으면 '이미 판매됨' — 체크 불가, 건너뜀.
- **사은품**: 본품 줄과 **같은 주문일**이고 상품명에 `(사은품)` 이 들어간 판매 안 된 줄 → 같이 판매, 실판매가 0 (D2).
- 바코드가 빈 주문 줄(입고 전) → 그 행 **차단**('바코드 없음 — 입고 확인').

### 3.3 실판매가 배분
- 본품 q줄에 `실판매 합계_r` 를 균등 배분, 나누어떨어지지 않는 나머지 원은 첫 줄에.
- 사은품 줄 = 0.
- 고객 전표 현금 = 그 고객 모든 줄 실판매가 합.

### 3.4 검토 표
고객 단위로 묶어 접기/펼치기. 줄마다: GS 주문번호 · 상품명/옵션 · 고객(자동/선택) · 매칭된 바코드·유비샵 상품명 · 주문가 · 실판매가 · 판정.
- **차단(빨강, 체크 불가)**: 고객 미확정 · 주문 줄 매칭 실패(0개/과다) · 바코드 없음 · 금액 ≤ 0.
- **제외(회색)**: 반품 · 이미 판매됨.
- 체크 가능 고객은 기본 체크. 상단 요약: 처리 대상 고객 수 · 줄 수 · 현금 합계 · 차단/제외 수.

---

## 4. 실행 (체크한 고객 순차)

> **Phase 0 실측 완료(2026-09-30 14:17~14:33, 사장님 지시·입회)** — `민*금2837/G`(#123699) 1건을 실제로 판매했다.
> 바코드 2504L5 · 판매가 112,000 · DC 36,278(32.39%) · 실판매가 75,722 · 현금 75,722 · 판매전표 tradeJun **114348** · 결제 payJun **280453**.
> 완료 후 plain GET 세션 비움(tradeJun 빈값·idx 0), 판매내역에 위 값 그대로. 아래 표가 그 요청이다.

### 4.1 쓰기 계약 (라이브 실측)

| # | 단계 | 요청 | 페이로드 | 결과·판정 |
|---|---|---|---|---|
| 0 | 고객 선택(읽기) | `GET /sale/item/saleItemWriteForm.do?tcode=sale_item&client=<seq>&clientName=<enc>&shop=LT&shopName=FASHION` | — | 고객 팝업의 `setSeting` 이 하는 일 그대로(쓰기 없음). form1 에 `client`·`clientName` 이 채워지고 `sKey` 발급 |
| 1 | 줄 등록 | `POST /sale/item/saleItemWrite.do?tcode=sale_item` | form1 10필드: `sKey pageSize=20 searchSortType=seq tradeJun payJun shop=LT client shopName=FASHION clientName barcode`(첫 줄은 tradeJun·payJun 빈값) | `saleItemWriteForm.do?…&barcode=<bc>…` 로 리다이렉트. 응답 hidden `tradeJun` 에 **새 판매전표 번호**(첫 줄에서 생성). 목록 `input[name=idx]` value = `<saleSeq>,<barcode>` (예 `376143,2504L5`). 판매가 = 상품 판매가(112,000), 실판매가 = 판매가 |
| 2 | 실판매가 | `GET /sale/item/saleItemModifyForm.do?tcode=sale_item&seq=<saleSeq>&reqPage=1&pageSize=20&searchSortType=seq&tradeJun=<t>&payJun=&shop=LT&client=<c>&shopName=FASHION&clientName=<enc>` → `POST /sale/item/saleItemModify.do?tcode=sale_item` | form1 22필드: hidden `sKey pageSize searchSortType tradeJun payJun seq barcode shop client shopName clientName` + `salePrice saleQty tmpSalePrice`(읽기 전용, 그대로) + **`dcRate dcPrice saleDcPrice`** + `cashPoint saleManager tmpPoint usePoint remark`(그대로) | 화면 JS(`changeSaleDcPrice`→`calDcPrice2`·`calDcRate`)가 `dcPrice = tmpSalePrice − saleDcPrice`(36,278), `dcRate` = 소수 2자리(32.39)를 채운다 → **확장도 세 값을 같은 규칙으로 계산해 보낸다**. 금액은 콤마 문자열. 판매 화면으로 리다이렉트, 목록 행에 DC·실판매가 반영 |
| 3 | 현금결제 | `GET /pay/client/clientCashPayWriteForm.do?tcode=sale_item&url=/sale/item/saleItemWriteForm.do&tradeType=3&reqPage=1&pageSize=20&searchSortType=seq&tradeJun=<t>&payJun=&shop=LT&client=<c>&shopName=FASHION&clientName=<enc>` → `POST /pay/client/clientCashPayWrite.do` | form1: hidden `sKey url tcode reqPage pageSize searchSortType tradeType=3 tradeJun payJun shop client shopName clientName searchRegId searchJunNum searchTradeType searchShop searchWordType3 searchWord3 syear smonth sday eyear emonth eday` + **`payCash`**(콤마 문자열) `payCashPaper=0 payEtc=0 remark` | 같은 결제폼으로 리다이렉트, URL·hidden 에 **새 `payJun`**(280453), 화면 '총 결제금액' = payCash |
| 3b | 결제창완료(읽기) | `GET saleItemWriteForm.do?…&tradeJun=<t>&payJun=<p>…` | — | 팝업의 `setPay()` 는 opener 를 이 URL 로 다시 여는 것뿐(쓰기 없음). form10 `payCash payPrice` = 결제액, `afterPrice`(거래 후 미수) = 0 |
| 4 | 판매하기 | `POST /jun/saleitem/saleItemJunWrite.do?tcode=sale_item` | form10 24필드 그대로: `sKey pageSize searchSortType tradeJun payJun shop client payBank payDia payCard paySaleOldGold payCash payCashPaper payRemark payEtc txtSaleDate regId beforePrice beforePoint saleDcPrice usePoint payPrice savePoint afterPrice afterPoint` | plain 판매폼으로 리다이렉트. plain GET → tradeJun 빈값·idx 0. 판매내역에 줄. 화면의 `checkForm2` 는 `confirm("판매처리 하시겠습니까?")` 를 띄우지만 fetch 경로엔 해당 없음 |
| D | 판매 줄 삭제(**미실측**) | `POST /sale/item/saleItemDelete.do?tcode=sale_item` + CONST_URL | form3: `sKey` + 체크된 `idx`(=`<saleSeq>,<barcode>`) | 화면 `del(form2,form3)` 스크립트에서 읽음. 주문 가져오기와 같은 이유로 라이브 미실측 — fail-closed 로 설계 |

- `sKey` 는 매 쓰기 직전 GET 에서 새로 받고, 그 GET 과 POST 사이에 다른 GET 을 끼우지 않는다(주문 가져오기와 동일 규칙).
- 판매전표는 **로그인 세션당 1개**로 보인다(plain GET 이 열린 전표를 보여 준다) — 주문 가져오기 §5.0 과 같은 동시작업 위험.
- 결제(3)는 판매하기(4) **전에** 이미 결제전표(payJun)를 만든다. 3 이후~4 이전에 실패하면 결제전표가 남는다 → **3 이후 실패는 fatal(전체 중단·보고)**, 결제 취소를 자동으로 하지 않는다.
- ⚠ 사은품 줄(실판매가 0 → dcRate 100) 은 이번 실측에 없었다. 첫 라이브 실행에서 사은품 있는 고객 1명으로 확인한다.
- ⚠ Claude Code 의 자동 모드 검사가 3(현금결제)을 '실제 금전 거래'로 분류해 막았다(자사 ERP 장부 기록이며 금전 이동 아님 — 사장님 확인 후 권한 우회 모드에서 진행). **확장 런타임과는 무관**하다(확장은 사장님 브라우저에서 돈다).

### 4.2 고객 한 명의 흐름
1. **가드**: plain GET `saleItemWriteForm.do?tcode=sale_item&pageSize=20&searchSortType=seq` → tradeJun 빈값·idx 0 이 아니면 시작하지 않는다.
2. **줄 등록**(줄마다, §4.1-0·1): 고객 지정 GET(첫 줄) 또는 tradeJun 지정 GET → sKey → POST → 응답의 idx 목록에 그 바코드 행 +1, tradeJun 보관.
3. **실판매가**(줄마다, §4.1-2) → 판매폼 목록 행의 실판매가 = 기대값.
4. **최종 대조**: 판매폼 GET 의 줄 수·바코드·실판매가 합 = 검토 표.
5. **현금결제**(§4.1-3) → 응답 payJun 비어 있지 않음 + 총 결제금액 = 합계.
6. **판매하기**(§4.1-3b → 4) → form10 `afterPrice = 0` 확인 후 POST → plain GET 세션 비움 → 그 고객 판매내역에서 바코드·실판매가 재대조.
7. **실패 처리**: 5 이전 실패 → 넣은 판매 줄만 삭제(§4.1-D) → 세션 0행 확인 → 다음 고객(삭제 후에도 줄이 남으면 전체 중단). 5 이후 실패 → **전체 중단**하고 보고.

## 5. Phase 0 — 결과

2026-09-30 완료(§4.1 머리말). 남은 미실측: 판매 줄 삭제(§4.1-D) · 사은품 0원 줄 · 실패 응답의 `msg` 형식. 앞의 둘은 첫 라이브 실행에서, `msg` 는 실행기가 **응답 URL 의 msg 비어 있음 + 상태 변화** 이중 판정으로 fail-closed 처리한다.

## 6. 안전장치 (주문 가져오기 §5 계승)
1. 실행 전 가드(열린 판매전표 없음).
2. 실행 중 패널 조작 코드 잠금 + 유비샵 화면 조작 금지 안내 + `beforeunload` 경고. 실행 중엔 사장님이 상품판매·결제 화면을 만지지 않는다(주문 가져오기 동시작업 사고 전례).
3. 매 줄 전에 세션 대조(client·행 수·내가 넣은 줄의 바코드) — 다르면 그 고객 중단(내 줄만 삭제).
4. 결제 전 최종 대조(줄 수·바코드·실판매가·합계 = 검토 표).
5. `sKey` 는 쓰기 직전 GET 에서 받고 그 GET 과 POST 사이에 다른 GET 을 끼우지 않는다.
6. 모든 쓰기는 `msg` 빈값 **그리고** 상태 변화로 판정.
7. 실행 로그(고객별 단계·판정) JSON 내보내기.
8. 로컬 장부(`chrome.storage.local`) `GS주문번호 → {판매일, tradeJun, 바코드}` — '이전에 처리함' 경고용. 판매내역 대조(D7)가 1차 방어.

## 7. 구조
| 파일 | world | 역할 |
|---|---|---|
| `src/saleimport-core.js` | ISOLATED | 순수 함수: 헤더 매핑, 최종금액 계산·검산, 행 분류, 고객명 생성, 주문/판매내역 파싱, 줄 매칭, 배분, 판정. node 테스트 대상 |
| `src/saleimport-erp.js` | ISOLATED | 유비샵 어댑터: 고객검색 · 주문/판매내역 읽기 · 판매 줄 등록/수정/삭제 · 현금결제 · 판매하기 · 세션 상태 |
| `src/saleimport.js` | ISOLATED | 사이드바 패널 · 검토 표 · 실행기 · 로그 |
| `src/orderimport-xls.js` + `vendor/xlsx.full.min.js` | MAIN | **재사용**(background `ubOiInjectXls`) |
| `manifest.json` | | content_scripts 에 `saleItemWriteForm.do` 매칭(erp → saleimport-core → saleimport-erp → saleimport), version 4.2.9 → **4.3.0** |

HTML 파싱은 기존 규칙대로 hidden 필드는 **문자열 정규식**(DOMParser `form.elements` 가 hidden 을 놓침 — 이번 조사에서도 재확인), 표는 DOMParser.

## 8. 테스트
- 단위(`tests/saleimport-*.test.js`): 이 xlsx 를 행 배열 픽스처로 — 최종금액(하*이 28,396 · 합계 = Σ최종) · 반품 제외 · 고객명(휴대전화 없음 포함) · 주문내역 파싱(사은품·수량 2·바코드 없음) · 매칭(정확 1 / 0 / 과다 / 이미 판매됨) · 배분(나머지 원).
- 배선: 가짜 fetch 로 실행기 — 가드 실패·세션 불일치·최종 대조 실패 시 결제/판매 POST 를 부르지 않음. 변이(가드·대조 제거) KILL 확인.
- 라이브: Phase 0 후 사장님 입회로 1~2명 체크 실행.
- 검수: T3.

## 9. 범위 밖
반품·환불 처리 · 다른 마켓 판처 파일 · 대체 고객 자동 매칭 · 결제 후 자동 취소.
