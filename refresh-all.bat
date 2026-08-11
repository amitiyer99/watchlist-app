@echo off
REM ============================================================
REM  refresh-all.bat  —  ONE daily unattended refresh of every
REM  data source that CI can't fetch (they need your logged-in
REM  browser): NSE FII/DII deals, Screener.in screens, marquee
REM  investor holdings. Fetches all three, then pushes the
REM  sidecars in a single commit; CI rebuilds the pages.
REM
REM  Scheduler-friendly: no pause; logs to refresh-all.log.
REM  Requirements: PC on + you logged in (interactive session, so
REM  the NSE browser can appear) + a valid Screener.in session
REM  (run login-screener.bat once; re-run if it ever expires).
REM  Register it with:  schedule-daily.bat  (double-click once).
REM ============================================================
setlocal
cd /d "%~dp0" || exit /b 1
set GIT_EDITOR=true
set "LOG=%~dp0refresh-all.log"
echo. >> "%LOG%"
echo ================ Daily refresh %date% %time% ================ >> "%LOG%"

echo [0/5] Syncing latest source from origin... >> "%LOG%"
git fetch origin >> "%LOG%" 2>&1
REM Fast-forward ONLY: pulls new source/CI commits when the local clone is simply
REM behind, but never merges, rebases or discards anything if histories diverge or
REM the tree is dirty (it just no-ops and the run continues on current code).
git merge --ff-only origin/master >> "%LOG%" 2>&1

echo [1/5] NSE FII/DII bulk/block deals... >> "%LOG%"
call npm run deals >> "%LOG%" 2>&1

echo [2/5] Screener.in quality screens... >> "%LOG%"
call npm run fetch-screener >> "%LOG%" 2>&1

REM Space out the two Screener.in fetches so we stay under its rate limit.
timeout /t 90 /nobreak >nul

echo [3/5] Marquee investor holdings... >> "%LOG%"
call npm run fetch-investors >> "%LOG%" 2>&1

REM Space out again before the next Screener.in pass.
timeout /t 90 /nobreak >nul

echo [4/5] Earnings quality (quarterly acceleration + results recency)... >> "%LOG%"
call npm run fetch-earnings-quality >> "%LOG%" 2>&1

echo [5/5] Exchange map (NSE vs BSE symbol identity + BSE liquidity)... >> "%LOG%"
call npm run fetch-exchange-map >> "%LOG%" 2>&1

echo Pushing sidecars (CI rebuilds the pages)... >> "%LOG%"
git fetch origin >> "%LOG%" 2>&1
git reset --soft origin/master >> "%LOG%" 2>&1
git restore --staged . 2>nul
REM Only these generated sidecars — never source or other docs.
git add -f docs\deals.json docs\screenerin-tickers.json docs\investors-tickers.json docs\earnings-quality.json docs\exchange-map.json 2>nul

git diff --cached --quiet
if not errorlevel 1 ( echo   Nothing changed - nothing to push. >> "%LOG%" & goto :end )

git commit -m "data: daily local refresh %date%" >> "%LOG%" 2>&1
git push origin master >> "%LOG%" 2>&1
if errorlevel 1 (
  echo   Push rejected ^(CI pushed at the same time^) - will catch up next run. >> "%LOG%"
) else (
  echo   Done - pushed. >> "%LOG%"
)
:end
echo ================ End %date% %time% ================ >> "%LOG%"
endlocal
