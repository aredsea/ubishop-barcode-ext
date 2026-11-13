/* =============================================================================
 *  orderimport-serverdup.test.js — 유비샵 서버 주문전표 목록 대조(oiServerDupCheck · oiServerDupRange) + 패널 배선 정적 검사.
 *  PC 로컬 장부는 다른 PC 의 등록을 모른다(2026-11-13 중복 3건) → 고객명 + 정산 금액으로 서버 목록과 대조한다.
 *  실행: node --test tests/orderimport-serverdup.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'src', 'orderimport-core.js'));
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const order = (clientName, settles, extra) => Object.assign({ clientName, lines: settles.map((s) => (typeof s === 'object' ? s : { settle: s })) }, extra || {});
const row = (title, status, junNum) => ({ orderSeq: '1', junNum: junNum || '2611130001', title, status: status == null ? '주문완료' : status });

test('고객명 + 정산 일치(상품은 다름) → same', () => {
  const r = C.oiServerDupCheck(order('김*숙6042/G', [538230]), [row('F-쿠션퀼팅E F-E-005E 김*숙6042/G 비고 : 정산 538,230 원')]);
  assert.equal(r.kind, 'same');
  assert.equal(r.rows.length, 1);
});

test('같은 고객·정산 금액만 다름 → customer', () => {
  const r = C.oiServerDupCheck(order('김*숙6042/G', [100000]), [row('F-쿠션퀼팅E F-E-005E 김*숙6042/G 비고 : 정산 538,230 원')]);
  assert.equal(r.kind, 'customer');
  assert.equal(r.rows.length, 1);
});

test('취소 행은 무시한다', () => {
  const r = C.oiServerDupCheck(order('김*숙6042/G', [538230]), [row('F-쿠션퀼팅E F-E-005E 김*숙6042/G 비고 : 정산 538,230 원', '주문취소')]);
  assert.equal(r.kind, 'none');
  assert.deepEqual(r.rows, []);
});

test('고객명 부분일치는 오탐이 아니다(앞뒤에 글자가 붙은 다른 고객)', () => {
  const rows = [
    row('F-링 T-1 A김진경9097/카 비고 : 정산 12,133 원'),
    row('F-링 T-1 김진경9097/카카 비고 : 정산 12,133 원')
  ];
  assert.equal(C.oiServerDupCheck(order('김진경9097/카', [12133]), rows).kind, 'none');
  assert.equal(C.oiServerDupCheck(order('김진경9097/카', [12133]), [row('F-링 T-1 김진경9097/카 비고 : 정산 12,133 원')]).kind, 'same');
});

test('상품명에 공백이 있는 title 도 읽는다', () => {
  const r = C.oiServerDupCheck(order('차윤희5138/카', [262778]), [row('F- 컷팅파이프링E(2.5cm) T-E6-I-PG-ZZ-005E 차윤희5138/카 비고 : 정산 262,778 원')]);
  assert.equal(r.kind, 'same');
});

test('정산 0(사은품) 줄만 있는 주문은 same 이 될 수 없다 — customer 이하', () => {
  const rows = [row('사은품 G-1 김*숙6042/G 비고 : 정산 0 원')];
  assert.equal(C.oiServerDupCheck(order('김*숙6042/G', [0, 0]), rows).kind, 'customer');
  assert.equal(C.oiServerDupCheck(order('김*숙6042/G', [0, 538230]), [row('X Y 김*숙6042/G 비고 : 정산 538,230 원')]).kind, 'same');
});

test('제외된 줄의 정산은 근거로 쓰지 않는다', () => {
  const o = order('김*숙6042/G', [{ settle: 538230, excluded: true }, { settle: 1000 }]);
  assert.equal(C.oiServerDupCheck(o, [row('X Y 김*숙6042/G 비고 : 정산 538,230 원')]).kind, 'customer');
});

test('clientName 이 비면 none', () => {
  assert.equal(C.oiServerDupCheck(order('', [1000]), [row('X Y  비고 : 정산 1,000 원')]).kind, 'none');
  assert.equal(C.oiServerDupCheck({ lines: [] }, [row('X Y 비고 : 정산 1,000 원')]).kind, 'none');
});

test("정규식 특수문자('*')는 이스케이프된다 — '김*숙' 이 '김가숙' 에 걸리지 않는다", () => {
  const rows = [row('X Y 김가숙6042/G 비고 : 정산 538,230 원'), row('X Y 김숙6042/G 비고 : 정산 538,230 원')];
  assert.equal(C.oiServerDupCheck(order('김*숙6042/G', [538230]), rows).kind, 'none');
});

test('rows 가 없거나 비면 none', () => {
  assert.equal(C.oiServerDupCheck(order('김*숙6042/G', [1]), null).kind, 'none');
  assert.equal(C.oiServerDupCheck(order('김*숙6042/G', [1]), []).kind, 'none');
});

test('oiServerDupRange: 14일 전~오늘, 월·일 2자리 패딩', () => {
  assert.deepEqual(C.oiServerDupRange(new Date(2026, 10, 13)), { syear: '2026', smonth: '10', sday: '30', eyear: '2026', emonth: '11', eday: '13' });
  assert.deepEqual(C.oiServerDupRange(new Date(2026, 0, 5), 14), { syear: '2025', smonth: '12', sday: '22', eyear: '2026', emonth: '01', eday: '05' });
  assert.deepEqual(C.oiServerDupRange(new Date(2026, 2, 9), 7), { syear: '2026', smonth: '03', sday: '02', eyear: '2026', emonth: '03', eday: '09' });
});

test('패널 배선: 어댑터 노출 · enrich 시작부와 run() 시작 직전(S.running 전)에만 조회', () => {
  const erp = read('src/orderimport-erp.js'), ui = read('src/orderimport.js');
  assert.match(erp, /async function listJunRowsRange/);
  assert.match(erp, /listJunRows, listJunRowsRange \}/);
  const iBody = ui.indexOf('async function enrichBody()');
  const head = ui.slice(iBody, iBody + 1400);
  assert.ok(head.indexOf('loadServerRows()') > 0 && head.indexOf('loadServerRows()') < head.indexOf('E.getWriteForm') || head.indexOf('E.getWriteForm') < 0, 'enrichBody 시작부(마스터 폼 조회 전) 조회');
  //  run 의 재조회는 enriching 대기 뒤 · S.running=true 앞 — 실행기의 sKey GET→POST 사이엔 끼지 않는다.
  const run = ui.slice(ui.indexOf('async function run()'), ui.indexOf('async function runTargets'));
  const iWait = run.indexOf('while (S.enriching)'), iRe = run.indexOf('await loadServerRows()'), iRun = run.indexOf('S.running = true');
  assert.ok(iWait >= 0 && iRe > iWait && iRun > iRe, '재조회 위치');
  assert.match(run, /server_dup_new/);
  assert.match(ui, /if \(o\.dup\.dup \|\| srvSame\(o\)\) return;/, '전체체크는 서버 same 도 건너뜀');
});

test('이름 안 공백 수가 달라도 같은 고객으로 본다(공백 정규화)', () => {
  assert.equal(C.oiServerDupCheck(order('홍 길동1234/카', [5000]), [row('X Y 홍  길동1234/카 비고 : 정산 5,000 원')]).kind, 'same');
  assert.equal(C.oiServerDupCheck(order(' 홍  길동1234/카 ', [5000]), [row('X Y 홍 길동1234/카 비고 : 정산 5,000 원')]).kind, 'same');
  assert.equal(C.oiServerDupCheck(order('홍 길동1234/카', [5000]), [row('X Y 홍길동1234/카 비고 : 정산 5,000 원')]).kind, 'none', '공백이 아예 없는 이름과는 다르다');
});

/* ------------------------------------------------------------------ 패널 동작(소스를 잘라 stub 위에서 실행)
 *  문자열 존재 검사로는 분기 회귀를 못 잡는다(Opus 검수 P2, 2026-11-13) → run()/refreshOrder/enrichBody/renderBody 등
 *  실제 소스를 잘라 S·E·C·confirm·alert·oiRunAll 기록 stub 위에서 돌린다. extractFn 은 orderimport-wiring.test.js 와 같은 방식. */
