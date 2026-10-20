import * as React from "react";
import { act, cleanup, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CommandPalette } from "./CommandPalette";

/**
 * BO-07: the palette's "New counter sale" action follows the REAL useCounterSaleGate, fed by the mocked API
 * (the tenant's capability and GET /users/me/permissions). An operator whose admin turned ORDERS off never sees it.
 */
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
let mockRole = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: mockRole } }),
  useOptionalAuth: () => ({ user: { role: mockRole } }),
}));
let mockGroups = ["PRICING", "ORDERS", "FINANCE"];
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => mockGet(...a) },
}));
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    isLoading: false,
    data: { capabilities: { fulfilment: { counter: "always", methods: ["PICKUP"] } } },
  }),
}));
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: true }),
  useDeliveryAccess: () => ({ enabled: true }),
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
afterEach(cleanup);

describe("CommandPalette counter action and the operator's till permission", () => {
  it("an operator without ORDERS never sees New counter sale", async () => {
    mockGroups = ["PRICING", "FINANCE"];
    renderWithProviders(<CommandPalette open onClose={() => {}} />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/users/me/permissions"));
    await act(async () => {}); // let the answer land: the entry must stay absent after it
    expect(screen.queryByText("New counter sale")).toBeNull();
    expect(screen.getByText("New Order")).toBeInTheDocument();
  });

  it("an operator with ORDERS sees it", async () => {
    renderWithProviders(<CommandPalette open onClose={() => {}} />);
    expect(await screen.findByText("New counter sale")).toBeInTheDocument();
  });

  it("an admin sees it and never asks for permissions", async () => {
    mockRole = "TENANT_ADMIN";
    renderWithProviders(<CommandPalette open onClose={() => {}} />);
    expect(await screen.findByText("New counter sale")).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalledWith("/users/me/permissions");
  });
});
