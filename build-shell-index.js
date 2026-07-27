/* =============================================================================
 *  build-shell-index.js — build-shell-index.ps1 의 node 판(크로스 플랫폼).
 *
 *  왜 있나: 껍데기(SHELL) 파일을 고치면 **반드시** manifest version 올림 + 이 인덱스
 *  재생성이다. 안 하면 `shell-files.json` 해시가 디스크와 어긋나 ExtSync 가 내려보낼
 *  판단을 못 하고 배포가 조용히 멈춘다(2026-07-27 에 v3.6.1 로 6릴리스간 멈춰 있었다).
 *  그런데 기존 빌더는 PowerShell 전용이라 pwsh 없는 환경에서는 돌릴 수가 없었다.
 *
 *  ⚠ 출력은 build-shell-index.ps1 과 **바이트 단위로 동일**해야 한다. 둘을 번갈아
 *   돌려도 diff 가 안 나야 하기 때문이다. 그래서 PowerShell `ConvertTo-Json` 의
 *   서식(4칸 들여쓰기 · 콜론 뒤 공백 2칸 · 배열 원소를 여는 대괄호 열에 맞춰 정렬)을
 *   그대로 재현하고, BOM 없이 LF 로, 끝 개행 없이 쓴다.
 *
 *  해시 규칙(ps1 과 동일):
 *    - 텍스트 확장자 → CRLF(0D0A)→LF(0A) 정규화 후 SHA256 (raw.githubusercontent 가
 *      LF 로 주므로 ExtSync 의 다운로드 검증과 맞추려면 이래야 한다)
 *    - 그 외(png 등 바이너리) → 원본 바이트 그대로 SHA256
 *    ⚠ 전부 LF 정규화해서 대조하면 아이콘이 항상 STALE 로 보인다(2026-07-27 오판).
 *
 *  실행: node build-shell-index.js
 * ========================================================================== */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;

// 껍데기 파일 = loader 로 원격 로드가 안 되는, 폴더 교체가 필요했던 파일들.
// ⚠ build-shell-index.ps1 의 $patterns 와 순서까지 같아야 한다.
const PATTERNS = [
  'manifest.json',
  'src/loader.js',
  'src/localbridge.js',
  'src/fsm.js',
  'src/background.js',
  'src/skin.js',
  'popup/popup.html',
  'popup/popup.js',
  'rules/cache.json'
];
const TEXT_EXT = new Set(['.js', '.json', '.html', '.htm', '.css', '.xml', '.md', '.txt', '.svg']);

function shellHash(full) {
  let buf = fs.readFileSync(full);
  if (TEXT_EXT.has(path.extname(full).toLowerCase())) {
    // CRLF → LF. 0D 뒤에 0A 가 오는 경우에만 0D 를 버린다(단독 0D 는 보존 — ps1 과 동일).
    const out = Buffer.alloc(buf.length);
    let n = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0d && i + 1 < buf.length && buf[i + 1] === 0x0a) continue;
      out[n++] = buf[i];
    }
    buf = out.subarray(0, n);
  }
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/*  PowerShell ConvertTo-Json 서식 재현.
 *  일반 emitter 가 아니라 이 인덱스의 모양({ version, files:[{path,sha256}] }) 전용이다.
 *  핵심 규칙: 배열 원소는 여는 '[' 가 놓인 **열**을 기준으로 +4 씩 들여쓴다.  */
function psJson(obj) {
  const q = (s) => JSON.stringify(String(s));
  const KEY = '    "files":  ';                 // '[' 가 놓이는 열 = 이 문자열의 길이
  const itemIndent = ' '.repeat(KEY.length + 4);
  const fieldIndent = ' '.repeat(KEY.length + 8);
  const items = obj.files.map((f) =>
    itemIndent + '{\n' +
    fieldIndent + '"path":  ' + q(f.path) + ',\n' +
    fieldIndent + '"sha256":  ' + q(f.sha256) + '\n' +
    itemIndent + '}'
  ).join(',\n');
  return '{\n' +
    '    "version":  ' + q(obj.version) + ',\n' +
    KEY + '[\n' + items + '\n' +
    ' '.repeat(KEY.length) + ']\n' +
    '}';
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const files = [];
for (const rel of PATTERNS) {
  const full = path.join(ROOT, rel);
  if (fs.existsSync(full)) files.push({ path: rel.replace(/\\/g, '/'), sha256: shellHash(full) });
  else console.warn('경고 — 누락: ' + rel);
}
// icons/* 전체 (바이너리 → 정규화 없이 원본 해시). ps1 의 Get-ChildItem 과 같은 이름순.
const iconDir = path.join(ROOT, 'icons');
if (fs.existsSync(iconDir)) {
  for (const name of fs.readdirSync(iconDir).sort()) {
    const full = path.join(iconDir, name);
    if (fs.statSync(full).isFile()) files.push({ path: 'icons/' + name, sha256: shellHash(full) });
  }
}

// BOM 없는 UTF-8, LF, 끝 개행 없음 — ps1 의 WriteAllText + UTF8Encoding($false) 와 동일.
fs.writeFileSync(path.join(ROOT, 'shell-files.json'), psJson({ version: manifest.version, files }), 'utf8');
console.log('shell-files.json v' + manifest.version + ': ' + files.length + ' files (LF-normalized text hashes)');
