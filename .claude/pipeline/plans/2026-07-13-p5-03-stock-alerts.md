# P5-03 — Stock alerts / Notify-me (api + web)

## Status

PLANNED — 2026-07-13

> **Pre-launch reconciliation (added by orchestrator):** this plan was authored while the P5-06/07
> pipeline was still writing the working tree, so some anchors reference P5-06 code (`ShelfService`
> import in `buyer.controller.ts`, `replenishmentSnooze: modelProxy()` in the prisma mock, the
> `shelf.service (P5-06/07)` code-map bullet, `StockAlertsModule` placement near shelf). Launch this
> pipeline ONLY off master AFTER P5-06/07 has merged, so those anchors exist. **Verified facts:**
> `Product.currentStock` is a real `Decimal` scalar (schema:865) that every stock-increase path
> updates INSIDE its tx (`recordPurchase`:~234, `recordAdjustment`:~284, `commitStockCount`:~392,
> `receivePurchaseOrder`:~688), so the after-commit `fireForProducts` read sees fresh stock and the
> `> 0` guard fires correctly on restock.

## Context

- **Increment:** P5-03 from `docs/design-package/PHASE-5-6-10-PLAN.md` (line 111): _"Alert on OOS product + restock fires exactly one notification and clears the entry; operator product detail shows waitlist count."_ New model `StockAlert`. Depends on P5-02 (buyer shop — SHIPPED, #249). Mobile (P10-BUY-3) is OUT OF SCOPE.
- **Architecture:**
  - New additive model `StockAlert` (one row per tenant/customer/product; `status PENDING|NOTIFIED`). Mirrors `ReplenishmentSnooze` relations/back-relations exactly.
  - New `StockAlertsModule` (`apps/api/src/stock-alerts/`) exporting `StockAlertService` (Prisma + `NotificationsService.sendToCustomer` — push-only per G9). Imported by BOTH `InventoryModule` (restock fire) and `BuyerModule` (subscribe endpoints). No circular imports: `StockAlertsModule → NotificationsModule → PrismaModule(@Global)` only.
  - **Restock fire is idempotent by construction:** `fireForProducts` only ever transitions `PENDING → NOTIFIED`, so a second call from another restock path finds no PENDING rows and fires nothing ("exactly one notification and clears the entry"). It is called AFTER each inventory transaction commits (never inside), wrapped in try/catch — a slow/failed push can NEVER roll back or break a stock write. Hooked into all four stock-increase paths in `InventoryService`: `recordPurchase`, `recordAdjustment` (positive only), `commitStockCount` (counted-up products), `receivePurchaseOrder`.
  - Buyer endpoints on `BuyerController` (seller-scoped via `ctx.customerId`/`ctx.tenantId`): `POST/DELETE /buyer/products/:productId/stock-alert` plus a tiny `GET /buyer/stock-alerts` (`{ productIds }` of PENDING alerts) so the web tile can render subscribed state after reload (mirrors the favorites pattern). `GET /buyer/products/:id` gains additive `alertSubscribed: boolean`.
  - Operator: `ProductsService.findOne` gains additive `stockAlertCount` (count of PENDING alerts); rendered as "N waiting for restock" in the product-detail Stock & Cost card.
- **Money discipline:** NO costing/lot/pricing math is touched. All inventory edits are strictly "collect product ids + fire after commit".
- **Verify:** `npm run verify` (typecheck + lint + Jest). Conventional Commits (suggested: `feat(api): stock alerts / notify-me engine (P5-03)`, `feat(web): buyer notify-me + operator waitlist count (P5-03)`).

## Acceptance

1. Buyer subscribes on an OOS product; a restock (purchase / positive adjustment / count-up / PO receive) fires **exactly one** push notification per pending alert (deep-link data `{ type: "STOCK_ALERT", productId }`) and flips the entry `PENDING → NOTIFIED` (sets `notifiedAt`). A second restock fires nothing.
2. No fire when on-hand is still ≤ 0 after the write. Notification failure never breaks the inventory write and still clears the entry.
3. Re-subscribe while PENDING is an idempotent upsert; unsubscribe removes the row; re-subscribe after NOTIFIED re-arms to PENDING.
4. Operator product detail shows the waitlist count ("N waiting for restock").
5. Buyer shop tile: OOS products show **Notify me** (replaces the disabled Add); subscribed state shows **Notifying ✓** and click cancels.
6. `npm run verify` green; existing suites (`inventory.service.spec`, `buyer.controller.spec`, `products.service.spec`) still compile and pass.

---

## Work Packages

### WP1 — Schema, migration, prisma-mock

files:

- `apps/api/prisma/schema.prisma` (edit)
- `apps/api/prisma/migrations/20260723000000_add_stock_alerts/migration.sql` (new)
- `apps/api/src/testing/prisma-mock.ts` (edit)

brief: Additive `StockAlert` model + `StockAlertStatus` enum + three back-relations, migration SQL (sorts AFTER `20260722000000_add_replenishment_snooze`), register `stockAlert` in the prisma mock. **After the schema edit run `npx prisma generate` (from `apps/api/`) and `git add -f apps/api/prisma/migrations/20260723000000_add_stock_alerts/migration.sql`** (repo `.gitignore` has a `*.sql` rule; migrations are negated but force-add anyway per pipeline convention).

**1. `apps/api/prisma/schema.prisma` — back-relation on `Tenant`.** Find (inside `model Tenant`):

```prisma
  replenishmentSnoozes   ReplenishmentSnooze[]
```

Replace with:

```prisma
  replenishmentSnoozes   ReplenishmentSnooze[]
  stockAlerts            StockAlert[]
```

**2. Back-relation on `Customer`.** Find (inside `model Customer`, end of the relation list):

```prisma
  replenishmentSnoozes ReplenishmentSnooze[]
```

Replace with:

```prisma
  replenishmentSnoozes ReplenishmentSnooze[]
  stockAlerts          StockAlert[]
```

**3. Back-relation on `Product`.** Find (inside `model Product`):

```prisma
  replenishmentSnoozes  ReplenishmentSnooze[]
```

Replace with:

```prisma
  replenishmentSnoozes  ReplenishmentSnooze[]
  stockAlerts           StockAlert[]
```

(Each of the three `replenishmentSnoozes` lines is unique in the file — match the exact spacing shown. If P5-06/07's merged spacing differs, match the actual file.)

**4. New model + enum.** Insert immediately AFTER the closing `}` of `model ReplenishmentSnooze`:

```prisma
// ─── Stock Alerts (P5-03 Notify-me) ───────────────────────────────────────────

/// Buyer "notify me when back in stock" subscription. One row per
/// (tenant, customer, product). A restock flips PENDING → NOTIFIED exactly once
/// (StockAlertService.fireForProducts only ever transitions PENDING rows, so
/// re-firing from multiple stock-increase paths is idempotent) and stamps
/// notifiedAt. Re-subscribing upserts the row back to PENDING.
model StockAlert {
  id         String           @id @default(uuid())
  tenantId   String?
  customerId String
  productId  String
  status     StockAlertStatus @default(PENDING)
  createdAt  DateTime         @default(now())
  notifiedAt DateTime?

  tenant   Tenant?  @relation(fields: [tenantId], references: [id])
  customer Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)
  product  Product  @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@unique([tenantId, customerId, productId])
  @@index([productId])
  @@index([tenantId])
}

enum StockAlertStatus {
  PENDING
  NOTIFIED
}
```

**5. `apps/api/prisma/migrations/20260723000000_add_stock_alerts/migration.sql` (new file, full contents):**

```sql
-- P5-03: buyer stock alerts ("Notify me" waitlist). Additive-only — one new
-- enum + table + indexes; no existing column/row changes, no backfill.
CREATE TYPE "StockAlertStatus" AS ENUM ('PENDING', 'NOTIFIED');

CREATE TABLE "StockAlert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "StockAlertStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),
    CONSTRAINT "StockAlert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockAlert_tenantId_customerId_productId_key" ON "StockAlert"("tenantId", "customerId", "productId");
CREATE INDEX "StockAlert_productId_idx" ON "StockAlert"("productId");
CREATE INDEX "StockAlert_tenantId_idx" ON "StockAlert"("tenantId");

ALTER TABLE "StockAlert" ADD CONSTRAINT "StockAlert_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockAlert" ADD CONSTRAINT "StockAlert_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockAlert" ADD CONSTRAINT "StockAlert_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

**6. `apps/api/src/testing/prisma-mock.ts`** — in `allModels()`, find:

```ts
    customerLink: modelProxy(),
    replenishmentSnooze: modelProxy(),
  });
