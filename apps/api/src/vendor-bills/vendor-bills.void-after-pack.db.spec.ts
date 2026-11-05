/**
 * SA-1093 Rule 2, W-867 (real Postgres, throwaway `qa-*` tenants): a bill's void after a Boxes answer takes out everything
 * the bill brought in, in today's pieces. Rows V-1 to V-13. With factor 1 the void writes what it wrote before.
 *
 * Collected only by `jest.db.config.js`; `requireLocalDatabaseUrl()` refuses any non-local host.
 */
import { MovementType } from "@prisma/client";
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import {
  describeDb,
  requireLocalDatabaseUrl,
  waitForBlockedSession,
} from "../common/testing/db-spec";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { ProductAliasService } from "../import/product-alias.service";
import { foldLedger } from "../inventory/fold-ledger";
import { InventoryService } from "../inventory/inventory.service";
import { applyStockMovements } from "../inventory/stock-movements";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { applyPackIntroduction } from "../products/pack-intro-apply";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { StorageService } from "../storage/storage.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { VendorBillsService } from "./vendor-bills.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;

const today = new Date();
const BILL_Y = today.getUTCMonth() === 0 ? today.getUTCFullYear() - 1 : today.getUTCFullYear();
const BILL_M = today.getUTCMonth() === 0 ? 12 : today.getUTCMonth();
const BILL_DATE = `${BILL_Y}-${String(BILL_M).padStart(2, "0")}-15`;
const MONTH_START = new Date(Date.UTC(BILL_Y, BILL_M - 1, 1));
const MONTH_END_EXCL = new Date(Date.UTC(BILL_Y, BILL_M, 1));

