@echo off
REM Double-click me. Pulls whatever the daily robot found overnight, then builds
REM your shortlist from it and opens the page.
REM
REM Safe to click any time: this only READS the ledger and writes gitignored
REM output, so it can never conflict with the robot or the other machine. The
REM worst case is a slightly stale list.
REM
REM No Claude, no model call, no cost.
cd /d "%~dp0"

git pull --ff-only
if errorlevel 1 (
  echo.
  echo Pull failed - refusing to build against a copy that is behind or diverged.
  echo Usually this means uncommitted changes here, or both machines have pushed.
  echo Open Claude Code and sort it out rather than forcing anything.
  echo.
  pause
  exit /b 1
)

node src\shortlist.mjs
if errorlevel 1 ( echo. & pause & exit /b 1 )

start "" "out\shortlist\shortlist.html"
echo.
pause
