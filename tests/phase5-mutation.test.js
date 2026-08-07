const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FSM = fs.readFileSync(path.join(__dirname, '..', 'src', 'fsm.js'), 'utf8');
const BG = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `${name} 선언을 찾지 못했습니다`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} 본문의 끝을 찾지 못했습니다`);
}

function replaceExactlyOnce(source, from, to) {
  assert.equal(source.includes(from), true, `변이 대상 내용을 찾지 못했습니다: ${from}`);
  const changed = source.replace(from, to);
  assert.equal(changed.includes(from), false, `변이 대상 내용이 둘 이상 남았습니다: ${from}`);
  assert.equal(changed.includes(to), true, `변이 내용이 반영되지 않았습니다: ${to}`);
  return changed;
}

function loadFsm(source) {
  const module = { exports: {} };
  new Function('module', 'exports', source)(module, module.exports);
  return module.exports;
}

function fullProbe(patch) {
  return {
    host: 'www.honsu114.com', url: 'https://www.honsu114.com/mall/main.ubs', path: '/mall/main.ubs',
    hasForm: false, hasLogout: false, hasPms: false, pmsHref: null, captcha: false,
    loginName: '', ambiguous: false, ...(patch || {})
  };
}

test('변이: logout_no_effect를 nav_timeout으로 되돌리면 전용 실패 코드 검증이 죽는다', () => {
  const mutant = replaceExactlyOnce(
    FSM,
    "if (probe.hasLogout) return expired ? fsmFail('logout_no_effect') : { action: 'wait' };",
    "if (probe.hasLogout) return expired ? fsmFail('nav_timeout') : { action: 'wait' };"
  );
  const { decide, DEADLINE } = loadFsm(mutant);
  const flow = { phase: 'loggingOut', enteredAt: 0, startedAt: 0, attempts: {}, accountId: 'B', submittedFor: null };
  const result = decide(flow, fullProbe({ hasLogout: true, loginName: 'A' }), DEADLINE.loggingOut + 1);
  assert.throws(() => assert.equal(result.failureCode, 'logout_no_effect'));
});

test('변이: 로그아웃 앵커 click 폴백을 제거하면 1회 click 검증이 죽는다', () => {
  const source = extractFn(BG, 'UB_DO_LOGOUT');
  const mutant = replaceExactlyOnce(source, '      a.click();', '      /* mutation: a.click() removed */');
  let clicks = 0;
  const anchor = {
    textContent: '로그아웃',
    getAttribute: () => "javascript:link('logout');",
    click() { clicks += 1; }
  };
  const document = { querySelectorAll: () => [anchor] };
  const location = { href: 'https://www.honsu114.com/mall/main.ubs' };
  new Function('document', 'location', 'link', mutant + '\nreturn UB_DO_LOGOUT();')(document, location, undefined);
  assert.throws(() => assert.equal(clicks, 1));
});

class FakeElement {
  constructor() { this.id = ''; this.children = []; this.parentNode = null; this.attributes = {}; this.style = {}; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] || null; }
  addEventListener() {}
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
}

function fakeDocument() {
  const body = new FakeElement();
  const find = (node, id) => {
    if (node.id === id) return node;
    for (const child of node.children) { const found = find(child, id); if (found) return found; }
    return null;
  };
  return { body, documentElement: body, createElement: () => new FakeElement(), getElementById: id => find(body, id) };
}

function count(node, id) {
  return (node.id === id ? 1 : 0) + node.children.reduce((sum, child) => sum + count(child, id), 0);
}

test('변이: 오버레이 멱등 가드를 제거하면 요소 1개 검증이 죽는다', () => {
  const source = extractFn(BG, 'UB_SWITCH_OVERLAY');
  const mutant = replaceExactlyOnce(source, '  if (!root) {', '  { /* mutation: idempotency guard removed */');
  const document = fakeDocument();
  const inject = new Function('document', 'setInterval', 'Date', mutant + '\nreturn UB_SWITCH_OVERLAY;')(
    document, () => 1, { now: () => 1000 }
  );
  const state = { phase: 'start', startedAt: 0, targetAlias: 'B' };
  inject(state);
  inject(state);
  assert.throws(() => assert.equal(count(document.body, 'ub-switch-overlay'), 1));
});
