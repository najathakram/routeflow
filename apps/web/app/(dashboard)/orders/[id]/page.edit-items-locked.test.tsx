import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * W-861 (SA-944 §3): the order read carries `editItemsLocked` (a paid walk-in sale; the server refuses the items
 * edit with 409 WALK_IN_SALE_PAID). The page reads it, never re-derives it: Edit Items is not offered, and a line
 * says what to do instead. false/absent leaves Edit Items exactly as before.
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

const open = async (extra: Record<string, unknown>) => {
  seedSession("OPERATOR");
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/o1" ? order("DELIVERED", extra) : [] }),
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

describe("W-861: a paid walk-in sale on the order page", () => {
  it("editItemsLocked: no Edit Items, and the what-to-do line is shown", async () => {
    await open({ editItemsLocked: true });
    expect(screen.queryByRole("button", { name: /^Edit Items$/ })).toBeNull();
    expect(screen.getByTestId("edit-items-locked")).toHaveTextContent(
      "This sale is paid. Ring up added items as a new sale, or use Return to take items back.",
    );
  });

  it("editItemsLocked false: Edit Items is offered and no lock line", async () => {
    await open({ editItemsLocked: false });
    expect(screen.getByRole("button", { name: /^Edit Items$/ })).toBeInTheDocument();
    expect(screen.queryByTestId("edit-items-locked")).toBeNull();
  });
});
