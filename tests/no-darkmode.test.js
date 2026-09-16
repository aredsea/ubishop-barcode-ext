/* =============================================================================
 *  no-darkmode.test.js — 다크모드는 걷어냈다(사장님 지시 2026-09-16, 스펙 2026-09-16-orderimport-panel-redesign §5).
 *  src/·popup/ 어디에도 ub-dark / ubDark 가 남아 있으면 안 되고, 팝업에 다크 스위치가 없어야 한다.
 *  실행: node --test tests/no-darkmode.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

test('다크모드 잔재 0 — src/·popup/ 에 ub-dark/ubDark 없음, 팝업에 #dark 스위치 없음, skin.js 에 applyDark/DARK_CSS 없음', () => {
  const files = ['src/skin.js', 'src/orderimport.js', 'src/content.js', 'src/statis.js', 'src/loader.js', 'src/background.js', 'popup/popup.html', 'popup/popup.js'];
  for (const f of files) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.equal((t.match(/ub-dark|ubDark/g) || []).length, 0, f + ' 에 다크모드 잔재');
  }
  assert.ok(!/id="dark"/.test(fs.readFileSync(path.join(ROOT, 'popup/popup.html'), 'utf8')), '팝업 다크 스위치');
  assert.ok(!/applyDark|DARK_CSS|ensureDarkStyle|DARK_STYLE_ID/.test(fs.readFileSync(path.join(ROOT, 'src/skin.js'), 'utf8')), 'skin.js 다크 코드');
});
