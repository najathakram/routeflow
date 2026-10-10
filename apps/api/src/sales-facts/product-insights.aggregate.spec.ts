import { rangeWindow } from "../analytics/demand-range";
import { aggregateProductInsights } from "./product-insights.aggregate";
import type { ProductCreditEvents, ProductSaleFact } from "./sales-facts.types";

/**
 * #2118 — the pure product aggregator. Every expectation below is hand-computed from the
 * fixture, so the spec states the money rules instead of re-running the code under test.
 */
const NY = "America/New_York";
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

function line(over: Partial<ProductSaleFact> & Pick<ProductSaleFact, "lineId">): ProductSaleFact {
  return {
    lineCreatedAt: new Date("2026-06-01T10:00:00.000Z"),
    invoiceId: `inv-${over.lineId}`,
    invoiceNumber: `INV-${over.lineId}`,
    invoiceStatus: "SENT",
    issueDate: day("2026-06-05"),
    invoiceCreatedAt: new Date("2026-06-05T15:00:00.000Z"),
    orderId: null,
    orderNumber: null,
    customerId: "c1",
    customerName: "Acme Grocers",
    qty: 1,
    subtotal: 1,
    unitPrice: 1,
    originalPrice: null,
    priceType: "STANDARD",
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitLabel: null,
    ...over,
  };
}

// Five lines across June-August (window 2026-06-01..2026-08-31, monthly):
//  L1 boxed  : 2 boxes of 12 = 24 pcs, $60 (box price 30)        c1, order o1, invoice i1
//  L2 unit   : 6 pcs, factor-1 unit snapshot, $24                 c2, no order, invoice i2
//  L3 legacy : qty 10, no split, no snapshot, product boxed today — pieces UNKNOWN (10 boxes or
//              10 pieces?), $30 revenue only                     c1, order o1 again (partial), invoice i3
//  L4 fee    : 0 pcs, $5 (revenue only)                           c2, no order, invoice i4
//  L5 w/off  : 1 box of 12 = 12 pcs, $30, WRITTEN_OFF invoice     c3, order o5, invoice i5
const LINES: ProductSaleFact[] = [
  line({
    lineId: "L1",
    invoiceId: "i1",
    orderId: "o1",
    issueDate: day("2026-06-05"),
    qty: 24,
    boxes: 2,
    pieces: 0,
    unitsPerBox: 12,
    unitPrice: 30,
    subtotal: 60,
  }),
  line({
    lineId: "L2",
    invoiceId: "i2",
    customerId: "c2",
    customerName: "Bodega Two",
    issueDate: day("2026-07-10"),
    qty: 6,
    unitsPerBox: 1,
    unitLabel: "each",
    unitPrice: 4,
    subtotal: 24,
  }),
  line({
    lineId: "L3",
    invoiceId: "i3",
    orderId: "o1",
    issueDate: day("2026-07-20"),
    qty: 10,
    unitPrice: 3,
    subtotal: 30,
  }),
  line({
    lineId: "L4",
    invoiceId: "i4",
    customerId: "c2",
    customerName: "Bodega Two",
    issueDate: day("2026-08-01"),
    qty: 0,
    unitPrice: 5,
    subtotal: 5,
  }),
  line({
    lineId: "L5",
    invoiceId: "i5",
    orderId: "o5",
    invoiceStatus: "WRITTEN_OFF",
    customerId: "c3",
    customerName: "Corner Three",
    issueDate: day("2026-08-15"),
    qty: 12,
    boxes: 1,
    pieces: 0,
    unitsPerBox: 12,
    unitPrice: 30,
    subtotal: 30,
  }),
];

