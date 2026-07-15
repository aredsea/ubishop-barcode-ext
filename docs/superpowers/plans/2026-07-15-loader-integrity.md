# 작업 A — 로직채널 무결성 차단 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(권장) 또는 superpowers:executing-plans로 태스크별 실행. 스텝은 `- [ ]` 체크박스.

**Goal:** loader.js가 GitHub raw 로직 6파일을 all-or-nothing 해시 검증 후에만 실행하고, 실패 시 검증 통과분(last-known-good)만 실행해 손상·부분fetch·나쁜push를 차단한다.

**Architecture:** loader.js 내부에 순수 JS SHA-256을 넣어(http라 crypto.subtle 불가), app-files.json의 `sha256` 맵과 대조한다. 검증 통과분만 `UB_APP_CACHE_v1`에 저장(캐시 오염 차단). `app-files.json`은 `files`(문자열)를 그대로 두고 `sha256` 맵만 추가해 옛 loader와 하위호환. loader.js 변경은 shell채널(C# ExtSync)로 재설치 없이 배포.

**Tech Stack:** Vanilla JS(브라우저 IIFE + node require 가드), Node `assert`(단위테스트, 의존성 무), PowerShell(해시 인덱스 빌드).

## Global Constraints

- **기존 기능·환경 무손상**: 정상 경로 동작 불변, 하위호환, fail-safe. (spec §3.5)
- **자동 업데이트 = 재설치 불필요**: 모든 배포 경로가 재설치 없이 동작해야 함(하드 요구). (spec §3.6)
- **위협모델**: 손상·부분fetch·나쁜push만 방어. repo/계정 탈취는 범위 밖. (spec 위협모델)
- **자동 `chrome.runtime.reload()` 재도입 금지.** 자가업데이트 실험은 **매장 운영시간 외.**
- **버전 하우스룰**: patch 9→minor, minor 9→major. 다운그레이드 불가. loader 변경=shell채널이라 manifest v3.6.2→v3.6.3 + shell-files.json 갱신.
- **해시 규약**: LF 정규화 UTF-8 바이트의 SHA-256 소문자 hex(shell-files.json과 동일). raw=LF 제공이라 loader는 fetch 원바이트를 그대로 해시.
- **PII/자격증명/키 로깅 금지.** 실패 사유 코드는 파일경로까지만.
- **완료 = 검증(실측) 통과 + Codex 공동검수 통과.**

---

### Task 1: 순수 JS SHA-256 (`ubSha256Hex`)

**Files:**
- Modify: `src/loader.js` (IIFE 내부에 함수 추가 + node export 가드)
- Test: `tests/loader-integrity.test.js` (신규)

**Interfaces:**
- Produces: `ubSha256Hex(bytes: Uint8Array): string` — 소문자 64-hex. Task 2/3이 사용.
- Produces(테스트 목적): node에서 `require('../src/loader.js')` → `{ ubSha256Hex, ubVerifyBundle }` 반환(브라우저에선 `boot()` 실행).

- [ ] **Step 1: 실패 테스트 작성** — `tests/loader-integrity.test.js`

```js
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
```

- [ ] **Step 2: 실패 확인**

Run: `node tests/loader-integrity.test.js`
Expected: FAIL — `Cannot find module` 또는 `ubSha256Hex is not a function`(아직 미구현·미export).

- [ ] **Step 3: 최소 구현** — `src/loader.js`의 IIFE `'use strict';` 다음에 함수 추가:

```js
  // FIPS 180-4 SHA-256. bytes: Uint8Array → 소문자 64-hex. (http는 crypto.subtle 불가)
  function ubSha256Hex(bytes) {
    var K = new Uint32Array([
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
    var h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,
        h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
    var l=bytes.length, bitLenLo=(l*8)>>>0, bitLenHi=Math.floor(l/0x20000000);
    var withOne=l+1, k=((56-(withOne%64))+64)%64, total=withOne+k+8;
    var m=new Uint8Array(total); m.set(bytes); m[l]=0x80;
    m[total-8]=(bitLenHi>>>24)&255; m[total-7]=(bitLenHi>>>16)&255; m[total-6]=(bitLenHi>>>8)&255; m[total-5]=bitLenHi&255;
    m[total-4]=(bitLenLo>>>24)&255; m[total-3]=(bitLenLo>>>16)&255; m[total-2]=(bitLenLo>>>8)&255; m[total-1]=bitLenLo&255;
    var w=new Uint32Array(64), rotr=function(x,n){return (x>>>n)|(x<<(32-n));};
    for (var i=0;i<total;i+=64){
      for (var t=0;t<16;t++) w[t]=(m[i+4*t]<<24)|(m[i+4*t+1]<<16)|(m[i+4*t+2]<<8)|(m[i+4*t+3]);
      for (t=16;t<64;t++){
        var s0=rotr(w[t-15],7)^rotr(w[t-15],18)^(w[t-15]>>>3);
        var s1=rotr(w[t-2],17)^rotr(w[t-2],19)^(w[t-2]>>>10);
        w[t]=(w[t-16]+s0+w[t-7]+s1)|0;
      }
      var a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
      for (t=0;t<64;t++){
        var S1=rotr(e,6)^rotr(e,11)^rotr(e,25), ch=(e&f)^(~e&g);
        var t1=(h+S1+ch+K[t]+w[t])|0;
        var S0=rotr(a,2)^rotr(a,13)^rotr(a,22), maj=(a&b)^(a&c)^(b&c);
        var t2=(S0+maj)|0;
        h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
      }
      h0=(h0+a)|0;h1=(h1+b)|0;h2=(h2+c)|0;h3=(h3+d)|0;h4=(h4+e)|0;h5=(h5+f)|0;h6=(h6+g)|0;h7=(h7+h)|0;
    }
    var toHex=function(x){return ('00000000'+(x>>>0).toString(16)).slice(-8);};
    return toHex(h0)+toHex(h1)+toHex(h2)+toHex(h3)+toHex(h4)+toHex(h5)+toHex(h6)+toHex(h7);
  }
```

그리고 IIFE 맨 끝의 `boot();`(현 line 71)을 아래로 교체(node에서 boot 미실행 + export):

```js
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ubSha256Hex: ubSha256Hex, ubVerifyBundle: ubVerifyBundle };
  } else {
    boot();
  }
```
(⚠ `ubVerifyBundle`은 Task 2에서 정의. Task 1 단계에선 export 라인에서 `ubVerifyBundle` 참조를 잠시 빼거나 Task 2까지 함께 진행. 권장: Task 1·2를 연속 구현 후 export 한 번에.)

- [ ] **Step 4: 통과 확인**

Run: `node tests/loader-integrity.test.js`
Expected: PASS — `Task1 sha256 vectors OK`.

- [ ] **Step 5: 커밋**

```bash
git add src/loader.js tests/loader-integrity.test.js
git commit -m "feat(A): loader 순수JS SHA-256(ubSha256Hex) + NIST 벡터 테스트"
```

---

### Task 2: 번들 검증 (`ubVerifyBundle`)

**Files:**
- Modify: `src/loader.js`
- Test: `tests/loader-integrity.test.js`

**Interfaces:**
- Consumes: `ubSha256Hex`.
- Produces: `ubVerifyBundle(manifest, bytesByPath): { ok, reason, bundle }`
  - `manifest = { version, files: string[], sha256: {path: hex} }`
  - `bytesByPath = { path: Uint8Array }` (이미 fetch된 원바이트)
  - 반환: 성공 `{ ok:true, reason:'', bundle:{ version, code } }`, 실패 `{ ok:false, reason, bundle:null }`
  - `reason` ∈ `INTEGRITY_INCOMPLETE`, `INTEGRITY_MISMATCH:<path>`, `FILE_MISSING:<path>`

- [ ] **Step 1: 실패 테스트 추가** — `tests/loader-integrity.test.js` 하단:

```js
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
console.log('Task2 verifyBundle OK');
```

- [ ] **Step 2: 실패 확인**

Run: `node tests/loader-integrity.test.js`
Expected: FAIL — `ubVerifyBundle is not a function`.

- [ ] **Step 3: 최소 구현** — `src/loader.js`에 `ubSha256Hex` 다음 추가:

```js
  // 매니페스트 sha256 맵과 fetch 바이트를 all-or-nothing 대조. utf-8 decode → 이어붙일 코드.
  function ubBytesToUtf8(bytes){
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    return Buffer.from(bytes).toString('utf8'); // node 테스트 폴백
  }
  function ubVerifyBundle(manifest, bytesByPath){
    var files = manifest && manifest.files, hashes = manifest && manifest.sha256;
    if (!files || !hashes) return { ok:false, reason:'INTEGRITY_INCOMPLETE', bundle:null };
    var i, p, want, got, parts = [];
    for (i=0;i<files.length;i++){
      p = files[i]; want = hashes[p];
      if (!want || !/^[0-9a-f]{64}$/.test(want)) return { ok:false, reason:'INTEGRITY_INCOMPLETE', bundle:null };
    }
    for (i=0;i<files.length;i++){
      p = files[i];
      var bytes = bytesByPath[p];
      if (!bytes) return { ok:false, reason:'FILE_MISSING:'+p, bundle:null };
      got = ubSha256Hex(bytes);
      if (got !== hashes[p]) return { ok:false, reason:'INTEGRITY_MISMATCH:'+p, bundle:null };
      parts.push(ubBytesToUtf8(bytes));
    }
    var code = '/* UB app v'+manifest.version+' */\n' + parts.join('\n;\n');
    return { ok:true, reason:'', bundle:{ version:manifest.version, code:code } };
  }
```

Step 3에서 Task 1의 export 라인(`module.exports = { ubSha256Hex, ubVerifyBundle }`)을 확정.

- [ ] **Step 4: 통과 확인**

Run: `node tests/loader-integrity.test.js`
Expected: PASS — `Task1... OK` + `Task2 verifyBundle OK`.

- [ ] **Step 5: shell-files.json 해시 재현 교차검증(규약 일치)** — 테스트 하단 추가:

```js
const fs = require('node:fs'), path = require('node:path');
// popup/popup.js는 이 작업에서 안 건드림 → shell-files.json 해시가 안정.
(function(){
  const shell = JSON.parse(fs.readFileSync(path.join(__dirname,'..','shell-files.json'),'utf8'));
  const entry = shell.files.find(f => f.path === 'popup/popup.js');
  const raw = fs.readFileSync(path.join(__dirname,'..','popup','popup.js'));
  // LF 정규화(raw=LF 규약): CRLF→LF
  const lf = Buffer.from(raw.toString('binary').replace(/\r\n/g,'\n'),'binary');
  assert.strictEqual(ubSha256Hex(new Uint8Array(lf)), entry.sha256,
    'ubSha256Hex가 shell-files.json 규약과 불일치');
})();
console.log('Task2 shell-files 규약 교차검증 OK');
```

Run: `node tests/loader-integrity.test.js` → Expected: PASS (규약 일치 확인). ⚠불일치 시 build 스크립트의 정규화와 loader 해시 규약을 맞출 것.

- [ ] **Step 6: 커밋**

```bash
git add src/loader.js tests/loader-integrity.test.js
git commit -m "feat(A): ubVerifyBundle all-or-nothing 검증 + shell-files 규약 교차검증"
```

---

### Task 3: loader.js boot 배선 — 검증 게이트 + 캐시 오염 수정

**Files:**
- Modify: `src/loader.js` (`loadRemote`, `boot`)

**Interfaces:**
- Consumes: `ubVerifyBundle`, `ubSha256Hex`.
- 동작: 원격 fetch(바이트) → verifyBundle → ok면 캐시저장+inject / !ok면 last-known-good 실행. **캐시는 검증 통과분만.**

- [ ] **Step 1: `loadRemote`를 바이트 fetch로 교체** — 현 `fetchText`는 유지(app-files.json 파싱용), 파일은 arrayBuffer로:

```js
  async function fetchBytes(path) {
    var r = await fetch(RAW + path, { cache: 'no-cache', credentials: 'omit' });
    if (!r.ok) throw new Error(path + ' HTTP ' + r.status);
    return new Uint8Array(await r.arrayBuffer());
  }
  async function loadRemote() {
    var manifest = JSON.parse(await fetchText('app-files.json'));
    var bytesByPath = {};
    await Promise.all(manifest.files.map(async function(p){ bytesByPath[p] = await fetchBytes(p); }));
    var v = ubVerifyBundle(manifest, bytesByPath);
    return { verify: v, version: manifest.version };
  }
```

- [ ] **Step 2: `boot`을 검증 게이트로 교체** — 캐시 저장은 검증 통과 후에만:

```js
  async function boot() {
    var code = null, ver = null, src = 'remote';
    try {
      var r = await loadRemote();
      if (r.verify.ok) {
        code = r.verify.bundle.code; ver = r.verify.bundle.version;
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ version: ver, code: code, ts: Date.now() })); } catch (e) {}
        log('원격 로드·검증 성공 v' + ver);
      } else {
        console.warn('[UB][loader] 무결성 실패 → last-known-good:', r.verify.reason);
      }
    } catch (e) {
      console.warn('[UB][loader] 원격 로드 실패 → 캐시 사용:', e && e.message);
    }
    if (!code) {   // 검증 실패 또는 fetch 실패 → last-known-good
      try {
        var c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (c && c.code) { code = c.code; ver = c.version; src = 'cache'; }
      } catch (_) {}
    }
    if (!code) {
      alert('유비샵 바코드 확장: 최초 1회는 인터넷 연결이 필요합니다.\n인터넷 연결 후 페이지를 새로고침하세요.');
      return;
    }
    try { inject(code); log('실행 완료 (' + src + ') v' + ver); }
    catch (e) { console.error('[UB][loader] 실행 오류:', e); }
  }
```

- [ ] **Step 3: node 구문/회귀 확인** (브라우저 wiring은 Task 6 E2E에서 실측; 여기선 파일이 여전히 require 가능+기존 테스트 통과 확인)

Run: `node tests/loader-integrity.test.js`
Expected: PASS(전체) — boot 미실행(node), pure 함수 정상.
Run: `node -e "require('./src/loader.js'); console.log('require OK')"`
Expected: `require OK` (top-level 브라우저 전역 접근 없음 확인).

- [ ] **Step 4: 커밋**

```bash
git add src/loader.js
git commit -m "feat(A): loader boot 검증 게이트 + 캐시 오염 수정(검증 통과분만 저장)"
```

---

### Task 4: `build-app-index.ps1` — app-files.json sha256 재생성

**Files:**
- Create: `build-app-index.ps1`
- Modify: `app-files.json` (sha256 맵 추가)

**Interfaces:**
- Produces: `app-files.json`에 `sha256:{path:hex}` (LF 정규화 규약).

- [ ] **Step 1: 스크립트 작성** — `build-app-index.ps1` (build-shell-index.ps1 규약 재사용):

```powershell
# app-files.json의 files 각각을 LF 정규화 SHA-256 → sha256 맵 갱신. (raw=LF와 일치)
$root = $PSScriptRoot
$appPath = Join-Path $root 'app-files.json'
$app = Get-Content $appPath -Raw | ConvertFrom-Json
function Get-LfHash([string]$path){
  $bytes=[System.IO.File]::ReadAllBytes($path)
  $out=New-Object System.Collections.Generic.List[byte]
  for($i=0;$i -lt $bytes.Length;$i++){ if($bytes[$i] -eq 0x0D -and ($i+1) -lt $bytes.Length -and $bytes[$i+1] -eq 0x0A){continue}; $out.Add($bytes[$i]) }
  ([BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData($out.ToArray()))).Replace('-','').ToLower()
}
$sha=[ordered]@{}
foreach($rel in $app.files){
  $full=Join-Path $root $rel
  if(Test-Path $full){ $sha[$rel]=(Get-LfHash $full) } else { Write-Warning "누락: $rel" }
}
$app | Add-Member -NotePropertyName sha256 -NotePropertyValue $sha -Force
$app | ConvertTo-Json -Depth 6 | Set-Content $appPath -Encoding UTF8
Write-Host "app-files.json sha256: $($sha.Count) files"
```

- [ ] **Step 2: 실행 → app-files.json 갱신**

Run: `pwsh -File build-app-index.ps1`
Expected: `app-files.json sha256: 6 files`.

- [ ] **Step 3: 검증 — 생성 해시가 loader 규약과 일치** (Task 2 교차검증의 로직채널판) — 테스트 추가:

```js
(function(){
  const app = JSON.parse(fs.readFileSync(path.join(__dirname,'..','app-files.json'),'utf8'));
  assert.ok(app.sha256 && app.files.every(p => /^[0-9a-f]{64}$/.test(app.sha256[p])), 'sha256 맵 불완전');
  const rel = app.files[0];
  const raw = fs.readFileSync(path.join(__dirname,'..',rel));
  const lf = Buffer.from(raw.toString('binary').replace(/\r\n/g,'\n'),'binary');
  assert.strictEqual(ubSha256Hex(new Uint8Array(lf)), app.sha256[rel], 'build-app-index 해시가 loader 규약과 불일치');
})();
console.log('Task4 app-files sha256 규약 일치 OK');
```

Run: `node tests/loader-integrity.test.js` → Expected: PASS.

- [ ] **Step 4: 커밋**

```bash
git add build-app-index.ps1 app-files.json tests/loader-integrity.test.js
git commit -m "feat(A): build-app-index.ps1 + app-files.json sha256 맵(하위호환)"
```

---

### Task 5: 버전·shell-files.json 갱신 (배포 준비)

**Files:**
- Modify: `manifest.json` (version v3.6.2→v3.6.3)
- Modify: `shell-files.json` (loader.js·manifest.json 해시·version — build-shell-index.ps1로)
- Modify: `app-files.json` (version 갱신)

- [ ] **Step 1: manifest version** — `manifest.json`의 `"version": "3.6.2"` → `"3.6.3"`.

- [ ] **Step 2: app-files.json version** — `"version"`을 현재값에서 patch +1(하우스룰; 9면 minor). loader 로직 변경 반영.

- [ ] **Step 3: shell-files.json 재생성**

Run: `pwsh -File build-shell-index.ps1`
Expected: `shell-files.json v3.6.3: N files (LF-normalized text hashes)`. loader.js·manifest.json 해시가 새 값으로.

- [ ] **Step 4: 정합성 확인** — node 테스트 전체 통과(popup 교차검증은 여전히 안정) + shell-files version=3.6.3.

Run: `node tests/loader-integrity.test.js`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add manifest.json shell-files.json app-files.json
git commit -m "chore(A): v3.6.3 버전·shell-files·app-files 갱신"
```

---

### Task 6: E2E 실측 검증 (완료기준 1·2·3·5) — Advisor 직접, 매장 운영시간 외

> ⚠ **되돌리기 어려운 고위험 · Codex autonomous 금지.** Advisor가 직접 수행·관측. 손상 실험은 매장 배포 전 **로컬(테스트 PC)에서** 먼저.

**단계 A — 로컬 검증(푸시 전, 손상 폴백 실측):**
- [ ] app-files.json(sha256 포함)만 먼저 안전 배포 가능성 검토: 옛 loader는 `files`만 읽어 무영향(하위호환) — 로컬에서 옛 loader가 새 app-files.json으로 정상 로드됨을 claude-in-chrome로 확인(회귀 없음).
- [ ] 테스트 PC의 확장 폴더(StableExtensionDir)에 **새 loader.js 수동 배치**(푸시 없이) → 브라우저 재로드.
- [ ] **정상 경로**(완료기준 1): ubdstore 페이지 로드 → 콘솔 `[UB][loader] 원격 로드·검증 성공 v…` + 현재 로직 정상(재고화/회전입고/통계 버튼 존재).
- [ ] **손상 폴백**(완료기준 2): 로컬에서 app-files.json의 한 파일 sha256을 오값으로 바꾼 사본으로 로드(또는 한 파일 본문 손상) → 콘솔 `무결성 실패 → last-known-good: INTEGRITY_MISMATCH:<file>` + **손상 코드 미실행** + `localStorage.UB_APP_CACHE_v1`가 직전 정상값 유지(오염 없음) 실측.
- [ ] **부분 매니페스트**(완료기준 3): sha256에서 한 파일 키 제거 → `INTEGRITY_INCOMPLETE`로 거부·last-known-good 실측.

**단계 B — 배포(로컬 통과 후):**
- [ ] Codex 공동검수(전 diff) 통과 확인(§ 아래).
- [ ] 푸시: app-files.json(+sha256) + loader.js + shell-files.json + manifest.json. (build-app-index/build-shell-index 실행 완료 상태)

**단계 C — 자동 업데이트 무손상 실측(완료기준 5):**
- [ ] 배포 후 테스트 PC(트레이 프로그램 실행 중)에서 **재설치 없이** 새 loader.js가 shell sync로 도달함 확인(`/ext/sync` 또는 StableExtensionDir loader.js 해시=새 값, 브라우저 재시작 후 콘솔 v3.6.3).
- [ ] 정상 해시 로직 push 1건(예: 사소한 주석) → build-app-index → push → 새 loader가 검증·로드(콘솔 성공) 실측. **재설치 없음.**

**완료 판정:** 위 관측 전부 + Codex 공동검수 통과 시에만 "작업 A 완료". 실패 시 원인 담아 수정.

---

## Self-Review (작성자 체크)

- **Spec 커버리지:** §3.1 매니페스트→Task4/5 · §3.2 검증흐름→Task2/3 · §3.3 순수SHA→Task1 · §3.4 build스크립트→Task4 · §3.5 무손상→하위호환(Task4)+Task3 캐시수정+Task6 회귀 · §3.6 자동업뎃무손상→Task6 단계C · §4 테스트→Task1/2/4 단위+Task6 E2E · 완료기준1~5→Task6. 누락 없음.
- **Placeholder:** 없음(SHA-256·verifyBundle·build 스크립트·테스트 전부 실코드).
- **타입 일관성:** `ubSha256Hex(Uint8Array)→hex`, `ubVerifyBundle(manifest,bytesByPath)→{ok,reason,bundle}`, `bundle{version,code}` — Task1~3 일치. reason 코드(INTEGRITY_INCOMPLETE/MISMATCH/FILE_MISSING) Task2 정의=Task6 관측 일치.
- **미확정(구현 중 결정):** build-app-index를 build-shell-index와 통합할지(선택). node 없으면 테스트 실행 불가→Codex/worker 환경에 node 필요(win에 존재 확인).

## Codex 공동검수 게이트

- 각 코드 커밋 전(또는 배포 전 전체 diff) Codex(mcp__codex__codex) 재검토. Claude·Codex 둘 다 "문제없음"이어야 완료. 특히 SHA-256 정확성·검증 게이트의 fail-safe·하위호환·캐시 오염 수정을 교차 확인.
