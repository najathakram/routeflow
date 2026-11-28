#!/usr/bin/env bash
# W-1514: run a command under a time budget that kills its whole SESSION (CI only).
#
#   bash scripts/ci-budget.sh <budget: 56m | 90s | 90> <grace seconds> <command...>
#
# Why not `timeout -k`: it signals only its own process group, and turbo starts every task in a new
# process group, so a task that outlives turbo is out of its reach and holds the step's stdout open
# until the job cap (#4556's three 55:00 cancels with no log). A process group change keeps the
# session, so `pkill -s <sid>` reaches every turbo task.
#
# - The command runs as the leader of a new session (perl's POSIX::setsid; setsid(1) forks when its
#   caller leads a process group, which would make $! the wrong id). Its pid is the session id.
# - The session kill needs procps pkill with -s, as on the CI runner (Linux). macOS pkill has no -s:
#   there the kill fails loudly and the run exits 125 (see kill_session). This script is CI-only.
# - At the budget: TERM to the session, then KILL to it once the command has exited or the grace
#   has run out, whichever is first. Exit 124, like timeout(1).
# - When the command ends by itself: KILL whatever is left in the session, then exit with the
#   command's own status. A leftover cannot hold a green step open either.
# - On TERM or INT to this script (a GitHub cancel): TERM the session, KILL it 2s later, exit 143/130.
# - Exit 2 on bad arguments. A process that calls setsid itself would escape; nothing in the repo
#   does, and turbo only does for its TUI on a terminal, never in CI.
set -u

usage() {
  echo "ci-budget: $1" >&2
  echo "usage: bash scripts/ci-budget.sh <budget: Nm | Ns | N> <grace seconds> <command...>" >&2
  exit 2
}

[ "$#" -ge 3 ] || usage "needs a budget, a grace and a command"
budget=$1
grace=$2
shift 2
case "$budget" in
  *[!0-9]*m | m) usage "bad budget '$budget'" ;;
  *m) budget_s=$((10#${budget%m} * 60)) ;;
  *[!0-9]*s | s) usage "bad budget '$budget'" ;;
  *s) budget_s=$((10#${budget%s})) ;;
  '' | *[!0-9]*) usage "bad budget '$budget'" ;;
  *) budget_s=$((10#$budget)) ;;
esac
case "$grace" in
  '' | *[!0-9]*) usage "bad grace '$grace'" ;;
esac
[ "$budget_s" -gt 0 ] || usage "budget must be more than 0"

# A timer that sends this script USR1 after $1 seconds. Its stdio is /dev/null, so it never holds the
# step's output open; disarm kills it and its sleep.
timer=""
fired=0
trap 'fired=1' USR1
arm() {
  fired=0
  (
    trap 'kill "$sp" 2>/dev/null; exit 0' TERM
    sleep "$1" &
    sp=$!
    wait "$sp" && kill -USR1 "$$" 2>/dev/null
  ) </dev/null >/dev/null 2>&1 &
  timer=$!
}
disarm() {
  if [ -n "$timer" ]; then
    kill "$timer" 2>/dev/null
    wait "$timer" 2>/dev/null
    timer=""
  fi
}

# pkill exits 0 when it signalled something and 1 when nothing matched; both are fine. 2 or more is
# a usage error or a pkill without -s (macOS's has none): the session was NOT signalled. Say so once,
# still signal the leader itself (only while it is unreaped, so its pid cannot belong to anything
# else) so `wait` cannot hang, and exit 125 at the end instead of a clean 124 or the command's own
# status. A broken kill must never pass as a clean budget stop.
kill_broken=0
leader_unreaped() { jobs -p | grep -qx "$sid"; }
kill_session() {
  pkill -"$1" -s "$sid" 2>/dev/null
  local rc=$?
  if [ "$rc" -ge 2 ]; then
    [ "$kill_broken" = 1 ] || echo "ci-budget: pkill -s failed (exit $rc), so the session was not signalled; this run exits 125" >&2
    kill_broken=1
    if leader_unreaped; then kill -"$1" "$sid" 2>/dev/null; fi
  fi
}
finish() {
  [ "$kill_broken" = 1 ] && exit 125
  exit "$1"
}

# bash starts a background job with INT and QUIT ignored; reset them so the command (and turbo's own
# shutdown, which sends its tasks SIGINT) behaves as it does in the pre-push hook.
perl -MPOSIX -e '$SIG{INT} = $SIG{QUIT} = "DEFAULT"; defined(POSIX::setsid()) or die "ci-budget: setsid failed: $!\n"; exec { $ARGV[0] } @ARGV or die "ci-budget: exec $ARGV[0] failed: $!\n"' "$@" &
sid=$!

on_cancel() {
  disarm
  kill_session TERM
  sleep 2
  kill_session KILL
  finish "$1"
}
trap 'on_cancel 143' TERM
trap 'on_cancel 130' INT

arm "$budget_s"
wait "$sid"
status=$?
# The timer interrupts `wait` only while the command is still running. If it fired just as the command
# ended, `wait` has already reaped it and returned its real status, so `kill -0` fails and this is a
# normal exit.
if [ "$fired" = 1 ] && kill -0 "$sid" 2>/dev/null; then
  echo "ci-budget: the budget of ${budget_s}s ran out; stopping the whole session (TERM, then KILL after ${grace}s)" >&2
  kill_session TERM
  arm "$grace"
  # A short grace can fire before `wait` starts; then go straight to KILL.
  [ "$fired" = 1 ] || wait "$sid" 2>/dev/null
  disarm
  kill_session KILL
  wait "$sid" 2>/dev/null
  finish 124
fi
disarm
kill_session KILL
finish "$status"
