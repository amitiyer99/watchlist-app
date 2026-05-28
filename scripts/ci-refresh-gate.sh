#!/usr/bin/env bash
# Decide whether market-refresh should run (writes skip + reason to GITHUB_OUTPUT).
set -euo pipefail

DOW=$(TZ=Asia/Kolkata date +%u)
HOUR=$(TZ=Asia/Kolkata date +%H)
EVENT="${GITHUB_EVENT_NAME:-schedule}"
CATCHUP="${INPUT_CATCHUP:-false}"

TODAY=$(TZ=Asia/Kolkata date +%Y-%m-%d)
last_ist() {
  local f="$1" iso
  iso=$(git log -1 --format="%cI" -- "$f" 2>/dev/null || echo "")
  [ -z "$iso" ] && echo "" && return
  TZ=Asia/Kolkata date -d "$iso" +%Y-%m-%d
}
INDEX_IST=$(last_ist docs/index.html)
PRICES_IST=$(last_ist docs/live-prices.json)
STALE=false
if [ "$INDEX_IST" != "$TODAY" ] || [ "$PRICES_IST" != "$TODAY" ]; then
  STALE=true
fi

skip=true
reason=""

if [ "$EVENT" = "workflow_dispatch" ]; then
  skip=false
  reason=$([ "$CATCHUP" = "true" ] && echo "manual-catchup" || echo "manual")
elif [ "$DOW" -gt 5 ]; then
  skip=true
  reason="weekend"
elif [ "$HOUR" -ge 9 ] && [ "$HOUR" -lt 16 ]; then
  skip=false
  reason="market-hours"
elif [ "$STALE" = true ]; then
  skip=false
  reason="stale-catchup"
else
  skip=true
  reason="outside-hours-fresh"
fi

echo "gate: event=$EVENT dow=$DOW hour=$HOUR stale=$STALE catchup=$CATCHUP → skip=$skip ($reason)"
echo "skip=$skip" >> "${GITHUB_OUTPUT:?}"
echo "reason=$reason" >> "${GITHUB_OUTPUT:?}"
