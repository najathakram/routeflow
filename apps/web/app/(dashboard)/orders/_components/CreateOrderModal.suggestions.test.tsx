import * as React from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * Staff New Order: "Usually buys" chips + "Order again" for the selected customer. Every line they
 * add goes through the modal's normal add-line path, exactly like a manual add, so it is priced by
 * today's normal pricing (the customer's tier / special price and the usual last-given pre-fill) —
 * never the price an old order paid.
 */

window.HTMLElement.prototype.scrollIntoView = jest.fn();

const acme = { id: "c1", businessName: "Acme Foods", pricingTier: 2 };

const product = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  name: `Product ${id}`,
  variantName: null,
  parentProductId: null,
  parent: null,
  unit: "each",
  unitsPerBox: null,
  pricePerUnit: 5,
  priceTier2: 4.5,
  priceTier3: 4,
  priceTier4: 3.5,
  priceTier5: 3,
  averageCost: null,
  category: null,
  trackedCategoryId: null,
  isActive: true,
  ...o,
});

const cola = product("p1", { name: "Sample Cola" });
const chips = product("p2", {
  name: "Sample Chips",
  unit: "case",
  unitsPerBox: 12,
  pricePerUnit: 30,
  priceTier2: 27,
});
const retired = product("p3", { name: "Retired Gum", isActive: false });
const soda = product("p4", { name: "Sample Soda", pricePerUnit: 10, priceTier2: 8 });

const oldOrder = (id: string, lines: unknown[]) => ({
  id,
  orderNumber: `ORD-${id}`,
  date: "2026-09-28T00:00:00.000Z",
  status: "DELIVERED",
  lines,
});
const ol = (productId: string, o: Record<string, unknown> = {}) => ({
  productId,
  qty: 1,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  ...o,
});

let mockSuggestions: unknown;
let mockTier = 2; // tier 1 = no special price, so the last-given pre-fill applies (as for a manual add)
let mockLastGiven: Record<string, { lastPrice: number }> | undefined;
const mockApiGet = jest.fn();
const mockFetchUnits = jest.fn();

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [{ ...acme, pricingTier: mockTier }] } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
  useActiveOrderForCustomer: () => ({ data: undefined }),
  // The customer's remembered last-given prices: a manual add pre-fills from it, and so do suggestions.
  useCustomerPriceHistory: () => ({ data: mockLastGiven }),
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
  useOrderUiV2: () => ({ enabled: true, resolved: true }),
  useScanV2: () => false,
}));
jest.mock("@/lib/api/product-units", () => ({
  UNITS_FLAG: "flag.units_v1",
  useUnitsEnabled: () => false,
  useProductUnits: () => ({ data: undefined }),
  productUnitsKey: (id: string) => ["products", id, "units"],
  fetchProductUnits: (id: string) => mockFetchUnits(id),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (url: string) => mockApiGet(url),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: ({ title }: { title?: string }) => (
    <button type="button" title={title}>
      scan
    </button>
  ),
}));
jest.mock("./scan/ScanOrderScreen", () => ({ ScanOrderScreen: () => null }));
jest.mock("@/lib/barcode-resolve", () => ({ resolveProductByCode: jest.fn() }));

const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));

const lineFor = (name: string) =>
  screen
    .getAllByText(name)
    .map((el) => el.closest("li"))
    .find((li) => li?.querySelector('[title="Remove"]')) as HTMLElement;

const openWithCustomer = async () => {
  renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
  fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
    target: { value: "Acm" },
  });
  fireEvent.click(await screen.findByText("Acme Foods"));
  await screen.findByTestId("order-suggestions");
};

