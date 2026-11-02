import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import CustomersPage from "./page";

/**
 * SA-1084 A-2: the list's Edit button reads the customer's detail first (the same `GET customers/:id` the detail
 * page uses, the only read that carries the last 4 of a stored tax ID), opens the form only once that read has
 * loaded, and on a failed read opens nothing and says so. The list row itself carries no tax ID, as ruled (SI-3,
 * pinned on the list endpoint in customer-identity-by-role.sa1084.db.spec.ts: SI-18 is that row, unchanged).
 */
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/customers",
  useSearchParams: () => new URLSearchParams(),
}));

const user = { id: "u", email: "a@b.c", username: "x", status: "ACTIVE" };
const listRow = {
  id: "c1",
  businessName: "Acme Foods",
  contactName: "Pat Lee",
  customerType: "BUSINESS",
  isWalkIn: null,
  user,
  email: "c1@acme.example",
  addresses: [{ line1: "1 Main St", city: "Austin", zip: "78701" }],
};
const detail = { ...listRow, taxIdLast4: "1234" };

const fetchCustomer = jest.fn();
const updateMutate = jest.fn();

jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  fetchCustomer: (id: string) => fetchCustomer(id),
  useCustomers: () => ({
    data: { data: [listRow], meta: { total: 1, page: 1, limit: 20, totalPages: 1 } },
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
  useUpdateCustomer: () => ({
    mutate: updateMutate,
    isPending: false,
    error: null,
    reset: jest.fn(),
  }),
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

const pencil = () => screen.getByRole("button", { name: /^edit customer$/i });
const saveButton = () => screen.queryByRole("button", { name: /save changes/i });

beforeEach(() => jest.clearAllMocks());

describe("CustomersPage: the list's Edit button reads the detail first (SA-1084 A-2)", () => {
  it("SI-15: a customer with a tax ID on file opens the form with 'On file, ending 1234' and Remove", async () => {
    fetchCustomer.mockResolvedValue(detail);
    renderWithProviders(<CustomersPage />);
    fireEvent.click(pencil());
    expect(await screen.findByPlaceholderText(/On file, ending 1234/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove the tax id on file/i })).toBeInTheDocument();
    expect(fetchCustomer).toHaveBeenCalledTimes(1);
    expect(fetchCustomer).toHaveBeenCalledWith("c1");
  });

  it("opens only once the read has loaded, so typing is never lost to a late reset", async () => {
    let finish: (v: unknown) => void = () => {};
    fetchCustomer.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderWithProviders(<CustomersPage />);
    fireEvent.click(pencil());
    expect(saveButton()).toBeNull();
    finish(detail);
    expect(await screen.findByPlaceholderText(/On file, ending 1234/)).toBeInTheDocument();
    expect(saveButton()).not.toBeNull();
  });

  it("SI-16 (guard): a blank save from this door sends no tax ID, so the stored value stays", async () => {
    fetchCustomer.mockResolvedValue(detail);
    renderWithProviders(<CustomersPage />);
    fireEvent.click(pencil());
    fireEvent.click(await screen.findByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    expect(updateMutate.mock.calls[0][0].taxId).toBeUndefined();
  });

  it("SI-17: a failed read opens no form and says so in plain words", async () => {
    fetchCustomer.mockRejectedValue(new Error("Network Error"));
    renderWithProviders(<CustomersPage />);
    fireEvent.click(pencil());
    expect(await screen.findByText(/couldn.t open this customer/i)).toBeInTheDocument();
    expect(saveButton()).toBeNull();
    expect(screen.queryByPlaceholderText(/On file, ending/)).toBeNull();
  });

  it("a failed read leaves the button usable: the next click reads again and opens", async () => {
    fetchCustomer.mockRejectedValueOnce(new Error("Network Error")).mockResolvedValue(detail);
    renderWithProviders(<CustomersPage />);
    fireEvent.click(pencil());
    await screen.findByText(/couldn.t open this customer/i);
    fireEvent.click(pencil());
    expect(await screen.findByPlaceholderText(/On file, ending 1234/)).toBeInTheDocument();
    expect(fetchCustomer).toHaveBeenCalledTimes(2);
  });
});
