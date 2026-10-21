import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { StorageService } from "../storage/storage.service";
import { InventoryService } from "../inventory/inventory.service";
import { ProductAliasService } from "../import/product-alias.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { BILL_REVERTED_NOTE, billReceiptNote, pairedReceiptIds } from "../inventory/bill-revert";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * B846 — revertToDraft must APPEND a signed PURCHASE row per receipt row instead of deleting the
 * ledger history (B562 / SA-136: nothing deletes a StockMovement). Runs the real service against a
 * small stateful in-memory ledger, so each assertion is on the ledger's end state, not on a call.
 * The DB twin is `vendor-bills.revert-appends.db.spec.ts`.
 */
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn(() => ({ messages: { create: jest.fn() } })),
}));
jest.mock("sharp", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    rotate: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: jest.fn(),
  })),
}));

const D = (n: number | string) => new Prisma.Decimal(n);
const BILL_DATE = new Date("2026-09-15T00:00:00.000Z");
const NOW = new Date("2026-10-16T12:00:00.000Z");
/** The bill date of the scenario under test; reset to September 15 before every test. */
let billDate = BILL_DATE;

type Row = Record<string, any>;

/** A tiny where-matcher: primitives, Decimal/Date compares, { gt, lt, in, startsWith, not }. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Row[]).some((w) => matches(row, w));
    if (key === "NOT") return !matches(row, cond as Row);
    const v = row[key];
    if (cond === undefined) return true;
    if (cond === null) return v == null;
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    if (Prisma.Decimal.isDecimal(cond)) return v != null && D(v).eq(cond);
    if (typeof cond === "object") {
      return Object.entries(cond as Row).every(([op, arg]) => {
        const cmp = (a: any, b: any) =>
          a instanceof Date ? a.getTime() - b.getTime() : D(a).cmp(b);
        if (op === "gt") return v != null && cmp(v, arg) > 0;
        if (op === "lt") return v != null && cmp(v, arg) < 0;
        if (op === "gte") return v != null && cmp(v, arg) >= 0;
        if (op === "in") return (arg as unknown[]).includes(v);
        if (op === "notIn") return !(arg as unknown[]).includes(v);
        if (op === "startsWith") return typeof v === "string" && v.startsWith(arg as string);
        if (op === "equals") return v === arg;
        throw new Error(`fake ledger: unsupported operator ${op}`);
      });
    }
    return v === cond;
  });
}

interface Harness {
  service: VendorBillsService;
  prisma: ReturnType<typeof createMockPrisma>;
  rows: Row[];
  product: { currentStock: Prisma.Decimal; averageCost: Prisma.Decimal | null };
  lots: Row[];
  /** Σ quantity of the ledger rows matching `where`. */
  sum: (where?: Row) => Prisma.Decimal;
  /** Set what vendorBill.findUnique returns (the pre-tx read AND the in-tx re-read). */
  setBill: (b: Row) => void;
  /** The product's regulated flags, as documentStockDate reads them. */
  flags: { isTobacco: boolean; trackedCategoryId: string | null };
  /** Filed periods the fake filing tables answer with. */
  tobaccoReports: Row[];
  regulatedFilings: Row[];
  inventory: { recomputeProductInTx: jest.Mock };
}

async function harness(): Promise<Harness> {
  const prisma = createMockPrisma();
  const rows: Row[] = [];
  const lots: Row[] = [];
  const product = { currentStock: D(0), averageCost: null as Prisma.Decimal | null };
  let seq = 0;
  let clock = NOW.getTime();

  prisma.stockMovement.create.mockImplementation(async ({ data }: any) => {
    const row = { id: `mv-${++seq}`, createdAt: new Date((clock += 1000)), ...data };
    rows.push(row);
    return row;
  });
  prisma.stockMovement.findMany.mockImplementation(async ({ where }: any = {}) =>
    rows.filter((r) => matches(r, where)),
  );
  prisma.stockMovement.count.mockImplementation(
    async ({ where }: any = {}) => rows.filter((r) => matches(r, where)).length,
  );
  prisma.stockMovement.deleteMany.mockImplementation(async ({ where }: any = {}) => {
    let n = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (matches(rows[i], where)) {
        rows.splice(i, 1);
        n++;
      }
    }
    return { count: n };
  });
  prisma.product.findFirst.mockImplementation(async () => ({
    name: "Widget",
    kind: "STOCKED",
    costingMethod: "AVCO",
    ...product,
  }));
  prisma.product.update.mockImplementation(async ({ data }: any) => {
    if (data.currentStock?.increment)
      product.currentStock = product.currentStock.add(data.currentStock.increment);
    if (data.currentStock?.decrement)
      product.currentStock = product.currentStock.sub(data.currentStock.decrement);
    if (data.averageCost !== undefined) product.averageCost = data.averageCost;
    return { ...product };
  });
  prisma.stockLot.create.mockImplementation(async ({ data }: any) => {
    lots.push({ id: `lot-${lots.length + 1}`, ...data });
    return data;
  });
  prisma.stockLot.findMany.mockImplementation(async ({ where }: any = {}) =>
    lots.filter((l) => matches(l, where)),
  );
  prisma.stockLot.delete.mockImplementation(async ({ where }: any) => {
    lots.splice(
      lots.findIndex((l) => l.id === where.id),
      1,
    );
  });
  const flags = { isTobacco: false, trackedCategoryId: null as string | null };
  const tobaccoReports: Row[] = [];
  const regulatedFilings: Row[] = [];
  prisma.product.findMany.mockImplementation(async () => [{ id: "prod-1", ...flags }]);
  const latest = (xs: Row[]) =>
    [...xs].sort((x, y) => y.periodEnd.getTime() - x.periodEnd.getTime())[0] ?? null;
  // A query that passes a period window (the pre-SA-808a predicate did) is answered through it.
  const inWindow = (r: Row, where: Row) =>
    (!where.periodStart?.lte || r.periodStart <= where.periodStart.lte) &&
    (!where.periodEnd?.gte || r.periodEnd >= where.periodEnd.gte) &&
    (!where.periodEnd?.gt || r.periodEnd > where.periodEnd.gt);
  prisma.tobaccoReport.findFirst.mockImplementation(async ({ where }: any) =>
    latest(tobaccoReports.filter((r) => r.status !== "FAILED" && inWindow(r, where))),
  );
  prisma.regulatedFiling.findFirst.mockImplementation(async ({ where }: any) =>
    latest(
      regulatedFilings.filter(
        (r) =>
          r.trackedCategoryId === where.trackedCategoryId &&
          where.status.in.includes(r.status) &&
          inWindow(r, where),
      ),
    ),
  );
  prisma.stockLot.update.mockImplementation(async ({ where, data }: any) => {
    Object.assign(lots.find((l) => l.id === where.id) as Row, data);
  });
  prisma.vendorBill.update.mockImplementation(async ({ data }: any) => ({ id: "bill-1", ...data }));

  let currentBill: Row = {};
  prisma.vendorBill.findUnique.mockImplementation(async () => currentBill);

  const inventory = {
    recomputeProductInTx: jest.fn(),
    lockProducts: jest.fn(),
    fireStockAlerts: jest.fn(),
  };
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      VendorBillsService,
      { provide: PrismaService, useValue: prisma },
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
      { provide: InventoryService, useValue: inventory },
      {
        provide: ProductAliasService,
        useValue: { resolveMany: jest.fn(), learn: jest.fn(), unlearn: jest.fn() },
      },
    ],
  }).compile();

  return {
    service: module.get(VendorBillsService),
    prisma,
    rows,
    product,
    lots,
    sum: (where) => rows.filter((r) => matches(r, where)).reduce((t, r) => t.add(r.quantity), D(0)),
    setBill: (b) => {
      currentBill = b;
    },
    flags,
    tobaccoReports,
    regulatedFilings,
    inventory,
  };
}