```

Replace with:

```ts
    customerLink: modelProxy(),
    replenishmentSnooze: modelProxy(),
    stockAlert: modelProxy(),
  });
```

**7. Commands (run from repo root):**

```
cd apps/api && npx prisma generate
git add -f apps/api/prisma/migrations/20260723000000_add_stock_alerts/migration.sql
```

---

### WP2 — API: StockAlertService, restock fire-hooks, buyer endpoints, specs

files:

- `apps/api/src/stock-alerts/stock-alert.service.ts` (new)
- `apps/api/src/stock-alerts/stock-alerts.module.ts` (new)
- `apps/api/src/stock-alerts/stock-alert.service.spec.ts` (new)
- `apps/api/src/inventory/inventory.module.ts` (edit)
- `apps/api/src/inventory/inventory.service.ts` (edit)
- `apps/api/src/inventory/inventory.service.spec.ts` (edit)
- `apps/api/src/buyer/buyer.module.ts` (edit)
- `apps/api/src/buyer/buyer.controller.ts` (edit)
- `apps/api/src/buyer/buyer.controller.spec.ts` (edit)

brief: The alert engine + its module; fire hooks appended AFTER the tx commit in all four stock-increase paths (try/catch, never inside the tx, no costing math touched); seller-scoped subscribe/unsubscribe/list endpoints; Jest specs at the Prisma/Notifications boundary.

**1. `apps/api/src/stock-alerts/stock-alert.service.ts` (new file, full contents):**

```ts
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { StockAlertStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";

/**
 * Phase 5 (P5-03): buyer "Notify me when back in stock".
 *
 * One StockAlert row per (tenant, customer, product). Subscribing upserts the
 * row to PENDING (idempotent; re-subscribing after a NOTIFIED restock re-arms
 * it). Restocks call {@link fireForProducts} AFTER the inventory transaction
 * commits: for each product with on-hand > 0, every PENDING alert gets exactly
 * one push (NotificationsService.sendToCustomer — push-only per G9) and is
 * flipped PENDING → NOTIFIED. Because only PENDING rows ever fire, calling
 * this from multiple restock paths is idempotent — a second call finds no
 * PENDING rows and fires nothing.
 *
 * Tenant scoping rides forTenant() on every read/write (callers run inside a
 * tenant ALS context). No costing/lot/pricing math lives here.
 */
@Injectable()
export class StockAlertService {
  private readonly logger = new Logger(StockAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Subscribe (idempotent upsert on the unique key). Only meaningful when the
   * product is OOS, but an in-stock subscribe is NOT hard-blocked — the row is
   * simply kept and fires on the next restock-from-zero.
   */
  async subscribe(
    customerId: string,
    productId: string,
    tenantId: string,
  ): Promise<{ subscribed: true }> {
    const product = await this.prisma.forTenant().product.findFirst({
      where: { id: productId, isActive: true },
      select: { id: true },
    });
    if (!product) throw new NotFoundException("Product not found");

    await this.prisma.forTenant().stockAlert.upsert({
      where: { tenantId_customerId_productId: { tenantId, customerId, productId } },
      create: { tenantId, customerId, productId, status: StockAlertStatus.PENDING },
      // Re-subscribing after a NOTIFIED restock re-arms the alert.
      update: { status: StockAlertStatus.PENDING, notifiedAt: null },
    });
    return { subscribed: true };
  }

  /** Unsubscribe (deleteMany → no-op safe when none exists). */
  async unsubscribe(customerId: string, productId: string): Promise<{ subscribed: false }> {
    await this.prisma.forTenant().stockAlert.deleteMany({
      where: { customerId, productId },
    });
    return { subscribed: false };
  }

  /** Product ids this buyer has a PENDING alert on (tile subscribed-state). */
  async subscriptionsFor(customerId: string): Promise<{ productIds: string[] }> {
    const rows = await this.prisma.forTenant().stockAlert.findMany({
      where: { customerId, status: StockAlertStatus.PENDING },
      select: { productId: true },
    });
    return { productIds: rows.map((r) => r.productId) };
  }

  /** Whether this buyer has a PENDING alert on the product (detail DTO flag). */
  async isSubscribed(customerId: string, productId: string): Promise<boolean> {
    const row = await this.prisma.forTenant().stockAlert.findFirst({
      where: { customerId, productId, status: StockAlertStatus.PENDING },
      select: { id: true },
    });
    return row != null;
  }

  /**
   * Restock fire. For each (deduped) product: if current on-hand > 0, send
   * exactly one push per PENDING alert, then flip it PENDING → NOTIFIED.
   * A push failure is swallowed per-alert and the entry is STILL cleared
   * ("fires exactly one notification and clears the entry" — a broken push
   * channel must not turn into an infinite re-fire loop).
   */
  async fireForProducts(productIds: string[]): Promise<{ notified: number }> {
    const unique = [...new Set(productIds)];
    if (unique.length === 0) return { notified: 0 };

    let notified = 0;
    for (const productId of unique) {
      const product = await this.prisma.forTenant().product.findUnique({
        where: { id: productId },
        select: { id: true, name: true, currentStock: true },
      });
      // In-stock guard: never fire while on-hand is still 0 or negative.
      if (!product || Number(product.currentStock) <= 0) continue;

      const pending = await this.prisma.forTenant().stockAlert.findMany({
        where: { productId, status: StockAlertStatus.PENDING },
      });

      for (const alert of pending) {
        try {
          await this.notifications.sendToCustomer(
            alert.customerId,
            "Back in stock",
            `${product.name} is back in stock — order now before it sells out.`,
            { type: "STOCK_ALERT", productId: product.id },
          );
        } catch {
          this.logger.warn(`Stock-alert push failed for alert ${alert.id} (entry still cleared)`);
        }
        await this.prisma.forTenant().stockAlert.update({
          where: { id: alert.id },
          data: { status: StockAlertStatus.NOTIFIED, notifiedAt: new Date() },
        });
        notified += 1;
      }
    }
    return { notified };
  }
}
```

> **Implementer note:** verify `NotificationsService.sendToCustomer`'s real signature before wiring
> (read `apps/api/src/notifications/notifications.service.ts` ~line 140). If it takes a single
> payload object rather than `(customerId, title, body, data)`, adapt BOTH the call here and the spec
> assertions in WP2.6 to the real signature — keep "exactly one call per PENDING alert" invariant.

**2. `apps/api/src/stock-alerts/stock-alerts.module.ts` (new file, full contents):**

```ts
import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { StockAlertService } from "./stock-alert.service";

/**
 * P5-03 stock alerts. Standalone module so BOTH InventoryModule (restock fire)
 * and BuyerModule (subscribe/unsubscribe endpoints) can import it without a
 * circular dependency. PrismaModule is @Global.
 */
@Module({
  imports: [NotificationsModule],
  providers: [StockAlertService],
  exports: [StockAlertService],
})
export class StockAlertsModule {}
```

**3. `apps/api/src/inventory/inventory.module.ts` — replace the whole file with:**

```ts
import { Module } from "@nestjs/common";
import { StockAlertsModule } from "../stock-alerts/stock-alerts.module";
import { InventoryService } from "./inventory.service";
import { InventoryController } from "./inventory.controller";

@Module({
  imports: [StockAlertsModule],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
```

> **Implementer note:** if the real `inventory.module.ts` imports/providers differ from the above
> (e.g. extra imports), do NOT blindly overwrite — ADD `StockAlertsModule` to its `imports` array
> and keep everything else.

**4. `apps/api/src/inventory/inventory.service.ts` — anchored edits. Touch NOTHING else (no costing/lot/money math changes).**

**(a) Imports + constructor.** Find:

```ts
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
```

Replace with:

```ts
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
```

Then add the import and the `StockAlertService` constructor dependency + the private `fireStockAlerts` helper:

```ts
import { StockAlertService } from "../stock-alerts/stock-alert.service";
```

```ts
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stockAlerts: StockAlertService,
  ) {}

  /**
   * P5-03: fire Notify-me stock alerts for products whose stock just
   * increased. Always called AFTER the inventory transaction has committed
   * (never inside it) and NEVER throws — a slow or failed push must not roll
   * back or break the stock write. Idempotent across paths: the service only
   * transitions PENDING → NOTIFIED, so a second call fires nothing.
   */
  private async fireStockAlerts(productIds: string[]): Promise<void> {
    if (productIds.length === 0) return;
    try {
      await this.stockAlerts.fireForProducts(productIds);
    } catch (err) {
      this.logger.warn(`Stock-alert fire failed (non-fatal): ${(err as Error).message}`);
    }
  }
```

**(b) `recordPurchase`** — capture the `tenantTransaction(...)` result into `const result = await ...`, then AFTER the tx returns, call `await this.fireStockAlerts([dto.productId]); return result;` (replacing the old `return this.prisma.tenantTransaction(...)` / trailing `});`).

**(c) `recordAdjustment`** — same pattern; fire ONLY on an increase: `if (qty.gt(0)) await this.fireStockAlerts([dto.productId]); return result;` (use whatever the method's signed-qty Decimal variable is named).

**(d) `commitStockCount`** — declare `const restockedProductIds: string[] = [];` before the tx; inside the items loop, in the `if (delta.gt(0)) { ... }` branch that creates the count-up lot, push `restockedProductIds.push(item.productId);`; capture the tx result, then `await this.fireStockAlerts(restockedProductIds); return result;`.

**(e) `receivePurchaseOrder`** — declare `const restockedProductIds: string[] = [];` before the tx; where an item is actually received (after `if (actualQty <= 0) continue;`), push `restockedProductIds.push(item.productId);`; capture the tx result, then `await this.fireStockAlerts(restockedProductIds); return result;`.

> The full before/after blocks for each of (b)-(e) are in the design notes; the invariant is:
> **collect ids → run the existing tx unchanged → fire after commit.** Do not move any existing
> statement into/out of the tx; only wrap the return and append the fire call.

**5. `apps/api/src/inventory/inventory.service.spec.ts` — provide the new dependency + hook tests.**

Add the import:

```ts
import { StockAlertService } from "../stock-alerts/stock-alert.service";
```

In `beforeEach`, add a mock and provider:

```ts
stockAlerts = { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) };
```

```ts
const module: TestingModule = await Test.createTestingModule({
  providers: [
    InventoryService,
    { provide: PrismaService, useValue: prisma },
    { provide: StockAlertService, useValue: stockAlerts },
  ],
}).compile();
```

(declare `let stockAlerts: { fireForProducts: jest.Mock };` with the other lets).

Add tests: `recordPurchase` fires `["prod-1"]` after the tx; a rejected `fireForProducts` still resolves the inventory write; `recordAdjustment` fires on positive qty and NOT on negative. Mirror the existing `recordPurchase`/`recordAdjustment` describe blocks' mock setup (`prisma.product.findUnique.mockResolvedValue(product())`, `prisma.stockMovement.count.mockResolvedValue(0)`).

**6. `apps/api/src/stock-alerts/stock-alert.service.spec.ts` (new file, full contents):**

```ts
import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { StockAlertService } from "./stock-alert.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("StockAlertService (P5-03)", () => {
  let service: StockAlertService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let notifications: { sendToCustomer: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    notifications = { sendToCustomer: jest.fn().mockResolvedValue(undefined) };

    const mod = await Test.createTestingModule({
      providers: [
        StockAlertService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = mod.get(StockAlertService);
  });

  it("subscribe: idempotent upsert to PENDING on (tenant, customer, product)", async () => {
    prisma.product.findFirst.mockResolvedValue({ id: "p1" });

    const first = await service.subscribe("cust-1", "p1", "tenant-1");
    const second = await service.subscribe("cust-1", "p1", "tenant-1");

    expect(first).toEqual({ subscribed: true });
    expect(second).toEqual({ subscribed: true });
    expect(prisma.stockAlert.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.stockAlert.upsert).toHaveBeenCalledWith({
      where: {
        tenantId_customerId_productId: {
          tenantId: "tenant-1",
          customerId: "cust-1",
          productId: "p1",
        },
      },
      create: { tenantId: "tenant-1", customerId: "cust-1", productId: "p1", status: "PENDING" },
      update: { status: "PENDING", notifiedAt: null },
    });
  });

  it("subscribe: 404 when the product is missing or inactive", async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    await expect(service.subscribe("cust-1", "nope", "tenant-1")).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.stockAlert.upsert).not.toHaveBeenCalled();
  });

  it("unsubscribe: deleteMany by customer+product (no-op safe)", async () => {
    await expect(service.unsubscribe("cust-1", "p1")).resolves.toEqual({ subscribed: false });
    expect(prisma.stockAlert.deleteMany).toHaveBeenCalledWith({
      where: { customerId: "cust-1", productId: "p1" },
    });
  });

  it("subscriptionsFor: only PENDING product ids", async () => {
    prisma.stockAlert.findMany.mockResolvedValue([{ productId: "p1" }, { productId: "p2" }]);
    await expect(service.subscriptionsFor("cust-1")).resolves.toEqual({
      productIds: ["p1", "p2"],
    });
    expect(prisma.stockAlert.findMany).toHaveBeenCalledWith({
      where: { customerId: "cust-1", status: "PENDING" },
      select: { productId: true },
    });
  });

  it("fire: exactly one notification per PENDING alert, each flipped to NOTIFIED", async () => {
    prisma.product.findUnique.mockResolvedValue({ id: "p1", name: "Cola 24pk", currentStock: 12 });
    prisma.stockAlert.findMany.mockResolvedValue([
      { id: "a1", customerId: "c1", productId: "p1", status: "PENDING" },
      { id: "a2", customerId: "c2", productId: "p1", status: "PENDING" },
    ]);

    const res = await service.fireForProducts(["p1", "p1"]);

    expect(res).toEqual({ notified: 2 });
    expect(prisma.product.findUnique).toHaveBeenCalledTimes(1);
    expect(notifications.sendToCustomer).toHaveBeenCalledTimes(2);
    expect(notifications.sendToCustomer).toHaveBeenCalledWith(
      "c1",
      "Back in stock",
      expect.stringContaining("Cola 24pk"),
      { type: "STOCK_ALERT", productId: "p1" },
    );
    expect(prisma.stockAlert.update).toHaveBeenCalledTimes(2);
    expect(prisma.stockAlert.update.mock.calls[0][0]).toMatchObject({
      where: { id: "a1" },
      data: { status: "NOTIFIED", notifiedAt: expect.any(Date) },
    });
  });

  it("fire: second fire is a no-op (no PENDING rows remain)", async () => {
    prisma.product.findUnique.mockResolvedValue({ id: "p1", name: "Cola 24pk", currentStock: 12 });
    prisma.stockAlert.findMany.mockResolvedValue([]);

    const res = await service.fireForProducts(["p1"]);

    expect(res).toEqual({ notified: 0 });
    expect(notifications.sendToCustomer).not.toHaveBeenCalled();
    expect(prisma.stockAlert.update).not.toHaveBeenCalled();
  });

  it("fire: in-stock guard — no fire while on-hand <= 0", async () => {
    prisma.product.findUnique.mockResolvedValue({ id: "p1", name: "Cola 24pk", currentStock: 0 });

    const res = await service.fireForProducts(["p1"]);

    expect(res).toEqual({ notified: 0 });
    expect(prisma.stockAlert.findMany).not.toHaveBeenCalled();
    expect(notifications.sendToCustomer).not.toHaveBeenCalled();
  });

  it("fire: a push failure is swallowed and the entry is STILL cleared", async () => {
    prisma.product.findUnique.mockResolvedValue({ id: "p1", name: "Cola 24pk", currentStock: 3 });
    prisma.stockAlert.findMany.mockResolvedValue([
      { id: "a1", customerId: "c1", productId: "p1", status: "PENDING" },
    ]);
    notifications.sendToCustomer.mockRejectedValue(new Error("expo down"));

    await expect(service.fireForProducts(["p1"])).resolves.toEqual({ notified: 1 });
    expect(prisma.stockAlert.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { status: "NOTIFIED", notifiedAt: expect.any(Date) },
    });
  });
});
```

**7. `apps/api/src/buyer/buyer.module.ts`** — import `StockAlertsModule` and add it to the `imports:` array (anchor near the existing `AuthorizationsModule` import + array entry).

**8. `apps/api/src/buyer/buyer.controller.ts`** — four edits:

- import `StockAlertService` (anchor near the `ShelfService` import that P5-06 added);
- add `private readonly stockAlertService: StockAlertService,` to the constructor (near `shelfService`);
- make `getProduct` async and append the additive `alertSubscribed` flag:

```ts
  async getProduct(@Param("id") id: string, @CurrentBuyerCustomer() ctx: any) {
    const detail = await this.catalogService.getProductDetail(id, ctx.customerId);
    const alertSubscribed = await this.stockAlertService.isSubscribed(ctx.customerId, id);
    return { ...detail, alertSubscribed };
  }
