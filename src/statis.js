/* =============================================================================
 *  statis.js — 상품집계(sheetStatisList) 제품별 판매 통계 (v1)
 *  loader 동적로드(MAIN world). 상품집계 페이지에서만 동작.
 *
 *  흐름: [제품별 통계화] 버튼 → 월 전체 데이터 POST 재조회(pageSize=500 순차)
 *        → 단가(총공급가/수량) 50,000원 초과 행만 → 제품별 그룹핑 → 통계 오버레이
 *        → XLSX 다운로드.
 *
 *  그룹핑 규칙(사용자 확정 2026-07-02):
 *   · 단가 = 총공급가 ÷ 수량 > 50,000 인 행만 대상(이하 제외).
 *   · 자사(상품명이 "D자사/"로 시작): "D자사/" 제거 후 제품명 뒤 성별표기
 *     (SR·LR·S·L 모두)와 그 이후(옵션·괄호·/·*개) 잘라낸 것이 제품명.
 *     성별(SR/LR/S/L) 달라도 같은 제품명이면 합산.
 *     예) 루센트-폴드SR / 루센트-폴드LR → "루센트-폴드",
 *         피앙세SR-1(가드링) / 피앙세S-LR(1부DIA)/무광 → "피앙세",
 *         블링썸 메인-S → "블링썸 메인", 블링썸-L → "블링썸".
 *   · 사입(그 외): 이름 앞부분을 '(' 또는 '/' 전까지 코드로, 끝의 성별 S/L 1글자는
 *     떼어 병합. 예) E0121RS + E0121RL → "E0121R", N9405R/N9406R 는 숫자가 달라 별개.
 *
 *  loader 관리 파일이라 규칙 수정은 push 만으로 반영(crx 재배포 불필요).
 * ========================================================================== */
