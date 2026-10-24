import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import CustomersPage from "./page";

// Perms PR1 M1: POST /import/contacts is TENANT_ADMIN-only, so the Import button is admin-only.
let mockRole = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", username: "x", role: mockRole } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/customers",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: () => ({
    data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } },
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

const importBtn = () => screen.queryByRole("button", { name: /^import$/i });

describe("T1.3 operator: account-admin controls are not offered", () => {
  it("customers page has no Import button, but still has Export", () => {
    mockRole = "OPERATOR";
    renderWithProviders(<CustomersPage />);
    expect(importBtn()).toBeNull();
    expect(screen.getByRole("button", { name: /^export$/i })).toBeInTheDocument();
  });
});

describe("T1.4 admin: the same controls are all there", () => {
  it.each(["TENANT_ADMIN", "SUPER_ADMIN"])("%s sees the Import button", (role) => {
    mockRole = role;
    renderWithProviders(<CustomersPage />);
    expect(importBtn()).not.toBeNull();
  });
});
