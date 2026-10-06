/**
 * B1120: "Adjust Prices" accepted a sub-cent unit price (8.355, 17.335, 24.985, 9.995). The stored
 * `InvoiceItem.unitPrice` is numeric(10,2) (8.36) while the line subtotal was computed from the RAW
 * 8.355, so the invoice read 6 x $8.36 = $50.13 (6 x 8.36 is 50.16), 3 x $17.34 = $52.01 (52.02). The next
 * adjust then recovered the multiplier as `subtotal / unitPrice` = 50.13 / 8.36 = 5.9964 and drifted again.
 *
 * The convention (every unit price column is numeric(10,2); every other writer rounds with `roundMoney` at
 * the write, and a product price DTO refuses a 3rd decimal) means: a unit price on this path is WHOLE CENTS.
 * Fixed in three layers, each pinned here on the bug's own wrong values:
 *   1. the DTO refuses more than 2 decimals (and a value the numeric(10,2) column cannot hold);
 *   2. `buildPriceAdjustmentUpdates` rounds the price with `roundMoney` BEFORE it is written, and prices
 *      the line from THAT price via `computeLineSubtotal` (the line's own boxes/pieces/pack), never from a
 *      multiplier recovered out of the stored, already-rounded subtotal;
 *   3. a line whose split no pack can price keeps the old proportional recovery (never a 12x overcharge).
 * The real-Postgres twin is price-adjustment-whole-cents-b1120.db.spec.ts.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: class InvoicePdfService {} }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../common/msrp", () => ({ loadMsrpMap: jest.fn().mockResolvedValue(new Map()) }));

import { Test } from "@nestjs/testing";
import { ValidationPipe } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { InvoicesService } from "./invoices.service";
import { buildPriceAdjustmentUpdates } from "./price-adjustment-ledger";
import { PriceAdjustmentDto } from "./dto/price-adjustment.dto";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";

type Row = Record<string, any>;

/** A loose (non-boxed) line, priced whole-cent: `unitPrice x qty`, no discount. */
const line = (id: string, over: Row = {}): Row => ({
  id,
  invoiceId: "inv-1",
  productId: "prod-x",
  description: "Widget",
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  unitPrice: 8.36,
  discount: 0,
  subtotal: 50.16,
  qty: 6,
  taxRate: 0,
  categoryTaxAmount: 0,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  promoFreeUnits: null,
  orderItemId: null,
  ...over,
});

const build = (items: Row[], prices: Record<string, number>) =>
  buildPriceAdjustmentUpdates({
    items,
    localPriceMap: new Map(Object.entries(prices)),
    categoriesById: new Map(),
    unitsPerBoxByProduct: new Map(),
    isTaxExempt: false,
  });

/** What numeric(10,2) does to whatever the write hands it (the stand-in for the real column). */
const column = (v: unknown): number => Number(Number(v).toFixed(2));

describe("buildPriceAdjustmentUpdates: the price written IS the price the line is priced at (B1120)", () => {
  it.each([
    ["8.355 x 6", 8.355, 6, 8.36, 50.16],
    ["17.335 x 3", 17.335, 3, 17.34, 52.02],
    ["24.985 x 4", 24.985, 4, 24.99, 99.96],
  ])(
    "%s: the stored price is whole cents and the line total is qty x THAT price",
    (_n, typed, qty, price, total) => {
      const [u] = build([line("i1", { qty })], { i1: typed });
      // Persisted values first, so a red run names the wrong one: today unitPrice is the raw `typed`
      // (numeric(10,2) then stores 8.36) and the subtotal is round(typed x qty) = 50.13 / 52.01 / 99.94.
      expect(u.data.unitPrice).toBe(price);
      expect(u.data.subtotal).toBe(total);
      expect(roundMoney(qty * u.data.unitPrice)).toBe(u.data.subtotal); // the line says what it multiplies
    },
  );

  it("9.995 is rounded half-up by roundMoney (10.00), and 6 x that price is the line total", () => {
    const [u] = build([line("i1")], { i1: 9.995 });
    expect(u.data.unitPrice).toBe(10);
    expect(u.data.subtotal).toBe(60);
  });

  it("6 x 9.99 = 59.94 on the row the demo left behind (8.36 stored with the drifted 50.13)", () => {
    const drifted = line("i1", { unitPrice: 8.36, subtotal: 50.13 });
    const [u] = build([drifted], { i1: 9.99 });
    expect(u.data).toMatchObject({ unitPrice: 9.99, subtotal: 59.94 }); // today 59.90: 9.99 x 5.9964
  });

  it("a stored line discount is still taken off the re-priced line total", () => {
    const [u] = build([line("i1", { unitPrice: 10, subtotal: 55, discount: 5 })], { i1: 8.355 });
    expect(u.data).toMatchObject({ unitPrice: 8.36, subtotal: 45.16 }); // 6 x 8.36 - 5
  });

  it("re-applying the same prices changes nothing, executed over every cent price from 0.01 to 20.00", () => {
    const changed: number[] = [];
    for (let cents = 1; cents <= 2000; cents++) {
      const price = cents / 100;
      const first = build([line("i1", { qty: 7 })], { i1: price })[0].data;
      const stored = line("i1", { qty: 7, unitPrice: first.unitPrice, subtotal: first.subtotal });
      const again = build([stored], { i1: price })[0].data;
      if (again.subtotal !== first.subtotal || again.unitPrice !== first.unitPrice)
        changed.push(price);
    }
    expect(changed).toEqual([]);
  });
});

