# Plan: P5-08b — credit-limit + stock inline guards on order edit

> Authored by Fable 5 on 2026-07-13. Status: DRAFT
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

Complete the P5-08 acceptance criterion "credit / regulated / stock-violating edit blocked inline" on `OrdersService.updateOrderItems`. P5-08 (shipped, live) added the edit-window gate and OrderRevision versioning and kept the existing regulated/license guard, but deferred two greenfield guards. Build them now:

1. **Credit-limit guard** (money-critical): an edit whose projected order total pushes the customer's total credit exposure over `Customer.creditLimit` throws `409 { code: "CREDIT_LIMIT_EXCEEDED", limit, exposure }` — for ALL roles.
2. **Stock guard** (validate-only): a CUSTOMER/DRIVER edit that _increases_ a product's quantity beyond available `Product.currentStock` throws `409 { code: "INSUFFICIENT_STOCK", productId, available, requested }`; operators/admins are warn-only (they may oversell — matches `create()`).

A blocked edit must leave the order, its items, and its revision history completely untouched. This lands on the already-created branch `feat/p5-08b-edit-guards` (off `master`, at commit `25ee765`). All file/line references below are against that commit.

## Constraints & conventions

- **Repo**: RouteFlow monorepo. API = NestJS 11 + Prisma 7/PostgreSQL at `apps/api`. Everything in this plan is API-only — no web/mobile changes.
- **NO Prisma migration.** All columns exist already — verified: `Customer.creditLimit Decimal? @db.Decimal(10,2)` (`apps/api/prisma/schema.prisma:685`), `Product.currentStock Decimal @default(0) @db.Decimal(10,3)` (`schema.prisma:849`), `Transaction.totalOwed/totalPaid` (`schema.prisma:1317-1323`), `InvoiceStatus` enum incl. `PAID/VOID/WRITTEN_OFF` (`schema.prisma:178-187`). Do not touch `schema.prisma` or `prisma/migrations/`.
- **No new dependencies. No new NestJS providers/injections.** `OrdersService`'s constructor must NOT gain a dependency (e.g. do NOT inject `CustomersService`) — that would break the existing `orders.service.spec.ts` TestingModule setup, which must keep passing without modification.
- **Money math discipline** (CLAUDE.md): money only via `apps/api/src/common/pricing.ts` helpers (`roundMoney`, `computeLineSubtotal`). Never re-derive `qty*unitPrice` for a boxed line; never re-derive a discount from `originalPrice`. The credit guard's projected total is the **same** `roundMoney(subtotal + tax)` that `updateOrderItems` already computes from stored line `subtotal`s (which were written via `computeLineSubtotal`) and is about to persist — no second money formula anywhere in this change.
- **Credit exposure formula must mirror `CustomersService.getStatementForOperator`** (`apps/api/src/customers/customers.service.ts:556-667`) — the authoritative customer-balance derivation. Do not invent a new balance formula. Notes on the mirror:
  - Open invoice balance = `Number(invoice.total) − Σ payments.amount` over invoices whose `status ∉ {PAID, VOID, WRITTEN_OFF}` (statement lines 608-610). DRAFT invoices count, deliberately.
  - Open-order bucket = `order.total` over orders in `{PENDING, CONFIRMED, OUT_FOR_DELIVERY}` (statement lines 594-600, 627).
  - The guard does NOT read the `Transaction` model: a delivered order gets BOTH a `Transaction` row and an auto-created invoice, so mixing Transaction totals with invoice balances double-counts. The statement itself derives from invoices + open orders; the guard mirrors that.
  - Deviations from the statement, each deliberate: (a) no `take: 100`/`take: 50` caps — those are display caps; the guard aggregates ALL rows; (b) orders that already have a counted open invoice are skipped in the order bucket (the statement shows both buckets side-by-side for display; summing both raw would double-count every open order that carries a draft/sent mirror invoice — see Risks §1); (c) the order being edited is excluded from both buckets and represented by the projected total instead; (d) credit notes / advance payments are NOT netted — the statement reports them separately from `outstandingAmount`, and netting would loosen a money guard.
