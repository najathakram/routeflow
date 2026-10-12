import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * Row 342: a handed-over order's header says where and by whom ("Handed over by Pat · main"). Staff reads only: a
 * customer session sees nothing, and an order that was not handed over (or has no stamp) shows nothing.
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

const order = (extra: Record<string, unknown> = {}) => ({
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "cust-9",
  customer: { id: "cust-9", businessName: "Acme Retail" },
  status: "DELIVERED",
  fulfillPath: "PICKUP",
  cancelBlockedReason: null,
  editWindow: { editable: false },
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  lineItems: [],
  createdAt: "2026-10-07T15:15:00.000Z",
  ...extra,
});

type Role = "OPERATOR" | "TENANT_ADMIN" | "CUSTOMER" | null;
const open = async (role: Role, extra: Record<string, unknown> = {}, timezone?: string) => {
  seedSession(role);
  get.mockImplementation((url: string) =>
    Promise.resolve({
      data:
        url === "/orders/o1" ? order(extra) : url === "/settings" && timezone ? { timezone } : [],
    }),
  );
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  await screen.findByText(/ORD-1/);
};

beforeEach(() => jest.clearAllMocks());
afterEach(() => seedSession(null));

describe("order header hand-over stamp (row 342)", () => {
  it("staff: register and cashier", async () => {
    await open("OPERATOR", {
      registerKey: "main",
      handedOverBy: "Pat",
      soldBy: { username: "Pat" },
    });
    expect(screen.getByTestId("hand-over-stamp")).toHaveTextContent("Handed over by Pat · main");
  });
  it("staff: register only when no cashier is stamped", async () => {
    await open("TENANT_ADMIN", { registerKey: "main", handedOverBy: null, soldBy: null });
    const stamp = screen.getByTestId("hand-over-stamp");
    expect(stamp).toHaveTextContent("Handed over · main");
    expect(stamp).not.toHaveTextContent(" by ");
  });
  it("staff: an unstamped register (null) reads as main", async () => {
    await open("OPERATOR", { registerKey: null, handedOverBy: "Pat", soldBy: { username: "Pat" } });
    expect(screen.getByTestId("hand-over-stamp")).toHaveTextContent("Handed over by Pat · main");
  });
  it("staff: the hand-over time in the business's zone once it is known", async () => {
    await open(
      "OPERATOR",
      { registerKey: "main", handedOverBy: "Pat", deliveredAt: "2026-10-07T15:14:00.000Z" },
      "America/New_York",
    );
    await screen.findByText("Handed over by Pat · main · Oct 7, 2026, 11:14 AM");
  });
  it("a customer session never sees it, even if a stamp rode the payload", async () => {
    await open("CUSTOMER", { registerKey: "main", handedOverBy: "Pat" });
    expect(screen.queryByTestId("hand-over-stamp")).toBeNull();
  });
  it("no stamp on the read (an older API): nothing", async () => {
    await open("OPERATOR");
    expect(screen.queryByTestId("hand-over-stamp")).toBeNull();
  });
  it("an order not handed over (a ROUTE order) shows nothing", async () => {
    await open("OPERATOR", { fulfillPath: "ROUTE", registerKey: "main", handedOverBy: "Pat" });
    expect(screen.queryByTestId("hand-over-stamp")).toBeNull();
  });
});
