@echo off
chcp 65001 >nul
REM ============================================================================
REM  유비샵 무다이얼로그 인쇄 모드 실행기
REM  크롬을 --kiosk-printing 플래그로 다시 띄운다.
REM  → 이 상태에서 "바코드인쇄"를 누르면 크롬 인쇄창 없이 기본 프린터로 즉시 인쇄.
REM
REM  사전 준비(1회):
REM   1) Windows 기본 프린터를 Zebra GX430t 로 지정(설정>프린터).
REM   2) Zebra 용지 크기 60 x 10 mm, 여백 없음 으로 등록.
REM   3) 크롬 확장(ubishop-barcode-ext)을 평소 쓰는 프로필에 설치되어 있어야 함.
REM
REM  주의: 이 배치는 실행 중인 크롬을 모두 종료한 뒤 다시 켭니다.
REM        (플래그는 크롬이 새로 시작될 때만 적용되기 때문)
REM ============================================================================

set URL=http://ubdstore.ubshop.biz/info/item/infoItemList.do

echo 크롬을 종료하고 인쇄 모드로 다시 시작합니다...
taskkill /IM chrome.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul

set CHROME=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe

if "%CHROME%"=="" (
  echo [오류] chrome.exe 를 찾지 못했습니다. 크롬 설치 경로를 확인하세요.
  pause
  exit /b 1
)

start "" "%CHROME%" --kiosk-printing "%URL%"
echo 완료. 인쇄 모드 크롬이 실행되었습니다.
