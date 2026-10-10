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
 *   3. a line whose split no pack can price keeps the old proportional recovery while its stored price and
 *      total are above $0; from a stored $0 it REFUSES (400 MONEY_INVARIANT), never `price x qty` (SA-698a).
 * The real-Postgres twin is price-adjustment-whole-cents-b1120.db.spec.ts.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: class InvoicePdfService {} }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../common/msrp", () => ({ loadMsrpMap: jest.fn().mockResolvedValue(new Map()) }));

import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException, ValidationPipe } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { InvoicesService } from "./invoices.service";
import { applyBulkPriceAdjustment, buildPriceAdjustmentUpdates } from "./price-adjustment-ledger";
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

const build = (items: Row[], prices: Record<string, number>, invoiceStatus?: string) =>
  buildPriceAdjustmentUpdates({
    items,
    localPriceMap: new Map(Object.entries(prices)),
    categoriesById: new Map(),
    unitsPerBoxByProduct: new Map(),
    isTaxExempt: false,
    invoiceStatus,
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
      // stored at a price of 10 (never at the price the typed one rounds to, which would leave the line alone)
      const [u] = build([line("i1", { qty, unitPrice: 10, subtotal: 10 * qty })], { i1: typed });
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

  it("re-applying the same prices leaves the line ALONE (no update at all), executed over every cent price from 0.01 to 20.00", () => {
    const updated: number[] = [];
    for (let cents = 1; cents <= 2000; cents++) {
      const price = cents / 100;
      const base = line("i1", { qty: 7, unitPrice: 25, subtotal: 175 }); // 25 is outside the swept 0.01 to 20.00
      const first = build([base], { i1: price })[0].data;
      const stored = line("i1", { qty: 7, unitPrice: first.unitPrice, subtotal: first.subtotal });
      if (build([stored], { i1: price }).length !== 0) updated.push(price); // SA-640 / SA-698b: untouched means untouched
    }
    expect(updated).toEqual([]);
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

  it("a split with its pack missing (boxes 0, pieces 5, no snapshot) keeps the proportional recovery (5 pieces of an $11.00 case re-priced to $12.00 are $5.00)", () => {
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

  it("re-applying the SAME price on the fallback line is the identity over EVERY cent price 0.01 to 30.00, a $0.00 gross included: no refusal, no update", () => {
    const touched: number[] = [];
    let zeroGross = 0;
    for (let cents = 1; cents <= 3000; cents++) {
      const price = cents / 100;
      const start = roundMoney((price * 5) / 12);
      for (const discount of [0, 0.5]) {
        const row = { ...legacy(price, start), discount };
        if (start + discount === 0) zeroGross++;
        const out = attempt(() => build([row], { l1: price }));
        if (!Array.isArray(out) || out.length !== 0) touched.push(price); // a throw or an update both fail
      }
    }
    expect(touched).toEqual([]);
    expect(zeroGross).toBeGreaterThan(0); // the sub-12-cent prices, whose 5/12 share rounds to $0.00
  });

  it("one round trip moves the total by at most 1/2 cent x A/B + 1/2 cent, and by at most 1 cent when B is at least half of A (executed sweep)", () => {
    let worstWithinRatio = 0;
    let checked = 0;
    for (let a = 100; a <= 3000; a += 3) {
      const priceA = a / 100;
      for (const priceB of [0.25, 1, 5, priceA * 0.5, priceA * 0.75, priceA * 1.5, priceA * 2]) {
        const b = roundMoney(priceB);
        if (b <= 0 || b === priceA) continue; // a price left unchanged is skipped, not re-based
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

/** Runs `fn` and returns what it returned, or what it threw: the persisted/returned value shows in a red run. */
const attempt = <T>(fn: () => T): T | unknown => {
  try {
    return fn();
  } catch (e) {
    return e;
  }
};
const codeOf = (e: unknown): unknown =>
  ((e as BadRequestException).getResponse?.() as { code?: string } | undefined)?.code;
/** What a re-price LANDED as, or "refused": a red run prints the line it wrongly wrote. */
const landed = (out: unknown): unknown => (Array.isArray(out) ? out[0].data : "refused");

describe("buildPriceAdjustmentUpdates: a pack-less legacy split is never re-priced from a stored price or total of 0 (B1120, SA-698a/b)", () => {
  /** qty 5 as boxes 0 + pieces 5, no pack snapshot, none derivable: 5/12 of a case at $10 = $4.17 stored. */
  const legacy = (price: number, subtotal: number, over: Row = {}) =>
    line("l1", {
      description: "Legacy Case",
      qty: 5,
      boxes: 0,
      pieces: 5,
      unitsPerBox: null,
      unitPrice: price,
      subtotal,
      ...over,
    });
  /** N1: the remedy depends on the invoice. A DRAFT can be edited; an issued invoice needs a credit note or a reissue. */
  const DRAFT_REMEDY = "Re-enter this line's quantity and price.";
  const ISSUED_REMEDY = "Issue a credit note, or void and reissue the invoice.";

  it.each([
    ["DRAFT", DRAFT_REMEDY, ISSUED_REMEDY],
    ["SENT", ISSUED_REMEDY, DRAFT_REMEDY],
    ["PARTIAL", ISSUED_REMEDY, DRAFT_REMEDY],
    ["OVERDUE", ISSUED_REMEDY, DRAFT_REMEDY],
  ])(
    "10 -> 0 -> 10 on a %s invoice: the step up from $0 is refused (MONEY_INVARIANT, names the line, the right remedy), never $50.00",
    (status, remedy, notRemedy) => {
      const atZero = build([legacy(10, 4.17)], { l1: 0 }, status)[0].data;
      expect(atZero).toMatchObject({ unitPrice: 0, subtotal: 0 }); // going to $0 is a real price and is allowed

      // today this returns subtotal 50 (price x qty: the `: qty` arm, 5 pieces billed at the case price)
      const out = attempt(() => build([legacy(0, 0)], { l1: 10 }, status));
      expect(landed(out)).toBe("refused");
      expect(out).toBeInstanceOf(BadRequestException);
      expect(codeOf(out)).toBe("MONEY_INVARIANT");
      expect((out as Error).message).toContain('"Legacy Case"');
      expect((out as Error).message).toContain(remedy);
      expect((out as Error).message).not.toContain(notRemedy);
    },
  );

  it("with no invoice status the copy is the issued-invoice one (never advise re-entering a line that cannot be edited)", () => {
    const out = attempt(() => build([legacy(0, 0)], { l1: 10 }));
    expect((out as Error).message).toContain(ISSUED_REMEDY);
  });

  it("a gross of 0 with a positive stored price (stored $0.00 total, no discount) is refused when its price CHANGES", () => {
    const out = attempt(() => build([legacy(0.05, 0)], { l1: 7 }, "DRAFT"));
    expect(landed(out)).toBe("refused");
    expect(out).toBeInstanceOf(BadRequestException);
    expect(codeOf(out)).toBe("MONEY_INVARIANT");
  });

  it("N2: 10 -> 0.01 is refused up front, because its new gross rounds to $0.00 and would strand the line", () => {
    // today: lands {unitPrice 0.01, subtotal 0}; the next re-price of that row is then refused for good
    const out = attempt(() => build([legacy(10, 4.17)], { l1: 0.01 }, "DRAFT"));
    expect(landed(out)).toBe("refused");
    expect(out).toBeInstanceOf(BadRequestException);
    expect(codeOf(out)).toBe("MONEY_INVARIANT");
    expect((out as Error).message).toContain('"Legacy Case"');
    expect((out as Error).message).toContain("$0.00");
  });

  it("N2 controls: the smallest price whose gross still rounds above $0.00 is allowed, and so is an explicit $0", () => {
    // 0.25 x (4.17 / 10) = 0.104 -> $0.10; 0.12 x 0.417 = 0.05 -> $0.05; 0.01 x 0.417 = 0.004 -> $0.00 (refused above)
    expect(build([legacy(10, 4.17)], { l1: 0.25 })[0].data).toMatchObject({ subtotal: 0.1 });
    expect(build([legacy(10, 4.17)], { l1: 0.12 })[0].data).toMatchObject({ subtotal: 0.05 });
    expect(build([legacy(10, 4.17)], { l1: 0 })[0].data).toMatchObject({
      unitPrice: 0,
      subtotal: 0,
    });
  });

  it("controls: a recoverable row (price > 0, gross > 0) still re-prices, and the discount is part of the gross", () => {
    expect(build([legacy(10, 4.17)], { l1: 12 })[0].data).toMatchObject({
      unitPrice: 12,
      subtotal: 5,
    });
    // a $0.00 net line that was $4.17 gross before a $4.17 discount recovers
    expect(build([legacy(10, 0, { discount: 4.17 })], { l1: 12 })[0].data.subtotal).toBe(0.83);
  });

  describe("SA-698b: a line whose price is UNCHANGED is left alone before anything is re-derived or refused", () => {
    /** The panel sends EVERY line with its current price; A is pack-less $5.00 with a $0.00 gross. */
    const A = () => legacy(5, 0, { id: "a", description: "Pack-less A" });
    const B = () => line("b", { description: "Line B", unitPrice: 10, subtotal: 60, qty: 6 });

    it("A at its unchanged 5.00 and B 10 -> 12: B is re-priced, A gets no update (today: a 400 naming A)", () => {
      const out = attempt(() => build([A(), B()], { a: 5, b: 12 }, "SENT"));
      // today this refuses ("Line item \"Pack-less A\" can't be re-priced"), so the value shows what landed
      expect(out instanceof Error ? (out as Error).message : "no refusal").toBe("no refusal");
      expect((out as ReturnType<typeof build>).map((x) => x.id)).toEqual(["b"]);
      expect((out as ReturnType<typeof build>)[0].data).toMatchObject({
        unitPrice: 12,
        subtotal: 72,
      });
    });

    it("the same when the typed price only differs by sub-cent noise (rounded to the stored price first)", () => {
      const out = attempt(() => build([A(), B()], { a: 5.004, b: 12 }));
      expect((out as ReturnType<typeof build>).map((x) => x.id)).toEqual(["b"]);
    });

    it("a stored LEGACY NEGATIVE line at its unchanged price does not block the panel", () => {
      const negative = line("n", {
        description: "Legacy negative",
        unitPrice: 5,
        discount: 50,
        subtotal: -45,
        qty: 1,
      });
      // today: the negative line is re-derived (-45) and the whole save is refused with the B1031 message
      const out = attempt(() => build([negative, B()], { n: 5, b: 12 }));
      expect(out instanceof Error ? (out as Error).message : "no refusal").toBe("no refusal");
      expect((out as ReturnType<typeof build>).map((x) => x.id)).toEqual(["b"]);
    });

    it("a CHANGED price on that negative line is still judged (the guard is not weakened)", () => {
      const negative = line("n", {
        description: "Legacy negative",
        unitPrice: 5,
        discount: 50,
        subtotal: -45,
        qty: 1,
      });
      const out = attempt(() => build([negative], { n: 6 }));
      expect(out).toBeInstanceOf(BadRequestException);
      expect((out as Error).message).toContain("negative subtotal");
    });

    it("every line unchanged: no updates, nothing refused", () => {
      expect(build([A(), B()], { a: 5, b: 10 })).toEqual([]);
    });
  });

  it("a boxed line whose pack IS derivable round trips 10 -> 0 -> 10 back to $14.17 (master bills $170.00: 17 x $10)", () => {
    const boxed = (price: number, subtotal: number) =>
      line("b1", { qty: 17, boxes: 1, pieces: 5, unitsPerBox: 12, unitPrice: price, subtotal });
    const atZero = build([boxed(10, 14.17)], { b1: 0 })[0].data;
    expect(atZero).toMatchObject({ unitPrice: 0, subtotal: 0 });
    expect(build([boxed(0, 0)], { b1: 10 })[0].data).toMatchObject({
      unitPrice: 10,
      subtotal: 14.17,
    });
    // the same with the pack read from the line's own split, no snapshot (boxes 2 + pieces 3 of qty 27)
    const own = (price: number, subtotal: number) =>
      line("b2", { qty: 27, boxes: 2, pieces: 3, unitsPerBox: null, unitPrice: price, subtotal });
    expect(build([own(0, 0)], { b2: 12 })[0].data.subtotal).toBe(27);
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

  /** Two lines so the invoice total never reaches $0 (a $0 invoice settles to PAID, which refuses every re-price). */
  const legacyLine = (id: string, price: number, subtotal: number, over: Row = {}) =>
    line(id, {
      description: "Legacy Case",
      qty: 5,
      boxes: 0,
      pieces: 5,
      unitsPerBox: null,
      unitPrice: price,
      subtotal,
      ...over,
    });
  const ISSUED_REMEDY = "Issue a credit note, or void and reissue the invoice.";
  const DRAFT_REMEDY = "Re-enter this line's quantity and price.";
  /** A deep copy of a stored line, to prove an untouched row is byte-identical afterwards. */
  const snapshotOf = (invId: string, itemId: string) =>
    JSON.parse(JSON.stringify(stored(invId, itemId)));

  it.each([
    [InvoiceStatus.DRAFT, DRAFT_REMEDY],
    [InvoiceStatus.SENT, ISSUED_REMEDY],
  ])(
    "SINGLE on a %s invoice: a pack-less row stored at $0 refuses a re-price to $10 (400 MONEY_INVARIANT, the right remedy) and writes nothing",
    async (status, remedy) => {
      arrange([
        invoice(
          "inv-1",
          [legacyLine("a", 0, 0), line("p", { qty: 1, unitPrice: 5, subtotal: 5 })],
          {
            status,
          },
        ),
      ]);

      const out = await single("inv-1", { a: 10, p: 5 }).then(
        () => "applied" as const,
        (e: unknown) => e,
      );

      // persisted first, so a red run names the wrong value: today the row lands at 10.00 / 50.00
      expect(stored("inv-1", "a")).toMatchObject({ unitPrice: 0, subtotal: 0 });
      expect(invoices["inv-1"].total).toBe(5);
      expect(out).toBeInstanceOf(BadRequestException);
      expect(codeOf(out)).toBe("MONEY_INVARIANT");
      expect((out as Error).message).toContain(remedy);
      expect(prisma.invoiceItem.update).not.toHaveBeenCalled();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    },
  );

  it("SA-698b SINGLE (the panel's payload): A pack-less 5.00 / $0.00 gross sent UNCHANGED, B 10 -> 12: B is re-priced, A's row is byte-identical", async () => {
    arrange([
      invoice("inv-1", [
        legacyLine("a", 5, 0, { description: "Pack-less A" }),
        line("b", { description: "Line B", qty: 6, unitPrice: 10, subtotal: 60 }),
      ]),
    ]);
    const aBefore = snapshotOf("inv-1", "a");

    const out = await single("inv-1", { a: 5, b: 12 }).then(
      () => "applied" as const,
      (e: unknown) => e,
    );

    // today: a 400 naming A, and nothing re-priced
    expect(out instanceof Error ? out.message : out).toBe("applied");
    expect(stored("inv-1", "b")).toMatchObject({ unitPrice: 12, subtotal: 72 });
    expect(stored("inv-1", "a")).toEqual(aBefore);
    expect(invoices["inv-1"].total).toBe(72);
    const written = prisma.invoiceItem.update.mock.calls.map((c: any[]) => c[0].where.id);
    expect(written).toEqual(["b"]); // A was never even written
  });

  it("SA-698b SINGLE: a stored LEGACY NEGATIVE line at its unchanged price does not block the panel, and its row is byte-identical", async () => {
    arrange([
      invoice("inv-1", [
        line("n", {
          description: "Legacy negative",
          qty: 1,
          unitPrice: 5,
          discount: 50,
          subtotal: -45,
        }),
        line("b", { description: "Line B", qty: 6, unitPrice: 10, subtotal: 60 }),
      ]),
    ]);
    const nBefore = snapshotOf("inv-1", "n");

    const out = await single("inv-1", { n: 5, b: 12 }).then(
      () => "applied" as const,
      (e: unknown) => e,
    );

    // today: the B1031 negative-subtotal 400, because the unchanged negative line was re-derived
    expect(out instanceof Error ? out.message : out).toBe("applied");
    expect(stored("inv-1", "b")).toMatchObject({ unitPrice: 12, subtotal: 72 });
    expect(stored("inv-1", "n")).toEqual(nBefore);
  });

  it("SA-698b BULK: a batch carrying A at its unchanged price succeeds for the other lines, on both invoices", async () => {
    const withA = (n: number) => [
      legacyLine(`a${n}`, 5, 0, { productId: "prod-a", description: "Pack-less A" }),
      line(`b${n}`, {
        productId: "prod-b",
        description: "Line B",
        qty: 6,
        unitPrice: 10,
        subtotal: 60,
      }),
    ];
    arrange([invoice("inv-1", withA(1)), invoice("inv-2", withA(2))]);
    const before = [snapshotOf("inv-1", "a1"), snapshotOf("inv-2", "a2")];

    const out = await bulk("inv-1", { a1: 5, b1: 12 }).then(
      () => "applied" as const,
      (e: unknown) => e,
    );

    // today: the pre-flight refuses the whole batch naming the pack-less line, and nothing is re-priced
    expect(out instanceof Error ? out.message : out).toBe("applied");
    expect(stored("inv-1", "b1")).toMatchObject({ unitPrice: 12, subtotal: 72 });
    expect(stored("inv-2", "b2")).toMatchObject({ unitPrice: 12, subtotal: 72 });
    expect([stored("inv-1", "a1"), stored("inv-2", "a2")]).toEqual(before);
  });

  it("BULK: the refusal names the invoice with the code, and NOTHING is written to the batch (the all-or-nothing pre-flight)", async () => {
    arrange([
      invoice("inv-1", [line("a1", { qty: 6, unitPrice: 10, subtotal: 60 })]),
      invoice("inv-2", [legacyLine("a2", 0, 0)]),
    ]);

    const out = await bulk("inv-1", { a1: 9 }).then(
      () => "applied" as const,
      (e: unknown) => e,
    );

    expect(stored("inv-1", "a1")).toMatchObject({ unitPrice: 10, subtotal: 60 }); // the sound invoice was NOT re-priced
    expect(stored("inv-2", "a2")).toMatchObject({ unitPrice: 0, subtotal: 0 }); // today: 9.00 / 45.00
    expect(out).toBeInstanceOf(BadRequestException);
    expect(codeOf(out)).toBe("MONEY_INVARIANT");
    expect((out as Error).message).toContain("Invoice INV-inv-2:");
    expect((out as Error).message).toContain(ISSUED_REMEDY); // inv-2 is SENT: its own status picks the copy
    expect(prisma.invoiceItem.update).not.toHaveBeenCalled();
  });

  it("BULK race: if the refusal surfaces inside a later invoice's tx, the report carries refused.code MONEY_INVARIANT (a KNOWN code), not a crash", async () => {
    const good = invoice("inv-1", [line("a1", { qty: 6, unitPrice: 10, subtotal: 60 })]);
    const bad = invoice("inv-2", [legacyLine("a2", 0, 0)]);
    const plans = [
      { inv: good, localMap: new Map([["a1", 9]]) },
      { inv: bad, localMap: new Map([["a2", 10]]) },
    ];
    const out: any = await applyBulkPriceAdjustment(
      plans as any,
      async (inv, localMap, onCommitted) => {
        buildPriceAdjustmentUpdates({
          items: (inv as Row).items,
          localPriceMap: localMap,
          categoriesById: new Map(),
          unitsPerBoxByProduct: new Map(),
          isTaxExempt: false,
        });
        onCommitted();
      },
    ).catch((e: unknown) => e);

    expect(out).toBeInstanceOf(ConflictException);
    expect(out.getResponse()).toMatchObject({
      code: "PRICE_ADJUSTMENT_PARTIAL",
      applied: ["inv-1"],
      skipped: [],
      refused: { invoiceId: "inv-2", invoiceNumber: "INV-inv-2", code: "MONEY_INVARIANT" },
    });
  });
});
