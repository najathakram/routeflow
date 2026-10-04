import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import CustomersPage from "./page";

// M3: fleet-off (fulfilment model set, no fleet module) has no routes, so no "Unassigned only" chip and
// ?unassigned=1 is stripped. A fleet account (and an UNSET one) keeps the chip.
let fleet = true;
let search = "";
const replace = jest.fn();
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useFleetAccess: () => ({ fleet, loading: false }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace }),
  usePathname: () => "/customers",
  useSearchParams: () => new URLSearchParams(search),
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

describe("CustomersPage — fleet-off", () => {
  beforeEach(() => {
    search = "";
    replace.mockClear();
  });

  it("fleet-OFF: no 'Unassigned only' chip", () => {
    fleet = false;
    renderWithProviders(<CustomersPage />);
    expect(screen.queryByText("Unassigned only")).not.toBeInTheDocument();
  });

  it("fleet-OFF: ?unassigned=1 is stripped from the URL", () => {
    fleet = false;
    search = "unassigned=1";
    renderWithProviders(<CustomersPage />);
    expect(screen.queryByText("Unassigned only")).not.toBeInTheDocument();
    expect(replace).toHaveBeenCalled();
    expect(String(replace.mock.calls[0][0])).not.toContain("unassigned");
  });

  it("fleet-ON (today's UI, unchanged): the chip is there", () => {
    fleet = true;
    renderWithProviders(<CustomersPage />);
    expect(screen.getByText("Unassigned only")).toBeInTheDocument();
  });
});
