#!/usr/bin/env bash
# Serialize-safe push to master — used by all data workflows.
# Do NOT use rebase -Xours (drops concurrent commits from other workflows).
set -euo pipefail

MSG="${1:?commit message required}"

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

if git diff --staged --quiet; then
  echo "No staged changes — skipping commit"
  exit 0
fi

git commit -m "$MSG"

for attempt in 1 2 3 4 5 6; do
  if git pull --rebase --autostash origin master; then
    if git push origin master; then
      echo "Push succeeded on attempt ${attempt}"
      exit 0
    fi
  else
    echo "Rebase conflict on attempt ${attempt} — aborting rebase"
    git rebase --abort 2>/dev/null || true
  fi
  wait_sec=$((attempt * 8))
  echo "Retrying in ${wait_sec}s..."
  sleep "${wait_sec}"
done

echo "ERROR: all push attempts failed"
exit 1
