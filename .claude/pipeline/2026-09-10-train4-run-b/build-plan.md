Status: IMPLEMENTED

# Build plan: train 4 Run B — B215 (a same-key retry of a staff order merge folds the same items twice)

> **Status: IMPLEMENTED (light-loop round 2).** The fix shipped; the design below is the plan as WRITTEN. Read
> "Post-implementation corrections" at the bottom before trusting the Risks table, the bookkeeping bullet, or any
> claim about D3 / test numbering.
>
> **Stage S5 ("how").** Written 2026-09-10. Status: `APPROVED` (for launch).
> **Model note:** bug-pipeline policy assigns S5 to Fable 5.1. Fable was out of usage credits on 2026-09-10 (a direct
> probe returned HTTP 429), so **Opus 5 wrote this plan as the documented fallback**. It transcribes the Fable cause
> ruling and the OWNER RULINGS 2026-09-10 (`local-assets/handoff/2026-09-09/planning/train4/cause-ruling.md`; the final
> section supersedes earlier lines). The one design point the ruling left open, where the key write lands relative to
> the fold's commit, is resolved below under "Design decision".
> Mode `bugfix`, scale `major`. The implementation and review agents receive only this file and
> [bug-test-plan.md](./bug-test-plan.md); both stand alone.
> Grounding: every cited line was re-read at master `edd379bf` on 2026-09-10 and matched. Line numbers are approximate
> (±5); anchor on the quoted code, not the number.

---

## Objective

A staff `POST /orders` with `mergeChoice:"merge"` and an `Idempotency-Key` header folds the cart into the customer's
active order. A retry carrying the same key (a mobile queue re-delivery, a timed-out request retried) must replay the
first result and must never fold the same cart a second time. Today it does fold again whenever the target order already
carries a key: `recordIdempotencyKey`'s `where: { id, idempotencyKey: null }` is first-key-wins, so the merge's key is
silently dropped (the dominant defect, per the S2 refutation). It also re-folds whenever the key write never happens
after a committed fold. The fold writes ABSOLUTE totals, so every re-fold doubles the cart on the order.

After the fix, every staff merge records its own key in a new tenant-scoped `OrderIdempotencyKey` table, **inside the
same database transaction as the fold**. The merge replay reads that table first, and a same-key retry replays the
stored order and never re-folds.

**In scope**

- The new model + additive migration.
- `MODEL_DOMAIN`.
- `OrdersService`:
  - `findOrderIdByIdempotencyKey` reads the table first.
  - new `recordMergeIdempotencyKey`.
  - `updateOrderItems` takes an optional 4th argument and writes the key in its own tx.
  - the two consolidation loser loops re-point key rows to the winner.
- `OrdersController.create`'s merge branch: fingerprint, pass the key into the fold.
- A new pure helper `merge-idempotency.ts`.
- The tests in bug-test-plan.md.

**Out of scope (scope fence; each is its own row if wanted)**

- `OrdersService.create()`'s replay stays column-only. See the residual risk "retry falls through to create()".
- The buyer-portal merge (`buyer.controller.ts` `createOrder`, ~537-640) takes no `Idempotency-Key` at all. It is not a
  twin of this defect (no key to honour); do not add one here.
- The global `IdempotencyKey` model (`platform.prisma` ~690, RoutesService stop replay) is a different mechanism with
  the wrong scope. Do not reuse, rename or touch it.
- TTL/cleanup of key rows; appending the table to the parked RLS list (`apps/api/prisma/deferred-rls/`).
- Removing or changing `recordIdempotencyKey` or the Order column / its unique index.
- Any data repair. See "Data repair": read-only report specified, not written in this run.

## Design decision (resolves the ruling's open point)

**Facts.**

- `withAdvisoryLock` (`apps/api/src/common/db-locks.ts:176-302`) holds a dedicated `pg` pool client. It serializes
  merges per customer and encloses no Prisma transaction.
- `updateOrderItems` (`orders.service.ts:3069`) commits its own `this.prisma.tenantTransaction` (~3225-4285, `timeout:
15_000`). CLAUDE.md forbids threading a tx **into** it.
- Today the key write is a second, later commit from the controller.

**Decision: the key row is written INSIDE `updateOrderItems`' own transaction.**

- The controller hands the key to `updateOrderItems` as an optional 4th argument (`opts.idempotency`).
- As the last statement of the transaction callback, just before its `return { subtotal, tax, total, shouldRevert,
shippingFee }`, `updateOrderItems` calls `this.recordMergeIdempotencyKey(tx, orderId, opts.idempotency)` with the `tx`
  it already holds.
- This does not thread a transaction into `updateOrderItems`; no outer tx enters it. It is the opposite direction: one
  more row written by the transaction `updateOrderItems` already owns.
- The call still runs inside the `withAdvisoryLock` callback, as the ruling requires, and adds no second lock
  (CLAUDE.md: never an in-process lock on top of `withAdvisoryLock`).
- This applies L-081 (gate the write inside the primitive that performs it) and L-068 (make the durable record of intent
  commit with the step it guards).

**What a same-key retry sees in each window, after the fix**

