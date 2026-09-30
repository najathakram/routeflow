# Fix ruling — B09 B46 B48 B92 B106 F13 recurring invoices / standing orders

> Fable @ high rules over the S1 brief + S2 refutation verbatim; it opens no file. One ruling per run.
> PRE = `d07697016bff73e6335e112ae87881ff6e2509c7`. POST (this batch's committed snapshot, v1
> fixes applied, pre-master-merge) = `9e5ce526cca75dc4410e1c542cdf76b67b0739f7`
> (`origin/fix/F13-recurring-standing-v2`). The master merge has since landed: this run executes on
> `428046772195178cd694109e37d437f9097a8b14` (`42804677`, merge commit — master `f60bd27c` merged
> into `fix/F13-recurring-standing-v2`) — it does not rebuild from scratch. **Every file:line anchor
> below has been re-anchored against `42804677` (confirmed 2026-09-04 by reading the current
> working file at each cited range)**; none shifted except where noted inline.

## S2's verdicts (quoted in full, per id)

- **B46** — cause: `confirmed` (diverging line `recurring-invoices.service.ts:33`, PRE —
  `d.setDate(1)` runs before the `d.getDate() > dom` test, making the month-advance dead code).
  Fix: `fixes-the-cause`. Repro: `real-repro` (T1, T3, T5, T6, T7b go red on PRE's wrong `Date`);
  T7 is `not-a-repro` today — it is calendar-conditional and passes on PRE on 2026-09-04.
- **B48** — cause: `confirmed` (diverging line `order-templates.service.ts:360`, PRE — `const
unitPrice = Number(product.pricePerUnit)`, no tier/override/promo resolution anywhere in the
  function). Fix: `fixes-the-cause`. Repro: `real-repro` (T9–T16 all fail on PRE on a money value
  or a persisted price field).
- **B09** — cause: `confirmed` (diverging line `StandingOrderModal.tsx:181-187`, PRE — the
  `isEditing` mutate payload omits `items`; backstopped by the PRE DTO carrying no `items` field
  and PRE `update()` doing no item handling — a three-layer absence). Fix: `fixes-the-cause`.
  Repro: `real-repro` at the id level (T23, T25 fail on PRE on the persisted result); T26 is
  real-repro but proves a new guard, not B09's symptom; T28 is `no-jest-repro` (T2, spec 30 —
  no jest asserts the modal's own PATCH body).
- **B92** — cause: `confirmed` (diverging fact is an **absence** — no `[id]/edit` route existed at
  PRE — paired with the defective line `recurring-invoices.controller.ts:41`, PRE — `@Body() dto:
Partial<CreateRecurringInvoiceDto>`, a mapped type that erases to `Object` in
  `design:paramtypes` and is skipped whole by the global `ValidationPipe`). Fix:
  `fixes-the-cause`. Repro: `no-jest-repro` at the id level — T29 asserts the new DTO class
  exists, not the bug's wrong value (on PRE, `ValidationPipe.transform` skips validation and
  `resolves.toEqual` **passes**, so T29 is not a repro of B92 on its own terms); T31 proves
  transactionality, a hardening addition, not B92's registered symptom; only T32 (no-jest-repro,
  T2, spec 30) proves the registered "no UI reaches the working PATCH" symptom.
