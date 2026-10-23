import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * W-745 (SA-868/884, the web pickers): the new-invoice builder gated picks on the LAYER only. A customer-price read that FAILED
 * (no data) still let a pick through, priced at the customer's tier with every per-product override dropped. It now uses the
 * shared customerPricingGate: a failed read refuses the pick (scan or search) with the failed copy and Retry; the plan-gated
 * PLAN_GATE 403 is an empty read, so an un-flagged tenant picks at the tier. Harness copied from
 * page.invoice-override-reason.test.tsx.
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

let mockCustomers: Array<Record<string, unknown>> = [];
let mockPricesRead: Record<string, unknown> = {};
const mockRefetchPrices = jest.fn();
const mockCreateSale = jest.fn();
const mockToast = jest.fn();
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: mockCustomers } }),
  useCustomerPrices: () => ({ data: [], refetch: mockRefetchPrices, ...mockPricesRead }),
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

async function openOtherCharge() {
  const user = userEvent.setup();
  renderWithProviders(<NewInvoicePage />);
  await user.click(
    screen.getByRole("button", { name: /other charge \(a fee or correction with no order\)/i }),
  );
  const customerInput = screen.getByPlaceholderText(/search customers/i);
  await user.click(customerInput);
  await user.click(await screen.findByText("Acme Co"));
  return user;
}
const saveDraft = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /save as draft/i }));
const sentItems = () =>
  (createInvoiceMutate.mock.calls[0][0] as { items: Array<Record<string, unknown>> }).items;
const typePrice = async (user: ReturnType<typeof userEvent.setup>, v: string) => {
  const price = screen.getByLabelText("Unit price");
  await user.clear(price);
  await user.type(price, v);
};

const failed = (status: number, code?: string) => ({
  data: undefined,
  isError: true,
  error: { response: { status, data: { code } } },
});

describe("W-745: the new-invoice builder fails closed on a failed customer-price read", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCustomers = [{ id: "cust-1", businessName: "Acme Co", pricingTier: 3 }];
    mockBarcodeProduct = TIERED;
    mockSearchProducts = [TIERED];
    mockPricesRead = {};
  });

  it("a failed prices read (500): a scan prices nothing and the failed copy offers Retry (master: priced at $8)", async () => {
    mockPricesRead = failed(500);
    const user = await openOtherCharge();
    expect(await screen.findByText(/couldn't load this customer's prices/i)).toBeInTheDocument();
    capturedOnScan?.("111");
    await new Promise((r) => setTimeout(r, 50));
    // The line is NOT priced: no unit price lands (master: 8, the tier price with the overrides dropped). The search box
    // itself still echoes the picked name, as it does while the layer is pending.
    expect((screen.getByLabelText("Unit price") as HTMLInputElement).value).not.toMatch(
      /^8(\.00)?$/,
    );
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(mockRefetchPrices).toHaveBeenCalled();
  });

  it("a PLAN_GATE 403 is an empty read: a scan adds at the tier ($8)", async () => {
    mockPricesRead = failed(403, "PLAN_GATE");
    const user = await openOtherCharge();
    capturedOnScan!("111");
    await screen.findByDisplayValue("Tiered Widget");
    expect(screen.queryByText(/couldn't load this customer's prices/i)).not.toBeInTheDocument();
    await saveDraft(user);
    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalled());
    expect(sentItems()[0]).toMatchObject({ productId: "prod-1", unitPrice: 8 });
  });
});
