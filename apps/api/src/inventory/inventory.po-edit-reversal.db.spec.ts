/**
 * SA-808 §5 (B846 sibling) — the PO-edit reversal against real Postgres: the compensation a re-apply
 * writes is a NEGATIVE PURCHASE row (the tobacco filing sums signed PURCHASE rows), dated at the
 * receipt or, when that period is filed, now with the filing named; the re-post books beside it; a
 * second edit pairs the reversal (and a LEGACY ADJUSTMENT reversal) so nothing is reversed twice.
 * The twin of `inventory.po-edit-reversal.spec.ts` (P1-P3; P4 is the unit guard).
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * Every tenant is a throwaway `qa-po-rev-*` slug (`assertTestTenant`).
 *
 * NOT EXECUTED by the authoring session (no Postgres it owns) — for the Mac mini.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
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
    `qa-po-rev-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "inventory.po-edit-reversal.db.spec.ts",
  );
};

/** The receipt month is LAST month (a completed month a tobacco report may cover); today is open. */
const today = new Date();
const REC_Y = today.getUTCMonth() === 0 ? today.getUTCFullYear() - 1 : today.getUTCFullYear();
const REC_M = today.getUTCMonth() === 0 ? 12 : today.getUTCMonth(); // 1-12
const RECEIPT_AT = new Date(Date.UTC(REC_Y, REC_M - 1, 15, 10, 0, 0));
const MONTH_START = new Date(Date.UTC(REC_Y, REC_M - 1, 1));
const MONTH_END_EXCL = new Date(Date.UTC(REC_Y, REC_M, 1));
const inReceiptMonth = (d: Date) => d >= MONTH_START && d < MONTH_END_EXCL;
const inOpenMonths = (d: Date) => d >= MONTH_END_EXCL;

