//  사용: node tools/make-saleimport-queenit-fixture.js "<정산상세내역_검색결과.xlsx>"  → tests/fixtures/saleimport/rows-queenit.json
//  브라우저와 같은 옵션으로 첫 시트를 읽는다. 이 파일에는 개인 이름·연락처 열이 없다(브랜드·상품·금액·주문번호뿐).
//  혹시 이름/연락처/주소 계열 헤더가 있으면 안전을 위해 X 로 치환한다.
const X = require('../vendor/xlsx.full.min.js');
const fs = require('fs'), path = require('path');
const src = process.argv[2];
if (!src) { console.error('xlsx 경로가 필요합니다'); process.exit(1); }
const wb = X.read(fs.readFileSync(src), { type: 'buffer', cellText: true });
const rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
const mask = rows[0].map((c, i) => (/구매자|수취인|연락처|전화|주소|이메일|회원/.test(String(c)) ? i : -1)).filter((i) => i >= 0);
for (let i = 1; i < rows.length; i++) mask.forEach((c) => { if (String(rows[i][c]) !== '') rows[i][c] = 'X'; });
const out = path.join(__dirname, '..', 'tests', 'fixtures', 'saleimport', 'rows-queenit.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(rows, null, 1));
console.log('rows', rows.length, 'masked cols', mask.length, '→', out);
