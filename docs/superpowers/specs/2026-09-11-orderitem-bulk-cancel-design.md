# 주문 전표 일괄취소 설계 (2026-09-11)

> **2026-09-16 확장** — 대상 상태(출고완료·입고완료·본사확인 추가)와 건별 루프(상태 사슬)는 `2026-09-16-orderitem-cancel-chain-design.md` 가 정본이다. 이 문서의 §2 "본사확인 행 제외"·§8 "OS- 연쇄 범위 외" 는 그 결정으로 뒤집혔다.

주문 전표(`/jun/orderitem/orderItemList.do?tcode=order_item`)에 **[일괄취소]** 버튼을 추가한다.
체크한 건을 순서대로 네이티브 [취소](`del(seq)`) + 확인창 [확인] 과 같은 동작으로 **주문취소(OC-)** 로 만든다.
기존 [본사확인+입고완료](작업C, `2026-07-20-orderitem-batch-design.md`)와 같은 자리·같은 형식·같은 배관이다.

배포 채널은 **SHELL**(`skin.js`, `popup/*`)이다 — manifest 버전 올림 → `shell-files.json` 재생성 → push 하면 D102 인쇄 프로그램(ExtSync)이 받아 **다음 브라우저 재시작 시** 반영된다(README '배포 절차'). crx/update.xml 은 폐기된 레거시다.

---

## 1. 라이브 실측 사실 (2026-09-11, 운영 ERP, 읽기만)

추측이 아니라 실제 화면·함수 소스에서 확인한 계약이다. 이 값들이 바뀌면 설계가 깨진다.

### 행의 [취소] = `del(seq)`

```js
function del(seq) {
  if (chk_key == 0) if(!confirm("취소 된 주문서는 복구되지 않습니다. 정말 취소하시겠습니까?")) return;
  var url = "/jun/orderitem/orderItemCancel.do?tcode=order_item"
    + "&seq=" + seq
    + "&sKey=<페이지 로드 시 발급된 15자리 키>"
    + CONST_URL;
  location.href = url;
}
```

- **GET 자체가 쓰기다** (재고배정 `setCurrent` 와 같은 유형). 조회 목적으로 절대 부르지 않는다.
- `chk_key` 는 페이지 전역 `0` → 네이티브에서는 항상 확인창이 뜬다. 우리는 `del()` 을 거치지 않으므로 확인창은 **우리 승인창**이 대신한다.
- `sKey` 는 인라인 스크립트에 리터럴로 박힌 페이지별 토큰이다. `standby` 가 쓰는 것과 같은 키 — 작업C 의 `cExtractSKey`(`[?&]sKey=(\d{14,16})`)로 그대로 뽑힌다. **재사용 금지, 건마다 fresh GET.**
- `CONST_URL` = `&reqPage=…&pageSize=…` + 검색조건 24종(= `pageSize` 를 뺀 `ASG_SEARCH_FIELDS`; 그 배열은 `pageSize` 포함 25개) — 네이티브가 이동 후 같은 검색 화면으로 돌아가기 위한 값이다.

### [취소] 링크가 붙는 상태

최근 45일, 상태 필터별 목록 조회(읽기) 결과:

| 상태 | 행 수 | [취소] 링크 |
|---|---|---|
| 주문완료 `O--` | 100 | **100 / 100** |
| 본사확인 `OS-` | 22 | 0 |
| 주문취소 `OC-` | 72 | 0 |
| 발주완료 `B--` | 100 | 0 |
| 입고완료 `I--` | 100 | 0 |

→ **취소 가능 상태는 주문완료(O--) 하나뿐이다.** 본사확인 행은 네이티브에서도 [본사확인취소]를 먼저 눌러야 한다.
→ **`input[name=idx]` 값 == 그 행 `del()` 인자: 주문완료 332행 중 332행 일치(불일치 0, 링크 없음 0).** 취소 GET 의 `seq` 는 이 값이다.
   프로덕션 경로 그대로(POST 재조회 응답 → DOMParser → `tr.outerHTML` → `ccRowCancelSeq`)로 재확인: 327/327 일치(직렬화가 `javascript:del('N');` 를 그대로 보존).
