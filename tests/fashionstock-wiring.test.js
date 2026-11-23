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
