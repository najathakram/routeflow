import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * S19b slice C, C-1 (SA-811a, SA-813): invoices/new prices a catalog add from the customer's LAYER (billing's own resolved row)
 * when flag.units_prices_v2 is on. Flag off: no price-layer request, master's tier numbers. Layer pending or failed: the prices
 * are unconfirmed (SA-813 M3 copy) and Save/Send stay disabled. Above-list is MANUAL with no reason prompt (R2).
 * Harness copied from page.special-override.test.tsx. (Original header: #2696(c) SA-558e — the New-sale builder posts to /orders/sell, which prices through the server's
 * create() and its ONE staff-override rule (pricing's decideStaffOverride): a special (tier) price
 * moves only with a reason. The builder asks for it, blocks the sale without it (naming the
 * product, in the server's words) and sends it. Harness copied from page.test.tsx.)
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

let mockCustomers: Array<Record<string, unknown>> = [];
const mockCreateSale = jest.fn();
const mockToast = jest.fn();
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: mockCustomers } }),
  useCustomerPrices: () => ({ data: [] }),
}));

// Keyed by URL so the page's own /settings fetch (tax rate, on mount) doesn't consume the
// barcode-scan mock — apiClient.get is called for both.
let mockBarcodeProduct: Record<string, unknown> | undefined;
let flagOn = true;
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => flagOn }));
let layerResponder: () => Promise<unknown> = () => Promise.resolve({ data: {} });
const mockProductsGet = jest.fn((url: string) => {
  if (url === "/customers/cust-1/price-layer") return layerResponder();
  if (url.startsWith("/products/barcode/")) {
    return mockBarcodeProduct
      ? Promise.resolve({ data: mockBarcodeProduct })
      : Promise.reject(new Error("not found"));
  }
  return Promise.resolve({ data: {} });
});
let mockSearchProducts: Array<Record<string, unknown>> = [];
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: mockSearchProducts } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));

const createInvoiceMutate = jest.fn();
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useCreateInvoice: () => ({ mutate: createInvoiceMutate, isPending: false }),
  useUpdateInvoice: () => ({ mutate: jest.fn(), isPending: false }),
  useCreateInvoiceFromOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useInvoiceSettings: () => ({ data: undefined }),
}));

jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useCreateSale: () => ({ mutate: mockCreateSale, isPending: false }),
  useUninvoicedOrders: () => ({ orders: [], isLoading: false }),
}));

jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (url: string) => mockProductsGet(url),
    post: jest.fn().mockResolvedValue({ data: {} }),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

// Same technique as CreateOrderModal.test.tsx (B499): the real scanner needs getUserMedia,
// impractical in JSDOM — capture the live onScan prop so a test can trigger it directly.
let capturedOnScan: ((code: string) => void) | undefined;
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: { onScan: (code: string) => void }) => {
    capturedOnScan = props.onScan;
    return null;
  },
}));

// Same technique — the real modal needs form interaction impractical to drive here; capture
// onCreated so a test can simulate "the operator just created this product" directly (#1176 pin).
let capturedOnCreated: ((product: Record<string, unknown>) => void) | undefined;
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: (props: {
    isOpen: boolean;
    onCreated: (product: Record<string, unknown>) => void;
  }) => {
    if (props.isOpen) capturedOnCreated = props.onCreated;
    return null;
  },
}));

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));

/** list $10, tier-3 (special) $8. */
const TIERED = { id: "prod-1", name: "Tiered Widget", pricePerUnit: "10", priceTier3: "8" };
const layer = (price: number, aboveList = false) => ({
  data: {
    customerId: "cust-1",
    complete: true,
    products: {
      "prod-1": [{ ref: "pack", label: null, price, listPrice: 10, source: "customer", aboveList }],
    },
  },
});

async function openNewSale() {
  const user = userEvent.setup();
  renderWithProviders(<NewInvoicePage />);
  await user.click(screen.getByRole("button", { name: /new sale/i }));
  const customerInput = screen.getByPlaceholderText(/search customers/i);
  await user.click(customerInput);
  await user.click(await screen.findByText("Acme Co"));
  return user;
}
const submitSale = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /create sale|save draft invoice/i }));
const sentItems = () =>
  (mockCreateSale.mock.calls[0][0] as { items: Array<Record<string, unknown>> }).items;