const CREDITS: ProductCreditEvents = {
  attributed: [
    // 23:30 New York on Aug 30 → August, not September.
    {
      at: new Date("2026-08-31T03:30:00.000Z"),
      amount: 10,
      kind: "CREDIT_NOTE",
      customerId: "c1",
      customerName: "Acme Grocers",
    },
    // 23:30 New York on Aug 31 — the last minutes of the window: IN.
    {
      at: new Date("2026-09-01T03:30:00.000Z"),
      amount: 4,
      kind: "EXTERNAL_REFUND",
      customerId: "c2",
      customerName: "Bodega Two",
    },
    // 00:00 New York on Sep 1 — the first instant AFTER the window: OUT.
    {
      at: new Date("2026-09-01T04:00:00.000Z"),
      amount: 7,
      kind: "CREDIT_NOTE",
      customerId: "c1",
      customerName: "Acme Grocers",
    },
    // A buyer present only through a credit.
    {
      at: new Date("2026-06-15T12:00:00.000Z"),
      amount: 1.5,
      kind: "CREDIT_NOTE",
      customerId: "c4",
      customerName: "Dock Four",
    },
  ],
  returned: [
    { at: new Date("2026-07-02T12:00:00.000Z"), qty: 2, customerId: "c1", customerName: null },
    { at: new Date("2026-05-31T12:00:00.000Z"), qty: 5, customerId: "c1", customerName: null },
    // A STANDARD return line whose unit could not be resolved to pieces (B665).
    { at: new Date("2026-08-05T12:00:00.000Z"), qty: null, customerId: "c3", customerName: null },
  ],
  unattributed: [
    { at: new Date("2026-06-10T12:00:00.000Z"), amount: 3.5 },
    { at: new Date("2026-09-02T12:00:00.000Z"), amount: 100 },
  ],
};

const PRODUCT = {
  id: "p1",
  name: "Sparkling Water 12pk",
  sku: "SW-12",
  unitSku: "SW-1",
  barcode: "0123456789012",
  unitsPerBox: 12,
  unitLabel: "case",
  isActive: true,
};

function run(overrides: Partial<Parameters<typeof aggregateProductInsights>[0]> = {}) {
  return aggregateProductInsights({
    product: PRODUCT,
    window: rangeWindow("2026-06-01", "2026-08-31", "month"),
    timezone: NY,
    lines: LINES,
    lifetime: { first: day("2025-01-03"), last: day("2026-08-15") },
    credits: CREDITS,
    productPackNow: 12,
    topBuyers: 50,
    ...overrides,
  });
}