| Window                                                                                                                                                        | What happens                                                                                                                                                                                  | What the retry sees                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Success, response lost (timeout, dropped socket)                                                                                                              | Fold + key row committed together                                                                                                                                                             | Replay pre-check (inside the lock) finds the row, hash matches, returns `findOne(orderId)`: **no re-fold**                  |
| Fold committed, then a later step inside `updateOrderItems` throws (invoice reconcile/resync, the credit-settle tx, revision, events) — the caller gets a 500 | Key row already committed with the fold                                                                                                                                                       | **Replay, no re-fold.** Today: re-fold (the controller never reaches the stamp)                                             |
| "Fold committed, then the key write fails"                                                                                                                    | **Cannot happen any more**: the key write is inside the fold tx, so its failure (P2002 = key owned by another request → 409; DB error; tenant missing) aborts the tx and the fold never lands | The retry runs one real fold (or gets 409 again). At most one fold. Today: fold kept, stamp error swallowed, retry re-folds |
| "Crash between the two"                                                                                                                                       | **No "between"**: one `COMMIT`. Crash before it → Postgres rolls back fold and key together; crash after it → both durable                                                                    | Before-commit crash: retry folds once. After-commit crash: retry replays                                                    |
| Retry arrives while the first request still holds the customer lock                                                                                           | Waits up to 10 s, then reads the committed row                                                                                                                                                | Replays; if the wait times out → 409 `MERGE_IN_PROGRESS`, client retries later → replays                                    |
| Same key, different cart                                                                                                                                      | Stored `responseHash` ≠ incoming fingerprint                                                                                                                                                  | 409 "Idempotency-Key reused with a different cart…" (mirrors `create()`'s R4 text), no fold                                 |
| Same key used by ANOTHER customer of the same tenant                                                                                                          | Customer-scoped pre-check misses it; the in-tx insert hits `@@unique([tenantId, key])` → P2002                                                                                                | Fold rolled back, 409 (proven against real Postgres by D3)                                                                  |

**Residual risk accepted (honest list)**

1. **Retry falls through to `create()`.** The retry may no longer reach the merge branch: the merged order left
   DRAFT/PENDING before the retry arrived, or `findActiveOrder` returns null. Then the controller takes the plain
   `create()` path, whose replay reads only the Order column. If that column slot held a different key (first-key-wins),
   `create()` makes a **new** order with the retried cart. That is a duplicate order, not a re-fold. It is pre-existing
   and narrow: retries arrive within seconds, and an operator would have to confirm the order in that window. Follow-up
   row: `create()` consults `OrderIdempotencyKey` too.
2. **The Order-column stamp stays a best-effort second commit.** `recordIdempotencyKey` is unchanged, and the controller
   still calls it after the fold, because `create()`'s replay and the consolidation R6 carry read that column. Its
   failure no longer affects merge replay.
3. **Replay returns the order's current state.** `findOne` returns the order as it is now, not a byte snapshot of the
   first response. That is the same as `create()`'s replay. "The stored result" is the stored `orderId`.
4. **Key rows never expire.** There is no TTL and no sweep: one small row per keyed staff merge.
5. **`responseHash` holds the REQUEST fingerprint.** The column keeps the ruled name. It stores the SHA-256 of the
   canonical merge request whose result the row replays (see `mergeRequestHash`). The schema comment says so.
6. **Deleting an order deletes its keys.** Hard-deleting an order (`deleteOrder`, loser deletes) cascades its key rows.
   The two loser loops re-point keys to the winner first. Any other future hard-delete path drops them by design, since
   the order is gone.

## Constraints & conventions

- **Stack:**
  - NestJS 11, Prisma 7, Postgres.
  - `this.prisma.forTenant()` injects `tenantId` into `where`/`create` (`prisma.service.ts` `_tenantExtension`).
  - `tenantTransaction(cb, opts)` hands `cb` a proxy that does the same (`_wrapTxWithTenant`: `create` gets `tenantId`
    injected; `updateMany`/`findFirst` get it added to `where`).
  - `ConflictException` and `ForbiddenException` are already imported in `orders.service.ts` (used by `create()`).
- **Schema is a FOLDER** (`apps/api/prisma/schema/*.prisma`). A new model goes in the domain file (`sales.prisma`, next to
  `Order`) **and** into `MODEL_DOMAIN` in `apps/api/scripts/split-prisma-schema.mjs`, or `--check` fails.
- **Migrations:**
  - Additive only; Squawk-gated (`apps/api/.squawk.toml` keeps only the destructive rules, so `CREATE TABLE`,
    `CREATE INDEX` and `ADD CONSTRAINT … FOREIGN KEY` are clean).
  - The new directory must sort after the newest existing one, `20260910000000_order_idempotency`.
  - `migration.sql` under `apps/api/prisma/migrations/**` is re-included by a `.gitignore` negation (verified with
    `git check-ignore`), so it is tracked.
- **Tests:**
  - Jest.
  - Unit specs: `apps/api/src/**/*.spec.ts`, config inline in `apps/api/package.json` (no jest.config file). Run as
    `cd apps/api && npx jest <path> -t <pattern> --reporters=default`.
  - DB-lane specs: `*.db.spec.ts`, collected only by `apps/api/jest.db.config.js`. They must use `describeDb` +
    `requireLocalDatabaseUrl` (`apps/api/src/common/testing/db-spec.ts`) and `assertTestTenant`
    (`scripts/lib/test-tenants.cjs`) with throwaway `qa-*` slugs.
  - No snapshot tests, no Vitest.
- **Lint/format:** `npm run lint -w apps/api`, Prettier (semicolons, double quotes, printWidth 100, trailing commas).
- **Must NOT change:**
  - `recordIdempotencyKey` (byte-identical).
  - `create()`.
  - The Order column and `@@unique([tenantId, idempotencyKey])`.
  - `withAdvisoryLock` options on the merge path (`orders.merge-lock.spec.ts` pins them).
  - `updateOrderItems` behaviour for any caller that passes 3 arguments: the PATCH routes (`orders.controller.ts` ~400,
    `buyer.controller.ts` ~742) and the buyer merge (`buyer.controller.ts` ~617).
  - Existing specs (R1/R3 in `orders.scan-hardening.spec.ts` stay unedited and green).
- **Do-not-introduce:** a second lock; a tx threaded into `updateOrderItems`; any `@Cron`; a new HTTP client; Vitest.
- **Landmines:**
  1. Swallowing a Postgres error INSIDE a transaction leaves the tx aborted. So `recordMergeIdempotencyKey` never
     swallows P2002: it converts it to 409 and rethrows.
  2. Run `cd apps/api && npx prisma generate` after the schema edit, or `check-types` fails on `orderIdempotencyKey`
     (a stale client; memory "Stale Prisma client").
  3. `mapLockError(e)` in the controller rethrows anything that is not a lock error, so a `ConflictException` thrown
     inside the lock callback reaches the client as 409. Keep it that way.

## Lessons carried (cite ids)

- **L-096 / L-035 (grep the schema before designing a store).**
  - Done: `Order.idempotencyKey` (`sales.prisma` ~598, one slot per order) is the defect itself.
  - The global `IdempotencyKey` (`platform.prisma` ~690) is non-tenant-scoped, has no `orderId`, and belongs to
    RoutesService. It is not reusable.
  - The ruled new table stands.
- **L-068:** the durable record of intent must not be a separate, later write after the step that can fail. It commits
  in the fold's own transaction.
- **L-081:** gate the write inside the primitive that performs it (`updateOrderItems`), not at one call site.
- **L-061:** a unit mock cannot prove composition or rollback. D2/D3 prove the replay and the atomic rollback against the
  real unique constraint.
- **L-060:** every pin states its colour. A red pin escalates to a fix on the spot.
- **L-097:** REG titles carry `REG-B215` byte-for-byte.
- **L-063:** use `--reporters=default` on partial unit runs.
- **L-062:** the unit spec reads nothing outside `apps/api`.
- **CLAUDE.md money rules:** no second lock over `withAdvisoryLock`; never thread a tx into `updateOrderItems`.

---

## Test packages

Authored FIRST. Test-only edits (plus the one mock-helper line). No production code.

### TP1 — Unit REG + pins (controller and service)

- **writes:**
  - `apps/api/src/orders/orders.merge-idempotency.spec.ts` (NEW)
  - `apps/api/src/testing/prisma-mock.ts` (one line: add `orderIdempotencyKey: modelProxy(),` to the `allModels()`
    object, next to `idempotencyKey: modelProxy(),`)
- **tests:** T1-T10, P1-P4 (titles, setups and oracles exactly as bug-test-plan.md).
- **brief / harness to copy (do not invent):**
  - The three `jest.mock(...)` blocks at the top of `apps/api/src/orders/orders.scan-hardening.spec.ts` (~30-120:
    `../invoices/invoices.service`, `../notifications/notifications.service`, and the FIFO `../common/db-locks` mock).
    Copy them verbatim; they must precede the imports.
  - `buildOrdersService(prisma, gateway)` (~215-300 of the same file), `mockGateway`, `operatorPayload` (~182-188), and
    the `activeOrderFixture` literal (~1227-1246).
    - For T6/T7: add `findOpenOrderDraft: jest.fn().mockResolvedValue(null)` to its `InvoicesService` stub.
    - For T6/T7: make sure `PromotionsService.activeForCatalog` resolves `[]`.
  - `const buildController = (svc: any) => new OrdersController(svc, {} as any);` (as at ~673).
  - The service-level DRAFT-order `updateOrderItems` setup for T4/T5/T10/P4: copy the R10 test (~596-660 of the same
    file). Order `{ id: "ord-1", customerId: "cust-1", status: "DRAFT", routeRun: null, lineItems: [existingLine] }`,
    `product.findUnique`/`findMany` resolving `prod-B`, `orderItem.findMany` resolving priced rows.
  - The T6/T7 merge fixture: copy `seedMergeMocks` from `apps/api/src/orders/orders-promo-bogo.spec.ts` (~478-497).
    Winner `w1` first (the service takes `[winner, ...losers]` from `updatedAt desc`), loser `l1`, plain `STANDARD`
    lines with `promoFreeUnits: null`.
- **must fail with:** the "Fails TODAY with" column of bug-test-plan.md for T1-T10; P1-P4 GREEN.

**Exact code — the stateful fake OrdersService (T1-T3, P1, P2).** It mirrors the REAL semantics of each method: today's
column lookup and first-key-wins stamp, plus the table store the fix adds. The same fake therefore reproduces today's
double fold and proves the fixed controller's replay.

```ts
function statefulOrdersService(opts: { orderKey: string | null; throwAfterFirstFold?: boolean }) {
  const order = {
    id: "ord-active",
    customerId: "cust-1",
    idempotencyKey: opts.orderKey,
    total: 96,
  };
  const keyRows: Array<{ key: string; orderId: string; responseHash: string }> = [];
  let folds = 0;
  const svc: any = {
    findActiveOrder: jest.fn(async () => ({ ...activeOrderFixture })),
    // Table first (the fix's store), then the single Order column (today's store).
    findOrderIdByIdempotencyKey: jest.fn(
      async (key: string, customerId: string, requestHash?: string) => {
        const row = keyRows.find((r) => r.key === key);
        if (row) {
          if (requestHash !== undefined && row.responseHash !== requestHash) {
            throw new ConflictException("Idempotency-Key reused with a different cart");
          }
          return row.orderId;
        }
        return order.idempotencyKey === key && order.customerId === customerId ? order.id : null;
      },
    ),
    // Fold stand-in; records the key only when the caller hands it in (the fixed controller does).
    updateOrderItems: jest.fn(
      async (
        _id: string,
        _dto: unknown,
        _user: unknown,
        o?: { idempotency?: { key: string; responseHash: string } },
      ) => {
        folds += 1;
        order.total += 12;
        if (o?.idempotency) {
          keyRows.push({
            key: o.idempotency.key,
            orderId: order.id,
            responseHash: o.idempotency.responseHash,
          });
        }
        if (opts.throwAfterFirstFold && folds === 1) {
          throw new Error("reconcileOrderDraftInvoice failed after commit");
        }
      },
    ),
    // Today's real semantics: first key wins on the Order column.
    recordIdempotencyKey: jest.fn(async (_id: string, key: string) => {
      if (order.idempotencyKey == null) order.idempotencyKey = key;
    }),
    mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
    findOne: jest.fn(async () => ({ id: order.id, total: order.total })),
  };
  return { svc, order, keyRows };
}
const mergeDto = (qty = 5) =>
  ({ customerId: "cust-1", mergeChoice: "merge", items: [{ productId: "prod-1", qty }] }) as any;
```

T1 body (T2/T3 follow the same shape with the setups in bug-test-plan.md):

```ts
const { svc } = statefulOrdersService({ orderKey: "K0-created" });
const controller = buildController(svc);
await controller.create(mergeDto(), operatorPayload as any, "idem-K1");
await controller.create(mergeDto(), operatorPayload as any, "idem-K1");
expect(svc.updateOrderItems).toHaveBeenCalledTimes(1);
```

**Exact code — T5 transaction sequencing.**

```ts
let txSeq = 0;
let openTx = 0;
const createdInTx: number[] = [];
prisma.tenantTransaction.mockImplementation(async (fn: any) => {
  const mine = ++txSeq;
  const prev = openTx;
  openTx = mine;
  try {
    return await fn({
      ...prisma,
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([]),
    });
  } finally {
    openTx = prev;
  }
});
(prisma as any).orderIdempotencyKey.create.mockImplementation(async () => {
  createdInTx.push(openTx);
  return {};
});
await (service as any).updateOrderItems("ord-1", dto, operatorPayload, {
  idempotency: { key: "K1", responseHash: "h1" },
});
expect(createdInTx).toEqual([1]);
```

**Exact code — T6/T7 fake key store with FK-cascade semantics.**

```ts
const rows = [{ key: "K1", orderId: "l1" }];
prisma.order.delete.mockImplementation(async ({ where }: any) => {
  // ON DELETE CASCADE on OrderIdempotencyKey.orderId (the migration's FK).
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].orderId === where.id) rows.splice(i, 1);
  return {};
});
(prisma as any).orderIdempotencyKey.updateMany.mockImplementation(async ({ where, data }: any) => {
  let count = 0;
  for (const r of rows)
    if (r.orderId === where.orderId) {
      r.orderId = data.orderId;
      count++;
    }
  return { count };
});
await service.mergeAllPendingForCustomer("cust-1"); // T7: service.forceConsolidateCustomer("cust-1")
expect(rows.find((r) => r.key === "K1")?.orderId).toBe("w1");
```

Every 4-argument `updateOrderItems` call and every 3-argument `findOrderIdByIdempotencyKey` call goes through
`(service as any)`, so today's file compiles and fails on values, not on TS2554.

### TP2 — DB lane (real Postgres; REG D1-D4 + pins PD1-PD3)

- **writes:** `apps/api/src/orders/order-idempotency-key.db.spec.ts` (NEW).
- **tests:** D1, D2, D3, D4, PD1, PD2, PD3.
- **brief:** Follow `apps/api/src/prisma/tenant-findunique.db.spec.ts` for the lane shape: `describeDb`; nothing
  env-dependent at collection time; `beforeAll`/`afterAll` with 120 s hook timeouts; a raw superuser `PrismaClient` for
  fixtures; `new PrismaService(tenantCtx)` for the code under test; `tenantCtx.run(tenantId, fn)`. Copy the two
  `jest.mock` blocks for `../invoices/invoices.service` and `../notifications/notifications.service` from
  `orders.scan-hardening.spec.ts` (~30-50) to the top.
- **must fail with:** D1 `Expected "<uuid>", Received null`; D2 `Expected 110, Received 120`; D3 `Expected 100,
Received 110`. PD1/PD2 GREEN.

**Exact code — the skeleton (transcribe; fill the five `it` bodies from bug-test-plan.md).**

```ts
jest.mock("../invoices/invoices.service", () => ({/* copy from orders.scan-hardening.spec.ts */}));
jest.mock("../notifications/notifications.service", () => ({/* copy */}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { OrdersService } from "./orders.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

interface Fx {
  tenantId: string;
  userId: string;
  customerId: string;
  orderId: string;
}

describeDb("B215 OrderIdempotencyKey — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let svc: any;
  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-idem-${run}-a`, "order-idempotency-key.db.spec.ts");
  const slugB = assertTestTenant(`qa-idem-${run}-b`, "order-idempotency-key.db.spec.ts");
  let tenantA = "";
  let tenantB = "";
  const created: Fx[] = [];

  async function seed(tenantId: string, tag: string, orderKey: string | null): Promise<Fx> {
    const user = await raw.user.create({
      data: {
        email: `${tag}-${run}@example.test`,
        username: `${tag}-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await raw.customer.create({
      data: { userId: user.id, businessName: `${tag} co`, contactName: "Idem Tester", tenantId },
    });
    const order = await raw.order.create({
      data: { customerId: customer.id, tenantId, total: "100.00", idempotencyKey: orderKey },
    });
    const fx = { tenantId, userId: user.id, customerId: customer.id, orderId: order.id };
    created.push(fx);
    return fx;
  }

  async function totalOf(orderId: string): Promise<number> {
    return Number((await raw.order.findUniqueOrThrow({ where: { id: orderId } })).total);
  }

  // The staff merge branch's persistence sequence with a raw +10 fold stand-in:
  // replay lookup -> ONE fold transaction (+ the in-tx key write once the fixed service
  // exposes it) -> the controller's post-commit Order-column stamp (kept by the fix).
  async function mergeOnce(f: Fx, key: string, hash: string): Promise<"replayed" | "folded"> {
    return tenantCtx.run(f.tenantId, async () => {
      if (await svc.findOrderIdByIdempotencyKey(key, f.customerId, hash)) return "replayed";
      await prisma.tenantTransaction(async (tx: any) => {
        await tx.$executeRaw`UPDATE "Order" SET "total" = "total" + 10 WHERE "id" = ${f.orderId}`;
        if (typeof svc.recordMergeIdempotencyKey === "function") {
          await svc.recordMergeIdempotencyKey(tx, f.orderId, { key, responseHash: hash });
        }
      });
      await svc.recordIdempotencyKey(f.orderId, key);
      return "folded";
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    svc = Object.assign(Object.create(OrdersService.prototype), { prisma });
    tenantA = (await raw.tenant.create({ data: { slug: slugA, name: `Idem ${slugA}` } })).id;
    tenantB = (await raw.tenant.create({ data: { slug: slugB, name: `Idem ${slugB}` } })).id;
  }, 120_000);

  afterAll(async () => {
    // Key rows go with their orders (FK ON DELETE CASCADE once the migration exists).
    for (const f of created) {
      await raw.order.deleteMany({ where: { id: f.orderId } });
      await raw.customer.deleteMany({ where: { id: f.customerId } });
      await raw.user.deleteMany({ where: { id: f.userId } });
    }
    await raw.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  // it("REG-B215 D1: …"), it("REG-B215 D2: …"), it("REG-B215 D3: …"),
  // it("B215 pin PD1: …"), it("B215 pin PD2: …") — setups/oracles per bug-test-plan.md.
  // Keys are unique per test: `K1-${run}-d1`, `K0-${run}-d1`, … (the Order column is unique per tenant).
});
```

D3 body (the pre-fold refusal — the replay lookup rejects a key already held by another customer's order, so the fold
transaction is never opened):

```ts
const b = await seed(tenantA, "d3b", null);
const a = await seed(tenantA, "d3a", `K0-${run}-d3`);
const key = `K1-${run}-d3`;
await mergeOnce(b, key, "h-d3b");
await expect(mergeOnce(a, key, "h-d3a")).rejects.toBeInstanceOf(ConflictException);
expect(await totalOf(a.orderId)).toBe(100);
```

D4 body (the atomicity proof — the in-tx P2002 rollback the pre-fold refusal cannot reach; skips the replay lookup to
simulate a collision that only appears after it):

```ts
const b = await seed(tenantA, "d4b", null);
const a = await seed(tenantA, "d4a", `K0-${run}-d4`);
const key = `K1-${run}-d4`;
await mergeOnce(b, key, "h-d4b");
await expect(
  tenantCtx.run(a.tenantId, () =>
    prisma.tenantTransaction(async (tx: any) => {
      await tx.order.update({ where: { id: a.orderId }, data: { total: 110 } });
      await svc.recordMergeIdempotencyKey(tx, a.orderId, { key, responseHash: "h-d4a" });
    }),
  ),
).rejects.toBeInstanceOf(ConflictException);
expect(await totalOf(a.orderId)).toBe(100);
expect(await raw.orderIdempotencyKey.count({ where: { orderId: a.orderId, key } })).toBe(0);
```

**Red gate command** (every REG test must fail on its value; no pin may be red):

```bash
cd apps/api && npx jest src/orders/orders.merge-idempotency.spec.ts -t "REG-B215" --reporters=default
node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api -- order-idempotency-key -t REG-B215"
```

---

## Work packages

### WP1 — Model, migration, MODEL_DOMAIN

- **files:**
  - `apps/api/prisma/schema/sales.prisma`
  - `apps/api/prisma/migrations/20260911000000_order_idempotency_key_table/migration.sql` (NEW directory + file)
  - `apps/api/scripts/split-prisma-schema.mjs`
- **provenBy:** D1-D4, PD1, PD2, PD3 (and the schema gates in final verify)
- **dependsOn:** none
- **effort:** high (tenancy/migration)
- **brief:**
  1. In `sales.prisma`, add the model directly after `model Order { … }`.
  2. Inside `model Order`, add the back-relation line after `orderCreditNotes  OrderCreditNote[]`.
  3. In `split-prisma-schema.mjs` `MODEL_DOMAIN`, add `OrderIdempotencyKey: "sales",` on the line after
     `Order: "sales",`.
  4. Create the migration file with exactly the SQL below.
  5. Run `cd apps/api && npx prisma generate` so the client knows the delegate.
- **exact code:**

```prisma
/// B215: one row per staff-merge Idempotency-Key. Written by
/// OrdersService.recordMergeIdempotencyKey INSIDE updateOrderItems' own transaction, so the key
/// commits or rolls back together with the fold it guards. An order may hold many keys (every
/// merge wave keeps its own); a key belongs to exactly one order per tenant. `responseHash` is the
/// SHA-256 fingerprint (merge-idempotency.ts mergeRequestHash) of the request whose result this
/// row replays — a same-key retry with a different cart is refused (409). The consolidation
/// sweeps re-point a loser's rows onto the winner before deleting the loser.
/// NOT the global `IdempotencyKey` model (platform.prisma — RoutesService stop replay).
model OrderIdempotencyKey {
  id           String   @id @default(uuid())
  tenantId     String
  key          String
  orderId      String
  responseHash String
  createdAt    DateTime @default(now())

  order Order @relation(fields: [orderId], references: [id], onDelete: Cascade)

  @@unique([tenantId, key])
  @@index([orderId])
}
```

```prisma
  // (inside model Order, after orderCreditNotes)
  mergeIdempotencyKeys OrderIdempotencyKey[]
```

```sql
-- B215: additive-only per-request idempotency store for the staff create-merge branch
-- (POST /orders mergeChoice:"merge"). One row per Idempotency-Key per tenant, written inside the
-- fold's own transaction so the key and the fold commit together. Replaces nothing: the existing
-- Order."idempotencyKey" column and its unique index are untouched. No backfill; no reader or
-- writer until this PR's server half deploys, so applying it ahead of the deploy is safe.

-- CreateTable
CREATE TABLE "OrderIdempotencyKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "responseHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderIdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderIdempotencyKey_orderId_idx" ON "OrderIdempotencyKey"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderIdempotencyKey_tenantId_key_key" ON "OrderIdempotencyKey"("tenantId", "key");

-- AddForeignKey
ALTER TABLE "OrderIdempotencyKey" ADD CONSTRAINT "OrderIdempotencyKey_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

The SQL must equal what Prisma would generate for the model. The final-verify drift gate (`npm run local:drift`, exit 0)
is the proof. If the drift gate prints a diff, correct the SQL to match it; never edit the model to match the SQL.

### WP2 — OrdersService: table-first replay, in-tx key write, loser re-point

- **files:** `apps/api/src/orders/orders.service.ts`
- **provenBy:** T4, T5, T6, T7, T8, T9, T10, D1, D2, D3, D4, P3, P4
- **dependsOn:** WP1
- **effort:** high (money path)
- **brief:** Five surgical edits. Nothing else in this 6000-line file changes. `recordIdempotencyKey` stays
  byte-identical.

**Edit 1 — replace the body of `findOrderIdByIdempotencyKey`** (~1638-1647) and extend its JSDoc with one B215
sentence:

```ts
  async findOrderIdByIdempotencyKey(
    idempotencyKey: string,
    customerId: string,
    requestHash?: string,
  ): Promise<string | null> {
    // B215: every staff merge wave records its OWN key in OrderIdempotencyKey (written inside
    // the fold's transaction by recordMergeIdempotencyKey), so that table is the authoritative
    // replay store for the merge branch. Scoped to THIS customer through the order relation —
    // the key is client-chosen, so a bare match could replay onto another customer's order.
    const keyed = await this.prisma.forTenant().orderIdempotencyKey.findFirst({
      where: { key: idempotencyKey, order: { customerId } },
      select: { orderId: true, responseHash: true },
    });
    if (keyed) {
      if (requestHash !== undefined && keyed.responseHash !== requestHash) {
        throw new ConflictException(
          "Idempotency-Key reused with a different cart — submit the edited cart as a new order (new key), or retry the original unchanged",
        );
      }
      return keyed.orderId;
    }
    // The single Order column: keys stamped by create() and by recordIdempotencyKey. Unchanged.
    const existing = await this.prisma.forTenant().order.findFirst({
      where: { idempotencyKey, customerId },
      select: { id: true },
    });
    return existing?.id ?? null;
  }
```

**Edit 2 — add `recordMergeIdempotencyKey` directly after `recordIdempotencyKey`** (which stays as is):

```ts
  /**
   * B215: record a staff merge's Idempotency-Key in OrderIdempotencyKey through the FOLD's own
   * transaction client `tx`, so the key and the fold commit — or roll back — together. Called
   * only from updateOrderItems' transaction callback. A P2002 means the key already belongs to
   * another request (every same-customer retry is answered by the replay pre-check before the
   * fold), so it aborts the fold with a 409: swallowing an error inside a Postgres transaction
   * would leave the transaction aborted anyway. Uses only this.prisma (the DB lane builds this
   * service without DI).
   */
  async recordMergeIdempotencyKey(
    tx: any,
    orderId: string,
    idem: { key: string; responseHash: string },
  ): Promise<void> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) {
      throw new ForbiddenException("Idempotency-Key requires a tenant-scoped session");
    }
    try {
      await tx.orderIdempotencyKey.create({
        data: { tenantId, key: idem.key, orderId, responseHash: idem.responseHash },
      });
    } catch (e: any) {
      if (e?.code === "P2002") {
        throw new ConflictException("Idempotency-Key already used for a different order");
      }
      throw e;
    }
  }
```

**Edit 3 — `updateOrderItems` signature** (~3069):

```ts
  async updateOrderItems(
    orderId: string,
    dto: UpdateOrderItemsDto,
    user?: JwtPayload,
    // B215: set ONLY by the staff create-merge branch (OrdersController.create). Not reachable
    // from a request body — the PATCH routes and the buyer merge call with three arguments.
    opts?: { idempotency?: { key: string; responseHash: string } },
  ) {
```

**Edit 4 — inside the fold transaction** (the `tenantTransaction` callback opened at ~3225). Insert immediately
before its closing `return { subtotal, tax, total, shouldRevert, shippingFee };` (~4280), after the `tx.order.update`:

```ts
// B215: the merge's replay key commits in THIS transaction, atomically with the fold —
// never a second, later commit that a crash or a post-commit throw can split off.
if (opts?.idempotency) {
  await this.recordMergeIdempotencyKey(tx, orderId, opts.idempotency);
}
```

**Edit 5 — both consolidation loser loops.**

- In `mergeAllPendingForCustomer` (loop at ~1139-1142) and in `forceConsolidateCustomer` (loop at ~1427-1438), insert
  the code below immediately before `await tx.order.delete({ where: { id: loser.id } });`.
- Both functions name the survivor `winner` (`const [winner, ...losers] = …`).

```ts
// B215: a loser's merge keys follow its cart onto the winner. The FK cascade would
// otherwise delete them with the loser, and a retry of that merge would fold the
// same cart into the winner a second time.
await tx.orderIdempotencyKey.updateMany({
  where: { orderId: loser.id },
  data: { orderId: winner.id },
});
```

### WP3 — Controller merge branch + request fingerprint helper

- **files:**
  - `apps/api/src/orders/orders.controller.ts`
  - `apps/api/src/orders/merge-idempotency.ts` (NEW)
- **provenBy:** T1, T2, T3, P1, P2
- **dependsOn:** WP2 (calls the new 4-argument signature and the 3-argument lookup)
- **effort:** high
- **brief:**
  1. Create the pure helper file.
  2. In the controller's `choice === "merge"` branch: compute the fingerprint once, before `let merged`.
  3. Pass it to the replay lookup.
  4. Hand the key into the fold.
  5. Keep the post-fold `recordIdempotencyKey` try/catch but rewrite its comment.

  Leave untouched: the lock options, the stale branch, the post-commit sweep and `findOne`.

- **exact code — `merge-idempotency.ts`:**

```ts
import { createHash } from "crypto";

// Canonical JSON: object keys sorted, undefined-valued keys dropped (an absent field and a
// missing field fingerprint the same), arrays kept in order at this level.
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * B215: the fingerprint of a staff merge request, stored as OrderIdempotencyKey.responseHash.
 * A same-key retry is replayed only when its fingerprint matches; a same key with a different
 * cart is refused (409), mirroring create()'s R4 content check. Item order does not matter.
 */
export function mergeRequestHash(input: {
  customerId: string;
  items?: readonly unknown[] | null;
  appliedCreditNotes?: unknown;
}): string {
  const items = (input.items ?? []).map(stable).sort();
  return createHash("sha256")
    .update(
      stable({
        customerId: input.customerId,
        items,
        appliedCreditNotes: input.appliedCreditNotes ?? null,
      }),
    )
    .digest("hex");
}
```

- **exact code — controller (import + the three edits inside the merge branch):**

```ts
import { mergeRequestHash } from "./merge-idempotency";
```

```ts
// B215: the fingerprint a same-key retry must match to be replayed (stored with the key).
const requestHash = idempotencyKey
  ? mergeRequestHash({
      customerId: dto.customerId!,
      items: dto.items,
      appliedCreditNotes: dto.appliedCreditNotes,
    })
  : undefined;
let merged: { kind: "merged"; orderId: string; replayed: boolean } | { kind: "stale" };
```

```ts
if (idempotencyKey) {
  // B215: reads OrderIdempotencyKey (every merge wave's own key) before the Order
  // column; the same key with a different cart is refused (409), never folded.
  const replayedOrderId = await this.ordersService.findOrderIdByIdempotencyKey(
    idempotencyKey,
    dto.customerId!,
    requestHash,
  );
  if (replayedOrderId) return { kind: "merged" as const, orderId: replayedOrderId, replayed: true };
}
const mergedItems = foldMergeItems(current.lineItems ?? [], dto.items ?? []);
const foldDto = {
  items: mergedItems,
  // (keep the existing replaceAll comment block here verbatim)
  replaceAll: true,
  // (keep the existing appliedCreditNotes comment verbatim)
  ...(dto.appliedCreditNotes !== undefined ? { appliedCreditNotes: dto.appliedCreditNotes } : {}),
} as any;
if (idempotencyKey) {
  // B215: the key rides INTO updateOrderItems and commits inside the fold's own
  // transaction — a crash or a later throw can no longer separate the two. The
  // 4th argument is passed ONLY when a key exists, so keyless merges keep the
  // exact three-argument call.
  await this.ordersService.updateOrderItems(current.id, foldDto, user, {
    idempotency: { key: idempotencyKey, responseHash: requestHash! },
  });
} else {
  await this.ordersService.updateOrderItems(current.id, foldDto, user);
}
```

Replace the comment above the kept `recordIdempotencyKey` try/catch with:

```ts
// Order-column stamp, kept for create()'s replay path (first key wins, best-effort,
// a separate commit). Merge replay no longer depends on it: the authoritative key
// row committed together with the fold above (B215).
```

### Package map

| WP  | provenBy              | dependsOn | Wave  |
| --- | --------------------- | --------- | ----- |
| TP1 | T1-T10, P1-P4         | —         | tests |
| TP2 | D1-D4, PD1-PD3        | —         | tests |
| WP1 | D1-D4, PD1-PD3        | —         | 1     |
| WP2 | T4-T10, D1-D4, P3, P4 | WP1       | 2     |
| WP3 | T1-T3, P1, P2         | WP2       | 3     |

File lists are disjoint. The chain is typed, not invented: WP2 needs the generated `orderIdempotencyKey` delegate, and
WP3 calls WP2's new signatures.

---

## Acceptance criteria

1. A same-key staff merge retry onto an order that already carries a key performs exactly one fold (T1, D2).
2. A retry after a post-commit throw inside `updateOrderItems` performs exactly one fold (T2).
3. The key row is inserted through the fold transaction's client, inside the first `tenantTransaction` of
   `updateOrderItems`, and a failed insert rolls the fold back (T5, T10, D4).
4. The same key with a different cart is refused with 409 and nothing is folded (T3, T9).
5. A key owned by another customer is never replayed (PD1) and, if reused, is refused before the fold (D3) — and,
   when the collision only appears after the replay lookup, aborts the fold through the real unique constraint (D4).
6. The consolidation sweeps keep a loser's keys replayable on the winner (T6, T7).
7. Keyless merges, the PATCH routes and the buyer merge call `updateOrderItems` exactly as before (P1, P4; the three
   existing `toHaveBeenCalledWith` tests stay green unedited).
8. `create()`-path keys on the Order column still replay a merge (P2, P3); `recordIdempotencyKey` is byte-identical
   and the existing R1/R3 tests pass unedited.
9. Schema gates: `split-prisma-schema.mjs --check` exit 0; `lint:migrations` on the new file exit 0; the local drift gate
   exit 0 after `prisma migrate deploy`.
10. Deploy day: old code never reads the table; existing orders and keys behave as before.

## Verification commands

Per round (after every implementation wave):

```bash
npm run check-types -w apps/api
npm run lint -w apps/api
```

Final (once; compose Postgres must be up — `npm run db:up` — before launch):

```bash
cd apps/api && npx jest src/orders/ src/buyer/buyer.merge-lock --reporters=default
node apps/api/scripts/split-prisma-schema.mjs --check
node scripts/lint-migrations.mjs --files apps/api/prisma/migrations/20260911000000_order_idempotency_key_table/migration.sql
node scripts/local-env.mjs --db -- "cd apps/api && npx prisma migrate deploy"
npm run local:drift
node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api -- order-idempotency-key"
```

## Sibling sweep

None plausible (S3.5 evidence from the master re-grounding, 2026-09-10):

- `idempotencyKey:\s*null` hits only the defect line (~1670) and the consolidation R6 carry (~1131, a different
  operation).
- A broad `updateMany({… : null` sweep found only FK detach/cleanup writes, never a set-once guard.
- `e?.code !== "P2002"` appears only at the defect's own catch.
- The buyer merge (`buyer.controller.ts` ~617) folds with no key at all, so it is a different gap, not a twin.

`siblingPatterns` is therefore omitted from the args.

## Data repair (S3.6) — report only; nothing ships in this run

**Could prod rows already be corrupted?** Plausibly yes. Any staff merge whose target order already carried a key,
re-delivered with the same key, doubled that cart on the order. That applies to every order created by mobile with a
key, and to every second merge wave. The owner approved running a read-only report during train 4; the owner decides any
repair separately. No backfill ships with the fix.

**Report spec** (to be written as `apps/api/scripts/report-b215-doubled-merges.mjs` in a separate docs/ops step; NOT in
this run). Run it via `railway run --service postgres node apps/api/scripts/report-b215-doubled-merges.mjs`.

- First statement `BEGIN READ ONLY;` plus `SET TRANSACTION READ ONLY`. SELECT-only. Refuse to run if
  `current_setting('transaction_read_only') <> 'on'`.
- **Signal:** two consecutive `OrderRevision` rows on the same order, same `editedById`, ≤ 120 s apart, whose snapshot
  line deltas are identical (the second step added exactly the same productId/qty multiset as the first). The report
  author must read `appendOrderRevision` in `orders.service.ts` first to learn the `snapshot` JSON shape and the
  `source` value the merge path writes.
- **Output:**
  - candidate count
  - per candidate: order id, the two revision ids, `revisionNumber`s, seconds apart, and the delta multiset size
  - a per-tenant count bucketed by an ordinal (tenant #1..n), never slug, name or tenant UUID
  - no business names, no product names
- **Also:** count orders with non-null `idempotencyKey` created since the merge branch shipped (F30/R8 merge date), to
  size exposure.

## Landing order (schema change — owner-approved migration, inside train 4's window)

1. **Before the deploy:**
   - Fresh prod backup: `./apps/api/scripts/backup-production.sh pre-b215-order-idempotency-key`.
   - Then `railway run --service postgres node apps/api/scripts/prod-migrate.mjs`. It prints status, runs
     `migrate deploy`, and then runs the read-only drift check, failing closed.
2. **Schema-drift gate at exit 0:** `railway run --service postgres node apps/api/scripts/schema-drift.mjs` must exit 0
   (run from the PR branch tree, whose schema folder carries the model). The new table is invisible to the old code
   still serving, so migrating ahead of the code is safe.
3. Then the canonical flow: watchdog, then public, then push, CI green, squash-merge. Railway deploys.
4. Wait for both deployments to reach `SUCCESS`, then flip private (as a `finally`).
5. **After the deploy reaches `SUCCESS`:** run `schema-drift.mjs` against prod again. Exit 0 is required (CLAUDE.md: every
   schema PR). Then `npm run post-deploy-check`.
6. Bookkeeping — **superseded: it lands IN-PR** (owner ruling 2026-09-10, after this plan was written), so there is
   no follow-up PR and the code PR's HEAD carries **no** `Bookkeeping-Follow-Up` trailer:
   - Code-map entries in `api.md` (`orders.controller.ts`, `orders.service.ts`, `merge-idempotency.ts`, `sales.prisma`,
     the two new specs, the migration) and `mobile.md` (the client half), plus `_meta.json` + `CHANGELOG.md`.
   - Registry close-out of B215 with proof `REG-B215` (T1-T17, D1-D4), pending deploy.
   - Lesson **L-104** (L-099 archived for headroom) — an idempotency key must cover the whole unit of work.

## Risks & rollback

| Risk                                                                                                                        | Likelihood | Blast radius                                                                                                                                 | Watch                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Edit 4 lands outside the fold tx (after `tenantTransaction` resolves)                                                       | low        | the double-fold returns via the post-commit window                                                                                           | T5 (`createdInTx` = `[1]`) and **D2** — D3 became the pre-fold refusal and never opens the fold tx (corrections) |
| A swallowed P2002 inside the tx                                                                                             | low        | every merge 500s ("transaction aborted")                                                                                                     | Landmine 1; T10 expects 409                                                                                      |
| Stale Prisma client in the worktree                                                                                         | med        | per-round `check-types` red at Baseline                                                                                                      | Launcher runs `cd apps/api && npx prisma generate` after WP1; WP1 runs it too                                    |
| Compose DB shared with Runs A/C/D                                                                                           | med        | after the final `migrate deploy`, the compose DB carries the extra table, so another run's `local:drift` against master reads DRIFT (exit 2) | Sequence Run B's final verify after the other runs' drift checks, or `npm run local:reset` + re-seed afterwards  |
| Service `revertFix` probe goes red by TS2554 (the fixed controller calls the reverted 3-param service) rather than by value | high       | probe evidence is structural for that file                                                                                                   | The behavioral witness for the service is D2 (`Expected 110, Received 120`), which imports only the service      |
| Migration SQL differs from Prisma's rendering                                                                               | low        | drift exit 2 in final verify / prod                                                                                                          | Fix the SQL to the printed diff; never the model                                                                 |

- **Rollback:**
  - Revert the code PR. Old code ignores the table; merges fall back to today's behaviour (with the bug).
  - The table can stay. It is additive, and old code neither reads nor writes it.
- **Migration reversibility:** no down migration. Dropping the table would need a `-- reason:` + `-- squawk-ignore
ban-drop-table` migration. Do not do that without the owner.
- **Feature flag / entitlement:** none.
- **Deploy day:**
  - Existing orders and keys are unaffected.
  - The first keyed staff merge after the deploy writes the first row.
  - No backfill is required; the data-repair question is a separate owner decision.
- **Observability:**
  - A 409 "Idempotency-Key reused with a different cart" or "already used for a different order" on `POST /orders`
    means the new guard fired.
  - A spike of 500s with "current transaction is aborted" on merges means Landmine 1 regressed.

---

## Pipeline args

Canonical JSON: `pipeline-args.json` beside this file (kept under 4 KB; the launcher fills the date in both paths and
adds `startedAt`/`workdir`). Summary of its content:

> Amended 2026-09-10 (lead): --reporters=default moved LAST — Jest reads positionals after it as reporter modules (proven in wf_363f0377-624 Baseline).

> Amended 2026-09-10 (lead): --passWithNoTests on final Jest commands whose only targets are new spec files, so Baseline does not exclude them (wf_363f0377-624 trap); close-out must confirm the T#/REG tests actually executed in the final gate.

- `mode: "bugfix"`, `scale: "major"`, `planPath`/`testPlanPath` =
  `.claude/pipeline/2026-09-10-train4-run-b/{build-plan,bug-test-plan}.md`, `lessonsPath: .claude/lessons/LESSONS.md`.
- `radiusFiles`:
  - the controller, the service, `merge-idempotency.ts`
  - `sales.prisma`, the migration, `split-prisma-schema.mjs`
  - `prisma-mock.ts`, both new specs, `orders.scan-hardening.spec.ts`
  - `db-locks.ts` (context)
- `testPackages` TP1/TP2 → this file's Test packages; `redGate` = the two commands above, `expect: "fail"`.
- `packages` WP1 → WP2 → WP3 (`dependsOn` chain), `effort: "high"` each.
- `verifyCommands.perRound` = api check-types + api lint; `final` = the six commands above.
- `mutationProbe.targets`:
  - `orders.service.ts` (`revertFix`, test REG-B215 T4 / D2)
  - `orders.controller.ts` (`revertFix`, REG-B215 T1)
  - `merge-idempotency.ts` (behavior probe, REG-B215 T3)
- `siblingPatterns` omitted (none plausible).

## Manual verification

Behaviour with no pure helper to unit-test. Run once against the local stack before the PR.

| ID          | Check                                                                                                                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REG-B215-M1 | switching customer rotates the submit key — mobile New order: pick customer A, add a line, tap **Change customer**, pick B, submit. The POST carries a DIFFERENT `Idempotency-Key` than A's cart would have sent, and no 409. Re-picking A instead of B must KEEP the key (a retry of A's cart still replays). |

## Post-implementation corrections (light-loop round 1, 2026-09-11)

The design above is preserved as written. What the tree does differently:

1. **D3 was retitled and re-scoped; D4 was added.** The fix added a PRE-FOLD refusal (the tenant-wide
   `heldByAnotherOrder` branch of `findOrderIdByIdempotencyKey`), so D3 proves that refusal and never opens the fold
   transaction. The in-transaction P2002 rollback the Risks table's first row cares about is proved by **D2**
   (behavioural double-fold witness) and by the post-hoc **D4**.
2. **The `typeof svc.recordMergeIdempotencyKey === "function"` feature probe is gone** from the DB lane's `mergeOnce`:
   the call is unconditional, so a missing method or table fails loudly rather than silently skipping the write.
3. **Bookkeeping is in-PR**, not Option B — see the corrected bullet above.
4. **The lookup order changed** (round-1 review finding): key table (this customer) → this customer's own
   `Order.idempotencyKey` column → tenant-wide refusal. The reverse order turned a legitimate replay of the caller's
   own key into a permanent 409 whenever any other customer held a key-table row.
5. **The post-fold tail is now re-run on replay.** `reconcileOrderAfterEdit` (private) holds the invoice
   resync/reconcile choice + the Serializable credit sync+settle; `replayMergeReconcile` (public) is called by the
   controller on its `replayed: true` path, inside the customer advisory lock. `appendOrderRevision` and the status
   event stay fold-only.
6. **Both Idempotency-Key 409s carry a machine-readable body** `{ code: "IDEMPOTENCY_KEY_CONFLICT", reason, orderId,
message }`; the message no longer tells the operator to mint a "new key" (no client can without abandoning the
   cart). Mobile offers "Open order" instead.
7. **`create()` consults the key table** (private `findReplayCandidateByKey`), pre-check and P2002 recovery alike.
8. **`mergeRequestHash` sorts `appliedCreditNotes`** as well as `items`.
9. **`apply-rls.js`'s `TENANT_TABLES` lists `OrderIdempotencyKey`** — the step that actually arms RLS in prod, missed
   in the first pass (the parked deferred-RLS migration alone was not enough).
10. **Test numbering:** the planned create()-replay case is **T16**, not T14 — T14 was already taken by the
    tenant-less `recordMergeIdempotencyKey` refusal. New: T2b, T11b, T16, T17, and the manual `REG-B215-M1`.

## Post-implementation corrections (light-loop round 2, 2026-09-11)

Opus refute-first review of `cfb3c331`; Fable's round-2 fix designs R1-R5 implemented.

1. **R1 — `findOrderIdByIdempotencyKey` returns `{ orderId, verified } | null`.** `verified` is true only for a
   key-TABLE hit whose stored `responseHash` matched the request fingerprint (a caller that passes no hash gets
   `false`); a COLUMN hit is always `false`, since the column stores no fingerprint. The controller forwards the retry
   body's `appliedCreditNotes` to `replayMergeReconcile` only when `verified`, `undefined` otherwise, and
   `reconcileOrderAfterEdit` documents + keeps the explicit `!== undefined` guard around `syncOrderCreditSelections`
   ("never touch the stored selection"). Pin `T2c` (+ positive control, + service half).
2. **R2 — post-delivery replay reconciles or refuses.** The fold's partial-billing guard is extracted as the pure
   `shouldSkipInPlaceResync(lines)` in `apps/api/src/orders/merge-idempotency.ts` and used by BOTH callers:
   `updateOrderItems` over the pre-edit snapshot, `replayMergeReconcile` over the CURRENT lines. **The guard is not
   always reproducible**, so `T2e` stands: a replace-all fold resets `invoicedQty` to 0, so "nothing invoiced" is
   ambiguous. A non-VOID invoice count separates the two states — none → the resync is a proven no-op (route it), one
   or more → `logger.warn` + `ConflictException({ code: IDEMPOTENCY_REPLAY_NEEDS_RECONCILE, orderId, message })`. The
   "provably the same routing" comment is gone. Mobile's 409 handler treats the new code exactly like
   `IDEMPOTENCY_KEY_CONFLICT` (Open order).
3. **R3 — mobile per-customer submit keys.** `apps/mobile/lib/order-submit-key.ts` holds `Map<customerId, key>` with
   `getOrderSubmitKey(customerId)` / `resetOrderSubmitKey(customerId)` / `clearAllOrderSubmitKeys()` and a `__none__`
   slot; `keyCustomerIdRef` and the round-1 onPick/onChangeCustomer rotation are removed. The submit site, the mount
   reset, the success path and the 409 "Open order" path all pass the selected `customerId`.
4. **R4 — `findReplayCandidateByKey(key, customerId)`.** Own key-table row → own column → tenant-wide table row →
   tenant-wide column, each loaded with the caller's `include` in ONE query (a select-then-reread would have made the
   own-column hit invisible to the existing mock harnesses). Pin `T18`.
5. **R5 — plan hygiene.** Both plans' Status lines now read round 2; the harness-contract notes carry the new return
   shape and the re-verified line refs; `(proved by D3)` was already `D4` at `cfb3c331`.

**Gates (round 2):** `apps/api` orders+buyer+schema-folder lane 17 suites / 480 tests green; `check-types` clean;
`lint` 0 errors; DB lane `order-idempotency-key` 7/7; `apps/mobile` check-types clean and 127 suites / 1555 tests
green; prettier clean on every touched file; full `apps/api` lane green (see the commit body).
