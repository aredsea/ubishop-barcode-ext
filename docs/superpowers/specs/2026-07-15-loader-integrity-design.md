# 작업 A — 로직채널 무결성 차단 (loader.js all-or-nothing) · 설계

- **날짜**: 2026-07-15
- **대상**: `ubishop-barcode-ext` — `src/loader.js`, `app-files.json`, 신규 `build-app-index.ps1`
- **위협모델(사용자 확정)**: 손상·부분fetch·나쁜push 방어. **repo/GitHub 계정 탈취는 범위 밖** — 서명키 검증 훅 자리만 남기고 별도 결정으로 미룸. 근거: 두 업데이트 채널(로직/shell)이 모두 GitHub raw=repo에서 오고, C# ExtSync가 검증하는 shell-files.json 자체도 repo 전달이라 raw-manifest 대조는 계정 탈취에 무력. 진짜 탈취 방어는 repo 밖 신뢰앵커(로컬 서명키+외부 핀)가 필요하며 단일 GitHub 계정 구조상 완전방어가 어려워 과설계로 판단.
- **최우선 제약**: **기존 기능·배포 환경 무손상** — 정상 경로 동작 불변, 하위호환, fail-safe.

---

## 1. 문제

`loader.js`가 `app-files.json`의 6개 로직 파일(config/overlay/collector/content/cache-intercept/statis)을 GitHub raw에서 받아 **무검증**으로 `\n;\n` 이어붙여 실행한다.

- fetch가 HTTP 에러면 throw→캐시 폴백(전체 실패는 안전). 그러나 **부분 손상(200이지만 잘린 본문)·나쁜 push(문법 깨진 파일)는 에러 없이 그대로 실행**된다.
- ★성공 fetch 후 **검증 없이 `UB_APP_CACHE_v1`에 저장**(현 loader.js line 54) → 나쁜 push가 last-known-good 캐시까지 오염한다. 즉 나쁜 push 1회로 ⓐ깨진 코드 실행 + ⓑ폴백 캐시 소실.

## 2. 완료기준

1. 정상 상태에서 기존 동작 회귀 없음.
2. 일부러 한 파일을 손상시켜 로드 → 손상 코드 미실행 + last-known-good 폴백(실측).
3. 부분 매니페스트(해시 누락/일부만 갱신) 시 실행 거부.
4. 확정 위협모델·trust root 결정을 커밋 메시지/이 문서에 기록.
5. **자동 업데이트 무손상 실측** — 새 loader가 재설치 없이 shell sync로 도달 + 정상 해시 로직 push가 새 loader에서 검증·로드됨(§3.6).

## 3. 설계

### 3.1 매니페스트 형식 — 하위호환 확장

`app-files.json`을 **하위호환**으로 확장한다. `files`(문자열 배열)는 **그대로 유지**하고 `sha256` 맵을 **추가**한다.

```json
{
  "version": "2.7.1",
  "note": "...",
  "files": ["src/config.js", "src/overlay.js", "src/collector.js",
            "src/content.js", "src/cache-intercept.js", "src/statis.js"],
  "sha256": {
    "src/config.js": "<64-hex>",
    "src/overlay.js": "<64-hex>",
    "src/collector.js": "<64-hex>",
    "src/content.js": "<64-hex>",
    "src/cache-intercept.js": "<64-hex>",
    "src/statis.js": "<64-hex>"
  }
}
```

