/* =============================================================================
 *  config.js — 모든 설정 외부화 (기획서 8절 [CFG])
 *  값만 바꾸면 출력이 바뀐다. 코드 수정 불필요.
 *  MAIN world 전역 네임스페이스(window.UBCFG)로 다른 모듈에 공유된다.
 *
 *  ※ 라벨 항목 위치는 코드가 아니라 "편집기"에서 드래그/수치로 조정하고 저장한다.
 *    저장값은 localStorage(키: storageKey)에 들어가며, 아래 layout 은 "기본값"이다.
 * ========================================================================== */
(function () {
  'use strict';

  window.UBCFG = {
    /* --- 디버그 ----------------------------------------------------------- */
    // true 면 콘솔에 상세 로그를 찍고, 출처 A 응답 HTML을 window.__UB_LAST_BARPRINT_HTML
    // 에 보관한다(파서 확정용). 운영 배포 시 false 권장.
    debug: true,

    /* --- 데이터 소싱 모드 -------------------------------------------------- */
    // 'auto'        : 출처 A(infoItemBarPrint.do) 시도 → 실패/부족 시 출처 B(목록) 폴백 (권장)
    // 'barPrintOnly': 출처 A만 사용
    // 'listOnly'    : 출처 B(목록 스크래핑)만 사용 (프로토타입에서 검증된 경로)
    sourceMode: 'auto',

    // 출처 A 응답에서 라벨 1건당 최소 이 개수 이상 핵심 필드가 차야 "성공"으로 본다.
    barPrintMinFields: 1,

    /* --- 인쇄 페이지 엔드포인트 (현행 동작 분석 결과) --------------------- */
    barPrint: {
      path: '/info/item/infoItemBarPrint.do',
      tcode: 'info_item'
    },

    /* --- 목록 표 셀(열) 매핑 — 0-base. 분석으로 확정된 값 (기획서 3절) ----- */
    cell: {
      idx: 1, vendor: 2, itemNum: 4, gubun: 5, storeInfo: 6, price: 12, status: 15
    },

    /* --- 출처 A: infoItemBarPrint.do 응답 파싱 매핑 (실측 확정 2026-06) ----
     *  응답은 table.t_list(마지막) + div.tooltip2#note_N(상품명) 으로 구성.
     *  검색결과 전체가 오므로 체크한 바코드로 필터한다. 인코딩 UTF-8.
     *  행별 셀:
     *   1=idx체크박스(바코드), 4=바코드+상품번호, 5=구분, 6=구분/거래처/금속/중량/호수,
     *   12=판매가.  상품명(한글)=note_N 툴팁의 "상품명 : … 해리/배수".          */
    barPrintCell: { vendor: 2, itemNo: 4, gubun: 5, info: 6, price: 12 },

    /* --- 상품입고 페이지(inputItemWriteForm.do) 매핑 (실측 확정 2026-06) -----
     *  검색페이지와 레이아웃이 다르다. 이 페이지는 목록 행에 모든 데이터가 있고
     *  note 툴팁에 "상품명 :"이 없으므로 목록 스크래핑만 사용한다(barPrint 엔드포인트는
     *  inputItemBarPrint.do = 인쇄포맷뷰라 구조화 파싱 불가).
     *  ⚠ idx 체크박스 value 는 복합("순번,바코드,코드") → 바코드는 셀2 첫 줄을 사용.
     *  셀: 2=바코드/매입처코드/상품번호+상품명(줄바꿈), 3=구분,
     *      4=매장명(고객명)+금속중량+호수(줄바꿈), 11=판매가.                       */
    inbound: {
      match: /input\/item\/inputItem/i,   // location.pathname 매칭
      cell: { info2: 2, gubun: 3, store: 4, price: 11 }
    },

    /* --- 라벨 물리 규격 (Zebra GX430t 300dpi) — 확정: 가로 60 × 세로 10 mm -- */
    label: { wmm: 60, hmm: 10 },

    /* --- 편집기 --------------------------------------------------------- */
    editor: {
      pxmm: 13,      // 편집 캔버스 확대율(화면 px/mm). 60mm→780px, 10mm→130px
      grid: 0.5,     // 스냅/넛지 기본 격자(mm). 화살표키 0.5mm, Shift+화살표 0.1mm
      showDividers: true,
      dividers: [22, 42]  // 3분할 안내선 위치(mm). 인쇄에는 점선으로 안 나옴(가이드)
    },

    /* --- localStorage 저장 키 (레이아웃 위치 저장) ----------------------- */
    storageKey: 'UB_LABEL_LAYOUT_v1',

    /* --- 로컬 인쇄 프로그램(D102 Label Printer) 엔드포인트 --------------- */
    localPrint: { url: 'http://127.0.0.1:17600/print' },

    /* --- 바코드 ----------------------------------------------------------- */
    barcode: {
      format: 'CODE128',  // 미확정(기획서 6절). 스캐너 디코드로 확정 후 변경.
      width: 1.4,
      displayValue: false
    },

    /* --- 인쇄 동작 -------------------------------------------------------- */
    print: {
      // false(기본): 바코드인쇄 → 곧바로 인쇄(미리보기 모달 없음).
      //   크롬 인쇄창까지 없애려면 크롬을 --kiosk-printing 플래그로 실행해야 한다.
      //   (동봉 "유비샵-인쇄모드.bat" 참고. Zebra 를 기본 프린터로 지정.)
      // true: 인쇄 전에 미리보기/위치편집 모달을 먼저 띄움.
      previewBeforePrint: false,
      fontFamily: "'Pretendard', '돋움', Dotum, sans-serif",
      waitFontsMs: 400   // 인쇄 직전 폰트 로드 대기(ms). 0이면 fonts.ready 만 사용.
    },

    /* --- 위치 설정 버튼(페이지에 떠 있는 작은 버튼) ----------------------- */
    settingsButton: { show: true, text: '🏷 라벨위치', bottom: 12, right: 12 },

    /* --- 표시 토글(전역) -------------------------------------------------- */
    show: { panelDividerLine: true },

    /* --- 고정 텍스트 ------------------------------------------------------ */
    fixed: {
      company: '(주)D102',
      brandTop: '주얼리전산의 리더 지앤샵',
      brandUrl: 'www.honsu114.com'
    },

    /* --- 바코드 하단 접두 ------------------------------------------------- */
    barcodePrefix: 'LT',

    /* =======================================================================
     *  라벨 레이아웃 기본값 — 60×10mm 캔버스 위 절대좌표(mm)
     *  편집기에서 드래그/수치로 바꾸고 저장하면 이 값을 덮어쓴다(localStorage).
     *  필드: key=데이터키, name=편집기 표시이름, type=text|barcode|box
     *        x,y=좌상단(mm), w=폭(mm), h=높이(mm, barcode/box), fs=글자크기(mm)
     *        bold, align(left|center|right), visible
     * ===================================================================== */
    layout: [
      // ── 패널 A (바코드/가격면) ──
      { key: 'company',      name: '회사/매장',     type: 'text',    x: 0.6,  y: 0.2, w: 20,   fs: 1.9, bold: false, align: 'left',   visible: true, editable: true },
      { key: 'itemName',     name: '품명',          type: 'text',    x: 0.6,  y: 2.0, w: 20,   fs: 1.9, bold: false, align: 'left',   visible: true },
      { key: 'price',        name: '판매가',        type: 'text',    x: 0.6,  y: 3.8, w: 20,   fs: 2.6, bold: true,  align: 'left',   visible: true },
      { key: 'barcode',      name: '바코드',        type: 'barcode', x: 0.6,  y: 5.9, w: 20,   h: 2.9,  bold: false, align: 'left',   visible: true },
      { key: 'barcodeLabel', name: '바코드+접두',   type: 'text',    x: 0.6,  y: 9.0, w: 20,   fs: 2.0, bold: false, align: 'left',   visible: true },

      // ── 패널 B (제품정보면) ──
      { key: 'bnum2',        name: '바코드번호(B)', type: 'text',    x: 22.6, y: 0.4, w: 18.5, fs: 2.1, bold: false, align: 'left',   visible: true },
      { key: 'metal',        name: '금속/외경',     type: 'text',    x: 22.6, y: 2.4, w: 18.5, fs: 1.9, bold: false, align: 'left',   visible: true },
      { key: 'weight',       name: '중량',          type: 'text',    x: 22.6, y: 4.3, w: 18.5, fs: 1.9, bold: false, align: 'left',   visible: true },
      { key: 'compCat',      name: '회사+구분',     type: 'text',    x: 22.6, y: 6.2, w: 18.5, fs: 1.8, bold: false, align: 'left',   visible: true },
      { key: 'namePartner',  name: '품명+거래처',   type: 'text',    x: 22.6, y: 8.1, w: 18.5, fs: 1.8, bold: false, align: 'left',   visible: true },

      // ── 패널 C (브랜딩면) ── editable:true = 편집기에서 텍스트 직접 입력 가능
      { key: 'brandTop',     name: '브랜드상단',    type: 'text',    x: 42.6, y: 0.6, w: 16.8, fs: 1.7, bold: false, align: 'center', visible: true, editable: true },
      { key: 'signbox',      name: '서명란',        type: 'box',     x: 43.0, y: 3.0, w: 16,   h: 3.6,  bold: false, align: 'left',   visible: true },
      { key: 'brandUrl',     name: '브랜드URL',     type: 'text',    x: 42.6, y: 8.4, w: 16.8, fs: 1.7, bold: false, align: 'center', visible: true, editable: true }
    ]
  };

  if (window.UBCFG.debug) console.log('[UB] config loaded', window.UBCFG);
})();
