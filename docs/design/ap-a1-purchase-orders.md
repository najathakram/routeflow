# AP-A1 — Purchase Orders as the spine of Accounts Payable

_Implementation design for the three-way match: PO ↔ goods receipt ↔ supplier bill._

- **Status:** Design — not yet implemented
- **Implements:** `AP-A1` in [`docs/product/purchasing.md`](../product/purchasing.md) (currently `MISSING ⬜`)
- **Closes:** bug **B285** (PO receiving writes stock/cost as an absolute value from an unlocked read)
- **Related defects fixed in passing:** `purchaseOrderId` silently dropped on bill create; racy
  `nextPoNumber`; raw-float money math in `createPurchaseOrder`; `@Roles(OPERATOR, DRIVER)` on PO
  routes (bug **B168**)

---

## 1. Where this design comes from

Four open-source systems were surveyed for this design: Odoo 19 (LGPLv3), ERPNext (GPLv3),
Twenty (AGPLv3 core) and Krayin (MIT). Purchase-order lifecycle is the **best-precedented flow in
either ERP** — Odoo and ERPNext have each run it in production for well over a decade across
thousands of businesses.

**Licensing posture — read this before writing code.** Odoo is LGPLv3 and ERPNext GPLv3. Copyleft
attaches to *expression*, not to ideas, algorithms or data-model shapes. Every design below was
derived from prose descriptions of how those systems behave, and all code in this document is
original work written against RouteFlow's own conventions. When implementing:

1. Read the reference product's behaviour, close the file, then write from this document.
2. Never copy identifiers, comments, docstrings or error strings from either product.
3. Never paste a snippet from either product into a PR, an issue, or a prompt asking to "translate this".
4. Cite the *idea* here; never the source. No fragment of either codebase enters this repo, ever.

This matters concretely: RouteFlow goes public for every CI window, so a copied fragment is a live
exposure, not a theoretical one.

### What we inherit, and from which system

| # | Inherited design | Source | Why it earns its place |
|---|---|---|---|
| 1 | **Derive, never increment.** `qtyReceived`/`qtyBilled` are stored but *fully re-summed* from child rows on every child write, never `+=`. | ERPNext (full re-sum); Odoo (computed fields) | Cancellation and amendment self-heal. This is the fix-shape for the B298/B299 bug class applied pre-emptively. |
| 2 | **Lock the row, write a delta.** Receiving locks the product row before reading, then writes a delta. | Odoo `stock.quant` | This *is* the B285 fix. |
| 3 | **Min-clamp percentages.** `receivedPct = Σ min(received, ordered) / Σ ordered`. | ERPNext | Over-receipt cannot push a PO past 100%, so status stays truthful. |
| 4 | **Status is derived, never set by hand.** Header status falls out of the two percentages. | ERPNext; Odoo | Removes a whole class of "status says RECEIVED but lines disagree" bugs. |
| 5 | **Tolerance with role bypass.** Over-receipt / over-billing allowance %, breach = hard error, named role downgrades to warning. | ERPNext | The single most useful thing ERPNext has that Odoo lacks. |
| 6 | **Match by PO number → vendor reference → vendor + total within tolerance.** | Odoo | This is what turns a *scanned* invoice into a *matched* one. The core of this request. |
| 7 | **"PO required" policy switch**, with a per-supplier escape hatch. | ERPNext | The enforcement lever that makes POs actually get used rather than bypassed. |
| 8 | **Hold flag** with comment and auto-expiring release date. | ERPNext | Cheap, and the only way to stop payment on a disputed bill. |
| 9 | **Manual Close** to write off a remainder. | Both | Under-receipt otherwise leaves POs open forever. |
| 10 | **Confirmed lines cannot be deleted**, only closed. | Both | Preserves the audit chain without ERPNext's whole amend-by-cancel framework. |

### What we deliberately do NOT inherit

Both products have these; none earns its keep in v1. Say no now, in writing, so it doesn't creep in:

**RFQ / tender rounds** (a distributor reordering known SKUs from known vendors does not bid) ·
**blanket orders / material requests** (doubles the status-updater surface for no early value) ·
**subcontracting** · **multi-step receipt routes** (you receive to a dock, full stop) ·
**landed costs at receipt** (large, error-prone; put freight on the bill as a non-stock line —
this is already `AP-A4`, tracked separately) · **supplier scorecards** (`AP-A6`, reporting not
domain) · **dropshipping** · **advance-payment status** · **multi-currency price lists** ·
**per-line analytic distribution** · **ERPNext's amend-by-cancel-and-recreate** (a framework-wide
invariant; bolting it onto one entity creates more confusion than it solves) · **Odoo's
standard-cost price-difference account** (we carry stock at moving average — adjust the layer instead).

### One inherited idea we must NOT take: GRNI as a journal entry

Both products debit inventory and credit a **Goods Received Not Invoiced** clearing account on
receipt, then clear it when the bill posts. This is their strongest convergence — and it is
**not implementable here**. RouteFlow has no general ledger, no chart of accounts and no journal
entries: `finance.prisma` holds `Invoice`, `VendorBill`, `Payment`, `Expense` and friends directly,
with no double-entry substrate.

So the accrual is **derived, not posted**:

```
valueReceivedNotBilled = Σ(receipt line value) − Σ(billed value against those receipt lines)
```

computable on demand from the same rows that drive the three-way match. If a general ledger is ever
added, this figure becomes the GRNI balance and the design carries over unchanged. Until then,
expose it as a report, not an account.

---

## 2. What already exists (verified, not assumed)

A `PurchaseOrder` **already exists** and is a stub that nothing is wired into.

```prisma
// apps/api/prisma/schema/catalog.prisma — TODAY
enum PurchaseOrderStatus { DRAFT SENT PARTIAL RECEIVED CLOSED }

model PurchaseOrder {
  id String @id @default(uuid())
  poNumber String
  supplierId String
  status PurchaseOrderStatus @default(DRAFT)
  expectedDate DateTime?
  notes String?
  totalAmount Decimal @db.Decimal(10, 2)
  // ... tenantId, timestamps, supplier/tenant/items relations
  @@unique([tenantId, poNumber])
}

model PurchaseOrderItem {
  id String @id @default(uuid())
  poId String
  productId String
  qtyOrdered Decimal @db.Decimal(10, 3)
  qtyReceived Decimal @default(0) @db.Decimal(10, 3)
  unitCost Decimal @db.Decimal(10, 4)
  totalCost Decimal @db.Decimal(10, 2)
  // ... tenantId, relations
}
```

| Fact | Detail |
|---|---|
| Where the code lives | `apps/api/src/inventory/` — there is no `purchase-orders` module |
| Routes | `POST|GET /inventory/purchase-orders`, `GET|POST /inventory/purchase-orders/:id{,/send,/receive,/close}` |
| **No PO ↔ VendorBill link** | `VendorBill` has no `purchaseOrderId` column. `CreateVendorBillDto` *declares* `purchaseOrderId?: string` — it is accepted over the wire and silently dropped. |
| **No `qtyBilled`** | Only ordered and received exist, so there is no third leg to match against. |
| **No receipt document** | Receiving mutates `PurchaseOrderItem.qtyReceived` in place. Nothing records *what arrived when*. |
| **Two independent stock paths** | `InventoryService.receivePurchaseOrder` **and** `VendorBillsService.receive` both write stock, and neither knows the other exists. |
| **B285 lives here** | `receivePurchaseOrder` reads `product.currentStock` unlocked, then writes `currentStock: stockAfter` — an absolute value. Two concurrent receipts lose one. |
| Numbering | `nextPoNumber()` is a racy `findFirst`-max on a string sort; `DocumentNumberType` has no `PURCHASE_ORDER` member. |
| Money | `createPurchaseOrder` computes `totalCost = qtyOrdered * unitCost` in **raw floats**, no `roundMoney` — a direct violation of the money-discipline rule in `CLAUDE.md`. |
| DTOs | `createPurchaseOrder(dto: any)` and `receivePurchaseOrder(id, dto: any)` — unvalidated. |
| Roles | PO create/receive carry `@Roles(OPERATOR, DRIVER)` — a driver can raise and receive a PO and rewrite cost basis (bug **B168**). |

### The hazard this design exists to prevent

`purchasing.md:328` already states the acceptance criterion: *"receiving a PO then a bill raised
from that PO increases stock once."* Today both paths write stock independently. **Link them
naively and every PO-backed purchase doubles both stock and cost basis.** Section 4 is the answer.

---

## 3. Target data model

All additions go in `catalog.prisma` (PO, receipt) and `finance.prisma` (bill link), matching where
the existing models already live. Every model added to a domain file must also be added to the
`MODEL_DOMAIN` map in `apps/api/scripts/split-prisma-schema.mjs` or
`node apps/api/scripts/split-prisma-schema.mjs --check` fails.

