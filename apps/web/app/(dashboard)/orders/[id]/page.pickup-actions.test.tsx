import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * Order ahead, staff side: a PICKUP order is "Ready for pickup" -> "Picked up". The OUT_FOR_DELIVERY
 * action reads "Ready for pickup" (not Out for Delivery); "Picked up" opens the hand-over dialog while
 * the order is CONFIRMED or OUT_FOR_DELIVERY; "Mark as Delivered" is hidden for PICKUP (Picked up is the
 * completion path) and unchanged for ROUTE / SHIP.
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
// Add-on gated and unrelated to the role gate: a stub so the "Record return" button is always there to hide.
jest.mock("@/app/(dashboard)/returns/_components/RecordReturnAction", () => ({
  RecordReturnAction: () => <button type="button">Record return</button>,
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (...a: unknown[]) => get(...a), patch: jest.fn(), post: jest.fn() },
}));

const order = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "cust-9",
  customer: { id: "cust-9", businessName: "Acme Retail" },
  status,
  fulfillPath: "ROUTE",
  cancelBlockedReason: null,
  // The edit window is open at every live stage on purpose: the role gate, not this fixture, must hide Edit Items.
  editWindow: { editable: status !== "CANCELLED" },
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  lineItems: [],
  ...extra,
});

type Role = "OPERATOR" | "TENANT_ADMIN" | "SUPER_ADMIN" | "CUSTOMER" | "DRIVER" | null;

const open = async (role: Role, status: string, extra: Record<string, unknown> = {}) => {
  seedSession(role);
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/o1" ? order(status, extra) : [] }),
  );
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  await screen.findByText(/ORD-1/);
};

const has = (re: RegExp) => !!screen.queryByRole("button", { name: re });

beforeEach(() => jest.clearAllMocks());
afterEach(() => seedSession(null));

describe("PICKUP order actions", () => {
  it("CONFIRMED: 'Ready for pickup' replaces 'Out for Delivery'; 'Picked up' is offered", async () => {
    await open("OPERATOR", "CONFIRMED", { fulfillPath: "PICKUP" });
    expect(has(/^Ready for pickup$/)).toBe(true);
    expect(has(/^Out for Delivery$/)).toBe(false);
    expect(has(/^Mark shipped$/)).toBe(false);
    expect(has(/^Picked up$/)).toBe(true);
  });

  it("OUT_FOR_DELIVERY (Ready for pickup): 'Picked up' is the completion; Mark as Delivered is hidden", async () => {
    await open("OPERATOR", "OUT_FOR_DELIVERY", { fulfillPath: "PICKUP" });
    expect(has(/^Picked up$/)).toBe(true);
    expect(has(/^Mark as Delivered$/)).toBe(false);
    expect(has(/^Mark delivered$/)).toBe(false);
  });

  it.each(["PENDING", "DELIVERED", "CANCELLED"])("%s: no 'Picked up'", async (status) => {
    await open("OPERATOR", status, { fulfillPath: "PICKUP" });
    expect(has(/^Picked up$/)).toBe(false);
  });

  it("a customer session never sees Picked up", async () => {
    await open("CUSTOMER", "OUT_FOR_DELIVERY", { fulfillPath: "PICKUP" });
    expect(has(/^Picked up$/)).toBe(false);
  });

  it("ROUTE keeps Mark as Delivered and gets no Picked up", async () => {
    await open("OPERATOR", "OUT_FOR_DELIVERY", { fulfillPath: "ROUTE" });
    expect(has(/^Mark as Delivered$/)).toBe(true);
    expect(has(/^Picked up$/)).toBe(false);
  });

  it("SHIP keeps Mark delivered and gets no Picked up", async () => {
    await open("OPERATOR", "OUT_FOR_DELIVERY", { fulfillPath: "SHIP" });
    expect(has(/^Mark delivered$/)).toBe(true);
    expect(has(/^Picked up$/)).toBe(false);
  });

  it("ROUTE CONFIRMED still reads Out for Delivery", async () => {
    await open("OPERATOR", "CONFIRMED", { fulfillPath: "ROUTE" });
    expect(has(/^Out for Delivery$/)).toBe(true);
    expect(has(/^Ready for pickup$/)).toBe(false);
  });
});
