# 매장 제품 가격 변경 (원버튼) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 상품검색 화면에서 체크한 매장 출고 제품(일반·회전)을 버튼 하나로 출고 삭제 → 입고 소비자가·판매가 변경 → 원래 매장 재출고(인쇄 없음)까지 처리한다.

**Architecture:** 주문 가져오기와 같은 3층 구조. `storeprice-core.js`(순수 로직·실행기, node 테스트) · `storeprice-erp.js`(유비샵 fetch + 수정 화면 숨은 iframe 저장) · `storeprice.js`(버튼·패널 UI). ISOLATED content script 로 infoItemList.do 에만 싣는다. 표·폼 파싱은 `orderimport-core.js` 의 `oiTListAllRows`·`oiExtractHidden`·`oiSelectOptions`·`oiSubmitResult` 를 재사용한다.

**Tech Stack:** MV3 content script(ISOLATED), fetch(credentials include), node:test.

## Global Constraints

- 대상 구분: 일반(A)·회전(Z)만. 고객(B)·수리(X) 건너뜀. 판정은 매장출고전표 행 구분 열.
- 처리 조건: 출고전표 최신 1행의 상태가 정확히 `출고완료`.
- 금액 1개 → `basicSalePrice`·`salePrice` 둘 다 같은 값(쉼표 포맷 `1,234,000`).
- 재출고 `printFlag=0`.
- 2~4단계(입고 찾기·저장·확인) 실패 시에도 재출고는 반드시 실행 → 전체 정지.
- 첫 1건 시범 후 정지, [나머지 진행] 으로 계속.
- 한 번에 1건(직렬). 모든 fetch 30초 abort. 세션 끊김(ubshop.biz 밖 리다이렉트)은 실패.
- 🔴 수정 화면은 fetch 직렬화 금지 — 선택칸 6개(origin·orderType·shop·k·stoneStyle2·color)를 페이지 스크립트가 로드 후 채운다(2026-10-23 실측: HTML 값 빈칸, 화면 값 1/A/00/5/I/XY). 반드시 iframe 에서 실제 폼으로 저장.
- 스위치: `chrome.storage.local.ubSkin` 이 켜져 있을 때만 버튼 표시.
- 껍데기 파일(manifest) 변경 → manifest version 4.3.9→4.4.0, `pwsh build-shell-index.ps1`, `node tests/loader-integrity.test.js`.

---

### Task 1: core — 출고 행 파싱·분류·재출고 본문

**Files:**
- Create: `src/storeprice-core.js`
- Test: `tests/storeprice-core.test.js`

**Interfaces:**
- Consumes: `globalThis.ubOi` / `require('./orderimport-core.js')` 의 `oiTListAllRows(html)`, `oiExtractHidden(html)`, `oiSelectOptions(html,name)`, `oiSubmitResult(url)`.
- Produces (`globalThis.ubSp`, `module.exports`):
  - `spParsePrice(s) → number|null` — 쉼표 허용 양의 정수, 1~999,999,999. 그 외 null.
  - `spComma(n) → string`
  - `spDelivRows(html) → [{idx, barcode, junNum, delivDate, kind, orderType, itemType, shopText, status, salePrice}]` — 헤더 이름으로 열을 찾고(못 찾으면 실측 기본 2/4/7/8/12/14), `kind` 예 `"일반 (상품)"` → orderType A·itemType 1. 구분 맵 `{일반:'A',고객:'B',수리:'X',회전:'Z'}`, `{상품:'1',메인석:'2'}`.
  - `spShopCode(shopText, opts) → {code,name}|null` — opts=`oiSelectOptions(writeHtml,'searchShop')`, 값 빈 옵션 제외, shopText 가 옵션 text 로 시작하는 것 중 가장 긴 것.
  - `spClassify(barcode, rows, shopOpts) → {go:true, target}|{go:false, reason}` — rows 중 barcode 정확일치 첫 행(서버가 seq 내림차순). reason: `출고 내역 없음` · `구분 고객 — 대상 아님` · `구분 수리 — 대상 아님` · `구분 판독 불가` · `상태 X — 출고완료 아님` · `매장 판독 불가`. target = `{barcode, idx, junNum, shop:{code,name}, orderType, itemType, salePrice}`.
  - `spForm1Segment(html) → string` — `<form name=form1` 부터 다음 `<form` 직전.
  - `spRedelivPairs(writeHtml, target) → {pairs, missing}` — form1 구간 hidden(sKey·pageSize·searchSortType·listFlag) + `searchShop`·`searchOrderType`·`searchItemType`·`barcode`·`printFlag='0'`. hidden 의 printFlag 는 버린다. sKey 없으면 missing.

