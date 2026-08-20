@echo off
REM ============================================================
REM  rebuild-pages.bat  —  rebuild every HTML page LOCALLY and
REM  push the results, bypassing GitHub Actions entirely.
REM
REM  WHY THIS EXISTS
REM  sync.bat deliberately excludes docs\ because CI owns it. So
REM  after a SOURCE change (a generator, or anything in lib\) the
REM  fix is on master but the live site still serves the last
REM  CI-built HTML — which is how the 🧠 model fix looked "not
REM  applied" for an hour while scheduled workflows were throttled.
REM
REM  Run this when you need a source change live NOW and don't
REM  want to wait for, or fight with, the scheduler.
REM
REM  Needs: internet (Tickertape + Yahoo, both public - no keys).
REM  Takes: roughly 5-12 minutes.
REM ============================================================
setlocal
cd /d "%~dp0" || exit /b 1

echo === Rebuilding pages (this takes several minutes) ===
echo.

REM Order matters: breakout2 writes nse-tickers.json / breakout2-data.json,
REM which triggers, confluence, apex and bestpicks all read.
for %%G in (
  generate-breakout2.js
  generate-apex.js
  generate-multibagger.js
  generate-creamy.js
  generate-indianresearch.js
  generate-sectors.js
  generate-rocket.js
  generate-trendingvalue.js
  generate-compounders.js
  generate-fiidii.js
  generate-investors.js
  generate-triggers.js
  generate-sniper.js
  generate-confluence.js
  generate-debate.js
  generate-prediction.js
  generate-bestpicks.js
  generate-alerts.js
  generate-dashboard.js
) do (
  echo --- %%G
  call node %%G
  REM Keep going on failure: one dead data source should not stop 18 other pages
  REM from picking up the fix. Failures are printed above and worth pasting to Claude.
  if errorlevel 1 echo     *** FAILED: %%G  ^(continuing^)
)

echo.
echo === Checking the emitted page JS actually parses ===
REM A source change that breaks emitted browser JS produces a page that looks
REM fine and silently does nothing. audit check G catches it - read the HIGH lines.
call node audit-pipeline.js 2>&1 | findstr /c:"BROKEN PAGE JS" /c:"HIGH" /c:"Summary:"

echo.
echo === Staging the rebuilt pages ===
git add -f docs\*.html 2>nul
git add -f docs\*.json 2>nul

git diff --cached --quiet
if not errorlevel 1 (
  echo Nothing changed - pages already match what is committed.
  goto :end
)

git commit -m "data: local page rebuild" || goto :end
git pull --rebase origin master || ( echo *** Rebase conflict - tell Claude. & goto :end )
git push origin master || ( echo *** Push failed - tell Claude the message above. & goto :end )

echo.
echo === DONE ===
echo Pages pushed. GitHub Pages takes a minute or two, then hard-refresh
echo the browser with Ctrl+Shift+R - a normal reload serves the cached copy.
echo.
echo Verify you are on the new build: the "Generated:" line at the top of any
echo page should show the time you just ran this, not an earlier one.

:end
echo.
pause
