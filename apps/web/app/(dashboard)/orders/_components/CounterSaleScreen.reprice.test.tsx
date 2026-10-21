import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * POS-2: a customer picked AFTER items were scanned as a walk-in RE-PRICES every line, through the same lookup Create
 * Order uses (GET /customers/:id/prices for the per-product tier, else the customer's default tier, then
 * @routeflow/pricing getTierPrice). The money still goes through cartTotals / computeLineSubtotal. While the lookup is in
 * flight, or after it failed, Complete is blocked; the server prices the sale anyway (no unitPrice is ever sent).
 */

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

const COLA = {
  id: "p-cola",
  name: "Cola",
  pricePerUnit: 2.5,
  priceTier2: 2,
  priceTier3: 1.5,
  unit: "each",
  unitsPerBox: null,
};
const WATER_CASE = {
  id: "p-water",
  name: "Water",
  pricePerUnit: 12,
  priceTier2: 9,
  priceTier3: 8,
  unit: "case",
  unitsPerBox: 12,
};
const PRODUCTS: Record<string, unknown> = { COLA, WATER: WATER_CASE };
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    PRODUCTS[code] ? { product: PRODUCTS[code], source: "sku" } : { notFound: true },
}));
const ACME = { id: "c-acme", businessName: "Acme Cafe", pricingTier: 2 };
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
// The real hook's shape (GET /customers/:id/prices under ["customer-prices", id]) over the mocked client.
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [ACME] } }),
  useCustomerPrices: (customerId: string | undefined) =>
    jest.requireActual("@tanstack/react-query").useQuery({
      queryKey: ["customer-prices", customerId],
      queryFn: () =>
        jest
          .requireMock("@/lib/api-client")
          .apiClient.get(`/customers/${customerId}/prices`)
          .then((r: { data: unknown }) => r.data),
      enabled: !!customerId,
    }),
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

const get = apiClient.get as unknown as jest.Mock;
let pricesFor: () => Promise<{ data: unknown }>;

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  pricesFor = async () => ({ data: [] });
  get.mockImplementation((url: string) =>
    url.startsWith("/customers/") ? pricesFor() : Promise.resolve({ data: { taxRate: 0 } }),
  );
  mutateAsync.mockResolvedValue({
    orderId: "o1",
    orderNumber: "ORD-1",
    invoiceId: "i1",
    invoiceNumber: "INV-1",
    total: 11,
    paid: 11,
    balanceDue: 0,
    change: 0,
    paymentRecorded: true,
  });
});

const scan = async (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
};
const total = () => screen.getByTestId("running-total");
const pickAcme = () => {
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
  fireEvent.click(screen.getByRole("button", { name: "Acme Cafe" }));
};
const scanBoth = async () => {
  await scan("COLA");
  await scan("WATER");
  await waitFor(() => expect(total()).toHaveTextContent("$14.50")); // 2.50 + 12.00 at walk-in prices
};
const completeBtn = () => screen.getByRole("button", { name: "Complete & show receipt" });

