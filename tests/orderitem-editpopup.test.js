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
               'epSubmitMarkValid', 'epClassifyForm'];
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
        epSubmitMarkValid, epClassifyForm, EP_FORM_PATH } = sandbox;

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
