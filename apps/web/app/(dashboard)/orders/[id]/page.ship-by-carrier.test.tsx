import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * M8 (qa-azm): shipping a pickup order. The POS action bar offers "Ship by carrier…" next to "Switch to
 * delivery"; its confirm says it becomes a carrier shipment (carrier + tracking); a SHIP order shows its
 * Shipment card ABOVE Summary; a POS step that is still to do reads as "next", not as a state.
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
jest.mock("@/app/(dashboard)/returns/_components/RecordReturnAction", () => ({
  RecordReturnAction: () => <button type="button">Record return</button>,
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    post: jest.fn(),
  },
}));

const order = (status: string, extra: Record<string, unknown> = {}) => ({
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
  ...extra,
});

const shippedRule = (enabled: boolean) => ({
  events: [
    { eventKey: "ORDER_SHIPPED", channels: [{ channel: "EMAIL", enabled }] },
    { eventKey: "ORDER_CONFIRMED", channels: [{ channel: "EMAIL", enabled: true }] },
  ],
});

const open = async (
  status: string,
  extra: Record<string, unknown> = {},
  messaging: unknown = [],
) => {
  seedSession("OPERATOR");
  get.mockImplementation((url: string) =>
    Promise.resolve({
      data:
        url === "/orders/o1" ? order(status, extra) : url === "/messaging/config" ? messaging : [],
    }),
  );
  patch.mockResolvedValue({ data: order(status, extra) });
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  await screen.findByText(/ORD-1/);
};

beforeEach(() => jest.clearAllMocks());
afterEach(() => seedSession(null));

describe("M8a: Ship by carrier… on a pickup order", () => {
  it.each(["PENDING", "CONFIRMED"])(
    "%s: offered next to Switch to delivery; the confirm names the carrier and tracking, then PATCHes SHIP",
    async (status) => {
      await open(status);
      expect(screen.getByRole("button", { name: /^Switch to delivery$/ })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /^Ship by carrier…$/ }));
      await screen.findByText(/Move this order off in-store pickup\?/);
      expect(screen.getByText(/carrier and tracking number/i)).toBeInTheDocument();
      expect(patch).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Move order" }));
      await waitFor(() =>
        expect(patch).toHaveBeenCalledWith("/orders/o1/fulfill-path", { fulfillPath: "SHIP" }),
      );
    },
  );

  it("Switch to delivery still goes to the delivery route, and says nothing about carriers", async () => {
    await open("CONFIRMED");
    fireEvent.click(screen.getByRole("button", { name: /^Switch to delivery$/ }));
    await screen.findByText(/Move this order off in-store pickup\?/);
    expect(screen.queryByText(/carrier and tracking number/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Move order" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/orders/o1/fulfill-path", { fulfillPath: "ROUTE" }),
    );
  });

  it("no Ship by carrier… once handed over", async () => {
    await open("DELIVERED", {
      invoices: [{ id: "i1", invoiceNumber: "I", status: "PAID", total: 10, payments: [] }],
    });
    expect(screen.queryByRole("button", { name: /Ship by carrier/ })).toBeNull();
  });
});

describe("M8b: the Shipment card sits above Summary on a SHIP order", () => {
  const before = (a: HTMLElement, b: HTMLElement) =>
    !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it("SHIP: Shipment comes before Summary", async () => {
    await open("PENDING", { fulfillPath: "SHIP" });
    const shipment = screen.getByText("Shipment", { selector: "h3, h2, h4, div, span, p" });
    const summary = screen.getByText("Summary", { selector: "h3, h2, h4, div, span, p" });
    expect(before(shipment, summary)).toBe(true);
    expect(screen.getByRole("button", { name: /Add tracking/ })).toBeInTheDocument();
  });

  it("historical non-SHIP order with tracking data: Shipment stays below Summary", async () => {
    await open("DELIVERED", {
      fulfillPath: "ROUTE",
      shippingCarrier: "ups",
      shippingTrackingNumber: "1Z999",
    });
    const shipment = screen.getByText("Shipment", { selector: "h3, h2, h4, div, span, p" });
    const summary = screen.getByText("Summary", { selector: "h3, h2, h4, div, span, p" });
    expect(before(summary, shipment)).toBe(true);
  });
});

describe("M8d: a step still to do reads as the next step", () => {
  it("PENDING POS order: the Confirmed step is announced as next, not as a state", async () => {
    await open("PENDING");
    const list = screen.getByRole("list", { name: "Order progress" });
    const confirmed = within(list).getAllByRole("listitem")[0];
    expect(confirmed).toHaveAttribute("aria-current", "step");
    expect(confirmed).toHaveTextContent(/Confirmed\s*\(next step\)/);
  });
});

describe("M8d: the not-shipped line follows the order-shipped notification setting", () => {
  const ship = { fulfillPath: "SHIP", shippingCarrier: "ups", shippingTrackingNumber: "1Z999" };

  it("on: says the customer is told when the order is marked shipped", async () => {
    await open("PENDING", ship, shippedRule(true));
    expect(
      await screen.findByText(/The customer is told when you mark the order shipped/),
    ).toBeInTheDocument();
  });

  it("off: just 'Not shipped yet.'", async () => {
    await open("PENDING", ship, shippedRule(false));
    const line = await screen.findByText(/^Not shipped yet\./);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/messaging/config"));
    expect(line).toHaveTextContent(/^Not shipped yet\.$/);
  });

  it("setting unknown (config not loaded): no claim either", async () => {
    await open("PENDING", ship);
    expect(await screen.findByText(/^Not shipped yet\./)).toHaveTextContent(/^Not shipped yet\.$/);
  });
});
