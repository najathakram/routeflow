import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import type { BuyerOrderListItem } from "@routeflow/types";
import { orderLine, orderListItem } from "@/test-utils/buyer-order-fixtures";
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

let mockOrders: BuyerOrderListItem[] = [];
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

// B1130: rows have the shape GET /buyer/orders really returns — `lineItems` and `total`, no
// `itemCount`/`totalAmount` (the fixtures are typed by @routeflow/types, so an invented field
// fails type-check instead of quietly passing).
const orders: BuyerOrderListItem[] = [
  orderListItem({
    id: "11111111-aaaa",
    orderNumber: "ORD-00001",
    createdAt: "2026-09-10T12:00:00Z",
    status: "OUT_FOR_DELIVERY",
    total: 645,
    lineItems: [orderLine({ id: "l1" }), orderLine({ id: "l2" }), orderLine({ id: "l3" })],
  }),
  orderListItem({
    id: "22222222-bbbb",
    orderNumber: null,
    createdAt: "2026-09-11T12:00:00Z",
    status: "DELIVERED",
    total: 52.5,
    lineItems: [orderLine({ id: "l4" })],
  }),
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
    // singular item count + the id-derived label when there is no order number
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

  it("B1130: the Items column counts the order's real line items, per row", () => {
    renderWithProviders(<BuyerOrdersPage />);
    const rows = within(screen.getByTestId("buyer-orders-table")).getAllByRole("row");
    // rows[0] is the header; the cells are Order #, Date, Items, Status, Total.
    expect(within(rows[1]).getByText("3 items")).toBeInTheDocument();
    expect(within(rows[2]).getByText("1 item")).toBeInTheDocument();
    expect(within(rows[1]).queryByText("—")).toBeNull();
    expect(within(rows[2]).queryByText("—")).toBeNull();
  });

  it("B1130: shows the em dash only when the order has no lines or the API sent none", () => {
    mockOrders = [
      orderListItem({ id: "33333333-cccc", orderNumber: "ORD-00003", lineItems: [] }),
      // A response that omits `lineItems` entirely is "unknown", not "0 items" and not a crash.
      { ...orderListItem({ id: "44444444-dddd", orderNumber: "ORD-00004" }), lineItems: undefined },
    ] as unknown as BuyerOrderListItem[];
    renderWithProviders(<BuyerOrdersPage />);
    const rows = within(screen.getByTestId("buyer-orders-table")).getAllByRole("row");
    expect(within(rows[1]).getByText("—")).toBeInTheDocument();
    expect(within(rows[2]).getByText("—")).toBeInTheDocument();
    // the phone card prints no count at all rather than a wrong one
    const cards = within(screen.getByTestId("buyer-orders-cards")).getAllByRole("link");
    expect(within(cards[0]).queryByText(/item/)).toBeNull();
    expect(within(cards[1]).queryByText(/item/)).toBeNull();
  });

  it("shows the em dash, never $NaN or $0.00, when an order's total is missing, null or not a number", () => {
    // A missing total is "unknown", not zero: Number(undefined) is NaN and Number(null) is 0,
    // and both used to print as money.
    mockOrders = [
      { ...orderListItem({ id: "55555555-eeee", orderNumber: "ORD-00005" }), total: undefined },
      { ...orderListItem({ id: "66666666-ffff", orderNumber: "ORD-00006" }), total: null },
      { ...orderListItem({ id: "77777777-gggg", orderNumber: "ORD-00007" }), total: "oops" },
      orderListItem({ id: "88888888-hhhh", orderNumber: "ORD-00008", total: 0 }),
    ] as unknown as BuyerOrderListItem[];
    renderWithProviders(<BuyerOrdersPage />);
    const rows = within(screen.getByTestId("buyer-orders-table")).getAllByRole("row");
    const total = (row: HTMLElement) => within(row).getAllByRole("cell").at(-1)?.textContent;
    expect(total(rows[1])).toBe("—");
    expect(total(rows[2])).toBe("—");
    expect(total(rows[3])).toBe("—");
    // a real zero total is still money
    expect(total(rows[4])).toBe("$0.00");
    const cards = within(screen.getByTestId("buyer-orders-cards")).getAllByRole("link");
    expect(within(cards[0]).queryByText(/NaN|N\/A/)).toBeNull();
    expect(within(cards[0]).getByText("—")).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("shows the empty state, not an empty card list, when there are no orders", () => {
    mockOrders = [];
    renderWithProviders(<BuyerOrdersPage />);
    expect(screen.getByText("No orders yet")).toBeInTheDocument();
    expect(screen.queryByTestId("buyer-orders-cards")).toBeNull();
    expect(screen.queryByTestId("buyer-orders-table")).toBeNull();
  });
});
