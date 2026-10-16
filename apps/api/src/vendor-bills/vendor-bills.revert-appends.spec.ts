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

  it("L-207: refuses with a coded error when the receipt rows do not add up to the received qty", async () => {
    const h = await harness();
    await receive(h, 10);
    h.rows[0].quantity = D(7); // history no longer explains the line

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

  it("L-207: refuses a void the ledger cannot explain — coded 409 naming the void, nothing written", async () => {
    const h = await harness();
    await receive(h, 10);
    h.rows[0].quantity = D(7);
    h.prisma.vendorBill.update.mockClear(); // receive() updated the bill; the refused void must not

    await expect(voidIt(h, 10)).rejects.toMatchObject({
      response: {
        code: API_ERROR_CODES.INVENTORY_LEDGER_GAP,
        message: expect.stringContaining("can't be voided"),
      },
    });
    expect(h.rows).toHaveLength(1);
    expect(h.product.currentStock.toNumber()).toBe(10);
    expect(h.prisma.vendorBill.update).not.toHaveBeenCalled();
  });
});
