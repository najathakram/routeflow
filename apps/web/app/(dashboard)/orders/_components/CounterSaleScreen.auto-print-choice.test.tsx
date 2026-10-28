import * as React from "react";
import { screen, waitFor, fireEvent } from "@/test-utils/render";
import { renderTill } from "@/test-utils/render-till";
import { apiClient } from "@/lib/api-client";
import { AUTO_PRINT_KEY } from "@/lib/counter-sale";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * SA-1026 B-R5: the till's "Print receipt automatically" becomes a choice of nothing, receipt, invoice or both. It stays a
 * per-device setting. Receipt prints the page (as before); invoice fetches and prints the sale's invoice PDF instead; both
 * does the receipt, then the invoice. The done screen's own Print invoice is the one-tap fallback.
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
const choose = (value: string) =>
  fireEvent.change(screen.getByLabelText("Print automatically"), { target: { value } });

describe("CounterSaleScreen: auto-print choice (SA-1026 B-R5)", () => {
  it("offers nothing, receipt, invoice and both, and remembers the pick on this device", () => {
    renderTill(<CounterSaleScreen />);
    const select = screen.getByLabelText("Print automatically") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Nothing",
      "Receipt",
      "Invoice",
      "Receipt and invoice",
    ]);
    choose("invoice");
    expect(window.localStorage.getItem(AUTO_PRINT_KEY)).toBe("invoice");
  });

  it("invoice: the invoice PDF for the sale prints and the receipt page does not", async () => {
    window.localStorage.setItem(AUTO_PRINT_KEY, "invoice");
    renderTill(<CounterSaleScreen />);
    await scan();
    named();
    complete();
    await screen.findByTestId("counter-sale-receipt");
    await waitFor(() => expect(printPdfBlob).toHaveBeenCalledTimes(1));
    expect(get.mock.calls.map((c) => String(c[0]))).toContain("/invoices/i1/pdf");
    expect(print).not.toHaveBeenCalled();
  });

  it("both: the receipt prints, then the invoice", async () => {
    window.localStorage.setItem(AUTO_PRINT_KEY, "both");
    renderTill(<CounterSaleScreen />);
    await scan();
    named();
    complete();
    await screen.findByTestId("counter-sale-receipt");
    await waitFor(() => expect(printPdfBlob).toHaveBeenCalledTimes(1));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("receipt (a stored 1) prints the page only, exactly as before", async () => {
    window.localStorage.setItem(AUTO_PRINT_KEY, "1");
    renderTill(<CounterSaleScreen />);
    await scan();
    named();
    complete();
    await screen.findByTestId("counter-sale-receipt");
    expect(print).toHaveBeenCalledTimes(1);
    expect(printPdfBlob).not.toHaveBeenCalled();
  });
});
