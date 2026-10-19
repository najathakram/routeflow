import * as React from "react";
import { renderWithProviders, screen, waitFor, act, fireEvent } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";
import { apiClient } from "@/lib/api-client";

/**
 * BO-07: the POS mode switch follows the operator's till permission. The REAL useCounterSaleGate runs over the
 * mocked API (GET /users/me/permissions): an operator whose admin turned ORDERS off sees no switch, and a stored
 * posMode=true preference never turns the builder into a PICKUP order for them.
 */
window.HTMLElement.prototype.scrollIntoView = jest.fn();

let mockPrefs: Record<string, string> = {};
let mockGroups = ["PRICING", "ORDERS", "FINANCE"];
let mockRole: string = "OPERATOR";
jest.mock("@/lib/auth-context", () => {
  const actual = jest.requireActual("@/lib/auth-context");
  return {
    ...actual,
    useAuth: () => ({ ...actual.useAuth(), user: { id: "u1", role: mockRole } }),
    useOptionalAuth: () => ({ user: { id: "u1", role: mockRole, tenantSlug: "acme" } }),
  };
});
let mockActive: unknown = undefined;
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({
    data: { data: [{ id: "c1", businessName: "Acme Foods", pricingTier: 2 }] },
  }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
const mockActiveHook = jest.fn((..._a: unknown[]) => ({ data: mockActive }));
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useActiveOrderForCustomer: (...a: unknown[]) => mockActiveHook(...a),
  useCustomerPriceHistory: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useUpdateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useDeleteDraft: () => ({ mutate: jest.fn() }),
  useDraft: () => ({ data: undefined, isFetching: false }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useScanV2: () => false,
  useOrderUiV2: () => ({ enabled: false, resolved: true }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
let capturedOnScan: ((code: string) => void) | undefined;
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: { onScan: (c: string) => void }) => {
    capturedOnScan = props.onScan;
    return <button type="button">scan</button>;
  },
}));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
const mockResolve = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (c: string) => mockResolve(c),
}));
const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));

const get = apiClient.get as jest.Mock;
const post = apiClient.post as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockPrefs = {};
  mockRole = "OPERATOR";
  mockActive = undefined;
  mockGroups = ["PRICING", "ORDERS", "FINANCE"];
  get.mockImplementation((url: string) =>
    Promise.resolve({
      data:
        url === "/users/me/preferences"
          ? mockPrefs
          : url === "/users/me/permissions"
            ? {
                role: mockRole,
                isAccountAdmin: false,
                groups: mockGroups,
                version: 1,
                mode: "shadow",
              }
            : { taxRate: 0 },
    }),
  );
  post.mockResolvedValue({ data: [] });
  localStorage.clear();
});

describe("CreateOrderModal: POS mode switch and the operator's till permission", () => {
  it("an operator without ORDERS: no switch, even with a stored posMode=true", async () => {
    mockGroups = ["PRICING", "FINANCE"];
    mockPrefs = { "orders.posMode": "true" };
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/users/me/permissions"));
    await waitFor(() =>
      expect(screen.queryByRole("switch", { name: /pos mode/i })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Confirm and invoice" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^create order$/i })).toBeInTheDocument();
  });

  it("while the permissions read is pending: no switch, and a stored posMode=true is not applied", async () => {
    mockPrefs = { "orders.posMode": "true" };
    get.mockImplementation((url: string) =>
      url === "/users/me/permissions"
        ? new Promise(() => undefined)
        : Promise.resolve({ data: url === "/users/me/preferences" ? mockPrefs : { taxRate: 0 } }),
    );
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/users/me/permissions"));
    await act(async () => {});
    expect(screen.queryByRole("switch", { name: /pos mode/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm and invoice" })).not.toBeInTheDocument();
  });

  it("when the permissions read fails: no switch, and a stored posMode=true is not applied", async () => {
    mockPrefs = { "orders.posMode": "true" };
    get.mockImplementation((url: string) =>
      url === "/users/me/permissions"
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ data: url === "/users/me/preferences" ? mockPrefs : { taxRate: 0 } }),
    );
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/users/me/permissions"));
    await act(async () => {});
    expect(screen.queryByRole("switch", { name: /pos mode/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm and invoice" })).not.toBeInTheDocument();
  });

  it("an operator with ORDERS: the switch is offered", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(await screen.findByRole("switch", { name: /pos mode/i })).toBeInTheDocument();
  });

  it("a tenant admin: the switch is offered and permissions are never asked for", async () => {
    mockRole = "TENANT_ADMIN";
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(await screen.findByRole("switch", { name: /pos mode/i })).toBeInTheDocument();
    expect(get).not.toHaveBeenCalledWith("/users/me/permissions");
  });
});