describeDb("PO edit reversal is a PURCHASE row (SA-808 §5) — real Postgres", () => {
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
      await (async () => {
        const pos = await prisma.purchaseOrder.findMany({
          where: { tenantId },
          select: { id: true },
        });
        await prisma.purchaseOrderItem.deleteMany({
          where: { poId: { in: pos.map((p) => p.id) } },
        });
        await prisma.purchaseOrder.deleteMany({ where: { tenantId } });
        await prisma.tobaccoReport.deleteMany({ where: { tenantId } });
        await prisma.stockLot.deleteMany({ where: { tenantId } });
        await prisma.stockMovement.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.supplier.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      })().catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`po-edit-reversal cleanup failed for tenant ${tenantId}:`, e);
      });
    }
    await prisma.$disconnect();
  });

  interface World {
    tenantId: string;
    userId: string;
    supplierId: string;
    productId: string;
  }

  async function seedWorld(label: string): Promise<World> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `PO reversal ${slug}` } });
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
        name: `Cigars ${slug}`,
        unit: "ea",
        pricePerUnit: 10,
        currentStock: 0,
        costingMethod: "AVCO",
        tenantId: tenant.id,
        isTobacco: true,
      },
    });
    return { tenantId: tenant.id, userId: user.id, supplierId: supplier.id, productId: product.id };
  }

  const inTenant = <T>(w: World, fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);

  /** createPO -> send -> receive all -> backdate the receipt (movement + lot) to last month. */
  async function receivedPoLastMonth(w: World, qty: number, cost: number) {
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
        { items: [{ itemId: created.items[0].id, receivedQty: qty }] },
        w.userId,
      ),
    );
    await prisma.stockMovement.updateMany({
      where: { tenantId: w.tenantId, reference: created.poNumber },
      data: { effectiveAt: RECEIPT_AT },
    });
    await prisma.stockLot.updateMany({
      where: { tenantId: w.tenantId, reference: created.poNumber },
      data: { purchaseDate: RECEIPT_AT },
    });
    return inTenant(w, () => service.getPurchaseOrder(created.id));
  }

  const edit = (w: World, po: { id: string; items: { id: string }[] }, unitCost: number) =>
    inTenant(w, () =>
      service.updatePurchaseOrder(
        po.id,
        {
          reapplyInventory: true,
          items: [{ id: po.items[0].id, productId: w.productId, qtyOrdered: 10, unitCost }],
        },
        w.userId,
      ),
    );

  const ledger = async (w: World, poNumber: string) =>
    (
      await prisma.stockMovement.findMany({
        where: { tenantId: w.tenantId, reference: poNumber },
        orderBy: [{ effectiveAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      })
    ).map((m) => ({
      id: m.id,
      type: m.type as string,
      q: Number(m.quantity),
      notes: m.notes,
      effectiveAt: m.effectiveAt,
    }));
  /** What the tobacco report sums: signed PURCHASE quantity, by the month it falls in. */
  const purchasesIn = (rows: Awaited<ReturnType<typeof ledger>>, inMonth: (d: Date) => boolean) =>
    rows
      .filter((r) => r.type === "PURCHASE" && inMonth(r.effectiveAt))
      .reduce((t, r) => t + r.q, 0);
  const stock = async (w: World) =>
    Number((await prisma.product.findUniqueOrThrow({ where: { id: w.productId } })).currentStock);

  const fileMonth = (w: World, start: Date, endExcl: Date) =>
    prisma.tobaccoReport.create({
      data: {
        tenantId: w.tenantId,
        periodYear: start.getUTCFullYear(),
        periodMonth: start.getUTCMonth() + 1,
        periodStart: start,
        periodEnd: new Date(endExcl.getTime() - 1),
        status: "GENERATED",
        rows: [],
      },
    });

  it("P1: a last-month receipt edited today nets in last month — a -Q PURCHASE at the receipt's date, no ADJUSTMENT", async () => {
    const w = await seedWorld("p1");
    const po = await receivedPoLastMonth(w, 10, 2);
    await edit(w, po, 3);

    const rows = await ledger(w, po.poNumber);
    expect(rows.filter((r) => r.type === "ADJUSTMENT")).toHaveLength(0);
    const reversal = rows.find((r) => r.q === -10)!;
    expect(reversal.type).toBe("PURCHASE");
    expect(reversal.effectiveAt.getTime()).toBe(RECEIPT_AT.getTime());
    expect(reversal.notes).toMatch(/^PO edit reversal — reverses /);
    expect(purchasesIn(rows, inReceiptMonth)).toBe(10); // one receipt, edited cost — not 10 + 10
    expect(purchasesIn(rows, inOpenMonths)).toBe(0);
    expect(await stock(w)).toBe(10);
  });

  it("P2: last month already filed — reversal and re-post book now with the filing named; live last month equals the filing", async () => {
    const w = await seedWorld("p2");
    const po = await receivedPoLastMonth(w, 10, 2);
    await fileMonth(w, MONTH_START, MONTH_END_EXCL);
    await edit(w, po, 3);

    const rows = await ledger(w, po.poNumber);
    const reversal = rows.find((r) => r.q === -10)!;
    expect(reversal.type).toBe("PURCHASE");
    expect(inOpenMonths(reversal.effectiveAt)).toBe(true);
    expect(reversal.notes).toContain("(filed through ");
    expect(purchasesIn(rows, inReceiptMonth)).toBe(10); // what was filed
    expect(purchasesIn(rows, inOpenMonths)).toBe(0); // -10 + 10 in the open month
    expect(await stock(w)).toBe(10);
  });

  it("P2: when the current month is filed too, the edit is refused 409 and nothing is written", async () => {
    const w = await seedWorld("p2b");
    const po = await receivedPoLastMonth(w, 10, 2);
    await fileMonth(
      w,
      MONTH_START,
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1)),
    );
    const before = await ledger(w, po.poNumber);
    await expect(edit(w, po, 3)).rejects.toMatchObject({
      response: { code: "STOCK_DATE_IN_FILED_PERIOD" },
    });
    expect(await ledger(w, po.poNumber)).toEqual(before);
    expect(await stock(w)).toBe(10);
  });

  it("P3: a second edit reverses only the unreversed rows; a LEGACY ADJUSTMENT reversal still pairs", async () => {
    const w = await seedWorld("p3");
    const po = await receivedPoLastMonth(w, 10, 2);
    await edit(w, po, 3);
    await edit(w, po, 4);

    let rows = await ledger(w, po.poNumber);
    expect(rows.filter((r) => r.type === "PURCHASE" && r.q > 0)).toHaveLength(3); // 2, 3, 4
    expect(rows.filter((r) => r.type === "PURCHASE" && r.q < 0)).toHaveLength(2);
    expect(purchasesIn(rows, inReceiptMonth)).toBe(10);
    expect(await stock(w)).toBe(10);

    // Re-type the FIRST reversal as the pre-fix row (ADJUSTMENT, dated when it was written).
    const firstReversal = rows.find((r) => r.q < 0)!;
    await prisma.stockMovement.update({
      where: { id: firstReversal.id },
      data: { type: "ADJUSTMENT", effectiveAt: new Date() },
    });
    await edit(w, po, 5);

    rows = await ledger(w, po.poNumber);
    const targets = rows
      .filter((r) => r.q < 0)
      .map((r) => (r.notes ?? "").replace("PO edit reversal — reverses ", "").split(" ")[0]);
    expect(new Set(targets).size).toBe(targets.length); // no receipt reversed twice
    expect(rows.reduce((t, r) => t + r.q, 0)).toBe(10); // the ledger nets to exactly one receipt
    expect(await stock(w)).toBe(10);
  });

  // ── one re-post per reversed receipt (SA-808 §3(A) per receipt) ─────────────────────────
  const EARLY_AT = new Date(Date.UTC(REC_Y, REC_M - 2, 5, 10, 0, 0)); // the month BEFORE the receipt month
  const EARLY_START = new Date(Date.UTC(REC_Y, REC_M - 2, 1));
  const inEarlyMonth = (d: Date) => d >= EARLY_START && d < MONTH_START;

  /** createPO of 10 -> two partial receipts of 5 (early month, last month), both backdated. */
  async function twoMonthPo(w: World) {
    const created = await inTenant(w, () =>
      service.createPurchaseOrder(
        { supplierId: w.supplierId, items: [{ productId: w.productId, qty: 10, unitCost: 2 }] },
        w.userId,
      ),
    );
    await inTenant(w, () => service.sendPurchaseOrder(created.id));
    for (const at of [EARLY_AT, RECEIPT_AT]) {
      // eslint-disable-next-line no-await-in-loop
      await inTenant(w, () =>
        service.receivePurchaseOrder(
          created.id,
          { items: [{ itemId: created.items[0].id, receivedQty: 5 }] },
          w.userId,
        ),
      );
      // eslint-disable-next-line no-await-in-loop
      const newest = await prisma.stockMovement.findFirstOrThrow({
        where: { tenantId: w.tenantId, reference: created.poNumber, effectiveAt: { gt: at } },
        orderBy: { createdAt: "desc" },
      });
      // eslint-disable-next-line no-await-in-loop
      await prisma.stockMovement.update({ where: { id: newest.id }, data: { effectiveAt: at } });
    }
    return inTenant(w, () => service.getPurchaseOrder(created.id));
  }
  /** The report's ending stock for a period: the counter minus every movement dated after it. */
  const endingStock = async (w: World, periodEndExcl: Date) => {
    const after = await prisma.stockMovement.findMany({
      where: { tenantId: w.tenantId, productId: w.productId, effectiveAt: { gte: periodEndExcl } },
    });
    return (await stock(w)) - after.reduce((t, m) => t + Number(m.quantity), 0);
  };

  it("two-month PO edited today: early month 5, last month 5, open months 0, and the early month's ending stock is right", async () => {
    const w = await seedWorld("m1");
    const po = await twoMonthPo(w);
    await edit(w, po, 3);

    const rows = await ledger(w, po.poNumber);
    expect(rows.filter((r) => r.type === "ADJUSTMENT")).toHaveLength(0);
    expect(purchasesIn(rows, inEarlyMonth)).toBe(5);
    expect(purchasesIn(rows, inReceiptMonth)).toBe(5);
    expect(purchasesIn(rows, inOpenMonths)).toBe(0);
    expect(rows.filter((r) => r.q > 0 && r.notes == null)).toHaveLength(2); // one re-post per receipt
    expect(await endingStock(w, MONTH_START)).toBe(5);
    expect(await stock(w)).toBe(10);
    const lots = await prisma.stockLot.findMany({
      where: { tenantId: w.tenantId, reference: po.poNumber },
    });
    expect(lots).toHaveLength(1);
    expect(lots[0].qty.toString()).toBe("10");
  });

  it("two-month PO, early month filed, last month open: early month unchanged, last month 5, the closed receipt's pair nets 0 now", async () => {
    const w = await seedWorld("m2");
    const po = await twoMonthPo(w);
    await fileMonth(w, EARLY_START, MONTH_START);
    await edit(w, po, 3);

    const rows = await ledger(w, po.poNumber);
    expect(purchasesIn(rows, inEarlyMonth)).toBe(5); // what was filed
    expect(purchasesIn(rows, inReceiptMonth)).toBe(5);
    expect(purchasesIn(rows, inOpenMonths)).toBe(0); // −5 + 5 for the closed receipt
    const closedReversal = rows.find(
      (r) => r.q === -5 && (r.notes ?? "").includes("(filed through "),
    )!;
    expect(inOpenMonths(closedReversal.effectiveAt)).toBe(true);
    expect(await endingStock(w, MONTH_START)).toBe(5);
  });
});