describeDb("SA-1093: a bill's void after a Boxes answer", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let bills: VendorBillsService;
  let inventory: InventoryService;
  const tenantIds: string[] = [];

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
            prepareAiCall: jest.fn().mockResolvedValue({
              key: null,
              source: "routeflow",
              model: "",
              tenantId: "test-tenant",
            }),
            requireAiTenant: jest.fn(),
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
    inventory = module.get(InventoryService);
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        const vb = await prisma.vendorBill.findMany({ where: { tenantId }, select: { id: true } });
        await prisma.vendorBillItem.deleteMany({
          where: { vendorBillId: { in: vb.map((b) => b.id) } },
        });
        await prisma.vendorBill.deleteMany({ where: { tenantId } });
        await prisma.auditLog.deleteMany({ where: { tenantId } });
        await prisma.tobaccoReport.deleteMany({ where: { tenantId } });
        await prisma.stockLot.deleteMany({ where: { tenantId } });
        await prisma.stockMovement.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.supplier.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      })().catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`void-after-pack cleanup failed for tenant ${tenantId}:`, e);
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

  async function seedWorld(label: string, product: Record<string, unknown> = {}): Promise<World> {
    seq += 1;
    const slug = assertTestTenant(
      `qa-voidpack-${RUN}-${seq}-${label}`,
      "void-after-pack.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: slug } });
    tenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "OPERATOR",
        tenantId: tenant.id,
      },
    });
    const supplier = await prisma.supplier.create({
      data: { name: `Acme ${slug}`, tenantId: tenant.id },
    });
    const p = await prisma.product.create({
      data: {
        name: `Widget ${slug}`,
        unit: "ea",
        pricePerUnit: 10,
        currentStock: 0,
        costingMethod: "AVCO",
        tenantId: tenant.id,
        ...product,
      } as any,
    });
    return { tenantId: tenant.id, userId: user.id, supplierId: supplier.id, productId: p.id };
  }

  const inTenant = <T>(w: World, fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);

  async function createBill(w: World, qty: number, unitCost: number, date = BILL_DATE) {
    const bill: any = await inTenant(w, () =>
      bills.create({
        supplierId: w.supplierId,
        billDate: date,
        items: [{ productId: w.productId, description: "Widget", qty, unitCost }],
      } as never),
    );
    return { id: bill.id as string, billNumber: bill.billNumber as string };
  }
  async function receivedBill(w: World, qty: number, unitCost: number, date = BILL_DATE) {
    const bill = await createBill(w, qty, unitCost, date);
    await inTenant(w, () => bills.receive(bill.id, undefined, w.userId) as Promise<unknown>);
    return bill;
  }
  /** A legacy received bill: the counter and the lot hold the stock, but no PURCHASE row exists. */
  async function legacyReceivedBill(w: World, qty: number, lots = 1) {
    const bill = await createBill(w, qty, 2);
    await prisma.vendorBill.update({
      where: { id: bill.id },
      data: {
        status: "RECEIVED",
        receivedDate: new Date(`${BILL_DATE}T12:00:00.000Z`),
        items: { updateMany: { where: {}, data: { qtyReceived: qty } } },
      },
    });
    for (let i = 0; i < lots; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.stockLot.create({
        data: {
          tenantId: w.tenantId,
          productId: w.productId,
          reference: bill.billNumber,
          qty,
          remainingQty: qty,
          unitCost: 2,
          purchaseDate: new Date(`${BILL_DATE}T00:00:00.000Z`),
        },
      });
    }
    await prisma.product.update({
      where: { id: w.productId },
      data: { currentStock: qty, averageCost: 2 },
    });
    return bill;
  }
  const answer = (
    w: World,
    to: number,
    reading: "box" | "piece" = "box",
    from: number | null = null,
    whileOpen?: () => Promise<void>,
  ) =>
    inTenant(w, () =>
      prisma.tenantTransaction(async (tx) => {
        const data: Record<string, unknown> = { unitsPerBox: to };
        await applyPackIntroduction(tx as any, {
          tenantId: w.tenantId,
          productId: w.productId,
          from,
          to,
          reading,
          data,
          actorId: null,
        });
        await tx.product.update({ where: { id: w.productId }, data });
        await whileOpen?.();
      }),
    );
  const sell = (w: World, qty: number) =>
    inTenant(w, () =>
      prisma.tenantTransaction((tx) =>
        applyStockMovements(tx as any, w.tenantId, [
          {
            productId: w.productId,
            type: MovementType.SALE,
            quantity: -qty,
            average: "keep",
            reference: "acme-sale",
          },
        ]),
      ),
    );
  const voidIt = (w: World, id: string) =>
    inTenant(w, () => bills.voidBill(id, w.userId) as Promise<any>);

  const product = (w: World) => prisma.product.findUniqueOrThrow({ where: { id: w.productId } });
  const stock = async (w: World) => Number((await product(w)).currentStock);
  const average = async (w: World) => Number((await product(w)).averageCost);
  const lots = (w: World) =>
    prisma.stockLot.findMany({ where: { productId: w.productId }, orderBy: { qty: "asc" } });
  const movements = (w: World, reference: string) =>
    prisma.stockMovement.findMany({
      where: { productId: w.productId, reference },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  /** The rows the void wrote: everything carrying the bill number but the receipt itself. */
  const voidRows = async (w: World, billNumber: string) =>
    (await movements(w, billNumber))
      .filter((m) => !(m.type === MovementType.PURCHASE && Number(m.quantity) > 0))
      .map((m) => [m.type, Number(m.quantity), m.unitCost == null ? null : Number(m.unitCost)]);
  const replay = (w: World) =>
    inTenant(w, () =>
      prisma.tenantTransaction((tx) =>
        inventory.recomputeProductInTx(tx, w.productId, {
          throwOnGap: false,
          trigger: "spec",
          performedById: null,
        }),
      ),
    );
  const foldOf = async (w: World) => {
    const rows = await prisma.stockMovement.findMany({
      where: { productId: w.productId },
      orderBy: [{ effectiveAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    return foldLedger(
      rows.map((m) => ({
        type: m.type,
        quantity: m.quantity,
        unitCost: m.unitCost,
        reference: m.reference,
      })),
      { isStandard: false, averageCost: null },
    );
  };

  /** Case A: bill 10 @ 2, Boxes x24. */
  async function caseA(label: string) {
    const w = await seedWorld(label);
    const bill = await receivedBill(w, 10, 2);
    await answer(w, 24);
    return { w, bill };
  }
  /** Case B: 5 @ 1 on hand, bill 10 @ 2, Boxes x24. */
  async function caseB(label: string) {
    const w = await seedWorld(label);
    await receivedBill(w, 5, 1);
    const bill = await receivedBill(w, 10, 2);
    await answer(w, 24);
    return { w, bill };
  }

  it("V-1: case A goes 240 to 0, the lot goes, and the rows are the pair, the remainder and the cost", async () => {
    const { w, bill } = await caseA("v1");
    expect(await stock(w)).toBe(240);

    const out = await voidIt(w, bill.id);

    expect(out.status).toBe("VOID");
    expect(await stock(w)).toBe(0);
    expect(await average(w)).toBe(0.0833);
    expect(await lots(w)).toHaveLength(0);
    expect(await voidRows(w, bill.billNumber)).toEqual([
      [MovementType.PURCHASE, -10, 2],
      [MovementType.ADJUSTMENT, -230, null],
      [MovementType.COST_BASIS, 0, 0.0833],
    ]);
  });

  it("V-2: case B goes to 120 at 0.0415, and the other bill's lot is untouched", async () => {
    const { w, bill } = await caseB("v2");
    expect(await stock(w)).toBe(360);

    await voidIt(w, bill.id);

    expect(await stock(w)).toBe(120);
    expect(await average(w)).toBe(0.0415);
    const left = await lots(w);
    expect(left.map((l) => [Number(l.qty), Number(l.remainingQty), Number(l.unitCost)])).toEqual([
      [120, 120, 0.0417],
    ]);
  });

  it("V-1 (SA-1093 G5): a void that arrives while the answer is open waits for it: 240 to 0", async () => {
    const w = await seedWorld("v1open");
    const bill = await receivedBill(w, 10, 2);

    let voiding: Promise<unknown> | undefined;
    await answer(w, 24, "box", null, async () => {
      voiding = voidIt(w, bill.id);
      await waitForBlockedSession(prisma);
    });
    await voiding;

    expect(await stock(w)).toBe(0);
    expect(await voidRows(w, bill.billNumber)).toEqual([
      [MovementType.PURCHASE, -10, 2],
      [MovementType.ADJUSTMENT, -230, null],
      [MovementType.COST_BASIS, 0, 0.0833],
    ]);
  });

  it("V-3: case A with 4 sold before the pack goes to -96", async () => {
    const w = await seedWorld("v3");
    const bill = await receivedBill(w, 10, 2);
    await sell(w, 4);
    await answer(w, 24);

    await voidIt(w, bill.id);

    expect(await stock(w)).toBe(-96);
    expect(await average(w)).toBe(0.0833);
  });

  it("V-4: case B with 48 pieces sold after the pack goes to 72 at 0.023", async () => {
    const { w, bill } = await caseB("v4");
    await sell(w, 48);

    await voidIt(w, bill.id);

    expect(await stock(w)).toBe(72);
    expect(await average(w)).toBe(0.023);
  });

  it.each([
    ["no pack", null],
    ["a Pieces answer", "piece"],
  ] as const)("V-5: %s writes exactly one pair row, and nothing more", async (name, reading) => {
    const w = await seedWorld(`v5${reading ?? "none"}`);
    const bill = await receivedBill(w, 10, 2);
    if (reading) await answer(w, 24, reading);

    await voidIt(w, bill.id);

    expect(await stock(w)).toBe(0);
    expect(await voidRows(w, bill.billNumber)).toEqual([[MovementType.PURCHASE, -10, 2]]);
  });

  it("V-6: a bill received after Boxes and backdated before it takes out its own 10, one pair row", async () => {
    const w = await seedWorld("v6");
    await receivedBill(w, 1, 24, BILL_DATE);
    await answer(w, 24);
    const earlier = new Date(Date.UTC(BILL_Y, BILL_M - 2, 15)).toISOString().slice(0, 10);
    const bill = await receivedBill(w, 10, 2, earlier);
    expect(await stock(w)).toBe(34);

    await voidIt(w, bill.id);

    expect(await stock(w)).toBe(24);
    expect(await voidRows(w, bill.billNumber)).toEqual([[MovementType.PURCHASE, -10, 2]]);
  });

  it("V-7: x3, the pack cleared, x8 gives factor 24, and the lot is found by the two-step shape", async () => {
    const w = await seedWorld("v7");
    const bill = await receivedBill(w, 10, 2.0003);
    await answer(w, 3);
    await prisma.product.update({ where: { id: w.productId }, data: { unitsPerBox: null } });
    await answer(w, 8);
    expect(await stock(w)).toBe(240);
    // 2.0003 / 3 / 8 rounds to 0.0834 and a single / 24 to 0.0833, so a single division wouldn't find this lot.
    expect((await lots(w)).map((l) => Number(l.unitCost))).toEqual([0.0834]);

    await voidIt(w, bill.id);

    expect(await stock(w)).toBe(0);
    expect(await lots(w)).toHaveLength(0);
    expect(await voidRows(w, bill.billNumber)).toEqual([
      [MovementType.PURCHASE, -10, 2.0003],
      [MovementType.ADJUSTMENT, -230, null],
      [MovementType.COST_BASIS, 0, 0.0834],
    ]);
  });

  it("V-8: a STANDARD product: stock right, no cost row, average untouched", async () => {
    const w = await seedWorld("v8", {
      costingMethod: "STANDARD",
      standardCost: "2.4000",
      averageCost: "2.4000",
    });
    const bill = await receivedBill(w, 10, 2);
    await answer(w, 24);
    const before = await average(w);

    await voidIt(w, bill.id);

    expect(await stock(w)).toBe(0);
    expect(await average(w)).toBe(before);
    expect(await voidRows(w, bill.billNumber)).toEqual([
      [MovementType.PURCHASE, -10, 2],
      [MovementType.ADJUSTMENT, -230, null],
    ]);
  });

  describe("V-9: a regulated product's filing", () => {
    const inMonth = (d: Date) => d >= MONTH_START && d < MONTH_END_EXCL;
    /** What a filing sums for this bill: signed PURCHASE rows, quantity and quantity x unit cost. */
    const filed = async (w: World, billNumber: string) => {
      const rows = (await movements(w, billNumber)).filter((m) => m.type === MovementType.PURCHASE);
      return [
        rows.reduce((t, m) => t + Number(m.quantity), 0),
        rows.reduce((t, m) => t + Number(m.quantity) * Number(m.unitCost), 0),
      ];
    };
    const ledgerSum = async (w: World) =>
      (await prisma.stockMovement.findMany({ where: { productId: w.productId } })).reduce(
        (t, m) => t + Number(m.quantity),
        0,
      );

    it("open period: the bill's filed quantity and value net 0 in its month, and ending stock is right", async () => {
      const w = await seedWorld("v9open", { isTobacco: true });
      const bill = await receivedBill(w, 10, 2);
      await answer(w, 24);

      await voidIt(w, bill.id);

      expect(await filed(w, bill.billNumber)).toEqual([0, 0]);
      const pair = (await movements(w, bill.billNumber)).find(
        (m) => m.type === MovementType.PURCHASE && Number(m.quantity) < 0,
      )!;
      expect(inMonth(pair.effectiveAt)).toBe(true);
      expect(await stock(w)).toBe(0);
      expect(await ledgerSum(w)).toBe(0);
    });

    it("filed period: the pair is dated now and says so; the bill's total still nets 0, ending stock is right", async () => {
      const w = await seedWorld("v9filed", { isTobacco: true });
      const bill = await receivedBill(w, 10, 2);
      await answer(w, 24);
      await prisma.tobaccoReport.create({
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

      await voidIt(w, bill.id);

      expect(await filed(w, bill.billNumber)).toEqual([0, 0]);
      const rows = await movements(w, bill.billNumber);
      const pair = rows.find((m) => m.type === MovementType.PURCHASE && Number(m.quantity) < 0)!;
      expect(inMonth(pair.effectiveAt)).toBe(false);
      expect(pair.notes).toContain("(filed through ");
      for (const m of rows.filter((r) => r.type !== MovementType.PURCHASE)) {
        expect(inMonth(m.effectiveAt)).toBe(false);
      }
      expect(await stock(w)).toBe(0);
      expect(await ledgerSum(w)).toBe(0);
      expect(await average(w)).toBe(0.0833);
    });
  });

  it("V-10: a spent lot was never converted, so it's matched at its original shape", async () => {
    const w = await seedWorld("v10");
    const bill = await receivedBill(w, 10, 2);
    await prisma.stockLot.updateMany({
      where: { productId: w.productId },
      data: { remainingQty: 0 },
    });
    await answer(w, 24);

    const out = await voidIt(w, bill.id);

    const [lot] = await lots(w);
    expect([Number(lot.qty), Number(lot.remainingQty), Number(lot.unitCost)]).toEqual([10, 0, 2]);
    expect(lot.notes).toContain("(bill reversed;");
    expect(out.gapsDetected).toEqual([]);
  });

  it("V-11: two same-shape lots are left standing and named in the audit row", async () => {
    const w = await seedWorld("v11");
    const bill = await legacyReceivedBill(w, 10, 2);
    await answer(w, 24);
    const before = await lots(w);

    await voidIt(w, bill.id);

    const after = await lots(w);
    expect(after.map((l) => Number(l.remainingQty))).toEqual(
      before.map((l) => Number(l.remainingQty)),
    );
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        tenantId: w.tenantId,
        entityId: bill.id,
        action: "vendor-bill.void-without-receipt",
      },
    });
    const left = (audit.meta as { lotsLeft: { lotIds: string[] }[] }).lotsLeft;
    expect(left[0].lotIds.sort()).toEqual(before.map((l) => l.id).sort());
  });

  it("V-12: stock with no receipt row is taken out x24 at its cost / 24, and the void succeeds", async () => {
    const w = await seedWorld("v12");
    const bill = await legacyReceivedBill(w, 10);
    await answer(w, 24);
    expect(await stock(w)).toBe(240);

    const out = await voidIt(w, bill.id);

    expect(out.status).toBe("VOID");
    expect(await stock(w)).toBe(0);
    expect(await lots(w)).toHaveLength(0);
    expect(out.gapsDetected).toEqual([expect.objectContaining({ noReceiptQty: 240 })]);
    const [adjustment, ...rest] = await voidRows(w, bill.billNumber);
    expect(adjustment).toEqual([MovementType.ADJUSTMENT, -240, 0.0833]);
    expect(rest).toEqual([[MovementType.COST_BASIS, 0, 0.0833]]);
  });

  it.each([
    ["case A", caseA],
    ["case B", caseB],
  ] as const)(
    "V-13: a replay after the void of %s finds no gap and folds to the counter",
    async (name, make) => {
      const { w, bill } = await make(`v13${name.slice(-1)}`);
      await voidIt(w, bill.id);
      const counter = await stock(w);
      const avg = await average(w);

      const out = await replay(w);

      expect(out?.gapDetected).toBe(false);
      const fold = await foldOf(w);
      expect(Number(fold.stock)).toBe(counter);
      expect(Number(fold.avg)).toBe(avg);
      expect(await stock(w)).toBe(counter);
      expect(await average(w)).toBe(avg);
    },
  );

  it("Rule 1: an answer with no readable pack size throws, and nothing is written", async () => {
    const w = await seedWorld("unreadable");
    const bill = await receivedBill(w, 10, 2);
    await prisma.auditLog.create({
      data: {
        tenantId: w.tenantId,
        action: "product.pack_introduced",
        entityType: "Product",
        entityId: w.productId,
        meta: { reading: "box", to: "24" },
      },
    });
    const rows = await prisma.stockMovement.count({ where: { productId: w.productId } });

    await expect(voidIt(w, bill.id)).rejects.toThrow("no readable pack size");

    expect(await stock(w)).toBe(10);
    expect(await prisma.stockMovement.count({ where: { productId: w.productId } })).toBe(rows);
    const row = await prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(row.status).not.toBe("VOID");
  });

  describe("SA-1093 Rule 3: revert to draft", () => {
    const revert = (w: World, id: string) =>
      inTenant(w, () => bills.revertToDraft(id, w.userId) as Promise<any>);

    it("R-1: a bill received before the pack is refused 409, and nothing is written", async () => {
      const { w, bill } = await caseA("r1");
      const rowsBefore = await prisma.stockMovement.count({ where: { productId: w.productId } });

      const code = await revert(w, bill.id).then(
        () => "reverted",
        (e) => e?.response?.code,
      );

      expect(code).toBe("RECEIVED_BEFORE_PACK");
      expect(await stock(w)).toBe(240);
      expect(await prisma.stockMovement.count({ where: { productId: w.productId } })).toBe(
        rowsBefore,
      );
      const row = await prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } });
      expect(row.status).toBe("RECEIVED");
      expect(row.receivedDate).not.toBeNull();
      expect(await lots(w)).toHaveLength(1);
    });

    it.each([
      ["no pack", null],
      ["a Pieces answer", "piece"],
    ] as const)("R-2: %s reverts as it always did", async (_name, reading) => {
      const w = await seedWorld(`r2${reading ?? "none"}`);
      const bill = await receivedBill(w, 10, 2);
      if (reading) await answer(w, 24, reading);

      const out = await revert(w, bill.id);

      expect(out.status).toBe("DRAFT");
      expect(await stock(w)).toBe(0);
    });

    it("R-2: a bill received after the answer reverts too", async () => {
      const w = await seedWorld("r2after");
      await receivedBill(w, 1, 24);
      await answer(w, 24);
      const bill = await receivedBill(w, 10, 2);

      expect((await revert(w, bill.id)).status).toBe("DRAFT");
      expect(await stock(w)).toBe(24);
    });
  });
});