function extractFn(src, name) {
  const kw = src.indexOf('function ' + name + '(');
  assert.ok(kw >= 0, 'orderimport.js 에서 ' + name + ' 선언을 찾지 못했습니다');
  const start = (src.slice(kw - 6, kw) === 'async ') ? kw - 6 : kw;
  const open = src.indexOf('{', kw);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(name + ' 본문의 중괄호 균형을 찾지 못했습니다');
}
const PANEL_FNS = ['refreshOrder', 'loadServerRows', 'enrichBody', 'run', 'runTargets', 'counts', 'renderBody', 'srvChip', 'orderRow', 'onChange'];
const TITLE = (name, settle) => 'F-링 T-1 ' + name + ' 비고 : 정산 ' + settle + ' 원';
function panel(opts) {
  const ui = read('src/orderimport.js');
  const srvLine = ui.match(/^\s*const srvSame = [^\n]*$/m);
  assert.ok(srvLine, 'srvSame 선언');
  const code = srvLine[0] + '\n' + PANEL_FNS.map((n) => extractFn(ui, n)).join('\n') + '\nreturn { srvSame, ' + PANEL_FNS.join(', ') + ' };';
  const rec = { runAll: [], confirms: [], alerts: [], listCalls: 0, html: '' };
  const listQ = (opts && opts.list) || [];
  const S = { enabled: true, ledger: {}, orders: [], hiddenOrders: [], masters: {}, running: false, starting: false, enriching: null, results: [], log: [],
    server: { rows: null, at: '', error: '', capped: false }, phase: 'idle', progress: { done: 0, total: 0, m: [0, 0], c: [0, 0], s: [0, 0], key: '', label: '' } };
  const E = {
    listJunRowsRange: async (range) => {
      rec.listCalls++; rec.range = range;
      const r = listQ.length ? listQ.shift() : { rows: [] };
      if (r instanceof Error) throw r;
      return { rows: r.rows, capped: !!r.capped };
    },
    getWriteForm: async () => { throw new Error('getWriteForm 은 이 테스트에서 불리면 안 된다'); }
  };
  const CC = Object.assign({}, C, {
    oiOrderReady: (o) => o._ready !== false,
    oiDupCheck: (o) => o._dup || { dup: false, kind: 'none' },
    oiPostRunState: () => ({ ledgerEntry: null, uncheck: true }),
    oiRunAll: async (jobs, e, hooks) => {
      rec.runAll.push(jobs.map((j) => j.key));
      const out = jobs.map((j) => ({ key: j.key, status: 'done' }));
      out.forEach((r) => hooks.onOrder(r));
      return out;
    }
  });
  const confirmAns = (opts && opts.confirm) || [];
  const stubs = {
    S, E, C: CC,
    confirm: (m) => { rec.confirms.push(m); return confirmAns.length ? confirmAns.shift() : true; },
    alert: (m) => { rec.alerts.push(m); },
    render: () => {}, renderSoft: () => {}, progPatch: () => {}, saveLedger: () => {}, logLine: () => {},
    loadState: async () => {}, refreshLine: () => {}, hasWarn: () => false, toRunOrder: (o) => ({ key: o.key }),
    window: { addEventListener() {}, removeEventListener() {} }, onUnload: () => {},
    progInit: () => {}, progStep: () => {},
    PANEL_ID: 'p', document: { getElementById: () => ({ querySelector: () => ({ set innerHTML(v) { rec.html = v; } }) }) },
    ico: () => '', esc: (s) => String(s == null ? '' : s), chip: (cls, text) => '[' + cls + ':' + text + ']',
    custChip: () => '', marketPick: () => '', resultChip: (r) => '[result:' + r.status + ']', prevChip: () => '', lineRow: () => ''
  };
  const names = Object.keys(stubs);
  // eslint-disable-next-line no-new-func
  const fns = new Function(...names, code)(...names.map((n) => stubs[n]));
  return Object.assign(fns, { S, E, rec });
}
const mkOrder = (key, name, settle, extra) => Object.assign({ key, clientName: name, lines: [{ settle }], market: { code: 'x' }, customer: { mode: 'reuse' }, phone: { phone: '010' }, seller: 's', orderNo: key, buyer: 'b' }, extra || {});

