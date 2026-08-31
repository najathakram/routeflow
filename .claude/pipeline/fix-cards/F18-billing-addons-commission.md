# F18 · Billing, add-ons and commission

**Bug IDs (3):** B58, B73, B107

**Root cause:** Money paths that write before confirming. "Change plan" always calls subscribe, charging full price and resetting the billing period while the correct prorated upgrade/downgrade endpoints sit fully implemented and orphaned (B58); disableAddon nulls stripeItemId even when the Stripe delete failed (B107); concurrent commission sync double-appends a CLAWBACK (B73).

**Ships as:** One PR.

**Files:** web choose-plan + settings/billing · billing/addon.service.ts · sales-agents/commission-engine.service.ts

**Together because:** Three independent money-paths-that-write-before-confirming defects, small enough to batch together; no shared hot file.

**Guardrails / shared infra:** None new. No lane conflicts — freely parallel.

**Dependencies / lane notes:** None.

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F18.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status     |
| ---- | ---- | -------------- | ------------------- |
| B58  | T2   | e5b0af8e       | NO_TOKEN_UNVERIFIED |
| B73  | T1   | e5b0af8e       | OUT_OF_BOUNDS       |
| B107 | T1   | 0cd59277       | NO_TOKEN_UNVERIFIED |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B58 — "Change plan" always calls subscribe — full non-prorated charge and a reset billing period

**Area:** apps/web choose-plan + settings/billing; apps/api/src/billing

**Meant to do:** An active paying subscriber changing plans gets the backend's prorated instant upgrade (period preserved, only the difference charged) or a deferred free downgrade at period end, per plan-tier direction.

**Actually does:** The only change-plan UI path calls useSubscribe -> POST /billing/subscribe unconditionally for every plan change. subscribe() always sets periodStart=now and periodEnd=addCycle(now) and charges the full new-plan quote. useUpgrade/useDowngrade/useProrationPreview exist, are fully typed, and have zero callers anywhere in apps/web.

**The gap:** subscribe() is architected for committing a subscription / converting a trial, but is used for every change including an already-ACTIVE payer. The correct instant-prorated and deferred-free endpoints are fully implemented server-side and completely orphaned on the frontend.

**Evidence:** apps/web/app/(dashboard)/choose-plan/page.tsx:64-76 (commit() -> subscribe.mutate, unconditional); apps/web/app/(dashboard)/settings/billing/page.tsx:207-210 ("Change plan" is a plain link to /choose-plan); apps/web/lib/api/billing.ts:156-198 (useProrationPreview/useUpgrade/useDowngrade, no other references in apps/web); apps/api/src/billing/subscription-mutation.service.ts:94-259 (subscribe resets period at :158-159/:168-169) vs :262-308 (upgrade: instant, prorated, period preserved) vs :311-340 (downgrade: scheduled at period end, free); apps/api/src/billing/settings-billing.controller.ts:98,106,114.

**Suggested fix:** Branch on whether the tenant already has an ACTIVE paid subscription: call useUpgrade when the new plan ranks higher and useDowngrade when lower, reserving subscribe() for trial conversion / no prior subscription, and surface useProrationPreview in the confirmation step.

### B73 — Concurrent commission sync double-appends a CLAWBACK — an agent's payable is clawed back twice

**Area:** apps/api/src/sales-agents — commission-engine.service.ts

**Meant to do:** syncInvoiceCommission is idempotent: once a CLAWBACK adjustment is committed for a negative-drift event, any re-sync (cron or hook) sees it and appends nothing more.

**Actually does:** Drift is computed from a plain non-locking read of existing.adjustments, then commissionAdjustment.create runs unconditionally — no unique constraint, no pre-insert re-check, no row lock. The accrual path a few lines away has exactly that pre-insert re-check; the adjustment path does not.

**The gap:** The hourly reconciliation cron and a payment/void hook, both running READ COMMITTED with no lock, can each read zero prior adjustments and each insert a CLAWBACK, doubling the deduction against the agent.

**Evidence:** apps/api/src/sales-agents/commission-engine.service.ts:332-335 (priorAdjTotal from a plain read), :343-357 (drift/kind decision), :416-426 (unconditional create), contrast :470-481 (the accrual path's alreadyAccrued re-check); apps/api/prisma/schema.prisma:4289-4308 (CommissionAdjustment has only @@index, no @@unique); apps/api/src/sales-agents/commission-reconciliation.service.ts:29 (@Cron 30 * * * *), :44-58; apps/api/src/prisma/prisma.service.ts:35-49 (tenantTransaction passes no isolationLevel — READ COMMITTED). Hook call sites bookkeeping.service.ts:217, credit-notes.service.ts:447/677, customers.service.ts:1221, invoices.service.ts:4634/4703/4748/4908/4996/5136 all call the sync inside a plain tenantTransaction.

**Suggested fix:** Row-lock the CommissionAccrual (SELECT ... FOR UPDATE, the idiom already used in recordPayment and returns create) before computing drift, or run syncInvoiceCommission under Serializable at every call site including the cron.

### B107 — disableAddon nulls stripeItemId even when the Stripe delete failed — tenant keeps paying, pointer destroyed

**Area:** Platform billing · add-ons API

**Meant to do:** Disabling an add-on removes both the entitlement and the recurring Stripe charge; if the charge can't be removed, the platform admin must be told so billing can be fixed.

**Actually does:** subscriptionItems.del is wrapped in a log-only catch, then the update unconditionally writes active:false, stripeItemId:null and returns 200. Enable has the mirror flaw: a failed create still activates with stripeItemId null.

**The gap:** On a Stripe failure the tenant is billed for a feature they lost (or gets a paid add-on free), and the only stored si_ id is erased.

**Evidence:** apps/api/src/billing/addon.service.ts:178-189 (log-only catch on del), :191-194 (unconditional {active:false, stripeItemId:null}), :123-139 (enable-side catch with "Continue — don't block" comment), :143-157 (upsert writes null/undefined stripeItemId); apps/api/prisma/schema.prisma:562 (TenantAddon.stripeItemId is the sole store — grep shows no reconciliation/webhook reads it anywhere); apps/api/src/platform-admin/platform-admin.controller.ts:336-349 and :321-334 (results returned with no failure signal).

**Suggested fix:** Only null stripeItemId after a successful (or already-deleted, resource_missing) Stripe delete; on other failures keep the id, mark the row pending-removal, and surface the error to the admin. Mirror the guard on enable.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
