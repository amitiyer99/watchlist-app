#!/usr/bin/env bash
# A chained refresh that starts before the session must not sleep until 08:05
# in one job. That sleep is ~6 hours; the job timeout killed it at 3.5 hours
# (2026-10-14 00:19 UTC) and the successor was never queued.
# Sleep at most one hop. The caller queues the next hop before this sleep.
set -euo pipefail

MAX_SLEEP=2400 # 40 min — well under the job timeout
READY=true

DOW=$(TZ=Asia/Kolkata date +%u)
if [ "$DOW" -gt 5 ]; then
  echo "Weekend — not waiting"
else
  TARGET=$(TZ=Asia/Kolkata date -d "$(TZ=Asia/Kolkata date +%Y-%m-%d) 08:05:00" +%s)
  NOW=$(date +%s)
  if [ "$NOW" -ge "$TARGET" ]; then
    echo "Session window already open — no wait"
  else
    WAIT=$((TARGET - NOW))
    if [ "$WAIT" -gt "$MAX_SLEEP" ]; then
      WAIT=$MAX_SLEEP
      READY=false
    fi
    echo "Chained before 08:05 IST — sleeping ${WAIT}s (ready=$READY)"
    sleep "$WAIT"
    if [ "$READY" = true ]; then
      echo "Session window open — continuing"
    else
      echo "Hop done — next chained run continues the wait"
    fi
  fi
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "ready=$READY" >> "$GITHUB_OUTPUT"
fi
