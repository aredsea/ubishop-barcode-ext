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