→ **취소된 주문은 무필터(`searchItemStatus=''`)·그 하루 조회에서도 돌아온다**(seq 389315, 2026-09-09: 1행, 상태 텍스트 정확히 `주문취소`, [취소] 링크 없음). 성공 판정(`fetchOrderRow` → OC-)이 기대는 계약이다. (검수 Fable 요구로 실측)
→ 45일에 주문취소 72건 — 일괄화할 만한 빈도다.

### 툴바

`TD.left` 안: `[본사확인](standby OS-←O--)` `[본사확인+입고완료](우리 버튼, #ub-hq-btn)` `[본사확인취소](standby O--←OS-)`.
상태 열 헤더 `상태`(관측 인덱스 12 — 하드코딩 금지, `cStatusColFor` 로 찾는다). 체크박스 `input[name=idx]` value = orderSeq(단일값).

---

## 2. 확정된 결정 (사용자, 2026-09-11)

| 결정 | 선택 | 근거 |
|---|---|---|
| "취소 → 확인"의 뜻 | 네이티브 [취소] + 확인창 [확인] 을 체크한 건마다 | 실측 `del()` 과 일치. 결과 상태 = 주문취소(OC-) |
| 본사확인(OS-) 행 | **제외하고 사유 표시** | 네이티브와 같은 범위. 자동 본사확인취소는 되돌리기 어려운 범위를 넓힌다 |
| 실행 중 실패·미확정 | **즉시 중단** | 작업C 와 동일. 처리된 건까지는 화면 갱신, 나머지는 사용자가 다시 체크해 재실행 |
| 게이트 | **기존 `ubHqConfirm` 스위치 공유** | 설정 항목 증가 없음. 팝업 라벨을 '주문전표 일괄 처리'로 바꿔 두 버튼을 함께 켠다 |
| 구현 경로 | **A — 작업C 배관 재사용**(fetch 기반 GET 쓰기 + 재조회 판정) | B(네이티브 링크 클릭)는 건마다 페이지 이동, C(일괄 엔드포인트)는 운영 데이터 쓰기 실험이 필요해 기각 |

---

## 3. 아키텍처

작업C(`skin.js` §5.10)의 실행부를 그대로 재사용하고, 취소 고유의 **순수 판정부**와 **루프**만 새로 쓴다.

| 재사용 | 신규 |
|---|---|
| `fetchOrderRow` 재조회(**`sKey` 필드 추가** — 응답의 키를 함께 반환, 기존 호출자 무영향) · `cExtractSKey` · `cReadSearchFields` · `cReadCheckedRows` · `cUpdateRow` 행 교체 · `cStatusColFor`/`cListStatusCode` · 승인창 CSS(`HQ_CSS`, `ensureHqStyle`) | `ccTargetStatus` · `ccClassifyChecked` · `ccBuildCancelUrl` · `ccRedirectMsg` · `ccClassifyOutcome`(순수) / `ccDoCancel` · `ccRunCancelBatch` · `ccShowApprovalDialog` · `onBulkCancelClick` · `injectBulkCancelButton`(실행부) |

- 접두 `cc` = "C-cancel". 순수 판정부는 DOM·네트워크·`chrome.*`·타이머 무접촉 → `tests/orderitem-cancel.test.js` 에서 extractFn 방식으로 평가한다.
- 모든 쓰기는 `fetch(credentials:'include')` 이다. ISOLATED world 라 `form.submit`/`location` 대입·`javascript:` 링크 클릭은 쓰지 않는다(작업C rev2 §3.2 와 같은 이유).
- `cBatchBusy` 플래그를 **공유**한다 — 본사확인+입고완료와 일괄취소가 동시에 돌지 않게.

---

## 4. 명세

### 4.1 버튼 `[일괄취소]`

