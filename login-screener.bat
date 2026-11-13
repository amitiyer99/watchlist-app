@echo off
REM ============================================================
REM  login-screener.bat  —  ONE-TIME Screener.in login in Chrome.
REM  Opens Google Chrome with the watchlist session. Log into
REM  Screener.in (credentials or autofill).
REM  Once logged in, it auto-detects, saves the session, and
REM  immediately updates all superstar marquee investor filings!
REM ============================================================
setlocal
cd /d "%~dp0" || goto :end
echo.
echo === Opening Google Chrome for Screener.in login ===
echo   Log into Screener.in in the Chrome window that opens.
echo   Login is auto-detected — the window will close and sync automatically!
echo.
call npm run login-screener
echo.
echo Done! All Screener and Marquee Investor data is now synced.
:end
echo.
pause
