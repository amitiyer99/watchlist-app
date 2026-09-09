@echo off
REM One-click catch-up: start GitHub Market Refresh only.
REM Do not also run Keep Alive — that queues/cancels and has no catchup input.
setlocal
cd /d "%~dp0" || exit /b 1

echo Starting Market Refresh...
gh workflow run "Market Refresh (10 min)" -f catchup=true
if errorlevel 1 (
  echo.
  echo Failed to start. From this folder run:  gh auth login
  goto :end
)

echo Waiting a few seconds for GitHub...
timeout /t 5 /nobreak >nul
echo.
gh run list --workflow "Market Refresh (10 min)" --limit 3
echo.
echo Takes about 20 minutes. Watch with:
echo   gh run watch
echo.

:end
pause
endlocal
