# Watchlist evening refresh — runs fetch, rebuilds dashboard, commits & pushes
# Scheduled via Windows Task Scheduler (weekdays, ~7 PM IST)

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $appDir

$log = Join-Path $appDir "refresh.log"
$timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")

function Log($msg) {
  $line = "[$timestamp] $msg"
  Write-Host $line
  Add-Content -Path $log -Value $line
}

Log "=== Evening refresh started ==="

# 1. Scrape Tickertape watchlists (opens browser, requires saved session)
Log "Step 1: Fetching watchlist from Tickertape..."
$r1 = & node fetch.js 2>&1
$r1 | ForEach-Object { Log "  fetch: $_" }
if ($LASTEXITCODE -ne 0) { Log "ERROR: fetch.js failed"; exit 1 }

# 2. Rebuild dashboard HTML
Log "Step 2: Generating dashboard..."
$r2 = & node generate-dashboard.js 2>&1
$r2 | ForEach-Object { Log "  dashboard: $_" }
if ($LASTEXITCODE -ne 0) { Log "ERROR: generate-dashboard.js failed"; exit 1 }

# 3. Commit and push if anything changed
Log "Step 3: Committing and pushing..."
$status = & git status --porcelain 2>&1
if ($status) {
  $date = (Get-Date).ToString("yyyy-MM-dd")
  & git add my-watchlists.json docs/index.html
  & git commit -m "data: evening refresh $date"
  & git push
  Log "Pushed: $status"
} else {
  Log "No changes to commit."
}

Log "=== Refresh complete ==="
