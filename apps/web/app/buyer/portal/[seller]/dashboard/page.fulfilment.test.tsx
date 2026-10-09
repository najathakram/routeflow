import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import BuyerDashboardPage from "./page";

/**
 * Business profiles 1B (lead review M2) — the dashboard's Recent Orders badge is the SAME
 * per-order label the order detail page shows (`buyerOrderStatusLabel`): a SHIP order reads
 * "Shipped" for a shipping-only seller and for a fleet seller, a fleet seller's ROUTE order keeps
 * "Out For Delivery", and an unset seller sees today's labels. Fixtures are placeholders.
 */

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({
    isLoading: false,
    buyer: { id: "buyer-1" },
    activeSeller: {
      tenant: { slug: "acme", name: "Acme Wholesale" },
      customer: { businessName: "Sample Buyer Co" },
    },
  }),
}));

const ORDER = {
  total: 20,
  createdAt: "2026-09-10T12:00:00Z",
  requestedDeliveryDate: null,
  itemCount: 1,
  shippedAt: null,
};
const mockRecent = [
  {
    ...ORDER,
    id: "o1",
    orderNumber: "ORD-00001",
    status: "OUT_FOR_DELIVERY",
    fulfillPath: "ROUTE",
  },
  { ...ORDER, id: "o2", orderNumber: "ORD-00002", status: "OUT_FOR_DELIVERY", fulfillPath: "SHIP" },
  {
    ...ORDER,
    id: "o3",
    orderNumber: "ORD-00003",
    status: "CONFIRMED",
    fulfillPath: "SHIP",
    shippedAt: "2026-10-01T10:00:00Z",
  },
];

jest.mock("@/lib/api/buyer", () => ({
  useBuyerDashboard: () => ({
    data: {
      recentOrders: mockRecent,
      stats: {
        activeOrders: 3,
        pendingDeliveries: 3,
        templateCount: 0,
        spend30d: 60,
        spend90d: 60,
        spendAllTime: 60,
      },
      frequentlyOrdered: [],
      newFromSeller: [],
      featuredItems: [],
      suggestedItems: [],
    },
    isLoading: false,
    isError: false,
  }),
  useBuyerTemplates: () => ({ data: { data: [] }, isLoading: false }),
  useBuyerReorder: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useBuyerShelf: () => ({ data: undefined }),
}));
jest.mock("@/lib/buyer-cart", () => ({ useBuyerCart: () => ({ addItem: jest.fn(), items: [] }) }));
jest.mock("@/components/PwaInstallPrompt", () => ({ PwaInstallPrompt: () => null }));

let mockCaps: { data: unknown; isLoading: boolean; isError: boolean };
jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => mockCaps,
}));
const caps = (portalDefault: string | null, fleet: boolean) => ({
  data: { portalMethods: portalDefault ? [portalDefault] : [], portalDefault, fleet },
  isLoading: false,
  isError: false,
});

const row = (orderNumber: string) =>
  screen.getAllByRole("button").find((b) => b.textContent?.includes(orderNumber))!;

describe("BuyerDashboardPage — Recent Orders badge = the detail page's label", () => {
  it("shipping-only seller: SHIP orders read Shipped, a non-SHIP order On Its Way", () => {
    mockCaps = caps("SHIP", false);
    renderWithProviders(<BuyerDashboardPage />);
    expect(within(row("ORD-00002")).getByText("Shipped")).toBeInTheDocument();
    expect(within(row("ORD-00003")).getByText("Shipped")).toBeInTheDocument();
    expect(within(row("ORD-00001")).getByText("On Its Way")).toBeInTheDocument();
    expect(screen.queryByText("Out For Delivery")).toBeNull();
  });

  it("fleet seller: a SHIP order reads Shipped; a ROUTE order keeps Out For Delivery", () => {
    mockCaps = caps("ROUTE", true);
    renderWithProviders(<BuyerDashboardPage />);
    expect(within(row("ORD-00002")).getByText("Shipped")).toBeInTheDocument();
    expect(within(row("ORD-00003")).getByText("Shipped")).toBeInTheDocument();
    expect(within(row("ORD-00001")).getByText("Out For Delivery")).toBeInTheDocument();
  });

  it.each([
    ["an unset seller", () => caps(null, true)],
    ["an unreadable capability", () => ({ data: undefined, isLoading: false, isError: true })],
  ])("before == after — %s: today's labels, SHIP orders included", (_l, c) => {
    mockCaps = c();
    renderWithProviders(<BuyerDashboardPage />);
    expect(within(row("ORD-00001")).getByText("Out For Delivery")).toBeInTheDocument();
    expect(within(row("ORD-00002")).getByText("Out For Delivery")).toBeInTheDocument();
    expect(within(row("ORD-00003")).getByText("Confirmed")).toBeInTheDocument();
  });
});