- **Stock lifecycle facts (verified in code — the guard's correctness depends on them):**
  - `create()` decrements `currentStock` at order time for every non-draft catalog line, under `SELECT … FOR UPDATE` (`orders.service.ts:1196-1249`, RF-017). Hard-block for customer/driver (`ConflictException` when `Number(p.currentStock) < li.qty`, line 1223/1236), warn-only for staff (`isStaffRole`, line 1231-1237).
  - `updateOrderItems` performs **zero** stock reads/writes today (verified: the only `currentStock` decrement in `orders.service.ts` is line 1246, inside `create()`).
  - Delivery decrements again via `InventoryService.recordSale` (`inventory/inventory.service.ts:495-498`) called from `completeStop` (`orders.service.ts:2429`).
  - Therefore an order's existing lines are already "out of" `currentStock`. The edit guard must be **delta-based**: only the _increase_ over what the order already holds needs coverage. An absolute check would false-block any edit of an order whose own creation emptied the shelf (stock 10 → order 10 → `currentStock` 0 → a notes-only edit would 409). New products (held = 0) need full coverage — identical to `create()`. The guard must NOT decrement anything and must NOT take a `FOR UPDATE` lock (it reserves nothing, so a lock closes no race).
  - `create()` skips the stock check for DRAFT orders (`!isDraft`, line 1206); the regulated edit-guard skips DRAFT too (`orders.service.ts:1642`). Both new guards skip DRAFT edits at the call site for the same reason (a draft edit isn't a sale yet).
- **Atomicity approach — transaction, not pre-projection (decision + why):** `updateOrderItems` currently mutates items through ~24 sequential non-transactional `this.prisma.forTenant()` calls across three branches (customer/driver replace, operator replace-all, operator merge), then recomputes totals from the DB (`orders.service.ts:2146-2151`) and writes them (`:2163-2178`). A pre-mutation projection of the total would have to re-simulate all three branches' pricing (tier/promo/box-proration/override anchoring) — a duplicated money formula with permanent drift risk, exactly what CLAUDE.md forbids. Instead, wrap the mutation phase + recompute + guards + `order.update` in ONE `this.prisma.tenantTransaction(...)`: the guards consume the _authoritative_ recomputed total and the _actual_ post-edit line set, and a violation throws → Prisma rolls back every item write → nothing persists, and `reconcileOrderDraftInvoice` + `appendOrderRevision` (both after the transaction) never run. This is exact by construction and also fixes the pre-existing partial-edit hazard (a crash mid-edit could previously strand a half-edited order). `PrismaService.tenantTransaction` (`apps/api/src/prisma/prisma.service.ts:36-51`) wraps the tx client with `_wrapTxWithTenant`, which auto-injects `tenantId` on `create/createMany/upsert` and tenant-scopes `findMany/findFirst/count/update/updateMany/delete/deleteMany/aggregate/groupBy` and post-filters `findUnique` — so a mechanical `this.prisma.forTenant().X` → `tx.X` conversion inside the wrapper is tenant-safety-preserving and behavior-identical (incl. the SUPER_ADMIN null-tenant case, where both paths are unscoped). `findUniqueOrThrow` falls through unscoped in BOTH the `forTenant()` extension and the tx proxy — also identical.
- **Existing tests must pass unmodified.** `apps/api/src/orders/orders.service.spec.ts` (1824 lines) uses `createMockPrisma()` (`apps/api/src/testing/prisma-mock.ts`); its `tenantTransaction` mock is a passthrough that hands the callback **the same model mock objects** (`fn({...models, …})`, prisma-mock.ts:206-212), so converting service code from `forTenant().orderItem.create` to `tx.orderItem.create` keeps every existing stub/assertion working. The spec contains no `mockResolvedValueOnce` on prisma models and no `currentStock`/`creditLimit` stubs (verified by grep), so the guards' new queries hit mock defaults (`findUnique → null`, `findMany → []`) or stubs lacking those fields (`Number(undefined) → NaN`) — both fail open, so every existing test passes. The guards below are deliberately written so `NaN`/missing data never blocks.
- **What must NOT change:** the regulated guard (`:1642-1658`), the edit-window gate (`:1616-1628`), `revertLinkedInvoicesForOrderEdit` call position (`:1634`), all branch pricing logic, the recompute formula, `appendOrderRevision`, the method's return shape, and `create()`.
- Error style: mirror the P5-08 edit-window error — `ConflictException` with a structured object `{ code, message, ... }` (`orders.service.ts:1622-1628`); web/mobile switch on `code`.
- Prisma-mock already covers every model the guards query (`customer`, `invoice`, `order`, `orderItem`, `product` — prisma-mock.ts:58-149). No prisma-mock changes needed.

## Work packages

### WP1 — Guards + transactional edit in `orders.service.ts`

- **files:** `apps/api/src/orders/orders.service.ts`
- **brief:** (1) Wrap the mutation phase of `updateOrderItems` (current lines 1660–2178) in `this.prisma.tenantTransaction`, mechanically converting the `this.prisma.forTenant()` calls inside it to the `tx` client. (2) Insert the two guard calls between the totals recompute and `order.update`, gated off for DRAFT orders. (3) Add two private methods `assertStockAvailableForEdit` and `assertWithinCreditLimit` after `appendOrderRevision` (which ends at line 2280), before `updateShipment` (line 2288). No import changes are needed — `ConflictException`, `roundMoney`, `UserRole`, `InvoiceStatus`, `OrderStatus`, `JwtPayload` are already imported (lines 1-55).

**Step 1 — the transaction wrapper.** Replace the region from line 1660 (the comment `// Customer/Driver path: replace items by productId`) through line 2178 (the closing `});` of the `order.update` call) with the same code wrapped as follows. Everything currently between those lines moves inside unchanged except the conversions in Step 2 and the insertion in Step 3:

```ts
// P5-08b: the entire mutation phase — item writes, totals recompute, the
// stock/credit guards, and the order-header update — runs in ONE tenant
// transaction. A guard violation (or any failure) rolls back every item
// write, so a blocked edit leaves the order byte-identical and appends no
// revision. The guards intentionally consume the AUTHORITATIVE recomputed
// totals/line set (not a pre-mutation simulation), so there is no second
// pricing formula to drift. reconcileOrderDraftInvoice and
// appendOrderRevision stay OUTSIDE (after commit), unchanged.
const { subtotal, tax, shouldRevert } = await this.prisma.tenantTransaction(
  async (tx) => {
    // ── existing lines 1660–2144 go here, with forTenant() → tx (Step 2) ──

    // ── existing recompute, lines 2146–2151, with forTenant() → tx ──
    const activeItems = await tx.orderItem.findMany({
      where: { orderId, status: { not: "CANCELLED" } },
    });
    const subtotal = roundMoney(activeItems.reduce((s, li) => s + Number(li.subtotal), 0));
    const tax = roundMoney(subtotal * (await this.getTaxRate()));

    // ── Step 3 guard block goes HERE (see below) ──

    // ── existing lines 2153–2178 (shouldRevert / revertNote / order.update),
    //    with forTenant() → tx ──

    return { subtotal, tax, shouldRevert };
  },
  // Headroom over Prisma's 5s default: the merge branch issues per-line
  // queries inside the transaction (same shape as create()'s per-line work).
  { timeout: 15_000 },
);
```

`subtotal`, `tax`, `shouldRevert` were previously method-scope consts consumed after this region (gateway emit at :2185-2193, revision totals at :2198-2204); destructuring the transaction's return keeps those consumers untouched.

**Step 2 — mechanical conversions inside the wrapper.** Every `this.prisma.forTenant().` between lines 1660 and 2178 becomes `tx.` — exactly these 25 sites (current line numbers):

| line       | call                                                   |
| ---------- | ------------------------------------------------------ |
| 1663       | `customer.findFirst` (buyer ownership)                 |
| 1671       | `product.findMany` (customer branch)                   |
| 1682       | `customer.findUnique` (pricingTier)                    |
| 1689       | `customerPrice.findMany`                               |
| 1711       | `orderItem.deleteMany` (customer replace)              |
| 1720, 1768 | `orderItem.create` (customer branch)                   |
| 1810       | `product.findMany` (replace-all)                       |
| 1815       | `orderItem.deleteMany` (replace-all)                   |
| 1824, 1871 | `orderItem.create` (replace-all)                       |
| 1905, 1945 | `orderItem.create` (merge: new unlisted / new catalog) |
| 1923       | `product.findUnique` (merge new item)                  |
| 1976       | `deliveryMutation.count` (DELETE decision)             |
| 1980, 1988 | `orderItem.update` (strike-off / cancel)               |
| 1985       | `orderItem.delete`                                     |
| 1993       | `product.findUniqueOrThrow` (substitute)               |
| 2012       | `orderItem.update` (substitute)                        |
| 2049, 2100 | `product.findUnique` (unitsPerBox / catalog anchor)    |
| 2113       | `orderItem.update` (qty/price edit)                    |
| 2147       | `orderItem.findMany` (recompute)                       |
| 2163       | `order.update` (totals write)                          |

Leave as-is (do NOT convert): `this.loadActivePromotions(...)` (:1694), `this.getCustomerPriceHistory(...)` (:1697), `this.getTaxRate()` (:2151) — internal read-only reference-data helpers, not part of the atomic write set; and everything outside the wrapper: the initial `order.findUnique` (:1603), the edit-window gate, `revertLinkedInvoicesForOrderEdit` (:1634), the regulated guard (:1642-1658), `reconcileOrderDraftInvoice` (:2183), the gateway emit, `appendOrderRevision` (:2198), and the final `order.findUnique` return (:2206).

**Step 3 — guard invocation.** Insert between the `tax` computation and the `shouldRevert` block, inside the transaction:

```ts
// P5-08b inline guards (completes P5-08 "credit / regulated / stock-
// violating edit blocked inline"). DRAFT edits are exempt, matching the
// regulated guard above and create()'s !isDraft stock gate — a draft
// edit isn't a sale yet. Order: stock first (more actionable message),
// then credit. A throw here rolls back the whole transaction.
if (order.status !== "DRAFT") {
  await this.assertStockAvailableForEdit(tx, order, activeItems, user);
  await this.assertWithinCreditLimit(
    tx,
    order.customerId,
    orderId,
    // The exact total the order.update below writes — Σ of stored
    // computeLineSubtotal results + tax, cents-rounded. Note: mirrors
    // the existing edit recompute, which (pre-existing) does not
    // subtract Order.discountAmount.
    roundMoney(subtotal + tax),
  );
}
```

**Step 4 — the two private methods.** Insert verbatim after `appendOrderRevision` (ends line 2280), before `updateShipment` (line 2288):

```ts
  /**
   * P5-08b stock guard — VALIDATE-ONLY, delta-based. Never decrements stock.
   *
   * Lifecycle (why delta, not absolute): create() already decremented
   * Product.currentStock for every non-draft line under a row lock (RF-017,
   * create() ~line 1196-1249), so the order's existing lines are already "out
   * of" currentStock; delivery decrements separately via
   * InventoryService.recordSale. Edits never touch stock. An edit therefore
   * only needs the INCREASE over what the order already holds to be coverable;
   * requiring the absolute qty would false-block any edit of an order whose
   * own creation emptied the shelf (stock 10 → order of 10 → currentStock 0 →
   * a same-qty edit would 409). Brand-new lines have held = 0, so they need
   * full coverage — identical to create()'s check.
   *
   * Role semantics mirror create(): CUSTOMER/DRIVER hard-block (409
   * INSUFFICIENT_STOCK), everyone else (operator/admin/undefined = internal
   * caller) may knowingly oversell — warn-only log. Quantities compare in each
   * line's own stored denomination (pieces for box-split lines, selling units
   * otherwise) — the same mixed-denomination convention create() uses against
   * currentStock. No SELECT ... FOR UPDATE: this guard reserves nothing, so a
   * lock would close no race. Unknown/missing product rows and non-numeric
   * quantities fail OPEN (skip) — same posture as create()'s `if (p && ...)`.
   */
  private async assertStockAvailableForEdit(
    db: any,
    order: { id: string; status: string; lineItems: any[] },
    finalActiveItems: Array<{ productId: string | null; qty: any }>,
    user?: JwtPayload,
  ): Promise<void> {
    // Qty the order already holds per product (pre-edit, non-cancelled lines).
    const held = new Map<string, number>();
    for (const li of order.lineItems ?? []) {
      if (li.productId && li.status !== "CANCELLED") {
        held.set(li.productId, (held.get(li.productId) ?? 0) + Number(li.qty));
      }
    }
    // Qty the edit requests per product (post-edit active line set).
    const requested = new Map<string, number>();
    for (const li of finalActiveItems) {
      if (li.productId) {
        requested.set(li.productId, (requested.get(li.productId) ?? 0) + Number(li.qty));
      }
    }
    const increases = [...requested.entries()]
      .map(([productId, req]) => ({
        productId,
        requested: req,
        delta: req - (held.get(productId) ?? 0),
      }))
      .filter((x) => x.delta > 0);
    if (increases.length === 0) return;

    const products = await db.product.findMany({
      where: { id: { in: increases.map((x) => x.productId) } },
      select: { id: true, name: true, currentStock: true },
    });
    const violations: Array<{
      productId: string;
      name: string;
      available: number;
      requested: number;
      delta: number;
    }> = [];
    for (const inc of increases) {
      const p = products.find((lp: any) => lp.id === inc.productId);
      if (p && Number(p.currentStock) < inc.delta) {
        violations.push({
          productId: inc.productId,
          name: p.name,
          available: Number(p.currentStock),
          requested: inc.requested,
          delta: inc.delta,
        });
      }
    }
    if (violations.length === 0) return;

    if (user?.role !== UserRole.CUSTOMER && user?.role !== UserRole.DRIVER) {
      // Operators/admins may oversell — matches create()'s warn-only path.
      this.logger.warn(
        `Operator edit of order ${order.id} will go below stock: ` +
          violations
            .map((v) => `${v.name} (available: ${v.available}, requested increase: ${v.delta})`)
            .join("; "),
      );
      return;
    }
    const first = violations[0];
    throw new ConflictException({
      code: "INSUFFICIENT_STOCK",
      message:
        `Not enough stock for ${first.name} ` +
        `(available: ${first.available}, requested: ${first.requested}).`,
      productId: first.productId,
      available: first.available,
      requested: first.requested,
    });
  }

  /**
   * P5-08b credit-limit guard — the FIRST credit enforcement in the codebase
   * (verified: no other creditLimit read exists in apps/api/src outside DTOs).
   *
   * Exposure mirrors customers.service.ts getStatementForOperator (the
   * authoritative statement derivation — do NOT invent a second balance
   * formula):
   *   • open invoice balances: status ∉ {PAID, VOID, WRITTEN_OFF}, each worth
   *     Number(total) − Σ payments.amount (statement's `outstanding`);
   *   • open-order totals: status ∈ {PENDING, CONFIRMED, OUT_FOR_DELIVERY}
   *     (statement's `pendingOrdersAmount`) — but ONLY orders with no counted
   *     open invoice, else every order carrying a draft/sent mirror invoice
   *     (reconcileOrderDraftInvoice keeps one in lockstep) counts twice;
   *   • the order being edited is EXCLUDED from both buckets and represented
   *     by projectedOrderTotal instead. Exact, not approximate: an editable
   *     order's linked invoice can never carry payments —
   *     revertLinkedInvoicesForOrderEdit (already called by updateOrderItems)
   *     throws if it does;
   *   • credit notes / advance payments are NOT netted (the statement reports
   *     them separately from outstandingAmount; netting loosens a money guard);
   *   • the Transaction model is NOT read — delivered orders have BOTH a
   *     Transaction and an invoice, so mixing the two double-counts.
   *
   * creditLimit == null (or customer row not found) → no limit → no check.
   * Blocks ALL roles — money exposure is stricter than stock (operators may
   * oversell, they may not silently extend credit); the shared error code
   * leaves room for a future explicit operator-override flow.
   *
   * Runs INSIDE the updateOrderItems transaction, after the totals recompute:
   * projectedOrderTotal is the SAME roundMoney(subtotal + tax) the order.update
   * persists. A throw rolls the whole edit back.
   */
  private async assertWithinCreditLimit(
    db: any,
    customerId: string,
    currentOrderId: string,
    projectedOrderTotal: number,
  ): Promise<void> {
    const customer = await db.customer.findUnique({
      where: { id: customerId },
      select: { creditLimit: true },
    });
    if (customer?.creditLimit == null) return;
    const limit = Number(customer.creditLimit);

    // JS-side exclusion of the edited order's invoices (avoids SQL null
    // semantics of `not` on the nullable orderId column).
    const openInvoices = (
      await db.invoice.findMany({
        where: {
          customerId,
          status: {
            notIn: [InvoiceStatus.PAID, InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF],
          },
        },
        select: { total: true, orderId: true, payments: { select: { amount: true } } },
      })
    ).filter((inv: any) => inv.orderId !== currentOrderId);

    const invoiceExposure = openInvoices.reduce(
      (sum: number, inv: any) =>
        sum +
        (Number(inv.total) -
          inv.payments.reduce((s: number, p: any) => s + Number(p.amount), 0)),
      0,
    );

    const invoicedOrderIds = new Set(
      openInvoices.map((inv: any) => inv.orderId).filter(Boolean),
    );
    const openOrders = await db.order.findMany({
      where: {
        customerId,
        status: {
          in: [OrderStatus.PENDING, OrderStatus.CONFIRMED, OrderStatus.OUT_FOR_DELIVERY],
        },
      },
      select: { id: true, total: true },
    });
    const uninvoicedOrderExposure = openOrders
      .filter((o: any) => o.id !== currentOrderId && !invoicedOrderIds.has(o.id))
      .reduce((sum: number, o: any) => sum + Number(o.total), 0);

    const exposure = roundMoney(
      invoiceExposure + uninvoicedOrderExposure + projectedOrderTotal,
    );
    if (exposure > limit) {
      throw new ConflictException({
        code: "CREDIT_LIMIT_EXCEEDED",
        message:
          `This edit would take the customer's exposure to ${exposure.toFixed(2)}, ` +
          `over their credit limit of ${limit.toFixed(2)}.`,
        limit,
        exposure,
      });
    }
  }
