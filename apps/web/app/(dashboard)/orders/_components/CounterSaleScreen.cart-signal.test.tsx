import * as React from "react";
import { act } from "@testing-library/react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";
import {
  getCounterCartBusy,
  getCounterCartHasLines,
  setCounterCartBusy,
  setCounterCartHasLines,
} from "@/lib/counter-cart-signal";

/**
 * POS-7: the cart signal the register header reads (a line exists -> true; empty / unmounted -> false). The API is
 * mocked at the module boundary exactly as CounterSaleScreen.test.tsx does. RTL cannot measure pixels, so the layout and
 * size pins are CLASS pins (Playwright verifies the rendered 390 / lg layout).
 */

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: jest.fn() }) }));

const COLA = { id: "p-cola", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null };
const WATER = { id: "p-water", name: "Water", pricePerUnit: 12, unit: "case", unitsPerBox: 12 };
const productFor: Record<string, unknown> = { COLA, WATER };
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    productFor[code] ? { product: productFor[code], source: "sku" } : { notFound: true },
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
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }), post: jest.fn() },
}));
let gate: Record<string, unknown> = {};
const mutateAsync = jest.fn();
let pending = false;
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => gate,
  useCreateCounterSale: () => ({ mutateAsync, isPending: pending }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  pending = false;
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.print = jest.fn();
  gate = {
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: true,
    capability: { counter: "always", methods: ["SHIP", "PICKUP"], staffDefault: "PICKUP" },
  };
  mutateAsync.mockResolvedValue({
    orderId: "o1",
    orderNumber: "ORD-1",
    invoiceId: "i1",
    invoiceNumber: "INV-1",
    total: 0,
    paid: 0,
    balanceDue: 0,
    paymentRecorded: true,
  });
});
afterEach(() => jest.useRealTimers());

const scan = async (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
};

describe("POS-7 cart signal", () => {
  afterEach(() => {
    setCounterCartHasLines(false);
    setCounterCartBusy(false);
  });

  it("is false on an empty cart, true once a line exists, false again after removing it", async () => {
    renderWithProviders(<CounterSaleScreen />);
    expect(getCounterCartHasLines()).toBe(false);
    await scan("COLA");
    await waitFor(() => expect(getCounterCartHasLines()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Remove Cola" }));
    await waitFor(() => expect(getCounterCartHasLines()).toBe(false));
  });

  it("is cleared when the counter unmounts with lines in the cart", async () => {
    const view = renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await waitFor(() => expect(getCounterCartHasLines()).toBe(true));
    view.unmount();
    expect(getCounterCartHasLines()).toBe(false);
  });

  it("publishes busy while the sale POST is pending and clears it after and on unmount", async () => {
    const view = renderWithProviders(<CounterSaleScreen />);
    expect(getCounterCartBusy()).toBe(false);
    pending = true;
    view.rerender(<CounterSaleScreen />);
    await waitFor(() => expect(getCounterCartBusy()).toBe(true));
    pending = false;
    view.rerender(<CounterSaleScreen />);
    await waitFor(() => expect(getCounterCartBusy()).toBe(false));
    pending = true;
    view.rerender(<CounterSaleScreen />);
    await waitFor(() => expect(getCounterCartBusy()).toBe(true));
    view.unmount();
    expect(getCounterCartBusy()).toBe(false);
  });

  it("asks the browser to confirm leaving (beforeunload) only while busy", async () => {
    const view = renderWithProviders(<CounterSaleScreen />);
    const unload = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload()).toBe(false);
    pending = true;
    view.rerender(<CounterSaleScreen />);
    await waitFor(() => expect(unload()).toBe(true));
    pending = false;
    view.rerender(<CounterSaleScreen />);
    await waitFor(() => expect(unload()).toBe(false));
    pending = true;
    view.rerender(<CounterSaleScreen />);
    await waitFor(() => expect(unload()).toBe(true));
    view.unmount();
    expect(unload()).toBe(false);
  });
});
