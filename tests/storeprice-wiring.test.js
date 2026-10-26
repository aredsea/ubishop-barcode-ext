/* =============================================================================
 *  storeprice-wiring.test.js — 매장 제품 가격 변경 배선 구조 회귀테스트(소스 문자열 대상).
 *  UI·어댑터는 브라우저 API 가 필요해 node 로 돌릴 수 없으므로 "어디서 싣고, 무엇을 부르고, 무엇을 안 하는가" 를 고정한다.
 *  실행: node --test tests/storeprice-wiring.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const UI = read('src/storeprice.js');
const ERP = read('src/storeprice-erp.js');

test('manifest: infoItemList 에만 ISOLATED 로, erp → orderimport-core → core → erp → UI 순서', () => {
  const m = JSON.parse(read('manifest.json'));
  const cs = m.content_scripts.filter((c) => c.js.includes('src/storeprice.js'));
  assert.equal(cs.length, 1);
  assert.deepEqual(cs[0].js, ['src/erp.js', 'src/orderimport-core.js', 'src/storeprice-core.js', 'src/storeprice-erp.js', 'src/storeprice.js']);
  assert.equal(cs[0].world, 'ISOLATED');
  assert.equal(cs[0].all_frames, false);
  assert.deepEqual(cs[0].matches.map((u) => u.replace(/^https?:\/\/ubdstore\.ubshop\.biz/, '')), ['/info/item/infoItemList.do*', '/info/item/infoItemList.do*']);
});

test('UI 는 서버를 직접 부르지 않고 core 실행기·erp.lookup 만 쓴다', () => {
  assert.ok(!/\bfetch\(/.test(UI), 'UI 에 fetch 없음');
  assert.ok(!/E\.(deleteDeliv|savePrice|redeliver|verifyPrice|verifyRedeliv|findVoucherItem)\(/.test(UI), 'UI 는 쓰기 함수를 직접 부르지 않는다');
  assert.ok(/C\.spRunAll\(pending, S\.price, E, \{ limit: n,/.test(UI), '실행은 spRunAll 로');
  assert.ok(/E\.lookup\(it\.barcode\)/.test(UI), '조회는 lookup');
});

test('시범 1건 → 나머지: trial 은 run(1), rest 는 run(null)', () => {
  assert.ok(UI.includes("else if (act === 'trial') run(1);"));
  assert.ok(UI.includes("else if (act === 'rest') run(null);"));
  assert.ok(UI.includes("S.phase === 'ready' && nGo && !nDone"), '시범 버튼은 처리 전에만');
});

test('스킨모드(ubSkin) 꺼짐이면 버튼을 그리지 않는다', () => {
  assert.ok(/if \(!S\.enabled\) \{ const b = document\.getElementById\(BTN_ID\); if \(b\) b\.remove\(\); return; \}/.test(UI));
});

test('스킨모드 꺼짐이면 실행 중이 아닌 패널은 그리지 않고, 조회 루프도 멈춘다', () => {
  assert.ok(/function render\(\) \{\s*let p = document\.getElementById\(PANEL_ID\);[\s\S]{0,200}?if \(!S\.enabled && !S\.running\) \{ if \(p\) p\.remove\(\); return; \}/.test(UI));
  assert.ok(/for \(const it of S\.items\) \{\s*if \(!S\.enabled\) return;/.test(UI));
});

test('erp: 수정 저장은 iframe 실제 폼(fetch 직렬화 금지) · 저장 버튼은 form 소속 대조', () => {
  assert.ok(!/inputItemModify\.do/.test(ERP), 'inputItemModify.do 로 직접 POST 하지 않는다');
  assert.ok(/querySelectorAll\('input\[name="imageField22"\]'\)\]\.find\(\(b\) => b\.form === f\)/.test(ERP));
  assert.ok(/window\.alert=function/.test(ERP), 'iframe alert 를 막는다');
});

test('erp: 재출고는 spRedelivPairs(printFlag=0) 로만 보낸다', () => {
  const at = ERP.indexOf('async function redeliver(target) {');
  const b = ERP.slice(at, ERP.indexOf('\n  }\n', at));
  assert.ok(/S\.spRedelivPairs\(g\.html, target\)/.test(b));
  assert.ok(/post\('\/deliv\/item\/delivItemWrite\.do\?tcode=deliv_item', pairs, null\)/.test(b));
  assert.ok(!/printFlag/.test(b), 'redeliver 안에서 printFlag 를 따로 만지지 않는다(core 가 0 으로 고정)');
  //  2단계: 대기 목록이 비어야 올리고, 올린 뒤 정확히 [그 바코드] 일 때만 [출고하기](form10)
  const iEmpty = b.indexOf('if (g.list.length) return');
  const iAdd = b.indexOf("post('/deliv/item/delivItemWrite.do");
  const iExact = b.indexOf("after.list.length !== 1 || after.list[0] !== target.barcode");
  const iDone = b.indexOf("post('/jun/delivitem/delivItemJunWrite.do?tcode=deliv_item', c.pairs, null)");
  assert.ok(iEmpty > 0 && iAdd > iEmpty && iExact > iAdd && iDone > iExact, '순서: 빈 목록 확인 → 올리기 → 정확히 1건 확인 → 출고하기');
  assert.ok(/S\.spCompletePairs\(after\.html, new Date\(\)\)/.test(b));
});

test('erp: 대기 목록은 listFlag=1 로 받고, 삭제 전에 비어 있는지 본다', () => {
  assert.ok(ERP.includes("const WRITE_FORM_LIST = WRITE_FORM + '&listFlag=1';"));
  const at = ERP.indexOf('async function deleteDeliv(target) {');
  const b = ERP.slice(at, ERP.indexOf('\n  }\n', at));
  const iPend = b.indexOf('pend = await pendingNow()');
  const iPost = b.indexOf("post('/jun/delivitem/delivItemDelete.do");
  assert.ok(iPend > 0 && iPost > iPend, '대기 목록 확인이 삭제 요청보다 먼저');
  assert.ok(/if \(pend\.list === null\) return \{ ok: false/.test(b) && /if \(pend\.list\.length\) return \{ ok: false/.test(b));
});

test('erp: 삭제 전 재조회로 같은 행인지 확인하고, 삭제 뒤 사라졌는지 본다', () => {
  const at = ERP.indexOf('async function deleteDeliv(target) {');
  const b = ERP.slice(at, ERP.indexOf('\n  }\n', at));
  assert.ok(/cur\.idx !== target\.idx/.test(b));
  assert.ok(/after\.rows\.some\(\(x\) => x\.idx === target\.idx\)/.test(b));
});

test('금액 ±5%·10% 버튼: data-act=step → stepPrice → C.spStepPrice, 조회 뒤(잠금)에는 비활성', () => {
  assert.ok(UI.includes('const STEPS = [-10, -5, 5, 10];'));
  assert.ok(UI.includes("if (act === 'step') stepPrice(Number(b.dataset.pct));"));
  const at = UI.indexOf('function stepPrice(pct) {');
  const b = UI.slice(at, UI.indexOf('\n  }\n', at));
  assert.ok(/if \(!el \|\| el\.disabled\) return;/.test(b), '잠긴 입력칸은 안 바꾼다');
  assert.ok(/C\.spStepPrice\(n, pct\)/.test(b) && /el\.value = C\.spComma\(v\);/.test(b));
  assert.ok(/data-act="step" data-pct="' \+ s \+ '"' \+ \(locked \? ' disabled' : ''\)/.test(UI), '잠금이면 버튼도 disabled');
});
