/* =============================================================================
 *  orderimport-sellername.test.js — '판매처 상품명' 열(이지어드민 확장주문검색, 2026-10-19 추가) 판정.
 *  사장님 지시(2026-10-19): 상품명과 판매처 상품명을 14K·18K·Silver925 같은 문구를 빼고 비교해, 제품명이 다르면
 *  판매처 상품명을 따른다. 판정 기준은 '낱말 포함' — 상품명의 낱말이 판매처 상품명에 전부 들어 있으면 같음.
 *  사은품 행은 판매처 상품명에 본품 이름이 들어 있으므로 항상 상품명을 유지한다.
 *  예시 상품명은 2026-10-19 실제 파일에서 뽑았다(개인정보 없음).
 *  실행: node --test tests/orderimport-sellername.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'src', 'orderimport-core.js'));

const same = (name, seller) => assert.equal(C.oiPickName(name, seller).source, 'name', name + ' ↔ ' + seller);

test('oiPickName: 실제 파일의 18줄은 전부 같음 — 문구·광고 꼬리표·검색용 긴 제목은 차이가 아니다', () => {
  same('14K, 18K 쿠션퀼팅 귀걸이', '[D102] *단독 특가* 14K 쿠션퀼팅 귀걸이');
  same('댄디 버클 소가죽 팔찌', '[D102] 댄디 버클 소가죽 팔찌');
  same('14K, 18K 하프 볼 귀걸이', '[D102 패션] 14K, 18K 하프 볼 귀걸이');
  same('14K, 18K 크루즈 체인 반지', '14K, 18K 크루즈 체인 금 반지 십자가 레이어드  데일리 패션 여자 생일 기념일 선물');
  same('Silver925 로즈골드 펄 귀걸이', 'Silver925 로즈골드 펄 귀걸이');
  same('Silver925 포지타노 피어싱', 'Silver925 포지타노 피어싱(1개)');
  same('Silver925 퓨어 컷팅 반지', 'Silver925 퓨어 컷팅 반지');
});

test('oiPickName: 제품명이 다르면 판매처 상품명을 따르고, 광고 꼬리표만 걷어 낸다', () => {
  const r = C.oiPickName('14K, 18K 하프 볼 귀걸이', '[D102 패션] 14K, 18K 쿠션퀼팅 귀걸이');
  assert.equal(r.source, 'seller');
  assert.equal(r.name, '14K, 18K 쿠션퀼팅 귀걸이');
  assert.equal(C.oiPickName('Silver925 매트 웨이브 귀걸이', '[D102] *단독 특가* Silver925 버블 데일리 라인 귀걸이').name, 'Silver925 버블 데일리 라인 귀걸이');
});

test('oiPickName: 품위 문구만 다르면 같음 — 14K/18K/Silver925 차이는 옵션이 정한다', () => {
  same('14K 쿠션퀼팅 귀걸이', '18K 쿠션퀼팅 귀걸이');
  same('Silver925 매트 웨이브 귀걸이', '실버925 매트 웨이브 귀걸이');
  same('14k,18k 오벌 슬림 원터치 귀걸이', '오벌슬림 원터치 귀걸이');
});

test('oiPickName: 판매처 상품명이 비었거나 사은품이면 상품명 유지', () => {
  same('14K, 18K 하프 볼 귀걸이', '');
  same('14K, 18K 하프 볼 귀걸이', null);
  const g = C.oiPickName('[사은품] 티타늄 실버 귀걸이', '[D102 패션] 14K, 18K 하프 볼 귀걸이', { gift: true });
  assert.equal(g.source, 'name');
  assert.equal(g.name, '[사은품] 티타늄 실버 귀걸이');
});

test('oiParseRows: 판매처 상품명 열은 선택 — 있으면 판정해 productName 을 정하고 원래 이름을 남긴다', () => {
  const head = ['관리번호', '판매처', '주문번호', '상태', 'CS', '상품명', '옵션명', '판매가', '정산금액', '주문일', '수령자이름', '수령자전화', '수령자휴대폰', '판매처 상품명', ''];
  const row = (name, sellerName, price) => ['1', 'CJ몰', 'A1', '배송전', '', name, '', price, '0', '2026-10-19', '가나다', '', '010-0000-1234', sellerName, ''];
  const r = C.oiParseRows([head,
    row('14K, 18K 하프 볼 귀걸이', '[D102 패션] 14K, 18K 하프 볼 귀걸이', '30000'),
    row('[사은품] 티타늄 실버 귀걸이', '[D102 패션] 14K, 18K 하프 볼 귀걸이', ''),
    row('14K, 18K 하프 볼 귀걸이', '[D102 패션] 14K, 18K 쿠션퀼팅 귀걸이', '30000')]);
  assert.equal(r.error, null);
  const [a, g, d] = r.lines;
  assert.equal(a.productName, '14K, 18K 하프 볼 귀걸이'); assert.equal(a.nameSource, 'name');
  assert.equal(g.productName, '[사은품] 티타늄 실버 귀걸이'); assert.equal(g.gift, true); assert.equal(g.nameSource, 'name');
  assert.equal(d.productName, '14K, 18K 쿠션퀼팅 귀걸이'); assert.equal(d.nameSource, 'seller');
  assert.equal(d.ezName, '14K, 18K 하프 볼 귀걸이');
  assert.equal(d.sellerName, '[D102 패션] 14K, 18K 쿠션퀼팅 귀걸이');
  //  열이 없는 옛 양식은 그대로
  const old = C.oiParseRows([head.slice(0, 13), row('A 반지', '', '1000').slice(0, 13)]);
  assert.equal(old.lines[0].productName, 'A 반지'); assert.equal(old.lines[0].nameSource, 'name');
});
