/**
 * B846 / SA-808 — vendor-bill revert against real Postgres: nothing deletes a StockMovement, the
 * reversal is a signed PURCHASE row paired by note, and a filed period never moves. The twin of
 * `vendor-bills.revert-appends.spec.ts` (R1-R5; R6 is the unit guard). Throwaway `qa-b846-*` tenants.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`). Run with `npm run local:test:db`.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InventoryService } from "../inventory/inventory.service";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { StorageService } from "../storage/storage.service";
import { ProductAliasService } from "../import/product-alias.service";
import { BILL_REVERTED_NOTE, billReceiptNote } from "../inventory/bill-revert";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(`qa-b846-${RUN_SUFFIX}-${tenantSeq}-${label}`, "bill-revert-appends");
};

/** The bill month is LAST month (a completed month, so a tobacco report may exist); today is open. */
const today = new Date();
const BILL_Y = today.getUTCMonth() === 0 ? today.getUTCFullYear() - 1 : today.getUTCFullYear();
const BILL_M = today.getUTCMonth() === 0 ? 12 : today.getUTCMonth(); // 1-12
const BILL_DATE = `${BILL_Y}-${String(BILL_M).padStart(2, "0")}-15`;
const MONTH_START = new Date(Date.UTC(BILL_Y, BILL_M - 1, 1));
const MONTH_END_EXCL = new Date(Date.UTC(BILL_Y, BILL_M, 1));
/** The month BEFORE the bill month: unfiled in R7 while the bill month is filed. */
const EARLIER_DATE = new Date(Date.UTC(BILL_Y, BILL_M - 2, 15)).toISOString().slice(0, 10);
const inBillMonth = (d: Date) => d >= MONTH_START && d < MONTH_END_EXCL;