const suggestions = (o: Record<string, unknown> = {}) => ({
  customerId: "c1",
  usuallyBuys: [
    { productId: "p1", orderLineCount: 9 },
    { productId: "p2", orderLineCount: 4 },
  ],
  recentOrders: [
    oldOrder("o1", [
      ol("p1", { qty: 3 }),
      ol("p2", { qty: 30, boxes: 2, pieces: 6, unitsPerBox: 12 }),
      ol("p3", { qty: 2 }),
    ]),
    oldOrder("o2", [ol("p4", { qty: 5 })]),
  ],
  products: { p1: cola, p2: chips, p3: retired, p4: soda },
  ...o,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSuggestions = suggestions();
  mockLastGiven = undefined;
  mockTier = 2;
  mockApiGet.mockImplementation((url: string) =>
    url === "/customers/c1/order-suggestions"
      ? Promise.resolve({ data: mockSuggestions })
      : Promise.resolve({ data: { taxRate: 0 } }),
  );
});

describe("Usually buys chips", () => {
  it("shows nothing before a customer is chosen and never asks the server", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(screen.queryByTestId("order-suggestions")).not.toBeInTheDocument();
    expect(mockApiGet).not.toHaveBeenCalledWith(expect.stringContaining("order-suggestions"));
  });

  it("lists the usually-bought products under the customer and hides retired ones", async () => {
    mockSuggestions = suggestions({
      usuallyBuys: [
        { productId: "p1", orderLineCount: 9 },
        { productId: "p3", orderLineCount: 5 },
      ],
    });
    await openWithCustomer();
    const bar = screen.getByTestId("order-suggestions");
    expect(within(bar).getByText("Usually buys")).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: /Sample Cola/ })).toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: /Retired Gum/ })).not.toBeInTheDocument();
  });

  const tapCola = () =>
    fireEvent.click(
      within(screen.getByTestId("order-suggestions")).getByRole("button", { name: /Sample Cola/ }),
    );

  it("a tap adds a line at TODAY's tier price", async () => {
    await openWithCustomer();
    tapCola();
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    await waitFor(() => expect(lineFor("Sample Cola").textContent).toContain("$4.50"));
  });

  it("a tap behaves exactly like a manual add: the customer's last-given price pre-fills the same way", async () => {
    mockLastGiven = { p1: { lastPrice: 1 } };
    mockTier = 1;
    await openWithCustomer();
    tapCola();
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    await waitFor(() => expect(lineFor("Sample Cola").textContent).toContain("$1.00"));
  });

  it("a second tap merges into the same line (the picker's rule), never a duplicate", async () => {
    await openWithCustomer();
    const chip = () =>
      within(screen.getByTestId("order-suggestions")).getByRole("button", { name: /Sample Cola/ });
    fireEvent.click(chip());
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    fireEvent.click(chip());
    await waitFor(() => expect(screen.getAllByTitle("Remove")).toHaveLength(1));
  });
});

