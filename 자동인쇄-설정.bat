@echo off
REM One-time setup for UbiShop silent printing (no print dialog).
REM Runs autoprint-setup.vbs (creates startup shortcut, patches Chrome shortcuts, background OFF).
wscript.exe "%~dp0autoprint-setup.vbs"
