import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import OrdersPage from "./page";

/**
 * UX E: the "Shipped" chip on the orders list uses the design system's one neutral chip tone (Badge neutral), not a
 * per-screen colour (it was sky blue), in both the mobile card and the table row.
 */
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(),
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
let rows: ReturnType<typeof order>[] = [];
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

describe("OrdersPage: the Shipped chip", () => {
  it("is the shared neutral Badge tone (no per-screen colour), still titled (no icon, per the design spec)", () => {
    rows = [order({ fulfillPath: "SHIP" })];
    renderWithProviders(<OrdersPage />);
    const chips = screen.getAllByTitle("Shipped by supplier/carrier");
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect(chip).toHaveTextContent(/shipped/i);
      expect(chip.className).toMatch(/\bbg-sunken\b/);
      expect(chip.className).not.toMatch(/sky-/);
    }
  });

  it("a delivery-route order shows no Shipped chip", () => {
    rows = [order({ fulfillPath: "ROUTE" })];
    renderWithProviders(<OrdersPage />);
    expect(screen.queryByTitle("Shipped by supplier/carrier")).toBeNull();
  });
});
