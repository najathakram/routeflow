/**
 * LANE-U step 6 — DB-lane proof for `InventoryService.updatePurchaseOrder` re-apply:
 * receive → edit cost → re-apply must leave stock and `averageCost` equal to a FRESH receive
 * at the edited cost, with the movement/lot ledger showing exactly that receipt. Re-apply
 * restates COST, never quantity (lead ruling, three-document rule): a raised qtyOrdered or an
 * added line is outstanding and arrives through the normal receive; lowering below received is
 * refused.
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
  async function seedWorld(
    label: string,
    stock: number,
    avg: number,
    costingMethod: "AVCO" | "FIFO" | "LIFO" = "AVCO",
  ): Promise<World> {
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
        costingMethod,
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

  // ── 1. edit cost → re-apply == a fresh receive at the edited cost ───────────────────────
  it("case 1: receive 20@4, edit the cost to 6, re-apply → stock and average equal a fresh 20@6 receive", async () => {
    const edited = await seedWorld("c1a", 20, 2);
    const po = await receivedPo(edited, 20, 4);
    expect(Number((await productOf(edited)).currentStock)).toBe(40);
    expect((await productOf(edited)).averageCost!.toString()).toBe("3"); // (20×2+20×4)/40

    await inTenant(edited, () =>
      service.updatePurchaseOrder(
        po.id,
        {
          reapplyInventory: true,
          items: [{ id: po.items[0].id, productId: edited.productId, qtyOrdered: 20, unitCost: 6 }],
        },
        edited.userId,
      ),
    );

    const fresh = await seedWorld("c1b", 20, 2);
    await receivedPo(fresh, 20, 6);

    const a = await productOf(edited);
    const b = await productOf(fresh);
    expect(a.currentStock.toString()).toBe(b.currentStock.toString()); // 40
    expect(a.averageCost!.toString()).toBe(b.averageCost!.toString()); // (20×2+20×6)/40 = 4
  });

  // ── 2. the ledger is append-only: original + compensation + re-post ─────────────────────
  it("case 2: re-apply keeps the original receipt, adds a costed compensation and the re-post; ONE lot remains", async () => {
    const w = await seedWorld("c2", 20, 2);
    const po = await receivedPo(w, 20, 4);
    await inTenant(w, () =>
      service.updatePurchaseOrder(
        po.id,
        {
          reapplyInventory: true,
          items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 20, unitCost: 6 }],
        },
        w.userId,
      ),
    );

    const all = await prisma.stockMovement.findMany({
      where: { tenantId: w.tenantId, reference: po.poNumber },
      orderBy: { createdAt: "asc" },
    });
    // SA-808 §5: the compensation is a NEGATIVE PURCHASE (the tobacco filing sums signed PURCHASE rows)
    const purchases = all.filter((m) => m.type === "PURCHASE" && Number(m.quantity) > 0);
    const compensations = all.filter((m) => m.type === "PURCHASE" && Number(m.quantity) < 0);
    expect(all.filter((m) => m.type === "ADJUSTMENT")).toHaveLength(0);
    expect(purchases).toHaveLength(2); // the original 20@4 is KEPT, plus the re-post 20@6
    expect(compensations).toHaveLength(1);
    const original = purchases.find((m) => m.unitCost!.toString() === "4")!;
    const repost = purchases.find((m) => m.unitCost!.toString() === "6")!;
    expect(original.quantity.toString()).toBe("20");
    expect(repost.quantity.toString()).toBe("20");
    expect(repost.performedById).toBe(w.userId);
    // the compensation is the exact inverse of the original: negative, same cost, tied to it
    expect(compensations[0].quantity.toString()).toBe("-20");
    expect(compensations[0].unitCost!.toString()).toBe("4");
    expect(compensations[0].notes).toBe("PO edit reversal — reverses " + original.id);
    // the ledger nets to exactly the edited receipt
    const net = all.reduce((sum, m) => sum + Number(m.quantity), 0);
    expect(net).toBe(20);

    const lots = await prisma.stockLot.findMany({
      where: { tenantId: w.tenantId, reference: po.poNumber },
    });
    expect(lots).toHaveLength(1);
    expect(lots[0].qty.toString()).toBe("20");
    expect(lots[0].remainingQty.toString()).toBe("20");
    expect(lots[0].unitCost.toString()).toBe("6");

    const after = await inTenant(w, () => service.getPurchaseOrder(po.id));
    expect(after.status).toBe("RECEIVED");
    expect(after.items[0].qtyReceived.toString()).toBe("20");
    expect(after.items[0].unitCost.toString()).toBe("6");
    expect(after.totalAmount.toString()).toBe("120");
  });

  // ── 3. a sale between receipt and edit is not lost ───────────────────────────────────────
  it("case 3: stock sold since the receipt survives the re-apply (net stock unchanged — same qty re-posted)", async () => {
    const w = await seedWorld("c3", 20, 2);
    const po = await receivedPo(w, 20, 4); // 40 on hand
    await prisma.product.update({ where: { id: w.productId }, data: { currentStock: 35 } }); // 5 sold
    await inTenant(w, () =>
      service.updatePurchaseOrder(
        po.id,
        {
          reapplyInventory: true,
          items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 20, unitCost: 6 }],
        },
        w.userId,
      ),
    );
    expect(Number((await productOf(w)).currentStock)).toBe(35); // 35 − 20 + 20
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
          items: [{ id: po.items[0].id, productId: edited.productId, qtyOrdered: 10, unitCost: 5 }],
        },
        edited.userId,
      ),
    );
    const fresh = await seedWorld("c4b", 20, 2);
    await receivedPo(fresh, 10, 5);

    const a = await productOf(edited);
    const b = await productOf(fresh);
    expect(a.currentStock.toString()).toBe(b.currentStock.toString()); // exact: 30
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
            items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 20, unitCost: 6 }],
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

  // ── 8. history stays put; the lot keeps its FIFO position ───────────────────────────────
  it("case 8: the original receipt stays in its own period, the correction is dated now, and the lot keeps its original purchase date", async () => {
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
          items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 20, unitCost: 5 }],
        },
        w.userId,
      ),
    );

    // Positive rows only: the reversal also writes a NEGATIVE PURCHASE row at the same unitCost 4,
    // dated now, and an unordered read can return it ahead of the original receipt.
    const purchases = await prisma.stockMovement.findMany({
      where: {
        tenantId: w.tenantId,
        reference: po.poNumber,
        type: "PURCHASE",
        quantity: { gt: 0 },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const kept = purchases.find((m) => m.unitCost!.toString() === "4")!;
    const repost = purchases.find((m) => m.unitCost!.toString() === "5")!;
    expect(kept.createdAt.toISOString()).toBe(original.toISOString()); // August is untouched
    const compensations = await prisma.stockMovement.findMany({
      where: {
        tenantId: w.tenantId,
        reference: po.poNumber,
        type: "PURCHASE",
        quantity: { lt: 0 },
      },
    });
    expect(compensations).toHaveLength(1);
    expect(Number(compensations[0].quantity)).toBe(-20);
    expect(compensations[0].unitCost!.toString()).toBe("4");
    expect(compensations[0].createdAt.getTime()).toBeGreaterThan(original.getTime());
    expect(repost.createdAt.getTime()).toBeGreaterThan(original.getTime()); // the correction is dated now
    const [lot] = await prisma.stockLot.findMany({
      where: { tenantId: w.tenantId, reference: po.poNumber },
    });
    expect(lot.purchaseDate.toISOString()).toBe(original.toISOString()); // FIFO position kept
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
          items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 20, unitCost: 6 }],
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

  // ── 11. a raised qty is outstanding — no phantom stock, normal receive completes it ───────
  it("case 11: raising qtyOrdered on a RECEIVED PO with re-apply posts NO extra stock; the outstanding qty arrives through the normal receive (and can't be over-received)", async () => {
    const w = await seedWorld("c11", 20, 2);
    const po = await receivedPo(w, 20, 4);
    expect(po.status).toBe("RECEIVED");

    await inTenant(w, () =>
      service.updatePurchaseOrder(
        po.id,
        {
          reapplyInventory: true,
          items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 30, unitCost: 4 }],
        },
        w.userId,
      ),
    );
    const mid = await inTenant(w, () => service.getPurchaseOrder(po.id));
    expect(mid.status).toBe("PARTIAL"); // RECEIVED with outstanding qty
    expect(mid.items[0].qtyReceived.toString()).toBe("20");
    expect(Number((await productOf(w)).currentStock)).toBe(40); // unchanged — nothing new arrived

    // the over-receipt gate holds: only 10 is outstanding
    await expect(
      inTenant(w, () =>
        service.receivePurchaseOrder(
          po.id,
          { items: [{ itemId: po.items[0].id, receivedQty: 11 }] },
          w.userId,
        ),
      ),
    ).rejects.toThrow(/outstanding/);

    await inTenant(w, () =>
      service.receivePurchaseOrder(
        po.id,
        { items: [{ itemId: po.items[0].id, receivedQty: 10 }] },
        w.userId,
      ),
    );
    const done = await inTenant(w, () => service.getPurchaseOrder(po.id));
    expect(done.status).toBe("RECEIVED");
    expect(Number((await productOf(w)).currentStock)).toBe(50);
  });

  // ── 12. lowering below received is refused in both modes ─────────────────────────────────
  it("case 12: lowering a received line below what arrived is refused (400) and changes nothing", async () => {
    const w = await seedWorld("c12", 20, 2);
    const po = await receivedPo(w, 20, 4);
    for (const reapplyInventory of [false, true]) {
      await expect(
        inTenant(w, () =>
          service.updatePurchaseOrder(
            po.id,
            {
              reapplyInventory,
              items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 15, unitCost: 4 }],
            },
            w.userId,
          ),
        ),
      ).rejects.toThrow(/recording a return/);
    }
    expect(Number((await productOf(w)).currentStock)).toBe(40);
    const after = await inTenant(w, () => service.getPurchaseOrder(po.id));
    expect(after.items[0].qtyOrdered.toString()).toBe("20");
  });

  // ── 13/14. B583: a partly-consumed lot refuses the re-apply (FIFO and LIFO) ──────────────
  describe.each(["FIFO", "LIFO"] as const)("B583 — %s: a partly-consumed lot", (method) => {
    it("refuses the re-apply (409) and changes NOTHING — the lot pool is never inflated", async () => {
      const w = await seedWorld("b583" + method.toLowerCase(), 0, 0, method);
      const po = await receivedPo(w, 10, 4); // one lot of 10
      // a sale consumed 4 of the lot (and took 4 off the shelf)
      await prisma.stockLot.updateMany({
        where: { tenantId: w.tenantId, reference: po.poNumber },
        data: { remainingQty: 6 },
      });
      await prisma.product.update({ where: { id: w.productId }, data: { currentStock: 6 } });
      const movementsBefore = await prisma.stockMovement.count({
        where: { tenantId: w.tenantId, reference: po.poNumber },
      });

      await expect(
        inTenant(w, () =>
          service.updatePurchaseOrder(
            po.id,
            {
              reapplyInventory: true,
              items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 10, unitCost: 5 }],
            },
            w.userId,
          ),
        ),
      ).rejects.toMatchObject({ response: { code: "PO_LOT_PARTIALLY_CONSUMED" } });

      // nothing moved: one lot, still 6 remaining; stock still 6; no movement written
      const lots = await prisma.stockLot.findMany({
        where: { tenantId: w.tenantId, reference: po.poNumber },
      });
      expect(lots).toHaveLength(1);
      expect(lots[0].remainingQty.toString()).toBe("6");
      expect(Number((await productOf(w)).currentStock)).toBe(6);
      expect(
        await prisma.stockMovement.count({
          where: { tenantId: w.tenantId, reference: po.poNumber },
        }),
      ).toBe(movementsBefore);
      const unchanged = await inTenant(w, () => service.getPurchaseOrder(po.id));
      expect(unchanged.items[0].unitCost.toString()).toBe("4"); // the edit rolled back / never applied

      // the lot pool equals what is really on hand: 6 == 6 (the old code left 0 + 10 = 10)
      const pool = lots.reduce((sum, l) => sum + Number(l.remainingQty), 0);
      expect(pool).toBe(6);
    });

    it("document-only is still allowed on the same PO", async () => {
      const w = await seedWorld("b583doc" + method.toLowerCase(), 0, 0, method);
      const po = await receivedPo(w, 10, 4);
      await prisma.stockLot.updateMany({
        where: { tenantId: w.tenantId, reference: po.poNumber },
        data: { remainingQty: 6 },
      });
      await prisma.product.update({ where: { id: w.productId }, data: { currentStock: 6 } });
      await inTenant(w, () =>
        service.updatePurchaseOrder(
          po.id,
          {
            reapplyInventory: false,
            items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 10, unitCost: 5 }],
          },
          w.userId,
        ),
      );
      const after = await inTenant(w, () => service.getPurchaseOrder(po.id));
      expect(after.items[0].unitCost.toString()).toBe("5");
      expect(Number((await productOf(w)).currentStock)).toBe(6);
    });
  });

  // ── 15. an untouched FIFO lot re-applies cleanly and the pool still equals stock ────────
  it("case 15: an untouched FIFO lot re-applies cleanly — the lot pool equals the stock on hand", async () => {
    const w = await seedWorld("c15", 0, 0, "FIFO");
    const po = await receivedPo(w, 10, 4);
    await inTenant(w, () =>
      service.updatePurchaseOrder(
        po.id,
        {
          reapplyInventory: true,
          items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 10, unitCost: 5 }],
        },
        w.userId,
      ),
    );
    const lots = await prisma.stockLot.findMany({
      where: { tenantId: w.tenantId, productId: w.productId },
    });
    const pool = lots.reduce((sum, l) => sum + Number(l.remainingQty), 0);
    expect(lots).toHaveLength(1);
    expect(pool).toBe(10);
    expect(Number((await productOf(w)).currentStock)).toBe(10);
    expect((await productOf(w)).averageCost!.toString()).toBe("5");
  });

  // ── 16. re-applying twice: the second reverses only the live receipt ────────────────────
  it("case 16: re-applying twice — the second re-apply reverses only the live receipt and stock/average stay right", async () => {
    const w = await seedWorld("c16", 20, 2);
    const po = await receivedPo(w, 20, 4);
    for (const cost of [6, 8]) {
      await inTenant(w, () =>
        service.updatePurchaseOrder(
          po.id,
          {
            reapplyInventory: true,
            items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 20, unitCost: cost }],
          },
          w.userId,
        ),
      );
    }
    const fresh = await seedWorld("c16b", 20, 2);
    await receivedPo(fresh, 20, 8);
    const a = await productOf(w);
    const b = await productOf(fresh);
    expect(a.currentStock.toString()).toBe(b.currentStock.toString()); // 40
    expect(a.averageCost!.toString()).toBe(b.averageCost!.toString()); // (20×2+20×8)/40 = 5

    const all = await prisma.stockMovement.findMany({
      where: { tenantId: w.tenantId, reference: po.poNumber },
    });
    expect(all.filter((m) => m.type === "PURCHASE" && Number(m.quantity) > 0)).toHaveLength(3); // 20@4, 20@6, 20@8
    // reverses 20@4, reverses 20@6 — negative PURCHASE rows (SA-808 §5)
    expect(all.filter((m) => m.type === "PURCHASE" && Number(m.quantity) < 0)).toHaveLength(2);
    expect(all.filter((m) => m.type === "ADJUSTMENT")).toHaveLength(0);
    expect(all.reduce((sum, m) => sum + Number(m.quantity), 0)).toBe(20);
    expect(
      await prisma.stockLot.count({ where: { tenantId: w.tenantId, reference: po.poNumber } }),
    ).toBe(1);
  });
});
