/* =============================================================================
 *  orderitem-cancel-skey.test.js — fetchOrderRow 의 sKey 배관 테스트(Opus 5 재검수 P2-5).
 *
 *  일괄취소는 취소 GET 의 sKey 를 "상태를 확인한 그 재조회 응답" 에서 뽑는다(원자성). 그 원천이
 *  fetchOrderRow 안에 있는데, 배치 테스트는 fetchOrderRow 를 스텁으로 갈아 끼우므로 여기서 실제
 *  fetchOrderRow 를 가짜 fetch·DOMParser 위에서 돌려 "응답에서 키를 실제로 뽑아 싣는다" 를 고정한다.
 *  (변이 실측: 반환의 sKey 누락 / cExtractSKey 호출 누락 — 이 테스트 없이는 둘 다 228 pass 로 생존)
 *
 *  ⚠ 실제 네트워크 접근 없음. ⚠ 이 파일을 PowerShell 로 편집하지 마라 — Set-Content 가 한글을 깨뜨린다.
 *  실행: node --test tests/orderitem-cancel-skey.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'skin.js'), 'utf8');

function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'skin.js 에서 ' + name + ' 선언을 찾지 못했습니다 (리네임 여부 확인)');
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(name + ' 본문의 중괄호 균형을 찾지 못했습니다');
}

//  최소 가짜 문서: idx 체크박스 1개 + '상태' 헤더 열. cStatusColFor/cListStatusCode/cHasMore 등은 실제 함수.
function fakeDoc(seq, statusText) {
  const cell = (t) => ({ textContent: t });
  const headRow = { cells: [cell('No'), cell('주문일'), cell('상태')] };
  const dataRow = { cells: [cell('1'), cell('26-09-11 000001'), cell(statusText)],
                    outerHTML: '<tr><td>' + statusText + '</td></tr>', querySelector: () => null };
  const table = { dataset: {}, rows: [headRow, dataRow] };
  headRow.closest = dataRow.closest = (s) => (s === 'table' ? table : null);
  const box = { value: seq, closest: (s) => (s === 'tr' ? dataRow : null) };
  return { querySelectorAll: (s) => (s === 'input[name=idx]' ? [box] : []), querySelector: () => null };
}

const NAMES = ['fetchOrderRow', 'cExtractSKey', 'cListStatusCode', 'cStatusColIndex', 'cStatusColFor',
               'cHasMore', 'cReadTotalCount', 'oneDayParams', 'parseCurrentSettingArgs'];
function build(html, doc) {
  // eslint-disable-next-line no-new-func
  const factory = new Function('deps',
    'const ASG_FETCH_MS = 8000; const cLog = () => {};\n' +
    'const fetch = async () => ({ arrayBuffer: async () => new TextEncoder().encode(deps.html).buffer });\n' +
    'class DOMParser { parseFromString() { return deps.doc; } }\n' +
    NAMES.map(n => extractFn(SRC, n)).join('\n') + '\nreturn { fetchOrderRow };');
  return factory({ html, doc });
}

//  실제 응답 모양: 인라인 del() 의 orderItemCancel.do URL 에 15자리 sKey (2026-09-11 라이브 실측)
const HTML_WITH_KEY = '<html><script>function del(seq){ var url="/jun/orderitem/orderItemCancel.do?tcode=order_item"' +
                      '+"&seq="+seq+"&sKey=260911151234567"+CONST_URL; location.href=url; }</script><body></body></html>';

test('fetchOrderRow: found:true 응답에 그 렌더의 sKey 가 실린다(취소 GET 의 키 원천)', async () => {
  const r = await build(HTML_WITH_KEY, fakeDoc('101', '주문완료')).fetchOrderRow('101', '20260911');
  assert.equal(r.found, true);
  assert.equal(r.code, 'O--');
  assert.equal(r.sKey, '260911151234567');
});
test('fetchOrderRow: 응답에 sKey 가 없으면 null (호출부가 "sKey 추출 실패" 로 fail-closed)', async () => {
  const r = await build('<html><body></body></html>', fakeDoc('101', '주문완료')).fetchOrderRow('101', '20260911');
  assert.equal(r.found, true);
  assert.equal(r.sKey, null);
});
test('fetchOrderRow: 행이 없어(found:false) 도 응답의 sKey 는 실린다(필드 계약 — 호출부는 found 를 먼저 본다)', async () => {
  const r = await build(HTML_WITH_KEY, fakeDoc('999', '주문완료')).fetchOrderRow('101', '20260911');
  assert.equal(r.found, false);
  assert.equal(r.sKey, '260911151234567');
});
