// erp-wiring.test.js — 작업 C Phase 2 MAIN world 배선 구조 회귀테스트.
// loader 실행순서, 소비자별 contentType 정책, 자체 디코드 휴리스틱 제거를 소스로 고정한다.
// 실행: node tests/erp-wiring.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app-files.json'), 'utf8'));
const src = (name) => fs.readFileSync(path.join(ROOT, 'src', name), 'utf8');
const collector = src('collector.js');
const statis = src('statis.js');
const cache = src('cache-intercept.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

console.log('loader 순서 — SSOT가 MAIN world 소비자보다 먼저 실행');
t('src/erp.js가 files에 있고 맨 앞이다', () => {
  assert.strictEqual(app.files[0], 'src/erp.js');
});
t('src/erp.js가 소비자 3개보다 앞선다', () => {
  const erpAt = app.files.indexOf('src/erp.js');
  assert.ok(erpAt >= 0, 'src/erp.js가 app-files.json.files에 없습니다');
  ['src/collector.js', 'src/statis.js', 'src/cache-intercept.js'].forEach((consumer) => {
    const at = app.files.indexOf(consumer);
    assert.ok(at >= 0, consumer + '가 app-files.json.files에 없습니다');
    assert.ok(erpAt < at, 'src/erp.js가 ' + consumer + '보다 먼저 로드돼야 합니다');
  });
});

console.log('소비자 이관 — 자체 휴리스틱 제거 + ubErp SSOT 호출');
t('collector는 decodeKr 없이 ubErp를 호출한다', () => {
  assert.ok(/ubErp\.decodeErpHtml\(\s*buf\s*\)/.test(collector));
  assert.ok(!/function\s+decodeKr\s*\(/.test(collector));
  assert.ok(!/new\s+TextDecoder\(\s*['"]euc-kr['"]/.test(collector));
});
t('statis는 threshold 디코드 없이 ubErp를 호출한다', () => {
  assert.ok(/ubErp\.decodeErpHtml\(\s*buf\s*\)/.test(statis));
  assert.ok(!/new\s+TextDecoder\(\s*['"]euc-kr['"]/.test(statis));
  assert.ok(!/replCount/.test(statis));
});
t('cache-intercept는 샘플 휴리스틱 없이 ubErp를 호출한다', () => {
  assert.ok(/ubErp\.decodeErpHtml\(\s*buf\s*,\s*ct\s*\)/.test(cache));
  assert.ok(!/new\s+TextDecoder\(\s*['"]euc-kr['"]/.test(cache));
  assert.ok(!/replCount/.test(cache));
  assert.ok(/decoder:\s*['"]ubErp['"]/.test(cache));
});

console.log('contentType 정책 — 헤더 신뢰 범위를 사이트별로 보존');
t('collector는 buf 1개 인자만 넘긴다', () => {
  assert.ok(/ubErp\.decodeErpHtml\(\s*buf\s*\)/.test(collector));
  assert.ok(!/ubErp\.decodeErpHtml\(\s*buf\s*,/.test(collector));
});
t('statis는 buf 1개 인자만 넘긴다', () => {
  assert.ok(/ubErp\.decodeErpHtml\(\s*buf\s*\)/.test(statis));
  assert.ok(!/ubErp\.decodeErpHtml\(\s*buf\s*,/.test(statis));
});
t('cache-intercept만 ct를 두 번째 인자로 넘긴다', () => {
  assert.ok(/ubErp\.decodeErpHtml\(\s*buf\s*,\s*ct\s*\)/.test(cache));
  assert.ok(!/ubErp\.decodeErpHtml\(\s*buf\s*\)/.test(cache));
});

console.log('statis 렌더러 — 죽은 바깥 함수만 제거');
t('render(result, meta)는 없고 renderOrder와 중첩 render()는 남는다', () => {
  assert.ok(!/function\s+render\s*\(\s*result\s*,\s*meta\s*\)/.test(statis));
  const renderOrderAt = statis.indexOf('function renderOrder(');
  assert.ok(renderOrderAt >= 0, '살아있는 renderOrder가 없습니다');
  assert.ok(/function\s+render\s*\(\s*\)/.test(statis.slice(renderOrderAt)),
    'renderOrder 안의 중첩 render()가 없습니다');
});

console.log(`\nerp-wiring: ${pass} pass`);
