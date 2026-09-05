# Bug test plan — B09 B46 B48 B92 B106 F13 recurring invoices / standing orders

> Fable @ high writes this from `cause-ruling.md`; Sonnet types the tests inside the engine. The
> red bar is BEHAVIORAL: each REG test must fail today on its own exact wrong value —
> reproduction is the point. All file:line anchors have been **re-anchored against `42804677`**
> (`428046772195178cd694109e37d437f9097a8b14`, this worktree's committed HEAD now that the master
> merge has landed — `f60bd27c` merged into `fix/F13-recurring-standing-v2`, superseding the
> pre-merge snapshot `9e5ce526`); confirmed 2026-09-04, none shifted except where noted inline.
>
> This run does not re-prove B46/B48/B09's already-`fixes-the-cause` behavior (S2 already confirmed
> `real-repro` for T1/T3/T5/T6/T7b, T9–T16, T23/T25) — those existing REG-tagged tests at POST are
> left untouched except where named below. This plan covers only what `cause-ruling.md` §2/§3 adds:
> the B106 CAS rollback + retry-hint fix, the B46 T7 date-freeze, and the two controller-binding
> pins.

## Red set (REG-tagged; in the red gate)

| T#            | Title (starts with REG-<bug id>)                                                                                                    | Setup                                                                                                                                                                             | Asserts                                                                                                                                                                                                                                                                                                                                                                     | Fails TODAY with                                                                                                                                                                                                                                                                                                                                                                                                                                           | File                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| T17 (rewrite) | `REG-B106 T17 — a create failure restores nextRunAt via compare-and-set on the value the claim wrote, records FAILED, and rethrows` | `template()` fixture (MONTHLY, `dayOfMonth: 15`); claim `updateMany` resolves `{count:1}`; `invoices.create` rejects with `new Error("Customer not found")`                       | `prisma.recurringInvoice.updateMany` was called (not `.update`) with `where` containing `{id: "ri-1", nextRunAt: <the advanced value the claim's own `updateMany` call wrote>}` and `data` containing `{nextRunAt: <the pre-claim value>, lastRunStatus: "FAILED", lastError: expect.stringContaining("Customer not found")}`; the function rejects with the original error | today the rollback calls `prisma.recurringInvoice.**update**({where:{id:"ri-1"}, data:{...}})` — a plain update with no `nextRunAt` predicate at all, so an assertion on an `updateMany` call with a `where.nextRunAt` clause fails: **received undefined call to `updateMany`, only `update` was called**                                                                                                                                                 | `apps/api/src/recurring-invoices/recurring-invoices.schedule-outcome.spec.ts` |
| T17c (new)    | `REG-B106 T17c — a lost rollback CAS (count: 0) writes nothing to the row and still rethrows`                                       | Same as T17, but `prisma.recurringInvoice.updateMany` (the rollback call) is mocked to resolve `{count: 0}` on its second invocation (first is the claim, second is the rollback) | the function still rejects with the original create error; **no** `prisma.recurringInvoice.update` call and **no additional** `updateMany` call happen after the `{count:0}` rollback attempt (i.e. nothing further is written to the row once the CAS is lost)                                                                                                             | today there is no CAS on the rollback at all — the rollback is an unconditional plain `update` that always writes, so a lost-CAS scenario cannot even be constructed against current code; asserting "no further write after a `{count:0}` updateMany" fails because the current code path never calls `updateMany` for the rollback in the first place (the assertion's precondition — a rollback `updateMany` existing to return `{count:0}` — is unmet) | `apps/api/src/recurring-invoices/recurring-invoices.schedule-outcome.spec.ts` |
| T36 (new)     | `REG-B106 T36 — RUN_INTERRUPTED_ERROR is not a retryable failure; a terminal create-failure message is`                             | Import `isRetryableRunFailure`, `RUN_INTERRUPTED_ERROR` from `apps/web/lib/api/invoices.ts`                                                                                       | `isRetryableRunFailure(RUN_INTERRUPTED_ERROR)` is `false`; `isRetryableRunFailure("Customer not found")` (a terminal create error) is `true`; `isRetryableRunFailure(null)` / `isRetryableRunFailure(undefined)` are `false` (pin, unchanged)                                                                                                                               | today `isRetryableRunFailure(RUN_INTERRUPTED_ERROR)` returns **`true`** (`expected false, received true`) — the function only excludes `RUN_UNFINALIZED_PREFIX`, and `RUN_INTERRUPTED_ERROR` does not start with that prefix                                                                                                                                                                                                                               | `apps/web/lib/api/invoices.test.ts` (new file)                                |

"Fails TODAY with" is the exact expected-vs-received the red gate will verify.

## Pins (no REG token; outside the red gate)

Per `cause-ruling.md` §3, three items are **pins** — they assert a currently-true fact and only go
red on a _regression_ (a revert), not on today's wrong value, so they carry a REG token (for the
mutation-probe hook) but sit outside the behavioral red gate:

| T#                       | Frozen behavior                                                                                                                                                                                                                                                            | File                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T7 (date-frozen rewrite) | `REG-B46 T7` — the cycle claim's `nextRunAt` is strictly future, asserted with the system clock frozen (`jest.useFakeTimers().setSystemTime(...)` or an injected fixed `now`) so the assertion is deterministic on every calendar day, not only when run on/after the 15th | `apps/api/src/recurring-invoices/recurring-invoices.schedule-outcome.spec.ts` (existing `:135-151`, rewritten in place — same title, frozen clock)                                   |
| T34 (new)                | `REG-B92 T34` — `Reflect.getMetadata("design:paramtypes", RecurringInvoicesController.prototype, "update")[1]` is `UpdateRecurringInvoiceDto`                                                                                                                              | `apps/api/src/recurring-invoices/recurring-invoices.controller.spec.ts` (new file — no controller-level spec exists for this controller at `42804677` either)                        |
| T35 (new)                | `REG-B09 T35` — `Reflect.getMetadata("design:paramtypes", OrderTemplatesController.prototype, "update")[1]` is `UpdateOrderTemplateDto`                                                                                                                                    | `apps/api/src/order-templates/order-templates.controller.roles.spec.ts` (existing file, extended — it already builds `OrderTemplatesController.prototype` for the B133 roles matrix) |

T34/T35 are pins **today** (the metatype at `42804677` already is the validated DTO class — S2's
residual #1 is that nothing _proves_ it, not that it is wrong) but they carry the REG token so a
mutation probe reverting the controller's `@Body()` type back to `Partial<...Dto>` turns them red —
that reversion is exactly the defect class S2 confirmed still lives at
`invoices.controller.ts:156`.

## Harness notes (verified by the engine's harness-integrity check)

- **`prisma-mock.ts`'s default `updateMany` resolves `{count: 0}`** (a lost claim). Every
  generate-path test already sets `{count: 1}` explicitly for the _claim_ call — T17/T17c must
  additionally control the **rollback** `updateMany`'s resolved value per-call (Jest
  `mockResolvedValueOnce`/sequenced `mockImplementation`, since claim and rollback are now the
  _same_ mocked method, called twice with different `where` shapes). Getting this wrong makes T17c
  vacuously pass (the rollback silently returns the same default `{count:0}` whether or not the
  fix's own guard logic runs).
- **`tenantTransaction` shares the same spies as the top-level `models` object** (`prisma-mock.ts`
  — `forTenant()` returns the same object as the top level). No new risk from this run's changes,
  but T17/T17c's assertions on `prisma.recurringInvoice.updateMany` rely on this being unchanged;
  if the mock ever gains a distinct tx client, these two tests (and every T25/T26/T27/T31 in the
  existing suite) break together — call this out to the implementer as a "do not touch" fact, not
  something to fix.
- **`schedule-outcome.spec.ts`'s existing `T18`** asserts `calls` equals
  `["claim","create","link","status:SUCCESS"]` **exactly** via `toEqual`. The B106-a rollback
  change does not touch the happy path, but the implementer must re-run T18 after the CAS rewrite
  to confirm the claim call's internal shape change (still `updateMany`, unchanged signature on
  the happy path) does not perturb the `calls` array's push sites.
- **The two stale `OrdersService` doubles** in `order-templates.service.spec.ts` (`:238`
  "template ownership (F2-003)" and `:452` "update() with no items key (T27)" — re-anchored from
  `~:186`/`~:400` at `9e5ce526`, confirmed at `42804677`) currently provide
  only `{ mergeAllPendingForCustomer: jest.fn() }`. They pass today only because their suites never
  reach `createOrderFromTemplate`. This run's T35 pin extends the SAME spec file's sibling
  `order-templates.controller.roles.spec.ts` — a different file — so it does not by itself touch
  these two doubles, but the harness-hygiene fix (widen both doubles to the same four methods every
  other suite in this batch carries) ships in the same edit as a defensive measure per
  `cause-ruling.md` §2, since any future change routing either suite through the pricing
  collaborators would otherwise fail on `ordersService.loadActivePromotions is not a function`
  with no test in this run pointing at the cause.
- **`apps/web/lib/api/invoices.test.ts` is a new file** — no existing web jest file imports from
  `apps/web/lib/api/invoices.ts` today per this batch's diff; confirm no naming collision and that
  the web jest config (`apps/web/jest.config.*`) picks up `lib/api/*.test.ts` without a new glob
  entry before authoring T36.

## Commands

- `redGate.commands`:
  - `cd apps/api && npx jest src/recurring-invoices/recurring-invoices.schedule-outcome.spec.ts -t "REG-B106 T17" --runInBand` — expect fail.
  - `cd apps/web && npx jest invoices.test -t "REG-B106"` — expect fail.
- The REG token(s) (`REG-B106`, `REG-B46`, `REG-B92`, `REG-B09`) double as the registry proof lines
  at close-out, alongside the untouched existing REG-tagged tests at `42804677` for the four
  already-`fixes-the-cause` bugs.
