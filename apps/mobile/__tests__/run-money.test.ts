/**
 * REG-B49: every driver money figure must derive from the server's box-aware line money,
 * never `qty * unitPrice` for a boxed line (spec R2, test-plan T-B49m). `lib/run-money.ts`
 * does not exist as a real implementation yet — imports resolve against a signature-only
 * stub so these fail on assertion, not on module resolution.
 */
import {
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

  it("REG-B305 a short-picked order prorates the draft's tax (incl. category tax) by the delivered share", () => {
    // draft: $100 subtotal, $60 tax (10 regular + 50 per-unit excise). Half
    // delivered -> server bills $50 + $5 regular tax + $25 category tax = $80.
    const draft = { subtotal: 100, taxAmount: 60, discount: 0, shippingFee: 0 };
    expect(reconciledAmountDue({ draft, reconciledSubtotal: 50 })).toBeCloseTo(80, 2);
    // Everything delivered -> the full draft total, unprorated.
    expect(reconciledAmountDue({ draft, reconciledSubtotal: 100 })).toBeCloseTo(160, 2);
  });

  it("REG-B305 falls back to Order.total minus discount when the payload carries no draft", () => {
    expect(orderAmountDue({ lineItems: [], total: 110, discountAmount: 15 } as any)).toBe(95);
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