```

### WP2 — Spec coverage in `orders.service.spec.ts`

- **files:** `apps/api/src/orders/orders.service.spec.ts`
- **brief:** Append two describe blocks after the existing `updateOrderItems — edit window + revisions (P5-08)` block (ends line 1823). Use the existing setup verbatim — `createMockPrisma()`, `operatorPayload`/`customerPayload`, `MOCK_ORDER`. Do not modify any existing test or the TestingModule providers. Key fixture facts: `SystemConfigService.get` is mocked to `null` → `getTaxRate()` returns 0 → **projected total = subtotal** in every test; the mock `tenantTransaction` is a passthrough over the same model mocks; the authorization guard mock resolves, so the regulated guard never interferes. Because the mock cannot roll back, "nothing persists" is asserted as: `prisma.order.update` not called (guards throw before it), `prisma.orderRevision.create` not called, and `invoicesService.reconcileOrderDraftInvoice` not called (both are after the transaction).

**Exact code** (transplant; keep expected numbers exactly — they are the money math under review):

```ts
// ─── P5-08b: credit-limit + stock inline guards on edit ────────────────────

describe("updateOrderItems — credit-limit guard (P5-08b)", () => {
  // PENDING order (guards skip DRAFT), no run (edit window open), one line
  // qty 2 @ $5. The merge edit below moves it to qty 3 → recompute stub says
  // subtotal 15; tax rate is 0 in tests → projected total = 15.
  const editableOrder = () => ({
    ...MOCK_ORDER,
    status: "PENDING" as const,
    routeRun: null,
    lineItems: [
      {
        id: "li-1",
        orderId: "ord-1",
        productId: "prod-1",
        qty: 2,
        unitPrice: 5,
        subtotal: 10,
        status: "PENDING",
        boxes: null,
        pieces: null,
      },
    ],
  });
  const editDto = { items: [{ id: "li-1", action: "UPDATE" as const, qty: 3, unitPrice: 5 }] };
  const postEditItems = [
    { id: "li-1", productId: "prod-1", qty: 3, unitPrice: 5, subtotal: 15, status: "PENDING" },
  ];

  beforeEach(() => {
    prisma.order.findUnique.mockResolvedValue(editableOrder());
    prisma.orderItem.findMany.mockResolvedValue(postEditItems);
    prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
  });

  it("creditLimit null → no limit: passes without querying exposure", async () => {
    prisma.customer.findUnique.mockResolvedValue({ creditLimit: null });

    await service.updateOrderItems("ord-1", editDto, operatorPayload);

    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(prisma.order.update).toHaveBeenCalled();
  });

  it("under the limit passes (exposure = open invoice balance + projected total)", async () => {
    prisma.customer.findUnique.mockResolvedValue({ creditLimit: 100 });
    prisma.invoice.findMany.mockResolvedValue([
      { total: 50, orderId: null, payments: [{ amount: 20 }] }, // balance 30
    ]);
    prisma.order.findMany.mockResolvedValue([]);

    await service.updateOrderItems("ord-1", editDto, operatorPayload);

    // 30 + 15 = 45 ≤ 100
    expect(prisma.order.update).toHaveBeenCalled();
    expect(prisma.orderRevision.create).toHaveBeenCalled();
  });

  it("over the limit blocks ALL roles and persists nothing (409 CREDIT_LIMIT_EXCEEDED)", async () => {
    prisma.customer.findUnique.mockResolvedValue({ creditLimit: 100 });
    prisma.invoice.findMany.mockResolvedValue([
      { total: 200, orderId: null, payments: [{ amount: 80 }] }, // balance 120
    ]);
    prisma.order.findMany.mockResolvedValue([]);

    await expect(service.updateOrderItems("ord-1", editDto, operatorPayload)).rejects.toMatchObject(
      {
        response: { code: "CREDIT_LIMIT_EXCEEDED", limit: 100, exposure: 135 }, // 120 + 15
      },
    );

    // Guard throws inside the transaction, before the header write; the
    // post-transaction reconcile + revision never run.
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.orderRevision.create).not.toHaveBeenCalled();
    const invoices = (service as any).invoicesService;
    expect(invoices.reconcileOrderDraftInvoice).not.toHaveBeenCalled();
  });

  it("excludes the edited order from exposure (its mirror invoice AND its order row)", async () => {
    prisma.customer.findUnique.mockResolvedValue({ creditLimit: 100 });
    // Both rows belong to the order being edited — must not count; the
    // projected total (15) represents it instead.
    prisma.invoice.findMany.mockResolvedValue([{ total: 500, orderId: "ord-1", payments: [] }]);
    prisma.order.findMany.mockResolvedValue([{ id: "ord-1", total: 500 }]);

    await service.updateOrderItems("ord-1", editDto, operatorPayload); // 15 ≤ 100

    expect(prisma.order.update).toHaveBeenCalled();
  });

  it("nets partial payments off an open invoice (partially-paid handling)", async () => {
    prisma.customer.findUnique.mockResolvedValue({ creditLimit: 100 });
    prisma.invoice.findMany.mockResolvedValue([
      { total: 90, orderId: null, payments: [{ amount: 60 }, { amount: 10 }] }, // balance 20
    ]);
    prisma.order.findMany.mockResolvedValue([]);

    await service.updateOrderItems("ord-1", editDto, operatorPayload); // 20 + 15 = 35

    expect(prisma.order.update).toHaveBeenCalled();
  });

  it("exposure exactly at the limit passes; one cent over blocks", async () => {
    prisma.customer.findUnique.mockResolvedValue({ creditLimit: 100 });
    prisma.order.findMany.mockResolvedValue([]);

    prisma.invoice.findMany.mockResolvedValue([
      { total: 85, orderId: null, payments: [] }, // 85 + 15 = 100 → not over
    ]);
    await service.updateOrderItems("ord-1", editDto, operatorPayload);
    expect(prisma.order.update).toHaveBeenCalled();

    jest.clearAllMocks();
    prisma.order.findUnique.mockResolvedValue(editableOrder());
    prisma.orderItem.findMany.mockResolvedValue(postEditItems);
    prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
    prisma.customer.findUnique.mockResolvedValue({ creditLimit: 100 });
    prisma.order.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([
      { total: 85.01, orderId: null, payments: [] }, // 100.01 → over
    ]);
    await expect(service.updateOrderItems("ord-1", editDto, operatorPayload)).rejects.toMatchObject(
      { response: { code: "CREDIT_LIMIT_EXCEEDED", exposure: 100.01 } },
    );
  });

  it("does NOT double-count an open order that already has an open mirror invoice", async () => {
    // ord-2 appears as BOTH an open invoice (40) and an open order (40):
    // exposure must be 40 + 30 + 15 = 85, not 125.
    prisma.customer.findUnique.mockResolvedValue({ creditLimit: 90 });
    prisma.invoice.findMany.mockResolvedValue([{ total: 40, orderId: "ord-2", payments: [] }]);
    prisma.order.findMany.mockResolvedValue([
      { id: "ord-2", total: 40 },
      { id: "ord-3", total: 30 },
    ]);

    await service.updateOrderItems("ord-1", editDto, operatorPayload); // 85 ≤ 90
    expect(prisma.order.update).toHaveBeenCalled();
  });

  it("blocks a CUSTOMER edit over the limit (buyer replace path)", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" }); // ownership
    // Serves BOTH the branch's pricingTier read and the guard's creditLimit read.
    prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1, creditLimit: 10 });
    prisma.product.findMany.mockResolvedValue([
      { ...MOCK_PRODUCT, id: "prod-1", unitsPerBox: null },
    ]);
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.order.findMany.mockResolvedValue([]);

    await expect(
      service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 3 }] },
        customerPayload,
      ),
    ).rejects.toMatchObject({ response: { code: "CREDIT_LIMIT_EXCEEDED" } });
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it("skips both guards entirely on a DRAFT order", async () => {
    prisma.order.findUnique.mockResolvedValue({ ...editableOrder(), status: "DRAFT" });
    // Would block if the guard ran:
    prisma.customer.findUnique.mockResolvedValue({ creditLimit: 0.01 });

    await service.updateOrderItems("ord-1", editDto, operatorPayload);

    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(prisma.order.update).toHaveBeenCalled();
  });
});

