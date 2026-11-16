/* arrival-panel.test.js — 유비샵 페이지 안 '입고 지연' 메뉴·패널(src/arrival-panel.js) 정적 검사 + 순수 함수.
 * 실행: node --test tests/arrival-panel.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/arrival-panel.js'), 'utf8');
const P = require('../src/arrival-panel.js');

test('최상위 프레임 가드 + 스위치 확인 후에만 삽입', () => {
  assert.ok(/window\s*!==\s*window\.top/.test(SRC), 'top frame 가드');
  assert.ok(/if \(!state\.watch\) \{ closePanel\(\); removeMenu\(\); return; \}\s*\n\s*ensureMenu\(\)/.test(SRC), 'watch false 면 ensureMenu 전에 return');
  assert.ok(/ubArrivalWatch/.test(SRC));
});

test('innerHTML 은 상수 리터럴만(변수 대입 없음) · 네트워크 호출 없음 · 페이지 함수 호출 없음', () => {
  const lines = SRC.split('\n').filter((l) => /innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l));
  for (const l of lines) assert.ok(/\.innerHTML\s*=\s*'[^'+]*';/.test(l), '리터럴 아님: ' + l.trim());
  assert.ok(!/outerHTML|insertAdjacentHTML|document\.write/.test(SRC.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')));
  const code = SRC.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/.test(code), '네트워크 호출');
  assert.ok(!/infoItemView|javascript:|eval\(|new Function/.test(code), '페이지 함수/javascript: 사용');
});

test('메뉴 찾기 텍스트·href="#"', () => {
  assert.ok(/'본사매뉴얼'/.test(SRC) && /'상품상세검색'/.test(SRC));
  assert.ok(/a\.href\s*=\s*'#'/.test(SRC) && /preventDefault/.test(SRC));
  assert.ok(/f_green_note/.test(SRC) && /icon1\.gif/.test(SRC));
});

test('manifest · SHELL 목록에 등록', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const cs = m.content_scripts.find((c) => c.js.includes('src/skin.js'));
  assert.ok(cs && cs.all_frames === true);
  assert.deepStrictEqual(cs.js, ['src/skin.js', 'src/arrival-panel.js']);
  assert.ok(/'src\/arrival-panel\.js'/.test(fs.readFileSync(path.join(ROOT, 'build-shell-index.ps1'), 'utf8')));
  assert.ok(/'src\/arrival-panel\.js'/.test(fs.readFileSync(path.join(ROOT, 'tests/loader-integrity.test.js'), 'utf8')));
});

test('순수 함수 — 건수·머리·메모', () => {
  assert.equal(P.countSuffix(0), '');
  assert.equal(P.countSuffix(3), ' 3');
  assert.equal(P.delayCount(null), 0);
  assert.equal(P.delayCount({ items: [1, 2] }), 2);
  assert.equal(P.headText(true, { items: [1, 2, 3] }), '입고 지연 (FASHION · 14영업일 초과) 3건');
  assert.equal(P.headText(true, null), '입고 지연 (FASHION · 14영업일 초과)');
  assert.equal(P.metaText(null), '아직 확인한 적이 없습니다 — [지금 다시 확인]');
  assert.ok(/^마지막 확인 \d{4}-\d\d-\d\d \d\d:\d\d$/.test(P.metaText({ at: Date.now(), ok: true })));
  assert.ok(/직전 성공 결과/.test(P.metaText({ at: Date.now(), ok: false })));
  assert.equal(P.baljuCell({ stage: 'pre' }), '');
  assert.equal(P.baljuCell({ stage: 'post', baseFallback: true, baljuDate: '2026-11-01' }), '미확인');
  assert.equal(P.baljuCell({ stage: 'post', baljuDate: '2026-11-01' }), '2026-11-01');
});

test('순수 함수 — 상태 줄', () => {
  assert.deepStrictEqual(P.noteList({ ok: true, items: [] }, null), []);
  const login = P.noteList({ ok: false, error: 'login' }, null);
  assert.ok(login.length === 1 && login[0].warn && /로그인/.test(login[0].text));
  assert.ok(/구조를 읽지 못했습니다/.test(P.noteList({ ok: false, error: 'parse:x' }, null)[0].text));
  assert.ok(/연결하지 못했습니다/.test(P.noteList({ ok: false, error: 'net:x' }, null)[0].text));
  assert.ok(P.noteList({ ok: true, capped: true }, null)[0].warn);
  assert.ok(/공휴일/.test(P.noteList({ ok: true, holidaysOk: false }, null)[0].text));
  assert.ok(/아틀리에/.test(P.noteList({ ok: true }, { error: 'http_500' })[0].text));
});
