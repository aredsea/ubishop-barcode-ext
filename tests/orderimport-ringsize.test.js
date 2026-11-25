/* =============================================================================
 *  orderimport-ringsize.test.js — 주문 가져오기: 쿠팡 1호·5호 '반지 호수 확인!' 경고(4.6.2).
 *  실행: node --test tests/orderimport-ringsize.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../src/orderimport-core.js');

const cp = { market: { name: '쿠팡' } };
test('oiRingSizeAlert — 쿠팡 + 1호/5호만', () => {
  assert.equal(C.oiRingSizeAlert(cp, '5'), true);
  assert.equal(C.oiRingSizeAlert(cp, '1'), true);
  assert.equal(C.oiRingSizeAlert(cp, ' 5 '), true);
  assert.equal(C.oiRingSizeAlert(cp, '5.0'), true);
  assert.equal(C.oiRingSizeAlert(cp, 5), true);
  assert.equal(C.oiRingSizeAlert(cp, '15'), false);
  assert.equal(C.oiRingSizeAlert(cp, '11'), false);
  assert.equal(C.oiRingSizeAlert(cp, '1.5'), false);
  assert.equal(C.oiRingSizeAlert(cp, ''), false);
  assert.equal(C.oiRingSizeAlert(cp, null), false);
  assert.equal(C.oiRingSizeAlert({ market: { name: '카페24' } }, '5'), false, '쿠팡 외 마켓은 아님');
  assert.equal(C.oiRingSizeAlert({ market: null }, '5'), false);
  assert.equal(C.oiRingSizeAlert(null, '5'), false);
});

test('화면 — 경고 줄 클래스·문구가 사이즈 칸 값으로 판정된다', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src/orderimport.js'), 'utf8');
  assert.match(ui, /C\.oiRingSizeAlert\(l, l\.spec\.itemSize\)/);
  assert.match(ui, /반지 호수 확인!/);
  assert.match(ui, /tr\.oi-l\.oi-ring/);
});
