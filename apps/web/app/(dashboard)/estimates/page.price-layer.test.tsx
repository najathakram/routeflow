import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import EstimatesPage from "./page";

// S19b slice C, C-3 (SA-811a, SA-813): the estimate create dialog prices an added product from the customer's LAYER (billing's
// own resolved row) when flag.units_prices_v2 is on. Flag off: no price-layer request and master's tier price. Layer pending or
// failed: unconfirmed (M3 copy), nothing is added at the tier, and Create stays disabled. Harness copied from page.test.tsx.
let flagOn = true;
let layerResponder: () => Promise<unknown> = () => Promise.resolve({ data: {} });
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/estimates",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => flagOn }));
const mockGet = jest.fn((url: string) =>
  url === "/customers/cust-1/price-layer" ? layerResponder() : Promise.reject(new Error("nope")),
);
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (url: string) => mockGet(url), post: jest.fn() },
}));
jest.mock("@/lib/api/estimates", () => ({
  ...jest.requireActual("@/lib/api/estimates"),
  useEstimates: () => ({
    data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } },
    isLoading: false,
    isError: false,
  }),
  useCreateEstimate: () => ({ mutate: jest.fn(), isPending: false }),
}));
// list $42, tier 3 $36; the customer's typed pack price is $33.
const CUSTOMER = { id: "cust-1", businessName: "Acme Foods", contactName: "Jane", pricingTier: 3 };
const PRODUCT = {
  id: "prod-1",
  name: "Widget",
  sku: "WID-1",
  unit: "each",
  pricePerUnit: 42,
  priceTier3: 36,
  isActive: true,
};
jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: () => ({ data: { data: [CUSTOMER] }, isLoading: false, isError: false }),
  useCustomerPrices: () => ({ data: [], isLoading: false, isError: false }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [PRODUCT] }, isLoading: false, isError: false }),
}));
jest.mock("@/lib/api/tier-labels", () => ({
  ...jest.requireActual("@/lib/api/tier-labels"),
  useTierLabels: () => ({ data: {}, isLoading: false, isError: false }),
}));

const layer = (price: number, aboveList = false) => ({
  data: {
    customerId: "cust-1",
    complete: true,
    products: {
      "prod-1": [{ ref: "pack", label: null, price, listPrice: 42, source: "customer", aboveList }],
    },
  },
});
const layerCalls = () => mockGet.mock.calls.filter((c) => String(c[0]).endsWith("/price-layer"));

async function openAndPickCustomer() {
  const user = userEvent.setup();
  renderWithProviders(<EstimatesPage />);
  await user.click(screen.getByRole("button", { name: "New Estimate" }));
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByPlaceholderText(/search customers/i), "Acme");
  await user.click(await within(dialog).findByText("Acme Foods"));
  return { user, dialog };
}
async function addWidget(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.type(within(dialog).getByPlaceholderText(/search by name, sku/i), "Widget");
  await user.click(await within(dialog).findByText("Widget"));
}

beforeEach(() => {
  jest.clearAllMocks();
  flagOn = true;
  layerResponder = () => Promise.resolve(layer(33));
});

describe("S19b C-3: estimate add from the customer layer", () => {
  it("C-3: an added product shows the layer price $33.00, not the tier $36.00", async () => {
    const { user, dialog } = await openAndPickCustomer();
    await waitFor(() =>
      expect(within(dialog).queryByText(/checking this customer/i)).not.toBeInTheDocument(),
    );
    await addWidget(user, dialog);
    expect(await within(dialog).findByText(/\$33\.00\/each/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/\$36\.00/)).not.toBeInTheDocument();
  });

  it("R2: an above-list layer price ($45 on a $42 list) shows as is with no TIER badge", async () => {
    layerResponder = () => Promise.resolve(layer(45, true));
    const { user, dialog } = await openAndPickCustomer();
    await waitFor(() =>
      expect(within(dialog).queryByText(/checking this customer/i)).not.toBeInTheDocument(),
    );
    await addWidget(user, dialog);
    expect(await within(dialog).findByText(/\$45\.00\/each/)).toBeInTheDocument();
    expect(within(dialog).queryByText("TIER")).not.toBeInTheDocument();
  });

  it("flag OFF: no price-layer request and master's tier price ($36.00)", async () => {
    flagOn = false;
    const { user, dialog } = await openAndPickCustomer();
    await addWidget(user, dialog);
    expect(await within(dialog).findByText(/\$36\.00\/each/)).toBeInTheDocument();
    expect(layerCalls()).toHaveLength(0);
  });

  it("M3: while the layer is pending: unconfirmed copy, Create disabled, a pick adds nothing", async () => {
    layerResponder = () => new Promise(() => {});
    const { user, dialog } = await openAndPickCustomer();
    expect(
      await within(dialog).findByText("Checking this customer's prices\u2026"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create estimate/i })).toBeDisabled();
    await addWidget(user, dialog);
    expect(within(dialog).queryByText(/\$36\.00/)).not.toBeInTheDocument();
  });

  it("M3: a failed layer read says so with Retry and keeps Create disabled", async () => {
    layerResponder = () => Promise.reject(new Error("boom"));
    const { dialog } = await openAndPickCustomer();
    expect(
      await within(dialog).findByText(/couldn't load this customer's prices/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create estimate/i })).toBeDisabled();
  });
});
