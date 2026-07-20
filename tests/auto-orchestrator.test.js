/* =============================================================================
 *  auto-orchestrator.test.js — 자동화 오케스트레이터(Phase 0) 안전 경계.
 *
 *  background.js / skin.js 는 SW·content script IIFE 라 require 할 수 없다.
 *  → orderitem-assign.test.js 와 같은 방식으로 소스에서 선언을 추출해 평가한다.
 *    추출 실패(리네임)면 즉시 죽으므로 조용한 드리프트가 안 생긴다.
 *
 *  두 종류를 섞어 쓴다:
 *    ① 정적 가드 — 위치·순서·허용목록처럼 '코드 모양'이 곧 안전인 것
 *    ② 동작 검증 — chrome.scripting 과 sender 를 목으로 세워 실제로 돌려보는 것
 *       (정적 검사만 두면 검증 순서를 바꿔도 통과한다 — 실제로 그 지적을 받았다)
 *
 *  ⚠ 이 파일을 PowerShell 로 편집하지 마라. Set-Content -Encoding utf8 이 BOM 을 붙이고
 *    Get-Content -Raw 가 cp949 로 읽어 한글을 통째로 깨뜨린다(실제로 당했다).
 *
 *  스펙: docs/superpowers/specs/2026-07-20-orderitem-batch-design.md §3.2·§3.3
 *  실행: node tests/auto-orchestrator.test.js
 * ========================================================================== */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BG = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
const SKIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'skin.js'), 'utf8');

