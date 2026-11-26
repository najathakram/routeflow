import * as React from "react";
import { render, screen } from "@testing-library/react";
import { buildCounterReceipt } from "@/lib/counter-receipt";
import { CounterReceiptView } from "./CounterReceiptView";

/** W-1459 / B1470: the money still owed on a sale the customer is carrying reads "On account", the checkout's own words. */
const sale = (over: {
  method: "CARD" | "ON_ACCOUNT";
  paid: number;
  balanceDue: number;
  paymentRecorded?: boolean;
}) =>
  buildCounterReceipt({
    receipt: {
      tax: 0,
      taxRatePercent: null,
      orderId: "o1",
      orderNumber: "ORD-1",
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      total: 6.95,
      paymentRecorded: true,
      ...over,
    },
    lines: [{ tempId: "a", name: "UX-pos Chips Box", unitPrice: 6.95, qty: 1 }],
    enteredTender: null,
    profile: { taxRate: 0 },
    now: new Date("2026-10-07T15:15:00.000Z"),
  });
const show = (model: ReturnType<typeof sale>) => render(<CounterReceiptView model={model} />);

/** the money row (a <dt>/<dd> pair), not the "On account" payment-method line above it */
const balanceRow = () =>
  screen.getAllByText(/^(On account|Balance due)$/).find((e) => e.tagName === "DT")!.parentElement!;

describe("receipt balance row (B1470)", () => {
  it("a sale put wholly on account says On account $6.95, never Balance due", () => {
    const { container } = show(sale({ method: "ON_ACCOUNT", paid: 0, balanceDue: 6.95 }));
    expect(balanceRow()).toHaveTextContent("On account$6.95");
    expect(container.textContent).not.toMatch(/Balance due/);
  });

  it("a card part payment says On account $1.95", () => {
    const { container } = show(sale({ method: "CARD", paid: 5, balanceDue: 1.95 }));
    expect(balanceRow()).toHaveTextContent("On account$1.95");
    expect(container.textContent).not.toMatch(/Balance due/);
  });

  it("a payment that was NOT recorded keeps Balance due (it is not on account)", () => {
    show(sale({ method: "CARD", paid: 0, balanceDue: 6.95, paymentRecorded: false }));
    expect(balanceRow()).toHaveTextContent("Balance due$6.95");
  });
});