- 위치: `TD.left` 의 **마지막 standby 앵커 뒤**(= [본사확인취소] 뒤). 앵커가 없으면 주입하지 않는다(fail-safe).
- 모양: 우리 primary(파랑)가 아니라 **빨간 outline** — 되돌릴 수 없는 동작을 색으로 구분한다.
  `border:1px solid #f0b4b4; background:#fff; color:#b42318;` hover 시 배경 `#fff3f3`. 크기·폰트·반경은 `#ub-hq-btn` 과 동일.
- id `ub-cancel-btn`. idempotent 주입, 게이트 OFF 면 `display:none`. 클릭 시점에 게이트를 다시 본다. `event.isTrusted===false` 는 무시(페이지 스크립트의 `.click()` 차단).
- 게이트: `state.ubSkin && state.ubHqConfirm`. `popup.html` 의 스위치 라벨을 **'주문전표 일괄 처리'**, 설명을 **'⚠ 본사확인+입고완료 · 일괄취소 버튼을 켭니다. 실제로 서버에 씁니다(되돌리려면 수동)'** 로 바꾼다. 키 이름(`ubHqConfirm`)은 유지 — 저장된 설정 호환.

### 4.2 사전검증 승인창 (`ccShowApprovalDialog`)

- 제목 **'일괄취소 — 사전검증'**.
- 본문: `총 N건 중 대상 K건 / 제외 M건` + 제외 목록(주문번호 — 사유 (코드)):

| 상태 | 사유 문구 |
|---|---|
| `OS-` | 본사확인 상태 — [본사확인취소] 후 다시 |
| `OC-` | 이미 취소됨 |
| `B--` `I--` `T--` `TS-` `TE-` `S--` | 취소 불가 상태(라벨) |
| 판독 불가(null) | 상태 불명 |

- 같은 주문번호가 둘 이상 체크되면 [진행] 없이 **'중복 주문번호 — 중단'** 안내만(작업C 와 동일).
- 대상이 있으면 ERP 원문 경고를 그대로 빨간 박스로: **'취소된 주문서는 복구되지 않습니다.'**
- 버튼: **[취소 진행]**(빨강 `#b42318`, `isTrusted` 클릭만) / [닫기](라벨 고정 — '취소' 는 주문취소와 헷갈린다). 진행 중엔 [닫기]→[중단](다음 건 경계에서 멈춤), 끝나면 다시 [닫기]. 진행 중인 창은 툴바 재클릭으로 교체되지 않는다(검수 1R·2R 채택).
- 결과 요약: `성공 N건 / 실패 1건: <번호> — <사유> / 미확정 1건: … / 미처리 M건`.

### 4.3 건별 루프 (`ccRunCancelBatch`) — 순차, 첫 실패·미확정에서 중단

