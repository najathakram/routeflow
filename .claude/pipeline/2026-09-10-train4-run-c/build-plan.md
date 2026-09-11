# Build plan: B216 — Stripe reinstatement disarms a pre-lapse downgrade (train 4, Run C)

> **Stage S5 — "how".** Written 2026-09-10. Status: `APPROVED` (from the cause ruling).
> **Model note:** bug-pipeline policy puts S5 on Fable 5.1. Fable was out of usage credits on 2026-09-10
> (direct probe: HTTP 429), so **Opus 5 wrote this, as the documented fallback.**
> This file is the ONLY context the implementation and review agents receive. The test plan is
> [bug-test-plan.md](./bug-test-plan.md) (T1-T7). Mode `bugfix`, scale `small`. Bug runs have no
> discovery/spec, so the Preamble below stands in for them.
> Evidence: `local-assets/handoff/2026-09-09/planning/train4/cause-{brief,refutation,ruling}.md`,
> re-grounded at master `edd379bf`. Every line number below was re-read at that sha.

---

## Preamble (small scale)

- **Problem:** a tenant that lapses (SUSPENDED/CANCELLED) with a downgrade scheduled and is then
  reinstated by Stripe (`invoice.payment_succeeded` or `checkout.session.completed`) keeps the stale
  schedule. The 02:00 `applyScheduledDowngrades` sweep (`apps/api/src/billing/billing-cron.service.ts:121-220`,
  filter `tenant.status = "ACTIVE"`) applies it on the first night after reactivation: plan flip, a
  second MRR `BillingEvent` delta, non-retained staff deactivated.
- **Who hits it:** any plans-as-data tenant reinstated after a lapse with `downgradeToPlanKey` set. It is
  rare per tenant but lands on money (MRR ledger, invoiced plan price) and on staff access.
- **Success signal:** after a Stripe reinstatement that actually flipped the tenant to ACTIVE, the
  tenant's `TenantSubscription` has `downgradeToPlanKey = null`, `downgradeEffectiveAt = null` and
  `retainedUserIds = []`. After an ordinary renewal of an already-ACTIVE tenant, those fields are unchanged.
- **Requirements:**
  - `R1` — `onPaymentSucceeded` disarms the downgrade (three fields) iff its `transitionAndEmit` returned `true`.
  - `R2` — `onCheckoutCompleted` does the same, on the same condition.
  - `R3` — the disarm is a separate `this.prisma.tenantSubscription.update` issued **after**
    `transitionAndEmit` resolves. It is never folded into the pre-CAS period-date write, never inside the
    CAS `tx`, and never touches `cancelAtPeriodEnd`.
  - `R4` — `SUBSCRIPTION_RESUMED` is still emitted exactly once per reinstatement (no `resume()` reuse, no
    extra emit).
  - `R5` — the three-field disarm shape lives in ONE file-local helper in `billing.service.ts`, spread by
    all four Stripe lifecycle sites (L-072 drift guard). The existing `onSubscriptionDeleted`/
    `onSubscriptionUpdated` behaviour is byte-for-byte unchanged.
- **Non-goals (scope fence):** no change to `transitionAndEmit`'s signature or its transaction; no change
  to `billing-cron.service.ts`, `subscription-mutation.service.ts` or `platform-admin.service.ts` (their
  own copies of the shape stay; unifying them is a deferred follow-up); no data repair/backfill; no
  migration; no new DB-lane spec.

**Scale note:** billing is a HIGH-risk (money) area, which the small-scale Preamble normally excludes.
The orchestrator chose `small` because the diff is 1 production file plus 1 spec, the cause is ruled,
and bug mode's refute-first S2 already ran. The launcher must know that at `small` the engine may skip
the revert probe (see Risks).

---

## Objective

Make the two Stripe reinstatement webhooks disarm a downgrade that was armed before the tenant lapsed,
**only** when the webhook actually performed the non-ACTIVE->ACTIVE transition. Nightly downgrade
application then never re-prices or strips staff from a freshly reinstated tenant. Ordinary renewals
keep a legitimately scheduled downgrade.

**In scope:** `apps/api/src/billing/billing.service.ts` (two handlers plus one file-local helper plus two
sibling spreads) and `apps/api/src/billing/billing.service.spec.ts` (new tests only).
**Explicitly out of scope:** everything in the Non-goals list above.

