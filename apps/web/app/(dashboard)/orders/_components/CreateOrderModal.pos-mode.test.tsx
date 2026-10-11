import * as React from "react";
import { renderWithProviders, screen, waitFor, act, fireEvent } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";
import { apiClient } from "@/lib/api-client";

/**
 * SA-763r P-2: the "POS mode" switch in the Create Order header. Seeded from GET /users/me/preferences,
 * written with PATCH on flip (never localStorage); when on the order is sent as PICKUP, the delivery-only
 * fields step aside (restorable) and the primary action is "Confirm & invoice".
 */
window.HTMLElement.prototype.scrollIntoView = jest.fn();

let mockPrefs: Record<string, string> = {};
let mockRole: string = "OPERATOR";
jest.mock("@/lib/auth-context", () => {
  const actual = jest.requireActual("@/lib/auth-context");
  return {
    ...actual,
    useAuth: () => ({ ...actual.useAuth(), user: { id: "u1", role: mockRole } }),
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
const patch = apiClient.patch as jest.Mock;
const orderPosts = () => post.mock.calls.filter((c) => c[0] === "/orders");

async function openWithLine() {
  mockResolve.mockResolvedValue({
    notFound: false,
    archived: false,
    product: { id: "p1", name: "Widget p1", pricePerUnit: "9.99", unit: "each" },
  });
  const onViewOrder = jest.fn();
  renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} onViewOrder={onViewOrder} />);
  fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
    target: { value: "Acm" },
  });
  fireEvent.click(await screen.findByText("Acme Foods"));
  capturedOnScan!("111");
  await screen.findByText("Widget p1");
  return { onViewOrder };
}
const posSwitch = () => screen.findByRole("switch", { name: /pos mode/i });

beforeEach(() => {
  jest.clearAllMocks();
  mockPrefs = {};
  mockRole = "OPERATOR";
  mockActive = undefined;
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/users/me/preferences" ? mockPrefs : { taxRate: 0 } }),
  );
  patch.mockResolvedValue({ data: {} });
  post.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders" ? { id: "o1", orderNumber: "SO-1" } : [] }),
  );
  localStorage.clear();
});

