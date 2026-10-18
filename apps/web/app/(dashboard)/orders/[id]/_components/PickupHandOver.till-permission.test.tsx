import * as React from "react";
import { act, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { PickupHandOverButton } from "./PickupHandOver";

/**
 * BO-07: completing a pickup is a till action. The REAL useCounterSaleGate runs over the mocked API
 * (GET /users/me/permissions): an operator whose admin turned ORDERS off gets no "Picked up" entry.
 */
let mockRole = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: mockRole, tenantSlug: "acme" } }),
  useOptionalAuth: () => ({ user: { id: "u1", role: mockRole, tenantSlug: "acme" } }),
}));
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({ isLoading: false, data: { capabilities: {} } }),
}));
let mockGroups = ["PRICING", "ORDERS", "FINANCE"];
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (...a: unknown[]) => mockGet(...a) },
}));

beforeEach(() => {
  mockRole = "OPERATOR";
  mockGroups = ["PRICING", "ORDERS", "FINANCE"];
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
          : {},
    }),
  );
});

describe("PickupHandOverButton and the operator's till permission", () => {
  it("an operator without ORDERS: no Picked up entry", async () => {
    mockGroups = ["PRICING", "FINANCE"];
    renderWithProviders(<PickupHandOverButton onOpen={jest.fn()} />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/users/me/permissions"));
    await act(async () => {});
    await waitFor(() => expect(screen.queryByRole("button", { name: "Picked up" })).toBeNull());
  });

  it("an operator with ORDERS: the entry is offered", async () => {
    renderWithProviders(<PickupHandOverButton onOpen={jest.fn()} />);
    expect(await screen.findByRole("button", { name: "Picked up" })).toBeInTheDocument();
  });

  it("a tenant admin: the entry is offered and permissions are never asked for", async () => {
    mockRole = "TENANT_ADMIN";
    renderWithProviders(<PickupHandOverButton onOpen={jest.fn()} label="Hand over" />);
    expect(await screen.findByRole("button", { name: "Hand over" })).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalledWith("/users/me/permissions");
  });
});
