const test = require('node:test');
const assert = require('node:assert');
const F = require('../src/fashionstock-core.js');

test('fsSuffixMarket — 주문 가져오기 접미 규칙과 아틀리에 marketId', () => {
  assert.equal(F.fsSuffixMarket('김가명1234/카'), 'own');
  assert.equal(F.fsSuffixMarket('김가명1234/스'), 'smartstore');
  assert.equal(F.fsSuffixMarket('김가명1234/쿠'), 'coupang');
  assert.equal(F.fsSuffixMarket('김가명1234/K'), 'kakao');
  assert.equal(F.fsSuffixMarket('김가명1234/아'), 'amonds');
  assert.equal(F.fsSuffixMarket('김가명1234/G'), 'homeshop');
  assert.equal(F.fsSuffixMarket('김가명1234/s'), 'homeshop');
  assert.equal(F.fsSuffixMarket('김가명1234/옥'), 'gmarket');
  assert.equal(F.fsSuffixMarket('김가명1234/에'), 'ably');
  assert.equal(F.fsSuffixMarket('김가명1234/지'), null, 'G마켓·지그재그 겹침');
  assert.equal(F.fsSuffixMarket('김가명1754/협찬'), null);
  assert.equal(F.fsSuffixMarket('김가명1234'), null);
});

test('fsCategoryLetter — 둘째 칸 첫 글자', () => {
  assert.equal(F.fsCategoryLetter('F-BF-I-PG-PA-0091'), 'B');
  assert.equal(F.fsCategoryLetter('FBFIPGPA0091'), 'B');
  assert.equal(F.fsCategoryLetter('F-RF-P-PG-PA-00G3'), 'R');
  assert.equal(F.fsCategoryLetter('F-NF-Q-WG-QB-00EQ'), 'N');
  assert.equal(F.fsCategoryLetter(''), null);
});

test('fsComposeDesc — 접두 FD- 제거 · 종류 낱말 치환 · 고객명', () => {
  assert.equal(F.fsComposeDesc('Silver925물방울오팔팔찌', 'B', '김가명1234/카'), 'Silver925물방울오팔B/김가명1234');
  assert.equal(F.fsComposeDesc('FD-Silver925물방울오팔B', 'B', '김가명1234/카'), 'Silver925물방울오팔B/김가명1234');
  assert.equal(F.fsComposeDesc('FD-Silver925심플바게트오팔R', 'R', '김가명1234/쿠'), 'Silver925심플바게트오팔R/김가명1234');
  assert.equal(F.fsComposeDesc('Silver925누드2라인목걸이', 'N', '김가명1234/스'), 'Silver925누드2라인N/김가명1234');
  assert.equal(F.fsComposeDesc('Silver925물방울오팔B/이전고객', 'B', '김가명1234/카'), 'Silver925물방울오팔B/김가명1234', '기존 고객 꼬리 교체');
  assert.equal(F.fsComposeDesc('하트펜던트', null, '김가명1234/카'), '하트펜던트/김가명1234', '글자 모르면 낱말 유지');
});

test('fsPickPrice — base 우선, 없으면 price', () => {
  assert.equal(F.fsPickPrice({ base: 52000, price: 45000 }), 52000);
  assert.equal(F.fsPickPrice({ price: 45000 }), 45000);
  assert.equal(F.fsPickPrice({}), null);
  assert.equal(F.fsPickPrice(null), null);
});

test('fsSplitTitle — 상품명 코드 고객명 비고', () => {
  assert.deepEqual(F.fsSplitTitle('[925실버]물방울오팔팔찌 F-BF-I-PG-PA-0091 김가명4672/카'),
    { code: 'F-BF-I-PG-PA-0091', customer: '김가명4672/카' });
  assert.deepEqual(F.fsSplitTitle('[925실버]물방울오팔팔찌 F-BF-I-PG-PA-0091 김가명4672/카 주문 비고 : 정산 30,000 원'),
    { code: 'F-BF-I-PG-PA-0091', customer: '김가명4672/카' });
  assert.deepEqual(F.fsSplitTitle('코드없음'), { code: '', customer: '' });
});

