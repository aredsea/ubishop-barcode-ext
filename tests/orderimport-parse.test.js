/* =============================================================================
 *  orderimport-parse.test.js — 판매처 주문 가져오기 순수 함수 단위 테스트 1/2 (파일·정규화·옵션·매핑·묶기·검토).
 *  픽스처: tests/fixtures/orderimport/ (xls 행 배열은 실제 파일에서 뽑아 이름·전화만 가명 치환,
 *          HTML 은 2026-09-14 라이브 실측 마크업을 그대로 본뜬 합성본).
 *  스펙: docs/superpowers/specs/2026-09-14-orderimport-design.md §2·§4·§5
 *  실행: node --test tests/orderimport-parse.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'src', 'orderimport-core.js'));
const FX = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'orderimport', name), 'utf8');
const ROWS_A = JSON.parse(FX('rows-a.json'));   // 원본 양식(판매가 열 없음) 35행
const ROWS_B = JSON.parse(FX('rows-b.json'));   // 개선 양식(판매가 열 있음) 9행 + 합계 + 빈 행

/* ---------------------------------------------------------------- §2.1 헤더 */
test('oiHeaderMap: 열은 이름으로 찾고 순서·추가 열은 무관, 판매가 없으면 missing', () => {
  const b = C.oiHeaderMap(ROWS_B[0]);
  assert.deepEqual(b.missing, []);
  assert.equal(ROWS_B[0][b.idx.price], '판매가');
  assert.equal(ROWS_B[0][b.idx.phone], '수령자휴대폰');
  const a = C.oiHeaderMap(ROWS_A[0]);
  assert.deepEqual(a.missing, ['판매가']);
  const shuffled = ['수령자휴대폰', '판매가', '주문번호', '상품명', '옵션명', '판매처', '정산금액', '수령자이름', '수량'];
  const s = C.oiHeaderMap(shuffled);
  assert.deepEqual(s.missing, []);
  assert.equal(s.idx.qty, 8);
  assert.equal(C.oiHeaderMap([' 판 매 처 ', '주문번호']).idx.seller, 0, '헤더 공백은 무시');
});

test('oiParseRows: 개선 양식 9줄, 합계·빈 행 제외, 판매가·정산·마켓·휴대폰 정규화', () => {
  const r = C.oiParseRows(ROWS_B);
  assert.equal(r.error, null);
  assert.equal(r.lines.length, 9);
  const first = r.lines[0];
  assert.equal(first.row, 2);
  assert.equal(first.seller, 'GS샵'); assert.equal(first.market.suffix, 'G'); assert.equal(first.market.clientJob, '7');
  assert.equal(first.price, 125000); assert.equal(first.settle, 87500); assert.equal(first.qty, 1);
  assert.equal(first.phone.phone, '0504-0000-4166'); assert.equal(first.phone.last4, '4166');
  assert.equal(first.optionText, '[14K-옐로우골드-12호]');
  const r2 = C.oiParseRows(ROWS_A);
  assert.match(r2.error, /필수 열 없음: 판매가/);
  assert.deepEqual(C.oiParseRows([]).lines, []);
});

test('oiParseRows: 수령자휴대폰이 비면 수령자전화로 대체하고 사용한 열을 표시한다', () => {
  const rows = [['판매처', '주문번호', '상품명', '옵션명', '판매가', '정산금액', '수령자이름', '수령자전화', '수령자휴대폰'],
    ['GS샵', '3473031135', '14K 목걸이', '[14K-로즈골드-38cm]', 1492000, 1044400, '이주', '0504-2185-5122', ''],
    ['스마트스토어', '2', 'Silver925 목걸이', '', 1000, 500, '김혜진', '02-123-4567', '010-8518-3509']];
  const r = C.oiParseRows(rows);
  assert.equal(r.error, null);
  assert.equal(r.lines[0].phone.phone, '0504-2185-5122');
  assert.equal(r.lines[0].phoneSource, '수령자전화');
  assert.equal(C.oiGroupOrders(r.lines)[0].phoneSource, '수령자전화', '주문 묶기 뒤에도 자동 대체 출처를 유지한다');
  assert.equal(r.lines[1].phone.phone, '010-8518-3509', '휴대폰 값이 있으면 수령자전화보다 우선한다');
  assert.equal(r.lines[1].phoneSource, '수령자휴대폰');
});

test('oiHeaderMap: 휴대폰 열이 없어도 수령자전화 열이 있으면 읽을 수 있다', () => {
  const h = C.oiHeaderMap(['판매처', '주문번호', '상품명', '옵션명', '판매가', '수령자이름', '수령자전화']);
  assert.deepEqual(h.missing, []);
  assert.equal(h.idx.recipientPhone, 6);
});

//  Terra 2R P2 (2026-09-15): 주문번호만 빈 행이 '판매처|' 키로 한 주문장에 합쳐져 실행될 수 있었다.
test('oiParseRows/oiGroupOrders: 주문번호가 빈 행은 검토 대상이 되고 서로 묶이지 않는다', () => {
  const rows = [['판매처', '주문번호', '상품명', '옵션명', '판매가', '정산금액', '수령자이름', '수령자휴대폰'],
    ['쿠팡', '', 'A', '', 1000, 100, '홍길동', '010-1234-5678'],
    ['쿠팡', '', 'B', '', 2000, 200, '김철수', '010-2222-3333'],
    ['', 'X1', 'C', '', 3000, 300, '이영희', '010-3333-4444']];
  const r = C.oiParseRows(rows);
  assert.equal(r.lines.length, 3);
  const g = C.oiGroupOrders(r.lines);
  assert.equal(g.length, 3, '주문번호 없는 행끼리 합쳐지면 안 된다');
  r.lines.slice(0, 2).forEach((l) => assert.ok(C.oiLineIssues(l, { mapping: { entry: { seq: '1', code: 'X' } }, parsed: C.oiParseOption('') }).includes('주문번호 없음')));
  assert.ok(C.oiLineIssues(r.lines[2], { mapping: { entry: { seq: '1', code: 'X' } }, parsed: C.oiParseOption('') }).some((s) => s.startsWith('판매처 미등록')));
});

