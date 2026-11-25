import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import OrdersPage from "./page";
import { showOrderCreatedToast } from "./_components/order-created-toast";

/**
 * UX audit 2026-11-24 F39, review R-172: the order-created message stays until dismissed, and used to follow the
 * person onto every other page. The orders list takes it down when the list is left. This pins the page's own
 * effect: without it nothing here is dismissed.
 */
const dismiss = jest.fn();
const toast = jest.fn(() => "toast-1");
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast, dismiss }),
}));

// ── URL state: a tiny store so router.replace() really changes what useSearchParams() returns ─────────────────────
let currentQuery = "";
const listeners = new Set<() => void>();
const setQuery = (q: string) => {
  currentQuery = q;
  listeners.forEach((l) => l());
};
const replace = jest.fn((url: string) => setQuery(url.split("?")[1] ?? ""));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace }),
  usePathname: () => "/orders",
  useSearchParams: () => {
    const q = React.useSyncExternalStore(
      (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      () => currentQuery,
      () => currentQuery,
    );
    return React.useMemo(() => new URLSearchParams(q), [q]);
  },
}));

const order = (over: Record<string, unknown>) => ({
  id: "o1",
  orderNumber: "ORD-1",
  status: "CONFIRMED",
  fulfillPath: "ROUTE",
  total: 25,
  createdAt: "2026-10-08T12:00:00.000Z",
  deliveryDate: null,
  customer: { id: "c1", businessName: "Acme Co" },
  lineItems: [{ id: "li1" }],
  _count: { changeRequests: 0 },
  ...over,
});
const rows = [order({ id: "o1" }), order({ id: "o2", orderNumber: "ORD-2" })];
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useOrders: () => ({
    data: { data: rows, meta: { total: rows.length, page: 1, limit: 20, totalPages: 1 } },
    isLoading: false,
    isError: false,
  }),
  useUpdateOrderStatus: () => ({ mutate: jest.fn(), isPending: false }),
  useBulkDeleteOrders: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useDeliveryAccess: () => ({ enabled: false, resolved: true }),
}));

beforeEach(() => {
  currentQuery = "";
  jest.clearAllMocks();
});

describe("OrdersPage: leaving the list takes the order-created message down (F39)", () => {
  it("unmounting the list dismisses the message that is up", async () => {
    const view = renderWithProviders(<OrdersPage />);
    await screen.findByRole("searchbox");
    showOrderCreatedToast({ toast, dismiss }, { created: { id: "o9", orderNumber: "ORD-9" } });
    expect(dismiss).not.toHaveBeenCalledWith("toast-1");
    view.unmount();
    expect(dismiss).toHaveBeenCalledWith("toast-1");
  });

  it("while the list stays on screen the message is left alone (F28)", async () => {
    const view = renderWithProviders(<OrdersPage />);
    await screen.findByRole("searchbox");
    showOrderCreatedToast({ toast, dismiss }, { created: { id: "o10", orderNumber: "ORD-10" } });
    view.rerender(<OrdersPage />);
    expect(dismiss).not.toHaveBeenCalledWith("toast-1");
    view.unmount();
  });

  it("leaving with no message up dismisses nothing", async () => {
    const view = renderWithProviders(<OrdersPage />);
    await screen.findByRole("searchbox");
    view.unmount();
    expect(dismiss).not.toHaveBeenCalled();
  });
});
