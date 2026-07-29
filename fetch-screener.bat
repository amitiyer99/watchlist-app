@echo off
REM ============================================================
REM  fetch-screener.bat  —  pull your Screener.in screen(s) live.
REM  1) Runs the raw queries in screener-config.json against
REM     Screener.in (a browser window opens briefly) and writes
REM     docs\screenerin-tickers.json.
REM  2) Pushes ONLY that sidecar; CI folds it into Confluence +
REM     Sniper (so we never touch the generated pages -> no conflicts).
REM  Re-run whenever you tweak the query or want fresh fundamentals.
REM  Requires: PC on/unlocked, Chromium installed (npx playwright install chromium).
REM ============================================================
setlocal
cd /d "%~dp0" || goto :end
set GIT_EDITOR=true

echo.
echo === [1/2] Fetching Screener.in screen(s) (a browser window will open briefly) ===
call npm run fetch-screener

findstr /C:"ticker" docs\screenerin-tickers.json >nul
if errorlevel 1 (
  echo.
  echo No stocks in file - the fetch was blocked/empty. Nothing pushed; existing data kept.
  goto :end
)

echo.
echo === [2/2] Pushing screenerin-tickers.json (CI rebuilds the pages) ===
git fetch origin || goto :fail
git reset --soft origin/master || goto :fail
git restore --staged . 2>nul
git add -f docs\screenerin-tickers.json

git diff --cached --quiet
if not errorlevel 1 ( echo Sidecar unchanged since last push - nothing to do. & goto :end )

git commit -m "data: refresh Screener.in quality screen %date%" || goto :fail
git push origin master || ( echo *** Push rejected - CI pushed at the same moment. Just re-run this file. & goto :end )

echo.
echo === DONE. Screener.in data pushed - Confluence + Sniper update on the next CI run. ===
goto :end

:fail
echo *** FAILED - paste the output to Claude. ***
:end
echo.
pause
