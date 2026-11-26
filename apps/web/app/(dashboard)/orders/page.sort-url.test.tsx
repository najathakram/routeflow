import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import OrdersPage from "./page";

/**
 * UX audit 2026-11-24, findings F50 and F51 on the orders list.
 * F50: Back from an order kept the filter and dropped the sort. The sort is read from the URL now.
 * F51: urgent orders are pinned above the sorted rows; sorted by Total that looked like a broken sort. The list
 * says so whenever a sort is on and the pin shows.
 */
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useDeliveryAccess: () => ({ enabled: false, resolved: true }),
}));
jest.mock("@/lib/tenant-features", () => ({ useTenantFeatures: () => ({ data: undefined }) }));
const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

const order = (id: string, total: number, urgent: boolean) => ({
  id,
  orderNumber: `ORD-${id}`,
  status: "PENDING",
  urgent,
  total,
  createdAt: `2026-10-0${id}T00:00:00.000Z`,
  requestedDeliveryDate: null,
  customer: { businessName: `Acme ${id}` },
  lineItems: [],
});
let rows = [order("1", 30, false), order("2", 10, false), order("3", 99, true)];
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useOrders: () => ({
    data: { data: rows, meta: { total: rows.length, page: 1, limit: 20, totalPages: 1 } },
    isLoading: false,
    isError: false,
  }),
  useUpdateOrderStatus: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useBulkDeleteOrders: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));

/** Order numbers in the desktop table, top to bottom. */
const tableOrder = () =>
  within(screen.getByRole("table"))
    .getAllByText(/^ORD-\d$/)
    .map((el) => el.textContent);

beforeEach(() => {
  window.history.replaceState(null, "", "/orders");
  mockReplace.mockReset();
  rows = [order("1", 30, false), order("2", 10, false), order("3", 99, true)];
});

describe("Orders list: the sort lives in the URL", () => {
  it("a sort already in the URL (Back from an order, a reload) is the sort the rows are in", () => {
    window.history.replaceState(null, "", "/orders?sort=total&dir=desc");
    renderWithProviders(<OrdersPage />);
    // urgent ORD-3 pinned first, then 30, then 10: the reverse of the default (newest first) order
    expect(tableOrder()).toEqual(["ORD-3", "ORD-1", "ORD-2"]);
  });

  it("clicking the Total header writes the sort in one router write and keeps the status filter", async () => {
    window.history.replaceState(null, "", "/orders?status=PENDING");
    const replaceState = jest.spyOn(window.history, "replaceState");
    renderWithProviders(<OrdersPage />);
    await userEvent.setup().click(screen.getByRole("columnheader", { name: /Total/ }));

    // the same writer the filters use, never a second mechanism beside it (R-137)
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(replaceState).not.toHaveBeenCalled();
    expect(mockReplace.mock.calls[0][0]).toBe("/orders?status=PENDING&sort=total&dir=asc");
    replaceState.mockRestore();
  });

  it("no sort in the URL is the default: newest first, urgent on top, nothing written", () => {
    renderWithProviders(<OrdersPage />);
    expect(tableOrder()).toEqual(["ORD-3", "ORD-2", "ORD-1"]);
    expect(window.location.search).toBe("");
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

describe("Orders list: says why urgent rows are out of the sorted order", () => {
  const note = () => screen.queryByText("Urgent orders stay on top, then the sort applies.");

  it("a sort is on and some rows are urgent: the line shows", () => {
    window.history.replaceState(null, "", "/orders?sort=total&dir=asc");
    renderWithProviders(<OrdersPage />);
    expect(note()).toBeInTheDocument();
  });

  it("the default sort: no line", () => {
    renderWithProviders(<OrdersPage />);
    expect(note()).not.toBeInTheDocument();
  });

  it("a sort is on but no row is urgent: no line", () => {
    rows = [order("1", 30, false), order("2", 10, false)];
    window.history.replaceState(null, "", "/orders?sort=total&dir=asc");
    renderWithProviders(<OrdersPage />);
    expect(note()).not.toBeInTheDocument();
  });

  it("a sort is on and every row is urgent: nothing is out of order, no line", () => {
    rows = [order("1", 30, true), order("2", 10, true)];
    window.history.replaceState(null, "", "/orders?sort=total&dir=asc");
    renderWithProviders(<OrdersPage />);
    expect(note()).not.toBeInTheDocument();
  });
});
