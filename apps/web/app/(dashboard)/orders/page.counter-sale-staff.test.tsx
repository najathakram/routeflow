import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import OrdersPage from "./page";

/** W20-L2: the Orders page Counter sale button is staff-only, from the REAL useCounterSaleGate with cached add-on data. */
const push = jest.fn();
const replace = jest.fn();
let search = "";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(search),
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
let role = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role } }),
}));
// Cached answer present for everyone (a shared browser cache); only the role may hide the button.
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: (o?: { enabled?: boolean }) => ({
    data: { capabilities: { fulfilment: { counter: "optional", methods: ["ROUTE"] } } },
    isLoading: false,
    ...o,
  }),
}));
jest.mock("./_components/CreateOrderModal", () => ({
  CreateOrderModal: ({
    isOpen,
    initialFulfillPath,
    resumeDraftId,
  }: {
    isOpen: boolean;
    initialFulfillPath?: string | null;
    resumeDraftId?: string | null;
  }) =>
    isOpen ? (
      <div
        data-testid="order-builder-open"
        data-fulfill={initialFulfillPath ?? ""}
        data-resume={resumeDraftId ?? ""}
      />
    ) : null,
}));

beforeEach(() => {
  jest.clearAllMocks();
  search = "";
  role = "OPERATOR";
});

describe("Orders page — Counter sale button is staff-only (W20-L2)", () => {
  it.each(["OPERATOR", "TENANT_ADMIN"])("%s with cached add-on data: button shown", (r) => {
    role = r;
    renderWithProviders(<OrdersPage />);
    expect(screen.getByRole("button", { name: "Counter sale" })).toBeInTheDocument();
  });
  it.each(["DRIVER", "CUSTOMER"])("%s with cached add-on data: no button", (r) => {
    role = r;
    renderWithProviders(<OrdersPage />);
    expect(screen.queryByRole("button", { name: "Counter sale" })).toBeNull();
  });
});