test('패널 동작: refreshOrder — 첫 판정 same 이면 체크 해제, 사람이 다시 켠 체크는 다음 판정에서 유지, customer 는 체크에 영향 없음', () => {
  const P = panel();
  const a = mkOrder('A', '김가1111/카', 5000), b = mkOrder('B', '박나2222/카', 7000);
  P.S.orders = [a, b];
  P.S.server.rows = [row(TITLE('김가1111/카', '5,000')), row(TITLE('박나2222/카', '9,999'))];
  P.S.orders.forEach(P.refreshOrder);
  assert.equal(a.sdup.kind, 'same'); assert.equal(a.checked, false, '첫 판정 same → 해제');
  assert.equal(b.sdup.kind, 'customer'); assert.equal(b.checked, true, 'customer 는 체크 유지');
  a.checked = true;                                   // 사람이 알고 다시 켬
  P.refreshOrder(a);
  assert.equal(a.checked, true, '사람 체크 존중');
  //  same 이 풀렸다가(목록에서 사라짐) 다시 same 이 되면 '새로 same' 이라 다시 해제
  P.S.server.rows = []; P.refreshOrder(a); assert.equal(a.checked, true);
  P.S.server.rows = [row(TITLE('김가1111/카', '5,000'))]; P.refreshOrder(a); assert.equal(a.checked, false, '새로 same → 해제');
});

