@echo off
chcp 65001 >nul
setlocal
echo ============================================================
echo   DSH Token Ledger - Install
echo ============================================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-auto.ps1" -Action Install
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (echo [OK] Done. Now restart DSH normally.) else (echo [FAILED] See messages above. Exit code: %RC%)
echo.
pause