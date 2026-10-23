# 매장 제품 가격 변경 (원버튼) — 설계

- 날짜: 2026-10-23
- 요청: 사장님
- 기반 코드: `src/skin.js` 5.5a "출고 확인 취소 → 판매가 수정"(dcm*) — 1~4단계를 이미 실사용 중

## 목적

매장에 출고된 제품의 소비자가·판매가를 바꾸려면 지금은 사람이 ①출고 삭제 ②입고장 찾기 ③수정 화면에서 가격 입력·저장 ④원래 매장으로 재출고(프린터 팝업 닫기)를 제품마다 손으로 한다. 상품검색 화면에서 체크한 제품을 버튼 하나로 일괄 처리한다.

## 범위

- 대상: 상품검색 화면(`/info/item/infoItemList.do`)에서 체크한 제품(바코드 기준).
- **주문 구분이 일반(A)·회전(Z)인 출고 건만.** 고객(B)·수리(X)는 건너뛴다. 판정 기준은 매장출고전표 행의 구분 열이다.
- 가격: 금액 1개를 받아 **소비자가(`basicSalePrice`)와 판매가(`salePrice`)에 같은 값**을 넣는다.
- 출고 내역이 없는 제품: 건너뛰고 결과에 표시(가격도 안 바꾼다).

범위 밖: 제품마다 다른 금액, 기초상품관리 판매가 자동 조회(기존 dcm 기능의 몫), 출고장 번호·출고일 복원(재출고는 새 출고장·오늘 날짜로 잡힌다).

## 실측 근거 (2026-10-23, 읽기 전용)

| 단계 | 엔드포인트 | 실측 |
|---|---|---|
| 출고 조회 | `POST /jun/delivitem/delivItemList.do?tcode=deliv_item` | 행 idx 체크박스 value `427695,260AIM,47585,390275`(2번째=바코드). 열: 2 출고장번호 · 4 출고일 · 7 구분 "고객 (상품)" · 8 매장명+상품정보 · 12 판매가 · 14 상태 |
| 출고 삭제 | `POST /jun/delivitem/delivItemDelete.do?tcode=deliv_item` + 검색조건 | 본문 sKey + idx. 기존 `dcmDelete` 그대로 |
| 입고장 찾기 | `barcodeToJunNum` → `junNumToSeq` → `inputItemWriteForm.do`(jun) → `dcmPickVoucherItem` | 기존 코드 그대로. 출고된 품목은 수정 링크가 없으므로 삭제가 먼저다 |
| 입고 수정 | `GET /input/item/inputItemModifyForm.do?tcode=input_item&seq=…&jun=…` → form1 `POST /input/item/inputItemModify.do` | `basicSalePrice`(소비자가)·`salePrice`(판매가)는 onKeyUp 에 쉼표 포맷만 있고 재계산 없음. onsubmit=`checkForm`→`movePageForm`(validate+중복가드). 저장 버튼 `input[type=image][name=imageField22]`(form.elements 에서 빠지고 form 의 DOM 자손이 아닐 수 있음) |
| 재출고 | `/deliv/item/delivItemWriteForm.do?tcode=deliv_item` form1 → `POST /deliv/item/delivItemWrite.do?tcode=deliv_item` | form1 필드: sKey·pageSize·searchSortType·listFlag(h)·searchShop·searchOrderType·searchItemType·barcode·printFlag. 바코드 엔터=`checkBarcode`→form1.submit 으로 즉시 출고 |
| 프린터 팝업 | 같은 화면 | `printFlag`(체크박스 기본 checked, hidden 기본 1). 1이면 출고 뒤 `sendPrint(jun)` 이 `delivItemJunPrintView.do` 창을 연다. **0으로 보낸다** |

매장 코드(searchShop): GE 거제점 · GJ 광주점 · KH 김해점 · NU 누리엔점 · DG 대구점 · ME 메리움점 · CT 센텀점 · SW 수원점 · US 울산점 · IN 인천점 · CW 창원점 · LT FASHION · 00 D102본사. 출고 행의 매장명(열 8 앞부분)을 옵션 텍스트와 대조해 코드로 바꾼다 — 화면에서 옵션을 읽어 쓰고 표를 코드에 박지 않는다.
구분 코드(searchOrderType): A 일반 · B 고객 · X 수리 · Z 회전. 상품/메인석(searchItemType): 1 상품 · 2 메인석 — 출고 행 구분 열 괄호 안 값.

