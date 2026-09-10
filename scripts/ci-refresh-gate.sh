#!/usr/bin/env bash
# Decide whether market-refresh should run (writes skip + reason to GITHUB_OUTPUT).
set -euo pipefail

DOW=$(TZ=Asia/Kolkata date +%u)
HOUR=$(TZ=Asia/Kolkata date +%H)
EVENT="${GITHUB_EVENT_NAME:-schedule}"
CATCHUP="${INPUT_CATCHUP:-false}"
CHAIN="${INPUT_CHAIN:-false}"

TODAY=$(TZ=Asia/Kolkata date +%Y-%m-%d)
NOW_EPOCH=$(date +%s)
STALE_AFTER_MIN=20

last_iso() {
  git log -1 --format="%cI" -- "$1" 2>/dev/null || echo ""
}

last_ist() {
  local iso="$1"
  [ -z "$iso" ] && echo "" && return
  TZ=Asia/Kolkata date -d "$iso" +%Y-%m-%d
}

age_min() {
  local iso="$1"
  [ -z "$iso" ] && echo "9999" && return
  local then
  then=$(date -d "$iso" +%s)
  echo $(( (NOW_EPOCH - then) / 60 ))
}

INDEX_ISO=$(last_iso docs/index.html)
PRICES_ISO=$(last_iso docs/live-prices.json)
INDEX_IST=$(last_ist "$INDEX_ISO")
PRICES_IST=$(last_ist "$PRICES_ISO")
PRICES_AGE=$(age_min "$PRICES_ISO")
STALE=false
if [ "$INDEX_IST" != "$TODAY" ] || [ "$PRICES_IST" != "$TODAY" ]; then
  STALE=true
elif [ "$DOW" -le 5 ] && [ "$HOUR" -ge 8 ] && [ "$HOUR" -lt 16 ] && [ "$PRICES_AGE" -ge "$STALE_AFTER_MIN" ]; then
  STALE=true
fi

skip=true
reason=""

# Manual / Keep Alive catch-up always runs. Self-chained runs use the same
# hours/stale rules as cron so a job queued at 15:50 IST cannot start a
# full refresh after the close.
if [ "$EVENT" = "workflow_dispatch" ] && [ "$CHAIN" != "true" ]; then
  skip=false
  reason=$([ "$CATCHUP" = "true" ] && echo "manual-catchup" || echo "manual")
elif [ "$DOW" -gt 5 ]; then
  skip=true
  reason="weekend"
elif [ "$HOUR" -ge 8 ] && [ "$HOUR" -lt 16 ]; then
  skip=false
  reason="market-hours"
elif [ "$STALE" = true ]; then
  skip=false
  reason="stale-catchup"
else
  skip=true
  reason="outside-hours-fresh"
fi

echo "gate: event=$EVENT dow=$DOW hour=$HOUR prices_age=${PRICES_AGE}m stale=$STALE catchup=$CATCHUP chain=$CHAIN → skip=$skip ($reason)"
echo "skip=$skip" >> "${GITHUB_OUTPUT:?}"
echo "reason=$reason" >> "${GITHUB_OUTPUT:?}"