---

## Constraints & conventions

- **Stack:** NestJS 11 + Prisma 7. `BillingService` constructor is
  `(prisma, stripe, email, tenantStatusGuard, events, pricing)` (`billing.service.ts:24-30`).
- **Test runner/layout:** Jest, co-located `*.spec.ts`. Run from `apps/api`:
  `cd apps/api && npx jest src/billing/billing.service.spec.ts --runInBand`. No snapshot tests, no Vitest.
- **Lint/format:** ESLint flat config per workspace (`apps/api` script `lint`); Prettier (double quotes,
  semicolons, `printWidth` 100, trailing commas).
- **Pattern to copy:** `onSubscriptionDeleted`'s post-`transitionAndEmit` separate
  `this.prisma.tenantSubscription.update` (`billing.service.ts:676-687`). **Gate on the boolean
  `transitionAndEmit` returns**, the same way `onSubscriptionDeleted` consumes it as `churned` (`:657-674`).
- **Must NOT change:** `transitionAndEmit` (`:90-112`), the pre-CAS period-date write in
  `onPaymentSucceeded` (`:598-611`, post-B216 line numbers), the `upsert` in `onCheckoutCompleted`, event names/payloads,
  `onSubscriptionDeleted`'s `cancelAtPeriodEnd: true`, and `onSubscriptionUpdated`'s conditional (only when
  `cancel_at_period_end === true`).
- **Do-not-introduce:** a new `$transaction`; a call to `SubscriptionMutationService.resume()` (it
  re-emits `SUBSCRIPTION_RESUMED`, a double emit); any use of `this.pricing` in these handlers (it is
  `undefined` in the spec harness); an exported helper (no other consumer).
- **Lessons carried:**
  - **L-081** ("gate a money write inside the primitive that performs it, on the row it just read"). The
    disarm is gated on `transitionAndEmit`'s own `count === 1` verdict, never on a `tenant.status` or
    `sub` snapshot read before the CAS. A pre-read would race the paired checkout and payment webhooks
    and disarm on the loser too.
  - **L-072** (never hand-type a second copy of a shape that must stay identical). Hence the one
    `disarmedDowngrade()` helper for all four sites in this file.
- **Landmines:**
  - Folding the three fields into the pre-CAS period write (`:598-611`, post-B216 line numbers) would run before the CAS and on
    every renewal. T3 and T4 catch it.
  - Writing through the CAS `tx` is out of the ruling ("mirror the sibling, not a new transaction"),
    and the spec's `tx` mock has no `tenantSubscription`.
  - A module-level `as const` object would type `retainedUserIds` as `readonly []`, which Prisma's
    `string[]` input rejects. Use the function below, which also returns a fresh array per call.

---

## Test packages

### TP1 — B216 red set + pins

- **writes:** `apps/api/src/billing/billing.service.spec.ts` (append one new top-level `describe`; edit
  nothing else)
- **tests:** T1, T2, T3 (REG), T4, T5, T6, T7 (pins)
- **brief:** transcribe [bug-test-plan.md](./bug-test-plan.md) exactly: its fixtures (`armedSub`,
  `disarmCall`, `DISARMED`, `checkoutSession`), placement, titles and one-oracle-per-`it()`
  assertions. Do not modify `make()`. Implement nothing in `billing.service.ts`.
- **must fail with:** T1 and T2 `received undefined` against the `DISARMED` object; T3
  `received [["periodEnd","periodStart"]]`. T4-T6 pass.

**Red gate command:**

```bash
cd apps/api && npx jest src/billing/billing.service.spec.ts --runInBand -t "REG-B216" --reporters=default
```

---

## Work packages

### WP1 — disarm on a real Stripe reinstatement

- **files:** `apps/api/src/billing/billing.service.ts`
- **satisfies:** R1, R2, R3, R4, R5
- **provenBy:** T1, T2, T3, T4, T5, T6, T7 (plus existing `billing.service.spec.ts:128-172` for R5)
- **dependsOn:** none
- **effort:** high (money file)
- **brief:** four edits in this one file, in order.

**(1) File-local helper.** Add at module scope, directly above the `@Injectable()` decorator of
`export class BillingService` (below the imports):