//  Terra 4R P1 (2026-09-15): 같은 주문번호에 수령자/휴대폰이 다른 행이 첫 행 고객으로 합쳐졌다.
test('oiGroupOrders: 같은 주문장 안에서 수령자나 휴대폰이 첫 줄과 다르면 그 줄은 검토 대상', () => {
  const rows = [['판매처', '주문번호', '상품명', '옵션명', '판매가', '정산금액', '수령자이름', '수령자휴대폰'],
    ['쿠팡', 'O1', 'A', '', 1000, 100, '홍길동', '010-1234-5678'],
    ['쿠팡', 'O1', 'B', '', 2000, 200, '홍길동', '010-1234-5678'],
    ['쿠팡', 'O1', 'C', '', 3000, 300, '김철수', '010-1234-5678'],
    ['쿠팡', 'O1', 'D', '', 4000, 400, '홍길동', '010-9999-0000']];
  const g = C.oiGroupOrders(C.oiParseRows(rows).lines);
  assert.equal(g.length, 1);
  const iss = (l) => C.oiLineIssues(l, { mapping: { entry: { seq: '1', code: 'X' } }, parsed: C.oiParseOption('') });
  assert.deepEqual(iss(g[0].lines[0]), []); assert.deepEqual(iss(g[0].lines[1]), []);
  assert.ok(iss(g[0].lines[2]).some((s) => s.startsWith('수령자 불일치')));
  assert.ok(iss(g[0].lines[3]).some((s) => s.startsWith('수령자 불일치')));
});

//  Terra 4R P2 (2026-09-15): 미해석 토큰(3푼)을 사람이 보정해도 영구 차단됐다.
test('oiLineIssues: optOverride 면 미해석 토큰 이슈를 내지 않는다', () => {
  const line = C.oiParseRows(ROWS_B).lines[0];
  const parsed = C.oiParseOption('[14K-로즈골드-3푼-45cm]');
  assert.ok(C.oiLineIssues(line, { mapping: { entry: { seq: '1', code: 'X' } }, parsed }).some((s) => s.startsWith('옵션 해석 불가')));
  assert.deepEqual(C.oiLineIssues(line, { mapping: { entry: { seq: '1', code: 'X' } }, parsed, optOverride: true }), []);
});

//  Terra 4R P2 (2026-09-15): 코드표 밖 판매처를 세션에서 보정할 길이 없었다(스펙 §2.3 약속 항목).
test('oiApplyMarket: 미등록 판매처에 세션 한정 접미·마켓을 넣으면 고객명이 생기고 줄에도 전파된다', () => {
  const rows = [['판매처', '주문번호', '상품명', '옵션명', '판매가', '정산금액', '수령자이름', '수령자휴대폰'],
    ['11번가', 'O9', 'A', '', 1000, 100, '홍길동', '010-1234-5678']];
  const g = C.oiGroupOrders(C.oiParseRows(rows).lines);
  assert.equal(g[0].market, null); assert.equal(g[0].clientName, '');
  C.oiApplyMarket(g[0], '십', '12');
  assert.deepEqual(g[0].market, { name: '11번가', suffix: '십', clientJob: '12', sessionOnly: true });
  assert.equal(g[0].clientName, '홍길동5678/십');
  assert.equal(g[0].lines[0].market.clientJob, '12');
  assert.deepEqual(C.oiLineIssues(g[0].lines[0], { mapping: { entry: { seq: '1', code: 'X' } }, parsed: C.oiParseOption('') }), []);
  assert.equal(C.oiApplyMarket(g[0], '', '12'), false, '접미가 비면 적용하지 않는다');
});

test('oiApplyCustomer: 검토 화면에서 바꾼 수령자와 전화가 주문 전체와 고객명에 반영된다', () => {
  const rows = [['판매처', '주문번호', '상품명', '옵션명', '판매가', '정산금액', '수령자이름', '수령자휴대폰'],
    ['GS샵', '1', 'A', '', 1000, 100, '홍길동', '010-1234-5678'],
    ['GS샵', '1', 'B', '', 2000, 200, '홍길동', '010-1234-5678']];
  const o = C.oiGroupOrders(C.oiParseRows(rows).lines)[0];
  o.customer = { mode: 'reuse', seq: '9' };
  C.oiApplyCustomer(o, '김수정', '010 9999 0000');
  assert.equal(o.buyer, '김수정');
  assert.equal(o.phone.phone, '010-9999-0000');
  assert.equal(o.clientName, '김수정0000/G');
  assert.equal(o.customer, null, '수정 전 고객 조회 결과는 폐기한다');
  assert.deepEqual(o.lines.map((l) => [l.buyer, l.phone.phone, l.groupMismatch]), [
    ['김수정', '010-9999-0000', false], ['김수정', '010-9999-0000', false]
  ]);
});

