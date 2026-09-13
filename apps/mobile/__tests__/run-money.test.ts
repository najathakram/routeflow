/**
 * REG-B49: every driver money figure must derive from the server's box-aware line money,
 * never `qty * unitPrice` for a boxed line (spec R2, test-plan T-B49m). `lib/run-money.ts`
 * does not exist as a real implementation yet — imports resolve against a signature-only
 * stub so these fail on assertion, not on module resolution.
 */
import {
  deliveredCategoryTax,
  lineItemSubtotal,
  orderAmountDue,
  reconciledAmountDue,
  stopAmountDue,
  sumOrderLineItems,
  sumStopOrders,
} from "../lib/run-money";
import { computeLineSubtotal } from "@routeflow/pricing";

describe("lineItemSubtotal (REG-B49)", () => {
  it("uses the server-computed subtotal for a boxed line, never qty * unitPrice", () => {
    // 2 boxes @ $30/box = $60.00. The wrong basis (qty 48 * unitPrice 30) inflates
    // this by unitsPerBox (24x) to $1,440 — the exact bug this test pins.
    const line = {
      qty: 48,
      unitPrice: 30,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 24,
      subtotal: "60.00",
    };
    expect(lineItemSubtotal(line)).toBe(60);
    expect(lineItemSubtotal(line)).not.toBe(1440);
  });

  it("coerces a string-Decimal subtotal via Number()", () => {
    expect(lineItemSubtotal({ qty: 1, unitPrice: 5, subtotal: "12.34" })).toBe(12.34);
  });

  it("falls back to computeLineSubtotal when the line carries no subtotal", () => {
    const line = { qty: 48, unitPrice: 30, boxes: 2, pieces: 0, unitsPerBox: 24 };
    // Oracle: computeLineSubtotal itself (2 box-equivalents * $30 = $60), never NaN/0.
    const expected = computeLineSubtotal({
      unitPrice: 30,
      qty: 48,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 24,
    });
    expect(expected).toBe(60);
    expect(lineItemSubtotal(line)).toBe(60);
  });

  it("preserves qty * unitPrice equivalence for a loose line (unitsPerBox null)", () => {
    const line = { qty: 5, unitPrice: 12, boxes: null, pieces: null, unitsPerBox: null };
    expect(lineItemSubtotal(line)).toBe(60); // 5 * 12, no box proration applies
  });

  it("preserves qty * unitPrice equivalence for a loose line (unitsPerBox 1)", () => {
    expect(lineItemSubtotal({ qty: 3, unitPrice: 10, unitsPerBox: 1 })).toBe(30); // 3 * 10
  });

  it("still prefers a stored subtotal over qty * unitPrice on a loose line", () => {
    expect(lineItemSubtotal({ qty: 5, unitPrice: 12, unitsPerBox: 1, subtotal: "75.00" })).toBe(75);
  });
});

describe("sumOrderLineItems / sumStopOrders (REG-B49)", () => {
  it("sums an order's line items via lineItemSubtotal", () => {
    const order = {
      lineItems: [
        // boxed, server subtotal -> $60.00
        { qty: 48, unitPrice: 30, boxes: 2, pieces: 0, unitsPerBox: 24, subtotal: "60.00" },
        // loose, no subtotal -> falls back to 3 * 10 = $30.00
        { qty: 3, unitPrice: 10, unitsPerBox: 1 },
      ],
    };
    expect(sumOrderLineItems(order)).toBe(90);
  });

  it("sums every order at a stop", () => {
    const stop = {
      orders: [
        {
          lineItems: [
            { qty: 48, unitPrice: 30, boxes: 2, pieces: 0, unitsPerBox: 24, subtotal: "60.00" },
            { qty: 3, unitPrice: 10, unitsPerBox: 1 },
          ],
        },
        { lineItems: [{ qty: 2, unitPrice: 5, unitsPerBox: 1 }] }, // fallback -> $10.00
      ],
    };
    expect(sumStopOrders(stop)).toBe(100);
  });

  it("treats a stop with no orders as zero", () => {
    expect(sumStopOrders({})).toBe(0);
  });
});

/**
 * REG-B305 round 2 (Opus BLOCKER on round 1's basis): `Order.total` carries
 * NO discount and, on a split delivery, bills the WHOLE shipping fee on
 * every visit — it is not what the invoice actually bills. The driver's
 * amount due must be the order's OPEN DRAFT INVOICE as the server last
 * computed it (`order.invoices[0]`: `total = subtotal + taxAmount +
 * shippingFee - discount`). These fixtures pin that basis; before the fix,
 * `orderAmountDue`/`reconciledAmountDue` read `order.total` directly and the
 * discount/split-fee assertions below are red on the WRONG (pre-fix) value,
 * not on a missing export.
 */
