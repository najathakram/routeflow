---
name: regression
description: >
  Full autonomous regression pipeline for RouteFlow — what runs, when, and how to wire it.
  Auto-load when asked about: "regression", "test automation", "every build", "post-deploy",
  "nightly", "Railway webhook", "autonomous tests", "CI pipeline", "float artifacts",
  "money math regression", "critical paths", "CP-0*".
---

# Skill: RouteFlow Regression Pipeline

> **Test-tenant policy**: any tenant a test/seed/QA run touches MUST satisfy
> `scripts/lib/test-tenants.cjs` (`test`, `e2e-routeflow`, or `qa-*`/`e2e-*`/`ux-audit-*`).
> Never target a live client tenant — see CLAUDE.md "Test tenants & real-client data".

## What runs at every build (autonomously)

```
push to any branch
  └─ GitHub Actions ci.yml
       ├─ lint          (ESLint per workspace)
       ├─ type-check    (tsc --noEmit)
       └─ test          (Jest: 214 api + 63 mobile tests, incl. money-math + backsync specs)

push to master  →  Railway deploys  →  (in parallel)
  └─ GitHub Actions ci.yml
       └─ e2e job        waits for Railway health, then runs full Playwright suite

push to master (Railway deployment_status)  →  ci.yml e2e job owns the automatic post-deploy Playwright run.

manual / ad-hoc only: Actions → "Post-Deploy Verification" (post-deploy.yml, workflow_dispatch)
  ├─ api-smoke      post-deploy-check.mjs: login + 5 endpoints + float scan + invoice math
  └─ playwright     Playwright: all 6 specs including critical-paths

nightly 02:00 UTC
  └─ GitHub Actions nightly.yml
       ├─ api-smoke      same as above
       └─ playwright     same as above

nightly 02:00 local (Claude Code app open)
  └─ Scheduled task: routeflow-nightly-regression
       ├─ post-deploy-check.mjs  against production API
       └─ Playwright critical-paths  against production web
```

## Key test files

| File                                             | Layer | Purpose                                                |
| ------------------------------------------------ | ----- | ------------------------------------------------------ |
| `packages/pricing/src/pricing.spec.ts`           | Unit  | Money math: 220×2=440, boxed proration, rounding       |
| `apps/api/src/invoices/invoices.service.spec.ts` | Unit  | Invoice→order backward sync                            |
| `apps/mobile/__tests__/qty.test.ts`              | Unit  | Integer qty sanitizer                                  |
| `apps/web/e2e/06-critical-paths.spec.ts`         | E2E   | CP-01–10: float artifacts, $X.XX format, total=sub+tax |
| `scripts/post-deploy-check.mjs`                  | Smoke | Auth + 5 endpoints + money field scan + invoice math   |
| `scripts/smoke.mjs`                              | Smoke | Unauthenticated liveness only                          |

> The money-math spec lives in the `@routeflow/pricing` package and runs in its own Jest project —
> `npm test -w @routeflow/pricing`, not an `apps/api` jest invocation.

## Running locally

```bash
# Layer 1 — fast, no network
npm run verify                              # check-types + lint + test

# Layer 2 — needs production API running
SMOKE_BASE_URL=https://routeflowapi-production.up.railway.app \
SMOKE_TENANT_SLUG=e2e-routeflow \
npm run post-deploy-check

# Layer 3 — needs full Railway deploy
cd apps/web
PLAYWRIGHT_BASE_URL=https://routeflowweb-production.up.railway.app \
PLAYWRIGHT_TENANT_SLUG=e2e-routeflow \
npx playwright test --project=critical-paths   # fast (~3 min)
npx playwright test                            # all specs (~15 min)
```

## Post-deploy trigger (no webhook to set up)

The automatic post-deploy Playwright run is `ci.yml`'s `e2e` job, which fires on Railway's
`deployment_status` event (its declared fallback is `repository_dispatch: railway-deploy`).
`post-deploy.yml` had that webhook trigger removed on 2026-08-30 — it never fired, and two
workflows on one event would bill two Playwright suites — so it is now a manual, ad-hoc
"check production right now" workflow. Do not re-add a Railway deploy hook for it. To run it:
Actions tab → "Post-Deploy Verification" → "Run workflow".

Secrets both workflows read (Settings → Secrets → Actions):

- `SMOKE_BASE_URL` → `https://routeflowapi-production.up.railway.app`
- `PLAYWRIGHT_BASE_URL` → `https://routeflowweb-production.up.railway.app`
- `PLAYWRIGHT_TENANT_SLUG` → `e2e-routeflow`

For nightly GitHub Actions (free on public repo only):

- Keep repo public when CI is expected, or use a self-hosted runner.
- Self-hosted runner on Railway: deploy `myoung34/github-runner` as a Railway service
  with env `RUNNER_SCOPE=repo`, `REPO_URL=https://github.com/YOUR_ORG/routeflow`,
  `ACCESS_TOKEN=<PAT>`, then change `runs-on: ubuntu-latest` → `runs-on: self-hosted`
  in the workflow files.

## GitHub Actions budget ($0 plan)

- Workflows only run free on **public** repos.
- Workflow: make repo public → push → wait for CI → make private.
- The scheduled Claude Code task (`routeflow-nightly-regression`) runs locally regardless
  of repo visibility — it's a fallback that doesn't need Actions minutes.

## Adding a regression test

When you fix a bug:

1. Add a unit spec in `packages/pricing/src/pricing.spec.ts` (money) or the relevant
   `*.service.spec.ts` (locks the fix in Jest).
2. Add a CP-\* test to `06-critical-paths.spec.ts` if it's visible in the UI or API response.
3. Update the code map: `_meta.json` + the relevant area file.
