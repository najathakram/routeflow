import * as React from "react";
import { screen, waitFor, fireEvent } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { renderTill } from "@/test-utils/render-till";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * W-1185: the till shows the running item count above the total and it follows every scan, so the clerk
 * can check the count against the goods in hand. Harness as CounterSaleScreen.scan.test.tsx.
 */

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
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

const COLA = {
  id: "p-cola",
  name: "Sample Cola",
  sku: "200000000001",
  pricePerUnit: 2.5,
  unit: "each",
  unitsPerBox: null,
  isActive: true,
};
const CHIPS = {
  id: "p-chips",
  name: "Sample Chips",
  sku: "200000000002",
  pricePerUnit: 4,
  unit: "each",
  unitsPerBox: null,
  isActive: true,
};
// A 24-pack priced 30.00 per case: its case code is one whole case.
const PACK24 = {
  id: "p-pack",
  name: "Sample Cola 24pk",
  sku: "400500600011",
  unitSku: "400500600028",
  pricePerUnit: 30,
  unit: "case",
  unitsPerBox: 24,
  isActive: true,
};

type Handler = () => Promise<unknown> | unknown;
let barcodeFor: Record<string, Handler> = {};
let listFor: Record<string, Handler> = {};
const notFound = () => Promise.reject({ response: { status: 404 } });

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  barcodeFor = {};
  listFor = {};
  (apiClient.get as jest.Mock).mockImplementation(async (url: string, cfg?: any) => {
    if (url === "/settings") return { data: { taxRate: 0 } };
    if (url.startsWith("/products/barcode/")) {
      const code = decodeURIComponent(url.slice("/products/barcode/".length));
      return barcodeFor[code] ? { data: await barcodeFor[code]() } : notFound();
    }
    if (url === "/products") {
      const code = cfg?.params?.scanCode ?? cfg?.params?.search;
      const rows = listFor[code]
        ? await listFor[code]()
        : barcodeFor[code]
          ? [await barcodeFor[code]()] // the fuzzy list also finds an exact code's product
          : [];
      return { data: { data: rows } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
  mutateAsync.mockResolvedValue({
    orderId: "o1",
    orderNumber: "ORD-1",
    invoiceId: "i1",
    invoiceNumber: "INV-1",
    total: 1.25,
    paid: 20,
    balanceDue: 0,
    change: 18.75,
    paymentRecorded: true,
  });
});

const submitScan = (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
};
const scan = async (text: string) => {
  submitScan(text);
  await waitFor(() =>
    expect((screen.getByLabelText("Scan or search items") as HTMLInputElement).value).toBe(""),
  );
};
describe("till item count chip (W-1185)", () => {
  it("shows no chip on an empty cart, then follows each scan", async () => {
    barcodeFor["200000000001"] = () => COLA;
    barcodeFor["400500600011"] = () => PACK24;
    barcodeFor["400500600028"] = () => PACK24;
    renderTill(<CounterSaleScreen />);
    expect(screen.queryByTestId("line-count-chip")).not.toBeInTheDocument();

    await scan("200000000001");
    await waitFor(() =>
      expect(screen.getByTestId("line-count-chip")).toHaveTextContent("1 line · 1 pc"),
    );
    await scan("400500600011");
    await waitFor(() =>
      expect(screen.getByTestId("line-count-chip")).toHaveTextContent("2 lines · 1 box · 1 pc"),
    );
    // a unit code on the pack adds a loose piece to that line: boxes and pieces stay apart
    await scan("400500600028");
    await waitFor(() =>
      expect(screen.getByTestId("line-count-chip")).toHaveTextContent("2 lines · 1 box · 2 pcs"),
    );
  });

  it("sits above the running total, inside the sticky checkout bar", async () => {
    barcodeFor["200000000001"] = () => COLA;
    renderTill(<CounterSaleScreen />);
    await scan("200000000001");
    const chip = await screen.findByTestId("line-count-chip");
    expect(screen.getByTestId("counter-checkout-bar")).toContainElement(chip);
    const total = screen.getByTestId("running-total");
    expect(chip.compareDocumentPosition(total) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
