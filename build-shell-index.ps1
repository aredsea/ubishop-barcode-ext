# build-shell-index.ps1 — 껍데기(folder-lock) 파일의 SHA256 인덱스 생성.
# 프로그램(D102LabelPrinter)의 ExtSync 가 이 shell-files.json 을 raw 에서 받아
# 로컬 안정 경로와 대조 → 바뀐 파일만 다운로드·교체한다.
#
# 배포 절차: 껍데기 수정 → manifest version 올림 → 이 스크립트 실행 → git push.
# 로직 파일(app-files.json 대상)은 여기 포함하지 않는다(loader 가 즉시 로드).

$root = $PSScriptRoot
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json

# 껍데기 파일 = crx/폴더 교체가 필요했던 파일들(loader 로 원격 로드 안 되는 것).
$patterns = @(
  'manifest.json',
  'src/loader.js',
  'src/localbridge.js',
  'src/background.js',
  'src/skin.js',
  'popup/popup.html',
  'popup/popup.js',
  'rules/cache.json'
)

$files = @()
foreach ($rel in $patterns) {
  $full = Join-Path $root $rel
  if (Test-Path $full) {
    $hash = (Get-FileHash $full -Algorithm SHA256).Hash.ToLower()
    $files += [ordered]@{ path = $rel.Replace('\', '/'); sha256 = $hash }
  } else {
    Write-Warning "누락: $rel"
  }
}

# icons/* 전체
$iconDir = Join-Path $root 'icons'
if (Test-Path $iconDir) {
  foreach ($ic in Get-ChildItem $iconDir -File) {
    $hash = (Get-FileHash $ic.FullName -Algorithm SHA256).Hash.ToLower()
    $files += [ordered]@{ path = "icons/$($ic.Name)"; sha256 = $hash }
  }
}

$out = [ordered]@{ version = $manifest.version; files = $files }
$json = $out | ConvertTo-Json -Depth 5
Set-Content (Join-Path $root 'shell-files.json') -Value $json -Encoding UTF8
Write-Host "shell-files.json v$($manifest.version): $($files.Count) files"
