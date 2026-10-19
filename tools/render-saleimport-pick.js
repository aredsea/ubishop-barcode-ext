/* render-saleimport-pick.js — '줄 직접 고르기' 가 열린 검토 표 한 건을 정적 HTML 로 뽑아 눈으로 확인한다(§10.10). 가명 데이터, 네트워크 없음.
 * 실행: node tools/render-saleimport-pick.js [출력.html]   (기본: 임시 폴더 saleimport-pick.html) */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPanel } = require('./saleimport-panel-harness.js');

const ORDERS = [
  { date: '26-08-20', barcode: '2608A1', code: 'F-BF-Z-WG-ZZ-0001', name: '반지', gift: false, settle: 18409, qty: 1, price: 30000, cancel: false },
  { date: '26-08-20', barcode: '2608A2', code: 'F-BF-Z-WG-ZZ-0002', name: '팔찌', gift: false, settle: null, qty: 1, price: 10000, cancel: false },
  { date: '26-08-22', barcode: '', code: 'F-BF-Z-WG-ZZ-0003', name: '목걸이', gift: false, settle: null, qty: 1, price: 5000, cancel: false },
  { date: '26-08-23', barcode: '2608A4', code: 'F-BF-Z-WG-ZZ-0004', name: '귀걸이', gift: false, settle: null, qty: 1, price: 20000, cancel: false },
  { date: '26-08-23', barcode: '2608A5', code: 'F-BF-Z-WG-ZZ-0005', name: '귀걸이', gift: false, settle: null, qty: 1, price: 20000, cancel: false }];
const erp = {
  openClient: async () => ({ values: { client: '1' }, form10: { beforePrice: '0' } }),
  trade: async () => ({ orders: ORDERS, sales: [{ barcode: '2608A5', date: '26-09-01', amount: 20000, price: 20000 }] })
};
(async () => {
  const h = loadPanel(erp);
  const mk = (o) => Object.assign({ key: '고객X/아', rows: [{ orderNo: 'AM-X', ledgerNo: 'AM-X', amount: 41000, name: '반지 외 1건', qty: 1, option: '', note: '' }], buyer: '고객X', client: { seq: '1', name: '고객X/아' }, how: '자동', st: 'block',
    reason: '정산 18,409 주문 줄 0개 (필요 1개)', match: { status: 'block', kind: 'line', reason: 'x', lines: [], cash: 0 }, checked: false, cands: null, q: '', note: '', qGen: 0, result: null,
    source: '원장', ledger: new Map([['AM-X', [{}]]]), retOrders: new Set(), retFull: new Set(), hard: false, manual: null, pick: null }, o || {});
  const other = mk({ key: '고객Y/아', rows: [{ orderNo: 'AM-Y', ledgerNo: 'AM-Y', amount: 20000, name: '귀걸이', qty: 1 }], client: { seq: '2', name: '고객Y/아' }, st: 'ok', how: '직접 지정', checked: true,
    match: { status: 'ok', reason: '', lines: [{ barcode: '2608A4', code: 'F-BF-Z-WG-ZZ-0004', name: '귀걸이', gift: false, orderNo: 'AM-Y', amount: 20000 }], cash: 20000, manual: true } });
  h.S.entries = [mk(), other];
  await h.api.openPicker(0);
  h.api.pickToggle(0, '2608A1', true); h.api.pickToggle(0, '2608A2', true);
  const rows = h.api.entryRows(h.S.entries[0], 0) + h.api.entryRows(h.S.entries[1], 1);
  const html = '<!doctype html><meta charset="utf-8"><title>saleimport 줄 직접 고르기 (정적 스냅샷)</title><body style="margin:0;background:#eee"><div id="ub-sl-panel" style="position:static;inset:auto;margin:24px;max-width:1200px"><div class="sl-b">'
    + h.api.ICON_DEFS + '<style>' + h.api.CSS + '</style><table class="sl-t"><colgroup><col style="width:36px"><col class="c-no"><col class="c-gs"><col><col class="c-amt"></colgroup>'
    + '<thead><tr><th></th><th>주문번호</th><th>상품</th><th>유비샵 바코드 · 상품</th><th class="num">실판매가</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  const out = process.argv[2] || path.join(os.tmpdir(), 'saleimport-pick.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log(out);
})();