const item = (qty: number, unitCost = 2, over: Row = {}) => ({
  id: "item-1",
  productId: "prod-1",
  description: "Widget",
  qty: D(qty),
  unitCost: D(unitCost),
  packSize: null as number | null,
  qtyReceived: null as Prisma.Decimal | null,
  product: { id: "prod-1", name: "Widget", currentStock: D(0), averageCost: null },
  ...over,
});

const draftBill = (qty: number) => ({
  id: "bill-1",
  billNumber: "B-1",
  supplierId: "sup-1",
  status: "DRAFT",
  billDate,
  receivedDate: null as Date | null,
  purchaseOrderId: null,
  items: [item(qty)],
  supplier: { id: "sup-1", name: "Acme Supply" },
});

const receivedBill = (qty: number) => ({
  ...draftBill(qty),
  status: "RECEIVED",
  receivedDate: billDate,
  items: [item(qty, 2, { qtyReceived: D(qty) })],
});

async function receive(h: Harness, qty: number) {
  h.setBill(draftBill(qty));
  await h.service.receive("bill-1", undefined, "user-1");
}
async function revert(h: Harness, qty: number, userId = "user-2") {
  h.setBill(receivedBill(qty));
  await (h.service as any).revertToDraft("bill-1", userId);
}

/** A manual recordPurchase row whose free-text reference happens to equal the bill number. */
const manualPurchase = (h: Harness, qty: number) => {
  h.rows.push({
    id: "mv-manual",
    productId: "prod-1",
    type: "PURCHASE",
    quantity: D(qty),
    unitCost: D(1),
    supplierId: "sup-1",
    reference: "B-1",
    notes: "manual purchase",
    effectiveAt: new Date("2026-05-20T00:00:00.000Z"),
    createdAt: new Date("2026-05-20T00:00:00.000Z"),
  });
  h.product.currentStock = D(qty);
  h.product.averageCost = D(1);
};

const summary = (h: Harness) =>
  h.rows.map((r) => ({ q: Number(r.quantity), notes: r.notes as string }));

const inMonth = (r: Row, y: number, m: number) =>
  r.effectiveAt >= new Date(Date.UTC(y, m - 1, 1)) && r.effectiveAt < new Date(Date.UTC(y, m, 1));
/** The tobacco report's figure for a month: the SIGNED sum of its PURCHASE rows. */
const monthSum = (h: Harness, y: number, m: number) =>
  h.rows
    .filter((r) => inMonth(r, y, m))
    .reduce((t, r) => t.add(r.quantity), D(0))
    .toNumber();

const SEPT_FILED = {
  status: "GENERATED",
  periodStart: new Date("2026-09-01T00:00:00.000Z"),
  periodEnd: new Date("2026-09-30T23:59:59.999Z"),
};

