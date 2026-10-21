import * as React from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/** F22: trashing a line toasts Removed with Undo, which restores it in place. */
const get = jest.fn();
const mockToast = jest.fn();
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
  useToast: () => ({ toast: mockToast }),
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

async function openEdit() {
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
  fireEvent.click(await screen.findByRole("button", { name: /edit items/i }));
  await screen.findByRole("button", { name: /^save changes$/i });
}

beforeEach(() => {
  jest.clearAllMocks();
  seedSession("OPERATOR");
});

describe("Removing a line offers Undo (F22)", () => {
  it("the line goes, a 'Removed' toast carries Undo, and Undo puts the line back unchanged", async () => {
    await openEdit();
    fireEvent.click(screen.getByTitle("Delete item"));
    expect(screen.queryByRole("spinbutton", { name: /qty/i })).toBeNull();
    const removed = mockToast.mock.calls.map((c) => c[0]).find((t) => /removed/i.test(t.title));
    expect(removed?.action?.label).toBe("Undo");
    act(() => removed.action.onClick());
    expect(screen.getByRole("spinbutton", { name: /qty/i })).toHaveValue(10);
  });
  it("an Undo from before a Save is dropped: it never re-adds the saved-away line in a later edit (row 604 S4)", async () => {
    const twoLines = {
      ...baseOrder,
      lineItems: [
        ...baseOrder.lineItems,
        {
          id: "li-2",
          productId: "p2",
          product: { id: "p2", name: "Gadget", unit: "each", unitsPerBox: null },
          qty: 4,
          unitPrice: 3,
          status: "CONFIRMED",
        },
      ],
    };
    let saved = false;
    get.mockImplementation((url: string) => {
      if (url === "/orders/o1")
        return Promise.resolve({
          data: saved ? { ...twoLines, lineItems: [twoLines.lineItems[1]] } : twoLines,
        });
      if (url === "/tenants/me/addons") return Promise.resolve({ data: { addons: [] } });
      return Promise.resolve({ data: [] });
    });
    patch.mockImplementation(() => {
      saved = true;
      return Promise.resolve({ data: {} });
    });
    render(
      <Providers>
        <OrderDetailPage />
      </Providers>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /edit items/i }));
    await screen.findByRole("button", { name: /^save changes$/i });
    fireEvent.click(screen.getAllByTitle("Delete item")[0]);
    const removed = mockToast.mock.calls.map((c) => c[0]).find((t) => /removed/i.test(t.title));
    fireEvent.click(screen.getByRole("button", { name: /^save changes$/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: /edit items/i }));
    await screen.findByRole("button", { name: /^save changes$/i });
    expect(screen.getAllByRole("spinbutton", { name: /qty/i })).toHaveLength(1);
    act(() => removed.action.onClick());
    expect(screen.getAllByRole("spinbutton", { name: /qty/i })).toHaveLength(1);
  });
});
