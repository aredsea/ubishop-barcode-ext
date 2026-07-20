/* =============================================================================
 *  statis-xlsx.test.js — 상품집계 XLSX의 '이익율' 열 위치·값 회귀테스트.
 *
 *  statis.js 는 IIFE 라 require 할 수 없다. 배포 소스에서 숫자 유틸, XLSX 블록,
 *  실제 renderOrder 클릭 핸들러의 aoa 생성 구문을 추출·평가해 생성 파일을 검사한다.
 *  ZIP은 EOCD → central directory → local header 순서로 읽어 sheet1.xml을 꺼낸다.
 *
 *  실행: node tests/statis-xlsx.test.js
 * ========================================================================== */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'statis.js'), 'utf8');
// ⚠ 여기에 특정 기기·세션의 절대경로를 박지 마라. 작성 당시 세션의 스크래치패드 경로가
//    하드코딩돼 있어 다른 PC(그리고 같은 PC의 다른 세션)에서 EPERM 으로 전체 스위트가
//    깨졌다. 샘플은 사람이 눈으로 열어보는 용도이므로 OS 임시폴더면 충분하다.
const SAMPLE_PATH = path.join(os.tmpdir(), '판매통계_이익율_샘플.xlsx');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `statis.js 에서 ${name} 선언을 찾지 못했습니다 (리네임 여부 확인)`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 본문의 중괄호 균형을 찾지 못했습니다`);
}

const XLSX_START = '/* ---------- XLSX (라이브러리 없이 최소 구현: stored ZIP) ---------- */';
const XLSX_END = '/* ---------- 통계 오버레이 ---------- */';
const xlsxAt = SRC.indexOf(XLSX_START);
const xlsxEnd = SRC.indexOf(XLSX_END, xlsxAt);
assert.ok(xlsxAt >= 0 && xlsxEnd > xlsxAt, 'statis.js 에서 XLSX 블록 마커를 찾지 못했습니다');

const UTIL_NAMES = ['esc', 'firstNum', 'discountRate', 'discountText', 'profitRate', 'profitText'];
const xlsxSource = UTIL_NAMES.map(name => extractFn(SRC, name)).join('\n') +
  '\n' + SRC.slice(xlsxAt, xlsxEnd) + '\nreturn { buildXlsx, discountText, profitText };';
// eslint-disable-next-line no-new-func
const { buildXlsx, discountText, profitText } = new Function(xlsxSource)();

// ★추출 대상이 renderOrder '본문 안'임을 구조적으로 보장한다 — renderOrder 본문(중괄호 균형)만
//   잘라내 그 안에서 핸들러를 찾는다. "renderOrder 선언보다 뒤"라는 인덱스 비교로는
//   renderOrder 종료 후에 생긴 제3의 핸들러도 집어갈 수 있다.
//   (v2.9.1 이전에는 죽은 render(result, meta) 소속 #ub-stat-xlsx 핸들러가 하나 더 있어
//    엉뚱한 쪽을 집을 위험이 실재했다. 그 죽은 코드는 제거됐지만, 같은 이름의 다른 것을
//    집는 사고가 이 저장소에서 반복됐으므로 앵커는 계속 본문 기준으로 둔다.)
const renderOrderSrc = extractFn(SRC, 'renderOrder');
const handlerMarker = "box.querySelector('#ub-stat-xlsx').addEventListener('click', () => {";
const liveHandlerAt = renderOrderSrc.indexOf(handlerMarker);
assert.ok(liveHandlerAt >= 0, 'renderOrder 본문 안에서 XLSX 핸들러를 찾지 못했습니다');

const aoaAt = renderOrderSrc.indexOf('let aoa;', liveHandlerAt);
const downloadAt = renderOrderSrc.indexOf('downloadXlsx(', aoaAt);
assert.ok(aoaAt > liveHandlerAt && downloadAt > aoaAt, '라이브 핸들러에서 aoa 생성 구간을 찾지 못했습니다');
const aoaSource = renderOrderSrc.slice(aoaAt, downloadAt);
// eslint-disable-next-line no-new-func
const makeAoaFromSource = new Function(
  'view', 'IS_ORDER', 'PAGE', 'staffDisplay', 'countedProducts', 'storeDisplay', 'discountText', 'profitText',
  aoaSource + '\nreturn aoa;'
);

const PAGE = { supLabel: '공급가', priceLabel: '실판매가', xlsxName: () => '판매통계_test.xlsx' };
const rows = [
  { label: '라이브A', qty: 1, supExp: 1800000, saleExp: 1800000, price: 1670000, cost: 878439, costMissing: false },
  { label: '라이브B', qty: 1, supExp: 1450000, saleExp: 1450000, price: 1330000, cost: 669673, costMissing: false },
  { label: '라이브C', qty: 1, supExp: 1200000, saleExp: 1200000, price: 1100000, cost: 764381, costMissing: false },
  { label: '원가결측', qty: 1, supExp: 500000, saleExp: 500000, price: 450000, cost: 0, costMissing: true }
];
const staffRows = rows.map(r => ({ ...r, staff: r.label, products: [r.label + '-제품'] }));
const productRows = rows.map(r => ({ ...r, name: r.label, type: '자사', members: [r.label + '-코드'] }));
const storeRows = rows.map(r => ({ ...r, store: r.label, products: [r.label + '-제품'] }));

function makeAoa(view, isOrder) {
  return makeAoaFromSource(
    view, isOrder, PAGE,
    () => staffRows, () => productRows, () => storeRows,
    discountText, profitText
  );
}

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function zipEntry(bytes, wantedName) {
  const minEocd = Math.max(0, bytes.length - 22 - 0xFFFF);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= minEocd; i--) {
    if (readU32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, 'ZIP EOCD를 찾지 못했습니다');
  assert.strictEqual(eocd + 22 + readU16(bytes, eocd + 20), bytes.length, 'ZIP EOCD 길이가 맞지 않습니다');
  assert.strictEqual(readU16(bytes, eocd + 4), 0, '다중 디스크 ZIP은 지원하지 않습니다');
  assert.strictEqual(readU16(bytes, eocd + 6), 0, 'central directory 디스크가 0이 아닙니다');

  const entries = readU16(bytes, eocd + 10);
  const cdSize = readU32(bytes, eocd + 12);
  const cdOffset = readU32(bytes, eocd + 16);
  let p = cdOffset;
  let found = null;
  for (let i = 0; i < entries; i++) {
    assert.strictEqual(readU32(bytes, p), 0x02014b50, `central directory ${i}번 헤더가 손상됐습니다`);
    const method = readU16(bytes, p + 10);
    const compressedSize = readU32(bytes, p + 20);
    const uncompressedSize = readU32(bytes, p + 24);
    const nameLength = readU16(bytes, p + 28);
    const extraLength = readU16(bytes, p + 30);
    const commentLength = readU16(bytes, p + 32);
    const localOffset = readU32(bytes, p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength));

    if (name === wantedName) {
      assert.strictEqual(method, 0, `${wantedName} 압축 방식이 stored(method 0)가 아닙니다`);
      assert.strictEqual(compressedSize, uncompressedSize, `${wantedName} stored 크기가 서로 다릅니다`);
      assert.strictEqual(readU32(bytes, localOffset), 0x04034b50, `${wantedName} local header가 손상됐습니다`);
      assert.strictEqual(readU16(bytes, localOffset + 8), method, `${wantedName} 압축 방식이 헤더끼리 다릅니다`);
      const localNameLength = readU16(bytes, localOffset + 26);
      const localExtraLength = readU16(bytes, localOffset + 28);
      const localName = new TextDecoder().decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
      assert.strictEqual(localName, wantedName, `${wantedName} local header 이름이 다릅니다`);
      const dataAt = localOffset + 30 + localNameLength + localExtraLength;
      assert.ok(dataAt + compressedSize <= cdOffset, `${wantedName} 데이터 범위가 central directory를 침범합니다`);
      found = bytes.subarray(dataAt, dataAt + compressedSize);
    }
    p += 46 + nameLength + extraLength + commentLength;
  }
  assert.strictEqual(p, cdOffset + cdSize, 'central directory 크기가 EOCD 기록과 다릅니다');
  assert.ok(found, `ZIP central directory에서 ${wantedName}을 찾지 못했습니다`);
  return found;
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function sheetCells(aoa) {
  const bytes = buildXlsx(aoa);
  const xml = new TextDecoder().decode(zipEntry(bytes, 'xl/worksheets/sheet1.xml'));
  const cells = new Map();
  const re = /<c r="([A-Z]+\d+)"(?: t="inlineStr")?>([\s\S]*?)<\/c>/g;
  let m;
  while ((m = re.exec(xml))) {
    const text = m[2].match(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/);
    const number = m[2].match(/<v>([\s\S]*?)<\/v>/);
    cells.set(m[1], text ? decodeXml(text[1]) : Number(number[1]));
  }
  return { bytes, xml, cells };
}

function rowLength(cells, row) {
  return [...cells.keys()].filter(ref => Number(ref.match(/\d+$/)[0]) === row).length;
}

function assertRow(cells, row, expected) {
  assert.strictEqual(rowLength(cells, row), expected.length, `${row}행은 정확히 ${expected.length}열이어야 합니다`);
  expected.forEach((value, i) => {
    const ref = String.fromCharCode(65 + i) + row;
    assert.strictEqual(cells.get(ref), value, `${ref}: ${JSON.stringify(value)} 이어야 합니다`);
  });
}

// 2행만 고정하면 "3행 이후에만 열이 끼어드는" 누출을 놓친다(조건부 splice 등).
// 픽스처 데이터 행 전체(2~5행)가 헤더와 같은 열 개수인지 확인한다.
const LAST_DATA_ROW = 1 + rows.length;
function assertAllDataRowLengths(cells, expectedLength) {
  for (let r = 2; r <= LAST_DATA_ROW; r++) {
    assert.strictEqual(rowLength(cells, r), expectedLength, `${r}행은 정확히 ${expectedLength}열이어야 합니다`);
  }
}

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

console.log('배포 소스 추출 — 죽은 render가 아닌 renderOrder 핸들러');
t('라이브 핸들러의 aoa와 buildXlsx를 소스에서 평가한다', () => {
  assert.ok(aoaSource.includes("if (view === 'staff')"));
  assert.strictEqual(typeof buildXlsx, 'function');
});

console.log('판매탭 XLSX — 헤더 위치와 데이터 열 정렬');
const staff = sheetCells(makeAoa('staff', false));
t('staff 헤더 8열, 이익율은 G1', () => {
  assertRow(staff.cells, 1, ['순위', '직원', '총수량', '총공급가', '총실판매가', '할인율', '이익율', '제품수']);
  assert.strictEqual(staff.cells.get('G1'), '이익율');
});
t('staff 데이터도 G열이며 47.4%·49.6%·30.5%·결측 빈칸', () => {
  assert.deepStrictEqual(['G2', 'G3', 'G4', 'G5'].map(ref => staff.cells.get(ref)), ['47.4%', '49.6%', '30.5%', '']);
  // 데이터 행도 열 개수·순서를 통째로 고정한다(값만 보면 열이 하나 더 붙어도 통과한다).
  assertRow(staff.cells, 2, [1, '라이브A', 1, 1800000, 1670000, '7.2%', '47.4%', 1]);
  assertAllDataRowLengths(staff.cells, 8);
});

const product = sheetCells(makeAoa('product', false));
t('product 헤더 9열, 이익율은 H1', () => {
  assertRow(product.cells, 1, ['순위', '제품명', '구분', '총수량', '총공급가', '총실판매가', '할인율', '이익율', '코드수']);
  assert.strictEqual(product.cells.get('H1'), '이익율');
});
t('product 데이터도 H열이며 47.4%·49.6%·30.5%·결측 빈칸', () => {
  assert.deepStrictEqual(['H2', 'H3', 'H4', 'H5'].map(ref => product.cells.get(ref)), ['47.4%', '49.6%', '30.5%', '']);
  assertRow(product.cells, 2, [1, '라이브A', '자사', 1, 1800000, 1670000, '7.2%', '47.4%', 1]);
  assertAllDataRowLengths(product.cells, 9);
});

const store = sheetCells(makeAoa('store', false));
t('store 헤더 8열, 이익율은 G1', () => {
  assertRow(store.cells, 1, ['순위', '매장', '총수량', '총공급가', '총실판매가', '할인율', '이익율', '제품수']);
  assert.strictEqual(store.cells.get('G1'), '이익율');
});
t('store 데이터도 G열이며 47.4%·49.6%·30.5%·결측 빈칸', () => {
  assert.deepStrictEqual(['G2', 'G3', 'G4', 'G5'].map(ref => store.cells.get(ref)), ['47.4%', '49.6%', '30.5%', '']);
  assertRow(store.cells, 2, [1, '라이브A', 1, 1800000, 1670000, '7.2%', '47.4%', 1]);
  assertAllDataRowLengths(store.cells, 8);
});

console.log('주문탭 XLSX — 판매 전용 열 회귀 가드');
// ★헤더 문자열만 검사하면 부족하다. 데이터 행에만 할인율·이익율 '값'(7.2% 같은)이 끼어들면
//   XML 어디에도 '이익율' 이라는 글자는 없어 통과해버린다(실제로 변이로 재현 확인).
//   그래서 데이터 행도 assertRow 로 열 개수·순서를 통째로 고정한다.
t('staff 주문탭에는 할인율·이익율 열이 없다', () => {
  const order = sheetCells(makeAoa('staff', true));
  assertRow(order.cells, 1, ['순위', '직원', '총수량', '총공급가', '총실판매가', '제품수']);
  assertRow(order.cells, 2, [1, '라이브A', 1, 1800000, 1670000, 1]);
  assertAllDataRowLengths(order.cells, 6);
  assert.ok(!order.xml.includes('할인율') && !order.xml.includes('이익율'));
});
t('product 주문탭에는 할인율·이익율 열이 없다', () => {
  const order = sheetCells(makeAoa('product', true));
  assertRow(order.cells, 1, ['순위', '제품명', '구분', '총수량', '총공급가', '총실판매가', '코드수']);
  assertRow(order.cells, 2, [1, '라이브A', '자사', 1, 1800000, 1670000, 1]);
  assertAllDataRowLengths(order.cells, 7);
  assert.ok(!order.xml.includes('할인율') && !order.xml.includes('이익율'));
});
t('store 주문탭에는 할인율·이익율 열이 없다', () => {
  const order = sheetCells(makeAoa('store', true));
  assertRow(order.cells, 1, ['순위', '매장', '총수량', '총공급가', '총실판매가', '제품수']);
  assertRow(order.cells, 2, [1, '라이브A', 1, 1800000, 1670000, 1]);
  assertAllDataRowLengths(order.cells, 6);
  assert.ok(!order.xml.includes('할인율') && !order.xml.includes('이익율'));
});

fs.mkdirSync(path.dirname(SAMPLE_PATH), { recursive: true });
fs.writeFileSync(SAMPLE_PATH, staff.bytes);
t('사람 확인용 판매통계 XLSX 샘플을 지정 경로에 저장한다', () => {
  assert.deepStrictEqual(fs.readFileSync(SAMPLE_PATH), Buffer.from(staff.bytes));
});

console.log(`\n${pass} pass`);
