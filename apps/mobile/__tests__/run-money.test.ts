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
 * REG-B305: the driver "amount due" must be the tax-inclusive total the invoice
 * will actually bill, not the pre-tax line subtotal — `sumOrderLineItems` alone
 * (REG-B49 above) undercharges by the order's tax whenever the tenant has a
 * non-zero tax rate. `orderAmountDue`/`stopAmountDue`/`reconciledAmountDue` do
 * not exist in `lib/run-money.ts` yet, so every assertion below is red on
 * missing export (a TypeError calling `undefined` as a function) until the fix
 * adds them.
 */
describe("REG-B305 tax-inclusive amount due", () => {
  // The bug's own numbers: invoice $128.51, driver screen asked $116.83 (pre-tax).
  const taxedOrder = {
    lineItems: [{ qty: 1, unitPrice: 116.83, subtotal: 116.83 }],
    subtotal: "116.83",
    tax: "11.68",
    total: "128.51",
  };

  it("REG-B305 a stop on a tenant with a non-zero tax rate quotes and collects the tax-inclusive amount due", () => {
    expect(orderAmountDue(taxedOrder as any)).toBe(128.51);
    expect(stopAmountDue({ orders: [taxedOrder] } as any)).toBe(128.51);
    // Documents the wrong value: the legacy pre-tax helper still returns the bare subtotal.
    expect(sumOrderLineItems(taxedOrder as any)).toBe(116.83);
  });

  it("REG-B305 change is computed off the tax-inclusive amount", () => {
    // Driver collected $130 cash; change should be $1.49, not $13.17 (pre-tax basis).
    const change = Math.max(0, 130 - orderAmountDue(taxedOrder as any));
    expect(change).toBeCloseTo(1.49, 2);
  });

  it("REG-B305 a short-picked order prorates the order's tax by the delivered share", () => {
    // Half the goods delivered → half the tax carried forward.
    expect(
      reconciledAmountDue({
        orderSubtotal: 116.83,
        orderTax: 11.68,
        orderTotal: 128.51,
        reconciledSubtotal: 58.415,
      }),
    ).toBeCloseTo(64.26, 2);

    // Everything delivered → the full order total, unprorated.
    expect(
      reconciledAmountDue({
        orderSubtotal: 116.83,
        orderTax: 11.68,
        orderTotal: 128.51,
        reconciledSubtotal: 116.83,
      }),
    ).toBeCloseTo(128.51, 2);
  });

  it("REG-B305 falls back to the pre-tax line sum when the payload carries no server total", () => {
    const order = { lineItems: [{ qty: 2, unitPrice: 10, subtotal: 20 }] };
    expect(orderAmountDue(order as any)).toBe(sumOrderLineItems(order as any));
  });

  it("REG-B305 coerces string-Decimal totals", () => {
    const base = { lineItems: [{ qty: 1, unitPrice: 10, subtotal: 10 }] };
    expect(orderAmountDue({ ...base, total: "128.51" } as any)).toBe(128.51);
    expect(orderAmountDue({ ...base, total: 128.51 } as any)).toBe(128.51);
    expect(orderAmountDue({ ...base, total: null } as any)).toBe(sumOrderLineItems(base as any));
  });
});
