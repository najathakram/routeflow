import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * CQ-17: "Complete & next sale" starts a fresh sale straight away, so the screen names the order the finished sale became
 * (until the next sale has a line). "Complete & show receipt" shows the receipt, which carries the number itself.
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

const SALE = {
  orderId: "o1",
  orderNumber: "ORD-1042",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total: 2.5,
  paid: 20,
  balanceDue: 0,
  change: 17.5, // what the screen showed for a $20 tender: the sale is clean, so 'next' starts fresh
  paymentRecorded: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  mutateAsync.mockResolvedValue(SALE);
});

const scan = async (text: string, name = "Cola") => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
  await screen.findByRole("button", { name: `Remove ${name}` });
};

describe("CounterSaleScreen: the finished sale's order number (CQ-17)", () => {
  it("Complete & next sale names the order just completed, until the next sale has a line", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & next sale" }));
    const note = await screen.findByTestId("counter-last-sale");
    expect(note).toHaveTextContent("ORD-1042");
    expect(screen.getByRole("list", { name: "Items" })).toHaveTextContent("No items yet.");
    await scan("COLA");
    expect(screen.queryByTestId("counter-last-sale")).toBeNull();
  });

  // At 390 the note sat above the viewport (the scroll container was left scrolled at the Complete buttons).
  it("brings the note into view when it appears (nearest, so the page moves no more than needed)", async () => {
    const scrollIntoView = jest.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      renderWithProviders(<CounterSaleScreen />);
      await scan("COLA");
      fireEvent.click(screen.getByRole("button", { name: "$20" }));
      scrollIntoView.mockClear(); // the scan field's own focus handling may call it too
      fireEvent.click(screen.getByRole("button", { name: "Complete & next sale" }));
      const note = await screen.findByTestId("counter-last-sale");
      await waitFor(() => {
        const calls = scrollIntoView.mock.calls.map((c, i) => ({
          arg: c[0],
          el: scrollIntoView.mock.contexts[i],
        }));
        expect(calls).toContainEqual({ arg: { block: "nearest" }, el: note });
      });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("Complete & show receipt shows the receipt, not the note", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-sale-receipt");
    expect(screen.queryByTestId("counter-last-sale")).toBeNull();
  });
});
