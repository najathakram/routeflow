import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * M8 pins: which "move off pickup" actions a POS (pickup) order offers, per account fulfilment capability.
 *   both ROUTE+SHIP -> Switch to delivery (ROUTE) and Ship by carrier… (SHIP): page.ship-by-carrier.test.tsx
 *   ship-only       -> only Ship by carrier…
 *   route-only      -> only Switch to delivery (ROUTE)
 *   pickup-only     -> only the old lone Switch to delivery (to the SHIP fallback), no Ship by carrier…
 */
const get = jest.fn();
const patch = jest.fn();
let mockMethods: string[] = [];
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "o1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/orders/o1",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => children,
}));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@/app/(dashboard)/returns/_components/RecordReturnAction", () => ({
  RecordReturnAction: () => <button type="button">Record return</button>,
}));
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    data: {
      capabilities: {
        fulfilment: {
          methods: mockMethods,
          staffDefault: mockMethods[0],
          staffOpensAs: "order",
          portalMethods: [],
          portalDefault: null,
          counter: "off",
          fleet: false,
          consistent: true,
        },
      },
    },
  }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    post: jest.fn(),
  },
}));

const order = (status: string) => ({
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "cust-9",
  customer: { id: "cust-9", businessName: "Acme Retail" },
  status,
  fulfillPath: "PICKUP",
  counterSale: false,
  cancelBlockedReason: null,
  editWindow: { editable: true },
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  lineItems: [],
  invoices: [],
});

const open = async (methods: string[], status: string) => {
  mockMethods = methods;
  seedSession("OPERATOR");
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/o1" ? order(status) : [] }),
  );
  patch.mockResolvedValue({ data: order(status) });
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  await screen.findByText(/ORD-1/);
};
const sw = () => screen.queryByRole("button", { name: /^Switch to delivery$/ });
const ship = () => screen.queryByRole("button", { name: /^Ship by carrier…$/ });
const moveTo = async (button: HTMLElement, path: string) => {
  fireEvent.click(button);
  await screen.findByText(/Move this order off in-store pickup\?/);
  fireEvent.click(screen.getByRole("button", { name: "Move order" }));
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith("/orders/o1/fulfill-path", { fulfillPath: path }),
  );
};

beforeEach(() => jest.clearAllMocks());
afterEach(() => seedSession(null));

describe.each(["PENDING", "CONFIRMED"])("a %s pickup order, per account", (status) => {
  it("ship-only: only Ship by carrier…, to SHIP", async () => {
    await open(["SHIP"], status);
    expect(sw()).toBeNull();
    await moveTo(ship() as HTMLElement, "SHIP");
  });

  it("route-only: only Switch to delivery, to ROUTE", async () => {
    await open(["ROUTE"], status);
    expect(ship()).toBeNull();
    await moveTo(sw() as HTMLElement, "ROUTE");
  });

  it("pickup-only: the lone Switch to delivery stays (to the SHIP fallback), no Ship by carrier…", async () => {
    await open(["PICKUP"], status);
    expect(ship()).toBeNull();
    await moveTo(sw() as HTMLElement, "SHIP");
  });
});
