const assert = require('node:assert');
const { ubSha256Hex } = require('../src/loader.js');
const enc = (s) => new TextEncoder().encode(s);

// NIST FIPS 180-4 test vectors
assert.strictEqual(ubSha256Hex(enc('abc')),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
assert.strictEqual(ubSha256Hex(enc('')),
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
assert.strictEqual(ubSha256Hex(enc('The quick brown fox jumps over the lazy dog')),
  'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
console.log('Task1 sha256 vectors OK');

const { ubVerifyBundle } = require('../src/loader.js');
const B = (s) => new TextEncoder().encode(s);
const hx = (s) => ubSha256Hex(B(s));

// 정상: 전부 일치 → ok + bundle
(function(){
  const man = { version:'1', files:['a.js','b.js'], sha256:{ 'a.js':hx('AAA'), 'b.js':hx('BBB') } };
  const r = ubVerifyBundle(man, { 'a.js':B('AAA'), 'b.js':B('BBB') });
  assert.strictEqual(r.ok, true);
  assert.ok(r.bundle.code.includes('AAA') && r.bundle.code.includes('BBB'));
  assert.strictEqual(r.bundle.version, '1');
})();
// 1개 불일치 → INTEGRITY_MISMATCH:<path>, bundle 없음
(function(){
  const man = { version:'1', files:['a.js','b.js'], sha256:{ 'a.js':hx('AAA'), 'b.js':hx('BBB') } };
  const r = ubVerifyBundle(man, { 'a.js':B('AAA'), 'b.js':B('CORRUPT') });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'INTEGRITY_MISMATCH:b.js');
  assert.strictEqual(r.bundle, null);
})();
// 불완전 매니페스트(해시 누락) → INTEGRITY_INCOMPLETE
(function(){
  const man = { version:'1', files:['a.js','b.js'], sha256:{ 'a.js':hx('AAA') } };
  const r = ubVerifyBundle(man, { 'a.js':B('AAA'), 'b.js':B('BBB') });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'INTEGRITY_INCOMPLETE');
})();
// 파일 누락(fetch 안 됨) → FILE_MISSING:<path>
(function(){
  const man = { version:'1', files:['a.js'], sha256:{ 'a.js':hx('AAA') } };
  const r = ubVerifyBundle(man, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'FILE_MISSING:a.js');
})();
// 빈 files → INTEGRITY_INCOMPLETE (빈 번들 캐시 방지)
(function(){
  const r = ubVerifyBundle({ version:'1', files:[], sha256:{} }, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'INTEGRITY_INCOMPLETE');
  assert.strictEqual(r.bundle, null);
})();
console.log('Task2 verifyBundle OK');

const fs = require('node:fs'), path = require('node:path');
const ROOT = path.join(__dirname,'..');

/* Task3: shell-files.json 교차검증 — 전 파일, 단 '작업 중'에는 건너뛴다.
 *  ★종전엔 popup/popup.js **한 개만** 대조했다(그 작업에서 안 건드리는 안정 파일이라).
 *   그래서 **skin.js 해시가 낡아도 초록불**이었고, 그 함정을 전체로 3번 밟았다
 *   (2026-08-03 인수인계 — 매번 사람 검수자가 잡았다).
 *  ★그렇다고 무조건 전 파일을 대조하면 껍데기를 고치는 순간부터 릴리스까지 상시 빨간불이다.
 *  ★판정을 'shell-files.version === manifest.version' 으로 하면 **양쪽 다 틀린다**:
 *   배포 절차가 `껍데기 수정 → 버전 올림 → 재생성`(build-shell-index.ps1 머리말) 이라
 *   작업 중에는 두 버전이 **같으므로** 상시 빨간불이 되고, 반대로 버전만 먼저 올려 두면
 *   재생성을 통째로 잊어도 **조용히 통과**한다.
 *  → 판정자는 git 작업 트리다. 인덱스를 아직 재생성하지 않은 순수 작업 중에만 건너뛴다.
 *    - 껍데기가 dirty 인데 shell-files.json 은 그대로  → 작업 중         → SKIP
 *    - 그 밖의 모든 상태(깨끗한 트리 = 커밋된 상태 / 인덱스를 재생성한 상태) → 전량 대조
 *   이러면 "재생성한 뒤 소스를 또 고쳤다"(= 실제로 밟은 함정)는 shell-files.json 이 dirty 라
 *   즉시 빨간불이고, "재생성을 잊고 커밋했다" 는 트리가 깨끗해지는 순간 빨간불이다.
 *  ⚠ git 을 못 쓰면 **대조하는 쪽**으로 넘어간다(fail-closed). 조용히 통과시키지 않는다.
 */
//  build-shell-index.ps1 의 $patterns 와 같은 순서.
const SHELL_PATTERNS = [
  'manifest.json','src/loader.js','src/localbridge.js','src/fsm.js','src/background.js',
  'src/skin.js','popup/popup.html','popup/popup.js','rules/cache.json'
];
//  ★icons 는 **목록을 박아 두면 안 된다** — 생성 스크립트가 `icons/*` 전체를 동적으로 담기
//   때문이다. 박아 두면 아이콘을 새로 넣고 재생성을 잊었을 때, 인덱스도 기대 목록도 옛 3개라
//   서로 맞고 새 파일은 git pathspec 에도 안 걸려 **깨끗한 트리에서도 초록불**이 된다
//   (Codex 검수 2026-08-03). 생성기와 똑같이 디렉터리를 읽어 대조한다.
//  ⚠ 생성기는 `Get-ChildItem -File`(`-Force` 없음)이라 **숨김·시스템 파일을 안 담는다.**
//   readdir 은 담으므로 그대로 두면 `Thumbs.db`(Hidden+System) 하나에 "재생성 필요" 로 빨개지는데
//   **재생성해도 안 고쳐진다**(생성기는 계속 무시). 이 저장소 .gitignore 가 이미 그 파일들을
//   담고 있다 = 실제로 생기는 파일이다. → 같은 것들을 여기서도 뺀다(Opus 검수 2026-08-03).
const ICON_SKIP = new Set(['thumbs.db','desktop.ini','.ds_store']);
function iconPaths(){
  return fs.readdirSync(path.join(ROOT,'icons'), { withFileTypes:true })
    .filter(e => e.isFile() && !ICON_SKIP.has(e.name.toLowerCase()))
    .map(e => 'icons/' + e.name);
}
// build-shell-index.ps1 의 $textExt 와 같아야 한다. 텍스트=CRLF→LF 정규화 / 그 밖=원본 바이트.
const SHELL_TEXT_EXT = ['.js','.json','.html','.htm','.css','.xml','.md','.txt','.svg'];
function shellHash(rel){
  const raw = fs.readFileSync(path.join(ROOT, rel));
  const bytes = SHELL_TEXT_EXT.includes(path.extname(rel).toLowerCase())
    ? Buffer.from(raw.toString('binary').replace(/\r\n/g,'\n'),'binary')
    : raw;
  return ubSha256Hex(new Uint8Array(bytes));
}
//  껍데기 중 지금 손대고 있는 파일들. git 이 없거나 실패하면 null(→ 대조하는 쪽).
//  ★결과를 **인덱스 입력 파일로 한정**한다. 종전엔 pathspec 에 `icons` 디렉터리를 통째로
//   넘기고 걸린 것을 다 dirty 로 셌는데, 그러면 인덱스 입력이 아닌 경로 하나(`icons/tmp/x.png`
//   같은 하위 디렉터리 파일)만 있어도 SKIP 이 발동해 **깨끗한 트리에서 낡은 인덱스가 exit 0 으로
//   통과**한다(Opus 검수 2026-08-03, 재현됨). 한정하면 rename 표기(`a -> b`)나 core.quotePath
//   인용 경로처럼 파싱이 어긋난 줄도 자동으로 빠진다 — 어긋나면 dirty 로 안 세고, 대조는 돈다.
//  ⚠ 새로 넣은 아이콘은 여기서 일부러 안 본다. 그건 위의 아이콘 집합 검사가 무조건 잡는다.
function dirtyShellPaths(inputs){
  try {
    const out = require('node:child_process')
      .execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--', ...inputs],
                    { encoding:'utf8', stdio:['ignore','pipe','ignore'] });
    const seen = new Set(inputs);
    return out.split('\n').map(l => l.slice(3).trim()).filter(p => seen.has(p));
  } catch (_) { return null; }
}
(function(){
  const shell = JSON.parse(fs.readFileSync(path.join(ROOT,'shell-files.json'),'utf8'));

  // ── 무조건 하는 검사: 구성·형식. 소스 **내용**을 고쳐도 빨개지지 않는다. ──
  //  ★개수(=== 12)가 아니라 목록으로 고정한다 — 개수만 보면 파일이 바뀌어도 통과한다.
  const idxPaths = shell.files.map(f => f.path);
  assert.deepStrictEqual(idxPaths.slice(0, SHELL_PATTERNS.length), SHELL_PATTERNS,
    'shell-files.json 의 껍데기 구성·순서가 바뀌었다(build-shell-index.ps1 의 $patterns 와 함께 갱신)');
  //  아이콘은 **집합**으로 본다 — 순서까지 보면 Get-ChildItem 과 readdir 의 정렬이 갈릴 때
  //  내용은 멀쩡한데 빨개진다. 빠진·남은 아이콘만 잡으면 된다.
  assert.deepStrictEqual(idxPaths.slice(SHELL_PATTERNS.length).sort(), iconPaths().sort(),
    'shell-files.json 의 아이콘 목록이 icons/ 실제 내용과 다르다(재생성 필요)');
  for (const f of shell.files){
    assert.ok(/^[0-9a-f]{64}$/.test(f.sha256||''), 'sha256 누락/형식: '+f.path);
    assert.ok(fs.existsSync(path.join(ROOT, f.path)), '인덱스에만 있고 실재하지 않는 파일: '+f.path);
  }

  // ── 조건부: 전 파일 해시 + 버전 ──
  const dirty = dirtyShellPaths([...idxPaths, 'shell-files.json']);
  const indexDirty = dirty === null ? true : dirty.includes('shell-files.json');
  const sourcesDirty = dirty === null ? false : dirty.some(p => p !== 'shell-files.json');
  if (sourcesDirty && !indexDirty){
    console.log('Task3 shell-files 전량 대조 SKIP — 작업 중(재생성 전): ' +
                dirty.filter(p => p !== 'shell-files.json').join(', '));
    return;
  }
  const manifestVer = JSON.parse(fs.readFileSync(path.join(ROOT,'manifest.json'),'utf8')).version;
  assert.strictEqual(shell.version, manifestVer,
    'shell-files.json 버전이 manifest 와 다르다 → build-shell-index.ps1 재생성이 빠졌다');
  for (const f of shell.files){
    assert.strictEqual(shellHash(f.path), f.sha256,
      'shell-files.json 해시가 낡았다(재생성 필요): '+f.path);
  }
  console.log('Task3 shell-files 전량 대조 OK — ' + shell.files.length + '개 파일 / v' + shell.version);
})();