describe("Order again", () => {
  const pickOrder = async (label: RegExp) => {
    // The menu stays open after a cancelled confirm: only open it when it is closed.
    if (!screen.queryByRole("list", { name: "Choose a recent order" })) {
      fireEvent.click(screen.getByRole("button", { name: "Order again" }));
    }
    const menu = await screen.findByRole("list", { name: "Choose a recent order" });
    fireEvent.click(within(menu).getByRole("button", { name: label }));
  };

  it("lists the recent orders by number, date and lines", async () => {
    await openWithCustomer();
    fireEvent.click(screen.getByRole("button", { name: "Order again" }));
    const menu = await screen.findByRole("list", { name: "Choose a recent order" });
    expect(within(menu).getAllByRole("button")).toHaveLength(2);
    expect(within(menu).getByText(/ORD-o1/)).toBeInTheDocument();
    expect(within(menu).getByText(/Sample Cola × 3/)).toBeInTheDocument();
  });

  it("adds that order's lines as ordered, re-priced today (not what the old order paid)", async () => {
    await openWithCustomer();
    await pickOrder(/ORD-o1/);

    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    expect(
      (lineFor("Sample Cola").querySelector('input[aria-label="Quantity"]') as HTMLInputElement)
        .value,
    ).toBe("3");
    expect(lineFor("Sample Cola").textContent).toContain("$4.50");

    // boxed: 2 cases + 6 loose = 30 pieces, at today's tier-2 case price
    await waitFor(() => expect(lineFor("Sample Chips")).toBeTruthy());
    expect((screen.getByTitle("Number of whole cases") as HTMLInputElement).value).toBe("2");
    expect(lineFor("Sample Chips").textContent).toContain("30 pcs total");
    expect(lineFor("Sample Chips").textContent).toContain("$27.00");
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Added 2 lines from ORD-o1" }),
    );
  });

  it("prices through the same path as a manual add, including the last-given pre-fill", async () => {
    mockLastGiven = { p1: { lastPrice: 1 } };
    mockTier = 1;
    await openWithCustomer();
    await pickOrder(/ORD-o1/);
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    expect(lineFor("Sample Cola").textContent).toContain("$1.00");
    expect(lineFor("Sample Cola").textContent).not.toContain("$99");
  });

  it("skips retired products and says how many are no longer available", async () => {
    await openWithCustomer();
    await pickOrder(/ORD-o1/);
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "1 item is no longer available" }),
      ),
    );
    expect(screen.queryByText("Retired Gum")).not.toBeInTheDocument();
    expect(screen.getAllByTitle("Remove")).toHaveLength(2);
  });

  it("does not prefill an order that already has lines until the operator confirms", async () => {
    await openWithCustomer();
    fireEvent.click(
      within(screen.getByTestId("order-suggestions")).getByRole("button", { name: /Sample Cola/ }),
    );
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());

    await pickOrder(/ORD-o2/);
    expect(
      screen.getByText("This order already has lines. Add these lines as well?"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Sample Soda")).not.toBeInTheDocument();

    // Cancel leaves the order untouched
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Sample Soda")).not.toBeInTheDocument();
    expect(screen.getAllByTitle("Remove")).toHaveLength(1);

    // Confirm adds the lines alongside the existing one
    await pickOrder(/ORD-o2/);
    fireEvent.click(screen.getByRole("button", { name: "Add lines" }));
    await waitFor(() => expect(lineFor("Sample Soda")).toBeTruthy());
    expect(lineFor("Sample Soda").textContent).toContain("$8.00");
    expect(screen.getAllByTitle("Remove")).toHaveLength(2);
  });

  it("re-adds a unit line (Carton) as that unit, priced from today's ladder", async () => {
    mockFetchUnits.mockResolvedValue([
      {
        id: "u1",
        label: "Carton",
        factorToBase: 12,
        isDefaultSelling: false,
        price: "50.00",
        priceTier2: "44.00",
        priceTier3: null,
        priceTier4: null,
        priceTier5: null,
      },
    ]);
    mockSuggestions = suggestions({
      recentOrders: [
        oldOrder("o3", [
          ol("p2", { qty: 48, boxes: 4, pieces: 0, unitsPerBox: 12, unitLabel: "Carton" }),
        ]),
      ],
    });
    await openWithCustomer();
    await pickOrder(/ORD-o3/);
    await waitFor(() => expect(lineFor("Sample Chips")).toBeTruthy());
    expect(mockFetchUnits).toHaveBeenCalledWith("p2");
    expect(lineFor("Sample Chips").textContent).toContain("$44.00");
    expect(
      (lineFor("Sample Chips").querySelector('input[aria-label="Quantity"]') as HTMLInputElement)
        .value,
    ).toBe("4");
  });

  it("a unit that is no longer offered counts as unavailable and adds nothing", async () => {
    mockFetchUnits.mockResolvedValue([]);
    mockSuggestions = suggestions({
      recentOrders: [oldOrder("o3", [ol("p2", { qty: 4, unitLabel: "Carton" })])],
    });
    await openWithCustomer();
    await pickOrder(/ORD-o3/);
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "1 item is no longer available" }),
      ),
    );
    expect(screen.queryAllByTitle("Remove")).toHaveLength(0);
  });

  it("a legacy line with no stored split on a boxed product is skipped with a notice, never guessed", async () => {
    // 24 loose items at today's pack of 12 must not become 24 cases (288 pieces).
    mockSuggestions = suggestions({
      recentOrders: [oldOrder("o4", [ol("p2", { qty: 24 }), ol("p1", { qty: 2 })])],
    });
    await openWithCustomer();
    await pickOrder(/ORD-o4/);
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "1 item could not be added because its quantity is unclear",
        }),
      ),
    );
    expect(screen.getAllByTitle("Remove")).toHaveLength(1);
  });

  it("says so when a product's pack size changed since the order", async () => {
    mockSuggestions = suggestions({
      recentOrders: [oldOrder("o5", [ol("p2", { qty: 12, boxes: 2, pieces: 0, unitsPerBox: 6 })])],
    });
    await openWithCustomer();
    await pickOrder(/ORD-o5/);
    await waitFor(() => expect(lineFor("Sample Chips")).toBeTruthy());
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "1 item has a new pack size, so check its quantity" }),
    );
  });

  it("a second Order again while the first is still resolving adds nothing twice", async () => {
    let release: (units: unknown[]) => void = () => {};
    mockFetchUnits.mockReturnValue(new Promise((resolve) => (release = resolve)));
    mockSuggestions = suggestions({
      recentOrders: [
        oldOrder("o3", [
          ol("p2", { qty: 48, boxes: 4, pieces: 0, unitsPerBox: 12, unitLabel: "Carton" }),
        ]),
      ],
    });
    await openWithCustomer();
    await pickOrder(/ORD-o3/); // slow: the ladder is still loading
    await pickOrder(/ORD-o3/); // the menu is reopened and the same order picked again
    release([
      {
        id: "u1",
        label: "Carton",
        factorToBase: 12,
        isDefaultSelling: false,
        price: "50.00",
        priceTier2: "44.00",
        priceTier3: null,
        priceTier4: null,
        priceTier5: null,
      },
    ]);
    await waitFor(() => expect(lineFor("Sample Chips")).toBeTruthy());
    expect(screen.getAllByTitle("Remove")).toHaveLength(1);
    expect(
      (lineFor("Sample Chips").querySelector('input[aria-label="Quantity"]') as HTMLInputElement)
        .value,
    ).toBe("4");
    expect(mockFetchUnits).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the menu (not the order) and gives focus back to the button", async () => {
    await openWithCustomer();
    const trigger = screen.getByRole("button", { name: "Order again" });
    fireEvent.click(trigger);
    await screen.findByRole("list", { name: "Choose a recent order" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Choose a recent order" })).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("order-suggestions")).toBeInTheDocument(); // the order is still open
    expect(trigger).toHaveFocus();
  });
});

describe("when the suggestions cannot be loaded", () => {
  it("says so quietly and leaves order entry alone", async () => {
    mockApiGet.mockImplementation((url: string) =>
      url === "/customers/c1/order-suggestions"
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ data: { taxRate: 0 } }),
    );
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
      target: { value: "Acm" },
    });
    fireEvent.click(await screen.findByText("Acme Foods"));
    expect(await screen.findByText("Suggestions unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Order again" })).not.toBeInTheDocument();
  });
});

describe("when there is nothing to suggest", () => {
  it("renders no bar for a customer with no history", async () => {
    mockSuggestions = { customerId: "c1", usuallyBuys: [], recentOrders: [], products: {} };
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
      target: { value: "Acm" },
    });
    fireEvent.click(await screen.findByText("Acme Foods"));
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledWith("/customers/c1/order-suggestions"));
    expect(screen.queryByTestId("order-suggestions")).not.toBeInTheDocument();
  });
});