describe("buildPriceAdjustmentUpdates: a boxed line goes through computeLineSubtotal (B1120)", () => {
  /** 12 per box, 1 box + 5 loose pieces: 1.4166... boxes of a $10.00 box = $14.17 stored. */
  const boxed = (over: Row = {}) =>
    line("b1", {
      qty: 17,
      boxes: 1,
      pieces: 5,
      unitsPerBox: 12,
      unitPrice: 10,
      subtotal: 14.17,
      ...over,
    });

  it("prices the box + loose-pieces split at the new BOX price, never qty x price", () => {
    const [u] = build([boxed()], { b1: 100 });
    // the box price is $100: 1 box + 5/12 box = $141.67. Today the multiplier recovered from the
    // rounded $14.17 gives 141.70; qty x price would give 17 x 100 = $1,700 (a 12x overcharge).
    expect(u.data.subtotal).toBe(141.67);
    expect(u.data.subtotal).toBeLessThan(200);
  });

  it("no drift on a repeat: 10 -> 0.50 -> 10 lands back on the original 14.17 (today it ends at 14.20)", () => {
    const down = build([boxed()], { b1: 0.5 })[0].data;
    expect(down.subtotal).toBe(0.71);
    const back = build([boxed({ unitPrice: down.unitPrice, subtotal: down.subtotal })], {
      b1: 10,
    })[0].data;
    expect(back.subtotal).toBe(14.17);
  });

  it("a Case line (unitLabel, count 3 of a 12-pack) is priced per Case", () => {
    const caseLine = line("c1", {
      unitLabel: "Case",
      qty: 36,
      boxes: 3,
      pieces: null,
      unitsPerBox: 12,
      unitPrice: 8,
      subtotal: 24,
    });
    expect(build([caseLine], { c1: 7.99 })[0].data).toMatchObject({
      unitPrice: 7.99,
      subtotal: 23.97,
    });
  });

  it("BUY_N_GET_M free boxes come off before pricing: 12 boxes, 2 free, at 36 = 360", () => {
    const bogo = line("g1", {
      qty: 144,
      boxes: 12,
      pieces: 0,
      unitsPerBox: 12,
      promoFreeUnits: 2,
      unitPrice: 35,
      subtotal: 350,
    });
    expect(build([bogo], { g1: 36 })[0].data.subtotal).toBe(360);
  });

  it("a split with its pack missing (boxes 0, pieces 5, no snapshot) keeps the proportional recovery, never 12x", () => {
    // 5 pieces of an $11.00 case = $4.58 stored; the pack is underivable from boxes 0, so pricing the
    // split as loose pieces would bill 5 x 12 = $60.00.
    const legacy = line("l1", {
      qty: 5,
      boxes: 0,
      pieces: 5,
      unitsPerBox: null,
      unitPrice: 11,
      subtotal: 4.58,
    });
    const [u] = build([legacy], { l1: 12 });
    expect(u.data.subtotal).toBe(5);
  });

  it("a pack-less box split whose own qty derives the pack (boxes 2, pieces 3, qty 27) prices from it", () => {
    const legacy = line("l2", {
      qty: 27,
      boxes: 2,
      pieces: 3,
      unitsPerBox: null,
      unitPrice: 12,
      subtotal: 27,
    });
    expect(build([legacy], { l2: 14 })[0].data.subtotal).toBe(31.5); // 2.25 boxes x 14
  });
});

