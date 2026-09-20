import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import BuyerOrdersPage from "./page";

/**
 * Buyer-portal orders list. Under 640px the 5-column table only scrolled sideways, so phones
 * get a card list (`sm:hidden`) and the table (`hidden sm:block`) keeps the Order # column
 * pinned (`sticky left-0`) for the narrow-tablet case that still scrolls. JSDOM applies no
 * media queries, so both trees are present here; visibility is pinned by class and by the
 * Lane F Playwright pass at 390/768/1440.
 */

const push = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push }),
}));

let mockOrders: unknown[] = [];
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

const orders = [
  {
    id: "11111111-aaaa",
    orderNumber: "ORD-00001",
    createdAt: "2026-09-10T12:00:00Z",
    itemCount: 3,
    status: "OUT_FOR_DELIVERY",
    totalAmount: 645,
  },
  {
    id: "22222222-bbbb",
    orderNumber: null,
    createdAt: "2026-09-11T12:00:00Z",
    itemCount: 1,
    status: "DELIVERED",
    total: 52.5,
  },
];

describe("BuyerOrdersPage — responsive list", () => {
  beforeEach(() => {
    push.mockClear();
    mockOrders = orders;
  });

  it("renders a card list for phones, one linked card per order", () => {
    renderWithProviders(<BuyerOrdersPage />);
    const cards = screen.getByTestId("buyer-orders-cards");
    expect(cards).toHaveClass("sm:hidden");

    const links = within(cards).getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "/buyer/portal/acme/orders/11111111-aaaa");
    expect(within(links[0]).getByText("ORD-00001")).toBeInTheDocument();
    expect(within(links[0]).getByText("Out For Delivery")).toBeInTheDocument();
    expect(within(links[0]).getByText(/3 items/)).toBeInTheDocument();
    expect(within(links[0]).getByText("$645.00")).toBeInTheDocument();
    // singular item count + the id-derived label when there is no order number + `total` fallback
    expect(within(links[1]).getByText("22222222")).toBeInTheDocument();
    expect(within(links[1]).getByText(/1 item(?!s)/)).toBeInTheDocument();
    expect(within(links[1]).getByText("$52.50")).toBeInTheDocument();
  });

  it("keeps the table from sm up, in a horizontal scroller with the Order # column pinned", () => {
    renderWithProviders(<BuyerOrdersPage />);
    const wrapper = screen.getByTestId("buyer-orders-table");
    expect(wrapper).toHaveClass("hidden", "sm:block");
    expect(wrapper.querySelector(".overflow-x-auto")).not.toBeNull();

    const header = within(wrapper).getByRole("columnheader", { name: "Order #" });
    expect(header).toHaveClass("sticky", "left-0");
    const firstCell = within(wrapper).getByText("ORD-00001");
    expect(firstCell).toHaveClass("sticky", "left-0", "bg-white");
    // Badge ignores JSX children, so the status must go through `label` — a blank pill here is
    // the pre-existing bug this page used to ship.
    expect(within(wrapper).getByText("Out For Delivery")).toBeInTheDocument();
    expect(within(wrapper).getByText("Delivered")).toBeInTheDocument();
  });

  it("row click still navigates to the order", () => {
    renderWithProviders(<BuyerOrdersPage />);
    const wrapper = screen.getByTestId("buyer-orders-table");
    within(wrapper).getByText("ORD-00001").click();
    expect(push).toHaveBeenCalledWith("/buyer/portal/acme/orders/11111111-aaaa");
  });

  it("shows the empty state, not an empty card list, when there are no orders", () => {
    mockOrders = [];
    renderWithProviders(<BuyerOrdersPage />);
    expect(screen.getByText("No orders yet")).toBeInTheDocument();
    expect(screen.queryByTestId("buyer-orders-cards")).toBeNull();
    expect(screen.queryByTestId("buyer-orders-table")).toBeNull();
  });
});
