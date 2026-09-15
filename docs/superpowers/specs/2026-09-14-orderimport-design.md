# 판매처 주문 가져오기 설계 (2026-09-14)

이지어드민 `확장주문검색` 엑셀(xls)을 유비샵 판매처 주문 화면(`/order/item/orderItemWriteForm.do`)에서
사이드바에 올리면, 확장이 **고객 검색/등록 → 상품 줄 등록 → 주문장 완료**를 주문장 단위로 대신 한다.
지금은 판매처 직원이 건마다 고객 등록 팝업·상품 검색 팝업을 열어 손으로 넣는다.

배포 채널은 **SHELL**(`manifest.json`, 새 `src/orderimport*.js`, `vendor/`, `popup/*`)이라 적용에 브라우저 재시작이 필요하다.

> **Phase 0 완료(2026-09-14, 사장님 감독 하 실제 주문 4건)** — 쓰기 계약 5건 중 4건을 실측으로 닫았다(§4).
> 남은 1건(휴대폰 중복 등록을 서버가 거부하는지)은 설계상 영향이 없다(검색으로 먼저 걸러 빈칸으로 넣는다).
> 같은 세션의 수동 작업과 섞이는 사고를 **실제로 겪었다**(§5.0) — 안전장치는 그 사고에서 도출했다.

---

## 1. 확정된 결정

| # | 결정 | 근거 |
|---|---|---|
| Q1 | 입력 = 이지어드민 xls 업로드 → 주문 일괄 생성 | 매일 반복되는 수작업의 출발점이 이 파일 |
| Q2 | 상품 매칭 = **학습 매핑표**(B) + **추천 후보 표시**(C). 이지어드민에는 유비샵 상품코드가 없어 A 불가 | 사장님 확정 |
| Q3 | 고객 = 고객명 정확일치 검색 → 재사용 / 없으면 휴대폰 검색 → 다른 이름이 그 번호를 쓰면 **휴대폰 빈칸으로 신규** / 아니면 휴대폰 포함 신규 | 예물고객이 같은 번호로 등록돼 있는 경우(실측: `010-0000-3269` = `라마바/가나다`) |
| Q5 | 주문가 = 엑셀의 **`판매가` 열**(사장님이 양식에 추가). 정산금액은 비고 `정산 12,133 원` | xls에는 마켓별 실판매가가 없음 |
| Q5 | 옵션명 자동 분해(품위·색상·사이즈), 못 푸는 토큰은 검토 | |
| Q6 | 주문장 = `판매처+주문번호`로 묶어 한 주문장에 N줄. 사은품 행도 같은 줄 | 실제 등록도 한 관리번호 아래 여러 줄 |
| Q7 | 중복 방지는 로컬 장부 **경고만**(막지 않음). 아침 파일 기준으로 그날 처리하는 운영이라 실제 중복은 없음 | 사장님 확정 |
| Q8 | 마켓 접미 코드표(§2.3). 표에 없는 판매처는 검토 | 사장님 확정 |
| Q9 | 매핑표·장부 = `chrome.storage.local` + JSON 내보내기/가져오기. 우선 **이 PC 한 대** | 두 번째 PC는 나중에 기본표 GitHub(3안)로 |
| 실패 | 실패한 주문장은 **되돌리고 건너뛴다**, 다음 주문장 계속. 되돌리기까지 실패하면 전체 중단 | 사장님 확정 |
| 파일 | `.xls`(BIFF8) 그대로 읽는다 — SheetJS full 빌드를 패널 열 때만 로드 | 이지어드민은 xls만 내려줌. mini 빌드는 xls 불가(실측 `parse_xlscfb is not defined`) |

---

## 2. 입력 계약과 정규화

### 2.1 파일
- 이지어드민 `확장주문검색` xls(BIFF8, 실측 `biff_version 80`, 문자열 UTF-16). `.xlsx`도 같은 코드로 읽는다.
- 첫 행이 헤더. **열은 이름으로 찾는다**(순서·추가 열 무관). `합계` 행과 빈 행은 버린다.

