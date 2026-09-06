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
3. **Wait until the deploy reaches `BUILDING`** — never flip during `INITIALIZING`, which IS the
   snapshot-clone window:
   ```bash
   until railway deployment list --service @routeflow/api | sed -n '2p' | grep -qE 'BUILDING|DEPLOYING|SUCCESS'; do sleep 10; done
   ```
   Do not include `FAILED` in that pattern — a failure is precisely the case where you must not
   conclude the snapshot succeeded.
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