```

- add three endpoints after the Favorites section:

```ts
  // ─── Stock alerts / Notify-me (P5-03) ────────────────────────────────────────

  @Get("stock-alerts")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Product ids the buyer has a PENDING restock alert on" })
  getStockAlerts(@CurrentBuyerCustomer() ctx: any) {
    return this.stockAlertService.subscriptionsFor(ctx.customerId);
  }

  @Post("products/:productId/stock-alert")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Subscribe to a restock alert (idempotent upsert)" })
  subscribeStockAlert(@Param("productId") productId: string, @CurrentBuyerCustomer() ctx: any) {
    return this.stockAlertService.subscribe(ctx.customerId, productId, ctx.tenantId);
  }

  @Delete("products/:productId/stock-alert")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Cancel a restock alert" })
  unsubscribeStockAlert(@Param("productId") productId: string, @CurrentBuyerCustomer() ctx: any) {
    return this.stockAlertService.unsubscribe(ctx.customerId, productId);
  }
```

> Verify `ctx` exposes `tenantId` (the buyer seller-context guard). If the tenant id is named
> differently on `ctx`, use the real property. The `MOCK_CTX` in the spec must carry the same shape.

**9. `apps/api/src/buyer/buyer.controller.spec.ts`** — add the `StockAlertService` import, a mock with `subscribe`/`unsubscribe`/`subscriptionsFor`/`isSubscribed` jest.fns, register it as a provider, and add delegation tests:

```ts
it("subscribeStockAlert: delegates with context customerId + tenantId", () => {
  controller.subscribeStockAlert("prod-9", MOCK_CTX as any);
  expect(stockAlertService.subscribe).toHaveBeenCalledWith("cust-abc", "prod-9", "tenant-xyz");
});

