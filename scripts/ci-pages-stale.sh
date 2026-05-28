#!/usr/bin/env bash
# True when docs were not updated today (IST) — used by keepalive / refresh gate.
set -euo pipefail

TODAY=$(TZ=Asia/Kolkata date +%Y-%m-%d)

last_ist() {
  local f="$1"
  local iso
  iso=$(git log -1 --format="%cI" -- "$f" 2>/dev/null || echo "")
  if [ -z "$iso" ]; then
    echo ""
    return
  fi
  TZ=Asia/Kolkata date -d "$iso" +%Y-%m-%d
}

INDEX_IST=$(last_ist docs/index.html)
PRICES_IST=$(last_ist docs/live-prices.json)

echo "IST today=$TODAY | index.html=$INDEX_IST | live-prices.json=$PRICES_IST"

STALE=false
if [ "$INDEX_IST" != "$TODAY" ] || [ "$PRICES_IST" != "$TODAY" ]; then
  STALE=true
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "stale=$STALE" >> "$GITHUB_OUTPUT"
fi

if [ "$STALE" = true ]; then
  echo "Pages/prices are stale for today (IST) — refresh recommended"
  exit 0
fi

echo "Pages/prices already updated today (IST)"
exit 0