describe("B846 / SA-808 — revertToDraft appends reversal rows and never deletes", () => {
  beforeEach(() => {
    billDate = BILL_DATE;
    jest.useFakeTimers({
      now: NOW,
      doNotFake: [
        "nextTick",
        "setImmediate",
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "clearImmediate",
        "queueMicrotask",
        "performance",
        "hrtime",
      ],
    });
  });
  afterEach(() => jest.useRealTimers());

  it("R1: a manual PURCHASE sharing the bill number survives; the receipt row gets a signed reversal", async () => {
    const h = await harness();
    manualPurchase(h, 5);
    h.lots.push({
      id: "lot-manual",
      productId: "prod-1",
      reference: "B-1",
      purchaseDate: new Date("2026-05-20T00:00:00.000Z"),
      qty: D(5),
      remainingQty: D(5),
      unitCost: D(1),
    });

    await receive(h, 10);
    await revert(h, 10);

    // Master deleted BOTH the receipt and the manual row (free-text reference match): 0 rows left,
    // counter 5, Σq 0 — the ledger gap this bug is about.
    expect(h.rows.map((r) => Number(r.quantity))).toEqual([5, 10, -10]);
    expect(h.prisma.stockMovement.deleteMany).not.toHaveBeenCalled();

    const [manual, receipt, reversal] = h.rows;
    expect(manual.id).toBe("mv-manual");
    expect(receipt.notes).toBe(billReceiptNote("B-1"));
    expect(reversal).toMatchObject({
      type: "PURCHASE",
      productId: "prod-1",
      supplierId: "sup-1",
      reference: "B-1",
      notes: `${BILL_REVERTED_NOTE}${receipt.id}`,
      performedById: "user-2",
    });
    expect(D(reversal.unitCost).eq(receipt.unitCost)).toBe(true);
    // Ruling (A): dated at the ORIGINAL receipt's accounting date.
    expect(reversal.effectiveAt).toEqual(receipt.effectiveAt);
    // Invariant: Σq == the counter, and the reversal's snapshot is the counter after the revert.
    expect(h.sum({ productId: "prod-1" }).eq(h.product.currentStock)).toBe(true);
    expect(D(reversal.stockAfter).eq(5)).toBe(true);
    // Average restored to the pre-bill 1 (reverseAverageCost's own 4dp rounding: 1.6667 -> 1.0001).
    expect(Number(h.product.averageCost)).toBeCloseTo(1, 3);
    expect(D(reversal.avgCostAfter).eq(h.product.averageCost as Prisma.Decimal)).toBe(true);
    // The manual purchase's lot is untouched; only the bill's own lot (full tuple) was removed.
    expect(h.lots.map((l) => l.id)).toEqual(["lot-manual"]);
  });

  it("R2: unfiled September bill — receive 10, revert, re-receive 8: September = 8, October untouched, history kept", async () => {
    const h = await harness();

    await receive(h, 10);
    await revert(h, 10);
    await receive(h, 8);

    expect(monthSum(h, 2026, 9)).toBe(8);
    expect(monthSum(h, 2026, 10)).toBe(0);
    expect(summary(h).map((r) => r.q)).toEqual([10, -10, 8]);
    expect(h.prisma.stockMovement.deleteMany).not.toHaveBeenCalled();
    expect(h.sum({ productId: "prod-1" }).eq(h.product.currentStock)).toBe(true);
  });

  it("R4: a second revert after the re-receive reverses only the re-received row", async () => {
    const h = await harness();
    await receive(h, 10);
    await revert(h, 10);
    await receive(h, 8);

    await revert(h, 8);

    expect(summary(h).map((r) => r.q)).toEqual([10, -10, 8, -8]);
    const [plus10, minus10, plus8, minus8] = h.rows;
    expect(minus10.notes).toBe(`${BILL_REVERTED_NOTE}${plus10.id}`);
    expect(minus8.notes).toBe(`${BILL_REVERTED_NOTE}${plus8.id}`);
    expect(h.sum({ productId: "prod-1" }).toNumber()).toBe(0);
    expect(h.product.currentStock.toNumber()).toBe(0);
    expect(h.lots).toHaveLength(0);
  });

  it("R3: a GENERATED September tobacco report — the revert on Oct 16 is dated now, September stays as filed", async () => {
    const h = await harness();
    h.flags.isTobacco = true;
    await receive(h, 10); // booked in September, before the report
    h.tobaccoReports.push(SEPT_FILED);

    await revert(h, 10);

    const [receipt, reversal] = h.rows;
    expect(reversal.effectiveAt).toEqual(NOW);
    expect(reversal.notes).toBe(
      `${BILL_REVERTED_NOTE}${receipt.id} (filed through September 2026)`,
    );
    expect(monthSum(h, 2026, 9)).toBe(10); // live September == what was filed
    expect(monthSum(h, 2026, 10)).toBe(-10);

    // Re-receive: the bill date is in the filed month, so the receipt moves to now too.
    await receive(h, 8);
    expect(monthSum(h, 2026, 9)).toBe(10);
    expect(monthSum(h, 2026, 10)).toBe(-2); // -Q + Q'
    expect(h.rows[2].effectiveAt).toEqual(NOW);
    expect(h.lots.map((l) => l.purchaseDate)).toEqual([NOW]);

    // ...and a second revert reverses only the re-receive (the original is already paired).
    await revert(h, 8);
    expect(summary(h).map((r) => r.q)).toEqual([10, -10, 8, -8]);
    expect(monthSum(h, 2026, 9)).toBe(10);
    expect(monthSum(h, 2026, 10)).toBe(-10);
  });

  it("R5: a LOCKED RegulatedFiling for the product's tracked category behaves as R3", async () => {
    const h = await harness();
    h.flags.trackedCategoryId = "cat-1";
    await receive(h, 10);
    h.regulatedFilings.push({
      trackedCategoryId: "cat-1",
      status: "LOCKED",
      cadence: "MONTHLY",
      periodKey: "2026-09",
      periodStart: new Date("2026-09-01T00:00:00.000Z"),
      periodEnd: new Date("2026-10-01T00:00:00.000Z"),
    });

    await revert(h, 10);

    expect(h.rows[1].effectiveAt).toEqual(NOW);
    expect(h.rows[1].notes).toContain("(filed through September 2026)");
    expect(monthSum(h, 2026, 9)).toBe(10);
    expect(monthSum(h, 2026, 10)).toBe(-10);
  });

  it("R6: a non-regulated product is always dated at the original, whatever filings exist", async () => {
    const h = await harness();
    h.tobaccoReports.push(SEPT_FILED);
    h.regulatedFilings.push({
      trackedCategoryId: "cat-1",
      status: "LOCKED",
      cadence: "MONTHLY",
      periodKey: "2026-09",
      periodStart: new Date("2026-09-01T00:00:00.000Z"),
      periodEnd: new Date("2026-10-01T00:00:00.000Z"),
    });
    await receive(h, 10);
    await revert(h, 10);

    expect(h.rows[1].effectiveAt).toEqual(h.rows[0].effectiveAt);
    expect(h.rows[1].notes).toBe(`${BILL_REVERTED_NOTE}${h.rows[0].id}`);
    expect(monthSum(h, 2026, 9)).toBe(0);
  });

  /** A month's live ending stock (tobacco report): the counter minus every movement after it. */
  const endingStockAfter = (h: Harness, y: number, m: number) =>
    h.product.currentStock
      .sub(
        h.rows
          .filter((r) => r.effectiveAt >= new Date(Date.UTC(y, m, 1)))
          .reduce((t, r) => t.add(r.quantity), D(0)),
      )
      .toNumber();
  const AUG_BILL = new Date("2026-08-15T00:00:00.000Z");
  const failed = (start: string, end: string) => ({
    status: "FAILED",
    periodStart: new Date(`${start}T00:00:00.000Z`),
    periodEnd: new Date(`${end}T23:59:59.999Z`),
  });

  it("R7: August unfiled, September filed — an August bill's revert is dated now, September's live ending stock equals what was filed", async () => {
    const h = await harness();
    h.flags.isTobacco = true;
    billDate = AUG_BILL;
    await receive(h, 10);
    h.tobaccoReports.push(SEPT_FILED);
    const filedEnding = endingStockAfter(h, 2026, 9); // 10, as September's report read it

    await revert(h, 10);

    expect(h.rows[1].effectiveAt).toEqual(NOW);
    expect(h.rows[1].notes).toContain("(filed through September 2026)");
    expect(monthSum(h, 2026, 8)).toBe(10);
    expect(endingStockAfter(h, 2026, 9)).toBe(filedEnding);
  });

  it("a FAILED month AFTER the latest filed one stays open: dated at the original", async () => {
    const h = await harness();
    h.flags.isTobacco = true;
    await receive(h, 10); // September 15
    h.tobaccoReports.push(failed("2026-09-01", "2026-09-30"));
    h.tobaccoReports.push({
      status: "GENERATED",
      periodStart: new Date("2026-08-01T00:00:00.000Z"),
      periodEnd: new Date("2026-08-31T23:59:59.999Z"),
    });

    await revert(h, 10);

    expect(h.rows[1].effectiveAt).toEqual(h.rows[0].effectiveAt);
    expect(h.rows[1].notes).not.toContain("filed through");
  });

  it("a FAILED month BEFORE the latest filed one is closed: dated now", async () => {
    const h = await harness();
    h.flags.isTobacco = true;
    billDate = AUG_BILL;
    await receive(h, 10);
    h.tobaccoReports.push(failed("2026-08-01", "2026-08-31"), SEPT_FILED);

    await revert(h, 10);

    expect(h.rows[1].effectiveAt).toEqual(NOW);
  });

  it("refuses 409 STOCK_DATE_IN_FILED_PERIOD when today is itself filed for the product", async () => {
    const h = await harness();
    h.flags.trackedCategoryId = "cat-1";
    await receive(h, 10);
    for (const [key, start, end] of [
      ["2026-09", "2026-09-01", "2026-10-01"],
      ["2026-10", "2026-10-01", "2026-11-01"],
    ]) {
      h.regulatedFilings.push({
        trackedCategoryId: "cat-1",
        status: "GENERATED",
        cadence: "MONTHLY",
        periodKey: key,
        periodStart: new Date(`${start}T00:00:00.000Z`),
        periodEnd: new Date(`${end}T00:00:00.000Z`),
      });
    }

    await expect(revert(h, 10)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.STOCK_DATE_IN_FILED_PERIOD, period: "October 2026" },
    });
    expect(h.rows).toHaveLength(1);
  });

  it("replays the product after a reversal that sits behind newer rows", async () => {
    const h = await harness();
    await receive(h, 10);
    h.rows.push({
      id: "mv-sale",
      productId: "prod-1",
      type: "SALE",
      quantity: D(-2),
      effectiveAt: new Date("2026-09-20T00:00:00.000Z"),
      createdAt: new Date("2026-09-20T00:00:00.000Z"),
    });
    h.product.currentStock = D(8);

    await revert(h, 10);

    expect(h.inventory.recomputeProductInTx).toHaveBeenCalledWith(
      expect.anything(),
      "prod-1",
      expect.objectContaining({ throwOnGap: false }),
    );
  });

  it("lots: a pre-2026-08-12 lot whose purchaseDate differs from the movement is reversed by the single-candidate fallback", async () => {
    const h = await harness();
    await receive(h, 10);
    // legacy: the lot was stamped with the bill date, the movement with the DB insert instant
    h.rows[0].effectiveAt = new Date("2026-09-16T08:00:00.000Z");

    await revert(h, 10);

    expect(h.lots).toHaveLength(0); // not left behind as a phantom FIFO lot
  });

  it("row 645 follow-up: a revert after a sale zeroes the lot and its note states the units really consumed (the lot never moves on a sale)", async () => {
    const h = await harness();
    await receive(h, 10);
    // #3487: a sale writes a SALE row and never lowers the lot's remainingQty
    h.rows.push({
      id: "mv-sale",
      productId: "prod-1",
      type: "SALE",
      quantity: D(-4),
      reference: "ORD-1",
      notes: null,
      effectiveAt: new Date("2026-09-20T00:00:00.000Z"),
      createdAt: new Date("2026-09-20T00:00:00.000Z"),
    });
    expect(h.lots[0].remainingQty.toString()).toBe("10");

    await revert(h, 10);

    expect(h.prisma.stockLot.delete).not.toHaveBeenCalled();
    expect(h.lots).toHaveLength(1);
    expect(h.lots[0].remainingQty).toBe(0);
    expect(h.lots[0].notes).toMatch(/\(bill reversed; 4 already consumed\)/);
  });

  it("lots: a bill that never made a lot reverts fine — movement reversed, no lot touched", async () => {
    const h = await harness();
    await receive(h, 10);
    h.lots.length = 0; // no lot was ever made for this receipt

    await revert(h, 10);

    expect(h.rows.map((r) => Number(r.quantity))).toEqual([10, -10]);
    expect(h.prisma.stockLot.delete).not.toHaveBeenCalled();
    expect(h.prisma.stockLot.update).not.toHaveBeenCalled();
  });

  /** Two legacy receipt rows of 5 @ 2 on one bill (partial top-ups), each with its own bill-dated lot. */
  const legacyReceipt = (h: Harness, n: number, lot = true) => {
    h.rows.push({
      id: `mv-legacy-${n}`,
      productId: "prod-1",
      type: "PURCHASE",
      quantity: D(5),
      unitCost: D(2),
      supplierId: "sup-1",
      reference: "B-1",
      notes: billReceiptNote("B-1"),
      effectiveAt: new Date(`2026-09-1${5 + n}T08:00:00.000Z`),
      createdAt: new Date(`2026-09-1${5 + n}T08:00:00.000Z`),
    });
    if (lot) {
      h.lots.push({
        id: `lot-legacy-${n}`,
        productId: "prod-1",
        reference: "B-1",
        purchaseDate: BILL_DATE,
        qty: D(5),
        remainingQty: D(5),
        unitCost: D(2),
      });
    }
  };

  it("lots: two equal legacy receipts on one bill reverse BOTH lots — no false 409", async () => {
    const h = await harness();
    legacyReceipt(h, 1);
    legacyReceipt(h, 2);
    h.product.currentStock = D(10);
    h.product.averageCost = D(2);

    await revert(h, 10);

    expect(h.lots).toHaveLength(0);
    expect(h.rows.map((r) => Number(r.quantity))).toEqual([5, 5, -5, -5]);
  });

  it("lots: a legacy receipt that never made a lot leaves a same-shaped MANUAL lot alone", async () => {
    const h = await harness();
    legacyReceipt(h, 1, false);
    h.rows[0].quantity = D(10);
    h.product.currentStock = D(10);
    h.product.averageCost = D(2);
    h.lots.push({
      id: "lot-manual",
      productId: "prod-1",
      reference: "B-1", // a manual purchase that happens to share the bill number
      purchaseDate: new Date("2026-05-20T00:00:00.000Z"),
      qty: D(10),
      remainingQty: D(10),
      unitCost: D(2),
    });

    await revert(h, 10);

    expect(h.lots.map((l) => l.id)).toEqual(["lot-manual"]);
  });

  it("lots: two fallback candidates are ambiguous — 409 and nothing written", async () => {
    const h = await harness();
    await receive(h, 10);
    h.rows[0].effectiveAt = new Date("2026-09-16T08:00:00.000Z");
    h.lots.push({ ...h.lots[0], id: "lot-twin" });

    await expect(revert(h, 10)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.INVENTORY_LEDGER_GAP },
    });
    expect(h.lots).toHaveLength(2);
  });

  it("surfaces the replay's gap the way receive does (gapsDetected), without aborting the revert", async () => {
    const h = await harness();
    await receive(h, 10);
    h.rows.push({
      id: "mv-sale",
      productId: "prod-1",
      type: "SALE",
      quantity: D(-2),
      effectiveAt: new Date("2026-09-20T00:00:00.000Z"),
      createdAt: new Date("2026-09-20T00:00:00.000Z"),
    });
    h.product.currentStock = D(8);
    h.inventory.recomputeProductInTx.mockResolvedValue({ gapDetected: true, stockDrift: 3 });
    h.setBill(receivedBill(10));

    const out: any = await h.service.revertToDraft("bill-1", "user-2");

    expect(out.gapsDetected).toEqual([{ productId: "prod-1", name: "Widget", stockDrift: 3 }]);
  });

  describe.each([
    ["receipt-row order", (rows: Row[]) => rows],
    ["reversed row order", (rows: Row[]) => [...rows].reverse()],
  ])(
    "V5 (SA-808b item 3): a two-line, one-product bill (5 @ $2 + 3 @ $3) — %s",
    (_label, order) => {
      const twoLines = (over: Row = {}) => ({
        ...draftBill(0),
        items: [
          item(5, 2, { id: "item-1", ...over }),
          item(3, 3, { id: "item-2", ...(over.qtyReceived ? { qtyReceived: D(3) } : {}) }),
        ],
      });
      it("reverts without refusing, whichever row comes first (one receive ties effectiveAt and createdAt)", async () => {
        const h = await harness();
        h.setBill(twoLines());
        await h.service.receive("bill-1", undefined, "user-1");
        expect(h.rows.map((r) => Number(r.quantity))).toEqual([5, 3]);
        // One receive's rows tie on (effectiveAt, createdAt): the DB falls back to the uuid. The
        // harness returns rows in array order, so reordering it stands in for either uuid order.
        const tied = h.rows[0].createdAt;
        for (const r of h.rows) r.createdAt = tied;
        h.rows.splice(0, h.rows.length, ...order([...h.rows]));
        const originals = new Map(h.rows.map((r) => [r.id as string, r]));

        h.setBill({
          ...twoLines({ qtyReceived: D(5) }),
          status: "RECEIVED",
          receivedDate: billDate,
        });
        await (h.service as any).revertToDraft("bill-1", "user-2");

        const reversals = h.rows.filter((r) => Number(r.quantity) < 0);
        expect(reversals).toHaveLength(2);
        for (const rev of reversals) {
          const original = originals.get(rev.notes.slice(BILL_REVERTED_NOTE.length)) as Row;
          expect(original).toBeDefined(); // each reversal names its own original...
          expect(D(rev.quantity).eq(D(original.quantity).negated())).toBe(true); // ...and mirrors it
          expect(D(rev.unitCost).eq(original.unitCost)).toBe(true);
        }
        expect(h.sum({ productId: "prod-1" }).toNumber()).toBe(0);
        expect(h.product.currentStock.toNumber()).toBe(0);
        // The snapshots walk the counter down to where the product ended (8 on hand at the start).
        let walk = 8;
        for (const rev of reversals) {
          walk += Number(rev.quantity);
          expect(D(rev.stockAfter).toNumber()).toBe(walk);
        }
        expect(walk).toBe(0);
        // Both receipt lots (5 @ $2 and 3 @ $3) are reversed or gone, none left as a phantom.
        expect(h.lots.filter((l) => D(l.remainingQty).gt(0))).toHaveLength(0);
      });
    },
  );

  it("L-207: refuses with a coded error when the receipt rows do not add up to the received qty", async () => {
    const h = await harness();
    await receive(h, 10);
    h.rows[0].quantity = D(7); // history no longer explains the line

    await expect(revert(h, 10)).rejects.toMatchObject({
      response: {
        code: API_ERROR_CODES.INVENTORY_LEDGER_GAP,
        message:
          "Widget's stock records for this bill don't match what was received, so it can't go back to draft. Void the bill and enter it again.",
      },
    });
    await expect(revert(h, 10)).rejects.toBeInstanceOf(ConflictException);
    expect(h.rows).toHaveLength(1); // nothing written
    expect(h.product.currentStock.toNumber()).toBe(10);
  });
});

