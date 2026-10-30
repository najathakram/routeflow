import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import OrdersPage from "./page";

/**
 * apple-ux r5, Orders list table at 768: every cell wrapped (ORD-/00024, names and dates on two lines). jsdom has no
 * layout, so the claim is pinned on the class tokens the CSS keys off; the measured one-line rows at 768 are the
 * host-run capture's job. Cells never wrap; a long customer name truncates; the low-value Items column steps out
 * below lg so the rest fit; the full name stays available as a title.
 */
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(),
}));

const order = (over: Record<string, unknown>) => ({
  id: "o1",
  orderNumber: "ORD-00024",
  status: "CONFIRMED",
  fulfillPath: "ROUTE",
  total: 25,
  createdAt: "2026-10-08T12:00:00.000Z",
  deliveryDate: null,
  customer: { id: "c1", businessName: "Acme Wholesale Foods and Beverages Distribution Co" },
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

const tokens = (el: Element | null) =>
  (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("Orders list table at md (768)", () => {
  it("no body cell wraps, and the customer name truncates (title keeps the whole name)", () => {
    rows = [order({})];
    renderWithProviders(<OrdersPage />);
    const row = document.querySelector("tr[data-order-row]") as HTMLElement;
    for (const td of Array.from(row.querySelectorAll("td"))) {
      expect(tokens(td)).toContain("whitespace-nowrap");
    }
    const name = within(row).getByText(/Acme Wholesale Foods/);
    expect(tokens(name)).toContain("truncate");
    expect(name).toHaveAttribute("title", "Acme Wholesale Foods and Beverages Distribution Co");
    expect(tokens(name)).toEqual(expect.arrayContaining(["max-w-[12rem]"]));
  });

  it("the Items column (header and cells) steps out below lg", () => {
    rows = [order({})];
    renderWithProviders(<OrdersPage />);
    const head = screen.getByRole("columnheader", { name: "Items" });
    expect(tokens(head)).toContain("max-lg:hidden");
    const row = document.querySelector("tr[data-order-row]") as HTMLElement;
    const itemsCell = Array.from(row.querySelectorAll("td")).find(
      (td) => td.textContent === "1",
    ) as HTMLElement;
    expect(tokens(itemsCell)).toContain("max-lg:hidden");
  });

  it("the header cells do not wrap either", () => {
    rows = [order({})];
    renderWithProviders(<OrdersPage />);
    for (const th of Array.from(document.querySelectorAll("thead th"))) {
      expect(tokens(th)).toContain("whitespace-nowrap");
    }
  });
});
