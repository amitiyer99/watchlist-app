@echo off
REM ============================================================
REM  fetch-investors.bat  —  pull marquee-investor holdings.
REM  Reads investors-config.json, scrapes each superstar's Screener.in
REM  shareholder page (a browser window opens briefly), writes
REM  docs\investors-tickers.json, and pushes ONLY that sidecar.
REM  CI folds it into the Investors page, Confluence and Sniper.
REM  Needs the one-time login: run login-screener.bat first.
REM ============================================================
setlocal
cd /d "%~dp0" || goto :end
set GIT_EDITOR=true

echo.
echo === [1/2] Fetching marquee-investor holdings (a browser window will open briefly) ===
call npm run fetch-investors

findstr /C:"ticker" docs\investors-tickers.json >nul
if errorlevel 1 (
  echo.
  echo No holdings in file - fetch was blocked/empty.
  echo If it said NOT LOGGED IN, run login-screener.bat once, then re-run this.
  goto :end
)

echo.
echo === [2/2] Pushing investors-tickers.json (CI rebuilds the pages) ===
git fetch origin || goto :fail
git reset --soft origin/master || goto :fail
git restore --staged . 2>nul
git add -f docs\investors-tickers.json

git diff --cached --quiet
if not errorlevel 1 ( echo Sidecar unchanged since last push - nothing to do. & goto :end )

git commit -m "data: refresh marquee-investor holdings %date%" || goto :fail
git push origin master || ( echo *** Push rejected - CI pushed at the same moment. Just re-run this file. & goto :end )

echo.
echo === DONE. Marquee-investor data pushed - pages update on the next CI run. ===
goto :end

:fail
echo *** FAILED - paste the output to Claude. ***
:end
echo.
pause