test('패널 동작: ledgered(이번 실행에서 완료된) 주문은 서버 same 에서 빠진다', () => {
  const P = panel();
  const a = mkOrder('A', '김가1111/카', 5000, { ledgered: true, checked: true });
  P.S.orders = [a];
  P.S.server.rows = [row(TITLE('김가1111/카', '5,000'))];
  P.refreshOrder(a);
  assert.equal(a.sdup.kind, 'same');
  assert.equal(P.srvSame(a), false);
  assert.equal(a.checked, true, 'ledgered 는 서버 same 으로 체크를 풀지 않는다');
  assert.equal(P.counts().nSrv, 0);
  assert.equal(P.srvChip(a), '', '칩 숨김');
});

test('패널 동작: run — confirm 뒤 재조회에서 새로 same 이 된 주문은 빼고 skipped(server_dup_new), 확인 때 이미 same 이던 주문은 실행, 장부 중복이어도 다른 관리번호로 새로 보이면 건너뜀, 결과 병합', async () => {
  const rowsAtConfirm = [row(TITLE('김가1111/카', '5,000'))];
  const rowsAfter = rowsAtConfirm.concat([row(TITLE('박나2222/카', '7,000')), row(TITLE('최라4444/카', '3,000'), '주문완료', '2611130044')]);
  const P = panel({ list: [{ rows: rowsAfter }] });
  const a = mkOrder('A', '김가1111/카', 5000), b = mkOrder('B', '박나2222/카', 7000), c = mkOrder('C', '이다3333/카', 1000);
  const d = mkOrder('D', '최라4444/카', 3000, { _dup: { dup: true, kind: 'same' } });   // 이 PC 장부 중복(관리번호 2611120099) — 사람이 알고 체크
  P.S.ledger.D = { at: '2026-11-12T10:00:00Z', junNums: ['2611120099'], sig: 's' };
  P.S.orders = [a, b, c, d];
  P.S.server = { rows: rowsAtConfirm, at: new Date().toISOString(), error: '', capped: false };
  P.S.orders.forEach(P.refreshOrder);
  assert.deepEqual([a.checked, b.checked, c.checked, d.checked], [false, true, true, false]);
  a.checked = true; d.checked = true;                 // 사람이 알고 켬
  await P.run();
  assert.equal(P.rec.listCalls, 1, '시작 직전 재조회 1회');
  assert.deepEqual(P.rec.runAll, [['A', 'C']], 'B·D 가 빠진다(D 는 장부와 다른 관리번호로 새로 보임)');
  assert.match(d.result.reason, /^server_dup_new: 유비샵 목록에 같은 주문\(고객명·정산\)이 새로 보임 — 이전 시도분일 수 있으니 주문전표에서 확인$/);
  assert.match(P.rec.confirms[0], /유비샵에 이미 등록된 주문\(고객명·정산 금액 동일\) 1개/);
  assert.equal(b.result.status, 'skipped'); assert.match(b.result.reason, /^server_dup_new/);
  assert.equal(b.checked, false);
  assert.deepEqual(P.S.results.map((r) => r.key + ':' + r.status), ['B:skipped', 'D:skipped', 'A:done', 'C:done']);
  assert.equal(P.S.ledger.B, undefined, '장부엔 쓰지 않는다');
});

