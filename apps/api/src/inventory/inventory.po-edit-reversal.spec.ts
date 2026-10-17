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
const AUG_5 = new Date("2026-08-05T10:00:00.000Z");
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
    let rowSeq = 0;
    prisma.stockMovement.create.mockImplementation(async () => ({ id: `row-${++rowSeq}` }));
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

  // ── one re-post per reversed receipt (Opus MUST) ─────────────────────────
  describe("a PO received in two months re-posts each receipt in its own month", () => {
    const AUG_END = "2026-08-31T23:59:59.999Z";
    const receipts = () => [
      mv({ id: "mv-2", quantity: D(5), createdAt: SEPT_5, effectiveAt: SEPT_5 }),
      mv({ id: "mv-1", quantity: D(5), createdAt: AUG_5, effectiveAt: AUG_5 }),
    ];
    /** The report's ending stock: the counter minus every movement dated after the period. */
    const endingStock = (rows: any[], counter: number, periodEndExcl: Date) =>
      counter -
      rows
        .filter((r) => new Date(r.effectiveAt) >= periodEndExcl)
        .reduce((t, r) => t + Number(r.quantity), 0);

    beforeEach(() => {
      prisma.stockMovement.findMany.mockResolvedValue(receipts());
      prisma.stockLot.findMany.mockResolvedValue([
        { id: "lot-a", productId: "prod-1", qty: D(5), remainingQty: D(5), purchaseDate: AUG_5 },
        { id: "lot-b", productId: "prod-1", qty: D(5), remainingQty: D(5), purchaseDate: SEPT_5 },
      ]);
    });

    it("Aug 5 + Sep 5 edited in October: August 5, September 5, October 0 — and August's ending stock is right", async () => {
      await edit();
      const rows = written();
      expect(rows.filter((r) => Number(r.quantity) > 0).map((r) => r.quantity.toString())).toEqual([
        "5",
        "5",
      ]); // one re-post per reversed receipt, each at its own quantity
      const ledger = [...receipts(), ...rows];
      expect(purchases(ledger, "2026-08")).toBe(5);
      expect(purchases(ledger, "2026-09")).toBe(5);
      expect(purchases(ledger, "2026-10")).toBe(0);
      expect(endingStock(ledger, 10, new Date("2026-09-01T00:00:00.000Z"))).toBe(5);
      // lots stay as today: one lot for the line, the full quantity, at the earliest lot's date
      expect(prisma.stockLot.create).toHaveBeenCalledTimes(1);
      expect(prisma.stockLot.create.mock.calls[0][0].data.qty.toString()).toBe("10");
      expect(prisma.stockLot.create.mock.calls[0][0].data.purchaseDate).toEqual(AUG_5);
      // the counter moved by the whole line, once each way
      const incs = prisma.product.update.mock.calls
        .map((c: any) => c[0].data.currentStock)
        .map((c: any) => (c.increment ? `+${c.increment}` : `-${c.decrement}`));
      expect(incs).toEqual(["-10", "+5", "+5"]);
    });

    it("August filed, September open: August is unchanged, September 5, and the closed receipt's pair lands in October netting 0", async () => {
      markFiled("2026-08-01T00:00:00.000Z", AUG_END);
      await edit();
      const rows = written();
      const ledger = [...receipts(), ...rows];
      expect(purchases(ledger, "2026-08")).toBe(5); // what was filed
      expect(purchases(ledger, "2026-09")).toBe(5);
      expect(purchases(ledger, "2026-10")).toBe(0); // −5 + 5 for the closed receipt
      const augReversal = rows.find((r) => r.notes?.startsWith("PO edit reversal — reverses mv-1"));
      expect(augReversal.notes).toBe(
        "PO edit reversal — reverses mv-1 (filed through August 2026)",
      );
      expect(augReversal.effectiveAt.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
      const sepReversal = rows.find((r) => r.notes?.startsWith("PO edit reversal — reverses mv-2"));
      expect(sepReversal.notes).toBe("PO edit reversal — reverses mv-2");
      expect(sepReversal.effectiveAt).toEqual(SEPT_5);
      expect(endingStock(ledger, 10, new Date("2026-09-01T00:00:00.000Z"))).toBe(5);
    });

    it("one receipt split across two lines of the same product is re-posted in slices, each at the receipt's date", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue({
        id: "po-1",
        poNumber: PO_NUMBER,
        supplierId: "sup-1",
        status: "RECEIVED",
        items: [
          {
            id: "poi-1",
            productId: "prod-1",
            qtyOrdered: D(7),
            qtyReceived: D(7),
            unitCost: D(2),
            totalCost: D(14),
          },
          {
            id: "poi-2",
            productId: "prod-1",
            qtyOrdered: D(3),
            qtyReceived: D(3),
            unitCost: D(2),
            totalCost: D(6),
          },
        ],
      });
      await service.updatePurchaseOrder(
        "po-1",
        {
          reapplyInventory: true,
          items: [
            { id: "poi-1", productId: "prod-1", qtyOrdered: 7, unitCost: 3 },
            { id: "poi-2", productId: "prod-1", qtyOrdered: 3, unitCost: 4 },
          ],
        },
        "user-1",
      );
      const reposts = written().filter((r) => Number(r.quantity) > 0);
      expect(
        reposts.map(
          (r) => `${r.quantity}@${r.unitCost}:${r.effectiveAt.toISOString().slice(0, 7)}`,
        ),
      ).toEqual([
        "5@3:2026-08", // line 1 takes the August receipt …
        "2@3:2026-09", // … and 2 of September's
        "3@4:2026-09", // line 2 takes the rest
      ]);
      const ledger = [...receipts(), ...written()];
      expect(purchases(ledger, "2026-08")).toBe(5);
      expect(purchases(ledger, "2026-09")).toBe(5);
    });
  });

  // ── the replay's gap is reported, like the bill path ──────────────────────
  describe("gapsDetected", () => {
    it("returns the replay's gap on the PO response so the caller can flag it", async () => {
      prisma.stockMovement.count.mockResolvedValue(1);
      jest
        .spyOn(service, "recomputeProductInTx")
        .mockResolvedValue({ gapDetected: true, stockDrift: 3 } as any);
      const res: any = await edit();
      expect(res.gapsDetected).toEqual([{ productId: "prod-1", name: "Cigars", stockDrift: 3 }]);
    });
    it("is an empty list when nothing was replayed or no gap was found", async () => {
      const res: any = await edit();
      expect(res.gapsDetected).toEqual([]);
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
      // this edit's OWN rows (by id, not by a clock a concurrent commit can slip under) never count
      expect(where.id).toEqual({ notIn: ["row-1", "row-2"] });
      expect(where.createdAt).toBeUndefined();
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
