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

jest.mock("@/lib/api/buyer", () => ({
  useBuyerOrders: () => ({
    data: {
      data: [
        {
          id: "11111111-aaaa",
          orderNumber: "ORD-00001",
          createdAt: "2026-09-10T12:00:00Z",
          itemCount: 3,
          status: "OUT_FOR_DELIVERY",
          totalAmount: 645,
        },
      ],
      meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
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
  data: {
    fulfilment: {
      methods: ["SHIP"],
      staffDefault: "SHIP",
      staffOpensAs: "order",
      portalMethods: portalDefault ? [portalDefault] : [],
      portalDefault,
      counter: "off",
      fleet,
      consistent: true,
    },
  },
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
