/* =============================================================================
 *  write-journal.test.js — write-ahead 저널 + 계정 전역 writer lock (Phase 0 → §3.7·§5).
 *
 *  background.js 는 MV3 SW IIFE 라 require 할 수 없다.
 *  → auto-orchestrator.test.js 와 같은 방식으로 소스에서 선언을 이름으로 추출해
 *    새 Function 샌드박스에서 평가한다(리네임하면 추출 실패로 즉사한다).
 *
 *  ⚠ 이 파일을 PowerShell 로 편집하지 마라. Set-Content -Encoding utf8 이 BOM 을 붙이고
 *    Get-Content -Raw 가 cp949 로 읽어 한글을 통째로 깨뜨린다(이 저장소가 실제로 당한 함정).
 *
 *  스펙: docs/superpowers/specs/2026-07-20-orderitem-batch-design.md §3.7·§5·§3.6
 *  실행: node tests/write-journal.test.js
 * ========================================================================== */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BG = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');

function extractFn(src, name, where) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `${where} 에서 ${name} 선언을 찾지 못했습니다 (리네임 여부 확인)`);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 본문의 중괄호 균형을 찾지 못했습니다`);
}

// const NAME = ... ; 를 괄호 균형으로 잘라낸다(화살표 함수 상수 포함).
function extractConst(src, name, where) {
  const m = new RegExp('const\\s+' + name + '\\s*=').exec(src);
  assert.ok(m, `${where} 에서 ${name} 상수를 찾지 못했습니다`);
  let depth = 0;
  for (let i = m.index; i < src.length; i++) {
    const c = src[i];
    if (c === '[' || c === '{' || c === '(') depth++;
    else if (c === ']' || c === '}' || c === ')') depth--;
    else if (c === ';' && depth === 0) return src.slice(m.index, i + 1);
  }
  throw new Error(`${name} 선언의 끝을 찾지 못했습니다`);
}

// let NAME = ...; 버전(ubAutoStorageChain 뮤텍스 변수 — const 가 아니라 재대입된다).
function extractLet(src, name, where) {
  const m = new RegExp('let\\s+' + name + '\\s*=').exec(src);
  assert.ok(m, `${where} 에서 ${name} 변수를 찾지 못했습니다`);
  let depth = 0;
  for (let i = m.index; i < src.length; i++) {
    const c = src[i];
    if (c === '[' || c === '{' || c === '(') depth++;
    else if (c === ']' || c === '}' || c === ')') depth--;
    else if (c === ';' && depth === 0) return src.slice(m.index, i + 1);
  }
  throw new Error(`${name} 선언의 끝을 찾지 못했습니다`);
}

// 이번 slice 에서 추가한 것 + 그것들이 의존하는 기존 선언(계정 식별·TTL 상수).
const BG_CONSTS = [
  'UB_AUTO_HARD_TTL_MS', 'UB_AUTO_IDLE_TTL_MS',                 // 기존 — lock TTL 재사용
  'ubNormName', 'ubGetFlow',                                    // 기존 — 계정 식별과 같은 값·비교
  'ubAutoLog',                                                  // 기존 — 로그 재사용
  'UB_AUTO_JOURNAL_KEY', 'UB_AUTO_LOCK_KEY',
  'UB_AUTO_JOURNAL_STATES', 'UB_AUTO_JOURNAL_PENDING_STATES'
];
const BG_FNS = [
  'ubAutoSerialize',
  'ubAutoJournalStorageGet', 'ubAutoJournalStorageSet',
  'ubAutoValidateJournalEntry',
  'ubAutoJournalPersistInner', 'ubAutoJournalPersist',
  'ubAutoJournalGet', 'ubAutoJournalAll', 'ubAutoJournalPendingEntries',
  'ubAutoJournalReconcileInner', 'ubAutoJournalReconcile',
  'ubAutoJournalRecoverOnStartup',
  'ubAutoWriterLockExpired',
  'ubAutoWriterLockStorageGet', 'ubAutoWriterLockStorageSet', 'ubAutoWriterLockStorageClear',
  'ubAutoWriterLockRead', 'ubAutoLockOwnerMatches',
  'ubAutoAcquireWriterLockInner', 'ubAutoAcquireWriterLock',
  'ubAutoReleaseWriterLockInner', 'ubAutoReleaseWriterLock',
  'ubAutoCurrentAccountKey',
  'ubAutoGuardAccount', 'ubAutoGuardWrite',
  'ubAutoDispatchNativeWrite'
];

/* ---- chrome.storage 목(mock) ----
 *  session/local 을 완전히 분리된 평범한 객체로 시뮬레이션한다. 문자열 키 형태의
 *  get/set/remove 만 지원 — 이 모듈이 실제로 쓰는 형태가 그것뿐이다.
 */
let sessionStore, localStore;
function resetStorage() { sessionStore = {}; localStore = {}; }
const fakeChrome = {
  storage: {
    session: {
      get: async (key) => ({ [key]: sessionStore[key] }),
      set: async (obj) => { Object.assign(sessionStore, obj); },
      remove: async (key) => { delete sessionStore[key]; }
    },
    local: {
      get: async (key) => ({ [key]: localStore[key] })
    }
  }
};

const bg = {};
// eslint-disable-next-line no-new-func
new Function('exports', 'chrome', 'console',
  BG_CONSTS.map(n => extractConst(BG, n, 'background.js')).join('\n') + '\n' +
  extractLet(BG, 'ubAutoStorageChain', 'background.js') + '\n' +
  BG_FNS.map(n => extractFn(BG, n, 'background.js')).join('\n') + '\n' +
  [...BG_CONSTS, ...BG_FNS].map(n => `exports.${n} = ${n};`).join('\n')
)(bg, fakeChrome, { log: () => {} });

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ---------- 목 헬퍼 ---------- */
const OWNER_A = { jobId: 'ubauto_jobA', tabId: 1, documentId: 'docA' };
const OWNER_B = { jobId: 'ubauto_jobB', tabId: 2, documentId: 'docB' };

function baseEntry(over) {
  return Object.assign({
    nonce: 'n1', jobId: OWNER_A.jobId, feature: 'C', account: 'accA',
    tabId: OWNER_A.tabId, orderSeq: '12345', operation: 'CALL_STANDBY',
    expectedPreState: 'O--', expectedState: 'OS-', expectedBarcode: null,
    state: 'WRITE_DISPATCHING'
  }, over || {});
}
async function acquireA() {
  return bg.ubAutoAcquireWriterLock(Object.assign({ account: 'accA' }, OWNER_A));
}

/* ---------- ① 저널: 기본 상태·검증 ---------- */

test('ubAutoJournalPersist: 필수 필드 누락은 거부(fail closed)', async () => {
  resetStorage();
  assert.equal((await bg.ubAutoJournalPersist(null)).error, 'invalid_entry');
  assert.equal((await bg.ubAutoJournalPersist(baseEntry({ nonce: '' }))).error, 'missing_nonce');
  assert.equal((await bg.ubAutoJournalPersist(baseEntry({ state: 'BOGUS' }))).error, 'invalid_state');
  assert.equal((await bg.ubAutoJournalPersist(baseEntry({ account: '' }))).error, 'missing_account');
  assert.equal((await bg.ubAutoJournalPersist(baseEntry({ orderSeq: '' }))).error, 'missing_orderSeq');
  assert.equal((await bg.ubAutoJournalPersist(baseEntry({ operation: '' }))).error, 'missing_operation');
  assert.deepStrictEqual(await bg.ubAutoJournalAll(), [], '거부된 시도가 저널에 남으면 안 된다');
});

test('ubAutoJournalPersist: 성공하면 즉시 storage 에서 다시 읽힌다(핵심 불변식의 전제)', async () => {
  resetStorage();
  const r = await bg.ubAutoJournalPersist(baseEntry());
  assert.ok(r.ok, JSON.stringify(r));
  const got = await bg.ubAutoJournalGet('n1');
  assert.equal(got.state, 'WRITE_DISPATCHING');
  assert.ok(Number.isFinite(got.createdAt) && Number.isFinite(got.updatedAt));
});

test('ubAutoJournalPersist: 같은 nonce 재저장은 createdAt 을 보존하고 updatedAt 만 간다', async () => {
  resetStorage();
  await bg.ubAutoJournalPersist(baseEntry());
  const first = await bg.ubAutoJournalGet('n1');
  await new Promise(r => setTimeout(r, 2));
  await bg.ubAutoJournalPersist(baseEntry({ state: 'WRITE_DISPATCHED' }));
  const second = await bg.ubAutoJournalGet('n1');
  assert.equal(second.createdAt, first.createdAt);
  assert.ok(second.updatedAt >= first.updatedAt);
  assert.equal(second.state, 'WRITE_DISPATCHED');
});

/* ---------- ② 완료 기준 필수 시나리오 1 — 저널 미기록 상태에서 dispatch 시도 → 거부 ---------- */

test('★저널 미기록 상태에서 dispatch 시도 → 거부되고 writeFn 은 절대 호출되지 않는다', async () => {
  resetStorage();
  const acq = await acquireA();
  assert.ok(acq.ok, 'lock 취득 실패: ' + JSON.stringify(acq));
  let calls = 0;
  const r = await bg.ubAutoDispatchNativeWrite(
    Object.assign({ nonce: 'never-journaled', account: 'accA' }, OWNER_A),
    async () => { calls++; return 'should-not-run'; }
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, 'journal_not_ready');
  assert.equal(calls, 0, 'writeFn 이 호출됐다 — 저널 없이 쓰기가 나갔다');
});

test('dispatch: lock 자체가 없으면 저널이 있어도 거부된다(lock_not_held)', async () => {
  resetStorage();
  await bg.ubAutoJournalPersist(baseEntry());
  let calls = 0;
  const r = await bg.ubAutoDispatchNativeWrite(
    Object.assign({ nonce: 'n1', account: 'accA' }, OWNER_A),
    async () => { calls++; }
  );
  assert.equal(r.error, 'lock_not_held');
  assert.equal(calls, 0);
});

test('dispatch: 저널이 PREPARED(아직 WRITE_DISPATCHING 아님)면 거부된다', async () => {
  resetStorage();
  await acquireA();
  await bg.ubAutoJournalPersist(baseEntry({ state: 'PREPARED' }));
  let calls = 0;
  const r = await bg.ubAutoDispatchNativeWrite(
    Object.assign({ nonce: 'n1', account: 'accA' }, OWNER_A),
    async () => { calls++; }
  );
  assert.equal(r.error, 'journal_not_ready');
  assert.equal(calls, 0);
});

test('dispatch: 저널이 WRITE_DISPATCHING 이고 lock·계정이 맞으면 writeFn 을 부르고 WRITE_DISPATCHED 로 남긴다', async () => {
  resetStorage();
  await acquireA();
  await bg.ubAutoJournalPersist(baseEntry());
  let calls = 0;
  const r = await bg.ubAutoDispatchNativeWrite(
    Object.assign({ nonce: 'n1', account: 'accA' }, OWNER_A),
    async () => { calls++; return 'ok-result'; }
  );
  assert.equal(calls, 1);
  assert.deepStrictEqual(r, { ok: true, result: 'ok-result', dispatched: true });
  const got = await bg.ubAutoJournalGet('n1');
  assert.equal(got.state, 'WRITE_DISPATCHED');
  assert.ok(Number.isFinite(got.dispatchedAt));
});

test('dispatch: writeFn 이 던져도 WRITE_DISPATCHED 로 남는다(§3.6 — dispatch 는 이미 일어났다)', async () => {
  resetStorage();
  await acquireA();
  await bg.ubAutoJournalPersist(baseEntry());
  const r = await bg.ubAutoDispatchNativeWrite(
    Object.assign({ nonce: 'n1', account: 'accA' }, OWNER_A),
    async () => { throw new Error('network-flaked'); }
  );
  assert.equal(r.ok, false);
  assert.equal(r.dispatched, true, 'dispatched:true 여야 한다 — 재시도 여지를 주면 안 된다');
  assert.match(r.error, /network-flaked/);
  const got = await bg.ubAutoJournalGet('n1');
  assert.equal(got.state, 'WRITE_DISPATCHED', 'throw 여도 dispatch 시도 자체는 기록에 남아야 한다');
});

/* ---------- ③ 완료 기준 필수 시나리오 2 — SW 재시작 복구 ---------- */

test('★WRITE_DISPATCHING 남긴 채 재시작 → 자동 재시도 없이 NEEDS_REVIEW 로 뜨고 새 락 발급도 거부된다', async () => {
  resetStorage();
  await bg.ubAutoJournalPersist(baseEntry());  // "재시작 전" 상태를 그대로 흉내
  const recovered = await bg.ubAutoJournalRecoverOnStartup();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].state, 'NEEDS_REVIEW');
  const got = await bg.ubAutoJournalGet('n1');
  assert.equal(got.state, 'NEEDS_REVIEW');
  assert.equal(got.lastCheckResult.reason, 'sw_restart');
  // "새 쓰기 거부" — 락조차 없던 상태에서 새 배치를 시작하려 해도 pending 저널이 막는다.
  const acq = await acquireA();
  assert.equal(acq.ok, false);
  assert.equal(acq.error, 'pending_journal');
});

test('복구: WRITE_DISPATCHED 도 NEEDS_REVIEW 로 내려간다', async () => {
  resetStorage();
  await bg.ubAutoJournalPersist(baseEntry({ state: 'WRITE_DISPATCHED' }));
  const recovered = await bg.ubAutoJournalRecoverOnStartup();
  assert.equal(recovered.length, 1);
  assert.equal((await bg.ubAutoJournalGet('n1')).state, 'NEEDS_REVIEW');
});

test('복구: VERIFIED_SUCCESS·PREPARED 는 건드리지 않는다(이미 끝났거나 아직 안 나간 쓰기)', async () => {
  resetStorage();
  await bg.ubAutoJournalPersist(baseEntry({ nonce: 'done', state: 'VERIFIED_SUCCESS' }));
  await bg.ubAutoJournalPersist(baseEntry({ nonce: 'prep', state: 'PREPARED' }));
  const recovered = await bg.ubAutoJournalRecoverOnStartup();
  assert.equal(recovered.length, 0);
  assert.equal((await bg.ubAutoJournalGet('done')).state, 'VERIFIED_SUCCESS');
  assert.equal((await bg.ubAutoJournalGet('prep')).state, 'PREPARED');
});

/* ---------- ④ 완료 기준 필수 시나리오 3 — 계정 변경 즉시 거부 + 진행 중 건 미확정 ---------- */

test('★계정 A 로 락 취득 → 계정 B 로 바뀜 → 쓰기 즉시 거부 + 진행 중이던 건은 미확정', async () => {
  resetStorage();
  const acq = await acquireA();
  assert.ok(acq.ok);
  await bg.ubAutoJournalPersist(baseEntry());   // "진행 중이던 쓰기" = 이미 WRITE_DISPATCHING
  let calls = 0;
  const r = await bg.ubAutoDispatchNativeWrite(
    Object.assign({ nonce: 'n1', account: 'accB' }, OWNER_A),   // 같은 탭·문서, 계정만 바뀜
    async () => { calls++; }
  );
  assert.equal(calls, 0, '계정이 바뀌었는데 네이티브 쓰기가 호출됐다');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'account_changed');
  const got = await bg.ubAutoJournalGet('n1');
  assert.equal(got.state, 'NEEDS_REVIEW', '진행 중이던 건은 확정 실패가 아니라 미확정이어야 한다');
  assert.equal(got.lastCheckResult.reason, 'account_changed_before_dispatch');
});

test('계정 변경: 읽기 RPC 공통 관문(ubAutoGuardAccount)도 즉시 거부한다', async () => {
  resetStorage();
  await acquireA();
  const r = await bg.ubAutoGuardAccount(Object.assign({ account: 'accB' }, OWNER_A));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'account_changed');
});

/* ---------- ⑤ 완료 기준 필수 시나리오 4 — 같은 계정 두 탭 동시 락 요청 ---------- */

test('★같은 계정 두 탭 동시 락 요청 → 하나만 성공', async () => {
  resetStorage();
  const [ra, rb] = await Promise.all([
    bg.ubAutoAcquireWriterLock(Object.assign({ account: 'accA' }, OWNER_A)),
    bg.ubAutoAcquireWriterLock(Object.assign({ account: 'accA' }, OWNER_B))
  ]);
  const oks = [ra, rb].filter(r => r.ok);
  const fails = [ra, rb].filter(r => !r.ok);
  assert.equal(oks.length, 1, '정확히 하나만 성공해야 한다: ' + JSON.stringify([ra, rb]));
  assert.equal(fails.length, 1);
  assert.equal(fails[0].error, 'lock_held');
});

test('lock: 같은 소유자(tabId+documentId) 재요청은 갱신(heartbeat)이지 충돌이 아니다', async () => {
  resetStorage();
  const first = await acquireA();
  const second = await acquireA();
  assert.ok(second.ok);
  assert.equal(second.renewed, true);
  assert.ok(second.lock.lastRenewedAt >= first.lock.lastRenewedAt);
  assert.equal(second.lock.acquiredAt, first.lock.acquiredAt, 'hard TTL 기준(acquiredAt)은 갱신되면 안 된다');
});

test('lock: 같은 소유자인데 계정이 다르면 거부한다(owner_account_mismatch)', async () => {
  resetStorage();
  await acquireA();
  const r = await bg.ubAutoAcquireWriterLock(Object.assign({ account: 'accB' }, OWNER_A));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'owner_account_mismatch');
});

/* ---------- ⑥ 완료 기준 필수 시나리오 5 — TTL 만료 회수 / pending 저널 있으면 새 락 거부 ---------- */

test('★TTL(hard) 만료된 락은 다른 탭이 회수할 수 있다', async () => {
  resetStorage();
  const old = Date.now() - (bg.UB_AUTO_HARD_TTL_MS + 1000);
  sessionStore[bg.UB_AUTO_LOCK_KEY] = { owner: OWNER_A, account: 'accA', acquiredAt: old, lastRenewedAt: old };
  const r = await bg.ubAutoAcquireWriterLock(Object.assign({ account: 'accA' }, OWNER_B));
  assert.ok(r.ok, 'TTL 만료 락도 회수하지 못했다: ' + JSON.stringify(r));
  assert.equal(r.reclaimed, true);
  assert.deepStrictEqual(r.lock.owner, OWNER_B);
});

test('★TTL(idle) 만료도 동일하게 회수된다', async () => {
  resetStorage();
  const now = Date.now();
  sessionStore[bg.UB_AUTO_LOCK_KEY] = {
    owner: OWNER_A, account: 'accA',
    acquiredAt: now,                                        // hard TTL 은 안 지남
    lastRenewedAt: now - (bg.UB_AUTO_IDLE_TTL_MS + 1000)     // idle TTL 만 지남
  };
  const r = await bg.ubAutoAcquireWriterLock(Object.assign({ account: 'accA' }, OWNER_B));
  assert.ok(r.ok);
});

test('★pending 저널이 있으면(락이 없어도) 새 락 발급을 거부한다', async () => {
  resetStorage();
  await bg.ubAutoJournalPersist(baseEntry({ state: 'NEEDS_REVIEW' }));
  const r = await acquireA();
  assert.equal(r.ok, false);
  assert.equal(r.error, 'pending_journal');
  assert.equal(r.pending.length, 1);
});

test('pending 저널: PREPARED·VERIFIED_SUCCESS 는 락 발급을 막지 않는다', async () => {
  resetStorage();
  await bg.ubAutoJournalPersist(baseEntry({ nonce: 'p', state: 'PREPARED' }));
  await bg.ubAutoJournalPersist(baseEntry({ nonce: 'v', state: 'VERIFIED_SUCCESS' }));
  const r = await acquireA();
  assert.ok(r.ok, 'PREPARED/VERIFIED_SUCCESS 가 새 락을 막았다: ' + JSON.stringify(r));
});

test('pending 저널: 만료된 락 회수 시도도 pending 저널이 있으면 막는다', async () => {
  resetStorage();
  const old = Date.now() - (bg.UB_AUTO_HARD_TTL_MS + 1000);
  sessionStore[bg.UB_AUTO_LOCK_KEY] = { owner: OWNER_A, account: 'accA', acquiredAt: old, lastRenewedAt: old };
  await bg.ubAutoJournalPersist(baseEntry({ state: 'WRITE_DISPATCHED' }));
  const r = await bg.ubAutoAcquireWriterLock(Object.assign({ account: 'accA' }, OWNER_B));
  assert.equal(r.error, 'pending_journal');
});

/* ---------- ⑦ 그 밖의 fail-closed 경계 ---------- */

test('acquire: 계정 불명·소유자 불명은 거부된다', async () => {
  resetStorage();
  assert.equal((await bg.ubAutoAcquireWriterLock(Object.assign({ account: '' }, OWNER_A))).error, 'account_unknown');
  assert.equal((await bg.ubAutoAcquireWriterLock({ account: 'accA', tabId: 1 })).error, 'owner_unknown');
});

test('release: 소유자가 아니면 거부, 소유자면 실제로 비운다, 이미 비어있으면 조용히 무해하다', async () => {
  resetStorage();
  await acquireA();
  assert.equal((await bg.ubAutoReleaseWriterLock(OWNER_B)).error, 'not_owner');
  const ok = await bg.ubAutoReleaseWriterLock(OWNER_A);
  assert.deepStrictEqual(ok, { ok: true, released: true });
  const again = await bg.ubAutoReleaseWriterLock(OWNER_A);
  assert.deepStrictEqual(again, { ok: true, released: false });
  const acqAgain = await acquireA();
  assert.ok(acqAgain.ok, 'release 후에는 다시 발급 가능해야 한다');
});

test('reconcile: 알 수 없는 nonce 는 not_found', async () => {
  resetStorage();
  const r = await bg.ubAutoJournalReconcile('ghost', { verified: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_found');
});

test('reconcile: verified:true 만 VERIFIED_SUCCESS, 그 외 전부 NEEDS_REVIEW', async () => {
  resetStorage();
  await bg.ubAutoJournalPersist(baseEntry());
  const s = await bg.ubAutoJournalReconcile('n1', { verified: true, code: 'I--', barcode: 'B1' });
  assert.equal(s.entry.state, 'VERIFIED_SUCCESS');
  await bg.ubAutoJournalPersist(baseEntry({ nonce: 'n2' }));
  const f = await bg.ubAutoJournalReconcile('n2', { verified: false });
  assert.equal(f.entry.state, 'NEEDS_REVIEW');
  await bg.ubAutoJournalPersist(baseEntry({ nonce: 'n3' }));
  const u = await bg.ubAutoJournalReconcile('n3', null);
  assert.equal(u.entry.state, 'NEEDS_REVIEW', '재조회 결과가 없어도(null) 성공으로 새면 안 된다');
});

test('ubAutoJournalPendingEntries: account/orderSeq 필터가 정확히 좁힌다', async () => {
  resetStorage();
  await bg.ubAutoJournalPersist(baseEntry({ nonce: 'a1', account: 'accA', orderSeq: '1' }));
  await bg.ubAutoJournalPersist(baseEntry({ nonce: 'a2', account: 'accA', orderSeq: '2' }));
  await bg.ubAutoJournalPersist(baseEntry({ nonce: 'b1', account: 'accB', orderSeq: '1' }));
  const byAccount = await bg.ubAutoJournalPendingEntries({ account: 'ACCA' });   // 대소문자 무시
  assert.equal(byAccount.length, 2);
  const byBoth = await bg.ubAutoJournalPendingEntries({ account: 'accA', orderSeq: '2' });
  assert.equal(byBoth.length, 1);
  assert.equal(byBoth[0].nonce, 'a2');
});

test('ubAutoCurrentAccountKey: ubLoginFlow.accountId 를 그대로 반환한다(새 개념 없음)', async () => {
  resetStorage();
  assert.equal(await bg.ubAutoCurrentAccountKey(), null, '전환 이력이 없으면 null(식별 불가)');
  localStore.ubLoginFlow = { accountId: 'shop01', phase: 'done', active: false };
  assert.equal(await bg.ubAutoCurrentAccountKey(), 'shop01');
});

test('ubAutoWriterLockExpired: 순수 함수 — hard 또는 idle 둘 중 하나만 지나도 만료', () => {
  const now = Date.now();
  assert.equal(bg.ubAutoWriterLockExpired(null, now), true);
  assert.equal(bg.ubAutoWriterLockExpired({ acquiredAt: now, lastRenewedAt: now }, now), false);
  assert.equal(bg.ubAutoWriterLockExpired({ acquiredAt: now - bg.UB_AUTO_HARD_TTL_MS - 1, lastRenewedAt: now }, now), true);
  assert.equal(bg.ubAutoWriterLockExpired({ acquiredAt: now, lastRenewedAt: now - bg.UB_AUTO_IDLE_TTL_MS - 1 }, now), true);
});

let passed = 0;
(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); passed += 1; console.log('PASS', name); }
    catch (error) { console.error('FAIL', name); throw error; }
  }
  console.log(`PASS ${passed}/${tests.length} tests`);
})();