function extractFn(src, name, where) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `${where} 에서 ${name} 선언을 찾지 못했습니다 (리네임 여부 확인)`);
  // ⚠ async 를 놓치면 본문의 await 이 SyntaxError 가 된다. 앞의 'async ' 를 같이 집는다.
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 본문의 중괄호 균형을 찾지 못했습니다`);
}

// const NAME = ... ; 를 괄호 균형으로 잘라낸다.
function extractConst(src, name, where) {
  const m = new RegExp('const\\s+' + name + '\\s*=').exec(src);
  assert.ok(m, `${where} 에서 ${name} 상수를 찾지 못했습니다`);
  let depth = 0;
  for (let i = m.index; i < src.length; i++) {
    const c = src[i];
    if (c === '[' || c === '{' || c === '(') depth++;
    else if (c === ']' || c === '}' || c === ')') depth--;
    else if (c === ';' && depth === 0) return src.slice(m.index, i + 1);
  }
  throw new Error(`${name} 선언의 끝을 찾지 못했습니다`);
}

const BG_CONSTS = ['UB_AUTO_ORIGINS', 'UB_AUTO_CONTROLLER_PATH', 'UB_AUTO_IDLE_TTL_MS',
                   'UB_AUTO_HARD_TTL_MS', 'UB_AUTO_MAX_RESULTS', 'UB_AUTO_OPS',
                   'UB_AUTO_SPIKE_STEPS', 'ubAutoJobs', 'ubAutoLog'];
const BG_FNS = ['ubAutoNewId', 'ubAutoParse', 'ubAutoExpired', 'ubAutoCheckController',
                'ubAutoCreateJob', 'ubAutoEndJob', 'ubAutoVerdict', 'ubAutoRecord',
                'ubAutoOnFrameReady', 'ubAutoBadInjection', 'UB_AUTO_READ_FACTS'];

const bg = {};
const fakeChrome = { scripting: { executeScript: null } };
// eslint-disable-next-line no-new-func
new Function('exports', 'chrome', 'crypto', 'console',
  BG_CONSTS.map(n => extractConst(BG, n, 'background.js')).join('\n') + '\n' +
  BG_FNS.map(n => extractFn(BG, n, 'background.js')).join('\n') + '\n' +
  [...BG_CONSTS, ...BG_FNS].map(n => `exports.${n} = ${n};`).join('\n')
)(bg, fakeChrome, { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = i; return a; } },
  { log: () => {} });

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ---------- 목 헬퍼 ---------- */
const TAB = 7;
const CTRL_DOC = 'doc-controller';
const ctrlSender = (over) => Object.assign({
  tab: { id: TAB }, frameId: 0, documentId: CTRL_DOC,
  url: 'http://ubdstore.ubshop.biz/jun/orderitem/orderItemList.do?tcode=order_item'
}, over || {});

// 목 주입이 '그 문서가 실제로 어느 페이지인지'를 알아야 facts.path 검증을 재현할 수 있다.
const DOC_PATH = new Map();
const workerSender = (docId, url, over) => {
  if (docId) DOC_PATH.set(docId, url);
  return Object.assign({
    tab: { id: TAB }, frameId: 3, documentId: docId,
    url: 'http://ubdstore.ubshop.biz' + url
  }, over || {});
};

function goodFacts(p) {
  return { path: p, charset: 'UTF-8', readyState: 'complete', hasForm1: true, hasForm3: true,
    hasStandby: true, hasSetCurrent: false, idxCount: 3, checkedCount: 0,
    setCurrentLinks: 0, statusColIdx: 12, tListRows: 5, hasPasswordInput: false };
}
function mockInject() {
  fakeChrome.scripting.executeScript = async ({ target }) => {
    const docId = target.documentIds[0];
    return [{ documentId: docId, frameId: 3, result: goodFacts(DOC_PATH.get(docId)) }];
  };
}
function freshJob() {
  bg.ubAutoJobs.clear();
  const r = bg.ubAutoCreateJob({ feature: 'spike' }, ctrlSender());
  assert.ok(r.ok, 'job 생성 실패: ' + JSON.stringify(r));
  return r.jobId;
}

/* ---------- ① 정적 가드 ---------- */

test('ubAutoParse 는 origin/path 를 분리하고 파싱 불가엔 null (fail closed)', () => {
  const r = bg.ubAutoParse('http://ubdstore.ubshop.biz/jun/orderitem/orderItemList.do?tcode=x');
  assert.equal(r.origin, 'http://ubdstore.ubshop.biz');
  assert.equal(r.path, '/jun/orderitem/orderItemList.do');
  assert.equal(bg.ubAutoParse(''), null);
  assert.equal(bg.ubAutoParse('not a url'), null);
});

test('비슷하게 생긴 origin 은 통과하지 못한다', () => {
  for (const bad of ['https://ubdstore.ubshop.biz.evil.com/x',
                     'https://evil.com/ubdstore.ubshop.biz',
                     'https://honsu114.com/mall/main.ubs']) {
    const p = bg.ubAutoParse(bad);
    assert.ok(p && !bg.UB_AUTO_ORIGINS.includes(p.origin), bad + ' 의 origin 이 허용되면 안 된다');
  }
});

test('★쓰기 엔드포인트는 어떤 operation 허용경로에도 없다', () => {
  const WRITE = ['/jun/orderitem/orderItemPopCurrentSettingModify.do',
                 '/jun/orderitem/orderItemPopCurrentSettingCancel.do',
                 '/jun/orderitem/orderItemStandby.do',
                 '/jun/orderitem/orderItemModify.do'];
  for (const [op, spec] of Object.entries(bg.UB_AUTO_OPS)) {
    for (const w of WRITE) assert.ok(!spec.paths.includes(w), `${op} 허용경로에 쓰기 ${w}`);
  }
});

test('읽기용 …ModifyForm.do 와 쓰기용 …Modify.do 를 구분한다 (한 글자 차이)', () => {
  const paths = new Set(Object.values(bg.UB_AUTO_OPS).flatMap(s => s.paths));
  assert.ok(paths.has('/jun/orderitem/orderItemPopCurrentSettingModifyForm.do'));
  assert.ok(!paths.has('/jun/orderitem/orderItemPopCurrentSettingModify.do'));
});

test('Phase 0 은 operation 이 READ_PAGE_FACTS 하나뿐이고 전부 exact path 다', () => {
  assert.deepStrictEqual(Object.keys(bg.UB_AUTO_OPS), ['READ_PAGE_FACTS']);
  for (const [op, spec] of Object.entries(bg.UB_AUTO_OPS)) {
    assert.equal(spec.write, false, op + ' 가 write:true');
    for (const p of spec.paths) {
      assert.ok(p.startsWith('/') && !p.includes('?') && !p.includes('*'), op + ' 경로 ' + p);
    }
  }
});

test('MAIN 주입 함수는 고정 함수이며 부작용 호출이 없다', () => {
  const src = extractFn(BG, 'UB_AUTO_READ_FACTS', 'background.js');
  for (const bad of ['fetch(', 'location =', 'location.href', '.submit(', '.click(', 'XMLHttpRequest', 'window.open']) {
    assert.ok(!src.includes(bad), 'MAIN 함수에 부작용 호출: ' + bad);
  }
  assert.ok(!/\bfunction\s+UB_AUTO_READ_FACTS\s*\([^)]+\)/.test(src),
    'MAIN 함수가 인자를 받는다 — 범용 page reader 가 된다');
});

test('프레임 가드는 URL 이 아니라 frameElement.dataset 을 본다', () => {
  const g = SKIN.match(/const\s+UB_AUTO_JOB\s*=\s*\(\(\)\s*=>\s*\{[\s\S]*?\}\)\(\);/);
  assert.ok(g, 'UB_AUTO_JOB 가드를 찾지 못했습니다');
  assert.ok(/frameElement/.test(g[0]) && /dataset/.test(g[0]));
  assert.ok(!/location\.search|URLSearchParams|location\.href/.test(g[0]),
    '가드가 URL 을 본다 — navigation 후 소실된다(ubasg 함정 재발)');
  assert.ok(/try\s*\{/.test(g[0]) && /catch/.test(g[0]), 'cross-origin 접근 throw 를 감싸지 않았다');
});

test('프레임 가드가 pageSize redirect 보다 앞에 있다', () => {
  const g = SKIN.indexOf('const UB_AUTO_JOB');
  const e = SKIN.indexOf('function ensurePageSizeAtStart');
  assert.ok(g >= 0 && e >= 0 && g < e,
    '가드가 늦다 — ensurePageSizeAtStart 는 document_start 에 location.replace 를 부른다');
});

test('자동화 프레임이면 즉시 return 하고 나머지 UI 가 실행되지 않는다', () => {
  const i = SKIN.indexOf('if (UB_AUTO_JOB) {');
  assert.ok(i >= 0, 'UB_AUTO_JOB 분기 없음');
  const dIdx = SKIN.indexOf('const D = {');
  assert.ok(dIdx > i, '가드가 D 선언보다 뒤에 있다');
  // 줄 시작 4칸 = outer 들여쓰기. 중첩 함수 안의 return 은 더 깊어서 걸리지 않는다.
  assert.ok(/^ {4}return;/m.test(SKIN.slice(i, dIdx)), '분기 안에 outer return 이 없다');
});

test('iframe 은 dataset → src → append 순서로 만든다', () => {
  const fn = extractFn(SKIN, 'autoSpikeFrame', 'skin.js');
  const ds = fn.indexOf('dataset.ubAutoJob'), sr = fn.search(/\.src\s*=/), ap = fn.search(/appendChild|\.append\(/);
  assert.ok(ds >= 0 && sr >= 0 && ap >= 0);
  assert.ok(ds < sr, 'src 가 dataset 보다 먼저다 — content script 가 가드 없이 먼저 돈다');
  assert.ok(sr < ap);
});

test('★스파이크 URL 은 상수 화이트리스트이고 런타임에서 쓰기 경로를 차단한다', () => {
  const urls = extractConst(SKIN, 'AUTO_SPIKE_URLS', 'skin.js');
  for (const bad of ['CurrentSettingModify.do', 'orderItemStandby.do', 'CurrentSettingCancel.do']) {
    assert.ok(!urls.includes(bad), '스파이크 URL 상수에 쓰기 경로: ' + bad);
  }
  assert.ok(urls.includes('ModifyForm.do'), '읽기용 수정폼이 빠졌다');
  const fn = extractFn(SKIN, 'autoSpikeUrl', 'skin.js');
  assert.ok(/AUTO_WRITE_MARKERS/.test(fn), 'autoSpikeUrl 에 런타임 쓰기 차단이 없다');
  const decl = extractConst(SKIN, 'AUTO_WRITE_MARKERS', 'skin.js');
  const lit = decl.match(/=\s*\/(.+)\/([a-z]*)\s*;/);
  assert.ok(lit, 'AUTO_WRITE_MARKERS 가 정규식 리터럴이 아니다');
  const re = new RegExp(lit[1], lit[2]);
  assert.ok(re.test('/jun/orderitem/orderItemPopCurrentSettingModify.do?x=1'), '쓰기 URL 을 못 잡는다');
  assert.ok(re.test('/jun/orderitem/orderItemStandby.do?x=1'), 'standby URL 을 못 잡는다');
  assert.ok(!re.test('/jun/orderitem/orderItemPopCurrentSettingModifyForm.do?x=1'), '읽기 URL 을 잘못 잡는다');
  assert.ok(!re.test('/jun/orderitem/orderItemModifyForm.do?x=1'), '읽기 수정폼을 잘못 잡는다');
});

test('스파이크는 기본 OFF · 1회성 · top frame 전용이다', () => {
  const fn = extractFn(SKIN, 'initAutoSpike', 'skin.js');
  assert.ok(/sessionStorage/.test(fn) && /removeItem/.test(fn) && /window !== window\.top/.test(fn));
});

/* ---------- ② 동작 검증 (목) ---------- */

test('컨트롤러는 top frame·허용경로·feature=spike 여야 job 을 만들 수 있다', () => {
  bg.ubAutoJobs.clear();
  assert.equal(bg.ubAutoCreateJob({ feature: 'spike' }, ctrlSender({ frameId: 3 })).error, 'controller_must_be_top');
  assert.equal(bg.ubAutoCreateJob({ feature: 'spike' }, ctrlSender({ documentId: null })).error, 'no_document_id');
  assert.equal(bg.ubAutoCreateJob({ feature: 'spike' }, ctrlSender({ url: 'https://evil.com/x' })).error, 'bad_origin');
  assert.equal(bg.ubAutoCreateJob({ feature: 'spike' },
    ctrlSender({ url: 'http://ubdstore.ubshop.biz/info/item/infoItemList.do' })).error, 'controller_path_not_allowed');
  assert.equal(bg.ubAutoCreateJob({ feature: 'anything' }, ctrlSender()).error, 'feature_not_allowed');
  assert.ok(bg.ubAutoCreateJob({ feature: 'spike' }, ctrlSender()).ok);
});

test('탭당 job 은 하나뿐이다', () => {
  freshJob();
  assert.equal(bg.ubAutoCreateJob({ feature: 'spike' }, ctrlSender()).error, 'job_already_running');
});

test('★jobId 만 알아도 다른 프레임이 job 을 끝내지 못한다', () => {
  const jobId = freshJob();
  assert.equal(bg.ubAutoEndJob(jobId, 'x', workerSender('d1', '/jun/orderitem/orderItemList.do')).error, 'not_controller_frame');
  assert.equal(bg.ubAutoEndJob(jobId, 'x', ctrlSender({ documentId: 'other' })).error, 'controller_document_mismatch');
  assert.equal(bg.ubAutoEndJob(jobId, 'x', ctrlSender({ tab: { id: 999 } })).error, 'tab_mismatch');
  assert.ok(bg.ubAutoEndJob(jobId, 'x', ctrlSender()).ok, '정상 컨트롤러는 끝낼 수 있어야 한다');
});

test('★worker 슬롯은 경로 검증을 통과한 뒤에야 고정된다', async () => {
  const jobId = freshJob();
  mockInject();
  // 엉뚱한 경로로 먼저 온 프레임(페이지 스크립트가 dataset 을 심은 경우)은 슬롯을 못 가져간다.
  const bad = await bg.ubAutoOnFrameReady({ jobId }, workerSender('dX', '/info/item/infoItemList.do', { frameId: 99 }));
  assert.equal(bad.error, 'unexpected_path');
  assert.equal(bg.ubAutoJobs.get(jobId).workerFrameId, null, '검증 실패인데 슬롯이 잡혔다');
  const ok = await bg.ubAutoOnFrameReady({ jobId }, workerSender('d1', '/jun/orderitem/orderItemList.do'));
  assert.ok(ok.ok, '정상 첫 단계가 실패했다: ' + JSON.stringify(ok));
  assert.equal(bg.ubAutoJobs.get(jobId).workerFrameId, 3);
});

test('★같은 문서의 READY 재전송(DOMContentLoaded+load)은 두 번 실행되지 않는다', async () => {
  const jobId = freshJob();
  let calls = 0;
  const s = workerSender('d1', '/jun/orderitem/orderItemList.do');
  fakeChrome.scripting.executeScript = async ({ target }) => {
    calls++;
    return [{ documentId: target.documentIds[0], frameId: 3, result: goodFacts(DOC_PATH.get(target.documentIds[0])) }];
  };
  assert.ok((await bg.ubAutoOnFrameReady({ jobId, phase: 'dom' }, s)).ok);
  assert.equal((await bg.ubAutoOnFrameReady({ jobId, phase: 'load' }, s)).error, 'duplicate_ready');
  assert.equal(calls, 1, '같은 문서에서 RPC 가 두 번 실행됐다 — 쓰기였다면 중복 쓰기다');
});

test('★허용목록 밖 경로는 path_not_allowed 로 거부되고 그 사실이 기록된다', async () => {
  const jobId = freshJob();
  mockInject();
  await bg.ubAutoOnFrameReady({ jobId }, workerSender('d1', '/jun/orderitem/orderItemList.do'));
  await bg.ubAutoOnFrameReady({ jobId }, workerSender('d2', '/jun/orderitem/orderItemModifyForm.do'));
  const denied = await bg.ubAutoOnFrameReady({ jobId }, workerSender('d3', '/info/item/infoItemList.do'));
  assert.equal(denied.error, 'path_not_allowed');
  const rec = bg.ubAutoJobs.get(jobId).results.find(r => r.stepKey === 'denied');
  assert.ok(rec, '거부가 결과에 기록되지 않았다 — 관찰 불가능하면 증명이 아니다');
  assert.equal(rec.outcome, 'rejected');
});

test('★빈/다른 문서/스키마 불일치 주입은 성공으로 세지 않는다', () => {
  const s = { documentId: 'd1', frameId: 3 };
  const P = '/jun/orderitem/orderItemList.do';
  assert.equal(bg.ubAutoBadInjection(null, s, P), 'injection_not_array');
  assert.equal(bg.ubAutoBadInjection([], s, P), 'injection_count_0');
  assert.equal(bg.ubAutoBadInjection([{ documentId: 'other', frameId: 3, result: goodFacts(P) }], s, P), 'injection_document_mismatch');
  assert.equal(bg.ubAutoBadInjection([{ documentId: 'd1', frameId: 9, result: goodFacts(P) }], s, P), 'injection_frame_mismatch');
  // ★누락도 실패여야 한다. "있으면 비교"로 두면 필드가 없는 결과가 통과해
  //   '정확한 문서에 주입됐다'는 Phase 0 의 핵심 주장이 false positive 가 된다.
  assert.equal(bg.ubAutoBadInjection([{ frameId: 3, result: goodFacts(P) }], s, P), 'injection_no_document_id');
  assert.equal(bg.ubAutoBadInjection([{ documentId: 'd1', result: goodFacts(P) }], s, P), 'injection_no_frame_id');
  assert.equal(bg.ubAutoBadInjection([{ documentId: 'd1', frameId: 3, result: null }], s, P), 'facts_not_object');
  assert.equal(bg.ubAutoBadInjection([{ documentId: 'd1', frameId: 3, result: goodFacts('/other') }], s, P), 'facts_path_mismatch');
  const missing = goodFacts(P); delete missing.hasStandby;
  assert.equal(bg.ubAutoBadInjection([{ documentId: 'd1', frameId: 3, result: missing }], s, P), 'facts_schema_hasStandby');
  assert.equal(bg.ubAutoBadInjection([{ documentId: 'd1', frameId: 3, result: goodFacts(P) }], s, P), null);
});

test('★같은 문서를 재사용하면 다음 단계가 진행되지 않고 판정도 FAIL 이다', async () => {
  const jobId = freshJob();
  mockInject();
  assert.ok((await bg.ubAutoOnFrameReady({ jobId }, workerSender('same', '/jun/orderitem/orderItemList.do'))).ok);
  // navigation 이 실제로 안 일어났으면 documentId 가 그대로다 → 다음 단계로 넘어가면 안 된다.
  const second = await bg.ubAutoOnFrameReady({ jobId }, workerSender('same', '/jun/orderitem/orderItemModifyForm.do'));
  assert.equal(second.error, 'duplicate_ready', '같은 문서인데 다음 단계가 실행됐다');
  const v = bg.ubAutoEndJob(jobId, 'test', ctrlSender()).verdict;
  assert.equal(v.pass, false, '재-handshake 를 증명하지 못했는데 PASS 다');
  assert.equal(v.documentIds, 1);
});

test('판정은 성공 단계가 2개 미만이면 재-handshake 미증명으로 FAIL 이다', async () => {
  const jobId = freshJob();
  mockInject();
  await bg.ubAutoOnFrameReady({ jobId }, workerSender('d1', '/jun/orderitem/orderItemList.do'));
  const v = bg.ubAutoEndJob(jobId, 'test', ctrlSender()).verdict;
  assert.equal(v.pass, false);
  assert.ok(v.reasons.some(r => /재-handshake/.test(r)), v.reasons.join(' / '));
});

test('전 단계가 기대대로면 PASS 다', async () => {
  const jobId = freshJob();
  mockInject();
  await bg.ubAutoOnFrameReady({ jobId }, workerSender('d1', '/jun/orderitem/orderItemList.do'));
  await bg.ubAutoOnFrameReady({ jobId }, workerSender('d2', '/jun/orderitem/orderItemModifyForm.do'));
  await bg.ubAutoOnFrameReady({ jobId }, workerSender('d3', '/info/item/infoItemList.do'));
  const v = bg.ubAutoEndJob(jobId, 'test', ctrlSender()).verdict;
  assert.ok(v.pass, 'PASS 여야 하는데 FAIL: ' + v.reasons.join(' / '));
  assert.equal(v.frameIds, 1, '같은 worker 슬롯이어야 한다');
  assert.equal(v.documentIds, 2);
});

test('다른 탭·top frame·documentId 없는 worker 는 거부된다', async () => {
  const jobId = freshJob();
  mockInject();
  const P = '/jun/orderitem/orderItemList.do';
  assert.equal((await bg.ubAutoOnFrameReady({ jobId }, workerSender('d1', P, { tab: { id: 99 } }))).error, 'tab_mismatch');
  assert.equal((await bg.ubAutoOnFrameReady({ jobId }, workerSender('d1', P, { frameId: 0 }))).error, 'not_subframe');
  assert.equal((await bg.ubAutoOnFrameReady({ jobId }, workerSender(null, P))).error, 'no_document_id');
  assert.equal((await bg.ubAutoOnFrameReady({ jobId: 'nope' }, workerSender('d1', P))).error, 'unknown_job');
});

test('hard TTL 은 READY 반복으로 연장되지 않는다', () => {
  const now = Date.now();
  const job = { createdAt: now - (bg.UB_AUTO_HARD_TTL_MS + 1), lastActivity: now };
  assert.ok(bg.ubAutoExpired(job, now), 'lastActivity 가 최신이어도 hard TTL 이면 만료여야 한다');
});

let passed = 0;
(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); passed += 1; console.log('PASS', name); }
    catch (error) { console.error('FAIL', name); throw error; }
  }
  console.log(`PASS ${passed}/${tests.length} tests`);
})();