//  Opus 2R P2(2026-11-13): 장부 항목의 관리번호와 같은 서버 행만 대조에서 뺀다 — 장부가 있다는 이유로 재조회 판정을 통째로 생략하지 않는다.
async function runWithLedger(entry, extra, rowsAfter) {
  const P = panel({ list: [{ rows: rowsAfter }] });
  const x = mkOrder('X', '김*숙6042/카', 538230, Object.assign({ _dup: { dup: true, kind: 'same' } }, extra));
  P.S.ledger.X = entry;
  P.S.orders = [x];
  P.S.server = { rows: [], at: new Date().toISOString(), error: '', capped: false };
  P.refreshOrder(x);
  x.checked = true;                                   // 사람이 알고 체크
  await P.run();
  return { P, x };
}
const XROW = (jun) => row('X F-A 김*숙6042/카 비고 : 정산 538,230 원', '주문완료', jun);

test('패널 동작: run — (i) 장부 미확인 항목(관리번호 없음) + 확인 뒤 새 same 행 → 건너뜀', async () => {
  const { P, x } = await runWithLedger({ at: '2026-11-12T10:00:00Z', junNums: [], sig: 's', unverified: true, reason: 'line_unverified:timeout' }, {}, [XROW('2611130077')]);
  assert.equal(P.rec.runAll.length, 0, 'oiRunAll 에 넘어가지 않는다');
  assert.equal(x.result.status, 'skipped'); assert.match(x.result.reason, /^server_dup_new/);
  assert.match(P.rec.alerts[0], /확인하는 사이 유비샵 목록에 같은 주문이 새로 보여 등록하지 않았습니다 — 주문전표에서 확인하세요/);
});

test('패널 동작: run — (ii) 같은 세션 완료분(장부 관리번호 = 서버 행) 만 서버에 있으면 실행(사람이 알고 다시 넣음)', async () => {
  const { P } = await runWithLedger({ at: '2026-11-13T10:00:00Z', junNums: ['2611130050'], sig: 's' }, { ledgered: true }, [XROW('2611130050')]);
  assert.deepEqual(P.rec.runAll, [['X']]);
});

