import * as React from "react";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CounterReceiptActions } from "./CounterReceiptActions";

/**
 * SA-1026 B-R1: the counter done screen offers "Print invoice" beside the receipt's Print: one tap prints the sale's invoice
 * as the same Letter PDF the invoice page prints. Print (the receipt) stays the one primary.
 */
const get = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => get(...a), post: jest.fn() },
}));
jest.mock("@/lib/fetch-pdf-blob", () => ({
  fetchPdfBlob: () => Promise.resolve(new Blob(["pdf"])),
}));
const printPdfBlob = jest.fn();
jest.mock("@/lib/print-pdf-blob", () => ({
  printPdfBlob: (...a: unknown[]) => printPdfBlob(...a),
}));
// W-783: the receipt reads the order and the sale row; this file is about the invoice PDF only, so neither goes through `get`.
jest.mock("@/lib/api/orders", () => ({ useOrder: () => ({ data: undefined }) }));
jest.mock("@/lib/api/counter-sale-today", () => ({
  useCounterSaleRow: () => ({ row: undefined, isPending: false }),
}));
jest.mock("./CounterReturnAction", () => ({ CounterReturnAction: () => null }));
jest.mock("./useEmailReceipt", () => ({
  useEmailReceipt: () => ({ open: false }),
}));
jest.mock("./EmailReceipt", () => ({
  EmailReceiptButton: () => null,
  EmailReceiptRow: () => null,
}));

beforeEach(() => {
  jest.clearAllMocks();
  get.mockResolvedValue({ data: { url: "https://files/i1.pdf" } });
});

describe("CounterReceiptActions: Print invoice (SA-1026 B-R1)", () => {
  it("shows Print invoice next to Print, and one tap prints that invoice's PDF", async () => {
    renderWithProviders(
      <CounterReceiptActions
        orderId="o1"
        invoiceIds={["i1"]}
        customer={null}
        onNewSale={jest.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Print" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Print invoice" }));
    await waitFor(() => expect(printPdfBlob).toHaveBeenCalledTimes(1));
    expect(get.mock.calls[0][0]).toBe("/invoices/i1/pdf");
  });

  it("a sale of sibling invoices prints each one's PDF, in order", async () => {
    renderWithProviders(
      <CounterReceiptActions
        orderId="o1"
        invoiceIds={["i1", "i2"]}
        customer={null}
        onNewSale={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Print invoice" }));
    await waitFor(() => expect(printPdfBlob).toHaveBeenCalledTimes(2));
    expect(get.mock.calls.map((c) => c[0])).toEqual(["/invoices/i1/pdf", "/invoices/i2/pdf"]);
  });

  it("without an invoice id (an older response) the control is not offered", () => {
    renderWithProviders(
      <CounterReceiptActions orderId="o1" customer={null} onNewSale={jest.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "Print invoice" })).toBeNull();
  });
});