//  Terra 8R P2 (2026-09-15): code 없는 매핑({seq}만)이 실행까지 통과해 POST 뒤 code 대조에서 fatal 로 끝났다 — POST 전에 막아야 한다.
test('oiLineIssues: 매핑 항목에 seq·code 가 없으면 매핑 불완전으로 차단', () => {
  const line = C.oiParseRows(ROWS_B).lines[0];
  const parsed = C.oiParseOption(line.optionText);
  assert.ok(C.oiLineIssues(line, { mapping: { entry: { seq: '7083' } }, parsed }).some((s) => s.startsWith('매핑 불완전')));
  assert.ok(C.oiLineIssues(line, { mapping: { entry: { code: 'F-RF-I-WG-PA-00F6' } }, parsed }).some((s) => s.startsWith('매핑 불완전')));
  assert.deepEqual(C.oiLineIssues(line, { mapping: { entry: { seq: '7083', code: 'F-RF-I-WG-PA-00F6' } }, parsed }), []);
  assert.deepEqual(C.oiValidMapEntry({ seq: '7083', code: 'F-RF-I-WG-PA-00F6', name: 'x' }), true);
  assert.deepEqual(C.oiValidMapEntry({ seq: '7083' }), false);
  assert.deepEqual(C.oiValidMapEntry({ seq: 7083, code: 'F-RF-I-WG-PA-00F6' }), false, 'seq 는 문자열');
});

test('사은품 제외 매핑은 유효하며 해당 줄 문제와 실행 대상에서 빠진다', () => {
  const gift = { gift: true, excluded: true, productName: '[사은품] 미등록 귀걸이', optionText: '', price: 0, qty: 1,
    market: C.oiMarket('GS샵'), orderNo: '1', buyer: '홍길동', phone: C.oiNormPhone('010-1234-5678') };
  const main = { gift: false, excluded: false, issues: [], productName: '14K 반지' };
  const excluded = { exclude: 'gift', name: '사은품 등록 제외' };
  assert.equal(C.oiValidMapEntry(excluded), true);
  assert.equal(C.oiIsExcludedEntry(excluded), true);
  assert.deepEqual(C.oiLineIssues(gift, { mapping: { entry: excluded }, parsed: C.oiParseOption('') }), []);
  assert.deepEqual(C.oiActiveLines({ lines: [main, gift] }), [main]);
  assert.equal(C.oiOrderReady({ lines: [main, gift], market: C.oiMarket('GS샵'), phone: C.oiNormPhone('010-1234-5678') }), true);
  assert.equal(C.oiOrderReady({ lines: [gift], market: C.oiMarket('GS샵'), phone: C.oiNormPhone('010-1234-5678') }), false, '제외 줄만 있는 주문은 실행하지 않는다');
});

//  Terra 9R P1 (2026-09-15): 주문폼 목록은 기본 pageSize 20 이라 21줄부터 행 수 대조가 깨진다 → 쓰기 전에 막는다.
test('oiGroupOrders: 20줄을 넘는 주문장은 모든 줄에 "줄 수 초과" 이슈', () => {
  const hdr = ['판매처', '주문번호', '상품명', '옵션명', '판매가', '정산금액', '수령자이름', '수령자휴대폰'];
  const mk = (n) => [hdr].concat(Array.from({ length: n }, (_, i) => ['쿠팡', 'BIG', 'P' + i, '', 1000, 100, '홍길동', '010-1234-5678']));
  const ok = C.oiGroupOrders(C.oiParseRows(mk(20)).lines);
  assert.deepEqual(C.oiLineIssues(ok[0].lines[19], { mapping: { entry: { seq: '1', code: 'X' } }, parsed: C.oiParseOption('') }), []);
  const big = C.oiGroupOrders(C.oiParseRows(mk(21)).lines);
  assert.equal(big[0].lines.length, 21);
  big[0].lines.forEach((l) => assert.ok(C.oiLineIssues(l, { mapping: { entry: { seq: '1', code: 'X' } }, parsed: C.oiParseOption('') }).some((s) => s.startsWith('줄 수 초과'))));
  assert.equal(C.OI_MAX_LINES, 20);
});

test('oiParseRows: 수량 열이 있으면 읽고, 판매가가 비면 null(검토 대상)', () => {
  const rows = [['판매처', '주문번호', '상품명', '옵션명', '판매가', '정산금액', '수령자이름', '수령자휴대폰', '수량'],
    ['쿠팡', '1', 'A', '', '', 100, '홍길동', '010-0000-5678', '2']];
  const r = C.oiParseRows(rows);
  assert.equal(r.lines[0].price, null);
  assert.equal(r.lines[0].qty, 2);
});

/* ------------------------------------------------------------- §2.2 정규화 */
test('oiNormPhone: 010/0504/1xx 하이픈 재구성, 그 외 ok:false', () => {
  assert.equal(C.oiNormPhone('01000003269').phone, '010-0000-3269');
  assert.equal(C.oiNormPhone('0504-0000-0399').phone, '0504-0000-0399');
  assert.equal(C.oiNormPhone('106-0000-2567').phone, '106-0000-2567');
  assert.equal(C.oiNormPhone('106 249 2567').last4, '2567');
  assert.equal(C.oiNormPhone('').ok, false);
  assert.equal(C.oiNormPhone('123').ok, false);
});