test('fsCandidates — 같은 상품코드 · 주문완료만', () => {
  const rows = [
    { orderSeq: '11', junNum: '0000002Z2A', orderDate: '20261123', title: '[925실버]물방울오팔팔찌 F-BF-I-PG-PA-0091 김가명4672/카', status: '주문완료' },
    { orderSeq: '12', junNum: '0000002Z2B', orderDate: '20261122', title: '[925실버]물방울오팔팔찌 F-BF-I-PG-PA-0091 박가명1111/쿠', status: '본사확인' },
    { orderSeq: '13', junNum: '0000002Z2C', orderDate: '20261121', title: '다른상품 F-RF-P-PG-PA-00G3 이가명2222/카', status: '주문완료' },
  ];
  assert.deepEqual(F.fsCandidates(rows, 'FBFIPGPA0091'),
    [{ orderSeq: '11', junNum: '0000002Z2A', orderDate: '20261123', customer: '김가명4672/카', code: 'F-BF-I-PG-PA-0091' }]);
  assert.deepEqual(F.fsCandidates(null, 'FBFIPGPA0091'), null, '파싱 실패는 null 그대로');
});

test('fsListParams — 오늘 포함 7일 · FASHION · 주문완료', () => {
  const p = F.fsListParams(new Date(2026, 10, 23));
  assert.equal(p.syear + p.smonth + p.sday, '20261117');
  assert.equal(p.eyear + p.emonth + p.eday, '20261123');
  assert.equal(p.searchShop, 'LT');
  assert.equal(p.searchItemStatus, 'O--');
  assert.equal(p.searchDateType, 'a.orderDate');
  assert.equal(p.pageSize, '500');
});

test('fsPriceSource — 카페24=주문가, 그 외 아는 마켓=아틀리에, 모르면 null', () => {
  assert.deepEqual(F.fsPriceSource('김가명1234/카'), { kind: 'order' });
  assert.deepEqual(F.fsPriceSource('김가명1234/쿠'), { kind: 'atelier', market: 'coupang' });
  assert.deepEqual(F.fsPriceSource('김가명1234/아'), { kind: 'atelier', market: 'amonds' });
  assert.equal(F.fsPriceSource('김가명1234/지'), null);
  assert.equal(F.fsPriceSource('김가명1754/협찬'), null);
});

test('fsAtelierNames — 고객 꼬리·접두·소재 머리 뗀 후보', () => {
  assert.deepEqual(F.fsAtelierNames('Silver925물방울오팔B/김가명1234'), ['Silver925물방울오팔B', '물방울오팔B']);
  assert.deepEqual(F.fsAtelierNames('FD-Silver925 심플바게트오팔R'), ['Silver925 심플바게트오팔R', '심플바게트오팔R']);
  assert.deepEqual(F.fsAtelierNames('14K 하트링R'), ['14K 하트링R', '하트링R']);
  assert.deepEqual(F.fsAtelierNames('하트R'), ['하트R']);
  assert.deepEqual(F.fsAtelierNames('a*b'), [], 'PostgREST 필터 문자는 보내지 않음');
});

test('fsOrderPrices — 주문가 열 → orderSeq 별 금액', () => {
  const all = [
    { idx: null, cells: ['No', '', '주문일', '발주처명', '이미지', '매입처상품코드', '구분', '상품정보', '수량', '주문가', '매장명', '인도예정일', '상태', '수정/취소'] },
    { idx: '901,0000002Z2A', cells: ['1', '', '26-11-23 0000002Z2A', '가네샤', '', '...', '고객', '925', '1', '42,500', 'FASHION', '26-11-23', '주문완료', ''] },
    { idx: '902,0000002Z2B', cells: ['2', '', '26-11-22 0000002Z2B', '가네샤', '', '...', '고객', '925', '1', '0', 'FASHION', '26-11-23', '주문완료', ''] },
  ];
  assert.deepEqual(F.fsOrderPrices(all), { '901': 42500, '902': 0 });
  assert.equal(F.fsOrderPrices([{ idx: null, cells: ['No'] }]), null, '주문가 열이 없으면 null');
});
