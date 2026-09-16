# Lite plan (invite-only, $99/mo) — cross-cutting, 2026-09-15

Split out of `feature-modules-4.md` when it hit the 100,000-byte area cap with zero headroom
(precedent: `api/returns-inline.md`). Cross-cutting: touches `billing/`, `estimates/`,
`recurring-invoices/`, `credit-notes/`, `suppliers/`, `messages/`, `customers/` — see each
module's own part file (`feature-modules-1.md` through `-6.md`) for the module itself; this file
covers only what the Lite lane added on top.

- **Lite-L2 (2026-09-15, WP1-WP13)** — invite-only LITE plan ($99/mo, below STARTER) + 5
  newly-enforced flags (`flag.{estimates,recurring_invoices,credit_notes,suppliers,messaging}`,
  see `pricing-plans.md` §Feature-flag keys). Migration `20260915000000_tenant_plan_lite`.
  `plan-catalog.constants.ts`: `INVITE_ONLY_PLAN_KEYS`/`ALWAYS_ENFORCED_PLAN_KEYS`/
  `inviteOnlyCheckoutAllowed()`; `PLAN_KEYS` leads `"LITE"`. New `plan-flag-policy.ts` (dark-flag
  policy split out of `plan-flag.guard.ts`; REMOVE by 2026-10-01). Invite-only refused on
  `subscribe`/`upgrade`/`downgrade` and hidden from the public catalog; `getSubscription()`
  gains `flags`/`paymentRequired`; new no-body `POST /billing/subscription/checkout`. New v12
  catalog (`plan-catalog-v{11,12}.definitions.ts`, `publish-plan-catalog-v12.ts`,
  `db:publish:catalog:v12`) adds LITE + the 5 flags catalog-wide; those 5 flags' controllers
  (`estimates`, `recurring-invoices`, `credit-notes`, `suppliers`, `messages`) + `customers`'
  portal endpoints gained a matching `PlanFlagGuard`/`RequirePlanFlag`. Specs:
  `estimates.plan-gate.spec.ts`, `recurring-invoices.plan-gate.spec.ts`,
  `credit-notes.plan-gate.spec.ts`, `suppliers.plan-gate.spec.ts`, `messages.plan-gate.spec.ts`,
  `customers.portal-plan-gate.spec.ts`, `plan-flag-guard-module-import.spec.ts`.
- **WP14 / B445 (2026-09-15) — `onCheckoutCompleted`'s upsert never wrote `planKey`** (create
  branch read the wrong metadata key — `metadata.plan`, always undefined; checkout stamps
  `metadata.planKey` — so neither branch wrote `planKey`), starving `emitPayingDelta`/billing-cron's
  MRR filter forever. Pre-existing prod defect; Lite's self-checkout just depends on it. Fix:
  `resolvedPlanKey = metadata.planKey ?? metadata.plan ?? null`; `resolvedBasePrice` via
  `this.pricing.resolveCatalogPricing(tenantId)`, try/catch'd (webhook must never throw
  uncaught). Create writes both fields unconditionally; UPDATE uses present-only spreads (never
  null-overwrites an existing value). **No new idempotency mechanism** — the existing
  `transitionAndEmit` CAS is still the only gate. No backfill. Spec: `billing.service.spec.ts`'s
  `onCheckoutCompleted — B445` describe.
