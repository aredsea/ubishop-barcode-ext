/* =============================================================================
 *  baljuremark.test.js — 주문전표 '발주비고 정산 문구 지우기'(4.6.2) 순수 판정 + 배선.
 *  실행: node --test tests/baljuremark.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const B = require('../src/baljuremark.js');

test('brStrip — 정산 N 원만 지우고 나머지는 남긴다', () => {
  assert.deepEqual(B.brStrip('정산 756,124 원'), { text: '', changed: true });
  assert.deepEqual(B.brStrip('정산 0 원'), { text: '', changed: true });
  assert.deepEqual(B.brStrip('정산 1,731원'), { text: '', changed: true });
  assert.deepEqual(B.brStrip('정산 -2,000 원'), { text: '', changed: true });
  assert.deepEqual(B.brStrip('급함 정산 30,000 원'), { text: '급함', changed: true });
  assert.deepEqual(B.brStrip('정산 30,000 원\n각인 J♡S'), { text: '각인 J♡S', changed: true });
  assert.deepEqual(B.brStrip('각인 J♡S'), { text: '각인 J♡S', changed: false });
  assert.deepEqual(B.brStrip(''), { text: '', changed: false });
  assert.deepEqual(B.brStrip(null), { text: '', changed: false });
});

test('brStrip — 정산 뒤에 숫자·원이 아니면 건드리지 않는다', () => {
  assert.deepEqual(B.brStrip('정산 예정'), { text: '정산 예정', changed: false });
  assert.deepEqual(B.brStrip('정산금 확인'), { text: '정산금 확인', changed: false });
});

test('배선 — 주문전표 목록 top frame 에만 · 셸 목록 · 저장 칸은 remark(발주비고)만', () => {
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const cs = man.content_scripts.find((c) => c.js.includes('src/baljuremark.js'));
  assert.ok(cs);
  assert.ok(cs.matches.length === 2 && cs.matches.every((m) => /\/jun\/orderitem\/orderItemList\.do\*$/.test(m)));
  assert.equal(cs.all_frames, false);
  assert.equal(cs.world, 'ISOLATED');
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'shell-files.json'), 'utf8'));
  assert.ok(idx.files.some((f) => f.path === 'src/baljuremark.js'));
  assert.equal(idx.version, man.version);
  const src = fs.readFileSync(path.join(ROOT, 'src/baljuremark.js'), 'utf8');
  assert.doesNotMatch(src, /elements\[?['".]?shopRemark/, '주문비고(shopRemark)는 건드리지 않는다');
  assert.match(src, /f\.elements\.remark/);
  assert.match(src, /fr\.dataset\.ubAutoJob = 'ubbr_'/);
});