(function () {
  'use strict';
  if (!/\/statis\/sheet\/saleitem\/sheetStatisList\.do/.test(location.pathname)) return;

  const TAG = '[UB][statis]';
  const log = (...a) => { try { console.log(TAG, ...a); } catch (_) {} };
  const PRICE_MIN = 50000;
  const FETCH_PS = 500;

  /* ---------- 숫자/문자 유틸 ---------- */
  // 셀에 두 줄로 숫자가 겹쳐 들어오는 경우가 있어 "첫 번째 숫자"만 취한다.
  function firstNum(s) {
    const m = String(s == null ? '' : s).match(/-?[\d,]+(?:\.\d+)?/);
    return m ? parseFloat(m[0].replace(/,/g, '')) : 0;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function nf(n) { try { return Math.round(n).toLocaleString('ko-KR'); } catch (_) { return String(n); } }

  /* ---------- 상품코드 셀 → {code, name} ---------- */
  function splitCodeName(cellText) {
    const t = String(cellText || '').replace(/\s+/g, ' ').trim();
    // 앞 토큰이 코드(영숫자+하이픈), 나머지가 상품명
    const m = t.match(/^([A-Za-z0-9][A-Za-z0-9\-]*)\s+(.+)$/);
    if (m) return { code: m[1], name: m[2].trim() };
    return { code: t, name: t };
  }

  const isJasa = (name) => /^D?자사\//.test(name);

  // 자사 제품명 추출: "D자사/" 제거 후
  //  ① 이름에 '보조' 포함 → 그 앞까지(부모 제품에 종속). 예) 프쉬케보조S → 프쉬케
  //  ② 성별표기 잘라내되 '피앙세'와 '피앙세S'는 별개 제품으로 구분:
  //     - SR·LR(2글자): 이름에 붙어 있어도 성별 → 앞까지. 예) 피앙세SR → 피앙세, 루센트-폴드SR → 루센트-폴드
  //     - 단독 S·L: '구분자(공백/하이픈) 뒤'일 때만 성별. 예) 블링썸 메인-S → 블링썸 메인, 블링썸-L → 블링썸
  //       (이름에 그대로 붙은 단독 S 는 제품명 일부: 피앙세S-LR → 피앙세S, 피앙세S → 피앙세S)
  function jasaBase(name) {
    let s = name.replace(/^D?자사\//, '').trim();
    const bo = s.indexOf('보조');
    if (bo > 0) return s.slice(0, bo).replace(/[\s\-/]+$/, '').trim() || name;
    let cut = -1;
    const m2 = s.match(/(SR|LR)(?=$|[\s\-(/*0-9])/);       // 2글자 성별(글자에 붙어도 성별)
    if (m2) cut = m2.index;
    const m1 = s.match(/[\s\-](S|L)(?=$|[\s\-(/*0-9])/);    // 구분자 뒤 단독 S/L (구분자 위치에서 자름)
    if (m1 && (cut < 0 || m1.index < cut)) cut = m1.index;
    if (cut < 0) { const p = s.search(/[(/]/); if (p >= 0) cut = p; }
    if (cut >= 0) s = s.slice(0, cut);
    return s.replace(/[\s\-/]+$/, '').trim() || name;
  }
  // 사입 코드: '(' 또는 '/' 전까지 → 끝 성별 S/L 1글자 제거(병합).
  function saipKey(name) {
    let s = String(name).split(/[(/]/)[0].trim();
    s = s.replace(/[SL]$/, '');
    return s.trim() || name;
  }

  /* ---------- 검색폼 → 전체 데이터 POST 재조회 ---------- */
  function formParams() {
    const f = document.querySelector('form[name="form1"]');
    if (!f) return null;
    const p = new URLSearchParams();
    for (const el of f.elements) {
      if (!el.name) continue;
      const t = (el.type || '').toLowerCase();
      if (['submit', 'button', 'reset', 'image', 'file'].includes(t)) continue;
      if ((t === 'checkbox' || t === 'radio') && !el.checked) continue;
      p.append(el.name, el.value == null ? '' : el.value);
    }
    return { action: f.getAttribute('action') || location.pathname, params: p };
  }
  function readTotal() {
    const m = document.body.innerText.match(/총\s*:?\s*([0-9,]+)\s*개/);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  }
  async function fetchHtml(action, params) {
    const r = await fetch(action, {
      method: 'POST', credentials: 'include', cache: 'no-cache',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: params.toString()
    });
    const buf = await r.arrayBuffer();
    let html = '';
    try {
      html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      if ((html.match(/�/g) || []).length > 20) html = new TextDecoder('euc-kr').decode(buf);
    } catch (_) { try { html = new TextDecoder('euc-kr').decode(buf); } catch (__) {} }
    return html;
  }
  // 문서에서 t_list(수량 헤더 보유) 찾아 컬럼 인덱스 + 데이터행 반환
  function parseDoc(doc) {
    for (const t of doc.querySelectorAll('table.t_list')) {
      let hi = -1, cells = null;
      for (const r of t.rows) {
        const cs = [...r.cells].map(c => c.textContent.replace(/\s+/g, ' ').trim());
        if (cs.includes('수량')) { hi = r.rowIndex; cells = cs; break; }
      }
      if (hi < 0) continue;
      const idx = (nm) => cells.indexOf(nm);
      const rows = [];
      for (let i = hi + 1; i < t.rows.length; i++) {
        const r = t.rows[i];
        if (!/^\d+$/.test((r.cells[0] ? r.cells[0].textContent : '').replace(/\s+/g, ''))) continue;
        rows.push(r);
      }
      return { rows, cCode: idx('상품코드'), cQty: idx('수량'), cSup: idx('총공급가'), cSale: idx('판매가'), cDC: idx('DC금액'), cReal: idx('실판매가') };
    }
    return null;
  }
  async function loadAll(setStatus) {
    const fp = formParams();
    if (!fp) throw new Error('검색폼(form1)을 찾지 못했습니다');
    const total = readTotal();
    const pages = total > 0 ? Math.ceil(total / FETCH_PS) : 1;
    const items = [];
    let cSaleSeen = -1;
    for (let p = 1; p <= pages; p++) {
      setStatus(`전체 ${total}건 불러오는 중… (${p}/${pages})`);
      const params = new URLSearchParams(fp.params);
      params.set('pageSize', String(FETCH_PS));
      params.set('reqPage', String(p));
      const html = await fetchHtml(fp.action, params);
      const g = parseDoc(new DOMParser().parseFromString(html, 'text/html'));
      if (!g) throw new Error('결과 표(t_list)를 파싱하지 못했습니다 (로그인 만료?)');
      cSaleSeen = g.cSale;
      for (const r of g.rows) {
        const cn = splitCodeName(r.cells[g.cCode] ? r.cells[g.cCode].textContent : '');
        items.push({
          code: cn.code, name: cn.name,
          qty: firstNum(r.cells[g.cQty] && r.cells[g.cQty].textContent),
          sup: firstNum(r.cells[g.cSup] && r.cells[g.cSup].textContent),
          sale: g.cSale >= 0 ? firstNum(r.cells[g.cSale] && r.cells[g.cSale].textContent) : 0,
          dc: g.cDC >= 0 ? firstNum(r.cells[g.cDC] && r.cells[g.cDC].textContent) : 0,
          real: g.cReal >= 0 ? firstNum(r.cells[g.cReal] && r.cells[g.cReal].textContent) : 0
        });
      }
    }
    return { items, total, hasSale: cSaleSeen >= 0 };
  }

  /* ---------- 그룹핑 + 필터 ---------- */
  function buildGroups(items) {
    const map = new Map();
    let excluded = 0, kept = 0, gift = 0;
    for (const it of items) {
      if (/사은품/.test(it.name)) { gift++; continue; }   // 사은품은 순위에서 제외
      const unit = it.qty > 0 ? it.sup / it.qty : 0;   // 단가 = 총공급가 ÷ 수량
      if (unit <= PRICE_MIN) { excluded++; continue; }
      kept++;
      const jasa = isJasa(it.name);
      const base = jasa ? jasaBase(it.name) : saipKey(it.name);
      const key = (jasa ? 'J' : 'S') + '' + base;
      let g = map.get(key);
      if (!g) { g = { type: jasa ? '자사' : '사입', name: base, qty: 0, sup: 0, sale: 0, dc: 0, real: 0, members: [] }; map.set(key, g); }
      g.qty += it.qty; g.sup += it.sup; g.sale += it.sale; g.dc += it.dc; g.real += it.real; g.members.push(it);
    }
    const groups = [...map.values()].sort((a, b) => b.qty - a.qty || b.sup - a.sup);
    return { groups, excluded, kept, gift };
  }

  /* ---------- XLSX (라이브러리 없이 최소 구현: stored ZIP) ---------- */
  const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_T[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(files) {
    const enc = new TextEncoder();
    const u16 = n => [n & 255, (n >>> 8) & 255];
    const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
    const parts = [], central = []; let offset = 0;
    for (const f of files) {
      const nameB = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const local = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(nameB.length), u16(0));
      parts.push(new Uint8Array(local), nameB, data);
      const cd = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(nameB.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(offset));
      central.push(new Uint8Array(cd), nameB);
      offset += local.length + nameB.length + data.length;
    }
    let cdSize = 0; for (const c of central) cdSize += c.length;
    const eocd = [].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(cdSize), u32(offset), u16(0));
    const all = parts.concat(central, [new Uint8Array(eocd)]);
    let total = 0; for (const a of all) total += a.length;
    const out = new Uint8Array(total); let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }
  function colRef(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = (i - (m + 1)) / 26; } return s; }
  function sheetXml(aoa) {
    let sd = '';
    aoa.forEach((row, ri) => {
      let cs = '';
      row.forEach((v, ci) => {
        const ref = colRef(ci) + (ri + 1);
        if (typeof v === 'number' && isFinite(v)) cs += `<c r="${ref}"><v>${v}</v></c>`;
        else cs += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      });
      sd += `<row r="${ri + 1}">${cs}</row>`;
    });
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      sd + '</sheetData></worksheet>';
  }
  function buildXlsx(aoa) {
    const enc = new TextEncoder();
    const files = [
      { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>') },
      { name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
      { name: 'xl/workbook.xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="제품별통계" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>') },
      { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml(aoa)) }
    ];
    return zipStore(files);
  }
  function downloadXlsx(aoa, fname) {
    const blob = new Blob([buildXlsx(aoa)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
  function xlsxName() {
    const f = document.querySelector('form[name="form1"]');
    const g = n => { const el = f && f.elements[n]; return el ? el.value : ''; };
    const s = `${g('syear')}${g('smonth')}${g('sday')}`;
    const e = `${g('eyear')}${g('emonth')}${g('eday')}`;
    return (s && e) ? `상품집계_통계_${s}-${e}.xlsx` : '상품집계_통계.xlsx';
  }

  /* ---------- 통계 오버레이 ---------- */
  function ensureStyle() {
    if (document.getElementById('ub-stat-style')) return;
    const s = document.createElement('style');
    s.id = 'ub-stat-style';
    s.textContent = [
      '#ub-stat-mask{position:fixed;inset:0;background:rgba(15,20,25,.55);z-index:2147483646;}',
      '#ub-stat{position:fixed;inset:4% 3%;background:#fff;border-radius:14px;z-index:2147483647;',
      ' display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.4);font-family:Pretendard,"Malgun Gothic",sans-serif;color:#1b1b1b;overflow:hidden;}',
      '#ub-stat .hd{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid #e5e7eb;}',
      '#ub-stat .hd .t{font-size:15px;font-weight:800;}',
      '#ub-stat .hd .sum{font-size:12px;color:#6b7280;}',
      '#ub-stat .hd .sp{margin-left:auto;display:flex;gap:8px;}',
      '#ub-stat button{font-family:inherit;border:0;border-radius:8px;font-size:12.5px;font-weight:700;cursor:pointer;padding:8px 14px;}',
      '#ub-stat .bx{background:#1f8f52;color:#fff;} #ub-stat .bc{background:#eef1f5;color:#374151;}',
      '#ub-stat .bd{flex:1;overflow:auto;padding:0 18px 18px;}',
      '#ub-stat table{width:100%;border-collapse:collapse;font-size:12.5px;}',
      '#ub-stat thead th{position:sticky;top:0;background:#f3fbfe;color:#0f6f8c;font-weight:800;',
      ' padding:9px 8px;border-bottom:2px solid #35C5F0;text-align:right;white-space:nowrap;}',
      '#ub-stat thead th.l{text-align:left;}',
      '#ub-stat tbody td{padding:8px;border-bottom:1px solid #eef1f5;text-align:right;white-space:nowrap;}',
      '#ub-stat tbody td.l{text-align:left;} #ub-stat tbody tr.g{cursor:pointer;}',
      '#ub-stat tbody tr.g:hover{background:#f7fbfd;}',
      '#ub-stat .tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:700;}',
      '#ub-stat .tj{background:#e0f4fc;color:#0f8fb8;} #ub-stat .ts{background:#fdeede;color:#b8710f;}',
      '#ub-stat .rk{color:#9aa4af;font-weight:700;} #ub-stat .qty{font-weight:800;color:#111;}',
      '#ub-stat .exp{color:#35C5F0;font-weight:800;margin-left:5px;font-size:11px;user-select:none;}',
      '#ub-stat .det > td{background:#eef4f8;padding:8px 10px 12px 34px;}',
      '#ub-stat table.sub{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dbe6ee;border-radius:8px;overflow:hidden;}',
      '#ub-stat table.sub thead th{position:static;background:#f3f7fa;color:#54687a;font-weight:700;font-size:11px;',
      ' padding:6px 9px;border-bottom:1px solid #dce6ee;text-align:right;white-space:nowrap;}',
      '#ub-stat table.sub thead th.l{text-align:left;}',
      '#ub-stat table.sub tbody td{padding:5px 9px;border-bottom:1px solid #f1f5f8;text-align:right;font-size:11.5px;white-space:nowrap;color:#33414d;}',
      '#ub-stat table.sub tbody td.l{text-align:left;}',
      '#ub-stat table.sub tbody tr:nth-child(even){background:#fafcfe;}',
      '#ub-stat table.sub tbody tr:last-child td{border-bottom:0;}',
      '#ub-stat table.sub tbody td.c{color:#0f6f8c;font-weight:700;}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }
  function close() {
    ['ub-stat', 'ub-stat-mask'].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
  }
  function render(result, meta) {
    ensureStyle();
    close();
    const mask = document.createElement('div'); mask.id = 'ub-stat-mask';
    mask.addEventListener('click', close);
    const box = document.createElement('div'); box.id = 'ub-stat';
    const groups = result.groups;
    const totQty = groups.reduce((a, g) => a + g.qty, 0);
    const totSup = groups.reduce((a, g) => a + g.sup, 0);
    const totReal = groups.reduce((a, g) => a + g.real, 0);

    let rows = '';
    groups.forEach((g, i) => {
      const tag = g.type === '자사' ? '<span class="tag tj">자사</span>' : '<span class="tag ts">사입</span>';
      rows += `<tr class="g" data-i="${i}">` +
        `<td class="rk">${i + 1}</td>` +
        `<td class="l">${esc(g.name)} <span class="exp">▸</span></td>` +
        `<td class="l">${tag}</td>` +
        `<td class="qty">${nf(g.qty)}</td>` +
        `<td>${nf(g.sup)}</td>` +
        `<td>${nf(g.sale)}</td>` +
        `<td>${nf(g.dc)}</td>` +
        `<td>${nf(g.real)}</td>` +
        `<td>${g.members.length}</td></tr>`;
      const memRows = g.members.slice().sort((a, b) => b.qty - a.qty).map(m =>
        '<tr>' +
        `<td class="l">${esc(m.name)}</td>` +
        `<td>${nf(m.qty)}</td>` +
        `<td>${nf(m.sup)}</td>` +
        `<td>${nf(m.sale)}</td>` +
        `<td>${nf(m.dc)}</td>` +
        `<td>${nf(m.real)}</td>` +
        '</tr>').join('');
      rows += `<tr class="det" data-d="${i}" style="display:none"><td></td><td colspan="8">` +
        '<table class="sub"><thead><tr>' +
        '<th class="l">상품명</th><th>수량</th><th>총공급가</th><th>판매가</th><th>DC금액</th><th>실판매가</th>' +
        `</tr></thead><tbody>${memRows}</tbody></table></td></tr>`;
    });

    box.innerHTML =
      '<div class="hd">' +
        '<span class="t">제품별 판매 통계</span>' +
        `<span class="sum">제품군 ${groups.length}개 · 총수량 ${nf(totQty)} · 총공급가 ${nf(totSup)}원 · 총실판매가 ${nf(totReal)}원 · 단가 5만원 초과만 · 제외 ${result.excluded}행 · 사은품 제외 ${result.gift} · 기간 ${esc(meta)}</span>` +
        '<span class="sp"><button class="bx" id="ub-stat-xlsx">엑셀 다운로드(XLSX)</button><button class="bc" id="ub-stat-close">닫기</button></span>' +
      '</div>' +
      '<div class="bd"><table>' +
        '<thead><tr><th>#</th><th class="l">제품명</th><th class="l">구분</th><th>총수량</th><th>총공급가</th><th>총판매가</th><th>총DC금액</th><th>총실판매가</th><th>코드수</th></tr></thead>' +
        `<tbody>${rows}</tbody></table></div>`;

    document.body.appendChild(mask);
    document.body.appendChild(box);
    box.querySelector('#ub-stat-close').addEventListener('click', close);
    box.querySelectorAll('tr.g').forEach(tr => tr.addEventListener('click', () => {
      const d = box.querySelector(`tr.det[data-d="${tr.dataset.i}"]`);
      const caret = tr.querySelector('.exp');
      if (d) {
        const open = d.style.display === 'none';
        d.style.display = open ? '' : 'none';
        if (caret) caret.textContent = open ? '▾' : '▸';
      }
    }));
    box.querySelector('#ub-stat-xlsx').addEventListener('click', () => {
      const aoa = [['순위', '제품명', '구분', '총수량', '총공급가', '총판매가', '총DC금액', '총실판매가', '코드수']];
      groups.forEach((g, i) => aoa.push([i + 1, g.name, g.type, g.qty, Math.round(g.sup), Math.round(g.sale), Math.round(g.dc), Math.round(g.real), g.members.length]));
      downloadXlsx(aoa, xlsxName());
      log('xlsx 저장', xlsxName(), aoa.length - 1, '행');
    });
    log('통계 렌더', { groups: groups.length, excluded: result.excluded, kept: result.kept });
  }

  /* ---------- 버튼 ---------- */
  let running = false;
  async function runStats(btn) {
    if (running) return; running = true;
    const orig = btn.textContent;
    const setStatus = (t) => { btn.textContent = t; };
    btn.disabled = true;
    try {
      const { items, total } = await loadAll(setStatus);
      const result = buildGroups(items);
      const f = document.querySelector('form[name="form1"]');
      const g = n => { const el = f && f.elements[n]; return el ? el.value : ''; };
      const meta = `${g('syear')}-${g('smonth')}-${g('sday')} ~ ${g('eyear')}-${g('emonth')}-${g('eday')} (원본 ${total}건)`;
      render(result, meta);
    } catch (e) {
      log('실패', e);
      alert('통계화 실패: ' + (e && e.message ? e.message : e));
    } finally {
      running = false; btn.disabled = false; btn.textContent = orig;
    }
  }
  function addButton() {
    const anchor = document.querySelector('select[name="searchSortType"]');
    if (!anchor) { if (!addButton._n) { addButton._n = 1; setTimeout(addButton, 600); } return; }
    if (document.getElementById('ub-stat-btn')) return;
    const b = document.createElement('button');
    b.id = 'ub-stat-btn';
    b.type = 'button';
    b.textContent = '제품별 통계화';
    b.title = '단가 5만원 초과 제품을 제품별로 묶어 판매 통계 + 엑셀 다운로드';
    b.style.cssText = 'margin-left:6px;padding:3px 12px;background:#35C5F0;color:#fff;border:0;border-radius:6px;' +
      'font:700 12px/1.5 Pretendard,sans-serif;cursor:pointer;vertical-align:middle;';
    b.addEventListener('click', () => runStats(b));
    // skin.js 의 수량정렬 드롭다운 뒤에 오도록 약간 늦게 삽입
    anchor.parentNode.appendChild(b);
    log('통계화 버튼 추가');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addButton);
  else addButton();
})();