describe("aggregateProductInsights (#2118)", () => {
  it("echoes the window, the basis and the product", () => {
    const res = run();
    expect(res.window).toEqual({
      from: "2026-06-01",
      to: "2026-08-31",
      grain: "month",
      timezone: NY,
    });
    expect(res.basis).toBe("accrual_net");
    expect(res.product).toEqual(PRODUCT);
  });

  it("totals: pieces, gross, credits on their own tenant-local days, net via netOf", () => {
    expect(run().totals).toEqual({
      invoicedQtyPieces: 42, // 24 + 6 + 0 + 12 — L3's pieces are unknown, never its bare qty
      unresolvedSaleLines: 1, // L3: counted, never guessed into pieces
      returnedQtyPieces: 2, // the May 31 return is outside the window
      unresolvedReturnLines: 1, // counted, never guessed into pieces
      netQtyPieces: 40,
      // 24/12 + 6/1 + 12/12 — the legacy line (unknown pack) is excluded.
      sellingUnits: 9,
      sellingUnitPack: null,
      legacyLines: 1,
      mixedPackSizes: true,
      lineGross: 149,
      attributedCredits: 15.5, // 10 + 4 + 1.5; the Sep 1 00:00 credit is out
      lineNet: 133.5,
      unattributedCredits: 3.5,
      invoices: 5,
      orders: 4, // o1 (two invoices, one event), i2, i4, o5
      buyers: 3, // purchasers only
      firstSaleAt: "2025-01-03",
      lastSaleAt: "2026-08-15",
    });
  });

  it("price facts stay on ONE axis: per piece, from subtotals, fee lines excluded", () => {
    expect(run().price).toEqual({
      avgPerPiece: 2.71, // (60 + 24 + 30) / 42 — L3 (unknown pieces) and the fee line are out
      avgPerSellingUnit: 12.67, // (60 + 24 + 30) / 9 selling units
      last: {
        unitPrice: 30,
        unitLabel: null,
        unitsPerBox: 12,
        perPiece: 2.5,
        date: "2026-08-15",
        customerId: "c3",
        customer: "Corner Three",
      },
      minPerPiece: 2.5, // L1 60/24 and L5 30/12 — never L5's $30 box price
      maxPerPiece: 4, // L2 24/6
    });
  });

  it("pack-snapshot rule: a line whose pieces the stored line cannot give adds revenue only", () => {
    // A no-split line with a BOXED snapshot (B644: qty 3 may be 3 boxes) on a product that is
    // NOT boxed today: the snapshot, never today's pack, decides — unknown.
    const b644 = line({ lineId: "b644", qty: 3, unitsPerBox: 12, unitPrice: 30, subtotal: 90 });
    // A snapshot-1 line on a product boxed today: its own snapshot says pieces.
    const one = line({ lineId: "one", qty: 4, unitsPerBox: 1, unitPrice: 2, subtotal: 8 });
    const res = run({
      lines: [b644, one],
      productPackNow: null,
      credits: { attributed: [], returned: [], unattributed: [] },
    });
    expect(res.totals).toMatchObject({
      invoicedQtyPieces: 4,
      unresolvedSaleLines: 1,
      lineGross: 98, // revenue keeps the unknown line
    });
    expect(res.price).toMatchObject({ avgPerPiece: 2, minPerPiece: 2, maxPerPiece: 2 });
    expect(res.series.reduce((s, p) => s + p.qtyPieces, 0)).toBe(4);
    expect(res.buyers[0]).toMatchObject({ qtyPieces: 4, lineGross: 98, avgPerPiece: 2 });

    const boxedToday = run({
      lines: [one],
      productPackNow: 12,
      credits: { attributed: [], returned: [], unattributed: [] },
    });
    expect(boxedToday.totals).toMatchObject({ invoicedQtyPieces: 4, unresolvedSaleLines: 0 });
  });

  it("SA-289: unattributed credits sit BESIDE the product net — never subtracted, never prorated", () => {
    const res = run();
    expect(res.totals.unattributedCredits).toBe(3.5);
    // lineNet = lineGross − attributedCredits exactly; the 3.50 footnote touches neither.
    expect(res.totals.lineNet).toBe(res.totals.lineGross - res.totals.attributedCredits);
    const noFootnote = run({ credits: { ...CREDITS, unattributed: [] } });
    expect(noFootnote.totals.lineNet).toBe(res.totals.lineNet);
    expect(noFootnote.series).toEqual(res.series);
    expect(noFootnote.buyers).toEqual(res.buyers);
  });

  it("series: one zero-filled point per bucket, credits in the bucket of their local day", () => {
    expect(run().series).toEqual([
      {
        date: "2026-06-01",
        qtyPieces: 24,
        returnedQtyPieces: 0,
        lineGross: 60,
        credits: 1.5,
        lineNet: 58.5,
        avgPerPiece: 2.5,
      },
      {
        date: "2026-07-01",
        qtyPieces: 6, // L2 only — L3's pieces are unknown
        returnedQtyPieces: 2,
        lineGross: 54, // L3's $30 still counts as revenue
        credits: 0,
        lineNet: 54,
        avgPerPiece: 4, // 24 / 6 — L3 has no per-piece price
      },
      {
        date: "2026-08-01",
        qtyPieces: 12,
        returnedQtyPieces: 0,
        lineGross: 35,
        credits: 14,
        lineNet: 21,
        avgPerPiece: 2.5, // the $5 fee line has no pieces: revenue only
      },
    ]);
  });

  it("series sums reconcile with the totals (one collection feeds both — L-119)", () => {
    const res = run();
    const sum = (k: "lineGross" | "credits" | "lineNet" | "qtyPieces") =>
      Math.round(res.series.reduce((s, p) => s + p[k], 0) * 100) / 100;
    expect(sum("lineGross")).toBe(res.totals.lineGross);
    expect(sum("credits")).toBe(res.totals.attributedCredits);
    expect(sum("lineNet")).toBe(res.totals.lineNet);
    expect(sum("qtyPieces")).toBe(res.totals.invoicedQtyPieces);
  });

  it("buyers: ranked by gross, events per ORDER, a credit-only buyer kept, shares of gross", () => {
    const res = run();
    expect(res.buyersTotal).toBe(4);
    expect(res.buyers).toEqual([
      {
        customerId: "c1",
        name: "Acme Grocers",
        qtyPieces: 24, // L1 only — L3's pieces are unknown
        lineGross: 90,
        lineNet: 80,
        orders: 1, // one order billed on two invoices
        lastDate: "2026-07-20", // L3 is still a purchase day
        lastPerPiece: 2.5, // L1: the newest line with KNOWN pieces
        avgPerPiece: 2.5, // 60 / 24
        share: 0.604, // 90 / 149 = 0.60402…
      },
      {
        customerId: "c3",
        name: "Corner Three",
        qtyPieces: 12,
        lineGross: 30,
        lineNet: 30,
        orders: 1,
        lastDate: "2026-08-15",
        lastPerPiece: 2.5,
        avgPerPiece: 2.5,
        share: 0.2013,
      },
      {
        customerId: "c2",
        name: "Bodega Two",
        qtyPieces: 6,
        lineGross: 29,
        lineNet: 25,
        orders: 2,
        lastDate: "2026-08-01", // the fee line is still a purchase day
        lastPerPiece: 4, // …but has no per-piece price; the newest priced line does
        avgPerPiece: 4,
        share: 0.1946,
      },
      {
        customerId: "c4",
        name: "Dock Four",
        qtyPieces: 0,
        lineGross: 0,
        lineNet: -1.5,
        orders: 0,
        lastDate: null,
        lastPerPiece: null,
        avgPerPiece: null,
        share: 0,
      },
    ]);
  });

  it("buyers net reconciles with the totals net", () => {
    const res = run();
    const net = Math.round(res.buyers.reduce((s, b) => s + b.lineNet, 0) * 100) / 100;
    expect(net).toBe(res.totals.lineNet);
  });

  it("cuts the buyer list to the top N but keeps buyersTotal", () => {
    const res = run({ topBuyers: 2 });
    expect(res.buyers.map((b) => b.customerId)).toEqual(["c1", "c3"]);
    expect(res.buyersTotal).toBe(4);
    expect(run({ topBuyers: "all" }).buyers).toHaveLength(4);
  });

  it("one pack size only: sellingUnitPack names it and mixedPackSizes is false", () => {
    const res = run({ lines: [LINES[0], LINES[4]] });
    expect(res.totals).toMatchObject({
      sellingUnits: 3,
      sellingUnitPack: 12,
      mixedPackSizes: false,
      legacyLines: 0,
    });
    expect(res.price.avgPerSellingUnit).toBe(30); // (60 + 30) / 3 boxes
  });

  it("an unknown product pack (live pack not supplied) never turns a no-snapshot line into pieces", () => {
    const res = run({ lines: [LINES[2]], productPackNow: undefined });
    expect(res.totals).toMatchObject({
      legacyLines: 1,
      sellingUnits: 0,
      sellingUnitPack: null,
      invoicedQtyPieces: 0,
      unresolvedSaleLines: 1,
      lineGross: 30,
    });
    expect(res.price.avgPerSellingUnit).toBeNull();
    expect(res.price.avgPerPiece).toBeNull();
  });

  it("a no-snapshot line on a product that exists and is NOT boxed today counts its qty as pieces", () => {
    const res = run({ lines: [LINES[2]], productPackNow: null });
    expect(res.totals).toMatchObject({ invoicedQtyPieces: 10, unresolvedSaleLines: 0 });
    expect(res.price.avgPerPiece).toBe(3);
  });

  it("an empty window: zeros everywhere, nulls for prices, lifetime dates kept (never sold ≠ quiet window)", () => {
    const res = run({ lines: [], credits: { attributed: [], returned: [], unattributed: [] } });
    expect(res.series).toHaveLength(3);
    expect(res.series.every((p) => p.lineGross === 0 && p.avgPerPiece === null)).toBe(true);
    expect(res.totals).toMatchObject({
      invoicedQtyPieces: 0,
      lineGross: 0,
      lineNet: 0,
      buyers: 0,
      firstSaleAt: "2025-01-03",
    });
    expect(res.price).toEqual({
      avgPerPiece: null,
      avgPerSellingUnit: null,
      last: null,
      minPerPiece: null,
      maxPerPiece: null,
    });
    expect(res.buyers).toEqual([]);
    const never = run({ lines: [], lifetime: { first: null, last: null } });
    expect(never.totals.firstSaleAt).toBeNull();
    expect(never.totals.lastSaleAt).toBeNull();
  });

  it("rounds money to cents and pieces to 3dp (no float drift reaches the payload)", () => {
    const res = run({
      lines: [
        line({ lineId: "a", qty: 0.333, subtotal: 0.1 }),
        line({ lineId: "b", qty: 0.333, subtotal: 0.2 }),
        line({ lineId: "c", qty: 0.333, subtotal: 0.005 }),
      ],
      productPackNow: null, // never boxed: a bare qty is pieces
      credits: { attributed: [], returned: [], unattributed: [] },
    });
    expect(res.totals.lineGross).toBe(0.31);
    expect(res.totals.invoicedQtyPieces).toBe(0.999);
  });
});
