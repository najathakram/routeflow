# Wave W1 — "money that is wrong today" (build plan / design digest)

Branch `fix/w1-billing-money` off master `3f206e6f` (the post-#714 tree), worktree
`rf-billing-trial`. Money carve-out: red-first per row, ONE in-lane refute, then the lead's
independent `pre-merge-review` pass. Task list: `docs/backoffice/waves/waves.json` wave W1 on
`docs/platform-backoffice-design`. Evidence pack (read-only, file:line per claim) was built
against the pre-merge tree, which is byte-identical to `3f206e6f` for these files.

## Rows and verdicts

| Row                  | Sev    | Verdict from the evidence pack             | In this PR                         |
| -------------------- | ------ | ------------------------------------------ | ---------------------------------- |
| `STRIPE-CANCEL-2`    | high   | CONFIRMED                                  | yes — with `STRIPE-RESUME-1`       |
| `STRIPE-RESUME-1`    | high   | CONFIRMED (a passing test encodes it)      | yes — with `STRIPE-CANCEL-2`       |
| B327                 | high   | CONFIRMED, but it is a MISSING FEATURE     | **no — escalated, see below**      |
| B216                 | high   | PARTIAL — webhooks already fixed on master | yes, shrunk to the admin path      |
| B342                 | medium | CONFIRMED under concurrency only           | yes — a lock, not a check          |
| B218                 | low    | CONFIRMED                                  | yes                                |
| B329                 | low    | CONFIRMED — two bugs                       | yes, landed FIRST as an extraction |
| `ADMIN-UPDATEPLAN-1` | high   | CONFIRMED omission, premise partly wrong   | yes, rescoped — see below          |

## The seam lesson this wave starts from

`STRIPE-CANCEL-2` and `STRIPE-RESUME-1` are both damage from how the previous lane was built, and
the shape is worth naming because it will recur: **round 1 added a READ_ONLY short-circuit for
idempotence; a later round added a Stripe-propagation block; neither round could see that the
short-circuit now sits AHEAD of the propagation.** Same for `resume()`: one round gave the Stripe
call a three-condition gate and left the local write on one condition. Each fix was correct in
isolation and each review round read the diff it was handed. An in-lane reviewer is structurally
blind to this; the independent pre-merge pass found both in one read. Treat "a guard added by an
earlier round" and "a call added by a later round" as a seam to check explicitly whenever a
function is edited twice by different rounds.

## S2 — design per row

### `STRIPE-CANCEL-2` + `STRIPE-RESUME-1` (design together — same state, same file)

The shared state is **a tenant the cron took READ_ONLY whose `TenantSubscription` still carries a
live `stripeSubId`** (`applyScheduledCancellations` produces exactly this cohort).

- `cancel()` (`subscription-mutation.service.ts` ~:790 vs ~:856): the READ_ONLY short-circuit
  returns `{cancelled:"already_read_only"}` before the Stripe block, so Stripe is never told and
  keeps invoicing — and the web hides Cancel for READ_ONLY tenants, so there is no self-serve way
  out. **Fix:** propagate to Stripe FIRST when `sub?.stripeSubId` is set, then short-circuit.
  Fold the currently-unconditional `Promise.all` tenant read into the same restructure (one fewer
  query on the null path; behaviourally identical).
- `resume()` (~:932-969): the Stripe call is gated on `stripeSubId && cancelAtPeriodEnd === true`
  then `tenant.status === "ACTIVE"`, but the local transaction that clears `cancelAtPeriodEnd` and
  emits `SUBSCRIPTION_RESUMED` is ungated. For the shared state, Stripe is correctly skipped and
  the flag is cleared anyway — disarming the exact key `onPaymentSucceeded`'s guard reads
  (`billing.service.ts` ~:633-641), so the next `invoice.payment_succeeded` reinstates the tenant
  ACTIVE with a +1 MRR delta. **Fix:** that combination REFUSES (`ConflictException`, mirroring
  `cancel()`'s own handling) — there is nothing legitimate to resume locally while Stripe was never
  told and the tenant is not paying. **Invariant that must not move:** the scheduled-DOWNGRADE undo
  (`cancelAtPeriodEnd` already false) stays byte-identical.
- **A passing test currently encodes the defect**: `subscription-mutation.service.spec.ts`
  ~:1676-1690 is titled "…never calls Stripe — local clear still happens". It must be rewritten to
  the refusal, not merely extended. A test written to document current behaviour becomes a lie the
  moment a later round changes the invariant; re-read what the tests CLAIM is expected.

### B216 — shrunk to the admin path

Both Stripe webhook reinstatements already call `disarmedDowngrade()` correctly, guarded on the
real CAS (`billing.service.ts` ~:569-579 and ~:658-665 — the latter landed with #714). The live
gap is `platform-admin.service.ts` `updateStatus()`: an admin reactivating a lapsed tenant never
clears an armed downgrade, so it fires later against a paying tenant. **Fix:** clear the same three
fields on the admin reactivation transition, matching the webhook paths' shape.

### B342 — a lock, not a check

Sequential double-enable already throws `ConflictException`; the defect is a race with no lock
around the Stripe-item create + row upsert, so two concurrent enables create two Stripe items and
keep one pointer — double billing with one handle. **Fix:** serialise per `(tenantId, addonKey)`
the way customer-level merges already do (`withAdvisoryLock`, `common/db-locks.ts`), never a second
in-process lock.

### B218 — `planKeyToEnum`'s silent STARTER fallback

An off-catalog published plan key falls back to the STARTER enum shadow, so the tenant silently
gets STARTER entitlements. Blast radius: `subscribe()`, `upgrade()`, and the cron's
`applyScheduledDowngrades()`. **Fix:** fail loudly for an unknown key rather than defaulting;
check each call site for what "loudly" must mean there (a 400 on a client-supplied key, a logged
skip in a cron that must not die on one bad row).

### B329 — land FIRST, as a behaviour-preserving extraction

Two bugs: the period time-of-day is dropped to midnight, and the anchor day permanently ratchets
down after clipping a short February (a 31st anchor becomes 28th forever). The fix unifies the
date helpers across `billing-cron.service.ts` and `subscription-mutation.service.ts` — the same
files rows 1/2/4/6 touch — so it lands as its own commit first to keep those diffs reviewable.

### `ADMIN-UPDATEPLAN-1` — rescoped (the row's premise is partly wrong)

The row says "no proration, no Stripe sync". **The Stripe half is wrong:** both paths are
Stripe-silent for plan changes (`upgrade()`/`downgrade()` never call Stripe either), so there is no
admin-vs-tenant Stripe gap. The real gaps are (i) `updatePlan()` never computes or surfaces a
mid-cycle prorated amount — the tenant path returns `proratedNow` from the private `proratedDiff()`
— and (ii) it applies every change instantly, upgrade and downgrade alike, while the tenant path
deliberately schedules downgrades at period end with no credit.

**Both halves are in this PR — lead ruling 2026-09-13, owner informed:**

- (i) promote `proratedDiff()` to `ProrationService` (inject it into `PlatformAdminService`, which
  does not have it today) and surface the same prorated figure on an admin upgrade.
- (ii) **align admin downgrades to the tenant path — schedule at period end, no credit.** This is a
  deliberate behaviour change, not an omission: the point of B58 was ONE proration model, and today
  the admin path is strictly worse than the tenant path — it can strip a paying tenant's plan
  mid-cycle instantly with no credit. The only admin is the owner, who is being told that "Change
  plan" downgrades now take effect at period end.

No speculative `prorate?: boolean` and no "apply now" option: the DTO carries only `plan`, the
single caller conveys no comp intent, and the admin UI has no field for a charge-today figure. If
an admin ever needs an immediate downgrade, that is an explicit future feature with its own UI.
Four specs in `platform-admin.service.spec.ts` assert today's shape and move with the fix.

## B327 — CONFIRMED, and deliberately NOT fixed here

`suspendOverdueTenants()` (`billing.service.ts` ~:789-846; its grace constant is a LOCAL
`PAYMENT_GRACE_DAYS = 3` at ~:15 — **not** `GRACE_DAYS` in `plan-catalog.constants.ts`, which is 7
and belongs to the unrelated soft-cap meter) filters `stripeSubId: { not: null }`. The self-service
plans-as-data model never sets `stripeSubId`, and there is no other non-payment signal for that
cohort: `TenantSubscription.failedPaymentCount` and `.nextChargeAt` exist in the schema and are
**dead** — zero reads or writes for the former, never persisted for the latter. So every self-serve
tenant is structurally invisible to the suspension cron, and only the legacy Stripe-checkout cohort
(zero tenants in prod) can ever be suspended.

Dropping the filter would suspend tenants that were never charged anything. The prerequisite
question is **how the first five customers are actually being charged today**: if payment is
collected out-of-band, "non-payers are never auto-suspended" is current policy, not a defect, and
auto-suspension would lock out a paying customer on a signal that does not exist. Recommended as a
design row (charge loop + dunning) in the back-office programme, not a W1 bug fix. Awaiting the
lead's ruling; W1 ships without it unless told otherwise.

## Gates

Red-first per row (the REG test fails against `3f206e6f` for the stated reason, recorded).
`B329` first as an isolated extraction. One in-lane Opus refute over the whole diff — with the seam
question asked explicitly: _which guards did an earlier round add, and does a later round's call now
sit on the wrong side of one?_ Then the lead's independent pre-merge pass. Code-map rows go into
#716's split part files once that lands; `validate-code-map.mjs` becomes a push gate at that point.
Lessons: the cap decision landed (#717, master `b2b791a4` — `maxEntries 48` / `maxBytes 49,152`,
after bytes alone left the entry cap binding at 40/40 with nothing eligible to archive). So this PR
carries lessons **directly**, with no `Bookkeeping-Follow-Up` trailer: **L-120 and L-121 verbatim
as drafted** in `.claude/pipeline/2026-09-13-billing-trial/build-plan.md` (they were held out of
#714 only by the cap), plus W1's own entries — at minimum the seam rule above, which is what
`STRIPE-CANCEL-2` and `STRIPE-RESUME-1` are damage from. L-113 stays active. Rebase onto
`b2b791a4` before the register edit so the new caps are in `_meta.json`.

## Lessons HELD for the follow-up PR (not in the register)

The register could not take them at push time: master came back from #719 and #722 at 42 entries /
44.0 KB against a 48.0 KB cap, and this wave's five entries are 5,596 B — over by ~1.2 KB. The lead
ruled (2026-09-14) that no one's live entry gets trimmed to make room and that the cap itself is an
owner escalation (proposal: 49,152 → 65,536 bytes, `maxEntries` unchanged, plus a house rule that an
entry over 1.5 KB is trimmed by its author BEFORE it lands). So this PR carries
`Bookkeeping-Follow-Up: pending` and the five entries land in its docs follow-up once the cap is
ruled on. They are reproduced verbatim below so nothing depends on a session scratchpad.

Id allocation agreed with the lead: 122 = #719, 124 = #722, so this wave holds **123, 125, 126**
alongside the two released by #717 (**120, 121**); next free is 127.

### L-120 · 2026-09-13 · domain · billing self-serve (TRIAL-1 / RO-1)

- **Symptom:** every trial tenant's "Cancel" 404'd; an expired trial showed the same button, got
  the same 404, and saw no explanation — a guard-enforced lockout with no UI.
- **Root cause:** `cancel()` keyed on a `TenantSubscription` row `register()` never writes, while
  the real lifecycle state lives on `Tenant.status`; the web rendered that status as a raw badge
  with no branch for the guard's `READ_ONLY` code.
- **Lesson:** **Key a lifecycle action on the table that owns the state; a sibling row some
  creation path never writes is optional — a missing-row 404 there hides a legitimate transition.
  Every status the API can return and every code a guard can emit needs a UI branch, or the
  lockout is invisible.**
- **Guard:** TRIAL-1 in `subscription-mutation.service.spec.ts`; RO-1 in
  `subscription.service.spec.ts` + `billing-page.test.tsx`.

### L-121 · 2026-09-13 · domain · STRIPE-CANCEL-1

- **Symptom:** a tenant on an admin-provisioned Stripe subscription clicked Cancel; Stripe kept
  invoicing; the cron made it READ_ONLY (−MRR), the next paid invoice lifted it back to ACTIVE
  (+MRR) — a monthly flap while a cancelled customer was charged.
- **Root cause:** `cancel()`/`resume()` wrote `cancelAtPeriodEnd` locally and never called Stripe;
  `onPaymentSucceeded` reinstated ANY non-ACTIVE tenant without reading the local cancellation.
- **Lesson:** **On a provider-billed tenant, write a scheduled billing transition to the provider
  FIRST and locally second — a failed provider call changes nothing, a failed local write
  self-heals off the webhook. Gate the provider call on the state that makes it meaningful (a
  cancellation actually armed, a tenant actually paying): a fix for over-charging must never be
  able to START charging. A webhook that promotes status must read the local intent it overrides —
  an executed cancellation plus a payment is an anomaly to flag, never to resurrect.**
- **Guard:** STRIPE-CANCEL-1 ×15 in `subscription-mutation.service.spec.ts` + ×4 in
  `billing.service.spec.ts`. Class of B107.

### L-123 · 2026-09-14 · process · W1 seam rows

- **Symptom:** an independent pre-merge review found two live defects in code three in-lane
  rounds had passed — a cancel that never reached the payment provider, and a resume that
  cleared the one flag a new guard reads.
- **Root cause:** each round fixed what it was handed. Round 1 added an idempotence
  short-circuit; a later round added a provider call BELOW it; a third gave that call a
  three-condition gate and left the local write on one. Every diff was correct read alone.
- **Lesson:** **When a function is edited by more than one review round, the seam between the
  rounds is where the defect lives: a guard added early can end up ahead of a call added late,
  and a gate tightened on one branch can leave its sibling ungated. Touching a function an
  earlier round changed means re-reading it whole — an in-lane reviewer holding one diff cannot
  see this, which is what the independent pre-merge pass is for.**
- **Guard:** the W1 rows (`STRIPE-CANCEL-2`, `STRIPE-RESUME-1`) plus the rewritten spec that
  asserted the defect. Sibling [[L-119]].

### L-125 · 2026-09-14 · domain · W1 billing anchor

- **Symptom:** a fix for billing-period drift was about to derive each tenant's cycle anchor from
  `TenantSubscription.createdAt`, the only date on the row — moving real charge dates for anyone
  whose row predates their subscription.
- **Root cause:** several paths create that row without subscribing (a customer-cap grace window,
  a Stripe customer being minted), so its creation date is not the anchor; no column stores one.
- **Lesson:** **Never infer a money-bearing date from a column that merely happens to hold a date.
  Check every writer of the row before treating a field as the thing you need — if none of them
  means it, the honest fix is a column and a migration, not the nearest plausible field. Shipping
  half a fix beats shipping a wrong charge date.**
- **Guard:** the time-of-day half shipped alone; the drift half is filed, blocked on an
  `anchorDay` column. Sibling [[L-118]].

### L-126 · 2026-09-14 · domain · W1 admin plan change

- **Symptom:** a new admin plan-change branch cleared `cancelAtPeriodEnd`, silently revoking a
  cancellation the TENANT had asked for — no event, no audit line, and the sweep then never
  churned them, so a tenant who cancelled kept being billed indefinitely.
- **Root cause:** the line was copied verbatim from the tenant's own `downgrade()`, where clearing
  that flag is correct because the tenant is acting on their own subscription; the admin path
  performs the same write on someone else's. The code was identical, the authority behind it was
  not — and the sibling branch two screens down already stated the opposite rule.
- **Lesson:** **Consent does not travel with copied code. Before lifting a write from a
  self-service path into an admin path (or the reverse), ask who is acting and on whose behalf: a
  flag the owner of a subscription may clear for themselves is not one an operator may clear for
  them. When a function already contains a branch stating a rule, a new branch that contradicts it
  is the bug, not the discovery of an exception.**
- **Guard:** the admin plan change now REFUSES in either direction while a cancellation is armed,
  with `cancelAtPeriodEnd` added to the select it was blind to; REG tests in
  `platform-admin.service.spec.ts`. Sibling [[L-123]].

## Round 3 — the independent pre-merge pass (verdict: MERGE-WITH-NOTES)

The lead's independent Opus pass cleared the diff on assertions, double-apply, lock family, DI
and the refusal-while-armed coverage, and returned four notes. Three were fixed here.

### F-1 — admin reactivation must NOT clear the tenant's armed downgrade (reverses B216's admin half)

`updateStatus()`'s non-ACTIVE→ACTIVE CAS cleared `downgradeToPlanKey`/`downgradeEffectiveAt`/
`retainedUserIds`. Only two paths ever ARM those fields — the tenant's own `downgrade()` and
`updatePlan()`'s scheduled branch — so the field set is **always a chosen schedule**, never a
dunning threat the system armed. Clearing it revoked the tenant's own choice by someone else's
action, unrecorded, leaving them on the higher plan they had asked to leave. This is the same
consent seam the round-2 review caught on `cancelAtPeriodEnd`, one function away.

Implemented per the lead's ruling: the schedule survives, `applyScheduledDowngrades` applies it
when due (one that came due during the lapse applies on the next pass — the tenant's stated
intent), and the reactivation records `downgradeLeftArmed`/`downgradeEffectiveAt` in the admin
audit meta. `updateStatus()` now writes nothing to `TenantSubscription` on any path. FINDING-3's
single transaction is kept and still earns its place: the audited schedule must be the row as it
stood AT the transition, not one a concurrent `downgrade()` armed a moment later.

**Consequence for B216:** its admin half is not a defect as filed, so #730 does not fix B216. The
row's remaining substance is the Stripe-webhook disarm already on master. A registry note records
this; disposition is the lead's.

**Contested, as invited — the precedent argues the other way.** `billing.service.ts`'s comment at
the `disarmedDowngrade()` call sites states the disarm's rationale as: left armed, the sweep
"applies it the first night after reactivation" — i.e. the webhook path treats exactly the outcome
F-1 now mandates as the thing to prevent. So the two paths now disagree, and the webhook side may
be a latent instance of this same class: it clears a FUTURE-dated tenant-chosen schedule when an
invoice is paid, and paying an invoice does not express "I no longer want my downgrade". Out of
scope here and unchanged; raised to the lead for the owner.

### F-2 — an already-cancelled Stripe sub is a 400, not `resource_missing`

Cancelling an already-cancelled subscription returns `invalid_request_error` ("a subscription with
status `canceled` may not be updated") because the object still exists. That fell to the generic
branch, so the READ_ONLY path threw 503 on every retry while `stripeSubId` was never cleared —
the tenant could never get out. Already-cancelled is now treated as success, **detected by
re-reading the subscription's status**, not by matching the message: Stripe exposes no dedicated
code here, and a message-prefix discriminator is exactly what B218 had to replace one commit
earlier in this same wave. A 404 on the re-read is equally "nothing left to cancel"; any other
re-read failure is inconclusive and still surfaces the 503. On a confirmed outcome the dead
pointer is dropped, scoped to the same `stripeSubId` so a concurrent re-subscribe is never
clobbered — which is what makes a repeat `cancel()` a true no-op rather than merely tolerated.

### F-3 — the two add-on paths locked on different keys

Admin keyed on the raw `addonKey`, tenant on the `sku`, so the four `LEGACY_ADDON_KEY_TO_SKU`
add-ons took two different locks for one entitlement and raced each other despite both holding a
lock — the comments on both sides claimed they serialised. Both now key on the SKU.

### F-4 — `proratedNow` ignores `priceOverrideMonthly`/`discount` (left as a row)

Confirmed and NOT trivial, so left per the lead's own instruction. `ProrationService` exposes no
effective-price helper; the override logic lives in `platform-pricing.service.ts` (`ignoreOverrides`
→ `tenant.subscription.priceOverrideMonthly`). Wiring it in means injecting that service into the
proration math and changing what every `proratedDiff()` caller computes — a money change that
needs its own red-first row, not a review-round patch. Worth noting the admin path already selects
`priceOverrideMonthly` for other purposes, so the value is in hand at the call site.
