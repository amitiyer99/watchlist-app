@echo off
REM ============================================================
REM  schedule-daily.bat  —  register refresh-all.bat to run on
REM  WEEKDAYS (Mon-Fri) via Windows Task Scheduler. Double-click ONCE.
REM  Runs at 08:30 each weekday morning, only while you're logged in
REM  (so the NSE browser window can appear). No admin rights needed.
REM ============================================================
setlocal
set "TASK=Watchlist Daily Refresh"
set "TIME=08:30"

schtasks /create /tn "%TASK%" /tr "\"%~dp0refresh-all.bat\"" /sc weekly /d MON,TUE,WED,THU,FRI /st %TIME% /f
if errorlevel 1 (
  echo.
  echo *** Could not create the task. Copy the message above to Claude.
) else (
  echo.
  echo Scheduled "%TASK%" to run Mon-Fri at %TIME% while you are logged in.
  echo   - Change the time:   re-run this after editing the TIME= line above.
  echo   - Run it now to test: schtasks /run /tn "%TASK%"
  echo   - See status:         schtasks /query /tn "%TASK%"
  echo   - Remove it:          schtasks /delete /tn "%TASK%" /f
  echo   - Output log:         refresh-all.log  in this folder
)
echo.
pause
