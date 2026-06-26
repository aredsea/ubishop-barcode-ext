@echo off
chcp 65001 >nul
REM ============================================================================
REM  [수동] 지금 바로 인쇄모드 크롬 열기
REM  보통은 "자동인쇄-설정.bat" 으로 1회 설정하면 이 파일은 쓸 일이 없다.
REM  (평소 크롬 프로필 그대로 — 확장/로그인/위치설정 유지)
REM ============================================================================
set "URL=http://ubdstore.ubshop.biz/info/item/infoItemList.do"

echo 인쇄모드로 크롬을 다시 엽니다. (잠시 크롬이 모두 닫힙니다)
taskkill /F /T /IM chrome.exe >nul 2>&1

REM 크롬이 완전히 종료될 때까지 대기(최대 ~12초) — 안 그러면 플래그가 무시됨
set /a n=0
:wait
tasklist /FI "IMAGENAME eq chrome.exe" 2>nul | find /I "chrome.exe" >nul
if not errorlevel 1 (
  set /a n+=1
  if %n% LSS 12 ( timeout /t 1 /nobreak >nul & goto wait )
)

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if "%CHROME%"=="" ( echo [오류] chrome.exe 를 찾지 못함 & pause & exit /b 1 )

start "" "%CHROME%" --kiosk-printing "%URL%"
