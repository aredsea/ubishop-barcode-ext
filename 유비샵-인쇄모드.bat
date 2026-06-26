@echo off
chcp 65001 >nul
REM ============================================================================
REM  유비샵 무다이얼로그 인쇄 크롬 실행기 (전용 프로필)
REM
REM  평소 크롬과 "별도 프로필"로 크롬을 띄워 --kiosk-printing 을 항상 적용한다.
REM  → 이 창에서 "바코드인쇄"를 누르면 크롬 인쇄창 없이 기본 프린터로 즉시 인쇄.
REM  (기존 방식은 평소 크롬과 프로세스가 합쳐져 플래그가 무시되는 문제가 있었음)
REM
REM  ※ 매 인쇄마다 실행할 필요 없음. 이 창을 띄워두고 계속 인쇄하면 됨.
REM    아침에 한 번 더블클릭 → 종일 이 창에서 인쇄.
REM
REM  최초 1회 준비:
REM   1) 이 창(전용 프로필)에서 유비샵에 "로그인" (이후 기억됨)
REM   2) Windows 기본 프린터 = Zebra GX430t, 용지 60 x 10 mm
REM   3) 처음 뜨면 위치 편집기로 라벨 위치 맞추고 "저장"
REM ============================================================================

set "URL=http://ubdstore.ubshop.biz/info/item/infoItemList.do"
set "PROFILE=%LocalAppData%\UBKioskChrome"

REM 이 배치 파일이 있는 폴더 = 확장 폴더 (자동 로드)
set "EXTDIR=%~dp0"
if "%EXTDIR:~-1%"=="\" set "EXTDIR=%EXTDIR:~0,-1%"

REM 크롬 실행 파일 찾기
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if "%CHROME%"=="" (
  echo [오류] chrome.exe 를 찾지 못했습니다. 크롬 설치 경로를 확인하세요.
  pause
  exit /b 1
)

start "" "%CHROME%" --kiosk-printing --user-data-dir="%PROFILE%" --load-extension="%EXTDIR%" --no-first-run --no-default-browser-check "%URL%"
echo 인쇄모드 크롬을 실행했습니다. 이 창은 닫아도 됩니다.
