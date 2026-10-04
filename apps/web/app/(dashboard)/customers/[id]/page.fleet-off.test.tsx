import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import CustomerDetailPage from "./page";

// Fleet-off clean UI on the customer detail: no "Assigned Routes" card, no "Assign to Route", and the
// /customers/:id/routes request is never made. Fleet-on shows today's card.
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

const open = async () => {
  get.mockImplementation((url: string) => {
    if (url === "/customers/c1") return Promise.resolve({ data: customer });
    if (url === "/customers/c1/statement")
      return Promise.resolve({ data: { transactions: [], creditExposure: 0 } });
    if (url === "/customers/c1/routes")
      return Promise.resolve({ data: [{ id: "r1", name: "Route A", isActive: true }] });
    return Promise.resolve({ data: [] });
  });
  render(
    <Providers>
      <CustomerDetailPage />
    </Providers>,
  );
  await screen.findAllByText("Acme Foods");
};

beforeEach(() => jest.clearAllMocks());

describe("customer detail — fleet-off clean UI", () => {
  it("fleet-OFF: no Assigned Routes card, no Assign to Route, and no routes request", async () => {
    fleet = false;
    await open();
    expect(screen.queryByText("Assigned Routes")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /assign to route/i })).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(get.mock.calls.map((c) => c[0])).not.toContain("/customers/c1/routes");
  });

  it("fleet-ON (today's UI, unchanged): the card, its route and the Assign button", async () => {
    fleet = true;
    await open();
    expect(await screen.findByText("Assigned Routes")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Route A")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /assign to route/i })).toBeInTheDocument();
  });
});
