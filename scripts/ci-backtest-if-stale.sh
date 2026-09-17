#!/usr/bin/env bash
# Re-run the historical breakout harness when docs/backtest-report.json is missing
# or older than STALE_DAYS. Uses --quick so Daily Refresh stays within Actions time
# (watchlist universe, 3y bars, max 200 tickers).
set -euo pipefail

REPORT=docs/backtest-report.json
STALE_DAYS=${BACKTEST_STALE_DAYS:-14}
NOW_EPOCH=$(date +%s)
STALE_SECS=$((STALE_DAYS * 86400))

need_refresh=false
reason=""

if [ ! -f "$REPORT" ]; then
  need_refresh=true
  reason="missing"
else
  iso=$(git log -1 --format="%cI" -- "$REPORT" 2>/dev/null || true)
  if [ -z "$iso" ]; then
    # Untracked or never committed — fall back to file mtime (GNU/Linux CI).
    then_epoch=$(stat -c %Y "$REPORT" 2>/dev/null || echo 0)
  else
    then_epoch=$(date -d "$iso" +%s)
  fi
  age=$((NOW_EPOCH - then_epoch))
  if [ "$age" -ge "$STALE_SECS" ]; then
    need_refresh=true
    reason="age-$((age / 86400))d"
  fi
fi

if [ "$need_refresh" != true ]; then
  echo "backtest-report.json is fresh (<${STALE_DAYS}d) — skip"
  exit 0
fi

echo "Refreshing historical backtest ($reason) via node backtest.js --quick ..."
node backtest.js --quick
echo "Wrote $REPORT"
