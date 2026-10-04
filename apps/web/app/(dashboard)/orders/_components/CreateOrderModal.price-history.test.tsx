import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, fireEvent, within } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

// JSDOM has no scrollIntoView implementation at all (not a stub — genuinely absent), and
// addLineItem's scroll-to-added-row effect calls it. No prior test in this file exercised
// that path (only the customer-not-selected submit guard), so this gap was never hit before.
/**
 * The REAL configuration of the new-order line list: every line is rendered with `onTapPrice` (tap the
 * price to edit it), so the inline price input never shows. The price-history button must still be
 * visible, disabled until a customer is chosen, open the panel without opening the price sheet, and
 * "Use this price" must set the line price through the same path a typed price takes.
 */
window.HTMLElement.prototype.scrollIntoView = jest.fn();

const createOrderMutate = jest.fn();
const mockApiGet = jest.fn();
// Mutable so a test can put the mutation in its error state (the modal's inline API-error banner).
let mockCreateOrderError: unknown = null;
// Mutable so a test can put a customer in the picker / give them per-product tier prices.
let mockCustomers: Array<Record<string, unknown>> = [];
let mockCustomerPrices: Array<Record<string, unknown>> = [];
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: mockCustomers } }),
  // Like the real hook: nothing until a customer is selected.
  useCustomerPrices: (customerId?: string) => ({ data: customerId ? mockCustomerPrices : [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({
    mutate: createOrderMutate,
    isPending: false,
    error: mockCreateOrderError,
    reset: jest.fn(),
  }),
  useActiveOrderForCustomer: () => ({ data: undefined }),
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
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
}));
jest.mock("@/lib/api/tobacco", () => ({
  useHasAddon: () => false,
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (url: string) => mockApiGet(url),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

// B499 — the product-search row's BarcodeScannerButton. The real component's webcam path
// needs getUserMedia + a dynamic @zxing/browser import, impractical in JSDOM — mock it the
// same way the sibling pages' own barcode call sites are exercised elsewhere: capture the
// live onScan/onError props so a test can trigger them directly, same as a real scan would.
let capturedOnScan: ((code: string) => void) | undefined;
let capturedOnError: ((message: string) => void) | undefined;
let capturedOnOpenContinuous: (() => void) | undefined;
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: {
    onScan: (code: string) => void;
    onError?: (message: string) => void;
    onOpenContinuous?: () => void;
    title?: string;
  }) => {
    capturedOnScan = props.onScan;
    capturedOnError = props.onError;
    capturedOnOpenContinuous = props.onOpenContinuous;
    return (
      <button type="button" title={props.title} aria-label={props.title}>
        {props.title}
      </button>
    );
  },
}));

// NOTE: this stubs InlineCreateProductModal for EVERY test in this file (none rendered the real
// one). A test that needs the real create-product form must un-mock it locally.
// The unknown-barcode fallback: capture the props so a test can assert the modal opens with the
// scanned code as its SKU without rendering the real product form.
let capturedInlineCreate: { isOpen: boolean; initialSku?: string } | undefined;
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: (props: { isOpen: boolean; initialSku?: string }) => {
    capturedInlineCreate = props;
    return null;
  },
}));

// scan_v2: the flag and the camera are the two seams. The flag is a mutable stub; the camera hook
// hands the test the screen's onDetect so a barcode can be injected without getUserMedia.
let mockScanV2 = false;
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useScanV2: () => mockScanV2,
  useOrderUiV2: () => ({ enabled: false, resolved: true }), // order_ui_v2 has its own file (add-line)
}));
let cameraDetect: ((code: string) => void) | undefined;
let cameraEnabled: boolean | undefined;
jest.mock("./scan/useContinuousScanCamera", () => ({
  useContinuousScanCamera: ({
    enabled,
    onDetect,
  }: {
    enabled: boolean;
    onDetect: (c: string) => void;
  }) => {
    cameraDetect = onDetect;
    cameraEnabled = enabled;
    return {
      videoRef: { current: null },
      torchAvailable: false,
      torchOn: false,
      toggleTorch: jest.fn(),
      refocus: jest.fn(),
      error: null,
    };
  },
}));
jest.mock("@/lib/scan-cue", () => ({ playScanCue: jest.fn(), unlockScanCue: jest.fn() }));

const mockResolveProductByCode = jest.fn();