//  Terra 11R P1 (2026-09-15): 17000.5 가 검토를 통과한 뒤 17,001 로 조용히 반올림돼 화면 값과 쓰기 값이 달라졌다.
test('oiMoney: 원 단위는 정수만 — 소수·음수·문자는 null(검토 대상)', () => {
  assert.equal(C.oiMoney('17,000'), 17000); assert.equal(C.oiMoney(17000), 17000); assert.equal(C.oiMoney(' 17000 '), 17000);
  assert.equal(C.oiMoney('17000.5'), null); assert.equal(C.oiMoney(17000.5), null); assert.equal(C.oiMoney('17000.0'), null);
  assert.equal(C.oiMoney('0'), null); assert.equal(C.oiMoney('-5'), null); assert.equal(C.oiMoney('abc'), null); assert.equal(C.oiMoney(''), null);
  const rows = [['판매처', '주문번호', '상품명', '옵션명', '판매가', '정산금액', '수령자이름', '수령자휴대폰'], ['쿠팡', '1', 'A', '', 17000.5, 100, '홍길동', '010-1234-5678']];
  const l = C.oiParseRows(rows).lines[0];
  assert.equal(l.price, null);
  assert.ok(C.oiLineIssues(l, { mapping: { entry: { seq: '1', code: 'X' } }, parsed: C.oiParseOption('') }).includes('판매가 없음'));
});

//  Terra 12R P2 (2026-09-15): 사은품처럼 정산금액이 0 인 행은 비고가 빈값이 됐다 — 값이 있으면 '정산 0 원' 을 써야 한다.
test('정산금액 0 은 비고 "정산 0 원", 비어 있으면 생략, 소수는 거부', () => {
  assert.equal(C.oiMoney0('0'), 0); assert.equal(C.oiMoney0(0), 0); assert.equal(C.oiMoney0('1,234'), 1234);
  assert.equal(C.oiMoney0(''), null); assert.equal(C.oiMoney0('12.5'), null); assert.equal(C.oiMoney0('-1'), null);
  const rows = [['판매처', '주문번호', '상품명', '옵션명', '판매가', '정산금액', '수령자이름', '수령자휴대폰'],
    ['아몬즈', '1', '[사은품] 가죽 트레이', '', 1400, 0, '홍길동', '010-1234-5678'],
    ['아몬즈', '1', 'A', '', 1000, '', '홍길동', '010-1234-5678']];
  const ls = C.oiParseRows(rows).lines;
  assert.equal(ls[0].settle, 0); assert.equal(C.oiRemark(ls[0].settle), '정산 0 원');
  assert.equal(ls[1].settle, null); assert.equal(C.oiRemark(ls[1].settle), '');
});

//  Terra 12R P2 (2026-09-15): [매핑 지우기] 뒤 같은 상품을 다시 고르면 seq/code/name 만 저장돼 remarkSuffix·colorFallback 이 사라졌다.
test('oiLearn: 같은 seq 의 기존 항목이 있으면 remarkSuffix·colorFallback 을 이어받는다', () => {
  const map = { 'a|x': { seq: '6965', code: 'F-NF-P-WG-UU-00DH', name: '이스키아N', remarkSuffix: '/블루칼세도니', colorFallback: 'WG' } };
  const next = C.oiLearn(map, ['b'], { seq: '6965', code: 'F-NF-P-WG-UU-00DH', name: '이스키아N' }, 'now');
  assert.equal(next.b.remarkSuffix, '/블루칼세도니'); assert.equal(next.b.colorFallback, 'WG');
  const other = C.oiLearn(map, ['c'], { seq: '7083', code: 'X', name: 'y' }, 'now');
  assert.equal(other.c.remarkSuffix, undefined);
  const explicit = C.oiLearn(map, ['d'], { seq: '6965', code: 'F-NF-P-WG-UU-00DH', name: '이스키아N', remarkSuffix: '/새접미' }, 'now');
  assert.equal(explicit.d.remarkSuffix, '/새접미', '명시한 값이 우선');
});

//  Terra 14R P1 (2026-09-15): 엑셀이 휴대폰을 숫자형 셀로 저장하면 앞 0 이 사라진 값(1065783269)이 '106-578-3269' 로 통과했다.
test('oiParseRows: 숫자형 휴대폰 셀(meta.numericPhoneRows)은 검토 대상', () => {
  const rows = [['판매처', '주문번호', '상품명', '옵션명', '판매가', '정산금액', '수령자이름', '수령자휴대폰'],
    ['쿠팡', '1', 'A', '', 1000, 100, '홍길동', 1065783269],
    ['쿠팡', '2', 'B', '', 1000, 100, '김철수', '010-2222-3333']];
  const r = C.oiParseRows(rows, { numericPhoneRows: [1] });
  assert.equal(r.lines[0].phoneNumericCell, true); assert.equal(r.lines[1].phoneNumericCell, false);
  const iss = C.oiLineIssues(r.lines[0], { mapping: { entry: { seq: '1', code: 'X' } }, parsed: C.oiParseOption('') });
  assert.ok(iss.some((s) => s.startsWith('휴대폰 숫자 셀')));
  assert.deepEqual(C.oiLineIssues(r.lines[1], { mapping: { entry: { seq: '1', code: 'X' } }, parsed: C.oiParseOption('') }), []);
});

//  Opus 5 P2 (2026-09-15): 12자리는 무조건 4-4-4, 11자리는 3-4-4 로 재조립해 '+82 10-…'·'0505-123-4567' 이 다른 번호 문자열이 됐다.
test('oiNormPhone: 이미 세 토막이면 원문 하이픈 유지, 숫자만 왔을 때만 재구성, 국가코드는 검토', () => {
  assert.equal(C.oiNormPhone('0505-123-4567').phone, '0505-123-4567');
  assert.equal(C.oiNormPhone('010-1234-5678').phone, '010-1234-5678');
  assert.equal(C.oiNormPhone('0504-0000-4166').phone, '0504-0000-4166');
  assert.equal(C.oiNormPhone('01012345678').phone, '010-1234-5678');
  assert.equal(C.oiNormPhone('+82 10-1234-5678').ok, false, '국가코드 형식은 검토');
  assert.equal(C.oiNormPhone('821012345678').ok, false);
  assert.equal(C.oiNormPhone('010-12345-678').ok, false, '토막 자릿수가 이상하면 검토');
  assert.equal(C.oiNormPhone('0505-123-4567').last4, '4567');
  assert.equal(C.oiNormPhone('0505 123 4567').phone, '0505-123-4567', '공백 구분도 토막 유지(Opus O2 Nit)');
  assert.equal(C.oiNormPhone('106 249 2567').phone, '106-249-2567');
});

