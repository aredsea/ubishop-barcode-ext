/* =============================================================================
 *  saleimport-wiring.test.js — 판매 처리 패널(src/saleimport.js) 배선 구조 회귀테스트(소스 문자열 대상).
 *  패널은 브라우저 API 가 필요해 node 로 실행할 수 없으므로 "겹침 검사가 어디서 호출되는가", "실행 결과가 어떻게 반영되는가",
 *  "지원 마켓 문구·erp 검색 판정이 어디서 오는가" 를 고정한다. 스펙 §10.7.
 *  실행: node --test tests/saleimport-wiring.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const UI = read('src/saleimport.js');

//  `  async function name(` 부터 같은 들여쓰기(2칸)의 닫는 `  }` 까지.
function body(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, head + ' 없음');
  const end = src.indexOf('\n  }\n', at);
  assert.ok(end > at, head + ' 끝을 못 찾음');
  return src.slice(at, end);
}

test('applyOverlaps(): matchEntry 에서 e.checked 가 정해진 직후 호출된다', () => {
  const b = body(UI, 'async function matchEntry(e) {');
  assert.ok(/e\.checked = m\.status === 'ok';\s*applyOverlaps\(\);/.test(b), 'matchEntry 는 e.checked 설정 뒤 applyOverlaps() 를 부른다');
  assert.equal((b.match(/applyOverlaps\(\)/g) || []).length, 1);
});

test('applyOverlaps(): run() 은 대상 계산 전에 한 번, 조회 대기 뒤 targets.every(entryReady) 와 함께 다시 부르고 그 뒤에 S.running 을 세운다', () => {
  const b = body(UI, 'async function run() {');
  const calls = [];
  const re = /applyOverlaps\(\)/g; let m;
  while ((m = re.exec(b))) calls.push(m.index);
  assert.equal(calls.length, 2, 'run() 안 applyOverlaps() 호출 수');
  const iTargets = b.indexOf('const targets = ');
  const iWait = b.indexOf('while (S.enriching)');
  const iEvery = b.indexOf('targets.every(entryReady)');
  const iRun = b.indexOf('S.running = true;');
  assert.ok(iTargets > 0 && iWait > 0 && iEvery > 0 && iRun > 0, '기준 문장 존재');
  assert.ok(calls[0] < iTargets, '첫 호출은 targets 계산 전');
  assert.ok(calls[1] > iWait && calls[1] < iEvery, '둘째 호출은 조회 대기 뒤 · every(entryReady) 앞');
  assert.ok(iEvery < iRun, 'every(entryReady) 확인 뒤에 S.running = true');
  assert.ok(/applyOverlaps\(\);[^\n]*\n\s*if \(!targets\.every\(entryReady\)\)/.test(b), '둘째 호출 바로 뒤에 every(entryReady) 판정');
});

test('applyOverlaps(): 정의 1 + 호출 3 — 다른 곳에서 부르지 않는다', () => {
  assert.equal((UI.match(/applyOverlaps\(\)/g) || []).length, 4);
  assert.ok(/function applyOverlaps\(\) \{\s*C\.slOverlaps\(S\.entries\)/.test(UI));
});

test('실행 결과: runPlans 가 C.slApplyResults 로 반영하고, entryReady 는 st=ok 만 통과시킨다(done 은 체크·실행 불가)', () => {
  const b = body(UI, 'async function runPlans(plans) {');
  assert.ok(/const results = await C\.slRunAll\(plans, E, \{[\s\S]*?\}\);\s*S\.results = results;/.test(b));
  assert.ok(/C\.slApplyResults\(S\.entries, results\);/.test(b), 'runPlans 는 결과를 slApplyResults 로 반영');
  assert.ok(b.indexOf('C.slApplyResults(S.entries, results);') < b.indexOf('await saveLedger();'), '반영은 장부 저장 앞');
  assert.ok(UI.includes("const entryReady = (e) => e.st === 'ok' && !!e.match && !!e.client;"), 'entryReady 는 st=ok 필수');
  //  체크 전체·개별·실행 대상은 모두 entryReady 로 거른다
  assert.ok(UI.includes("S.entries.forEach((en) => { en.checked = el.checked && entryReady(en); }); render(); return; }"), 'chkall 은 entryReady');
  assert.ok(UI.includes("en.checked = el.checked && entryReady(en); render(); return; }"), 'chk 는 entryReady');
  assert.ok(UI.includes("S.entries.filter((e) => e.checked && entryReady(e));"), 'run 대상은 entryReady');
});

test('erp.searchClient 는 core slSearchResult(잘림 판정 한 곳)를 쓴다', () => {
  const erp = read('src/saleimport-erp.js');
  assert.ok(/async function searchClient\(word\) \{[\s\S]*?return S\.slSearchResult\(r\.html\);/.test(erp));
  assert.ok(!/truncated:\s*rows\.length/.test(erp), 'erp 안에 잘림 판정 사본이 남아 있다');
});

test('지원 마켓 문구: 알 수 없는 양식 배너 · 빈 화면 안내 · 사이드바 섹션', () => {
  const LIST = 'GS샵 · 카페24 이니시스(신용카드) · SSG · 스마트스토어 · 쿠팡 · 퀸잇 · 아몬즈 · 에이블리';
  assert.ok(UI.includes("'알 수 없는 파일 양식 — 지원: " + LIST + "'"), '알 수 없는 양식 배너');
  assert.ok(UI.includes('지원: ' + LIST + ' — xlsx 를 선택하세요'), '파일 선택 안내');
  assert.ok(read('src/skin.js').includes(LIST + '. 파일 → 검토 → 판매 시작.'), '사이드바 섹션 문구');
});

test('manifest 버전 4.3.2 이상', () => {
  const [ma, mi, pa] = JSON.parse(read('manifest.json')).version.split('.').map(Number);
  assert.ok(ma > 4 || (ma === 4 && (mi > 3 || (mi === 3 && pa >= 2))), 'manifest version 4.3.2 이상');
});
