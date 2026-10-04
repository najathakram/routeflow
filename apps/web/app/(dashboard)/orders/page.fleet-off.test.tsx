import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import OrdersPage from "./page";

// SHIP fulfilment mode: "Out for Delivery" reads "Shipped" on the orders list (saved-view chip, status
// filter, row chip). Every other account, including one with no fleet modules, sees today's labels.
// Display only: the filter VALUE stays OUT_FOR_DELIVERY.
let ship = false;
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useDeliveryAccess: () => ({ enabled: false, resolved: true }),
}));
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    data: ship
      ? {
          capabilities: {
            fulfilment: {
              methods: ["SHIP"],
              staffDefault: "SHIP",
              portalMethods: [],
              portalDefault: null,
              counter: "off",
              fleet: false,
            },
          },
        }
      : undefined,
  }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useOrders: () => ({
    data: {
      data: [
        {
          id: "o1",
          orderNumber: "ORD-1",
          status: "OUT_FOR_DELIVERY",
          urgent: false,
          total: 10,
          createdAt: "2026-10-01T00:00:00.000Z",
          requestedDeliveryDate: null,
          customer: { businessName: "Acme" },
          lineItems: [],
        },
      ],
      meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
    },
    isLoading: false,
    isError: false,
  }),
  useUpdateOrderStatus: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useBulkDeleteOrders: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));

describe("Orders list — SHIP mode wording", () => {
  it("ship mode: the chip, the filter option and the row all say Shipped", () => {
    ship = true;
    renderWithProviders(<OrdersPage />);

    expect(screen.queryAllByText("Out for Delivery")).toHaveLength(0);
    // saved-view chip + row badge (table and card list) + the filter option
    expect(screen.getAllByText("Shipped").length).toBeGreaterThanOrEqual(3);
    const option = screen.getByRole("option", { name: "Shipped" }) as HTMLOptionElement;
    expect(option.value).toBe("OUT_FOR_DELIVERY");
  });

  it("not ship mode (today's UI, unchanged): Out for Delivery everywhere", () => {
    ship = false;
    renderWithProviders(<OrdersPage />);

    expect(screen.queryAllByText("Shipped")).toHaveLength(0);
    expect(screen.getAllByText("Out for Delivery").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole("option", { name: "Out for Delivery" })).toBeInTheDocument();
  });
});