test('패널 동작: run — (iii) 장부 관리번호 행 + 다른 관리번호의 same 행 → 건너뜀', async () => {
  const { P, x } = await runWithLedger({ at: '2026-11-13T10:00:00Z', junNums: ['2611130050'], sig: 's' }, { ledgered: true }, [XROW('2611130050'), XROW('2611130051')]);
  assert.equal(P.rec.runAll.length, 0);
  assert.equal(x.result.status, 'skipped');
});

test('oiServerDupCheck excludeJuns: 지정한 관리번호 행만 대조에서 빠진다(빈 관리번호 행은 안 빠짐)', () => {
  const o = order('김*숙6042/G', [538230]);
  const t = 'X Y 김*숙6042/G 비고 : 정산 538,230 원';
  assert.equal(C.oiServerDupCheck(o, [row(t, '주문완료', 'J1')], { excludeJuns: ['J1'] }).kind, 'none');
  assert.equal(C.oiServerDupCheck(o, [row(t, '주문완료', 'J1'), row(t, '주문완료', 'J2')], { excludeJuns: ['J1'] }).rows.map((r) => r.junNum).join(), 'J2');
  assert.equal(C.oiServerDupCheck(o, [{ orderSeq: '1', junNum: '', title: t, status: '주문완료' }], { excludeJuns: [''] }).kind, 'same');
  assert.equal(C.oiServerDupCheck(o, [row(t, '주문완료', 'J1')]).kind, 'same', 'opts 없으면 기존 동작');
});

test('패널 동작: run — 재조회에서 남은 주문이 없으면 실행하지 않고 skipped 만 남긴다', async () => {
  const P = panel({ list: [{ rows: [row(TITLE('박나2222/카', '7,000'))] }] });
  const b = mkOrder('B', '박나2222/카', 7000);
  P.S.orders = [b]; P.S.server = { rows: [], at: new Date().toISOString(), error: '', capped: false };
  P.refreshOrder(b);
  await P.run();
  assert.equal(P.rec.runAll.length, 0);
  assert.equal(P.S.running, false);
  assert.deepEqual(P.S.results.map((r) => r.key + ':' + r.status), ['B:skipped']);
  assert.equal(P.rec.alerts.length, 1);
});

test('패널 동작: run — 재조회 실패 + 사람이 취소하면 실행 0회, 진행하면 전원 실행', async () => {
  const mk = () => [mkOrder('A', '김가1111/카', 5000), mkOrder('B', '박나2222/카', 7000)];
  const P1 = panel({ list: [new Error('boom')], confirm: [true, false] });
  P1.S.orders = mk(); P1.S.server = { rows: [], at: new Date().toISOString(), error: '', capped: false };
  P1.S.orders.forEach(P1.refreshOrder);
  await P1.run();
  assert.equal(P1.rec.runAll.length, 0, '취소 → 실행 없음');
  assert.equal(P1.S.running, false);
  assert.match(P1.rec.confirms[1], /유비샵 중복 재확인에 실패했습니다\(boom\)/);
  assert.equal(P1.S.server.error, 'boom');

  const P2 = panel({ list: [new Error('boom')], confirm: [true, true] });
  P2.S.orders = mk(); P2.S.server = { rows: [row(TITLE('박나2222/카', '7,000'))], at: new Date().toISOString(), error: '', capped: false };
  P2.S.orders.forEach(P2.refreshOrder);
  P2.S.orders[1].checked = true;                      // 사람이 알고 켠 same
  await P2.run();
  assert.equal(P2.rec.confirms.length, 2);
  assert.deepEqual(P2.rec.runAll, [['A', 'B']], '진행 → 체크된 전원 실행');
});