//  Opus 5 P1 (2026-09-15): complete_unverified 등으로 끝난 주문장이 체크된 채·장부 미기록으로 남아 [등록 시작] 재클릭 때 중복 주문장이 생겼다.
test('oiPostRunState: 완료됐을 수 있는 결과는 체크 해제 + 장부(unverified), 완전히 되돌린 skipped 만 재시도 가능', () => {
  const base = { key: 'K', tradeJun: '141236', orderSeqs: ['1', '2'], junNums: [{ junNum: '0000002YF5' }], rolledBack: 0, completing: false, completed: false };
  const done = C.oiPostRunState(Object.assign({}, base, { status: 'done' }), 'now');
  assert.equal(done.uncheck, true); assert.deepEqual(done.ledgerEntry, { at: 'now', tradeJun: '141236', junNums: ['0000002YF5'], lines: 2, sig: '' });   // sig: 2026-09-16 중복 경고용(§5b)
  for (const r of [
    Object.assign({}, base, { status: 'fatal', reason: 'complete_unverified:x', completing: true }),
    Object.assign({}, base, { status: 'fatal', reason: 'session_not_clear', completed: true, completing: true }),
    Object.assign({}, base, { status: 'fatal', reason: 'foreign_line_completed:…', completed: true, completing: true }),
    Object.assign({}, base, { status: 'fatal', reason: 'line_unverified:x', junNums: [] })
  ]) {
    const st = C.oiPostRunState(r, 'now');
    assert.equal(st.uncheck, true, r.reason);
    assert.equal(st.ledgerEntry.unverified, true, r.reason); assert.equal(st.ledgerEntry.reason, r.reason);
  }
  //  Opus O2 P2: 첫 줄 응답 유실은 orderSeqs 가 비어 있어도 서버에 줄이 남았을 수 있다
  const unknown = C.oiPostRunState({ key: 'K', status: 'fatal', reason: 'line_unverified:x', orderSeqs: [], junNums: [], rolledBack: 0, lineUnknown: true }, 'now');
  assert.equal(unknown.uncheck, true); assert.equal(unknown.ledgerEntry.unverified, true);
  const rolled = C.oiPostRunState(Object.assign({}, base, { status: 'skipped', reason: 'line_failed:x', rolledBack: 2, junNums: [] }), 'now');
  assert.equal(rolled.uncheck, false); assert.equal(rolled.ledgerEntry, null);
  const guard = C.oiPostRunState({ key: 'K', status: 'skipped', reason: 'open_trade', orderSeqs: [], junNums: [], rolledBack: 0 }, 'now');
  assert.equal(guard.uncheck, false); assert.equal(guard.ledgerEntry, null);
  const blocked = C.oiPostRunState({ key: 'K', status: 'blocked', reason: 'halted' }, 'now');
  assert.equal(blocked.uncheck, false); assert.equal(blocked.ledgerEntry, null);
});

test('oiClientName / oiMarket / oiRemark', () => {
  assert.equal(C.oiClientName('아자차', '4492', '쿠'), '아자차4492/쿠');
  assert.equal(C.oiClientName(' 가*나 ', '0399', 'G'), '가*나0399/G');
  assert.deepEqual(C.oiMarket('스마트스토어'), { name: '스마트스토어', suffix: '스', clientJob: '5' });
  assert.deepEqual(C.oiMarket('ssg'), { name: 'SSG', suffix: 's', clientJob: '2' });
  assert.equal(C.oiMarket('11번가'), null, '표에 없는 판매처는 null(검토)');
  assert.equal(C.oiRemark(12133), '정산 12,133 원');
  assert.equal(C.oiRemark(44138, '/블루칼세도니'), '정산 44,138 원 /블루칼세도니');
  assert.equal(C.oiRemark(null, '/블루칼세도니'), '/블루칼세도니');
  assert.equal(C.oiRemark(null), '');
});

test('oiGroupOrders: 판매처+주문번호로 묶고 고객명을 만든다(카*타 3줄, 차카타 2줄)', () => {
  const g = C.oiGroupOrders(C.oiParseRows(ROWS_B).lines);
  assert.equal(g.length, 6);
  assert.equal(g[0].lines.length, 3); assert.equal(g[0].clientName, '카*타4166/G');
  const last = g[g.length - 1];
  assert.equal(last.lines.length, 2); assert.equal(last.clientName, '차카타2567/아');
  assert.deepEqual(last.lines.map((l) => l.optionText), ['[17호]', '[9호]']);
});

/* ---------------------------------------------------------------- §2.2 옵션 */
test('oiParseOption: 품위·색상·사이즈 분해, 못 푸는 토큰은 unresolved', () => {
  assert.deepEqual(C.oiParseOption('[14K-로즈골드-15호]'), { k: '14', color: 'PG', itemSize: '15', unresolved: [], tokens: ['14K', '로즈골드', '15호'] });
  assert.deepEqual(C.oiParseOption('[18K-옐로우골드-42cm]').itemSize, '42');
  assert.equal(C.oiParseOption('[18K-옐로우골드-42cm]').color, 'YG');
  assert.deepEqual(C.oiParseOption('[15호]'), { k: null, color: null, itemSize: '15', unresolved: [], tokens: ['15호'] });
  assert.deepEqual(C.oiParseOption('[14K-옐로우골드]').itemSize, null);
  const dia = C.oiParseOption('[14K-로즈골드-3푼-45cm]');
  assert.deepEqual(dia.unresolved, ['3푼']); assert.equal(dia.itemSize, '45');
  assert.deepEqual(C.oiParseOption('').tokens, []);
  assert.equal(C.oiParseOption('[리얼화이트-11호]').color, 'RW');
  assert.equal(C.oiParseOption('[925-11호]').k, '925');
});

