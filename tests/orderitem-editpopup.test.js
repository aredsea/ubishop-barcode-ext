/* =============================================================================
 *  orderitem-editpopup.test.js — 작업B 수정 팝업(목록 위 플로팅 패널) 순수 헬퍼 단위테스트.
 *
 *  skin.js 는 content script IIFE 라 require 할 수 없다.
 *  → 소스에서 DOM 비의존 선언만 이름으로 추출해 샌드박스에서 **실제로 실행**한다
 *    (orderitem-c2a.test.js 와 동일 방식. 리네임하면 추출 실패로 즉사한다).
 *
 *  ⚠ 판정 로직은 전부 **실제로 실행**해 검증한다. 다만 아래 두 개(라우터 계약 가드)만은
 *    소스 대조다 — chrome.* 오케스트레이션은 node 로 실행할 수단이 없고, 그 계약이 깨지면
 *    라이브에서 조용히 죽기 때문에(실제로 겪었다) 최소한의 그물로 남겨둔다. 나머지 통합
 *    경로(창 생성·레지스트리·화면 정리)는 스펙 §7 의 브라우저 통합검증 몫이다.
 *  ⚠ 이 파일을 PowerShell 로 편집하지 마라 — Set-Content 가 한글을 깨뜨린다.
 *  실행: node --test tests/orderitem-editpopup.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'skin.js'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'skin.js 에서 ' + name + ' 선언을 찾지 못했습니다 (리네임 여부 확인)');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(name + ' 본문의 중괄호 균형을 찾지 못했습니다');
}

//  상수도 소스에서 뽑는다 — 테스트가 자기 사본을 들고 있으면 경로가 바뀌어도 안 깨져
//  '수정폼 판정'이 조용히 어긋난다.
function extractConst(src, name) {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*(.+?);').exec(src);
  assert.ok(m, 'skin.js 에서 상수 ' + name + ' 를 찾지 못했습니다');
  return 'const ' + name + ' = ' + m[1] + ';';
}

const NAMES = ['parseModifyArgs', 'epModifyRowMatches', 'epModifyQuery', 'epPopupAction',
               'epSubmitMarkValid', 'epClassifyForm',
               //  2026-08-03 내부 UI 재설계 — 배치 판정부
               'epRowspanBlocks', 'epOuterSlot', 'epRemarkRowSlot', 'epFitHeight', 'epIsFillerRow'];
const sandbox = {};

// eslint-disable-next-line no-new-func
const CONSTS = ['EP_FORM_PATH', 'EP_SAVE_PATH', 'EP_LIST_PATH', 'EP_FULL_ROW', 'EP_OPT_LABELS'];
new Function('exports',
  CONSTS.map(c => extractConst(SRC, c)).join('\n') + '\n' +
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => 'exports.' + n + ' = ' + n + ';').join('\n') + '\n' +
  CONSTS.map(c => 'exports.' + c + ' = ' + c + ';').join('\n')
)(sandbox);

const { parseModifyArgs, epModifyRowMatches, epModifyQuery, epPopupAction,
        epSubmitMarkValid, epClassifyForm, EP_FORM_PATH,
        epRowspanBlocks, epOuterSlot, epRemarkRowSlot, epFitHeight, epIsFillerRow } = sandbox;

/* ── epClassifyForm — 옵션 표를 '확인하고' 변환하는가 ───────────────────────
 *  '품위' 한 단어만 보고 표를 갈아엎으면 다른 주문 유형의 요약표를 망가뜨린다.
 *  변환은 보기 좋으라고 하는 것이니, 조금이라도 이상하면 안 하는 쪽이 옳다.
 */
function row(label, opts) {
  const o = opts || {};
  return {
    cells: o.cells === undefined ? 2 : o.cells,
    label: label,
    controls: o.controls === undefined ? 1 : o.controls,
    textarea: !!o.textarea,
    colspan: !!o.colspan,
    rowspan: !!o.rowspan
  };
}
const OPT_ROWS = [
  row('', { cells: 1, controls: 0, colspan: true }),   // 구분선(1칸 colspan 은 정상)
  row('품위'), row('색상'), row('사이즈'), row('수량'),
  row('주문가', { controls: 2 })
];

test('아는 옵션 라벨이 3개 이상이면 변환한다', () => {
  const v = epClassifyForm(OPT_ROWS);
  assert.equal(v.ok, true);
  assert.deepEqual(v.kinds, ['full', 'half', 'half', 'half', 'half', 'full']);
});

test('라벨이 하나뿐인 남의 표는 거부한다 (품위만 있는 요약표)', () => {
  const v = epClassifyForm([row('품위'), row('거래처'), row('담당자')]);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'labels');
});

test('rowspan 이 있으면 어디에 있든 거부한다', () => {
  const rows = OPT_ROWS.slice();
  rows[2] = row('색상', { rowspan: true });
  assert.equal(epClassifyForm(rows).reason, 'rowspan');
});

test('3칸 이상 행이 있으면 라벨-값 표가 아니므로 거부한다', () => {
  const rows = OPT_ROWS.concat([row('수량', { cells: 3 })]);
  assert.equal(epClassifyForm(rows).reason, 'cells');
});

test('2칸 행의 colspan 은 거부한다 (칸 수와 실제 폭이 어긋난다)', () => {
  const rows = OPT_ROWS.slice();
  rows[1] = row('품위', { colspan: true });
  assert.equal(epClassifyForm(rows).reason, 'colspan');
});

test('빈 표는 거부한다', () => {
  assert.equal(epClassifyForm([]).reason, 'empty');
  assert.equal(epClassifyForm(null).ok, false);
});

test('비고·메모와 textarea 행은 한 줄을 통째로 쓴다', () => {
  const v = epClassifyForm(OPT_ROWS.concat([
    row('주문비고', { textarea: true }), row('발주비고', { textarea: true }), row('메모')
  ]));
  assert.deepEqual(v.kinds.slice(-3), ['full', 'full', 'full']);
});

test('컨트롤이 2개 이상인 행은 반 칸에 넣지 않는다 (줄바꿈 방지)', () => {
  const v = epClassifyForm(OPT_ROWS);
  assert.equal(v.kinds[5], 'full');           // 주문가 = 입력 2개
  assert.equal(v.kinds[4], 'half');           // 수량 = 입력 1개
});

/* ── epSubmitMarkValid — 제출 증거가 다른 주문으로 승계되지 않는가 ────────── */

test('★제출 마커는 그 주문의 것일 때만 인정한다 — 창 재사용 승계 차단', () => {
  // 창은 재사용된다(같은 탭을 다른 주문 폼으로 이동). 마커가 boolean 이면 주문 A 의 신호가
  // 주문 B 로 넘어가, B 에서 저장하지 않고 목록에 가도 완료로 오인한다.
  assert.equal(epSubmitMarkValid('387898', '387898'), true);
  assert.equal(epSubmitMarkValid('387898', '387897'), false);   // 다른 주문의 증거
  assert.equal(epSubmitMarkValid(' 387898 ', '387898'), true);  // 공백 정규화
});

test('마커가 없거나 비면 증거로 치지 않는다', () => {
  assert.equal(epSubmitMarkValid(null, '387898'), false);
  assert.equal(epSubmitMarkValid('', '387898'), false);
  assert.equal(epSubmitMarkValid('  ', '387898'), false);
  assert.equal(epSubmitMarkValid('387898', null), false);
  assert.equal(epSubmitMarkValid('387898', ''), false);
  assert.equal(epSubmitMarkValid('1', true), false);            // 옛 boolean 마커는 무효
});

/* ── epModifyQuery — 네이티브 modify() 와 같은 주소를 만드는가 ────────────── */

test('★수정폼 쿼리가 네이티브와 정확히 같다 — tcode·seq·tradeJun 셋뿐', () => {
  // 실측: function modify(seq, jun) → ...ModifyForm.do?tcode=order_item&seq=<seq>&tradeJun=<jun>
  const args = parseModifyArgs("javascript:modify('387898','140546');");
  assert.equal(epModifyQuery(args), 'tcode=order_item&seq=387898&tradeJun=140546');
});

