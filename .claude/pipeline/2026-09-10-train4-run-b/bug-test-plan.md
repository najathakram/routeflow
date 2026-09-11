# Bug test plan — B215 staff-merge same-key retry re-folds (train 4 Run B)

> **Status: IMPLEMENTED (light-loop round 1).** The fix shipped; every REG/pin below is GREEN in the tree. This file
> is the plan as it was WRITTEN plus the corrections in "Post-implementation corrections" at the bottom — read that
> section before trusting any "Fails TODAY with", any harness note, or any D3/PD1 oracle above.
>
> **Stage S4.** Written 2026-09-10 at master `edd379bf`.
> **Model note:** bug-pipeline policy assigns S4 to Fable 5.1. Fable was out of usage credits on 2026-09-10 (direct
> probe: HTTP 429), so **Opus 5 wrote this plan as the documented fallback**. It transcribes the Fable cause ruling plus
> the OWNER RULINGS 2026-09-10 (`local-assets/handoff/2026-09-09/planning/train4/cause-ruling.md`, final section wins).
> Companion: [build-plan.md](./build-plan.md) holds the exact code, the harness to copy, and the fix design. Sonnet
> types these tests inside the engine; this file and build-plan.md are all it sees.
> **The red bar is behavioral.** Each REG test must fail TODAY on its own wrong value (a call count, a total, a
> row, a resolved-vs-rejected), never on a missing import or a type error.

## The bug in one paragraph

`POST /orders` with `mergeChoice:"merge"` (staff, `OrdersController.create`, `apps/api/src/orders/orders.controller.ts`
~147-221) folds the incoming cart into the customer's active order under `withAdvisoryLock`, then records the
`Idempotency-Key` with `OrdersService.recordIdempotencyKey` (`orders.service.ts` ~1661-1676). That writer is
`updateMany({ where: { id, idempotencyKey: null } })`: **first key wins**. An order that already carries a key (created
with one by `create()`, or stamped by an earlier merge wave) silently drops the new key, so a same-key retry finds
nothing on replay (`findOrderIdByIdempotencyKey`, ~1638, reads only that one column) and folds the same cart in a second
time. The fold writes ABSOLUTE totals, so the order's quantities and total double. Secondary windows: the stamp is a
second commit after `updateOrderItems`' own transaction. A throw inside `updateOrderItems` after its commit (invoice
reconcile, credit settle) never reaches the stamp, and a failed stamp is only logged. In both cases the retry re-folds.

## Red set (REG-tagged; in the red gate)

Unit file: `apps/api/src/orders/orders.merge-idempotency.spec.ts` (NEW). DB-lane file:
`apps/api/src/orders/order-idempotency-key.db.spec.ts` (NEW). Titles start with the exact token `REG-B215` followed by
the T#/D# id (L-097: the registry proof token must match titles byte-for-byte).

