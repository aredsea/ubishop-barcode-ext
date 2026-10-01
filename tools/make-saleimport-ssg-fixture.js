//  사용: node tools/make-saleimport-ssg-fixture.js "<위수탁 마감 업체별 상세내역_*.xls>"  → tests/fixtures/saleimport/rows-ssg.json
//  브라우저와 같은 옵션(cellText·raw:false·header:1·defval)으로 첫 시트를 읽고, 주문자명 실명은 가명(고객A…)으로,
//  배송ID·송장번호는 X 로 치환한다. 금액·주문ID·상품명은 그대로.
const X = require('../vendor/xlsx.full.min.js');
const fs = require('fs'), path = require('path');
const src = process.argv[2];
if (!src) { console.error('xls 경로가 필요합니다'); process.exit(1); }
const wb = X.read(fs.readFileSync(src), { type: 'buffer', cellText: true });
const rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
const h = rows[0].map((c) => String(c).replace(/\s+/g, ''));
const col = (n) => h.indexOf(n);
const bi = col('주문자명');
if (bi < 0) { console.error('주문자명 열 없음'); process.exit(1); }
const maskCols = ['배송ID', '송장번호'].map(col).filter((i) => i >= 0);
const alias = new Map();
for (let i = 1; i < rows.length; i++) {
  const b = String(rows[i][bi]).trim();
  if (b) {
    if (!alias.has(b)) alias.set(b, '고객' + String.fromCharCode(65 + alias.size));
    rows[i][bi] = alias.get(b);
  }
  maskCols.forEach((c) => { if (String(rows[i][c]) !== '') rows[i][c] = 'X'; });
}
const out = path.join(__dirname, '..', 'tests', 'fixtures', 'saleimport', 'rows-ssg.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(rows, null, 1));
console.log('rows', rows.length, '→', out);
