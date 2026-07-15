# build-shell-index.ps1 — 껍데기(folder-lock) 파일의 SHA256 인덱스 생성.
# 프로그램(D102LabelPrinter)의 ExtSync 가 이 shell-files.json 을 raw 에서 받아
# 로컬 안정 경로와 대조 → 바뀐 파일만 다운로드·교체한다.
#
# ⚠ git autocrlf 로 raw(github)는 텍스트 파일을 LF 로 저장한다. 따라서 해시도
#    LF 기준으로 계산해야 ExtSync 의 다운로드(raw=LF) 검증과 일치한다.
#    텍스트 파일은 CRLF(0D0A)→LF(0A) 정규화 후 SHA256.
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
  'src/fsm.js',
  'src/background.js',
  'src/skin.js',
  'popup/popup.html',
  'popup/popup.js',
  'rules/cache.json'
)
$textExt = @('.js', '.json', '.html', '.htm', '.css', '.xml', '.md', '.txt', '.svg')

function Get-ShellHash([string]$path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $ext = [System.IO.Path]::GetExtension($path).ToLower()
  if ($textExt -contains $ext) {
    # CRLF(0D 0A) → LF(0A): git autocrlf 정규화를 재현해 raw(LF) 해시와 맞춘다.
    $out = New-Object System.Collections.Generic.List[byte]
    for ($i = 0; $i -lt $bytes.Length; $i++) {
      if ($bytes[$i] -eq 0x0D -and ($i + 1) -lt $bytes.Length -and $bytes[$i + 1] -eq 0x0A) { continue }
      $out.Add($bytes[$i])
    }
    $bytes = $out.ToArray()
  }
  return ([BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData($bytes))).Replace('-', '').ToLower()
}

$files = @()
foreach ($rel in $patterns) {
  $full = Join-Path $root $rel
  if (Test-Path $full) {
    $files += [ordered]@{ path = $rel.Replace('\', '/'); sha256 = (Get-ShellHash $full) }
  } else {
    Write-Warning "누락: $rel"
  }
}

# icons/* 전체 (바이너리 → 정규화 없이 원본 해시)
$iconDir = Join-Path $root 'icons'
if (Test-Path $iconDir) {
  foreach ($ic in Get-ChildItem $iconDir -File) {
    $files += [ordered]@{ path = "icons/$($ic.Name)"; sha256 = (Get-ShellHash $ic.FullName) }
  }
}

$out = [ordered]@{ version = $manifest.version; files = $files }
$json = $out | ConvertTo-Json -Depth 5
Set-Content (Join-Path $root 'shell-files.json') -Value $json -Encoding UTF8
Write-Host "shell-files.json v$($manifest.version): $($files.Count) files (LF-normalized text hashes)"
