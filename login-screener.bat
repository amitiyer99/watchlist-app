@echo off
REM ============================================================
REM  login-screener.bat  —  ONE-TIME Screener.in login.
REM  Opens the browser profile that fetch-screener uses. Log into
REM  Screener.in, then close the window. Your session persists, so
REM  fetch-screener.bat can then pull your screens (incl. private ones).
REM  You only need to re-run this if the session ever expires.
REM  Requires: Chromium installed (npx playwright install chromium).
REM ============================================================
setlocal
cd /d "%~dp0" || goto :end
echo.
echo === Opening browser for Screener.in login ===
echo   Log in, then CLOSE the browser window when you see your name top-right.
echo.
call npm run login-screener
echo.
echo Done. Next: run fetch-screener.bat
:end
echo.
pause
