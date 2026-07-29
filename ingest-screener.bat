@echo off
REM ============================================================
REM  ingest-screener.bat  —  import Screener.in custom screens.
REM  1) Export each screen from Screener.in as CSV and save it into
REM     the imports\screener\ folder (filename = the screen's name).
REM  2) Run this file. It parses them, resolves names to tickers,
REM     writes docs\screenerin-tickers.json, and pushes ONLY that
REM     sidecar. CI then folds it into Confluence + Sniper.
REM  Re-run whenever you tweak a screen or want fresh fundamentals.
REM ============================================================
setlocal
cd /d "%~dp0" || goto :end
set GIT_EDITOR=true

echo.
echo === [1/2] Parsing Screener.in CSV export(s) ===
call npm run ingest-screener

if not exist "docs\screenerin-tickers.json" (
  echo.
  echo No sidecar produced - did you drop CSV files into imports\screener\ ?
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

git commit -m "data: refresh Screener.in fundamental screens %date%" || goto :fail
git push origin master || ( echo *** Push rejected - CI pushed at the same moment. Just re-run this file. & goto :end )

echo.
echo === DONE. Screener.in data pushed - Confluence + Sniper update on the next CI run. ===
goto :end

:fail
echo *** FAILED - paste the output to Claude. ***
:end
echo.
pause
