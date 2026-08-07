/* =============================================================================
 *  acct-lookup.test.js — 계정 조회 규칙(ubMatchAccount) 회귀 테스트.
 *
 *  🔴 이 버그가 새어나간 이유가 "테스트가 없어서" 다(Sol 검수 지적 2026-08-05).
 *     계정 ID→userid 재조회 경로에 테스트가 하나도 없었다.
 *
 *  버그: 종전 규칙은 `a.id === id || normName(a.loginName || a.userid) === normName(id)`.
 *  loginName 이 있으면 userid 를 **아예 비교하지 않는다.** 그런데 startSwitch 는
 *  flow.accountId 에 userid 를 넣고, loginName 은 첫 전환 성공 뒤 저장된다.
 *  → 한 번 성공하면 그 다음부터 로그인 폼 단계의 재조회가 매번 실패한다.
 *  ("처음엔 되는데 그 뒤로 안 됨" 의 정체)
 *
 *  background.js 는 service worker 라 require 할 수 없다. 함수 선언을 이름으로 뽑아
 *  new Function 샌드박스에서 평가한다(masterprice.test.js 와 같은 방식).
 *
 *  실행: node tests/acct-lookup.test.js
 * ========================================================================== */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');

function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `background.js 에서 ${name} 선언을 찾지 못했습니다 (리네임 여부 확인)`);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 본문의 중괄호 균형을 찾지 못했습니다`);
}
const NORM_LINE = (SRC.match(/^const ubNormName = .*$/m) || [])[0];
assert.ok(NORM_LINE, 'ubNormName 정의를 찾지 못했습니다');

const box = {};
// eslint-disable-next-line no-new-func
new Function('exports',
  NORM_LINE + '\n' + extractFn(SRC, 'ubMatchAccount') + '\n' +
  'exports.ubNormName = ubNormName; exports.ubMatchAccount = ubMatchAccount;'
)(box);
const { ubMatchAccount } = box;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* 실제 데이터 모양(2026-08-05 사용자 저장소 실측):
 *   alias "홍해진" · userid "홍해진@디102"(8자) · loginName "홍해진"
 * loginName 과 userid 가 다르다 — 종전 규칙이 깨지는 바로 그 조건이다. */
const ACC = { id: 'a1b2c3d4e5', alias: '홍해진', userid: '홍해진@디102', loginName: '홍해진' };

test('생성 id 로 찾는다 (팝업이 보내는 값)', () => {
  assert.strictEqual(ubMatchAccount(ACC, 'a1b2c3d4e5'), true);
});
test('🔴 userid 로 찾는다 — loginName 이 저장돼 있어도 (이 버그의 핵심)', () => {
  assert.strictEqual(ubMatchAccount(ACC, '홍해진@디102'), true,
    'startSwitch 가 flow.accountId 에 userid 를 넣으므로 이게 되어야 전환이 끝까지 간다');
});
test('loginName 으로도 찾는다 (관측된 표시명으로 조회하는 경로)', () => {
  assert.strictEqual(ubMatchAccount(ACC, '홍해진'), true);
});
test('loginName 이 아직 없으면 userid 로 찾는다 (첫 전환)', () => {
  const fresh = { id: 'x1', userid: 'shop01@d102' };
  assert.strictEqual(ubMatchAccount(fresh, 'shop01@d102'), true);
});
test('공백·대소문자는 정규화해서 비교한다', () => {
  assert.strictEqual(ubMatchAccount({ id: 'x', userid: 'Shop01@D102' }, ' shop01@d102 '), true);
  assert.strictEqual(ubMatchAccount({ id: 'x', loginName: '쇼핑몰  01' }, '쇼핑몰 01'), true);
});
test('다른 계정은 찾지 않는다', () => {
  assert.strictEqual(ubMatchAccount(ACC, '쇼핑몰01@디102'), false);
  assert.strictEqual(ubMatchAccount(ACC, '쇼핑몰'), false);
});
test('빈 값은 아무거나 매칭하지 않는다 (loginName 없는 계정이 전부 걸리면 안 된다)', () => {
  const noLogin = { id: 'x1', userid: 'shop01@d102' };
  assert.strictEqual(ubMatchAccount(noLogin, ''), false);
  assert.strictEqual(ubMatchAccount(noLogin, null), false);
  assert.strictEqual(ubMatchAccount(noLogin, undefined), false);
});
test('계정이 null 이면 false (조회 실패를 예외로 만들지 않는다)', () => {
  assert.strictEqual(ubMatchAccount(null, 'x'), false);
});

let pass = 0, fail = 0;
for (const t of tests) {
  try { t.fn(); console.log('PASS ' + t.name); pass++; }
  catch (e) { console.error('FAIL ' + t.name); console.error(e.message); fail++; }
}
console.log(`\n${fail ? 'FAIL' : 'PASS'} ${pass}/${tests.length} tests`);
process.exit(fail ? 1 : 0);