| 열 | 용도 | 없으면 |
|---|---|---|
| `판매처` | 마켓코드·유비샵 마켓 셀렉트 | 파일 거부 |
| `주문번호` | 주문장 묶음 키·장부 키 | 파일 거부 |
| `상품명` `옵션명` | 매핑표 키·추천 검색어·옵션 분해 | `상품명` 없으면 거부, `옵션명` 없으면 빈값 |
| `판매가` | 유비샵 주문가(orderPrice) | 열이 없으면 파일 거부. **값이 비면 그 줄은 검토**(마스터가로 대체하지 않는다) |
| `정산금액` | 비고 `정산 12,133 원` | 비면 비고에 정산 문구 생략 |
| `수령자이름` `수령자휴대폰` | 고객명·휴대폰 | 없으면 파일 거부 |
| `수량` | 줄 수량 | **없으면 1**(현재 내보내기에 이 열이 없다 — 행 하나 = 수량 1) |
| `상태` | 표시만 | — |

### 2.2 행 정규화
- **휴대폰**: 숫자만 남긴 뒤 하이픈 재구성. 11자리 `3-4-4`(010…), 12자리 `4-4-4`(0504 안심번호), 10자리 `3-3-4`(`106-0000-2567` 같은 가상번호). 유비샵은 **하이픈 형식으로 저장·검색**한다(실측: `01000003269` 0건, `010-0000-3269` 1건). 그 외 길이는 원문 그대로 두고 검토 표시.
- **고객명** = `수령자이름 + 휴대폰 뒤4자리 + '/' + 마켓코드`. `가*나`처럼 마스킹된 이름도 그대로.
- **비고**(shopRemark) = `정산 ${정산금액 천단위 콤마} 원` + 매핑표의 `remarkSuffix`가 있으면 ` ${suffix}` (예: `정산 44,138 원 /블루칼세도니`).
- **옵션명 분해** `[14K-로즈골드-15호]` → 토큰을 `-`로 나눠 각각 해석:
  - `14K`/`18K`/`925` → 품위(k). 폼의 k 셀렉트에 그 값이 있을 때만 적용(925 상품은 `[5:925]` 하나뿐).
  - 색상표: 로즈골드·핑크→`PG`, 옐로우골드·옐로우→`YG`, 화이트골드·화이트→`WG`, 리얼화이트→`RW`, 블랙→`BK`, 플래티넘→`PT`. 폼 color 셀렉트에 있는 값만.
  - `NN호` / `NNcm` / 숫자만 → 사이즈(itemSize). 숫자만 넘긴다.
  - 해석 안 되는 토큰(`3푼` 등) → 그 줄 **검토**(해석된 나머지는 채워 둠).
  - 옵션 없음 → 품위·색상·사이즈 전부 **마스터 기본값 그대로**. 사이즈는 `40+5`처럼 문자열일 수 있으므로 숫자 변환하지 않는다.
  - 마스터 기본 색상이 빈값이면 상품코드 4번째 토막(`F-NF-P-WG-UU-00DH` → `WG`)이 셀렉트에 있으면 그 값, 아니면 검토.
- **주문장 묶기**: `판매처|주문번호`가 같은 행을 파일 순서대로 한 주문장에.

### 2.3 마켓 코드표 (확정)

| 판매처 | 접미 | 유비샵 `clientJob` |
|---|---|---|
| 쿠팡 | 쿠 | 8 |
| 아몬즈 | 아 | 18 |
| 카페24 | 카 | 6 |
| GS샵 | G | 7 |
| 스마트스토어 | 스 | 5 |
| SSG | s | 2 |
| G마켓 | 지 | 13 |
| 지그재그 | 지 | 17 |
| 옥션 | 옥 | 14 |
| 카카오 | K | 11 |
| 롯데ON | 롯 | 10 |
| H몰 | H | 4 |
| 퀸잇 | 퀸 | 20 |
| 에이블리 | 에 | 21 |

- G마켓·지그재그가 같은 접미 `/지`인 것은 사장님이 인지한 상태로 확정. 유비샵 마켓 셀렉트는 따로 맞게 넣는다.
- 표에 없는 판매처(11번가·위메프·CJ몰·AK몰·더리본샵·오늘룩 등) → 그 주문장 **검토**(사람이 접미·마켓을 고르면 그 세션에서만 사용, 표에 저장하지 않음).