describe("updateOrderItems — stock guard (P5-08b, validate-only, delta-based)", () => {
  // PENDING order already holding qty 5 of prod-1 (create() decremented that
  // 5 from currentStock at order time — only INCREASES need coverage).
  const stockOrder = () => ({
    ...MOCK_ORDER,
    status: "PENDING" as const,
    routeRun: null,
    lineItems: [
      {
        id: "li-1",
        orderId: "ord-1",
        productId: "prod-1",
        qty: 5,
        unitPrice: 5,
        subtotal: 25,
        status: "PENDING",
        boxes: null,
        pieces: null,
      },
    ],
  });

  beforeEach(() => {
    prisma.order.findUnique.mockResolvedValue(stockOrder());
    prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
    // Credit guard stays inert in this block:
    prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1, creditLimit: null });
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.customerPrice.findMany.mockResolvedValue([]);
  });

  it("blocks a CUSTOMER increase beyond available stock (delta 3 > available 2)", async () => {
    prisma.product.findMany.mockResolvedValue([
      { ...MOCK_PRODUCT, id: "prod-1", currentStock: 2, unitsPerBox: null },
    ]);
    prisma.orderItem.findMany.mockResolvedValue([
      { id: "li-1", productId: "prod-1", qty: 8, unitPrice: 5, subtotal: 40, status: "PENDING" },
    ]);

    await expect(
      service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 8 }] },
        customerPayload,
      ),
    ).rejects.toMatchObject({
      response: { code: "INSUFFICIENT_STOCK", productId: "prod-1", available: 2, requested: 8 },
    });
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.orderRevision.create).not.toHaveBeenCalled();
  });

  it("checks the DELTA, not the absolute qty: 5 → 8 passes with only 3 in stock", async () => {
    prisma.product.findMany.mockResolvedValue([
      { ...MOCK_PRODUCT, id: "prod-1", currentStock: 3, unitsPerBox: null },
    ]);
    prisma.orderItem.findMany.mockResolvedValue([
      { id: "li-1", productId: "prod-1", qty: 8, unitPrice: 5, subtotal: 40, status: "PENDING" },
    ]);

    await service.updateOrderItems(
      "ord-1",
      { items: [{ productId: "prod-1", qty: 8 }] },
      customerPayload,
    );
    expect(prisma.order.update).toHaveBeenCalled();
  });

  it("never false-blocks a same-qty edit when the shelf is empty (delta 0, stock 0)", async () => {
    // The order's own creation emptied the shelf; re-saving qty 5 must pass
    // and must not even query product stock.
    prisma.product.findMany.mockResolvedValue([
      { ...MOCK_PRODUCT, id: "prod-1", currentStock: 0, unitsPerBox: null },
    ]);
    prisma.orderItem.findMany.mockResolvedValue([
      { id: "li-1", productId: "prod-1", qty: 5, unitPrice: 5, subtotal: 25, status: "PENDING" },
    ]);

    await service.updateOrderItems(
      "ord-1",
      { items: [{ productId: "prod-1", qty: 5 }] },
      customerPayload,
    );
    expect(prisma.order.update).toHaveBeenCalled();
  });

  it("a NEW line needs full coverage (held 0): qty 4 vs stock 3 blocks", async () => {
    prisma.product.findMany.mockResolvedValue([
      { ...MOCK_PRODUCT, id: "prod-1", currentStock: 99, unitsPerBox: null },
      { ...MOCK_PRODUCT, id: "prod-2", name: "Basil", currentStock: 3, unitsPerBox: null },
    ]);
    prisma.orderItem.findMany.mockResolvedValue([
      { id: "li-1", productId: "prod-1", qty: 5, unitPrice: 5, subtotal: 25, status: "PENDING" },
      { id: "li-2", productId: "prod-2", qty: 4, unitPrice: 2, subtotal: 8, status: "PENDING" },
    ]);

    await expect(
      service.updateOrderItems(
        "ord-1",
        {
          items: [
            { productId: "prod-1", qty: 5 },
            { productId: "prod-2", qty: 4 },
          ],
        },
        customerPayload,
      ),
    ).rejects.toMatchObject({
      response: { code: "INSUFFICIENT_STOCK", productId: "prod-2", available: 3, requested: 4 },
    });
  });

  it("operator over-stock increase WARNS and passes (may oversell, matches create())", async () => {
    const warnSpy = jest.spyOn((service as any).logger, "warn").mockImplementation();
    prisma.product.findMany.mockResolvedValue([
      { ...MOCK_PRODUCT, id: "prod-1", currentStock: 1, unitsPerBox: null },
    ]);
    prisma.orderItem.findMany.mockResolvedValue([
      { id: "li-1", productId: "prod-1", qty: 50, unitPrice: 5, subtotal: 250, status: "PENDING" },
    ]);

    await service.updateOrderItems(
      "ord-1",
      { items: [{ id: "li-1", action: "UPDATE", qty: 50, unitPrice: 5 }] },
      operatorPayload,
    );

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("below stock"));
    expect(prisma.order.update).toHaveBeenCalled();
    expect(prisma.orderRevision.create).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("never decrements currentStock on edit (validate-only)", async () => {
    prisma.product.findMany.mockResolvedValue([
      { ...MOCK_PRODUCT, id: "prod-1", currentStock: 100, unitsPerBox: null },
    ]);
    prisma.orderItem.findMany.mockResolvedValue([
      { id: "li-1", productId: "prod-1", qty: 8, unitPrice: 5, subtotal: 40, status: "PENDING" },
    ]);

    await service.updateOrderItems(
      "ord-1",
      { items: [{ productId: "prod-1", qty: 8 }] },
      customerPayload,
    );

    expect(prisma.product.update).not.toHaveBeenCalled();
  });
});
```

Note for the implementer: `(service as any).invoicesService` — check the actual private property name of the injected `InvoicesService` in `OrdersService`'s constructor and use that; alternatively capture the mock via `module.get(InvoicesService)` in the describe block (the cleaner pattern — mirror how `inventoryService` is captured at spec line 173).

## Acceptance criteria

1. `apps/api/src/orders/orders.service.ts` has two new private methods, `assertStockAvailableForEdit` and `assertWithinCreditLimit`, and `updateOrderItems` calls both inside a `tenantTransaction` after the totals recompute and before the `order.update`, gated by `order.status !== "DRAFT"`. No other method changes; `create()` is untouched.
2. The whole mutation phase of `updateOrderItems` (both role branches, recompute, guards, header update) runs inside ONE `this.prisma.tenantTransaction(...)`; every former `this.prisma.forTenant()` call in that region now uses the `tx` client (all 25 sites in the WP1 table). `revertLinkedInvoicesForOrderEdit`, the regulated guard, `reconcileOrderDraftInvoice`, the gateway emit, `appendOrderRevision`, and the final `findUnique` return remain outside the transaction, in their current order.
3. Credit guard semantics: `creditLimit == null` → no check; exposure = Σ open-invoice balances (`status ∉ {PAID, VOID, WRITTEN_OFF}`, each `total − Σ payments`) excluding invoices linked to the edited order, + Σ totals of `PENDING/CONFIRMED/OUT_FOR_DELIVERY` orders that are neither the edited order nor already represented by a counted open invoice, + `roundMoney(subtotal + tax)` of the edit; `exposure > limit` (strict, after `roundMoney`) throws `ConflictException` whose response contains `code: "CREDIT_LIMIT_EXCEEDED"`, `limit`, `exposure`. It blocks every role, including OPERATOR/TENANT_ADMIN.
4. Stock guard semantics: validate-only (zero writes; specifically no `product.update`/`currentStock` change anywhere in `updateOrderItems`); delta-based per product (post-edit active qty − pre-edit non-cancelled qty; only positive deltas checked against `Number(currentStock)`); CUSTOMER/DRIVER violations throw `ConflictException` with `code: "INSUFFICIENT_STOCK"`, `productId`, `available`, `requested`; all other callers get a `logger.warn` and proceed; missing product rows / non-numeric values never block; no `FOR UPDATE` lock.
5. On any guard violation nothing persists: the transaction rolls back all item writes, `order.update` is never reached, no `OrderRevision` row is appended, and `reconcileOrderDraftInvoice` is not called.
6. Guard order is deterministic: stock is checked before credit (when both would violate, the response code is `INSUFFICIENT_STOCK`).
7. No changes to `apps/api/prisma/schema.prisma`, no new migration, no new npm dependency, no new constructor dependency on `OrdersService`, no changes to `apps/api/src/testing/prisma-mock.ts`.
8. All pre-existing tests in `orders.service.spec.ts` pass **unmodified** (only additions to the file are allowed), and the new describe blocks from WP2 pass, including the exact expected numbers (`exposure: 135`, `exposure: 100.01`, `available: 2, requested: 8`, etc.).
9. `npx tsc -p tsconfig.build.json --noEmit` (in `apps/api`) is clean; lint passes.

## Verification commands

Confirmed present in the repo:

- `cd apps/api && npx jest orders.service` — full orders spec (existing + new).
- `cd apps/api && npx tsc -p tsconfig.build.json --noEmit` — typecheck (`apps/api/tsconfig.build.json` exists).
- `npm run verify` from the repo root — `turbo run check-types lint test` (root `package.json:13`).

## Risks & rollback

1. **Credit-exposure double-counting (top money risk — reviewer walk this first).** Open orders can carry a DRAFT (or SENT) mirror invoice kept in lockstep by `reconcileOrderDraftInvoice`; the statement's `outstanding` bucket counts invoices with status ∉ {PAID, VOID, WRITTEN_OFF} — DRAFT included — while `pendingOrdersAmount` counts the same orders again. Summing both raw would double every mirrored open order and false-block customers at roughly half their real headroom. The guard dedupes by skipping orders whose id appears on a counted open invoice, and prefers the invoice (its balance nets partial payments, the order total doesn't). Similarly the edited order is excluded from BOTH buckets before adding the projected total — exclusion is exact because `revertLinkedInvoicesForOrderEdit` (:1846-1880 of `invoices.service.ts`) throws when a linked invoice has payments, so an editable order's invoice balance always equals its total. The `Transaction` model is deliberately unread (delivered orders have both a Transaction and an invoice — another double-count vector).
2. **Paid/partially-paid invoice handling.** Exposure per invoice is `total − Σ payments.amount` — the statement's exact formula. PAID/VOID/WRITTEN_OFF are excluded by status, so an OVERDUE-but-fully-paid edge case (status lagging payments) contributes ~0, never negative-blocks. Watch in review that no code path re-derives balance from `Order.total` for invoiced orders.
3. **Stock false-block (the trap this design avoids).** `create()` decrements `currentStock` at order time (RF-017), so an absolute post-edit check would 409 any order whose creation emptied the shelf even when the qty didn't increase. The delta model only requires the increase to be coverable. Residual known imprecision (accepted, documented): edits don't adjust stock, so consecutive increases each re-baseline against the current line qty rather than the originally-decremented qty — a heuristic guard, not an inventory ledger. Also inherited from `create()`: quantities compare in each line's own denomination (pieces vs selling-units) against `currentStock`; do not "fix" this here — matching `create()`'s semantics is the requirement.
4. **Transaction wrap regressions.** The forTenant→tx conversion must cover exactly the mutation region; a missed write outside the tx would escape rollback. Reviewer: grep `this.prisma.forTenant()` inside `updateOrderItems` — after the change only the initial load (:1603) and the final return read should remain. Interactive-tx timeout is raised to 15s (merge branch does per-line queries; same shape as `create()`'s in-tx per-line work). Tenant safety is preserved by `_wrapTxWithTenant` (auto tenantId injection/scoping — see Constraints).
5. **Pre-existing warts intentionally NOT fixed (do not let scope creep in):** (a) a guard-blocked edit may still leave a SENT linked invoice reverted to DRAFT, because `revertLinkedInvoicesForOrderEdit` runs before the guards — identical to today's regulated-guard behavior; (b) the edit recompute writes `total = subtotal + tax` without `Order.discountAmount` (`:2168`) — the guard uses the same value the edit persists; (c) `changeStatus` DRAFT→PENDING promotion runs the regulated guard but neither new guard — draft promotion bypass is a P5-08c follow-up; (d) the create-vs-delivery double-decrement question in the stock lifecycle is out of scope.
6. **Fail-open posture** on missing customer/product rows and NaN values is deliberate (guard, not ledger; also keeps the 40+ existing updateOrderItems tests green without touching them). Reviewer should confirm no fail-open path can be triggered by attacker-controlled input to _lower_ a real limit check — it can't: a real customer row always resolves, and a missing product row can't be added as a line (branches throw `Product not found` first).
7. **Rollback:** single revert of the feature commit(s) on `feat/p5-08b-edit-guards`; no migration, no data backfill, no cross-service contract change. The API error codes are additive — clients that don't know them fall back to generic 409 message display.

## Status

IMPLEMENTED (2026-07-13, via dev-pipeline on branch feat/p5-08b-edit-guards). WP1+WP2 landed; `npm run verify` 18/18 green (85 orders.service tests). **Adversarial review caught a real availability bug the plan missed:** the tx wrap left `getTaxRate`/`loadActivePromotions`/`getCustomerPriceHistory` (separate pooled connections) running INSIDE the transaction → connection-pool-starvation deadlock under concurrent edits. Fixer hoisted them before the tx (mirrors `create()`, orders.service.ts:1666-1684). No migration.
