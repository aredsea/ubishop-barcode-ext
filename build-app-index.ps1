# build-app-index.ps1 — 로직채널(app-files.json)의 files 각각을 LF 정규화 SHA-256 →
#   app-files.json 의 sha256 맵 갱신. loader.js 가 이 값과 raw fetch 바이트를 대조(all-or-nothing).
#
# ⚠ raw(github)는 텍스트를 LF 로 저장 → 해시도 LF 기준(CRLF→LF 정규화 후 SHA-256).
#    build-shell-index.ps1 과 동일 규약.
#
# 로직 배포 절차: 로직파일 수정 → 이 스크립트 실행 → git push.

$root = $PSScriptRoot
$appPath = Join-Path $root 'app-files.json'
$app = Get-Content $appPath -Raw | ConvertFrom-Json

function Get-LfHash([string]$path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  # CRLF(0D0A) → LF(0A) 정규화(raw=LF 규약 재현)
  $out = New-Object System.Collections.Generic.List[byte]
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    if ($bytes[$i] -eq 0x0D -and ($i + 1) -lt $bytes.Length -and $bytes[$i + 1] -eq 0x0A) { continue }
    $out.Add($bytes[$i])
  }
  return ([BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData($out.ToArray()))).Replace('-', '').ToLower()
}

$sha = [ordered]@{}
foreach ($rel in $app.files) {
  $full = Join-Path $root $rel
  if (Test-Path $full) { $sha[$rel] = (Get-LfHash $full) }
  else { Write-Warning "누락: $rel" }
}
$app | Add-Member -NotePropertyName sha256 -NotePropertyValue $sha -Force
$app | ConvertTo-Json -Depth 6 | Set-Content $appPath -Encoding UTF8
Write-Host "app-files.json sha256: $($sha.Count) files"