describeDb("B846 bill revert appends — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let bills: VendorBillsService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorBillsService,
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
        {
          provide: PlatformConfigService,
          useValue: {
            resolveAnthropicKey: jest.fn().mockResolvedValue(null),
            recordAiUsage: jest.fn(),
          },
        },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        {
          provide: DuplicateMatchService,
          useValue: {
            normalizeNumber: (raw: string) => (raw ?? "").toUpperCase().replace(/\s+/g, ""),
            findVendorBillDuplicate: jest.fn().mockResolvedValue(null),
            findScanDuplicate: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
        {
          provide: ProductAliasService,
          useValue: { resolveMany: jest.fn(), learn: jest.fn(), unlearn: jest.fn() },
        },
      ],
    }).compile();
    bills = module.get(VendorBillsService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        const vb = await prisma.vendorBill.findMany({ where: { tenantId }, select: { id: true } });
        const billIds = vb.map((b) => b.id);
        await prisma.billPayment.deleteMany({ where: { vendorBillId: { in: billIds } } });
        await prisma.vendorBillItem.deleteMany({ where: { vendorBillId: { in: billIds } } });
        await prisma.vendorBill.deleteMany({ where: { tenantId } });
        await prisma.regulatedFiling.deleteMany({ where: { tenantId } });
        await prisma.tobaccoReport.deleteMany({ where: { tenantId } });
        await prisma.stockLot.deleteMany({ where: { tenantId } });
        await prisma.stockMovement.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.trackedCategory.deleteMany({ where: { tenantId } });
        await prisma.supplier.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      })().catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`bill-revert-appends cleanup failed for tenant ${tenantId}:`, e);
      });
    }
    await prisma.$disconnect();
  });

  interface World {
    tenantId: string;
    userId: string;
    supplierId: string;
    productId: string;
    categoryId: string | null;
  }

  async function seedWorld(
    label: string,
    kind: "plain" | "tobacco" | "tracked" = "plain",
  ): Promise<World> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `Revert appends ${slug}` } });
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
    const category =
      kind === "tracked"
        ? await prisma.trackedCategory.create({
            data: { name: `Cat ${slug}`, tenantId: tenant.id, reportCadence: "MONTHLY" },
          })
        : null;
    const product = await prisma.product.create({
      data: {
        name: `Widget ${slug}`,
        unit: "ea",
        pricePerUnit: 10,
        currentStock: 0,
        costingMethod: "AVCO",
        tenantId: tenant.id,
        isTobacco: kind === "tobacco",
        trackedCategoryId: category?.id ?? null,
      },
    });
    return {
      tenantId: tenant.id,
      userId: user.id,
      supplierId: supplier.id,
      productId: product.id,
      categoryId: category?.id ?? null,
    };
  }

  const inTenant = <T>(w: World, fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);

  async function receiveBill(w: World, qty: number, billNumber = "B-846-1", date = BILL_DATE) {
    const bill: any = await inTenant(w, () =>
      bills.create({
        supplierId: w.supplierId,
        billNumber,
        billDate: date,
        items: [{ productId: w.productId, description: "Widget", qty, unitCost: 2 }],
      } as never),
    );
    await inTenant(w, () => bills.receive(bill.id, undefined, w.userId));
    return bill.id as string;
  }
  const revert = (w: World, id: string) =>
    inTenant(w, () => bills.revertToDraft(id, w.userId) as Promise<unknown>);
  const rereceive = async (w: World, id: string, qty: number) => {
    await inTenant(w, () =>
      bills.update(id, {
        items: [{ productId: w.productId, description: "Widget", qty, unitCost: 2 }],
      } as never),
    );
    await inTenant(w, () => bills.receive(id, undefined, w.userId));
  };

  const ledger = async (w: World) =>
    (
      await prisma.stockMovement.findMany({
        where: { productId: w.productId },
        orderBy: [{ effectiveAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      })
    ).map((m) => ({
      id: m.id,
      q: Number(m.quantity),
      notes: m.notes,
      effectiveAt: m.effectiveAt,
    }));
  const billMonthSum = async (w: World) =>
    (await ledger(w)).filter((r) => inBillMonth(r.effectiveAt)).reduce((t, r) => t + r.q, 0);
  const counter = async (w: World) =>
    Number((await prisma.product.findUniqueOrThrow({ where: { id: w.productId } })).currentStock);

  const fileTobaccoMonth = (w: World) =>
    prisma.tobaccoReport.create({
      data: {
        tenantId: w.tenantId,
        periodYear: BILL_Y,
        periodMonth: BILL_M,
        periodStart: MONTH_START,
        periodEnd: new Date(MONTH_END_EXCL.getTime() - 1),
        status: "GENERATED",
        rows: [],
      },
    });

  it("R1: a manual PURCHASE sharing the bill number survives the revert; one -Q reversal is appended", async () => {
    const w = await seedWorld("r1");
    await inTenant(w, () =>
      prisma.stockMovement.create({
        data: {
          productId: w.productId,
          type: "PURCHASE",
          quantity: 5,
          unitCost: 1,
          stockAfter: 5,
          supplierId: w.supplierId,
          reference: "B-846-1",
          notes: "manual purchase",
        },
      }),
    );
    await prisma.product.update({
      where: { id: w.productId },
      data: { currentStock: 5, averageCost: 1 },
    });

    const id = await receiveBill(w, 10);
    await revert(w, id);

    const rows = await ledger(w);
    expect(rows.map((r) => r.q)).toEqual(expect.arrayContaining([5, 10, -10]));
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.notes === "manual purchase")).toBeDefined();
    const receipt = rows.find(
      (r) => r.notes === billReceiptNote("B-846-1"),
    ) as (typeof rows)[number];
    const reversal = rows.find((r) => r.q === -10) as (typeof rows)[number];
    expect(reversal.notes).toBe(`${BILL_REVERTED_NOTE}${receipt.id}`);
    expect(rows.reduce((t, r) => t + r.q, 0)).toBe(await counter(w)); // Σq == the counter
  });

  it("R2: unfiled bill month — receive Q, revert, re-receive Q': the month sums to Q' and history is kept", async () => {
    const w = await seedWorld("r2");
    const id = await receiveBill(w, 10);
    await revert(w, id);
    await rereceive(w, id, 8);

    expect(await billMonthSum(w)).toBe(8);
    expect((await ledger(w)).map((r) => r.q)).toEqual([10, -10, 8]);
    expect(await counter(w)).toBe(8);
  });

  it("R4: a second revert after the re-receive reverses only the re-received row", async () => {
    const w = await seedWorld("r4");
    const id = await receiveBill(w, 10);
    await revert(w, id);
    await rereceive(w, id, 8);
    await revert(w, id);

    const rows = await ledger(w);
    expect(rows.map((r) => r.q)).toEqual([10, -10, 8, -8]);
    expect(rows[3].notes).toBe(`${BILL_REVERTED_NOTE}${rows[2].id}`);
    expect(await counter(w)).toBe(0);
  });

  it("R3: a GENERATED tobacco report for the bill month — the revert is dated now, the filed month is unchanged", async () => {
    const w = await seedWorld("r3", "tobacco");
    const id = await receiveBill(w, 10);
    await fileTobaccoMonth(w);

    await revert(w, id);

    const rows = await ledger(w);
    expect(await billMonthSum(w)).toBe(10); // live == what was filed
    const reversal = rows.find((r) => r.q === -10) as (typeof rows)[number];
    expect(inBillMonth(reversal.effectiveAt)).toBe(false);
    expect(reversal.notes).toContain("(filed through ");
    await rereceive(w, id, 8);
    expect(await billMonthSum(w)).toBe(10);
    const fresh = await ledger(w);
    expect(fresh.map((r) => r.q)).toEqual(expect.arrayContaining([10, -10, 8]));
    expect(fresh).toHaveLength(3);
    expect(fresh.reduce((t, r) => t + r.q, 0)).toBe(await counter(w));
  });

  it("R5: a LOCKED RegulatedFiling for the tracked category behaves as R3", async () => {
    const w = await seedWorld("r5", "tracked");
    const id = await receiveBill(w, 10);
    await prisma.regulatedFiling.create({
      data: {
        tenantId: w.tenantId,
        trackedCategoryId: w.categoryId as string,
        reportTemplate: "GENERIC",
        cadence: "MONTHLY",
        periodKey: `${BILL_Y}-${String(BILL_M).padStart(2, "0")}`,
        periodStart: MONTH_START,
        periodEnd: MONTH_END_EXCL,
        status: "LOCKED",
        lockedAt: new Date(),
        rows: [],
      },
    });

    await revert(w, id);

    expect(await billMonthSum(w)).toBe(10);
    const reversal = (await ledger(w)).find((r) => r.q === -10) as { effectiveAt: Date };
    expect(inBillMonth(reversal.effectiveAt)).toBe(false);
  });

  it("R7: an earlier UNFILED month's bill, bill month FILED — the revert is dated now and the filed month's ending stock holds", async () => {
    const w = await seedWorld("r7", "tobacco");
    const id = await receiveBill(w, 10, "B-846-7", EARLIER_DATE);
    await fileTobaccoMonth(w);
    const endingStock = async () =>
      (await counter(w)) -
      (await ledger(w)).filter((r) => r.effectiveAt >= MONTH_END_EXCL).reduce((t, r) => t + r.q, 0);
    const filedEnding = await endingStock();

    await revert(w, id);

    const reversal = (await ledger(w)).find((r) => r.q === -10) as {
      effectiveAt: Date;
      notes: string | null;
    };
    expect(reversal.effectiveAt >= MONTH_END_EXCL).toBe(true);
    expect(reversal.notes).toContain("(filed through ");
    expect(await endingStock()).toBe(filedEnding);
  });

  it("a FAILED month before the latest filed one is closed; a FAILED month after it stays open", async () => {
    const w = await seedWorld("failed", "tobacco");
    const id = await receiveBill(w, 10, "B-846-8");
    // bill month: FAILED, earlier month GENERATED => the bill month is after the latest filed one
    await prisma.tobaccoReport.create({
      data: {
        tenantId: w.tenantId,
        periodYear: BILL_Y,
        periodMonth: BILL_M,
        periodStart: MONTH_START,
        periodEnd: new Date(MONTH_END_EXCL.getTime() - 1),
        status: "FAILED",
        rows: [],
      },
    });
    await prisma.tobaccoReport.create({
      data: {
        tenantId: w.tenantId,
        periodYear: new Date(Date.UTC(BILL_Y, BILL_M - 2, 1)).getUTCFullYear(),
        periodMonth: new Date(Date.UTC(BILL_Y, BILL_M - 2, 1)).getUTCMonth() + 1,
        periodStart: new Date(Date.UTC(BILL_Y, BILL_M - 2, 1)),
        periodEnd: new Date(MONTH_START.getTime() - 1),
        status: "GENERATED",
        rows: [],
      },
    });

    await revert(w, id);

    const reversal = (await ledger(w)).find((r) => r.q === -10) as { effectiveAt: Date };
    expect(inBillMonth(reversal.effectiveAt)).toBe(true); // open: dated at the original
  });

  it("a FAILED earlier month is closed once a later month is filed: dated now", async () => {
    const w = await seedWorld("failed-before", "tobacco");
    const id = await receiveBill(w, 10, "B-846-9", EARLIER_DATE);
    const earlierStart = new Date(Date.UTC(BILL_Y, BILL_M - 2, 1));
    await prisma.tobaccoReport.create({
      data: {
        tenantId: w.tenantId,
        periodYear: earlierStart.getUTCFullYear(),
        periodMonth: earlierStart.getUTCMonth() + 1,
        periodStart: earlierStart,
        periodEnd: new Date(MONTH_START.getTime() - 1),
        status: "FAILED",
        rows: [],
      },
    });
    await fileTobaccoMonth(w); // the later month is GENERATED

    await revert(w, id);

    const reversal = (await ledger(w)).find((r) => r.q === -10) as { effectiveAt: Date };
    expect(reversal.effectiveAt >= MONTH_END_EXCL).toBe(true);
  });

  // The DB does not force row order, so the uuid tiebreak on a createdAt tie is pinned here: after
  // the receive, the two receipt rows get fixed ids in each order, making the old per-line split a
  // deterministic red. (StockMovement has no inbound FKs; resolvedMovementId is a plain string.)
  it.each([
    ["5-row first", [5, 3]],
    ["3-row first", [3, 5]],
  ] as const)(
    "V5 (SA-808b item 3): a two-line, one-product bill reverts — %s on the uuid tiebreak",
    async (_label, qtyOrder) => {
      const w = await seedWorld(`v5-${qtyOrder[0]}`);
      const bill: any = await inTenant(w, () =>
        bills.create({
          supplierId: w.supplierId,
          billNumber: `B-846-V5-${qtyOrder[0]}`,
          billDate: BILL_DATE,
          items: [
            { productId: w.productId, description: "Widget", qty: 5, unitCost: 2 },
            { productId: w.productId, description: "Widget", qty: 3, unitCost: 3 },
          ],
        } as never),
      );
      await inTenant(w, () => bills.receive(bill.id, undefined, w.userId));
      const created = await prisma.stockMovement.findMany({ where: { productId: w.productId } });
      expect(created).toHaveLength(2);
      // One receive's rows tie on createdAt (CURRENT_TIMESTAMP = transaction start); pin the uuid order.
      expect(new Set(created.map((r) => r.createdAt.getTime())).size).toBe(1);
      // Distinct per case (ids are table-global): the last hex digit carries the case, then the rank.
      const fixed = [1, 2].map((rank) => `00000000-0000-4000-8000-0000000000${qtyOrder[0]}${rank}`);
      for (const [i, q] of qtyOrder.entries()) {
        const row = created.find((r) => Number(r.quantity) === q) as (typeof created)[number];
        await prisma.$executeRaw`UPDATE "StockMovement" SET id = ${fixed[i]} WHERE id = ${row.id}`;
      }
      const pinned = await ledger(w);
      expect(pinned.map((r) => r.q)).toEqual([...qtyOrder]);

      await revert(w, bill.id);

      const rows = await ledger(w);
      expect(rows.map((r) => r.q).sort((a, b) => a - b)).toEqual(
        [-5, -3, 3, 5].sort((a, b) => a - b),
      );
      expect(await counter(w)).toBe(0);
    },
  );
});