```prisma
// ─── apps/api/prisma/schema/catalog.prisma ────────────────────────────────

enum PurchaseOrderStatus {
  DRAFT          // being built, freely editable, no stock or money consequence
  SENT           // issued to the supplier; lines may no longer be deleted, only closed
  PARTIAL        // some but not all ordered qty received  (DERIVED — never set by hand)
  RECEIVED       // receivedPct >= 100                      (DERIVED)
  CLOSED         // terminal: fully billed, or remainder manually written off
  CANCELLED      // terminal: abandoned before any receipt
}

model PurchaseOrder {
  id            String              @id @default(uuid())
  poNumber      String
  supplierId    String
  status        PurchaseOrderStatus @default(DRAFT)
  expectedDate  DateTime?
  notes         String?
  totalAmount   Decimal             @db.Decimal(10, 2)

  // NEW ────────────────────────────────────────────────────────────────────
  /// The number the SUPPLIER prints on their own paperwork. Matching needs this as much
  /// as it needs poNumber — a scanned invoice usually quotes the vendor's reference.
  supplierReference String?
  /// Derived roll-ups, recomputed by recomputePoRollups(). Never written directly.
  /// Min-clamped: Σ min(done, ordered) / Σ ordered, so over-receipt cannot exceed 100.
  receivedPct   Decimal             @default(0) @db.Decimal(5, 2)
  billedPct     Decimal             @default(0) @db.Decimal(5, 2)
  /// Immutability flag, orthogonal to status (inherited from Odoo's "locked" boolean).
  locked        Boolean             @default(false)
  sentAt        DateTime?
  closedAt      DateTime?
  closedById    String?
  createdById   String?
  // ─────────────────────────────────────────────────────────────────────────

  createdAt     DateTime            @default(now())
  updatedAt     DateTime            @updatedAt
  tenantId      String?

  supplier Supplier            @relation(fields: [supplierId], references: [id])
  tenant   Tenant?             @relation(fields: [tenantId], references: [id])
  items    PurchaseOrderItem[]
  receipts GoodsReceipt[]
  bills    VendorBill[]

  @@unique([tenantId, poNumber])
  @@index([supplierId])
  @@index([status])
  @@index([createdAt])
  @@index([tenantId])
  @@index([tenantId, expectedDate])              // NEW — "what's due in" views
  @@index([tenantId, supplierId, status])        // NEW — the matcher's hot path
  @@index([tenantId, supplierReference])         // NEW — matcher strategy 2
}

model PurchaseOrderItem {
  id          String  @id @default(uuid())
  poId        String
  productId   String
  /// CANONICAL UNIT: PIECES. A case line is expanded at entry via packSize.
  /// This mirrors StockMovement.quantity so no conversion happens at receipt time.
  qtyOrdered  Decimal @db.Decimal(10, 3)
  /// DERIVED — full re-sum of GoodsReceiptItem.qtyReceived. Never incremented.
  qtyReceived Decimal @default(0) @db.Decimal(10, 3)
  /// NEW. DERIVED — full re-sum of VendorBillItem.qty for bill lines pointing here.
  qtyBilled   Decimal @default(0) @db.Decimal(10, 3)
  /// Cost per PIECE, matching qtyOrdered's denomination.
  unitCost    Decimal @db.Decimal(10, 4)
  totalCost   Decimal @db.Decimal(10, 2)

  // NEW ────────────────────────────────────────────────────────────────────
  /// Entry-time convenience: how the buyer typed it. Display only; qtyOrdered is truth.
  packSize    Int?
  description String?
  /// Line-level write-off of a remainder — drops out of the roll-up denominator.
  closed      Boolean @default(false)
  // ─────────────────────────────────────────────────────────────────────────

  tenantId    String?

  po           PurchaseOrder      @relation(fields: [poId], references: [id], onDelete: Cascade)
  tenant       Tenant?            @relation(fields: [tenantId], references: [id])
  product      Product            @relation(fields: [productId], references: [id])
  receiptItems GoodsReceiptItem[]
  billItems    VendorBillItem[]

  @@index([poId])
  @@index([productId])
  @@index([tenantId])
}

/// NEW. The ONLY path that writes stock for a PO-backed purchase.
/// One receipt = one physical delivery. Under-receipt leaves the PO open; a later
/// delivery is a second receipt. (We do NOT split backorders in v1 — see §9.)
model GoodsReceipt {
  id            String   @id @default(uuid())
  receiptNumber String
  poId          String
  supplierId    String
  receivedAt    DateTime @default(now())
  receivedById  String?
  notes         String?
  /// Σ(qtyReceived × unitCost) at receipt time — the accrual basis for value-received-not-billed.
  totalValue    Decimal  @db.Decimal(12, 2)
  /// Set when a receipt is reversed. A reversal writes compensating stock movements;
  /// the row is never deleted, so the audit chain holds.
  voidedAt      DateTime?
  voidedById    String?
  createdAt     DateTime @default(now())
  tenantId      String?

  po       PurchaseOrder      @relation(fields: [poId], references: [id])
  supplier Supplier           @relation(fields: [supplierId], references: [id])
  tenant   Tenant?            @relation(fields: [tenantId], references: [id])
  items    GoodsReceiptItem[]

  @@unique([tenantId, receiptNumber])
  @@index([poId])
  @@index([tenantId, receivedAt])
  @@index([tenantId, supplierId])
}

model GoodsReceiptItem {
  id          String  @id @default(uuid())
  receiptId   String
  poItemId    String
  productId   String
  /// PIECES received on THIS delivery.
  qtyReceived Decimal @db.Decimal(10, 3)
  /// Cost per PIECE actually charged on this delivery — may differ from the PO's unitCost.
  unitCost    Decimal @db.Decimal(10, 4)
  lineValue   Decimal @db.Decimal(12, 2)
  tenantId    String?

  receipt GoodsReceipt      @relation(fields: [receiptId], references: [id], onDelete: Cascade)
  poItem  PurchaseOrderItem @relation(fields: [poItemId], references: [id])
  product Product           @relation(fields: [productId], references: [id])
  tenant  Tenant?           @relation(fields: [tenantId], references: [id])

  @@index([receiptId])
  @@index([poItemId])
  @@index([productId])
}
```

```prisma
// ─── apps/api/prisma/schema/finance.prisma ────────────────────────────────

model VendorBill {
  // ... all existing fields unchanged ...

  // NEW ────────────────────────────────────────────────────────────────────
  /// Makes CreateVendorBillDto.purchaseOrderId real. Today it is accepted and dropped.
  purchaseOrderId String?
  /// Discretionary payment block (ERPNext's on-hold trio).
  onHold          Boolean   @default(false)
  holdReason      String?
  /// A hold can be time-boxed: blocked = onHold && (holdReleaseAt == null || holdReleaseAt > now)
  holdReleaseAt   DateTime?
  /// Set when the three-way match finds a variance outside tolerance. Blocks payment
  /// independently of onHold, and is cleared only by re-matching within tolerance.
  matchVariance   Json?
  // ─────────────────────────────────────────────────────────────────────────

  purchaseOrder PurchaseOrder? @relation(fields: [purchaseOrderId], references: [id])

  @@index([tenantId, purchaseOrderId])   // NEW
  @@index([tenantId, onHold])            // NEW — payment runs must exclude held bills
}

model VendorBillItem {
  // ... all existing fields unchanged ...

  // NEW — the third leg of the match. Nullable: a bill line need not come from a PO.
  poItemId String?
  poItem   PurchaseOrderItem? @relation(fields: [poItemId], references: [id])

  @@index([poItemId])   // NEW
}
```

Two supporting additions:

```prisma
// platform.prisma — DocumentNumberType gains two members
enum DocumentNumberType {
  INVOICE
  ESTIMATE
  CREDIT_NOTE
  PAYMENT
  RETURN
  ORDER
  PURCHASE_ORDER   // NEW
  GOODS_RECEIPT    // NEW
}

// tenancy.prisma — TenantConfig gains the purchasing policy block
model TenantConfig {
  // ... existing ...
  /// ERPNext's "Purchase Order Required" switch — the lever that makes POs actually used.
  requirePoForBills        Boolean @default(false)
  /// Percentage headroom before an over-receipt / over-bill is a hard error.
  overReceiptTolerancePct  Decimal @default(0) @db.Decimal(5, 2)
  overBillingTolerancePct  Decimal @default(0) @db.Decimal(5, 2)
  /// Absolute currency tolerance for the "vendor + total" matcher fallback.
  matchTotalTolerance      Decimal @default(0.02) @db.Decimal(10, 2)
}

// catalog.prisma — Supplier gains the per-supplier escape hatch
model Supplier {
  // ... existing ...
  /// Exempts this supplier from requirePoForBills (ERPNext's per-supplier flag).
  exemptFromPoRequirement Boolean @default(false)
}
```

---

## 4. The central design decision: exactly one stock write

This is the most important section in the document. Get it wrong and every PO-backed purchase
doubles stock and corrupts average cost.

**Today there are two stock-writing paths, mutually unaware:**

```
Path A:  PO ──▶ InventoryService.receivePurchaseOrder ──▶ stock +Q, avgCost reblended
Path B:  Bill ─▶ VendorBillsService.receive          ──▶ stock +Q, avgCost reblended
```

**The rule, from here on:**

> **Stock is written by whichever document represents the physical arrival — and only once.
> A bill linked to a PO is a financial document only.**

Concretely:

