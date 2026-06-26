# 유비샵 바코드 라벨 인쇄 (ActiveX 대체) — 크롬 확장

스윙브라우저 + ActiveX(BarcodeActive.ocx) + BPS2 종속을 제거하고, **일반 크롬**에서
유비샵 상품검색 화면의 `바코드인쇄` 버튼으로 주얼리 라벨을 인쇄한다.
(프린터: Zebra GX430t / 3분할 긴 택 ≈ 60×10mm)

기획서: `유비샵-바코드-크롬확장-기획서.md`
버전: **v1.4.0** (이전 버전은 `../dist/` 에 zip 으로 보관)
저장소: https://github.com/aredsea/ubishop-barcode-ext

> ⚠ **v1.4.0 은 1회 재설치 필요**: manifest(옵션페이지·storage 권한·bridge)가 바뀌었다.
> 매장 PC에서 `chrome://extensions` → 이 확장 **"새로고침(⟳)"** 또는 폴더 다시 로드.
> (이후 로직 변경은 자동업데이트로 반영되지만, manifest/옵션/bridge 변경 시에만 재설치.)

## 자동 업데이트 (라이브 로더)

설치본에는 **로더 + JsBarcode + 폰트**(고정 자산)만 들어간다. 실제 로직(config/
barcode/collector/label/print/editor/content)은 매 페이지 로드 시 **GitHub 에서
실시간으로 가져와 실행**한다.

- **코드 수정 → `git push` → 매장 PC가 다음 페이지 열 때 자동 반영**(GitHub raw 캐시
  때문에 ~5분 내). 재설치·레지스트리 불필요.
- 오프라인이면 마지막으로 성공한 캐시(localStorage)로 동작. **최초 1회만 인터넷 필요.**
- 로드할 파일 목록은 `app-files.json` 에서 관리(모듈 추가 시 여기에 줄 추가 → push).
- 저장소 주소는 `src/loader.js` 상단 `REPO` 에. (현재 `aredsea/ubishop-barcode-ext`)

### 내가 코드 고치는 법
```bash
# 코드 수정 후
git add -A && git commit -m "수정 내용" && git push
# 끝. 매장 PC는 다음 페이지 열 때 자동으로 새 코드를 받음.
```

---

## 구성

```
ubishop-barcode-ext/
├── manifest.json          # MV3, world:MAIN 로 목록 페이지에 주입
├── app-files.json         # ★ 로더가 원격 로드할 파일 목록(자동업데이트 대상)
├── options.html / options.js  # ★ 확장 옵션 페이지(위치 설정, chrome.storage)
├── src/
│   ├── loader.js          # ★ 라이브 자동업데이트 로더(설치본에 포함)
│   ├── bridge.js          # ★ chrome.storage ↔ 페이지(MAIN) 다리(ISOLATED, 설치본)
│   ├── config.js          # ★ 모든 설정 + 라벨 위치 "기본값"(layout)
│   ├── font.js            # Pretendard woff2(Regular+Bold) base64 임베드(오프라인)
│   ├── barcode.js         # JsBarcode 래퍼 (SVG, 박스에 맞춤)
│   ├── collector.js       # 선택 수집 + infoItemBarPrint.do 파싱(실측 확정) + 목록 폴백
│   ├── label.js           # 좌표(mm) 기반 라벨 렌더 + 레이아웃 저장/로드 + 폰트
│   ├── print.js           # 숨은 iframe @page 인쇄(폰트 로드 대기)
│   ├── editor.js          # 미리보기 + 위치 정밀 편집 모달
│   └── content.js         # sendBarPrint 후킹 + 즉시인쇄 + 위치설정 버튼
├── vendor/JsBarcode.all.min.js   # 오프라인 포함(인터넷 끊겨도 동작)
├── 유비샵-인쇄모드.bat    # ★ 크롬 인쇄창 없이 인쇄(--kiosk-printing) 실행기
└── preview.html           # 설치 없이 양식·편집기 테스트
```

## 버전 이력

