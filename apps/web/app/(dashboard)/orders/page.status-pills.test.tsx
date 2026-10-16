import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import OrdersPage from "./page";

/**
 * O4 (P04, apple-ux run 2026-10-16; owner ruling 10-16): the Orders list had TWO status filters
 * (the saved-view pills and an "All Statuses" dropdown). Keep the pills, remove the dropdown, and
 * add Draft + Partly delivered pills so no status filter is lost. `?status=` URLs keep working.
 */
let search = "";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(search),
}));

jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useOrders: () => ({
    data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } },
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

beforeEach(() => {
  search = "";
});

describe("OrdersPage: one status filter (O4)", () => {
  it("has no status dropdown", () => {
    renderWithProviders(<OrdersPage />);
    expect(screen.queryByText("All Statuses")).toBeNull();
    // The remaining comboboxes are the fulfilment filter (and mobile sort), never a status list.
    for (const combo of screen.queryAllByRole("combobox")) {
      expect(combo).not.toHaveTextContent(/pending|confirmed|delivered|cancelled|draft/i);
    }
  });

  it.each([
    "All",
    "Draft",
    "Pending",
    "Confirmed",
    "Out for Delivery",
    "Partly delivered",
    "Delivered",
    "Cancelled",
  ])("has a %s pill", (label) => {
    renderWithProviders(<OrdersPage />);
    expect(screen.getByRole("button", { name: new RegExp(`^${label}`, "i") })).toBeInTheDocument();
  });

  it("marks Partly delivered active for ?status=PARTIALLY_DELIVERED", () => {
    search = "status=PARTIALLY_DELIVERED";
    renderWithProviders(<OrdersPage />);
    expect(screen.getByRole("button", { name: /^Partly delivered/i }).className).toMatch(
      /\bbg-navy\b/,
    );
    expect(screen.getByRole("button", { name: /^All/i }).className).not.toMatch(/\bbg-navy\b/);
  });

  it("marks Draft active for ?status=DRAFT", () => {
    search = "status=DRAFT";
    renderWithProviders(<OrdersPage />);
    expect(screen.getByRole("button", { name: /^Draft/i }).className).toMatch(/\bbg-navy\b/);
  });
});
