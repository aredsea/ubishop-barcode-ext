#!/usr/bin/env node
/* =============================================================================
 *  build-app-index.js — 로직채널(app-files.json)의 files 각각을 LF 정규화 SHA-256 →
 *    app-files.json 의 sha256 맵 갱신. loader.js 가 이 값과 raw fetch 바이트를 대조
 *    (all-or-nothing). raw(github)는 텍스트를 LF 로 주므로 해시도 LF 기준이다.
 *
 *  ⚠ 왜 PowerShell 이 아니라 node 인가 — build-app-index.ps1 은 Windows PowerShell 5.1
 *    에서 한글 note 를 조용히 망가뜨렸다(2026-07-19 실제로 당함):
 *      ① Get-Content -Raw 가 BOM 없는 UTF-8 을 시스템 ANSI(cp949)로 읽어 모지바케
 *      ② Set-Content -Encoding UTF8 이 BOM 을 붙여 loader 의 JSON.parse 를 깨뜨림
 *      ③ SHA256::HashData 는 .NET 5+ 전용이라 5.1 엔 아예 없음(해시가 전부 빈 값)
 *    node 는 UTF-8 이 기본이라 셋 다 해당 없다. 이 스크립트를 정본으로 쓴다.
 *
 *  ★이 스크립트의 유일한 실패 방식은 '요란하게 죽는 것' 이어야 한다. 불완전한 인덱스를
 *    써놓고 성공을 보고하면 loader 가 번들 전체를 거부하고, 캐시가 없는 최초 설치 기기는
 *    아예 동작하지 않는다. 그래서 이상하면 쓰지 않고 exit 1 한다.
 *
 *  사용법:  node build-app-index.js [새버전] [붙일 note]
 *           node build-app-index.js            # 해시만 갱신
 * ========================================================================== */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = __dirname;
const appPath = path.join(root, 'app-files.json');
const app = JSON.parse(fs.readFileSync(appPath, 'utf8'));

const [, , newVersion, ...noteParts] = process.argv;
const note = noteParts.join(' ').trim();

const sha256 = {};
const missing = [];
const suspect = [];
for (const rel of app.files) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) { missing.push(rel); continue; }
  // CRLF → LF 정규화(raw=LF 규약 재현) 후 해시. 바이트 단위로 다뤄 인코딩 가정을 안 한다.
  //  (latin1 왕복은 바이트 무손실이고, UTF-8 연속바이트엔 0x0D/0x0A 가 없어 한글이 걸릴 일도 없다)
  const buf = fs.readFileSync(full);
  const bin = buf.toString('binary');
  // ★단독 CR(구 Mac 개행)이 섞이면 git 의 정규화와 우리 치환이 갈릴 수 있다. 해시가 raw 와
  //   어긋나면 배포가 통째로 거부되므로, 추측하지 말고 멈춘다.
  if (/\r(?!\n)/.test(bin)) suspect.push(rel);
  sha256[rel] = crypto.createHash('sha256')
    .update(Buffer.from(bin.replace(/\r\n/g, '\n'), 'binary')).digest('hex');
}

if (missing.length || suspect.length) {
  if (missing.length) console.error('누락된 파일: ' + missing.join(', '));
  if (suspect.length) console.error('단독 CR 개행이 섞인 파일(개행 정리 후 재실행): ' + suspect.join(', '));
  console.error('→ app-files.json 을 쓰지 않고 중단합니다. 불완전한 인덱스는 배포를 통째로 막습니다.');
  process.exit(1);
}

if (newVersion) app.version = newVersion;
// ★같은 배포 명령을 다시 돌려도 note 가 중복 누적되지 않게 한다(재시도가 흔하다).
//   단순 endsWith 는 경계를 안 봐서 서로 다른 note 를 중복으로 오판한다 —
//   기존 note 가 'hotfix' 로 끝날 때 새 note 'fix' 를 이미 있다고 보고 조용히 버린다.
const alreadyNoted = (n) => app.note === n || app.note.endsWith(' ' + n);
if (note && !alreadyNoted(note)) app.note = app.note + ' ' + note;

app.sha256 = sha256;
// BOM 없는 UTF-8 + LF. 커밋본과 같은 모양이라야 diff 가 실제 변화만 보여준다.
fs.writeFileSync(appPath, JSON.stringify(app, null, 2) + '\n', 'utf8');
console.log(`app-files.json v${app.version}: ${Object.keys(sha256).length} files`);