### 2.4 매핑표 (chrome.storage.local `ub_orderimport_map`)
```
{ "<key>": { seq: "7083", code: "F-RF-I-WG-PA-00F6", name: "F-퓨어컷팅(실버)R",
             remarkSuffix?: "/블루칼세도니", colorFallback?: "WG", learnedAt: "2026-09-14T…" } }
```
- key 1순위 `norm(상품명)|품위-색상`(옵션에서 사이즈를 뺀 부분, 예 `14k,18k핑크로맨스귀걸이|14-YG`), 2순위 `norm(상품명)`. `norm` = 공백 제거·소문자·전각 괄호 정규화.
- 조회는 1순위 → 2순위. 사람이 검토 표에서 고르면 **그 행의 1순위 키와 2순위 키 둘 다** 저장(옵션이 없던 행은 2순위만).
- `remarkSuffix`·`colorFallback`은 검토 표의 줄 편집에서 넣으면 함께 저장.
- 장부 `ub_orderimport_ledger`: `{ "<판매처|주문번호>": { at, tradeJun, junNum?, lines: n } }` — 경고 표시 전용.

---

## 3. 파이프라인

```
xls 읽기(SheetJS, MAIN) → 행 정규화 → 주문장 묶기 → 매핑 조회(+추천) → [검토 표] → 실행(주문장 순차) → 결과·장부
```

### 3.1 파일 읽기
- 사이드바 `<input type=file>`(ISOLATED)에서 `ArrayBuffer`를 얻어 MAIN에 `postMessage` → MAIN의 SheetJS가 `sheet_to_json(header:1)`로 행 배열을 돌려준다. SheetJS는 background가 `chrome.scripting.executeScript({target:{tabId}, world:'MAIN', files:['vendor/xlsx.full.min.js','src/orderimport-xls.js']})`로 **패널을 처음 열 때만** 주입한다(기존 `scripting` 권한).
- 주입 실패(파일 없음·권한) → 패널에 "엑셀 읽기 모듈을 못 불러왔습니다" + 재시도. 대체 경로 없음.

### 3.2 추천 후보
- 미매칭 줄마다 상품명에서 범주어(`Silver925`, `14K, 18K`, `14K,18K`, `반지·목걸이·귀걸이·팔찌·피어싱·이어커프·발찌`, `[사은품]`, 괄호 안 `(1개)`)를 빼고 남은 토큰을 **공백 제거**한 검색어로 `orderMasterItem.do` 검색(부분일치 — 실측: `퓨어 컷팅` 0건, `퓨어컷팅` 4건). 괄호 안에 유비샵 상품명이 들어 있으면(`(심플가드링R(대)2.3m)`) 그 문자열을 1순위 검색어로.
- 결과 상위 10개를 셀렉트로. 0건이면 검색창에 직접 입력해 다시 검색.
- 추천은 **후보일 뿐 자동 채택하지 않는다.** 사람이 골라야 매핑표에 들어간다.

### 3.3 검토 표
- 주문장 단위 접기/펼치기. 줄마다: 고객명(생성값) · 고객 판정(재사용 seq / 신규 / 신규-휴대폰 비움 — 실행 전 조회로 미리 표시) · 상품(매핑 결과 코드+이름 또는 추천 셀렉트) · 품위/색상/사이즈(해석값, 못 푼 토큰 노란색, 직접 수정 가능) · 수량 · 판매가 · 비고.
- 문제가 있는 줄이 하나라도 있는 주문장은 실행 체크가 **자동 해제**. 사람이 고쳐야 체크 가능.
- 장부에 있는 주문번호는 "이전에 넣음(날짜)" 경고. 막지 않는다.
- 이 단계까지는 **쓰기 0**. 고객 판정을 위한 검색 POST는 읽기다.

