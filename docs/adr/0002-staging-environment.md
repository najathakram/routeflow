# 2. Staging environment

- **Status:** Deferred — design of record
- **Date:** 2026-09-03
- **Deciders:** RouteFlow maintainers
- **Related:** [`docs/IMPROVEMENTS.md`](../IMPROVEMENTS.md) (#4 — Add a staging environment),
  [`docs/adr/0001-local-hosting-environment.md`](0001-local-hosting-environment.md) (the local
  full-stack lane this ADR's Consequences compares against), [`CLAUDE.md`](../../CLAUDE.md)
  (§ Deployment & DB safety)

## Context and problem statement

RouteFlow has **no staging environment**: no `railway.toml` in the repo defines one, and the
Playwright E2E suite runs against **production**, triggered off Railway's `deployment_status`
signal for the prod services (`.github/workflows/ci.yml`). Production is the canary.

Two dormant workflows already encode a staging design that was never finished:
`.github/workflows/deploy-staging.yml` (push-triggered on a `develop` branch that does not exist
in this repo — `branches: [__disabled_develop__]` — building images and pushing to GHCR, then
`railway up` + an **automatic** `prisma migrate deploy`) and
[`deploy-production.yml`](../../.github/workflows/deploy-production.yml) (`workflow_dispatch`
only, kept deliberately as "a reference implementation for a future self-hosted/registry-based
pipeline"). The staging workflow's auto-migrate step directly contradicts this repo's
never-auto-migrate policy (`CLAUDE.md` § Deployment & DB safety), so it could not simply be
re-enabled as written.

`docs/railway-deployment.md:239-258` (pre-existing, GHCR-era) already documents a staging
token/GitHub-environment setup for that same pipeline. `apps/web/lib/tenant-host.ts`'s
`HOSTING_PROVIDER_DOMAINS` set already treats `railway.app`/`up.railway.app` as hosting-provider
domains rather than tenant hosts, so a staging service on Railway's own `*.up.railway.app` domain
needs no tenant-routing change; a custom `acme.staging.…` subdomain scheme would. Web bakes
`NEXT_PUBLIC_API_URL` in at Docker **build** time
(`apps/web/Dockerfile:50-52`, `ARG NEXT_PUBLIC_API_URL` → `ENV`, consumed by `next build`), so a
staging web image cannot share a build with the prod image — it needs its own build with its own
ARG value pointing at the staging API.

[ADR 0001](0001-local-hosting-environment.md) already named cloud staging as **option 2**,
deferred on cost, with the local Docker-Compose `app` profile as "the cheap first step, not a
replacement." This ADR records the design that first step is standing in for, so that if the
cost/priority calculus changes later, the shape does not have to be rediscovered.

Item 7 of `docs/IMPROVEMENTS.md` named two supporting gaps this ADR also closes: the
`RUN_STARTUP_DDL` flag question (moot — boot-time DDL was deleted outright in PR-1/`imp-03a`, so
there is no flag to gate a staging boot with) and the PR-template checklist line (added in this
same PR — see `.github/PULL_REQUEST_TEMPLATE.md`).

## Decision

**Deferred.** This ADR is the design of record for a `staging` Railway environment, not an
implementation. When it is picked up:

1. A **`staging` Railway environment** in the same Railway project as production — `api`, `web`,
   `postgres`, `redis` — mirroring prod's service topology (per `docs/railway-deployment.md`
   §4a-4d), not a separate project.
2. **Deployed from a `staging` branch via Railway's native GitHub auto-deploy** — the same
   watch-pattern-gated mechanism that redeploys `api`/`web` on every `master` push today — not
   the GHCR-push pipeline `deploy-staging.yml` used. Railway's GitHub App already clones this
   repo while private (proven repeatedly on `master`), so no image registry or `RAILWAY_TOKEN`
   secret is needed for this path, and it does not depend on the public/private CI flip
   (`docs/runbooks/deploy-visibility-flip.md`) at all.
3. A **staging-tagged web image built with its own `NEXT_PUBLIC_API_URL` build ARG**, pointed at
   the staging API's Railway domain — a straight consequence of the build-time bake described
   above; there is no way to share the prod web image.
4. **Seeded only from the test-tenant allow-list** — `scripts/lib/test-tenants.cjs`
   (`assertTestTenant`/`assertSafeTarget`), the same guard the local lane and prod scripts already
   enforce. Never a live tenant, never a copy of live data.
5. **E2E gates on the staging `deployment_status`**, not the prod one — the suite runs once,
   against staging, and only a green run triggers a **manual promotion** to prod (a `master` merge
   or a `workflow_dispatch` of `deploy-production.yml`). This is the one change that actually
   closes the "production is the canary" gap named above; everything else is plumbing to reach it.

### Non-decisions

- **Custom staging subdomain scheme** (e.g. `acme.staging.routeflow.info`) is explicitly not
  decided here — plain `*.up.railway.app` is sufficient and needs no `tenant-host.ts` change
  (see Context). A custom scheme is a separate decision if it's ever wanted.
- **Build-once, promote-the-same-artifact** is not chosen, and is deferred rather than rejected:
  it is blocked by the `NEXT_PUBLIC_API_URL` build-time-bake constraint above (a single web image
  cannot serve two different API URLs at runtime) unless the web app is changed to read that URL
  at runtime instead — out of scope for this ADR.

## Consequences

**Cost — why this stays deferred.** A second full environment (api + web + Postgres + Redis, all
managed services) is a recurring Railway bill on top of production, for a repo whose owner has
already deferred it once (ADR 0001 option 2) in favor of a $0 local alternative. Nothing in this
ADR changes that trade-off; it only removes the ambiguity of "if we build it, what does it look
like" so the decision, when made, isn't also a design exercise.

**What the local lane (ADR 0001) covers instead.** `npm run local:up` + `local:seed` +
`local:validate`[`:features`] runs the **real production Docker images** — API, Web, Postgres,
Redis — wired together, against the approved `test` tenant, before a PR is opened. That closes
the "first time the built artifacts run as a system is in prod" gap for wiring/migration/env-var
regressions.

**What it does not cover (the residual).** The local lane runs on a developer's machine, once,
manually, before a PR — it is not a deploy-shaped environment, and it does not run the
Playwright E2E suite (that stays a `deployment_status`-triggered job in `ci.yml`, `apps/web/e2e/`
run against `.github/workflows/ci.yml`'s deploy target). So **E2E still reports on production**
after every merge: a real regression is still caught in prod first, only earlier in the pipeline
than a total absence of local validation would allow. Standing up staging per this design is the
change that would close that residual, by giving E2E a non-production target to gate on.

## Follow-ons

Named here so they aren't lost, not because this ADR resolves them:

- **P-18 — httpOnly JWT migration.** Web currently keeps JWTs in `localStorage`
  (`apps/web/lib/api-client.ts:4`, flagged as MVP debt in
  [`docs/ARCHITECTURE_REVERSE_ENGINEERING.md:196`](../ARCHITECTURE_REVERSE_ENGINEERING.md)).
  Unrelated to staging directly, but a staging environment is the natural place to exercise a
  cookie-based auth rewrite against something other than production.
- **P-20 — nonce-based CSP.** `apps/web/next.config.mjs`'s CSP currently allows
  `'unsafe-inline'`/`'unsafe-eval'`, flagged as tech debt pending a nonce migration
  (`docs/ARCHITECTURE_REVERSE_ENGINEERING.md:241`). Same rationale — staging is where a
  behavior-changing header rewrite gets its first real-traffic-shaped test.
- **`deploy-production.yml` as the worked reference.** Its header names it "a reference
  implementation for a future self-hosted/registry-based pipeline" — the GHCR build-and-push +
  environment-gated deploy shape it already contains is the pattern to adapt for staging if the
  GitHub-auto-deploy path (Decision §2) is ever swapped for a registry-based one instead.
