import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { SettingsHub } from "./SettingsHub";

/**
 * BO-07: the settings finder lists the Counter rows (quick keys, day close, open the Counter) only for someone who may
 * use the till. The REAL useCounterSaleGate runs over the mocked API (the capability and GET /users/me/permissions).
 */
let mockRole = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: mockRole, tenantSlug: "acme" } }),
  useOptionalAuth: () => ({ user: { id: "u1", role: mockRole, tenantSlug: "acme" } }),
}));
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    isLoading: false,
    data: { capabilities: { fulfilment: { counter: "always", methods: ["PICKUP"] } } },
  }),
}));
let mockGroups = ["PRICING", "ORDERS", "FINANCE"];
const get = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    post: jest.fn(),
    patch: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("./RouteDefaultsCard", () => ({
  RouteDefaultsCard: () => <div>route-defaults-card</div>,
}));
jest.mock("./BuyerOversellCard", () => ({ BuyerOversellCard: () => <div>oversell-card</div> }));

beforeEach(() => {
  mockRole = "OPERATOR";
  mockGroups = ["PRICING", "ORDERS", "FINANCE"];
  get.mockReset();
  get.mockImplementation((url: string) =>
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
          : undefined,
    }),
  );
});

describe("Settings finder and the operator's till permission", () => {
  it("an operator without ORDERS: a search for quick keys finds nothing", async () => {
    mockGroups = ["PRICING", "FINANCE"];
    const user = userEvent.setup();
    renderWithProviders(<SettingsHub isAdmin={false} />);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/users/me/permissions"));
    await act(async () => {});
    await user.type(screen.getByLabelText("Search settings"), "quick keys");
    expect(screen.getByText("No settings match “quick keys”.")).toBeInTheDocument();
  });

  it("an operator with ORDERS: the Counter quick keys row is found", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsHub isAdmin={false} />);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/users/me/permissions"));
    await act(async () => {});
    await user.type(screen.getByLabelText("Search settings"), "quick keys");
    expect(await screen.findByText("How you sell › Counter quick keys")).toBeInTheDocument();
  });

  it("a tenant admin never asks for permissions", async () => {
    mockRole = "TENANT_ADMIN";
    renderWithProviders(<SettingsHub isAdmin />);
    await act(async () => {});
    expect(get).not.toHaveBeenCalledWith("/users/me/permissions");
  });
});
