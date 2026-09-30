# Brief — PR-7 · Item 6b: local E2E lane against the Docker stack (light loop)

Branch `test/imp-06b-local-e2e-lane` (after PR-6). Commit type `test:`. Scale small (scripts +
config; no production code). Loop: Sonnet builds → Opus `high` review → gates.

## Why

Hosted staging is deferred (owner, 2026-09-03), so item 6's "E2E before prod" ships as a
pre-PR lane against the #606 local stack. Today E2E runs only post-deploy against production
(`ci.yml` e2e job, `deployment_status`). The pieces already exist: `apps/web/e2e/helpers/api.ts`
`apiBase()` rewrites `:3001` → `:3000`; `helpers/auth.ts` `setTenantCookie`/`fillWorkspaceIfShown`
handle a bare host (`tenant-host.ts` returns `null` for `localhost`); `global.setup.ts` seeds
`e2e-routeflow` from `E2E_SEED_DATABASE_URL`; compose bakes web's API URL as
`http://localhost:3000/api/v1`. Trap: the JSON reporter writes `.campaign/runs/web-e2e.json`
(`playwright.config.ts:47`), which `scripts/campaign-check.mjs:202` reads as the campaign's
evidence — a local run must not clobber it.

## Requirements

| R#  | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Verified by |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| R1  | Root `package.json` script `local:e2e`: sets `PLAYWRIGHT_BASE_URL=http://localhost:3001`, `SMOKE_BASE_URL=http://localhost:3000`, `PLAYWRIGHT_TENANT_SLUG=e2e-routeflow`, `E2E_SEED_DATABASE_URL=<the compose URL exactly as local:seed builds it>`, `PLAYWRIGHT_JSON_OUTPUT_NAME=../../.campaign/runs/web-e2e-local.json` (Playwright's documented override of the json reporter's `outputFile`), `CI` unset, and runs `npm --prefix apps/web run test:e2e -- --project=<allow-list>`; uses the same `sh -c` env mechanism `local:seed` uses. `local:e2e:all` runs every project (no `--project`). | A1          |
| R2  | The allow-list is explicit and documented in `apps/web/e2e/LOCAL-LANE.md`: `setup` plus the money/guard projects `critical-paths`, `create-order-escape`, `boxed-order-entry`, `order-edit-pricing`, `payment-truth`, `destructive-guards`, `cancelled-edit-banner`, trimmed by measurement to ≤ 10 min wall clock on this machine (the PR records each project's local duration); projects needing `PLAYWRIGHT_SA_*` are excluded.                                                                                                                                                                 | A1          |
| R3  | `scripts/campaign-check.mjs` continues to read only `web-e2e.json`; a `web-e2e-local.json` is never mistaken for campaign evidence (add one line to its header comment). `.gitignore` already covers `.campaign/runs/`.                                                                                                                                                                                                                                                                                                                                                                             | review      |
| R4  | Docs: `CLAUDE.md` local-hosting runbook gains `npm run local:e2e` as the third gate tier ("UI changes"); `docs/adr/0001-local-hosting-environment.md` gets a "Local E2E lane" subsection stating the ruling: item 6's staging gate ships at half (pre-PR local lane; E2E still reports on prod) because hosted staging is deferred; `.github/PULL_REQUEST_TEMPLATE.md` checkbox wording (PR-12 owns the template — leave it).                                                                                                                                                                       | review      |
| R5  | Bookkeeping: code-map `web.md` (lane doc + script), `_meta.json`; `docs/IMPROVEMENTS.md` item 6 status `partial (PR-7 lane; users PR-8)`; lessons `updatedAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                      | review      |

## Tests

No unit tests (config + docs). Proof = A1.

## Acceptance

- A1: with the stack up (`local:up`, `local:seed`), `npm run local:e2e` → green; wall time ≤ 10
  min pasted; `.campaign/runs/web-e2e-local.json` written and `web-e2e.json` untouched
  (`git status`/mtime); `npm run local:e2e:all` runs to completion (report pass/fail per project —
  failures in projects outside the allow-list are recorded, not fixed here).
- A2: `npm run verify` green.

## Files

Root `package.json`; `apps/web/e2e/LOCAL-LANE.md` (new); `scripts/campaign-check.mjs` (comment);
`CLAUDE.md`; `docs/adr/0001-local-hosting-environment.md`; bookkeeping.
