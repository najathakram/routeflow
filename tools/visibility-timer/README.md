# Visibility timer (Mac launchd safety net)

`scripts/visibility-watchdog.mjs` flips the repo private at a deadline, but it runs on the machine
that opened the public window, and that machine has died mid-window twice. This is the off-machine
backstop: the watchdog (launched with `--window-marker`) writes a marker to
`najathakram/routeflow-specs` at `ops/visibility-window.json`; `scripts/visibility-timer.mjs` runs on
the Mac every 5 minutes, reads it, and flips `najathakram/routeflow` private if the repo is still
PUBLIC 2 minutes past the deadline. A marker that is missing, malformed, for another repo, or more
than 6 hours past its deadline causes no action. Details: the header of `scripts/visibility-timer.mjs`
and the runbook `docs/runbooks/deploy-visibility-flip.md`.

## Arming

Arming is NOT part of the PR that adds this. Installing the job is the owner-authorized flip
routine's step, done once on the Mac after the PR lands. Nothing here installs itself.

## Install (later, on the Mac)

```bash
mkdir -p ~/.routeflow/ops ~/Library/LaunchAgents
sed -e "s|__NODE__|$(command -v node)|" -e "s|__REPO__|$HOME/code/routeflow|" -e "s|__HOME__|$HOME|" \
  tools/visibility-timer/com.routeflow.visibility-timer.plist \
  > ~/Library/LaunchAgents/com.routeflow.visibility-timer.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.routeflow.visibility-timer.plist
launchctl print gui/$(id -u)/com.routeflow.visibility-timer | head -20
```

Uninstall: `launchctl bootout gui/$(id -u)/com.routeflow.visibility-timer`, then delete the plist.
The job needs `gh` logged in with `repo` scope (the plist PATH includes `/opt/homebrew/bin`).

## Reading the log

`~/.routeflow/ops/visibility-timer.log`: one line per decision, `<ISO> <event> <detail>`. Events:
`none` / `wait` (no action, with the reason), `already-private`, `flipped`, `attempt` / `error`
(a failed flip), `marker-unreadable`, `visibility-unreadable`. `tail -n 20` it after a window.

launchd's own stdout/stderr land in `visibility-timer.stdout.log` / `.stderr.log` beside it.

In the first window after arming, check `~/.routeflow/ops/visibility-timer.log` for a `wait` line:
it is the proof the timer can read the marker. `marker-unreadable` means the Mac's `gh` token cannot
read `najathakram/routeflow-specs` (GitHub answers 404 for a private repo the token cannot see, so
the timer probes the repo itself before it trusts a 404 as "no marker"); fix `gh auth` on the Mac.
