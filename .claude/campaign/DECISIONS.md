# Campaign decisions of record

Standing decisions for the bug-register burn-down (plan:
`read-the-bug-registry-scalable-gosling`). Each is binding for the campaign unless
the owner reverses it; reversals are recorded here, dated, never deleted.

## D1 — No web unit-test runner; web-side logic is tier T2 (2026-08-30, F00)

`apps/web` has no unit runner (no `test` script; its only specs are the Playwright
e2e). The plan allowed F00 to either stand one up or record a decision. **Decision:
do not add one.**

- The repo's own guardrail says *no root-level test runner* and *no Vitest*; a
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
