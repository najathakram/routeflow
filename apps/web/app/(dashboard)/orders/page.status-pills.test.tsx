import * as React from "react";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen } from "@/test-utils/render";
import OrdersPage from "./page";

/**
 * O4 (P04, apple-ux run 2026-10-16; owner ruling 10-16): the Orders list had TWO status filters
 * (the saved-view pills and an "All Statuses" dropdown). Keep the pills, remove the dropdown, and
 * add Draft + Partly delivered pills so no status filter is lost. `?status=` URLs keep working.
 */
let search = "";
let rows: Record<string, unknown>[] = [];
const replace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(search),
}));

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

beforeEach(() => {
  search = "";
  rows = [];
  replace.mockClear();
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

  it("clicking a status pill keeps the date range, product and fulfilment filters (only status changes)", () => {
    search = "dateFrom=2026-10-01&dateTo=2026-10-15&productId=p1&fulfillPath=SHIP&status=PENDING";
    renderWithProviders(<OrdersPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Delivered/i }));
    expect(replace).toHaveBeenCalledTimes(1);
    const url = new URLSearchParams(String(replace.mock.calls[0][0]).split("?")[1]);
    expect(url.get("status")).toBe("DELIVERED");
    expect(url.get("dateFrom")).toBe("2026-10-01");
    expect(url.get("dateTo")).toBe("2026-10-15");
    expect(url.get("productId")).toBe("p1");
    expect(url.get("fulfillPath")).toBe("SHIP");
  });

  it("the All pill still clears every filter", () => {
    search = "dateFrom=2026-10-01&productId=p1&status=PENDING";
    renderWithProviders(<OrdersPage />);
    fireEvent.click(screen.getByRole("button", { name: /^All/i }));
    const url = String(replace.mock.calls.at(-1)![0]);
    expect(url).not.toMatch(/dateFrom|productId|status/);
  });

  it("the pill and the row badge use the same word for PARTIALLY_DELIVERED", () => {
    rows = [
      {
        id: "o1",
        orderNumber: "ORD-1",
        status: "PARTIALLY_DELIVERED",
        fulfillPath: "ROUTE",
        total: 25,
        createdAt: "2026-10-08T12:00:00.000Z",
        deliveryDate: null,
        customer: { id: "c1", businessName: "Acme Co" },
        lineItems: [{ id: "li1" }],
        _count: { changeRequests: 0 },
      },
    ];
    renderWithProviders(<OrdersPage />);
    expect(screen.getAllByText("Partly delivered").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/partially delivered/i)).toBeNull();
  });
});
