/**
 * LANE-U step 6 — DB-lane proof for `InventoryService.updatePurchaseOrder` re-apply:
 * receive → edit qty + cost → re-apply must leave stock and `averageCost` equal to a FRESH
 * receive of the edited lines, with the movement/lot ledger showing exactly the edited receipt.
 * The state table and operation order are locked without a database in
 * `inventory.po-edit.spec.ts`; only a real Postgres can prove the reversal arithmetic, the
 * `FOR UPDATE` lock statement and the nested item writes.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host. Drives the REAL service through a
 * REAL `PrismaService` + `TenantContextService` (pattern: invoice-delete-credit.db.spec.ts).
 *
 * SAFETY: every tenant is a throwaway `qa-po-edit-<run>-<n>-<label>` slug approved by
 * `assertTestTenant`; `afterAll` deletes exactly the rows this run created, in FK order.
 *
 * ROUNDING NOTE (why one case uses a tolerance): `averageCost` is Decimal(10,4). Reversing a
 * receipt whose blended average was itself rounded to 4dp restates the prior average to within
 * 1e-4, so a re-apply is exactly equal to a fresh receive only when the intermediate average is
 * representable in 4dp (cases 1–3 use such numbers) and within 1e-4 otherwise (case 4).
 *
 * NOT EXECUTED by the authoring session (no Postgres it owns) — posted to the board as NEED-DB
 * for the F prover's shared stack.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-po-edit-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "inventory.po-edit.db.spec.ts",
  );
};

const D = (n: number | string) => new Prisma.Decimal(n);

describeDb("PO edit + re-apply — real Postgres (LANE-U step 6)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: InventoryService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
      ],
    }).compile();
    service = module.get(InventoryService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    const pos = await prisma.purchaseOrder.findMany({ where: { tenantId }, select: { id: true } });
    await prisma.purchaseOrderItem.deleteMany({ where: { poId: { in: pos.map((p) => p.id) } } });
    await prisma.purchaseOrder.deleteMany({ where: { tenantId } });
    await prisma.stockLot.deleteMany({ where: { tenantId } });
    await prisma.stockMovement.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.supplier.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  interface World {
    tenantId: string;
    userId: string;
    supplierId: string;
    productId: string;
  }

  /** A tenant with one AVCO product carrying `stock` pieces @ `avg` from before any PO. */
  async function seedWorld(label: string, stock: number, avg: number): Promise<World> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `PO edit ${slug}` } });
    createdTenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "OPERATOR",
        tenantId: tenant.id,
      },
    });
    const supplier = await prisma.supplier.create({
      data: { name: `Supplier ${slug}`, tenantId: tenant.id },
    });
    const product = await prisma.product.create({
      data: {
        name: `Widget ${slug}`,
        unit: "ea",
        pricePerUnit: 10,
        currentStock: stock,
        averageCost: avg,
        costingMethod: "AVCO",
        tenantId: tenant.id,
      },
    });
    return { tenantId: tenant.id, userId: user.id, supplierId: supplier.id, productId: product.id };
  }

  const inTenant = <T>(w: World, fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);

  /** createPO → send → receive `receiveQty` (default: all). Returns the PO with its line. */
  async function receivedPo(w: World, qty: number, cost: number, receiveQty = qty) {
    const created = await inTenant(w, () =>
      service.createPurchaseOrder(
        { supplierId: w.supplierId, items: [{ productId: w.productId, qty, unitCost: cost }] },
        w.userId,
      ),
    );
    await inTenant(w, () => service.sendPurchaseOrder(created.id));
    await inTenant(w, () =>
      service.receivePurchaseOrder(
        created.id,
        { items: [{ itemId: created.items[0].id, receivedQty: receiveQty }] },
        w.userId,
      ),
    );
    return inTenant(w, () => service.getPurchaseOrder(created.id));
  }

  const productOf = (w: World) => prisma.product.findUniqueOrThrow({ where: { id: w.productId } });

  // ── 1. edit qty + cost → re-apply == a fresh receive of the edited line ─────────────────
  it("case 1: receive 20@4, edit to 10@6, re-apply → stock and average equal a fresh 10@6 receive", async () => {
    const edited = await seedWorld("c1a", 20, 2);
    const po = await receivedPo(edited, 20, 4);
    expect(Number((await productOf(edited)).currentStock)).toBe(40);
    expect((await productOf(edited)).averageCost!.toString()).toBe("3"); // (20×2+20×4)/40

    await inTenant(edited, () =>
      service.updatePurchaseOrder(
        po.id,
        {
          reapplyInventory: true,
          items: [{ id: po.items[0].id, productId: edited.productId, qtyOrdered: 10, unitCost: 6 }],
        },
        edited.userId,
      ),
    );

    const fresh = await seedWorld("c1b", 20, 2);
    await receivedPo(fresh, 10, 6);

    const a = await productOf(edited);
    const b = await productOf(fresh);
    expect(a.currentStock.toString()).toBe(b.currentStock.toString()); // 30
    expect(a.averageCost!.toString()).toBe(b.averageCost!.toString()); // (20×2+10×6)/30 = 3.3333
  });

  // ── 2. the ledger shows exactly the edited receipt ───────────────────────────────────────
  it("case 2: after re-apply exactly ONE purchase movement and ONE lot remain, at the edited qty/cost", async () => {
    const w = await seedWorld("c2", 20, 2);
    const po = await receivedPo(w, 20, 4);
    await inTenant(w, () =>
      service.updatePurchaseOrder(
        po.id,
        {
          reapplyInventory: true,
          items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 10, unitCost: 6 }],
        },
        w.userId,
      ),
    );

    const movements = await prisma.stockMovement.findMany({
      where: { tenantId: w.tenantId, reference: po.poNumber, type: "PURCHASE" },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity.toString()).toBe("10");
    expect(movements[0].unitCost!.toString()).toBe("6");
    expect(movements[0].performedById).toBe(w.userId);

    const lots = await prisma.stockLot.findMany({
      where: { tenantId: w.tenantId, reference: po.poNumber },
    });
    expect(lots).toHaveLength(1);
    expect(lots[0].qty.toString()).toBe("10");
    expect(lots[0].remainingQty.toString()).toBe("10");
    expect(lots[0].unitCost.toString()).toBe("6");

    const after = await inTenant(w, () => service.getPurchaseOrder(po.id));
    expect(after.status).toBe("RECEIVED");
    expect(after.items[0].qtyReceived.toString()).toBe("10");
    expect(after.items[0].unitCost.toString()).toBe("6");
    expect(after.totalAmount.toString()).toBe("60");
  });

  // ── 3. a sale between receipt and edit is not lost ───────────────────────────────────────
  it("case 3: stock sold since the receipt survives the re-apply (net stock = before − old + new)", async () => {
    const w = await seedWorld("c3", 20, 2);
    const po = await receivedPo(w, 20, 4); // 40 on hand
    await prisma.product.update({ where: { id: w.productId }, data: { currentStock: 35 } }); // 5 sold
    await inTenant(w, () =>
      service.updatePurchaseOrder(
        po.id,
        {
          reapplyInventory: true,
          items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 10, unitCost: 6 }],
        },
        w.userId,
      ),
    );
    expect(Number((await productOf(w)).currentStock)).toBe(25); // 35 − 20 + 10
  });

  // ── 4. the 4dp rounding bound ────────────────────────────────────────────────────────────
  it("case 4: with a non-representable intermediate average the result is within 1e-4 of a fresh receive", async () => {
    const edited = await seedWorld("c4a", 20, 2);
    const po = await receivedPo(edited, 10, 4); // avg (40+40)/30 = 2.6667 (rounded)
    await inTenant(edited, () =>
      service.updatePurchaseOrder(
        po.id,
        {
          reapplyInventory: true,
          items: [{ id: po.items[0].id, productId: edited.productId, qtyOrdered: 8, unitCost: 5 }],
        },
        edited.userId,
      ),
    );
    const fresh = await seedWorld("c4b", 20, 2);
    await receivedPo(fresh, 8, 5);

    const a = await productOf(edited);
    const b = await productOf(fresh);
    expect(a.currentStock.toString()).toBe(b.currentStock.toString()); // exact: 28
    expect(a.averageCost!.sub(b.averageCost!).abs().lte(D("0.0001"))).toBe(true);
  });

  // ── 5. document-only leaves stock and cost alone ─────────────────────────────────────────
  it("case 5: reapplyInventory:false changes the document only — stock, average, movements untouched", async () => {
    const w = await seedWorld("c5", 20, 2);
    const po = await receivedPo(w, 20, 4);
    const before = await productOf(w);
    const movementsBefore = await prisma.stockMovement.count({ where: { tenantId: w.tenantId } });

    await inTenant(w, () =>
      service.updatePurchaseOrder(
        po.id,
        {
          reapplyInventory: false,
          items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 20, unitCost: 5 }],
        },
        w.userId,
      ),
    );

    const after = await productOf(w);
    expect(after.currentStock.toString()).toBe(before.currentStock.toString());
    expect(after.averageCost!.toString()).toBe(before.averageCost!.toString());
    expect(await prisma.stockMovement.count({ where: { tenantId: w.tenantId } })).toBe(
      movementsBefore,
    );
    const po2 = await inTenant(w, () => service.getPurchaseOrder(po.id));
    expect(po2.items[0].unitCost.toString()).toBe("5");
    expect(po2.totalAmount.toString()).toBe("100");
  });

  // ── 6. refuses when the ledger can't be reconstructed ────────────────────────────────────
  it("case 6: a PO whose movements no longer match its receipts cannot be re-applied — and nothing changes", async () => {
    const w = await seedWorld("c6", 20, 2);
    const po = await receivedPo(w, 20, 4);
    await prisma.stockMovement.deleteMany({
      where: { tenantId: w.tenantId, reference: po.poNumber },
    });
    const before = await productOf(w);

    await expect(
      inTenant(w, () =>
        service.updatePurchaseOrder(
          po.id,
          {
            reapplyInventory: true,
            items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 10, unitCost: 6 }],
          },
          w.userId,
        ),
      ),
    ).rejects.toThrow(/cannot be re-applied safely/);

    const after = await productOf(w);
    expect(after.currentStock.toString()).toBe(before.currentStock.toString());
    const po2 = await inTenant(w, () => service.getPurchaseOrder(po.id));
    expect(po2.items[0].qtyOrdered.toString()).toBe("20"); // the edit rolled back with it
  });

  // ── 7. PARTIAL keeps what was received ───────────────────────────────────────────────────
  it("case 7: a PARTIAL PO re-applied keeps its received quantity, then can still be received to completion", async () => {
    const w = await seedWorld("c7", 0, 0);
    const po = await receivedPo(w, 10, 4, 4); // ordered 10, received 4 → PARTIAL
    expect(po.status).toBe("PARTIAL");

    await inTenant(w, () =>
      service.updatePurchaseOrder(
        po.id,
        {
          reapplyInventory: true,
          items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 6, unitCost: 5 }],
        },
        w.userId,
      ),
    );
    const mid = await inTenant(w, () => service.getPurchaseOrder(po.id));
    expect(mid.status).toBe("PARTIAL");
    expect(mid.items[0].qtyReceived.toString()).toBe("4");
    expect(Number((await productOf(w)).currentStock)).toBe(4);
    expect((await productOf(w)).averageCost!.toString()).toBe("5"); // the 4 received are now valued @5

    await inTenant(w, () =>
      service.receivePurchaseOrder(
        po.id,
        { items: [{ itemId: po.items[0].id, receivedQty: 2 }] },
        w.userId,
      ),
    );
    const done = await inTenant(w, () => service.getPurchaseOrder(po.id));
    expect(done.status).toBe("RECEIVED");
    expect(Number((await productOf(w)).currentStock)).toBe(6);
  });

  // ── 8. the receipt keeps its original date ─────────────────────────────────────────────
  it("case 8: a re-apply keeps the receipt's ORIGINAL date on the movement and the lot (dated reports don't shift)", async () => {
    const w = await seedWorld("c8", 20, 2);
    const po = await receivedPo(w, 20, 4);
    const original = new Date("2026-08-20T10:00:00.000Z");
    await prisma.stockMovement.updateMany({
      where: { tenantId: w.tenantId, reference: po.poNumber },
      data: { createdAt: original },
    });
    await prisma.stockLot.updateMany({
      where: { tenantId: w.tenantId, reference: po.poNumber },
      data: { purchaseDate: original },
    });

    await inTenant(w, () =>
      service.updatePurchaseOrder(
        po.id,
        {
          reapplyInventory: true,
          items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 12, unitCost: 4 }],
        },
        w.userId,
      ),
    );

    const [movement] = await prisma.stockMovement.findMany({
      where: { tenantId: w.tenantId, reference: po.poNumber, type: "PURCHASE" },
    });
    const [lot] = await prisma.stockLot.findMany({
      where: { tenantId: w.tenantId, reference: po.poNumber },
    });
    expect(movement.quantity.toString()).toBe("12");
    expect(movement.createdAt.toISOString()).toBe(original.toISOString());
    expect(lot.purchaseDate.toISOString()).toBe(original.toISOString());
  });

  // ── 9. another product's lot that happens to share the reference is left alone ─────────
  it("case 9: a manual lot of ANOTHER product carrying this PO's reference survives the re-apply", async () => {
    const w = await seedWorld("c9", 20, 2);
    const other = await prisma.product.create({
      data: {
        name: `Other ${w.tenantId}`,
        unit: "ea",
        pricePerUnit: 5,
        currentStock: 50,
        averageCost: 2,
        costingMethod: "AVCO",
        tenantId: w.tenantId,
      },
    });
    const po = await receivedPo(w, 20, 4);
    const foreign = await prisma.stockLot.create({
      data: {
        productId: other.id,
        qty: 50,
        remainingQty: 50,
        unitCost: 2,
        reference: po.poNumber,
        tenantId: w.tenantId,
      },
    });

    await inTenant(w, () =>
      service.updatePurchaseOrder(
        po.id,
        {
          reapplyInventory: true,
          items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 10, unitCost: 6 }],
        },
        w.userId,
      ),
    );

    expect(await prisma.stockLot.findUnique({ where: { id: foreign.id } })).not.toBeNull();
  });

  // ── 10. PO lines are created with a tenant ────────────────────────────────────────────
  it("case 10: lines created through createPurchaseOrder and through an edit carry the tenant id", async () => {
    const w = await seedWorld("c10", 0, 0);
    const created = await inTenant(w, () =>
      service.createPurchaseOrder(
        { supplierId: w.supplierId, items: [{ productId: w.productId, qty: 3, unitCost: 2 }] },
        w.userId,
      ),
    );
    await inTenant(w, () =>
      service.updatePurchaseOrder(
        created.id,
        {
          items: [
            { id: created.items[0].id, productId: w.productId, qtyOrdered: 3, unitCost: 2 },
            { productId: w.productId, qtyOrdered: 1, unitCost: 2 },
          ],
        },
        w.userId,
      ),
    );
    const lines = await prisma.purchaseOrderItem.findMany({ where: { poId: created.id } });
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.tenantId === w.tenantId)).toBe(true);
  });
});
