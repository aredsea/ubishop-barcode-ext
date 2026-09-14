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
  const buf = Buffer.from(fs.readFileSync(path.join(ROOT, 'vendor/xlsx.full.min.js'), 'latin1').replace(/
/g, '
'), 'latin1');
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
  assert.ok(erp.includes('globalThis.ubOiErp = { state, searchClient, searchMaster, registerClient, getWriteForm, postLine, getForm10, postComplete, deleteLines, findJunNums };'));
  const ui = read('src/orderimport.js');
  assert.ok(ui.includes("closest('#ub-oi-open')"), 'UI 는 사이드바 버튼을 문서 위임으로 받는다');
  assert.ok(ui.includes("type: 'ubOiInjectXls'"));
  assert.ok(ui.includes("source: 'ub-oi', type: 'parse'"));
  const xls = read('src/orderimport-xls.js');
  assert.ok(xls.includes("d.source !== 'ub-oi' || d.type !== 'parse'"));
  assert.ok(xls.includes("source: 'ub-oi-xls'"));
});

test('core 는 ISOLATED 에서 globalThis.ubOi, node 에서 module.exports 로 같은 api 를 낸다', () => {
  const core = read('src/orderimport-core.js');
  assert.ok(core.includes('globalThis.ubOi = api;'));
  const api = require(path.join(ROOT, 'src', 'orderimport-core.js'));
  for (const n of ['oiParseRows', 'oiGroupOrders', 'oiReadWriteForm', 'oiReadForm10', 'oiLinePayload', 'oiForm10Payload', 'oiRunOrder', 'oiRunAll'])
    assert.equal(typeof api[n], 'function', n);
});
