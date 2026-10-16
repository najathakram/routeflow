import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { pairedReceiptIds, poReversalOf } from "./bill-revert";
import { resolveSaleCost } from "./sale-movement";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";

/**
 * SA-808 §5 (B846 sibling): the PO-edit reversal. A re-apply used to write its compensation as an
 * ADJUSTMENT dated now, while the tobacco filing sums signed PURCHASE rows only — so an edited PO's
 * month counted the original receipt AND its re-post. The reversal is now a negative PURCHASE dated
 * at the receipt (or now, with a note, when that period is filed) and the re-post books beside it.
 * Mock-level; the real-ledger twin is inventory.po-edit-reversal.db.spec.ts.
 */

const D = (n: number | string) => new Prisma.Decimal(n);
const NOW = new Date("2026-10-16T12:00:00.000Z");
const SEPT_5 = new Date("2026-09-05T10:00:00.000Z");
const PO_NUMBER = "PO-2026-0001";

const tobacco = {
  id: "prod-1",
  name: "Cigars",
  kind: "SIMPLE",
  isTobacco: true,
  trackedCategoryId: null,
};

const mv = (o: Record<string, unknown> = {}) => ({
  id: "mv-1",
  productId: "prod-1",
  type: "PURCHASE",
  quantity: D(10),
  unitCost: D(2),
  supplierId: "sup-1",
  reference: PO_NUMBER,
  notes: null as string | null,
  createdAt: SEPT_5,
  effectiveAt: SEPT_5,
  ...o,
});

/** Signed PURCHASE quantity booked in `monthKey` (YYYY-MM) — what the tobacco report sums. */
const purchases = (rows: any[], monthKey: string) =>
  rows
    .filter(
      (r) => r.type === "PURCHASE" && new Date(r.effectiveAt).toISOString().startsWith(monthKey),
    )
    .reduce((t, r) => t + Number(r.quantity), 0);

