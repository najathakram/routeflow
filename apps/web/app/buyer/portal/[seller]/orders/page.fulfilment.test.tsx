import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import BuyerOrdersPage from "./page";

/**
 * Business profiles 1B — the buyer orders list. A configured seller without a fleet has no
 * delivery run, so the list offers no "Out for Delivery" filter and never labels an order with
 * it. An unset seller (or an unreadable capability) keeps today's tabs and labels exactly.
 */

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push: jest.fn() }),
}));

const ROUTE_OUT = {
  id: "11111111-aaaa",
  orderNumber: "ORD-00001",
  createdAt: "2026-09-10T12:00:00Z",
  itemCount: 3,
  status: "OUT_FOR_DELIVERY",
  fulfillPath: "ROUTE",
  shippedAt: null,
  totalAmount: 645,
};
let mockOrders: unknown[] = [ROUTE_OUT];
jest.mock("@/lib/api/buyer", () => ({
  useBuyerOrders: () => ({
    data: {
      data: mockOrders,
      meta: { page: 1, limit: 20, total: mockOrders.length, totalPages: 1 },
    },
    isLoading: false,
    isError: false,
    error: null,
  }),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({
    isLoading: false,
    activeSeller: {
      tenant: { slug: "acme", name: "Acme Wholesale" },
      customer: { businessName: "Sample Buyer Co" },
    },
  }),
}));

let mockCaps: { data: unknown; isLoading: boolean; isError: boolean };
jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => mockCaps,
}));

const fulfilment = (portalDefault: string | null, fleet: boolean) => ({
  data: { portalMethods: portalDefault ? [portalDefault] : [], portalDefault, fleet },
  isLoading: false,
  isError: false,
});

const TODAY_TABS = ["All", "Active", "Confirmed", "Out for Delivery", "Delivered", "Cancelled"];
const tabs = () =>
  screen
    .getAllByRole("button")
    .map((b) => b.textContent)
    .filter((t) => t && TODAY_TABS.concat("Shipped").includes(t));

describe("BuyerOrdersPage — fulfilment wording (business profiles 1B)", () => {
  beforeEach(() => {
    mockOrders = [ROUTE_OUT];
  });

  it("shipping-only seller (no fleet): no Out for Delivery tab or label", () => {
    mockCaps = fulfilment("SHIP", false);
    const { container } = renderWithProviders(<BuyerOrdersPage />);
    expect(tabs()).toEqual(["All", "Active", "Confirmed", "Delivered", "Cancelled"]);
    expect(container.textContent).not.toMatch(/out for delivery/i);
    const card = within(screen.getByTestId("buyer-orders-cards")).getByRole("link");
    expect(within(card).getByText("On Its Way")).toBeInTheDocument();
  });

  it("a seller with a fleet keeps the tab", () => {
    mockCaps = fulfilment("ROUTE", true);
    renderWithProviders(<BuyerOrdersPage />);
    expect(tabs()).toEqual(TODAY_TABS);
  });

  it.each([
    ["an unset seller without a fleet", () => fulfilment(null, false)],
    ["a capability read that failed", () => ({ data: undefined, isLoading: false, isError: true })],
    ["a capability still loading", () => ({ data: undefined, isLoading: true, isError: false })],
  ])("before == after — %s: today's tabs and labels", (_l, caps) => {
    mockCaps = caps();
    renderWithProviders(<BuyerOrdersPage />);
    expect(tabs()).toEqual(TODAY_TABS);
    const card = within(screen.getByTestId("buyer-orders-cards")).getByRole("link");
    expect(within(card).getByText("Out For Delivery")).toBeInTheDocument();
  });
});

describe("BuyerOrdersPage — each order's badge is the detail page's label (lead review M2)", () => {
  const SHIP_OUT = {
    ...ROUTE_OUT,
    id: "22222222-bbbb",
    orderNumber: "ORD-00002",
    fulfillPath: "SHIP",
  };
  const SHIP_CONFIRMED_SHIPPED = {
    ...ROUTE_OUT,
    id: "33333333-cccc",
    orderNumber: "ORD-00003",
    status: "CONFIRMED",
    fulfillPath: "SHIP",
    shippedAt: "2026-10-01T10:00:00Z",
  };
  const badgeOf = (orderNumber: string) => {
    const cards = within(screen.getByTestId("buyer-orders-cards")).getAllByRole("link");
    const card = cards.find((c) => c.textContent?.includes(orderNumber))!;
    return card;
  };

  beforeEach(() => {
    mockOrders = [ROUTE_OUT, SHIP_OUT, SHIP_CONFIRMED_SHIPPED];
  });

  it("shipping-only seller: SHIP orders read Shipped (as on the detail page), never On Its Way", () => {
    mockCaps = fulfilment("SHIP", false);
    renderWithProviders(<BuyerOrdersPage />);
    expect(within(badgeOf("ORD-00002")).getByText("Shipped")).toBeInTheDocument();
    expect(within(badgeOf("ORD-00002")).queryByText("On Its Way")).toBeNull();
    expect(within(badgeOf("ORD-00003")).getByText("Shipped")).toBeInTheDocument();
    // a non-SHIP order of a seller without a fleet still never says Out For Delivery
    expect(within(badgeOf("ORD-00001")).getByText("On Its Way")).toBeInTheDocument();
  });

  it("fleet seller: a SHIP order reads Shipped; a ROUTE order keeps Out For Delivery", () => {
    mockCaps = fulfilment("ROUTE", true);
    renderWithProviders(<BuyerOrdersPage />);
    expect(within(badgeOf("ORD-00002")).getByText("Shipped")).toBeInTheDocument();
    expect(within(badgeOf("ORD-00002")).queryByText("Out For Delivery")).toBeNull();
    expect(within(badgeOf("ORD-00003")).getByText("Shipped")).toBeInTheDocument();
    expect(within(badgeOf("ORD-00001")).getByText("Out For Delivery")).toBeInTheDocument();
  });

  it("unset seller: today's labels for every order, SHIP included", () => {
    mockCaps = fulfilment(null, true);
    renderWithProviders(<BuyerOrdersPage />);
    expect(within(badgeOf("ORD-00002")).getByText("Out For Delivery")).toBeInTheDocument();
    expect(within(badgeOf("ORD-00003")).getByText("Confirmed")).toBeInTheDocument();
  });
});