describe("CounterSaleScreen: re-price when a customer is picked (POS-2)", () => {
  it("re-prices both walk-in lines to the customer's tier, shows the note, and updates the total", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scanBoth();
    pickAcme();
    await waitFor(() => expect(total()).toHaveTextContent("$11.00")); // tier 2: 2.00 + 9.00
    expect(screen.getByTestId("counter-reprice-note")).toHaveTextContent(
      "Prices updated for Acme Cafe (Tier 2).",
    );
    expect(get).toHaveBeenCalledWith("/customers/c-acme/prices");
  });

  it("a per-product customer price (CustomerPrice tier) wins over the customer's default tier", async () => {
    pricesFor = async () => ({ data: [{ productId: "p-cola", pricingTier: 3 }] });
    renderWithProviders(<CounterSaleScreen />);
    await scanBoth();
    pickAcme();
    await waitFor(() => expect(total()).toHaveTextContent("$10.50")); // cola tier 3 = 1.50, water tier 2 = 9.00
  });

  it("back to Walk-in re-prices to the walk-in prices", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scanBoth();
    pickAcme();
    await waitFor(() => expect(total()).toHaveTextContent("$11.00"));
    fireEvent.click(screen.getByRole("button", { name: "Use Walk-in customer" }));
    await waitFor(() => expect(total()).toHaveTextContent("$14.50"));
    expect(screen.getByTestId("counter-reprice-note")).toHaveTextContent(
      "Prices updated for Walk-in customer (Tier 1).",
    );
    expect(completeBtn()).not.toBeDisabled();
  });

  it("a boxed line with loose pieces re-prices through the box proration, never qty x price", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("WATER");
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Add a piece to Water" }));
    }
    await waitFor(() => expect(total()).toHaveTextContent("$15.00")); // 1 box + 3 pcs at 12/box
    pickAcme();
    await waitFor(() => expect(total()).toHaveTextContent("$11.25")); // 9 + 3 x (9/12)
  });

  it("blocks Complete while the re-price is in flight, then unblocks", async () => {
    let release: (v: { data: unknown }) => void = () => {};
    pricesFor = () => new Promise((res) => (release = res));
    renderWithProviders(<CounterSaleScreen />);
    await scanBoth();
    pickAcme();
    await waitFor(() => expect(screen.getByTestId("counter-reprice-busy")).toBeInTheDocument());
    expect(completeBtn()).toBeDisabled();
    expect(screen.getByRole("button", { name: /Complete & next sale/ })).toBeDisabled();
    expect(total()).toHaveTextContent("$14.50"); // old prices until the lookup answers
    release({ data: [] });
    await waitFor(() => expect(total()).toHaveTextContent("$11.00"));
    expect(screen.queryByTestId("counter-reprice-busy")).toBeNull();
    expect(completeBtn()).not.toBeDisabled();
  });

  it("a failed re-price shows a retryable error, keeps the old prices and blocks Complete until resolved", async () => {
    pricesFor = () => Promise.reject(new Error("boom"));
    renderWithProviders(<CounterSaleScreen />);
    await scanBoth();
    pickAcme();
    const alert = await screen.findByTestId("counter-reprice-failed");
    expect(alert).toHaveTextContent("Couldn't update prices");
    expect(alert.textContent).not.toMatch(/boom/); // fixed copy, never the raw error
    expect(total()).toHaveTextContent("$14.50");
    expect(completeBtn()).toBeDisabled();
    pricesFor = async () => ({ data: [] });
    fireEvent.click(screen.getByRole("button", { name: "Retry price update" }));
    await waitFor(() => expect(total()).toHaveTextContent("$11.00"));
    expect(screen.queryByTestId("counter-reprice-failed")).toBeNull();
    expect(completeBtn()).not.toBeDisabled();
  });

  it("reverting to Walk-in clears a failed re-price and unblocks Complete", async () => {
    pricesFor = () => Promise.reject(new Error("boom"));
    renderWithProviders(<CounterSaleScreen />);
    await scanBoth();
    pickAcme();
    await screen.findByTestId("counter-reprice-failed");
    fireEvent.click(screen.getByRole("button", { name: "Use Walk-in customer" }));
    await waitFor(() => expect(screen.queryByTestId("counter-reprice-failed")).toBeNull());
    expect(total()).toHaveTextContent("$14.50");
    expect(completeBtn()).not.toBeDisabled();
  });

  it("Undo reverts the PRICES only (the customer stays); Dismiss just hides the note", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scanBoth();
    pickAcme();
    await waitFor(() => expect(total()).toHaveTextContent("$11.00"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(total()).toHaveTextContent("$14.50"));
    expect(screen.getByText("Acme Cafe")).toBeInTheDocument(); // still the customer on the sale
    expect(screen.queryByTestId("counter-reprice-note")).toBeNull();
    expect(completeBtn()).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Use Walk-in customer" }));
    await waitFor(() => expect(screen.getByText("Walk-in customer")).toBeInTheDocument());
    expect(total()).toHaveTextContent("$14.50");
    pickAcme();
    await waitFor(() => expect(total()).toHaveTextContent("$11.00"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("counter-reprice-note")).toBeNull();
    expect(total()).toHaveTextContent("$11.00");
  });

  it("the sale request never carries a client price: the server prices by customer", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scanBoth();
    pickAcme();
    await waitFor(() => expect(total()).toHaveTextContent("$11.00"));
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    fireEvent.click(completeBtn());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    const { dto } = mutateAsync.mock.calls[0][0];
    expect(dto.customerId).toBe("c-acme");
    for (const item of dto.items) expect(item).not.toHaveProperty("unitPrice");
  });
});