describe("InventoryService.updatePurchaseOrder — reversal is a PURCHASE row (SA-808 §5)", () => {
  let service: InventoryService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    // Only Date is faked: the stock tx helpers use real timers/microtasks.
    jest.useFakeTimers({
      now: NOW,
      doNotFake: [
        "nextTick",
        "setImmediate",
        "clearImmediate",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "queueMicrotask",
        "performance",
        "hrtime",
      ],
    });
    prisma = createMockPrisma();
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({ ...prisma, $executeRaw: jest.fn().mockResolvedValue(0) }),
    );
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

    prisma.purchaseOrder.findUnique.mockResolvedValue({
      id: "po-1",
      poNumber: PO_NUMBER,
      supplierId: "sup-1",
      status: "RECEIVED",
      items: [
        {
          id: "poi-1",
          poId: "po-1",
          productId: "prod-1",
          qtyOrdered: D(10),
          qtyReceived: D(10),
          unitCost: D(2),
          totalCost: D(20),
          sku: null,
          packSize: null,
        },
      ],
    });
    prisma.purchaseOrder.update.mockResolvedValue({});
    prisma.purchaseOrder.findUniqueOrThrow.mockResolvedValue({ id: "po-1" });
    prisma.product.findMany.mockResolvedValue([tobacco]);
    prisma.product.findUnique.mockResolvedValue({
      id: "prod-1",
      name: "Cigars",
      currentStock: D(10),
      averageCost: D(2),
      costingMethod: "AVCO",
    });
    prisma.stockMovement.findMany.mockResolvedValue([mv()]);
    prisma.stockMovement.count.mockResolvedValue(0);
    prisma.stockLot.findMany.mockResolvedValue([
      { id: "lot-1", productId: "prod-1", qty: D(10), remainingQty: D(10), purchaseDate: SEPT_5 },
    ]);
  });

  afterEach(() => jest.useRealTimers());

  const edit = () =>
    service.updatePurchaseOrder(
      "po-1",
      {
        reapplyInventory: true,
        items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 3 }],
      },
      "user-1",
    );
  const written = () => prisma.stockMovement.create.mock.calls.map((c: any) => c[0].data);
  const markFiled = (periodStart: string, periodEnd: string) =>
    prisma.tobaccoReport.findFirst.mockResolvedValue({
      periodStart: new Date(periodStart),
      periodEnd: new Date(periodEnd),
    });

  // ── P1 ───────────────────────────────────────────────────────────────────
  it("P1: a September receipt edited in October nets in September — a −Q PURCHASE at the receipt's date, no ADJUSTMENT, nothing leaks into October", async () => {
    await edit();
    const [reversal, repost] = written();

    expect(reversal.type).toBe("PURCHASE");
    expect(reversal.quantity.toString()).toBe("-10");
    expect(reversal.unitCost.toString()).toBe("2"); // the ORIGINAL cost is what is reversed
    expect(reversal.supplierId).toBe("sup-1");
    expect(reversal.reference).toBe(PO_NUMBER);
    expect(reversal.notes).toBe("PO edit reversal — reverses mv-1"); // the pairing the readers parse
    expect(reversal.effectiveAt).toEqual(SEPT_5);
    expect(repost.type).toBe("PURCHASE");
    expect(repost.quantity.toString()).toBe("10");
    expect(repost.unitCost.toString()).toBe("3");
    expect(repost.effectiveAt).toEqual(SEPT_5); // beside its reversal, in the receipt's month
    expect(repost.createdAt.getTime()).toBeGreaterThan(reversal.createdAt.getTime());
    expect(written().some((r: any) => r.type === "ADJUSTMENT")).toBe(false);

    // What the September / October tobacco reports would sum, original included.
    const ledger = [mv(), ...written()];
    expect(purchases(ledger, "2026-09")).toBe(10); // one receipt of 10, edited cost — not 10 + 10
    expect(purchases(ledger, "2026-10")).toBe(0);
  });

  // ── P2 ───────────────────────────────────────────────────────────────────
  it("P2: September already filed — the reversal and the re-post book NOW with the filing named, and live September still equals the filing", async () => {
    markFiled("2026-09-01T00:00:00.000Z", "2026-09-30T23:59:59.999Z");
    await edit();
    const [reversal, repost] = written();

    expect(reversal.type).toBe("PURCHASE");
    expect(reversal.notes).toBe("PO edit reversal — reverses mv-1 (filed through September 2026)");
    expect(reversal.effectiveAt.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
    expect(reversal.effectiveAt.getTime()).toBeLessThan(NOW.getTime() + 1000);
    expect(reversal.effectiveAt).toEqual(reversal.createdAt);
    expect(repost.effectiveAt.getTime()).toBeGreaterThan(reversal.effectiveAt.getTime());
    expect(repost.effectiveAt.getTime()).toBeLessThan(NOW.getTime() + 1000);

    const ledger = [mv(), ...written()];
    expect(purchases(ledger, "2026-09")).toBe(10); // what was filed
    expect(purchases(ledger, "2026-10")).toBe(0); // −10 + 10 in the open month
  });

  it("P2: when TODAY is filed too, the edit is refused 409 STOCK_DATE_IN_FILED_PERIOD, naming the period, and writes nothing", async () => {
    markFiled("2026-10-01T00:00:00.000Z", "2026-10-31T23:59:59.999Z");
    const err: any = await edit().catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: API_ERROR_CODES.STOCK_DATE_IN_FILED_PERIOD,
      period: "October 2026",
      productId: "prod-1",
    });
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(prisma.stockLot.deleteMany).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it("a non-regulated product is never moved: filings elsewhere do not touch it (R6 guard)", async () => {
    prisma.product.findMany.mockResolvedValue([{ ...tobacco, isTobacco: false }]);
    markFiled("2026-09-01T00:00:00.000Z", "2026-09-30T23:59:59.999Z");
    await edit();
    const [reversal] = written();
    expect(reversal.effectiveAt).toEqual(SEPT_5);
    expect(reversal.notes).toBe("PO edit reversal — reverses mv-1");
  });

  // ── P3 ───────────────────────────────────────────────────────────────────
  describe("P3: pairing — a second edit reverses only what is unreversed", () => {
    const O = mv({ id: "mv-1" });
    const reversalRow = (type: string, o: Record<string, unknown> = {}) =>
      mv({
        id: "mv-2",
        type,
        quantity: D(-10),
        notes: "PO edit reversal — reverses mv-1",
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
        effectiveAt: type === "PURCHASE" ? SEPT_5 : new Date("2026-10-01T00:00:00.000Z"),
        ...o,
      });
    const repostRow = (o: Record<string, unknown> = {}) =>
      mv({
        id: "mv-3",
        unitCost: D(3),
        createdAt: new Date("2026-10-01T00:00:01.000Z"),
        effectiveAt: SEPT_5,
        ...o,
      });

    it("after a new-type edit (PURCHASE −10) only the re-post is live", async () => {
      prisma.stockMovement.findMany.mockResolvedValue([repostRow(), reversalRow("PURCHASE"), O]);
      await edit();
      const [reversal] = written();
      expect(reversal.notes).toBe("PO edit reversal — reverses mv-3");
      expect(reversal.quantity.toString()).toBe("-10");
      expect(reversal.unitCost.toString()).toBe("3");
      expect(written()).toHaveLength(2); // one reversal + one re-post, nothing else touched
      expect(prisma.product.update.mock.calls[0][0].data.currentStock.decrement.toString()).toBe(
        "10",
      );
    });

    it("a LEGACY ADJUSTMENT reversal still pairs — no double reversal of the receipt it undid", async () => {
      prisma.stockMovement.findMany.mockResolvedValue([
        repostRow({ effectiveAt: new Date("2026-10-01T00:00:01.000Z") }),
        reversalRow("ADJUSTMENT"),
        O,
      ]);
      await edit();
      const [reversal] = written();
      expect(reversal.notes).toBe("PO edit reversal — reverses mv-3");
      expect(written()).toHaveLength(2);
    });

    it("a legacy pair and a new pair in one history: only the last re-post is live", async () => {
      prisma.stockMovement.findMany.mockResolvedValue([
        mv({
          id: "mv-5",
          unitCost: D(4),
          createdAt: new Date("2026-10-05T00:00:01.000Z"),
          effectiveAt: SEPT_5,
        }),
        mv({
          id: "mv-4",
          type: "PURCHASE",
          quantity: D(-10),
          notes: "PO edit reversal — reverses mv-3",
          createdAt: new Date("2026-10-05T00:00:00.000Z"),
          effectiveAt: SEPT_5,
        }),
        repostRow({ effectiveAt: new Date("2026-10-01T00:00:01.000Z") }),
        reversalRow("ADJUSTMENT"),
        O,
      ]);
      await edit();
      expect(written()[0].notes).toBe("PO edit reversal — reverses mv-5");
      expect(written()).toHaveLength(2);
    });

    it("poReversalOf pairs only a NEGATIVE PURCHASE/ADJUSTMENT row — a positive purchase quoting the text is not a reversal", () => {
      const note = "PO edit reversal — reverses mv-1";
      expect(poReversalOf({ type: "PURCHASE", quantity: D(-10), notes: note })).toBe("mv-1");
      expect(poReversalOf({ type: "ADJUSTMENT", quantity: D(-10), notes: note })).toBe("mv-1");
      expect(poReversalOf({ type: "PURCHASE", quantity: D(10), notes: note })).toBeNull();
      expect(poReversalOf({ type: "SALE", quantity: D(-10), notes: note })).toBeNull();
      expect(
        poReversalOf({
          type: "PURCHASE",
          quantity: D(-10),
          notes: `${note} (filed through May 2026)`,
        }),
      ).toBe("mv-1");
    });

    it("the PO page reads a PURCHASE reversal as a REVERSAL of its receipt, never as a receipt", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue({
        id: "po-1",
        poNumber: PO_NUMBER,
        supplierId: "sup-1",
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        items: [
          {
            productId: "prod-1",
            qtyReceived: D(10),
            product: { id: "prod-1", name: "Cigars", unit: "pc", unitsPerBox: 1 },
          },
        ],
      });
      prisma.stockMovement.findMany.mockResolvedValue([repostRow(), reversalRow("PURCHASE"), O]);
      const res: any = await service.getPurchaseOrder("po-1");
      expect(res.receipts.map((r: any) => `${r.kind}:${r.id}`).sort()).toEqual([
        "RECEIPT:mv-1",
        "RECEIPT:mv-3",
        "REVERSAL:mv-2",
      ]);
      expect(res.receipts.find((r: any) => r.id === "mv-2")).toMatchObject({
        kind: "REVERSAL",
        reversesId: "mv-1",
      });
    });
  });

  // ── replay ───────────────────────────────────────────────────────────────
  describe("replay after a backdated write", () => {
    it("replays the product when rows other than this edit's own sort after the receipt", async () => {
      prisma.stockMovement.count.mockResolvedValue(2);
      const replay = jest
        .spyOn(service, "recomputeProductInTx")
        .mockResolvedValue({ gapDetected: false } as any);
      await edit();
      expect(replay).toHaveBeenCalledWith(
        expect.anything(),
        "prod-1",
        expect.objectContaining({ throwOnGap: false, trigger: "PO:po-1" }),
      );
      const where = prisma.stockMovement.count.mock.calls[0][0].where;
      expect(where.productId).toBe("prod-1");
      expect(where.effectiveAt).toEqual({ gt: SEPT_5 });
      expect(where.createdAt.lt).toBeInstanceOf(Date); // this edit's own rows never count as "newer"
    });

    it("does not replay when nothing else sits after the receipt", async () => {
      const replay = jest.spyOn(service, "recomputeProductInTx");
      await edit();
      expect(replay).not.toHaveBeenCalled();
    });
  });
});

