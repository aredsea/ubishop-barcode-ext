const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const skin = fs.readFileSync(path.join(ROOT, 'src/skin.js'), 'utf8');

test('skin.js — 작업C 함수 노출 · 패션 재고화 섹션(상품 재고화 바로 아래)', () => {
  assert.match(skin, /globalThis\.ubHqApi = \{ cFetchSKey, cDoStandby, fetchOrderRow, cExtractRowArgs, cFetchCandidates, cDoAssign \}/);
  assert.match(skin, /id="ub-fs-in"/);
  const a = skin.indexOf('<span>상품 재고화</span>'), b = skin.indexOf('<span>패션 상품 재고화</span>'), c = skin.indexOf('<span>출고취소 → 판매가 수정</span>');
  assert.ok(a > 0 && a < b && b < c, '순서: 상품 재고화 → 패션 → 출고취소');
  assert.match(skin, /globalThis\.ubFs\.open\(bc, setFsStatus\)/);
});
test('storeprice-erp — iframe 도우미 노출', () => {
  const sp = fs.readFileSync(path.join(ROOT, 'src/storeprice-erp.js'), 'utf8');
  assert.match(sp, /globalThis\.ubSpErp = \{[^}]*openFrame, loadFrame, waitLoad[^}]*\}/);
});

test('manifest — 상품입고 화면에만, ISOLATED, top frame, 의존 순서 · 셸 목록 · 버전', () => {
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const cs = man.content_scripts.find((c) => c.js.includes('src/fashionstock.js'));
  assert.ok(cs);
  assert.deepEqual(cs.js, ['src/erp.js', 'src/orderimport-core.js', 'src/arrival-core.js', 'src/storeprice-core.js', 'src/storeprice-erp.js', 'src/fashionstock-core.js', 'src/fashionstock-erp.js', 'src/fashionstock.js']);
  assert.ok(cs.matches.length === 2 && cs.matches.every((m) => /\/input\/item\/inputItemWriteForm\.do\*$/.test(m)));
  assert.equal(cs.all_frames, false);
  assert.equal(cs.world, 'ISOLATED');
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'shell-files.json'), 'utf8'));
  ['src/fashionstock-core.js', 'src/fashionstock-erp.js', 'src/fashionstock.js'].forEach((p) => assert.ok(idx.files.some((f) => f.path === p), p));
  assert.equal(idx.version, man.version);
});
test('fashionstock-erp — 배정은 바코드 정확일치만, 숨은 iframe 은 ubAutoJob', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/fashionstock-erp.js'), 'utf8');
  assert.doesNotMatch(src, /cPickAssignBarcode\(/);
  assert.match(src, /\.find\(\(x\) => String\(x\.barcode\)\.trim\(\)\.toUpperCase\(\) === want\)/);
  assert.match(src, /fr\.dataset\.ubAutoJob = 'ubfs_'/);
});
