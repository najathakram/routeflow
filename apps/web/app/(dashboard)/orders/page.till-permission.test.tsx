import * as React from "react";
import { act, fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import OrdersPage from "./page";

/**
 * BO-07: the Orders header follows the till permission. The REAL useCounterSaleGate runs over the mocked API
 * (the capability and GET /users/me/permissions); an operator whose admin turned ORDERS off gets neither the
 * Counter sale button nor a "New Order" that opens as the counter.
 */
const push = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: jest.fn() }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(""),
}));
let mockRole = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: mockRole, tenantSlug: "acme" } }),
  useOptionalAuth: () => ({ user: { id: "u1", role: mockRole, tenantSlug: "acme" } }),
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
let mockCounter = "optional";
let mockMethods: string[] = ["PICKUP", "ROUTE"];
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    isLoading: false,
    data: {
      capabilities: { fulfilment: { counter: mockCounter, methods: mockMethods } },
    },
  }),
}));
let mockGroups = ["PRICING", "ORDERS", "FINANCE"];
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (...a: unknown[]) => mockGet(...a) },
}));
jest.mock("./_components/CreateOrderModal", () => ({
  CreateOrderModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="order-builder-open" /> : null,
}));

beforeEach(() => {
  mockRole = "OPERATOR";
  mockCounter = "optional";
  mockMethods = ["PICKUP", "ROUTE"];
  mockGroups = ["PRICING", "ORDERS", "FINANCE"];
  push.mockReset();
  mockGet.mockReset();
  mockGet.mockImplementation((url: string) =>
    Promise.resolve({
      data:
        url === "/users/me/permissions"
          ? {
              role: mockRole,
              isAccountAdmin: false,
              groups: mockGroups,
              version: 1,
              mode: "shadow",
            }
          : { data: [], meta: { total: 0 } },
    }),
  );
});

describe("Orders header and the operator's till permission", () => {
  it("an operator without ORDERS: no Counter sale button", async () => {
    mockGroups = ["PRICING", "FINANCE"];
    renderWithProviders(<OrdersPage />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/users/me/permissions"));
    await act(async () => {}); // the answer has landed: the entry must still be absent
    expect(screen.queryByRole("button", { name: "Counter sale" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Counter sale" })).toBeNull();
  });

  it("an operator with ORDERS: Counter sale is offered and goes to the counter", async () => {
    renderWithProviders(<OrdersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Counter sale" }));
    expect(push).toHaveBeenCalledWith("/orders/counter-sale");
  });

  it("an operator without ORDERS on a counter-first tenant: New Order opens the builder, not the counter", async () => {
    mockCounter = "always";
    mockGroups = ["PRICING", "FINANCE"];
    renderWithProviders(<OrdersPage />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/users/me/permissions"));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "New Order" }));
    expect(screen.getByTestId("order-builder-open")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  describe("a store-only account's Invoice a customer entry (the builder's PICKUP path)", () => {
    beforeEach(() => {
      mockCounter = "always";
      mockMethods = ["PICKUP"];
    });

    it("an operator without ORDERS: no Invoice a customer", async () => {
      mockGroups = ["PRICING", "FINANCE"];
      renderWithProviders(<OrdersPage />);
      await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/users/me/permissions"));
      await act(async () => {});
      // the entry is offered until the answer lands, then withdrawn
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Invoice a customer" })).toBeNull(),
      );
    });

    it("an operator with ORDERS: Invoice a customer opens the builder", async () => {
      renderWithProviders(<OrdersPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Invoice a customer" }));
      expect(screen.getByTestId("order-builder-open")).toBeInTheDocument();
    });

    it("a tenant admin: Invoice a customer is offered", async () => {
      mockRole = "TENANT_ADMIN";
      renderWithProviders(<OrdersPage />);
      expect(await screen.findByRole("button", { name: "Invoice a customer" })).toBeInTheDocument();
    });
  });

  it("a tenant admin never asks for permissions", async () => {
    mockRole = "TENANT_ADMIN";
    renderWithProviders(<OrdersPage />);
    await act(async () => {});
    expect(mockGet).not.toHaveBeenCalledWith("/users/me/permissions");
  });
});
