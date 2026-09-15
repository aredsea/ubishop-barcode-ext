/* =============================================================================
 *  orderimport-wiring.test.js — 주문 가져오기 배선 구조 회귀테스트(소스 문자열·manifest·shell 인덱스 대상).
 *  브라우저 API 가 필요한 파일(erp 어댑터·UI·xls 브리지)은 node 로 실행할 수 없으므로 "파싱된다 + 기대한
 *  이름을 노출한다 + manifest/shell/background 에 정확히 배선됐다" 를 고정한다.
 *  실행: node --test tests/orderimport-wiring.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const NEW_FILES = ['src/orderimport-core.js', 'src/orderimport-erp.js', 'src/orderimport.js', 'src/orderimport-xls.js', 'vendor/xlsx.full.min.js'];
const CONTENT_ORDER = ['src/erp.js', 'src/orderimport-core.js', 'src/orderimport-erp.js', 'src/orderimport.js'];
const SHEETJS_SHA256 = 'cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41';   // xlsx-0.20.3 xlsx.full.min.js

test('새 파일이 존재하고 문법 오류 없이 파싱된다', () => {
  for (const f of NEW_FILES) assert.ok(fs.existsSync(path.join(ROOT, f)), f + ' 없음');
  for (const f of ['src/orderimport-core.js', 'src/orderimport-erp.js', 'src/orderimport.js', 'src/orderimport-xls.js']) {
    // eslint-disable-next-line no-new-func
    assert.doesNotThrow(() => new Function(read(f)), f + ' 문법 오류');
  }
});

test('vendor/xlsx.full.min.js 는 SheetJS 0.20.3 full 빌드 그대로(해시 고정)', () => {
  //  git autocrlf 가 체크아웃 때 LF→CRLF 로 바꾸므로(작업 사본 CR 24개 실측) build-shell-index.ps1 처럼 CRLF→LF 정규화 후 해시.
  const buf = Buffer.from(fs.readFileSync(path.join(ROOT, 'vendor/xlsx.full.min.js'), 'latin1').replace(/\r\n/g, '\n'), 'latin1');
  assert.ok(buf.length > 900000, 'full 빌드가 아니다(mini 는 xls 를 못 읽는다)');
  assert.ok(buf.slice(0, 200).toString('utf8').includes('SheetJS'));
  assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), SHEETJS_SHA256);
});

test('manifest: orderItemWriteForm.do 에 erp → core → erp어댑터 → UI 순서로 ISOLATED 주입', () => {
  const man = JSON.parse(read('manifest.json'));
  const cs = man.content_scripts.find((c) => Array.isArray(c.js) && c.js.includes('src/orderimport.js'));
  assert.ok(cs, 'orderimport.js 를 싣는 content_scripts 항목이 없다');
  assert.deepEqual(cs.js, CONTENT_ORDER);
  assert.equal(cs.world, 'ISOLATED');
  assert.equal(cs.all_frames, false);
  assert.equal(cs.run_at, 'document_idle');
  assert.deepEqual(cs.matches, ['http://ubdstore.ubshop.biz/order/item/orderItemWriteForm.do*', 'https://ubdstore.ubshop.biz/order/item/orderItemWriteForm.do*']);
  assert.ok(man.permissions.includes('scripting'), 'SheetJS MAIN 주입에 scripting 권한이 필요하다');
  assert.ok(/^4\.2\.\d+$/.test(man.version), 'SHELL 버전은 4.2.x 여야 한다(4.1.9 → patch>9 규칙)');
});

test('background: ubOiInjectXls 가 vendor+브리지를 MAIN 에 파일 주입한다', () => {
  const bg = read('src/background.js');
  assert.ok(bg.includes("msg.type === 'ubOiInjectXls'"));
  const m = bg.match(/ubOiInjectXls[\s\S]{0,600}?executeScript\(\{[\s\S]*?\}\)/);
  assert.ok(m, 'ubOiInjectXls 핸들러 안에 executeScript 가 없다');
  assert.ok(/world:\s*'MAIN'/.test(m[0]));
  assert.ok(/files:\s*\['vendor\/xlsx\.full\.min\.js',\s*'src\/orderimport-xls\.js'\]/.test(m[0]), 'files 순서는 vendor → 브리지');
});

test('build-shell-index.ps1 patterns 에 새 파일 + src/erp.js 가 들어 있다(ExtSync 배포 대상)', () => {
  const ps1 = read('build-shell-index.ps1');
  for (const f of NEW_FILES.concat(['src/erp.js'])) assert.ok(ps1.includes("'" + f + "'"), f + ' 가 patterns 에 없다');
});

test('popup: 스위치 orderImport, 기본 ON', () => {
  assert.ok(read('popup/popup.html').includes('id="orderImport"'));
  const js = read('popup/popup.js');
  assert.ok(/ubOrderImport:\s*true/.test(js), 'popup.js D 에 ubOrderImport:true');
  assert.ok(js.includes("save({ ubOrderImport: orderImport.checked })"));
});

test('skin.js: 기본값 ubOrderImport:true, 주문 화면 판별, 섹션 버튼 #ub-oi-open 은 on(ubOrderImport) 게이트', () => {
  const skin = read('src/skin.js');
  assert.ok(/ubOrderImport:\s*true/.test(skin));
  assert.ok(skin.includes("function isOrderWrite() { return /\\/order\\/item\\/orderItemWriteForm\\.do/.test(location.pathname); }"));
  const sect = skin.match(/\$\{isOrderWrite\(\) && on\('ubOrderImport'\) \? `[\s\S]*?` : ''\}/);
  assert.ok(sect, '주문 가져오기 섹션 템플릿이 없다');
  assert.ok(sect[0].includes('id="ub-oi-open"'));
});

test('erp 어댑터·UI·브리지가 기대한 이름을 노출한다', () => {
  const erp = read('src/orderimport-erp.js');
  assert.ok(erp.includes('globalThis.ubOiErp = { state, searchClient, searchMaster, registerClient, getWriteForm, postLine, getForm10, postComplete, deleteLines, findJunNums, listJunRows };'));
  const ui = read('src/orderimport.js');
  assert.ok(ui.includes("closest('#ub-oi-open')"), 'UI 는 사이드바 버튼을 문서 위임으로 받는다');
  assert.ok(ui.includes("type: 'ubOiInjectXls'"));
  assert.ok(ui.includes("source: 'ub-oi', type: 'parse'"));
  const xls = read('src/orderimport-xls.js');
  assert.ok(xls.includes("d.source !== 'ub-oi' || d.type !== 'parse'"));
  assert.ok(xls.includes("source: 'ub-oi-xls'"));
});

//  Opus 5 P1·P2 (2026-09-15): 결과 → 체크/장부 판정은 core 의 순수 함수로 하고 UI 는 그 결과만 배선한다. 장부는 병합 저장, 매핑표 onChanged 는 실행 중에도 반영.
test('UI 배선: onOrder 가 oiPostRunState 를 쓰고, 장부는 병합 저장, 매핑표 onChanged 는 실행 중에도 S.map 을 갱신한다', () => {
  const ui = read('src/orderimport.js');
  assert.ok(/onOrder:[\s\S]{0,400}?C\.oiPostRunState\(r/.test(ui), 'onOrder 안에서 oiPostRunState 호출');
  assert.ok(/async function saveLedger\(\)[\s\S]{0,300}?sget\(\{ \[KEY_LEDGER\]/.test(ui), '장부는 저장 직전에 다시 읽어 병합');
  assert.ok(/if \(ch\[KEY_MAP\]\) \{ S\.map = ch\[KEY_MAP\]\.newValue \|\| \{\};/.test(ui), '매핑표 변경은 실행 중에도 대입');
  assert.ok(!/ch\[KEY_MAP\] && !S\.running/.test(ui), '실행 중 매핑표 변경을 버리는 옛 조건이 남아 있다');
});

//  Fable 5 F2 (2026-09-15): 실행 중에도 검토 표의 선택·검색·매핑 지우기가 살아 있어 enrich/검색 GET 이 실행기의 sKey GET→POST 사이에 끼어들 수 있었다.
test('UI 배선: 실행 중에는 onClick/onChange/enrich 가 조작을 받지 않고 줄·마켓·매핑표 컨트롤이 disabled 다', () => {
  const ui = read('src/orderimport.js');
  assert.ok(/async function onClick\(e\) \{[\s\S]{0,200}?if \(S\.running && act !== 'close' && act !== 'export-log' && act !== 'export-map'\) return;/.test(ui), 'onClick 실행 중 게이트');
  assert.ok(/async function onChange\(e\) \{\s*if \(S\.running\) return;/.test(ui), 'onChange 실행 중 게이트');
  assert.ok(/async function enrich\(\) \{\s*if \(S\.running\) return;/.test(ui), 'enrich 실행 중 게이트');
  //  Fable 5 G1 (2026-09-15): 진입 게이트만으론 파일 로드 직후 진행 중인 enrich 가 실행 시작 뒤에도 요청을 보냈다 → 진행 중 프라미스 대기 + 루프 내 게이트.
  assert.ok(/S\.enriching = p; render\(\);/.test(ui), 'enrich 가 진행 중 프라미스를 S.enriching 에 잡는다');
  assert.ok(/if \(S\.enriching\) \{ try \{ await S\.enriching; \} catch \(_\) \{\} \}\s*\/\/[^\n]*\n\s*S\.running = true;/.test(ui), 'run() 은 진행 중 enrich 를 기다린 뒤 running 을 세운다');
  const body = ui.slice(ui.indexOf('async function enrichBody()'), ui.indexOf('/* ------------------------------------------------------------ 실행 */'));
  const awaits = (body.match(/await E\./g) || []).length, gates = (body.match(/if \(S\.running\) return;/g) || []).length;
  assert.equal(awaits, 4, 'enrichBody 의 ERP 요청 수'); assert.equal(gates, 4, 'ERP 요청마다 실행 중 게이트');
  assert.ok(ui.includes(`data-act="run"' + (nChk && !S.running && !S.enriching && S.enabled ? '' : ' disabled')`), '조회 중엔 실행 버튼 잠금');
  assert.ok(/function lineRow\(o, oi, l, li\) \{\s*const dis = S\.running \? ' disabled' : '';/.test(ui), 'lineRow dis');
  for (const frag of ['data-f="pick" data-o="\' + oi + \'" data-l="\' + li + \'"\' + dis + \'>', 'data-act="unmap" data-o="\' + oi + \'" data-l="\' + li + \'" title="매핑 지우기"\' + dis + \'>',
    'data-act="search" data-o="\' + oi + \'" data-l="\' + li + \'"\' + dis + \'>', 'value="\' + esc(v == null ? \'\' : v) + \'"\' + dis + \'>\'', 'data-act="mkt-apply" data-o="\' + oi + \'"\' + dis + \'>',
    'id="ub-oi-mapfile" accept=".json" hidden\' + (S.running ? \' disabled\' : \'\') + \'>'])
    assert.ok(ui.includes(frag), '실행 중 disabled 누락: ' + frag);
  assert.ok(/await saveMap\(\); S\.orders\.forEach\(refreshOrder\); await enrich\(\); render\(\);\s*\/\/ 새로 매핑된 줄/.test(ui), 'importMap 뒤 enrich(Fable F5)');
});

test('core 는 ISOLATED 에서 globalThis.ubOi, node 에서 module.exports 로 같은 api 를 낸다', () => {
  const core = read('src/orderimport-core.js');
  assert.ok(core.includes('globalThis.ubOi = api;'));
  const api = require(path.join(ROOT, 'src', 'orderimport-core.js'));
  for (const n of ['oiParseRows', 'oiGroupOrders', 'oiReadWriteForm', 'oiReadForm10', 'oiLinePayload', 'oiForm10Payload', 'oiRunOrder', 'oiRunAll', 'oiPostRunState'])
    assert.equal(typeof api[n], 'function', n);
});
