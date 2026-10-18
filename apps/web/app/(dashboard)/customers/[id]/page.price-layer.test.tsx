import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import CustomerDetailPage from "./page";

// S19b slice C, C-4 (SA-811a, SA-813): the customer's price list shows the customer-LAYER price (billing's own resolved row)
// beside the override, not the bare tier price. Flag off: no price-layer request and the tier price as master. Pending or
// failed: unconfirmed copy, never a final tier price.
let flagOn = true;
const get = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "c1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  usePathname: () => "/customers/c1",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => children,
}));
jest.mock("../_components/CustomerFormModal", () => ({ CustomerFormModal: () => null }));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => flagOn }));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useFleetAccess: () => ({ fleet: false, loading: false }),
  useRoutesAccess: () => ({ enabled: false, resolved: true }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: jest.fn(),
    post: jest.fn(),
    delete: jest.fn(),
  },
}));

const customer = {
  id: "c1",
  businessName: "Acme Foods",
  contactName: "Pat Lee",
  customerType: "BUSINESS",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "ACTIVE",
  pricingTier: 3,
  user: { status: "ACTIVE" },
  addresses: [],
};
// list $42, tier 3 $36: the row's tier price is $36; the customer's typed pack price is $33.
const priceRow = {
  id: "cp1",
  productId: "p1",
  pricingTier: 3,
  product: { id: "p1", name: "Soda", sku: "S1", pricePerUnit: "42", priceTier3: "36" },
};
const priceRow2 = {
  id: "cp2",
  productId: "p2",
  pricingTier: 3,
  product: { id: "p2", name: "Juice", sku: "J1", pricePerUnit: "20", priceTier3: "18" },
};
const layerRow = {
  ref: "pack",
  label: null,
  price: 33,
  listPrice: 42,
  source: "customer",
  aboveList: false,
};

const open = async (layer: () => Promise<unknown>) => {
  get.mockImplementation((url: string) => {
    if (url === "/customers/c1") return Promise.resolve({ data: customer });
    if (url === "/customers/c1/prices") return Promise.resolve({ data: [priceRow, priceRow2] });
    if (url === "/customers/c1/price-layer") return layer();
    if (url === "/customers/c1/statement")
      return Promise.resolve({ data: { transactions: [], creditExposure: 0 } });
    if (url === "/customers/c1/routes") return Promise.resolve({ data: [] });
    if (url === "/policies") return Promise.resolve({ data: { policies: [] } });
    return Promise.resolve({ data: [] });
  });
  render(
    <Providers>
      <CustomerDetailPage />
    </Providers>,
  );
  await screen.findAllByText("Acme Foods");
  await userEvent.setup().click(await screen.findByRole("tab", { name: /special prices/i }));
  await screen.findByText("Soda");
};
const layerCalls = () => get.mock.calls.filter((c) => String(c[0]).endsWith("/price-layer"));

beforeEach(() => {
  // jsdom has no scrollIntoView (the page scrolls the active tab into view).
  Element.prototype.scrollIntoView = jest.fn();
  flagOn = true;
  get.mockReset();
});

describe("S19b C-4: the customer price list shows the layer price", () => {
  it("C-4: a typed pack $33 (list $42, tier 3 $36) shows $33.00, not the tier $36.00", async () => {
    await open(() =>
      Promise.resolve({ data: { customerId: "c1", complete: true, products: { p1: [layerRow] } } }),
    );
    expect(await screen.findByText("$33.00")).toBeInTheDocument();
    expect(screen.queryByText("$36.00")).not.toBeInTheDocument();
  });

  it("flag OFF: no price-layer request and master's tier price ($36.00)", async () => {
    flagOn = false;
    await open(() => Promise.reject(new Error("must not be called")));
    expect(await screen.findByText("$36.00")).toBeInTheDocument();
    expect(layerCalls()).toHaveLength(0);
  });

  it("M3: while the layer is pending the tier price is not shown as final", async () => {
    await open(() => new Promise(() => {}));
    expect(await screen.findByText("Checking this customer's prices\u2026")).toBeInTheDocument();
    expect(screen.queryByText("$36.00")).not.toBeInTheDocument();
  });

  it("M3: one notice for the whole list, not one per row", async () => {
    await open(() => new Promise(() => {}));
    await screen.findByText("Juice");
    expect(screen.getAllByText("Checking this customer's prices…")).toHaveLength(1);
  });

  it("M3: a failed layer read says so, with Retry, and shows no tier price", async () => {
    await open(() => Promise.reject(new Error("boom")));
    expect(await screen.findByText(/couldn't load this customer's prices/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("$36.00")).not.toBeInTheDocument());
  });
});
