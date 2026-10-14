#!/usr/bin/env bash
# Keep Alive backstop. The only cron GitHub reliably runs on this repo is the
# ~00:00 UTC heartbeat (05:30 IST). By then an overnight catch-up has already
# written "today", so the stale check does not dispatch — and if the session
# chain died, nothing else starts it. Arm a chain when none is in flight.
set -euo pipefail

DOW=$(TZ=Asia/Kolkata date +%u)
HOUR=$(TZ=Asia/Kolkata date +%H)

if [ "$DOW" -gt 5 ] || [ "$HOUR" -ge 8 ]; then
  echo "Session arm not needed (dow=$DOW hour=$HOUR IST)"
  exit 0
fi

active=$(gh run list --workflow "Market Refresh (10 min)" --repo "${GITHUB_REPOSITORY:?}" --limit 20 \
  --json status --jq '[.[] | select(.status=="queued" or .status=="in_progress" or .status=="waiting" or .status=="requested" or .status=="pending")] | length')
if [ "${active:-0}" != "0" ]; then
  echo "Market Refresh already active ($active) — not arming another"
  exit 0
fi

echo "::warning title=Session chain was not running::No Market Refresh in flight before 08:00 IST. Arming one so the open is covered even if morning crons are dropped."
echo "Arming session chain (dow=$DOW hour=$HOUR IST)"
gh workflow run "Market Refresh (10 min)" \
  --repo "${GITHUB_REPOSITORY:?}" \
  -f chain=true
