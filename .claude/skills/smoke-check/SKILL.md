---
name: smoke-check
description: >
  Auto-load before pushing RouteFlow or to verify a deploy is healthy. Runs the local
  correctness gates (typecheck + lint + unit tests), the authenticated API smoke probe,
  and/or the Playwright e2e regression suite. Keywords: "smoke", "smoke test",
  "verify before push", "pre-push", "is the deploy up", "health check", "ci will it pass",
  "run verify", "regression", "post-deploy check", "float artifacts", "money math test".
---

# Skill: Smoke, pre-push verification & regression (RouteFlow)

> **Test-tenant policy**: any tenant a test/seed/QA run touches MUST satisfy
> `scripts/lib/test-tenants.cjs` (`test`, `e2e-routeflow`, or `qa-*`/`e2e-*`/`ux-audit-*`).
> Never target a live client tenant — see CLAUDE.md "Test tenants & real-client data".

Three layers. Run from the repo root unless noted. Prefer these over GitHub Actions minutes
(CI is only free while the repo is public — see `.github/workflows/ci.yml` header).

## Layer 1 — Local correctness gate (before every push)

```bash
npm run verify        # turbo: check-types + lint + test (api + mobile Jest, mocked — fast)
```

Critical regression specs that must stay green:

- `packages/pricing/src/pricing.spec.ts` — money math (220 × 2 = 440, boxed proration, rounding).
  Its own Jest project: run it directly with `npm test -w @routeflow/pricing`, not from `apps/api`.
- `apps/api/src/invoices/invoices.service.spec.ts` — invoice→order backward sync.
- `apps/mobile/__tests__/qty.test.ts` — integer qty sanitizer.

## Layer 2 — Authenticated API smoke (after any deploy)

```bash
# unauthenticated liveness only (health + public tenants endpoint)
SMOKE_BASE_URL=https://<api-host> npm run smoke

# full authenticated check: login → 5 endpoints → float-artifact scan → invoice math assertion
SMOKE_BASE_URL=https://routeflowapi-production.up.railway.app \
SMOKE_TENANT_SLUG=e2e-routeflow \
npm run post-deploy-check
```

`scripts/post-deploy-check.mjs` logs in as operator, hits orders/invoices/customers/products/
drivers, verifies no money field has >2 decimal places (catches the 220 × 2 = 420 float-drift
bug), and asserts `invoice.total ≈ subtotal + tax`. Set `SMOKE_WAIT_RETRIES=30` to poll for
the API to become healthy before starting (used in CI after Railway deploys).

## Layer 3 — Playwright e2e regression (against live Railway)

```bash
cd apps/web
PLAYWRIGHT_BASE_URL=https://routeflowweb-production.up.railway.app \
PLAYWRIGHT_TENANT_SLUG=e2e-routeflow \
npx playwright test                          # all 6 spec files
npx playwright test --project=critical-paths # CP-01–10 only (~3 min, money-math focused)
```

`06-critical-paths.spec.ts` is the dedicated money-math regression guard:
CP-01/02 — displayed amounts are `$X.XX`; CP-03 — invoice total = subtotal + tax;
CP-04/05 — API money fields have ≤2 dp; CP-10 — no float artifacts in line items.

## Autonomous pipeline (no manual trigger needed)

| When                       | What                                  | Config                                                  |
| -------------------------- | ------------------------------------- | ------------------------------------------------------- |
| Every push (any branch)    | Layer 1 (lint + types + unit tests)   | `.github/workflows/ci.yml`                              |
| Every master push          | + Playwright e2e after Railway health | `.github/workflows/ci.yml` `e2e` job                    |
| After every Railway deploy | Layer 2 + 3 (smoke + e2e)             | `.github/workflows/post-deploy.yml` via Railway webhook |
| Nightly 02:00 UTC          | Layer 2 + 3                           | `.github/workflows/nightly.yml`                         |
| Nightly 02:00 local        | Layer 2 + 3 (Claude Code agent)       | Scheduled task `routeflow-nightly-regression`           |

To wire the Railway webhook → see the header comment in `.github/workflows/post-deploy.yml`.

## When extending

- Add a regression spec whenever you fix a correctness bug — lock it in `pricing.spec.ts` or
  a new CP-\* test in `06-critical-paths.spec.ts`.
- Keep Layer 1 fast (no network, no DB). Layer 2 needs a running API. Layer 3 needs full deploy.
- After touching tests/CI, update the code map per the routine.