### 3.4 실행 (주문장 순차, 주문장 안에서 줄 순차)
1. **가드**: plain GET(`orderItemWriteForm.do?tcode=order_item&pageSize=20&searchSortType=seq`) → `tradeJun` 빈값 + `idx` 0개가 아니면 시작하지 않는다.
2. **고객 확정**: 고객명 정확일치 검색(`searchWordType=clientName`, 서버는 부분일치라 확장이 `name===` 로 거른다) → 있으면 seq. 없으면 휴대폰 검색 → 다른 이름이 있으면 phone 빈칸, 없으면 phone 포함 → `clientWrite.do` POST → 리다이렉트된 고객검색 페이지의 행에서 seq(실측: `msg` 빈값 + 그 이름으로 검색된 페이지).
3. **줄 등록**(줄마다): `orderItemWriteForm.do?tcode=order_item&tradeJun=<t|빈값>&master=<seq>&client=<seq>&clientName=<enc>` GET → form1 25필드 정규식 추출(§4.2) → 기대치 대조(§5) → k/color/itemSize/orderQty/orderPrice/shopRemark 덮어쓰기 → `orderItemWrite.do` POST → `msg` 빈값 + 목록 행 수 +1 + 새 행의 상품코드 일치. 응답 hidden `tradeJun`을 다음 줄에 전달(첫 줄에서 생성됨).
4. **완료**: plain GET으로 세션의 열린 주문장이 아직 내 `tradeJun`인지 대조(둘째 줄부터 매 줄 앞에서도 같은 대조) → GET(tradeJun·client 명시) → form10 23필드 추출 → **인도예정일 오늘로 명시 세팅**(HTML엔 selected가 없어 추출값이 01/01) → 최종 대조(행 수·상품코드·사이즈·주문가 = 검토 표) → `orderItemJunWrite.do` POST → `msg` 빈값 → plain GET으로 `tradeJun` 빈값·0행 확인 → 주문전표 목록(`/jun/orderitem/orderItemList.do`)에서 고객명으로 관리번호 조회 → 장부 기록.
5. **실패 처리**: 어느 단계든 판정 실패면 그 주문장 중단 → 이번 실행에서 넣은 `orderSeq`만 골라 `orderItemDelete.do`(form3 `idx`=`<orderSeq>,<tradeJun>`)로 삭제 → plain GET 0행 확인 → 결과에 "건너뜀(사유)·되돌림 n줄" → 다음 주문장. 되돌리기 후에도 세션에 줄이 남으면 **전체 중단**.

---

## 4. 유비샵 계약 (라이브 실측 2026-09-14)

### 4.1 읽기
| 요청 | 필드 | 응답 |
|---|---|---|
| `POST /etc/client.do?tcode=order_item` | `formname=form1 url=/order/item/orderItemWriteForm.do actFlag=1 shop=LT shopName=FASHION searchWordType=clientName\|phone searchWord pageSize=100` | `table.t_list` 행 `No\|고객명\|매장명\|휴대폰(신부)\|전화(신랑)\|선택\|수정/삭제`, 선택 링크 `setSeting(form1,'<i>','<seq>')`. **부분일치**. |
| `POST /etc/orderMasterItem.do?tcode=order_item` | `formname url actFlag=1 jun searchItemType client clientName searchWord2 pageSize=100 searchSortType=seq` | 행 `No\|이미지\|상품코드\|구분\|상품명\|선택`, 링크 `setSeting('<masterSeq>')`. 바코드·상품명·상품코드 부분일치, 공백 민감. |
| `GET /order/item/orderItemWriteForm.do?tcode=order_item&…` | `tradeJun master client clientName` | form1/form10/form2/form3. `idx` value = `<orderSeq>,<tradeJun>`. 목록 행 `No\|상품코드 비고 : …\|상품\|상품명\|품위\|중량\|색상\|사이즈\|수량\|주문가`. |
| `GET /jun/orderitem/orderItemList.do?tcode=order_item&pageSize=100&searchSortType=seq` | | 행에 관리번호(`26-09-140000002YF4` 꼴로 날짜와 붙어 나옴 → 뒤 10자리)·상품·고객명·비고·상태 |

