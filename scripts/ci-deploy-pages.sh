#!/usr/bin/env bash
# Publish docs/ to the gh-pages branch. Market Refresh is usually started by
# Keep Alive via GITHUB_TOKEN; GitHub then suppresses workflow_run → Deploy for
# that chain, so the site stays on last night's live-prices even while master
# keeps updating. Explicit workflow_dispatch of Deploy is allowed and fixes it.
set -euo pipefail

echo "Dispatching Deploy to GitHub Pages"
gh workflow run "Deploy to GitHub Pages" \
  --repo "${GITHUB_REPOSITORY:?}" \
  --ref master
