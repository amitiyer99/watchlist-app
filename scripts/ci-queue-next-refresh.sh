#!/usr/bin/env bash
# After a real market refresh, queue the next one so the session does not depend
# on GitHub honoring */10 cron. No-ops outside Mon–Fri 09:00–16:00 IST.
set -euo pipefail

DOW=$(TZ=Asia/Kolkata date +%u)
HOUR=$(TZ=Asia/Kolkata date +%H)

if [ "$DOW" -gt 5 ] || [ "$HOUR" -lt 9 ] || [ "$HOUR" -ge 16 ]; then
  echo "Not queueing next refresh (dow=$DOW hour=$HOUR IST)"
  exit 0
fi

echo "Queueing next Market Refresh (dow=$DOW hour=$HOUR IST)"
gh workflow run "Market Refresh (10 min)" \
  --repo "${GITHUB_REPOSITORY:?}" \
  -f chain=true
