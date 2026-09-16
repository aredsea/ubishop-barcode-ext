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
  assert.ok(/async function onClick\(e\) \{[\s\S]{0,200}?if \(\(S\.running \|\| S\.starting\) && act !== 'close' && act !== 'export-log' && act !== 'export-map'\) return;/.test(ui), 'onClick 실행 중 게이트');
  assert.ok(/async function onChange\(e\) \{\s*if \(S\.running \|\| S\.starting\) return;/.test(ui), 'onChange 실행 중 게이트');
  assert.ok(/async function enrich\(\) \{\s*if \(S\.running \|\| S\.starting\) return;/.test(ui), 'enrich 실행 중 게이트');
  //  Fable 5 G1 (2026-09-15): 진입 게이트만으론 파일 로드 직후 진행 중인 enrich 가 실행 시작 뒤에도 요청을 보냈다 → 진행 중 프라미스 대기 + 루프 내 게이트.
  assert.ok(/S\.enriching = p; render\(\);/.test(ui), 'enrich 가 진행 중 프라미스를 S.enriching 에 잡는다');
  assert.ok(/jobs = targets\.map\(toRunOrder\);[^\n]*\n\s*while \(S\.enriching\) \{ try \{ await S\.enriching; \} catch \(_\) \{\} \}\s*\/\/[^\n]*\n\s*S\.running = true;/.test(ui), 'run() 은 confirm 한 집합을 스냅샷한 뒤 진행 중 enrich 를 기다리고 running 을 세운다');
  assert.ok(ui.includes('await runTargets(jobs);') && ui.includes('await C.oiRunAll(jobs, E, {'), 'runTargets 는 대기 뒤 다시 거르지 않고 스냅샷을 실행한다(Fable F3 Nit)');
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

//  2026-09-16 사장님 제보: 직접 검색에 키워드를 치고 [검색]을 눌러도 반응이 없었다 — 검색칸 change 가 표 전체를 다시 그려
//  친 글자가 사라지고 클릭이 떨어져 나간 옛 버튼에 붙었다. Enter 처리도 없었다.
test('UI 배선: 직접 검색 — 검색칸 change 는 재렌더하지 않고, 클릭·Enter 가 같은 searchLine 을 부르며, 검색어·결과 안내가 렌더에 남는다', () => {
  const ui = read('src/orderimport.js');
  assert.ok(/if \(f === 'q'\) \{ l\.q = el\.value; return; \}\s*\/\/[^\n]*\n\s*if \(f === 'pick'\) \{/.test(ui), "onChange 가 'q' 를 재렌더 없이 끝낸다(pick 분기보다 먼저)");
  assert.ok(/else if \(act === 'search'\) await searchLine\(\+btn\.dataset\.o, \+btn\.dataset\.l, btn\.parentElement\.querySelector\('input\[data-f="q"\]'\)\);/.test(ui), '클릭 → searchLine');
  assert.ok(/function onKeydown\(e\) \{[\s\S]{0,300}?e\.key !== 'Enter'\) return;[\s\S]{0,200}?searchLine\(\+el\.dataset\.o, \+el\.dataset\.l, el\);/.test(ui), 'Enter → searchLine');
  assert.ok(/if \(S\.running \|\| S\.starting\) return;\s*searchLine\(/.test(ui), 'Enter 검색도 실행 중 게이트');
  assert.ok(ui.includes("p.addEventListener('keydown', onKeydown);"), '패널에 keydown 배선');
  assert.ok(ui.includes(`data-f="q" data-o="' + oi + '" data-l="' + li + '" value="' + esc(l.q || '') + '"' + dis + '>`), '검색어가 재렌더에 살아남는다');
  const fn = ui.slice(ui.indexOf('async function searchLine('), ui.indexOf('function onKeydown('));
  assert.ok(/l\.q = q;/.test(fn) && /E\.searchMaster\(q\.replace\(\/\\s\+\/g, ''\)\)/.test(fn), '검색어 보존 + 공백 제거 검색');
  assert.ok(/검색 결과 0건/.test(fn) && /검색 실패: /.test(fn), '0건·실패도 안내(무반응 금지)');
  assert.ok(/const note = \(!e && l\.searchNote\)/.test(ui) && ui.includes("'<td>' + prod + note + '</td><td>'"), '안내가 상품 셀에 렌더된다');
});

//  Luna 1R(2026-09-16): 소스 대조만으론 "빈 칸 + Enter 가 이전 검색어로 재검색" 같은 동작 회귀를 못 잡는다 → searchLine 을 잘라 실제로 돌린다.
function extractFn(src, name) {
  const kw = src.indexOf('function ' + name + '(');
  assert.ok(kw >= 0, 'orderimport.js 에서 ' + name + ' 선언을 찾지 못했습니다');
  const start = (src.slice(kw - 6, kw) === 'async ') ? kw - 6 : kw;
  const open = src.indexOf('{', kw);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(name + ' 본문의 중괄호 균형을 찾지 못했습니다');
}
test('searchLine 동작: 공백 제거해 검색·검색어 보존·0건 안내, 빈 칸이면 이전 검색어로 재검색하지 않는다', async () => {
  const ui = read('src/orderimport.js');
  const calls = []; let renders = 0;
  const E = { async searchMaster(q) { calls.push(q); return q === 'abc' ? [{ seq: '1', code: 'C', name: 'N' }] : []; } };
  const line = { q: '', suggest: null, suggestQuery: '', searchNote: '' };
  const S = { orders: [{ lines: [line] }], running: false, starting: false };
  const searchLine = new Function('S', 'E', 'render', extractFn(ui, 'searchLine') + '\nreturn searchLine;')(S, E, () => { renders++; });
  await searchLine(0, 0, { value: ' a bc ' });
  assert.deepStrictEqual(calls, ['abc'], '공백을 지워 보낸다');
  assert.equal(line.q, 'a bc', '친 검색어(trim)가 줄에 남는다');
  assert.equal(line.suggest.length, 1); assert.equal(line.suggestQuery, 'a bc');
  assert.ok(/1건/.test(line.searchNote));
  await searchLine(0, 0, { value: 'zzz' });
  assert.ok(/0건/.test(line.searchNote), '0건도 안내한다');
  const before = calls.length;
  await searchLine(0, 0, { value: '' });                      // 검색 뒤 칸을 비우고 Enter
  assert.equal(calls.length, before, '빈 칸이면 검색하지 않는다(이전 검색어 재사용 금지)');
  assert.equal(line.q, ''); assert.equal(line.searchNote, '');
  await searchLine(0, 0, null);                                // 입력칸 없이 호출(줄에 남은 검색어 사용) — q 가 비어 있으니 역시 검색 없음
  assert.equal(calls.length, before);
  E.searchMaster = async () => { throw new Error('boom'); };
  await searchLine(0, 0, { value: 'x' });
  assert.ok(/검색 실패: boom/.test(line.searchNote), '실패도 안내한다');
  assert.ok(renders >= 4, '검색 중·결과마다 다시 그린다');
});

//  Luna 2R(2026-09-16): 검색 A 진행 중 B 로 다시 검색하면 늦게 온 A 응답이 B 결과를 덮었다 → 줄 단위 세대 토큰.
test('searchLine 경합: 응답 순서가 뒤집혀도 마지막 검색어의 결과만 남고, 비운 뒤 온 옛 응답은 버린다', async () => {
  const ui = read('src/orderimport.js');
  const pending = {};
  const E = { searchMaster(q) { return new Promise((res) => { pending[q] = res; }); } };
  const line = { q: '', suggest: null, suggestQuery: '', searchNote: '' };
  const S = { orders: [{ lines: [line] }], running: false, starting: false };
  const searchLine = new Function('S', 'E', 'render', extractFn(ui, 'searchLine') + '\nreturn searchLine;')(S, E, () => {});
  const pA = searchLine(0, 0, { value: 'AAA' });
  const pB = searchLine(0, 0, { value: 'BBB' });
  pending.BBB([{ seq: '2', code: 'B', name: 'b' }]);   // B 가 먼저 도착
  await pB;
  assert.equal(line.suggestQuery, 'BBB'); assert.equal(line.suggest[0].code, 'B');
  pending.AAA([{ seq: '1', code: 'A', name: 'a' }]);   // A 가 늦게 도착 — 버려야 한다
  await pA;
  assert.equal(line.suggestQuery, 'BBB', '옛 응답이 새 결과를 덮었다');
  assert.equal(line.suggest[0].code, 'B');
  const pC = searchLine(0, 0, { value: 'CCC' });
  await searchLine(0, 0, { value: '' });                // 비움
  pending.CCC([{ seq: '3', code: 'C', name: 'c' }]);
  await pC;
  assert.equal(line.searchNote, '', '비운 뒤 온 옛 응답의 안내가 남으면 안 된다');
  assert.equal(line.suggestQuery, 'BBB', '비운 뒤 온 옛 응답이 목록을 바꾸면 안 된다');
});

test('core 는 ISOLATED 에서 globalThis.ubOi, node 에서 module.exports 로 같은 api 를 낸다', () => {
  const core = read('src/orderimport-core.js');
  assert.ok(core.includes('globalThis.ubOi = api;'));
  const api = require(path.join(ROOT, 'src', 'orderimport-core.js'));
  for (const n of ['oiParseRows', 'oiGroupOrders', 'oiReadWriteForm', 'oiReadForm10', 'oiLinePayload', 'oiForm10Payload', 'oiRunOrder', 'oiRunAll', 'oiPostRunState'])
    assert.equal(typeof api[n], 'function', n);
});
