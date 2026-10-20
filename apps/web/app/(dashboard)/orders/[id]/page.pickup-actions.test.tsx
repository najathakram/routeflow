import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
// Add-on gated and unrelated to the role gate: a stub so the "Record return" button is always there to hide.
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
    Promise.resolve({
      data:
        url === "/orders/o1"
          ? order(status, extra)
          : // BO-07: an operator's till entries follow their permissions; this one holds every group.
            url === "/users/me/permissions"
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
};

const has = (re: RegExp) => !!screen.queryByRole("button", { name: re });

beforeEach(() => jest.clearAllMocks());
afterEach(() => seedSession(null));

describe("PICKUP order actions", () => {
  it("CONFIRMED (POS mode, SA-763r): Ready for pickup is secondary, no Out for Delivery; 'Hand over' is offered", async () => {
    await open("OPERATOR", "CONFIRMED", { fulfillPath: "PICKUP" });
    expect(has(/^Ready for pickup$/)).toBe(true);
    expect(has(/^Out for Delivery$/)).toBe(false);
    expect(has(/^Mark shipped$/)).toBe(false);
    expect(has(/^Hand over$/)).toBe(true);
  });

  it("a counter sale (counterSale true) keeps the pre-POS CONFIRMED actions", async () => {
    await open("OPERATOR", "CONFIRMED", { fulfillPath: "PICKUP", counterSale: true });
    expect(has(/^Ready for pickup$/)).toBe(true);
    expect(has(/^Picked up$/)).toBe(true);
    expect(has(/^Hand over$/)).toBe(false);
  });

  it("OUT_FOR_DELIVERY (Ready for pickup): 'Picked up' is the completion; Mark as Delivered is hidden", async () => {
    await open("OPERATOR", "OUT_FOR_DELIVERY", { fulfillPath: "PICKUP" });
    expect(has(/^Hand over$/)).toBe(true);
    expect(has(/^Mark as Delivered$/)).toBe(false);
    expect(has(/^Mark delivered$/)).toBe(false);
  });

  it.each(["PENDING", "DELIVERED", "CANCELLED"])("%s: no 'Picked up'", async (status) => {
    await open("OPERATOR", status, { fulfillPath: "PICKUP" });
    expect(has(/^Picked up$/)).toBe(false);
  });

  it("the Fulfillment select shows 'Pick up at store' for a PICKUP order (never blank)", async () => {
    await open("OPERATOR", "CONFIRMED", { fulfillPath: "PICKUP" });
    const select = screen
      .getAllByRole("combobox")
      .find((el) => (el as HTMLSelectElement).value === "PICKUP") as HTMLSelectElement | undefined;
    expect(select).toBeDefined();
    expect(select!.selectedOptions[0]?.textContent).toBe("Pick up at store");
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

describe("Picked up result survives the order refetch (the order flips to DELIVERED underneath it)", () => {
  const ordersGets = () => get.mock.calls.filter((c) => c[0] === "/orders/o1").length;
  /** After the pickup POST the next GET of the order answers DELIVERED, as the server would. */
  const pickUp = async (
    response: Record<string, unknown>,
    tender: (d: HTMLElement) => Promise<void>,
  ) => {
    await open("OPERATOR", "CONFIRMED", {
      fulfillPath: "PICKUP",
      customer: { id: "c", isWalkIn: true, businessName: "Walk-in" },
    });
    post.mockImplementation(() => {
      get.mockImplementation((url: string) =>
        Promise.resolve({
          data: url === "/orders/o1" ? order("DELIVERED", { fulfillPath: "PICKUP" }) : [],
        }),
      );
      return Promise.resolve({
        data: {
          orderId: "o1",
          orderNumber: "ORD-1",
          total: 10,
          paid: 0,
          balanceDue: 10,
          ...response,
        },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: /^Hand over$/ }));
    const dialog = await screen.findByRole("dialog");
    await tender(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: /^Hand over$/ }));
  };

  it("payment not recorded: the alert and Retry are still on screen after the order refetches as DELIVERED", async () => {
    await pickUp({ paymentRecorded: false }, async (d) => {
      fireEvent.click(await within(d).findByRole("button", { name: "Card" }));
    });
    await screen.findByText("Payment not recorded");
    await waitFor(() => expect(ordersGets()).toBeGreaterThan(1)); // the invalidation refetched the order
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByText("Payment not recorded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("cash with change: the change is still shown after the refetch, and Done closes it", async () => {
    await pickUp({ paymentRecorded: true, paid: 10, balanceDue: 0, change: 10 }, async (d) => {
      fireEvent.click(await within(d).findByRole("button", { name: "$20" }));
    });
    await screen.findByTestId("pickup-change");
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId("pickup-change")).toHaveTextContent("Change $10.00");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByTestId("pickup-change")).toBeNull());
  });
});

describe("leaving in-store pickup asks first", () => {
  const selectWith = (value: string) =>
    screen
      .getAllByRole("combobox")
      .find((el) => (el as HTMLSelectElement).value === value) as HTMLSelectElement;

  it("choosing Ship on a PICKUP order opens a confirm; Cancel leaves it unchanged (no PATCH)", async () => {
    patch.mockResolvedValue({ data: {} });
    await open("OPERATOR", "CONFIRMED", { fulfillPath: "PICKUP" });
    fireEvent.change(selectWith("PICKUP"), { target: { value: "SHIP" } });
    expect(await screen.findByText(/Move this order off in-store pickup\?/)).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(patch).not.toHaveBeenCalled();
    expect(selectWith("PICKUP")).toBeDefined();
  });

  it("confirming PATCHes the chosen path", async () => {
    patch.mockResolvedValue({ data: {} });
    await open("OPERATOR", "CONFIRMED", { fulfillPath: "PICKUP" });
    fireEvent.change(selectWith("PICKUP"), { target: { value: "ROUTE" } });
    await screen.findByText(/Move this order off in-store pickup\?/);
    fireEvent.click(screen.getByRole("button", { name: "Move order" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][0]).toBe("/orders/o1/fulfill-path");
    expect(patch.mock.calls[0][1]).toEqual({ fulfillPath: "ROUTE" });
  });

  it("a ROUTE order switching to SHIP is not asked", async () => {
    patch.mockResolvedValue({ data: {} });
    await open("OPERATOR", "CONFIRMED", { fulfillPath: "ROUTE" });
    fireEvent.change(selectWith("ROUTE"), { target: { value: "SHIP" } });
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Move this order off in-store pickup/)).toBeNull();
  });
});
