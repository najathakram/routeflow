import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Providers } from "@/app/providers";
import CustomerDetailPage from "./page";

// SA-1211: the customer page names the prepaid balance "Credit" (profile tile and billing card), never "Advance Balance".
let fleet = true;
let tab = "";
const get = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "c1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  usePathname: () => "/customers/c1",
  useSearchParams: () => new URLSearchParams(tab ? `tab=${tab}` : ""),
}));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => children,
}));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useFleetAccess: () => ({ fleet, loading: false }),
  useRoutesAccess: () => ({ enabled: fleet, resolved: true }),
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
  pricingTier: 1,
  user: { status: "ACTIVE" },
  addresses: [],
};

const open = async () => {
  get.mockImplementation((url: string) => {
    if (url === "/customers/c1") return Promise.resolve({ data: customer });
    if (url === "/customers/c1/statement")
      return Promise.resolve({ data: { transactions: [], creditExposure: 0, advanceBalance: 25 } });
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
};

beforeEach(() => {
  jest.clearAllMocks();
  tab = "";
});

describe("customer detail Credit label", () => {
  it("the profile tile reads exactly Credit, not Advance Balance", async () => {
    await open();
    expect(await screen.findByText("Credit", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("Advance Balance")).toBeNull();
  });

  it("the billing card reads exactly Credit, not Advance Balance", async () => {
    tab = "billing";
    await open();
    expect(await screen.findByText("Credit", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("Advance Balance")).toBeNull();
  });
});
