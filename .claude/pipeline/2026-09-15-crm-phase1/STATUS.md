# CRM cloud session status

**2026-09-15 ~22:10Z** · session `routeflow-62` · branch `feat/crm-phase1` · run dir
`.claude/pipeline/2026-09-15-crm-core-phase1/`

**Engine: `02d58b81…`, 224,133 B, `node --check` passes, worktree clean.**

| Stage | State |
|---|---|
| S0 · S0.5 · S1 · S2 · S3 | done |
| **S4 test plan** | **done — 50 tests, all 34 requirements covered** |
| S5 build plan | next — **its summary comes to you before any building** |
| S6 approval | **your "S5 approved" gates every code push** |

## S4 outcome

50 tests, T1–T50. Coverage walk is complete: every R1–R34 has ≥ 1 T#, every T# names its R#,
nothing deliberately untested. Negative tests, mutation probes, flake controls and expected
red-gate failure messages are all in the file.

**Tier split — this matters for what I can actually prove here:**
- **Bare checkout, this session (T1–T18):** 13 api unit specs, 3 web RTL, 2 mobile Jest.
- **Needs your host (T19–T50):** 28 `*.db.spec.ts` via `local:test:db`, the compose boot gate,
  Playwright, the screenshot matrix, and the Expo design review. That is 32 of 50 tests I can
  write but cannot run.

**Strongest oracles**, so you can judge whether they'd really fail on a wrong implementation:
- **T38** (dedup, Frappe #16 as a deliberate divergence): a customer with `phone:"(555) 010-0100"`
  stored raw and a *different* email; querying `?phone=555.010.0100` returns exactly 1 match. Fails
  if either side isn't normalised, or if someone "fixes" it back to upstream's email-only rule.
- **T35/T36** (convert idempotency): second convert — sequential and concurrent — returns the same
  `customerId` with tenant `Customer` count N+1, **not** N+2.
- **T37** (cap 403): body `toStrictEqual(buildPlanGateBody("meter.customers", upgrade))` passed
  through unchanged, `User` count unchanged, lead still `OPEN` with `convertedCustomerId:null`.
- **T39/T40**: DRIVER and CUSTOMER each 403 — a filtered empty 200 fails the test, by design.

## Two infrastructure gaps I verified myself

**1. There is no DRIVER identity anywhere in the e2e stack.** `apps/web/e2e/setup/auth.setup.ts`
produces only super-admin, operator and customer storage states (its own docstring says so), and
`apps/api/scripts/e2e-seed.js` seeds **zero** DRIVER users — `grep -c DRIVER` returns 0.

So the Playwright role-deny flow runs as **CUSTOMER**, and the DRIVER denial is proven at the db
level instead (T39, a real 403 against the compiled app). **Recommendation: accept that for
Phase 1.** Adding a DRIVER seed identity plus a storage state changes shared e2e infrastructure
used by every project, which is outside this slice and not something I'll do unasked. Your call if
you want it done properly now.

**2. `post-deploy-check` has no CRM probe** and I have not added one — the gate is dark, so there is
nothing to probe until it flips, and touching that script affects every deploy. Flagged for the
flip diff, not for this PR.

**A new Playwright project is genuinely needed.** House shape is one project per spec file
(`playwright.config.ts:65-300`), so `crm-core` → `apps/web/e2e/48-crm-core.spec.ts`. The
`local:e2e` allow-list is the inline `--project=` list in root `package.json:38` (8 projects today)
plus `apps/web/e2e/LOCAL-LANE.md`. Both need the entry added.

## Open rulings — #13 is now the one that can block

- **#13 advisory-lock family** — **this is the blocker.** `withAdvisoryLock` throws on an
  unregistered family, so R19 cannot ship and T36 cannot name one. Either let me borrow
  `order-merge` keyed on lead id (my recommendation — `customers.service.ts:1374` already borrows
  it for advance payments), or approve a new `crm` family in `LOCK_FAMILIES`.
- **Q4** owner-on-unassign tie-break — T27 has the single `toBe(userC.id)` line named as the flip point.
- **Q5** cap-403 prompt scope — flow 9 is written for the convert-scoped handler; a global
  `MutationCache` branch changes the assertion target.
- **Q6** CALL outcome enum — T5 pins `["REACHED","NO_ANSWER","LEFT_VOICEMAIL"]`.
- **#12** phone normaliser placement — T6 assumes `digitsOnly` in `lead-rules.ts`.
- **Q1** hq merged · **Q2** prospect count N · **Q3** second gate.

## Compliance

No code written. No bug or lesson id minted. No host-heavy step attempted. No PR. Docs-only pushes.
Test tenants (`qa-crm-<run8>` after `assertTestTenant`) and `acme` placeholders throughout.
