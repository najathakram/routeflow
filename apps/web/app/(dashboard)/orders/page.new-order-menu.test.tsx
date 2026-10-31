import * as React from "react";
import userEvent from "@testing-library/user-event";
import { ReadOnlyGateProvider } from "@/lib/read-only-gate";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import OrdersPage from "./page";

/**
 * W-854 (SA-940 MUSTs 1 to 4, A-1): one New order on the Orders header, for every business, and the URL intent waits for
 * the gate. The gate here is the REAL `useCounterSaleGate` over a mocked capability and a mocked permissions read, so
 * these rows read the same on the old header and the new one.
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
type Features = { isLoading: boolean; data?: unknown; isError?: boolean };
let features: Features = { isLoading: true };
jest.mock("@/lib/tenant-features", () => ({
  ...jest.requireActual("@/lib/tenant-features"),
  useTenantFeatures: () => ({ fetchStatus: "idle", isFetching: false, ...features }),
}));
type Perms = { isLoading: boolean; data?: unknown };
const ALLOWED = { isLoading: false, data: { groups: ["PRICING", "ORDERS", "FINANCE"] } };
let perms: Perms = ALLOWED;
jest.mock("@/lib/api/my-permissions", () => ({
  ...jest.requireActual("@/lib/api/my-permissions"),
  useMyPermissions: () => perms,
}));
jest.mock("./_components/CreateOrderModal", () => ({
  CreateOrderModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="order-builder-open" /> : null,
}));

const CAP = {
  portalMethods: [],
  portalDefault: null,
  fleet: true,
  consistent: true,
};
const PICKUP_SHIP = {
  ...CAP,
  methods: ["PICKUP", "SHIP"],
  staffDefault: "PICKUP",
  counter: "always",
  staffOpensAs: "counter",
};
const STORE_ONLY = {
  ...CAP,
  methods: ["PICKUP"],
  staffDefault: "PICKUP",
  counter: "always",
  staffOpensAs: "counter",
};
const OPTIONAL = {
  ...CAP,
  methods: ["ROUTE", "SHIP"],
  staffDefault: "ROUTE",
  counter: "optional",
  staffOpensAs: "order",
};
const NO_COUNTER = { ...OPTIONAL, counter: "off" };
const loaded = (fulfilment: unknown): Features => ({
  isLoading: false,
  data: { capabilities: { fulfilment } },
});
const DENIED = { isLoading: false, data: { groups: ["PRICING", "FINANCE"] } };

const newOrder = () => screen.queryByRole("button", { name: "New order" });
const saleButtons = () =>
  screen
    .queryAllByRole("button")
    .map((b) => b.textContent?.trim())
    .filter((t) => t === "New order" || t === "Counter sale" || t === "Invoice a customer");
const menuWords = () =>
  screen.getAllByRole("menuitem").map((item) => item.querySelector("span")?.textContent);

beforeEach(() => {
  jest.clearAllMocks();
  search = "";
  mockRole = "OPERATOR";
  features = loaded(OPTIONAL);
  perms = ALLOWED;
  // The URL follows the page's own replace, as it does in a browser.
  replace.mockImplementation((url: string) => {
    search = url.split("?")[1] ?? "";
  });
});

describe("Orders header: one New order", () => {
  it("a pickup and ship business has one button, and the menu lists Counter sale first", async () => {
    features = loaded(PICKUP_SHIP);
    renderWithProviders(<OrdersPage />);
    expect(saleButtons()).toEqual(["New order"]);
    await userEvent.setup().click(newOrder()!);
    expect(await screen.findAllByRole("menuitem")).toHaveLength(2);
    expect(menuWords()).toEqual(["Counter sale", "Regular order"]);
  });

  it("an optional counter has one button, and the menu lists Regular order first", async () => {
    features = loaded(OPTIONAL);
    renderWithProviders(<OrdersPage />);
    expect(saleButtons()).toEqual(["New order"]);
    await userEvent.setup().click(newOrder()!);
    expect(await screen.findAllByRole("menuitem")).toHaveLength(2);
    expect(menuWords()).toEqual(["Regular order", "Counter sale"]);
  });

  it("a store-only business has one button and the menu, and Regular order opens the builder", async () => {
    features = loaded(STORE_ONLY);
    renderWithProviders(<OrdersPage />);
    expect(saleButtons()).toEqual(["New order"]);
    const user = userEvent.setup();
    await user.click(newOrder()!);
    await user.click(await screen.findByRole("menuitem", { name: /regular order/i }));
    expect(screen.getByTestId("order-builder-open")).toBeInTheDocument();
  });

  it("the default answers with Enter after a mouse open", async () => {
    features = loaded(PICKUP_SHIP);
    renderWithProviders(<OrdersPage />);
    const user = userEvent.setup();
    await user.click(newOrder()!);
    await screen.findAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]));
    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/orders/counter-sale");
  });

  it("Esc closes the menu and starts nothing", async () => {
    features = loaded(OPTIONAL);
    renderWithProviders(<OrdersPage />);
    const user = userEvent.setup();
    await user.click(newOrder()!);
    await screen.findAllByRole("menuitem");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByTestId("order-builder-open")).toBeNull();
  });

  it("guard: no counter opens the builder with no menu", async () => {
    features = loaded(NO_COUNTER);
    renderWithProviders(<OrdersPage />);
    await userEvent.setup().click(newOrder()!);
    expect(screen.getByTestId("order-builder-open")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("guard: an operator denied the till on a delivery business opens the builder with no menu", async () => {
    features = loaded(OPTIONAL);
    perms = DENIED;
    renderWithProviders(<OrdersPage />);
    expect(saleButtons()).toEqual(["New order"]);
    await userEvent.setup().click(newOrder()!);
    expect(screen.getByTestId("order-builder-open")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("guard: a store-only operator denied the till has no sale control", () => {
    features = loaded(STORE_ONLY);
    perms = DENIED;
    renderWithProviders(<OrdersPage />);
    expect(saleButtons()).toEqual([]);
  });

  it("guard: store-only with permissions unknown has no sale control", () => {
    features = loaded(STORE_ONLY);
    perms = { isLoading: false, data: undefined };
    renderWithProviders(<OrdersPage />);
    expect(saleButtons()).not.toContain("Invoice a customer");
    expect(saleButtons()).not.toContain("New order");
  });

  it("a read-only menu business has a disabled button", () => {
    features = loaded(OPTIONAL);
    renderWithProviders(
      <ReadOnlyGateProvider view={{ status: "READ_ONLY" } as never}>
        <OrdersPage />
      </ReadOnlyGateProvider>,
    );
    expect(newOrder()).toBeDisabled();
  });
});

describe("Orders page: ?action=new waits for the gate", () => {
  it("cold, counter first, the gate answers after the first render: the menu opens, the builder doesn't", async () => {
    search = "action=new";
    features = { isLoading: true };
    const view = renderWithProviders(<OrdersPage />);
    features = loaded(PICKUP_SHIP);
    view.rerender(<OrdersPage />);
    expect(await screen.findAllByRole("menuitem")).toHaveLength(2);
    expect(menuWords()).toEqual(["Counter sale", "Regular order"]);
    expect(screen.queryByTestId("order-builder-open")).toBeNull();
  });

  it("while the gate is out the params stay and nothing opens", () => {
    search = "action=new";
    features = { isLoading: true };
    renderWithProviders(<OrdersPage />);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId("order-builder-open")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(newOrder()).toBeDisabled();
  });

  it("the params go once the menu is open, so a refresh doesn't reopen it", async () => {
    search = "action=new&page=2";
    features = loaded(OPTIONAL);
    renderWithProviders(<OrdersPage />);
    await screen.findAllByRole("menuitem");
    expect(replace).toHaveBeenCalled();
  });

  it("guard: builder=1 opens the builder at once, even with the gate out", () => {
    search = "action=new&builder=1";
    features = { isLoading: true };
    renderWithProviders(<OrdersPage />);
    expect(screen.getByTestId("order-builder-open")).toBeInTheDocument();
  });

  it("guard: ship=1 opens the builder at once", () => {
    search = "action=new&ship=1";
    features = loaded(PICKUP_SHIP);
    renderWithProviders(<OrdersPage />);
    expect(screen.getByTestId("order-builder-open")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("guard: resumeDraft opens the builder at once", () => {
    search = "resumeDraft=d1";
    features = { isLoading: true };
    renderWithProviders(<OrdersPage />);
    expect(screen.getByTestId("order-builder-open")).toBeInTheDocument();
  });

  it("no counter: ?action=new opens the builder", () => {
    search = "action=new";
    features = loaded(NO_COUNTER);
    renderWithProviders(<OrdersPage />);
    expect(screen.getByTestId("order-builder-open")).toBeInTheDocument();
  });

  it("store-only and denied: the params go and nothing opens", async () => {
    search = "action=new";
    features = loaded(STORE_ONLY);
    perms = DENIED;
    renderWithProviders(<OrdersPage />);
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(screen.queryByTestId("order-builder-open")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("a read-only menu business: the params go and nothing opens", async () => {
    search = "action=new";
    features = loaded(OPTIONAL);
    renderWithProviders(
      <ReadOnlyGateProvider view={{ status: "READ_ONLY" } as never}>
        <OrdersPage />
      </ReadOnlyGateProvider>,
    );
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(screen.queryByTestId("order-builder-open")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
