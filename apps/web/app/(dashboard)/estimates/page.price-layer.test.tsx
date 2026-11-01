import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import EstimatesPage from "./page";

// S19b slice C, C-3 (SA-811a, SA-813): the estimate create dialog prices an added product from the customer's LAYER (billing's
// own resolved row) when flag.units_prices_v2 is on. Flag off: no price-layer request and master's tier price. Layer pending or
// failed: unconfirmed (M3 copy), nothing is added at the tier, and Create stays disabled. Harness copied from page.test.tsx.
let flagOn = true;
let mockPricesRead: Record<string, unknown> = {};
const mockRefetchPrices = jest.fn();
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
  useCustomerPrices: () => ({
    data: [],
    isLoading: false,
    isError: false,
    refetch: mockRefetchPrices,
    ...mockPricesRead,
  }),
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
  await user.click(screen.getAllByRole("button", { name: "New estimate" })[0]);
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
  mockPricesRead = {};
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
    expect(within(dialog).getByText("MANUAL")).toBeInTheDocument();
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

/**
 * W-745 (SA-868/883/884, the web pickers): the estimate dialog gated picks on the LAYER only. A customer-price read that FAILED
 * (no data) still let a pick through, priced at the customer's own tier with every per-product override dropped. It now uses
 * the shared customerPricingGate: a failed read refuses the pick with the failed copy and Retry; the plan-gated PLAN_GATE 403
 * is an empty read, so an un-flagged tenant picks at the tier as before.
 */
describe("W-745: the estimate dialog fails closed on a failed customer-price read", () => {
  const failed = (status: number, code?: string) => ({
    data: undefined,
    isError: true,
    error: { response: { status, data: { code } } },
  });

  it("a failed prices read (500): failed copy with Retry, and a pick adds nothing (master: added at $36.00)", async () => {
    flagOn = false;
    mockPricesRead = failed(500);
    const { user, dialog } = await openAndPickCustomer();
    expect(
      await within(dialog).findByText(/couldn't load this customer's prices/i),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /retry/i }));
    expect(mockRefetchPrices).toHaveBeenCalled();
    await addWidget(user, dialog);
    expect(within(dialog).queryByText(/\$36\.00/)).not.toBeInTheDocument();
  });

  it("a PLAN_GATE 403 (plan without tier pricing) is an empty read: the pick adds at the tier ($36.00)", async () => {
    flagOn = false;
    mockPricesRead = failed(403, "PLAN_GATE");
    const { user, dialog } = await openAndPickCustomer();
    expect(
      within(dialog).queryByText(/couldn't load this customer's prices/i),
    ).not.toBeInTheDocument();
    await addWidget(user, dialog);
    expect(await within(dialog).findByText(/\$36\.00\/each/)).toBeInTheDocument();
  });
});

// SA-1077 / W-1093: a tier ABOVE Retail prices a line over its list; the TIER badge stays and the lower list is not struck.
describe("W-1093: the struck list price on a TIER line", () => {
  afterEach(() => {
    PRODUCT.priceTier3 = 36;
  });

  it("a tier price above the list ($48 on $42): the badge stays, the $42.00 list is not struck", async () => {
    flagOn = false;
    PRODUCT.priceTier3 = 48;
    const { user, dialog } = await openAndPickCustomer();
    await addWidget(user, dialog);
    expect(await within(dialog).findByText(/\$48\.00\/each/)).toBeInTheDocument();
    expect(within(dialog).getByText("TIER")).toBeInTheDocument();
    expect(within(dialog).queryByText("$42.00")).not.toBeInTheDocument();
  });

  it("a tier price below the list ($36 on $42): the list is struck", async () => {
    flagOn = false;
    const { user, dialog } = await openAndPickCustomer();
    await addWidget(user, dialog);
    expect(await within(dialog).findByText(/\$36\.00\/each/)).toBeInTheDocument();
    expect(within(dialog).getByText("$42.00")).toBeInTheDocument();
  });
});
