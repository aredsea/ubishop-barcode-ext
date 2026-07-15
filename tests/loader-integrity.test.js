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