test('oiColorFromCode: 코드 4번째 토막이 셀렉트에 있을 때만', () => {
  const opts = [{ value: 'WG' }, { value: 'PG' }];
  assert.equal(C.oiColorFromCode('F-NF-P-WG-UU-00DH', opts), 'WG');
  assert.equal(C.oiColorFromCode('F-AF-Z-XY-ZZ-004E', opts), null);
  assert.equal(C.oiColorFromCode('FNFPWGUU00DH', opts), null, '대시 없는 itemNum 은 못 쓴다');
  assert.equal(C.oiColorFromCode('', opts), null);
});

/* ---------------------------------------------------------------- §2.4 매핑 */
test('oiMapKeys / oiLookupMap / oiLearn: 2단 키, 사이즈 제외, 학습은 원본 불변', () => {
  const parsed = C.oiParseOption('[14K-옐로우골드-12호]');
  const keys = C.oiMapKeys('14K, 18K 샤인스키니 반지', parsed);
  assert.deepEqual(keys, ['14k,18k샤인스키니반지|14-YG', '14k,18k샤인스키니반지']);
  assert.deepEqual(C.oiMapKeys('Silver925 퓨어 컷팅 반지', C.oiParseOption('[11호]')), ['silver925퓨어컷팅반지']);
  const map0 = {};
  const map1 = C.oiLearn(map0, keys, { seq: '7777', code: 'T-R6-Q-YG-ZZ-0001', name: '샤인스키니R' }, '2026-09-14T00:00:00Z');
  assert.deepEqual(map0, {}, '원본은 그대로');
  assert.equal(map1[keys[0]].seq, '7777'); assert.equal(map1[keys[1]].learnedAt, '2026-09-14T00:00:00Z');
  const hit = C.oiLookupMap(map1, C.oiMapKeys('14K, 18K 샤인스키니 반지', C.oiParseOption('[14K-옐로우골드-14호]')));
  assert.equal(hit.key, keys[0], '사이즈만 다르면 1순위 키로 맞는다');
  const hit2 = C.oiLookupMap(map1, C.oiMapKeys('14K, 18K 샤인스키니 반지', C.oiParseOption('[18K-로즈골드-14호]')));
  assert.equal(hit2.key, keys[1], '품위·색상이 다르면 2순위(상품명) 키로 폴백');
  assert.equal(C.oiLookupMap(map1, ['없음']), null);
});

test('oiSuggestQueries: 괄호 안 우선 → 범주어 제거·공백 제거 → 토큰', () => {
  assert.deepEqual(C.oiSuggestQueries('14K, 18K 큐 라인 볼드 반지 (심플가드링R(대)2.3m)').slice(0, 2), ['심플가드링R(대)2.3m', '큐라인볼드']);
  assert.deepEqual(C.oiSuggestQueries('Silver925 퓨어 컷팅 반지'), ['퓨어컷팅', '퓨어', '컷팅']);
  assert.deepEqual(C.oiSuggestQueries('Silver925 이스키아 블루칼세도니 목걸이'), ['이스키아블루칼세도니', '이스키아', '블루칼세도니']);
  assert.deepEqual(C.oiSuggestQueries('[사은품] 가죽 트레이')[0], '가죽트레이');
  assert.deepEqual(C.oiSuggestQueries('Silver925 미니 트윈 스타 피어싱 (1개)')[0], '미니트윈스타');
  assert.deepEqual(C.oiSuggestQueries('14K,18K 핑크 로맨스 귀걸이')[0], '핑크로맨스');
});

/* ---------------------------------------------------------- §3.3 검토 판정 */
test('oiLineIssues: 미매칭·옵션 미해석·판매처 미등록·판매가 없음', () => {
  const line = C.oiParseRows(ROWS_B).lines[0];
  assert.deepEqual(C.oiLineIssues(line, { mapping: null, parsed: C.oiParseOption(line.optionText) }), ['상품 미매칭']);
  const ok = C.oiLineIssues(line, { mapping: { entry: { seq: '1', code: 'X' } }, parsed: C.oiParseOption(line.optionText) });
  assert.deepEqual(ok, []);
  const bad = Object.assign({}, line, { market: null, price: null });
  const issues = C.oiLineIssues(bad, { mapping: { entry: { seq: '1', code: 'X' } }, parsed: C.oiParseOption('[3푼]') });
  assert.ok(issues.some((s) => s.startsWith('판매처 미등록')));
  assert.ok(issues.includes('판매가 없음'));
  assert.ok(issues.some((s) => s.startsWith('옵션 해석 불가: 3푼')));
  const form = { kOpts: [{ value: '5', text: '925' }], colorOpts: [{ value: 'WG' }], defaults: { color: '' } };
  const kIssue = C.oiLineIssues(line, { mapping: { entry: { seq: '7083', code: 'F-RF-I-WG-PA-00F6' } }, parsed: C.oiParseOption('[14K-옐로우골드-12호]'), form });
  assert.ok(kIssue.some((s) => s.startsWith('품위 옵션 없음: 14')));
  assert.ok(kIssue.some((s) => s.startsWith('색상 없음: YG')));
});