### 4.2 쓰기
| 요청 | 페이로드 | 판정 |
|---|---|---|
| `POST /etc/clientWrite.do?tcode=order_item` | clientWriteForm의 hidden 28개(`sKey` 포함) + `regShop=LT clientName phone tel='' smsType=1 emailType=1 grade=05 inDate=YYYYMMDD clientType=1 sexType=2 wedType=0 birthType=1 birthLeapType=0 weddingType=1 weddingLeapType=0 clientJob=<코드> clientRelation3..5=1 clientMemorial3..5=1 memorialType3..5=1 memorialLeapType3..5=0` 나머지 빈값 | 200 → `/etc/client.do?…&searchWord=<고객명>`으로 리다이렉트, `msg` 빈값. 그 페이지 행에서 seq |
| `POST /order/item/orderItemWrite.do?tcode=order_item` | form1 25필드: `sKey pageSize searchSortType tradeJun payJun shop client master itemType inputPrice orgOrderPrice shopName clientName itemNum weight doc diaColor clarity surface k color itemSize orderQty orderPrice shopRemark`(input 22 + select k/color + textarea). `orgOrderPrice`(마스터가)는 그대로 두고 `orderPrice`만 판매가(콤마 문자열 `17,000`) | `orderItemWriteForm.do?…&tradeJun=<t>&client=<c>…`로 리다이렉트, `msg` 빈값. 첫 줄은 URL의 tradeJun이 비고 **hidden에 새 번호** → 세션 보관. 행 수 +1 |
| `POST /jun/orderitem/orderItemJunWrite.do?tcode=order_item` | form10 23필드: `sKey pageSize searchSortType tradeJun payJun shop client payBank=0 payDia=0 txtOrderDate exdelivedyear/month/day regId beforePrice…payEtc(=0) payRemark`. 인도예정일은 오늘로 명시 | `orderItemWriteForm.do`로 리다이렉트, `msg` 빈값. plain GET → `tradeJun` 빈값·0행. 주문전표에 관리번호 |
| `POST /order/item/orderItemDelete.do?tcode=order_item&<CONST_URL>` | form3 `sKey` + `idx`(선택 줄) | **라이브 미실측(2026-09-15 사장님 결정)** — 실제 주문 데이터라 위험해 확장 경로로는 시험하지 않는다. 취소·되돌리기는 사장님이 실제 건에서 직접 확인하며 진행. 실행기의 되돌리기 분기는 스텁 테스트(`orderimport-run.test.js`)로만 검증됨 |

- 폼 hidden은 **HTML 문자열 정규식**으로 뽑는다. 기존 메모리(DOMParser `form.elements`가 hidden을 놓침)와 같은 이유.
- `sKey`는 매 쓰기 직전 GET에서 새로 받는다(재사용 금지). **그 GET과 POST 사이에 다른 GET을 끼우지 않는다** — 세션 대조 같은 plain GET은 form10 GET 앞에 둔다(2026-09-15 Opus O2 P1). 그래서 plain GET 대조 이후~POST 사이의 창은 남는다(줄 경로와 같은 크기, 사장님 '실행 중 조작 금지'로 받아들임). 페이지에 박힌 `alert("상품번호를 입력하세요!")` 류는 항상 있으므로 판정에 쓰지 않는다.
- 응답 인코딩: 주문폼·고객폼·주문전표 목록 모두 UTF-8이었다(U+FFFD 0). `src/erp.js`의 `decodeErpHtml`을 그대로 쓴다.
- 폼의 `validate()`가 REQUIRED로 잡는 것: form1 `shopName color orderQty orderPrice`, form10 결제 8필드. 서버는 color 빈값도 받았으나(실측) 확장은 §2.2 규칙으로 채운다.

---

## 5. 안전장치

### 5.0 실증된 사고
14:10 확장이 `차카타2567/아` 주문장(tradeJun 141236)에 줄 2개를 넣는 동안 사장님이 자기 창에서 넣은 줄이 **같은 주문장에 붙었다**(서버가 로그인 세션당 열린 주문장을 하나만 든다). 사장님이 우리 줄을 지우고 완료 → 주문전표 `0000002YF1`이 엉뚱한 고객으로 생성 → 주문취소. **세션을 공유하는 다른 탭·다른 PC의 수동 작업은 확장이 막을 수 없다.** 아래 장치는 그 전제에서 "섞였으면 즉시 알아채고 멈춘다"에 초점을 둔다.

