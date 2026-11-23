/* =============================================================================
 *  fashionstock.js — 패션 상품 재고화 확인 창 + 진행 (v4.6.1).
 *  스펙: docs/superpowers/specs/2026-11-23-fashion-stock-design.md
 *
 *  확인 창까지 유비샵 쓰기 0. [진행] 한 번 = ① 품목 수정 → ② 본사확인 → ③ 배정.
 *  순서를 바꾸지 않는다 — 배정되면 입고장 행에서 [수정] 링크가 사라진다(2026-11-23 실측).
 *  실패하면 거기서 멈추고 남은 일을 적는다. 자동 되돌리기는 하지 않는다.
 * ========================================================================== */
(function () {
  'use strict';
  if (window !== window.top) return;
  const C = globalThis.ubFsCore, E = globalThis.ubFsErp;
  const ID = 'ub-fs-panel';
  const LOCK = 'ubFsLock';
  const LOCK_MS = 120000;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const digits = (s) => String(s == null ? '' : s).replace(/[^\d]/g, '');
  const comma = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const ymd = (s) => String(s || '').replace(/^\d{2}(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3');

  const CSS = `
    #${ID}{position:fixed;inset:0;z-index:2147483000;background:rgba(17,24,39,.32);display:flex;align-items:flex-start;justify-content:center;
      padding:64px 16px 16px;box-sizing:border-box;font:14px/1.45 Pretendard,'Malgun Gothic',sans-serif;color:#1b1b1b}
    #${ID} *{box-sizing:border-box}
    #${ID} .bx{width:560px;max-width:100%;max-height:calc(100vh - 80px);overflow:auto;background:#fff;border-radius:12px;
      box-shadow:0 12px 40px rgba(17,24,39,.16);padding:20px}
    #${ID} .hd{display:flex;align-items:center;gap:8px;margin:0 0 16px}
    #${ID} .hd h3{margin:0;font-size:16px;font-weight:700}
    #${ID} .hd .bc{font-size:13px;font-weight:600;color:#2a8f99;background:#eaf7f8;padding:3px 8px;border-radius:6px;font-variant-numeric:tabular-nums}
    #${ID} .it{display:flex;gap:12px;align-items:center;padding:12px;background:#f6f8f9;border-radius:8px}
    #${ID} .it img{width:56px;height:56px;object-fit:cover;border-radius:8px;border:1px solid #e3e7eb;background:#fff;flex:none}
    #${ID} .it .code{font-weight:600;font-variant-numeric:tabular-nums}
    #${ID} .sub{font-size:12px;color:#6b7280}
    #${ID} .lb{display:block;font-size:12px;font-weight:600;color:#4b5563;margin:16px 0 6px}
    #${ID} input[type=text]{width:100%;height:38px;border:1px solid #d5dbe0;border-radius:8px;padding:0 10px;font:inherit;font-size:14px;color:#1b1b1b;background:#fff}
    #${ID} input[type=text]:focus-visible{outline:2px solid #4abcc7;outline-offset:1px;border-color:#4abcc7}
    #${ID} .cands{display:flex;flex-direction:column;gap:4px}
    #${ID} .cands label{display:flex;gap:8px;align-items:center;padding:8px 10px;border:1px solid #e3e7eb;border-radius:8px;cursor:pointer;font-size:13px}
    #${ID} .cands label:has(input:checked){border-color:#4abcc7;background:#f0fafb}
    #${ID} .cands input{accent-color:#4abcc7;margin:0}
    #${ID} .cands .d{color:#6b7280;font-variant-numeric:tabular-nums}
    #${ID} .src{font-size:12px;color:#6b7280;margin-top:6px;min-height:18px}
    #${ID} .warn{color:#b45309}
    #${ID} .err{color:#d93a32}
    #${ID} .steps{margin:16px 0 0;padding:12px;list-style:none;font-size:13px;background:#f6f8f9;border-radius:8px}
    #${ID} .steps li{margin:2px 0}
    #${ID} .ft{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
    #${ID} button{height:38px;padding:0 16px;border-radius:8px;border:1px solid #d5dbe0;background:#fff;color:#1b1b1b;font:600 13px Pretendard,'Malgun Gothic',sans-serif;cursor:pointer}
    #${ID} button:hover{border-color:#4abcc7}
    #${ID} button:focus-visible{outline:2px solid #4abcc7;outline-offset:2px}
    #${ID} button.pri{background:#4abcc7;border-color:#4abcc7;color:#fff}
    #${ID} button.pri:hover{background:#3aa9b4;border-color:#3aa9b4}
    #${ID} button:disabled{opacity:.45;cursor:not-allowed}
  `;

  let running = false;
  function close() {
    if (running) return;                      // 진행 중엔 닫지 않는다(숨은 iframe 이 끊긴다)
    const el = document.getElementById(ID);
    if (el) el.remove();
  }

  async function open(barcode, setStatus) {
    if (running) { setStatus('다른 품목을 진행 중입니다', 'warn'); return; }
    close();
    setStatus('불러오는 중… ' + barcode, 'go');
    const item = await E.readItem(barcode);
    if (!item.ok) { setStatus(barcode + ' — ' + item.msg, 'err'); return; }
    const cl = await E.listCandidates(item.itemNum);
    if (!cl.ok) { setStatus(barcode + ' — ' + cl.msg, 'err'); return; }
    setStatus(barcode + ' 확인 창을 열었습니다', 'go');
    render(barcode, item, cl.list, setStatus);
  }

  function render(barcode, item, cands, setStatus) {
    const root = document.createElement('div');
    root.id = ID;
    root.innerHTML = '<style>' + CSS + '</style>' +
      '<div class="bx" role="dialog" aria-modal="true" aria-labelledby="ubfs-t">' +
        '<div class="hd"><h3 id="ubfs-t">패션 상품 재고화</h3><span class="bc">' + esc(barcode) + '</span></div>' +
        '<div class="it">' + (item.img ? '<img src="' + esc(item.img) + '" alt="">' : '') +
          '<div><div class="code">' + esc(item.itemNum) + '</div>' +
          '<div class="sub">현재 추가설명 ' + esc(item.desc || '(비어 있음)') + ' · 판매가 ' + esc(comma(item.salePrice || 0)) + '</div></div></div>' +
        '<span class="lb">고객 · 최근 7일 같은 상품 주문완료</span><div class="cands">' +
          (cands.length
            ? cands.map((c, i) => '<label><input type="radio" name="ubfs-c" value="' + i + '"' + (cands.length === 1 ? ' checked' : '') + '>' +
                '<span class="d">' + esc(ymd(c.orderDate)) + '</span><b>' + esc(c.customer) + '</b><span class="d">' + esc(c.junNum) + '</span></label>').join('')
            : '<div class="err">후보 주문이 없습니다. 진행할 수 없습니다</div>') +
        '</div>' +
        '<label class="lb" for="ubfs-desc">추가설명</label><input type="text" id="ubfs-desc" autocomplete="off" spellcheck="false">' +
        '<label class="lb" for="ubfs-price">소비자가 · 판매가</label><input type="text" id="ubfs-price" inputmode="numeric" autocomplete="off">' +
        '<div class="src" id="ubfs-src"></div>' +
        '<ul class="steps" id="ubfs-steps" hidden></ul>' +
        '<div class="ft"><button type="button" id="ubfs-close">닫기</button><button type="button" class="pri" id="ubfs-go" disabled>진행</button></div>' +
      '</div>';
    document.body.appendChild(root);
    const $ = (s) => root.querySelector(s);
    const desc = $('#ubfs-desc'), price = $('#ubfs-price'), src = $('#ubfs-src'), go = $('#ubfs-go');
    let cand = null, seq = 0;
    const refresh = () => { go.disabled = running || !(cand && +digits(price.value) > 0 && desc.value.trim()); };
    const pick = async (i) => {
      cand = cands[i];
      desc.value = C.fsComposeDesc(item.desc, C.fsCategoryLetter(item.itemNum), cand.customer);
      price.value = ''; src.textContent = '판매가 찾는 중…'; src.className = 'src'; refresh();
      const my = ++seq;
      const r = await E.lookupPrice(cand, desc.value, item.k);
      if (my !== seq) return;                 // 그 사이 다른 고객을 골랐다
      if (r.ok) { price.value = comma(r.price); src.textContent = '출처: ' + r.src; src.className = 'src'; }
      else { src.textContent = r.msg + ' — 판매가를 직접 넣어 주세요'; src.className = 'src warn'; }
      refresh();
    };
    root.querySelectorAll('input[name=ubfs-c]').forEach((el) => el.addEventListener('change', () => pick(+el.value)));
    desc.addEventListener('input', refresh);
    price.addEventListener('input', () => { const d = digits(price.value); price.value = d ? comma(+d) : ''; refresh(); });
    $('#ubfs-close').addEventListener('click', close);
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    go.addEventListener('click', () => run(barcode, item, cand, desc.value.trim(), +digits(price.value), root, setStatus));
    if (cands.length === 1) pick(0);
    (cands.length > 1 ? root.querySelector('input[name=ubfs-c]') : desc).focus();
  }

  const sget = (k) => new Promise((res) => { try { chrome.storage.local.get({ [k]: null }, (d) => res(d && d[k])); } catch (_) { res(null); } });
  const sset = (o) => new Promise((res) => { try { chrome.storage.local.set(o, res); } catch (_) { res(); } });
  const sdel = (k) => new Promise((res) => { try { chrome.storage.local.remove(k, res); } catch (_) { res(); } });

  async function run(barcode, item, cand, desc, price, root, setStatus) {
    if (running || !cand || !(price > 0) || !desc) return;
    const steps = root.querySelector('#ubfs-steps');
    steps.hidden = false;
    steps.innerHTML = '';
    const li = (t) => {
      const e = document.createElement('li');
      e.textContent = '… ' + t;
      steps.appendChild(e);
      return (ok, m) => { e.textContent = (ok ? '✔ ' : '✖ ') + t + (m ? ' — ' + m : ''); e.className = ok ? '' : 'err'; };
    };
    const held = await sget(LOCK);
    if (held && held.bc === barcode && Date.now() - held.at < LOCK_MS) { li('잠금')(false, '같은 바코드를 다른 창에서 진행 중'); return; }
    running = true;
    root.querySelectorAll('input,button').forEach((el) => { el.disabled = true; });
    await sset({ [LOCK]: { bc: barcode, at: Date.now() } });
    try {
      let s = li('품목 수정 · 추가설명 · 판매가 ' + comma(price));
      let r = await E.saveItem(item.modifyUrl, { desc, price });
      if (r.ok) r = await E.verifyItem(item.modifyUrl, { desc, price });
      s(r.ok, r.msg);
      if (!r.ok) { setStatus(barcode + ' 품목 수정 실패 — 입고장에서 직접 확인', 'err'); return; }
      s = li('본사확인 · ' + cand.customer);
      const h = await E.hqConfirm(cand);
      s(h.ok, h.msg || h.note);
      if (!h.ok) { setStatus(barcode + ' 품목 수정 완료 · 본사확인부터 직접', 'warn'); return; }
      s = li('배정 · ' + barcode);
      const a = await E.assign(cand, barcode, h.rowHtml);
      s(a.ok, a.msg);
      if (!a.ok) { setStatus(barcode + ' 수정·본사확인 완료 · 배정은 직접', 'warn'); return; }
      setStatus(barcode + ' → ' + cand.customer + ' 입고완료', 'ok');
    } finally {
      running = false;
      await sdel(LOCK);
      const cb = root.querySelector('#ubfs-close');
      if (cb) { cb.disabled = false; cb.focus(); }
    }
  }

  globalThis.ubFs = { open, close };
})();
