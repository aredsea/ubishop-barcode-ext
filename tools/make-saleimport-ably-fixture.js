//  사용: node tools/make-saleimport-ably-fixture.js "<…_에이블리_…_정산세부내역.csv>"  → tests/fixtures/saleimport/rows-ably.json
//  브라우저와 같은 옵션(cellText·raw:false·header:1·defval)으로 읽는다(SheetJS 가 UTF-8 CSV 를 그대로 읽는다). 이 파일에는 이름·연락처가 없다 — 주문번호·금액은 그대로.
const X = require('../vendor/xlsx.full.min.js');
const fs = require('fs'), path = require('path');
const src = process.argv[2];
if (!src) { console.error('csv 경로가 필요합니다'); process.exit(1); }
const wb = X.read(fs.readFileSync(src), { type: 'buffer', cellText: true });
const rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
const out = path.join(__dirname, '..', 'tests', 'fixtures', 'saleimport', 'rows-ably.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(rows, null, 1));
console.log('rows', rows.length, '→', out);