test('패널 동작: enrichBody 는 마스터 폼 조회 전에 서버 목록을 읽고 o.sdup 을 채운다(실패는 S.server.error)', async () => {
  const P = panel({ list: [{ rows: [row(TITLE('김가1111/카', '5,000'))], capped: true }] });
  const a = mkOrder('A', '김가1111/카', 5000);
  a.lines[0].suggest = [];                            // 추천 검색 건너뜀
  P.S.orders = [a];
  P.refreshOrder(a); assert.equal(a.sdup, null); assert.equal(a.checked, true);
  await P.enrichBody();
  assert.equal(P.rec.listCalls, 1);
  assert.match(P.rec.range.smonth, /^\d\d$/);
  assert.equal(a.sdup.kind, 'same'); assert.equal(a.checked, false);
  assert.equal(P.S.server.capped, true);

  const F = panel({ list: [new Error('session_lost: x')] });
  const b = mkOrder('B', '박나2222/카', 7000); b.lines[0].suggest = [];
  F.S.orders = [b];
  await F.enrichBody();
  assert.equal(F.S.server.error, 'session_lost: x');
  F.renderBody();
  assert.match(F.rec.html, /유비샵 중복 확인 실패 — 다른 PC에서 넣은 주문을 못 거릅니다: session_lost: x/);
});

test('패널 동작: 전체체크는 서버 same 을 건너뛰고, 배너·행 표시가 서버 same 을 센다', async () => {
  const P = panel();
  const a = mkOrder('A', '김가1111/카', 5000), c = mkOrder('C', '이다3333/카', 1000);
  P.S.orders = [a, c];
  P.S.server = { rows: [row(TITLE('김가1111/카', '5,000'), '입고완료 (250NOZ)', '2611120007')], at: '', error: '', capped: true };
  P.S.orders.forEach(P.refreshOrder);
  c.checked = false;
  await P.onChange({ target: { dataset: { f: 'chkall' }, checked: true } });
  assert.equal(a.checked, false, '서버 same 은 전체체크가 켜지 않는다');
  assert.equal(c.checked, true);
  const cnt = P.counts();
  assert.equal(cnt.nSrv, 1); assert.equal(cnt.nAll, 1); assert.equal(cnt.nChkAll, 1);
  P.renderBody();
  assert.match(P.rec.html, /유비샵에 이미 등록된 것과 같은 주문장 1개는 체크를 풀어 두었습니다/);
  assert.match(P.rec.html, /최근 14일 주문이 500건을 넘어 일부만 대조했습니다/);
  assert.match(P.orderRow(a, 0), /^<tr class="oi-o[^"]* dup/, '행 빨간 표시');
  assert.doesNotMatch(P.orderRow(c, 1), /^<tr class="oi-o[^"]* dup/);
  assert.match(P.srvChip(a), /\[dup:유비샵에 이미 등록 · 관리번호 2611120007 · 입고완료 \(250NOZ\)\]/);
});

/* ------------------------------------------------------------------ erp 어댑터(fetch stub) */
function junHtml(n) {
  let h = '<table class="t_list"><tr><th>주문장번호</th><th>고객명</th><th>상태</th></tr>';
  for (let i = 0; i < n; i++) h += '<tr><td><input type="checkbox" name="idx" value="' + (1000 + i) + '">26-11-13 2611130' + String(i % 1000).padStart(3, '0') + '</td><td>' + TITLE('고객' + i + '/카', '1,000') + '</td><td>주문완료</td></tr>';
  return h + '</table>';
}
async function withErp(resp, fn) {
  const saved = globalThis.fetch, savedErp = globalThis.ubOiErp;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { url: 'https://www.ubshop.biz/jun/orderitem/orderItemList.do', status: resp.status == null ? 200 : resp.status, arrayBuffer: async () => new TextEncoder().encode(resp.html).buffer };
  };
  try {
    // eslint-disable-next-line no-new-func
    new Function(read('src/orderimport-erp.js'))();
    return await fn(globalThis.ubOiErp, calls);
  } finally { globalThis.fetch = saved; globalThis.ubOiErp = savedErp; }
}
const RANGE = { syear: '2026', smonth: '10', sday: '30', eyear: '2026', emonth: '11', eday: '13' };

