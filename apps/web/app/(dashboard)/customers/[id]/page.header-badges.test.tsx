import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { Providers } from "@/app/providers";
import CustomerDetailPage from "./page";

// UX C1 / decision E: the customer header badges (status, tier pricing, customer type) share the design system's neutral
// tone and carry no icon, instead of three per-screen styles.
let fleet = true;
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

const open = async (over: Record<string, unknown> = {}) => {
  get.mockImplementation((url: string) => {
    if (url === "/customers/c1") return Promise.resolve({ data: { ...customer, ...over } });
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
};
const header = () => screen.getByRole("heading", { name: "Acme Foods" }).parentElement!;

beforeEach(() => jest.clearAllMocks());

describe("customer detail header badges", () => {
  it("the tier badge is the neutral tone, keeps its 'pricing' text, and has no icon", async () => {
    await open();
    const tier = within(header()).getByText(/pricing$/i);
    expect(tier.className).toMatch(/\bbg-sunken\b/);
    expect(tier.className).not.toMatch(/bg-info-bg/);
    expect(tier.querySelector("svg")).toBeNull();
  });

  it("a business customer's type badge is neutral text with no icon or colour of its own", async () => {
    await open();
    const type = within(header()).getByText("Business");
    expect(type.className).toMatch(/\bbg-sunken\b/);
    expect(type.className).not.toMatch(/blue-|purple-/);
    expect(type.querySelector("svg")).toBeNull();
  });

  it("an individual customer's type badge is neutral too, text kept", async () => {
    await open({ customerType: "individual" });
    const type = within(header()).getByText("Individual");
    expect(type.className).toMatch(/\bbg-sunken\b/);
    expect(type.className).not.toMatch(/blue-|purple-/);
    expect(type.querySelector("svg")).toBeNull();
  });
});