| 버전 | 변경 |
|---|---|
| v1.0.0 | 초기 구현. 바코드인쇄 → 곧바로 크롬 인쇄. 3분할 flex 양식. |
| v1.1.0 | 미리보기/위치편집 모달. 라벨 좌표(mm) 기반 전환 → 드래그·수치 조정·저장. 60×10mm 확정. |
| v1.2.0 | ① 즉시인쇄(`--kiosk-printing` 시 크롬창도 없음) ② 위치설정 분리 ③ 데이터 실측 확정(상품명·거래처·금속·중량·호수, UTF-8) ④ Pretendard 폰트 임베드. |
| v1.3.0 | 라이브 자동업데이트: 설치본은 로더만, 로직은 GitHub raw 에서 실시간 로드 → push 하면 매장 PC 자동 반영. |
| **v1.4.0** | **확장 옵션 페이지**(위치설정) + **최초실행 자동 편집기** + 저장소를 `chrome.storage`(옵션·인쇄 공유)로 전환(bridge). ※manifest 변경 → 1회 재설치 필요. |

## 요구사항

- **크롬 111+** (`manifest content_scripts`의 `"world": "MAIN"` 사용). 매장 PC 크롬을 최신으로.
- 유비샵 상품검색 페이지: `http(s)://ubdstore.ubshop.biz/info/item/infoItemList.do`

## 설치 (개발자 모드, unpacked)

1. 이 폴더(`ubishop-barcode-ext`)를 매장 PC에 복사.
2. 크롬 → `chrome://extensions` → 우측 상단 **개발자 모드** ON.
3. **압축해제된 확장 프로그램을 로드** → 이 폴더 선택.
4. 유비샵 상품검색 페이지를 새로고침. 콘솔(F12)에 `[유비샵 바코드 라벨] 활성화됨` 이 보이면 정상.

## 사용

**상품 체크 → `바코드인쇄` 클릭 → 즉시 인쇄.** (미리보기 모달 없음)

### 크롬 인쇄창까지 없애기 (완전 자동 인쇄)

크롬은 보안상 확장만으로 인쇄 다이얼로그를 없앨 수 없다. **크롬을 `--kiosk-printing`
플래그로 실행**하면 `바코드인쇄` 클릭 시 다이얼로그 없이 기본 프린터로 바로 인쇄된다.

1. 동봉 **`유비샵-인쇄모드.bat`** 더블클릭 → 크롬이 인쇄모드로 다시 뜨고 유비샵 목록이 열림.
   (배치는 실행 중인 크롬을 닫고 플래그를 붙여 재시작한다. 평소 프로필·로그인·확장 유지.)
2. 최초 1회 준비:
   - Windows **기본 프린터 = Zebra GX430t** 로 지정.
   - Zebra 용지 **60 × 10 mm**, 여백 없음 등록.

> **❓ 인쇄창이 계속 떠요** → 평소 크롬으로 열어서 그렇다. `--kiosk-printing` 은 크롬이
> **그 플래그로 새로 시작될 때만** 적용된다. 반드시 **`유비샵-인쇄모드.bat`** 으로 크롬을
> 켜야 한다(실행 중인 크롬을 닫고 플래그를 붙여 재시작). 평소 바탕화면 크롬 아이콘으로
> 열면 계속 인쇄창이 뜬다. → 매장 PC는 이 .bat 으로만 유비샵을 열도록 안내.
>
> 인쇄 전에 미리보기를 보고 싶으면 `config.js` 의 `print.previewBeforePrint: true`.

### 라벨 위치 조정 (확장 옵션 페이지)

`chrome://extensions` → 이 확장 **"세부정보"** → **"확장 프로그램 옵션"** → 위치 설정 페이지.
(또는 페이지 우하단 "🏷 라벨위치" 버튼으로도 열림)

- 드래그/수치(mm)/화살표키(0.5mm, Shift 0.1mm)로 항목 위치·크기 조정 → **저장**.
- 저장값은 `chrome.storage` 에 보관되어 **옵션페이지·인쇄가 같은 설정 공유**.

### 최초 실행 시 자동 위치 설정

설정이 없는 상태로 목록 페이지를 열면 **위치 편집기가 자동으로 뜬다**.
항목을 맞추고 **"저장"** 을 누르면 닫힌다. (저장 전에는 다음에 또 뜸 → 저장 유도)

### 라벨 항목 위치 정밀 조정 (위치 편집기)

미리보기 모달에서 **✎ 위치 편집** 을 켜면:

- **드래그**: 캔버스에서 항목을 끌어 위치 이동.
- **수치 입력**: 오른쪽 패널에서 선택 항목의 **X/Y/너비/글자크기(mm)**, 정렬, 굵게, 표시여부 조정.
- **화살표키**: 선택 항목을 **0.5mm**(Shift = 0.1mm) 단위로 미세 이동.
- **칩**: 패널 상단 항목칩으로 빠르게 선택. (취소선 = 숨김 항목)
- **저장**: 조정한 위치를 저장하면 **이후 모든 인쇄에 적용**(localStorage, 이 PC·이 사이트 기준).
- **기본값**: 저장값을 지우고 `config.js` 의 기본 레이아웃으로 복귀.

