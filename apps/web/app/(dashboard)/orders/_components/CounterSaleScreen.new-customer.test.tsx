import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { ReadOnlyGateProvider } from "@/lib/read-only-gate";
import type { SubscriptionView } from "@routeflow/types";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * W-1041 (SA-1062 R1, R3, R4): a customer made inside the sale. The empty search offers `Add "<typed>" as a new
 * customer`, "New customer" in the buyer question opens the same window, a save picks the new customer (the cart stays
 * and re-prices, Pay waits for the answer) and a cancel changes nothing. Read-only hides the way in for good.
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-o", tenantSlug: "acme", role: "OPERATOR" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
const COLA = {
  id: "p-cola",
  name: "Cola",
  pricePerUnit: 2.5,
  priceTier2: 2,
  unit: "each",
  unitsPerBox: null,
};
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    code === "COLA" ? { product: COLA, source: "sku" } : { notFound: true },
}));
const NEW_CUSTOMER = {
  id: "c-new",
  businessName: "Acme Cafe",
  pricingTier: 2,
  fulfillPath: "ROUTE",
  isWalkIn: false,
};
const createCustomer = jest.fn();
let mockOfferShip = false;
const mockSaleMutate = jest.fn();
jest.mock("@/lib/api/drafts", () => ({
  ...jest.requireActual("@/lib/api/drafts"),
  useCreateDraft: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
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
  useCreateCustomer: () => ({
    mutate: (payload: unknown, opts?: { onSuccess?: (d: unknown) => void }) => {
      createCustomer(payload);
      opts?.onSuccess?.({ customer: NEW_CUSTOMER, user: {}, tempPassword: "x" });
    },
    isPending: false,
    error: null,
    reset: jest.fn(),
  }),
  useUpdateCustomer: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
}));
jest.mock("@/lib/api/tobacco", () => ({
  ...jest.requireActual("@/lib/api/tobacco"),
  useHasAddon: () => false,
}));
jest.mock("@/lib/api/sales-agents", () => ({ useSalesAgents: () => ({ data: undefined }) }));
jest.mock("../../sales-agents/_components/AgentFormModal", () => ({ AgentFormModal: () => null }));
jest.mock("@/components/AddressAutocomplete", () => ({
  AddressAutocomplete: () => <input aria-label="Street" />,
}));
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: mockOfferShip,
    capability: { counter: "always" },
  }),
  useCreateCounterSale: () => {
    const [pending, setPending] = jest.requireActual("react").useState(false);
    return {
      mutateAsync: (...args: unknown[]) => {
        setPending(true);
        return mockSaleMutate(...args);
      },
      isPending: pending,
    };
  },
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const get = apiClient.get as unknown as jest.Mock;
let releasePrices: (() => void) | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  releasePrices = undefined;
  mockOfferShip = false;
  mockSaleMutate.mockReset();
  get.mockImplementation((url: string) =>
    url.startsWith("/customers/")
      ? new Promise((resolve) => {
          releasePrices = () => resolve({ data: [] });
        })
      : Promise.resolve({ data: { taxRate: 0 } }),
  );
});

const scanCola = async () => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: "COLA" } });
  fireEvent.submit(field.closest("form")!);
  await screen.findByRole("button", { name: "Remove Cola" });
};
const search = (text: string) =>
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: text } });
const kind = () => screen.getByTestId("counter-buyer-choice").getAttribute("data-kind");
const total = () => screen.getByTestId("running-total");
const completeBtn = () => screen.getByRole("button", { name: "Complete & show receipt" });

