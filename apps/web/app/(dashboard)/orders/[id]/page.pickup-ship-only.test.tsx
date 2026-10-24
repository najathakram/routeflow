import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * A PICKUP order on a ship-only account: the Fulfillment select lists "Pick up at store" (current) and
 * SHIP; choosing SHIP asks first; confirming PATCHes SHIP; the select is still there afterwards even though
 * SHIP is now the only path the account offers.
 */
const get = jest.fn();
const patch = jest.fn();
let current = "PICKUP";
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
  fulfillPath: current,
  cancelBlockedReason: null,
  editWindow: { editable: true },
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  lineItems: [],
});

beforeEach(() => {
  jest.clearAllMocks();
  current = "PICKUP";
  seedSession("OPERATOR");
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/o1" ? order() : [] }),
  );
  patch.mockImplementation(() => {
    current = "SHIP";
    return Promise.resolve({ data: { ...order(), fulfillPath: "SHIP" } });
  });
});
afterEach(() => seedSession(null));

describe("PICKUP order on a ship-only account", () => {
  it("lists the current path and SHIP, asks before leaving pickup, PATCHes SHIP and keeps the select", async () => {
    render(
      <Providers>
        <OrderDetailPage />
      </Providers>,
    );
    await screen.findByText(/ORD-1/);
    const select = screen.getByDisplayValue("Pick up at store") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["SHIP", "PICKUP"]);

    fireEvent.change(select, { target: { value: "SHIP" } });
    expect(await screen.findByText(/Move this order off in-store pickup\?/)).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Move order" }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][0]).toBe("/orders/o1/fulfill-path");
    expect(patch.mock.calls[0][1]).toEqual({ fulfillPath: "SHIP" });
    await waitFor(() => expect(screen.queryByText(/Ships via carrier/)).toBeInTheDocument());
    expect(screen.getByText("Fulfillment")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Ship via carrier")).toBeInTheDocument();
  });
});
