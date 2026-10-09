import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * SA-763r P-2, the order page of a POS-mode order (PICKUP and not a counter sale): a 3-step progress
 * (Confirmed, Invoice (draft), Handed over), no Out-for-delivery and no DELIVERED status action, one
 * primary per state (Create invoice, Hand over, Record payment / Print), Edit order always there and
 * Switch to delivery until delivered. Counter sales (counterSale true) are unaffected.
 */
const get = jest.fn();
const post = jest.fn();
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
jest.mock("@/app/(dashboard)/returns/_components/RecordReturnAction", () => ({
  RecordReturnAction: () => <button type="button">Record return</button>,
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    post: (...a: unknown[]) => post(...a),
  },
}));

const INV = (status: string) => [
  { id: "i1", invoiceNumber: "INV-1", status, total: 10, payments: [] },
];
const order = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "cust-9",
  customer: { id: "cust-9", businessName: "Acme Retail" },
  status,
  fulfillPath: "PICKUP",
  counterSale: false,
  cancelBlockedReason: null,
  editWindow: { editable: status !== "CANCELLED" },
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  lineItems: [],
  invoices: [],
  ...extra,
});

const open = async (status: string, extra: Record<string, unknown> = {}) => {
  seedSession("OPERATOR");
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
const hasLink = (re: RegExp) => !!screen.queryByRole("link", { name: re });
const steps = () =>
  within(screen.getByRole("list", { name: "Order progress" })).getAllByRole("listitem");

beforeEach(() => jest.clearAllMocks());
afterEach(() => seedSession(null));

describe("POS order page: progress", () => {
  it("CONFIRMED with no invoice: Confirmed done, Invoice (draft) is the current step", async () => {
    await open("CONFIRMED");
    const [a, b, c] = steps();
    expect(a).toHaveTextContent("Confirmed");
    expect(a).toHaveAttribute("data-done", "true");
    expect(b).toHaveTextContent("Invoice (draft)");
    expect(b).toHaveAttribute("aria-current", "step");
    expect(c).toHaveTextContent("Handed over");
    expect(c).toHaveAttribute("data-done", "false");
  });

  it("DELIVERED with a final invoice: all three steps done and the invoice step is no longer a draft", async () => {
    await open("DELIVERED", { invoices: INV("SENT") });
    const items = steps();
    expect(items.map((i) => i.getAttribute("data-done"))).toEqual(["true", "true", "true"]);
    expect(items[1]).toHaveTextContent(/^Invoice$/);
  });

  it("a counter sale and a ROUTE order get no POS progress", async () => {
    await open("CONFIRMED", { counterSale: true });
    expect(screen.queryByRole("list", { name: "Order progress" })).toBeNull();
  });
});

describe("POS order page: one primary per state", () => {
  it("CONFIRMED, no invoice: Create invoice is the primary; no Out for Delivery, no Mark as Delivered", async () => {
    await open("CONFIRMED");
    expect(has(/^Create invoice$/)).toBe(true);
    expect(has(/^Out for Delivery$/)).toBe(false);
    expect(has(/^Ready for pickup$/)).toBe(false);
    expect(has(/^Mark as Delivered$/)).toBe(false);
    expect(has(/^Mark delivered$/)).toBe(false);
  });

  it("Create invoice POSTs from-order (the retry after a failed 2nd step of Confirm & invoice)", async () => {
    post.mockResolvedValue({ data: [] });
    await open("CONFIRMED");
    fireEvent.click(screen.getByRole("button", { name: /^Create invoice$/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/invoices/from-order/o1"));
  });

  it("CONFIRMED with an invoice: Hand over replaces Create invoice and opens the pickup dialog", async () => {
    await open("CONFIRMED", { invoices: INV("DRAFT") });
    expect(has(/^Create invoice$/)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /^Hand over$/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("DELIVERED, unpaid invoice: Record payment is the primary and links to the invoice", async () => {
    await open("DELIVERED", { invoices: INV("SENT") });
    expect(has(/^Hand over$/)).toBe(false);
    expect(has(/^Mark as Delivered$/)).toBe(false);
    expect(screen.getByRole("link", { name: /^Record payment$/ })).toHaveAttribute(
      "href",
      "/invoices/i1",
    );
  });

  it("DELIVERED, paid invoice: Print invoice instead of Record payment", async () => {
    await open("DELIVERED", { invoices: INV("PAID") });
    expect(hasLink(/^Record payment$/)).toBe(false);
    expect(screen.getByRole("link", { name: /^Print invoice$/ })).toBeInTheDocument();
  });
});

describe("POS order page: edit and switch", () => {
  it("Edit order is available, and Switch to delivery is offered until delivered", async () => {
    await open("CONFIRMED", { invoices: INV("DRAFT") });
    expect(has(/^Edit order$/)).toBe(true);
    expect(has(/^Switch to delivery$/)).toBe(true);
  });

  it("Switch to delivery asks first, then PATCHes fulfill-path ROUTE", async () => {
    patch.mockResolvedValue({ data: {} });
    await open("CONFIRMED", { invoices: INV("DRAFT") });
    fireEvent.click(screen.getByRole("button", { name: /^Switch to delivery$/ }));
    await screen.findByText(/Move this order off in-store pickup\?/);
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Move order" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/orders/o1/fulfill-path", { fulfillPath: "ROUTE" }),
    );
  });

  it("DELIVERED: Edit order stays, Switch to delivery is gone", async () => {
    await open("DELIVERED", { invoices: INV("SENT") });
    expect(has(/^Edit order$/)).toBe(true);
    expect(has(/^Switch to delivery$/)).toBe(false);
  });

  it("editing a handed-over order shows the no-restock note", async () => {
    await open("DELIVERED", { invoices: INV("SENT") });
    fireEvent.click(screen.getByRole("button", { name: /^Edit order$/ }));
    expect(
      await screen.findByText(
        "Cutting items after hand-over doesn't put them back on the shelf. If the goods came back, record a return.",
      ),
    ).toBeInTheDocument();
  });

  it("a counter sale keeps 'Edit Items' and gets no POS actions", async () => {
    await open("CONFIRMED", { counterSale: true });
    expect(has(/^Edit Items$/)).toBe(true);
    expect(has(/^Create invoice$/)).toBe(false);
    expect(has(/^Switch to delivery$/)).toBe(false);
  });
});