describe("buildPriceAdjustmentUpdates: the no-derivable-pack fallback round trip is bounded (B1120)", () => {
  /** boxes 0, pieces 5, no unitsPerBox snapshot: the one shape no pack can price, 5/12 of a case at price A. */
  const legacy = (price: number, subtotal: number) =>
    line("l1", { qty: 5, boxes: 0, pieces: 5, unitsPerBox: null, unitPrice: price, subtotal });

  /** A -> B -> A through the builder, each step re-reading the line the previous one stored. Cents moved. */
  const driftCents = (priceA: number, priceB: number): number => {
    const start = roundMoney((priceA * 5) / 12);
    const atB = build([legacy(priceA, start)], { l1: priceB })[0].data;
    const back = build([legacy(priceB, atB.subtotal)], { l1: priceA })[0].data;
    return Math.round((back.subtotal - start) * 100);
  };

  it("the pinned pair 5.01 -> 3.01 -> 5.01 really does move one cent (so the bound below is tight, not vacuous)", () => {
    expect(build([legacy(5.01, 2.09)], { l1: 3.01 })[0].data.subtotal).toBe(1.26);
    expect(build([legacy(3.01, 1.26)], { l1: 5.01 })[0].data.subtotal).toBe(2.1);
  });

  it("re-applying the SAME price on the fallback line is exactly the identity, executed over every cent price from 0.01 to 30.00", () => {
    const moved: number[] = [];
    for (let cents = 1; cents <= 3000; cents++) {
      const price = cents / 100;
      const start = roundMoney((price * 5) / 12);
      for (const discount of [0, 0.5]) {
        const row = { ...legacy(price, start), discount };
        const [u] = build([row], { l1: price });
        if (u.data.subtotal !== start || u.data.unitPrice !== price) moved.push(price);
      }
    }
    expect(moved).toEqual([]);
  });

  it("one round trip moves the total by at most 1/2 cent x A/B + 1/2 cent, and by at most 1 cent when B is at least half of A (executed sweep)", () => {
    let worstWithinRatio = 0;
    let checked = 0;
    for (let a = 100; a <= 3000; a += 3) {
      const priceA = a / 100;
      for (const priceB of [0.25, 1, 5, priceA * 0.5, priceA * 0.75, priceA * 1.5, priceA * 2]) {
        const b = roundMoney(priceB);
        if (b <= 0) continue;
        const moved = Math.abs(driftCents(priceA, b));
        // the general bound: a multiplier error of (1/2 cent) / B, scaled back up by A, plus the final rounding
        expect(moved).toBeLessThanOrEqual(0.5 * (priceA / b) + 0.5 + 1e-9);
        if (priceA <= 2 * b) worstWithinRatio = Math.max(worstWithinRatio, moved);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5000);
    expect(worstWithinRatio).toBeLessThanOrEqual(1);
  });
});

describe("PriceAdjustmentItemDto: a unit price is whole cents the column can hold (B1120)", () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const body = (newUnitPrice: unknown) => ({
    items: [{ itemId: "11111111-1111-4111-8111-111111111111", newUnitPrice }],
    scope: "SINGLE",
  });
  const run = (newUnitPrice: unknown) =>
    pipe.transform(body(newUnitPrice), {
      type: "body",
      metatype: PriceAdjustmentDto,
      data: "",
    });

  it.each([8.355, 17.335, 24.985, 9.995, 0.001, 1.005, 1e-7])(
    "refuses %p (more than 2 decimals) with a 400 that says why",
    async (v) => {
      await expect(run(v)).rejects.toMatchObject({ status: 400 });
      // the pipe's body carries the per-field messages; the operator reads WHICH rule failed
      const body: any = await run(v).catch((e) => e.getResponse());
      expect(JSON.stringify(body.message)).toContain(
        "newUnitPrice must be a whole-cent amount (at most 2 decimal places)",
      );
    },
  );

  it.each([0, 0.01, 1.1, 4.35, 8.36, 9.99, 19.99, 100, 12345.67, 99_999_999.99])(
    "accepts the whole-cent price %p",
    async (v) => {
      await expect(run(v)).resolves.toBeDefined();
    },
  );

  it.each([-0.01, 100_000_000, NaN, Infinity, "8.36", null])(
    "still refuses %p (negative, over numeric(10,2), non-finite or not a number)",
    async (v) => {
      await expect(run(v)).rejects.toMatchObject({ status: 400 });
    },
  );
});

