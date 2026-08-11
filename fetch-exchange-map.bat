@echo off
REM ============================================================
REM  fetch-exchange-map.bat  —  resolve NSE vs BSE ticker identity.
REM  Works out, for every ticker in our sidecars, which exchange it
REM  trades on and the symbol Yahoo knows it by (NSE = TICKER.NS,
REM  BSE = <scripCode>.BO), and computes ADV20 for BSE names so the
REM  same liquidity floor applies to them. Caches to
REM  docs\exchange-map.json and pushes it; CI rebuilds the pages.
REM
REM  Capped at 250 unresolved tickers per run, so re-run a few times
REM  (or just let the daily refresh-all.bat finish it over a few days).
REM  To do more in one go:  set MAX_RESOLVE=600 && fetch-exchange-map.bat
REM  No browser needed - this one only talks to Yahoo.
REM ============================================================
setlocal
cd /d "%~dp0" || goto :end
set GIT_EDITOR=true

echo.
echo === [1/2] Resolving ticker exchanges (Yahoo probe + name search) ===
call npm run fetch-exchange-map

if not exist "docs\exchange-map.json" (
  echo.
  echo No map produced - check the output above.
  goto :end
)

echo.
echo === [2/2] Pushing exchange-map.json (CI rebuilds the pages) ===
git fetch origin || goto :fail
git reset --soft origin/master || goto :fail
git restore --staged . 2>nul
git add -f docs\exchange-map.json

git diff --cached --quiet
if not errorlevel 1 ( echo Map unchanged since last push - nothing to do. & goto :end )

git commit -m "data: refresh NSE/BSE exchange map %date%" || goto :fail
git push origin master || ( echo *** Push rejected - CI pushed at the same moment. Just re-run this file. & goto :end )

echo.
echo === DONE. Exchange map pushed - BSE names now price off .BO and face the liquidity floor. ===
goto :end

:fail
echo *** FAILED - paste the output to Claude. ***
:end
echo.
pause
