# Fix ruling — F18 (B58 · B73 · B107) billing plan-change, commission clawback, add-on ↔ Stripe

> Fable @ high, 2026-09-06. Inputs: the committed plan `.claude/pipeline/2026-09-02-wave-a-completion/F18.md`
> (adversarially verified 2026-09-02), the verified corrections `local-assets/handoff/2026-09-06/bug-plan/corrections-F18.md`,
> S1 `cause-brief.md` and S2 `refutation.md` in this run dir (attached when they land; this ruling is amended only
> where S2 refutes). Base: master `597c72dc`, worktree `rf-watchdog`, branch `fix/F18-billing-plan-change`.
> Owner rulings 2026-09-06: carve-out GO; **B58 = a bug** → variant (a).

## 1. Cause verdicts (accepted from the plan; S2 confirms line numbers on 597c72dc)

| Bug  | Verdict   | Diverging behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B58  | confirmed | `choose-plan/page.tsx` `commit()` posts `/billing/subscribe` unconditionally; `subscription-mutation.service.ts` `subscribe()` has no guard for an ACTIVE plan-holder and resets `periodStart/periodEnd` on both upsert branches → instant downgrade, metering re-bucket (`MeterUsage` keyed on `periodStart`), renewal jump, full-cycle "due today". No Stripe money moves (only platform-admin's `syncStripeSubscriptionPrice` does). `useProrationPreview` previews an ADD-ON, not a plan change — there is no plan-change preview endpoint. |
| B73  | confirmed | `commission-engine.service.ts` `runSync` reads accruals+adjustments with no lock; `syncAccrualRow` inserts the `CommissionAdjustment` unconditionally; the model has `@@index` only, no `@@unique`. READ COMMITTED callers (the :30 cron + hook sites outside the two Serializable blocks) both read zero prior adjustments and each append a CLAWBACK. Copying the accrual path's re-check would NOT fix it (that path is saved by `@@unique`).                                                                                                |
| B107 | confirmed | `addon.service.ts` `disableAddon`: log-only catch around `subscriptionItems.del`, then unconditional `{ active:false, stripeItemId:null }`; `enableAddon`: catch-and-continue then activates with `stripeItemId` null; sibling in the same method: `if (sub?.stripeSubId)` skips Stripe entirely when the tenant has no Stripe subscription. The controller/web need no change (non-2xx already surfaces).                                                                                                                                      |

> **Amendment 1 (S1 finding, 2026-09-06):** the :30 cron is now `@LeaderCron("30 * * * *", "commission-reconciliation.reconcileCommissions")` (#623), a per-job try-mode advisory lock that only prevents two REPLICAS running the SAME cron concurrently. It does not serialize the cron against the READ COMMITTED hook callers, which is the race B73 targets — so the `FOR UPDATE` seam at the top of `runSync` stands unchanged. Schema citations move to `apps/api/prisma/schema/sales.prisma:1232-1283` (CommissionAccrual `@@unique` at 1258; CommissionAdjustment has `@@index` only) and `platform.prisma` for `TenantAddon.stripeItemId`; the sync call-site line numbers in F18.md are stale and must be re-derived by the engine, never trusted.

## 2. Fix design (minimal diff) — F18.md §Fix per bug, with these bindings

- **B58 API:** guard in `subscribe()` after the prior-state reads: `tenant.status === 'ACTIVE' && priorSub?.planKey && input.planKey !== priorSub.planKey && input.cycle === priorSub.cycle` → `ConflictException("Your subscription is active — use upgrade or downgrade to change plan")` BEFORE the `$transaction`; read `priorSub` with `select { planKey, cycle }`. New read `planChangePreview(tenantId, planKey, cycle)` → `{ action: SUBSCRIBE|UPGRADE|DOWNGRADE|NOOP, proratedNow, effectiveAt, keepsRenewalAt, warning? }` ranking with the server's `planRank` (never web `sortOrder`), reusing the private prorated-diff helper. `settings-billing.controller.ts` `quote()` returns `{ ...quote, change }` — no new endpoint, hook or DTO.
- **B58 web:** `lib/api/billing.ts` `QuoteResult.change: PlanChange`; `choose-plan/page.tsx` `commit()` dispatches on `preview.change.action` → `upgrade.mutate({planKey})` / `downgrade.mutate({targetPlanKey, retainedUserIds: []})` / `subscribe.mutate({planKey, cycle})` / NOOP disabled; Summary "Due today" from `change.proratedNow` (UPGRADE) or `$0 + "Takes effect <effectiveAt>"` (DOWNGRADE); button/toast labels per action. `settings/billing/page.tsx` unchanged. Keep `useUpgrade`/`useDowngrade`; do not delete `useProrationPreview`.
- **B58 T2:** `apps/web/e2e/33-change-plan-routing.spec.ts` (**33**, never 29 — F08 owns 29) + a `playwright.config.ts` project `change-plan-routing` (operator storageState, dependencies `['setup']`) — interception-only via `page.route`, mutates nothing on the e2e tenant.
- **B73:** ONE guard at the top of `runSync(invoiceId, db)` before the invoice read: `await db.$executeRaw\`SELECT id FROM "CommissionAccrual" WHERE "invoiceId" = ${invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE\`` (raw SQL bypasses the tenant proxy — scope by hand). The flag-OFF early return stays BEFORE the lock. Lock order Invoice → CommissionAccrual is preserved. Update the class docblock.
- **B107:** refusal strategy, no migration. `disableAddon`: if `addon.stripeItemId && stripe.isConfigured` → try del; on error not `resource_missing`/404 → `ServiceUnavailableException` naming the item, the add-on and the retry; `resource_missing` = success (clear the pointer). `enableAddon` inside `if (stripePriceId && stripe.isConfigured)`: `!sub?.stripeSubId` → `ConflictException`; create failure → `ServiceUnavailableException`, upsert not run. Module-level `isStripeResourceMissing(e)`. Free-grant path (no price) unchanged.
- **Must NOT change:** cycle switches and non-ACTIVE re-entry stay on `subscribe()`; the existing drift test (single-sync idempotency) stays; the no-price add-on path; `platform-admin.controller.ts`; the twin seams (`subscription-mutation.service.ts` `disableAddon`, `billing-cron` `applyScheduledCancellations`) are FILED, not fixed.
- **Invariants:** (B58) an ACTIVE subscription's period is never reset by a same-cycle plan change; (B73) under concurrency `runSync` appends at most one adjustment per drift; (B107) with a Stripe price, entitlement and the Stripe item move together or not at all.

## 3. Regression tests — `bug-test-plan.md` (T1–T12); REG tokens `REG-B58`, `REG-B73`, `REG-B107`.

## 4. Blast radius (`radiusFiles`)

`apps/api/src/billing/subscription-mutation.service.ts`, `.spec.ts`, `apps/api/src/billing/settings-billing.controller.ts`,
`apps/api/src/billing/proration.service.ts` (read), `apps/api/src/billing/plan-catalog.constants.ts` (read),
`apps/web/lib/api/billing.ts`, `apps/web/app/(dashboard)/choose-plan/page.tsx`,
`apps/api/src/sales-agents/commission-engine.service.ts`, `.spec.ts`, `apps/api/src/billing/addon.service.ts`, `.spec.ts`,
`apps/web/playwright.config.ts`, `apps/web/e2e/33-change-plan-routing.spec.ts`.

## 5. Sibling patterns (`siblingPatterns`)

- `subscriptionItems\.(del|create)\(` — a Stripe item write; each needs refusal on failure, not a log.
- `catch \(\w+\) \{\s*this\.logger\.(warn|error)` in `apps/api/src/billing/` — a swallowed money-side failure.
- `include: \{ commissionAccruals` — an unlocked read of accruals before a write.

## 6. Data repair (owner-owed, never bundled)

Plausibly corrupted: (B58) ACTIVE tenants whose `periodStart` was reset by a same-cycle plan change (identifiable: PLAN_CHANGED events without `instant`/`prorated` markers + a period reset); (B73) duplicate CLAWBACK adjustments on one accrual within seconds; (B107) `TenantAddon` rows `active:false, stripeItemId:null` whose Stripe item still exists. One read-only report script per class, run by the owner via `railway run --service postgres`; decisions after the report.

## 7. Probe plan (`revertFix: true`)

| File                                                     | REG test that must go red |
| -------------------------------------------------------- | ------------------------- |
| `apps/api/src/billing/subscription-mutation.service.ts`  | REG-B58 (T1 guard)        |
| `apps/api/src/sales-agents/commission-engine.service.ts` | REG-B73 (T5)              |
| `apps/api/src/billing/addon.service.ts`                  | REG-B107 (T7)             |

## 8. Close-out bindings

One PR (D6). Commits carry `Bookkeeping-Follow-Up: pending`; registry rows (`prove`, T2 `--pending-deploy`, `discharge` after the deploy + E2E read) and the lesson (register at 40/40 and 40.0/40.0 KB → archive TWO guarded entries first; id from `_meta.json.nextId`) land in the lead's docs-only follow-up. File as new registry rows: the two B58 residuals (ACTIVE cycle switch uncredited; no self-service Stripe push) and B107's two twin seams.

## 9. Amendment 2 — S2 rulings (Fable, after `refutation.md`; these override §2 where they differ)

- **B58 guard keys on plan RANK, not the raw key.** `planRank(input.planKey) !== planRank(priorSub.planKey)` (+ ACTIVE + same cycle) → 409. A legacy rename with equal rank (e.g. a v7 `BUSINESS` re-pinned as the v8 `SCALE`) stays on `subscribe()` — it is the only `planVersionId` re-pin path — and `planChangePreview` returns **SUBSCRIBE** (never NOOP) for equal-rank-different-key; NOOP only for the same key AND cycle.
- **`quote()` must not 403 a SUPER_ADMIN.** Resolve the tenant defensively: when no tenant context exists, return `change: null` (client treats null as SUBSCRIBE); do not add a role gate.
- **Second entrance:** `apps/web/app/(dashboard)/_components/gates/PlanGates.tsx` (CTA "Upgrade to X" posting `/billing/subscribe`) must go through the SAME dispatch: extract `dispatchPlanChange(preview, mutations)` into `apps/web/lib/api/billing.ts` and use it from both `choose-plan/page.tsx` and `PlanGates.tsx` (or route the CTA to `/choose-plan`). Added to P4 and the radius; T4 gains a pin that PlanGates' CTA no longer calls `/billing/subscribe` directly (interception, third case).
- **B73 lock keys on `invoiceId` ONLY**: `SELECT id FROM "CommissionAccrual" WHERE "invoiceId" = ${invoiceId} FOR UPDATE` — `CommissionAccrual.tenantId` is nullable (`sales.prisma:1249`), so a tenant predicate would let legacy NULL rows escape the lock; `invoiceId` is a UUID, so cross-tenant collision is impossible. Document the contract in the docblock: `runSync` is always called with a transactional client; a non-transactional `db` makes the lock a no-op (residual to FILE with `removeInvoiceCommission` having no lock). The PR body must not claim to close cron-vs-cron (already closed by `@LeaderCron`, #623).
- **B107 harness:** `addon.service.spec.ts` `make()` must RETURN the stripe mock (`{ svc, prisma, entitlements, catalog, stripe }`); the existing disable test sits at ~:68-88.
- **Register at close-out:** `_meta.json.nextId` is 83; `L-045` is already archived; `L-056` remains the archive candidate — the follow-up archives TWO.