describe("CounterSaleScreen: a new customer in the sale (W-1041)", () => {
  it("R1: no match offers Add, a name-only save picks them, keeps the cart and re-prices before Pay", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scanCola();
    expect(total()).toHaveTextContent("$2.50");
    search("Acme Cafe");
    const add = screen.queryByRole("button", { name: 'Add "Acme Cafe" as a new customer' });
    expect(add).toBeInTheDocument();
    fireEvent.click(add!);
    expect((screen.getByLabelText("Business Name") as HTMLInputElement).value).toBe("Acme Cafe");
    fireEvent.click(screen.getByRole("button", { name: "Create Customer" }));
    await waitFor(() => expect(createCustomer).toHaveBeenCalledTimes(1));
    expect(createCustomer.mock.calls[0][0].businessName).toBe("Acme Cafe");
    expect(kind()).toBe("customer");
    expect(screen.getByRole("button", { name: "Remove Cola" })).toBeInTheDocument();
    await waitFor(() => expect(releasePrices).toBeDefined());
    expect(completeBtn()).toBeDisabled(); // Pay waits for the re-price answer
    releasePrices!();
    await waitFor(() => expect(total()).toHaveTextContent("$2.00")); // tier 2
    expect(completeBtn()).toBeEnabled();
  });

  it("R3: Walk-in tapped, then Add and save, names the customer in place of the walk-in", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Walk-in" }));
    expect(kind()).toBe("walk-in");
    search("Acme Cafe");
    const add = screen.queryByRole("button", { name: 'Add "Acme Cafe" as a new customer' });
    expect(add).toBeInTheDocument();
    fireEvent.click(add!);
    fireEvent.click(screen.getByRole("button", { name: "Create Customer" }));
    await waitFor(() => expect(kind()).toBe("customer"));
    expect(screen.getByTestId("counter-buyer-choice")).toHaveTextContent("Acme Cafe");
  });

  it("the buyer question's New customer opens the window empty", () => {
    renderWithProviders(<CounterSaleScreen />);
    const door = screen.queryByRole("button", { name: "New customer" });
    expect(door).toBeInTheDocument();
    fireEvent.click(door!);
    expect((screen.getByLabelText("Business Name") as HTMLInputElement).value).toBe("");
  });

  it("R4: Cancel leaves the customer, cart and buyer question as they were", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scanCola();
    search("Acme Cafe");
    const add = screen.queryByRole("button", { name: 'Add "Acme Cafe" as a new customer' });
    expect(add).toBeInTheDocument();
    fireEvent.click(add!);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(createCustomer).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(kind()).toBe("none");
    expect(screen.getByRole("button", { name: "Remove Cola" })).toBeInTheDocument();
    expect(total()).toHaveTextContent("$2.50");
  });

  it("guard: read-only leaves both ways in drawn but disabled", () => {
    const view = { status: "READ_ONLY", billingContactEmail: "dana@example.test" };
    renderWithProviders(
      <ReadOnlyGateProvider view={view as unknown as SubscriptionView}>
        <CounterSaleScreen />
      </ReadOnlyGateProvider>,
    );
    expect(screen.queryByRole("button", { name: "New customer" })).toBeDisabled();
    search("Acme Cafe");
    const add = screen.queryByRole("button", { name: 'Add "Acme Cafe" as a new customer' });
    expect(add).toBeInTheDocument();
    expect(add).toBeDisabled();
  });

  it("MUST 8: the Add button is disabled while the sale is posting", async () => {
    mockSaleMutate.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<CounterSaleScreen />);
    await scanCola();
    fireEvent.click(screen.getByRole("button", { name: "Walk-in" }));
    search("Acme Cafe");
    const addName = { name: 'Add "Acme Cafe" as a new customer' };
    expect(screen.queryByRole("button", addName)).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(completeBtn());
    await waitFor(() => expect(screen.queryByRole("button", addName)).toBeDisabled());
    expect(mockSaleMutate).toHaveBeenCalledTimes(1);
  });

  it("Ship this order instead with a walk-in: the new customer needs an address first", async () => {
    mockOfferShip = true;
    renderWithProviders(<CounterSaleScreen />);
    await scanCola();
    fireEvent.click(screen.getByRole("button", { name: "Walk-in" }));
    fireEvent.click(screen.getByRole("button", { name: "Ship this order instead" }));
    search("Acme Cafe");
    const add = screen.queryByRole("button", { name: 'Add "Acme Cafe" as a new customer' });
    expect(add).toBeInTheDocument();
    fireEvent.click(add!);
    fireEvent.click(screen.getByRole("button", { name: "Create Customer" }));
    await waitFor(() => expect(screen.queryAllByText("Required").length).toBeGreaterThan(0));
    expect(createCustomer).not.toHaveBeenCalled();
  });
});
