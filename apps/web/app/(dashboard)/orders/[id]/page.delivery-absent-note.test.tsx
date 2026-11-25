import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import { DELIVERY_STEPS_ABSENT_COPY } from "@routeflow/types";
import OrderDetailPage from "./page";

/**
 * W-1306 / #4510: the "why is there no Out for delivery step" note on the order page. It renders for staff
 * on a CONFIRMED order that is not being edited, and for no one else. Every absence is asserted beside its
 * twin (the same page, the same wait) that shows the note, so an absence can never pass because the
 * features answer had not landed yet.
 */
const get = jest.fn();
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
  RecordReturnAction: () => null,
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: jest.fn(),
    post: jest.fn(),
  },
}));

const NOTE = DELIVERY_STEPS_ABSENT_COPY.NO_FLEET;
// a delivery business that configured its portal and runs no fleet: reason NO_FLEET
const NO_FLEET_CAPS = {
  methods: ["ROUTE"],
  staffDefault: "ROUTE",
  staffOpensAs: "order",
  portalMethods: ["ROUTE"],
  portalDefault: "ROUTE",
  counter: "off",
  fleet: false,
  consistent: true,
};

const order = (status: string) => ({
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "cust-9",
  customer: { id: "cust-9", businessName: "Acme Retail" },
  status,
  fulfillPath: "ROUTE",
  cancelBlockedReason: null,
  editWindow: { editable: true },
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  lineItems: [],
  invoices: [],
});

const open = async (status: string, role = "OPERATOR", fleet = false) => {
  seedSession(role as never);
  get.mockImplementation((url: string) =>
    Promise.resolve({
      data:
        url === "/orders/o1"
          ? order(status)
          : url === "/tenants/me/features"
            ? { capabilities: { fulfilment: { ...NO_FLEET_CAPS, fleet } } }
            : url === "/users/me/permissions"
              ? {
                  role,
                  isAccountAdmin: false,
                  groups: ["PRICING", "ORDERS", "FINANCE"],
                  version: 1,
                  mode: "shadow",
                }
              : [],
    }),
  );
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  await screen.findByText(/ORD-1/);
  await waitFor(() => expect(get).toHaveBeenCalledWith("/tenants/me/features"));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
};

const note = () => screen.queryByText(NOTE);

beforeEach(() => jest.clearAllMocks());
afterEach(() => {
  cleanup();
  seedSession(null);
});

describe("order page: delivery-steps-absent note (W-1306)", () => {
  it("staff, CONFIRMED, not editing: the NO_FLEET sentence renders", async () => {
    await open("CONFIRMED");
    expect(await screen.findByText(NOTE)).toBeInTheDocument();
  });

  it("a fleet business has no note on the same order (the reason, not the page, gates it)", async () => {
    await open("CONFIRMED", "OPERATOR", true);
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
    expect(note()).toBeNull();
  });

  it("while editing items the note is gone (twin: shown before Edit Items is clicked)", async () => {
    await open("CONFIRMED");
    expect(await screen.findByText(NOTE)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /edit items/i }));
    await screen.findByRole("button", { name: /^save changes$/i });
    expect(note()).toBeNull();
  });

  it("PENDING: no note (twin: CONFIRMED shows it)", async () => {
    await open("CONFIRMED");
    expect(await screen.findByText(NOTE)).toBeInTheDocument();
    cleanup();
    await open("PENDING");
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
    expect(note()).toBeNull();
  });

  it.each(["CUSTOMER", "DRIVER"])("%s: no note (twin: staff shows it)", async (role) => {
    await open("CONFIRMED");
    expect(await screen.findByText(NOTE)).toBeInTheDocument();
    cleanup();
    await open("CONFIRMED", role);
    await screen.findByText(/ORD-1/);
    expect(note()).toBeNull();
  });
});
