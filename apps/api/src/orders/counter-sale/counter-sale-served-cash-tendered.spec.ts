import { buildCounterSaleResponse, servedCashTendered } from "./counter-sale-readback";

/**
 * Row 347 item 2 / row 638 (SA-821): `Order.counterCashTendered` is stored once and never cleared by a later retry, so a
 * sale that ended on a card (or was left on account) still carried the cash the clerk once typed. The read-back served
 * it as `cashTendered` whatever the tender, while `change` was already gated on a CASH-first sale (`servedChange`).
 * `servedCashTendered` is the same first-tender gate for the figure itself: the three readers (POST / by-key response,
 * Today's row, receipt) call it, so what they print as "Tendered" can not outlive the tender it was handed over for.
 */
const cash = { id: "p1", amount: "20.00", method: "CASH", status: "PAID" };
const card = { id: "p2", amount: "20.00", method: "CREDIT_CARD", status: "PAID" };

const inv = (payments: unknown[]) => ({
  id: "inv-1",
  invoiceNumber: "INV-1",
  total: "20.00",
  subtotal: "20.00",
  taxAmount: "0.00",
  items: [] as Array<{ taxRate: string }>,
  payments,
});
const build = (tendered: unknown, payments: unknown[]) =>
  buildCounterSaleResponse({
    order: { id: "o1", orderNumber: "ORD-1", counterCashTendered: tendered },
    invoices: [inv(payments)],
    replayed: false,
  });

describe("servedCashTendered (row 638 / SA-821)", () => {
  it("a sale with a CASH tender serves the stored tendered to the cent", () => {
    expect(servedCashTendered("50", [cash])).toBe(50);
    expect(servedCashTendered("50.005", [cash])).toBe(50.01);
  });

  it("a stale tendered beside a card-only tender is not served (served on master)", () => {
    expect(servedCashTendered("50", [card])).toBeNull();
  });

  it("a sale left on account (no tender stored) serves no tendered", () => {
    expect(servedCashTendered("50", [])).toBeNull();
  });

  it("a voided cash row and a credit-note / advance application are not a cash tender", () => {
    const voided = { ...cash, status: "VOID" };
    const credit = { id: "p3", amount: "5.00", method: "CREDIT_NOTE", status: "PAID" };
    expect(servedCashTendered("50", [voided, card])).toBeNull();
    expect(servedCashTendered("50", [credit, card])).toBeNull();
    expect(servedCashTendered("50", [credit, cash])).toBe(50);
  });

  it("a card-first sale that also has a cash leg still serves it (only the card-only retry is stale)", () => {
    expect(servedCashTendered("50", [card, cash])).toBe(50);
  });

  it("nothing stored serves nothing, whatever the tender", () => {
    expect(servedCashTendered(null, [cash])).toBeNull();
    expect(servedCashTendered(undefined, [cash])).toBeNull();
  });
});

describe("counter-sale response: cashTendered follows the served tender (row 638)", () => {
  it("a cash sale echoes cashTendered", () => {
    expect(build("50", [cash]).cashTendered).toBe(50);
  });

  it("RED on master: a card sale carrying an old cashTendered omits it (the by-key read after a card retry)", () => {
    const r = build("50", [card]);
    expect(r).not.toHaveProperty("cashTendered");
    expect(r.change).toBeUndefined();
  });
});
