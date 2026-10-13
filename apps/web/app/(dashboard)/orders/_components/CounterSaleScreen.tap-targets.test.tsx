import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * CQ-32: from a tablet width (768) the counter's own small controls are 44 px targets; only a desktop width (lg) goes compact.
 * jsdom has no layout, so the rule is asserted on the classes the breakpoints hang on.
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

describe("CounterSaleScreen: tablet tap targets (CQ-32)", () => {
  it("the Print receipt automatically checkbox is a 44 px box through md and compact from lg", () => {
    renderWithProviders(<CounterSaleScreen />);
    const box = screen.getByRole("checkbox", { name: "Print receipt automatically" });
    expect(box).toHaveClass("max-lg:h-11");
    expect(box).toHaveClass("max-lg:w-11");
    expect(box).toHaveClass("h-5"); // desktop density is unchanged
    expect(box.closest("label")).toHaveClass("min-h-[44px]");
  });
});
