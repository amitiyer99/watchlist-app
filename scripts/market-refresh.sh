#!/usr/bin/env bash
# Full intraday refresh — all HTML pages + live-prices.json during NSE session.
# Called by .github/workflows/market-refresh.yml every 10 minutes.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-1}"

run() {
  echo ""
  echo ">>> node $*"
  if node "$@"; then
    return 0
  fi
  echo "FAILED: node $* (exit $?)"
  return 1
}

run_optional() {
  run "$@" || echo "WARN: optional step failed: $*"
}

FAILED=0

echo "=== Market refresh $(TZ=Asia/Kolkata date '+%Y-%m-%d %H:%M') IST ==="

# Phase 1 — live prices + regime (fast)
run generate-prices.js || FAILED=1
run generate-regime.js || FAILED=1

# Phase 2 — breakout sidecars (required before triggers / confluence)
run generate-breakout2.js || FAILED=1
run_optional generate-breakout.js

# Phase 3 — screeners in parallel
PIDS=()
for script in \
  generate-dashboard.js \
  generate-debate.js \
  generate-prediction.js \
  generate-potential.js \
  generate-apex.js \
  generate-multibagger.js \
  generate-creamy.js \
  generate-sectors.js \
  generate-indianresearch.js \
  generate-alerts.js \
  generate-rocket.js
do
  echo ">>> parallel: $script"
  node "$script" &
  PIDS+=($!)
done
for pid in "${PIDS[@]}"; do
  wait "$pid" || FAILED=1
done

# Phase 4 — depends on breakout2 sidecars
run generate-triggers.js || FAILED=1
run generate-confluence.js || FAILED=1

# Phase 5 — email / exit alerts (non-fatal)
run_optional monitor.js --once

echo ""
echo "=== Staging git changes ==="
for f in \
  docs/live-prices.json docs/regime.json \
  docs/breakout.html docs/breakout2.html docs/breakout2-data.json docs/nse-tickers.json \
  docs/index.html docs/alerts.html docs/potential.html \
  docs/apex.html docs/multibagger.html docs/creamy.html \
  docs/sectors.html docs/indian-research.html \
  docs/confluence.html docs/debate.html docs/debate-data.json \
  docs/prediction.html docs/prediction-history.json \
  docs/triggers.html docs/triggers.json \
  docs/rocket.html docs/rocket-tickers.json \
  screener-outcomes.json
do
  [ -f "$f" ] && git add -f "$f" || true
done

bash scripts/ci-git-push.sh "data: market refresh $(date -u +'%H:%M') UTC"

if [ "$FAILED" -ne 0 ]; then
  echo "Market refresh completed with generator errors (commit may still have succeeded)"
  exit 1
fi

echo "Market refresh OK"
