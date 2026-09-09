#!/usr/bin/env bash
# Serialize-safe push to master — used by all data workflows.
# Do NOT use rebase -Xours (drops concurrent commits from other workflows).
#
# When rebase conflicts (typical: screener-outcomes.json from overlapping
# market-refresh + daily-refresh), replay ONLY the files this job staged onto
# the current origin/master instead of retrying the same conflict.
set -euo pipefail

MSG="${1:?commit message required}"

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

if git diff --staged --quiet; then
  echo "No staged changes — skipping commit"
  exit 0
fi

mapfile -t FILES < <(git diff --cached --name-only)
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "No staged files — skipping commit"
  exit 0
fi

git commit -m "$MSG"
OUR=$(git rev-parse HEAD)

replay_ours_on_master() {
  git fetch origin master
  git reset --hard origin/master
  git checkout "$OUR" -- "${FILES[@]}"
  git add -f -- "${FILES[@]}"
  if git diff --staged --quiet; then
    echo "Replay produced no net change vs origin/master"
    return 1
  fi
  git commit -m "$MSG"
}

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

  echo "Replaying ${#FILES[@]} generated file(s) onto origin/master"
  if replay_ours_on_master; then
    if git push origin master; then
      echo "Push succeeded after replay on attempt ${attempt}"
      exit 0
    fi
  fi

  wait_sec=$((attempt * 8))
  echo "Retrying in ${wait_sec}s..."
  sleep "${wait_sec}"
done

echo "ERROR: all push attempts failed"
exit 1