describe("CreateOrderModal: POS mode switch", () => {
  it("SUPER_ADMIN: no switch, and a stored posMode=true never sends PICKUP", async () => {
    mockRole = "SUPER_ADMIN";
    mockPrefs = { "orders.posMode": "true" };
    await openWithLine();
    expect(screen.queryByRole("switch", { name: /pos mode/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm & invoice" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^create order$/i }));
    await waitFor(() => expect(orderPosts().length).toBe(1));
    expect(orderPosts()[0][1].fulfillPath).not.toBe("PICKUP");
  });

  it("OPERATOR: the switch renders, its whole row is the label, and the hint describes it", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    const sw = await posSwitch();
    expect(sw).toHaveAccessibleDescription(/\S/);
    expect(sw.closest("label")).not.toBeNull();
  });

  it("is off when the preference is unset, and a flip is written with PATCH (not localStorage)", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    const sw = await posSwitch();
    await waitFor(() => expect(sw).toBeEnabled());
    expect(sw).not.toBeChecked();
    fireEvent.click(sw);
    expect(sw).toBeChecked();
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/users/me/preferences", { "orders.posMode": "true" }),
    );
    expect(localStorage.length).toBe(0);
  });

  it("is seeded on from GET preferences", async () => {
    mockPrefs = { "orders.posMode": "true" };
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    const sw = await posSwitch();
    await waitFor(() => expect(sw).toBeChecked());
    expect(screen.getByRole("button", { name: "Confirm & invoice" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm only" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save as draft/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^create order$/i })).not.toBeInTheDocument();
  });

  it("rolls the switch back and says so when the PATCH fails", async () => {
    patch.mockRejectedValue(new Error("boom"));
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    const sw = await posSwitch();
    await waitFor(() => expect(sw).toBeEnabled());
    fireEvent.click(sw);
    await waitFor(() => expect(sw).not.toBeChecked());
    expect(await screen.findByText(/couldn't save your pos mode setting/i)).toBeInTheDocument();
  });

  it("steps the delivery-only fields aside and restores them when switched off", async () => {
    mockPrefs = { "orders.posMode": "true" };
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    const sw = await posSwitch();
    await waitFor(() => expect(sw).toBeChecked());
    expect(screen.queryByLabelText(/requested delivery date/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Mark as Urgent")).not.toBeInTheDocument();
    fireEvent.click(sw);
    await waitFor(() => expect(sw).not.toBeChecked());
    expect(screen.getByLabelText(/requested delivery date/i)).toBeInTheDocument();
    expect(screen.getByText("Mark as Urgent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^create order$/i })).toBeInTheDocument();
  });

  it("Confirm & invoice: creates a PICKUP order, then PATCH status CONFIRMED, then POST from-order", async () => {
    mockPrefs = { "orders.posMode": "true" };
    await openWithLine();
    await waitFor(() => expect(screen.getByRole("switch", { name: /pos mode/i })).toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: "Confirm & invoice" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/orders/o1/status", { status: "CONFIRMED" }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledWith("/invoices/from-order/o1"));
    const body = orderPosts()[0][1];
    expect(body.fulfillPath).toBe("PICKUP");
    expect(body.urgent).toBe(false);
    expect(body.requestedDeliveryDate).toBeUndefined();
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Order confirmed and invoiced" }),
      ),
    );
  });

  it("Confirm only: confirms but never invoices", async () => {
    mockPrefs = { "orders.posMode": "true" };
    await openWithLine();
    await waitFor(() => expect(screen.getByRole("switch", { name: /pos mode/i })).toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: "Confirm only" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/orders/o1/status", { status: "CONFIRMED" }),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(post.mock.calls.some((c) => String(c[0]).startsWith("/invoices/from-order"))).toBe(
      false,
    );
  });

  it("when the invoice step fails, the order stays confirmed and the toast points at the order page", async () => {
    mockPrefs = { "orders.posMode": "true" };
    post.mockImplementation((url: string) =>
      url === "/orders"
        ? Promise.resolve({ data: { id: "o1", orderNumber: "SO-1" } })
        : Promise.reject(new Error("nope")),
    );
    const { onViewOrder } = await openWithLine();
    await waitFor(() => expect(screen.getByRole("switch", { name: /pos mode/i })).toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: "Confirm & invoice" }));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringMatching(/confirmed, but the invoice wasn't created/i),
          variant: "warning",
        }),
      ),
    );
    const toastArg = mockToast.mock.calls.find((c) => /invoice wasn't/.test(c[0].title))![0];
    toastArg.action.onClick();
    expect(onViewOrder).toHaveBeenCalledWith("o1");
  });

  it("Save as Draft is kept and sends the draft as PICKUP without confirming", async () => {
    mockPrefs = { "orders.posMode": "true" };
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
      target: { value: "Acm" },
    });
    fireEvent.click(await screen.findByText("Acme Foods"));
    await waitFor(() => expect(screen.getByRole("switch", { name: /pos mode/i })).toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    await waitFor(() => expect(orderPosts()).toHaveLength(1));
    expect(orderPosts()[0][1]).toEqual(
      expect.objectContaining({ fulfillPath: "PICKUP", status: "DRAFT" }),
    );
    expect(patch.mock.calls.some((c) => String(c[0]).includes("/status"))).toBe(false);
  });

  it("an open counter order: the merge prompt uses the counter copy and looks up the PICKUP target", async () => {
    mockPrefs = { "orders.posMode": "true" };
    mockActive = { id: "a1", orderNumber: "SO-9", status: "PENDING", itemCount: 2, total: 20 };
    await openWithLine();
    await waitFor(() => expect(screen.getByRole("switch", { name: /pos mode/i })).toBeChecked());
    expect(mockActiveHook).toHaveBeenLastCalledWith("c1", "PICKUP");
    fireEvent.click(screen.getByRole("button", { name: "Confirm & invoice" }));
    expect(
      await screen.findByText("This customer already has an open counter order"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to it" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start a new one" })).toBeInTheDocument();
  });
});

describe("CreateOrderModal: POS mode landing and Enter", () => {
  it("lands on the new order's page after Confirm & invoice (not the list)", async () => {
    mockPrefs = { "orders.posMode": "true" };
    const { onViewOrder } = await openWithLine();
    await waitFor(() => expect(screen.getByRole("switch", { name: /pos mode/i })).toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: "Confirm & invoice" }));
    await waitFor(() => expect(onViewOrder).toHaveBeenCalledWith("o1"));
    expect(post).toHaveBeenCalledWith("/invoices/from-order/o1");
  });

  it("lands on the order page even when the invoice step failed", async () => {
    mockPrefs = { "orders.posMode": "true" };
    post.mockImplementation((url: string) =>
      url === "/orders" ? Promise.resolve({ data: { id: "o1" } }) : Promise.reject(new Error("x")),
    );
    const { onViewOrder } = await openWithLine();
    await waitFor(() => expect(screen.getByRole("switch", { name: /pos mode/i })).toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: "Confirm & invoice" }));
    await waitFor(() => expect(onViewOrder).toHaveBeenCalledWith("o1"));
  });

  it("an implicit (Enter) submit follows the primary, even right after a Confirm only choice", async () => {
    mockPrefs = { "orders.posMode": "true" };
    await openWithLine();
    await waitFor(() => expect(screen.getByRole("switch", { name: /pos mode/i })).toBeChecked());
    fireEvent.submit(document.getElementById("create-order-form")!);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/invoices/from-order/o1"));
  });
});

