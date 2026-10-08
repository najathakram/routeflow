import * as React from "react";
import { screen, renderWithProviders, fireEvent } from "@/test-utils/render";
import CustomersPage from "./page";

/**
 * SA-672a (e): the tenant's system walk-in customer (counter sales) is shown in the list like any customer
 * but can never be deactivated or bulk-deleted: its row has no Deactivate control and cannot be selected.
 * The server refuses it too (400 WALK_IN_PROTECTED); this keeps the UI from offering what will fail.
 */
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/customers",
  useSearchParams: () => new URLSearchParams(),
}));

const user = { id: "u", email: "a@b.c", username: "x", status: "ACTIVE" };
const rows = [
  {
    id: "w1",
    businessName: "Walk-in customer",
    contactName: "Walk-in",
    isWalkIn: true,
    user,
    addresses: [],
  },
  { id: "c1", businessName: "Acme Foods", contactName: "Ann", isWalkIn: null, user, addresses: [] },
];

jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: () => ({
    data: { data: rows, meta: { total: 2, page: 1, limit: 20, totalPages: 1 } },
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

describe("CustomersPage — the walk-in customer is protected", () => {
  it("an ordinary row offers Deactivate, the walk-in row does not", () => {
    renderWithProviders(<CustomersPage />);
    // One Deactivate (Acme); the walk-in's control is gone.
    expect(screen.getAllByRole("button", { name: /deactivate customer/i })).toHaveLength(1);
    expect(screen.getByText("Walk-in customer")).toBeInTheDocument();
  });

  it("the walk-in row's checkbox is disabled in select mode and select-all skips it", () => {
    renderWithProviders(<CustomersPage />);
    fireEvent.click(screen.getByRole("button", { name: /^select$/i }));
    const boxes = screen.getAllByRole("checkbox");
    // header, walk-in, Acme
    expect(boxes).toHaveLength(3);
    expect(boxes[1]).toBeDisabled();
    expect(boxes[2]).not.toBeDisabled();
    fireEvent.click(boxes[0]); // select all
    const after = screen.getAllByRole("checkbox"); // re-query: the columns re-render on select
    expect(after[1]).not.toBeChecked();
    expect(after[2]).toBeChecked();
  });
});