- **옛 loader**: `files`(문자열)만 읽어 기존대로 동작(무검증). `sha256` 키는 무시 → **깨지지 않음**.
- **새 loader**: `files` + `sha256` 사용, 검증.
- **전환 안전성**: app-files.json은 raw에서 즉시 반영, loader.js는 shell채널(C# sync+브라우저 재시작이라 느림). 새 app-files.json(sha256 포함)이 먼저 떠도 옛 loader는 `files`만 읽어 정상; 새 loader가 도달하면 검증 시작. **도달 순서 무관하게 무손상.**
- 해시 = **LF 정규화 UTF-8 바이트의 SHA-256**(raw=LF와 일치, shell-files.json과 동일 규약).

### 3.2 검증 흐름 (loader.js `loadRemote`/`boot` 개정)

```
1. app-files.json fetch·파싱
2. 완전성 검사: manifest.files의 모든 경로가 manifest.sha256에 비어있지 않은 64-hex로 존재?
   → 아니면  reason=INTEGRITY_INCOMPLETE, 원격 거부 → last-known-good
3. files 6개 fetch (r.arrayBuffer() 원바이트)
4. 각 파일 sha256hex(bytes) === manifest.sha256[path]?
   → 하나라도 불일치  reason=INTEGRITY_MISMATCH:<file>, 원격 거부 → last-known-good
   → fetch 실패      reason=FILE_FETCH:<file>, 원격 거부 → last-known-good
5. 전부 통과:
   code = '/* UB app v'+version+' */\n' + parts.join('\n;\n')
   UB_APP_CACHE_v1 = {version, code, ts}   ← 검증 통과분만 저장(= 새 last-known-good)
   inject(code)
6. 원격 거부/실패 시: UB_APP_CACHE_v1.code 실행(src='cache'); 없으면 기존 "인터넷 필요" alert
```

- **캐시 저장은 5단계(검증 통과)에서만.** 오염 차단(현 line 54 위치 이동).
- 실패 사유는 `console.warn('[UB][loader]', reason)`으로 남김. **PII/자격증명/키 미포함.** popup 노출은 작업 B 범위.

**구현 리뷰 반영(Codex 공동검수 2건, 2026-07-15):**
- **빈/영 `files` 방어**: `files.length===0`이면 `INTEGRITY_INCOMPLETE` 거부. (공허한 루프가 빈 번들을 "검증 성공"으로 캐시하는 것 차단.)
- **캐시 세대 표식**: 검증 통과분 저장 시 `{version,code,ts,verified:true}`. boot 폴백에서 `c.verified`로 로그 구분(`src='cache'` vs `'cache-legacy'`). ⚠ **legacy(플래그 없는 구 loader 캐시)도 계속 last-known-good로 실행** — refuse 시 오프라인 최초 로드 매장이 깨져 "무손상" 하드제약 위반. 위협모델(탈취 제외)상 legacy 캐시는 매장의 마지막 정상 버전이라 benign이며, 첫 검증 성공 로드 후 verified 캐시로 대체됨(노출 창≈1 로드).

### 3.3 순수 JS SHA-256

- `crypto.subtle`은 http(비-secure context)에서 `undefined` — **실측 확정**(isSecureContext=false, crypto.subtle=undefined @ ubdstore http). 따라서 **순수 JS SHA-256**(FIPS 180-4, 작은 함수) 내장.
- 입력 = fetch한 `ArrayBuffer`의 `Uint8Array` **원바이트**(text decode/re-encode 왕복 회피 → 바이트 불일치 위험 제거).
- 단일 경로(순수JS만). secure-context 자동분기는 YAGNI로 제외.
- 위치: **loader.js 인라인**(loader 자체가 shell 파일이라 self-contained, 별도 fetch 불필요).

### 3.4 배포 워크플로 — 신규 `build-app-index.ps1`

- `build-shell-index.ps1`의 로직채널판: `files`의 각 파일을 LF 정규화 후 SHA-256 → `app-files.json`의 `sha256` 맵 갱신(+ 필요 시 `version`).
- **로직 배포 절차 변경**: 편집 → **`build-app-index.ps1` 실행** → `git push`. (기존은 편집→version 수기→push.)
- 스크립트 누락 시: loader가 해시 불일치로 신규 거부 → last-known-good 실행(**안전하나 "push했는데 반영 안 됨"** 혼동 여지). README/CLAUDE.md에 명기해 완화. build-shell + build-app 통합 래퍼는 선택(계획 단계 결정).

### 3.5 하위호환·무손상 보장 (최우선 제약 매핑)

- `app-files.json`의 `files` 형식·기존 필드 불변 → 옛 loader 무손상.
- 정상 경로(모든 해시 일치): 기존과 동일 로드(추가 비용=6파일 해시계산, 페이지당 수 ms, 무시할 수준).
- loader.js 외 파일·manifest 권한·content_scripts 불변(순수 페이지 fetch+계산, 신규 권한 없음).
- **fail-safe**: 최악의 경우에도 신규를 거부하고 last-known-good을 실행 → 매장 PC가 깨지지 않음.

### 3.6 자동 업데이트 무손상 — 재설치 불필요 (하드 요구, 검증 필수)

이 작업은 **자동 업데이트를 깨뜨리거나 매장 PC 재설치를 요구해서는 절대 안 된다**(사용자 명시 원칙). 경로별:

- **loader.js 변경 배포**: shell채널 → C# ExtSync(D102LabelPrinter)가 `shell-files.json` 폴링·sha256 검증·스왑 → 다음 브라우저 재시작 시 적용. **재설치 아님(자동 sync).**
- **app-files.json `sha256` 추가**: raw 즉시 반영. 옛 loader는 `files`(문자열)만 읽어 무손상, 새 loader만 검증. **도달 순서 무관.**
- **이후 로직 업데이트**: 해시 포함 push(`build-app-index.ps1`) → 새 loader 검증·로드. **재설치 아님.**
- **새 loader 미도달 매장**: 옛 loader 계속 동작(무검증=기존과 동일). **재설치·중단 없음.**
- **검증(완료기준 5로 추가)**: 배포 후 라이브에서 ⓐ새 loader가 shell sync로 재설치 없이 도달(트레이 프로그램만으로) ⓑ정상 해시 로직 push가 새 loader에서 검증·로드됨을 실측. 매장 운영시간 외.

## 4. 테스트 (TDD)

- **순수함수 추출로 테스트 가능화**: `sha256hex(bytes)` + `verifyBundle(manifest, fetchedBytesByPath, cache)`→`{ok, reason, bundle?}` 를 loader의 IIFE에서 분리해 node로 단위테스트.
- **red→green**:
  - `sha256hex`: NIST 벡터("abc"=ba7816bf…, ""=e3b0c442…) 실패→구현→통과. **shell-files.json의 기존 파일 해시 재현**(같은 파일 같은 해시)로 규약 일치 교차검증.
  - `verifyBundle`: ⓐ전부일치→ok+cacheWrite ⓑ1개 불일치→!ok(INTEGRITY_MISMATCH)+cache보존 ⓒ불완전 매니페스트→!ok(INTEGRITY_INCOMPLETE) ⓓfetch실패→!ok(FILE_FETCH). 각 red→green.
- **E2E(라이브 http, 완료기준 2·3)**: 한 파일을 손상시키거나 `sha256`를 오설정한 매니페스트로 로드 → last-known-good 실행·손상코드 미실행·`UB_APP_CACHE_v1` 미변경을 콘솔 사유와 함께 실측. **매장 운영시간 외.**
- **회귀**: 정상 매니페스트 → 현재 버전 정상 로드(동작 불변). 재고화/회전입고/통계 등 로직 파일 실행 무영향 확인.

## 5. 롤백

- loader.js는 shell채널 → `git revert` + `build-shell-index.ps1` + push + C# sync + 브라우저 재시작.
- 변경이 fail-safe라 blast radius 작음(신규 거부해도 last-known-good 동작).

## 6. 범위 외 (이 작업에서 하지 않음)

- repo/계정 탈취 방어(서명키) — 훅 자리만, 별도 결정.
- popup 실패사유 노출 — 작업 B.
- 계정전환 FSM(작업 B)·ERP 응답 어댑터(작업 C)·cache-intercept 수정.
- 자동 `chrome.runtime.reload()` 재도입(인쇄 중단 사고).

## 7. 버전

- loader.js 변경 = shell채널 → `manifest.json` version + `shell-files.json` 갱신. 하우스룰(patch 9→minor, minor 9→major), 다운그레이드 불가. 현 v3.6.2 → v3.6.3(예정).
- app-files.json = 로직채널 version(현 2.7.1)도 이번 sha256 추가 시 함께 갱신.
