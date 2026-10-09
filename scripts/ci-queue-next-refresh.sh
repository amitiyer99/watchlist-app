#!/usr/bin/env bash
# After a real market refresh, queue the next one so the session does not depend
# on GitHub honoring */10 cron. Queue on weekdays until 16:00 IST even before
# 08:00 — the chained job waits until 08:05 IST (ci-wait-session.sh). GitHub
# often drops every morning cron after the overnight Keep Alive.
set -euo pipefail

DOW=$(TZ=Asia/Kolkata date +%u)
HOUR=$(TZ=Asia/Kolkata date +%H)

if [ "$DOW" -gt 5 ] || [ "$HOUR" -ge 16 ]; then
  echo "Not queueing next refresh (dow=$DOW hour=$HOUR IST)"
  exit 0
fi

echo "Queueing next Market Refresh (dow=$DOW hour=$HOUR IST)"
gh workflow run "Market Refresh (10 min)" \
  --repo "${GITHUB_REPOSITORY:?}" \
  -f chain=true
