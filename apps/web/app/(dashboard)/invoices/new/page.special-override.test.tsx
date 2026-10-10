import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * #2696(c) SA-558e — the New-sale builder posts to /orders/sell, which prices through the server's
 * create() and its ONE staff-override rule (pricing's decideStaffOverride): a special (tier) price
 * moves only with a reason. The builder asks for it, blocks the sale without it (naming the
 * product, in the server's words) and sends it. Harness copied from page.test.tsx.
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
const mockProductsGet = jest.fn((url: string) => {
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

describe("#2696(c) SA-558e — New sale: a special price moves only with a reason", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCustomers = [{ id: "cust-1", businessName: "Acme Co", pricingTier: 3 }];
    mockBarcodeProduct = TIERED;
    mockSearchProducts = [TIERED];
  });

  it("the special price itself needs no reason; the sale sends it", async () => {
    const user = await openNewSale();
    capturedOnScan!("111");
    await screen.findByDisplayValue("Tiered Widget");
    expect(screen.queryByLabelText("Reason (required)")).not.toBeInTheDocument();
    await submitSale(user);
    await waitFor(() => expect(mockCreateSale).toHaveBeenCalled());
    expect(sentItems()[0]).toMatchObject({ productId: "prod-1", unitPrice: 8 });
    expect(sentItems()[0]).not.toHaveProperty("overrideReason");
  });

  it("red-first: off the special price, a reason is required and the sale is BLOCKED, naming the product", async () => {
    const user = await openNewSale();
    capturedOnScan!("111");
    await screen.findByDisplayValue("Tiered Widget");
    const price = screen.getByLabelText("Unit price");
    await user.clear(price);
    await user.type(price, "6");
    expect(screen.getByLabelText("Reason (required)")).toBeInTheDocument();
    await submitSale(user);
    expect(mockCreateSale).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringMatching(/reason is required to change Tiered Widget/),
      }),
    );
  });

  it("red-first: with a reason the sale carries unitPrice + overrideReason", async () => {
    const user = await openNewSale();
    capturedOnScan!("111");
    await screen.findByDisplayValue("Tiered Widget");
    const price = screen.getByLabelText("Unit price");
    await user.clear(price);
    await user.type(price, "6");
    await user.type(screen.getByLabelText("Reason (required)"), "dented");
    await submitSale(user);
    await waitFor(() => expect(mockCreateSale).toHaveBeenCalled());
    expect(sentItems()[0]).toMatchObject({ unitPrice: 6, overrideReason: "dented" });
  });

  it("red-first: a product picked from the row's search is priced at the customer's TIER, not list (else the server would refuse it)", async () => {
    const user = await openNewSale();
    const input = screen.getByPlaceholderText("Description / product…");
    await user.click(input);
    await user.type(input, "Tiered");
    await user.click(await screen.findByText("Tiered Widget"));
    await submitSale(user);
    await waitFor(() => expect(mockCreateSale).toHaveBeenCalled());
    expect(sentItems()[0]).toMatchObject({ productId: "prod-1", unitPrice: 8 });
  });
});
