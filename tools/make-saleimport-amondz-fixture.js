//  사용: node tools/make-saleimport-amondz-fixture.js "<아몬즈_정산내역상세조회.xlsx>"  → tests/fixtures/saleimport/rows-amondz.json
//  구매자명·수취인명 → 고객A…, 연락처 열 → 010-0000-<발명한 4자리>. 같은 사람은 같은 가명·같은 번호. 금액·주문번호는 그대로.
const X = require('../vendor/xlsx.full.min.js');
const fs = require('fs'), path = require('path');
const src = process.argv[2];
if (!src) { console.error('xlsx 경로가 필요합니다'); process.exit(1); }
const wb = X.read(fs.readFileSync(src), { type: 'buffer', cellText: true });
const rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
const h = rows[0].map((c) => String(c).replace(/\s+/g, ''));
const nameCols = ['구매자명', '수취인명'].map((n) => h.indexOf(n)).filter((i) => i >= 0);
const phoneCols = ['구매자연락처', '수취인연락처'].map((n) => h.indexOf(n)).filter((i) => i >= 0);
const names = new Map(), phones = new Map();
for (let i = 1; i < rows.length; i++) {
  nameCols.forEach((c) => { const v = String(rows[i][c]).trim(); if (v && v !== '-') { if (!names.has(v)) names.set(v, '고객' + String.fromCharCode(65 + names.size)); rows[i][c] = names.get(v); } });
  phoneCols.forEach((c) => { const v = String(rows[i][c]).trim(); if (v && v !== '-') { if (!phones.has(v)) phones.set(v, '010-0000-' + String(1234 + 1111 * phones.size).padStart(4, '0')); rows[i][c] = phones.get(v); } });
}
const out = path.join(__dirname, '..', 'tests', 'fixtures', 'saleimport', 'rows-amondz.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(rows, null, 1));
console.log('rows', rows.length, '→', out);
