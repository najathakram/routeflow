import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/** F08/F26: Edit Items opened from the keyboard focuses the first quantity; a mouse open keeps the scan bar (B62), never scrolling. */
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

async function openEdit(detail: number) {
  get.mockImplementation((url: string) => {
    if (url === "/orders/o1") return Promise.resolve({ data: baseOrder });
    if (url === "/tenants/me/addons") return Promise.resolve({ data: { addons: [] } });
    return Promise.resolve({ data: [] });
  });
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /edit items/i }), { detail });
  await screen.findByRole("button", { name: /^save changes$/i });
}

const scanBox = () => screen.getByPlaceholderText(/scan barcode/i);
const qty = () => screen.getByRole("spinbutton", { name: /qty/i });

beforeEach(() => {
  jest.restoreAllMocks();
  seedSession("OPERATOR");
});

describe("Edit Items initial focus (F08 / F26)", () => {
  it("opened from the keyboard (click detail 0): the first quantity has focus", async () => {
    await openEdit(0);
    await waitFor(() => expect(qty()).toHaveFocus(), { timeout: 3000 });
  });

  it("opened with the mouse: the scan bar keeps focus, and nothing scrolls", async () => {
    const focus = jest.spyOn(HTMLElement.prototype, "focus");
    await openEdit(1);
    await waitFor(() => expect(scanBox()).toHaveFocus(), { timeout: 3000 });
    expect(qty()).not.toHaveFocus();
    const scanCall = focus.mock.instances.findIndex((el) => el === scanBox());
    expect(focus.mock.calls[scanCall][0]).toEqual({ preventScroll: true });
  });
});
