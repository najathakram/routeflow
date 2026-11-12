import * as React from "react";
import { render, screen } from "@testing-library/react";
import { buildCounterReceipt } from "@/lib/counter-receipt";
import { CounterReceiptView } from "./CounterReceiptView";

// W-1188 (reader SHOULD): a reprint of a dated sale shows the sale day and the entry time, like the live receipt.
const model = (orderDate?: string) =>
  buildCounterReceipt({
    receipt: {
      orderId: "o1",
      orderNumber: "ORD-1",
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      total: 2.5,
      paid: 2.5,
      balanceDue: 0,
      paymentRecorded: true,
      method: "CASH",
    } as never,
    lines: [{ tempId: "a", name: "Cola", unitPrice: 2.5, qty: 1 }],
    enteredTender: null,
    profile: null,
    now: new Date("2026-10-07T15:30:00Z"),
    orderDate,
  });

describe("CounterReceiptView dated sale", () => {
  it("the live receipt shows Sale date and Entered", () => {
    render(<CounterReceiptView model={model("2026-10-05")} />);
    expect(screen.getByTestId("receipt-date")).toHaveTextContent("Sale date Mon, Oct 5, 2026");
    expect(screen.getByTestId("receipt-entered")).toHaveTextContent("Entered Oct 7, 2026, 3:30 PM");
  });

  it("the reprint keeps its Reprint line AND shows the sale date and entry time", () => {
    render(
      <CounterReceiptView
        model={model("2026-10-05")}
        reprintLabel="Reprint · Sold Oct 7, 3:30 PM"
      />,
    );
    expect(screen.getByTestId("receipt-reprint")).toBeInTheDocument();
    expect(screen.getByTestId("receipt-date")).toHaveTextContent("Sale date Mon, Oct 5, 2026");
    expect(screen.getByTestId("receipt-entered")).toHaveTextContent("Entered Oct 7, 2026, 3:30 PM");
  });

  it("an undated reprint is unchanged: the reprint line alone", () => {
    render(<CounterReceiptView model={model()} reprintLabel="Reprint · Sold Oct 7, 3:30 PM" />);
    expect(screen.queryByTestId("receipt-date")).toBeNull();
    expect(screen.queryByTestId("receipt-entered")).toBeNull();
  });
});