| T#  | Title (starts with `REG-B215`)                                                                                         | Setup                                                                                                                                                                                                                                                                                                                                                                 | Asserts (ONE oracle)                                                                                                                                                      | Fails TODAY with                                                                                         | File |
| --- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---- |
| T1  | `REG-B215 T1: a same-key retry onto an order that already carries a key folds once, not twice`                         | Controller + stateful fake OrdersService (build-plan TP1 "fake"); active order's column key = `"K0-created"`; two identical merge requests, key `"idem-K1"`                                                                                                                                                                                                           | `svc.updateOrderItems` called **1** time                                                                                                                                  | `Expected number of calls: 1, Received number of calls: 2`                                               | unit |
| T2  | `REG-B215 T2: a retry after the fold committed but a later step threw folds once`                                      | Same fake, column key `null`, `throwAfterFirstFold: true`; request 1 swallowed with `.catch(() => undefined)`; request 2 same key `"idem-K2"`                                                                                                                                                                                                                         | `svc.updateOrderItems` called **1** time                                                                                                                                  | `Expected: 1, Received: 2`                                                                               | unit |
| T3  | `REG-B215 T3: the same key with a different cart is refused, never folded`                                             | Fake, column key `"K0-created"`; request 1 items `[{prod-1, qty 5}]`, request 2 items `[{prod-1, qty 7}]`, same key `"idem-K3"`                                                                                                                                                                                                                                       | request 2 `rejects.toBeInstanceOf(ConflictException)`                                                                                                                     | `Received promise resolved instead of rejected` (resolves `{ id: "ord-active", … }` after a second fold) | unit |
| T4  | `REG-B215 T4: updateOrderItems with an idempotency option writes exactly one key row`                                  | `buildOrdersService` harness, DRAFT order `ord-1`, `(service as any).updateOrderItems("ord-1", {items:[{productId:"prod-B",qty:1}],replaceAll:true}, operatorPayload, { idempotency: { key: "K1", responseHash: "h1" } })`                                                                                                                                            | `prisma.orderIdempotencyKey.create.mock.calls.map(c => c[0].data)` equals `[{ tenantId: "test-tenant", key: "K1", orderId: "ord-1", responseHash: "h1" }]`                | `Expected [ {…} ], Received []`                                                                          | unit |
| T5  | `REG-B215 T5: the key row is written inside the fold's own transaction`                                                | Same as T4, plus the tx-sequencing `tenantTransaction` override (build-plan TP1)                                                                                                                                                                                                                                                                                      | `createdInTx` equals `[1]` (created while the FIRST tenantTransaction, the fold tx, was open)                                                                             | `Expected [1], Received []`                                                                              | unit |
| T6  | `REG-B215 T6: a consolidation sweep moves a loser's merge key onto the winner`                                         | `mergeAllPendingForCustomer("cust-1")`, `order.findMany` → `[w1, l1]`; fake key store `[{ key: "K1", orderId: "l1" }]`; `order.delete` fake cascades rows of the deleted id (mirrors the FK `ON DELETE CASCADE`); `orderIdempotencyKey.updateMany` fake re-points                                                                                                     | `rows.find(r => r.key === "K1")?.orderId` is `"w1"`                                                                                                                       | `Expected "w1", Received undefined` (row cascaded away with the loser)                                   | unit |
| T7  | `REG-B215 T7: forceConsolidateCustomer moves a loser's merge key onto the winner`                                      | Same fakes as T6, `forceConsolidateCustomer("cust-1")`, `invoicesService.findOpenOrderDraft` → `null`                                                                                                                                                                                                                                                                 | same oracle                                                                                                                                                               | `Expected "w1", Received undefined`                                                                      | unit |
| T8  | `REG-B215 T8: the merge replay lookup reads the per-request key table`                                                 | `prisma.orderIdempotencyKey.findFirst` → `{ orderId: "ord-1", responseHash: "h1" }`; `prisma.order.findFirst` → `null`; `(service as any).findOrderIdByIdempotencyKey("K1", "cust-1", "h1")`                                                                                                                                                                          | resolves `"ord-1"`                                                                                                                                                        | `Expected "ord-1", Received null`                                                                        | unit |
| T9  | `REG-B215 T9: a key-table hit with a different request fingerprint is refused`                                         | Same mocks as T8; call with hash `"h-other"`                                                                                                                                                                                                                                                                                                                          | `rejects.toBeInstanceOf(ConflictException)`                                                                                                                               | `Received promise resolved instead of rejected` (resolves `null`)                                        | unit |
| T10 | `REG-B215 T10: a key that is already taken aborts the fold with 409`                                                   | T4 harness; `prisma.orderIdempotencyKey.create.mockRejectedValue(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }))`                                                                                                                                                                                                                            | `updateOrderItems(…, { idempotency })` `rejects.toBeInstanceOf(ConflictException)`                                                                                        | `Received promise resolved instead of rejected`                                                          | unit |
| D1  | `REG-B215 D1: a second key on an already-keyed order is replayed by the merge lookup`                                  | Real Postgres; order seeded with column key `K0-<run>-d1`; `mergeOnce(a, K1, "h-d1")`                                                                                                                                                                                                                                                                                 | `findOrderIdByIdempotencyKey(K1, a.customerId, "h-d1")` is `a.orderId`                                                                                                    | `Expected "<uuid>", Received null`                                                                       | DB   |
| D2  | `REG-B215 D2: a same-key retry never folds twice`                                                                      | Order total `100.00`, column key `K0-<run>-d2`; `mergeOnce` twice, same key and hash                                                                                                                                                                                                                                                                                  | order total is `110`                                                                                                                                                      | `Expected 110, Received 120`                                                                             | DB   |
| D3  | `REG-B215 D3: a key held by another customer's order is refused before the fold (pre-fold 409)`                        | Same tenant: order B (free column) merged with key K first; order A (column key `K0-<run>-d3`, total 100) then `mergeOnce(a, K, "h-d3a")`                                                                                                                                                                                                                             | `mergeOnce(a, …)` rejects with `ConflictException` (the replay lookup's `heldByAnotherOrder` branch, before the fold tx opens) **and** order A total is `100`             | `Expected 100, Received 110`                                                                             | DB   |
| D4  | `REG-B215 D4: a colliding key inserted after the replay lookup rolls the fold back through the real unique constraint` | Same tenant: order B (free column) merged with key K first; order A (column key `K0-<run>-d4`, total 100). The lost race the pre-fold lookup cannot close — skip the replay lookup and run the fold's two writes in ONE `tenantTransaction`: `tx.order.update({ total: 110 })` then `svc.recordMergeIdempotencyKey(tx, a.orderId, { key: K, responseHash: "h-d4a" })` | the transaction rejects with `ConflictException` (the in-tx P2002 branch), order A total is `100`, and `orderIdempotencyKey.count({ orderId: a.orderId, key: K })` is `0` | `Expected 100, Received 110` (no unique constraint existed, so the fold committed)                       | DB   |

`mergeOnce` (DB lane) is the staff merge branch's persistence sequence with a raw `+10` fold stand-in. It runs the
replay lookup, then one `prisma.tenantTransaction` holding the fold plus, when the fixed service exposes
`recordMergeIdempotencyKey`, the in-tx key write, then the controller's post-commit column stamp
`recordIdempotencyKey`. Before the fix it therefore runs today's real `OrdersService` methods against real Postgres, so
D1-D4 fail on the bug's own values. Exact code is in build-plan TP2. D4 deliberately bypasses `mergeOnce`'s replay
lookup: once the fix's pre-fold refusal lands, the lookup short-circuits the common case, so the in-transaction P2002
rollback needs a test that reaches the insert (D3 now proves the pre-fold refusal instead).

## Pins (no REG token; outside the red gate; expected colour stated per L-060)

| T#         | Frozen behavior                                                                                                                                                                                                         | Colour today / after        | File     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------- |
| P1         | `B215 pin P1: a merge with no Idempotency-Key calls updateOrderItems with exactly three arguments` — oracle `svc.updateOrderItems.mock.calls[0]` has length 3                                                           | GREEN / GREEN               | unit     |
| P2         | `B215 pin P2: a key that sits only on the Order column (create()'s key) still replays a merge` — fake column key `"K0-created"`, merge with key `"K0-created"`, oracle `updateOrderItems` called 0 times                | GREEN / GREEN               | unit     |
| P3         | `B215 pin P3: with no key-table row the lookup falls back to the Order column` — `order.findFirst` → `{ id: "ord-1" }`, `findOrderIdByIdempotencyKey("K0", "cust-1")` resolves `"ord-1"`                                | GREEN / GREEN               | unit     |
| P4         | `B215 pin P4: updateOrderItems without the option writes no key row` — T4 harness with 3 args, oracle `prisma.orderIdempotencyKey.create` called 0 times                                                                | GREEN / GREEN               | unit     |
| PD1        | `B215 pin PD1: a key recorded for one customer is never replayed for another` — `mergeOnce(b, K, "h")`, then `findOrderIdByIdempotencyKey(K, a.customerId, "h")` **rejects with `ConflictException`** (see corrections) | GREEN / GREEN               | DB       |
| PD2        | `B215 pin PD2: the same key string in two tenants folds once in each` — oracle `[totalA, totalB]` equals `[110, 110]`                                                                                                   | GREEN / GREEN               | DB       |
| (existing) | `orders.scan-hardening.spec.ts` ~1407 "R3: an idempotency record that fails AFTER the fold committed is logged, never thrown" and ~1649 "OrdersService.recordIdempotencyKey — first key wins (R1)"                      | GREEN / GREEN, **unedited** | existing |

The two existing tests stay valid because this run **keeps** `recordIdempotencyKey` byte-identical (the Order-column
stamp that `create()`'s replay and the consolidation R6 carry still read) and keeps the controller's best-effort call to
it. The merge branch simply stops depending on it. Any red P# escalates on the spot (L-060): it is a live defect, not a
spec to ship.

## Harness notes (verified by the engine's harness-integrity check)

1. **`createMockPrisma()` has no `orderIdempotencyKey` model.** TP1 adds `orderIdempotencyKey: modelProxy(),` to
   `allModels()` in `apps/api/src/testing/prisma-mock.ts`, in the same edit as the tests. `tenantTransaction`/
   `$transaction` spread `models`, so one entry reaches both the root client and every `tx`. Without it T4-T10, P3 and P4
   die on `Cannot read properties of undefined`, and every other spec exercising `updateOrderItems` breaks after WP2.
2. **Type errors are not a red bar.** As written: today `updateOrderItems` took 3 parameters and
   `findOrderIdByIdempotencyKey` took 2, and the generated client had no `orderIdempotencyKey` delegate, so every
   4-argument `updateOrderItems` call, 3-argument `findOrderIdByIdempotencyKey` call and `recordMergeIdempotencyKey`
   reference went through `(service as any)` / `(svc as any)`. **Post-fix (corrections below):** those signatures and
   the delegate all exist, so the casts are cosmetic; the DB spec now reads `raw.orderIdempotencyKey` directly in D4's
   rollback oracle, and the earlier `typeof svc.recordMergeIdempotencyKey === "function"` feature probe around
   `mergeOnce`'s in-tx write is GONE — the call is unconditional, so a missing method fails loudly.
3. **Existing `toHaveBeenCalledWith` on `updateOrderItems`** (`orders.scan-hardening.spec.ts:720`,
   `orders.service.spec.ts:6645`, `buyer/buyer.merge-lock.spec.ts:204`) pass three matchers. They stay green only
   because WP3 passes a 4th argument **only when a key is present** (exact code in build-plan WP3). None of those tests
   sends a key. Do not edit them.
4. **The DB spec needs the two `jest.mock` blocks** for `../invoices/invoices.service` and
   `../notifications/notifications.service` (copy from `orders.scan-hardening.spec.ts` lines ~30-50). It imports
   `OrdersService` for real, and the invoice PDF chain is ESM-only.
5. **The DB spec builds the service without Nest DI** — as SHIPPED:
   `Object.assign(Object.create(OrdersService.prototype), { prisma, logger: new Logger(OrdersService.name) })`.
   `Object.create` runs no constructor, so every instance FIELD the exercised paths dereference must be supplied:
   `logger` is a class field (not on the prototype), and both refusal paths warn through it — without it the pins
   surfaced as `TypeError: Cannot read properties of undefined (reading 'warn')` instead of the
   Conflict/ForbiddenException they assert. The three methods it calls (`findOrderIdByIdempotencyKey`,
   `recordIdempotencyKey`, `recordMergeIdempotencyKey`) still use only `this.prisma` + `this.logger`; keep them that
   way (no other injected service inside them). ⚠️ `replayMergeReconcile` does NOT qualify — it reaches
   `invoicesService`/`creditNotes`, so it is covered in the unit lane, never this one.
6. **The DB lane requires `scripts/lib/test-tenants.cjs`** (outside apps/api), exactly as `tenant-findunique.db.spec.ts`
   does. That is the DB-lane convention (CLAUDE.md test-tenant policy). It is not the turbo main lane, so L-062 does not
   bite. The UNIT spec must not read or require anything outside `apps/api`.
7. **Campaign reporter.** Run unit specs with `--reporters=default` so a partial run never overwrites
   `.campaign/runs/api.json` (L-063). `jest.db.config.js` already drops that reporter.

## Commands

- `redGate.commands` (both must FAIL today, every REG test on its stated value, no pin red):
  - `cd apps/api && npx jest src/orders/orders.merge-idempotency.spec.ts -t "REG-B215" --reporters=default`
  - `node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api -- order-idempotency-key -t REG-B215"`
    (compose Postgres must be up at master's schema: `npm run db:up`; D1-D4 touch only today's columns before the fix)
- The token `REG-B215` doubles as the registry proof line at close-out (T1-T10, D1-D4).

## Post-implementation corrections (light-loop round 1, 2026-09-11)

The plan above is preserved as written. These are the places it no longer describes the tree:

1. **D3 was RETITLED and re-scoped.** Planned as "a colliding key in the same tenant rolls the fold back through the
   real unique constraint"; the fix added a PRE-FOLD refusal (the tenant-wide `heldByAnotherOrder` branch), so D3 now
   proves that refusal — it never opens the fold transaction — and is titled `… is refused before the fold (pre-fold
409)`. **D4 was ADDED after the red gate ran** to keep the in-transaction P2002 rollback covered: it bypasses
   `mergeOnce`'s replay lookup and runs the fold's two writes in one `tenantTransaction`. D4 therefore has no
   "fails TODAY" colour from the red gate — it is a post-fix addition, proven by execution (it passes and emits the
   `fold rolled back` warn).
2. **"Fails TODAY with" is no longer reachable for the D lane.** `mergeOnce` now calls `recordMergeIdempotencyKey`
   unconditionally (the `typeof` probe is gone), so against a pre-fix tree every D test dies on a TypeError rather
   than on the bug's own value. The behavioral red bar those columns record was met at the time of the red gate, on
   the probe-guarded version; it cannot be re-derived by checking this branch out against master.
3. **PD1 refuses rather than returns null.** With the pre-fold refusal in place, a same-tenant key bound to ANOTHER
   customer's order is rejected by the lookup itself, so PD1's oracle is `rejects.toBeInstanceOf(ConflictException)`.
   The in-tx P2002 remains the backstop for a true race — proved by **D4**, not D3.
4. **Tests added in this round** (all in `apps/api/src/orders/orders.merge-idempotency.spec.ts` unless noted):
   - `REG-B215 T2b` — folded into T2 plus a dedicated
     `OrdersService.replayMergeReconcile` describe: a replay re-runs the convergent tail (invoice
     `reconcileOrderDraftInvoice` + credit `syncOrderCreditSelections`/`settleOrderCreditsInTx` once each), never
     `resyncOrderInvoicesForEdit`, and appends **no** revision; plus a tenant-less refusal pin.
   - `REG-B215 T11b` — `mergeRequestHash` is credit-note-ORDER-insensitive and credit-SET-sensitive.
   - `REG-B215 T16` — a key present only in the key table makes `create()` return the existing order with no
     `order.create`. (Planned as "T14"; **T14 was already taken** by the tenant-less `recordMergeIdempotencyKey`
     refusal, so the new case took the next free number.)
   - `REG-B215 T17` — the lookup order: this customer's own column key replays even while another customer holds a
     key-table row (before the reorder this was a permanent 409).
   - `REG-B215 T3` / `T9` / `T13` tightened to assert the machine-readable 409 body
     (`code` / `reason` / `orderId`), and T13's "no column read" assertion replaced with "no write" — the
     customer-scoped column read now runs BEFORE the tenant-wide refusal by design.
   - **Manual only:** `REG-B215-M1` (mobile cart-key rotation on customer switch) — see build-plan.md's
     "Manual verification" table. No pure helper exists to unit-test the rotation predicate.
