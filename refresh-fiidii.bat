@echo off
REM ============================================================
REM  refresh-fiidii.bat  —  the ONLY recurring task for the app.
REM  1) Fetches fresh NSE bulk/block deals via a real browser
REM     (the one thing the CI can't do — NSE blocks its IP).
REM  2) Pushes ONLY docs/deals.json; the CI rebuilds fiidii.html
REM     from it, so we never touch the generated page (no conflicts).
REM  Run weekly (or whenever you want the FII/DII page fresh).
REM  Requires: PC on/unlocked, Chromium installed (npx playwright install chromium).
REM ============================================================
setlocal
cd /d "%~dp0" || goto :end
set GIT_EDITOR=true

echo.
echo === [1/2] Fetching NSE bulk/block deals (a browser window will open briefly) ===
call npm run deals

REM Guard: only push if real deals came through — never overwrite good data with empty.
findstr /C:"symbol" docs\deals.json >nul
if errorlevel 1 (
  echo.
  echo No deals in file - NSE fetch was blocked or empty. Nothing pushed; existing data kept.
  echo Tip: if it keeps failing, try again off the corporate network.
  goto :end
)

echo.
echo === [2/2] Pushing deals.json (CI regenerates the page) ===
git fetch origin || goto :fail
git reset --soft origin/master || goto :fail
git restore --staged . 2>nul
git checkout -- docs/fiidii.html 2>nul
git add -f docs/deals.json

git diff --cached --quiet
if not errorlevel 1 ( echo deals.json unchanged since last push - nothing to do. & goto :end )

git commit -m "data: refresh NSE FII/DII bulk/block deals %date%" || goto :fail
git push origin master || ( echo *** Push rejected - CI pushed at the same moment. Just re-run this file. & goto :end )

echo.
echo === DONE. deals.json pushed - FII/DII page updates on the next CI run (a few min). ===
goto :end

:fail
echo *** FAILED - paste the output to Claude. ***
:end
echo.
pause
