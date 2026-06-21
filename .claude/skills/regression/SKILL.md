---
name: regression
description: >
  Full autonomous regression pipeline for RouteFlow — what runs, when, and how to wire it.
  Auto-load when asked about: "regression", "test automation", "every build", "post-deploy",
  "nightly", "Railway webhook", "autonomous tests", "CI pipeline", "float artifacts",
  "money math regression", "critical paths", "CP-0*".
---

# Skill: RouteFlow Regression Pipeline

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

Railway deploy finishes  →  Railway sends webhook  →
  └─ GitHub Actions post-deploy.yml
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
| `apps/api/src/common/pricing.spec.ts`            | Unit  | Money math: 220×2=440, boxed proration, rounding       |
| `apps/api/src/invoices/invoices.service.spec.ts` | Unit  | Invoice→order backward sync                            |
| `apps/mobile/__tests__/pricing.test.ts`          | Unit  | Pricing mirror parity (mobile = api)                   |
| `apps/mobile/__tests__/qty.test.ts`              | Unit  | Integer qty sanitizer                                  |
| `apps/web/e2e/06-critical-paths.spec.ts`         | E2E   | CP-01–10: float artifacts, $X.XX format, total=sub+tax |
| `scripts/post-deploy-check.mjs`                  | Smoke | Auth + 5 endpoints + money field scan + invoice math   |
| `scripts/smoke.mjs`                              | Smoke | Unauthenticated liveness only                          |

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

## One-time Railway webhook setup

This makes every Railway deploy trigger `post-deploy.yml` automatically:

1. Create a GitHub Personal Access Token (Settings → Developer Settings → Tokens → Classic):
   - Scope: `repo`
   - Name: `railway-deploy-hook`

2. In Railway dashboard → your API service → Settings → Deploy Hooks → Add Hook:
   - **URL**: `https://api.github.com/repos/YOUR_ORG/routeflow/dispatches`
   - **Method**: POST
   - **Headers**:
     ```
     Authorization: Bearer <your-PAT>
     Accept: application/vnd.github+json
     X-GitHub-Api-Version: 2022-11-28
     Content-Type: application/json
     ```
   - **Body**:
     ```json
     { "event_type": "railway-deploy", "client_payload": {} }
     ```

3. Add these GitHub repository secrets (Settings → Secrets → Actions):
   - `SMOKE_BASE_URL` → `https://routeflowapi-production.up.railway.app`
   - `PLAYWRIGHT_BASE_URL` → `https://routeflowweb-production.up.railway.app`
   - `PLAYWRIGHT_TENANT_SLUG` → `e2e-routeflow`

4. For nightly GitHub Actions (free on public repo only):
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

1. Add a unit spec in `pricing.spec.ts` or the relevant `*.service.spec.ts` (locks the fix in Jest).
2. Add a CP-\* test to `06-critical-paths.spec.ts` if it's visible in the UI or API response.
3. Update the code map: `_meta.json` + the relevant area file.
