@echo off
rem Run install.ps1 with execution policy bypass (ASCII-only on purpose:
rem cmd.exe mis-parses UTF-8 comments when the file has no BOM).
setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" echo [exit %CODE%]
endlocal & exit /b %CODE%