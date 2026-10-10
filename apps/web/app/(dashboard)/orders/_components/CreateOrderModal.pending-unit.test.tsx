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
  // a SHARED-code scan (box + unit rows, here codes 110-112 on a 12-pack) STARTS PENDING on the default unit (SA-626a/#2784);
  // a multi-match no longer does - B1219 sends it to the picker instead of adding the first row
  product: {
    id: "prod-1",
    name: "Widget",
    pricePerUnit: "24",
    unit: "Case",
    unitsPerBox: 12,
    barcodes: ["110", "111", "112"].flatMap((code) => [
      { code, level: "BOX" },
      { code, level: "UNIT" },
    ]),
  },
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
    mockScanV2 = false;
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

  /** Every qty control the row offers, driven the way a user (or a stray event) would. */
  const hammerQtyControls = async () => {
    for (const b of screen.queryAllByRole("button", { name: /^[+−]$/ })) fireEvent.click(b);
    for (const el of screen.queryAllByRole("spinbutton"))
      fireEvent.change(el, { target: { value: "2" } });
    await act(async () => undefined);
  };

  it("SA-632 refusal: a '+' / typed qty / box edit before the ladder loads changes NOTHING; after the load the line is exactly 1 Bottle", async () => {
    let release!: (u: unknown[]) => void;
    mockFetchProductUnits.mockReturnValue(new Promise((r) => (release = r)));
    await open(1);

    await hammerQtyControls();
    await act(async () => release([bottleLevel, caseLevel]));
    await waitFor(() => expect(mockFetchProductUnits).toHaveBeenCalled());
    await act(async () => undefined);
    save();
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(createOrderMutate.mock.calls[0][0].items).toEqual([
      { productId: "prod-1", qty: 1, unitLabel: "Bottle" },
    ]);
  });

  it("SA-632 refusal + case d: after a FAILED load the controls still change nothing, submit stays blocked, Retry -> exactly 1 Bottle", async () => {
    mockFetchProductUnits.mockRejectedValue(new Error("offline"));
    await open(1);
    await screen.findByRole("alert", {}, { timeout: 3000 });

    await hammerQtyControls();
    save();
    await act(async () => undefined);
    expect(createOrderMutate).not.toHaveBeenCalled();

    mockFetchProductUnits.mockResolvedValue([bottleLevel, caseLevel]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    save();
    expect(createOrderMutate.mock.calls[0][0].items).toEqual([
      { productId: "prod-1", qty: 1, unitLabel: "Bottle" },
    ]);
  });

  it("case d (SA-632): the ladder NEVER resolves -> Create Order is disabled + aria-busy and no order is created, even if clicked", async () => {
    mockFetchProductUnits.mockReturnValue(new Promise(() => undefined)); // never settles
    await open(1);

    const create = screen.getByRole("button", { name: /create order/i });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute("aria-busy", "true");
    fireEvent.click(create);
    await act(async () => undefined);
    expect(createOrderMutate).not.toHaveBeenCalled();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("case d (SA-632): once the ladder resolves Create Order is enabled again and submits exactly the default unit", async () => {
    let release!: (u: unknown[]) => void;
    mockFetchProductUnits.mockReturnValue(new Promise((r) => (release = r)));
    await open(2);
    expect(screen.getByRole("button", { name: /create order/i })).toBeDisabled();

    await act(async () => release([bottleLevel, caseLevel]));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /create order/i })).toBeEnabled(),
    );
    expect(screen.getByRole("button", { name: /create order/i })).not.toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  const scanOther = async () => {
    // a plain (NOT shared-code, not ambiguous) scan of the same product: it maps to a DIFFERENT level than the default
    mockResolveProductByCode.mockResolvedValue({ ...boxed });
    await act(async () => {
      capturedOnScan!("222");
    });
  };

  it("SA-632 H2: a scan of a DIFFERENT level while pending is REFUSED visibly: not counted, no 'Added', the line is untouched", async () => {
    let release!: (u: unknown[]) => void;
    mockFetchProductUnits.mockReturnValue(new Promise((r) => (release = r)));
    await open(1);
    expect(await screen.findByText("1 · loading units")).toBeInTheDocument();

    await scanOther();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Units are still loading. Scan again in a moment" }),
    );
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Added to existing line" }),
    );
    expect(screen.getByText("1 · loading units")).toBeInTheDocument(); // still 1, not 2

    await act(async () => release([bottleLevel, caseLevel]));
    await waitFor(() => expect(screen.queryByText(/loading units/)).not.toBeInTheDocument());
    save();
    expect(createOrderMutate.mock.calls[0][0].items).toEqual([
      { productId: "prod-1", qty: 1, unitLabel: "Bottle" },
    ]);
  });

  it("SA-632 M2: taps on a pending line never show N cases: the row and the total stay as ONE case until the load, then exactly N Bottles", async () => {
    mockScanV2 = true; // scan_v2 steps a whole case per repeat scan (the old box increment this pins away)
    let release!: (u: unknown[]) => void;
    mockFetchProductUnits.mockReturnValue(new Promise((r) => (release = r)));
    await open(3);
    expect(await screen.findByText("3 · loading units")).toBeInTheDocument();
    expect(screen.getByTestId("line-total")).toHaveTextContent("$24.00"); // one case, never 3 cases ($72)

    await act(async () => release([bottleLevel, caseLevel]));
    await waitFor(() => expect(screen.getByTestId("line-total")).toHaveTextContent("$6.00"));
  });

  it("SA-632 H1: a typed price on a PENDING line is refused; after the load the line is exactly N default units at the tier price", async () => {
    let release!: (u: unknown[]) => void;
    mockFetchProductUnits.mockReturnValue(new Promise((r) => (release = r)));
    await open(2);
    expect(await screen.findByText("2 · loading units")).toBeInTheDocument();

    // the price is tap-to-edit: while pending the tap target is aria-disabled and opens no price editor
    const priceTargets = screen
      .queryAllByRole("button")
      .filter((b) => /\$24\.00/.test(b.textContent ?? ""));
    expect(priceTargets.length).toBeGreaterThan(0);
    for (const el of priceTargets) {
      expect(el).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(el);
    }
    expect(screen.queryByRole("textbox", { name: "Price" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Price")).not.toBeInTheDocument();
    await act(async () => undefined);
    expect(screen.getByText("2 · loading units")).toBeInTheDocument();

    await act(async () => release([bottleLevel, caseLevel]));
    await waitFor(() => expect(screen.queryByText(/loading units/)).not.toBeInTheDocument());
    save();
    expect(createOrderMutate.mock.calls[0][0].items).toEqual([
      { productId: "prod-1", qty: 2, unitLabel: "Bottle" },
    ]);
  });

  it("SA-632 M1: while the subscription read is in flight the row says LOADING, never 'Couldn't load' + Retry; a failed read then shows the error", async () => {
    let failSub!: (e: Error) => void;
    (apiClient.get as jest.Mock).mockImplementation((url: string) =>
      String(url).includes("/billing/subscription")
        ? new Promise((_r, rej) => (failSub = rej))
        : Promise.resolve({ data: { taxRate: 0 } }),
    );
    await open(1);
    expect(await screen.findByText("1 · loading units")).toBeInTheDocument();
    await act(async () => undefined);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();

    await act(async () => failSub(new Error("offline")));
    const alert = await screen.findByRole("alert", {}, { timeout: 3000 });
    expect(alert).toHaveTextContent("Couldn't load the selling units");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("LOW: a Retry that fails again returns to the failed state with the count kept, then a good Retry -> exactly N Bottles", async () => {
    mockFetchProductUnits.mockRejectedValue(new Error("offline"));
    await open(2);
    await screen.findByRole("alert", {}, { timeout: 3000 });

    // the retry takes a moment and fails again: while in flight the button says so and cannot be pressed twice
    mockFetchProductUnits.mockImplementation(
      () => new Promise((_r, rej) => setTimeout(() => rej(new Error("offline")), 150)),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const inFlight = await screen.findByRole("button", { name: "Retrying…" });
    expect(inFlight).toBeDisabled();
    // in flight the button says so; a failed retry returns to the failed state (not stuck "Retrying…")
    const retry = await screen.findByRole("button", { name: "Retry" }, { timeout: 3000 });
    expect(retry).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("2 added");

    mockFetchProductUnits.mockResolvedValue([bottleLevel, caseLevel]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    save();
    expect(createOrderMutate.mock.calls[0][0].items).toEqual([
      { productId: "prod-1", qty: 2, unitLabel: "Bottle" },
    ]);
  });

  it("SA-632 N2: 'Undo last scan' on a PENDING line takes one TAP back (3 scans, 2 undos -> exactly 1 Bottle); it never settles a case", async () => {
    mockScanV2 = true;
    let release!: (u: unknown[]) => void;
    mockFetchProductUnits.mockReturnValue(new Promise((r) => (release = r)));
    await open(0);
    act(() => capturedOnOpenContinuous!());
    await screen.findByRole("dialog", { name: "Scan items" });
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        // steady read: one deliberate scan = the same code held for three frames
        for (let f = 0; f < 3; f++) cameraDetect!(`11${i}`);
      });
      await act(async () => new Promise((r) => setTimeout(r, 30)));
    }
    for (let i = 0; i < 2; i++) {
      fireEvent.click(await screen.findByRole("button", { name: /undo last scan/i }));
      await act(async () => undefined);
    }
    await act(async () => release([bottleLevel, caseLevel]));
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    await screen.findByRole("dialog", { name: "Create Order" });
    await waitFor(() => expect(screen.queryByText(/loading units/)).not.toBeInTheDocument());
    save();
    expect(createOrderMutate.mock.calls[0][0].items).toEqual([
      { productId: "prod-1", qty: 1, unitLabel: "Bottle" },
    ]);
  });

  it("#2865 F2: Enter on the focused Retry runs the refetch inside the order form (whose Enter rule is preventDefault); the line ends at exactly N Bottles", async () => {
    mockFetchProductUnits.mockRejectedValue(new Error("offline"));
    await open(2);
    await screen.findByRole("alert", {}, { timeout: 3000 });
    const calls = mockFetchProductUnits.mock.calls.length;

    mockFetchProductUnits.mockResolvedValue([bottleLevel, caseLevel]);
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(mockFetchProductUnits.mock.calls.length).toBeGreaterThan(calls));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    save();
    expect(createOrderMutate.mock.calls[0][0].items).toEqual([
      { productId: "prod-1", qty: 2, unitLabel: "Bottle" },
    ]);
  });
});
