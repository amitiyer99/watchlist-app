@echo off
REM One-shot: push the FII/DII page (source) + the hub tile edit (a docs/ file
REM that normal sync skips). Double-click, or run from anywhere.
setlocal
cd /d "%~dp0" || goto :end

echo === Staging source (excluding generated data) ===
git add -A -- . ":(exclude)docs" ":(exclude)*.log" ":(exclude).backtest-cache" ":(exclude).dataset-cache" ":(exclude)screener-outcomes.json" ":(exclude)scorecard-tags.json" ":(exclude)alert-log.json" ":(exclude)feature-history.jsonl" ":(exclude).github/keepalive.json" ":(exclude)my-watchlists.json" ":(exclude)my-watchlists.html" ":(exclude)dataset.jsonl"

echo === Also staging the hub tile edit (docs/hub.html) ===
git add -f docs/hub.html

git diff --cached --quiet
if not errorlevel 1 ( echo Nothing to commit. & goto :end )

git commit -m "feat: FII/DII institutional confluence page + hub tile + gitattributes LF fix" || goto :end
git pull --rebase origin master || ( echo *** Rebase conflict - tell Claude. & goto :end )
git push origin master || ( echo *** Push failed - tell Claude the message above. & goto :end )
echo.
echo === DONE: pushed to master ===
:end
echo.
pause
