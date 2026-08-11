@echo off
REM Push source changes to master in one step.  Usage:  sync a short message
REM Stages only SOURCE (skips CI-generated docs/, logs, ledgers, caches).
setlocal
set "MSG=%*"
if "%MSG%"=="" ( echo Usage: sync your commit message here & goto :end )

cd /d "%~dp0" || goto :end

echo === Staging source (excluding generated data) ===
git add -A -- . ":(exclude)docs" ":(exclude)*.log" ":(exclude).backtest-cache" ":(exclude).dataset-cache" ":(exclude)screener-outcomes.json" ":(exclude)scorecard-tags.json" ":(exclude)alert-log.json" ":(exclude)feature-history.jsonl" ":(exclude).github/keepalive.json" ":(exclude)my-watchlists.json" ":(exclude)my-watchlists.html" ":(exclude)dataset.jsonl"

REM hub.html is a hand-maintained static page (not CI-generated), so include it
REM explicitly even though docs/ is excluded above - otherwise the git checkout below
REM would discard edits to it.
git add -f docs/hub.html 2>nul

git diff --cached --quiet
if not errorlevel 1 ( echo Nothing to commit - no source changes staged. & goto :end )

git commit -m "%MSG%" || goto :end

REM Discard local changes to generated/CI-owned files (docs pages, ledgers, caches)
REM BEFORE the rebase. Otherwise the rebase autostashes them and they collide with
REM the versions CI just pushed, leaving unmerged files that block the commit.
REM Source is already committed above, so this only throws away regenerable output.
REM WARNING THIS CAUSED THREE TIMES: if you rebuilt pages locally to preview a change,
REM this line silently throws that work away. Rebuild AFTER sync, never before.
git diff --quiet -- docs || set REBUILT_PAGES=1
git checkout -- . 2>nul

git pull --rebase origin master || ( echo *** Rebase conflict - tell Claude. & goto :end )
git push origin master || ( echo *** Push failed - tell Claude the message above. & goto :end )
echo.
echo === DONE: pushed to master ===
if defined REBUILT_PAGES (
  echo.
  echo *** NOTE: you had locally-rebuilt pages in docs\ and sync discarded them.
  echo     That is normal - CI owns docs\. If you wanted those pages live NOW,
  echo     re-run the generator then:  git add -f docs\THEPAGE.html ^&^& git commit ^&^& git push
)
:end
echo.
pause
