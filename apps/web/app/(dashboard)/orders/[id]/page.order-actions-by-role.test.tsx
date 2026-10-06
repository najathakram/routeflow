import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * B1134: this page is reachable by CUSTOMER sessions (RouteGuard's CUSTOMER_ALLOWED lists /orders), but
 * its action bar was gated by order status alone. A customer saw Confirm, Out for Delivery, Mark
 * delivered, Unconfirm, Reopen, Delete and Edit Items after dispatch; the server refuses every one of
 * them. Now: a customer sees Edit Items + Cancel only while the order is PENDING or DRAFT, and nothing
 * else. Staff (OPERATOR, TENANT_ADMIN, SUPER_ADMIN) are unchanged. Any other role, and no session at all
 * (still loading), is treated as non-staff: fail closed.
 *
 * B1135: a customer looking at an order with the carrier is told it has shipped and is offered the exits
 * that exist (a return, a new order, the seller), never a change request.
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

/** Every action-bar control the page offers, by its accessible name (the ROUTE-path labels). */
const ACTIONS: Array<[string, RegExp]> = [
  ["Edit Items", /^Edit Items$/],
  ["Save Draft", /^Save Draft$/],
  ["Record return", /^Record return$/],
  ["Publish Order", /^Publish Order$/],
  ["Delete Draft", /^Delete Draft$/],
  ["Confirm Order", /^Confirm Order$/],
  ["Out for Delivery", /^Out for Delivery$/],
  ["Unconfirm", /^Unconfirm$/],
  ["Mark as Delivered", /^Mark as Delivered$/],
  ["Return to Confirmed", /^Return to Confirmed$/],
  ["Reopen Order", /^Reopen Order$/],
  ["Cancel Order", /^Cancel Order$/],
  ["Delete", /^Delete( order)?$/],
];
const visibleActions = () =>
  ACTIONS.filter(([, re]) => screen.queryByRole("button", { name: re })).map(([name]) => name);
/** A DRAFT opens in edit mode (the page enters it on load); "Cancel" there leaves edit mode. */
const leaveDraftEditMode = () => fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

beforeEach(() => jest.clearAllMocks());
afterEach(() => seedSession(null));

describe("B1134: a CUSTOMER session on the staff order page", () => {
  it("PENDING: only Edit Items and Cancel Order are offered", async () => {
    await open("CUSTOMER", "PENDING");
    expect(visibleActions()).toEqual(["Edit Items", "Cancel Order"]);
  });

  it("DRAFT: the edit form offers Save Draft but no Publish; out of edit mode, Edit Items and Cancel Order only", async () => {
    await open("CUSTOMER", "DRAFT");
    expect(visibleActions()).toEqual(["Save Draft"]);
    leaveDraftEditMode();
    expect(visibleActions()).toEqual(["Edit Items", "Cancel Order"]);
  });

  it.each(["CONFIRMED", "OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", "DELIVERED", "CANCELLED"])(
    "%s: no action at all (no status change, no Delete, no Edit Items, no Cancel)",
    async (status) => {
      await open("CUSTOMER", status);
      expect(visibleActions()).toEqual([]);
    },
  );
});

describe("B1134: an unknown role fails closed (treated as non-staff)", () => {
  it.each<[string, Role]>([
    ["no session", null],
    ["a DRIVER", "DRIVER"],
  ])("%s on a CONFIRMED order: no action", async (_label, role) => {
    await open(role, "CONFIRMED");
    expect(visibleActions()).toEqual([]);
  });

  it.each<[string, Role]>([
    ["no session", null],
    ["a DRIVER", "DRIVER"],
  ])("%s on a PENDING order: no action, not even Edit Items or Cancel", async (_label, role) => {
    await open(role, "PENDING");
    expect(visibleActions()).toEqual([]);
  });
});

describe("B1134 regression pin: staff see the same actions as before", () => {
  const STAFF: Array<[string, Role]> = [
    ["OPERATOR", "OPERATOR"],
    ["TENANT_ADMIN", "TENANT_ADMIN"],
    ["SUPER_ADMIN", "SUPER_ADMIN"],
  ];
  const EXPECTED: Array<[string, string[]]> = [
    ["PENDING", ["Edit Items", "Record return", "Confirm Order", "Cancel Order", "Delete"]],
    [
      "CONFIRMED",
      ["Edit Items", "Record return", "Out for Delivery", "Unconfirm", "Cancel Order", "Delete"],
    ],
    [
      "OUT_FOR_DELIVERY",
      [
        "Edit Items",
        "Record return",
        "Mark as Delivered",
        "Return to Confirmed",
        "Cancel Order",
        "Delete",
      ],
    ],
    ["DELIVERED", ["Edit Items", "Record return", "Reopen Order"]],
    ["CANCELLED", ["Record return", "Reopen Order", "Delete"]],
  ];

  describe.each(STAFF)("%s", (_name, role) => {
    it.each(EXPECTED)("%s offers its full action set", async (status, expected) => {
      await open(role, status);
      expect(visibleActions()).toEqual(expected);
    });

    it("DRAFT: Save Draft and Publish Order in the edit form, then the draft actions", async () => {
      await open(role, "DRAFT");
      expect(visibleActions()).toEqual(["Save Draft", "Publish Order"]);
      leaveDraftEditMode();
      expect(visibleActions()).toEqual([
        "Edit Items",
        "Record return",
        "Publish Order",
        "Delete Draft",
      ]);
    });
  });
});

describe("B1135: a customer on an order with the carrier is shown the exits that exist", () => {
  const SHIPPED = "This order has already shipped. Contact the seller for changes.";
  const withCarrier = { fulfillPath: "SHIP", cancelBlockedReason: "WITH_CARRIER" };

  it.each(["OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED"])(
    "%s: the shipped sentence, a return, a new order, and no change request",
    async (status) => {
      await open("CUSTOMER", status, withCarrier);
      const panel = screen.getByTestId("shipped-order-exits");
      expect(panel).toHaveTextContent(SHIPPED);
      expect(screen.getByRole("link", { name: "start a return" })).toHaveAttribute(
        "href",
        "/returns",
      );
      expect(screen.getByRole("link", { name: "place a new order" })).toHaveAttribute(
        "href",
        "/orders?action=new",
      );
      expect(panel).not.toHaveTextContent(/change request/i);
      expect(visibleActions()).toEqual([]);
    },
  );

  it("a PENDING or CONFIRMED order reopened with the carrier: the same exits, no Edit Items", async () => {
    await open("CUSTOMER", "CONFIRMED", withCarrier);
    expect(screen.getByTestId("shipped-order-exits")).toHaveTextContent(SHIPPED);
    expect(visibleActions()).toEqual([]);
  });

  it("a customer's PENDING with-carrier order is not offered Edit Items or Cancel either", async () => {
    await open("CUSTOMER", "PENDING", withCarrier);
    expect(screen.getByTestId("shipped-order-exits")).toBeInTheDocument();
    expect(visibleActions()).toEqual([]);
  });

  it("an order that is not with the carrier shows no exits panel", async () => {
    await open("CUSTOMER", "OUT_FOR_DELIVERY");
    expect(screen.queryByTestId("shipped-order-exits")).toBeNull();
  });

  it("staff never see the panel (the staff page keeps its own with-carrier note)", async () => {
    await open("OPERATOR", "OUT_FOR_DELIVERY", withCarrier);
    expect(screen.queryByTestId("shipped-order-exits")).toBeNull();
    expect(screen.getAllByText(/already with the carrier/i).length).toBeGreaterThan(0);
  });
});

/**
 * B1134 (same class): three more staff-only controls on this page. Generate Invoice / Split into invoice
 * (the Invoice card), the Fulfillment selector (Summary), and Add tracking / Edit shipment (the Shipment
 * card). A customer sees none of them; staff see all of them as before. The invoice list itself and the
 * tracking details stay visible to a customer: only the controls go.
 */
describe("B1134: invoice, fulfillment and shipment controls", () => {
  const LINE = {
    id: "li-1",
    productId: "p-1",
    product: { id: "p-1", name: "Sample Widget", unit: "each", unitsPerBox: null },
    qty: 4,
    invoicedQty: 0,
    unitPrice: 5,
    subtotal: 20,
    status: "PENDING",
  };
  // A carrier order with a line left to bill and no invoice yet: every one of the three controls applies.
  const carrierOrder = { fulfillPath: "SHIP", lineItems: [LINE] };

  const generate = () =>
    screen.queryByRole("button", { name: /^Generate Invoice \(full order\)$/ });
  const split = () => screen.queryByRole("button", { name: /^Split into invoice…$/ });
  const fulfillmentRow = () => screen.queryByText(/^Fulfillment$/);
  const fulfillmentSelect = () => screen.queryByRole("combobox");
  const addTracking = () => screen.queryByRole("button", { name: /^Add tracking$/ });
  const editShipment = () => screen.queryByRole("button", { name: /^Edit shipment$/ });

  describe.each<[string, Role]>([
    ["a CUSTOMER", "CUSTOMER"],
    ["a DRIVER", "DRIVER"],
    ["no session yet", null],
  ])("%s", (_label, role) => {
    it("sees none of the three controls on a carrier order", async () => {
      await open(role, "CONFIRMED", carrierOrder);
      expect(generate()).toBeNull();
      expect(split()).toBeNull();
      expect(fulfillmentRow()).toBeNull();
      expect(fulfillmentSelect()).toBeNull();
      expect(addTracking()).toBeNull();
    });
  });

  it("a CUSTOMER still sees the carrier tracking details, but cannot edit them", async () => {
    await open("CUSTOMER", "OUT_FOR_DELIVERY", {
      ...carrierOrder,
      cancelBlockedReason: "WITH_CARRIER",
      shippingCarrier: "UPS",
      shippingTrackingNumber: "1Z999AA10123456784",
    });
    expect(screen.getByText("1Z999AA10123456784")).toBeInTheDocument();
    expect(editShipment()).toBeNull();
    expect(addTracking()).toBeNull();
  });

  it("a CUSTOMER still sees an existing invoice and its links, without the billing buttons", async () => {
    await open("CUSTOMER", "CONFIRMED", {
      fulfillPath: "ROUTE",
      lineItems: [LINE],
      invoices: [{ id: "inv-1", invoiceNumber: "INV-1", status: "SENT", total: 20, amountPaid: 0 }],
    });
    expect(screen.getByRole("link", { name: /Open/ })).toHaveAttribute("href", "/invoices/inv-1");
    expect(generate()).toBeNull();
    expect(split()).toBeNull();
  });

  it("a CUSTOMER with no invoice yet is told so, and offered nothing to generate", async () => {
    await open("CUSTOMER", "CONFIRMED", { fulfillPath: "ROUTE", lineItems: [LINE] });
    expect(screen.getByText("No invoice has been generated for this order.")).toBeInTheDocument();
    expect(generate()).toBeNull();
  });

  describe.each<[string, Role]>([
    ["OPERATOR", "OPERATOR"],
    ["TENANT_ADMIN", "TENANT_ADMIN"],
    ["SUPER_ADMIN", "SUPER_ADMIN"],
  ])("%s (regression pin: as before)", (_name, role) => {
    it("sees all three controls on a carrier order", async () => {
      await open(role, "CONFIRMED", carrierOrder);
      expect(generate()).not.toBeNull();
      expect(split()).not.toBeNull();
      expect(fulfillmentRow()).not.toBeNull();
      expect(fulfillmentSelect()).toHaveValue("SHIP");
      expect(addTracking()).not.toBeNull();
    });

    it("sees Edit shipment once tracking is recorded", async () => {
      await open(role, "CONFIRMED", {
        ...carrierOrder,
        shippingCarrier: "UPS",
        shippingTrackingNumber: "1Z999AA10123456784",
      });
      expect(editShipment()).not.toBeNull();
    });
  });
});
