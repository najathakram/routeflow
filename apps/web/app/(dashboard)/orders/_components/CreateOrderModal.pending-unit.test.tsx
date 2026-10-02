import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, act, fireEvent, within } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";
import { apiClient } from "@/lib/api-client";

// JSDOM has no scrollIntoView implementation at all (not a stub — genuinely absent), and
// addLineItem's scroll-to-added-row effect calls it. No prior test in this file exercised
// that path (only the customer-not-selected submit guard), so this gap was never hit before.
window.HTMLElement.prototype.scrollIntoView = jest.fn();

/**
 * CreateOrderModal's own zod schema (`notes`/`urgent`/`fulfillPath`) has NO
 * required fields — react-hook-form's resolver never blocks a submit. The
 * real "required" guardrails (must pick a customer, must add a line item) are
 * imperative React state checks in `onSubmit` (`setCustomerError`/
 * `setLineItemsError`), not react-hook-form/zod validation. This spec covers
 * that actual guard instead of a nonexistent zod message. A full happy path
 * (search + select a customer, search + add a product, then submit) needs a
 * much larger mocked surface — debounced customer/product search dropdowns
 * backed by 6+ query hooks — and is out of scope for this pass; recorded as a
 * finding, not faked.
 */

const createOrderMutate = jest.fn();
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
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
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
// #2865 case c: the units ladder load is a seam the test controls (resolve / reject / hang).
const mockFetchProductUnits = jest.fn();
jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => mockUnitsEnabled,
  useProductUnits: (_id: string, _enabled: boolean) => ({ data: undefined }),
  fetchProductUnits: (id: string) => mockFetchProductUnits(id),
  productUnitsKey: (id: string) => ["product-units", id],
  UNITS_FLAG: "flag.units_v1",
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "OPERATOR" } }),
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

const caseLevel = {
  id: "u1",
  label: "Case",
  factorToBase: 12,
  price: "24.00",
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling: false,
  sortOrder: 1,
};
const bottleLevel = {
  ...caseLevel,
  id: "u2",
  label: "Bottle",
  factorToBase: 1,
  price: "2.00",
  isDefaultSelling: true,
  sortOrder: 0,
};
const boxed = {
  notFound: false,
  archived: false,
  // a multi-match / shared-code scan is a picker-style pick: it STARTS PENDING on the default unit (SA-626a)
  ambiguous: true,
  product: { id: "prod-1", name: "Widget", pricePerUnit: "24", unit: "Case", unitsPerBox: 12 },
};
const cust = { id: "c1", businessName: "Acme Foods", pricingTier: 1 };

/**
 * #2865 case c (SA-632): a line added by a scan/tap is PENDING until its default selling unit resolves. The qty
 * controls stay locked, the PENDING TAP COUNT is shown, and a failed load shows an error + Retry. Nothing is ever
 * added by a "+" before the load, and an order is never submitted with a pending line (case d).
 */
describe("CreateOrderModal pending selling unit (#2865 case c/d)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCustomers = [cust];
    mockUnitsEnabled = true;
    mockProductUnits = [];
    mockResolveProductByCode.mockResolvedValue(boxed);
    mockFetchProductUnits.mockReset();
    (apiClient.get as jest.Mock).mockImplementation((url: string) =>
      Promise.resolve({
        data: String(url).includes("/billing/subscription")
          ? { flags: ["flag.units_v1"] }
          : { taxRate: 0 },
      }),
    );
  });

  const open = async (taps: number) => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
      target: { value: "Acm" },
    });
    fireEvent.click(await screen.findByText("Acme Foods"));
    for (let i = 0; i < taps; i++) {
      await act(async () => {
        capturedOnScan!("111");
      });
    }
  };
  const save = () => fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));

  it("3 scans before the ladder loads: locked controls + '3 · loading units'; after the load the line is exactly 3 Bottles", async () => {
    let release!: (u: unknown[]) => void;
    mockFetchProductUnits.mockReturnValue(new Promise((r) => (release = r)));
    await open(3);

    expect(await screen.findByText("3 · loading units")).toBeInTheDocument();
    const controls = screen.getByTestId("line-qty-controls");
    expect(controls).toBeDisabled();
    expect(controls).toHaveAttribute("aria-busy", "true");

    await act(async () => release([bottleLevel, caseLevel]));
    await waitFor(() => expect(screen.queryByText(/loading units/)).not.toBeInTheDocument());
    save();
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(createOrderMutate.mock.calls[0][0].items).toEqual([
      { productId: "prod-1", qty: 3, unitLabel: "Bottle" },
    ]);
  });

  it("3 scans + a FAILED load: error + Retry, controls stay locked, the order is NOT submitted; Retry with a working ladder -> 3 Bottles", async () => {
    mockFetchProductUnits.mockRejectedValue(new Error("offline"));
    await open(3);

    const alert = await screen.findByRole("alert", {}, { timeout: 3000 });
    expect(alert).toHaveTextContent("Couldn't load the selling units");
    expect(alert).toHaveTextContent("3 added");
    expect(screen.getByTestId("line-qty-controls")).toBeDisabled();

    // case d: submit with a PENDING line is blocked, nothing is created
    save();
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining("Couldn't load the selling units"),
          variant: "error",
        }),
      ),
    );
    expect(createOrderMutate).not.toHaveBeenCalled();

    // Retry (a real button) with the ladder now available
    mockFetchProductUnits.mockResolvedValue([bottleLevel, caseLevel]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    save();
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(createOrderMutate.mock.calls[0][0].items).toEqual([
      { productId: "prod-1", qty: 3, unitLabel: "Bottle" },
    ]);
  });
});
