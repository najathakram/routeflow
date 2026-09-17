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
# Windows PowerShell
Start-Process -WindowStyle Hidden -FilePath node -ArgumentList "scripts/visibility-watchdog.mjs","--minutes","45"

# POSIX
nohup node scripts/visibility-watchdog.mjs --minutes 45 >/dev/null 2>&1 &
```

Verify it started (log at `local-assets/visibility-watchdog.log`, gitignored — see its `start`
line) before proceeding to step 1. A flip-to-private by the watchdog while CI, a merge, or a
deploy is still running is the CORRECT outcome, not a failure — a GitHub Actions run on a private
repo just fails on billing (see below); rerun it once the window reopens. The watchdog's later
flip is harmless if the routine's own step 4 already flipped private first.

**Failure marker — `local-assets/visibility-watchdog.FAILED` in the MAIN checkout.** The watchdog
resolves `local-assets/` against the main checkout (via `git rev-parse --git-common-dir`), never
the worktree it was armed from, and reports the resolved directory as `root=` on its `start`
line — so there is exactly one path to check no matter where it was launched.
**Before opening any window and after each one, check that
`local-assets/visibility-watchdog.FAILED` does not exist in the main checkout; if it does, flip
private by hand, read visibility back, then delete the marker.** The watchdog writes it only
after every attempt failed, and clears it itself on the next confirmed flip.

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
