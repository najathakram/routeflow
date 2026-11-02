import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import CustomerDetailPage from "./page";

// SA-1084 (SI-14): the customer page shows the tax ID as "On file, ending ####" and the stored value appears nowhere
// in the page. The api does not send it; this proves the page prints only what it is given.
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
  taxIdLast4: "6789",
};

const open = async (data: Record<string, unknown>) => {
  get.mockImplementation((url: string) => {
    if (url === "/customers/c1") return Promise.resolve({ data });
    if (url === "/customers/c1/statement")
      return Promise.resolve({ data: { transactions: [], creditExposure: 0 } });
    if (url === "/policies") return Promise.resolve({ data: { policies: [] } });
    return Promise.resolve({ data: [] });
  });
  render(
    <Providers>
      <CustomerDetailPage />
    </Providers>,
  );
  await screen.findAllByText("Acme Foods");
};

beforeEach(() => {
  // jsdom has no scrollIntoView (the page scrolls the active tab into view).
  Element.prototype.scrollIntoView = jest.fn();
  flagOn = true;
  get.mockReset();
});

describe("SA-1084: the customer page shows the tax ID as its last 4", () => {
  it("SI-14: a tax ID on file reads 'On file, ending 6789' and nothing longer is in the page", async () => {
    await open(customer);
    expect(await screen.findByText("On file, ending 6789")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/12-3456789|123456789/);
  });

  it("no tax ID on file: no Tax ID row at all", async () => {
    await open({ ...customer, taxIdLast4: null });
    expect(screen.queryByText(/On file, ending/)).not.toBeInTheDocument();
    expect(screen.queryByText("Tax ID")).not.toBeInTheDocument();
  });
});
