@echo off
REM Double-click me. Runs the whole deterministic half of Scout with no AI:
REM scan every source, then fetch the new posting bodies before they vanish.
REM Nothing in here calls a model, so it costs no Claude usage at all.
REM
REM The pull is NOT optional. CI pushes new ledger rows every morning; a scan
REM that has not caught up does not recognise those postings, appends them a
REM second time, and jobs.tsv is append-only with no second copy anywhere.
cd /d "%~dp0"

git pull --ff-only
if errorlevel 1 (
  echo.
  echo Pull failed - NOT scanning. Appending to a ledger that is behind is how
  echo you get a real conflict in the one file that cannot be rebuilt.
  echo Open Claude Code and sort it out rather than forcing anything.
  echo.
  pause
  exit /b 1
)

node srcintake.mjs
echo.
pause
