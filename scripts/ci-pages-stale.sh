#!/usr/bin/env bash
# True when docs/prices need a catch-up refresh — used by keepalive / refresh gate.
# Calendar-day freshness is not enough: an overnight catch-up marks files "today"
# IST, then GitHub skips the */10 market cron and the site stays on pre-open data.
set -euo pipefail

TODAY=$(TZ=Asia/Kolkata date +%Y-%m-%d)
DOW=$(TZ=Asia/Kolkata date +%u)
HOUR=$(TZ=Asia/Kolkata date +%H)
NOW_EPOCH=$(date +%s)
# Match the in-page "live" window in lib/stock-actions.js (FRESH_MIN = 20).
STALE_AFTER_MIN=20

last_iso() {
  git log -1 --format="%cI" -- "$1" 2>/dev/null || echo ""
}

last_ist() {
  local iso="$1"
  if [ -z "$iso" ]; then
    echo ""
    return
  fi
  TZ=Asia/Kolkata date -d "$iso" +%Y-%m-%d
}

age_min() {
  local iso="$1"
  if [ -z "$iso" ]; then
    echo "9999"
    return
  fi
  local then
  then=$(date -d "$iso" +%s)
  echo $(( (NOW_EPOCH - then) / 60 ))
}

INDEX_ISO=$(last_iso docs/index.html)
PRICES_ISO=$(last_iso docs/live-prices.json)
INDEX_IST=$(last_ist "$INDEX_ISO")
PRICES_IST=$(last_ist "$PRICES_ISO")
PRICES_AGE=$(age_min "$PRICES_ISO")

echo "IST today=$TODAY hour=$HOUR | index.html=$INDEX_IST | live-prices.json=$PRICES_IST age=${PRICES_AGE}m"

STALE=false
REASON=""

if [ "$INDEX_IST" != "$TODAY" ] || [ "$PRICES_IST" != "$TODAY" ]; then
  STALE=true
  REASON="not-updated-today"
elif [ "$DOW" -le 5 ] && [ "$HOUR" -ge 9 ] && [ "$HOUR" -lt 16 ]; then
  if [ "$PRICES_AGE" -ge "$STALE_AFTER_MIN" ]; then
    STALE=true
    REASON="market-hours-prices-stale-${PRICES_AGE}m"
  fi
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "stale=$STALE" >> "$GITHUB_OUTPUT"
  echo "reason=$REASON" >> "$GITHUB_OUTPUT"
fi

if [ "$STALE" = true ]; then
  echo "Pages/prices are stale ($REASON) — refresh recommended"
  exit 0
fi

echo "Pages/prices are fresh"
exit 0
