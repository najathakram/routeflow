import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * P-4: `409 ORDER_EDIT_WOULD_OVERPAY`. Saving an edit shows the page's own notice and NO global toast;
 * the same 409 arriving outside edit mode (no notice on screen) must still reach the user as the single
 * global toast. The real global MutationCache handler (app/providers.tsx) is in play.
 */
const toast = jest.fn();
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
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    post: jest.fn(),
    delete: jest.fn(),
  },
}));

const order = {
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "c1",
  customer: { id: "c1", businessName: "Acme Retail" },
  status: "PENDING",
  fulfillPath: "ROUTE",
  urgent: false,
  subtotal: 20,
  tax: 0,
  total: 20,
  lineItems: [
    {
      id: "li-1",
      productId: "p1",
      product: { id: "p1", name: "Widget", unit: "each", unitsPerBox: null },
      qty: 10,
      unitPrice: 2,
      status: "CONFIRMED",
    },
  ],
};
const overpay409 = {
  code: "ORDER_EDIT_WOULD_OVERPAY",
  message: "RAW SERVER TEXT",
  invoiceId: "inv-1",
  paid: 20,
  projectedTotal: 10,
  excess: 10,
};
const rejectOverpay = () =>
  patch.mockRejectedValueOnce(
    Object.assign(new Error("Request failed"), { response: { status: 409, data: overpay409 } }),
  );

beforeEach(() => {
  jest.clearAllMocks();
  seedSession("OPERATOR");
  get.mockImplementation((url: string) => {
    if (url === "/orders/o1") return Promise.resolve({ data: order });
    if (url === "/tenants/me/addons")
      return Promise.resolve({ data: { addons: ["orders_inline_returns"] } });
    return Promise.resolve({ data: [] });
  });
});

const open = () =>
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );

describe("order detail — ORDER_EDIT_WOULD_OVERPAY", () => {
  it("on an edit save: the notice is shown and there is no global toast", async () => {
    rejectOverpay();
    open();
    fireEvent.click(await screen.findByRole("button", { name: /edit items/i }));
    await screen.findByRole("button", { name: /^save changes$/i });
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "5" } });
    fireEvent.click(await screen.findByRole("button", { name: /^save changes$/i }));
    const notice = await screen.findByTestId("order-overpay-notice");
    expect(notice).toHaveTextContent("$10.00");
    expect(notice).not.toHaveTextContent("RAW SERVER TEXT");
    expect(toast).not.toHaveBeenCalled();
  });

  it("outside edit mode: no notice, the single global toast fires with fixed copy", async () => {
    rejectOverpay();
    open();
    fireEvent.click(await screen.findByRole("button", { name: /confirm order/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0][0].title).toMatch(/overpaid/i);
    expect(JSON.stringify(toast.mock.calls[0][0])).not.toContain("RAW SERVER TEXT");
    expect(screen.queryByTestId("order-overpay-notice")).toBeNull();
  });
});
