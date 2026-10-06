import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import BuyerDashboardPage from "./page";

/** Buyer dashboard recent-orders row: "1 item" / "N items" (never "1 items"). */

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({
    buyer: { id: "buyer-1" },
    isLoading: false,
    activeSeller: {
      tenant: { slug: "acme", name: "Acme Wholesale" },
      customer: { businessName: "Sample Buyer Co" },
    },
  }),
}));
jest.mock("@/lib/buyer-cart", () => ({ useBuyerCart: () => ({ itemCount: 0 }) }));
jest.mock("@/components/PwaInstallPrompt", () => ({ PwaInstallPrompt: () => null }));

const order = (id: string, itemCount: number) => ({
  id,
  orderNumber: `ORD-${id}`,
  status: "PENDING",
  total: 10,
  createdAt: "2026-09-10T12:00:00.000Z",
  requestedDeliveryDate: null,
  itemCount,
});

jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerDashboard: () => ({
    isLoading: false,
    isError: false,
    data: {
      recentOrders: [order("1", 1), order("2", 3)],
      stats: {
        activeOrders: 0,
        pendingDeliveries: 0,
        templateCount: 0,
        spend30d: 0,
        spend90d: 0,
        spendAllTime: 0,
      },
      frequentlyOrdered: [],
      newFromSeller: [],
      featuredItems: [],
    },
  }),
  useBuyerTemplates: () => ({ data: { data: [] }, isLoading: false }),
  useBuyerShelf: () => ({ data: { estimates: [] } }),
  useBuyerReorder: () => ({ mutateAsync: jest.fn() }),
}));

describe("BuyerDashboardPage recent orders item count", () => {
  it("says '1 item' for one line and 'N items' otherwise", () => {
    renderWithProviders(<BuyerDashboardPage />);
    expect(screen.getByText(/· 1 item$/)).toBeInTheDocument();
    expect(screen.getByText(/· 3 items$/)).toBeInTheDocument();
    expect(screen.queryByText(/1 items/)).toBeNull();
  });
});