describe("REG-B305 tax-inclusive amount due (round 2: read off the draft invoice)", () => {
  it("REG-B305 the bug's own numbers: quotes and collects the draft invoice's total", () => {
    const order = {
      lineItems: [{ qty: 1, unitPrice: 116.83, subtotal: 116.83 }],
      invoices: [
        {
          id: "inv-1",
          subtotal: "116.83",
          taxAmount: "11.68",
          discount: "0",
          shippingFee: "0",
          total: "128.51",
        },
      ],
    };
    expect(orderAmountDue(order as any)).toBe(128.51);
    // Driver collected $130 cash; change should be $1.49, not $13.17 (pre-tax basis).
    const change = Math.max(0, 130 - orderAmountDue(order as any));
    expect(change).toBeCloseTo(1.49, 2);
  });

  it("REG-B305 Opus BLOCKER: a discount on the draft wins, never Order.total's discount-less figure", () => {
    // Order.total (110) carries no discount; the draft (95) is what the
    // invoice actually bills.
    const order = {
      lineItems: [],
      subtotal: 100,
      tax: 10,
      total: 110,
      discountAmount: 15,
      invoices: [
        { id: "inv-1", subtotal: 100, taxAmount: 10, discount: 15, shippingFee: 0, total: 95 },
      ],
    };
    expect(orderAmountDue(order as any)).toBe(95);
    expect(orderAmountDue(order as any)).not.toBe(110);
  });

  it("REG-B305 a split delivery's allocated fee is read off the draft, never Order.total's whole fee", () => {
    // Order.total (121) is the WHOLE shipping fee applied on every visit —
    // the draft carries the fee actually allocated to THIS visit.
    const baseOrder = { lineItems: [], subtotal: 50, tax: 5, total: 121 };
    const firstVisit = {
      ...baseOrder,
      invoices: [
        { id: "inv-1", subtotal: 50, taxAmount: 5, discount: 0, shippingFee: 10, total: 65 },
      ],
    };
    expect(orderAmountDue(firstVisit as any)).toBe(65);
    const secondVisit = {
      ...baseOrder,
      invoices: [
        { id: "inv-2", subtotal: 50, taxAmount: 5, discount: 0, shippingFee: 0, total: 55 },
      ],
    };
    expect(orderAmountDue(secondVisit as any)).toBe(55);
    expect(orderAmountDue(secondVisit as any)).not.toBe(121);
  });

  it("REG-B305 RULING 1: sums ALL open drafts, not just the first (a regulated split can have several)", () => {
    const order = {
      lineItems: [],
      invoices: [
        { id: "base", subtotal: 60, taxAmount: 0, discount: 0, shippingFee: 0, total: 120 },
        { id: "base-R1", subtotal: 40, taxAmount: 0, discount: 0, shippingFee: 0, total: 80 },
      ],
    };
    expect(orderAmountDue(order as any)).toBe(200);
  });

  it("REG-B305 without an open draft the amount due falls back to the pre-tax line sum, never a client-side discount guess", () => {
    // Order.total (110) and discountAmount (15) look like they'd net to 95, but
    // Order.total is only net-of-discount on the CREATE path — an edited/merged
    // order can leave it stale, so re-deriving the discount client-side is never
    // safe (RULING 2). No `invoices` at all -> the honest pre-tax line sum (100).
    const order = {
      lineItems: [{ qty: 2, unitPrice: 50, subtotal: 100 }],
      total: 110,
      discountAmount: 15,
    };
    expect(orderAmountDue(order as any)).toBe(sumOrderLineItems(order as any));
    expect(orderAmountDue(order as any)).toBe(100);
    expect(orderAmountDue(order as any)).not.toBe(95);
  });

  it("REG-B305 falls back to the pre-tax line sum when the payload carries no total at all", () => {
    const order = { lineItems: [{ qty: 2, unitPrice: 10, subtotal: 20 }] };
    expect(orderAmountDue(order as any)).toBe(sumOrderLineItems(order as any));
  });

  it("REG-B305 a malformed total with no draft falls to the line sum, never NaN", () => {
    const order = { lineItems: [{ qty: 2, unitPrice: 10, subtotal: 20 }], total: "abc" };
    const due = orderAmountDue(order as any);
    expect(due).toBe(20);
    expect(Number.isNaN(due)).toBe(false);
  });

  it("REG-B305 coerces string-Decimal draft totals", () => {
    const base = { lineItems: [{ qty: 1, unitPrice: 10, subtotal: 10 }] };
    expect(
      orderAmountDue({
        ...base,
        invoices: [
          {
            id: "i1",
            subtotal: "10",
            taxAmount: "0",
            discount: "0",
            shippingFee: "0",
            total: "10",
          },
        ],
      } as any),
    ).toBe(10);
  });

  it("REG-B305 stopAmountDue mixes a draft-bearing order with a legacy order, never NaN", () => {
    const draftOrder = {
      lineItems: [],
      invoices: [{ id: "i1", subtotal: 50, taxAmount: 5, discount: 0, shippingFee: 0, total: 55 }],
    };
    const legacyOrder = { lineItems: [{ qty: 1, unitPrice: 20, subtotal: 20 }] };
    // No draft AND a malformed total -> falls all the way to the line sum.
    const brokenOrder = { lineItems: [{ qty: 1, unitPrice: 5, subtotal: 5 }], total: "garbage" };
    expect(stopAmountDue({ orders: [draftOrder, legacyOrder, brokenOrder] } as any)).toBe(80);
  });
});

