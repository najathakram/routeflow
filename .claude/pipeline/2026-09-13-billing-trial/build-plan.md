# Billing self-serve: trial cancel (TRIAL-1) + read-only visibility (RO-1) — S0–S3 digest

Lane from routeflow-fb 2026-09-13 (K-HUB comparison): two self-inflicted revenue wounds. Scope
here: S0 confirm · S2 design · S3 red tests. **STOP before the fix round** (lead ruling: no
second PR in flight during the W18 train; #710's bookkeeping takes priority). Ids unfiled —
neutral tags `TRIAL-1` / `RO-1` until routeflow-0d mints after W18. Money carve-out: billing code →
Opus refute-first review mandatory when built. Branch `fix/trial-cancel-readonly` off master
`2d353752`, worktree `rf-billing-trial`. Evidence pack (read-only, file:line quoted):
`local scratch billing-trial-pack.md` (18.8 KB) — key facts restated below.

## S0 — confirmed in code

- `tenants.service.ts:85-140` `register()` and `platform-admin.service.ts:212-252` `createTenant()`
  write `Tenant{status:"TRIAL", plan:"STARTER", trialEndsAt}` + `TenantConfig` + `ExpenseCategory[]`
  - admin `User` in one `$transaction` — **no `TenantSubscription` row** (all four writers of that
    row are subscribe / Stripe webhook / customer-cap grace / platform-admin actions).
- `subscription-mutation.service.ts:749-752` `cancel()`: `findUnique({ where: { tenantId } })` →
  `NotFoundException("No subscription to cancel.")` when null; `resume()` identical (:782-798). The
  only `cancel()` test always supplies a row; `tenants.service.spec.ts` does not exist.
- Trial-ness lives on `Tenant.status === "TRIAL"` + `trialEndsAt`; `TenantSubscription` has no
  status column and no trial field except `trialConvertedAt`.
- `READ_ONLY` is `Tenant.status` (`TenantStatus` enum), written only by `billing-cron.service.ts`
  `expireTrials()` (`readOnlyReason: "trial_expired"`) and `applyScheduledCancellations()`
  (`"subscription_cancelled"`); enforced by `TenantStatusGuard.assertAllowed()` (403
  `{ code: "READ_ONLY" }`, GET/HEAD/OPTIONS + `/auth/*` + billing subscribe/subscription exempt).
- The web receives the raw enum in `GET /billing/subscription` `status` (`entitlements.service.ts:226`)
  and renders it only as `<Badge label={s.status} />`; `TrialBanner` exists for the pre-expiry case
  only; `git grep READ_ONLY -- apps/web apps/mobile packages` is empty; a blocked write surfaces as
  the generic `MutationCache.onError` toast (`providers.tsx:16-39`), no persistent banner, no CTA.
- **Interaction:** an expired trial (READ_ONLY) has `status !== "TRIAL"`, so the Cancel button
  renders (`billing/page.tsx:223-236`) and its click hits the same 404 → raw toast "No subscription to
  cancel."

## S2 — design (Fable ruling)

### TRIAL-1 — "cancel" for a tenant without a subscription row means _end the trial now_

- `cancel()` when no row: read `Tenant{status, trialEndsAt}`; `TRIAL` → `tenant.update({ status:
"READ_ONLY", readOnlyReason: "trial_cancelled", trialEndsAt: now })`, emit the billing event
  (new constant `TRIAL_CANCELLED` beside `TRIAL_EXPIRED` if the mutation service already emits
  events; else skip), invalidate the entitlements + tenant-status caches exactly as
  `expireTrials()` does (only if those services are already injected — no `billing.module.ts`
  change; a TTL-stale guard read is acceptable and documented otherwise), resolve
  `{ cancelled: "trial" }`; `READ_ONLY` → resolve `{ cancelled: "already_read_only" }`, no write;
  any other status without a row → the existing 404 (a genuine anomaly, e.g. an ACTIVE tenant whose
  row is missing). `resume()` unchanged (a cancelled trial is restored by subscribing).
- NOT done, deliberately: creating a `TenantSubscription` row at `register()`/`createTenant()`
  (would change `EntitlementsService.resolve()`'s no-row fallback for every new tenant — a separate
  decision) and any backfill (data repair → DECIDE-30 (a) FAIL).
- **Lead ruling (fb, 2026-09-13): the no-row state is TEMPORARY.** The platform back-office Phase 0
  plan (`docs/superpowers/plans/2026-09-12-backoffice-phase-0-truth.md`, fb's, not started) carries
  a subscription-reconciliation script that creates the missing rows under owner sign-off on a
  dry-run diff (the same absence splits MRR into $499-vs-$0 on the admin dashboard). The target
  convention — every tenant carries a `TenantSubscription` row — is reached by that reconciliation,
  never by changing `register()` under a bug fix. Therefore the fix keys on **`Tenant.status`, not
  on row presence**, and is idempotent in both worlds: TRIAL → end the trial now (tenant →
  READ_ONLY/`trial_cancelled`; if a row exists, also `cancelAtPeriodEnd: true` so the row agrees);
  READ_ONLY without a row → no-op success, READ_ONLY with a row → the existing schedule path;
  any other status without a row → the existing 404 — **revisit when Phase 0 reconciliation lands:
  that case should become unreachable, not stay a 404 forever.** No new code path may assume
  no-row is the steady state.
- Invariants: no schema change; no new endpoint (same `POST /billing/subscription/cancel`,
  TENANT_ADMIN); one-armed transition untouched for ACTIVE tenants WITH a row.

### RO-1 — the read-only state is visible and actionable

- API: `GET /billing/subscription` gains `readOnlyReason: string | null` (from the tenant row;
  `entitlements.resolve()` carries it or `SubscriptionService` reads it) — additive DTO field.
- Web `settings/billing/page.tsx`: `ReadOnlyBanner` (mirror of `TrialBanner`) when
  `status === "READ_ONLY"`: heading "Your workspace is read-only"; body by reason —
  `trial_expired` "Your trial ended. Exports still work; subscribe to restore full access." /
  `subscription_cancelled` "Your subscription ended. …" / `trial_cancelled` "You ended your trial. …";
  CTA "Choose a plan" → `/choose-plan`. Cancel hidden when READ_ONLY; during TRIAL an **"End trial"**
  button (confirm dialog: "Your workspace becomes read-only now; exports still work") calls the same
  cancel mutation; ACTIVE keeps Cancel.
- Dashboard-wide: a persistent read-only banner in the dashboard shell if it has a banner slot
  (T3 manual row); `providers.tsx` gets `READ_ONLY` in `HANDLED_CODES` so the blocked-write toast
  carries a "Choose a plan" action instead of the bare guard message (T3 manual row).

## S3 — red tests (committed on this branch)

| Tag     | Test                                                                 | File                                    | Red today                        |
| ------- | -------------------------------------------------------------------- | --------------------------------------- | -------------------------------- |
| TRIAL-1 | cancel() on a trial tenant with no row ends the trial into READ_ONLY | `subscription-mutation.service.spec.ts` | 404 "No subscription to cancel." |
| TRIAL-1 | cancel() on a read-only tenant with no row is an idempotent success  | same                                    | 404                              |
| TRIAL-1 | cancel() on an ACTIVE tenant with no row still 404s (guard)          | same                                    | green (guard)                    |
| TRIAL-1 | cancel() with a row still schedules cancelAtPeriodEnd (guard)        | same                                    | green (guard)                    |
| RO-1    | subscription view carries readOnlyReason                             | `subscription.service.spec.ts`          | field undefined                  |
| RO-1    | read-only tenant sees the banner + Choose-a-plan link, no Cancel     | `billing-page.test.tsx` (web)           | no banner text                   |
| RO-1    | trial tenant sees End trial                                          | same                                    | no button                        |
| RO-1    | active tenant still sees Cancel (guard)                              | same                                    | green (guard)                    |

### Design-fit facts from S3 (reduce the build)

- `SubscriptionMutationService` already injects `entitlements: EntitlementsService` and
  `tenantStatus: TenantStatusGuard` (`subscription-mutation.service.ts:132-140`) — the cache
  invalidation in TRIAL-1 needs no `billing.module.ts` change (no L-115 boot proof needed).
- `apps/web/app/(dashboard)/layout.tsx:1399` renders `<ImpersonationBanner />` above `<Header>` —
  the slot for the dashboard-wide read-only banner (T3 manual row).
- `SubscriptionView` (`apps/web/lib/api/billing.ts:52-66`) has no `readOnlyReason` yet — the fix
  adds the field to the shared view type alongside the API DTO.
- `subscription.service.spec.ts` already exists (inline mocks, no shared `make()`); the RO-1 api
  test appends to its `getSubscription` describe.

## DECIDE-30 conditions at build time

(a) no data repair — PASS by design · (b) no migration — PASS · (c) Opus refute-first review —
REQUIRED (billing = money carve-out) · (d) REG red on the wrong value — the rows above.

## Manual verification (T3, at build time)

| Tag     | Check                                                                                      | Expected                                                                                |
| ------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| RO-1    | dashboard shell banner for a READ_ONLY tenant; blocked-write toast carries "Choose a plan" | persistent banner on every dashboard page; toast action navigates to `/choose-plan`     |
| TRIAL-1 | "End trial" from the billing page on a `test`-tenant trial                                 | confirm dialog → workspace read-only, exports work, banner shows "You ended your trial" |

## TO FILE (after W18, by routeflow-0d)

- TRIAL-1 (high): a trial tenant cannot cancel — no subscription row, `cancel()` 404s; expired
  trials show Cancel and get the raw 404 toast.
- RO-1 (high): READ_ONLY is invisible in the web app — no banner, no CTA, no handled toast.
- (Not a TO FILE — lead decision, Phase 0:) the register/subscribe row convention is settled by the
  back-office Phase 0 reconciliation plan above; only TRIAL-1 and RO-1 are filed.

## Lead rulings 2026-09-13 (fb)

1. Never push a red-tests-only branch (a merge-train accident); committed locally satisfies the
   no-uncommitted-work rule. 2. Proceed to the fix round now — Opus refutation mandatory (money
   carve-out), fix, then HOLD before the push; the PR opens only after #710 merges and its
   bookkeeping follow-up lands. 3. Correct in both worlds (row / no row), see S2. 4. Row convention
   = Phase 0, not a registry item.

## Fix round 1 (committed `51daea36` api · `3c06e734` web · `bca9b5cc` docs) → Opus refutation

Round-1 build: Sonnet api + web fixers off the S2 contract; api 77/77 + 6/6 (+ entitlements 18,
cron 11), web 3/3 + full 58 suites/504, check-types clean both. Opus (refute-first, C1–C7)
**refuted C1, C3, C7** and confirmed C2, C4-enforcement, C5, C6a/b/d:

| Id  | Sev          | Finding (file:line)                                                                                                                                                                                                                                           | Ruling (Fable)                                                                                                                                                                                                                                                                |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | BLOCKER      | `/choose-plan` fires `POST /billing/quote` (`choose-plan/page.tsx:72-78`) which `TenantStatusGuard` does not exempt (`tenant-status.guard.ts:135-138`) → 403 → `clearPreview` → `commit()` early-return; the new READ_ONLY toast's "Choose a plan" CTA loops. | Exempt `POST /billing/quote` (read-only classifier) + REG in the guard spec.                                                                                                                                                                                                  |
| F2  | MUST         | TRIAL branch armed `cancelAtPeriodEnd` on the row → billing page shows "Cancellation scheduled / Keep my plan" (`page.tsx:163-177`, no status gate) → `resume()` clears the flag, tenant stays READ_ONLY, false `SUBSCRIPTION_RESUMED` ledger row.            | **Refines ruling 3:** the TRIAL branch leaves the row UNTOUCHED (the sweep filters ACTIVE, so the flag could never fire anyway). Gate "Keep my plan" on `status !== READ_ONLY`.                                                                                               |
| F3  | MUST (money) | `ensureStripeCustomer()` mints a row on a TRIAL tenant (`billing.service.ts:168-176`); end-trial then arms the flag; `onCheckoutCompleted` clears only the downgrade fields → paying tenant churned at period end (−MRR) while Stripe keeps invoicing.        | Closed by F2's ruling (no flag written). The pre-existing `onCheckoutCompleted`-does-not-clear-`cancelAtPeriodEnd` gap is already noted in the api code map (F18) — not this lane.                                                                                            |
| F4  | MUST         | Status read outside the transaction, `tenant.update` unconditional inside → a concurrent `subscribe()`/webhook is overwritten to READ_ONLY; double-cancel emits two events.                                                                                   | CAS: `tx.tenant.updateMany({ where: { id, status: "TRIAL" } })`; `count ≠ 1` → re-read: READ_ONLY → `already_read_only`, else `ConflictException`.                                                                                                                            |
| F5  | MUST         | "with a row still schedules" guard is vacuous (`make()` defaults `tenantStatus` TRIAL → exercises the new branch). Missing REGs listed.                                                                                                                       | Spec rewritten: explicit status in every case; 8 cases incl. ACTIVE+row legacy path, TRIAL+row row-untouched, READ_ONLY+row, both CAS outcomes; web: READ_ONLY+`cancelAtPeriodEnd` no resume control, End trial → confirm → `cancel.mutate` once, OPERATOR sees no End trial. |
| F6  | SHOULD       | READ_ONLY **with** a row fell through to the legacy path → re-armed flag + a fresh `SUBSCRIPTION_CANCELED` row per call.                                                                                                                                      | READ_ONLY → `already_read_only` regardless of row (short-circuit first).                                                                                                                                                                                                      |
| F7  | SHOULD       | `readOnlyReason` never cleared: `subscribe()` and `transitionAndEmit` write `status` only → RO-1 ships a stale reason to an ACTIVE tenant.                                                                                                                    | `readOnlyReason: null` beside every `status: "ACTIVE"` write in both.                                                                                                                                                                                                         |
| F8  | NIT          | "End trial" rendered for OPERATOR (API 403s); unused `trialEndsAt` select; `platform.prisma:187` event-type comment stale.                                                                                                                                    | Gate the button on the page's admin predicate; drop the select; the schema comment stays (no schema-folder touch in a fix PR).                                                                                                                                                |

Round 2 = Sonnet api + web fixers on the rulings above, then Opus refutation round 2 on the
delta. Deviation from lead ruling 3 (row write dropped) reported to fb with the F2/F3 evidence —
**fb overturned ruling 3 (2026-09-13): leave the row untouched.** fb also **transferred F1 to this
lane**: the `POST /billing/quote` exemption was task 7 of the Phase 0 plan
(`docs/superpowers/plans/2026-09-12-backoffice-phase-0-truth.md`, READ_ONLY allowlist gap); fb
strikes it there and cites this PR; nobody else touches `tenant-status.guard.ts` until this lands.

## Fix round 2 (committed `a1466890` api · `798f872c` web · `8c1fe5de` docs) → Opus round 2

**Verdict: SHIP-READY, hold pending #710.** F1–F8 all CLOSED with traces (F7 partially — see N2);
seven regression shapes walked against the specs (revert CAS→`update`, emit on lost CAS, return
instead of throw on CAS-lost-ACTIVE, re-arm the row, drop the quote exemption, drop the READ_ONLY
status gate, drop `isAdmin`) — each caught. Notable confirmations: CAS re-read is sound under
Postgres READ COMMITTED (fresh per-statement snapshot after the blocked `updateMany`); `cancel()`
never reached Stripe in any revision (`stripe.service.ts cancelSubscription` has zero call sites),
so the READ_ONLY no-op skips nothing that mattered; SUSPENDED/CANCELLED tenants are 403'd by the
guard on every method before any controller, so the quote exemption is READ_ONLY-only and the
no-row 404 for those statuses is dead code; `/choose-plan` end-to-end for READ_ONLY verified
(GETs → quote → `SUBSCRIBE` for any non-ACTIVE tenant → `POST /billing/subscribe`, all exempt).

| Id  | Sev             | Finding                                                                                                                                                                                                                      | Disposition                                                                                             |
| --- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| N1  | SHOULD (test)   | `subscribe()`'s new `readOnlyReason: null` had no pinning assertion (only a loose `toMatchObject`).                                                                                                                          | FIXED pre-hold: explicit assertion in the subscribe describe (`subscription-mutation.service.spec.ts`). |
| N2  | SHOULD (F7)     | `platform-admin.service.ts` `updateStatus()` / `activateManualSubscription()` / `extendTrial()` still leave a stale `readOnlyReason`; cosmetic (every READ_ONLY entry path rewrites it; banner only renders when READ_ONLY). | TO FILE (out of lane). Code-map row reworded (N3).                                                      |
| N4  | NIT             | CAS re-read returning `null` (row gone) → 409 not 404; unreachable (`deleteTenant` sets CANCELLED, guard 403s).                                                                                                              | Note only.                                                                                              |
| N5  | NIT (pre-exist) | `Cancel` and both `resume()` controls on the billing page are still ungated for OPERATOR (API 403s) — now inconsistent with the admin-gated End trial.                                                                       | TO FILE.                                                                                                |
| —   | pre-existing    | Self-serve `cancel()` never reaches Stripe: an admin-provisioned Stripe subscription keeps invoicing a READ_ONLY tenant and `onPaymentSucceeded` resurrects it to ACTIVE.                                                    | TO FILE (orthogonal; untouched by this diff).                                                           |

## TO FILE (after W18, by routeflow-0d) — consolidated

1. TRIAL-1 (high) · 2. RO-1 (high) — as above. 3. `onCheckoutCompleted` clears only the downgrade
   fields, never `cancelAtPeriodEnd` (api code-map F18 note says "filed as a new bug" — verify a row
   exists; else file). 4. N2 platform-admin status writers leave a stale `readOnlyReason` (low). 5. N5
   billing-page Cancel/resume controls ungated for OPERATOR (low, pre-existing). 6. Self-serve
   `cancel()` never cancels the Stripe subscription (admin-provisioned Stripe sub keeps invoicing a
   READ_ONLY tenant; `onPaymentSucceeded` resurrects it) — medium, money — **FIXED on this branch
   as STRIPE-CANCEL-1; exposure at time of fix: ZERO** (owner-approved read-only prod aggregate
   2026-09-13: `count(*) FROM "TenantSubscription" WHERE "stripeSubId" IS NOT NULL` = 0, hence 0
   with `cancelAtPeriodEnd = true`; Stripe checkout has never been exercised in production — the
   code path was live, the real-world exposure nil; no tenant was ever wrongly invoiced; no data
   repair needed). 7. Spec files are excluded from `tsc` (`apps/api/tsconfig.json`,
   `tsconfig.build.json`; Jest transpile-only) — `billing.service.spec.ts` `make()` passes 5 of 6
   `BillingService` ctor args silently (tooling, low). 8. CANCELLED is a UI dead end (Opus
   STRIPE-CANCEL-1 F5): the guard 403s every method incl. GET, `ReadOnlyBanner` renders only for
   READ_ONLY, no resubscribe CTA, `/choose-plan`/`subscribe()` unreachable; only platform-admin
   `updateStatus` restores — with STRIPE-CANCEL-1 a self-serve-cancelled Stripe tenant now ends
   there (fb: correct terminal state) (medium, UX). **fb ruling — file as a GATING PRECONDITION, not
   a UI gap: "Do not enable Stripe checkout for any real tenant until CANCELLED has a path back
   (self-serve resubscribe, or at minimum read-only data access + a support CTA)."** Rationale:
   this fix makes a total-lockout state (403 on GET — the tenant cannot see or export their own
   invoices/data, which cuts against the data-export position vs K-HUB's 30-day-deletion terms)
   reachable by a self-service click; zero tenants today, real the moment someone completes a
   Stripe checkout. Whoever first generates a Stripe checkout link for a customer must trip over
   this item. The PR body carries that sentence verbatim. 9. A READ_ONLY tenant with a live Stripe sub
   (legacy cohort — zero in prod today) is signalled only by the `STRIPE-CANCEL-1` warn in
   `onPaymentSucceeded`; `cancel()` returns `already_read_only` before any Stripe call, so they
   have no self-serve way to stop the charge — needs an alert/report, not a log line (Opus F6;
   low while the cohort is empty). 10. `cancel()`'s TRIAL branch never reaches the Stripe block: a
   TRIAL tenant with a live `stripeSubId` — reachable only via platform-admin `extendTrial()` on a
   checkout-provisioned ACTIVE tenant (`platform-admin.service.ts:1054-1062` sets `status: TRIAL`
   on any tenant) — ends the trial locally while Stripe keeps invoicing (STRIPE-CANCEL-1 on a
   second branch; Opus round-2 finding 1; zero exposure; inside the #8 gating precondition;
   case (5) pins today's behaviour on purpose) (low-med, money).

## STRIPE-CANCEL-1 (owner-directed via fb, 2026-09-13 ~12:00Z — built on this branch, same PR)

**Defect (pre-existing, found by Opus round 2, reachability traced):** self-serve `cancel()`/`resume()`
write `cancelAtPeriodEnd` locally and never call Stripe; `stripeSubId` exists only for tenants
provisioned through a super-admin checkout link (`onCheckoutCompleted` is the sole writer). Such a
tenant keeps being invoiced after cancelling; the cron makes it READ_ONLY (−MRR); the next
`invoice.payment_succeeded` → `onPaymentSucceeded` → `transitionAndEmit({ status: { not: "ACTIVE" } }
→ ACTIVE, +MRR)` resurrects it without reading `cancelAtPeriodEnd`, and `disarmedDowngrade()` leaves
the flag armed → monthly READ_ONLY↔ACTIVE flap with ±MRR pairs while Stripe charges every cycle.

**S2 ruling (Fable, lead-approved scope):** (a) real fix — `cancel()` legacy path and `resume()`
call `stripe.updateSubscription(stripeSubId, { cancel_at_period_end: true|false })` BEFORE the
local transaction (Stripe is the billing truth; a DB failure after a Stripe success self-heals via
`onSubscriptionDeleted`, the reverse order leaves a cancelled tenant being charged); B107 error
semantics — generic failure → `ServiceUnavailableException`, nothing written, no event;
`resource_missing` → cancel proceeds locally (nothing left to stop), resume → `ConflictException`
(nothing to resume); `stripeSubId: null` tenants byte-identical; the TRIAL/READ_ONLY branches never
touch Stripe. (b) defence in depth — `onPaymentSucceeded` refreshes period dates but, when
`cancelAtPeriodEnd` is armed, logs a `STRIPE-CANCEL-1` warn and returns without reinstating, without
a ledger delta and without `disarmedDowngrade()`. (c) NO data repair: no backfill, no self-healing
Stripe call from the webhook, `onCheckoutCompleted`/`onSubscriptionDeleted`/crons untouched — tenants
already in the loop are the owner's reconciliation decision once prod numbers exist.
`StripeService` becomes the 8th ctor dependency of `SubscriptionMutationService` (already provided by
`BillingModule`; `app-module-compile.spec.ts` guards the DI scope).

**Known consequence for the reviewer:** with (a), a self-serve-cancelled Stripe tenant reaches
period end via Stripe's `customer.subscription.deleted` → `onSubscriptionDeleted` → CANCELLED (hard
block, the existing terminal path) — whereas the cron alone would leave it READ_ONLY (exports work).
Which one wins depends on ordering; the tenant ends CANCELLED either way because the `!churned`
branch sets CANCELLED unconditionally. Pre-existing semantics of Stripe-deleted subscriptions;
flagged, not changed here. **fb ruling:** correct, not a regression — a genuinely cancelled
subscription should reach a real terminal state; the bug was that it never resolved at all. Opus
must additionally check whether a CANCELLED tenant has ANY path back in (resubscribe CTA, support
contact) or lands on a UI dead end — a gap is a TO FILE item, not built in this PR.

**Tests (red-first):** STRIPE-CANCEL-1 ×9 in `subscription-mutation.service.spec.ts` (Stripe called
once, before the write, with the right flag; 503 + no write on failure; `resource_missing` cancel
proceeds / resume 409; TRIAL branch never calls Stripe; null `stripeSubId` untouched) + ×2 in
`billing.service.spec.ts` (armed flag → no reinstatement, warn logged; unarmed → reinstates).
Gates: Opus refute-first → fix → re-review; commit, HOLD, ping fb "STRIPE-CANCEL-1 ready, holding".

### STRIPE-CANCEL-1 round 1 (`7c0d162c` api · `2d6aa80b` docs) → Opus refutation: NOT SHIP-READY

Opus confirmed the ordering (C1: a DB failure after a Stripe success self-heals — `onSubscriptionUpdated`
re-arms the same values, `onSubscriptionDeleted` books −MRR at most once via the ACTIVE CAS), the DI
path (C7: single provider, `app-module-compile` green), logging/copy safety (C8), and that the guard
skipping `disarmedDowngrade()`/cache invalidation is safe (C3 iii/iv). It REFUTED C2, C3(i), C5:

| Id  | Sev     | Finding                                                                                                                                                                                                                                                                                                  | Ruling (Fable)                                                                                                                                                                                                                    |
| --- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | MUST    | `resume()` called Stripe for ANY row with a `stripeSubId`, no status check → a READ_ONLY tenant with a live Stripe sub (legacy cohort; route allowlisted for READ_ONLY; the downgrade-undo control is gated only on `downgradeToPlanKey`) makes Stripe RESUME charging while the tenant stays read-only. | `resume()` reads `tenant.status`; Stripe called only when `stripeSubId && cancelAtPeriodEnd === true && status === "ACTIVE"`. Local clear + `SUBSCRIPTION_RESUMED` unchanged.                                                     |
| F2  | MUST    | `resume()` sent `cancel_at_period_end: false` even when the local flag was already false (undoing a DOWNGRADE) → silently revokes a cancellation made in the Stripe customer portal that the local row never learned about (only `onSubscriptionUpdated` syncs, no ordering guard).                      | Same gate (`cancelAtPeriodEnd === true`). Not an extra round trip — a money direction bug.                                                                                                                                        |
| F3  | SHOULD  | The payment guard refused reinstatement for ANY armed tenant → a SUSPENDED (past-due) tenant who scheduled a cancel and then PAID stays SUSPENDED (hard 403 incl. exports) for a period they paid for; nothing else moves them.                                                                          | Narrow the guard to executed cancellations: armed AND status ∈ {READ_ONLY, CANCELLED}. SUSPENDED + armed reinstates as before; Stripe (now told) ends the sub at period end.                                                      |
| F4  | SHOULD  | 503 copy "nothing was changed" is false on a timeout Stripe actually applied (local self-heals via `onSubscriptionUpdated`, but the sentence lies).                                                                                                                                                      | Reword: "The payment provider did not confirm the change — it may or may not have been applied. Refresh to check before retrying, or contact support."                                                                            |
| F5  | TO FILE | CANCELLED is a genuine UI dead end (guard 403s every method incl. GET; no banner; no CTA; only platform-admin `updateStatus`). fb: correct terminal state.                                                                                                                                               | TO FILE #8, not built here.                                                                                                                                                                                                       |
| F6  | TO FILE | Legacy READ_ONLY-with-live-Stripe cohort (zero in prod) is signalled only by a warn; `cancel()` short-circuits before any Stripe call, so no self-serve way to stop the charge.                                                                                                                          | TO FILE #9 (alert/report).                                                                                                                                                                                                        |
| F7  | TO FILE | `billing.service.spec.ts` `make()` passes 5 of 6 `BillingService` ctor args; spec files excluded from `tsc`.                                                                                                                                                                                             | TO FILE #7.                                                                                                                                                                                                                       |
| C6  | gaps    | `isStripeResourceMissing` widening only probed with a code-less Error; no case for resume-with-flag-false, resume-on-READ_ONLY, cancel-on-SUSPENDED.                                                                                                                                                     | Red-first REGs (10)–(16) added in round 2.                                                                                                                                                                                        |
| fb  | lead    | The `stripeSubId == null` branch is 100% of real cancels today (0 Stripe subs in prod) — the regression that matters is "did the Stripe call change anything for a tenant with no `stripeSubId`", incl. a Stripe outage making them uncancellable.                                                       | Red-first (17)/(18): cancel/resume with `stripeSubId: null` under a HOSTILE Stripe mock (rejects + `isConfigured=false`) → identical writes/events/return, Stripe never invoked. Named Opus round-2 item with boot-path evidence. |

Round 2 = Sonnet api fixer on R1–R5 above, then Opus round 2 on the delta (named items: null-branch
byte-identical + outage-proof + boot path; resume gate; narrowed guard; copy).

### STRIPE-CANCEL-1 round 2 (`9550b675` api · `5a222c0b` docs) → Opus round 2: SHIP-READY

F1–F4 CLOSED and pinned (cases 11/12, R2 SUSPENDED case, verbatim 503 copy); C6 gaps closed; N1
null branch byte-identical for `cancel()` and outage-proof for both (hostile-mock cases 17/18; the
single `if (sub.stripeSubId)` gate; `StripeService` boots without a key; `app-module-compile` 1/1);
N2 gate matches the mock, null tenant → skip (safe direction); N3 the `include` is inert
(`transitionAndEmit`/`emitPayingDelta` read only `planKey/basePriceSnapshot/discount`; the relation
is required; SUSPENDED arc nets zero MRR; TRIAL+armed unchanged); N5 every regression shape named
to its case. Three LOW findings, all latent behind the gating precondition (0 prod `stripeSubId`):

| Id  | Sev     | Finding                                                                                                                                                                                                                                                                                                               | Ruling (Fable)                                                                                                                                                                                                                |
| --- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | LOW-MED | `cancel()`'s TRIAL branch returns before the Stripe block, so a TRIAL tenant with a live `stripeSubId` — reachable only via platform-admin `extendTrial()` on a checkout-provisioned ACTIVE tenant — cancels locally while Stripe keeps invoicing (the defect on a second branch; F6/#9 covers READ_ONLY, not TRIAL). | TO FILE #10 beside #9 (scope creep to touch the TRIAL branch here; zero exposure; inside the gating sentence). Case (5) pins the current behaviour deliberately.                                                              |
| 2   | LOW     | `resume()`'s null-`stripeSubId` branch gained an unconditional second query (`tenant.findUnique`) — not query-identical to pre-fix; a pool timeout on that read would 500 a resume that used to succeed.                                                                                                              | Round 3: scope the tenant read inside `if (stripeSubId && cancelAtPeriodEnd === true)`; pin "no tenant read on the null branch" in cases 9/18. (fb's "changed nothing for tenants with no `stripeSubId`" made this in-scope.) |
| 3   | LOW     | 503 copy "Refresh to check" is only true once `customer.subscription.updated` lands; ~140 chars renders as a 5-line toast title.                                                                                                                                                                                      | Round 3: "The payment provider did not confirm the change — it may still apply. Check your subscription in a moment before retrying, or contact support." + resume-side `statusCode: 500` REG.                                |

Round 3 = Sonnet mechanic on 2 + 3, narrow Opus re-check, docs commit, ping fb.

### STRIPE-CANCEL-1 round 3 (`2c29917d` api) → Opus narrow re-check: SHIP-READY

V1 `resume()`'s null-`stripeSubId` branch is byte-identical to pre-fix (`f3165963` lines 870-886:
same read, NotFound, transaction data, emit, return; zero extra queries; the tenant read sits
inside `if (stripeSubId && cancelAtPeriodEnd === true)`, pinned by cases 9/18). V2 Stripe branch
unchanged vs round 2 (armed + ACTIVE → once, before the write; READ_ONLY → skipped; flag false →
skipped). V3 copy identical at both 503 sites, verbatim-asserted; 97/97. V4 `check-types` +
prettier clean, no raw errors logged, neutral fixtures. One LOW test-hardening gap applied
post-verdict (Fable, two assertion lines): case 11 also asserts `prisma.tenant.findUnique` is NOT
called (a refactor to `if (stripeSubId) { read; … }` would otherwise slip past cases 9/18), and
the resume happy path asserts `toHaveBeenCalledTimes(1)`.

**STRIPE-CANCEL-1 final:** `7c0d162c` → `9550b675` → `2c29917d` (+ the two-assertion hardening
commit). Three Opus rounds (NOT SHIP-READY → SHIP-READY w/ LOWs → SHIP-READY). TO FILE #6–#10.
HOLD — ping fb "STRIPE-CANCEL-1 ready, holding".

## Pre-push checklist (when #710 + its bookkeeping have landed)

1. `git fetch` + rebase onto master (expect LESSONS.md/ARCHIVE.md/`_meta.json` adjacency
   conflicts with #708 — same archive pair, keep L-120 + its numbering; code-map `_meta.json`
   notes/mappedSha). 2. `npm ci` if the lockfile moved; `npx prisma generate`. 3. Compose boot
   gate (`npm run local:up` → `local:seed` → `local:validate`) — the W16 rule; then the T3 manual
   rows above on the `test` tenant (End trial → banner + toast action → Choose a plan → subscribe
   restores ACTIVE). 4. `npx turbo run test --force --concurrency=2` (fresh worktree: no cache
   hits or campaign-check goes red). 5. Push through the hook in the FOREGROUND; read git's own
   output before announcing. 6. PR body: neutral tags, Opus rounds 1+2 summary, TO FILE list, F1
   ownership note (Phase 0 task 7 struck by fb). No `Bookkeeping-Follow-Up` trailer — lessons +
   code-map ride this PR. MUST also carry, for STRIPE-CANCEL-1: (i) "zero affected rows at time
   of fix, verified against prod (0 `stripeSubId`, 0 armed cancellations; Stripe checkout never
   exercised in production) — no data repair needed"; (ii) the gating sentence verbatim: "Do not
   enable Stripe checkout for any real tenant until CANCELLED has a path back (self-serve
   resubscribe, or at minimum read-only data access + a support CTA)."

## Lessons HELD for the bookkeeping follow-up (not in the register)

The register is at its byte cap (40/40 entries, 40,957/40,960 B on master after #715) and the
`maxBytes` decision is with the owner, so this PR ships with a `Bookkeeping-Follow-Up: pending`
trailer and these two entries land in its docs follow-up. Lead ruling (fb): do NOT merge them —
the inverse-direction clause in the second is the most reusable thing in either. Drafted verbatim:

### L-120 · 2026-09-13 · domain · billing self-serve (TRIAL-1 / RO-1)

- **Symptom:** every trial tenant's "Cancel" 404'd; an expired trial (READ_ONLY) showed the same
  button, got the same 404, and saw no explanation in the web — a guard-enforced lockout with no UI.
- **Root cause:** `cancel()` keyed on a `TenantSubscription` row `register()` never writes, while
  the real lifecycle state lives on `Tenant.status`; the web rendered that status as a raw badge
  and had no branch for the guard's `READ_ONLY` code.
- **Lesson:** **Key a lifecycle action on the table that owns the state; a sibling row some
  creation path never writes is optional — a missing-row 404 there hides a legitimate transition.
  Every status the API can return and every code a guard can emit needs a UI branch, or the
  lockout is invisible.**
- **Guard:** TRIAL-1 in `subscription-mutation.service.spec.ts` (no-row TRIAL → READ_ONLY,
  READ_ONLY idempotent, ACTIVE no-row keeps 404, with-row unchanged); RO-1 in
  `subscription.service.spec.ts` + `billing-page.test.tsx`.

### L-121 · 2026-09-13 · domain · STRIPE-CANCEL-1

- **Symptom:** a tenant on an admin-provisioned Stripe subscription clicked Cancel; Stripe kept
  invoicing; the cron made it READ_ONLY (−MRR), then the next `invoice.payment_succeeded` lifted
  it back to ACTIVE (+MRR) — a monthly flap with ±MRR pairs while a cancelled customer was charged.
- **Root cause:** `cancel()`/`resume()` wrote `cancelAtPeriodEnd` locally and never called Stripe;
  `onPaymentSucceeded` reinstated ANY non-ACTIVE tenant without reading the local cancellation.
- **Lesson:** **On a provider-billed tenant, write a scheduled billing transition to the provider
  FIRST and locally second — a failed provider call changes nothing, a failed local write
  self-heals off the provider's webhook. Gate the provider call on the state that makes it
  meaningful (a cancellation actually armed, on a tenant actually paying) — a fix for
  over-charging must never be able to START charging. A webhook that promotes status must read
  the local intent it overrides: an EXECUTED cancellation plus a payment is an anomaly to flag,
  never to resurrect; a dunning tenant who pays is reinstated.**
- **Guard:** STRIPE-CANCEL-1 ×15 in `subscription-mutation.service.spec.ts` (called once, before
  the write; resume only when armed + ACTIVE; 503 writes nothing; null `stripeSubId` untouched
  under a hostile mock) + ×4 in `billing.service.spec.ts`. Sibling [[L-120]]; class of B107.