- **B106** — cause: `confirmed` (diverging line `recurring-invoices.service.ts:184`, PRE — the
  unguarded `await this.invoicesService.create(...)` immediately after the already-committed claim
  write; the loss becomes permanent at the cron's write-nothing `catch`, PRE `:253-258`). Fix:
  **`partial`**. Repro: `real-repro` (T17, T17b, T18, T19 all fail on PRE on B106's own wrong,
  unrecorded state). The outcome-recording half is a genuine fix for the registered symptom. It is
  `partial` on two counts, both attributable to this batch's own code: (a) the create-failure
  rollback is a **non-CAS plain `update`**, unlike the CAS claim it undoes; (b) the provisional
  `FAILED` + `RUN_INTERRUPTED_ERROR` stamped by the claim is operator-visible, and web's
  `isRetryableRunFailure` renders a "use Run Now to retry" hint on it — during a run that may still
  succeed.

### The B106 race claim — adopted verbatim as the finding (S2's dedicated section, verdict `real`)

**Claim under test:** the failure-rollback at POST `recurring-invoices.service.ts:263-268` (inside
the `:239-275` create try/catch) restores `nextRunAt` **unconditionally**, so a `runNow` or a
concurrent cron tick that moves `nextRunAt` between the failed `create` and the restore is
clobbered back to the pre-claim value, and the template fires again next cycle — an extra bill.

**Writers of `RecurringInvoice.nextRunAt` at POST** (anchors confirmed unchanged at `42804677`):

| #   | Site                                        | Form                                                      | Guarded?                                         |
| --- | ------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| W1  | `:224-232` the cycle claim                  | `updateMany({where:{id, nextRunAt: ri.nextRunAt}, …})`    | **CAS** on `nextRunAt`                           |
| W2  | `:263-268` the create-failure rollback      | `update({where:{id}, data:{nextRunAt: ri.nextRunAt, …}})` | **none** — plain update, `where` is the id alone |
| W3  | `:145` `update()` (PATCH, B92's new writer) | `update({where:{id}, data:{… nextRunAt …}})`              | **none**                                         |
| W4  | `:99` `create()`                            | initial value                                             | n/a                                              |

`runNow` has no private write path — it reads the row and calls `generateInvoiceFromTemplate`, i.e.
it goes through W1 exactly like the cron. The claim's CAS is the **only** mutual exclusion in the
file; W2 and W3 both bypass it. No outer lock exists — `generateDueRecurringInvoices` has no
advisory lock, no `SELECT … FOR UPDATE`, no idempotency row (contrast
`apps/api/src/common/db-locks.ts`'s `withAdvisoryLock`, which no cron in this module calls).

**The interleaving** (`ri.nextRunAt = T0` due; `A` = the midnight cron; `B` = an operator's Run Now):

| t   | A (cron)                                                                                               | B (Run Now)                                       | row `nextRunAt` | row status                    |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | --------------- | ----------------------------- |
| 1   | `findMany` reads `ri` at `T0`                                                                          |                                                   | `T0`            | —                             |
| 2   | W1 CAS `where nextRunAt=T0` → `T1`, provisional FAILED/interrupted, `count=1`                          |                                                   | `T1`            | FAILED (provisional)          |
| 3   | `invoicesService.create` in flight                                                                     | `findUnique` reads `ri` at `T1`                   | `T1`            | FAILED                        |
| 4   | still in flight                                                                                        | W1 CAS `where nextRunAt=T1` → `T2`, `count=1`     | `T2`            | FAILED                        |
| 5   | still in flight                                                                                        | `create` succeeds; link + `lastRunStatus:SUCCESS` | `T2`            | **SUCCESS**, one real invoice |
| 6   | `create` **throws** → W2 plain `update({where:{id}})` writes `nextRunAt: T0`, FAILED, `<create error>` |                                                   | **`T0`**        | **FAILED**, retryable         |

State after step 6: `nextRunAt = T0` (`<= now`). B's real, committed, customer-facing invoice is
recorded as a **failed** run with a **retryable** error string, and the schedule has been handed
back for a cycle already billed. The next midnight tick — or an operator taking the "use Run Now to
retry" hint the clobbered `lastError` now shows — generates a **second** invoice for the same
cycle. **Extra bill: yes.** The claim CAS closes only the _claim_ window (two callers cannot claim
the same `nextRunAt` value); it does nothing for W2, which runs after the claim and carries no
`where.nextRunAt`. B92's new edit-page writer (W3) reaches the same hazard non-concurrently: it
sends `nextRunAt` unconditionally on every save, so an operator saving a schedule change while a
generation is in flight and failing has that save silently reverted by W2.

**`REG-B106 T17` (`schedule-outcome.spec.ts:175-197`, confirmed unchanged at `42804677`) asserts exactly the plain,
non-CAS shape** — `toHaveBeenCalledWith` on `recurringInvoice.update` with `where: {id: "ri-1"}`
and no schedule predicate, nothing about `updateMany` anywhere in T17/T17b. The test proves the
plain-update behavior, not a race-free one; it is expected to change shape under this run's fix
(see §3).

## 1. Cause verdict

- **B46 — accepted.** `confirmed`, `fixes-the-cause`, `real-repro`. No further evidence needed.
- **B48 — accepted.** `confirmed`, `fixes-the-cause`, `real-repro`. No further evidence needed.
- **B09 — accepted.** `confirmed`, `fixes-the-cause`, `real-repro` (T2/no-jest-repro caveat is a
  tier fact, not a doubt about the fix).
- **B92 — accepted.** `confirmed`, `fixes-the-cause`, `no-jest-repro`. Accepted as-is: the symptom
  is proven only by e2e (T2), consistent with the ledger's own B92 tier; this run additionally
  closes S2's residual #1 (nothing at POST proves the controller binds the DTO) with a jest pin —
  see §2 B92-d.
- **B106 — accepted, PARTIAL.** `confirmed` cause, `partial` fix, `real-repro`. The race in S2's
  dedicated section is accepted **verbatim** as a real, reachable defect this batch introduced
  (the claim CAS pre-existed #373; the non-CAS rollback and the retry-hint-during-a-healthy-run are
  both new in this diff). This run's job is to close both counts (a) and (b) — see §2 B106-a/b.

## 2. Fix design (minimal diff)

### B106-a — CAS rollback

In `generateInvoiceFromTemplate`'s create-failure path (`recurring-invoices.service.ts:263-268`,
confirmed unchanged at `42804677`), replace the plain

```ts
await this.prisma.forTenant().recurringInvoice.update({
  where: { id: ri.id },
  data: { nextRunAt: ri.nextRunAt, lastRunStatus: RUN_STATUS_FAILED, lastError: message },
});
```

with a compare-and-set:

```ts
await this.prisma.forTenant().recurringInvoice.updateMany({
  where: {
    id: ri.id,
    /* tenant scoping exactly as the claim's updateMany does it */ nextRunAt:
      nextRunAt /* the ADVANCED value this run's own claim wrote */,
  },
  data: { nextRunAt: ri.nextRunAt, lastRunStatus: RUN_STATUS_FAILED, lastError: message },
});
```

When it returns `{ count: 0 }`, the row has been claimed by a newer run (Run Now or another tick)
— **write nothing** to the row (log at `warn` with the id and both `nextRunAt` values) and still
rethrow the original error. Keep `lastRunAt` behavior exactly as today on this path (untouched by
this change). Must NOT change: the claim CAS (W1), the unfinalized (billed-but-unlinked) path (the
link+SUCCESS/finalize block), the SUCCESS write, the cron loop, `runNow`. **Invariant preserved**:
after any failure, `nextRunAt` is either the pre-claim value (this run owned the row throughout, no
newer claimant appeared) or whatever a newer claimant wrote — **never** a value older than a cycle
that has already been billed.

### B106-b — no retry invitation during a healthy run

Web `apps/web/lib/api/invoices.ts`'s `isRetryableRunFailure` (`:785`, next to `RUN_UNFINALIZED_PREFIX`
at `:782`; confirmed at `42804677`) must return
`true` **only** for a terminal create-failure error — i.e. **not** for `RUN_INTERRUPTED_ERROR` (the
provisional marker the claim writes at `:224-232`) and **not** for `RUN_UNFINALIZED_*`. The
recurring list page (`apps/web/app/(dashboard)/invoices/recurring/page.tsx`, the pill/hint region
at `:184-193`, confirmed at `42804677`) renders the provisional state as informational copy —
"Generation in progress or interrupted — if no invoice appears by the next cycle, use Run Now" —
with no CTA styling, and keeps the existing retry hint only for terminal (real create) failures.
Mobile (`apps/mobile/lib/recurring-invoices-logic.ts`): **no change** — it already has no retry
button on this screen; record the API/mobile asymmetry as an accepted residual, not a defect to
close here. Must NOT change: the error constants' text (`RUN_INTERRUPTED_ERROR`,
`RUN_UNFINALIZED_ERROR`/`RUN_UNFINALIZED_PREFIX`) — coupled by a `startsWith` check that this run
does not touch.

### B46-c — date-robust T7

`schedule-outcome.spec.ts` T7 (`:135-151`, confirmed unchanged at `42804677`, "the claim is strictly future") derives
`due` from the real clock, so it is red on PRE only on calendar days `>= dayOfMonth` (it passes on
PRE today, 2026-09-04, per S2's trace). Freeze it: a fixed `now` via the test's own fixture, or
`jest.useFakeTimers().setSystemTime(...)`, so it is red on PRE and green on POST on every calendar
day. T7b is unaffected (already calendar-robust) and stays as-is.

### B92-d — controller binding pin

Neither DTO spec at POST touches `RecurringInvoicesController` — both construct their own
`ValidationPipe` and call `.transform()` directly, so reverting `controller.ts:42` back to
`Partial<CreateRecurringInvoiceDto>` leaves every jest test in the batch green (S2's residual #1).
Close it with two new/extended jest pins asserting `design:paramtypes`, since that is the exact
mechanism the mapped-type defect exploited:

- **NEW `REG-B92 T34`** — in a new `recurring-invoices.controller.spec.ts` (no controller-level
  spec exists for this controller today — confirmed absent at both PRE and POST): assert via
  `Reflect.getMetadata("design:paramtypes", RecurringInvoicesController.prototype, "update")` that
  the PATCH body parameter's metatype (index 1 — `update(id, dto)`, confirmed at
  `recurring-invoices.controller.ts:42`) is `UpdateRecurringInvoiceDto`, not `Object`/`Partial`.
  This is the only jest that goes red if the controller line reverts.
- **Same pin for the order-templates PATCH as `REG-B09 T35`** — `order-templates.controller.ts`'s
  `update` handler (id, dto, user — dto at index 1, confirmed at `:51-56`) must bind
  `UpdateOrderTemplateDto`. Extend the **existing** `order-templates.controller.roles.spec.ts`
  (it already builds `OrderTemplatesController.prototype` and reads its metadata for the roles
  matrix — the natural, minimal-diff home) rather than create a new file.

### Harness hygiene (test package)

- The two latent one-method `OrdersService` doubles in `order-templates.service.spec.ts`
  (`:238` "template ownership (F2-003)" and `:452` "update() with no items key (T27)" — re-anchored
  from `~:186`/`~:400` at `9e5ce526`, confirmed at `42804677`, per S2's Harness section) gain the
  same four methods the other suites in this batch carry
  (`mergeAllPendingForCustomer`, `loadActivePromotions`, `getCustomerPriceHistory`,
  `resolveBuyerLinePrice`) so a future change routing either suite through the pricing
  collaborators does not fail on `is not a function`.
- **T17 is REWRITTEN** for the CAS shape: `updateMany` with `where.nextRunAt` = the advanced value
  the claim wrote, `data.nextRunAt` = the pre-claim value. **NEW T17c**: `updateMany` resolves
  `{ count: 0 }` ⇒ no further `update`/`updateMany` write to the row follows, and the error still
  rethrows.

### Spec 30 comment only

`apps/web/e2e/30-recurring-standing.spec.ts` header + `finally` block: correct the comment to say
the template is **deactivated** (`DELETE` is deactivate, not a hard delete) — comment text only, no
behavior change.

**Nothing else in the POST diff changes.** In particular: the MONTHLY `calcNextRunAt` rewrite
(B46), the `advanceFrom = max(dueAt, now)` call-site change, the B48 pricing pipeline, the B09
item-replace transaction, and the B92 DTO/route/form all stand as-is — S2 confirmed all four
`fixes-the-cause`.

## 3. Regression tests

See `bug-test-plan.md` for full detail. Summary:

| T#                  | REG token | Fails TODAY on (exact wrong value)                                                                            | Passes after fix on                                                                                         | Notes                                                  |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| T17 (rewrite)       | REG-B106  | rollback calls `recurringInvoice.**update**({where:{id:"ri-1"}}, …)` — no `updateMany`, no schedule predicate | `updateMany` called with `where` containing `nextRunAt: <advanced T1>` and `data.nextRunAt: <pre-claim T0>` | red-gated                                              |
| T17c (new)          | REG-B106  | no equivalent exists — this exact scenario (`{count:0}` fallback) is unhandled today                          | `{count:0}` ⇒ no further write to the row, error still rethrows                                             | red-gated                                              |
| T36 (new, web jest) | REG-B106  | `isRetryableRunFailure(RUN_INTERRUPTED_ERROR)` returns `true`                                                 | returns `false`; a terminal message stays `true`                                                            | red-gated                                              |
| T7 (date-frozen)    | REG-B46   | flaky-false on PRE depending on calendar day                                                                  | deterministically red on PRE, green on POST, every day                                                      | pin outside the red gate (not a NEW wrong-value proof) |
| T34 (new)           | REG-B92   | is a pin — the metatype IS `UpdateRecurringInvoiceDto` today (T4)                                             | pin only; goes red on a controller revert                                                                   | pin outside the red gate                               |
| T35 (new)           | REG-B09   | is a pin — the metatype IS `UpdateOrderTemplateDto` today                                                     | pin only; goes red on a controller revert                                                                   | pin outside the red gate                               |

Pins (no REG token, outside the red gate): the two `OrdersService` double repairs in
`order-templates.service.spec.ts`; the spec-30 comment change (no assertion change).

## 4. Blast radius (`radiusFiles`)

Every file in `git diff --name-only d0769701 9e5ce526` (38 files, listed verbatim in
`pipeline-args.json`) **plus** — for the B106/B92-d closure this run adds —
`apps/api/src/orders/orders.service.ts`, `apps/api/src/invoices/invoices.service.ts`,
`apps/web/lib/api/invoices.ts`, `apps/mobile/lib/recurring-invoices-logic.ts`,
`apps/api/src/testing/prisma-mock.ts`. Three of those five (`orders.service.ts`,
`apps/web/lib/api/invoices.ts`, `apps/mobile/lib/recurring-invoices-logic.ts`) are already inside
the 38-file diff; the union is **40 unique files** — `apps/api/src/invoices/invoices.service.ts`
and `apps/api/src/testing/prisma-mock.ts` are the two genuinely new radius files (invoices.service
because its `create()` transactionality is the safety premise the rollback fix leans on; the
Prisma mock because T17/T17c's `updateMany` default (`{count:0}`) is the exact fixture every
generate-path test must override).

## 5. Sibling pattern (`siblingPatterns`)

- `update\(\{\s*where:\s*\{\s*id` within 30 lines after an `updateMany\(\{[^}]*nextRunAt` — an
  unconditional restore after a CAS claim (B106's own shape). Known structural twins outside this
  batch's radius, reported by S2, NOT fixed here: `billing-cron.service.ts:284-289`
  (`rollCycles`), and the order-templates 06:00 cron's dedupe-by-read at
  `order-templates.service.ts:321-330` (no CAS, no unique constraint, no advisory lock) — file as
  registry candidates, judge on hit, do not fix in this run.
- `@Body\(\)\s+\w+:\s*Partial<` — a mapped-type body the ValidationPipe skips (B92's exact shape).
  `apps/api/src/invoices/invoices.controller.ts:156` is a **known hit** (S2 confirms: "identical
  defect, still present at POST" — the only other `Partial<...Dto>` in a `@Body()` position in the
  whole API). Judge as a confirmed defect, file as a registry candidate, do **NOT** fix here.
- `@Body\(\)\s+\w+:\s*any\b` (and `Record<string, ...>`) — same class, report only. Known hits per
  S2: `customers.controller.ts:216,228` (money endpoints — advance-payment create/apply),
  `estimates.controller.ts:14`, `inventory.controller.ts:171,193,213`, `returns.controller.ts:26`;
  `settings.controller.ts:121,254` and `users.controller.ts:57` use `Record<...>` and are
  plausibly deliberate for open key-value bodies — report, do not flag as defects without review.
- Exclusions (do not sweep): the 13 `@Cron` sites without advisory locks (S2's list; a separate
  follow-up), `estimates.service.ts`'s pricing shortcut (a separate follow-up, same class as B48
  but a different writer).

## 6. Data repair

None. B106's double-bill is prevented **going forward only**; any historical duplicate invoice
produced by the race (or by the live B46 bug re-firing nightly) is an owner-report question, not a
repair this run bundles. Note it in the close-out; no read-only report script is specified here
because no batch has yet quantified how many rows are affected — that quantification, if the owner
wants it, is separate follow-up work.

## 7. Probe plan

All probes are **mutations** (`revertFix: false`) — HEAD (`42804677`, post-master-merge) already
contains the v1 fixes, so there is no PRE state to revert to; each probe instead injects a defect
into the fixed file and the named REG test must catch it.

| File                                                                                                                                                     | `revertFix`        | REG test that must go red |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------- |
| `apps/api/src/recurring-invoices/recurring-invoices.service.ts` — "rollback is compare-and-set on the advanced `nextRunAt` and writes nothing on a miss" | `false` (mutation) | REG-B106 T17 / T17c       |
| `apps/api/src/recurring-invoices/recurring-invoices.service.ts` — "MONTHLY advance lands strictly after the base date with the `dom` clamp"              | `false` (mutation) | REG-B46 T1 / T1b          |
| `apps/api/src/order-templates/order-templates.service.ts` — "generated lines price through `resolveBuyerLinePrice`, never list × qty"                    | `false` (mutation) | REG-B48 T9–T16            |
| `apps/api/src/order-templates/order-templates.service.ts` — "PATCH items replaces the template's items"                                                  | `false` (mutation) | REG-B09 T25 / T26         |
| `apps/api/src/recurring-invoices/recurring-invoices.controller.ts` — "PATCH binds `UpdateRecurringInvoiceDto`"                                           | `false` (mutation) | REG-B92 T34               |
| `apps/web/lib/api/invoices.ts` — "`RUN_INTERRUPTED` is not retryable"                                                                                    | `false` (mutation) | REG-B106 T36 (web jest)   |

## Follow-ups filed to the owner (explicitly NOT this batch)

- The local-vs-UTC midnight convention split on `nextRunAt` (`calcNextRunAt` writes server-local
  midnight; the B92 edit form writes UTC midnight — equal in prod only where `TZ=UTC`).
- A crash between claim and create advances the schedule by two cycles (one invoice produced where
  two elapsed, no record of the skip).
- The SUCCESS write drops `lastRunAt` from its data (the timestamp next to a green "Succeeded"
  pill is the claim time, not the completion time).
- `RUN_UNFINALIZED_ERROR`/`RUN_UNFINALIZED_PREFIX` text duplicated across api/web with no test
  pinning the two together.
- 13 `@Cron` sites with no advisory lock (sibling class A, S2).
- `invoices.controller.ts:156`'s `Partial<>` body (sibling class B/C, S2) — the direct B92 twin.
- `categoryTaxAmount: 0` on template-generated regulated lines (pre-existing, "left as-is, per
  plan" — now the only remaining divergence from the golden pricing path on the same line object).
- Item-route role asymmetry on order-templates (`POST /:id/items` OPERATOR-only vs `PATCH`/`DELETE`
  admitting CUSTOMER) — B09's fix routes item replacement through the now-CUSTOMER-reachable
  PATCH, widening (not closing) the asymmetry S2 confirmed is not itself an authorization hole
  (ownership is still enforced).
