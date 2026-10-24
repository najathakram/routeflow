import * as React from "react";
import { act, renderWithProviders, screen } from "@/test-utils/render";
import { QUICK_KEYS_QUERY_KEY } from "@/lib/api/counter-quick-keys";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * BO-07: the Counter screen reached by URL. The REAL useCounterSaleGate runs over the mocked API (the capability and
 * GET /users/me/permissions). An operator whose admin turned ORDERS off gets a plain no-access panel (never the sale UI,
 * never a toast); a PERMISSION_DENIED from any till call re-reads the permissions and lands on the same panel.
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: mockRole, tenantSlug: "acme" } }),
  useOptionalAuth: () => ({ user: { id: "u1", role: mockRole, tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    isLoading: false,
    data: { capabilities: { fulfilment: { counter: "always", methods: ["PICKUP"] } } },
  }),
}));
const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast, success: toast, error: toast }),
}));

let mockRole = "OPERATOR";
let mockGroups = ["PRICING", "ORDERS", "FINANCE"];
let quickKeysDenied = false;
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => mockGet(...a), post: jest.fn() },
}));

const NO_ACCESS = "Your admin hasn't turned on selling for your account.";
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  mockRole = "OPERATOR";
  mockGroups = ["PRICING", "ORDERS", "FINANCE"];
  quickKeysDenied = false;
  toast.mockReset();
  mockGet.mockReset();
  mockGet.mockImplementation((url: string) => {
    if (url === "/users/me/permissions")
      return Promise.resolve({
        data: {
          role: mockRole,
          isAccountAdmin: false,
          groups: mockGroups,
          version: 1,
          mode: "shadow",
        },
      });
    if (url === "/orders/counter-sale/quick-keys" && quickKeysDenied)
      return Promise.reject({
        response: { status: 403, data: { code: "PERMISSION_DENIED", groups: ["ORDERS"] } },
      });
    return Promise.resolve({ data: { taxRate: 0 } });
  });
});

describe("Counter screen and the operator's till permission", () => {
  it("an operator without ORDERS: the no-access panel, no sale UI, no toast", async () => {
    mockGroups = ["PRICING", "FINANCE"];
    renderWithProviders(<CounterSaleScreen />);
    expect(await screen.findByText(NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByLabelText("Scan or search items")).toBeNull();
    expect(screen.queryByText("Counter sales are not turned on for this business.")).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it("an operator with ORDERS: the sale UI", async () => {
    renderWithProviders(<CounterSaleScreen />);
    expect(await screen.findByLabelText("Scan or search items")).toBeInTheDocument();
    expect(screen.queryByText(NO_ACCESS)).toBeNull();
  });

  it("a tenant admin: the sale UI, and permissions are never asked for", async () => {
    mockRole = "TENANT_ADMIN";
    renderWithProviders(<CounterSaleScreen />);
    expect(await screen.findByLabelText("Scan or search items")).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalledWith("/users/me/permissions");
  });

  it("a PERMISSION_DENIED from a till call re-reads the permissions and shows the panel, not a toast", async () => {
    const { queryClient } = renderWithProviders(<CounterSaleScreen />);
    expect(await screen.findByLabelText("Scan or search items")).toBeInTheDocument();
    // The admin switches ORDERS off mid-shift; the next till call comes back PERMISSION_DENIED.
    mockGroups = ["PRICING", "FINANCE"];
    quickKeysDenied = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: [QUICK_KEYS_QUERY_KEY] });
    });
    expect(await screen.findByText(NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByLabelText("Scan or search items")).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });
});
