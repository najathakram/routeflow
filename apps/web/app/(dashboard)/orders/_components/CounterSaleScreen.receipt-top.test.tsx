import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * CQ-33: the receipt opens at its TOP. The dashboard scrolls `#main-content`; a clerk who scrolled the sale down to the
 * Complete buttons used to land half way down the receipt (the scroll position carried over).
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

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  mutateAsync.mockResolvedValue({
    orderId: "o1",
    orderNumber: "ORD-1",
    invoiceId: "i1",
    invoiceNumber: "INV-1",
    total: 2.5,
    paid: 5,
    balanceDue: 0,
    change: 2.5,
    paymentRecorded: true,
  });
});

describe("CounterSaleScreen: the receipt opens at the top (CQ-33)", () => {
  it("resets the shell's scroll position when the receipt appears", async () => {
    const main = document.createElement("div");
    main.id = "main-content";
    document.body.appendChild(main);
    try {
      renderWithProviders(<CounterSaleScreen />);
      const field = screen.getByLabelText("Scan or search items");
      fireEvent.change(field, { target: { value: "COLA" } });
      fireEvent.submit(field.closest("form")!);
      await screen.findByRole("button", { name: "Remove Cola" });
      fireEvent.click(screen.getByRole("button", { name: "$20" }));
      main.scrollTop = 480; // the clerk scrolled down to the Complete buttons
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      await screen.findByTestId("counter-sale-receipt");
      await waitFor(() => expect(main.scrollTop).toBe(0));
    } finally {
      main.remove();
    }
  });
});
