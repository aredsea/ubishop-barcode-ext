/* =============================================================================
 *  stock-recent.test.js — 재고화 바코드 보관함(2026-08-18) 순수 헬퍼 단위테스트.
 *
 *  skin.js 는 content script IIFE 라 require 할 수 없다.
 *  → 소스에서 DOM·chrome 비의존 함수 선언만 이름으로 추출해 샌드박스에서 평가한다.
 *    추출 실패(리네임/시그니처 변경) 시 즉시 죽으므로 조용한 드리프트가 안 생긴다.
 *
 *  대상: 재고화 조회에 성공한 바코드를 모아뒀다가 재고배정 팝업
 *       (orderItemPopCurrentSettingModifyForm.do)에서 그 행을 강조·스크롤하는 기능의
 *       판정부. 부작용(chrome.storage 읽기·쓰기)은 여기서 다루지 않는다.
 *
 *  실행: node tests/stock-recent.test.js
 * ========================================================================== */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'skin.js'), 'utf8');

// function NAME( ... ) { ... } 를 중괄호 균형으로 잘라낸다.
function extractFn(src, name) {
  const kw = src.indexOf('function ' + name + '(');
  assert.ok(kw >= 0, `skin.js 에서 ${name} 선언을 찾지 못했습니다 (리네임 여부 확인)`);
  // ★`async ` 접두를 반드시 같이 잘라낸다. 안 그러면 async 함수가 일반 함수로 추출되어
  //  본문의 await 가 SyntaxError 를 낸다 — 기능이 멀쩡한데 테스트만 죽는 가짜 실패다.
  const start = (src.slice(kw - 6, kw) === 'async ') ? kw - 6 : kw;
  const open = src.indexOf('{', kw);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 본문의 중괄호 균형을 찾지 못했습니다`);
}

const NAMES = ['stkNorm', 'stkRecentNormalize', 'stkRecentPut', 'stkPickHighlight'];

// 보관 한도는 사장님이 정한 정책값이다(최근 50개 · 7일). 소스에서 읽어 와 테스트가 정책 변경을
//  따라가게 하되, 값 자체도 한 번 못 박는다 — 실수로 바뀌면 테스트가 알려주게.
const MAX_SRC = SRC.match(/const\s+STK_RECENT_MAX\s*=\s*(\d+)\s*;/);
assert.ok(MAX_SRC, 'skin.js 에서 STK_RECENT_MAX 를 찾지 못했습니다');
const STK_RECENT_MAX = Number(MAX_SRC[1]);

const TTL_SRC = SRC.match(/const\s+STK_RECENT_TTL\s*=\s*([^;]+);/);
assert.ok(TTL_SRC, 'skin.js 에서 STK_RECENT_TTL 을 찾지 못했습니다');
// eslint-disable-next-line no-new-func
const STK_RECENT_TTL = new Function('return (' + TTL_SRC[1] + ')')();
assert.strictEqual(STK_RECENT_MAX, 50, '보관 개수 정책이 50개가 아닙니다');
assert.strictEqual(STK_RECENT_TTL, 7 * 24 * 60 * 60 * 1000, '보관 기간 정책이 7일이 아닙니다');

const sandbox = {};
// eslint-disable-next-line no-new-func
new Function('exports', 'STK_RECENT_MAX', 'STK_RECENT_TTL',
  NAMES.map(n => extractFn(SRC, n)).join('\n') + '\n' +
  NAMES.map(n => `exports.${n} = ${n};`).join('\n')
)(sandbox, STK_RECENT_MAX, STK_RECENT_TTL);

const { stkNorm, stkRecentNormalize, stkRecentPut, stkPickHighlight } = sandbox;

const NOW = 1800000000000;
const DAY = 24 * 60 * 60 * 1000;
const codes = (list) => list.map((e) => e.bc);

let pass = 0;
const t = (name, fn) => { queue.push(async () => { await fn(); pass++; console.log('  ok  ' + name); }); };
const queue = [];

console.log('stkNorm — 대소문자 어긋남이 강조를 조용히 죽이지 않게');
t('소문자 입력을 대문자로 정규화 (실측: 2607dl → 목록 2607DL)', () => {
  assert.strictEqual(stkNorm('2607dl'), '2607DL');
});
t('앞뒤 공백 제거', () => {
  assert.strictEqual(stkNorm('  2606WH \n'), '2606WH');
});
t('null·undefined·숫자도 문자열로 안전 처리', () => {
  assert.strictEqual(stkNorm(null), '');
  assert.strictEqual(stkNorm(undefined), '');
  assert.strictEqual(stkNorm(260881), '260881');
});

console.log('stkRecentNormalize — 만료·중복·초과분 정리');
t('TTL 을 넘긴 항목은 사라진다', () => {
  const out = stkRecentNormalize([
    { bc: 'AAA', ts: NOW - 1000 },
    { bc: 'BBB', ts: NOW - STK_RECENT_TTL - 1 }
  ], NOW);
  assert.deepStrictEqual(codes(out), ['AAA']);
});
t('TTL 경계는 남긴다 (딱 7일은 아직 유효)', () => {
  const out = stkRecentNormalize([{ bc: 'AAA', ts: NOW - STK_RECENT_TTL }], NOW);
  assert.deepStrictEqual(codes(out), ['AAA']);
});
t('최신순으로 정렬한다 (팝업 스크롤 기준이 여기서 나온다)', () => {
  const out = stkRecentNormalize([
    { bc: 'OLD', ts: NOW - 3 * DAY },
    { bc: 'NEW', ts: NOW - 1000 },
    { bc: 'MID', ts: NOW - DAY }
  ], NOW);
  assert.deepStrictEqual(codes(out), ['NEW', 'MID', 'OLD']);
});
t('같은 바코드가 겹치면 최신 기록이 남는다 (정렬을 중복제거보다 먼저 하는 이유)', () => {
  const out = stkRecentNormalize([
    { bc: 'AAA', ts: NOW - 5 * DAY },   // 옛 기록이 배열 앞에 있어도
    { bc: 'AAA', ts: NOW - 1000 }       // 최신 것이 이겨야 한다
  ], NOW);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].ts, NOW - 1000);
});
t('대소문자만 다른 중복도 하나로 합친다', () => {
  const out = stkRecentNormalize([{ bc: '2607dl', ts: NOW }, { bc: '2607DL', ts: NOW - 1000 }], NOW);
  assert.deepStrictEqual(codes(out), ['2607DL']);
});
t('보관 개수를 넘으면 오래된 것부터 밀려난다', () => {
  const many = [];
  for (let i = 0; i < STK_RECENT_MAX + 5; i++) many.push({ bc: 'BC' + i, ts: NOW - i * 1000 });
  const out = stkRecentNormalize(many, NOW);
  assert.strictEqual(out.length, STK_RECENT_MAX);
  assert.strictEqual(out[0].bc, 'BC0');                              // 가장 최근
  assert.strictEqual(out[out.length - 1].bc, 'BC' + (STK_RECENT_MAX - 1));
});
t('배열이 아니거나 원소가 깨져도 살릴 수 있는 것만 살린다 (fail-soft)', () => {
  assert.deepStrictEqual(stkRecentNormalize(null, NOW), []);
  assert.deepStrictEqual(stkRecentNormalize('garbage', NOW), []);
  const out = stkRecentNormalize([null, { bc: '' }, { bc: 'AAA', ts: NOW }, { ts: NOW }, 42], NOW);
  assert.deepStrictEqual(codes(out), ['AAA']);
});
t('now 가 숫자가 아니면 만료 판정을 건너뛴다 (지우는 쪽보다 남기는 쪽)', () => {
  const out = stkRecentNormalize([{ bc: 'AAA' }], null);
  assert.deepStrictEqual(codes(out), ['AAA']);
  assert.strictEqual(out[0].ts, 0);
});

console.log('stkRecentPut — 재고화 1건 보관');
t('새 바코드는 맨 앞(최신)에 들어간다', () => {
  const out = stkRecentPut([{ bc: 'OLD', ts: NOW - DAY }], '260881', NOW);
  assert.deepStrictEqual(codes(out), ['260881', 'OLD']);
});
t('소문자로 입력해도 대문자로 보관한다', () => {
  const out = stkRecentPut([], '2607dl', NOW);
  assert.deepStrictEqual(codes(out), ['2607DL']);
});
t('같은 바코드를 다시 재고화하면 중복이 아니라 시각이 갱신된다', () => {
  const first = stkRecentPut([], 'AAA', NOW - 2 * DAY);
  const out = stkRecentPut(first, 'aaa', NOW);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].ts, NOW);
});
t('빈 바코드는 넣지 않는다 (정리만 한다)', () => {
  const out = stkRecentPut([{ bc: 'AAA', ts: NOW }], '   ', NOW);
  assert.deepStrictEqual(codes(out), ['AAA']);
});

console.log('stkPickHighlight — 팝업에서 무엇을 강조하고 어디로 스크롤하나');
t('보관함과 화면 행의 교집합만 강조한다', () => {
  const r = stkPickHighlight(
    [{ bc: 'B', ts: 2 }, { bc: 'A', ts: 1 }],
    ['230MF4', 'A', '2405XS', 'B']
  );
  assert.deepStrictEqual(r.marks, ['B', 'A']);
});
t('스크롤 기준은 가장 최근 재고화한 것', () => {
  const r = stkPickHighlight([{ bc: 'NEW', ts: 2 }, { bc: 'OLD', ts: 1 }], ['OLD', 'NEW']);
  assert.strictEqual(r.focus, 'NEW');
});
t('가장 최근 것이 이 페이지에 없으면 그 다음으로 최근인 것으로 간다', () => {
  const r = stkPickHighlight(
    [{ bc: 'NOTHERE', ts: 3 }, { bc: 'SECOND', ts: 2 }, { bc: 'THIRD', ts: 1 }],
    ['THIRD', 'SECOND']
  );
  assert.strictEqual(r.focus, 'SECOND');
  assert.deepStrictEqual(r.marks, ['SECOND', 'THIRD']);
});
t('겹치는 게 없으면 아무것도 하지 않는다', () => {
  const r = stkPickHighlight([{ bc: 'AAA', ts: 1 }], ['230MF4', '2405XS']);
  assert.deepStrictEqual(r.marks, []);
  assert.strictEqual(r.focus, '');
});
t('보관함이 비었으면 빈 결과', () => {
  assert.deepStrictEqual(stkPickHighlight([], ['AAA']), { marks: [], focus: '' });
  assert.deepStrictEqual(stkPickHighlight(null, ['AAA']), { marks: [], focus: '' });
});
t('화면 행이 없으면(파싱 실패) 빈 결과 — 엉뚱한 강조 금지', () => {
  assert.deepStrictEqual(stkPickHighlight([{ bc: 'AAA', ts: 1 }], []), { marks: [], focus: '' });
  assert.deepStrictEqual(stkPickHighlight([{ bc: 'AAA', ts: 1 }], null), { marks: [], focus: '' });
});
t('행 바코드의 대소문자가 달라도 매칭된다', () => {
  const r = stkPickHighlight([{ bc: '2607DL', ts: 1 }], ['2607dl']);
  assert.deepStrictEqual(r.marks, ['2607DL']);
  assert.strictEqual(r.focus, '2607DL');
});

console.log('stkRecentAdd — 읽기 실패가 보관함을 지워버리지 않는가 (Opus 5 검수 F2)');
//  이 파일의 나머지 테스트와 달리 부작용 함수를 싣는다. 그래야 검수가 잡은 바로 그 회귀
//  ("읽기 실패 → 빈 배열로 읽힘 → 그 위에 덮어써서 기존 보관함이 통째로 날아감")를 고정할 수 있다.
//  chrome 은 스텁이고 실제 저장소는 건드리지 않는다.
const IO_NAMES = ['stkRecentLoad', 'stkRecentSave', 'stkRecentAdd'];
function makeIo(getImpl) {
  const calls = { sets: [] };
  const chromeStub = {
    runtime: {},
    storage: { local: {
      get: (key, cb) => getImpl(key, cb, chromeStub),
      set: (rec, cb) => { calls.sets.push(rec); chromeStub.runtime.lastError = undefined; cb(); }
    } }
  };
  const box = {};
  // eslint-disable-next-line no-new-func
  new Function('exports', 'chrome', 'stkLog', 'STK_RECENT_KEY', 'STK_RECENT_MAX', 'STK_RECENT_TTL',
    ['stkNorm', 'stkRecentNormalize', 'stkRecentPut'].concat(IO_NAMES).map(n => extractFn(SRC, n)).join('\n') +
    '\n' + IO_NAMES.map(n => `exports.${n} = ${n};`).join('\n')
  )(box, chromeStub, () => {}, 'ubStockRecent', STK_RECENT_MAX, STK_RECENT_TTL);
  return { api: box, calls: calls, chrome: chromeStub };
}

t('정상 읽기: 기존 항목을 보존한 채 새 바코드를 더한다', async () => {
  const io = makeIo((key, cb) => cb({ ubStockRecent: [{ bc: 'OLD', ts: Date.now() - 1000 }] }));
  await io.api.stkRecentAdd('NEW1');
  assert.strictEqual(io.calls.sets.length, 1, '정상 읽기면 저장해야 한다');
  assert.deepStrictEqual(io.calls.sets[0].ubStockRecent.map((e) => e.bc), ['NEW1', 'OLD']);
});
t('🔴 읽기 실패(lastError): 저장을 아예 하지 않는다 — 덮어쓰면 보관함이 날아간다', async () => {
  const io = makeIo((key, cb, ch) => { ch.runtime.lastError = { message: 'boom' }; cb(undefined); });
  await io.api.stkRecentAdd('NEW1');
  assert.strictEqual(io.calls.sets.length, 0, '읽기 실패인데 저장했다 — 기존 보관함을 갈아버린다');
});
t('🔴 읽기 예외(컨텍스트 무효화 등): 저장을 아예 하지 않는다', async () => {
  const io = makeIo(() => { throw new Error('Extension context invalidated'); });
  await io.api.stkRecentAdd('NEW1');
  assert.strictEqual(io.calls.sets.length, 0, '읽기 예외인데 저장했다');
});
t('빈 저장소(정말 비어 있음)는 실패가 아니다 — 정상적으로 저장한다', async () => {
  const io = makeIo((key, cb) => cb({}));
  await io.api.stkRecentAdd('NEW1');
  assert.strictEqual(io.calls.sets.length, 1);
  assert.deepStrictEqual(io.calls.sets[0].ubStockRecent.map((e) => e.bc), ['NEW1']);
});
t('빈 바코드는 읽지도 쓰지도 않는다', async () => {
  const io = makeIo((key, cb) => cb({}));
  await io.api.stkRecentAdd('   ');
  assert.strictEqual(io.calls.sets.length, 0);
});

console.log('HL_CSS 공유 배선 — 사이드바 화면과 팝업이 같은 규칙을 쓰는가');
// 강조 규칙을 SIDEBAR_CSS 밖으로 뺐다(팝업엔 사이드바가 없어 그 CSS 가 주입되지 않는다).
//  누가 SIDEBAR_CSS 안에 규칙을 되돌려 넣거나 참조를 지우면 한쪽만 조용히 강조가 죽는다.
//  이건 눈으로만 보이는 회귀라 테스트로 못 박는다.
const HL_CSS_SRC = SRC.match(/const\s+HL_CSS\s*=\s*`([\s\S]*?)`;/);
t('HL_CSS 상수가 존재하고 tr.ub-ms-hl 규칙을 담고 있다', () => {
  assert.ok(HL_CSS_SRC, 'skin.js 에서 HL_CSS 를 찾지 못했습니다');
  assert.match(HL_CSS_SRC[1], /tr\.ub-ms-hl\s*>\s*td\s*\{/);
  assert.match(HL_CSS_SRC[1], /@keyframes\s+ubMsHl/);
});
t('SIDEBAR_CSS 는 규칙을 복사하지 않고 HL_CSS 를 참조한다', () => {
  const sidebar = SRC.match(/const\s+SIDEBAR_CSS\s*=\s*`([\s\S]*?)`;/);
  assert.ok(sidebar, 'skin.js 에서 SIDEBAR_CSS 를 찾지 못했습니다');
  assert.ok(sidebar[1].includes('${HL_CSS}'), 'SIDEBAR_CSS 가 HL_CSS 를 참조하지 않습니다');
  assert.ok(!/tr\.ub-ms-hl\s*>\s*td\s*\{/.test(sidebar[1]),
    'SIDEBAR_CSS 안에 강조 규칙 사본이 되살아났습니다 (원본은 HL_CSS 하나여야 합니다)');
});
t('사이드바 없는 화면용 주입 함수가 HL_CSS 를 싣는다', () => {
  const fn = extractFn(SRC, 'ensureHlStyle');
  assert.match(fn, /textContent\s*=\s*HL_CSS/);
});

// t() 는 케이스를 큐에 담기만 한다 — chrome 스텁 테스트가 async 라 순서를 지키려면 여기서 몰아 돌린다.
//  ⚠ 실패는 그대로 던져 프로세스를 죽인다(exit≠0). 삼키면 "0 pass" 같은 조용한 초록불이 된다.
(async () => {
  for (const step of queue) await step();
  console.log(`\n${pass} pass`);
})().catch((e) => { console.error(e); process.exit(1); });