```ts
/**
 * The ONE shape that disarms a scheduled plans-as-data downgrade (L-072: never hand-type it twice).
 * Spread by every Stripe lifecycle handler that must cancel a pending downgrade: subscription deleted,
 * subscription updated to cancel_at_period_end, and a real reinstatement (B216). A function, not a
 * const, so each write gets a fresh mutable `retainedUserIds` array Prisma's String[] input accepts.
 */
function disarmedDowngrade(): {
  downgradeToPlanKey: null;
  downgradeEffectiveAt: null;
  retainedUserIds: string[];
} {
  return { downgradeToPlanKey: null, downgradeEffectiveAt: null, retainedUserIds: [] };
}
```

**(2) `onCheckoutCompleted` (`:493-552`).** Capture the result of the `transitionAndEmit` call at `:541`
and add the gated disarm after the existing `this.tenantStatusGuard.invalidate(tenantId);`. The final
shape of that tail:

```ts
const reinstated = await this.transitionAndEmit(
  tenantId,
  upserted,
  { status: { not: "ACTIVE" } },
  "ACTIVE",
  1,
  BILLING_EVENTS.SUBSCRIPTION_RESUMED,
  { source: "stripe", reason: "checkout_completed" },
);
this.tenantStatusGuard.invalidate(tenantId);

// B216: only a REAL reinstatement (this call won the non-ACTIVE→ACTIVE CAS) disarms a downgrade
// scheduled before the lapse; left armed, the 02:00 applyScheduledDowngrades sweep (which skips
// non-ACTIVE tenants) applies it the first night after reactivation. Never on a lost CAS (tenant
// already ACTIVE): that would delete a downgrade the ACTIVE tenant legitimately scheduled. A
// separate post-commit write, mirroring onSubscriptionDeleted; never resume() (double emit).
if (reinstated) {
  await this.prisma.tenantSubscription.update({
    where: { tenantId },
    data: disarmedDowngrade(),
  });
}

this.logger.log(`Tenant ${tenantId} activated via checkout (sub: ${subscriptionId})`);
```

**(3) `onPaymentSucceeded` (`:555-602`).** Same pattern at `:591`. The period-date `try` block
(`:599-610`, post-B216 line numbers) stays exactly where it is, before the CAS, unchanged:

```ts
const reinstated = await this.transitionAndEmit(
  sub.tenantId,
  sub,
  { status: { not: "ACTIVE" } },
  "ACTIVE",
  1,
  BILLING_EVENTS.SUBSCRIPTION_RESUMED,
  { source: "stripe", reason: "payment_succeeded" },
);
this.tenantStatusGuard.invalidate(sub.tenantId);

// B216: see onCheckoutCompleted — disarm ONLY when this call performed the reinstatement; an
// ordinary renewal (already ACTIVE → CAS count 0 → false) keeps a legitimately scheduled downgrade.
if (reinstated) {
  await this.prisma.tenantSubscription.update({
    where: { tenantId: sub.tenantId },
    data: disarmedDowngrade(),
  });
}

this.logger.log(`Payment succeeded for tenant ${sub.tenantId} (customer ${customerId})`);
```

**(4) Sibling spreads (R5, behaviour-preserving).**

- `onSubscriptionDeleted` (`:679-687`): `data: { cancelAtPeriodEnd: true, ...disarmedDowngrade() }`.
- `onSubscriptionUpdated` (`:713-715`): inside the existing
  `subscription.cancel_at_period_end === true ? ... : {}` conditional, replace the inline
  `{ downgradeToPlanKey: null, downgradeEffectiveAt: null, retainedUserIds: [] }` with `disarmedDowngrade()`.
  Keep the conditional.

Edit nothing else. Do not touch the spec file.

### Package map

| Pkg | satisfies | provenBy            | dependsOn | Wave                          |
| --- | --------- | ------------------- | --------- | ----------------------------- |
| TP1 | — (tests) | T1-T7               | —         | 0 (test phase, before any WP) |
| WP1 | R1-R5     | T1-T7, spec:128-172 | —         | 1                             |

Cross-check: R1-R5 all sit in WP1; T1-T7 all appear in WP1's `provenBy`.

---

## Acceptance criteria

1. `R1` — `onPaymentSucceeded` with CAS count 1 writes
   `tenantSubscription.update({ where: { tenantId }, data: { downgradeToPlanKey: null, downgradeEffectiveAt: null, retainedUserIds: [] } })` (T1).
