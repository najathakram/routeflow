# Release health

How RouteFlow decides whether a deploy introduced a regression, and what to do about it. No
secrets, tokens, or org/project ids live in this file — see the environment variable names below
and read actual values from Railway/GitHub Actions secrets, never from here.

## What it is

Two Sentry-backed signals, wired in three PRs:

1. **Release tagging** (`feat/release-health-tagging`) — every Sentry event, API and web, is
   tagged with `release` = the deployed git sha. `apps/api/src/instrument.ts` reads
   `RAILWAY_GIT_COMMIT_SHA` at runtime; `apps/web/components/SentryInit.tsx` reads
   `NEXT_PUBLIC_RELEASE_SHA`, baked in at `next build` time by `apps/web/Dockerfile`'s
   `NEXT_PUBLIC_RELEASE_SHA` build arg (see `apps/web/.env.example` for how to wire the Railway
   service variable). Without this, Sentry has no reliable way to say "this error started with
   deploy X" — it can only say "this error exists."
2. **Release comparison** (`feat/release-health-report`) — `scripts/release-health.mjs` is a
   read-only script that compares two releases via the Sentry API: issue groups first seen in the
   newer release, total error events per release normalized per hour, and the top 5 offenders by
   event count (with file/line when Sentry has it). It exits non-zero only when the count of new
   issue groups at/above `--min-severity` (default `critical`) exceeds `--threshold` (default 0).
3. **The CI gate** (this PR) — a step in `.github/workflows/ci.yml`'s deploy-triggered `e2e` job
   runs `scripts/release-health.mjs current previous` after a short soak window, once the deploy
   is confirmed fresh and Playwright has finished exercising the app.

## Why the gate lives where it does

The task that added this looked for an existing automatic "post-deploy check" step in the
deploy-triggered workflow to hook into and **found there wasn't one**: `scripts/post-deploy-check.mjs`
is wired only into `nightly.yml` (scheduled) and `post-deploy.yml` (manual `workflow_dispatch`) —
neither runs automatically after a production deploy. The actual deploy-triggered workflow is
`ci.yml`'s `e2e` job (fires on Railway's `deployment_status` event, see that file's header
comment). The release-health step lives there, after the deploy-readiness gate and the Playwright
run — Playwright's ~5-8 minutes of real traffic against the freshly-deployed app doubles as most
of the soak window "for free," and any additional wait is a short, explicit sleep rather than a
separate job (this repo bills Actions minutes; see `ci.yml`'s cost-budget header).

## Fail loud vs. fail open

Matches the two existing precedents in this repo (`scripts/ci-audit-critical.mjs` for the npm
advisory gate, `scripts/ci-freshness-guard.mjs` for the E2E freshness check):

- **Fail LOUD (exit 1, job goes red)** only when the comparison actually ran and found a real
  regression signal — new issue groups at/above `--min-severity` (default `critical`) exceeding
  `--threshold` (default 0).
- **Fail OPEN (exit 0, a `::warning::` on stderr, job stays green)** for anything that means the
  check itself couldn't run cleanly: missing `SENTRY_ORG`/`SENTRY_AUTH_TOKEN`/`SENTRY_PROJECT`,
  the Sentry API being unreachable or erroring, or an unparseable response. **A Sentry outage or a
  not-yet-configured secret must never block a deploy or fail a CI run** — that would make
  monitoring itself a single point of failure for shipping.

Until the owner provisions `SENTRY_ORG`/`SENTRY_AUTH_TOKEN`/`SENTRY_PROJECT` as repository
secrets, the step runs, prints its `::warning::` about the missing config, and exits 0 — it is
safe to merge this PR before that setup happens.

## Required secrets (names only — set actual values in GitHub → Settings → Secrets → Actions)

| Secret              | What it is                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_ORG`        | The Sentry organization slug.                                                                                       |
| `SENTRY_AUTH_TOKEN` | An internal integration token scoped to `project:read` + `org:read` — read-only, never grant write scopes for this. |
| `SENTRY_PROJECT`    | The Sentry project slug to compare (the API project, today — see "Scope" below).                                    |

## What a regression looks like

A failed "Release health check" step in the `e2e` job's log, e.g.:

```
Release health: 3f2a1c9 -> 7be0d41
New issue groups: 3 total, 1 at/above "critical" (threshold 0)
Error events/hour: new=42.00 previous=6.50
Top offenders:
  [critical] TypeError: cannot read properties of undefined — OrdersService.create — apps/api/src/orders/orders.service.ts:128 — 42 events
  [warning] ValidationError: qty must be positive — CreateOrderDto — (no file) — 5 events
REGRESSION: 1 new "critical"+ issue group(s) exceeds threshold 0
::error::release-health regression detected between 3f2a1c9 and 7be0d41
```

Run it manually against the same two shas for a fuller picture:

```bash
SENTRY_ORG=<org> SENTRY_AUTH_TOKEN=<token> SENTRY_PROJECT=<project> \
  npm run release-health -- 3f2a1c9 7be0d41 --json
```

## Who reverts, and how

The release-health gate is a **signal, not an auto-revert** — nothing in this repo rolls back a
deploy automatically. On a red "Release health check" step:

1. Open the linked Sentry issue(s) (top offenders print a `permalink` in `--json` output) and
   confirm it's a real new failure, not an unrelated pre-existing issue that happened to cross the
   `firstRelease` boundary (see "False positives" below).
2. If it's real, follow the existing deploy flow in reverse: revert the merge commit on `master`
   (a normal `git revert`, same PR process as any other change — this repo's canonical deploy flow
   is public → push/CI → merge → private, see `docs/runbooks/deploy-visibility-flip.md`), let it
   redeploy, and confirm the new issue stops accumulating events.
3. File a bug via the existing bug-registry workflow (`bug-registry` skill) referencing the
   regressed release sha and the Sentry issue link — never a live client tenant's data in the
   description (see `CLAUDE.md`'s test-tenant policy).

## Interpreting a new-issue spike (avoiding false alarms)

`firstRelease` in Sentry is "the release Sentry first saw this issue in," not "the release that
caused it" — a few things widen that gap:

- **A long-dormant code path exercised for the first time.** A pre-existing bug that a new feature
  finally triggers looks like a "new" issue at the new release, even though the faulty code
  shipped earlier. Check the issue's stack trace against the diff between the two releases before
  assuming the newest commit caused it.
- **Noisy third-party/browser errors** (extension conflicts, ad-blocker interference, transient
  network errors on the client) can appear "new" simply because Sentry's release grouping is
  sensitive to exact release strings. Sentry's own issue-merge / ignore tooling is the right place
  to suppress a confirmed-noisy signature; `--min-severity`/`--threshold` on this script are the
  right place to tune the CI gate's sensitivity once a pattern like that is confirmed recurring
  (raise `--threshold` only with evidence — see the ten-run learning-clause discipline in
  `CLAUDE.md`, never on a single run's taste).
- **A short soak window** means low-traffic issues may not have accumulated enough events yet to
  be conclusive — the event-rate-per-hour numbers in the report are for exactly this: a new
  release with a much higher events/hour than the previous one, even with zero _new_ issue groups,
  is worth a manual look even though it won't fail the gate on its own.

## Scope note (api vs. web)

The CI step today runs the script against **one** Sentry project (`SENTRY_PROJECT`) — the API
project, since that's where money-math and data-integrity regressions matter most. Comparing the
web project too is a straightforward follow-up: duplicate the CI step with a second
`SENTRY_PROJECT_WEB`-style secret and `--project` value; the script itself already takes
`--project` per invocation and needs no changes.