it("unsubscribeStockAlert: delegates with context customerId", () => {
  controller.unsubscribeStockAlert("prod-9", MOCK_CTX as any);
  expect(stockAlertService.unsubscribe).toHaveBeenCalledWith("cust-abc", "prod-9");
});
```

(Match `MOCK_CTX`'s actual `customerId`/`tenantId` values — adjust the expected args to whatever the spec's MOCK_CTX defines.)

---

### WP3 — API: operator waitlist count on product detail

files:

- `apps/api/src/products/products.service.ts` (edit)

brief: `findOne` gains an additive `stockAlertCount` (count of PENDING StockAlerts) via a separate tenant-scoped count — no `_count` include gymnastics, and `products.service.spec` keeps passing (mock `stockAlert.count` defaults to 0; the existing `toMatchObject(MOCK_PRODUCT)` assertion ignores extra fields).

Import `StockAlertStatus` from `@prisma/client`, and in `findOne` after the not-found guard:

```ts
const stockAlertCount = await this.prisma.forTenant().stockAlert.count({
  where: { productId: id, status: StockAlertStatus.PENDING },
});
```

then include `stockAlertCount` in the returned object (alongside `imageUrls`). `BuyerCatalogService.getProductDetail` maps fields explicitly, so `stockAlertCount` never leaks to buyers.

---

### WP4 — Web (buyer): Notify-me on the shop tile + hooks

files:

- `apps/web/lib/api/buyer.ts` (edit)
- `apps/web/app/buyer/portal/[seller]/shop/_components/ProductTile.tsx` (edit)
- `apps/web/app/buyer/portal/[seller]/shop/page.tsx` (edit)

brief: `useBuyerStockAlerts`/`useSubscribeStockAlert`/`useUnsubscribeStockAlert` hooks (invalidate buyer products/product/stock-alerts queries); OOS tiles swap the disabled Add button for a Notify-me toggle. Money/pricing untouched (`deriveTilePrice`/`tile-pricing.ts` NOT modified).

- `BuyerProductDetail` gains `alertSubscribed?: boolean`.
- Add the three hooks (mirror the favorites hooks' style; `useBuyerStockAlerts` → `GET /buyer/stock-alerts` with `staleTime`; subscribe/unsubscribe `POST|DELETE /buyer/products/:id/stock-alert`, invalidating `["buyer","stock-alerts"]`, `["buyer","products"]`, `["buyer","product",productId]`).
- `ProductTile`: import `Bell` from lucide-react; add optional props `isAlertSubscribed?: boolean` + `onToggleStockAlert?: () => void`; when `outOfStock` (and no cartItem) render a Notify-me toggle instead of the disabled Add button — subscribed → outlined "Notifying ✓" (Bell filled), else solid "Notify me". In-stock unchanged (solid Add).
- `shop/page.tsx`: import + call `useBuyerStockAlerts`/`useSubscribeStockAlert`/`useUnsubscribeStockAlert`; build `alertIds = new Set(stockAlerts?.productIds ?? [])`; a `toggleStockAlert(productId)` that subscribes/unsubscribes; pass `isAlertSubscribed={alertIds.has(p.id)}` + `onToggleStockAlert={() => toggleStockAlert(p.id)}` to the grid-view `ProductTile`. (List view untouched — the affordance lives on the tile.)

Full exact JSX for the tile button and the page wiring is in the design notes; keep money/pricing code paths untouched.

---

### WP5 — Web (operator): waitlist count on product detail

files:

- `apps/web/lib/api/products.ts` (edit)
- `apps/web/app/(dashboard)/products/[id]/page.tsx` (edit)

brief: Type the new `stockAlertCount?: number` field on `ApiProduct`; render a "Waitlist — N waiting for restock" row in the Stock & Cost card immediately after the "On hand" row (warning color when > 0, muted otherwise, off `product.stockAlertCount ?? 0`).

---

### WP6 — Code-map update

files:

- `.claude/code-map/api.md` (edit)
- `.claude/code-map/web.md` (edit)
- `.claude/code-map/_meta.json` (edit — bump mappedSha/generatedAt per the file's convention)

brief: Extend the buyer-controller bullet with the stock-alert endpoints + `alertSubscribed`; add a `stock-alerts/ StockAlertService (P5-03)` bullet (new `StockAlert` model, `fireForProducts` idempotence, the four InventoryService fire-hooks after-commit/try-catch, operator `stockAlertCount`); add a web bullet for the ProductTile Notify-me toggle + hooks + operator Waitlist row.

---

### Implementer checklist (order matters)

1. WP1 (schema → `npx prisma generate` from `apps/api/` → `git add -f` the migration) — nothing compiles against `stockAlert`/`StockAlertStatus` until generate runs.
2. WP2, WP3 (api). 3. WP4, WP5 (web). 4. WP6 (code-map).
3. `npm run verify` from the repo root must pass.
4. Do NOT touch: `costing.ts`, `recordSale`, lot-consumption/average-cost math, `deriveTilePrice`/`tile-pricing.ts`, any `Decimal` money field.

### Critical Files for Implementation

- apps/api/prisma/schema.prisma
- apps/api/src/inventory/inventory.service.ts
- apps/api/src/stock-alerts/stock-alert.service.ts (new)
- apps/api/src/buyer/buyer.controller.ts
- apps/web/app/buyer/portal/[seller]/shop/\_components/ProductTile.tsx
