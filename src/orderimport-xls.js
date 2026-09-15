/* =============================================================================
 *  orderimport-xls.js — MAIN world. background 가 vendor/xlsx.full.min.js 와 함께 주입한다(패널 첫 오픈 때).
 *  ISOLATED(orderimport.js) 가 postMessage 로 보낸 ArrayBuffer 를 SheetJS 로 읽어 행 배열(header:1)만 돌려준다.
 *  스펙: docs/superpowers/specs/2026-09-14-orderimport-design.md §3.1
 * ========================================================================== */
(function () {
  'use strict';
  if (window.__ubOiXls) return;
  window.__ubOiXls = true;
  window.addEventListener('message', function (e) {
    const d = e.data;
    if (!d || e.source !== window || d.source !== 'ub-oi' || d.type !== 'parse') return;
    let out;
    try {
      if (typeof XLSX === 'undefined') throw new Error('XLSX 미로드');
      const wb = XLSX.read(new Uint8Array(d.buf), { type: 'array', cellText: true });
      const name = wb.SheetNames[0]; const ws = wb.Sheets[name];
      //  raw:false → 셀의 **표시 문자열**(서식 적용값)을 넘긴다. 숫자형 휴대폰 셀은 행 번호를 따로 알려 검토로 올린다(Terra 14R P1).
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
      const numericPhoneRows = [];
      const hdr = rows[0] || [];
      const phoneCols = hdr.map((h, i) => (/휴대폰|전화/.test(String(h).replace(/\s+/g, '')) ? i : -1)).filter((i) => i >= 0);
      if (phoneCols.length && ws['!ref']) {
        const range = XLSX.utils.decode_range(ws['!ref']);
        for (let r = range.s.r + 1; r <= range.e.r; r++) {
          for (const c of phoneCols) {
            const cell = ws[XLSX.utils.encode_cell({ r: r, c: c })];
            if (cell && cell.t === 'n') { numericPhoneRows.push(r - range.s.r); break; }
          }
        }
      }
      out = { ok: true, rows: rows, sheet: name, numericPhoneRows: numericPhoneRows };
    } catch (err) {
      out = { ok: false, error: String(err && err.message || err) };
    }
    window.postMessage(Object.assign({ source: 'ub-oi-xls', id: d.id }, out), '*');
  });
})();
