import * as React from "react";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { usePrintInvoice } from "./use-print-invoice";

/**
 * SA-1026 B: ONE hook prints an invoice (or every invoice of an order) as the same Letter PDF the invoice page prints
 * (GET /invoices/:id/pdf), in the order given, and tells the user when it could not.
 */
const get = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => get(...a) },
}));
const fetchPdfBlob = jest.fn();
jest.mock("@/lib/fetch-pdf-blob", () => ({
  fetchPdfBlob: (...a: unknown[]) => fetchPdfBlob(...a),
}));
const printPdfBlob = jest.fn();
jest.mock("@/lib/print-pdf-blob", () => ({
  printPdfBlob: (...a: unknown[]) => printPdfBlob(...a),
}));

function Harness({ ids, variant }: { ids: string | string[]; variant?: "draft" | "final" }) {
  const { print, printing } = usePrintInvoice();
  return (
    <button onClick={() => void print(ids, variant ? { variant } : undefined)} disabled={printing}>
      go
    </button>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: { url: `https://files/${url.split("/")[2]}.pdf` } }),
  );
  // jsdom's Blob has no text(): the stand-in carries the url it came from
  fetchPdfBlob.mockImplementation((url: string) => Promise.resolve({ url }));
});

describe("usePrintInvoice (SA-1026 B)", () => {
  it("one id: requests that invoice's PDF and prints it once", async () => {
    renderWithProviders(<Harness ids="inv-1" />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await waitFor(() => expect(printPdfBlob).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe("/invoices/inv-1/pdf");
  });

  it("several ids: requests every PDF and prints them in the order given", async () => {
    renderWithProviders(<Harness ids={["inv-1", "inv-2"]} />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await waitFor(() => expect(printPdfBlob).toHaveBeenCalledTimes(2));
    expect(get.mock.calls.map((c) => c[0])).toEqual(["/invoices/inv-1/pdf", "/invoices/inv-2/pdf"]);
    const printed = printPdfBlob.mock.calls.map((c) => (c[0] as { url: string }).url);
    expect(printed).toEqual(["https://files/inv-1.pdf", "https://files/inv-2.pdf"]);
  });

  it("a PDF that cannot be fetched prints nothing, says so, and the control comes back", async () => {
    get.mockRejectedValueOnce(new Error("boom"));
    renderWithProviders(<Harness ids={["inv-1", "inv-2"]} />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(await screen.findByText("Could not print the invoice")).toBeInTheDocument();
    expect(printPdfBlob).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "go" })).toBeEnabled());
  });

  it("the invoice page's variant rides along", async () => {
    renderWithProviders(<Harness ids="inv-1" variant="final" />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await waitFor(() => expect(printPdfBlob).toHaveBeenCalledTimes(1));
    expect(get.mock.calls[0][1]).toEqual({ params: { variant: "final" } });
  });
});
