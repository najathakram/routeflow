import { computeLineSubtotal } from "@routeflow/pricing";
import { buildCounterReceipt, type ReceiptLineInput } from "./counter-receipt";

/**
 * POS-5: an edited counter line (`unitPrice` = the NET price, `tierPrice` = the system price it was rung at) shows the
 * struck original line total, the net and the discount on the receipt. A plain line is exactly what it was.
 */
const NOW = new Date("2026-10-07T15:30:00Z");
const PLAIN: ReceiptLineInput = { tempId: "a", name: "Juice", unitPrice: 5, qty: 1 };
const EDITED: ReceiptLineInput = {
  tempId: "b",
  name: "Cola",
  unitPrice: 9,
  tierPrice: 10,
  override: { mode: "percent", value: 10 },
  qty: 2,
};
/** 12-pack, 24.00 a box, 10% off the box (21.60), 2 boxes + 3 pieces */
const BOXED_EDITED: ReceiptLineInput = {
  tempId: "c",
  name: "Water",
  unitPrice: 21.6,
  tierPrice: 24,
  override: { mode: "percent", value: 10 },
  qty: 27,
  unitsPerBox: 12,
  boxes: 2,
  pieces: 3,
};
const build = (lines: ReceiptLineInput[], total: number) =>
  buildCounterReceipt({
    receipt: {
      orderId: "o1",
      orderNumber: "ORD-1",
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      total,
      paid: total,
      balanceDue: 0,
      paymentRecorded: true,
      method: "CARD",
    } as never,
    lines,
    enteredTender: null,
    profile: null,
    now: NOW,
  });

describe("buildCounterReceipt: edited lines (POS-5)", () => {
  it("a plain line has no original, no discount and no Discounts", () => {
    const m = build([PLAIN], 5);
    expect(m.lines[0]).toMatchObject({
      total: 5,
      original: null,
      discount: 0,
      priceChanged: false,
    });
    expect(m.discounts).toBe(0);
  });

  it("an edited line: original at the tier price, net total, the discount; subtotal is the NET sum", () => {
    const m = build([PLAIN, EDITED], 23);
    expect(m.lines[1]).toMatchObject({ total: 18, original: 20, discount: 2, priceChanged: false });
    expect(m.lines[0].original).toBeNull();
    expect(m.subtotal).toBe(23);
    expect(m.discounts).toBe(2);
    expect(m.adjustment).toBe(0); // the server total equals the net subtotal: nothing unexplained
  });

  it("a boxed edited line is prorated by computeLineSubtotal at both prices, never qty x price", () => {
    const m = build([BOXED_EDITED], 48.6);
    const at = (unitPrice: number) =>
      computeLineSubtotal({ unitPrice, qty: 27, boxes: 2, pieces: 3, unitsPerBox: 12 });
    expect(m.lines[0].total).toBe(at(21.6));
    expect(m.lines[0].original).toBe(at(24));
    expect(m.lines[0].original).toBe(54);
    expect(m.lines[0].discount).toBe(5.4);
    expect(m.discounts).toBe(5.4);
  });

  it("a raised price is Price changed with no discount and nothing in Discounts", () => {
    const raised: ReceiptLineInput = { ...EDITED, unitPrice: 12 };
    const m = build([raised], 24);
    expect(m.lines[0]).toMatchObject({ total: 24, original: 20, discount: 0, priceChanged: true });
    expect(m.discounts).toBe(0);
  });

  it("an override without its tier price (a recovered line) shows no per-line rows", () => {
    const { tierPrice: _drop, ...noTier } = EDITED;
    const m = build([noTier], 18);
    expect(m.lines[0]).toMatchObject({ original: null, discount: 0, priceChanged: false });
  });
});