// ── 2026-09-16 리디자인 회차: 중복 주문장 사전 경고(스펙 §5b)·진행 스트립(§3) 순수부 ──
test('oiOrderSig: 상품명·옵션·수량으로 만든 서명은 순서·공백·대소문자와 무관하다', () => {
  const a = { lines: [{ productName: 'Silver925 퓨어 컷팅 반지', optionText: '[17호]', qty: 1 }, { productName: '[사은품] 박스', optionText: '', qty: 1 }] };
  const b = { lines: [{ productName: '[사은품]  박스 ', optionText: '', qty: 1 }, { productName: 'silver925 퓨어  컷팅 반지', optionText: ' [17호]', qty: 1 }] };
  assert.equal(C.oiOrderSig(a), C.oiOrderSig(b));
  assert.notEqual(C.oiOrderSig(a), C.oiOrderSig({ lines: [a.lines[0]] }), '줄이 빠지면 다른 서명');
  assert.notEqual(C.oiOrderSig(a), C.oiOrderSig({ lines: [Object.assign({}, a.lines[0], { qty: 2 }), a.lines[1]] }), '수량이 다르면 다른 서명');
  assert.equal(C.oiOrderSig({ lines: [] }), '');
});
test('oiDupCheck: 장부 없음/서명 같음/다름/옛 항목', () => {
  const o = { lines: [{ productName: 'A', optionText: '', qty: 1 }] };
  const sig = C.oiOrderSig(o);
  assert.deepStrictEqual(C.oiDupCheck(o, null), { dup: false, kind: 'none', entry: null });
  assert.equal(C.oiDupCheck(o, { at: 't', sig }).kind, 'same'); assert.equal(C.oiDupCheck(o, { at: 't', sig }).dup, true);
  assert.equal(C.oiDupCheck(o, { at: 't', sig: sig + 'x' }).kind, 'diff'); assert.equal(C.oiDupCheck(o, { at: 't', sig: sig + 'x' }).dup, false);
  assert.equal(C.oiDupCheck(o, { at: 't', lines: 1 }).kind, 'legacy'); assert.equal(C.oiDupCheck(o, { at: 't', lines: 1 }).dup, true);
});
test('oiPostRunState: 장부 항목에 상품 서명이 실린다(done·unverified 둘 다)', () => {
  const base = { key: 'K', status: 'done', reason: '', tradeJun: '1', orderSeqs: ['1'], junNums: [{ junNum: 'J' }], rolledBack: 0, sig: 'SIG' };
  assert.equal(C.oiPostRunState(base, 'now').ledgerEntry.sig, 'SIG');
  assert.equal(C.oiPostRunState(Object.assign({}, base, { status: 'fatal', completing: true, reason: 'complete_unverified:x' }), 'now').ledgerEntry.sig, 'SIG');
});
test('oiStepLabel: 실행기 log step → 사람 문구, 모르는 step 은 마지막 문구 유지', () => {
  assert.equal(C.oiStepLabel('guard', {}, ''), '세션 확인');
  assert.equal(C.oiStepLabel('register', {}, ''), '고객 등록');
  assert.equal(C.oiStepLabel('line', { i: 1, n: 2 }, ''), '줄 2/2 등록');
  assert.equal(C.oiStepLabel('complete', {}, ''), '주문장 완료 요청');
  assert.equal(C.oiStepLabel('rollback', {}, ''), '되돌리는 중');
  assert.equal(C.oiStepLabel('foreign_check_error', {}, '전표 조회'), '전표 조회');
});
test('oiEnrichTotal: 조회할 마스터·고객·추천 수를 센다', () => {
  const orders = [
    { market: { name: 'x' }, phone: { ok: true }, customer: null, lines: [{ mapping: { entry: { seq: '7' } }, suggest: null }, { mapping: null, suggest: null }] },
    { market: null, phone: { ok: true }, customer: null, lines: [{ mapping: { entry: { seq: '7' } }, suggest: null }] },
    { market: { name: 'y' }, phone: { ok: true }, customer: { mode: 'reuse' }, lines: [{ mapping: null, suggest: [] }] }
  ];
  assert.deepStrictEqual(C.oiEnrichTotal(orders, {}), { masters: 1, customers: 1, suggests: 1, total: 3 });
  assert.deepStrictEqual(C.oiEnrichTotal(orders, { 7: {} }), { masters: 0, customers: 1, suggests: 1, total: 2 });
});

test('oiEnrichTotal: 등록 제외 사은품은 마스터·추천 조회 수에서 빠진다', () => {
  const orders = [{ market: C.oiMarket('GS샵'), phone: C.oiNormPhone('010-1234-5678'), customer: {}, lines: [
    { excluded: true, mapping: { entry: { exclude: 'gift' } } },
    { excluded: true, mapping: null },
    { excluded: false, mapping: null, suggest: null }
  ] }];
  assert.deepStrictEqual(C.oiEnrichTotal(orders, {}), { masters: 0, customers: 0, suggests: 1, total: 1 });
});