/**
 * REG-B305 round 2 (RULING 3): the short-pick estimate must follow the
 * SERVER's own delivered-basis rule (invoices.service.ts ~1447-1473) — regular
 * tax scales by the delivered share of the ORDER's own subtotal, category tax
 * is the Σ of each DELIVERED line's own snapshot (never the draft's whole
 * `taxAmount` prorated by subtotal share), and discount/fee stay whole.
 * Before the fix, `reconciledAmountDue` prorated the whole draft `taxAmount`
 * uniformly — Opus's A-only worked example below gave $135 (wrong), not $110.
 */
describe("deliveredCategoryTax (REG-B305 RULING 3)", () => {
  it("REG-B305 scales a line's snapshotted category tax by its delivered/ordered qty share", () => {
    const lines = [{ id: "x", qty: 10, unitPrice: 1, categoryTaxAmount: 50 }];
    expect(deliveredCategoryTax(lines, { x: 4 })).toBe(20);
  });

  it("REG-B305 sums across lines; a line missing from the plan defaults to fully delivered", () => {
    const lines = [
      { id: "a", qty: 1, unitPrice: 100, categoryTaxAmount: 0 },
      { id: "b", qty: 1, unitPrice: 100, categoryTaxAmount: 50 },
    ];
    expect(deliveredCategoryTax(lines, { a: 1, b: 0 })).toBe(0);
    expect(deliveredCategoryTax(lines, { a: 0, b: 1 })).toBe(50);
    expect(deliveredCategoryTax(lines, {})).toBe(50); // both default to fully delivered
  });

  it("REG-B305 never divides by zero on a qty-0 line", () => {
    const lines = [{ id: "z", qty: 0, unitPrice: 1, categoryTaxAmount: 50 }];
    expect(deliveredCategoryTax(lines, { z: 0 })).toBe(0);
  });
});

describe("reconciledAmountDue (REG-B305 RULING 3: the server's delivered-basis rule)", () => {
  it("REG-B305 Opus's worked example: category tax follows the DELIVERED lines, never the whole draft tax prorated by subtotal share", () => {
    // order subtotal 200, tax (regular) 20; lines A {subtotal 100, categoryTaxAmount 0}
    // and B {subtotal 100, categoryTaxAmount 50}; one draft {total 270}.
    const order = { subtotal: 200, tax: 20 };
    const drafts = [{ discount: 0, shippingFee: 0 }];
    // Deliver A only: today's helper prorates the WHOLE draft tax by subtotal
    // share (70 * 100/200 = 35) -> 135. The server's own rule instead charges
    // only A's $0 category tax -> 110.
    expect(
      reconciledAmountDue({ drafts, order, deliveredSubtotal: 100, deliveredCategoryTax: 0 }),
    ).toBe(110);
    // Deliver B only: same deliveredSubtotal (100) but B's $50 category tax
    // -> 160 (today's helper can't tell A and B apart and would also say 135).
    expect(
      reconciledAmountDue({ drafts, order, deliveredSubtotal: 100, deliveredCategoryTax: 50 }),
    ).toBe(160);
    // Deliver both -> equals the draft's own total (consistency check).
    expect(
      reconciledAmountDue({ drafts, order, deliveredSubtotal: 200, deliveredCategoryTax: 50 }),
    ).toBe(270);
  });

  it("REG-B305 discount and shipping fee stay WHOLE — only tax and category tax prorate by the delivered share", () => {
    const order = { subtotal: 100, tax: 10 };
    const drafts = [{ discount: 15, shippingFee: 10 }];
    // Deliver half, no category tax: 50 - 15 + 10 + (10 * 50/100) + 0 = 50.
    expect(
      reconciledAmountDue({ drafts, order, deliveredSubtotal: 50, deliveredCategoryTax: 0 }),
    ).toBe(50);
  });

  it("REG-B305 falls back to the bare delivered subtotal (legacy) when the payload carries no open draft", () => {
    expect(
      reconciledAmountDue({
        drafts: [],
        order: { subtotal: 100, tax: 10 },
        deliveredSubtotal: 42,
        deliveredCategoryTax: 5,
      }),
    ).toBe(42);
  });

  it("REG-B305 falls back to the bare delivered subtotal when the order's own subtotal isn't a usable basis", () => {
    expect(
      reconciledAmountDue({
        drafts: [{ discount: 0, shippingFee: 0 }],
        order: { subtotal: 0, tax: 10 },
        deliveredSubtotal: 42,
        deliveredCategoryTax: 0,
      }),
    ).toBe(42);
  });
});