// Task4: build-app-index.ps1 출력(app-files.json.sha256)이 loader 규약(ubSha256Hex)과 전 파일 일치
(function(){
  const app = JSON.parse(fs.readFileSync(path.join(__dirname,'..','app-files.json'),'utf8'));
  assert.ok(app.sha256, 'app-files.json sha256 맵 없음');
  // ★개수 상수(=== 6)는 '어떤' 파일인지를 못 지켜 파일 추가 때 숫자만 올리는 의식이 된다.
  //   그렇다고 개수 검사를 빼면 files+sha256 에서 파일을 '함께' 지웠을 때 아무도 못 잡는다
  //   (집합 일치는 양쪽이 같이 줄면 통과한다). → 배포 계약인 '순서 있는 구성' 자체를 고정한다.
  //   erp.js 는 소비자들이 bare ubErp 로 참조하므로 반드시 맨 앞이어야 한다.
  assert.deepStrictEqual(app.files, [
    'src/erp.js',
    'src/config.js',
    'src/overlay.js',
    'src/collector.js',
    'src/content.js',
    'src/cache-intercept.js',
    'src/statis.js',
    'src/masterprice.js'
  ], 'LOGIC 번들 구성·순서가 바뀌었다(의도한 변경이면 이 목록을 함께 갱신)');
  // files ↔ sha256 키 집합 일치 — 제거된 파일의 해시 잔재/누락을 잡는다(기존엔 검사 없었음).
  assert.deepStrictEqual(
    [...app.files].sort(), Object.keys(app.sha256).sort(),
    'app-files.json 의 files 와 sha256 키가 불일치(잔재 해시 또는 누락)');
  for (const rel of app.files){
    assert.ok(/^[0-9a-f]{64}$/.test(app.sha256[rel]||''), 'sha256 누락/형식: '+rel);
    const raw = fs.readFileSync(path.join(__dirname,'..',rel));
    const lf = Buffer.from(raw.toString('binary').replace(/\r\n/g,'\n'),'binary');
    assert.strictEqual(ubSha256Hex(new Uint8Array(lf)), app.sha256[rel], 'build-app-index 해시가 loader 규약과 불일치: '+rel);
  }
})();
console.log('Task4 app-files sha256 규약 일치(전 파일) OK');