// units_v1: the flag and the product's ladder, mutable per test (default: flag OFF = today's modal).
let mockUnitsEnabled = false;
let mockProductUnits: unknown[] = [];
jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => mockUnitsEnabled,
  useProductUnits: (_id: string, enabled: boolean) => ({
    data: enabled ? mockProductUnits : undefined,
  }),
}));
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolveProductByCode(code),
}));

const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));

// SA-090f (#1271) pin: scheduleScannerRefocus runs in EVERY addLineItem post-commit tail
// (unlike the toast, which is skipped on the scan screen) — the one call a test can force to
// throw there without needing a real DOM focus target.
const mockScheduleScannerRefocus = jest.fn();
jest.mock("@/lib/refocus-scanner", () => ({
  scheduleScannerRefocus: (...args: unknown[]) => mockScheduleScannerRefocus(...args),
  isTextEntryActive: () => false,
}));

const tiered = {
  notFound: false,
  archived: false,
  product: { id: "prod-1", name: "Widget", pricePerUnit: "10", priceTier2: "8", unit: "each" },
};
const acme = { id: "c1", businessName: "Acme Foods", pricingTier: 2 };
const historyResponse = {
  customerId: "c1",
  customerName: "Acme Foods",
  productId: "prod-1",
  productName: "Widget",
  costVisible: false,
  rows: [
    {
      date: "2026-09-20T00:00:00.000Z",
      source: "INVOICE",
      unitPrice: 9,
      unitLabel: "each",
      unitsPerBox: null,
      qty: 4,
      boxes: null,
      pieces: null,
      avgCostAtSale: null,
      invoiceId: "inv-1",
      invoiceNumber: "INV-0001",
      orderId: "ord-1",
      orderNumber: "ORD-0001",
      priceType: null,
    },
  ],
  summaries: [{ unitLabel: "each", last: 9, low: 9, high: 9, qtySold: 4, currentAvgCost: null }],
};

const pickCustomer = async (name: string) => {
  fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
    target: { value: name.slice(0, 3) },
  });
  fireEvent.click(await screen.findByText(name));
};

describe("CreateOrderModal - price history button (real onTapPrice configuration)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCustomers = [acme];
    mockCustomerPrices = [];
    mockScanV2 = true; // the customer's tier re-prices a line scanned before the customer (D1)
    mockUnitsEnabled = false;
    mockProductUnits = [];
    mockResolveProductByCode.mockResolvedValue(tiered);
    mockApiGet.mockImplementation((url: string) =>
      url.includes("/price-history")
        ? Promise.resolve({ data: historyResponse })
        : Promise.resolve({ data: { taxRate: 0 } }),
    );
  });

  it("is visible on the line, disabled until a customer is chosen, then opens the panel (not the price sheet)", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    capturedOnScan!("111");
    await screen.findByText("Widget");
    // the tap-to-edit price: there is NO inline price input in this configuration
    expect(screen.getAllByLabelText("Change price").length).toBeGreaterThan(0);

    const btn = screen.getByRole("button", { name: "Price history" });
    expect(btn).toBeDisabled();

    await pickCustomer("Acme Foods");
    const ready = await screen.findByRole("button", { name: "Price history" });
    expect(ready).toBeEnabled();

    fireEvent.click(ready);
    const panel = await screen.findByRole("dialog", { name: "Price history" });
    expect(await within(panel).findByText("Customer: Acme Foods")).toBeInTheDocument();
    // the price sheet did not open
    expect(screen.queryByRole("dialog", { name: /^edit /i })).not.toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledWith("/customers/c1/products/prod-1/price-history");
  });

  it("Use this price sets the line price through the normal path (a one-time Discounted price)", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    capturedOnScan!("111");
    await screen.findByText("Widget");
    await pickCustomer("Acme Foods");
    expect(await screen.findByText("$8.00 / each")).toBeInTheDocument(); // the customer's tier price

    fireEvent.click(await screen.findByRole("button", { name: "Price history" }));
    const panel = await screen.findByRole("dialog", { name: "Price history" });
    fireEvent.click(await within(panel).findByRole("button", { name: "Use this price $9.00" }));

    expect(screen.queryByRole("dialog", { name: "Price history" })).not.toBeInTheDocument();
    expect(await screen.findByText("$9.00 / each")).toBeInTheDocument();
  });
});