// ── P4 ─────────────────────────────────────────────────────────────────────
describe("P4: the shared pairing rule (LAST_COST / cost history) recognises PO-edit reversal pairs", () => {
  it("pairedReceiptIds returns the receipt ids a PO reversal undid — PURCHASE-typed and legacy ADJUSTMENT — and ignores a positive decoy", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { type: "PURCHASE", quantity: D(-10), notes: "PO edit reversal — reverses m2" },
      {
        type: "ADJUSTMENT",
        quantity: D(-4),
        notes: "PO edit reversal — reverses m0 (filed through May 2026)",
      },
      { type: "PURCHASE", quantity: D(5), notes: "PO edit reversal — reverses m9" },
      { type: "PURCHASE", quantity: D(-3), notes: "BILL_REVERTED — reverses m7" },
    ]);
    const ids = await pairedReceiptIds({ stockMovement: { findMany } }, "prod-1");
    expect(ids).toEqual(["m2", "m0", "m7"]);
    const where = findMany.mock.calls[0][0].where;
    expect(where.productId).toBe("prod-1");
    expect(JSON.stringify(where)).toContain("PO edit reversal — reverses ");
    expect(JSON.stringify(where)).toContain("BILL_REVERTED — reverses ");
  });

  it("LAST_COST ignores the reversed pair: the receipt a PO reversal paired is excluded from the last-purchase pick", async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce({ costingMethod: "LAST_COST", averageCost: D(2), standardCost: null })
      .mockResolvedValueOnce({ unitCost: D(4) });
    const findMany = jest
      .fn()
      .mockResolvedValue([
        { type: "PURCHASE", quantity: D(-10), notes: "PO edit reversal — reverses m2" },
      ]);
    const tx: any = { product: { findFirst }, stockMovement: { findFirst, findMany } };
    const res = await resolveSaleCost(tx, "prod-1", D(1));
    expect(findFirst.mock.calls[1][0].where).toEqual({
      productId: "prod-1",
      type: "PURCHASE",
      quantity: { gt: 0 },
      id: { notIn: ["m2"] },
    });
    expect(res.unitCost.toString()).toBe("4");
  });
});