```
0. 게이트 재확인 · 중단 요청 확인 (건 경계마다 + 3-2 쓰기 직전)
   주문일 없음 → 실패 '주문일 파싱 실패' → 중단
1. 재조회 fetchOrderRow(orderSeq, orderDate)
   found=false → '재조회 실패(행 없음 | 결과 잘림)' / loginExpired → '로그인 만료' / duplicate → '중복 orderSeq(재조회)'  → 중단
2. code !== 'O--' (EXACT) → 실패 '상태 부적합: <현재 상태 텍스트>' → 중단
   (사전검증 뒤 남이 취소·본사확인한 건도 여기서 걸린다)
3. sKey = **1 의 재조회 응답에 박힌 키**(fetchOrderRow 가 `cExtractSKey(html)` 로 함께 돌려준다) → null 이면 실패 'sKey 추출 실패' → 중단
   상태와 키가 같은 응답이라 그 사이에 남이 상태를 바꿀 창이 없다(검수 3R 의 취지를 구조로 해소). 네이티브도 POST 로
   렌더된 목록의 키로 [취소] GET 을 보내므로 같은 계약이다(2026-09-11 실측: POST 응답의 첫 sKey 출현이 del() 의 것).
   별도 `cFetchSKey()` GET 은 쓰지 않는다 — 키 발급과 사용 사이에 다른 렌더가 끼는 경우를 만들지 않는다(Opus P2-3).
3-0. 같은 응답의 `row.rowHtml` 에 서버가 렌더한 [취소] 링크 `javascript:del('<seq>')` 가 있고 그 인자가 orderSeq 와 EXACT 일치해야 한다
   (`ccRowCancelSeq`). 없으면 '취소 링크 없음(서버 렌더 기준 취소 불가)', 다르면 '취소 링크 불일치(<인자>)' 로 GET 없이 중단 —
   상태 라벨 판정이 틀려도(열 밀림·권한상 취소 불가 행·키 불일치) 서버의 증언으로 fail-closed(검수 Fable P1).
3-1. 재조회 대기 중 게이트 OFF 또는 중단 요청이면 GET 없이 중단하고 `processed` 를 되돌린다(요약이 '처리 완료' 가 되면 안 된다 — 검수 4R·Opus P2-1)
4. ccDoCancel: GET ccBuildCancelUrl(orderSeq, sKey, cReadSearchFields())   ← dispatch
   resp.url 의 msg 파라미터를 ccRedirectMsg 로 읽어 보관(서버 거부 문구, 판정 근거 아님)
5. 재조회 폴링(ASG_VERIFY_MS=12s, 1.5s 간격): found && code==='OC-' → success
   success → results.success++, cUpdateRow(orderSeq, row)  (서버 <tr> 로 제자리 교체)
   그 외 → uncertain '취소 미확정 — 수동 확인 필요' (+ msg 있으면 ' · 서버: <msg>'),
           row.found 면 cUpdateRow 로 현재 서버 상태 반영 → 중단
예외 → 그 건을 failed '실행 오류: …' 로 남긴다(빈 결과가 '처리 완료' 로 보이면 안 된다 — Opus P2-1)
```

- **dispatch 후 non-success 는 자동 재시도 금지**(작업C §3.6 그대로). 서버 반영 지연·남이 덮음·타임아웃이 모두 같은 모습이다.
- 판정은 언제나 **재조회 상태**로만 한다. `msg` 는 사용자에게 보여주는 부가 정보다 — 이 ERP 의 응답 문구 스캔은 오탐 전례가 있어 판정 근거로 쓰지 않는다.

### 4.4 URL 계약 (`ccBuildCancelUrl`)

```
/jun/orderitem/orderItemCancel.do?tcode=order_item&seq=<orderSeq>&sKey=<sKey>&reqPage=1&<ASG_SEARCH_FIELDS 25종(pageSize 포함)>
```

- `seq` 또는 `sKey` 가 비면 `null` → 호출부 실패(fail-closed). 빈 값이 쓰기로 흘러가지 않는다.
- 검색조건은 네이티브 `CONST_URL` 과 같은 집합을 `cReadSearchFields` 로 읽어 붙인다(`f.elements[n]` — `f[n]` 은 동명 필드에서 조용히 누락).

### 4.5 순수 판정부 요약

| 함수 | 입력 → 출력 |
|---|---|
| `ccTargetStatus(code)` | `code === 'O--'` 만 true. prefix·null·빈값 전부 false |
| `ccClassifyChecked(rows)` | `{targets, excluded:[{orderSeq,code,reason}], duplicate}` — 4.2 표의 사유 |
| `ccBuildCancelUrl(seq, sKey, searchFields)` | 4.4 URL 또는 `null` |
| `ccRedirectMsg(url)` | `new URL(url).searchParams.get('msg')` trim, 실패·없음이면 `''` |
| `ccClassifyOutcome({dispatched, requery})` | `dispatched!==true`→`'fail'` / `requery.found && code==='OC-'`→`'success'` / 그 외 `'uncertain'` |
| `ccRowCancelSeq(rowHtml)` | 행 HTML 의 `javascript:del('<seq>')` 인자 또는 `null` |

---

## 5. 안전 불변식 (전부 fail-closed)

