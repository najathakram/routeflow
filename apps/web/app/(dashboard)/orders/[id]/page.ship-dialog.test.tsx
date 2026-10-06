import * as React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Providers } from "@/app/providers";
import OrderDetailPage from "./page";

/**
 * Shipping-flow polish folds on the staff order page ("Mark shipped" on a carrier order):
 *  1. the "Add tracking (optional)" dialog is the ONLY tracking prompt: after "Skip, ship now" or
 *     "Ship with tracking" the old "Shipment tracking" modal must not pop open as well;
 *  2. the dialog pre-fills the carrier + tracking number already saved on the order.
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
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    post: jest.fn(),
  },
}));

let current: Record<string, unknown>;

const baseOrder = {
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "cust-9",
  customer: { id: "cust-9", businessName: "Acme Retail" },
  status: "CONFIRMED",
  fulfillPath: "SHIP",
  shippingCarrier: null as string | null,
  shippingTrackingNumber: null as string | null,
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  lineItems: [],
};

const open = async (
  saved: { shippingCarrier?: string | null; shippingTrackingNumber?: string | null } = {},
) => {
  current = { ...baseOrder, ...saved };
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/o1" ? current : [] }),
  );
  // The server answers each write the way the real one does, so a refetch never rolls the page back.
  patch.mockImplementation((url: string, body: Record<string, unknown>) => {
    if (url === "/orders/o1/status") current = { ...current, status: body.status };
    if (url === "/orders/o1/shipment") current = { ...current, ...body };
    return Promise.resolve({ data: current });
  });
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  await screen.findByText(/ORD-1/);
};

const markShipped = () => fireEvent.click(screen.getByRole("button", { name: "Mark shipped" }));
const dialogTitles = () =>
  screen.queryAllByRole("dialog").map((d) => within(d).queryByRole("heading")?.textContent);
/** The order shipped: the CONFIRMED actions (Mark shipped) are gone, and the page has settled. */
const shipped = async () => {
  await waitFor(() => expect(screen.queryByRole("button", { name: "Mark shipped" })).toBeNull());
  await act(async () => {});
};

beforeEach(() => jest.clearAllMocks());

describe("order detail: Mark shipped on a carrier order (shipping-flow polish)", () => {
  it("Skip, ship now: ships the order and opens NO second (Shipment tracking) modal", async () => {
    await open();
    markShipped();
    expect(dialogTitles()).toEqual(["Add tracking (optional)"]);
    fireEvent.click(screen.getByRole("button", { name: "Skip, ship now" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        "/orders/o1/status",
        expect.objectContaining({ status: "OUT_FOR_DELIVERY" }),
      ),
    );
    await shipped();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Shipment tracking")).toBeNull();
    expect(patch).not.toHaveBeenCalledWith("/orders/o1/shipment", expect.anything());
  });

  it("Ship with tracking: saves the shipment, ships, and opens NO second modal", async () => {
    await open();
    markShipped();
    fireEvent.change(screen.getByLabelText("Tracking number"), { target: { value: "1Z999" } });
    fireEvent.click(screen.getByRole("button", { name: "Ship with tracking" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        "/orders/o1/status",
        expect.objectContaining({ status: "OUT_FOR_DELIVERY" }),
      ),
    );
    expect(patch).toHaveBeenCalledWith("/orders/o1/shipment", {
      shippingCarrier: "ups",
      shippingTrackingNumber: "1Z999",
    });
    await shipped();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Shipment tracking")).toBeNull();
  });

  it("pre-fills the carrier and tracking number already saved on the order", async () => {
    await open({ shippingCarrier: "fedex", shippingTrackingNumber: "794644790138" });
    markShipped();
    expect((screen.getByLabelText("Carrier") as HTMLSelectElement).value).toBe("fedex");
    expect((screen.getByLabelText("Tracking number") as HTMLInputElement).value).toBe(
      "794644790138",
    );
    // Pre-filled tracking makes "Ship with tracking" available straight away.
    expect(
      (screen.getByRole("button", { name: "Ship with tracking" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("an order with nothing saved still opens empty, carrier UPS", async () => {
    await open();
    markShipped();
    expect((screen.getByLabelText("Carrier") as HTMLSelectElement).value).toBe("ups");
    expect((screen.getByLabelText("Tracking number") as HTMLInputElement).value).toBe("");
  });
});
