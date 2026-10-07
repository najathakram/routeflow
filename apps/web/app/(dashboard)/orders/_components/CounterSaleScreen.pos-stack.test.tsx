import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * POS stack integration (B1210 -> POS-1 -> POS-3 -> POS-2): the re-price (POS-2) lives in POS-3's row/Undo/checkout
 * structure and POS-1's "Complete & show receipt" respects both the re-price block and the POST freeze.
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
let pending = false;
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always" },
  }),
  useCreateCounterSale: () => ({ mutateAsync, isPending: pending }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const get = apiClient.get as unknown as jest.Mock;
let pricesFor: () => Promise<{ data: unknown }>;

beforeEach(() => {
  jest.clearAllMocks();
  pending = false;
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
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const total = () => screen.getByTestId("running-total");
const rows = () => within(screen.getByRole("list", { name: "Items" })).getAllByRole("listitem");
const colaRow = () => rows().find((r) => /Cola/.test(r.textContent ?? ""))!;
const pickAcme = () => {
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
  click("Acme Cafe");
};
const undoRemoved = () =>
  fireEvent.click(
    within(screen.getByRole("status", { name: "Removed item" })).getByRole("button", {
      name: "Undo",
    }),
  );
const completeBtn = () => screen.getByRole("button", { name: "Complete & show receipt" });
const nextBtn = () => screen.getByRole("button", { name: "Complete & next sale" });

describe("POS stack: re-price x line row x Undo x checkout", () => {
  it("a customer pick re-prices the line shown in CounterLineRow", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    expect(colaRow()).toHaveTextContent("$2.50");
    pickAcme();
    await waitFor(() => expect(colaRow()).toHaveTextContent("$2.00")); // tier 2
    expect(total()).toHaveTextContent("$2.00");
  });

  it("an Undo-restored line keeps its re-priced price (and a re-price during the undo window reaches it)", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await scan("WATER");
    pickAcme();
    await waitFor(() => expect(total()).toHaveTextContent("$11.00"));
    click("Remove Cola");
    undoRemoved();
    expect(colaRow()).toHaveTextContent("$2.00");
    expect(total()).toHaveTextContent("$11.00");

    // remove, then change the customer while the line sits in the undo window: the restored line is priced for them
    click("Remove Cola");
    click("Use Walk-in customer");
    await waitFor(() => expect(total()).toHaveTextContent("$12.00")); // water back at walk-in 12.00
    undoRemoved();
    expect(colaRow()).toHaveTextContent("$2.50");
    expect(total()).toHaveTextContent("$14.50");
  });

  it("Complete is disabled while re-pricing, and while the POST is in flight (both buttons)", async () => {
    let release: (v: { data: unknown }) => void = () => {};
    pricesFor = () => new Promise((res) => (release = res));
    const view = renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    pickAcme();
    await waitFor(() => expect(screen.getByTestId("counter-reprice-busy")).toBeInTheDocument());
    expect(completeBtn()).toBeDisabled();
    expect(nextBtn()).toBeDisabled();
    click("Exact");
    fireEvent.click(completeBtn());
    expect(mutateAsync).not.toHaveBeenCalled();
    release({ data: [] });
    await waitFor(() => expect(completeBtn()).toBeEnabled());
    expect(nextBtn()).toBeEnabled();

    pending = true;
    click("Card"); // any state change re-reads the in-flight flag
    expect(completeBtn()).toBeDisabled();
    expect(nextBtn()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Cola" })).toBeDisabled(); // POS-3 line freeze
    view.unmount();
  });

  it("a line note survives a re-price and goes out as items[].note, with NO unitPrice", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    click("Add a note to Cola");
    fireEvent.change(screen.getByLabelText("Note for Cola"), { target: { value: "no ice" } });
    click("Edit the note on Cola");
    pickAcme();
    await waitFor(() => expect(colaRow()).toHaveTextContent("$2.00"));
    expect(screen.getByTestId("line-note")).toHaveTextContent("no ice");
    click("Exact");
    fireEvent.click(completeBtn());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const { dto } = mutateAsync.mock.calls[0][0];
    expect(dto.customerId).toBe("c-acme");
    expect(dto.items).toEqual([{ productId: "p-cola", qty: 1, note: "no ice" }]);
    for (const item of dto.items) expect(item).not.toHaveProperty("unitPrice");
  });

  it("the re-price Undo restores prices without losing a line note or quantity", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    click("Add a note to Cola");
    fireEvent.change(screen.getByLabelText("Note for Cola"), { target: { value: "no ice" } });
    click("Edit the note on Cola");
    click("Add one Cola");
    pickAcme();
    await waitFor(() => expect(total()).toHaveTextContent("$4.00"));
    click("Undo"); // the re-price note's Undo (no line is removed)
    await waitFor(() => expect(total()).toHaveTextContent("$5.00"));
    expect(screen.getByTestId("line-note")).toHaveTextContent("no ice");
  });
});
