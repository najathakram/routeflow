import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import CustomersPage from "./page";

/**
 * B749: the customers-list action toolbar (Import / Export / Select / New
 * Customer) rendered as a plain `flex items-center gap-2` row with no wrap.
 * At 390px the row is wider than the viewport and overflows horizontally.
 * Fix: wrap, don't clip (same `flex-wrap ... justify-end` pattern as
 * CreateOrderModal's footer row and B770's invoices toolbar).
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/customers",
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: () => ({
    data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useCustomerTags: () => ({ data: [], isLoading: false, isError: false }),
  useUpdateCustomerStatus: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteCustomer: () => ({ mutate: jest.fn(), isPending: false }),
  useBatchDeleteCustomers: () => ({ mutate: jest.fn(), isPending: false }),
  useExportCustomers: () => ({ mutate: jest.fn(), isPending: false }),
  useMergeCustomers: () => ({ mutate: jest.fn(), isPending: false }),
  useRestoreCustomer: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock("@/lib/api/portal-approvals", () => ({
  ...jest.requireActual("@/lib/api/portal-approvals"),
  usePendingPortalApprovals: () => ({ data: [], isLoading: false, isError: false }),
  useApprovePortalRequest: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock("@/lib/api/routes", () => ({
  ...jest.requireActual("@/lib/api/routes"),
  useCustomerRouteAssignments: () => ({ data: [], isLoading: false, isError: false }),
}));

describe("CustomersPage — B749 action toolbar wraps instead of overflowing", () => {
  it("New Customer button row wraps at narrow widths, doesn't overflow off-screen", () => {
    renderWithProviders(<CustomersPage />);

    const newCustomer = screen.getByRole("button", { name: /new customer/i });
    const actions = newCustomer.parentElement!;
    expect(actions).toHaveClass("flex-wrap", "justify-end");
    // Every action stays reachable — none of them got dropped by the fix.
    expect(actions).toContainElement(screen.getByRole("button", { name: /^import$/i }));
    expect(actions).toContainElement(screen.getByRole("button", { name: /^export$/i }));
  });
});
