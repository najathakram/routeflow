/**
 * PO detail page data: `getPurchaseOrder` also returns the linked bill and the receipts history
 * (the PO's PURCHASE movements plus the compensating reversals a re-apply writes), joined on a
 * key that cannot pull in another document's movements: tenant scope, the PO's own products and
 * supplier, and nothing older than the PO itself.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * Every tenant is a throwaway `qa-po-detail-*` slug.
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
    `qa-po-detail-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "inventory.po-detail.db.spec.ts",
  );
};

const D = (n: number | string) => new Prisma.Decimal(n);

describeDb("PO detail read — receipts + linked bill — real Postgres", () => {
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
    await prisma.vendorBill.deleteMany({ where: { tenantId } });
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

  // ── 1. nothing received yet ────────────────────────────────────────────────────────────────
  it("a PO with no receipts has receipts [] and no linked bill", async () => {
    const w = await seedWorld("d1", 50, 2);
    const created = await inTenant(w, () =>
      service.createPurchaseOrder(
        { supplierId: w.supplierId, items: [{ productId: w.productId, qty: 20, unitCost: 4 }] },
        w.userId,
      ),
    );
    const po: any = await inTenant(w, () => service.getPurchaseOrder(created.id));
    expect(po.receipts).toEqual([]);
    expect(po.vendorBill).toBeNull();
  });

  // ── 2. partial receives, newest first ───────────────────────────────────────────────────────
  it("two partial receives list newest first with product, qty and cost", async () => {
    const w = await seedWorld("d2", 50, 2);
    const created = await inTenant(w, () =>
      service.createPurchaseOrder(
        { supplierId: w.supplierId, items: [{ productId: w.productId, qty: 20, unitCost: 4 }] },
        w.userId,
      ),
    );
    await inTenant(w, () => service.sendPurchaseOrder(created.id));
    for (const q of [8, 12]) {
      // eslint-disable-next-line no-await-in-loop
      await inTenant(w, () =>
        service.receivePurchaseOrder(
          created.id,
          { items: [{ itemId: created.items[0].id, receivedQty: q }] },
          w.userId,
        ),
      );
    }
    const po: any = await inTenant(w, () => service.getPurchaseOrder(created.id));
    expect(po.receipts.map((r: any) => [r.kind, Number(r.quantity)])).toEqual([
      ["RECEIPT", 12],
      ["RECEIPT", 8],
    ]);
    expect(po.receipts[0]).toMatchObject({ productId: w.productId, unitCost: expect.anything() });
    expect(po.receipts[0].productName).toMatch(/^Widget /);
  });

  // ── 3. a re-apply shows original + flagged reversal + re-post ───────────────────────────────
  it("a cost edit re-apply lists the receipt, a FLAGGED reversal pointing at it, and the re-post", async () => {
    const w = await seedWorld("d3", 20, 2);
    const po0 = await receivedPo(w, 20, 4);
    await inTenant(w, () =>
      service.updatePurchaseOrder(
        po0.id,
        {
          reapplyInventory: true,
          items: [{ id: po0.items[0].id, productId: w.productId, qtyOrdered: 20, unitCost: 6 }],
        },
        w.userId,
      ),
    );
    const po: any = await inTenant(w, () => service.getPurchaseOrder(po0.id));
    const kinds = po.receipts.map((r: any) => r.kind);
    expect(kinds.filter((k: string) => k === "RECEIPT")).toHaveLength(2);
    expect(kinds.filter((k: string) => k === "REVERSAL")).toHaveLength(1);
    const reversal = po.receipts.find((r: any) => r.kind === "REVERSAL");
    const original = po.receipts.find(
      (r: any) => r.kind === "RECEIPT" && r.id === reversal.reversesId,
    );
    expect(original).toBeDefined();
    // newest first: the re-post leads
    expect(po.receipts[0].kind).toBe("RECEIPT");
    expect(po.receipts[0].id).not.toBe(original.id);
  });

  // ── 4. the join key cannot pull in another document's movements ─────────────────────────────
  it("a movement that merely carries the same reference (other supplier, or older than the PO) is NOT a receipt", async () => {
    const w = await seedWorld("d4", 50, 2);
    const po0 = await receivedPo(w, 20, 4);
    const other = await prisma.supplier.create({
      data: { name: "Someone else", tenantId: w.tenantId },
    });
    // a manual purchase an operator happened to reference with this PO's number, from another supplier
    await prisma.stockMovement.create({
      data: {
        productId: w.productId,
        type: "PURCHASE",
        quantity: 5,
        unitCost: 9,
        reference: po0.poNumber,
        supplierId: other.id,
        tenantId: w.tenantId,
      },
    });
    // and one from the SAME supplier but written before this PO existed (a reused number)
    const old = await prisma.stockMovement.create({
      data: {
        productId: w.productId,
        type: "PURCHASE",
        quantity: 7,
        unitCost: 9,
        reference: po0.poNumber,
        supplierId: w.supplierId,
        tenantId: w.tenantId,
      },
    });
    await prisma.stockMovement.update({
      where: { id: old.id },
      data: { createdAt: new Date("2020-01-01T00:00:00Z") },
    });
    const po: any = await inTenant(w, () => service.getPurchaseOrder(po0.id));
    expect(po.receipts).toHaveLength(1);
    expect(Number(po.receipts[0].quantity)).toBe(20);
  });

  // ── 5. tenant scope ─────────────────────────────────────────────────────────────────────────
  it("another tenant's movement with the same reference never appears", async () => {
    const w = await seedWorld("d5a", 50, 2);
    const po0 = await receivedPo(w, 20, 4);
    const foreign = await seedWorld("d5b", 50, 2);
    // the PO's OWN product id and supplier, written under the OTHER tenant: only tenant scope can
    // exclude it (the product and supplier filters would let it through)
    await prisma.stockMovement.create({
      data: {
        productId: w.productId,
        type: "PURCHASE",
        quantity: 99,
        reference: po0.poNumber,
        supplierId: w.supplierId,
        tenantId: foreign.tenantId,
      },
    });
    const po: any = await inTenant(w, () => service.getPurchaseOrder(po0.id));
    expect(po.receipts).toHaveLength(1);
    await expect(inTenant(foreign, () => service.getPurchaseOrder(po0.id))).rejects.toThrow(
      /not found/i,
    );
  });

  // ── 6. the linked bill ──────────────────────────────────────────────────────────────────────
  it("returns the linked bill's id, number and status", async () => {
    const w = await seedWorld("d6", 50, 2);
    const created = await inTenant(w, () =>
      service.createPurchaseOrder(
        { supplierId: w.supplierId, items: [{ productId: w.productId, qty: 10, unitCost: 4 }] },
        w.userId,
      ),
    );
    const bill = await prisma.vendorBill.create({
      data: {
        billNumber: `BILL-${RUN_SUFFIX}-${tenantSeq}`,
        supplierId: w.supplierId,
        purchaseOrderId: created.id,
        totalOwed: 40,
        tenantId: w.tenantId,
      },
    });
    const po: any = await inTenant(w, () => service.getPurchaseOrder(created.id));
    expect(po.vendorBill).toMatchObject({ id: bill.id, billNumber: bill.billNumber });
    expect(po.vendorBill.status).toBeDefined();
  });

  // -- 7. a supplier-only edit leaves the receipts on the old supplier: they must still show ---
  it("a supplier-only edit of a received PO still lists its receipts (they carry the old supplier)", async () => {
    const w = await seedWorld("d7", 50, 2);
    const po0 = await receivedPo(w, 20, 4);
    const other = await prisma.supplier.create({
      data: { name: "New supplier", tenantId: w.tenantId },
    });
    await inTenant(w, () =>
      service.updatePurchaseOrder(
        po0.id,
        { supplierId: other.id, reapplyInventory: true },
        w.userId,
      ),
    );
    const po: any = await inTenant(w, () => service.getPurchaseOrder(po0.id));
    expect(po.supplier.id).toBe(other.id);
    expect(po.receipts.map((r: any) => r.kind)).toEqual(["RECEIPT"]);
    expect(Number(po.receipts[0].quantity)).toBe(20);
  });

  // -- 8. a planted "reversal" that points at nothing of this PO is not shown ----------------
  it("an ADJUSTMENT with the REAL reversal prefix but no matching receipt is ignored", async () => {
    const w = await seedWorld("d8", 50, 2);
    const po0 = await receivedPo(w, 20, 4);
    // the real constant (an em dash, not an ASCII hyphen), and an id that is not this PO's receipt
    const prefix = (InventoryService as unknown as { PO_REVERSAL_NOTE: string }).PO_REVERSAL_NOTE;
    expect(prefix).toContain("\u2014");
    await prisma.stockMovement.create({
      data: {
        productId: w.productId,
        type: "ADJUSTMENT",
        quantity: -5,
        reference: po0.poNumber,
        notes: `${prefix}not-a-real-movement`,
        tenantId: w.tenantId,
      },
    });
    const po: any = await inTenant(w, () => service.getPurchaseOrder(po0.id));
    expect(po.receipts.map((r: any) => r.kind)).toEqual(["RECEIPT"]);
  });

  // -- 9. after a re-apply an other-supplier same-reference movement still does not count ----
  it("re-apply, then an other-supplier movement with this PO's number: still not a receipt", async () => {
    const w = await seedWorld("d9", 20, 2);
    const po0 = await receivedPo(w, 20, 4);
    await inTenant(w, () =>
      service.updatePurchaseOrder(
        po0.id,
        {
          reapplyInventory: true,
          items: [{ id: po0.items[0].id, productId: w.productId, qtyOrdered: 20, unitCost: 6 }],
        },
        w.userId,
      ),
    );
    const other = await prisma.supplier.create({
      data: { name: "Someone else", tenantId: w.tenantId },
    });
    await prisma.stockMovement.create({
      data: {
        productId: w.productId,
        type: "PURCHASE",
        quantity: 7,
        unitCost: 9,
        reference: po0.poNumber,
        supplierId: other.id,
        tenantId: w.tenantId,
      },
    });
    const po: any = await inTenant(w, () => service.getPurchaseOrder(po0.id));
    const kinds = po.receipts.map((r: any) => r.kind).sort();
    expect(kinds).toEqual(["RECEIPT", "RECEIPT", "REVERSAL"]);
    expect(po.receipts.some((r: any) => Number(r.quantity) === 7)).toBe(false);
  });
});
