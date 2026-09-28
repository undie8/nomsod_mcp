@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0INSTALL-WINDOWS.ps1"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo Nomsod MCP installation failed with exit code %RC%.
  pause
)
exit /b %RC%
