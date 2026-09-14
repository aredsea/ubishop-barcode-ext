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
      const wb = XLSX.read(new Uint8Array(d.buf), { type: 'array' });
      const name = wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
      out = { ok: true, rows: rows, sheet: name };
    } catch (err) {
      out = { ok: false, error: String(err && err.message || err) };
    }
    window.postMessage(Object.assign({ source: 'ub-oi-xls', id: d.id }, out), '*');
  });
})();
