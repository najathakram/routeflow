import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import OrdersPage from "./page";

/**
 * REG-B1 (owner option A): a CUSTOMER session cannot start an order from the staff Orders page. New order, the empty-state
 * Create order and the ?action=new URL intent are all absent for it, and the builder never opens. Harness as
 * page.new-order-menu.test.tsx (real counter-sale gate over mocked capability and permissions).
 */
const push = jest.fn();
const replace = jest.fn();
let search = "";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(search),
}));
let mockRole = "OPERATOR";
let mockRows: unknown[] = [];
let mockDelivery = false;
const orderRow = (id: string, n: number) => ({
  id,
  orderNumber: `ORD-${n}`,
  status: "PENDING",
  urgent: false,
  total: 100,
  createdAt: "2026-10-01T00:00:00.000Z",
  requestedDeliveryDate: null,
  customer: { businessName: `Acme ${n}` },
  lineItems: [],
});
jest.mock("@/lib/auth-context", () => {
  const actual = jest.requireActual("@/lib/auth-context");
  return {
    ...actual,
    useAuth: () => ({ ...actual.useAuth(), user: { id: "u1", role: mockRole } }),
    useOptionalAuth: () => ({ user: { id: "u1", role: mockRole } }),
  };
});
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useOrders: () => ({
    data: { data: mockRows, meta: { total: mockRows.length, page: 1, limit: 20, totalPages: 1 } },
    isLoading: false,
    isError: false,
  }),
  useUpdateOrderStatus: () => ({ mutate: jest.fn(), isPending: false }),
  useBulkDeleteOrders: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useDeliveryAccess: () => ({ enabled: mockDelivery, resolved: true }),
}));
jest.mock("@/lib/tenant-features", () => ({
  ...jest.requireActual("@/lib/tenant-features"),
  useTenantFeatures: () => ({
    fetchStatus: "idle",
    isFetching: false,
    isLoading: false,
    data: {
      capabilities: {
        fulfilment: {
          portalMethods: [],
          portalDefault: null,
          fleet: true,
          consistent: true,
          methods: ["PICKUP", "SHIP"],
          staffDefault: "PICKUP",
          counter: "off",
          staffOpensAs: "order",
        },
      },
    },
  }),
}));
jest.mock("@/lib/api/my-permissions", () => ({
  ...jest.requireActual("@/lib/api/my-permissions"),
  useMyPermissions: () => ({
    isLoading: false,
    data: { groups: ["PRICING", "ORDERS", "FINANCE"] },
  }),
}));
jest.mock("./_components/CreateOrderModal", () => ({
  CreateOrderModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? (
      <div role="dialog" aria-label="New order" data-testid="order-builder-open">
        <h2>New order</h2>
      </div>
    ) : null,
}));

const startButtons = () => {
  const names = screen
    .queryAllByRole("button")
    .map((b) => b.textContent?.trim())
    .filter((t) => t === "New order" || t === "Create order");
  return { label: "New order / Create order buttons", count: names.length };
};

beforeEach(() => {
  jest.clearAllMocks();
  search = "";
  mockRole = "OPERATOR";
  mockRows = [];
  mockDelivery = false;
  replace.mockImplementation((url: string) => {
    search = url.split("?")[1] ?? "";
  });
});

const selectAll = () => {
  mockRows = [orderRow("o1", 1), orderRow("o2", 2)];
  mockDelivery = true;
  renderWithProviders(<OrdersPage />);
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.click(screen.getAllByRole("checkbox")[0]);
};
const bulkCount = (name: RegExp) => screen.queryAllByRole("button", { name }).length;

describe("REG-B1 orders bulk bar by role", () => {
  it("REG-B1 a CUSTOMER selecting orders sees Cancel but no Delete, Plan delivery or batch ship", () => {
    mockRole = "CUSTOMER";
    selectAll();
    expect({ label: "Cancel 2", count: bulkCount(/^Cancel 2$/) }).toEqual({
      label: "Cancel 2",
      count: 1,
    });
    for (const [label, name] of [
      ["Delete 2", /^Delete 2$/],
      ["Plan delivery", /^Plan delivery$/],
      ["Mark shipped", /^Mark shipped/],
      ["Print packing slips", /^Print packing slips$/],
    ] as const) {
      expect({ label, count: bulkCount(name) }).toEqual({ label, count: 0 });
    }
  });

  it("REG-B1 an OPERATOR twin sees Delete and Plan delivery", () => {
    selectAll();
    expect({ label: "Delete 2", count: bulkCount(/^Delete 2$/) >= 1 }).toEqual({
      label: "Delete 2",
      count: true,
    });
    expect({ label: "Mark shipped", count: bulkCount(/^Mark shipped/) >= 1 }).toEqual({
      label: "Mark shipped",
      count: true,
    });
    expect({
      label: "Print packing slips",
      count: bulkCount(/^Print packing slips$/) >= 1,
    }).toEqual({
      label: "Print packing slips",
      count: true,
    });
    expect({ label: "Plan delivery", count: bulkCount(/^Plan delivery$/) >= 1 }).toEqual({
      label: "Plan delivery",
      count: true,
    });
  });
});

describe("REG-B1 orders page by role", () => {
  it("REG-B1 a CUSTOMER sees no New order or Create order button", () => {
    mockRole = "CUSTOMER";
    renderWithProviders(<OrdersPage />);
    expect(screen.getByText("No orders yet")).toBeInTheDocument();
    expect(startButtons()).toEqual({ label: "New order / Create order buttons", count: 0 });
    expect(screen.queryByText(/on behalf of a customer/)).toBeNull();
  });

  it("REG-B1 a CUSTOMER with ?action=new gets no builder dialog", async () => {
    mockRole = "CUSTOMER";
    search = "action=new";
    renderWithProviders(<OrdersPage />);
    await new Promise((r) => setTimeout(r, 50));
    expect({
      dialogs: screen.queryAllByRole("dialog").length,
      heading: screen.queryAllByRole("heading", { name: "New order" }).length,
    }).toEqual({ dialogs: 0, heading: 0 });
  });

  it("REG-B1 an OPERATOR twin keeps the buttons and ?action=new opens the builder", async () => {
    renderWithProviders(<OrdersPage />);
    expect(startButtons().count).toBeGreaterThanOrEqual(1);

    search = "action=new";
    renderWithProviders(<OrdersPage />);
    await waitFor(() => expect(screen.getAllByRole("dialog").length).toBeGreaterThanOrEqual(1));
  });
});
