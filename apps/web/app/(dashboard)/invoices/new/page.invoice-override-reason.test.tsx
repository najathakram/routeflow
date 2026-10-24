import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * H3b — the "Other charge" invoice builder (POST /invoices, then PATCH on a preview draft) is judged by
 * the same server rule as a sale (pricing's decideStaffOverride, against the customer's TIER price): a
 * special price moves only with a reason. The builder shows the same Reason field, blocks Save and
 * Preview without it (naming the product, in the server's words) and sends the trimmed reason on the
 * create line. Harness copied from page.special-override.test.tsx.
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

describe("H3b — Other charge: a special price moves only with a reason", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCustomers = [{ id: "cust-1", businessName: "Acme Co", pricingTier: 3 }];
    mockBarcodeProduct = TIERED;
    mockSearchProducts = [TIERED];
  });

  it("the special price itself needs no reason; the create line carries no overrideReason", async () => {
    const user = await openOtherCharge();
    capturedOnScan!("111");
    await screen.findByDisplayValue("Tiered Widget");
    expect(screen.queryByLabelText("Reason (required)")).not.toBeInTheDocument();
    await saveDraft(user);
    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalled());
    expect(sentItems()[0]).toMatchObject({ productId: "prod-1", unitPrice: 8 });
    expect(sentItems()[0]).not.toHaveProperty("overrideReason");
  });

  it("red-first: off the special price the Reason field shows and Save is BLOCKED, naming the product", async () => {
    const user = await openOtherCharge();
    capturedOnScan!("111");
    await screen.findByDisplayValue("Tiered Widget");
    await typePrice(user, "6");
    expect(screen.getByLabelText("Reason (required)")).toBeInTheDocument();
    await saveDraft(user);
    expect(createInvoiceMutate).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/reason is required to change Tiered Widget/i),
    ).toBeInTheDocument();
  });

  it("red-first: with a reason the create line carries unitPrice + the trimmed overrideReason", async () => {
    const user = await openOtherCharge();
    capturedOnScan!("111");
    await screen.findByDisplayValue("Tiered Widget");
    await typePrice(user, "6");
    await user.type(screen.getByLabelText("Reason (required)"), "  dented ");
    await saveDraft(user);
    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalled());
    expect(sentItems()[0]).toMatchObject({ unitPrice: 6, overrideReason: "dented" });
  });

  it("typing the tier price back hides the field and sends no reason", async () => {
    const user = await openOtherCharge();
    capturedOnScan!("111");
    await screen.findByDisplayValue("Tiered Widget");
    await typePrice(user, "6");
    await user.type(screen.getByLabelText("Reason (required)"), "dented");
    await typePrice(user, "8");
    expect(screen.queryByLabelText("Reason (required)")).not.toBeInTheDocument();
    await saveDraft(user);
    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalled());
    expect(sentItems()[0]).toMatchObject({ unitPrice: 8 });
    expect(sentItems()[0]).not.toHaveProperty("overrideReason");
  });
});