1. 상태 판정은 canonical code **EXACT** match. 괄호 절단·prefix 일치는 화면 필터 전용이라 쓰기 권한 판정에 쓰지 않는다.
2. 쓰기 직전에 반드시 재조회한다 — 그 응답의 상태와 키를 함께 쓴다(검수 3R·Opus 반영). 사전검증창의 상태는 승인용이지 쓰기 근거가 아니다.
3. `sKey` 는 건마다 새로 — **그 건의 상태를 확인한 재조회 응답의 키**를 쓴다. 승인창을 띄운 시점의 값·페이지의 값·별도 GET 의 값을 쓰지 않는다.
4. 한 번에 한 건. 두 배치(본사확인+입고완료 / 일괄취소)는 `cBatchBusy` 로 상호 배타.
5. dispatch 후 non-success 는 재시도하지 않고 멈춘다. 사용자에게 '미확정'이라 말하고 수동 확인을 요구한다.
6. 중단하더라도 처리된 건까지는 화면을 갱신한다(서버는 바뀌었는데 화면만 옛 상태로 남는 것이 이 서브시스템의 반복 실패).
7. 게이트 OFF 면 버튼이 없고, 루프 중에 게이트가 꺼지거나 [중단] 을 누르면 **다음 건 경계와 쓰기 직전(sKey·재조회 대기 뒤)** 에서 멈춘다 — 이미 dispatch 한 건의 판정은 끝까지 한다(검수 4R 채택).
8. 취소 GET 은 조회 목적으로 절대 부르지 않는다. 테스트는 URL 문자열만 검증한다.
9. 쓰기 권한의 최종 근거는 라벨이 아니라 **서버가 그 행에 렌더한 [취소] 링크**다 — 링크 인자가 orderSeq 와 다르거나 없으면 쓰지 않는다.

---

## 6. 테스트

- `tests/orderitem-cancel.test.js` (node --test, extractFn 방식): `ccTargetStatus`(O-- 만 true, OS-/OC-/null/prefix false) · `ccClassifyChecked`(사유 매핑 4종, 중복 감지, 대상 순서 보존) · `ccBuildCancelUrl`(필수 파라미터, seq/sKey 없으면 null, 검색조건이 고정 키를 덮지 않음) · `ccRedirectMsg`(msg 유/무/깨진 URL) · `ccClassifyOutcome`(3분기).
- 기존 스위트(188 + livefilter 85)가 그대로 통과해야 한다.
- 라이브 검증: 게이트 ON 상태에서 **취소해도 되는 주문완료 건 1건**을 사장님이 골라 실행 → 승인창 → 성공 → 행이 '주문취소'로 교체되는 것을 눈으로 확인. 실 데이터 쓰기이므로 사장님 지정 건에만 한다.

## 7. 배포 (README '배포 절차' — 껍데기 수정)

1. `manifest.json` 4.1.8 → **4.1.9**.
2. `pwsh build-shell-index.ps1` → `shell-files.json` 재생성(LF 정규화 SHA256).
3. `node tests/loader-integrity.test.js` — 재생성 뒤 소스를 또 고치면 여기서 빨간불(3번 밟은 함정).
4. `git push` → 프로그램 ExtSync 가 바뀐 껍데기 파일만 `%LocalAppData%\D102LabelExtension` 에 교체 → **브라우저 재시작** 후 팝업 스위치 '주문전표 일괄 처리' ON.

⚠ 작업 트리에 미커밋 작업(주문전표 실시간 필터 v3.10.x, 미검수)이 같은 `skin.js` 에 있었다. main 에 실리면 매장에 그대로 배포되므로, 그 작업은 `orderitem-livefilter-pending-review` 브랜치에 체크포인트 커밋으로 격리하고(push·승인 아님) 이 기능은 깨끗한 main 위에 얹는다.

## 8. 범위 외

- 본사확인(OS-) 행의 자동 본사확인취소 → 취소 연쇄. 사용자가 명시적으로 제외했다.
- 취소 사유 입력·비고 기록. 네이티브 [취소]에도 없다.
- 실패 건 건너뛰고 계속 진행 모드.
- 일괄 엔드포인트 탐색(운영 쓰기 실험 필요).
