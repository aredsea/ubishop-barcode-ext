//  사용: node tools/make-saleimport-coupang-fixture.js "<MSF_PAYMENT_REVENUE_DETAIL-*.xlsx>" ["<두 번째 파일>" …]  → tests/fixtures/saleimport/rows-coupang.json
//  브라우저와 같은 옵션(cellText·raw:false·header:1·defval)으로 첫 시트를 읽는다. 여러 파일이면 첫 파일의 헤더 아래로 데이터 행만 이어 붙인다.
//  구매자명이 마스킹('***')이 아니면 가명(고객A…)으로 치환한다. 금액·주문번호·상품명은 그대로.
const X = require('../vendor/xlsx.full.min.js');
const fs = require('fs'), path = require('path');
const srcs = process.argv.slice(2);
if (!srcs.length) { console.error('xlsx 경로가 필요합니다'); process.exit(1); }
const read = (p) => { const wb = X.read(fs.readFileSync(p), { type: 'buffer', cellText: true }); return X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false }); };
let rows = null;
srcs.forEach((p) => { const r = read(p); rows = rows ? rows.concat(r.slice(1)) : r; });
const h = rows[0].map((c) => String(c).replace(/\s+/g, ''));
const bi = h.indexOf('구매자명');
if (bi < 0) { console.error('구매자명 열 없음'); process.exit(1); }
const alias = new Map();
for (let i = 1; i < rows.length; i++) {
  const b = String(rows[i][bi]).trim();
  if (b && b !== '***') { if (!alias.has(b)) alias.set(b, '고객' + String.fromCharCode(65 + alias.size)); rows[i][bi] = alias.get(b); }
}
const out = path.join(__dirname, '..', 'tests', 'fixtures', 'saleimport', 'rows-coupang.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(rows, null, 1));
console.log('rows', rows.length, '→', out);
