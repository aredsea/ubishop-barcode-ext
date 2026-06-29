# 유비샵 바코드 라벨 확장 (D102 인쇄 연동) — v2.0.0

유비샵 `바코드인쇄`를 가로채 **D102 인쇄 프로그램**으로 상품 데이터를 보내, 프로그램이
ZPL로 Zebra에 직접 인쇄한다(크롬 인쇄창 없음). **확장은 데이터만 보내는 얇은 호출자**다.

- 인쇄 프로그램/전체 시스템: https://github.com/aredsea/d102-label-printer
- 위치/문구 설정은 **프로그램**에서(트레이 → 라벨 위치·문구 설정).

## 구성 (얇은 호출자)

```
ubishop-barcode-ext/
├── manifest.json        # MV3, world:MAIN 로 loader 만 주입
├── app-files.json       # 로더가 원격 로드할 파일 목록(자동업데이트)
└── src/
    ├── loader.js        # GitHub 라이브 자동업데이트 로더(설치본 포함)
    ├── config.js        # 설정(목록 셀 매핑·infoItemBarPrint 파싱·인쇄 URL)
    ├── overlay.js       # 인쇄 로딩 오버레이(CSS 스피너)
    ├── collector.js     # 체크 상품 → infoItemBarPrint.do 파싱 → LabelData[]
    └── content.js       # sendBarPrint 가로채 → 127.0.0.1:17600/print 로 POST
```

## 동작

```
바코드인쇄 클릭 → collector 가 상품 데이터 수집
  → POST http://127.0.0.1:17600/print { items:[…] }
  → D102 인쇄 프로그램이 ZPL 생성·Zebra 직접 인쇄
  → 로딩 오버레이/결과 안내
```

프로그램이 꺼져 있으면 "인쇄 프로그램에 연결할 수 없습니다" 안내(트레이 확인).

## 자동 업데이트

로직(config/overlay/collector/content)은 매 페이지 로드 시 GitHub raw 에서 받아 실행
(`app-files.json`). **push 하면 매장 PC가 새로고침 시 자동 반영**. manifest/loader 변경 시에만 재설치.

## 설치

- 보통은 **D102 인쇄 시스템 설치 프로그램**이 이 확장을 자동 등록한다(권장).
- 수동: `chrome://extensions` → 개발자 모드 → 압축해제 로드 → 이 폴더.

> v1.x(확장이 직접 인쇄·편집)에서 v2.0.0(프로그램 인쇄)로 전환. 위치/문구 편집기는
> 프로그램으로 이관됨(WebView2 임베드, 동일 기능 + 파일기반 완벽 저장).