> 위치는 **이 PC의 크롬에만** 저장된다(localStorage). 여러 PC에 같은 배치를 쓰려면
> 확정된 좌표를 `src/config.js` 의 `layout` 기본값에 반영해 배포하면 된다.

---

## 설정 (`src/config.js`)

코드 수정 없이 값만 바꾸면 된다. 주요 항목:

| 키 | 의미 | 기본 |
|---|---|---|
| `debug` | 콘솔 로그 + 출처A 응답 HTML 덤프 | `true` (배포 시 `false` 권장) |
| `sourceMode` | `auto` / `barPrintOnly` / `listOnly` | `auto` |
| `print.previewBeforePrint` | 인쇄 전 미리보기 모달 표시 | `false` (즉시인쇄) |
| `print.fontFamily` | 인쇄 폰트 | Pretendard |
| `print.waitFontsMs` | 인쇄 직전 폰트 대기(ms) | 400 |
| `barPrintCell.*` | 인쇄페이지 응답 셀 인덱스(실측) | itemNo4/info6/price12 |
| `label.wmm/hmm` | 라벨 치수(mm) | 60 × 10 |
| `label.panel.{a,b,c}` | 3분할 패널 폭(mm) | 22/20/18 |
| `barcode.format` | 심볼로지 | `CODE128` |
| `barcodePrefix` | 바코드 하단 접두 | `LT` |
| `fixed.*` | 회사명/브랜드 고정 텍스트 | (주)D102 외 |
| `settingsButton.show` | 우하단 위치설정 버튼 표시 | `true` |

---

## 데이터 출처 (실측 확정 — 2026-06)

실제 `infoItemBarPrint.do` 응답을 직접 분석해 파서를 확정했다.

- **인코딩**: UTF-8.
- **구조**: 응답에 `table.t_list`(데이터 행) + `div.tooltip2#note_N`(상품명) 포함.
  응답은 **검색결과 전체**를 담으므로, 체크한 바코드로 **필터**한다.
- **행별 필드** (`barPrintCell`):
  - 셀1 `idx` 체크박스 = **바코드**
  - 셀4 = 바코드 + **상품번호**(`F-BF-Q-YG-ZZ-0096`)
  - 셀6 = **구분**(FASHION) + **거래처**(백*심9932/G) + **금속**(18K) + **중량**(4.36g) + **호수**(17)
  - 셀12 = **판매가**(1,830,000)
  - `note_N` 툴팁 `상품명 : …` = **상품명(한글)** = `F-볼륨하트언발체인` → 패널 A·B에 표시
- **고정 문구**(주얼리전산의 리더 지앤샵 / www.honsu114.com)는 응답에 없음 → `config.fixed` 로 공급.
- 출처 A 실패 시 **목록 스크래핑(출처 B)** 으로 자동 폴백.

## ⚠ 매장에서 1회 확정 (실물 비교)

### 바코드 심볼로지 / 접두
기존 라벨을 매장 스캐너로 찍어 디코드 → 값/심볼로지 확인.
- 값이 `2606RL`인지 `LT2606RL`인지 → `barcodePrefix` 조정.
- CODE128이 아니면 → `barcode.format` 변경(예: `CODE39`).

### 위치 미세조정
실인쇄가 사진과 다르면 **우하단 "🏷 라벨위치"** 로 항목 위치를 맞추고 저장.

---

## 검증 체크리스트 (기획서 9절)

- [ ] **스캔 정합**: 새 라벨을 매장 스캐너로 → 기존과 동일 코드값.
- [ ] **치수 정합**: 자로 재서 60×10mm, 3분할 위치 일치.
- [ ] **필드 정합**: 사진의 모든 텍스트가 같은 위치에.
- [ ] **오프라인**: 인터넷 차단 후에도 인쇄(vendor JsBarcode 로컬 포함).
- [ ] **2대 동일**: 문제됐던 PC 2대 모두 동작.

## 긴급 원복

확장이 문제를 일으키면 `chrome://extensions` 에서 끄면 끝(원본 페이지엔 영향 없음).
콘솔에서 임시 원복: `window.sendBarPrint = window.__ubOriginalSendBarPrint`.
