#!/bin/sh
# Double-click me (macOS). Runs the whole deterministic half of Scout with no AI:
# scan every source, then fetch the new posting bodies before they vanish.
# Nothing in here calls a model, so it costs no Claude usage at all.
#
# The pull is NOT optional. CI pushes new ledger rows every morning; a scan that
# has not caught up does not recognise those postings, appends them a second
# time, and jobs.tsv is append-only with no second copy anywhere.
cd "$(dirname "$0")" || exit 1

if ! git pull --ff-only; then
  echo
  echo "Pull failed - NOT scanning. Appending to a ledger that is behind is how"
  echo "you get a real conflict in the one file that cannot be rebuilt."
  echo "Open Claude Code and sort it out rather than forcing anything."
  exit 1
fi

node src/intake.mjs
