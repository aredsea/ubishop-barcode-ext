const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

function runLogout({ linkFn, anchors, initialHref = 'https://www.honsu114.com/mall/main.ubs' }) {
  const location = { href: initialHref };
  const document = { querySelectorAll: () => anchors || [] };
  const fn = new Function('document', 'location', 'link', extractFn(BG, 'UB_DO_LOGOUT') + '\nreturn UB_DO_LOGOUT();');
  return { result: fn(document, location, linkFn && (() => linkFn(location))), location };
}

test('UB_DO_LOGOUT은 link가 실제 URL을 바꾸면 구조화된 link 결과를 돌려준다', () => {
  const { result } = runLogout({ linkFn(location) { location.href = 'https://www.honsu114.com/mall/logout.ubs'; } });
  assert.deepEqual(result, {
    via: 'link', navigated: true, href: 'https://www.honsu114.com/mall/logout.ubs'
  });
});

test('UB_DO_LOGOUT은 link가 없으면 로그아웃 앵커를 정확히 한 번 click한다', () => {
  let clicks = 0;
  const anchor = {
    textContent: '로그아웃',
    getAttribute(name) { return name === 'href' ? "javascript:link('logout');" : ''; },
    click() { clicks += 1; }
  };
  const { result } = runLogout({ anchors: [anchor] });
  assert.equal(clicks, 1);
  assert.equal(result.via, 'href');
  assert.equal(result.navigated, false);
  assert.equal(result.href, "javascript:link('logout');");
});

test('UB_DO_LOGOUT은 link와 로그아웃 앵커가 모두 없으면 via none을 돌려준다', () => {
  const { result } = runLogout({ anchors: [] });
  assert.deepEqual(result, { via: 'none', navigated: false, href: '' });
});

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.id = '';
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.textContent = '';
    this.listeners = {};
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] || null; }
  addEventListener(type, listener) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }
  click() { for (const listener of this.listeners.click || []) listener(); }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
}

function makeFakeDocument() {
  const body = new FakeElement('body');
  const find = (node, id) => {
    if (node.id === id) return node;
    for (const child of node.children) {
      const match = find(child, id);
      if (match) return match;
    }
    return null;
  };
  return {
    body,
    documentElement: body,
    createElement(tagName) { return new FakeElement(tagName); },
    getElementById(id) { return find(body, id); }
  };
}

function countById(node, id) {
  return (node.id === id ? 1 : 0) + node.children.reduce((sum, child) => sum + countById(child, id), 0);
}

test('오버레이 주입은 두 번 실행해도 고정 id 요소를 하나만 만든다', () => {
  const document = makeFakeDocument();
  const timers = [];
  const fakeDate = { now: () => 30000 };
  const fn = new Function('document', 'setInterval', 'Date', extractFn(BG, 'UB_SWITCH_OVERLAY') + '\nreturn UB_SWITCH_OVERLAY;')(
    document, (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, fakeDate
  );
  const state = { phase: 'loggingOut', startedAt: 0, targetAlias: '쇼핑몰 B', flowId: 'flow-1' };
  fn(state);
  fn({ ...state, phase: 'toLogin' });
  assert.equal(countById(document.body, 'ub-switch-overlay'), 1);
  assert.equal(timers.length, 1);
  assert.equal(document.getElementById('ub-switch-overlay-title').textContent, '로그인 화면으로 이동 중 · 30초 경과');
  assert.equal(document.getElementById('ub-switch-overlay-slow').style.display, 'block');
});

test('오버레이 두 버튼은 source ub의 취소 메시지를 보내고 직접 로그인은 카드를 즉시 숨긴다', () => {
  const document = makeFakeDocument();
  const inject = new Function('document', 'setInterval', 'Date', extractFn(BG, 'UB_SWITCH_OVERLAY') + '\nreturn UB_SWITCH_OVERLAY;')(
    document, () => 1, { now: () => 1000 }
  );
  inject({ phase: 'start', startedAt: 0, targetAlias: 'B', flowId: 'flow-1' });
  const messages = [];
  const chrome = { runtime: { sendMessage(message) { messages.push(message); return Promise.resolve(); } } };
  const bind = new Function('document', 'chrome', extractFn(BG, 'UB_BIND_SWITCH_OVERLAY') + '\nreturn UB_BIND_SWITCH_OVERLAY;')(
    document, chrome
  );
  bind('flow-1');
  document.getElementById('ub-switch-overlay-cancel').click();
  document.getElementById('ub-switch-overlay-manual').click();
  assert.deepEqual(messages, [
    { source: 'ub', type: 'ubCancelSwitch', flowId: 'flow-1', mode: 'cancel' },
    { source: 'ub', type: 'ubCancelSwitch', flowId: 'flow-1', mode: 'manual' }
  ]);
  assert.equal(document.getElementById('ub-switch-overlay').style.display, 'none');
});