describe("CreateOrderModal: a store-only tenant (row 331)", () => {
  // capabilities.fulfilment of an in-store business: PICKUP is the only method and the counter is always on.
  const STORE_ONLY = {
    capabilities: {
      fulfilment: {
        methods: ["PICKUP"],
        staffDefault: "PICKUP",
        staffOpensAs: "counter",
        portalMethods: [],
        portalDefault: null,
        counter: "always",
        fleet: false,
        consistent: true,
      },
    },
  };
  const asStoreOnly = () =>
    get.mockImplementation((url: string) =>
      Promise.resolve({
        data:
          url === "/tenants/me/features"
            ? STORE_ONLY
            : url === "/users/me/preferences"
              ? mockPrefs
              : { taxRate: 0 },
      }),
    );

  it("is in POS mode with no stored preference: Confirm & invoice, no delivery steps, no switch", async () => {
    asStoreOnly();
    await openWithLine();
    expect(await screen.findByRole("button", { name: "Confirm & invoice" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /pos mode/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Requested Delivery Date/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^create order$/i })).not.toBeInTheDocument();
  });

  it("sends the order as PICKUP", async () => {
    asStoreOnly();
    await openWithLine();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm & invoice" }));
    await waitFor(() => expect(orderPosts().length).toBe(1));
    expect(orderPosts()[0][1].fulfillPath).toBe("PICKUP");
  });

  it("is titled Invoice a customer, with the in-store subtitle and no delivery wording in Notes", async () => {
    asStoreOnly();
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(await screen.findByRole("dialog", { name: "Invoice a customer" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Sold in store. The invoice is made when you confirm; hand the goods over when they collect.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Create a new order on behalf of a customer."),
    ).not.toBeInTheDocument();
    const notes = screen.getByLabelText("Notes");
    expect(notes).toHaveAttribute("placeholder", "Special instructions…");
  });

  it("a role without POS mode is left on the normal builder", async () => {
    asStoreOnly();
    mockRole = "SUPER_ADMIN";
    await openWithLine();
    expect(screen.queryByRole("button", { name: "Confirm & invoice" })).not.toBeInTheDocument();
  });

  it("a delivery tenant is unchanged: POS mode stays an opt-in switch", async () => {
    await openWithLine();
    expect(await posSwitch()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm & invoice" })).not.toBeInTheDocument();

    expect(screen.getByRole("dialog", { name: "Create Order" })).toBeInTheDocument();
    expect(screen.getByText("Create a new order on behalf of a customer.")).toBeInTheDocument();
    expect(screen.getByLabelText("Notes")).toHaveAttribute(
      "placeholder",
      "Special instructions, delivery notes…",
    );
  });
});
