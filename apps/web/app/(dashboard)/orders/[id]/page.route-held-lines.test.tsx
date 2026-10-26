import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * Row 590 (SA-978 §1): an office DELIVERED whose response carries `routeHeldLines` says, once, which lines stay at the
 * driver's figure and the one fix (lower the quantity). A response without the field toasts nothing extra.
 */
const toast = jest.fn();
const get = jest.fn();
const patch = jest.fn();
const post = jest.fn();
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
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    post: (...a: unknown[]) => post(...a),
  },
}));

const order = {
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "cust-9",
  customer: { id: "cust-9", businessName: "Acme Retail" },
  status: "OUT_FOR_DELIVERY",
  fulfillPath: "ROUTE",
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  lineItems: [
    {
      id: "L1",
      productId: "p1",
      qty: 10,
      deliveredQty: 6,
      unitPrice: 1,
      subtotal: 10,
      status: "ACTIVE",
      product: { id: "p1", name: "Widget", unit: "ea" },
    },
  ],
};

const deliver = async (response: Record<string, unknown>) => {
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/o1" ? order : [] }),
  );
  patch.mockResolvedValueOnce({ data: { ...order, status: "DELIVERED", ...response } });
  post.mockResolvedValue({ data: [] });
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Mark as Delivered/ }));
};
const held = () =>
  toast.mock.calls.map((c) => c[0]).filter((t) => /stays at/.test(t?.description ?? ""));

beforeEach(() => {
  jest.clearAllMocks();
  seedSession("OPERATOR");
});

describe("order detail: lines the driver's figure holds after an office DELIVERED (row 590)", () => {
  it("names the short route line and the one fix", async () => {
    await deliver({ routeHeldLines: [{ lineId: "L1", delivered: 6, qty: 10 }] });
    await waitFor(() => expect(held()).toHaveLength(1));
    expect(held()[0].description).toBe(
      "Widget stays at 6 of 10, as the driver recorded. To put the other 4 back in stock, lower its quantity.",
    );
  });

  it("a response with no routeHeldLines adds no such toast", async () => {
    await deliver({});
    await waitFor(() => expect(post).toHaveBeenCalled()); // handleDeliver ran to its invoice step
    expect(held()).toHaveLength(0);
  });
});
