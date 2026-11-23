/* =============================================================================
 *  masteredit.test.js — 기초상품관리 상품 수정 화면(4.5.7)의 순수 헬퍼 + 배선.
 *  실행: node --test tests/masteredit.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const M = require('../src/masteredit.js');

test('fitView — 상자 안에 통째로, 가운데, 원본보다 키우지 않음', () => {
  const v = M.fitView(1000, 862, 500, 600, 16);
  assert.ok(Math.abs(v.s - 0.468) < 1e-9);
  assert.ok(Math.abs(v.x - 16) < 1e-9);
  assert.ok(Math.abs(v.y - (600 - 862 * 0.468) / 2) < 1e-9);
  const small = M.fitView(200, 100, 800, 800, 16);
  assert.equal(small.s, 1, '작은 이미지는 1배');
  assert.deepEqual(M.fitView(0, 0, 500, 500), { s: 1, x: 0, y: 0 }, '크기 모르면 안전값');
});

test('zoomAt — 지정 지점이 화면에서 움직이지 않는다', () => {
  const v0 = { s: 0.5, x: 30, y: 40 };
  const cx = 210, cy = 170;
  const imgPx = (cx - v0.x) / v0.s, imgPy = (cy - v0.y) / v0.s;
  const v1 = M.zoomAt(v0, 3, cx, cy);
  assert.ok(Math.abs(v1.x + imgPx * v1.s - cx) < 1e-9);
  assert.ok(Math.abs(v1.y + imgPy * v1.s - cy) < 1e-9);
  assert.equal(M.zoomAt({ s: 7, x: 0, y: 0 }, 10, 0, 0).s, M.MAX_SCALE, '상한');
  assert.equal(M.zoomAt({ s: 0.06, x: 0, y: 0 }, 0.01, 0, 0).s, M.MIN_SCALE, '하한');
});

test('parseMasterCode / pctLabel', () => {
  assert.equal(M.parseMasterCode('기초상품관리 마스터상품코드 : D-R2-Q-WP-DA-01ID 등록일 2026'), 'D-R2-Q-WP-DA-01ID');
  assert.equal(M.parseMasterCode('코드 없음'), '');
  assert.equal(M.pctLabel(0.4567), '46%');
});

test('배선 — manifest 가 수정 화면에만 top frame 으로 싣고, skin.js 가 사이드바를 억제', () => {
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const cs = man.content_scripts.find((c) => c.js.includes('src/masteredit.js'));
  assert.ok(cs, 'content_scripts 등록');
  assert.equal(cs.all_frames, false, '숨은 iframe(적용시세 일괄변경)에는 싣지 않는다');
  assert.ok(cs.matches.every((m) => /masterItemModifyForm\.do/.test(m)));
  const skin = fs.readFileSync(path.join(ROOT, 'src/skin.js'), 'utf8');
  assert.match(skin, /if \(_IS_POPUP \|\| _IS_EP_FRAME \|\| _IS_MASTER_EDIT\)/);
  assert.match(skin, /window\.open\(editUrl\(seq\), 'ubEdit_' \+ seq, masterEditFeatures\(\)\)/);
});

test('목록 [수정] 아이콘 — 같은 탭 이동 대신 팝업 창(4.5.8)', () => {
  const skin = fs.readFileSync(path.join(ROOT, 'src/skin.js'), 'utf8');
  assert.match(skin, /function bindListModifyPopup\(\)/);
  assert.match(skin, /closest\('a\[href\^="javascript:modify\("\]'\)/);
  assert.match(skin, /window\.open\(editUrl\(m\[1\]\), 'ubEdit_' \+ m\[1\], masterEditFeatures\(\)\)/);
  assert.match(skin, /bindThumbEdit\(root\) \{\s*if \(!MASTER_RE\.test\(location\.pathname\)\) return;\s*bindListModifyPopup\(\);/);
});

test('4.5.9 — 유비샵 메뉴 상시 숨김(버튼 없음) · 상품 확대 기본 접힘 · hidden 이 display 에 지지 않음', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/masteredit.js'), 'utf8');
  assert.doesNotMatch(src, /ubme-erp-toggle/, '유비샵 메뉴 펼치기 버튼 없음');
  assert.match(src, /erpBox\.hidden = true;/);
  assert.match(src, /<section id="ubme-viewer" aria-label="상품 이미지" hidden>/, '확대 기본 접힘');
  assert.match(src, /id="ubme-view-toggle"/);
  assert.match(src, /#ubme-viewer\[hidden\], #ubme-viewer \[hidden\] \{ display: none !important; \}/);
});

test('4.6.0 — windowPlan: 접힘=폼 폭, 펼침=+간격+패널, 화면 밖이면 자르고 왼쪽으로', () => {
  const base = { formW: 998, chromeW: 16, scrollW: 0, availLeft: 0, availWidth: 2560, screenX: 100 };
  assert.deepEqual(M.windowPlan({ ...base, open: false }), { w: 1046, x: 100 });
  assert.deepEqual(M.windowPlan({ ...base, open: true }), { w: 1046 + 16 + M.VIEW_W, x: 100 });
  assert.deepEqual(M.windowPlan({ ...base, open: true, screenX: 1800 }), { w: 1622, x: 2560 - 1622 }, '오른쪽 끝을 넘으면 왼쪽으로');
  assert.deepEqual(M.windowPlan({ ...base, open: true, availWidth: 1280, screenX: 0 }), { w: 1280, x: 0 }, '화면보다 넓으면 화면 폭');
  assert.equal(M.windowPlan({ ...base, formW: 0, open: true }), null, '폼 폭 모르면 손대지 않음');
  const src = fs.readFileSync(path.join(ROOT, 'src/masteredit.js'), 'utf8');
  assert.match(src, /fitWindow\(open\);\s*\};/, 'setView 가 창 크기도 맞춘다');
  assert.match(src, /fitWindow\(false\);/, '처음엔 접힌 폭');
});