- [ ] Step 1: 픽스처 문자열로 실패 테스트 작성 — 실측 행(`427695,260AIM,47585,390275`, 구분 "고객 (상품)", 매장 "누리엔점925 1 g", 상태 "출고완료")과 일반·회전·수리·상태 미확인·매장 미상·바코드 echo(검색폼에만 있고 행 없음) 케이스, 금액 파싱 경계(0, 음수, "1,2a", "1,000,000"), 재출고 본문에 `printFlag=0`·hidden printFlag 제거·form2/form10 의 sKey 미혼입.
- [ ] Step 2: `node --test tests/storeprice-core.test.js` → FAIL(모듈 없음)
- [ ] Step 3: 구현
- [ ] Step 4: PASS 확인
- [ ] Step 5: 커밋 `feat(매장가격): core 파싱·분류·재출고 본문`

### Task 2: core — 실행기(필수 재출고·정지·시범)

**Files:**
- Modify: `src/storeprice-core.js`
- Test: `tests/storeprice-run.test.js`

**Interfaces:**
- Consumes: erp 어댑터 E = `{ log(entry)→bool, deleteDeliv(target)→{ok,msg}, findVoucherItem(barcode)→{ok, modifyUrl, msg}, savePrice(modifyUrl, price)→{ok,msg}, verifyPrice(modifyUrl, price)→{ok,msg}, redeliver(target)→{ok,msg}, verifyRedeliv(target)→{ok,msg} }`
- Produces:
  - `spRunOne(target, price, E) → {barcode, status:'ok'|'price_failed'|'stranded'|'delete_failed', step, msg, priceChanged:bool}`
    - log(before_delete) 실패 → delete_failed(삭제 안 함)
    - delete 실패 → delete_failed
    - find/save/verify 중 실패 → 재출고 실행 → 성공이면 price_failed(가격 그대로 복귀), 실패면 stranded
    - redeliver/verifyRedeliv 실패 → stranded
    - 예외도 같은 규칙(삭제 이후 예외는 재출고 시도)
  - `spRunAll(targets, price, E, {limit, onItem}) → results` — `limit` 건까지만, ok 아닌 결과에서 즉시 정지.

- [ ] Step 1: 스텁 E 로 실패 테스트 — 성공 경로 호출 순서 · find 실패/save 실패/verify 실패/save 예외 각각 redeliver 호출됨 + 정지 · redeliver 실패 → stranded · log 실패 → delete 미호출 · limit=1 이면 1건만 · 정지 후 나머지 미처리.
- [ ] Step 2: FAIL 확인
- [ ] Step 3: 구현
- [ ] Step 4: PASS · 변이(재출고 호출 제거, 정지 제거) 시 FAIL 확인 후 원복
- [ ] Step 5: 커밋 `feat(매장가격): 실행기 — 실패해도 원래 매장 재출고`

### Task 3: erp 어댑터

**Files:**
- Create: `src/storeprice-erp.js`

**Interfaces:** Task 2 의 E + `lookup(barcode)→{rows, shopOpts}` (출고전표 조회 + 출고 화면 GET 의 searchShop 옵션).

