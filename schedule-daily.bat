@echo off
REM ============================================================
REM  schedule-daily.bat  —  register the Watchlist daily refresh
REM  with Windows Task Scheduler. Double-click ONCE to set up.
REM  Runs refresh-all.bat Mon-Fri at 08:30 while you're logged in,
REM  and catches up if 08:30 was missed (laptop off/asleep).
REM  Delegates to schedule-daily.ps1 so paths + the "start when
REM  available" setting register cleanly. No admin rights needed.
REM ============================================================
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0schedule-daily.ps1"
if errorlevel 1 (
  echo.
  echo *** Could not register the task. Copy the message above to Claude.
)
echo.
pause
