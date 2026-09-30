//  사용: node tools/make-saleimport-fixture.js "<GS샵_판매처리_….xlsx>"  → tests/fixtures/saleimport/rows-gs.json
//  브라우저(orderimport-xls.js)와 같은 옵션으로 첫 시트를 읽고, 휴대전화만 0504-0000-<뒤4> 로 치환한다.
const X = require('../vendor/xlsx.full.min.js');
const fs = require('fs'), path = require('path');
const src = process.argv[2];
if (!src) { console.error('xlsx 경로가 필요합니다'); process.exit(1); }
const wb = X.read(fs.readFileSync(src), { type: 'buffer', cellText: true });
const rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
const pc = rows[0].indexOf('휴대전화');
for (let i = 1; i < rows.length; i++) {
  const d = String(rows[i][pc] || '').replace(/\D/g, '');
  if (d.length >= 4) rows[i][pc] = '0504-0000-' + d.slice(-4);
}
const out = path.join(__dirname, '..', 'tests', 'fixtures', 'saleimport', 'rows-gs.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(rows, null, 1));
console.log('rows', rows.length, '→', out);
