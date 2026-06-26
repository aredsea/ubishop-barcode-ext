@echo off
REM ============================================================================
REM  [Manual] Open UbiShop in kiosk-printing Chrome right now.
REM  Normally use "autoprint-setup.vbs" once instead of this.
REM  (uses your normal Chrome profile - extension/login/positions kept)
REM ============================================================================
set "URL=http://ubdstore.ubshop.biz/info/item/infoItemList.do"

echo Closing Chrome and reopening in print mode...
taskkill /F /T /IM chrome.exe >nul 2>&1

REM wait until chrome fully closed (max ~12s), else the flag is ignored
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
if "%CHROME%"=="" ( echo [ERROR] chrome.exe not found & pause & exit /b 1 )

start "" "%CHROME%" --kiosk-printing "%URL%"
