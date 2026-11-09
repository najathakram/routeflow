import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import CustomersPage from "./page";

/**
 * B1019 (item 1): the command palette's "New customer" pushes /customers?action=new (and
 * /customers/create redirects there). The page must honor it by opening the same Add Customer
 * modal the "New customer" button opens, once, and consume the param so a refresh or Back does
 * not reopen it. Orders and products already do this; customers read only `tag`.
 */
let mockSearch = "";
const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
  usePathname: () => "/customers",
  useSearchParams: () => new URLSearchParams(mockSearch),
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
  useCreateCustomer: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
  useUpdateCustomer: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
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
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/sales-agents", () => ({ useSalesAgents: () => ({ data: undefined }) }));
jest.mock("../sales-agents/_components/AgentFormModal", () => ({ AgentFormModal: () => null }));
jest.mock("@/components/AddressAutocomplete", () => ({
  AddressAutocomplete: ({ value, onChange }: any) => (
    <input aria-label="Street" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const addDialog = () => screen.queryByRole("dialog", { name: /add customer/i });

beforeEach(() => {
  jest.clearAllMocks();
  mockSearch = "";
});

describe("CustomersPage: ?action=new opens the Add Customer modal (B1019)", () => {
  it("opens the Add Customer modal on mount when ?action=new is present", () => {
    mockSearch = "action=new";
    renderWithProviders(<CustomersPage />);
    expect(addDialog()).not.toBeNull();
  });

  it("does not open the modal when ?action=new is absent", () => {
    renderWithProviders(<CustomersPage />);
    expect(addDialog()).toBeNull();
  });

  it("consumes the param (router.replace without action) so Back does not reopen", () => {
    mockSearch = "action=new";
    renderWithProviders(<CustomersPage />);
    expect(mockReplace).toHaveBeenCalled();
    for (const [href] of mockReplace.mock.calls) expect(String(href)).not.toMatch(/action=/);
  });
});
