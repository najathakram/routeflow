import * as React from "react";
import { renderWithProviders, screen, waitFor, act, fireEvent } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";
import { apiClient } from "@/lib/api-client";

/**
 * W-1043 (SA-1062 MUST 22) R21/R22: Store pickup in the regular order. The option shows when the business offers
 * PICKUP and the operator may use the till (BO-07); choosing it sends fulfillPath PICKUP. POS mode is not involved.
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
let caps: Record<string, unknown> = {};
let mockDenied: string[] = [];
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({ data: { capabilities: { fulfilment: caps } } }),
}));
jest.mock("@/lib/api/counter-sale", () => ({
  ...jest.requireActual("@/lib/api/counter-sale"),
  useCounterSaleGate: () => ({
    deniedGroups: mockDenied,
    permsKnown: true,
    mayUseTill: mockDenied.length === 0,
    loading: false,
  }),
}));
let mockLoadedDraft: unknown = undefined;
let mockActive: unknown = undefined;
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({
    data: {
      data: [
        { id: "c1", businessName: "Acme Foods", pricingTier: 2 },
        { id: "c2", businessName: "Beta Bakery", pricingTier: 2, fulfillPath: "ROUTE" },
        { id: "c3", businessName: "Gamma Grocers", pricingTier: 2, fulfillPath: "ROUTE" },
      ],
    },
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
  useDraft: () => ({ data: mockLoadedDraft, isFetching: false }),
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

const account = (over: Record<string, unknown>) => ({
  methods: ["ROUTE", "PICKUP"],
  staffDefault: "ROUTE",
  staffOpensAs: "order",
  portalMethods: [],
  portalDefault: null,
  counter: "off",
  fleet: true,
  consistent: true,
  ...over,
});
const storePickup = () => screen.queryAllByRole("button", { name: "Store pickup" });

beforeEach(() => {
  jest.clearAllMocks();
  mockPrefs = {};
  mockRole = "OPERATOR";
  mockActive = undefined;
  mockDenied = [];
  mockLoadedDraft = undefined;
  caps = account({});
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/users/me/preferences" ? mockPrefs : { taxRate: 0 } }),
  );
  post.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders" ? { id: "o1", orderNumber: "SO-1" } : [] }),
  );
  localStorage.clear();
});

describe("CreateOrderModal: Store pickup in the regular order", () => {
  it("R22: a business that offers PICKUP shows the option beside Delivery route", async () => {
    await openWithLine();
    expect(storePickup()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Delivery route" })).toBeInTheDocument();
  });

  it("R22: choosing Store pickup sends fulfillPath PICKUP on the wire", async () => {
    await openWithLine();
    expect(storePickup()).toHaveLength(1);
    fireEvent.click(storePickup()[0]);
    fireEvent.click(screen.getByRole("button", { name: /^create order$/i }));
    await waitFor(() => expect(orderPosts().length).toBe(1));
    expect(orderPosts()[0][1].fulfillPath).toBe("PICKUP");
  });

  it("the default stays the account's own path, and switching back sends it", async () => {
    await openWithLine();
    fireEvent.click(screen.getByRole("button", { name: /^create order$/i }));
    await waitFor(() => expect(orderPosts().length).toBe(1));
    expect(orderPosts()[0][1].fulfillPath).toBe("ROUTE");
  });

  it("choosing Store pickup, then Delivery route, sends ROUTE", async () => {
    await openWithLine();
    expect(storePickup()).toHaveLength(1);
    fireEvent.click(storePickup()[0]);
    fireEvent.click(screen.getByRole("button", { name: "Delivery route" }));
    fireEvent.click(screen.getByRole("button", { name: /^create order$/i }));
    await waitFor(() => expect(orderPosts().length).toBe(1));
    expect(orderPosts()[0][1].fulfillPath).toBe("ROUTE");
  });

  it("R21 (guard): an operator whose till is switched off is not offered it", async () => {
    mockDenied = ["ORDERS"];
    await openWithLine();
    expect(storePickup()).toHaveLength(0);
  });

  it("a business with no PICKUP method is not offered it (guard)", async () => {
    caps = account({ methods: ["ROUTE", "SHIP"] });
    await openWithLine();
    expect(storePickup()).toHaveLength(0);
  });

  it("a parked Store pickup draft resumes on Store pickup, not on carrier shipping", async () => {
    mockLoadedDraft = {
      id: "d1",
      kind: "ORDER",
      updatedAt: "2026-10-30T10:00:00.000Z",
      payload: {
        customer: { id: "c1", businessName: "Acme Foods", pricingTier: 1 },
        lineItems: [
          {
            tempId: "t1",
            productId: "p1",
            productName: "Widget p1",
            unit: "each",
            listPrice: 9.99,
            unitPrice: 9.99,
            priceType: "STANDARD",
            qty: 1,
          },
        ],
        orderDiscount: "",
        shippingFee: "",
        requestedDeliveryDate: "",
        orderDate: "",
        notes: "",
        urgent: false,
        floorAcked: [],
        fulfillPath: "PICKUP",
        _submitKey: "K-1",
      },
    };
    renderWithProviders(<CreateOrderModal isOpen resumeDraftId="d1" onClose={jest.fn()} />);
    await screen.findByText("Widget p1");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^create order$/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^create order$/i }));
    await waitFor(() => expect(orderPosts().length).toBe(1));
    expect(orderPosts()[0][1].fulfillPath).toBe("PICKUP");
  });

  // SA-1062 A-3 (R2a-R2d): a Store pickup the clerk chose beats the customer's default when a customer is
  // picked or changed afterwards. Delivery route, Ship via carrier and POS mode are unchanged.
  async function openBare() {
    mockResolve.mockResolvedValue({
      notFound: false,
      archived: false,
      product: { id: "p1", name: "Widget p1", pricePerUnit: "9.99", unit: "each" },
    });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} onViewOrder={jest.fn()} />);
  }
  async function pick(search: string, name: string) {
    fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
      target: { value: search },
    });
    fireEvent.click(await screen.findByText(name));
    await screen.findByRole("button", { name: "Change customer" });
  }
  async function addLineAndSubmit(label: RegExp) {
    capturedOnScan!("111");
    await screen.findByText("Widget p1");
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(orderPosts().length).toBe(1));
    return orderPosts()[0][1].fulfillPath;
  }

  it("R2a: Store pickup, then a ROUTE customer is picked: the order stays PICKUP", async () => {
    await openBare();
    fireEvent.click(storePickup()[0]);
    await pick("Beta", "Beta Bakery");
    expect(await addLineAndSubmit(/^create order$/i)).toBe("PICKUP");
  });

  it("R2b: Store pickup, customer A, then customer B: the order stays PICKUP", async () => {
    await openBare();
    fireEvent.click(storePickup()[0]);
    await pick("Beta", "Beta Bakery");
    fireEvent.click(screen.getByRole("button", { name: "Change customer" }));
    await pick("Gamma", "Gamma Grocers");
    expect(await addLineAndSubmit(/^create order$/i)).toBe("PICKUP");
  });

  it("R2c (guard): Ship via carrier, then a ROUTE customer is picked: the order is ROUTE", async () => {
    caps = account({ methods: ["ROUTE", "SHIP", "PICKUP"] });
    await openBare();
    fireEvent.click(await screen.findByRole("button", { name: "Ship via carrier" }));
    await pick("Beta", "Beta Bakery");
    expect(await addLineAndSubmit(/^create order$/i)).toBe("ROUTE");
  });

  it("R2d (guard): POS mode, a ROUTE customer is picked: the order posts PICKUP", async () => {
    mockPrefs = { "orders.posMode": "true" };
    await openBare();
    await pick("Beta", "Beta Bakery");
    expect(await addLineAndSubmit(/^confirm and invoice$/i)).toBe("PICKUP");
  });
});
