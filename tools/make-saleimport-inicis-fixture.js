//  사용: node tools/make-saleimport-inicis-fixture.js "<지급일_신용카드(….xlsx>"  → tests/fixtures/saleimport/rows-inicis-card.json
//  브라우저와 같은 옵션(cellText·raw:false·header:1·defval)으로 첫 시트를 읽고, 구매자 실명은 가명(고객A…)으로,
//  상점MID·TID·승인번호는 X 로 치환한다. 금액·상태·주문번호·상품명은 그대로.
const X = require('../vendor/xlsx.full.min.js');
const fs = require('fs'), path = require('path');
const src = process.argv[2];
if (!src) { console.error('xlsx 경로가 필요합니다'); process.exit(1); }
const wb = X.read(fs.readFileSync(src), { type: 'buffer', cellText: true });
const rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
const h = rows[0].map((c) => String(c).replace(/\s+/g, ''));
const col = (n) => h.indexOf(n);
const bi = col('구매자');
if (bi < 0) { console.error('구매자 열 없음'); process.exit(1); }
const maskCols = ['상점MID', 'TID', '승인번호'].map(col).filter((i) => i >= 0);
const alias = new Map();
for (let i = 1; i < rows.length; i++) {
  if (String(rows[i][0]).trim() === '합계') continue;
  const b = String(rows[i][bi]).trim();
  if (b) {
    if (!alias.has(b)) alias.set(b, '고객' + String.fromCharCode(65 + alias.size));
    rows[i][bi] = alias.get(b);
  }
  maskCols.forEach((c) => { if (String(rows[i][c]) !== '') rows[i][c] = 'X'; });
}
const out = path.join(__dirname, '..', 'tests', 'fixtures', 'saleimport', 'rows-inicis-card.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(rows, null, 1));
console.log('rows', rows.length, '→', out);