test('erp listJunRowsRange: 요청 파라미터 고정 · 500행이면 capped, 499행이면 아님', async () => {
  await withErp({ html: junHtml(500) }, async (E, calls) => {
    const r = await E.listJunRowsRange(RANGE);
    assert.equal(r.rows.length, 500); assert.equal(r.capped, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/jun/orderitem/orderItemList.do?tcode=order_item');
    assert.equal(calls[0].init.method, 'POST');
    const b = calls[0].init.body;
    const want = { tcode: 'order_item', reqPage: '1', pageSize: '500', searchSortType: 'seq', searchItemStatus: '', searchDateType: 'a.orderDate', syear: '2026', smonth: '10', sday: '30', eyear: '2026', emonth: '11', eday: '13' };
    for (const [k, v] of Object.entries(want)) assert.equal(b.get(k), v, k);
  });
  await withErp({ html: junHtml(499) }, async (E) => {
    const r = await E.listJunRowsRange(RANGE);
    assert.equal(r.rows.length, 499); assert.equal(r.capped, false);
  });
});

test('erp listJunRowsRange: 0건 목록은 정상, 머리글 없는 페이지·200 아닌 응답은 던진다', async () => {
  await withErp({ html: junHtml(0) }, async (E) => { assert.deepEqual(await E.listJunRowsRange(RANGE), { rows: [], capped: false }); });
  await withErp({ html: '<html><body>잠시 후 다시 시도하세요</body></html>' }, async (E) => {
    await assert.rejects(E.listJunRowsRange(RANGE), /머리글 없음/);
  });
  await withErp({ html: junHtml(3), status: 500 }, async (E) => {
    await assert.rejects(E.listJunRowsRange(RANGE), /order_list_http_500/);
  });
});

//  라이브 14열 형식(2026-11-13, 발주처명 열이 있는 화면 — 439행 전부 이 형식): '이름 주문 비고 : 정산 N [원] 발주 비고 : …'.
//  4.4.8 은 '이름 비고 :' 만 받아 이 형식의 행을 하나도 못 잡았다(라이브 읽기 대조에서 발견).
test('14열 형식 — 이름 뒤 "주문 비고 :" 도 읽는다', () => {
  const t = 'SN212 F-NF-Z-XY-PA-00FP 정다경0037/아 주문 비고 : 정산 51,614 원 발주 비고 : 정산 51,614 원';
  assert.equal(C.oiServerDupCheck(order('정다경0037/아', [51614]), [row(t)]).kind, 'same');
  assert.equal(C.oiServerDupCheck(order('정다경0037/아', [9999]), [row(t)]).kind, 'customer');
});

test('14열 형식 — 정산 뒤 "원" 이 빠져도 같은 금액이면 same', () => {
  const t = 'PRH0026(2mm) F-RF-I-YG-ZZ-005M 신선정0840/카 주문 비고 : 정산 247,682 발주 비고 :';
  assert.equal(C.oiServerDupCheck(order('신선정0840/카', [247682]), [row(t)]).kind, 'same');
});

test('14열 형식 — 발주 비고 쪽 정산만 맞아도 same, 이름 앞(상품명)의 "정산" 숫자는 근거가 아니다', () => {
  assert.equal(C.oiServerDupCheck(order('정다경0037/아', [51614]), [row('X Y 정다경0037/아 주문 비고 : 발주 비고 : 정산 51,614 원')]).kind, 'same');
  assert.equal(C.oiServerDupCheck(order('정다경0037/아', [51614]), [row('정산 51,614 기념 Y 정다경0037/아 주문 비고 : 정산 1 원')]).kind, 'customer');
});

test('14열 형식 — 앞뒤에 글자가 붙은 다른 고객은 여전히 오탐 아님', () => {
  assert.equal(C.oiServerDupCheck(order('김진경9097/카', [12133]), [row('X Y 김진경9097/카카 주문 비고 : 정산 12,133 원')]).kind, 'none');
});
