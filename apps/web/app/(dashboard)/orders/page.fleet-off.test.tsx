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
let query = "";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(query),
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

// A carrier-only account has no delivery runs: the requested-delivery-date filter, its sort option and its
// column are noise (Mac-mini pixel pass on #3198). Every other account keeps them; a date filter already in
// the URL keeps them too, so it can still be cleared.
describe("Orders list — delivery-date UI is fleet-only", () => {
  beforeEach(() => {
    query = "";
  });

  it("ship-only: no Delivery filter, no Delivery Date column, no Delivery Date sort option", () => {
    ship = true;
    renderWithProviders(<OrdersPage />);

    expect(screen.queryByText("Delivery:")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Delivery date from")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /Delivery Date/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Delivery Date" })).not.toBeInTheDocument();
    // the rest of the sort options and the Created column are untouched
    expect(screen.getByRole("option", { name: "Created" })).toBeInTheDocument();
  });

  it("not ship-only (today's UI, unchanged): the filter, the column and the sort option are there", () => {
    ship = false;
    renderWithProviders(<OrdersPage />);

    expect(screen.getAllByText("Delivery:").length).toBeGreaterThanOrEqual(1); // filter label + card line
    expect(screen.getByRole("columnheader", { name: /Delivery Date/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Delivery Date" })).toBeInTheDocument();
  });

  it("ship-only with a delivery date filter already in the URL: the filter stays so it can be cleared", () => {
    ship = true;
    query = "dateFrom=2026-10-01";
    renderWithProviders(<OrdersPage />);

    expect(screen.getAllByText("Delivery:").length).toBeGreaterThanOrEqual(1); // filter label + card line
    expect(screen.getByTitle("Clear dates")).toBeInTheDocument();
  });
});