| Scenario | Who writes stock | Who writes money |
|---|---|---|
| PO → GoodsReceipt → bill (linked) | `GoodsReceipt` | bill |
| Bill with **no** PO (invoice off the truck — today's normal flow, `AP-M3`) | bill, unchanged | bill |
| PO → bill directly, no receipt recorded | the bill, **and** it back-fills a `GoodsReceipt` | bill |
| Direct stock purchase, no PO and no bill (`AP-M13`) | `recordPurchase`, unchanged | n/a |

The third row matters operationally: some tenants will raise a PO and then only ever key the
invoice. Rather than force a separate receipt step, `receive()` detects `purchaseOrderId != null`
with no covering receipt and **creates the receipt itself**, so the invariant "stock is written by a
GoodsReceipt" holds for every PO-backed purchase without adding a click.

`VendorBillsService.receive` therefore gains one guard at the top — everything else about it is
untouched, which is deliberate: `AP-M3` is SHIPPED, tested, and is the daily flow. **Do not
refactor it.**

```ts
// apps/api/src/vendor-bills/vendor-bills.service.ts — inside receive(), before any stock write
if (bill.purchaseOrderId) {
  // PO-backed: the physical arrival is a GoodsReceipt, never this bill.
  // If no receipt covers these lines yet, mint one; otherwise this bill moves money only.
  await this.purchaseOrders.ensureReceiptForBill(bill.id, performedById, tx);
  await this.purchaseOrders.recomputeFromBill(bill.id, tx);
  return this.markBillReceivedFinancialsOnly(bill.id, tx);
}
// ...existing non-PO path continues unchanged below...
```

---

## 5. Derived quantities, status, and the min-clamp

**Invariant: `qtyReceived` and `qtyBilled` are never incremented. They are full re-sums.**

An increment is a lost update waiting to happen, and it cannot self-heal when a receipt is voided
or a bill reverted. A full re-sum is idempotent: run it twice, get the same answer.

```ts
// apps/api/src/purchase-orders/po-rollups.ts
import { Prisma } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { PurchaseOrderStatus } from "@prisma/client";

const D = (v: Prisma.Decimal | number | string | null | undefined) =>
  new Prisma.Decimal(v ?? 0);

/**
 * Re-derives every quantity and percentage on a PO from its children, then derives status.
 * Idempotent by construction. Call inside the same transaction as any child write.
 */
export async function recomputePoRollups(tx: any, poId: string): Promise<void> {
  const po = await tx.purchaseOrder.findUnique({
    where: { id: poId },
    select: { id: true, status: true, locked: true },
  });
  if (!po) return;

  const items = await tx.purchaseOrderItem.findMany({
    where: { poId },
    select: { id: true, qtyOrdered: true, closed: true },
  });
  if (items.length === 0) return;

  const itemIds = items.map((i: any) => i.id);

  // Full re-sum from the child rows — NEVER an increment.
  const receivedRows = await tx.goodsReceiptItem.groupBy({
    by: ["poItemId"],
    where: { poItemId: { in: itemIds }, receipt: { voidedAt: null } },
    _sum: { qtyReceived: true },
  });
  const billedRows = await tx.vendorBillItem.groupBy({
    by: ["poItemId"],
    where: {
      poItemId: { in: itemIds },
      vendorBill: { status: { not: "VOID" } },
    },
    _sum: { qty: true },
  });

  const receivedBy = new Map<string, Prisma.Decimal>(
    receivedRows.map((r: any) => [r.poItemId, D(r._sum.qtyReceived)]),
  );
  const billedBy = new Map<string, Prisma.Decimal>(
    billedRows.map((r: any) => [r.poItemId, D(r._sum.qty)]),
  );

  let orderedTotal = D(0);
  let receivedClamped = D(0);
  let billedClamped = D(0);

  for (const item of items) {
    const received = receivedBy.get(item.id) ?? D(0);
    const billed = billedBy.get(item.id) ?? D(0);

    await tx.purchaseOrderItem.update({
      where: { id: item.id },
      data: { qtyReceived: received, qtyBilled: billed },
    });

    // A closed line drops out of the denominator entirely (inherited from ERPNext).
    if (item.closed) continue;

    const ordered = D(item.qtyOrdered);
    orderedTotal = orderedTotal.add(ordered);
    // MIN-CLAMP: over-receipt must not push the PO past 100%.
    receivedClamped = receivedClamped.add(
      received.greaterThan(ordered) ? ordered : received,
    );
    billedClamped = billedClamped.add(billed.greaterThan(ordered) ? ordered : billed);
  }

  const pct = (part: Prisma.Decimal) =>
    orderedTotal.isZero()
      ? D(0)
      : part.mul(100).dividedBy(orderedTotal).toDecimalPlaces(2);

  const receivedPct = pct(receivedClamped);
  const billedPct = pct(billedClamped);

  await tx.purchaseOrder.update({
    where: { id: poId },
    data: {
      receivedPct,
      billedPct,
      status: derivePoStatus(po.status, receivedPct, billedPct),
    },
  });
}

/**
 * Status is a pure function of the two percentages, except for the three states a human
 * sets explicitly (DRAFT, CANCELLED, CLOSED), which are never overridden by derivation.
 */
export function derivePoStatus(
  current: PurchaseOrderStatus,
  receivedPct: Prisma.Decimal,
  billedPct: Prisma.Decimal,
): PurchaseOrderStatus {
  if (current === "DRAFT" || current === "CANCELLED" || current === "CLOSED") return current;
  if (receivedPct.greaterThanOrEqualTo(100) && billedPct.greaterThanOrEqualTo(100)) {
    return "CLOSED";
  }
  if (receivedPct.greaterThanOrEqualTo(100)) return "RECEIVED";
  if (receivedPct.greaterThan(0)) return "PARTIAL";
  return "SENT";
}
```

---

## 6. Receiving — and the B285 fix

B285 is: read `currentStock` unlocked → compute `stockAfter` → write it absolutely. Two concurrent
receipts of the same product both read 100, both write 110, and 10 pieces vanish.

The fix is the inherited invariant: **lock the row, then write a delta.** Quantity alone could be
made safe with an atomic `{ increment }`, but average cost genuinely needs the pre-state to blend,
so a real row lock is required.

```ts
// apps/api/src/purchase-orders/stock-writer.ts
import { Prisma } from "@prisma/client";
import { nextAverageCost, costDecimal } from "../inventory/costing";

export interface StockWriteResult {
  stockAfter: Prisma.Decimal;
  avgCostAfter: Prisma.Decimal | null;
}

/**
 * The ONE safe way to move purchase stock. Locks the product row FOR UPDATE, reads the
 * pre-state under that lock, then writes a delta. Fixes B285.
 *
 * MUST be called inside a transaction — the lock is released at commit. Prisma has no
 * native FOR UPDATE, so the lock is taken with $queryRaw.
 */
export async function applyPurchaseStockDelta(
  tx: any,
  args: {
    productId: string;
    qtyPieces: Prisma.Decimal;   // signed: negative reverses a receipt
    unitCostPerPiece: Prisma.Decimal;
    supplierId: string | null;
    reference: string;
    performedById?: string;
    movementType?: "PURCHASE" | "RETURN";
  },
): Promise<StockWriteResult> {
  const { productId, qtyPieces, unitCostPerPiece } = args;

  // 1. LOCK FIRST. Nothing below may read product state before this line.
  const locked = await tx.$queryRaw<
    Array<{ currentStock: Prisma.Decimal; averageCost: Prisma.Decimal | null; costingMethod: string }>
  >(Prisma.sql`
    SELECT "currentStock", "averageCost", "costingMethod"
    FROM "Product"
    WHERE id = ${productId}
    FOR UPDATE
  `);
  if (locked.length === 0) {
    throw new Error(`applyPurchaseStockDelta: product ${productId} not found`);
  }
  const before = locked[0];
  const stockBefore = new Prisma.Decimal(before.currentStock ?? 0);

  // 2. Compute under the lock.
  const stockAfter = stockBefore.add(qtyPieces);
  const updatesAverage = before.costingMethod !== "STANDARD" && qtyPieces.greaterThan(0);
  const avgCostAfter = updatesAverage
    ? nextAverageCost(stockBefore, before.averageCost, qtyPieces, unitCostPerPiece)
    : before.averageCost
      ? new Prisma.Decimal(before.averageCost)
      : null;

  // 3. Write a DELTA for quantity (atomic even under the lock), absolute only for the
  //    blended average, which is a pure function of the values we just read under lock.
  await tx.product.update({
    where: { id: productId },
    data: {
      currentStock: { increment: qtyPieces },
      ...(updatesAverage && avgCostAfter ? { averageCost: avgCostAfter } : {}),
    },
  });

  await tx.stockMovement.create({
    data: {
      productId,
      type: args.movementType ?? "PURCHASE",
      quantity: qtyPieces,
      unitCost: unitCostPerPiece,
      avgCostAfter,
      stockAfter,
      supplierId: args.supplierId,
      reference: args.reference,
      performedById: args.performedById,
    },
  });

  if (qtyPieces.greaterThan(0)) {
    await tx.stockLot.create({
      data: {
        productId,
        qty: qtyPieces,
        remainingQty: qtyPieces,
        unitCost: unitCostPerPiece,
        reference: args.reference,
      },
    });
  }

  return { stockAfter, avgCostAfter };
}
```

> **Note on costing.** RouteFlow runs **AVCO** (`CostingMethod.AVCO` is the default and the live
> path; the FIFO/LIFO lot-consumption path has no caller). `nextAverageCost` is reused as-is.
> `StockLot` rows are still written so the lot history exists if FIFO is ever activated — but no
> FIFO consumption logic is added here.
>
> **One WAC edge case — verified already correct.** The AVCO survey flagged that when stock reaches
> zero or goes negative and a new receipt arrives, the average must **reset to the new receipt's
> unit cost** rather than blend against a stale or zero-denominator average. `nextAverageCost`
> already does exactly this (`if (currentStock.lte(0)) return costDecimal(unitCost)`), matching
> the behaviour Odoo settled on. No change needed — but keep the regression test in §12, because
> this is a silent-corruption bug if anyone ever "simplifies" that guard away.

### The receipt service

```ts
// apps/api/src/purchase-orders/goods-receipt.service.ts
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, DocumentNumberType } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { PrismaService } from "../prisma/prisma.service";
import { NumberingService } from "../import/numbering.service";
import { applyPurchaseStockDelta } from "./stock-writer";
import { recomputePoRollups } from "./po-rollups";
import { assertWithinReceiptTolerance } from "./tolerance";
import { loadPurchasingPolicy } from "./purchasing-policy";

export interface ReceiveLineInput {
  poItemId: string;
  qtyReceived: number;     // PIECES
  unitCost?: number;       // per PIECE; defaults to the PO line's unitCost
}

@Injectable()
export class GoodsReceiptService {
  private readonly logger = new Logger(GoodsReceiptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
  ) {}

  /**
   * Record a physical delivery against a PO. This is the ONLY entry point that moves
   * stock for a PO-backed purchase.
   */
  async receive(
    poId: string,
    lines: ReceiveLineInput[],
    receivedById: string,
    opts: { notes?: string; allowOverReceipt?: boolean } = {},
  ) {
    if (lines.length === 0) {
      throw new BadRequestException("A receipt needs at least one line");
    }

    return this.prisma.tenantTransaction(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({
        where: { id: poId },
        include: { items: true },
      });
      if (!po) throw new NotFoundException("Purchase order not found");
      if (po.status === "DRAFT") {
        throw new ConflictException("Send the purchase order before receiving against it");
      }
      if (po.status === "CANCELLED") {
        throw new ConflictException("Cannot receive against a cancelled purchase order");
      }

      const policy = await loadPurchasingPolicy(tx);
      const byId = new Map(po.items.map((i: any) => [i.id, i]));

      // Validate every line BEFORE writing anything.
      for (const line of lines) {
        const poItem = byId.get(line.poItemId);
        if (!poItem) {
          throw new BadRequestException(`Line ${line.poItemId} does not belong to this PO`);
        }
        if (line.qtyReceived <= 0) {
          throw new BadRequestException("Received quantity must be positive");
        }
        await assertWithinReceiptTolerance(tx, {
          poItem,
          incomingQty: new Prisma.Decimal(line.qtyReceived),
          tolerancePct: policy.overReceiptTolerancePct,
          bypass: opts.allowOverReceipt === true,
        });
      }

      const receiptNumber = await this.numbering.reserveNext(
        DocumentNumberType.GOODS_RECEIPT,
        { tx },
      );

      let totalValue = 0;
      const receipt = await tx.goodsReceipt.create({
        data: {
          receiptNumber,
          poId,
          supplierId: po.supplierId,
          receivedById,
          notes: opts.notes,
          totalValue: new Prisma.Decimal(0),
        },
      });

      for (const line of lines) {
        const poItem = byId.get(line.poItemId)!;
        const qty = new Prisma.Decimal(line.qtyReceived);
        const unitCost = new Prisma.Decimal(line.unitCost ?? poItem.unitCost);
        const lineValue = roundMoney(qty.mul(unitCost).toNumber());
        totalValue = roundMoney(totalValue + lineValue);

        await tx.goodsReceiptItem.create({
          data: {
            receiptId: receipt.id,
            poItemId: poItem.id,
            productId: poItem.productId,
            qtyReceived: qty,
            unitCost,
            lineValue: new Prisma.Decimal(lineValue),
          },
        });

        // The single stock write — locked, delta-based. B285-safe.
        await applyPurchaseStockDelta(tx, {
          productId: poItem.productId,
          qtyPieces: qty,
          unitCostPerPiece: unitCost,
          supplierId: po.supplierId,
          reference: receipt.receiptNumber,
          performedById: receivedById,
        });
      }

      await tx.goodsReceipt.update({
        where: { id: receipt.id },
        data: { totalValue: new Prisma.Decimal(totalValue) },
      });

      // Derive, never increment.
      await recomputePoRollups(tx, poId);

      return tx.goodsReceipt.findUnique({
        where: { id: receipt.id },
        include: { items: true, po: { select: { poNumber: true, status: true, receivedPct: true } } },
      });
    });
  }

  /**
   * Reverse a receipt. Writes compensating movements; never deletes rows, so the audit
   * chain and every downstream re-sum stay correct.
   */
  async voidReceipt(receiptId: string, voidedById: string) {
    return this.prisma.tenantTransaction(async (tx) => {
      const receipt = await tx.goodsReceipt.findUnique({
        where: { id: receiptId },
        include: { items: true },
      });
      if (!receipt) throw new NotFoundException("Receipt not found");
      if (receipt.voidedAt) return receipt; // idempotent

      const billedAgainst = await tx.vendorBillItem.count({
        where: {
          poItemId: { in: receipt.items.map((i: any) => i.poItemId) },
          vendorBill: { status: { not: "VOID" } },
        },
      });
      if (billedAgainst > 0) {
        throw new ConflictException(
          "Void or revert the bills raised against this receipt before voiding it",
        );
      }

      for (const item of receipt.items) {
        await applyPurchaseStockDelta(tx, {
          productId: item.productId,
          qtyPieces: new Prisma.Decimal(item.qtyReceived).negated(),
          unitCostPerPiece: new Prisma.Decimal(item.unitCost),
          supplierId: receipt.supplierId,
          reference: `VOID ${receipt.receiptNumber}`,
          performedById: voidedById,
          movementType: "RETURN",
        });
      }

      await tx.goodsReceipt.update({
        where: { id: receiptId },
        data: { voidedAt: new Date(), voidedById },
      });
      await recomputePoRollups(tx, receipt.poId);

      return tx.goodsReceipt.findUnique({ where: { id: receiptId } });
    });
  }
}
```

### Reading the purchasing policy

There is no `TenantConfigService` in this codebase — services read `TenantConfig` directly through
the tenant-scoped client (e.g. `route-optimization.service.ts:189`). One small helper keeps that
pattern and gives every call site the same defaults:

```ts
// apps/api/src/purchase-orders/purchasing-policy.ts
import { Prisma } from "@prisma/client";

export interface PurchasingPolicy {
  requirePoForBills: boolean;
  overReceiptTolerancePct: Prisma.Decimal;
  overBillingTolerancePct: Prisma.Decimal;
  matchTotalTolerance: number;
}

/**
 * Load the tenant's purchasing policy. Pass a tenant-scoped client: either a `tx` from
 * tenantTransaction(), or prisma.forTenant(). Never the raw client — that would read
 * across tenants.
 */
export async function loadPurchasingPolicy(db: any): Promise<PurchasingPolicy> {
  const cfg = await db.tenantConfig.findFirst({
    select: {
      requirePoForBills: true,
      overReceiptTolerancePct: true,
      overBillingTolerancePct: true,
      matchTotalTolerance: true,
    },
  });

  return {
    requirePoForBills: cfg?.requirePoForBills ?? false,
    overReceiptTolerancePct: new Prisma.Decimal(cfg?.overReceiptTolerancePct ?? 0),
    overBillingTolerancePct: new Prisma.Decimal(cfg?.overBillingTolerancePct ?? 0),
    matchTotalTolerance: Number(cfg?.matchTotalTolerance ?? 0.02),
  };
}
```

### Tolerance

```ts
// apps/api/src/purchase-orders/tolerance.ts
import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * ERPNext's over-receipt allowance, adapted. A breach is a hard error naming the maximum
 * allowed; a caller holding the bypass right downgrades it to an accepted over-receipt.
 */
export async function assertWithinReceiptTolerance(
  tx: any,
  args: {
    poItem: { id: string; qtyOrdered: Prisma.Decimal; qtyReceived: Prisma.Decimal };
    incomingQty: Prisma.Decimal;
    tolerancePct: Prisma.Decimal;
    bypass: boolean;
  },
): Promise<void> {
  const ordered = new Prisma.Decimal(args.poItem.qtyOrdered);
  const alreadyReceived = new Prisma.Decimal(args.poItem.qtyReceived);
  const cumulative = alreadyReceived.add(args.incomingQty);

  const maxAllowed = ordered.mul(new Prisma.Decimal(100).add(args.tolerancePct)).dividedBy(100);
  if (cumulative.lessThanOrEqualTo(maxAllowed)) return;
  if (args.bypass) return;

  const headroom = maxAllowed.sub(alreadyReceived);
  throw new ConflictException({
    code: "OVER_RECEIPT",
    message:
      `Receiving ${args.incomingQty.toFixed(3)} would put this line at ` +
      `${cumulative.toFixed(3)} against ${ordered.toFixed(3)} ordered. ` +
      `Maximum receivable now is ${headroom.toFixed(3)}.`,
    poItemId: args.poItem.id,
    ordered: ordered.toFixed(3),
    alreadyReceived: alreadyReceived.toFixed(3),
    maxReceivableNow: headroom.toFixed(3),
  });
}
```

---

## 7. Bill ↔ PO matching — the part this request is really about

Two ways a bill gets onto a PO. Build both.

### Path A — pull from the PO (primary, always available)

The operator opens a PO and clicks **Create bill**. Header copies from the PO; each line defaults
to *remaining to bill* (`qtyReceived − qtyBilled`, so you cannot bill goods that never arrived) and
permanently stores `poItemId`.

```ts
// apps/api/src/purchase-orders/purchase-orders.service.ts (excerpt)
/**
 * Build a DRAFT bill from a PO, pre-filled with what is received but not yet billed.
 * Billing is capped at RECEIVED, never at ORDERED — you cannot bill goods that have
 * not arrived. (Odoo calls this the "on received quantities" bill-control policy; it is
 * the only sane default for a distributor and we do not make it configurable.)
 */
async createBillFromPo(poId: string, createdById: string) {
  return this.prisma.tenantTransaction(async (tx) => {
    const po = await tx.purchaseOrder.findUnique({
      where: { id: poId },
      include: { items: { include: { product: true } }, supplier: true },
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    if (po.status === "DRAFT") {
      throw new ConflictException("Send the purchase order before billing it");
    }

    const billable = po.items
      .filter((i: any) => !i.closed)
      .map((i: any) => {
        const remaining = new Prisma.Decimal(i.qtyReceived).sub(i.qtyBilled);
        return { poItem: i, remaining };
      })
      .filter(({ remaining }) => remaining.greaterThan(0));

    if (billable.length === 0) {
      throw new ConflictException({
        code: "NOTHING_TO_BILL",
        message:
          "Every received line on this purchase order is already billed. " +
          "Receive the outstanding goods first.",
      });
    }

    const billNumber = await this.numbering.reserveNext(DocumentNumberType.INVOICE, { tx });
    let subtotal = 0;

    const bill = await tx.vendorBill.create({
      data: {
        billNumber,
        supplierId: po.supplierId,
        purchaseOrderId: po.id,
        status: "DRAFT",
        billDate: new Date(),
        termsLabel: po.supplier?.defaultTerms ?? null,
        totalOwed: new Prisma.Decimal(0),
        subtotal: new Prisma.Decimal(0),
      },
    });

    for (const { poItem, remaining } of billable) {
      const unitCost = new Prisma.Decimal(poItem.unitCost);
      const lineTotal = roundMoney(remaining.mul(unitCost).toNumber());
      subtotal = roundMoney(subtotal + lineTotal);

      await tx.vendorBillItem.create({
        data: {
          vendorBillId: bill.id,
          poItemId: poItem.id,              // the permanent link
          productId: poItem.productId,
          description: poItem.description ?? poItem.product?.name ?? "",
          qty: remaining,
          unitCost,
          lineTotal: new Prisma.Decimal(lineTotal),
        },
      });
    }

    await tx.vendorBill.update({
      where: { id: bill.id },
      data: {
        subtotal: new Prisma.Decimal(subtotal),
        totalOwed: new Prisma.Decimal(subtotal),
      },
    });

    await recomputePoRollups(tx, poId);
    return tx.vendorBill.findUnique({ where: { id: bill.id }, include: { items: true } });
  });
}
```

### Path B — match a scanned invoice to a PO (the automation)

The scanner already produces vendor and total. It needs one more extracted field — **candidate PO
reference strings** — and then this cascade runs. The strategy order is inherited from Odoo, whose
matching design is in the community codebase even though its OCR extractor is enterprise-only. The
useful consequence: the extractor only has to yield **three things** — candidate PO references,
vendor, and invoice total.

```ts
// apps/api/src/purchase-orders/po-matcher.ts
import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { PrismaService } from "../prisma/prisma.service";
import { loadPurchasingPolicy } from "./purchasing-policy";

export type MatchStrategy = "PO_NUMBER" | "SUPPLIER_REFERENCE" | "SUPPLIER_TOTAL" | "NONE";

export interface PoMatchCandidate {
  poId: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  strategy: MatchStrategy;
  /** HIGH → safe to auto-link. MEDIUM/LOW → present to a human, never auto-link. */
  confidence: "HIGH" | "MEDIUM" | "LOW";
  remainingToBill: number;
  totalDelta: number | null;
  reason: string;
}

@Injectable()
export class PoMatcherService {
  private readonly logger = new Logger(PoMatcherService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Find the PO a scanned supplier invoice belongs to.
   *
   * Strategy order (inherited from Odoo):
   *   1. Our own PO number quoted on the document        → HIGH
   *   2. The supplier's own reference we recorded on the PO → HIGH
   *   3. Exactly one open PO for that supplier whose remaining-to-bill
   *      equals the invoice total within tolerance        → MEDIUM
   * Anything else → NONE. We never guess.
   */
  async match(input: {
    candidateReferences: string[];
    supplierId?: string | null;
    supplierNameRaw?: string | null;
    invoiceTotal?: number | null;
  }): Promise<PoMatchCandidate[]> {
    const db = this.prisma.forTenant();
    const refs = normalizeRefs(input.candidateReferences);

    // ── Strategy 1: our PO number ────────────────────────────────────────
    if (refs.length > 0) {
      const byNumber = await db.purchaseOrder.findMany({
        where: {
          poNumber: { in: refs, mode: "insensitive" },
          status: { in: ["SENT", "PARTIAL", "RECEIVED"] },
        },
        include: { supplier: { select: { name: true } }, items: true },
      });
      if (byNumber.length > 0) {
        return byNumber.map((po) =>
          this.toCandidate(po, "PO_NUMBER", "HIGH", input.invoiceTotal,
            `Invoice quotes purchase order ${po.poNumber}`),
        );
      }

      // ── Strategy 2: the supplier's own reference ───────────────────────
      const byRef = await db.purchaseOrder.findMany({
        where: {
          supplierReference: { in: refs, mode: "insensitive" },
          status: { in: ["SENT", "PARTIAL", "RECEIVED"] },
        },
        include: { supplier: { select: { name: true } }, items: true },
      });
      if (byRef.length > 0) {
        return byRef.map((po) =>
          this.toCandidate(po, "SUPPLIER_REFERENCE", "HIGH", input.invoiceTotal,
            `Invoice quotes the supplier reference recorded on ${po.poNumber}`),
        );
      }
    }

    // ── Strategy 3: supplier + total within tolerance ─────────────────────
    if (input.supplierId && input.invoiceTotal != null) {
      const { matchTotalTolerance: tolerance } = await loadPurchasingPolicy(db);

      const open = await db.purchaseOrder.findMany({
        where: {
          supplierId: input.supplierId,
          status: { in: ["SENT", "PARTIAL", "RECEIVED"] },
        },
        include: { supplier: { select: { name: true } }, items: true },
      });

      const hits = open
        .map((po) => ({ po, remaining: remainingToBill(po.items) }))
        .filter(({ remaining }) =>
          Math.abs(roundMoney(remaining - input.invoiceTotal!)) <= tolerance,
        );

      // Accept ONLY if exactly one PO matches. Two is ambiguous; ambiguity is a human's job.
      if (hits.length === 1) {
        const { po } = hits[0];
        return [
          this.toCandidate(po, "SUPPLIER_TOTAL", "MEDIUM", input.invoiceTotal,
            `Only open purchase order for this supplier whose outstanding value matches the invoice total`),
        ];
      }
      if (hits.length > 1) {
        this.logger.log(
          `PO match ambiguous: ${hits.length} candidates for supplier ${input.supplierId}`,
        );
        return hits.map(({ po }) =>
          this.toCandidate(po, "SUPPLIER_TOTAL", "LOW", input.invoiceTotal,
            `One of ${hits.length} purchase orders matching this total — needs a human`),
        );
      }
    }

    return [];
  }

  private toCandidate(
    po: any,
    strategy: MatchStrategy,
    confidence: "HIGH" | "MEDIUM" | "LOW",
    invoiceTotal: number | null | undefined,
    reason: string,
  ): PoMatchCandidate {
    const remaining = remainingToBill(po.items);
    return {
      poId: po.id,
      poNumber: po.poNumber,
      supplierId: po.supplierId,
      supplierName: po.supplier?.name ?? "",
      strategy,
      confidence,
      remainingToBill: remaining,
      totalDelta: invoiceTotal == null ? null : roundMoney(remaining - invoiceTotal),
      reason,
    };
  }
}

function remainingToBill(items: any[]): number {
  return roundMoney(
    items
      .filter((i) => !i.closed)
      .reduce((sum, i) => {
        const qty = Number(i.qtyReceived) - Number(i.qtyBilled);
        return qty > 0 ? sum + qty * Number(i.unitCost) : sum;
      }, 0),
  );
}

/** "P.O. 2026-0042", "po#2026-0042" and "PO-2026-0042" must all resolve to one key. */
function normalizeRefs(raw: string[]): string[] {
  const out = new Set<string>();
  for (const value of raw ?? []) {
    if (!value) continue;
    const trimmed = value.trim();
    if (trimmed.length < 3) continue;
    out.add(trimmed);
    out.add(trimmed.replace(/[.\s#]/g, ""));
    out.add(trimmed.replace(/^P\.?\s?O\.?[-\s#]*/i, "PO-"));
  }
  return [...out];
}
```

### Wiring it into the existing scanner

`VendorBillsService.scanInvoice` already extracts, fingerprints and persists an `InvoiceScan`. Two
changes, both small:

1. **Extraction** — add `candidatePoReferences: string[]` to the extraction schema. The prompt asks
   for any number on the document that looks like a customer/PO reference. This is the only
   extractor change required.
2. **Post-scan** — after the scan row is written, run the matcher and stash the result on the scan
   so the review screen can offer it:

```ts
// vendor-bills.service.ts — at the end of scanInvoice(), after the InvoiceScan row exists
const poMatches = await this.poMatcher.match({
  candidateReferences: extracted.candidatePoReferences ?? [],
  supplierId: resolvedSupplierId,
  supplierNameRaw: extracted.supplierName,
  invoiceTotal: extracted.total,
});

await this.prisma.forTenant().invoiceScan.update({
  where: { id: scan.id },
  data: { extractedPayload: { ...extracted, poMatches } },
});
```

No auto-linking. A `HIGH` match is pre-selected in the UI; a human still confirms. That is
deliberate — an auto-linked wrong PO silently corrupts two documents.

### Variance detection at bill post

```ts
// apps/api/src/purchase-orders/variance.ts
import { Prisma } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";

export interface MatchVariance {
  poItemId: string;
  productId: string;
  kind: "OVER_BILLED_QTY" | "PRICE_ABOVE_PO";
  ordered: string;
  received: string;
  billedIncludingThis: string;
  poUnitCost?: string;
  billUnitCost?: string;
  deltaPct: string;
}

/**
 * Compare a bill against its PO and return every variance outside tolerance.
 * Quantity variance is measured against RECEIVED (you cannot bill what did not arrive);
 * price variance against the PO's agreed unit cost.
 */
export function detectVariances(args: {
  billItems: Array<{ poItemId: string | null; productId: string | null; qty: Prisma.Decimal; unitCost: Prisma.Decimal }>;
  poItems: Map<string, { id: string; productId: string; qtyOrdered: Prisma.Decimal; qtyReceived: Prisma.Decimal; qtyBilled: Prisma.Decimal; unitCost: Prisma.Decimal }>;
  overBillingTolerancePct: Prisma.Decimal;
  priceTolerancePct: Prisma.Decimal;
}): MatchVariance[] {
  const variances: MatchVariance[] = [];

  for (const line of args.billItems) {
    if (!line.poItemId) continue;
    const poItem = args.poItems.get(line.poItemId);
    if (!poItem) continue;

    // Quantity: cumulative billed must not exceed received beyond tolerance.
    const cumulative = new Prisma.Decimal(poItem.qtyBilled).add(line.qty);
    const ceiling = new Prisma.Decimal(poItem.qtyReceived)
      .mul(new Prisma.Decimal(100).add(args.overBillingTolerancePct))
      .dividedBy(100);

    if (cumulative.greaterThan(ceiling)) {
      const base = poItem.qtyReceived.isZero() ? new Prisma.Decimal(1) : poItem.qtyReceived;
      variances.push({
        poItemId: poItem.id,
        productId: poItem.productId,
        kind: "OVER_BILLED_QTY",
        ordered: poItem.qtyOrdered.toFixed(3),
        received: poItem.qtyReceived.toFixed(3),
        billedIncludingThis: cumulative.toFixed(3),
        deltaPct: cumulative.sub(poItem.qtyReceived).mul(100).dividedBy(base).toFixed(2),
      });
    }

    // Price: the invoice charging more per piece than the PO agreed.
    const poCost = new Prisma.Decimal(poItem.unitCost);
    if (!poCost.isZero() && line.unitCost.greaterThan(poCost)) {
      const deltaPct = line.unitCost.sub(poCost).mul(100).dividedBy(poCost);
      if (deltaPct.greaterThan(args.priceTolerancePct)) {
        variances.push({
          poItemId: poItem.id,
          productId: poItem.productId,
          kind: "PRICE_ABOVE_PO",
          ordered: poItem.qtyOrdered.toFixed(3),
          received: poItem.qtyReceived.toFixed(3),
          billedIncludingThis: cumulative.toFixed(3),
          poUnitCost: poCost.toFixed(4),
          billUnitCost: line.unitCost.toFixed(4),
          deltaPct: deltaPct.toFixed(2),
        });
      }
    }
  }

  return variances;
}
```

A bill carrying variances is written with `matchVariance` populated, which **blocks payment**:

```ts
// vendor-bills.service.ts — in recordPayment(), before any money moves
if (bill.matchVariance && (bill.matchVariance as any[]).length > 0) {
  throw new ConflictException({
    code: "BILL_HAS_MATCH_VARIANCE",
    message:
      "This bill does not match its purchase order. Resolve the variance, " +
      "or override it explicitly, before paying.",
    variances: bill.matchVariance,
  });
}
if (isBillOnHold(bill)) {
  throw new ConflictException({
    code: "BILL_ON_HOLD",
    message: bill.holdReason ?? "This bill is on hold and cannot be paid.",
    holdReleaseAt: bill.holdReleaseAt,
  });
}
```

```ts
// apps/api/src/vendor-bills/hold.ts
/** A hold blocks payment until it is lifted, or until its release date passes. */
export function isBillOnHold(bill: {
  onHold: boolean;
  holdReleaseAt: Date | null;
}, now: Date = new Date()): boolean {
  if (!bill.onHold) return false;
  if (!bill.holdReleaseAt) return true;
  return bill.holdReleaseAt.getTime() > now.getTime();
}
```

### The "PO required" policy

```ts
// vendor-bills.service.ts — in create(), before the bill row is written
const policy = await loadPurchasingPolicy(tx);
if (policy.requirePoForBills && !dto.purchaseOrderId) {
  const supplier = dto.supplierId
    ? await tx.supplier.findUnique({
        where: { id: dto.supplierId },
        select: { exemptFromPoRequirement: true, name: true },
      })
    : null;

  if (!supplier?.exemptFromPoRequirement) {
    throw new BadRequestException({
      code: "PO_REQUIRED",
      message:
        `A purchase order is required for ${supplier?.name ?? "this supplier"}. ` +
        `Raise or select a purchase order, or mark the supplier exempt in Settings.`,
    });
  }
}
```

---

## 8. API surface

New module `apps/api/src/purchase-orders/` — the PO code moves out of `inventory`. The old
`/inventory/purchase-orders/*` routes are kept as thin deprecated forwarders for one release so the
mobile app keeps working (see §10).

```ts
// apps/api/src/purchase-orders/purchase-orders.controller.ts
import {
  Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { Roles } from "../auth/roles.decorator";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/plan-flag.decorator";
import { UserRole } from "@prisma/client";
import { PurchaseOrdersService } from "./purchase-orders.service";
import { GoodsReceiptService } from "./goods-receipt.service";
import { PoMatcherService } from "./po-matcher.service";
import { CreatePurchaseOrderDto } from "./dto/create-purchase-order.dto";
import { UpdatePurchaseOrderDto } from "./dto/update-purchase-order.dto";
import { ReceivePurchaseOrderDto } from "./dto/receive-purchase-order.dto";
import { ListPurchaseOrdersDto } from "./dto/list-purchase-orders.dto";
import { MatchScanToPoDto } from "./dto/match-scan-to-po.dto";

// NOTE: OPERATOR only, on every route. This is the B168 fix — a driver must not raise
// a purchase order, receive stock against it, or rewrite cost basis.
@Controller("purchase-orders")
@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard)
@RequirePlanFlag("flag.ap_bills")
@Roles(UserRole.OPERATOR)
export class PurchaseOrdersController {
  constructor(
    private readonly service: PurchaseOrdersService,
    private readonly receipts: GoodsReceiptService,
    private readonly matcher: PoMatcherService,
  ) {}

  @Get()
  list(@Query() query: ListPurchaseOrdersDto) {
    return this.service.findAll(query);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.service.findOne(id);
  }

  @Post()
  create(@Body() dto: CreatePurchaseOrderDto, @Req() req: any) {
    return this.service.create(dto, req.user.id);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdatePurchaseOrderDto) {
    return this.service.update(id, dto);
  }

  @Post(":id/send")
  send(@Param("id") id: string) {
    return this.service.send(id);
  }

  /** Record a physical delivery. The only stock-moving route in this controller. */
  @Post(":id/receipts")
  receive(@Param("id") id: string, @Body() dto: ReceivePurchaseOrderDto, @Req() req: any) {
    return this.receipts.receive(id, dto.lines, req.user.id, {
      notes: dto.notes,
      allowOverReceipt: dto.allowOverReceipt,
    });
  }

  @Get(":id/receipts")
  listReceipts(@Param("id") id: string) {
    return this.service.listReceipts(id);
  }

  @Post("receipts/:receiptId/void")
  voidReceipt(@Param("receiptId") receiptId: string, @Req() req: any) {
    return this.receipts.voidReceipt(receiptId, req.user.id);
  }

  /** Draft a bill pre-filled with everything received but not yet billed. */
  @Post(":id/bills")
  createBill(@Param("id") id: string, @Req() req: any) {
    return this.service.createBillFromPo(id, req.user.id);
  }

  /** Close a PO, writing off any unreceived remainder. */
  @Post(":id/close")
  close(@Param("id") id: string, @Req() req: any) {
    return this.service.close(id, req.user.id);
  }

  @Post(":id/cancel")
  cancel(@Param("id") id: string, @Req() req: any) {
    return this.service.cancel(id, req.user.id);
  }

  /** Ask the matcher which POs a scanned invoice might belong to. */
  @Post("match")
  match(@Body() dto: MatchScanToPoDto) {
    return this.matcher.match({
      candidateReferences: dto.candidateReferences ?? [],
      supplierId: dto.supplierId,
      supplierNameRaw: dto.supplierName,
      invoiceTotal: dto.invoiceTotal,
    });
  }

  /** Link an existing unlinked bill to a PO, running the variance check. */
  @Post(":id/link-bill/:billId")
  linkBill(@Param("id") id: string, @Param("billId") billId: string) {
    return this.service.linkBillToPo(billId, id);
  }

  /** Open PO lines with something still to bill — feeds the manual matching screen. */
  @Get("open-lines")
  openLines(@Query("supplierId") supplierId?: string) {
    return this.service.openBillableLines(supplierId);
  }
}
```

```ts
// apps/api/src/purchase-orders/dto/create-purchase-order.dto.ts
import { Type } from "class-transformer";
import {
  ArrayMinSize, IsArray, IsDateString, IsInt, IsNumber, IsOptional,
  IsString, IsUUID, Min, ValidateNested,
} from "class-validator";

export class CreatePurchaseOrderItemDto {
  @IsUUID()
  productId!: string;

  /** PIECES. If the buyer types cases, the client multiplies by packSize before sending. */
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  qtyOrdered!: number;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  unitCost!: number;

  @IsOptional() @IsInt() @Min(1)
  packSize?: number;

  @IsOptional() @IsString()
  description?: string;
}

export class CreatePurchaseOrderDto {
  @IsUUID()
  supplierId!: string;

  @IsOptional() @IsDateString()
  expectedDate?: string;

  @IsOptional() @IsString()
  notes?: string;

  /** The supplier's own reference — matching needs this as much as our PO number. */
  @IsOptional() @IsString()
  supplierReference?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseOrderItemDto)
  items!: CreatePurchaseOrderItemDto[];
}
```

```ts
// apps/api/src/purchase-orders/dto/receive-purchase-order.dto.ts
import { Type } from "class-transformer";
import {
  ArrayMinSize, IsArray, IsBoolean, IsNumber, IsOptional, IsString, IsUUID, Min, ValidateNested,
} from "class-validator";

export class ReceiveLineDto {
  @IsUUID()
  poItemId!: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  qtyReceived!: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0)
  unitCost?: number;
}

export class ReceivePurchaseOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiveLineDto)
  lines!: ReceiveLineDto[];

  @IsOptional() @IsString()
  notes?: string;

  /** Explicit acknowledgement of an over-receipt beyond tolerance. */
  @IsOptional() @IsBoolean()
  allowOverReceipt?: boolean;
}
```

### Fixing PO creation (money + numbering)

```ts
// apps/api/src/purchase-orders/purchase-orders.service.ts (excerpt)
/**
 * Replaces InventoryService.createPurchaseOrder, which computed totals in raw floats
 * and minted numbers with a racy findFirst-max.
 */
async create(dto: CreatePurchaseOrderDto, createdById: string) {
  return this.prisma.tenantTransaction(async (tx) => {
    const supplier = await tx.supplier.findUnique({ where: { id: dto.supplierId } });
    if (!supplier) throw new NotFoundException("Supplier not found");

    // Sequenced, not raced. DocumentNumberType.PURCHASE_ORDER is new.
    const poNumber = await this.numbering.reserveNext(DocumentNumberType.PURCHASE_ORDER, { tx });

    let totalAmount = 0;
    const lines = dto.items.map((item) => {
      // roundMoney on every monetary write — the old raw-float path was a money-discipline
      // violation, not a style preference.
      const totalCost = roundMoney(item.qtyOrdered * item.unitCost);
      totalAmount = roundMoney(totalAmount + totalCost);
      return { ...item, totalCost };
    });

    const po = await tx.purchaseOrder.create({
      data: {
        poNumber,
        supplierId: dto.supplierId,
        supplierReference: dto.supplierReference,
        expectedDate: dto.expectedDate ? new Date(dto.expectedDate) : null,
        notes: dto.notes,
        createdById,
        status: "DRAFT",
        totalAmount: new Prisma.Decimal(totalAmount),
        items: {
          create: lines.map((l) => ({
            productId: l.productId,
            qtyOrdered: new Prisma.Decimal(l.qtyOrdered),
            unitCost: new Prisma.Decimal(l.unitCost),
            totalCost: new Prisma.Decimal(l.totalCost),
            packSize: l.packSize,
            description: l.description,
          })),
        },
      },
      include: { items: true, supplier: true },
    });

    return po;
  });
}
```

---

## 9. Under-receipt: no backorder split in v1

Odoo splits the unreceived remainder into a linked backorder document. ERPNext leaves the PO open
and lets the percentage carry the shortfall, with a manual Close to write off the rest.

**We take ERPNext's model.** The backorder split is operationally friendlier but it is a second
document type with its own lifecycle, and the percentage model already tells the buyer exactly what
is outstanding. A short delivery leaves the PO `PARTIAL`; the next delivery is simply a second
`GoodsReceipt`; if the remainder is never coming, the buyer closes the PO (or the individual line)
and it drops out of the denominator.

This is a deliberate divergence from the backorder invariant used elsewhere in RouteFlow's design
notes — recorded here so the next reader does not think it was an oversight. Revisit it if buyers
start asking "what is still owed to me across all suppliers", which is the question a backorder
document answers well and a percentage answers badly.

---

## 10. Rollout

The risk is not the new code — it is the two existing stock paths and the live mobile app.

| Phase | What ships | Guard |
|---|---|---|
| **0** | Migration: all new columns nullable / defaulted. No behaviour change. | Deploy alone. `npm run local:drift` clean. |
| **1** | New `purchase-orders` module, `GoodsReceipt`, B285-safe stock writer, rollups. Old `/inventory/purchase-orders/*` routes forward to it. `POST /inventory/purchase-orders/:id/receive` maps onto `GoodsReceiptService.receive`. | Behind `flag.ap_bills`. Old routes keep working, so mobile is unaffected. |
| **2** | `purchaseOrderId` on bills actually persists. `createBillFromPo`. Variance detection + payment block. | `requirePoForBills` defaults **false** — no existing tenant's flow changes. |
| **3** | Scanner extracts `candidatePoReferences`; matcher runs; review UI offers matches. | Gated by the existing `ocr` addon (`dark`). |
| **4** | Per-tenant opt-in to `requirePoForBills`. Deprecated `/inventory/purchase-orders/*` removed once mobile ships the new path. | Per tenant, never global. |

**Migration must backfill the derived columns**, or every existing PO reads 0% until it is next
touched:

```sql
-- After adding the columns, seed the roll-ups from existing data.
-- Existing POs have no GoodsReceipt rows, so receivedPct derives from the legacy
-- PurchaseOrderItem.qtyReceived that the old receive path maintained.
UPDATE "PurchaseOrder" po
SET "receivedPct" = COALESCE(sub.pct, 0)
FROM (
  SELECT "poId",
         ROUND(
           SUM(LEAST("qtyReceived", "qtyOrdered")) * 100.0
           / NULLIF(SUM("qtyOrdered"), 0), 2
         ) AS pct
  FROM "PurchaseOrderItem"
  GROUP BY "poId"
) sub
WHERE po.id = sub."poId";
```

Legacy `qtyReceived` values are **kept, not recomputed** — there are no `GoodsReceipt` rows behind
them, so a full re-sum would zero them and silently reopen closed POs. Post-migration, every new
receipt writes a `GoodsReceipt` and the re-sum becomes authoritative. Guard the transition:
`recomputePoRollups` must not zero a line whose `qtyReceived > 0` when the PO has no receipts at
all — add that check before deploying phase 1.

---

## 11. Web UI (Next.js)

Four surfaces under `apps/web/app/(dashboard)/purchase-orders/`. Server components fetch; client
components handle interaction, matching the existing dashboard pattern (Radix + Tailwind, TanStack
Query, react-hook-form + zod).

```
purchase-orders/
  page.tsx                    list: status chips, receivedPct/billedPct bars, supplier filter
  new/page.tsx                create: supplier → products → qty/cost, live total via roundMoney
  [id]/page.tsx               detail: lines with ordered/received/billed, receipts, bills
  [id]/receive/page.tsx       receive: defaults to remaining, over-receipt confirm
  match/page.tsx              two-pane manual matcher: unlinked bill lines ↔ open PO lines
```

The one genuinely new interaction is the match confirmation on the scan-review screen:

```tsx
// apps/web/components/purchase-orders/PoMatchBanner.tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/format";
import type { PoMatchCandidate } from "@/lib/api/purchase-orders";

/**
 * Shown on the scan-review screen when the matcher found candidate POs.
 * A HIGH-confidence match is pre-selected but NEVER auto-applied — an auto-linked
 * wrong PO silently corrupts two documents.
 */
export function PoMatchBanner({
  candidates,
  onLink,
  onSkip,
}: {
  candidates: PoMatchCandidate[];
  onLink: (poId: string) => Promise<void>;
  onSkip: () => void;
}) {
  const best = candidates[0];
  const [selected, setSelected] = useState(
    best?.confidence === "HIGH" ? best.poId : null,
  );
  const [linking, setLinking] = useState(false);

  if (candidates.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          {candidates.length === 1
            ? "This invoice looks like it belongs to a purchase order"
            : `${candidates.length} purchase orders could match this invoice`}
        </h3>
        <Button variant="ghost" size="sm" onClick={onSkip}>
          No purchase order
        </Button>
      </div>

      <ul className="space-y-2">
        {candidates.map((c) => (
          <li key={c.poId}>
            <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 hover:bg-white/60 dark:hover:bg-black/20">
              <input
                type="radio"
                name="po-match"
                className="mt-1"
                checked={selected === c.poId}
                onChange={() => setSelected(c.poId)}
              />
              <span className="flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-medium">{c.poNumber}</span>
                  <Badge variant={c.confidence === "HIGH" ? "default" : "outline"}>
                    {c.confidence === "HIGH" ? "Confident" : "Needs a check"}
                  </Badge>
                </span>
                <span className="mt-1 block text-sm text-muted-foreground">{c.reason}</span>
                <span className="mt-1 block text-sm">
                  Outstanding on this PO: {formatMoney(c.remainingToBill)}
                  {c.totalDelta !== null && c.totalDelta !== 0 && (
                    <span className="ml-2 text-amber-700 dark:text-amber-400">
                      ({c.totalDelta > 0 ? "+" : ""}
                      {formatMoney(c.totalDelta)} vs this invoice)
                    </span>
                  )}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      <div className="mt-3 flex justify-end">
        <Button
          disabled={!selected || linking}
          onClick={async () => {
            if (!selected) return;
            setLinking(true);
            try {
              await onLink(selected);
            } finally {
              setLinking(false);
            }
          }}
        >
          {linking ? "Linking…" : "Link to purchase order"}
        </Button>
      </div>
    </div>
  );
}
```

```ts
// apps/web/lib/api/purchase-orders.ts
import { apiClient } from "./client";

export interface PoMatchCandidate {
  poId: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  strategy: "PO_NUMBER" | "SUPPLIER_REFERENCE" | "SUPPLIER_TOTAL" | "NONE";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  remainingToBill: number;
  totalDelta: number | null;
  reason: string;
}

export const purchaseOrdersApi = {
  list: (params?: { status?: string; supplierId?: string; page?: number; limit?: number }) =>
    apiClient.get("/purchase-orders", { params }),

  get: (id: string) => apiClient.get(`/purchase-orders/${id}`),

  create: (body: unknown) => apiClient.post("/purchase-orders", body),

  send: (id: string) => apiClient.post(`/purchase-orders/${id}/send`),

  receive: (
    id: string,
    body: {
      lines: Array<{ poItemId: string; qtyReceived: number; unitCost?: number }>;
      notes?: string;
      allowOverReceipt?: boolean;
    },
  ) => apiClient.post(`/purchase-orders/${id}/receipts`, body),

  createBill: (id: string) => apiClient.post(`/purchase-orders/${id}/bills`),

  close: (id: string) => apiClient.post(`/purchase-orders/${id}/close`),

  match: (body: {
    candidateReferences?: string[];
    supplierId?: string;
    supplierName?: string;
    invoiceTotal?: number;
  }) => apiClient.post<PoMatchCandidate[]>("/purchase-orders/match", body),

  linkBill: (poId: string, billId: string) =>
    apiClient.post(`/purchase-orders/${poId}/link-bill/${billId}`),

  openLines: (supplierId?: string) =>
    apiClient.get("/purchase-orders/open-lines", { params: { supplierId } }),
};
```

---

## 12. Test criteria

`purchasing.md` already lists four for AP-A1. They stand, and these extend them. Follow the house
convention: DB-backed specs are `*.db.spec.ts` and run in the `local:test:db` lane.

**The double-count guard (the single most important test):**

- [ ] `Jest (api)` STOCK INVARIANT: receive 60 pieces via a `GoodsReceipt`, then post a bill raised
      from that PO for the same 60 — `Product.currentStock` rises by exactly **60**, and exactly
      **one** `PURCHASE` movement exists. `Jest`
- [ ] `Jest (api)`: a bill with **no** `purchaseOrderId` still moves stock through the legacy path
      (`AP-M3` must not regress). `Jest`

**B285:**

- [ ] `Jest (api)` CONCURRENCY: two simultaneous receipts of +10 against the same product leave
      `currentStock` exactly +20. Must fail on the current `receivePurchaseOrder`. `Jest`
- [ ] `Jest (api)`: `averageCost` after two concurrent receipts at different unit costs equals the
      value of serial application in either order. `Jest`
- [ ] `Jest (api)` WAC EDGE: sell stock to exactly 0, then receive at a new unit cost —
      `averageCost` equals the **new** cost, not a blend against a stale average. Repeat from
      negative stock. `Jest`

**Derivation:**

- [ ] `Jest (api)`: `recomputePoRollups` is idempotent — running it twice changes nothing. `Jest`
- [ ] `Jest (api)`: voiding a receipt returns `qtyReceived` and `receivedPct` to their prior values
      (self-healing re-sum, not a decrement). `Jest`
- [ ] `Jest (api)` MIN-CLAMP: over-receiving one line to 150% of ordered leaves `receivedPct` at
      exactly 100, never 150. `Jest`
- [ ] `Jest (api)`: closing a line removes it from the denominator — a PO with one fulfilled and
      one closed line reads 100%. `Jest`
- [ ] `Jest (api)`: status is never writable directly; `PATCH` attempting to set `RECEIVED` on a PO
      with `receivedPct = 0` is rejected. `Jest`

**Tolerance and blocking:**

- [ ] `Jest (api)`: with tolerance 0, receiving ordered+1 throws `OVER_RECEIPT` naming the maximum
      receivable and writes no stock. `Jest`
- [ ] `Jest (api)`: with tolerance 5%, receiving 104% succeeds and 106% throws. `Jest`
- [ ] `Jest (api)`: `allowOverReceipt: true` bypasses the tolerance and still records the true
      received quantity. `Jest`
- [ ] `Jest (api)`: a bill priced above its PO beyond tolerance persists `matchVariance`, and
      `recordPayment` then throws `BILL_HAS_MATCH_VARIANCE` and moves no money. `Jest`
- [ ] `Jest (api)`: `isBillOnHold` is false once `holdReleaseAt` has passed; payment then succeeds. `Jest`

**Matching:**

- [ ] `Jest (api)`: "P.O. 2026-0042", "po#2026-0042" and "PO-2026-0042" all resolve to the same PO. `Jest`
- [ ] `Jest (api)`: two open POs with the same total for one supplier return **LOW** confidence for
      both and auto-link nothing. `Jest`
- [ ] `Jest (api)`: a total matching within `matchTotalTolerance` but for a **different** supplier
      returns no candidates. `Jest`
- [ ] `Jest (api)` TENANT ISOLATION: a PO number from tenant A is never a candidate in tenant B. `Jest`
- [ ] `Jest (api)`: `requirePoForBills` rejects a PO-less bill with `PO_REQUIRED`, and a supplier
      flagged `exemptFromPoRequirement` still succeeds. `Jest`

**Billing:**

- [ ] `Jest (api)` MONEY INVARIANT: a bill drafted from a PO has
      `totalOwed == roundMoney(Σ remaining × unitCost)` to the cent. `Jest`
- [ ] `Jest (api)`: `createBillFromPo` on a PO with nothing received throws `NOTHING_TO_BILL` —
      you cannot bill goods that have not arrived. `Jest`
- [ ] `Jest (api)`: two sequential partial bills against one PO sum to `billedPct` 100 and never
      exceed it. `Jest`

**UI:**

- [ ] `Playwright (web)`: a scanned invoice quoting a PO number shows the match banner with the
      correct PO pre-selected, and linking navigates to a bill with lines pre-filled. `Playwright`
- [ ] `Playwright (web)`: a PO at 50% received renders both progress bars and a Receive action
      defaulting to the outstanding quantity. `Playwright`
- [ ] `Playwright (web)` TENANT ISOLATION: a PO created in tenant A 404s in tenant B. `Playwright`

---

## 13. Summary of what this buys

| Before | After |
|---|---|
| PO exists but nothing reads it | PO is the spine of AP |
| `purchaseOrderId` silently dropped | Persisted, and the match runs off it |
| Two stock paths, mutually unaware | One receipt writes stock; PO-backed bills are financial only |
| B285: unlocked read, absolute write | Locked read, delta write |
| Ordered vs received only | Ordered vs received vs billed, with variance detection |
| Counters incremented in place | Full re-sums that self-heal on void |
| Status set by hand | Status derived from min-clamped percentages |
| Scanned invoice keyed free-standing | Scanned invoice matched to a PO by number, reference, or total |
| Nothing blocks paying a wrong bill | Variance and hold both block payment |
| Racy `findFirst`-max PO numbers | `NumberingSequence` |
| Raw-float PO totals | `roundMoney` on every monetary write |
| Drivers can raise and receive POs | `@Roles(OPERATOR)` throughout (B168) |
