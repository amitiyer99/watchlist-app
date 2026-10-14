#!/usr/bin/env bash
# Queue the next Market Refresh so the session does not depend on GitHub
# honoring */10 cron. Called at the START of a run, before any long sleep,
# so a timeout still leaves a successor waiting on the concurrency group.
# Weekdays before 16:00 IST only. The successor waits until 08:05 IST when
# it is still pre-session (ci-wait-session.sh, one hop at a time).
set -euo pipefail

DOW=$(TZ=Asia/Kolkata date +%u)
HOUR=$(TZ=Asia/Kolkata date +%H)

if [ "$DOW" -gt 5 ] || [ "$HOUR" -ge 16 ]; then
  echo "Not queueing next refresh (dow=$DOW hour=$HOUR IST)"
  exit 0
fi

queued=$(gh run list --workflow "Market Refresh (10 min)" --repo "${GITHUB_REPOSITORY:?}" --limit 20 \
  --json status --jq '[.[] | select(.status=="queued" or .status=="waiting" or .status=="requested" or .status=="pending")] | length')
if [ "${queued:-0}" != "0" ]; then
  echo "A Market Refresh is already queued ($queued) — not adding another"
  exit 0
fi

echo "Queueing next Market Refresh (dow=$DOW hour=$HOUR IST)"
attempt=1
while [ "$attempt" -le 3 ]; do
  if gh workflow run "Market Refresh (10 min)" --repo "${GITHUB_REPOSITORY:?}" -f chain=true; then
    echo "Queued (attempt $attempt)"
    exit 0
  fi
  echo "Queue attempt $attempt failed"
  attempt=$((attempt + 1))
  sleep 5
done

echo "::error title=Refresh chain broken::Could not queue the next Market Refresh"
exit 1