2. `R2` — `onCheckoutCompleted` with CAS count 1 writes the same (T2).
3. `R3` — with a live `stripeSubId`, the period write and the disarm are two separate updates, and the
   disarm comes second (T3). With CAS count 0, no update carries a downgrade key, in either handler (T4,
   T5). `cancelAtPeriodEnd` is absent from the disarm write (T1/T2 `toEqual`).
4. `R4` — `SUBSCRIPTION_RESUMED` is emitted exactly once per reinstatement (T6). `resume(` is not
   referenced from `billing.service.ts`.
5. `R5` — the literal `downgradeToPlanKey: null` appears exactly once in `billing.service.ts`, inside
   `disarmedDowngrade()`. Existing spec `:128-140`, `:151-160` and `:162-172` pass unchanged.
6. Negative — `transitionAndEmit`, the period write, event payloads and `onSubscriptionUpdated`'s
   conditional are unchanged in the diff. The suspension transition (`suspendOverdueTenants`, `:764`)
   still does not disarm.
7. Deploy day — no migration and no backfill. Existing armed rows on currently-ACTIVE tenants are left as
   they are. Only future reinstatements disarm.

---

## Verification commands

Per round:

```bash
npm run check-types -w apps/api
cd apps/api && npx eslint src/billing/billing.service.ts src/billing/billing.service.spec.ts
```

Final:

```bash
cd apps/api && npx jest src/billing --runInBand --reporters=default
```

**No DB-lane entry, and why:** the project's DB-lane command is
`node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api -- <paths>"`
(`test:db` = `jest --config jest.db.config.js`). No `*.db.spec.ts` exists under `apps/api/src/billing/`
(checked at `edd379bf`), the ruling puts B216 on the unit lane, and running the whole DB lane would be an
unscoped suite. Nothing is owed there.

---

## Risks & rollback

| Risk                                                                                                         | Likelihood                    | Blast radius                                   | Mitigation / what the reviewer should watch                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disarm fires on an ordinary renewal (unconditional, or folded into the period write)                         | med if the builder improvises | money: silently deletes a legitimate downgrade | T3, T4, T5. Reviewer confirms the gate is the returned boolean.                                                                                                                 |
| Disarm write throws after the CAS committed; the Stripe retry then loses the CAS (count 0) and never disarms | low (single-row PK update)    | money: this defect recurs for that one tenant  | **Accepted per ruling** (mirror the sibling; no transaction change). Follow-up option for the owner: pass an in-tx callback into `transitionAndEmit`. Do NOT do it in this run. |
| Double `SUBSCRIPTION_RESUMED` (via `resume()` or an extra emit)                                              | low                           | MRR ledger double-counts                       | T6. `SubscriptionMutationService` is not injected, so reuse would need new DI, which is out of scope.                                                                           |
| Helper refactor changes a sibling's written shape                                                            | low                           | money                                          | spec `:128-172` plus acceptance criterion 5                                                                                                                                     |
| `scale: small` skips the revert probe                                                                        | med                           | test-quality evidence only                     | T1-T3 are behavioral red, so the red gate already proves they bite. If the launcher wants the probe evidence, launch at `major`.                                                |

- **Rollback:** `git revert` the squash commit. There is no schema, no flag and no data write.
- **Migration reversibility:** none (no migration).
- **Feature flag / entitlement:** none.
- **Deploy day / data (S3.6):** **prod rows may already be corrupted.** Any tenant reinstated via Stripe
  while a downgrade was armed would have had it applied at the next 02:00: a plan flip,
  `basePriceSnapshot` re-priced, a second MRR `BillingEvent` delta
  (`billing-cron.service.ts:157-168`), and possibly non-retained staff deactivated. **No backfill in this
  run.** The read-only report that would measure it (to be authored in a separate, owner-approved run;
  none exists today, since `apps/api/scripts` has no `downgradeToPlanKey` reader) is
  `apps/api/scripts/report-b216-reinstated-downgrades.mjs`. It would list, per tenant, each downgrade
  application the sweep booked whose tenant has a Stripe-sourced `SUBSCRIPTION_RESUMED` event
  (`payload.source = "stripe"`, reason `payment_succeeded`/`checkout_completed`) dated between the
  downgrade's scheduling and its application. It would also count ACTIVE tenants still carrying
  `downgradeToPlanKey` whose latest status change was such a reinstatement. The owner decides any repair.
