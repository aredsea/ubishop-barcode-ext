/* =============================================================================
 *  arrival-wiring.test.js — 입고 지연 알림 배선 정적 검사. 실행: node --test tests/arrival-wiring.test.js
 *  스펙: docs/superpowers/specs/2026-11-13-arrival-delay-design.md §8
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const bg = read('src/background.js');
const MARK = '입고 지연 알림 (v4.5.1)';
const arrivalBlock = bg.slice(bg.indexOf(MARK));

test('background — 입고 지연 블록 존재 · importScripts 에 core 포함', () => {
  assert.ok(bg.indexOf(MARK) > 0, '입고 지연 블록 없음');
  const first = bg.split(/\r?\n/)[0];
  assert.ok(/^importScripts\(/.test(first) && /fsm\.js/.test(first), 'importScripts 첫 줄 형태');
  assert.ok(/orderimport-core\.js/.test(first) && /arrival-core\.js/.test(first), 'importScripts 에 orderimport-core·arrival-core 필요');
});

test('background — ubArrivalWatch 가 꺼져 있으면 조회 전에 return', () => {
  const m = arrivalBlock.match(/async function arrivalCheckInner[\s\S]*?\n}\r?\n/);
  assert.ok(m, 'arrivalCheckInner 를 못 찾음');
  const body = m[0];
  const off = body.search(/if \(!s\.ubArrivalWatch\)[^\n]*return/);
  const fetchAt = body.indexOf('arrivalFetchRows(');
  assert.ok(off >= 0, '스위치 OFF return 없음');
  assert.ok(fetchAt > off, '스위치 검사가 조회보다 먼저여야 한다');
  assert.ok(/ubArrivalWatch:\s*false/.test(body), '스위치 기본값 false');
});

test('background — 쓰기 URL 패턴 없음(읽기 POST·공휴일 GET 만)', () => {
  assert.ok(!/Write\.do|Delete\.do|Modify\.do|Standby|CurrentSetting/.test(arrivalBlock), '쓰기 URL 패턴 발견');
  //  POST 는 둘: 유비샵 목록 검색(읽기) + 아틀리에 arrival-notify(4.5.2, 앱 알림 넣기 — 유비샵 쓰기 아님).
  const posts = arrivalBlock.match(/method:\s*'POST'/g) || [];
  assert.strictEqual(posts.length, 2, 'POST 는 목록 검색과 아틀리에 알림 둘뿐이어야 한다');
  assert.ok(/fetch\(ARRIVAL_ATELIER_URL,\s*\{\s*method:\s*'POST'/.test(arrivalBlock));
  //  정의만 있고 호출이 빠지면 아틀리에 알림이 조용히 끊긴다 — arrivalCheckInner 본문에서 부르는지 고정(Opus 4.7 R2 Nit).
  const inner = arrivalBlock.slice(arrivalBlock.indexOf('async function arrivalCheckInner'), arrivalBlock.indexOf('async function arrivalSendAtelier'));
  assert.ok(/await arrivalSendAtelier\(items\)/.test(inner), 'arrivalCheckInner 가 arrivalSendAtelier(items) 를 불러야 한다');
  assert.ok(/ARRIVAL_ATELIER_URL\s*=\s*'https:\/\/sshwwwavcbgyiyojngav\.supabase\.co\/functions\/v1\/arrival-notify'/.test(arrivalBlock));
  assert.ok(/orderItemList\.do\?tcode=order_item/.test(arrivalBlock));
  assert.ok(/searchShop:\s*'LT'/.test(arrivalBlock));
  assert.ok(/\['O--',\s*'pre'\][\s\S]*\['OS-',\s*'pre'\][\s\S]*\['B--',\s*'post'\]/.test(arrivalBlock));
});

test('background — 알림 id 접두 ub-arrival- 와 onClicked 처리', () => {
  assert.ok(/ARRIVAL_NOTIFY_PREFIX\s*=\s*'ub-arrival-'/.test(arrivalBlock));
  assert.ok(/chrome\.notifications\.create\(ARRIVAL_NOTIFY_PREFIX \+ Date\.now\(\)/.test(arrivalBlock));
  assert.ok(/notifications\.onClicked\.addListener[\s\S]*ARRIVAL_NOTIFY_PREFIX[\s\S]*arrivalOpenList\(\)/.test(arrivalBlock));
  assert.ok(/pages\/arrival\.html/.test(arrivalBlock));
  //  기존 업데이트 알림 리스너·배지 관례는 그대로
  assert.ok(/id\.indexOf\('ub-update-'\) === 0/.test(bg));
  assert.ok(/ubUpdateAvailable/.test(bg));
});

test('background — 알람·시작·스위치 변경·메시지 배선', () => {
  assert.ok(/ARRIVAL_ALARM\s*=\s*'ub-arrival'/.test(arrivalBlock) && /periodInMinutes:\s*30/.test(arrivalBlock));
  assert.ok(/onStartup\.addListener\(\(\) => \{ arrivalCheck\(\{\}\)/.test(arrivalBlock));
  assert.ok(/onInstalled\.addListener\(\(\) => \{ arrivalCheck\(\{\}\)/.test(arrivalBlock));
  assert.ok(/ch\.ubArrivalWatch\.newValue\) arrivalCheck\(\{ force: true \}\)/.test(arrivalBlock));
  assert.ok(/msg\.type !== 'arrivalRefresh'/.test(arrivalBlock));
});

test('popup — 기본값 ubArrivalWatch: false · 스위치·버튼', () => {
  const js = read('popup/popup.js');
  const html = read('popup/popup.html');
  assert.ok(/ubArrivalWatch:\s*false/.test(js), '팝업 기본값');
  assert.ok(/ubArrivalWatch:\s*arrivalWatch\.checked/.test(js));
  assert.ok(/pages\/arrival\.html/.test(js));
  assert.ok(/id="arrivalWatch"/.test(html) && /id="arrivalList"/.test(html));
});

test('arrival.js — 서버 문자열을 innerHTML 로 넣지 않는다 · 인라인 스크립트 없음', () => {
  const js = read('pages/arrival.js');
  const html = read('pages/arrival.html');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js), 'HTML 주입 API 사용');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), '인라인 스크립트(MV3 CSP)');
  assert.ok(/<script src="arrival\.js">/.test(html));
  assert.ok(!/ub-dark|ubDark|prefers-color-scheme/.test(js + html), '다크모드 금지');
});

test('manifest — 공휴일 호스트 권한', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.ok(m.host_permissions.includes('https://sshwwwavcbgyiyojngav.supabase.co/*'));
});
