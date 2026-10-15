import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * POS order page on a ship-only account: the only move off pickup is "Ship by carrier…" (SHIP), never a
 * hard-coded ROUTE.
 */
const get = jest.fn();
const patch = jest.fn();
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
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    data: {
      capabilities: {
        fulfilment: {
          methods: ["SHIP"],
          staffDefault: "SHIP",
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

const order = () => ({
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "cust-9",
  customer: { id: "cust-9", businessName: "Acme Retail" },
  status: "CONFIRMED",
  fulfillPath: "PICKUP",
  counterSale: false,
  cancelBlockedReason: null,
  editWindow: { editable: true },
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  lineItems: [],
  invoices: [{ id: "i1", invoiceNumber: "INV-1", status: "DRAFT", total: 10, payments: [] }],
});

beforeEach(() => {
  jest.clearAllMocks();
  seedSession("OPERATOR");
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/o1" ? order() : [] }),
  );
  patch.mockResolvedValue({ data: order() });
});
afterEach(() => seedSession(null));

describe("POS order page: a ship-only account moves a pickup order to SHIP", () => {
  it("on a ship-only account it PATCHes SHIP, not ROUTE", async () => {
    render(
      <Providers>
        <OrderDetailPage />
      </Providers>,
    );
    await screen.findByText(/ORD-1/);
    // M8: a ship-only account has no delivery route to switch to: the one move is "Ship by carrier…".
    expect(screen.queryByRole("button", { name: /^Switch to delivery$/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Ship by carrier…$/ }));
    await screen.findByText(/Move this order off in-store pickup\?/);
    fireEvent.click(screen.getByRole("button", { name: "Move order" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/orders/o1/fulfill-path", { fulfillPath: "SHIP" }),
    );
  });
});
