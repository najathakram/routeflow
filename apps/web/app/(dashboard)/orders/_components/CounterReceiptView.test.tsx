import * as React from "react";
import { render, screen } from "@testing-library/react";
import { buildCounterReceipt } from "@/lib/counter-receipt";
import { CounterReceiptView } from "./CounterReceiptView";

const LINES = [{ tempId: "a", name: "Cola", unitPrice: 2.5, qty: 3 }]; // subtotal 7.50

function view(rate: number, total: number) {
  const model = buildCounterReceipt({
    receipt: {
      orderId: "o1",
      orderNumber: "ORD-1",
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      total,
      paid: total,
      balanceDue: 0,
      method: "CARD",
      paymentRecorded: true,
    } as never,
    lines: LINES,
    enteredTender: null,
    profile: { taxRate: rate },
    now: new Date("2026-10-07T15:15:00Z"),
  });
  render(<CounterReceiptView model={model} />);
}

describe("receipt tax label rate text", () => {
  it.each([
    [8.25, 8.12, "Tax (8.25%)"], // 7.50 x 8.25% = 0.62
    [8, 8.1, "Tax (8%)"], // 0.60
    [9.0625, 8.18, "Tax (9.0625%)"], // 0.6797 -> 0.68: the free-precision rate prints as stored
  ])("rate %s prints as stored, never re-rounded", (rate, total, label) => {
    view(rate, total);
    expect(screen.getByTestId("receipt-adjustment")).toHaveTextContent(label);
  });
});
