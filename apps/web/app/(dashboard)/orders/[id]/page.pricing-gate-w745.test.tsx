import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * W-745 (SA-868/884): the order editor's pricing gate counted a FAILED customer or customer-price read as "settled" (B62's
 * "tier-1 degraded mode"), so Substitute and the product picker opened and priced at LIST. It now uses the shared
 * customerPricingGate: a failed read keeps them closed with the failed copy and Retry; a PLAN_GATE 403 on the prices read (a
 * plan without tier pricing) is an empty read, so they open. Harness copied from page.edit-focus.test.tsx.
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
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
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

const baseOrder = {
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

let pricesReply: () => Promise<unknown> = () => Promise.resolve({ data: [] });

async function openEdit() {
  get.mockImplementation((url: string) => {
    if (url === "/orders/o1") return Promise.resolve({ data: baseOrder });
    if (url === "/tenants/me/addons") return Promise.resolve({ data: { addons: [] } });
    if (url === "/customers/c1") return Promise.resolve({ data: { id: "c1", pricingTier: 3 } });
    if (String(url).startsWith("/customers/c1/prices")) return pricesReply();
    return Promise.resolve({ data: [] });
  });
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /edit items/i }), { detail: 1 });
  await screen.findByRole("button", { name: /^save changes$/i });
}
const substitute = () => screen.getByRole("button", { name: /^substitute$/i });
const httpError = (status: number, code?: string) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { code } } });

beforeEach(() => {
  jest.restoreAllMocks();
  seedSession("OPERATOR");
  pricesReply = () => Promise.resolve({ data: [] });
});

describe("W-745: the order editor fails closed on a failed customer-price read", () => {
  it("prices read fails (500): Substitute stays disabled and the failed copy shows (master: degraded mode, enabled)", async () => {
    pricesReply = () => Promise.reject(httpError(500));
    await openEdit();
    expect(
      await screen.findByText(/couldn't load this customer's prices/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(substitute()).toBeDisabled();
  });

  it("a PLAN_GATE 403 on the prices read is an empty read: Substitute opens", async () => {
    pricesReply = () => Promise.reject(httpError(403, "PLAN_GATE"));
    await openEdit();
    await waitFor(() => expect(substitute()).not.toBeDisabled(), { timeout: 5000 });
    expect(screen.queryByText(/couldn't load this customer's prices/i)).not.toBeInTheDocument();
  });

  it("everything read: Substitute opens", async () => {
    await openEdit();
    await waitFor(() => expect(substitute()).not.toBeDisabled(), { timeout: 5000 });
  });
});