1. **실행 전 가드** — plain GET의 `tradeJun` 빈값·0행이 아니면 시작하지 않는다. 메시지: "진행 중 주문장을 먼저 완료하거나 삭제하세요."
2. **실행 중 잠금** — 사이드바 배너 "실행 중 — 주문 화면을 조작하지 마세요" + 같은 탭 주문폼 위 반투명 덮개(유비샵 화면 쪽은 안내일 뿐 강제가 아니다 — 3이 진짜 방어). **패널 쪽은 코드로 잠근다**(2026-09-15 Fable F2): 실행 중 `onClick`/`onChange`/`enrich()` 가 조작을 받지 않고 줄·마켓·매핑표 컨트롤이 `disabled` — 검토 표의 상품 선택·검색이 부르는 GET 이 실행기의 sKey GET→POST 사이에 끼어들면 §4 규칙이 깨진다.
3. **줄마다 기대치 대조(fail-closed)** — 줄 등록 전 GET 응답에서 `client` = 이번 주문장 고객 seq, 행 수 = 내가 넣은 수, 각 행의 `idx` orderSeq·상품코드 = 내가 기록한 값. 하나라도 다르면 그 주문장 중단 → §3.4-5 되돌리기(**내 orderSeq만** 삭제, 남의 줄은 건드리지 않음) → "외부 개입 감지"로 기록. 되돌린 뒤에는 삭제 직전 목록(어댑터의 키 발급 GET 응답 `before`)과 대조해 **남의 줄이 사라졌으면** `rollback_overreach` fatal(2026-09-15 Fable F1 — 되돌리기는 라이브 미실측이라 서버 계약이 idx 단독 삭제가 아닐 때도 fail-closed 여야 한다).
4. **완료 전 최종 대조** — 행 수·상품코드·사이즈·주문가를 검토 표와 대조. 불일치면 완료하지 않는다.
5. **완료 후 확인** — plain GET 세션 비움 + 주문전표 목록에서 `orderSeq`(idx)로 관리번호. 목록의 열 구성이 계정·화면마다 다르므로(2026-09-15 실측 13열↔14열) 열은 **헤더 이름**으로 찾는다. 못 찾으면 "완료 응답 성공, 전표 미확인" 경고(장부에는 tradeJun만).
6. **판정 이중화** — 모든 쓰기는 `msg` 빈값 **그리고** 상태 변화(행 수·세션)로 판정.
7. **실행 로그** — 주문장별 단계·요청 요약·판정·응답 URL을 사이드바에 남기고 JSON 내보내기.
8. **탭 이탈 경고** — 실행 중 `beforeunload`로 확인창(기존 masterprice F3과 동일).

---

## 6. 구조·UI·배포

### 6.1 파일
| 파일 | world | 역할 |
|---|---|---|
| `src/orderimport-core.js` | ISOLATED (content_script) | **순수 함수**: 헤더 매핑, 휴대폰 정규화, 고객명, 옵션 분해, 주문장 묶기, 매핑 키·조회, 추천어, hidden 추출, 판정 규칙. DOM·fetch 없음. node 테스트 대상 |
| `src/orderimport-erp.js` | ISOLATED | 유비샵 어댑터: `state / searchClient / searchMaster / registerClient / addLine / complete / deleteLines / findJunNum`. Phase 0에서 검증한 호출 그대로 |
| `src/orderimport.js` | ISOLATED | 사이드바 "주문 가져오기" 섹션, 검토 표, 실행기(상태 머신), storage, 로그. `skin.js` 사이드바 컨테이너에 섹션 등록(기존 재고화·일괄취소와 같은 방식) |
| `src/orderimport-xls.js` | MAIN (scripting 주입) | `postMessage` 수신 → SheetJS로 행 배열 반환 |
| `vendor/xlsx.full.min.js` | MAIN (scripting 주입) | SheetJS CE 0.20.3, Apache-2.0. 패널 첫 오픈 때만 |
| `manifest.json` | | content_scripts에 `orderItemWriteForm.do` 매칭 항목(core → erp → orderimport). 기존 `scripting`·host 권한으로 충분 |
| `popup/` | | 스위치 "주문 가져오기"(기본 ON) |

- `orderItemWriteForm.do`는 현재 loader/localbridge 매칭에 없다. **skin.js는 전 페이지에 이미 실리므로** 사이드바 컨테이너는 있다. 새 파일은 이 URL에만 실린다.
- SheetJS 주입은 `background.js`에 메시지 하나(`{type:'ub-inject-xls'}`) 추가 → `chrome.scripting.executeScript`.

### 6.2 화면 흐름
파일 선택 → 파싱 요약(주문장 N·줄 M·검토 K·파일 거부 사유) → 검토 표(§3.3) → [등록 시작] → 진행 표(주문장별 단계 실시간) → 결과 요약(관리번호·건너뜀 사유·되돌림) + [로그 JSON] [매핑표 내보내기/가져오기] [장부 내보내기].