describe("InvoicesService.applyPriceAdjustment: stored rows and totals after real round trips (B1120)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoices: Record<string, Row>;

  const invoice = (id: string, items: Row[], over: Row = {}): Row => ({
    id,
    invoiceNumber: `INV-${id}`,
    customerId: "cust-1",
    orderId: null,
    status: InvoiceStatus.SENT,
    discount: 0,
    shippingFee: 0,
    subtotal: items.reduce((s, i) => s + i.subtotal, 0),
    taxAmount: 0,
    total: items.reduce((s, i) => s + i.subtotal, 0),
    internalNotes: null,
    payments: [],
    items,
    ...over,
  });

  /** An in-memory invoice table: every write goes through `column`, the numeric(10,2) stand-in. */
  const arrange = (rows: Row[]) => {
    invoices = Object.fromEntries(rows.map((r) => [r.id, r]));
    const snapshot = (r: Row) => ({ ...r, items: r.items.map((i: Row) => ({ ...i })) });
    prisma.invoice.findUnique.mockImplementation(async ({ where }: any) =>
      invoices[where.id] ? snapshot(invoices[where.id]) : null,
    );
    prisma.invoice.findMany.mockImplementation(async () => Object.values(invoices).map(snapshot));
    prisma.invoiceItem.update.mockImplementation(async ({ where, data }: any) => {
      for (const inv of Object.values(invoices)) {
        const row = inv.items.find((i: Row) => i.id === where.id);
        if (!row) continue;
        for (const [k, v] of Object.entries(data)) {
          row[k] = ["unitPrice", "subtotal", "categoryTaxAmount"].includes(k) ? column(v) : v;
        }
      }
      return {};
    });
    prisma.invoiceItem.findMany.mockImplementation(async ({ where }: any) =>
      invoices[where.invoiceId].items.map((i: Row) => ({ ...i })),
    );
    prisma.invoice.update.mockImplementation(async ({ where, data }: any) => {
      const inv = invoices[where.id];
      for (const [k, v] of Object.entries(data)) {
        inv[k] = ["subtotal", "taxAmount", "total"].includes(k) ? column(v) : v;
      }
      return {};
    });
    prisma.invoiceItem.updateMany.mockResolvedValue({ count: 0 });
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.trackedCategory.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([]);
  };

  const single = (id: string, prices: Record<string, number>) =>
    service.applyPriceAdjustment(id, {
      items: Object.entries(prices).map(([itemId, newUnitPrice]) => ({ itemId, newUnitPrice })),
      scope: "SINGLE",
    });
  const bulk = (id: string, prices: Record<string, number>) =>
    service.applyPriceAdjustment(id, {
      items: Object.entries(prices).map(([itemId, newUnitPrice]) => ({ itemId, newUnitPrice })),
      scope: "ALL_CUSTOMER_SINCE",
      sinceDate: "2026-01-01",
    });
  const stored = (invId: string, itemId: string) =>
    invoices[invId].items.find((i: Row) => i.id === itemId);

  beforeEach(async () => {
    prisma = createMockPrisma();
    const autoMock = () =>
      new Proxy({} as Record<string | symbol, jest.Mock>, {
        get: (t, k) =>
          k === "then" || typeof k === "symbol"
            ? undefined
            : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
      });
    const module = await Test.createTestingModule({ providers: [InvoicesService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === EntitlementsService) return { hasFlag: jest.fn().mockResolvedValue(false) };
        return autoMock();
      })
      .compile();
    service = module.get(InvoicesService);
  });

  it("SINGLE 8.355 / 17.335 / 24.985: every line total is qty x the stored price, the invoice is their sum", async () => {
    arrange([
      invoice("inv-1", [
        line("a", { qty: 6, unitPrice: 10, subtotal: 60 }),
        line("b", { qty: 3, unitPrice: 20, subtotal: 60 }),
        line("c", { qty: 4, unitPrice: 30, subtotal: 120 }),
      ]),
    ]);
    await single("inv-1", { a: 8.355, b: 17.335, c: 24.985 });

    // today: 6 x $8.36 = 50.13, 3 x $17.34 = 52.01, 4 x $24.99 = 99.94 and an invoice of 202.08
    expect([stored("inv-1", "a"), stored("inv-1", "b"), stored("inv-1", "c")]).toMatchObject([
      { unitPrice: 8.36, subtotal: 50.16 },
      { unitPrice: 17.34, subtotal: 52.02 },
      { unitPrice: 24.99, subtotal: 99.96 },
    ]);
    expect(invoices["inv-1"]).toMatchObject({ subtotal: 202.14, total: 202.14 });
  });

  it("a SECOND adjust with the same typed prices leaves every line and the invoice total where they were", async () => {
    arrange([invoice("inv-1", [line("a", { qty: 6, unitPrice: 10, subtotal: 60 })])]);
    await single("inv-1", { a: 8.355 });
    const afterFirst = { line: { ...stored("inv-1", "a") }, total: invoices["inv-1"].total };

    await single("inv-1", { a: 8.355 }); // today: 8.355 x (50.13 / 8.36) = 50.10, the total slides
    await single("inv-1", { a: 8.36 });

    expect(stored("inv-1", "a")).toMatchObject({
      unitPrice: afterFirst.line.unitPrice,
      subtotal: afterFirst.line.subtotal,
    });
    expect(invoices["inv-1"].total).toBe(afterFirst.total);
    expect(afterFirst.total).toBe(50.16);
  });

  it("BULK from a date: both invoices re-price to qty x the stored price and a repeat changes nothing", async () => {
    arrange([
      invoice("inv-1", [line("a1", { qty: 6, unitPrice: 10, subtotal: 60 })]),
      invoice("inv-2", [line("a2", { qty: 3, unitPrice: 10, subtotal: 30 })]),
    ]);
    await bulk("inv-1", { a1: 8.355 });
    expect(invoices["inv-1"].total).toBe(50.16);
    expect(invoices["inv-2"].total).toBe(25.08); // 3 x 8.36
    expect(stored("inv-2", "a2")).toMatchObject({ unitPrice: 8.36, subtotal: 25.08 });

    await bulk("inv-1", { a1: 8.355 });
    expect([invoices["inv-1"].total, invoices["inv-2"].total]).toEqual([50.16, 25.08]);
  });

  it("BULK at 9.99 over rows the demo left drifted (8.36 / 50.13): 6 x 9.99 = 59.94, not 59.90", async () => {
    arrange([
      invoice("inv-1", [line("a1", { qty: 6, unitPrice: 8.36, subtotal: 50.13 })]),
      invoice("inv-2", [line("a2", { qty: 6, unitPrice: 8.36, subtotal: 50.13 })]),
    ]);
    await bulk("inv-1", { a1: 9.99 });
    expect(stored("inv-1", "a1")).toMatchObject({ unitPrice: 9.99, subtotal: 59.94 });
    expect(stored("inv-2", "a2")).toMatchObject({ unitPrice: 9.99, subtotal: 59.94 });
    expect(invoices["inv-1"].total).toBe(59.94);
  });

  it("a boxed line round trips 10 -> 0.50 -> 10 through the service and lands on its original 14.17", async () => {
    const boxed = line("b1", {
      qty: 17,
      boxes: 1,
      pieces: 5,
      unitsPerBox: 12,
      unitPrice: 10,
      subtotal: 14.17,
    });
    arrange([invoice("inv-1", [boxed])]);
    await single("inv-1", { b1: 0.5 });
    expect(stored("inv-1", "b1").subtotal).toBe(0.71);
    await single("inv-1", { b1: 10 });
    expect(stored("inv-1", "b1")).toMatchObject({ unitPrice: 10, subtotal: 14.17 });
    expect(invoices["inv-1"].total).toBe(14.17);
  });
});
