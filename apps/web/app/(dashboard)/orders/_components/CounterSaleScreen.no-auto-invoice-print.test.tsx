import * as React from "react";
import { readFileSync } from "fs";
import { join } from "path";
import { screen, waitFor, fireEvent } from "@/test-utils/render";
import { renderTill } from "@/test-utils/render-till";
import { apiClient } from "@/lib/api-client";
import { AUTO_PRINT_KEY } from "@/lib/counter-sale";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * SA-1026 B (owner ruling): an invoice never prints by itself. The till keeps its one device-local "Print receipt
 * automatically" checkbox (the receipt page, as before) and offers NO auto-print choice for the invoice; the invoice prints
 * only when staff tap "Print invoice". A stored "invoice" or "both" from the retired choice reads as off.
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
const COLA = { id: "p-cola", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null };
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    code === "COLA" ? { product: COLA, source: "sku" } : { notFound: true },
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [{ id: "c1", businessName: "Acme Co", pricingTier: 1 }] } }),
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));
jest.mock("@/lib/fetch-pdf-blob", () => ({
  fetchPdfBlob: () => Promise.resolve(new Blob(["pdf"])),
}));
const printPdfBlob = jest.fn();
jest.mock("@/lib/print-pdf-blob", () => ({
  printPdfBlob: (...a: unknown[]) => printPdfBlob(...a),
}));
const mutateAsync = jest.fn();
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always" },
  }),
  useCreateCounterSale: () => ({ mutateAsync, isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const SALE = {
  orderId: "o1",
  orderNumber: "ORD-1042",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total: 2.5,
  paid: 2.5,
  balanceDue: 0,
  paymentRecorded: true,
};
const get = apiClient.get as unknown as jest.Mock;
const print = jest.fn();
const pdfCalls = () => get.mock.calls.map((c) => String(c[0])).filter((u) => u.endsWith("/pdf"));

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.print = print;
  get.mockImplementation((url: string) =>
    url === "/settings"
      ? Promise.resolve({ data: { taxRate: 0, timezone: "UTC" } })
      : url.endsWith("/pdf")
        ? Promise.resolve({ data: { url: `https://files${url}` } })
        : Promise.resolve({ data: [] }),
  );
  mutateAsync.mockResolvedValue(SALE);
});

const scan = async () => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: "COLA" } });
  fireEvent.submit(field.closest("form")!);
  await screen.findByRole("button", { name: "Remove Cola" });
};
const named = () => {
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
  fireEvent.click(screen.getByRole("option", { name: "Acme Co" }));
  fireEvent.click(screen.getByRole("radio", { name: "Card" })); // a tender that needs nothing typed
};
const complete = () =>
  fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));

describe("CounterSaleScreen: the invoice never prints by itself (SA-1026 B-G2)", () => {
  it("has the one receipt checkbox and no Print automatically choice", () => {
    renderTill(<CounterSaleScreen />);
    expect(screen.getByRole("checkbox", { name: "Print receipt automatically" })).not.toBeChecked();
    expect(screen.queryByLabelText("Print automatically")).toBeNull();
    expect(screen.queryByRole("combobox", { name: /print/i })).toBeNull();
  });

  it.each(["invoice", "both"])(
    "a stored %s prints nothing when a sale completes",
    async (stored) => {
      window.localStorage.setItem(AUTO_PRINT_KEY, stored);
      renderTill(<CounterSaleScreen />);
      await scan();
      named();
      complete();
      await screen.findByTestId("counter-sale-receipt");
      expect(printPdfBlob).not.toHaveBeenCalled();
      expect(print).not.toHaveBeenCalled();
      expect(pdfCalls()).toEqual([]);
    },
  );

  it("the receipt checkbox still prints the receipt page only, never the invoice PDF", async () => {
    window.localStorage.setItem(AUTO_PRINT_KEY, "1");
    renderTill(<CounterSaleScreen />);
    await scan();
    named();
    complete();
    await screen.findByTestId("counter-sale-receipt");
    expect(print).toHaveBeenCalledTimes(1);
    expect(printPdfBlob).not.toHaveBeenCalled();
  });

  it("the done screen's Print invoice is the one-tap way, and it prints that sale's invoice", async () => {
    renderTill(<CounterSaleScreen />);
    await scan();
    named();
    complete();
    await screen.findByTestId("counter-sale-receipt");
    expect(printPdfBlob).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Print invoice" }));
    await waitFor(() => expect(printPdfBlob).toHaveBeenCalledTimes(1));
    expect(pdfCalls()).toEqual(["/invoices/i1/pdf"]);
  });

  it("no source keeps an invoice auto-print choice", () => {
    const till = readFileSync(join(__dirname, "CounterSaleScreen.tsx"), "utf8");
    const lib = readFileSync(
      join(__dirname, "..", "..", "..", "..", "lib", "counter-sale.ts"),
      "utf8",
    );
    expect(till).not.toContain("usePrintInvoice");
    for (const gone of ["printsInvoice", "AutoPrintChoice", "AUTO_PRINT_CHOICES"]) {
      expect(lib).not.toContain(gone);
      expect(till).not.toContain(gone);
    }
  });
});
