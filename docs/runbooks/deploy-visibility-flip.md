# Runbook: repo visibility flip for PR CI

**Single source of truth** for the public→private flip. `CLAUDE.md`, `.claude/skills/rebuild/SKILL.md`,
and `.github/workflows/ci.yml`'s header all point here instead of restating the routine.

## Why the window exists today

RouteFlow is **private by default** (commercial source). GitHub Actions minutes are unlimited and
free on **public** repos, and metered on **private** ones. As of this writing, **private-minute
billing on this account is broken**: a private run dies as a **0-step failure in ~3 seconds**
(`gh run view` shows a job with zero step conclusions) rather than actually executing. Until that
billing is fixed in GitHub Settings → Billing, PR CI needs the repo to be public for the ~1-2
minutes it takes to run. This is the ONLY reason the flip exists — the push-trigger flip ritual
that used to run on every merge was retired 2026-08-30 (`ci.yml` no longer has a `push:` trigger);
this routine covers PR CI only.

> **Observed 2026-09-16 — private PR CI now executes.** `pull_request` `Verify` runs completed
> green in 10–12 minutes while the repo was **private** (#778 run 35082061621, #781 run
> 35089782573, #789 run 35118809863), so the 0-step billing failure above no longer reproduces.
> Private runs still consume metered minutes. In practice this shortened windows to 3–8 minutes:
> push and let CI go green while private, then open the window only for merge + deploy (step 3's
> `SUCCESS` and served-commit check still apply — the deploy snapshot is why the window remains).

## Actions minutes

Runs that happen **inside** a public window (this routine's step 1–4) are free — public-repo
Actions minutes are unlimited. Private-minute exposure comes only from runs triggered **while
the repo is private**: Dependabot PRs (opened on Dependabot's own schedule, independent of any
window) and manual `workflow_dispatch` runs. `ci.yml`'s `verify` job now skips `pull_request`
events actored by `dependabot[bot]` for exactly this reason (measured 16 Dependabot runs/14
days, ~19 min each, all billed private) — a Dependabot PR gets its real `verify` via a manual
`workflow_dispatch` on its branch inside a brief public window right before merge, using this
same routine, instead of running twice for free.

## Watchdog (mandatory)

**Launch `scripts/visibility-watchdog.mjs` detached, BEFORE step 1 below, every time.** It sleeps
45 minutes, then flips the repo private and verifies the flip, independent of whatever session
started it — the safety net for the 2026-09-04 incident where a session was killed by a process
restart mid-public-window and the repo stayed public for ~6.5 hours because the private flip lived
only in that session's own control flow (nothing else was ever going to run it).

```bash
# Windows PowerShell. -PassThru keeps the pid, which the verification below checks.
$wd = Start-Process -PassThru -WindowStyle Hidden -FilePath node -ArgumentList "scripts/visibility-watchdog.mjs","--minutes","45","--window-marker"
$wd.Id

# POSIX
nohup node scripts/visibility-watchdog.mjs --minutes 45 --window-marker >/dev/null 2>&1 &
```

Verify it started before proceeding to step 1: the log (`local-assets/visibility-watchdog.log`,
gitignored) must show a `start` line **carrying the pid you just launched** (`pid=<$wd.Id>` on
PowerShell, `$!` on POSIX). A `start` line with another pid is somebody else's watchdog, and a
`refused` line means your launch did not arm anything: the launches above discard stderr, so the log
is the only place a refusal shows. Do not proceed to step 1 without your own pid's `start` line. A flip-to-private by the watchdog while CI, a merge, or a
deploy is still running is the CORRECT outcome, not a failure — a GitHub Actions run on a private
repo just fails on billing (see below); rerun it once the window reopens. The watchdog's later
flip is harmless if the routine's own step 4 already flipped private first.

**Mac timer (off-machine backstop).** `--window-marker` makes the watchdog publish a window marker
(`ops/visibility-window.json` in `najathakram/routeflow-specs`: repo, openedAt, deadline, opener) as
a best-effort step after its `start` line; a failed write logs `marker-failed` and never delays the
flip. A launchd job on the Mac (`scripts/visibility-timer.mjs`, every 5 min, template and install
steps in `tools/visibility-timer/`) reads it and flips the repo private if it is still PUBLIC 2 min
past the deadline, so a dead launch machine no longer leaves the window open. A marker more than 6 h
past its deadline, a missing or malformed one, or one for another repo is ignored. The timer writes
exactly one line per decision to `~/.routeflow/ops/visibility-timer.log`; check it after a window.

One watchdog at a time (#2076). A second start finds the lock (`local-assets/visibility-watchdog.lock`). If the old watchdog's repo reads PRIVATE and the new deadline is later, the old one has no window left to guard: the new start stops it, logs a `takeover` line and arms. An old watchdog blocked in a slow `gh` call can take about 3 minutes to stop, and is killed after that, so wait for your own pid's `start` line; the new deadline stands. Otherwise (PUBLIC, unknown, or an earlier deadline) it
prints the running pid and its deadline, logs a `refused` line and exits 3; pass `--replace` to stop
the old one and take over (the older watchdog's earlier deadline would otherwise flip the repo private
inside the new window). A lock is treated as STALE and taken over (nothing is killed) when its pid is
dead, when the pid now belongs to another process (a watchdog killed by `Stop-Process` or a reboot
leaves its lock behind), or when its deadline plus the ~16 min retry budget has passed. `--replace`
only kills a pid whose command line is confirmed to name the watchdog (`ps` on POSIX,
`Get-CimInstance Win32_Process` on Windows). An unknown flag exits 2 and `--help` exits 0, both before any side effect:
never probe the script with a bare invocation, since a bare run arms a real 45-minute watchdog.

**Failure marker — `local-assets/visibility-watchdog.FAILED` in the MAIN checkout.** The watchdog
resolves `local-assets/` against the main checkout (via `git rev-parse --git-common-dir`), never
the worktree it was armed from, and reports the resolved directory as `root=` on its `start`
line — so there is exactly one path to check no matter where it was launched.
**Before opening any window and after each one, check that
`local-assets/visibility-watchdog.FAILED` does not exist in the main checkout; if it does, flip
private by hand, read visibility back, then delete the marker.** The watchdog writes it only
after every attempt failed, and clears it itself on the next confirmed flip.

## Dead-man switch (second machine)

The watchdog above lives on the machine that opens the window, so it dies with it: on 2026-10-25 a
PC reboot killed it and the repo stayed public ~8 hours. `scripts/visibility-deadman.mjs` is the
backstop that runs on a **different** machine (the Mac mini, under launchd) and knows nothing about
windows. Every ~2 minutes it polls `gh repo view <repo> --json visibility,viewerPermission`; once the repo has been
continuously PUBLIC for more than `--max-public-minutes` (default 60: the watchdog's 45 minutes plus
a deploy) it flips the repo private (`gh repo edit ... --visibility private
--accept-visibility-change-consequences`), reads back until PRIVATE is confirmed, and logs an
`incident` JSON line. Like the watchdog, a flip while a window is still legitimately open is the
correct outcome; rerun the job once the window reopens. An unreadable poll (network/auth) is logged,
keeps the state and exits 4: it never guesses the visibility.

State and log are in `local-assets/` (`visibility-deadman.state.json`, `visibility-deadman.log`, one
JSON line per event, a `heartbeat` for every poll). Exit codes: 0 ok, 1 flip not confirmed (flip by
hand), 2 usage error, 3 `--status` unhealthy, 4 `gh` could not answer, 5 the `gh` account is **not an
admin** of the repo. If `gh repo view` fails while the stored timer is past the deadline (or lost after the repo was
last seen public), the switch still runs the flip and exits 1 when it cannot read it back. After 3
failed polls in a row (`DEGRADED_AFTER_FAILURES`) every poll logs `DEADMAN DEGRADED` and `--status`
exits 3: fix `gh` or the token before the next public window.

Two guards against a switch that looks alive but is dead:

- **Admin check.** Every poll reads `viewerPermission`. Anything but `ADMIN` (the wrong GitHub
  account) logs an `incident` with `"reason":"not-admin"` and exits 5 on every poll, even while the
  repo is PRIVATE; a flip that is due is still attempted. `viewerPermission` is the account's
  **role** on the repo, not the scope of its token, so it cannot prove a token is able to flip: that
  is what the install test flip below is for.
- **No free window after a gap.** If the first PUBLIC sighting follows missed polls (`gh` errors, a
  sleeping Mac; the previous answered poll is older than 2x the interval), the timer is backdated to
  that previous poll instead of starting at "now". A corrupt state file (unreadable, truncated, or a
  timer that is unparseable or in the future) is logged and never grants a fresh window: the timer
  restarts at the last readable `lastCheckAt` only if the repo was last seen PRIVATE; otherwise the
  window is treated as spent and a PUBLIC repo is flipped at once.
- **Bookkeeping can't block a flip.** The flip happens before the state and log are written, and a
  failing write (full disk, root-owned `local-assets/`, a state path that is not a file) only prints a
  `WARNING` on stderr. A first PUBLIC sighting whose timer cannot be stored is flipped at once, since
  a timer that cannot be stored would never fire.

**Install on the Mac mini: LaunchDaemon (recommended)**

A LaunchAgent dies with logout and does not start after a reboot unless the Mac auto-logs-in, which
is exactly the failure this switch exists to cover. A LaunchDaemon starts at boot with nobody logged
in.

1. Create a **classic PAT with `repo` scope** for the **repo owner** (an admin of
   `najathakram/routeflow`). Store it in a root-only file; the wrapper refuses any other mode, and
   the token never goes in the plist:

   ```bash
   sudo mkdir -p /etc/routeflow
   sudo sh -c 'umask 077; cat > /etc/routeflow/visibility-deadman.token'   # paste token, Ctrl-D
   sudo chown root:wheel /etc/routeflow/visibility-deadman.token
   sudo chmod 600 /etc/routeflow/visibility-deadman.token
   ```

2. Check out the repo and `mkdir -p <repo>/local-assets` (gitignored; launchd will not create it).
3. Copy the template and fill the four placeholders (`__NODE_BIN__` = `command -v node`,
   `__REPO_DIR__` = the checkout, `__GH_DIR__` = `dirname "$(command -v gh)"`, `__TOKEN_FILE__` = the
   file above; launchd's PATH is minimal, so without `__GH_DIR__` it cannot find `gh`):

   ```bash
   sudo cp scripts/launchd/com.routeflow.visibility-deadman.daemon.plist \
     /Library/LaunchDaemons/com.routeflow.visibility-deadman.plist
   sudo $EDITOR /Library/LaunchDaemons/com.routeflow.visibility-deadman.plist
   sudo chown root:wheel /Library/LaunchDaemons/com.routeflow.visibility-deadman.plist
   sudo chmod 644 /Library/LaunchDaemons/com.routeflow.visibility-deadman.plist
   plutil -lint /Library/LaunchDaemons/com.routeflow.visibility-deadman.plist
   sudo launchctl load -w /Library/LaunchDaemons/com.routeflow.visibility-deadman.plist
   ```

4. **One-time install test flip on a scratch repo** (never on `routeflow`). The admin check cannot
   prove the token can flip, so prove it once with the token the daemon will use. Create a throwaway
   PUBLIC repo under the owner's account (`gh repo create <owner>/deadman-scratch --public`), then run
   the switch twice against it with a near-zero limit and a scratch state dir; the second poll must
   flip it and print `"action":"flipped-private","confirmed":true`. Delete the scratch repo afterwards.

   ```bash
   sudo sh -c 'export GH_TOKEN="$(cat /etc/routeflow/visibility-deadman.token)"; \
     for i in 1 2; do node scripts/visibility-deadman.mjs --once --repo <owner>/deadman-scratch \
       --max-public-minutes 0.01 --state-dir /tmp/deadman-test; sleep 2; done'
   ```

5. Check it is alive: `node scripts/visibility-deadman.mjs --status` prints the state and the age
   of the last heartbeat (no `gh` call, writes nothing). It prints `WARNING` lines and **exits 3**
   when the last answered poll is older than 600 s, the last flip was not confirmed, the last poll
   failed (including not-admin), or there is no state yet. Check it after every install and every
   token rotation. Read `local-assets/visibility-deadman.launchd.err.log` if it is unhealthy. Stop it
   with `sudo launchctl unload /Library/LaunchDaemons/com.routeflow.visibility-deadman.plist`.

**Fallback: LaunchAgent.** `scripts/launchd/com.routeflow.visibility-deadman.plist` goes in
`~/Library/LaunchAgents/` and loads with `launchctl load`. It uses the `gh` login of that macOS user
(`gh auth login` as the repo owner, admin rights). It only runs while that user is logged in, so the
Mac **must have automatic login enabled** (System Settings > Users & Groups); without it the switch
is off after any reboot.

Never probe it with a bare `--once` while the repo is public mid-window: it is a real poll. `node
scripts/visibility-deadman.self-test.mjs` exercises every branch against a stub `gh` and never
touches the real repo or `local-assets/`. `VISIBILITY_DEADMAN_GH_BIN` replaces the `gh` path and is
**test-only**: it prints a WARNING and must never appear in the plist.

## The routine

1. **Make the repo public:**
   `gh repo edit najathakram/routeflow --visibility public --accept-visibility-change-consequences`
2. **Push, let CI go green, merge the PR to `master`** (squash). The `master` push triggers
   Railway's own auto-deploy — nothing in this routine drives that.
3. **Wait until BOTH deployments (`@routeflow/api` and `@routeflow/web`) reach `SUCCESS`** — never
   flip on `BUILDING` (see Failure modes: that is not a safe flip point, only timing luck made it
   look like one). `SUCCESS` typically lands ≈2.5 minutes after the merge:

   ```bash
   until railway deployment list --service @routeflow/api | sed -n '2p' | grep -qE 'SUCCESS|FAILED'; do sleep 10; done
   until railway deployment list --service @routeflow/web | sed -n '2p' | grep -qE 'SUCCESS|FAILED'; do sleep 10; done
   ```

   Do not include `BUILDING`/`DEPLOYING` in that pattern — a mid-build state is precisely the case
   where you must not conclude the snapshot succeeded. A `FAILED` result means the deploy did not
   go out; see the recovery steps below before flipping.

   **Then prove each service is serving the merge commit** — before flipping, check what both
   services actually serve:

   ```bash
   curl -s https://routeflowapi-production.up.railway.app/api/v1/health   # .commit
   curl -s -H 'cache-control: no-cache' https://www.routeflow.info/api/health   # .sha
   ```

   A service that the merge did not touch (outside its `watchPatterns`) keeps serving its previous
   commit — that is expected, not a failure. **Never use the GitHub deployments API's
   `statuses[0].state` as proof:** both services post to the one `routeflow / production`
   environment, so an untouched service re-asserting its own deployment flips a fresh, successful
   deploy's record to `inactive` within seconds, and a two-service deploy can show a single
   `success` (#801 and #802, 2026-09-17). Read the whole status history at most — the served commits
   are the proof.

4. **Make the repo private again — as a `finally`.** Run this even if CI failed, the merge failed,
   or the deploy failed:
   `gh repo edit najathakram/routeflow --visibility private --accept-visibility-change-consequences`
5. **Read the visibility back in a retry loop and confirm `PRIVATE`** before moving on — a network
   error from `gh repo edit` can leave the repo public while printing nothing useful.

> **Owner authorization (2026-07-31):** the assistant IS authorized to perform the visibility
> flips as part of this routine — a brief public window for CI is an accepted trade-off.

## Failure modes (root cause, not just symptom)

- **Five consecutive `"Snapshot code → repository not found"` deploy failures** (#367, #369,
  #371, and two before them): flipping private in the same breath as the merge lands inside
  Railway's ~2s post-merge snapshot window and invalidates the GitHub App's installation token
  mid-clone — a race, not a permissions problem (the App has "All repositories" access; #318
  deployed fine fully private). Fix: wait for `BUILDING` (step 3), never flip at `INITIALIZING`
  (verified the hard way on #376 — both services FAILED at that stage).
- **`gh repo edit` fails over the network** and leaves the repo public with no clear error (#374).
  Fix: step 5's read-back-and-retry, always.
- **`BUILDING` is not a safe flip point** — both 1b413d07 deployments (#652, 2026-09-07) FAILED at
  the code snapshot with no build log when the flip came 7 seconds after reaching `BUILDING`;
  #650's 3-second flip at `BUILDING` had succeeded, but that was timing luck, not a rule.
  `railway redeploy` refuses to redeploy a `FAILED` deployment, and `railway up` is unsafe here (no
  `.railwayignore`, and this repo's worktrees live under the root checkout, so a raw upload risks
  shipping worktree content). Recovery: from a spare worktree, push an empty
  `chore(deploy): retrigger …` commit as `master` while the repo is still public, wait for
  `SUCCESS` (never `BUILDING`), then flip private. Fix: flip only after step 3's `SUCCESS`.
- **Migration replay does not fire on `ready_for_review`.** Its `pull_request` trigger only fires
  on opened/synchronize, so flipping a draft to ready (or the CI rerun button on a private-time
  skipped run) leaves it SKIPPED. Dispatch it: `gh workflow run "Migration replay" --ref <branch>`
  — never close/reopen the PR, which restarts CI under cancel-in-progress.
- **`railway deployment list` prints stale rows first.** After a merge, wait for NEW deployment
  ids for BOTH services to reach a terminal state (SUCCESS) before flipping private; an old
  SKIPPED/SUCCESS row at the top is not your deploy (Window 14, 2026-09-10).

- **The container boots, then crashes — prod 502 with every gate green** (#702 → #703, Window 16,
  2026-09-12: `CrmModule` shipped without `BillingModule`, so `AddonGuard` could not resolve
  `AddonService`; Nest threw `UnknownDependenciesException` at InstanceLoader on every boot and
  the API answered 502 for 26 minutes while web stayed up). Boundary-mocked specs, lint and `tsc`
  cannot see DI scope, and the deploy showed a green healthcheck before the crash. Railway's CLI has
  NO rollback to an earlier deployment (`redeploy` only re-runs the latest); the dashboard does
  (service → deployment → Rollback) — hand the owner that path immediately, then FIX FORWARD:
  keep the repo public, hotfix branch off master, verify → CI → merge → `SUCCESS` → health 200 →
  private. Guards now: `apps/api/src/common/app-module-compile.spec.ts` (compiles the real
  `AppModule` graph) + `addon-guard-module-import.spec.ts`; any diff touching `*.module.ts`
  also runs the compose boot gate (`npm run local:up` → `local:validate`) before its push.

## Retirement checklist

Retire this routine only when, in order:

1. Private-minute Actions billing is fixed in GitHub Settings → Billing.
2. **One full private PR run completes with `steps > 0`** on every job (`gh run view <id> --json
jobs` — a 0-step green is still the billing block, not proof it's fixed).
3. The first private month's minutes are checked against the 2,000/mo Free cap — central
   projection is **~2,076 min/mo** (unverified until a real month runs private; see `ci.yml`'s
   header for the measured per-job breakdown this projection is derived from).
4. Delete the routine from all three referrers: `CLAUDE.md` (§ Canonical deploy flow), the
   `rebuild` skill (`.claude/skills/rebuild/SKILL.md`), and this file's own existence — plus trim
   `ci.yml`'s header sentence that currently points here.

Until step 1 happens, none of the later steps are actionable — this checklist is not a queue to
work through now, it's the trigger condition to watch for.