## 흐름

### 1. 버튼·입력창
상품검색 화면 [바코드 인쇄] 옆에 **[매장 제품 가격 변경]** 버튼. 누르면 패널: 체크한 바코드 목록 + 금액 입력 1칸(천단위 쉼표, 0·비숫자 거부).

### 2. 사전 조회 (쓰기 없음)
바코드마다 출고전표 조회 → 원래 매장·구분·현재 판매가·상태를 표로. 분류:
- 처리 예정: 구분 일반/회전, 매장 코드 대조 성공
- 건너뜀: 출고 내역 없음 / 구분 고객·수리 / 매장 코드 대조 실패 / 상태가 출고완료가 아님
사장님이 표를 보고 [시작]을 눌러야 진행한다.

### 3. 제품 1건 처리 (직렬)
1. **출고 삭제** — 삭제 직전에 처리 로그(바코드·출고장번호·매장·구분·idx)를 남긴다. 로그를 못 남기면 삭제하지 않는다.
2. **입고장 찾기** — 기존 dcm 경로로 수정 seq·jun 확보.
3. **가격 저장** — 숨은 iframe 에 수정 화면을 열고 두 칸에 금액 입력 → 저장 버튼 클릭(문서 조회 + `btn.form === form1` 대조로 찾고, 못 찾으면 저장하지 않는다). iframe 의 alert/confirm 은 가로채 사유로 기록한다. 저장 후 리다이렉트 URL 의 `msg` 가 비었으면 성공.
4. **저장 확인** — 수정 화면을 다시 GET 해 두 칸 값이 입력 금액과 같은지 대조.
5. **재출고** — 출고 화면 GET → hidden 정규식 추출(sKey 등) → searchShop=원래 매장, searchOrderType=원래 구분, searchItemType=원래 값, barcode, **printFlag=0** POST. 리다이렉트 `msg` 로 판정.
6. **재출고 확인** — 출고전표를 다시 조회해 그 바코드가 그 매장으로 출고돼 있는지 확인.

### 4. 실패 처리
- 2~4 실패 → **5 재출고는 반드시 실행**(예전 가격 그대로 원래 매장으로 복귀) → 전체 정지.
- 5·6 실패 → "본사에 남아 있음 — 직접 출고 필요"를 빨간색으로 표시 → 전체 정지.
- 1 실패 → 아무것도 바뀌지 않았으므로 정지만.
- 모든 fetch 에 시간 제한(abort). 응답이 없으면 실패로 친다.

### 5. 시범
첫 처리 예정 1건만 처리하고 멈춘다. 결과를 보여 주고 [나머지 진행]을 눌러야 계속한다.

### 6. 결과
바코드별: 매장 · 구분 · 이전 판매가 → 새 금액 · 성공/건너뜀/실패(단계·사유). 처리 로그는 localStorage 에 남는다(기존 `UB_DCM_LOG` 와 별도 키).

## 안전 원칙
- 한 번에 1건만 쓴다(병렬 금지).
- 삭제 전 로그, 로그 실패 시 삭제 금지.
- 저장 버튼·매장 코드 등 판단이 안 서면 쓰지 않고 멈춘다(fail-closed).
- 페이지 이탈 경고(작업 중).
- 운영 데이터로 시험하지 않는다 — 실기 시험은 사장님이 고른 제품 1건으로 함께 한다.

## 테스트
- 단위: 출고 행 파싱(구분·매장·상품/메인석), 매장명→코드 대조, 금액 파싱, 분류(처리/건너뜀), 재출고 POST 본문(printFlag=0·구분·매장).
- 흐름: fetch·iframe 을 가짜로 바꾼 하네스로 성공·각 단계 실패 시 "재출고는 반드시 실행"·정지 동작 검증. 저장 버튼은 실제 제약대로(form.elements 에 없음, 문서 조회로만 발견) 재현한다.
- 변이: 재출고 생략·printFlag=1·구분 필터 제거 변이가 테스트에 잡히는지 확인.
- 실기: 사장님 입회하에 1건.