### 6.3 배포
SHELL: manifest `version` 올림(4.1.9 → **4.2.0**, patch>9 규칙) → `pwsh build-shell-index.ps1` → `node tests/loader-integrity.test.js` → push → ExtSync → 브라우저 재시작.

---

## 7. 테스트

- **단위(node, `tests/orderimport-*.test.js`)** — 픽스처는 오늘 두 xls를 SheetJS로 뽑은 행 배열(JSON)과 오늘 캡처한 실제 폼 HTML 조각:
  헤더 매핑(열 순서 뒤섞기·`판매가` 누락 거부·`수량` 유무) · 휴대폰 정규화(010/0504/1xx/이상 길이) · 고객명 생성(마스킹 이름 포함) · 옵션 분해 표(`[14K-로즈골드-15호]` `[15호]` `[14K-옐로우골드]` `[18K-옐로우골드-42cm]` `3푼`→검토 · 빈값) · 주문장 묶기(박\*정 3줄, 차카타 2줄) · 매핑 2단 키 조회·학습 · 추천어 생성(공백 제거·괄호 우선) · hidden 추출(form1 25 / form10 23 / clientWriteForm 28) · 판정(`msg`·행 수·client 대조·완료 후 세션·인도예정일 명시).
- **배선 테스트** — stub fetch로 실행기를 돌려 "가드 실패·외부 개입·최종 대조 실패 시 쓰기 POST를 부르지 않는다"를 고정. 변이(가드 제거·대조 제거)가 KILL 되는지 확인.
- **라이브** — 검토 표까지는 쓰기 0이라 언제든 확인. 실행은 사장님 감독 하에 실제 파일 1개(첫 회는 1~2 주문장만 체크).
- **검수 등급** — 실행 코드 + 라이브 쓰기(주문 생성·삭제) → **T3**.

## 8. 단계

| 단계 | 산출물 | 게이트 |
|---|---|---|
| ① core | `orderimport-core.js` + 단위 테스트 | node 테스트 통과 |
| ② 파일 읽기 + 검토 표 | SheetJS 주입, 사이드바 UI, 고객 판정 조회 | 라이브에서 오늘 파일로 검토 표 확인(쓰기 0) |
| ③ 실행기 + 안전장치 | erp 어댑터, 상태 머신, 되돌리기, 로그 | 배선 테스트 + 감독 하 라이브 1~2 주문장 |
| ④ 학습·추천·장부·내보내기 | 매핑 학습 UI, 추천 검색, JSON 입출력 | 라이브 |

## 9. 범위 외
- 두 번째 PC 매핑표 공유(기본표 GitHub) — 이 PC에서 안정된 뒤.
- MD 쪽 후속(본사확인·발주·입고·출고) — 기존 기능.
- 이지어드민 쪽 연동·주문번호 역기입.
- 유비샵 고객 레코드 정리(옛 규칙 `차카타0673`처럼 접미 없는 고객과의 통합).

## 10. Phase 0 기록 (2026-09-14)
- 12:10~12:16 읽기 실측: 폼·팝업·콜백 구조, 검색 부분일치, 예물고객 휴대폰 충돌 실례.
- 14:08~14:25 쓰기 실측 1: 차카타2567/아 등록(123784) + 줄 2개 → **수동 작업과 섞임**(§5.0). 차카타 건은 사장님이 직접 처리.
- 14:25~14:40 쓰기 실측 2: 자차카8718/아(123787) 줄 1 → 완료 POST는 Claude 도구 차단으로 사장님이 클릭 → `0000002YF3`.
- 2026-09-15 10:40 라이브 실행(사장님 직접, 확장 패널): 당일 파일 10주문장·11줄 전부 정확히 등록(`0000002YFQ`~`2YFZ`, 18K·옐로우골드·17호 분해, SSG `/s`, 2줄 주문장, 기존 고객 재사용 포함). 주문전표 대조로 확인.
- 14:45~14:55 쓰기 실측 3: 마바사1931/아(123789) `0000002YF4` · 나다라7748/아(123790) `0000002YF5` · 파하가5207/아(123791) `0000002YF6` — 등록·줄·완료 전부 확장 경로, 3/3 성공, 완료 후 세션 비움 확인.
