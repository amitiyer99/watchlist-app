#!/usr/bin/env bash
# After a concurrency wait, GitHub still checks out github.sha from trigger time.
# Reset to current origin/master so generators read/write the latest data files.
set -euo pipefail

git fetch origin master
git reset --hard origin/master
git log -1 --format='Synced to %h %s (%cI)'
