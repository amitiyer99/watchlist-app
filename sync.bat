@echo off
REM Push source changes to master in one step.  Usage:  sync a short message
REM Stages only SOURCE (skips CI-generated docs/, logs, ledgers, caches).
setlocal
set "MSG=%*"
if "%MSG%"=="" ( echo Usage: sync your commit message here & goto :end )

cd /d "%~dp0" || goto :end

echo === Staging source (excluding generated data) ===
git add -A -- . ":(exclude)docs" ":(exclude)*.log" ":(exclude).backtest-cache" ":(exclude).dataset-cache" ":(exclude)screener-outcomes.json" ":(exclude)scorecard-tags.json" ":(exclude)alert-log.json" ":(exclude)feature-history.jsonl" ":(exclude).github/keepalive.json" ":(exclude)my-watchlists.json" ":(exclude)my-watchlists.html" ":(exclude)dataset.jsonl"

REM hub.html and playbook.html are hand-maintained static pages (not CI-generated), so include them
REM explicitly even though docs/ is excluded above - otherwise the git checkout below
REM would discard edits to it.
git add -f docs/hub.html 2>nul
git add -f docs/playbook.html 2>nul
git add -f compounder-positions.json 2>nul

git diff --cached --quiet
if not errorlevel 1 ( echo Nothing to commit - no source changes staged. & goto :end )

git commit -m "%MSG%" || goto :end

REM UNTRACKED CI artifacts abort the rebase. When a local run of an analysis tool
REM (factor-lab, score-lab, audit-*) writes docs\*.json that CI has since started
REM publishing, git refuses to overwrite the untracked copy with:
REM   "error: The following untracked working tree files would be overwritten by checkout"
REM and the rebase aborts, leaving the push rejected as non-fast-forward. These files are
REM all regenerable reports owned by CI, so delete them before pulling.
for %%F in (factor-lab score-lab pipeline-audit ai-research-audit earnings-quality) do (
  if exist "docs\%%F.json" (
    git ls-files --error-unmatch "docs/%%F.json" >nul 2>&1 || del /q "docs\%%F.json"
  )
)

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
