import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/** B1182: below md the register publishes the sticky bar's height (+12px) as the toast inset; md+ and unmount leave none. */
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
  apiClient: { get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }), post: jest.fn() },
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

const INSET = "--toast-bottom-inset";
const inset = () => document.documentElement.style.getPropertyValue(INSET);
const setViewport = (md: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches: md && query.includes("min-width: 768px"),
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    onchange: null,
    dispatchEvent: jest.fn(),
  })) as unknown as typeof window.matchMedia;
};

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 100 });
});
afterEach(() => document.documentElement.style.removeProperty(INSET));

describe("CounterSaleScreen: toast inset above the sticky bar (B1182)", () => {
  it("below md sets the inset to the bar height + 12px; unmount removes it", async () => {
    setViewport(false);
    const { unmount } = renderWithProviders(<CounterSaleScreen />);
    await waitFor(() => expect(inset()).toBe("112px"));
    unmount();
    expect(inset()).toBe("");
  });

  it("at md and up sets no inset", async () => {
    setViewport(true);
    renderWithProviders(<CounterSaleScreen />);
    await screen.findByLabelText("Scan or search items");
    expect(inset()).toBe("");
  });
});
