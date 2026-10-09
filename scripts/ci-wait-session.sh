#!/usr/bin/env bash
# Chained Market Refresh jobs queued overnight must hold until 08:05 IST.
# GitHub often drops every cron after the ~00:00 UTC Keep Alive, so without
# this wait the overnight catch-up cannot start the in-session chain.
set -euo pipefail

DOW=$(TZ=Asia/Kolkata date +%u)
if [ "$DOW" -gt 5 ]; then
  echo "Weekend — not waiting"
  exit 0
fi

TARGET=$(TZ=Asia/Kolkata date -d "$(TZ=Asia/Kolkata date +%Y-%m-%d) 08:05:00" +%s)
NOW=$(date +%s)
if [ "$NOW" -ge "$TARGET" ]; then
  echo "Session window already open — no wait"
  exit 0
fi

WAIT=$((TARGET - NOW))
echo "Chained before 08:05 IST — sleeping ${WAIT}s"
sleep "$WAIT"
echo "Session window open — continuing"
