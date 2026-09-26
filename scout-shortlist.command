#!/bin/sh
# Double-click me (macOS). Pulls whatever the daily robot found overnight, then
# builds your shortlist from it and opens the page.
#
# Safe to click any time: this only READS the ledger and writes gitignored
# output, so it can never conflict with the robot or the other machine. The
# worst case is a slightly stale list.
#
# No Claude, no model call, no cost.
cd "$(dirname "$0")" || exit 1

if ! git pull --ff-only; then
  echo
  echo "Pull failed - refusing to build against a copy that is behind or diverged."
  echo "Usually this means uncommitted changes here, or both machines have pushed."
  echo "Open Claude Code and sort it out rather than forcing anything."
  exit 1
fi

node src/shortlist.mjs || exit 1
open out/shortlist/shortlist.html