구현 요점:
- `req/post` — orderimport-erp 와 같은 패턴(30초 abort, ubshop.biz 밖이면 throw).
- 출고 조회: `POST /jun/delivitem/delivItemList.do?tcode=deliv_item` 본문 `{syear:'2000',smonth:'01',sday:'01',eyear,emonth,eday(오늘), pageSize:'100', searchSortType:'seq', searchDateType:'delivDate', searchBarcode}` → `spDelivRows` + 응답 sKey.
- 삭제: 같은 검색조건 쿼리 + 본문 sKey·idx → `POST /jun/delivitem/delivItemDelete.do?tcode=deliv_item` → `oiSubmitResult`.
- 입고 찾기: `/jun/inputitem/inputItemList.do`(searchBarcode, 2000-01-01~오늘) 첫 데이터행 '입고장번호' 열 → `/jun/inputitem/inputItemJunList.do?tcode=input_item_jun`(searchJunNum, searchItemType=1) 행의 `view(N)` → `POST /input/item/inputItemWriteForm.do?tcode=input_item` {jun:N} → 바코드 행의 `modify(M)` → `/input/item/inputItemModifyForm.do?tcode=input_item&seq=M&jun=N`.
- 저장(iframe): 숨은 iframe 로드 → iframe 문서에 `<script>` 주입해 alert/confirm 을 기록 후 통과(confirm=true) → form1 전 필드 스냅샷 → 두 칸 쉼표 금액 → `input[name=imageField22]` 중 `b.form===form1` 클릭(없으면 저장 안 함) → 다음 load 대기(30초) → URL msg·기록된 alert 로 판정.
- 저장 확인: iframe 으로 수정 화면 재로드 → 두 칸 = 금액, 나머지 필드(sKey 제외) = 저장 전 스냅샷.
- 재출고: `GET /deliv/item/delivItemWriteForm.do?tcode=deliv_item` → `spRedelivPairs` → `POST /deliv/item/delivItemWrite.do?tcode=deliv_item` → `oiSubmitResult`.
- 재출고 확인: 출고 재조회 최신 행이 같은 매장명 · 출고장번호 ≠ 이전.
- 로그: `localStorage['UB_SP_LOG']` 배열(최근 500).

- [ ] Step 1: 구현
- [ ] Step 2: 라이브 **읽기 전용** 점검 — 콘솔에서 `ubSpErp.lookup('<바코드>')`·`findVoucherItem` 은 출고 삭제 전이라 수정 링크가 없다는 것까지 확인(쓰기 함수는 부르지 않는다)
- [ ] Step 3: 커밋 `feat(매장가격): 유비샵 어댑터`

### Task 4: UI·배선·배포 준비

**Files:**
- Create: `src/storeprice.js`
- Modify: `manifest.json` (content_scripts 항목 추가: matches infoItemList.do http/https, js `src/erp.js, src/orderimport-core.js, src/storeprice-core.js, src/storeprice-erp.js, src/storeprice.js`, ISOLATED, document_idle; version 4.4.0), `shell-files.json`(재생성)
- Test: `tests/storeprice-wiring.test.js` — manifest 항목·로드 순서, storeprice.js 가 `printFlag`·직접 삭제를 하지 않고 core 실행기만 부르는지 정적 검사

UI:
- `a[href*="sendBarPrint"]` 뒤에 버튼 `매장 제품 가격 변경`(D102 틸 #4abcc7, 유비샵 버튼 높이 22px 에 맞춤). ubSkin 꺼짐이면 안 그림.
- 클릭 → 체크된 `form2` idx(바코드) 수집, 없으면 안내.
- 패널(우측 고정, 폭 520): 금액 입력(쉼표 자동) · [조회] → 표(바코드·매장·구분·현재 판매가·판정) · [시작 — 첫 1건 시범] → 결과 줄 · [나머지 진행] · [닫기](실행 중엔 확인).
- 실행 중 `beforeunload` 경고.
- stranded 는 빨간 굵은 글씨 `본사에 남아 있음 — 직접 출고 필요`.

- [ ] Step 1: wiring 테스트 작성 → FAIL
- [ ] Step 2: UI·manifest 구현 → PASS
- [ ] Step 3: 전체 테스트 `node --test tests/` PASS
- [ ] Step 4: `pwsh build-shell-index.ps1` → `node tests/loader-integrity.test.js` PASS
- [ ] Step 5: 커밋 `feat(매장가격): 상품검색 버튼·패널 (4.4.0)`

### Task 5: 검수·배포·시연

- [ ] 검수 등급 판정(라이브 출고 삭제·재출고 → T3) 후 `docs/REVIEW-LEDGER.md` 규칙대로 검수
- [ ] 사장님 확인 후 main 병합·push → 프로그램 동기화 → 브라우저 재시작
- [ ] 사장님이 고른 제품 1건으로 시연(조회 → 시범 1건 → 결과 대조)