// ─── voidBill: the same reversal, same helpers (SA-808 §5, "B846 sibling: void") ─────────────────
async function voidIt(h: Harness, qty: number, userId = "user-2") {
  h.setBill(receivedBill(qty));
  return (h.service as any).voidBill("bill-1", userId);
}
/** The tobacco report's purchases for a month: the signed sum of PURCHASE rows only. */
const purchaseSum = (h: Harness, y: number, m: number) =>
  h.rows
    .filter((r) => r.type === "PURCHASE" && inMonth(r, y, m))
    .reduce((t, r) => t.add(r.quantity), D(0))
    .toNumber();

describe("B846 sibling — voidBill appends a PURCHASE reversal (the tobacco filing sums PURCHASE)", () => {
  beforeEach(() => {
    billDate = BILL_DATE;
    jest.useFakeTimers({
      now: NOW,
      doNotFake: [
        "nextTick",
        "setImmediate",
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "clearImmediate",
        "queueMicrotask",
        "performance",
        "hrtime",
      ],
    });
  });
  afterEach(() => jest.useRealTimers());

  it("V1: a September bill voided in October — one -10 PURCHASE at the original date, September purchases 0, no ADJUSTMENT", async () => {
    const h = await harness();
    h.flags.isTobacco = true;
    await receive(h, 10);
    expect(purchaseSum(h, 2026, 9)).toBe(10);

    await voidIt(h, 10);

    expect(h.rows.filter((r) => r.type === "ADJUSTMENT")).toHaveLength(0);
    expect(h.rows).toHaveLength(2);
    const [receipt, reversal] = h.rows;
    expect(reversal).toMatchObject({
      type: "PURCHASE",
      reference: "B-1",
      supplierId: "sup-1",
      notes: `${BILL_REVERTED_NOTE}${receipt.id}`,
      performedById: "user-2",
    });
    expect(D(reversal.quantity).eq(-10)).toBe(true);
    expect(D(reversal.unitCost).eq(receipt.unitCost)).toBe(true);
    expect(reversal.effectiveAt).toEqual(receipt.effectiveAt);
    expect(purchaseSum(h, 2026, 9)).toBe(0);
    expect(purchaseSum(h, 2026, 10)).toBe(0);
    // Ledger invariant: Σq == the counter, and the reversal snapshots the counter after the void.
    expect(h.sum({ productId: "prod-1" }).eq(h.product.currentStock)).toBe(true);
    expect(D(reversal.stockAfter).eq(0)).toBe(true);
    expect(h.lots).toHaveLength(0);
    expect(h.prisma.stockMovement.deleteMany).not.toHaveBeenCalled();
    expect(h.prisma.vendorBill.update.mock.calls.at(-1)?.[0].data.status).toBe("VOID");
  });

  it("V2: September already filed — the reversal is dated now with the filed-through note, live September equals the filing, October shows -10", async () => {
    const h = await harness();
    h.flags.isTobacco = true;
    await receive(h, 10);
    h.tobaccoReports.push(SEPT_FILED);

    await voidIt(h, 10);

    const [receipt, reversal] = h.rows;
    expect(reversal.type).toBe("PURCHASE");
    expect(reversal.effectiveAt).toEqual(NOW);
    expect(reversal.notes).toBe(
      `${BILL_REVERTED_NOTE}${receipt.id} (filed through September 2026)`,
    );
    expect(purchaseSum(h, 2026, 9)).toBe(10); // live September == what was filed
    expect(purchaseSum(h, 2026, 10)).toBe(-10);
    expect(h.rows.filter((r) => r.type === "ADJUSTMENT")).toHaveLength(0);
  });

  it("V2b: refuses 409 STOCK_DATE_IN_FILED_PERIOD when today is itself filed — nothing written", async () => {
    const h = await harness();
    h.flags.isTobacco = true;
    await receive(h, 10);
    h.tobaccoReports.push({
      status: "GENERATED",
      periodStart: new Date("2026-10-01T00:00:00.000Z"),
      periodEnd: new Date("2026-10-31T23:59:59.999Z"),
    });

    await expect(voidIt(h, 10)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.STOCK_DATE_IN_FILED_PERIOD },
    });
    expect(h.rows).toHaveLength(1); // (the counter rolls back with the tx; the db twin proves it)
  });

  it("V3: a manual purchase sharing the bill number survives the void — row and lot — and is not counted as the bill's", async () => {
    const h = await harness();
    h.flags.isTobacco = true;
    manualPurchase(h, 5);
    h.lots.push({
      id: "lot-manual",
      productId: "prod-1",
      reference: "B-1",
      purchaseDate: new Date("2026-05-20T00:00:00.000Z"),
      qty: D(5),
      remainingQty: D(5),
      unitCost: D(1),
    });
    await receive(h, 10);

    await voidIt(h, 10);

    expect(h.rows.map((r) => Number(r.quantity))).toEqual([5, 10, -10]);
    expect(h.rows[0].id).toBe("mv-manual");
    expect(h.prisma.stockMovement.deleteMany).not.toHaveBeenCalled();
    expect(purchaseSum(h, 2026, 5)).toBe(5);
    expect(purchaseSum(h, 2026, 9)).toBe(0);
    expect(h.lots.map((l) => l.id)).toEqual(["lot-manual"]);
    expect(h.sum({ productId: "prod-1" }).eq(h.product.currentStock)).toBe(true);
    expect(h.product.currentStock.toNumber()).toBe(5);
  });

  it("V4 (guard): a PO-linked bill posts no stock, so its void writes nothing to the ledger", async () => {
    const h = await harness();
    h.setBill({ ...receivedBill(10), purchaseOrderId: "po-1" });

    await (h.service as any).voidBill("bill-1", "user-2");

    expect(h.rows).toHaveLength(0);
    expect(h.prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(h.prisma.product.update).not.toHaveBeenCalled();
  });

  it("V5 (guard): a voided bill's cost is not LAST_COST — the shared exclusion pairs its receipt", async () => {
    const h = await harness();
    await receive(h, 10);
    await voidIt(h, 10);

    const [receipt] = h.rows;
    expect(await pairedReceiptIds(h.prisma as any, "prod-1")).toEqual([receipt.id]);
  });

  it("void after a revert and re-receive reverses only the re-received row", async () => {
    const h = await harness();
    await receive(h, 10);
    await revert(h, 10);
    await receive(h, 8);

    await voidIt(h, 8);

    expect(summary(h).map((r) => r.q)).toEqual([10, -10, 8, -8]);
    expect(h.rows[3].notes).toBe(`${BILL_REVERTED_NOTE}${h.rows[2].id}`);
    expect(h.product.currentStock.toNumber()).toBe(0);
    expect(h.sum({ productId: "prod-1" }).toNumber()).toBe(0);
  });

  it("replays the product when newer rows sit after the (backdated) reversal, and surfaces the gap", async () => {
    const h = await harness();
    await receive(h, 10);
    h.rows.push({
      id: "mv-sale",
      productId: "prod-1",
      type: "SALE",
      quantity: D(-2),
      effectiveAt: new Date("2026-09-20T00:00:00.000Z"),
      createdAt: new Date("2026-09-20T00:00:00.000Z"),
    });
    h.product.currentStock = D(8);
    h.inventory.recomputeProductInTx.mockResolvedValue({ gapDetected: true, stockDrift: 3 });

    const out = await voidIt(h, 10);

    expect(h.inventory.recomputeProductInTx).toHaveBeenCalledTimes(1);
    expect(out.gapsDetected).toEqual([{ productId: "prod-1", name: "Widget", stockDrift: 3 }]);
    expect(out.status).toBe("VOID");
  });

  describe("SA-808b — a void degrades, an excess is still refused, revert names the way out", () => {
    /** A legacy bill: the counter holds the stock, but no PURCHASE row was ever written for it. */
    const legacyWorld = async () => {
      const h = await harness();
      h.flags.isTobacco = true;
      h.product.currentStock = D(10);
      h.product.averageCost = D(2);
      h.lots.push({
        id: "lot-legacy",
        productId: "prod-1",
        reference: "B-1",
        purchaseDate: BILL_DATE,
        qty: D(10),
        remainingQty: D(10),
        unitCost: D(2),
      });
      return h;
    };
    /** Review item 4: a void moves the product's Σq and its counter by the same amount. */
    const together = async (h: Harness, run: () => Promise<any>) => {
      const q0 = h.sum({ productId: "prod-1" });
      const c0 = h.product.currentStock;
      const out = await run();
      expect(h.sum({ productId: "prod-1" }).sub(q0).toNumber()).toBe(
        h.product.currentStock.sub(c0).toNumber(),
      );
      return out;
    };

    it("V1: a legacy bill with no receipt row voids — ADJUSTMENT -Q dated now, purchases unchanged, audit row, lot gone", async () => {
      const h = await legacyWorld();

      const out = await together(h, () => voidIt(h, 10));

      expect(h.rows).toHaveLength(1);
      expect(h.rows[0]).toMatchObject({
        type: "ADJUSTMENT",
        reference: "B-1",
        supplierId: "sup-1",
      });
      expect(D(h.rows[0].quantity).eq(-10)).toBe(true);
      expect(h.rows[0].effectiveAt).toEqual(NOW);
      expect(h.rows[0].notes).toContain("B-1");
      expect(h.rows[0].notes).toContain("had no receipt record");
      expect(purchaseSum(h, 2026, 9)).toBe(0); // no PURCHASE was ever counted, none is added
      expect(h.product.currentStock.toNumber()).toBe(0);
      expect(h.lots).toHaveLength(0);
      expect(out.status).toBe("VOID");
      expect(out.gapsDetected).toEqual([
        { productId: "prod-1", name: "Widget", stockDrift: 10, noReceiptQty: 10 },
      ]);
      expect(h.prisma.auditLog.create).toHaveBeenCalledTimes(1);
      expect(h.prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: "vendor-bill.void-without-receipt",
        entityType: "VendorBill",
        entityId: "bill-1",
        userId: "user-2",
        meta: {
          billNumber: "B-1",
          products: [{ productId: "prod-1", found: [], noReceiptQty: "10" }],
        },
      });
    });

    it("V1b: a closed month never moves — with today filed the void is refused 409, nothing written", async () => {
      const h = await legacyWorld();
      h.tobaccoReports.push({
        status: "GENERATED",
        periodStart: new Date("2026-10-01T00:00:00.000Z"),
        periodEnd: new Date("2026-10-31T23:59:59.999Z"),
      });
      await expect(voidIt(h, 10)).rejects.toMatchObject({
        response: { code: API_ERROR_CODES.STOCK_DATE_IN_FILED_PERIOD },
      });
      expect(h.rows).toHaveLength(0);
    });

    it("V2: a PAID bill with half its rows missing — half reversed as -PURCHASE (original date), half as ADJUSTMENT now, credits returned", async () => {
      const h = await harness();
      h.flags.isTobacco = true;
      await receive(h, 10);
      h.rows[0].quantity = D(5); // the other 5 were never recorded
      h.product.currentStock = D(10);
      const refund = jest.spyOn(h.service as any, "refundDrawnSupplierCredits");
      h.setBill({ ...receivedBill(10), status: "PAID" });

      const out = await together(h, () => (h.service as any).voidBill("bill-1", "user-2"));

      expect(h.rows.map((r) => [r.type, Number(r.quantity)])).toEqual([
        ["PURCHASE", 5],
        ["PURCHASE", -5],
        ["ADJUSTMENT", -5],
      ]);
      expect(h.rows[1].effectiveAt).toEqual(h.rows[0].effectiveAt);
      expect(h.rows[2].effectiveAt).toEqual(NOW);
      expect(purchaseSum(h, 2026, 9)).toBe(0);
      expect(h.product.currentStock.toNumber()).toBe(0);
      expect(D(h.rows[2].stockAfter).toNumber()).toBe(0);
      expect(h.lots).toHaveLength(0); // the bill's lot holds no more than it received: reversed
      expect(refund).toHaveBeenCalledTimes(1);
      expect(out.gapsDetected).toEqual([
        { productId: "prod-1", name: "Widget", stockDrift: 5, noReceiptQty: 5 },
      ]);
      expect(out.status).toBe("VOID");
    });

    it("rows that sit on another product count as shortfall and are listed in the audit row, never reassigned", async () => {
      const h = await legacyWorld();
      h.rows.push({
        id: "mv-moved",
        productId: "prod-2",
        type: "PURCHASE",
        quantity: D(10),
        unitCost: D(2),
        reference: "B-1",
        notes: billReceiptNote("B-1"),
        effectiveAt: BILL_DATE,
        createdAt: BILL_DATE,
      });

      await together(h, () => voidIt(h, 10));

      expect(h.rows.find((r) => r.id === "mv-moved")?.productId).toBe("prod-2");
      expect(D(h.rows.at(-1)?.quantity).eq(-10)).toBe(true);
      expect(
        h.prisma.auditLog.create.mock.calls[0][0].data.meta.receiptRowsOnOtherProducts,
      ).toEqual([{ id: "mv-moved", productId: "prod-2", quantity: "10" }]);
    });

    it("V7 (SA-808c): an excess is refused for void and revert alike with the repair copy, and each refusal writes one ledger-excess audit row", async () => {
      const h = await harness();
      await receive(h, 10);
      h.rows[0].quantity = D(12);
      h.prisma.vendorBill.update.mockClear();
      h.prisma.auditLog.create.mockClear();

      await expect(voidIt(h, 10)).rejects.toMatchObject({
        status: 409,
        response: {
          code: API_ERROR_CODES.INVENTORY_LEDGER_GAP,
          message:
            "Widget's stock records show more received than this bill, so it can't be voided here. We've flagged it for a repair.",
        },
      });
      await expect(revert(h, 10)).rejects.toMatchObject({
        status: 409,
        response: {
          code: API_ERROR_CODES.INVENTORY_LEDGER_GAP,
          message:
            "Widget's stock records show more received than this bill, so it can't be reverted here. We've flagged it for a repair.",
        },
      });
      expect(h.rows).toHaveLength(1);
      expect(h.prisma.vendorBill.update).not.toHaveBeenCalled();
      const audits = h.prisma.auditLog.create.mock.calls.map((c: any) => c[0].data);
      expect(audits).toHaveLength(2);
      for (const a of audits) {
        expect(a).toMatchObject({
          action: "vendor-bill.ledger-excess",
          entityType: "VendorBill",
          entityId: "bill-1",
          meta: { billNumber: "B-1", productId: "prod-1", posted: "12", received: "10" },
        });
      }
      expect(audits.map((a: any) => a.meta.action)).toEqual(["voided", "reverted to draft"]);
      expect(JSON.stringify(audits)).not.toContain("Void the bill");
    });

    it("V4 / V8 (guard): a shortfall revert on V1's bill is refused 409 with the message that names void", async () => {
      const h = await legacyWorld();
      await expect(revert(h, 10)).rejects.toMatchObject({
        response: {
          code: API_ERROR_CODES.INVENTORY_LEDGER_GAP,
          message:
            "Widget's stock records for this bill don't match what was received, so it can't go back to draft. Void the bill and enter it again.",
        },
      });
      expect(h.rows).toHaveLength(0);
      expect(h.prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("V5: a two-line, one-product bill voids in either row order (the planner is shared with revert)", async () => {
      for (const reverse of [false, true]) {
        const h = await harness();
        const two = (received = false) => ({
          ...draftBill(0),
          items: [
            item(5, 2, { id: "item-1", ...(received ? { qtyReceived: D(5) } : {}) }),
            item(3, 3, { id: "item-2", ...(received ? { qtyReceived: D(3) } : {}) }),
          ],
        });
        h.setBill(two());
        await h.service.receive("bill-1", undefined, "user-1");
        const tied = h.rows[0].createdAt;
        for (const r of h.rows) r.createdAt = tied;
        if (reverse) h.rows.reverse();
        h.setBill({
          ...two(true),
          status: "RECEIVED",
          receivedDate: billDate,
        });
        h.prisma.auditLog.create.mockClear();

        await together(h, () => (h.service as any).voidBill("bill-1", "user-2"));

        expect(h.rows.filter((r) => r.type === "ADJUSTMENT")).toHaveLength(0);
        expect(h.rows.filter((r) => Number(r.quantity) < 0)).toHaveLength(2);
        expect(h.sum({ productId: "prod-1" }).toNumber()).toBe(0);
        expect(h.product.currentStock.toNumber()).toBe(0);
        expect(h.prisma.auditLog.create).not.toHaveBeenCalled();
      }
    });

    it("V6: lot ambiguity never blocks a void: both candidates stand untouched, the audit row and gapsDetected name them", async () => {
      const h = await harness();
      await receive(h, 10);
      h.rows[0].effectiveAt = new Date("2026-09-16T08:00:00.000Z"); // legacy: lot and row disagree
      h.lots.push({ ...h.lots[0], id: "lot-twin" });

      const out = await together(h, () => voidIt(h, 10));

      expect(out.status).toBe("VOID");
      expect(h.rows.map((r) => [r.type, Number(r.quantity)])).toEqual([
        ["PURCHASE", 10],
        ["PURCHASE", -10],
      ]);
      expect(h.product.currentStock.toNumber()).toBe(0);
      expect(h.lots.map((l) => [l.id, Number(l.remainingQty)])).toEqual([
        ["lot-1", 10],
        ["lot-twin", 10],
      ]);
      expect(h.prisma.stockLot.delete).not.toHaveBeenCalled();
      expect(h.prisma.stockLot.update).not.toHaveBeenCalled();
      expect(out.gapsDetected).toEqual([
        { productId: "prod-1", name: "Widget", stockDrift: 0, lotsLeft: 20 },
      ]);
      expect(h.prisma.auditLog.create).toHaveBeenCalledTimes(1);
      expect(h.prisma.auditLog.create.mock.calls[0][0].data.meta).toMatchObject({
        billNumber: "B-1",
        products: [{ productId: "prod-1", found: ["mv-1"], noReceiptQty: "0" }],
        lotsLeft: [
          {
            productId: "prod-1",
            name: "Widget",
            lotIds: ["lot-1", "lot-twin"],
            remainingQty: "20",
          },
        ],
      });
      // revert keeps refusing the same ambiguity (it has an exit: void)
      const r = await harness();
      await receive(r, 10);
      r.rows[0].effectiveAt = new Date("2026-09-16T08:00:00.000Z");
      r.lots.push({ ...r.lots[0], id: "lot-twin" });
      await expect(revert(r, 10)).rejects.toMatchObject({
        response: { code: API_ERROR_CODES.INVENTORY_LEDGER_GAP },
      });
    });

    it("a manual lot alone, ≤ received, survives a void (never by reference alone, SA-808 §2)", async () => {
      const h = await legacyWorld();
      h.lots.length = 0; // the legacy bill never made a lot of its own
      h.rows.push({
        id: "mv-manual",
        productId: "prod-1",
        type: "PURCHASE",
        quantity: D(4),
        unitCost: D(1),
        supplierId: "sup-1",
        reference: "B-1",
        notes: "manual purchase",
        effectiveAt: new Date("2026-05-20T00:00:00.000Z"),
        createdAt: new Date("2026-05-20T00:00:00.000Z"),
      });
      h.lots.push({
        id: "lot-manual",
        productId: "prod-1",
        reference: "B-1", // a person's purchase that happens to share the bill number
        purchaseDate: new Date("2026-05-20T00:00:00.000Z"),
        qty: D(4),
        remainingQty: D(4),
        unitCost: D(1),
      });
      h.product.currentStock = D(14);

      const out = await together(h, () => voidIt(h, 10));

      expect(out.status).toBe("VOID");
      expect(h.lots.map((l) => l.id)).toEqual(["lot-manual"]);
      expect(h.prisma.stockLot.delete).not.toHaveBeenCalled();
      expect(h.prisma.stockLot.update).not.toHaveBeenCalled();
    });

    it("a shortfall takes only the lot shaped like its line; a manual lot sharing the number stays", async () => {
      const h = await legacyWorld();
      h.lots.push({
        id: "lot-manual",
        productId: "prod-1",
        reference: "B-1",
        purchaseDate: new Date("2026-05-20T00:00:00.000Z"),
        qty: D(4),
        remainingQty: D(4),
        unitCost: D(1),
      });
      h.product.currentStock = D(14);

      const out = await together(h, () => voidIt(h, 10));

      expect(out.status).toBe("VOID");
      expect(D(h.rows[0].quantity).eq(-10)).toBe(true); // the shortfall ADJUSTMENT lands
      expect(h.lots.map((l) => l.id)).toEqual(["lot-manual"]);
      expect(out.gapsDetected).toEqual([
        { productId: "prod-1", name: "Widget", stockDrift: 10, noReceiptQty: 10 },
      ]);
    });

    it("SA-808c S1: a shortfall product's lots that match no line are recorded as lotsUnmatched, never as lotsLeft", async () => {
      const h = await legacyWorld();
      h.lots.length = 0; // two partial receipt lots (6 + 4) instead of one 10: neither is the line's shape
      for (const [id, qty] of [
        ["lot-a", 6],
        ["lot-b", 4],
      ] as const)
        h.lots.push({
          id,
          productId: "prod-1",
          reference: "B-1",
          purchaseDate: BILL_DATE,
          qty: D(qty),
          remainingQty: D(qty),
          unitCost: D(2),
        });
      h.lots.push({
        id: "lot-manual", // a person's purchase sharing the number looks the same
        productId: "prod-1",
        reference: "B-1",
        purchaseDate: new Date("2026-05-20T00:00:00.000Z"),
        qty: D(4),
        remainingQty: D(4),
        unitCost: D(1),
      });
      h.product.currentStock = D(14);

      const out = await together(h, () => voidIt(h, 10));

      expect(out.status).toBe("VOID");
      // nothing is touched (as before) ...
      expect(h.lots.map((l) => l.id)).toEqual(["lot-a", "lot-b", "lot-manual"]);
      expect(h.prisma.stockLot.delete).not.toHaveBeenCalled();
      expect(h.prisma.stockLot.update).not.toHaveBeenCalled();
      // ... but no longer silently, and never in the zero-by-id repair list
      const meta = h.prisma.auditLog.create.mock.calls[0][0].data.meta;
      expect(meta.lotsLeft).toEqual([]);
      expect(meta.lotsUnmatched).toEqual([
        {
          productId: "prod-1",
          name: "Widget",
          lotIds: ["lot-a", "lot-b", "lot-manual"],
          remainingQty: "14",
        },
      ]);
      expect(out.gapsDetected).toEqual([
        { productId: "prod-1", name: "Widget", stockDrift: 10, noReceiptQty: 10 },
      ]);
    });
  });
});