- **Observability:** the existing `Payment succeeded for tenant ...` and `Tenant ... activated via
checkout` log lines. A failing disarm write surfaces as a webhook handler error in the API logs.

---

## Pipeline args

Identical to `pipeline-args.json` beside this file. Paths are relative to the run worktree root. The
launcher copies this file and the test plan into `.claude/pipeline/2026-09-10-train4-run-c/`, fixes
the date, and sets `startedAt`/`workdir`. Code-map and lessons edits follow Bookkeeping Option B (the
docs-only follow-up PR), not this run.

```json
{
  "mode": "bugfix",
  "planPath": ".claude/pipeline/2026-09-10-train4-run-c/build-plan.md",
  "testPlanPath": ".claude/pipeline/2026-09-10-train4-run-c/bug-test-plan.md",
  "lessonsPath": ".claude/lessons/LESSONS.md",
  "scale": "small",
  "context": "B216: Stripe reinstatement (onPaymentSucceeded/onCheckoutCompleted) must disarm a pre-lapse downgrade ONLY when transitionAndEmit returns true; separate post-CAS prisma update; one disarmedDowngrade() helper (L-072); gate on the CAS verdict (L-081); never resume() (double emit); no tx change, no backfill. Option-B bookkeeping: no map/lessons/ledger edits.",
  "formatCommand": "npx prettier --write apps/api/src/billing/billing.service.ts apps/api/src/billing/billing.service.spec.ts",
  "radiusFiles": [
    "apps/api/src/billing/billing.service.ts",
    "apps/api/src/billing/billing.service.spec.ts",
    "apps/api/src/billing/subscription-mutation.service.ts",
    "apps/api/src/billing/billing-cron.service.ts"
  ],
  "siblingPatterns": [
    {
      "regex": "await this\\.transitionAndEmit\\(",
      "note": "4 hits: 541/591 are the B216 sites; 657 already disarms; 764 is suspension (must NOT disarm). A new reinstatement site without a gated disarm = defect"
    },
    {
      "regex": "downgradeToPlanKey:\\s*null",
      "note": "after WP1 only disarmedDowngrade() in billing.service.ts; other files are separate flows (cron apply, admin, resume) - report, do not edit"
    }
  ],
  "testPackages": [
    {
      "id": "TP1",
      "title": "B216 red set + pins",
      "files": ["apps/api/src/billing/billing.service.spec.ts"],
      "brief": "build-plan TP1 / bug-test-plan T1-T6; append one describe; implement nothing"
    }
  ],
  "redGate": {
    "commands": [
      "cd apps/api && npx jest src/billing/billing.service.spec.ts --runInBand -t \"REG-B216\" --reporters=default"
    ],
    "expect": "fail"
  },
  "packages": [
    {
      "id": "WP1",
      "title": "gated disarm on Stripe reinstatement + shared helper",
      "files": ["apps/api/src/billing/billing.service.ts"],
      "brief": "build-plan WP1 edits (1)-(4), exact code",
      "effort": "high",
      "satisfies": ["R1", "R2", "R3", "R4", "R5"],
      "provenBy": ["T1", "T2", "T3", "T4", "T5", "T6"]
    }
  ],
  "verifyCommands": {
    "perRound": [
      "npm run check-types -w apps/api",
      "cd apps/api && npx eslint src/billing/billing.service.ts src/billing/billing.service.spec.ts"
    ],
    "final": ["cd apps/api && npx jest src/billing --runInBand --reporters=default"]
  },
  "mutationProbe": {
    "targets": [
      {
        "file": "apps/api/src/billing/billing.service.ts",
        "behavior": "a won reinstatement CAS disarms the downgrade as a separate post-CAS write",
        "test": "REG-B216-A REG-B216-B REG-B216-C",
        "revertFix": true
      }
    ]
  }
}
```

> Amended 2026-09-10 (lead review): --reporters=default added to both Jest commands per L-063.
> Amended 2026-09-10 (lead): --reporters=default moved LAST — Jest reads positionals after it as reporter modules (proven in wf_363f0377-624 Baseline).
