import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import OrdersPage from "./page";

/**
 * F04 (orders apple-ux r3): a keyboard clerk needed 51 Tabs to reach the first order. A "Skip to orders (N)" link
 * right after the search box moves focus to the first row, so the next Enter opens it.
 */
const push = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: jest.fn() }),
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
let loading = false;
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useOrders: () => ({
    data: loading
      ? undefined
      : { data: rows, meta: { total: rows.length, page: 1, limit: 20, totalPages: 1 } },
    isLoading: loading,
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
  push.mockClear();
  loading = false;
});

describe("OrdersPage: skip to orders", () => {
  it("is the next Tab stop after the search box and names the order count", async () => {
    rows = [order({ id: "o1" }), order({ id: "o2", orderNumber: "ORD-2" })];
    const user = userEvent.setup();
    renderWithProviders(<OrdersPage />);
    const link = screen.getByRole("link", { name: "Skip to orders (2)" });
    await user.click(screen.getByRole("searchbox"));
    await user.tab();
    expect(link).toHaveFocus();
  });

  it("is hidden until focused and 44px tall when shown", () => {
    rows = [order({})];
    renderWithProviders(<OrdersPage />);
    const link = screen.getByRole("link", { name: "Skip to orders (1)" });
    expect(link).toHaveClass("sr-only", "focus:not-sr-only", "focus:h-11");
  });

  it("Enter moves focus to the first order row, and the next Enter opens it", async () => {
    rows = [order({ id: "o1" }), order({ id: "o2", orderNumber: "ORD-2" })];
    const user = userEvent.setup();
    renderWithProviders(<OrdersPage />);
    screen.getByRole("link", { name: "Skip to orders (2)" }).focus();
    await user.keyboard("{Enter}");
    const active = document.activeElement as HTMLElement;
    expect(active).toHaveAttribute("role", "link");
    expect(active).toHaveTextContent("ORD-1");
    expect(push).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/orders/o1");
  });

  it("is not rendered when there are no orders to skip to", () => {
    rows = [];
    renderWithProviders(<OrdersPage />);
    expect(screen.queryByRole("link", { name: /skip to orders/i })).toBeNull();
  });

  it("is not rendered while the list is loading", () => {
    loading = true;
    renderWithProviders(<OrdersPage />);
    expect(screen.queryByRole("link", { name: /skip to orders/i })).toBeNull();
  });
});

describe("OrdersPage: skip to orders target", () => {
  it("the link's href points at an element that exists and holds the rows", () => {
    rows = [order({})];
    renderWithProviders(<OrdersPage />);
    const link = screen.getByRole("link", { name: "Skip to orders (1)" });
    const id = link.getAttribute("href")?.replace(/^#/, "") ?? "";
    const target = document.getElementById(id);
    expect(target).not.toBeNull();
    expect(target).toHaveTextContent("ORD-1");
    expect(target?.querySelectorAll("[data-order-row]").length).toBeGreaterThan(0);
  });
});
