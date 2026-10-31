import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/**
 * I-120 PR-2 (SA-861 rules 1-3, G7; the lead's rulings 2026-10-23): "Complete at counter" on an open order. It is a
 * SECONDARY action next to the order's primary status action. It never shows beside the pickup hand-over (the same
 * engine: one control per action), and it is never offered once shipped with the carrier (SA-913 R9). An order on a
 * driver's run is offered: the api asks to confirm taking it off the run (R8). The dialog is the till's own payment step in complete mode, and confirm POSTs pickup-complete.
 */
let caps: Record<string, unknown> | null = {
  counter: "optional",
  methods: ["ROUTE", "SHIP", "PICKUP"],
};
const order = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "cust-9",
  customer: { id: "cust-9", businessName: "Acme Retail" },
  status,
  fulfillPath: "ROUTE",
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

const open = async (status: string, extra: Record<string, unknown> = {}, role = "OPERATOR") => {
  seedSession(role as never);
  get.mockImplementation((url: string) =>
    Promise.resolve({
      data:
        url === "/orders/o1"
          ? order(status, extra)
          : url === "/tenants/me/features"
            ? { capabilities: caps ? { fulfilment: caps } : undefined }
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
  // a NEGATIVE only counts once the gate has its answers (features + permissions), never before they land
  await waitFor(() => expect(get).toHaveBeenCalledWith("/tenants/me/features"));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
};

const COMPLETE = /^complete at counter$/i;
const completeButton = () => screen.queryByRole("button", { name: COMPLETE });
const handOverButton = () => screen.queryByRole("button", { name: /^(picked up|hand over)$/i });

beforeEach(() => {
  jest.clearAllMocks();
  caps = { counter: "optional", methods: ["ROUTE", "SHIP", "PICKUP"] };
});
afterEach(() => seedSession(null));

describe("order page: Complete at counter (I-120 PR-2)", () => {
  it("PENDING delivery order: offered, secondary, after the primary Confirm Order", async () => {
    await open("PENDING");
    const button = await screen.findByRole("button", { name: COMPLETE });
    const confirm = screen.getByRole("button", { name: /^confirm order$/i });
    // the primary stays first in the action bar
    expect(confirm.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("CONFIRMED delivery and ship orders: offered", async () => {
    await open("CONFIRMED");
    expect(await screen.findByRole("button", { name: COMPLETE })).toBeInTheDocument();
  });

  it.each([
    ["CONFIRMED", "PICKUP"],
    ["OUT_FOR_DELIVERY", "PICKUP"],
  ])(
    "%s %s: the pickup hand-over shows and Complete at counter does not (one control per action)",
    async (status, fulfillPath) => {
      await open(status, { fulfillPath });
      await waitFor(() => expect(handOverButton()).toBeInTheDocument());
      expect(completeButton()).toBeNull();
    },
  );

  it.each(
    ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"].flatMap((st) =>
      ["ROUTE", "SHIP", "PICKUP"].map((p) => [st, p] as const),
    ),
  )("%s %s: the two never render together", async (status, fulfillPath) => {
    await open(status, { fulfillPath });
    await waitFor(() => expect(screen.getAllByRole("button").length).toBeGreaterThan(0));
    expect(!!completeButton() && !!handOverButton()).toBe(false);
  });

  // SA-913 R9: each hidden case beside its OFFERED twin, the same wait before both, so an absence can never pass because the
  // gate had not answered yet.
  it.each([
    [
      "with the carrier (OUT_FOR_DELIVERY)",
      "OUT_FOR_DELIVERY",
      { fulfillPath: "SHIP" },
      { status: "CONFIRMED", extra: { fulfillPath: "SHIP" } },
    ],
    [
      "shipped (shippedAt)",
      "CONFIRMED",
      { fulfillPath: "SHIP", shippedAt: "2026-10-20T10:00:00.000Z" },
      { status: "CONFIRMED", extra: { fulfillPath: "SHIP", shippedAt: null } },
    ],
  ])("R9: %s is not offered, while its twin is", async (_n, status, extra, twin) => {
    await open(twin.status, twin.extra); // positive control: the gate has answered and offers the twin
    expect(await screen.findByRole("button", { name: COMPLETE })).toBeInTheDocument();
    cleanup();
    await open(status, extra);
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0); // the page rendered its actions
    expect(completeButton()).toBeNull();
  });

  it.each([
    ["OUT_FOR_DELIVERY on a route", "OUT_FOR_DELIVERY", { fulfillPath: "ROUTE" }],
    ["on an active run", "PENDING", { routeRun: { status: "SCHEDULED" } }],
  ])(
    "R8 (SA-913): %s is offered (the api asks to take it off the run)",
    async (_n, status, extra) => {
      await open(status, extra);
      expect(await screen.findByRole("button", { name: COMPLETE })).toBeInTheDocument();
    },
  );

  it("a counter sale, or a business that cannot hand over at the store: not offered", async () => {
    await open("PENDING", { counterSale: true, fulfillPath: "PICKUP" });
    expect(completeButton()).toBeNull();
    document.body.innerHTML = "";
    caps = { counter: "off", methods: ["ROUTE"] };
    await open("PENDING");
    expect(completeButton()).toBeNull();
  });

  it("opens the till's payment step in complete mode; confirm POSTs pickup-complete with an Idempotency-Key", async () => {
    post.mockResolvedValue({
      data: {
        orderId: "o1",
        orderNumber: "ORD-1",
        invoiceId: "i1",
        invoiceNumber: "INV-1",
        total: 10,
        paid: 10,
        balanceDue: 0,
        paymentRecorded: true,
        emailed: true,
      },
    });
    await open("PENDING");
    fireEvent.click(await screen.findByRole("button", { name: COMPLETE }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/^complete at counter ORD-1$/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Card" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /^complete$/i }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [url, body, config] = post.mock.calls[0];
    expect(url).toBe("/orders/o1/pickup-complete");
    expect(body.payment).toMatchObject({ method: "CARD" });
    expect(config.headers["Idempotency-Key"]).toBeTruthy();
    expect(
      await within(dialog).findByText(
        "Completed at counter. The invoice was emailed to the customer.",
      ),
    ).toBeInTheDocument();
  });

  it("R8 (SA-913): COUNTER_COMPLETE_ON_RUN names the driver; the confirm re-sends the same request with takeOffRun, same key", async () => {
    post
      .mockRejectedValueOnce({
        response: {
          status: 409,
          data: { code: "COUNTER_COMPLETE_ON_RUN", driverName: "Sam", runId: "run-1" },
        },
      })
      .mockResolvedValueOnce({
        data: {
          orderId: "o1",
          orderNumber: "ORD-1",
          invoiceId: "i1",
          invoiceNumber: "INV-1",
          total: 10,
          paid: 10,
          balanceDue: 0,
          paymentRecorded: true,
          emailed: false,
        },
      });
    await open("CONFIRMED", { routeRun: { status: "SCHEDULED" } });
    fireEvent.click(await screen.findByRole("button", { name: COMPLETE }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Card" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /^complete$/i }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "This order is on Sam's run. Completing it here takes it off the run.",
    );
    expect(within(dialog).queryByRole("button", { name: /^complete$/i })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Take off run and complete" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const [, first, firstConfig] = post.mock.calls[0];
    const [, second, secondConfig] = post.mock.calls[1];
    expect(first.takeOffRun).toBeUndefined();
    expect(second).toEqual({ ...first, takeOffRun: true });
    expect(secondConfig.headers["Idempotency-Key"]).toBe(firstConfig.headers["Idempotency-Key"]);
    expect(await within(dialog).findByText("Completed at counter.")).toBeInTheDocument();
  });
});
