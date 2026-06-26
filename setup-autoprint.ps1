# =============================================================================
#  setup-autoprint.ps1 — 유비샵 무다이얼로그 자동 인쇄 1회 설정
#  실행하면 이후 "평소처럼 크롬을 켜기만 해도" 인쇄창 없이 바로 인쇄된다.
#   1) Windows 시작 시 유비샵 인쇄크롬 자동 실행(시작프로그램)
#   2) 바탕화면/작업표시줄/시작메뉴 크롬 바로가기에 --kiosk-printing 자동 추가
#   3) 크롬 백그라운드 모드 OFF (닫으면 완전 종료 → 다음 실행 시 플래그 재적용)
#  (관리자 권한 불필요. 평소 크롬 프로필 그대로라 확장/로그인/위치설정 유지)
# =============================================================================
$ErrorActionPreference = 'Continue'
$URL  = 'http://ubdstore.ubshop.biz/info/item/infoItemList.do'
$FLAG = '--kiosk-printing'

Write-Host '유비샵 자동 인쇄 설정을 시작합니다...' -ForegroundColor Cyan

# 크롬 실행 파일 찾기
$cands = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
)
$chrome = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Host '[오류] chrome.exe 를 찾을 수 없습니다.' -ForegroundColor Red; return }
Write-Host "크롬: $chrome"

$ws = New-Object -ComObject WScript.Shell

# 1) 시작프로그램 등록
try {
  $startup = [Environment]::GetFolderPath('Startup')
  $path = Join-Path $startup '유비샵 인쇄크롬.lnk'
  $lnk = $ws.CreateShortcut($path)
  $lnk.TargetPath = $chrome
  $lnk.Arguments  = "$FLAG `"$URL`""
  $lnk.IconLocation = "$chrome,0"
  $lnk.Save()
  Write-Host '[1/3] 시작프로그램 등록 완료 (로그인 시 유비샵 인쇄크롬 자동 실행)' -ForegroundColor Green
} catch { Write-Host "[1/3] 시작프로그램 등록 실패: $($_.Exception.Message)" -ForegroundColor Yellow }

# 2) 기존 크롬 바로가기에 플래그 추가
$dirs = @(
  [Environment]::GetFolderPath('Desktop'),
  'C:\Users\Public\Desktop',
  [Environment]::GetFolderPath('Programs'),
  [Environment]::GetFolderPath('CommonPrograms'),
  "$env:AppData\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"
) | Select-Object -Unique
$mod = 0
foreach ($d in $dirs) {
  if (-not (Test-Path $d)) { continue }
  Get-ChildItem -Path $d -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $s = $ws.CreateShortcut($_.FullName)
      if ($s.TargetPath -like '*chrome.exe') {
        if ($s.Arguments -notmatch 'kiosk-printing') {
          $s.Arguments = ("$($s.Arguments) $FLAG").Trim()
          $s.Save()
          $mod++
          Write-Host "      수정: $($_.Name)"
        }
      }
    } catch {}
  }
}
Write-Host "[2/3] 크롬 바로가기 $mod 개에 인쇄플래그 추가" -ForegroundColor Green

# 3) 백그라운드 모드 OFF (HKCU 정책 — 관리자 불필요)
try {
  $reg = 'HKCU:\Software\Policies\Google\Chrome'
  if (-not (Test-Path $reg)) { New-Item -Path $reg -Force | Out-Null }
  Set-ItemProperty -Path $reg -Name 'BackgroundModeEnabled' -Value 0 -Type DWord
  Write-Host '[3/3] 크롬 백그라운드 모드 OFF' -ForegroundColor Green
} catch { Write-Host "[3/3] 백그라운드 모드 설정 실패: $($_.Exception.Message)" -ForegroundColor Yellow }

Write-Host ''
Write-Host '설정 완료!  지금 열려있는 크롬을 모두 닫았다가 다시 여세요.' -ForegroundColor Cyan
Write-Host '이후부터는 평소처럼 크롬을 켜기만 해도 인쇄창 없이 바로 인쇄됩니다.' -ForegroundColor Cyan
Write-Host '(Windows 기본 프린터가 Zebra GX430t 인지 확인하세요)'
