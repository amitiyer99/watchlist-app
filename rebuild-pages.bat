@echo off
REM ============================================================
REM  rebuild-pages.bat  —  rebuild every HTML page LOCALLY and
REM  push, bypassing GitHub Actions.
REM
REM  WHY THIS EXISTS
REM  sync.bat excludes docs\ because CI owns it. So after a SOURCE
REM  change the fix is on master while the live site still serves
REM  the last CI-built HTML. Use this when you need it live NOW.
REM
REM  THREE RULES LEARNED THE HARD WAY
REM  1. SYNC BEFORE GENERATING, NEVER AFTER. v1 generated pages,
REM     committed, then ran `git pull --rebase`. CI regenerates the
REM     same docs\*.html, so that conflicted on ~19 files and left
REM     the repo mid-rebase with a detached HEAD - twice. Rebasing
REM     your generated output onto someone else's cannot work.
REM  2. NOT EVERYTHING IN docs\ IS REGENERABLE. Some is state built
REM     up over days, and a hard reset destroys it:
REM       cashflow.json          ~1,600 Yahoo requests over ~2 weeks
REM       earnings-quality.json  one Screener.in page load per stock
REM       tv-fields.json         the API field-code probe results
REM       compounder-*           the cohort and its quarterly log
REM       screener-outcomes.json THE OUTCOME LEDGER - every
REM                              measurement this project has made
REM     A reset already cost one 600-stock cash-flow fetch. These are
REM     copied out and restored around the reset.
REM  3. UNTRACKED FILES BLOCK A RESET. A docs\*.json that is untracked
REM     locally but tracked upstream aborts the checkout outright
REM     ("would be overwritten by reset"). Generated sidecars are
REM     cleared first, the way sync.bat already does.
REM
REM  Needs: internet (Tickertape + Yahoo, both public - no keys).
REM  Takes: roughly 5-12 minutes.
REM ============================================================
setlocal
cd /d "%~dp0" || exit /b 1

REM Refuse to run from a half-finished git operation - that is how the last two
REM tangles compounded. Bail loudly rather than making it worse.
if exist ".git\rebase-merge" goto :midgit
if exist ".git\rebase-apply" goto :midgit
if exist ".git\MERGE_HEAD" goto :midgit

set "KEEP=%TEMP%\watchlist-keep"
set "CACHES=cashflow.json earnings-quality.json tv-fields.json compounder-cohort.json compounder-log.jsonl"
set "LEDGERS=screener-outcomes.json screener-weights.json scorecard-tags.json feature-history.jsonl"
REM Purely derived sidecars: safe to delete, and deleting them is what stops an
REM untracked-vs-tracked collision from aborting the reset below.
set "DERIVED=trendingvalue-universe.json pipeline-audit.json factor-lab.json score-lab.json"

if exist "%KEEP%" rd /s /q "%KEEP%"
mkdir "%KEEP%\docs" 2>nul
for %%F in (%CACHES%) do if exist "docs\%%F" copy /y "docs\%%F" "%KEEP%\docs\%%F" >nul
for %%F in (%LEDGERS%) do if exist "%%F" copy /y "%%F" "%KEEP%\%%F" >nul

echo === Syncing to origin (regenerable pages only; caches preserved) ===
git fetch origin || ( echo *** fetch failed - check your connection. & goto :end )
for %%F in (%DERIVED%) do (
  if exist "docs\%%F" git ls-files --error-unmatch "docs/%%F" >nul 2>&1 || del /q "docs\%%F"
)
git checkout master 2>nul
git reset --hard origin/master || ( echo *** reset failed - paste the message to Claude. & goto :end )

for %%F in (%CACHES%) do if exist "%KEEP%\docs\%%F" copy /y "%KEEP%\docs\%%F" "docs\%%F" >nul
for %%F in (%LEDGERS%) do if exist "%KEEP%\%%F" copy /y "%KEEP%\%%F" "%%F" >nul
echo   caches and ledgers preserved
echo.

echo === Rebuilding pages (several minutes) ===
echo.

REM Order matters: fetch-cashflow feeds the P/CF factor and must precede
REM generate-trendingvalue; breakout2 writes the sidecars triggers, confluence,
REM apex and bestpicks all read.
for %%G in (
  fetch-cashflow.js
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
  REM Keep going: one dead data source should not stop 19 other pages from
  REM picking up the fix. Failures print above and are worth pasting to Claude.
  if errorlevel 1 echo     *** FAILED: %%G  ^(continuing^)
)

echo.
echo === Checking the emitted page JS actually parses ===
REM A source change that breaks emitted browser JS produces a page that looks fine
REM and silently does nothing. Audit check G catches it - read the HIGH lines.
call node audit-pipeline.js 2>&1 | findstr /c:"BROKEN PAGE JS" /c:"HIGH" /c:"Summary:"

echo.
echo === Staging and pushing ===
git add -f docs\*.html 2>nul
git add -f docs\*.json 2>nul
git add -f docs\*.jsonl 2>nul
for %%F in (%LEDGERS%) do git add -f "%%F" 2>nul

git diff --cached --quiet
if not errorlevel 1 (
  echo Nothing changed - pages already match what is committed.
  goto :end
)

git commit -m "data: local page rebuild" || goto :end

REM Plain push - NO rebase, NO pull. We reset to origin at the top, so this is a
REM fast-forward unless CI pushed during the minutes of generating.
git push origin master && goto :pushed
echo.
echo *** Push rejected - CI pushed while this was running.
echo     Nothing is lost. Just run this script again; it re-syncs at the top.
goto :end

:pushed
echo.
echo === DONE ===
echo Pushed. GitHub Pages takes a minute or two, then hard-refresh with
echo Ctrl+Shift+R - a normal reload serves the cached copy.
echo.
echo Check you are on the new build: the "Generated:" line at the top of any page
echo should show the time you just ran this.
goto :end

:midgit
echo *** A git operation is already in progress (rebase or merge).
echo     Finish or abort it first, then re-run. Refusing to make it worse.

:end
echo.
pause