//  사장님 요청(2026-09-16): 사은품이라 표기된 항목은 판매가가 비어 있거나 0 이어도 주문이 되게(유비샵도 판매가 0 주문 가능).
test('사은품 줄: 판매가가 비었거나 0 이면 0 으로 읽고 검토를 통과한다 — 일반 상품은 그대로 차단', () => {
  const H = ['판매처', '주문번호', '상품명', '옵션명', '판매가', '정산금액', '수령자이름', '수령자휴대폰'];
  const rows = [H, ['GS샵', '1', '[사은품] 쥬얼리 박스', '', '', 0, '홍길동', '010-1234-5678'], ['GS샵', '1', '(사은품) 파우치', '', '0', 0, '홍길동', '010-1234-5678'],
    ['GS샵', '1', '14K 반지', '', '', 100, '홍길동', '010-1234-5678'], ['GS샵', '1', '[사은품] 박스', '', 'abc', 0, '홍길동', '010-1234-5678']];
  const ls = C.oiParseRows(rows).lines;
  assert.equal(ls[0].gift, true); assert.equal(ls[0].price, 0);
  assert.equal(ls[1].gift, true); assert.equal(ls[1].price, 0);
  assert.equal(ls[2].gift, false); assert.equal(ls[2].price, null);
  assert.equal(ls[3].gift, true); assert.equal(ls[3].price, null, '문자는 사은품이라도 null(검토)');
  const issues = (l) => C.oiLineIssues(l, { mapping: { entry: { seq: '1', code: 'X' } }, parsed: C.oiParseOption('') });
  assert.ok(!issues(ls[0]).includes('판매가 없음')); assert.ok(!issues(ls[1]).includes('판매가 없음'));
  assert.ok(issues(ls[2]).includes('판매가 없음')); assert.ok(issues(ls[3]).includes('판매가 없음'));
  assert.equal(C.oiMoney0('0'), 0); assert.equal(C.oiMoney0(''), null);
});

//  사장님 규칙 2026-09-16 ①: 서버가 '휴대폰이 전화번호와 중복' 으로 거부한 경우만 재시도 대상.
test('oiPhoneDupMsg: 실측 문구(리터럴 \\n 포함)는 true, 다른 거부·빈값·null 은 false', () => {
  assert.equal(C.oiPhoneDupMsg('휴대폰이 전화번호와 중복인 고객이 되었습니다.\\n\\n다시 입력하세요!'), true);
  assert.equal(C.oiPhoneDupMsg('휴대폰이 전화번호와 중복인 고객이 되었습니다.\n\n다시 입력하세요!'), true);
  assert.equal(C.oiPhoneDupMsg('휴대폰 중복'), true);
  assert.equal(C.oiPhoneDupMsg('등록 실패'), false);
  assert.equal(C.oiPhoneDupMsg('전화번호가 중복입니다'), false);
  assert.equal(C.oiPhoneDupMsg(''), false); assert.equal(C.oiPhoneDupMsg(null), false); assert.equal(C.oiPhoneDupMsg(undefined), false);
});

//  사장님 규칙 2026-09-16 ②: 카페24 주문 중 판매금액 대비 정산금액 차이 60% 이상 → 등록 마켓만 지인소개(19).
test('oiReferralRatio / oiClientJob: 카페24 60% 이상만 19, 나머지는 원래 마켓', () => {
  const cafe = (lines) => ({ market: { name: '카페24', suffix: '카', clientJob: '6' }, lines });
  const L = (price, settle, qty) => ({ price, settle, qty: qty == null ? 1 : qty });
  assert.equal(C.oiReferralRatio(cafe([L(100000, 40000)])), 0.6);
  assert.equal(C.oiClientJob(cafe([L(100000, 40000)])), '19', '정확히 60% 도 지인소개');
  assert.equal(C.oiClientJob(cafe([L(100000, 40001)])), '6', '59.999% 는 카페24');
  assert.equal(C.oiClientJob(cafe([L(82000, 44138)])), '6', '46% 는 카페24');
  assert.equal(C.oiClientJob(cafe([L(100000, 30000), L(0, 0)])), '19', '사은품(0/0) 줄은 합계에 영향 없음');
  assert.equal(C.oiClientJob(cafe([L(100000, 41000), L(3000, 0)])), '19', '사은품 줄에 판매가가 있으면 파일 값 그대로 합산(103,000 vs 41,000 → 60.2%) — Opus Nit-1, 파일 합계 행과 같은 셈');
  assert.equal(C.oiClientJob(cafe([L(100000, 30000), L(100000, 90000)])), '6', '주문장 합계로 본다(줄 하나만 60% 넘어도 합계가 40% 면 아님)');
  assert.equal(C.oiClientJob(cafe([L(50000, 40000, 2)])), '19', '수량 반영: 50,000×2 = 100,000 vs 정산 40,000 → 60%');
  assert.equal(C.oiClientJob(cafe([L(50000, 45000, 2)])), '6', '100,000 vs 45,000 → 55%');
  assert.equal(C.oiClientJob(cafe([L(50000, 30000, 3)])), '19', '150,000 vs 30,000 → 80%');
  assert.equal(C.oiClientJob(cafe([L(100000, null)])), '6', '정산금액 없는 줄이 있으면 판정 불가 → 원래 마켓');
  assert.equal(C.oiClientJob(cafe([L(null, 0)])), '6', '판매가 없는 줄도 판정 불가');
  assert.equal(C.oiClientJob(cafe([L(0, 0)])), '6', '판매금액 0 → 판정 불가');
  assert.equal(C.oiClientJob(cafe([])), '6');
  assert.equal(C.oiClientJob({ market: { name: '아몬즈', suffix: '아', clientJob: '18' }, lines: [L(100000, 10000)] }), '18', '카페24 아니면 90% 차이라도 원래 마켓');
  assert.equal(C.oiClientJob({ market: { name: 'cafe24', suffix: '카', clientJob: '6', sessionOnly: true }, lines: [L(100000, 10000)] }), '19', '세션 마켓이라도 마켓 코드가 카페24(6) 면 적용');
  assert.equal(C.oiClientJob({ market: null, lines: [L(100000, 10000)] }), '');
});