test('★존재하지 않는 파라미터를 지어내지 않는다 (옛 구현이 master·orderSeq 를 보냈다)', () => {
  const q = epModifyQuery({ seq: 'a', jun: 'b' });
  assert.ok(!/master=/.test(q), 'master 는 네이티브에 없는 이름이다');
  assert.ok(!/orderSeq=/.test(q), 'orderSeq 는 네이티브에 없는 이름이다');
  assert.ok(!/searchWord|syear|pageSize|reqPage/.test(q), '검색조건은 네이티브가 안 보낸다');
  assert.equal(q.split('&').length, 3, '파라미터는 정확히 3개');
});

test('빈 인자도 형태를 지키고, 값은 URL 인코딩된다', () => {
  assert.equal(epModifyQuery({}), 'tcode=order_item&seq=&tradeJun=');
  assert.equal(epModifyQuery(null), 'tcode=order_item&seq=&tradeJun=');
  assert.equal(epModifyQuery({ seq: 'a b', jun: 'c&d' }), 'tcode=order_item&seq=a+b&tradeJun=c%26d');
});

/* ── v3.9.9 페이지 내 패널 계약 — 별도 창·background 경유가 사라졌는가 ────── */

test('★수정 팝업이 background 를 전혀 거치지 않는다 (별도 창 경로 제거)', () => {
  // 사장님 지시(2026-07-28): 매입처 정보창처럼 페이지 안에 떠야 한다. 창을 따로 띄우면
  // 목록에서 시선이 끊긴다. 그래서 windowId 레지스트리·SW 왕복이 통째로 필요 없어졌다.
  const BG = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
  assert.doesNotMatch(BG, /ubEp/, 'background 에 수정 팝업 잔재가 남아 있다');
  assert.doesNotMatch(SRC, /type:\s*'ubEp/, 'skin 에 background 로 보내는 수정 팝업 메시지가 남아 있다');
});

test("★신원 dataset 을 src 보다 **먼저** 심는다 — 순서가 뒤집히면 자식이 자기를 못 알아본다", () => {
  // 자식은 document_start 에 frameElement.dataset.ubEpSeq 를 읽어 사이드바를 억제하고
  // 폼을 꾸민다. src 를 먼저 주면 그 시점에 dataset 이 비어 있어 날것의 ERP 페이지가 뜬다.
  const fn = extractFn(SRC, 'epOpenPanel');
  const iSeq = fn.indexOf('ubEpSeq');
  const iSrc = fn.indexOf('fr.src');
  assert.ok(iSeq >= 0 && iSrc >= 0, 'epOpenPanel 이 dataset·src 를 둘 다 다뤄야 한다');
  assert.ok(iSeq < iSrc, 'dataset.ubEpSeq 지정이 fr.src 대입보다 앞서야 한다');
});

test('★프레임 안에서 sessionStorage 팝업 마커를 세우지 않는다 (부모 목록의 도구가 사라진다)', () => {
  // iframe 은 부모 목록과 **같은 탭·같은 origin** 이라 sessionStorage 를 공유한다.
  // 별도 창 시절엔 저장소가 갈려 있어 안전했지만, 패널로 바뀌며 성립하지 않는다.
  const fn = extractFn(SRC, 'epSuppressOwnUi');
  //  '쓰기'만 잡는다 — 주석에 sessionStorage 를 언급하는 건(왜 쓰면 안 되는지 적어둔 것) 정상.
  assert.doesNotMatch(fn, /sessionStorage\s*\.\s*setItem/,
    'epSuppressOwnUi 가 sessionStorage 에 쓰면 목록 페이지의 D102 도구까지 사라진다');
  assert.match(SRC, /_IS_EP_FRAME/, '프레임 판정 상수로 억제해야 한다');
});

test('★[수정] 가로채기는 최상위 프레임에서만 — ERP 자체 iframe 에서 걸리면 패널이 갇힌다', () => {
  const fn = extractFn(SRC, 'bindEditPopupIntercept');
  assert.match(fn, /window\s*!==\s*window\.top/, '최상위 프레임 가드가 없다');
});

/* ── 세대(gen) 가드 — 낡은 문서가 새 패널을 닫지 못하는가 ────────────────────
 *  별도 창 시절엔 레지스트리의 createdAt 으로 막던 경합이다. 패널로 바뀌며 신원이
 *  주문키뿐이 되자 **같은 주문을 다시 열면** 구별이 사라졌다(주문키가 그대로라서).
 *  epSignalDone 은 epLog 말고는 의존이 없어 여기서 **실제로 실행**해 검증한다.
 * ------------------------------------------------------------------------ */
const doneBox = {};
// eslint-disable-next-line no-new-func
new Function('exports', 'epLog',
  extractFn(SRC, 'epSignalDone') + '\nexports.epSignalDone = epSignalDone;'
)(doneBox, () => {});
const { epSignalDone } = doneBox;

//  dataset 을 흉내낸다 — 이 함수가 만지는 건 el.dataset 의 두 키가 전부다.
function fakeFrame(gen) { return { dataset: { ubEpGen: String(gen) } }; }

test('세대가 같으면 완료를 세운다', () => {
  const el = fakeFrame(3);
  assert.equal(epSignalDone({ orderSeq: '111', gen: '3', el: el }), true);
  assert.equal(el.dataset.ubEpDone, '1');
});

test('★같은 주문이어도 세대가 다르면 완료를 세우지 않는다 — 낡은 문서가 새 패널을 닫는 경합', () => {
  // 주문 A 를 저장 → 결과 페이지 문서(D1)가 아직 살아 있는 사이 사용자가 A 의 [수정]을
  // 다시 누른다. 부모는 같은 iframe 에 A 를 다시 지정(세대 3→4)한다. 이때 뒤늦게 깨어난
  // D1 이 완료를 세우면 방금 연 패널이 눈앞에서 닫힌다. 주문키만으로는 못 막는다.
  const el = fakeFrame(4);                                   // 부모가 이미 다시 열었다
  assert.equal(epSignalDone({ orderSeq: '111', gen: '3', el: el }), false);
  assert.equal(el.dataset.ubEpDone, undefined, '낡은 문서가 완료를 세워선 안 된다');
});

test('세대값이 없으면 완료를 세우지 않는다 — fail-closed', () => {
  //  ⓐ 내 세대는 있는데 화면에 세대가 없다.
  const a = { dataset: {} };
  assert.equal(epSignalDone({ orderSeq: '111', gen: '1', el: a }), false);
  assert.equal(a.dataset.ubEpDone, undefined);
  //  ⓑ ★양쪽 다 비었다. '다를 때만 거부' 로 두면 여기가 통과해 세대 보호가 통째로 우회된다
  //     — 우리가 연 패널이 아닌데 data-ub-ep-seq 만 붙은 프레임이 그 경로다.
  const b = { dataset: {} };
  assert.equal(epSignalDone({ orderSeq: '111', gen: '', el: b }), false);
  assert.equal(b.dataset.ubEpDone, undefined, '세대 없는 신원이 완료를 세워선 안 된다');
  const c = { dataset: {} };
  assert.equal(epSignalDone({ orderSeq: '111', el: c }), false);   // gen 자체가 없는 신원
  assert.equal(c.dataset.ubEpDone, undefined);
  //  ⓒ 신원 자체가 없으면 당연히 거부.
  assert.equal(epSignalDone(null), false);
  assert.equal(epSignalDone({ orderSeq: '111', gen: '1' }), false);
});

test('★신원은 document_start 캡처본을 쓴다 — epFrameIdentity 가 dataset 을 다시 읽으면 안 된다', () => {
  // 이 함수는 storage 콜백 뒤(비동기)에 불린다. 그 시점에 dataset 을 읽으면 그 사이 부모가
  // 다시 연 패널의 신원을 자기 것으로 읽어, 위 세대 가드가 통째로 무력해진다.
  const fn = extractFn(SRC, 'epFrameIdentity');
  assert.doesNotMatch(fn, /frameElement|dataset/,
    'epFrameIdentity 가 dataset 을 다시 읽으면 세대 가드가 무력해진다');
  assert.match(fn, /_EP_FRAME_ID/, 'document_start 캡처본(_EP_FRAME_ID)을 돌려줘야 한다');
  assert.match(SRC, /const\s+_EP_FRAME_ID\s*=/, 'document_start 캡처 상수가 없다');
  assert.match(SRC, /const\s+_IS_EP_FRAME\s*=\s*!!_EP_FRAME_ID/, '프레임 판정이 캡처본에서 파생돼야 한다');
});

test('★패널을 열 때마다 세대가 오른다 — 안 오르면 재사용을 구별할 수 없다', () => {
  const fn = extractFn(SRC, 'epOpenPanel');
  assert.match(fn, /ubEpGen\s*=\s*String\(\s*\+\+/, 'epOpenPanel 이 세대를 올려 심지 않는다');
  const iGen = fn.indexOf('ubEpGen');
  const iSrc = fn.indexOf('fr.src');
  assert.ok(iGen >= 0 && iGen < iSrc, '세대도 src 대입보다 먼저 심어야 한다');
});

/* ── 완료 처리 순서 — 갱신이 걸렸을 때만 닫는가(fail-closed) ────────────────── */

test('★목록 갱신을 먼저 걸고, 성공했을 때만 패널을 닫는다', () => {
  // 반대 순서면 갱신이 안 걸렸을 때 패널까지 사라져, 사용자는 옛 값이 남은 목록만 보고
  // 방금 저장한 화면으로 돌아갈 방법이 없다. 별도 창 시절의 fail-closed 순서와 같다.
  const fn = extractFn(SRC, 'epEnsurePanel');
  const iReload = fn.indexOf('epReloadList');
  const iClose = fn.indexOf('epClosePanel(');
  assert.ok(iReload >= 0 && iClose >= 0, '완료 감시가 갱신·닫기를 둘 다 다뤄야 한다');
  assert.ok(iReload < iClose, 'epReloadList() 가 epClosePanel() 보다 앞서야 한다');
  assert.match(fn, /if\s*\(\s*!epReloadList\(\)\s*\)[\s\S]{0,220}?return;/,
    '갱신 실패 시 닫지 않고 빠져나가는 경로가 없다');
});

/* ── 패널 위치 보정 — 조작부가 화면 밖으로 나가지 않는가 ──────────────────────
 *  epClampPanel 은 el.style·offsetWidth·window 크기만 만지므로 여기서 **실제로 실행**한다.
 * ------------------------------------------------------------------------ */
const VP = { innerWidth: 1920, innerHeight: 1080 };
const clampBox = {};
// eslint-disable-next-line no-new-func
new Function('exports', 'window', 'epLog',
  extractFn(SRC, 'epClampPanel') + '\nexports.epClampPanel = epClampPanel;'
)(clampBox, VP, () => {});
const { epClampPanel } = clampBox;

//  style 만 있는 가짜 패널 — offsetWidth/Height 는 인라인 크기를 그대로 돌려준다.
function fakePanel(w, h, x, y) {
  const st = { width: w + 'px', height: h + 'px', left: x + 'px', top: y + 'px' };
  return {
    style: st,
    get offsetWidth() { return parseInt(st.width, 10) || 0; },
    get offsetHeight() { return parseInt(st.height, 10) || 0; }
  };
}
const px = (v) => parseInt(v, 10);

test('★좁은 화면에서 기본 크기 패널이 화면을 넘지 않는다 (닫기 버튼이 밖으로 안 나간다)', () => {
  VP.innerWidth = 800; VP.innerHeight = 700;
  const el = fakePanel(900, 660, 16, 16);        // 기본값 그대로 열린 상태
  epClampPanel(el);
  assert.ok(px(el.style.width) <= 800, '폭이 화면을 넘는다: ' + el.style.width);
  assert.ok(px(el.style.left) + px(el.style.width) <= 800, '오른쪽 끝(닫기·리사이즈)이 화면 밖이다');
  assert.ok(px(el.style.top) + px(el.style.height) <= 700, '아래쪽 끝이 화면 밖이다');
});

test('★열어둔 채 창을 줄이면 패널을 화면 안으로 다시 끌어온다', () => {
  VP.innerWidth = 1920; VP.innerHeight = 1080;
  const el = fakePanel(900, 660, 1000, 200);     // 넓은 모니터 오른쪽에 둔 패널
  epClampPanel(el);
  assert.equal(el.style.left, '1000px', '넓은 화면에서는 건드리지 않는다');
  VP.innerWidth = 800; VP.innerHeight = 700;     // 창을 줄였다
  epClampPanel(el);
  assert.ok(px(el.style.left) >= 0 && px(el.style.left) + px(el.style.width) <= 800,
    '창을 줄인 뒤에도 패널이 화면 밖에 남아 있다: left=' + el.style.left + ' w=' + el.style.width);
});

test('화면이 최소 크기보다 좁아도 420×320 아래로는 줄이지 않는다 (CSS min 과 싸우지 않게)', () => {
  VP.innerWidth = 300; VP.innerHeight = 250;
  const el = fakePanel(900, 660, 0, 0);
  epClampPanel(el);
  assert.equal(px(el.style.width), 420);
  assert.equal(px(el.style.height), 320);
});

test('★패널을 만들 때·창 크기가 바뀔 때 둘 다 보정한다', () => {
  const fn = extractFn(SRC, 'epEnsurePanel');
  assert.match(fn, /epClampPanel\(el\)/, '생성 직후 보정이 없다');
  assert.match(fn, /addEventListener\('resize'/, '창 크기 변경 보정이 없다');
  assert.match(fn, /el\.isConnected[\s\S]{0,120}?epDropResize\(\)/,
    '엘리먼트가 사라진 경우의 보정 해제가 없다');
  const iAppend = fn.indexOf('appendChild(el)');
  const iClamp = fn.indexOf('epClampPanel(el)');
  assert.ok(iAppend >= 0 && iAppend < iClamp, 'offsetWidth 를 보려면 붙인 뒤에 보정해야 한다');
});

test('★패널을 닫을 때 resize 리스너를 즉시 뗀다 — 열고 닫기를 반복하면 쌓인다', () => {
  // 다음 resize 를 기다려 자진 해제하게 두면, 창 크기를 안 바꾸고 X 로 열고 닫기를 반복하는
  // 동안 리스너와 떼어진 패널 DOM 이 계속 쌓인다(closure 가 붙잡아 GC 도 안 된다).
  const close = extractFn(SRC, 'epClosePanel');
  assert.match(close, /epDropResize\(\)/, 'epClosePanel 이 리스너를 즉시 떼지 않는다');
  const drop = extractFn(SRC, 'epDropResize');
  assert.match(drop, /removeEventListener\('resize'/, 'epDropResize 가 실제로 떼지 않는다');
  assert.match(drop, /_epOnResize = null/, '뗀 뒤 참조를 비우지 않으면 패널 DOM 이 붙잡힌다');
  //  새 패널을 만들 때도 앞선 리스너가 남아 있으면 먼저 뗀다(중복 등록 방지).
  const ensure = extractFn(SRC, 'epEnsurePanel');
  const iDrop = ensure.indexOf('epDropResize()');
  const iAdd = ensure.indexOf("addEventListener('resize'");
  assert.ok(iDrop >= 0 && iDrop < iAdd, '등록 전에 기존 리스너를 떼지 않는다');
});

/* ── parseModifyArgs — 목록의 [수정] 앵커 인자 파싱 ──────────────────────── */

test('modify() 인자를 파싱한다 — 첫 인자가 seq(행 키), 둘째가 jun(전표 묶음)', () => {
  // ★2026-07-27 라이브 실측 — 네이티브 원본이 function modify(seq, jun) 이다.
  //  옛 구현은 첫 인자를 master 로 부르고 URL 도 master/orderSeq 로 지어냈다(존재하지 않는 이름).
  assert.deepEqual(parseModifyArgs("javascript:modify('387898','140546');"), { seq: '387898', jun: '140546' });
  assert.deepEqual(parseModifyArgs("modify('a','b')"), { seq: 'a', jun: 'b' });
  assert.deepEqual(parseModifyArgs('javascript:modify("a","b");'), { seq: 'a', jun: 'b' });
  assert.deepEqual(parseModifyArgs("  javascript : modify( 'a' , 'b' ) ; "), { seq: 'a', jun: 'b' });
});

test('★행 키는 첫 인자다 — 실측 6행에서 idx === 첫 인자, idx !== 둘째 인자', () => {
  // 라이브 실측 표본(같은 jun 을 여러 행이 공유한다):
  const rows = [
    { idx: '387898', seq: '387898', jun: '140546' },
    { idx: '387897', seq: '387897', jun: '140546' },
    { idx: '387896', seq: '387896', jun: '140546' },
    { idx: '387894', seq: '387894', jun: '140545' },
  ];
  for (const r of rows) {
    assert.equal(epModifyRowMatches(r.idx, r.seq), true, r.idx + ' 는 첫 인자와 같아야 한다');
    // ⚠ 둘째 인자로 비교하면 전부 불일치 → 가로채기가 통째로 죽는다(이 버그로 기능이 안 됐다).
    assert.equal(epModifyRowMatches(r.idx, r.jun), false, r.idx + ' 는 둘째 인자와 달라야 한다');
  }
});

test('modify() 가 아니거나 형식이 어긋나면 null — 가로채지 않고 네이티브로 흘린다', () => {
  assert.equal(parseModifyArgs("javascript:del('387897')"), null);      // 취소 링크
  assert.equal(parseModifyArgs("javascript:modify('a')"), null);        // 인자 1개
  assert.equal(parseModifyArgs("javascript:modify('a','b','c')"), null); // 인자 3개
  assert.equal(parseModifyArgs("modifyOther('a','b')"), null);          // 다른 함수
  assert.equal(parseModifyArgs(''), null);
  assert.equal(parseModifyArgs(null), null);
  assert.equal(parseModifyArgs(undefined), null);
});

/* ── epModifyRowMatches — 행 일치 fail-closed ─────────────────────────────── */

test('행 idx 와 modify() 인자가 둘 다 있고 같을 때만 가로챈다', () => {
  assert.equal(epModifyRowMatches('1405401', '1405401'), true);
  assert.equal(epModifyRowMatches(' 1405401 ', '1405401'), true);   // 공백은 정규화
  assert.equal(epModifyRowMatches(1405401, '1405401'), true);       // 숫자 입력도 허용
});

test('행 키가 없거나 다르면 fail-closed — 다른 주문을 열 수 있는 경로를 막는다', () => {
  assert.equal(epModifyRowMatches('1405401', '9999999'), false);   // 불일치
  assert.equal(epModifyRowMatches('', '1405401'), false);          // 행에 idx 없음
  assert.equal(epModifyRowMatches('1405401', ''), false);          // 인자 없음
  assert.equal(epModifyRowMatches(null, null), false);
  assert.equal(epModifyRowMatches(undefined, undefined), false);
  assert.equal(epModifyRowMatches('  ', '1405401'), false);        // 공백뿐
});

/* ── epPopupAction — 팝업 창이 지금 어디냐 ────────────────────────────────── */

test('수정폼 경로면 화면을 정리한다(dress)', () => {
  assert.equal(EP_FORM_PATH, '/jun/orderitem/orderItemModifyForm.do');   // ⚠ Form 접미사 = 읽기
  assert.equal(epPopupAction(EP_FORM_PATH), 'dress');
});

test('제출 신호 + 아는 저장 착지에서만 닫는다(done)', () => {
  assert.equal(epPopupAction('/jun/orderitem/orderItemModify.do', true), 'done');   // 저장(POST) 경로
  assert.equal(epPopupAction('/jun/orderitem/orderItemList.do', true), 'done');     // 목록 리다이렉트
});

test('★제출 증거가 없으면 아는 경로여도 닫지 않는다 — 인과 없이 완료로 치지 않는다', () => {
  // 사용자가 저장하지 않고 메뉴로 목록에 간 것도 경로만 보면 '저장 완료' 로 오인한다.
  assert.equal(epPopupAction('/jun/orderitem/orderItemList.do', false), 'stay');
  assert.equal(epPopupAction('/jun/orderitem/orderItemModify.do', false), 'stay');
  assert.equal(epPopupAction('/jun/orderitem/orderItemList.do'), 'stay');           // 인자 생략
  assert.equal(epPopupAction('/jun/orderitem/orderItemList.do', 'yes'), 'stay');    // true 만 인정
});

test("★모르는 곳에서는 창을 닫지 않는다(stay) — 저장 안 한 작업·오류 화면을 잃지 않게", () => {
  // '수정폼이 아니면 전부 done' 이면 사용자가 폼에서 다른 데로 이동하거나 서버 오류에
  // 착지했을 때도 창을 닫아버려, 저장 안 한 입력을 잃고 오류 내용을 못 본다.
  for (const submitted of [true, false]) {
    assert.equal(epPopupAction('/jun/orderitem/orderItemPopCurrentSettingModifyForm.do', submitted), 'stay');
    assert.equal(epPopupAction('/board/list.do', submitted), 'stay');
    assert.equal(epPopupAction('/mall/login.ubs', submitted), 'stay');
    assert.equal(epPopupAction('/error.jsp', submitted), 'stay');
    assert.equal(epPopupAction('/', submitted), 'stay');
    assert.equal(epPopupAction('', submitted), 'stay');
    assert.equal(epPopupAction(null, submitted), 'stay');
  }
});

test('수정폼은 제출 신호와 무관하게 항상 dress — 저장 후 폼이 다시 떠도 창을 유지한다', () => {
  assert.equal(epPopupAction(EP_FORM_PATH, false), 'dress');
  assert.equal(epPopupAction(EP_FORM_PATH, true), 'dress');   // 검증 실패로 폼 재표시 = 사용자가 봐야 한다
});

test('⚠ 저장 엔드포인트(Modify.do)와 읽기 폼(ModifyForm.do)은 한 글자 차이 — 섞이면 안 된다', () => {
  // ModifyForm.do 는 폼을 보여주는 읽기 경로, Modify.do 는 저장(POST) 경로다.
  // 접두 일치로 판정하면 저장 경로까지 'dress' 로 잡혀 창이 안 닫힌다.
  assert.equal(epPopupAction('/jun/orderitem/orderItemModifyForm.do', true), 'dress');
  assert.equal(epPopupAction('/jun/orderitem/orderItemModify.do', true), 'done');
});

/* ══ 내부 UI 재설계 (2026-08-03) ══════════════════════════════════════════════
 *  spec: docs/superpowers/specs/2026-08-03-orderitem-editpopup-inner-ui-design.md
 * ========================================================================== */

//  2026-08-03 라이브 실측(주문 388077). 바깥 배치표 = 3행 4칸.
//    [0 상품정보표 입력1] [1 썸네일 rowspan=2 입력0] [2 옵션표 입력6] [3 인도예정일+비고 입력5]
const OUTER_CELLS_LIVE = [
  { rowSpan: 1, controls: 1 },   // 상품정보(중량 input)
  { rowSpan: 2, controls: 0 },   // 썸네일 — ★이것 때문에 종전 가드가 매번 물러났다
  { rowSpan: 1, controls: 6 },   // 옵션
  { rowSpan: 1, controls: 5 }    // 인도예정일 + 비고 2
];

test('★회귀 — 실측 배치표(썸네일 rowspan=2)를 거부하지 않는다', () => {
  //  이 한 줄이 이번 작업의 핵심이다. v3.9.9 까지 epReflowLayout 은 rowspan 이 하나라도
  //  있으면 통째로 물러났고, 이 표는 **항상** 썸네일 rowspan=2 를 갖는다. 그래서 비고
  //  재정렬이 한 번도 실행된 적이 없었다(라이브 실측: .ub-ep-outer 0개).
  assert.equal(epRowspanBlocks(OUTER_CELLS_LIVE), false);
});

test('rowspan 칸이 입력을 품었으면 거부한다 — 묶여 있어야 할 입력이 흩어진다', () => {
  //  거부해야 하는 진짜 위험. display:contents 로 tr 을 통과시키면 rowspan 은 렌더링에
  //  관여하지 않으므로, 그 칸이 입력을 품고 있으면 폼의 시각적 묶음이 깨진다.
  assert.equal(epRowspanBlocks([{ rowSpan: 2, controls: 1 }]), true);
  assert.equal(epRowspanBlocks([{ rowSpan: 1, controls: 9 }, { rowSpan: 3, controls: 2 }]), true);
});

test('rowspan 판정 — 표시 전용 칸·빈 입력·이상한 값에 흔들리지 않는다', () => {
  assert.equal(epRowspanBlocks([{ rowSpan: 5, controls: 0 }]), false);   // 사진만 있는 칸
  assert.equal(epRowspanBlocks([{ rowSpan: 1, controls: 3 }]), false);   // rowspan 아님
  assert.equal(epRowspanBlocks([]), false);
  assert.equal(epRowspanBlocks(null), false);
  assert.equal(epRowspanBlocks(undefined), false);
  assert.equal(epRowspanBlocks([null, undefined]), false);               // 구멍 뚫린 목록
  //  숫자 문자열은 숫자로 본다('2'|0 === 2). 실제 DOM 은 항상 number 라 안 오는 경로지만,
  //  온다면 '2행을 먹는 입력 칸' 이 맞으므로 거부가 옳다.
  assert.equal(epRowspanBlocks([{ rowSpan: '2', controls: '1' }]), true);
  //  숫자로 못 읽는 값은 0 으로 떨어져 '거부' 로 튀지 않는다.
  assert.equal(epRowspanBlocks([{ rowSpan: 'abc', controls: 'xyz' }]), false);
  assert.equal(epRowspanBlocks([{ rowSpan: 2, controls: 'xyz' }]), false);
});

test('바깥 배치표 자리 — 비고1 · 옵션2 · 상품정보3 · 썸네일4', () => {
  assert.deepEqual(epOuterSlot({ remark: true }), { order: 1, flex: '0 0 100%' });
  assert.deepEqual(epOuterSlot({ opt: true }), { order: 2, flex: '0 0 100%' });
  assert.deepEqual(epOuterSlot({}), { order: 3, flex: '1 1 240px' });
  assert.deepEqual(epOuterSlot({ thumb: true }), { order: 4, flex: '0 0 auto' });
  assert.deepEqual(epOuterSlot(null), { order: 3, flex: '1 1 240px' });   // 인자 없음 = 평범한 칸
});

test('★비고 칸은 옵션표를 품고 있어도 맨 위다 — 판정 우선순위', () => {
  //  실측상 비고 칸과 옵션 칸은 다르지만, 다른 주문 유형에서 한 칸에 같이 올 수 있다.
  //  그때 옵션(2)이 이기면 비고가 아래로 내려가 이번 작업의 목적이 뒤집힌다.
  assert.equal(epOuterSlot({ remark: true, opt: true }).order, 1);
  assert.equal(epOuterSlot({ remark: true, thumb: true }).order, 1);
  assert.equal(epOuterSlot({ opt: true, thumb: true }).order, 2);
});

test('상품정보 칸만 늘어난다 — 썸네일은 48px 고정폭이라 신축 금지', () => {
  //  마지막 줄에 [상품정보 ....][사진] 이 나란히 서려면 한쪽만 남는 폭을 먹어야 한다.
  //  둘 다 `1 1` 이면 48px 사진이 늘어나 우스운 그림이 된다.
  assert.equal(epOuterSlot({}).flex.startsWith('1 1'), true);
  assert.equal(epOuterSlot({ thumb: true }).flex, '0 0 auto');
});

test('비고 행 — textarea 는 반 칸·라벨 위, 나머지는 전체 폭·아래', () => {
  assert.deepEqual(epRemarkRowSlot({ textarea: true }), { full: false, stack: true, order: 1 });
  assert.deepEqual(epRemarkRowSlot({ textarea: false }), { full: true, stack: false, order: 2 });
  assert.deepEqual(epRemarkRowSlot({}), { full: true, stack: false, order: 2 });
  assert.deepEqual(epRemarkRowSlot(null), { full: true, stack: false, order: 2 });
});

test('★비고 행에 ub-ep-full 을 붙이면 안 된다 — 붙는 순간 2열이 1열로 무너진다', () => {
  //  .ub-ep-full 은 grid-column:1/-1 이다. 비고 두 칸에 이게 붙으면 나란히 서지 못한다.
  assert.equal(epRemarkRowSlot({ textarea: true }).full, false);
  //  반대로 고객인도예정일은 전체 폭을 써야 한다(반 칸에 select 3개는 안 들어간다).
  assert.equal(epRemarkRowSlot({ textarea: false }).full, true);
});

test('패널 높이 — 콘텐츠 + 헤더 + 2, 화면과 최소치 안으로 clamp', () => {
  //  실측 기준: 재설계 후 콘텐츠 약 600, 패널 헤더 44 → 646.
  assert.equal(epFitHeight(600, 44, 1279), 646);
  //  거대한 콘텐츠는 화면에서 32px 뺀 값으로 잘린다(epClampPanel 과 같은 규칙).
  assert.equal(epFitHeight(5000, 44, 1000), 968);
  //  작은 콘텐츠는 최소 320(CSS min-height 와 같은 값)보다 작아지지 않는다.
  assert.equal(epFitHeight(50, 44, 1000), 320);
});

test('패널 높이 — 화면이 아주 낮아도 최소치가 이긴다(음수·0 높이 금지)', () => {
  assert.equal(epFitHeight(600, 44, 200), 320);   // 진짜로 낮은 창
  assert.equal(epFitHeight(0, 0, 1000), 320);
});

test('★백그라운드 탭 — 화면을 못 재면 가두지 않는다(패널 찌그러짐 방지)', () => {
  //  실측 2026-08-03: document.hidden 인 탭에서는 innerWidth/innerHeight/screen 이 전부 0 이다.
  //  높이 신호는 load 뒤에 오므로, [수정]을 누르고 다른 탭에 다녀오면 그때 도착한다.
  //  그 값을 그대로 쓰면 cap 이 최소치로 떨어져 패널이 320px 로 찌그러진 채 남는다.
  assert.equal(epFitHeight(600, 44, 0), 646);       // 못 잼 → 콘텐츠대로
  assert.equal(epFitHeight(600, 44, -1), 646);
  assert.equal(epFitHeight(600, 44, null), 646);
  //  ⚠ 200 은 '못 잰 것' 이 아니라 '진짜 낮은 창' 이다 — 그건 위 테스트대로 여전히 가둔다.
});

test('빈 행 판정 — 입력이 있으면 절대 접지 않는다', () => {
  //  접는 것은 보기 좋으라고 하는 일이다. 사용자가 고쳐야 할 칸을 숨기면 그 순간 버그가 된다.
  assert.equal(epIsFillerRow({ controls: 0, text: '   \n\t ' }), true);   // 공백뿐
  assert.equal(epIsFillerRow({ controls: 0, text: '' }), true);
  assert.equal(epIsFillerRow({ controls: 1, text: '' }), false);         // ★입력 있음
  assert.equal(epIsFillerRow({ controls: 0, text: '고객인도예정일' }), false);
  assert.equal(epIsFillerRow({ controls: 0, text: '', thumb: true }), false);  // 사진 행
  assert.equal(epIsFillerRow({}), true);
  assert.equal(epIsFillerRow(null), true);
});

test('빈 행 판정 — text 가 없거나 이상한 타입이어도 터지지 않는다', () => {
  assert.equal(epIsFillerRow({ controls: 0, text: null }), true);
  assert.equal(epIsFillerRow({ controls: 0, text: undefined }), true);
  assert.equal(epIsFillerRow({ controls: 0, text: 0 }), false);      // '0' 은 내용이다
  assert.equal(epIsFillerRow({ controls: '2', text: '' }), false);   // 숫자 문자열도 입력으로 센다
});

test('★회귀(소스 대조) — 빈 행 접기가 두 표 모두에 걸려 있다', () => {
  //  비고 표에만 걸면 옵션 표의 빈 행(실측 1개)이 남고, 옵션 표에만 걸면 이번 작업의
  //  최대 효과(비고 표 9개)를 통째로 놓친다.
  assert.equal(extractFn(SRC, 'epReflowRemarks').includes('epMarkFiller'), true,
    '비고 표에 빈 행 접기가 빠졌다');
  assert.equal(extractFn(SRC, 'epCompactForm').includes('epMarkFiller'), true,
    '옵션 표에 빈 행 접기가 빠졌다');
});

/* ── 아주 작은 CSS 캐스케이드 해석기 ────────────────────────────────────────
 *  ★왜 필요한가: 2026-08-03 Codex 검수에서 `.ub-ep-card tr.ub-ep-filler{display:none
 *   !important}` 가 **뒤에 선언된** `.ub-ep-card tr.ub-ep-row{display:grid !important}` 에
 *   특이도 동률(0,2,1)로 져서 빈 행이 하나도 접히지 않는 결함이 나왔다. 라이브 확인은
 *   델타를 별도 스타일시트로 나중에 붙이는 바람에 우연히 통과했다(위양성).
 *   "규칙 문자열이 있다"는 검사로는 이 부류를 절대 못 잡는다 → **실제로 이기는지**를 본다.
 *  지원 문법은 이 스타일시트가 쓰는 것뿐: 콤마 목록 · 자손( ) · 자식(>) · 태그+클래스.
 *  속성/의사 선택자가 낀 복합부는 매칭하지 않는다(tr 에는 어차피 안 걸린다).
 * ------------------------------------------------------------------------- */
function epStylesheet() {
  const inj = extractFn(SRC, 'epInjectStyle');
  const open = inj.indexOf('[', inj.indexOf('s.textContent = ['));
  let depth = 0, close = -1;
  for (let i = open; i < inj.length; i++) {
    if (inj[i] === '[') depth++;
    else if (inj[i] === ']') { depth--; if (depth === 0) { close = i; break; } }
  }
  assert.ok(close > open, 'epInjectStyle 의 CSS 배열을 못 찾았다');
  // eslint-disable-next-line no-new-func
  return new Function('return (' + inj.slice(open, close + 1) + ').join("")')();
}
//  ★다루지 못하는 문법은 **조용히 무시하지 않는다**(Codex 2라운드 지적). 예컨대 `:not()` 은
//   실제로는 매칭되는데 무시하면 승자가 뒤바뀌고, `#id` 는 태그·클래스가 없어 아무 노드에나
//   매칭돼 버린다. 둘 다 '통과했지만 답이 틀린' 테스트를 만든다 → 만나면 fail-closed 로 보고한다.
//  ★단, **이 체인에 걸릴 수도 없는** 미지원 선택자까지 신고하면 테스트가 늘 빨개져 쓸모없어진다
//   (실제 스타일시트엔 `#ub-sidebar{display:none}`·`.ub-ep-title:before{display:inline-block}` 이
//   있는데 tr 과 무관하다). 그래서 미지원 부분을 **떼어낸 느슨한 형태**로 먼저 매칭해 본다.
//   느슨한 쪽은 항상 원본보다 넓으므로, 느슨해도 안 걸리면 원본은 확실히 안 걸린다(보수적).
const SEL_UNSUPPORTED = /[[:#]/;
//  ⚠ 형제 결합자(`+`·`~`)는 **느슨화로도 판정할 수 없다** — 이 체인 모델은 조상만 담고 형제를
//   모르기 때문이다. 그래서 '걸릴 수 있나' 를 물을 수조차 없어 **무조건 신고**한다. 신고하지
//   않으면 `selMatches` 가 그냥 '안 걸림' 으로 처리해 조용히 오답이 된다(Fable 검수 m2).
//   지금 스타일시트엔 없으므로 오탐도 없다 — 누가 넣는 순간 요란하게 깨지는 게 목적이다.
const SEL_UNEVALUABLE = /[+~]/;
//  ★두 단계로 나눠 벗긴다(Codex 4라운드 지적). 한 번에 다 지우면 `:not(.keep)` 처럼 **복합부가
//   통째로 사라져** 대상 위치를 잃고, 그러면 "느슨한 쪽이 상위집합" 이라는 전제가 깨져 오답이
//   조용히 통과한다(`.card :not(.keep)` 가 `.card ` 가 돼 tr 에 안 걸린다).
//   - `#id` 만으로 이뤄진 복합부: 이 체인 모델엔 id 가 없으니 **절대 못 걸린다** → 안전하게 무시
//     (실제 스타일시트의 `#ub-sidebar{display:none}` 이 매번 오탐이 되는 걸 막는다).
//   - `:pseudo`/`[attr]` 만으로 이뤄진 복합부: 무엇에든 걸릴 수 있는 필터다 → 판정 불가로 신고.
//  ⚠ id 전용 복합부가 **조상 자리**에 있어도(`#erpId tr.ub-ep-row{display:…}`) 무시한다.
//   "체인 모델이 계약" 이라는 전제에서는 옳지만, 나중에 id 기반 display 규칙을 넣는 사람은
//   체인 모델(CHAIN_FILLER)에 id 지원도 함께 넣어야 한다(Fable 검수 4라운드 nit).
const stripId = (s) => s.replace(/#[A-Za-z0-9_-]+/g, '');
const stripFilter = (s) => s.replace(/:{1,2}[a-zA-Z-]+(\([^)]*\))?/g, '').replace(/\[[^\]]*\]/g, '');
const hasSubstance = (s) => /[a-zA-Z.*]/.test(s);
//  { verdict: 'ignore' | 'report' | 'test', relaxed }
function relaxSelect(sel) {
  const toks = sel.trim().replace(/>/g, ' > ').split(/\s+/).filter(Boolean);
  const out = [];
  for (const t of toks) {
    if (t === '>') { out.push(t); continue; }
    const noId = stripId(t);
    if (!hasSubstance(noId)) return { verdict: 'ignore', relaxed: '' };   // id 전용 복합부
    const bare = stripFilter(noId);
    if (!hasSubstance(bare)) return { verdict: 'report', relaxed: '' };   // 필터 전용 복합부
    out.push(bare);
  }
  return { verdict: 'test', relaxed: out.join(' ') };
}
function cmpMatches(cmp, node) {
  if (!/[a-zA-Z.*]/.test(cmp)) return false;        // 떼어내고 나면 빈 복합부 → 아무것도 안 맞는다
  const tag = (cmp.match(/^[a-zA-Z*]+/) || [''])[0];
  if (tag && tag !== '*' && tag !== node.tag) return false;
  return (cmp.match(/\.[A-Za-z0-9_-]+/g) || []).every((c) => node.cls.indexOf(c.slice(1)) >= 0);
}
function selMatches(sel, chain) {
  const raw = sel.trim().replace(/>/g, ' > ').split(/\s+/).filter(Boolean);
  const parts = [];
  let comb = null;
  for (const t of raw) { if (t === '>') { comb = '>'; continue; } parts.push({ comb, cmp: t }); comb = ' '; }
  if (!parts.length) return false;
  let ci = chain.length - 1;
  if (!cmpMatches(parts[parts.length - 1].cmp, chain[ci])) return false;
  for (let pi = parts.length - 2; pi >= 0; pi--) {
    if (parts[pi + 1].comb === '>') {
      ci--;
      if (ci < 0 || !cmpMatches(parts[pi].cmp, chain[ci])) return false;
    } else {
      let found = false;
      for (ci--; ci >= 0; ci--) { if (cmpMatches(parts[pi].cmp, chain[ci])) { found = true; break; } }
      if (!found) return false;
    }
  }
  return true;
}
function specificity(sel) {
  return [(sel.match(/\.[A-Za-z0-9_-]+/g) || []).length,
          (sel.match(/(^|[\s>])[a-zA-Z]+/g) || []).length];
}
//  chain 에 대해 prop 의 **최종 승자**를 돌려준다. 캐스케이드 순서: !important → 특이도 → 선언 순서.
//  반환 { best, unsupported } — unsupported 가 비어 있지 않으면 판정을 믿으면 안 된다.
function resolveProp(css, prop, chain) {
  const flat = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');  // 미디어 블록 제외
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m, order = 0, best = null;
  const unsupported = [];
  while ((m = re.exec(flat))) {
    order++;
    const d = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)').exec(m[2]);
    if (!d) continue;                                  // 이 규칙은 해당 속성을 안 건드린다
    const value = d[1].trim();
    const important = /!important/.test(value);
    for (const sel of m[1].split(',')) {
      if (SEL_UNEVALUABLE.test(sel)) { unsupported.push(sel.trim()); continue; }
      if (SEL_UNSUPPORTED.test(sel)) {
        //  느슨하게 해도 이 체인에 안 걸리면 원본도 확실히 안 걸린다 → 조용히 넘어간다.
        const r = relaxSelect(sel);
        if (r.verdict === 'ignore') continue;
        if (r.verdict === 'report' || selMatches(r.relaxed, chain)) unsupported.push(sel.trim());
        continue;
      }
      if (!selMatches(sel, chain)) continue;
      const sp = specificity(sel);
      const cand = { value: value.replace(/\s*!important\s*/, '').trim(), important, sp, order, sel: sel.trim() };
      if (!best) { best = cand; continue; }
      if (cand.important !== best.important) { if (cand.important) best = cand; continue; }
      if (cand.sp[0] !== best.sp[0]) { if (cand.sp[0] > best.sp[0]) best = cand; continue; }
      if (cand.sp[1] !== best.sp[1]) { if (cand.sp[1] > best.sp[1]) best = cand; continue; }
      best = cand;                       // 동률이면 뒤에 선언된 쪽이 이긴다
    }
  }
  return { best, unsupported };
}
//  판정을 쓰기 전에 '해석기가 다 이해했는가' 를 먼저 확인한다.
function resolveDisplay(css, chain) {
  const { best, unsupported } = resolveProp(css, 'display', chain);
  assert.deepEqual(unsupported, [],
    '해석기가 못 다루는 선택자가 display 규칙에 생겼다 — 판정을 믿을 수 없다. ' +
    '해석기를 넓히거나 그 규칙을 단순화하라: ' + unsupported.join(' , '));
  return best;
}
//  실측 DOM 사슬: 카드 > 바깥배치표 > tbody > tr > td > 비고표 > tbody > 대상 tr
const CHAIN_FILLER = [
  { tag: 'body', cls: [] },
  { tag: 'table', cls: ['ub-ep-card'] },
  { tag: 'table', cls: ['ub-ep-outer'] },
  { tag: 'tbody', cls: [] }, { tag: 'tr', cls: [] }, { tag: 'td', cls: [] },
  { tag: 'table', cls: ['ub-ep-grid1'] }, { tag: 'tbody', cls: [] },
  { tag: 'tr', cls: ['ub-ep-row', 'ub-ep-filler', 'ub-ep-solo', 'ub-ep-full'] }
];

test('★★빈 행이 실제로 접히는가 — CSS 캐스케이드 승자 검증 (Codex 2026-08-03 지적)', () => {
  const win = resolveDisplay(epStylesheet(), CHAIN_FILLER);
  assert.ok(win, 'tr 에 걸리는 display 규칙이 하나도 없다');
  assert.equal(win.value, 'none',
    '빈 행이 접히지 않는다 — 이긴 규칙: ' + win.sel + ' → display:' + win.value);
});

test('빈 행이 아닌 보통 행은 여전히 grid 다 (접기 규칙이 과하게 먹지 않는다)', () => {
  const chain = CHAIN_FILLER.slice(0, -1).concat([{ tag: 'tr', cls: ['ub-ep-row', 'ub-ep-stack'] }]);
  const win = resolveDisplay(epStylesheet(), chain);
  assert.equal(win.value, 'grid', '보통 행이 grid 가 아니다 — 이긴 규칙: ' + win.sel);
});

test('해석기 자체 점검 — 동률이면 뒤가 이기고, 클래스가 하나 더 많으면 앞이라도 이긴다', () => {
  //  해석기가 틀리면 위 두 테스트가 조용히 무의미해진다. 알려진 답으로 먼저 재본다.
  const chain = [{ tag: 'div', cls: ['card'] }, { tag: 'tr', cls: ['a', 'b'] }];
  const v = (css) => resolveProp(css, 'display', chain).best;
  assert.equal(v('.card tr.a{display:none !important;}.card tr.b{display:grid !important;}')
    .value, 'grid');                                                    // 동률 → 뒤
  assert.equal(v('.card tr.a.b{display:none !important;}.card tr.b{display:grid !important;}')
    .value, 'none');                                                    // 특이도 높은 앞쪽
  assert.equal(v('.card tr.b{display:grid !important;}.card tr.a{display:none;}')
    .value, 'grid');                                                    // !important 우선
  assert.equal(v('.card tr.zzz{display:none !important;}'), null);
  assert.equal(v('.card > tr.a{display:none !important;}').value, 'none');       // 자식 결합자
  assert.equal(v('span > tr.a{display:none !important;}'), null);                // 부모 태그 불일치
  assert.equal(v('.card tr.a.c{display:none !important;}'), null);               // 없는 클래스
});

test('★해석기는 못 다루는 선택자를 조용히 넘기지 않는다 (Codex 2라운드 지적)', () => {
  //  `:not()` 은 실제로는 매칭되는데 무시하면 승자가 뒤바뀌고, `#id` 는 태그·클래스가 없어
  //  아무 노드에나 매칭된다. 둘 다 '통과했지만 답이 틀린' 테스트를 만든다 → 반드시 보고돼야 한다.
  const chain = [{ tag: 'div', cls: ['card'] }, { tag: 'tr', cls: ['a', 'b'] }];
  const notSel = '.card tr.a{display:none !important;}.card tr.a:not(.keep){display:grid !important;}';
  assert.deepEqual(resolveProp(notSel, 'display', chain).unsupported, ['.card tr.a:not(.keep)']);
  assert.throws(() => resolveDisplay(notSel, chain), /못 다루는 선택자/);
  //  ⚠ display 를 건드리지 않는 규칙의 미지원 선택자는 무해하므로 보고하지 않는다
  //   (실제 스타일시트의 `input[type=text]`, `tr.ub-ep-row:not(.ub-ep-full)` 등).
  assert.deepEqual(resolveProp('.card input[type=text]{max-width:220px !important;}', 'display', chain)
    .unsupported, []);
  //  ⚠ 이 체인에 **걸릴 수도 없는** 미지원 선택자도 보고하지 않는다. 안 그러면 실제
  //   스타일시트의 `#ub-sidebar{display:none}`·`.ub-ep-title:before{display:inline-block}`
  //   때문에 테스트가 늘 빨개져 아무도 안 보게 된다.
  assert.deepEqual(resolveProp('#ghost{display:none !important;}', 'display', chain).unsupported, []);
  assert.deepEqual(resolveProp('.other:before{display:block !important;}', 'display', chain).unsupported, []);
  //  반대로 **걸릴 수 있는** 미지원 선택자는 반드시 보고한다(위 :not 케이스가 그 예).
  assert.deepEqual(resolveProp('.card tr.a[data-x]{display:grid !important;}', 'display', chain)
    .unsupported, ['.card tr.a[data-x]']);
  //  형제 결합자도 못 다룬다 — 신고 안 하면 '안 걸림' 으로 조용히 오답이 된다.
  assert.deepEqual(resolveProp('.card tr.a ~ tr.b{display:grid !important;}', 'display', chain)
    .unsupported, ['.card tr.a ~ tr.b']);
  assert.deepEqual(resolveProp('tr.a + tr.b{display:grid !important;}', 'display', chain)
    .unsupported, ['tr.a + tr.b']);
  //  ★필터 전용 복합부(`:not(.keep)` 하나로 이뤄진 부분)는 벗기면 대상 위치를 잃는다 —
  //   느슨화 결과가 상위집합이 아니게 되므로 매칭을 물어선 안 되고 **무조건 신고**해야 한다.
  //   (Codex 4라운드 지적: 이 경로로 실제 승자 none 을 놓치고 grid 로 오답 통과했다)
  const lost = '.card .a{display:grid !important;}.card :not(.keep){display:none !important;}';
  assert.deepEqual(resolveProp(lost, 'display', chain).unsupported, ['.card :not(.keep)']);
  assert.throws(() => resolveDisplay(lost, chain), /못 다루는 선택자/);
  //  반대로 id **전용** 복합부는 이 체인에 id 가 없어 절대 못 걸린다 → 조용히 넘어간다.
  assert.deepEqual(resolveProp('.card #x{display:none !important;}', 'display', chain).unsupported, []);
});

test('★회귀(소스 대조) — 정리에 실패하면 높이를 맞추지 않는다', () => {
  //  날것 문서(form1 없음)의 높이에 패널을 맞추면 설계의 660 폴백이 무력화된다(Codex 지적).
  const dress = extractFn(SRC, 'epDressPopup');
  assert.match(dress, /return false;/, 'epDressPopup 이 실패를 알리지 않는다');
  assert.match(dress, /return true;\s*\n?\s*\}$/, 'epDressPopup 이 성공을 알리지 않는다');
  const init = extractFn(SRC, 'initEditPopupWindow');
  assert.match(init, /if\s*\(\s*epDressPopup\([^)]*\)\s*\)\s*epScheduleFit/,
    '정리 성공 여부와 무관하게 높이 신호를 걸고 있다');
});

test('★회귀(소스 대조) — 패널을 다시 열 때마다 자동 맞춤이 되살아난다', () => {
  //  ★리셋이 epEnsurePanel 에만 있으면 **재사용 경로가 빠진다** — 그 함수는 이미 있는 패널이면
  //   조기 반환한다. 주문 A 에서 손잡이를 한 번 잡고 닫지 않은 채 B 의 [수정]을 누르면 B 가
  //   영영 A 때 크기로 열린다(Fable 검수 2026-08-03 지적). 리셋은 epOpenPanel 에 있어야 한다.
  assert.match(extractFn(SRC, 'epOpenPanel'), /_epUserSized\s*=\s*false/,
    'epOpenPanel 이 _epUserSized 를 리셋하지 않는다 — 패널 재사용 시 자동 맞춤이 죽는다');
  assert.match(extractFn(SRC, 'epOpenPanel'), /_epPendingFit\s*=\s*0/,
    'epOpenPanel 이 앞 문서의 높이를 비우지 않는다');
  //  ★플래그만으로는 부족하다 — 높이 자체를 폴백으로 되돌려야 한다. 안 그러면 A 를 900 으로
  //   늘려 둔 채 B 를 열었을 때, B 에서 dress 가 물러나면(신호 없음) A 의 900 이 그대로 남아
  //   660 폴백이 무력해진다(Codex 3라운드 지적).
  assert.match(extractFn(SRC, 'epOpenPanel'), /style\.height\s*=\s*EP_DEFAULT_H/,
    'epOpenPanel 이 패널 높이를 폴백으로 되돌리지 않는다 — 앞 주문 크기를 승계한다');
  assert.match(SRC, /const EP_DEFAULT_H = 660;/, '폴백 높이가 상수로 한 곳에 있지 않다');
  assert.match(extractFn(SRC, 'epEnsurePanel'), /=\s*EP_DEFAULT_H/,
    '생성 경로와 재사용 경로가 서로 다른 폴백 높이를 쓰면 언젠가 갈린다');
});

test('★회귀(소스 대조) — 숨은 탭에서는 높이를 적용하지 않고 보류한다', () => {
  //  상한 없이 키워 놓으면 돌아와도 resize 가 없어 화면보다 큰 채 남는다(Fable 지적).
  const fit = extractFn(SRC, 'epApplyFit');
  assert.match(fit, /window\.innerHeight\s*>\s*0/, 'epApplyFit 에 화면 측정 가드가 없다');
  assert.match(fit, /_epPendingFit\s*=\s*content/, '보류값을 담아 두지 않으면 복귀해도 못 맞춘다');
  assert.match(extractFn(SRC, 'epEnsurePanel'), /visibilitychange/,
    '탭 복귀 시 다시 맞추는 경로가 없다');
  assert.match(extractFn(SRC, 'epDropResize'), /visibilitychange/,
    'visibilitychange 리스너를 떼지 않으면 패널 DOM 이 쌓인다');
});

test('★회귀(소스 대조) — 빈 행 판정은 버튼류도 컨트롤로 센다', () => {
  //  글자 없는 버튼(`<button>`·`btn_*.gif` 링크)만 있는 행을 접으면 사용자가 못 누른다.
  //  ⚠ EP_CTRL_SEL 자체를 넓히면 썸네일 칸 판정이 뒤집힌다 → 별도 선택자여야 한다.
  assert.match(SRC, /const EP_ACTION_SEL = EP_CTRL_SEL \+ ".*button.*"/,
    '빈 행 판정용 넓은 선택자(EP_ACTION_SEL)가 없다');
  assert.match(extractFn(SRC, 'epMarkFiller'), /EP_ACTION_SEL/,
    'epMarkFiller 가 좁은 선택자를 쓰고 있다');
  assert.equal(extractFn(SRC, 'epReflowLayout').includes('EP_ACTION_SEL'), false,
    '썸네일·rowspan 판정까지 넓은 선택자를 쓰면 사진 축소가 풀린다');
});

test('★회귀(소스 대조) — 높이 신호는 scrollHeight 를 쓰지 않는다', () => {
  //  scrollHeight 는 뷰포트보다 작아지지 않는다(실측: 패널 900/700/660 에서 851/651/626,
  //  실제 콘텐츠는 내내 627). 그걸 쓰면 패널이 절대 줄지 않고 신호 2회 동안 되레 커진다.
  const sig = extractFn(SRC, 'epSignalFit');
  assert.equal(/scrollHeight/.test(sig), false, 'epSignalFit 이 scrollHeight 로 되돌아갔다');
  assert.equal(sig.includes('epContentHeight'), true, 'epSignalFit 이 실측 바닥을 안 쓴다');
  //  폴백으로만 남아 있어야 한다(잴 수 없을 때).
  const m = extractFn(SRC, 'epContentHeight');
  assert.equal(m.includes('getBoundingClientRect'), true, '바닥을 직접 재지 않는다');
  assert.equal(m.includes('scrollHeight'), true, '측정 불가 시 폴백이 없다');
});

test('★회귀(소스 대조) — 패널은 border-box 다 (clamp 마다 2px 씩 커지지 않게)', () => {
  //  content-box 면 offsetWidth 가 border 를 포함하는데 epClampPanel 이 그 값을 style.width 에
  //  되쓰므로 900 → 902 → 904 … 로 자란다. fit 신호가 주문마다 두 번 오고 탭 복귀에도 clamp 하니
  //  실제로 쌓인다(Codex 검수 4라운드). epFitHeight 의 `+2` 도 border-box 라야 정확히 맞는다.
  const css = extractFn(SRC, 'epEnsurePanelStyle');   // EP_PANEL_CSS 를 주입하는 쪽
  assert.ok(css.includes('EP_PANEL_STYLE_ID'), 'EP_PANEL_CSS 주입 경로가 바뀌었다');
  const m = /const EP_PANEL_CSS = `([\s\S]*?)`;/.exec(SRC);
  assert.ok(m, 'EP_PANEL_CSS 를 찾지 못했다');
  const panelRule = /\.ub-epw\s*\{([\s\S]*?)\}/.exec(m[1]);
  assert.ok(panelRule, '.ub-epw 규칙을 찾지 못했다');
  assert.match(panelRule[1], /box-sizing:\s*border-box/,
    '.ub-epw 에 box-sizing:border-box 가 없다 — clamp 할 때마다 패널이 2px 씩 커진다');
  assert.match(panelRule[1], /border:\s*1px/, 'border 가 사라졌다면 이 테스트의 전제를 다시 보라');
});

test('★회귀(소스 대조) — 화면을 못 재면 epClampPanel 이 손대지 않는다', () => {
  //  이 가드가 빠지면 min(innerWidth-32, w) 가 음수를 골라 패널이 420×320 으로 찌그러진다.
  const body = extractFn(SRC, 'epClampPanel');
  assert.match(body, /window\.innerWidth\s*>\s*0/, 'epClampPanel 에 화면 측정 가드가 없다');
  assert.match(body, /window\.innerHeight\s*>\s*0/, 'epClampPanel 에 화면 측정 가드가 없다');
});

test('패널 높이 — 쓰레기 입력에도 유한한 값이 나온다', () => {
  for (const bad of [null, undefined, NaN, 'abc', {}, [], -1]) {
    const h = epFitHeight(bad, bad, bad);
    assert.equal(Number.isFinite(h), true, '유한하지 않다: ' + String(bad));
    assert.equal(h >= 320, true, '최소치 미만: ' + String(bad));
  }
});

test('★회귀(소스 대조) — epReflowLayout 은 더 이상 썸네일 칸을 숨기지 않는다', () => {
  //  사장님 결정 2026-08-03: 숨기지 말고 48px 로 줄여 남긴다(엉뚱한 주문을 눈으로 거른다).
  //  숨김이 돌아오면 flex 자리 지정(order 4)이 무의미해지므로 소스로 못 박는다.
  const body = extractFn(SRC, 'epReflowLayout');
  assert.equal(/display\s*=\s*['"]none['"]/.test(body), false,
    'epReflowLayout 에 display:none 이 다시 들어왔다 — 썸네일을 숨기면 안 된다');
  assert.equal(body.includes('ub-ep-thumb'), true, '썸네일 칸에 클래스를 붙여야 CSS 가 48px 로 줄인다');
});

test('★회귀(소스 대조) — 패널 높이를 저장하지 않는다', () => {
  //  ubEpH 를 다시 저장하면 콘텐츠를 줄여도 옛 높이로 열려 '매번 늘리거나 스크롤' 이 부활한다.
  const body = extractFn(SRC, 'epPanelSavePos');
  assert.equal(body.includes('ubEpH'), false, 'epPanelSavePos 가 높이를 다시 저장하고 있다');
  assert.equal(body.includes('ubEpW'), true, '폭·위치는 계속 저장해야 한다');
});
