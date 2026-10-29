import * as React from "react";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";

/**
 * SA-1026 B-R3: the order page offers "Print invoice" once the order is handed over (the invoices are issued and
 * numbered): one tap prints every non-void invoice of the order, oldest first, as the invoice page's Letter PDF.
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
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({ mayUseTill: true, loading: false }),
}));
jest.mock("@/components/OrderStatusBadge", () => ({ useOrderStatusLabel: () => (s: string) => s }));

import { PosOrderActions } from "./PosOrderActions";

const noop = () => undefined;
function renderActions(status: string, invoices: { id: string; status: string }[]) {
  return renderWithProviders(
    <PosOrderActions
      order={{ invoices } as never}
      orderId="o1"
      status={status}
      onHandOver={noop}
      onReadyForPickup={noop}
      moveOptions={{ delivery: "ROUTE", ship: true }}
      onMove={noop}
    />,
  );
}
const pdfCalls = () =>
  get.mock.calls.map((c) => String(c[0])).filter((url) => url.endsWith("/pdf"));

beforeEach(() => {
  jest.clearAllMocks();
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: { url: `https://files${url}` } }),
  );
});

describe("PosOrderActions: Print invoice (SA-1026 B-R3)", () => {
  it("a handed-over, paid order: one tap prints every non-void invoice, oldest first", async () => {
    renderActions("DELIVERED", [
      { id: "i1", status: "PAID" },
      { id: "i-void", status: "VOID" },
      { id: "i2", status: "PAID" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Print invoice" }));
    await waitFor(() => expect(printPdfBlob).toHaveBeenCalledTimes(2));
    expect(pdfCalls()).toEqual(["/invoices/i1/pdf", "/invoices/i2/pdf"]);
  });

  it("a handed-over order with a balance keeps Record payment and also offers Print invoice", () => {
    renderActions("DELIVERED", [{ id: "i1", status: "SENT" }]);
    expect(screen.getByRole("link", { name: "Record payment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print invoice" })).toBeInTheDocument();
  });

  it("before the hand-over the invoice is a draft: no Print invoice", () => {
    renderActions("CONFIRMED", [{ id: "i1", status: "DRAFT" }]);
    expect(screen.queryByRole("button", { name: "Print invoice" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Print invoice" })).toBeNull();
  });
});