const unitPriceValue = () =>
  parseFloat((screen.getByLabelText("Unit price") as HTMLInputElement).value);
const layerCalls = () =>
  mockProductsGet.mock.calls.filter((c) => String(c[0]).endsWith("/price-layer"));

describe("S19b C-1: invoices/new adds from the customer layer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    flagOn = true;
    layerResponder = () => Promise.resolve(layer(7));
    mockCustomers = [{ id: "cust-1", businessName: "Acme Co", pricingTier: 3 }];
    mockBarcodeProduct = TIERED;
    mockSearchProducts = [TIERED];
  });

  it("C-1: a scanned add lands on the layer price $7 (SPECIAL), not the tier $8, and sends it with no reason", async () => {
    const user = await openNewSale();
    await waitFor(() => expect(layerCalls().length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(screen.queryByText(/checking this customer/i)).not.toBeInTheDocument(),
    );
    capturedOnScan!("111");
    await screen.findByDisplayValue("Tiered Widget");
    await waitFor(() => expect(unitPriceValue()).toBe(7));
    expect(screen.queryByLabelText("Reason (required)")).not.toBeInTheDocument();
    await submitSale(user);
    await waitFor(() => expect(mockCreateSale).toHaveBeenCalled());
    expect(sentItems()[0]).toMatchObject({ productId: "prod-1", unitPrice: 7 });
    expect(sentItems()[0]).not.toHaveProperty("overrideReason");
  });

  it("C-1: a product picked from the row search also lands on the layer price", async () => {
    const user = await openNewSale();
    await waitFor(() =>
      expect(screen.queryByText(/checking this customer/i)).not.toBeInTheDocument(),
    );
    const input = screen.getByPlaceholderText("Description / product…");
    await user.click(input);
    await user.type(input, "Tiered");
    await user.click(await screen.findByText("Tiered Widget"));
    await submitSale(user);
    await waitFor(() => expect(mockCreateSale).toHaveBeenCalled());
    expect(sentItems()[0]).toMatchObject({ productId: "prod-1", unitPrice: 7 });
  });

  it("R2: an above-list layer price ($12 on a $10 list) is MANUAL: no reason prompt, sent as is", async () => {
    layerResponder = () => Promise.resolve(layer(12, true));
    const user = await openNewSale();
    await waitFor(() =>
      expect(screen.queryByText(/checking this customer/i)).not.toBeInTheDocument(),
    );
    capturedOnScan!("111");
    await screen.findByDisplayValue("Tiered Widget");
    await waitFor(() => expect(unitPriceValue()).toBe(12));
    expect(screen.queryByLabelText("Reason (required)")).not.toBeInTheDocument();
    await submitSale(user);
    await waitFor(() => expect(mockCreateSale).toHaveBeenCalled());
    expect(sentItems()[0]).toMatchObject({ unitPrice: 12 });
    expect(sentItems()[0]).not.toHaveProperty("overrideReason");
  });

  it("flag OFF: no price-layer request and master's tier price ($8)", async () => {
    flagOn = false;
    const user = await openNewSale();
    capturedOnScan!("111");
    await screen.findByDisplayValue("Tiered Widget");
    await submitSale(user);
    await waitFor(() => expect(mockCreateSale).toHaveBeenCalled());
    expect(sentItems()[0]).toMatchObject({ unitPrice: 8 });
    expect(layerCalls()).toHaveLength(0);
  });

  it("M3: while the layer is pending the prices are unconfirmed and Save is disabled", async () => {
    layerResponder = () => new Promise(() => {});
    await openNewSale();
    expect(await screen.findByText("Checking this customer's prices…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create sale|save draft invoice/i })).toBeDisabled();
  });

  it("M3: a failed layer read says so with Retry and keeps Save disabled", async () => {
    layerResponder = () => Promise.reject(new Error("boom"));
    await openNewSale();
    expect(await screen.findByText(/couldn't load this customer's prices/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create sale|save draft invoice/i })).toBeDisabled();
  });
});
