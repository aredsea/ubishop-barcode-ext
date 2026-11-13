/* =============================================================================
 *  arrival-core.test.js — 입고 지연 판정 core.  실행: node --test tests/arrival-core.test.js
 *  스펙: docs/superpowers/specs/2026-11-13-arrival-delay-design.md
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const A = require('../src/arrival-core.js');

const HDR14 = ['No', '', '주문일<br>주문장번호', '발주처명<br>발주일', '이미지', '매입처상품코드<br>상품코드 / 고객명', '구분', '상품정보', '수량', '주문가', '매장명(주문직원)', '인도예정일', '상태', '수정/취소'];
const HDR13 = HDR14.filter((h) => !/^발주처명/.test(h));

function table(hdr, rows) {
  const th = '<tr>' + hdr.map((h) => '<th>' + h + '</th>').join('') + '</tr>';
  return '<html><body><form><table class="t_list">' + th + rows.join('') + '</table></form></body></html>';
}
//  data = {seq, order:'26-11-13', jun:'0000002Z02', supplier:'키골드(F) 26-11-13', title, status}
function row14(d) {
  return '<tr><td>1</td><td><input type="checkbox" name="idx" value="' + d.seq + ',' + d.jun + '"></td>'
    + '<td>' + d.order + '<br>' + d.jun + '</td><td>' + d.supplier + '</td><td><img src="x.png"></td>'
    + '<td>' + d.title + '</td><td>일반 (상품)</td><td>반지 18K</td><td>1</td><td>100,000</td><td>FASHION(홍길동)</td><td></td><td>' + d.status + '</td><td>수정</td></tr>';
}
function row13(d) {
  return '<tr><td>1</td><td><input type="checkbox" name="idx" value="' + d.seq + ',' + d.jun + '"></td>'
    + '<td>' + d.order + '<br>' + d.jun + '</td><td><img src="x.png"></td>'
    + '<td>' + d.title + '</td><td>일반 (상품)</td><td>반지 18K</td><td>1</td><td>100,000</td><td>FASHION(홍길동)</td><td></td><td>' + d.status + '</td><td>수정</td></tr>';
}

test('arParseYmd — 붙은 셀·빈 값', () => {
  assert.strictEqual(A.arParseYmd('26-11-130000002Z02'), '2026-11-13');
  assert.strictEqual(A.arParseYmd('26-11-13'), '2026-11-13');
  assert.strictEqual(A.arParseYmd('키골드(F) 26-11-13'), '2026-11-13');
  assert.strictEqual(A.arParseYmd(''), null);
  assert.strictEqual(A.arParseYmd(null), null);
  assert.strictEqual(A.arParseYmd('26-13-45'), null);
});

test('arBizDaysAfter — 당일 0 · 주말 · 공휴일 · 연말 넘김', () => {
  const S = new Set();
  assert.strictEqual(A.arBizDaysAfter('2026-11-13', '2026-11-13', S), 0);
  assert.strictEqual(A.arBizDaysAfter('2026-11-13', '2026-11-12', S), 0);
  assert.strictEqual(A.arBizDaysAfter('2026-11-13', '2026-11-16', S), 1);   // 금 → 월
  assert.strictEqual(A.arBizDaysAfter('2026-11-13', '2026-11-15', S), 0);   // 금 → 일
  const H = new Set(['2027-01-01']);
  assert.strictEqual(A.arBizDaysAfter('2026-12-31', '2027-01-04', H), 1);   // 1/1(금 공휴일)·주말 제외 → 1/4 만
  assert.strictEqual(A.arBizDaysAfter('2026-12-31', '2027-01-04', new Set()), 2);  // 공휴일 없으면 1/1·1/4
  assert.strictEqual(A.arBizDaysAfter('2026-12-31', '2027-01-04'), 2);
});

test('arJudge — 경계 14 제외 · 15 포함', () => {
  const S = new Set();
  //  2026-10-26(월) 기준 → 14영업일 뒤 = 2026-11-13(금)
  const row = { orderSeq: '1', orderDate: '2026-10-26', baljuDate: null };
  assert.strictEqual(A.arBizDaysAfter('2026-10-26', '2026-11-13', S), 14);
  assert.strictEqual(A.arJudge([row], { stage: 'pre', todayYmd: '2026-11-13', holidaySet: S }).length, 0);
  const r15 = A.arJudge([row], { stage: 'pre', todayYmd: '2026-11-16', holidaySet: S });
  assert.strictEqual(r15.length, 1);
  assert.strictEqual(r15[0].elapsed, 15);
  assert.strictEqual(r15[0].key, '1|pre');
  assert.strictEqual(r15[0].baseYmd, '2026-10-26');
});

test('arJudge — pre 는 주문일, post 는 발주일, 발주일 없으면 주문일 + baseFallback', () => {
  const S = new Set();
  const row = { orderSeq: '7', orderDate: '2026-09-01', baljuDate: '2026-11-10' };
  const pre = A.arJudge([row], { stage: 'pre', todayYmd: '2026-11-13', holidaySet: S });
  assert.strictEqual(pre.length, 1);
  assert.strictEqual(pre[0].baseYmd, '2026-09-01');
  const post = A.arJudge([row], { stage: 'post', todayYmd: '2026-11-13', holidaySet: S });
  assert.strictEqual(post.length, 0);   // 발주일 11-10 → 3영업일
  const noBalju = A.arJudge([{ orderSeq: '8', orderDate: '2026-09-01', baljuDate: null }], { stage: 'post', todayYmd: '2026-11-13', holidaySet: S });
  assert.strictEqual(noBalju.length, 1);
  assert.strictEqual(noBalju[0].baseYmd, '2026-09-01');
  assert.strictEqual(noBalju[0].baseFallback, true);
  assert.strictEqual(noBalju[0].key, '8|post');
});

test('arSort — 경과 내림차순, 동률이면 주문일 오름차순', () => {
  const s = A.arSort([
    { elapsed: 20, orderDate: '2026-10-01' }, { elapsed: 30, orderDate: '2026-09-01' }, { elapsed: 20, orderDate: '2026-09-15' }
  ]);
  assert.deepStrictEqual(s.map((x) => x.elapsed + x.orderDate), ['302026-09-01', '202026-09-15', '202026-10-01']);
});

test('arRows — 14열: 날짜·번호·발주처 파싱', () => {
  const html = table(HDR14, [
    row14({ seq: '9001', jun: '0000002Z02', order: '26-11-13', supplier: '키골드(F) 26-11-13', title: 'A-1 홍길동', status: '발주완료' }),
    row14({ seq: '9002', jun: '0000002Z03', order: '26-09-21', supplier: '웨어베러', title: 'B-2 김철수', status: '주문완료' }),
    row14({ seq: '9003', jun: '0000002Z04', order: '26-10-01', supplier: '키골드(F) 26-10-05', title: 'C-3 박', status: '입고완료 (250NOZ)' })
  ]);
  const rows = A.arRows(html);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].orderSeq, '9001');
  assert.strictEqual(rows[0].junNum, '0000002Z02');
  assert.strictEqual(rows[0].orderDate, '2026-11-13');
  assert.strictEqual(rows[0].supplier, '키골드(F)');
  assert.strictEqual(rows[0].baljuDate, '2026-11-13');
  assert.strictEqual(rows[0].status, '발주완료');
  assert.strictEqual(rows[0].title, 'A-1 홍길동');
  assert.strictEqual(rows[0].qty, '1');
  assert.strictEqual(rows[1].supplier, '웨어베러');
  assert.strictEqual(rows[1].baljuDate, null);
  assert.strictEqual(rows[2].status, '입고완료 (250NOZ)');
});

test('arRows — 13열(발주처 열 없음): supplier 빈 값 · baljuDate null', () => {
  const html = table(HDR13, [row13({ seq: '9101', jun: '0000002Z09', order: '26-11-13', title: 'D-4 이', status: '주문완료' })]);
  const rows = A.arRows(html);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].supplier, '');
  assert.strictEqual(rows[0].baljuDate, null);
  assert.strictEqual(rows[0].status, '주문완료');
  assert.strictEqual(rows[0].title, 'D-4 이');
  assert.strictEqual(rows[0].orderSeq, '9101');
});

test('arRows — 헤더 없는 HTML 은 null(fail-closed)', () => {
  assert.strictEqual(A.arRows('<html><body>로그인</body></html>'), null);
  assert.strictEqual(A.arRows('<table class="t_list"><tr><td>x</td></tr></table>'), null);
  assert.strictEqual(A.arRows(''), null);
});

test('arRows — 머리글만 있는 0건 화면은 [] (본사확인 0건 같은 정상 응답)', () => {
  assert.deepStrictEqual(A.arRows(table(HDR14, [])), []);
});

test('arRows — 번호 칸은 있는데 idx 체크박스가 없는 데이터 행이 있으면 null(0건으로 오인 금지, Luna R1 P1)', () => {
  const ok = row14({ seq: '9001', order: '26-11-13', jun: '0000002Z02', supplier: '키골드(F) 26-11-13', title: '상품 고객', status: '발주완료' });
  const noIdx = ok.replace(/<input[^>]*>/, '');
  assert.strictEqual(A.arRows(table(HDR14, [noIdx])), null);
  assert.strictEqual(A.arRows(table(HDR14, [ok, noIdx])), null);
  //  합계 행('합 계')처럼 번호가 아닌 행은 영향 없음
  assert.strictEqual(A.arRows(table(HDR14, ['<tr><td>합 계</td><td>순금 : 0 g</td></tr>', ok])).length, 1);
});

test('arNewKeys — 새 키만 fresh · 빠진 키는 제거', () => {
  const r = A.arNewKeys(['a', 'b'], ['b', 'c']);
  assert.deepStrictEqual(r.fresh, ['a']);
  assert.deepStrictEqual(r.nextNotified.slice().sort(), ['a', 'b']);
  assert.ok(!r.nextNotified.includes('c'));
  assert.deepStrictEqual(A.arNewKeys([], ['x']), { fresh: [], nextNotified: [] });
});
