# build-app-index.ps1 — build-app-index.js 로 위임하는 shim.
#
# ⚠ 예전 PowerShell 구현은 Windows PowerShell 5.1 에서 app-files.json 을 조용히 망가뜨렸다
#   (2026-07-19 실제로 당함 — note 의 한글이 전부 모지바케됐다):
#     ① Get-Content -Raw 가 BOM 없는 UTF-8 을 시스템 ANSI(cp949)로 읽음
#     ② Set-Content -Encoding UTF8 이 BOM 을 붙여 loader 의 JSON.parse 를 깨뜨림
#     ③ SHA256::HashData 는 .NET 5+ 전용이라 5.1 엔 없음(해시가 전부 빈 값인데 성공 메시지)
#   셋 다 실패해도 스크립트가 계속 진행해 "성공"처럼 보이는 게 제일 위험했다.
#   node 는 UTF-8 이 기본이라 해당 없음 → 구현을 build-app-index.js 로 옮기고 여기서 호출만 한다.
#
# 사용법:  .\build-app-index.ps1                      # 해시만 갱신
#          .\build-app-index.ps1 2.9.1 "붙일 note"    # 버전·note 까지

# ★node 가 없으면 PowerShell 은 명령을 찾지 못해 $LASTEXITCODE 를 갱신하지 않는다.
#   그러면 이전 명령의 0 이 남아 '성공'으로 보고된다 — 이 스크립트가 없애려던 바로 그 실패다.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error 'node 를 찾을 수 없습니다. Node.js 설치 후 다시 실행하세요.'
  exit 1
}

# ⚠ $LASTEXITCODE 에 미리 대입하면 자동 변수를 지역 변수로 가려서, node 가 0 으로 끝나도
#   그 지역값($null)을 읽어 실패로 보고한다(실제로 당함). 대입하지 말고 그대로 읽는다.
try { & $node.Source (Join-Path $PSScriptRoot 'build-app-index.js') @args }
catch { Write-Error $_; exit 1 }
if ($null -eq $LASTEXITCODE) { exit 1 }   # 호출이 종료코드를 남기지 못한 경우
exit $LASTEXITCODE
