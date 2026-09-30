# Campaign decisions of record

Standing decisions for the bug-register burn-down (plan:
`read-the-bug-registry-scalable-gosling`). Each is binding for the campaign unless
the owner reverses it; reversals are recorded here, dated, never deleted.

## D1 — No web unit-test runner; web-side logic is tier T2 (2026-08-30, F00)

`apps/web` has no unit runner (no `test` script; its only specs are the Playwright
e2e). The plan allowed F00 to either stand one up or record a decision. **Decision:
do not add one.**

- The repo's own guardrail says _no root-level test runner_ and _no Vitest_; a
  web-side Jest would mean a second jsdom/Next transform stack maintained for one
  campaign's worth of tests.
- Every web-side bug in the register is user-visible behaviour, which the deployed
  Playwright suite exercises against the real build — a stronger oracle than a
  mocked hook test.
- The seeded ledger already froze every web-side ID as T2; a runner now would
  invite tier churn `campaign-check` is designed to reject.

Consequence: web-side proofs carry `state: proven-pending-deploy` through their PR
and are discharged by the deploy-triggered e2e run (ci.yml `deployment_status`
trigger). Shared logic that genuinely wants a unit test moves to `packages/*` (jest
already runs there via the api/mobile workspaces importing it) rather than growing
a web runner.

## D2 — B126/B127 are `already-fixed`, not `done` (2026-08-30, F00)

Their fix shipped pre-campaign (PR #506, deployed and post-deploy-verified) with
specs named before the `REG-` convention existed
(`settings.controller.clear-financial.spec.ts`,
`customers.service.delete-all.spec.ts`). `done` would make `campaign-check` demand
a `REG-B126`/`REG-B127` test title on every future `npm run verify`; renaming
shipped green specs to satisfy a bookkeeping state is churn with no safety value.
`already-fixed` + evidence naming those specs is the vocabulary's exact case and is
a terminal state for the campaign's exit criteria. If F02b touches either spec file
anyway, it may add the `REG-` token to the titles opportunistically — then and only
then may the rows flip to `done`.

## D3 — RLS arming rule: pre-flight-gated auto-arm (owner, 2026-08-31)

Zero NULL-tenantId rows on every policied table (per `scripts/rls-preflight.mjs`, which parses
the table list out of the migration itself) ⇒ backup, apply `20260909000000_rls`, and trust only
the migration's own post-apply RAISE-EXCEPTION assertion. Any NULLs ⇒ do NOT arm; ship the rest
of F02b and bring the owner the counts with a backfill plan.

## D4 — Historical data repair: repair-as-we-go (owner, 2026-08-31)

Each batch that fixed a damage-writing bug also repairs its identifiable historical rows,
post-deploy: fresh verified backup → dry-run printout → per-row tx apply with in-tx re-read →
scoped integrity re-check, JSONL log to local-assets/. Unidentifiable damage (e.g. B81's
overwritten payment methods, B98's truncated imports) is recorded as unrepairable, never guessed.

## D5 — Feature-shaped register entries: session judgment + reported list (owner, 2026-08-31)

The ~25 feature-shaped entries: build the small/flow-completing ones, defer genuine feature
requests to the register's Deferred section with reasons. Full build-vs-deferred list reported at
Wave C close.

## D6 — Deploy cadence: merge as ready, any hour (owner, 2026-08-31)

Strictly serial per lane, but no batching into windows; every merge followed by
post-deploy-check + the self-triggering e2e run. One PR per batch stays sacred for revertability.
