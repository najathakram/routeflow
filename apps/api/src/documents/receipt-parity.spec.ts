// The web receipt builders import the product-name helper through the web app's `@/` alias, which this package's Jest does not
// map; it is only reached for a catalogue product, and the fixture's lines are ad-hoc, so a virtual stand-in is enough.
jest.mock(
  "@/lib/product-display",
  () => ({ displayProductName: (p: { name: string }) => p.name }),
  {
    virtual: true,
  },
);

import { roundMoney } from "@routeflow/pricing";
import type { ReceiptModel } from "@routeflow/types";
import { buildCounterReceipt, receiptModelFromOrder } from "../../../web/lib/counter-receipt";
import { buildReceiptModel } from "./receipt-model";
import { BRANDING, INVOICE, orderFixture, paymentsFixture } from "./receipt.fixtures";

/**
 * SA-762r / SA-751r (G1, G4): ONE receipt money model. The counter receipt (live), the Today's-sales reprint and the emailed
 * receipt are built here from ONE sale and must carry the same Tax and Adjustments figures. Placeholders only (acme).
 *
 * The sale: 3 x $2.50 + a boxed line ($15.00) + an ad-hoc line rung at $4.00 off a $5.00 system price (a $1.00 discount) =
 * $26.50 net lines; 8% tax = $2.12; total $28.62, paid $20.00 cash + $8.62 card.
 */
const ZONE = "America/New_York";
/** What the stored invoice lines carry (0.08), and what the Today's-sales row hands the reprint, in percent. */
const STORED_RATE_PERCENT = 8;
const PAID = 28.62; // 20.00 cash + 8.62 card, as the fixture's payments
const MONEY_ROWS = [
  "subtotal",
  "discounts",
  "tax",
  "adjustments",
  "taxRatePercent",
  "total",
  "paid",
  "balanceDue",
  "tendered",
  "change",
] as const satisfies ReadonlyArray<keyof ReceiptModel>;
const moneyRows = (m: ReceiptModel) => Object.fromEntries(MONEY_ROWS.map((k) => [k, m[k]]));

function build(total: string, tax: string) {
  const order = orderFixture({ total, tax });
  const emailModel = buildReceiptModel(order, [INVOICE], paymentsFixture(), BRANDING, ZONE);

  const reprint = receiptModelFromOrder({
    order: {
      orderNumber: "ORD-1001",
      total: Number(total),
      tax: Number(tax),
      lineItems: order.lineItems.map((l) => ({
        id: l.id,
        name: l.name,
        product: l.product,
        qty: Number(l.qty),
        unitPrice: Number(l.unitPrice),
        unitsPerBox: l.unitsPerBox,
        boxes: l.boxes,
        pieces: l.pieces,
        status: l.status,
      })),
    },
    sale: {
      invoiceId: "inv-1",
      invoiceNumber: "INV-2001",
      paid: PAID,
      balanceDue: Math.max(0, roundMoney(Number(total) - PAID)),
      methods: [
        { method: "CASH", amount: 20 },
        { method: "CARD", amount: 8.62 },
      ],
      createdAt: order.createdAt,
      taxRatePercent: STORED_RATE_PERCENT,
      timezone: ZONE,
    },
    profile: { businessName: BRANDING.businessName },
  });

  const live = buildCounterReceipt({
    receipt: {
      orderId: "ord-1",
      orderNumber: "ORD-1001",
      invoiceId: "inv-1",
      invoiceNumber: "INV-2001",
      total: Number(total),
      paid: PAID,
      balanceDue: Math.max(0, roundMoney(Number(total) - PAID)),
      method: "CARD",
      paymentRecorded: true,
    },
    lines: [
      { tempId: "li-1", name: "Cola", unitPrice: 2.5, qty: 3 },
      {
        tempId: "li-2",
        name: "Chips",
        unitPrice: 12,
        qty: 15,
        unitsPerBox: 12,
        boxes: 1,
        pieces: 3,
      },
      { tempId: "li-3", name: "Loose candy", unitPrice: 4, qty: 1, tierPrice: 5, override: {} },
    ],
    enteredTender: null,
    profile: { businessName: BRANDING.businessName, taxRate: STORED_RATE_PERCENT, timezone: ZONE },
    now: order.createdAt,
  });
  return { emailModel, reprint, live };
}

describe("print / reprint / email carry one money model (SA-762r)", () => {
  const { emailModel, reprint, live } = build("28.62", "2.12");

  it("the email's money rows are the reprint's, row for row", () => {
    expect(moneyRows(emailModel)).toEqual(moneyRows(reprint));
    expect(emailModel.tax).toBe(2.12);
    expect(emailModel.adjustments).toBe(0);
    expect(emailModel.taxRatePercent).toBe(8);
  });

  it("the email's lines are the reprint's lines (name, detail, total)", () => {
    const pick = (m: ReceiptModel) => m.lines.map((l) => [l.name, l.detail, l.total]);
    expect(pick(emailModel)).toEqual(pick(reprint));
  });

  it("the live counter receipt shows the same Tax, Adjustments, rate and Total for the same sale", () => {
    for (const k of [
      "tax",
      "adjustments",
      "taxRatePercent",
      "total",
      "paid",
      "balanceDue",
    ] as const)
      expect(live[k]).toBe(emailModel[k]);
  });

  it("the live receipt's Subtotal is at system prices: net lines + the $1.00 discount (Subtotal - Discounts = the email's Subtotal)", () => {
    expect(live.discounts).toBe(1);
    expect(roundMoney(live.subtotal - live.discounts)).toBe(emailModel.subtotal);
  });

  it("every model adds up: Subtotal - Discounts + Tax + Adjustments = Total", () => {
    for (const m of [emailModel, reprint, live])
      expect(roundMoney(m.subtotal - m.discounts + m.tax + m.adjustments)).toBe(m.total);
  });

  it("a sale with something left after tax: email and reprint agree on Tax and Adjustments (the live receipt, which is told no tax figure, can only name it Adjustments)", () => {
    const adj = build("29.62", "2.12");
    expect(moneyRows(adj.emailModel)).toEqual(moneyRows(adj.reprint));
    expect(adj.emailModel).toMatchObject({ tax: 2.12, adjustments: 1, taxRatePercent: 8 });
    expect(adj.live.total).toBe(adj.emailModel.total);
    expect(roundMoney(adj.live.tax + adj.live.adjustments)).toBe(
      roundMoney(adj.emailModel.tax + adj.emailModel.adjustments),
    );
  });

  it("a stored tax that no single rate reproduces: both name no rate and print plain Tax", () => {
    const odd = build("29.00", "2.50");
    expect(moneyRows(odd.emailModel)).toEqual(moneyRows(odd.reprint));
    expect(odd.emailModel.taxRatePercent).toBeNull();
    expect(odd.emailModel.tax).toBe(2.5);
  });
});
