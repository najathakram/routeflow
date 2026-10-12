import * as React from "react";
import { onlineManager } from "@tanstack/react-query";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { COUNTER_OFFLINE_COPY } from "@/lib/counter-sale";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * CQ-29 (S1) on the screen with the REAL useCreateCounterSale over a REAL QueryClient whose online manager is OFFLINE: the
 * request is not paused, so the screen shows the offline state and unlocks, and the retry reuses the SAME Idempotency-Key.
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
// only the gate is faked: the sale mutations are the real hooks
jest.mock("@/lib/api/counter-sale", () => ({
  ...jest.requireActual("@/lib/api/counter-sale"),
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always" },
    loading: false,
    failed: false,
    retry: jest.fn(),
  }),
}));

const post = apiClient.post as unknown as jest.Mock;
const get = apiClient.get as unknown as jest.Mock;
const SALE = {
  orderId: "o1",
  orderNumber: "ORD-1",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total: 2.5,
  paid: 20,
  balanceDue: 0,
  change: 17.5,
  paymentRecorded: true,
};
let browserOnline = true;
const setBrowserOnline = (v: boolean) => {
  browserOnline = v;
  onlineManager.setOnline(v);
};

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  get.mockResolvedValue({ data: { taxRate: 0 } });
  setBrowserOnline(true);
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => browserOnline,
  });
});
afterEach(() => {
  onlineManager.setOnline(true);
  delete (window.navigator as unknown as Record<string, unknown>).onLine;
});

describe("CounterSaleScreen offline through the real mutation (CQ-29)", () => {
  it("shows the offline state, unlocks the form, and the retry reuses the same key", async () => {
    post.mockRejectedValueOnce({ code: "ERR_NETWORK", message: "Network Error" });
    renderWithProviders(<CounterSaleScreen />);
    const field = screen.getByLabelText("Scan or search items");
    fireEvent.change(field, { target: { value: "COLA" } });
    fireEvent.submit(field.closest("form")!);
    await screen.findByRole("button", { name: "Remove Cola" });
    fireEvent.click(screen.getByRole("button", { name: "$20" }));

    setBrowserOnline(false);
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    // not paused: the failure comes back and the bar says so
    expect(await screen.findByText(COUNTER_OFFLINE_COPY)).toBeInTheDocument();
    expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
    expect(screen.getByLabelText("Scan or search items")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Complete & show receipt" })).not.toBeDisabled();
    expect(post).toHaveBeenCalledTimes(1);

    setBrowserOnline(true);
    post.mockResolvedValueOnce({ data: SALE });
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-sale-receipt");
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const key = (i: number) => post.mock.calls[i][2].headers["Idempotency-Key"];
    expect(key(1)).toBe(key(0));
  });
});
