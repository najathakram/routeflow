import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import OrdersPage from "./page";

// B506: the delivery date-range filter's second field ran past the 390px
// viewport edge because its own container never wrapped, unlike every other
// filter control on this row. This pins the functional/structural half of
// the fix — both inputs render, are enabled, and are wired to the URL filter
// state. The actual visual-overflow regression can only be proven with a
// real layout engine (jsdom has none — see e2e/orders-mobile-filters.spec.ts
// for the Playwright case that asserts the real bounding boxes at 390px).

const routerReplace = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: routerReplace }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(),
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

describe("OrdersPage — delivery date-range filter (B506)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders both the from and to date inputs, each enabled", () => {
    renderWithProviders(<OrdersPage />);

    const from = screen.getByTitle("Delivery date from") as HTMLInputElement;
    const to = screen.getByTitle("Delivery date to") as HTMLInputElement;

    expect(from).toBeEnabled();
    expect(to).toBeEnabled();
    expect(from).toHaveAttribute("type", "date");
    expect(to).toHaveAttribute("type", "date");
  });

  it("the from field is interactive and writes to the URL filter state", () => {
    renderWithProviders(<OrdersPage />);

    const from = screen.getByTitle("Delivery date from");
    fireEvent.change(from, { target: { value: "2026-10-01" } });

    expect(routerReplace).toHaveBeenCalledWith(
      expect.stringContaining("dateFrom=2026-10-01"),
      expect.anything(),
    );
  });

  it("the to field is interactive and writes to the URL filter state", () => {
    renderWithProviders(<OrdersPage />);

    const to = screen.getByTitle("Delivery date to");
    fireEvent.change(to, { target: { value: "2026-10-15" } });

    expect(routerReplace).toHaveBeenCalledWith(
      expect.stringContaining("dateTo=2026-10-15"),
      expect.anything(),
    );
  });
});
