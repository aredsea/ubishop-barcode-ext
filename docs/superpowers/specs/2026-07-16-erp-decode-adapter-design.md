# ERP 응답 디코드 어댑터 (작업 C) — 설계

작성일: 2026-07-16 · 상태: 승인됨(realm별 점진), Phase 1 착수 예정

## 문제

유비샵 ERP(옛 Struts, EUC-KR/UTF-8 혼재) 응답을 fetch·파싱하는 코드가 6개 파일에
흩어져 있고, **같은 "인코딩 자동판별" 문제에 4가지 서로 다른 휴리스틱**이 복붙돼 있다:

| 방식 | 위치 | 요지 |
|---|---|---|
| A | skin.js ×3 (postDoc 등) | utf-8 디코드 후 `�`>20 이면 euc-kr 재디코드 |
| B | cache-intercept.js, background.js (verbatim 중복) | content-type 헤더 스니프 → 미선언 시 4KB 샘플 `�`>5 이면 euc-kr |
| C | collector.js `decodeKr` | utf-8·euc-kr 둘 다 디코드해 `�` 적은 쪽 채택 |
| D | background.js (또 다른 곳) | utf-8 실패 시 euc-kr |

- loader.js 의 디코드는 **GitHub raw(항상 utf-8)** 용이라 ERP 아님 → 대상 제외.
- 파편화 위험: 인코딩·마크업이 바뀌면 여러 기능이 조금씩 다르게 조용히 깨질 수 있고,
  각 사이트가 서로 다른 강건성을 가진다.

부차: 성공판정(리다이렉트 URL `msg` 비면 성공)이 skin.js(회전입고)·background.js(로그인)
2곳에 있음. hidden 필드 정규식 추출은 자동화별로 국소적이라 **범위 외(YAGNI)**.

## 제약

- **절대 무회귀**: 현재 각 사이트가 처리하는 실제 페이지에서 디코드 결과가 동일해야 함.
  더 강건해질 뿐, 나빠지지 않는다(픽스처로 보증).
- **채널 결합 회피**: ERP fetch/decode 는 3개 JS realm 에 분리돼 있다 —
  MAIN world(loader 번들: collector/statis/cache-intercept), ISOLATED(skin.js content
  script), SW(background.js). 하나로 완전통합하면 로더번들+manifest content_script+SW
  importScripts 3방식 + 2개 배포채널이 결합되고, SW엔 DOMParser도 없다. → realm 경계 유지.

## 솔루션 — 정규 디코드(realm별) + 픽스처

### 정규 알고리즘 `decodeErpHtml(bytes, contentType)`
4종 휴리스틱을 가장 강건한 하나로 흡수:
1. content-type 가 `euc-kr`/`ks_c_5601`/`ksc5601` 선언 → euc-kr, `utf-8` 선언 → utf-8.
2. 미선언/모호 → utf-8·euc-kr 둘 다 디코드해 `�`(U+FFFD) 개수 비교, 적은 쪽 채택(동률 utf-8).

`submitResult(url)` → `{ ok, msg }` : `new URL(url).searchParams.get('msg')` 비면 `ok:true`.

### 배치 (realm별, 채널 결합 없음)
- 신규 requireable 모듈 `src/erp.js`(fsm.js 처럼 `module.exports` 가드) = SSOT + 테스트 대상.
- **app-files.json(LOGIC)** 에 추가 → loader 가 MAIN world 번들에 포함 → collector/statis/
  cache-intercept 가 호출(3+곳 → 1개 공유; 즉시 배포·revert 쉬움·재시작 불필요).
- **skin.js(ISOLATED)·background.js(SW)** 는 같은 알고리즘의 **로컬 복사본**(shell 채널 별개).
  주석에 `SSOT=src/erp.js` 명시 + 드리프트 방지 테스트(각 realm 복사본이 픽스처에 동일 출력).

### 픽스처 + 테스트 (`tests/erp-decode.test.js`)
- 합성 픽스처: 알려진 한글 문자열을 **EUC-KR·UTF-8 양쪽으로 인코딩한 바이트** + content-type
  변형(euc-kr 선언 / utf-8 선언 / 미선언 / 오선언). (실제 페이지 캡처가 아니어도 인코딩 판별
  로직 검증엔 충분·결정론적.) 가능하면 실제 ERP 응답 스냅샷도 1~2개 추가.
- `require('../src/erp.js')` → decodeErpHtml 이 각 케이스에서 한글을 정확히 디코드하는지 assert.

## 마이그레이션 (한 realm씩, 각각 검증·공동검수)
1. **Phase 1**: `src/erp.js` + 픽스처 + 테스트 생성. 동작 변경 0(아직 아무도 호출 안 함). 커밋.
2. **Phase 2**: MAIN world 로직파일(collector/statis/cache-intercept) → decodeErpHtml 호출.
   LOGIC 배포(app-files 버전), revert 쉬움. 검증.
3. **Phase 3**: skin.js 로컬 복사본으로 교체. SHELL 배포. Codex 공동검수 + 검증.
4. **Phase 4**: background.js 로컬 복사본으로 교체. SHELL 배포. 공동검수 + 검증.

각 Phase: 동작보존·무회귀·Codex 공동검수. loader.js(GitHub utf-8)는 손대지 않음.

## 범위 외 (YAGNI)
hidden 필드 추출 통합(국소적), 그 외 리팩토링.
