import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import OrdersPage from "./page";

// SA-1101 §4.3: a wholly refused order reads "Refused" in the orders list: a chip in the warning tone (the Pending /
// Partly delivered amber, not Cancelled's red), a "Refused" saved-view pill that filters on REFUSED, and never the
// word "Delivered". Fixtures are placeholders.
const routerReplace = jest.fn();
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useDeliveryAccess: () => ({ enabled: false, resolved: true }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: routerReplace }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useOrders: () => ({
    data: {
      data: [
        {
          id: "o1",
          orderNumber: "ORD-1",
          status: "REFUSED",
          urgent: false,
          total: 10,
          createdAt: "2026-10-01T00:00:00.000Z",
          requestedDeliveryDate: null,
          customer: { businessName: "Acme" },
          lineItems: [],
        },
      ],
      meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
    },
    isLoading: false,
    isError: false,
  }),
  useUpdateOrderStatus: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useBulkDeleteOrders: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));

describe("Orders list: REFUSED (SA-1101)", () => {
  beforeEach(() => routerReplace.mockClear());

  it("the row chip says Refused in the warning tone, never Delivered or the cancelled red", () => {
    renderWithProviders(<OrdersPage />);
    const chips = screen
      .getAllByText("Refused")
      // the saved-view pill is a button; the row chip is the Badge span
      .filter((el) => el.tagName === "SPAN");
    expect(chips.length).toBeGreaterThanOrEqual(1);
    for (const chip of chips) {
      const badge = chip.closest("span[class*='rounded-full']") as HTMLElement;
      expect(badge.className).toContain("bg-warning-bg");
      expect(badge.className).not.toContain("bg-danger-bg");
    }
    expect(screen.queryAllByText("Delivered").every((el) => el.tagName === "BUTTON")).toBe(true);
  });

  it("the status filter has a Refused option, and it filters on REFUSED", () => {
    renderWithProviders(<OrdersPage />);
    const pill = screen.getByRole("button", { name: "Refused" });
    fireEvent.click(pill);
    expect(routerReplace).toHaveBeenCalledWith(
      expect.stringContaining("status=REFUSED"),
      expect.anything(),
    );
  });
});
