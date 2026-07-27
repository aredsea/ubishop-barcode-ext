// login-fill-safety.test.js — UB_FILL_LOGIN(계정전환 로그인 자동입력)의 fail-closed 불변식을
// 소스로 고정한다. UB_FILL_LOGIN 은 MAIN world 주입 함수(document/window/page-global login 사용)라
// node 유닛테스트가 불가하므로, erp-wiring.test.js 와 동일하게 소스 정적 검증으로 회귀를 막는다.
// 근거: 2026-07-22 Codex 공동검수 P1-2(제출 직전 재확정이 ID만·PW 누락) / P1-3(hasForm 은 제네릭
//       password 로도 true 인데 fill 은 정확명만 → 필드 불완전해도 제출).
// 실행: node tests/login-fill-safety.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const bg = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');

// UB_FILL_LOGIN 본문만 잘라낸다(다음 함수 직전까지).
const start = bg.indexOf('function UB_FILL_LOGIN');
assert.ok(start >= 0, 'UB_FILL_LOGIN 함수를 찾지 못했습니다');
const end = bg.indexOf('async function ubExec', start);
assert.ok(end > start, 'UB_FILL_LOGIN 본문 끝(ubExec 경계)을 찾지 못했습니다');
const body = bg.slice(start, end);

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

console.log('P1-3 — 정확명 필드가 불완전하면 제출하지 않는다(fail-closed)');
t('exact-named id·pw 존재+동일 form 게이트가 있다', () => {
  // idEl/pwEl 둘 다 없거나 form 이 다르면 조기 반환하는 가드.
  assert.ok(/if \(!idEl \|\| !pwEl/.test(body),
    'idEl/pwEl 존재 가드(if (!idEl || !pwEl ...))가 없습니다');
  assert.ok(/idEl\.form\s*!==\s*pwEl\.form|idEl\.form\s*===\s*pwEl\.form/.test(body),
    'id/pw 가 같은 form 소속인지 검사가 없습니다');
});

console.log('P1-2 — 제출 직전 id·pw 를 함께 재확정하고 read-back 으로 검증한다');
t('제출 직전 pw 를 재확정한다(ID 만 재확정하던 버그 제거)', () => {
  assert.ok(/nativeSet\.call\(pwEl, pw\)/.test(body),
    'pwEl 재확정(nativeSet.call(pwEl, pw))이 없습니다 — ID 만 재확정하면 자동완성이 되돌린 비번이 제출된다');
  assert.ok(/nativeSet\.call\(idEl, userid\)/.test(body),
    'idEl 재확정(nativeSet.call(idEl, userid))이 없습니다');
});
t('read-back(value===기대값)으로 okId·okPw 를 판정한다', () => {
  assert.ok(/idEl\.value === userid/.test(body), 'idEl read-back(idEl.value === userid)이 없습니다');
  assert.ok(/pwEl\.value === pw/.test(body), 'pwEl read-back(pwEl.value === pw)이 없습니다');
});

console.log('제출 게이트 — read-back 실패면 어떤 제출 경로도 호출하지 않는다');
t('okId && okPw read-back 게이트가 submit(login()/버튼/form.submit)보다 앞선다', () => {
  const gateIdx = body.search(/if \(!okId \|\| !okPw\)[\s\S]{0,120}?return/);
  const submitIdx = body.indexOf("typeof login === 'function'");
  assert.ok(gateIdx >= 0, 'read-back 실패 시 조기 반환 게이트(if (!okId || !okPw) ... return)가 없습니다');
  assert.ok(submitIdx >= 0, 'login() 제출 경로를 찾지 못했습니다');
  assert.ok(gateIdx < submitIdx, '제출 게이트가 login() 제출보다 뒤에 있습니다(제출 후 검사=무의미)');
});
t('반환에 submitted 플래그가 있다(호출부가 실제 제출 여부를 알 수 있게)', () => {
  assert.ok(/submitted:\s*(true|false)/.test(body), '반환 객체에 submitted 플래그가 없습니다');
});

console.log('비밀번호 값은 절대 로그하지 않는다(길이만)');
t('진단 로그는 pw 값이 아니라 길이(pwLen: String(pw).length)만 남긴다', () => {
  assert.ok(/pwLen:\s*String\(pw\)\.length/.test(body),
    '비밀번호는 pwLen: String(pw).length 형태로 길이만 로그해야 합니다');
});

console.log('\nlogin-fill-safety: ' + pass + ' pass');
